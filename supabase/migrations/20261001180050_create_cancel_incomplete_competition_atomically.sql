-- CANCEL_INCOMPLETE_COMPETITION (UG-CR-GATE-081 Phase 3E; corrected by
-- UG-CR-GATE-082 per UG-CR-REV-053 #3). A supported, organizer-only,
-- genuinely audited way to wind down a competition that never reached
-- PUBLISHED — the pre-fixture sibling of VOID_COMPETITION_FIXTURE's own
-- cascade to this same terminal state (20260906044842_create_void_
-- competition_fixture_atomically.sql), explicitly scoped to DRAFT,
-- TEAM_REGISTRATION_OPEN, and READY_TO_PUBLISH only. Nothing is ever
-- deleted — no competition, team, registration, proposal, or
-- membership row is removed or rewritten; this is a state+reason
-- transition on the one competitions row, now additionally recording
-- who performed it and when.
--
-- REV-053 #3 (corrected here, two parts):
--
-- 1. "Calling this audited is unsupported" — the original version wrote
-- only state and cancelled_reason: no actor, no timestamp, no
-- immutable event. This version adds two new columns,
-- cancelled_by_gaming_member_id and cancelled_at, written atomically
-- with the state transition, AND inserts exactly one row into the
-- existing platform-wide audit ledger admin_audit_events (created in
-- 0115_create_admin_audit_events.sql and already used the same way —
-- a direct SQL insert inside the atomic function body, in the same
-- transaction as the domain-state write — by
-- 0120_finalize_match_result_atomically_actor_provenance.sql and its
-- 0121-0124 siblings). authority_class_used is left null: cancellation
-- is authorized by this competition's own organizer_gaming_member_id,
-- the same record-level authorization every other function in this
-- domain already uses, never a platform authority_grants check, so no
-- authority_class applies here (the column already allows null for
-- exactly this reason). The idempotent-replay branch returns before
-- this insert is ever reached, so re-cancelling an already-cancelled
-- competition creates no duplicate event and does not overwrite
-- cancelled_by/cancelled_at — this is the "equivalent immutable
-- evidence" REV-053 asked for: once written, nothing in this function
-- ever updates these fields again.
--
-- 2. "The claim that every later write already fails closed is false"
-- — the original version's own comment asserted this domain's other
-- RPCs already guarded against a cancelled competition. That claim was
-- inaccurate for decide_competition_team_atomically and the three
-- join-request RPCs, among others — see the new
-- 20261002* "add cancellation guard" migrations, each of which adds
-- the missing check directly to the affected function. This migration
-- no longer makes any claim about those other functions' behavior.

alter table competitions add column cancelled_by_gaming_member_id uuid references gaming_members (gaming_member_id);
alter table competitions add column cancelled_at timestamptz;

create function cancel_incomplete_competition_atomically(
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
