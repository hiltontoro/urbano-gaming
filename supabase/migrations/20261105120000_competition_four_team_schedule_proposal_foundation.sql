-- UG-CR-GATE-SSS-022 — Four-Team Schedule Proposal backend foundation.
--
-- WHAT THIS DOES. After the draw (READY_TO_PUBLISH, one consistent freeze of exactly four accepted teams, the one permanent draw, no fixture) the competition's own ACTIVE
-- organizer may record a PROPOSED SCHEDULE for the two semifinals and the final, and only the organizer. A proposal is separate, immutable evidence: three placements, each
-- a planning pitch of the CURRENT accepted plan, a plan date and a start time in the venue's own clock. Nothing else is a client's to say: the teams and the pairing are the
-- permanent draw's (positions one and two meet in the first semifinal, three and four in the second); the venue's zone, capacity, dates, windows and pitches are the current
-- planning revision's; the timing is the format registry's; the actor is the verified caller; every instant is derived here. A proposal names the plan revision, the draw and
-- the draw's digest it was made on, and carries a digest of the whole and of the request it answered.
--
--   1. Two server-only, append-only tables: competition_schedule_proposals (one row per version, numbered 1, 2, 3 ... without a gap, each superseding the one before) and
--      competition_schedule_proposal_placements (exactly three per proposal, one per role). Row-level security is on, there is no policy, no role holds any privilege, and
--      UPDATE, DELETE and TRUNCATE are refused. At commit a deferred check re-derives every placement from the plan, re-judges every rule and recomputes both digests, and
--      refuses a proposal that does not reproduce itself.
--   2. Eleven internal helpers, executable by nobody: the registry timing, the two digests, the eligibility test, the schedule evaluator, the plan context, the evidence
--      builder and the checks.
--   3. Two service-role-only operations: the atomic create-or-replay and a bounded read (the active organizer alone).
--
-- THE ORDER OF DECISIONS in the create operation: the competition lock; the organizer's exact, null-safe ownership and the host-revocation guard; the shape of the request; an
-- exact retry of the same request (answered from the record, writing nothing, even after the competition has moved on) or, for a different request under the same
-- identifier, a conflict; then the lifecycle (state and fixtures, the freeze, the current plan, the freeze's consistency, the draw, a plan change that genuinely awaits the
-- captains); then the schedule itself, one rule at a time, in a fixed order; and only then the sequence number, the supersession and the writes. All of it is judged on real
-- elapsed time - instants, never wall-clock arithmetic - and at the one accepted clock (competition_registration_clock), so a daylight-saving change can neither hide a
-- violation nor invent one, and a start is valid only if it is strictly after that clock.
--
-- WHAT THIS DELIBERATELY DOES NOT DO. It changes no earlier migration, no registry value, no registration, deadline, freeze, planning, amendment or draw function, no table
-- of the draw or the plan, no publish or cancel operation and no discovery. It creates no fixture, publishes nothing, adds no Competition state and makes no format other
-- than five-a-side creatable (the format a proposal uses is always the competition's own, taken from the competition). It is NOT yet what a publication reads: the existing
-- manual publication still accepts any pairing and any time, and a later gate must derive the bracket and the times from a current proposal. A plan change activated after the
-- draw leaves the draw exactly as it was and leaves an older proposal on the older plan revision, readable as STALE; a new proposal on the new revision is then required.
--
-- Append-only: no earlier migration is edited.

-- 1/8  The proposals and their placements.
create table competition_schedule_proposals (
  schedule_proposal_id uuid primary key default gen_random_uuid(),
  competition_id uuid not null,
  sequence_number integer not null,
  supersedes_schedule_proposal_id uuid,
  intent_id uuid not null,
  request_digest text not null,
  proposed_by_gaming_member_id uuid not null references gaming_members (gaming_member_id),
  created_at timestamptz not null,
  planning_revision_id uuid not null,
  competition_draw_id uuid not null,
  draw_digest text not null,
  format_key text not null,
  time_zone text not null,
  simultaneous_match_capacity smallint not null,
  occupancy_minutes smallint not null,
  pitch_transition_minutes smallint not null,
  minimum_team_rest_minutes smallint not null,
  proposal_digest text not null,
  constraint competition_schedule_proposals_sequence_key unique (competition_id, sequence_number),
  constraint competition_schedule_proposals_intent_key unique (competition_id, intent_id),
  constraint competition_schedule_proposals_competition_proposal_key unique (competition_id, schedule_proposal_id),
  constraint competition_schedule_proposals_one_successor_key unique (supersedes_schedule_proposal_id),
  constraint competition_schedule_proposals_competition_fkey foreign key (competition_id) references competitions (competition_id),
  constraint competition_schedule_proposals_revision_fkey foreign key (competition_id, planning_revision_id) references competition_planning_revisions (competition_id, planning_revision_id),
  constraint competition_schedule_proposals_draw_fkey foreign key (competition_id, competition_draw_id) references competition_draws (competition_id, competition_draw_id),
  constraint competition_schedule_proposals_format_fkey foreign key (competition_id, format_key) references competitions (competition_id, activity_key),
  constraint competition_schedule_proposals_supersedes_fkey foreign key (competition_id, supersedes_schedule_proposal_id) references competition_schedule_proposals (competition_id, schedule_proposal_id),
  constraint competition_schedule_proposals_sequence_positive check (sequence_number >= 1),
  constraint competition_schedule_proposals_first_has_no_predecessor check ((sequence_number = 1) = (supersedes_schedule_proposal_id is null)),
  constraint competition_schedule_proposals_digest_shape check (proposal_digest ~ '^[0-9a-f]{64}$' and request_digest ~ '^[0-9a-f]{64}$' and draw_digest ~ '^[0-9a-f]{64}$'),
  constraint competition_schedule_proposals_time_zone_shape check (time_zone ~ '^[A-Z][A-Za-z0-9_+-]*(/[A-Z][A-Za-z0-9_+-]*){1,2}$'),
  constraint competition_schedule_proposals_capacity_range check (simultaneous_match_capacity between 1 and 16),
  constraint competition_schedule_proposals_timing_positive check (occupancy_minutes > 0 and pitch_transition_minutes > 0 and minimum_team_rest_minutes > 0)
);

create table competition_schedule_proposal_placements (
  schedule_proposal_id uuid not null,
  competition_id uuid not null,
  planning_revision_id uuid not null,
  fixture_role text not null,
  planning_pitch_id uuid not null references competition_planning_pitches (planning_pitch_id),
  plan_date date not null,
  start_time time(0) not null,
  starts_at timestamptz not null,
  occupancy_ends_at timestamptz not null,
  window_starts_at timestamptz not null,
  window_ends_at timestamptz not null,
  constraint competition_schedule_proposal_placements_pkey primary key (schedule_proposal_id, fixture_role),
  constraint competition_schedule_proposal_placements_proposal_fkey foreign key (competition_id, schedule_proposal_id) references competition_schedule_proposals (competition_id, schedule_proposal_id),
  constraint competition_schedule_proposal_placements_revision_fkey foreign key (competition_id, planning_revision_id) references competition_planning_revisions (competition_id, planning_revision_id),
  constraint competition_schedule_proposal_placements_date_fkey foreign key (planning_revision_id, plan_date) references competition_planning_dates (planning_revision_id, plan_date),
  constraint competition_schedule_proposal_placements_role check (fixture_role in ('SEMIFINAL_1', 'SEMIFINAL_2', 'FINAL')),
  constraint competition_schedule_proposal_placements_window check (window_starts_at <= starts_at and starts_at < occupancy_ends_at and occupancy_ends_at <= window_ends_at)
);

-- 2/8  Server-only: no browser role holds any privilege, and not even the server role can read or write a row directly (the operations below do that).
alter table competition_schedule_proposals enable row level security;
alter table competition_schedule_proposal_placements enable row level security;

revoke all on table competition_schedule_proposals from public, anon, authenticated, service_role;
revoke all on table competition_schedule_proposal_placements from public, anon, authenticated, service_role;

-- 3/8  Append-only: a recorded proposal never changes, whoever asks.
create function competition_schedule_reject_change()
 returns trigger
 language plpgsql
 set search_path = public, pg_temp
as $function$
begin
  raise exception 'SCHEDULE_PROPOSAL_IMMUTABLE: a recorded schedule proposal cannot be changed, replaced or removed' using errcode = 'P0001';
end;
$function$;
revoke all on function competition_schedule_reject_change() from public, anon, authenticated;
revoke all on function competition_schedule_reject_change() from service_role;

create trigger competition_schedule_proposals_immutable_rows before update or delete on competition_schedule_proposals
  for each row execute function competition_schedule_reject_change();
create trigger competition_schedule_proposal_placements_immutable_rows before update or delete on competition_schedule_proposal_placements
  for each row execute function competition_schedule_reject_change();

create trigger competition_schedule_proposals_immutable_truncate before truncate on competition_schedule_proposals
  for each statement execute function competition_schedule_reject_change();
create trigger competition_schedule_proposal_placements_immutable_truncate before truncate on competition_schedule_proposal_placements
  for each statement execute function competition_schedule_reject_change();

-- 4/8  The pure helpers. Nobody can call them directly; the operations (which run as the database owner) and the checks do.
--
-- The reserved timing of one match of a format, from the registry and nowhere else: the pitch is held for first half + halftime + second half + the FULL shootout reserve; the
-- pitch transition follows it before the same pitch is used again; the team rest follows it before a finalist plays again. No row for a format the registry does not know.
create function competition_schedule_timing(p_format_key text)
 returns table(occupancy_minutes integer, pitch_transition_minutes integer, minimum_team_rest_minutes integer)
 language sql
 stable
 set search_path = public, pg_temp
as $function$
  select (r.halves * r.minutes_per_half + r.halftime_minutes + r.knockout_shootout_reserve_minutes)::integer, r.pitch_transition_minutes::integer, r.minimum_team_rest_minutes::integer
    from competition_format_rules r
   where r.format_key = p_format_key
$function$;
revoke all on function competition_schedule_timing(text) from public, anon, authenticated;
revoke all on function competition_schedule_timing(text) from service_role;

-- The digest of one request. Canonical text (version 1), lines joined by a newline with none at the end: the version line, the competition, the request identifier and one line
-- per placement in role order (role, pitch, plan date, local start). Independent of the order the placements arrive in.
create function competition_schedule_request_digest(p_competition_id uuid, p_intent_id uuid, p_placements jsonb)
 returns text
 language sql
 immutable
 set search_path = public, pg_temp
as $function$
  select encode(sha256(convert_to(
    'URBANO-COMPETITION-SCHEDULE-REQUEST-V1'
    || E'\ncompetition:' || p_competition_id::text
    || E'\nintent:' || p_intent_id::text
    || coalesce((select string_agg(E'\nplacement:' || (e.value ->> 'fixture_role') || ',' || ((e.value ->> 'planning_pitch_id')::uuid)::text || ',' || (e.value ->> 'plan_date') || ',' || (e.value ->> 'start_time'),
                                   '' order by array_position(array['SEMIFINAL_1', 'SEMIFINAL_2', 'FINAL'], e.value ->> 'fixture_role'))
                   from jsonb_array_elements(p_placements) e), ''), 'UTF8')), 'hex')
$function$;
revoke all on function competition_schedule_request_digest(uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function competition_schedule_request_digest(uuid, uuid, jsonb) from service_role;

-- The digest of one proposal. Canonical text (version 1), lines joined by a newline with none at the end: the version line, the competition, the sequence number, the previous
-- proposal's digest (or none), the request digest, the plan revision, the draw and its digest, the format, the zone, the capacity, the three timing values and one line per
-- placement in role order (role, pitch, plan date, local start, then the start, the end of the occupancy and the window's two ends, each in UTC to the millisecond).
create function competition_schedule_proposal_digest(
  p_competition_id uuid, p_sequence integer, p_supersedes_digest text, p_request_digest text, p_planning_revision_id uuid, p_draw_id uuid, p_draw_digest text,
  p_format_key text, p_time_zone text, p_capacity integer, p_occupancy integer, p_transition integer, p_rest integer, p_placements jsonb
)
 returns text
 language sql
 immutable
 set search_path = public, pg_temp
as $function$
  select encode(sha256(convert_to(
    'URBANO-COMPETITION-SCHEDULE-PROPOSAL-V1'
    || E'\ncompetition:' || p_competition_id::text
    || E'\nsequence:' || p_sequence::text
    || E'\nsupersedes:' || coalesce(p_supersedes_digest, 'none')
    || E'\nrequest-digest:' || p_request_digest
    || E'\nplanning-revision:' || p_planning_revision_id::text
    || E'\ndraw:' || p_draw_id::text
    || E'\ndraw-digest:' || p_draw_digest
    || E'\nformat:' || p_format_key
    || E'\ntime-zone:' || p_time_zone
    || E'\ncapacity:' || p_capacity::text
    || E'\noccupancy-minutes:' || p_occupancy::text
    || E'\npitch-transition-minutes:' || p_transition::text
    || E'\nteam-rest-minutes:' || p_rest::text
    || coalesce((select string_agg(E'\nplacement:' || (e.value ->> 'fixture_role') || ',' || ((e.value ->> 'planning_pitch_id')::uuid)::text || ',' || (e.value ->> 'plan_date') || ',' || (e.value ->> 'start_time')
                                   || ',' || (e.value ->> 'start_utc') || ',' || (e.value ->> 'end_utc') || ',' || (e.value ->> 'window_start_utc') || ',' || (e.value ->> 'window_end_utc'),
                                   '' order by array_position(array['SEMIFINAL_1', 'SEMIFINAL_2', 'FINAL'], e.value ->> 'fixture_role'))
                   from jsonb_array_elements(p_placements) e), ''), 'UTF8')), 'hex')
$function$;
revoke all on function competition_schedule_proposal_digest(uuid, integer, text, text, uuid, uuid, text, text, text, integer, integer, integer, integer, jsonb) from public, anon, authenticated;
revoke all on function competition_schedule_proposal_digest(uuid, integer, text, text, uuid, uuid, text, text, text, integer, integer, integer, integer, jsonb) from service_role;

-- 5/8  The schedule evaluator: one complete schedule, judged against one plan revision and one format, at one decision instant (null: the future is not judged, as when stored
-- evidence is re-examined). The placements are three normalized objects in role order. It returns the derived placements (the instants, the label of the pitch, and the accepted
-- window each lies in) or raises the FIRST violation, in this order:
--   per placement, in role order: PITCH_NOT_IN_PLAN, PITCH_NOT_USABLE, PITCH_FORMAT_UNSUPPORTED, DATE_NOT_IN_PLAN, LOCAL_TIME_NONEXISTENT / LOCAL_TIME_AMBIGUOUS,
--   START_NOT_FUTURE, OUTSIDE_WINDOW;
--   then across the placements: for the pairs (first semifinal, second semifinal), (first semifinal, final), (second semifinal, final) - PITCH_OVERLAP, then PITCH_TRANSITION -
--   then CAPACITY_EXCEEDED, then FINAL_REST.
-- A placement is never altered to make it fit. A window whose end the clocks skip or repeat is never matched.
create function competition_schedule_evaluate(p_competition_id uuid, p_planning_revision_id uuid, p_format_key text, p_placements jsonb, p_now timestamptz)
 returns jsonb
 language plpgsql
 stable
 set search_path = public, pg_temp
as $function$
declare
  v_roles constant text[] := array['SEMIFINAL_1', 'SEMIFINAL_2', 'FINAL'];
  v_zone text;
  v_capacity integer;
  v_occupancy integer;
  v_transition integer;
  v_rest integer;
  v_i integer;
  v_a integer;
  v_b integer;
  v_pair integer;
  v_element jsonb;
  v_pitch competition_planning_pitches%rowtype;
  v_date date;
  v_local timestamp;
  v_kind text;
  v_window record;
  v_window_start timestamptz;
  v_window_end timestamptz;
  v_found boolean;
  v_running integer;
  v_pitch_ids uuid[] := array[null, null, null]::uuid[];
  v_labels text[] := array[null, null, null]::text[];
  v_starts timestamptz[] := array[null, null, null]::timestamptz[];
  v_ends timestamptz[] := array[null, null, null]::timestamptz[];
  v_window_starts timestamptz[] := array[null, null, null]::timestamptz[];
  v_window_ends timestamptz[] := array[null, null, null]::timestamptz[];
  v_out jsonb := '[]'::jsonb;
begin
  select r.venue_time_zone, r.simultaneous_match_capacity into v_zone, v_capacity
    from competition_planning_revisions r
   where r.planning_revision_id = p_planning_revision_id and r.competition_id = p_competition_id;
  if not found then
    raise exception 'SCHEDULE_PROPOSAL_INVALID: PLAN_NOT_FOUND: the plan revision is not one of this competition''s' using errcode = 'P0001';
  end if;
  select t.occupancy_minutes, t.pitch_transition_minutes, t.minimum_team_rest_minutes into v_occupancy, v_transition, v_rest
    from competition_schedule_timing(p_format_key) t;
  if not found then
    raise exception 'SCHEDULE_PROPOSAL_INVALID: FORMAT_UNSUPPORTED: the registry has no timing for this format' using errcode = 'P0001';
  end if;
  if p_placements is null or jsonb_typeof(p_placements) <> 'array' or jsonb_array_length(p_placements) <> 3 then
    raise exception 'SCHEDULE_PROPOSAL_INVALID: PLACEMENTS_INVALID: exactly three placements are evaluated' using errcode = 'P0001';
  end if;

  for v_i in 1..3 loop
    v_element := p_placements -> (v_i - 1);
    if v_element ->> 'fixture_role' is distinct from v_roles[v_i] then
      raise exception 'SCHEDULE_PROPOSAL_INVALID: ROLE_INVALID: the placements must be given in role order' using errcode = 'P0001';
    end if;
    select * into v_pitch from competition_planning_pitches pp
     where pp.planning_pitch_id = (v_element ->> 'planning_pitch_id')::uuid and pp.planning_revision_id = p_planning_revision_id;
    if not found then
      raise exception 'SCHEDULE_PROPOSAL_INVALID: PITCH_NOT_IN_PLAN: this pitch is not one of the pitches in the accepted plan' using errcode = 'P0001';
    end if;
    if not v_pitch.is_usable then
      raise exception 'SCHEDULE_PROPOSAL_INVALID: PITCH_NOT_USABLE: this pitch is marked as not usable in the accepted plan' using errcode = 'P0001';
    end if;
    if not exists (select 1 from competition_planning_pitch_formats f where f.planning_pitch_id = v_pitch.planning_pitch_id and f.format_key = p_format_key) then
      raise exception 'SCHEDULE_PROPOSAL_INVALID: PITCH_FORMAT_UNSUPPORTED: this pitch does not take this competition''s format' using errcode = 'P0001';
    end if;
    v_date := (v_element ->> 'plan_date')::date;
    if not exists (select 1 from competition_planning_dates d where d.planning_revision_id = p_planning_revision_id and d.plan_date = v_date) then
      raise exception 'SCHEDULE_PROPOSAL_INVALID: DATE_NOT_IN_PLAN: this date is not one of the tournament dates in the accepted plan' using errcode = 'P0001';
    end if;
    v_local := v_date + (v_element ->> 'start_time')::time;
    v_kind := competition_planning_local_time_kind(v_local, v_zone);
    if v_kind = 'nonexistent' then
      raise exception 'SCHEDULE_PROPOSAL_INVALID: LOCAL_TIME_NONEXISTENT: this time does not exist on that date at the venue: the clocks skip it' using errcode = 'P0001';
    end if;
    if v_kind = 'ambiguous' then
      raise exception 'SCHEDULE_PROPOSAL_INVALID: LOCAL_TIME_AMBIGUOUS: this time happens twice on that date at the venue: the clocks repeat it' using errcode = 'P0001';
    end if;
    v_starts[v_i] := v_local at time zone v_zone;
    v_ends[v_i] := v_starts[v_i] + make_interval(mins => v_occupancy);
    if p_now is not null and v_starts[v_i] <= p_now then
      raise exception 'SCHEDULE_PROPOSAL_INVALID: START_NOT_FUTURE: the match must start after the moment this schedule is proposed' using errcode = 'P0001';
    end if;
    v_found := false;
    for v_window in
      select w.start_time as opens, w.end_time as closes from competition_planning_windows w
       where w.planning_revision_id = p_planning_revision_id and w.plan_date = v_date order by w.window_index
    loop
      if competition_planning_local_time_kind(v_date + v_window.opens, v_zone) = 'ok' and competition_planning_local_time_kind(v_date + v_window.closes, v_zone) = 'ok' then
        v_window_start := (v_date + v_window.opens) at time zone v_zone;
        v_window_end := (v_date + v_window.closes) at time zone v_zone;
        if v_window_start <= v_starts[v_i] and v_ends[v_i] <= v_window_end then
          v_window_starts[v_i] := v_window_start;
          v_window_ends[v_i] := v_window_end;
          v_found := true;
          exit;
        end if;
      end if;
    end loop;
    if not v_found then
      raise exception 'SCHEDULE_PROPOSAL_INVALID: OUTSIDE_WINDOW: the match, with its full reserved time, does not fit inside one operating window of that date' using errcode = 'P0001';
    end if;
    v_pitch_ids[v_i] := v_pitch.planning_pitch_id;
    v_labels[v_i] := v_pitch.label;
  end loop;

  for v_pair in 1..3 loop
    v_a := case v_pair when 3 then 2 else 1 end;
    v_b := case v_pair when 1 then 2 else 3 end;
    if v_pitch_ids[v_a] = v_pitch_ids[v_b] then
      if v_starts[v_a] < v_ends[v_b] and v_starts[v_b] < v_ends[v_a] then
        raise exception 'SCHEDULE_PROPOSAL_INVALID: PITCH_OVERLAP: two matches would use the same pitch at the same time' using errcode = 'P0001';
      end if;
      if greatest(v_starts[v_a], v_starts[v_b]) - least(v_starts[v_a], v_starts[v_b]) < make_interval(mins => v_occupancy + v_transition) then
        raise exception 'SCHEDULE_PROPOSAL_INVALID: PITCH_TRANSITION: the same pitch needs the format''s transition time after a match before the next one' using errcode = 'P0001';
      end if;
    end if;
  end loop;

  for v_i in 1..3 loop
    select count(*) into v_running from generate_series(1, 3) g(n) where v_starts[g.n] <= v_starts[v_i] and v_starts[v_i] < v_ends[g.n];
    if v_running > v_capacity then
      raise exception 'SCHEDULE_PROPOSAL_INVALID: CAPACITY_EXCEEDED: more matches would be on at once than the venue can host' using errcode = 'P0001';
    end if;
  end loop;

  if v_starts[3] < greatest(v_ends[1], v_ends[2]) + make_interval(mins => v_rest) then
    raise exception 'SCHEDULE_PROPOSAL_INVALID: FINAL_REST: the final must start at least the format''s team rest after the later semifinal''s reserved time ends' using errcode = 'P0001';
  end if;

  for v_i in 1..3 loop
    v_element := p_placements -> (v_i - 1);
    v_out := v_out || jsonb_build_array(jsonb_build_object(
      'fixture_role', v_roles[v_i],
      'planning_pitch_id', v_pitch_ids[v_i],
      'pitch_label', v_labels[v_i],
      'plan_date', v_element ->> 'plan_date',
      'start_time', v_element ->> 'start_time',
      'start_utc', to_char(v_starts[v_i] at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'end_utc', to_char(v_ends[v_i] at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'window_start_utc', to_char(v_window_starts[v_i] at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'window_end_utc', to_char(v_window_ends[v_i] at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')));
  end loop;
  return v_out;
end;
$function$;
revoke all on function competition_schedule_evaluate(uuid, uuid, text, jsonb, timestamptz) from public, anon, authenticated;
revoke all on function competition_schedule_evaluate(uuid, uuid, text, jsonb, timestamptz) from service_role;

-- 6/8  Eligibility, the plan context and the evidence.
-- Why a schedule cannot be proposed at this instant, or null when it can. Decided under the competition's lock, in this order: the wrong state (anything but READY_TO_PUBLISH
-- and unpublished, or a fixture present); no freeze; no current accepted plan; a freeze that is not exactly four teams, or that no longer matches the competition (the live
-- accepted teams, captains and members, and the frozen evidence, in both directions - and the plan still carrying what the freeze recorded); no permanent draw; and a plan
-- change that genuinely awaits the captains (a proposal's status is derived: PENDING until a resolution is recorded or its lifetime ends by the clock).
create function competition_schedule_eligibility_problem(p_competition_id uuid, p_instant timestamptz)
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
    return 'WRONG_STATE';
  end if;
  if exists (select 1 from competition_fixtures x where x.competition_id = p_competition_id) then
    return 'WRONG_STATE';
  end if;
  select * into v_freeze from competition_registration_freezes f where f.competition_id = p_competition_id;
  if not found then
    return 'FREEZE_REQUIRED';
  end if;
  select cur.* into v_current from competition_current_registration_plan(p_competition_id) cur;
  if v_current.planning_revision_id is null then
    return 'PLAN_REQUIRED';
  end if;
  if v_freeze.team_count is distinct from 4
     or (select count(*) from competition_registration_freeze_teams ft where ft.registration_freeze_id = v_freeze.registration_freeze_id) <> 4
     or (select count(*) from competition_teams t where t.competition_id = p_competition_id and t.status = 'ACCEPTED') <> 4
     or v_current.format_key is distinct from v_freeze.format_key
     or v_current.roster_minimum is distinct from v_freeze.roster_minimum
     or v_current.roster_maximum is distinct from v_freeze.roster_maximum
     or v_current.registration_deadline_utc is distinct from v_freeze.registration_deadline_utc
     or not competition_registration_freeze_consistent(p_competition_id) then
    return 'FREEZE_INCONSISTENT';
  end if;
  if not exists (select 1 from competition_draws d where d.competition_id = p_competition_id) then
    return 'DRAW_REQUIRED';
  end if;
  if exists (select 1 from competition_plan_change_proposals a
              where a.competition_id = p_competition_id and competition_plan_amendment_status_of(a.plan_amendment_id, p_instant) = 'PENDING') then
    return 'AMENDMENT_PENDING';
  end if;
  return null;
end;
$function$;
revoke all on function competition_schedule_eligibility_problem(uuid, timestamptz) from public, anon, authenticated;
revoke all on function competition_schedule_eligibility_problem(uuid, timestamptz) from service_role;

-- The current accepted plan as the active organizer needs it to compose a proposal: the revision, the zone, the capacity, the registry timing, the pitches with their
-- identifiers (and the formats each takes) and the tournament dates with their windows. Null when the competition has no plan.
create function competition_schedule_context(p_competition_id uuid)
 returns jsonb
 language plpgsql
 stable
 set search_path = public, pg_temp
as $function$
declare
  v_rev competition_planning_revisions%rowtype;
  v_timing record;
begin
  select * into v_rev from competition_planning_revisions r where r.competition_id = p_competition_id order by r.revision_number desc limit 1;
  if not found then
    return null;
  end if;
  select t.occupancy_minutes, t.pitch_transition_minutes, t.minimum_team_rest_minutes into v_timing from competition_schedule_timing(v_rev.format_key) t;
  return jsonb_build_object(
    'planning_revision_number', v_rev.revision_number,
    'format_key', v_rev.format_key,
    'time_zone', v_rev.venue_time_zone,
    'simultaneous_match_capacity', v_rev.simultaneous_match_capacity,
    'timing', jsonb_build_object('occupancy_minutes', v_timing.occupancy_minutes, 'pitch_transition_minutes', v_timing.pitch_transition_minutes, 'minimum_team_rest_minutes', v_timing.minimum_team_rest_minutes),
    'pitches', coalesce((
      select jsonb_agg(jsonb_build_object(
               'planning_pitch_id', p.planning_pitch_id, 'label', p.label, 'usable', p.is_usable,
               'supported_formats', coalesce((select jsonb_agg(f.format_key order by f.format_key collate "C") from competition_planning_pitch_formats f where f.planning_pitch_id = p.planning_pitch_id), '[]'::jsonb))
             order by p.position)
        from competition_planning_pitches p where p.planning_revision_id = v_rev.planning_revision_id), '[]'::jsonb),
    'dates', coalesce((
      select jsonb_agg(jsonb_build_object(
               'date', to_char(d.plan_date, 'YYYY-MM-DD'),
               'windows', coalesce((select jsonb_agg(jsonb_build_object('start', to_char(w.start_time, 'HH24:MI'), 'end', to_char(w.end_time, 'HH24:MI')) order by w.window_index)
                                      from competition_planning_windows w where w.planning_revision_id = d.planning_revision_id and w.plan_date = d.plan_date), '[]'::jsonb))
             order by d.position)
        from competition_planning_dates d where d.planning_revision_id = v_rev.planning_revision_id), '[]'::jsonb));
end;
$function$;
revoke all on function competition_schedule_context(uuid) from public, anon, authenticated;
revoke all on function competition_schedule_context(uuid) from service_role;

-- The bounded evidence of one proposal, exactly as both operations return it. The STATUS is derived at the moment of reading: SUPERSEDED when a later proposal exists; else
-- STALE when its plan revision is no longer the competition's current one or its draw digest no longer matches the draw's; else CURRENT. The teams of the semifinals are the
-- draw's (positions one and two, three and four); the final names none. No identifier of a member or an intent.
create function competition_schedule_proposal_evidence(p_schedule_proposal_id uuid)
 returns jsonb
 language plpgsql
 stable
 set search_path = public, pg_temp
as $function$
declare
  v_p competition_schedule_proposals%rowtype;
  v_current_revision uuid;
  v_revision_current boolean;
  v_draw_matches boolean;
  v_status text;
begin
  select * into v_p from competition_schedule_proposals s where s.schedule_proposal_id = p_schedule_proposal_id;
  if not found then
    return null;
  end if;
  select r.planning_revision_id into v_current_revision from competition_planning_revisions r where r.competition_id = v_p.competition_id order by r.revision_number desc limit 1;
  v_revision_current := v_current_revision is not distinct from v_p.planning_revision_id;
  v_draw_matches := exists (select 1 from competition_draws d where d.competition_draw_id = v_p.competition_draw_id and d.competition_id = v_p.competition_id and d.draw_digest = v_p.draw_digest);
  v_status := case
    when exists (select 1 from competition_schedule_proposals s where s.competition_id = v_p.competition_id and s.sequence_number > v_p.sequence_number) then 'SUPERSEDED'
    when not v_revision_current or not v_draw_matches then 'STALE'
    else 'CURRENT' end;
  return jsonb_build_object(
    'sequence_number', v_p.sequence_number,
    'created_at', to_char(v_p.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
    'status', v_status,
    'planning_revision_current', v_revision_current,
    'draw_digest_matches', v_draw_matches,
    'proposal_digest', v_p.proposal_digest,
    'request_digest', v_p.request_digest,
    'supersedes_digest', (select s.proposal_digest from competition_schedule_proposals s where s.schedule_proposal_id = v_p.supersedes_schedule_proposal_id),
    'planning_revision_id', v_p.planning_revision_id,
    'planning_revision_number', (select r.revision_number from competition_planning_revisions r where r.planning_revision_id = v_p.planning_revision_id),
    'draw_id', v_p.competition_draw_id,
    'draw_digest', v_p.draw_digest,
    'format_key', v_p.format_key,
    'time_zone', v_p.time_zone,
    'simultaneous_match_capacity', v_p.simultaneous_match_capacity,
    'timing', jsonb_build_object('occupancy_minutes', v_p.occupancy_minutes, 'pitch_transition_minutes', v_p.pitch_transition_minutes, 'minimum_team_rest_minutes', v_p.minimum_team_rest_minutes),
    'placements', (
      select jsonb_agg(jsonb_build_object(
               'fixture_role', x.fixture_role,
               'planning_pitch_id', x.planning_pitch_id,
               'pitch_label', pt.label,
               'plan_date', to_char(x.plan_date, 'YYYY-MM-DD'),
               'start_time', to_char(x.start_time, 'HH24:MI'),
               'start_utc', to_char(x.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'end_utc', to_char(x.occupancy_ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'window_start_utc', to_char(x.window_starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'window_end_utc', to_char(x.window_ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
               'team_a', case x.fixture_role
                 when 'SEMIFINAL_1' then (select jsonb_build_object('team_id', t.competition_team_id, 'team_name', t.name) from competition_draw_entries e join competition_teams t on t.competition_team_id = e.competition_team_id where e.competition_draw_id = v_p.competition_draw_id and e.draw_position = 1)
                 when 'SEMIFINAL_2' then (select jsonb_build_object('team_id', t.competition_team_id, 'team_name', t.name) from competition_draw_entries e join competition_teams t on t.competition_team_id = e.competition_team_id where e.competition_draw_id = v_p.competition_draw_id and e.draw_position = 3)
                 else null end,
               'team_b', case x.fixture_role
                 when 'SEMIFINAL_1' then (select jsonb_build_object('team_id', t.competition_team_id, 'team_name', t.name) from competition_draw_entries e join competition_teams t on t.competition_team_id = e.competition_team_id where e.competition_draw_id = v_p.competition_draw_id and e.draw_position = 2)
                 when 'SEMIFINAL_2' then (select jsonb_build_object('team_id', t.competition_team_id, 'team_name', t.name) from competition_draw_entries e join competition_teams t on t.competition_team_id = e.competition_team_id where e.competition_draw_id = v_p.competition_draw_id and e.draw_position = 4)
                 else null end)
             order by array_position(array['SEMIFINAL_1', 'SEMIFINAL_2', 'FINAL'], x.fixture_role))
        from competition_schedule_proposal_placements x
        join competition_planning_pitches pt on pt.planning_pitch_id = x.planning_pitch_id
       where x.schedule_proposal_id = v_p.schedule_proposal_id));
end;
$function$;
revoke all on function competition_schedule_proposal_evidence(uuid) from public, anon, authenticated;
revoke all on function competition_schedule_proposal_evidence(uuid) from service_role;

-- 7/8  The evidence is consistent whatever wrote it. A proposal must reproduce itself: exactly three placements, one per role, all of its own competition and plan revision;
-- the revision's format, zone and capacity; the registry's timing; the organizer as the actor; the competition's one permanent draw, which itself still reproduces; the next
-- sequence number and the proposal it supersedes; the plan revision being the CURRENT one and the competition being eligible at the moment it is recorded; every placement
-- re-derived from the plan, with every rule re-judged (the future is not re-judged); and both digests recomputed from all of it. Checked when the transaction commits, so a
-- proposal and its placements are judged together.
create function competition_schedule_proposal_verify(p_schedule_proposal_id uuid)
 returns void
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
declare
  v_roles constant text[] := array['SEMIFINAL_1', 'SEMIFINAL_2', 'FINAL'];
  v_p competition_schedule_proposals%rowtype;
  v_c competitions%rowtype;
  v_rev competition_planning_revisions%rowtype;
  v_draw competition_draws%rowtype;
  v_previous competition_schedule_proposals%rowtype;
  v_count integer;
  v_distinct integer;
  v_timing record;
  v_current uuid;
  v_requested jsonb;
  v_derived jsonb;
  v_stored jsonb;
  v_previous_digest text;
begin
  select * into v_p from competition_schedule_proposals s where s.schedule_proposal_id = p_schedule_proposal_id;
  if not found then
    raise exception 'SCHEDULE_PROPOSAL_INVALID: RECORD: the schedule proposal does not exist' using errcode = 'P0001';
  end if;
  select * into v_c from competitions c where c.competition_id = v_p.competition_id;
  select count(*), count(distinct x.fixture_role) into v_count, v_distinct from competition_schedule_proposal_placements x where x.schedule_proposal_id = v_p.schedule_proposal_id;
  if v_count <> 3 or v_distinct <> 3 then
    raise exception 'SCHEDULE_PROPOSAL_INVALID: SHAPE: a schedule proposal has exactly three placements, one per role' using errcode = 'P0001';
  end if;
  if exists (select 1 from competition_schedule_proposal_placements x
              where x.schedule_proposal_id = v_p.schedule_proposal_id and (x.competition_id <> v_p.competition_id or x.planning_revision_id <> v_p.planning_revision_id)) then
    raise exception 'SCHEDULE_PROPOSAL_INVALID: SHAPE: every placement belongs to its proposal''s own competition and plan revision' using errcode = 'P0001';
  end if;
  select * into v_rev from competition_planning_revisions r where r.planning_revision_id = v_p.planning_revision_id and r.competition_id = v_p.competition_id;
  if not found
     or v_rev.format_key is distinct from v_p.format_key or v_c.activity_key is distinct from v_p.format_key
     or v_rev.venue_time_zone is distinct from v_p.time_zone or v_rev.simultaneous_match_capacity is distinct from v_p.simultaneous_match_capacity then
    raise exception 'SCHEDULE_PROPOSAL_INVALID: PLAN: the format, the zone and the capacity are the plan revision''s and the competition''s own' using errcode = 'P0001';
  end if;
  select t.occupancy_minutes, t.pitch_transition_minutes, t.minimum_team_rest_minutes into v_timing from competition_schedule_timing(v_p.format_key) t;
  if not found or v_timing.occupancy_minutes <> v_p.occupancy_minutes or v_timing.pitch_transition_minutes <> v_p.pitch_transition_minutes
     or v_timing.minimum_team_rest_minutes <> v_p.minimum_team_rest_minutes then
    raise exception 'SCHEDULE_PROPOSAL_INVALID: TIMING: the timing is the registry''s for the format' using errcode = 'P0001';
  end if;
  if v_p.proposed_by_gaming_member_id is distinct from v_c.organizer_gaming_member_id then
    raise exception 'SCHEDULE_PROPOSAL_INVALID: ACTOR: a schedule is proposed by the competition''s own organizer' using errcode = 'P0001';
  end if;
  select * into v_draw from competition_draws d where d.competition_draw_id = v_p.competition_draw_id and d.competition_id = v_p.competition_id;
  if not found or v_draw.draw_digest is distinct from v_p.draw_digest then
    raise exception 'SCHEDULE_PROPOSAL_INVALID: DRAW: a proposal names its own competition''s draw and that draw''s digest' using errcode = 'P0001';
  end if;
  perform competition_draw_verify(v_draw.competition_draw_id);
  if v_p.sequence_number > 1 then
    select * into v_previous from competition_schedule_proposals s where s.competition_id = v_p.competition_id and s.sequence_number = v_p.sequence_number - 1;
    if not found or v_p.supersedes_schedule_proposal_id is distinct from v_previous.schedule_proposal_id then
      raise exception 'SCHEDULE_PROPOSAL_INVALID: SEQUENCE: a proposal supersedes the one numbered just before it, with no gap' using errcode = 'P0001';
    end if;
  end if;
  select r.planning_revision_id into v_current from competition_planning_revisions r where r.competition_id = v_p.competition_id order by r.revision_number desc limit 1;
  if v_current is distinct from v_p.planning_revision_id then
    raise exception 'SCHEDULE_PROPOSAL_INVALID: PLAN_NOT_CURRENT: a proposal is recorded only against the current accepted plan' using errcode = 'P0001';
  end if;
  if competition_schedule_eligibility_problem(v_p.competition_id, competition_registration_clock()) is not null then
    raise exception 'SCHEDULE_PROPOSAL_INVALID: NOT_ELIGIBLE: a proposal is recorded only while the competition is ready to publish with its draw' using errcode = 'P0001';
  end if;

  select jsonb_agg(jsonb_build_object('fixture_role', x.fixture_role, 'planning_pitch_id', x.planning_pitch_id, 'plan_date', to_char(x.plan_date, 'YYYY-MM-DD'), 'start_time', to_char(x.start_time, 'HH24:MI'))
                   order by array_position(v_roles, x.fixture_role))
    into v_requested from competition_schedule_proposal_placements x where x.schedule_proposal_id = v_p.schedule_proposal_id;
  v_derived := competition_schedule_evaluate(v_p.competition_id, v_p.planning_revision_id, v_p.format_key, v_requested, null);
  select jsonb_agg(jsonb_build_object(
           'fixture_role', x.fixture_role, 'planning_pitch_id', x.planning_pitch_id, 'pitch_label', pt.label, 'plan_date', to_char(x.plan_date, 'YYYY-MM-DD'), 'start_time', to_char(x.start_time, 'HH24:MI'),
           'start_utc', to_char(x.starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'end_utc', to_char(x.occupancy_ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
           'window_start_utc', to_char(x.window_starts_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), 'window_end_utc', to_char(x.window_ends_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
           order by array_position(v_roles, x.fixture_role))
    into v_stored
    from competition_schedule_proposal_placements x join competition_planning_pitches pt on pt.planning_pitch_id = x.planning_pitch_id
   where x.schedule_proposal_id = v_p.schedule_proposal_id;
  if v_derived is distinct from v_stored then
    raise exception 'SCHEDULE_PROPOSAL_INVALID: DERIVED: every instant and window is the one the plan and the venue''s clock give' using errcode = 'P0001';
  end if;
  if competition_schedule_request_digest(v_p.competition_id, v_p.intent_id, v_requested) is distinct from v_p.request_digest then
    raise exception 'SCHEDULE_PROPOSAL_INVALID: REQUEST_DIGEST: the request digest does not match the placements and the identifier' using errcode = 'P0001';
  end if;
  v_previous_digest := (select s.proposal_digest from competition_schedule_proposals s where s.schedule_proposal_id = v_p.supersedes_schedule_proposal_id);
  if competition_schedule_proposal_digest(v_p.competition_id, v_p.sequence_number, v_previous_digest, v_p.request_digest, v_p.planning_revision_id, v_p.competition_draw_id, v_p.draw_digest,
                                           v_p.format_key, v_p.time_zone, v_p.simultaneous_match_capacity, v_p.occupancy_minutes, v_p.pitch_transition_minutes, v_p.minimum_team_rest_minutes,
                                           v_derived) is distinct from v_p.proposal_digest then
    raise exception 'SCHEDULE_PROPOSAL_INVALID: DIGEST: the proposal digest does not match the evidence' using errcode = 'P0001';
  end if;
end;
$function$;
revoke all on function competition_schedule_proposal_verify(uuid) from public, anon, authenticated;
revoke all on function competition_schedule_proposal_verify(uuid) from service_role;

create function competition_schedule_proposal_verify_row()
 returns trigger
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
begin
  perform competition_schedule_proposal_verify(new.schedule_proposal_id);
  return null;
end;
$function$;
revoke all on function competition_schedule_proposal_verify_row() from public, anon, authenticated;
revoke all on function competition_schedule_proposal_verify_row() from service_role;

create function competition_schedule_placement_verify_row()
 returns trigger
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
begin
  perform competition_schedule_proposal_verify(new.schedule_proposal_id);
  return null;
end;
$function$;
revoke all on function competition_schedule_placement_verify_row() from public, anon, authenticated;
revoke all on function competition_schedule_placement_verify_row() from service_role;

create constraint trigger competition_schedule_proposals_verify after insert on competition_schedule_proposals
  deferrable initially deferred
  for each row execute function competition_schedule_proposal_verify_row();
create constraint trigger competition_schedule_proposal_placements_verify after insert on competition_schedule_proposal_placements
  deferrable initially deferred
  for each row execute function competition_schedule_placement_verify_row();

-- 8/8  The two operations.
-- CREATE (the competition's own ACTIVE organizer only). One atomic operation: it takes the competition lock, decides who is acting (exact, null-safe ownership and the
-- host-revocation guard), judges the shape of the request, answers an exact retry of the same request from the record and refuses any other request under the same identifier,
-- judges the lifecycle and every scheduling rule, and only then numbers the proposal, links it to the one it supersedes and writes it. It takes no team, pairing, instant,
-- zone, duration, capacity, format, timing or actor beyond the verified caller.
create function create_competition_schedule_proposal_atomically(p_competition_id uuid, p_organizer_gaming_member_id uuid, p_intent_id uuid, p_placements jsonb)
 returns jsonb
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
declare
  v_roles constant text[] := array['SEMIFINAL_1', 'SEMIFINAL_2', 'FINAL'];
  v_organizer_id uuid;
  v_format text;
  v_i integer;
  v_element jsonb;
  v_key text;
  v_text text;
  v_date date;
  v_roles_seen text[] := array[]::text[];
  v_normalized jsonb;
  v_request_digest text;
  v_existing competition_schedule_proposals%rowtype;
  v_now timestamptz;
  v_problem text;
  v_revision competition_planning_revisions%rowtype;
  v_draw competition_draws%rowtype;
  v_timing record;
  v_derived jsonb;
  v_sequence integer;
  v_previous_id uuid;
  v_previous_digest text;
  v_proposal_id uuid;
  v_digest text;
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
    raise exception 'COMPETITION_ACCESS_DENIED: only this competition''s own organizer may propose its schedule' using errcode = 'P0001';
  end if;
  perform assert_competition_not_host_revoked(p_competition_id);

  -- The shape of the request: an identifier and exactly three placements, each exactly a role, a pitch, a plan date and a local start time.
  if p_intent_id is null then
    raise exception 'SCHEDULE_PROPOSAL_INVALID: INTENT_INVALID: a request identifier is required' using errcode = 'P0001';
  end if;
  if p_placements is null or jsonb_typeof(p_placements) <> 'array' or jsonb_array_length(p_placements) <> 3 then
    raise exception 'SCHEDULE_PROPOSAL_INVALID: PLACEMENTS_INVALID: exactly three placements are required: the first semifinal, the second semifinal and the final' using errcode = 'P0001';
  end if;
  for v_i in 0..2 loop
    v_element := p_placements -> v_i;
    if jsonb_typeof(v_element) <> 'object' then
      raise exception 'SCHEDULE_PROPOSAL_INVALID: PLACEMENT_NOT_OBJECT: each placement must be an object' using errcode = 'P0001';
    end if;
    for v_key in select jsonb_object_keys(v_element) loop
      if v_key not in ('fixture_role', 'planning_pitch_id', 'plan_date', 'start_time') then
        raise exception 'SCHEDULE_PROPOSAL_INVALID: UNKNOWN_FIELD: a placement has a field that is not part of the request' using errcode = 'P0001';
      end if;
    end loop;
    if jsonb_typeof(v_element -> 'fixture_role') is distinct from 'string' or not ((v_element ->> 'fixture_role') = any (v_roles)) then
      raise exception 'SCHEDULE_PROPOSAL_INVALID: ROLE_INVALID: the role must be SEMIFINAL_1, SEMIFINAL_2 or FINAL' using errcode = 'P0001';
    end if;
    if jsonb_typeof(v_element -> 'planning_pitch_id') is distinct from 'string'
       or (v_element ->> 'planning_pitch_id') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
      raise exception 'SCHEDULE_PROPOSAL_INVALID: PITCH_INVALID: a planning pitch identifier is required' using errcode = 'P0001';
    end if;
    v_text := case when jsonb_typeof(v_element -> 'plan_date') = 'string' then v_element ->> 'plan_date' end;
    if v_text is null or v_text !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
      raise exception 'SCHEDULE_PROPOSAL_INVALID: DATE_INVALID: the plan date must be a real calendar day written YYYY-MM-DD' using errcode = 'P0001';
    end if;
    begin
      v_date := v_text::date;
    exception when others then
      raise exception 'SCHEDULE_PROPOSAL_INVALID: DATE_INVALID: the plan date must be a real calendar day written YYYY-MM-DD' using errcode = 'P0001';
    end;
    if to_char(v_date, 'YYYY-MM-DD') <> v_text or v_date < date '2020-01-01' or v_date > date '2099-12-31' then
      raise exception 'SCHEDULE_PROPOSAL_INVALID: DATE_INVALID: the plan date must be a real calendar day written YYYY-MM-DD' using errcode = 'P0001';
    end if;
    v_text := case when jsonb_typeof(v_element -> 'start_time') = 'string' then v_element ->> 'start_time' end;
    if v_text is null or v_text !~ '^([01][0-9]|2[0-3]):[0-5][0-9]$' then
      raise exception 'SCHEDULE_PROPOSAL_INVALID: TIME_INVALID: the start time must be written HH:MM on a 24-hour clock, in the venue''s time' using errcode = 'P0001';
    end if;
    v_roles_seen := v_roles_seen || (v_element ->> 'fixture_role');
  end loop;
  if (select count(distinct r) from unnest(v_roles_seen) r) <> 3 then
    raise exception 'SCHEDULE_PROPOSAL_INVALID: ROLE_DUPLICATE: each role must appear exactly once' using errcode = 'P0001';
  end if;
  select jsonb_agg(jsonb_build_object('fixture_role', e.value ->> 'fixture_role', 'planning_pitch_id', ((e.value ->> 'planning_pitch_id')::uuid)::text,
                                      'plan_date', e.value ->> 'plan_date', 'start_time', e.value ->> 'start_time')
                   order by array_position(v_roles, e.value ->> 'fixture_role'))
    into v_normalized from jsonb_array_elements(p_placements) e;
  v_request_digest := competition_schedule_request_digest(p_competition_id, p_intent_id, v_normalized);

  -- An exact retry is answered from the record, after the caller's identity and the host's standing (judged above) and BEFORE the lifecycle: the proposal stays replayable after
  -- the competition has moved on, and a replay writes nothing. The same identifier for anything else is a conflict and changes nothing.
  select * into v_existing from competition_schedule_proposals s where s.competition_id = p_competition_id and s.intent_id = p_intent_id;
  if found then
    if v_existing.request_digest = v_request_digest then
      return jsonb_build_object('already_proposed', true, 'proposal', competition_schedule_proposal_evidence(v_existing.schedule_proposal_id));
    end if;
    raise exception 'SCHEDULE_PROPOSAL_INTENT_MISMATCH: this request identifier was already used for a different schedule' using errcode = 'P0001';
  end if;

  v_now := competition_registration_clock();
  v_problem := competition_schedule_eligibility_problem(p_competition_id, v_now);
  if v_problem = 'WRONG_STATE' then
    raise exception 'SCHEDULE_PROPOSAL_WRONG_STATE: a schedule can only be proposed while the competition is ready to publish, before anything is published or played' using errcode = 'P0001';
  elsif v_problem = 'FREEZE_REQUIRED' then
    raise exception 'SCHEDULE_PROPOSAL_FREEZE_REQUIRED: registration must be closed and frozen before a schedule can be proposed' using errcode = 'P0001';
  elsif v_problem = 'PLAN_REQUIRED' then
    raise exception 'SCHEDULE_PROPOSAL_PLAN_REQUIRED: the competition has no accepted plan to schedule against' using errcode = 'P0001';
  elsif v_problem = 'FREEZE_INCONSISTENT' then
    raise exception 'SCHEDULE_PROPOSAL_FREEZE_INCONSISTENT: the frozen registration no longer matches this competition, so a schedule cannot be proposed' using errcode = 'P0001';
  elsif v_problem = 'DRAW_REQUIRED' then
    raise exception 'SCHEDULE_PROPOSAL_DRAW_REQUIRED: the draw must be made before a schedule can be proposed' using errcode = 'P0001';
  elsif v_problem = 'AMENDMENT_PENDING' then
    raise exception 'SCHEDULE_PROPOSAL_AMENDMENT_PENDING: a plan change is still waiting for the captains'' answers' using errcode = 'P0001';
  end if;

  -- The facts the schedule is judged against are the server's: the current accepted plan revision, the one permanent draw (which must still reproduce itself) and the
  -- competition's own format.
  select r.* into v_revision from competition_planning_revisions r where r.competition_id = p_competition_id order by r.revision_number desc limit 1;
  select d.* into v_draw from competition_draws d where d.competition_id = p_competition_id;
  perform competition_draw_verify(v_draw.competition_draw_id);
  v_derived := competition_schedule_evaluate(p_competition_id, v_revision.planning_revision_id, v_format, v_normalized, v_now);
  select t.occupancy_minutes, t.pitch_transition_minutes, t.minimum_team_rest_minutes into v_timing from competition_schedule_timing(v_format) t;

  select coalesce(max(s.sequence_number), 0) + 1 into v_sequence from competition_schedule_proposals s where s.competition_id = p_competition_id;
  select s.schedule_proposal_id, s.proposal_digest into v_previous_id, v_previous_digest
    from competition_schedule_proposals s where s.competition_id = p_competition_id and s.sequence_number = v_sequence - 1;
  v_proposal_id := gen_random_uuid();
  v_digest := competition_schedule_proposal_digest(p_competition_id, v_sequence, v_previous_digest, v_request_digest, v_revision.planning_revision_id, v_draw.competition_draw_id, v_draw.draw_digest,
                                                   v_format, v_revision.venue_time_zone, v_revision.simultaneous_match_capacity, v_timing.occupancy_minutes, v_timing.pitch_transition_minutes,
                                                   v_timing.minimum_team_rest_minutes, v_derived);

  insert into competition_schedule_proposals (
    schedule_proposal_id, competition_id, sequence_number, supersedes_schedule_proposal_id, intent_id, request_digest, proposed_by_gaming_member_id, created_at,
    planning_revision_id, competition_draw_id, draw_digest, format_key, time_zone, simultaneous_match_capacity, occupancy_minutes, pitch_transition_minutes, minimum_team_rest_minutes, proposal_digest
  ) values (
    v_proposal_id, p_competition_id, v_sequence, v_previous_id, p_intent_id, v_request_digest, p_organizer_gaming_member_id, v_now,
    v_revision.planning_revision_id, v_draw.competition_draw_id, v_draw.draw_digest, v_format, v_revision.venue_time_zone, v_revision.simultaneous_match_capacity,
    v_timing.occupancy_minutes, v_timing.pitch_transition_minutes, v_timing.minimum_team_rest_minutes, v_digest
  );

  insert into competition_schedule_proposal_placements (
    schedule_proposal_id, competition_id, planning_revision_id, fixture_role, planning_pitch_id, plan_date, start_time, starts_at, occupancy_ends_at, window_starts_at, window_ends_at
  )
  select v_proposal_id, p_competition_id, v_revision.planning_revision_id, d.value ->> 'fixture_role', (d.value ->> 'planning_pitch_id')::uuid, (d.value ->> 'plan_date')::date,
         (d.value ->> 'start_time')::time, (d.value ->> 'start_utc')::timestamptz, (d.value ->> 'end_utc')::timestamptz, (d.value ->> 'window_start_utc')::timestamptz,
         (d.value ->> 'window_end_utc')::timestamptz
    from jsonb_array_elements(v_derived) d;

  return jsonb_build_object('already_proposed', false, 'proposal', competition_schedule_proposal_evidence(v_proposal_id));
end;
$function$;

-- READ (bounded). Only the active, non-revoked organizer gets an answer - the plan as proposals are judged against it, the latest proposal in full (null before the first) and a
-- bounded history, newest first; every other caller - including a missing one - gets SQL NULL, the same as for a competition that does not exist.
create function get_competition_schedule_proposals(p_competition_id uuid, p_caller_gaming_member_id uuid)
 returns jsonb
 language plpgsql
 security definer
 set search_path = public, pg_temp
as $function$
declare
  v_organizer_id uuid;
  v_revoked boolean;
  v_latest uuid;
begin
  select competitions.organizer_gaming_member_id into v_organizer_id from competitions where competitions.competition_id = p_competition_id;
  if v_organizer_id is null then
    return null;
  end if;
  v_revoked := exists (select 1 from competition_host_capabilities h where h.competition_id = p_competition_id and h.state = 'REVOKED');
  if p_caller_gaming_member_id is distinct from v_organizer_id or v_revoked then
    return null;
  end if;
  select s.schedule_proposal_id into v_latest from competition_schedule_proposals s where s.competition_id = p_competition_id order by s.sequence_number desc limit 1;
  return jsonb_build_object(
    'context', competition_schedule_context(p_competition_id),
    'proposal', case when v_latest is null then null else competition_schedule_proposal_evidence(v_latest) end,
    'history', coalesce((
      select jsonb_agg(h.item order by h.sequence_number desc)
        from (select s.sequence_number,
                     jsonb_build_object(
                       'sequence_number', s.sequence_number,
                       'created_at', to_char(s.created_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'),
                       'status', competition_schedule_proposal_evidence(s.schedule_proposal_id) ->> 'status',
                       'proposal_digest', s.proposal_digest) as item
                from competition_schedule_proposals s
               where s.competition_id = p_competition_id
               order by s.sequence_number desc
               limit 50) h), '[]'::jsonb));
end;
$function$;

revoke all on function create_competition_schedule_proposal_atomically(uuid, uuid, uuid, jsonb) from public, anon, authenticated;
revoke all on function get_competition_schedule_proposals(uuid, uuid) from public, anon, authenticated;
grant execute on function create_competition_schedule_proposal_atomically(uuid, uuid, uuid, jsonb) to service_role;
grant execute on function get_competition_schedule_proposals(uuid, uuid) to service_role;
