-- Migration: 0115_create_admin_audit_events
-- Admin Control Plane A0 — Authority & Audit Foundation.
--
-- The thin cross-domain platform audit ledger (Product/Authority_and_
-- Audit_Foundation.md). Domain state (match_results, evaluations,
-- experience_summaries, prize_qualifications, authority_grants itself)
-- remains authoritative for *what* happened; this table records *who*
-- exercised platform authority to make it happen. previous_reference/
-- resulting_reference are bounded {"table", "id"} pointers into that
-- authoritative domain state — never a duplicated before/after blob.
--
-- actor_kind mirrors this Slice's own minimal Actor model: only
-- GAMING_MEMBER and SYSTEM exist. SESSION_HOST is deliberately absent —
-- Session Host actions remain Session-domain evidence (session_events)
-- and are never written here. No producer in this Slice writes a
-- SYSTEM row; the value is reserved, not yet exercised.
--
-- Append-only is an application-layer discipline, not a database-role
-- grant: this schema has no RLS and every write reaches Postgres
-- through the service-role client (matching every other table here),
-- so a GRANT-based restriction would be theater. No application code
-- path issues UPDATE or DELETE against this table — the same posture
-- session_events already relies on for its own append-only guarantee.

create table admin_audit_events (
  admin_audit_event_id uuid primary key default gen_random_uuid(),
  action_type text not null,
  actor_kind text not null check (actor_kind in ('GAMING_MEMBER', 'SYSTEM')),
  actor_id uuid null references gaming_members (gaming_member_id),
  authority_class_used text null check (
    authority_class_used in ('OPERATIONAL', 'CONSEQUENTIAL_FINALIZER', 'PRODUCT_GOVERNANCE')
  ),
  target_type text not null,
  target_id uuid not null,
  occurred_at timestamptz not null default now(),
  previous_reference jsonb null,
  resulting_reference jsonb null,
  outcome text not null check (outcome in ('SUCCESS', 'FAILURE')),
  reason text null,
  constraint admin_audit_events_actor_shape check (
    (actor_kind = 'GAMING_MEMBER' and actor_id is not null)
    or (actor_kind = 'SYSTEM' and actor_id is null)
  )
);

create index admin_audit_events_target_idx on admin_audit_events (target_type, target_id);
create index admin_audit_events_actor_idx on admin_audit_events (actor_id);
