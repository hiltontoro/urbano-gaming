import { randomUUID } from "node:crypto";

import type { LegalAcceptanceRecord } from "../types";
import { LegalAcceptanceHashConflictError } from "../types";
import type { LegalAcceptanceRepository, RecordLegalAcceptanceInput } from "./legalAcceptanceRepository";

/**
 * In-memory twin of the Supabase repository, with the same uniqueness: one row per member, document, version and scope, where a NULL scope
 * (the global documents) counts as a scope like any other — the very case a plain SQL UNIQUE would let through.
 */
export class InMemoryLegalAcceptanceRepository implements LegalAcceptanceRepository {
  private rows: LegalAcceptanceRecord[] = [];

  async recordAcceptance(input: RecordLegalAcceptanceInput) {
    const existing = this.rows.find(
      (row) =>
        row.gamingMemberId === input.gamingMemberId &&
        row.documentKey === input.documentKey &&
        row.documentVersion === input.documentVersion &&
        row.scopeMatchId === input.scopeMatchId
    );
    if (existing) {
      if (existing.contentSha256 !== input.contentSha256) throw new LegalAcceptanceHashConflictError();
      return { record: { ...existing }, alreadyRecorded: true };
    }
    const record: LegalAcceptanceRecord = {
      legalAcceptanceId: randomUUID(),
      gamingMemberId: input.gamingMemberId,
      documentKey: input.documentKey,
      documentVersion: input.documentVersion,
      contentSha256: input.contentSha256,
      actType: input.actType,
      scopeMatchId: input.scopeMatchId,
      ageDeclared18: input.ageDeclared18,
      locale: input.locale,
      source: input.source,
      acceptedAt: new Date().toISOString(),
    };
    this.rows.push(record);
    return { record: { ...record }, alreadyRecorded: false };
  }

  async listForMember(gamingMemberId: string, scopeMatchId?: string | null) {
    return this.rows
      .filter((row) => row.gamingMemberId === gamingMemberId)
      .filter((row) => scopeMatchId === undefined || row.scopeMatchId === null || row.scopeMatchId === scopeMatchId)
      .map((row) => ({ ...row }));
  }

  /** Test seam: how many rows exist, to prove that repeats and concurrent requests wrote exactly one. */
  count(): number {
    return this.rows.length;
  }
}
