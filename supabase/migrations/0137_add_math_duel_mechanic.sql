-- Migration: 0137_add_math_duel_mechanic
-- Math Duel Slice 001 (Product/Duel_Architecture.md's "Duel Container
-- vs. Mechanic" boundary; MATH_DUEL_IMPLEMENTATION_RECORD.md).
--
-- Two independent, additive changes to the existing duels table, both
-- required before a second mechanic can create a row:
--
-- 1. Widen mechanic_key's own CHECK constraint (0136) to also accept
--    'MATH_DUEL'. Still a small, code-owned, Product-defined
--    vocabulary — no registry table, no dynamic values.
--
-- 2. Relax prompt_text/options/correct_option_index from NOT NULL to
--    nullable. These are Multiple Choice's own mechanic-owned columns
--    (0128's own comment: "co-located here for now... until a second
--    mechanic's own Slice provides real requirements to design
--    against" — this is that Slice). A Math Duel row leaves all three
--    null; nothing about this migration touches, rewrites, or moves
--    any existing row's already-populated values — every Multiple
--    Choice Duel in production stays byte-for-byte exactly as it is.
--    Explicitly the smaller of the two options pressure-tested during
--    implementation readiness (nullable columns vs. extracting MC
--    content into its own side table) — no data movement, no risk to
--    existing evidence.

alter table duels
  drop constraint duels_mechanic_key_valid_values;

alter table duels
  add constraint duels_mechanic_key_valid_values
  check (mechanic_key in ('MULTIPLE_CHOICE', 'MATH_DUEL'));

alter table duels
  alter column prompt_text drop not null,
  alter column options drop not null,
  alter column correct_option_index drop not null;
