-- VOID_COMPETITION_FIXTURE — add competition-scoped serialization lock
-- (UG-CR-GATE-083 per UG-CR-REV-054 finding 1). See
-- 20261005090000_add_serialization_lock_to_cancel_incomplete_competition.sql
-- for the full rationale. This function's ORIGINAL first operation
-- (after REASON_REQUIRED) was a FOR UPDATE lock on competition_fixtures
-- before competition_id was known (that select already fetched only
-- competition_id, nothing else). A small plain preliminary lookup now
-- resolves competition_id and checks FIXTURE_NOT_FOUND first;
-- competition_scope is acquired next; only then does the ORIGINAL FOR
-- UPDATE select run exactly as before — a now-redundant but harmless
-- re-read of the same single column, kept rather than removed so this
-- function's own fixture-row lock (its guard against two concurrent
-- voids of the SAME fixture both passing the "no existing finalization"
-- check) is left completely untouched. This is also the function that
-- itself cascades the competition to CANCELLED_WITHOUT_CHAMPION; with
-- competition_scope now held for its whole duration, that cascade and
-- every other function's own CANCELLED_WITHOUT_CHAMPION check are
-- finally racing against the SAME serialization point, closing exactly
-- the gap UG-CR-REV-054 finding 1 identified. Every other line is
-- unchanged from
-- 20261002090120_add_cancellation_guard_to_void_competition_fixture.sql.
create or replace function void_competition_fixture_atomically(
  p_competition_fixture_id uuid,
  p_organizer_gaming_member_id uuid,
  p_reason text
)
returns table (competition_fixture_finalization_id uuid, competition_state text, already_finalized boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_lookup_competition_id uuid;
  v_competition_id uuid;
  v_competition_state text;
  v_organizer_id uuid;
  v_existing_finalization_id uuid;
  v_finalized_at timestamptz;
  v_finalization_id uuid;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'REASON_REQUIRED: a void requires a reason' using errcode = 'P0001';
  end if;

  select competition_fixtures.competition_id into v_lookup_competition_id
    from competition_fixtures
   where competition_fixtures.competition_fixture_id = p_competition_fixture_id;

  if v_lookup_competition_id is null then
    raise exception 'FIXTURE_NOT_FOUND: no such fixture exists' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('competition_scope:' || v_lookup_competition_id::text));

  select competition_fixtures.competition_id into v_competition_id
    from competition_fixtures where competition_fixtures.competition_fixture_id = p_competition_fixture_id for update;

  if v_competition_id is null then
    raise exception 'FIXTURE_NOT_FOUND: no such fixture exists' using errcode = 'P0001';
  end if;

  select competition_fixture_finalizations.competition_fixture_finalization_id into v_existing_finalization_id
    from competition_fixture_finalizations
   where competition_fixture_finalizations.competition_fixture_id = p_competition_fixture_id and competition_fixture_finalizations.is_current;

  if v_existing_finalization_id is not null then
    return query select v_existing_finalization_id, (select competitions.state from competitions where competitions.competition_id = v_competition_id), true;
    return;
  end if;

  select competitions.organizer_gaming_member_id, competitions.state
    into v_organizer_id, v_competition_state
    from competitions where competitions.competition_id = v_competition_id;
  if p_organizer_gaming_member_id <> v_organizer_id then
    raise exception 'COMPETITION_ACCESS_DENIED: only the organizer may void a fixture' using errcode = 'P0001';
  end if;

  if v_competition_state = 'CANCELLED_WITHOUT_CHAMPION' then
    raise exception 'COMPETITION_CANCELLED: this competition has been cancelled and no longer accepts this action'
      using errcode = 'P0001';
  end if;

  v_finalized_at := now();

  insert into competition_fixture_finalizations (competition_fixture_id, finalized_by_gaming_member_id, finalized_at, outcome_type, winning_competition_team_id, reason)
  values (p_competition_fixture_id, p_organizer_gaming_member_id, v_finalized_at, 'VOID', null, p_reason)
  returning competition_fixture_finalizations.competition_fixture_finalization_id into v_finalization_id;

  update competition_fixtures set state = 'VOID' where competition_fixtures.competition_fixture_id = p_competition_fixture_id;

  update competition_disputes
     set resolved_at = v_finalized_at, resolved_by_gaming_member_id = p_organizer_gaming_member_id, resolution_action = 'VOIDED'
   where competition_disputes.competition_fixture_id = p_competition_fixture_id and competition_disputes.resolved_at is null;

  update competitions
     set state = 'CANCELLED_WITHOUT_CHAMPION', cancelled_reason = p_reason
   where competitions.competition_id = v_competition_id;

  return query select v_finalization_id, 'CANCELLED_WITHOUT_CHAMPION'::text, false;
end;
$$;

revoke all on function void_competition_fixture_atomically(uuid, uuid, text) from public, anon, authenticated;
grant execute on function void_competition_fixture_atomically(uuid, uuid, text) to service_role;
