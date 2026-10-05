-- FORFEIT_COMPETITION_FIXTURE — add cancellation guard (UG-CR-GATE-082
-- per UG-CR-REV-053 #3: "finalization actions" was named explicitly).
-- The function read competitions.organizer_gaming_member_id but never
-- competitions.state — reachable in practice once a DIFFERENT fixture's
-- void has already cascaded this same competition to
-- CANCELLED_WITHOUT_CHAMPION, since that cascade leaves every OTHER
-- fixture's own state untouched. The idempotent "already finalized"
-- replay (an existing finalization on THIS fixture, pure read, no
-- mutation) is deliberately left unguarded, matching
-- cancel_incomplete_competition_atomically's own idempotent branch —
-- only a genuinely NEW forfeit is blocked. Every other line is
-- unchanged from
-- 20260906044839_create_forfeit_competition_fixture_atomically.sql —
-- only the organizer-lookup select now also reads competitions.state,
-- and one new guard is inserted immediately after the existing
-- COMPETITION_ACCESS_DENIED check.
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

  select competitions.organizer_gaming_member_id, competitions.state
    into v_organizer_id, v_competition_state
    from competitions where competitions.competition_id = v_competition_id;
  if p_organizer_gaming_member_id <> v_organizer_id then
    raise exception 'COMPETITION_ACCESS_DENIED: only the organizer may forfeit a fixture' using errcode = 'P0001';
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
$$;

revoke all on function forfeit_competition_fixture_atomically(uuid, uuid, uuid, text) from public, anon, authenticated;
grant execute on function forfeit_competition_fixture_atomically(uuid, uuid, uuid, text) to service_role;
