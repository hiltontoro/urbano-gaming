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
