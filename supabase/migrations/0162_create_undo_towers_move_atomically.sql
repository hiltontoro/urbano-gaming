-- Migration: 0162_create_undo_towers_move_atomically
-- URBANO Towers Slice 001. Single-step Undo — entirely server-derived:
-- takes no client-supplied target, reverses only the immediately
-- preceding action IF it is a MOVE. A second consecutive Undo (most
-- recent action already an UNDO) or an Undo with no prior MOVE at all
-- raises TOWERS_NOTHING_TO_UNDO. Mirrors 0161's own lock-then-
-- idempotency-check shape exactly.

create function undo_towers_move_atomically(
  p_attempt_id uuid,
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
  v_most_recent_type text;
  v_most_recent_seq integer;
  v_most_recent_payload jsonb;
  v_previous_stacks jsonb;
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

  select towers_attempt_actions.event_type, towers_attempt_actions.sequence_number, towers_attempt_actions.payload
    into v_most_recent_type, v_most_recent_seq, v_most_recent_payload
  from towers_attempt_actions
  where towers_attempt_actions.attempt_id = p_attempt_id
  order by towers_attempt_actions.sequence_number desc
  limit 1;

  if v_most_recent_type is null or v_most_recent_type <> 'MOVE' then
    raise exception 'TOWERS_NOTHING_TO_UNDO: there is no move to undo in this towers attempt'
      using errcode = 'P0001';
  end if;

  v_previous_stacks := v_most_recent_payload -> 'previousStacks';

  select coalesce(max(towers_attempt_actions.sequence_number), 0) + 1 into v_next_seq
  from towers_attempt_actions
  where towers_attempt_actions.attempt_id = p_attempt_id;

  insert into towers_attempt_actions (attempt_id, sequence_number, event_type, payload, idempotency_key)
  values (
    p_attempt_id,
    v_next_seq,
    'UNDO',
    jsonb_build_object('undoesSequenceNumber', v_most_recent_seq),
    p_idempotency_key
  );

  update towers_attempts
  set current_stacks = v_previous_stacks,
      undo_count = towers_attempts.undo_count + 1
  where towers_attempts.attempt_id = p_attempt_id;

  return query select p_attempt_id, v_scenario_id, v_scenario_version, v_previous_stacks,
    v_move_count, v_undo_count + 1, v_restart_of_attempt_id, v_started_at, v_completed_at,
    v_outcome, v_created_at, false;
end;
$$;
