-- PUBLISH_COMPETITION — refuse organizer actions once a host's access has been revoked
-- (UG-CR-GATE-088, Become a Host). Adds exactly one statement,
--   perform assert_competition_not_host_revoked(p_competition_id);
-- directly after this function's existing organizer-ownership check and before
-- any state check or write. Every other line is the definition live after
-- 20261005090210, unchanged. The helper does nothing for a competition that is
-- not bound to a host capability (every internally created competition), so
-- existing OPERATIONAL behavior is unaffected, and it is keyed on the
-- competition id, never on the caller, so it cannot be bypassed by the actor
-- argument. The competition-scope advisory lock is already held at this point,
-- which revoke_host_capability_atomically also takes, so a revocation and an
-- in-flight organizer mutation serialize.
--

CREATE OR REPLACE FUNCTION public.publish_competition_atomically(p_competition_id uuid, p_organizer_gaming_member_id uuid, p_semifinal_1_team_a_id uuid, p_semifinal_1_team_b_id uuid, p_semifinal_2_team_a_id uuid, p_semifinal_2_team_b_id uuid, p_semifinal_1_scheduled_at timestamp with time zone, p_semifinal_2_scheduled_at timestamp with time zone, p_final_scheduled_at timestamp with time zone)
 RETURNS TABLE(competition_id uuid, state text, published_at timestamp with time zone, semifinal_1_fixture_id uuid, semifinal_2_fixture_id uuid, final_fixture_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  perform assert_competition_not_host_revoked(p_competition_id);

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
$function$;

revoke all on function publish_competition_atomically(uuid,uuid,uuid,uuid,uuid,uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone) from public, anon, authenticated;
grant execute on function publish_competition_atomically(uuid,uuid,uuid,uuid,uuid,uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone) to service_role;
