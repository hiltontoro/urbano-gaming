-- UG-CR-GATE-SSS-004 — Small-Sided Soccer Organizer Planning Foundation.
--
-- WHAT THIS DOES. It gives the organizer of a DRAFT competition one place to record a competition-specific DRAFT PLAN: the venue and its time zone,
-- the pitches, one to three tournament dates with one or two operating windows each, the roster size the organizer configures within the format's
-- registry ranges, the registration deadline, and the rules the plan was made under. The plan is an append-only sequence of immutable revisions;
-- saving never edits an earlier one. It adds exactly:
--
--   1. competitions_competition_format_key: a unique key on (competition_id, activity_key), the only change to an existing table. It exists so that
--      a revision's recorded format is tied to its competition's own format by a composite foreign key and can never disagree with it or drift.
--      (That competition format is itself a registry key through competitions_activity_key_fkey, so a revision needs no key of its own into the
--      registry. A pitch's supported formats ARE tied to the authoritative registry directly: competition_planning_pitch_formats.format_key is a
--      foreign key to competition_format_rules(format_key), and the save operation also judges every one against the registry's own rows at run time.)
--   2. Five server-only tables: competition_planning_revisions and its four children (pitches, the formats each pitch supports, tournament dates,
--      operating windows). Row-level security is on, there is no policy, no browser role holds any privilege, and not even the server role can write
--      a row directly: every row is written by the one save operation, and the server role may only read.
--   3. Append-only triggers. UPDATE, DELETE and TRUNCATE are refused on every one of the five tables, so a saved revision and its facts never change.
--      Two further triggers keep the database itself the authority on the date limits and the non-overlap of windows, whatever writes the rows.
--   4. Three internal helpers (text cleaning, unknown-field refusal, and the resolver that says whether a venue-local wall-clock time exists once,
--      twice or not at all in a time zone), executable by nobody, and
--   5. save_competition_planning_revision_atomically: the one atomic save operation. It locks the competition, requires exact (null-safe) ownership,
--      applies the host-revocation guard, requires the DRAFT state, derives the format from the locked competition, loads the registry rule, then
--      judges the COMPLETE payload itself (it does not rely on the application having done so), and inserts one revision with all its children.
--      That judgment includes the clock: every operating-window start and end is a wall-clock time in the venue's time zone, and one that a clock change
--      skips (it never occurs) or repeats (it occurs twice) is refused, never silently shifted to another time or given a guessed offset.
--      An exact replay of the same intent returns the existing revision and writes nothing; the same intent with a different payload is refused.
--
-- WHAT THIS DELIBERATELY DOES NOT DO. It creates no venue or venue entitlement, no fixture, draw, schedule, appeal or adjudication record, no
-- automatic deadline job and no competition state. It does not touch competition creation: both creation functions still accept only SOCCER_5V5,
-- and nothing here lets any other format be created, selected or advertised. The fixed timing and the roster ranges stay in the format registry,
-- which this migration only reads; the plan stores the roster values the organizer configured, explicitly, and nothing of the timing.
-- A plan records validated planning capacity; whether future fixtures fit is the scheduling gate's question, not this one's.
--
-- Append-only: no earlier migration is edited. The save operation is a new function (no earlier definition exists to replace).

-- 1/8  The unique key behind the composite format foreign key.
alter table competitions
  add constraint competitions_competition_format_key unique (competition_id, activity_key);

-- 2/8  The revision table.
create table competition_planning_revisions (
  planning_revision_id uuid primary key default gen_random_uuid(),
  competition_id uuid not null,
  format_key text not null,
  revision_number integer not null,
  supersedes_revision_id uuid,
  authored_by_gaming_member_id uuid not null references gaming_members (gaming_member_id),
  created_at timestamptz not null default now(),
  intent_id uuid not null,
  payload_digest text not null,
  venue_name text not null,
  venue_location_description text not null,
  venue_time_zone text not null,
  simultaneous_match_capacity smallint not null,
  venue_restriction_notes text not null default '',
  roster_minimum smallint not null,
  roster_maximum smallint not null,
  registration_deadline_local timestamp not null,
  registration_deadline_time_zone text not null,
  registration_deadline_utc_offset_minutes smallint not null,
  registration_deadline_utc timestamptz not null,
  rules_version text not null,
  rules_snapshot text not null,
  rules_snapshot_digest text not null,
  constraint competition_planning_revisions_number_key unique (competition_id, revision_number),
  constraint competition_planning_revisions_intent_key unique (competition_id, intent_id),
  constraint competition_planning_revisions_one_successor_key unique (supersedes_revision_id),
  constraint competition_planning_revisions_competition_revision_key unique (competition_id, planning_revision_id),
  constraint competition_planning_revisions_number_positive check (revision_number >= 1),
  constraint competition_planning_revisions_first_has_no_predecessor check ((revision_number = 1) = (supersedes_revision_id is null)),
  constraint competition_planning_revisions_digest_shape check (payload_digest ~ '^[0-9a-f]{64}$' and rules_snapshot_digest ~ '^[0-9a-f]{64}$'),
  constraint competition_planning_revisions_venue_text check (
    char_length(venue_name) between 1 and 120 and char_length(venue_location_description) between 1 and 300 and char_length(venue_restriction_notes) <= 500),
  constraint competition_planning_revisions_time_zone_shape check (
    venue_time_zone ~ '^[A-Z][A-Za-z0-9_+-]*(/[A-Z][A-Za-z0-9_+-]*){1,2}$' and registration_deadline_time_zone = venue_time_zone),
  constraint competition_planning_revisions_capacity_range check (simultaneous_match_capacity between 1 and 16),
  constraint competition_planning_revisions_roster_range check (roster_minimum between 1 and 16 and roster_maximum between 1 and 16 and roster_minimum <= roster_maximum),
  constraint competition_planning_revisions_offset_range check (registration_deadline_utc_offset_minutes between -840 and 840),
  constraint competition_planning_revisions_rules_shape check (
    rules_version ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$' and char_length(rules_snapshot) between 1 and 4000)
);

alter table competition_planning_revisions
  add constraint competition_planning_revisions_competition_format_fkey
    foreign key (competition_id, format_key) references competitions (competition_id, activity_key);
alter table competition_planning_revisions
  add constraint competition_planning_revisions_supersedes_fkey
    foreign key (competition_id, supersedes_revision_id) references competition_planning_revisions (competition_id, planning_revision_id);

-- 3/8  The children.
create table competition_planning_pitches (
  planning_pitch_id uuid primary key default gen_random_uuid(),
  planning_revision_id uuid not null references competition_planning_revisions (planning_revision_id),
  position smallint not null,
  label text not null,
  is_usable boolean not null,
  restriction_notes text not null default '',
  constraint competition_planning_pitches_position_range check (position between 1 and 16),
  constraint competition_planning_pitches_position_key unique (planning_revision_id, position),
  constraint competition_planning_pitches_label_length check (char_length(label) between 1 and 40 and label = btrim(label)),
  constraint competition_planning_pitches_notes_length check (char_length(restriction_notes) <= 300)
);
create unique index competition_planning_pitches_label_key on competition_planning_pitches (planning_revision_id, lower(label));

create table competition_planning_pitch_formats (
  planning_pitch_id uuid not null references competition_planning_pitches (planning_pitch_id),
  format_key text not null,
  constraint competition_planning_pitch_formats_pkey primary key (planning_pitch_id, format_key),
  constraint competition_planning_pitch_formats_format_registry_fkey foreign key (format_key) references competition_format_rules (format_key)
);

create table competition_planning_dates (
  planning_revision_id uuid not null references competition_planning_revisions (planning_revision_id),
  plan_date date not null,
  position smallint not null,
  constraint competition_planning_dates_pkey primary key (planning_revision_id, plan_date),
  constraint competition_planning_dates_position_range check (position between 1 and 3),
  constraint competition_planning_dates_position_key unique (planning_revision_id, position)
);

create table competition_planning_windows (
  planning_window_id uuid primary key default gen_random_uuid(),
  planning_revision_id uuid not null,
  plan_date date not null,
  window_index smallint not null,
  start_time time(0) not null,
  end_time time(0) not null,
  constraint competition_planning_windows_index_range check (window_index in (1, 2)),
  constraint competition_planning_windows_forward check (start_time < end_time),
  constraint competition_planning_windows_index_key unique (planning_revision_id, plan_date, window_index),
  constraint competition_planning_windows_revision_fkey foreign key (planning_revision_id) references competition_planning_revisions (planning_revision_id),
  constraint competition_planning_windows_date_fkey foreign key (planning_revision_id, plan_date) references competition_planning_dates (planning_revision_id, plan_date)
);

-- 4/8  Server-only: no browser role holds any privilege, and not even the server role can write a row directly (the save operation does that).
alter table competition_planning_revisions enable row level security;
alter table competition_planning_pitches enable row level security;
alter table competition_planning_pitch_formats enable row level security;
alter table competition_planning_dates enable row level security;
alter table competition_planning_windows enable row level security;

revoke all on table competition_planning_revisions from public, anon, authenticated, service_role;
revoke all on table competition_planning_pitches from public, anon, authenticated, service_role;
revoke all on table competition_planning_pitch_formats from public, anon, authenticated, service_role;
revoke all on table competition_planning_dates from public, anon, authenticated, service_role;
revoke all on table competition_planning_windows from public, anon, authenticated, service_role;

grant select on table competition_planning_revisions to service_role;
grant select on table competition_planning_pitches to service_role;
grant select on table competition_planning_pitch_formats to service_role;
grant select on table competition_planning_dates to service_role;
grant select on table competition_planning_windows to service_role;

-- 5/8  Append-only: a saved revision and its facts never change, whoever asks.
create function competition_planning_reject_change()
 returns trigger
 language plpgsql
 set search_path = public, pg_temp
as $function$
begin
  raise exception 'PLANNING_REVISION_IMMUTABLE: a saved planning revision and its facts cannot be changed or removed' using errcode = 'P0001';
end;
$function$;
revoke all on function competition_planning_reject_change() from public, anon, authenticated;
revoke all on function competition_planning_reject_change() from service_role;

create trigger competition_planning_revisions_append_only before update or delete on competition_planning_revisions
  for each row execute function competition_planning_reject_change();
create trigger competition_planning_pitches_append_only before update or delete on competition_planning_pitches
  for each row execute function competition_planning_reject_change();
create trigger competition_planning_pitch_formats_append_only before update or delete on competition_planning_pitch_formats
  for each row execute function competition_planning_reject_change();
create trigger competition_planning_dates_append_only before update or delete on competition_planning_dates
  for each row execute function competition_planning_reject_change();
create trigger competition_planning_windows_append_only before update or delete on competition_planning_windows
  for each row execute function competition_planning_reject_change();

create trigger competition_planning_revisions_no_truncate before truncate on competition_planning_revisions
  for each statement execute function competition_planning_reject_change();
create trigger competition_planning_pitches_no_truncate before truncate on competition_planning_pitches
  for each statement execute function competition_planning_reject_change();
create trigger competition_planning_pitch_formats_no_truncate before truncate on competition_planning_pitch_formats
  for each statement execute function competition_planning_reject_change();
create trigger competition_planning_dates_no_truncate before truncate on competition_planning_dates
  for each statement execute function competition_planning_reject_change();
create trigger competition_planning_windows_no_truncate before truncate on competition_planning_windows
  for each statement execute function competition_planning_reject_change();

-- 6/8  The date limits and the non-overlap of windows are the database's own, whatever writes the rows.
create function competition_planning_check_date_limits()
 returns trigger
 language plpgsql
 set search_path = public, pg_temp
as $function$
declare
  v_count integer;
  v_first date;
  v_last date;
begin
  select count(*), min(d.plan_date), max(d.plan_date) into v_count, v_first, v_last
    from competition_planning_dates d
   where d.planning_revision_id = new.planning_revision_id;
  if v_count >= 3 then
    raise exception 'PLANNING_INVALID: DATE_COUNT_INVALID: a plan has at most three tournament dates' using errcode = 'P0001';
  end if;
  if greatest(v_last, new.plan_date) - least(v_first, new.plan_date) + 1 > 14 then
    raise exception 'PLANNING_INVALID: DATE_SPAN_TOO_LONG: the tournament dates must fall within a span of 14 days' using errcode = 'P0001';
  end if;
  return new;
end;
$function$;
revoke all on function competition_planning_check_date_limits() from public, anon, authenticated;
revoke all on function competition_planning_check_date_limits() from service_role;

create trigger competition_planning_dates_limits before insert on competition_planning_dates
  for each row execute function competition_planning_check_date_limits();

create function competition_planning_check_window_overlap()
 returns trigger
 language plpgsql
 set search_path = public, pg_temp
as $function$
begin
  if exists (
    select 1 from competition_planning_windows w
     where w.planning_revision_id = new.planning_revision_id
       and w.plan_date = new.plan_date
       and w.start_time < new.end_time
       and new.start_time < w.end_time
  ) then
    raise exception 'PLANNING_INVALID: WINDOW_OVERLAP: operating windows on the same date cannot overlap' using errcode = 'P0001';
  end if;
  return new;
end;
$function$;
revoke all on function competition_planning_check_window_overlap() from public, anon, authenticated;
revoke all on function competition_planning_check_window_overlap() from service_role;

create trigger competition_planning_windows_no_overlap before insert on competition_planning_windows
  for each row execute function competition_planning_check_window_overlap();

-- 7/8  Two internal helpers for the save operation. Nobody can call them directly.
create function competition_planning_clean_text(p_value jsonb, p_required boolean, p_max integer, p_multiline boolean, p_label text)
 returns text
 language plpgsql
 immutable
 set search_path = public, pg_temp
as $function$
declare
  v_text text;
begin
  if p_value is null or jsonb_typeof(p_value) <> 'string' then
    if p_required then
      raise exception 'PLANNING_INVALID: REQUIRED: the % is required', p_label using errcode = 'P0001';
    end if;
    if p_value is null or jsonb_typeof(p_value) = 'null' then
      return '';
    end if;
    raise exception 'PLANNING_INVALID: INVALID_TEXT: the % must be text', p_label using errcode = 'P0001';
  end if;
  v_text := btrim(replace(replace(p_value #>> '{}', E'\r\n', E'\n'), E'\r', E'\n'));
  if v_text = '' then
    if p_required then
      raise exception 'PLANNING_INVALID: REQUIRED: the % is required', p_label using errcode = 'P0001';
    end if;
    return '';
  end if;
  if (p_multiline and v_text ~ '[\x01-\x08\x0b\x0c\x0e-\x1f\x7f]') or ((not p_multiline) and v_text ~ '[\x01-\x1f\x7f]') then
    raise exception 'PLANNING_INVALID: INVALID_TEXT: the % contains characters that are not allowed', p_label using errcode = 'P0001';
  end if;
  if char_length(v_text) > p_max then
    raise exception 'PLANNING_INVALID: TOO_LONG: the % can have at most % characters', p_label, p_max using errcode = 'P0001';
  end if;
  return v_text;
end;
$function$;
revoke all on function competition_planning_clean_text(jsonb, boolean, integer, boolean, text) from public, anon, authenticated;
revoke all on function competition_planning_clean_text(jsonb, boolean, integer, boolean, text) from service_role;

-- How many instants a venue-local wall-clock time denotes in a time zone: 'ok' (exactly one), 'ambiguous' (a backward clock change shows it twice) or
-- 'nonexistent' (a forward clock change skips it). The offset in force is read at three probe instants around the reading, and each candidate is kept only
-- if that offset really holds at the instant it implies; the application's resolver (planning.ts) is the same method, and a contract test compares the two
-- on every five minutes around every 2026 clock change of sixteen zones.
create function competition_planning_local_time_kind(p_local timestamp, p_zone text)
 returns text
 language plpgsql
 stable
 set search_path = public, pg_temp
as $function$
declare
  v_reading timestamptz := p_local at time zone 'UTC';
  v_probe timestamptz;
  v_offset integer;
  v_instant timestamptz;
  v_found timestamptz[] := array[]::timestamptz[];
begin
  foreach v_probe in array array[v_reading - interval '36 hours', v_reading, v_reading + interval '36 hours'] loop
    v_offset := round(extract(epoch from ((v_probe at time zone p_zone) - (v_probe at time zone 'UTC'))) / 60)::integer;
    v_instant := v_reading - make_interval(mins => v_offset);
    if round(extract(epoch from ((v_instant at time zone p_zone) - (v_instant at time zone 'UTC'))) / 60)::integer = v_offset
       and not (v_instant = any (v_found)) then
      v_found := v_found || v_instant;
    end if;
  end loop;
  return case coalesce(array_length(v_found, 1), 0) when 0 then 'nonexistent' when 1 then 'ok' else 'ambiguous' end;
end;
$function$;
revoke all on function competition_planning_local_time_kind(timestamp, text) from public, anon, authenticated;
revoke all on function competition_planning_local_time_kind(timestamp, text) from service_role;

create function competition_planning_assert_keys(p_object jsonb, p_allowed text[], p_label text)
 returns void
 language plpgsql
 immutable
 set search_path = public, pg_temp
as $function$
declare
  v_key text;
begin
  for v_key in select jsonb_object_keys(p_object) loop
    if not (v_key = any (p_allowed)) then
      raise exception 'PLANNING_INVALID: UNKNOWN_FIELD: the % has a field that is not part of the plan', p_label using errcode = 'P0001';
    end if;
  end loop;
end;
$function$;
revoke all on function competition_planning_assert_keys(jsonb, text[], text) from public, anon, authenticated;
revoke all on function competition_planning_assert_keys(jsonb, text[], text) from service_role;

-- 8/8  The one atomic save operation.
create function save_competition_planning_revision_atomically(
  p_competition_id uuid,
  p_organizer_gaming_member_id uuid,
  p_intent_id uuid,
  p_plan jsonb
)
 returns table(planning_revision_id uuid, revision_number integer, already_saved boolean, is_current boolean)
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
#variable_conflict use_column
declare
  v_organizer_id uuid;
  v_state text;
  v_format text;
  v_rule competition_format_rules%rowtype;
  v_digest text;

  v_venue jsonb;
  v_pitches jsonb;
  v_pitch jsonb;
  v_dates jsonb;
  v_date_obj jsonb;
  v_windows jsonb;
  v_window jsonb;
  v_roster jsonb;
  v_deadline jsonb;
  v_rules jsonb;
  v_formats jsonb;
  v_elem jsonb;

  v_name text;
  v_location text;
  v_notes text;
  v_tz text;
  v_capacity integer;
  v_label text;
  v_labels text[] := array[]::text[];
  v_usable_count integer := 0;
  v_format_supported boolean := false;
  v_pitch_supports boolean;
  v_text text;
  v_d date;
  v_seen_dates date[] := array[]::date[];
  v_first_date date;
  v_last_date date;
  v_first_start timestamp;
  v_start_text text;
  v_end_text text;
  v_start_time time;
  v_end_time time;
  v_kind text;
  v_prev_start time;
  v_prev_end time;
  v_roster_min integer;
  v_roster_max integer;
  v_dl_local timestamp;
  v_dl_offset integer;
  v_dl_utc timestamptz;
  v_dl_derived integer;
  v_rules_version text;
  v_rules_snapshot text;

  v_existing_id uuid;
  v_existing_number integer;
  v_existing_digest text;
  v_prev_id uuid;
  v_prev_number integer;
  v_current_number integer;
  v_new_id uuid;
  v_new_number integer;
  v_pitch_id uuid;
  v_i integer;
  v_j integer;
  v_position integer;
begin
  -- Lock the competition (the same scope every organizer operation uses), then read it.
  perform pg_advisory_xact_lock(hashtext('competition_scope:' || p_competition_id::text));

  select competitions.organizer_gaming_member_id, competitions.state, competitions.activity_key
    into v_organizer_id, v_state, v_format
    from competitions
   where competitions.competition_id = p_competition_id
   for update;

  if v_organizer_id is null then
    raise exception 'COMPETITION_NOT_FOUND: no such competition exists' using errcode = 'P0001';
  end if;

  -- Exact, null-safe ownership: a missing caller is refused, never skipped.
  if p_organizer_gaming_member_id is distinct from v_organizer_id then
    raise exception 'COMPETITION_ACCESS_DENIED: only this competition''s own organizer may plan it'
      using errcode = 'P0001';
  end if;
  perform assert_competition_not_host_revoked(p_competition_id);

  if v_state <> 'DRAFT' then
    raise exception 'COMPETITION_NOT_DRAFT: planning is only available while the competition is a DRAFT'
      using errcode = 'P0001';
  end if;

  -- The format is the locked competition's own; the plan has no way to name one. Its rule comes from the registry.
  select * into v_rule from competition_format_rules where competition_format_rules.format_key = v_format;
  if not found then
    raise exception 'PLANNING_FORMAT_UNSUPPORTED: this competition format has no rule in the registry' using errcode = 'P0001';
  end if;

  -- The complete payload is judged here, whatever the caller already checked.
  if p_intent_id is null then
    raise exception 'PLANNING_INVALID: REQUIRED: a save identifier is required' using errcode = 'P0001';
  end if;
  if p_plan is null or jsonb_typeof(p_plan) <> 'object' then
    raise exception 'PLANNING_INVALID: PLAN_NOT_OBJECT: the plan must be an object' using errcode = 'P0001';
  end if;
  perform competition_planning_assert_keys(p_plan, array['venue', 'pitches', 'dates', 'roster', 'registration_deadline', 'rules'], 'plan');

  -- Venue.
  v_venue := p_plan -> 'venue';
  if v_venue is null or jsonb_typeof(v_venue) <> 'object' then
    raise exception 'PLANNING_INVALID: REQUIRED: the venue is required' using errcode = 'P0001';
  end if;
  perform competition_planning_assert_keys(v_venue, array['name', 'location_description', 'time_zone', 'simultaneous_match_capacity', 'restriction_notes'], 'venue');
  v_name := competition_planning_clean_text(v_venue -> 'name', true, 120, false, 'venue name');
  v_location := competition_planning_clean_text(v_venue -> 'location_description', true, 300, true, 'venue location');
  v_notes := competition_planning_clean_text(v_venue -> 'restriction_notes', false, 500, true, 'venue restriction notes');
  v_tz := case when jsonb_typeof(v_venue -> 'time_zone') = 'string' then v_venue ->> 'time_zone' end;
  if v_tz is null
     or v_tz !~ '^[A-Z][A-Za-z0-9_+-]*(/[A-Z][A-Za-z0-9_+-]*){1,2}$'
     or not exists (select 1 from pg_timezone_names z where z.name = v_tz) then
    raise exception 'PLANNING_INVALID: INVALID_TIMEZONE: enter a valid IANA time zone name such as America/Costa_Rica' using errcode = 'P0001';
  end if;

  -- Pitches.
  v_pitches := p_plan -> 'pitches';
  if v_pitches is null or jsonb_typeof(v_pitches) <> 'array' or jsonb_array_length(v_pitches) = 0 then
    raise exception 'PLANNING_INVALID: NO_PITCHES: a plan needs at least one pitch' using errcode = 'P0001';
  end if;
  if jsonb_array_length(v_pitches) > 16 then
    raise exception 'PLANNING_INVALID: TOO_MANY_PITCHES: a plan has at most 16 pitches' using errcode = 'P0001';
  end if;
  for v_i in 0 .. jsonb_array_length(v_pitches) - 1 loop
    v_pitch := v_pitches -> v_i;
    if jsonb_typeof(v_pitch) <> 'object' then
      raise exception 'PLANNING_INVALID: INVALID: every pitch must be an object' using errcode = 'P0001';
    end if;
    perform competition_planning_assert_keys(v_pitch, array['label', 'usable', 'supported_formats', 'restriction_notes'], 'pitch');
    v_label := competition_planning_clean_text(v_pitch -> 'label', true, 40, false, 'pitch label');
    if lower(v_label) = any (v_labels) then
      raise exception 'PLANNING_INVALID: DUPLICATE_LABEL: two pitches have the same label' using errcode = 'P0001';
    end if;
    v_labels := v_labels || lower(v_label);
    perform competition_planning_clean_text(v_pitch -> 'restriction_notes', false, 300, true, 'pitch restriction notes');
    if jsonb_typeof(v_pitch -> 'usable') is distinct from 'boolean' then
      raise exception 'PLANNING_INVALID: INVALID: whether a pitch is usable must be yes or no' using errcode = 'P0001';
    end if;
    v_formats := v_pitch -> 'supported_formats';
    if v_formats is null or jsonb_typeof(v_formats) <> 'array' then
      raise exception 'PLANNING_INVALID: REQUIRED: the formats a pitch supports are required' using errcode = 'P0001';
    end if;
    v_pitch_supports := false;
    for v_j in 0 .. jsonb_array_length(v_formats) - 1 loop
      v_elem := v_formats -> v_j;
      if jsonb_typeof(v_elem) <> 'string'
         or not exists (select 1 from competition_format_rules r where r.format_key = (v_elem #>> '{}')) then
        raise exception 'PLANNING_INVALID: UNSUPPORTED_FORMAT_KEY: a pitch lists a format that is not supported' using errcode = 'P0001';
      end if;
      if (v_elem #>> '{}') = v_format then
        v_pitch_supports := true;
      end if;
    end loop;
    if (v_pitch -> 'usable')::boolean then
      if jsonb_array_length(v_formats) = 0 then
        raise exception 'PLANNING_INVALID: REQUIRED: a usable pitch must support at least one format' using errcode = 'P0001';
      end if;
      v_usable_count := v_usable_count + 1;
      if v_pitch_supports then
        v_format_supported := true;
      end if;
    end if;
  end loop;
  if v_usable_count = 0 then
    raise exception 'PLANNING_INVALID: NO_USABLE_PITCH: a plan needs at least one usable pitch' using errcode = 'P0001';
  end if;
  if not v_format_supported then
    raise exception 'PLANNING_INVALID: FORMAT_NOT_SUPPORTED_BY_ANY_USABLE_PITCH: no usable pitch supports this competition''s format' using errcode = 'P0001';
  end if;

  -- Simultaneous capacity: a whole number from one up to the number of usable pitches.
  v_text := case when jsonb_typeof(v_venue -> 'simultaneous_match_capacity') = 'number' then v_venue ->> 'simultaneous_match_capacity' end;
  if v_text is null or v_text !~ '^[0-9]{1,3}$' then
    raise exception 'PLANNING_INVALID: CAPACITY_INVALID: simultaneous matches must be a whole number from 1 up to the number of usable pitches' using errcode = 'P0001';
  end if;
  v_capacity := v_text::integer;
  if v_capacity < 1 or v_capacity > v_usable_count then
    raise exception 'PLANNING_INVALID: CAPACITY_INVALID: simultaneous matches must be a whole number from 1 up to the number of usable pitches' using errcode = 'P0001';
  end if;

  -- Tournament dates and their operating windows.
  v_dates := p_plan -> 'dates';
  if v_dates is null or jsonb_typeof(v_dates) <> 'array' or jsonb_array_length(v_dates) < 1 or jsonb_array_length(v_dates) > 3 then
    raise exception 'PLANNING_INVALID: DATE_COUNT_INVALID: a plan has one to three tournament dates' using errcode = 'P0001';
  end if;
  for v_i in 0 .. jsonb_array_length(v_dates) - 1 loop
    v_date_obj := v_dates -> v_i;
    if jsonb_typeof(v_date_obj) <> 'object' then
      raise exception 'PLANNING_INVALID: INVALID_DATE: every date must be an object' using errcode = 'P0001';
    end if;
    perform competition_planning_assert_keys(v_date_obj, array['date', 'windows'], 'date');
    v_text := case when jsonb_typeof(v_date_obj -> 'date') = 'string' then v_date_obj ->> 'date' end;
    if v_text is null or v_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception 'PLANNING_INVALID: INVALID_DATE: a tournament date must be a real calendar day written YYYY-MM-DD' using errcode = 'P0001';
    end if;
    begin
      v_d := v_text::date;
    exception when others then
      raise exception 'PLANNING_INVALID: INVALID_DATE: a tournament date must be a real calendar day written YYYY-MM-DD' using errcode = 'P0001';
    end;
    if to_char(v_d, 'YYYY-MM-DD') <> v_text or v_d < date '2020-01-01' or v_d > date '2099-12-31' then
      raise exception 'PLANNING_INVALID: INVALID_DATE: a tournament date must be a real calendar day written YYYY-MM-DD' using errcode = 'P0001';
    end if;
    if v_d = any (v_seen_dates) then
      raise exception 'PLANNING_INVALID: DUPLICATE_DATE: a date is listed twice' using errcode = 'P0001';
    end if;
    v_seen_dates := v_seen_dates || v_d;
    v_first_date := least(coalesce(v_first_date, v_d), v_d);
    v_last_date := greatest(coalesce(v_last_date, v_d), v_d);

    v_windows := v_date_obj -> 'windows';
    if v_windows is null or jsonb_typeof(v_windows) <> 'array' or jsonb_array_length(v_windows) < 1 or jsonb_array_length(v_windows) > 2 then
      raise exception 'PLANNING_INVALID: WINDOW_COUNT_INVALID: every date has one or two operating windows' using errcode = 'P0001';
    end if;
    v_prev_start := null;
    v_prev_end := null;
    for v_j in 0 .. jsonb_array_length(v_windows) - 1 loop
      v_window := v_windows -> v_j;
      if jsonb_typeof(v_window) <> 'object' then
        raise exception 'PLANNING_INVALID: INVALID_TIME: every window must be an object' using errcode = 'P0001';
      end if;
      perform competition_planning_assert_keys(v_window, array['start', 'end'], 'window');
      v_start_text := case when jsonb_typeof(v_window -> 'start') = 'string' then v_window ->> 'start' end;
      v_end_text := case when jsonb_typeof(v_window -> 'end') = 'string' then v_window ->> 'end' end;
      if v_start_text is null or v_start_text !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'
         or v_end_text is null or v_end_text !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
        raise exception 'PLANNING_INVALID: INVALID_TIME: a window time must be written HH:MM on a 24-hour clock' using errcode = 'P0001';
      end if;
      v_start_time := v_start_text::time;
      v_end_time := v_end_text::time;
      -- Every endpoint is a wall-clock time in the venue's zone on that date: one a clock change skips or repeats is refused, never shifted or guessed.
      v_kind := competition_planning_local_time_kind(v_d + v_start_time, v_tz);
      if v_kind = 'nonexistent' then
        raise exception 'PLANNING_INVALID: WINDOW_NONEXISTENT_LOCAL_TIME: the window start % does not exist on % in % (the clocks skip it)', v_start_text, v_text, v_tz using errcode = 'P0001';
      elsif v_kind = 'ambiguous' then
        raise exception 'PLANNING_INVALID: WINDOW_AMBIGUOUS_LOCAL_TIME: the window start % happens twice on % in % (the clocks repeat it)', v_start_text, v_text, v_tz using errcode = 'P0001';
      end if;
      v_kind := competition_planning_local_time_kind(v_d + v_end_time, v_tz);
      if v_kind = 'nonexistent' then
        raise exception 'PLANNING_INVALID: WINDOW_NONEXISTENT_LOCAL_TIME: the window end % does not exist on % in % (the clocks skip it)', v_end_text, v_text, v_tz using errcode = 'P0001';
      elsif v_kind = 'ambiguous' then
        raise exception 'PLANNING_INVALID: WINDOW_AMBIGUOUS_LOCAL_TIME: the window end % happens twice on % in % (the clocks repeat it)', v_end_text, v_text, v_tz using errcode = 'P0001';
      end if;
      if v_start_time >= v_end_time then
        raise exception 'PLANNING_INVALID: WINDOW_CROSSES_MIDNIGHT: a window must end after it starts, on the same day' using errcode = 'P0001';
      end if;
      if v_prev_start is not null and v_prev_start < v_end_time and v_start_time < v_prev_end then
        raise exception 'PLANNING_INVALID: WINDOW_OVERLAP: operating windows on the same date cannot overlap' using errcode = 'P0001';
      end if;
      v_prev_start := v_start_time;
      v_prev_end := v_end_time;
      if v_first_start is null or (v_d + v_start_time) < v_first_start then
        v_first_start := v_d + v_start_time;
      end if;
    end loop;
  end loop;
  if v_last_date - v_first_date + 1 > 14 then
    raise exception 'PLANNING_INVALID: DATE_SPAN_TOO_LONG: the tournament dates must fall within a span of 14 days' using errcode = 'P0001';
  end if;

  -- Roster: explicit values, inside this format's registry ranges.
  v_roster := p_plan -> 'roster';
  if v_roster is null or jsonb_typeof(v_roster) <> 'object' then
    raise exception 'PLANNING_INVALID: ROSTER_VALUE_INVALID: the roster minimum and maximum are required' using errcode = 'P0001';
  end if;
  perform competition_planning_assert_keys(v_roster, array['minimum', 'maximum'], 'roster');
  v_start_text := case when jsonb_typeof(v_roster -> 'minimum') = 'number' then v_roster ->> 'minimum' end;
  v_end_text := case when jsonb_typeof(v_roster -> 'maximum') = 'number' then v_roster ->> 'maximum' end;
  if v_start_text is null or v_start_text !~ '^[0-9]{1,3}$' or v_end_text is null or v_end_text !~ '^[0-9]{1,3}$' then
    raise exception 'PLANNING_INVALID: ROSTER_VALUE_INVALID: the roster minimum and maximum must be whole numbers' using errcode = 'P0001';
  end if;
  v_roster_min := v_start_text::integer;
  v_roster_max := v_end_text::integer;
  if v_roster_min < v_rule.roster_minimum_range_low or v_roster_min > v_rule.roster_minimum_range_high then
    raise exception 'PLANNING_INVALID: ROSTER_MINIMUM_OUT_OF_RANGE: the roster minimum is outside the range allowed for this format' using errcode = 'P0001';
  end if;
  if v_roster_max < v_rule.roster_maximum_range_low or v_roster_max > v_rule.roster_maximum_range_high then
    raise exception 'PLANNING_INVALID: ROSTER_MAXIMUM_OUT_OF_RANGE: the roster maximum is outside the range allowed for this format' using errcode = 'P0001';
  end if;
  if v_roster_min > v_roster_max then
    raise exception 'PLANNING_INVALID: ROSTER_MINIMUM_ABOVE_MAXIMUM: the roster minimum cannot exceed the roster maximum' using errcode = 'P0001';
  end if;

  -- Registration deadline: the venue-local time, the zone, the offset and the UTC instant must all describe one and the same moment.
  v_deadline := p_plan -> 'registration_deadline';
  if v_deadline is null or jsonb_typeof(v_deadline) <> 'object' then
    raise exception 'PLANNING_INVALID: DEADLINE_INVALID: the registration deadline is required' using errcode = 'P0001';
  end if;
  perform competition_planning_assert_keys(v_deadline, array['local', 'time_zone', 'utc_offset_minutes', 'utc'], 'registration deadline');
  v_text := case when jsonb_typeof(v_deadline -> 'local') = 'string' then v_deadline ->> 'local' end;
  if v_text is null or v_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T([01][0-9]|2[0-3]):[0-5][0-9]$' then
    raise exception 'PLANNING_INVALID: DEADLINE_INVALID: the registration deadline must be written YYYY-MM-DDTHH:MM' using errcode = 'P0001';
  end if;
  begin
    v_d := substr(v_text, 1, 10)::date;
  exception when others then
    raise exception 'PLANNING_INVALID: DEADLINE_INVALID: the registration deadline must be a real calendar day' using errcode = 'P0001';
  end;
  if to_char(v_d, 'YYYY-MM-DD') <> substr(v_text, 1, 10) or v_d < date '2020-01-01' or v_d > date '2099-12-31' then
    raise exception 'PLANNING_INVALID: DEADLINE_INVALID: the registration deadline must be a real calendar day' using errcode = 'P0001';
  end if;
  v_dl_local := replace(v_text, 'T', ' ')::timestamp;
  if (case when jsonb_typeof(v_deadline -> 'time_zone') = 'string' then v_deadline ->> 'time_zone' end) is distinct from v_tz then
    raise exception 'PLANNING_INVALID: DEADLINE_TIMEZONE_MISMATCH: the registration deadline must use the venue''s time zone' using errcode = 'P0001';
  end if;
  v_start_text := case when jsonb_typeof(v_deadline -> 'utc_offset_minutes') = 'number' then v_deadline ->> 'utc_offset_minutes' end;
  if v_start_text is null or v_start_text !~ '^-?[0-9]{1,4}$' or v_start_text::integer not between -840 and 840 then
    raise exception 'PLANNING_INVALID: DEADLINE_OFFSET_INVALID: the registration deadline needs a UTC offset of up to 14 hours' using errcode = 'P0001';
  end if;
  v_dl_offset := v_start_text::integer;
  v_text := case when jsonb_typeof(v_deadline -> 'utc') = 'string' then v_deadline ->> 'utc' end;
  if v_text is null or v_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}(\.[0-9]{1,3})?Z$' then
    raise exception 'PLANNING_INVALID: DEADLINE_UTC_INVALID: the registration deadline needs a UTC instant written YYYY-MM-DDTHH:MM:SSZ' using errcode = 'P0001';
  end if;
  begin
    v_dl_utc := v_text::timestamptz;
  exception when others then
    raise exception 'PLANNING_INVALID: DEADLINE_UTC_INVALID: the registration deadline needs a real UTC instant' using errcode = 'P0001';
  end;
  if (v_dl_utc at time zone v_tz) <> v_dl_local then
    raise exception 'PLANNING_INVALID: DEADLINE_UTC_MISMATCH: the UTC instant does not match the venue-local deadline in that time zone' using errcode = 'P0001';
  end if;
  v_dl_derived := round(extract(epoch from ((v_dl_utc at time zone v_tz) - (v_dl_utc at time zone 'UTC'))) / 60)::integer;
  if v_dl_derived <> v_dl_offset then
    raise exception 'PLANNING_INVALID: DEADLINE_OFFSET_MISMATCH: the UTC offset does not match the venue-local deadline in that time zone' using errcode = 'P0001';
  end if;
  if v_dl_local >= v_first_start then
    raise exception 'PLANNING_INVALID: DEADLINE_NOT_BEFORE_FIRST_WINDOW: registration must close before the first operating window opens' using errcode = 'P0001';
  end if;

  -- Rules the plan was made under.
  v_rules := p_plan -> 'rules';
  if v_rules is null or jsonb_typeof(v_rules) <> 'object' then
    raise exception 'PLANNING_INVALID: REQUIRED: the rules version and snapshot are required' using errcode = 'P0001';
  end if;
  perform competition_planning_assert_keys(v_rules, array['version', 'snapshot'], 'rules');
  v_rules_version := competition_planning_clean_text(v_rules -> 'version', true, 1000, false, 'rules version');
  if v_rules_version !~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$' then
    raise exception 'PLANNING_INVALID: INVALID: the rules version may use letters, digits, dots, dashes and underscores only' using errcode = 'P0001';
  end if;
  v_rules_snapshot := competition_planning_clean_text(v_rules -> 'snapshot', true, 4000, true, 'rules snapshot');

  -- The intent: an exact replay returns what was saved; the same intent with anything different is refused.
  v_digest := encode(sha256(convert_to(p_plan::text, 'UTF8')), 'hex');

  select r.planning_revision_id, r.revision_number, r.payload_digest
    into v_existing_id, v_existing_number, v_existing_digest
    from competition_planning_revisions r
   where r.competition_id = p_competition_id and r.intent_id = p_intent_id;

  if found then
    if v_existing_digest <> v_digest then
      raise exception 'PLANNING_INTENT_MISMATCH: this save identifier was already used for a different plan' using errcode = 'P0001';
    end if;
    select max(r.revision_number) into v_current_number
      from competition_planning_revisions r where r.competition_id = p_competition_id;
    return query select v_existing_id, v_existing_number, true, (v_existing_number = v_current_number);
    return;
  end if;

  -- A new revision supersedes the current one. The competition lock makes the numbering gap-free and unique.
  select r.planning_revision_id, r.revision_number into v_prev_id, v_prev_number
    from competition_planning_revisions r
   where r.competition_id = p_competition_id
   order by r.revision_number desc
   limit 1;
  v_new_number := coalesce(v_prev_number, 0) + 1;

  insert into competition_planning_revisions (
    competition_id, format_key, revision_number, supersedes_revision_id, authored_by_gaming_member_id, created_at, intent_id, payload_digest,
    venue_name, venue_location_description, venue_time_zone, simultaneous_match_capacity, venue_restriction_notes,
    roster_minimum, roster_maximum,
    registration_deadline_local, registration_deadline_time_zone, registration_deadline_utc_offset_minutes, registration_deadline_utc,
    rules_version, rules_snapshot, rules_snapshot_digest
  ) values (
    p_competition_id, v_format, v_new_number, v_prev_id, p_organizer_gaming_member_id, clock_timestamp(), p_intent_id, v_digest,
    v_name, v_location, v_tz, v_capacity, v_notes,
    v_roster_min, v_roster_max,
    v_dl_local, v_tz, v_dl_offset, v_dl_utc,
    v_rules_version, v_rules_snapshot, encode(sha256(convert_to(v_rules_snapshot, 'UTF8')), 'hex')
  ) returning competition_planning_revisions.planning_revision_id into v_new_id;

  for v_i in 0 .. jsonb_array_length(v_pitches) - 1 loop
    v_pitch := v_pitches -> v_i;
    insert into competition_planning_pitches (planning_revision_id, position, label, is_usable, restriction_notes)
    values (
      v_new_id, v_i + 1,
      competition_planning_clean_text(v_pitch -> 'label', true, 40, false, 'pitch label'),
      (v_pitch -> 'usable')::boolean,
      competition_planning_clean_text(v_pitch -> 'restriction_notes', false, 300, true, 'pitch restriction notes')
    ) returning competition_planning_pitches.planning_pitch_id into v_pitch_id;
    insert into competition_planning_pitch_formats (planning_pitch_id, format_key)
    select distinct v_pitch_id, f.value #>> '{}' from jsonb_array_elements(v_pitch -> 'supported_formats') f;
  end loop;

  v_position := 0;
  for v_date_obj in select d.value from jsonb_array_elements(v_dates) d order by d.value ->> 'date' loop
    v_position := v_position + 1;
    v_d := (v_date_obj ->> 'date')::date;
    insert into competition_planning_dates (planning_revision_id, plan_date, position) values (v_new_id, v_d, v_position);
    v_j := 0;
    for v_window in select w.value from jsonb_array_elements(v_date_obj -> 'windows') w order by w.value ->> 'start' loop
      v_j := v_j + 1;
      insert into competition_planning_windows (planning_revision_id, plan_date, window_index, start_time, end_time)
      values (v_new_id, v_d, v_j, (v_window ->> 'start')::time, (v_window ->> 'end')::time);
    end loop;
  end loop;

  return query select v_new_id, v_new_number, false, true;
end;
$function$;

revoke all on function save_competition_planning_revision_atomically(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function save_competition_planning_revision_atomically(uuid, uuid, uuid, jsonb) to service_role;
