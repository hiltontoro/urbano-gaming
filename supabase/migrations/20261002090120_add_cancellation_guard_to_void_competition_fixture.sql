-- VOID_COMPETITION_FIXTURE — add cancellation guard (UG-CR-GATE-082 per
-- UG-CR-REV-053 #3: "finalization actions" was named explicitly). This
-- function is itself one of the two pre-existing paths TO
-- CANCELLED_WITHOUT_CHAMPION (voiding any of the three required
-- knockout fixtures cascades the whole competition to that terminal
-- state) — but voiding a DIFFERENT fixture of a competition already
-- cancelled by an earlier void was not itself blocked, since the
-- function only read competitions.organizer_gaming_member_id, never
-- competitions.state. The idempotent "already finalized" replay (an
-- existing finalization on THIS SAME fixture, pure read, no mutation)
-- is deliberately left unguarded, matching
-- cancel_incomplete_competition_atomically's own idempotent branch —
-- only a genuinely NEW void is blocked. Every other line is unchanged
-- from 20260906044842_create_void_competition_fixture_atomically.sql —
-- only the organizer-lookup select now also reads competitions.state,
-- and one new guard is inserted immediately after the existing
-- COMPETITION_ACCESS_DENIED check.
--
-- Not addressed here (disclosed, not silently expanded): this
-- function's own cascade write to CANCELLED_WITHOUT_CHAMPION (a few
-- lines below) still records only state+cancelled_reason, with no
-- actor/timestamp/audit-event parity with the corrected
-- cancel_incomplete_competition_atomically — retrofitting that
-- pre-existing, already-accepted cascade is outside REV-053's four
-- named blockers and would be the unrelated redesign UG-CR-GATE-082
-- explicitly prohibits.
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
