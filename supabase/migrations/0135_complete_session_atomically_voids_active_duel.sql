-- Migration: 0135_complete_session_atomically_voids_active_duel
-- Duel / SESSION_SUBGAME v1.
--
-- 0013's own complete_session_atomically is not edited as a file —
-- create-or-replace, the same precedent as every prior replacement of
-- this function. The only behavioral change: if this Session has an
-- active Duel at the moment of completion, that Duel is resolved VOID
-- in the same atomic transaction — Duel_Architecture.md's own
-- "Interaction With Session Completion" section: Host-controlled
-- completion remains fully authoritative and is never blocked by a
-- subordinate Duel's runtime state; the Duel is superseded, never
-- fabricated a winner, and its partial response history (duel_
-- responses) is preserved unchanged. No new parameter — the voiding is
-- an internal side effect, not something a caller opts into.
--
-- One transaction, one session-row lock already held by the existing
-- `for update` below: this closes the exact race the implementation-
-- readiness gate named (COMPLETE_SESSION racing a Duel's own normal or
-- exceptional resolution) by construction — whichever RPC's `for
-- update` on the session/duel row commits first wins; the other sees
-- a state that no longer permits its own transition and raises its own
-- already-existing error. Everything else is byte-for-byte unchanged
-- from 0013.

create or replace function complete_session_atomically(
  p_session_id uuid,
  p_host_token text,
  p_event_type text,
  p_event_payload jsonb
)
returns table (state text, state_version integer)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_state text;
  v_state_version integer;
  v_host_token text;
  v_active_duel_id uuid;
begin
  select sessions.state, sessions.state_version, sessions.host_token
    into v_state, v_state_version, v_host_token
  from sessions
  where sessions.session_id = p_session_id
  for update;

  if v_state is null then
    raise exception 'SESSION_NOT_FOUND: no session exists for this session_id'
      using errcode = 'P0001';
  end if;

  if v_host_token <> p_host_token then
    raise exception 'HOST_TOKEN_MISMATCH: supplied host token does not match this session'
      using errcode = 'P0001';
  end if;

  if v_state = 'SESSION_COMPLETE' then
    raise exception 'SESSION_ALREADY_COMPLETE: session is already complete'
      using errcode = 'P0001';
  end if;

  update sessions
  set state = 'SESSION_COMPLETE',
      state_version = v_state_version + 1,
      updated_at = now()
  where session_id = p_session_id;

  select duels.duel_id into v_active_duel_id
  from duels
  where duels.session_id = p_session_id
    and duels.lifecycle_state = 'ACTIVE'
  for update;

  if v_active_duel_id is not null then
    update duels
       set lifecycle_state = 'COMPLETED',
           terminal_resolution = 'VOID',
           winner_participant_id = null,
           reason = 'Session completed while Duel was active',
           ended_at = now()
     where duels.duel_id = v_active_duel_id;

    insert into session_events (session_id, event_type, payload)
    values (
      p_session_id,
      'DUEL_RESOLVED',
      jsonb_build_object(
        'duelId', v_active_duel_id,
        'terminalResolution', 'VOID',
        'winnerParticipantId', null,
        'reason', 'Session completed while Duel was active'
      )
    );
  end if;

  insert into session_events (session_id, event_type, payload)
  values (p_session_id, p_event_type, p_event_payload);

  return query select 'SESSION_COMPLETE'::text, v_state_version + 1;
end;
$$;
