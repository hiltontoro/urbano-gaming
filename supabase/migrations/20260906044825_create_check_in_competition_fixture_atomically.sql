-- CHECK_IN. Self-service; requires the caller be on this fixture's
-- current roster (either team). Presence only, never participation
-- (UG-CR-RPT-016 §6). Idempotent: a repeat check-in returns the
-- original timestamp. The fixture transitions ROSTER_DECLARED ->
-- CHECKIN_OPEN on the first check-in recorded for it (Slice 001 has no
-- separate organizer "open check-in" action documented anywhere in the
-- accepted design — check-in becomes possible, and the state reflects
-- it, as soon as a roster exists for both teams).
create or replace function check_in_competition_fixture_atomically(
  p_competition_fixture_id uuid,
  p_gaming_member_id uuid
)
returns table (competition_checkin_id uuid, checked_in_at timestamptz, already_checked_in boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_fixture_state text;
  v_on_roster boolean;
  v_existing_id uuid;
  v_existing_at timestamptz;
  v_new_id uuid;
  v_new_at timestamptz;
begin
  select competition_fixtures.state into v_fixture_state
    from competition_fixtures
   where competition_fixtures.competition_fixture_id = p_competition_fixture_id
   for update;

  if v_fixture_state is null then
    raise exception 'FIXTURE_NOT_FOUND: no such fixture exists' using errcode = 'P0001';
  end if;

  select competition_checkins.competition_checkin_id, competition_checkins.checked_in_at
    into v_existing_id, v_existing_at
    from competition_checkins
   where competition_checkins.competition_fixture_id = p_competition_fixture_id
     and competition_checkins.gaming_member_id = p_gaming_member_id;

  if v_existing_id is not null then
    return query select v_existing_id, v_existing_at, true;
    return;
  end if;

  if v_fixture_state not in ('ROSTER_DECLARED', 'CHECKIN_OPEN') then
    raise exception 'FIXTURE_NOT_READY_FOR_CHECKIN: this fixture is not currently open for check-in'
      using errcode = 'P0001';
  end if;

  select exists(
    select 1
      from competition_roster_revision_entries entries
      join competition_roster_revisions revisions
        on revisions.competition_roster_revision_id = entries.competition_roster_revision_id
     where revisions.competition_fixture_id = p_competition_fixture_id
       and revisions.is_current
       and entries.gaming_member_id = p_gaming_member_id
  ) into v_on_roster;

  if not v_on_roster then
    raise exception 'NOT_ON_ROSTER: this member is not on either team''s current roster for this fixture'
      using errcode = 'P0001';
  end if;

  v_new_at := now();

  insert into competition_checkins (competition_fixture_id, gaming_member_id, checked_in_at)
  values (p_competition_fixture_id, p_gaming_member_id, v_new_at)
  returning competition_checkins.competition_checkin_id into v_new_id;

  if v_fixture_state = 'ROSTER_DECLARED' then
    update competition_fixtures set state = 'CHECKIN_OPEN' where competition_fixtures.competition_fixture_id = p_competition_fixture_id;
  end if;

  return query select v_new_id, v_new_at, false;
end;
$$;

revoke all on function check_in_competition_fixture_atomically(uuid, uuid) from public, anon, authenticated;
grant execute on function check_in_competition_fixture_atomically(uuid, uuid) to service_role;
