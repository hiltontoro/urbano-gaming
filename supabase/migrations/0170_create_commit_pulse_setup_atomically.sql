-- Migration: 0170_create_commit_pulse_setup_atomically
-- URBANO Pulse Slice 001 (UG-CR-GATE-002). COMMIT_SETUP's atomic
-- operation. The duels row is locked FIRST and held for the whole
-- transaction, which is what actually serializes two near-simultaneous
-- commits against the same Duel (both callers' first lock acquisition
-- is the same row) — the second caller's transaction cannot even begin
-- reading pulse_boards until the first has committed, so "does the
-- opponent's board already show committed_at" is always answered
-- truthfully, never racily.
--
-- Idempotency is checked against THIS competitor's own pulse_boards
-- row before any validation: a repeat call with the same
-- commit_idempotency_key returns the original result (including
-- whether it was the activating commit); a repeat call with a
-- different key against an already-committed board is a genuine
-- second, rejected commit attempt, since setup has no legitimate
-- "retry with different content" case once committed.
--
-- Activation — coin flip, current_actor_participant_id, current_
-- deadline (60s per UG-CR-REV-001's Founder correction), started_at —
-- all happen in this same transaction as the second commit, never as a
-- separate step, so activation can never be observed as "half done."

create function commit_pulse_setup_atomically(
  p_duel_id uuid,
  p_participant_token text,
  p_forms jsonb,
  p_was_assisted boolean,
  p_idempotency_key text
)
returns table (
  participant_id uuid,
  committed_at timestamptz,
  activated boolean,
  current_actor_participant_id uuid,
  current_deadline timestamptz,
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
  v_duel_session_id uuid;
  v_mechanic_key text;
  v_duel_lifecycle text;
  v_competitor_a uuid;
  v_competitor_b uuid;
  v_my_committed_at timestamptz;
  v_my_key text;
  v_opponent_participant_id uuid;
  v_opponent_committed_at timestamptz;
  v_activated boolean := false;
  v_actor uuid;
  v_deadline timestamptz;
begin
  select participants.participant_id, participants.session_id
    into v_participant_id, v_token_session_id
  from participants
  where participants.participant_token = p_participant_token;

  if v_participant_id is null then
    raise exception 'PULSE_ACCESS_DENIED: invalid participant token'
      using errcode = 'P0001';
  end if;

  select duels.session_id, duels.mechanic_key, duels.lifecycle_state,
         duels.competitor_a_participant_id, duels.competitor_b_participant_id
    into v_duel_session_id, v_mechanic_key, v_duel_lifecycle, v_competitor_a, v_competitor_b
  from duels
  where duels.duel_id = p_duel_id
  for update;

  if v_duel_session_id is null or v_mechanic_key <> 'PULSE' then
    raise exception 'PULSE_NOT_FOUND: no pulse duel exists for this id'
      using errcode = 'P0001';
  end if;
  if v_duel_session_id <> v_token_session_id
     or (v_participant_id <> v_competitor_a and v_participant_id <> v_competitor_b) then
    raise exception 'PULSE_ACCESS_DENIED: participant is not a competitor in this duel'
      using errcode = 'P0001';
  end if;
  if v_duel_lifecycle <> 'ACTIVE' then
    raise exception 'PULSE_NOT_ACTIVE: this pulse duel is not active'
      using errcode = 'P0001';
  end if;

  select pulse_boards.committed_at, pulse_boards.commit_idempotency_key
    into v_my_committed_at, v_my_key
  from pulse_boards
  where pulse_boards.duel_id = p_duel_id and pulse_boards.participant_id = v_participant_id
  for update;

  if v_my_committed_at is not null then
    if v_my_key = p_idempotency_key then
      select pulse_games.current_actor_participant_id, pulse_games.current_deadline
        into v_actor, v_deadline
      from pulse_games
      where pulse_games.duel_id = p_duel_id;

      return query select v_participant_id, v_my_committed_at, (v_actor is not null), v_actor, v_deadline, true;
      return;
    else
      raise exception 'PULSE_SETUP_ALREADY_COMMITTED: this competitor has already committed a layout'
        using errcode = 'P0001';
    end if;
  end if;

  if not pulse_forms_are_valid(p_forms) then
    raise exception 'PULSE_INVALID_SETUP: the submitted layout is not a valid arrangement'
      using errcode = 'P0001';
  end if;

  update pulse_boards
  set forms = p_forms,
      was_assisted = p_was_assisted,
      committed_at = now(),
      commit_idempotency_key = p_idempotency_key
  where pulse_boards.duel_id = p_duel_id and pulse_boards.participant_id = v_participant_id;

  v_opponent_participant_id := case when v_participant_id = v_competitor_a then v_competitor_b else v_competitor_a end;

  select pulse_boards.committed_at into v_opponent_committed_at
  from pulse_boards
  where pulse_boards.duel_id = p_duel_id and pulse_boards.participant_id = v_opponent_participant_id
  for update;

  if v_opponent_committed_at is not null then
    v_activated := true;
    v_actor := case when random() < 0.5 then v_competitor_a else v_competitor_b end;
    v_deadline := now() + interval '60 seconds';

    update pulse_games
    set current_actor_participant_id = v_actor,
        current_deadline = v_deadline,
        started_at = now()
    where pulse_games.duel_id = p_duel_id;

    insert into session_events (session_id, event_type, payload)
    values (
      v_token_session_id,
      'PULSE_ACTIVATED',
      jsonb_build_object('duelId', p_duel_id, 'currentActorParticipantId', v_actor)
    );
  end if;

  return query select v_participant_id, now(), v_activated, v_actor, v_deadline, false;
end;
$$;
