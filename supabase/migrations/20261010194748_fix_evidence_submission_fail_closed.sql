-- SUBMIT_COMPETITION_FIXTURE_EVIDENCE — scorekeeper authorization fails closed (UG-CR-GATE-089, correcting a
-- defect reported in UG-CR-RPT-088).
--
-- ROOT CAUSE. The function compared `p_scorekeeper_gaming_member_id <> v_appointed_scorekeeper`. When no
-- scorekeeper had been appointed (the column is NULL until the organizer appoints one) the comparison evaluates to
-- NULL, PL/pgSQL treats a NULL condition as false, and the denial was skipped: any member who knew the fixture id
-- passed the access check and was stopped, if at all, only by a later fixture-state check. The check also sat AFTER
-- the idempotent replay and the cancellation check, so an existing result could be returned to anyone.
--
-- FIX. Authorization is now the first decision after the fixture is loaded under the competition_scope advisory
-- lock and a row lock, before the replay, the cancellation and fixture-state checks, and any write. The caller must
-- be the scorekeeper appointed to THIS fixture; no appointment, a NULL caller, a different member, a scorekeeper of
-- another fixture or competition, the organizer, a captain or a host all receive the same COMPETITION_ACCESS_DENIED
-- (the comparison is IS DISTINCT FROM plus explicit NULL tests). The GATE-088 host guard follows immediately.
-- The organizer's documented correction path (correct_competition_fixture_atomically) is a separate, unchanged
-- entrypoint whose authority is derived from the fixture's own competition.
--
-- Every other line of the function is the definition live after 20261007220644. Signature, SECURITY DEFINER, pinned
-- search_path and the execute grants are unchanged and restated below.

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

  if coalesce(v_team_a_participant_count, 0) < 4 or coalesce(v_team_b_participant_count, 0) < 4 then
    raise exception 'MINIMUM_PARTICIPATION_NOT_MET: each team requires at least 4 actually-participating rostered members for a normal result — use forfeit or void instead'
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
