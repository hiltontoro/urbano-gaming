-- Become a Host (UG-CR-GATE-088) — helpers and application lifecycle functions.
--
-- FUNCTION SECURITY MODEL
-- Every function here is SECURITY INVOKER with a locked search_path. They are
-- executable ONLY by service_role (EXECUTE is revoked from PUBLIC, anon and
-- authenticated for each exact overload), and service_role holds the table
-- privileges and bypasses RLS, so SECURITY DEFINER is not needed. The acting
-- Gaming Member is always an explicit argument supplied by the trusted server
-- from a verified session; each function performs its own authorization against
-- database state (ownership, or an active PRODUCT_GOVERNANCE grant) rather than
-- trusting the caller's claim.
--
-- LOCKING
-- host_scope:<member> serializes every operation on one member's application and
-- capability (submit, withdraw, decide, revoke, create). When a capability is
-- already bound to a competition, revoke additionally takes that competition's
-- competition_scope lock, so a revocation and an in-flight organizer mutation can
-- never interleave. Order is always host_scope -> competition_scope; organizer
-- functions take only competition_scope, so no cycle is possible.

-- ---------------------------------------------------------------------------
-- Helper used by every organizer function: refuse once a host's access to the
-- competition bound to their capability has been revoked. A competition that is
-- not bound to any host capability (every internally created one) is unaffected.
-- ---------------------------------------------------------------------------
create function assert_competition_not_host_revoked(p_competition_id uuid)
returns void
language plpgsql
set search_path = public
as $$
begin
  if exists (
    select 1 from competition_host_capabilities c
    where c.competition_id = p_competition_id and c.state = 'REVOKED'
  ) then
    raise exception 'HOST_ACCESS_REVOKED: this hosting access has been revoked and no longer allows organizer actions on this competition'
      using errcode = 'P0001';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- SUBMIT
-- ---------------------------------------------------------------------------
create function submit_host_application_atomically(
  p_gaming_member_id uuid,
  p_venue_name text,
  p_city_area text,
  p_playing_fields integer,
  p_venue_description text,
  p_expected_window text,
  p_expected_team_count integer,
  p_confirm_all_adults boolean,
  p_confirm_independent_scorekeepers boolean,
  p_confirm_pilot_exclusions boolean
)
returns table (public_code text, state text, submitted_at timestamptz)
language plpgsql
set search_path = public
as $$
declare
  v_venue text := btrim(coalesce(p_venue_name, ''));
  v_city text := btrim(coalesce(p_city_area, ''));
  v_description text := btrim(coalesce(p_venue_description, ''));
  v_window text := btrim(coalesce(p_expected_window, ''));
  v_application_id uuid;
  v_code text;
  v_submitted_at timestamptz;
begin
  if length(v_venue) not between 2 and 80 then
    raise exception 'INVALID_HOST_APPLICATION: venue_name' using errcode = 'P0001';
  end if;
  if length(v_city) not between 2 and 80 then
    raise exception 'INVALID_HOST_APPLICATION: city_area' using errcode = 'P0001';
  end if;
  if p_playing_fields is null or p_playing_fields not between 1 and 50 then
    raise exception 'INVALID_HOST_APPLICATION: playing_fields' using errcode = 'P0001';
  end if;
  if length(v_description) not between 20 and 800 then
    raise exception 'INVALID_HOST_APPLICATION: venue_description' using errcode = 'P0001';
  end if;
  if length(v_window) not between 3 and 100 then
    raise exception 'INVALID_HOST_APPLICATION: expected_window' using errcode = 'P0001';
  end if;
  if p_expected_team_count is null or p_expected_team_count not between 4 and 16 then
    raise exception 'INVALID_HOST_APPLICATION: expected_team_count' using errcode = 'P0001';
  end if;
  if p_confirm_all_adults is distinct from true
     or p_confirm_independent_scorekeepers is distinct from true
     or p_confirm_pilot_exclusions is distinct from true then
    raise exception 'INVALID_HOST_APPLICATION: confirmations' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('host_scope:' || p_gaming_member_id::text));

  perform 1 from gaming_members where gaming_members.gaming_member_id = p_gaming_member_id;
  if not found then
    raise exception 'GAMING_MEMBER_NOT_FOUND: no such Gaming Member' using errcode = 'P0001';
  end if;

  if exists (
    select 1 from competition_host_applications a
    where a.gaming_member_id = p_gaming_member_id and a.state in ('PENDING', 'APPROVED')
  ) then
    raise exception 'HOST_APPLICATION_ALREADY_ACTIVE: you already have a host application that is under review or approved'
      using errcode = 'P0001';
  end if;

  v_submitted_at := now();

  insert into competition_host_applications (
    gaming_member_id, venue_name, city_area, playing_fields, venue_description,
    expected_window, expected_team_count, confirm_all_adults,
    confirm_independent_scorekeepers, confirm_pilot_exclusions, submitted_at
  )
  values (
    p_gaming_member_id, v_venue, v_city, p_playing_fields, v_description,
    v_window, p_expected_team_count, true, true, true, v_submitted_at
  )
  returning competition_host_applications.host_application_id, competition_host_applications.public_code
  into v_application_id, v_code;

  insert into admin_audit_events (
    action_type, actor_kind, actor_id, authority_class_used,
    target_type, target_id, occurred_at, resulting_reference, outcome, reason
  )
  values (
    'HOST_APPLICATION_SUBMITTED', 'GAMING_MEMBER', p_gaming_member_id, null,
    'competition_host_applications', v_application_id, v_submitted_at,
    jsonb_build_object('table', 'competition_host_applications', 'id', v_application_id, 'state', 'PENDING'),
    'SUCCESS', null
  );

  return query select v_code, 'PENDING'::text, v_submitted_at;
end;
$$;

-- ---------------------------------------------------------------------------
-- WITHDRAW — the applicant, and only for their own pending application.
-- ---------------------------------------------------------------------------
create function withdraw_host_application_atomically(
  p_gaming_member_id uuid,
  p_public_code text
)
returns table (public_code text, state text, already_withdrawn boolean)
language plpgsql
set search_path = public
as $$
declare
  v_application_id uuid;
  v_state text;
  v_now timestamptz;
begin
  perform pg_advisory_xact_lock(hashtext('host_scope:' || p_gaming_member_id::text));

  -- Ownership is part of the lookup: someone else's application is
  -- indistinguishable from one that does not exist.
  select a.host_application_id, a.state into v_application_id, v_state
    from competition_host_applications a
   where a.public_code = p_public_code and a.gaming_member_id = p_gaming_member_id
   for update;

  if v_application_id is null then
    raise exception 'HOST_APPLICATION_NOT_FOUND: no such host application' using errcode = 'P0001';
  end if;

  if v_state = 'WITHDRAWN' then
    return query select p_public_code, 'WITHDRAWN'::text, true;
    return;
  end if;

  if v_state <> 'PENDING' then
    raise exception 'HOST_APPLICATION_NOT_PENDING: only a pending application can be withdrawn' using errcode = 'P0001';
  end if;

  v_now := now();
  update competition_host_applications a
     set state = 'WITHDRAWN', withdrawn_at = v_now
   where a.host_application_id = v_application_id;

  insert into admin_audit_events (
    action_type, actor_kind, actor_id, authority_class_used,
    target_type, target_id, occurred_at, previous_reference, resulting_reference, outcome, reason
  )
  values (
    'HOST_APPLICATION_WITHDRAWN', 'GAMING_MEMBER', p_gaming_member_id, null,
    'competition_host_applications', v_application_id, v_now,
    jsonb_build_object('table', 'competition_host_applications', 'id', v_application_id, 'state', 'PENDING'),
    jsonb_build_object('table', 'competition_host_applications', 'id', v_application_id, 'state', 'WITHDRAWN'),
    'SUCCESS', null
  );

  return query select p_public_code, 'WITHDRAWN'::text, false;
end;
$$;

-- ---------------------------------------------------------------------------
-- DECIDE — approve or reject. Only an active PRODUCT_GOVERNANCE member, never
-- the applicant themself. Approval creates exactly one AVAILABLE capability; a
-- replayed approval returns the existing outcome and creates nothing.
-- ---------------------------------------------------------------------------
create function decide_host_application_atomically(
  p_reviewer_gaming_member_id uuid,
  p_public_code text,
  p_decision text,
  p_reason text
)
returns table (public_code text, state text, capability_state text, already_decided boolean)
language plpgsql
set search_path = public
as $$
declare
  v_application_id uuid;
  v_applicant_id uuid;
  v_state text;
  v_capability_id uuid;
  v_capability_state text;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_now timestamptz;
begin
  if p_decision is null or p_decision not in ('APPROVE', 'REJECT') then
    raise exception 'INVALID_HOST_DECISION: decision must be APPROVE or REJECT' using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from authority_grants g
    where g.gaming_member_id = p_reviewer_gaming_member_id
      and g.authority_class = 'PRODUCT_GOVERNANCE' and g.revoked_at is null
  ) then
    raise exception 'GOVERNANCE_AUTHORITY_REQUIRED: only an active Product Governance reviewer may decide a host application'
      using errcode = 'P0001';
  end if;

  if p_decision = 'REJECT' and v_reason is null then
    raise exception 'REASON_REQUIRED: rejecting a host application requires a reason' using errcode = 'P0001';
  end if;

  select a.gaming_member_id into v_applicant_id
    from competition_host_applications a where a.public_code = p_public_code;
  if v_applicant_id is null then
    raise exception 'HOST_APPLICATION_NOT_FOUND: no such host application' using errcode = 'P0001';
  end if;

  if v_applicant_id = p_reviewer_gaming_member_id then
    raise exception 'HOST_SELF_REVIEW_FORBIDDEN: a reviewer cannot decide their own host application' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('host_scope:' || v_applicant_id::text));

  select a.host_application_id, a.state into v_application_id, v_state
    from competition_host_applications a where a.public_code = p_public_code for update;

  if v_state <> 'PENDING' then
    if (v_state = 'APPROVED' and p_decision = 'APPROVE') or (v_state = 'REJECTED' and p_decision = 'REJECT') then
      select c.state into v_capability_state
        from competition_host_capabilities c where c.host_application_id = v_application_id;
      return query select p_public_code, v_state, v_capability_state, true;
      return;
    end if;
    raise exception 'HOST_APPLICATION_ALREADY_DECIDED: this host application has already been decided' using errcode = 'P0001';
  end if;

  v_now := now();

  if p_decision = 'APPROVE' then
    update competition_host_applications a
       set state = 'APPROVED', decided_by_gaming_member_id = p_reviewer_gaming_member_id,
           decided_at = v_now, decision_reason = v_reason
     where a.host_application_id = v_application_id;

    insert into competition_host_capabilities (host_application_id, gaming_member_id, granted_at, granted_by_gaming_member_id)
    values (v_application_id, v_applicant_id, v_now, p_reviewer_gaming_member_id)
    returning competition_host_capabilities.host_capability_id into v_capability_id;

    insert into admin_audit_events (
      action_type, actor_kind, actor_id, authority_class_used,
      target_type, target_id, occurred_at, previous_reference, resulting_reference, outcome, reason
    )
    values (
      'HOST_APPLICATION_APPROVED', 'GAMING_MEMBER', p_reviewer_gaming_member_id, 'PRODUCT_GOVERNANCE',
      'competition_host_applications', v_application_id, v_now,
      jsonb_build_object('table', 'competition_host_applications', 'id', v_application_id, 'state', 'PENDING'),
      jsonb_build_object('table', 'competition_host_capabilities', 'id', v_capability_id, 'state', 'AVAILABLE'),
      'SUCCESS', v_reason
    );

    return query select p_public_code, 'APPROVED'::text, 'AVAILABLE'::text, false;
    return;
  end if;

  update competition_host_applications a
     set state = 'REJECTED', decided_by_gaming_member_id = p_reviewer_gaming_member_id,
         decided_at = v_now, decision_reason = v_reason
   where a.host_application_id = v_application_id;

  insert into admin_audit_events (
    action_type, actor_kind, actor_id, authority_class_used,
    target_type, target_id, occurred_at, previous_reference, resulting_reference, outcome, reason
  )
  values (
    'HOST_APPLICATION_REJECTED', 'GAMING_MEMBER', p_reviewer_gaming_member_id, 'PRODUCT_GOVERNANCE',
    'competition_host_applications', v_application_id, v_now,
    jsonb_build_object('table', 'competition_host_applications', 'id', v_application_id, 'state', 'PENDING'),
    jsonb_build_object('table', 'competition_host_applications', 'id', v_application_id, 'state', 'REJECTED'),
    'SUCCESS', v_reason
  );

  return query select p_public_code, 'REJECTED'::text, null::text, false;
end;
$$;

-- ---------------------------------------------------------------------------
-- REVOKE — an approved-but-unused or active capability. Preserves every row.
-- ---------------------------------------------------------------------------
create function revoke_host_capability_atomically(
  p_reviewer_gaming_member_id uuid,
  p_public_code text,
  p_reason text
)
returns table (public_code text, capability_state text, already_revoked boolean)
language plpgsql
set search_path = public
as $$
declare
  v_application_id uuid;
  v_host_id uuid;
  v_capability_id uuid;
  v_capability_state text;
  v_competition_id uuid;
  v_reason text := nullif(btrim(coalesce(p_reason, '')), '');
  v_now timestamptz;
begin
  if not exists (
    select 1 from authority_grants g
    where g.gaming_member_id = p_reviewer_gaming_member_id
      and g.authority_class = 'PRODUCT_GOVERNANCE' and g.revoked_at is null
  ) then
    raise exception 'GOVERNANCE_AUTHORITY_REQUIRED: only an active Product Governance reviewer may revoke hosting access'
      using errcode = 'P0001';
  end if;

  if v_reason is null then
    raise exception 'REASON_REQUIRED: revoking hosting access requires a reason' using errcode = 'P0001';
  end if;

  select a.host_application_id, a.gaming_member_id into v_application_id, v_host_id
    from competition_host_applications a where a.public_code = p_public_code;
  if v_application_id is null then
    raise exception 'HOST_APPLICATION_NOT_FOUND: no such host application' using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('host_scope:' || v_host_id::text));

  -- The binding cannot change while host_scope is held, so this read is stable.
  select c.competition_id into v_competition_id
    from competition_host_capabilities c where c.host_application_id = v_application_id;

  if v_competition_id is not null then
    perform pg_advisory_xact_lock(hashtext('competition_scope:' || v_competition_id::text));
  end if;

  select c.host_capability_id, c.state into v_capability_id, v_capability_state
    from competition_host_capabilities c where c.host_application_id = v_application_id for update;

  if v_capability_id is null then
    raise exception 'HOST_CAPABILITY_NOT_FOUND: this application has no hosting access to revoke' using errcode = 'P0001';
  end if;

  if v_capability_state = 'REVOKED' then
    return query select p_public_code, 'REVOKED'::text, true;
    return;
  end if;

  v_now := now();
  update competition_host_capabilities c
     set state = 'REVOKED', revoked_at = v_now,
         revoked_by_gaming_member_id = p_reviewer_gaming_member_id, revoke_reason = v_reason
   where c.host_capability_id = v_capability_id;

  insert into admin_audit_events (
    action_type, actor_kind, actor_id, authority_class_used,
    target_type, target_id, occurred_at, previous_reference, resulting_reference, outcome, reason
  )
  values (
    'HOST_CAPABILITY_REVOKED', 'GAMING_MEMBER', p_reviewer_gaming_member_id, 'PRODUCT_GOVERNANCE',
    'competition_host_capabilities', v_capability_id, v_now,
    jsonb_build_object('table', 'competition_host_capabilities', 'id', v_capability_id, 'state', v_capability_state),
    jsonb_build_object('table', 'competition_host_capabilities', 'id', v_capability_id, 'state', 'REVOKED'),
    'SUCCESS', v_reason
  );

  return query select p_public_code, 'REVOKED'::text, false;
end;
$$;

-- ---------------------------------------------------------------------------
-- Grants: exact overloads, service_role only.
-- ---------------------------------------------------------------------------
revoke all on function assert_competition_not_host_revoked(uuid) from public, anon, authenticated;
revoke all on function submit_host_application_atomically(uuid, text, text, integer, text, text, integer, boolean, boolean, boolean) from public, anon, authenticated;
revoke all on function withdraw_host_application_atomically(uuid, text) from public, anon, authenticated;
revoke all on function decide_host_application_atomically(uuid, text, text, text) from public, anon, authenticated;
revoke all on function revoke_host_capability_atomically(uuid, text, text) from public, anon, authenticated;

grant execute on function assert_competition_not_host_revoked(uuid) to service_role;
grant execute on function submit_host_application_atomically(uuid, text, text, integer, text, text, integer, boolean, boolean, boolean) to service_role;
grant execute on function withdraw_host_application_atomically(uuid, text) to service_role;
grant execute on function decide_host_application_atomically(uuid, text, text, text) to service_role;
grant execute on function revoke_host_capability_atomically(uuid, text, text) to service_role;
