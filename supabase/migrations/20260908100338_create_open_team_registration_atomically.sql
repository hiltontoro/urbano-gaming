-- OPEN_TEAM_REGISTRATION (UG-CR-RPT-041 §3/§4). Organizer only, DRAFT
-- only. Entering TEAM_REGISTRATION_OPEN is what makes a competition
-- member-visible (see the corrected listCompetitions filter) and opens
-- both REGISTER_FOR_COMPETITION and PROPOSE_COMPETITION_TEAM — this
-- function itself only performs the state transition; every one of
-- those downstream preconditions is re-verified inside its own RPC, not
-- assumed from this one having run.
create or replace function open_team_registration_atomically(
  p_competition_id uuid,
  p_organizer_gaming_member_id uuid
)
returns table (competition_id uuid, state text)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_organizer_id uuid;
  v_state text;
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
    raise exception 'COMPETITION_ACCESS_DENIED: only this competition''s own organizer may open team registration'
      using errcode = 'P0001';
  end if;

  if v_state <> 'DRAFT' then
    raise exception 'COMPETITION_NOT_DRAFT: team registration may only be opened while the competition is DRAFT'
      using errcode = 'P0001';
  end if;

  update competitions set state = 'TEAM_REGISTRATION_OPEN' where competitions.competition_id = p_competition_id;

  return query select p_competition_id, 'TEAM_REGISTRATION_OPEN'::text;
end;
$$;

revoke all on function open_team_registration_atomically(uuid, uuid) from public, anon, authenticated;
grant execute on function open_team_registration_atomically(uuid, uuid) to service_role;
