-- Migration: 20261020150100_result_integrity_and_prize_correction_atomic_functions
-- Score Predictions — Result Integrity and Prize Correction.
--
-- Founder-accepted rules this migration enforces in the database:
--   1. All four prediction dimensions use REGULATION time: 90 minutes
--      plus first- and second-half stoppage. Goal events recorded after
--      minute 90 (extra time / penalties) are retained as evidence only
--      and are excluded from every dimension and from the score check.
--   2. A correction never authorizes a second physical delivery.
--   3. A redeemed entitlement that is unchanged by a correction is
--      linked to the ORIGINAL redemption (fulfilled_by), is not
--      redeemable, and does not copy the delivery actor/time.
--   4. A redeemed entitlement that CHANGES is created on hold; only a
--      CONSEQUENTIAL_FINALIZER can release it, with a reason, leaving an
--      attributable audit event.
--   5. A participant who no longer qualifies keeps their history; there
--      is no automatic clawback.
--
-- What changes, over 0120 / 0121 / 0124:
--
--   match_result_content_digest        deterministic sha256 of the exact
--                                      reviewed content (result, score,
--                                      teams, ordered events).
--   assert_match_result_integrity      every scorer belongs to one of the
--                                      match's two teams; regulation-time
--                                      goals credited per team (own goals
--                                      credit the opponent) equal the score.
--   save_draft_match_result_atomically one transaction: locks the match,
--                                      decides initial draft vs correction
--                                      under that lock, validates before
--                                      writing, replaces the draft's
--                                      events with it. Replaces the
--                                      previous non-atomic read-then-write
--                                      sequence in application code. The
--                                      caller sends the SAVE BASE of the
--                                      state it edited from (the draft's
--                                      digest, FINAL:<digest> to start a
--                                      correction, or NONE); a save whose
--                                      state changed meanwhile is refused.
--   finalize_match_result_atomically   NEW 4-arg signature: requires the
--                                      digest of the content the caller
--                                      reviewed; rechecks integrity;
--                                      refuses a correction draft; fixes
--                                      first-scorer ordering (45+10 no
--                                      longer ties with minute 55).
--   correct_match_result_atomically    NEW 4-arg signature, same digest
--                                      rule; implements the prize policy
--                                      above.
--   redeem_prize_qualification_atomically
--                                      same signature; refuses held and
--                                      already-fulfilled entitlements and
--                                      records the delivered prize label.
--   release_prize_qualification_hold_atomically
--                                      NEW.
--
-- Lock order (every function that takes more than one lock follows it, so
-- no cycle exists): matches row (FOR NO KEY UPDATE) -> match_results
-- draft row -> match_results superseded row -> prize_qualifications rows
-- (the correction is the only multi-row locker and runs under the match
-- lock, so it needs no row ordering). Redeem and release lock only their
-- own prize_qualifications row and wait on nothing else, and every state
-- decision is made AFTER the
-- lock is held, against freshly read state (READ COMMITTED re-evaluates a
-- locked row after waiting), so a correction racing a redemption or a
-- release always observes the other's committed outcome.
--
-- Callable-entrypoint inventory:
--   dropped    finalize_match_result_atomically(uuid, uuid, text)
--              correct_match_result_atomically(uuid, uuid, text)
--              (the unreviewed-content signatures; leaving them callable
--              would keep the stale path open)
--   replaced   redeem_prize_qualification_atomically(uuid, uuid, text)
--   new        the six functions above
-- Every function created here has EXECUTE revoked from PUBLIC, anon and
-- authenticated and granted to service_role only, in this migration.
-- The application checks authority with a server-resolved member
-- identity; these functions additionally enforce CONSEQUENTIAL_FINALIZER
-- where they did before. Possession of a digest is NOT authorization.
--
-- Immutability: finalized match_results, the goal events of finalized
-- results, evaluations and prize_qualifications evidence can no longer be
-- updated or deleted through ordinary paths (triggers). Direct client
-- access to the five settlement tables is closed (RLS on, anon and
-- authenticated privileges revoked); service_role keeps its access.
--
-- Two independent layers protect an entitlement from a second delivery:
-- the checks inside redeem / release / correct, and the table guard
-- trigger prize_qualifications_guard_evidence. Either alone refuses a
-- redemption of a superseded, held or already-fulfilled entitlement.
--
-- "Latest delivery" for a member and activation is the redeemed row at
-- the highest LINEAGE position (lineage_ordinal, derived from the explicit
-- supersession chain of results — see the previous migration). It is never
-- derived from created_at, redeemed_at, superseded_at or an id, because
-- transaction-start timestamps cannot order a chain: transactions can begin
-- in one order and take their locks in another, and one transaction can
-- write several rows with one timestamp. Where a delivery's position is
-- not established the correction holds the new entitlement for
-- reconciliation rather than guessing, and a delivery recorded before
-- delivery-time label snapshots existed never satisfies a corrected
-- entitlement on an inferred label.
--
-- NOT changed here (reported separately): other Predictions functions and
-- tables that are still reachable by client roles in this schema —
-- set_match_activity_classification_atomically,
-- set_match_xp_eligibility_atomically, upsert_prediction_atomically, and
-- the matches / predictions / players / teams / venues /
-- venue_activations tables — and the shared authority_grants /
-- admin_audit_events tables, which belong to the shared authority
-- architecture.

-- ---------------------------------------------------------------------
-- Digest + integrity helpers
-- ---------------------------------------------------------------------

create function match_result_content_digest(p_match_result_id uuid)
returns text
language sql
security invoker
set search_path = public
as $$
  select encode(
    sha256(convert_to(
      'v1'
      || '|' || mr.match_result_id::text
      || '|' || mr.match_id::text
      || '|' || m.home_team_id::text
      || '|' || m.away_team_id::text
      || '|' || mr.home_score::text
      || '|' || mr.away_score::text
      || '|' || coalesce(mr.supersedes_match_result_id::text, '')
      || '|' || coalesce((
            select string_agg(
                     e.ordinal::text
                     || ':' || e.scorer_player_id::text
                     || ':' || e.minute_regulation::text
                     || ':' || coalesce(e.minute_stoppage::text, '')
                     || ':' || (case when e.is_own_goal then '1' else '0' end),
                     ';' order by e.ordinal)
            from official_goal_events e
            where e.match_result_id = mr.match_result_id
          ), ''),
      'UTF8')),
    'hex')
  from match_results mr
  join matches m on m.match_id = mr.match_id
  where mr.match_result_id = p_match_result_id;
$$;

create function assert_match_result_integrity(p_match_result_id uuid)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_home_team_id uuid;
  v_away_team_id uuid;
  v_home_score integer;
  v_away_score integer;
  v_invalid_scorers integer;
  v_credited_home integer;
  v_credited_away integer;
begin
  select matches.home_team_id, matches.away_team_id, match_results.home_score, match_results.away_score
    into v_home_team_id, v_away_team_id, v_home_score, v_away_score
  from match_results
  join matches on matches.match_id = match_results.match_id
  where match_results.match_result_id = p_match_result_id;

  if not found then
    raise exception 'MATCH_RESULT_NOT_FOUND: no result exists for this id'
      using errcode = 'P0001';
  end if;

  select count(*) into v_invalid_scorers
  from official_goal_events
  left join players on players.player_id = official_goal_events.scorer_player_id
  where official_goal_events.match_result_id = p_match_result_id
    and (players.team_id is null or players.team_id not in (v_home_team_id, v_away_team_id));

  if v_invalid_scorers > 0 then
    raise exception 'MATCH_RESULT_SCORER_NOT_IN_MATCH: every goal scorer must be a player on one of this match''s two teams'
      using errcode = 'P0001';
  end if;

  -- Regulation time only (minute 1-90, which includes first- and
  -- second-half stoppage at 45 and 90). An own goal credits the
  -- opponent of the scorer's team. Extra-time events (91-120) are
  -- evidence only and never part of this check.
  select count(*) filter (where (players.team_id = v_home_team_id) <> official_goal_events.is_own_goal),
         count(*) filter (where (players.team_id = v_home_team_id) = official_goal_events.is_own_goal)
    into v_credited_home, v_credited_away
  from official_goal_events
  join players on players.player_id = official_goal_events.scorer_player_id
  where official_goal_events.match_result_id = p_match_result_id
    and official_goal_events.minute_regulation <= 90;

  if v_credited_home <> v_home_score or v_credited_away <> v_away_score then
    raise exception 'MATCH_RESULT_EVENTS_CONTRADICT_SCORE: regulation-time goal events credit % home and % away, but the score is %-%',
      v_credited_home, v_credited_away, v_home_score, v_away_score
      using errcode = 'P0001';
  end if;
end;
$$;

-- ---------------------------------------------------------------------
-- Atomic draft save
-- ---------------------------------------------------------------------

create function save_draft_match_result_atomically(
  p_match_id uuid,
  p_entered_by_gaming_member_id uuid,
  p_home_score integer,
  p_away_score integer,
  p_events jsonb,
  p_save_base text
)
returns table (
  match_result_id uuid,
  match_id uuid,
  home_score integer,
  away_score integer,
  entered_by_gaming_member_id uuid,
  created_at timestamptz,
  content_digest text,
  supersedes_match_result_id uuid,
  is_correction boolean
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_home_team_id uuid;
  v_away_team_id uuid;
  v_current_final_id uuid;
  v_draft_id uuid;
  v_draft_supersedes uuid;
  v_expected_base text;
  v_result_id uuid;
  v_supersedes uuid;
  v_event jsonb;
  v_ordinal integer := 0;
  v_scorer_player_id uuid;
  v_scorer_team_id uuid;
  v_minute_num numeric;
  v_stoppage_num numeric;
  v_minute integer;
  v_stoppage integer;
  v_own_goal boolean;
begin
  if p_save_base is null or length(btrim(p_save_base)) = 0 then
    raise exception 'MATCH_RESULT_BASE_REQUIRED: the save base from your last load of this result is required'
      using errcode = 'P0001';
  end if;

  if p_home_score is null or p_away_score is null or p_home_score < 0 or p_away_score < 0 then
    raise exception 'MATCH_RESULT_SCORE_INVALID: scores must be non-negative whole numbers'
      using errcode = 'P0001';
  end if;

  if p_events is null or jsonb_typeof(p_events) is distinct from 'array' then
    raise exception 'MATCH_RESULT_EVENTS_INVALID: official goal events must be a list'
      using errcode = 'P0001';
  end if;

  -- The one lock that serializes saves, finalization and correction for
  -- this match. NO KEY UPDATE conflicts with itself (and with FOR UPDATE /
  -- FOR SHARE) but not with the KEY SHARE lock foreign-key checks take,
  -- so concurrent member predictions are not blocked by it.
  select matches.home_team_id, matches.away_team_id
    into v_home_team_id, v_away_team_id
  from matches
  where matches.match_id = p_match_id
  for no key update;

  if not found then
    raise exception 'MATCH_NOT_FOUND: no match exists for this id'
      using errcode = 'P0001';
  end if;

  -- Initial draft vs correction is decided here, under the lock, from
  -- the supersession chain: the current finalized result is the finalized
  -- one that no other finalized result supersedes.
  select match_results.match_result_id into v_current_final_id
  from match_results
  where match_results.match_id = p_match_id
    and match_results.finalized_at is not null
    and not exists (
      select 1 from match_results later
      where later.supersedes_match_result_id = match_results.match_result_id
        and later.finalized_at is not null
    )
  order by match_result_lineage_ordinal(match_results.match_result_id) desc
  limit 1;

  select match_results.match_result_id, match_results.supersedes_match_result_id
    into v_draft_id, v_draft_supersedes
  from match_results
  where match_results.match_id = p_match_id
    and match_results.finalized_at is null
  for update;

  v_supersedes := v_current_final_id;

  if v_draft_id is not null and v_draft_supersedes is distinct from v_supersedes then
    raise exception 'RESULT_ALREADY_BEING_CORRECTED: this match already has a draft that does not belong to its current result'
      using errcode = 'P0001';
  end if;

  -- The save base identifies exactly the state the caller edited from:
  -- the draft's digest, else FINAL:<digest of the current finalized
  -- result> (the caller is starting a correction of it), else NONE (a
  -- first result). Compared HERE, under the match lock, so a save can
  -- never silently become a second first-result beside a result that
  -- was finalized meanwhile, or a correction the caller did not know of.
  if v_draft_id is not null then
    v_expected_base := match_result_content_digest(v_draft_id);
  elsif v_current_final_id is not null then
    v_expected_base := 'FINAL:' || match_result_content_digest(v_current_final_id);
  else
    v_expected_base := 'NONE';
  end if;

  if p_save_base <> v_expected_base then
    raise exception 'MATCH_RESULT_BASE_STALE: the result changed since you loaded it (it was saved, finalized or corrected); reload before saving'
      using errcode = 'P0001';
  end if;

  if v_draft_id is null then
    insert into match_results (
      match_id, home_score, away_score, entered_by_gaming_member_id, supersedes_match_result_id
    )
    values (
      p_match_id, p_home_score, p_away_score, p_entered_by_gaming_member_id, v_supersedes
    )
    returning match_results.match_result_id into v_result_id;
  else
    update match_results
       set home_score = p_home_score,
           away_score = p_away_score
     where match_results.match_result_id = v_draft_id
       and match_results.finalized_at is null;

    if not found then
      raise exception 'MATCH_RESULT_FINALIZED_IMMUTABLE: a finalized result cannot be changed'
        using errcode = 'P0001';
    end if;

    v_result_id := v_draft_id;

    delete from official_goal_events
    where official_goal_events.match_result_id = v_result_id;
  end if;

  for v_event in select value from jsonb_array_elements(p_events)
  loop
    v_ordinal := v_ordinal + 1;

    if jsonb_typeof(v_event) is distinct from 'object'
       or jsonb_typeof(v_event -> 'scorerPlayerId') is distinct from 'string'
       or jsonb_typeof(v_event -> 'minuteRegulation') is distinct from 'number'
       or ((v_event ? 'minuteStoppage') and jsonb_typeof(v_event -> 'minuteStoppage') not in ('number', 'null'))
       or ((v_event ? 'isOwnGoal') and jsonb_typeof(v_event -> 'isOwnGoal') not in ('boolean', 'null'))
       or (v_event ->> 'scorerPlayerId') !~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then
      raise exception 'MATCH_RESULT_EVENTS_INVALID: goal event % is malformed', v_ordinal
        using errcode = 'P0001';
    end if;

    v_scorer_player_id := (v_event ->> 'scorerPlayerId')::uuid;
    v_minute_num := (v_event ->> 'minuteRegulation')::numeric;
    v_stoppage_num := case
      when jsonb_typeof(v_event -> 'minuteStoppage') = 'number' then (v_event ->> 'minuteStoppage')::numeric
      else null
    end;
    v_own_goal := coalesce((v_event ->> 'isOwnGoal')::boolean, false);

    if v_minute_num <> trunc(v_minute_num)
       or v_minute_num < 1 or v_minute_num > 120
       or (v_stoppage_num is not null and (
             v_stoppage_num <> trunc(v_stoppage_num)
             or v_stoppage_num < 1
             or v_minute_num not in (45, 90, 105, 120)))
    then
      raise exception 'MATCH_RESULT_EVENT_MINUTE_INVALID: goal event % has an invalid minute; stoppage is only valid at minute 45, 90, 105 or 120', v_ordinal
        using errcode = 'P0001';
    end if;

    v_minute := v_minute_num::integer;
    v_stoppage := v_stoppage_num::integer;

    select players.team_id into v_scorer_team_id
    from players
    where players.player_id = v_scorer_player_id;

    if v_scorer_team_id is null or v_scorer_team_id not in (v_home_team_id, v_away_team_id) then
      raise exception 'MATCH_RESULT_SCORER_NOT_IN_MATCH: goal event % is not by a player on one of this match''s two teams', v_ordinal
        using errcode = 'P0001';
    end if;

    insert into official_goal_events (
      match_result_id, scorer_player_id, minute_regulation, minute_stoppage, is_own_goal, ordinal
    )
    values (
      v_result_id, v_scorer_player_id, v_minute, v_stoppage, v_own_goal, v_ordinal
    );
  end loop;

  perform assert_match_result_integrity(v_result_id);

  -- The saved row and its digest come from this same transaction, so a
  -- caller never pairs one save's record with another save's digest.
  return query
    select saved.match_result_id,
           saved.match_id,
           saved.home_score,
           saved.away_score,
           saved.entered_by_gaming_member_id,
           saved.created_at,
           match_result_content_digest(saved.match_result_id),
           saved.supersedes_match_result_id,
           (saved.supersedes_match_result_id is not null)
    from match_results saved
    where saved.match_result_id = v_result_id;
end;
$$;

-- ---------------------------------------------------------------------
-- Finalize (first result) — reviewed-content digest, integrity, ordering
-- ---------------------------------------------------------------------

drop function if exists finalize_match_result_atomically(uuid, uuid, text);

create function finalize_match_result_atomically(
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
           predictions.predicted_first_team_to_score, predictions.created_at
    from predictions
    where predictions.match_id = v_match_id
  loop
    v_scoreline_correct := (r_prediction.predicted_home_score = v_home_score and r_prediction.predicted_away_score = v_away_score);

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

    v_dimension_count := (
      v_scoreline_correct::int + v_goalscorer_correct::int + v_goal_minute_correct::int + v_first_team_correct::int
    );

    v_dimension_keys := array[]::text[];
    if v_scoreline_correct then v_dimension_keys := array_append(v_dimension_keys, 'EXACT_SCORELINE'); end if;
    if v_goalscorer_correct then v_dimension_keys := array_append(v_dimension_keys, 'ANY_GOALSCORER'); end if;
    if v_goal_minute_correct then v_dimension_keys := array_append(v_dimension_keys, 'ANY_GOAL_MINUTE'); end if;
    if v_first_team_correct then v_dimension_keys := array_append(v_dimension_keys, 'FIRST_TEAM_TO_SCORE'); end if;

    insert into evaluations (
      prediction_id, match_result_id, scoreline_correct, goalscorer_correct,
      goal_minute_correct, first_team_to_score_correct, correct_dimension_count
    )
    values (
      r_prediction.prediction_id, p_match_result_id, v_scoreline_correct, v_goalscorer_correct,
      v_goal_minute_correct, v_first_team_correct, v_dimension_count
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

    select prize_tiers.prize_tier_id into v_tier_id
    from prize_tiers
    where prize_tiers.venue_activation_id = r_prediction.venue_activation_id
      and prize_tiers.correct_dimension_count = v_dimension_count;

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

-- ---------------------------------------------------------------------
-- Correct (supersede a finalized result) — digest, integrity, prize policy
-- ---------------------------------------------------------------------

drop function if exists correct_match_result_atomically(uuid, uuid, text);

create function correct_match_result_atomically(
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
           predictions.predicted_first_team_to_score, predictions.created_at
    from predictions
    where predictions.match_id = v_match_id
  loop
    select evaluations.evaluation_id
      into v_old_evaluation_id
    from evaluations
    where evaluations.prediction_id = r_prediction.prediction_id
      and evaluations.match_result_id = v_supersedes_id;

    v_scoreline_correct := (r_prediction.predicted_home_score = v_home_score and r_prediction.predicted_away_score = v_away_score);

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

    v_dimension_count := (
      v_scoreline_correct::int + v_goalscorer_correct::int + v_goal_minute_correct::int + v_first_team_correct::int
    );

    v_dimension_keys := array[]::text[];
    if v_scoreline_correct then v_dimension_keys := array_append(v_dimension_keys, 'EXACT_SCORELINE'); end if;
    if v_goalscorer_correct then v_dimension_keys := array_append(v_dimension_keys, 'ANY_GOALSCORER'); end if;
    if v_goal_minute_correct then v_dimension_keys := array_append(v_dimension_keys, 'ANY_GOAL_MINUTE'); end if;
    if v_first_team_correct then v_dimension_keys := array_append(v_dimension_keys, 'FIRST_TEAM_TO_SCORE'); end if;

    insert into evaluations (
      prediction_id, match_result_id, scoreline_correct, goalscorer_correct,
      goal_minute_correct, first_team_to_score_correct, correct_dimension_count
    )
    values (
      r_prediction.prediction_id, p_match_result_id, v_scoreline_correct, v_goalscorer_correct,
      v_goal_minute_correct, v_first_team_correct, v_dimension_count
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

    select prize_tiers.prize_tier_id, prize_tiers.prize_label
      into v_new_tier_id, v_new_tier_label
    from prize_tiers
    where prize_tiers.venue_activation_id = r_prediction.venue_activation_id
      and prize_tiers.correct_dimension_count = v_dimension_count;

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
        select prize_tiers.correct_dimension_count into v_last_redeemed_dimension_count
        from prize_tiers
        where prize_tiers.prize_tier_id = v_last_redeemed_tier_id;
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
            'A correction affected a prize for a member who already has a delivery, but the order of this member''s deliveries and replacements could not be established from the records. Now entitled to: "%s" (%s of 4 correct). A Consequential Finalizer must reconcile this with the venue, with a reason, before any further delivery.',
            v_new_tier_label, v_dimension_count
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
            'A correction changed a prize that was already delivered. Delivered: "%s" (%s of 4 correct). Now entitled to: "%s" (%s of 4 correct). No further delivery is authorized until a Consequential Finalizer releases this hold with a reason.',
            v_last_redeemed_label,
            coalesce(v_last_redeemed_dimension_count::text, '?'),
            v_new_tier_label,
            v_dimension_count
          );
        else
          -- The earlier delivery predates delivery-time label snapshots:
          -- today's definition of that prize is not evidence of what was
          -- handed over, so equivalence is unknown and cannot be inferred.
          v_hold_basis := 'DELIVERY_EQUIVALENCE_UNKNOWN';
          v_hold_text := format(
            'A correction affected a prize that was already delivered, but that delivery was recorded before delivery-time prize labels were kept, so it cannot be shown to be the same prize. The earlier delivery is defined today as "%s" (%s of 4 correct), which may differ from what was handed over; this correction entitles the member to "%s" (%s of 4 correct). A Consequential Finalizer must reconcile this with the venue, with a reason, before any further delivery.',
            coalesce(v_last_redeemed_observed, '(no definition found)'),
            coalesce(v_last_redeemed_dimension_count::text, '?'),
            v_new_tier_label,
            v_dimension_count
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

-- ---------------------------------------------------------------------
-- Redeem — refuses held / already-fulfilled entitlements
-- ---------------------------------------------------------------------

drop function if exists redeem_prize_qualification_atomically(uuid, uuid, text);

create function redeem_prize_qualification_atomically(
  p_prize_qualification_id uuid,
  p_redeemed_by_gaming_member_id uuid,
  p_reason text default null
)
returns table (
  prize_qualification_id uuid,
  redeemed_at timestamptz,
  already_redeemed boolean
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_existing_redeemed_at timestamptz;
  v_existing_superseded_at timestamptz;
  v_held_at timestamptz;
  v_released_at timestamptz;
  v_fulfilled_by uuid;
  v_prize_tier_id uuid;
  v_prize_label text;
  v_new_redeemed_at timestamptz;
  v_has_authority boolean;
begin
  select prize_qualifications.redeemed_at, prize_qualifications.superseded_at,
         prize_qualifications.held_at, prize_qualifications.released_at,
         prize_qualifications.fulfilled_by_prize_qualification_id, prize_qualifications.prize_tier_id
    into v_existing_redeemed_at, v_existing_superseded_at,
         v_held_at, v_released_at, v_fulfilled_by, v_prize_tier_id
  from prize_qualifications
  where prize_qualifications.prize_qualification_id = p_prize_qualification_id
  for update;

  if not found then
    raise exception 'PRIZE_QUALIFICATION_NOT_FOUND: no qualification exists for this id'
      using errcode = 'P0001';
  end if;

  select exists(
    select 1 from authority_grants
    where authority_grants.gaming_member_id = p_redeemed_by_gaming_member_id
      and authority_grants.authority_class = 'CONSEQUENTIAL_FINALIZER'
      and authority_grants.revoked_at is null
  ) into v_has_authority;

  if not v_has_authority then
    raise exception 'CONSEQUENTIAL_FINALIZER_AUTHORITY_REQUIRED: this action requires Consequential Finalizer authority'
      using errcode = 'P0001';
  end if;

  -- Every decision below is made against the row as locked above.
  if v_existing_redeemed_at is not null then
    return query select p_prize_qualification_id, v_existing_redeemed_at, true;
    return;
  end if;

  if v_existing_superseded_at is not null then
    raise exception 'QUALIFICATION_SUPERSEDED: this qualification is no longer supported by the current result'
      using errcode = 'P0001';
  end if;

  if v_fulfilled_by is not null then
    raise exception 'PRIZE_ALREADY_FULFILLED: an earlier delivery already satisfies this entitlement'
      using errcode = 'P0001';
  end if;

  if v_held_at is not null and v_released_at is null then
    raise exception 'PRIZE_QUALIFICATION_HELD: this entitlement is on hold until a Consequential Finalizer releases it'
      using errcode = 'P0001';
  end if;

  select prize_tiers.prize_label into v_prize_label
  from prize_tiers
  where prize_tiers.prize_tier_id = v_prize_tier_id;

  v_new_redeemed_at := now();

  update prize_qualifications
     set redeemed_at = v_new_redeemed_at,
         redeemed_by_gaming_member_id = p_redeemed_by_gaming_member_id,
         redeemed_prize_label = v_prize_label,
         redeemed_prize_label_basis = 'SNAPSHOT_AT_REDEMPTION'
   where prize_qualifications.prize_qualification_id = p_prize_qualification_id;

  insert into admin_audit_events (
    action_type, actor_kind, actor_id, authority_class_used,
    target_type, target_id, resulting_reference, outcome, reason
  )
  values (
    'CONFIRM_PRIZE_REDEMPTION', 'GAMING_MEMBER', p_redeemed_by_gaming_member_id, 'CONSEQUENTIAL_FINALIZER',
    'prize_qualifications', p_prize_qualification_id,
    jsonb_build_object('table', 'prize_qualifications', 'id', p_prize_qualification_id),
    'SUCCESS', p_reason
  );

  return query select p_prize_qualification_id, v_new_redeemed_at, false;
end;
$$;

-- ---------------------------------------------------------------------
-- Release a hold — reasoned, CONSEQUENTIAL_FINALIZER only, audited
-- ---------------------------------------------------------------------

create function release_prize_qualification_hold_atomically(
  p_prize_qualification_id uuid,
  p_released_by_gaming_member_id uuid,
  p_reason text
)
returns table (
  prize_qualification_id uuid,
  released_at timestamptz,
  already_released boolean
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_held_at timestamptz;
  v_released_at timestamptz;
  v_superseded_at timestamptz;
  v_hold_prior uuid;
  v_new_released_at timestamptz;
  v_has_authority boolean;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'REASON_REQUIRED: releasing a prize hold requires a reason'
      using errcode = 'P0001';
  end if;

  select prize_qualifications.held_at, prize_qualifications.released_at,
         prize_qualifications.superseded_at, prize_qualifications.hold_prior_prize_qualification_id
    into v_held_at, v_released_at, v_superseded_at, v_hold_prior
  from prize_qualifications
  where prize_qualifications.prize_qualification_id = p_prize_qualification_id
  for update;

  if not found then
    raise exception 'PRIZE_QUALIFICATION_NOT_FOUND: no qualification exists for this id'
      using errcode = 'P0001';
  end if;

  select exists(
    select 1 from authority_grants
    where authority_grants.gaming_member_id = p_released_by_gaming_member_id
      and authority_grants.authority_class = 'CONSEQUENTIAL_FINALIZER'
      and authority_grants.revoked_at is null
  ) into v_has_authority;

  if not v_has_authority then
    raise exception 'CONSEQUENTIAL_FINALIZER_AUTHORITY_REQUIRED: this action requires Consequential Finalizer authority'
      using errcode = 'P0001';
  end if;

  if v_held_at is null then
    raise exception 'PRIZE_QUALIFICATION_NOT_HELD: this entitlement is not on hold'
      using errcode = 'P0001';
  end if;

  if v_released_at is not null then
    return query select p_prize_qualification_id, v_released_at, true;
    return;
  end if;

  if v_superseded_at is not null then
    raise exception 'QUALIFICATION_SUPERSEDED: this qualification is no longer supported by the current result'
      using errcode = 'P0001';
  end if;

  v_new_released_at := now();

  update prize_qualifications
     set released_at = v_new_released_at,
         released_by_gaming_member_id = p_released_by_gaming_member_id,
         release_reason = p_reason
   where prize_qualifications.prize_qualification_id = p_prize_qualification_id;

  insert into admin_audit_events (
    action_type, actor_kind, actor_id, authority_class_used,
    target_type, target_id, occurred_at, previous_reference, resulting_reference, outcome, reason
  )
  values (
    'RELEASE_PRIZE_HOLD', 'GAMING_MEMBER', p_released_by_gaming_member_id, 'CONSEQUENTIAL_FINALIZER',
    'prize_qualifications', p_prize_qualification_id, v_new_released_at,
    jsonb_build_object('table', 'prize_qualifications', 'id', v_hold_prior),
    jsonb_build_object('table', 'prize_qualifications', 'id', p_prize_qualification_id),
    'SUCCESS', p_reason
  );

  return query select p_prize_qualification_id, v_new_released_at, false;
end;
$$;

-- ---------------------------------------------------------------------
-- Immutability of settled evidence
-- ---------------------------------------------------------------------

create function match_results_reject_finalized_change()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  if old.finalized_at is not null then
    raise exception 'MATCH_RESULT_FINALIZED_IMMUTABLE: a finalized result cannot be changed or deleted'
      using errcode = 'P0001';
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;

  -- A draft may be finalized (finalized_at / finalized_by set) and may
  -- have its scores edited; its identity may never change.
  if new.match_result_id is distinct from old.match_result_id
     or new.match_id is distinct from old.match_id
     or new.supersedes_match_result_id is distinct from old.supersedes_match_result_id
     or new.entered_by_gaming_member_id is distinct from old.entered_by_gaming_member_id
     or new.created_at is distinct from old.created_at then
    raise exception 'MATCH_RESULT_FINALIZED_IMMUTABLE: a result''s identity cannot be changed'
      using errcode = 'P0001';
  end if;

  return new;
end;
$$;

create trigger match_results_finalized_immutable
  before update or delete on match_results
  for each row execute function match_results_reject_finalized_change();

create function official_goal_events_reject_finalized_change()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_old_finalized_at timestamptz;
  v_new_finalized_at timestamptz;
begin
  -- FOR SHARE makes a direct change wait for a concurrent finalization
  -- (which holds the result row FOR UPDATE) and then see its outcome.
  if tg_op in ('UPDATE', 'DELETE') then
    select match_results.finalized_at into v_old_finalized_at
    from match_results
    where match_results.match_result_id = old.match_result_id
    for share;

    if v_old_finalized_at is not null then
      raise exception 'MATCH_RESULT_FINALIZED_IMMUTABLE: goal evidence of a finalized result cannot be changed or deleted'
        using errcode = 'P0001';
    end if;
  end if;

  if tg_op in ('INSERT', 'UPDATE') then
    select match_results.finalized_at into v_new_finalized_at
    from match_results
    where match_results.match_result_id = new.match_result_id
    for share;

    if v_new_finalized_at is not null then
      raise exception 'MATCH_RESULT_FINALIZED_IMMUTABLE: goal evidence cannot be added to a finalized result'
        using errcode = 'P0001';
    end if;
  end if;

  if tg_op = 'DELETE' then
    return old;
  end if;
  return new;
end;
$$;

create trigger official_goal_events_finalized_immutable
  before insert or update or delete on official_goal_events
  for each row execute function official_goal_events_reject_finalized_change();

create function evaluations_reject_change()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  raise exception 'EVALUATION_IMMUTABLE: an evaluation is immutable evidence of one result version'
    using errcode = 'P0001';
end;
$$;

create trigger evaluations_immutable
  before update or delete on evaluations
  for each row execute function evaluations_reject_change();

-- The previous migration's transitional enforcement (hold-aware redemption
-- for the OLD redeem function, hold-on-creation for the OLD correct
-- function) existed only because those functions were still installed. This
-- migration replaced them above; the guard below is stronger and complete,
-- so the transitional triggers and their helper are dropped here, in the
-- same transaction that installs it: there is no moment without a guard.
drop trigger if exists prize_qualifications_transitional_redeem_guard on prize_qualifications;
drop trigger if exists prize_qualifications_transitional_insert_guard on prize_qualifications;
drop function if exists prize_qualifications_transitional_redeem_guard();
drop function if exists prize_qualifications_transitional_insert_guard();
drop function if exists prize_qualification_twin_hold(uuid, uuid, integer);

create function prize_qualifications_guard_evidence()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_ref record;
  v_expected_lineage integer;
begin
  if tg_op = 'DELETE' then
    raise exception 'PRIZE_QUALIFICATION_IMMUTABLE: prize qualification history cannot be deleted'
      using errcode = 'P0001';
  end if;

  if tg_op = 'INSERT' then
    if new.redeemed_at is not null or new.redeemed_by_gaming_member_id is not null
       or new.redeemed_prize_label is not null or new.redeemed_prize_label_basis is not null
       or new.legacy_observed_prize_label is not null or new.superseded_at is not null
       or new.released_at is not null or new.released_by_gaming_member_id is not null
       or new.release_reason is not null then
      raise exception 'PRIZE_QUALIFICATION_IMMUTABLE: a qualification must be created without redemption, supersession or release state'
        using errcode = 'P0001';
    end if;

    -- A new entitlement states its position in the result chain, and it
    -- must be the position of its own evaluation's result.
    select match_result_lineage_ordinal(evaluations.match_result_id) into v_expected_lineage
    from evaluations
    where evaluations.evaluation_id = new.evaluation_id;
    if new.lineage_ordinal is distinct from v_expected_lineage then
      raise exception 'PRIZE_QUALIFICATION_IMMUTABLE: an entitlement''s lineage position must be that of its own result in the supersession chain'
        using errcode = 'P0001';
    end if;

    if new.fulfilled_by_prize_qualification_id is not null then
      select prize_qualifications.gaming_member_id, prize_qualifications.venue_activation_id,
             prize_qualifications.redeemed_at, prize_qualifications.redeemed_prize_label_basis
        into v_ref
      from prize_qualifications
      where prize_qualifications.prize_qualification_id = new.fulfilled_by_prize_qualification_id;
      -- Only a delivery whose prize was recorded AT redemption can satisfy a later entitlement.
      if not found or v_ref.redeemed_at is null
         or v_ref.redeemed_prize_label_basis is distinct from 'SNAPSHOT_AT_REDEMPTION'
         or v_ref.gaming_member_id <> new.gaming_member_id
         or v_ref.venue_activation_id <> new.venue_activation_id then
        raise exception 'PRIZE_QUALIFICATION_IMMUTABLE: a fulfilled-by link must point to a delivery recorded at redemption, of the same member and activation'
          using errcode = 'P0001';
      end if;
    end if;

    if new.hold_prior_prize_qualification_id is not null then
      select prize_qualifications.gaming_member_id, prize_qualifications.venue_activation_id, prize_qualifications.redeemed_at
        into v_ref
      from prize_qualifications
      where prize_qualifications.prize_qualification_id = new.hold_prior_prize_qualification_id;
      if not found or v_ref.redeemed_at is null
         or v_ref.gaming_member_id <> new.gaming_member_id
         or v_ref.venue_activation_id <> new.venue_activation_id then
        raise exception 'PRIZE_QUALIFICATION_IMMUTABLE: a hold must point to a redeemed qualification of the same member and activation'
          using errcode = 'P0001';
      end if;
    end if;

    return new;
  end if;

  -- UPDATE
  if new.prize_qualification_id is distinct from old.prize_qualification_id
     or new.evaluation_id is distinct from old.evaluation_id
     or new.gaming_member_id is distinct from old.gaming_member_id
     or new.venue_activation_id is distinct from old.venue_activation_id
     or new.prize_tier_id is distinct from old.prize_tier_id
     or new.created_at is distinct from old.created_at
     or new.lineage_ordinal is distinct from old.lineage_ordinal
     or new.replaces_prize_qualification_id is distinct from old.replaces_prize_qualification_id
     or new.fulfilled_by_prize_qualification_id is distinct from old.fulfilled_by_prize_qualification_id
     or new.hold_prior_prize_qualification_id is distinct from old.hold_prior_prize_qualification_id
     or new.held_at is distinct from old.held_at
     or new.hold_basis is distinct from old.hold_basis
     or new.hold_reason is distinct from old.hold_reason then
    raise exception 'PRIZE_QUALIFICATION_IMMUTABLE: a qualification''s identity, lineage and hold evidence cannot be changed'
      using errcode = 'P0001';
  end if;

  if old.redeemed_at is not null then
    if new.redeemed_at is distinct from old.redeemed_at
       or new.redeemed_by_gaming_member_id is distinct from old.redeemed_by_gaming_member_id
       or new.redeemed_prize_label is distinct from old.redeemed_prize_label
       or new.redeemed_prize_label_basis is distinct from old.redeemed_prize_label_basis
       or new.legacy_observed_prize_label is distinct from old.legacy_observed_prize_label then
      raise exception 'PRIZE_QUALIFICATION_IMMUTABLE: delivery evidence of a redeemed qualification cannot be changed'
        using errcode = 'P0001';
    end if;
  elsif new.redeemed_at is not null then
    -- The entitlement's own state is judged first, so a refusal names the
    -- business reason; the evidence shape of a permitted redemption second.
    if old.superseded_at is not null then
      raise exception 'QUALIFICATION_SUPERSEDED: this qualification is no longer supported by the current result'
        using errcode = 'P0001';
    end if;
    if old.fulfilled_by_prize_qualification_id is not null then
      raise exception 'PRIZE_ALREADY_FULFILLED: an earlier delivery already satisfies this entitlement'
        using errcode = 'P0001';
    end if;
    if old.held_at is not null and old.released_at is null then
      raise exception 'PRIZE_QUALIFICATION_HELD: this entitlement is on hold until a Consequential Finalizer releases it'
        using errcode = 'P0001';
    end if;
    if new.redeemed_by_gaming_member_id is null or new.redeemed_prize_label is null
       or new.redeemed_prize_label_basis is distinct from 'SNAPSHOT_AT_REDEMPTION'
       or new.legacy_observed_prize_label is not null then
      raise exception 'PRIZE_QUALIFICATION_IMMUTABLE: a redemption must record who delivered and a snapshot of the prize at that moment'
        using errcode = 'P0001';
    end if;
  elsif new.redeemed_by_gaming_member_id is not null or new.redeemed_prize_label is not null
        or new.redeemed_prize_label_basis is not null or new.legacy_observed_prize_label is not null then
    raise exception 'PRIZE_QUALIFICATION_IMMUTABLE: redemption fields must be set together with redeemed_at'
      using errcode = 'P0001';
  end if;

  if old.superseded_at is not null and new.superseded_at is distinct from old.superseded_at then
    raise exception 'PRIZE_QUALIFICATION_IMMUTABLE: supersession cannot be undone or changed'
      using errcode = 'P0001';
  end if;

  if old.released_at is not null then
    if new.released_at is distinct from old.released_at
       or new.released_by_gaming_member_id is distinct from old.released_by_gaming_member_id
       or new.release_reason is distinct from old.release_reason then
      raise exception 'PRIZE_QUALIFICATION_IMMUTABLE: a hold release cannot be changed'
        using errcode = 'P0001';
    end if;
  elsif new.released_at is not null then
    if old.held_at is null then
      raise exception 'PRIZE_QUALIFICATION_NOT_HELD: this entitlement is not on hold'
        using errcode = 'P0001';
    end if;
  end if;

  return new;
end;
$$;

create trigger prize_qualifications_evidence_guard
  before insert or update or delete on prize_qualifications
  for each row execute function prize_qualifications_guard_evidence();

create function predictions_settlement_reject_truncate()
returns trigger
language plpgsql
security invoker
set search_path = public
as $$
begin
  raise exception 'SETTLEMENT_EVIDENCE_IMMUTABLE: settlement evidence cannot be truncated'
    using errcode = 'P0001';
end;
$$;

create trigger match_results_no_truncate
  before truncate on match_results
  for each statement execute function predictions_settlement_reject_truncate();
create trigger official_goal_events_no_truncate
  before truncate on official_goal_events
  for each statement execute function predictions_settlement_reject_truncate();
create trigger evaluations_no_truncate
  before truncate on evaluations
  for each statement execute function predictions_settlement_reject_truncate();
create trigger prize_qualifications_no_truncate
  before truncate on prize_qualifications
  for each statement execute function predictions_settlement_reject_truncate();

-- ---------------------------------------------------------------------
-- Database access boundary
-- ---------------------------------------------------------------------

-- Every function created or replaced above: service_role only.
revoke execute on function match_result_content_digest(uuid) from public, anon, authenticated;
revoke execute on function assert_match_result_integrity(uuid) from public, anon, authenticated;
revoke execute on function save_draft_match_result_atomically(uuid, uuid, integer, integer, jsonb, text) from public, anon, authenticated;
revoke execute on function finalize_match_result_atomically(uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function correct_match_result_atomically(uuid, uuid, text, text) from public, anon, authenticated;
revoke execute on function redeem_prize_qualification_atomically(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function release_prize_qualification_hold_atomically(uuid, uuid, text) from public, anon, authenticated;
revoke execute on function match_results_reject_finalized_change() from public, anon, authenticated;
revoke execute on function official_goal_events_reject_finalized_change() from public, anon, authenticated;
revoke execute on function evaluations_reject_change() from public, anon, authenticated;
revoke execute on function prize_qualifications_guard_evidence() from public, anon, authenticated;
revoke execute on function predictions_settlement_reject_truncate() from public, anon, authenticated;

grant execute on function match_result_content_digest(uuid) to service_role;
grant execute on function assert_match_result_integrity(uuid) to service_role;
grant execute on function save_draft_match_result_atomically(uuid, uuid, integer, integer, jsonb, text) to service_role;
grant execute on function finalize_match_result_atomically(uuid, uuid, text, text) to service_role;
grant execute on function correct_match_result_atomically(uuid, uuid, text, text) to service_role;
grant execute on function redeem_prize_qualification_atomically(uuid, uuid, text) to service_role;
grant execute on function release_prize_qualification_hold_atomically(uuid, uuid, text) to service_role;

-- The five settlement tables are reached only through the server-side
-- (service_role) repository. RLS is enabled explicitly rather than left
-- to a platform trigger, and direct client privileges are removed.
alter table match_results enable row level security;
alter table official_goal_events enable row level security;
alter table evaluations enable row level security;
alter table prize_qualifications enable row level security;
alter table prize_tiers enable row level security;

revoke all on table match_results from public, anon, authenticated;
revoke all on table official_goal_events from public, anon, authenticated;
revoke all on table evaluations from public, anon, authenticated;
revoke all on table prize_qualifications from public, anon, authenticated;
revoke all on table prize_tiers from public, anon, authenticated;
