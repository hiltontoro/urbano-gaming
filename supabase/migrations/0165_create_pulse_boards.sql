-- Migration: 0165_create_pulse_boards
-- URBANO Pulse Slice 001 (UG-CR-GATE-002). One row per (duel_id,
-- participant_id) — mirrors duel_responses'/duel_math_responses' own
-- one-or-composite-row-per-competitor shape. Owns the actual private
-- secret: forms is null until commitment, then holds the immutable
-- committed layout as an array of
-- {"formId": text, "cells": [{"row": int, "col": int}, ...]}.
-- Never exposed to the opponent, Host, or spectators while the Duel is
-- ACTIVE — enforced entirely at the read-model boundary (getSession.ts),
-- not by any property of this table.
--
-- commit_idempotency_key is the idempotency mechanism for
-- COMMIT_SETUP: once committed_at is set, a repeat call with the same
-- key returns the cached result; a repeat call with a different key is
-- a genuine second, rejected commit attempt (setup has no legitimate
-- "retry with different content" case once committed).

create table pulse_boards (
  duel_id uuid not null
    references duels (duel_id) on delete cascade,
  participant_id uuid not null
    references participants (participant_id) on delete cascade,
  forms jsonb null,
  was_assisted boolean not null default false,
  commit_idempotency_key text null,
  committed_at timestamptz null,

  primary key (duel_id, participant_id)
);

-- URBANO Pulse — Migration Atomicity and Table Boundary Correction
-- (UG-CR-GATE-058, UG-CR-REV-038). This table's own row IS the private
-- secret this comment block already warns about above (forms holds the
-- committed board layout) — RLS with zero client policies, plus an
-- explicit revoke/grant boundary in this SAME migration, closes the
-- table to anon/authenticated from the instant it is created, exactly
-- as the accepted Race table-boundary precedent does. service_role
-- bypasses RLS (standard Postgres/Supabase behavior) and is the only
-- role this repository's server-side code ever uses to reach this
-- table. No sequence grant: this table has no identity/serial column
-- (its primary key is the composite duel_id/participant_id uuid pair).
alter table public.pulse_boards enable row level security;
revoke all on table public.pulse_boards from public, anon, authenticated;
grant select, insert, update, delete on table public.pulse_boards to service_role;
