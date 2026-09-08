-- Branded Team Registration and Invitation Journey (UG-CR-RPT-041 §4/§5).
-- Extends competition_teams with a bounded status/provenance model so a
-- member-proposed team can exist without consuming a bracket slot until
-- the organizer accepts it, while every existing organizer-created row
-- migrates truthfully to status=ACCEPTED, provenance=ORGANIZER_CREATED
-- via the column DEFAULTs below — no separate UPDATE statement, no row
-- rewritten or deleted, no history lost.
alter table competition_teams
  add column status text not null default 'ACCEPTED'
    check (status in ('PENDING_ORGANIZER_APPROVAL', 'ACCEPTED', 'REJECTED')),
  add column provenance text not null default 'ORGANIZER_CREATED'
    check (provenance in ('ORGANIZER_CREATED', 'MEMBER_PROPOSED')),
  add column decided_at timestamptz null,
  add column decided_by_gaming_member_id uuid null references gaming_members (gaming_member_id),
  add column rejection_reason text null;

-- One non-REJECTED team name per competition, case/whitespace normalized
-- (accepted decisions §5). A partial index rather than a plain unique
-- constraint: rejected history must never block a later proposal that
-- reuses the same normalized name (accepted decisions §4/§5) — the
-- rejected row simply falls outside this index's own predicate.
create unique index competition_teams_unique_name_per_competition
  on competition_teams (competition_id, lower(btrim(name)))
  where status <> 'REJECTED';

-- One active (non-REJECTED) captaincy per member per competition
-- (accepted decisions §5) — the same partial-index technique, applied to
-- captain_gaming_member_id instead of name. This is the actual
-- non-bypassable enforcement for "a member cannot propose/captain a
-- second team while already captaining or having an accepted team in
-- this competition"; every write path that could violate it (organizer
-- ADD_COMPETITION_TEAM, member PROPOSE_COMPETITION_TEAM,
-- DECIDE_COMPETITION_TEAM's own ACCEPT branch) catches this exact
-- constraint's unique_violation and translates it to a typed domain
-- error rather than depending only on an application-level precheck.
create unique index competition_teams_one_active_captaincy
  on competition_teams (competition_id, captain_gaming_member_id)
  where status <> 'REJECTED';
