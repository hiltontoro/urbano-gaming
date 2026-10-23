-- UG-CR-GATE-SSS-007 — Small-Sided Soccer Registration Deadline and Competition Freeze Foundation.
--
-- WHAT THIS DOES. The registration deadline stored in a competition's CURRENT Organizer Planning revision becomes the authority for when team
-- registration is open, and the existing close operation becomes the one explicit, atomic FREEZE checkpoint. Everything is decided inside the
-- atomic database operations, by the database clock, under the competition's existing serialization lock — never by a job, a browser or a cache.
--
--   1. Three server-only, append-only tables record a freeze: competition_registration_freezes (one row per competition: the plan revision, the
--      format, the configured roster bounds, the deadline, the database-clock freeze time, the actor, the counts and a deterministic digest),
--      competition_registration_freeze_teams (exactly the four accepted teams and their captains) and competition_registration_freeze_members
--      (the complete competitive membership of each team; a person appears once). Row-level security is on, there is no policy, no browser role
--      holds any privilege and not even the server role can write: only the close operation writes. UPDATE, DELETE and TRUNCATE are refused.
--      A deferred check at commit recomputes the digest and the counts from the stored rows, so the evidence is internally consistent
--      whatever wrote it.
--   2. Eight internal helpers, executable by nobody: the ONE clock (competition_registration_clock, whose body is clock_timestamp()), the
--      deadline comparison, the current-plan lookup, the plan-usability test, the frozen test, the two rules the registration operations apply
--      (intake and decision) and the digest builder.
--   3. open_team_registration_atomically now requires a usable plan: a current revision, of the competition's own format, with roster bounds
--      inside the registry's ranges, a deadline that is an exact instant to the millisecond, and a deadline that is still in the future by the
--      database clock.
--   4. register_for_competition_atomically, add_competition_team_atomically (both signatures), propose_competition_team_atomically (both
--      signatures) and request_join_competition_team_atomically refuse a NEW entry at and after the deadline (the exact instant is closed) and
--      once the competition is frozen. An existing registration is still returned unchanged (a replay is not a new registration).
--   5. decide_competition_team_atomically, decide_join_request_atomically and organizer_review_join_request_atomically may still decide work
--      received BEFORE the deadline after it (within their existing authority), refuse any entry stamped at or after the deadline, and refuse an
--      approval once the competition is frozen.
--   6. close_team_registration_atomically is the freeze: it requires the deadline to have passed, the competition to be open, a current plan of
--      the competition's format, exactly four accepted teams, no pending team proposal, no pending join request, every roster within the
--      configured bounds and every person on exactly one team, then records the immutable evidence and moves the competition to
--      READY_TO_PUBLISH. An exact retry returns the existing freeze; it never rebuilds it from changed data.
--   7. get_competition_registration_status: a bounded, server-only read of the deadline facts the addressed competition view reports.
--
-- COMPETITIONS WITHOUT A USABLE PLAN ARE CLOSED (UG-CR-GATE-SSS-007A). A competition that is no longer a draft and has no current planning revision —
-- or whose current revision is not usable (another format, roster bounds outside the registry's range, a deadline that is not an exact millisecond
-- instant) — accepts no new registration, organizer-added team, proposed team or join request, and decides no pending proposal or join request,
-- because there is no authoritative plan to date them by. The answer is the bounded "registration is closed for this competition" and says nothing of
-- why. Nothing is backfilled and nothing is opened by guessing a deadline: such a competition (one opened before Organizer Planning existed) cannot be
-- frozen, and its one safe operational exit is the cancellation that already exists. The helpers themselves never let a missing plan through; the one
-- exception is stated where it belongs, in the organizer-added-team operation: a DRAFT that has no plan at all has not opened registration, so its
-- organizer may still prepare its teams, as before.
--
-- WHAT THIS DELIBERATELY DOES NOT DO. It adds no competition state (the freeze moves OPEN to READY_TO_PUBLISH), no reopening, no draw, pairing,
-- fixture, schedule, appeal, adjudication or amendment record, no cron job and no client-supplied time. It changes no earlier migration, no
-- registry value, no planning revision, no capability or host behavior, no cancellation authority, no publication or fixture operation, and it
-- makes no format other than five-a-side creatable.
--
-- Append-only: no earlier migration is edited. The nine registration functions are replaced in place (create or replace keeps their grants).

-- 1/8  The freeze evidence.
create table competition_registration_freezes (
  registration_freeze_id uuid primary key default gen_random_uuid(),
  competition_id uuid not null,
  planning_revision_id uuid not null,
  format_key text not null,
  roster_minimum smallint not null,
  roster_maximum smallint not null,
  registration_deadline_utc timestamptz not null,
  frozen_at timestamptz not null,
  frozen_by_gaming_member_id uuid not null references gaming_members (gaming_member_id),
  team_count smallint not null,
  member_count integer not null,
  snapshot_digest text not null,
  constraint competition_registration_freezes_one_per_competition unique (competition_id),
  constraint competition_registration_freezes_competition_freeze_key unique (competition_id, registration_freeze_id),
  constraint competition_registration_freezes_revision_fkey foreign key (competition_id, planning_revision_id) references competition_planning_revisions (competition_id, planning_revision_id),
  constraint competition_registration_freezes_format_fkey foreign key (competition_id, format_key) references competitions (competition_id, activity_key),
  constraint competition_registration_freezes_team_count check (team_count = 4),
  constraint competition_registration_freezes_member_count check (member_count >= 0),
  constraint competition_registration_freezes_roster_range check (roster_minimum >= 1 and roster_maximum <= 16 and roster_minimum <= roster_maximum),
  constraint competition_registration_freezes_frozen_after_deadline check (frozen_at >= registration_deadline_utc),
  constraint competition_registration_freezes_deadline_precision check (registration_deadline_utc = date_trunc('milliseconds', registration_deadline_utc)),
  constraint competition_registration_freezes_digest_shape check (snapshot_digest ~ '^[0-9a-f]{64}$')
);

create table competition_registration_freeze_teams (
  registration_freeze_id uuid not null,
  competition_id uuid not null,
  position smallint not null,
  competition_team_id uuid not null references competition_teams (competition_team_id),
  captain_gaming_member_id uuid not null references gaming_members (gaming_member_id),
  member_count smallint not null,
  constraint competition_registration_freeze_teams_pkey primary key (registration_freeze_id, position),
  constraint competition_registration_freeze_teams_team_key unique (registration_freeze_id, competition_team_id),
  constraint competition_registration_freeze_teams_freeze_fkey foreign key (competition_id, registration_freeze_id)
    references competition_registration_freezes (competition_id, registration_freeze_id) deferrable initially deferred,
  constraint competition_registration_freeze_teams_position_range check (position between 1 and 4),
  constraint competition_registration_freeze_teams_member_count check (member_count between 0 and 16)
);

create table competition_registration_freeze_members (
  registration_freeze_id uuid not null,
  competition_id uuid not null,
  competition_team_id uuid not null,
  gaming_member_id uuid not null references gaming_members (gaming_member_id),
  competition_team_membership_id uuid not null references competition_team_memberships (competition_team_membership_id),
  constraint competition_registration_freeze_members_pkey primary key (registration_freeze_id, gaming_member_id),
  constraint competition_registration_freeze_members_membership_key unique (registration_freeze_id, competition_team_membership_id),
  constraint competition_registration_freeze_members_team_fkey foreign key (registration_freeze_id, competition_team_id)
    references competition_registration_freeze_teams (registration_freeze_id, competition_team_id) deferrable initially deferred,
  constraint competition_registration_freeze_members_freeze_fkey foreign key (competition_id, registration_freeze_id)
    references competition_registration_freezes (competition_id, registration_freeze_id) deferrable initially deferred
);

-- 2/8  Server-only: no browser role holds any privilege, and not even the server role can write a row directly (the close operation does that).
alter table competition_registration_freezes enable row level security;
alter table competition_registration_freeze_teams enable row level security;
alter table competition_registration_freeze_members enable row level security;

revoke all on table competition_registration_freezes from public, anon, authenticated, service_role;
revoke all on table competition_registration_freeze_teams from public, anon, authenticated, service_role;
revoke all on table competition_registration_freeze_members from public, anon, authenticated, service_role;

grant select on table competition_registration_freezes to service_role;
grant select on table competition_registration_freeze_teams to service_role;
grant select on table competition_registration_freeze_members to service_role;

-- 3/8  Append-only: a recorded freeze never changes, whoever asks.
create function competition_registration_freeze_reject_change()
 returns trigger
 language plpgsql
 set search_path = public, pg_temp
as $function$
begin
  raise exception 'REGISTRATION_FREEZE_IMMUTABLE: a recorded registration freeze cannot be changed or removed' using errcode = 'P0001';
end;
$function$;
revoke all on function competition_registration_freeze_reject_change() from public, anon, authenticated;
revoke all on function competition_registration_freeze_reject_change() from service_role;

create trigger competition_registration_freezes_immutable_rows before update or delete on competition_registration_freezes
  for each row execute function competition_registration_freeze_reject_change();
create trigger competition_registration_freeze_teams_immutable_rows before update or delete on competition_registration_freeze_teams
  for each row execute function competition_registration_freeze_reject_change();
create trigger competition_registration_freeze_members_immutable_rows before update or delete on competition_registration_freeze_members
  for each row execute function competition_registration_freeze_reject_change();

create trigger competition_registration_freezes_immutable_truncate before truncate on competition_registration_freezes
  for each statement execute function competition_registration_freeze_reject_change();
create trigger competition_registration_freeze_teams_immutable_truncate before truncate on competition_registration_freeze_teams
  for each statement execute function competition_registration_freeze_reject_change();
create trigger competition_registration_freeze_members_immutable_truncate before truncate on competition_registration_freeze_members
  for each statement execute function competition_registration_freeze_reject_change();

-- 4/8  The internal helpers. Nobody can call them directly; the registration operations (which run as the database owner) do.
--
-- The ONE clock. Every deadline decision reads the database clock through this function and nothing else; its body is clock_timestamp() so that
-- the instant is the moment of the decision (taken after the competition's lock), not the moment the transaction began. No setting, table or
-- argument can move it. Only the database owner could redefine it, which the contract tests do inside transactions they roll back.
create function competition_registration_clock()
 returns timestamptz
 language sql
 volatile
 set search_path = public, pg_temp
as $function$ select clock_timestamp() $function$;
revoke all on function competition_registration_clock() from public, anon, authenticated;
revoke all on function competition_registration_clock() from service_role;

-- At the exact deadline instant registration is closed: the instant is "reached" when it is equal to or later than the deadline.
create function competition_registration_deadline_reached(p_deadline timestamptz, p_instant timestamptz)
 returns boolean
 language sql
 immutable
 set search_path = public, pg_temp
as $function$ select coalesce(p_instant >= p_deadline, false) $function$;
revoke all on function competition_registration_deadline_reached(timestamptz, timestamptz) from public, anon, authenticated;
revoke all on function competition_registration_deadline_reached(timestamptz, timestamptz) from service_role;

-- The current (highest-numbered) planning revision of one competition: the authority for the deadline and the roster bounds. No row when there is none.
create function competition_current_registration_plan(p_competition_id uuid)
 returns table(planning_revision_id uuid, format_key text, roster_minimum smallint, roster_maximum smallint, registration_deadline_utc timestamptz)
 language sql
 volatile
 set search_path = public, pg_temp
as $function$
  select r.planning_revision_id, r.format_key, r.roster_minimum, r.roster_maximum, r.registration_deadline_utc
    from competition_planning_revisions r
   where r.competition_id = p_competition_id
   order by r.revision_number desc
   limit 1
$function$;
revoke all on function competition_current_registration_plan(uuid) from public, anon, authenticated;
revoke all on function competition_current_registration_plan(uuid) from service_role;

create function competition_registration_frozen(p_competition_id uuid)
 returns boolean
 language sql
 volatile
 set search_path = public, pg_temp
as $function$
  select exists (select 1 from competition_registration_freezes f where f.competition_id = p_competition_id)
$function$;
revoke all on function competition_registration_frozen(uuid) from public, anon, authenticated;
revoke all on function competition_registration_frozen(uuid) from service_role;

-- Whether a plan can be the authority for registration: it is of the competition's OWN format; its roster bounds lie inside the registry's ranges for that
-- format (and the minimum is not above the maximum); and its deadline is an exact instant to the millisecond — the precision Organizer Planning accepts and the
-- precision the freeze records and hashes, so no deadline is ever rounded into another instant. false for anything missing or malformed: "closed", never a guess.
create function competition_registration_plan_usable(p_activity_key text, p_plan_format text, p_roster_minimum integer, p_roster_maximum integer, p_deadline timestamptz)
 returns boolean
 language plpgsql
 stable
 set search_path = public, pg_temp
as $function$
declare
  v_rule competition_format_rules%rowtype;
begin
  if p_activity_key is null or p_plan_format is null or p_roster_minimum is null or p_roster_maximum is null or p_deadline is null then
    return false;
  end if;
  if p_plan_format <> p_activity_key or p_deadline <> date_trunc('milliseconds', p_deadline) then
    return false;
  end if;
  select * into v_rule from competition_format_rules r where r.format_key = p_activity_key;
  if not found then
    return false;
  end if;
  return p_roster_minimum between v_rule.roster_minimum_range_low and v_rule.roster_minimum_range_high
     and p_roster_maximum between v_rule.roster_maximum_range_low and v_rule.roster_maximum_range_high
     and p_roster_maximum <= v_rule.roster_absolute_maximum
     and p_roster_minimum <= p_roster_maximum;
end;
$function$;
revoke all on function competition_registration_plan_usable(text, text, integer, integer, timestamptz) from public, anon, authenticated;
revoke all on function competition_registration_plan_usable(text, text, integer, integer, timestamptz) from service_role;

-- The rule for a NEW entry (a registration, an organizer-added team, a proposed team, a join request). The caller already holds the competition's lock.
--   * It NEVER returns successfully without a usable current plan: with none (or an unusable one) registration is CLOSED, with the same bounded answer for
--     every reason. (The one place a competition may legitimately have no plan — a DRAFT whose organizer is still preparing its teams — is decided by that
--     caller, visibly, and never by this rule.)
--   * A frozen competition accepts nothing.
--   * At or after the plan's deadline (by the database clock) registration is closed.
-- It raises the existing "not open" code, which the application already maps to a conflict.
create function competition_assert_registration_intake_open(p_competition_id uuid)
 returns void
 language plpgsql
 volatile
 set search_path = public, pg_temp
as $function$
declare
  v_state text;
  v_activity_key text;
  v_revision uuid;
  v_format text;
  v_minimum smallint;
  v_maximum smallint;
  v_deadline timestamptz;
begin
  select competitions.state, competitions.activity_key into v_state, v_activity_key
    from competitions where competitions.competition_id = p_competition_id;
  select p.planning_revision_id, p.format_key, p.roster_minimum, p.roster_maximum, p.registration_deadline_utc
    into v_revision, v_format, v_minimum, v_maximum, v_deadline
    from competition_current_registration_plan(p_competition_id) p;

  if v_state is null then
    raise exception 'TEAM_REGISTRATION_NOT_OPEN: registration is closed for this competition' using errcode = 'P0001';
  end if;
  if competition_registration_frozen(p_competition_id) then
    raise exception 'TEAM_REGISTRATION_NOT_OPEN: registration for this competition is frozen and no longer accepts new entries' using errcode = 'P0001';
  end if;
  if v_revision is null or not competition_registration_plan_usable(v_activity_key, v_format, v_minimum, v_maximum, v_deadline) then
    raise exception 'TEAM_REGISTRATION_NOT_OPEN: registration is closed for this competition' using errcode = 'P0001';
  end if;
  if competition_registration_deadline_reached(v_deadline, competition_registration_clock()) then
    raise exception 'TEAM_REGISTRATION_NOT_OPEN: the registration deadline for this competition has passed' using errcode = 'P0001';
  end if;
end;
$function$;
revoke all on function competition_assert_registration_intake_open(uuid) from public, anon, authenticated;
revoke all on function competition_assert_registration_intake_open(uuid) from service_role;

-- The rule for deciding work that was received earlier: it needs the usable plan that dates it (without one, registration is closed and nothing pending is
-- decided); after the deadline only an entry created strictly BEFORE it may still be decided; and once the competition is frozen no approval may change
-- membership. The caller has already proved its authority; this only judges the entry.
create function competition_assert_registration_decision_allowed(p_competition_id uuid, p_decision text, p_item_created_at timestamptz)
 returns void
 language plpgsql
 volatile
 set search_path = public, pg_temp
as $function$
declare
  v_state text;
  v_activity_key text;
  v_revision uuid;
  v_format text;
  v_minimum smallint;
  v_maximum smallint;
  v_deadline timestamptz;
begin
  select competitions.state, competitions.activity_key into v_state, v_activity_key
    from competitions where competitions.competition_id = p_competition_id;
  select p.planning_revision_id, p.format_key, p.roster_minimum, p.roster_maximum, p.registration_deadline_utc
    into v_revision, v_format, v_minimum, v_maximum, v_deadline
    from competition_current_registration_plan(p_competition_id) p;

  if v_state is null then
    raise exception 'TEAM_REGISTRATION_NOT_OPEN: registration is closed for this competition' using errcode = 'P0001';
  end if;
  if p_decision = 'APPROVE' and competition_registration_frozen(p_competition_id) then
    raise exception 'TEAM_REGISTRATION_NOT_OPEN: registration is frozen and team membership can no longer change' using errcode = 'P0001';
  end if;
  if v_revision is null or not competition_registration_plan_usable(v_activity_key, v_format, v_minimum, v_maximum, v_deadline) then
    raise exception 'TEAM_REGISTRATION_NOT_OPEN: registration is closed for this competition' using errcode = 'P0001';
  end if;
  if competition_registration_deadline_reached(v_deadline, competition_registration_clock())
     and not coalesce(p_item_created_at < v_deadline, false) then
    raise exception 'TEAM_REGISTRATION_NOT_OPEN: this entry was created at or after the registration deadline and cannot be decided' using errcode = 'P0001';
  end if;
end;
$function$;
revoke all on function competition_assert_registration_decision_allowed(uuid, text, timestamptz) from public, anon, authenticated;
revoke all on function competition_assert_registration_decision_allowed(uuid, text, timestamptz) from service_role;

-- The deterministic digest of the frozen competitive data. The canonical text is, one item per line and without a trailing newline:
--   URBANO-REGISTRATION-FREEZE-V1 / competition:<id> / revision:<id> / format:<key> / roster:<min>-<max> / deadline:<UTC, exactly three fractional digits, Z>
--   then, for each team ordered by team id (byte order): team:<id>|captain:<id>|members:<member ids ordered by id, comma separated>
-- The deadline is the exact instant to the millisecond (for example 2026-11-01T00:00:00.250Z), so two deadlines that differ only in milliseconds never share a
-- digest; an instant finer than a millisecond is refused rather than truncated. Who froze it, when, and the freeze's own id are not competitive data and are
-- not part of it. The input order never matters.
create function competition_registration_freeze_digest(p_competition_id uuid, p_revision_id uuid, p_format text, p_min integer, p_max integer, p_deadline timestamptz, p_teams jsonb)
 returns text
 language plpgsql
 stable
 set search_path = public, pg_temp
as $function$
declare
  v_text text;
  v_team record;
  v_members text;
begin
  if p_deadline is null or p_deadline <> date_trunc('milliseconds', p_deadline) then
    raise exception 'REGISTRATION_FREEZE_INVALID: the registration deadline must be an exact instant to the millisecond' using errcode = 'P0001';
  end if;
  v_text := 'URBANO-REGISTRATION-FREEZE-V1'
    || E'\ncompetition:' || p_competition_id::text
    || E'\nrevision:' || p_revision_id::text
    || E'\nformat:' || p_format
    || E'\nroster:' || p_min::text || '-' || p_max::text
    || E'\ndeadline:' || to_char(p_deadline at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
  for v_team in
    select t.value as team from jsonb_array_elements(p_teams) t order by (t.value ->> 'team') collate "C"
  loop
    select coalesce(string_agg(m.value, ',' order by m.value collate "C"), '') into v_members
      from jsonb_array_elements_text(v_team.team -> 'members') m;
    v_text := v_text || E'\nteam:' || (v_team.team ->> 'team') || '|captain:' || (v_team.team ->> 'captain') || '|members:' || v_members;
  end loop;
  return encode(sha256(convert_to(v_text, 'UTF8')), 'hex');
end;
$function$;
revoke all on function competition_registration_freeze_digest(uuid, uuid, text, integer, integer, timestamptz, jsonb) from public, anon, authenticated;
revoke all on function competition_registration_freeze_digest(uuid, uuid, text, integer, integer, timestamptz, jsonb) from service_role;

-- 5/8  The evidence is consistent whatever wrote it. A child row must describe a real, current fact of the live tables; and at commit the freeze
-- header's counts, roster bounds and digest must agree with the rows actually stored.
create function competition_registration_freeze_check_child()
 returns trigger
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
begin
  if tg_table_name = 'competition_registration_freeze_teams' then
    if not exists (
      select 1 from competition_teams t
       where t.competition_team_id = new.competition_team_id and t.competition_id = new.competition_id
         and t.captain_gaming_member_id = new.captain_gaming_member_id and t.status = 'ACCEPTED'
    ) then
      raise exception 'REGISTRATION_FREEZE_INVALID: a frozen team must be an accepted team of the same competition with the same captain' using errcode = 'P0001';
    end if;
  else
    if not exists (
      select 1 from competition_team_memberships m
       where m.competition_team_membership_id = new.competition_team_membership_id and m.competition_id = new.competition_id
         and m.competition_team_id = new.competition_team_id and m.gaming_member_id = new.gaming_member_id
    ) then
      raise exception 'REGISTRATION_FREEZE_INVALID: a frozen member must be a real membership of the same team and competition' using errcode = 'P0001';
    end if;
  end if;
  return new;
end;
$function$;
revoke all on function competition_registration_freeze_check_child() from public, anon, authenticated;
revoke all on function competition_registration_freeze_check_child() from service_role;

create trigger competition_registration_freeze_teams_check before insert on competition_registration_freeze_teams
  for each row execute function competition_registration_freeze_check_child();
create trigger competition_registration_freeze_members_check before insert on competition_registration_freeze_members
  for each row execute function competition_registration_freeze_check_child();

create function competition_registration_freeze_verify()
 returns trigger
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
declare
  v_team_rows integer;
  v_member_rows integer;
  v_bad integer;
  v_teams jsonb;
begin
  select count(*) into v_team_rows from competition_registration_freeze_teams t where t.registration_freeze_id = new.registration_freeze_id;
  select count(*) into v_member_rows from competition_registration_freeze_members m where m.registration_freeze_id = new.registration_freeze_id;
  if v_team_rows <> 4 or v_team_rows <> new.team_count or v_member_rows <> new.member_count then
    raise exception 'REGISTRATION_FREEZE_INVALID: the frozen counts do not match the frozen rows' using errcode = 'P0001';
  end if;
  select count(*) into v_bad
    from competition_registration_freeze_teams t
   where t.registration_freeze_id = new.registration_freeze_id
     and (t.member_count <> (select count(*) from competition_registration_freeze_members m where m.registration_freeze_id = t.registration_freeze_id and m.competition_team_id = t.competition_team_id)
          or t.member_count < new.roster_minimum or t.member_count > new.roster_maximum);
  if v_bad > 0 then
    raise exception 'REGISTRATION_FREEZE_INVALID: every frozen roster must match its rows and lie within the configured bounds' using errcode = 'P0001';
  end if;
  select jsonb_agg(jsonb_build_object(
           'team', t.competition_team_id, 'captain', t.captain_gaming_member_id,
           'members', coalesce((select jsonb_agg(m.gaming_member_id) from competition_registration_freeze_members m
                                 where m.registration_freeze_id = t.registration_freeze_id and m.competition_team_id = t.competition_team_id), '[]'::jsonb)))
    into v_teams
    from competition_registration_freeze_teams t where t.registration_freeze_id = new.registration_freeze_id;
  if competition_registration_freeze_digest(new.competition_id, new.planning_revision_id, new.format_key, new.roster_minimum, new.roster_maximum, new.registration_deadline_utc, v_teams)
       is distinct from new.snapshot_digest then
    raise exception 'REGISTRATION_FREEZE_INVALID: the digest does not match the frozen data' using errcode = 'P0001';
  end if;
  return null;
end;
$function$;
revoke all on function competition_registration_freeze_verify() from public, anon, authenticated;
revoke all on function competition_registration_freeze_verify() from service_role;

create constraint trigger competition_registration_freezes_verify after insert on competition_registration_freezes
  deferrable initially deferred
  for each row execute function competition_registration_freeze_verify();

-- 6/8  The bounded, server-only read behind the addressed competition view: the deadline facts and whether the server is accepting new entries.
-- It reads the same clock the operations use, so "passed" and "accepting" are the database's own words. A draft competition's plan is still a draft
-- and is not reported; a competition with no usable plan has nothing to report (and the operations treat it as closed).
create function get_competition_registration_status(p_competition_id uuid)
 returns table(deadline_utc timestamptz, time_zone text, deadline_local timestamp, deadline_passed boolean, accepting_new_writes boolean, is_frozen boolean, roster_minimum smallint, roster_maximum smallint)
 language plpgsql
 volatile
 security definer
 set search_path = public, pg_temp
as $function$
#variable_conflict use_column
declare
  v_state text;
  v_now timestamptz;
  v_frozen boolean;
begin
  select competitions.state into v_state from competitions where competitions.competition_id = p_competition_id;
  if v_state is null or v_state = 'DRAFT' then
    return;
  end if;
  v_now := competition_registration_clock();
  v_frozen := competition_registration_frozen(p_competition_id);
  return query
    select r.registration_deadline_utc, r.registration_deadline_time_zone, r.registration_deadline_local,
           competition_registration_deadline_reached(r.registration_deadline_utc, v_now),
           (v_state = 'TEAM_REGISTRATION_OPEN' and not v_frozen and not competition_registration_deadline_reached(r.registration_deadline_utc, v_now)),
           v_frozen, r.roster_minimum, r.roster_maximum
      from (select cur.* from competition_planning_revisions cur where cur.competition_id = p_competition_id order by cur.revision_number desc limit 1) r
      join competitions c on c.competition_id = r.competition_id
     where v_frozen or competition_registration_plan_usable(c.activity_key, r.format_key, r.roster_minimum, r.roster_maximum, r.registration_deadline_utc);
end;
$function$;
revoke all on function get_competition_registration_status(uuid) from public, anon, authenticated;
grant execute on function get_competition_registration_status(uuid) to service_role;

-- 7/8  Opening requires a usable plan. Order is unchanged up to the state check (lock, ownership, host guard, DRAFT); only then is the plan judged.
create or replace function open_team_registration_atomically(p_competition_id uuid, p_organizer_gaming_member_id uuid)
 returns table(competition_id uuid, state text)
 language plpgsql
 security definer
 set search_path = public
as $function$
declare
  v_organizer_id uuid;
  v_state text;
  v_activity_key text;
  v_plan_revision_id uuid;
  v_plan_format text;
  v_roster_minimum integer;
  v_roster_maximum integer;
  v_deadline timestamptz;
begin
  perform pg_advisory_xact_lock(hashtext('competition_scope:' || p_competition_id::text));

  select competitions.organizer_gaming_member_id, competitions.state, competitions.activity_key
    into v_organizer_id, v_state, v_activity_key
    from competitions
   where competitions.competition_id = p_competition_id
   for update;

  if v_organizer_id is null then
    raise exception 'COMPETITION_NOT_FOUND: no such competition exists' using errcode = 'P0001';
  end if;

  if p_organizer_gaming_member_id is distinct from v_organizer_id then
    raise exception 'COMPETITION_ACCESS_DENIED: only this competition''s own organizer may open team registration'
      using errcode = 'P0001';
  end if;
  perform assert_competition_not_host_revoked(p_competition_id);

  if v_state <> 'DRAFT' then
    raise exception 'COMPETITION_NOT_DRAFT: team registration may only be opened while the competition is DRAFT'
      using errcode = 'P0001';
  end if;

  select p.planning_revision_id, p.format_key, p.roster_minimum, p.roster_maximum, p.registration_deadline_utc
    into v_plan_revision_id, v_plan_format, v_roster_minimum, v_roster_maximum, v_deadline
    from competition_current_registration_plan(p_competition_id) p;

  if v_plan_revision_id is null then
    raise exception 'REGISTRATION_OPENING_PLAN_MISSING: save a registration plan before opening team registration' using errcode = 'P0001';
  end if;

  if not competition_registration_plan_usable(v_activity_key, v_plan_format, v_roster_minimum, v_roster_maximum, v_deadline) then
    raise exception 'REGISTRATION_OPENING_PLAN_INVALID: the saved plan does not match this competition''s format and roster rules' using errcode = 'P0001';
  end if;

  if competition_registration_deadline_reached(v_deadline, competition_registration_clock()) then
    raise exception 'REGISTRATION_OPENING_DEADLINE_EXPIRED: the registration deadline has already passed' using errcode = 'P0001';
  end if;

  update competitions set state = 'TEAM_REGISTRATION_OPEN' where competitions.competition_id = p_competition_id;

  return query select p_competition_id, 'TEAM_REGISTRATION_OPEN'::text;
end;
$function$;

-- 8/8  New entries are refused at and after the deadline and once frozen; decisions are judged by when their entry was created.
create or replace function register_for_competition_atomically(p_competition_id uuid, p_gaming_member_id uuid, p_is_adult_self_attested boolean)
 returns table(competition_registration_id uuid, registered_at timestamptz, already_registered boolean)
 language plpgsql
 security definer
 set search_path = public
as $function$
declare
  v_state text;
  v_existing_id uuid;
  v_existing_at timestamptz;
  v_new_id uuid;
  v_new_at timestamptz;
begin
  perform pg_advisory_xact_lock(hashtext('competition_scope:' || p_competition_id::text));

  select competitions.state into v_state
    from competitions
   where competitions.competition_id = p_competition_id
   for update;

  if v_state is null then
    raise exception 'COMPETITION_NOT_FOUND: no such competition exists' using errcode = 'P0001';
  end if;

  select competition_registrations.competition_registration_id, competition_registrations.registered_at
    into v_existing_id, v_existing_at
    from competition_registrations
   where competition_registrations.competition_id = p_competition_id
     and competition_registrations.gaming_member_id = p_gaming_member_id;

  if v_existing_id is not null then
    return query select v_existing_id, v_existing_at, true;
    return;
  end if;

  if v_state not in ('TEAM_REGISTRATION_OPEN', 'READY_TO_PUBLISH', 'PUBLISHED') then
    raise exception 'COMPETITION_NOT_PUBLISHED: registration is only open once the organizer has opened team registration'
      using errcode = 'P0001';
  end if;

  perform competition_assert_registration_intake_open(p_competition_id);

  insert into competition_registrations (competition_id, gaming_member_id, is_adult_self_attested)
  values (p_competition_id, p_gaming_member_id, p_is_adult_self_attested)
  returning competition_registrations.competition_registration_id, competition_registrations.registered_at
  into v_new_id, v_new_at;

  return query select v_new_id, v_new_at, false;
end;
$function$;

create or replace function add_competition_team_atomically(p_competition_id uuid, p_organizer_gaming_member_id uuid, p_name text, p_captain_gaming_member_id uuid)
 returns table(competition_team_id uuid, created_at timestamptz)
 language plpgsql
 security definer
 set search_path = public
as $function$
declare
  v_organizer_id uuid;
  v_state text;
  v_team_id uuid;
  v_created_at timestamptz;
  v_accepted_count integer;
begin
  perform pg_advisory_xact_lock(hashtext('competition_scope:' || p_competition_id::text));

  select competitions.organizer_gaming_member_id, competitions.state
    into v_organizer_id, v_state
    from competitions
   where competitions.competition_id = p_competition_id
   for update;

  if v_organizer_id is null then
    raise exception 'COMPETITION_NOT_FOUND: no such competition exists' using errcode = 'P0001';
  end if;

  if p_organizer_gaming_member_id is distinct from v_organizer_id then
    raise exception 'COMPETITION_ACCESS_DENIED: only this competition''s own organizer may add a team'
      using errcode = 'P0001';
  end if;
  perform assert_competition_not_host_revoked(p_competition_id);

  if v_state not in ('DRAFT', 'TEAM_REGISTRATION_OPEN') then
    raise exception 'COMPETITION_NOT_DRAFT: teams may only be added while the competition is DRAFT or TEAM_REGISTRATION_OPEN'
      using errcode = 'P0001';
  end if;

  -- A DRAFT that has no plan at all has not opened registration: its organizer may still prepare its teams, exactly as before, and nothing is judged. Every
  -- other competition — a DRAFT that has a plan, or any later state — is judged by the intake rule, which never lets a missing plan through.
  if v_state <> 'DRAFT' or exists (select 1 from competition_planning_revisions r where r.competition_id = p_competition_id) then
    perform competition_assert_registration_intake_open(p_competition_id);
  end if;

  perform pg_advisory_xact_lock(hashtext('competition_team_scope:' || p_competition_id::text));

  select count(*) into v_accepted_count
    from competition_teams
   where competition_teams.competition_id = p_competition_id
     and competition_teams.status = 'ACCEPTED';

  if v_accepted_count >= 4 then
    raise exception 'TEAM_CAPACITY_REACHED: four teams have already been accepted for this competition'
      using errcode = 'P0001';
  end if;

  begin
    insert into competition_teams (competition_id, name, captain_gaming_member_id, status, provenance)
    values (p_competition_id, p_name, p_captain_gaming_member_id, 'ACCEPTED', 'ORGANIZER_CREATED')
    returning competition_teams.competition_team_id, competition_teams.created_at
    into v_team_id, v_created_at;
  exception
    when unique_violation then
      if sqlerrm like '%competition_teams_unique_name_per_competition%' then
        raise exception 'DUPLICATE_TEAM_NAME: a team with this name already exists in this competition' using errcode = 'P0001';
      elsif sqlerrm like '%competition_teams_one_active_captaincy%' then
        raise exception 'ALREADY_CAPTAIN_OR_MEMBER: this member already holds an active team role in this competition' using errcode = 'P0001';
      else
        raise;
      end if;
  end;

  return query select v_team_id, v_created_at;
end;
$function$;

create or replace function add_competition_team_atomically(p_competition_id uuid, p_organizer_gaming_member_id uuid, p_name text, p_captain_gaming_member_id uuid, p_public_code text)
 returns table(competition_team_id uuid, created_at timestamptz)
 language plpgsql
 security definer
 set search_path = public
as $function$
declare
  v_organizer_id uuid;
  v_state text;
  v_team_id uuid;
  v_created_at timestamptz;
  v_accepted_count integer;
begin
  if p_public_code is null or length(trim(p_public_code)) = 0 then
    raise exception 'PUBLIC_CODE_REQUIRED: an opaque public code is required' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('competition_scope:' || p_competition_id::text));

  select competitions.organizer_gaming_member_id, competitions.state
    into v_organizer_id, v_state
    from competitions
   where competitions.competition_id = p_competition_id
   for update;

  if v_organizer_id is null then
    raise exception 'COMPETITION_NOT_FOUND: no such competition exists' using errcode = 'P0001';
  end if;

  if p_organizer_gaming_member_id is distinct from v_organizer_id then
    raise exception 'COMPETITION_ACCESS_DENIED: only this competition''s own organizer may add a team'
      using errcode = 'P0001';
  end if;
  perform assert_competition_not_host_revoked(p_competition_id);

  if v_state not in ('DRAFT', 'TEAM_REGISTRATION_OPEN') then
    raise exception 'COMPETITION_NOT_DRAFT: teams may only be added while the competition is DRAFT or TEAM_REGISTRATION_OPEN'
      using errcode = 'P0001';
  end if;

  -- A DRAFT that has no plan at all has not opened registration: its organizer may still prepare its teams, exactly as before, and nothing is judged. Every
  -- other competition — a DRAFT that has a plan, or any later state — is judged by the intake rule, which never lets a missing plan through.
  if v_state <> 'DRAFT' or exists (select 1 from competition_planning_revisions r where r.competition_id = p_competition_id) then
    perform competition_assert_registration_intake_open(p_competition_id);
  end if;

  perform pg_advisory_xact_lock(hashtext('competition_team_scope:' || p_competition_id::text));

  select count(*) into v_accepted_count
    from competition_teams
   where competition_teams.competition_id = p_competition_id
     and competition_teams.status = 'ACCEPTED';

  if v_accepted_count >= 4 then
    raise exception 'TEAM_CAPACITY_REACHED: four teams have already been accepted for this competition'
      using errcode = 'P0001';
  end if;

  begin
    insert into competition_teams (competition_id, name, captain_gaming_member_id, status, provenance, public_code)
    values (p_competition_id, p_name, p_captain_gaming_member_id, 'ACCEPTED', 'ORGANIZER_CREATED', p_public_code)
    returning competition_teams.competition_team_id, competition_teams.created_at
    into v_team_id, v_created_at;
  exception
    when unique_violation then
      if sqlerrm like '%competition_teams_unique_name_per_competition%' then
        raise exception 'DUPLICATE_TEAM_NAME: a team with this name already exists in this competition' using errcode = 'P0001';
      elsif sqlerrm like '%competition_teams_one_active_captaincy%' then
        raise exception 'ALREADY_CAPTAIN_OR_MEMBER: this member already holds an active team role in this competition' using errcode = 'P0001';
      else
        raise;
      end if;
  end;

  return query select v_team_id, v_created_at;
end;
$function$;

create or replace function propose_competition_team_atomically(p_competition_id uuid, p_name text, p_proposing_gaming_member_id uuid)
 returns table(competition_team_id uuid, status text, created_at timestamptz)
 language plpgsql
 security definer
 set search_path = public
as $function$
declare
  v_state text;
  v_registered boolean;
  v_has_membership boolean;
  v_has_active_captaincy boolean;
  v_team_id uuid;
  v_created_at timestamptz;
begin
  perform pg_advisory_xact_lock(hashtext('competition_scope:' || p_competition_id::text));

  select competitions.state into v_state
    from competitions
   where competitions.competition_id = p_competition_id
   for update;

  if v_state is null then
    raise exception 'COMPETITION_NOT_FOUND: no such competition exists' using errcode = 'P0001';
  end if;

  if v_state <> 'TEAM_REGISTRATION_OPEN' then
    raise exception 'TEAM_REGISTRATION_NOT_OPEN: team proposals are only accepted while team registration is open'
      using errcode = 'P0001';
  end if;

  perform competition_assert_registration_intake_open(p_competition_id);

  select exists(
    select 1 from competition_registrations
    where competition_registrations.competition_id = p_competition_id
      and competition_registrations.gaming_member_id = p_proposing_gaming_member_id
  ) into v_registered;

  if not v_registered then
    raise exception 'COMPETITION_REGISTRATION_REQUIRED: register for this competition before proposing a team'
      using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('competition_team_scope:' || p_competition_id::text));

  select exists(
    select 1 from competition_team_memberships
    where competition_team_memberships.competition_id = p_competition_id
      and competition_team_memberships.gaming_member_id = p_proposing_gaming_member_id
  ) into v_has_membership;

  if v_has_membership then
    raise exception 'ALREADY_TEAM_MEMBER: this member already holds a team membership in this competition'
      using errcode = 'P0001';
  end if;

  select exists(
    select 1 from competition_teams
    where competition_teams.competition_id = p_competition_id
      and competition_teams.captain_gaming_member_id = p_proposing_gaming_member_id
      and competition_teams.status <> 'REJECTED'
  ) into v_has_active_captaincy;

  if v_has_active_captaincy then
    raise exception 'ALREADY_CAPTAIN_OR_MEMBER: this member already holds an active team role in this competition'
      using errcode = 'P0001';
  end if;

  begin
    insert into competition_teams (competition_id, name, captain_gaming_member_id, status, provenance)
    values (p_competition_id, p_name, p_proposing_gaming_member_id, 'PENDING_ORGANIZER_APPROVAL', 'MEMBER_PROPOSED')
    returning competition_teams.competition_team_id, competition_teams.created_at
    into v_team_id, v_created_at;
  exception
    when unique_violation then
      if sqlerrm like '%competition_teams_unique_name_per_competition%' then
        raise exception 'DUPLICATE_TEAM_NAME: a team with this name already exists in this competition' using errcode = 'P0001';
      elsif sqlerrm like '%competition_teams_one_active_captaincy%' then
        raise exception 'ALREADY_CAPTAIN_OR_MEMBER: this member already holds an active team role in this competition' using errcode = 'P0001';
      else
        raise;
      end if;
  end;

  return query select v_team_id, 'PENDING_ORGANIZER_APPROVAL'::text, v_created_at;
end;
$function$;

create or replace function propose_competition_team_atomically(p_competition_id uuid, p_name text, p_proposing_gaming_member_id uuid, p_public_code text)
 returns table(competition_team_id uuid, status text, created_at timestamptz)
 language plpgsql
 security definer
 set search_path = public
as $function$
declare
  v_state text;
  v_registered boolean;
  v_has_membership boolean;
  v_has_active_captaincy boolean;
  v_team_id uuid;
  v_created_at timestamptz;
begin
  if p_public_code is null or length(trim(p_public_code)) = 0 then
    raise exception 'PUBLIC_CODE_REQUIRED: an opaque public code is required' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('competition_scope:' || p_competition_id::text));

  select competitions.state into v_state
    from competitions
   where competitions.competition_id = p_competition_id
   for update;

  if v_state is null then
    raise exception 'COMPETITION_NOT_FOUND: no such competition exists' using errcode = 'P0001';
  end if;

  if v_state <> 'TEAM_REGISTRATION_OPEN' then
    raise exception 'TEAM_REGISTRATION_NOT_OPEN: team proposals are only accepted while team registration is open'
      using errcode = 'P0001';
  end if;

  perform competition_assert_registration_intake_open(p_competition_id);

  select exists(
    select 1 from competition_registrations
    where competition_registrations.competition_id = p_competition_id
      and competition_registrations.gaming_member_id = p_proposing_gaming_member_id
  ) into v_registered;

  if not v_registered then
    raise exception 'COMPETITION_REGISTRATION_REQUIRED: register for this competition before proposing a team'
      using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('competition_team_scope:' || p_competition_id::text));

  select exists(
    select 1 from competition_team_memberships
    where competition_team_memberships.competition_id = p_competition_id
      and competition_team_memberships.gaming_member_id = p_proposing_gaming_member_id
  ) into v_has_membership;

  if v_has_membership then
    raise exception 'ALREADY_TEAM_MEMBER: this member already holds a team membership in this competition'
      using errcode = 'P0001';
  end if;

  select exists(
    select 1 from competition_teams
    where competition_teams.competition_id = p_competition_id
      and competition_teams.captain_gaming_member_id = p_proposing_gaming_member_id
      and competition_teams.status <> 'REJECTED'
  ) into v_has_active_captaincy;

  if v_has_active_captaincy then
    raise exception 'ALREADY_CAPTAIN_OR_MEMBER: this member already holds an active team role in this competition'
      using errcode = 'P0001';
  end if;

  begin
    insert into competition_teams (competition_id, name, captain_gaming_member_id, status, provenance, public_code)
    values (p_competition_id, p_name, p_proposing_gaming_member_id, 'PENDING_ORGANIZER_APPROVAL', 'MEMBER_PROPOSED', p_public_code)
    returning competition_teams.competition_team_id, competition_teams.created_at
    into v_team_id, v_created_at;
  exception
    when unique_violation then
      if sqlerrm like '%competition_teams_unique_name_per_competition%' then
        raise exception 'DUPLICATE_TEAM_NAME: a team with this name already exists in this competition' using errcode = 'P0001';
      elsif sqlerrm like '%competition_teams_one_active_captaincy%' then
        raise exception 'ALREADY_CAPTAIN_OR_MEMBER: this member already holds an active team role in this competition' using errcode = 'P0001';
      else
        raise;
      end if;
  end;

  return query select v_team_id, 'PENDING_ORGANIZER_APPROVAL'::text, v_created_at;
end;
$function$;

create or replace function request_join_competition_team_atomically(p_competition_id uuid, p_competition_team_id uuid, p_requesting_gaming_member_id uuid)
 returns table(competition_join_request_id uuid, status text, created_at timestamptz)
 language plpgsql
 security definer
 set search_path = public
as $function$
declare
  v_team_competition_id uuid;
  v_team_status text;
  v_competition_state text;
  v_registered boolean;
  v_has_membership boolean;
  v_has_active_captaincy boolean;
  v_has_pending boolean;
  v_request_id uuid;
  v_created_at timestamptz;
begin
  perform pg_advisory_xact_lock(hashtext('competition_scope:' || p_competition_id::text));

  select competition_teams.competition_id, competition_teams.status
    into v_team_competition_id, v_team_status
    from competition_teams
   where competition_teams.competition_team_id = p_competition_team_id;

  if v_team_competition_id is null or v_team_competition_id <> p_competition_id then
    raise exception 'COMPETITION_TEAM_NOT_FOUND: no such team exists in this competition' using errcode = 'P0001';
  end if;

  select competitions.state into v_competition_state
    from competitions where competitions.competition_id = p_competition_id;

  if v_competition_state = 'CANCELLED_WITHOUT_CHAMPION' then
    raise exception 'COMPETITION_CANCELLED: this competition has been cancelled and no longer accepts this action'
      using errcode = 'P0001';
  end if;

  perform competition_assert_registration_intake_open(p_competition_id);

  if v_team_status <> 'ACCEPTED' then
    raise exception 'TEAM_NOT_ACCEPTED: this team has not yet been accepted for this competition' using errcode = 'P0001';
  end if;

  select exists(
    select 1 from competition_registrations
    where competition_registrations.competition_id = p_competition_id
      and competition_registrations.gaming_member_id = p_requesting_gaming_member_id
  ) into v_registered;

  if not v_registered then
    raise exception 'COMPETITION_REGISTRATION_REQUIRED: register for this competition before requesting a team'
      using errcode = 'P0001';
  end if;

  select exists(
    select 1 from competition_team_memberships
    where competition_team_memberships.competition_id = p_competition_id
      and competition_team_memberships.gaming_member_id = p_requesting_gaming_member_id
  ) into v_has_membership;

  if v_has_membership then
    raise exception 'ALREADY_TEAM_MEMBER: this member already holds a team membership in this competition'
      using errcode = 'P0001';
  end if;

  select exists(
    select 1 from competition_teams
    where competition_teams.competition_id = p_competition_id
      and competition_teams.captain_gaming_member_id = p_requesting_gaming_member_id
      and competition_teams.status <> 'REJECTED'
  ) into v_has_active_captaincy;

  if v_has_active_captaincy then
    raise exception 'ALREADY_CAPTAIN_OR_MEMBER: this member already holds an active team role in this competition'
      using errcode = 'P0001';
  end if;

  select exists(
    select 1 from competition_join_requests
    where competition_join_requests.competition_id = p_competition_id
      and competition_join_requests.requesting_gaming_member_id = p_requesting_gaming_member_id
      and competition_join_requests.status = 'REQUESTED'
  ) into v_has_pending;

  if v_has_pending then
    raise exception 'DUPLICATE_PENDING_JOIN_REQUEST: this member already has a pending join request in this competition'
      using errcode = 'P0001';
  end if;

  insert into competition_join_requests (competition_id, competition_team_id, requesting_gaming_member_id)
  values (p_competition_id, p_competition_team_id, p_requesting_gaming_member_id)
  returning competition_join_requests.competition_join_request_id, competition_join_requests.created_at
  into v_request_id, v_created_at;

  return query select v_request_id, 'REQUESTED'::text, v_created_at;
end;
$function$;

create or replace function decide_competition_team_atomically(p_competition_team_id uuid, p_organizer_gaming_member_id uuid, p_decision text, p_reason text)
 returns table(competition_team_id uuid, status text, decided_at timestamptz, competition_team_membership_id uuid)
 language plpgsql
 security definer
 set search_path = public
as $function$
declare
  v_lookup_competition_id uuid;
  v_competition_id uuid;
  v_competition_state text;
  v_current_status text;
  v_captain_id uuid;
  v_team_created_at timestamptz;
  v_organizer_id uuid;
  v_decided_at timestamptz;
  v_membership_id uuid;
  v_accepted_count integer;
begin
  if p_decision not in ('APPROVE', 'REJECT') then
    raise exception 'INVALID_DECISION: decision must be APPROVE or REJECT' using errcode = 'P0001';
  end if;

  select competition_teams.competition_id into v_lookup_competition_id
    from competition_teams
   where competition_teams.competition_team_id = p_competition_team_id;

  if v_lookup_competition_id is null then
    raise exception 'COMPETITION_TEAM_NOT_FOUND: no such team exists in this competition' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('competition_scope:' || v_lookup_competition_id::text));

  select competition_teams.competition_id, competition_teams.status, competition_teams.captain_gaming_member_id, competition_teams.created_at
    into v_competition_id, v_current_status, v_captain_id, v_team_created_at
    from competition_teams
   where competition_teams.competition_team_id = p_competition_team_id
   for update;

  if v_competition_id is null then
    raise exception 'COMPETITION_TEAM_NOT_FOUND: no such team exists in this competition' using errcode = 'P0001';
  end if;

  select competitions.organizer_gaming_member_id, competitions.state
    into v_organizer_id, v_competition_state
    from competitions where competitions.competition_id = v_competition_id;

  if p_organizer_gaming_member_id is distinct from v_organizer_id then
    raise exception 'COMPETITION_ACCESS_DENIED: only this competition''s own organizer may decide a team proposal'
      using errcode = 'P0001';
  end if;
  perform assert_competition_not_host_revoked(v_competition_id);

  if v_competition_state = 'CANCELLED_WITHOUT_CHAMPION' then
    raise exception 'COMPETITION_CANCELLED: this competition has been cancelled and no longer accepts this action'
      using errcode = 'P0001';
  end if;

  if v_current_status <> 'PENDING_ORGANIZER_APPROVAL' then
    if (v_current_status = 'ACCEPTED' and p_decision = 'APPROVE')
        or (v_current_status = 'REJECTED' and p_decision = 'REJECT') then
      select competition_teams.decided_at into v_decided_at
        from competition_teams where competition_teams.competition_team_id = p_competition_team_id;
      select competition_team_memberships.competition_team_membership_id into v_membership_id
        from competition_team_memberships
       where competition_team_memberships.competition_team_id = p_competition_team_id
         and competition_team_memberships.gaming_member_id = v_captain_id;
      return query select p_competition_team_id, v_current_status, v_decided_at, v_membership_id;
      return;
    end if;
    raise exception 'TEAM_DECISION_ALREADY_MADE: this team proposal has already been decided'
      using errcode = 'P0001';
  end if;

  perform competition_assert_registration_decision_allowed(v_competition_id, p_decision, v_team_created_at);

  if p_decision = 'REJECT' then
    if p_reason is null or length(trim(p_reason)) = 0 then
      raise exception 'REASON_REQUIRED: rejecting a team proposal requires a reason' using errcode = 'P0001';
    end if;

    v_decided_at := now();
    update competition_teams
       set status = 'REJECTED', rejection_reason = p_reason,
           decided_at = v_decided_at, decided_by_gaming_member_id = p_organizer_gaming_member_id
     where competition_teams.competition_team_id = p_competition_team_id;

    return query select p_competition_team_id, 'REJECTED'::text, v_decided_at, null::uuid;
    return;
  end if;

  perform pg_advisory_xact_lock(hashtext('competition_team_scope:' || v_competition_id::text));

  select count(*) into v_accepted_count
    from competition_teams
   where competition_teams.competition_id = v_competition_id
     and competition_teams.status = 'ACCEPTED';

  if v_accepted_count >= 4 then
    raise exception 'TEAM_CAPACITY_REACHED: four teams have already been accepted for this competition'
      using errcode = 'P0001';
  end if;

  v_decided_at := now();

  update competition_teams
     set status = 'ACCEPTED', decided_at = v_decided_at, decided_by_gaming_member_id = p_organizer_gaming_member_id
   where competition_teams.competition_team_id = p_competition_team_id;

  begin
    insert into competition_team_memberships (competition_id, competition_team_id, gaming_member_id, approved_by_gaming_member_id)
    values (v_competition_id, p_competition_team_id, v_captain_id, p_organizer_gaming_member_id)
    returning competition_team_memberships.competition_team_membership_id into v_membership_id;
  exception when unique_violation then
    raise exception 'ALREADY_TEAM_MEMBER: this member already holds a team membership in this competition'
      using errcode = 'P0001';
  end;

  return query select p_competition_team_id, 'ACCEPTED'::text, v_decided_at, v_membership_id;
end;
$function$;

create or replace function decide_join_request_atomically(p_competition_join_request_id uuid, p_deciding_gaming_member_id uuid, p_decision text, p_is_organizer_override boolean)
 returns table(competition_join_request_id uuid, status text, decided_at timestamptz, competition_team_membership_id uuid)
 language plpgsql
 security definer
 set search_path = public
as $function$
declare
  v_lookup_competition_id uuid;
  v_competition_id uuid;
  v_competition_state text;
  v_team_id uuid;
  v_requesting_member_id uuid;
  v_current_status text;
  v_request_created_at timestamptz;
  v_organizer_id uuid;
  v_captain_id uuid;
  v_decided_at timestamptz;
  v_membership_id uuid;
  v_has_active_captaincy boolean;
begin
  if p_decision not in ('APPROVE', 'REJECT') then
    raise exception 'INVALID_DECISION: decision must be APPROVE or REJECT' using errcode = 'P0001';
  end if;

  select competition_join_requests.competition_id into v_lookup_competition_id
    from competition_join_requests
   where competition_join_requests.competition_join_request_id = p_competition_join_request_id;

  if v_lookup_competition_id is null then
    -- UG-CR-GATE-092: a request that does not exist has no organizer or captain, so nobody is authorized for it. It is refused with the
    -- SAME bounded denial an unauthorized caller gets for a request that does exist, never with a "not found" that would tell a caller
    -- holding an id whether it exists.
    if p_is_organizer_override then
      raise exception 'COMPETITION_ACCESS_DENIED: only the organizer may override a join-request decision' using errcode = 'P0001';
    end if;
    raise exception 'NOT_TEAM_CAPTAIN: only this team''s own captain may decide this request' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('competition_scope:' || v_lookup_competition_id::text));

  select competition_join_requests.competition_id, competition_join_requests.competition_team_id,
         competition_join_requests.requesting_gaming_member_id, competition_join_requests.status, competition_join_requests.created_at
    into v_competition_id, v_team_id, v_requesting_member_id, v_current_status, v_request_created_at
    from competition_join_requests
   where competition_join_requests.competition_join_request_id = p_competition_join_request_id
   for update;

  if v_competition_id is null then
    -- UG-CR-GATE-092: a request that does not exist has no organizer or captain, so nobody is authorized for it. It is refused with the
    -- SAME bounded denial an unauthorized caller gets for a request that does exist, never with a "not found" that would tell a caller
    -- holding an id whether it exists.
    if p_is_organizer_override then
      raise exception 'COMPETITION_ACCESS_DENIED: only the organizer may override a join-request decision' using errcode = 'P0001';
    end if;
    raise exception 'NOT_TEAM_CAPTAIN: only this team''s own captain may decide this request' using errcode = 'P0001';
  end if;

  -- UG-CR-GATE-092: authorization comes BEFORE any lifecycle response. The caller must be the exact organizer of this request's own
  -- competition (override) or the exact captain of its target team (and, for an organizer who is a host, still hold the capability)
  -- before this function says anything about the request: whether it is still pending, already decided, or attached to a cancelled
  -- competition. An unauthorized caller therefore gets the same bounded denial in every one of those states. (UG-CR-GATE-SSS-007: that
  -- includes the registration deadline and the freeze, which are judged only after authorization, below.)
  select competitions.organizer_gaming_member_id, competitions.state
    into v_organizer_id, v_competition_state
    from competitions where competitions.competition_id = v_competition_id;

  select competition_teams.captain_gaming_member_id into v_captain_id
    from competition_teams where competition_teams.competition_team_id = v_team_id;

  if p_is_organizer_override then
    if p_deciding_gaming_member_id is distinct from v_organizer_id then
      raise exception 'COMPETITION_ACCESS_DENIED: only the organizer may override a join-request decision'
        using errcode = 'P0001';
    end if;
    perform assert_competition_not_host_revoked(v_competition_id);
  else
    if p_deciding_gaming_member_id is distinct from v_captain_id then
      raise exception 'NOT_TEAM_CAPTAIN: only this team''s own captain may decide this request'
        using errcode = 'P0001';
    end if;
  end if;

  -- Only an authorized caller reaches the lifecycle checks, in their original order.
  if v_current_status <> 'REQUESTED' then
    raise exception 'JOIN_REQUEST_NOT_PENDING: this join request has already been decided' using errcode = 'P0001';
  end if;

  if v_competition_state = 'CANCELLED_WITHOUT_CHAMPION' then
    raise exception 'COMPETITION_CANCELLED: this competition has been cancelled and no longer accepts this action'
      using errcode = 'P0001';
  end if;

  perform competition_assert_registration_decision_allowed(v_competition_id, p_decision, v_request_created_at);

  v_decided_at := now();

  update competition_join_requests
     set status = case when p_decision = 'APPROVE' then 'APPROVED' else 'REJECTED' end,
         decided_by_gaming_member_id = p_deciding_gaming_member_id,
         decided_at = v_decided_at
   where competition_join_requests.competition_join_request_id = p_competition_join_request_id;

  if p_decision = 'APPROVE' then
    perform pg_advisory_xact_lock(hashtext('competition_team_scope:' || v_competition_id::text));

    select exists(
      select 1 from competition_teams
      where competition_teams.competition_id = v_competition_id
        and competition_teams.captain_gaming_member_id = v_requesting_member_id
        and competition_teams.status <> 'REJECTED'
    ) into v_has_active_captaincy;

    if v_has_active_captaincy then
      raise exception 'ALREADY_CAPTAIN_OR_MEMBER: this member already holds an active team role in this competition'
        using errcode = 'P0001';
    end if;

    begin
      insert into competition_team_memberships (competition_id, competition_team_id, gaming_member_id, approved_by_gaming_member_id)
      values (v_competition_id, v_team_id, v_requesting_member_id, p_deciding_gaming_member_id)
      returning competition_team_memberships.competition_team_membership_id into v_membership_id;
    exception when unique_violation then
      raise exception 'ALREADY_TEAM_MEMBER: this member already holds a team membership in this competition'
        using errcode = 'P0001';
    end;
  end if;

  return query select p_competition_join_request_id,
    (case when p_decision = 'APPROVE' then 'APPROVED' else 'REJECTED' end)::text,
    v_decided_at, v_membership_id;
end;
$function$;

create or replace function organizer_review_join_request_atomically(p_competition_join_request_id uuid, p_organizer_gaming_member_id uuid, p_decision text, p_reason text)
 returns table(competition_join_request_id uuid, status text, organizer_reviewed_at timestamptz, competition_team_membership_id uuid)
 language plpgsql
 security definer
 set search_path = public
as $function$
declare
  v_lookup_competition_id uuid;
  v_competition_id uuid;
  v_competition_state text;
  v_team_id uuid;
  v_requesting_member_id uuid;
  v_current_status text;
  v_already_reviewed timestamptz;
  v_request_created_at timestamptz;
  v_organizer_id uuid;
  v_reviewed_at timestamptz;
  v_membership_id uuid;
  v_has_active_captaincy boolean;
begin
  if p_decision not in ('APPROVE', 'REJECT') then
    raise exception 'INVALID_DECISION: decision must be APPROVE or REJECT' using errcode = 'P0001';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'REASON_REQUIRED: an organizer review requires a reason' using errcode = 'P0001';
  end if;

  select competition_join_requests.competition_id into v_lookup_competition_id
    from competition_join_requests
   where competition_join_requests.competition_join_request_id = p_competition_join_request_id;

  if v_lookup_competition_id is null then
    raise exception 'JOIN_REQUEST_NOT_FOUND: no such join request exists' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('competition_scope:' || v_lookup_competition_id::text));

  select competition_join_requests.competition_id, competition_join_requests.competition_team_id,
         competition_join_requests.requesting_gaming_member_id, competition_join_requests.status,
         competition_join_requests.organizer_reviewed_at, competition_join_requests.created_at
    into v_competition_id, v_team_id, v_requesting_member_id, v_current_status, v_already_reviewed, v_request_created_at
    from competition_join_requests
   where competition_join_requests.competition_join_request_id = p_competition_join_request_id
   for update;

  if v_competition_id is null then
    raise exception 'JOIN_REQUEST_NOT_FOUND: no such join request exists' using errcode = 'P0001';
  end if;

  select competitions.organizer_gaming_member_id, competitions.state
    into v_organizer_id, v_competition_state
    from competitions where competitions.competition_id = v_competition_id;

  if p_organizer_gaming_member_id is distinct from v_organizer_id then
    raise exception 'COMPETITION_ACCESS_DENIED: only the organizer may review a join request'
      using errcode = 'P0001';
  end if;
  perform assert_competition_not_host_revoked(v_competition_id);

  if v_competition_state = 'CANCELLED_WITHOUT_CHAMPION' then
    raise exception 'COMPETITION_CANCELLED: this competition has been cancelled and no longer accepts this action'
      using errcode = 'P0001';
  end if;

  if v_current_status <> 'REJECTED' then
    raise exception 'JOIN_REQUEST_NOT_REJECTED: organizer review only applies to an already-rejected request'
      using errcode = 'P0001';
  end if;

  if v_already_reviewed is not null then
    raise exception 'JOIN_REQUEST_ALREADY_REVIEWED: this request has already received its one organizer review'
      using errcode = 'P0001';
  end if;

  perform competition_assert_registration_decision_allowed(v_competition_id, p_decision, v_request_created_at);

  v_reviewed_at := now();

  update competition_join_requests
     set status = case when p_decision = 'APPROVE' then 'APPROVED' else 'REJECTED' end,
         organizer_reviewed_at = v_reviewed_at,
         organizer_reviewed_by_gaming_member_id = p_organizer_gaming_member_id
   where competition_join_requests.competition_join_request_id = p_competition_join_request_id;

  if p_decision = 'APPROVE' then
    perform pg_advisory_xact_lock(hashtext('competition_team_scope:' || v_competition_id::text));

    select exists(
      select 1 from competition_teams
      where competition_teams.competition_id = v_competition_id
        and competition_teams.captain_gaming_member_id = v_requesting_member_id
        and competition_teams.status <> 'REJECTED'
    ) into v_has_active_captaincy;

    if v_has_active_captaincy then
      raise exception 'ALREADY_CAPTAIN_OR_MEMBER: this member already holds an active team role in this competition'
        using errcode = 'P0001';
    end if;

    begin
      insert into competition_team_memberships (competition_id, competition_team_id, gaming_member_id, approved_by_gaming_member_id)
      values (v_competition_id, v_team_id, v_requesting_member_id, p_organizer_gaming_member_id)
      returning competition_team_memberships.competition_team_membership_id into v_membership_id;
    exception when unique_violation then
      raise exception 'ALREADY_TEAM_MEMBER: this member already holds a team membership in this competition'
        using errcode = 'P0001';
    end;
  end if;

  return query select p_competition_join_request_id,
    (case when p_decision = 'APPROVE' then 'APPROVED' else 'REJECTED' end)::text,
    v_reviewed_at, v_membership_id;
end;
$function$;

-- The freeze. Same signature and result as the close operation it replaces; the evidence and the new prerequisites are new. The order: lock, ownership, host
-- guard, an exact retry of a completed freeze, the OPEN state, and the exactly-four-accepted-teams count (these keep the places and the answers they always had),
-- and only then the new prerequisites: the plan, the deadline, nothing pending, every roster within its bounds, every person on one team.
create or replace function close_team_registration_atomically(p_competition_id uuid, p_organizer_gaming_member_id uuid)
 returns table(competition_id uuid, state text)
 language plpgsql
 security definer
 set search_path = public
as $function$
#variable_conflict use_column
declare
  v_organizer_id uuid;
  v_state text;
  v_activity_key text;
  v_existing_freeze uuid;
  v_plan_revision_id uuid;
  v_plan_format text;
  v_roster_minimum integer;
  v_roster_maximum integer;
  v_deadline timestamptz;
  v_now timestamptz;
  v_accepted_count integer;
  v_pending_proposals integer;
  v_pending_requests integer;
  v_team record;
  v_conflicts integer;
  v_orphans integer;
  v_freeze_id uuid;
  v_teams jsonb;
  v_member_count integer;
  v_digest text;
begin
  perform pg_advisory_xact_lock(hashtext('competition_scope:' || p_competition_id::text));

  select competitions.organizer_gaming_member_id, competitions.state, competitions.activity_key
    into v_organizer_id, v_state, v_activity_key
    from competitions
   where competitions.competition_id = p_competition_id
   for update;

  if v_organizer_id is null then
    raise exception 'COMPETITION_NOT_FOUND: no such competition exists' using errcode = 'P0001';
  end if;

  if p_organizer_gaming_member_id is distinct from v_organizer_id then
    raise exception 'COMPETITION_ACCESS_DENIED: only this competition''s own organizer may close team registration'
      using errcode = 'P0001';
  end if;
  perform assert_competition_not_host_revoked(p_competition_id);

  -- An exact retry of a completed freeze returns the freeze that exists. It is never rebuilt from the data as it is now.
  select f.registration_freeze_id into v_existing_freeze from competition_registration_freezes f where f.competition_id = p_competition_id;
  if v_existing_freeze is not null and v_state in ('READY_TO_PUBLISH', 'PUBLISHED', 'COMPLETE') then
    return query select p_competition_id, v_state;
    return;
  end if;

  if v_state <> 'TEAM_REGISTRATION_OPEN' then
    raise exception 'TEAM_REGISTRATION_NOT_OPEN: team registration is not currently open'
      using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('competition_team_scope:' || p_competition_id::text));

  select count(*) into v_accepted_count
    from competition_teams
   where competition_teams.competition_id = p_competition_id
     and competition_teams.status = 'ACCEPTED';

  if v_accepted_count <> 4 then
    raise exception 'TEAM_REGISTRATION_CAPACITY_NOT_REACHED: exactly four accepted teams are required to close team registration (found %)', v_accepted_count
      using errcode = 'P0001';
  end if;

  select p.planning_revision_id, p.format_key, p.roster_minimum, p.roster_maximum, p.registration_deadline_utc
    into v_plan_revision_id, v_plan_format, v_roster_minimum, v_roster_maximum, v_deadline
    from competition_current_registration_plan(p_competition_id) p;

  if v_plan_revision_id is null then
    raise exception 'REGISTRATION_FREEZE_PLAN_MISSING: this competition has no registration plan' using errcode = 'P0001';
  end if;
  if not competition_registration_plan_usable(v_activity_key, v_plan_format, v_roster_minimum, v_roster_maximum, v_deadline) then
    raise exception 'REGISTRATION_FREEZE_PLAN_INVALID: the registration plan does not match this competition' using errcode = 'P0001';
  end if;

  v_now := competition_registration_clock();
  if not competition_registration_deadline_reached(v_deadline, v_now) then
    raise exception 'REGISTRATION_FREEZE_DEADLINE_NOT_REACHED: the registration deadline has not been reached' using errcode = 'P0001';
  end if;

  select count(*) into v_pending_proposals
    from competition_teams
   where competition_teams.competition_id = p_competition_id
     and competition_teams.status = 'PENDING_ORGANIZER_APPROVAL';
  if v_pending_proposals > 0 then
    raise exception 'REGISTRATION_FREEZE_PENDING_PROPOSALS: % team proposal(s) are still pending', v_pending_proposals using errcode = 'P0001';
  end if;

  select count(*) into v_pending_requests
    from competition_join_requests
   where competition_join_requests.competition_id = p_competition_id
     and competition_join_requests.status = 'REQUESTED';
  if v_pending_requests > 0 then
    raise exception 'REGISTRATION_FREEZE_PENDING_JOIN_REQUESTS: % join request(s) are still pending', v_pending_requests using errcode = 'P0001';
  end if;

  for v_team in
    select teams.competition_team_id as team_id,
           (select count(*) from competition_team_memberships m where m.competition_team_id = teams.competition_team_id)::integer as member_total
      from competition_teams teams
     where teams.competition_id = p_competition_id and teams.status = 'ACCEPTED'
     order by teams.competition_team_id::text collate "C"
  loop
    if v_team.member_total < v_roster_minimum then
      raise exception 'REGISTRATION_FREEZE_ROSTER_BELOW_MINIMUM: a team has % member(s); the minimum is %', v_team.member_total, v_roster_minimum using errcode = 'P0001';
    end if;
  end loop;
  for v_team in
    select teams.competition_team_id as team_id,
           (select count(*) from competition_team_memberships m where m.competition_team_id = teams.competition_team_id)::integer as member_total
      from competition_teams teams
     where teams.competition_id = p_competition_id and teams.status = 'ACCEPTED'
     order by teams.competition_team_id::text collate "C"
  loop
    if v_team.member_total > v_roster_maximum then
      raise exception 'REGISTRATION_FREEZE_ROSTER_ABOVE_MAXIMUM: a team has % member(s); the maximum is %', v_team.member_total, v_roster_maximum using errcode = 'P0001';
    end if;
  end loop;

  -- Every person belongs to exactly one team: nobody is a member (or captain) of two teams, and no membership points at a team that is not accepted.
  select count(*) into v_conflicts
    from (
      select people.person
        from (
          select m.gaming_member_id as person, m.competition_team_id as team
            from competition_team_memberships m where m.competition_id = p_competition_id
          union
          select teams.captain_gaming_member_id, teams.competition_team_id
            from competition_teams teams where teams.competition_id = p_competition_id and teams.status = 'ACCEPTED'
        ) people
       group by people.person
      having count(distinct people.team) > 1
    ) shared;
  select count(*) into v_orphans
    from competition_team_memberships m
    join competition_teams teams on teams.competition_team_id = m.competition_team_id
   where m.competition_id = p_competition_id and teams.status <> 'ACCEPTED';
  if v_conflicts > 0 or v_orphans > 0 then
    raise exception 'REGISTRATION_FREEZE_MEMBER_CONFLICT: every person must belong to exactly one accepted team' using errcode = 'P0001';
  end if;

  -- The evidence: the four teams, their captains and every membership, with a digest of exactly that data.
  v_freeze_id := gen_random_uuid();
  select jsonb_agg(jsonb_build_object(
           'team', teams.competition_team_id, 'captain', teams.captain_gaming_member_id,
           'members', coalesce((select jsonb_agg(m.gaming_member_id order by m.gaming_member_id::text collate "C")
                                  from competition_team_memberships m where m.competition_team_id = teams.competition_team_id), '[]'::jsonb))
           order by teams.competition_team_id::text collate "C")
    into v_teams
    from competition_teams teams
   where teams.competition_id = p_competition_id and teams.status = 'ACCEPTED';
  select count(*) into v_member_count from competition_team_memberships m where m.competition_id = p_competition_id;
  v_digest := competition_registration_freeze_digest(p_competition_id, v_plan_revision_id, v_plan_format, v_roster_minimum, v_roster_maximum, v_deadline, v_teams);

  insert into competition_registration_freeze_teams (registration_freeze_id, competition_id, position, competition_team_id, captain_gaming_member_id, member_count)
  select v_freeze_id, p_competition_id, (row_number() over (order by teams.competition_team_id::text collate "C"))::smallint,
         teams.competition_team_id, teams.captain_gaming_member_id,
         (select count(*) from competition_team_memberships m where m.competition_team_id = teams.competition_team_id)::smallint
    from competition_teams teams
   where teams.competition_id = p_competition_id and teams.status = 'ACCEPTED';

  insert into competition_registration_freeze_members (registration_freeze_id, competition_id, competition_team_id, gaming_member_id, competition_team_membership_id)
  select v_freeze_id, p_competition_id, m.competition_team_id, m.gaming_member_id, m.competition_team_membership_id
    from competition_team_memberships m
   where m.competition_id = p_competition_id;

  insert into competition_registration_freezes (
    registration_freeze_id, competition_id, planning_revision_id, format_key, roster_minimum, roster_maximum, registration_deadline_utc,
    frozen_at, frozen_by_gaming_member_id, team_count, member_count, snapshot_digest)
  values (
    v_freeze_id, p_competition_id, v_plan_revision_id, v_plan_format, v_roster_minimum, v_roster_maximum, v_deadline,
    v_now, p_organizer_gaming_member_id, 4, v_member_count, v_digest);

  update competitions set state = 'READY_TO_PUBLISH' where competitions.competition_id = p_competition_id;

  return query select p_competition_id, 'READY_TO_PUBLISH'::text;
end;
$function$;
