-- CORRECT_COMPETITION_FIXTURE. Organizer only, reason always required.
-- Scope decision, disclosed rather than silently assumed: a correction
-- supersedes the fixture's ENTIRE evidence bundle (score, goal events,
-- assist events, shootout) with a corrected replacement, rather than
-- patching one field in isolation — every prior row is marked
-- is_current = false, never deleted, and the new bundle is validated
-- with the same regulation-score-vs-event-count rule as the original
-- submission (UG-CR-RPT-024 §6). Participation attestations may also be
-- corrected in the same call.
--
-- If this fixture already has a current finalization (a post-
-- finalization correction), a NEW CompetitionFixtureFinalizationRecord
-- is written superseding the old one, carrying whichever winner the
-- corrected evidence now implies, and every actually-participated
-- member's CompetitionMemberParticipationRecord is likewise re-derived
-- and superseded (never left stale from the original finalization) —
-- UG-CR-GATE-029's own local-demo step 9, "a correction supersedes the
-- prior record without erasing history." If this fixture is a SEMIFINAL and
-- the recomputed winner differs from the finalization being superseded
-- (a winner-changing correction, UG-CR-RPT-024 §7), this same
-- transaction cascades: before the FINAL's check-in opens, the FINAL's
-- corresponding team slot is atomically updated and the displaced
-- team's current FINAL roster (if any) is superseded; once the FINAL's
-- check-in has opened, the whole competition instead terminates as
-- CANCELLED_WITHOUT_CHAMPION, retaining every prior assertion.
create or replace function correct_competition_fixture_atomically(
  p_competition_fixture_id uuid,
  p_organizer_gaming_member_id uuid,
  p_reason text,
  p_team_a_score integer,
  p_team_b_score integer,
  p_goal_events jsonb,
  p_assist_events jsonb,
  p_penalty_shootout_winning_team_id uuid
)
returns table (
  competition_fixture_evidence_id uuid,
  new_winning_competition_team_id uuid,
  competition_state text,
  cascade_outcome text
)
language plpgsql
security definer
set search_path = public
as $$
declare
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
  v_member record;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'REASON_REQUIRED: a correction requires a reason' using errcode = 'P0001';
  end if;

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

  if p_organizer_gaming_member_id <> v_organizer_id then
    raise exception 'COMPETITION_ACCESS_DENIED: only the organizer may correct fixture evidence' using errcode = 'P0001';
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

  if coalesce(v_team_a_participant_count, 0) < 4 or coalesce(v_team_b_participant_count, 0) < 4 then
    raise exception 'MINIMUM_PARTICIPATION_NOT_MET: each team requires at least 4 actually-participating rostered members for a normal result — use forfeit or void instead'
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
$$;

revoke all on function correct_competition_fixture_atomically(uuid, uuid, text, integer, integer, jsonb, jsonb, uuid) from public, anon, authenticated;
grant execute on function correct_competition_fixture_atomically(uuid, uuid, text, integer, integer, jsonb, jsonb, uuid) to service_role;
