-- Migration: 0119_add_finalized_by_to_match_results
-- Admin Control Plane A0 — First Consequential Integration.
--
-- Closes the gap ADR-037 names directly: finalize_match_result_atomically
-- and correct_match_result_atomically have always accepted the acting
-- Gaming Member's identity as p_finalized_by_gaming_member_id and never
-- persisted it. This column is where 0120/0121 will start writing it.
--
-- Nullable — every pre-existing match_results row (all local/production
-- rows finalized before this Slice) has no such actor to record and is
-- never backfilled, matching this schema's own established precedent
-- (Session Capability's declared_capabilities, XP Eligibility's
-- xp_eligible) of leaving historical rows honestly null rather than
-- fabricating provenance that was never actually captured.
--
-- Domain-column actor persistence coexists with, and does not replace,
-- the cross-domain admin_audit_events ledger (0115) — the same split
-- Prize Qualification's own redeemed_by_gaming_member_id already
-- proves works well in this schema.

alter table match_results
  add column finalized_by_gaming_member_id uuid null
  references gaming_members (gaming_member_id);
