-- DECLARE_COMPETITION_ROSTER. Actor is the target team's own captain,
-- or the competition's organizer correcting (reason required for an
-- organizer correction of an existing current revision). Serializes on
-- (fixture, team) via an advisory transaction lock — chosen over a
-- row-level lock because the very first declaration for a (fixture,
-- team) has no existing row to lock (UG-CR-REV-026 condition 2's own
-- "concurrent writes may not create two current branches" requirement,
-- satisfied here plus by the partial unique index on is_current).
-- Every entry must reference a member holding a current approved
-- membership on this team (UG-CR-RPT-024 §2), and must not be this
-- fixture's own appointed scorekeeper (UG-CR-REV-021 decision 3,
-- checkpoint 2 of 5 — UG-CR-RPT-024 §5).
create or replace function declare_competition_roster_atomically(
  p_competition_fixture_id uuid,
  p_competition_team_id uuid,
  p_declaring_gaming_member_id uuid,
  p_is_organizer_action boolean,
  p_reason text,
  p_gaming_member_ids uuid[]
)
returns table (
  competition_roster_revision_id uuid,
  declared_at timestamptz,
  fixture_state text
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_competition_id uuid;
  v_captain_id uuid;
  v_organizer_id uuid;
  v_scorekeeper_id uuid;
  v_fixture_state text;
  v_prior_revision_id uuid;
  v_new_revision_id uuid;
  v_declared_at timestamptz;
  v_other_team_id uuid;
  v_other_team_has_current boolean;
  v_member_id uuid;
begin
  perform pg_advisory_xact_lock(hashtextextended(p_competition_fixture_id::text || ':' || p_competition_team_id::text, 0));

  select competition_fixtures.competition_id, competition_fixtures.state, competition_fixtures.scorekeeper_gaming_member_id,
         (case when competition_fixtures.team_a_competition_team_id = p_competition_team_id
               then competition_fixtures.team_b_competition_team_id
               else competition_fixtures.team_a_competition_team_id end)
    into v_competition_id, v_fixture_state, v_scorekeeper_id, v_other_team_id
    from competition_fixtures
   where competition_fixtures.competition_fixture_id = p_competition_fixture_id;

  if v_competition_id is null then
    raise exception 'FIXTURE_NOT_FOUND: no such fixture exists' using errcode = 'P0001';
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

  select competitions.organizer_gaming_member_id into v_organizer_id
    from competitions where competitions.competition_id = v_competition_id;

  if p_is_organizer_action then
    if p_declaring_gaming_member_id <> v_organizer_id then
      raise exception 'COMPETITION_ACCESS_DENIED: only the organizer may correct a roster' using errcode = 'P0001';
    end if;
    if p_reason is null or length(trim(p_reason)) = 0 then
      raise exception 'REASON_REQUIRED: an organizer roster correction requires a reason' using errcode = 'P0001';
    end if;
  else
    if p_declaring_gaming_member_id <> v_captain_id then
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
$$;

revoke all on function declare_competition_roster_atomically(uuid, uuid, uuid, boolean, text, uuid[]) from public, anon, authenticated;
grant execute on function declare_competition_roster_atomically(uuid, uuid, uuid, boolean, text, uuid[]) to service_role;
