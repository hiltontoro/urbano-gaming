-- Migration: 0159_create_restart_rutas_attempt_atomically
-- URBANO Rutas Slice 001. Creates a NEW attempt rather than resetting
-- the old one in place. The old attempt is finalized ABANDONED only if
-- it was still IN_PROGRESS — a COMPLETE attempt is left COMPLETE forever
-- (restarting after a win is "play again," not un-winning); an already
-- ABANDONED attempt cannot be restarted again (it has already been
-- superseded — the caller should be restarting its successor, not it).
-- Idempotency is scoped to the OLD attempt's own action history: a
-- repeated call with the same idempotency_key returns the SAME successor
-- attempt rather than creating a second one.

create function restart_rutas_attempt_atomically(
  p_old_attempt_id uuid,
  p_new_attempt_id uuid,
  p_scenario_id text,
  p_scenario_version integer,
  p_initial_positions jsonb,
  p_idempotency_key text
)
returns table (
  new_attempt_id uuid,
  abandoned_attempt_id uuid,
  current_piece_positions jsonb,
  move_count integer,
  undo_count integer,
  restart_of_attempt_id uuid,
  started_at timestamptz,
  completed_at timestamptz,
  outcome text,
  created_at timestamptz,
  already_applied boolean
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_old_outcome text;
  v_existing_action_id uuid;
  v_existing_payload jsonb;
  v_successor_id uuid;
  v_next_seq integer;
  v_created_at timestamptz;
begin
  select rutas_attempts.outcome into v_old_outcome
  from rutas_attempts
  where rutas_attempts.attempt_id = p_old_attempt_id
  for update;

  if not found then
    raise exception 'RUTAS_ATTEMPT_NOT_FOUND: no rutas attempt exists for this id'
      using errcode = 'P0001';
  end if;

  select rutas_attempt_actions.attempt_action_id, rutas_attempt_actions.payload
    into v_existing_action_id, v_existing_payload
  from rutas_attempt_actions
  where rutas_attempt_actions.attempt_id = p_old_attempt_id
    and rutas_attempt_actions.idempotency_key = p_idempotency_key;

  if v_existing_action_id is not null then
    v_successor_id := (v_existing_payload ->> 'successorAttemptId')::uuid;
    return query
      select v_successor_id, p_old_attempt_id,
             rutas_attempts.current_piece_positions, rutas_attempts.move_count,
             rutas_attempts.undo_count, rutas_attempts.restart_of_attempt_id,
             rutas_attempts.started_at, rutas_attempts.completed_at,
             rutas_attempts.outcome, rutas_attempts.created_at, true
      from rutas_attempts
      where rutas_attempts.attempt_id = v_successor_id;
    return;
  end if;

  if v_old_outcome = 'ABANDONED' then
    raise exception 'RUTAS_ATTEMPT_ALREADY_ABANDONED: this rutas attempt has already been superseded'
      using errcode = 'P0001';
  end if;

  if v_old_outcome = 'IN_PROGRESS' then
    update rutas_attempts set outcome = 'ABANDONED'
    where rutas_attempts.attempt_id = p_old_attempt_id;
  end if;

  select coalesce(max(rutas_attempt_actions.sequence_number), 0) + 1 into v_next_seq
  from rutas_attempt_actions
  where rutas_attempt_actions.attempt_id = p_old_attempt_id;

  insert into rutas_attempt_actions (attempt_id, sequence_number, event_type, payload, idempotency_key)
  values (
    p_old_attempt_id, v_next_seq, 'RESTART',
    jsonb_build_object('successorAttemptId', p_new_attempt_id),
    p_idempotency_key
  );

  v_created_at := now();
  insert into rutas_attempts (
    attempt_id, scenario_id, scenario_version, current_piece_positions,
    move_count, undo_count, restart_of_attempt_id, started_at, completed_at, outcome, created_at
  )
  values (
    p_new_attempt_id, p_scenario_id, p_scenario_version, p_initial_positions,
    0, 0, p_old_attempt_id, null, null, 'IN_PROGRESS', v_created_at
  );

  return query select
    p_new_attempt_id, p_old_attempt_id, p_initial_positions, 0, 0,
    p_old_attempt_id, null::timestamptz, null::timestamptz, 'IN_PROGRESS', v_created_at, false;
end;
$$;
