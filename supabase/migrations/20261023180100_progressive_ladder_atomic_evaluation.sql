-- URBANO Score — progressive predictions and the prize ladder:
-- settlement. Append-only; replaces the bodies of the two settlement
-- functions in place (same signatures, same return shapes) so that:
--
--   * a prediction of a COMPLETE_COUNT_V1 Match is evaluated, matched to a
--     prize tier and corrected EXACTLY as before (the historical branch below
--     is the previous body, unchanged);
--
--   * a prediction of a PROGRESSIVE_LADDER_V1 Match is evaluated by explicit
--     category state: NOT_ATTEMPTED has no outcome (null, never "correct"),
--     NONE is correct exactly when the official record has no regulation-time
--     goals, PICKED is compared. The evaluation records the attempted level,
--     and the WON level (the consecutive correct prefix, at most the attempted
--     level). The prize is the tier of the won level: level 0, or a level
--     without a tier, has no prize, and there is never a descent to another
--     level's prize. Because an activation can only be attempted up to a
--     consecutive offered prefix (see the previous migration), every level a
--     prediction can win has a tier.
--
-- Unchanged on purpose: the single qualification per evaluation, the lineage
-- uniqueness, the supersession of the old entitlement, the delivered /
-- fulfilled / held / released policy and its decision (only the wording of a
-- hold reason says "level N of 4" instead of "N of 4 correct" for a
-- progressive Match), the audit events, the Metagame and XP calls, and every
-- other function and trigger. correct_dimension_count keeps meaning "the
-- number of correct dimensions" and is never used as a ladder level.

create or replace function finalize_match_result_atomically(
  p_match_result_id uuid,
  p_finalized_by_gaming_member_id uuid,
  p_reason text default null,
  p_expected_digest text default null
)
returns table (
  match_result_id uuid,
  match_id uuid,
  finalized_at timestamptz,
  already_finalized boolean
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_match_id uuid;
  v_home_team_id uuid;
  v_away_team_id uuid;
  v_home_score integer;
  v_away_score integer;
  v_supersedes_id uuid;
  v_activity_classification text;
  v_xp_eligible boolean;
  v_cancelled_at timestamptz;
  v_existing_finalized_at timestamptz;
  v_new_finalized_at timestamptz;
  v_has_authority boolean;
  r_prediction record;
  v_official_goal_count integer;
  v_first_scorer_player_id uuid;
  v_first_is_own_goal boolean;
  v_first_scorer_team_id uuid;
  v_official_first_team text;
  v_scoreline_correct boolean;
  v_goalscorer_correct boolean;
  v_goal_minute_correct boolean;
  v_first_team_correct boolean;
  v_attempted_level smallint;
  v_ladder_level smallint;
  v_dimension_count integer;
  v_dimension_keys text[];
  v_evaluation_id uuid;
  v_tier_id uuid;
  v_performance_band_key text;
  v_experience_summary_id uuid;
  v_lineage integer;
begin
  select match_results.match_id into v_match_id
  from match_results
  where match_results.match_result_id = p_match_result_id;

  if v_match_id is null then
    raise exception 'MATCH_RESULT_NOT_FOUND: no draft result exists for this id'
      using errcode = 'P0001';
  end if;

  -- Match lock first (shared lock order with save and correct), then the
  -- result row; every fact below is read AFTER both are held.
  perform 1 from matches where matches.match_id = v_match_id for no key update;

  select match_results.home_score, match_results.away_score,
         match_results.finalized_at, match_results.supersedes_match_result_id
    into v_home_score, v_away_score, v_existing_finalized_at, v_supersedes_id
  from match_results
  where match_results.match_result_id = p_match_result_id
  for update;

  if not found then
    raise exception 'MATCH_RESULT_NOT_FOUND: no draft result exists for this id'
      using errcode = 'P0001';
  end if;

  select exists(
    select 1 from authority_grants
    where authority_grants.gaming_member_id = p_finalized_by_gaming_member_id
      and authority_grants.authority_class = 'CONSEQUENTIAL_FINALIZER'
      and authority_grants.revoked_at is null
  ) into v_has_authority;

  if not v_has_authority then
    raise exception 'CONSEQUENTIAL_FINALIZER_AUTHORITY_REQUIRED: this action requires Consequential Finalizer authority'
      using errcode = 'P0001';
  end if;

  if p_expected_digest is null or length(btrim(p_expected_digest)) = 0 then
    raise exception 'MATCH_RESULT_DIGEST_REQUIRED: the digest of the reviewed result content is required'
      using errcode = 'P0001';
  end if;

  if v_supersedes_id is not null then
    raise exception 'MATCH_RESULT_IS_CORRECTION: this result supersedes a prior finalized result and must be finalized as a correction'
      using errcode = 'P0001';
  end if;

  -- An already-finalized result is an idempotent replay only for the
  -- exact content that was finalized.
  if v_existing_finalized_at is not null then
    if p_expected_digest <> match_result_content_digest(p_match_result_id) then
      raise exception 'MATCH_RESULT_DIGEST_MISMATCH: the reviewed content is not the content of this result'
        using errcode = 'P0001';
    end if;
    return query select p_match_result_id, v_match_id, v_existing_finalized_at, true;
    return;
  end if;

  select matches.cancelled_at into v_cancelled_at
  from matches
  where matches.match_id = v_match_id;

  if v_cancelled_at is not null then
    raise exception 'MATCH_CANCELLED: this match has been cancelled'
      using errcode = 'P0001';
  end if;

  if p_expected_digest <> match_result_content_digest(p_match_result_id) then
    raise exception 'MATCH_RESULT_DIGEST_MISMATCH: the draft changed since it was reviewed; reload and review it again'
      using errcode = 'P0001';
  end if;

  perform assert_match_result_integrity(p_match_result_id);

  v_new_finalized_at := now();

  update match_results
     set finalized_at = v_new_finalized_at,
         finalized_by_gaming_member_id = p_finalized_by_gaming_member_id
   where match_results.match_result_id = p_match_result_id;

  insert into admin_audit_events (
    action_type, actor_kind, actor_id, authority_class_used,
    target_type, target_id, occurred_at, resulting_reference, outcome, reason
  )
  values (
    'FINALIZE_RESULT', 'GAMING_MEMBER', p_finalized_by_gaming_member_id, 'CONSEQUENTIAL_FINALIZER',
    'match_results', p_match_result_id, v_new_finalized_at,
    jsonb_build_object('table', 'match_results', 'id', p_match_result_id),
    'SUCCESS', p_reason
  );

  select matches.home_team_id, matches.away_team_id, matches.activity_classification, matches.xp_eligible
    into v_home_team_id, v_away_team_id, v_activity_classification, v_xp_eligible
  from matches
  where matches.match_id = v_match_id;

  select count(*) into v_official_goal_count
  from official_goal_events
  where official_goal_events.match_result_id = p_match_result_id
    and official_goal_events.minute_regulation between 1 and 90;

  -- Chronological order is (minute, stoppage, ordinal). The previous key
  -- minute + stoppage tied first-half stoppage 45+10 with ordinary
  -- minute 55 and let a later goal be treated as the first.
  select official_goal_events.scorer_player_id, official_goal_events.is_own_goal
    into v_first_scorer_player_id, v_first_is_own_goal
  from official_goal_events
  where official_goal_events.match_result_id = p_match_result_id
    and official_goal_events.minute_regulation between 1 and 90
  order by official_goal_events.minute_regulation asc,
           coalesce(official_goal_events.minute_stoppage, 0) asc,
           official_goal_events.ordinal asc
  limit 1;

  if v_first_scorer_player_id is null then
    v_official_first_team := 'NO_GOAL';
  else
    select players.team_id into v_first_scorer_team_id
    from players
    where players.player_id = v_first_scorer_player_id;

    if v_first_is_own_goal then
      v_official_first_team := case when v_first_scorer_team_id = v_home_team_id then 'AWAY' else 'HOME' end;
    else
      v_official_first_team := case when v_first_scorer_team_id = v_home_team_id then 'HOME' else 'AWAY' end;
    end if;
  end if;

  -- Position of this result in the explicit supersession chain (0 for a first result).
  v_lineage := match_result_lineage_ordinal(p_match_result_id);

  for r_prediction in
    select predictions.prediction_id, predictions.gaming_member_id, predictions.venue_activation_id,
           predictions.predicted_home_score, predictions.predicted_away_score,
           predictions.predicted_goalscorer_player_id,
           predictions.predicted_goal_minute_regulation, predictions.predicted_goal_minute_stoppage,
           predictions.predicted_first_team_to_score, predictions.created_at,
           predictions.prediction_contract, predictions.first_team_state,
           predictions.goalscorer_state, predictions.goal_minute_state,
           predictions.attempted_level
    from predictions
    where predictions.match_id = v_match_id
  loop
    v_scoreline_correct := (r_prediction.predicted_home_score = v_home_score and r_prediction.predicted_away_score = v_away_score);

    if r_prediction.prediction_contract = 'PROGRESSIVE_LADDER_V1' then
      -- Explicit state per category. NOT_ATTEMPTED has no outcome (null)
      -- and stops the ladder; NONE is an answer, correct exactly when the
      -- official record has no regulation-time goals; PICKED is compared.
      -- The state is read, never a null in a value column.
      if r_prediction.first_team_state = 'NOT_ATTEMPTED' then
        v_first_team_correct := null;
      elsif r_prediction.first_team_state = 'NONE' then
        v_first_team_correct := (v_official_first_team = 'NO_GOAL');
      else
        v_first_team_correct := (r_prediction.predicted_first_team_to_score = v_official_first_team);
      end if;

      if r_prediction.goalscorer_state = 'NOT_ATTEMPTED' then
        v_goalscorer_correct := null;
      elsif r_prediction.goalscorer_state = 'NONE' then
        v_goalscorer_correct := (v_official_goal_count = 0);
      else
        v_goalscorer_correct := exists (
          select 1 from official_goal_events
          where official_goal_events.match_result_id = p_match_result_id
            and official_goal_events.minute_regulation between 1 and 90
            and official_goal_events.scorer_player_id = r_prediction.predicted_goalscorer_player_id
            and not official_goal_events.is_own_goal
        );
      end if;

      if r_prediction.goal_minute_state = 'NOT_ATTEMPTED' then
        v_goal_minute_correct := null;
      elsif r_prediction.goal_minute_state = 'NONE' then
        v_goal_minute_correct := (v_official_goal_count = 0);
      else
        v_goal_minute_correct := exists (
          select 1 from official_goal_events
          where official_goal_events.match_result_id = p_match_result_id
            and official_goal_events.minute_regulation between 1 and 90
            and official_goal_events.minute_regulation = r_prediction.predicted_goal_minute_regulation
            and official_goal_events.minute_stoppage is not distinct from r_prediction.predicted_goal_minute_stoppage
        );
      end if;

      v_attempted_level := r_prediction.attempted_level;
      v_ladder_level := prediction_prize_ladder_level(
        v_scoreline_correct, v_first_team_correct, v_goalscorer_correct, v_goal_minute_correct);
    else
      if r_prediction.predicted_goalscorer_player_id is null then
        v_goalscorer_correct := (v_official_goal_count = 0);
      else
        v_goalscorer_correct := exists (
          select 1 from official_goal_events
          where official_goal_events.match_result_id = p_match_result_id
            and official_goal_events.minute_regulation between 1 and 90
            and official_goal_events.scorer_player_id = r_prediction.predicted_goalscorer_player_id
            and not official_goal_events.is_own_goal
        );
      end if;

      if r_prediction.predicted_goal_minute_regulation is null then
        v_goal_minute_correct := (v_official_goal_count = 0);
      else
        v_goal_minute_correct := exists (
          select 1 from official_goal_events
          where official_goal_events.match_result_id = p_match_result_id
            and official_goal_events.minute_regulation between 1 and 90
            and official_goal_events.minute_regulation = r_prediction.predicted_goal_minute_regulation
            and official_goal_events.minute_stoppage is not distinct from r_prediction.predicted_goal_minute_stoppage
        );
      end if;

      if r_prediction.predicted_first_team_to_score is null then
        v_first_team_correct := (v_official_first_team = 'NO_GOAL');
      else
        v_first_team_correct := (r_prediction.predicted_first_team_to_score = v_official_first_team);
      end if;


      v_attempted_level := null;
      v_ladder_level := null;
    end if;

    v_dimension_count := (
      v_scoreline_correct::int
      + coalesce(v_goalscorer_correct::int, 0)
      + coalesce(v_goal_minute_correct::int, 0)
      + coalesce(v_first_team_correct::int, 0)
    );

    v_dimension_keys := array[]::text[];
    if v_scoreline_correct then v_dimension_keys := array_append(v_dimension_keys, 'EXACT_SCORELINE'); end if;
    if v_goalscorer_correct then v_dimension_keys := array_append(v_dimension_keys, 'ANY_GOALSCORER'); end if;
    if v_goal_minute_correct then v_dimension_keys := array_append(v_dimension_keys, 'ANY_GOAL_MINUTE'); end if;
    if v_first_team_correct then v_dimension_keys := array_append(v_dimension_keys, 'FIRST_TEAM_TO_SCORE'); end if;

    insert into evaluations (
      prediction_id, match_result_id, scoreline_correct, goalscorer_correct,
      goal_minute_correct, first_team_to_score_correct, correct_dimension_count,
      prediction_contract, attempted_level, ladder_level
    )
    values (
      r_prediction.prediction_id, p_match_result_id, v_scoreline_correct, v_goalscorer_correct,
      v_goal_minute_correct, v_first_team_correct, v_dimension_count,
      r_prediction.prediction_contract, v_attempted_level, v_ladder_level
    )
    returning evaluations.evaluation_id into v_evaluation_id;

    v_performance_band_key := 'CORRECT_' || v_dimension_count || '_OF_4';

    select record_experience_summary_atomically.experience_summary_id into v_experience_summary_id
    from record_experience_summary_atomically(
      r_prediction.gaming_member_id,
      'SOCCER_PREDICTIONS',
      'SOCCER_PREDICTIONS',
      v_activity_classification,
      'ADMIN_FINALIZED',
      r_prediction.created_at,
      v_new_finalized_at,
      true,
      v_performance_band_key,
      v_evaluation_id::text,
      'predictions-v2',
      null,
      v_evaluation_id::text,
      jsonb_build_object(
        'correctDimensionCount', v_dimension_count,
        'scorelineCorrect', v_scoreline_correct,
        'goalscorerCorrect', v_goalscorer_correct,
        'goalMinuteCorrect', v_goal_minute_correct,
        'firstTeamCorrect', v_first_team_correct
      ),
      v_dimension_count,
      v_dimension_keys,
      coalesce(v_xp_eligible, false)
    );

    perform 1 from process_experience_summary_consequences_atomically(v_experience_summary_id);

    -- COMPLETE_COUNT_V1: equality on the number of correct dimensions.
    -- PROGRESSIVE_LADDER_V1: the tier of the WON level; level 0 has no tier
    -- and a level without a tier has no prize. Never a descent to another
    -- level's prize.
    v_tier_id := null;
    if r_prediction.prediction_contract = 'PROGRESSIVE_LADDER_V1' then
      if v_ladder_level >= 1 then
        select prize_tiers.prize_tier_id into v_tier_id
        from prize_tiers
        where prize_tiers.venue_activation_id = r_prediction.venue_activation_id
          and prize_tiers.ladder_level = v_ladder_level;
      end if;
    else
      select prize_tiers.prize_tier_id into v_tier_id
      from prize_tiers
      where prize_tiers.venue_activation_id = r_prediction.venue_activation_id
        and prize_tiers.correct_dimension_count = v_dimension_count;
    end if;

    if v_tier_id is not null then
      insert into prize_qualifications (
        evaluation_id, gaming_member_id, venue_activation_id, prize_tier_id, lineage_ordinal
      )
      values (
        v_evaluation_id, r_prediction.gaming_member_id, r_prediction.venue_activation_id, v_tier_id, v_lineage
      );
    end if;
  end loop;

  return query select p_match_result_id, v_match_id, v_new_finalized_at, false;
end;
$$;

create or replace function correct_match_result_atomically(
  p_match_result_id uuid,
  p_finalized_by_gaming_member_id uuid,
  p_reason text,
  p_expected_digest text default null
)
returns table (
  match_result_id uuid,
  match_id uuid,
  finalized_at timestamptz,
  supersedes_match_result_id uuid,
  already_finalized boolean
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_match_id uuid;
  v_home_team_id uuid;
  v_away_team_id uuid;
  v_home_score integer;
  v_away_score integer;
  v_activity_classification text;
  v_xp_eligible boolean;
  v_cancelled_at timestamptz;
  v_existing_finalized_at timestamptz;
  v_new_finalized_at timestamptz;
  v_supersedes_id uuid;
  v_supersedes_finalized_at timestamptz;
  v_has_authority boolean;
  r_prediction record;
  v_official_goal_count integer;
  v_first_scorer_player_id uuid;
  v_first_is_own_goal boolean;
  v_first_scorer_team_id uuid;
  v_official_first_team text;
  v_scoreline_correct boolean;
  v_goalscorer_correct boolean;
  v_goal_minute_correct boolean;
  v_first_team_correct boolean;
  v_attempted_level smallint;
  v_ladder_level smallint;
  v_dimension_count integer;
  v_dimension_keys text[];
  v_new_evaluation_id uuid;
  v_old_evaluation_id uuid;
  v_old_prize_qualification_id uuid;
  v_new_tier_id uuid;
  v_new_tier_label text;
  v_last_redeemed_id uuid;
  v_last_redeemed_tier_id uuid;
  v_last_redeemed_label text;
  v_last_redeemed_basis text;
  v_last_redeemed_observed text;
  v_last_redeemed_ordinal integer;
  v_last_redeemed_dimension_count integer;
  v_new_key_text text;
  v_last_key_text text;
  v_redeemed_count integer;
  v_unordered_redeemed integer;
  v_lineage integer;
  v_hold_basis text;
  v_hold_text text;
  v_performance_band_key text;
  v_old_experience_summary_id uuid;
  v_new_experience_summary_id uuid;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'REASON_REQUIRED: correction requires a reason'
      using errcode = 'P0001';
  end if;

  select match_results.match_id into v_match_id
  from match_results
  where match_results.match_result_id = p_match_result_id;

  if v_match_id is null then
    raise exception 'MATCH_RESULT_NOT_FOUND: no correction draft exists for this id'
      using errcode = 'P0001';
  end if;

  perform 1 from matches where matches.match_id = v_match_id for no key update;

  select match_results.home_score, match_results.away_score,
         match_results.finalized_at, match_results.supersedes_match_result_id
    into v_home_score, v_away_score, v_existing_finalized_at, v_supersedes_id
  from match_results
  where match_results.match_result_id = p_match_result_id
  for update;

  if not found then
    raise exception 'MATCH_RESULT_NOT_FOUND: no correction draft exists for this id'
      using errcode = 'P0001';
  end if;

  if v_supersedes_id is null then
    raise exception 'NOT_A_CORRECTION: this result does not supersede a prior finalized result'
      using errcode = 'P0001';
  end if;

  select exists(
    select 1 from authority_grants
    where authority_grants.gaming_member_id = p_finalized_by_gaming_member_id
      and authority_grants.authority_class = 'CONSEQUENTIAL_FINALIZER'
      and authority_grants.revoked_at is null
  ) into v_has_authority;

  if not v_has_authority then
    raise exception 'CONSEQUENTIAL_FINALIZER_AUTHORITY_REQUIRED: this action requires Consequential Finalizer authority'
      using errcode = 'P0001';
  end if;

  if p_expected_digest is null or length(btrim(p_expected_digest)) = 0 then
    raise exception 'MATCH_RESULT_DIGEST_REQUIRED: the digest of the reviewed result content is required'
      using errcode = 'P0001';
  end if;

  if v_existing_finalized_at is not null then
    if p_expected_digest <> match_result_content_digest(p_match_result_id) then
      raise exception 'MATCH_RESULT_DIGEST_MISMATCH: the reviewed content is not the content of this result'
        using errcode = 'P0001';
    end if;
    return query select p_match_result_id, v_match_id, v_existing_finalized_at, v_supersedes_id, true;
    return;
  end if;

  select matches.cancelled_at into v_cancelled_at
  from matches
  where matches.match_id = v_match_id;

  if v_cancelled_at is not null then
    raise exception 'MATCH_CANCELLED: this match has been cancelled'
      using errcode = 'P0001';
  end if;

  select match_results.finalized_at into v_supersedes_finalized_at
  from match_results
  where match_results.match_result_id = v_supersedes_id
  for update;

  if v_supersedes_finalized_at is null then
    raise exception 'SUPERSEDED_RESULT_NOT_FINALIZED: the result being corrected is not itself finalized'
      using errcode = 'P0001';
  end if;

  if p_expected_digest <> match_result_content_digest(p_match_result_id) then
    raise exception 'MATCH_RESULT_DIGEST_MISMATCH: the draft changed since it was reviewed; reload and review it again'
      using errcode = 'P0001';
  end if;

  perform assert_match_result_integrity(p_match_result_id);

  -- Lock every entitlement of the result being superseded BEFORE deciding
  -- anything about delivery. A redemption or a hold release racing this
  -- correction either committed first (and is seen below) or waits and
  -- then finds the row superseded. No lock ORDER is imposed on these rows
  -- (no ordering by identifier or time): this is the only function that
  -- takes several entitlement locks, it does so while holding the match
  -- lock that serializes every settlement operation, and redeem and
  -- release take exactly one entitlement lock and wait on nothing else —
  -- so no wait cycle can form.
  perform 1
  from prize_qualifications
  join evaluations on evaluations.evaluation_id = prize_qualifications.evaluation_id
  where evaluations.match_result_id = v_supersedes_id
  for update of prize_qualifications;

  v_new_finalized_at := now();

  update match_results
     set finalized_at = v_new_finalized_at,
         finalized_by_gaming_member_id = p_finalized_by_gaming_member_id
   where match_results.match_result_id = p_match_result_id;

  insert into admin_audit_events (
    action_type, actor_kind, actor_id, authority_class_used,
    target_type, target_id, occurred_at, previous_reference, resulting_reference, outcome, reason
  )
  values (
    'CORRECT_RESULT', 'GAMING_MEMBER', p_finalized_by_gaming_member_id, 'CONSEQUENTIAL_FINALIZER',
    'match_results', p_match_result_id, v_new_finalized_at,
    jsonb_build_object('table', 'match_results', 'id', v_supersedes_id),
    jsonb_build_object('table', 'match_results', 'id', p_match_result_id),
    'SUCCESS', p_reason
  );

  select matches.home_team_id, matches.away_team_id, matches.activity_classification, matches.xp_eligible
    into v_home_team_id, v_away_team_id, v_activity_classification, v_xp_eligible
  from matches
  where matches.match_id = v_match_id;

  select count(*) into v_official_goal_count
  from official_goal_events
  where official_goal_events.match_result_id = p_match_result_id
    and official_goal_events.minute_regulation between 1 and 90;

  select official_goal_events.scorer_player_id, official_goal_events.is_own_goal
    into v_first_scorer_player_id, v_first_is_own_goal
  from official_goal_events
  where official_goal_events.match_result_id = p_match_result_id
    and official_goal_events.minute_regulation between 1 and 90
  order by official_goal_events.minute_regulation asc,
           coalesce(official_goal_events.minute_stoppage, 0) asc,
           official_goal_events.ordinal asc
  limit 1;

  if v_first_scorer_player_id is null then
    v_official_first_team := 'NO_GOAL';
  else
    select players.team_id into v_first_scorer_team_id
    from players
    where players.player_id = v_first_scorer_player_id;

    if v_first_is_own_goal then
      v_official_first_team := case when v_first_scorer_team_id = v_home_team_id then 'AWAY' else 'HOME' end;
    else
      v_official_first_team := case when v_first_scorer_team_id = v_home_team_id then 'HOME' else 'AWAY' end;
    end if;
  end if;

  -- Position of this correction in the explicit supersession chain.
  v_lineage := match_result_lineage_ordinal(p_match_result_id);

  for r_prediction in
    select predictions.prediction_id, predictions.gaming_member_id, predictions.venue_activation_id,
           predictions.predicted_home_score, predictions.predicted_away_score,
           predictions.predicted_goalscorer_player_id,
           predictions.predicted_goal_minute_regulation, predictions.predicted_goal_minute_stoppage,
           predictions.predicted_first_team_to_score, predictions.created_at,
           predictions.prediction_contract, predictions.first_team_state,
           predictions.goalscorer_state, predictions.goal_minute_state,
           predictions.attempted_level
    from predictions
    where predictions.match_id = v_match_id
  loop
    select evaluations.evaluation_id
      into v_old_evaluation_id
    from evaluations
    where evaluations.prediction_id = r_prediction.prediction_id
      and evaluations.match_result_id = v_supersedes_id;

    v_scoreline_correct := (r_prediction.predicted_home_score = v_home_score and r_prediction.predicted_away_score = v_away_score);

    if r_prediction.prediction_contract = 'PROGRESSIVE_LADDER_V1' then
      -- Explicit state per category. NOT_ATTEMPTED has no outcome (null)
      -- and stops the ladder; NONE is an answer, correct exactly when the
      -- official record has no regulation-time goals; PICKED is compared.
      -- The state is read, never a null in a value column.
      if r_prediction.first_team_state = 'NOT_ATTEMPTED' then
        v_first_team_correct := null;
      elsif r_prediction.first_team_state = 'NONE' then
        v_first_team_correct := (v_official_first_team = 'NO_GOAL');
      else
        v_first_team_correct := (r_prediction.predicted_first_team_to_score = v_official_first_team);
      end if;

      if r_prediction.goalscorer_state = 'NOT_ATTEMPTED' then
        v_goalscorer_correct := null;
      elsif r_prediction.goalscorer_state = 'NONE' then
        v_goalscorer_correct := (v_official_goal_count = 0);
      else
        v_goalscorer_correct := exists (
          select 1 from official_goal_events
          where official_goal_events.match_result_id = p_match_result_id
            and official_goal_events.minute_regulation between 1 and 90
            and official_goal_events.scorer_player_id = r_prediction.predicted_goalscorer_player_id
            and not official_goal_events.is_own_goal
        );
      end if;

      if r_prediction.goal_minute_state = 'NOT_ATTEMPTED' then
        v_goal_minute_correct := null;
      elsif r_prediction.goal_minute_state = 'NONE' then
        v_goal_minute_correct := (v_official_goal_count = 0);
      else
        v_goal_minute_correct := exists (
          select 1 from official_goal_events
          where official_goal_events.match_result_id = p_match_result_id
            and official_goal_events.minute_regulation between 1 and 90
            and official_goal_events.minute_regulation = r_prediction.predicted_goal_minute_regulation
            and official_goal_events.minute_stoppage is not distinct from r_prediction.predicted_goal_minute_stoppage
        );
      end if;

      v_attempted_level := r_prediction.attempted_level;
      v_ladder_level := prediction_prize_ladder_level(
        v_scoreline_correct, v_first_team_correct, v_goalscorer_correct, v_goal_minute_correct);
    else
      if r_prediction.predicted_goalscorer_player_id is null then
        v_goalscorer_correct := (v_official_goal_count = 0);
      else
        v_goalscorer_correct := exists (
          select 1 from official_goal_events
          where official_goal_events.match_result_id = p_match_result_id
            and official_goal_events.minute_regulation between 1 and 90
            and official_goal_events.scorer_player_id = r_prediction.predicted_goalscorer_player_id
            and not official_goal_events.is_own_goal
        );
      end if;

      if r_prediction.predicted_goal_minute_regulation is null then
        v_goal_minute_correct := (v_official_goal_count = 0);
      else
        v_goal_minute_correct := exists (
          select 1 from official_goal_events
          where official_goal_events.match_result_id = p_match_result_id
            and official_goal_events.minute_regulation between 1 and 90
            and official_goal_events.minute_regulation = r_prediction.predicted_goal_minute_regulation
            and official_goal_events.minute_stoppage is not distinct from r_prediction.predicted_goal_minute_stoppage
        );
      end if;

      if r_prediction.predicted_first_team_to_score is null then
        v_first_team_correct := (v_official_first_team = 'NO_GOAL');
      else
        v_first_team_correct := (r_prediction.predicted_first_team_to_score = v_official_first_team);
      end if;


      v_attempted_level := null;
      v_ladder_level := null;
    end if;

    v_dimension_count := (
      v_scoreline_correct::int
      + coalesce(v_goalscorer_correct::int, 0)
      + coalesce(v_goal_minute_correct::int, 0)
      + coalesce(v_first_team_correct::int, 0)
    );

    v_dimension_keys := array[]::text[];
    if v_scoreline_correct then v_dimension_keys := array_append(v_dimension_keys, 'EXACT_SCORELINE'); end if;
    if v_goalscorer_correct then v_dimension_keys := array_append(v_dimension_keys, 'ANY_GOALSCORER'); end if;
    if v_goal_minute_correct then v_dimension_keys := array_append(v_dimension_keys, 'ANY_GOAL_MINUTE'); end if;
    if v_first_team_correct then v_dimension_keys := array_append(v_dimension_keys, 'FIRST_TEAM_TO_SCORE'); end if;

    insert into evaluations (
      prediction_id, match_result_id, scoreline_correct, goalscorer_correct,
      goal_minute_correct, first_team_to_score_correct, correct_dimension_count,
      prediction_contract, attempted_level, ladder_level
    )
    values (
      r_prediction.prediction_id, p_match_result_id, v_scoreline_correct, v_goalscorer_correct,
      v_goal_minute_correct, v_first_team_correct, v_dimension_count,
      r_prediction.prediction_contract, v_attempted_level, v_ladder_level
    )
    returning evaluations.evaluation_id into v_new_evaluation_id;

    v_performance_band_key := 'CORRECT_' || v_dimension_count || '_OF_4';

    v_old_experience_summary_id := null;
    if v_old_evaluation_id is not null then
      select experience_summaries.experience_summary_id into v_old_experience_summary_id
      from experience_summaries
      where experience_summaries.experience_key = 'SOCCER_PREDICTIONS'
        and experience_summaries.idempotency_key = v_old_evaluation_id::text;
    end if;

    select record_experience_summary_atomically.experience_summary_id into v_new_experience_summary_id
    from record_experience_summary_atomically(
      r_prediction.gaming_member_id,
      'SOCCER_PREDICTIONS',
      'SOCCER_PREDICTIONS',
      v_activity_classification,
      'ADMIN_FINALIZED',
      r_prediction.created_at,
      v_new_finalized_at,
      true,
      v_performance_band_key,
      v_new_evaluation_id::text,
      'predictions-v2',
      v_old_experience_summary_id,
      v_new_evaluation_id::text,
      jsonb_build_object(
        'correctDimensionCount', v_dimension_count,
        'scorelineCorrect', v_scoreline_correct,
        'goalscorerCorrect', v_goalscorer_correct,
        'goalMinuteCorrect', v_goal_minute_correct,
        'firstTeamCorrect', v_first_team_correct,
        'correction', true
      ),
      v_dimension_count,
      v_dimension_keys,
      coalesce(v_xp_eligible, false)
    );

    perform 1 from process_experience_summary_consequences_atomically(v_new_experience_summary_id);

    -- Prize policy. The old entitlement is always superseded (history is
    -- kept). What the correction issues in its place depends on what was
    -- PHYSICALLY DELIVERED for this member and activation, never on the
    -- old row alone.
    v_old_prize_qualification_id := null;
    if v_old_evaluation_id is not null then
      select prize_qualifications.prize_qualification_id into v_old_prize_qualification_id
      from prize_qualifications
      where prize_qualifications.evaluation_id = v_old_evaluation_id;

      update prize_qualifications
         set superseded_at = v_new_finalized_at
       where prize_qualifications.evaluation_id = v_old_evaluation_id
         and prize_qualifications.superseded_at is null;
    end if;

    v_new_tier_id := null;
    v_new_tier_label := null;
    if r_prediction.prediction_contract = 'PROGRESSIVE_LADDER_V1' then
      if v_ladder_level >= 1 then
        select prize_tiers.prize_tier_id, prize_tiers.prize_label
          into v_new_tier_id, v_new_tier_label
        from prize_tiers
        where prize_tiers.venue_activation_id = r_prediction.venue_activation_id
          and prize_tiers.ladder_level = v_ladder_level;
      end if;
    else
      select prize_tiers.prize_tier_id, prize_tiers.prize_label
        into v_new_tier_id, v_new_tier_label
      from prize_tiers
      where prize_tiers.venue_activation_id = r_prediction.venue_activation_id
        and prize_tiers.correct_dimension_count = v_dimension_count;
    end if;

    if v_new_tier_id is not null then
      v_last_redeemed_id := null;
      v_last_redeemed_tier_id := null;
      v_last_redeemed_label := null;
      v_last_redeemed_basis := null;
      v_last_redeemed_observed := null;
      v_last_redeemed_ordinal := null;

      select count(*) filter (where prize_qualifications.redeemed_at is not null),
             count(*) filter (where prize_qualifications.redeemed_at is not null
                                and prize_qualifications.lineage_ordinal is null)
        into v_redeemed_count, v_unordered_redeemed
      from prize_qualifications
      where prize_qualifications.gaming_member_id = r_prediction.gaming_member_id
        and prize_qualifications.venue_activation_id = r_prediction.venue_activation_id;

      -- Latest delivery = the redeemed row at the highest LINEAGE position
      -- (its result's place in the explicit supersession chain). Never a
      -- timestamp, never an id: transaction-start times cannot order a
      -- chain, because transactions can begin in one order and take their
      -- locks in another, and one transaction can write many rows with one
      -- timestamp. (member, activation, lineage_ordinal) is unique, so the
      -- latest position is unambiguous when every delivery has one.
      select prize_qualifications.prize_qualification_id,
             prize_qualifications.prize_tier_id,
             prize_qualifications.redeemed_prize_label,
             prize_qualifications.redeemed_prize_label_basis,
             prize_qualifications.legacy_observed_prize_label,
             prize_qualifications.lineage_ordinal
        into v_last_redeemed_id, v_last_redeemed_tier_id, v_last_redeemed_label,
             v_last_redeemed_basis, v_last_redeemed_observed, v_last_redeemed_ordinal
      from prize_qualifications
      where prize_qualifications.gaming_member_id = r_prediction.gaming_member_id
        and prize_qualifications.venue_activation_id = r_prediction.venue_activation_id
        and prize_qualifications.redeemed_at is not null
        and prize_qualifications.lineage_ordinal is not null
      order by prize_qualifications.lineage_ordinal desc
      limit 1;

      v_hold_basis := null;
      v_hold_text := null;
      v_last_redeemed_dimension_count := null;
      if v_last_redeemed_tier_id is not null then
        -- A delivered tier carries exactly one key; the ladder level for a
        -- progressive Match, the correct-dimension count for a historical one.
        select coalesce(prize_tiers.ladder_level, prize_tiers.correct_dimension_count) into v_last_redeemed_dimension_count
        from prize_tiers
        where prize_tiers.prize_tier_id = v_last_redeemed_tier_id;
      end if;

      if r_prediction.prediction_contract = 'PROGRESSIVE_LADDER_V1' then
        v_new_key_text := 'level ' || v_ladder_level || ' of 4';
        v_last_key_text := 'level ' || coalesce(v_last_redeemed_dimension_count::text, '?') || ' of 4';
      else
        v_new_key_text := v_dimension_count || ' of 4 correct';
        v_last_key_text := coalesce(v_last_redeemed_dimension_count::text, '?') || ' of 4 correct';
      end if;

      if v_redeemed_count = 0 then
        -- Nothing delivered yet: replace the unredeemed entitlement.
        insert into prize_qualifications (
          evaluation_id, gaming_member_id, venue_activation_id, prize_tier_id,
          replaces_prize_qualification_id, lineage_ordinal
        )
        values (
          v_new_evaluation_id, r_prediction.gaming_member_id, r_prediction.venue_activation_id, v_new_tier_id,
          v_old_prize_qualification_id, v_lineage
        );
      else
        if v_lineage is null or v_unordered_redeemed > 0 or v_last_redeemed_id is null or v_last_redeemed_ordinal >= v_lineage then
          -- A delivery exists whose place in the chain cannot be
          -- established (or sits at or beyond this correction, or this
          -- correction's own place is unreadable): do not invent an
          -- order. Hold for reconciliation, naming no prior. (The null
          -- test comes first: comparing against a null position would
          -- otherwise read as "not later" instead of "unknown".)
          v_hold_basis := 'DELIVERY_ORDER_UNKNOWN';
          v_last_redeemed_id := null;
          v_hold_text := format(
            'A correction affected a prize for a member who already has a delivery, but the order of this member''s deliveries and replacements could not be established from the records. Now entitled to: "%s" (%s). A Consequential Finalizer must reconcile this with the venue, with a reason, before any further delivery.',
            v_new_tier_label, v_new_key_text
          );
        elsif v_last_redeemed_basis = 'SNAPSHOT_AT_REDEMPTION'
              and v_last_redeemed_tier_id = v_new_tier_id
              and v_last_redeemed_label = v_new_tier_label then
          -- Same prize identity AND the label recorded at delivery equals
          -- today's definition: the original delivery already satisfies it.
          insert into prize_qualifications (
            evaluation_id, gaming_member_id, venue_activation_id, prize_tier_id,
            replaces_prize_qualification_id, fulfilled_by_prize_qualification_id, lineage_ordinal
          )
          values (
            v_new_evaluation_id, r_prediction.gaming_member_id, r_prediction.venue_activation_id, v_new_tier_id,
            v_old_prize_qualification_id, v_last_redeemed_id, v_lineage
          );
        elsif v_last_redeemed_basis = 'SNAPSHOT_AT_REDEMPTION' then
          v_hold_basis := 'DELIVERED_PRIZE_CHANGED';
          v_hold_text := format(
            'A correction changed a prize that was already delivered. Delivered: "%s" (%s). Now entitled to: "%s" (%s). No further delivery is authorized until a Consequential Finalizer releases this hold with a reason.',
            v_last_redeemed_label,
            v_last_key_text,
            v_new_tier_label,
            v_new_key_text
          );
        else
          -- The earlier delivery predates delivery-time label snapshots:
          -- today's definition of that prize is not evidence of what was
          -- handed over, so equivalence is unknown and cannot be inferred.
          v_hold_basis := 'DELIVERY_EQUIVALENCE_UNKNOWN';
          v_hold_text := format(
            'A correction affected a prize that was already delivered, but that delivery was recorded before delivery-time prize labels were kept, so it cannot be shown to be the same prize. The earlier delivery is defined today as "%s" (%s), which may differ from what was handed over; this correction entitles the member to "%s" (%s). A Consequential Finalizer must reconcile this with the venue, with a reason, before any further delivery.',
            coalesce(v_last_redeemed_observed, '(no definition found)'),
            v_last_key_text,
            v_new_tier_label,
            v_new_key_text
          );
        end if;

        if v_hold_basis is not null then
          insert into prize_qualifications (
            evaluation_id, gaming_member_id, venue_activation_id, prize_tier_id,
            replaces_prize_qualification_id, lineage_ordinal,
            hold_prior_prize_qualification_id, held_at, hold_basis, hold_reason
          )
          values (
            v_new_evaluation_id, r_prediction.gaming_member_id, r_prediction.venue_activation_id, v_new_tier_id,
            v_old_prize_qualification_id, v_lineage,
            v_last_redeemed_id, v_new_finalized_at, v_hold_basis, v_hold_text
          );
        end if;
      end if;
    end if;
  end loop;

  return query select p_match_result_id, v_match_id, v_new_finalized_at, v_supersedes_id, false;
end;
$$;

revoke execute on function finalize_match_result_atomically(uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function correct_match_result_atomically(uuid, uuid, text, text) from public, anon, authenticated;
grant execute on function finalize_match_result_atomically(uuid, uuid, text, text) to service_role;
grant execute on function correct_match_result_atomically(uuid, uuid, text, text) to service_role;

do $$
declare
  r record;
begin
  for r in
    select p.oid::regprocedure as signature
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('finalize_match_result_atomically', 'correct_match_result_atomically')
  loop
    if has_function_privilege('anon', r.signature, 'execute')
       or has_function_privilege('authenticated', r.signature, 'execute') then
      raise exception 'FUNCTION_NOT_SERVER_ONLY: % is reachable by a browser role', r.signature;
    end if;
    if not has_function_privilege('service_role', r.signature, 'execute') then
      raise exception 'FUNCTION_MISSING_SERVER_GRANT: % is not executable by service_role', r.signature;
    end if;
  end loop;
end;
$$;
