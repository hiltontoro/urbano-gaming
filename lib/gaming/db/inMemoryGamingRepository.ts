import { randomUUID } from "crypto";
import type { GamingRepository } from "./gamingRepository";
import type { GamingMemberRecord } from "../types";

/**
 * In-memory GamingRepository for behavioral tests — mirrors
 * lib/session/db/inMemorySessionRepository.ts's role: fast, dependency-
 * free, and independently authoritative for the same invariants the
 * real database enforces (idempotent create).
 */
export class InMemoryGamingRepository implements GamingRepository {
  private membersByAuthUserId = new Map<string, GamingMemberRecord>();

  async resolveGamingMemberByAuthUserId(
    authUserId: string
  ): Promise<GamingMemberRecord | null> {
    return this.membersByAuthUserId.get(authUserId) ?? null;
  }

  async createGamingMember(
    authUserId: string,
    displayName: string
  ): Promise<GamingMemberRecord> {
    // Idempotent under retry/concurrency for the same authUserId,
    // mirroring create_gaming_member_atomically's ON CONFLICT DO
    // NOTHING + re-select: an existing row always wins, never
    // overwritten by a later displayName.
    const existing = this.membersByAuthUserId.get(authUserId);
    if (existing) {
      return existing;
    }

    const record: GamingMemberRecord = {
      gamingMemberId: randomUUID(),
      authUserId,
      displayName,
      createdAt: new Date().toISOString(),
    };

    this.membersByAuthUserId.set(authUserId, record);
    return record;
  }
}
