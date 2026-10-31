-- Migration 20261025120000 — database-level coherence between the answers of a progressive participation.
-- Append-only: a new file after 20261023180100. It replaces ONE function with "create or replace" (same signature, same return shape, so its ACL is
-- kept, and it is asserted again at the end). The body is the body in 20261023180000_add_progressive_prediction_contract.sql with ONE block added
-- (marked in it). Converted from the reviewed proposal PROPOSED_20261025120000_progressive_answer_coherence.sql; the function body below is
-- byte-identical to that proposal's.
--
-- Why: coherence (0-0 only with "none", "none" only with 0-0, the first team and the goalscorer from a team with goals) is enforced today by the
-- application and the in-memory repository. The database function accepts any shape-valid combination, so a caller that reaches it without the
-- application (a direct service-role call) could still write one. This gives the database the same rule, with the same texts.
--
-- What it does NOT do: it does not rewrite, validate or delete any stored prediction (a participation saved before the rule stays as it is and its
-- exact replay is still returned); it adds no column, table, constraint or trigger; it does not touch evaluation, prizes, XP or results.

create or replace function upsert_progressive_prediction_atomically(
  p_match_id uuid,
  p_gaming_member_id uuid,
  p_venue_activation_id uuid,
  p_attempted_level integer,
  p_predicted_home_score integer,
  p_predicted_away_score integer,
  p_first_team_state text,
  p_first_team text,
  p_goalscorer_state text,
  p_goalscorer_player_id uuid,
  p_goal_minute_state text,
  p_goal_minute_regulation integer,
  p_goal_minute_stoppage integer,
  p_offer_digest text,
  p_geo_verified_at timestamptz,
  p_measured_distance_meters numeric,
  p_reported_accuracy_meters numeric,
  p_geo_eligible boolean
)
returns setof predictions
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_kickoff_at timestamptz;
  v_cancelled_at timestamptz;
  v_activity_classification text;
  v_contract text;
  v_home_team_id uuid;
  v_away_team_id uuid;
  v_activation_match_id uuid;
  v_activation_enabled boolean;
  v_max_level smallint;
  v_digest text;
  v_existing_id uuid;
  v_existing_venue_activation_id uuid;
  v_replay_id uuid;
  v_goalscorer_team_id uuid;
  v_goalscorer_active boolean;
begin
  select matches.kickoff_at, matches.cancelled_at, matches.activity_classification,
         matches.prediction_contract, matches.home_team_id, matches.away_team_id
    into v_kickoff_at, v_cancelled_at, v_activity_classification,
         v_contract, v_home_team_id, v_away_team_id
  from matches
  where matches.match_id = p_match_id
  for update;

  if v_kickoff_at is null then
    raise exception 'MATCH_NOT_FOUND: no match exists for this match_id'
      using errcode = 'P0001';
  end if;

  if v_contract <> 'PROGRESSIVE_LADDER_V1' then
    raise exception 'CONTRACT_MISMATCH: this match does not use the progressive prediction contract'
      using errcode = 'P0001';
  end if;

  -- An exact replay of the request already accepted for this member and
  -- match returns what is stored and writes nothing: the row is not updated
  -- and its geolocation evidence is not rewritten. It is decided before the
  -- checks that close a match (cancelled, kickoff, finalized result, closed
  -- activation, geolocation), because a replay changes nothing and so cannot
  -- be refused for what has happened since. A request that differs in ANY
  -- answer, in the venue or in the offer fingerprint is a new edit and goes
  -- through every check below. The stored row is locked here, under the
  -- match lock this function already holds.
  select predictions.prediction_id into v_replay_id
  from predictions
  where predictions.match_id = p_match_id
    and predictions.gaming_member_id = p_gaming_member_id
    and predictions.venue_activation_id = p_venue_activation_id
    and predictions.prediction_contract = 'PROGRESSIVE_LADDER_V1'
    and predictions.attempted_level is not distinct from p_attempted_level
    and predictions.predicted_home_score is not distinct from p_predicted_home_score
    and predictions.predicted_away_score is not distinct from p_predicted_away_score
    and predictions.first_team_state is not distinct from p_first_team_state
    and predictions.predicted_first_team_to_score is not distinct from p_first_team
    and predictions.goalscorer_state is not distinct from p_goalscorer_state
    and predictions.predicted_goalscorer_player_id is not distinct from p_goalscorer_player_id
    and predictions.goal_minute_state is not distinct from p_goal_minute_state
    and predictions.predicted_goal_minute_regulation is not distinct from p_goal_minute_regulation
    and predictions.predicted_goal_minute_stoppage is not distinct from p_goal_minute_stoppage
    and p_offer_digest is not null
    and predictions.accepted_offer_digest = p_offer_digest
  for update;

  if v_replay_id is not null then
    return query select * from predictions where predictions.prediction_id = v_replay_id;
    return;
  end if;

  if v_cancelled_at is not null then
    raise exception 'MATCH_CANCELLED: this match has been cancelled'
      using errcode = 'P0001';
  end if;

  if v_activity_classification is null then
    raise exception 'MATCH_NOT_CLASSIFIED: this match has no declared Activity Classification and cannot accept predictions yet'
      using errcode = 'P0001';
  end if;

  if now() >= v_kickoff_at then
    raise exception 'KICKOFF_PASSED: predictions are locked for this match'
      using errcode = 'P0001';
  end if;

  if exists (
    select 1 from match_results
    where match_results.match_id = p_match_id
      and match_results.finalized_at is not null
  ) then
    raise exception 'RESULT_ALREADY_FINALIZED: this match already has a finalized result, so predictions can no longer be created or edited'
      using errcode = 'P0001';
  end if;

  select venue_activations.match_id, venue_activations.enabled
    into v_activation_match_id, v_activation_enabled
  from venue_activations
  where venue_activations.venue_activation_id = p_venue_activation_id
  for share;

  if v_activation_match_id is null then
    raise exception 'VENUE_ACTIVATION_NOT_FOUND: no venue activation exists for this id'
      using errcode = 'P0001';
  end if;

  if v_activation_match_id <> p_match_id then
    raise exception 'VENUE_ACTIVATION_MATCH_MISMATCH: this venue activation is not for the supplied match'
      using errcode = 'P0001';
  end if;

  if not v_activation_enabled then
    raise exception 'VENUE_ACTIVATION_DISABLED: this venue activation is not currently enabled'
      using errcode = 'P0001';
  end if;

  if p_geo_eligible is not true then
    raise exception 'GEO_NOT_ELIGIBLE: submission failed geolocation eligibility'
      using errcode = 'P0001';
  end if;

  -- Shape. A category above the attempted level must be NOT_ATTEMPTED with
  -- no value; one at or below it must be NONE (no value) or PICKED (its
  -- value). A missing category, a value under a state without one and a
  -- contradiction between the level and the states are all refused.
  if p_attempted_level is null or p_attempted_level not between 1 and 4 then
    raise exception 'INVALID_ATTEMPT_SHAPE: the attempted level must be a whole number from 1 to 4'
      using errcode = 'P0001';
  end if;

  if p_predicted_home_score is null or p_predicted_away_score is null
     or p_predicted_home_score < 0 or p_predicted_away_score < 0 then
    raise exception 'INVALID_ATTEMPT_SHAPE: the scoreline must have both scores, as non-negative whole numbers'
      using errcode = 'P0001';
  end if;

  if p_first_team_state is null
     or p_first_team_state not in ('NOT_ATTEMPTED', 'NONE', 'PICKED')
     or (p_attempted_level >= 2) <> (p_first_team_state <> 'NOT_ATTEMPTED') then
    raise exception 'INVALID_ATTEMPT_SHAPE: the first team category contradicts the attempted level'
      using errcode = 'P0001';
  end if;
  if p_goalscorer_state is null
     or p_goalscorer_state not in ('NOT_ATTEMPTED', 'NONE', 'PICKED')
     or (p_attempted_level >= 3) <> (p_goalscorer_state <> 'NOT_ATTEMPTED') then
    raise exception 'INVALID_ATTEMPT_SHAPE: the goalscorer category contradicts the attempted level'
      using errcode = 'P0001';
  end if;
  if p_goal_minute_state is null
     or p_goal_minute_state not in ('NOT_ATTEMPTED', 'NONE', 'PICKED')
     or (p_attempted_level >= 4) <> (p_goal_minute_state <> 'NOT_ATTEMPTED') then
    raise exception 'INVALID_ATTEMPT_SHAPE: the goal minute category contradicts the attempted level'
      using errcode = 'P0001';
  end if;

  if (p_first_team_state = 'PICKED') <> (p_first_team is not null)
     or (p_first_team is not null and p_first_team not in ('HOME', 'AWAY')) then
    raise exception 'INVALID_ATTEMPT_SHAPE: the first team value must be HOME or AWAY, and only when the category is PICKED'
      using errcode = 'P0001';
  end if;
  if (p_goalscorer_state = 'PICKED') <> (p_goalscorer_player_id is not null) then
    raise exception 'INVALID_ATTEMPT_SHAPE: a goalscorer player is given exactly when the category is PICKED'
      using errcode = 'P0001';
  end if;
  if (p_goal_minute_state = 'PICKED') <> (p_goal_minute_regulation is not null)
     or (p_goal_minute_stoppage is not null and p_goal_minute_state <> 'PICKED') then
    raise exception 'INVALID_ATTEMPT_SHAPE: a goal minute is given exactly when the category is PICKED'
      using errcode = 'P0001';
  end if;
  if p_goal_minute_regulation is not null
     and (p_goal_minute_regulation < 1 or p_goal_minute_regulation > 90) then
    raise exception 'INVALID_ATTEMPT_SHAPE: the goal minute must be between 1 and 90'
      using errcode = 'P0001';
  end if;
  if p_goal_minute_stoppage is not null
     and (p_goal_minute_stoppage <= 0 or p_goal_minute_regulation not in (45, 90)) then
    raise exception 'INVALID_ATTEMPT_SHAPE: added time is a positive whole number and only with minute 45 or 90'
      using errcode = 'P0001';
  end if;

  -- The offer. The activation row is share-locked above, so a tier change
  -- (which needs a no-key-update lock on it) cannot slip in between this
  -- read and the write.
  v_max_level := progressive_offer_max_level(p_venue_activation_id);
  if v_max_level = 0 then
    raise exception 'OFFER_NOT_AVAILABLE: this venue has no valid prize offer for this match, so it cannot take new predictions'
      using errcode = 'P0001';
  end if;
  if p_attempted_level > v_max_level then
    raise exception 'LEVEL_NOT_OFFERED: that level is not offered at this venue'
      using errcode = 'P0001';
  end if;
  if p_offer_digest is null or length(p_offer_digest) = 0 then
    raise exception 'OFFER_DIGEST_REQUIRED: the fingerprint of the prize offer you saw is required to send a prediction'
      using errcode = 'P0001';
  end if;
  v_digest := progressive_offer_digest(p_venue_activation_id);
  if p_offer_digest <> v_digest then
    raise exception 'OFFER_CHANGED: the prizes offered at this venue changed since you loaded the page'
      using errcode = 'P0001';
  end if;

  if p_goalscorer_player_id is not null then
    select players.team_id, players.active into v_goalscorer_team_id, v_goalscorer_active
    from players
    where players.player_id = p_goalscorer_player_id;

    if v_goalscorer_team_id is null then
      raise exception 'INVALID_GOALSCORER_SELECTION: no player exists for this id'
        using errcode = 'P0001';
    end if;

    if v_goalscorer_team_id <> v_home_team_id and v_goalscorer_team_id <> v_away_team_id then
      raise exception 'INVALID_GOALSCORER_SELECTION: this player does not belong to either team in this match'
        using errcode = 'P0001';
    end if;

    if not v_goalscorer_active then
      raise exception 'INVALID_GOALSCORER_SELECTION: this player is not currently selectable'
        using errcode = 'P0001';
    end if;
  end if;

  -- Coherence between answers. It judges a NEW answer or an EDIT: an exact replay was returned above and is never judged again, so a
  -- prediction accepted before this rule keeps being returned as it is. The order is the application's (lib/gaming/predictions/
  -- prizeLadder.ts, progressiveCoherenceProblems), and the texts are the application's, so the same refusal reads the same from either:
  --   0-0: a later attempted category can only be answered with an explicit NONE;
  --   any goal: NONE is not an answer for a later category;
  --   the first team to score needs at least one goal in the predicted scoreline;
  --   the goalscorer must belong to a team with at least one goal in the predicted scoreline.
  -- A category that was not attempted is NOT_ATTEMPTED, is never completed here and is never raised to a level.
  if p_predicted_home_score + p_predicted_away_score = 0 then
    if p_first_team_state = 'PICKED' or p_goalscorer_state = 'PICKED' or p_goal_minute_state = 'PICKED' then
      raise exception 'INVALID_ATTEMPT_SHAPE: With a 0-0 scoreline, a later category can only be answered with none.'
        using errcode = 'P0001';
    end if;
  else
    if p_first_team_state = 'NONE' or p_goalscorer_state = 'NONE' or p_goal_minute_state = 'NONE' then
      raise exception 'INVALID_ATTEMPT_SHAPE: With goals in the scoreline, none is not a valid answer for a later category.'
        using errcode = 'P0001';
    end if;
    if p_first_team_state = 'PICKED'
       and ((p_first_team = 'HOME' and p_predicted_home_score = 0)
         or (p_first_team = 'AWAY' and p_predicted_away_score = 0)) then
      raise exception 'INVALID_ATTEMPT_SHAPE: The first team to score must have at least one goal in the predicted scoreline.'
        using errcode = 'P0001';
    end if;
    if p_goalscorer_state = 'PICKED'
       and ((v_goalscorer_team_id = v_home_team_id and p_predicted_home_score = 0)
         or (v_goalscorer_team_id = v_away_team_id and p_predicted_away_score = 0)) then
      raise exception 'INVALID_ATTEMPT_SHAPE: The goalscorer must belong to a team with at least one goal in the predicted scoreline.'
        using errcode = 'P0001';
    end if;
  end if;

  select predictions.prediction_id, predictions.venue_activation_id
    into v_existing_id, v_existing_venue_activation_id
  from predictions
  where predictions.match_id = p_match_id
    and predictions.gaming_member_id = p_gaming_member_id
  for update;

  if v_existing_id is not null and v_existing_venue_activation_id <> p_venue_activation_id then
    raise exception 'VENUE_ACTIVATION_IMMUTABLE: this prediction was first submitted through a different venue activation'
      using errcode = 'P0001';
  end if;

  if v_existing_id is null then
    insert into predictions (
      match_id, gaming_member_id, venue_activation_id,
      predicted_home_score, predicted_away_score,
      predicted_goalscorer_player_id, predicted_goal_minute_regulation, predicted_goal_minute_stoppage,
      predicted_first_team_to_score,
      prediction_contract, first_team_state, goalscorer_state, goal_minute_state,
      accepted_offer_digest, accepted_offer_max_level,
      geo_verified_at, measured_distance_meters, reported_accuracy_meters, geo_eligible
    )
    values (
      p_match_id, p_gaming_member_id, p_venue_activation_id,
      p_predicted_home_score, p_predicted_away_score,
      p_goalscorer_player_id, p_goal_minute_regulation, p_goal_minute_stoppage,
      p_first_team,
      'PROGRESSIVE_LADDER_V1', p_first_team_state, p_goalscorer_state, p_goal_minute_state,
      v_digest, v_max_level,
      p_geo_verified_at, p_measured_distance_meters, p_reported_accuracy_meters, p_geo_eligible
    )
    returning predictions.prediction_id into v_existing_id;
  else
    -- The whole row is replaced: a lower attempted level overwrites every
    -- higher category with NOT_ATTEMPTED and no value, in this statement.
    update predictions set
      predicted_home_score = p_predicted_home_score,
      predicted_away_score = p_predicted_away_score,
      predicted_goalscorer_player_id = p_goalscorer_player_id,
      predicted_goal_minute_regulation = p_goal_minute_regulation,
      predicted_goal_minute_stoppage = p_goal_minute_stoppage,
      predicted_first_team_to_score = p_first_team,
      first_team_state = p_first_team_state,
      goalscorer_state = p_goalscorer_state,
      goal_minute_state = p_goal_minute_state,
      accepted_offer_digest = v_digest,
      accepted_offer_max_level = v_max_level,
      geo_verified_at = p_geo_verified_at,
      measured_distance_meters = p_measured_distance_meters,
      reported_accuracy_meters = p_reported_accuracy_meters,
      geo_eligible = p_geo_eligible,
      updated_at = now()
    where predictions.prediction_id = v_existing_id;
  end if;

  return query select * from predictions where predictions.prediction_id = v_existing_id;
end;
$$;

revoke execute on function upsert_progressive_prediction_atomically(uuid, uuid, uuid, integer, integer, integer, text, text, text, uuid, text, integer, integer, text, timestamptz, numeric, numeric, boolean) from public, anon, authenticated;
grant execute on function upsert_progressive_prediction_atomically(uuid, uuid, uuid, integer, integer, integer, text, text, text, uuid, text, integer, integer, text, timestamptz, numeric, numeric, boolean) to service_role;
