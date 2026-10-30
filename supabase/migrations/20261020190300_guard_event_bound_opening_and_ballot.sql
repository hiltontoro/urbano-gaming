-- Migration: 20261020190300_guard_event_bound_opening_and_ballot
-- UG-IV-GATE-003 — Literal preparation and atomic Community Voting start (Design B1, corrected).
--
-- Canon: IDENTITY_VOTING_LITERAL_PREPARATION_AND_ATOMIC_START_ACCEPTED. PROMPT_ACTIVE means Voting is actually
-- open, and an event-bound Session may open only through start_community_voting_atomically, which materializes a
-- fully attributed ballot. This migration makes that true at the database, for every path that can write the
-- relevant tables — not merely for the routes that happen to call the right function.
--
-- ---------------------------------------------------------------------------------------
-- Why TRIGGERS, and why not a guard inside start_session_atomically
-- ---------------------------------------------------------------------------------------
-- The join guard (20261020190200) edits join_participant_atomically in place because joining has exactly one
-- writer. Opening a Session has several: start_session_atomically creates Voting and Open Response and Trivia
-- interactions, start_quiz_atomically and the Duel starts create others, and a future engine will add more.
-- A guard inside one function would have to be repeated in each, would redefine the largest function in the
-- Session lifecycle (nine definitions deep), and would leave direct table writes unguarded. One BEFORE INSERT
-- trigger on interaction_instances closes every path at the single point where an interaction comes into
-- existence — and leaves start_session_atomically byte-for-byte the committed definition, so the ordinary start's
-- behaviour, signature, errors and ACL cannot have changed. For an ordinary (non-event) Session every trigger
-- below returns immediately; the contract suite proves it.
--
-- The one sanctioned way through is the TRANSACTION-LOCAL marker `urbano.community_voting_start`, which only
-- start_community_voting_atomically sets, to the id of the one Session it is opening, and clears before it returns
-- (see that function's commentary for why it cannot be forged through the REST surface).
--
-- ---------------------------------------------------------------------------------------
-- What is guarded
-- ---------------------------------------------------------------------------------------
--   interaction_instances  INSERT  - an event-bound Session gets an interaction only inside the sanctioned start.
--                                    Hence the ordinary start, however it is called, cannot open it.
--   voting_candidates      I/U/D   - an event-bound ballot's candidates are created, and attributed, only inside
--                                    the sanctioned start, and are FROZEN the moment they exist: no new candidate,
--                                    no replacement, no deletion, no attribution change, ever.
--   community_voting_entries I/U/D - preparation data is mutable only until the Session has any interaction; it
--                                    also refuses re-assigning an entry's identity or giving one contestant two
--                                    entries (the cross-row rule a unique constraint cannot express).
--   community_voting_entries TRUNCATE - never.
--
-- Deliberately NOT guarded: `votes` (the Voting store is writable by exactly cast_vote_atomically and nothing in
-- this work touches that), `participants` (the join guard and the bind function already own admission) and
-- interaction_instances UPDATE (close and reveal are Session transitions and stay Session-owned).

-- ---------------------------------------------------------------------------------------
-- A second bare-boolean lookup that must run as the table owner
-- ---------------------------------------------------------------------------------------
-- The candidate guard fires on writes by whoever calls start_session_atomically — including, by inherited default,
-- anon and authenticated — and it must look an interaction up to find its Session. For the same reason the join
-- guard uses a definer helper (a browser role has no privilege on the Community Voting tables, and under row-level
-- security would see no rows and silently pass), this lookup is done as the owner. It returns only the Session id of
-- an event-bound interaction, or null; it exposes nothing else. With community_voting_session_is_event_bound these
-- are the only SECURITY DEFINER functions this work adds.

create function community_voting_event_session_of_interaction(p_interaction_instance_id uuid)
returns uuid
language sql
stable
security definer
set search_path = public
as $$
  select ii.session_id
  from public.interaction_instances ii
  join public.community_voting_instances i on i.session_id = ii.session_id
  where ii.interaction_instance_id = p_interaction_instance_id;
$$;

-- ---------------------------------------------------------------------------------------
-- interaction_instances: an event-bound Session opens only through the Community Voting start
-- ---------------------------------------------------------------------------------------

create function community_voting_guard_interaction_insert()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not community_voting_session_is_event_bound(new.session_id) then
    return new;
  end if;

  if current_setting('urbano.community_voting_start', true) is not distinct from new.session_id::text then
    return new;
  end if;

  raise exception 'EVENT_BOUND_SESSION: this session is bound to a Community Voting event and opens only through the Community Voting start'
    using errcode = 'P0001';
end;
$$;

create trigger community_voting_guard_interaction_insert
  before insert on interaction_instances
  for each row execute function community_voting_guard_interaction_insert();

-- ---------------------------------------------------------------------------------------
-- voting_candidates: an event-bound ballot is created attributed and then frozen
-- ---------------------------------------------------------------------------------------

create function community_voting_guard_candidates()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_session_id uuid;
begin
  v_session_id := community_voting_event_session_of_interaction(
    coalesce(new.interaction_instance_id, old.interaction_instance_id)
  );

  if v_session_id is null then
    return coalesce(new, old);
  end if;

  if current_setting('urbano.community_voting_start', true) is not distinct from v_session_id::text then
    return coalesce(new, old);
  end if;

  raise exception 'COMMUNITY_VOTING_BALLOT_FROZEN: the candidates of an event-bound ballot cannot be created, changed, re-attributed or removed outside the Community Voting start'
    using errcode = 'P0001';
end;
$$;

create trigger community_voting_guard_candidates
  before insert or update or delete on voting_candidates
  for each row execute function community_voting_guard_candidates();

-- ---------------------------------------------------------------------------------------
-- community_voting_entries: preparation data is frozen from the moment the Session has any interaction
-- ---------------------------------------------------------------------------------------

create function community_voting_guard_entries()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_session_id uuid;
begin
  select i.session_id into v_session_id
  from community_voting_instances i
  where i.instance_id = coalesce(new.instance_id, old.instance_id);

  if exists (select 1 from interaction_instances ii where ii.session_id = v_session_id)
     and current_setting('urbano.community_voting_start', true) is distinct from v_session_id::text then
    raise exception 'COMMUNITY_VOTING_PREPARATION_FROZEN: Voting has opened; the preparation can no longer change'
      using errcode = 'P0001';
  end if;

  if tg_op = 'UPDATE' then
    if new.entry_id is distinct from old.entry_id
       or new.instance_id is distinct from old.instance_id
       or new.ordinal is distinct from old.ordinal
       or new.label is distinct from old.label
       or new.created_at is distinct from old.created_at then
      raise exception 'COMMUNITY_VOTING_HISTORY_IMMUTABLE: an entry''s identity cannot change'
        using errcode = 'P0001';
    end if;
  end if;

  -- A contestant holds at most one entry, pending OR confirmed. The unique constraints cover pending-on-two and
  -- confirmed-on-two; this closes the one gap they cannot express: pending on one entry and confirmed on another.
  if tg_op in ('INSERT', 'UPDATE')
     and (new.pending_binding_id is not null or new.confirmed_binding_id is not null)
     and exists (
       select 1 from community_voting_entries e
       where e.instance_id = new.instance_id
         and e.entry_id <> new.entry_id
         and (
           (new.pending_binding_id is not null
              and (e.pending_binding_id = new.pending_binding_id or e.confirmed_binding_id = new.pending_binding_id))
           or
           (new.confirmed_binding_id is not null
              and (e.pending_binding_id = new.confirmed_binding_id or e.confirmed_binding_id = new.confirmed_binding_id))
         )
     ) then
    raise exception 'COMMUNITY_VOTING_ENTRY_CONFLICT: a contestant holds at most one entry in a ballot'
      using errcode = 'P0001';
  end if;

  return coalesce(new, old);
end;
$$;

create trigger community_voting_guard_entries
  before insert or update or delete on community_voting_entries
  for each row execute function community_voting_guard_entries();

create trigger community_voting_entries_no_truncate
  before truncate on community_voting_entries
  for each statement execute function community_voting_reject_history_loss();

-- Trigger functions are never callable directly, but nothing here should be executable by a browser role either.
revoke execute on function community_voting_guard_interaction_insert() from public, anon, authenticated;
revoke execute on function community_voting_guard_candidates() from public, anon, authenticated;
revoke execute on function community_voting_guard_entries() from public, anon, authenticated;
