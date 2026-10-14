-- FORFEIT_COMPETITION_FIXTURE_ATOMICALLY — authorization before the idempotent replay (UG-CR-GATE-091).
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
-- Every other line is the definition live after 20261012200036. Signature, SECURITY DEFINER, pinned search_path and the execute grants
-- are unchanged and restated below.

CREATE OR REPLACE FUNCTION public.forfeit_competition_fixture_atomically(p_competition_fixture_id uuid, p_organizer_gaming_member_id uuid, p_forfeiting_competition_team_id uuid, p_reason text)
 RETURNS TABLE(competition_fixture_finalization_id uuid, winning_competition_team_id uuid, already_finalized boolean)
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
  v_team_a uuid;
  v_team_b uuid;
  v_existing_finalization_id uuid;
  v_existing_winner uuid;
  v_winner uuid;
  v_finalized_at timestamptz;
  v_finalization_id uuid;
  v_final_fixture_id uuid;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'REASON_REQUIRED: a forfeit requires a reason' using errcode = 'P0001';
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
    from competition_fixtures where competition_fixtures.competition_fixture_id = p_competition_fixture_id for update;

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
    raise exception 'COMPETITION_ACCESS_DENIED: only the organizer may forfeit a fixture' using errcode = 'P0001';
  end if;
  perform assert_competition_not_host_revoked(v_competition_id);

  select competition_fixture_finalizations.competition_fixture_finalization_id, competition_fixture_finalizations.winning_competition_team_id
    into v_existing_finalization_id, v_existing_winner
    from competition_fixture_finalizations
   where competition_fixture_finalizations.competition_fixture_id = p_competition_fixture_id and competition_fixture_finalizations.is_current;

  if v_existing_finalization_id is not null then
    return query select v_existing_finalization_id, v_existing_winner, true;
    return;
  end if;

  if v_competition_state = 'CANCELLED_WITHOUT_CHAMPION' then
    raise exception 'COMPETITION_CANCELLED: this competition has been cancelled and no longer accepts this action'
      using errcode = 'P0001';
  end if;

  if p_forfeiting_competition_team_id not in (v_team_a, v_team_b) then
    raise exception 'INVALID_FORFEITING_TEAM: the forfeiting team must be one of the two competing teams' using errcode = 'P0001';
  end if;

  v_winner := case when p_forfeiting_competition_team_id = v_team_a then v_team_b else v_team_a end;
  v_finalized_at := now();

  insert into competition_fixture_finalizations (competition_fixture_id, finalized_by_gaming_member_id, finalized_at, outcome_type, winning_competition_team_id, reason)
  values (p_competition_fixture_id, p_organizer_gaming_member_id, v_finalized_at, 'FORFEIT', v_winner, p_reason)
  returning competition_fixture_finalizations.competition_fixture_finalization_id into v_finalization_id;

  update competition_fixtures set state = 'FORFEIT_FINALIZED' where competition_fixtures.competition_fixture_id = p_competition_fixture_id;

  update competition_disputes
     set resolved_at = v_finalized_at, resolved_by_gaming_member_id = p_organizer_gaming_member_id, resolution_action = 'FINALIZED_AS_SUBMITTED'
   where competition_disputes.competition_fixture_id = p_competition_fixture_id and competition_disputes.resolved_at is null;

  if v_fixture_role = 'FINAL' then
    update competitions set state = 'COMPLETE' where competitions.competition_id = v_competition_id;
  else
    select competition_fixtures.competition_fixture_id into v_final_fixture_id
      from competition_fixtures where competition_fixtures.competition_id = v_competition_id and competition_fixtures.fixture_role = 'FINAL';

    update competition_fixtures set team_a_competition_team_id = v_winner
     where competition_fixtures.competition_fixture_id = v_final_fixture_id and competition_fixtures.team_a_source_fixture_id = p_competition_fixture_id;
    update competition_fixtures set team_b_competition_team_id = v_winner
     where competition_fixtures.competition_fixture_id = v_final_fixture_id and competition_fixtures.team_b_source_fixture_id = p_competition_fixture_id;
  end if;

  return query select v_finalization_id, v_winner, false;
end;
$function$;

revoke all on function forfeit_competition_fixture_atomically(uuid,uuid,uuid,text) from public, anon, authenticated;
grant execute on function forfeit_competition_fixture_atomically(uuid,uuid,uuid,text) to service_role;
