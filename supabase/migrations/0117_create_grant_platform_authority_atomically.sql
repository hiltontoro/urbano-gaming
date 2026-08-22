-- Migration: 0117_create_grant_platform_authority_atomically
-- Admin Control Plane A0 — Authority & Audit Foundation.
--
-- Ordinary platform authority grant, PRODUCT_GOVERNANCE-only after
-- bootstrap. Not exposed through any HTTP route in this Slice — invoked
-- directly by tooling/tests, exactly like bootstrap. Idempotent: a
-- grant already active for the same (member, class) returns that
-- existing grant rather than raising or inserting a duplicate row (the
-- partial unique index on authority_grants would reject a duplicate
-- insert anyway; this makes the intended idempotent behavior explicit
-- rather than surfacing as a raw constraint violation).
--
-- Locks the target gaming_members row for the duration of the
-- transaction before checking/inserting — the same "lock the parent
-- entity a child relationship is scoped to" discipline
-- join_participant_atomically already applies to sessions before
-- inserting a participant, applied here to the Gaming Member a grant
-- is scoped to. This serializes concurrent grant/revoke calls
-- targeting the same member; concurrent calls targeting different
-- members never conflict, matching that same precedent's own scope.

create function grant_platform_authority_atomically(
  p_granting_gaming_member_id uuid,
  p_target_gaming_member_id uuid,
  p_authority_class text,
  p_reason text
)
returns table (
  authority_grant_id uuid,
  gaming_member_id uuid,
  authority_class text,
  granted_at timestamptz,
  already_active boolean
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_granting_is_governance boolean;
  v_existing_grant_id uuid;
  v_existing_granted_at timestamptz;
  v_new_grant_id uuid;
  v_granted_at timestamptz;
begin
  if p_authority_class not in ('OPERATIONAL', 'CONSEQUENTIAL_FINALIZER', 'PRODUCT_GOVERNANCE') then
    raise exception 'INVALID_AUTHORITY_CLASS: % is not a recognized platform authority class', p_authority_class
      using errcode = 'P0001';
  end if;

  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'REASON_REQUIRED: authority grant requires a reason'
      using errcode = 'P0001';
  end if;

  select exists(
    select 1 from authority_grants
    where authority_grants.gaming_member_id = p_granting_gaming_member_id
      and authority_grants.authority_class = 'PRODUCT_GOVERNANCE'
      and authority_grants.revoked_at is null
  ) into v_granting_is_governance;

  if not v_granting_is_governance then
    raise exception 'GOVERNANCE_AUTHORITY_REQUIRED: only an active Product Governance actor may grant platform authority'
      using errcode = 'P0001';
  end if;

  perform 1 from gaming_members where gaming_members.gaming_member_id = p_target_gaming_member_id for update;
  if not found then
    raise exception 'GAMING_MEMBER_NOT_FOUND: no such Gaming Member'
      using errcode = 'P0001';
  end if;

  select authority_grants.authority_grant_id, authority_grants.granted_at
    into v_existing_grant_id, v_existing_granted_at
  from authority_grants
  where authority_grants.gaming_member_id = p_target_gaming_member_id
    and authority_grants.authority_class = p_authority_class
    and authority_grants.revoked_at is null;

  if v_existing_grant_id is not null then
    return query select v_existing_grant_id, p_target_gaming_member_id, p_authority_class, v_existing_granted_at, true;
    return;
  end if;

  v_granted_at := now();

  insert into authority_grants (gaming_member_id, authority_class, granted_at, granted_by)
  values (p_target_gaming_member_id, p_authority_class, v_granted_at, p_granting_gaming_member_id)
  returning authority_grants.authority_grant_id into v_new_grant_id;

  insert into admin_audit_events (
    action_type, actor_kind, actor_id, authority_class_used,
    target_type, target_id, occurred_at, resulting_reference, outcome, reason
  )
  values (
    'GRANT_AUTHORITY', 'GAMING_MEMBER', p_granting_gaming_member_id, 'PRODUCT_GOVERNANCE',
    'authority_grants', v_new_grant_id, v_granted_at,
    jsonb_build_object(
      'table', 'authority_grants', 'id', v_new_grant_id,
      'gamingMemberId', p_target_gaming_member_id, 'authorityClass', p_authority_class
    ),
    'SUCCESS', p_reason
  );

  return query select v_new_grant_id, p_target_gaming_member_id, p_authority_class, v_granted_at, false;
end;
$$;
