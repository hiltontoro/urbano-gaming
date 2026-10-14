-- VOID_COMPETITION_FIXTURE_ATOMICALLY — authorization before the idempotent replay (UG-CR-GATE-091).
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
-- Every other line is the definition live after 20261012200037. Signature, SECURITY DEFINER, pinned search_path and the execute grants
-- are unchanged and restated below.

CREATE OR REPLACE FUNCTION public.void_competition_fixture_atomically(p_competition_fixture_id uuid, p_organizer_gaming_member_id uuid, p_reason text)
 RETURNS TABLE(competition_fixture_finalization_id uuid, competition_state text, already_finalized boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_lookup_competition_id uuid;
  v_competition_id uuid;
  v_competition_state text;
  v_organizer_id uuid;
  v_existing_finalization_id uuid;
  v_finalized_at timestamptz;
  v_finalization_id uuid;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'REASON_REQUIRED: a void requires a reason' using errcode = 'P0001';
  end if;

  select competition_fixtures.competition_id into v_lookup_competition_id
    from competition_fixtures
   where competition_fixtures.competition_fixture_id = p_competition_fixture_id;

  if v_lookup_competition_id is null then
    raise exception 'FIXTURE_NOT_FOUND: no such fixture exists' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('competition_scope:' || v_lookup_competition_id::text));

  select competition_fixtures.competition_id into v_competition_id
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
    raise exception 'COMPETITION_ACCESS_DENIED: only the organizer may void a fixture' using errcode = 'P0001';
  end if;
  perform assert_competition_not_host_revoked(v_competition_id);

  select competition_fixture_finalizations.competition_fixture_finalization_id into v_existing_finalization_id
    from competition_fixture_finalizations
   where competition_fixture_finalizations.competition_fixture_id = p_competition_fixture_id and competition_fixture_finalizations.is_current;

  if v_existing_finalization_id is not null then
    return query select v_existing_finalization_id, (select competitions.state from competitions where competitions.competition_id = v_competition_id), true;
    return;
  end if;

  if v_competition_state = 'CANCELLED_WITHOUT_CHAMPION' then
    raise exception 'COMPETITION_CANCELLED: this competition has been cancelled and no longer accepts this action'
      using errcode = 'P0001';
  end if;

  v_finalized_at := now();

  insert into competition_fixture_finalizations (competition_fixture_id, finalized_by_gaming_member_id, finalized_at, outcome_type, winning_competition_team_id, reason)
  values (p_competition_fixture_id, p_organizer_gaming_member_id, v_finalized_at, 'VOID', null, p_reason)
  returning competition_fixture_finalizations.competition_fixture_finalization_id into v_finalization_id;

  update competition_fixtures set state = 'VOID' where competition_fixtures.competition_fixture_id = p_competition_fixture_id;

  update competition_disputes
     set resolved_at = v_finalized_at, resolved_by_gaming_member_id = p_organizer_gaming_member_id, resolution_action = 'VOIDED'
   where competition_disputes.competition_fixture_id = p_competition_fixture_id and competition_disputes.resolved_at is null;

  update competitions
     set state = 'CANCELLED_WITHOUT_CHAMPION', cancelled_reason = p_reason
   where competitions.competition_id = v_competition_id;

  return query select v_finalization_id, 'CANCELLED_WITHOUT_CHAMPION'::text, false;
end;
$function$;

revoke all on function void_competition_fixture_atomically(uuid,uuid,text) from public, anon, authenticated;
grant execute on function void_competition_fixture_atomically(uuid,uuid,text) to service_role;
