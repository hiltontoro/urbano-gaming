-- Migration: 0131_create_resolve_duel_atomically
-- Duel / SESSION_SUBGAME v1.
--
-- RESOLVE_DUEL's atomic operation — the normal, mechanic-derived
-- resolution path. Host-triggered pacing, mirroring close_submissions_
-- atomically's own precedent exactly: no timer, no background job, the
-- Host decides when to close. Deterministic winner logic, precise
-- about every combination the implementation-readiness gate named
-- rather than inventing a coin-flip for the ambiguous cases:
--
--   both responded, exactly one correct  -> that competitor wins
--   both responded, both correct         -> earlier answered_at wins;
--                                            an exact tie is DRAW
--   both responded, both wrong           -> DRAW (both tried, both failed)
--   exactly one responded, correct       -> that competitor wins
--     (uncontested correct answer beats no answer at all)
--   exactly one responded, wrong         -> VOID (the one answer given
--     was wrong; nothing was meaningfully decided)
--   neither responded                    -> VOID
--
-- Never fabricates a winner. Duel_Architecture.md's own "mechanic-
-- derived result" tier: once computed here, the Host does not
-- separately get to override it — a different, exceptional path
-- (0132) exists for stalled/disputed cases, and never touches an
-- already-COMPLETED Duel.
--
-- Lock order: sessions row FOR UPDATE, then duels row FOR UPDATE —
-- matching start_duel_atomically / start_session_atomically /
-- start_quiz_atomically / complete_session_atomically exactly. An
-- earlier version of this function locked duels first and only
-- plain-SELECTed sessions, which is correct in isolation but deadlocks
-- (Postgres 40P01) against complete_session_atomically under genuine
-- concurrency: that function locks sessions then duels, while this
-- one's later `insert into session_events` implicitly takes a FOR KEY
-- SHARE lock on the parent sessions row (the FK from session_events to
-- sessions) — session-then-duels order for every function touching
-- both rows is what avoids the cycle. Proven by
-- duelSupabaseRepository.contract.test.ts's own concurrent RESOLVE_
-- DUEL-vs-COMPLETE_SESSION scenario. A lightweight, non-locking
-- pre-read of session_id from duels is safe here — duel_id and
-- session_id are immutable for the lifetime of a Duel row — purely to
-- discover which sessions row to lock first, before the authoritative
-- locked read below.

create function resolve_duel_atomically(
  p_duel_id uuid,
  p_host_token text
)
returns table (
  duel_id uuid,
  lifecycle_state text,
  terminal_resolution text,
  winner_participant_id uuid
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_session_id uuid;
  v_host_token text;
  v_lifecycle_state text;
  v_competitor_a uuid;
  v_competitor_b uuid;
  v_correct_option_index integer;
  v_a_selected integer;
  v_a_answered_at timestamptz;
  v_b_selected integer;
  v_b_answered_at timestamptz;
  v_a_correct boolean;
  v_b_correct boolean;
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

  select sessions.host_token into v_host_token
  from sessions
  where sessions.session_id = v_session_id
  for update;

  if v_host_token <> p_host_token then
    raise exception 'HOST_TOKEN_MISMATCH: supplied host token does not match this session'
      using errcode = 'P0001';
  end if;

  select duels.lifecycle_state, duels.competitor_a_participant_id,
         duels.competitor_b_participant_id, duels.correct_option_index
    into v_lifecycle_state, v_competitor_a, v_competitor_b, v_correct_option_index
  from duels
  where duels.duel_id = p_duel_id
  for update;

  if v_lifecycle_state <> 'ACTIVE' then
    raise exception 'DUEL_ALREADY_RESOLVED: duel is in % state, not ACTIVE', v_lifecycle_state
      using errcode = 'P0001';
  end if;

  select duel_responses.selected_option_index, duel_responses.answered_at
    into v_a_selected, v_a_answered_at
  from duel_responses
  where duel_responses.duel_id = p_duel_id
    and duel_responses.participant_id = v_competitor_a;

  select duel_responses.selected_option_index, duel_responses.answered_at
    into v_b_selected, v_b_answered_at
  from duel_responses
  where duel_responses.duel_id = p_duel_id
    and duel_responses.participant_id = v_competitor_b;

  v_a_correct := v_a_selected is not null and v_a_selected = v_correct_option_index;
  v_b_correct := v_b_selected is not null and v_b_selected = v_correct_option_index;

  if v_a_selected is not null and v_b_selected is not null then
    if v_a_correct and not v_b_correct then
      v_resolution := 'WON_LOST';
      v_winner := v_competitor_a;
    elsif v_b_correct and not v_a_correct then
      v_resolution := 'WON_LOST';
      v_winner := v_competitor_b;
    elsif v_a_correct and v_b_correct then
      if v_a_answered_at < v_b_answered_at then
        v_resolution := 'WON_LOST';
        v_winner := v_competitor_a;
      elsif v_b_answered_at < v_a_answered_at then
        v_resolution := 'WON_LOST';
        v_winner := v_competitor_b;
      else
        v_resolution := 'DRAW';
        v_winner := null;
      end if;
    else
      v_resolution := 'DRAW';
      v_winner := null;
    end if;
  elsif v_a_selected is not null and v_a_correct then
    v_resolution := 'WON_LOST';
    v_winner := v_competitor_a;
  elsif v_b_selected is not null and v_b_correct then
    v_resolution := 'WON_LOST';
    v_winner := v_competitor_b;
  else
    v_resolution := 'VOID';
    v_winner := null;
  end if;

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

  return query select p_duel_id, 'COMPLETED'::text, v_resolution, v_winner;
end;
$$;
