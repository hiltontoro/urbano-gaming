-- Migration: 0134_start_quiz_atomically_excludes_active_duel
-- Duel / SESSION_SUBGAME v1.
--
-- 0112's own start_quiz_atomically is not edited as a file —
-- create-or-replace, the same precedent as every prior replacement of
-- this function. The only behavioral change: the same active-Duel
-- guard 0133 already added to start_session_atomically, placed
-- identically (immediately after LOBBY_NOT_LOCKED) — Quiz is its own
-- structurally separate activation path (0112's own comment) and needs
-- the mutual-exclusion invariant enforced independently, not inferred
-- from start_session_atomically having it. Everything else is
-- byte-for-byte unchanged from 0112.

create or replace function start_quiz_atomically(
  p_session_id uuid,
  p_host_token text,
  p_duration_seconds integer
)
returns table (
  interaction_instance_id uuid,
  prompt_id uuid,
  ordinal integer,
  segment_id uuid,
  segment_ordinal integer,
  closes_at timestamptz
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
  v_previous_interaction_instance_id uuid;
  v_previous_interaction_state text;
  v_segment_id uuid;
  v_segment_ordinal integer;
  v_closes_at timestamptz;
  v_prompt_id uuid;
  v_interaction_instance_id uuid;
  v_question_count integer := 0;
  v_active_duel_id uuid;
  r record;
begin
  if p_duration_seconds is null or p_duration_seconds < 30 or p_duration_seconds > 3600 then
    raise exception 'INVALID_QUIZ_DURATION: duration must be between 30 and 3600 seconds'
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

  -- Duel / SESSION_SUBGAME v1: symmetric half of the mutual-exclusion
  -- invariant with start_duel_atomically (0129), same as 0133 already
  -- added to start_session_atomically.
  select duels.duel_id into v_active_duel_id
  from duels
  where duels.session_id = p_session_id
    and duels.lifecycle_state = 'ACTIVE'
  for update;

  if v_active_duel_id is not null then
    raise exception 'ACTIVE_DUEL_EXISTS: this session has an active Duel; an ordinary interaction cannot start until it resolves'
      using errcode = 'P0001';
  end if;

  if not ('QUIZ' = any(coalesce(v_declared_capabilities, array[]::text[]))) then
    raise exception 'CAPABILITY_NOT_AUTHORIZED: this session has not declared the QUIZ capability'
      using errcode = 'P0001';
  end if;

  select interaction_instances.interaction_instance_id, interaction_instances.state
    into v_previous_interaction_instance_id, v_previous_interaction_state
  from interaction_instances
  where interaction_instances.session_id = p_session_id
  order by interaction_instances.created_at desc
  limit 1
  for update;

  if v_previous_interaction_instance_id is not null
     and v_previous_interaction_state <> 'RESULT_REVEAL' then
    raise exception 'PREVIOUS_INTERACTION_NOT_REVEALED: current interaction is in % state, not RESULT_REVEAL', v_previous_interaction_state
      using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from prepared_questions
    where prepared_questions.session_id = p_session_id
      and prepared_questions.consumed_at is null
  ) then
    raise exception 'EMPTY_QUIZ_QUESTION_SET: no unconsumed prepared questions exist to start a Quiz'
      using errcode = 'P0001';
  end if;

  select coalesce(max(segments.segment_ordinal), 0) + 1 into v_segment_ordinal
  from segments
  where segments.session_id = p_session_id;

  insert into segments (session_id, segment_ordinal)
  values (p_session_id, v_segment_ordinal)
  returning segments.segment_id into v_segment_id;

  v_closes_at := now() + make_interval(secs => p_duration_seconds);

  insert into quiz_windows (segment_id, closes_at)
  values (v_segment_id, v_closes_at);

  for r in
    select prepared_questions.prepared_question_id, prepared_questions.ordinal,
           prepared_questions.prompt_text, prepared_questions.options,
           prepared_questions.correct_option_index, prepared_questions.points_for_correct
    from prepared_questions
    where prepared_questions.session_id = p_session_id
      and prepared_questions.consumed_at is null
    order by prepared_questions.ordinal
    for update
  loop
    insert into prompts (text)
    values (r.prompt_text)
    returning prompts.prompt_id into v_prompt_id;

    insert into interaction_instances (session_id, segment_id, prompt_id, state, engine_type)
    values (p_session_id, v_segment_id, v_prompt_id, 'PROMPT_ACTIVE', 'MULTIPLE_CHOICE')
    returning interaction_instances.interaction_instance_id into v_interaction_instance_id;

    insert into multiple_choice_details (
      interaction_instance_id, options, correct_option_index, points_for_correct
    )
    values (
      v_interaction_instance_id, r.options, r.correct_option_index, r.points_for_correct
    );

    update prepared_questions
    set consumed_at = now()
    where prepared_questions.prepared_question_id = r.prepared_question_id;

    v_question_count := v_question_count + 1;

    interaction_instance_id := v_interaction_instance_id;
    prompt_id := v_prompt_id;
    ordinal := r.ordinal;
    segment_id := v_segment_id;
    segment_ordinal := v_segment_ordinal;
    closes_at := v_closes_at;
    return next;
  end loop;

  assert v_question_count > 0, 'unreachable: EMPTY_QUIZ_QUESTION_SET should have fired earlier';

  insert into session_events (session_id, event_type, payload)
  values (
    p_session_id,
    'QUIZ_STARTED',
    jsonb_build_object(
      'segmentId', v_segment_id,
      'questionCount', v_question_count,
      'closesAt', v_closes_at
    )
  );

  return;
end;
$$;
