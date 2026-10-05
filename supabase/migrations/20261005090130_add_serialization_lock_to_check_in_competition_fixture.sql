-- CHECK_IN — add competition-scoped serialization lock (UG-CR-GATE-083
-- per UG-CR-REV-054 finding 1). See
-- 20261005090000_add_serialization_lock_to_cancel_incomplete_competition.sql
-- for the full rationale. This function's ORIGINAL first operation was
-- a FOR UPDATE lock on competition_fixtures before competition_id was
-- known. A small plain preliminary lookup now resolves competition_id
-- and checks FIXTURE_NOT_FOUND first; competition_scope is acquired
-- next; only then does the ORIGINAL FOR UPDATE select run exactly as
-- before (harmlessly re-reading competition_id alongside fixture
-- state). The idempotent "already checked in" replay is now itself
-- protected by competition_scope too (a pure read, so this costs
-- nothing but a moment's wait if cancellation is mid-flight) — still
-- unguarded against CANCELLED specifically, matching cancel_
-- incomplete_competition_atomically's own idempotent-replay posture.
-- Every other line is unchanged from
-- 20261002090050_add_cancellation_guard_to_check_in_competition_fixture.sql.
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
  v_lookup_competition_id uuid;
  v_competition_id uuid;
  v_competition_state text;
  v_fixture_state text;
  v_on_roster boolean;
  v_existing_id uuid;
  v_existing_at timestamptz;
  v_new_id uuid;
  v_new_at timestamptz;
begin
  select competition_fixtures.competition_id into v_lookup_competition_id
    from competition_fixtures
   where competition_fixtures.competition_fixture_id = p_competition_fixture_id;

  if v_lookup_competition_id is null then
    raise exception 'FIXTURE_NOT_FOUND: no such fixture exists' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('competition_scope:' || v_lookup_competition_id::text));

  select competition_fixtures.competition_id, competition_fixtures.state
    into v_competition_id, v_fixture_state
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

  select competitions.state into v_competition_state
    from competitions where competitions.competition_id = v_competition_id;

  if v_competition_state = 'CANCELLED_WITHOUT_CHAMPION' then
    raise exception 'COMPETITION_CANCELLED: this competition has been cancelled and no longer accepts this action'
      using errcode = 'P0001';
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
