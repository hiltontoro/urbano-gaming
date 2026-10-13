-- APPOINT_COMPETITION_SCOREKEEPER — refuse organizer actions once a host's access has been revoked
-- (UG-CR-GATE-088, Become a Host). Adds exactly one statement,
--   perform assert_competition_not_host_revoked(v_competition_id);
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

CREATE OR REPLACE FUNCTION public.appoint_competition_scorekeeper_atomically(p_competition_fixture_id uuid, p_organizer_gaming_member_id uuid, p_scorekeeper_gaming_member_id uuid)
 RETURNS TABLE(competition_fixture_id uuid, scorekeeper_gaming_member_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_lookup_competition_id uuid;
  v_competition_id uuid;
  v_competition_state text;
  v_organizer_id uuid;
  v_team_a_captain uuid;
  v_team_b_captain uuid;
  v_on_roster boolean;
begin
  select competition_fixtures.competition_id into v_lookup_competition_id
    from competition_fixtures
   where competition_fixtures.competition_fixture_id = p_competition_fixture_id;

  if v_lookup_competition_id is null then
    raise exception 'FIXTURE_NOT_FOUND: no such fixture exists' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('competition_scope:' || v_lookup_competition_id::text));

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
  perform assert_competition_not_host_revoked(v_competition_id);

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
$function$;

revoke all on function appoint_competition_scorekeeper_atomically(uuid,uuid,uuid) from public, anon, authenticated;
grant execute on function appoint_competition_scorekeeper_atomically(uuid,uuid,uuid) to service_role;
