-- UG-CR-GATE-CFM-001 — Lifetime Teams and Competition Entry Foundation.
--
-- WHAT THIS DOES. It adds the persistent entity the Competitions product is moving to — a LIFETIME TEAM that outlives any one competition — and the way such
-- a team ENTERS a competition, WITHOUT touching a single existing V1 operation, table row or migration. It is one additive file; nothing is rewritten.
--
--   1. LIFETIME TEAMS (lifetime_teams): a stable id, an opaque public code, a name (unique among active teams, ignoring case and spaces), a lifecycle status
--      (ACTIVE or DISBANDED), the creator, the timestamps. Its creator is its captain and first member.
--   2. DATED MEMBERSHIP (lifetime_team_memberships): a person belongs to a team for a period [joined_at, ended_at). A membership begins only when BOTH sides
--      agree (a leader invites and the person accepts, or the person asks and a leader accepts; an offer lapses after seven days). A person holds at most TWO
--      active memberships; a captain or sub-captain belongs to ONE team only (the Founder's rule: someone who wants to play for another team stops leading first).
--      A period is ended, never overwritten or deleted; joining again starts a new period.
--   3. CAPTAIN AND SUB-CAPTAIN (lifetime_team_leaderships): one active captain per team, at most one sub-captain, each a dated row that is ended, never rewritten.
--      The captaincy changes hands ONLY when the captain leaves, to the sub-captain (the Founder: no hand-over while the captain stays). The sub-captain seat is
--      offered by the captain and accepted by the person.
--   4. AUDIT (lifetime_team_events): an append-only event for every change of a team's status, memberships and leadership seats that takes effect (a disband writes one
--      per ended row), with the actor (none for the system's own backfill). An offer or a roster claim keeps its history on its own dated row.
--   5. COMPETITION ENTRY. An entry is a competition_teams row (the existing competition-scoped team concept) that carries three new columns: entry_flow (V1 by
--      default, LIFETIME for an entry), lifetime_team_id and a sub-captain snapshot. The entry's name and captain are the existing columns, written once. The
--      whole snapshot is immutable. A competition uses the lifetime flow only after its organizer ENABLES it (competition_lifetime_flows, no route calls it); from
--      then on every V1 team path REFUSES (adding, proposing and deciding a team answer "registration is closed"; a join request, the close and the publish answer their
--      own bounded refusals), an entry can never become ACCEPTED, and the V1 freeze and fixtures are refused for it — so no draw, schedule, fixture or result operation
--      can ever consume an entry that is not fully migrated. A person represents ONE team in a competition: the captain and sub-captain an entry names count as well as the
--      people on its roster, and an entry can be created only by the entry operation. Nothing here is public.
--   6. ROSTER CLAIMS (competition_lifetime_roster_claims): a leader PROPOSES people for an entry; a proposal claims nobody. A claim begins only when the PERSON
--      accepts it, and at most ONE accepted claim per person per competition can exist (a partial unique index). Before the freeze a claim is released by
--      rejection, withdrawal, removal or expiry; after it the accepted row stays as evidence and a later departure is only DATED (departed_at). The roster of an entry is its
--      ACCEPTED claims; the freeze records only the counts, and settles (expires) every proposal still open.
--   7. THE LIFETIME FREEZE (competition_lifetime_freezes): the organizer's append-only checkpoint after the registration deadline. It changes no competition state.
--   8. LEGACY BACKFILL (backfill_legacy_competition_teams_atomically): an explicit, idempotent, scoped service-side function that records each ACCEPTED V1
--      team as a LEGACY lifetime team (dated from the V1 rows, linked in a side table, never merged by name or person). Legacy rows are excluded from the new
--      caps. It is NEVER run by this migration.
--
-- IDENTITY. The anchor is the existing gaming_member_id (one row per authenticated user, auth_user_id not null unique). Nothing here reads a name, an email or a
-- phone number, merges anyone or infers an identity; an unknown or missing person is refused.
--
-- LOCK ORDER. Every operation takes its locks in ONE order: persons -> teams -> competition -> entries and claims. A person lock is
-- pg_advisory_xact_lock(7101, hashtext('lifetime_person:' || member id)), taken in ascending key order (a two-key lock, a keyspace of its own: it can never meet
-- the single-key competition_scope locks V1 uses). A team lock is its row, FOR UPDATE, in id order. The competition lock is V1's own: the competition_scope
-- advisory lock and then the competitions row FOR UPDATE, so lifetime operations serialize against V1 operations in the same competition. Because the order is
-- fixed, two operations can never wait on each other in a cycle (the competitions of one person's claims are locked in lock-key order). The tables hold the rules that
-- matter most as well: the membership and leadership guards take the person lock when a record BECOMES active (so a cap or exclusivity rule cannot be raced by a direct
-- write), the entry and claim guards take the competition lock for the one-team-per-competition check, and the unique indexes hold one seat, one captain, one accepted
-- claim per person per competition and one live entry per team. Rules that span rows — an accepted claim implies an active member, a team has exactly one captain —
-- are kept by the operations, which change those rows in one transaction, and are not enforced by the tables.
--
-- ERRORS. Every refusal is a coded P0001 error whose message starts with CODE: (the repository turns it into a typed error); no raw database failure is meant
-- to reach a caller. Existing codes are reused where the meaning is the same (COMPETITION_NOT_FOUND, COMPETITION_ACCESS_DENIED, COMPETITION_CANCELLED,
-- TEAM_REGISTRATION_NOT_OPEN, COMPETITION_REGISTRATION_REQUIRED, HOST_ACCESS_REVOKED, DUPLICATE_TEAM_NAME). ALREADY_CAPTAIN_OR_MEMBER is kept only as the answer of the
-- one-active-captaincy index when an entry meets it, which the entry guard's own LIFETIME_PERSON_REPRESENTS_ANOTHER_TEAM normally answers first.
--
-- WHAT THIS DELIBERATELY DOES NOT DO. No group, league, variable bracket, standing, public page, goal, assist, card, result-confirmation system, phone
-- verification, account merge, payment or public enablement; no route, no page, no change to Home, Predictions or Voting. It edits no earlier migration and
-- no V1 function: V1 stays exactly as it is for every competition that never enables the lifetime flow.
--
-- WHO CAN DO WHAT (the Founder's matrix): a captain AND a sub-captain enter the team in a competition, propose its roster, invite and remove ordinary members, and
-- withdraw an entry; only the captain names the sub-captain, removes them and disbands the team. A leader's invitation or roster proposal stands only while that leader
-- still holds a seat: ending a seat ends its pending invitations, and a roster place cannot be accepted from a proposer who no longer leads.
--
-- KNOWN LIMITS, carried to the gates that own them: (1) entering needs the adult self-attestation of the ENTERING leader only, and a V1 registration made without the tick
-- cannot be upgraded by V1 (the refusal now says so; the repair is a V1 change); (2) team names are unique ignoring case and spaces only — look-alike characters are a
-- moderation matter for the page that shows names, which must also escape them; (3) a former leader stays bound to the competition (as captain or sub-captain of record)
-- until the team's CURRENT leaders withdraw the entry, and the organizer has no verb to decide or remove an entry (the host-approval gate owns both, and must also give the
-- organizer a way out of a mistaken enable); (4) legacy rows are history for the new caps, so a legacy captain may lead several teams — the one-team-per-competition rule
-- still holds at the competition boundary; (5) no route may read or write this foundation until it authenticates, probes authority with a plain read, rate-limits and
-- projects per audience; (6) apply this file in a quiet window: it alters competition_teams, which V1 transactions read; (7) the backfill mirrors what V1 recorded EVERY
-- time it runs, so a V1 approval or an accepted V1 team that a LATER run mirrors is legacy too and never counts toward the caps — run it only for competitions whose V1
-- registration is closed; a V1 member who already has a lifetime row on the legacy team (pending, active or ended) is not mirrored; (8) the backfill holds foreign-key
-- row locks on every V1 competition and team it links until it finishes (V1 writes in those competitions wait): run it per competition, or a few at a time, in a quiet
-- window — it converges, so several small runs are safe; (9) a roster proposal made by a leader whose seat has ended is not settled eagerly: the person can still
-- reject it and any current leader can release it, and the leaders' own proposal for that person is answered LIFETIME_CLAIM_ALREADY_OPEN until one of those happens.

-- 1/9  Internal helpers. Nobody can call them directly.
create function lifetime_clock()
 returns timestamptz
 language sql
 volatile
 set search_path = public, pg_temp
as $function$ select clock_timestamp() $function$;
revoke all on function lifetime_clock() from public, anon, authenticated;
revoke all on function lifetime_clock() from service_role;

-- Takes the person locks for every distinct, non-null person given, in ascending key order, so two operations that lock overlapping people can never deadlock.
create function lifetime_lock_people(p_people uuid[])
 returns void
 language plpgsql
 volatile
 set search_path = public, pg_temp
as $function$
declare
  v_key integer;
begin
  for v_key in
    select distinct hashtext('lifetime_person:' || person::text) from unnest(p_people) as person where person is not null order by 1
  loop
    perform pg_advisory_xact_lock(7101, v_key);
  end loop;
end;
$function$;
revoke all on function lifetime_lock_people(uuid[]) from public, anon, authenticated;
revoke all on function lifetime_lock_people(uuid[]) from service_role;

-- 2/9  Lifetime teams, dated memberships, dated leadership and their audit trail.
create table lifetime_teams (
  lifetime_team_id uuid primary key default gen_random_uuid(),
  public_code text not null default rtrim(translate(encode(uuid_send(gen_random_uuid()), 'base64'), '+/', '-_'), '='),
  name text not null,
  status text not null default 'ACTIVE',
  origin text not null default 'NEW',
  created_by_gaming_member_id uuid not null references gaming_members (gaming_member_id),
  created_at timestamptz not null default now(),
  disbanded_at timestamptz null,
  disbanded_by_gaming_member_id uuid null references gaming_members (gaming_member_id),
  constraint lifetime_teams_public_code_key unique (public_code),
  constraint lifetime_teams_public_code_shape check (public_code ~ '^[A-Za-z0-9_-]{22}$'),
  constraint lifetime_teams_status_check check (status in ('ACTIVE', 'DISBANDED')),
  constraint lifetime_teams_origin_check check (origin in ('NEW', 'LEGACY_BACKFILL')),
  constraint lifetime_teams_name_length check (
    (origin = 'NEW' and char_length(btrim(name)) between 2 and 60) or (origin = 'LEGACY_BACKFILL' and char_length(btrim(name)) >= 1)),
  constraint lifetime_teams_disbanded_shape check ((status = 'DISBANDED') = (disbanded_at is not null and disbanded_by_gaming_member_id is not null))
);

-- A name is unique among the active teams that were created through the lifetime flow, ignoring case and spaces. Legacy teams are history and are excluded.
create unique index lifetime_teams_active_name_key on lifetime_teams (lower(regexp_replace(name, '\s+', '', 'g'))) where status = 'ACTIVE' and origin = 'NEW';

create table lifetime_team_memberships (
  lifetime_team_membership_id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  lifetime_team_id uuid not null references lifetime_teams (lifetime_team_id),
  gaming_member_id uuid not null references gaming_members (gaming_member_id),
  status text not null,
  initiated_by_side text not null,
  initiated_by_gaming_member_id uuid not null references gaming_members (gaming_member_id),
  is_legacy boolean not null default false,
  created_at timestamptz not null default now(),
  expires_at timestamptz null,
  decided_at timestamptz null,
  decided_by_gaming_member_id uuid null references gaming_members (gaming_member_id),
  joined_at timestamptz null,
  ended_at timestamptz null,
  ended_by_gaming_member_id uuid null references gaming_members (gaming_member_id),
  end_reason text null,
  constraint lifetime_team_memberships_status_check check (status in ('PENDING', 'ACTIVE', 'ENDED')),
  constraint lifetime_team_memberships_side_check check (initiated_by_side in ('TEAM', 'PERSON')),
  constraint lifetime_team_memberships_end_reason_check check (end_reason is null or end_reason in ('DECLINED', 'WITHDRAWN', 'EXPIRED', 'LEFT', 'REMOVED', 'TEAM_DISBANDED')),
  constraint lifetime_team_memberships_shape check (
    (status = 'PENDING' and joined_at is null and ended_at is null and end_reason is null and expires_at is not null)
    or (status = 'ACTIVE' and joined_at is not null and ended_at is null and end_reason is null)
    or (status = 'ENDED' and ended_at is not null and end_reason is not null
        and ((joined_at is null and end_reason in ('DECLINED', 'WITHDRAWN', 'EXPIRED', 'TEAM_DISBANDED'))
             or (joined_at is not null and end_reason in ('LEFT', 'REMOVED', 'TEAM_DISBANDED') and ended_at >= joined_at)))
  )
);
create unique index lifetime_team_memberships_one_pending on lifetime_team_memberships (lifetime_team_id, gaming_member_id) where status = 'PENDING';
create unique index lifetime_team_memberships_one_active on lifetime_team_memberships (lifetime_team_id, gaming_member_id) where status = 'ACTIVE';
create index lifetime_team_memberships_person_idx on lifetime_team_memberships (gaming_member_id) where status = 'ACTIVE';
create index lifetime_team_memberships_team_idx on lifetime_team_memberships (lifetime_team_id, status);

create table lifetime_team_leaderships (
  lifetime_team_leadership_id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  lifetime_team_id uuid not null references lifetime_teams (lifetime_team_id),
  gaming_member_id uuid not null references gaming_members (gaming_member_id),
  role text not null,
  status text not null,
  is_legacy boolean not null default false,
  offered_by_gaming_member_id uuid not null references gaming_members (gaming_member_id),
  created_at timestamptz not null default now(),
  expires_at timestamptz null,
  decided_at timestamptz null,
  started_at timestamptz null,
  ended_at timestamptz null,
  ended_by_gaming_member_id uuid null references gaming_members (gaming_member_id),
  end_reason text null,
  predecessor_leadership_id uuid null references lifetime_team_leaderships (lifetime_team_leadership_id),
  constraint lifetime_team_leaderships_role_check check (role in ('CAPTAIN', 'SUB_CAPTAIN')),
  constraint lifetime_team_leaderships_status_check check (status in ('PENDING', 'ACTIVE', 'ENDED')),
  constraint lifetime_team_leaderships_pending_role check (role = 'SUB_CAPTAIN' or status <> 'PENDING'),
  constraint lifetime_team_leaderships_end_reason_check check (end_reason is null or end_reason in ('DECLINED', 'WITHDRAWN', 'EXPIRED', 'STEPPED_DOWN', 'REMOVED', 'SUCCEEDED', 'PROMOTED', 'TEAM_DISBANDED')),
  constraint lifetime_team_leaderships_shape check (
    (status = 'PENDING' and started_at is null and ended_at is null and end_reason is null and expires_at is not null)
    or (status = 'ACTIVE' and started_at is not null and ended_at is null and end_reason is null)
    or (status = 'ENDED' and ended_at is not null and end_reason is not null
        and ((started_at is null and end_reason in ('DECLINED', 'WITHDRAWN', 'EXPIRED', 'TEAM_DISBANDED'))
             or (started_at is not null and end_reason in ('STEPPED_DOWN', 'REMOVED', 'SUCCEEDED', 'PROMOTED', 'TEAM_DISBANDED') and ended_at >= started_at)))
  )
);
create unique index lifetime_team_leaderships_one_active_per_role on lifetime_team_leaderships (lifetime_team_id, role) where status = 'ACTIVE';
create unique index lifetime_team_leaderships_one_pending_per_role on lifetime_team_leaderships (lifetime_team_id, role) where status = 'PENDING';
create unique index lifetime_team_leaderships_one_seat_per_person on lifetime_team_leaderships (gaming_member_id) where status = 'ACTIVE' and not is_legacy;
create index lifetime_team_leaderships_team_idx on lifetime_team_leaderships (lifetime_team_id, status);

create table lifetime_team_events (
  event_id uuid primary key default gen_random_uuid(),
  event_seq bigint generated always as identity,
  lifetime_team_id uuid not null references lifetime_teams (lifetime_team_id),
  event_type text not null,
  actor_gaming_member_id uuid null references gaming_members (gaming_member_id),
  subject_gaming_member_id uuid null references gaming_members (gaming_member_id),
  related_id uuid null,
  details jsonb not null default '{}'::jsonb,
  occurred_at timestamptz not null default now(),
  constraint lifetime_team_events_type_check check (event_type in (
    'TEAM_CREATED', 'TEAM_DISBANDED', 'MEMBERSHIP_OFFERED', 'MEMBERSHIP_ACTIVATED', 'MEMBERSHIP_DECLINED', 'MEMBERSHIP_WITHDRAWN', 'MEMBERSHIP_ENDED',
    'LEADERSHIP_OFFERED', 'LEADERSHIP_ACTIVATED', 'LEADERSHIP_DECLINED', 'LEADERSHIP_WITHDRAWN', 'LEADERSHIP_ENDED', 'CAPTAINCY_SUCCEEDED', 'ENTRY_SUBMITTED', 'ENTRY_WITHDRAWN'))
);
create index lifetime_team_events_team_idx on lifetime_team_events (lifetime_team_id, event_seq);

-- 3/9  The competition side: the flow switch, the entry columns, the claims and the freeze.
create table competition_lifetime_flows (
  competition_id uuid primary key references competitions (competition_id),
  enabled_at timestamptz not null,
  enabled_by_gaming_member_id uuid not null references gaming_members (gaming_member_id)
);

alter table competition_teams
  add column entry_flow text not null default 'V1' constraint competition_teams_entry_flow_check check (entry_flow in ('V1', 'LIFETIME')),
  add column lifetime_team_id uuid null references lifetime_teams (lifetime_team_id),
  add column sub_captain_gaming_member_id uuid null references gaming_members (gaming_member_id);
alter table competition_teams
  add constraint competition_teams_entry_flow_shape check (
    (entry_flow = 'V1' and lifetime_team_id is null and sub_captain_gaming_member_id is null) or (entry_flow = 'LIFETIME' and lifetime_team_id is not null));
-- One live entry per lifetime team per competition (a withdrawn entry is REJECTED and falls outside the index: re-entry is allowed).
create unique index competition_teams_lifetime_entry_unique on competition_teams (competition_id, lifetime_team_id) where lifetime_team_id is not null and status <> 'REJECTED';
-- The reference a claim holds, so a claim can never name an entry of another competition or another team.
create unique index competition_teams_entry_reference_key on competition_teams (competition_team_id, competition_id, lifetime_team_id);

create table lifetime_team_legacy_sources (
  lifetime_team_id uuid primary key references lifetime_teams (lifetime_team_id),
  competition_team_id uuid not null references competition_teams (competition_team_id),
  competition_id uuid not null references competitions (competition_id),
  linked_at timestamptz not null default now(),
  constraint lifetime_team_legacy_sources_competition_team_key unique (competition_team_id)
);

create table competition_lifetime_roster_claims (
  competition_lifetime_roster_claim_id uuid primary key default gen_random_uuid(),
  seq bigint generated always as identity,
  competition_id uuid not null references competitions (competition_id),
  competition_team_id uuid not null,
  lifetime_team_id uuid not null,
  gaming_member_id uuid not null references gaming_members (gaming_member_id),
  status text not null default 'PROPOSED',
  proposed_by_gaming_member_id uuid not null references gaming_members (gaming_member_id),
  proposed_at timestamptz not null default now(),
  expires_at timestamptz not null,
  decided_at timestamptz null,
  accepted_at timestamptz null,
  released_at timestamptz null,
  released_by_gaming_member_id uuid null references gaming_members (gaming_member_id),
  release_reason text null,
  departed_at timestamptz null,
  departure_reason text null,
  constraint competition_lifetime_roster_claims_entry_fkey foreign key (competition_team_id, competition_id, lifetime_team_id)
    references competition_teams (competition_team_id, competition_id, lifetime_team_id),
  constraint competition_lifetime_roster_claims_status_check check (status in ('PROPOSED', 'ACCEPTED', 'REJECTED', 'WITHDRAWN', 'REMOVED', 'EXPIRED')),
  constraint competition_lifetime_roster_claims_release_reason_check check (release_reason is null or release_reason in (
    'PERSON_REJECTED', 'PERSON_WITHDREW', 'LEADER_REMOVED', 'LEADER_WITHDREW_PROPOSAL', 'EXPIRED', 'LEFT_TEAM', 'REMOVED_FROM_TEAM', 'TEAM_DISBANDED', 'ENTRY_WITHDRAWN')),
  constraint competition_lifetime_roster_claims_departure_reason_check check (departure_reason is null or departure_reason in ('LEFT_TEAM', 'REMOVED_FROM_TEAM', 'TEAM_DISBANDED')),
  constraint competition_lifetime_roster_claims_expiry_check check (expires_at > proposed_at),
  constraint competition_lifetime_roster_claims_shape check (
    (status = 'PROPOSED' and accepted_at is null and released_at is null and release_reason is null and departed_at is null and departure_reason is null)
    or (status = 'ACCEPTED' and accepted_at is not null and released_at is null and release_reason is null and ((departed_at is null) = (departure_reason is null)))
    or (status in ('REJECTED', 'WITHDRAWN', 'REMOVED', 'EXPIRED') and released_at is not null and release_reason is not null and departed_at is null and departure_reason is null)
  )
);
-- THE invariant: a person holds at most ONE accepted claim per competition. It does not mention departure: a person who leaves after the freeze is still
-- the competition's claim, and no other team can accept them there.
create unique index competition_lifetime_roster_claims_one_accepted_per_person on competition_lifetime_roster_claims (competition_id, gaming_member_id) where status = 'ACCEPTED';
create unique index competition_lifetime_roster_claims_one_open_per_entry_person on competition_lifetime_roster_claims (competition_team_id, gaming_member_id) where status in ('PROPOSED', 'ACCEPTED');
create index competition_lifetime_roster_claims_competition_idx on competition_lifetime_roster_claims (competition_id, status);
create index competition_lifetime_roster_claims_person_idx on competition_lifetime_roster_claims (gaming_member_id, status);

create table competition_lifetime_freezes (
  competition_id uuid primary key references competitions (competition_id),
  planning_revision_id uuid not null,
  roster_minimum smallint not null,
  roster_maximum smallint not null,
  registration_deadline_utc timestamptz not null,
  frozen_at timestamptz not null,
  frozen_by_gaming_member_id uuid not null references gaming_members (gaming_member_id),
  entry_count integer not null,
  claim_count integer not null,
  constraint competition_lifetime_freezes_revision_fkey foreign key (competition_id, planning_revision_id) references competition_planning_revisions (competition_id, planning_revision_id),
  constraint competition_lifetime_freezes_roster_range check (roster_minimum >= 1 and roster_maximum <= 16 and roster_minimum <= roster_maximum),
  constraint competition_lifetime_freezes_counts check (entry_count >= 2 and claim_count >= 0),
  constraint competition_lifetime_freezes_after_deadline check (frozen_at >= registration_deadline_utc)
);

-- 4/9  Server-only: row-level security on, no policy, no browser role holds any privilege, and not even the server role can write a row directly.
alter table lifetime_teams enable row level security;
alter table lifetime_team_memberships enable row level security;
alter table lifetime_team_leaderships enable row level security;
alter table lifetime_team_events enable row level security;
alter table lifetime_team_legacy_sources enable row level security;
alter table competition_lifetime_flows enable row level security;
alter table competition_lifetime_roster_claims enable row level security;
alter table competition_lifetime_freezes enable row level security;

revoke all on table lifetime_teams from public, anon, authenticated, service_role;
revoke all on table lifetime_team_memberships from public, anon, authenticated, service_role;
revoke all on table lifetime_team_leaderships from public, anon, authenticated, service_role;
revoke all on table lifetime_team_events from public, anon, authenticated, service_role;
revoke all on table lifetime_team_legacy_sources from public, anon, authenticated, service_role;
revoke all on table competition_lifetime_flows from public, anon, authenticated, service_role;
revoke all on table competition_lifetime_roster_claims from public, anon, authenticated, service_role;
revoke all on table competition_lifetime_freezes from public, anon, authenticated, service_role;

-- The four identity sequences ("generated always as identity") receive rwU for the browser and server roles from the platform's default privileges: nobody but the
-- owner (and the definer functions that run as it) needs them, and a role that could move one could make every later insert fail.
revoke all on sequence lifetime_team_memberships_seq_seq, lifetime_team_leaderships_seq_seq, lifetime_team_events_event_seq_seq, competition_lifetime_roster_claims_seq_seq
  from public, anon, authenticated, service_role;

grant select on table lifetime_teams to service_role;
grant select on table lifetime_team_memberships to service_role;
grant select on table lifetime_team_leaderships to service_role;
grant select on table lifetime_team_events to service_role;
grant select on table lifetime_team_legacy_sources to service_role;
grant select on table competition_lifetime_flows to service_role;
grant select on table competition_lifetime_roster_claims to service_role;
grant select on table competition_lifetime_freezes to service_role;

-- 5/9  The tables hold the rules too. Each guard raises the SAME coded refusal an operation would, so a direct write cannot get around a rule.
-- History that is never rewritten: events, legacy links, the flow switch and the freeze can neither change nor go.
create function lifetime_history_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
begin
  raise exception 'LIFETIME_INVARIANT_VIOLATION: this record is history and cannot be changed or removed' using errcode = 'P0001';
  return null;
end;
$function$;
revoke all on function lifetime_history_guard() from public, anon, authenticated;
revoke all on function lifetime_history_guard() from service_role;

create trigger lifetime_team_events_history_rows before update or delete on lifetime_team_events for each row execute function lifetime_history_guard();
create trigger lifetime_team_events_history_truncate before truncate on lifetime_team_events for each statement execute function lifetime_history_guard();
create trigger lifetime_team_legacy_sources_history_rows before update or delete on lifetime_team_legacy_sources for each row execute function lifetime_history_guard();
create trigger lifetime_team_legacy_sources_history_truncate before truncate on lifetime_team_legacy_sources for each statement execute function lifetime_history_guard();
create trigger competition_lifetime_flows_history_rows before update or delete on competition_lifetime_flows for each row execute function lifetime_history_guard();
create trigger competition_lifetime_flows_history_truncate before truncate on competition_lifetime_flows for each statement execute function lifetime_history_guard();
create trigger competition_lifetime_freezes_history_rows before update or delete on competition_lifetime_freezes for each row execute function lifetime_history_guard();
create trigger competition_lifetime_freezes_history_truncate before truncate on competition_lifetime_freezes for each statement execute function lifetime_history_guard();
create trigger lifetime_teams_history_truncate before truncate on lifetime_teams for each statement execute function lifetime_history_guard();
create trigger lifetime_team_memberships_history_truncate before truncate on lifetime_team_memberships for each statement execute function lifetime_history_guard();
create trigger lifetime_team_leaderships_history_truncate before truncate on lifetime_team_leaderships for each statement execute function lifetime_history_guard();
create trigger competition_lifetime_roster_claims_history_truncate before truncate on competition_lifetime_roster_claims for each statement execute function lifetime_history_guard();

-- The flow switch can be added only to a competition with no legacy team and no legacy freeze.
create function competition_lifetime_flows_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
begin
  if exists (select 1 from competition_teams t where t.competition_id = new.competition_id)
     or exists (select 1 from competition_registration_freezes f where f.competition_id = new.competition_id) then
    raise exception 'LIFETIME_FLOW_CONFLICT: this competition already uses the legacy team flow' using errcode = 'P0001';
  end if;
  return new;
end;
$function$;
revoke all on function competition_lifetime_flows_guard() from public, anon, authenticated;
revoke all on function competition_lifetime_flows_guard() from service_role;
create trigger competition_lifetime_flows_guard before insert on competition_lifetime_flows for each row execute function competition_lifetime_flows_guard();

-- A team keeps its identity: only its status may move (ACTIVE to DISBANDED, once) and, for the owner, its name. It is never deleted.
create function lifetime_teams_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
begin
  if tg_op = 'DELETE' then
    raise exception 'LIFETIME_INVARIANT_VIOLATION: a lifetime team is never deleted' using errcode = 'P0001';
  end if;
  if new.lifetime_team_id is distinct from old.lifetime_team_id or new.public_code is distinct from old.public_code
     or new.created_by_gaming_member_id is distinct from old.created_by_gaming_member_id or new.created_at is distinct from old.created_at
     or new.origin is distinct from old.origin then
    raise exception 'LIFETIME_INVARIANT_VIOLATION: a team keeps its identity, origin and creation' using errcode = 'P0001';
  end if;
  if old.status = 'DISBANDED' then
    raise exception 'LIFETIME_INVARIANT_VIOLATION: a disbanded team is history' using errcode = 'P0001';
  end if;
  if new.status is distinct from old.status and not (old.status = 'ACTIVE' and new.status = 'DISBANDED') then
    raise exception 'LIFETIME_INVARIANT_VIOLATION: invalid team status change' using errcode = 'P0001';
  end if;
  return new;
end;
$function$;
revoke all on function lifetime_teams_guard() from public, anon, authenticated;
revoke all on function lifetime_teams_guard() from service_role;
create trigger lifetime_teams_guard before update or delete on lifetime_teams for each row execute function lifetime_teams_guard();

-- Membership: rows are created PENDING or ACTIVE, move only PENDING to ACTIVE or ENDED and ACTIVE to ENDED, and are never rewritten or deleted. Activating a
-- membership holds the person's lock and enforces the cap (two) and the exclusivity of leaders (legacy rows are history and are not counted).
create function lifetime_membership_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
declare
  v_origin text;
  v_others integer;
  v_activating boolean := false;
begin
  if tg_op = 'DELETE' then
    raise exception 'LIFETIME_INVARIANT_VIOLATION: a membership record is never deleted' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' then
    if new.lifetime_team_membership_id is distinct from old.lifetime_team_membership_id or new.seq is distinct from old.seq
       or new.lifetime_team_id is distinct from old.lifetime_team_id or new.gaming_member_id is distinct from old.gaming_member_id
       or new.initiated_by_side is distinct from old.initiated_by_side or new.initiated_by_gaming_member_id is distinct from old.initiated_by_gaming_member_id
       or new.is_legacy is distinct from old.is_legacy or new.created_at is distinct from old.created_at or new.expires_at is distinct from old.expires_at then
      raise exception 'LIFETIME_INVARIANT_VIOLATION: a membership record keeps what it recorded' using errcode = 'P0001';
    end if;
    if not ((old.status = 'PENDING' and new.status in ('ACTIVE', 'ENDED')) or (old.status = 'ACTIVE' and new.status = 'ENDED')) then
      raise exception 'LIFETIME_INVARIANT_VIOLATION: a membership record moves forward only' using errcode = 'P0001';
    end if;
    if new.status = 'ENDED' and (new.joined_at is distinct from old.joined_at) then
      raise exception 'LIFETIME_INVARIANT_VIOLATION: an ended period keeps its start' using errcode = 'P0001';
    end if;
  else
    if new.status not in ('PENDING', 'ACTIVE') then
      raise exception 'LIFETIME_INVARIANT_VIOLATION: a membership record starts pending or active' using errcode = 'P0001';
    end if;
    select t.origin into v_origin from lifetime_teams t where t.lifetime_team_id = new.lifetime_team_id;
    if new.is_legacy and v_origin is distinct from 'LEGACY_BACKFILL' then
      raise exception 'LIFETIME_INVARIANT_VIOLATION: only a legacy team carries legacy records' using errcode = 'P0001';
    end if;
  end if;

  if new.status = 'ACTIVE' and not new.is_legacy then
    if tg_op = 'INSERT' then
      v_activating := true;
    elsif old.status is distinct from 'ACTIVE' then
      v_activating := true;
    end if;
  end if;
  if v_activating then
    perform lifetime_lock_people(array[new.gaming_member_id]);
    if exists (select 1 from lifetime_team_leaderships l where l.gaming_member_id = new.gaming_member_id and l.status = 'ACTIVE' and not l.is_legacy
                  and l.lifetime_team_id <> new.lifetime_team_id) then
      raise exception 'LIFETIME_LEADER_CANNOT_JOIN_OTHER_TEAM: a captain or sub-captain belongs to one team only' using errcode = 'P0001';
    end if;
    select count(*) into v_others from lifetime_team_memberships m
     where m.gaming_member_id = new.gaming_member_id and m.status = 'ACTIVE' and not m.is_legacy
       and m.lifetime_team_membership_id <> new.lifetime_team_membership_id and m.lifetime_team_id <> new.lifetime_team_id;
    if v_others >= 2 then
      raise exception 'LIFETIME_MEMBERSHIP_CAP_REACHED: a person may belong to at most two teams at once' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$function$;
revoke all on function lifetime_membership_guard() from public, anon, authenticated;
revoke all on function lifetime_membership_guard() from service_role;
create trigger lifetime_membership_guard before insert or update or delete on lifetime_team_memberships for each row execute function lifetime_membership_guard();

-- Leadership: the same movement rules; activating a seat requires an active membership of THAT team and no other team (and no other seat).
create function lifetime_leadership_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
declare
  v_origin text;
  v_activating boolean := false;
begin
  if tg_op = 'DELETE' then
    raise exception 'LIFETIME_INVARIANT_VIOLATION: a leadership record is never deleted' using errcode = 'P0001';
  end if;
  if tg_op = 'UPDATE' then
    if new.lifetime_team_leadership_id is distinct from old.lifetime_team_leadership_id or new.seq is distinct from old.seq
       or new.lifetime_team_id is distinct from old.lifetime_team_id or new.gaming_member_id is distinct from old.gaming_member_id
       or new.role is distinct from old.role or new.is_legacy is distinct from old.is_legacy
       or new.offered_by_gaming_member_id is distinct from old.offered_by_gaming_member_id or new.created_at is distinct from old.created_at
       or new.expires_at is distinct from old.expires_at or new.predecessor_leadership_id is distinct from old.predecessor_leadership_id then
      raise exception 'LIFETIME_INVARIANT_VIOLATION: a leadership record keeps what it recorded' using errcode = 'P0001';
    end if;
    if not ((old.status = 'PENDING' and new.status in ('ACTIVE', 'ENDED')) or (old.status = 'ACTIVE' and new.status = 'ENDED')) then
      raise exception 'LIFETIME_INVARIANT_VIOLATION: a leadership record moves forward only' using errcode = 'P0001';
    end if;
    if new.status = 'ENDED' and (new.started_at is distinct from old.started_at) then
      raise exception 'LIFETIME_INVARIANT_VIOLATION: an ended seat keeps its start' using errcode = 'P0001';
    end if;
  else
    if new.status not in ('PENDING', 'ACTIVE') then
      raise exception 'LIFETIME_INVARIANT_VIOLATION: a leadership record starts pending or active' using errcode = 'P0001';
    end if;
    select t.origin into v_origin from lifetime_teams t where t.lifetime_team_id = new.lifetime_team_id;
    if new.is_legacy and v_origin is distinct from 'LEGACY_BACKFILL' then
      raise exception 'LIFETIME_INVARIANT_VIOLATION: only a legacy team carries legacy records' using errcode = 'P0001';
    end if;
  end if;

  if new.status = 'ACTIVE' and not new.is_legacy then
    if tg_op = 'INSERT' then
      v_activating := true;
    elsif old.status is distinct from 'ACTIVE' then
      v_activating := true;
    end if;
  end if;
  if v_activating then
    perform lifetime_lock_people(array[new.gaming_member_id]);
    if not exists (select 1 from lifetime_team_memberships m where m.lifetime_team_id = new.lifetime_team_id and m.gaming_member_id = new.gaming_member_id and m.status = 'ACTIVE') then
      raise exception 'LIFETIME_NOT_A_MEMBER: a leader must be an active member of the team' using errcode = 'P0001';
    end if;
    if exists (select 1 from lifetime_team_memberships m where m.gaming_member_id = new.gaming_member_id and m.status = 'ACTIVE' and not m.is_legacy
                  and m.lifetime_team_id <> new.lifetime_team_id)
       or exists (select 1 from lifetime_team_leaderships l where l.gaming_member_id = new.gaming_member_id and l.status = 'ACTIVE' and not l.is_legacy
                  and l.lifetime_team_leadership_id <> new.lifetime_team_leadership_id) then
      raise exception 'LIFETIME_LEADER_MUST_BELONG_TO_ONE_TEAM: a captain or sub-captain belongs to one team only' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$function$;
revoke all on function lifetime_leadership_guard() from public, anon, authenticated;
revoke all on function lifetime_leadership_guard() from service_role;
create trigger lifetime_leadership_guard before insert or update or delete on lifetime_team_leaderships for each row execute function lifetime_leadership_guard();

-- The entry guard on competition_teams. A V1 row is untouched (its flow columns may not change). A LIFETIME entry exists only in a competition that enabled the
-- lifetime flow and is created only by the entry operation (which marks the transaction, urbano.lifetime_entry_transition = 'enter'); its snapshot never changes, and
-- neither do its own id or its competition (for any team row); its status can only move PENDING_ORGANIZER_APPROVAL to REJECTED, and only inside the withdrawal operation
-- (mark 'on') — so the V1 decision functions can neither approve nor reject an entry, and no V1 team can be added to a lifetime-flow competition. The leaders an entry
-- names are held to one team per competition here (the claims guard holds the players). Every refusal on a V1 path is a bounded refusal the application already understands.
create function competition_teams_lifetime_entry_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
declare
  v_flow boolean;
begin
  if tg_op = 'INSERT' then
    select exists (select 1 from competition_lifetime_flows f where f.competition_id = new.competition_id) into v_flow;
    if new.entry_flow = 'LIFETIME' then
      if not v_flow then
        raise exception 'LIFETIME_FLOW_NOT_ENABLED: this competition has not enabled the lifetime flow' using errcode = 'P0001';
      end if;
      if new.status <> 'PENDING_ORGANIZER_APPROVAL' or new.provenance <> 'MEMBER_PROPOSED' then
        raise exception 'LIFETIME_INVARIANT_VIOLATION: an entry starts pending and member-proposed' using errcode = 'P0001';
      end if;
      -- Only the entry operation creates an entry: it reads the team and its leaders under their locks and marks this transaction around its INSERT.
      if coalesce(current_setting('urbano.lifetime_entry_transition', true), '') is distinct from 'enter' then
        raise exception 'LIFETIME_INVARIANT_VIOLATION: an entry is created only by the entry operation' using errcode = 'P0001';
      end if;
      -- A person represents ONE team in a competition, and that includes the captain and sub-captain this entry names: neither may already lead another live entry or
      -- hold an accepted roster place. The competition lock is the operation's own, taken again here so that a direct write is serialized with everything else.
      perform pg_advisory_xact_lock(hashtext('competition_scope:' || new.competition_id::text));
      if exists (select 1 from competition_lifetime_freezes f where f.competition_id = new.competition_id) then
        raise exception 'LIFETIME_ENTRIES_FROZEN: the entries of this competition are frozen' using errcode = 'P0001';
      end if;
      if exists (select 1 from competition_teams e where e.competition_id = new.competition_id and e.entry_flow = 'LIFETIME' and e.status <> 'REJECTED'
                   and (e.captain_gaming_member_id in (new.captain_gaming_member_id, new.sub_captain_gaming_member_id)
                        or e.sub_captain_gaming_member_id in (new.captain_gaming_member_id, new.sub_captain_gaming_member_id)))
         or exists (select 1 from competition_lifetime_roster_claims c where c.competition_id = new.competition_id and c.status = 'ACCEPTED'
                      and c.gaming_member_id in (new.captain_gaming_member_id, new.sub_captain_gaming_member_id)) then
        raise exception 'LIFETIME_PERSON_REPRESENTS_ANOTHER_TEAM: a person represents only one team in a competition' using errcode = 'P0001';
      end if;
    elsif v_flow then
      raise exception 'TEAM_REGISTRATION_NOT_OPEN: registration is closed for this competition' using errcode = 'P0001';
    end if;
    return new;
  elsif tg_op = 'UPDATE' then
    if new.competition_team_id is distinct from old.competition_team_id or new.competition_id is distinct from old.competition_id then
      raise exception 'LIFETIME_INVARIANT_VIOLATION: a team entry keeps its identity and its competition' using errcode = 'P0001';
    end if;
    if new.entry_flow is distinct from old.entry_flow or new.lifetime_team_id is distinct from old.lifetime_team_id
       or new.sub_captain_gaming_member_id is distinct from old.sub_captain_gaming_member_id then
      raise exception 'LIFETIME_INVARIANT_VIOLATION: the lifetime columns of an entry never change' using errcode = 'P0001';
    end if;
    if old.entry_flow = 'LIFETIME' then
      if new.name is distinct from old.name or new.captain_gaming_member_id is distinct from old.captain_gaming_member_id
         or new.provenance is distinct from old.provenance or new.created_at is distinct from old.created_at or new.public_code is distinct from old.public_code then
        raise exception 'LIFETIME_INVARIANT_VIOLATION: an entry keeps the snapshot it was made with' using errcode = 'P0001';
      end if;
      if new.status is distinct from old.status then
        if not (old.status = 'PENDING_ORGANIZER_APPROVAL' and new.status = 'REJECTED' and coalesce(current_setting('urbano.lifetime_entry_transition', true), '') = 'on') then
          raise exception 'TEAM_REGISTRATION_NOT_OPEN: registration is closed for this competition' using errcode = 'P0001';
        end if;
      elsif new.decided_at is distinct from old.decided_at or new.decided_by_gaming_member_id is distinct from old.decided_by_gaming_member_id
            or new.rejection_reason is distinct from old.rejection_reason then
        raise exception 'LIFETIME_INVARIANT_VIOLATION: an entry changes only through the lifetime operations' using errcode = 'P0001';
      end if;
    end if;
    return new;
  end if;
  if old.entry_flow = 'LIFETIME' then
    raise exception 'LIFETIME_INVARIANT_VIOLATION: an entry is never deleted' using errcode = 'P0001';
  end if;
  return old;
end;
$function$;
revoke all on function competition_teams_lifetime_entry_guard() from public, anon, authenticated;
revoke all on function competition_teams_lifetime_entry_guard() from service_role;
create trigger competition_teams_lifetime_entry_guard before insert or update or delete on competition_teams for each row execute function competition_teams_lifetime_entry_guard();

-- A lifetime-flow competition can never have a V1 registration freeze or a fixture: nothing downstream may consume an entry that is not fully migrated.
create function competition_registration_freezes_lifetime_flow_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
begin
  if exists (select 1 from competition_lifetime_flows f where f.competition_id = new.competition_id) then
    raise exception 'REGISTRATION_FREEZE_INVALID: a lifetime-flow competition has no legacy registration freeze' using errcode = 'P0001';
  end if;
  return new;
end;
$function$;
revoke all on function competition_registration_freezes_lifetime_flow_guard() from public, anon, authenticated;
revoke all on function competition_registration_freezes_lifetime_flow_guard() from service_role;
create trigger competition_registration_freezes_lifetime_flow_guard before insert on competition_registration_freezes for each row execute function competition_registration_freezes_lifetime_flow_guard();

create function competition_fixtures_lifetime_flow_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
begin
  if exists (select 1 from competition_lifetime_flows f where f.competition_id = new.competition_id) then
    raise exception 'COMPETITION_NOT_READY_TO_PUBLISH: a lifetime-flow competition cannot publish fixtures yet' using errcode = 'P0001';
  end if;
  return new;
end;
$function$;
revoke all on function competition_fixtures_lifetime_flow_guard() from public, anon, authenticated;
revoke all on function competition_fixtures_lifetime_flow_guard() from service_role;
create trigger competition_fixtures_lifetime_flow_guard before insert on competition_fixtures for each row execute function competition_fixtures_lifetime_flow_guard();

-- Claims: created as proposals in an open lifetime competition; move only PROPOSED to a decision and ACCEPTED to a release; after the freeze nothing changes
-- but the dating of a departure; never deleted. An accepted claim needs an active member of the team and a live entry.
create function competition_lifetime_roster_claims_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
declare
  v_frozen boolean;
  v_live boolean;
begin
  if tg_op = 'DELETE' then
    raise exception 'LIFETIME_INVARIANT_VIOLATION: a roster claim is never deleted' using errcode = 'P0001';
  end if;
  select exists (select 1 from competition_lifetime_freezes f where f.competition_id = new.competition_id) into v_frozen;
  if tg_op = 'INSERT' then
    if v_frozen then
      raise exception 'LIFETIME_ENTRIES_FROZEN: the entries of this competition are frozen' using errcode = 'P0001';
    end if;
    if new.status <> 'PROPOSED' then
      raise exception 'LIFETIME_INVARIANT_VIOLATION: a claim starts as a proposal' using errcode = 'P0001';
    end if;
    select (e.status <> 'REJECTED' and e.entry_flow = 'LIFETIME') into v_live from competition_teams e where e.competition_team_id = new.competition_team_id;
    if not coalesce(v_live, false) then
      raise exception 'LIFETIME_ENTRY_NOT_LIVE: the entry is not live' using errcode = 'P0001';
    end if;
    return new;
  end if;
  if new.competition_lifetime_roster_claim_id is distinct from old.competition_lifetime_roster_claim_id or new.seq is distinct from old.seq
     or new.competition_id is distinct from old.competition_id or new.competition_team_id is distinct from old.competition_team_id
     or new.lifetime_team_id is distinct from old.lifetime_team_id or new.gaming_member_id is distinct from old.gaming_member_id
     or new.proposed_by_gaming_member_id is distinct from old.proposed_by_gaming_member_id or new.proposed_at is distinct from old.proposed_at
     or new.expires_at is distinct from old.expires_at then
    raise exception 'LIFETIME_INVARIANT_VIOLATION: a claim keeps what it recorded' using errcode = 'P0001';
  end if;
  if v_frozen then
    -- After the freeze the only change is dating a departure of an accepted claim.
    if old.status = 'ACCEPTED' and new.status = 'ACCEPTED' and old.departed_at is null and new.departed_at is not null
       and new.accepted_at is not distinct from old.accepted_at and new.decided_at is not distinct from old.decided_at
       and new.released_at is null and new.release_reason is null then
      return new;
    end if;
    raise exception 'LIFETIME_ENTRIES_FROZEN: the entries of this competition are frozen' using errcode = 'P0001';
  end if;
  if new.departed_at is not null or new.departure_reason is not null then
    raise exception 'LIFETIME_INVARIANT_VIOLATION: a departure is dated only after the freeze' using errcode = 'P0001';
  end if;
  if not ((old.status = 'PROPOSED' and new.status in ('ACCEPTED', 'REJECTED', 'WITHDRAWN', 'EXPIRED')) or (old.status = 'ACCEPTED' and new.status in ('WITHDRAWN', 'REMOVED'))) then
    raise exception 'LIFETIME_INVARIANT_VIOLATION: a claim moves forward only' using errcode = 'P0001';
  end if;
  if new.status = 'ACCEPTED' then
    if not exists (select 1 from lifetime_team_memberships m where m.lifetime_team_id = new.lifetime_team_id and m.gaming_member_id = new.gaming_member_id and m.status = 'ACTIVE') then
      raise exception 'LIFETIME_CLAIM_SUBJECT_NOT_MEMBER: only an active member of the team can be on its roster' using errcode = 'P0001';
    end if;
    select (e.status <> 'REJECTED') into v_live from competition_teams e where e.competition_team_id = new.competition_team_id;
    if not coalesce(v_live, false) then
      raise exception 'LIFETIME_ENTRY_NOT_LIVE: the entry is not live' using errcode = 'P0001';
    end if;
    -- A person represents ONE team in a competition: nobody who is captain or sub-captain of record of a DIFFERENT live entry can take a roster place here.
    perform pg_advisory_xact_lock(hashtext('competition_scope:' || new.competition_id::text));
    if exists (select 1 from competition_teams e where e.competition_id = new.competition_id and e.entry_flow = 'LIFETIME' and e.status <> 'REJECTED'
                 and e.competition_team_id is distinct from new.competition_team_id
                 and (e.captain_gaming_member_id = new.gaming_member_id or e.sub_captain_gaming_member_id = new.gaming_member_id)) then
      raise exception 'LIFETIME_PERSON_REPRESENTS_ANOTHER_TEAM: a person represents only one team in a competition' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$function$;
revoke all on function competition_lifetime_roster_claims_guard() from public, anon, authenticated;
revoke all on function competition_lifetime_roster_claims_guard() from service_role;
create trigger competition_lifetime_roster_claims_guard before insert or update or delete on competition_lifetime_roster_claims for each row execute function competition_lifetime_roster_claims_guard();

-- 6/9  Teams: create, disband.
create function create_lifetime_team_atomically(p_creator_gaming_member_id uuid, p_name text)
 returns table(lifetime_team_id uuid, public_code text, created_at timestamptz)
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
#variable_conflict use_column
declare
  v_name text;
  v_now timestamptz;
  v_team_id uuid;
  v_code text;
begin
  v_name := btrim(regexp_replace(coalesce(p_name, ''), '\s+', ' ', 'g'));
  if char_length(v_name) < 2 or char_length(v_name) > 60 or v_name ~ '[[:cntrl:]]' then
    raise exception 'LIFETIME_NAME_INVALID: a team name has 2 to 60 characters and no control characters' using errcode = 'P0001';
  end if;
  perform lifetime_lock_people(array[p_creator_gaming_member_id]);
  if not exists (select 1 from gaming_members g where g.gaming_member_id = p_creator_gaming_member_id) then
    raise exception 'LIFETIME_PERSON_NOT_FOUND: no such member exists' using errcode = 'P0001';
  end if;
  if exists (select 1 from lifetime_team_memberships m where m.gaming_member_id = p_creator_gaming_member_id and m.status = 'ACTIVE' and not m.is_legacy)
     or exists (select 1 from lifetime_team_leaderships l where l.gaming_member_id = p_creator_gaming_member_id and l.status = 'ACTIVE' and not l.is_legacy) then
    raise exception 'LIFETIME_LEADER_MUST_BELONG_TO_ONE_TEAM: leave your other teams before creating one' using errcode = 'P0001';
  end if;
  v_now := lifetime_clock();
  begin
    insert into lifetime_teams (name, created_by_gaming_member_id, created_at) values (v_name, p_creator_gaming_member_id, v_now)
    returning lifetime_teams.lifetime_team_id, lifetime_teams.public_code into v_team_id, v_code;
  exception
    when unique_violation then
      if sqlerrm like '%lifetime_teams_active_name_key%' then
        raise exception 'LIFETIME_NAME_TAKEN: an active team already has this name' using errcode = 'P0001';
      end if;
      raise;
  end;
  insert into lifetime_team_memberships (lifetime_team_id, gaming_member_id, status, initiated_by_side, initiated_by_gaming_member_id, created_at, decided_at, decided_by_gaming_member_id, joined_at)
  values (v_team_id, p_creator_gaming_member_id, 'ACTIVE', 'PERSON', p_creator_gaming_member_id, v_now, v_now, p_creator_gaming_member_id, v_now);
  insert into lifetime_team_leaderships (lifetime_team_id, gaming_member_id, role, status, offered_by_gaming_member_id, created_at, decided_at, started_at)
  values (v_team_id, p_creator_gaming_member_id, 'CAPTAIN', 'ACTIVE', p_creator_gaming_member_id, v_now, v_now, v_now);
  insert into lifetime_team_events (lifetime_team_id, event_type, actor_gaming_member_id, subject_gaming_member_id, occurred_at, details) values
    (v_team_id, 'TEAM_CREATED', p_creator_gaming_member_id, p_creator_gaming_member_id, v_now, jsonb_build_object('origin', 'NEW')),
    (v_team_id, 'MEMBERSHIP_ACTIVATED', p_creator_gaming_member_id, p_creator_gaming_member_id, v_now, jsonb_build_object('initiated_by_side', 'PERSON')),
    (v_team_id, 'LEADERSHIP_ACTIVATED', p_creator_gaming_member_id, p_creator_gaming_member_id, v_now, jsonb_build_object('role', 'CAPTAIN'));
  return query select v_team_id, v_code, v_now;
end;
$function$;
revoke all on function create_lifetime_team_atomically(uuid, text) from public, anon, authenticated;
grant execute on function create_lifetime_team_atomically(uuid, text) to service_role;

create function disband_lifetime_team_atomically(p_lifetime_team_id uuid, p_actor_gaming_member_id uuid)
 returns table(lifetime_team_id uuid, status text, disbanded_at timestamptz)
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
#variable_conflict use_column
declare
  v_status text;
  v_role text;
  v_now timestamptz;
  v_competition uuid;
  v_stamp timestamptz;
  v_frozen_at timestamptz;
begin
  select t.status into v_status from lifetime_teams t where t.lifetime_team_id = p_lifetime_team_id for update;
  if v_status is null then
    raise exception 'LIFETIME_TEAM_NOT_FOUND: no such team exists' using errcode = 'P0001';
  end if;
  -- Authorization first: a disbanded team has no leaders, so everyone but a current captain gets the same answer.
  select l.role into v_role from lifetime_team_leaderships l where l.lifetime_team_id = p_lifetime_team_id and l.gaming_member_id = p_actor_gaming_member_id and l.status = 'ACTIVE';
  if v_role is distinct from 'CAPTAIN' then
    raise exception 'LIFETIME_NOT_THE_CAPTAIN: only the captain can do this' using errcode = 'P0001';
  end if;
  if v_status <> 'ACTIVE' then
    raise exception 'LIFETIME_TEAM_NOT_ACTIVE: this team has been disbanded' using errcode = 'P0001';
  end if;
  if exists (select 1 from competition_teams e join competitions c on c.competition_id = e.competition_id
              where e.lifetime_team_id = p_lifetime_team_id and e.status <> 'REJECTED' and c.state <> 'CANCELLED_WITHOUT_CHAMPION') then
    raise exception 'LIFETIME_TEAM_HAS_LIVE_ENTRIES: withdraw the team from its competitions before disbanding it' using errcode = 'P0001';
  end if;
  v_now := lifetime_clock();
  -- The only live entries left sit in cancelled competitions. Their open claims are settled like any other departure: released before the competition's freeze, dated
  -- after it. Each competition is locked on its own, in lock-key order (team, then competition: the order of every operation).
  for v_competition in
    select d.competition_id from (select distinct c.competition_id from competition_lifetime_roster_claims c
                                   where c.lifetime_team_id = p_lifetime_team_id and c.status in ('PROPOSED', 'ACCEPTED')) d
     order by hashtext('competition_scope:' || d.competition_id::text), d.competition_id
  loop
    perform pg_advisory_xact_lock(hashtext('competition_scope:' || v_competition::text));
    perform 1 from competitions c where c.competition_id = v_competition for update;
    v_stamp := lifetime_clock();
    select f.frozen_at into v_frozen_at from competition_lifetime_freezes f where f.competition_id = v_competition;
    if v_frozen_at is not null then
      update competition_lifetime_roster_claims c set departed_at = greatest(v_stamp, v_frozen_at), departure_reason = 'TEAM_DISBANDED'
       where c.competition_id = v_competition and c.lifetime_team_id = p_lifetime_team_id and c.status = 'ACCEPTED' and c.departed_at is null;
    else
      update competition_lifetime_roster_claims c
         set status = case when c.status = 'ACCEPTED' then 'REMOVED' else 'WITHDRAWN' end, released_at = v_stamp, released_by_gaming_member_id = p_actor_gaming_member_id, release_reason = 'TEAM_DISBANDED'
       where c.competition_id = v_competition and c.lifetime_team_id = p_lifetime_team_id and c.status in ('PROPOSED', 'ACCEPTED');
    end if;
  end loop;
  -- Every membership and seat the disband ends has its own event, in the order the rows were made.
  with ended as (
    update lifetime_team_memberships m set status = 'ENDED', ended_at = v_now, ended_by_gaming_member_id = p_actor_gaming_member_id, end_reason = 'TEAM_DISBANDED'
     where m.lifetime_team_id = p_lifetime_team_id and m.status in ('PENDING', 'ACTIVE')
    returning m.lifetime_team_membership_id, m.gaming_member_id, m.joined_at, m.seq)
  insert into lifetime_team_events (lifetime_team_id, event_type, actor_gaming_member_id, subject_gaming_member_id, related_id, occurred_at, details)
  select p_lifetime_team_id, 'MEMBERSHIP_ENDED', p_actor_gaming_member_id, e.gaming_member_id, e.lifetime_team_membership_id, v_now,
         jsonb_build_object('end_reason', 'TEAM_DISBANDED', 'was_member', e.joined_at is not null)
    from ended e order by e.seq;
  with ended as (
    update lifetime_team_leaderships l set status = 'ENDED', ended_at = v_now, ended_by_gaming_member_id = p_actor_gaming_member_id, end_reason = 'TEAM_DISBANDED'
     where l.lifetime_team_id = p_lifetime_team_id and l.status in ('PENDING', 'ACTIVE')
    returning l.lifetime_team_leadership_id, l.gaming_member_id, l.role, l.seq)
  insert into lifetime_team_events (lifetime_team_id, event_type, actor_gaming_member_id, subject_gaming_member_id, related_id, occurred_at, details)
  select p_lifetime_team_id, 'LEADERSHIP_ENDED', p_actor_gaming_member_id, e.gaming_member_id, e.lifetime_team_leadership_id, v_now,
         jsonb_build_object('role', e.role, 'end_reason', 'TEAM_DISBANDED')
    from ended e order by e.seq;
  update lifetime_teams t set status = 'DISBANDED', disbanded_at = v_now, disbanded_by_gaming_member_id = p_actor_gaming_member_id where t.lifetime_team_id = p_lifetime_team_id;
  insert into lifetime_team_events (lifetime_team_id, event_type, actor_gaming_member_id, occurred_at) values (p_lifetime_team_id, 'TEAM_DISBANDED', p_actor_gaming_member_id, v_now);
  return query select p_lifetime_team_id, 'DISBANDED'::text, v_now;
end;
$function$;
revoke all on function disband_lifetime_team_atomically(uuid, uuid) from public, anon, authenticated;
grant execute on function disband_lifetime_team_atomically(uuid, uuid) to service_role;

-- 7/9  Membership and leadership.
create function propose_lifetime_team_membership_atomically(p_lifetime_team_id uuid, p_actor_gaming_member_id uuid, p_subject_gaming_member_id uuid)
 returns table(lifetime_team_membership_id uuid, status text, initiated_by_side text, expires_at timestamptz)
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
#variable_conflict use_column
declare
  v_status text;
  v_role text;
  v_side text;
  v_now timestamptz;
  v_id uuid;
  v_expires timestamptz;
begin
  perform lifetime_lock_people(array[p_actor_gaming_member_id, p_subject_gaming_member_id]);
  select t.status into v_status from lifetime_teams t where t.lifetime_team_id = p_lifetime_team_id for update;
  if v_status is null then
    raise exception 'LIFETIME_TEAM_NOT_FOUND: no such team exists' using errcode = 'P0001';
  end if;
  -- Authorization first: a person asks for themselves (a caller with no identity is nobody); anyone else must be a leader of this team before being told anything about it.
  select l.role into v_role from lifetime_team_leaderships l where l.lifetime_team_id = p_lifetime_team_id and l.gaming_member_id = p_actor_gaming_member_id and l.status = 'ACTIVE';
  if p_actor_gaming_member_id is not null and p_actor_gaming_member_id = p_subject_gaming_member_id then
    v_side := 'PERSON';
  elsif v_role is not null then
    v_side := 'TEAM';
  else
    raise exception 'LIFETIME_NOT_A_LEADER: only a captain or sub-captain can do this' using errcode = 'P0001';
  end if;
  if v_status <> 'ACTIVE' then
    raise exception 'LIFETIME_TEAM_NOT_ACTIVE: this team has been disbanded' using errcode = 'P0001';
  end if;
  if not exists (select 1 from gaming_members g where g.gaming_member_id = p_subject_gaming_member_id) then
    raise exception 'LIFETIME_PERSON_NOT_FOUND: no such member exists' using errcode = 'P0001';
  end if;
  if exists (select 1 from lifetime_team_memberships m where m.lifetime_team_id = p_lifetime_team_id and m.gaming_member_id = p_subject_gaming_member_id and m.status = 'ACTIVE') then
    raise exception 'LIFETIME_ALREADY_MEMBER: this person already belongs to the team' using errcode = 'P0001';
  end if;
  v_now := lifetime_clock();
  -- A lapsed offer is dated at its expiry, not at the moment something noticed it.
  update lifetime_team_memberships m set status = 'ENDED', ended_at = m.expires_at, end_reason = 'EXPIRED'
   where m.lifetime_team_id = p_lifetime_team_id and m.gaming_member_id = p_subject_gaming_member_id and m.status = 'PENDING' and m.expires_at <= v_now;
  if v_side = 'PERSON' then
    -- A request is the person's own information: refuse at once what could never be accepted. (An invitation is not judged here: that would disclose the person's other teams.)
    if exists (select 1 from lifetime_team_leaderships l where l.gaming_member_id = p_subject_gaming_member_id and l.status = 'ACTIVE' and not l.is_legacy and l.lifetime_team_id <> p_lifetime_team_id) then
      raise exception 'LIFETIME_LEADER_CANNOT_JOIN_OTHER_TEAM: a captain or sub-captain belongs to one team only' using errcode = 'P0001';
    end if;
    if (select count(*) from lifetime_team_memberships m where m.gaming_member_id = p_subject_gaming_member_id and m.status = 'ACTIVE' and not m.is_legacy and m.lifetime_team_id <> p_lifetime_team_id) >= 2 then
      raise exception 'LIFETIME_MEMBERSHIP_CAP_REACHED: a person may belong to at most two teams at once' using errcode = 'P0001';
    end if;
  end if;
  begin
    insert into lifetime_team_memberships (lifetime_team_id, gaming_member_id, status, initiated_by_side, initiated_by_gaming_member_id, created_at, expires_at)
    values (p_lifetime_team_id, p_subject_gaming_member_id, 'PENDING', v_side, p_actor_gaming_member_id, v_now, v_now + interval '7 days')
    returning lifetime_team_memberships.lifetime_team_membership_id, lifetime_team_memberships.expires_at into v_id, v_expires;
  exception
    when unique_violation then
      if sqlerrm like '%lifetime_team_memberships_one_pending%' then
        raise exception 'LIFETIME_OFFER_ALREADY_PENDING: an offer for this person and team is already waiting for an answer' using errcode = 'P0001';
      end if;
      raise;
  end;
  insert into lifetime_team_events (lifetime_team_id, event_type, actor_gaming_member_id, subject_gaming_member_id, related_id, occurred_at, details)
  values (p_lifetime_team_id, 'MEMBERSHIP_OFFERED', p_actor_gaming_member_id, p_subject_gaming_member_id, v_id, v_now, jsonb_build_object('initiated_by_side', v_side));
  return query select v_id, 'PENDING'::text, v_side, v_expires;
end;
$function$;
revoke all on function propose_lifetime_team_membership_atomically(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function propose_lifetime_team_membership_atomically(uuid, uuid, uuid) to service_role;

create function decide_lifetime_team_membership_atomically(p_lifetime_team_membership_id uuid, p_actor_gaming_member_id uuid, p_decision text)
 returns table(lifetime_team_membership_id uuid, status text, joined_at timestamptz)
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
#variable_conflict use_column
declare
  v_team uuid;
  v_subject uuid;
  v_team_status text;
  v_status text;
  v_side text;
  v_initiator uuid;
  v_expires timestamptz;
  v_now timestamptz;
begin
  select m.lifetime_team_id, m.gaming_member_id, m.initiated_by_side, m.initiated_by_gaming_member_id into v_team, v_subject, v_side, v_initiator
    from lifetime_team_memberships m where m.lifetime_team_membership_id = p_lifetime_team_membership_id;
  if v_team is null then
    raise exception 'LIFETIME_OFFER_NOT_FOUND: no such offer exists' using errcode = 'P0001';
  end if;
  if p_decision is distinct from 'ACCEPT' and p_decision is distinct from 'DECLINE' then
    raise exception 'LIFETIME_DECISION_INVALID: the decision must be ACCEPT or DECLINE' using errcode = 'P0001';
  end if;
  perform lifetime_lock_people(array[v_subject, p_actor_gaming_member_id]);
  select t.status into v_team_status from lifetime_teams t where t.lifetime_team_id = v_team for update;
  -- Authorization first (the side and the subject of an offer never change): the OTHER side decides — the person for an invitation, a captain or sub-captain for a request.
  if v_side = 'TEAM' then
    if p_actor_gaming_member_id is distinct from v_subject then
      raise exception 'LIFETIME_OFFER_WRONG_PARTY: only the other side of this offer can answer it' using errcode = 'P0001';
    end if;
  elsif not exists (select 1 from lifetime_team_leaderships l where l.lifetime_team_id = v_team and l.gaming_member_id = p_actor_gaming_member_id and l.status = 'ACTIVE') then
    raise exception 'LIFETIME_OFFER_WRONG_PARTY: only the other side of this offer can answer it' using errcode = 'P0001';
  end if;
  select m.status, m.expires_at into v_status, v_expires from lifetime_team_memberships m where m.lifetime_team_membership_id = p_lifetime_team_membership_id for update;
  if v_status <> 'PENDING' then
    raise exception 'LIFETIME_OFFER_NOT_PENDING: this offer has already been answered or withdrawn' using errcode = 'P0001';
  end if;
  v_now := lifetime_clock();
  if v_expires <= v_now then
    raise exception 'LIFETIME_OFFER_EXPIRED: this offer has lapsed' using errcode = 'P0001';
  end if;
  if p_decision = 'DECLINE' then
    update lifetime_team_memberships m set status = 'ENDED', ended_at = v_now, ended_by_gaming_member_id = p_actor_gaming_member_id, end_reason = 'DECLINED',
           decided_at = v_now, decided_by_gaming_member_id = p_actor_gaming_member_id
     where m.lifetime_team_membership_id = p_lifetime_team_membership_id;
    insert into lifetime_team_events (lifetime_team_id, event_type, actor_gaming_member_id, subject_gaming_member_id, related_id, occurred_at)
    values (v_team, 'MEMBERSHIP_DECLINED', p_actor_gaming_member_id, v_subject, p_lifetime_team_membership_id, v_now);
    return query select p_lifetime_team_membership_id, 'ENDED'::text, null::timestamptz;
    return;
  end if;
  if v_team_status <> 'ACTIVE' then
    raise exception 'LIFETIME_TEAM_NOT_ACTIVE: this team has been disbanded' using errcode = 'P0001';
  end if;
  -- An invitation stands only while the leader who made it still leads: ending that leader's seat ends their pending invitations (this is the table's own backstop).
  if v_side = 'TEAM' and not exists (select 1 from lifetime_team_leaderships l where l.lifetime_team_id = v_team and l.gaming_member_id = v_initiator and l.status = 'ACTIVE') then
    raise exception 'LIFETIME_OFFER_NOT_PENDING: this offer has already been answered or withdrawn' using errcode = 'P0001';
  end if;
  -- What the person's own acceptance judges is the person's own information. The leader who decides a REQUEST is told only that it cannot be accepted, never why: the
  -- reason would disclose which other teams the person belongs to or leads.
  if exists (select 1 from lifetime_team_leaderships l where l.gaming_member_id = v_subject and l.status = 'ACTIVE' and not l.is_legacy and l.lifetime_team_id <> v_team) then
    if v_side = 'PERSON' then
      raise exception 'LIFETIME_REQUEST_NOT_ACCEPTABLE: this request cannot be accepted' using errcode = 'P0001';
    end if;
    raise exception 'LIFETIME_LEADER_CANNOT_JOIN_OTHER_TEAM: a captain or sub-captain belongs to one team only' using errcode = 'P0001';
  end if;
  if (select count(*) from lifetime_team_memberships m where m.gaming_member_id = v_subject and m.status = 'ACTIVE' and not m.is_legacy and m.lifetime_team_id <> v_team) >= 2 then
    if v_side = 'PERSON' then
      raise exception 'LIFETIME_REQUEST_NOT_ACCEPTABLE: this request cannot be accepted' using errcode = 'P0001';
    end if;
    raise exception 'LIFETIME_MEMBERSHIP_CAP_REACHED: a person may belong to at most two teams at once' using errcode = 'P0001';
  end if;
  -- A person who already belongs to the team cannot be admitted a second time (the offer stays pending until it is answered, withdrawn or lapses). The one-active index
  -- is the last word; whichever of the two answers first, the caller meets a coded refusal, never a raw unique violation.
  if exists (select 1 from lifetime_team_memberships m where m.lifetime_team_id = v_team and m.gaming_member_id = v_subject and m.status = 'ACTIVE') then
    raise exception 'LIFETIME_ALREADY_MEMBER: this person already belongs to the team' using errcode = 'P0001';
  end if;
  begin
    update lifetime_team_memberships m set status = 'ACTIVE', joined_at = v_now, decided_at = v_now, decided_by_gaming_member_id = p_actor_gaming_member_id
     where m.lifetime_team_membership_id = p_lifetime_team_membership_id;
  exception
    when unique_violation then
      if sqlerrm like '%lifetime_team_memberships_one_active%' then
        raise exception 'LIFETIME_ALREADY_MEMBER: this person already belongs to the team' using errcode = 'P0001';
      end if;
      raise;
  end;
  insert into lifetime_team_events (lifetime_team_id, event_type, actor_gaming_member_id, subject_gaming_member_id, related_id, occurred_at)
  values (v_team, 'MEMBERSHIP_ACTIVATED', p_actor_gaming_member_id, v_subject, p_lifetime_team_membership_id, v_now);
  return query select p_lifetime_team_membership_id, 'ACTIVE'::text, v_now;
end;
$function$;
revoke all on function decide_lifetime_team_membership_atomically(uuid, uuid, text) from public, anon, authenticated;
grant execute on function decide_lifetime_team_membership_atomically(uuid, uuid, text) to service_role;

create function withdraw_lifetime_team_offer_atomically(p_offer_kind text, p_offer_id uuid, p_actor_gaming_member_id uuid)
 returns table(offer_id uuid, status text)
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
#variable_conflict use_column
declare
  v_team uuid;
  v_subject uuid;
  v_status text;
  v_initiator uuid;
  v_side text;
  v_leader boolean;
  v_now timestamptz;
begin
  if p_offer_kind is distinct from 'MEMBERSHIP' and p_offer_kind is distinct from 'LEADERSHIP' then
    raise exception 'LIFETIME_DECISION_INVALID: the offer kind must be MEMBERSHIP or LEADERSHIP' using errcode = 'P0001';
  end if;
  if p_offer_kind = 'MEMBERSHIP' then
    select m.lifetime_team_id, m.gaming_member_id into v_team, v_subject from lifetime_team_memberships m where m.lifetime_team_membership_id = p_offer_id;
  else
    select l.lifetime_team_id, l.gaming_member_id into v_team, v_subject from lifetime_team_leaderships l where l.lifetime_team_leadership_id = p_offer_id;
  end if;
  if v_team is null then
    raise exception 'LIFETIME_OFFER_NOT_FOUND: no such offer exists' using errcode = 'P0001';
  end if;
  perform 1 from lifetime_teams t where t.lifetime_team_id = v_team for update;
  v_now := lifetime_clock();
  select exists (select 1 from lifetime_team_leaderships l where l.lifetime_team_id = v_team and l.gaming_member_id = p_actor_gaming_member_id and l.status = 'ACTIVE') into v_leader;
  if p_offer_kind = 'MEMBERSHIP' then
    select m.status, m.initiated_by_gaming_member_id, m.initiated_by_side into v_status, v_initiator, v_side from lifetime_team_memberships m where m.lifetime_team_membership_id = p_offer_id for update;
    -- The side that made an offer withdraws it: the person who asked, or — for an invitation — the leader who made it or ANY current leader of the team.
    if p_actor_gaming_member_id is distinct from v_initiator and not (v_side = 'TEAM' and v_leader) then
      raise exception 'LIFETIME_OFFER_WRONG_PARTY: only the side that made this offer can withdraw it' using errcode = 'P0001';
    end if;
    if v_status <> 'PENDING' then
      raise exception 'LIFETIME_OFFER_NOT_PENDING: this offer has already been answered or withdrawn' using errcode = 'P0001';
    end if;
    update lifetime_team_memberships m set status = 'ENDED', ended_at = v_now, ended_by_gaming_member_id = p_actor_gaming_member_id, end_reason = 'WITHDRAWN'
     where m.lifetime_team_membership_id = p_offer_id;
    insert into lifetime_team_events (lifetime_team_id, event_type, actor_gaming_member_id, subject_gaming_member_id, related_id, occurred_at)
    values (v_team, 'MEMBERSHIP_WITHDRAWN', p_actor_gaming_member_id, v_subject, p_offer_id, v_now);
  else
    select l.status, l.offered_by_gaming_member_id into v_status, v_initiator from lifetime_team_leaderships l where l.lifetime_team_leadership_id = p_offer_id for update;
    if p_actor_gaming_member_id is distinct from v_initiator and not v_leader then
      raise exception 'LIFETIME_OFFER_WRONG_PARTY: only the side that made this offer can withdraw it' using errcode = 'P0001';
    end if;
    if v_status <> 'PENDING' then
      raise exception 'LIFETIME_OFFER_NOT_PENDING: this offer has already been answered or withdrawn' using errcode = 'P0001';
    end if;
    update lifetime_team_leaderships l set status = 'ENDED', ended_at = v_now, ended_by_gaming_member_id = p_actor_gaming_member_id, end_reason = 'WITHDRAWN'
     where l.lifetime_team_leadership_id = p_offer_id;
    insert into lifetime_team_events (lifetime_team_id, event_type, actor_gaming_member_id, subject_gaming_member_id, related_id, occurred_at)
    values (v_team, 'LEADERSHIP_WITHDRAWN', p_actor_gaming_member_id, v_subject, p_offer_id, v_now);
  end if;
  return query select p_offer_id, 'ENDED'::text;
end;
$function$;
revoke all on function withdraw_lifetime_team_offer_atomically(text, uuid, uuid) from public, anon, authenticated;
grant execute on function withdraw_lifetime_team_offer_atomically(text, uuid, uuid) to service_role;

-- A person leaves, or a leader removes an ordinary member. A captain leaves only by naming the sub-captain as successor (the only way the captaincy changes
-- hands); a sub-captain who leaves steps down. The person's open claims on the team's entries are released before the freeze and dated after it.
create function end_lifetime_team_membership_atomically(p_lifetime_team_id uuid, p_actor_gaming_member_id uuid, p_subject_gaming_member_id uuid, p_successor_gaming_member_id uuid default null)
 returns table(lifetime_team_membership_id uuid, ended_at timestamptz, successor_leadership_id uuid)
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
#variable_conflict use_column
declare
  v_status text;
  v_membership uuid;
  v_actor_role text;
  v_subject_role text;
  v_removal boolean;
  v_now timestamptz;
  v_captain_seat uuid;
  v_sub_seat uuid;
  v_sub_person uuid;
  v_successor_seat uuid := null;
  v_peek uuid;
  v_competition uuid;
  v_frozen_at timestamptz;
begin
  -- The sub-captain may become the captain, and that activation locks THEIR person: take it now, before the team lock, so the lock order holds.
  select l.gaming_member_id into v_peek from lifetime_team_leaderships l where l.lifetime_team_id = p_lifetime_team_id and l.role = 'SUB_CAPTAIN' and l.status = 'ACTIVE';
  perform lifetime_lock_people(array[p_actor_gaming_member_id, p_subject_gaming_member_id, p_successor_gaming_member_id, v_peek]);
  select t.status into v_status from lifetime_teams t where t.lifetime_team_id = p_lifetime_team_id for update;
  if v_status is null then
    raise exception 'LIFETIME_TEAM_NOT_FOUND: no such team exists' using errcode = 'P0001';
  end if;
  select l.role into v_actor_role from lifetime_team_leaderships l where l.lifetime_team_id = p_lifetime_team_id and l.gaming_member_id = p_actor_gaming_member_id and l.status = 'ACTIVE';
  select l.role into v_subject_role from lifetime_team_leaderships l where l.lifetime_team_id = p_lifetime_team_id and l.gaming_member_id = p_subject_gaming_member_id and l.status = 'ACTIVE';
  -- Authorization first: a person leaves on their own account; removing anyone else needs a seat on this team before anything about it is answered.
  if p_actor_gaming_member_id is not distinct from p_subject_gaming_member_id then
    v_removal := false;
  else
    if v_actor_role is null then
      raise exception 'LIFETIME_NOT_A_LEADER: only a captain or sub-captain can do this' using errcode = 'P0001';
    end if;
    v_removal := true;
  end if;
  select m.lifetime_team_membership_id into v_membership from lifetime_team_memberships m
   where m.lifetime_team_id = p_lifetime_team_id and m.gaming_member_id = p_subject_gaming_member_id and m.status = 'ACTIVE' for update;
  if v_membership is null then
    raise exception 'LIFETIME_NOT_A_MEMBER: this person does not belong to the team' using errcode = 'P0001';
  end if;
  if v_removal and v_subject_role is not null then
    raise exception 'LIFETIME_LEADER_CANNOT_BE_REMOVED: a captain or sub-captain leaves only by handing over' using errcode = 'P0001';
  end if;

  -- The person's open claims on this team's entries are settled at the end, one competition at a time. Every one of those competitions is locked FIRST, in LOCK-KEY order
  -- (the order of the advisory lock itself, so two operations can never wait on each other in a cycle), and the moment of this act is taken only once every lock is held:
  -- the membership period, the seats, the audit events and the claims then all carry the order the locks produced (a person a freeze still counted did not leave before
  -- it). The set of those competitions cannot grow while the team is locked — every operation that creates a claim takes the team lock first — and a freeze only shrinks it.
  for v_competition in
    select d.competition_id from (select distinct c.competition_id from competition_lifetime_roster_claims c
                                   where c.lifetime_team_id = p_lifetime_team_id and c.gaming_member_id = p_subject_gaming_member_id and c.status in ('PROPOSED', 'ACCEPTED')) d
     order by hashtext('competition_scope:' || d.competition_id::text), d.competition_id
  loop
    perform pg_advisory_xact_lock(hashtext('competition_scope:' || v_competition::text));
    perform 1 from competitions c where c.competition_id = v_competition for update;
  end loop;
  v_now := lifetime_clock();

  if v_subject_role = 'CAPTAIN' then
    select l.lifetime_team_leadership_id, l.gaming_member_id into v_sub_seat, v_sub_person from lifetime_team_leaderships l
     where l.lifetime_team_id = p_lifetime_team_id and l.role = 'SUB_CAPTAIN' and l.status = 'ACTIVE' for update;
    if v_sub_person is distinct from v_peek then
      raise exception 'LIFETIME_CONCURRENT_CHANGE: the sub-captain changed while this was being processed; try again' using errcode = 'P0001';
    end if;
    if p_successor_gaming_member_id is not null and p_successor_gaming_member_id is distinct from v_sub_person then
      raise exception 'LIFETIME_SUCCESSOR_INVALID: the successor must be the sub-captain' using errcode = 'P0001';
    end if;
    if v_sub_person is null then
      raise exception 'LIFETIME_CAPTAIN_NEEDS_SUCCESSOR: a captain who leaves must first have a sub-captain to succeed them' using errcode = 'P0001';
    end if;
    select l.lifetime_team_leadership_id into v_captain_seat from lifetime_team_leaderships l
     where l.lifetime_team_id = p_lifetime_team_id and l.role = 'CAPTAIN' and l.status = 'ACTIVE' for update;
    update lifetime_team_leaderships l set status = 'ENDED', ended_at = v_now, ended_by_gaming_member_id = p_actor_gaming_member_id, end_reason = 'SUCCEEDED' where l.lifetime_team_leadership_id = v_captain_seat;
    update lifetime_team_leaderships l set status = 'ENDED', ended_at = v_now, ended_by_gaming_member_id = p_actor_gaming_member_id, end_reason = 'PROMOTED' where l.lifetime_team_leadership_id = v_sub_seat;
    insert into lifetime_team_leaderships (lifetime_team_id, gaming_member_id, role, status, offered_by_gaming_member_id, created_at, decided_at, started_at, predecessor_leadership_id)
    values (p_lifetime_team_id, v_sub_person, 'CAPTAIN', 'ACTIVE', p_actor_gaming_member_id, v_now, v_now, v_now, v_captain_seat)
    returning lifetime_team_leaderships.lifetime_team_leadership_id into v_successor_seat;
    insert into lifetime_team_events (lifetime_team_id, event_type, actor_gaming_member_id, subject_gaming_member_id, related_id, occurred_at, details)
    values (p_lifetime_team_id, 'CAPTAINCY_SUCCEEDED', p_actor_gaming_member_id, v_sub_person, v_successor_seat, v_now,
            jsonb_build_object('former_captain_leadership_id', v_captain_seat, 'former_sub_captain_leadership_id', v_sub_seat));
  elsif v_subject_role = 'SUB_CAPTAIN' then
    update lifetime_team_leaderships l set status = 'ENDED', ended_at = v_now, ended_by_gaming_member_id = p_actor_gaming_member_id, end_reason = 'STEPPED_DOWN'
     where l.lifetime_team_id = p_lifetime_team_id and l.gaming_member_id = p_subject_gaming_member_id and l.status = 'ACTIVE'
    returning l.lifetime_team_leadership_id into v_sub_seat;
    insert into lifetime_team_events (lifetime_team_id, event_type, actor_gaming_member_id, subject_gaming_member_id, related_id, occurred_at, details)
    values (p_lifetime_team_id, 'LEADERSHIP_ENDED', p_actor_gaming_member_id, p_subject_gaming_member_id, v_sub_seat, v_now, jsonb_build_object('role', 'SUB_CAPTAIN', 'end_reason', 'STEPPED_DOWN'));
  end if;

  update lifetime_team_memberships m set status = 'ENDED', ended_at = v_now, ended_by_gaming_member_id = p_actor_gaming_member_id, end_reason = case when v_removal then 'REMOVED' else 'LEFT' end
   where m.lifetime_team_membership_id = v_membership;
  insert into lifetime_team_events (lifetime_team_id, event_type, actor_gaming_member_id, subject_gaming_member_id, related_id, occurred_at, details)
  values (p_lifetime_team_id, 'MEMBERSHIP_ENDED', p_actor_gaming_member_id, p_subject_gaming_member_id, v_membership, v_now, jsonb_build_object('removal', v_removal));

  -- Whatever the person was offered, or offered others, ends with their membership: a seat offer made to them (a re-admitted person must not accept an older offer), and —
  -- when they led — the invitations they made (an invitation stands only while its leader still leads).
  with ended as (
    update lifetime_team_leaderships l set status = 'ENDED', ended_at = v_now, ended_by_gaming_member_id = p_actor_gaming_member_id, end_reason = 'WITHDRAWN'
     where l.lifetime_team_id = p_lifetime_team_id and l.gaming_member_id = p_subject_gaming_member_id and l.status = 'PENDING'
    returning l.lifetime_team_leadership_id, l.role)
  insert into lifetime_team_events (lifetime_team_id, event_type, actor_gaming_member_id, subject_gaming_member_id, related_id, occurred_at, details)
  select p_lifetime_team_id, 'LEADERSHIP_WITHDRAWN', p_actor_gaming_member_id, p_subject_gaming_member_id, e.lifetime_team_leadership_id, v_now,
         jsonb_build_object('role', e.role, 'reason', 'MEMBERSHIP_ENDED')
    from ended e;
  if v_subject_role is not null then
    with ended as (
      update lifetime_team_memberships m set status = 'ENDED', ended_at = v_now, ended_by_gaming_member_id = p_actor_gaming_member_id, end_reason = 'WITHDRAWN'
       where m.lifetime_team_id = p_lifetime_team_id and m.initiated_by_side = 'TEAM' and m.initiated_by_gaming_member_id = p_subject_gaming_member_id and m.status = 'PENDING'
      returning m.lifetime_team_membership_id, m.gaming_member_id, m.seq)
    insert into lifetime_team_events (lifetime_team_id, event_type, actor_gaming_member_id, subject_gaming_member_id, related_id, occurred_at, details)
    select p_lifetime_team_id, 'MEMBERSHIP_WITHDRAWN', p_actor_gaming_member_id, e.gaming_member_id, e.lifetime_team_membership_id, v_now, jsonb_build_object('reason', 'INVITER_LEFT_LEADERSHIP')
      from ended e order by e.seq;
  end if;

  -- The person's open claims on this team's entries: released before a competition's freeze, dated after it. Every lock is already held (above), so what a freeze
  -- recorded cannot change under this settlement and the one moment of the act serves for the claims as for the membership.
  for v_competition in
    select distinct c.competition_id from competition_lifetime_roster_claims c
     where c.lifetime_team_id = p_lifetime_team_id and c.gaming_member_id = p_subject_gaming_member_id and c.status in ('PROPOSED', 'ACCEPTED')
  loop
    select f.frozen_at into v_frozen_at from competition_lifetime_freezes f where f.competition_id = v_competition;
    if v_frozen_at is not null then
      update competition_lifetime_roster_claims c
         set departed_at = greatest(v_now, v_frozen_at), departure_reason = case when v_removal then 'REMOVED_FROM_TEAM' else 'LEFT_TEAM' end
       where c.competition_id = v_competition and c.lifetime_team_id = p_lifetime_team_id and c.gaming_member_id = p_subject_gaming_member_id
         and c.status = 'ACCEPTED' and c.departed_at is null;
    else
      update competition_lifetime_roster_claims c
         set status = case when v_removal and c.status = 'ACCEPTED' then 'REMOVED' else 'WITHDRAWN' end, released_at = v_now, released_by_gaming_member_id = p_actor_gaming_member_id,
             release_reason = case when v_removal then 'REMOVED_FROM_TEAM' else 'LEFT_TEAM' end
       where c.competition_id = v_competition and c.lifetime_team_id = p_lifetime_team_id and c.gaming_member_id = p_subject_gaming_member_id and c.status in ('PROPOSED', 'ACCEPTED');
    end if;
  end loop;
  return query select v_membership, v_now, v_successor_seat;
end;
$function$;
revoke all on function end_lifetime_team_membership_atomically(uuid, uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function end_lifetime_team_membership_atomically(uuid, uuid, uuid, uuid) to service_role;

create function offer_lifetime_team_leadership_atomically(p_lifetime_team_id uuid, p_actor_gaming_member_id uuid, p_subject_gaming_member_id uuid)
 returns table(lifetime_team_leadership_id uuid, status text, expires_at timestamptz)
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
#variable_conflict use_column
declare
  v_status text;
  v_role text;
  v_now timestamptz;
  v_id uuid;
  v_expires timestamptz;
begin
  perform lifetime_lock_people(array[p_actor_gaming_member_id, p_subject_gaming_member_id]);
  select t.status into v_status from lifetime_teams t where t.lifetime_team_id = p_lifetime_team_id for update;
  if v_status is null then
    raise exception 'LIFETIME_TEAM_NOT_FOUND: no such team exists' using errcode = 'P0001';
  end if;
  select l.role into v_role from lifetime_team_leaderships l where l.lifetime_team_id = p_lifetime_team_id and l.gaming_member_id = p_actor_gaming_member_id and l.status = 'ACTIVE';
  if v_role is distinct from 'CAPTAIN' then
    raise exception 'LIFETIME_NOT_THE_CAPTAIN: only the captain can do this' using errcode = 'P0001';
  end if;
  if v_status <> 'ACTIVE' then
    raise exception 'LIFETIME_TEAM_NOT_ACTIVE: this team has been disbanded' using errcode = 'P0001';
  end if;
  if p_subject_gaming_member_id is not distinct from p_actor_gaming_member_id then
    raise exception 'LIFETIME_SEAT_SUBJECT_INVALID: the captain cannot also hold the sub-captain seat' using errcode = 'P0001';
  end if;
  if not exists (select 1 from lifetime_team_memberships m where m.lifetime_team_id = p_lifetime_team_id and m.gaming_member_id = p_subject_gaming_member_id and m.status = 'ACTIVE') then
    raise exception 'LIFETIME_NOT_A_MEMBER: only an active member of the team can be offered the seat' using errcode = 'P0001';
  end if;
  v_now := lifetime_clock();
  update lifetime_team_leaderships l set status = 'ENDED', ended_at = l.expires_at, end_reason = 'EXPIRED'
   where l.lifetime_team_id = p_lifetime_team_id and l.role = 'SUB_CAPTAIN' and l.status = 'PENDING' and l.expires_at <= v_now;
  if exists (select 1 from lifetime_team_leaderships l where l.lifetime_team_id = p_lifetime_team_id and l.role = 'SUB_CAPTAIN' and l.status in ('ACTIVE', 'PENDING')) then
    raise exception 'LIFETIME_SEAT_TAKEN: the sub-captain seat is taken or already offered' using errcode = 'P0001';
  end if;
  begin
    insert into lifetime_team_leaderships (lifetime_team_id, gaming_member_id, role, status, offered_by_gaming_member_id, created_at, expires_at)
    values (p_lifetime_team_id, p_subject_gaming_member_id, 'SUB_CAPTAIN', 'PENDING', p_actor_gaming_member_id, v_now, v_now + interval '7 days')
    returning lifetime_team_leaderships.lifetime_team_leadership_id, lifetime_team_leaderships.expires_at into v_id, v_expires;
  exception
    when unique_violation then
      raise exception 'LIFETIME_SEAT_TAKEN: the sub-captain seat is taken or already offered' using errcode = 'P0001';
  end;
  insert into lifetime_team_events (lifetime_team_id, event_type, actor_gaming_member_id, subject_gaming_member_id, related_id, occurred_at, details)
  values (p_lifetime_team_id, 'LEADERSHIP_OFFERED', p_actor_gaming_member_id, p_subject_gaming_member_id, v_id, v_now, jsonb_build_object('role', 'SUB_CAPTAIN'));
  return query select v_id, 'PENDING'::text, v_expires;
end;
$function$;
revoke all on function offer_lifetime_team_leadership_atomically(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function offer_lifetime_team_leadership_atomically(uuid, uuid, uuid) to service_role;

create function decide_lifetime_team_leadership_atomically(p_lifetime_team_leadership_id uuid, p_actor_gaming_member_id uuid, p_decision text)
 returns table(lifetime_team_leadership_id uuid, status text, started_at timestamptz)
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
#variable_conflict use_column
declare
  v_team uuid;
  v_subject uuid;
  v_team_status text;
  v_status text;
  v_expires timestamptz;
  v_now timestamptz;
begin
  select l.lifetime_team_id, l.gaming_member_id into v_team, v_subject from lifetime_team_leaderships l where l.lifetime_team_leadership_id = p_lifetime_team_leadership_id;
  if v_team is null then
    raise exception 'LIFETIME_OFFER_NOT_FOUND: no such offer exists' using errcode = 'P0001';
  end if;
  if p_decision is distinct from 'ACCEPT' and p_decision is distinct from 'DECLINE' then
    raise exception 'LIFETIME_DECISION_INVALID: the decision must be ACCEPT or DECLINE' using errcode = 'P0001';
  end if;
  perform lifetime_lock_people(array[v_subject, p_actor_gaming_member_id]);
  select t.status into v_team_status from lifetime_teams t where t.lifetime_team_id = v_team for update;
  -- Authorization first (the person offered a seat never changes): only that person answers, whatever state the offer is in.
  if p_actor_gaming_member_id is distinct from v_subject then
    raise exception 'LIFETIME_OFFER_WRONG_PARTY: only the person offered the seat can answer it' using errcode = 'P0001';
  end if;
  select l.status, l.expires_at into v_status, v_expires from lifetime_team_leaderships l where l.lifetime_team_leadership_id = p_lifetime_team_leadership_id for update;
  if v_status <> 'PENDING' then
    raise exception 'LIFETIME_OFFER_NOT_PENDING: this offer has already been answered or withdrawn' using errcode = 'P0001';
  end if;
  v_now := lifetime_clock();
  if v_expires <= v_now then
    raise exception 'LIFETIME_OFFER_EXPIRED: this offer has lapsed' using errcode = 'P0001';
  end if;
  if p_decision = 'DECLINE' then
    update lifetime_team_leaderships l set status = 'ENDED', ended_at = v_now, ended_by_gaming_member_id = p_actor_gaming_member_id, end_reason = 'DECLINED', decided_at = v_now
     where l.lifetime_team_leadership_id = p_lifetime_team_leadership_id;
    insert into lifetime_team_events (lifetime_team_id, event_type, actor_gaming_member_id, subject_gaming_member_id, related_id, occurred_at)
    values (v_team, 'LEADERSHIP_DECLINED', p_actor_gaming_member_id, v_subject, p_lifetime_team_leadership_id, v_now);
    return query select p_lifetime_team_leadership_id, 'ENDED'::text, null::timestamptz;
    return;
  end if;
  if v_team_status <> 'ACTIVE' then
    raise exception 'LIFETIME_TEAM_NOT_ACTIVE: this team has been disbanded' using errcode = 'P0001';
  end if;
  if not exists (select 1 from lifetime_team_memberships m where m.lifetime_team_id = v_team and m.gaming_member_id = v_subject and m.status = 'ACTIVE') then
    raise exception 'LIFETIME_NOT_A_MEMBER: only an active member of the team can take the seat' using errcode = 'P0001';
  end if;
  if exists (select 1 from lifetime_team_memberships m where m.gaming_member_id = v_subject and m.status = 'ACTIVE' and not m.is_legacy and m.lifetime_team_id <> v_team)
     or exists (select 1 from lifetime_team_leaderships l where l.gaming_member_id = v_subject and l.status = 'ACTIVE' and not l.is_legacy) then
    raise exception 'LIFETIME_LEADER_MUST_BELONG_TO_ONE_TEAM: leave your other teams before taking a seat' using errcode = 'P0001';
  end if;
  if exists (select 1 from lifetime_team_leaderships l where l.lifetime_team_id = v_team and l.role = 'SUB_CAPTAIN' and l.status = 'ACTIVE') then
    raise exception 'LIFETIME_SEAT_TAKEN: the sub-captain seat is taken or already offered' using errcode = 'P0001';
  end if;
  update lifetime_team_leaderships l set status = 'ACTIVE', started_at = v_now, decided_at = v_now where l.lifetime_team_leadership_id = p_lifetime_team_leadership_id;
  insert into lifetime_team_events (lifetime_team_id, event_type, actor_gaming_member_id, subject_gaming_member_id, related_id, occurred_at, details)
  values (v_team, 'LEADERSHIP_ACTIVATED', p_actor_gaming_member_id, v_subject, p_lifetime_team_leadership_id, v_now, jsonb_build_object('role', 'SUB_CAPTAIN'));
  return query select p_lifetime_team_leadership_id, 'ACTIVE'::text, v_now;
end;
$function$;
revoke all on function decide_lifetime_team_leadership_atomically(uuid, uuid, text) from public, anon, authenticated;
grant execute on function decide_lifetime_team_leadership_atomically(uuid, uuid, text) to service_role;

-- The sub-captain steps down, or the captain removes the sub-captain. The seat's record stays.
create function end_lifetime_team_leadership_atomically(p_lifetime_team_id uuid, p_actor_gaming_member_id uuid)
 returns table(lifetime_team_leadership_id uuid, ended_at timestamptz, end_reason text)
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
#variable_conflict use_column
declare
  v_status text;
  v_peek uuid;
  v_actor_role text;
  v_seat uuid;
  v_sub_person uuid;
  v_reason text;
  v_now timestamptz;
begin
  select l.gaming_member_id into v_peek from lifetime_team_leaderships l where l.lifetime_team_id = p_lifetime_team_id and l.role = 'SUB_CAPTAIN' and l.status = 'ACTIVE';
  perform lifetime_lock_people(array[p_actor_gaming_member_id, v_peek]);
  select t.status into v_status from lifetime_teams t where t.lifetime_team_id = p_lifetime_team_id for update;
  if v_status is null then
    raise exception 'LIFETIME_TEAM_NOT_FOUND: no such team exists' using errcode = 'P0001';
  end if;
  select l.role into v_actor_role from lifetime_team_leaderships l where l.lifetime_team_id = p_lifetime_team_id and l.gaming_member_id = p_actor_gaming_member_id and l.status = 'ACTIVE';
  if v_actor_role is null then
    raise exception 'LIFETIME_NOT_A_LEADER: only a captain or sub-captain can do this' using errcode = 'P0001';
  end if;
  select l.lifetime_team_leadership_id, l.gaming_member_id into v_seat, v_sub_person from lifetime_team_leaderships l
   where l.lifetime_team_id = p_lifetime_team_id and l.role = 'SUB_CAPTAIN' and l.status = 'ACTIVE' for update;
  if v_seat is null then
    raise exception 'LIFETIME_SEAT_EMPTY: there is no sub-captain to remove' using errcode = 'P0001';
  end if;
  if v_actor_role = 'CAPTAIN' then
    v_reason := 'REMOVED';
  elsif p_actor_gaming_member_id is not distinct from v_sub_person then
    v_reason := 'STEPPED_DOWN';
  else
    raise exception 'LIFETIME_NOT_A_LEADER: only a captain or sub-captain can do this' using errcode = 'P0001';
  end if;
  v_now := lifetime_clock();
  update lifetime_team_leaderships l set status = 'ENDED', ended_at = v_now, ended_by_gaming_member_id = p_actor_gaming_member_id, end_reason = v_reason where l.lifetime_team_leadership_id = v_seat;
  insert into lifetime_team_events (lifetime_team_id, event_type, actor_gaming_member_id, subject_gaming_member_id, related_id, occurred_at, details)
  values (p_lifetime_team_id, 'LEADERSHIP_ENDED', p_actor_gaming_member_id, v_sub_person, v_seat, v_now, jsonb_build_object('role', 'SUB_CAPTAIN', 'end_reason', v_reason));
  -- An invitation stands only while the leader who made it still leads: the seat's end ends the invitations the former sub-captain made.
  with ended as (
    update lifetime_team_memberships m set status = 'ENDED', ended_at = v_now, ended_by_gaming_member_id = p_actor_gaming_member_id, end_reason = 'WITHDRAWN'
     where m.lifetime_team_id = p_lifetime_team_id and m.initiated_by_side = 'TEAM' and m.initiated_by_gaming_member_id = v_sub_person and m.status = 'PENDING'
    returning m.lifetime_team_membership_id, m.gaming_member_id, m.seq)
  insert into lifetime_team_events (lifetime_team_id, event_type, actor_gaming_member_id, subject_gaming_member_id, related_id, occurred_at, details)
  select p_lifetime_team_id, 'MEMBERSHIP_WITHDRAWN', p_actor_gaming_member_id, e.gaming_member_id, e.lifetime_team_membership_id, v_now, jsonb_build_object('reason', 'INVITER_LEFT_LEADERSHIP')
    from ended e order by e.seq;
  return query select v_seat, v_now, v_reason;
end;
$function$;
revoke all on function end_lifetime_team_leadership_atomically(uuid, uuid) from public, anon, authenticated;
grant execute on function end_lifetime_team_leadership_atomically(uuid, uuid) to service_role;

-- 8/9  The competition side: the flow switch, entry, roster claims and the freeze.
create function enable_lifetime_entry_flow_atomically(p_competition_id uuid, p_organizer_gaming_member_id uuid)
 returns table(competition_id uuid, enabled_at timestamptz, already_enabled boolean)
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
#variable_conflict use_column
declare
  v_organizer_id uuid;
  v_state text;
  v_existing timestamptz;
  v_now timestamptz;
begin
  perform pg_advisory_xact_lock(hashtext('competition_scope:' || p_competition_id::text));
  select c.organizer_gaming_member_id, c.state into v_organizer_id, v_state from competitions c where c.competition_id = p_competition_id for update;
  if v_organizer_id is null then
    raise exception 'COMPETITION_NOT_FOUND: no such competition exists' using errcode = 'P0001';
  end if;
  if p_organizer_gaming_member_id is distinct from v_organizer_id then
    raise exception 'COMPETITION_ACCESS_DENIED: only this competition''s own organizer may enable the lifetime flow' using errcode = 'P0001';
  end if;
  perform assert_competition_not_host_revoked(p_competition_id);
  select f.enabled_at into v_existing from competition_lifetime_flows f where f.competition_id = p_competition_id;
  if v_existing is not null then
    return query select p_competition_id, v_existing, true;
    return;
  end if;
  if v_state = 'CANCELLED_WITHOUT_CHAMPION' then
    raise exception 'COMPETITION_CANCELLED: this competition has been cancelled' using errcode = 'P0001';
  end if;
  if v_state not in ('DRAFT', 'TEAM_REGISTRATION_OPEN')
     or exists (select 1 from competition_teams t where t.competition_id = p_competition_id)
     or exists (select 1 from competition_registration_freezes f where f.competition_id = p_competition_id) then
    raise exception 'LIFETIME_FLOW_CONFLICT: this competition already uses the legacy team flow' using errcode = 'P0001';
  end if;
  v_now := lifetime_clock();
  insert into competition_lifetime_flows (competition_id, enabled_at, enabled_by_gaming_member_id) values (p_competition_id, v_now, p_organizer_gaming_member_id);
  return query select p_competition_id, v_now, false;
end;
$function$;
revoke all on function enable_lifetime_entry_flow_atomically(uuid, uuid) from public, anon, authenticated;
grant execute on function enable_lifetime_entry_flow_atomically(uuid, uuid) to service_role;

create function enter_lifetime_team_into_competition_atomically(p_competition_id uuid, p_lifetime_team_id uuid, p_actor_gaming_member_id uuid)
 returns table(competition_team_id uuid, public_code text, created_at timestamptz)
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
#variable_conflict use_column
declare
  v_team_status text;
  v_team_name text;
  v_state text;
  v_role text;
  v_captain uuid;
  v_sub uuid;
  v_active integer;
  v_attested boolean;
  v_entry uuid;
  v_code text;
  v_created timestamptz;
begin
  select t.status, t.name into v_team_status, v_team_name from lifetime_teams t where t.lifetime_team_id = p_lifetime_team_id for update;
  if v_team_status is null then
    raise exception 'LIFETIME_TEAM_NOT_FOUND: no such team exists' using errcode = 'P0001';
  end if;
  -- Authorization first: whatever the state of the team or the competition, only a leader of this team is told anything about either.
  select l.role into v_role from lifetime_team_leaderships l where l.lifetime_team_id = p_lifetime_team_id and l.gaming_member_id = p_actor_gaming_member_id and l.status = 'ACTIVE';
  if v_role is null then
    raise exception 'LIFETIME_NOT_A_LEADER: only a captain or sub-captain can do this' using errcode = 'P0001';
  end if;
  if v_team_status <> 'ACTIVE' then
    raise exception 'LIFETIME_TEAM_NOT_ACTIVE: this team has been disbanded' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtext('competition_scope:' || p_competition_id::text));
  select c.state into v_state from competitions c where c.competition_id = p_competition_id for update;
  if v_state is null then
    raise exception 'COMPETITION_NOT_FOUND: no such competition exists' using errcode = 'P0001';
  end if;
  if v_state = 'CANCELLED_WITHOUT_CHAMPION' then
    raise exception 'COMPETITION_CANCELLED: this competition has been cancelled' using errcode = 'P0001';
  end if;
  if not exists (select 1 from competition_lifetime_flows f where f.competition_id = p_competition_id) then
    raise exception 'LIFETIME_FLOW_NOT_ENABLED: this competition has not enabled the lifetime flow' using errcode = 'P0001';
  end if;
  if exists (select 1 from competition_lifetime_freezes f where f.competition_id = p_competition_id) then
    raise exception 'LIFETIME_ENTRIES_FROZEN: the entries of this competition are frozen' using errcode = 'P0001';
  end if;
  if v_state <> 'TEAM_REGISTRATION_OPEN' then
    raise exception 'TEAM_REGISTRATION_NOT_OPEN: team entries are only accepted while team registration is open' using errcode = 'P0001';
  end if;
  perform competition_assert_registration_intake_open(p_competition_id);
  select r.is_adult_self_attested into v_attested from competition_registrations r where r.competition_id = p_competition_id and r.gaming_member_id = p_actor_gaming_member_id;
  if not found then
    raise exception 'COMPETITION_REGISTRATION_REQUIRED: register for this competition before entering a team' using errcode = 'P0001';
  end if;
  if v_attested is not true then
    raise exception 'LIFETIME_ADULT_ATTESTATION_REQUIRED: this registration lacks the adult self-attestation' using errcode = 'P0001';
  end if;
  select count(*) into v_active from lifetime_team_memberships m where m.lifetime_team_id = p_lifetime_team_id and m.status = 'ACTIVE';
  if v_active < 2 then
    raise exception 'LIFETIME_TEAM_DORMANT: a team needs at least two members to enter a competition' using errcode = 'P0001';
  end if;
  -- Judged here, under the team and competition locks, so the specific answer comes first (the V1 name index would otherwise be the first unique index to refuse it).
  if exists (select 1 from competition_teams e where e.competition_id = p_competition_id and e.lifetime_team_id = p_lifetime_team_id and e.status <> 'REJECTED') then
    raise exception 'LIFETIME_ENTRY_ALREADY_EXISTS: this team already has a live entry in this competition' using errcode = 'P0001';
  end if;
  select l.gaming_member_id into v_captain from lifetime_team_leaderships l where l.lifetime_team_id = p_lifetime_team_id and l.role = 'CAPTAIN' and l.status = 'ACTIVE';
  select l.gaming_member_id into v_sub from lifetime_team_leaderships l where l.lifetime_team_id = p_lifetime_team_id and l.role = 'SUB_CAPTAIN' and l.status = 'ACTIVE';
  perform set_config('urbano.lifetime_entry_transition', 'enter', true);
  begin
    -- The table's guard refuses LIFETIME_PERSON_REPRESENTS_ANOTHER_TEAM here when the captain or sub-captain already leads another live entry or holds an accepted place.
    insert into competition_teams (competition_id, name, captain_gaming_member_id, status, provenance, entry_flow, lifetime_team_id, sub_captain_gaming_member_id)
    values (p_competition_id, v_team_name, v_captain, 'PENDING_ORGANIZER_APPROVAL', 'MEMBER_PROPOSED', 'LIFETIME', p_lifetime_team_id, v_sub)
    returning competition_teams.competition_team_id, competition_teams.public_code, competition_teams.created_at into v_entry, v_code, v_created;
  exception
    when unique_violation then
      if sqlerrm like '%competition_teams_lifetime_entry_unique%' then
        raise exception 'LIFETIME_ENTRY_ALREADY_EXISTS: this team already has a live entry in this competition' using errcode = 'P0001';
      elsif sqlerrm like '%competition_teams_unique_name_per_competition%' then
        raise exception 'DUPLICATE_TEAM_NAME: a team with this name already exists in this competition' using errcode = 'P0001';
      elsif sqlerrm like '%competition_teams_one_active_captaincy%' then
        raise exception 'ALREADY_CAPTAIN_OR_MEMBER: this member already holds an active team role in this competition' using errcode = 'P0001';
      end if;
      raise;
  end;
  perform set_config('urbano.lifetime_entry_transition', 'off', true);
  insert into lifetime_team_events (lifetime_team_id, event_type, actor_gaming_member_id, related_id, occurred_at, details)
  values (p_lifetime_team_id, 'ENTRY_SUBMITTED', p_actor_gaming_member_id, v_entry, lifetime_clock(), jsonb_build_object('competition_id', p_competition_id, 'competition_team_id', v_entry));
  return query select v_entry, v_code, v_created;
end;
$function$;
revoke all on function enter_lifetime_team_into_competition_atomically(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function enter_lifetime_team_into_competition_atomically(uuid, uuid, uuid) to service_role;

create function withdraw_lifetime_competition_entry_atomically(p_competition_team_id uuid, p_actor_gaming_member_id uuid)
 returns table(competition_team_id uuid, status text, released_claims integer)
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
#variable_conflict use_column
declare
  v_team uuid;
  v_competition uuid;
  v_status text;
  v_role text;
  v_released integer;
  v_now timestamptz;
begin
  select e.lifetime_team_id, e.competition_id into v_team, v_competition from competition_teams e where e.competition_team_id = p_competition_team_id and e.entry_flow = 'LIFETIME';
  if v_team is null then
    raise exception 'LIFETIME_ENTRY_NOT_FOUND: no such entry exists' using errcode = 'P0001';
  end if;
  perform 1 from lifetime_teams t where t.lifetime_team_id = v_team for update;
  -- Authorization first: only a leader of the team is told whether the entry is live, frozen or already withdrawn.
  select l.role into v_role from lifetime_team_leaderships l where l.lifetime_team_id = v_team and l.gaming_member_id = p_actor_gaming_member_id and l.status = 'ACTIVE';
  if v_role is null then
    raise exception 'LIFETIME_NOT_A_LEADER: only a captain or sub-captain can do this' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtext('competition_scope:' || v_competition::text));
  perform 1 from competitions c where c.competition_id = v_competition for update;
  select e.status into v_status from competition_teams e where e.competition_team_id = p_competition_team_id for update;
  if v_status = 'REJECTED' then
    raise exception 'LIFETIME_ENTRY_NOT_LIVE: this entry has already been withdrawn' using errcode = 'P0001';
  end if;
  if exists (select 1 from competition_lifetime_freezes f where f.competition_id = v_competition) then
    raise exception 'LIFETIME_ENTRIES_FROZEN: the entries of this competition are frozen' using errcode = 'P0001';
  end if;
  v_now := lifetime_clock();
  update competition_lifetime_roster_claims c
     set status = case when c.status = 'PROPOSED' then 'WITHDRAWN' else 'REMOVED' end, released_at = v_now, released_by_gaming_member_id = p_actor_gaming_member_id, release_reason = 'ENTRY_WITHDRAWN'
   where c.competition_team_id = p_competition_team_id and c.status in ('PROPOSED', 'ACCEPTED');
  get diagnostics v_released = row_count;
  perform set_config('urbano.lifetime_entry_transition', 'on', true);
  update competition_teams e set status = 'REJECTED', decided_at = v_now, decided_by_gaming_member_id = p_actor_gaming_member_id, rejection_reason = 'ENTRY_WITHDRAWN_BY_TEAM'
   where e.competition_team_id = p_competition_team_id;
  perform set_config('urbano.lifetime_entry_transition', 'off', true);
  insert into lifetime_team_events (lifetime_team_id, event_type, actor_gaming_member_id, related_id, occurred_at, details)
  values (v_team, 'ENTRY_WITHDRAWN', p_actor_gaming_member_id, p_competition_team_id, v_now, jsonb_build_object('competition_id', v_competition, 'released_claims', v_released));
  return query select p_competition_team_id, 'REJECTED'::text, v_released;
end;
$function$;
revoke all on function withdraw_lifetime_competition_entry_atomically(uuid, uuid) from public, anon, authenticated;
grant execute on function withdraw_lifetime_competition_entry_atomically(uuid, uuid) to service_role;

-- A leader proposes people for an entry. A proposal claims nobody: it is an invitation the person may accept (and which lapses at the deadline or after seven days).
create function propose_lifetime_entry_roster_claims_atomically(p_competition_team_id uuid, p_actor_gaming_member_id uuid, p_gaming_member_ids uuid[])
 returns table(competition_lifetime_roster_claim_id uuid, gaming_member_id uuid, status text, expires_at timestamptz)
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
#variable_conflict use_column
declare
  v_team uuid;
  v_competition uuid;
  v_entry_status text;
  v_state text;
  v_team_status text;
  v_role text;
  v_deadline timestamptz;
  v_now timestamptz;
  v_subject uuid;
  v_id uuid;
  v_expires timestamptz;
begin
  if p_gaming_member_ids is null or cardinality(p_gaming_member_ids) = 0 or cardinality(p_gaming_member_ids) > 32
     or exists (select 1 from unnest(p_gaming_member_ids) as x where x is null)
     or (select count(distinct x) from unnest(p_gaming_member_ids) as x) <> cardinality(p_gaming_member_ids) then
    raise exception 'LIFETIME_CLAIM_BATCH_INVALID: propose between 1 and 32 different people' using errcode = 'P0001';
  end if;
  select e.lifetime_team_id, e.competition_id into v_team, v_competition from competition_teams e where e.competition_team_id = p_competition_team_id and e.entry_flow = 'LIFETIME';
  if v_team is null then
    raise exception 'LIFETIME_ENTRY_NOT_FOUND: no such entry exists' using errcode = 'P0001';
  end if;
  select t.status into v_team_status from lifetime_teams t where t.lifetime_team_id = v_team for update;
  -- Authorization first: only a leader of the team is told whether the entry is live, frozen or closed.
  select l.role into v_role from lifetime_team_leaderships l where l.lifetime_team_id = v_team and l.gaming_member_id = p_actor_gaming_member_id and l.status = 'ACTIVE';
  if v_role is null then
    raise exception 'LIFETIME_NOT_A_LEADER: only a captain or sub-captain can do this' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtext('competition_scope:' || v_competition::text));
  select c.state into v_state from competitions c where c.competition_id = v_competition for update;
  select e.status into v_entry_status from competition_teams e where e.competition_team_id = p_competition_team_id for update;
  if v_entry_status = 'REJECTED' then
    raise exception 'LIFETIME_ENTRY_NOT_LIVE: this entry has been withdrawn' using errcode = 'P0001';
  end if;
  if v_state = 'CANCELLED_WITHOUT_CHAMPION' then
    raise exception 'COMPETITION_CANCELLED: this competition has been cancelled' using errcode = 'P0001';
  end if;
  if exists (select 1 from competition_lifetime_freezes f where f.competition_id = v_competition) then
    raise exception 'LIFETIME_ENTRIES_FROZEN: the entries of this competition are frozen' using errcode = 'P0001';
  end if;
  if v_state <> 'TEAM_REGISTRATION_OPEN' then
    raise exception 'TEAM_REGISTRATION_NOT_OPEN: roster proposals are only accepted while team registration is open' using errcode = 'P0001';
  end if;
  perform competition_assert_registration_intake_open(v_competition);
  if v_team_status <> 'ACTIVE' then
    raise exception 'LIFETIME_TEAM_NOT_ACTIVE: this team has been disbanded' using errcode = 'P0001';
  end if;
  select p.registration_deadline_utc into v_deadline from competition_current_registration_plan(v_competition) p;
  v_now := lifetime_clock();
  -- The deadline is judged with the registration clock above and stamped with this one; if it fell between the two, the proposal is the same bounded refusal.
  if v_now >= v_deadline then
    raise exception 'TEAM_REGISTRATION_NOT_OPEN: the registration deadline for this competition has passed' using errcode = 'P0001';
  end if;
  for v_subject in select x from unnest(p_gaming_member_ids) as x order by x loop
    if not exists (select 1 from lifetime_team_memberships m where m.lifetime_team_id = v_team and m.gaming_member_id = v_subject and m.status = 'ACTIVE') then
      raise exception 'LIFETIME_CLAIM_SUBJECT_NOT_MEMBER: only an active member of the team can be proposed' using errcode = 'P0001';
    end if;
    update competition_lifetime_roster_claims c set status = 'EXPIRED', released_at = c.expires_at, release_reason = 'EXPIRED'
     where c.competition_team_id = p_competition_team_id and c.gaming_member_id = v_subject and c.status = 'PROPOSED' and c.expires_at <= v_now;
    begin
      insert into competition_lifetime_roster_claims (competition_id, competition_team_id, lifetime_team_id, gaming_member_id, proposed_by_gaming_member_id, proposed_at, expires_at)
      values (v_competition, p_competition_team_id, v_team, v_subject, p_actor_gaming_member_id, v_now, least(v_now + interval '7 days', v_deadline))
      returning competition_lifetime_roster_claims.competition_lifetime_roster_claim_id, competition_lifetime_roster_claims.expires_at into v_id, v_expires;
    exception
      when unique_violation then
        raise exception 'LIFETIME_CLAIM_ALREADY_OPEN: this person already has an open claim on this entry' using errcode = 'P0001';
    end;
    return query select v_id, v_subject, 'PROPOSED'::text, v_expires;
  end loop;
end;
$function$;
revoke all on function propose_lifetime_entry_roster_claims_atomically(uuid, uuid, uuid[]) from public, anon, authenticated;
grant execute on function propose_lifetime_entry_roster_claims_atomically(uuid, uuid, uuid[]) to service_role;

-- THE PERSON decides. Only the person named by a claim can accept or reject it; accepting needs the adult self-attestation registered for the competition, an
-- active membership of the team and no other accepted claim in this competition. The claim begins here, never before.
create function decide_lifetime_entry_roster_claim_atomically(p_competition_lifetime_roster_claim_id uuid, p_actor_gaming_member_id uuid, p_decision text)
 returns table(competition_lifetime_roster_claim_id uuid, status text, accepted_at timestamptz)
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
#variable_conflict use_column
declare
  v_subject uuid;
  v_team uuid;
  v_competition uuid;
  v_entry uuid;
  v_proposer uuid;
  v_status text;
  v_expires timestamptz;
  v_state text;
  v_team_status text;
  v_entry_status text;
  v_attested boolean;
  v_maximum smallint;
  v_now timestamptz;
begin
  select c.gaming_member_id, c.lifetime_team_id, c.competition_id, c.competition_team_id, c.proposed_by_gaming_member_id into v_subject, v_team, v_competition, v_entry, v_proposer
    from competition_lifetime_roster_claims c where c.competition_lifetime_roster_claim_id = p_competition_lifetime_roster_claim_id;
  if v_subject is null then
    raise exception 'LIFETIME_CLAIM_NOT_FOUND: no such claim exists' using errcode = 'P0001';
  end if;
  if p_decision is distinct from 'ACCEPT' and p_decision is distinct from 'REJECT' then
    raise exception 'LIFETIME_DECISION_INVALID: the decision must be ACCEPT or REJECT' using errcode = 'P0001';
  end if;
  perform lifetime_lock_people(array[v_subject, p_actor_gaming_member_id]);
  select t.status into v_team_status from lifetime_teams t where t.lifetime_team_id = v_team for update;
  perform pg_advisory_xact_lock(hashtext('competition_scope:' || v_competition::text));
  select c.state into v_state from competitions c where c.competition_id = v_competition for update;
  select c.status, c.expires_at into v_status, v_expires from competition_lifetime_roster_claims c where c.competition_lifetime_roster_claim_id = p_competition_lifetime_roster_claim_id for update;
  if p_actor_gaming_member_id is distinct from v_subject then
    raise exception 'LIFETIME_CLAIM_WRONG_PARTY: only the person named by a claim can answer it' using errcode = 'P0001';
  end if;
  if v_status <> 'PROPOSED' then
    raise exception 'LIFETIME_CLAIM_NOT_OPEN: this claim has already been answered or released' using errcode = 'P0001';
  end if;
  if v_state = 'CANCELLED_WITHOUT_CHAMPION' then
    raise exception 'COMPETITION_CANCELLED: this competition has been cancelled' using errcode = 'P0001';
  end if;
  if exists (select 1 from competition_lifetime_freezes f where f.competition_id = v_competition) then
    raise exception 'LIFETIME_ENTRIES_FROZEN: the entries of this competition are frozen' using errcode = 'P0001';
  end if;
  v_now := lifetime_clock();
  if p_decision = 'REJECT' then
    update competition_lifetime_roster_claims c set status = 'REJECTED', decided_at = v_now, released_at = v_now, released_by_gaming_member_id = p_actor_gaming_member_id, release_reason = 'PERSON_REJECTED'
     where c.competition_lifetime_roster_claim_id = p_competition_lifetime_roster_claim_id;
    return query select p_competition_lifetime_roster_claim_id, 'REJECTED'::text, null::timestamptz;
    return;
  end if;
  if v_state <> 'TEAM_REGISTRATION_OPEN' then
    raise exception 'TEAM_REGISTRATION_NOT_OPEN: a roster place can only be accepted while team registration is open' using errcode = 'P0001';
  end if;
  perform competition_assert_registration_intake_open(v_competition);
  if v_expires <= v_now then
    raise exception 'LIFETIME_CLAIM_EXPIRED: this proposal has lapsed' using errcode = 'P0001';
  end if;
  select e.status into v_entry_status from competition_teams e where e.competition_team_id = v_entry for update;
  if v_entry_status = 'REJECTED' then
    raise exception 'LIFETIME_ENTRY_NOT_LIVE: this entry has been withdrawn' using errcode = 'P0001';
  end if;
  if v_team_status <> 'ACTIVE' then
    raise exception 'LIFETIME_TEAM_NOT_ACTIVE: this team has been disbanded' using errcode = 'P0001';
  end if;
  -- A proposal stands only while the leader who made it still leads: nobody can take a place that no current leader of the team asked for.
  if not exists (select 1 from lifetime_team_leaderships l where l.lifetime_team_id = v_team and l.gaming_member_id = v_proposer and l.status = 'ACTIVE') then
    raise exception 'LIFETIME_CLAIM_NOT_OPEN: this claim has already been answered or released' using errcode = 'P0001';
  end if;
  if not exists (select 1 from lifetime_team_memberships m where m.lifetime_team_id = v_team and m.gaming_member_id = v_subject and m.status = 'ACTIVE') then
    raise exception 'LIFETIME_CLAIM_SUBJECT_NOT_MEMBER: only an active member of the team can be on its roster' using errcode = 'P0001';
  end if;
  select r.is_adult_self_attested into v_attested from competition_registrations r where r.competition_id = v_competition and r.gaming_member_id = v_subject;
  if not found then
    raise exception 'COMPETITION_REGISTRATION_REQUIRED: register for this competition before accepting a roster place' using errcode = 'P0001';
  end if;
  if v_attested is not true then
    raise exception 'LIFETIME_ADULT_ATTESTATION_REQUIRED: this registration lacks the adult self-attestation' using errcode = 'P0001';
  end if;
  if exists (select 1 from competition_lifetime_roster_claims c where c.competition_id = v_competition and c.gaming_member_id = v_subject and c.status = 'ACCEPTED') then
    raise exception 'LIFETIME_PERSON_ALREADY_CLAIMED: this person is already on a team''s roster in this competition' using errcode = 'P0001';
  end if;
  select p.roster_maximum into v_maximum from competition_current_registration_plan(v_competition) p;
  if (select count(*) from competition_lifetime_roster_claims c where c.competition_team_id = v_entry and c.status = 'ACCEPTED') >= v_maximum then
    raise exception 'LIFETIME_ROSTER_FULL: this entry already has the maximum number of players' using errcode = 'P0001';
  end if;
  begin
    update competition_lifetime_roster_claims c set status = 'ACCEPTED', decided_at = v_now, accepted_at = v_now where c.competition_lifetime_roster_claim_id = p_competition_lifetime_roster_claim_id;
  exception
    when unique_violation then
      raise exception 'LIFETIME_PERSON_ALREADY_CLAIMED: this person is already on a team''s roster in this competition' using errcode = 'P0001';
  end;
  return query select p_competition_lifetime_roster_claim_id, 'ACCEPTED'::text, v_now;
end;
$function$;
revoke all on function decide_lifetime_entry_roster_claim_atomically(uuid, uuid, text) from public, anon, authenticated;
grant execute on function decide_lifetime_entry_roster_claim_atomically(uuid, uuid, text) to service_role;

-- Before the freeze a claim is released by the person (withdrawing their accepted place) or by a leader of the team (removing it, or withdrawing a proposal).
create function release_lifetime_entry_roster_claim_atomically(p_competition_lifetime_roster_claim_id uuid, p_actor_gaming_member_id uuid)
 returns table(competition_lifetime_roster_claim_id uuid, status text, release_reason text)
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
#variable_conflict use_column
declare
  v_subject uuid;
  v_team uuid;
  v_competition uuid;
  v_status text;
  v_role text;
  v_new_status text;
  v_reason text;
  v_now timestamptz;
begin
  select c.gaming_member_id, c.lifetime_team_id, c.competition_id into v_subject, v_team, v_competition
    from competition_lifetime_roster_claims c where c.competition_lifetime_roster_claim_id = p_competition_lifetime_roster_claim_id;
  if v_subject is null then
    raise exception 'LIFETIME_CLAIM_NOT_FOUND: no such claim exists' using errcode = 'P0001';
  end if;
  perform lifetime_lock_people(array[v_subject, p_actor_gaming_member_id]);
  perform 1 from lifetime_teams t where t.lifetime_team_id = v_team for update;
  -- Authorization first: the person named by a claim, or a leader of the team, and nobody else is told what state it is in.
  select l.role into v_role from lifetime_team_leaderships l where l.lifetime_team_id = v_team and l.gaming_member_id = p_actor_gaming_member_id and l.status = 'ACTIVE';
  if p_actor_gaming_member_id is distinct from v_subject and v_role is null then
    raise exception 'LIFETIME_NOT_A_LEADER: only a captain or sub-captain can do this' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(hashtext('competition_scope:' || v_competition::text));
  perform 1 from competitions c where c.competition_id = v_competition for update;
  select c.status into v_status from competition_lifetime_roster_claims c where c.competition_lifetime_roster_claim_id = p_competition_lifetime_roster_claim_id for update;
  if v_status not in ('PROPOSED', 'ACCEPTED') then
    raise exception 'LIFETIME_CLAIM_NOT_OPEN: this claim has already been answered or released' using errcode = 'P0001';
  end if;
  if exists (select 1 from competition_lifetime_freezes f where f.competition_id = v_competition) then
    raise exception 'LIFETIME_ENTRIES_FROZEN: the entries of this competition are frozen' using errcode = 'P0001';
  end if;
  if p_actor_gaming_member_id is not distinct from v_subject then
    if v_status = 'PROPOSED' then
      raise exception 'LIFETIME_CLAIM_WRONG_PARTY: answer a proposal with a decision; only an accepted place is withdrawn' using errcode = 'P0001';
    end if;
    v_new_status := 'WITHDRAWN';
    v_reason := 'PERSON_WITHDREW';
  elsif v_role is not null then
    if v_status = 'PROPOSED' then
      v_new_status := 'WITHDRAWN';
      v_reason := 'LEADER_WITHDREW_PROPOSAL';
    else
      v_new_status := 'REMOVED';
      v_reason := 'LEADER_REMOVED';
    end if;
  else
    raise exception 'LIFETIME_NOT_A_LEADER: only a captain or sub-captain can do this' using errcode = 'P0001';
  end if;
  v_now := lifetime_clock();
  update competition_lifetime_roster_claims c set status = v_new_status, released_at = v_now, released_by_gaming_member_id = p_actor_gaming_member_id, release_reason = v_reason
   where c.competition_lifetime_roster_claim_id = p_competition_lifetime_roster_claim_id;
  return query select p_competition_lifetime_roster_claim_id, v_new_status, v_reason;
end;
$function$;
revoke all on function release_lifetime_entry_roster_claim_atomically(uuid, uuid) from public, anon, authenticated;
grant execute on function release_lifetime_entry_roster_claim_atomically(uuid, uuid) to service_role;

-- The organizer's checkpoint. It needs the deadline to have passed (the same clock as every registration decision), at least two live entries and every roster
-- within the plan's bounds; it records the counts and changes NO competition state (so nothing downstream can start). An exact retry returns the freeze that exists.
create function freeze_lifetime_competition_entries_atomically(p_competition_id uuid, p_organizer_gaming_member_id uuid)
 returns table(competition_id uuid, frozen_at timestamptz, entry_count integer, claim_count integer, already_frozen boolean)
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
#variable_conflict use_column
declare
  v_organizer_id uuid;
  v_state text;
  v_activity_key text;
  v_existing record;
  v_revision uuid;
  v_format text;
  v_minimum smallint;
  v_maximum smallint;
  v_deadline timestamptz;
  v_now timestamptz;
  v_entries integer;
  v_claims integer;
  v_entry record;
begin
  perform pg_advisory_xact_lock(hashtext('competition_scope:' || p_competition_id::text));
  select c.organizer_gaming_member_id, c.state, c.activity_key into v_organizer_id, v_state, v_activity_key from competitions c where c.competition_id = p_competition_id for update;
  if v_organizer_id is null then
    raise exception 'COMPETITION_NOT_FOUND: no such competition exists' using errcode = 'P0001';
  end if;
  if p_organizer_gaming_member_id is distinct from v_organizer_id then
    raise exception 'COMPETITION_ACCESS_DENIED: only this competition''s own organizer may freeze its entries' using errcode = 'P0001';
  end if;
  perform assert_competition_not_host_revoked(p_competition_id);
  if not exists (select 1 from competition_lifetime_flows f where f.competition_id = p_competition_id) then
    raise exception 'LIFETIME_FLOW_NOT_ENABLED: this competition has not enabled the lifetime flow' using errcode = 'P0001';
  end if;
  select f.frozen_at, f.entry_count, f.claim_count into v_existing from competition_lifetime_freezes f where f.competition_id = p_competition_id;
  if v_existing.frozen_at is not null then
    return query select p_competition_id, v_existing.frozen_at, v_existing.entry_count, v_existing.claim_count, true;
    return;
  end if;
  if v_state = 'CANCELLED_WITHOUT_CHAMPION' then
    raise exception 'COMPETITION_CANCELLED: this competition has been cancelled' using errcode = 'P0001';
  end if;
  if v_state <> 'TEAM_REGISTRATION_OPEN' then
    raise exception 'TEAM_REGISTRATION_NOT_OPEN: team registration is not currently open' using errcode = 'P0001';
  end if;
  select p.planning_revision_id, p.format_key, p.roster_minimum, p.roster_maximum, p.registration_deadline_utc into v_revision, v_format, v_minimum, v_maximum, v_deadline
    from competition_current_registration_plan(p_competition_id) p;
  if v_revision is null or not competition_registration_plan_usable(v_activity_key, v_format, v_minimum, v_maximum, v_deadline) then
    raise exception 'LIFETIME_FREEZE_PLAN_INVALID: this competition has no usable registration plan' using errcode = 'P0001';
  end if;
  v_now := competition_registration_clock();
  if not competition_registration_deadline_reached(v_deadline, v_now) then
    raise exception 'LIFETIME_FREEZE_DEADLINE_NOT_REACHED: the registration deadline has not been reached' using errcode = 'P0001';
  end if;
  select count(*) into v_entries from competition_teams e where e.competition_id = p_competition_id and e.entry_flow = 'LIFETIME' and e.status <> 'REJECTED';
  if v_entries < 2 then
    raise exception 'LIFETIME_FREEZE_NOT_ENOUGH_ENTRIES: at least two live entries are needed (found %)', v_entries using errcode = 'P0001';
  end if;
  for v_entry in
    select e.competition_team_id as entry_id,
           (select count(*) from competition_lifetime_roster_claims c where c.competition_team_id = e.competition_team_id and c.status = 'ACCEPTED')::integer as accepted_total
      from competition_teams e where e.competition_id = p_competition_id and e.entry_flow = 'LIFETIME' and e.status <> 'REJECTED'
     order by e.competition_team_id::text collate "C"
  loop
    if v_entry.accepted_total < v_minimum then
      raise exception 'LIFETIME_FREEZE_ROSTER_BELOW_MINIMUM: an entry has % accepted player(s); the minimum is %', v_entry.accepted_total, v_minimum using errcode = 'P0001';
    end if;
    if v_entry.accepted_total > v_maximum then
      raise exception 'LIFETIME_FREEZE_ROSTER_ABOVE_MAXIMUM: an entry has % accepted player(s); the maximum is %', v_entry.accepted_total, v_maximum using errcode = 'P0001';
    end if;
  end loop;
  -- The deadline has passed, so no proposal can be accepted any more: settle every one still open as expired (at its own expiry, or now when that is later), so none
  -- is left open and unanswerable. Only a proposal can lapse here; an accepted place is evidence and is counted below.
  update competition_lifetime_roster_claims c set status = 'EXPIRED', released_at = least(c.expires_at, v_now), release_reason = 'EXPIRED'
   where c.competition_id = p_competition_id and c.status = 'PROPOSED';
  select count(*) into v_claims from competition_lifetime_roster_claims c where c.competition_id = p_competition_id and c.status = 'ACCEPTED';
  insert into competition_lifetime_freezes (competition_id, planning_revision_id, roster_minimum, roster_maximum, registration_deadline_utc, frozen_at, frozen_by_gaming_member_id, entry_count, claim_count)
  values (p_competition_id, v_revision, v_minimum, v_maximum, v_deadline, v_now, p_organizer_gaming_member_id, v_entries, v_claims);
  return query select p_competition_id, v_now, v_entries, v_claims, false;
end;
$function$;
revoke all on function freeze_lifetime_competition_entries_atomically(uuid, uuid) from public, anon, authenticated;
grant execute on function freeze_lifetime_competition_entries_atomically(uuid, uuid) to service_role;

-- 9/9  The legacy backfill. EXPLICIT, scoped, idempotent, service-side — and never run by this migration. Each ACCEPTED V1 team becomes one LEGACY lifetime team (named
-- as it was, created when it was, with its captain's seat and every member dated from the V1 rows) and is linked to its V1 team in a side table; not one V1 row is
-- read-modified. Nothing is merged: the same name in two competitions is two teams, the same person on two V1 teams is two legacy memberships. Legacy rows are history:
-- the new caps and the exclusivity of leaders do not count them. A scope is REQUIRED: name the competitions to backfill (a missing, null or empty scope is refused, so
-- nothing can run for everyone by omission). A re-run converges: a member approved in V1 after an earlier run is mirrored — unless that person already has ANY membership
-- row on the legacy team (an offer, an active period or an ended one, of either origin): the lifetime flow's own rows are authoritative once they exist, so a person who
-- left or declined is never brought back and an offer that is still pending is never shadowed. The mirror takes the legacy team's row lock first (like every other
-- operation that writes a membership), so a disband or an invitation answered at the same moment cannot interleave with it. A V1 team whose name is blank (V1 accepts
-- one) is kept as '(unnamed team)'; its V1 row is never touched. The backfill is the system's own act: its events name no person as actor.
create function backfill_legacy_competition_teams_atomically(p_competition_ids uuid[])
 returns table(teams_created integer, memberships_created integer, leaderships_created integer, skipped_already_linked integer, skipped_not_accepted integer)
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
#variable_conflict use_column
declare
  v_team record;
  v_new uuid;
  v_stamp timestamptz;
  v_teams integer := 0;
  v_memberships integer := 0;
  v_leaderships integer := 0;
  v_linked integer := 0;
  v_skipped integer := 0;
  v_added integer;
begin
  if p_competition_ids is null or cardinality(p_competition_ids) = 0 then
    raise exception 'LIFETIME_BACKFILL_SCOPE_INVALID: name at least one competition to backfill' using errcode = 'P0001';
  end if;
  perform pg_advisory_xact_lock(7102, 0);
  v_stamp := lifetime_clock();
  select count(*) into v_skipped from competition_teams t
   where t.entry_flow = 'V1' and t.status <> 'ACCEPTED' and t.competition_id = any(p_competition_ids);
  for v_team in
    select t.competition_team_id, t.competition_id, t.name, t.captain_gaming_member_id, t.created_at from competition_teams t
     where t.entry_flow = 'V1' and t.status = 'ACCEPTED' and t.competition_id = any(p_competition_ids)
     order by t.created_at, t.competition_team_id
  loop
    select s.lifetime_team_id into v_new from lifetime_team_legacy_sources s where s.competition_team_id = v_team.competition_team_id;
    if v_new is not null then
      v_linked := v_linked + 1;
      -- Converge: a V1 approval that landed after an earlier run is mirrored now, dated from its V1 row. Anyone who already has ANY membership row on this team (an offer,
      -- an active period, an ended one) is left alone, and a disbanded legacy team is history. The team row is locked before its status is read.
      perform 1 from lifetime_teams t where t.lifetime_team_id = v_new and t.status = 'ACTIVE' for update;
      if found then
        with added as (
          insert into lifetime_team_memberships (lifetime_team_id, gaming_member_id, status, initiated_by_side, initiated_by_gaming_member_id, is_legacy, created_at, decided_at, decided_by_gaming_member_id, joined_at)
          select v_new, m.gaming_member_id, 'ACTIVE', 'TEAM', m.approved_by_gaming_member_id, true, m.approved_at, m.approved_at, m.approved_by_gaming_member_id, m.approved_at
            from competition_team_memberships m
           where m.competition_team_id = v_team.competition_team_id
             and not exists (select 1 from lifetime_team_memberships x where x.lifetime_team_id = v_new and x.gaming_member_id = m.gaming_member_id)
          returning lifetime_team_memberships.lifetime_team_membership_id, lifetime_team_memberships.gaming_member_id, lifetime_team_memberships.joined_at, lifetime_team_memberships.seq)
        insert into lifetime_team_events (lifetime_team_id, event_type, subject_gaming_member_id, related_id, occurred_at, details)
        select v_new, 'MEMBERSHIP_ACTIVATED', a.gaming_member_id, a.lifetime_team_membership_id, v_stamp,
               jsonb_build_object('origin', 'LEGACY_BACKFILL', 'joined_at', a.joined_at, 'refresh', true)
          from added a order by a.seq;
        get diagnostics v_added = row_count;
        v_memberships := v_memberships + v_added;
      end if;
      continue;
    end if;
    insert into lifetime_teams (name, status, origin, created_by_gaming_member_id, created_at)
    values (coalesce(nullif(btrim(v_team.name), ''), '(unnamed team)'), 'ACTIVE', 'LEGACY_BACKFILL', v_team.captain_gaming_member_id, v_team.created_at)
    returning lifetime_teams.lifetime_team_id into v_new;
    insert into lifetime_team_legacy_sources (lifetime_team_id, competition_team_id, competition_id) values (v_new, v_team.competition_team_id, v_team.competition_id);
    insert into lifetime_team_memberships (lifetime_team_id, gaming_member_id, status, initiated_by_side, initiated_by_gaming_member_id, is_legacy, created_at, decided_at, decided_by_gaming_member_id, joined_at)
    values (v_new, v_team.captain_gaming_member_id, 'ACTIVE', 'TEAM', v_team.captain_gaming_member_id, true, v_team.created_at, v_team.created_at, v_team.captain_gaming_member_id, v_team.created_at);
    insert into lifetime_team_leaderships (lifetime_team_id, gaming_member_id, role, status, is_legacy, offered_by_gaming_member_id, created_at, decided_at, started_at)
    values (v_new, v_team.captain_gaming_member_id, 'CAPTAIN', 'ACTIVE', true, v_team.captain_gaming_member_id, v_team.created_at, v_team.created_at, v_team.created_at);
    insert into lifetime_team_memberships (lifetime_team_id, gaming_member_id, status, initiated_by_side, initiated_by_gaming_member_id, is_legacy, created_at, decided_at, decided_by_gaming_member_id, joined_at)
    select v_new, m.gaming_member_id, 'ACTIVE', 'TEAM', m.approved_by_gaming_member_id, true, m.approved_at, m.approved_at, m.approved_by_gaming_member_id, m.approved_at
      from competition_team_memberships m
     where m.competition_team_id = v_team.competition_team_id and m.gaming_member_id is distinct from v_team.captain_gaming_member_id;
    get diagnostics v_added = row_count;
    -- The system's own act: no person is named as its actor, the time is when it happened, and the V1 dates are kept in the details.
    insert into lifetime_team_events (lifetime_team_id, event_type, subject_gaming_member_id, occurred_at, details)
    values (v_new, 'TEAM_CREATED', v_team.captain_gaming_member_id, v_stamp,
            jsonb_build_object('origin', 'LEGACY_BACKFILL', 'competition_team_id', v_team.competition_team_id, 'competition_id', v_team.competition_id, 'v1_created_at', v_team.created_at));
    insert into lifetime_team_events (lifetime_team_id, event_type, subject_gaming_member_id, related_id, occurred_at, details)
    select v_new, 'MEMBERSHIP_ACTIVATED', m.gaming_member_id, m.lifetime_team_membership_id, v_stamp, jsonb_build_object('origin', 'LEGACY_BACKFILL', 'joined_at', m.joined_at)
      from lifetime_team_memberships m where m.lifetime_team_id = v_new order by m.seq;
    insert into lifetime_team_events (lifetime_team_id, event_type, subject_gaming_member_id, related_id, occurred_at, details)
    select v_new, 'LEADERSHIP_ACTIVATED', l.gaming_member_id, l.lifetime_team_leadership_id, v_stamp, jsonb_build_object('origin', 'LEGACY_BACKFILL', 'role', l.role, 'started_at', l.started_at)
      from lifetime_team_leaderships l where l.lifetime_team_id = v_new order by l.seq;
    v_teams := v_teams + 1;
    v_leaderships := v_leaderships + 1;
    v_memberships := v_memberships + 1 + v_added;
  end loop;
  return query select v_teams, v_memberships, v_leaderships, v_linked, v_skipped;
end;
$function$;
revoke all on function backfill_legacy_competition_teams_atomically(uuid[]) from public, anon, authenticated;
grant execute on function backfill_legacy_competition_teams_atomically(uuid[]) to service_role;
