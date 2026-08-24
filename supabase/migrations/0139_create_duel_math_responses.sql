-- Migration: 0139_create_duel_math_responses
-- Math Duel Slice 001.
--
-- One row per (challenge, competitor) — deliberately NOT an upsert
-- target the way duel_responses (0128) is for Multiple Choice.
-- Math Duel's own Product Definition requires first-successful-write
-- finality, never editing (implementation-readiness §8): the primary
-- key itself is the idempotency mechanism — a genuine retry inserts
-- nothing new and the caller is served the already-recorded row back;
-- a second call carrying a different value is never applied over the
-- first, by construction, since there is no UPDATE path.
--
-- The composite foreign key to duel_math_challenges (rather than a
-- plain duel_id FK) is real, enforced referential integrity: an
-- answer can never be recorded against a challenge_ordinal that was
-- never actually selected for this Duel.
--
-- is_correct is computed once, at write time, by comparing against
-- duel_math_challenges.correct_answer — never recomputed later, and
-- correct_answer itself is never re-derived from this table.

create table duel_math_responses (
  duel_id uuid not null,
  challenge_ordinal integer not null,
  participant_id uuid not null
    references participants(participant_id) on delete cascade,
  submitted_answer integer not null,
  is_correct boolean not null,
  answered_at timestamptz not null default now(),

  primary key (duel_id, challenge_ordinal, participant_id),
  foreign key (duel_id, challenge_ordinal)
    references duel_math_challenges (duel_id, challenge_ordinal) on delete cascade
);

create index duel_math_responses_duel_id_idx on duel_math_responses (duel_id);
