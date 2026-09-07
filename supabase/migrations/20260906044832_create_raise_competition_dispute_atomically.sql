-- RAISE_COMPETITION_DISPUTE. A directly affected member, or a captain
-- on behalf of their own team/players, may flag a dispute — never
-- itself changes a fact, only requests organizer review (UG-CR-
-- RPT-016 §8). The organizer is never required to raise one to
-- exercise their own direct correction/finalization authority.
--
-- UG-CR-GATE-032 correction: the caller's authorization for the
-- SPECIFIC target fact is now derived entirely from current database
-- state inside this function — never from the UI, the HTTP route, or
-- any client-supplied authority/team/actor claim. Bounded to the four
-- accepted target_fact_type values named in the accepted design
-- (UG-CR-RPT-020 §3's own CompetitionDisputeRecord.targetFactType
-- enum): PARTICIPATION_ATTESTATION, SCORE, GOAL_EVENT, ASSIST_EVENT.
--
-- SHOOTOUT is not accepted here: the accepted design never defined an
-- unambiguous directly-affected-member or team-ownership mapping for a
-- shootout outcome — soccer_penalty_shootouts has no per-player
-- attribution and no single "owning" team column (it names only the
-- WINNING team), so there is no principled way to say who is "directly
-- affected" versus merely on the losing side. First reported as an
-- ambiguity in UG-CR-RPT-032 rather than silently resolved; UG-CR-
-- GATE-033 then removed SHOOTOUT consistently from the table's own
-- CHECK constraint, the TS DisputeTargetFactType union, and every
-- selectable UI, so this check is now also the type-level guarantee,
-- not just a defensive one — a SHOOTOUT dispute attempt is rejected as
-- UNSUPPORTED_TARGET_FACT_TYPE.
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
  v_fixture_exists boolean;
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
  select exists(select 1 from competition_fixtures where competition_fixtures.competition_fixture_id = p_competition_fixture_id)
    into v_fixture_exists;

  if not v_fixture_exists then
    raise exception 'FIXTURE_NOT_FOUND: no such fixture exists' using errcode = 'P0001';
  end if;

  select competition_fixtures.team_a_competition_team_id, competition_fixtures.team_b_competition_team_id
    into v_team_a, v_team_b
    from competition_fixtures
   where competition_fixtures.competition_fixture_id = p_competition_fixture_id;

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
