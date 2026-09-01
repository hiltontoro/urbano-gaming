-- Migration: 0160_create_towers_attempts
-- URBANO Towers Slice 001 — BOUNDED_GAME_RUNTIME, not a Session
-- capability and not a Poker-style Dedicated Experience: exactly one
-- legitimate writer per attempt, no Host, no Participant, no room code,
-- no Room Registry involvement (see the Towers Founder Product
-- Definition Gate and Slice 001 Implementation gate history). Scenarios
-- are code-owned curated content — never stored here, never
-- player-authored, never procedurally generated; only the runtime
-- ATTEMPT state (one player's progress through a scenario) is persisted.
--
-- Same two-table shape as rutas_attempts/rutas_attempt_actions (itself
-- mirroring poker_hand_actions' precedent): an append-only actions table
-- with a genuine unique(attempt_id, idempotency_key) constraint gives a
-- real DB-level idempotency guarantee rather than scanning a JSONB array
-- inside a stored procedure.

create table towers_attempts (
  attempt_id uuid primary key default gen_random_uuid(),
  scenario_id text not null,
  scenario_version integer not null,
  current_stacks jsonb not null,
  move_count integer not null default 0,
  undo_count integer not null default 0,
  restart_of_attempt_id uuid null references towers_attempts (attempt_id),
  started_at timestamptz null,
  completed_at timestamptz null,
  outcome text not null default 'IN_PROGRESS',
  created_at timestamptz not null default now(),

  constraint towers_attempts_outcome_valid
    check (outcome in ('IN_PROGRESS', 'COMPLETE', 'ABANDONED')),
  constraint towers_attempts_move_count_nonnegative check (move_count >= 0),
  constraint towers_attempts_undo_count_nonnegative check (undo_count >= 0)
);

-- Append-only action history: one row per MOVE/UNDO/RESTART. Undo is
-- derived entirely from the most recent MOVE row here (see
-- undo_towers_move_atomically, 0162) — no client-supplied target is ever
-- trusted for what to reverse.
create table towers_attempt_actions (
  attempt_action_id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references towers_attempts (attempt_id) on delete cascade,
  sequence_number integer not null,
  event_type text not null,
  payload jsonb not null,
  idempotency_key text not null,
  created_at timestamptz not null default now(),

  constraint towers_attempt_actions_event_type_valid
    check (event_type in ('MOVE', 'UNDO', 'RESTART')),
  constraint towers_attempt_actions_sequence_unique unique (attempt_id, sequence_number),
  -- The real atomicity/idempotency guarantee: a duplicate submission
  -- (network retry, double-tap) with the same idempotency_key can never
  -- insert a second action row for this attempt.
  constraint towers_attempt_actions_idempotency_unique unique (attempt_id, idempotency_key)
);

create index towers_attempt_actions_attempt_id_idx on towers_attempt_actions (attempt_id);
