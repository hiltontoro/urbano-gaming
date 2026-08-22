import type { AdminAuditEventRecord } from "../types";

/**
 * Read-only by design. Every write in this Slice happens inside the
 * same Postgres transaction as the consequential action it audits
 * (bootstrap/grant/revoke/finalize/correct each insert their own
 * admin_audit_events row directly) — there is no case yet where
 * TypeScript issues an audit write independent of a domain RPC, so no
 * write method exists here to leave unused. This interface exists for
 * inspection: tests verifying what was written, and a future read-only
 * Admin surface.
 */
export interface AuditRepository {
  listEventsForTarget(targetType: string, targetId: string): Promise<AdminAuditEventRecord[]>;
  listAllEvents(): Promise<AdminAuditEventRecord[]>;
}
