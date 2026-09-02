-- Migration: 0171_create_apply_pulse_target_atomically
-- URBANO Pulse Slice 001 (UG-CR-GATE-002). TARGET_CELL's atomic
-- operation.
--
-- Idempotency is checked FIRST, before lifecycle/turn revalidation —
-- the mandatory Towers lesson (a completing-target retry must return
-- the original result rather than being rejected because the duel is
-- no longer ACTIVE).
--
-- pulse_games is the single row-locked serialization point for turn
-- authority, mirroring rutas_attempts/towers_attempts. The deadline
-- race is resolved under that same lock: if the deadline has already
-- passed when this call acquires the lock, the target is rejected
-- (PULSE_TURN_EXPIRED) without mutating anything — resolution itself
-- happens only via the dedicated claim_pulse_timeout_atomically (0172),
-- the CLOSE_QUIZ pattern applied here: a lazy, dual-authority,
-- explicit action, never a background job, never enacted as a silent
-- side effect of an unrelated call.
--
-- Completed-form and terminal detection both read this attacker's own
-- accumulated pulse_actions history (including the row this call is
-- about to insert) — never the defender's own hit/miss state, which
-- is irrelevant to whether the attacker has now cleared a form or the
-- whole board.

create function apply_pulse_target_atomically(
  p_duel_id uuid,
  p_participant_token text,
  p_row integer,
  p_col integer,
  p_idempotency_key text
)
returns table (
  result text,
  completed_form_id text,
  terminal boolean,
  winner_participant_id uuid,
  next_actor_participant_id uuid,
  next_deadline timestamptz,
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
  v_existing pulse_actions%rowtype;
  v_current_actor uuid;
  v_current_deadline timestamptz;
  v_opponent uuid;
  v_opponent_forms jsonb;
  v_form jsonb;
  v_matched_form jsonb;
  v_result text;
  v_hit_form_id text;
  v_completed_form_id text;
  v_next_seq integer;
  v_form_cell_count integer;
  v_hit_cell_count integer;
  v_all_forms_cleared boolean;
  v_next_actor uuid;
  v_next_deadline timestamptz;
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

  select * into v_existing from pulse_actions
  where pulse_actions.duel_id = p_duel_id and pulse_actions.idempotency_key = p_idempotency_key;

  if found then
    select pulse_games.current_actor_participant_id, pulse_games.current_deadline
      into v_next_actor, v_next_deadline
    from pulse_games where pulse_games.duel_id = p_duel_id;

    return query select v_existing.result, v_existing.completed_form_id,
      (v_lifecycle_state = 'COMPLETED'), v_winner_participant_id,
      v_next_actor, v_next_deadline, true;
    return;
  end if;

  if v_lifecycle_state <> 'ACTIVE' then
    raise exception 'PULSE_NOT_ACTIVE: this pulse duel is not active'
      using errcode = 'P0001';
  end if;

  select pulse_games.current_actor_participant_id, pulse_games.current_deadline
    into v_current_actor, v_current_deadline
  from pulse_games
  where pulse_games.duel_id = p_duel_id
  for update;

  if v_current_actor is null then
    raise exception 'PULSE_NOT_ACTIVE: setup is not yet complete'
      using errcode = 'P0001';
  end if;

  if now() >= v_current_deadline then
    raise exception 'PULSE_TURN_EXPIRED: the active turn deadline has passed; claim the timeout to resolve'
      using errcode = 'P0001';
  end if;

  if v_participant_id <> v_current_actor then
    raise exception 'PULSE_NOT_YOUR_TURN: it is not your turn'
      using errcode = 'P0001';
  end if;

  if p_row < 0 or p_row > 7 or p_col < 0 or p_col > 7 then
    raise exception 'PULSE_TARGET_OUT_OF_BOUNDS: coordinate is out of bounds'
      using errcode = 'P0001';
  end if;

  if exists (
    select 1 from pulse_actions
    where pulse_actions.duel_id = p_duel_id
      and pulse_actions.actor_participant_id = v_participant_id
      and pulse_actions.cell_row = p_row
      and pulse_actions.cell_col = p_col
  ) then
    raise exception 'PULSE_CELL_ALREADY_TARGETED: this coordinate has already been targeted'
      using errcode = 'P0001';
  end if;

  v_opponent := case when v_participant_id = v_competitor_a then v_competitor_b else v_competitor_a end;

  select pulse_boards.forms into v_opponent_forms
  from pulse_boards
  where pulse_boards.duel_id = p_duel_id and pulse_boards.participant_id = v_opponent;

  v_result := 'MISS';
  v_hit_form_id := null;
  for v_form in select * from jsonb_array_elements(v_opponent_forms) loop
    if exists (
      select 1 from jsonb_array_elements(v_form -> 'cells') c
      where (c ->> 'row')::integer = p_row and (c ->> 'col')::integer = p_col
    ) then
      v_result := 'HIT';
      v_hit_form_id := v_form ->> 'formId';
      exit;
    end if;
  end loop;

  select coalesce(max(pulse_actions.sequence_number), 0) + 1 into v_next_seq
  from pulse_actions where pulse_actions.duel_id = p_duel_id;

  v_completed_form_id := null;

  if v_result = 'HIT' then
    select f into v_matched_form
    from jsonb_array_elements(v_opponent_forms) f
    where f ->> 'formId' = v_hit_form_id;

    v_form_cell_count := jsonb_array_length(v_matched_form -> 'cells');

    select count(*) into v_hit_cell_count
    from jsonb_array_elements(v_matched_form -> 'cells') c
    where ((c ->> 'row')::integer = p_row and (c ->> 'col')::integer = p_col)
       or exists (
         select 1 from pulse_actions
         where pulse_actions.duel_id = p_duel_id
           and pulse_actions.actor_participant_id = v_participant_id
           and pulse_actions.cell_row = (c ->> 'row')::integer
           and pulse_actions.cell_col = (c ->> 'col')::integer
       );

    if v_hit_cell_count = v_form_cell_count then
      v_completed_form_id := v_hit_form_id;
      v_result := 'HIT_COMPLETED_FORM';
    end if;
  end if;

  insert into pulse_actions (
    duel_id, sequence_number, actor_participant_id, cell_row, cell_col, result, completed_form_id, idempotency_key
  ) values (
    p_duel_id, v_next_seq, v_participant_id, p_row, p_col, v_result, v_completed_form_id, p_idempotency_key
  );

  select not exists (
    select 1
    from jsonb_array_elements(v_opponent_forms) f, jsonb_array_elements(f -> 'cells') c
    where not exists (
      select 1 from pulse_actions
      where pulse_actions.duel_id = p_duel_id
        and pulse_actions.actor_participant_id = v_participant_id
        and pulse_actions.cell_row = (c ->> 'row')::integer
        and pulse_actions.cell_col = (c ->> 'col')::integer
    )
  ) into v_all_forms_cleared;

  if v_participant_id = v_competitor_a then
    update pulse_games set target_count_a = pulse_games.target_count_a + 1 where pulse_games.duel_id = p_duel_id;
  else
    update pulse_games set target_count_b = pulse_games.target_count_b + 1 where pulse_games.duel_id = p_duel_id;
  end if;

  if v_all_forms_cleared then
    update duels
    set lifecycle_state = 'COMPLETED', terminal_resolution = 'WON_LOST',
        winner_participant_id = v_participant_id, ended_at = now()
    where duels.duel_id = p_duel_id;

    update pulse_games
    set completed_at = now(), current_actor_participant_id = null, current_deadline = null
    where pulse_games.duel_id = p_duel_id;

    insert into session_events (session_id, event_type, payload)
    values (v_session_id, 'DUEL_RESOLVED', jsonb_build_object(
      'duelId', p_duel_id, 'terminalResolution', 'WON_LOST', 'winnerParticipantId', v_participant_id));

    insert into point_awards (session_id, duel_id, participant_id, points, idempotency_key)
    values (v_session_id, p_duel_id, v_participant_id, v_winner_points, md5('duel-score:' || p_duel_id::text)::uuid)
    on conflict (session_id, idempotency_key) do nothing
    returning point_awards.point_award_id into v_point_award_id;

    if v_point_award_id is not null then
      insert into session_events (session_id, event_type, payload)
      values (v_session_id, 'POINTS_AWARDED', jsonb_build_object(
        'pointAwardId', v_point_award_id, 'duelId', p_duel_id,
        'participantId', v_participant_id, 'points', v_winner_points));
    end if;

    return query select v_result, v_completed_form_id, true, v_participant_id, null::uuid, null::timestamptz, false;
    return;
  end if;

  v_next_actor := v_opponent;
  v_next_deadline := now() + interval '60 seconds';

  update pulse_games
  set current_actor_participant_id = v_next_actor, current_deadline = v_next_deadline
  where pulse_games.duel_id = p_duel_id;

  return query select v_result, v_completed_form_id, false, null::uuid, v_next_actor, v_next_deadline, false;
end;
$$;
