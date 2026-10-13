-- CLOSE_TEAM_REGISTRATION — refuse organizer actions once a host's access has been revoked
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

CREATE OR REPLACE FUNCTION public.close_team_registration_atomically(p_competition_id uuid, p_organizer_gaming_member_id uuid)
 RETURNS TABLE(competition_id uuid, state text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  perform assert_competition_not_host_revoked(p_competition_id);

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
$function$;

revoke all on function close_team_registration_atomically(uuid,uuid) from public, anon, authenticated;
grant execute on function close_team_registration_atomically(uuid,uuid) to service_role;
