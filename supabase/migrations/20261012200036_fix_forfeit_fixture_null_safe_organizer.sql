-- FORFEIT_COMPETITION_FIXTURE_ATOMICALLY — null-safe organizer check (UG-CR-GATE-090).
--
-- ROOT CAUSE. The organizer check compared `p_organizer_gaming_member_id <> v_organizer_id`. For a NULL caller that
-- comparison is NULL, PL/pgSQL treats a NULL condition as false, and the denial was skipped. Unlike the evidence and
-- roster paths corrected in GATE-089 nothing later stopped it: the call carried on and mutated state with no
-- authorization at all. The stored organizer column is NOT NULL, so only a NULL CALLER can reach this; the application
-- never passes one (the actor is always the verified session member) and the function is executable only by
-- service_role, so this is defense in depth that brings the last organizer entrypoints to the GATE-089 standard.
--
-- FIX. The comparison is `IS DISTINCT FROM`, so a NULL caller is refused with the function's own existing
-- COMPETITION_ACCESS_DENIED message. Behavior for every non-NULL caller is identical.
--
-- This function answers an idempotent replay BEFORE it reaches the organizer check, so the comparison alone would
-- still hand an existing result to a NULL caller. One explicit NULL test therefore sits after the fixture is locked and
-- read and before that replay. It changes nothing for a non-NULL caller: the existing replay-before-authorization
-- behavior (reported in RPT-088 section 7) is deliberately left exactly as it was.
--
-- Every other line is the definition live after 20261007220029. Signature, SECURITY DEFINER, pinned search_path
-- and the execute grants are unchanged and restated below.

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

  -- UG-CR-GATE-090: a NULL caller is refused here, after the fixture is locked and read and before the idempotent
  -- replay below could answer it. A non-NULL caller reaches the replay and the organizer check exactly as before.
  if p_organizer_gaming_member_id is null then
    raise exception 'COMPETITION_ACCESS_DENIED: only the organizer may forfeit a fixture' using errcode = 'P0001';
  end if;

  select competition_fixture_finalizations.competition_fixture_finalization_id, competition_fixture_finalizations.winning_competition_team_id
    into v_existing_finalization_id, v_existing_winner
    from competition_fixture_finalizations
   where competition_fixture_finalizations.competition_fixture_id = p_competition_fixture_id and competition_fixture_finalizations.is_current;

  if v_existing_finalization_id is not null then
    return query select v_existing_finalization_id, v_existing_winner, true;
    return;
  end if;

  select competitions.organizer_gaming_member_id, competitions.state
    into v_organizer_id, v_competition_state
    from competitions where competitions.competition_id = v_competition_id;
  if p_organizer_gaming_member_id is distinct from v_organizer_id then
    raise exception 'COMPETITION_ACCESS_DENIED: only the organizer may forfeit a fixture' using errcode = 'P0001';
  end if;
  perform assert_competition_not_host_revoked(v_competition_id);

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
