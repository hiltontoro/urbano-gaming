-- Migration: 0148_add_duel_source_to_point_awards
-- Ordinary Duel Session Scoring Slice 001.
--
-- point_awards.interaction_instance_id was NOT NULL, which made it
-- structurally impossible to record a truthful Duel-sourced award —
-- 0128's own migration comment is explicit that a Duel does not create
-- an interaction_instances row (a real Interaction Instance's own
-- assumptions are not truthful for a two-competitor subgame). Relaxed
-- to nullable and paired with a new duel_id column so a Duel-sourced
-- award has something truthful to reference instead.
--
-- point_awards_source_check enforces exactly one source per row —
-- never both null, never both populated — giving every future reader a
-- direct, single-column provenance signal (duel_id is not null means
-- this award came from a Duel) with no new field needed beyond what
-- correctness itself already requires. Distinguishing a Duel's normal
-- win from a forfeit win, if a reader ever needs that, is already
-- recoverable by joining back to duels.terminal_resolution — the
-- actual source of truth — rather than needing to encode it a second
-- time here.
--
-- Existing rows are unaffected: every one of them already has a
-- non-null interaction_instance_id and a null duel_id (the column
-- default), which already satisfies the new constraint with no
-- backfill required.

alter table point_awards
  alter column interaction_instance_id drop not null;

alter table point_awards
  add column duel_id uuid references duels(duel_id) on delete cascade;

alter table point_awards
  add constraint point_awards_source_check
  check (num_nonnulls(interaction_instance_id, duel_id) = 1);
