-- Migration: 0144_start_math_duel_atomically_standard_only
-- Math Duel Slice 001 — Pre-Deployment Product-Invariant Correction.
--
-- Replaces 0140's own start_math_duel_atomically. Corrects a confirmed
-- Product-invariant defect: pre-materializing a finite sudden-death
-- reserve (25 rows) alongside the 5 standard challenges made the Duel
-- functionally cap out at 25 tied sudden-death rounds — a real
-- MATH_DUEL_CHALLENGES_EXHAUSTED stall, contradicting the Founder-
-- confirmed "no round cap" requirement. See 0145's own migration
-- comment for the corrected, uncapped sudden-death design this
-- function's narrower job now supports.
--
-- p_challenges is now exactly the 5 STANDARD challenges — no phase
-- tag, no sudden-death entries. Ordinal 1 is activated the instant
-- the Duel starts (authorized to both competitors immediately);
-- ordinals 2-5 are activated lazily, by submit_math_duel_answer_
-- atomically (0145), the moment either competitor is first authorized
-- into them.

create or replace function start_math_duel_atomically(
  p_session_id uuid,
  p_host_token text,
  p_competitor_a_participant_id uuid,
  p_competitor_b_participant_id uuid,
  p_challenges jsonb
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
  v_session_state text;
  v_host_token text;
  v_declared_capabilities text[];
  v_previous_interaction_state text;
  v_active_duel_id uuid;
  v_competitor_a_session_id uuid;
  v_competitor_b_session_id uuid;
  v_duel_id uuid;
  v_started_at timestamptz;
  v_challenge jsonb;
  v_ordinal integer;
begin
  if p_competitor_a_participant_id = p_competitor_b_participant_id then
    raise exception 'DUPLICATE_DUEL_COMPETITOR: a Duel requires two distinct competitors'
      using errcode = 'P0001';
  end if;

  -- p_challenges is exactly the 5 standard-phase challenges now — the
  -- sudden-death supply is no longer pre-materialized (see 0145).
  if p_challenges is null or jsonb_typeof(p_challenges) <> 'array' or jsonb_array_length(p_challenges) <> 5 then
    raise exception 'INVALID_MATH_DUEL_CHALLENGES: exactly 5 standard-phase challenges are required'
      using errcode = 'P0001';
  end if;

  if exists (
    select 1
    from jsonb_array_elements(p_challenges) as c(val)
    where btrim(c.val ->> 'questionText') = ''
       or c.val ->> 'questionText' is null
       or (c.val ->> 'correctAnswer') is null
       or (c.val ->> 'correctAnswer')::integer < 0
  ) then
    raise exception 'INVALID_MATH_DUEL_CHALLENGES: each challenge requires non-empty questionText and a non-negative correctAnswer'
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
    session_id, mechanic_key, competitor_a_participant_id, competitor_b_participant_id,
    lifecycle_state, started_at
  )
  values (
    p_session_id, 'MATH_DUEL', p_competitor_a_participant_id, p_competitor_b_participant_id,
    'ACTIVE', v_started_at
  )
  returning duels.duel_id into v_duel_id;

  v_ordinal := 1;
  for v_challenge in select * from jsonb_array_elements(p_challenges)
  loop
    insert into duel_math_challenges (
      duel_id, challenge_ordinal, phase, question_text, correct_answer, activated_at
    )
    values (
      v_duel_id, v_ordinal, 'STANDARD',
      btrim(v_challenge ->> 'questionText'),
      (v_challenge ->> 'correctAnswer')::integer,
      -- Ordinal 1 is authorized to both competitors from the instant
      -- the Duel starts; ordinals 2-5 are not yet authorized to
      -- anyone until the prior one is answered, so their activation
      -- is left null here and set lazily by 0145.
      case when v_ordinal = 1 then v_started_at else null end
    );
    v_ordinal := v_ordinal + 1;
  end loop;

  insert into session_events (session_id, event_type, payload)
  values (
    p_session_id,
    'DUEL_STARTED',
    jsonb_build_object(
      'duelId', v_duel_id,
      'mechanicKey', 'MATH_DUEL',
      'competitorAParticipantId', p_competitor_a_participant_id,
      'competitorBParticipantId', p_competitor_b_participant_id
    )
  );

  return query select v_duel_id, 'ACTIVE'::text, v_started_at;
end;
$$;
