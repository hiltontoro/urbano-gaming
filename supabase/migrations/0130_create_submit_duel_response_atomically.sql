-- Migration: 0130_create_submit_duel_response_atomically
-- Duel / SESSION_SUBGAME v1.
--
-- SUBMIT_DUEL_RESPONSE's atomic operation. Participant-token authority
-- only, mirroring submit_response_atomically's own precedent — no host
-- fallback. Only the Duel's own two bound competitors may submit;
-- every other Session participant (including a non-competitor host)
-- is rejected identically to a stranger. "Last write wins" on retry,
-- the same MVP decision submit_response_atomically already made for
-- ordinary submissions — the primary key on duel_responses (0128)
-- makes this an upsert, not application-level branching.

create function submit_duel_response_atomically(
  p_duel_id uuid,
  p_participant_token text,
  p_selected_option_index integer
)
returns table (
  participant_id uuid,
  answered_at timestamptz
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_session_id uuid;
  v_lifecycle_state text;
  v_competitor_a uuid;
  v_competitor_b uuid;
  v_options jsonb;
  v_participant_id uuid;
  v_answered_at timestamptz;
begin
  select duels.session_id, duels.lifecycle_state, duels.competitor_a_participant_id,
         duels.competitor_b_participant_id, duels.options
    into v_session_id, v_lifecycle_state, v_competitor_a, v_competitor_b, v_options
  from duels
  where duels.duel_id = p_duel_id
  for update;

  if v_session_id is null then
    raise exception 'DUEL_NOT_FOUND: no duel exists for this duel_id'
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

  if p_selected_option_index is null
     or p_selected_option_index < 0
     or p_selected_option_index >= jsonb_array_length(v_options) then
    raise exception 'INVALID_DUEL_OPTION_SELECTION: must be a valid option index for this duel'
      using errcode = 'P0001';
  end if;

  v_answered_at := now();

  insert into duel_responses (duel_id, participant_id, selected_option_index, answered_at)
  values (p_duel_id, v_participant_id, p_selected_option_index, v_answered_at)
  on conflict (duel_id, participant_id)
  do update set selected_option_index = excluded.selected_option_index,
                answered_at = excluded.answered_at;

  return query select v_participant_id, v_answered_at;
end;
$$;
