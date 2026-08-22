import { randomUUID } from "crypto";
import type { AuditRepository } from "./auditRepository";
import type { AdminAuditEventRecord } from "../types";

/**
 * In-memory admin_audit_events for behavioral tests. Unlike every other
 * in-memory repository in this codebase, this one is meant to be shared
 * across two different domain repositories (InMemoryAuthorityRepository
 * and InMemoryPredictionsRepository) — both write into the SAME ledger
 * in real Postgres, so their in-memory counterparts must too. record()
 * is the internal write path each in-memory repository calls directly
 * (there is no RPC to hide it inside, unlike Postgres); the
 * AuditRepository read methods are what tests use to inspect the
 * result, exactly mirroring how the real ledger is read.
 */
export class InMemoryAuditStore implements AuditRepository {
  private events: AdminAuditEventRecord[] = [];

  record(event: Omit<AdminAuditEventRecord, "adminAuditEventId" | "occurredAt">): AdminAuditEventRecord {
    const full: AdminAuditEventRecord = {
      adminAuditEventId: randomUUID(),
      occurredAt: new Date().toISOString(),
      ...event,
    };
    this.events.push(full);
    return full;
  }

  async listEventsForTarget(targetType: string, targetId: string): Promise<AdminAuditEventRecord[]> {
    return this.events.filter((e) => e.targetType === targetType && e.targetId === targetId);
  }

  async listAllEvents(): Promise<AdminAuditEventRecord[]> {
    return [...this.events];
  }
}
