-- Migration: 20261020190100_create_community_voting_functions
-- UG-IV-GATE-002 — Community Voting local foundation (Design B1).
--
-- The atomic operations of a Community Voting Experience Instance. Conventions, all inherited
-- from this repository's existing functions:
--
--   * security invoker, search_path = public, error codes as "CODE: text" under errcode P0001.
--     Community Voting codes are prefixed CV_; the Session codes SESSION_NOT_FOUND and
--     HOST_TOKEN_MISMATCH are reused verbatim so the existing error classes translate them.
--   * SESSION-FIRST LOCK ORDER. Every function that writes locks the `sessions` row FOR UPDATE
--     before anything else — the same first lock join_participant_atomically, lock_lobby_atomically,
--     start_session_atomically, close_submissions_atomically and cast_vote_atomically take. All of
--     them therefore serialize per Session and cannot deadlock against one another. The binding
--     row is locked second, the current interaction third (as cast_vote_atomically does).
--   * Authority comparisons use IS DISTINCT FROM so a NULL caller can never slip past a check
--     (the NULL-comparison bug class fixed in GATE-089/091).
--   * These functions TRUST their caller for one thing: that p_auth_user_id is a server-verified
--     Auth user with a confirmed phone. The route derives it from `auth.getUser`, never from the
--     client, and every function below is executable by service_role only (see the end of this
--     file) — the same trust model as create_gaming_member_atomically (0047). They deliberately do
--     NOT read auth.users: that would couple the authoritative layer to a hosted Auth schema this
--     migration cannot verify.
--
-- Nothing here writes a vote. The only vote writer remains the UNCHANGED cast_vote_atomically; the
-- cast wrapper below is a gate in front of it and a recorder of the accepted recovery metadata.

-- ---------------------------------------------------------------------------------------
-- Location assessment (server-side; the client's coordinates are untrusted claims)
-- ---------------------------------------------------------------------------------------
--
-- INSIDE    : distance + inside_margin_factor  * accuracy <= radius
-- OUTSIDE   : distance - outside_margin_factor * accuracy >  radius
-- AMBIGUOUS : everything between
-- ACCURACY_EXCESSIVE : the reading reports an accuracy radius above the Instance's maximum
--
-- A missing, non-finite, out-of-range or (0,0) reading raises CV_INVALID_LOCATION_READING. (0,0)
-- is rejected as the explicit current PILOT POLICY, not as a claim that the point is universally
-- invalid. The message never repeats a submitted value. NaN sorts above every number in Postgres,
-- so each bound below is written so that NaN cannot satisfy it.

create function community_voting_assess_location(
  p_venue_latitude double precision,
  p_venue_longitude double precision,
  p_venue_radius_meters double precision,
  p_max_accuracy_meters double precision,
  p_inside_margin_factor double precision,
  p_outside_margin_factor double precision,
  p_latitude double precision,
  p_longitude double precision,
  p_accuracy_meters double precision
)
returns table (decision text, distance_meters double precision)
language plpgsql
immutable
set search_path = public
as $$
declare
  v_dlat double precision;
  v_dlon double precision;
  v_a double precision;
  v_distance double precision;
  v_decision text;
begin
  if p_latitude is null or p_longitude is null or p_accuracy_meters is null
     or not (p_latitude between -90 and 90)
     or not (p_longitude between -180 and 180)
     or not (p_accuracy_meters > 0 and p_accuracy_meters < 'Infinity'::double precision)
     or (p_latitude = 0 and p_longitude = 0) then
    raise exception 'CV_INVALID_LOCATION_READING: the location reading is missing, malformed or not accepted'
      using errcode = 'P0001';
  end if;

  -- Great-circle (haversine) distance on a 6,371,000 m sphere, in meters.
  v_dlat := radians(p_latitude - p_venue_latitude);
  v_dlon := radians(p_longitude - p_venue_longitude);
  v_a := power(sin(v_dlat / 2.0), 2)
       + cos(radians(p_venue_latitude)) * cos(radians(p_latitude)) * power(sin(v_dlon / 2.0), 2);
  v_a := least(1.0, greatest(0.0, v_a));
  v_distance := 6371000.0 * 2.0 * atan2(sqrt(v_a), sqrt(1.0 - v_a));

  if p_accuracy_meters > p_max_accuracy_meters then
    v_decision := 'ACCURACY_EXCESSIVE';
  elsif v_distance + p_inside_margin_factor * p_accuracy_meters <= p_venue_radius_meters then
    v_decision := 'INSIDE';
  elsif v_distance - p_outside_margin_factor * p_accuracy_meters > p_venue_radius_meters then
    v_decision := 'OUTSIDE';
  else
    v_decision := 'AMBIGUOUS';
  end if;

  return query select v_decision, v_distance;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Instance registration
-- ---------------------------------------------------------------------------------------
--
-- Requires the Session's host authority; takes the Session lock BEFORE checking or writing, so it
-- serializes with ordinary joining (join_participant_atomically takes the same lock first and,
-- after migration 20261020190200, refuses an event-bound Session). Registration must precede any
-- Participant, requires the declared capability set to be EXACTLY {VOTING}, and enforces one
-- Instance per Session. It adds no lifecycle state: the Session's state is untouched.

create function register_community_voting_instance_atomically(
  p_session_id uuid,
  p_host_token text,
  p_venue_latitude double precision,
  p_venue_longitude double precision,
  p_venue_radius_meters double precision,
  p_max_accuracy_meters double precision,
  p_inside_margin_factor double precision,
  p_outside_margin_factor double precision,
  p_rule_version integer
)
returns table (
  instance_id uuid,
  session_id uuid,
  venue_latitude double precision,
  venue_longitude double precision,
  venue_radius_meters double precision,
  max_accuracy_meters double precision,
  inside_margin_factor double precision,
  outside_margin_factor double precision,
  rule_version integer,
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

  if exists (
    select 1 from community_voting_instances i where i.session_id = p_session_id
  ) then
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

  if exists (
    select 1 from participants p where p.session_id = p_session_id
  ) then
    raise exception 'CV_PARTICIPANTS_ALREADY_EXIST: an Instance must be registered before any Participant exists'
      using errcode = 'P0001';
  end if;

  if p_rule_version is null or p_rule_version < 1 then
    raise exception 'CV_INVALID_REQUEST: ruleVersion must be a positive integer'
      using errcode = 'P0001';
  end if;

  if p_venue_latitude is null or not (p_venue_latitude between -90 and 90)
     or p_venue_longitude is null or not (p_venue_longitude between -180 and 180)
     or p_venue_radius_meters is null or not (p_venue_radius_meters > 0 and p_venue_radius_meters <= 100000)
     or p_max_accuracy_meters is null or not (p_max_accuracy_meters > 0 and p_max_accuracy_meters <= 100000)
     or p_inside_margin_factor is null or not (p_inside_margin_factor >= 0 and p_inside_margin_factor <= 1000)
     or p_outside_margin_factor is null or not (p_outside_margin_factor >= 0 and p_outside_margin_factor <= 1000) then
    raise exception 'CV_INVALID_GEOFENCE_CONFIG: the geofence configuration is missing or out of range'
      using errcode = 'P0001';
  end if;

  insert into community_voting_instances (
    session_id, venue_latitude, venue_longitude, venue_radius_meters, max_accuracy_meters,
    inside_margin_factor, outside_margin_factor, rule_version
  )
  values (
    p_session_id, p_venue_latitude, p_venue_longitude, p_venue_radius_meters, p_max_accuracy_meters,
    p_inside_margin_factor, p_outside_margin_factor, p_rule_version
  )
  returning * into v_row;

  return query select
    v_row.instance_id, v_row.session_id, v_row.venue_latitude, v_row.venue_longitude,
    v_row.venue_radius_meters, v_row.max_accuracy_meters, v_row.inside_margin_factor,
    v_row.outside_margin_factor, v_row.rule_version, v_row.created_at;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Verified voter binding
-- ---------------------------------------------------------------------------------------
--
-- Atomically creates the Participant and the binding for one server-verified Auth user. Idempotent:
-- an existing (instance, auth user) binding is returned unchanged in ANY Session state, which is
-- what makes recovery possible after a close. A NEW binding is admitted only in the explicit states:
--
--   LOBBY_OPEN
--   LOBBY_LOCKED, no interaction yet
--   LOBBY_LOCKED, current interaction is VOTING in PROMPT_ACTIVE   (late arrival while voting is open)
--
-- Everything else — Voting closed or revealed, SESSION_COMPLETE (which is also how an early
-- termination ends: no distinct cancelled state exists), SESSION_PAUSED, and every legacy state —
-- raises CV_ADMISSION_CLOSED.
--
-- The Participant is OPAQUE: a random label ('cv-' + 16 hex characters from gen_random_uuid(),
-- unrelated to the Auth user), no Gaming Member link, and a 64-hex-character token generated HERE,
-- in the database. The token is not returned, not copied into the binding, and not placed in the
-- PARTICIPANT_JOINED event. No gaming_members row is created or required.

create function bind_community_voting_voter_atomically(
  p_instance_id uuid,
  p_auth_user_id uuid
)
returns table (binding_id uuid, instance_id uuid, created boolean)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_session_id uuid;
  v_state text;
  v_capabilities text[];
  v_existing_binding_id uuid;
  v_cur_id uuid;
  v_cur_state text;
  v_cur_engine text;
  v_participant_id uuid;
  v_label text;
  v_token text;
  v_binding_id uuid;
  v_attempt integer := 0;
begin
  select i.session_id into v_session_id
  from community_voting_instances i
  where i.instance_id = p_instance_id;

  if v_session_id is null then
    raise exception 'CV_INSTANCE_NOT_FOUND: no Community Voting Instance exists for this id'
      using errcode = 'P0001';
  end if;

  -- SESSION-FIRST: every later read and write happens under this lock.
  select sessions.state, sessions.declared_capabilities
    into v_state, v_capabilities
  from sessions
  where sessions.session_id = v_session_id
  for update;

  select b.binding_id into v_existing_binding_id
  from community_voting_voter_bindings b
  where b.instance_id = p_instance_id and b.auth_user_id = p_auth_user_id;

  if v_existing_binding_id is not null then
    return query select v_existing_binding_id, p_instance_id, false;
    return;
  end if;

  if v_capabilities is distinct from array['VOTING']::text[] then
    raise exception 'CV_CAPABILITY_SET_NOT_EXACTLY_VOTING: the declared capability set must be exactly VOTING'
      using errcode = 'P0001';
  end if;

  select ii.interaction_instance_id, ii.state, ii.engine_type
    into v_cur_id, v_cur_state, v_cur_engine
  from interaction_instances ii
  where ii.session_id = v_session_id
  order by ii.created_at desc
  limit 1;

  if v_state = 'LOBBY_OPEN' then
    null;
  elsif v_state = 'LOBBY_LOCKED'
        and (v_cur_id is null or (v_cur_engine = 'VOTING' and v_cur_state = 'PROMPT_ACTIVE')) then
    null;
  else
    raise exception 'CV_ADMISSION_CLOSED: new voters are not admitted in this state'
      using errcode = 'P0001';
  end if;

  v_participant_id := gen_random_uuid();
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');

  loop
    v_attempt := v_attempt + 1;
    v_label := 'cv-' || substr(replace(gen_random_uuid()::text, '-', ''), 1, 16);
    begin
      insert into participants (
        participant_id, session_id, display_name, normalized_display_name,
        participant_token, joined_at, gaming_member_id
      )
      values (
        v_participant_id, v_session_id, v_label, lower(btrim(v_label)),
        v_token, now(), null
      );
      exit;
    exception when unique_violation then
      -- Only an (astronomically unlikely) label collision can reach here: the id and token are
      -- random and no Gaming Member is linked. Retry with a fresh label.
      if v_attempt >= 5 then
        raise;
      end if;
    end;
  end loop;

  insert into session_events (session_id, event_type, payload)
  values (
    v_session_id,
    'PARTICIPANT_JOINED',
    jsonb_build_object('participantId', v_participant_id, 'displayName', v_label)
  );

  insert into community_voting_voter_bindings (instance_id, auth_user_id, participant_id)
  values (p_instance_id, p_auth_user_id, v_participant_id)
  returning community_voting_voter_bindings.binding_id into v_binding_id;

  return query select v_binding_id, p_instance_id, true;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Intent issuance
-- ---------------------------------------------------------------------------------------
--
-- Hands the caller's binding its next strictly-increasing intent number. The number is a
-- SERVER-ISSUED ORDERING TOKEN for that one binding. It orders the intents the server handed out;
-- it does NOT prove the chronological order in which a human formed intentions across devices.
-- Issuing is refused unless voting is open, so a closed event accumulates no further intents.

create function issue_community_voting_intent_atomically(
  p_instance_id uuid,
  p_auth_user_id uuid
)
returns table (binding_id uuid, intent_no integer)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_session_id uuid;
  v_state text;
  v_binding_id uuid;
  v_cur_id uuid;
  v_cur_state text;
  v_cur_engine text;
  v_issued integer;
begin
  select i.session_id into v_session_id
  from community_voting_instances i
  where i.instance_id = p_instance_id;

  if v_session_id is null then
    raise exception 'CV_INSTANCE_NOT_FOUND: no Community Voting Instance exists for this id'
      using errcode = 'P0001';
  end if;

  select sessions.state into v_state
  from sessions
  where sessions.session_id = v_session_id
  for update;

  select b.binding_id into v_binding_id
  from community_voting_voter_bindings b
  where b.instance_id = p_instance_id and b.auth_user_id = p_auth_user_id
  for update;

  if v_binding_id is null then
    raise exception 'CV_NOT_BOUND: this identity is not bound to the Instance'
      using errcode = 'P0001';
  end if;

  select ii.interaction_instance_id, ii.state, ii.engine_type
    into v_cur_id, v_cur_state, v_cur_engine
  from interaction_instances ii
  where ii.session_id = v_session_id
  order by ii.created_at desc
  limit 1
  for update;

  if v_state <> 'LOBBY_LOCKED' or v_cur_id is null
     or v_cur_engine <> 'VOTING' or v_cur_state <> 'PROMPT_ACTIVE' then
    raise exception 'CV_VOTING_NOT_OPEN: voting is not open'
      using errcode = 'P0001';
  end if;

  update community_voting_voter_bindings
  set issued_intent_no = community_voting_voter_bindings.issued_intent_no + 1
  where community_voting_voter_bindings.binding_id = v_binding_id
  returning community_voting_voter_bindings.issued_intent_no into v_issued;

  return query select v_binding_id, v_issued;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Preparation: entries, private claims, host confirmation (all BEFORE the ballot opens)
-- ---------------------------------------------------------------------------------------
--
-- None of these functions opens anything or creates a candidate, a prompt, a segment or an event. They
-- write readiness data (community_voting_entries) and nothing else, and every one of them is refused with
-- CV_PREPARATION_CLOSED the moment the Session has any interaction — i.e. once Voting has opened. "Opened" is
-- DERIVED from the Session's own data (an interaction exists); this module keeps no state of its own for it,
-- because the only way an interaction can come to exist for an event-bound Session is the explicit start below.
--
-- WHAT THE DIGITAL MECHANISM PROVES, AND WHAT THE HOST MUST VERIFY
-- ----------------------------------------------------------------
-- Proven by the system: a Supabase-Auth identity with a CONFIRMED PHONE, bound to this event, presented the
-- single-use claim credential issued for exactly this entry, and then the host typed back the confirmation
-- code that only that identity's device was shown. The credential is bound to one entry of one event, is
-- consumed on first use, expires, and is stored only as a digest; the confirmation code is bound to one claim,
-- expires, allows five attempts and then voids the claim. Neither secret is ever readable by the host or
-- stored in the clear; the host never sees a phone, an Auth id, a binding or a Participant.
--
-- NOT proven by the system, and therefore the HOST'S OPERATIONAL DUTY: that the person who presented the
-- credential is the person the entry is FOR. The host must (a) hand the claim credential to the intended
-- contestant in person, (b) look at the screen of the person in front of them when entering the confirmation
-- code, and (c) if anyone else could have used the credential, simply not confirm it — remove the entry and
-- create it again. The system cannot see the costume, the room or the face; it can only make sure that nobody
-- can be attached to an entry without the host's own act, and that nobody's identity is revealed to the host.

create function create_community_voting_entry_atomically(
  p_instance_id uuid,
  p_host_token text,
  p_label text,
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
  v_host_token text;
  v_label text;
  v_ordinal integer;
  v_code text;
  v_entry_id uuid;
  v_expires timestamptz;
begin
  select i.session_id into v_session_id
  from community_voting_instances i
  where i.instance_id = p_instance_id;

  if v_session_id is null then
    raise exception 'CV_INSTANCE_NOT_FOUND: no Community Voting Instance exists for this id'
      using errcode = 'P0001';
  end if;

  select sessions.host_token into v_host_token
  from sessions
  where sessions.session_id = v_session_id
  for update;

  if v_host_token is distinct from p_host_token then
    raise exception 'HOST_TOKEN_MISMATCH: supplied host token does not match this session'
      using errcode = 'P0001';
  end if;

  if exists (select 1 from interaction_instances ii where ii.session_id = v_session_id) then
    raise exception 'CV_PREPARATION_CLOSED: Voting has opened; the ballot can no longer change'
      using errcode = 'P0001';
  end if;

  if p_claim_ttl_seconds is null or p_claim_ttl_seconds not between 1 and 86400 then
    raise exception 'CV_INVALID_REQUEST: the claim window must be between 1 and 86400 seconds'
      using errcode = 'P0001';
  end if;

  v_label := btrim(coalesce(p_label, ''));
  if char_length(v_label) not between 1 and 60 then
    raise exception 'CV_ENTRY_LABEL_INVALID: an entry label must be 1 to 60 characters'
      using errcode = 'P0001';
  end if;

  if exists (
    select 1 from community_voting_entries e
    where e.instance_id = p_instance_id and lower(e.label) = lower(v_label)
  ) then
    raise exception 'CV_ENTRY_LABEL_DUPLICATE: this ballot already has an entry with that label'
      using errcode = 'P0001';
  end if;

  select coalesce(max(e.ordinal), 0) + 1 into v_ordinal
  from community_voting_entries e
  where e.instance_id = p_instance_id;

  -- 122 random bits. Shown to the host ONCE, here; the table keeps only its digest.
  v_code := replace(gen_random_uuid()::text, '-', '');
  v_expires := now() + make_interval(secs => p_claim_ttl_seconds);

  insert into community_voting_entries (instance_id, ordinal, label, claim_code_hash, claim_window_seconds, claim_expires_at)
  values (
    p_instance_id, v_ordinal, v_label,
    encode(sha256(convert_to(v_code, 'UTF8')), 'hex'),
    p_claim_ttl_seconds, v_expires
  )
  returning community_voting_entries.entry_id into v_entry_id;

  return query select v_entry_id, v_label, v_code, v_expires;
end;
$$;

create function remove_community_voting_entry_atomically(
  p_instance_id uuid,
  p_host_token text,
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
  v_host_token text;
  v_removed uuid;
begin
  select i.session_id into v_session_id
  from community_voting_instances i
  where i.instance_id = p_instance_id;

  if v_session_id is null then
    raise exception 'CV_INSTANCE_NOT_FOUND: no Community Voting Instance exists for this id'
      using errcode = 'P0001';
  end if;

  select sessions.host_token into v_host_token
  from sessions
  where sessions.session_id = v_session_id
  for update;

  if v_host_token is distinct from p_host_token then
    raise exception 'HOST_TOKEN_MISMATCH: supplied host token does not match this session'
      using errcode = 'P0001';
  end if;

  if exists (select 1 from interaction_instances ii where ii.session_id = v_session_id) then
    raise exception 'CV_PREPARATION_CLOSED: Voting has opened; the ballot can no longer change'
      using errcode = 'P0001';
  end if;

  delete from community_voting_entries
  where community_voting_entries.entry_id = p_entry_id
    and community_voting_entries.instance_id = p_instance_id
  returning community_voting_entries.entry_id into v_removed;

  if v_removed is null then
    raise exception 'CV_ENTRY_NOT_FOUND: this ballot has no such entry'
      using errcode = 'P0001';
  end if;

  return query select v_removed;
end;
$$;

-- The host's view of the ballot being prepared: label, state, and whether a usable claim credential remains.
-- It returns no identity of any kind and no secret. (A read, so it takes no lock; it still checks host authority.)
create function read_community_voting_preparation(
  p_instance_id uuid,
  p_host_token text
)
returns table (entry_id uuid, label text, state text, claimable boolean, claim_expires_at timestamptz)
language plpgsql
stable
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_session_id uuid;
  v_host_token text;
begin
  select i.session_id into v_session_id
  from community_voting_instances i
  where i.instance_id = p_instance_id;

  if v_session_id is null then
    raise exception 'CV_INSTANCE_NOT_FOUND: no Community Voting Instance exists for this id'
      using errcode = 'P0001';
  end if;

  select sessions.host_token into v_host_token
  from sessions
  where sessions.session_id = v_session_id;

  if v_host_token is distinct from p_host_token then
    raise exception 'HOST_TOKEN_MISMATCH: supplied host token does not match this session'
      using errcode = 'P0001';
  end if;

  return query
    select s.entry_id, s.label, s.state, s.claimable,
           case when s.claimable then s.claim_expires_at else null end
    from (
      select e.entry_id, e.label,
             case
               when e.confirmed_binding_id is not null then 'CONFIRMED'
               when e.pending_binding_id is not null then 'PENDING_CONFIRMATION'
               else 'UNCLAIMED'
             end as state,
             (e.pending_binding_id is null and e.confirmed_binding_id is null
                and e.claim_code_hash is not null and e.claim_expires_at > now()) as claimable,
             e.claim_expires_at, e.ordinal
      from community_voting_entries e
      where e.instance_id = p_instance_id
    ) s
    order by s.ordinal, s.entry_id;
end;
$$;

-- The CONTESTANT's act. The caller is a server-verified identity (the route's concern) that must already be
-- bound to this event. It consumes the single-use claim credential, marks the entry pending for THEIR binding,
-- and returns the confirmation code once. An unknown, malformed, already-used or foreign-event credential all
-- fail the same way (CV_CLAIM_INVALID); an expired one says so (CV_CLAIM_EXPIRED). The credential is looked up
-- only within this Instance, so a credential from another event can never match.
create function claim_community_voting_entry_atomically(
  p_instance_id uuid,
  p_auth_user_id uuid,
  p_claim_code text
)
returns table (label text, confirmation_code text, confirm_expires_at timestamptz)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_session_id uuid;
  v_binding_id uuid;
  v_code text;
  v_entry_id uuid;
  v_label text;
  v_claim_expires timestamptz;
  v_window integer;
  v_confirmation text;
  v_confirm_expires timestamptz;
begin
  select i.session_id into v_session_id
  from community_voting_instances i
  where i.instance_id = p_instance_id;

  if v_session_id is null then
    raise exception 'CV_INSTANCE_NOT_FOUND: no Community Voting Instance exists for this id'
      using errcode = 'P0001';
  end if;

  perform 1 from sessions where sessions.session_id = v_session_id for update;

  select b.binding_id into v_binding_id
  from community_voting_voter_bindings b
  where b.instance_id = p_instance_id and b.auth_user_id = p_auth_user_id;

  if v_binding_id is null then
    raise exception 'CV_NOT_BOUND: this identity is not bound to the Instance'
      using errcode = 'P0001';
  end if;

  if exists (select 1 from interaction_instances ii where ii.session_id = v_session_id) then
    raise exception 'CV_PREPARATION_CLOSED: Voting has opened; the ballot can no longer change'
      using errcode = 'P0001';
  end if;

  v_code := lower(btrim(coalesce(p_claim_code, '')));
  if v_code !~ '^[0-9a-f]{32}$' then
    raise exception 'CV_CLAIM_INVALID: this claim is not valid'
      using errcode = 'P0001';
  end if;

  select e.entry_id, e.label, e.claim_expires_at, e.claim_window_seconds
    into v_entry_id, v_label, v_claim_expires, v_window
  from community_voting_entries e
  where e.instance_id = p_instance_id
    and e.claim_code_hash = encode(sha256(convert_to(v_code, 'UTF8')), 'hex')
  for update;

  if v_entry_id is null then
    raise exception 'CV_CLAIM_INVALID: this claim is not valid'
      using errcode = 'P0001';
  end if;

  if v_claim_expires <= now() then
    raise exception 'CV_CLAIM_EXPIRED: this claim has expired'
      using errcode = 'P0001';
  end if;

  if exists (
    select 1 from community_voting_entries e
    where e.instance_id = p_instance_id
      and (e.pending_binding_id = v_binding_id or e.confirmed_binding_id = v_binding_id)
  ) then
    raise exception 'CV_CONTESTANT_ALREADY_HAS_ENTRY: this identity already holds an entry in this ballot'
      using errcode = 'P0001';
  end if;

  v_confirmation := upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 8));
  v_confirm_expires := now() + make_interval(secs => v_window);

  update community_voting_entries
  set claim_code_hash = null,
      pending_binding_id = v_binding_id,
      confirmation_code_hash = encode(sha256(convert_to(v_confirmation, 'UTF8')), 'hex'),
      confirmation_expires_at = v_confirm_expires,
      confirmation_failures = 0
  where community_voting_entries.entry_id = v_entry_id;

  return query select v_label, v_confirmation, v_confirm_expires;
end;
$$;

-- The HOST's act: confirm the intended entry against the code shown on the claimant's own screen.
--
-- A wrong code must COUNT, and a count only survives if the call returns normally — a raised exception would
-- roll the increment back and make the limit meaningless. So a mismatch is a normal RETURN (outcome REJECTED,
-- or VOIDED on the fifth), and the caller turns it into an error. Everything else (no such entry, nothing
-- pending, expired, malformed input) raises and changes nothing.
create function confirm_community_voting_entry_atomically(
  p_instance_id uuid,
  p_host_token text,
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
  v_host_token text;
  v_pending uuid;
  v_hash text;
  v_expires timestamptz;
  v_failures integer;
  v_normalized text;
  v_found uuid;
begin
  select i.session_id into v_session_id
  from community_voting_instances i
  where i.instance_id = p_instance_id;

  if v_session_id is null then
    raise exception 'CV_INSTANCE_NOT_FOUND: no Community Voting Instance exists for this id'
      using errcode = 'P0001';
  end if;

  select sessions.host_token into v_host_token
  from sessions
  where sessions.session_id = v_session_id
  for update;

  if v_host_token is distinct from p_host_token then
    raise exception 'HOST_TOKEN_MISMATCH: supplied host token does not match this session'
      using errcode = 'P0001';
  end if;

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

  if v_hash = encode(sha256(convert_to(v_normalized, 'UTF8')), 'hex') then
    update community_voting_entries
    set confirmed_binding_id = v_pending,
        confirmed_at = now(),
        pending_binding_id = null,
        confirmation_code_hash = null,
        confirmation_expires_at = null,
        confirmation_failures = 0
    where community_voting_entries.entry_id = p_entry_id;

    return query select p_entry_id, 'CONFIRMED'::text, 0;
    return;
  end if;

  if v_failures + 1 >= 5 then
    -- Five wrong codes void the claim. The credential was consumed by the claim, so the entry is now dead:
    -- the host removes it and creates it again.
    update community_voting_entries
    set pending_binding_id = null,
        confirmation_code_hash = null,
        confirmation_expires_at = null,
        confirmation_failures = 0
    where community_voting_entries.entry_id = p_entry_id;

    return query select p_entry_id, 'VOIDED'::text, 0;
    return;
  end if;

  update community_voting_entries
  set confirmation_failures = v_failures + 1
  where community_voting_entries.entry_id = p_entry_id;

  return query select p_entry_id, 'REJECTED'::text, 5 - (v_failures + 1);
end;
$$;

-- ---------------------------------------------------------------------------------------
-- The explicit, atomic start
-- ---------------------------------------------------------------------------------------
--
-- The ONLY way an event-bound Session ever gets a Voting interaction. It is host-authorized, never implied by
-- completing preparation, and it is ONE transaction. Order:
--
--   1. resolve the Instance; lock the Session row FIRST; verify the Session's host token
--   2. the declared capability set must be exactly VOTING
--   3. no interaction may exist yet                                            (CV_ALREADY_OPENED)
--   4. the Session must be LOBBY_LOCKED, as for the ordinary start             (CV_SESSION_NOT_STARTABLE)
--   5. the prompt must be real text
--   6. preparation must be complete: at least two entries, EVERY one confirmed (CV_PREPARATION_INCOMPLETE).
--      Uniqueness needs no check here: it is guaranteed by the table (one entry per contestant, unique
--      labels), and no association can point at another event.
--   7. mark this transaction as the sanctioned opening of THIS Session (see below), then call the Session's
--      OWN start_session_atomically — the unchanged function — with the entries' labels as a HOST_AUTHORED
--      ballot. That is the Session-owned opening transition: it writes the prompt, the segment, the
--      interaction (born PROMPT_ACTIVE), the candidates and the single INTERACTION_STARTED event, exactly as
--      it does for every ordinary Session, with the same timestamps and without touching the Session row.
--   8. attribute each materialized candidate to its confirmed contestant's Participant (the existing
--      voting_candidates.participant_id) and link each entry to its candidate
--   9. verify the result (every candidate attributed, counts equal) and return
--
-- Everything is one function call, hence one transaction: a failure at ANY step — including a failure in step
-- 8 after the Session has already written its interaction — rolls back all of it, so no interaction, prompt,
-- segment, candidate, event or link survives, and the caller sees an error, never a success.
--
-- THE MARKER. The Session's own start inserts into interaction_instances and voting_candidates, which the
-- guard triggers (migration 20261020190300) refuse for an event-bound Session — that refusal is exactly what
-- stops the ordinary start from opening an event-bound Session with an unattributed ballot. This function
-- authorizes its own opening by setting a TRANSACTION-LOCAL setting, `urbano.community_voting_start`, to the
-- Session's id, for the duration of this call only (set_config(..., true), cleared before returning and
-- discarded at transaction end). The triggers honour it for that one Session only. It cannot be forged through
-- the REST surface (set_config lives in pg_catalog, which PostgREST does not expose, and a setting is private to
-- its own connection); anyone who can already run arbitrary SQL as a privileged role could set it, but that
-- caller can write these tables directly anyway.

create function start_community_voting_atomically(
  p_instance_id uuid,
  p_host_token text,
  p_prompt_text text
)
returns table (
  interaction_instance_id uuid,
  prompt_id uuid,
  state text,
  segment_ordinal integer,
  candidate_count integer
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_session_id uuid;
  v_state text;
  v_host_token text;
  v_capabilities text[];
  v_prompt text;
  v_total integer;
  v_confirmed integer;
  v_labels jsonb;
  v_start record;
  v_rows integer;
begin
  select i.session_id into v_session_id
  from community_voting_instances i
  where i.instance_id = p_instance_id;

  if v_session_id is null then
    raise exception 'CV_INSTANCE_NOT_FOUND: no Community Voting Instance exists for this id'
      using errcode = 'P0001';
  end if;

  -- SESSION-FIRST
  select sessions.state, sessions.host_token, sessions.declared_capabilities
    into v_state, v_host_token, v_capabilities
  from sessions
  where sessions.session_id = v_session_id
  for update;

  if v_host_token is distinct from p_host_token then
    raise exception 'HOST_TOKEN_MISMATCH: supplied host token does not match this session'
      using errcode = 'P0001';
  end if;

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

  select count(*)::integer, (count(*) filter (where e.confirmed_binding_id is not null))::integer
    into v_total, v_confirmed
  from community_voting_entries e
  where e.instance_id = p_instance_id;

  if v_total < 2 or v_confirmed <> v_total then
    raise exception 'CV_PREPARATION_INCOMPLETE: the ballot needs at least two entries and every entry must have a confirmed contestant'
      using errcode = 'P0001';
  end if;

  select jsonb_agg(to_jsonb(e.label) order by e.ordinal) into v_labels
  from community_voting_entries e
  where e.instance_id = p_instance_id;

  perform set_config('urbano.community_voting_start', v_session_id::text, true);

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

  return query select v_start.interaction_instance_id, v_start.prompt_id, v_start.state, v_start.segment_ordinal, v_total;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Cast: a gate in front of the unchanged cast_vote_atomically
-- ---------------------------------------------------------------------------------------
--
-- Order (the Session lock first, then the binding, then the interaction — every step in ONE
-- transaction, so any failure rolls back the delegated Voting write, its VOTE_CAST event and the
-- recovery metadata together):
--
--   1. resolve the Instance; lock the Session; lock the caller's binding
--   2. the binding must be the caller's own (cross-binding intents are refused)
--   3. the intent must have been issued
--   4. REPLAY      (intent == applied)  : same payload commitment -> return the authoritative vote
--                                         unchanged, with no new Voting transition and no
--                                         re-evaluation of location, even after close;
--                                         different payload -> CV_INTENT_PAYLOAD_MISMATCH
--   5. STALE       (intent <  applied)  : CV_STALE_INTENT. An older intent never overwrites a newer
--   6. a NEW intent additionally requires: Session LOBBY_LOCKED, current interaction VOTING in
--      PROMPT_ACTIVE, the stated interaction to BE the current one, the candidate to belong to it,
--      (every candidate of an open ballot is attributed BY CONSTRUCTION — see the corruption check below)
--   7. location is evaluated HERE, server-side, from the Instance's stored facts. Only INSIDE passes.
--      Raw coordinates are parameters of this call only: never stored, logged or echoed.
--   8. if the candidate equals the voter's current vote the intent is CONSUMED but NO Voting
--      transition happens (outcome UNCHANGED); otherwise the Participant token is read here, inside
--      the database, and cast_vote_atomically is called with it (outcome APPLIED)
--   9. only now are the accepted recovery metadata recorded
--
-- A rejected attempt consumes nothing. Because intents are consumed only on success, an intent that
-- failed (outside the venue, ambiguous reading, ...) can be retried as-is.

create function cast_community_voting_vote_atomically(
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
  v_digest text;
  v_vote_candidate uuid;
  v_vote_updated timestamptz;
  v_assess record;
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

  -- The canonical payload commitment: Instance, Voting interaction and candidate.
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

  select ii.interaction_instance_id, ii.state, ii.engine_type
    into v_cur_id, v_cur_state, v_cur_engine
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

  if p_candidate_id is null or not exists (
    select 1 from voting_candidates vc
    where vc.candidate_id = p_candidate_id and vc.interaction_instance_id = v_cur_id
  ) then
    raise exception 'INVALID_CANDIDATE_SELECTION: selected candidate is not valid for this Voting interaction'
      using errcode = 'P0001';
  end if;

  -- INVARIANT, not a normal condition: an open event ballot never has an unattributed candidate, because the
  -- only way it can open is start_community_voting_atomically, which attributes every candidate in the same
  -- transaction that creates them, and the guard triggers freeze them from then on. Reaching this means the
  -- ballot was corrupted behind the application's back. Fail closed, loudly — never accept a vote on it.
  if exists (
    select 1 from voting_candidates vc
    where vc.interaction_instance_id = v_cur_id and vc.participant_id is null
  ) then
    raise exception 'CV_STATE_INCONSISTENT: an open ballot has an unattributed candidate'
      using errcode = 'P0001';
  end if;

  -- 7. location, evaluated server-side from stored facts
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

  -- 8. no-op reselection, or delegation to the unchanged Voting writer
  select v.candidate_id, v.updated_at into v_vote_candidate, v_vote_updated
  from votes v
  where v.interaction_instance_id = v_cur_id and v.participant_id = v_binding.participant_id;

  if found and v_vote_candidate = p_candidate_id then
    v_outcome := 'UNCHANGED';
  else
    select participants.participant_token into v_token
    from participants
    where participants.participant_id = v_binding.participant_id;

    select * into v_delegate
    from cast_vote_atomically(v_instance.session_id, v_binding.participant_id, v_token, p_candidate_id);

    v_vote_updated := v_delegate.updated_at;
    v_outcome := 'APPLIED';
  end if;

  -- 9. record ONLY the accepted recovery metadata (derived evidence — never a coordinate)
  update community_voting_voter_bindings
  set applied_intent_no = p_intent_no,
      applied_payload_digest = v_digest,
      applied_distance_meters = round(v_assess.distance_meters::numeric, 1),
      applied_accuracy_meters = round(p_accuracy_meters::numeric, 1),
      applied_at = now()
  where community_voting_voter_bindings.binding_id = v_binding.binding_id;

  return query select v_outcome, v_binding.binding_id, p_intent_no, v_cur_id, p_candidate_id, v_vote_updated;
end;
$$;

-- ---------------------------------------------------------------------------------------
-- Status recovery (read-only)
-- ---------------------------------------------------------------------------------------
--
-- The caller's OWN bounded snapshot, read from the existing Voting store. Zero rows when the
-- caller has no binding. It exposes no Participant token, no opaque label, no Participant id, no
-- other voter and no tally. It is a single statement, so it is internally consistent, and it does
-- not depend on the Session being open: a committed vote is recoverable after close.

create function read_community_voting_voter_status(
  p_instance_id uuid,
  p_auth_user_id uuid
)
returns table (
  instance_id uuid,
  binding_id uuid,
  session_state text,
  interaction_instance_id uuid,
  interaction_state text,
  engine_type text,
  issued_intent_no integer,
  applied_intent_no integer,
  my_candidate_id uuid,
  my_entry_label text,
  my_entry_state text
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    b.instance_id,
    b.binding_id,
    s.state,
    ci.interaction_instance_id,
    ci.state,
    ci.engine_type,
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
    end
  from community_voting_voter_bindings b
  join community_voting_instances i on i.instance_id = b.instance_id
  join sessions s on s.session_id = i.session_id
  left join lateral (
    select ii.interaction_instance_id, ii.state, ii.engine_type
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
-- Every function above was created under this project's standing default-privilege rule, which
-- grants EXECUTE to PUBLIC, anon and authenticated. None of these may be called by a browser
-- role, so each is revoked in the SAME migration that creates it (ENGINEERING_PATTERNS.md,
-- 0126). service_role keeps its EXECUTE.

revoke execute on function community_voting_assess_location(double precision, double precision, double precision, double precision, double precision, double precision, double precision, double precision, double precision) from public, anon, authenticated;
revoke execute on function register_community_voting_instance_atomically(uuid, text, double precision, double precision, double precision, double precision, double precision, double precision, integer) from public, anon, authenticated;
revoke execute on function bind_community_voting_voter_atomically(uuid, uuid) from public, anon, authenticated;
revoke execute on function issue_community_voting_intent_atomically(uuid, uuid) from public, anon, authenticated;
revoke execute on function create_community_voting_entry_atomically(uuid, text, text, integer) from public, anon, authenticated;
revoke execute on function remove_community_voting_entry_atomically(uuid, text, uuid) from public, anon, authenticated;
revoke execute on function read_community_voting_preparation(uuid, text) from public, anon, authenticated;
revoke execute on function claim_community_voting_entry_atomically(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function confirm_community_voting_entry_atomically(uuid, text, uuid, text) from public, anon, authenticated;
revoke execute on function start_community_voting_atomically(uuid, text, text) from public, anon, authenticated;
revoke execute on function cast_community_voting_vote_atomically(uuid, uuid, uuid, integer, uuid, uuid, double precision, double precision, double precision) from public, anon, authenticated;
revoke execute on function read_community_voting_voter_status(uuid, uuid) from public, anon, authenticated;
