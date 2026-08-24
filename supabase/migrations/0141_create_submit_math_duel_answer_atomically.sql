-- Migration: 0141_create_submit_math_duel_answer_atomically
-- Math Duel Slice 001.
--
-- SUBMIT_MATH_DUEL_ANSWER's atomic operation — records one answer and,
-- when the answer just recorded is the one that completes a shared
-- condition, performs normal resolution inline. Deliberately does NOT
-- call resolve_duel_atomically (0131): that function is Host-token-
-- authenticated and reads correct_option_index/selected_option_index
-- directly, both Multiple-Choice-specific — genuinely incompatible
-- authority models and content shapes, not merely a missed abstraction
-- opportunity. See MATH_DUEL_IMPLEMENTATION_RECORD.md's own
-- reconsideration of the generic-terminalization deferral.
--
-- Implementation-time simplification over the readiness gate's own
-- sketch: start_math_duel_atomically (0140) pre-materializes every
-- challenge this Duel could need — standard phase and a full sudden-
-- death supply — as immutable rows, all at Duel creation. This
-- function therefore never creates a new duel_math_challenges row;
-- "entering sudden death" is not a write at all, only a read of
-- whichever pre-existing row a participant's own answered-count
-- naturally advances them to. The only state this function ever
-- mutates is duel_math_responses (always) and duels (only at the
-- exact moment a real winner, or the honest challenge-exhaustion
-- edge case, is determined).
--
-- First-write-wins: p_challenge_ordinal less than the caller's own
-- next-expected ordinal is treated as a retry of an already-answered
-- challenge — the existing row is returned unconditionally, the
-- supplied answer is never compared or applied, and no resolution
-- check runs a second time. Greater than expected is rejected outright
-- (out-of-order/future-ordinal submission).
--
-- Lock order: sessions row FOR UPDATE, then the duels row FOR UPDATE —
-- identical to 0131/0132's own already-proven, deadlock-avoiding
-- order (this function may insert into session_events on the terminal
-- path, taking the same implicit FOR KEY SHARE on sessions those
-- functions' own comments describe). The duels-row lock serializes
-- every call for one Duel regardless of which competitor or which
-- ordinal, which is what makes the "did both now answer this ordinal"
-- check race-free without any finer-grained locking.

create function submit_math_duel_answer_atomically(
  p_duel_id uuid,
  p_participant_token text,
  p_challenge_ordinal integer,
  p_submitted_answer integer
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
begin
  select duels.session_id into v_session_id
  from duels
  where duels.duel_id = p_duel_id;

  if v_session_id is null then
    raise exception 'DUEL_NOT_FOUND: no duel exists for this duel_id'
      using errcode = 'P0001';
  end if;

  -- Pre-lock the parent session first, matching 0131/0132's own
  -- deadlock-avoiding order, even though this function never reads or
  -- writes a sessions column directly — the session_events insert on
  -- the terminal path below takes an implicit lock on this row via its
  -- foreign key regardless.
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
    -- Idempotent retry of an already-answered challenge: the first
    -- successful write is authoritative forever, regardless of what
    -- this retry's own p_submitted_answer says.
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

  -- A competitor who independently finishes the standard phase first
  -- must not be authorized into sudden-death territory (ordinal 6+)
  -- until the OTHER competitor has also finished all 5 standard
  -- challenges — otherwise a fast competitor could pre-answer a
  -- sudden-death round that turns out never to be needed (the
  -- standard phase decided the Duel outright), leaving an orphaned,
  -- one-sided response that would misleadingly appear in the terminal
  -- reveal. If both have genuinely finished 1-5 and the Duel is still
  -- ACTIVE at this point, the standard phase must have been a tie —
  -- any decisive (non-tied) outcome already transitioned the Duel to
  -- COMPLETED the moment the second competitor finished ordinal 5,
  -- which the ACTIVE check at the top of this function already
  -- enforces; no separate tie recomputation is needed here.
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
      -- Equal counts: no resolution yet — the Duel continues into
      -- whichever pre-materialized sudden-death challenge ordinal 6
      -- already is. Nothing to create, nothing to write here.

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
      -- Both correct or both wrong: another tied round — again, no
      -- write here; the next pre-materialized ordinal already exists.
    end if;
    -- STANDARD phase with ordinal < 5 and both answered: no transition
    -- yet, more standard challenges remain — nothing to do.
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
  end if;

  return query select v_participant_id, p_challenge_ordinal, v_answered_at;
end;
$$;
