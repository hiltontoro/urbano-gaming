import type { PlatformAuthorityClass } from "../authority/types";

export type AuditActorKind = "GAMING_MEMBER" | "SYSTEM";

/** A bounded pointer into authoritative domain state — never a duplicated blob. */
export interface AuditReference {
  table: string;
  id: string;
}

export interface AdminAuditEventRecord {
  adminAuditEventId: string;
  actionType: string;
  actorKind: AuditActorKind;
  actorId: string | null;
  authorityClassUsed: PlatformAuthorityClass | null;
  targetType: string;
  targetId: string;
  occurredAt: string;
  previousReference: AuditReference | null;
  resultingReference: AuditReference | null;
  outcome: "SUCCESS" | "FAILURE";
  reason: string | null;
}
