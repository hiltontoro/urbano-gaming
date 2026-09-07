-- One row per finalization EVENT, not per fixture — a post-finalization
-- correction inserts a NEW row whose supersedes_finalization_id points
-- at the original (UG-CR-REV-021 decision 4 / UG-CR-RPT-024 §2); the
-- original is never edited. winning_competition_team_id is null only
-- for outcome_type = 'VOID'.
create table competition_fixture_finalizations (
  competition_fixture_finalization_id uuid primary key default gen_random_uuid(),
  competition_fixture_id uuid not null references competition_fixtures (competition_fixture_id),
  finalized_by_gaming_member_id uuid not null references gaming_members (gaming_member_id),
  finalized_at timestamptz not null default now(),
  outcome_type text not null check (outcome_type in ('NORMAL', 'FORFEIT', 'VOID')),
  winning_competition_team_id uuid null references competition_teams (competition_team_id),
  reason text null,
  supersedes_finalization_id uuid null references competition_fixture_finalizations (competition_fixture_finalization_id),
  is_current boolean not null default true
);

create unique index competition_fixture_finalizations_one_current
  on competition_fixture_finalizations (competition_fixture_id)
  where is_current;

alter table competition_fixture_finalizations enable row level security;
revoke all on competition_fixture_finalizations from anon, authenticated;

-- Derived automatically, never directly written by any human action
-- (UG-CR-RPT-020 §3/§10). One row per (fixture, member) who actually
-- appeared — no row at all for a rostered-but-non-participating
-- member. A correction re-derives a NEW current row, superseding the
-- prior one; a competition that later cancels does not retroactively
-- strip records already validly derived from a *different*, earlier,
-- normally-finalized fixture (UG-CR-RPT-024 §7's own retention rule).
create table competition_member_participation_records (
  competition_member_participation_record_id uuid primary key default gen_random_uuid(),
  competition_id uuid not null references competitions (competition_id),
  competition_fixture_id uuid not null references competition_fixtures (competition_fixture_id),
  gaming_member_id uuid not null references gaming_members (gaming_member_id),
  appeared boolean not null default true,
  goals integer not null default 0 check (goals >= 0),
  assists integer not null default 0 check (assists >= 0),
  derived_from_finalization_id uuid not null references competition_fixture_finalizations (competition_fixture_finalization_id),
  derived_at timestamptz not null default now(),
  supersedes_record_id uuid null references competition_member_participation_records (competition_member_participation_record_id),
  is_current boolean not null default true
);

create unique index competition_member_participation_records_one_current
  on competition_member_participation_records (competition_fixture_id, gaming_member_id)
  where is_current;
create index competition_member_participation_records_member_idx
  on competition_member_participation_records (competition_id, gaming_member_id) where is_current;

alter table competition_member_participation_records enable row level security;
revoke all on competition_member_participation_records from anon, authenticated;
