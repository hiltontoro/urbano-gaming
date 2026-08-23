-- Migration: 0127_add_duel_capability
-- Duel / SESSION_SUBGAME v1 (Product/Duel_Architecture.md,
-- Session_Capability_Architecture.md, ADR-036).
--
-- 0109's own set_session_capabilities_atomically is not edited as a
-- file — create-or-replace, since the function's own signature never
-- changes, the same precedent 0111/0112 already established for this
-- exact literal-list pattern. The only behavioral change: 'DUEL' is
-- now a valid capability key, alongside the four already-approved
-- ones. Everything else is byte-for-byte unchanged from 0109.

create or replace function set_session_capabilities_atomically(
  p_session_id uuid,
  p_host_token text,
  p_capabilities text[]
)
returns table (
  session_id uuid,
  declared_capabilities text[],
  locked boolean
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_current text[];
  v_host_token text;
  v_normalized text[];
  v_has_participants boolean;
begin
  v_normalized := coalesce(
    array(select distinct unnest(p_capabilities) order by 1),
    array[]::text[]
  );

  if exists (
    select 1 from unnest(v_normalized) as key
    where key not in ('OPEN_RESPONSE', 'VOTING', 'TRIVIA', 'QUIZ', 'DUEL')
  ) then
    raise exception 'INVALID_CAPABILITY_KEY: must be one of OPEN_RESPONSE, VOTING, TRIVIA, QUIZ, DUEL'
      using errcode = 'P0001';
  end if;

  select sessions.declared_capabilities, sessions.host_token
    into v_current, v_host_token
  from sessions
  where sessions.session_id = p_session_id
  for update;

  if not found then
    raise exception 'SESSION_NOT_FOUND: no session exists for this session_id'
      using errcode = 'P0001';
  end if;

  if v_host_token <> p_host_token then
    raise exception 'HOST_TOKEN_MISMATCH: supplied host token does not match this session'
      using errcode = 'P0001';
  end if;

  select exists(
    select 1 from participants where participants.session_id = p_session_id
  ) into v_has_participants;

  if v_has_participants then
    if v_current is distinct from v_normalized then
      raise exception 'CAPABILITIES_LOCKED: this session already has a real participant and its declared capabilities cannot change'
        using errcode = 'P0001';
    end if;

    return query select p_session_id, v_current, true;
    return;
  end if;

  update sessions
     set declared_capabilities = v_normalized,
         updated_at = now()
   where sessions.session_id = p_session_id;

  insert into session_events (session_id, event_type, payload)
  values (
    p_session_id,
    'SESSION_CAPABILITIES_DECLARED',
    jsonb_build_object('declaredCapabilities', to_jsonb(v_normalized))
  );

  return query select p_session_id, v_normalized, false;
end;
$$;
