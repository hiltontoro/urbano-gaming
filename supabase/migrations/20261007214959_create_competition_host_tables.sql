-- Become a Host (UG-CR-GATE-088) — application and tournament-scoped capability tables.
--
-- WHY A NEW CAPABILITY AND NOT THE OPERATIONAL AUTHORITY CLASS
-- authority_grants.OPERATIONAL is a standing, platform-wide class: whoever holds
-- it may create any number of competitions and use other OPERATIONAL-gated
-- surfaces (it is the same class Predictions and Matches administration use).
-- An external venue owner must never receive that. A host instead receives one
-- row in competition_host_capabilities, bound to ONE application and, once used,
-- to exactly ONE competition. It is checked only on the competitions the host
-- owns and is revocable without touching any platform authority.
--
-- ACCESS MODEL
-- Both tables are reached only by the trusted server through the service role,
-- exactly like every other Gaming table; the browser never holds a data client.
-- RLS is therefore enabled with NO policies (deny by default for anon and
-- authenticated), table privileges are revoked from anon/authenticated, and
-- service_role is deliberately granted only SELECT/INSERT/UPDATE: it has no
-- DELETE, TRUNCATE, REFERENCES or TRIGGER privilege, so history cannot be erased
-- through the API even by a compromised server credential. Triggers below
-- additionally enforce the state machine and refuse DELETE/TRUNCATE for the
-- table owner as well.
--
-- No ownership policy is created on purpose: no client path reads these tables
-- directly, and adding one would create a second, unneeded way in. Every read
-- is a SELECT function that takes the verified actor as an explicit argument.

create table competition_host_applications (
  host_application_id uuid primary key default gen_random_uuid(),
  public_code text not null default rtrim(translate(encode(uuid_send(gen_random_uuid()), 'base64'), '+/', '-_'), '='),
  gaming_member_id uuid not null references gaming_members (gaming_member_id),
  state text not null default 'PENDING' check (state in ('PENDING', 'APPROVED', 'REJECTED', 'WITHDRAWN')),
  venue_name text not null check (length(btrim(venue_name)) between 2 and 80),
  city_area text not null check (length(btrim(city_area)) between 2 and 80),
  playing_fields integer not null check (playing_fields between 1 and 50),
  venue_description text not null check (length(btrim(venue_description)) between 20 and 800),
  expected_window text not null check (length(btrim(expected_window)) between 3 and 100),
  expected_team_count integer not null check (expected_team_count between 4 and 16),
  confirm_all_adults boolean not null check (confirm_all_adults),
  confirm_independent_scorekeepers boolean not null check (confirm_independent_scorekeepers),
  confirm_pilot_exclusions boolean not null check (confirm_pilot_exclusions),
  submitted_at timestamptz not null default now(),
  decided_by_gaming_member_id uuid null references gaming_members (gaming_member_id),
  decided_at timestamptz null,
  decision_reason text null,
  withdrawn_at timestamptz null,
  constraint competition_host_applications_public_code_unique unique (public_code),
  constraint competition_host_applications_decision_shape check (
    (state = 'PENDING' and decided_at is null and decided_by_gaming_member_id is null and decision_reason is null and withdrawn_at is null)
    or (state = 'APPROVED' and decided_at is not null and decided_by_gaming_member_id is not null and withdrawn_at is null)
    or (state = 'REJECTED' and decided_at is not null and decided_by_gaming_member_id is not null and withdrawn_at is null
        and decision_reason is not null and length(btrim(decision_reason)) > 0)
    or (state = 'WITHDRAWN' and withdrawn_at is not null and decided_at is null and decided_by_gaming_member_id is null and decision_reason is null)
  )
);

-- One live application per member: a member may hold at most one PENDING or
-- APPROVED application at a time. REJECTED and WITHDRAWN rows stay as history
-- and do not block a later application.
create unique index competition_host_applications_one_live_per_member
  on competition_host_applications (gaming_member_id)
  where state in ('PENDING', 'APPROVED');

create index competition_host_applications_member_idx on competition_host_applications (gaming_member_id, submitted_at desc);
create index competition_host_applications_decided_by_idx on competition_host_applications (decided_by_gaming_member_id);
create index competition_host_applications_state_idx on competition_host_applications (state, submitted_at);

create table competition_host_capabilities (
  host_capability_id uuid primary key default gen_random_uuid(),
  host_application_id uuid not null references competition_host_applications (host_application_id),
  gaming_member_id uuid not null references gaming_members (gaming_member_id),
  state text not null default 'AVAILABLE' check (state in ('AVAILABLE', 'CONSUMED', 'REVOKED')),
  competition_id uuid null references competitions (competition_id),
  granted_at timestamptz not null default now(),
  granted_by_gaming_member_id uuid not null references gaming_members (gaming_member_id),
  consumed_at timestamptz null,
  revoked_at timestamptz null,
  revoked_by_gaming_member_id uuid null references gaming_members (gaming_member_id),
  revoke_reason text null,
  -- One capability per approved application, and one capability per competition.
  constraint competition_host_capabilities_application_unique unique (host_application_id),
  constraint competition_host_capabilities_competition_unique unique (competition_id),
  constraint competition_host_capabilities_consumption_pair check ((competition_id is null) = (consumed_at is null)),
  constraint competition_host_capabilities_state_shape check (
    (state = 'AVAILABLE' and competition_id is null and revoked_at is null and revoked_by_gaming_member_id is null and revoke_reason is null)
    or (state = 'CONSUMED' and competition_id is not null and revoked_at is null and revoked_by_gaming_member_id is null and revoke_reason is null)
    or (state = 'REVOKED' and revoked_at is not null and revoked_by_gaming_member_id is not null
        and revoke_reason is not null and length(btrim(revoke_reason)) > 0)
  )
);

-- At most one live (not revoked) capability per member.
create unique index competition_host_capabilities_one_live_per_member
  on competition_host_capabilities (gaming_member_id)
  where state in ('AVAILABLE', 'CONSUMED');

create index competition_host_capabilities_member_idx on competition_host_capabilities (gaming_member_id);
create index competition_host_capabilities_granted_by_idx on competition_host_capabilities (granted_by_gaming_member_id);
create index competition_host_capabilities_revoked_by_idx on competition_host_capabilities (revoked_by_gaming_member_id);

-- Deny by default. No policies exist, deliberately (see header).
alter table competition_host_applications enable row level security;
alter table competition_host_capabilities enable row level security;

revoke all on table competition_host_applications from public, anon, authenticated, service_role;
revoke all on table competition_host_capabilities from public, anon, authenticated, service_role;
grant select, insert, update on table competition_host_applications to service_role;
grant select, insert, update on table competition_host_capabilities to service_role;

-- ---------------------------------------------------------------------------
-- History is preserved: neither table can lose a row, and neither can leave a
-- terminal state, whichever role issues the statement.
-- ---------------------------------------------------------------------------

create function competition_host_reject_history_loss()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'HOST_HISTORY_IMMUTABLE: host applications and capabilities are preserved and cannot be deleted or truncated'
    using errcode = 'P0001';
end;
$$;

create function competition_host_guard_application_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.host_application_id is distinct from new.host_application_id
     or old.public_code is distinct from new.public_code
     or old.gaming_member_id is distinct from new.gaming_member_id
     or old.venue_name is distinct from new.venue_name
     or old.city_area is distinct from new.city_area
     or old.playing_fields is distinct from new.playing_fields
     or old.venue_description is distinct from new.venue_description
     or old.expected_window is distinct from new.expected_window
     or old.expected_team_count is distinct from new.expected_team_count
     or old.confirm_all_adults is distinct from new.confirm_all_adults
     or old.confirm_independent_scorekeepers is distinct from new.confirm_independent_scorekeepers
     or old.confirm_pilot_exclusions is distinct from new.confirm_pilot_exclusions
     or old.submitted_at is distinct from new.submitted_at then
    raise exception 'HOST_HISTORY_IMMUTABLE: a submitted host application cannot be edited' using errcode = 'P0001';
  end if;

  -- The only legal move is PENDING -> APPROVED | REJECTED | WITHDRAWN.
  if old.state <> 'PENDING' or new.state = 'PENDING' then
    raise exception 'HOST_HISTORY_IMMUTABLE: a decided or withdrawn host application cannot change' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create function competition_host_guard_capability_update()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if old.host_capability_id is distinct from new.host_capability_id
     or old.host_application_id is distinct from new.host_application_id
     or old.gaming_member_id is distinct from new.gaming_member_id
     or old.granted_at is distinct from new.granted_at
     or old.granted_by_gaming_member_id is distinct from new.granted_by_gaming_member_id then
    raise exception 'HOST_HISTORY_IMMUTABLE: a host capability cannot be re-assigned' using errcode = 'P0001';
  end if;

  if old.state = 'REVOKED' then
    raise exception 'HOST_HISTORY_IMMUTABLE: a revoked host capability cannot change' using errcode = 'P0001';
  end if;

  if old.state = 'AVAILABLE' and new.state not in ('CONSUMED', 'REVOKED') then
    raise exception 'HOST_HISTORY_IMMUTABLE: invalid host capability transition' using errcode = 'P0001';
  end if;

  if old.state = 'CONSUMED' then
    -- Once bound to a competition the binding is permanent; only revocation may follow.
    if new.state <> 'REVOKED'
       or old.competition_id is distinct from new.competition_id
       or old.consumed_at is distinct from new.consumed_at then
      raise exception 'HOST_HISTORY_IMMUTABLE: a consumed host capability stays bound to its competition' using errcode = 'P0001';
    end if;
  end if;

  if old.state = 'AVAILABLE' and new.state = 'REVOKED'
     and (new.competition_id is not null or new.consumed_at is not null) then
    raise exception 'HOST_HISTORY_IMMUTABLE: an unused host capability cannot gain a competition while being revoked' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger competition_host_applications_no_delete
  before delete on competition_host_applications
  for each row execute function competition_host_reject_history_loss();
create trigger competition_host_applications_no_truncate
  before truncate on competition_host_applications
  for each statement execute function competition_host_reject_history_loss();
create trigger competition_host_applications_guard_update
  before update on competition_host_applications
  for each row execute function competition_host_guard_application_update();

create trigger competition_host_capabilities_no_delete
  before delete on competition_host_capabilities
  for each row execute function competition_host_reject_history_loss();
create trigger competition_host_capabilities_no_truncate
  before truncate on competition_host_capabilities
  for each statement execute function competition_host_reject_history_loss();
create trigger competition_host_capabilities_guard_update
  before update on competition_host_capabilities
  for each row execute function competition_host_guard_capability_update();

-- ---------------------------------------------------------------------------
-- Immutable audit events for the host workflow.
-- admin_audit_events has always been append-only only by application
-- discipline (see 0115). Existing contract suites delete their own audit rows
-- during cleanup, so a blanket guard would break them; the guard therefore
-- covers exactly the HOST_* action types introduced here, plus TRUNCATE of the
-- table, which no code path uses. Every other row keeps its current behavior.
-- ---------------------------------------------------------------------------

create function admin_audit_events_reject_host_event_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'AUDIT_EVENT_IMMUTABLE: host workflow audit events cannot be changed, deleted, or truncated'
    using errcode = 'P0001';
end;
$$;

create trigger admin_audit_events_host_events_immutable
  before update or delete on admin_audit_events
  for each row
  when (left(old.action_type, 5) = 'HOST_')
  execute function admin_audit_events_reject_host_event_change();

create trigger admin_audit_events_no_truncate
  before truncate on admin_audit_events
  for each statement
  execute function admin_audit_events_reject_host_event_change();

revoke all on function competition_host_reject_history_loss() from public, anon, authenticated;
revoke all on function competition_host_guard_application_update() from public, anon, authenticated;
revoke all on function competition_host_guard_capability_update() from public, anon, authenticated;
revoke all on function admin_audit_events_reject_host_event_change() from public, anon, authenticated;
