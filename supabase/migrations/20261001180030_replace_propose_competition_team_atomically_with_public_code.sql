-- PROPOSE_COMPETITION_TEAM — adds p_public_code as an ADDITIVE overload
-- (UG-CR-GATE-081 Phase 3A; corrected by UG-CR-GATE-082 per
-- UG-CR-REV-053 #2 — expand/contract, not a hard cutover). Same
-- additive-overload rationale as the two sibling migrations alongside
-- this one: the original 3-arg propose_competition_team_atomically(uuid,
-- text, uuid) is left untouched and still callable (its INSERT
-- receives public_code from the column DEFAULT added in
-- 20261001180000_add_competition_public_codes.sql); this migration no
-- longer drops it, only adds the new 4-arg overload. Removing the
-- legacy 3-arg overload is deferred to a later cleanup gate;
-- __tests__/competitionsAuthorizationMatrix.contract.test.ts exercises
-- the 3-arg shape directly and continues to pass unmodified.
--
-- Every other line (state guard, registration check, advisory lock,
-- membership/captaincy exclusivity, unique-violation mapping) is
-- unchanged from 20260908100340_create_propose_competition_team_atomically.sql.

create function propose_competition_team_atomically(
  p_competition_id uuid,
  p_name text,
  p_proposing_gaming_member_id uuid,
  p_public_code text
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
  if p_public_code is null or length(trim(p_public_code)) = 0 then
    raise exception 'PUBLIC_CODE_REQUIRED: an opaque public code is required' using errcode = 'P0001';
  end if;

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
    insert into competition_teams (competition_id, name, captain_gaming_member_id, status, provenance, public_code)
    values (p_competition_id, p_name, p_proposing_gaming_member_id, 'PENDING_ORGANIZER_APPROVAL', 'MEMBER_PROPOSED', p_public_code)
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

revoke all on function propose_competition_team_atomically(uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function propose_competition_team_atomically(uuid, text, uuid, text) to service_role;
