-- URBANO Gaming Competitions — Soccer Slice 001.
--
-- Competitions is an independently-owned domain (UG-CR-REV-017 decision
-- 4): every table here is distinct from Predictions'/Session's own
-- entities of similar shape (competitions_teams != Predictions' teams,
-- UG-CR-RPT-018's own naming-collision finding), and every table is
-- server-only — no anon/authenticated grant is ever issued, and RLS is
-- enabled with zero policies, in this same migration that creates the
-- table (UG-CR-REV-026 condition 3), not deferred to a later
-- consolidated pass.
--
-- state: DRAFT (organizer sets up teams/pairings) -> PUBLISHED
-- (registration and fixtures exist) -> COMPLETE | CANCELLED_WITHOUT_
-- CHAMPION (UG-CR-RPT-024 §3). organizer_gaming_member_id is a direct
-- field, not a global authority_grants row — only *creating* a
-- competition requires active platform OPERATIONAL authority
-- (UG-CR-REV-026 condition 1, enforced in create_competition_atomically,
-- not here); once created, organizer authority is scoped to this one
-- row.
create table competitions (
  competition_id uuid primary key default gen_random_uuid(),
  activity_key text not null check (activity_key in ('SOCCER_5V5')),
  name text not null,
  organizer_gaming_member_id uuid not null references gaming_members (gaming_member_id),
  state text not null default 'DRAFT' check (
    state in ('DRAFT', 'PUBLISHED', 'COMPLETE', 'CANCELLED_WITHOUT_CHAMPION')
  ),
  cancelled_reason text null,
  created_at timestamptz not null default now(),
  published_at timestamptz null
);

create index competitions_organizer_idx on competitions (organizer_gaming_member_id);

alter table competitions enable row level security;
revoke all on competitions from anon, authenticated;

-- Exactly four rows per Slice 001 competition, created only during
-- DRAFT by the organizer (UG-CR-RPT-016 §10: team creation is excluded
-- from the member journey — these are pre-existing/seeded, never
-- member-created).
create table competition_teams (
  competition_team_id uuid primary key default gen_random_uuid(),
  competition_id uuid not null references competitions (competition_id),
  name text not null,
  captain_gaming_member_id uuid not null references gaming_members (gaming_member_id),
  created_at timestamptz not null default now()
);

create index competition_teams_competition_idx on competition_teams (competition_id);

alter table competition_teams enable row level security;
revoke all on competition_teams from anon, authenticated;
