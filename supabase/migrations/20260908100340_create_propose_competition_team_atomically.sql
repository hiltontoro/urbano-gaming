-- PROPOSE_COMPETITION_TEAM (UG-CR-RPT-041 §4/§5/§7; accepted decisions
-- §8/§9). A registered member proposes a team for a competition whose
-- team registration is open; the proposer becomes that team's
-- captain_gaming_member_id immediately (confirmed only once the
-- organizer accepts — see decide_competition_team_atomically), with
-- status PENDING_ORGANIZER_APPROVAL and provenance MEMBER_PROPOSED. The
-- creator/proposed-captain identity is always the verified caller
-- (p_proposing_gaming_member_id) — the route layer never accepts any
-- other actor id for this call.
--
-- Serializes on the same per-competition advisory-lock key that
-- decide_competition_team_atomically's own ACCEPT branch and both
-- join-request approval RPCs use (accepted decisions §5/§9) — the
-- shared key that makes "a member cannot hold an active captaincy and a
-- confirmed membership in the same competition at once" a real,
-- non-bypassable serialization rather than an application-only
-- precheck.
create or replace function propose_competition_team_atomically(
  p_competition_id uuid,
  p_name text,
  p_proposing_gaming_member_id uuid
)
returns table (competition_team_id uuid, status text, created_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state text;
  v_registered boolean;
  v_has_membership boolean;
  v_has_active_captaincy boolean;
  v_team_id uuid;
  v_created_at timestamptz;
begin
  select competitions.state into v_state
    from competitions
   where competitions.competition_id = p_competition_id
   for update;

  if v_state is null then
    raise exception 'COMPETITION_NOT_FOUND: no such competition exists' using errcode = 'P0001';
  end if;

  if v_state <> 'TEAM_REGISTRATION_OPEN' then
    raise exception 'TEAM_REGISTRATION_NOT_OPEN: team proposals are only accepted while team registration is open'
      using errcode = 'P0001';
  end if;

  select exists(
    select 1 from competition_registrations
    where competition_registrations.competition_id = p_competition_id
      and competition_registrations.gaming_member_id = p_proposing_gaming_member_id
  ) into v_registered;

  if not v_registered then
    raise exception 'COMPETITION_REGISTRATION_REQUIRED: register for this competition before proposing a team'
      using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('competition_team_scope:' || p_competition_id::text));

  select exists(
    select 1 from competition_team_memberships
    where competition_team_memberships.competition_id = p_competition_id
      and competition_team_memberships.gaming_member_id = p_proposing_gaming_member_id
  ) into v_has_membership;

  if v_has_membership then
    raise exception 'ALREADY_TEAM_MEMBER: this member already holds a team membership in this competition'
      using errcode = 'P0001';
  end if;

  select exists(
    select 1 from competition_teams
    where competition_teams.competition_id = p_competition_id
      and competition_teams.captain_gaming_member_id = p_proposing_gaming_member_id
      and competition_teams.status <> 'REJECTED'
  ) into v_has_active_captaincy;

  if v_has_active_captaincy then
    raise exception 'ALREADY_CAPTAIN_OR_MEMBER: this member already holds an active team role in this competition'
      using errcode = 'P0001';
  end if;

  begin
    insert into competition_teams (competition_id, name, captain_gaming_member_id, status, provenance)
    values (p_competition_id, p_name, p_proposing_gaming_member_id, 'PENDING_ORGANIZER_APPROVAL', 'MEMBER_PROPOSED')
    returning competition_teams.competition_team_id, competition_teams.created_at
    into v_team_id, v_created_at;
  exception
    when unique_violation then
      if sqlerrm like '%competition_teams_unique_name_per_competition%' then
        raise exception 'DUPLICATE_TEAM_NAME: a team with this name already exists in this competition' using errcode = 'P0001';
      elsif sqlerrm like '%competition_teams_one_active_captaincy%' then
        raise exception 'ALREADY_CAPTAIN_OR_MEMBER: this member already holds an active team role in this competition' using errcode = 'P0001';
      else
        raise;
      end if;
  end;

  return query select v_team_id, 'PENDING_ORGANIZER_APPROVAL'::text, v_created_at;
end;
$$;

revoke all on function propose_competition_team_atomically(uuid, text, uuid) from public, anon, authenticated;
grant execute on function propose_competition_team_atomically(uuid, text, uuid) to service_role;
