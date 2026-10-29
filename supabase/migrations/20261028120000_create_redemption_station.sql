-- Migration: 20261028120000_create_redemption_station
-- A restricted redemption station for ONE venue activation: a mobile page with a shared PIN that lets the staff of the venue mark a prize
-- of THAT match as delivered, and nothing else.
--
-- What this migration is, and is not:
--   * The station acts under its OWN identity: a gaming member that holds NO platform authority and cannot sign in. It never borrows the
--     authority of a person, and nothing here grants any authority to anyone. The existing redeem_prize_qualification_atomically()
--     (which asks for CONSEQUENTIAL_FINALIZER, a general authority) is left untouched and is not called by the station.
--   * The station redeems through redemption_station_redeem(), a function of its own that applies the SAME rules for a delivery (a
--     delivered prize is returned as it was; a superseded, satisfied or held one is refused; the prize label is snapshotted at the moment;
--     one CONFIRM_PRIZE_REDEMPTION audit event) and writes the SAME facts in prize_qualifications (the single source of truth for what
--     is delivered; the evidence guard of prize_qualifications still applies to it). What it adds is the scope, decided HERE and not by
--     the caller: the session names the station, the station names ONE activation and ONE match, and a prize of any other activation or
--     match is refused whatever the request says.
--   * Everything one delivery needs happens in ONE transaction: the check of the session and of the station, the scope, the delivery, the
--     station log (with the declared name) and the audit event. There is no delivery without its record and no record without its delivery.
--   * The PIN is never stored: only a salted scrypt hash. It is chosen privately by the Founder and set with redemption_station_set_pin(),
--     which also revokes every earlier session and writes an immutable change log (who, when; never the PIN). A session is valid only for
--     the PIN version it was opened under, so a session that races a PIN change is dead on arrival.
--   * The declared name of whoever delivers is kept ONCE, in redemption_station_events, only for a delivery that this station made. The
--     audit event names the station and points at that record; it does not repeat the name. A shared PIN cannot say WHICH person
--     operated: the name is a declaration and the station says so wherever it shows it.
--   * Personal data kept by the station, its purpose and its retention (see also the runbook):
--       declared_operator  purpose: constancia de quién declaró entregar el premio. Kept with the delivery record; this migration
--                          implements NO deletion of it (the log is immutable by design), so none is promised.
--       attempts.ip_hash   purpose: limit PIN guessing per client. A salted hash of the address, never the address. Deleted by
--                          redemption_station_attempt_begin() when older than 24 hours and by redemption_station_revoke() (the closing
--                          action) at once. If a station is neither used nor closed, the last attempts stay until one of those two happens.
--       sessions           a hash of a random token, no address, no name; kept as evidence of access.
--   * Every table is reachable by the server's service key only (RLS on, no policy, no grant to anon or authenticated).

create table redemption_stations (
  station_id uuid primary key default gen_random_uuid(),
  slug text not null unique,
  label text not null,
  venue_activation_id uuid not null references venue_activations (venue_activation_id),
  match_id uuid not null references matches (match_id),
  -- the identity of the station: a gaming member with no authority grant (checked when the station is created and on every delivery)
  actor_gaming_member_id uuid not null references gaming_members (gaming_member_id),
  -- null until the Founder sets the PIN (then nobody can open a session); only a salted scrypt hash, never the PIN
  pin_salt text,
  pin_hash text,
  pin_version integer not null default 0,
  -- salt of the hash of the client address (kept apart from the PIN salt, so a PIN change does not reset the attempt limits)
  ip_salt text not null default encode(sha256(convert_to(gen_random_uuid()::text || gen_random_uuid()::text, 'utf8')), 'hex'),
  session_ttl_minutes integer not null default 240,
  expires_at timestamptz not null,
  revoked_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  constraint redemption_stations_slug_shape check (slug ~ '^[a-z0-9]+(-[a-z0-9]+)*$'),
  constraint redemption_stations_label_not_empty check (length(btrim(label)) > 0),
  constraint redemption_stations_pin_shape check (
    (pin_salt is null and pin_hash is null and pin_version = 0)
    or (pin_salt is not null and pin_hash is not null and pin_salt ~ '^[0-9a-f]{32,128}$' and pin_hash ~ '^[0-9a-f]{64,255}$' and pin_version >= 1)
  ),
  constraint redemption_stations_ip_salt_shape check (ip_salt ~ '^[0-9a-f]{64}$'),
  constraint redemption_stations_ttl_range check (session_ttl_minutes between 15 and 720)
);

-- A station is its configuration: after creation only the revocation and (through redemption_station_set_pin) the PIN can change.
create function redemption_stations_are_not_edited()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_pin_change boolean := coalesce(current_setting('redemption_station.pin_change', true), '') = 'on';
begin
  if tg_op = 'DELETE' then
    raise exception 'REDEMPTION_STATION_IMMUTABLE: a station is revoked, never deleted';
  end if;
  if new.station_id is distinct from old.station_id
     or new.slug is distinct from old.slug
     or new.label is distinct from old.label
     or new.venue_activation_id is distinct from old.venue_activation_id
     or new.match_id is distinct from old.match_id
     or new.actor_gaming_member_id is distinct from old.actor_gaming_member_id
     or new.ip_salt is distinct from old.ip_salt
     or new.session_ttl_minutes is distinct from old.session_ttl_minutes
     or new.expires_at is distinct from old.expires_at
     or new.created_at is distinct from old.created_at then
    raise exception 'REDEMPTION_STATION_IMMUTABLE: only the revocation and the PIN of a station can change';
  end if;
  if new.pin_salt is distinct from old.pin_salt
     or new.pin_hash is distinct from old.pin_hash
     or new.pin_version is distinct from old.pin_version then
    if not v_pin_change then
      raise exception 'REDEMPTION_STATION_IMMUTABLE: the PIN changes only through redemption_station_set_pin()';
    end if;
    if new.pin_version <> old.pin_version + 1 then
      raise exception 'REDEMPTION_STATION_IMMUTABLE: the PIN version moves one step at a time';
    end if;
  end if;
  if old.revoked_at is not null and new.revoked_at is distinct from old.revoked_at then
    raise exception 'REDEMPTION_STATION_IMMUTABLE: a revoked station stays revoked';
  end if;
  return new;
end;
$$;

create trigger redemption_stations_immutable
  before update or delete on redemption_stations
  for each row execute function redemption_stations_are_not_edited();

-- The activation and the match of a station belong together, and the station's identity holds NO authority at all.
create function redemption_stations_scope_is_coherent()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not exists (
    select 1 from venue_activations
     where venue_activation_id = new.venue_activation_id and match_id = new.match_id
  ) then
    raise exception 'REDEMPTION_STATION_SCOPE: the activation does not belong to that match';
  end if;
  if exists (
    select 1 from authority_grants
     where gaming_member_id = new.actor_gaming_member_id
       and revoked_at is null
  ) then
    raise exception 'REDEMPTION_STATION_ACTOR: the identity of a station must not hold any platform authority';
  end if;
  return new;
end;
$$;

create trigger redemption_stations_scope
  before insert on redemption_stations
  for each row execute function redemption_stations_scope_is_coherent();

-- A session belongs to the PIN version it was opened under: it stops being valid the moment the PIN changes.
create table redemption_station_sessions (
  session_id uuid primary key default gen_random_uuid(),
  station_id uuid not null references redemption_stations (station_id),
  token_sha256 text not null unique,
  pin_version integer not null,
  created_at timestamptz not null default clock_timestamp(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  constraint redemption_station_sessions_token_shape check (token_sha256 ~ '^[0-9a-f]{64}$'),
  constraint redemption_station_sessions_version check (pin_version >= 1)
);

create index redemption_station_sessions_station_idx on redemption_station_sessions (station_id);

-- One row per PIN attempt, written BEFORE the PIN is checked (as a failure) and flipped to a success afterwards: parallel attempts are all
-- counted, so the limit holds under concurrency. Only the salted hash of the client address, for the limit and nothing else.
create table redemption_station_attempts (
  attempt_id bigint generated always as identity primary key,
  station_id uuid not null references redemption_stations (station_id),
  ip_hash text not null,
  attempted_at timestamptz not null default clock_timestamp(),
  succeeded boolean not null default false
);

create index redemption_station_attempts_station_time_idx on redemption_station_attempts (station_id, attempted_at);

-- What the station did, never changed and never deleted. The declared name exists ONLY for a delivery this station made.
create table redemption_station_events (
  event_id uuid primary key default gen_random_uuid(),
  station_id uuid not null references redemption_stations (station_id),
  session_id uuid not null references redemption_station_sessions (session_id),
  prize_qualification_id uuid not null references prize_qualifications (prize_qualification_id),
  outcome text not null,
  declared_operator text,
  detail text,
  occurred_at timestamptz not null default clock_timestamp(),
  constraint redemption_station_events_outcome check (outcome in ('REDEEMED', 'ALREADY_REDEEMED', 'REFUSED')),
  constraint redemption_station_events_operator_shape check (
    (outcome = 'REDEEMED' and declared_operator is not null and length(btrim(declared_operator)) between 2 and 40)
    or (outcome <> 'REDEEMED' and declared_operator is null)
  )
);

create index redemption_station_events_prize_idx on redemption_station_events (prize_qualification_id);

create function redemption_station_events_are_never_changed()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'REDEMPTION_STATION_EVENT_IMMUTABLE: the station log is never changed or deleted';
end;
$$;

create trigger redemption_station_events_immutable
  before update or delete on redemption_station_events
  for each row execute function redemption_station_events_are_never_changed();

-- Who changed the PIN and when. Never the PIN, never its hash.
create table redemption_station_pin_changes (
  change_id uuid primary key default gen_random_uuid(),
  station_id uuid not null references redemption_stations (station_id),
  changed_by_gaming_member_id uuid not null references gaming_members (gaming_member_id),
  new_pin_version integer not null,
  sessions_revoked integer not null,
  changed_at timestamptz not null default clock_timestamp()
);

create index redemption_station_pin_changes_station_idx on redemption_station_pin_changes (station_id, changed_at);

create trigger redemption_station_pin_changes_immutable
  before update or delete on redemption_station_pin_changes
  for each row execute function redemption_station_events_are_never_changed();

-- Opens a PIN attempt, or refuses it. Serialised per station, so two parallel attempts are counted one after the other. It refuses when
-- this client (ip_hash) or the station as a whole already has too many failed attempts in the window — a station-wide limit stops an attack
-- that spreads over many addresses. The attempt is recorded as a failure; redemption_station_attempt_succeed() flips it. Attempts older
-- than 24 hours are no longer needed for anything and are deleted here.
create function redemption_station_attempt_begin(
  p_station_id uuid,
  p_ip_hash text,
  p_ip_limit integer,
  p_station_limit integer,
  p_window_seconds integer
)
returns table (allowed boolean, attempt_id bigint, retry_after_seconds integer)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_now timestamptz := clock_timestamp();
  v_since timestamptz := clock_timestamp() - make_interval(secs => p_window_seconds);
  v_ip_failures integer;
  v_station_failures integer;
  v_oldest_ip timestamptz;
  v_oldest_station timestamptz;
  v_retry integer := 0;
  v_attempt_id bigint;
begin
  perform pg_advisory_xact_lock(hashtextextended('redemption_station:' || p_station_id::text, 0));

  delete from redemption_station_attempts a
   where a.station_id = p_station_id and a.attempted_at < v_now - interval '24 hours';

  select count(*), min(a.attempted_at) into v_station_failures, v_oldest_station
    from redemption_station_attempts a
   where a.station_id = p_station_id and a.succeeded = false and a.attempted_at >= v_since;
  select count(*), min(a.attempted_at) into v_ip_failures, v_oldest_ip
    from redemption_station_attempts a
   where a.station_id = p_station_id and a.ip_hash = p_ip_hash and a.succeeded = false and a.attempted_at >= v_since;

  if v_ip_failures >= p_ip_limit then
    v_retry := greatest(v_retry, ceil(extract(epoch from (v_oldest_ip + make_interval(secs => p_window_seconds) - v_now)))::integer);
  end if;
  if v_station_failures >= p_station_limit then
    v_retry := greatest(v_retry, ceil(extract(epoch from (v_oldest_station + make_interval(secs => p_window_seconds) - v_now)))::integer);
  end if;
  if v_retry > 0 then
    return query select false, null::bigint, v_retry;
    return;
  end if;

  insert into redemption_station_attempts (station_id, ip_hash, attempted_at)
  values (p_station_id, p_ip_hash, v_now)
  returning redemption_station_attempts.attempt_id into v_attempt_id;
  return query select true, v_attempt_id, 0;
end;
$$;

create function redemption_station_attempt_succeed(p_attempt_id bigint)
returns void
language sql
security invoker
set search_path = public
as $$
  update redemption_station_attempts set succeeded = true where attempt_id = p_attempt_id;
$$;

-- Closes the station for good: the station, every session of it, and the attempts (the hashed addresses are of no use any more). It is the
-- way to take the access away; running it twice changes nothing.
create function redemption_station_revoke(p_station_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  update redemption_stations set revoked_at = clock_timestamp() where station_id = p_station_id and revoked_at is null;
  update redemption_station_sessions set revoked_at = clock_timestamp() where station_id = p_station_id and revoked_at is null;
  delete from redemption_station_attempts where station_id = p_station_id;
end;
$$;

-- Sets (or changes) the PIN of an open station: stores the salt and the hash it is given, moves the PIN version one step, revokes every
-- session of the station and writes the change log. The caller computes the hash, so the PIN never reaches the database.
create function redemption_station_set_pin(
  p_station_id uuid,
  p_pin_salt text,
  p_pin_hash text,
  p_changed_by_gaming_member_id uuid
)
returns table (pin_version integer, sessions_revoked integer)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_station redemption_stations%rowtype;
  v_revoked integer;
begin
  select * into v_station from redemption_stations where station_id = p_station_id for update;
  if not found then
    raise exception 'REDEMPTION_STATION_NOT_FOUND: there is no station with that identifier' using errcode = 'P0001';
  end if;
  if v_station.revoked_at is not null or clock_timestamp() >= v_station.expires_at then
    raise exception 'REDEMPTION_STATION_CLOSED: a closed station keeps its PIN as it was' using errcode = 'P0001';
  end if;

  perform set_config('redemption_station.pin_change', 'on', true);
  update redemption_stations
     set pin_salt = p_pin_salt, pin_hash = p_pin_hash, pin_version = v_station.pin_version + 1
   where station_id = p_station_id;
  perform set_config('redemption_station.pin_change', 'off', true);

  with revoked as (
    update redemption_station_sessions set revoked_at = clock_timestamp()
     where station_id = p_station_id and revoked_at is null
    returning 1
  )
  select count(*)::integer into v_revoked from revoked;

  insert into redemption_station_pin_changes (station_id, changed_by_gaming_member_id, new_pin_version, sessions_revoked)
  values (p_station_id, p_changed_by_gaming_member_id, v_station.pin_version + 1, v_revoked);

  return query select v_station.pin_version + 1, v_revoked;
end;
$$;

-- Marks ONE prize as delivered on behalf of a station session, or says why it was not. The caller names the session (by the hash of its
-- token) and the prize; EVERYTHING else is decided here:
--   * the session decides the station (there is no station parameter to manipulate), and it must be unrevoked, unexpired and opened under
--     the station's current PIN version; the station must be open;
--   * the prize must belong to the station's ONE activation and to its ONE match, else nothing is read or changed and the call fails;
--   * the station's identity must still hold no authority;
--   * the outcome is REDEEMED, ALREADY_REDEEMED (the same delivery as before, no second audit event) or REFUSED (superseded, satisfied by
--     an earlier delivery, or held), and every outcome is logged in the same transaction.
-- The station row is locked FOR SHARE: a revocation or a PIN change (which update it) waits for a delivery in progress, and a delivery that
-- starts after them sees the closed station or the new PIN version. The prize row is locked FOR UPDATE: two deliveries of one prize are
-- serialised and the second sees the first.
create function redemption_station_redeem(
  p_session_token_sha256 text,
  p_prize_qualification_id uuid,
  p_declared_operator text
)
returns table (outcome text, redeemed_at timestamptz, refusal text, event_id uuid)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_station_id uuid;
  v_station redemption_stations%rowtype;
  v_session redemption_station_sessions%rowtype;
  v_operator text := btrim(p_declared_operator);
  v_prize_activation uuid;
  v_redeemed_at timestamptz;
  v_superseded_at timestamptz;
  v_held_at timestamptz;
  v_released_at timestamptz;
  v_fulfilled_by uuid;
  v_prize_tier_id uuid;
  v_prize_label text;
  v_now timestamptz;
  v_event_id uuid := gen_random_uuid();
  v_refusal text;
begin
  select s.station_id into v_station_id from redemption_station_sessions s where s.token_sha256 = p_session_token_sha256;
  if not found then
    raise exception 'REDEMPTION_STATION_SESSION_INVALID: the session is not valid' using errcode = 'P0001';
  end if;
  select * into v_station from redemption_stations where station_id = v_station_id for share;
  -- read again once the station is locked: a revocation or a PIN change that was in progress has committed by now
  select * into v_session from redemption_station_sessions s where s.token_sha256 = p_session_token_sha256;
  if v_session.revoked_at is not null
     or clock_timestamp() >= v_session.expires_at
     or v_session.pin_version <> v_station.pin_version then
    raise exception 'REDEMPTION_STATION_SESSION_INVALID: the session is not valid' using errcode = 'P0001';
  end if;
  if v_station.revoked_at is not null or clock_timestamp() >= v_station.expires_at then
    raise exception 'REDEMPTION_STATION_CLOSED: the station is closed' using errcode = 'P0001';
  end if;
  if exists (select 1 from authority_grants g where g.gaming_member_id = v_station.actor_gaming_member_id and g.revoked_at is null) then
    raise exception 'REDEMPTION_STATION_ACTOR: the identity of a station must not hold any platform authority' using errcode = 'P0001';
  end if;
  if v_operator is null or length(v_operator) not between 2 and 40 or v_operator ~ '[[:cntrl:]]' then
    raise exception 'REDEMPTION_STATION_OPERATOR: the declared name must have 2 to 40 characters and no control characters' using errcode = 'P0001';
  end if;

  -- scope: this station's activation and match, and nothing else; an unknown or foreign prize is not even looked at further
  select q.venue_activation_id into v_prize_activation from prize_qualifications q where q.prize_qualification_id = p_prize_qualification_id;
  if not found
     or v_prize_activation is distinct from v_station.venue_activation_id
     or not exists (select 1 from venue_activations a where a.venue_activation_id = v_prize_activation and a.match_id = v_station.match_id) then
    raise exception 'REDEMPTION_STATION_SCOPE: that prize is not one of this station''s' using errcode = 'P0001';
  end if;

  select q.redeemed_at, q.superseded_at, q.held_at, q.released_at, q.fulfilled_by_prize_qualification_id, q.prize_tier_id
    into v_redeemed_at, v_superseded_at, v_held_at, v_released_at, v_fulfilled_by, v_prize_tier_id
    from prize_qualifications q
   where q.prize_qualification_id = p_prize_qualification_id
     for update;

  -- every decision below is made against the row as locked above, in the order of the existing redemption
  if v_redeemed_at is not null then
    insert into redemption_station_events (event_id, station_id, session_id, prize_qualification_id, outcome)
    values (v_event_id, v_station.station_id, v_session.session_id, p_prize_qualification_id, 'ALREADY_REDEEMED');
    return query select 'ALREADY_REDEEMED'::text, v_redeemed_at, null::text, v_event_id;
    return;
  end if;

  v_refusal := case
    when v_superseded_at is not null then 'SUPERSEDED'
    when v_fulfilled_by is not null then 'FULFILLED'
    when v_held_at is not null and v_released_at is null then 'HELD'
    else null
  end;
  if v_refusal is not null then
    insert into redemption_station_events (event_id, station_id, session_id, prize_qualification_id, outcome, detail)
    values (v_event_id, v_station.station_id, v_session.session_id, p_prize_qualification_id, 'REFUSED', v_refusal);
    return query select 'REFUSED'::text, null::timestamptz, v_refusal, v_event_id;
    return;
  end if;

  select t.prize_label into v_prize_label from prize_tiers t where t.prize_tier_id = v_prize_tier_id;
  v_now := now();

  update prize_qualifications q
     set redeemed_at = v_now,
         redeemed_by_gaming_member_id = v_station.actor_gaming_member_id,
         redeemed_prize_label = v_prize_label,
         redeemed_prize_label_basis = 'SNAPSHOT_AT_REDEMPTION'
   where q.prize_qualification_id = p_prize_qualification_id;

  insert into redemption_station_events (event_id, station_id, session_id, prize_qualification_id, outcome, declared_operator)
  values (v_event_id, v_station.station_id, v_session.session_id, p_prize_qualification_id, 'REDEEMED', v_operator);

  insert into admin_audit_events (
    action_type, actor_kind, actor_id, authority_class_used,
    target_type, target_id, resulting_reference, outcome, reason
  )
  values (
    'CONFIRM_PRIZE_REDEMPTION', 'GAMING_MEMBER', v_station.actor_gaming_member_id, null,
    'prize_qualifications', p_prize_qualification_id,
    jsonb_build_object('table', 'prize_qualifications', 'id', p_prize_qualification_id),
    'SUCCESS',
    'Canje en la estación «' || v_station.label || '» con PIN compartido (no acredita individualmente quién operó); el encargado declarado consta en el registro de la estación, evento ' || v_event_id::text || '.'
  );

  return query select 'REDEEMED'::text, v_now, null::text, v_event_id;
end;
$$;

alter table redemption_stations enable row level security;
alter table redemption_station_sessions enable row level security;
alter table redemption_station_attempts enable row level security;
alter table redemption_station_events enable row level security;
alter table redemption_station_pin_changes enable row level security;

revoke all on table redemption_stations from public, anon, authenticated;
revoke all on table redemption_station_sessions from public, anon, authenticated;
revoke all on table redemption_station_attempts from public, anon, authenticated;
revoke all on table redemption_station_events from public, anon, authenticated;
revoke all on table redemption_station_pin_changes from public, anon, authenticated;
grant all on table redemption_stations to service_role;
grant all on table redemption_station_sessions to service_role;
grant all on table redemption_station_attempts to service_role;
grant all on table redemption_station_events to service_role;
grant all on table redemption_station_pin_changes to service_role;
grant usage, select on all sequences in schema public to service_role;

revoke execute on function redemption_stations_are_not_edited() from public, anon, authenticated;
revoke execute on function redemption_stations_scope_is_coherent() from public, anon, authenticated;
revoke execute on function redemption_station_events_are_never_changed() from public, anon, authenticated;
revoke execute on function redemption_station_attempt_begin(uuid, text, integer, integer, integer) from public, anon, authenticated;
revoke execute on function redemption_station_attempt_succeed(bigint) from public, anon, authenticated;
revoke execute on function redemption_station_revoke(uuid) from public, anon, authenticated;
revoke execute on function redemption_station_set_pin(uuid, text, text, uuid) from public, anon, authenticated;
revoke execute on function redemption_station_redeem(text, uuid, text) from public, anon, authenticated;
grant execute on function redemption_station_attempt_begin(uuid, text, integer, integer, integer) to service_role;
grant execute on function redemption_station_attempt_succeed(bigint) to service_role;
grant execute on function redemption_station_revoke(uuid) to service_role;
grant execute on function redemption_station_set_pin(uuid, text, text, uuid) to service_role;
grant execute on function redemption_station_redeem(text, uuid, text) to service_role;
