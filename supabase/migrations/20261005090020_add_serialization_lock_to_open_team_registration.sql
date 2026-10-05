-- OPEN_TEAM_REGISTRATION — add competition-scoped serialization lock
-- (UG-CR-GATE-083 per UG-CR-REV-054 finding 1). See
-- 20261005090000_add_serialization_lock_to_cancel_incomplete_competition.sql
-- for the full rationale and the one global lock order this domain now
-- follows. p_competition_id is a direct parameter, so the lock is
-- acquired as the very first statement, before the existing FOR UPDATE
-- select. Every other line is unchanged from
-- 20260908100338_create_open_team_registration_atomically.sql.
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
