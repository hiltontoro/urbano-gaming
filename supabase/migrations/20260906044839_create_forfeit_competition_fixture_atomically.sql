-- FORFEIT_COMPETITION_FIXTURE. Organizer only, reason required. Applies
-- when exactly one team is below the configured four-actual-participant
-- minimum (UG-CR-REV-021 decision/UG-CR-RPT-024 §6) — this RPC trusts
-- the organizer's own judgment that the threshold condition holds
-- (Slice 001 does not compute the count itself, since "actual
-- participation" is only fully known once evidence exists, and a
-- forfeit is precisely the path taken when it does not). Produces only
-- a team-level winner; no individual appearance/goal/assist is ever
-- invented for either team, mirroring the shootout/finalize path's own
-- winner-derivation shape but without any evidence bundle.
create or replace function forfeit_competition_fixture_atomically(
  p_competition_fixture_id uuid,
  p_organizer_gaming_member_id uuid,
  p_forfeiting_competition_team_id uuid,
  p_reason text
)
returns table (competition_fixture_finalization_id uuid, winning_competition_team_id uuid, already_finalized boolean)
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

  select competition_fixtures.competition_id, competition_fixtures.fixture_role, competition_fixtures.state,
         competition_fixtures.team_a_competition_team_id, competition_fixtures.team_b_competition_team_id
    into v_competition_id, v_fixture_role, v_fixture_state, v_team_a, v_team_b
    from competition_fixtures where competition_fixtures.competition_fixture_id = p_competition_fixture_id for update;

  if v_competition_id is null then
    raise exception 'FIXTURE_NOT_FOUND: no such fixture exists' using errcode = 'P0001';
  end if;

  select competition_fixture_finalizations.competition_fixture_finalization_id, competition_fixture_finalizations.winning_competition_team_id
    into v_existing_finalization_id, v_existing_winner
    from competition_fixture_finalizations
   where competition_fixture_finalizations.competition_fixture_id = p_competition_fixture_id and competition_fixture_finalizations.is_current;

  if v_existing_finalization_id is not null then
    return query select v_existing_finalization_id, v_existing_winner, true;
    return;
  end if;

  select competitions.organizer_gaming_member_id into v_organizer_id from competitions where competitions.competition_id = v_competition_id;
  if p_organizer_gaming_member_id <> v_organizer_id then
    raise exception 'COMPETITION_ACCESS_DENIED: only the organizer may forfeit a fixture' using errcode = 'P0001';
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
$$;

revoke all on function forfeit_competition_fixture_atomically(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function forfeit_competition_fixture_atomically(uuid, uuid, uuid, text) to service_role;
