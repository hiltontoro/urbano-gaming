-- Migration: 0136_add_duel_mechanic_key
-- Duel Mechanic Boundary — Narrow Backend Correction (Product/Duel_
-- Architecture.md at gera-os 93be2a7: "Duel Container vs. Mechanic").
--
-- Every Duel so far has implicitly been Multiple Choice, because it
-- was the only mechanic that existed — nothing in the schema ever had
-- to say so. This column makes that explicit and becomes the single
-- source of truth for which mechanic a Duel hosts, the same pattern
-- 0023's own engine_type column already established for
-- interaction_instances when Open Response was, for the same reason,
-- the only engine that had ever existed.
--
-- Additive only: existing rows backfill to 'MULTIPLE_CHOICE' via the
-- column default, which is correct for every row that exists today —
-- start_duel_atomically (0129) has no other mechanic path, and every
-- production Duel row was directly inspected and confirmed to be
-- Multiple Choice before this migration was written. No RPC signature
-- or body changes: start_duel_atomically's existing INSERT never lists
-- mechanic_key, so it receives the default automatically.
--
-- prompt_text/options/correct_option_index remain physically
-- unchanged on this table — they are Multiple Choice's own
-- implementation columns, co-located here for now (Duel_Architecture.
-- md's own "Current MC Columns" disposition: no extraction, no
-- rename, no new side table, until a second mechanic's own Slice
-- provides real requirements to design against).

alter table duels
  add column if not exists mechanic_key text
  not null
  default 'MULTIPLE_CHOICE';

alter table duels
  add constraint duels_mechanic_key_valid_values
  check (mechanic_key in ('MULTIPLE_CHOICE'));
