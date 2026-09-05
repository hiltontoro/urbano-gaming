-- Migration: 20260904085843_create_race_functions
-- URBANO Race Slice 001 — atomic Race-owned functions.
--
-- Every function here that mutates race_events begins by locking that
-- row (`select ... for update`) BEFORE doing anything else, and every
-- mutating official move/undo invokes Towers' own existing atomic
-- function (0161/0162) as a NESTED SQL call within that SAME PL/pgSQL
-- function body — one Postgres transaction, no HTTP round-trip in
-- between (per UG-CR-REV-020's required transaction boundary). Because
-- a PL/pgSQL function body executes as a single transaction, if
-- anything after the nested Towers call were to fail, the Towers-level
-- mutation would roll back too — Race's own state and the child
-- attempt's state can never diverge from each other.
--
-- Why this makes the earlier (corrected) concurrency defect structurally
-- impossible, not just improbable: competitor B's own request for the
-- SAME race_event_id cannot even begin its own nested Towers call until
-- competitor A's entire transaction (lock, Towers call, evidence,
-- terminalization) has committed and released the lock. There is never
-- a moment where two competitors' underlying Towers transactions are
-- concurrently in flight for the same Race event — so "first to
-- genuinely acquire the lock with an accepted completing move" is not a
-- probabilistic proxy for "first to complete," it IS the authoritative
-- Product-truth ordering UG-CR-REV-020 defines: "the winner is the
-- competitor whose completing move is first accepted through this
-- serialized Race authority."
--
-- CORRECTED per UG-CR-GATE-025 (UG-CR-REV-022's required corrections to
-- UG-CR-RPT-023's candidate). Three substantive defects were found and
-- fixed here, none of which change the Product or the transaction
-- boundary above:
--
--   1. Race-owned idempotency (Correction A). The prior candidate
--      relied entirely on Towers' own per-attempt idempotency_key
--      (derived deterministically from the Race key) for MOVE/UNDO, and
--      had NO idempotency protection at all for CREATE_EVENT or
--      JOIN_EVENT. Two concrete defects followed: a lost-response retry
--      of JOIN_EVENT could consume the OTHER competitor's slot instead
--      of returning the caller's own; and a retry of the exact move
--      that just won the Race, after terminalization, hit the generic
--      "already terminal" rejection instead of replaying the original
--      successful result — because once the event is terminal, Towers
--      is never called again at all (by design, to avoid post-terminal
--      child mutation), so Towers' own idempotency check never had a
--      chance to run for that retry. Every mutating function below now
--      checks the race_event_operations ledger (or, for CREATE, the
--      race_event_creations ledger) FIRST — under the same lock, before
--      any terminal-state rejection or child mutation — and, on a
--      genuine replay (same command, same caller, same payload),
--      returns the ORIGINAL stored result verbatim, regardless of
--      current terminal state. A key reused with a different command,
--      caller, or payload is rejected deterministically
--      (RACE_IDEMPOTENCY_KEY_CONFLICT) rather than silently replayed or
--      silently re-executed. Towers' own idempotency remains in place
--      as defense in depth for the child-level action history, not as
--      the Race-level guarantee.
--
--   2. Timestamp semantics (Correction B). The prior candidate called
--      now() a second time inside apply_race_move_atomically, after the
--      nested Towers call, and treated that second value as if it were
--      a fresh "completion observation instant." It is not: PostgreSQL
--      now()/transaction_timestamp() are fixed at transaction start and
--      do not advance within one transaction, so both calls returned
--      the identical value — the elapsed_ms this produced did not
--      actually measure time elapsed during the nested call at all.
--      Fixed by using two distinctly-named, distinctly-sourced
--      timestamps: v_admission_now (now(), captured once, used for
--      every deadline/admission check — correct semantics, since
--      admission is properly anchored to when this request's
--      transaction began) and v_completion_observed_at
--      (clock_timestamp(), captured fresh immediately after the nested
--      Towers call returns — genuinely current wall-clock time, the
--      only PostgreSQL time source that actually advances within one
--      transaction). The deadline rule itself is unchanged and is
--      evaluated exactly once, against v_admission_now, before the
--      nested call — so a request admitted just under the deadline
--      still wins even if real time crosses the deadline while its own
--      nested Towers call is executing; the observation timestamp is
--      evidence for race_completions, not a second, later admission
--      check that could retroactively overturn it.
--
--   3. Tie truthfulness (Correction C). The prior candidate's
--      opponent-completion comparison branch (intended to resolve a
--      simultaneous-completion tie) could only ever be exercised by
--      directly injecting a fabricated opponent race_completions row in
--      a test — under this function's own real locking, a second
--      unresolved completion can never coexist with an already-recorded
--      one, so no genuine two-competitor execution can reach that
--      branch. Claiming it as validated tie behavior was false. The
--      branch is removed: a genuine completion, while the event is not
--      yet terminal, wins outright — full stop. 'TIE' is removed from
--      race_events' own valid-value constraint (see the events
--      migration) rather than kept as a schema value no code path can
--      produce.
--
-- CORRECTED FURTHER per UG-CR-GATE-026 (UG-CR-REV-023): every
-- `p_idempotency_key` parameter across all five mutating functions
-- (create/join/move/undo/cancel) is now `uuid`, not `text` — the
-- database-type layer of one shared key contract that also has a
-- format check in the browser (public/race.html's own uuid()/
-- isValidIdempotencyKey()) and a stricter regex check in each API
-- route before the repository is ever called. This closes the gap a
-- browser client minting a fresh key on every retry had exposed:
-- UG-CR-RPT-025's own database/ledger correction was sound, but the
-- browser itself never reused one key across a lost-response retry, so
-- the ledger's replay path was provably correct yet never actually
-- exercised by a real user retry. See public/race.html's own pending-
-- operation-envelope comment for the client-side half of this
-- correction — no change to the transaction boundary, Product rules,
-- or any table/column other than the two idempotency_key columns
-- (events migration) and these five parameter types.
--
-- No SECURITY DEFINER anywhere in this migration, matching every
-- existing function in this repository (0 prior uses) and Towers' own
-- precedent (0161/0162 are both `security invoker`): service_role
-- already has full table access via the grants in
-- 20260904085836_create_race_events, so no privilege escalation is
-- needed, and DEFINER would only add risk. Following this repository's
-- own 0126 precedent, EXECUTE is explicitly revoked from
-- PUBLIC/anon/authenticated on every function below immediately after
-- creation; service_role keeps its default EXECUTE grant.
--
-- Scenario content (initialStacks) is TypeScript-owned data
-- (lib/gaming/towers/scenarios.ts) that does not exist in this
-- database — confirm_race_readiness_atomically therefore receives
-- p_initial_stacks as a parameter, computed server-side by the Race API
-- route via Towers' own existing initialStacks() helper, rather than
-- redefining scenario data here.

-- ---------------------------------------------------------------------
-- create_race_event_atomically — CREATE_EVENT, now ledger-backed. A
-- plain insert has no concurrency hazard for a fresh row, but DOES need
-- durable idempotency: a lost-response retry must return the SAME
-- event and organizer credential, never create a second event. The
-- ledger insert is attempted FIRST (claiming the idempotency_key via
-- its own primary key) and only the transaction that wins that claim
-- proceeds to create the actual race_events row — this avoids an
-- orphaned race_events row if two genuinely concurrent calls race with
-- the same client-generated key.
-- ---------------------------------------------------------------------
create function create_race_event_atomically(
  p_idempotency_key uuid,
  p_scenario_id text,
  p_scenario_version integer
)
returns table (
  race_event_id uuid,
  organizer_token text,
  scenario_id text,
  scenario_version integer
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_existing race_event_creations%rowtype;
  v_race_event_id uuid;
  v_organizer_token text;
begin
  v_race_event_id := gen_random_uuid();
  v_organizer_token := gen_random_uuid()::text;

  begin
    insert into race_event_creations
      (idempotency_key, race_event_id, organizer_token, scenario_id, scenario_version)
    values
      (p_idempotency_key, v_race_event_id, v_organizer_token, p_scenario_id, p_scenario_version);
  exception when unique_violation then
    select * into v_existing from race_event_creations
    where race_event_creations.idempotency_key = p_idempotency_key;

    if v_existing.scenario_id <> p_scenario_id or v_existing.scenario_version <> p_scenario_version then
      raise exception 'RACE_IDEMPOTENCY_KEY_CONFLICT: this idempotency key was already used with different parameters'
        using errcode = 'P0001';
    end if;

    return query select v_existing.race_event_id, v_existing.organizer_token,
      v_existing.scenario_id, v_existing.scenario_version;
    return;
  end;

  -- Only reached by the transaction that won the idempotency_key claim above.
  insert into race_events (race_event_id, organizer_token, scenario_id, scenario_version)
  values (v_race_event_id, v_organizer_token, p_scenario_id, p_scenario_version);

  return query select v_race_event_id, v_organizer_token, p_scenario_id, p_scenario_version;
end;
$$;

revoke execute on function create_race_event_atomically(uuid, text, integer) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- join_race_event_atomically — claims the next open competitor slot,
-- now ledger-backed under the event's own lock. A lost-response retry
-- with the same idempotency_key returns the ORIGINAL slot/token without
-- re-entering the slot-assignment logic at all — it can never claim the
-- other slot, because the ledger check happens before that logic runs.
-- ---------------------------------------------------------------------
create function join_race_event_atomically(
  p_race_event_id uuid,
  p_idempotency_key uuid
)
returns table (
  competitor_slot text,
  competitor_token text
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_terminal_resolution text;
  v_competitor_a_token text;
  v_competitor_b_token text;
  v_existing_op race_event_operations%rowtype;
  v_new_token text;
  v_slot text;
begin
  select race_events.terminal_resolution, race_events.competitor_a_token, race_events.competitor_b_token
    into v_terminal_resolution, v_competitor_a_token, v_competitor_b_token
  from race_events
  where race_events.race_event_id = p_race_event_id
  for update;

  if not found then
    raise exception 'RACE_EVENT_NOT_FOUND: no race event exists for this id'
      using errcode = 'P0001';
  end if;

  select * into v_existing_op from race_event_operations
  where race_event_operations.race_event_id = p_race_event_id
    and race_event_operations.idempotency_key = p_idempotency_key;

  if found then
    if v_existing_op.command <> 'JOIN' then
      raise exception 'RACE_IDEMPOTENCY_KEY_CONFLICT: this idempotency key was already used for a different command'
        using errcode = 'P0001';
    end if;
    return query select
      (v_existing_op.result->>'competitor_slot')::text,
      (v_existing_op.result->>'competitor_token')::text;
    return;
  end if;

  if v_terminal_resolution is not null then
    raise exception 'RACE_EVENT_ALREADY_TERMINAL: this race event has already ended'
      using errcode = 'P0001';
  end if;

  v_new_token := gen_random_uuid()::text;

  if v_competitor_a_token is null then
    v_slot := 'A';
    update race_events set competitor_a_token = v_new_token
    where race_events.race_event_id = p_race_event_id;
  elsif v_competitor_b_token is null then
    v_slot := 'B';
    update race_events
    set competitor_b_token = v_new_token,
        second_competitor_assigned_at = now()
    where race_events.race_event_id = p_race_event_id;
  else
    raise exception 'RACE_EVENT_FULL: both competitor slots are already assigned'
      using errcode = 'P0001';
  end if;

  insert into race_event_operations
    (race_event_id, idempotency_key, command, caller_token, payload_fingerprint, result)
  values
    (p_race_event_id, p_idempotency_key, 'JOIN', v_new_token, '',
     jsonb_build_object('competitor_slot', v_slot, 'competitor_token', v_new_token));

  return query select v_slot, v_new_token;
end;
$$;

revoke execute on function join_race_event_atomically(uuid, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- confirm_race_readiness_atomically — marks a competitor ready; when
-- both are ready, schedules the shared three-second countdown and
-- creates both official Towers attempts (a plain insert matching
-- Towers' own createAttempt shape exactly — confirmed via direct
-- repository read that Towers has no dedicated atomic RPC for attempt
-- creation, only for move/undo/restart).
--
-- Relies on NATURAL state idempotency rather than the operations
-- ledger, and this is sufficient: setting an already-true ready flag
-- again is a true no-op, and the one genuine one-time side effect
-- (creating both Towers attempts and scheduling shared_start_at) is
-- gated by `shared_start_at is null`, which becomes permanently false
-- the instant it first fires — so a repeated delivery, from either
-- competitor, can never recreate attempts or reschedule the countdown;
-- it always falls through to returning the already-established result.
-- This satisfies UG-CR-REV-022's own bar for natural idempotency ("only
-- where it returns the same authoritative result and cannot duplicate
-- authority or side effects").
-- ---------------------------------------------------------------------
create function confirm_race_readiness_atomically(
  p_race_event_id uuid,
  p_competitor_token text,
  p_initial_stacks jsonb
)
returns table (
  both_ready boolean,
  shared_start_at timestamptz,
  terminal_resolution text
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row race_events%rowtype;
  v_admission_now timestamptz;
  v_slot text;
  v_start timestamptz;
  v_attempt_a uuid;
  v_attempt_b uuid;
begin
  select * into v_row from race_events
  where race_events.race_event_id = p_race_event_id
  for update;

  if not found then
    raise exception 'RACE_EVENT_NOT_FOUND: no race event exists for this id'
      using errcode = 'P0001';
  end if;

  -- Request/statement timestamp: fixed at transaction start, which is
  -- the correct semantics for an admission/deadline check.
  v_admission_now := now();

  -- Lazy readiness expiry, checked under the same lock before doing
  -- anything else, so it is coherent with a concurrent readiness
  -- confirmation for the same event.
  if v_row.terminal_resolution is null
     and v_row.shared_start_at is null
     and v_row.second_competitor_assigned_at is not null
     and v_admission_now >= v_row.second_competitor_assigned_at + interval '5 minutes'
  then
    update race_events
    set terminal_resolution = 'CANCELLED', terminal_reason = 'READINESS_EXPIRED', ended_at = v_admission_now
    where race_events.race_event_id = p_race_event_id;
    return query select false, null::timestamptz, 'CANCELLED'::text;
    return;
  end if;

  if v_row.terminal_resolution is not null then
    return query select false, v_row.shared_start_at, v_row.terminal_resolution;
    return;
  end if;

  if p_competitor_token = v_row.competitor_a_token then
    v_slot := 'A';
  elsif p_competitor_token = v_row.competitor_b_token then
    v_slot := 'B';
  else
    raise exception 'RACE_INVALID_COMPETITOR_TOKEN: this token does not match a competitor slot on this race event'
      using errcode = 'P0001';
  end if;

  if v_slot = 'A' then
    update race_events set competitor_a_ready = true where race_events.race_event_id = p_race_event_id;
    v_row.competitor_a_ready := true;
  else
    update race_events set competitor_b_ready = true where race_events.race_event_id = p_race_event_id;
    v_row.competitor_b_ready := true;
  end if;

  if v_row.competitor_a_ready and v_row.competitor_b_ready and v_row.shared_start_at is null then
    v_start := v_admission_now + interval '3 seconds';

    insert into towers_attempts (attempt_id, scenario_id, scenario_version, current_stacks, restart_of_attempt_id)
    values (gen_random_uuid(), v_row.scenario_id, v_row.scenario_version, p_initial_stacks, null)
    returning attempt_id into v_attempt_a;

    insert into towers_attempts (attempt_id, scenario_id, scenario_version, current_stacks, restart_of_attempt_id)
    values (gen_random_uuid(), v_row.scenario_id, v_row.scenario_version, p_initial_stacks, null)
    returning attempt_id into v_attempt_b;

    update race_events
    set competitor_a_attempt_id = v_attempt_a,
        competitor_b_attempt_id = v_attempt_b,
        shared_start_at = v_start
    where race_events.race_event_id = p_race_event_id;

    return query select true, v_start, null::text;
    return;
  end if;

  return query select
    (v_row.competitor_a_ready and v_row.competitor_b_ready),
    v_row.shared_start_at,
    null::text;
end;
$$;

revoke execute on function confirm_race_readiness_atomically(uuid, text, jsonb) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- apply_race_move_atomically — the core transaction boundary. Legality
-- (is this move legal against the current state, and what state
-- results) is derived in TypeScript by the caller from Towers' own
-- existing pure validateAndApplyMove()/isComplete() helpers, exactly as
-- Towers' own applyMove.ts already does for its own direct callers —
-- this function does not re-derive or redefine that logic. What this
-- function guarantees is the transaction boundary: the Race event is
-- locked, the operations ledger is checked for an exact replay, the
-- caller's slot/lifecycle/timing are authorized, Towers' own atomic
-- function commits the move under a compare-and-swap guard against the
-- caller's now-possibly-stale expected_stacks, and any resulting
-- terminal transition is recorded — durably, in the ledger, and as
-- race_completions evidence if it completes — before the lock releases.
-- ---------------------------------------------------------------------
create function apply_race_move_atomically(
  p_race_event_id uuid,
  p_competitor_token text,
  p_expected_stacks jsonb,
  p_new_stacks jsonb,
  p_from_tower_id text,
  p_to_tower_id text,
  p_piece_rank integer,
  p_completes boolean,
  p_idempotency_key uuid
)
returns table (
  towers_outcome text,
  current_stacks jsonb,
  move_count integer,
  race_terminal_resolution text,
  race_winner_slot text,
  already_applied boolean
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row race_events%rowtype;
  v_admission_now timestamptz;
  v_completion_observed_at timestamptz;
  v_slot text;
  v_attempt_id uuid;
  v_towers_idempotency_key text;
  v_towers_result record;
  v_elapsed_ms bigint;
  v_existing_op race_event_operations%rowtype;
  v_payload_fingerprint text;
  v_result jsonb;
begin
  select * into v_row from race_events
  where race_events.race_event_id = p_race_event_id
  for update;

  if not found then
    raise exception 'RACE_EVENT_NOT_FOUND: no race event exists for this id'
      using errcode = 'P0001';
  end if;

  -- Request/statement timestamp: fixed at transaction start. Correct
  -- semantics for every admission/deadline check below — admission is
  -- properly anchored to when THIS request's transaction began, and
  -- staying fixed for the whole transaction is exactly what makes the
  -- deadline rule coherent (a request admitted just under the wire
  -- still wins even if real time crosses the deadline while its own
  -- nested Towers call is executing).
  v_admission_now := now();

  -- Slot resolution happens before the ledger check because the ledger
  -- replay itself is validated against the caller — an invalid token
  -- must never even look up, let alone replay, another caller's result.
  if p_competitor_token = v_row.competitor_a_token then
    v_slot := 'A';
  elsif p_competitor_token = v_row.competitor_b_token then
    v_slot := 'B';
  else
    raise exception 'RACE_INVALID_COMPETITOR_TOKEN: this token does not match a competitor slot on this race event'
      using errcode = 'P0001';
  end if;

  v_payload_fingerprint := p_from_tower_id || '>' || p_to_tower_id;

  -- Durable Race-owned idempotency check FIRST — under the same lock,
  -- before any terminal-state rejection or child mutation. This is what
  -- makes a retry of the exact move that already won the Race return
  -- the original successful result instead of a generic terminal
  -- rejection: the ledger row was written before the ORIGINAL call
  -- returned, so it is found here regardless of what race_events.
  -- terminal_resolution has since become.
  select * into v_existing_op from race_event_operations
  where race_event_operations.race_event_id = p_race_event_id
    and race_event_operations.idempotency_key = p_idempotency_key;

  if found then
    if v_existing_op.command <> 'MOVE'
       or v_existing_op.caller_token <> p_competitor_token
       or v_existing_op.payload_fingerprint <> v_payload_fingerprint then
      raise exception 'RACE_IDEMPOTENCY_KEY_CONFLICT: this idempotency key was already used with a different command, caller, or payload'
        using errcode = 'P0001';
    end if;
    return query select
      (v_existing_op.result->>'towers_outcome')::text,
      (v_existing_op.result->'current_stacks')::jsonb,
      (v_existing_op.result->>'move_count')::integer,
      (v_existing_op.result->>'race_terminal_resolution')::text,
      (v_existing_op.result->>'race_winner_slot')::text,
      true;
    return;
  end if;

  -- Lazy running-duration expiry, evaluated once against the admission
  -- timestamp, before anything else — serialized coherently against a
  -- genuinely completing move racing the same deadline.
  if v_row.terminal_resolution is null
     and v_row.shared_start_at is not null
     and v_admission_now >= v_row.shared_start_at + interval '10 minutes'
  then
    update race_events
    set terminal_resolution = 'NO_CONTEST', terminal_reason = 'MAX_DURATION_EXCEEDED', ended_at = v_admission_now
    where race_events.race_event_id = p_race_event_id;
    v_row.terminal_resolution := 'NO_CONTEST';
  end if;

  -- Post-terminal: reject the established result for every genuinely
  -- new (non-replay — already handled above) request. Never touch
  -- Towers once the Race event is already decided; never rewrite the
  -- losing competitor's own last truthful Towers state.
  if v_row.terminal_resolution is not null then
    return query select
      'RACE_EVENT_ALREADY_TERMINAL'::text, null::jsonb, null::integer,
      v_row.terminal_resolution, v_row.winner_slot, false;
    return;
  end if;

  if v_row.shared_start_at is null or v_admission_now < v_row.shared_start_at then
    raise exception 'RACE_NOT_YET_STARTED: this race event has not reached its shared start time'
      using errcode = 'P0001';
  end if;

  v_attempt_id := case when v_slot = 'A' then v_row.competitor_a_attempt_id else v_row.competitor_b_attempt_id end;
  if v_attempt_id is null then
    raise exception 'RACE_ATTEMPT_NOT_ASSIGNED: no official attempt is associated with this competitor slot'
      using errcode = 'P0001';
  end if;

  -- Towers-level idempotency remains as defense in depth, independent
  -- of and secondary to the Race-level ledger above.
  v_towers_idempotency_key := 'race:' || p_race_event_id::text || ':' || p_idempotency_key::text;

  select * into v_towers_result
  from apply_towers_move_atomically(
    v_attempt_id, p_expected_stacks, p_new_stacks, p_from_tower_id, p_to_tower_id,
    p_piece_rank, p_completes, v_towers_idempotency_key
  );

  -- Completion-observation timestamp: clock_timestamp(), captured fresh
  -- right now — genuinely current wall-clock time, unlike now() above,
  -- which stayed fixed at transaction start throughout this whole call.
  v_completion_observed_at := clock_timestamp();

  if v_towers_result.outcome = 'COMPLETE' and not v_towers_result.already_applied then
    -- The first (and, under this function's own row lock, only)
    -- genuine completion wins outright. No opponent-comparison branch:
    -- under strict serialization a second unresolved completion cannot
    -- coexist with this one (see this migration's own header comment)
    -- — TIE is not a reachable outcome in this Slice, not fabricated
    -- here defensively for a case that cannot occur.
    v_elapsed_ms := greatest(0, floor(extract(epoch from (v_completion_observed_at - v_row.shared_start_at)) * 1000));

    insert into race_completions
      (race_event_id, competitor_slot, race_observed_completed_at, towers_completed_at, towers_move_count, elapsed_ms)
    values
      (p_race_event_id, v_slot, v_completion_observed_at, v_towers_result.completed_at, v_towers_result.move_count, v_elapsed_ms);

    update race_events
    set terminal_resolution = 'WON_LOST', winner_slot = v_slot,
        terminal_reason = 'COMPLETED_FIRST', ended_at = v_completion_observed_at
    where race_events.race_event_id = p_race_event_id;

    v_result := jsonb_build_object(
      'towers_outcome', v_towers_result.outcome,
      'current_stacks', v_towers_result.current_stacks,
      'move_count', v_towers_result.move_count,
      'race_terminal_resolution', 'WON_LOST',
      'race_winner_slot', v_slot
    );
  else
    v_result := jsonb_build_object(
      'towers_outcome', v_towers_result.outcome,
      'current_stacks', v_towers_result.current_stacks,
      'move_count', v_towers_result.move_count,
      'race_terminal_resolution', null,
      'race_winner_slot', null
    );
  end if;

  -- Durable ledger write BEFORE returning — including for an ordinary,
  -- non-completing move, so "an ordinary retry returns the original
  -- board/result without another Towers action" holds for every move,
  -- not only the completing one.
  insert into race_event_operations
    (race_event_id, idempotency_key, command, caller_token, payload_fingerprint, result)
  values
    (p_race_event_id, p_idempotency_key, 'MOVE', p_competitor_token, v_payload_fingerprint, v_result);

  return query select
    (v_result->>'towers_outcome')::text,
    (v_result->'current_stacks')::jsonb,
    (v_result->>'move_count')::integer,
    (v_result->>'race_terminal_resolution')::text,
    (v_result->>'race_winner_slot')::text,
    false;
end;
$$;

revoke execute on function apply_race_move_atomically(uuid, text, jsonb, jsonb, text, text, integer, boolean, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- apply_race_undo_atomically — same lock/ledger/authorization/timing
-- shape as move, nested-calling Towers' own undo_towers_move_atomically.
-- Undo can never itself be a completing transition, so there is no
-- terminalization branch and no completion-observation timestamp.
-- ---------------------------------------------------------------------
create function apply_race_undo_atomically(
  p_race_event_id uuid,
  p_competitor_token text,
  p_idempotency_key uuid
)
returns table (
  towers_outcome text,
  current_stacks jsonb,
  move_count integer,
  undo_count integer,
  race_terminal_resolution text,
  already_applied boolean
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row race_events%rowtype;
  v_admission_now timestamptz;
  v_slot text;
  v_attempt_id uuid;
  v_towers_idempotency_key text;
  v_towers_result record;
  v_existing_op race_event_operations%rowtype;
  v_result jsonb;
begin
  select * into v_row from race_events
  where race_events.race_event_id = p_race_event_id
  for update;

  if not found then
    raise exception 'RACE_EVENT_NOT_FOUND: no race event exists for this id'
      using errcode = 'P0001';
  end if;

  v_admission_now := now();

  if p_competitor_token = v_row.competitor_a_token then
    v_slot := 'A';
  elsif p_competitor_token = v_row.competitor_b_token then
    v_slot := 'B';
  else
    raise exception 'RACE_INVALID_COMPETITOR_TOKEN: this token does not match a competitor slot on this race event'
      using errcode = 'P0001';
  end if;

  select * into v_existing_op from race_event_operations
  where race_event_operations.race_event_id = p_race_event_id
    and race_event_operations.idempotency_key = p_idempotency_key;

  if found then
    if v_existing_op.command <> 'UNDO' or v_existing_op.caller_token <> p_competitor_token then
      raise exception 'RACE_IDEMPOTENCY_KEY_CONFLICT: this idempotency key was already used with a different command or caller'
        using errcode = 'P0001';
    end if;
    return query select
      (v_existing_op.result->>'towers_outcome')::text,
      (v_existing_op.result->'current_stacks')::jsonb,
      (v_existing_op.result->>'move_count')::integer,
      (v_existing_op.result->>'undo_count')::integer,
      null::text, true;
    return;
  end if;

  if v_row.terminal_resolution is null
     and v_row.shared_start_at is not null
     and v_admission_now >= v_row.shared_start_at + interval '10 minutes'
  then
    update race_events
    set terminal_resolution = 'NO_CONTEST', terminal_reason = 'MAX_DURATION_EXCEEDED', ended_at = v_admission_now
    where race_events.race_event_id = p_race_event_id;
    v_row.terminal_resolution := 'NO_CONTEST';
  end if;

  if v_row.terminal_resolution is not null then
    return query select 'RACE_EVENT_ALREADY_TERMINAL'::text, null::jsonb, null::integer, null::integer, v_row.terminal_resolution, false;
    return;
  end if;

  if v_row.shared_start_at is null or v_admission_now < v_row.shared_start_at then
    raise exception 'RACE_NOT_YET_STARTED: this race event has not reached its shared start time'
      using errcode = 'P0001';
  end if;

  v_attempt_id := case when v_slot = 'A' then v_row.competitor_a_attempt_id else v_row.competitor_b_attempt_id end;
  if v_attempt_id is null then
    raise exception 'RACE_ATTEMPT_NOT_ASSIGNED: no official attempt is associated with this competitor slot'
      using errcode = 'P0001';
  end if;

  v_towers_idempotency_key := 'race:' || p_race_event_id::text || ':' || p_idempotency_key::text;

  select * into v_towers_result
  from undo_towers_move_atomically(v_attempt_id, v_towers_idempotency_key);

  v_result := jsonb_build_object(
    'towers_outcome', v_towers_result.outcome,
    'current_stacks', v_towers_result.current_stacks,
    'move_count', v_towers_result.move_count,
    'undo_count', v_towers_result.undo_count
  );

  insert into race_event_operations
    (race_event_id, idempotency_key, command, caller_token, payload_fingerprint, result)
  values
    (p_race_event_id, p_idempotency_key, 'UNDO', p_competitor_token, '', v_result);

  return query select
    (v_result->>'towers_outcome')::text,
    (v_result->'current_stacks')::jsonb,
    (v_result->>'move_count')::integer,
    (v_result->>'undo_count')::integer,
    null::text, false;
end;
$$;

revoke execute on function apply_race_undo_atomically(uuid, text, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- request_race_cancellation_atomically — organizer free pre-countdown
-- cancellation, or mutual two-sided competitor agreement once the
-- countdown has been scheduled. No independent administrative
-- cancellation surface in Slice 001 (per Final Founder Parameters).
-- Ledger-backed like move/undo: a retry of a competitor's own
-- cancellation request (pending or already-mutual) replays the exact
-- original response rather than re-deriving current state, so a retry
-- cannot duplicate evidence or (for the organizer's own pre-countdown
-- path) re-run the cancellation transition a second time.
-- ---------------------------------------------------------------------
create function request_race_cancellation_atomically(
  p_race_event_id uuid,
  p_caller_token text,
  p_idempotency_key uuid
)
returns table (
  terminal_resolution text,
  cancel_pending boolean
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row race_events%rowtype;
  v_admission_now timestamptz;
  v_existing_op race_event_operations%rowtype;
  v_result jsonb;
begin
  select * into v_row from race_events
  where race_events.race_event_id = p_race_event_id
  for update;

  if not found then
    raise exception 'RACE_EVENT_NOT_FOUND: no race event exists for this id'
      using errcode = 'P0001';
  end if;

  v_admission_now := now();

  select * into v_existing_op from race_event_operations
  where race_event_operations.race_event_id = p_race_event_id
    and race_event_operations.idempotency_key = p_idempotency_key;

  if found then
    if v_existing_op.command <> 'CANCEL' or v_existing_op.caller_token <> p_caller_token then
      raise exception 'RACE_IDEMPOTENCY_KEY_CONFLICT: this idempotency key was already used with a different command or caller'
        using errcode = 'P0001';
    end if;
    return query select
      (v_existing_op.result->>'terminal_resolution')::text,
      (v_existing_op.result->>'cancel_pending')::boolean;
    return;
  end if;

  if v_row.terminal_resolution is null
     and v_row.shared_start_at is not null
     and v_admission_now >= v_row.shared_start_at + interval '10 minutes'
  then
    update race_events
    set terminal_resolution = 'NO_CONTEST', terminal_reason = 'MAX_DURATION_EXCEEDED', ended_at = v_admission_now
    where race_events.race_event_id = p_race_event_id;
    v_row.terminal_resolution := 'NO_CONTEST';
  end if;

  if v_row.terminal_resolution is not null then
    return query select v_row.terminal_resolution, false;
    return;
  end if;

  if p_caller_token = v_row.organizer_token then
    if v_row.shared_start_at is null then
      update race_events
      set terminal_resolution = 'CANCELLED', terminal_reason = 'ORGANIZER_CANCELLED_PRE_COUNTDOWN', ended_at = v_admission_now
      where race_events.race_event_id = p_race_event_id;
      v_result := jsonb_build_object('terminal_resolution', 'CANCELLED', 'cancel_pending', false);
    else
      raise exception 'RACE_ORGANIZER_CANNOT_CANCEL_AFTER_COUNTDOWN: cancellation after the countdown is scheduled requires both competitors'' agreement'
        using errcode = 'P0001';
    end if;
  elsif p_caller_token = v_row.competitor_a_token then
    update race_events set competitor_a_cancel_requested = true where race_events.race_event_id = p_race_event_id;
    v_row.competitor_a_cancel_requested := true;
  elsif p_caller_token = v_row.competitor_b_token then
    update race_events set competitor_b_cancel_requested = true where race_events.race_event_id = p_race_event_id;
    v_row.competitor_b_cancel_requested := true;
  else
    raise exception 'RACE_INVALID_CALLER_TOKEN: this token does not match any role on this race event'
      using errcode = 'P0001';
  end if;

  if v_result is null then
    if v_row.competitor_a_cancel_requested and v_row.competitor_b_cancel_requested then
      update race_events
      set terminal_resolution = 'CANCELLED', terminal_reason = 'MUTUAL_LIVE_CANCELLATION', ended_at = v_admission_now
      where race_events.race_event_id = p_race_event_id;
      v_result := jsonb_build_object('terminal_resolution', 'CANCELLED', 'cancel_pending', false);
    else
      v_result := jsonb_build_object('terminal_resolution', null, 'cancel_pending', true);
    end if;
  end if;

  insert into race_event_operations
    (race_event_id, idempotency_key, command, caller_token, payload_fingerprint, result)
  values
    (p_race_event_id, p_idempotency_key, 'CANCEL', p_caller_token, '', v_result);

  return query select
    (v_result->>'terminal_resolution')::text,
    (v_result->>'cancel_pending')::boolean;
end;
$$;

revoke execute on function request_race_cancellation_atomically(uuid, text, uuid) from public, anon, authenticated;

-- ---------------------------------------------------------------------
-- get_race_event_projection_atomically — the read path. Locks the row
-- (consistent with "serializes ... reads that enact lazy expiry ...
-- coherently") so a reload/poll that discovers an expired readiness or
-- running window actually enacts and returns that terminal transition,
-- rather than only reporting a deadline for the client to infer from.
-- A pure read with server-enacted lazy expiry is naturally idempotent
-- (the expiry transition is gated by terminal_resolution is null, fires
-- at most once, same as every other lazy-expiry check in this
-- migration) — no client-supplied idempotency key applies to a read.
-- ---------------------------------------------------------------------
create function get_race_event_projection_atomically(
  p_race_event_id uuid
)
returns setof race_events
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_row race_events%rowtype;
  v_admission_now timestamptz;
begin
  select * into v_row from race_events
  where race_events.race_event_id = p_race_event_id
  for update;

  if not found then
    return;
  end if;

  v_admission_now := now();

  if v_row.terminal_resolution is null then
    if v_row.shared_start_at is not null and v_admission_now >= v_row.shared_start_at + interval '10 minutes' then
      update race_events
      set terminal_resolution = 'NO_CONTEST', terminal_reason = 'MAX_DURATION_EXCEEDED', ended_at = v_admission_now
      where race_events.race_event_id = p_race_event_id
      returning * into v_row;
    elsif v_row.shared_start_at is null
          and v_row.second_competitor_assigned_at is not null
          and v_admission_now >= v_row.second_competitor_assigned_at + interval '5 minutes'
    then
      update race_events
      set terminal_resolution = 'CANCELLED', terminal_reason = 'READINESS_EXPIRED', ended_at = v_admission_now
      where race_events.race_event_id = p_race_event_id
      returning * into v_row;
    end if;
  end if;

  return next v_row;
end;
$$;

revoke execute on function get_race_event_projection_atomically(uuid) from public, anon, authenticated;
