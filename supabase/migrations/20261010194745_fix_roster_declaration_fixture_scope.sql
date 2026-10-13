-- DECLARE_COMPETITION_ROSTER — fixture scope (UG-CR-GATE-089, correcting a defect reported in UG-CR-RPT-088).
--
-- ROOT CAUSE. declare_competition_roster_atomically took the team id from the request and checked only that the
-- caller was THAT team's captain (captain branch) or the fixture's organizer (organizer branch). Nothing tied the
-- team to the fixture or to the fixture's competition, so the captain of any accepted team in any competition
-- could write a roster revision onto any other competition's fixture. The helper CASE that computes "the other
-- team" also silently resolved an unrelated team to team A, which could flip the fixture to ROSTER_DECLARED early.
-- Become a Host widened who can hold a captaincy (an approved host can name themselves captain), which made this
-- reachable by external hosts.
--
-- FIX. (1) The function now reads the fixture's competition and both team slots under the competition_scope
-- advisory lock and a row lock, reads the team's own competition, and refuses unless the team is exactly one of
-- the fixture's two slots AND belongs to the fixture's competition. The check runs before the organizer/captain
-- decision and before every lifecycle check, for both branches, with null-safe comparisons (the Final's slots
-- start NULL). Every identifier mismatch, including an unknown fixture, raises the same bounded error,
-- FIXTURE_TEAM_SCOPE_MISMATCH, which says nothing about what exists. (2) A BEFORE INSERT/UPDATE trigger on
-- competition_roster_revisions enforces the same relationship at the table, so a future function or a direct
-- write cannot recreate the hole.
--
-- The organizer and captain comparisons are also made null-safe (IS DISTINCT FROM): `caller <> authority` is NULL for a
-- NULL caller, which PL/pgSQL treats as false, so a NULL caller used to skip the denial and was stopped only by a later
-- NOT NULL write. Behavior for every non-NULL caller is identical; the stored organizer and captain are NOT NULL.
--
-- Every other line of the function is the definition live after 20261007220039. Signature, SECURITY DEFINER,
-- pinned search_path and the execute grants are unchanged and restated below.

CREATE OR REPLACE FUNCTION public.declare_competition_roster_atomically(p_competition_fixture_id uuid, p_competition_team_id uuid, p_declaring_gaming_member_id uuid, p_is_organizer_action boolean, p_reason text, p_gaming_member_ids uuid[])
 RETURNS TABLE(competition_roster_revision_id uuid, declared_at timestamp with time zone, fixture_state text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_lookup_competition_id uuid;
  v_competition_id uuid;
  v_competition_state text;
  v_captain_id uuid;
  v_organizer_id uuid;
  v_scorekeeper_id uuid;
  v_fixture_state text;
  v_prior_revision_id uuid;
  v_new_revision_id uuid;
  v_declared_at timestamptz;
  v_other_team_id uuid;
  v_team_a_id uuid;
  v_team_b_id uuid;
  v_team_competition_id uuid;
  v_other_team_has_current boolean;
  v_member_id uuid;
begin
  select competition_fixtures.competition_id into v_lookup_competition_id
    from competition_fixtures
   where competition_fixtures.competition_fixture_id = p_competition_fixture_id;

  if v_lookup_competition_id is null then
    raise exception 'FIXTURE_TEAM_SCOPE_MISMATCH: this team is not part of this fixture' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('competition_scope:' || v_lookup_competition_id::text));
  perform pg_advisory_xact_lock(hashtextextended(p_competition_fixture_id::text || ':' || p_competition_team_id::text, 0));

  select competition_fixtures.competition_id, competition_fixtures.state, competition_fixtures.scorekeeper_gaming_member_id,
         competition_fixtures.team_a_competition_team_id, competition_fixtures.team_b_competition_team_id,
         (case when competition_fixtures.team_a_competition_team_id = p_competition_team_id
               then competition_fixtures.team_b_competition_team_id
               else competition_fixtures.team_a_competition_team_id end)
    into v_competition_id, v_fixture_state, v_scorekeeper_id, v_team_a_id, v_team_b_id, v_other_team_id
    from competition_fixtures
   where competition_fixtures.competition_fixture_id = p_competition_fixture_id
   for update;

  if v_competition_id is null then
    raise exception 'FIXTURE_TEAM_SCOPE_MISMATCH: this team is not part of this fixture' using errcode = 'P0001';
  end if;

  -- UG-CR-GATE-089 (roster fixture scope). Nothing the caller sent is trusted to describe a relationship: the
  -- fixture's competition and its two team slots were just read under the competition_scope advisory lock and a
  -- row lock (every writer of those relationships takes the same advisory lock first), and the team's own
  -- competition is read here, in the same transaction. The team must be EXACTLY one of this fixture's two slots
  -- AND belong to the same competition as the fixture. IS DISTINCT FROM keeps the comparison null-safe: the Final's
  -- slots start NULL, and a NULL can never match. This runs before the organizer/captain decision and before any
  -- lifecycle check, for both branches, so neither organizer authority nor captaincy of a team elsewhere can
  -- substitute for the fixture/team relationship.
  select competition_teams.competition_id into v_team_competition_id
    from competition_teams
   where competition_teams.competition_team_id = p_competition_team_id
     for share;

  if v_team_competition_id is distinct from v_competition_id
     or (p_competition_team_id is distinct from v_team_a_id and p_competition_team_id is distinct from v_team_b_id) then
    raise exception 'FIXTURE_TEAM_SCOPE_MISMATCH: this team is not part of this fixture' using errcode = 'P0001';
  end if;

  if v_fixture_state in ('VOID', 'FINALIZED', 'CORRECTED_AND_FINALIZED', 'FORFEIT_FINALIZED') then
    raise exception 'FIXTURE_NOT_OPEN_FOR_ROSTER: this fixture is no longer open for roster declaration'
      using errcode = 'P0001';
  end if;

  -- Structural validation of the roster array itself — distinct from,
  -- and checked earlier than, the per-entry membership/conflict checks
  -- below and the separate minimum-actual-participation rule enforced at
  -- evidence submission (a roster MAY legitimately be declared with
  -- fewer than 4 members; that is exactly what makes a forfeit or void
  -- necessary later — but it may never be empty, and never lists the
  -- same member twice).
  if p_gaming_member_ids is null or array_length(p_gaming_member_ids, 1) is null then
    raise exception 'EMPTY_ROSTER: a roster must include at least one gaming member' using errcode = 'P0001';
  end if;

  if array_length(p_gaming_member_ids, 1) <> (select count(distinct entry) from unnest(p_gaming_member_ids) as entry) then
    raise exception 'DUPLICATE_ROSTER_ENTRY: a roster may not list the same gaming member more than once' using errcode = 'P0001';
  end if;

  select competition_teams.captain_gaming_member_id into v_captain_id
    from competition_teams where competition_teams.competition_team_id = p_competition_team_id;

  select competitions.organizer_gaming_member_id, competitions.state
    into v_organizer_id, v_competition_state
    from competitions where competitions.competition_id = v_competition_id;

  if v_competition_state = 'CANCELLED_WITHOUT_CHAMPION' then
    raise exception 'COMPETITION_CANCELLED: this competition has been cancelled and no longer accepts this action'
      using errcode = 'P0001';
  end if;

  if p_is_organizer_action then
    if p_declaring_gaming_member_id is distinct from v_organizer_id then
      raise exception 'COMPETITION_ACCESS_DENIED: only the organizer may correct a roster' using errcode = 'P0001';
    end if;
    perform assert_competition_not_host_revoked(v_competition_id);
    if p_reason is null or length(trim(p_reason)) = 0 then
      raise exception 'REASON_REQUIRED: an organizer roster correction requires a reason' using errcode = 'P0001';
    end if;
  else
    if p_declaring_gaming_member_id is distinct from v_captain_id then
      raise exception 'NOT_TEAM_CAPTAIN: only this team''s own captain may declare its roster' using errcode = 'P0001';
    end if;
  end if;

  -- Every entry: current approved membership on this team, and not the
  -- fixture's own scorekeeper.
  foreach v_member_id in array p_gaming_member_ids loop
    if not exists (
      select 1 from competition_team_memberships
      where competition_team_memberships.competition_team_id = p_competition_team_id
        and competition_team_memberships.gaming_member_id = v_member_id
    ) then
      raise exception 'ROSTER_MEMBER_NOT_APPROVED: gaming member % has no approved membership on this team', v_member_id
        using errcode = 'P0001';
    end if;

    if v_scorekeeper_id is not null and v_member_id = v_scorekeeper_id then
      raise exception 'SCOREKEEPER_CONFLICT_OF_INTEREST: the appointed scorekeeper cannot appear on either team''s roster'
        using errcode = 'P0001';
    end if;
  end loop;

  select competition_roster_revisions.competition_roster_revision_id into v_prior_revision_id
    from competition_roster_revisions
   where competition_roster_revisions.competition_fixture_id = p_competition_fixture_id
     and competition_roster_revisions.competition_team_id = p_competition_team_id
     and competition_roster_revisions.is_current;

  if v_prior_revision_id is not null then
    update competition_roster_revisions
       set is_current = false
     where competition_roster_revisions.competition_roster_revision_id = v_prior_revision_id;
  end if;

  v_declared_at := now();

  insert into competition_roster_revisions (competition_fixture_id, competition_team_id, declared_by_gaming_member_id, declared_at, reason, supersedes_revision_id, is_current)
  values (p_competition_fixture_id, p_competition_team_id, p_declaring_gaming_member_id, v_declared_at, p_reason, v_prior_revision_id, true)
  returning competition_roster_revisions.competition_roster_revision_id into v_new_revision_id;

  insert into competition_roster_revision_entries (competition_roster_revision_id, gaming_member_id)
  select v_new_revision_id, member_id from unnest(p_gaming_member_ids) as member_id;

  if v_fixture_state = 'SCHEDULED' then
    select exists(
      select 1 from competition_roster_revisions
      where competition_roster_revisions.competition_fixture_id = p_competition_fixture_id
        and competition_roster_revisions.competition_team_id = v_other_team_id
        and competition_roster_revisions.is_current
    ) into v_other_team_has_current;

    if v_other_team_has_current then
      update competition_fixtures set state = 'ROSTER_DECLARED' where competition_fixtures.competition_fixture_id = p_competition_fixture_id;
      v_fixture_state := 'ROSTER_DECLARED';
    end if;
  end if;

  return query select v_new_revision_id, v_declared_at, v_fixture_state;
end;
$function$;

revoke all on function declare_competition_roster_atomically(uuid,uuid,uuid,boolean,text,uuid[]) from public, anon, authenticated;
grant execute on function declare_competition_roster_atomically(uuid,uuid,uuid,boolean,text,uuid[]) to service_role;

-- ---------------------------------------------------------------------------
-- Table-level guard: a roster revision's team must be one of the fixture's two slots and belong to the same
-- competition as the fixture. SECURITY INVOKER (it only reads tables the writing role already reads); the
-- functions that write roster revisions are SECURITY DEFINER, so it runs with their privileges.
-- ---------------------------------------------------------------------------
create function competition_roster_revisions_require_fixture_team()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_fixture_competition_id uuid;
  v_team_a_id uuid;
  v_team_b_id uuid;
  v_team_competition_id uuid;
begin
  select f.competition_id, f.team_a_competition_team_id, f.team_b_competition_team_id
    into v_fixture_competition_id, v_team_a_id, v_team_b_id
    from competition_fixtures f
   where f.competition_fixture_id = new.competition_fixture_id;

  select t.competition_id into v_team_competition_id
    from competition_teams t
   where t.competition_team_id = new.competition_team_id;

  if v_fixture_competition_id is null
     or v_team_competition_id is distinct from v_fixture_competition_id
     or (new.competition_team_id is distinct from v_team_a_id and new.competition_team_id is distinct from v_team_b_id) then
    raise exception 'FIXTURE_TEAM_SCOPE_MISMATCH: this team is not part of this fixture' using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger competition_roster_revisions_fixture_team_scope
  before insert or update of competition_fixture_id, competition_team_id on competition_roster_revisions
  for each row execute function competition_roster_revisions_require_fixture_team();

revoke all on function competition_roster_revisions_require_fixture_team() from public, anon, authenticated;
