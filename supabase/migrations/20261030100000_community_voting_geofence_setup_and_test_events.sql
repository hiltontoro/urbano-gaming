-- Migration: 20261030100000_community_voting_geofence_setup_and_test_events
-- UG-IV-GATE-010 — the OPERATOR'S GEOFENCE SETUP and the TEST EVENT (append-only; no earlier migration is edited).
--
-- 1. The final's venue geofence becomes CONFIGURABLE by the designated operator, before the final has ever opened, and not after.
--      * The six geofence columns of a FINAL are the only columns of an Instance that can change, and only through
--        configure_community_voting_final_geofence_atomically, which holds the Session lock FIRST (the opening takes the same lock first, so a
--        save and the opening serialize), proves the host token AND the designated operator, refuses a preliminary and an opened final, validates
--        the values and records WHO, WHEN, OLD and NEW in the operator's audit trail.
--      * The Instance update guard keeps refusing everything, with ONE narrow exception: the six columns of a FINAL, under a transaction-local
--        marker bound to that Instance's id, while its Session has never opened voting. The comparison is made on the whole row minus those six
--        columns, so any column — present or added later — stays immutable. service_role gets UPDATE on those six columns only (the table-level
--        UPDATE stays revoked), so a direct write cannot reach any other column even before the guard looks at it.
--      * Nothing about voting changes: cast_community_voting_round_vote_atomically and start_community_voting_round_atomically are untouched.
--
-- 2. "Test my location" — test_community_voting_round_geofence — is a STABLE function (it cannot write) that evaluates one reading with the
--    SAME community_voting_assess_location the vote uses, against the Instance's own stored geofence. It stores, logs and returns no coordinate.
--
-- 3. A TEST EVENT is a round registered as one (is_test). The flag is written only by the registration, never changes (the update guard), exists
--    only on a round, and a final must agree with the preliminary it descends from. It is exposed to the public info and to the operator's overview.
--
-- Applying this file to a database that already has the previous migrations is the upgrade path; applying all migrations to an empty database is the
-- clean-install path; both give the same schema.

-- ---------------------------------------------------------------------------------------
-- The test-event flag
-- ---------------------------------------------------------------------------------------

alter table community_voting_instances add column is_test boolean not null default false;

alter table community_voting_instances
  add constraint community_voting_instances_test_only_rounds check (not is_test or ballot_mode = 'FAVORITE_ROUND');

-- A final descends from a PRELIMINARY of the same operator (unchanged) and now also of the same KIND: a test final only follows a test preliminary
-- and a real final only a real one, so a rehearsal can never feed the real event or the reverse.
create or replace function community_voting_guard_instance_insert()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_source community_voting_instances%rowtype;
begin
  if new.ballot_mode is distinct from 'FAVORITE_ROUND' or new.round_role is distinct from 'FINAL' then
    return new;
  end if;

  select * into v_source from community_voting_instances i where i.instance_id = new.source_instance_id;
  if not found
     or v_source.ballot_mode is distinct from 'FAVORITE_ROUND'
     or v_source.round_role is distinct from 'PRELIMINARY'
     or v_source.operator_gaming_member_id is distinct from new.operator_gaming_member_id then
    raise exception 'CV_INVALID_REQUEST: a final must descend from a preliminary round of the same operator'
      using errcode = 'P0001';
  end if;

  if v_source.is_test is distinct from new.is_test then
    raise exception 'CV_TEST_MODE_MISMATCH: a test final can only follow a test preliminary, and a real final a real one'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- The Instance update guard: still refuses everything, with ONE narrow exception
-- ---------------------------------------------------------------------------------------
--
-- The exception needs ALL of: the transaction-local marker 'urbano.community_voting_geofence' equal to THIS Instance's id (set by the operation
-- below and cleared before it returns; it cannot be set through the REST surface), a FINAL, a Session that has never opened voting, and no
-- difference from the old row outside the six geofence columns.

create or replace function community_voting_guard_instance_update()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_geofence_columns constant text[] := array[
    'venue_latitude', 'venue_longitude', 'venue_radius_meters', 'max_accuracy_meters', 'inside_margin_factor', 'outside_margin_factor'
  ];
begin
  if current_setting('urbano.community_voting_geofence', true) is not distinct from old.instance_id::text
     and old.ballot_mode = 'FAVORITE_ROUND'
     and old.round_role = 'FINAL'
     and (to_jsonb(new) - v_geofence_columns) = (to_jsonb(old) - v_geofence_columns)
     and not exists (select 1 from interaction_instances ii where ii.session_id = old.session_id) then
    return new;
  end if;

  raise exception 'COMMUNITY_VOTING_HISTORY_IMMUTABLE: a registered Community Voting Instance cannot be changed'
    using errcode = 'P0001';
end;
$$;

-- service_role writes the six geofence columns and nothing else of an Instance (table-level UPDATE remains revoked).
grant update (venue_latitude, venue_longitude, venue_radius_meters, max_accuracy_meters, inside_margin_factor, outside_margin_factor)
  on community_voting_instances to service_role;

-- ---------------------------------------------------------------------------------------
-- The operator's audit trail learns the new act
-- ---------------------------------------------------------------------------------------

alter table community_voting_operator_actions drop constraint community_voting_operator_actions_values;
alter table community_voting_operator_actions add constraint community_voting_operator_actions_values check (action in (
  'REGISTER_INSTANCE', 'SET_SCHEDULE', 'CREATE_ENTRY', 'REMOVE_ENTRY', 'UPLOAD_PHOTO', 'RECORD_CONSENT', 'APPROVE_PHOTO',
  'REJECT_PHOTO', 'CONFIRM_ASSOCIATION', 'OPEN_VOTING', 'CLOSE_VOTING', 'WITHDRAW_CANDIDATURE', 'HIDE_PHOTO',
  'SELECT_FINALISTS', 'PREPARE_FINAL', 'REVIEW_RESULTS', 'PUBLISH_RESULTS', 'RECORD_PROMO_CONSENT',
  'RECORD_POLICY_APPROVAL', 'RESOLVE_FOLLOWUP_TASK', 'CONFIGURE_GEOFENCE'
));

-- ---------------------------------------------------------------------------------------
-- Saving the final's geofence
-- ---------------------------------------------------------------------------------------
--
-- Order of the checks: the Session lock FIRST (so this serializes with the opening, which takes it first too), host token, designated operator,
-- a FINAL, never opened, then the values. An accepted save is one transaction: the update and its audit row commit together or not at all.
-- The audit row carries the venue's old and new configuration (bounded facts, no person) and the operator who did it.

create function configure_community_voting_final_geofence_atomically(
  p_instance_id uuid,
  p_host_token text,
  p_operator_member_id uuid,
  p_venue_latitude double precision,
  p_venue_longitude double precision,
  p_venue_radius_meters double precision,
  p_max_accuracy_meters double precision,
  p_inside_margin_factor double precision,
  p_outside_margin_factor double precision
)
returns table (
  venue_latitude double precision,
  venue_longitude double precision,
  venue_radius_meters double precision,
  max_accuracy_meters double precision,
  inside_margin_factor double precision,
  outside_margin_factor double precision,
  configured_at timestamptz
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_session_id uuid;
  v_role text;
  v_old community_voting_instances%rowtype;
  v_at timestamptz;
begin
  select o.o_session_id into v_session_id
  from community_voting_authorize_operator(p_instance_id, p_host_token, p_operator_member_id, true) o;
  v_role := community_voting_require_round(p_instance_id);

  if v_role is distinct from 'FINAL' then
    raise exception 'CV_NOT_A_FINAL: only the final has a venue geofence; the preliminary is voted from anywhere'
      using errcode = 'P0001';
  end if;

  if exists (select 1 from interaction_instances ii where ii.session_id = v_session_id) then
    raise exception 'CV_GEOFENCE_FROZEN: the final has opened; its venue geofence can no longer change'
      using errcode = 'P0001';
  end if;

  -- finite numbers in range: NaN is greater than every number in Postgres and Infinity is out of every range, so each bound below also refuses them
  if p_venue_latitude is null or not (p_venue_latitude between -90 and 90)
     or p_venue_longitude is null or not (p_venue_longitude between -180 and 180)
     or p_venue_radius_meters is null or not (p_venue_radius_meters > 0 and p_venue_radius_meters <= 100000)
     or p_max_accuracy_meters is null or not (p_max_accuracy_meters > 0 and p_max_accuracy_meters <= 100000)
     or p_inside_margin_factor is null or not (p_inside_margin_factor >= 0 and p_inside_margin_factor <= 1000)
     or p_outside_margin_factor is null or not (p_outside_margin_factor >= 0 and p_outside_margin_factor <= 1000) then
    raise exception 'CV_INVALID_GEOFENCE_CONFIG: the geofence configuration is missing or out of range'
      using errcode = 'P0001';
  end if;

  select * into v_old from community_voting_instances i where i.instance_id = p_instance_id;

  perform set_config('urbano.community_voting_geofence', p_instance_id::text, true);

  update community_voting_instances
  set venue_latitude = p_venue_latitude,
      venue_longitude = p_venue_longitude,
      venue_radius_meters = p_venue_radius_meters,
      max_accuracy_meters = p_max_accuracy_meters,
      inside_margin_factor = p_inside_margin_factor,
      outside_margin_factor = p_outside_margin_factor
  where community_voting_instances.instance_id = p_instance_id;

  perform set_config('urbano.community_voting_geofence', '', true);

  v_at := now();

  perform community_voting_log_operator_action(
    p_instance_id, p_operator_member_id, 'CONFIGURE_GEOFENCE', null,
    jsonb_build_object(
      'old', jsonb_build_object(
        'venueLatitude', v_old.venue_latitude, 'venueLongitude', v_old.venue_longitude, 'venueRadiusMeters', v_old.venue_radius_meters,
        'maxAccuracyMeters', v_old.max_accuracy_meters, 'insideMarginFactor', v_old.inside_margin_factor, 'outsideMarginFactor', v_old.outside_margin_factor),
      'new', jsonb_build_object(
        'venueLatitude', p_venue_latitude, 'venueLongitude', p_venue_longitude, 'venueRadiusMeters', p_venue_radius_meters,
        'maxAccuracyMeters', p_max_accuracy_meters, 'insideMarginFactor', p_inside_margin_factor, 'outsideMarginFactor', p_outside_margin_factor)
    )
  );

  return query
    select p_venue_latitude, p_venue_longitude, p_venue_radius_meters, p_max_accuracy_meters, p_inside_margin_factor, p_outside_margin_factor, v_at;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- "Test my location": the vote's own evaluator, and nothing else
-- ---------------------------------------------------------------------------------------
--
-- STABLE, so it cannot insert, update or delete anything; it takes no lock (a read, so the operator's screen never delays a vote); it creates no
-- vote, intent, binding or audit row and returns the decision, the distance and the accuracy it saw (rounded as the vote's evidence is) with the
-- thresholds it used — never a coordinate. An invalid reading raises CV_INVALID_LOCATION_READING exactly as a vote would.

create function test_community_voting_round_geofence(
  p_instance_id uuid,
  p_host_token text,
  p_operator_member_id uuid,
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy_meters double precision
)
returns table (
  decision text,
  distance_meters numeric,
  accuracy_meters numeric,
  radius_meters double precision,
  max_accuracy_meters double precision
)
language plpgsql
stable
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_instance community_voting_instances%rowtype;
  v_assess record;
begin
  perform 1 from community_voting_authorize_operator(p_instance_id, p_host_token, p_operator_member_id, false);

  if community_voting_require_round(p_instance_id) is distinct from 'FINAL' then
    raise exception 'CV_NOT_A_FINAL: only the final has a venue geofence; the preliminary is voted from anywhere'
      using errcode = 'P0001';
  end if;

  select * into v_instance from community_voting_instances i where i.instance_id = p_instance_id;

  select * into v_assess
  from community_voting_assess_location(
    v_instance.venue_latitude, v_instance.venue_longitude, v_instance.venue_radius_meters,
    v_instance.max_accuracy_meters, v_instance.inside_margin_factor, v_instance.outside_margin_factor,
    p_latitude, p_longitude, p_accuracy_meters
  );

  return query
    select v_assess.decision, round(v_assess.distance_meters::numeric, 1), round(p_accuracy_meters::numeric, 1),
           v_instance.venue_radius_meters, v_instance.max_accuracy_meters;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Registration (one more, defaulted parameter) and the two readers that carry the flag
-- ---------------------------------------------------------------------------------------

drop function register_community_voting_round_atomically(
  uuid, text, uuid, integer, text, uuid, double precision, double precision, double precision, double precision, double precision, double precision, integer
);

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
  p_window_seconds integer,
  p_is_test boolean default false
)
returns table (
  instance_id uuid,
  session_id uuid,
  round_role text,
  rule_version integer,
  source_instance_id uuid,
  window_seconds integer,
  is_test boolean,
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

    insert into community_voting_instances (session_id, rule_version, ballot_mode, operator_gaming_member_id, round_role, finalist_cutoff, is_test)
    values (p_session_id, p_rule_version, 'FAVORITE_ROUND', p_operator_member_id, 'PRELIMINARY', 10, coalesce(p_is_test, false))
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
      venue_latitude, venue_longitude, venue_radius_meters, max_accuracy_meters, inside_margin_factor, outside_margin_factor, is_test
    )
    values (
      p_session_id, p_rule_version, 'FAVORITE_ROUND', p_operator_member_id, 'FINAL', p_source_instance_id, p_window_seconds,
      p_venue_latitude, p_venue_longitude, p_venue_radius_meters, p_max_accuracy_meters, p_inside_margin_factor, p_outside_margin_factor, coalesce(p_is_test, false)
    )
    returning * into v_row;
  end if;

  insert into community_voting_schedules (instance_id, updated_by_member_id)
  values (v_row.instance_id, p_operator_member_id);

  perform community_voting_log_operator_action(
    v_row.instance_id, p_operator_member_id, 'REGISTER_INSTANCE', null,
    jsonb_build_object('roundRole', v_row.round_role, 'sourceInstanceId', v_row.source_instance_id, 'windowSeconds', v_row.window_seconds, 'isTest', v_row.is_test)
  );

  return query
    select v_row.instance_id, v_row.session_id, v_row.round_role, v_row.rule_version, v_row.source_instance_id, v_row.window_seconds, v_row.is_test, v_row.created_at;
end;
$$;

drop function read_community_voting_round_public_info(uuid);

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
  published boolean,
  is_test boolean
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
         exists (select 1 from community_voting_publications p where p.instance_id = i.instance_id),
         i.is_test
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

create or replace function read_community_voting_round_overview(
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
    'isTest', (select i.is_test from community_voting_instances i where i.instance_id = p_instance_id),
    'sessionState', v_state,
    'interactionState', v_cur_state,
    'opened', v_cur_state is not null,
    'closed', v_closed,
    'published', exists (select 1 from community_voting_publications p where p.instance_id = p_instance_id),
    'serverNow', clock_timestamp(),
    'windowSeconds', v_window,
    -- the final's venue geofence, with whether it can still be edited (it cannot once the final has ever opened) and when it was last saved
    'geofence', case when v_role = 'FINAL' then (
      select jsonb_build_object(
               'venueLatitude', i.venue_latitude, 'venueLongitude', i.venue_longitude, 'venueRadiusMeters', i.venue_radius_meters,
               'maxAccuracyMeters', i.max_accuracy_meters, 'insideMarginFactor', i.inside_margin_factor, 'outsideMarginFactor', i.outside_margin_factor,
               'editable', v_cur_state is null,
               'savedAt', (select max(a.occurred_at) from community_voting_operator_actions a where a.instance_id = p_instance_id and a.action = 'CONFIGURE_GEOFENCE'))
      from community_voting_instances i where i.instance_id = p_instance_id) else null end,
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
-- Privileges: service_role only (created under the project's default-privilege rule, so each is revoked in the SAME migration)
-- ---------------------------------------------------------------------------------------

revoke execute on function configure_community_voting_final_geofence_atomically(uuid, text, uuid, double precision, double precision, double precision, double precision, double precision, double precision) from public, anon, authenticated;
revoke execute on function test_community_voting_round_geofence(uuid, text, uuid, double precision, double precision, double precision) from public, anon, authenticated;
revoke execute on function register_community_voting_round_atomically(uuid, text, uuid, integer, text, uuid, double precision, double precision, double precision, double precision, double precision, double precision, integer, boolean) from public, anon, authenticated;
revoke execute on function read_community_voting_round_public_info(uuid) from public, anon, authenticated;
