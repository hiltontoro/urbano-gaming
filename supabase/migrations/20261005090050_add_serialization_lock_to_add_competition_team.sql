-- ADD_COMPETITION_TEAM (new 5-arg signature) — add competition-scoped
-- serialization lock (UG-CR-GATE-083 per UG-CR-REV-054 finding 1). See
-- 20261005090000_add_serialization_lock_to_cancel_incomplete_competition.sql
-- for the full rationale and the one global lock order this domain now
-- follows: competition_scope is always acquired before the existing
-- 'competition_team_scope:' lock, never the reverse. p_competition_id
-- is a direct parameter, so competition_scope is acquired immediately
-- after the pre-existing PUBLIC_CODE_REQUIRED check (pure input
-- validation, no DB access), before the existing FOR UPDATE select.
--
-- The OLD, deliberately-frozen 4-arg add_competition_team_atomically
-- overload (the expand/contract compatibility shim from GATE-081/082,
-- UG-CR-REV-053 #2) is intentionally NOT given this lock: nothing in
-- this application ever calls it, it is a temporary bridge for an
-- old-app/new-schema rollout window that has not begun, and it will be
-- retired entirely — not patched — in the future cleanup gate that
-- drops it. Locking a function nothing calls would not close any real
-- concurrency exposure and would reopen the already-accepted
-- expand/contract design's "old overload body stays untouched"
-- guarantee.
--
-- Every other line is unchanged from
-- 20261001180020_replace_add_competition_team_atomically_with_public_code.sql.
create or replace function add_competition_team_atomically(
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
