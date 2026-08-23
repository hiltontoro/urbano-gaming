-- Migration: 0129_create_start_duel_atomically
-- Duel / SESSION_SUBGAME v1.
--
-- START_DUEL's atomic operation. Mirrors start_session_atomically's
-- (0111) own locking discipline exactly: lock the session row first,
-- re-verify host token and LOBBY_LOCKED state, then check the mutual-
-- exclusion invariant with the current Interaction Instance (if any)
-- before creating anything. Duel does not create an interaction_
-- instances row or a segment — see 0128's own comment for why a real
-- Interaction Instance would not be truthful for a two-competitor
-- subgame; a Duel is its own, structurally separate entity.
--
-- Ordering matters for the mutual-exclusion checks: the existing-
-- interaction check and the existing-Duel check both use `for update`
-- locks, so two concurrent START_DUEL calls (or a START_DUEL racing an
-- ordinary interaction start) serialize on the session row lock taken
-- first, then re-verify their own precondition — exactly the same
-- discipline that already makes start_session_atomically's own
-- PREVIOUS_INTERACTION_NOT_REVEALED check race-safe. duels_one_active_
-- per_session (0128) is the schema-level backstop if a caller ever
-- reached this function through the row lock, satisfies every check,
-- but still races an equally-locked concurrent insert.

create function start_duel_atomically(
  p_session_id uuid,
  p_host_token text,
  p_competitor_a_participant_id uuid,
  p_competitor_b_participant_id uuid,
  p_prompt_text text,
  p_options jsonb,
  p_correct_option_index integer
)
returns table (
  duel_id uuid,
  lifecycle_state text,
  prompt_text text,
  options jsonb,
  started_at timestamptz
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_session_state text;
  v_host_token text;
  v_declared_capabilities text[];
  v_previous_interaction_state text;
  v_active_duel_id uuid;
  v_competitor_a_session_id uuid;
  v_competitor_b_session_id uuid;
  v_duel_id uuid;
  v_started_at timestamptz;
begin
  if p_competitor_a_participant_id = p_competitor_b_participant_id then
    raise exception 'DUPLICATE_DUEL_COMPETITOR: a Duel requires two distinct competitors'
      using errcode = 'P0001';
  end if;

  if p_options is null or jsonb_typeof(p_options) <> 'array' or jsonb_array_length(p_options) < 2 then
    raise exception 'INVALID_DUEL_OPTIONS: at least two options are required'
      using errcode = 'P0001';
  end if;

  if exists (
    select 1 from jsonb_array_elements_text(p_options) as o(val)
    where btrim(o.val) = ''
  ) then
    raise exception 'INVALID_DUEL_OPTIONS: options must not be empty'
      using errcode = 'P0001';
  end if;

  if (
    select count(distinct btrim(o.val))
    from jsonb_array_elements_text(p_options) as o(val)
  ) <> jsonb_array_length(p_options) then
    raise exception 'INVALID_DUEL_OPTIONS: options must be distinct'
      using errcode = 'P0001';
  end if;

  if p_correct_option_index is null
     or p_correct_option_index < 0
     or p_correct_option_index >= jsonb_array_length(p_options) then
    raise exception 'INVALID_DUEL_OPTIONS: correct option index is out of range'
      using errcode = 'P0001';
  end if;

  select sessions.state, sessions.host_token, sessions.declared_capabilities
    into v_session_state, v_host_token, v_declared_capabilities
  from sessions
  where sessions.session_id = p_session_id
  for update;

  if v_session_state is null then
    raise exception 'SESSION_NOT_FOUND: no session exists for this session_id'
      using errcode = 'P0001';
  end if;

  if v_host_token <> p_host_token then
    raise exception 'HOST_TOKEN_MISMATCH: supplied host token does not match this session'
      using errcode = 'P0001';
  end if;

  if v_session_state <> 'LOBBY_LOCKED' then
    raise exception 'LOBBY_NOT_LOCKED: session is in % state, not LOBBY_LOCKED', v_session_state
      using errcode = 'P0001';
  end if;

  if not ('DUEL' = any(coalesce(v_declared_capabilities, array[]::text[]))) then
    raise exception 'CAPABILITY_NOT_AUTHORIZED: this session has not declared the DUEL capability'
      using errcode = 'P0001';
  end if;

  select participants.session_id into v_competitor_a_session_id
  from participants
  where participants.participant_id = p_competitor_a_participant_id
  for update;

  if v_competitor_a_session_id is null or v_competitor_a_session_id <> p_session_id then
    raise exception 'DUEL_COMPETITOR_NOT_IN_SESSION: competitor A does not belong to this session'
      using errcode = 'P0001';
  end if;

  select participants.session_id into v_competitor_b_session_id
  from participants
  where participants.participant_id = p_competitor_b_participant_id
  for update;

  if v_competitor_b_session_id is null or v_competitor_b_session_id <> p_session_id then
    raise exception 'DUEL_COMPETITOR_NOT_IN_SESSION: competitor B does not belong to this session'
      using errcode = 'P0001';
  end if;

  select interaction_instances.state into v_previous_interaction_state
  from interaction_instances
  where interaction_instances.session_id = p_session_id
  order by interaction_instances.created_at desc
  limit 1
  for update;

  if v_previous_interaction_state is not null and v_previous_interaction_state <> 'RESULT_REVEAL' then
    raise exception 'INTERACTION_ACTIVE: an ordinary interaction is in % state; a Duel cannot start until it is RESULT_REVEAL', v_previous_interaction_state
      using errcode = 'P0001';
  end if;

  select duels.duel_id into v_active_duel_id
  from duels
  where duels.session_id = p_session_id
    and duels.lifecycle_state = 'ACTIVE'
  for update;

  if v_active_duel_id is not null then
    raise exception 'ACTIVE_DUEL_EXISTS: this session already has an active Duel'
      using errcode = 'P0001';
  end if;

  v_started_at := now();

  insert into duels (
    session_id, competitor_a_participant_id, competitor_b_participant_id,
    prompt_text, options, correct_option_index, lifecycle_state, started_at
  )
  values (
    p_session_id, p_competitor_a_participant_id, p_competitor_b_participant_id,
    btrim(p_prompt_text), p_options, p_correct_option_index, 'ACTIVE', v_started_at
  )
  returning duels.duel_id into v_duel_id;

  insert into session_events (session_id, event_type, payload)
  values (
    p_session_id,
    'DUEL_STARTED',
    jsonb_build_object(
      'duelId', v_duel_id,
      'competitorAParticipantId', p_competitor_a_participant_id,
      'competitorBParticipantId', p_competitor_b_participant_id
    )
  );

  return query select v_duel_id, 'ACTIVE'::text, btrim(p_prompt_text), p_options, v_started_at;
end;
$$;
