-- Migration: 0152_create_rooms
-- Room Registry Slice 001 (Unified Entry Architecture).
--
-- Room is a pure addressing abstraction: it answers "which runtime does
-- this human-facing code point to," and owns nothing else — no
-- gameplay, no lifecycle detail, no scoring, no sequencing. Session and
-- Poker Table each keep their entire existing internal architecture
-- untouched; this table only points outward at them, never the
-- reverse (no column is added to sessions or poker_tables).
--
-- Polymorphic association mirrors point_awards' own already-proven
-- shape (interaction_instance_id / duel_id, num_nonnulls(...) = 1) —
-- the same structural problem (one row must reference exactly one of
-- several possible parent tables), the same precedented solution.
-- runtime_type is deliberately NOT a stored column: which FK column is
-- non-null is itself the provenance signal, exactly as point_awards'
-- own "duel_id is not null" already establishes for that table.
--
-- Founder decision (Room Registry Slice 001 resolution): v1 room codes
-- are non-reusable. Once URBANO Gaming issues a code through this
-- registry, that code never identifies another runtime — deliberately
-- simpler than sessions_room_code_active_unique / poker_tables_room_
-- code_active_unique's own "unique among active rows only" rule. No
-- closed_at column exists here; Room does not track whether the
-- runtime it points to is still running — that remains exclusively
-- Session's or Poker's own concern.
--
-- on delete cascade: production never hard-deletes a sessions or
-- poker_tables row (completion is a state transition, never a
-- deletion) — this exists purely so a rooms row can never survive as
-- an orphaned FK violation blocking cleanup, the one place hard
-- deletes genuinely happen: this repository's own contract-test
-- teardown, across every existing Session/Poker contract test file,
-- none of which this Slice otherwise touches.

create table rooms (
  room_id        uuid primary key default gen_random_uuid(),
  room_code      text not null,
  session_id     uuid null references sessions(session_id) on delete cascade,
  poker_table_id uuid null references poker_tables(poker_table_id) on delete cascade,
  created_at     timestamptz not null default now(),

  constraint rooms_exactly_one_runtime check (num_nonnulls(session_id, poker_table_id) = 1)
);

-- Global, permanent uniqueness — not partial/active-only, per the
-- non-reusable-codes decision above. This is the sole authoritative
-- room-code allocation constraint going forward; sessions_room_code_
-- active_unique and poker_tables_room_code_active_unique remain in
-- place, untouched, as harmless legacy belt-and-suspenders — never
-- relied on for anything new.
create unique index rooms_room_code_unique on rooms (room_code);

-- Read path for the resolver's fast (non-legacy) case.
create index rooms_session_id_idx on rooms (session_id) where session_id is not null;
create index rooms_poker_table_id_idx on rooms (poker_table_id) where poker_table_id is not null;
