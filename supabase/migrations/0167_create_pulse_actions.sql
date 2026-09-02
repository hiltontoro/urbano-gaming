-- Migration: 0167_create_pulse_actions
-- URBANO Pulse Slice 001 (UG-CR-GATE-002). Append-only evidence: one
-- row per accepted TARGET_CELL attempt (never for a rejected/illegal
-- attempt, and never for a timeout-forfeit resolution — that path is
-- recorded as an ordinary DUEL_RESOLVED session_event only, mirroring
-- how Host VOID/CANCELLED already works via 0135/resolveDuelExceptionally
-- with no dedicated action-table row of its own).
--
-- unique(duel_id, idempotency_key) is the real, DB-level idempotency
-- guarantee: a duplicate/retried target submission — including a retry
-- of the exact target that completed the Duel — can never insert a
-- second row (the mandatory Towers lesson, applied from the start
-- here). unique(duel_id, sequence_number) preserves the same
-- chronological-evidence-stream discipline Rutas/Towers already
-- established, computed under the pulse_games row lock so no race
-- exists.
--
-- One row per attacker action against the opponent's board — a
-- completed-form result is still exactly one row (completed_form_id
-- populated), never a second fragment event, per the "reject
-- unnecessary event fragmentation" discipline already established for
-- Rutas/Towers.

create table pulse_actions (
  pulse_action_id uuid primary key default gen_random_uuid(),
  duel_id uuid not null
    references duels (duel_id) on delete cascade,
  sequence_number integer not null,
  actor_participant_id uuid not null
    references participants (participant_id),
  cell_row integer not null,
  cell_col integer not null,
  result text not null
    check (result in ('MISS', 'HIT', 'HIT_COMPLETED_FORM')),
  completed_form_id text null,
  idempotency_key text not null,
  created_at timestamptz not null default now(),

  constraint pulse_actions_cell_row_in_bounds check (cell_row >= 0 and cell_row <= 7),
  constraint pulse_actions_cell_col_in_bounds check (cell_col >= 0 and cell_col <= 7),
  constraint pulse_actions_sequence_unique unique (duel_id, sequence_number),
  constraint pulse_actions_idempotency_unique unique (duel_id, idempotency_key)
);

create index pulse_actions_duel_id_idx on pulse_actions (duel_id);
