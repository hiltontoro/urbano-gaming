-- Migration: 0161_create_apply_towers_move_atomically
-- URBANO Towers Slice 001. Commits one already-validated MOVE_TOP_PIECE.
-- Legality (top-of-tower derivation, larger-on-smaller rejection) is
-- validated in the TypeScript domain layer against the CURRENT state it
-- read (applyMove.ts / moveLogic.ts) — deliberately NOT ported into
-- PL/pgSQL, mirroring Rutas' own reasoning: exactly one legitimate
-- writer per attempt, so there is no second independent actor to
-- arbitrate. What this function guarantees instead: (1) the row is
-- locked before anything else, serializing concurrent calls against the
-- same attempt; (2) a repeated idempotency_key short-circuits to the
-- previously-committed result rather than double-applying; (3) a
-- compare-and-swap against p_expected_stacks rejects
-- (TOWERS_STALE_ATTEMPT_STATE) if the row's actual current state no
-- longer matches what the caller validated against — this guards against
-- rapid near-simultaneous submissions computed against the same stale
-- read, not against legality (legality is always derived from the
-- current top of fromTowerId, so staleness alone can never produce an
-- illegal accepted move — only a lost-update race), forcing a
-- re-fetch-and-retry rather than silently overwriting.

create function apply_towers_move_atomically(
  p_attempt_id uuid,
  p_expected_stacks jsonb,
  p_new_stacks jsonb,
  p_from_tower_id text,
  p_to_tower_id text,
  p_piece_rank integer,
  p_completes boolean,
  p_idempotency_key text
)
returns table (
  attempt_id uuid,
  scenario_id text,
  scenario_version integer,
  current_stacks jsonb,
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
  v_current_stacks jsonb;
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
  select towers_attempts.scenario_id, towers_attempts.scenario_version,
         towers_attempts.restart_of_attempt_id, towers_attempts.created_at,
         towers_attempts.outcome, towers_attempts.current_stacks,
         towers_attempts.move_count, towers_attempts.undo_count,
         towers_attempts.started_at, towers_attempts.completed_at
    into v_scenario_id, v_scenario_version, v_restart_of_attempt_id, v_created_at,
         v_outcome, v_current_stacks, v_move_count, v_undo_count, v_started_at, v_completed_at
  from towers_attempts
  where towers_attempts.attempt_id = p_attempt_id
  for update;

  if not found then
    raise exception 'TOWERS_ATTEMPT_NOT_FOUND: no towers attempt exists for this id'
      using errcode = 'P0001';
  end if;

  select towers_attempt_actions.attempt_action_id into v_existing_action_id
  from towers_attempt_actions
  where towers_attempt_actions.attempt_id = p_attempt_id
    and towers_attempt_actions.idempotency_key = p_idempotency_key;

  if v_existing_action_id is not null then
    return query select p_attempt_id, v_scenario_id, v_scenario_version, v_current_stacks,
      v_move_count, v_undo_count, v_restart_of_attempt_id, v_started_at, v_completed_at,
      v_outcome, v_created_at, true;
    return;
  end if;

  if v_outcome <> 'IN_PROGRESS' then
    raise exception 'TOWERS_ATTEMPT_NOT_IN_PROGRESS: this towers attempt is not in progress'
      using errcode = 'P0001';
  end if;

  if v_current_stacks <> p_expected_stacks then
    raise exception 'TOWERS_STALE_ATTEMPT_STATE: this towers attempt has changed since it was last read'
      using errcode = 'P0001';
  end if;

  select coalesce(max(towers_attempt_actions.sequence_number), 0) + 1 into v_next_seq
  from towers_attempt_actions
  where towers_attempt_actions.attempt_id = p_attempt_id;

  insert into towers_attempt_actions (attempt_id, sequence_number, event_type, payload, idempotency_key)
  values (
    p_attempt_id,
    v_next_seq,
    'MOVE',
    jsonb_build_object(
      'fromTowerId', p_from_tower_id,
      'toTowerId', p_to_tower_id,
      'pieceRank', p_piece_rank,
      'previousStacks', v_current_stacks,
      'resultingStacks', p_new_stacks
    ),
    p_idempotency_key
  );

  v_new_started_at := coalesce(v_started_at, now());
  v_new_outcome := case when p_completes then 'COMPLETE' else v_outcome end;
  v_new_completed_at := case when p_completes then now() else v_completed_at end;

  update towers_attempts
  set current_stacks = p_new_stacks,
      move_count = towers_attempts.move_count + 1,
      started_at = v_new_started_at,
      completed_at = v_new_completed_at,
      outcome = v_new_outcome
  where towers_attempts.attempt_id = p_attempt_id;

  return query select p_attempt_id, v_scenario_id, v_scenario_version, p_new_stacks,
    v_move_count + 1, v_undo_count, v_restart_of_attempt_id, v_new_started_at, v_new_completed_at,
    v_new_outcome, v_created_at, false;
end;
$$;
