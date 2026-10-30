-- Migration: 20261029100100_community_voting_two_round_functions
-- Halloween Community Voting pilot — the authoritative operations of a two-round (FAVORITE_ROUND) Instance
-- (UG-IV-GATE-004A, corrected by UG-IV-GATE-005 / 005A). Self-contained on top of the GATE-003 foundation and 20261029100000.
--
-- Conventions inherited from 20261020190100 and kept here:
--   * every writing function takes the Session row lock FIRST (`for update`), then the rows it needs, so any two operations on one
--     event serialize in the same order and cannot deadlock;
--   * every function is `security invoker`, service_role only (EXECUTE is revoked from PUBLIC, anon and authenticated at the
--     bottom), and re-validates every precondition itself — the TypeScript layer is a fast path;
--   * GATE-003's functions (bind, issue-intent, start, cast, status) are NOT edited. The pilot reuses bind and issue-intent as they
--     are (its identity policy is enforced by a table trigger, see 20261029100200), reuses the Session's own start/close/reveal
--     through the same transaction-local marker mechanism, and has its own cast because its rules differ: no telephone, a geofence
--     only in the final, a binding server deadline in both rounds.
--
-- The transaction-local markers used here (cleared before each function returns; none can be set through the REST surface):
--   urbano.community_voting_round_op        = <instance id>  entries of that Instance may be written
--   urbano.community_voting_start           = <session id>   the sanctioned opening
--   urbano.community_voting_round_vote      = <session id>   the sanctioned write of a vote
--   urbano.community_voting_round_close     = <session id>   the sanctioned close
--   urbano.community_voting_round_publish   = <session id>   the sanctioned reveal (publication)
--   urbano.community_voting_round_withdraw  = 'on'           the sanctioned withdrawal (cascades across both rounds)
--   urbano.community_voting_finalists       = <instance id>  the sanctioned finalist selection

-- ---------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------

-- Resolves the Instance, optionally takes the Session lock, and proves host authority AND operator identity. The caller decides
-- whether it will write (lock) or only read (no lock, so a polling operator screen never delays a vote).
create function community_voting_authorize_operator(
  p_instance_id uuid,
  p_host_token text,
  p_operator_member_id uuid,
  p_lock boolean default true
)
returns table (o_session_id uuid, o_session_state text)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_session_id uuid;
  v_mode text;
  v_operator uuid;
  v_state text;
  v_host_token text;
begin
  select i.session_id, i.ballot_mode, i.operator_gaming_member_id
    into v_session_id, v_mode, v_operator
  from community_voting_instances i
  where i.instance_id = p_instance_id;

  if v_session_id is null then
    raise exception 'CV_INSTANCE_NOT_FOUND: no Community Voting Instance exists for this id'
      using errcode = 'P0001';
  end if;

  if p_lock then
    select s.state, s.host_token into v_state, v_host_token
    from sessions s
    where s.session_id = v_session_id
    for update;
  else
    select s.state, s.host_token into v_state, v_host_token
    from sessions s
    where s.session_id = v_session_id;
  end if;

  if v_host_token is distinct from p_host_token then
    raise exception 'HOST_TOKEN_MISMATCH: supplied host token does not match this session'
      using errcode = 'P0001';
  end if;

  if v_mode is distinct from 'FAVORITE_ROUND' then
    raise exception 'CV_NOT_A_ROUND: this operation applies to a two-round Instance only'
      using errcode = 'P0001';
  end if;

  if p_operator_member_id is null or v_operator is distinct from p_operator_member_id then
    raise exception 'CV_OPERATOR_REQUIRED: only the Instance''s designated operator may do this'
      using errcode = 'P0001';
  end if;

  return query select v_session_id, v_state;
end;
$$;

create function community_voting_log_operator_action(
  p_instance_id uuid,
  p_operator_member_id uuid,
  p_action text,
  p_entry_id uuid,
  p_detail jsonb
)
returns void
language sql
security invoker
set search_path = public
as $$
  insert into community_voting_operator_actions (instance_id, operator_member_id, action, entry_id, detail)
  values (p_instance_id, p_operator_member_id, p_action, p_entry_id, coalesce(p_detail, '{}'::jsonb));
$$;

-- The round role of an Instance, or an error when it is not a round. Used by every operation after it has authorized.
create function community_voting_require_round(p_instance_id uuid)
returns text
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_role text;
begin
  select i.round_role into v_role
  from community_voting_instances i
  where i.instance_id = p_instance_id and i.ballot_mode = 'FAVORITE_ROUND';

  if v_role is null then
    raise exception 'CV_NOT_A_ROUND: this operation applies to a two-round Instance only'
      using errcode = 'P0001';
  end if;
  return v_role;
end;
$$;

-- The contestant-facing preparation (entries, photographs, consent, the claim) belongs to the PRELIMINARY: a final's entries are
-- carried from the finalists and never made by hand.
create function community_voting_require_preliminary(p_instance_id uuid)
returns void
language plpgsql
stable
security invoker
set search_path = public
as $$
begin
  if community_voting_require_round(p_instance_id) <> 'PRELIMINARY' then
    raise exception 'CV_WRONG_ROUND: this operation applies to the preliminary round only'
      using errcode = 'P0001';
  end if;
end;
$$;

-- The preliminary a round belongs to: itself, or the one a final descends from. Policies, finalists and publications are decided at
-- the level of the pair.
create function community_voting_preliminary_of(p_instance_id uuid)
returns uuid
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(i.source_instance_id, i.instance_id)
  from community_voting_instances i
  where i.instance_id = p_instance_id;
$$;

-- Both Instances of a pair (the preliminary and its final, once registered).
create function community_voting_policy_instances(p_instance_id uuid)
returns setof uuid
language sql
stable
security invoker
set search_path = public
as $$
  select i.instance_id
  from community_voting_instances i
  where coalesce(i.source_instance_id, i.instance_id) = community_voting_preliminary_of(p_instance_id);
$$;

-- Has Product's decision for this policy been recorded for the pair?
create function community_voting_policy_approved(p_instance_id uuid, p_policy_key text)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select exists (
    select 1
    from community_voting_policy_approvals a
    where a.policy_key = p_policy_key
      and a.instance_id in (select community_voting_policy_instances(p_instance_id))
  );
$$;

-- A deadline is open strictly BEFORE it. At the deadline and after it, and when there is no deadline at all, it is closed: a missing
-- deadline fails closed. The one place the comparison is written, so the boundary is a single, testable fact.
create function community_voting_deadline_open(p_deadline timestamptz, p_now timestamptz)
returns boolean
language sql
immutable
security invoker
set search_path = public
as $$
  select p_deadline is not null and p_now is not null and p_now < p_deadline;
$$;

-- The instant after which no vote is accepted. PRELIMINARY: the CONFIGURED closing time (an operator who opens late does not extend
-- it). FINAL: the instant of its explicit opening plus its window, null until it opens.
create function community_voting_round_deadline(p_instance_id uuid)
returns timestamptz
language sql
stable
security invoker
set search_path = public
as $$
  select case i.round_role
           when 'PRELIMINARY' then (select sc.voting_closes_at from community_voting_schedules sc where sc.instance_id = i.instance_id)
           when 'FINAL' then (
             select ii.created_at + make_interval(secs => i.window_seconds)
             from interaction_instances ii
             where ii.session_id = i.session_id
             order by ii.created_at desc
             limit 1)
         end
  from community_voting_instances i
  where i.instance_id = p_instance_id and i.ballot_mode = 'FAVORITE_ROUND';
$$;

-- The state of an entry's CURRENT (newest) photograph, resolved through the entry it descends from, and whether the person has
-- asked for it to be hidden. The state is the review state ONLY (APPROVED / REJECTED / PENDING_REVIEW / PENDING_CONSENT): hiding
-- never rewrites it, because a privacy request does not decide the competition. A candidature withdrawal is a separate fact.
create function community_voting_entry_media(p_entry_id uuid)
returns table (m_photo_id uuid, m_state text, m_hidden boolean)
language sql
stable
security invoker
set search_path = public
as $$
  select p.photo_id,
         case
           when d.decision = 'APPROVED' then 'APPROVED'
           when d.decision = 'REJECTED' then 'REJECTED'
           when c.consent_id is not null then 'PENDING_REVIEW'
           else 'PENDING_CONSENT'
         end,
         exists (select 1 from community_voting_photo_privacy_actions pa where pa.entry_id = src.media_entry_id)
  from (
    select coalesce(e.source_entry_id, e.entry_id) as media_entry_id
    from community_voting_entries e
    where e.entry_id = p_entry_id
  ) src
  join community_voting_entry_photos p on p.entry_id = src.media_entry_id
  left join community_voting_entry_consents c on c.photo_id = p.photo_id
  left join community_voting_photo_decisions d on d.photo_id = p.photo_id
  order by p.created_at desc, p.photo_id desc
  limit 1;
$$;

-- The promotional decision currently in force for the PERSON behind an entry: 'ACCEPTED', 'DECLINED', 'WITHDRAWN' or 'NOT_ASKED'.
create function community_voting_entry_promo_state(p_entry_id uuid)
returns text
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(
    (select pc.decision
     from community_voting_promo_consents pc
     where pc.entry_id = (select coalesce(e.source_entry_id, e.entry_id) from community_voting_entries e where e.entry_id = p_entry_id)
     order by pc.recorded_at desc, pc.promo_consent_id desc
     limit 1),
    'NOT_ASKED');
$$;

-- Votes per candidate (the Voting store's own rows) and the standard competition rank among the contestants who have NOT withdrawn:
-- 1 + the number of contestants with strictly more votes. Equal votes share a rank and the next rank is skipped (1,1,3).
-- A withdrawn contestant keeps their votes in the store (evidence) but has no rank and appears in no total.
create function community_voting_compute_round_results(p_instance_id uuid)
returns table (
  r_candidate_id uuid,
  r_entry_id uuid,
  r_label text,
  r_ordinal integer,
  r_withdrawn boolean,
  r_votes bigint,
  r_rank integer
)
language sql
stable
security invoker
set search_path = public
as $$
  with base as (
    select e.entry_id,
           e.candidate_id,
           e.label,
           e.ordinal,
           exists (select 1 from community_voting_withdrawals w where w.entry_id = e.entry_id) as withdrawn,
           (select count(*) from votes v where v.candidate_id = e.candidate_id) as votes
    from community_voting_entries e
    where e.instance_id = p_instance_id and e.candidate_id is not null
  )
  select b.candidate_id,
         b.entry_id,
         b.label,
         b.ordinal,
         b.withdrawn,
         b.votes::bigint,
         case when b.withdrawn then null
              else (1 + (select count(*) from base o where not o.withdrawn and o.votes > b.votes))::integer
         end
  from base b
  order by b.ordinal;
$$;

-- sha256('cvrnd1|<role>|<votes in the interaction>|' || <ordinal>:<votes>:<rank> per NON-withdrawn contestant by ordinal, ';'-joined)
-- The identical value is computed by lib/gaming/communityVoting/rounds/finalists.ts (roundResultsDigest).
create function community_voting_compute_round_digest(p_instance_id uuid)
returns text
language sql
stable
security invoker
set search_path = public
as $$
  select encode(
    sha256(convert_to(
      'cvrnd1|'
      || (select i.round_role from community_voting_instances i where i.instance_id = p_instance_id)
      || '|'
      || (select count(*)
          from votes v
          join interaction_instances ii on ii.interaction_instance_id = v.interaction_instance_id
          join community_voting_instances i on i.session_id = ii.session_id
          where i.instance_id = p_instance_id)::text
      || '|'
      || coalesce(
           (select string_agg(r.r_ordinal::text || ':' || r.r_votes::text || ':' || r.r_rank::text, ';' order by r.r_ordinal)
            from community_voting_compute_round_results(p_instance_id) r
            where not r.r_withdrawn),
           ''),
      'UTF8')),
    'hex');
$$;

-- The number of VALID votes of a round: the votes for contestants who have NOT withdrawn. This is the one definition the whole pilot uses (the
-- finalist cut's "valid votes", the final's result): a vote for a contestant who withdrew stays in the Voting store as evidence, is shown to the
-- operator against the withdrawn contestant, and is not valid.
create function community_voting_valid_vote_count(p_instance_id uuid)
returns bigint
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(sum(r.r_votes) filter (where not r.r_withdrawn), 0)::bigint
  from community_voting_compute_round_results(p_instance_id) r;
$$;

-- A FINAL that has closed and has no valid vote has NO RESULT: shared winners exist only when the highest valid count is greater than zero, so
-- a final where every count is zero has nobody to announce. The system does not cancel it, reopen it, extend it or choose a winner for it: it
-- refuses to publish it and keeps every vote and every record. (A preliminary with no valid votes is a different case: it is the cut's
-- own Product decision, ZERO_VALID_VOTES_PRELIMINARY.)
create function community_voting_has_no_valid_result(p_instance_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select exists (
           select 1 from community_voting_instances i
           where i.instance_id = p_instance_id and i.ballot_mode = 'FAVORITE_ROUND' and i.round_role = 'FINAL')
     and exists (select 1 from community_voting_closures c where c.instance_id = p_instance_id)
     and community_voting_valid_vote_count(p_instance_id) = 0;
$$;

-- Which Product policy, if any, the preliminary's finalist cut cannot proceed without. NULL for a final and when none is needed.
--   * nobody voted for an eligible contestant           -> ZERO_VALID_VOTES_PRELIMINARY  (a vote for a contestant who withdrew is no vote)
--   * a would-be finalist (rank within the cutoff) has no votes -> ZERO_VOTE_ENTRIES_AT_CUTOFF
-- Read conservatively: any path by which a contestant without a single vote would advance needs the decision.
create function community_voting_cut_policy_requirement(p_instance_id uuid)
returns text
language sql
stable
security invoker
set search_path = public
as $$
  with r as (
    select x.r_votes, x.r_rank
    from community_voting_compute_round_results(p_instance_id) x
    where not x.r_withdrawn
  ),
  i as (
    select ci.finalist_cutoff as cutoff
    from community_voting_instances ci
    where ci.instance_id = p_instance_id and ci.ballot_mode = 'FAVORITE_ROUND' and ci.round_role = 'PRELIMINARY'
  )
  select case
           when not exists (select 1 from i) then null
           when not exists (select 1 from r) then null
           when (select coalesce(sum(r.r_votes), 0) from r) = 0 then 'ZERO_VALID_VOTES_PRELIMINARY'
           when exists (select 1 from r, i where r.r_rank <= i.cutoff and r.r_votes = 0) then 'ZERO_VOTE_ENTRIES_AT_CUTOFF'
           else null
         end;
$$;

-- The policies that are blocking this pair RIGHT NOW (required and not approved):
--   * FINALIST_WITHDRAWAL_AFTER_SELECTION once a selected finalist has withdrawn;
--   * the cut's own policy, for a closed preliminary whose finalists have not been selected yet.
create function community_voting_pending_policies(p_instance_id uuid)
returns table (policy_key text)
language sql
stable
security invoker
set search_path = public
as $$
  select 'FINALIST_WITHDRAWAL_AFTER_SELECTION'::text
  where exists (
          select 1
          from community_voting_finalists f
          join community_voting_withdrawals w on w.entry_id = f.entry_id
          where f.preliminary_instance_id = community_voting_preliminary_of(p_instance_id))
    and not community_voting_policy_approved(p_instance_id, 'FINALIST_WITHDRAWAL_AFTER_SELECTION')
  union all
  select c.req
  from (select community_voting_cut_policy_requirement(p_instance_id) as req) c
  where c.req is not null
    and exists (select 1 from community_voting_closures cl where cl.instance_id = p_instance_id)
    and not exists (select 1 from community_voting_finalist_selections s where s.preliminary_instance_id = p_instance_id)
    and not community_voting_policy_approved(p_instance_id, c.req);
$$;

-- What the operator reviews and what a publication must match. It commits to the closed result, to the finalist cut, to WHO HAS
-- WITHDRAWN and to the Product decisions in force, so ANY change to who is eligible, or to a decision, makes an earlier review stale.
--   sha256('cvrev2|' || round digest || '|' || selection digest or '' || '|' || withdrawn ordinals ',' || '|' || key=value ';')
-- The identical value is computed by lib/gaming/communityVoting/rounds/finalists.ts (reviewDigest).
create function community_voting_compute_review_digest(p_instance_id uuid)
returns text
language sql
stable
security invoker
set search_path = public
as $$
  select encode(
    sha256(convert_to(
      'cvrev2|' || community_voting_compute_round_digest(p_instance_id)
      || '|' || coalesce((select s.selection_digest from community_voting_finalist_selections s where s.preliminary_instance_id = p_instance_id), '')
      || '|' || coalesce((select string_agg(r.r_ordinal::text, ',' order by r.r_ordinal)
                          from community_voting_compute_round_results(p_instance_id) r
                          where r.r_withdrawn), '')
      || '|' || coalesce((select string_agg(a.policy_key || '=' || a.policy_value, ';' order by a.policy_key)
                          from community_voting_policy_approvals a
                          where a.instance_id in (select community_voting_policy_instances(p_instance_id))), ''),
      'UTF8')),
    'hex');
$$;

-- ---------------------------------------------------------------------------------------
-- Registration and schedule
-- ---------------------------------------------------------------------------------------
--
-- A round is registered with host authority, the Session lock first, the exact capability set (VOTING) and before any Participant,
-- like the GATE-003 Instance — plus the pilot's facts: the role, the descent of a final, the final's geofence and window. The
-- preliminary carries NO venue at all, so no location can ever be asked of it.

create function register_community_voting_round_atomically(
  p_session_id uuid,
  p_host_token text,
  p_operator_member_id uuid,
  p_rule_version integer,
  p_round_role text,
  p_source_instance_id uuid,
  p_venue_latitude double precision,
  p_venue_longitude double precision,
  p_venue_radius_meters double precision,
  p_max_accuracy_meters double precision,
  p_inside_margin_factor double precision,
  p_outside_margin_factor double precision,
  p_window_seconds integer
)
returns table (
  instance_id uuid,
  session_id uuid,
  round_role text,
  rule_version integer,
  source_instance_id uuid,
  window_seconds integer,
  created_at timestamptz
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_state text;
  v_host_token text;
  v_capabilities text[];
  v_row community_voting_instances%rowtype;
begin
  select sessions.state, sessions.host_token, sessions.declared_capabilities
    into v_state, v_host_token, v_capabilities
  from sessions
  where sessions.session_id = p_session_id
  for update;

  if not found then
    raise exception 'SESSION_NOT_FOUND: no session exists for this session_id'
      using errcode = 'P0001';
  end if;

  if v_host_token is distinct from p_host_token then
    raise exception 'HOST_TOKEN_MISMATCH: supplied host token does not match this session'
      using errcode = 'P0001';
  end if;

  if p_operator_member_id is null or not exists (
    select 1 from gaming_members m where m.gaming_member_id = p_operator_member_id
  ) then
    raise exception 'CV_OPERATOR_REQUIRED: the operator must be an existing Gaming Member'
      using errcode = 'P0001';
  end if;

  if exists (select 1 from community_voting_instances i where i.session_id = p_session_id) then
    raise exception 'CV_INSTANCE_ALREADY_REGISTERED: this session already has a Community Voting Instance'
      using errcode = 'P0001';
  end if;

  if v_state not in ('LOBBY_OPEN', 'LOBBY_LOCKED') then
    raise exception 'CV_SESSION_NOT_REGISTRABLE: session is in % state', v_state
      using errcode = 'P0001';
  end if;

  if v_capabilities is distinct from array['VOTING']::text[] then
    raise exception 'CV_CAPABILITY_SET_NOT_EXACTLY_VOTING: the declared capability set must be exactly VOTING'
      using errcode = 'P0001';
  end if;

  if exists (select 1 from participants p where p.session_id = p_session_id) then
    raise exception 'CV_PARTICIPANTS_ALREADY_EXIST: an Instance must be registered before any Participant exists'
      using errcode = 'P0001';
  end if;

  if p_rule_version is null or p_rule_version < 1 then
    raise exception 'CV_INVALID_REQUEST: ruleVersion must be a positive integer'
      using errcode = 'P0001';
  end if;

  if p_round_role is null or p_round_role not in ('PRELIMINARY', 'FINAL') then
    raise exception 'CV_INVALID_REQUEST: the round role must be PRELIMINARY or FINAL'
      using errcode = 'P0001';
  end if;

  if p_round_role = 'PRELIMINARY' then
    if p_source_instance_id is not null or p_window_seconds is not null
       or p_venue_latitude is not null or p_venue_longitude is not null or p_venue_radius_meters is not null
       or p_max_accuracy_meters is not null or p_inside_margin_factor is not null or p_outside_margin_factor is not null then
      raise exception 'CV_INVALID_REQUEST: a preliminary has no source, no window and no venue (it is voted from anywhere)'
        using errcode = 'P0001';
    end if;

    insert into community_voting_instances (session_id, rule_version, ballot_mode, operator_gaming_member_id, round_role, finalist_cutoff)
    values (p_session_id, p_rule_version, 'FAVORITE_ROUND', p_operator_member_id, 'PRELIMINARY', 10)
    returning * into v_row;
  else
    if p_source_instance_id is null or p_window_seconds is null
       or p_venue_latitude is null or p_venue_longitude is null or p_venue_radius_meters is null
       or p_max_accuracy_meters is null or p_inside_margin_factor is null or p_outside_margin_factor is null then
      raise exception 'CV_INVALID_REQUEST: a final needs its preliminary, its voting window and the complete venue geofence'
        using errcode = 'P0001';
    end if;

    insert into community_voting_instances (
      session_id, rule_version, ballot_mode, operator_gaming_member_id, round_role, source_instance_id, window_seconds,
      venue_latitude, venue_longitude, venue_radius_meters, max_accuracy_meters, inside_margin_factor, outside_margin_factor
    )
    values (
      p_session_id, p_rule_version, 'FAVORITE_ROUND', p_operator_member_id, 'FINAL', p_source_instance_id, p_window_seconds,
      p_venue_latitude, p_venue_longitude, p_venue_radius_meters, p_max_accuracy_meters, p_inside_margin_factor, p_outside_margin_factor
    )
    returning * into v_row;
  end if;

  insert into community_voting_schedules (instance_id, updated_by_member_id)
  values (v_row.instance_id, p_operator_member_id);

  perform community_voting_log_operator_action(
    v_row.instance_id, p_operator_member_id, 'REGISTER_INSTANCE', null,
    jsonb_build_object('roundRole', v_row.round_role, 'sourceInstanceId', v_row.source_instance_id, 'windowSeconds', v_row.window_seconds)
  );

  return query
    select v_row.instance_id, v_row.session_id, v_row.round_role, v_row.rule_version, v_row.source_instance_id, v_row.window_seconds, v_row.created_at;
end;
$$;

-- The schedule: CONFIGURATION until the round opens, BINDING afterwards (see the table's comment in 20261029100000).
--   * editable any number of times while the round has not opened, then frozen — by this function and by a table guard;
--   * the order registration <= cutoff <= opening < closing (and cutoff < closing) is checked here and by the table;
--   * a FINAL has no configured closing: its deadline is its explicit opening plus its window, a fact of the opening itself;
--   * setting times never opens, closes or refuses anything by itself.
create function set_community_voting_round_schedule_atomically(
  p_instance_id uuid,
  p_host_token text,
  p_operator_member_id uuid,
  p_registration_opens_at timestamptz,
  p_contestant_cutoff_at timestamptz,
  p_voting_opens_at timestamptz,
  p_voting_closes_at timestamptz,
  p_status text
)
returns table (
  registration_opens_at timestamptz,
  contestant_cutoff_at timestamptz,
  voting_opens_at timestamptz,
  voting_closes_at timestamptz,
  status text,
  updated_at timestamptz
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_session_id uuid;
  v_role text;
begin
  select o.o_session_id into v_session_id
  from community_voting_authorize_operator(p_instance_id, p_host_token, p_operator_member_id, true) o;
  v_role := community_voting_require_round(p_instance_id);

  if exists (select 1 from interaction_instances ii where ii.session_id = v_session_id) then
    raise exception 'CV_PREPARATION_CLOSED: the round has opened; its schedule can no longer change'
      using errcode = 'P0001';
  end if;

  if p_status is null or p_status not in ('TENTATIVE', 'CONFIRMED') then
    raise exception 'CV_INVALID_REQUEST: the schedule status must be TENTATIVE or CONFIRMED'
      using errcode = 'P0001';
  end if;

  if (p_registration_opens_at is not null and p_contestant_cutoff_at is not null and p_registration_opens_at > p_contestant_cutoff_at)
     or (p_contestant_cutoff_at is not null and p_voting_opens_at is not null and p_contestant_cutoff_at > p_voting_opens_at)
     or (p_voting_opens_at is not null and p_voting_closes_at is not null and p_voting_opens_at >= p_voting_closes_at)
     or (p_contestant_cutoff_at is not null and p_voting_closes_at is not null and p_contestant_cutoff_at >= p_voting_closes_at) then
    raise exception 'CV_SCHEDULE_INVALID: registration, cutoff, opening and closing must be in that order, and the opening must precede the closing'
      using errcode = 'P0001';
  end if;

  if v_role = 'FINAL' and p_voting_closes_at is not null then
    raise exception 'CV_SCHEDULE_INVALID: a final has no configured closing; its deadline is its opening plus its window'
      using errcode = 'P0001';
  end if;

  update community_voting_schedules
  set registration_opens_at = p_registration_opens_at,
      contestant_cutoff_at = p_contestant_cutoff_at,
      voting_opens_at = p_voting_opens_at,
      voting_closes_at = p_voting_closes_at,
      status = p_status,
      updated_at = now(),
      updated_by_member_id = p_operator_member_id
  where community_voting_schedules.instance_id = p_instance_id;

  perform community_voting_log_operator_action(
    p_instance_id, p_operator_member_id, 'SET_SCHEDULE', null,
    jsonb_build_object('status', p_status, 'registrationOpens', p_registration_opens_at, 'cutoff', p_contestant_cutoff_at,
                       'opens', p_voting_opens_at, 'closes', p_voting_closes_at)
  );

  return query
    select s.registration_opens_at, s.contestant_cutoff_at, s.voting_opens_at, s.voting_closes_at, s.status, s.updated_at
    from community_voting_schedules s
    where s.instance_id = p_instance_id;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Contestant entries, photographs, consent and the operator's decision (preliminary only)
-- ---------------------------------------------------------------------------------------
--
-- An entry is a contestant's place on the ballot. Its public identity is an OPAQUE number ('#4827') drawn at random — not
-- sequential, so it neither reveals arrival order nor can be walked. The claim credential is 12 characters from a 32-symbol
-- alphabet without the look-alikes (no 0/O, 1/I/L, U): short enough to be read off a tablet and typed on a phone, 60 bits,
-- single use, expiring, stored only as a digest, and attempts are counted per identity (see the claim function).
-- Registration and photographs are refused at or after the configured cutoff.

create function create_community_voting_round_entry_atomically(
  p_instance_id uuid,
  p_host_token text,
  p_operator_member_id uuid,
  p_claim_ttl_seconds integer default 900
)
returns table (entry_id uuid, label text, claim_code text, claim_expires_at timestamptz)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_session_id uuid;
  v_cutoff timestamptz;
  v_alphabet constant text := '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  v_label text;
  v_ordinal integer;
  v_code text := '';
  v_hex text;
  v_attempt integer := 0;
  v_entry_id uuid;
  v_expires timestamptz;
  i integer;
begin
  select o.o_session_id into v_session_id
  from community_voting_authorize_operator(p_instance_id, p_host_token, p_operator_member_id, true) o;
  perform community_voting_require_preliminary(p_instance_id);

  if exists (select 1 from interaction_instances ii where ii.session_id = v_session_id) then
    raise exception 'CV_PREPARATION_CLOSED: Voting has opened; the ballot can no longer change'
      using errcode = 'P0001';
  end if;

  select s.contestant_cutoff_at into v_cutoff from community_voting_schedules s where s.instance_id = p_instance_id;
  if v_cutoff is not null and not community_voting_deadline_open(v_cutoff, clock_timestamp()) then
    raise exception 'CV_CUTOFF_PASSED: the contestant cutoff has passed'
      using errcode = 'P0001';
  end if;

  if p_claim_ttl_seconds is null or p_claim_ttl_seconds not between 1 and 86400 then
    raise exception 'CV_INVALID_REQUEST: the claim window must be between 1 and 86400 seconds'
      using errcode = 'P0001';
  end if;

  perform set_config('urbano.community_voting_round_op', p_instance_id::text, true);

  loop
    v_attempt := v_attempt + 1;
    if v_attempt > 60 then
      raise exception 'CV_ALIAS_EXHAUSTED: no free contestant number could be drawn'
        using errcode = 'P0001';
    end if;
    v_label := '#' || (1000 + floor(random() * 9000))::integer::text;
    exit when not exists (
      select 1 from community_voting_entries e where e.instance_id = p_instance_id and lower(e.label) = lower(v_label)
    );
  end loop;

  select coalesce(max(e.ordinal), 0) + 1 into v_ordinal
  from community_voting_entries e
  where e.instance_id = p_instance_id;

  -- 12 symbols from 24 hex digits of one uuid (skipping the version and variant nibbles); 256 is divisible by 32, so no bias.
  v_hex := replace(gen_random_uuid()::text, '-', '');
  for i in 0..11 loop
    v_code := v_code || substr(
      v_alphabet,
      1 + (('x' || substr(case when i < 6 then substr(v_hex, 1, 12) else substr(v_hex, 18, 12) end, 1 + 2 * (i % 6), 2))::bit(8)::integer % 32),
      1
    );
  end loop;

  v_expires := now() + make_interval(secs => p_claim_ttl_seconds);

  insert into community_voting_entries (instance_id, ordinal, label, claim_code_hash, claim_window_seconds, claim_expires_at)
  values (p_instance_id, v_ordinal, v_label, encode(sha256(convert_to(v_code, 'UTF8')), 'hex'), p_claim_ttl_seconds, v_expires)
  returning community_voting_entries.entry_id into v_entry_id;

  perform set_config('urbano.community_voting_round_op', '', true);

  perform community_voting_log_operator_action(p_instance_id, p_operator_member_id, 'CREATE_ENTRY', v_entry_id, '{}'::jsonb);

  return query select v_entry_id, v_label, v_code, v_expires;
end;
$$;

create function remove_community_voting_round_entry_atomically(
  p_instance_id uuid,
  p_host_token text,
  p_operator_member_id uuid,
  p_entry_id uuid
)
returns table (entry_id uuid)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_session_id uuid;
  v_removed uuid;
begin
  select o.o_session_id into v_session_id
  from community_voting_authorize_operator(p_instance_id, p_host_token, p_operator_member_id, true) o;
  perform community_voting_require_preliminary(p_instance_id);

  if exists (select 1 from interaction_instances ii where ii.session_id = v_session_id) then
    raise exception 'CV_PREPARATION_CLOSED: Voting has opened; the ballot can no longer change'
      using errcode = 'P0001';
  end if;

  if not exists (select 1 from community_voting_entries e where e.entry_id = p_entry_id and e.instance_id = p_instance_id) then
    raise exception 'CV_ENTRY_NOT_FOUND: this ballot has no such entry'
      using errcode = 'P0001';
  end if;

  if exists (select 1 from community_voting_entry_photos ph where ph.entry_id = p_entry_id) then
    raise exception 'CV_ENTRY_HAS_MEDIA: an entry with a photograph cannot be removed; withdraw it instead'
      using errcode = 'P0001';
  end if;

  perform set_config('urbano.community_voting_round_op', p_instance_id::text, true);

  delete from community_voting_entries
  where community_voting_entries.entry_id = p_entry_id and community_voting_entries.instance_id = p_instance_id
  returning community_voting_entries.entry_id into v_removed;

  perform set_config('urbano.community_voting_round_op', '', true);

  perform community_voting_log_operator_action(p_instance_id, p_operator_member_id, 'REMOVE_ENTRY', null, jsonb_build_object('entryId', p_entry_id));

  return query select v_removed;
end;
$$;

create function upload_community_voting_round_photo_atomically(
  p_instance_id uuid,
  p_host_token text,
  p_operator_member_id uuid,
  p_entry_id uuid,
  p_full_b64 text,
  p_thumb_b64 text,
  p_width integer,
  p_height integer
)
returns table (photo_id uuid, full_sha256 text, thumb_sha256 text)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_session_id uuid;
  v_cutoff timestamptz;
  v_full bytea;
  v_thumb bytea;
  v_photo_id uuid;
  v_full_sha text;
  v_thumb_sha text;
begin
  select o.o_session_id into v_session_id
  from community_voting_authorize_operator(p_instance_id, p_host_token, p_operator_member_id, true) o;
  perform community_voting_require_preliminary(p_instance_id);

  if exists (select 1 from interaction_instances ii where ii.session_id = v_session_id) then
    raise exception 'CV_PREPARATION_CLOSED: Voting has opened; the ballot can no longer change'
      using errcode = 'P0001';
  end if;

  if not exists (select 1 from community_voting_entries e where e.entry_id = p_entry_id and e.instance_id = p_instance_id) then
    raise exception 'CV_ENTRY_NOT_FOUND: this ballot has no such entry'
      using errcode = 'P0001';
  end if;

  if exists (select 1 from community_voting_withdrawals w where w.entry_id = p_entry_id) then
    raise exception 'CV_ENTRY_ALREADY_WITHDRAWN: this entry has been withdrawn'
      using errcode = 'P0001';
  end if;

  if exists (select 1 from community_voting_photo_privacy_actions pa where pa.entry_id = p_entry_id) then
    raise exception 'CV_PHOTO_HIDDEN: this person asked for their photograph to be hidden; no new photograph can be added'
      using errcode = 'P0001';
  end if;

  select s.contestant_cutoff_at into v_cutoff from community_voting_schedules s where s.instance_id = p_instance_id;
  if v_cutoff is not null and not community_voting_deadline_open(v_cutoff, clock_timestamp()) then
    raise exception 'CV_CUTOFF_PASSED: the photograph cutoff has passed'
      using errcode = 'P0001';
  end if;

  begin
    v_full := decode(coalesce(p_full_b64, ''), 'base64');
    v_thumb := decode(coalesce(p_thumb_b64, ''), 'base64');
  exception when others then
    raise exception 'CV_PHOTO_INVALID: the photograph could not be decoded'
      using errcode = 'P0001';
  end;

  -- Backstop for the server-side sanitizer: both renditions must be bounded JPEG streams carrying no EXIF block.
  if p_width is null or p_height is null or p_width not between 1 and 4000 or p_height not between 1 and 4000
     or length(v_full) not between 4 and 1500000 or length(v_thumb) not between 4 and 150000
     or substring(v_full from 1 for 2) <> '\xffd8'::bytea or substring(v_full from length(v_full) - 1 for 2) <> '\xffd9'::bytea
     or substring(v_thumb from 1 for 2) <> '\xffd8'::bytea or substring(v_thumb from length(v_thumb) - 1 for 2) <> '\xffd9'::bytea
     or position('\x457869660000'::bytea in v_full) > 0 or position('\x457869660000'::bytea in v_thumb) > 0 then
    raise exception 'CV_PHOTO_INVALID: the photograph is not an acceptable metadata-free JPEG'
      using errcode = 'P0001';
  end if;

  v_full_sha := encode(sha256(v_full), 'hex');
  v_thumb_sha := encode(sha256(v_thumb), 'hex');

  -- A new photograph supersedes the previous ones: their bytes are erased now (their records remain).
  update community_voting_entry_photos
  set full_bytes = null, thumb_bytes = null, bytes_deleted_at = now(), bytes_deleted_reason = 'SUPERSEDED'
  where community_voting_entry_photos.entry_id = p_entry_id and community_voting_entry_photos.bytes_deleted_at is null;

  insert into community_voting_entry_photos (
    instance_id, entry_id, width, height, full_bytes, thumb_bytes, full_sha256, thumb_sha256, full_size, thumb_size, uploaded_by_member_id
  )
  values (
    p_instance_id, p_entry_id, p_width, p_height, v_full, v_thumb, v_full_sha, v_thumb_sha, length(v_full), length(v_thumb), p_operator_member_id
  )
  returning community_voting_entry_photos.photo_id into v_photo_id;

  perform community_voting_log_operator_action(
    p_instance_id, p_operator_member_id, 'UPLOAD_PHOTO', p_entry_id,
    jsonb_build_object('photoId', v_photo_id, 'fullSize', length(v_full), 'fullSha256', v_full_sha)
  );

  return query select v_photo_id, v_full_sha, v_thumb_sha;
end;
$$;

create function record_community_voting_round_consent_atomically(
  p_instance_id uuid,
  p_host_token text,
  p_operator_member_id uuid,
  p_entry_id uuid,
  p_photo_id uuid,
  p_consent_version text,
  p_statement_sha256 text,
  p_age_confirmed boolean
)
returns table (consent_id uuid, accepted_at timestamptz)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_session_id uuid;
  v_current uuid;
  v_consent_id uuid;
  v_accepted timestamptz;
begin
  select o.o_session_id into v_session_id
  from community_voting_authorize_operator(p_instance_id, p_host_token, p_operator_member_id, true) o;
  perform community_voting_require_preliminary(p_instance_id);

  if exists (select 1 from interaction_instances ii where ii.session_id = v_session_id) then
    raise exception 'CV_PREPARATION_CLOSED: Voting has opened; the ballot can no longer change'
      using errcode = 'P0001';
  end if;

  if not exists (select 1 from community_voting_entries e where e.entry_id = p_entry_id and e.instance_id = p_instance_id) then
    raise exception 'CV_ENTRY_NOT_FOUND: this ballot has no such entry'
      using errcode = 'P0001';
  end if;

  if exists (select 1 from community_voting_withdrawals w where w.entry_id = p_entry_id) then
    raise exception 'CV_ENTRY_ALREADY_WITHDRAWN: this entry has been withdrawn'
      using errcode = 'P0001';
  end if;

  select m.m_photo_id into v_current from community_voting_entry_media(p_entry_id) m;
  if v_current is null or v_current is distinct from p_photo_id then
    raise exception 'CV_PHOTO_REQUIRED: consent is recorded against the entry''s current photograph'
      using errcode = 'P0001';
  end if;

  if p_age_confirmed is distinct from true then
    raise exception 'CV_CONSENT_REQUIRED: the contestant must confirm being of legal age and accept the statement'
      using errcode = 'P0001';
  end if;

  if p_consent_version is null or p_consent_version !~ '^[A-Za-z0-9._-]{1,64}$'
     or p_statement_sha256 is null or p_statement_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'CV_INVALID_REQUEST: the consent version or statement digest is malformed'
      using errcode = 'P0001';
  end if;

  if exists (select 1 from community_voting_entry_consents c where c.photo_id = p_photo_id) then
    raise exception 'CV_CONSENT_ALREADY_RECORDED: consent is already recorded for this photograph'
      using errcode = 'P0001';
  end if;

  insert into community_voting_entry_consents (
    instance_id, entry_id, photo_id, consent_version, statement_sha256, age_confirmed, recorded_by_member_id
  )
  values (p_instance_id, p_entry_id, p_photo_id, p_consent_version, p_statement_sha256, true, p_operator_member_id)
  returning community_voting_entry_consents.consent_id, community_voting_entry_consents.accepted_at
    into v_consent_id, v_accepted;

  perform community_voting_log_operator_action(
    p_instance_id, p_operator_member_id, 'RECORD_CONSENT', p_entry_id,
    jsonb_build_object('photoId', p_photo_id, 'consentVersion', p_consent_version)
  );

  return query select v_consent_id, v_accepted;
end;
$$;

create function decide_community_voting_round_photo_atomically(
  p_instance_id uuid,
  p_host_token text,
  p_operator_member_id uuid,
  p_entry_id uuid,
  p_photo_id uuid,
  p_decision text,
  p_reason text
)
returns table (entry_id uuid, photo_id uuid, decision text)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_session_id uuid;
  v_current uuid;
  v_reason text;
begin
  select o.o_session_id into v_session_id
  from community_voting_authorize_operator(p_instance_id, p_host_token, p_operator_member_id, true) o;
  perform community_voting_require_preliminary(p_instance_id);

  if exists (select 1 from interaction_instances ii where ii.session_id = v_session_id) then
    raise exception 'CV_PREPARATION_CLOSED: Voting has opened; use a withdrawal to remove a contestant'
      using errcode = 'P0001';
  end if;

  if p_decision is null or p_decision not in ('APPROVED', 'REJECTED') then
    raise exception 'CV_INVALID_REQUEST: the decision must be APPROVED or REJECTED'
      using errcode = 'P0001';
  end if;

  v_reason := nullif(btrim(coalesce(p_reason, '')), '');
  if v_reason is not null and char_length(v_reason) > 200 then
    raise exception 'CV_INVALID_REQUEST: the reason is too long'
      using errcode = 'P0001';
  end if;

  if not exists (select 1 from community_voting_entries e where e.entry_id = p_entry_id and e.instance_id = p_instance_id) then
    raise exception 'CV_ENTRY_NOT_FOUND: this ballot has no such entry'
      using errcode = 'P0001';
  end if;

  if exists (select 1 from community_voting_withdrawals w where w.entry_id = p_entry_id) then
    raise exception 'CV_ENTRY_ALREADY_WITHDRAWN: this entry has been withdrawn'
      using errcode = 'P0001';
  end if;

  select m.m_photo_id into v_current from community_voting_entry_media(p_entry_id) m;
  if v_current is null or v_current is distinct from p_photo_id then
    raise exception 'CV_PHOTO_REQUIRED: the decision applies to the entry''s current photograph'
      using errcode = 'P0001';
  end if;

  if exists (select 1 from community_voting_photo_decisions d where d.photo_id = p_photo_id) then
    raise exception 'CV_DECISION_ALREADY_RECORDED: this photograph has already been decided'
      using errcode = 'P0001';
  end if;

  if p_decision = 'APPROVED' and not exists (select 1 from community_voting_entry_consents c where c.photo_id = p_photo_id) then
    raise exception 'CV_CONSENT_REQUIRED: a photograph cannot be approved before the contestant''s consent is recorded'
      using errcode = 'P0001';
  end if;

  insert into community_voting_photo_decisions (instance_id, entry_id, photo_id, decision, reason, decided_by_member_id)
  values (p_instance_id, p_entry_id, p_photo_id, p_decision, v_reason, p_operator_member_id);

  if p_decision = 'REJECTED' then
    update community_voting_entry_photos
    set full_bytes = null, thumb_bytes = null, bytes_deleted_at = now(), bytes_deleted_reason = 'REJECTED'
    where community_voting_entry_photos.photo_id = p_photo_id and community_voting_entry_photos.bytes_deleted_at is null;
  end if;

  perform community_voting_log_operator_action(
    p_instance_id, p_operator_member_id,
    case p_decision when 'APPROVED' then 'APPROVE_PHOTO' else 'REJECT_PHOTO' end,
    p_entry_id, jsonb_build_object('photoId', p_photo_id)
  );

  return query select p_entry_id, p_photo_id, p_decision;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- The contestant's private association: claim (by the contestant) and confirm (by the operator)
-- ---------------------------------------------------------------------------------------
--
-- The contestant presents the claim code with their own signed-in identity. The binding already proves a confirmed email and a Gaming
-- Member (the binding trigger refused it otherwise), so no further identity step exists and none is asked.

create function claim_community_voting_round_entry_atomically(
  p_instance_id uuid,
  p_auth_user_id uuid,
  p_claim_code text
)
returns table (outcome text, label text, confirmation_code text, confirm_expires_at timestamptz, attempts_remaining integer)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_session_id uuid;
  v_binding community_voting_voter_bindings%rowtype;
  v_code text;
  v_entry_id uuid;
  v_label text;
  v_claim_expires timestamptz;
  v_window integer;
  v_confirmation text;
  v_confirm_expires timestamptz;
  c_max constant integer := 10;
begin
  select i.session_id into v_session_id
  from community_voting_instances i
  where i.instance_id = p_instance_id;

  if v_session_id is null then
    raise exception 'CV_INSTANCE_NOT_FOUND: no Community Voting Instance exists for this id'
      using errcode = 'P0001';
  end if;

  perform 1 from sessions where sessions.session_id = v_session_id for update;

  perform community_voting_require_preliminary(p_instance_id);

  select * into v_binding
  from community_voting_voter_bindings b
  where b.instance_id = p_instance_id and b.auth_user_id = p_auth_user_id
  for update;

  if not found then
    raise exception 'CV_NOT_BOUND: this identity is not bound to the Instance'
      using errcode = 'P0001';
  end if;

  if exists (select 1 from interaction_instances ii where ii.session_id = v_session_id) then
    raise exception 'CV_PREPARATION_CLOSED: Voting has opened; the ballot can no longer change'
      using errcode = 'P0001';
  end if;

  if v_binding.gaming_member_id is null then
    raise exception 'CV_PROFILE_INCOMPLETE: complete your URBANO Gaming profile first'
      using errcode = 'P0001';
  end if;

  if v_binding.claim_failures >= c_max then
    return query select 'RATE_LIMITED'::text, null::text, null::text, null::timestamptz, 0;
    return;
  end if;

  -- Crockford-style input handling: case-insensitive, separators ignored, look-alikes mapped (O->0, I/L->1).
  v_code := translate(upper(regexp_replace(coalesce(p_claim_code, ''), '[^0-9A-Za-z]', '', 'g')), 'OIL', '011');

  if v_code !~ '^[0-9A-HJKMNP-TV-Z]{12}$' then
    update community_voting_voter_bindings set claim_failures = v_binding.claim_failures + 1
    where community_voting_voter_bindings.binding_id = v_binding.binding_id;
    return query select 'INVALID'::text, null::text, null::text, null::timestamptz, c_max - (v_binding.claim_failures + 1);
    return;
  end if;

  select e.entry_id, e.label, e.claim_expires_at, e.claim_window_seconds
    into v_entry_id, v_label, v_claim_expires, v_window
  from community_voting_entries e
  where e.instance_id = p_instance_id
    and e.claim_code_hash = encode(sha256(convert_to(v_code, 'UTF8')), 'hex')
    and not exists (select 1 from community_voting_withdrawals w where w.entry_id = e.entry_id)
  for update;

  if v_entry_id is null then
    update community_voting_voter_bindings set claim_failures = v_binding.claim_failures + 1
    where community_voting_voter_bindings.binding_id = v_binding.binding_id;
    return query select 'INVALID'::text, null::text, null::text, null::timestamptz, c_max - (v_binding.claim_failures + 1);
    return;
  end if;

  if v_claim_expires <= now() then
    update community_voting_voter_bindings set claim_failures = v_binding.claim_failures + 1
    where community_voting_voter_bindings.binding_id = v_binding.binding_id;
    return query select 'EXPIRED'::text, null::text, null::text, null::timestamptz, c_max - (v_binding.claim_failures + 1);
    return;
  end if;

  if exists (
    select 1 from community_voting_entries e
    where e.instance_id = p_instance_id
      and (e.pending_binding_id = v_binding.binding_id or e.confirmed_binding_id = v_binding.binding_id)
  ) then
    return query select 'CONTESTANT_ALREADY_HAS_ENTRY'::text, null::text, null::text, null::timestamptz, null::integer;
    return;
  end if;

  v_confirmation := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  v_confirm_expires := now() + make_interval(secs => v_window);

  perform set_config('urbano.community_voting_round_op', p_instance_id::text, true);

  update community_voting_entries
  set claim_code_hash = null,
      pending_binding_id = v_binding.binding_id,
      confirmation_code_hash = encode(sha256(convert_to(v_confirmation, 'UTF8')), 'hex'),
      confirmation_expires_at = v_confirm_expires,
      confirmation_failures = 0
  where community_voting_entries.entry_id = v_entry_id;

  perform set_config('urbano.community_voting_round_op', '', true);

  update community_voting_voter_bindings set claim_failures = 0
  where community_voting_voter_bindings.binding_id = v_binding.binding_id;

  return query select 'CLAIMED'::text, v_label, v_confirmation, v_confirm_expires, null::integer;
end;
$$;

create function confirm_community_voting_round_entry_atomically(
  p_instance_id uuid,
  p_host_token text,
  p_operator_member_id uuid,
  p_entry_id uuid,
  p_confirmation_code text
)
returns table (entry_id uuid, outcome text, attempts_remaining integer)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_session_id uuid;
  v_pending uuid;
  v_hash text;
  v_expires timestamptz;
  v_failures integer;
  v_normalized text;
  v_found uuid;
begin
  select o.o_session_id into v_session_id
  from community_voting_authorize_operator(p_instance_id, p_host_token, p_operator_member_id, true) o;
  perform community_voting_require_preliminary(p_instance_id);

  if exists (select 1 from interaction_instances ii where ii.session_id = v_session_id) then
    raise exception 'CV_PREPARATION_CLOSED: Voting has opened; the ballot can no longer change'
      using errcode = 'P0001';
  end if;

  select e.entry_id, e.pending_binding_id, e.confirmation_code_hash, e.confirmation_expires_at, e.confirmation_failures
    into v_found, v_pending, v_hash, v_expires, v_failures
  from community_voting_entries e
  where e.entry_id = p_entry_id and e.instance_id = p_instance_id
  for update;

  if v_found is null then
    raise exception 'CV_ENTRY_NOT_FOUND: this ballot has no such entry'
      using errcode = 'P0001';
  end if;

  if v_pending is null then
    raise exception 'CV_CONFIRMATION_NOT_PENDING: this entry has no claim waiting for confirmation'
      using errcode = 'P0001';
  end if;

  if v_expires <= now() then
    raise exception 'CV_CLAIM_EXPIRED: this claim has expired'
      using errcode = 'P0001';
  end if;

  v_normalized := upper(regexp_replace(coalesce(p_confirmation_code, ''), '[^0-9A-Za-z]', '', 'g'));
  if v_normalized = '' then
    raise exception 'CV_INVALID_REQUEST: a confirmation code is required'
      using errcode = 'P0001';
  end if;

  perform set_config('urbano.community_voting_round_op', p_instance_id::text, true);

  if v_hash = encode(sha256(convert_to(v_normalized, 'UTF8')), 'hex') then
    update community_voting_entries
    set confirmed_binding_id = v_pending,
        confirmed_at = now(),
        pending_binding_id = null,
        confirmation_code_hash = null,
        confirmation_expires_at = null,
        confirmation_failures = 0
    where community_voting_entries.entry_id = p_entry_id;

    perform set_config('urbano.community_voting_round_op', '', true);
    perform community_voting_log_operator_action(p_instance_id, p_operator_member_id, 'CONFIRM_ASSOCIATION', p_entry_id, '{}'::jsonb);
    return query select p_entry_id, 'CONFIRMED'::text, 0;
    return;
  end if;

  if v_failures + 1 >= 5 then
    update community_voting_entries
    set pending_binding_id = null,
        confirmation_code_hash = null,
        confirmation_expires_at = null,
        confirmation_failures = 0
    where community_voting_entries.entry_id = p_entry_id;

    perform set_config('urbano.community_voting_round_op', '', true);
    return query select p_entry_id, 'VOIDED'::text, 0;
    return;
  end if;

  update community_voting_entries
  set confirmation_failures = v_failures + 1
  where community_voting_entries.entry_id = p_entry_id;

  perform set_config('urbano.community_voting_round_op', '', true);
  return query select p_entry_id, 'REJECTED'::text, 5 - (v_failures + 1);
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Promotional consent (separate from the gallery/contest consent, optional, never a condition to compete)
-- ---------------------------------------------------------------------------------------
--
-- A withdrawal after an acceptance opens ONE follow-up task for the team. The system records the request and the pending
-- operational work; it does NOT delete, and does not claim to delete, anything published outside it (Instagram, for instance).

create function record_community_voting_promo_consent_atomically(
  p_instance_id uuid,
  p_host_token text,
  p_operator_member_id uuid,
  p_entry_id uuid,
  p_decision text,
  p_consent_version text,
  p_statement_sha256 text
)
returns table (promo_consent_id uuid, entry_id uuid, decision text, recorded_at timestamptz)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_source uuid;
  v_media_entry uuid;
  v_media_instance uuid;
  v_current text;
  v_id uuid;
  v_at timestamptz;
begin
  perform 1 from community_voting_authorize_operator(p_instance_id, p_host_token, p_operator_member_id, true);
  perform community_voting_require_round(p_instance_id);

  if p_decision is null or p_decision not in ('ACCEPTED', 'DECLINED', 'WITHDRAWN') then
    raise exception 'CV_INVALID_REQUEST: the promotional decision must be ACCEPTED, DECLINED or WITHDRAWN'
      using errcode = 'P0001';
  end if;

  select e.source_entry_id into v_source
  from community_voting_entries e
  where e.entry_id = p_entry_id and e.instance_id = p_instance_id;

  if not found then
    raise exception 'CV_ENTRY_NOT_FOUND: this ballot has no such entry'
      using errcode = 'P0001';
  end if;

  -- The decision belongs to the person, so it is stored on the entry that owns the photograph.
  v_media_entry := coalesce(v_source, p_entry_id);
  select e.instance_id into v_media_instance from community_voting_entries e where e.entry_id = v_media_entry;

  v_current := community_voting_entry_promo_state(v_media_entry);
  if p_decision = 'WITHDRAWN' and v_current is distinct from 'ACCEPTED' then
    raise exception 'CV_INVALID_REQUEST: only an accepted promotional consent can be withdrawn'
      using errcode = 'P0001';
  end if;
  if p_decision = v_current then
    raise exception 'CV_CONSENT_ALREADY_RECORDED: this promotional decision is already in force'
      using errcode = 'P0001';
  end if;

  insert into community_voting_promo_consents (instance_id, entry_id, decision, consent_version, statement_sha256, recorded_by_member_id)
  values (v_media_instance, v_media_entry, p_decision, p_consent_version, p_statement_sha256, p_operator_member_id)
  returning community_voting_promo_consents.promo_consent_id, community_voting_promo_consents.recorded_at into v_id, v_at;

  if p_decision = 'WITHDRAWN' then
    insert into community_voting_followup_tasks (instance_id, entry_id, kind, description, created_by_member_id)
    values (
      v_media_instance, v_media_entry, 'EXTERNAL_PROMO_REMOVAL',
      'La persona retiró su autorización promocional. El sistema solo registra la solicitud: no elimina publicaciones externas '
      || '(por ejemplo, en Instagram). Alguien del equipo debe retirarlas a mano y marcar esta tarea como hecha.',
      p_operator_member_id
    );
  end if;

  perform community_voting_log_operator_action(
    p_instance_id, p_operator_member_id, 'RECORD_PROMO_CONSENT', p_entry_id,
    jsonb_build_object('decision', p_decision, 'consentVersion', p_consent_version)
  );

  return query select v_id, p_entry_id, p_decision, v_at;
end;
$$;

create function resolve_community_voting_followup_task_atomically(
  p_instance_id uuid,
  p_host_token text,
  p_operator_member_id uuid,
  p_task_id uuid,
  p_note text
)
returns table (task_id uuid, status text, resolved_at timestamptz)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_note text;
  v_status text;
  v_at timestamptz := now();
begin
  perform 1 from community_voting_authorize_operator(p_instance_id, p_host_token, p_operator_member_id, true);
  perform community_voting_require_round(p_instance_id);

  v_note := btrim(coalesce(p_note, ''));
  if char_length(v_note) not between 1 and 300 then
    raise exception 'CV_INVALID_REQUEST: the resolution note needs 1 to 300 characters'
      using errcode = 'P0001';
  end if;

  select t.status into v_status
  from community_voting_followup_tasks t
  where t.task_id = p_task_id
    and t.instance_id in (select community_voting_policy_instances(p_instance_id))
  for update;

  if not found then
    raise exception 'CV_INVALID_REQUEST: no such task for this round'
      using errcode = 'P0001';
  end if;

  if v_status <> 'PENDING' then
    raise exception 'CV_ALREADY_CLOSED: this task has already been resolved'
      using errcode = 'P0001';
  end if;

  update community_voting_followup_tasks
  set status = 'DONE', resolved_at = v_at, resolved_by_member_id = p_operator_member_id, resolution_note = v_note
  where community_voting_followup_tasks.task_id = p_task_id;

  perform community_voting_log_operator_action(
    p_instance_id, p_operator_member_id, 'RESOLVE_FOLLOWUP_TASK', null, jsonb_build_object('taskId', p_task_id)
  );

  return query select p_task_id, 'DONE'::text, v_at;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- (1) Photograph visibility: the privacy action
-- ---------------------------------------------------------------------------------------
--
-- Hides the person's photograph now: it is no longer served in ANY round and its bytes are erased. It is possible at any time,
-- including after a round has closed or been published. It does NOT withdraw the candidature, does not touch a vote, does not alter a
-- finalist selection or a result. Deleting the bytes is not claimed to be legal erasure: the metadata, the consents, the decisions
-- and this record stay.

create function hide_community_voting_round_photo_atomically(
  p_instance_id uuid,
  p_host_token text,
  p_operator_member_id uuid,
  p_entry_id uuid,
  p_reason text
)
returns table (action_id uuid, entry_id uuid, performed_at timestamptz)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_reason text;
  v_media_entry uuid;
  v_media_instance uuid;
  v_id uuid;
  v_at timestamptz;
  v_erased integer;
begin
  perform 1 from community_voting_authorize_operator(p_instance_id, p_host_token, p_operator_member_id, true);
  perform community_voting_require_round(p_instance_id);

  v_reason := btrim(coalesce(p_reason, ''));
  if char_length(v_reason) not between 1 and 300 then
    raise exception 'CV_INVALID_REQUEST: a privacy action needs a reason of 1 to 300 characters'
      using errcode = 'P0001';
  end if;

  select coalesce(e.source_entry_id, e.entry_id) into v_media_entry
  from community_voting_entries e
  where e.entry_id = p_entry_id and e.instance_id = p_instance_id;

  if not found then
    raise exception 'CV_ENTRY_NOT_FOUND: this ballot has no such entry'
      using errcode = 'P0001';
  end if;

  if exists (select 1 from community_voting_photo_privacy_actions pa where pa.entry_id = v_media_entry) then
    raise exception 'CV_PHOTO_HIDDEN: this photograph has already been hidden'
      using errcode = 'P0001';
  end if;

  if not exists (select 1 from community_voting_entry_photos ph where ph.entry_id = v_media_entry) then
    raise exception 'CV_PHOTO_REQUIRED: this entry has no photograph to hide'
      using errcode = 'P0001';
  end if;

  select e.instance_id into v_media_instance from community_voting_entries e where e.entry_id = v_media_entry;

  insert into community_voting_photo_privacy_actions (instance_id, entry_id, reason, performed_by_member_id)
  values (v_media_instance, v_media_entry, v_reason, p_operator_member_id)
  returning community_voting_photo_privacy_actions.action_id, community_voting_photo_privacy_actions.performed_at into v_id, v_at;

  update community_voting_entry_photos
  set full_bytes = null, thumb_bytes = null, bytes_deleted_at = now(), bytes_deleted_reason = 'PRIVACY_REQUEST'
  where community_voting_entry_photos.entry_id = v_media_entry and community_voting_entry_photos.bytes_deleted_at is null;
  get diagnostics v_erased = row_count;

  -- The reason is a person's words: it stays in the privacy record and is not copied into the audit trail.
  perform community_voting_log_operator_action(
    p_instance_id, p_operator_member_id, 'HIDE_PHOTO', p_entry_id,
    jsonb_build_object('actionId', v_id, 'photosErased', v_erased)
  );

  return query select v_id, p_entry_id, v_at;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- (2) Candidature withdrawal: one act, honored in BOTH rounds
-- ---------------------------------------------------------------------------------------
--
-- A person withdraws from the event. The entry, the entry it descends from and every entry descending from it are withdrawn in one
-- transaction. Votes already cast are KEPT as evidence; the contestant leaves every ranking, every total and every gallery, and can
-- receive no new vote. A finalist selection is never edited and nobody is added in a withdrawn finalist's place: the consequence is
-- a pending Product policy (FINALIST_WITHDRAWAL_AFTER_SELECTION) that blocks the final and the publications until it is approved.
-- The photograph is erased ONLY when the operator asks for that (p_hide_photo), and then through the privacy action.
-- Withdrawal stays possible at any time, including after a round has closed or been published.

create function withdraw_community_voting_round_candidature_atomically(
  p_instance_id uuid,
  p_host_token text,
  p_operator_member_id uuid,
  p_entry_id uuid,
  p_reason text,
  p_hide_photo boolean default false
)
returns table (withdrawal_id uuid, entry_id uuid, withdrawn_at timestamptz, during_voting boolean, cascaded integer, photo_hidden boolean)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_session_id uuid;
  v_reason text;
  v_media_entry uuid;
  v_media_instance uuid;
  v_own uuid;
  v_own_at timestamptz;
  v_at timestamptz;
  v_open boolean;
  v_cascaded integer := 0;
  v_chain record;
  v_new uuid;
  v_hidden boolean := false;
begin
  select o.o_session_id into v_session_id
  from community_voting_authorize_operator(p_instance_id, p_host_token, p_operator_member_id, true) o;
  perform community_voting_require_round(p_instance_id);

  v_reason := btrim(coalesce(p_reason, ''));
  if char_length(v_reason) not between 1 and 300 then
    raise exception 'CV_INVALID_REQUEST: a withdrawal needs a reason of 1 to 300 characters'
      using errcode = 'P0001';
  end if;

  select coalesce(e.source_entry_id, e.entry_id) into v_media_entry
  from community_voting_entries e
  where e.entry_id = p_entry_id and e.instance_id = p_instance_id
  for update;

  if not found then
    raise exception 'CV_ENTRY_NOT_FOUND: this ballot has no such entry'
      using errcode = 'P0001';
  end if;

  if exists (select 1 from community_voting_withdrawals w where w.entry_id = p_entry_id) then
    raise exception 'CV_ENTRY_ALREADY_WITHDRAWN: this entry has been withdrawn'
      using errcode = 'P0001';
  end if;

  v_open := exists (select 1 from interaction_instances ii where ii.session_id = v_session_id)
            and not exists (select 1 from community_voting_closures c where c.instance_id = p_instance_id);

  perform set_config('urbano.community_voting_round_withdraw', 'on', true);

  -- The requested entry first (its row is the answer), then every other member of the chain that has not withdrawn yet.
  for v_chain in
    select e.entry_id, e.instance_id, e.candidate_id
    from community_voting_entries e
    where (e.entry_id = v_media_entry or e.source_entry_id = v_media_entry)
      and not exists (select 1 from community_voting_withdrawals w where w.entry_id = e.entry_id)
    order by (e.entry_id = p_entry_id) desc, e.created_at, e.entry_id
  loop
    insert into community_voting_withdrawals (instance_id, entry_id, candidate_id, reason, recorded_by_member_id)
    values (v_chain.instance_id, v_chain.entry_id, v_chain.candidate_id, v_reason, p_operator_member_id)
    returning community_voting_withdrawals.withdrawal_id, community_voting_withdrawals.withdrawn_at into v_new, v_at;

    if v_chain.entry_id = p_entry_id then
      v_own := v_new;
      v_own_at := v_at;
    else
      v_cascaded := v_cascaded + 1;
    end if;
  end loop;

  perform set_config('urbano.community_voting_round_withdraw', '', true);

  if coalesce(p_hide_photo, false) then
    v_hidden := true;
    if not exists (select 1 from community_voting_photo_privacy_actions pa where pa.entry_id = v_media_entry) then
      select e.instance_id into v_media_instance from community_voting_entries e where e.entry_id = v_media_entry;

      insert into community_voting_photo_privacy_actions (instance_id, entry_id, reason, performed_by_member_id)
      values (v_media_instance, v_media_entry, v_reason, p_operator_member_id);
    end if;

    update community_voting_entry_photos
    set full_bytes = null, thumb_bytes = null, bytes_deleted_at = now(), bytes_deleted_reason = 'PRIVACY_REQUEST'
    where community_voting_entry_photos.entry_id = v_media_entry and community_voting_entry_photos.bytes_deleted_at is null;
  end if;

  -- The free-text reason is NOT copied into the audit trail (it is a person's words); the withdrawal records hold it.
  perform community_voting_log_operator_action(
    p_instance_id, p_operator_member_id, 'WITHDRAW_CANDIDATURE', p_entry_id,
    jsonb_build_object('withdrawalId', v_own, 'duringVoting', v_open, 'cascaded', v_cascaded, 'photoHidden', v_hidden)
  );

  return query select v_own, p_entry_id, v_own_at, v_open, v_cascaded, v_hidden;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Pending Product policies: the operator's recorded approval
-- ---------------------------------------------------------------------------------------
--
-- The operator records the decision that Product took, with its reference. Nothing is approved by default, only the value the system
-- can execute is accepted, an approval is recorded once for the pair of rounds and never changed, and it changes the review digest,
-- so a review taken before it must be made again.

create function record_community_voting_policy_approval_atomically(
  p_instance_id uuid,
  p_host_token text,
  p_operator_member_id uuid,
  p_policy_key text,
  p_policy_value text,
  p_approval_reference text
)
returns table (approval_id uuid, policy_key text, policy_value text, approved_at timestamptz)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_reference text;
  v_id uuid;
  v_at timestamptz;
begin
  perform 1 from community_voting_authorize_operator(p_instance_id, p_host_token, p_operator_member_id, true);
  perform community_voting_require_round(p_instance_id);

  if not coalesce(
    (p_policy_key = 'ZERO_VALID_VOTES_PRELIMINARY' and p_policy_value = 'ALL_ENTRIES_ADVANCE')
    or (p_policy_key = 'ZERO_VOTE_ENTRIES_AT_CUTOFF' and p_policy_value = 'TIED_ZERO_VOTE_ENTRIES_ADVANCE')
    or (p_policy_key = 'FINALIST_WITHDRAWAL_AFTER_SELECTION' and p_policy_value = 'EXCLUDE_WITHOUT_REFILL'),
    false
  ) then
    raise exception 'CV_INVALID_REQUEST: this policy and value are not supported'
      using errcode = 'P0001';
  end if;

  v_reference := btrim(coalesce(p_approval_reference, ''));
  if char_length(v_reference) not between 3 and 200 then
    raise exception 'CV_INVALID_REQUEST: a policy approval cites the decision it records (3 to 200 characters)'
      using errcode = 'P0001';
  end if;

  if community_voting_policy_approved(p_instance_id, p_policy_key) then
    raise exception 'CV_POLICY_ALREADY_RECORDED: this policy has already been approved for these rounds'
      using errcode = 'P0001';
  end if;

  insert into community_voting_policy_approvals (instance_id, policy_key, policy_value, approval_reference, approved_by_member_id)
  values (p_instance_id, p_policy_key, p_policy_value, v_reference, p_operator_member_id)
  returning community_voting_policy_approvals.approval_id, community_voting_policy_approvals.approved_at into v_id, v_at;

  perform community_voting_log_operator_action(
    p_instance_id, p_operator_member_id, 'RECORD_POLICY_APPROVAL', null,
    jsonb_build_object('policyKey', p_policy_key, 'policyValue', p_policy_value)
  );

  return query select v_id, p_policy_key, p_policy_value, v_at;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- The explicit atomic open
-- ---------------------------------------------------------------------------------------
--
-- The same mechanism and guarantees as start_community_voting_atomically (host + lock + exact capability + atomic materialization
-- of attributed candidates through the Session's OWN start). Readiness: every contestant still on the ballot needs a CONFIRMED
-- association and an APPROVED photograph with the contestant's gallery/contest consent (there must be at least two) — a photograph
-- hidden for privacy since does not make a contestant "not ready": a privacy request does not decide the competition.
--   * PRELIMINARY: needs its configured closing time, in the future (SCHEDULE_REQUIRED). That time is the deadline, however late the
--     operator opens.
--   * FINAL: its entries come from the finalists (prepare), never by hand; it cannot open while a finalist's withdrawal awaits
--     Product's decision. Its deadline is this opening plus its window.
-- The configured opening time is information only: opening is an explicit operator act.

create function start_community_voting_round_atomically(
  p_instance_id uuid,
  p_host_token text,
  p_operator_member_id uuid,
  p_prompt_text text
)
returns table (
  interaction_instance_id uuid,
  prompt_id uuid,
  state text,
  segment_ordinal integer,
  candidate_count integer,
  opened_at timestamptz,
  deadline_at timestamptz
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_session_id uuid;
  v_state text;
  v_role text;
  v_capabilities text[];
  v_prompt text;
  v_total integer;
  v_ready integer;
  v_labels jsonb;
  v_start record;
  v_rows integer;
  v_opened timestamptz;
  v_pending text;
begin
  select o.o_session_id, o.o_session_state into v_session_id, v_state
  from community_voting_authorize_operator(p_instance_id, p_host_token, p_operator_member_id, true) o;
  v_role := community_voting_require_round(p_instance_id);

  select sessions.declared_capabilities into v_capabilities from sessions where sessions.session_id = v_session_id;
  if v_capabilities is distinct from array['VOTING']::text[] then
    raise exception 'CV_CAPABILITY_SET_NOT_EXACTLY_VOTING: the declared capability set must be exactly VOTING'
      using errcode = 'P0001';
  end if;

  if exists (select 1 from interaction_instances ii where ii.session_id = v_session_id) then
    raise exception 'CV_ALREADY_OPENED: Voting has already opened for this event'
      using errcode = 'P0001';
  end if;

  if v_state <> 'LOBBY_LOCKED' then
    raise exception 'CV_SESSION_NOT_STARTABLE: the Session must be locked (LOBBY_LOCKED) before Voting can start'
      using errcode = 'P0001';
  end if;

  v_prompt := btrim(coalesce(p_prompt_text, ''));
  if v_prompt = '' or char_length(v_prompt) > 1000 then
    raise exception 'CV_INVALID_REQUEST: the prompt must be 1 to 1000 characters'
      using errcode = 'P0001';
  end if;

  if v_role = 'PRELIMINARY'
     and not community_voting_deadline_open(community_voting_round_deadline(p_instance_id), clock_timestamp()) then
    raise exception 'CV_SCHEDULE_REQUIRED: the preliminary needs a configured closing time in the future before it can open'
      using errcode = 'P0001';
  end if;

  if v_role = 'FINAL' then
    select p.policy_key into v_pending from community_voting_pending_policies(p_instance_id) p limit 1;
    if v_pending is not null then
      raise exception 'CV_POLICY_REQUIRED: % has no approved Product decision; the final cannot open until it is recorded', v_pending
        using errcode = 'P0001';
    end if;
  end if;

  select count(*)::integer,
         (count(*) filter (
           where e.confirmed_binding_id is not null
             and (select m.m_state from community_voting_entry_media(e.entry_id) m) = 'APPROVED'
         ))::integer
    into v_total, v_ready
  from community_voting_entries e
  where e.instance_id = p_instance_id
    and not exists (select 1 from community_voting_withdrawals w where w.entry_id = e.entry_id);

  if v_total < 2 or v_ready <> v_total then
    raise exception 'CV_PREPARATION_INCOMPLETE: every contestant needs a confirmed association and an approved, consented photograph (and there must be at least two)'
      using errcode = 'P0001';
  end if;

  select jsonb_agg(to_jsonb(e.label) order by e.ordinal) into v_labels
  from community_voting_entries e
  where e.instance_id = p_instance_id
    and not exists (select 1 from community_voting_withdrawals w where w.entry_id = e.entry_id);

  perform set_config('urbano.community_voting_start', v_session_id::text, true);
  perform set_config('urbano.community_voting_round_op', p_instance_id::text, true);

  select * into v_start
  from start_session_atomically(
    p_session_id => v_session_id,
    p_host_token => p_host_token,
    p_prompt_text => v_prompt,
    p_voting_source_type => 'HOST_AUTHORED',
    p_voting_candidates => v_labels
  );

  update voting_candidates
  set participant_id = b.participant_id
  from community_voting_entries e
  join community_voting_voter_bindings b on b.binding_id = e.confirmed_binding_id
  where e.instance_id = p_instance_id
    and not exists (select 1 from community_voting_withdrawals w where w.entry_id = e.entry_id)
    and voting_candidates.interaction_instance_id = v_start.interaction_instance_id
    and voting_candidates.label = e.label;

  get diagnostics v_rows = row_count;
  if v_rows <> v_total then
    raise exception 'CV_STATE_INCONSISTENT: the materialized ballot does not match its preparation'
      using errcode = 'P0001';
  end if;

  update community_voting_entries
  set candidate_id = vc.candidate_id
  from voting_candidates vc
  where community_voting_entries.instance_id = p_instance_id
    and not exists (select 1 from community_voting_withdrawals w where w.entry_id = community_voting_entries.entry_id)
    and vc.interaction_instance_id = v_start.interaction_instance_id
    and vc.label = community_voting_entries.label;

  get diagnostics v_rows = row_count;
  if v_rows <> v_total
     or exists (
       select 1 from voting_candidates vc
       where vc.interaction_instance_id = v_start.interaction_instance_id and vc.participant_id is null
     ) then
    raise exception 'CV_STATE_INCONSISTENT: the materialized ballot does not match its preparation'
      using errcode = 'P0001';
  end if;

  perform set_config('urbano.community_voting_start', '', true);
  perform set_config('urbano.community_voting_round_op', '', true);

  select ii.created_at into v_opened
  from interaction_instances ii
  where ii.interaction_instance_id = v_start.interaction_instance_id;

  perform community_voting_log_operator_action(
    p_instance_id, p_operator_member_id, 'OPEN_VOTING', null,
    jsonb_build_object('interactionInstanceId', v_start.interaction_instance_id, 'candidateCount', v_total, 'roundRole', v_role)
  );

  return query
    select v_start.interaction_instance_id, v_start.prompt_id, v_start.state, v_start.segment_ordinal, v_total, v_opened,
           community_voting_round_deadline(p_instance_id);
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Cast: a gate in front of the unchanged cast_vote_atomically (the pilot's rules)
-- ---------------------------------------------------------------------------------------
--
-- The order of GATE-003's cast (Session lock first, then the binding, then the interaction; ONE transaction, so a failure rolls back
-- the delegated Voting write, its VOTE_CAST event and the recovery metadata together; REPLAY / STALE / UNCHANGED / APPLIED), with the
-- pilot's differences:
--   * identity: the binding must belong to a Gaming Member whose Auth user still has a confirmed email (re-checked on every cast, a
--     replay included — nothing is accepted from a person who no longer qualifies);
--   * a withdrawn contestant cannot be chosen;
--   * the DEADLINE, binding in both rounds and measured by the database clock AFTER the locks are held, so a request that waited for
--     the Session lock across the deadline is refused and stores nothing, and the visual counter is never the authority:
--       PRELIMINARY: the configured closing time, whether or not the operator has closed the round;
--       FINAL: its explicit opening plus its window.
--     A REPLAY of an already-applied intent is still answered, so a voter whose confirmation was lost can recover it;
--   * the geofence is evaluated ONLY when the Instance has one (the FINAL), for EVERY new intent — a revision included. The
--     PRELIMINARY has no venue and any coordinates sent to it are ignored and never stored.
-- A rejected attempt consumes nothing, so an intent that failed (outside the venue, window elapsed ...) can be retried as is.

create function cast_community_voting_round_vote_atomically(
  p_instance_id uuid,
  p_auth_user_id uuid,
  p_binding_id uuid,
  p_intent_no integer,
  p_interaction_instance_id uuid,
  p_candidate_id uuid,
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy_meters double precision
)
returns table (
  outcome text,
  binding_id uuid,
  intent_no integer,
  interaction_instance_id uuid,
  candidate_id uuid,
  vote_updated_at timestamptz
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_instance community_voting_instances%rowtype;
  v_session_state text;
  v_binding community_voting_voter_bindings%rowtype;
  v_cur_id uuid;
  v_cur_state text;
  v_cur_engine text;
  v_cur_created timestamptz;
  v_deadline timestamptz;
  v_digest text;
  v_vote_candidate uuid;
  v_vote_updated timestamptz;
  v_assess record;
  v_distance numeric(12, 1);
  v_accuracy numeric(10, 1);
  v_token text;
  v_delegate record;
  v_outcome text;
begin
  select * into v_instance
  from community_voting_instances i
  where i.instance_id = p_instance_id;

  if not found then
    raise exception 'CV_INSTANCE_NOT_FOUND: no Community Voting Instance exists for this id'
      using errcode = 'P0001';
  end if;

  if v_instance.ballot_mode is distinct from 'FAVORITE_ROUND' then
    raise exception 'CV_NOT_A_ROUND: this operation applies to a two-round Instance only'
      using errcode = 'P0001';
  end if;

  -- 1. SESSION-FIRST
  select sessions.state into v_session_state
  from sessions
  where sessions.session_id = v_instance.session_id
  for update;

  select * into v_binding
  from community_voting_voter_bindings b
  where b.instance_id = p_instance_id and b.auth_user_id = p_auth_user_id
  for update;

  if not found then
    raise exception 'CV_NOT_BOUND: this identity is not bound to the Instance'
      using errcode = 'P0001';
  end if;

  -- 1b. the pilot identity, re-checked: a confirmed email AND the Gaming Member this binding points at
  if not community_voting_email_confirmed(p_auth_user_id) then
    raise exception 'CV_VERIFIED_EMAIL_REQUIRED: a verified email address is required to vote'
      using errcode = 'P0001';
  end if;
  if v_binding.gaming_member_id is null or not exists (
    select 1 from gaming_members m where m.gaming_member_id = v_binding.gaming_member_id and m.auth_user_id = p_auth_user_id
  ) then
    raise exception 'CV_PROFILE_INCOMPLETE: complete your URBANO Gaming profile to vote'
      using errcode = 'P0001';
  end if;

  -- 2. an intent belongs to exactly one binding
  if p_binding_id is distinct from v_binding.binding_id then
    raise exception 'CV_INTENT_BINDING_MISMATCH: the intent does not belong to this voter binding'
      using errcode = 'P0001';
  end if;

  -- 3. only server-issued intents exist
  if p_intent_no is null or p_intent_no < 1 or p_intent_no > v_binding.issued_intent_no then
    raise exception 'CV_INTENT_UNISSUED: this intent was not issued to this binding'
      using errcode = 'P0001';
  end if;

  -- The canonical payload commitment: Instance, Voting interaction and candidate (identical to GATE-003's).
  v_digest := encode(
    sha256(convert_to(
      'cv1|' || p_instance_id::text
      || '|' || coalesce(p_interaction_instance_id::text, '')
      || '|' || coalesce(p_candidate_id::text, ''),
      'UTF8'
    )),
    'hex'
  );

  -- 4. REPLAY
  if p_intent_no = v_binding.applied_intent_no then
    if v_binding.applied_payload_digest is distinct from v_digest then
      raise exception 'CV_INTENT_PAYLOAD_MISMATCH: this intent was already applied with a different payload'
        using errcode = 'P0001';
    end if;

    select v.candidate_id, v.updated_at into v_vote_candidate, v_vote_updated
    from votes v
    where v.interaction_instance_id = p_interaction_instance_id
      and v.participant_id = v_binding.participant_id;

    if not found then
      raise exception 'CV_STATE_INCONSISTENT: an applied intent has no authoritative vote'
        using errcode = 'P0001';
    end if;

    return query select 'REPLAYED'::text, v_binding.binding_id, p_intent_no,
      p_interaction_instance_id, v_vote_candidate, v_vote_updated;
    return;
  end if;

  -- 5. STALE: an older intent can never overwrite a newer applied one
  if p_intent_no < v_binding.applied_intent_no then
    raise exception 'CV_STALE_INTENT: a newer intent has already been applied'
      using errcode = 'P0001';
  end if;

  -- 6. a NEW intent
  if v_session_state <> 'LOBBY_LOCKED' then
    raise exception 'CV_VOTING_NOT_OPEN: voting is not open'
      using errcode = 'P0001';
  end if;

  select ii.interaction_instance_id, ii.state, ii.engine_type, ii.created_at
    into v_cur_id, v_cur_state, v_cur_engine, v_cur_created
  from interaction_instances ii
  where ii.session_id = v_instance.session_id
  order by ii.created_at desc
  limit 1
  for update;

  if v_cur_id is null or v_cur_engine <> 'VOTING' or v_cur_state <> 'PROMPT_ACTIVE' then
    raise exception 'CV_VOTING_NOT_OPEN: voting is not open'
      using errcode = 'P0001';
  end if;

  if p_interaction_instance_id is distinct from v_cur_id then
    raise exception 'CV_INTERACTION_MISMATCH: the stated interaction is not the current Voting interaction'
      using errcode = 'P0001';
  end if;

  -- 6b. the DEADLINE, by the database clock, strictly before it (see the head of this function)
  if v_instance.round_role = 'PRELIMINARY' then
    select sc.voting_closes_at into v_deadline from community_voting_schedules sc where sc.instance_id = p_instance_id;
  else
    v_deadline := v_cur_created + make_interval(secs => v_instance.window_seconds);
  end if;

  if not community_voting_deadline_open(v_deadline, clock_timestamp()) then
    raise exception 'CV_VOTING_WINDOW_ELAPSED: the voting time of this round has ended'
      using errcode = 'P0001';
  end if;

  if p_candidate_id is null or not exists (
    select 1 from voting_candidates vc
    where vc.candidate_id = p_candidate_id and vc.interaction_instance_id = v_cur_id
  ) then
    raise exception 'INVALID_CANDIDATE_SELECTION: selected candidate is not valid for this Voting interaction'
      using errcode = 'P0001';
  end if;

  if exists (select 1 from community_voting_withdrawals w where w.candidate_id = p_candidate_id) then
    raise exception 'CV_CANDIDATE_NOT_AVAILABLE: this contestant has withdrawn'
      using errcode = 'P0001';
  end if;

  -- INVARIANT (see GATE-003): an open event ballot never has an unattributed candidate.
  if exists (
    select 1 from voting_candidates vc
    where vc.interaction_instance_id = v_cur_id and vc.participant_id is null
  ) then
    raise exception 'CV_STATE_INCONSISTENT: an open ballot has an unattributed candidate'
      using errcode = 'P0001';
  end if;

  -- 7. location: only when the Instance has a venue (the FINAL), for every new intent. Raw coordinates are parameters of this
  --    call only: never stored, logged or echoed. The PRELIMINARY ignores them entirely.
  if v_instance.venue_latitude is not null then
    select * into v_assess
    from community_voting_assess_location(
      v_instance.venue_latitude, v_instance.venue_longitude, v_instance.venue_radius_meters,
      v_instance.max_accuracy_meters, v_instance.inside_margin_factor, v_instance.outside_margin_factor,
      p_latitude, p_longitude, p_accuracy_meters
    );

    if v_assess.decision = 'ACCURACY_EXCESSIVE' then
      raise exception 'CV_LOCATION_ACCURACY_EXCESSIVE: the reading is too imprecise to be accepted'
        using errcode = 'P0001';
    elsif v_assess.decision = 'OUTSIDE' then
      raise exception 'CV_LOCATION_OUTSIDE: the reading is outside the event area'
        using errcode = 'P0001';
    elsif v_assess.decision = 'AMBIGUOUS' then
      raise exception 'CV_LOCATION_AMBIGUOUS: the reading cannot be confirmed inside or outside the event area'
        using errcode = 'P0001';
    end if;

    v_distance := round(v_assess.distance_meters::numeric, 1);
    v_accuracy := round(p_accuracy_meters::numeric, 1);
  end if;

  -- 8. no-op reselection, or delegation to the unchanged Voting writer under the vote marker
  select v.candidate_id, v.updated_at into v_vote_candidate, v_vote_updated
  from votes v
  where v.interaction_instance_id = v_cur_id and v.participant_id = v_binding.participant_id;

  if found and v_vote_candidate = p_candidate_id then
    v_outcome := 'UNCHANGED';
  else
    select participants.participant_token into v_token
    from participants
    where participants.participant_id = v_binding.participant_id;

    perform set_config('urbano.community_voting_round_vote', v_instance.session_id::text, true);

    select * into v_delegate
    from cast_vote_atomically(v_instance.session_id, v_binding.participant_id, v_token, p_candidate_id);

    perform set_config('urbano.community_voting_round_vote', '', true);

    v_vote_updated := v_delegate.updated_at;
    v_outcome := 'APPLIED';
  end if;

  -- 9. record ONLY the accepted recovery metadata (derived evidence — never a coordinate; null in the preliminary)
  update community_voting_voter_bindings
  set applied_intent_no = p_intent_no,
      applied_payload_digest = v_digest,
      applied_distance_meters = v_distance,
      applied_accuracy_meters = v_accuracy,
      applied_at = now()
  where community_voting_voter_bindings.binding_id = v_binding.binding_id;

  return query select v_outcome, v_binding.binding_id, p_intent_no, v_cur_id, p_candidate_id, v_vote_updated;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- The explicit atomic close
-- ---------------------------------------------------------------------------------------
--
-- The Session's own close transition is called with the close marker set; the interaction guard refuses that transition from any
-- other path for a round, so there is NO way to close one without leaving the closure record. The record commits to the number of
-- votes and to the digest of the result. Closing is the operator's act and is separate from the review and from the publication.
-- Concurrency: a vote cast at the same moment holds the Session lock first or waits for it; either it commits before the close and is
-- counted, or it finds the interaction closed and is refused. There is no third outcome.

create function close_community_voting_round_atomically(
  p_instance_id uuid,
  p_host_token text,
  p_operator_member_id uuid
)
returns table (closed_at timestamptz, valid_vote_count integer, results_digest text)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_session_id uuid;
  v_cur_id uuid;
  v_cur_state text;
  v_count integer;
  v_digest text;
  v_closed timestamptz := now();
begin
  select o.o_session_id into v_session_id
  from community_voting_authorize_operator(p_instance_id, p_host_token, p_operator_member_id, true) o;
  perform community_voting_require_round(p_instance_id);

  if exists (select 1 from community_voting_closures c where c.instance_id = p_instance_id) then
    raise exception 'CV_ALREADY_CLOSED: voting has already been closed'
      using errcode = 'P0001';
  end if;

  select ii.interaction_instance_id, ii.state into v_cur_id, v_cur_state
  from interaction_instances ii
  where ii.session_id = v_session_id
  order by ii.created_at desc
  limit 1
  for update;

  if v_cur_id is null or v_cur_state <> 'PROMPT_ACTIVE' then
    raise exception 'CV_VOTING_NOT_OPEN: voting is not open'
      using errcode = 'P0001';
  end if;

  perform set_config('urbano.community_voting_round_close', v_session_id::text, true);
  perform close_submissions_atomically(v_session_id, p_host_token, 'SUBMISSIONS_CLOSED', '{}'::jsonb);

  select count(*)::integer into v_count from votes v where v.interaction_instance_id = v_cur_id;
  v_digest := community_voting_compute_round_digest(p_instance_id);

  insert into community_voting_closures (instance_id, interaction_instance_id, closed_at, closed_by_member_id, valid_vote_count, results_digest)
  values (p_instance_id, v_cur_id, v_closed, p_operator_member_id, v_count, v_digest);

  perform set_config('urbano.community_voting_round_close', '', true);

  perform community_voting_log_operator_action(
    p_instance_id, p_operator_member_id, 'CLOSE_VOTING', null,
    jsonb_build_object('validVotes', v_count, 'resultsDigest', v_digest)
  );

  return query select v_closed, v_count, v_digest;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- (4) The finalist cut (preliminary only, after its close)
-- ---------------------------------------------------------------------------------------
--
-- Deterministic and free of discretion: the function takes NO list from its caller. The finalists are the contestants who have not
-- withdrawn whose standard competition rank is at most the cutoff (ten) — so every contestant tied with the tenth advances, and when
-- there are ten or fewer contestants all of them advance. It FAILS CLOSED while a Product policy it depends on has no recorded
-- approval (nobody voted; a contestant without a single vote would advance): nothing is written and nobody advances by default.
-- Called again after it succeeded it changes nothing and says so.

create function select_community_voting_finalists_atomically(
  p_instance_id uuid,
  p_host_token text,
  p_operator_member_id uuid
)
returns table (finalist_count integer, eligible_count integer, selection_digest text, selected_at timestamptz, already_selected boolean)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_role text;
  v_interaction uuid;
  v_cutoff integer;
  v_eligible integer;
  v_finalists integer;
  v_digest text;
  v_requirement text;
  v_existing community_voting_finalist_selections%rowtype;
  v_at timestamptz := now();
begin
  perform 1 from community_voting_authorize_operator(p_instance_id, p_host_token, p_operator_member_id, true);
  v_role := community_voting_require_round(p_instance_id);

  if v_role <> 'PRELIMINARY' then
    raise exception 'CV_WRONG_ROUND: finalists are selected from the preliminary round only'
      using errcode = 'P0001';
  end if;

  select * into v_existing from community_voting_finalist_selections s where s.preliminary_instance_id = p_instance_id;
  if found then
    return query select v_existing.finalist_count, v_existing.eligible_count, v_existing.selection_digest, v_existing.selected_at, true;
    return;
  end if;

  select c.interaction_instance_id into v_interaction from community_voting_closures c where c.instance_id = p_instance_id;
  if v_interaction is null then
    raise exception 'CV_RESULTS_NOT_AVAILABLE: the preliminary has not been closed'
      using errcode = 'P0001';
  end if;

  select i.finalist_cutoff into v_cutoff from community_voting_instances i where i.instance_id = p_instance_id;

  select count(*)::integer into v_eligible
  from community_voting_compute_round_results(p_instance_id) r
  where not r.r_withdrawn;

  if v_eligible < 1 then
    raise exception 'CV_NO_ELIGIBLE_ENTRIES: no contestant remains to advance'
      using errcode = 'P0001';
  end if;

  v_requirement := community_voting_cut_policy_requirement(p_instance_id);
  if v_requirement is not null and not community_voting_policy_approved(p_instance_id, v_requirement) then
    raise exception 'CV_POLICY_REQUIRED: % has no approved Product decision; the finalist cut cannot be confirmed until it is recorded', v_requirement
      using errcode = 'P0001';
  end if;

  select count(*)::integer,
         encode(sha256(convert_to(
           'cvfin1|' || v_cutoff::text || '|'
           || coalesce(string_agg(r.r_ordinal::text || ':' || r.r_rank::text || ':' || r.r_votes::text, ';' order by r.r_ordinal), ''),
           'UTF8')), 'hex')
    into v_finalists, v_digest
  from community_voting_compute_round_results(p_instance_id) r
  where not r.r_withdrawn and r.r_rank <= v_cutoff;

  perform set_config('urbano.community_voting_finalists', p_instance_id::text, true);

  insert into community_voting_finalist_selections (
    preliminary_instance_id, interaction_instance_id, rule, cutoff_size, eligible_count, finalist_count, selection_digest, selected_at, selected_by_member_id
  )
  values (p_instance_id, v_interaction, 'TOP_N_WITH_CUTOFF_TIES_V1', v_cutoff, v_eligible, v_finalists, v_digest, v_at, p_operator_member_id);

  insert into community_voting_finalists (preliminary_instance_id, entry_id, candidate_id, competition_rank, votes_at_selection)
  select p_instance_id, r.r_entry_id, r.r_candidate_id, r.r_rank, r.r_votes
  from community_voting_compute_round_results(p_instance_id) r
  where not r.r_withdrawn and r.r_rank <= v_cutoff;

  perform set_config('urbano.community_voting_finalists', '', true);

  perform community_voting_log_operator_action(
    p_instance_id, p_operator_member_id, 'SELECT_FINALISTS', null,
    jsonb_build_object('finalists', v_finalists, 'eligible', v_eligible, 'cutoff', v_cutoff, 'selectionDigest', v_digest)
  );

  return query select v_finalists, v_eligible, v_digest, v_at, false;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- The final's preparation: carry the finalists across
-- ---------------------------------------------------------------------------------------
--
-- Creates, in ONE transaction, the final's entry for each finalist who has not withdrawn. Each entry REFERENCES the preliminary
-- entry (so the photograph, the consent and the withdrawal are the person's, not copied), keeps its public number, and is CONFIRMED
-- to the contestant's binding in this round. That binding is made with the unchanged GATE-003 bind for the contestant's own canonical
-- identity, which the pilot trigger accepts only for a confirmed email and an existing Gaming Member: no identity or profile is
-- created here, and no account is linked or merged. The final starts from zero: nothing of the preliminary's votes is copied.
-- A finalist who withdrew after the cut is not carried and nobody takes their place; that consequence waits for Product's decision
-- (FINALIST_WITHDRAWAL_AFTER_SELECTION) and the final cannot be prepared before it is recorded. Called again it changes nothing
-- and says so.

create function prepare_community_voting_final_atomically(
  p_instance_id uuid,
  p_host_token text,
  p_operator_member_id uuid
)
returns table (carried_count integer, already_prepared boolean)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_session_id uuid;
  v_role text;
  v_source uuid;
  v_finalist record;
  v_binding uuid;
  v_n integer := 0;
  v_pending text;
begin
  select o.o_session_id into v_session_id
  from community_voting_authorize_operator(p_instance_id, p_host_token, p_operator_member_id, true) o;
  v_role := community_voting_require_round(p_instance_id);

  if v_role <> 'FINAL' then
    raise exception 'CV_WRONG_ROUND: only a final is prepared from a preliminary''s finalists'
      using errcode = 'P0001';
  end if;

  -- Idempotent: a second call (even after the final has opened) reports what the first one made and changes nothing.
  if exists (select 1 from community_voting_entries e where e.instance_id = p_instance_id) then
    return query select (select count(*)::integer from community_voting_entries e where e.instance_id = p_instance_id), true;
    return;
  end if;

  if exists (select 1 from interaction_instances ii where ii.session_id = v_session_id) then
    raise exception 'CV_PREPARATION_CLOSED: Voting has opened; the ballot can no longer change'
      using errcode = 'P0001';
  end if;

  select i.source_instance_id into v_source from community_voting_instances i where i.instance_id = p_instance_id;

  if not exists (select 1 from community_voting_finalist_selections s where s.preliminary_instance_id = v_source) then
    raise exception 'CV_FINALISTS_NOT_SELECTED: the preliminary has no finalist selection yet'
      using errcode = 'P0001';
  end if;

  select p.policy_key into v_pending from community_voting_pending_policies(p_instance_id) p limit 1;
  if v_pending is not null then
    raise exception 'CV_POLICY_REQUIRED: % has no approved Product decision; the final cannot be prepared until it is recorded', v_pending
      using errcode = 'P0001';
  end if;

  perform set_config('urbano.community_voting_round_op', p_instance_id::text, true);

  for v_finalist in
    select pe.entry_id, pe.label, pe.ordinal, pb.auth_user_id
    from community_voting_finalists f
    join community_voting_entries pe on pe.entry_id = f.entry_id
    join community_voting_voter_bindings pb on pb.binding_id = pe.confirmed_binding_id
    where f.preliminary_instance_id = v_source
      and not exists (select 1 from community_voting_withdrawals w where w.entry_id = pe.entry_id)
    order by pe.ordinal
  loop
    select b.binding_id into v_binding
    from bind_community_voting_voter_atomically(p_instance_id, v_finalist.auth_user_id) b;

    insert into community_voting_entries (
      instance_id, ordinal, label, claim_window_seconds, claim_expires_at, confirmed_binding_id, confirmed_at, source_entry_id
    )
    values (p_instance_id, v_finalist.ordinal, v_finalist.label, 1, now(), v_binding, now(), v_finalist.entry_id);

    v_n := v_n + 1;
  end loop;

  perform set_config('urbano.community_voting_round_op', '', true);

  if v_n < 1 then
    raise exception 'CV_NO_ELIGIBLE_ENTRIES: no finalist remains to carry into the final'
      using errcode = 'P0001';
  end if;

  perform community_voting_log_operator_action(
    p_instance_id, p_operator_member_id, 'PREPARE_FINAL', null,
    jsonb_build_object('carried', v_n, 'sourceInstanceId', v_source)
  );

  return query select v_n, false;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Operator reads (no Session lock, so a polling screen never delays a vote)
-- ---------------------------------------------------------------------------------------

-- Per-contestant totals are an operator-only fact and exist ONLY once the round has been closed: during voting they are hidden from
-- everyone, the operator included.
create function read_community_voting_round_results(
  p_instance_id uuid,
  p_host_token text,
  p_operator_member_id uuid
)
returns table (
  candidate_id uuid,
  entry_id uuid,
  label text,
  ordinal integer,
  withdrawn boolean,
  votes bigint,
  competition_rank integer,
  finalist boolean,
  winner boolean
)
language plpgsql
stable
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_role text;
begin
  perform 1 from community_voting_authorize_operator(p_instance_id, p_host_token, p_operator_member_id, false);
  v_role := community_voting_require_round(p_instance_id);

  if not exists (select 1 from community_voting_closures c where c.instance_id = p_instance_id) then
    raise exception 'CV_RESULTS_NOT_AVAILABLE: totals are not available until the round has been closed'
      using errcode = 'P0001';
  end if;

  return query
    select r.r_candidate_id, r.r_entry_id, r.r_label, r.r_ordinal, r.r_withdrawn, r.r_votes, r.r_rank,
           (v_role = 'PRELIMINARY' and exists (
              select 1 from community_voting_finalists f
              where f.preliminary_instance_id = p_instance_id and f.entry_id = r.r_entry_id)),
           (v_role = 'FINAL' and not r.r_withdrawn and r.r_rank = 1 and r.r_votes > 0)
    from community_voting_compute_round_results(p_instance_id) r;
end;
$$;

create function read_community_voting_round_evidence(
  p_instance_id uuid,
  p_host_token text,
  p_operator_member_id uuid
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_session_id uuid;
  v_role text;
  v_window integer;
  v_opened timestamptz;
  v_closure community_voting_closures%rowtype;
  v_selection community_voting_finalist_selections%rowtype;
  v_review community_voting_round_reviews%rowtype;
  v_pub community_voting_publications%rowtype;
begin
  select o.o_session_id into v_session_id
  from community_voting_authorize_operator(p_instance_id, p_host_token, p_operator_member_id, false) o;
  v_role := community_voting_require_round(p_instance_id);

  select i.window_seconds into v_window from community_voting_instances i where i.instance_id = p_instance_id;
  select min(ii.created_at) into v_opened from interaction_instances ii where ii.session_id = v_session_id;
  select * into v_closure from community_voting_closures c where c.instance_id = p_instance_id;
  select * into v_selection from community_voting_finalist_selections s where s.preliminary_instance_id = p_instance_id;
  select * into v_review from community_voting_round_reviews r where r.instance_id = p_instance_id order by r.reviewed_at desc, r.review_id desc limit 1;
  select * into v_pub from community_voting_publications p where p.instance_id = p_instance_id;

  return jsonb_build_object(
    'roundRole', v_role,
    'openedAt', v_opened,
    'windowSeconds', v_window,
    'deadlineAt', community_voting_round_deadline(p_instance_id),
    'closed', v_closure.instance_id is not null,
    'closedAt', v_closure.closed_at,
    'resultsDigest', v_closure.results_digest,
    'validVotesAtClose', v_closure.valid_vote_count,
    'currentReviewDigest', case when v_closure.instance_id is not null then community_voting_compute_review_digest(p_instance_id) else null end,
    'finalists', case when v_selection.preliminary_instance_id is null then null else jsonb_build_object(
      'selectedAt', v_selection.selected_at, 'cutoff', v_selection.cutoff_size, 'eligible', v_selection.eligible_count,
      'finalists', v_selection.finalist_count, 'digest', v_selection.selection_digest) end,
    'review', case when v_review.review_id is null then null else jsonb_build_object(
      'reviewedAt', v_review.reviewed_at, 'digest', v_review.results_digest) end,
    'publication', case when v_pub.instance_id is null then null else jsonb_build_object(
      'publishedAt', v_pub.published_at, 'digest', v_pub.results_digest) end,
    'policies', coalesce((
      select jsonb_agg(jsonb_build_object(
               'key', a.policy_key, 'value', a.policy_value, 'approvalReference', a.approval_reference, 'approvedAt', a.approved_at)
             order by a.policy_key)
      from community_voting_policy_approvals a
      where a.instance_id in (select community_voting_policy_instances(p_instance_id))
    ), '[]'::jsonb),
    'withdrawals', coalesce((
      select jsonb_agg(jsonb_build_object(
               'label', e.label, 'withdrawnAt', w.withdrawn_at,
               'afterClose', (v_closure.instance_id is not null and w.withdrawn_at > v_closure.closed_at),
               'duringVoting', (v_opened is not null and w.withdrawn_at >= v_opened
                                and (v_closure.instance_id is null or w.withdrawn_at <= v_closure.closed_at)))
             order by w.withdrawn_at)
      from community_voting_withdrawals w
      join community_voting_entries e on e.entry_id = w.entry_id
      where w.instance_id = p_instance_id
    ), '[]'::jsonb),
    'privacyActions', coalesce((
      select jsonb_agg(jsonb_build_object('label', e.label, 'at', pa.performed_at) order by pa.performed_at, pa.action_id)
      from community_voting_photo_privacy_actions pa
      join community_voting_entries e on e.entry_id = pa.entry_id
      where pa.instance_id = p_instance_id
         or pa.entry_id in (select x.source_entry_id from community_voting_entries x where x.instance_id = p_instance_id and x.source_entry_id is not null)
    ), '[]'::jsonb),
    'operatorActions', coalesce((
      select jsonb_agg(jsonb_build_object('action', a.action, 'at', a.occurred_at) order by a.occurred_at, a.action_id)
      from community_voting_operator_actions a
      where a.instance_id = p_instance_id
    ), '[]'::jsonb)
  );
end;
$$;

-- The operator's working view of one round, plus live counters. NEVER a total per contestant.
create function read_community_voting_round_overview(
  p_instance_id uuid,
  p_host_token text,
  p_operator_member_id uuid
)
returns jsonb
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_session_id uuid;
  v_state text;
  v_role text;
  v_window integer;
  v_cur_id uuid;
  v_cur_state text;
  v_review community_voting_round_reviews%rowtype;
  v_closed boolean;
begin
  select o.o_session_id, o.o_session_state into v_session_id, v_state
  from community_voting_authorize_operator(p_instance_id, p_host_token, p_operator_member_id, false) o;
  v_role := community_voting_require_round(p_instance_id);

  select i.window_seconds into v_window from community_voting_instances i where i.instance_id = p_instance_id;

  select ii.interaction_instance_id, ii.state into v_cur_id, v_cur_state
  from interaction_instances ii
  where ii.session_id = v_session_id
  order by ii.created_at desc
  limit 1;

  v_closed := exists (select 1 from community_voting_closures c where c.instance_id = p_instance_id);
  select * into v_review from community_voting_round_reviews r where r.instance_id = p_instance_id order by r.reviewed_at desc, r.review_id desc limit 1;

  return jsonb_build_object(
    'roundRole', v_role,
    'sessionState', v_state,
    'interactionState', v_cur_state,
    'opened', v_cur_state is not null,
    'closed', v_closed,
    'published', exists (select 1 from community_voting_publications p where p.instance_id = p_instance_id),
    'serverNow', clock_timestamp(),
    'windowSeconds', v_window,
    'deadlineAt', community_voting_round_deadline(p_instance_id),
    'schedule', (
      select jsonb_build_object(
        'registrationOpensAt', s.registration_opens_at, 'contestantCutoffAt', s.contestant_cutoff_at,
        'votingOpensAt', s.voting_opens_at, 'votingClosesAt', s.voting_closes_at, 'status', s.status)
      from community_voting_schedules s where s.instance_id = p_instance_id),
    'counters', jsonb_build_object(
      'boundVoters', (select count(*) from community_voting_voter_bindings b where b.instance_id = p_instance_id),
      'votes', (select count(*) from votes v where v.interaction_instance_id = v_cur_id),
      'entries', (select count(*) from community_voting_entries e where e.instance_id = p_instance_id),
      'withdrawn', (select count(*) from community_voting_withdrawals w where w.instance_id = p_instance_id)),
    'finalistsSelected', exists (select 1 from community_voting_finalist_selections s where s.preliminary_instance_id = p_instance_id),
    -- a closed final with no valid vote has no result: the screen says so and offers neither the review nor the publication
    'noValidResult', community_voting_has_no_valid_result(p_instance_id),
    'policies', (
      select jsonb_agg(jsonb_build_object(
               'key', k.key, 'approved', a.policy_value is not null, 'value', a.policy_value, 'approvalReference', a.approval_reference)
             order by k.key)
      from (values ('FINALIST_WITHDRAWAL_AFTER_SELECTION'), ('ZERO_VALID_VOTES_PRELIMINARY'), ('ZERO_VOTE_ENTRIES_AT_CUTOFF')) k(key)
      left join lateral (
        select pa.policy_value, pa.approval_reference
        from community_voting_policy_approvals pa
        where pa.policy_key = k.key and pa.instance_id in (select community_voting_policy_instances(p_instance_id))
        order by pa.approved_at
        limit 1
      ) a on true),
    'pendingResolutions', coalesce((
      select jsonb_agg(jsonb_build_object('key', p.policy_key) order by p.policy_key)
      from community_voting_pending_policies(p_instance_id) p
    ), '[]'::jsonb),
    'review', case when v_review.review_id is null then null else jsonb_build_object(
      'reviewedAt', v_review.reviewed_at,
      'digest', v_review.results_digest,
      'current', v_closed and v_review.results_digest = community_voting_compute_review_digest(p_instance_id)) end,
    'tasks', coalesce((
      select jsonb_agg(jsonb_build_object(
               'taskId', t.task_id, 'kind', t.kind, 'status', t.status, 'description', t.description,
               'createdAt', t.created_at, 'resolvedAt', t.resolved_at, 'resolutionNote', t.resolution_note)
             order by t.created_at, t.task_id)
      from community_voting_followup_tasks t
      where t.instance_id in (select community_voting_policy_instances(p_instance_id))
    ), '[]'::jsonb),
    'publishedAffected', coalesce((
      select jsonb_agg(jsonb_build_object('alias', pr.alias, 'ordinal', pr.ordinal) order by pr.ordinal)
      from community_voting_published_results pr
      where pr.instance_id = p_instance_id
        and exists (select 1 from community_voting_withdrawals w where w.entry_id = pr.entry_id)
    ), '[]'::jsonb),
    'entries', coalesce((
      select jsonb_agg(jsonb_build_object(
        'entryId', e.entry_id,
        'label', e.label,
        'association', case when e.confirmed_binding_id is not null then 'CONFIRMED'
                            when e.pending_binding_id is not null then 'PENDING_CONFIRMATION'
                            else 'UNCLAIMED' end,
        'media', case
                   when (select m.m_hidden from community_voting_entry_media(e.entry_id) m) then 'HIDDEN'
                   else coalesce((select m.m_state from community_voting_entry_media(e.entry_id) m), 'NONE')
                 end,
        'photoId', (select m.m_photo_id from community_voting_entry_media(e.entry_id) m),
        'promotional', community_voting_entry_promo_state(e.entry_id),
        'withdrawn', exists (select 1 from community_voting_withdrawals w where w.entry_id = e.entry_id),
        'carried', e.source_entry_id is not null,
        'claimable', (e.pending_binding_id is null and e.confirmed_binding_id is null
                      and e.claim_code_hash is not null and e.claim_expires_at > now()),
        'claimExpiresAt', case when e.claim_code_hash is not null then e.claim_expires_at else null end
      ) order by e.ordinal)
      from community_voting_entries e
      where e.instance_id = p_instance_id
    ), '[]'::jsonb)
  );
end;
$$;

-- ---------------------------------------------------------------------------------------
-- (5) Review and (6) publication
-- ---------------------------------------------------------------------------------------
--
-- Review is the operator's recorded confirmation that they looked at the CLOSED result; it commits to the review digest. Publication
-- needs a review of the CURRENT state: after any withdrawal, any policy decision, the review is stale and must be made again. The
-- order of the publication's own refusals is: already published, not closed, NO VALID RESULT (a final with no valid vote), not reviewed, review
-- stale, Product policy pending.
-- A publication freezes WHAT WAS ANNOUNCED — the finalists' (or winners') public numbers, never a count — in an immutable snapshot.

create function record_community_voting_round_review_atomically(
  p_instance_id uuid,
  p_host_token text,
  p_operator_member_id uuid,
  p_note text
)
returns table (review_id uuid, results_digest text, reviewed_at timestamptz)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_role text;
  v_digest text;
  v_note text;
  v_id uuid;
  v_at timestamptz;
begin
  perform 1 from community_voting_authorize_operator(p_instance_id, p_host_token, p_operator_member_id, true);
  v_role := community_voting_require_round(p_instance_id);

  if not exists (select 1 from community_voting_closures c where c.instance_id = p_instance_id) then
    raise exception 'CV_RESULTS_NOT_AVAILABLE: the round has not been closed'
      using errcode = 'P0001';
  end if;

  if v_role = 'PRELIMINARY'
     and not exists (select 1 from community_voting_finalist_selections s where s.preliminary_instance_id = p_instance_id) then
    raise exception 'CV_FINALISTS_NOT_SELECTED: the finalist cut must be made before the preliminary is reviewed'
      using errcode = 'P0001';
  end if;

  v_note := nullif(btrim(coalesce(p_note, '')), '');
  if v_note is not null and char_length(v_note) > 300 then
    raise exception 'CV_INVALID_REQUEST: the review note is at most 300 characters'
      using errcode = 'P0001';
  end if;

  v_digest := community_voting_compute_review_digest(p_instance_id);

  insert into community_voting_round_reviews (instance_id, results_digest, reviewed_by_member_id, note)
  values (p_instance_id, v_digest, p_operator_member_id, v_note)
  returning community_voting_round_reviews.review_id, community_voting_round_reviews.reviewed_at into v_id, v_at;

  perform community_voting_log_operator_action(
    p_instance_id, p_operator_member_id, 'REVIEW_RESULTS', null,
    jsonb_build_object('reviewId', v_id, 'digest', v_digest)
  );

  return query select v_id, v_digest, v_at;
end;
$$;

create function publish_community_voting_round_atomically(
  p_instance_id uuid,
  p_host_token text,
  p_operator_member_id uuid
)
returns table (published_at timestamptz, results_digest text)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_session_id uuid;
  v_role text;
  v_current text;
  v_pending text;
  v_review community_voting_round_reviews%rowtype;
  v_at timestamptz := now();
begin
  select o.o_session_id into v_session_id
  from community_voting_authorize_operator(p_instance_id, p_host_token, p_operator_member_id, true) o;
  v_role := community_voting_require_round(p_instance_id);

  if exists (select 1 from community_voting_publications p where p.instance_id = p_instance_id) then
    raise exception 'CV_ALREADY_PUBLISHED: the results of this round have already been published'
      using errcode = 'P0001';
  end if;

  if not exists (select 1 from community_voting_closures c where c.instance_id = p_instance_id) then
    raise exception 'CV_RESULTS_NOT_AVAILABLE: the round has not been closed'
      using errcode = 'P0001';
  end if;

  -- A final with no valid vote has no result. This comes BEFORE the review and the Product decisions on purpose: no review, current or stale,
  -- and no decision about a withdrawal can make a result out of zero valid votes, and the operator is told so rather than asked for more steps.
  if community_voting_has_no_valid_result(p_instance_id) then
    raise exception 'CV_NO_VALID_RESULT: this final has no valid votes, so there is no result to publish; it needs an explicit resolution'
      using errcode = 'P0001';
  end if;

  select * into v_review
  from community_voting_round_reviews r
  where r.instance_id = p_instance_id
  order by r.reviewed_at desc, r.review_id desc
  limit 1;

  if not found then
    raise exception 'CV_REVIEW_REQUIRED: the operator must review the closed result before it is published'
      using errcode = 'P0001';
  end if;

  v_current := community_voting_compute_review_digest(p_instance_id);
  if v_review.results_digest is distinct from v_current then
    raise exception 'CV_REVIEW_STALE: the result or the eligible contestants changed after it was reviewed; review it again'
      using errcode = 'P0001';
  end if;

  select p.policy_key into v_pending from community_voting_pending_policies(p_instance_id) p limit 1;
  if v_pending is not null then
    raise exception 'CV_POLICY_REQUIRED: % has no approved Product decision; the result cannot be published until it is recorded', v_pending
      using errcode = 'P0001';
  end if;

  perform set_config('urbano.community_voting_round_publish', v_session_id::text, true);
  perform reveal_results_atomically(v_session_id, p_host_token, 'RESULTS_REVEALED', '{}'::jsonb);

  insert into community_voting_publications (instance_id, review_id, results_digest, published_at, published_by_member_id)
  values (p_instance_id, v_review.review_id, v_current, v_at, p_operator_member_id);

  -- The snapshot of what is announced: public number and order, never a count. Nothing rewrites it afterwards.
  insert into community_voting_published_results (instance_id, entry_id, kind, alias, ordinal)
  select p_instance_id,
         r.r_entry_id,
         case v_role when 'PRELIMINARY' then 'FINALISTS' else 'WINNERS' end,
         r.r_label,
         r.r_ordinal
  from community_voting_compute_round_results(p_instance_id) r
  where not r.r_withdrawn
    and (
      (v_role = 'PRELIMINARY'
        and exists (select 1 from community_voting_finalists f where f.preliminary_instance_id = p_instance_id and f.entry_id = r.r_entry_id))
      or (v_role = 'FINAL' and r.r_rank = 1 and r.r_votes > 0)
    );

  perform set_config('urbano.community_voting_round_publish', '', true);

  perform community_voting_log_operator_action(
    p_instance_id, p_operator_member_id, 'PUBLISH_RESULTS', null,
    jsonb_build_object('reviewId', v_review.review_id, 'digest', v_current)
  );

  return query select v_at, v_current;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Public reads (no identity: numbers, labels and schedule only; never a count that reveals standing)
-- ---------------------------------------------------------------------------------------
--
-- The server's own clock is part of the answer: a browser's counter is derived from it and is never the authority. A contestant is
-- shown when the association is CONFIRMED, the current photograph is APPROVED with the gallery/contest consent, the person has not
-- asked for it to be hidden and the candidature has not been withdrawn. That is a permission to SHOW a photograph; it does not depend
-- on the round being open, and it never lets anyone vote: voting needs the round open (see the cast).

create function read_community_voting_round_public_info(p_instance_id uuid)
returns table (
  round_role text,
  session_state text,
  interaction_state text,
  opened_at timestamptz,
  window_seconds integer,
  deadline_at timestamptz,
  server_now timestamptz,
  location_required boolean,
  registration_opens_at timestamptz,
  contestant_cutoff_at timestamptz,
  voting_opens_at timestamptz,
  voting_closes_at timestamptz,
  schedule_status text,
  approved_contestants integer,
  closed boolean,
  published boolean
)
language sql
stable
security invoker
set search_path = public
as $$
  select i.round_role,
         s.state,
         ci.state,
         ci.created_at,
         i.window_seconds,
         community_voting_round_deadline(i.instance_id),
         clock_timestamp(),
         i.venue_latitude is not null,
         sc.registration_opens_at,
         sc.contestant_cutoff_at,
         sc.voting_opens_at,
         sc.voting_closes_at,
         sc.status,
         (select count(*)::integer
          from community_voting_entries e
          where e.instance_id = i.instance_id
            and e.confirmed_binding_id is not null
            and not exists (select 1 from community_voting_withdrawals w where w.entry_id = e.entry_id)
            and (select m.m_state from community_voting_entry_media(e.entry_id) m) = 'APPROVED'),
         exists (select 1 from community_voting_closures c where c.instance_id = i.instance_id),
         exists (select 1 from community_voting_publications p where p.instance_id = i.instance_id)
  from community_voting_instances i
  join sessions s on s.session_id = i.session_id
  left join lateral (
    select ii.state, ii.created_at
    from interaction_instances ii
    where ii.session_id = i.session_id
    order by ii.created_at desc
    limit 1
  ) ci on true
  left join community_voting_schedules sc on sc.instance_id = i.instance_id
  where i.instance_id = p_instance_id and i.ballot_mode = 'FAVORITE_ROUND';
$$;

create function read_community_voting_round_gallery(p_instance_id uuid)
returns table (alias text, candidate_id uuid, ordinal integer)
language sql
stable
security invoker
set search_path = public
as $$
  select e.label, e.candidate_id, e.ordinal
  from community_voting_entries e
  join community_voting_instances i on i.instance_id = e.instance_id and i.ballot_mode = 'FAVORITE_ROUND'
  cross join lateral community_voting_entry_media(e.entry_id) m
  where e.instance_id = p_instance_id
    and e.confirmed_binding_id is not null
    and not exists (select 1 from community_voting_withdrawals w where w.entry_id = e.entry_id)
    and m.m_state = 'APPROVED'
    and not m.m_hidden
  order by e.ordinal;
$$;

-- One photograph by its opaque number. The same eligibility as the gallery, and the bytes must still exist.
create function read_community_voting_round_photo(p_instance_id uuid, p_alias text, p_variant text)
returns table (content_type text, bytes_b64 text, sha256 text)
language sql
stable
security invoker
set search_path = public
as $$
  select p.content_type,
         encode(case when p_variant = 'thumb' then p.thumb_bytes else p.full_bytes end, 'base64'),
         case when p_variant = 'thumb' then p.thumb_sha256 else p.full_sha256 end
  from community_voting_entries e
  join community_voting_instances i on i.instance_id = e.instance_id and i.ballot_mode = 'FAVORITE_ROUND'
  cross join lateral community_voting_entry_media(e.entry_id) m
  join community_voting_entry_photos p on p.photo_id = m.m_photo_id
  where e.instance_id = p_instance_id
    and e.label = '#' || p_alias
    and p_variant in ('thumb', 'full')
    and e.confirmed_binding_id is not null
    and not exists (select 1 from community_voting_withdrawals w where w.entry_id = e.entry_id)
    and m.m_state = 'APPROVED'
    and not m.m_hidden
    and p.full_bytes is not null;
$$;

-- What a PUBLISHED round announced: the finalists (preliminary) or the winners (final), read from the immutable snapshot. Nothing
-- before publication, and no counts. A contestant who withdraws afterwards stays in what was announced; the operator is told instead.
create function read_community_voting_round_public_results(p_instance_id uuid)
returns table (kind text, alias text, ordinal integer)
language sql
stable
security invoker
set search_path = public
as $$
  select pr.kind, pr.alias, pr.ordinal
  from community_voting_published_results pr
  join community_voting_instances i on i.instance_id = pr.instance_id and i.ballot_mode = 'FAVORITE_ROUND'
  where pr.instance_id = p_instance_id
  order by pr.ordinal;
$$;

-- ---------------------------------------------------------------------------------------
-- Status recovery (read-only)
-- ---------------------------------------------------------------------------------------
--
-- The caller's OWN bounded snapshot. Zero rows when the caller has no binding. It exposes no Participant token, no Participant id,
-- no other voter and no tally, and it does not depend on the round being open: a committed vote is recoverable after close.

create function read_community_voting_round_voter_status(
  p_instance_id uuid,
  p_auth_user_id uuid
)
returns table (
  instance_id uuid,
  binding_id uuid,
  round_role text,
  session_state text,
  interaction_instance_id uuid,
  interaction_state text,
  issued_intent_no integer,
  applied_intent_no integer,
  my_candidate_id uuid,
  my_entry_label text,
  my_entry_state text,
  opened_at timestamptz,
  deadline_at timestamptz,
  server_now timestamptz,
  closed boolean,
  published boolean
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    b.instance_id,
    b.binding_id,
    i.round_role,
    s.state,
    ci.interaction_instance_id,
    ci.state,
    b.issued_intent_no,
    b.applied_intent_no,
    (
      select v.candidate_id from votes v
      where v.interaction_instance_id = ci.interaction_instance_id
        and v.participant_id = b.participant_id
    ),
    me.label,
    case
      when me.confirmed_binding_id is not null then 'CONFIRMED'
      when me.pending_binding_id is not null then 'PENDING_CONFIRMATION'
      else null
    end,
    ci.created_at,
    community_voting_round_deadline(i.instance_id),
    clock_timestamp(),
    exists (select 1 from community_voting_closures c where c.instance_id = i.instance_id),
    exists (select 1 from community_voting_publications p where p.instance_id = i.instance_id)
  from community_voting_voter_bindings b
  join community_voting_instances i on i.instance_id = b.instance_id and i.ballot_mode = 'FAVORITE_ROUND'
  join sessions s on s.session_id = i.session_id
  left join lateral (
    select ii.interaction_instance_id, ii.state, ii.created_at
    from interaction_instances ii
    where ii.session_id = s.session_id
    order by ii.created_at desc
    limit 1
  ) ci on true
  left join lateral (
    select e.label, e.pending_binding_id, e.confirmed_binding_id
    from community_voting_entries e
    where e.instance_id = b.instance_id
      and (e.pending_binding_id = b.binding_id or e.confirmed_binding_id = b.binding_id)
    limit 1
  ) me on true
  where b.instance_id = p_instance_id and b.auth_user_id = p_auth_user_id;
$$;

-- ---------------------------------------------------------------------------------------
-- Privileges: service_role only.
-- ---------------------------------------------------------------------------------------
--
-- Created under this project's standing default-privilege rule (EXECUTE to PUBLIC, anon and authenticated), so each is revoked in the
-- SAME migration that creates it (ENGINEERING_PATTERNS.md, 0126). service_role keeps its EXECUTE. The pure helpers are revoked too:
-- nothing a browser role can call reads any of these tables.

revoke execute on function community_voting_authorize_operator(uuid, text, uuid, boolean) from public, anon, authenticated;
revoke execute on function community_voting_log_operator_action(uuid, uuid, text, uuid, jsonb) from public, anon, authenticated;
revoke execute on function community_voting_require_round(uuid) from public, anon, authenticated;
revoke execute on function community_voting_require_preliminary(uuid) from public, anon, authenticated;
revoke execute on function community_voting_preliminary_of(uuid) from public, anon, authenticated;
revoke execute on function community_voting_policy_instances(uuid) from public, anon, authenticated;
revoke execute on function community_voting_policy_approved(uuid, text) from public, anon, authenticated;
revoke execute on function community_voting_deadline_open(timestamptz, timestamptz) from public, anon, authenticated;
revoke execute on function community_voting_round_deadline(uuid) from public, anon, authenticated;
revoke execute on function community_voting_entry_media(uuid) from public, anon, authenticated;
revoke execute on function community_voting_entry_promo_state(uuid) from public, anon, authenticated;
revoke execute on function community_voting_compute_round_results(uuid) from public, anon, authenticated;
revoke execute on function community_voting_compute_round_digest(uuid) from public, anon, authenticated;
revoke execute on function community_voting_valid_vote_count(uuid) from public, anon, authenticated;
revoke execute on function community_voting_has_no_valid_result(uuid) from public, anon, authenticated;
revoke execute on function community_voting_cut_policy_requirement(uuid) from public, anon, authenticated;
revoke execute on function community_voting_pending_policies(uuid) from public, anon, authenticated;
revoke execute on function community_voting_compute_review_digest(uuid) from public, anon, authenticated;
revoke execute on function register_community_voting_round_atomically(uuid, text, uuid, integer, text, uuid, double precision, double precision, double precision, double precision, double precision, double precision, integer) from public, anon, authenticated;
revoke execute on function set_community_voting_round_schedule_atomically(uuid, text, uuid, timestamptz, timestamptz, timestamptz, timestamptz, text) from public, anon, authenticated;
revoke execute on function create_community_voting_round_entry_atomically(uuid, text, uuid, integer) from public, anon, authenticated;
revoke execute on function remove_community_voting_round_entry_atomically(uuid, text, uuid, uuid) from public, anon, authenticated;
revoke execute on function upload_community_voting_round_photo_atomically(uuid, text, uuid, uuid, text, text, integer, integer) from public, anon, authenticated;
revoke execute on function record_community_voting_round_consent_atomically(uuid, text, uuid, uuid, uuid, text, text, boolean) from public, anon, authenticated;
revoke execute on function decide_community_voting_round_photo_atomically(uuid, text, uuid, uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function claim_community_voting_round_entry_atomically(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function confirm_community_voting_round_entry_atomically(uuid, text, uuid, uuid, text) from public, anon, authenticated;
revoke execute on function record_community_voting_promo_consent_atomically(uuid, text, uuid, uuid, text, text, text) from public, anon, authenticated;
revoke execute on function resolve_community_voting_followup_task_atomically(uuid, text, uuid, uuid, text) from public, anon, authenticated;
revoke execute on function hide_community_voting_round_photo_atomically(uuid, text, uuid, uuid, text) from public, anon, authenticated;
revoke execute on function withdraw_community_voting_round_candidature_atomically(uuid, text, uuid, uuid, text, boolean) from public, anon, authenticated;
revoke execute on function record_community_voting_policy_approval_atomically(uuid, text, uuid, text, text, text) from public, anon, authenticated;
revoke execute on function start_community_voting_round_atomically(uuid, text, uuid, text) from public, anon, authenticated;
revoke execute on function cast_community_voting_round_vote_atomically(uuid, uuid, uuid, integer, uuid, uuid, double precision, double precision, double precision) from public, anon, authenticated;
revoke execute on function close_community_voting_round_atomically(uuid, text, uuid) from public, anon, authenticated;
revoke execute on function select_community_voting_finalists_atomically(uuid, text, uuid) from public, anon, authenticated;
revoke execute on function prepare_community_voting_final_atomically(uuid, text, uuid) from public, anon, authenticated;
revoke execute on function read_community_voting_round_results(uuid, text, uuid) from public, anon, authenticated;
revoke execute on function read_community_voting_round_evidence(uuid, text, uuid) from public, anon, authenticated;
revoke execute on function read_community_voting_round_overview(uuid, text, uuid) from public, anon, authenticated;
revoke execute on function record_community_voting_round_review_atomically(uuid, text, uuid, text) from public, anon, authenticated;
revoke execute on function publish_community_voting_round_atomically(uuid, text, uuid) from public, anon, authenticated;
revoke execute on function read_community_voting_round_public_info(uuid) from public, anon, authenticated;
revoke execute on function read_community_voting_round_gallery(uuid) from public, anon, authenticated;
revoke execute on function read_community_voting_round_photo(uuid, text, text) from public, anon, authenticated;
revoke execute on function read_community_voting_round_public_results(uuid) from public, anon, authenticated;
revoke execute on function read_community_voting_round_voter_status(uuid, uuid) from public, anon, authenticated;
