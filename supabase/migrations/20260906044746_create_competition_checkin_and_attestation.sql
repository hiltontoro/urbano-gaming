-- Check-in proves presence intent only, never participation
-- (UG-CR-RPT-016 §6). One row per (fixture, member); checking in
-- requires an existing current roster entry for that pairing, enforced
-- in check_in_competition_fixture_atomically, not by a table-level FK
-- (there is no single "roster entry id" to reference once rosters are
-- normalized into a header+entries pair, §fixtures_and_roster).
create table competition_checkins (
  competition_checkin_id uuid primary key default gen_random_uuid(),
  competition_fixture_id uuid not null references competition_fixtures (competition_fixture_id),
  gaming_member_id uuid not null references gaming_members (gaming_member_id),
  checked_in_at timestamptz not null default now(),
  unique (competition_fixture_id, gaming_member_id)
);

alter table competition_checkins enable row level security;
revoke all on competition_checkins from anon, authenticated;

-- Independent of roster/check-in, structurally (UG-CR-RPT-016 §6): a
-- rostered, checked-in player the scorekeeper attests did NOT actually
-- play receives no appearance/goal/assist record. One CURRENT
-- attestation per (fixture, member), reachable via the supersession
-- chain — a correction inserts a new row, never edits this one in
-- place.
create table competition_participation_attestations (
  competition_participation_attestation_id uuid primary key default gen_random_uuid(),
  competition_fixture_id uuid not null references competition_fixtures (competition_fixture_id),
  gaming_member_id uuid not null references gaming_members (gaming_member_id),
  actually_participated boolean not null,
  attested_by_gaming_member_id uuid not null references gaming_members (gaming_member_id),
  attested_at timestamptz not null default now(),
  supersedes_attestation_id uuid null references competition_participation_attestations (competition_participation_attestation_id),
  is_current boolean not null default true
);

create unique index competition_participation_attestations_one_current
  on competition_participation_attestations (competition_fixture_id, gaming_member_id)
  where is_current;

alter table competition_participation_attestations enable row level security;
revoke all on competition_participation_attestations from anon, authenticated;
