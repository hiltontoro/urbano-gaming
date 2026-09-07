-- fixture_role is a fixed three-value enum for this one knockout shape
-- (SEMIFINAL_1, SEMIFINAL_2, FINAL) — not a generic bracket-position
-- system (UG-CR-RPT-020 §3's own explicit non-goal).
--
-- team_a/b_competition_team_id are set at publish time for the two
-- semifinals; both are null for FINAL until team_a/b_source_fixture_id
-- (pointing at the two semifinals) resolve on semifinal finalization —
-- this is the actual mechanism by which "a final time slot may be
-- published before finalist identities resolve" (UG-CR-RPT-024 §3) is
-- represented: scheduled_at is set on all three rows at publish time,
-- independent of whether team slots are yet known.
create table competition_fixtures (
  competition_fixture_id uuid primary key default gen_random_uuid(),
  competition_id uuid not null references competitions (competition_id),
  fixture_role text not null check (fixture_role in ('SEMIFINAL_1', 'SEMIFINAL_2', 'FINAL')),
  scheduled_at timestamptz not null,
  team_a_competition_team_id uuid null references competition_teams (competition_team_id),
  team_b_competition_team_id uuid null references competition_teams (competition_team_id),
  team_a_source_fixture_id uuid null references competition_fixtures (competition_fixture_id),
  team_b_source_fixture_id uuid null references competition_fixtures (competition_fixture_id),
  state text not null default 'SCHEDULED' check (
    state in ('SCHEDULED', 'ROSTER_DECLARED', 'CHECKIN_OPEN', 'EVIDENCE_SUBMITTED', 'UNDER_REVIEW',
              'FINALIZED', 'CORRECTED_AND_FINALIZED', 'VOID', 'FORFEIT_FINALIZED')
  ),
  scorekeeper_gaming_member_id uuid null references gaming_members (gaming_member_id),
  created_at timestamptz not null default now(),
  unique (competition_id, fixture_role)
);

create index competition_fixtures_competition_idx on competition_fixtures (competition_id);

alter table competition_fixtures enable row level security;
revoke all on competition_fixtures from anon, authenticated;

-- Normalized, append-only roster revisions (UG-CR-REV-021 decision 2 —
-- replaces an earlier array-valued design UG-CR-RPT-022 had proposed
-- and Code Review rejected). One header row per declaration/correction
-- EVENT; the child entry table below holds the actual per-player rows.
-- "The current roster" for a (fixture, team) is always the entry set
-- of the one non-superseded header — never a stored array, never an
-- in-place-mutable field.
create table competition_roster_revisions (
  competition_roster_revision_id uuid primary key default gen_random_uuid(),
  competition_fixture_id uuid not null references competition_fixtures (competition_fixture_id),
  competition_team_id uuid not null references competition_teams (competition_team_id),
  declared_by_gaming_member_id uuid not null references gaming_members (gaming_member_id),
  declared_at timestamptz not null default now(),
  reason text null,
  supersedes_revision_id uuid null references competition_roster_revisions (competition_roster_revision_id),
  is_current boolean not null default true
);

create index competition_roster_revisions_fixture_team_idx
  on competition_roster_revisions (competition_fixture_id, competition_team_id);

-- Exactly one current (non-superseded) revision per (fixture, team) —
-- the actual database-enforced answer to "concurrent writes may not
-- create two current branches" (UG-CR-REV-026 condition 2). declare_
-- competition_roster_atomically serializes on this same (fixture,
-- team) pair with a row lock before flipping the old current row to
-- is_current = false and inserting the new one, so this index is a
-- backstop, not the sole mechanism.
create unique index competition_roster_revisions_one_current
  on competition_roster_revisions (competition_fixture_id, competition_team_id)
  where is_current;

alter table competition_roster_revisions enable row level security;
revoke all on competition_roster_revisions from anon, authenticated;

create table competition_roster_revision_entries (
  competition_roster_revision_entry_id uuid primary key default gen_random_uuid(),
  competition_roster_revision_id uuid not null references competition_roster_revisions (competition_roster_revision_id),
  gaming_member_id uuid not null references gaming_members (gaming_member_id),
  unique (competition_roster_revision_id, gaming_member_id)
);

create index competition_roster_revision_entries_revision_idx
  on competition_roster_revision_entries (competition_roster_revision_id);

alter table competition_roster_revision_entries enable row level security;
revoke all on competition_roster_revision_entries from anon, authenticated;
