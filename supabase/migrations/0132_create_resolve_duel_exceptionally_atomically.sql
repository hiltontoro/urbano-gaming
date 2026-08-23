-- Migration: 0132_create_resolve_duel_exceptionally_atomically
-- Duel / SESSION_SUBGAME v1.
--
-- RESOLVE_DUEL_EXCEPTIONALLY's atomic operation — Duel_Architecture.md's
-- "exceptional resolution" Host-authority tier: CANCELLED, VOID, or a
-- named competitor's FORFEIT. One general command with an explicit
-- allowed-value list, not three narrow commands — a single domain
-- concept (Host-driven exceptional termination) at the implementation-
-- readiness gate's own recommendation. Callable against a Duel in
-- CREATED or ACTIVE state (CREATED is never actually observed today —
-- see 0128 — but the check does not assume otherwise); never against
-- an already-COMPLETED Duel, so a mechanic-derived result already
-- resolved by 0131 can never be silently overwritten by this path.
-- Correction/supersession of an already-terminal Duel is explicitly
-- out of scope for v1 — Duel_Architecture.md authorizes no such
-- mechanism yet.
--
-- CANCELLED/VOID never carry a winner (0128's own check constraint
-- enforces this independently). FORFEIT_A/FORFEIT_B require a reason —
-- the one case in this command where the outcome would otherwise be
-- ambiguous without one, mirroring this schema's own established
-- reason-required precedent (correction, grant, revoke, bootstrap).
--
-- Lock order: sessions row FOR UPDATE, then duels row FOR UPDATE — the
-- same fix and the same reasoning as 0131's own migration comment
-- (deadlocks against complete_session_atomically otherwise, via the
-- FK-implied FOR KEY SHARE this function's own session_events insert
-- takes on the parent sessions row).

create function resolve_duel_exceptionally_atomically(
  p_duel_id uuid,
  p_host_token text,
  p_resolution text,
  p_reason text
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
  v_winner uuid;
  v_ended_at timestamptz;
begin
  if p_resolution not in ('CANCELLED', 'VOID', 'FORFEIT_A', 'FORFEIT_B') then
    raise exception 'INVALID_DUEL_RESOLUTION: must be one of CANCELLED, VOID, FORFEIT_A, FORFEIT_B'
      using errcode = 'P0001';
  end if;

  if p_resolution in ('FORFEIT_A', 'FORFEIT_B') and (p_reason is null or btrim(p_reason) = '') then
    raise exception 'REASON_REQUIRED: a forfeit requires a reason'
      using errcode = 'P0001';
  end if;

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
         duels.competitor_b_participant_id
    into v_lifecycle_state, v_competitor_a, v_competitor_b
  from duels
  where duels.duel_id = p_duel_id
  for update;

  if v_lifecycle_state = 'COMPLETED' then
    raise exception 'DUEL_ALREADY_RESOLVED: this duel already has a terminal resolution'
      using errcode = 'P0001';
  end if;

  if p_resolution = 'FORFEIT_A' then
    v_winner := v_competitor_b;
  elsif p_resolution = 'FORFEIT_B' then
    v_winner := v_competitor_a;
  else
    v_winner := null;
  end if;

  v_ended_at := now();

  update duels
     set lifecycle_state = 'COMPLETED',
         terminal_resolution = case when p_resolution in ('FORFEIT_A', 'FORFEIT_B') then 'FORFEIT' else p_resolution end,
         winner_participant_id = v_winner,
         reason = p_reason,
         ended_at = v_ended_at
   where duels.duel_id = p_duel_id;

  insert into session_events (session_id, event_type, payload)
  values (
    v_session_id,
    'DUEL_RESOLVED',
    jsonb_build_object(
      'duelId', p_duel_id,
      'terminalResolution', case when p_resolution in ('FORFEIT_A', 'FORFEIT_B') then 'FORFEIT' else p_resolution end,
      'winnerParticipantId', v_winner,
      'reason', p_reason
    )
  );

  return query select p_duel_id, 'COMPLETED'::text,
    (case when p_resolution in ('FORFEIT_A', 'FORFEIT_B') then 'FORFEIT' else p_resolution end),
    v_winner;
end;
$$;
