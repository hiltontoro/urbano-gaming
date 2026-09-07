-- Multiple disputes may target the same fact (additive, not exclusive
-- — UG-CR-RPT-016 §9's own concurrent-dispute scenario). A dispute
-- never itself changes a fact; resolution_action records what the
-- organizer's own resulting action was — FINALIZED_AS_SUBMITTED is the
-- outcome finalize_competition_fixture_atomically writes atomically
-- into every then-open dispute row for that fixture (UG-CR-RPT-024
-- §9), never a state a client can request directly.
create table competition_disputes (
  competition_dispute_id uuid primary key default gen_random_uuid(),
  competition_fixture_id uuid not null references competition_fixtures (competition_fixture_id),
  raised_by_gaming_member_id uuid not null references gaming_members (gaming_member_id),
  -- Exactly the accepted design's own dispute enum (UG-CR-RPT-020 §3) —
  -- SHOOTOUT was never part of it and is deliberately absent: a
  -- shootout outcome has no single attributable scorer or owning team
  -- column, so no unambiguous directly-affected/captain-ownership
  -- authorization mapping exists for it (UG-CR-GATE-033). A shootout
  -- change remains reachable only through the organizer's own
  -- correction path, never a dispute.
  target_fact_type text not null check (
    target_fact_type in ('PARTICIPATION_ATTESTATION', 'SCORE', 'GOAL_EVENT', 'ASSIST_EVENT')
  ),
  target_fact_id uuid not null,
  reason text not null,
  raised_at timestamptz not null default now(),
  resolved_at timestamptz null,
  resolved_by_gaming_member_id uuid null references gaming_members (gaming_member_id),
  resolution_action text null check (resolution_action in ('CORRECTED', 'VOIDED', 'FINALIZED_AS_SUBMITTED'))
);

create index competition_disputes_fixture_idx on competition_disputes (competition_fixture_id);
create index competition_disputes_open_idx on competition_disputes (competition_fixture_id) where resolved_at is null;

alter table competition_disputes enable row level security;
revoke all on competition_disputes from anon, authenticated;

-- Append-only audit log distinct from each fact's own supersedes
-- pointer — one place to see every correction on a fixture at a
-- glance (UG-CR-RPT-020 §3). previous/new_value_snapshot are
-- deliberately generic jsonb, since the corrected fact type varies.
create table competition_fixture_corrections (
  competition_fixture_correction_id uuid primary key default gen_random_uuid(),
  competition_fixture_id uuid not null references competition_fixtures (competition_fixture_id),
  corrected_by_gaming_member_id uuid not null references gaming_members (gaming_member_id),
  reason text not null,
  target_fact_type text not null,
  target_fact_id uuid null,
  previous_value_snapshot jsonb null,
  new_value_snapshot jsonb null,
  corrected_at timestamptz not null default now()
);

create index competition_fixture_corrections_fixture_idx on competition_fixture_corrections (competition_fixture_id);

alter table competition_fixture_corrections enable row level security;
revoke all on competition_fixture_corrections from anon, authenticated;
