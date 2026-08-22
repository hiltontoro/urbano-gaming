-- Migration: 0116_create_bootstrap_governance_authority_atomically
-- Admin Control Plane A0 — Authority & Audit Foundation.
--
-- The one-time root bootstrap (Product/Authority_and_Audit_Foundation.md,
-- "Root / Governance Bootstrap"). Establishing the very first
-- PRODUCT_GOVERNANCE authority is a bootstrap problem: ordinary grant
-- requires an existing Governance actor, and none exists yet. This
-- function is never exposed through any HTTP route — invoked only by
-- direct service-role call, exactly matching how gaming_admins rows are
-- seeded today. It self-limits by checking evidence (no active
-- PRODUCT_GOVERNANCE grant exists) rather than a separately persisted
-- "used" flag, following this schema's own established lock-from-
-- evidence convention (Activity Classification, Session Capability). It
-- is not dropped after use; it simply refuses once evidence shows
-- Governance already exists — it is not a standing alternative to the
-- ordinary grant/revoke workflow after that point.
--
-- granted_by is left null on the bootstrap row itself: no prior actor
-- granted it in the ordinary sense (mirroring gaming_admins.granted_by's
-- own nullable shape for exactly this "no clear granter" case). The
-- audit event's own actor_id still attributes the bootstrap action to
-- the Gaming Member who performed it. authority_class_used is left
-- null on that event: the actor held no established class at the
-- moment they invoked bootstrap — that is the entire point of it.
--
-- pg_advisory_xact_lock serializes concurrent bootstrap attempts against
-- each other. A permanent uniqueness constraint was deliberately not
-- used instead: canonical authority allows more than one Gaming Member
-- to hold PRODUCT_GOVERNANCE over time via ordinary grants after
-- bootstrap, so "at most one PRODUCT_GOVERNANCE grant ever" would be
-- wrong as a standing invariant — only "at most one bootstrap" needs
-- serializing, and only for the brief window before the first grant
-- exists to check against.

create function bootstrap_governance_authority_atomically(
  p_gaming_member_id uuid,
  p_reason text
)
returns table (
  authority_grant_id uuid,
  gaming_member_id uuid,
  authority_class text,
  granted_at timestamptz
)
language plpgsql
security invoker
set search_path = public
as $$
declare
  v_governance_exists boolean;
  v_new_grant_id uuid;
  v_granted_at timestamptz;
begin
  if p_reason is null or length(trim(p_reason)) = 0 then
    raise exception 'REASON_REQUIRED: bootstrap requires a reason'
      using errcode = 'P0001';
  end if;

  perform pg_advisory_xact_lock(hashtext('bootstrap_governance_authority_atomically'));

  select exists(
    select 1 from authority_grants
    where authority_grants.authority_class = 'PRODUCT_GOVERNANCE'
      and authority_grants.revoked_at is null
  ) into v_governance_exists;

  if v_governance_exists then
    raise exception 'GOVERNANCE_ALREADY_BOOTSTRAPPED: platform governance authority already exists'
      using errcode = 'P0001';
  end if;

  if not exists (
    select 1 from gaming_members where gaming_members.gaming_member_id = p_gaming_member_id
  ) then
    raise exception 'GAMING_MEMBER_NOT_FOUND: no such Gaming Member'
      using errcode = 'P0001';
  end if;

  v_granted_at := now();

  insert into authority_grants (gaming_member_id, authority_class, granted_at, granted_by)
  values (p_gaming_member_id, 'PRODUCT_GOVERNANCE', v_granted_at, null)
  returning authority_grants.authority_grant_id into v_new_grant_id;

  insert into admin_audit_events (
    action_type, actor_kind, actor_id, authority_class_used,
    target_type, target_id, occurred_at, resulting_reference, outcome, reason
  )
  values (
    'BOOTSTRAP_GOVERNANCE_GRANT', 'GAMING_MEMBER', p_gaming_member_id, null,
    'authority_grants', v_new_grant_id, v_granted_at,
    jsonb_build_object('table', 'authority_grants', 'id', v_new_grant_id),
    'SUCCESS', p_reason
  );

  return query select v_new_grant_id, p_gaming_member_id, 'PRODUCT_GOVERNANCE'::text, v_granted_at;
end;
$$;
