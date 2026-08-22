-- Migration: 0118_create_revoke_platform_authority_atomically
-- Admin Control Plane A0 — Authority & Audit Foundation.
--
-- Ordinary platform authority revocation, PRODUCT_GOVERNANCE-only.
-- Mutates the existing grant row's revoked_at/revoked_by rather than
-- deleting it or superseding it with a new row — the full grant period
-- remains queryable on that one row afterward. Idempotent against the
-- most recent grant row for the (member, class) pair: already-revoked
-- returns the existing revocation rather than raising; no grant of that
-- class ever having existed at all is a genuine not-found.
--
-- Same target-row locking discipline as grant_platform_authority_
-- atomically (0117), for the same reason.

create function revoke_platform_authority_atomically(
  p_revoking_gaming_member_id uuid,
  p_target_gaming_member_id uuid,
  p_authority_class text,
  p_reason text
)
returns table (
  authority_grant_id uuid,
  gaming_member_id uuid,
  authority_class text,
  revoked_at timestamptz,
  already_revoked boolean
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_revoking_is_governance boolean;
  v_grant_id uuid;
  v_existing_revoked_at timestamptz;
  v_revoked_at timestamptz;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'REASON_REQUIRED: authority revocation requires a reason'
      using errcode = 'P0001';
  end if;

  select exists(
    select 1 from authority_grants
    where authority_grants.gaming_member_id = p_revoking_gaming_member_id
      and authority_grants.authority_class = 'PRODUCT_GOVERNANCE'
      and authority_grants.revoked_at is null
  ) into v_revoking_is_governance;

  if not v_revoking_is_governance then
    raise exception 'GOVERNANCE_AUTHORITY_REQUIRED: only an active Product Governance actor may revoke platform authority'
      using errcode = 'P0001';
  end if;

  perform 1 from gaming_members where gaming_members.gaming_member_id = p_target_gaming_member_id for update;
  if not found then
    raise exception 'GAMING_MEMBER_NOT_FOUND: no such Gaming Member'
      using errcode = 'P0001';
  end if;

  select authority_grants.authority_grant_id, authority_grants.revoked_at
    into v_grant_id, v_existing_revoked_at
  from authority_grants
  where authority_grants.gaming_member_id = p_target_gaming_member_id
    and authority_grants.authority_class = p_authority_class
  order by authority_grants.granted_at desc
  limit 1
  for update;

  if v_grant_id is null then
    raise exception 'AUTHORITY_GRANT_NOT_FOUND: no grant of this class exists for this Gaming Member'
      using errcode = 'P0001';
  end if;

  if v_existing_revoked_at is not null then
    return query select v_grant_id, p_target_gaming_member_id, p_authority_class, v_existing_revoked_at, true;
    return;
  end if;

  v_revoked_at := now();

  update authority_grants
     set revoked_at = v_revoked_at,
         revoked_by = p_revoking_gaming_member_id
   where authority_grants.authority_grant_id = v_grant_id;

  insert into admin_audit_events (
    action_type, actor_kind, actor_id, authority_class_used,
    target_type, target_id, occurred_at, previous_reference, outcome, reason
  )
  values (
    'REVOKE_AUTHORITY', 'GAMING_MEMBER', p_revoking_gaming_member_id, 'PRODUCT_GOVERNANCE',
    'authority_grants', v_grant_id, v_revoked_at,
    jsonb_build_object(
      'table', 'authority_grants', 'id', v_grant_id,
      'gamingMemberId', p_target_gaming_member_id, 'authorityClass', p_authority_class
    ),
    'SUCCESS', p_reason
  );

  return query select v_grant_id, p_target_gaming_member_id, p_authority_class, v_revoked_at, false;
end;
$$;
