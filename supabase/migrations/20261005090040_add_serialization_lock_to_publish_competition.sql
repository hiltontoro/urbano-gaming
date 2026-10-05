-- PUBLISH_COMPETITION — add competition-scoped serialization lock
-- (UG-CR-GATE-083 per UG-CR-REV-054 finding 1). See
-- 20261005090000_add_serialization_lock_to_cancel_incomplete_competition.sql
-- for the full rationale and the one global lock order this domain now
-- follows. p_competition_id is a direct parameter, so the lock is
-- acquired as the very first statement, before the existing FOR UPDATE
-- select. Every other line is unchanged from
-- 20260908100347_replace_publish_competition_atomically_ready_to_publish.sql.
create or replace function publish_competition_atomically(
  p_competition_id uuid,
  p_organizer_gaming_member_id uuid,
  p_semifinal_1_team_a_id uuid,
  p_semifinal_1_team_b_id uuid,
  p_semifinal_2_team_a_id uuid,
  p_semifinal_2_team_b_id uuid,
  p_semifinal_1_scheduled_at timestamptz,
  p_semifinal_2_scheduled_at timestamptz,
  p_final_scheduled_at timestamptz
)
returns table (
  competition_id uuid,
  state text,
  published_at timestamptz,
  semifinal_1_fixture_id uuid,
  semifinal_2_fixture_id uuid,
  final_fixture_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_organizer_id uuid;
  v_state text;
  v_team_count integer;
  v_distinct_pairing_count integer;
  v_published_at timestamptz;
  v_sf1_id uuid;
  v_sf2_id uuid;
  v_final_id uuid;
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
    raise exception 'COMPETITION_ACCESS_DENIED: only this competition''s own organizer may publish it'
      using errcode = 'P0001';
  end if;

  if v_state <> 'READY_TO_PUBLISH' then
    raise exception 'COMPETITION_NOT_READY_TO_PUBLISH: a competition may only be published from READY_TO_PUBLISH'
      using errcode = 'P0001';
  end if;

  select count(*) into v_team_count
    from competition_teams
   where competition_teams.competition_id = p_competition_id
     and competition_teams.status = 'ACCEPTED';

  if v_team_count <> 4 then
    raise exception 'COMPETITION_TEAM_COUNT_INVALID: exactly four accepted teams are required to publish (found %)', v_team_count
      using errcode = 'P0001';
  end if;

  select count(distinct team_id) into v_distinct_pairing_count
    from unnest(array[p_semifinal_1_team_a_id, p_semifinal_1_team_b_id,
                       p_semifinal_2_team_a_id, p_semifinal_2_team_b_id]) as team_id;

  if v_distinct_pairing_count <> 4 then
    raise exception 'COMPETITION_PAIRING_INVALID: the four semifinal pairing slots must name four distinct teams'
      using errcode = 'P0001';
  end if;

  if exists (
    select 1 from unnest(array[p_semifinal_1_team_a_id, p_semifinal_1_team_b_id,
                                p_semifinal_2_team_a_id, p_semifinal_2_team_b_id]) as team_id
    where not exists (
      select 1 from competition_teams
      where competition_teams.competition_team_id = team_id
        and competition_teams.competition_id = p_competition_id
        and competition_teams.status = 'ACCEPTED'
    )
  ) then
    raise exception 'COMPETITION_PAIRING_INVALID: every paired team must belong to this competition and be accepted'
      using errcode = 'P0001';
  end if;

  v_published_at := now();

  insert into competition_fixtures (competition_id, fixture_role, scheduled_at, team_a_competition_team_id, team_b_competition_team_id, state)
  values (p_competition_id, 'SEMIFINAL_1', p_semifinal_1_scheduled_at, p_semifinal_1_team_a_id, p_semifinal_1_team_b_id, 'SCHEDULED')
  returning competition_fixtures.competition_fixture_id into v_sf1_id;

  insert into competition_fixtures (competition_id, fixture_role, scheduled_at, team_a_competition_team_id, team_b_competition_team_id, state)
  values (p_competition_id, 'SEMIFINAL_2', p_semifinal_2_scheduled_at, p_semifinal_2_team_a_id, p_semifinal_2_team_b_id, 'SCHEDULED')
  returning competition_fixtures.competition_fixture_id into v_sf2_id;

  insert into competition_fixtures (competition_id, fixture_role, scheduled_at, team_a_source_fixture_id, team_b_source_fixture_id, state)
  values (p_competition_id, 'FINAL', p_final_scheduled_at, v_sf1_id, v_sf2_id, 'SCHEDULED')
  returning competition_fixtures.competition_fixture_id into v_final_id;

  update competitions
     set state = 'PUBLISHED', published_at = v_published_at
   where competitions.competition_id = p_competition_id;

  return query select p_competition_id, 'PUBLISHED'::text, v_published_at, v_sf1_id, v_sf2_id, v_final_id;
end;
$$;

revoke all on function publish_competition_atomically(uuid, uuid, uuid, uuid, uuid, uuid, timestamptz, timestamptz, timestamptz) from public, anon, authenticated;
grant execute on function publish_competition_atomically(uuid, uuid, uuid, uuid, uuid, uuid, timestamptz, timestamptz, timestamptz) to service_role;
