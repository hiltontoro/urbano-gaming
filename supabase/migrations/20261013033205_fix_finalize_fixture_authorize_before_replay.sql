-- FINALIZE_COMPETITION_FIXTURE_ATOMICALLY — authorization before the idempotent replay (UG-CR-GATE-091).
--
-- ROOT CAUSE. This function answered an idempotent replay BEFORE it asked who was calling. A non-NULL authenticated stranger
-- who knew a finalized fixture's id therefore received the existing finalization id and outcome through the service route.
-- That is incompatible with private competitions: a result's existence and outcome are private to its organizer. (GATE-090
-- already refused a NULL caller before the replay; every other caller was still answered.)
--
-- FIX. The fixture is still locked and loaded first. The organizer and competition state are then derived from the fixture's
-- own competition and the caller is validated — exact organizer, IS DISTINCT FROM so NULL can never pass, then the GATE-088
-- host revocation guard — before the replay lookup or anything else. An authorized retry still returns the existing result
-- (it reaches the replay exactly as before, ahead of the cancellation and lifecycle checks). An unauthorized caller gets the
-- function's own COMPETITION_ACCESS_DENIED whether or not the fixture has been finalized, and nothing is read from or written
-- to the finalization tables. The GATE-090 explicit NULL test is removed because this check now precedes the replay and
-- already refuses NULL. A revoked host's retry is now refused (HOST_ACCESS_REVOKED) instead of answered.
--
-- Every other line is the definition live after 20261012200034. Signature, SECURITY DEFINER, pinned search_path and the execute grants
-- are unchanged and restated below.

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

  if coalesce(v_team_a_participant_count, 0) < 4 or coalesce(v_team_b_participant_count, 0) < 4 then
    raise exception 'MINIMUM_PARTICIPATION_NOT_MET: each team requires at least 4 actually-participating rostered members for a normal result — use forfeit or void instead'
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
