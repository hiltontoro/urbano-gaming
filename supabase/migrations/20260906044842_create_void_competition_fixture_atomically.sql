-- VOID_COMPETITION_FIXTURE. Organizer only, reason required. Produces
-- no winner, advancement, or derived statistics. Slice 001 has no
-- rematch flow (UG-CR-REV-019): voiding ANY of the three required
-- knockout fixtures immediately terminates the whole competition as
-- CANCELLED_WITHOUT_CHAMPION, in this same transaction, preserving the
-- void reason and every prior assertion/evidence on this and every
-- other fixture (nothing is deleted anywhere by this operation).
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

  select competitions.organizer_gaming_member_id into v_organizer_id from competitions where competitions.competition_id = v_competition_id;
  if p_organizer_gaming_member_id <> v_organizer_id then
    raise exception 'COMPETITION_ACCESS_DENIED: only the organizer may void a fixture' using errcode = 'P0001';
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
