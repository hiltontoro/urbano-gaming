-- Migration: 0143_add_activated_at_to_duel_math_challenges
-- Math Duel Slice 001 — Pre-Deployment Product-Invariant Correction.
--
-- The genuinely new, non-derivable evidence this correction needs:
-- when did this challenge first become authorized/presented to a
-- competitor, independent of whether anyone ever answered it. A
-- response's own existence already tells the "answered" story
-- (duel_math_responses); it cannot tell the "was shown before the
-- Duel was exceptionally cut short" story for a challenge nobody got
-- to answer — see 0145's own migration comment for the exact
-- Cancel/Void/Forfeit-before-response case this closes.
--
-- Nullable: a challenge row can exist for a brief instant before
-- activation is recorded (see 0144/0145 — both set it in the same
-- statement/transaction that makes the row relevant, so in practice
-- this is never observably null for long, but the column itself
-- carries no invented default).

alter table duel_math_challenges
  add column activated_at timestamptz null;
