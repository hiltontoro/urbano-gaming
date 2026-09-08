-- ORGANIZER_REVIEW_JOIN_REQUEST correction (UG-CR-RPT-041 §5) — the same
-- captaincy-exclusivity enforcement added to DECIDE_JOIN_REQUEST above,
-- applied to this function's own one-shot-override APPROVE path, under
-- the same shared per-competition advisory lock. Every other line is
-- unchanged.
create or replace function organizer_review_join_request_atomically(
  p_competition_join_request_id uuid,
  p_organizer_gaming_member_id uuid,
  p_decision text,
  p_reason text
)
returns table (
  competition_join_request_id uuid,
  status text,
  organizer_reviewed_at timestamptz,
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
  v_already_reviewed timestamptz;
  v_organizer_id uuid;
  v_reviewed_at timestamptz;
  v_membership_id uuid;
  v_has_active_captaincy boolean;
begin
  if p_decision not in ('APPROVE', 'REJECT') then
    raise exception 'INVALID_DECISION: decision must be APPROVE or REJECT' using errcode = 'P0001';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'REASON_REQUIRED: an organizer review requires a reason' using errcode = 'P0001';
  end if;

  select competition_join_requests.competition_id, competition_join_requests.competition_team_id,
         competition_join_requests.requesting_gaming_member_id, competition_join_requests.status,
         competition_join_requests.organizer_reviewed_at
    into v_competition_id, v_team_id, v_requesting_member_id, v_current_status, v_already_reviewed
    from competition_join_requests
   where competition_join_requests.competition_join_request_id = p_competition_join_request_id
   for update;

  if v_competition_id is null then
    raise exception 'JOIN_REQUEST_NOT_FOUND: no such join request exists' using errcode = 'P0001';
  end if;

  select competitions.organizer_gaming_member_id into v_organizer_id
    from competitions where competitions.competition_id = v_competition_id;

  if p_organizer_gaming_member_id <> v_organizer_id then
    raise exception 'COMPETITION_ACCESS_DENIED: only the organizer may review a join request'
      using errcode = 'P0001';
  end if;

  if v_current_status <> 'REJECTED' then
    raise exception 'JOIN_REQUEST_NOT_REJECTED: organizer review only applies to an already-rejected request'
      using errcode = 'P0001';
  end if;

  if v_already_reviewed is not null then
    raise exception 'JOIN_REQUEST_ALREADY_REVIEWED: this request has already received its one organizer review'
      using errcode = 'P0001';
  end if;

  v_reviewed_at := now();

  update competition_join_requests
     set status = case when p_decision = 'APPROVE' then 'APPROVED' else 'REJECTED' end,
         organizer_reviewed_at = v_reviewed_at,
         organizer_reviewed_by_gaming_member_id = p_organizer_gaming_member_id
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
      values (v_competition_id, v_team_id, v_requesting_member_id, p_organizer_gaming_member_id)
      returning competition_team_memberships.competition_team_membership_id into v_membership_id;
    exception when unique_violation then
      raise exception 'ALREADY_TEAM_MEMBER: this member already holds a team membership in this competition'
        using errcode = 'P0001';
    end;
  end if;

  return query select p_competition_join_request_id,
    (case when p_decision = 'APPROVE' then 'APPROVED' else 'REJECTED' end)::text,
    v_reviewed_at, v_membership_id;
end;
$$;

revoke all on function organizer_review_join_request_atomically(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function organizer_review_join_request_atomically(uuid, uuid, text, text) to service_role;
