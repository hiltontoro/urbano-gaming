-- Migration: 20260904085836_create_race_events
-- URBANO Race Slice 001 — Towers-specific synchronous Live Race.
--
-- Race is its own bounded runtime (per UG-CR-TAX-001's Format
-- dimension), not a Session capability and not a generic engine: this
-- Slice proves exactly one Towers-specific Race event shape. Race owns
-- competitor slots, readiness, the shared countdown, timing comparison,
-- and event lifecycle; Towers remains the sole owner of scenario rules,
-- move validation, undo, and per-attempt evidence (0160-0163). Race
-- never stores or exposes a raw towers_attempts.attempt_id to any
-- client — attempt identity is looked up server-side only, through
-- Race's own bearer tokens.
--
-- CORRECTED per UG-CR-GATE-025 (UG-CR-REV-022's required corrections):
-- this migration candidate is local, uncommitted, and undeployed, so it
-- is amended in place rather than patched by a second migration.
--   1. Added race_event_creations and race_event_operations: a durable,
--      Race-owned idempotency ledger, independent of Towers' own
--      per-attempt idempotency (which remains defense in depth, not the
--      Race-level guarantee). See 20260904085843_create_race_functions
--      for how every mutating function checks this ledger, under the
--      event's own lock, BEFORE any terminal-state rejection or child
--      mutation — so a retry of the exact operation that already
--      terminalized the event (e.g. the winning move) replays the
--      original successful result rather than a generic terminal error.
--   2. Removed 'TIE' from terminal_resolution's valid set. Once the
--      transaction-boundary correctness was properly understood (see
--      the functions migration's own comment on now() vs
--      clock_timestamp()), it became clear the serialized Towers Race
--      admits only one completing move before terminalization — a
--      second, genuinely competing completion can never be observed
--      unresolved. The prior implementation's tie-comparison branch was
--      only reachable via artificially injected evidence, never through
--      any real path, so claiming live tie support was false. TIE is
--      removed from this Slice's schema entirely rather than kept as an
--      unreachable enum value; a future Product rule may reintroduce it
--      deliberately.
--
-- Tables:
--   - race_events: one row per Race event; the row every official move,
--     undo, readiness, and cancellation transition locks via
--     `select ... for update` (see 20260904085843_create_race_functions)
--     before doing anything else. All lifecycle sub-phases (assignment
--     pending, readiness pending, countdown, running) are DERIVED from
--     column presence/absence, mirroring this repository's existing
--     Pulse SETUP/ACTIVE derivation convention, rather than a
--     separately-persisted phase enum.
--   - race_completions: append-only Race-owned evidence, one row per
--     competitor slot that reached a genuine Towers COMPLETE while the
--     event was not yet terminal (unique(race_event_id, competitor_slot)
--     makes a duplicate impossible at the database level, mirroring
--     towers_attempt_actions' own idempotency-by-constraint pattern).
--   - race_event_creations: durable idempotency ledger for CREATE_EVENT,
--     keyed by a client-generated idempotency_key alone (no race_event_id
--     exists yet at that point).
--   - race_event_operations: durable idempotency ledger for every other
--     mutating Race command (JOIN/MOVE/UNDO/CANCEL), keyed by
--     (race_event_id, idempotency_key). Stores the exact authoritative
--     response so a retry — including one arriving after the event has
--     since terminalized — can be replayed verbatim, and stores enough
--     of the original request (command, caller, payload fingerprint) to
--     deterministically reject a key reused with a different one of
--     those.
--
-- Data API exposure: current official Supabase guidance (verified
-- 2026-09-04) is mid-rollout on a breaking change removing automatic
-- Data API/GraphQL exposure for new public-schema tables (opt-in from
-- 2026-04-28, default for new projects from 2026-05-30, applied to all
-- existing projects by 2026-10-30). This project's existing tables
-- predate that default and rely on ambient grants, but this migration
-- does not assume that posture: RLS is enabled with zero policies
-- (true default-deny for anon/authenticated regardless of Data API
-- exposure state — service_role bypasses RLS by design, matching this
-- repository's `gaming_admins`/`authority_grants` precedent of
-- `ENABLE ROW LEVEL SECURITY` with zero `CREATE POLICY` statements),
-- and grants to service_role are explicit rather than assumed, so the
-- application's existing service-role Supabase client keeps working
-- whichever Data API exposure default this project ends up under.

create table race_events (
  race_event_id uuid primary key default gen_random_uuid(),

  -- Race-issued bearer credential for the organizer role. The organizer
  -- may additionally hold one of the two competitor tokens below if
  -- they choose to compete — organizer authority and competitor
  -- authority are deliberately separate credentials/permission sets.
  organizer_token text not null unique,

  child_game text not null default 'TOWERS',
  scenario_id text not null,
  scenario_version integer not null,

  -- Race-issued bearer credentials, generated only when a slot is
  -- assigned. Never derived from or equal to the underlying Towers
  -- attempt_id.
  competitor_a_token text null unique,
  competitor_b_token text null unique,

  -- Raw Towers attempt identity. Server-side only: no API route or
  -- projection may ever select these columns into a client response.
  competitor_a_attempt_id uuid null references towers_attempts (attempt_id),
  competitor_b_attempt_id uuid null references towers_attempts (attempt_id),

  competitor_a_ready boolean not null default false,
  competitor_b_ready boolean not null default false,

  -- Post-countdown mutual-cancellation handshake. Both must be true for
  -- a live cancellation to terminalize the event.
  competitor_a_cancel_requested boolean not null default false,
  competitor_b_cancel_requested boolean not null default false,

  -- Anchors the five-minute readiness window from assignment of the
  -- SECOND competitor slot, per Founder parameter.
  second_competitor_assigned_at timestamptz null,

  -- The single future server timestamp both competitors race toward.
  -- Set exactly once, atomically, the moment both competitors are
  -- ready.
  shared_start_at timestamptz null,

  terminal_resolution text null,
  winner_slot text null,
  terminal_reason text null,
  ended_at timestamptz null,

  created_at timestamptz not null default now(),

  constraint race_events_child_game_valid
    check (child_game in ('TOWERS')),
  -- 'TIE' intentionally excluded — see the migration header comment.
  constraint race_events_terminal_resolution_valid
    check (terminal_resolution in ('WON_LOST', 'NO_CONTEST', 'CANCELLED')),
  constraint race_events_winner_slot_valid
    check (winner_slot in ('A', 'B')),
  constraint race_events_winner_requires_won_lost
    check (winner_slot is null or terminal_resolution = 'WON_LOST'),
  constraint race_events_ended_requires_terminal
    check (ended_at is null or terminal_resolution is not null),
  constraint race_events_distinct_competitor_tokens
    check (
      competitor_a_token is null
      or competitor_b_token is null
      or competitor_a_token <> competitor_b_token
    )
);

-- Append-only Race-owned completion evidence. race_observed_completed_at
-- is captured via clock_timestamp() (genuinely current wall-clock time,
-- unlike now()/transaction_timestamp() which stay fixed at transaction
-- start) immediately after Towers' own atomic move function returns,
-- under the race_events row lock — see 20260904085843_create_race_functions
-- for the corrected timestamp semantics this depends on.
create table race_completions (
  race_completion_id uuid primary key default gen_random_uuid(),
  race_event_id uuid not null references race_events (race_event_id) on delete cascade,
  competitor_slot text not null,
  race_observed_completed_at timestamptz not null,
  towers_completed_at timestamptz null,
  towers_move_count integer not null,
  elapsed_ms bigint not null,
  created_at timestamptz not null default now(),

  constraint race_completions_slot_valid
    check (competitor_slot in ('A', 'B')),
  constraint race_completions_elapsed_nonnegative
    check (elapsed_ms >= 0),
  constraint race_completions_move_count_nonnegative
    check (towers_move_count >= 0),
  -- At most one recorded completion per competitor per event — a
  -- database-enforced guarantee, not just an application convention.
  constraint race_completions_unique_slot_per_event
    unique (race_event_id, competitor_slot)
);

create index race_completions_race_event_id_idx on race_completions (race_event_id);

-- Durable idempotency ledger for CREATE_EVENT. No race_event_id exists
-- until the winning insert commits, so this is keyed by the client's
-- own idempotency_key alone rather than the (race_event_id,
-- idempotency_key) pair the event-scoped ledger below uses.
--
-- idempotency_key is the native `uuid` column type (UG-CR-GATE-026's
-- key validation boundary), not `text`: this is the database-type
-- enforcement layer of the shared key contract that also has a
-- format/length check in the browser and a stricter regex check in the
-- API route before the repository is ever called — Postgres itself
-- rejects any non-UUID-shaped value at the column boundary, so direct
-- server-side misuse (bypassing the API layer entirely) still cannot
-- store an invalid key.
--
-- The race_event_id foreign key is DEFERRABLE INITIALLY DEFERRED: the
-- atomic creation function deliberately inserts this claim row BEFORE
-- the race_events row it references exists yet (claiming the
-- idempotency_key is what determines which concurrent caller "wins"
-- and gets to create the event at all — see
-- 20260904085843_create_race_functions's own comment). A deferred
-- constraint checks referential integrity at COMMIT, not at each
-- statement, so this within-transaction ordering is valid while the
-- guarantee that every claim row ultimately points at a real event
-- still holds.
create table race_event_creations (
  idempotency_key uuid primary key,
  race_event_id uuid not null references race_events (race_event_id) deferrable initially deferred,
  organizer_token text not null,
  scenario_id text not null,
  scenario_version integer not null,
  created_at timestamptz not null default now()
);

-- Durable idempotency ledger for every event-scoped mutating Race
-- command. `result` is the exact authoritative response body returned
-- to the original caller, replayed verbatim on a matching retry —
-- including a retry that arrives after the event has since
-- terminalized. `caller_token` and `payload_fingerprint` let a replay
-- attempt be verified as safe (same command, same caller, same
-- payload) before replaying, and let a genuinely different request
-- reusing the same key be rejected deterministically instead of either
-- silently replaying the wrong response or silently re-executing.
-- idempotency_key is `uuid`, not `text` — see race_event_creations'
-- own comment on the shared key-contract enforcement this provides.
create table race_event_operations (
  race_event_id uuid not null references race_events (race_event_id) on delete cascade,
  idempotency_key uuid not null,
  command text not null,
  caller_token text not null,
  payload_fingerprint text not null,
  result jsonb not null,
  created_at timestamptz not null default now(),

  constraint race_event_operations_command_valid
    check (command in ('JOIN', 'MOVE', 'UNDO', 'CANCEL')),
  constraint race_event_operations_pkey
    primary key (race_event_id, idempotency_key)
);

alter table race_events enable row level security;
alter table race_completions enable row level security;
alter table race_event_creations enable row level security;
alter table race_event_operations enable row level security;

-- Zero policies defined on any Race table: with RLS enabled,
-- anon/authenticated requests are denied by default for every
-- operation. service_role bypasses RLS (standard Supabase/Postgres
-- behavior) and is the only role this repository's server-side code
-- ever uses to reach these tables — including the two idempotency
-- ledgers, which store bearer credentials and must never be reachable
-- by a direct client request.
revoke all on race_events from anon, authenticated;
revoke all on race_completions from anon, authenticated;
revoke all on race_event_creations from anon, authenticated;
revoke all on race_event_operations from anon, authenticated;

grant select, insert, update, delete on race_events to service_role;
grant select, insert, update, delete on race_completions to service_role;
grant select, insert, update, delete on race_event_creations to service_role;
grant select, insert, update, delete on race_event_operations to service_role;
