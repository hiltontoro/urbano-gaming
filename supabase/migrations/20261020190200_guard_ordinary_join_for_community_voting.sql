-- Migration: 20261020190200_guard_ordinary_join_for_community_voting
-- UG-IV-GATE-002 — Community Voting local foundation (Design B1).
--
-- Adds the authoritative database guard that keeps ordinary joining out of an
-- event-bound Session. Route-only enforcement would be insufficient: join_participant_atomically
-- is executable by PUBLIC, anon and authenticated (an inherited default that predates this
-- work and is deliberately NOT changed here), so the guard has to live inside it.
--
-- ---------------------------------------------------------------------------------------
-- Why the check is a SECURITY DEFINER helper rather than an inline EXISTS
-- ---------------------------------------------------------------------------------------
-- join_participant_atomically is `security invoker`, and the Community Voting tables are
-- (correctly) closed to anon and authenticated. An inline `exists (select ... from
-- community_voting_instances)` would therefore run with the CALLER's privileges, and for a
-- browser role it would either fail with a permission error on every Session (a behaviour
-- change for ordinary joins) or — had anon been granted SELECT to cure that — see ZERO rows
-- through row-level security and silently BYPASS the guard. Neither is acceptable. The helper
-- below evaluates one boolean as the table owner, so the guard answers the same question for
-- every caller. It is the single, deliberate `security definer` exception in this work:
-- fixed search_path, the table fully schema-qualified, a bare boolean result, and no data
-- returned. It is executable by every role because every join caller must be able to run the
-- guard; the fact that a Session is event-bound is not secret — it is exactly what the guard
-- error says.
--
-- ---------------------------------------------------------------------------------------
-- The join function itself
-- ---------------------------------------------------------------------------------------
-- This is `create or replace` of the IDENTICAL signature, not drop-and-create: the function
-- object, its owner and its ACL are preserved (see ENGINEERING_PATTERNS.md on function
-- recreation), and the committed body from 0110 is kept byte-for-byte except for ONE
-- delimited block inserted immediately after the SESSION_NOT_FOUND check. Every other check,
-- error, insert and return behaves exactly as before for an ordinary (non-event) Session,
-- including the order in which errors are raised. The contract suite proves this by stripping
-- the delimited block and comparing the remaining body with the committed 0110 fingerprint.

create function community_voting_session_is_event_bound(p_session_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.community_voting_instances i where i.session_id = p_session_id
  );
$$;

create or replace function join_participant_atomically(
  p_participant_id uuid,
  p_session_id uuid,
  p_display_name text,
  p_normalized_display_name text,
  p_participant_token text,
  p_joined_at timestamptz,
  p_event_type text,
  p_event_payload jsonb,
  p_gaming_member_id uuid default null
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_state text;
  v_declared_capabilities text[];
begin
  select sessions.state, sessions.declared_capabilities
    into v_state, v_declared_capabilities
  from sessions
  where sessions.session_id = p_session_id
  for update;

  if v_state is null then
    raise exception 'SESSION_NOT_FOUND: no session exists for this session_id'
      using errcode = 'P0001';
  end if;

  -- BEGIN community-voting guard (UG-IV-GATE-002)
  -- A Session bound to a Community Voting Instance admits Participants ONLY through
  -- bind_community_voting_voter_atomically, which enforces verified identity there.
  -- The Session row is already locked FOR UPDATE above, so this check serializes with
  -- Instance registration, which takes the same lock before looking for Participants:
  -- whichever commits first wins, and an event-bound Session can never hold an
  -- ordinary (Guest or Gaming Member) Participant.
  if community_voting_session_is_event_bound(p_session_id) then
    raise exception 'EVENT_BOUND_SESSION: this session is bound to a Community Voting event; ordinary joining is not available'
      using errcode = 'P0001';
  end if;
  -- END community-voting guard

  if v_state <> 'LOBBY_OPEN' then
    raise exception 'SESSION_NOT_JOINABLE: session is in % state, not LOBBY_OPEN', v_state
      using errcode = 'P0001';
  end if;

  if coalesce(array_length(v_declared_capabilities, 1), 0) = 0 then
    raise exception 'SESSION_CAPABILITIES_NOT_DECLARED: this session has not declared any gameplay capability yet'
      using errcode = 'P0001';
  end if;

  insert into participants (
    participant_id,
    session_id,
    display_name,
    normalized_display_name,
    participant_token,
    joined_at,
    gaming_member_id
  )
  values (
    p_participant_id,
    p_session_id,
    p_display_name,
    p_normalized_display_name,
    p_participant_token,
    p_joined_at,
    p_gaming_member_id
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
end;
$$;
