-- OPEN_TEAM_REGISTRATION — refuse organizer actions once a host's access has been revoked
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

CREATE OR REPLACE FUNCTION public.open_team_registration_atomically(p_competition_id uuid, p_organizer_gaming_member_id uuid)
 RETURNS TABLE(competition_id uuid, state text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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
  perform assert_competition_not_host_revoked(p_competition_id);

  if v_state <> 'DRAFT' then
    raise exception 'COMPETITION_NOT_DRAFT: team registration may only be opened while the competition is DRAFT'
      using errcode = 'P0001';
  end if;

  update competitions set state = 'TEAM_REGISTRATION_OPEN' where competitions.competition_id = p_competition_id;

  return query select p_competition_id, 'TEAM_REGISTRATION_OPEN'::text;
end;
$function$;

revoke all on function open_team_registration_atomically(uuid,uuid) from public, anon, authenticated;
grant execute on function open_team_registration_atomically(uuid,uuid) to service_role;
