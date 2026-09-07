-- Registration, team-join request, and team membership are three
-- distinct facts (UG-CR-REV-019 correction 1; UG-CR-RPT-016 §6) — none
-- is derivable from another.

-- One registration per (competition, member). is_adult_self_attested is
-- exactly what its name says: synthetic self-attestation, never
-- verified age or identity (UG-CR-REV-026 condition/UG-CR-REV-017
-- decision 5) — it carries no authority beyond gating the Slice 001
-- registration action itself.
create table competition_registrations (
  competition_registration_id uuid primary key default gen_random_uuid(),
  competition_id uuid not null references competitions (competition_id),
  gaming_member_id uuid not null references gaming_members (gaming_member_id),
  is_adult_self_attested boolean not null,
  registered_at timestamptz not null default now(),
  unique (competition_id, gaming_member_id)
);

create index competition_registrations_member_idx on competition_registrations (gaming_member_id);

alter table competition_registrations enable row level security;
revoke all on competition_registrations from anon, authenticated;

-- A member requests one team; a captain (or organizer override)
-- approves/rejects; at most one *pending* (non-terminal) request per
-- (competition, member) — enforced by request_join_competition_team_
-- atomically, not by a partial unique index alone, since "pending"
-- spans REQUESTED and organizer-review-in-progress states that are
-- both represented by status = 'REQUESTED' with organizer_reviewed_at
-- still null.
create table competition_join_requests (
  competition_join_request_id uuid primary key default gen_random_uuid(),
  competition_id uuid not null references competitions (competition_id),
  competition_team_id uuid not null references competition_teams (competition_team_id),
  requesting_gaming_member_id uuid not null references gaming_members (gaming_member_id),
  status text not null default 'REQUESTED' check (status in ('REQUESTED', 'APPROVED', 'REJECTED')),
  decided_by_gaming_member_id uuid null references gaming_members (gaming_member_id),
  decided_at timestamptz null,
  organizer_reviewed_at timestamptz null,
  organizer_reviewed_by_gaming_member_id uuid null references gaming_members (gaming_member_id),
  created_at timestamptz not null default now()
);

create index competition_join_requests_member_idx on competition_join_requests (competition_id, requesting_gaming_member_id);
create index competition_join_requests_team_idx on competition_join_requests (competition_team_id);

alter table competition_join_requests enable row level security;
revoke all on competition_join_requests from anon, authenticated;

-- At most one CURRENT membership per (competition, member) — UG-CR-
-- REV-021 decision 1 / UG-CR-RPT-024 §2. Slice 001 has no transfer
-- contract, so "current" and "ever" coincide: the unique index below
-- is the actual enforcement, re-verified atomically inside decide_
-- join_request_atomically / organizer_review_join_request_atomically
-- before either would attempt an insert that could violate it.
create table competition_team_memberships (
  competition_team_membership_id uuid primary key default gen_random_uuid(),
  -- Denormalized alongside competition_team_id specifically so a single
  -- database-enforced unique index (below) can guarantee "at most one
  -- current membership per competition per member" directly, without a
  -- cross-table subquery a concurrent insert could still race past.
  competition_id uuid not null references competitions (competition_id),
  competition_team_id uuid not null references competition_teams (competition_team_id),
  gaming_member_id uuid not null references gaming_members (gaming_member_id),
  approved_at timestamptz not null default now(),
  approved_by_gaming_member_id uuid not null references gaming_members (gaming_member_id)
);

create index competition_team_memberships_team_idx on competition_team_memberships (competition_team_id);
create unique index competition_team_memberships_one_per_member
  on competition_team_memberships (competition_id, gaming_member_id);

alter table competition_team_memberships enable row level security;
revoke all on competition_team_memberships from anon, authenticated;
