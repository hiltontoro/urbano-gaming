-- CLOSE_TEAM_REGISTRATION (UG-CR-RPT-041 §3/§4). Organizer only,
-- TEAM_REGISTRATION_OPEN only, exactly four ACCEPTED teams required —
-- the deliberate, explicit checkpoint that freezes the accepted team set
-- before pairing/publish, rather than an implicit auto-transition on the
-- fourth accept. Locking the competitions row (for update) before this
-- transition, exactly like every other Competitions state transition,
-- already serializes this against a concurrent
-- ADD_COMPETITION_TEAM/PROPOSE_COMPETITION_TEAM for the SAME row (both
-- also lock competitions for update first) — the additional advisory
-- lock below further serializes the four-accepted-team recount against a
-- concurrent DECIDE_COMPETITION_TEAM accept, which does not lock the
-- competitions row itself.
create or replace function close_team_registration_atomically(
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
  v_accepted_count integer;
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
    raise exception 'COMPETITION_ACCESS_DENIED: only this competition''s own organizer may close team registration'
      using errcode = 'P0001';
  end if;

  if v_state <> 'TEAM_REGISTRATION_OPEN' then
    raise exception 'TEAM_REGISTRATION_NOT_OPEN: team registration is not currently open'
      using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('competition_team_scope:' || p_competition_id::text));

  select count(*) into v_accepted_count
    from competition_teams
   where competition_teams.competition_id = p_competition_id
     and competition_teams.status = 'ACCEPTED';

  if v_accepted_count <> 4 then
    raise exception 'TEAM_REGISTRATION_CAPACITY_NOT_REACHED: exactly four accepted teams are required to close team registration (found %)', v_accepted_count
      using errcode = 'P0001';
  end if;

  update competitions set state = 'READY_TO_PUBLISH' where competitions.competition_id = p_competition_id;

  return query select p_competition_id, 'READY_TO_PUBLISH'::text;
end;
$$;

revoke all on function close_team_registration_atomically(uuid, uuid) from public, anon, authenticated;
grant execute on function close_team_registration_atomically(uuid, uuid) to service_role;
