-- APPOINT_COMPETITION_SCOREKEEPER — add cancellation guard
-- (UG-CR-GATE-082 per UG-CR-REV-053 #3: "scorekeeper" was named
-- explicitly). The function read competitions.organizer_gaming_member_id
-- but never competitions.state. Every other line is unchanged from
-- 20260906044827_create_appoint_competition_scorekeeper_atomically.sql —
-- only the organizer-lookup select now also reads competitions.state,
-- and one new guard is inserted immediately after the existing
-- COMPETITION_ACCESS_DENIED check.
create or replace function appoint_competition_scorekeeper_atomically(
  p_competition_fixture_id uuid,
  p_organizer_gaming_member_id uuid,
  p_scorekeeper_gaming_member_id uuid
)
returns table (competition_fixture_id uuid, scorekeeper_gaming_member_id uuid)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_competition_id uuid;
  v_competition_state text;
  v_organizer_id uuid;
  v_team_a_captain uuid;
  v_team_b_captain uuid;
  v_on_roster boolean;
begin
  select competition_fixtures.competition_id into v_competition_id
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
    raise exception 'COMPETITION_ACCESS_DENIED: only the organizer may appoint a scorekeeper' using errcode = 'P0001';
  end if;

  if v_competition_state = 'CANCELLED_WITHOUT_CHAMPION' then
    raise exception 'COMPETITION_CANCELLED: this competition has been cancelled and no longer accepts this action'
      using errcode = 'P0001';
  end if;

  select ct_a.captain_gaming_member_id, ct_b.captain_gaming_member_id
    into v_team_a_captain, v_team_b_captain
    from competition_fixtures cf
    left join competition_teams ct_a on ct_a.competition_team_id = cf.team_a_competition_team_id
    left join competition_teams ct_b on ct_b.competition_team_id = cf.team_b_competition_team_id
   where cf.competition_fixture_id = p_competition_fixture_id;

  if p_scorekeeper_gaming_member_id = v_team_a_captain or p_scorekeeper_gaming_member_id = v_team_b_captain then
    raise exception 'SCOREKEEPER_CONFLICT_OF_INTEREST: neither competing team''s captain may be this fixture''s scorekeeper'
      using errcode = 'P0001';
  end if;

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
    raise exception 'SCOREKEEPER_CONFLICT_OF_INTEREST: an active player on either team''s roster may not be this fixture''s scorekeeper'
      using errcode = 'P0001';
  end if;

  update competition_fixtures
     set scorekeeper_gaming_member_id = p_scorekeeper_gaming_member_id
   where competition_fixtures.competition_fixture_id = p_competition_fixture_id;

  return query select p_competition_fixture_id, p_scorekeeper_gaming_member_id;
end;
$$;

revoke all on function appoint_competition_scorekeeper_atomically(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function appoint_competition_scorekeeper_atomically(uuid, uuid, uuid) to service_role;
