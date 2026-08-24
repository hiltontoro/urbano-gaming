-- Migration: 0145_submit_math_duel_answer_atomically_lazy_sudden_death
-- Math Duel Slice 001 — Pre-Deployment Product-Invariant Correction.
--
-- Replaces 0141's own submit_math_duel_answer_atomically. Two
-- confirmed defects corrected together, since lazy sudden-death
-- creation is the shared fix for both:
--
-- Issue A (finite reserve contradicted "no round cap"): 0141's design
-- pre-materialized exactly 25 sudden-death rows; the 26th consecutive
-- tied round had no row to read, and this function raised
-- MATH_DUEL_CHALLENGES_EXHAUSTED permanently — a real functional cap,
-- not a "vanishingly unlikely" non-issue, directly contradicting the
-- Founder-confirmed Product Definition. This function now creates
-- exactly one new duel_math_challenges row, lazily, at the precise
-- moment a tie is confirmed (STANDARD ordinal 5, or any SUDDEN_DEATH
-- ordinal) — using p_next_challenge, content the caller (submitMathDuelAnswer.ts)
-- always computes via mathDuelFixture.ts's own generateSuddenDeathChallenge(duelId, ordinal),
-- a pure, deterministic, unbounded generator (see that file's own
-- comment). There is structurally no ordinal ceiling any more.
--
-- Race-free by construction, not by new locking: the duels row is
-- already locked FOR UPDATE for this entire function's execution
-- (0141's own established order), which already fully serializes
-- calls for one Duel — the exact same guarantee this function already
-- relied on to ensure only the second-to-answer call ever performs
-- normal resolution now equally ensures only that same call ever
-- performs the "create the next round" insert. No two calls can ever
-- both observe "the other has now answered" true for the same
-- ordinal, so at most one INSERT per ordinal boundary ever runs.
--
-- Issue B (response existence misclassified "activated but never
-- answered" evidence as never having happened): a challenge Cancel'd/
-- Void'd/Forfeited after being shown to competitors but before either
-- answered is genuinely part of the played Duel, not merely prepared-
-- but-untouched reserve — a raw duel_math_responses join could not
-- tell the difference. duel_math_challenges.activated_at (0143) is
-- the real, non-derivable signal: set here the moment either
-- competitor first becomes authorized into the *next* ordinal
-- (STANDARD 2-5, forwarded right after recording this response), and
-- at creation time for a lazily-created SUDDEN_DEATH row (creation
-- *is* activation there — there is no pre-existing reserve any more
-- for a SUDDEN_DEATH row to sit in, unactivated, the way a STANDARD
-- row briefly can). Ordinal 1's activation is set by 0144, at Duel
-- start. getSession.ts's terminal reveal now filters on activated_at,
-- not response existence, correctly including an activated-but-
-- unanswered final round in historical evidence.
--
-- The independent-pacing guard (0141's own fix, unchanged): ordinal
-- 6+ still requires the other competitor to have recorded all 5
-- standard responses first — now doubly necessary, since a
-- SUDDEN_DEATH row for an ordinal beyond the one just tied genuinely
-- does not exist yet under lazy creation, not merely "exists but
-- shouldn't be shown yet."

create or replace function submit_math_duel_answer_atomically(
  p_duel_id uuid,
  p_participant_token text,
  p_challenge_ordinal integer,
  p_submitted_answer integer,
  p_next_challenge jsonb default null
)
returns table (
  participant_id uuid,
  challenge_ordinal integer,
  answered_at timestamptz
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_session_id uuid;
  v_mechanic_key text;
  v_lifecycle_state text;
  v_competitor_a uuid;
  v_competitor_b uuid;
  v_participant_id uuid;
  v_other_participant_id uuid;
  v_my_answered_count integer;
  v_expected_ordinal integer;
  v_existing_answered_at timestamptz;
  v_correct_answer integer;
  v_phase text;
  v_is_correct boolean;
  v_answered_at timestamptz;
  v_other_has_answered boolean;
  v_other_correct boolean;
  v_a_correct_count integer;
  v_b_correct_count integer;
  v_resolution text;
  v_winner uuid;
  v_ended_at timestamptz;
  v_next_ordinal integer;
begin
  select duels.session_id into v_session_id
  from duels
  where duels.duel_id = p_duel_id;

  if v_session_id is null then
    raise exception 'DUEL_NOT_FOUND: no duel exists for this duel_id'
      using errcode = 'P0001';
  end if;

  perform 1 from sessions where sessions.session_id = v_session_id for update;

  select duels.mechanic_key, duels.lifecycle_state,
         duels.competitor_a_participant_id, duels.competitor_b_participant_id
    into v_mechanic_key, v_lifecycle_state, v_competitor_a, v_competitor_b
  from duels
  where duels.duel_id = p_duel_id
  for update;

  if v_mechanic_key <> 'MATH_DUEL' then
    raise exception 'DUEL_NOT_FOUND: no Math Duel exists for this duel_id'
      using errcode = 'P0001';
  end if;

  if v_lifecycle_state <> 'ACTIVE' then
    raise exception 'DUEL_NOT_ACTIVE: duel is in % state, not ACTIVE', v_lifecycle_state
      using errcode = 'P0001';
  end if;

  select participants.participant_id into v_participant_id
  from participants
  where participants.session_id = v_session_id
    and participants.participant_token = p_participant_token;

  if v_participant_id is null or v_participant_id not in (v_competitor_a, v_competitor_b) then
    raise exception 'DUEL_ACCESS_DENIED: caller is not a competitor in this duel'
      using errcode = 'P0001';
  end if;

  v_other_participant_id := case when v_participant_id = v_competitor_a then v_competitor_b else v_competitor_a end;

  if p_challenge_ordinal is null or p_challenge_ordinal < 1 then
    raise exception 'INVALID_MATH_DUEL_ANSWER: challenge ordinal must be a positive integer'
      using errcode = 'P0001';
  end if;

  if p_submitted_answer is null or p_submitted_answer < 0 then
    raise exception 'INVALID_MATH_DUEL_ANSWER: submitted answer must be a non-negative integer'
      using errcode = 'P0001';
  end if;

  select count(*) into v_my_answered_count
  from duel_math_responses
  where duel_math_responses.duel_id = p_duel_id
    and duel_math_responses.participant_id = v_participant_id;

  v_expected_ordinal := v_my_answered_count + 1;

  if p_challenge_ordinal < v_expected_ordinal then
    select duel_math_responses.answered_at into v_existing_answered_at
    from duel_math_responses
    where duel_math_responses.duel_id = p_duel_id
      and duel_math_responses.challenge_ordinal = p_challenge_ordinal
      and duel_math_responses.participant_id = v_participant_id;

    return query select v_participant_id, p_challenge_ordinal, v_existing_answered_at;
    return;
  end if;

  if p_challenge_ordinal > v_expected_ordinal then
    raise exception 'INVALID_MATH_DUEL_ORDINAL: challenge % is not yet authorized; the next challenge is %', p_challenge_ordinal, v_expected_ordinal
      using errcode = 'P0001';
  end if;

  if p_challenge_ordinal > 5 then
    if (
      select count(*) from duel_math_responses
      where duel_math_responses.duel_id = p_duel_id
        and duel_math_responses.participant_id = v_other_participant_id
        and duel_math_responses.challenge_ordinal between 1 and 5
    ) < 5 then
      raise exception 'INVALID_MATH_DUEL_ORDINAL: challenge % is not yet authorized; waiting for the opponent to finish the standard phase', p_challenge_ordinal
        using errcode = 'P0001';
    end if;
  end if;

  select duel_math_challenges.correct_answer, duel_math_challenges.phase
    into v_correct_answer, v_phase
  from duel_math_challenges
  where duel_math_challenges.duel_id = p_duel_id
    and duel_math_challenges.challenge_ordinal = p_challenge_ordinal;

  if v_correct_answer is null then
    raise exception 'MATH_DUEL_CHALLENGES_EXHAUSTED: no further challenges remain for this duel'
      using errcode = 'P0001';
  end if;

  v_is_correct := p_submitted_answer = v_correct_answer;
  v_answered_at := now();

  insert into duel_math_responses (duel_id, challenge_ordinal, participant_id, submitted_answer, is_correct, answered_at)
  values (p_duel_id, p_challenge_ordinal, v_participant_id, p_submitted_answer, v_is_correct, v_answered_at)
  on conflict (duel_id, challenge_ordinal, participant_id) do nothing;

  -- Forward-activate the STANDARD phase's own next ordinal (2-5), the
  -- instant either competitor is first authorized into it — a no-op
  -- if p_challenge_ordinal is 5 or later (the target ordinal is
  -- SUDDEN_DEATH territory, activated separately below, only once a
  -- tie actually creates it) or if it was already activated by the
  -- other competitor reaching it first.
  if p_challenge_ordinal < 5 then
    update duel_math_challenges
       set activated_at = coalesce(activated_at, v_answered_at)
     where duel_math_challenges.duel_id = p_duel_id
       and duel_math_challenges.challenge_ordinal = p_challenge_ordinal + 1;
  end if;

  select exists(
    select 1 from duel_math_responses
    where duel_math_responses.duel_id = p_duel_id
      and duel_math_responses.challenge_ordinal = p_challenge_ordinal
      and duel_math_responses.participant_id = v_other_participant_id
  ) into v_other_has_answered;

  if v_other_has_answered then
    if v_phase = 'STANDARD' and p_challenge_ordinal = 5 then
      select count(*) into v_a_correct_count
      from duel_math_responses
      where duel_math_responses.duel_id = p_duel_id
        and duel_math_responses.participant_id = v_competitor_a
        and duel_math_responses.challenge_ordinal between 1 and 5
        and duel_math_responses.is_correct;

      select count(*) into v_b_correct_count
      from duel_math_responses
      where duel_math_responses.duel_id = p_duel_id
        and duel_math_responses.participant_id = v_competitor_b
        and duel_math_responses.challenge_ordinal between 1 and 5
        and duel_math_responses.is_correct;

      if v_a_correct_count <> v_b_correct_count then
        v_resolution := 'WON_LOST';
        v_winner := case when v_a_correct_count > v_b_correct_count then v_competitor_a else v_competitor_b end;
      end if;
      -- Equal counts: genuinely tied — create sudden-death ordinal 6
      -- now, lazily, using the caller-supplied candidate content.

    elsif v_phase = 'SUDDEN_DEATH' then
      select duel_math_responses.is_correct into v_other_correct
      from duel_math_responses
      where duel_math_responses.duel_id = p_duel_id
        and duel_math_responses.challenge_ordinal = p_challenge_ordinal
        and duel_math_responses.participant_id = v_other_participant_id;

      if v_is_correct and not v_other_correct then
        v_resolution := 'WON_LOST';
        v_winner := v_participant_id;
      elsif v_other_correct and not v_is_correct then
        v_resolution := 'WON_LOST';
        v_winner := v_other_participant_id;
      end if;
      -- Both correct or both wrong: another tied round — create the
      -- next sudden-death ordinal now, lazily.
    end if;
  end if;

  if v_resolution is not null then
    v_ended_at := now();

    update duels
       set lifecycle_state = 'COMPLETED',
           terminal_resolution = v_resolution,
           winner_participant_id = v_winner,
           ended_at = v_ended_at
     where duels.duel_id = p_duel_id;

    insert into session_events (session_id, event_type, payload)
    values (
      v_session_id,
      'DUEL_RESOLVED',
      jsonb_build_object(
        'duelId', p_duel_id,
        'terminalResolution', v_resolution,
        'winnerParticipantId', v_winner
      )
    );
  elsif v_other_has_answered and (
    (v_phase = 'STANDARD' and p_challenge_ordinal = 5) or v_phase = 'SUDDEN_DEATH'
  ) then
    -- A genuine tie at the deciding challenge (standard or sudden
    -- death) with no resolution above: the Duel continues into a new
    -- sudden-death round that does not exist yet. Only this call
    -- reaches this branch for this ordinal boundary — v_other_has_answered
    -- can only be true for whichever of the two competitors' calls is
    -- second to record a response for p_challenge_ordinal, and the
    -- duels row lock held since this function's own start already
    -- serializes both calls, so no concurrent duplicate insert is
    -- possible.
    if p_next_challenge is null
       or btrim(p_next_challenge ->> 'questionText') = ''
       or (p_next_challenge ->> 'correctAnswer') is null
       or (p_next_challenge ->> 'correctAnswer')::integer < 0
    then
      raise exception 'INVALID_MATH_DUEL_CHALLENGES: a valid next sudden-death challenge is required to continue a tied duel'
        using errcode = 'P0001';
    end if;

    v_next_ordinal := p_challenge_ordinal + 1;
    insert into duel_math_challenges (
      duel_id, challenge_ordinal, phase, question_text, correct_answer, activated_at
    )
    values (
      p_duel_id, v_next_ordinal, 'SUDDEN_DEATH',
      btrim(p_next_challenge ->> 'questionText'),
      (p_next_challenge ->> 'correctAnswer')::integer,
      now()
    );
  end if;

  return query select v_participant_id, p_challenge_ordinal, v_answered_at;
end;
$$;
