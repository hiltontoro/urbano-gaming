import { CommunityVotingError, isUuidLike } from "../types";
import { validateGeofenceConfig, validateLocationClaim } from "../eligibility";
import { sanitizeJpeg } from "./jpeg";
import { parseOperatorAllowlist } from "./operatorAuth";
import {
  FINAL_WINDOW_SECONDS,
  GALLERY_CONSENT_SHA256,
  GALLERY_CONSENT_VERSION,
  PROMO_CONSENT_SHA256,
  PROMO_CONSENT_VERSION,
} from "./constants";
import type { RoundsRepository } from "./repository";
import type { OperatorContext, PhotoDecision, PolicyKey, PromoDecision, RoundInstanceRecord, RoundRole, ScheduleInput } from "./types";

/**
 * Operator-side operations of the two-round pilot. Thin by design: each validates the SHAPE of a request, supplies the server-owned
 * constants (the consent texts' digests, the final's window, the photograph limits) and hands ONE atomic operation to the repository.
 * The database is the authority for every rule (host token, designated operator, readiness, the freeze once voting opens, the
 * deterministic cut, the review before publication).
 */

const FULL_LIMITS = { maxBytes: 1_500_000, maxLongSide: 2400 };
const THUMB_LIMITS = { maxBytes: 150_000, maxLongSide: 480 };

const invalid = (message: string) => new CommunityVotingError("INVALID_REQUEST", message);

function asObject(body: unknown): Record<string, unknown> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) throw invalid("A JSON object body is required.");
  return body as Record<string, unknown>;
}
function requireEntryId(value: unknown): string {
  if (!isUuidLike(value)) throw new CommunityVotingError("ENTRY_NOT_FOUND", "This event has no such entry.");
  return value;
}
function requireUuid(value: unknown, what: string): string {
  if (!isUuidLike(value)) throw invalid(`${what} must be an id.`);
  return value;
}

// ---------------------------------------------------------------- registration

/**
 * Registers one round for a Session, designating the CALLER as its one operator. Only a Gaming Member on the configured allow-list may
 * do so; with no valid allow-list nobody can (fail closed). A preliminary takes nothing else; a final takes its preliminary and the
 * venue's geofence (no default: the venue's real values are the venue's to give) and always gets the contractual five-minute window.
 */
export async function registerCommunityVotingRound(
  repo: RoundsRepository,
  input: { body: unknown; hostToken: string; operatorMemberId: string; allowlistRaw: string | undefined; windowSeconds?: number }
): Promise<RoundInstanceRecord> {
  const allowlist = parseOperatorAllowlist(input.allowlistRaw);
  if (!allowlist) throw new CommunityVotingError("OPERATOR_NOT_CONFIGURED", "The activation operator is not configured.");
  if (!allowlist.has(input.operatorMemberId.toLowerCase())) {
    throw new CommunityVotingError("OPERATOR_REQUIRED", "Only the designated operator may do this.");
  }

  const b = asObject(input.body);
  const sessionId = requireUuid(b.sessionId, "sessionId");
  const ruleVersion = b.ruleVersion === undefined ? 1 : b.ruleVersion;
  if (typeof ruleVersion !== "number" || !Number.isInteger(ruleVersion) || ruleVersion < 1) throw invalid("ruleVersion must be a positive integer.");
  if (b.roundRole !== "PRELIMINARY" && b.roundRole !== "FINAL") throw invalid("roundRole must be PRELIMINARY or FINAL.");
  const roundRole: RoundRole = b.roundRole;
  // A test (rehearsal) event is chosen here and only here: the database fixes it at registration. Only the boolean true makes one.
  if (b.testMode !== undefined && typeof b.testMode !== "boolean") throw invalid("testMode must be true or false.");
  const testMode = b.testMode === true;

  if (roundRole === "PRELIMINARY") {
    if (b.sourceInstanceId !== undefined || b.venue !== undefined) throw invalid("A preliminary has no source and no venue: it is voted from anywhere.");
    return repo.registerRound({
      sessionId, hostToken: input.hostToken, operatorMemberId: input.operatorMemberId, ruleVersion,
      roundRole, sourceInstanceId: null, venue: null, windowSeconds: null, testMode,
    });
  }

  const sourceInstanceId = requireUuid(b.sourceInstanceId, "sourceInstanceId");
  const venue = validateGeofenceConfig(b.venue);
  return repo.registerRound({
    sessionId, hostToken: input.hostToken, operatorMemberId: input.operatorMemberId, ruleVersion,
    roundRole, sourceInstanceId, venue, windowSeconds: input.windowSeconds ?? FINAL_WINDOW_SECONDS, testMode,
  });
}

// ---------------------------------------------------------------- the final's geofence (configuration until the final opens, frozen afterwards)

/**
 * Saves the final's venue geofence. The body is { venue: { the six numbers } } and NOTHING else of it is read: the Instance is the one in the
 * URL, the operator is the verified caller, and no id, flag or role in the body can redirect or widen the save. The database decides whether it
 * may happen (the designated operator, a final, never opened — serialized with the opening) and records who, when, old and new.
 */
export async function configureFinalGeofence(repo: RoundsRepository, ctx: OperatorContext, body: unknown) {
  const b = asObject(body);
  const venue = validateGeofenceConfig(b.venue);
  return repo.configureFinalGeofence({ ...ctx, venue });
}

/**
 * Evaluates ONE reading with the vote's own evaluator against the stored geofence — validated exactly as a vote's reading is, then handed to a
 * database function that cannot write. The reading is a parameter of this call only: no operation here stores, logs or echoes it.
 */
export async function testFinalGeofence(repo: RoundsRepository, ctx: OperatorContext, body: unknown) {
  const b = asObject(body);
  const location = validateLocationClaim(b.location);
  return repo.testFinalGeofence({ ...ctx, location });
}

// ---------------------------------------------------------------- schedule (configuration until the round opens, binding afterwards)

function parseTime(value: unknown, name: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || value.length < 10) throw invalid(`${name} must be a date-time or null.`);
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) throw invalid(`${name} must be a date-time or null.`);
  return new Date(ms).toISOString();
}

export function setRoundSchedule(repo: RoundsRepository, ctx: OperatorContext, body: unknown) {
  const b = asObject(body);
  if (b.status !== "TENTATIVE" && b.status !== "CONFIRMED") throw invalid("status must be TENTATIVE or CONFIRMED.");
  const schedule: ScheduleInput = {
    registrationOpensAt: parseTime(b.registrationOpensAt, "registrationOpensAt"),
    contestantCutoffAt: parseTime(b.contestantCutoffAt, "contestantCutoffAt"),
    votingOpensAt: parseTime(b.votingOpensAt, "votingOpensAt"),
    votingClosesAt: parseTime(b.votingClosesAt, "votingClosesAt"),
    status: b.status,
  };
  return repo.setRoundSchedule({ ...ctx, schedule });
}

// ---------------------------------------------------------------- entries, photographs, consents, decisions

export function createEntry(repo: RoundsRepository, ctx: OperatorContext, body: unknown) {
  const b = body === undefined || body === null ? {} : asObject(body);
  let claimTtlSeconds: number | undefined;
  if (b.claimTtlSeconds !== undefined) {
    if (typeof b.claimTtlSeconds !== "number" || !Number.isInteger(b.claimTtlSeconds) || b.claimTtlSeconds < 1 || b.claimTtlSeconds > 86400) {
      throw invalid("The claim window must be between 1 and 86400 seconds.");
    }
    claimTtlSeconds = b.claimTtlSeconds;
  }
  return repo.createRoundEntry({ ...ctx, claimTtlSeconds });
}

export function removeEntry(repo: RoundsRepository, ctx: OperatorContext, entryId: unknown) {
  return repo.removeRoundEntry({ ...ctx, entryId: requireEntryId(entryId) });
}

function decodeImage(value: unknown): Buffer {
  if (typeof value !== "string" || value.length === 0) throw invalid("Both renditions of the photograph are required as base64.");
  if (value.length > 2_300_000) throw new CommunityVotingError("PHOTO_INVALID", "The photograph is too large.");
  if (!/^[A-Za-z0-9+/=\s]+$/.test(value)) throw new CommunityVotingError("PHOTO_INVALID", "The photograph is not valid base64.");
  return Buffer.from(value, "base64");
}

/** The server never trusts the browser's re-encoding: both renditions are re-parsed as JPEG and REBUILT without any EXIF, application or comment segment. */
export async function uploadEntryPhoto(repo: RoundsRepository, ctx: OperatorContext, entryId: unknown, body: unknown) {
  const b = asObject(body);
  const id = requireEntryId(entryId);
  const full = sanitizeJpeg(decodeImage(b.fullImage), FULL_LIMITS);
  const thumb = sanitizeJpeg(decodeImage(b.thumbImage), THUMB_LIMITS);
  if (!full.ok || !thumb.ok) throw new CommunityVotingError("PHOTO_INVALID", "The photograph is not an acceptable JPEG.");
  return repo.uploadEntryPhoto({
    ...ctx,
    entryId: id,
    fullBase64: Buffer.from(full.bytes).toString("base64"),
    thumbBase64: Buffer.from(thumb.bytes).toString("base64"),
    width: full.width,
    height: full.height,
  });
}

/**
 * The GALLERY-AND-CONTEST consent: the contestant has read the statement on the tablet and ticked it, and confirms being of legal age.
 * The statement and its digest are the SERVER's: a request cannot choose a different text, and a stale page is refused rather than
 * recorded. It is the only consent a contestant needs to compete.
 */
export function recordGalleryConsent(repo: RoundsRepository, ctx: OperatorContext, entryId: unknown, body: unknown) {
  const b = asObject(body);
  const id = requireEntryId(entryId);
  const photoId = requireUuid(b.photoId, "photoId");
  if (b.consentVersion !== GALLERY_CONSENT_VERSION) throw invalid("The consent text has changed; reload the page.");
  if (b.accepted !== true || b.ageConfirmed !== true) {
    throw new CommunityVotingError("CONSENT_REQUIRED", "The contestant must confirm being of legal age and accept the statement.");
  }
  return repo.recordEntryConsent({
    ...ctx,
    entryId: id,
    photoId,
    consentVersion: GALLERY_CONSENT_VERSION,
    statementSha256: GALLERY_CONSENT_SHA256,
    ageConfirmed: true,
  });
}

/** The PROMOTIONAL consent: optional, a separate act and statement. ACCEPTED, DECLINED or WITHDRAWN; none of them affects competing. */
export function recordPromoConsent(repo: RoundsRepository, ctx: OperatorContext, entryId: unknown, body: unknown) {
  const b = asObject(body);
  const id = requireEntryId(entryId);
  if (b.consentVersion !== PROMO_CONSENT_VERSION) throw invalid("The consent text has changed; reload the page.");
  if (b.decision !== "ACCEPTED" && b.decision !== "DECLINED" && b.decision !== "WITHDRAWN") throw invalid("decision must be ACCEPTED, DECLINED or WITHDRAWN.");
  return repo.recordPromoConsent({
    ...ctx,
    entryId: id,
    decision: b.decision as PromoDecision,
    consentVersion: PROMO_CONSENT_VERSION,
    statementSha256: PROMO_CONSENT_SHA256,
  });
}

export function decidePhoto(repo: RoundsRepository, ctx: OperatorContext, entryId: unknown, body: unknown) {
  const b = asObject(body);
  const id = requireEntryId(entryId);
  const photoId = requireUuid(b.photoId, "photoId");
  if (b.decision !== "APPROVED" && b.decision !== "REJECTED") throw invalid("decision must be APPROVED or REJECTED.");
  if (b.reason !== undefined && (typeof b.reason !== "string" || b.reason.length > 200)) throw invalid("reason must be at most 200 characters.");
  return repo.decideEntryPhoto({ ...ctx, entryId: id, photoId, decision: b.decision as PhotoDecision, reason: b.reason as string | undefined });
}

export function confirmAssociation(repo: RoundsRepository, ctx: OperatorContext, entryId: unknown, body: unknown) {
  const b = asObject(body);
  const id = requireEntryId(entryId);
  if (typeof b.confirmationCode !== "string" || b.confirmationCode.trim().length === 0) throw invalid("A confirmation code is required.");
  return repo.confirmRoundAssociation({ ...ctx, entryId: id, confirmationCode: b.confirmationCode });
}

/**
 * Candidature withdrawal: the contestant leaves every ranking and gallery and can receive no new vote; every vote already cast is kept as
 * evidence. The photograph is erased only when `hidePhoto` is asked for explicitly (and then through the privacy action).
 */
export function withdrawCandidature(repo: RoundsRepository, ctx: OperatorContext, entryId: unknown, body: unknown) {
  const b = asObject(body);
  const id = requireEntryId(entryId);
  const reason = typeof b.reason === "string" ? b.reason.trim() : "";
  if (reason.length === 0 || reason.length > 300) throw invalid("A withdrawal needs a reason of 1 to 300 characters.");
  if (b.hidePhoto !== undefined && typeof b.hidePhoto !== "boolean") throw invalid("hidePhoto must be true or false.");
  return repo.withdrawRoundCandidature({ ...ctx, entryId: id, reason, hidePhoto: b.hidePhoto === true });
}

/** Photograph visibility: the person asked for it to be hidden. It decides nothing about the competition. */
export function hideRoundPhoto(repo: RoundsRepository, ctx: OperatorContext, entryId: unknown, body: unknown) {
  const b = asObject(body);
  const id = requireEntryId(entryId);
  const reason = typeof b.reason === "string" ? b.reason.trim() : "";
  if (reason.length === 0 || reason.length > 300) throw invalid("A privacy action needs a reason of 1 to 300 characters.");
  return repo.hideRoundPhoto({ ...ctx, entryId: id, reason });
}

// ---------------------------------------------------------------- pending Product policies and follow-up tasks

const POLICY_KEYS: readonly PolicyKey[] = ["ZERO_VALID_VOTES_PRELIMINARY", "ZERO_VOTE_ENTRIES_AT_CUTOFF", "FINALIST_WITHDRAWAL_AFTER_SELECTION"];

/** The operator records the decision Product took, citing it. The database accepts only the value the system can execute. */
export function recordPolicyApproval(repo: RoundsRepository, ctx: OperatorContext, body: unknown) {
  const b = asObject(body);
  if (typeof b.policyKey !== "string" || !POLICY_KEYS.includes(b.policyKey as PolicyKey)) throw invalid("policyKey is not a known policy.");
  if (typeof b.policyValue !== "string" || b.policyValue.length === 0 || b.policyValue.length > 100) throw invalid("policyValue must be a non-empty value.");
  const approvalReference = typeof b.approvalReference === "string" ? b.approvalReference.trim() : "";
  if (approvalReference.length < 3 || approvalReference.length > 200) throw invalid("approvalReference must cite the decision (3 to 200 characters).");
  return repo.recordPolicyApproval({ ...ctx, policyKey: b.policyKey as PolicyKey, policyValue: b.policyValue, approvalReference });
}

export function resolveFollowupTask(repo: RoundsRepository, ctx: OperatorContext, taskId: unknown, body: unknown) {
  const b = asObject(body);
  const id = requireUuid(taskId, "taskId");
  const note = typeof b.note === "string" ? b.note.trim() : "";
  if (note.length === 0 || note.length > 300) throw invalid("A resolution note of 1 to 300 characters is required.");
  return repo.resolveFollowupTask({ ...ctx, taskId: id, note });
}

// ---------------------------------------------------------------- open, close, cut, final, review, publish, read

export function openRound(repo: RoundsRepository, ctx: OperatorContext, body: unknown) {
  const b = asObject(body);
  const promptText = typeof b.promptText === "string" ? b.promptText.trim() : "";
  if (promptText.length === 0 || promptText.length > 1000) throw invalid("The prompt must be 1 to 1000 characters.");
  return repo.startRound({ ...ctx, promptText });
}

export const closeRound = (repo: RoundsRepository, ctx: OperatorContext) => repo.closeRound(ctx);
export const selectFinalists = (repo: RoundsRepository, ctx: OperatorContext) => repo.selectFinalists(ctx);
export const prepareFinal = (repo: RoundsRepository, ctx: OperatorContext) => repo.prepareFinal(ctx);
export const publishRound = (repo: RoundsRepository, ctx: OperatorContext) => repo.publishRound(ctx);
export const readRoundOverview = (repo: RoundsRepository, ctx: OperatorContext) => repo.readRoundOverview(ctx);

export function reviewRound(repo: RoundsRepository, ctx: OperatorContext, body: unknown) {
  const b = body === undefined || body === null ? {} : asObject(body);
  if (b.note !== undefined && (typeof b.note !== "string" || b.note.length > 300)) throw invalid("note must be at most 300 characters.");
  return repo.recordRoundReview({ ...ctx, note: typeof b.note === "string" ? b.note : undefined });
}

/** Per-contestant totals exist only after the round has closed (the database refuses earlier). The evidence is read in the same breath. */
export async function readRoundResultsForOperator(repo: RoundsRepository, ctx: OperatorContext) {
  const rows = await repo.readRoundResults(ctx);
  const evidence = await repo.readRoundEvidence(ctx);
  return { rows, evidence };
}
