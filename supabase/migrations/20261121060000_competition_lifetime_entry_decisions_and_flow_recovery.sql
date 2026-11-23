-- UG-CR-GATE-CFM-004 — Organizer entry decisions and safe flow recovery (continues 20261120053000_competition_lifetime_teams_and_entry_foundation.sql).
--
-- WHAT THIS DOES. A lifetime entry could be created and withdrawn but never ACCEPTED, so the CFM-001 freeze counted every entry that had not been withdrawn, decided or not.
-- This file lets the competition's ORGANIZER approve, reject and (before the freeze) remove an entry, makes the lifetime freeze count only what was accepted, and lets the
-- organizer undo an ACCIDENTAL enablement of the lifetime flow — all server-side, all audited, all additive. It edits no earlier migration and recreates no V1 function.
--
--   1. AUDIT. competition_lifetime_entry_decisions: one append-only row for every decision about an entry (APPROVED, REJECTED, REMOVED by the organizer; WITHDRAWN by the
--      team's own leader), with who, in which role, why (a bounded reason code and an optional note), from which status to which, how many claims it released, and when.
--      competition_lifetime_flow_events: one append-only row for every ENABLED and DISABLED of a competition's lifetime flow. The enablement already on record is copied
--      into it by this file, before anything can ever be removed. Both tables are history (never updated, deleted or truncated) and are server-only like the rest.
--   2. ENTRY TRANSITIONS (competition_teams.status, for entry_flow = 'LIFETIME'; the table guard allows exactly these, and only inside the named operation):
--        PENDING_ORGANIZER_APPROVAL -> ACCEPTED   organizer APPROVE   (registration open, deadline not passed, team active, the captain it names still leads it)
--        PENDING_ORGANIZER_APPROVAL -> REJECTED   organizer REJECT    (any time before the freeze, even after the deadline: it is how leftover entries are cleared)
--        ACCEPTED                   -> REJECTED   organizer REMOVE    (before the freeze, while registration is open)
--        PENDING | ACCEPTED         -> REJECTED   the team's own leader withdraws (unchanged; it can now also withdraw an ACCEPTED entry before the freeze)
--      The entry's status stays REJECTED in all three endings; what distinguishes them is rejection_reason (ENTRY_REJECTED_BY_ORGANIZER, ENTRY_REMOVED_BY_ORGANIZER,
--      ENTRY_WITHDRAWN_BY_TEAM), the decision record (decision, role, reason), the team audit event (ENTRY_REJECTED, ENTRY_REMOVED, ENTRY_WITHDRAWN) and the reason on every
--      released claim. V1's three-valued status check is not widened.
--   3. WHO. Only the competition's own organizer, active and not revoked: the competition scope lock, then the ownership check (COMPETITION_ACCESS_DENIED), then the
--      host-revocation guard, then anything else — the order every organizer operation of this repository has. A captain, sub-captain, team member, applicant, scorekeeper,
--      unrelated organizer or a caller with no identity is refused before anything about the entry is said. An approval never accepts a roster claim, never waives the adult
--      attestation, the team membership, one-team-per-person or the roster bounds, and never creates or changes an identity: it changes one entry row and writes audit.
--   4. THE FREEZE counts only ACCEPTED entries and the ACCEPTED places of those entries. It refuses (LIFETIME_FREEZE_PENDING_ENTRIES) while any lifetime entry is still
--      pending, needs at least two accepted entries, validates the roster bounds for accepted entries only, ignores rejected and withdrawn entries, keeps the plan
--      revision and the deadline it froze under, and stays idempotent.
--   5. SAFE RECOVERY (disable_lifetime_entry_flow_atomically). The organizer can switch an accidentally enabled lifetime flow off ONLY IF the flow produced nothing: no lifetime
--      entry (of any status) has ever existed, no roster claim, no freeze, no entry decision; the competition is still DRAFT or TEAM_REGISTRATION_OPEN; and no V1 team,
--      membership, join request, registration freeze, draw, fixture, schedule proposal or plan-change row exists for it (nothing V1 happened while the flow was on, and none
--      could be created by it). Otherwise it fails closed and deletes nothing. The switch row is the one row that goes — and only inside this operation: its ENABLED event is
--      already in competition_lifetime_flow_events, the DISABLED event is written with it. After it V1 behaves as it did before the flow was enabled, and the flow can be
--      enabled again (a new ENABLED event).
--   6. V1 SEPARATION. Once an entry can be ACCEPTED, V1's join request would pass its own "is the team accepted" check against it. Two BEFORE INSERT guards (join requests and
--      V1 memberships) refuse any row naming a LIFETIME entry with the same bounded refusal V1 gave before (TEAM_NOT_ACCEPTED). V1 teams are untouched.
--
-- KNOWN LIMITS (carried, not hidden):
--   * the V1 read paths still list an accepted lifetime entry like any accepted team (no route consumes this foundation yet); nothing here lets the four-team draw, schedule or
--     publication consume a lifetime entry (the V1 freeze and fixture guards still refuse them), and the V1 close of a competition holding accepted lifetime entries is refused
--     by V1's own roster check first (a lifetime entry has no V1 membership, and the guards below keep it from ever getting one) with the V1 freeze-insert guard behind it;
--   * the transaction marks (urbano.lifetime_entry_transition, urbano.lifetime_flow_transition) keep every application path, and every role without write privilege on these
--     tables, out of the transitions they guard; they are not a defence against the database owner, who can set a setting and write any table;
--   * LOCK ORDER of the decision is team row, then competition (see 5/6): the race tests of this gate found a deadlock in the first draft, which took the team row after the
--     competition lock through a foreign key; a future operation that writes a team event while holding the competition lock must take the team row first too;
--   * apply this file in a quiet window: it alters two tables CFM-001 created (a CHECK each, re-validated against existing rows) and replaces four functions CFM-001 created.

-- 1/6  Audit structures.
create table competition_lifetime_entry_decisions (
  decision_id uuid primary key default gen_random_uuid(),
  decision_seq bigint generated always as identity,
  competition_id uuid not null references competitions (competition_id),
  competition_team_id uuid not null,
  lifetime_team_id uuid not null,
  decision text not null,
  decided_by_role text not null,
  decided_by_gaming_member_id uuid not null references gaming_members (gaming_member_id),
  reason_code text null,
  note text null,
  previous_status text not null,
  new_status text not null,
  released_claims integer not null default 0,
  decided_at timestamptz not null,
  constraint competition_lifetime_entry_decisions_entry_fkey foreign key (competition_team_id, competition_id, lifetime_team_id)
    references competition_teams (competition_team_id, competition_id, lifetime_team_id),
  constraint competition_lifetime_entry_decisions_decision_check check (decision in ('APPROVED', 'REJECTED', 'REMOVED', 'WITHDRAWN')),
  constraint competition_lifetime_entry_decisions_role_check check (decided_by_role in ('ORGANIZER', 'TEAM_LEADER')),
  constraint competition_lifetime_entry_decisions_reason_check check (reason_code is null or reason_code in (
    'INELIGIBLE_TEAM', 'INCOMPLETE_ENTRY', 'DUPLICATE_OR_MISTAKEN_ENTRY', 'COMPETITION_CAPACITY', 'RULE_VIOLATION', 'OTHER_ORGANIZER_DECISION')),
  constraint competition_lifetime_entry_decisions_note_check check (note is null or (note = btrim(note) and char_length(note) between 1 and 280)),
  constraint competition_lifetime_entry_decisions_claims_check check (released_claims >= 0),
  constraint competition_lifetime_entry_decisions_shape check (
    (decision = 'APPROVED' and decided_by_role = 'ORGANIZER' and reason_code is null and note is null and previous_status = 'PENDING_ORGANIZER_APPROVAL' and new_status = 'ACCEPTED' and released_claims = 0)
    or (decision = 'REJECTED' and decided_by_role = 'ORGANIZER' and reason_code is not null and previous_status = 'PENDING_ORGANIZER_APPROVAL' and new_status = 'REJECTED')
    or (decision = 'REMOVED' and decided_by_role = 'ORGANIZER' and reason_code is not null and previous_status = 'ACCEPTED' and new_status = 'REJECTED')
    or (decision = 'WITHDRAWN' and decided_by_role = 'TEAM_LEADER' and reason_code is null and note is null and previous_status in ('PENDING_ORGANIZER_APPROVAL', 'ACCEPTED') and new_status = 'REJECTED'))
);
create index competition_lifetime_entry_decisions_competition_idx on competition_lifetime_entry_decisions (competition_id, decision_seq);
create index competition_lifetime_entry_decisions_entry_idx on competition_lifetime_entry_decisions (competition_team_id, decision_seq);

create table competition_lifetime_flow_events (
  flow_event_id uuid primary key default gen_random_uuid(),
  flow_event_seq bigint generated always as identity,
  competition_id uuid not null references competitions (competition_id),
  event_type text not null,
  actor_gaming_member_id uuid not null references gaming_members (gaming_member_id),
  occurred_at timestamptz not null,
  details jsonb not null default '{}'::jsonb,
  constraint competition_lifetime_flow_events_type_check check (event_type in ('ENABLED', 'DISABLED'))
);
create index competition_lifetime_flow_events_competition_idx on competition_lifetime_flow_events (competition_id, flow_event_seq);

-- The enablement already on record is preserved as an event BEFORE any switch row can ever be removed (the one row recovery removes).
insert into competition_lifetime_flow_events (competition_id, event_type, actor_gaming_member_id, occurred_at, details)
select f.competition_id, 'ENABLED', f.enabled_by_gaming_member_id, f.enabled_at, jsonb_build_object('origin', 'FLOW_RECORD_BACKFILL')
  from competition_lifetime_flows f order by f.enabled_at, f.competition_id;

alter table competition_lifetime_entry_decisions enable row level security;
alter table competition_lifetime_flow_events enable row level security;
revoke all on table competition_lifetime_entry_decisions from public, anon, authenticated, service_role;
revoke all on table competition_lifetime_flow_events from public, anon, authenticated, service_role;
revoke all on sequence competition_lifetime_entry_decisions_decision_seq_seq, competition_lifetime_flow_events_flow_event_seq_seq from public, anon, authenticated, service_role;
grant select on table competition_lifetime_entry_decisions to service_role;
grant select on table competition_lifetime_flow_events to service_role;
create trigger competition_lifetime_entry_decisions_history_rows before update or delete on competition_lifetime_entry_decisions for each row execute function lifetime_history_guard();
create trigger competition_lifetime_entry_decisions_history_truncate before truncate on competition_lifetime_entry_decisions for each statement execute function lifetime_history_guard();
create trigger competition_lifetime_flow_events_history_rows before update or delete on competition_lifetime_flow_events for each row execute function lifetime_history_guard();
create trigger competition_lifetime_flow_events_history_truncate before truncate on competition_lifetime_flow_events for each statement execute function lifetime_history_guard();

-- The team audit gains the three organizer outcomes of an entry, and a claim can be released for them.
alter table lifetime_team_events drop constraint lifetime_team_events_type_check;
alter table lifetime_team_events add constraint lifetime_team_events_type_check check (event_type in (
  'TEAM_CREATED', 'TEAM_DISBANDED', 'MEMBERSHIP_OFFERED', 'MEMBERSHIP_ACTIVATED', 'MEMBERSHIP_DECLINED', 'MEMBERSHIP_WITHDRAWN', 'MEMBERSHIP_ENDED',
  'LEADERSHIP_OFFERED', 'LEADERSHIP_ACTIVATED', 'LEADERSHIP_DECLINED', 'LEADERSHIP_WITHDRAWN', 'LEADERSHIP_ENDED', 'CAPTAINCY_SUCCEEDED', 'ENTRY_SUBMITTED', 'ENTRY_WITHDRAWN',
  'ENTRY_APPROVED', 'ENTRY_REJECTED', 'ENTRY_REMOVED'));
alter table competition_lifetime_roster_claims drop constraint competition_lifetime_roster_claims_release_reason_check;
alter table competition_lifetime_roster_claims add constraint competition_lifetime_roster_claims_release_reason_check check (release_reason is null or release_reason in (
  'PERSON_REJECTED', 'PERSON_WITHDREW', 'LEADER_REMOVED', 'LEADER_WITHDREW_PROPOSAL', 'EXPIRED', 'LEFT_TEAM', 'REMOVED_FROM_TEAM', 'TEAM_DISBANDED', 'ENTRY_WITHDRAWN',
  'ENTRY_REJECTED_BY_ORGANIZER', 'ENTRY_REMOVED_BY_ORGANIZER'));

-- 2/6  Guards. The switch row can be removed by exactly one operation; an entry's status moves only along the transitions above; V1 cannot attach to a lifetime entry.
create function competition_lifetime_flows_row_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
begin
  if tg_op = 'DELETE' and coalesce(current_setting('urbano.lifetime_flow_transition', true), '') = 'disable' then
    return old;
  end if;
  raise exception 'LIFETIME_INVARIANT_VIOLATION: this record is history and cannot be changed or removed' using errcode = 'P0001';
  return null;
end;
$function$;
revoke all on function competition_lifetime_flows_row_guard() from public, anon, authenticated;
revoke all on function competition_lifetime_flows_row_guard() from service_role;
drop trigger competition_lifetime_flows_history_rows on competition_lifetime_flows;
create trigger competition_lifetime_flows_row_guard before update or delete on competition_lifetime_flows for each row execute function competition_lifetime_flows_row_guard();

create or replace function competition_teams_lifetime_entry_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
declare
  v_flow boolean;
  v_mark text;
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
        -- The only transitions, each inside its own operation (the transaction mark): the organizer's approve, reject and remove, and the team's withdrawal ('on').
        v_mark := coalesce(current_setting('urbano.lifetime_entry_transition', true), '');
        if not ((old.status = 'PENDING_ORGANIZER_APPROVAL' and new.status = 'ACCEPTED' and v_mark = 'approve')
                or (old.status = 'PENDING_ORGANIZER_APPROVAL' and new.status = 'REJECTED' and v_mark in ('on', 'reject'))
                or (old.status = 'ACCEPTED' and new.status = 'REJECTED' and v_mark in ('on', 'remove'))) then
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

-- A V1 join request or membership can never name a lifetime entry (it would otherwise pass V1's own "is the team accepted" check once an entry can be ACCEPTED).
create function competition_lifetime_entry_v1_path_guard()
 returns trigger
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
begin
  if exists (select 1 from competition_teams t where t.competition_team_id = new.competition_team_id and t.entry_flow = 'LIFETIME') then
    raise exception 'TEAM_NOT_ACCEPTED: this team has not yet been accepted for this competition' using errcode = 'P0001';
  end if;
  return new;
end;
$function$;
revoke all on function competition_lifetime_entry_v1_path_guard() from public, anon, authenticated;
revoke all on function competition_lifetime_entry_v1_path_guard() from service_role;
create trigger competition_join_requests_lifetime_entry_guard before insert on competition_join_requests for each row execute function competition_lifetime_entry_v1_path_guard();
create trigger competition_team_memberships_lifetime_entry_guard before insert on competition_team_memberships for each row execute function competition_lifetime_entry_v1_path_guard();

-- 3/6  Enabling the flow now leaves its event behind (an exact retry still returns the enablement that exists, and writes nothing).
create or replace function enable_lifetime_entry_flow_atomically(p_competition_id uuid, p_organizer_gaming_member_id uuid)
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
  insert into competition_lifetime_flow_events (competition_id, event_type, actor_gaming_member_id, occurred_at, details)
  values (p_competition_id, 'ENABLED', p_organizer_gaming_member_id, v_now, jsonb_build_object('state', v_state));
  return query select p_competition_id, v_now, false;
end;
$function$;
revoke all on function enable_lifetime_entry_flow_atomically(uuid, uuid) from public, anon, authenticated;
grant execute on function enable_lifetime_entry_flow_atomically(uuid, uuid) to service_role;

-- 4/6  The team's own withdrawal is unchanged except that it now also leaves its decision record (role TEAM_LEADER), so a withdrawal is as visible as an organizer's decision.
create or replace function withdraw_lifetime_competition_entry_atomically(p_competition_team_id uuid, p_actor_gaming_member_id uuid)
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
  v_decision uuid;
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
  insert into competition_lifetime_entry_decisions (competition_id, competition_team_id, lifetime_team_id, decision, decided_by_role, decided_by_gaming_member_id, reason_code, note, previous_status, new_status, released_claims, decided_at)
  values (v_competition, p_competition_team_id, v_team, 'WITHDRAWN', 'TEAM_LEADER', p_actor_gaming_member_id, null, null, v_status, 'REJECTED', v_released, v_now)
  returning competition_lifetime_entry_decisions.decision_id into v_decision;
  insert into lifetime_team_events (lifetime_team_id, event_type, actor_gaming_member_id, related_id, occurred_at, details)
  values (v_team, 'ENTRY_WITHDRAWN', p_actor_gaming_member_id, p_competition_team_id, v_now, jsonb_build_object('competition_id', v_competition, 'released_claims', v_released, 'decision_id', v_decision));
  return query select p_competition_team_id, 'REJECTED'::text, v_released;
end;
$function$;
revoke all on function withdraw_lifetime_competition_entry_atomically(uuid, uuid) from public, anon, authenticated;
grant execute on function withdraw_lifetime_competition_entry_atomically(uuid, uuid) to service_role;

-- 5/6  The organizer's decision. One operation, three explicit branches. LOCK ORDER: the team row, then the competition scope lock, then the competition, the entry and its claims —
-- the order of every other lifetime operation (persons, team, competition, entries/claims; the decision takes no person lock). The team row comes first although the decision is
-- a competition-level act, and not for reading: the decision's team event is an INSERT whose foreign key takes a share lock on the team row, and a lock first taken AFTER the
-- competition lock inverted the order and deadlocked (SQLSTATE 40P01) against a team's own withdrawal and against a person's acceptance — the race tests of this gate found it. The
-- team is read without a lock (an entry never changes its team) and locked before anything else; locking it says nothing to anyone, because a caller who is not this competition's
-- organizer is refused right after, before a word about the entry. The competition scope lock still comes before the ownership check, the revocation guard and every write, like every
-- organizer operation of this repository. It writes in this order: claims released, the entry's status, the decision record, the team event. Nothing here ever accepts a claim.
create function decide_lifetime_competition_entry_atomically(
  p_competition_id uuid, p_competition_team_id uuid, p_organizer_gaming_member_id uuid, p_decision text, p_reason_code text default null, p_note text default null)
 returns table(competition_team_id uuid, status text, decision text, decided_at timestamptz, released_claims integer, decision_id uuid)
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
#variable_conflict use_column
declare
  v_organizer_id uuid;
  v_state text;
  v_entry record;
  v_note text := null;
  v_team_status text;
  v_now timestamptz;
  v_released integer := 0;
  v_new_status text;
  v_kind text;
  v_event text;
  v_category text := null;
  v_decision_id uuid;
  v_team_id uuid;
begin
  select e.lifetime_team_id into v_team_id from competition_teams e where e.competition_team_id = p_competition_team_id and e.competition_id = p_competition_id and e.entry_flow = 'LIFETIME';
  if v_team_id is not null then
    perform 1 from lifetime_teams t where t.lifetime_team_id = v_team_id for update;
  end if;
  perform pg_advisory_xact_lock(hashtext('competition_scope:' || p_competition_id::text));
  select c.organizer_gaming_member_id, c.state into v_organizer_id, v_state from competitions c where c.competition_id = p_competition_id for update;
  if v_organizer_id is null then
    raise exception 'COMPETITION_NOT_FOUND: no such competition exists' using errcode = 'P0001';
  end if;
  if p_organizer_gaming_member_id is distinct from v_organizer_id then
    raise exception 'COMPETITION_ACCESS_DENIED: only this competition''s own organizer may decide a lifetime entry' using errcode = 'P0001';
  end if;
  perform assert_competition_not_host_revoked(p_competition_id);
  if p_decision is null or p_decision not in ('APPROVE', 'REJECT', 'REMOVE') then
    raise exception 'LIFETIME_DECISION_INVALID: the decision must be APPROVE, REJECT or REMOVE' using errcode = 'P0001';
  end if;
  if p_decision = 'APPROVE' then
    if p_reason_code is not null then
      raise exception 'LIFETIME_REASON_INVALID: an approval carries no reason' using errcode = 'P0001';
    end if;
    if p_note is not null then
      raise exception 'LIFETIME_NOTE_INVALID: an approval carries no note' using errcode = 'P0001';
    end if;
  else
    if p_reason_code is null or p_reason_code not in ('INELIGIBLE_TEAM', 'INCOMPLETE_ENTRY', 'DUPLICATE_OR_MISTAKEN_ENTRY', 'COMPETITION_CAPACITY', 'RULE_VIOLATION', 'OTHER_ORGANIZER_DECISION') then
      raise exception 'LIFETIME_REASON_INVALID: a rejection or removal needs one of the listed reason codes' using errcode = 'P0001';
    end if;
    if p_note is not null then
      -- Normalized exactly like a team name: trimmed, every run of whitespace one space; then 1 to 280 CHARACTERS and no control character.
      v_note := btrim(regexp_replace(p_note, '\s+', ' ', 'g'));
      if char_length(v_note) < 1 or char_length(v_note) > 280 or v_note ~ '[\x01-\x1f\x7f-\x9f]' then
        raise exception 'LIFETIME_NOTE_INVALID: a note has 1 to 280 characters and no control characters' using errcode = 'P0001';
      end if;
    end if;
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
  select e.lifetime_team_id, e.captain_gaming_member_id, e.name, e.status, e.created_at into v_entry
    from competition_teams e where e.competition_team_id = p_competition_team_id and e.competition_id = p_competition_id and e.entry_flow = 'LIFETIME' for update;
  if not found then
    raise exception 'LIFETIME_ENTRY_NOT_FOUND: no such entry exists in this competition' using errcode = 'P0001';
  end if;
  if p_decision in ('APPROVE', 'REJECT') and v_entry.status <> 'PENDING_ORGANIZER_APPROVAL' then
    raise exception 'LIFETIME_ENTRY_NOT_PENDING: this entry has already been decided or withdrawn' using errcode = 'P0001';
  end if;
  if p_decision = 'REMOVE' and v_entry.status <> 'ACCEPTED' then
    raise exception 'LIFETIME_ENTRY_NOT_ACCEPTED: only an accepted entry can be removed' using errcode = 'P0001';
  end if;
  if v_state <> 'TEAM_REGISTRATION_OPEN' then
    raise exception 'TEAM_REGISTRATION_NOT_OPEN: team registration is not currently open' using errcode = 'P0001';
  end if;
  if p_decision = 'REJECT' then
    -- An entry that was made before the deadline can still be rejected after it: that is how leftover entries are cleared so the freeze can proceed.
    perform competition_assert_registration_decision_allowed(p_competition_id, 'REJECT', v_entry.created_at);
  else
    perform competition_assert_registration_intake_open(p_competition_id);
  end if;
  if p_decision = 'APPROVE' then
    select t.status into v_team_status from lifetime_teams t where t.lifetime_team_id = v_entry.lifetime_team_id;
    if v_team_status is distinct from 'ACTIVE' then
      raise exception 'LIFETIME_TEAM_NOT_ACTIVE: this team has been disbanded' using errcode = 'P0001';
    end if;
    if v_entry.name is null or btrim(v_entry.name) = '' or v_entry.captain_gaming_member_id is null then
      raise exception 'LIFETIME_INVARIANT_VIOLATION: the entry snapshot is not valid' using errcode = 'P0001';
    end if;
    if not exists (select 1 from lifetime_team_leaderships l where l.lifetime_team_id = v_entry.lifetime_team_id and l.role = 'CAPTAIN' and l.status = 'ACTIVE'
                      and l.gaming_member_id = v_entry.captain_gaming_member_id) then
      raise exception 'LIFETIME_ENTRY_CAPTAIN_CHANGED: the captain this entry names no longer leads the team; reject it and let the team enter again' using errcode = 'P0001';
    end if;
    if exists (select 1 from competition_teams x where x.competition_id = p_competition_id and x.lifetime_team_id = v_entry.lifetime_team_id and x.status <> 'REJECTED'
                  and x.competition_team_id is distinct from p_competition_team_id) then
      raise exception 'LIFETIME_ENTRY_ALREADY_EXISTS: this team already has another live entry in this competition' using errcode = 'P0001';
    end if;
  end if;
  v_now := lifetime_clock();
  if p_decision = 'APPROVE' then
    v_new_status := 'ACCEPTED'; v_kind := 'APPROVED'; v_event := 'ENTRY_APPROVED';
  elsif p_decision = 'REJECT' then
    v_new_status := 'REJECTED'; v_kind := 'REJECTED'; v_event := 'ENTRY_REJECTED'; v_category := 'ENTRY_REJECTED_BY_ORGANIZER';
  else
    v_new_status := 'REJECTED'; v_kind := 'REMOVED'; v_event := 'ENTRY_REMOVED'; v_category := 'ENTRY_REMOVED_BY_ORGANIZER';
  end if;
  if p_decision <> 'APPROVE' then
    -- Settled, never deleted: an open proposal is WITHDRAWN, an accepted place REMOVED, each dated, attributed and given the organizer's reason category.
    update competition_lifetime_roster_claims c
       set status = case when c.status = 'PROPOSED' then 'WITHDRAWN' else 'REMOVED' end, released_at = v_now, released_by_gaming_member_id = p_organizer_gaming_member_id, release_reason = v_category
     where c.competition_team_id = p_competition_team_id and c.status in ('PROPOSED', 'ACCEPTED');
    get diagnostics v_released = row_count;
  end if;
  perform set_config('urbano.lifetime_entry_transition', case p_decision when 'APPROVE' then 'approve' when 'REJECT' then 'reject' else 'remove' end, true);
  update competition_teams e set status = v_new_status, decided_at = v_now, decided_by_gaming_member_id = p_organizer_gaming_member_id, rejection_reason = v_category
   where e.competition_team_id = p_competition_team_id;
  perform set_config('urbano.lifetime_entry_transition', 'off', true);
  insert into competition_lifetime_entry_decisions (competition_id, competition_team_id, lifetime_team_id, decision, decided_by_role, decided_by_gaming_member_id, reason_code, note, previous_status, new_status, released_claims, decided_at)
  values (p_competition_id, p_competition_team_id, v_entry.lifetime_team_id, v_kind, 'ORGANIZER', p_organizer_gaming_member_id, p_reason_code, v_note, v_entry.status, v_new_status, v_released, v_now)
  returning competition_lifetime_entry_decisions.decision_id into v_decision_id;
  insert into lifetime_team_events (lifetime_team_id, event_type, actor_gaming_member_id, related_id, occurred_at, details)
  values (v_entry.lifetime_team_id, v_event, p_organizer_gaming_member_id, p_competition_team_id, v_now,
          jsonb_build_object('competition_id', p_competition_id, 'decision_id', v_decision_id, 'reason_code', p_reason_code, 'released_claims', v_released));
  return query select p_competition_team_id, v_new_status, p_decision, v_now, v_released, v_decision_id;
end;
$function$;
revoke all on function decide_lifetime_competition_entry_atomically(uuid, uuid, uuid, text, text, text) from public, anon, authenticated;
grant execute on function decide_lifetime_competition_entry_atomically(uuid, uuid, uuid, text, text, text) to service_role;

-- 6/6  The corrected freeze, and the safe recovery.
-- The organizer's checkpoint. It needs the deadline to have passed, every lifetime entry DECIDED (a pending one refuses), at least two ACCEPTED entries and every accepted
-- roster within the plan's bounds; it records the counts of what was accepted and changes NO competition state. An exact retry returns the freeze that exists.
create or replace function freeze_lifetime_competition_entries_atomically(p_competition_id uuid, p_organizer_gaming_member_id uuid)
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
  -- Every entry must be decided first: the organizer approves or rejects what is still pending (a rejection is allowed after the deadline for exactly this reason).
  if exists (select 1 from competition_teams e where e.competition_id = p_competition_id and e.entry_flow = 'LIFETIME' and e.status = 'PENDING_ORGANIZER_APPROVAL') then
    raise exception 'LIFETIME_FREEZE_PENDING_ENTRIES: decide every pending entry before freezing' using errcode = 'P0001';
  end if;
  select count(*) into v_entries from competition_teams e where e.competition_id = p_competition_id and e.entry_flow = 'LIFETIME' and e.status = 'ACCEPTED';
  if v_entries < 2 then
    raise exception 'LIFETIME_FREEZE_NOT_ENOUGH_ENTRIES: at least two accepted entries are needed (found %)', v_entries using errcode = 'P0001';
  end if;
  for v_entry in
    select e.competition_team_id as entry_id,
           (select count(*) from competition_lifetime_roster_claims c where c.competition_team_id = e.competition_team_id and c.status = 'ACCEPTED')::integer as accepted_total
      from competition_teams e where e.competition_id = p_competition_id and e.entry_flow = 'LIFETIME' and e.status = 'ACCEPTED'
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
  -- Only the accepted places of ACCEPTED entries count (a rejected or withdrawn entry's places were released with it).
  select count(*) into v_claims from competition_lifetime_roster_claims c join competition_teams e on e.competition_team_id = c.competition_team_id
   where c.competition_id = p_competition_id and c.status = 'ACCEPTED' and e.status = 'ACCEPTED';
  insert into competition_lifetime_freezes (competition_id, planning_revision_id, roster_minimum, roster_maximum, registration_deadline_utc, frozen_at, frozen_by_gaming_member_id, entry_count, claim_count)
  values (p_competition_id, v_revision, v_minimum, v_maximum, v_deadline, v_now, p_organizer_gaming_member_id, v_entries, v_claims);
  return query select p_competition_id, v_now, v_entries, v_claims, false;
end;
$function$;
revoke all on function freeze_lifetime_competition_entries_atomically(uuid, uuid) from public, anon, authenticated;
grant execute on function freeze_lifetime_competition_entries_atomically(uuid, uuid) to service_role;

-- Switching an accidentally enabled lifetime flow OFF. Fail-closed: it succeeds only when the flow produced and touched nothing (see the header), and it never deletes
-- anything but the switch row — whose enablement is already an event. An exact retry (nothing enabled) answers already_disabled and writes nothing.
create function disable_lifetime_entry_flow_atomically(p_competition_id uuid, p_organizer_gaming_member_id uuid)
 returns table(competition_id uuid, disabled_at timestamptz, already_disabled boolean)
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
#variable_conflict use_column
declare
  v_organizer_id uuid;
  v_state text;
  v_enabled_at timestamptz;
  v_now timestamptz;
begin
  perform pg_advisory_xact_lock(hashtext('competition_scope:' || p_competition_id::text));
  select c.organizer_gaming_member_id, c.state into v_organizer_id, v_state from competitions c where c.competition_id = p_competition_id for update;
  if v_organizer_id is null then
    raise exception 'COMPETITION_NOT_FOUND: no such competition exists' using errcode = 'P0001';
  end if;
  if p_organizer_gaming_member_id is distinct from v_organizer_id then
    raise exception 'COMPETITION_ACCESS_DENIED: only this competition''s own organizer may disable the lifetime flow' using errcode = 'P0001';
  end if;
  perform assert_competition_not_host_revoked(p_competition_id);
  select f.enabled_at into v_enabled_at from competition_lifetime_flows f where f.competition_id = p_competition_id;
  if v_enabled_at is null then
    return query select p_competition_id, null::timestamptz, true;
    return;
  end if;
  if v_state = 'CANCELLED_WITHOUT_CHAMPION' then
    raise exception 'COMPETITION_CANCELLED: this competition has been cancelled' using errcode = 'P0001';
  end if;
  if v_state not in ('DRAFT', 'TEAM_REGISTRATION_OPEN') then
    raise exception 'LIFETIME_FLOW_RECOVERY_BLOCKED: the lifetime flow can only be switched off before the competition is published' using errcode = 'P0001';
  end if;
  -- Nothing the flow produced: no entry (of any status: a rejected or withdrawn entry still counts), no claim, no freeze, no decision.
  if exists (select 1 from competition_teams e where e.competition_id = p_competition_id and e.entry_flow = 'LIFETIME')
     or exists (select 1 from competition_lifetime_roster_claims c where c.competition_id = p_competition_id)
     or exists (select 1 from competition_lifetime_freezes f where f.competition_id = p_competition_id)
     or exists (select 1 from competition_lifetime_entry_decisions d where d.competition_id = p_competition_id) then
    raise exception 'LIFETIME_FLOW_RECOVERY_BLOCKED: this competition already has lifetime entries, places, decisions or a freeze, and none of them can be deleted' using errcode = 'P0001';
  end if;
  -- Nothing V1 happened while the flow was on (none of it could have been created through V1: the guards refuse it): no V1 team, membership, join request, registration
  -- freeze, draw, fixture, schedule proposal or plan change. If any exists the data was written around the guards, and revoking the switch would expose it. The schedule
  -- PUBLICATION table is deliberately not named here: its own data boundary (SSS-025) lets only its own family of functions mention it, and a publication needs a PUBLISHED
  -- competition (refused above) and a proposal, a draw and a registration freeze (all probed here), so nothing is lost by leaving it out.
  if exists (select 1 from competition_teams t where t.competition_id = p_competition_id)
     or exists (select 1 from competition_team_memberships m where m.competition_id = p_competition_id)
     or exists (select 1 from competition_join_requests j where j.competition_id = p_competition_id)
     or exists (select 1 from competition_registration_freezes f where f.competition_id = p_competition_id)
     or exists (select 1 from competition_draws d where d.competition_id = p_competition_id)
     or exists (select 1 from competition_fixtures x where x.competition_id = p_competition_id)
     or exists (select 1 from competition_schedule_proposals s where s.competition_id = p_competition_id)
     or exists (select 1 from competition_plan_change_proposals p where p.competition_id = p_competition_id)
     or exists (select 1 from competition_member_participation_records r where r.competition_id = p_competition_id) then
    raise exception 'LIFETIME_FLOW_RECOVERY_UNSAFE_LEGACY_STATE: legacy team data exists for this competition, so switching the lifetime flow off could expose it' using errcode = 'P0001';
  end if;
  v_now := lifetime_clock();
  perform set_config('urbano.lifetime_flow_transition', 'disable', true);
  delete from competition_lifetime_flows f where f.competition_id = p_competition_id;
  perform set_config('urbano.lifetime_flow_transition', 'off', true);
  insert into competition_lifetime_flow_events (competition_id, event_type, actor_gaming_member_id, occurred_at, details)
  values (p_competition_id, 'DISABLED', p_organizer_gaming_member_id, v_now, jsonb_build_object('enabled_at', v_enabled_at, 'state', v_state));
  return query select p_competition_id, v_now, false;
end;
$function$;
revoke all on function disable_lifetime_entry_flow_atomically(uuid, uuid) from public, anon, authenticated;
grant execute on function disable_lifetime_entry_flow_atomically(uuid, uuid) to service_role;
