import type { LegalAcceptanceRecord, LegalActType, LegalDocumentKey, LegalLocale } from "../types";

export interface RecordLegalAcceptanceInput {
  gamingMemberId: string;
  documentKey: LegalDocumentKey;
  documentVersion: string;
  contentSha256: string;
  actType: LegalActType;
  /** The match of an EVENT_RULES acceptance; null for the global documents. */
  scopeMatchId: string | null;
  /** True for EVENT_RULES, null for the others. */
  ageDeclared18: boolean | null;
  locale: LegalLocale;
  source: "PRE_PARTICIPATION";
}

/**
 * Where acceptances are kept. Append-only: there is no update and no delete here. The single writer is idempotent and safe under
 * concurrency — the same act asked twice, or at the same moment, is one row and the same answer.
 */
export interface LegalAcceptanceRepository {
  /** Records the act, or returns the row that already records it (alreadyRecorded). A different hash for an existing version throws LegalAcceptanceHashConflictError. */
  recordAcceptance(input: RecordLegalAcceptanceInput): Promise<{ record: LegalAcceptanceRecord; alreadyRecorded: boolean }>;
  /**
   * Every acceptance of one member: the global ones and, when a match is given, those scoped to that match (rows scoped to other matches are
   * left out); with no match, all of the member's rows.
   */
  listForMember(gamingMemberId: string, scopeMatchId?: string | null): Promise<LegalAcceptanceRecord[]>;
}
