-- DECIDE_COMPETITION_TEAM — refuse organizer actions once a host's access has been revoked
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

CREATE OR REPLACE FUNCTION public.decide_competition_team_atomically(p_competition_team_id uuid, p_organizer_gaming_member_id uuid, p_decision text, p_reason text)
 RETURNS TABLE(competition_team_id uuid, status text, decided_at timestamp with time zone, competition_team_membership_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_lookup_competition_id uuid;
  v_competition_id uuid;
  v_competition_state text;
  v_current_status text;
  v_captain_id uuid;
  v_organizer_id uuid;
  v_decided_at timestamptz;
  v_membership_id uuid;
  v_accepted_count integer;
begin
  if p_decision not in ('APPROVE', 'REJECT') then
    raise exception 'INVALID_DECISION: decision must be APPROVE or REJECT' using errcode = 'P0001';
  end if;

  select competition_teams.competition_id into v_lookup_competition_id
    from competition_teams
   where competition_teams.competition_team_id = p_competition_team_id;

  if v_lookup_competition_id is null then
    raise exception 'COMPETITION_TEAM_NOT_FOUND: no such team exists in this competition' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('competition_scope:' || v_lookup_competition_id::text));

  select competition_teams.competition_id, competition_teams.status, competition_teams.captain_gaming_member_id
    into v_competition_id, v_current_status, v_captain_id
    from competition_teams
   where competition_teams.competition_team_id = p_competition_team_id
   for update;

  if v_competition_id is null then
    raise exception 'COMPETITION_TEAM_NOT_FOUND: no such team exists in this competition' using errcode = 'P0001';
  end if;

  select competitions.organizer_gaming_member_id, competitions.state
    into v_organizer_id, v_competition_state
    from competitions where competitions.competition_id = v_competition_id;

  if p_organizer_gaming_member_id <> v_organizer_id then
    raise exception 'COMPETITION_ACCESS_DENIED: only this competition''s own organizer may decide a team proposal'
      using errcode = 'P0001';
  end if;
  perform assert_competition_not_host_revoked(v_competition_id);

  if v_competition_state = 'CANCELLED_WITHOUT_CHAMPION' then
    raise exception 'COMPETITION_CANCELLED: this competition has been cancelled and no longer accepts this action'
      using errcode = 'P0001';
  end if;

  if v_current_status <> 'PENDING_ORGANIZER_APPROVAL' then
    if (v_current_status = 'ACCEPTED' and p_decision = 'APPROVE')
        or (v_current_status = 'REJECTED' and p_decision = 'REJECT') then
      select competition_teams.decided_at into v_decided_at
        from competition_teams where competition_teams.competition_team_id = p_competition_team_id;
      select competition_team_memberships.competition_team_membership_id into v_membership_id
        from competition_team_memberships
       where competition_team_memberships.competition_team_id = p_competition_team_id
         and competition_team_memberships.gaming_member_id = v_captain_id;
      return query select p_competition_team_id, v_current_status, v_decided_at, v_membership_id;
      return;
    end if;
    raise exception 'TEAM_DECISION_ALREADY_MADE: this team proposal has already been decided'
      using errcode = 'P0001';
  end if;

  if p_decision = 'REJECT' then
    if p_reason is null or length(trim(p_reason)) = 0 then
      raise exception 'REASON_REQUIRED: rejecting a team proposal requires a reason' using errcode = 'P0001';
    end if;

    v_decided_at := now();
    update competition_teams
       set status = 'REJECTED', rejection_reason = p_reason,
           decided_at = v_decided_at, decided_by_gaming_member_id = p_organizer_gaming_member_id
     where competition_teams.competition_team_id = p_competition_team_id;

    return query select p_competition_team_id, 'REJECTED'::text, v_decided_at, null::uuid;
    return;
  end if;

  -- ACCEPT: serializes against propose/decide/membership-approval for
  -- this same competition's team namespace (accepted decisions §5).
  perform pg_advisory_xact_lock(hashtext('competition_team_scope:' || v_competition_id::text));

  select count(*) into v_accepted_count
    from competition_teams
   where competition_teams.competition_id = v_competition_id
     and competition_teams.status = 'ACCEPTED';

  if v_accepted_count >= 4 then
    raise exception 'TEAM_CAPACITY_REACHED: four teams have already been accepted for this competition'
      using errcode = 'P0001';
  end if;

  v_decided_at := now();

  update competition_teams
     set status = 'ACCEPTED', decided_at = v_decided_at, decided_by_gaming_member_id = p_organizer_gaming_member_id
   where competition_teams.competition_team_id = p_competition_team_id;

  begin
    insert into competition_team_memberships (competition_id, competition_team_id, gaming_member_id, approved_by_gaming_member_id)
    values (v_competition_id, p_competition_team_id, v_captain_id, p_organizer_gaming_member_id)
    returning competition_team_memberships.competition_team_membership_id into v_membership_id;
  exception when unique_violation then
    raise exception 'ALREADY_TEAM_MEMBER: this member already holds a team membership in this competition'
      using errcode = 'P0001';
  end;

  return query select p_competition_team_id, 'ACCEPTED'::text, v_decided_at, v_membership_id;
end;
$function$;

revoke all on function decide_competition_team_atomically(uuid,uuid,text,text) from public, anon, authenticated;
grant execute on function decide_competition_team_atomically(uuid,uuid,text,text) to service_role;
