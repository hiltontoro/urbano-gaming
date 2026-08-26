-- Migration: 0154_create_poker_table_atomically
-- Room Registry Slice 001.
--
-- CREATE_POKER_TABLE has never been atomic — createTable.ts's own
-- comment on the pre-existing plain insert explains why: "no atomic
-- function needed, no concurrent-mutation race," true for Poker alone.
-- That stops being true the moment Poker must jointly claim a code
-- from the same shared registry Session now writes to: without one
-- transaction, a poker_tables row could persist while its rooms row
-- fails (or the reverse), exactly the two failure modes 0153's own
-- comment closes for Session. This function closes them for Poker the
-- same way — new, not a CREATE OR REPLACE, since no prior atomic
-- function of this name existed.
--
-- No Poker gameplay behavior changes: same columns, same defaults,
-- same values createTable.ts already sends today. Ordering mirrors
-- 0153 for the same reason — poker_tables insert first (rooms.
-- poker_table_id is a real foreign key), rooms insert second.

create function create_poker_table_atomically(
  p_poker_table_id uuid,
  p_room_code text,
  p_host_token text,
  p_max_seats integer,
  p_starting_stack integer,
  p_small_blind integer,
  p_big_blind integer
)
returns void
language plpgsql
security invoker
set search_path = public
as $$
begin
  insert into poker_tables (
    poker_table_id,
    room_code,
    host_token,
    max_seats,
    starting_stack,
    small_blind,
    big_blind
  )
  values (
    p_poker_table_id,
    p_room_code,
    p_host_token,
    p_max_seats,
    p_starting_stack,
    p_small_blind,
    p_big_blind
  );

  insert into rooms (
    room_code,
    poker_table_id
  )
  values (
    p_room_code,
    p_poker_table_id
  );
end;
$$;
