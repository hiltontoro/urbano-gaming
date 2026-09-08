-- REQUEST_JOIN_COMPETITION_TEAM correction (UG-CR-RPT-041 §4/§9). A
-- team must now be ACCEPTED before anyone may request to join it — a
-- team that is still PENDING_ORGANIZER_APPROVAL or was REJECTED can no
-- longer receive join requests (an invitation link opened before
-- acceptance is still safe to VIEW, but any consequential request
-- through it fails here with a truthful, typed error). Also adds an
-- early, friendly rejection when the requester already holds an active
-- (non-REJECTED) captaincy anywhere in this competition — the real,
-- non-bypassable enforcement of that same rule lives in DECIDE_JOIN_
-- REQUEST/ORGANIZER_REVIEW_JOIN_REQUEST's own ACCEPT branch, under the
-- shared advisory lock; this is a courtesy check only, matching this
-- function's own pre-existing pattern for ALREADY_TEAM_MEMBER.
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
