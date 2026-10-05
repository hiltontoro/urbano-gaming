-- REQUEST_JOIN_COMPETITION_TEAM — add cancellation guard (UG-CR-GATE-082
-- per UG-CR-REV-053 #3: "join request" was named explicitly). The
-- function never queried the competitions table at all — a new join
-- request could be created against a team belonging to a cancelled
-- competition with no error. Every other line is unchanged from
-- 20260908100354_replace_request_join_competition_team_atomically_team_accepted.sql —
-- only a new competitions.state read and guard are inserted immediately
-- after the existing COMPETITION_TEAM_NOT_FOUND check, before the
-- team-acceptance check.
create or replace function request_join_competition_team_atomically(
  p_competition_id uuid,
  p_competition_team_id uuid,
  p_requesting_gaming_member_id uuid
)
returns table (competition_join_request_id uuid, status text, created_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_team_competition_id uuid;
  v_team_status text;
  v_competition_state text;
  v_registered boolean;
  v_has_membership boolean;
  v_has_active_captaincy boolean;
  v_has_pending boolean;
  v_request_id uuid;
  v_created_at timestamptz;
begin
  select competition_teams.competition_id, competition_teams.status
    into v_team_competition_id, v_team_status
    from competition_teams
   where competition_teams.competition_team_id = p_competition_team_id;

  if v_team_competition_id is null or v_team_competition_id <> p_competition_id then
    raise exception 'COMPETITION_TEAM_NOT_FOUND: no such team exists in this competition' using errcode = 'P0001';
  end if;

  select competitions.state into v_competition_state
    from competitions where competitions.competition_id = p_competition_id;

  if v_competition_state = 'CANCELLED_WITHOUT_CHAMPION' then
    raise exception 'COMPETITION_CANCELLED: this competition has been cancelled and no longer accepts this action'
      using errcode = 'P0001';
  end if;

  if v_team_status <> 'ACCEPTED' then
    raise exception 'TEAM_NOT_ACCEPTED: this team has not yet been accepted for this competition' using errcode = 'P0001';
  end if;

  select exists(
    select 1 from competition_registrations
    where competition_registrations.competition_id = p_competition_id
      and competition_registrations.gaming_member_id = p_requesting_gaming_member_id
  ) into v_registered;

  if not v_registered then
    raise exception 'COMPETITION_REGISTRATION_REQUIRED: register for this competition before requesting a team'
      using errcode = 'P0001';
  end if;

  select exists(
    select 1 from competition_team_memberships
    where competition_team_memberships.competition_id = p_competition_id
      and competition_team_memberships.gaming_member_id = p_requesting_gaming_member_id
  ) into v_has_membership;

  if v_has_membership then
    raise exception 'ALREADY_TEAM_MEMBER: this member already holds a team membership in this competition'
      using errcode = 'P0001';
  end if;

  select exists(
    select 1 from competition_teams
    where competition_teams.competition_id = p_competition_id
      and competition_teams.captain_gaming_member_id = p_requesting_gaming_member_id
      and competition_teams.status <> 'REJECTED'
  ) into v_has_active_captaincy;

  if v_has_active_captaincy then
    raise exception 'ALREADY_CAPTAIN_OR_MEMBER: this member already holds an active team role in this competition'
      using errcode = 'P0001';
  end if;

  select exists(
    select 1 from competition_join_requests
    where competition_join_requests.competition_id = p_competition_id
      and competition_join_requests.requesting_gaming_member_id = p_requesting_gaming_member_id
      and competition_join_requests.status = 'REQUESTED'
  ) into v_has_pending;

  if v_has_pending then
    raise exception 'DUPLICATE_PENDING_JOIN_REQUEST: this member already has a pending join request in this competition'
      using errcode = 'P0001';
  end if;

  insert into competition_join_requests (competition_id, competition_team_id, requesting_gaming_member_id)
  values (p_competition_id, p_competition_team_id, p_requesting_gaming_member_id)
  returning competition_join_requests.competition_join_request_id, competition_join_requests.created_at
  into v_request_id, v_created_at;

  return query select v_request_id, 'REQUESTED'::text, v_created_at;
end;
$$;

revoke all on function request_join_competition_team_atomically(uuid, uuid, uuid) from public, anon, authenticated;
grant execute on function request_join_competition_team_atomically(uuid, uuid, uuid) to service_role;
