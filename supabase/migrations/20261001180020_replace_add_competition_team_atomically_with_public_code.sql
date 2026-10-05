-- ADD_COMPETITION_TEAM — adds p_public_code as an ADDITIVE overload
-- (UG-CR-GATE-081 Phase 3A; corrected by UG-CR-GATE-082 per
-- UG-CR-REV-053 #2 — expand/contract, not a hard cutover). Same
-- additive-overload rationale as
-- 20261001180010_replace_create_competition_atomically_with_public_code.sql:
-- the original 4-arg add_competition_team_atomically(uuid, uuid, text, uuid)
-- is left untouched and still callable (its INSERT receives
-- public_code from the column DEFAULT added in
-- 20261001180000_add_competition_public_codes.sql); this migration no
-- longer drops it, only adds the new 5-arg overload. Removing the
-- legacy 4-arg overload is deferred to a later cleanup gate;
-- __tests__/competitionsAuthorizationMatrix.contract.test.ts exercises
-- the 4-arg shape directly and continues to pass unmodified.
--
-- Corrected from an earlier draft of this migration that based its body on
-- 20260906044809_create_add_competition_team_atomically.sql and silently
-- regressed the intervening correction in
-- 20260908100352_replace_add_competition_team_atomically_registration_open.sql
-- (UG-CR-RPT-041/042). Every other line below is unchanged from that
-- corrected function: the DRAFT-or-TEAM_REGISTRATION_OPEN state check, the
-- explicit ACCEPTED/ORGANIZER_CREATED values at insert, the four-accepted-
-- team capacity check serialized on the shared
-- 'competition_team_scope:<id>' advisory lock, and the unique_violation
-- translation for duplicate team name / already-captain-or-member. Only
-- p_public_code, its NOT NULL guard, and the public_code column on insert
-- are new.

create function add_competition_team_atomically(
  p_competition_id uuid,
  p_organizer_gaming_member_id uuid,
  p_name text,
  p_captain_gaming_member_id uuid,
  p_public_code text
)
returns table (competition_team_id uuid, created_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_organizer_id uuid;
  v_state text;
  v_team_id uuid;
  v_created_at timestamptz;
  v_accepted_count integer;
begin
  if p_public_code is null or length(trim(p_public_code)) = 0 then
    raise exception 'PUBLIC_CODE_REQUIRED: an opaque public code is required' using errcode = 'P0001';
  end if;

  select competitions.organizer_gaming_member_id, competitions.state
    into v_organizer_id, v_state
    from competitions
   where competitions.competition_id = p_competition_id
   for update;

  if v_organizer_id is null then
    raise exception 'COMPETITION_NOT_FOUND: no such competition exists' using errcode = 'P0001';
  end if;

  if v_organizer_id <> p_organizer_gaming_member_id then
    raise exception 'COMPETITION_ACCESS_DENIED: only this competition''s own organizer may add a team'
      using errcode = 'P0001';
  end if;

  if v_state not in ('DRAFT', 'TEAM_REGISTRATION_OPEN') then
    raise exception 'COMPETITION_NOT_DRAFT: teams may only be added while the competition is DRAFT or TEAM_REGISTRATION_OPEN'
      using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('competition_team_scope:' || p_competition_id::text));

  select count(*) into v_accepted_count
    from competition_teams
   where competition_teams.competition_id = p_competition_id
     and competition_teams.status = 'ACCEPTED';

  if v_accepted_count >= 4 then
    raise exception 'TEAM_CAPACITY_REACHED: four teams have already been accepted for this competition'
      using errcode = 'P0001';
  end if;

  begin
    insert into competition_teams (competition_id, name, captain_gaming_member_id, status, provenance, public_code)
    values (p_competition_id, p_name, p_captain_gaming_member_id, 'ACCEPTED', 'ORGANIZER_CREATED', p_public_code)
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

  return query select v_team_id, v_created_at;
end;
$$;

revoke all on function add_competition_team_atomically(uuid, uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function add_competition_team_atomically(uuid, uuid, text, uuid, text) to service_role;
