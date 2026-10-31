-- Migration: 20261031120100_community_voting_four_category_functions
-- Halloween Community Voting — the four-category contest's operations (UG-IV-GATE-018). See 20261031120000 for the composition.
--
-- ADDITIVE and SELF-DESCRIBING. Nothing earlier is edited. Two small existing helpers are REPLACED (CREATE OR REPLACE, same signature, same
-- privileges) because the contest changes what they must say, and both are exactly the old definition plus one clause:
--   community_voting_cut_policy_requirement  a category round has no finalist cut, so it never requires a cut policy (otherwise the pilot's
--                                            policy gate on publication would block a category with an unvoted contestant);
--   community_voting_entry_media             a GROUP photograph is APPROVED only while every attributed member has a confirmed association and has
--                                            consented to THAT photograph (the consent of all the people photographed).
-- Every other operation of the pilot — create entry, photograph, consent, decision, claim, confirm, withdraw, hide, close, bind, intent —
-- is used by a category round exactly as it is. The functions below are the ones a category round needs that the pilot could not express.
--
-- Conventions of the pilot, kept: every function is `security invoker`, service_role only (EXECUTE revoked from PUBLIC, anon and authenticated at
-- the end of this file); the operator's authority is proved by community_voting_authorize_operator (host token + designated operator); the
-- Session lock comes first; every refusal is `CV_*` with errcode P0001 and a stable prefix the TypeScript layer maps.
--
-- NO FUNCTION HERE TAKES A COORDINATE. A category vote has no location parameter at all, so no caller can send, store or be refused for one.

-- ---------------------------------------------------------------------------------------
-- Helpers
-- ---------------------------------------------------------------------------------------

create function community_voting_category_of(p_instance_id uuid)
returns text
language sql
stable
security invoker
set search_path = public
as $$
  select cr.category_key from community_voting_category_rounds cr where cr.instance_id = p_instance_id;
$$;

create function community_voting_require_category_round(p_instance_id uuid)
returns text
language plpgsql
stable
security invoker
set search_path = public
as $$
declare
  v_key text;
begin
  v_key := community_voting_category_of(p_instance_id);
  if v_key is null then
    raise exception 'CV_NOT_A_CATEGORY_ROUND: this operation applies to a category round of the four-category contest only'
      using errcode = 'P0001';
  end if;
  return v_key;
end;
$$;

-- A category round has no finalist cut. Same definition as the pilot's, plus: never for a category round.
create or replace function community_voting_cut_policy_requirement(p_instance_id uuid)
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
      and not exists (select 1 from community_voting_category_rounds cr where cr.instance_id = ci.instance_id)
  )
  select case
           when not exists (select 1 from i) then null
           when not exists (select 1 from r) then null
           when (select coalesce(sum(r.r_votes), 0) from r) = 0 then 'ZERO_VALID_VOTES_PRELIMINARY'
           when exists (select 1 from r, i where r.r_rank <= i.cutoff and r.r_votes = 0) then 'ZERO_VOTE_ENTRIES_AT_CUTOFF'
           else null
         end;
$$;

-- Is a group's photograph backed by EVERY person in it? A group needs at least one attributed member besides its representative, and each member
-- must have a CONFIRMED association (a canonical identity) and must have consented to this exact photograph. An entry that is not a group is
-- always complete (its own consent is what the pilot already requires).
create function community_voting_group_complete(p_entry_id uuid, p_photo_id uuid)
returns boolean
language sql
stable
security invoker
set search_path = public
as $$
  select case
           when e.entry_kind <> 'GROUP' then true
           else exists (select 1 from community_voting_entries m where m.group_entry_id = e.entry_id and m.entry_kind = 'GROUP_MEMBER')
                and not exists (
                  select 1
                  from community_voting_entries m
                  where m.group_entry_id = e.entry_id
                    and m.entry_kind = 'GROUP_MEMBER'
                    and (
                      m.confirmed_binding_id is null
                      or not exists (
                        select 1 from community_voting_member_consents mc
                        where mc.member_entry_id = m.entry_id and mc.photo_id = p_photo_id
                      )
                    )
                )
         end
  from community_voting_entries e
  where e.entry_id = p_entry_id;
$$;

-- The pilot's definition, with one change: a GROUP photograph the operator approved is APPROVED only when the group is complete. Until then it
-- reads PENDING_CONSENT (somebody in the photograph has not consented or has not been associated), whatever the decision says; the decision is
-- kept, so the photograph becomes APPROVED the moment the last person is in, with no second decision.
create or replace function community_voting_entry_media(p_entry_id uuid)
returns table (m_photo_id uuid, m_state text, m_hidden boolean)
language sql
stable
security invoker
set search_path = public
as $$
  select p.photo_id,
         case
           when d.decision = 'APPROVED' then
             case when community_voting_group_complete(p_entry_id, p.photo_id) then 'APPROVED' else 'PENDING_CONSENT' end
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

-- ---------------------------------------------------------------------------------------
-- Registration of a category round (and, with the first one, of the contest)
-- ---------------------------------------------------------------------------------------
--
-- One call per category, each with its own Session and host token. The pilot's registration proves the host token, the operator, the exact
-- VOTING capability set and that nobody has joined yet; this wrapper then records which category the round is and which contest it belongs to.
-- Without a contest id a new contest is created; with one, the category must be free and the operator the same. A category round is never a test
-- round and never has a venue.

create function register_community_voting_category_round_atomically(
  p_session_id uuid,
  p_host_token text,
  p_operator_member_id uuid,
  p_rule_version integer,
  p_contest_id uuid,
  p_category_key text
)
returns table (
  instance_id uuid,
  session_id uuid,
  contest_id uuid,
  category_key text,
  rule_version integer,
  created_at timestamptz
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_contest uuid;
  v_operator uuid;
  v_inst record;
begin
  if p_category_key is null or p_category_key not in ('MOST_ELABORATE', 'SEXIEST', 'BEST_GROUP', 'FUNNIEST') then
    raise exception 'CV_INVALID_REQUEST: the category must be one of the four categories of the contest'
      using errcode = 'P0001';
  end if;

  if p_contest_id is not null then
    select c.contest_id, c.operator_gaming_member_id into v_contest, v_operator
    from community_voting_contests c
    where c.contest_id = p_contest_id
    for update;

    if v_contest is null then
      raise exception 'CV_CONTEST_NOT_FOUND: no contest exists for this id'
        using errcode = 'P0001';
    end if;
    if p_operator_member_id is null or v_operator is distinct from p_operator_member_id then
      raise exception 'CV_OPERATOR_REQUIRED: only the contest''s designated operator may register its categories'
        using errcode = 'P0001';
    end if;
    if exists (select 1 from community_voting_category_rounds cr where cr.contest_id = v_contest and cr.category_key = p_category_key) then
      raise exception 'CV_CATEGORY_ALREADY_REGISTERED: this category already has its round in the contest'
        using errcode = 'P0001';
    end if;
  end if;

  -- Host token, designated operator, capability set, "before any participant" and the one-Instance-per-Session rule are the pilot's own.
  select * into v_inst
  from register_community_voting_round_atomically(
    p_session_id, p_host_token, p_operator_member_id, p_rule_version, 'PRELIMINARY', null, null, null, null, null, null, null, null, false
  );

  if v_contest is null then
    insert into community_voting_contests (operator_gaming_member_id) values (p_operator_member_id) returning community_voting_contests.contest_id into v_contest;
  end if;

  perform set_config('urbano.community_voting_category_register', v_inst.instance_id::text, true);
  insert into community_voting_category_rounds (instance_id, contest_id, category_key) values (v_inst.instance_id, v_contest, p_category_key);
  perform set_config('urbano.community_voting_category_register', '', true);

  return query select v_inst.instance_id, v_inst.session_id, v_contest, p_category_key, v_inst.rule_version, v_inst.created_at;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Group entries and group members
-- ---------------------------------------------------------------------------------------
--
-- A GROUP is the ballot candidate of the group category: ONE photograph, ONE representative (the entry's own association, exactly a contestant's).
-- Every other person in it is a GROUP_MEMBER entry of the same Instance: it is created by the operator, handed its own single-use claim credential,
-- claimed by that person signed in with their OWN verified identity and confirmed with their own code — the pilot's association, unchanged — so the
-- member is a canonical Gaming Member, never a typed name. A member has no photograph and no candidate: it exists to attribute the person, to
-- obtain their consent to the group's photograph and to refuse their vote for the group. Operator-created, pre-opening, claimable until its window.

create function community_voting_create_entry_row(
  p_instance_id uuid,
  p_kind text,
  p_group_entry_id uuid,
  p_claim_ttl_seconds integer
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
  select ci.session_id into v_session_id from community_voting_instances ci where ci.instance_id = p_instance_id;

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

  insert into community_voting_entries (instance_id, ordinal, label, claim_code_hash, claim_window_seconds, claim_expires_at, entry_kind, group_entry_id)
  values (p_instance_id, v_ordinal, v_label, encode(sha256(convert_to(v_code, 'UTF8')), 'hex'), p_claim_ttl_seconds, v_expires, p_kind, p_group_entry_id)
  returning community_voting_entries.entry_id into v_entry_id;

  perform set_config('urbano.community_voting_round_op', '', true);

  return query select v_entry_id, v_label, v_code, v_expires;
end;
$$;

create function create_community_voting_group_entry_atomically(
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
  v_row record;
begin
  perform 1 from community_voting_authorize_operator(p_instance_id, p_host_token, p_operator_member_id, true);
  perform community_voting_require_category_round(p_instance_id);

  if community_voting_category_of(p_instance_id) <> 'BEST_GROUP' then
    raise exception 'CV_WRONG_CATEGORY: only the group category takes group candidacies'
      using errcode = 'P0001';
  end if;

  select * into v_row from community_voting_create_entry_row(p_instance_id, 'GROUP', null, p_claim_ttl_seconds);

  perform community_voting_log_operator_action(p_instance_id, p_operator_member_id, 'CREATE_ENTRY', v_row.entry_id, jsonb_build_object('kind', 'GROUP'));

  return query select v_row.entry_id, v_row.label, v_row.claim_code, v_row.claim_expires_at;
end;
$$;

create function create_community_voting_group_member_atomically(
  p_instance_id uuid,
  p_host_token text,
  p_operator_member_id uuid,
  p_group_entry_id uuid,
  p_claim_ttl_seconds integer default 900
)
returns table (entry_id uuid, label text, claim_code text, claim_expires_at timestamptz)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  c_max_members constant integer := 30;
  v_row record;
  v_kind text;
begin
  perform 1 from community_voting_authorize_operator(p_instance_id, p_host_token, p_operator_member_id, true);
  perform community_voting_require_category_round(p_instance_id);

  select e.entry_kind into v_kind
  from community_voting_entries e
  where e.entry_id = p_group_entry_id and e.instance_id = p_instance_id;

  if v_kind is null then
    raise exception 'CV_ENTRY_NOT_FOUND: this ballot has no such entry'
      using errcode = 'P0001';
  end if;
  if v_kind <> 'GROUP' then
    raise exception 'CV_WRONG_ENTRY_KIND: members belong to a group candidacy'
      using errcode = 'P0001';
  end if;
  if exists (select 1 from community_voting_withdrawals w where w.entry_id = p_group_entry_id) then
    raise exception 'CV_ENTRY_ALREADY_WITHDRAWN: this entry has been withdrawn'
      using errcode = 'P0001';
  end if;
  if (select count(*) from community_voting_entries m where m.group_entry_id = p_group_entry_id) >= c_max_members then
    raise exception 'CV_GROUP_FULL: a group has at most % attributed members', c_max_members
      using errcode = 'P0001';
  end if;

  select * into v_row from community_voting_create_entry_row(p_instance_id, 'GROUP_MEMBER', p_group_entry_id, p_claim_ttl_seconds);

  perform community_voting_log_operator_action(
    p_instance_id, p_operator_member_id, 'CREATE_ENTRY', v_row.entry_id, jsonb_build_object('kind', 'GROUP_MEMBER', 'groupEntryId', p_group_entry_id)
  );

  return query select v_row.entry_id, v_row.label, v_row.claim_code, v_row.claim_expires_at;
end;
$$;

-- The consent of ONE attributed member to the group's CURRENT photograph (the representative's own consent is the pilot's, on the group entry).
create function record_community_voting_member_consent_atomically(
  p_instance_id uuid,
  p_host_token text,
  p_operator_member_id uuid,
  p_member_entry_id uuid,
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
  v_group uuid;
  v_kind text;
  v_current uuid;
  v_consent_id uuid;
  v_accepted timestamptz;
begin
  select o.o_session_id into v_session_id
  from community_voting_authorize_operator(p_instance_id, p_host_token, p_operator_member_id, true) o;
  perform community_voting_require_category_round(p_instance_id);

  if exists (select 1 from interaction_instances ii where ii.session_id = v_session_id) then
    raise exception 'CV_PREPARATION_CLOSED: Voting has opened; the ballot can no longer change'
      using errcode = 'P0001';
  end if;

  select e.entry_kind, e.group_entry_id into v_kind, v_group
  from community_voting_entries e
  where e.entry_id = p_member_entry_id and e.instance_id = p_instance_id;

  if v_kind is null then
    raise exception 'CV_ENTRY_NOT_FOUND: this ballot has no such entry'
      using errcode = 'P0001';
  end if;
  if v_kind <> 'GROUP_MEMBER' then
    raise exception 'CV_WRONG_ENTRY_KIND: this consent belongs to an attributed member of a group'
      using errcode = 'P0001';
  end if;
  if exists (select 1 from community_voting_withdrawals w where w.entry_id = v_group) then
    raise exception 'CV_ENTRY_ALREADY_WITHDRAWN: this entry has been withdrawn'
      using errcode = 'P0001';
  end if;

  select m.m_photo_id into v_current from community_voting_entry_media(v_group) m;
  if v_current is null or v_current is distinct from p_photo_id then
    raise exception 'CV_PHOTO_REQUIRED: consent is recorded against the group''s current photograph'
      using errcode = 'P0001';
  end if;
  if p_age_confirmed is distinct from true then
    raise exception 'CV_CONSENT_REQUIRED: the person must confirm being of legal age and accept the statement'
      using errcode = 'P0001';
  end if;
  if p_consent_version is null or p_consent_version !~ '^[A-Za-z0-9._-]{1,64}$'
     or p_statement_sha256 is null or p_statement_sha256 !~ '^[0-9a-f]{64}$' then
    raise exception 'CV_INVALID_REQUEST: the consent version or statement digest is malformed'
      using errcode = 'P0001';
  end if;
  if exists (select 1 from community_voting_member_consents c where c.member_entry_id = p_member_entry_id and c.photo_id = p_photo_id) then
    raise exception 'CV_CONSENT_ALREADY_RECORDED: consent is already recorded for this person and this photograph'
      using errcode = 'P0001';
  end if;

  insert into community_voting_member_consents (
    instance_id, group_entry_id, member_entry_id, photo_id, consent_version, statement_sha256, age_confirmed, recorded_by_member_id
  )
  values (p_instance_id, v_group, p_member_entry_id, p_photo_id, p_consent_version, p_statement_sha256, true, p_operator_member_id)
  returning community_voting_member_consents.consent_id, community_voting_member_consents.accepted_at into v_consent_id, v_accepted;

  perform community_voting_log_operator_action(
    p_instance_id, p_operator_member_id, 'RECORD_CONSENT', p_member_entry_id,
    jsonb_build_object('photoId', p_photo_id, 'consentVersion', p_consent_version, 'groupEntryId', v_group)
  );

  return query select v_consent_id, v_accepted;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- The atomic opening of a category round
-- ---------------------------------------------------------------------------------------
--
-- The pilot's opening of a PRELIMINARY, with the contest's differences: members are not ballot entries; the ballot is the candidacies that are
-- complete (confirmed association, an approved and consented photograph and — for a group — every member associated and consenting); and there
-- must be at least two of them, because a ballot of one is not a choice. The deadline is the CONFIGURED closing time: an operator who opens late
-- gets a shorter window and never a longer one. Opening is only ever this explicit call.

create function start_community_voting_category_atomically(
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
  v_category text;
  v_capabilities text[];
  v_prompt text;
  v_total integer;
  v_ready integer;
  v_labels jsonb;
  v_start record;
  v_rows integer;
  v_opened timestamptz;
begin
  select o.o_session_id, o.o_session_state into v_session_id, v_state
  from community_voting_authorize_operator(p_instance_id, p_host_token, p_operator_member_id, true) o;
  v_category := community_voting_require_category_round(p_instance_id);

  select sessions.declared_capabilities into v_capabilities from sessions where sessions.session_id = v_session_id;
  if v_capabilities is distinct from array['VOTING']::text[] then
    raise exception 'CV_CAPABILITY_SET_NOT_EXACTLY_VOTING: the declared capability set must be exactly VOTING'
      using errcode = 'P0001';
  end if;

  if exists (select 1 from interaction_instances ii where ii.session_id = v_session_id) then
    raise exception 'CV_ALREADY_OPENED: Voting has already opened for this category'
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

  if not community_voting_deadline_open(community_voting_round_deadline(p_instance_id), clock_timestamp()) then
    raise exception 'CV_SCHEDULE_REQUIRED: the category needs a configured closing time in the future before it can open'
      using errcode = 'P0001';
  end if;

  select count(*)::integer,
         (count(*) filter (
           where e.confirmed_binding_id is not null
             and (select m.m_state from community_voting_entry_media(e.entry_id) m) = 'APPROVED'
         ))::integer
    into v_total, v_ready
  from community_voting_entries e
  where e.instance_id = p_instance_id
    and e.entry_kind <> 'GROUP_MEMBER'
    and not exists (select 1 from community_voting_withdrawals w where w.entry_id = e.entry_id);

  if v_total < 2 or v_ready <> v_total then
    raise exception 'CV_PREPARATION_INCOMPLETE: every candidacy needs a confirmed association and an approved, consented photograph (and every member of a group too), and there must be at least two'
      using errcode = 'P0001';
  end if;

  -- A member who has not been associated or has not consented would already keep its group out of the "ready" count above (a group photograph is
  -- not APPROVED until every member is in). This is the second, independent look: no member of a ballot group may be left unassociated.
  if exists (
    select 1
    from community_voting_entries m
    join community_voting_entries g on g.entry_id = m.group_entry_id
    where m.instance_id = p_instance_id
      and m.entry_kind = 'GROUP_MEMBER'
      and m.confirmed_binding_id is null
      and not exists (select 1 from community_voting_withdrawals w where w.entry_id = g.entry_id)
  ) then
    raise exception 'CV_PREPARATION_INCOMPLETE: every member of a group must be associated before voting can open'
      using errcode = 'P0001';
  end if;

  select jsonb_agg(to_jsonb(e.label) order by e.ordinal) into v_labels
  from community_voting_entries e
  where e.instance_id = p_instance_id
    and e.entry_kind <> 'GROUP_MEMBER'
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
    and e.entry_kind <> 'GROUP_MEMBER'
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
    and community_voting_entries.entry_kind <> 'GROUP_MEMBER'
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
    jsonb_build_object('interactionInstanceId', v_start.interaction_instance_id, 'candidateCount', v_total, 'category', v_category)
  );

  return query
    select v_start.interaction_instance_id, v_start.prompt_id, v_start.state, v_start.segment_ordinal, v_total, v_opened,
           community_voting_round_deadline(p_instance_id);
end;
$$;

-- ---------------------------------------------------------------------------------------
-- The vote: the pilot's cast behind one more refusal, and NO location parameter
-- ---------------------------------------------------------------------------------------
--
-- The pilot's cast keeps every rule (Session lock first, verified identity re-checked on every cast, the intent and its replay, the deadline by
-- the database clock, a withdrawn contestant, the unchanged cast_vote_atomically with its own self-vote refusal for the contestant or a
-- representative). This gate adds what it could not know: an attributed MEMBER of a group cannot vote for that group either. The check reads the
-- member's confirmed association, which cannot change once voting has opened (the entries are frozen), so doing it before the delegate's locks is safe.
-- The coordinates the pilot's cast accepts are passed as NULL, always: a category round has no venue and the signature has no way to carry one.

create function cast_community_voting_category_vote_atomically(
  p_instance_id uuid,
  p_auth_user_id uuid,
  p_binding_id uuid,
  p_intent_no integer,
  p_interaction_instance_id uuid,
  p_candidate_id uuid
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
begin
  perform community_voting_require_category_round(p_instance_id);

  if p_candidate_id is not null and exists (
    select 1
    from community_voting_entries m
    join community_voting_voter_bindings b on b.binding_id = m.confirmed_binding_id
    join community_voting_entries g on g.entry_id = m.group_entry_id
    where m.instance_id = p_instance_id
      and m.entry_kind = 'GROUP_MEMBER'
      and b.auth_user_id = p_auth_user_id
      and g.candidate_id = p_candidate_id
  ) then
    raise exception 'SELF_VOTE_NOT_ALLOWED: a participant cannot vote for their own candidate'
      using errcode = 'P0001';
  end if;

  return query
    select r.outcome, r.binding_id, r.intent_no, r.interaction_instance_id, r.candidate_id, r.vote_updated_at
    from cast_community_voting_round_vote_atomically(
      p_instance_id, p_auth_user_id, p_binding_id, p_intent_no, p_interaction_instance_id, p_candidate_id, null, null, null
    ) r;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- After the close: the operator's totals, the review and the publication — per category
-- ---------------------------------------------------------------------------------------
--
-- The close is the pilot's, unchanged (one explicit act per round that records the commitment to the closed result). From there a category differs
-- from a finalist round: there is no cut and no Product policy; the WINNER of a category is rank 1 among the candidacies that have not withdrawn with
-- at least one valid vote (ties are shared); and a category with NO valid vote has NO winner — which is a complete, publishable outcome ("sin
-- resultado ganador"), recorded as a publication that announces nobody. Totals exist only here, for the designated operator, after the close.

create function read_community_voting_category_results(
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
  winner boolean
)
language plpgsql
stable
security invoker
set search_path = public
as $$
#variable_conflict use_column
begin
  perform 1 from community_voting_authorize_operator(p_instance_id, p_host_token, p_operator_member_id, false);
  perform community_voting_require_category_round(p_instance_id);

  if not exists (select 1 from community_voting_closures c where c.instance_id = p_instance_id) then
    raise exception 'CV_RESULTS_NOT_AVAILABLE: totals are not available until the category has been closed'
      using errcode = 'P0001';
  end if;

  return query
    select r.r_candidate_id, r.r_entry_id, r.r_label, r.r_ordinal, r.r_withdrawn, r.r_votes, r.r_rank,
           (not r.r_withdrawn and r.r_rank = 1 and r.r_votes > 0)
    from community_voting_compute_round_results(p_instance_id) r;
end;
$$;

create function record_community_voting_category_review_atomically(
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
  v_digest text;
  v_note text;
  v_id uuid;
  v_at timestamptz;
begin
  perform 1 from community_voting_authorize_operator(p_instance_id, p_host_token, p_operator_member_id, true);
  perform community_voting_require_category_round(p_instance_id);

  if not exists (select 1 from community_voting_closures c where c.instance_id = p_instance_id) then
    raise exception 'CV_RESULTS_NOT_AVAILABLE: the category has not been closed'
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

create function publish_community_voting_category_atomically(
  p_instance_id uuid,
  p_host_token text,
  p_operator_member_id uuid
)
returns table (published_at timestamptz, results_digest text, winner_count integer)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_session_id uuid;
  v_review community_voting_round_reviews%rowtype;
  v_current text;
  v_winners integer;
  v_at timestamptz := now();
begin
  select o.o_session_id into v_session_id
  from community_voting_authorize_operator(p_instance_id, p_host_token, p_operator_member_id, true) o;
  perform community_voting_require_category_round(p_instance_id);

  if exists (select 1 from community_voting_publications p where p.instance_id = p_instance_id) then
    raise exception 'CV_ALREADY_PUBLISHED: the results of this category have already been published'
      using errcode = 'P0001';
  end if;

  if not exists (select 1 from community_voting_closures c where c.instance_id = p_instance_id) then
    raise exception 'CV_RESULTS_NOT_AVAILABLE: the category has not been closed'
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
    raise exception 'CV_REVIEW_STALE: the result or the eligible candidacies changed after it was reviewed; review it again'
      using errcode = 'P0001';
  end if;

  perform set_config('urbano.community_voting_round_publish', v_session_id::text, true);
  perform reveal_results_atomically(v_session_id, p_host_token, 'RESULTS_REVEALED', '{}'::jsonb);

  insert into community_voting_publications (instance_id, review_id, results_digest, published_at, published_by_member_id)
  values (p_instance_id, v_review.review_id, v_current, v_at, p_operator_member_id);

  -- What is announced: the public number of each winner — never a count. A category with no valid vote announces nobody.
  insert into community_voting_published_results (instance_id, entry_id, kind, alias, ordinal)
  select p_instance_id, r.r_entry_id, 'WINNERS', r.r_label, r.r_ordinal
  from community_voting_compute_round_results(p_instance_id) r
  where not r.r_withdrawn and r.r_rank = 1 and r.r_votes > 0;

  get diagnostics v_winners = row_count;

  perform set_config('urbano.community_voting_round_publish', '', true);

  perform community_voting_log_operator_action(
    p_instance_id, p_operator_member_id, 'PUBLISH_RESULTS', null,
    jsonb_build_object('reviewId', v_review.review_id, 'digest', v_current, 'winners', v_winners)
  );

  return query select v_at, v_current, v_winners;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- The contest on Home and on the pages (public: no identity, no count)
-- ---------------------------------------------------------------------------------------

create function read_community_voting_category_of(p_instance_id uuid)
returns table (contest_id uuid, category_key text)
language sql
stable
security invoker
set search_path = public
as $$
  select cr.contest_id, cr.category_key from community_voting_category_rounds cr where cr.instance_id = p_instance_id;
$$;

create function read_community_voting_contest_categories(p_contest_id uuid)
returns table (category_key text, instance_id uuid, listed boolean)
language sql
stable
security invoker
set search_path = public
as $$
  select cr.category_key, cr.instance_id, (c.listed_at is not null)
  from community_voting_category_rounds cr
  join community_voting_contests c on c.contest_id = cr.contest_id
  where cr.contest_id = p_contest_id
  order by array_position(array['MOST_ELABORATE', 'SEXIEST', 'BEST_GROUP', 'FUNNIEST']::text[], cr.category_key);
$$;

-- The contest the operator last chose to show on Home, if any. Null result = Home says only what is true.
create function read_community_voting_featured_contest()
returns table (contest_id uuid)
language sql
stable
security invoker
set search_path = public
as $$
  select c.contest_id
  from community_voting_contests c
  where c.listed_at is not null
    and exists (select 1 from community_voting_category_rounds cr where cr.contest_id = c.contest_id)
  order by c.listed_at desc
  limit 1;
$$;

-- The operator's explicit act: show the contest on Home, or take it down. Authorized like every operator act (host token of one of its
-- rounds + the designated operator); logged on that round.
create function set_community_voting_contest_listing_atomically(
  p_instance_id uuid,
  p_host_token text,
  p_operator_member_id uuid,
  p_listed boolean
)
returns table (contest_id uuid, listed boolean)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_contest uuid;
begin
  perform 1 from community_voting_authorize_operator(p_instance_id, p_host_token, p_operator_member_id, true);
  perform community_voting_require_category_round(p_instance_id);

  if p_listed is null then
    raise exception 'CV_INVALID_REQUEST: listed must be true or false'
      using errcode = 'P0001';
  end if;

  select cr.contest_id into v_contest from community_voting_category_rounds cr where cr.instance_id = p_instance_id;

  update community_voting_contests
  set listed_at = case when p_listed then now() else null end,
      listed_by_member_id = case when p_listed then p_operator_member_id else null end
  where community_voting_contests.contest_id = v_contest;

  perform community_voting_log_operator_action(
    p_instance_id, p_operator_member_id, case when p_listed then 'LIST_CONTEST' else 'UNLIST_CONTEST' end, null, jsonb_build_object('contestId', v_contest)
  );

  return query select v_contest, p_listed;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Privileges: every function above is created under the project's standing default-privilege rule (EXECUTE to PUBLIC, anon and
-- authenticated), so each is revoked in the SAME migration that creates it. service_role keeps its EXECUTE.
-- ---------------------------------------------------------------------------------------

revoke execute on function community_voting_category_of(uuid) from public, anon, authenticated;
revoke execute on function community_voting_require_category_round(uuid) from public, anon, authenticated;
revoke execute on function community_voting_group_complete(uuid, uuid) from public, anon, authenticated;
revoke execute on function community_voting_create_entry_row(uuid, text, uuid, integer) from public, anon, authenticated;
revoke execute on function register_community_voting_category_round_atomically(uuid, text, uuid, integer, uuid, text) from public, anon, authenticated;
revoke execute on function create_community_voting_group_entry_atomically(uuid, text, uuid, integer) from public, anon, authenticated;
revoke execute on function create_community_voting_group_member_atomically(uuid, text, uuid, uuid, integer) from public, anon, authenticated;
revoke execute on function record_community_voting_member_consent_atomically(uuid, text, uuid, uuid, uuid, text, text, boolean) from public, anon, authenticated;
revoke execute on function start_community_voting_category_atomically(uuid, text, uuid, text) from public, anon, authenticated;
revoke execute on function cast_community_voting_category_vote_atomically(uuid, uuid, uuid, integer, uuid, uuid) from public, anon, authenticated;
revoke execute on function read_community_voting_category_results(uuid, text, uuid) from public, anon, authenticated;
revoke execute on function record_community_voting_category_review_atomically(uuid, text, uuid, text) from public, anon, authenticated;
revoke execute on function publish_community_voting_category_atomically(uuid, text, uuid) from public, anon, authenticated;
revoke execute on function read_community_voting_category_of(uuid) from public, anon, authenticated;
revoke execute on function read_community_voting_contest_categories(uuid) from public, anon, authenticated;
revoke execute on function read_community_voting_featured_contest() from public, anon, authenticated;
revoke execute on function set_community_voting_contest_listing_atomically(uuid, text, uuid, boolean) from public, anon, authenticated;
