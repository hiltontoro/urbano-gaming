-- Migration: 0153_create_session_atomically_registers_room
-- Room Registry Slice 001.
--
-- 0113's own create_session_atomically is not edited as a file —
-- CREATE OR REPLACE, mirroring 0113's own reasoning for reusing it:
-- neither the parameter list nor the return shape changes. The only
-- behavioral addition: every newly created session now also registers
-- a rooms row in the SAME transaction, using the exact p_session_id/
-- p_room_code this function already receives — no new parameter is
-- needed, since the function already has everything a room row
-- requires.
--
-- Ordering is load-bearing, not arbitrary: the sessions insert must
-- happen first because rooms.session_id is a real foreign key and
-- cannot reference a row that does not exist yet. If the rooms insert
-- then fails — most commonly rooms_room_code_unique, because this
-- exact code was already issued to some other runtime, active or
-- historical, a case the pre-existing sessions_room_code_active_unique
-- index cannot see on its own — the whole transaction rolls back,
-- undoing the sessions insert too. This closes the "claimed code but
-- no runtime" / "runtime created but code unreachable" failure modes
-- by construction: both inserts succeed together or neither persists.

create or replace function create_session_atomically(
  p_session_id uuid,
  p_room_code text,
  p_host_token text,
  p_state text,
  p_state_version integer,
  p_pause_reason text,
  p_created_at timestamptz,
  p_updated_at timestamptz,
  p_event_type text,
  p_event_payload jsonb,
  p_predecessor_session_id uuid default null
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  insert into sessions (
    session_id,
    room_code,
    host_token,
    state,
    state_version,
    pause_reason,
    created_at,
    updated_at,
    predecessor_session_id,
    declared_capabilities
  )
  values (
    p_session_id,
    p_room_code,
    p_host_token,
    p_state,
    p_state_version,
    p_pause_reason,
    p_created_at,
    p_updated_at,
    p_predecessor_session_id,
    array[]::text[]
  );

  insert into session_events (
    session_id,
    event_type,
    payload
  )
  values (
    p_session_id,
    p_event_type,
    p_event_payload
  );

  insert into rooms (
    room_code,
    session_id
  )
  values (
    p_room_code,
    p_session_id
  );
end;
$$;
