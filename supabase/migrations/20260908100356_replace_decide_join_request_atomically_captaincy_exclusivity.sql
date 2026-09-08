-- DECIDE_JOIN_REQUEST correction (UG-CR-RPT-041 §5). Adds the real,
-- non-bypassable enforcement of "a member cannot gain membership in
-- another team while holding an active proposed/accepted captaincy" —
-- checked immediately before the membership insert, under the same
-- per-competition advisory lock PROPOSE_COMPETITION_TEAM and DECIDE_
-- COMPETITION_TEAM's own ACCEPT branch use, so a captaincy proposal/
-- acceptance and a join-request approval targeting the SAME member can
-- never race past each other. Every other line — the captain/organizer-
-- override authority check, the idempotency shape, the existing
-- ALREADY_TEAM_MEMBER unique-index catch — is unchanged.
create or replace function decide_join_request_atomically(
  p_competition_join_request_id uuid,
  p_deciding_gaming_member_id uuid,
  p_decision text,
  p_is_organizer_override boolean
)
returns table (
  competition_join_request_id uuid,
  status text,
  decided_at timestamptz,
  competition_team_membership_id uuid
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_competition_id uuid;
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

  select competition_join_requests.competition_id, competition_join_requests.competition_team_id,
         competition_join_requests.requesting_gaming_member_id, competition_join_requests.status
    into v_competition_id, v_team_id, v_requesting_member_id, v_current_status
    from competition_join_requests
   where competition_join_requests.competition_join_request_id = p_competition_join_request_id
   for update;

  if v_competition_id is null then
    raise exception 'JOIN_REQUEST_NOT_FOUND: no such join request exists' using errcode = 'P0001';
  end if;

  if v_current_status <> 'REQUESTED' then
    raise exception 'JOIN_REQUEST_NOT_PENDING: this join request has already been decided' using errcode = 'P0001';
  end if;

  select competitions.organizer_gaming_member_id into v_organizer_id
    from competitions where competitions.competition_id = v_competition_id;

  select competition_teams.captain_gaming_member_id into v_captain_id
    from competition_teams where competition_teams.competition_team_id = v_team_id;

  if p_is_organizer_override then
    if p_deciding_gaming_member_id <> v_organizer_id then
      raise exception 'COMPETITION_ACCESS_DENIED: only the organizer may override a join-request decision'
        using errcode = 'P0001';
    end if;
  else
    if p_deciding_gaming_member_id <> v_captain_id then
      raise exception 'NOT_TEAM_CAPTAIN: only this team''s own captain may decide this request'
        using errcode = 'P0001';
    end if;
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
$$;

revoke all on function decide_join_request_atomically(uuid, uuid, text, boolean) from public, anon, authenticated;
grant execute on function decide_join_request_atomically(uuid, uuid, text, boolean) to service_role;
