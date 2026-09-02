-- Migration: 0169_create_start_pulse_duel_atomically
-- URBANO Pulse Slice 001 (UG-CR-GATE-002). START_PULSE_DUEL's atomic
-- operation — a sibling to start_duel_atomically/start_math_duel_
-- atomically, not a generalization of either (mirrors startMathDuel.ts's
-- own established "duplicated here rather than shared" convention for
-- the generic Duel-initiation checks). Creates the Duel already ACTIVE
-- at the container level (0128's own "goes straight to its running
-- state on creation" discipline) — the game's own SETUP sub-phase is
-- tracked entirely by pulse_games.current_actor_participant_id being
-- null, not by duels.lifecycle_state.

create function start_pulse_duel_atomically(
  p_session_id uuid,
  p_host_token text,
  p_competitor_a_participant_id uuid,
  p_competitor_b_participant_id uuid
)
returns table (
  duel_id uuid,
  lifecycle_state text,
  started_at timestamptz
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_host_token text;
  v_state text;
  v_declared_capabilities text[];
  v_a_exists boolean;
  v_b_exists boolean;
  v_current_interaction_state text;
  v_active_duel_id uuid;
  v_duel_id uuid;
  v_created_at timestamptz;
begin
  if p_competitor_a_participant_id = p_competitor_b_participant_id then
    raise exception 'DUPLICATE_DUEL_COMPETITOR: competitors must be distinct'
      using errcode = 'P0001';
  end if;

  select sessions.host_token, sessions.state, sessions.declared_capabilities
    into v_host_token, v_state, v_declared_capabilities
  from sessions
  where sessions.session_id = p_session_id
  for update;

  if v_host_token is null then
    raise exception 'SESSION_NOT_FOUND: no session exists for this session_id'
      using errcode = 'P0001';
  end if;
  if v_host_token <> p_host_token then
    raise exception 'HOST_TOKEN_MISMATCH: supplied host token does not match this session'
      using errcode = 'P0001';
  end if;
  if v_state <> 'LOBBY_LOCKED' then
    raise exception 'LOBBY_NOT_LOCKED: session is in % state, not LOBBY_LOCKED', v_state
      using errcode = 'P0001';
  end if;
  if v_declared_capabilities is null or not ('DUEL' = any(v_declared_capabilities)) then
    raise exception 'CAPABILITY_NOT_AUTHORIZED: DUEL is not declared for this session'
      using errcode = 'P0001';
  end if;

  select exists(
    select 1 from participants
    where participants.participant_id = p_competitor_a_participant_id
      and participants.session_id = p_session_id
  ) into v_a_exists;
  select exists(
    select 1 from participants
    where participants.participant_id = p_competitor_b_participant_id
      and participants.session_id = p_session_id
  ) into v_b_exists;
  if not v_a_exists or not v_b_exists then
    raise exception 'DUEL_COMPETITOR_NOT_IN_SESSION: a competitor id is not a participant of this session'
      using errcode = 'P0001';
  end if;

  select interaction_instances.state into v_current_interaction_state
  from interaction_instances
  where interaction_instances.session_id = p_session_id
  order by interaction_instances.created_at desc
  limit 1;

  if v_current_interaction_state is not null and v_current_interaction_state <> 'RESULT_REVEAL' then
    raise exception 'INTERACTION_ACTIVE: the current interaction is still %', v_current_interaction_state
      using errcode = 'P0001';
  end if;

  select duels.duel_id into v_active_duel_id
  from duels
  where duels.session_id = p_session_id and duels.lifecycle_state = 'ACTIVE'
  for update;

  if v_active_duel_id is not null then
    raise exception 'ACTIVE_DUEL_EXISTS: another duel is already active for this session'
      using errcode = 'P0001';
  end if;

  v_created_at := now();
  v_duel_id := gen_random_uuid();

  insert into duels (
    duel_id, session_id, competitor_a_participant_id, competitor_b_participant_id,
    prompt_text, options, correct_option_index,
    mechanic_key, lifecycle_state, created_at, started_at
  ) values (
    v_duel_id, p_session_id, p_competitor_a_participant_id, p_competitor_b_participant_id,
    null, null, null,
    'PULSE', 'ACTIVE', v_created_at, v_created_at
  );

  insert into pulse_boards (duel_id, participant_id) values (v_duel_id, p_competitor_a_participant_id);
  insert into pulse_boards (duel_id, participant_id) values (v_duel_id, p_competitor_b_participant_id);

  insert into pulse_games (duel_id) values (v_duel_id);

  insert into session_events (session_id, event_type, payload)
  values (
    p_session_id,
    'DUEL_STARTED',
    jsonb_build_object(
      'duelId', v_duel_id,
      'mechanicKey', 'PULSE',
      'competitorAParticipantId', p_competitor_a_participant_id,
      'competitorBParticipantId', p_competitor_b_participant_id
    )
  );

  return query select v_duel_id, 'ACTIVE'::text, v_created_at;
end;
$$;
