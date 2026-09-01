-- Migration: 0157_create_apply_rutas_move_atomically
-- URBANO Rutas Slice 001. Commits one already-validated MOVE. The
-- geometry (footprint sweep, collision, gate-crossing) is validated in
-- the TypeScript domain layer against the CURRENT state it read
-- (applyMove.ts / geometry.ts) — deliberately NOT ported into PL/pgSQL,
-- unlike Poker's rules engine: Rutas has exactly one legitimate writer
-- per attempt, so there is no second independent actor to arbitrate the
-- way Poker's Host+Participant dual-write reality requires. What this
-- function guarantees instead: (1) the row is locked before anything
-- else, serializing concurrent calls against the same attempt; (2) a
-- repeated idempotency_key short-circuits to the previously-committed
-- result rather than double-applying; (3) a compare-and-swap against
-- p_expected_positions rejects (RUTAS_STALE_ATTEMPT_STATE) if the row's
-- actual current state no longer matches what the caller validated
-- against, forcing a re-fetch-and-retry rather than silently overwriting
-- a lost update.

create function apply_rutas_move_atomically(
  p_attempt_id uuid,
  p_expected_positions jsonb,
  p_new_positions jsonb,
  p_piece_id text,
  p_direction text,
  p_distance integer,
  p_cleared boolean,
  p_completes boolean,
  p_idempotency_key text
)
returns table (
  attempt_id uuid,
  scenario_id text,
  scenario_version integer,
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
  v_scenario_id text;
  v_scenario_version integer;
  v_restart_of_attempt_id uuid;
  v_created_at timestamptz;
  v_outcome text;
  v_current_positions jsonb;
  v_move_count integer;
  v_undo_count integer;
  v_started_at timestamptz;
  v_completed_at timestamptz;
  v_existing_action_id uuid;
  v_new_started_at timestamptz;
  v_new_completed_at timestamptz;
  v_new_outcome text;
  v_next_seq integer;
begin
  select rutas_attempts.scenario_id, rutas_attempts.scenario_version,
         rutas_attempts.restart_of_attempt_id, rutas_attempts.created_at,
         rutas_attempts.outcome, rutas_attempts.current_piece_positions,
         rutas_attempts.move_count, rutas_attempts.undo_count,
         rutas_attempts.started_at, rutas_attempts.completed_at
    into v_scenario_id, v_scenario_version, v_restart_of_attempt_id, v_created_at,
         v_outcome, v_current_positions, v_move_count, v_undo_count, v_started_at, v_completed_at
  from rutas_attempts
  where rutas_attempts.attempt_id = p_attempt_id
  for update;

  if not found then
    raise exception 'RUTAS_ATTEMPT_NOT_FOUND: no rutas attempt exists for this id'
      using errcode = 'P0001';
  end if;

  select rutas_attempt_actions.attempt_action_id into v_existing_action_id
  from rutas_attempt_actions
  where rutas_attempt_actions.attempt_id = p_attempt_id
    and rutas_attempt_actions.idempotency_key = p_idempotency_key;

  if v_existing_action_id is not null then
    return query select p_attempt_id, v_scenario_id, v_scenario_version, v_current_positions,
      v_move_count, v_undo_count, v_restart_of_attempt_id, v_started_at, v_completed_at,
      v_outcome, v_created_at, true;
    return;
  end if;

  if v_outcome <> 'IN_PROGRESS' then
    raise exception 'RUTAS_ATTEMPT_NOT_IN_PROGRESS: this rutas attempt is not in progress'
      using errcode = 'P0001';
  end if;

  if v_current_positions <> p_expected_positions then
    raise exception 'RUTAS_STALE_ATTEMPT_STATE: this rutas attempt has changed since it was last read'
      using errcode = 'P0001';
  end if;

  select coalesce(max(rutas_attempt_actions.sequence_number), 0) + 1 into v_next_seq
  from rutas_attempt_actions
  where rutas_attempt_actions.attempt_id = p_attempt_id;

  insert into rutas_attempt_actions (attempt_id, sequence_number, event_type, payload, idempotency_key)
  values (
    p_attempt_id,
    v_next_seq,
    'MOVE',
    jsonb_build_object(
      'pieceId', p_piece_id,
      'direction', p_direction,
      'distance', p_distance,
      'previousPositions', v_current_positions,
      'resultingPositions', p_new_positions,
      'cleared', p_cleared
    ),
    p_idempotency_key
  );

  v_new_started_at := coalesce(v_started_at, now());
  v_new_outcome := case when p_completes then 'COMPLETE' else v_outcome end;
  v_new_completed_at := case when p_completes then now() else v_completed_at end;

  update rutas_attempts
  set current_piece_positions = p_new_positions,
      move_count = rutas_attempts.move_count + 1,
      started_at = v_new_started_at,
      completed_at = v_new_completed_at,
      outcome = v_new_outcome
  where rutas_attempts.attempt_id = p_attempt_id;

  return query select p_attempt_id, v_scenario_id, v_scenario_version, p_new_positions,
    v_move_count + 1, v_undo_count, v_restart_of_attempt_id, v_new_started_at, v_new_completed_at,
    v_new_outcome, v_created_at, false;
end;
$$;
