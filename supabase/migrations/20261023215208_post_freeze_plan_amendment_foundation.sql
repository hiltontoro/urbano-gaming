-- UG-CR-GATE-SSS-011 — Post-Freeze Plan Amendment backend foundation.
--
-- WHAT THIS DOES. After registration is frozen (READY_TO_PUBLISH, one freeze, no fixture) the organizer may PROPOSE a change to the venue, the pitches
-- and the tournament dates and windows — and nothing else. A proposal is separate, immutable evidence: it never touches the current planning revision. It
-- takes effect only when the FOUR frozen captains (read from the registration-freeze snapshot) have each confirmed THAT exact proposal; the fourth
-- confirmation atomically re-checks everything and creates the next immutable planning revision. One rejection ends the proposal. A proposal lives
-- until the earlier of 24 hours after it was recorded or 12 hours before its earliest window, by the database clock only (no job, no client time),
-- and is refused when its earliest window is 12 hours or less away.
--
--   1. The planning validation and the revision insert are EXTRACTED out of save_competition_planning_revision_atomically into two internal
--      functions (competition_validate_planning_plan, competition_insert_planning_revision), and the save operation is replaced so that it delegates to
--      them. The validation text is the accepted SSS-004 text, moved, not rewritten; the DRAFT save keeps its order, its refusals and its results.
--   2. Three server-only, append-only tables: competition_plan_change_proposals (the immutable proposal), competition_plan_change_decisions (one row per
--      frozen team: CONFIRMED or REJECTED, bound to the proposal's digest) and competition_plan_change_resolutions (at most one per proposal:
--      ACTIVATED, REJECTED, WITHDRAWN or SUPERSEDED). A proposal's status is DERIVED from them (PENDING, or EXPIRED by the clock when nothing resolved it).
--      Row-level security is on, there is no policy, no role holds any privilege, and UPDATE, DELETE and TRUNCATE are refused.
--   3. Internal helpers, executable by nobody: the digest, the window test, the freeze-consistency test, the current-plan reader and the check triggers.
--   4. Four service-role-only operations: propose, decide (a frozen captain confirms or rejects), withdraw (the organizer) and a bounded status read.
--
-- WHAT THIS DELIBERATELY DOES NOT DO. It changes no earlier migration, no registry value, no registration, deadline or freeze function, no freeze table,
-- no publish or cancel operation and no discovery. It adds no draw, pairing, fixture, schedule, appeal or adjudication record, no notification, no
-- captain replacement and no override of any kind: a frozen captain who does not answer simply leaves the proposal unable to activate, and the organizer's
-- exits are the withdrawal, the expiry and the cancellation that already exist. The venue time zone, the format, the roster bounds, the registration
-- deadline, the rules and the frozen teams, captains and members are PRESERVED: a proposal cannot carry them and the new revision is composed from the
-- current one. Nothing here makes any format other than five-a-side creatable.
--
-- Append-only: no earlier migration is edited. The save operation is replaced in place (create or replace keeps its grants).

-- 1/7  The extracted validation. It judges the COMPLETE plan for one format and returns it normalized (cleaned text, supported formats and windows sorted,
-- dates in order, the deadline's UTC instant to the millisecond), in exactly the shape it accepts, so validating its own output changes nothing.
create function competition_validate_planning_plan(p_format text, p_plan jsonb)
 returns jsonb
 language plpgsql
 stable
 set search_path = public, pg_temp
as $function$
declare
  v_format text := p_format;
  v_rule competition_format_rules%rowtype;

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
  v_pnotes text;
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

  v_out_pitches jsonb := '[]'::jsonb;
  v_out_dates jsonb := '[]'::jsonb;
  v_out_windows jsonb := '[]'::jsonb;
  v_i integer;
  v_j integer;
begin
  select * into v_rule from competition_format_rules where competition_format_rules.format_key = v_format;
  if not found then
    raise exception 'PLANNING_FORMAT_UNSUPPORTED: this competition format has no rule in the registry' using errcode = 'P0001';
  end if;

  -- The complete payload is judged here, whatever the caller already checked.
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
    v_pnotes := competition_planning_clean_text(v_pitch -> 'restriction_notes', false, 300, true, 'pitch restriction notes');
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
    v_out_pitches := v_out_pitches || jsonb_build_array(jsonb_build_object(
      'label', v_label,
      'usable', (v_pitch -> 'usable')::boolean,
      'supported_formats', (select coalesce(jsonb_agg(s.k order by s.k collate "C"), '[]'::jsonb) from (select distinct f.value #>> '{}' as k from jsonb_array_elements(v_formats) f) s),
      'restriction_notes', v_pnotes));
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
    v_out_windows := '[]'::jsonb;
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
      v_out_windows := v_out_windows || jsonb_build_array(jsonb_build_object('start', v_start_text, 'end', v_end_text));
    end loop;
    v_out_dates := v_out_dates || jsonb_build_array(jsonb_build_object(
      'date', to_char(v_d, 'YYYY-MM-DD'),
      'windows', (select coalesce(jsonb_agg(w.e order by w.e ->> 'start' collate "C"), '[]'::jsonb) from jsonb_array_elements(v_out_windows) as w(e))));
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


  return jsonb_build_object(
    'venue', jsonb_build_object('name', v_name, 'location_description', v_location, 'time_zone', v_tz, 'simultaneous_match_capacity', v_capacity, 'restriction_notes', v_notes),
    'pitches', v_out_pitches,
    'dates', (select coalesce(jsonb_agg(d.e order by d.e ->> 'date' collate "C"), '[]'::jsonb) from jsonb_array_elements(v_out_dates) as d(e)),
    'roster', jsonb_build_object('minimum', v_roster_min, 'maximum', v_roster_max),
    'registration_deadline', jsonb_build_object(
      'local', to_char(v_dl_local, 'YYYY-MM-DD"T"HH24:MI'), 'time_zone', v_tz, 'utc_offset_minutes', v_dl_offset,
      'utc', to_char(v_dl_utc at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
    'rules', jsonb_build_object('version', v_rules_version, 'snapshot', v_rules_snapshot)
  );
end;
$function$;
revoke all on function competition_validate_planning_plan(text, jsonb) from public, anon, authenticated;
revoke all on function competition_validate_planning_plan(text, jsonb) from service_role;

-- 2/7  The extracted insert: one immutable revision and all its children, from a plan the validation above has already judged and normalized.
create function competition_insert_planning_revision(
  p_competition_id uuid, p_format text, p_author_gaming_member_id uuid, p_intent_id uuid, p_payload_digest text, p_plan jsonb
)
 returns table(planning_revision_id uuid, revision_number integer)
 language plpgsql
 set search_path = public, pg_temp
as $function$
#variable_conflict use_column
declare
  v_prev_id uuid;
  v_prev_number integer;
  v_new_id uuid;
  v_new_number integer;
  v_pitch jsonb;
  v_pitch_id uuid;
  v_date_obj jsonb;
  v_window jsonb;
  v_i integer;
  v_j integer;
  v_position integer;
  v_d date;
begin
  -- A new revision supersedes the current one. The caller holds the competition lock, which makes the numbering gap-free and unique.
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
    p_competition_id, p_format, v_new_number, v_prev_id, p_author_gaming_member_id, clock_timestamp(), p_intent_id, p_payload_digest,
    p_plan #>> '{venue,name}', p_plan #>> '{venue,location_description}', p_plan #>> '{venue,time_zone}', (p_plan #>> '{venue,simultaneous_match_capacity}')::smallint, p_plan #>> '{venue,restriction_notes}',
    (p_plan #>> '{roster,minimum}')::smallint, (p_plan #>> '{roster,maximum}')::smallint,
    replace(p_plan #>> '{registration_deadline,local}', 'T', ' ')::timestamp, p_plan #>> '{registration_deadline,time_zone}',
    (p_plan #>> '{registration_deadline,utc_offset_minutes}')::smallint, (p_plan #>> '{registration_deadline,utc}')::timestamptz,
    p_plan #>> '{rules,version}', p_plan #>> '{rules,snapshot}', encode(sha256(convert_to(p_plan #>> '{rules,snapshot}', 'UTF8')), 'hex')
  ) returning competition_planning_revisions.planning_revision_id into v_new_id;

  for v_i in 0 .. jsonb_array_length(p_plan -> 'pitches') - 1 loop
    v_pitch := (p_plan -> 'pitches') -> v_i;
    insert into competition_planning_pitches (planning_revision_id, position, label, is_usable, restriction_notes)
    values (v_new_id, v_i + 1, v_pitch ->> 'label', (v_pitch -> 'usable')::boolean, v_pitch ->> 'restriction_notes')
    returning competition_planning_pitches.planning_pitch_id into v_pitch_id;
    insert into competition_planning_pitch_formats (planning_pitch_id, format_key)
    select distinct v_pitch_id, f.value #>> '{}' from jsonb_array_elements(v_pitch -> 'supported_formats') f;
  end loop;

  v_position := 0;
  for v_date_obj in select d.value from jsonb_array_elements(p_plan -> 'dates') d order by d.value ->> 'date' loop
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

  return query select v_new_id, v_new_number;
end;
$function$;
revoke all on function competition_insert_planning_revision(uuid, text, uuid, uuid, text, jsonb) from public, anon, authenticated;
revoke all on function competition_insert_planning_revision(uuid, text, uuid, uuid, text, jsonb) from service_role;

-- 3/7  The DRAFT save, replaced in place so that it DELEGATES. Everything before the validation is exactly what it was (lock, exact null-safe ownership, the
-- host-revocation guard, the DRAFT state, the format's registry rule, the save identifier), and so is everything after it (the exact replay, the same intent
-- with a different payload, the numbering, the result): only the two blocks that moved now live in the functions above.
create or replace function save_competition_planning_revision_atomically(
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
  v_norm jsonb;

  v_existing_id uuid;
  v_existing_number integer;
  v_existing_digest text;
  v_current_number integer;
  v_new_id uuid;
  v_new_number integer;
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

  if p_intent_id is null then
    raise exception 'PLANNING_INVALID: REQUIRED: a save identifier is required' using errcode = 'P0001';
  end if;

  -- The complete payload is judged here (by the shared validation), whatever the caller already checked.
  v_norm := competition_validate_planning_plan(v_format, p_plan);

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

  select h.planning_revision_id, h.revision_number into v_new_id, v_new_number
    from competition_insert_planning_revision(p_competition_id, v_format, p_organizer_gaming_member_id, p_intent_id, v_digest, v_norm) h;

  return query select v_new_id, v_new_number, false, true;
end;
$function$;

revoke all on function save_competition_planning_revision_atomically(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
grant execute on function save_competition_planning_revision_atomically(uuid, uuid, uuid, jsonb) to service_role;

-- 4/7  The amendment evidence: server-only, append-only, and consistent whatever wrote it.
create table competition_plan_change_proposals (
  plan_amendment_id uuid primary key default gen_random_uuid(),
  competition_id uuid not null,
  registration_freeze_id uuid not null,
  base_planning_revision_id uuid not null,
  sequence_number integer not null,
  proposed_by_gaming_member_id uuid not null references gaming_members (gaming_member_id),
  intent_id uuid not null,
  payload_digest text not null,
  proposed_plan jsonb not null,
  amendment_digest text not null,
  created_at timestamptz not null,
  expires_at timestamptz not null,
  constraint competition_plan_change_proposals_sequence_key unique (competition_id, sequence_number),
  constraint competition_plan_change_proposals_intent_key unique (competition_id, intent_id),
  constraint competition_plan_change_proposals_digest_key unique (competition_id, amendment_digest),
  constraint competition_plan_change_proposals_competition_amendment_key unique (competition_id, plan_amendment_id),
  constraint competition_plan_change_proposals_amendment_digest_key unique (plan_amendment_id, amendment_digest),
  constraint competition_plan_change_proposals_competition_fkey foreign key (competition_id) references competitions (competition_id),
  constraint competition_plan_change_proposals_freeze_fkey foreign key (competition_id, registration_freeze_id) references competition_registration_freezes (competition_id, registration_freeze_id),
  constraint competition_plan_change_proposals_base_fkey foreign key (competition_id, base_planning_revision_id) references competition_planning_revisions (competition_id, planning_revision_id),
  constraint competition_plan_change_proposals_sequence_positive check (sequence_number >= 1),
  constraint competition_plan_change_proposals_lifetime check (expires_at > created_at and expires_at <= created_at + interval '24 hours'),
  constraint competition_plan_change_proposals_digest_shape check (amendment_digest ~ '^[0-9a-f]{64}$' and payload_digest ~ '^[0-9a-f]{64}$'),
  constraint competition_plan_change_proposals_plan_shape check (jsonb_typeof(proposed_plan) = 'object' and not jsonb_exists(proposed_plan, 'format'))
);

create table competition_plan_change_decisions (
  plan_amendment_id uuid not null,
  competition_id uuid not null,
  competition_team_id uuid not null references competition_teams (competition_team_id),
  captain_gaming_member_id uuid not null references gaming_members (gaming_member_id),
  decision text not null,
  amendment_digest text not null,
  decided_at timestamptz not null,
  constraint competition_plan_change_decisions_pkey primary key (plan_amendment_id, competition_team_id),
  constraint competition_plan_change_decisions_captain_key unique (plan_amendment_id, captain_gaming_member_id),
  constraint competition_plan_change_decisions_amendment_fkey foreign key (competition_id, plan_amendment_id) references competition_plan_change_proposals (competition_id, plan_amendment_id),
  constraint competition_plan_change_decisions_digest_fkey foreign key (plan_amendment_id, amendment_digest) references competition_plan_change_proposals (plan_amendment_id, amendment_digest),
  constraint competition_plan_change_decisions_decision check (decision in ('CONFIRMED', 'REJECTED'))
);

create table competition_plan_change_resolutions (
  plan_amendment_id uuid primary key,
  competition_id uuid not null,
  outcome text not null,
  resolved_by_gaming_member_id uuid not null references gaming_members (gaming_member_id),
  resolved_at timestamptz not null,
  activated_planning_revision_id uuid,
  superseded_by_plan_amendment_id uuid,
  constraint competition_plan_change_resolutions_activated_key unique (activated_planning_revision_id),
  constraint competition_plan_change_resolutions_amendment_fkey foreign key (competition_id, plan_amendment_id) references competition_plan_change_proposals (competition_id, plan_amendment_id),
  constraint competition_plan_change_resolutions_revision_fkey foreign key (competition_id, activated_planning_revision_id) references competition_planning_revisions (competition_id, planning_revision_id),
  constraint competition_plan_change_resolutions_superseded_by_fkey foreign key (competition_id, superseded_by_plan_amendment_id) references competition_plan_change_proposals (competition_id, plan_amendment_id),
  constraint competition_plan_change_resolutions_outcome check (outcome in ('ACTIVATED', 'REJECTED', 'WITHDRAWN', 'SUPERSEDED')),
  constraint competition_plan_change_resolutions_activated_shape check ((outcome = 'ACTIVATED') = (activated_planning_revision_id is not null)),
  constraint competition_plan_change_resolutions_superseded_shape check (((outcome = 'SUPERSEDED') = (superseded_by_plan_amendment_id is not null)) and (superseded_by_plan_amendment_id is distinct from plan_amendment_id))
);

-- Server-only: no browser role holds any privilege, and not even the server role can read or write a row directly (the operations below do that).
alter table competition_plan_change_proposals enable row level security;
alter table competition_plan_change_decisions enable row level security;
alter table competition_plan_change_resolutions enable row level security;

revoke all on table competition_plan_change_proposals from public, anon, authenticated, service_role;
revoke all on table competition_plan_change_decisions from public, anon, authenticated, service_role;
revoke all on table competition_plan_change_resolutions from public, anon, authenticated, service_role;

-- Append-only: a recorded proposal, decision or resolution never changes, whoever asks.
create function competition_plan_amendment_reject_change()
 returns trigger
 language plpgsql
 set search_path = public, pg_temp
as $function$
begin
  raise exception 'PLAN_AMENDMENT_IMMUTABLE: a recorded plan amendment, decision or resolution cannot be changed or removed' using errcode = 'P0001';
end;
$function$;
revoke all on function competition_plan_amendment_reject_change() from public, anon, authenticated;
revoke all on function competition_plan_amendment_reject_change() from service_role;

create trigger competition_plan_change_proposals_immutable_rows before update or delete on competition_plan_change_proposals
  for each row execute function competition_plan_amendment_reject_change();
create trigger competition_plan_change_decisions_immutable_rows before update or delete on competition_plan_change_decisions
  for each row execute function competition_plan_amendment_reject_change();
create trigger competition_plan_change_resolutions_immutable_rows before update or delete on competition_plan_change_resolutions
  for each row execute function competition_plan_amendment_reject_change();

create trigger competition_plan_change_proposals_immutable_truncate before truncate on competition_plan_change_proposals
  for each statement execute function competition_plan_amendment_reject_change();
create trigger competition_plan_change_decisions_immutable_truncate before truncate on competition_plan_change_decisions
  for each statement execute function competition_plan_amendment_reject_change();
create trigger competition_plan_change_resolutions_immutable_truncate before truncate on competition_plan_change_resolutions
  for each statement execute function competition_plan_amendment_reject_change();

-- 5/7  Internal helpers. Nobody can call them directly.
--
-- The digest binds one confirmation to one exact proposal. Canonical text (version 1), lines joined by a newline with none at the end: the version line, the
-- competition, the registration freeze's own digest, the base revision, the proposal's sequence number, the format, then every PRESERVED fact (roster bounds,
-- the deadline's exact instant, local text and offset, the rules version and the SHA-256 of the rules snapshot, the venue time zone) and every AMENDABLE fact:
-- the venue's name, location and restriction notes (each as its SHA-256, so no text can move a line), the capacity, one line per pitch in position order
-- (label and notes as SHA-256, usability, the supported formats sorted bytewise) and one line per date in ascending order with its windows in ascending order.
-- Dates, windows and supported formats are unordered facts, so their input order never matters; the pitch order is part of the content.
create function competition_plan_amendment_digest(p_competition_id uuid, p_freeze_digest text, p_base_revision_id uuid, p_sequence integer, p_format text, p_plan jsonb)
 returns text
 language plpgsql
 stable
 set search_path = public, pg_temp
as $function$
declare
  v_text text;
  v_pitch record;
  v_date record;
begin
  v_text := 'URBANO-PLAN-AMENDMENT-V1'
    || E'\ncompetition:' || p_competition_id::text
    || E'\nfreeze:' || p_freeze_digest
    || E'\nbase:' || p_base_revision_id::text
    || E'\nsequence:' || p_sequence::text
    || E'\nformat:' || p_format
    || E'\nroster:' || (p_plan #>> '{roster,minimum}') || '-' || (p_plan #>> '{roster,maximum}')
    || E'\ndeadline:' || (p_plan #>> '{registration_deadline,utc}')
    || E'\ndeadline-local:' || (p_plan #>> '{registration_deadline,local}')
    || E'\ndeadline-offset:' || (p_plan #>> '{registration_deadline,utc_offset_minutes}')
    || E'\nrules-version:' || (p_plan #>> '{rules,version}')
    || E'\nrules:' || encode(sha256(convert_to(p_plan #>> '{rules,snapshot}', 'UTF8')), 'hex')
    || E'\ntimezone:' || (p_plan #>> '{venue,time_zone}')
    || E'\nvenue-name:' || encode(sha256(convert_to(p_plan #>> '{venue,name}', 'UTF8')), 'hex')
    || E'\nvenue-location:' || encode(sha256(convert_to(p_plan #>> '{venue,location_description}', 'UTF8')), 'hex')
    || E'\nvenue-notes:' || encode(sha256(convert_to(coalesce(p_plan #>> '{venue,restriction_notes}', ''), 'UTF8')), 'hex')
    || E'\ncapacity:' || (p_plan #>> '{venue,simultaneous_match_capacity}');
  for v_pitch in
    select e.value as pitch, e.ordinality as ord
      from jsonb_array_elements(p_plan -> 'pitches') with ordinality as e(value, ordinality)
     order by e.ordinality
  loop
    v_text := v_text
      || E'\npitch:' || v_pitch.ord::text
      || '|label:' || encode(sha256(convert_to(v_pitch.pitch ->> 'label', 'UTF8')), 'hex')
      || '|usable:' || (v_pitch.pitch ->> 'usable')
      || '|notes:' || encode(sha256(convert_to(coalesce(v_pitch.pitch ->> 'restriction_notes', ''), 'UTF8')), 'hex')
      || '|formats:' || coalesce((select string_agg(s.k, ',' order by s.k collate "C")
                                    from (select distinct x.value #>> '{}' as k from jsonb_array_elements(v_pitch.pitch -> 'supported_formats') x) s), '');
  end loop;
  for v_date in
    select e.value as day from jsonb_array_elements(p_plan -> 'dates') e order by (e.value ->> 'date') collate "C"
  loop
    v_text := v_text
      || E'\ndate:' || (v_date.day ->> 'date')
      || '|windows:' || coalesce((select string_agg((w.value ->> 'start') || '-' || (w.value ->> 'end'), ',' order by (w.value ->> 'start') collate "C", (w.value ->> 'end') collate "C")
                                    from jsonb_array_elements(v_date.day -> 'windows') w), '');
  end loop;
  if v_text is null then
    raise exception 'PLAN_AMENDMENT_INVALID: INCOMPLETE: the proposal is missing a fact the digest needs' using errcode = 'P0001';
  end if;
  return encode(sha256(convert_to(v_text, 'UTF8')), 'hex');
end;
$function$;
revoke all on function competition_plan_amendment_digest(uuid, text, uuid, integer, text, jsonb) from public, anon, authenticated;
revoke all on function competition_plan_amendment_digest(uuid, text, uuid, integer, text, jsonb) from service_role;

-- The instant the earliest operating window of a (validated) plan opens: each window start is a wall-clock time in the venue's own zone, and the validation has
-- already refused every one a clock change skips or repeats, so the instant is exact.
create function competition_plan_amendment_first_window(p_plan jsonb)
 returns timestamptz
 language sql
 stable
 set search_path = public, pg_temp
as $function$
  select min((((d.value ->> 'date') || ' ' || (w.value ->> 'start'))::timestamp) at time zone (p_plan #>> '{venue,time_zone}'))
    from jsonb_array_elements(p_plan -> 'dates') d
    cross join lateral jsonb_array_elements(d.value -> 'windows') w
$function$;
revoke all on function competition_plan_amendment_first_window(jsonb) from public, anon, authenticated;
revoke all on function competition_plan_amendment_first_window(jsonb) from service_role;

-- The current (highest-numbered) planning revision of one competition, as a plan in exactly the shape the validation accepts and returns.
create function competition_plan_amendment_current_plan(p_competition_id uuid)
 returns table(planning_revision_id uuid, format_key text, plan jsonb)
 language plpgsql
 set search_path = public, pg_temp
as $function$
#variable_conflict use_column
begin
  return query
  select r.planning_revision_id, r.format_key,
    jsonb_build_object(
      'venue', jsonb_build_object('name', r.venue_name, 'location_description', r.venue_location_description, 'time_zone', r.venue_time_zone,
                                  'simultaneous_match_capacity', r.simultaneous_match_capacity, 'restriction_notes', r.venue_restriction_notes),
      'pitches', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'label', p.label, 'usable', p.is_usable,
                 'supported_formats', coalesce((select jsonb_agg(f.format_key order by f.format_key collate "C") from competition_planning_pitch_formats f where f.planning_pitch_id = p.planning_pitch_id), '[]'::jsonb),
                 'restriction_notes', p.restriction_notes) order by p.position)
          from competition_planning_pitches p where p.planning_revision_id = r.planning_revision_id), '[]'::jsonb),
      'dates', coalesce((
        select jsonb_agg(jsonb_build_object(
                 'date', to_char(d.plan_date, 'YYYY-MM-DD'),
                 'windows', coalesce((select jsonb_agg(jsonb_build_object('start', to_char(w.start_time, 'HH24:MI'), 'end', to_char(w.end_time, 'HH24:MI')) order by w.window_index)
                                        from competition_planning_windows w where w.planning_revision_id = d.planning_revision_id and w.plan_date = d.plan_date), '[]'::jsonb)) order by d.position)
          from competition_planning_dates d where d.planning_revision_id = r.planning_revision_id), '[]'::jsonb),
      'roster', jsonb_build_object('minimum', r.roster_minimum, 'maximum', r.roster_maximum),
      'registration_deadline', jsonb_build_object(
        'local', to_char(r.registration_deadline_local, 'YYYY-MM-DD"T"HH24:MI'), 'time_zone', r.registration_deadline_time_zone,
        'utc_offset_minutes', r.registration_deadline_utc_offset_minutes,
        'utc', to_char(r.registration_deadline_utc at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')),
      'rules', jsonb_build_object('version', r.rules_version, 'snapshot', r.rules_snapshot))
    from competition_planning_revisions r
   where r.competition_id = p_competition_id
   order by r.revision_number desc
   limit 1;
end;
$function$;
revoke all on function competition_plan_amendment_current_plan(uuid) from public, anon, authenticated;
revoke all on function competition_plan_amendment_current_plan(uuid) from service_role;

-- The amendable facts of a plan (what a proposal may carry and what a person is shown), nothing else.
create function competition_plan_amendment_facts(p_plan jsonb)
 returns jsonb
 language sql
 immutable
 set search_path = public, pg_temp
as $function$
  select jsonb_build_object(
    'venue', jsonb_build_object(
      'name', p_plan #>> '{venue,name}', 'location_description', p_plan #>> '{venue,location_description}',
      'restriction_notes', p_plan #>> '{venue,restriction_notes}', 'simultaneous_match_capacity', (p_plan #>> '{venue,simultaneous_match_capacity}')::integer),
    'pitches', p_plan -> 'pitches',
    'dates', p_plan -> 'dates')
$function$;
revoke all on function competition_plan_amendment_facts(jsonb) from public, anon, authenticated;
revoke all on function competition_plan_amendment_facts(jsonb) from service_role;

-- A proposal's status is DERIVED: its resolution when there is one, else EXPIRED by the clock alone (the instant of expiry is already expired), else PENDING.
create function competition_plan_amendment_status_of(p_plan_amendment_id uuid, p_now timestamptz)
 returns text
 language sql
 volatile
 set search_path = public, pg_temp
as $function$
  select coalesce(r.outcome, case when p_now >= a.expires_at then 'EXPIRED' else 'PENDING' end)
    from competition_plan_change_proposals a
    left join competition_plan_change_resolutions r on r.plan_amendment_id = a.plan_amendment_id
   where a.plan_amendment_id = p_plan_amendment_id
$function$;
revoke all on function competition_plan_amendment_status_of(uuid, timestamptz) from public, anon, authenticated;
revoke all on function competition_plan_amendment_status_of(uuid, timestamptz) from service_role;

-- Whether the frozen snapshot is consistent, in both directions: the frozen evidence rows (the four teams, their captains and every member) reproduce the
-- digest the freeze recorded, and so do the live competition's four accepted teams, their captains and every membership, hashed exactly as the freeze hashed
-- them. A competition with no freeze is not consistent. (No public path changes a captain or a membership after the freeze, and the evidence is append-only;
-- this is the check that proves both every time authority depends on the snapshot.)
create function competition_registration_freeze_consistent(p_competition_id uuid)
 returns boolean
 language plpgsql
 set search_path = public, pg_temp
as $function$
declare
  v_freeze competition_registration_freezes%rowtype;
  v_teams jsonb;
begin
  select * into v_freeze from competition_registration_freezes f where f.competition_id = p_competition_id;
  if not found then
    return false;
  end if;
  -- The frozen evidence itself.
  select jsonb_agg(jsonb_build_object(
           'team', ft.competition_team_id, 'captain', ft.captain_gaming_member_id,
           'members', coalesce((select jsonb_agg(fm.gaming_member_id order by fm.gaming_member_id::text collate "C")
                                  from competition_registration_freeze_members fm
                                 where fm.registration_freeze_id = ft.registration_freeze_id and fm.competition_team_id = ft.competition_team_id), '[]'::jsonb))
           order by ft.competition_team_id::text collate "C")
    into v_teams
    from competition_registration_freeze_teams ft
   where ft.registration_freeze_id = v_freeze.registration_freeze_id;
  if v_teams is null
     or competition_registration_freeze_digest(v_freeze.competition_id, v_freeze.planning_revision_id, v_freeze.format_key, v_freeze.roster_minimum,
                                               v_freeze.roster_maximum, v_freeze.registration_deadline_utc, v_teams) is distinct from v_freeze.snapshot_digest then
    return false;
  end if;
  -- The live competition.
  select jsonb_agg(jsonb_build_object(
           'team', teams.competition_team_id, 'captain', teams.captain_gaming_member_id,
           'members', coalesce((select jsonb_agg(m.gaming_member_id order by m.gaming_member_id::text collate "C")
                                  from competition_team_memberships m where m.competition_team_id = teams.competition_team_id), '[]'::jsonb))
           order by teams.competition_team_id::text collate "C")
    into v_teams
    from competition_teams teams
   where teams.competition_id = p_competition_id and teams.status = 'ACCEPTED';
  if v_teams is null then
    return false;
  end if;
  return competition_registration_freeze_digest(v_freeze.competition_id, v_freeze.planning_revision_id, v_freeze.format_key, v_freeze.roster_minimum,
                                                v_freeze.roster_maximum, v_freeze.registration_deadline_utc, v_teams) is not distinct from v_freeze.snapshot_digest;
end;
$function$;
revoke all on function competition_registration_freeze_consistent(uuid) from public, anon, authenticated;
revoke all on function competition_registration_freeze_consistent(uuid) from service_role;

-- The amendment window. Open only while: the state is exactly READY_TO_PUBLISH and nothing has been published; the registration freeze exists; no fixture of any
-- kind exists; a planning revision exists and still carries what the freeze recorded (format, roster bounds, deadline); and the frozen snapshot is consistent.
-- null means open; otherwise the reason: WINDOW_CLOSED, or FREEZE_INCONSISTENT when the snapshot (or the plan beside it) no longer matches what was frozen.
create function competition_plan_amendment_window_problem(p_competition_id uuid)
 returns text
 language plpgsql
 set search_path = public, pg_temp
as $function$
declare
  v_state text;
  v_published_at timestamptz;
  v_freeze competition_registration_freezes%rowtype;
  v_current record;
begin
  select c.state, c.published_at into v_state, v_published_at from competitions c where c.competition_id = p_competition_id;
  if not found or v_state is distinct from 'READY_TO_PUBLISH' or v_published_at is not null then
    return 'WINDOW_CLOSED';
  end if;
  select * into v_freeze from competition_registration_freezes f where f.competition_id = p_competition_id;
  if not found then
    return 'WINDOW_CLOSED';
  end if;
  if exists (select 1 from competition_fixtures x where x.competition_id = p_competition_id) then
    return 'WINDOW_CLOSED';
  end if;
  select cur.* into v_current from competition_current_registration_plan(p_competition_id) cur;
  if v_current.planning_revision_id is null then
    return 'WINDOW_CLOSED';
  end if;
  if v_current.format_key is distinct from v_freeze.format_key or v_current.roster_minimum is distinct from v_freeze.roster_minimum
     or v_current.roster_maximum is distinct from v_freeze.roster_maximum or v_current.registration_deadline_utc is distinct from v_freeze.registration_deadline_utc
     or not competition_registration_freeze_consistent(p_competition_id) then
    return 'FREEZE_INCONSISTENT';
  end if;
  return null;
end;
$function$;
revoke all on function competition_plan_amendment_window_problem(uuid) from public, anon, authenticated;
revoke all on function competition_plan_amendment_window_problem(uuid) from service_role;

-- The window as a guard: raises with the reason, otherwise returns the competition's registration freeze. The caller already holds the competition's lock.
create function competition_assert_plan_amendment_window(p_competition_id uuid)
 returns uuid
 language plpgsql
 set search_path = public, pg_temp
as $function$
declare
  v_problem text := competition_plan_amendment_window_problem(p_competition_id);
  v_freeze_id uuid;
begin
  if v_problem = 'WINDOW_CLOSED' then
    raise exception 'PLAN_AMENDMENT_WINDOW_CLOSED: the plan can only be amended while the competition is ready to publish with nothing yet drawn, scheduled or played' using errcode = 'P0001';
  elsif v_problem = 'FREEZE_INCONSISTENT' then
    raise exception 'PLAN_AMENDMENT_FREEZE_INCONSISTENT: the frozen registration no longer matches this competition, so the plan cannot be amended' using errcode = 'P0001';
  end if;
  select f.registration_freeze_id into v_freeze_id from competition_registration_freezes f where f.competition_id = p_competition_id;
  return v_freeze_id;
end;
$function$;
revoke all on function competition_assert_plan_amendment_window(uuid) from public, anon, authenticated;
revoke all on function competition_assert_plan_amendment_window(uuid) from service_role;

-- 6/7  The evidence is consistent whatever wrote it.
-- A decision is a real, current fact of THIS proposal: the captain and team come from the proposal's own frozen snapshot, the digest is the proposal's, nothing
-- has resolved the proposal, and the instant lies inside its lifetime.
create function competition_plan_amendment_check_decision()
 returns trigger
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
declare
  v_a competition_plan_change_proposals%rowtype;
begin
  select * into v_a from competition_plan_change_proposals a where a.plan_amendment_id = new.plan_amendment_id;
  if not found or v_a.competition_id <> new.competition_id or v_a.amendment_digest <> new.amendment_digest then
    raise exception 'PLAN_AMENDMENT_INVALID: a decision must name its own proposal and digest' using errcode = 'P0001';
  end if;
  if not exists (
    select 1 from competition_registration_freeze_teams ft
     where ft.registration_freeze_id = v_a.registration_freeze_id and ft.competition_team_id = new.competition_team_id
       and ft.captain_gaming_member_id = new.captain_gaming_member_id
  ) then
    raise exception 'PLAN_AMENDMENT_INVALID: only the frozen captain of a frozen team can decide' using errcode = 'P0001';
  end if;
  if exists (select 1 from competition_plan_change_resolutions r where r.plan_amendment_id = new.plan_amendment_id) then
    raise exception 'PLAN_AMENDMENT_INVALID: a resolved proposal can receive no decision' using errcode = 'P0001';
  end if;
  if new.decided_at < v_a.created_at or new.decided_at >= v_a.expires_at then
    raise exception 'PLAN_AMENDMENT_INVALID: a decision must fall inside the proposal''s lifetime' using errcode = 'P0001';
  end if;
  return new;
end;
$function$;
revoke all on function competition_plan_amendment_check_decision() from public, anon, authenticated;
revoke all on function competition_plan_amendment_check_decision() from service_role;

create trigger competition_plan_change_decisions_check before insert on competition_plan_change_decisions
  for each row execute function competition_plan_amendment_check_decision();

-- At commit a resolution must be exactly what its outcome says: ACTIVATED needs the four distinct frozen captains' confirmations (and no rejection), inside the
-- lifetime, and the revision that supersedes the proposal's base; REJECTED needs a rejection by the resolver; WITHDRAWN is the proposing organizer's own act;
-- SUPERSEDED needs a newer proposal by the same organizer recorded at the same instant. Only a proposal that was still effective can be resolved.
create function competition_plan_amendment_verify_resolution()
 returns trigger
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
declare
  v_a competition_plan_change_proposals%rowtype;
  v_confirmed integer;
  v_rejected integer;
begin
  select * into v_a from competition_plan_change_proposals a where a.plan_amendment_id = new.plan_amendment_id;
  if not found or v_a.competition_id <> new.competition_id or new.resolved_at < v_a.created_at or new.resolved_at >= v_a.expires_at then
    raise exception 'PLAN_AMENDMENT_INVALID: a resolution must belong to its proposal and fall inside its lifetime' using errcode = 'P0001';
  end if;
  select count(*) filter (where d.decision = 'CONFIRMED'), count(*) filter (where d.decision = 'REJECTED')
    into v_confirmed, v_rejected
    from competition_plan_change_decisions d where d.plan_amendment_id = new.plan_amendment_id;
  if new.outcome = 'ACTIVATED' then
    if v_confirmed <> 4 or v_rejected <> 0 or not exists (
      select 1 from competition_planning_revisions r
       where r.planning_revision_id = new.activated_planning_revision_id and r.competition_id = new.competition_id
         and r.supersedes_revision_id = v_a.base_planning_revision_id and r.intent_id = new.plan_amendment_id
    ) then
      raise exception 'PLAN_AMENDMENT_INVALID: an activation needs four confirmations, no rejection and the revision that follows the proposal''s base' using errcode = 'P0001';
    end if;
  elsif new.outcome = 'REJECTED' then
    if not exists (select 1 from competition_plan_change_decisions d where d.plan_amendment_id = new.plan_amendment_id and d.decision = 'REJECTED' and d.captain_gaming_member_id = new.resolved_by_gaming_member_id) then
      raise exception 'PLAN_AMENDMENT_INVALID: a rejection needs the rejecting captain''s decision' using errcode = 'P0001';
    end if;
  elsif new.outcome = 'WITHDRAWN' then
    if new.resolved_by_gaming_member_id <> v_a.proposed_by_gaming_member_id then
      raise exception 'PLAN_AMENDMENT_INVALID: only the proposing organizer can withdraw a proposal' using errcode = 'P0001';
    end if;
  elsif new.outcome = 'SUPERSEDED' then
    if not exists (
      select 1 from competition_plan_change_proposals n
       where n.plan_amendment_id = new.superseded_by_plan_amendment_id and n.competition_id = new.competition_id and n.sequence_number > v_a.sequence_number
         and n.proposed_by_gaming_member_id = new.resolved_by_gaming_member_id and n.created_at = new.resolved_at
    ) then
      raise exception 'PLAN_AMENDMENT_INVALID: a superseded proposal needs a newer proposal by the same organizer' using errcode = 'P0001';
    end if;
  end if;
  return null;
end;
$function$;
revoke all on function competition_plan_amendment_verify_resolution() from public, anon, authenticated;
revoke all on function competition_plan_amendment_verify_resolution() from service_role;

create constraint trigger competition_plan_change_resolutions_verify after insert on competition_plan_change_resolutions
  deferrable initially deferred
  for each row execute function competition_plan_amendment_verify_resolution();

-- At commit a proposal must be consistent: its digest recomputes from the plan it stores, its freeze is the competition's own, and at most one earlier proposal
-- is still effective (unresolved and unexpired at the moment this one was recorded).
create function competition_plan_amendment_verify_proposal()
 returns trigger
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
declare
  v_freeze_digest text;
  v_format text;
begin
  select f.snapshot_digest, f.format_key into v_freeze_digest, v_format
    from competition_registration_freezes f
   where f.competition_id = new.competition_id and f.registration_freeze_id = new.registration_freeze_id;
  if v_freeze_digest is null
     or competition_plan_amendment_digest(new.competition_id, v_freeze_digest, new.base_planning_revision_id, new.sequence_number, v_format, new.proposed_plan)
        is distinct from new.amendment_digest then
    raise exception 'PLAN_AMENDMENT_INVALID: the proposal''s digest does not match its content' using errcode = 'P0001';
  end if;
  if exists (
    select 1 from competition_plan_change_proposals o
     where o.competition_id = new.competition_id and o.plan_amendment_id <> new.plan_amendment_id and o.sequence_number < new.sequence_number
       and o.expires_at > new.created_at
       and not exists (select 1 from competition_plan_change_resolutions r where r.plan_amendment_id = o.plan_amendment_id)
  ) then
    raise exception 'PLAN_AMENDMENT_INVALID: only one proposal can be effective at a time' using errcode = 'P0001';
  end if;
  return null;
end;
$function$;
revoke all on function competition_plan_amendment_verify_proposal() from public, anon, authenticated;
revoke all on function competition_plan_amendment_verify_proposal() from service_role;

create constraint trigger competition_plan_change_proposals_verify after insert on competition_plan_change_proposals
  deferrable initially deferred
  for each row execute function competition_plan_amendment_verify_proposal();

-- The answer to a decision, one shape for a first decision and for an exact retry: the captain's decision, the proposal's derived status, how many frozen
-- captains have confirmed (of the four required) and, once activated, the number of the revision it created.
create function competition_plan_amendment_decision_result(p_plan_amendment_id uuid, p_decision text, p_already_decided boolean, p_now timestamptz)
 returns jsonb
 language sql
 volatile
 set search_path = public, pg_temp
as $function$
  select jsonb_build_object(
    'decision', p_decision,
    'status', competition_plan_amendment_status_of(p_plan_amendment_id, p_now),
    'confirmed_count', (select count(*)::integer from competition_plan_change_decisions d where d.plan_amendment_id = p_plan_amendment_id and d.decision = 'CONFIRMED'),
    'required_count', 4,
    'already_decided', p_already_decided,
    'activated_revision_number', (select rev.revision_number from competition_plan_change_resolutions r
                                    join competition_planning_revisions rev on rev.planning_revision_id = r.activated_planning_revision_id
                                   where r.plan_amendment_id = p_plan_amendment_id))
$function$;
revoke all on function competition_plan_amendment_decision_result(uuid, text, boolean, timestamptz) from public, anon, authenticated;
revoke all on function competition_plan_amendment_decision_result(uuid, text, boolean, timestamptz) from service_role;

-- 7/7  The four service-role-only operations.
--
-- PROPOSE (organizer only). The caller supplies ONLY the amendable sections; the venue's time zone, the roster bounds, the registration deadline, the rules and
-- the format are composed here from the current revision and the competition itself, so they cannot be named, changed or smuggled in. The complete resulting
-- plan is judged by the same validation the DRAFT save uses. A proposal is refused when its earliest window is 12 hours or less away by the database clock, and it
-- lives until the earlier of 24 hours after it is recorded or 12 hours before that window. A new valid proposal supersedes the one still effective, atomically.
-- Order: lock, ownership, host standing, then an exact retry of a recorded save identifier (answered from the record, whatever the lifecycle), then the window.
create function propose_competition_plan_amendment_atomically(
  p_competition_id uuid,
  p_organizer_gaming_member_id uuid,
  p_intent_id uuid,
  p_amendment jsonb
)
 returns jsonb
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
#variable_conflict use_column
declare
  v_organizer_id uuid;
  v_format text;
  v_freeze_id uuid;
  v_freeze_digest text;
  v_key text;
  v_venue jsonb;

  v_existing competition_plan_change_proposals%rowtype;
  v_existing_superseded text;
  v_base_id uuid;
  v_base_format text;
  v_base_plan jsonb;
  v_plan jsonb;
  v_norm jsonb;
  v_now timestamptz;
  v_first timestamptz;
  v_expires timestamptz;
  v_sequence integer;
  v_prev competition_plan_change_proposals%rowtype;
  v_new_id uuid := gen_random_uuid();
  v_digest text;
  v_payload_digest text;
begin
  -- Lock the competition (the same scope every organizer operation uses), then read it.
  perform pg_advisory_xact_lock(hashtext('competition_scope:' || p_competition_id::text));

  select competitions.organizer_gaming_member_id, competitions.activity_key
    into v_organizer_id, v_format
    from competitions
   where competitions.competition_id = p_competition_id
   for update;

  if v_organizer_id is null then
    raise exception 'COMPETITION_NOT_FOUND: no such competition exists' using errcode = 'P0001';
  end if;

  -- Exact, null-safe ownership: a missing caller is refused, never skipped.
  if p_organizer_gaming_member_id is distinct from v_organizer_id then
    raise exception 'COMPETITION_ACCESS_DENIED: only this competition''s own organizer may propose a plan change'
      using errcode = 'P0001';
  end if;
  perform assert_competition_not_host_revoked(p_competition_id);

  if p_intent_id is null then
    raise exception 'PLAN_AMENDMENT_INVALID: REQUIRED: a save identifier is required' using errcode = 'P0001';
  end if;
  if p_amendment is null or jsonb_typeof(p_amendment) <> 'object' then
    raise exception 'PLAN_AMENDMENT_INVALID: AMENDMENT_NOT_OBJECT: the amendment must be an object' using errcode = 'P0001';
  end if;

  -- An exact retry is answered from the record, after the caller's identity and the host's standing (judged above) and BEFORE the lifecycle window: what was
  -- recorded stays replayable after the competition has moved on (published, cancelled), and a replay writes nothing. The same save identifier with anything
  -- different is refused, whatever the lifecycle says. Anything that is not an exact retry still needs the window.
  v_payload_digest := encode(sha256(convert_to(p_amendment::text, 'UTF8')), 'hex');
  select * into v_existing from competition_plan_change_proposals a where a.competition_id = p_competition_id and a.intent_id = p_intent_id;
  if found then
    if v_existing.payload_digest <> v_payload_digest then
      raise exception 'PLAN_AMENDMENT_INTENT_MISMATCH: this save identifier was already used for a different proposal' using errcode = 'P0001';
    end if;
    select s.amendment_digest into v_existing_superseded
      from competition_plan_change_resolutions r
      join competition_plan_change_proposals s on s.plan_amendment_id = r.plan_amendment_id
     where r.superseded_by_plan_amendment_id = v_existing.plan_amendment_id;
    return jsonb_build_object('amendment_digest', v_existing.amendment_digest, 'sequence_number', v_existing.sequence_number,
                              'created_at', v_existing.created_at, 'expires_at', v_existing.expires_at, 'already_proposed', true, 'superseded_digest', v_existing_superseded);
  end if;

  v_freeze_id := competition_assert_plan_amendment_window(p_competition_id);

  -- Only the venue's description, the pitches and the dates can be proposed. A preserved or system fact is refused BY NAME, at any level; anything else unknown too.
  for v_key in select jsonb_object_keys(p_amendment) loop
    if v_key = any (array['time_zone', 'roster', 'registration_deadline', 'rules', 'format', 'format_key', 'activity_key', 'teams', 'captains', 'members', 'competition_id',
                          'state', 'status', 'freeze', 'digest', 'amendment_digest', 'sequence_number', 'expires_at', 'created_at', 'now']) then
      raise exception 'PLAN_AMENDMENT_INVALID: IMMUTABLE_FIELD: % is fixed by the registration freeze and cannot be proposed', v_key using errcode = 'P0001';
    elsif not (v_key = any (array['venue', 'pitches', 'dates'])) then
      raise exception 'PLAN_AMENDMENT_INVALID: UNKNOWN_FIELD: the amendment has a field that is not amendable' using errcode = 'P0001';
    end if;
  end loop;
  v_venue := p_amendment -> 'venue';
  if v_venue is null or jsonb_typeof(v_venue) <> 'object' then
    raise exception 'PLAN_AMENDMENT_INVALID: REQUIRED: the venue is required' using errcode = 'P0001';
  end if;
  for v_key in select jsonb_object_keys(v_venue) loop
    if v_key = 'time_zone' then
      raise exception 'PLAN_AMENDMENT_INVALID: IMMUTABLE_FIELD: time_zone is fixed by the registration freeze and cannot be proposed' using errcode = 'P0001';
    elsif not (v_key = any (array['name', 'location_description', 'restriction_notes', 'simultaneous_match_capacity'])) then
      raise exception 'PLAN_AMENDMENT_INVALID: UNKNOWN_FIELD: the venue has a field that is not amendable' using errcode = 'P0001';
    end if;
  end loop;

  -- The complete resulting plan: the amendable sections from the request, everything else from the current revision.
  select cp.planning_revision_id, cp.format_key, cp.plan into v_base_id, v_base_format, v_base_plan from competition_plan_amendment_current_plan(p_competition_id) cp;
  if v_base_id is null or v_base_format is distinct from v_format then
    raise exception 'PLAN_AMENDMENT_WINDOW_CLOSED: the plan can only be amended while the competition is ready to publish with nothing yet drawn, scheduled or played' using errcode = 'P0001';
  end if;
  v_plan := jsonb_build_object(
    'venue', jsonb_build_object(
      'name', v_venue -> 'name', 'location_description', v_venue -> 'location_description', 'time_zone', v_base_plan #> '{venue,time_zone}',
      'simultaneous_match_capacity', v_venue -> 'simultaneous_match_capacity', 'restriction_notes', v_venue -> 'restriction_notes'),
    'pitches', p_amendment -> 'pitches',
    'dates', p_amendment -> 'dates',
    'roster', v_base_plan -> 'roster',
    'registration_deadline', v_base_plan -> 'registration_deadline',
    'rules', v_base_plan -> 'rules');
  v_norm := competition_validate_planning_plan(v_format, v_plan);

  -- Defence in depth: whatever the validation normalized, no preserved fact differs from the current revision's.
  if (v_norm -> 'roster') is distinct from (v_base_plan -> 'roster')
     or (v_norm -> 'registration_deadline') is distinct from (v_base_plan -> 'registration_deadline')
     or (v_norm -> 'rules') is distinct from (v_base_plan -> 'rules')
     or (v_norm #>> '{venue,time_zone}') is distinct from (v_base_plan #>> '{venue,time_zone}') then
    raise exception 'PLAN_AMENDMENT_INVALID: IMMUTABLE_FIELD: a preserved fact did not survive validation unchanged' using errcode = 'P0001';
  end if;

  -- The lead time and the lifetime, by the one database clock taken after the lock. Exactly 12 hours away fails closed.
  v_now := competition_registration_clock();
  v_first := competition_plan_amendment_first_window(v_norm);
  if v_first - interval '12 hours' <= v_now then
    raise exception 'PLAN_AMENDMENT_LEAD_TIME: the earliest window must be more than 12 hours away' using errcode = 'P0001';
  end if;
  v_expires := least(v_now + interval '24 hours', v_first - interval '12 hours');

  -- The proposal still effective (unresolved and unexpired), if any, is superseded by this one.
  select * into v_prev
    from competition_plan_change_proposals a
   where a.competition_id = p_competition_id and a.expires_at > v_now
     and not exists (select 1 from competition_plan_change_resolutions r where r.plan_amendment_id = a.plan_amendment_id)
   order by a.sequence_number desc
   limit 1;

  select coalesce(max(a.sequence_number), 0) + 1 into v_sequence from competition_plan_change_proposals a where a.competition_id = p_competition_id;
  select f.snapshot_digest into v_freeze_digest from competition_registration_freezes f where f.registration_freeze_id = v_freeze_id;
  v_digest := competition_plan_amendment_digest(p_competition_id, v_freeze_digest, v_base_id, v_sequence, v_format, v_norm);

  insert into competition_plan_change_proposals (
    plan_amendment_id, competition_id, registration_freeze_id, base_planning_revision_id, sequence_number, proposed_by_gaming_member_id, intent_id,
    payload_digest, proposed_plan, amendment_digest, created_at, expires_at
  ) values (
    v_new_id, p_competition_id, v_freeze_id, v_base_id, v_sequence, p_organizer_gaming_member_id, p_intent_id,
    v_payload_digest, v_norm, v_digest, v_now, v_expires
  );

  if v_prev.plan_amendment_id is not null then
    insert into competition_plan_change_resolutions (plan_amendment_id, competition_id, outcome, resolved_by_gaming_member_id, resolved_at, superseded_by_plan_amendment_id)
    values (v_prev.plan_amendment_id, p_competition_id, 'SUPERSEDED', p_organizer_gaming_member_id, v_now, v_new_id);
  end if;

  return jsonb_build_object('amendment_digest', v_digest, 'sequence_number', v_sequence, 'created_at', v_now, 'expires_at', v_expires,
                            'already_proposed', false, 'superseded_digest', v_prev.amendment_digest);
end;
$function$;

-- DECIDE (a frozen captain only). The captain is identified ONLY by the registration-freeze snapshot: not by the organizer, a member, a registrant, an
-- operational grant or any client claim. Every decision names the proposal's exact digest. The fourth distinct confirmation atomically re-checks the lifecycle,
-- the organizer's binding, the frozen snapshot, the digest and the complete resulting plan, and then creates the next immutable revision.
create function decide_competition_plan_amendment_atomically(
  p_competition_id uuid,
  p_captain_gaming_member_id uuid,
  p_amendment_digest text,
  p_decision text
)
 returns jsonb
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
#variable_conflict use_column
declare
  v_organizer_id uuid;
  v_format text;
  v_team_id uuid;
  v_freeze_id uuid;
  v_a competition_plan_change_proposals%rowtype;
  v_known boolean;
  v_existing text;
  v_resolved boolean;
  v_now timestamptz;
  v_current_base uuid;
  v_confirmed integer;
  v_freeze_digest text;
  v_base_plan jsonb;
  v_norm jsonb;
  v_new_id uuid;
  v_new_number integer;
begin
  if p_decision is null or p_decision not in ('CONFIRMED', 'REJECTED') then
    raise exception 'PLAN_AMENDMENT_INVALID: DECISION_INVALID: a decision is CONFIRMED or REJECTED' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('competition_scope:' || p_competition_id::text));

  select competitions.organizer_gaming_member_id, competitions.activity_key
    into v_organizer_id, v_format
    from competitions
   where competitions.competition_id = p_competition_id
   for update;

  if v_organizer_id is null then
    raise exception 'PLAN_AMENDMENT_NOT_AVAILABLE: there is no plan change here that you can decide' using errcode = 'P0001';
  end if;

  -- The captain: a frozen captain of THIS competition, from the freeze snapshot. A missing caller matches nothing.
  select ft.competition_team_id, ft.registration_freeze_id into v_team_id, v_freeze_id
    from competition_registration_freeze_teams ft
   where ft.competition_id = p_competition_id and ft.captain_gaming_member_id = p_captain_gaming_member_id;
  if not found then
    raise exception 'PLAN_AMENDMENT_NOT_AVAILABLE: there is no plan change here that you can decide' using errcode = 'P0001';
  end if;
  perform assert_competition_not_host_revoked(p_competition_id);

  v_now := competition_registration_clock();

  -- A decision this captain's team already made on this exact proposal is answered from the record, after the captain's identity and the host's standing
  -- (judged above) and BEFORE the lifecycle window: the same decision is an exact retry and writes nothing, and the other one is a conflict, whatever the
  -- lifecycle says. A captain with no recorded answer, or a digest that is not on record, is not a retry and still needs the window.
  select * into v_a from competition_plan_change_proposals a where a.competition_id = p_competition_id and a.amendment_digest = p_amendment_digest;
  v_known := found;
  if v_known then
    select d.decision into v_existing from competition_plan_change_decisions d where d.plan_amendment_id = v_a.plan_amendment_id and d.competition_team_id = v_team_id;
    if found then
      if v_existing <> p_decision then
        raise exception 'PLAN_AMENDMENT_DECISION_CONFLICT: this team has already given a different answer to this plan change' using errcode = 'P0001';
      end if;
      return competition_plan_amendment_decision_result(v_a.plan_amendment_id, p_decision, true, v_now);
    end if;
  end if;

  v_freeze_id := competition_assert_plan_amendment_window(p_competition_id);

  if not v_known then
    raise exception 'PLAN_AMENDMENT_STALE: this plan change is not the one on record' using errcode = 'P0001';
  end if;

  select exists (select 1 from competition_plan_change_resolutions r where r.plan_amendment_id = v_a.plan_amendment_id) into v_resolved;
  if v_resolved then
    raise exception 'PLAN_AMENDMENT_NOT_PENDING: this plan change is no longer pending' using errcode = 'P0001';
  end if;
  if v_now >= v_a.expires_at then
    raise exception 'PLAN_AMENDMENT_EXPIRED: this plan change has expired' using errcode = 'P0001';
  end if;
  select cur.planning_revision_id into v_current_base from competition_current_registration_plan(p_competition_id) cur;
  if v_current_base is distinct from v_a.base_planning_revision_id then
    raise exception 'PLAN_AMENDMENT_STALE: this plan change was made against a plan that is no longer current' using errcode = 'P0001';
  end if;

  insert into competition_plan_change_decisions (plan_amendment_id, competition_id, competition_team_id, captain_gaming_member_id, decision, amendment_digest, decided_at)
  values (v_a.plan_amendment_id, p_competition_id, v_team_id, p_captain_gaming_member_id, p_decision, v_a.amendment_digest, v_now);

  -- One rejection ends the proposal. There is no override.
  if p_decision = 'REJECTED' then
    insert into competition_plan_change_resolutions (plan_amendment_id, competition_id, outcome, resolved_by_gaming_member_id, resolved_at)
    values (v_a.plan_amendment_id, p_competition_id, 'REJECTED', p_captain_gaming_member_id, v_now);
    return competition_plan_amendment_decision_result(v_a.plan_amendment_id, p_decision, false, v_now);
  end if;

  select count(*) into v_confirmed from competition_plan_change_decisions d where d.plan_amendment_id = v_a.plan_amendment_id and d.decision = 'CONFIRMED';
  if v_confirmed < 4 then
    return competition_plan_amendment_decision_result(v_a.plan_amendment_id, p_decision, false, v_now);
  end if;

  -- The fourth distinct frozen captain: activate, or fail as a whole.
  if v_a.proposed_by_gaming_member_id is distinct from v_organizer_id then
    raise exception 'PLAN_AMENDMENT_STALE: the organizer who proposed this plan change no longer organizes this competition' using errcode = 'P0001';
  end if;
  select f.snapshot_digest into v_freeze_digest from competition_registration_freezes f where f.registration_freeze_id = v_a.registration_freeze_id;
  if competition_plan_amendment_digest(p_competition_id, v_freeze_digest, v_a.base_planning_revision_id, v_a.sequence_number, v_format, v_a.proposed_plan)
       is distinct from v_a.amendment_digest then
    raise exception 'PLAN_AMENDMENT_STALE: the stored plan change no longer matches its digest' using errcode = 'P0001';
  end if;
  select cp.plan into v_base_plan from competition_plan_amendment_current_plan(p_competition_id) cp;
  v_norm := competition_validate_planning_plan(v_format, v_a.proposed_plan);
  if v_norm is distinct from v_a.proposed_plan
     or (v_norm -> 'roster') is distinct from (v_base_plan -> 'roster')
     or (v_norm -> 'registration_deadline') is distinct from (v_base_plan -> 'registration_deadline')
     or (v_norm -> 'rules') is distinct from (v_base_plan -> 'rules')
     or (v_norm #>> '{venue,time_zone}') is distinct from (v_base_plan #>> '{venue,time_zone}') then
    raise exception 'PLAN_AMENDMENT_STALE: the stored plan change no longer passes the planning rules' using errcode = 'P0001';
  end if;

  select h.planning_revision_id, h.revision_number into v_new_id, v_new_number
    from competition_insert_planning_revision(p_competition_id, v_format, v_a.proposed_by_gaming_member_id, v_a.plan_amendment_id,
                                              encode(sha256(convert_to(v_a.proposed_plan::text, 'UTF8')), 'hex'), v_norm) h;

  insert into competition_plan_change_resolutions (plan_amendment_id, competition_id, outcome, resolved_by_gaming_member_id, resolved_at, activated_planning_revision_id)
  values (v_a.plan_amendment_id, p_competition_id, 'ACTIVATED', p_captain_gaming_member_id, v_now, v_new_id);

  return competition_plan_amendment_decision_result(v_a.plan_amendment_id, p_decision, false, v_now);
end;
$function$;

-- WITHDRAW (organizer only). Only a proposal that is still pending: not resolved, not expired. An exact retry of a withdrawal is idempotent, and is answered from
-- the record (after ownership and host standing, before the lifecycle window).
create function withdraw_competition_plan_amendment_atomically(
  p_competition_id uuid,
  p_organizer_gaming_member_id uuid,
  p_amendment_digest text
)
 returns jsonb
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
#variable_conflict use_column
declare
  v_organizer_id uuid;
  v_a competition_plan_change_proposals%rowtype;
  v_known boolean;
  v_outcome text;
  v_now timestamptz;
begin
  perform pg_advisory_xact_lock(hashtext('competition_scope:' || p_competition_id::text));

  select competitions.organizer_gaming_member_id
    into v_organizer_id
    from competitions
   where competitions.competition_id = p_competition_id
   for update;

  if v_organizer_id is null then
    raise exception 'COMPETITION_NOT_FOUND: no such competition exists' using errcode = 'P0001';
  end if;

  if p_organizer_gaming_member_id is distinct from v_organizer_id then
    raise exception 'COMPETITION_ACCESS_DENIED: only this competition''s own organizer may withdraw a plan change'
      using errcode = 'P0001';
  end if;
  perform assert_competition_not_host_revoked(p_competition_id);

  -- A withdrawal already recorded for this exact digest is answered from the record, after the organizer's ownership and standing (judged above) and BEFORE
  -- the lifecycle window, and writes nothing. Every other withdrawal — a pending, resolved or unknown proposal — is not a retry and still needs the window.
  select * into v_a from competition_plan_change_proposals a where a.competition_id = p_competition_id and a.amendment_digest = p_amendment_digest;
  v_known := found;
  if v_known then
    select r.outcome into v_outcome from competition_plan_change_resolutions r where r.plan_amendment_id = v_a.plan_amendment_id;
    if v_outcome = 'WITHDRAWN' then
      return jsonb_build_object('status', 'WITHDRAWN', 'already_withdrawn', true);
    end if;
  end if;

  perform competition_assert_plan_amendment_window(p_competition_id);

  if not v_known then
    raise exception 'PLAN_AMENDMENT_STALE: this plan change is not the one on record' using errcode = 'P0001';
  end if;
  if v_outcome is not null then
    raise exception 'PLAN_AMENDMENT_NOT_PENDING: this plan change is no longer pending' using errcode = 'P0001';
  end if;

  v_now := competition_registration_clock();
  if v_now >= v_a.expires_at then
    raise exception 'PLAN_AMENDMENT_EXPIRED: this plan change has expired' using errcode = 'P0001';
  end if;

  insert into competition_plan_change_resolutions (plan_amendment_id, competition_id, outcome, resolved_by_gaming_member_id, resolved_at)
  values (v_a.plan_amendment_id, p_competition_id, 'WITHDRAWN', p_organizer_gaming_member_id, v_now);

  return jsonb_build_object('status', 'WITHDRAWN', 'already_withdrawn', false);
end;
$function$;

-- STATUS (bounded read). Only the active, non-revoked organizer and the four frozen captains get an answer; every other caller — including a missing one — gets
-- SQL NULL, the same as for a competition that does not exist. No identifier of a team, member, proposal or revision is returned. The proposal shown is the
-- latest one; the organizer alone also gets the (bounded) history.
create function get_competition_plan_amendment_status(p_competition_id uuid, p_caller_gaming_member_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
#variable_conflict use_column
declare
  v_organizer_id uuid;
  v_revoked boolean;
  v_is_organizer boolean;
  v_is_captain boolean;
  v_team_id uuid;
  v_now timestamptz;
  v_window_open boolean;
  v_my_team_name text;
  v_a competition_plan_change_proposals%rowtype;
  v_status text;
  v_resolved_at timestamptz;
  v_confirmed integer;
  v_my_decision text;
  v_teams jsonb;
  v_current_plan jsonb;
  v_amendment jsonb := null;
  v_history jsonb := null;
begin
  select competitions.organizer_gaming_member_id into v_organizer_id from competitions where competitions.competition_id = p_competition_id;
  if v_organizer_id is null then
    return null;
  end if;
  v_revoked := exists (select 1 from competition_host_capabilities h where h.competition_id = p_competition_id and h.state = 'REVOKED');
  v_is_organizer := p_caller_gaming_member_id is not null and p_caller_gaming_member_id = v_organizer_id and not v_revoked;
  select ft.competition_team_id into v_team_id
    from competition_registration_freeze_teams ft
   where ft.competition_id = p_competition_id and ft.captain_gaming_member_id = p_caller_gaming_member_id;
  v_is_captain := found;
  if not v_is_organizer and not v_is_captain then
    return null;
  end if;

  v_now := competition_registration_clock();
  -- The window is open only if an action could succeed: with the organizer's hosting access revoked every operation is refused, so nothing is offered. The
  -- captains still read the historical proposal, but truthfully.
  v_window_open := not v_revoked and competition_plan_amendment_window_problem(p_competition_id) is null;
  if v_is_captain then
    select t.name into v_my_team_name from competition_teams t where t.competition_team_id = v_team_id;
  end if;
  select cp.plan into v_current_plan from competition_plan_amendment_current_plan(p_competition_id) cp;

  select * into v_a from competition_plan_change_proposals a where a.competition_id = p_competition_id order by a.sequence_number desc limit 1;
  if found then
    v_status := competition_plan_amendment_status_of(v_a.plan_amendment_id, v_now);
    select r.resolved_at into v_resolved_at from competition_plan_change_resolutions r where r.plan_amendment_id = v_a.plan_amendment_id;
    select count(*)::integer into v_confirmed from competition_plan_change_decisions d where d.plan_amendment_id = v_a.plan_amendment_id and d.decision = 'CONFIRMED';
    if v_is_captain then
      select d.decision into v_my_decision from competition_plan_change_decisions d where d.plan_amendment_id = v_a.plan_amendment_id and d.competition_team_id = v_team_id;
    end if;
    select coalesce(jsonb_agg(jsonb_build_object('team_name', t.name, 'decision', d.decision) order by ft.position), '[]'::jsonb) into v_teams
      from competition_registration_freeze_teams ft
      join competition_teams t on t.competition_team_id = ft.competition_team_id
      left join competition_plan_change_decisions d on d.plan_amendment_id = v_a.plan_amendment_id and d.competition_team_id = ft.competition_team_id
     where ft.registration_freeze_id = v_a.registration_freeze_id;
    v_amendment := jsonb_build_object(
      'digest', v_a.amendment_digest, 'sequence_number', v_a.sequence_number, 'status', v_status,
      'actionable', (v_status = 'PENDING' and v_window_open),
      'created_at', v_a.created_at, 'expires_at', v_a.expires_at, 'resolved_at', v_resolved_at,
      'confirmed_count', v_confirmed, 'required_count', 4, 'teams', v_teams, 'my_decision', v_my_decision,
      'proposed', competition_plan_amendment_facts(v_a.proposed_plan), 'current', competition_plan_amendment_facts(v_current_plan));
  end if;

  if v_is_organizer then
    select coalesce(jsonb_agg(jsonb_build_object(
             'sequence_number', h.sequence_number, 'status', competition_plan_amendment_status_of(h.plan_amendment_id, v_now),
             'created_at', h.created_at,
             'resolved_at', (select r.resolved_at from competition_plan_change_resolutions r where r.plan_amendment_id = h.plan_amendment_id)) order by h.sequence_number), '[]'::jsonb)
      into v_history
      from (select x.plan_amendment_id, x.sequence_number, x.created_at from competition_plan_change_proposals x
             where x.competition_id = p_competition_id order by x.sequence_number desc limit 20) h;
  end if;

  return jsonb_build_object('role', jsonb_build_object('organizer', v_is_organizer, 'captain', v_is_captain), 'window_open', v_window_open,
                            'my_team_name', v_my_team_name, 'amendment', v_amendment, 'history', v_history);
end;
$function$;

revoke all on function propose_competition_plan_amendment_atomically(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function decide_competition_plan_amendment_atomically(uuid, uuid, text, text) from public, anon, authenticated;
revoke all on function withdraw_competition_plan_amendment_atomically(uuid, uuid, text) from public, anon, authenticated;
revoke all on function get_competition_plan_amendment_status(uuid, uuid) from public, anon, authenticated;
grant execute on function propose_competition_plan_amendment_atomically(uuid, uuid, uuid, jsonb) to service_role;
grant execute on function decide_competition_plan_amendment_atomically(uuid, uuid, text, text) to service_role;
grant execute on function withdraw_competition_plan_amendment_atomically(uuid, uuid, text) to service_role;
grant execute on function get_competition_plan_amendment_status(uuid, uuid) to service_role;
