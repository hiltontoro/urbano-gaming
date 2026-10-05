-- CANCEL_INCOMPLETE_COMPETITION — add competition-scoped serialization
-- lock (UG-CR-GATE-083 per UG-CR-REV-054 finding 1). The thirteen new
-- cancellation guards added in GATE-082 read competitions.state with an
-- ordinary, non-locking SELECT, while this function only locks the row
-- with FOR UPDATE — an ordinary read does not participate in that lock,
-- so a concurrent mutation could read a pre-cancellation state, then
-- this function could cancel and commit, and the first transaction
-- could still write afterward. The fix, applied uniformly across every
-- function in this domain that mutates an existing competition or a
-- child record of one (this file plus the 19 "add serialization lock"
-- migrations alongside it): acquire
-- pg_advisory_xact_lock(hashtext('competition_scope:' || <id>::text))
-- — a NEW, broader lock, distinct from and always acquired BEFORE the
-- domain's existing 'competition_team_scope:' lock and
-- declare_competition_roster_atomically's own (fixture, team) lock,
-- establishing one stable global order
-- (competition_scope -> competition_team_scope / (fixture,team)) with
-- no exceptions anywhere in the domain, so no two functions can ever
-- wait on each other's locks in opposite orders. Held for the whole
-- transaction (pg_advisory_xact_lock releases automatically at commit
-- or rollback), so once a transaction passes this point it is the only
-- one reading or writing this competition's lifecycle state until it
-- finishes — the state decision below and the write are no longer two
-- separate, race-able steps from the perspective of any other
-- transaction competing for the same competition.
--
-- p_competition_id is already a direct, known parameter here, so the
-- lock is acquired immediately, before the existing FOR UPDATE select —
-- no preliminary lookup is needed. Every other line is unchanged from
-- 20261001180050_create_cancel_incomplete_competition_atomically.sql.
create or replace function cancel_incomplete_competition_atomically(
  p_competition_id uuid,
  p_organizer_gaming_member_id uuid,
  p_reason text
)
returns table (competition_id uuid, state text, cancelled_reason text, already_cancelled boolean)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_organizer_id uuid;
  v_state text;
  v_cancelled_reason text;
  v_cancelled_at timestamptz;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'REASON_REQUIRED: cancelling a competition requires a reason' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('competition_scope:' || p_competition_id::text));

  select competitions.organizer_gaming_member_id, competitions.state, competitions.cancelled_reason
    into v_organizer_id, v_state, v_cancelled_reason
    from competitions
   where competitions.competition_id = p_competition_id
   for update;

  if v_organizer_id is null then
    raise exception 'COMPETITION_NOT_FOUND: no such competition exists' using errcode = 'P0001';
  end if;

  if v_organizer_id <> p_organizer_gaming_member_id then
    raise exception 'COMPETITION_ACCESS_DENIED: only this competition''s own organizer may cancel it'
      using errcode = 'P0001';
  end if;

  if v_state = 'CANCELLED_WITHOUT_CHAMPION' then
    return query select p_competition_id, v_state, v_cancelled_reason, true;
    return;
  end if;

  if v_state not in ('DRAFT', 'TEAM_REGISTRATION_OPEN', 'READY_TO_PUBLISH') then
    raise exception 'COMPETITION_NOT_CANCELLABLE: only a DRAFT, TEAM_REGISTRATION_OPEN, or READY_TO_PUBLISH competition may be cancelled this way'
      using errcode = 'P0001';
  end if;

  v_cancelled_at := now();

  update competitions
     set state = 'CANCELLED_WITHOUT_CHAMPION',
         cancelled_reason = p_reason,
         cancelled_by_gaming_member_id = p_organizer_gaming_member_id,
         cancelled_at = v_cancelled_at
   where competitions.competition_id = p_competition_id;

  insert into admin_audit_events (
    action_type, actor_kind, actor_id, authority_class_used,
    target_type, target_id, occurred_at, previous_reference, resulting_reference, outcome, reason
  )
  values (
    'CANCEL_INCOMPLETE_COMPETITION', 'GAMING_MEMBER', p_organizer_gaming_member_id, null,
    'competitions', p_competition_id, v_cancelled_at,
    jsonb_build_object('table', 'competitions', 'id', p_competition_id, 'state', v_state),
    jsonb_build_object('table', 'competitions', 'id', p_competition_id, 'state', 'CANCELLED_WITHOUT_CHAMPION'),
    'SUCCESS', p_reason
  );

  return query select p_competition_id, 'CANCELLED_WITHOUT_CHAMPION'::text, p_reason, false;
end;
$$;

revoke all on function cancel_incomplete_competition_atomically(uuid, uuid, text) from public, anon, authenticated;
grant execute on function cancel_incomplete_competition_atomically(uuid, uuid, text) to service_role;
