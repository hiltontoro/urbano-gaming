-- CLOSE_TEAM_REGISTRATION — add competition-scoped serialization lock
-- (UG-CR-GATE-083 per UG-CR-REV-054 finding 1). See
-- 20261005090000_add_serialization_lock_to_cancel_incomplete_competition.sql
-- for the full rationale and the one global lock order this domain now
-- follows: competition_scope is always acquired before the existing
-- 'competition_team_scope:' lock, never the reverse, anywhere in this
-- domain — this function already demonstrates that ordering, since its
-- own pre-existing team_scope lock stays exactly where it was, strictly
-- after the new competition_scope lock inserted at the top.
-- p_competition_id is a direct parameter, so competition_scope is
-- acquired as the very first statement, before the existing FOR UPDATE
-- select. Every other line is unchanged from
-- 20260908100345_create_close_team_registration_atomically.sql.
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
  perform pg_advisory_xact_lock(hashtext('competition_scope:' || p_competition_id::text));

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
