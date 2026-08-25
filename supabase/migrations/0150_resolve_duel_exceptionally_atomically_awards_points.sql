-- Migration: 0150_resolve_duel_exceptionally_atomically_awards_points
-- Ordinary Duel Session Scoring Slice 001.
--
-- Replaces 0132's own resolve_duel_exceptionally_atomically. Signature
-- and RETURNS TABLE shape are both unchanged, so CREATE OR REPLACE is
-- safe here. The only behavioral change: on FORFEIT_A/FORFEIT_B, the
-- non-forfeiting competitor (already resolved as v_winner by this
-- function's own existing logic) is awarded duels.winner_points in the
-- same transaction as the terminal state transition — the Founder-
-- approved policy (FORFEIT: non-forfeiting winner +10). CANCELLED and
-- VOID never reach this insert; 0128's own check constraint already
-- guarantees v_winner is null for both, so the condition below is
-- belt-and-suspenders, not the only guard.
--
-- Idempotency: the identical single per-Duel scoring namespace
-- 0149 introduces (md5('duel-score:' || duel_id::text)::uuid), so a
-- Duel that is exceptionally resolved can never also carry a second
-- award from a different terminal path — the unique(session_id,
-- idempotency_key) constraint makes a second award for the same Duel
-- impossible regardless of which of this function, 0149's, or Math
-- Duel's own resolution attempts it. A duplicate/retried call never
-- even reaches this insert in practice, since it is rejected earlier
-- by the DUEL_ALREADY_RESOLVED guard.

create or replace function resolve_duel_exceptionally_atomically(
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
  v_winner_points integer;
  v_winner uuid;
  v_ended_at timestamptz;
  v_terminal_resolution text;
  v_point_award_id uuid;
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
         duels.competitor_b_participant_id, duels.winner_points
    into v_lifecycle_state, v_competitor_a, v_competitor_b, v_winner_points
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
  v_terminal_resolution := case when p_resolution in ('FORFEIT_A', 'FORFEIT_B') then 'FORFEIT' else p_resolution end;

  update duels
     set lifecycle_state = 'COMPLETED',
         terminal_resolution = v_terminal_resolution,
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
      'terminalResolution', v_terminal_resolution,
      'winnerParticipantId', v_winner,
      'reason', p_reason
    )
  );

  if v_terminal_resolution = 'FORFEIT' and v_winner is not null then
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

  return query select p_duel_id, 'COMPLETED'::text, v_terminal_resolution, v_winner;
end;
$$;
