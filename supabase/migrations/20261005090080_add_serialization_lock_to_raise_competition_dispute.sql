-- RAISE_COMPETITION_DISPUTE — add competition-scoped serialization lock
-- (UG-CR-GATE-083 per UG-CR-REV-054 finding 1). See
-- 20261005090000_add_serialization_lock_to_cancel_incomplete_competition.sql
-- for the full rationale and the one global lock order this domain now
-- follows. This function's own first database operation is a plain
-- (non-locking) SELECT that already resolves competition_id (from the
-- fixture) before anything else — a plain read never participates in a
-- lock-ordering/deadlock analysis, so no restructuring is needed here:
-- the lock is simply acquired right after that select's own
-- FIXTURE_NOT_FOUND check, before the competitions.state lookup. Every
-- other line is unchanged from
-- 20261002090080_add_cancellation_guard_to_raise_competition_dispute.sql.
create or replace function raise_competition_dispute_atomically(
  p_competition_fixture_id uuid,
  p_raised_by_gaming_member_id uuid,
  p_target_fact_type text,
  p_target_fact_id uuid,
  p_reason text
)
returns table (competition_dispute_id uuid, raised_at timestamptz)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_competition_id uuid;
  v_competition_state text;
  v_team_a uuid;
  v_team_b uuid;
  v_dispute_id uuid;
  v_raised_at timestamptz;
  v_authorized boolean := false;
  v_att_fixture uuid;
  v_att_member uuid;
  v_att_current boolean;
  v_att_team uuid;
  v_goal_fixture uuid;
  v_goal_scorer uuid;
  v_goal_team uuid;
  v_goal_current boolean;
  v_assist_fixture uuid;
  v_assist_member uuid;
  v_assist_current boolean;
  v_assist_team uuid;
  v_score_fixture uuid;
  v_score_current boolean;
begin
  select competition_fixtures.competition_id, competition_fixtures.team_a_competition_team_id,
         competition_fixtures.team_b_competition_team_id
    into v_competition_id, v_team_a, v_team_b
    from competition_fixtures
   where competition_fixtures.competition_fixture_id = p_competition_fixture_id;

  if v_competition_id is null then
    raise exception 'FIXTURE_NOT_FOUND: no such fixture exists' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('competition_scope:' || v_competition_id::text));

  select competitions.state into v_competition_state
    from competitions where competitions.competition_id = v_competition_id;

  if v_competition_state = 'CANCELLED_WITHOUT_CHAMPION' then
    raise exception 'COMPETITION_CANCELLED: this competition has been cancelled and no longer accepts this action'
      using errcode = 'P0001';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'REASON_REQUIRED: a dispute requires a reason' using errcode = 'P0001';
  end if;

  if p_target_fact_type not in ('PARTICIPATION_ATTESTATION', 'SCORE', 'GOAL_EVENT', 'ASSIST_EVENT') then
    raise exception 'UNSUPPORTED_TARGET_FACT_TYPE: this target fact type cannot be disputed' using errcode = 'P0001';
  end if;

  if p_target_fact_type = 'PARTICIPATION_ATTESTATION' then
    select competition_participation_attestations.competition_fixture_id,
           competition_participation_attestations.gaming_member_id,
           competition_participation_attestations.is_current
      into v_att_fixture, v_att_member, v_att_current
      from competition_participation_attestations
     where competition_participation_attestations.competition_participation_attestation_id = p_target_fact_id;

    if not found then
      raise exception 'TARGET_FACT_NOT_FOUND: no such participation attestation exists' using errcode = 'P0001';
    end if;

    if v_att_fixture <> p_competition_fixture_id then
      raise exception 'TARGET_FACT_FIXTURE_MISMATCH: the target fact does not belong to this fixture' using errcode = 'P0001';
    end if;

    if not v_att_current then
      raise exception 'TARGET_FACT_NOT_CURRENT: a superseded fact cannot receive a new dispute' using errcode = 'P0001';
    end if;

    -- Directly affected: the attested member themselves. Captain: the
    -- attested member's OWN current-roster team for this fixture —
    -- derived here, never trusted from the client.
    select revisions.competition_team_id into v_att_team
      from competition_roster_revision_entries entries
      join competition_roster_revisions revisions
        on revisions.competition_roster_revision_id = entries.competition_roster_revision_id
     where revisions.competition_fixture_id = p_competition_fixture_id
       and revisions.is_current
       and entries.gaming_member_id = v_att_member;

    v_authorized := (p_raised_by_gaming_member_id = v_att_member)
      or exists (
        select 1 from competition_teams
         where competition_teams.competition_team_id = v_att_team
           and competition_teams.captain_gaming_member_id = p_raised_by_gaming_member_id
      );

  elsif p_target_fact_type = 'GOAL_EVENT' then
    select soccer_goal_events.competition_fixture_id,
           soccer_goal_events.scorer_gaming_member_id,
           soccer_goal_events.competition_team_id,
           soccer_goal_events.is_current
      into v_goal_fixture, v_goal_scorer, v_goal_team, v_goal_current
      from soccer_goal_events
     where soccer_goal_events.soccer_goal_event_id = p_target_fact_id;

    if not found then
      raise exception 'TARGET_FACT_NOT_FOUND: no such goal event exists' using errcode = 'P0001';
    end if;

    if v_goal_fixture <> p_competition_fixture_id then
      raise exception 'TARGET_FACT_FIXTURE_MISMATCH: the target fact does not belong to this fixture' using errcode = 'P0001';
    end if;

    if not v_goal_current then
      raise exception 'TARGET_FACT_NOT_CURRENT: a superseded fact cannot receive a new dispute' using errcode = 'P0001';
    end if;

    -- Directly affected: the scorer. Captain: the goal's own recorded
    -- competition_team_id (an opposing-team captain never matches).
    v_authorized := (p_raised_by_gaming_member_id = v_goal_scorer)
      or exists (
        select 1 from competition_teams
         where competition_teams.competition_team_id = v_goal_team
           and competition_teams.captain_gaming_member_id = p_raised_by_gaming_member_id
      );

  elsif p_target_fact_type = 'ASSIST_EVENT' then
    select soccer_assist_events.competition_fixture_id,
           soccer_assist_events.assisting_gaming_member_id,
           soccer_assist_events.is_current
      into v_assist_fixture, v_assist_member, v_assist_current
      from soccer_assist_events
     where soccer_assist_events.soccer_assist_event_id = p_target_fact_id;

    if not found then
      raise exception 'TARGET_FACT_NOT_FOUND: no such assist event exists' using errcode = 'P0001';
    end if;

    if v_assist_fixture <> p_competition_fixture_id then
      raise exception 'TARGET_FACT_FIXTURE_MISMATCH: the target fact does not belong to this fixture' using errcode = 'P0001';
    end if;

    if not v_assist_current then
      raise exception 'TARGET_FACT_NOT_CURRENT: a superseded fact cannot receive a new dispute' using errcode = 'P0001';
    end if;

    -- Directly affected: the assisting player. Captain: the assisting
    -- player's OWN current-roster team for this fixture — derived the
    -- same way as PARTICIPATION_ATTESTATION above, since soccer_assist_
    -- events itself carries no team column.
    select revisions.competition_team_id into v_assist_team
      from competition_roster_revision_entries entries
      join competition_roster_revisions revisions
        on revisions.competition_roster_revision_id = entries.competition_roster_revision_id
     where revisions.competition_fixture_id = p_competition_fixture_id
       and revisions.is_current
       and entries.gaming_member_id = v_assist_member;

    v_authorized := (p_raised_by_gaming_member_id = v_assist_member)
      or exists (
        select 1 from competition_teams
         where competition_teams.competition_team_id = v_assist_team
           and competition_teams.captain_gaming_member_id = p_raised_by_gaming_member_id
      );

  else -- SCORE
    select competition_fixture_evidence.competition_fixture_id,
           competition_fixture_evidence.is_current
      into v_score_fixture, v_score_current
      from competition_fixture_evidence
     where competition_fixture_evidence.competition_fixture_evidence_id = p_target_fact_id;

    if not found then
      raise exception 'TARGET_FACT_NOT_FOUND: no such fixture evidence exists' using errcode = 'P0001';
    end if;

    if v_score_fixture <> p_competition_fixture_id then
      raise exception 'TARGET_FACT_FIXTURE_MISMATCH: the target fact does not belong to this fixture' using errcode = 'P0001';
    end if;

    if not v_score_current then
      raise exception 'TARGET_FACT_NOT_CURRENT: a superseded fact cannot receive a new dispute' using errcode = 'P0001';
    end if;

    -- SCORE is a whole-fixture fact with no single owning member or
    -- team — an ordinary member has no individual "own fact" to point
    -- to here, so only the captain of one of the two competing teams
    -- may dispute it.
    v_authorized := exists (
      select 1 from competition_teams
       where competition_teams.competition_team_id in (v_team_a, v_team_b)
         and competition_teams.captain_gaming_member_id = p_raised_by_gaming_member_id
    );
  end if;

  if not v_authorized then
    raise exception 'DISPUTE_NOT_AUTHORIZED: you are not authorized to dispute this fact' using errcode = 'P0001';
  end if;

  v_raised_at := now();

  insert into competition_disputes (competition_fixture_id, raised_by_gaming_member_id, target_fact_type, target_fact_id, reason, raised_at)
  values (p_competition_fixture_id, p_raised_by_gaming_member_id, p_target_fact_type, p_target_fact_id, p_reason, v_raised_at)
  returning competition_disputes.competition_dispute_id into v_dispute_id;

  return query select v_dispute_id, v_raised_at;
end;
$$;

revoke all on function raise_competition_dispute_atomically(uuid, uuid, text, uuid, text) from public, anon, authenticated;
grant execute on function raise_competition_dispute_atomically(uuid, uuid, text, uuid, text) to service_role;
