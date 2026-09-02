-- Migration: 0172_create_claim_pulse_timeout_atomically
-- URBANO Pulse Slice 001 (UG-CR-GATE-002). CLAIM_TIMEOUT's atomic
-- operation — the CLOSE_QUIZ pattern applied to Pulse's own 60-second
-- turn deadline: dual-authority (either competitor may call this,
-- mirroring CLOSE_QUIZ's "any participant may trigger automatic
-- expiry"), lazy (no background job — enactable only once now() has
-- genuinely passed the server-authoritative deadline, re-verified
-- here, never trusted from the caller), and idempotent by construction
-- (if the duel is already COMPLETED, the cached terminal facts are
-- simply returned rather than re-resolving).
--
-- Deliberately not folded into apply_pulse_target_atomically as a
-- side effect: a distinct, explicit action means the non-timed-out
-- competitor can always actively claim the win even if the timed-out
-- competitor never sends another request at all — the same reason
-- CLOSE_QUIZ is its own dedicated command rather than a passive
-- side effect of some other call.

create function claim_pulse_timeout_atomically(
  p_duel_id uuid,
  p_participant_token text
)
returns table (
  terminal boolean,
  terminal_resolution text,
  winner_participant_id uuid,
  already_applied boolean
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_participant_id uuid;
  v_token_session_id uuid;
  v_session_id uuid;
  v_mechanic_key text;
  v_lifecycle_state text;
  v_terminal_resolution text;
  v_winner_participant_id uuid;
  v_competitor_a uuid;
  v_competitor_b uuid;
  v_winner_points integer;
  v_current_actor uuid;
  v_current_deadline timestamptz;
  v_point_award_id uuid;
begin
  select participants.participant_id, participants.session_id
    into v_participant_id, v_token_session_id
  from participants
  where participants.participant_token = p_participant_token;

  if v_participant_id is null then
    raise exception 'PULSE_ACCESS_DENIED: invalid participant token'
      using errcode = 'P0001';
  end if;

  select duels.session_id, duels.mechanic_key, duels.lifecycle_state, duels.terminal_resolution,
         duels.winner_participant_id, duels.competitor_a_participant_id, duels.competitor_b_participant_id,
         duels.winner_points
    into v_session_id, v_mechanic_key, v_lifecycle_state, v_terminal_resolution,
         v_winner_participant_id, v_competitor_a, v_competitor_b, v_winner_points
  from duels
  where duels.duel_id = p_duel_id
  for update;

  if v_session_id is null or v_mechanic_key <> 'PULSE' then
    raise exception 'PULSE_NOT_FOUND: no pulse duel exists for this id'
      using errcode = 'P0001';
  end if;
  if v_session_id <> v_token_session_id
     or (v_participant_id <> v_competitor_a and v_participant_id <> v_competitor_b) then
    raise exception 'PULSE_ACCESS_DENIED: participant is not a competitor in this duel'
      using errcode = 'P0001';
  end if;

  if v_lifecycle_state = 'COMPLETED' then
    return query select true, v_terminal_resolution, v_winner_participant_id, true;
    return;
  end if;

  select pulse_games.current_actor_participant_id, pulse_games.current_deadline
    into v_current_actor, v_current_deadline
  from pulse_games
  where pulse_games.duel_id = p_duel_id
  for update;

  if v_current_actor is null or v_current_deadline is null then
    raise exception 'PULSE_NOT_ACTIVE: there is no active turn to expire'
      using errcode = 'P0001';
  end if;

  if now() < v_current_deadline then
    raise exception 'PULSE_TURN_NOT_EXPIRED: the active turn deadline has not passed yet'
      using errcode = 'P0001';
  end if;

  v_winner_participant_id := case when v_current_actor = v_competitor_a then v_competitor_b else v_competitor_a end;

  update duels
  set lifecycle_state = 'COMPLETED', terminal_resolution = 'FORFEIT',
      winner_participant_id = v_winner_participant_id, ended_at = now()
  where duels.duel_id = p_duel_id;

  update pulse_games
  set completed_at = now(), current_actor_participant_id = null, current_deadline = null
  where pulse_games.duel_id = p_duel_id;

  insert into session_events (session_id, event_type, payload)
  values (v_session_id, 'DUEL_RESOLVED', jsonb_build_object(
    'duelId', p_duel_id, 'terminalResolution', 'FORFEIT', 'winnerParticipantId', v_winner_participant_id));

  insert into point_awards (session_id, duel_id, participant_id, points, idempotency_key)
  values (v_session_id, p_duel_id, v_winner_participant_id, v_winner_points, md5('duel-score:' || p_duel_id::text)::uuid)
  on conflict (session_id, idempotency_key) do nothing
  returning point_awards.point_award_id into v_point_award_id;

  if v_point_award_id is not null then
    insert into session_events (session_id, event_type, payload)
    values (v_session_id, 'POINTS_AWARDED', jsonb_build_object(
      'pointAwardId', v_point_award_id, 'duelId', p_duel_id,
      'participantId', v_winner_participant_id, 'points', v_winner_points));
  end if;

  return query select true, 'FORFEIT'::text, v_winner_participant_id, false;
end;
$$;
