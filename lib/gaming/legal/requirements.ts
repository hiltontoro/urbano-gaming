import type { LegalAcceptanceRepository } from "./db/legalAcceptanceRepository";
import { publishedEntry } from "./documents";
import type {
  LegalAcceptanceRecord,
  LegalActType,
  LegalDocumentEntry,
  LegalDocumentKey,
  LegalMissingDocument,
  LegalScope,
} from "./types";
import {
  InvalidLegalSubmissionError,
  LEGAL_ACT_OF,
  LEGAL_DOCUMENT_KEYS,
  LegalAgeDeclarationRequiredError,
  LegalConditionsRequiredError,
  LegalDocumentStaleError,
  LegalDocumentsNotPublishedError,
} from "./types";

/** The match a participation is for: its id, and the instant it starts (what the rules of an event are keyed to). */
export interface LegalMatchRef {
  matchId: string;
  kickoffAt: string;
}

/** The three documents a participation in a match needs, and the scope each is published under. */
function scopeOf(key: LegalDocumentKey, match: LegalMatchRef): LegalScope {
  return key === "EVENT_RULES" ? { kind: "EVENT", kickoffAt: match.kickoffAt } : { kind: "GLOBAL" };
}

export interface RequiredDocument {
  key: LegalDocumentKey;
  actType: LegalActType;
  entry: LegalDocumentEntry;
  /** The match an acceptance of this document is recorded against; null for the global documents. */
  scopeMatchId: string | null;
}

export interface Requirements {
  required: RequiredDocument[];
  /** Documents that cannot be accepted because the registry publishes no single, intact, current text for them. */
  unpublished: LegalDocumentKey[];
}

/** What this match needs, from the registry. Nothing is assumed: a document with no single intact current text is unpublished. */
export function resolveRequirements(registry: ReadonlyArray<LegalDocumentEntry>, match: LegalMatchRef): Requirements {
  const required: RequiredDocument[] = [];
  const unpublished: LegalDocumentKey[] = [];
  for (const key of LEGAL_DOCUMENT_KEYS) {
    const entry = publishedEntry(registry, key, scopeOf(key, match));
    if (!entry) {
      unpublished.push(key);
      continue;
    }
    required.push({ key, actType: LEGAL_ACT_OF[key], entry, scopeMatchId: key === "EVENT_RULES" ? match.matchId : null });
  }
  return { required, unpublished };
}

/** Does this stored act cover this exact current text? Same document, same version, same hash, same scope, the right kind of act. */
export function covers(row: LegalAcceptanceRecord, doc: RequiredDocument): boolean {
  return (
    row.documentKey === doc.key &&
    row.documentVersion === doc.entry.version &&
    row.contentSha256 === doc.entry.sha256 &&
    row.scopeMatchId === doc.scopeMatchId &&
    row.actType === doc.actType &&
    (doc.key !== "EVENT_RULES" || row.ageDeclared18 === true)
  );
}

export interface ConditionStatusDocument {
  key: LegalDocumentKey;
  actType: LegalActType;
  version: string;
  locale: string;
  title: string;
  sha256: string;
  scope: LegalScope;
  needsAgeDeclaration: boolean;
  accepted: boolean;
  acceptedAt: string | null;
}

export interface ConditionStatus {
  /** False while any of the three required texts is unpublished: nothing can be accepted, nobody is admitted. */
  published: boolean;
  unpublished: LegalDocumentKey[];
  /** True only when every required text is published AND this member has accepted (or acknowledged) each of them. */
  satisfied: boolean;
  documents: ConditionStatusDocument[];
}

export async function conditionStatus(
  repo: LegalAcceptanceRepository,
  registry: ReadonlyArray<LegalDocumentEntry>,
  match: LegalMatchRef,
  gamingMemberId: string
): Promise<ConditionStatus> {
  const { required, unpublished } = resolveRequirements(registry, match);
  const rows = required.length > 0 ? await repo.listForMember(gamingMemberId, match.matchId) : [];
  const documents = required.map((doc): ConditionStatusDocument => {
    const row = rows.find((candidate) => covers(candidate, doc));
    return {
      key: doc.key,
      actType: doc.actType,
      version: doc.entry.version,
      locale: doc.entry.locale,
      title: doc.entry.content.title,
      sha256: doc.entry.sha256,
      scope: doc.entry.scope,
      needsAgeDeclaration: doc.key === "EVENT_RULES",
      accepted: row !== undefined,
      acceptedAt: row ? row.acceptedAt : null,
    };
  });
  return {
    published: unpublished.length === 0,
    unpublished,
    satisfied: unpublished.length === 0 && documents.every((document) => document.accepted),
    documents,
  };
}

function missingOf(status: ConditionStatus): LegalMissingDocument[] {
  return [
    ...status.unpublished.map((documentKey) => ({ documentKey, documentVersion: null })),
    ...status.documents.filter((document) => !document.accepted).map((document) => ({ documentKey: document.key, documentVersion: document.version })),
  ];
}

/**
 * The admission check. Throws when a required text is not published (nobody can be admitted) or when this member has not accepted the
 * current version of each one. It is not called for an exact replay of a participation that already exists: that is not an admission.
 */
export async function assertConditionsAccepted(
  repo: LegalAcceptanceRepository,
  registry: ReadonlyArray<LegalDocumentEntry>,
  match: LegalMatchRef,
  gamingMemberId: string
): Promise<void> {
  const status = await conditionStatus(repo, registry, match, gamingMemberId);
  if (!status.published) throw new LegalDocumentsNotPublishedError(missingOf(status));
  if (!status.satisfied) throw new LegalConditionsRequiredError(missingOf(status));
}

/** What the admission step needs: one question, asked only when a participation is genuinely new or genuinely edited. */
export interface AdmissionGate {
  assertConditions(): Promise<void>;
}

export function makeAdmissionGate(input: {
  repo: LegalAcceptanceRepository;
  registry: ReadonlyArray<LegalDocumentEntry>;
  match: LegalMatchRef;
  gamingMemberId: string;
}): AdmissionGate {
  return { assertConditions: () => assertConditionsAccepted(input.repo, input.registry, input.match, input.gamingMemberId) };
}

export interface SubmittedAcceptance {
  documentKey: string;
  documentVersion: string;
  contentSha256: string;
  ageDeclared18?: boolean;
}

/**
 * Records the acts a member submits for a match. Each one must name the CURRENT version and the exact hash of the text the member was
 * shown (a stale version or a different text is refused, never silently re-pointed), EVENT_RULES must carry the declaration of being 18 or
 * older, and a document the registry does not publish cannot be accepted. The write is idempotent: asking again records nothing new.
 */
export async function acceptConditions(
  repo: LegalAcceptanceRepository,
  registry: ReadonlyArray<LegalDocumentEntry>,
  match: LegalMatchRef,
  gamingMemberId: string,
  submitted: SubmittedAcceptance[]
): Promise<{ recorded: number; alreadyRecorded: number; status: ConditionStatus }> {
  const { required, unpublished } = resolveRequirements(registry, match);
  if (unpublished.length > 0) {
    throw new LegalDocumentsNotPublishedError(unpublished.map((documentKey) => ({ documentKey, documentVersion: null })));
  }
  if (submitted.length === 0) throw new InvalidLegalSubmissionError("Name at least one document to accept.");

  const seen = new Set<string>();
  const stale: LegalMissingDocument[] = [];
  const toWrite: Array<{ doc: RequiredDocument; ageDeclared18: boolean | null }> = [];
  for (const item of submitted) {
    const doc = required.find((candidate) => candidate.key === item.documentKey);
    if (!doc) throw new InvalidLegalSubmissionError(`"${String(item.documentKey)}" is not a document of this event.`);
    if (seen.has(doc.key)) throw new InvalidLegalSubmissionError(`"${doc.key}" is named twice.`);
    seen.add(doc.key);
    if (item.documentVersion !== doc.entry.version || item.contentSha256 !== doc.entry.sha256) {
      stale.push({ documentKey: doc.key, documentVersion: doc.entry.version });
      continue;
    }
    if (doc.key === "EVENT_RULES") {
      if (item.ageDeclared18 !== true) throw new LegalAgeDeclarationRequiredError();
      toWrite.push({ doc, ageDeclared18: true });
    } else {
      if (item.ageDeclared18 !== undefined) throw new InvalidLegalSubmissionError(`"${doc.key}" takes no age declaration.`);
      toWrite.push({ doc, ageDeclared18: null });
    }
  }
  if (stale.length > 0) throw new LegalDocumentStaleError(stale);

  let recorded = 0;
  let alreadyRecorded = 0;
  for (const { doc, ageDeclared18 } of toWrite) {
    const result = await repo.recordAcceptance({
      gamingMemberId,
      documentKey: doc.key,
      documentVersion: doc.entry.version,
      contentSha256: doc.entry.sha256,
      actType: doc.actType,
      scopeMatchId: doc.scopeMatchId,
      ageDeclared18,
      locale: doc.entry.locale,
      source: "PRE_PARTICIPATION",
    });
    if (result.alreadyRecorded) alreadyRecorded += 1;
    else recorded += 1;
  }
  return { recorded, alreadyRecorded, status: await conditionStatus(repo, registry, match, gamingMemberId) };
}
