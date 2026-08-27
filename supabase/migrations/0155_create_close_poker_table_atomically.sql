-- Migration: 0155_create_close_poker_table_atomically
-- Poker End Table Lifecycle Slice. Makes closed_at (present since 0067,
-- deliberately deferred — see that migration's own comment) reachable
-- for the first time. Mirrors start_poker_hand_atomically's (0079) own
-- lock order exactly: poker_tables row locked first, then the table's
-- most recent poker_hands row — the same two-lock sequence, so a
-- concurrent start_poker_hand_atomically call on the same table can
-- never race past this function undetected. Whichever transaction's
-- first `for update` commits first wins; the other blocks, then
-- re-reads the now-updated row and correctly rejects.
--
-- Legal only "between hands": no poker_hands row yet (a table may be
-- closed before its first Hand is ever dealt), or the most recent
-- Hand's street = 'COMPLETE'. Idempotent (mirrors 0079's own
-- already_started convention and 0081's already_settled convention): a
-- repeat call on an already-closed table returns already_closed = true
-- rather than raising.
--
-- No other mutation. poker_hands / poker_hand_players /
-- poker_hand_actions / poker_hand_results are never touched — full
-- Hand history remains queryable indefinitely, mirroring
-- complete_session_atomically's own precedent of never destroying
-- history on a terminal transition.

create function close_poker_table_atomically(
  p_poker_table_id uuid
)
returns table (
  poker_table_id uuid,
  closed_at timestamptz,
  already_closed boolean
)
language plpgsql
security invoker
set search_path = public
as $$
#variable_conflict use_column
declare
  v_closed_at timestamptz;
  v_existing_street text;
  v_new_closed_at timestamptz;
begin
  select poker_tables.closed_at into v_closed_at
  from poker_tables
  where poker_tables.poker_table_id = p_poker_table_id
  for update;

  if not found then
    raise exception 'POKER_TABLE_NOT_FOUND: no poker table exists for this id'
      using errcode = 'P0001';
  end if;

  if v_closed_at is not null then
    return query select p_poker_table_id, v_closed_at, true;
    return;
  end if;

  select poker_hands.street into v_existing_street
  from poker_hands
  where poker_hands.poker_table_id = p_poker_table_id
  order by poker_hands.hand_ordinal desc
  limit 1
  for update;

  if v_existing_street is not null and v_existing_street <> 'COMPLETE' then
    raise exception 'POKER_TABLE_HAS_ACTIVE_HAND: this poker table has a hand in progress'
      using errcode = 'P0001';
  end if;

  v_new_closed_at := now();
  update poker_tables set closed_at = v_new_closed_at
  where poker_tables.poker_table_id = p_poker_table_id;

  return query select p_poker_table_id, v_new_closed_at, false;
end;
$$;
