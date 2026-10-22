-- UG-CR-GATE-SSS-001 — Small-Sided Soccer Format Rules Foundation.
--
-- WHAT THIS DOES. It makes the format of a competition a recorded, typed, authoritative fact instead of the literal SOCCER_5V5, and it makes the
-- one rule that already varies by format — the minimum number of actually-participating rostered members each team needs for a normal result —
-- a registry value instead of the literal 4. It adds NO planning, venue, date, window, draw, schedule, appeal or adjudication structure, changes no
-- competition state or fixture structure, grants no browser access, and does not touch authority grants or discovery.
--
--   1. competition_format_rules: the internal, authoritative registry of the four accepted formats (SOCCER_5V5 to SOCCER_8V8), seeded with exactly
--      the accepted V1 values, with every numeric invariant enforced by the database itself:
--        players_on_field <= roster minimum <= roster maximum <= absolute roster maximum
--      (over the defaults and over both configurable ranges). Substitutes are derived (roster minus players on field) and are NOT stored. The
--      shootout figure is scheduling reserve, not a shootout duration. The roster ranges are stored for a later gate; nothing reads them yet.
--      Server-only: row-level security on, no policy, no access for public/anon/authenticated, and read-only for service_role.
--   2. competitions.activity_key: the single-value CHECK is replaced by a foreign key to the registry. Every existing row is SOCCER_5V5 and is
--      left exactly as it is.
--   3. Evidence submission, organizer correction and finalization now read the participation minimum from the registry for the competition's own
--      format. For SOCCER_5V5 that value is 4, so existing 5v5 behavior, including the refusal message, is unchanged.
--
-- WHAT THIS DELIBERATELY DOES NOT DO. The two creation functions are NOT touched: both still accept only SOCCER_5V5, and the host path takes no
-- format at all. Adding registry rows therefore does not make 6v6-8v8 selectable or creatable through any route, page or RPC. (A server-side
-- contract fixture can record another registry format on an existing row; no application path can.)
--
-- Append-only: no earlier migration is edited. Every function below is the definition live after the migration named in its section, with only
-- the lines needed to read the threshold from the registry changed; signatures, return types, SECURITY DEFINER, the pinned search_path, locking
-- order, authorization order, replay behavior, the host revocation guard and the execute grants are unchanged and restated.

-- 1/7  The authoritative format-rules registry.
create table competition_format_rules (
  format_key text primary key,
  players_on_field smallint not null,
  minimum_to_start_or_continue smallint not null,
  minimum_actual_participants_normal_result smallint not null,
  roster_default_minimum smallint not null,
  roster_default_maximum smallint not null,
  roster_minimum_range_low smallint not null,
  roster_minimum_range_high smallint not null,
  roster_maximum_range_low smallint not null,
  roster_maximum_range_high smallint not null,
  roster_absolute_maximum smallint not null,
  halves smallint not null,
  minutes_per_half smallint not null,
  halftime_minutes smallint not null,
  pitch_transition_minutes smallint not null,
  minimum_team_rest_minutes smallint not null,
  knockout_shootout_reserve_minutes smallint not null,
  constraint competition_format_rules_key_closed_set
    check (format_key in ('SOCCER_5V5', 'SOCCER_6V6', 'SOCCER_7V7', 'SOCCER_8V8')),
  constraint competition_format_rules_players_range
    check (players_on_field between 5 and 8),
  constraint competition_format_rules_key_matches_players
    check (format_key = 'SOCCER_' || players_on_field::text || 'V' || players_on_field::text),
  constraint competition_format_rules_start_continue_range
    check (minimum_to_start_or_continue between 1 and players_on_field),
  constraint competition_format_rules_normal_result_range
    check (minimum_actual_participants_normal_result between 1 and players_on_field),
  constraint competition_format_rules_players_within_minimum_range
    check (players_on_field <= roster_minimum_range_low),
  constraint competition_format_rules_minimum_range_ordered
    check (roster_minimum_range_low <= roster_minimum_range_high),
  constraint competition_format_rules_maximum_range_ordered
    check (roster_maximum_range_low <= roster_maximum_range_high),
  constraint competition_format_rules_ranges_jointly_satisfiable
    check (roster_minimum_range_low <= roster_maximum_range_low and roster_minimum_range_high <= roster_maximum_range_high),
  constraint competition_format_rules_default_minimum_in_range
    check (roster_default_minimum between roster_minimum_range_low and roster_minimum_range_high),
  constraint competition_format_rules_default_maximum_in_range
    check (roster_default_maximum between roster_maximum_range_low and roster_maximum_range_high),
  constraint competition_format_rules_default_minimum_not_above_maximum
    check (roster_default_minimum <= roster_default_maximum),
  constraint competition_format_rules_maximum_within_absolute
    check (roster_maximum_range_high <= roster_absolute_maximum),
  constraint competition_format_rules_two_halves
    check (halves = 2),
  constraint competition_format_rules_timing_positive
    check (minutes_per_half > 0 and halftime_minutes > 0 and pitch_transition_minutes > 0 and minimum_team_rest_minutes > 0 and knockout_shootout_reserve_minutes > 0)
);

-- 2/7  Server-only: nothing a browser holds can read or change the registry, and not even the server role can change it (only a migration can).
alter table competition_format_rules enable row level security;
revoke all on table competition_format_rules from public, anon, authenticated, service_role;
grant select on table competition_format_rules to service_role;

-- 3/7  Exactly the four accepted formats (the SSS-001 execution addendum), in this column order.
insert into competition_format_rules (
  format_key, players_on_field, minimum_to_start_or_continue, minimum_actual_participants_normal_result,
  roster_default_minimum, roster_default_maximum, roster_minimum_range_low, roster_minimum_range_high,
  roster_maximum_range_low, roster_maximum_range_high, roster_absolute_maximum,
  halves, minutes_per_half, halftime_minutes, pitch_transition_minutes, minimum_team_rest_minutes, knockout_shootout_reserve_minutes
) values
  ('SOCCER_5V5', 5, 4, 4, 5, 8, 5, 8, 5, 10, 10, 2, 10, 3, 10, 30, 15),
  ('SOCCER_6V6', 6, 5, 5, 6, 10, 6, 10, 6, 12, 12, 2, 12, 3, 10, 30, 15),
  ('SOCCER_7V7', 7, 6, 6, 7, 12, 7, 12, 7, 14, 14, 2, 15, 5, 10, 45, 15),
  ('SOCCER_8V8', 8, 7, 7, 8, 14, 8, 14, 8, 16, 16, 2, 15, 5, 10, 45, 15);

-- 4/7  competitions.activity_key: replace the single-value CHECK with a foreign key to the registry.
do $$
declare
  v_constraint_name text;
begin
  -- STRICT: exactly one CHECK on competitions mentions activity_key (the inline single-value one); anything else is unexpected and aborts.
  select conname into strict v_constraint_name
    from pg_constraint
   where conrelid = 'public.competitions'::regclass
     and contype = 'c'
     and pg_get_constraintdef(oid) ilike '%activity_key%';
  execute format('alter table public.competitions drop constraint %I', v_constraint_name);
end $$;

-- Validated against every existing row: all of them are SOCCER_5V5, which the registry contains.
alter table competitions add constraint competitions_activity_key_fkey
  foreign key (activity_key) references competition_format_rules (format_key);

-- 5/7  submit_competition_fixture_evidence_atomically (evidence submission): the participation minimum comes from the format registry.
-- Definition live after 20261010194748_fix_evidence_submission_fail_closed.sql; only the declaration and the threshold block differ.
CREATE OR REPLACE FUNCTION public.submit_competition_fixture_evidence_atomically(p_competition_fixture_id uuid, p_scorekeeper_gaming_member_id uuid, p_team_a_score integer, p_team_b_score integer, p_goal_events jsonb, p_assist_events jsonb, p_participation_attestations jsonb, p_penalty_shootout_winning_team_id uuid)
 RETURNS TABLE(competition_fixture_evidence_id uuid, fixture_state text, already_submitted boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_lookup_competition_id uuid;
  v_competition_id uuid;
  v_competition_state text;
  v_fixture_state text;
  v_team_a uuid;
  v_team_b uuid;
  v_appointed_scorekeeper uuid;
  v_existing_evidence_id uuid;
  v_evidence_id uuid;
  v_entered_at timestamptz;
  v_goal jsonb;
  v_assist jsonb;
  v_attestation jsonb;
  v_goal_ids uuid[] := array[]::uuid[];
  v_goal_id uuid;
  v_scorer uuid;
  v_goal_team uuid;
  v_team_a_goal_count integer;
  v_team_b_goal_count integer;
  v_on_roster boolean;
  v_index integer;
  v_team_a_participant_count integer;
  v_team_b_participant_count integer;
  v_min_participants integer;
begin
  select competition_fixtures.competition_id into v_lookup_competition_id
    from competition_fixtures
   where competition_fixtures.competition_fixture_id = p_competition_fixture_id;

  if v_lookup_competition_id is null then
    raise exception 'FIXTURE_NOT_FOUND: no such fixture exists' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('competition_scope:' || v_lookup_competition_id::text));

  select competition_fixtures.competition_id, competition_fixtures.state, competition_fixtures.team_a_competition_team_id,
         competition_fixtures.team_b_competition_team_id, competition_fixtures.scorekeeper_gaming_member_id
    into v_competition_id, v_fixture_state, v_team_a, v_team_b, v_appointed_scorekeeper
    from competition_fixtures
   where competition_fixtures.competition_fixture_id = p_competition_fixture_id
   for update;

  if v_fixture_state is null then
    raise exception 'FIXTURE_NOT_FOUND: no such fixture exists' using errcode = 'P0001';
  end if;

  -- UG-CR-GATE-089 (scorekeeper evidence fails closed). Authorization is decided here, explicitly, before the
  -- idempotent replay, before the cancellation and fixture-state checks, and before any evidence is written.
  -- The caller must be the scorekeeper appointed to THIS fixture. Every way of not being that — no appointment at
  -- all, a missing caller id, a different member, a scorekeeper appointed to another fixture or competition, the
  -- organizer, a captain, a host — gets the same refusal. A NULL appointment can never authorize anyone: the old
  -- `caller <> appointed` comparison evaluated to NULL when nobody was appointed, and PL/pgSQL treats a NULL
  -- condition as false, so the denial was skipped. IS DISTINCT FROM and the explicit NULL tests close that.
  if v_appointed_scorekeeper is null
     or p_scorekeeper_gaming_member_id is null
     or p_scorekeeper_gaming_member_id is distinct from v_appointed_scorekeeper then
    raise exception 'COMPETITION_ACCESS_DENIED: only this fixture''s appointed scorekeeper may submit evidence'
      using errcode = 'P0001';
  end if;

  -- UG-CR-GATE-088: an organizer who appointed themselves scorekeeper loses this route once their hosting access is revoked.
  perform assert_actor_not_revoked_host(v_competition_id, p_scorekeeper_gaming_member_id);

  select competition_fixture_evidence.competition_fixture_evidence_id
    into v_existing_evidence_id
    from competition_fixture_evidence
   where competition_fixture_evidence.competition_fixture_id = p_competition_fixture_id
     and competition_fixture_evidence.is_current;

  if v_existing_evidence_id is not null then
    return query select v_existing_evidence_id, v_fixture_state, true;
    return;
  end if;

  select competitions.state into v_competition_state
    from competitions where competitions.competition_id = v_competition_id;

  if v_competition_state = 'CANCELLED_WITHOUT_CHAMPION' then
    raise exception 'COMPETITION_CANCELLED: this competition has been cancelled and no longer accepts this action'
      using errcode = 'P0001';
  end if;


  if v_fixture_state not in ('ROSTER_DECLARED', 'CHECKIN_OPEN') then
    raise exception 'FIXTURE_NOT_IN_EVIDENCE_PHASE: this fixture is not ready to receive evidence'
      using errcode = 'P0001';
  end if;

  -- Checkpoint 3 of 5: re-verify the scorekeeper is not, at this
  -- moment, on either team's current roster.
  select exists(
    select 1
      from competition_roster_revision_entries entries
      join competition_roster_revisions revisions
        on revisions.competition_roster_revision_id = entries.competition_roster_revision_id
     where revisions.competition_fixture_id = p_competition_fixture_id
       and revisions.is_current
       and entries.gaming_member_id = p_scorekeeper_gaming_member_id
  ) into v_on_roster;

  if v_on_roster then
    raise exception 'SCOREKEEPER_CONFLICT_OF_INTEREST: the scorekeeper may not appear on either team''s current roster'
      using errcode = 'P0001';
  end if;

  if p_team_a_score < 0 or p_team_b_score < 0 then
    raise exception 'INVALID_SCORE: scores must be non-negative' using errcode = 'P0001';
  end if;

  if p_team_a_score = p_team_b_score and p_penalty_shootout_winning_team_id is null then
    raise exception 'SHOOTOUT_REQUIRED: regulation ended level — a penalty-shootout winner is required'
      using errcode = 'P0001';
  end if;

  if p_penalty_shootout_winning_team_id is not null
     and p_penalty_shootout_winning_team_id not in (v_team_a, v_team_b) then
    raise exception 'INVALID_SHOOTOUT_WINNER: the shootout winner must be one of the two competing teams'
      using errcode = 'P0001';
  end if;

  v_entered_at := now();

  insert into competition_fixture_evidence (competition_fixture_id, team_a_score, team_b_score, entered_by_gaming_member_id, entered_at)
  values (p_competition_fixture_id, p_team_a_score, p_team_b_score, p_scorekeeper_gaming_member_id, v_entered_at)
  returning competition_fixture_evidence.competition_fixture_evidence_id into v_evidence_id;

  -- Attestations first, so every goal/assist below can be validated
  -- against actual participation recorded in this same bundle.
  for v_attestation in select * from jsonb_array_elements(p_participation_attestations) loop
    select exists(
      select 1
        from competition_roster_revision_entries entries
        join competition_roster_revisions revisions
          on revisions.competition_roster_revision_id = entries.competition_roster_revision_id
       where revisions.competition_fixture_id = p_competition_fixture_id
         and revisions.is_current
         and entries.gaming_member_id = (v_attestation->>'gamingMemberId')::uuid
    ) into v_on_roster;

    if not v_on_roster then
      raise exception 'ROSTER_MEMBER_NOT_APPROVED: attestation target % is not on either team''s current roster',
        v_attestation->>'gamingMemberId' using errcode = 'P0001';
    end if;

    insert into competition_participation_attestations (competition_fixture_id, gaming_member_id, actually_participated, attested_by_gaming_member_id, attested_at)
    values (p_competition_fixture_id, (v_attestation->>'gamingMemberId')::uuid, (v_attestation->>'actuallyParticipated')::boolean,
            p_scorekeeper_gaming_member_id, v_entered_at);
  end loop;

  v_index := 0;
  for v_goal in select * from jsonb_array_elements(p_goal_events) loop
    v_scorer := (v_goal->>'scorerGamingMemberId')::uuid;
    v_goal_team := (v_goal->>'competitionTeamId')::uuid;

    if v_goal_team not in (v_team_a, v_team_b) then
      raise exception 'INVALID_GOAL_TEAM: goal event % does not name one of the two competing teams', v_index
        using errcode = 'P0001';
    end if;

    if not exists (
      select 1 from competition_participation_attestations
      where competition_participation_attestations.competition_fixture_id = p_competition_fixture_id
        and competition_participation_attestations.gaming_member_id = v_scorer
        and competition_participation_attestations.actually_participated
        and competition_participation_attestations.is_current
    ) then
      raise exception 'EVIDENCE_PARTICIPANT_NOT_ATTESTED: goal scorer % is not attested as actually participating', v_scorer
        using errcode = 'P0001';
    end if;

    insert into soccer_goal_events (competition_fixture_id, scorer_gaming_member_id, competition_team_id, entered_by_gaming_member_id, entered_at)
    values (p_competition_fixture_id, v_scorer, v_goal_team, p_scorekeeper_gaming_member_id, v_entered_at)
    returning soccer_goal_events.soccer_goal_event_id into v_goal_id;

    v_goal_ids := array_append(v_goal_ids, v_goal_id);
    v_index := v_index + 1;
  end loop;

  for v_assist in select * from jsonb_array_elements(p_assist_events) loop
    if not exists (
      select 1 from soccer_goal_events
      where soccer_goal_events.soccer_goal_event_id = v_goal_ids[((v_assist->>'goalEventIndex')::integer) + 1]
        and soccer_goal_events.scorer_gaming_member_id <> (v_assist->>'assistingGamingMemberId')::uuid
    ) then
      raise exception 'INVALID_ASSIST: an assist may not be credited to the same player as the goal, or the referenced goal does not exist'
        using errcode = 'P0001';
    end if;

    if not exists (
      select 1 from competition_participation_attestations
      where competition_participation_attestations.competition_fixture_id = p_competition_fixture_id
        and competition_participation_attestations.gaming_member_id = (v_assist->>'assistingGamingMemberId')::uuid
        and competition_participation_attestations.actually_participated
        and competition_participation_attestations.is_current
    ) then
      raise exception 'EVIDENCE_PARTICIPANT_NOT_ATTESTED: assisting player % is not attested as actually participating',
        v_assist->>'assistingGamingMemberId' using errcode = 'P0001';
    end if;

    insert into soccer_assist_events (competition_fixture_id, assisting_gaming_member_id, assisted_goal_event_id, entered_by_gaming_member_id, entered_at)
    values (p_competition_fixture_id, (v_assist->>'assistingGamingMemberId')::uuid,
            v_goal_ids[((v_assist->>'goalEventIndex')::integer) + 1], p_scorekeeper_gaming_member_id, v_entered_at);
  end loop;

  select count(*) filter (where competition_team_id = v_team_a), count(*) filter (where competition_team_id = v_team_b)
    into v_team_a_goal_count, v_team_b_goal_count
    from soccer_goal_events
   where soccer_goal_events.competition_fixture_id = p_competition_fixture_id
     and soccer_goal_events.is_current;

  if v_team_a_goal_count <> p_team_a_score or v_team_b_goal_count <> p_team_b_score then
    raise exception 'REGULATION_SCORE_EVENT_MISMATCH: regulation score must equal the count of attributed goal events per team'
      using errcode = 'P0001';
  end if;

  -- Slice 001's configured minimum-participation invariant (UG-CR-REV-015
  -- decision 4), checked last — after every more specific goal/assist/
  -- score integrity check above has already had the chance to reject a
  -- malformed submission on its own, more specific terms: an ordinary
  -- NORMAL result requires each team to have at least 4 actually-
  -- participating members who are ALSO on that team's current roster for
  -- this fixture — check-in alone and roster membership alone never
  -- substitute for an actual-participation attestation; a team below the
  -- threshold may only reach a result via forfeit or void, never
  -- fabricated evidence.
  select
    count(*) filter (where roster.competition_team_id = v_team_a),
    count(*) filter (where roster.competition_team_id = v_team_b)
    into v_team_a_participant_count, v_team_b_participant_count
    from competition_participation_attestations att
    join competition_roster_revision_entries entries on entries.gaming_member_id = att.gaming_member_id
    join competition_roster_revisions roster on roster.competition_roster_revision_id = entries.competition_roster_revision_id
   where att.competition_fixture_id = p_competition_fixture_id
     and att.is_current
     and att.actually_participated
     and roster.competition_fixture_id = p_competition_fixture_id
     and roster.is_current;

  -- UG-CR-GATE-SSS-001: the threshold is a fact of THIS competition's format, read from competition_format_rules, not the literal 4. For
  -- SOCCER_5V5 the registry value is 4, so every existing 5v5 competition behaves exactly as before. A format with no rules row (which the
  -- foreign key on competitions.activity_key makes impossible) fails closed rather than falling back to any number.
  select competition_format_rules.minimum_actual_participants_normal_result
    into v_min_participants
    from competitions
    join competition_format_rules on competition_format_rules.format_key = competitions.activity_key
   where competitions.competition_id = v_competition_id;

  if v_min_participants is null then
    raise exception 'FORMAT_RULES_NOT_FOUND: this competition''s format has no rules, so no normal result can be recorded'
      using errcode = 'P0001';
  end if;

  if coalesce(v_team_a_participant_count, 0) < v_min_participants or coalesce(v_team_b_participant_count, 0) < v_min_participants then
    raise exception 'MINIMUM_PARTICIPATION_NOT_MET: each team requires at least % actually-participating rostered members for a normal result — use forfeit or void instead', v_min_participants
      using errcode = 'P0001';
  end if;

  if p_penalty_shootout_winning_team_id is not null then
    insert into soccer_penalty_shootouts (competition_fixture_id, winning_competition_team_id, entered_by_gaming_member_id, entered_at)
    values (p_competition_fixture_id, p_penalty_shootout_winning_team_id, p_scorekeeper_gaming_member_id, v_entered_at);
  end if;

  update competition_fixtures set state = 'EVIDENCE_SUBMITTED' where competition_fixtures.competition_fixture_id = p_competition_fixture_id;

  return query select v_evidence_id, 'EVIDENCE_SUBMITTED'::text, false;
end;
$function$;

revoke all on function submit_competition_fixture_evidence_atomically(uuid,uuid,integer,integer,jsonb,jsonb,jsonb,uuid) from public, anon, authenticated;
grant execute on function submit_competition_fixture_evidence_atomically(uuid,uuid,integer,integer,jsonb,jsonb,jsonb,uuid) to service_role;

-- 6/7  correct_competition_fixture_atomically (organizer correction): the participation minimum comes from the format registry.
-- Definition live after 20261012145721_fix_correction_authorization_null_safe.sql; only the declaration and the threshold block differ.
CREATE OR REPLACE FUNCTION public.correct_competition_fixture_atomically(p_competition_fixture_id uuid, p_organizer_gaming_member_id uuid, p_reason text, p_team_a_score integer, p_team_b_score integer, p_goal_events jsonb, p_assist_events jsonb, p_penalty_shootout_winning_team_id uuid)
 RETURNS TABLE(competition_fixture_evidence_id uuid, new_winning_competition_team_id uuid, competition_state text, cascade_outcome text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_lookup_competition_id uuid;
  v_competition_id uuid;
  v_organizer_id uuid;
  v_fixture_role text;
  v_fixture_state text;
  v_team_a uuid;
  v_team_b uuid;
  v_prior_evidence_id uuid;
  v_new_evidence_id uuid;
  v_corrected_at timestamptz;
  v_goal jsonb;
  v_assist jsonb;
  v_goal_ids uuid[] := array[]::uuid[];
  v_goal_id uuid;
  v_scorer uuid;
  v_goal_team uuid;
  v_team_a_goal_count integer;
  v_team_b_goal_count integer;
  v_new_winner uuid;
  v_prior_finalization_id uuid;
  v_prior_winner uuid;
  v_new_finalization_id uuid;
  v_final_fixture_id uuid;
  v_final_state text;
  v_final_team_a_source uuid;
  v_slot text;
  v_displaced_team_id uuid;
  v_cascade_outcome text := 'NONE';
  v_competition_state text;
  v_team_a_participant_count integer;
  v_team_b_participant_count integer;
  v_min_participants integer;
  v_member record;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'REASON_REQUIRED: a correction requires a reason' using errcode = 'P0001';
  end if;

  select competition_fixtures.competition_id into v_lookup_competition_id
    from competition_fixtures
   where competition_fixtures.competition_fixture_id = p_competition_fixture_id;

  if v_lookup_competition_id is null then
    raise exception 'FIXTURE_NOT_FOUND: no such fixture exists' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('competition_scope:' || v_lookup_competition_id::text));

  select competition_fixtures.competition_id, competition_fixtures.fixture_role, competition_fixtures.state,
         competition_fixtures.team_a_competition_team_id, competition_fixtures.team_b_competition_team_id
    into v_competition_id, v_fixture_role, v_fixture_state, v_team_a, v_team_b
    from competition_fixtures
   where competition_fixtures.competition_fixture_id = p_competition_fixture_id
   for update;

  if v_competition_id is null then
    raise exception 'FIXTURE_NOT_FOUND: no such fixture exists' using errcode = 'P0001';
  end if;

  select competitions.organizer_gaming_member_id, competitions.state
    into v_organizer_id, v_competition_state
    from competitions where competitions.competition_id = v_competition_id;

  -- UG-CR-GATE-089: null-safe. `caller <> organizer` evaluates to NULL for a NULL caller, and PL/pgSQL treats a NULL
  -- condition as false, so the denial used to be skipped and the call stopped only later, on a NOT NULL write.
  -- IS DISTINCT FROM makes the refusal explicit, before any evidence is touched. The stored organizer is NOT NULL.
  if p_organizer_gaming_member_id is distinct from v_organizer_id then
    raise exception 'COMPETITION_ACCESS_DENIED: only the organizer may correct fixture evidence' using errcode = 'P0001';
  end if;
  perform assert_competition_not_host_revoked(v_competition_id);

  if v_competition_state = 'CANCELLED_WITHOUT_CHAMPION' then
    raise exception 'COMPETITION_CANCELLED: this competition has been cancelled and no longer accepts this action'
      using errcode = 'P0001';
  end if;

  if p_team_a_score = p_team_b_score and p_penalty_shootout_winning_team_id is null then
    raise exception 'SHOOTOUT_REQUIRED: regulation ended level — a penalty-shootout winner is required'
      using errcode = 'P0001';
  end if;

  select competition_fixture_evidence.competition_fixture_evidence_id into v_prior_evidence_id
    from competition_fixture_evidence
   where competition_fixture_evidence.competition_fixture_id = p_competition_fixture_id and competition_fixture_evidence.is_current;

  update competition_fixture_evidence set is_current = false where competition_fixture_evidence.competition_fixture_evidence_id = v_prior_evidence_id;
  update soccer_goal_events set is_current = false, corrected_at = now(), corrected_by_gaming_member_id = p_organizer_gaming_member_id
   where soccer_goal_events.competition_fixture_id = p_competition_fixture_id and soccer_goal_events.is_current;
  update soccer_assist_events set is_current = false, corrected_at = now(), corrected_by_gaming_member_id = p_organizer_gaming_member_id
   where soccer_assist_events.competition_fixture_id = p_competition_fixture_id and soccer_assist_events.is_current;
  update soccer_penalty_shootouts set is_current = false where soccer_penalty_shootouts.competition_fixture_id = p_competition_fixture_id and soccer_penalty_shootouts.is_current;

  v_corrected_at := now();

  insert into competition_fixture_evidence (competition_fixture_id, team_a_score, team_b_score, entered_by_gaming_member_id, entered_at, supersedes_evidence_id)
  values (p_competition_fixture_id, p_team_a_score, p_team_b_score, p_organizer_gaming_member_id, v_corrected_at, v_prior_evidence_id)
  returning competition_fixture_evidence.competition_fixture_evidence_id into v_new_evidence_id;

  for v_goal in select * from jsonb_array_elements(p_goal_events) loop
    v_scorer := (v_goal->>'scorerGamingMemberId')::uuid;
    v_goal_team := (v_goal->>'competitionTeamId')::uuid;
    if v_goal_team not in (v_team_a, v_team_b) then
      raise exception 'INVALID_GOAL_TEAM: a corrected goal event does not name one of the two competing teams' using errcode = 'P0001';
    end if;
    insert into soccer_goal_events (competition_fixture_id, scorer_gaming_member_id, competition_team_id, entered_by_gaming_member_id, entered_at)
    values (p_competition_fixture_id, v_scorer, v_goal_team, p_organizer_gaming_member_id, v_corrected_at)
    returning soccer_goal_events.soccer_goal_event_id into v_goal_id;
    v_goal_ids := array_append(v_goal_ids, v_goal_id);
  end loop;

  for v_assist in select * from jsonb_array_elements(p_assist_events) loop
    insert into soccer_assist_events (competition_fixture_id, assisting_gaming_member_id, assisted_goal_event_id, entered_by_gaming_member_id, entered_at)
    values (p_competition_fixture_id, (v_assist->>'assistingGamingMemberId')::uuid,
            v_goal_ids[((v_assist->>'goalEventIndex')::integer) + 1], p_organizer_gaming_member_id, v_corrected_at);
  end loop;

  select count(*) filter (where competition_team_id = v_team_a), count(*) filter (where competition_team_id = v_team_b)
    into v_team_a_goal_count, v_team_b_goal_count
    from soccer_goal_events where soccer_goal_events.competition_fixture_id = p_competition_fixture_id and soccer_goal_events.is_current;

  if v_team_a_goal_count <> p_team_a_score or v_team_b_goal_count <> p_team_b_score then
    raise exception 'REGULATION_SCORE_EVENT_MISMATCH: regulation score must equal the count of attributed goal events per team'
      using errcode = 'P0001';
  end if;

  -- Minimum participation (UG-CR-REV-015 decision 4), re-derived here
  -- too: a correction never modifies attestations, but this closes the
  -- same gate defensively rather than trusting the original submission
  -- was made under this check's own migration.
  select
    count(*) filter (where roster.competition_team_id = v_team_a),
    count(*) filter (where roster.competition_team_id = v_team_b)
    into v_team_a_participant_count, v_team_b_participant_count
    from competition_participation_attestations att
    join competition_roster_revision_entries entries on entries.gaming_member_id = att.gaming_member_id
    join competition_roster_revisions roster on roster.competition_roster_revision_id = entries.competition_roster_revision_id
   where att.competition_fixture_id = p_competition_fixture_id
     and att.is_current
     and att.actually_participated
     and roster.competition_fixture_id = p_competition_fixture_id
     and roster.is_current;

  -- UG-CR-GATE-SSS-001: the threshold is a fact of THIS competition's format, read from competition_format_rules, not the literal 4. For
  -- SOCCER_5V5 the registry value is 4, so every existing 5v5 competition behaves exactly as before. A format with no rules row (which the
  -- foreign key on competitions.activity_key makes impossible) fails closed rather than falling back to any number.
  select competition_format_rules.minimum_actual_participants_normal_result
    into v_min_participants
    from competitions
    join competition_format_rules on competition_format_rules.format_key = competitions.activity_key
   where competitions.competition_id = v_competition_id;

  if v_min_participants is null then
    raise exception 'FORMAT_RULES_NOT_FOUND: this competition''s format has no rules, so no normal result can be recorded'
      using errcode = 'P0001';
  end if;

  if coalesce(v_team_a_participant_count, 0) < v_min_participants or coalesce(v_team_b_participant_count, 0) < v_min_participants then
    raise exception 'MINIMUM_PARTICIPATION_NOT_MET: each team requires at least % actually-participating rostered members for a normal result — use forfeit or void instead', v_min_participants
      using errcode = 'P0001';
  end if;

  if p_penalty_shootout_winning_team_id is not null then
    insert into soccer_penalty_shootouts (competition_fixture_id, winning_competition_team_id, entered_by_gaming_member_id, entered_at, supersedes_shootout_id)
    select p_competition_fixture_id, p_penalty_shootout_winning_team_id, p_organizer_gaming_member_id, v_corrected_at, soccer_penalty_shootouts.soccer_penalty_shootout_id
      from soccer_penalty_shootouts
     where soccer_penalty_shootouts.competition_fixture_id = p_competition_fixture_id and not soccer_penalty_shootouts.is_current
     order by soccer_penalty_shootouts.entered_at desc limit 1;
    if not found then
      insert into soccer_penalty_shootouts (competition_fixture_id, winning_competition_team_id, entered_by_gaming_member_id, entered_at)
      values (p_competition_fixture_id, p_penalty_shootout_winning_team_id, p_organizer_gaming_member_id, v_corrected_at);
    end if;
  end if;

  insert into competition_fixture_corrections (competition_fixture_id, corrected_by_gaming_member_id, reason, target_fact_type, previous_value_snapshot, new_value_snapshot, corrected_at)
  values (p_competition_fixture_id, p_organizer_gaming_member_id, p_reason, 'EVIDENCE_BUNDLE',
          jsonb_build_object('evidenceId', v_prior_evidence_id), jsonb_build_object('evidenceId', v_new_evidence_id), v_corrected_at);

  -- Resolve every then-open dispute as CORRECTED, atomically with the
  -- correction itself.
  update competition_disputes
     set resolved_at = v_corrected_at, resolved_by_gaming_member_id = p_organizer_gaming_member_id, resolution_action = 'CORRECTED'
   where competition_disputes.competition_fixture_id = p_competition_fixture_id and competition_disputes.resolved_at is null;

  v_new_winner := case when p_team_a_score > p_team_b_score then v_team_a
                        when p_team_b_score > p_team_a_score then v_team_b
                        else p_penalty_shootout_winning_team_id end;

  select competition_fixture_finalizations.competition_fixture_finalization_id, competition_fixture_finalizations.winning_competition_team_id
    into v_prior_finalization_id, v_prior_winner
    from competition_fixture_finalizations
   where competition_fixture_finalizations.competition_fixture_id = p_competition_fixture_id and competition_fixture_finalizations.is_current;

  if v_prior_finalization_id is not null then
    update competition_fixture_finalizations set is_current = false where competition_fixture_finalizations.competition_fixture_finalization_id = v_prior_finalization_id;

    insert into competition_fixture_finalizations (competition_fixture_id, finalized_by_gaming_member_id, finalized_at, outcome_type, winning_competition_team_id, reason, supersedes_finalization_id)
    values (p_competition_fixture_id, p_organizer_gaming_member_id, v_corrected_at, 'NORMAL', v_new_winner, p_reason, v_prior_finalization_id)
    returning competition_fixture_finalizations.competition_fixture_finalization_id into v_new_finalization_id;

    -- A correction supersedes the prior persistent record without
    -- erasing history (UG-CR-GATE-029's own local-demo step 9) — mirrors
    -- finalize_competition_fixture_atomically's own derivation exactly,
    -- recomputed from the corrected evidence, and chained via
    -- supersedes_record_id rather than left stale from the original
    -- finalization.
    update competition_member_participation_records
       set is_current = false
     where competition_member_participation_records.competition_fixture_id = p_competition_fixture_id
       and competition_member_participation_records.is_current;

    for v_member in
      select competition_participation_attestations.gaming_member_id,
             coalesce((select count(*) from soccer_goal_events where soccer_goal_events.competition_fixture_id = p_competition_fixture_id
                         and soccer_goal_events.is_current and soccer_goal_events.scorer_gaming_member_id = competition_participation_attestations.gaming_member_id), 0) as goals,
             coalesce((select count(*) from soccer_assist_events where soccer_assist_events.competition_fixture_id = p_competition_fixture_id
                         and soccer_assist_events.is_current and soccer_assist_events.assisting_gaming_member_id = competition_participation_attestations.gaming_member_id), 0) as assists,
             (select competition_member_participation_records.competition_member_participation_record_id
                from competition_member_participation_records
               where competition_member_participation_records.competition_fixture_id = p_competition_fixture_id
                 and competition_member_participation_records.gaming_member_id = competition_participation_attestations.gaming_member_id
               order by competition_member_participation_records.derived_at desc limit 1) as prior_record_id
        from competition_participation_attestations
       where competition_participation_attestations.competition_fixture_id = p_competition_fixture_id
         and competition_participation_attestations.is_current
         and competition_participation_attestations.actually_participated
    loop
      insert into competition_member_participation_records (competition_id, competition_fixture_id, gaming_member_id, appeared, goals, assists, derived_from_finalization_id, derived_at, supersedes_record_id)
      values (v_competition_id, p_competition_fixture_id, v_member.gaming_member_id, true, v_member.goals, v_member.assists, v_new_finalization_id, v_corrected_at, v_member.prior_record_id);
    end loop;

    if v_fixture_role in ('SEMIFINAL_1', 'SEMIFINAL_2') and v_new_winner is distinct from v_prior_winner then
      select competition_fixtures.competition_fixture_id, competition_fixtures.state, competition_fixtures.team_a_source_fixture_id
        into v_final_fixture_id, v_final_state, v_final_team_a_source
        from competition_fixtures
       where competition_fixtures.competition_id = v_competition_id and competition_fixtures.fixture_role = 'FINAL'
       for update;

      if v_final_state in ('SCHEDULED', 'ROSTER_DECLARED') then
        v_slot := case when v_final_team_a_source = p_competition_fixture_id then 'A' else 'B' end;

        select case when v_slot = 'A' then team_a_competition_team_id else team_b_competition_team_id end
          into v_displaced_team_id
          from competition_fixtures where competition_fixtures.competition_fixture_id = v_final_fixture_id;

        if v_slot = 'A' then
          update competition_fixtures set team_a_competition_team_id = v_new_winner, state = 'SCHEDULED'
           where competition_fixtures.competition_fixture_id = v_final_fixture_id;
        else
          update competition_fixtures set team_b_competition_team_id = v_new_winner, state = 'SCHEDULED'
           where competition_fixtures.competition_fixture_id = v_final_fixture_id;
        end if;

        if v_displaced_team_id is not null then
          update competition_roster_revisions
             set is_current = false, reason = coalesce(reason, '') || ' [superseded: finalist replaced by semifinal correction]'
           where competition_roster_revisions.competition_fixture_id = v_final_fixture_id
             and competition_roster_revisions.competition_team_id = v_displaced_team_id
             and competition_roster_revisions.is_current;
        end if;

        v_cascade_outcome := 'FINALIST_REPLACED_BEFORE_CHECKIN';
      else
        update competitions set state = 'CANCELLED_WITHOUT_CHAMPION',
               cancelled_reason = 'Semifinal winner changed by correction after final check-in opened: ' || p_reason
         where competitions.competition_id = v_competition_id;
        v_competition_state := 'CANCELLED_WITHOUT_CHAMPION';
        v_cascade_outcome := 'COMPETITION_CANCELLED_AFTER_FINAL_CHECKIN';
      end if;
    end if;
  end if;

  return query select v_new_evidence_id, v_new_winner, v_competition_state, v_cascade_outcome;
end;
$function$;

revoke all on function correct_competition_fixture_atomically(uuid,uuid,text,integer,integer,jsonb,jsonb,uuid) from public, anon, authenticated;
grant execute on function correct_competition_fixture_atomically(uuid,uuid,text,integer,integer,jsonb,jsonb,uuid) to service_role;

-- 7/7  finalize_competition_fixture_atomically (finalization): the participation minimum comes from the format registry.
-- Definition live after 20261013033205_fix_finalize_fixture_authorize_before_replay.sql; only the declaration and the threshold block differ.
CREATE OR REPLACE FUNCTION public.finalize_competition_fixture_atomically(p_competition_fixture_id uuid, p_organizer_gaming_member_id uuid)
 RETURNS TABLE(competition_fixture_finalization_id uuid, outcome_type text, winning_competition_team_id uuid, already_finalized boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_lookup_competition_id uuid;
  v_competition_id uuid;
  v_competition_state text;
  v_organizer_id uuid;
  v_fixture_role text;
  v_fixture_state text;
  v_scorekeeper_id uuid;
  v_team_a uuid;
  v_team_b uuid;
  v_existing_finalization_id uuid;
  v_existing_outcome text;
  v_existing_winner uuid;
  v_team_a_score integer;
  v_team_b_score integer;
  v_shootout_winner uuid;
  v_winner uuid;
  v_finalized_at timestamptz;
  v_finalization_id uuid;
  v_on_roster boolean;
  v_member record;
  v_final_fixture_id uuid;
  v_team_a_participant_count integer;
  v_team_b_participant_count integer;
  v_min_participants integer;
begin
  select competition_fixtures.competition_id into v_lookup_competition_id
    from competition_fixtures
   where competition_fixtures.competition_fixture_id = p_competition_fixture_id;

  if v_lookup_competition_id is null then
    raise exception 'FIXTURE_NOT_FOUND: no such fixture exists' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('competition_scope:' || v_lookup_competition_id::text));

  select competition_fixtures.competition_id, competition_fixtures.fixture_role, competition_fixtures.state,
         competition_fixtures.scorekeeper_gaming_member_id, competition_fixtures.team_a_competition_team_id,
         competition_fixtures.team_b_competition_team_id
    into v_competition_id, v_fixture_role, v_fixture_state, v_scorekeeper_id, v_team_a, v_team_b
    from competition_fixtures
   where competition_fixtures.competition_fixture_id = p_competition_fixture_id
   for update;

  if v_competition_id is null then
    raise exception 'FIXTURE_NOT_FOUND: no such fixture exists' using errcode = 'P0001';
  end if;

  -- UG-CR-GATE-091: authorization comes BEFORE the idempotent replay. The caller must be the exact organizer of this fixture's
  -- own competition (and, for a host, still hold the capability) before this function says anything about the fixture:
  -- a retry by the organizer is answered from the existing result below; everyone else, NULL included, gets the same
  -- bounded refusal whether or not a result exists, so a private result is never confirmed, described or returned.
  select competitions.organizer_gaming_member_id, competitions.state
    into v_organizer_id, v_competition_state
    from competitions where competitions.competition_id = v_competition_id;
  if p_organizer_gaming_member_id is distinct from v_organizer_id then
    raise exception 'COMPETITION_ACCESS_DENIED: only the organizer may finalize a fixture' using errcode = 'P0001';
  end if;
  perform assert_competition_not_host_revoked(v_competition_id);

  select competition_fixture_finalizations.competition_fixture_finalization_id, competition_fixture_finalizations.outcome_type,
         competition_fixture_finalizations.winning_competition_team_id
    into v_existing_finalization_id, v_existing_outcome, v_existing_winner
    from competition_fixture_finalizations
   where competition_fixture_finalizations.competition_fixture_id = p_competition_fixture_id and competition_fixture_finalizations.is_current;

  if v_existing_finalization_id is not null then
    return query select v_existing_finalization_id, v_existing_outcome, v_existing_winner, true;
    return;
  end if;

  if v_competition_state = 'CANCELLED_WITHOUT_CHAMPION' then
    raise exception 'COMPETITION_CANCELLED: this competition has been cancelled and no longer accepts this action'
      using errcode = 'P0001';
  end if;

  if v_fixture_state <> 'EVIDENCE_SUBMITTED' and v_fixture_state <> 'UNDER_REVIEW' then
    raise exception 'FIXTURE_NOT_READY_TO_FINALIZE: evidence must be submitted before a fixture can be finalized'
      using errcode = 'P0001';
  end if;

  -- Checkpoint 4 of 5: re-verify the scorekeeper is not on either
  -- team's current roster before this fixture's evidence becomes
  -- historical.
  select exists(
    select 1 from competition_roster_revision_entries entries
    join competition_roster_revisions revisions on revisions.competition_roster_revision_id = entries.competition_roster_revision_id
    where revisions.competition_fixture_id = p_competition_fixture_id and revisions.is_current and entries.gaming_member_id = v_scorekeeper_id
  ) into v_on_roster;
  if v_on_roster then
    raise exception 'SCOREKEEPER_CONFLICT_OF_INTEREST: the scorekeeper may not appear on either team''s current roster'
      using errcode = 'P0001';
  end if;

  select competition_fixture_evidence.team_a_score, competition_fixture_evidence.team_b_score
    into v_team_a_score, v_team_b_score
    from competition_fixture_evidence
   where competition_fixture_evidence.competition_fixture_id = p_competition_fixture_id and competition_fixture_evidence.is_current;

  if v_team_a_score is null then
    raise exception 'EVIDENCE_MISSING: no current evidence exists for this fixture' using errcode = 'P0001';
  end if;

  select soccer_penalty_shootouts.winning_competition_team_id into v_shootout_winner
    from soccer_penalty_shootouts
   where soccer_penalty_shootouts.competition_fixture_id = p_competition_fixture_id and soccer_penalty_shootouts.is_current;

  if v_team_a_score = v_team_b_score and v_shootout_winner is null then
    raise exception 'SHOOTOUT_REQUIRED: regulation ended level — finalize requires a recorded shootout winner'
      using errcode = 'P0001';
  end if;

  -- Minimum participation (UG-CR-REV-015 decision 4), re-derived from
  -- current data rather than trusted from evidence-submission time —
  -- the last gate before this fixture's NORMAL outcome becomes historical.
  select
    count(*) filter (where roster.competition_team_id = v_team_a),
    count(*) filter (where roster.competition_team_id = v_team_b)
    into v_team_a_participant_count, v_team_b_participant_count
    from competition_participation_attestations att
    join competition_roster_revision_entries entries on entries.gaming_member_id = att.gaming_member_id
    join competition_roster_revisions roster on roster.competition_roster_revision_id = entries.competition_roster_revision_id
   where att.competition_fixture_id = p_competition_fixture_id
     and att.is_current
     and att.actually_participated
     and roster.competition_fixture_id = p_competition_fixture_id
     and roster.is_current;

  -- UG-CR-GATE-SSS-001: the threshold is a fact of THIS competition's format, read from competition_format_rules, not the literal 4. For
  -- SOCCER_5V5 the registry value is 4, so every existing 5v5 competition behaves exactly as before. A format with no rules row (which the
  -- foreign key on competitions.activity_key makes impossible) fails closed rather than falling back to any number.
  select competition_format_rules.minimum_actual_participants_normal_result
    into v_min_participants
    from competitions
    join competition_format_rules on competition_format_rules.format_key = competitions.activity_key
   where competitions.competition_id = v_competition_id;

  if v_min_participants is null then
    raise exception 'FORMAT_RULES_NOT_FOUND: this competition''s format has no rules, so no normal result can be recorded'
      using errcode = 'P0001';
  end if;

  if coalesce(v_team_a_participant_count, 0) < v_min_participants or coalesce(v_team_b_participant_count, 0) < v_min_participants then
    raise exception 'MINIMUM_PARTICIPATION_NOT_MET: each team requires at least % actually-participating rostered members for a normal result — use forfeit or void instead', v_min_participants
      using errcode = 'P0001';
  end if;

  v_winner := case when v_team_a_score > v_team_b_score then v_team_a
                    when v_team_b_score > v_team_a_score then v_team_b
                    else v_shootout_winner end;

  v_finalized_at := now();

  insert into competition_fixture_finalizations (competition_fixture_id, finalized_by_gaming_member_id, finalized_at, outcome_type, winning_competition_team_id)
  values (p_competition_fixture_id, p_organizer_gaming_member_id, v_finalized_at, 'NORMAL', v_winner)
  returning competition_fixture_finalizations.competition_fixture_finalization_id into v_finalization_id;

  update competition_fixtures set state = 'FINALIZED' where competition_fixtures.competition_fixture_id = p_competition_fixture_id;

  update competition_disputes
     set resolved_at = v_finalized_at, resolved_by_gaming_member_id = p_organizer_gaming_member_id, resolution_action = 'FINALIZED_AS_SUBMITTED'
   where competition_disputes.competition_fixture_id = p_competition_fixture_id and competition_disputes.resolved_at is null;

  for v_member in
    select competition_participation_attestations.gaming_member_id,
           coalesce((select count(*) from soccer_goal_events where soccer_goal_events.competition_fixture_id = p_competition_fixture_id
                       and soccer_goal_events.is_current and soccer_goal_events.scorer_gaming_member_id = competition_participation_attestations.gaming_member_id), 0) as goals,
           coalesce((select count(*) from soccer_assist_events where soccer_assist_events.competition_fixture_id = p_competition_fixture_id
                       and soccer_assist_events.is_current and soccer_assist_events.assisting_gaming_member_id = competition_participation_attestations.gaming_member_id), 0) as assists
      from competition_participation_attestations
     where competition_participation_attestations.competition_fixture_id = p_competition_fixture_id
       and competition_participation_attestations.is_current
       and competition_participation_attestations.actually_participated
  loop
    insert into competition_member_participation_records (competition_id, competition_fixture_id, gaming_member_id, appeared, goals, assists, derived_from_finalization_id, derived_at)
    values (v_competition_id, p_competition_fixture_id, v_member.gaming_member_id, true, v_member.goals, v_member.assists, v_finalization_id, v_finalized_at);
  end loop;

  if v_fixture_role = 'FINAL' then
    update competitions set state = 'COMPLETE' where competitions.competition_id = v_competition_id;
  else
    -- Each semifinal's own finalization independently and atomically
    -- writes only its own slot on the FINAL — the concurrency-safe
    -- mechanism for "simultaneous semifinal finalizations resolving the
    -- final" (UG-CR-RPT-024 §8): neither write depends on reading the
    -- other's slot first, so both can commit in either order or at the
    -- same instant without a lost update.
    select competition_fixtures.competition_fixture_id into v_final_fixture_id
      from competition_fixtures
     where competition_fixtures.competition_id = v_competition_id and competition_fixtures.fixture_role = 'FINAL';

    update competition_fixtures set team_a_competition_team_id = v_winner
     where competition_fixtures.competition_fixture_id = v_final_fixture_id and competition_fixtures.team_a_source_fixture_id = p_competition_fixture_id;

    update competition_fixtures set team_b_competition_team_id = v_winner
     where competition_fixtures.competition_fixture_id = v_final_fixture_id and competition_fixtures.team_b_source_fixture_id = p_competition_fixture_id;
  end if;

  return query select v_finalization_id, 'NORMAL'::text, v_winner, false;
end;
$function$;

revoke all on function finalize_competition_fixture_atomically(uuid,uuid) from public, anon, authenticated;
grant execute on function finalize_competition_fixture_atomically(uuid,uuid) to service_role;
