-- Migration: 0149_resolve_duel_atomically_awards_points
-- Ordinary Duel Session Scoring Slice 001.
--
-- Replaces 0131's own resolve_duel_atomically. Signature and RETURNS
-- TABLE shape are both unchanged, so CREATE OR REPLACE is safe here
-- (0027's own precedent). The only behavioral change: on a WON_LOST
-- resolution, the winner is awarded duels.winner_points in the same
-- transaction as the terminal state transition — the Founder-approved
-- policy (WON_LOST: winner +10, everything else: no award). DRAW,
-- VOID never reach this insert — both are genuinely reachable outcomes
-- of this function's own truth table (see 0131's own comment), and
-- neither branch is touched.
--
-- Idempotency: a single per-Duel scoring namespace,
-- md5('duel-score:' || duel_id::text)::uuid, shared by every terminal
-- path that can ever award this Duel (this function, the exceptional-
-- resolution function, and Math Duel's own automatic resolution).
-- Deliberately not two separate win/forfeit-prefixed keys — a Duel can
-- have at most one authoritative scoring consequence, ever (enforced
-- by the lifecycle_state <> 'ACTIVE' guard already preventing
-- re-resolution), so collapsing the key to duel_id alone makes a
-- second award for the same Duel a database-constraint-level
-- impossibility, not merely a consequence of the calling branches'
-- own mutual exclusivity. This is strictly stronger than a two-prefix
-- design and is defense-in-depth on top of the lock discipline 0131's
-- own comment already documents — a duplicate/retried call never even
-- reaches this insert, since it is rejected earlier by the
-- DUEL_ALREADY_RESOLVED guard.

create or replace function resolve_duel_atomically(
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
  v_winner_points integer;
  v_a_selected integer;
  v_a_answered_at timestamptz;
  v_b_selected integer;
  v_b_answered_at timestamptz;
  v_a_correct boolean;
  v_b_correct boolean;
  v_resolution text;
  v_winner uuid;
  v_ended_at timestamptz;
  v_point_award_id uuid;
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
         duels.competitor_b_participant_id, duels.correct_option_index,
         duels.winner_points
    into v_lifecycle_state, v_competitor_a, v_competitor_b, v_correct_option_index,
         v_winner_points
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

  if v_resolution = 'WON_LOST' then
    insert into point_awards (session_id, duel_id, participant_id, points, idempotency_key)
    values (
      v_session_id, p_duel_id, v_winner, v_winner_points,
      md5('duel-score:' || p_duel_id::text)::uuid
    )
    on conflict (session_id, idempotency_key) do nothing
    returning point_awards.point_award_id into v_point_award_id;

    if v_point_award_id is not null then
      insert into session_events (session_id, event_type, payload)
      values (
        v_session_id,
        'POINTS_AWARDED',
        jsonb_build_object(
          'pointAwardId', v_point_award_id,
          'duelId', p_duel_id,
          'participantId', v_winner,
          'points', v_winner_points
        )
      );
    end if;
  end if;

  return query select p_duel_id, 'COMPLETED'::text, v_resolution, v_winner;
end;
$$;
