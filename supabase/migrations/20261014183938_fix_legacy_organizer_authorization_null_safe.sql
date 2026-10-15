-- LEGACY ORGANIZER ENTRYPOINTS — null-safe organizer check (UG-CR-GATE-094).
--
-- ROOT CAUSE. Five functions, six signatures, authorized the organizer with
--   if v_organizer_id <> p_organizer_gaming_member_id then raise ... COMPETITION_ACCESS_DENIED
-- For a NULL caller that comparison is NULL, PL/pgSQL treats a NULL condition as false, and the denial is skipped.
-- The host revocation guard that follows is keyed on the competition id, not on the caller, so a NULL caller then
-- carried on as the organizer. The stored organizer column is NOT NULL, so only a NULL CALLER can reach this; the
-- application never passes one (the actor is always the verified session member) and the functions are executable
-- only by service_role, so this is defense in depth. It is the same defect class GATE-089 to GATE-091 corrected in
-- ten other functions. Those were found by a scan that recognized only the parameter-on-the-left operand order
-- (`p_..._gaming_member_id <> v_...`); these six write the operands the other way round and were therefore missed.
--
-- FIX. The comparison becomes
--   if p_organizer_gaming_member_id is distinct from v_organizer_id then raise ...
-- so a NULL caller is refused with each function's own existing COMPETITION_ACCESS_DENIED message, at the same point:
-- after the competition is locked and read, before the host revocation guard, before any lifecycle or state check and
-- before any write. Behavior for every non-NULL caller is identical.
--
-- Exactly one line differs in each function; every other line is the definition live after the migration named in
-- its section. Signatures, return types, SECURITY DEFINER, the pinned search_path, owner, locking order, replay
-- behavior and the host revocation guard are unchanged. The execute grants are restated after each function.

-- 1/6  ADD_COMPETITION_TEAM_ATOMICALLY (4 arguments, legacy overload) — definition live after 20261007220003_add_host_revocation_check_to_add_competition_team_legacy.
CREATE OR REPLACE FUNCTION public.add_competition_team_atomically(p_competition_id uuid, p_organizer_gaming_member_id uuid, p_name text, p_captain_gaming_member_id uuid)
 RETURNS TABLE(competition_team_id uuid, created_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_organizer_id uuid;
  v_state text;
  v_team_id uuid;
  v_created_at timestamptz;
  v_accepted_count integer;
begin
  perform pg_advisory_xact_lock(hashtext('competition_scope:' || p_competition_id::text));

  select competitions.organizer_gaming_member_id, competitions.state
    into v_organizer_id, v_state
    from competitions
   where competitions.competition_id = p_competition_id
   for update;

  if v_organizer_id is null then
    raise exception 'COMPETITION_NOT_FOUND: no such competition exists' using errcode = 'P0001';
  end if;

  if p_organizer_gaming_member_id is distinct from v_organizer_id then
    raise exception 'COMPETITION_ACCESS_DENIED: only this competition''s own organizer may add a team'
      using errcode = 'P0001';
  end if;
  perform assert_competition_not_host_revoked(p_competition_id);

  if v_state not in ('DRAFT', 'TEAM_REGISTRATION_OPEN') then
    raise exception 'COMPETITION_NOT_DRAFT: teams may only be added while the competition is DRAFT or TEAM_REGISTRATION_OPEN'
      using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('competition_team_scope:' || p_competition_id::text));

  select count(*) into v_accepted_count
    from competition_teams
   where competition_teams.competition_id = p_competition_id
     and competition_teams.status = 'ACCEPTED';

  if v_accepted_count >= 4 then
    raise exception 'TEAM_CAPACITY_REACHED: four teams have already been accepted for this competition'
      using errcode = 'P0001';
  end if;

  begin
    insert into competition_teams (competition_id, name, captain_gaming_member_id, status, provenance)
    values (p_competition_id, p_name, p_captain_gaming_member_id, 'ACCEPTED', 'ORGANIZER_CREATED')
    returning competition_teams.competition_team_id, competition_teams.created_at
    into v_team_id, v_created_at;
  exception
    when unique_violation then
      if sqlerrm like '%competition_teams_unique_name_per_competition%' then
        raise exception 'DUPLICATE_TEAM_NAME: a team with this name already exists in this competition' using errcode = 'P0001';
      elsif sqlerrm like '%competition_teams_one_active_captaincy%' then
        raise exception 'ALREADY_CAPTAIN_OR_MEMBER: this member already holds an active team role in this competition' using errcode = 'P0001';
      else
        raise;
      end if;
  end;

  return query select v_team_id, v_created_at;
end;
$function$;

revoke all on function add_competition_team_atomically(uuid,uuid,text,uuid) from public, anon, authenticated;
grant execute on function add_competition_team_atomically(uuid,uuid,text,uuid) to service_role;

-- 2/6  ADD_COMPETITION_TEAM_ATOMICALLY (5 arguments, with public code) — definition live after 20261007220006_add_host_revocation_check_to_add_competition_team.
CREATE OR REPLACE FUNCTION public.add_competition_team_atomically(p_competition_id uuid, p_organizer_gaming_member_id uuid, p_name text, p_captain_gaming_member_id uuid, p_public_code text)
 RETURNS TABLE(competition_team_id uuid, created_at timestamp with time zone)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_organizer_id uuid;
  v_state text;
  v_team_id uuid;
  v_created_at timestamptz;
  v_accepted_count integer;
begin
  if p_public_code is null or length(trim(p_public_code)) = 0 then
    raise exception 'PUBLIC_CODE_REQUIRED: an opaque public code is required' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('competition_scope:' || p_competition_id::text));

  select competitions.organizer_gaming_member_id, competitions.state
    into v_organizer_id, v_state
    from competitions
   where competitions.competition_id = p_competition_id
   for update;

  if v_organizer_id is null then
    raise exception 'COMPETITION_NOT_FOUND: no such competition exists' using errcode = 'P0001';
  end if;

  if p_organizer_gaming_member_id is distinct from v_organizer_id then
    raise exception 'COMPETITION_ACCESS_DENIED: only this competition''s own organizer may add a team'
      using errcode = 'P0001';
  end if;
  perform assert_competition_not_host_revoked(p_competition_id);

  if v_state not in ('DRAFT', 'TEAM_REGISTRATION_OPEN') then
    raise exception 'COMPETITION_NOT_DRAFT: teams may only be added while the competition is DRAFT or TEAM_REGISTRATION_OPEN'
      using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('competition_team_scope:' || p_competition_id::text));

  select count(*) into v_accepted_count
    from competition_teams
   where competition_teams.competition_id = p_competition_id
     and competition_teams.status = 'ACCEPTED';

  if v_accepted_count >= 4 then
    raise exception 'TEAM_CAPACITY_REACHED: four teams have already been accepted for this competition'
      using errcode = 'P0001';
  end if;

  begin
    insert into competition_teams (competition_id, name, captain_gaming_member_id, status, provenance, public_code)
    values (p_competition_id, p_name, p_captain_gaming_member_id, 'ACCEPTED', 'ORGANIZER_CREATED', p_public_code)
    returning competition_teams.competition_team_id, competition_teams.created_at
    into v_team_id, v_created_at;
  exception
    when unique_violation then
      if sqlerrm like '%competition_teams_unique_name_per_competition%' then
        raise exception 'DUPLICATE_TEAM_NAME: a team with this name already exists in this competition' using errcode = 'P0001';
      elsif sqlerrm like '%competition_teams_one_active_captaincy%' then
        raise exception 'ALREADY_CAPTAIN_OR_MEMBER: this member already holds an active team role in this competition' using errcode = 'P0001';
      else
        raise;
      end if;
  end;

  return query select v_team_id, v_created_at;
end;
$function$;

revoke all on function add_competition_team_atomically(uuid,uuid,text,uuid,text) from public, anon, authenticated;
grant execute on function add_competition_team_atomically(uuid,uuid,text,uuid,text) to service_role;

-- 3/6  CANCEL_INCOMPLETE_COMPETITION_ATOMICALLY — definition live after 20261007220011_add_host_revocation_check_to_cancel_incomplete_competition.
CREATE OR REPLACE FUNCTION public.cancel_incomplete_competition_atomically(p_competition_id uuid, p_organizer_gaming_member_id uuid, p_reason text)
 RETURNS TABLE(competition_id uuid, state text, cancelled_reason text, already_cancelled boolean)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
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

  if p_organizer_gaming_member_id is distinct from v_organizer_id then
    raise exception 'COMPETITION_ACCESS_DENIED: only this competition''s own organizer may cancel it'
      using errcode = 'P0001';
  end if;
  perform assert_competition_not_host_revoked(p_competition_id);

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
$function$;

revoke all on function cancel_incomplete_competition_atomically(uuid,uuid,text) from public, anon, authenticated;
grant execute on function cancel_incomplete_competition_atomically(uuid,uuid,text) to service_role;

-- 4/6  CLOSE_TEAM_REGISTRATION_ATOMICALLY — definition live after 20261007220013_add_host_revocation_check_to_close_team_registration.
CREATE OR REPLACE FUNCTION public.close_team_registration_atomically(p_competition_id uuid, p_organizer_gaming_member_id uuid)
 RETURNS TABLE(competition_id uuid, state text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_organizer_id uuid;
  v_state text;
  v_accepted_count integer;
begin
  perform pg_advisory_xact_lock(hashtext('competition_scope:' || p_competition_id::text));

  select competitions.organizer_gaming_member_id, competitions.state
    into v_organizer_id, v_state
    from competitions
   where competitions.competition_id = p_competition_id
   for update;

  if v_organizer_id is null then
    raise exception 'COMPETITION_NOT_FOUND: no such competition exists' using errcode = 'P0001';
  end if;

  if p_organizer_gaming_member_id is distinct from v_organizer_id then
    raise exception 'COMPETITION_ACCESS_DENIED: only this competition''s own organizer may close team registration'
      using errcode = 'P0001';
  end if;
  perform assert_competition_not_host_revoked(p_competition_id);

  if v_state <> 'TEAM_REGISTRATION_OPEN' then
    raise exception 'TEAM_REGISTRATION_NOT_OPEN: team registration is not currently open'
      using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('competition_team_scope:' || p_competition_id::text));

  select count(*) into v_accepted_count
    from competition_teams
   where competition_teams.competition_id = p_competition_id
     and competition_teams.status = 'ACCEPTED';

  if v_accepted_count <> 4 then
    raise exception 'TEAM_REGISTRATION_CAPACITY_NOT_REACHED: exactly four accepted teams are required to close team registration (found %)', v_accepted_count
      using errcode = 'P0001';
  end if;

  update competitions set state = 'READY_TO_PUBLISH' where competitions.competition_id = p_competition_id;

  return query select p_competition_id, 'READY_TO_PUBLISH'::text;
end;
$function$;

revoke all on function close_team_registration_atomically(uuid,uuid) from public, anon, authenticated;
grant execute on function close_team_registration_atomically(uuid,uuid) to service_role;

-- 5/6  OPEN_TEAM_REGISTRATION_ATOMICALLY — definition live after 20261007220032_add_host_revocation_check_to_open_team_registration.
CREATE OR REPLACE FUNCTION public.open_team_registration_atomically(p_competition_id uuid, p_organizer_gaming_member_id uuid)
 RETURNS TABLE(competition_id uuid, state text)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_organizer_id uuid;
  v_state text;
begin
  perform pg_advisory_xact_lock(hashtext('competition_scope:' || p_competition_id::text));

  select competitions.organizer_gaming_member_id, competitions.state
    into v_organizer_id, v_state
    from competitions
   where competitions.competition_id = p_competition_id
   for update;

  if v_organizer_id is null then
    raise exception 'COMPETITION_NOT_FOUND: no such competition exists' using errcode = 'P0001';
  end if;

  if p_organizer_gaming_member_id is distinct from v_organizer_id then
    raise exception 'COMPETITION_ACCESS_DENIED: only this competition''s own organizer may open team registration'
      using errcode = 'P0001';
  end if;
  perform assert_competition_not_host_revoked(p_competition_id);

  if v_state <> 'DRAFT' then
    raise exception 'COMPETITION_NOT_DRAFT: team registration may only be opened while the competition is DRAFT'
      using errcode = 'P0001';
  end if;

  update competitions set state = 'TEAM_REGISTRATION_OPEN' where competitions.competition_id = p_competition_id;

  return query select p_competition_id, 'TEAM_REGISTRATION_OPEN'::text;
end;
$function$;

revoke all on function open_team_registration_atomically(uuid,uuid) from public, anon, authenticated;
grant execute on function open_team_registration_atomically(uuid,uuid) to service_role;

-- 6/6  PUBLISH_COMPETITION_ATOMICALLY — definition live after 20261007220037_add_host_revocation_check_to_publish_competition.
CREATE OR REPLACE FUNCTION public.publish_competition_atomically(p_competition_id uuid, p_organizer_gaming_member_id uuid, p_semifinal_1_team_a_id uuid, p_semifinal_1_team_b_id uuid, p_semifinal_2_team_a_id uuid, p_semifinal_2_team_b_id uuid, p_semifinal_1_scheduled_at timestamp with time zone, p_semifinal_2_scheduled_at timestamp with time zone, p_final_scheduled_at timestamp with time zone)
 RETURNS TABLE(competition_id uuid, state text, published_at timestamp with time zone, semifinal_1_fixture_id uuid, semifinal_2_fixture_id uuid, final_fixture_id uuid)
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public'
AS $function$
declare
  v_organizer_id uuid;
  v_state text;
  v_team_count integer;
  v_distinct_pairing_count integer;
  v_published_at timestamptz;
  v_sf1_id uuid;
  v_sf2_id uuid;
  v_final_id uuid;
begin
  perform pg_advisory_xact_lock(hashtext('competition_scope:' || p_competition_id::text));

  select competitions.organizer_gaming_member_id, competitions.state
    into v_organizer_id, v_state
    from competitions
   where competitions.competition_id = p_competition_id
   for update;

  if v_organizer_id is null then
    raise exception 'COMPETITION_NOT_FOUND: no such competition exists' using errcode = 'P0001';
  end if;

  if p_organizer_gaming_member_id is distinct from v_organizer_id then
    raise exception 'COMPETITION_ACCESS_DENIED: only this competition''s own organizer may publish it'
      using errcode = 'P0001';
  end if;
  perform assert_competition_not_host_revoked(p_competition_id);

  if v_state <> 'READY_TO_PUBLISH' then
    raise exception 'COMPETITION_NOT_READY_TO_PUBLISH: a competition may only be published from READY_TO_PUBLISH'
      using errcode = 'P0001';
  end if;

  select count(*) into v_team_count
    from competition_teams
   where competition_teams.competition_id = p_competition_id
     and competition_teams.status = 'ACCEPTED';

  if v_team_count <> 4 then
    raise exception 'COMPETITION_TEAM_COUNT_INVALID: exactly four accepted teams are required to publish (found %)', v_team_count
      using errcode = 'P0001';
  end if;

  select count(distinct team_id) into v_distinct_pairing_count
    from unnest(array[p_semifinal_1_team_a_id, p_semifinal_1_team_b_id,
                       p_semifinal_2_team_a_id, p_semifinal_2_team_b_id]) as team_id;

  if v_distinct_pairing_count <> 4 then
    raise exception 'COMPETITION_PAIRING_INVALID: the four semifinal pairing slots must name four distinct teams'
      using errcode = 'P0001';
  end if;

  if exists (
    select 1 from unnest(array[p_semifinal_1_team_a_id, p_semifinal_1_team_b_id,
                                p_semifinal_2_team_a_id, p_semifinal_2_team_b_id]) as team_id
    where not exists (
      select 1 from competition_teams
      where competition_teams.competition_team_id = team_id
        and competition_teams.competition_id = p_competition_id
        and competition_teams.status = 'ACCEPTED'
    )
  ) then
    raise exception 'COMPETITION_PAIRING_INVALID: every paired team must belong to this competition and be accepted'
      using errcode = 'P0001';
  end if;

  v_published_at := now();

  insert into competition_fixtures (competition_id, fixture_role, scheduled_at, team_a_competition_team_id, team_b_competition_team_id, state)
  values (p_competition_id, 'SEMIFINAL_1', p_semifinal_1_scheduled_at, p_semifinal_1_team_a_id, p_semifinal_1_team_b_id, 'SCHEDULED')
  returning competition_fixtures.competition_fixture_id into v_sf1_id;

  insert into competition_fixtures (competition_id, fixture_role, scheduled_at, team_a_competition_team_id, team_b_competition_team_id, state)
  values (p_competition_id, 'SEMIFINAL_2', p_semifinal_2_scheduled_at, p_semifinal_2_team_a_id, p_semifinal_2_team_b_id, 'SCHEDULED')
  returning competition_fixtures.competition_fixture_id into v_sf2_id;

  insert into competition_fixtures (competition_id, fixture_role, scheduled_at, team_a_source_fixture_id, team_b_source_fixture_id, state)
  values (p_competition_id, 'FINAL', p_final_scheduled_at, v_sf1_id, v_sf2_id, 'SCHEDULED')
  returning competition_fixtures.competition_fixture_id into v_final_id;

  update competitions
     set state = 'PUBLISHED', published_at = v_published_at
   where competitions.competition_id = p_competition_id;

  return query select p_competition_id, 'PUBLISHED'::text, v_published_at, v_sf1_id, v_sf2_id, v_final_id;
end;
$function$;

revoke all on function publish_competition_atomically(uuid,uuid,uuid,uuid,uuid,uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone) from public, anon, authenticated;
grant execute on function publish_competition_atomically(uuid,uuid,uuid,uuid,uuid,uuid,timestamp with time zone,timestamp with time zone,timestamp with time zone) to service_role;
