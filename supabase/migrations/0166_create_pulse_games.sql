-- Migration: 0166_create_pulse_games
-- URBANO Pulse Slice 001 (UG-CR-GATE-002). One row per duel_id — the
-- fast-read current-state header, materialized exactly like
-- rutas_attempts/towers_attempts' own header-table convention
-- (technically re-derivable by replaying pulse_actions, materialized
-- here for read performance only, never a second source of truth).
--
-- current_actor_participant_id/current_deadline are both null while
-- setup is incomplete (game phase SETUP, derived — no separate phase
-- column, mirroring MathDuelSummary's own "phase is derived, not
-- separately persisted" precedent) and are set together, atomically,
-- by the second successful COMMIT_SETUP. current_deadline is the
-- server-authoritative per-turn clock — the CLOSE_QUIZ pattern (see
-- apply_pulse_target_atomically/claim_pulse_timeout_atomically), never
-- client-supplied or client-derived.
--
-- This row is the single serialization point (SELECT ... FOR UPDATE)
-- for every Pulse turn-authority mutation — the same role
-- rutas_attempts/towers_attempts already play for their own games.

create table pulse_games (
  duel_id uuid primary key
    references duels (duel_id) on delete cascade,
  current_actor_participant_id uuid null
    references participants (participant_id),
  current_deadline timestamptz null,
  target_count_a integer not null default 0,
  target_count_b integer not null default 0,
  started_at timestamptz null,
  completed_at timestamptz null,

  constraint pulse_games_target_counts_nonnegative
    check (target_count_a >= 0 and target_count_b >= 0)
);
