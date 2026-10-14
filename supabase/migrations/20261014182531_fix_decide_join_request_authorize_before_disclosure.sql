-- DECIDE_JOIN_REQUEST_ATOMICALLY — authorization before any lifecycle or not-found response (UG-CR-GATE-092).
--
-- ROOT CAUSE. This function answered the lifecycle checks BEFORE it asked who was calling: an unknown id raised JOIN_REQUEST_NOT_FOUND,
-- an already-decided request raised JOIN_REQUEST_NOT_PENDING, and a request in a cancelled competition raised COMPETITION_CANCELLED, each
-- to ANY caller. Possession of a join-request id therefore let an unrelated caller learn whether the request existed, whether it had
-- been decided, and whether its competition had been cancelled. It returned no result and no member data, but it is the same
-- authorization-before-disclosure invariant GATE-091 closed for the fixture result functions.
--
-- FIX. The request is still locked and loaded first. The organizer and captain are then derived from the request's own competition and
-- target team, and the caller is validated (exact organizer for an override, exact captain otherwise; IS DISTINCT FROM so NULL can never
-- pass; then the GATE-088 host revocation guard) BEFORE NOT_PENDING and COMPETITION_CANCELLED. An unauthorized caller gets the branch's
-- own bounded denial whether the request is pending, decided, attached to a cancelled competition, or does not exist (a request that does
-- not exist has no organizer or captain, so nobody is authorized for it and JOIN_REQUEST_NOT_FOUND is no longer raised). An authorized caller
-- reaches the lifecycle checks in their original order, so every authorized outcome is unchanged, with two intended differences: a
-- revoked host's override is refused with HOST_ACCESS_REVOKED whatever the request's state, and a request id that does not exist is a
-- denial for everyone, the organizer included. The input check on the decision value (INVALID_DECISION) depends on nothing stored and stays first.
--
-- Every other line is the definition live after 20261013033202. Signature, SECURITY DEFINER, pinned search_path and the execute grants are
-- unchanged and restated below.

CREATE OR REPLACE FUNCTION public.decide_join_request_atomically(p_competition_join_request_id uuid, p_deciding_gaming_member_id uuid, p_decision text, p_is_organizer_override boolean)
 RETURNS TABLE(competition_join_request_id uuid, status text, decided_at timestamp with time zone, competition_team_membership_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_lookup_competition_id uuid;
  v_competition_id uuid;
  v_competition_state text;
  v_team_id uuid;
  v_requesting_member_id uuid;
  v_current_status text;
  v_organizer_id uuid;
  v_captain_id uuid;
  v_decided_at timestamptz;
  v_membership_id uuid;
  v_has_active_captaincy boolean;
begin
  if p_decision not in ('APPROVE', 'REJECT') then
    raise exception 'INVALID_DECISION: decision must be APPROVE or REJECT' using errcode = 'P0001';
  end if;

  select competition_join_requests.competition_id into v_lookup_competition_id
    from competition_join_requests
   where competition_join_requests.competition_join_request_id = p_competition_join_request_id;

  if v_lookup_competition_id is null then
    -- UG-CR-GATE-092: a request that does not exist has no organizer or captain, so nobody is authorized for it. It is refused with the
    -- SAME bounded denial an unauthorized caller gets for a request that does exist, never with a "not found" that would tell a caller
    -- holding an id whether it exists.
    if p_is_organizer_override then
      raise exception 'COMPETITION_ACCESS_DENIED: only the organizer may override a join-request decision' using errcode = 'P0001';
    end if;
    raise exception 'NOT_TEAM_CAPTAIN: only this team''s own captain may decide this request' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('competition_scope:' || v_lookup_competition_id::text));

  select competition_join_requests.competition_id, competition_join_requests.competition_team_id,
         competition_join_requests.requesting_gaming_member_id, competition_join_requests.status
    into v_competition_id, v_team_id, v_requesting_member_id, v_current_status
    from competition_join_requests
   where competition_join_requests.competition_join_request_id = p_competition_join_request_id
   for update;

  if v_competition_id is null then
    -- UG-CR-GATE-092: a request that does not exist has no organizer or captain, so nobody is authorized for it. It is refused with the
    -- SAME bounded denial an unauthorized caller gets for a request that does exist, never with a "not found" that would tell a caller
    -- holding an id whether it exists.
    if p_is_organizer_override then
      raise exception 'COMPETITION_ACCESS_DENIED: only the organizer may override a join-request decision' using errcode = 'P0001';
    end if;
    raise exception 'NOT_TEAM_CAPTAIN: only this team''s own captain may decide this request' using errcode = 'P0001';
  end if;

  -- UG-CR-GATE-092: authorization comes BEFORE any lifecycle response. The caller must be the exact organizer of this request's own
  -- competition (override) or the exact captain of its target team (and, for an organizer who is a host, still hold the capability)
  -- before this function says anything about the request: whether it is still pending, already decided, or attached to a cancelled
  -- competition. An unauthorized caller therefore gets the same bounded denial in every one of those states.
  select competitions.organizer_gaming_member_id, competitions.state
    into v_organizer_id, v_competition_state
    from competitions where competitions.competition_id = v_competition_id;

  select competition_teams.captain_gaming_member_id into v_captain_id
    from competition_teams where competition_teams.competition_team_id = v_team_id;

  if p_is_organizer_override then
    if p_deciding_gaming_member_id is distinct from v_organizer_id then
      raise exception 'COMPETITION_ACCESS_DENIED: only the organizer may override a join-request decision'
        using errcode = 'P0001';
    end if;
    perform assert_competition_not_host_revoked(v_competition_id);
  else
    if p_deciding_gaming_member_id is distinct from v_captain_id then
      raise exception 'NOT_TEAM_CAPTAIN: only this team''s own captain may decide this request'
        using errcode = 'P0001';
    end if;
  end if;

  -- Only an authorized caller reaches the lifecycle checks, in their original order.
  if v_current_status <> 'REQUESTED' then
    raise exception 'JOIN_REQUEST_NOT_PENDING: this join request has already been decided' using errcode = 'P0001';
  end if;

  if v_competition_state = 'CANCELLED_WITHOUT_CHAMPION' then
    raise exception 'COMPETITION_CANCELLED: this competition has been cancelled and no longer accepts this action'
      using errcode = 'P0001';
  end if;

  v_decided_at := now();

  update competition_join_requests
     set status = case when p_decision = 'APPROVE' then 'APPROVED' else 'REJECTED' end,
         decided_by_gaming_member_id = p_deciding_gaming_member_id,
         decided_at = v_decided_at
   where competition_join_requests.competition_join_request_id = p_competition_join_request_id;

  if p_decision = 'APPROVE' then
    perform pg_advisory_xact_lock(hashtext('competition_team_scope:' || v_competition_id::text));

    select exists(
      select 1 from competition_teams
      where competition_teams.competition_id = v_competition_id
        and competition_teams.captain_gaming_member_id = v_requesting_member_id
        and competition_teams.status <> 'REJECTED'
    ) into v_has_active_captaincy;

    if v_has_active_captaincy then
      raise exception 'ALREADY_CAPTAIN_OR_MEMBER: this member already holds an active team role in this competition'
        using errcode = 'P0001';
    end if;

    begin
      insert into competition_team_memberships (competition_id, competition_team_id, gaming_member_id, approved_by_gaming_member_id)
      values (v_competition_id, v_team_id, v_requesting_member_id, p_deciding_gaming_member_id)
      returning competition_team_memberships.competition_team_membership_id into v_membership_id;
    exception when unique_violation then
      raise exception 'ALREADY_TEAM_MEMBER: this member already holds a team membership in this competition'
        using errcode = 'P0001';
    end;
  end if;

  return query select p_competition_join_request_id,
    (case when p_decision = 'APPROVE' then 'APPROVED' else 'REJECTED' end)::text,
    v_decided_at, v_membership_id;
end;
$function$;

revoke all on function decide_join_request_atomically(uuid,uuid,text,boolean) from public, anon, authenticated;
grant execute on function decide_join_request_atomically(uuid,uuid,text,boolean) to service_role;
