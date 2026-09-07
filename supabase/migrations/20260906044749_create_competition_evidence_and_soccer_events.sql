-- Regulation score only — never includes penalty-shootout kicks
-- (UG-CR-RPT-024 §2/§6). One CURRENT evidence row per fixture, via the
-- supersession chain, mirroring (never sharing) Predictions' own
-- match_results.entered_by/supersedes shape (UG-CR-RPT-018 §3).
create table competition_fixture_evidence (
  competition_fixture_evidence_id uuid primary key default gen_random_uuid(),
  competition_fixture_id uuid not null references competition_fixtures (competition_fixture_id),
  team_a_score integer not null check (team_a_score >= 0),
  team_b_score integer not null check (team_b_score >= 0),
  entered_by_gaming_member_id uuid not null references gaming_members (gaming_member_id),
  entered_at timestamptz not null default now(),
  supersedes_evidence_id uuid null references competition_fixture_evidence (competition_fixture_evidence_id),
  is_current boolean not null default true
);

create unique index competition_fixture_evidence_one_current
  on competition_fixture_evidence (competition_fixture_id)
  where is_current;

alter table competition_fixture_evidence enable row level security;
revoke all on competition_fixture_evidence from anon, authenticated;

-- Soccer-specific — kept out of the generic evidence table so no other
-- future activity adapter inherits soccer's own vocabulary (UG-CR-
-- RPT-020 §3). Own goals and unattributed regulation goals are
-- excluded from Slice 001 (UG-CR-RPT-024 §6): every regulation-score
-- point must be backed by exactly one attributed goal event crediting
-- the scoring team directly — enforced in submit_competition_fixture_
-- evidence_atomically / correct_competition_fixture_atomically, not by
-- a column here, since it is a cross-row count-vs-score invariant.
create table soccer_goal_events (
  soccer_goal_event_id uuid primary key default gen_random_uuid(),
  competition_fixture_id uuid not null references competition_fixtures (competition_fixture_id),
  scorer_gaming_member_id uuid not null references gaming_members (gaming_member_id),
  competition_team_id uuid not null references competition_teams (competition_team_id),
  entered_by_gaming_member_id uuid not null references gaming_members (gaming_member_id),
  entered_at timestamptz not null default now(),
  corrected_at timestamptz null,
  corrected_by_gaming_member_id uuid null references gaming_members (gaming_member_id),
  superseded_by_soccer_goal_event_id uuid null references soccer_goal_events (soccer_goal_event_id),
  is_current boolean not null default true
);

create index soccer_goal_events_fixture_idx on soccer_goal_events (competition_fixture_id) where is_current;

alter table soccer_goal_events enable row level security;
revoke all on soccer_goal_events from anon, authenticated;

-- assisted_goal_event_id: every assist references exactly one goal
-- event, optional, at most one current assist per goal event
-- (UG-CR-RPT-024 §6 evidence-consistency rules).
create table soccer_assist_events (
  soccer_assist_event_id uuid primary key default gen_random_uuid(),
  competition_fixture_id uuid not null references competition_fixtures (competition_fixture_id),
  assisting_gaming_member_id uuid not null references gaming_members (gaming_member_id),
  assisted_goal_event_id uuid not null references soccer_goal_events (soccer_goal_event_id),
  entered_by_gaming_member_id uuid not null references gaming_members (gaming_member_id),
  entered_at timestamptz not null default now(),
  corrected_at timestamptz null,
  corrected_by_gaming_member_id uuid null references gaming_members (gaming_member_id),
  superseded_by_soccer_assist_event_id uuid null references soccer_assist_events (soccer_assist_event_id),
  is_current boolean not null default true
);

create unique index soccer_assist_events_one_current_per_goal
  on soccer_assist_events (assisted_goal_event_id)
  where is_current;

alter table soccer_assist_events enable row level security;
revoke all on soccer_assist_events from anon, authenticated;

-- Winner-level only — individual penalty-kick detail is an explicit
-- Slice 001 exclusion (UG-CR-RPT-024 §2): shootout kicks/goals never
-- count toward player goal/assist totals (UG-CR-REV-019), so no
-- kick-by-kick ledger is needed to keep that guarantee.
create table soccer_penalty_shootouts (
  soccer_penalty_shootout_id uuid primary key default gen_random_uuid(),
  competition_fixture_id uuid not null references competition_fixtures (competition_fixture_id),
  winning_competition_team_id uuid not null references competition_teams (competition_team_id),
  entered_by_gaming_member_id uuid not null references gaming_members (gaming_member_id),
  entered_at timestamptz not null default now(),
  supersedes_shootout_id uuid null references soccer_penalty_shootouts (soccer_penalty_shootout_id),
  is_current boolean not null default true
);

create unique index soccer_penalty_shootouts_one_current
  on soccer_penalty_shootouts (competition_fixture_id)
  where is_current;

alter table soccer_penalty_shootouts enable row level security;
revoke all on soccer_penalty_shootouts from anon, authenticated;
