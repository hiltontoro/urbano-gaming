-- Migration: 0146_replace_duel_math_challenges_played_with_reached_view
-- Math Duel Slice 001 — Pre-Deployment Product-Invariant Correction.
--
-- 0142's own duel_math_challenges_played view defined "played" as "has
-- at least one duel_math_responses row" — truthful under 0140/0141's
-- pre-materialized-reserve design (where an activated-but-unanswered
-- challenge could not yet arise, since normal play always produces a
-- response once a challenge is reached, and the only surplus rows
-- were the untouched reserve nobody had been authorized into at all),
-- but not truthful in general: a challenge genuinely shown to
-- competitors and then cut short by Cancel/Void/Forfeit before either
-- answered would be misclassified as never having happened. With
-- 0143's activated_at and 0144/0145's lazy sudden-death creation, "was
-- this challenge actually reached" now has a real, direct, non-
-- derived answer that does not depend on a response ever having been
-- recorded — replacing this view rather than layering a second one
-- alongside it, since the response-based definition was simply wrong,
-- not a valid alternate cut.
--
-- Dropped and recreated rather than edited in place: 0142 was already
-- committed as its own historical migration (Final Local Acceptance
-- gate) and stays untouched, an honest record of what was tried and
-- superseded — this repository's own "migrations are append-only"
-- discipline, applied here even though nothing in this Slice has been
-- deployed anywhere yet.

drop view duel_math_challenges_played;

create view duel_math_challenges_reached as
select *
from duel_math_challenges
where activated_at is not null;
