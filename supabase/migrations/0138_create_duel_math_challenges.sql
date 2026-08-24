-- Migration: 0138_create_duel_math_challenges
-- Math Duel Slice 001.
--
-- One row per challenge actually selected for a specific Math Duel —
-- an immutable, authoritative snapshot, never a reference into a
-- reusable content bank. No such bank exists yet (Slice 001 uses a
-- code-owned deterministic fixture, per implementation-readiness
-- §3/§7) — this table's own correctness does not depend on that
-- fixture ever staying the same: the actual selected question_text
-- and correct_answer are persisted here, once, at selection time,
-- exactly mirroring poker_hands.deck_order's own "persist the
-- authoritative outcome, not a regenerable recipe" precedent.
--
-- challenge_ordinal is strictly increasing across BOTH phases for one
-- Duel — 1-5 are the standard phase (all created together at Duel
-- start, so both competitors receive the identical set/order
-- immediately); 6+ are sudden-death rounds, created one at a time,
-- lazily, only once actually needed.
--
-- No UPDATE/DELETE path exists through any application command — see
-- MATH_DUEL_IMPLEMENTATION_RECORD.md's own honest immutability-tier
-- classification: this is application-layer discipline, the same tier
-- every other history table in this schema already relies on (no
-- DELETE exists anywhere in the Duel or Poker modules), not a new
-- database-level enforcement mechanism invented for this table alone.

create table duel_math_challenges (
  duel_id uuid not null
    references duels(duel_id) on delete cascade,
  challenge_ordinal integer not null,
  phase text not null
    check (phase in ('STANDARD', 'SUDDEN_DEATH')),
  question_text text not null,
  correct_answer integer not null,
  created_at timestamptz not null default now(),

  primary key (duel_id, challenge_ordinal),
  check (challenge_ordinal >= 1)
);

create index duel_math_challenges_duel_id_idx on duel_math_challenges (duel_id);
