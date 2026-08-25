-- Migration: 0147_add_winner_points_to_duels
-- Ordinary Duel Session Scoring Slice 001.
--
-- winner_points is the Session-scoring configuration snapshot captured
-- for this Duel instance — not an intrinsic universal property of
-- "winning a Duel" (mirrors prepared_questions.points_for_correct's own
-- per-instance-configuration relationship to correctness). Defaults to
-- 10, the platform's already-established canonical scoring unit
-- (DEFAULT_POINTS_FOR_CORRECT in prepareQuestions.ts,
-- AWARD_POINTS_QUICK_ACTION_POINTS in host.html).
--
-- No RPC surface reads or writes this column with anything other than
-- its own default in this Slice: start_duel_atomically and
-- start_math_duel_atomically's own INSERT column lists do not mention
-- winner_points, so every Duel this Slice creates gets exactly 10.
-- Deliberately no override parameter is introduced here — a future
-- privileged/orchestrator caller needing a different value is not yet
-- authorized, and this codebase's own established discipline is not to
-- build a seam ahead of the evidence that requires it (see 0128's own
-- migration comment on the identical principle: "a second one is the
-- evidence that would justify extracting a shared substrate, not
-- something to build speculatively ahead of it"). Historical (already-
-- COMPLETED) Duel rows also receive winner_points = 10 as an inert
-- backfill artifact of the NOT NULL DEFAULT — never acted on, since
-- award-writing logic only runs at the moment of a fresh ACTIVE ->
-- COMPLETED transition, which every historical Duel has already
-- passed.

alter table duels
  add column winner_points integer not null default 10;

alter table duels
  add constraint duels_winner_points_positive check (winner_points > 0);
