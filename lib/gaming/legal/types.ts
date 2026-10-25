/**
 * Legal texts and the record of who accepted which version of them.
 *
 * Three documents, three different acts — kept apart on purpose:
 *   ACCOUNT_TERMS    accepted (ACCEPTANCE)
 *   EVENT_RULES      accepted (ACCEPTANCE), for ONE event, together with the member's declaration of being 18 or older
 *   PRIVACY_NOTICE   READ (READ_ACKNOWLEDGMENT): the member confirms having read it. That is an acknowledgment of information; it is never
 *                    presented, stored or worded as a consent to any processing, and there is no marketing consent anywhere in this module.
 */

export const LEGAL_DOCUMENT_KEYS = ["ACCOUNT_TERMS", "PRIVACY_NOTICE", "EVENT_RULES"] as const;
export type LegalDocumentKey = (typeof LEGAL_DOCUMENT_KEYS)[number];

export type LegalActType = "ACCEPTANCE" | "READ_ACKNOWLEDGMENT";

/** The act each document asks for. The database checks the same pairing. */
export const LEGAL_ACT_OF: Record<LegalDocumentKey, LegalActType> = {
  ACCOUNT_TERMS: "ACCEPTANCE",
  EVENT_RULES: "ACCEPTANCE",
  PRIVACY_NOTICE: "READ_ACKNOWLEDGMENT",
};

export type LegalLocale = "es" | "en";

/**
 * A document is data, not markup: a list of typed blocks. The page renders every string as text (never as HTML), so a text can never carry
 * script, and what the member was shown is exactly what is hashed.
 */
export type LegalBlock =
  | { kind: "heading"; text: string }
  | { kind: "paragraph"; text: string }
  | { kind: "list"; items: string[] }
  | { kind: "table"; header: string[]; rows: string[][] };

export interface LegalDocumentContent {
  title: string;
  blocks: LegalBlock[];
}

/** GLOBAL: the same text for every event. EVENT: the rules of the match that starts at exactly this instant. */
export type LegalScope = { kind: "GLOBAL" } | { kind: "EVENT"; kickoffAt: string };

/** One published version of one document. A published version is immutable: a change is a new version. */
export interface LegalDocumentEntry {
  key: LegalDocumentKey;
  version: string;
  locale: LegalLocale;
  scope: LegalScope;
  /** Exactly one entry per (key, scope) is current; the older versions stay readable. */
  current: boolean;
  /** SHA-256 of the canonical form of `content` (see hashDocument). Pinned here, recomputed on every use. */
  sha256: string;
  content: LegalDocumentContent;
}

export interface LegalAcceptanceRecord {
  legalAcceptanceId: string;
  gamingMemberId: string;
  documentKey: LegalDocumentKey;
  documentVersion: string;
  contentSha256: string;
  actType: LegalActType;
  /** The match an EVENT_RULES acceptance belongs to; null for the global documents. */
  scopeMatchId: string | null;
  /** True on EVENT_RULES (the declaration of being 18 or older); null on the other documents. */
  ageDeclared18: boolean | null;
  locale: LegalLocale;
  source: "PRE_PARTICIPATION";
  acceptedAt: string;
}

/** What the server reports a member is still missing, by document. */
export interface LegalMissingDocument {
  documentKey: LegalDocumentKey;
  documentVersion: string | null;
}

/** Base of the errors that stop a participation because the conditions are not in place. They answer 409, with a code the page understands. */
export abstract class LegalConditionsError extends Error {
  abstract readonly code: string;
  readonly missing: LegalMissingDocument[];
  constructor(message: string, missing: LegalMissingDocument[]) {
    super(message);
    this.missing = missing;
  }
}

/** A required text is not published (or not intact): nobody can accept it, so nobody can be admitted. Fail closed. */
export class LegalDocumentsNotPublishedError extends LegalConditionsError {
  readonly code = "LEGAL_DOCUMENTS_NOT_PUBLISHED";
  constructor(missing: LegalMissingDocument[]) {
    super("The conditions for this event have not been published yet.", missing);
    this.name = "LegalDocumentsNotPublishedError";
  }
}

/** The current texts are published but this member has not accepted (or acknowledged) all of them. */
export class LegalConditionsRequiredError extends LegalConditionsError {
  readonly code = "LEGAL_CONDITIONS_REQUIRED";
  constructor(missing: LegalMissingDocument[]) {
    super("The current conditions must be accepted before taking part.", missing);
    this.name = "LegalConditionsRequiredError";
  }
}

/** The member answered for a version or a text that is no longer (or never was) the current one. */
export class LegalDocumentStaleError extends LegalConditionsError {
  readonly code = "LEGAL_DOCUMENT_STALE";
  constructor(missing: LegalMissingDocument[]) {
    super("The text you were shown is no longer the current one.", missing);
    this.name = "LegalDocumentStaleError";
  }
}

/** The event rules were submitted without the declaration of being 18 or older. */
export class LegalAgeDeclarationRequiredError extends Error {
  constructor() {
    super("The declaration of being 18 or older is required.");
    this.name = "LegalAgeDeclarationRequiredError";
  }
}

/** The request did not have the shape the acceptance route takes. */
export class InvalidLegalSubmissionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidLegalSubmissionError";
  }
}

/** The same version was recorded for a different text: a published version is immutable, so this is never a normal state. */
export class LegalAcceptanceHashConflictError extends Error {
  constructor() {
    super("This version was recorded for a different text.");
    this.name = "LegalAcceptanceHashConflictError";
  }
}
