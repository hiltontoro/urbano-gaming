-- Migration: 0128_create_duels
-- Duel / SESSION_SUBGAME v1 (Product/Duel_Architecture.md).
--
-- Duel-specific persistence, deliberately not a generic
-- session_subgames table — Duel is the first, and only, concrete
-- SESSION_SUBGAME instance; a second one is the evidence that would
-- justify extracting a shared substrate, not something to build
-- speculatively ahead of it (see the implementation-readiness gate's
-- own reasoning).
--
-- Two fixed competitor-slot columns, not a child roster table — Duel's
-- own canonical participant model is exactly two competitors, never
-- an arbitrary N. `competitor_a_participant_id <> competitor_b_
-- participant_id` is enforced at the schema level, matching this
-- repository's own preference for constraint-backed invariants over
-- app-only checks wherever the invariant is cheap to express this way.
--
-- lifecycle_state/terminal_resolution/winner_participant_id follow
-- Duel_Architecture.md's own lifecycle section exactly: CREATED is a
-- valid enum value for schema completeness, but application code never
-- persists a row in it — start_duel_atomically (0129) creates a Duel
-- already ACTIVE, the same "goes straight to its running state on
-- creation" discipline start_session_atomically already applies to
-- ordinary Interaction Instances. The check constraints below protect
-- exactly the impossible combinations the readiness gate named: an
-- ACTIVE Duel can never already carry a terminal_resolution; a
-- COMPLETED Duel must always carry one; VOID and DRAW can never carry
-- a winner.
--
-- duel_content is a small, Duel-owned structure (prompt/options/
-- correct answer) — not a reference into prepared_questions, which
-- remains Quiz/Trivia's own content, and not a real interaction_
-- instances row, since that table's own existing assumptions (full
-- Session-roster participation) are not truthful for a two-competitor
-- subgame — see the readiness gate's "Interaction-engine reuse
-- disposition." correct_option_index is never exposed to participants
-- before a Duel resolves.
--
-- duel_responses is a genuinely separate table, not two columns on
-- duels — mirrors this schema's own existing submissions/votes
-- pattern of one row per (subject, participant), and gives a clean
-- unique-per-competitor upsert target for idempotent retry (last
-- write wins, mirroring submit_response_atomically's own precedent).

create table duels (
    duel_id uuid primary key default gen_random_uuid(),
    session_id uuid not null
        references sessions(session_id) on delete cascade,

    competitor_a_participant_id uuid not null
        references participants(participant_id) on delete cascade,
    competitor_b_participant_id uuid not null
        references participants(participant_id) on delete cascade,

    prompt_text text not null,
    options jsonb not null,
    correct_option_index integer not null,

    lifecycle_state text not null default 'ACTIVE'
        check (lifecycle_state in ('CREATED', 'ACTIVE', 'COMPLETED')),
    terminal_resolution text
        check (terminal_resolution in ('WON_LOST', 'DRAW', 'VOID', 'CANCELLED', 'FORFEIT')),
    winner_participant_id uuid
        references participants(participant_id) on delete set null,
    reason text,

    created_at timestamptz not null default now(),
    started_at timestamptz,
    ended_at timestamptz,

    check (competitor_a_participant_id <> competitor_b_participant_id),
    check (lifecycle_state <> 'ACTIVE' or terminal_resolution is null),
    check (lifecycle_state <> 'COMPLETED' or terminal_resolution is not null),
    check (terminal_resolution not in ('VOID', 'CANCELLED', 'DRAW') or winner_participant_id is null),
    check (terminal_resolution not in ('WON_LOST', 'FORFEIT') or winner_participant_id is not null)
);

-- At most one ACTIVE Duel per Session — the schema-level half of the
-- one-active-subgame invariant; start_duel_atomically's own row lock
-- and existence check (0129) is the concurrency-proof half.
create unique index duels_one_active_per_session
on duels (session_id)
where lifecycle_state = 'ACTIVE';

create index duels_session_id_idx on duels (session_id);

create table duel_responses (
    duel_id uuid not null
        references duels(duel_id) on delete cascade,
    participant_id uuid not null
        references participants(participant_id) on delete cascade,
    selected_option_index integer not null,
    answered_at timestamptz not null default now(),

    primary key (duel_id, participant_id)
);
