-- Migration: 0142_create_duel_math_challenges_played_view
-- Math Duel Slice 001 — Final Local Acceptance correction.
--
-- start_math_duel_atomically (0140) pre-materializes the entire
-- challenge supply a Duel could ever need — 5 standard plus a full
-- sudden-death reserve — as immutable duel_math_challenges rows, all
-- at Duel creation. That is a deliberate implementation-time
-- simplification (0141's own comment: it turns "enter sudden death"
-- into a pure read, eliminating a whole class of mid-Duel insert
-- concurrency). Its honest cost: a raw duel_math_challenges row does
-- NOT mean "this was shown to a participant" — a typical completed
-- Duel leaves dozens of never-asked reserve rows behind alongside the
-- handful that were actually played. GET_SESSION's own read-model
-- (getSession.ts) already reconstructs the correct distinction today,
-- by joining against duel_math_responses — but that logic lives only
-- in application code, one layer above this table. Any future direct
-- consumer of duel_math_challenges (a Game History or export feature
-- is real, named roadmap interest — see the Poker Founder Playtest
-- Evidence classification) could trivially get this wrong and present
-- unplayed reserve content as if it were part of the match.
--
-- This view makes the same distinction a first-class, self-evident
-- schema fact instead of tribal knowledge that only getSession.ts
-- happens to encode correctly: a challenge is "played" the moment any
-- response was ever recorded for it — an unambiguous signal (the
-- composite FK from duel_math_responses guarantees no response can
-- exist for a challenge that was never actually selected), and, given
-- this table's own strictly-sequential, no-skipping authorization
-- invariant, is exactly equivalent to "at or below the highest
-- ordinal either competitor ever reached" — the same rule
-- getSession.ts's own maxAnsweredOrdinal filter already implements.
--
-- Purely additive, read-only DDL: no existing RPC, repository method,
-- or test is touched or needs to be. Nothing currently queries this
-- view — it exists so a correct-by-construction answer is already
-- there, in the schema itself, before anything is ever built against
-- it.

create view duel_math_challenges_played as
select dmc.*
from duel_math_challenges dmc
where exists (
  select 1
  from duel_math_responses dmr
  where dmr.duel_id = dmc.duel_id
    and dmr.challenge_ordinal = dmc.challenge_ordinal
);
