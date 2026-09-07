-- ADD_COMPETITION_TEAM. Organizer only, DRAFT only — teams are seeded
-- during setup, never created by members (UG-CR-RPT-016 §10).
create or replace function add_competition_team_atomically(
  p_competition_id uuid,
  p_organizer_gaming_member_id uuid,
  p_name text,
  p_captain_gaming_member_id uuid
)
returns table (competition_team_id uuid, created_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_organizer_id uuid;
  v_state text;
  v_team_id uuid;
  v_created_at timestamptz;
begin
  select competitions.organizer_gaming_member_id, competitions.state
    into v_organizer_id, v_state
    from competitions
   where competitions.competition_id = p_competition_id
   for update;

  if v_organizer_id is null then
    raise exception 'COMPETITION_NOT_FOUND: no such competition exists' using errcode = 'P0001';
  end if;

  if v_organizer_id <> p_organizer_gaming_member_id then
    raise exception 'COMPETITION_ACCESS_DENIED: only this competition''s own organizer may add a team'
      using errcode = 'P0001';
  end if;

  if v_state <> 'DRAFT' then
    raise exception 'COMPETITION_NOT_DRAFT: teams may only be added while the competition is DRAFT'
      using errcode = 'P0001';
  end if;

  insert into competition_teams (competition_id, name, captain_gaming_member_id)
  values (p_competition_id, p_name, p_captain_gaming_member_id)
  returning competition_teams.competition_team_id, competition_teams.created_at
  into v_team_id, v_created_at;

  return query select v_team_id, v_created_at;
end;
$$;

revoke all on function add_competition_team_atomically(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function add_competition_team_atomically(uuid, uuid, text, uuid) to service_role;
