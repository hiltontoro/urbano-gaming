-- URBANO Score — progressive predictions and the prize ladder: schema,
-- guards and the new submission function. Append-only; nothing that
-- exists is rewritten, and every historical row keeps its meaning.
--
-- WHAT THIS ADDS
--
--   * matches.prediction_contract: a per-Match contract version.
--       COMPLETE_COUNT_V1    the historical contract (the default for every
--                            row that exists): four dimensions answered,
--                            null means "No Goal", prize by the number of
--                            correct dimensions.
--       PROGRESSIVE_LADDER_V1 a consecutive prefix of categories (1 scoreline,
--                            2 first team, 3 goalscorer, 4 goal minute) with
--                            an explicit state per category; prize by the WON
--                            level (the consecutive correct prefix); only the
--                            levels the activation offers can be attempted.
--     The contract is frozen from the Match's first prediction or result.
--
--   * Explicit category states on predictions. NOT_ATTEMPTED (the member did
--     not reach the category), NONE (the deliberate "no team / no player / no
--     minute" answer) and PICKED (a selection) are three different things and
--     are never stored as a bare null. CHECK constraints refuse gaps, a value
--     under a state that has none, contradictory rows and a level above the
--     offer, whatever wrote the row.
--
--   * The accepted offer. A progressive prediction records the fingerprint of
--     the prize offer the member saw and the highest level it allowed. From
--     the first prediction for an activation its prize tiers cannot change
--     (levels, labels, highest level offered), and a submission made against
--     an offer that has since changed is refused. Lock order is fixed
--     (matches, then venue_activations) so these guards cannot deadlock with
--     the settlement functions.
--
--   * evaluations: the contract, the attempted level and the won level
--     (ladder_level, never more than attempted_level); the three optional
--     outcomes may be null (= not attempted, which is never "correct").
--     correct_dimension_count keeps its meaning (the number of true outcomes).
--
--   * prize_tiers.ladder_level: the key of a progressive tier. Exactly one of
--     it and correct_dimension_count is set. A historical count tier is inert
--     on a progressive Match; the two keys are never converted.
--
--   * upsert_progressive_prediction_atomically: the single write path for a
--     progressive prediction. A request that is an EXACT REPLAY of the one
--     already accepted for this member and match (same venue, same answers,
--     same offer fingerprint) returns the confirmed row and writes nothing:
--     no update of the row, no new geolocation evidence, whatever the clock,
--     the activation or the match have done since. Anything else is a new
--     edit and passes every check below, so nothing can be changed after
--     kickoff, after a result is finalized, or once the activation is closed.
--
--   * upsert_prediction_atomically (the historical write path) is replaced in
--     place, same signature and privileges, body of migration 0096 unchanged
--     except for one first check: a Match that does not use the historical
--     contract is refused (CONTRACT_MISMATCH) whether the call would create a
--     prediction or edit one. Before this check the predictions guard refused
--     only the INSERT of a historical-shaped row on a progressive Match; an
--     UPDATE of an existing progressive row passed it.
--
--   * No prediction is created or edited once a result is finalized,
--     whatever the kickoff says (for both contracts, and for direct writes).
--
-- NOT CHANGED: finalize/correct (the next migration), redeem, release hold,
-- the evidence guard, every immutability trigger, XP and the Metagame, and
-- every function's server-only privilege boundary. New functions below are
-- revoked from public, anon and authenticated and granted to service_role
-- only, in this same migration; a check at the end fails the migration if
-- any of them is reachable by a browser role.

-- ---------------------------------------------------------------------
-- matches.prediction_contract
-- ---------------------------------------------------------------------

alter table matches
  add column prediction_contract text not null default 'COMPLETE_COUNT_V1';

alter table matches
  add constraint matches_prediction_contract_known
  check (prediction_contract in ('COMPLETE_COUNT_V1', 'PROGRESSIVE_LADDER_V1'));

create function matches_contract_freeze()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  -- The Match row is already locked by the UPDATE; creating a prediction
  -- takes a share lock on it first, and saving a result takes the Match
  -- lock first, so "change the contract" and "create the first prediction
  -- or result" are serialized and this check cannot miss one in flight.
  if exists (select 1 from predictions where predictions.match_id = old.match_id)
     or exists (select 1 from match_results where match_results.match_id = old.match_id) then
    raise exception 'CONTRACT_FROZEN: this match already has a prediction or a result, so its prediction contract can no longer change'
      using errcode = 'P0001';
  end if;
  return new;
end;
$$;

create trigger matches_contract_freeze
  before update of prediction_contract on matches
  for each row
  when (old.prediction_contract is distinct from new.prediction_contract)
  execute function matches_contract_freeze();

-- ---------------------------------------------------------------------
-- prize_tiers: the ladder key
-- ---------------------------------------------------------------------

alter table prize_tiers
  alter column correct_dimension_count drop not null;

alter table prize_tiers
  add column ladder_level smallint null;

alter table prize_tiers
  add constraint prize_tiers_ladder_level_range
  check (ladder_level is null or ladder_level between 1 and 4);

alter table prize_tiers
  add constraint prize_tiers_exactly_one_key
  check ((correct_dimension_count is null) <> (ladder_level is null));

create unique index prize_tiers_activation_ladder_level_key
  on prize_tiers (venue_activation_id, ladder_level)
  where ladder_level is not null;

-- ---------------------------------------------------------------------
-- Prize offer helpers (pure reads of prize_tiers)
-- ---------------------------------------------------------------------

-- Highest level an activation offers: its ladder tiers must be exactly
-- levels 1..n for some n from 1 to 4 (Easy; Easy+Medium; Easy+Medium+Hard;
-- all four). No ladder tiers, or a gap, means 0: the activation takes no
-- new participations. There is no descent to a different prize.
create function progressive_offer_max_level(p_venue_activation_id uuid)
returns smallint
language sql
stable
security invoker
set search_path = public
as $$
  select coalesce(
    (
      select case
               when count(*) = max(prize_tiers.ladder_level) and min(prize_tiers.ladder_level) = 1
                 then max(prize_tiers.ladder_level)::smallint
               else 0::smallint
             end
      from prize_tiers
      where prize_tiers.venue_activation_id = p_venue_activation_id
        and prize_tiers.ladder_level is not null
    ),
    0::smallint
  );
$$;

-- Fingerprint of exactly the offered levels and labels, or null when the
-- offer is not available. One line per level in order,
-- "level|length-of-label-in-characters|label", hashed with SHA-256: the
-- application builds the same text, and a test compares the two.
create function progressive_offer_digest(p_venue_activation_id uuid)
returns text
language sql
stable
security invoker
set search_path = public
as $$
  select case
           when progressive_offer_max_level(p_venue_activation_id) = 0 then null
           else encode(
             sha256(
               convert_to(
                 (
                   select string_agg(
                            prize_tiers.ladder_level::text || '|' || char_length(prize_tiers.prize_label)::text || '|' || prize_tiers.prize_label,
                            E'\n' order by prize_tiers.ladder_level
                          )
                   from prize_tiers
                   where prize_tiers.venue_activation_id = p_venue_activation_id
                     and prize_tiers.ladder_level is not null
                 ),
                 'UTF8'
               )
             ),
             'hex'
           )
         end;
$$;

-- The won level: the length of the consecutive run of TRUE outcomes in
-- ladder order, starting at the scoreline. A false outcome and a null one
-- (not attempted) both stop the run.
create function prediction_prize_ladder_level(
  p_scoreline boolean,
  p_first_team boolean,
  p_goalscorer boolean,
  p_goal_minute boolean
)
returns smallint
language sql
immutable
security invoker
set search_path = public
as $$
  select (
    case
      when p_scoreline is not true then 0
      when p_first_team is not true then 1
      when p_goalscorer is not true then 2
      when p_goal_minute is not true then 3
      else 4
    end
  )::smallint;
$$;

-- ---------------------------------------------------------------------
-- predictions: contract, explicit states, accepted offer
-- ---------------------------------------------------------------------

alter table predictions
  add column prediction_contract text not null default 'COMPLETE_COUNT_V1',
  add column first_team_state text null,
  add column goalscorer_state text null,
  add column goal_minute_state text null,
  add column accepted_offer_digest text null,
  add column accepted_offer_max_level smallint null;

alter table predictions
  add column attempted_level smallint
  generated always as (
    case
      when prediction_contract = 'PROGRESSIVE_LADDER_V1'
        then (
          1
          + (first_team_state <> 'NOT_ATTEMPTED')::int
          + (goalscorer_state <> 'NOT_ATTEMPTED')::int
          + (goal_minute_state <> 'NOT_ATTEMPTED')::int
        )::smallint
    end
  ) stored;

alter table predictions
  add constraint predictions_contract_known
  check (prediction_contract in ('COMPLETE_COUNT_V1', 'PROGRESSIVE_LADDER_V1'));

alter table predictions
  add constraint predictions_category_state_values
  check (
    (first_team_state is null or first_team_state in ('NOT_ATTEMPTED', 'NONE', 'PICKED'))
    and (goalscorer_state is null or goalscorer_state in ('NOT_ATTEMPTED', 'NONE', 'PICKED'))
    and (goal_minute_state is null or goal_minute_state in ('NOT_ATTEMPTED', 'NONE', 'PICKED'))
  );

-- The historical contract carries no states and no accepted offer (and a
-- null predicted_* there still means "No Goal"). The progressive contract
-- always carries all three states and the accepted offer.
alter table predictions
  add constraint predictions_contract_shape
  check (
    (
      prediction_contract = 'COMPLETE_COUNT_V1'
      and first_team_state is null
      and goalscorer_state is null
      and goal_minute_state is null
      and accepted_offer_digest is null
      and accepted_offer_max_level is null
    )
    or
    (
      prediction_contract = 'PROGRESSIVE_LADDER_V1'
      and first_team_state is not null
      and goalscorer_state is not null
      and goal_minute_state is not null
      and accepted_offer_digest is not null
      and accepted_offer_max_level is not null
      and accepted_offer_max_level between 1 and 4
    )
  );

-- A value exists exactly when the state is PICKED. NONE and NOT_ATTEMPTED
-- never hold a value; a stoppage offset needs a picked minute.
alter table predictions
  add constraint predictions_progressive_values
  check (
    prediction_contract <> 'PROGRESSIVE_LADDER_V1'
    or (
      ((first_team_state = 'PICKED') = (predicted_first_team_to_score is not null))
      and ((goalscorer_state = 'PICKED') = (predicted_goalscorer_player_id is not null))
      and ((goal_minute_state = 'PICKED') = (predicted_goal_minute_regulation is not null))
      and (predicted_goal_minute_stoppage is null or goal_minute_state = 'PICKED')
    )
  );

-- No gaps: a category cannot be attempted unless every category before it is.
alter table predictions
  add constraint predictions_progressive_no_gaps
  check (
    prediction_contract <> 'PROGRESSIVE_LADDER_V1'
    or (
      (first_team_state <> 'NOT_ATTEMPTED' or goalscorer_state = 'NOT_ATTEMPTED')
      and (goalscorer_state <> 'NOT_ATTEMPTED' or goal_minute_state = 'NOT_ATTEMPTED')
    )
  );

alter table predictions
  add constraint predictions_attempted_level_offered
  check (attempted_level is null or attempted_level <= accepted_offer_max_level);

-- The guard every write to predictions passes, whatever its source.
-- Lock order (matches, then venue_activations) matches the tier guard and
-- the settlement functions, which also take the Match lock first.
create function predictions_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_contract text;
  v_max_level smallint;
  v_digest text;
  v_attempted integer;
begin
  select matches.prediction_contract into v_contract
  from matches
  where matches.match_id = new.match_id
  for share;

  if v_contract is null then
    return new; -- no such match: the foreign key refuses the row
  end if;

  if tg_op = 'UPDATE' and new.prediction_contract is distinct from old.prediction_contract then
    raise exception 'CONTRACT_MISMATCH: the prediction contract of a prediction cannot change'
      using errcode = 'P0001';
  end if;

  if new.prediction_contract is distinct from v_contract then
    raise exception 'CONTRACT_MISMATCH: this match uses a different prediction contract than this prediction'
      using errcode = 'P0001';
  end if;

  if exists (
    select 1 from match_results
    where match_results.match_id = new.match_id
      and match_results.finalized_at is not null
  ) then
    raise exception 'RESULT_ALREADY_FINALIZED: this match already has a finalized result, so predictions can no longer be created or edited'
      using errcode = 'P0001';
  end if;

  if new.prediction_contract = 'PROGRESSIVE_LADDER_V1' then
    perform 1 from venue_activations
    where venue_activations.venue_activation_id = new.venue_activation_id
    for share;

    v_max_level := progressive_offer_max_level(new.venue_activation_id);
    if v_max_level = 0 then
      raise exception 'OFFER_NOT_AVAILABLE: this venue has no valid prize offer for this match, so it cannot take new predictions'
        using errcode = 'P0001';
    end if;

    v_attempted := 1
      + (new.first_team_state <> 'NOT_ATTEMPTED')::int
      + (new.goalscorer_state <> 'NOT_ATTEMPTED')::int
      + (new.goal_minute_state <> 'NOT_ATTEMPTED')::int;
    if v_attempted > v_max_level then
      raise exception 'LEVEL_NOT_OFFERED: that level is not offered at this venue'
        using errcode = 'P0001';
    end if;

    v_digest := progressive_offer_digest(new.venue_activation_id);
    if new.accepted_offer_digest is distinct from v_digest
       or new.accepted_offer_max_level is distinct from v_max_level then
      raise exception 'OFFER_CHANGED: the prizes offered at this venue changed since the offer was accepted'
        using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

create trigger predictions_guard
  before insert or update on predictions
  for each row execute function predictions_guard();

-- ---------------------------------------------------------------------
-- prize_tiers guard: the key matches the contract; the offer freezes
-- ---------------------------------------------------------------------

create function prize_tiers_offer_guard()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_activation uuid;
  v_match uuid;
  v_contract text;
begin
  for v_activation in
    select distinct activation_id
    from (
      select case when tg_op <> 'INSERT' then old.venue_activation_id end as activation_id
      union all
      select case when tg_op <> 'DELETE' then new.venue_activation_id end
    ) touched
    where activation_id is not null
  loop
    select venue_activations.match_id into v_match
    from venue_activations
    where venue_activations.venue_activation_id = v_activation;

    if v_match is null then
      continue; -- no such activation: the foreign key refuses the row
    end if;

    -- Match first, then the activation: the same order the prediction
    -- guard and the settlement functions use. A no-key-update lock on the
    -- activation conflicts with the share lock a progressive prediction
    -- takes, and not with the key-share locks plain foreign-key checks take.
    select matches.prediction_contract into v_contract
    from matches
    where matches.match_id = v_match
    for share;

    if v_contract = 'PROGRESSIVE_LADDER_V1' then
      perform 1 from venue_activations
      where venue_activations.venue_activation_id = v_activation
      for no key update;

      if tg_op <> 'DELETE' and new.ladder_level is null then
        raise exception 'TIER_KEY_CONTRACT_MISMATCH: a prize tier of a progressive match must be keyed by a ladder level'
          using errcode = 'P0001';
      end if;

      if exists (select 1 from predictions where predictions.venue_activation_id = v_activation) then
        raise exception 'OFFER_FROZEN: participants have already accepted this venue''s offer, so its prizes can no longer change'
          using errcode = 'P0001';
      end if;
    elsif tg_op <> 'DELETE' and new.correct_dimension_count is null then
      raise exception 'TIER_KEY_CONTRACT_MISMATCH: a prize tier of this match must be keyed by a correct-dimension count'
        using errcode = 'P0001';
    end if;
  end loop;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger prize_tiers_offer_guard
  before insert or update or delete on prize_tiers
  for each row execute function prize_tiers_offer_guard();

-- ---------------------------------------------------------------------
-- evaluations: contract, attempted level, won level, nullable outcomes
-- ---------------------------------------------------------------------

alter table evaluations
  alter column goalscorer_correct drop not null,
  alter column goal_minute_correct drop not null,
  alter column first_team_to_score_correct drop not null;

alter table evaluations
  add column prediction_contract text not null default 'COMPLETE_COUNT_V1',
  add column attempted_level smallint null,
  add column ladder_level smallint null;

alter table evaluations
  add constraint evaluations_contract_known
  check (prediction_contract in ('COMPLETE_COUNT_V1', 'PROGRESSIVE_LADDER_V1'));

-- Historical: all four outcomes are booleans, no levels. Progressive: the
-- outcome of a category is null exactly when it was not attempted, the won
-- level never exceeds the attempted level and equals the consecutive
-- correct prefix computed from this same row, and the count is the number
-- of true outcomes. The database therefore refuses a won level of 3 or 4
-- for a prediction that attempted two categories, whatever the function did.
alter table evaluations
  add constraint evaluations_contract_shape
  check (
    (
      prediction_contract = 'COMPLETE_COUNT_V1'
      and attempted_level is null
      and ladder_level is null
      and goalscorer_correct is not null
      and goal_minute_correct is not null
      and first_team_to_score_correct is not null
    )
    or
    (
      prediction_contract = 'PROGRESSIVE_LADDER_V1'
      and attempted_level is not null
      and attempted_level between 1 and 4
      and ladder_level is not null
      and ladder_level between 0 and 4
      and ladder_level <= attempted_level
      and ((first_team_to_score_correct is null) = (attempted_level < 2))
      and ((goalscorer_correct is null) = (attempted_level < 3))
      and ((goal_minute_correct is null) = (attempted_level < 4))
      and ladder_level = prediction_prize_ladder_level(
            scoreline_correct, first_team_to_score_correct, goalscorer_correct, goal_minute_correct)
      and correct_dimension_count = (
            scoreline_correct::int
            + coalesce(first_team_to_score_correct::int, 0)
            + coalesce(goalscorer_correct::int, 0)
            + coalesce(goal_minute_correct::int, 0))
    )
  );

-- ---------------------------------------------------------------------
-- upsert_progressive_prediction_atomically
-- ---------------------------------------------------------------------

create function upsert_progressive_prediction_atomically(
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

-- ---------------------------------------------------------------------
-- upsert_prediction_atomically: the historical write path refuses a
-- progressive Match, to create or to edit
-- ---------------------------------------------------------------------
-- Replaced in place with "create or replace": same signature, same return
-- shape, so the ACL it already has (service_role only, migration
-- 20261021120000) is kept and is asserted again below. The body is the
-- body of migration 0096 with the one first check marked in it.

create or replace function upsert_prediction_atomically(
  p_match_id uuid,
  p_gaming_member_id uuid,
  p_venue_activation_id uuid,
  p_predicted_home_score integer,
  p_predicted_away_score integer,
  p_predicted_goalscorer_player_id uuid,
  p_predicted_goal_minute_regulation integer,
  p_predicted_goal_minute_stoppage integer,
  p_predicted_first_team_to_score text,
  p_geo_verified_at timestamptz,
  p_measured_distance_meters numeric,
  p_reported_accuracy_meters numeric,
  p_geo_eligible boolean
)
returns table (
  prediction_id uuid,
  match_id uuid,
  gaming_member_id uuid,
  venue_activation_id uuid,
  predicted_home_score integer,
  predicted_away_score integer,
  predicted_goalscorer_player_id uuid,
  predicted_goal_minute_regulation integer,
  predicted_goal_minute_stoppage integer,
  predicted_first_team_to_score text,
  geo_verified_at timestamptz,
  measured_distance_meters numeric,
  reported_accuracy_meters numeric,
  geo_eligible boolean,
  created_at timestamptz,
  updated_at timestamptz
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_kickoff_at timestamptz;
  v_cancelled_at timestamptz;
  v_activity_classification text;
  v_contract text;
  v_home_team_id uuid;
  v_away_team_id uuid;
  v_activation_match_id uuid;
  v_activation_enabled boolean;
  v_existing_id uuid;
  v_existing_venue_activation_id uuid;
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

  -- The one change from 0096: this function writes the historical contract
  -- only. A progressive Match is refused for a call that would create a
  -- prediction and for one that would edit an existing one alike (the
  -- predictions guard alone refused only the first).
  if v_contract <> 'COMPLETE_COUNT_V1' then
    raise exception 'CONTRACT_MISMATCH: this match uses a different prediction contract than this function writes'
      using errcode = 'P0001';
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

  select venue_activations.match_id, venue_activations.enabled
    into v_activation_match_id, v_activation_enabled
  from venue_activations
  where venue_activations.venue_activation_id = p_venue_activation_id;

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

  if not p_geo_eligible then
    raise exception 'GEO_NOT_ELIGIBLE: submission failed geolocation eligibility'
      using errcode = 'P0001';
  end if;

  if p_predicted_home_score < 0 or p_predicted_away_score < 0 then
    raise exception 'INVALID_SCORE: predicted scores must be non-negative'
      using errcode = 'P0001';
  end if;

  if p_predicted_goal_minute_regulation is not null
     and (p_predicted_goal_minute_regulation < 1 or p_predicted_goal_minute_regulation > 90) then
    raise exception 'INVALID_GOAL_MINUTE: predicted goal minute regulation must be between 1 and 90'
      using errcode = 'P0001';
  end if;

  if p_predicted_goal_minute_stoppage is not null and p_predicted_goal_minute_stoppage <= 0 then
    raise exception 'INVALID_GOAL_MINUTE: predicted goal minute stoppage must be a positive integer'
      using errcode = 'P0001';
  end if;

  if p_predicted_goal_minute_stoppage is not null
     and (p_predicted_goal_minute_regulation is null or p_predicted_goal_minute_regulation not in (45, 90)) then
    raise exception 'INVALID_GOAL_MINUTE: predicted goal minute stoppage requires a regulation minute of 45 or 90'
      using errcode = 'P0001';
  end if;

  if p_predicted_first_team_to_score is not null and p_predicted_first_team_to_score not in ('HOME', 'AWAY') then
    raise exception 'INVALID_FIRST_TEAM: predicted first team to score must be HOME, AWAY, or null'
      using errcode = 'P0001';
  end if;

  if p_predicted_goalscorer_player_id is not null then
    select players.team_id, players.active into v_goalscorer_team_id, v_goalscorer_active
    from players
    where players.player_id = p_predicted_goalscorer_player_id;

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
      geo_verified_at, measured_distance_meters, reported_accuracy_meters, geo_eligible
    )
    values (
      p_match_id, p_gaming_member_id, p_venue_activation_id,
      p_predicted_home_score, p_predicted_away_score,
      p_predicted_goalscorer_player_id, p_predicted_goal_minute_regulation, p_predicted_goal_minute_stoppage,
      p_predicted_first_team_to_score,
      p_geo_verified_at, p_measured_distance_meters, p_reported_accuracy_meters, p_geo_eligible
    )
    returning predictions.prediction_id into v_existing_id;
  else
    update predictions set
      predicted_home_score = p_predicted_home_score,
      predicted_away_score = p_predicted_away_score,
      predicted_goalscorer_player_id = p_predicted_goalscorer_player_id,
      predicted_goal_minute_regulation = p_predicted_goal_minute_regulation,
      predicted_goal_minute_stoppage = p_predicted_goal_minute_stoppage,
      predicted_first_team_to_score = p_predicted_first_team_to_score,
      geo_verified_at = p_geo_verified_at,
      measured_distance_meters = p_measured_distance_meters,
      reported_accuracy_meters = p_reported_accuracy_meters,
      geo_eligible = p_geo_eligible,
      updated_at = now()
    where predictions.prediction_id = v_existing_id;
  end if;

  return query
    select predictions.prediction_id, predictions.match_id, predictions.gaming_member_id,
           predictions.venue_activation_id, predictions.predicted_home_score, predictions.predicted_away_score,
           predictions.predicted_goalscorer_player_id, predictions.predicted_goal_minute_regulation,
           predictions.predicted_goal_minute_stoppage,
           predictions.predicted_first_team_to_score, predictions.geo_verified_at,
           predictions.measured_distance_meters, predictions.reported_accuracy_meters, predictions.geo_eligible,
           predictions.created_at, predictions.updated_at
    from predictions
    where predictions.prediction_id = v_existing_id;
end;
$$;

-- ---------------------------------------------------------------------
-- Privileges: every new function is server-only
-- ---------------------------------------------------------------------

revoke execute on function matches_contract_freeze() from public, anon, authenticated;
revoke execute on function progressive_offer_max_level(uuid) from public, anon, authenticated;
revoke execute on function progressive_offer_digest(uuid) from public, anon, authenticated;
revoke execute on function prediction_prize_ladder_level(boolean, boolean, boolean, boolean) from public, anon, authenticated;
revoke execute on function predictions_guard() from public, anon, authenticated;
revoke execute on function prize_tiers_offer_guard() from public, anon, authenticated;
revoke execute on function upsert_progressive_prediction_atomically(uuid, uuid, uuid, integer, integer, integer, text, text, text, uuid, text, integer, integer, text, timestamptz, numeric, numeric, boolean) from public, anon, authenticated;
revoke execute on function upsert_prediction_atomically(uuid, uuid, uuid, integer, integer, uuid, integer, integer, text, timestamptz, numeric, numeric, boolean) from public, anon, authenticated;

grant execute on function progressive_offer_max_level(uuid) to service_role;
grant execute on function progressive_offer_digest(uuid) to service_role;
grant execute on function prediction_prize_ladder_level(boolean, boolean, boolean, boolean) to service_role;
grant execute on function upsert_progressive_prediction_atomically(uuid, uuid, uuid, integer, integer, integer, text, text, text, uuid, text, integer, integer, text, timestamptz, numeric, numeric, boolean) to service_role;
grant execute on function upsert_prediction_atomically(uuid, uuid, uuid, integer, integer, uuid, integer, integer, text, timestamptz, numeric, numeric, boolean) to service_role;

-- Fail the migration if any new function is reachable by a browser role or
-- is missing for the server role.
do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as signature, p.proname
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in (
        'matches_contract_freeze',
        'progressive_offer_max_level',
        'progressive_offer_digest',
        'prediction_prize_ladder_level',
        'predictions_guard',
        'prize_tiers_offer_guard',
        'upsert_progressive_prediction_atomically',
        'upsert_prediction_atomically'
      )
  loop
    if has_function_privilege('anon', r.signature, 'execute')
       or has_function_privilege('authenticated', r.signature, 'execute') then
      raise exception 'FUNCTION_NOT_SERVER_ONLY: % is reachable by a browser role', r.signature;
    end if;
    if r.proname in ('progressive_offer_max_level', 'progressive_offer_digest',
                     'prediction_prize_ladder_level', 'upsert_progressive_prediction_atomically',
                     'upsert_prediction_atomically')
       and not has_function_privilege('service_role', r.signature, 'execute') then
      raise exception 'FUNCTION_MISSING_SERVER_GRANT: % is not executable by service_role', r.signature;
    end if;
  end loop;
end;
$$;
