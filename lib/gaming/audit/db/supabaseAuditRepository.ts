import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { AuditRepository } from "./auditRepository";
import type { AdminAuditEventRecord, AuditReference } from "../types";

function mapReference(value: unknown): AuditReference | null {
  if (!value || typeof value !== "object") return null;
  const row = value as { table?: unknown; id?: unknown };
  if (typeof row.table !== "string" || typeof row.id !== "string") return null;
  return { table: row.table, id: row.id };
}

function mapEvent(row: any): AdminAuditEventRecord {
  return {
    adminAuditEventId: row.admin_audit_event_id,
    actionType: row.action_type,
    actorKind: row.actor_kind,
    actorId: row.actor_id,
    authorityClassUsed: row.authority_class_used,
    targetType: row.target_type,
    targetId: row.target_id,
    occurredAt: row.occurred_at,
    previousReference: mapReference(row.previous_reference),
    resultingReference: mapReference(row.resulting_reference),
    outcome: row.outcome,
    reason: row.reason,
  };
}

/**
 * Supabase-backed AuditRepository. service_role only, matching every
 * other repository in this codebase — admin_audit_events is reached
 * only through the server, never directly from the browser.
 */
export class SupabaseAuditRepository implements AuditRepository {
  private client: SupabaseClient;

  constructor(supabaseUrl: string, supabaseServiceKey: string) {
    this.client = createClient(supabaseUrl, supabaseServiceKey);
  }

  async listEventsForTarget(targetType: string, targetId: string): Promise<AdminAuditEventRecord[]> {
    const { data, error } = await this.client
      .from("admin_audit_events")
      .select("*")
      .eq("target_type", targetType)
      .eq("target_id", targetId)
      .order("occurred_at");
    if (error) throw error;
    return (data ?? []).map(mapEvent);
  }

  async listAllEvents(): Promise<AdminAuditEventRecord[]> {
    const { data, error } = await this.client
      .from("admin_audit_events")
      .select("*")
      .order("occurred_at");
    if (error) throw error;
    return (data ?? []).map(mapEvent);
  }
}
