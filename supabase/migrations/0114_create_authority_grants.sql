-- Migration: 0114_create_authority_grants
-- Admin Control Plane A0 — Authority & Audit Foundation.
--
-- Represents the three canonical, non-hierarchical platform authority
-- classes (Product/Authority_and_Audit_Foundation.md, ADR-037):
-- OPERATIONAL, CONSEQUENTIAL_FINALIZER, PRODUCT_GOVERNANCE. One row is
-- one effective grant period for one Gaming Member holding one class —
-- not a permissions table, only these three fixed values.
--
-- A Gaming Member may hold multiple classes simultaneously (each its
-- own row), since the classes do not inherit one another. Revocation
-- mutates the same row's revoked_at/revoked_by rather than deleting it
-- or inserting a new row — the full grant period remains queryable on
-- that one row, satisfying "revocation must not delete historical
-- evidence" without needing a separate supersession chain the way
-- match_results needs one (nothing downstream computes a consequence
-- off a grant's historical value the way Prediction scoring is
-- computed off a Result, so that stronger discipline isn't warranted
-- here). Re-granting after revocation inserts a new row, preserving the
-- old period's own end intact.
--
-- text + CHECK for authority_class, matching this schema's own
-- exclusive convention (zero Postgres enum types anywhere).

create table authority_grants (
  authority_grant_id uuid primary key default gen_random_uuid(),
  gaming_member_id uuid not null references gaming_members (gaming_member_id),
  authority_class text not null check (
    authority_class in ('OPERATIONAL', 'CONSEQUENTIAL_FINALIZER', 'PRODUCT_GOVERNANCE')
  ),
  granted_at timestamptz not null default now(),
  granted_by uuid null references gaming_members (gaming_member_id),
  revoked_at timestamptz null,
  revoked_by uuid null references gaming_members (gaming_member_id)
);

create index authority_grants_member_idx on authority_grants (gaming_member_id);

-- At most one ACTIVE grant per (member, class) — re-granting after a
-- revocation is a new row, never a reactivation of the old one.
create unique index authority_grants_active_unique
  on authority_grants (gaming_member_id, authority_class)
  where revoked_at is null;
