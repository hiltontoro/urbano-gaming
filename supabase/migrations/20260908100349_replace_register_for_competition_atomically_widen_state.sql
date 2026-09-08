-- REGISTER_FOR_COMPETITION correction (UG-CR-RPT-041 §4). The contract
-- required by the branded journey is that a member registers BEFORE the
-- four-team bracket is finalized, not only once PUBLISHED. Widened from
-- state = 'PUBLISHED' to state in ('TEAM_REGISTRATION_OPEN',
-- 'READY_TO_PUBLISH', 'PUBLISHED') — a strict widening, never a
-- narrowing: every competition that could accept a registration before
-- this migration still can. The idempotent-first check and every other
-- line of this function are otherwise unchanged.
create or replace function register_for_competition_atomically(
  p_competition_id uuid,
  p_gaming_member_id uuid,
  p_is_adult_self_attested boolean
)
returns table (
  competition_registration_id uuid,
  registered_at timestamptz,
  already_registered boolean
)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_state text;
  v_existing_id uuid;
  v_existing_at timestamptz;
  v_new_id uuid;
  v_new_at timestamptz;
begin
  select competitions.state into v_state
    from competitions
   where competitions.competition_id = p_competition_id
   for update;

  if v_state is null then
    raise exception 'COMPETITION_NOT_FOUND: no such competition exists' using errcode = 'P0001';
  end if;

  select competition_registrations.competition_registration_id, competition_registrations.registered_at
    into v_existing_id, v_existing_at
    from competition_registrations
   where competition_registrations.competition_id = p_competition_id
     and competition_registrations.gaming_member_id = p_gaming_member_id;

  if v_existing_id is not null then
    return query select v_existing_id, v_existing_at, true;
    return;
  end if;

  if v_state not in ('TEAM_REGISTRATION_OPEN', 'READY_TO_PUBLISH', 'PUBLISHED') then
    raise exception 'COMPETITION_NOT_PUBLISHED: registration is only open once the organizer has opened team registration'
      using errcode = 'P0001';
  end if;

  insert into competition_registrations (competition_id, gaming_member_id, is_adult_self_attested)
  values (p_competition_id, p_gaming_member_id, p_is_adult_self_attested)
  returning competition_registrations.competition_registration_id, competition_registrations.registered_at
  into v_new_id, v_new_at;

  return query select v_new_id, v_new_at, false;
end;
$$;

revoke all on function register_for_competition_atomically(uuid, uuid, boolean) from public, anon, authenticated;
grant execute on function register_for_competition_atomically(uuid, uuid, boolean) to service_role;
