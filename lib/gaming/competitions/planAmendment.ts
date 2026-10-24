import { createHash } from "node:crypto";

import type { CompetitionsRepository, CompetitionPlanAmendmentStore, CompetitionPlanningStore } from "./db/competitionsRepository";
import type {
  CompetitionPlanningPlan, CompetitionPlanningRevisionRecord, DecidePlanAmendmentResult, PlanAmendmentDecision, PlanAmendmentFacts, PlanAmendmentStatus,
  PlanAmendmentStatusRecord, ProposePlanAmendmentResult, WithdrawPlanAmendmentResult,
} from "./types";
import type { SoccerFormatKey } from "./formats";
import { isActiveOrganizer } from "./organizerAccess";
import { CompetitionAccessDeniedError, CompetitionNotFoundError, HostAccessRevokedError } from "./types";
import { PlanningValidationError, parsePlanningPlan, parseUtcOffset, type PlanningViolation } from "./planning";

/**
 * UG-CR-GATE-SSS-011 — Post-Freeze Plan Amendment backend foundation (application side).
 *
 * The decisions are the database's, made inside the four atomic operations of this gate's migration: who may act (the organizer's exact ownership and the
 * host-revocation guard, or a frozen captain from the registration-freeze snapshot), the amendment window, the expiry by the database clock, the digest each
 * confirmation is bound to, and the fourth confirmation's atomic activation. This module holds only what the application adds: the allowlist of what a proposal
 * may carry, the composition of the complete plan from the CURRENT revision, the digest, the typed refusals with their stable codes, the bounded shapes a
 * browser is shown, and the commands behind the three routes. It reads no clock of its own and decides nothing about whether anything may be activated.
 *
 * What a proposal can NEVER carry: the venue's time zone, the roster bounds, the registration deadline, the rules, the competition's format, the frozen teams,
 * captains or members, or any system field. They are refused wherever they appear, by name, and the complete plan is composed from the current revision, so a
 * client cannot supply, change or smuggle one in. Only the venue's name, location description, restriction notes and simultaneous match capacity, the pitches,
 * and the tournament dates with their operating windows are amendable.
 *
 * THE DIGEST (version 1) binds one confirmation to one exact proposal. Its canonical text is these lines, joined by a newline with none at the end, and the
 * digest is the lowercase hexadecimal SHA-256 of that text in UTF-8. Free text is hashed per field so that no separator in a name can move a line:
 *
 *   URBANO-PLAN-AMENDMENT-V1
 *   competition:<competition id>
 *   freeze:<the registration freeze's own digest>
 *   base:<the planning revision the proposal was made against>
 *   sequence:<the proposal's number within the competition>
 *   format:<the competition's format key>
 *   roster:<minimum>-<maximum>
 *   deadline:<the registration deadline's UTC instant, YYYY-MM-DDTHH:MM:SS.mmmZ>
 *   deadline-local:<YYYY-MM-DDTHH:MM>
 *   deadline-offset:<minutes east of UTC>
 *   rules-version:<version>
 *   rules:<SHA-256 of the rules snapshot>
 *   timezone:<IANA name>
 *   venue-name:<SHA-256 of the name>
 *   venue-location:<SHA-256 of the location description>
 *   venue-notes:<SHA-256 of the restriction notes>
 *   capacity:<simultaneous match capacity>
 *   pitch:<position from 1>|label:<SHA-256>|usable:<true|false>|notes:<SHA-256>|formats:<format keys, de-duplicated, sorted bytewise, comma separated>
 *   date:<YYYY-MM-DD>|windows:<HH:MM-HH:MM, ascending, comma separated>
 *
 * with one pitch line per pitch in position order (the order is part of the content) and one date line per date in ascending order. Dates, windows and
 * supported formats are unordered facts, so the order they arrive in never matters. The database function competition_plan_amendment_digest computes the
 * very same value; both are pinned by one known answer.
 *
 * Errors are defined here, not in types.ts: the amendment routes own their wording and status, and none of the database's words reaches a browser.
 */

export const PLAN_AMENDMENT_REQUIRED_CONFIRMATIONS = 4;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Typed refusals
// ---------------------------------------------------------------------------------------------------------------------------------------------

export type PlanAmendmentCode =
  | "NOT_AVAILABLE" | "WINDOW_CLOSED" | "LEAD_TIME" | "STALE" | "EXPIRED" | "NOT_PENDING" | "DECISION_CONFLICT" | "INTENT_MISMATCH" | "FREEZE_INCONSISTENT";

const MESSAGES: Record<PlanAmendmentCode, string> = {
  NOT_AVAILABLE: "There is no plan change here that you can act on.",
  WINDOW_CLOSED: "The plan can be changed only while the competition is ready to publish and nothing has been drawn, scheduled or played.",
  LEAD_TIME: "The earliest operating window must be more than 12 hours away. Choose later dates or times.",
  STALE: "This is not the plan change currently on record. Review the latest proposal.",
  EXPIRED: "This plan change has expired.",
  NOT_PENDING: "This plan change is no longer pending.",
  DECISION_CONFLICT: "Your team has already given a different answer to this plan change.",
  INTENT_MISMATCH: "This save was already used for a different plan change. Review the latest proposal and save again.",
  FREEZE_INCONSISTENT: "The frozen registration no longer matches this competition, so its plan cannot be changed.",
};

/** A refusal of a plan-change operation. The code is stable and bounded; the wording is the application's, never the database's. */
export class PlanAmendmentError extends Error {
  readonly code: PlanAmendmentCode;
  constructor(code: PlanAmendmentCode) {
    super(MESSAGES[code]);
    this.name = "PlanAmendmentError";
    this.code = code;
  }
}

/** The one uniform answer for everything the caller has no part in: a stranger, an unknown competition, a former host, an unfrozen captain. */
export class PlanAmendmentNotAvailableError extends PlanAmendmentError { constructor() { super("NOT_AVAILABLE"); this.name = "PlanAmendmentNotAvailableError"; } }
export class PlanAmendmentWindowClosedError extends PlanAmendmentError { constructor() { super("WINDOW_CLOSED"); this.name = "PlanAmendmentWindowClosedError"; } }
export class PlanAmendmentLeadTimeError extends PlanAmendmentError { constructor() { super("LEAD_TIME"); this.name = "PlanAmendmentLeadTimeError"; } }
export class PlanAmendmentStaleError extends PlanAmendmentError { constructor() { super("STALE"); this.name = "PlanAmendmentStaleError"; } }
export class PlanAmendmentExpiredError extends PlanAmendmentError { constructor() { super("EXPIRED"); this.name = "PlanAmendmentExpiredError"; } }
export class PlanAmendmentNotPendingError extends PlanAmendmentError { constructor() { super("NOT_PENDING"); this.name = "PlanAmendmentNotPendingError"; } }
export class PlanAmendmentDecisionConflictError extends PlanAmendmentError { constructor() { super("DECISION_CONFLICT"); this.name = "PlanAmendmentDecisionConflictError"; } }
export class PlanAmendmentIntentMismatchError extends PlanAmendmentError { constructor() { super("INTENT_MISMATCH"); this.name = "PlanAmendmentIntentMismatchError"; } }
export class PlanAmendmentFreezeInconsistentError extends PlanAmendmentError { constructor() { super("FREEZE_INCONSISTENT"); this.name = "PlanAmendmentFreezeInconsistentError"; } }

/** Every reason a proposal (or the request carrying it) is not acceptable. Always a 400 at the boundary. */
export class PlanAmendmentValidationError extends Error {
  readonly violations: readonly PlanningViolation[];
  constructor(violations: readonly PlanningViolation[]) {
    super("The plan change is not valid.");
    this.name = "PlanAmendmentValidationError";
    this.violations = violations;
  }
}

const DATABASE_CODES: Array<[string, () => PlanAmendmentError]> = [
  ["PLAN_AMENDMENT_NOT_AVAILABLE", () => new PlanAmendmentNotAvailableError()],
  ["PLAN_AMENDMENT_WINDOW_CLOSED", () => new PlanAmendmentWindowClosedError()],
  ["PLAN_AMENDMENT_LEAD_TIME", () => new PlanAmendmentLeadTimeError()],
  ["PLAN_AMENDMENT_STALE", () => new PlanAmendmentStaleError()],
  ["PLAN_AMENDMENT_EXPIRED", () => new PlanAmendmentExpiredError()],
  ["PLAN_AMENDMENT_NOT_PENDING", () => new PlanAmendmentNotPendingError()],
  ["PLAN_AMENDMENT_DECISION_CONFLICT", () => new PlanAmendmentDecisionConflictError()],
  ["PLAN_AMENDMENT_INTENT_MISMATCH", () => new PlanAmendmentIntentMismatchError()],
  ["PLAN_AMENDMENT_FREEZE_INCONSISTENT", () => new PlanAmendmentFreezeInconsistentError()],
];

/** The typed error for a refusal raised inside the database, or null when the message is not one of this gate's. Only the codes — never the words — are used. */
export function planAmendmentErrorFromDatabase(message: string): PlanAmendmentError | PlanAmendmentValidationError | null {
  if (typeof message !== "string" || message === "") return null;
  const invalid = /PLAN_AMENDMENT_INVALID: ([A-Z_]+): ([^\n]*)/.exec(message);
  if (invalid) {
    const text = invalid[2];
    return new PlanAmendmentValidationError([{ field: "amendment", code: invalid[1], message: text.charAt(0).toUpperCase() + text.slice(1) + (/[.!?]$/.test(text) ? "" : ".") }]);
  }
  for (const [databaseCode, build] of DATABASE_CODES) {
    if (message.includes(databaseCode)) return build();
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// What a proposal may carry
// ---------------------------------------------------------------------------------------------------------------------------------------------

const AMENDABLE_SECTIONS = ["venue", "pitches", "dates"] as const;
const AMENDABLE_VENUE_FIELDS = ["name", "locationDescription", "restrictionNotes", "simultaneousMatchCapacity"] as const;

/** Preserved or system facts a proposal can never name, at any level. Naming one is refused as such (not as "unknown"). */
const IMMUTABLE_FIELDS: ReadonlySet<string> = new Set([
  "timeZone", "format", "formatKey", "activityKey", "competitionFormat", "roster", "rosterMinimum", "rosterMaximum", "registrationDeadline", "deadline", "rules", "rulesVersion",
  "rulesSnapshot", "timing", "teams", "captains", "members", "competitionId", "state", "status", "freeze", "digest", "amendmentDigest", "sequenceNumber", "expiresAt", "createdAt", "now",
]);

function add(violations: PlanningViolation[], field: string, code: string, message: string) {
  violations.push({ field, code, message });
}

function checkAmendableKeys(raw: Record<string, unknown>, allowed: readonly string[], path: string, violations: PlanningViolation[]) {
  for (const key of Object.keys(raw)) {
    if (allowed.includes(key)) continue;
    const field = path ? `${path}.${key}` : key;
    if (IMMUTABLE_FIELDS.has(key)) add(violations, field, "IMMUTABLE_FIELD", "This is fixed by the registration freeze and cannot be changed in a plan change.");
    else add(violations, field, "UNKNOWN_FIELD", "This field is not part of a plan change.");
  }
}

/** Throws unless the request carries exactly the amendable sections (and, within the venue, exactly the amendable fields). Nothing else is ever sent on. */
function assertAmendableShape(raw: unknown): Record<string, unknown> {
  if (!isPlainObject(raw)) throw new PlanAmendmentValidationError([{ field: "amendment", code: "AMENDMENT_NOT_OBJECT", message: "The plan change must be an object." }]);
  const violations: PlanningViolation[] = [];
  checkAmendableKeys(raw, AMENDABLE_SECTIONS, "", violations);
  if (!isPlainObject(raw.venue)) add(violations, "venue", "REQUIRED", "Enter the venue details.");
  else checkAmendableKeys(raw.venue, AMENDABLE_VENUE_FIELDS, "venue", violations);
  if (violations.length > 0) throw new PlanAmendmentValidationError(violations);
  return raw;
}

export interface ComposedAmendment {
  /** The complete plan that would result: the amendable facts as proposed, everything else exactly the current revision's. Valid by the planning validator. */
  plan: CompetitionPlanningPlan;
  /** Only the amendable facts of that plan, normalized (text trimmed, dates and windows ascending, supported formats sorted): all that is ever sent on. */
  facts: PlanAmendmentFacts;
}

/** The amendable facts of a (validated) plan. */
function factsOf(plan: CompetitionPlanningPlan): PlanAmendmentFacts {
  return {
    venue: {
      name: plan.venue.name, locationDescription: plan.venue.locationDescription, restrictionNotes: plan.venue.restrictionNotes,
      simultaneousMatchCapacity: plan.venue.simultaneousMatchCapacity,
    },
    pitches: plan.pitches.map((p) => ({ label: p.label, usable: p.usable, supportedFormats: [...p.supportedFormats], restrictionNotes: p.restrictionNotes })),
    dates: plan.dates.map((d) => ({ date: d.date, windows: d.windows.map((w) => ({ start: w.start, end: w.end })) })),
  };
}

/**
 * Composes the complete resulting plan from the CURRENT revision and the amendable facts, and judges it with the very validator the DRAFT editor uses.
 * Throws a PlanAmendmentValidationError listing every problem found: a preserved or system field named at any level is IMMUTABLE_FIELD, anything else
 * unknown is UNKNOWN_FIELD, and the planning codes are the planning validator's own.
 */
export function composeAmendedPlan(base: CompetitionPlanningRevisionRecord, raw: unknown): ComposedAmendment {
  const amendment = assertAmendableShape(raw);
  const venue = amendment.venue as Record<string, unknown>;
  const composed = {
    venue: {
      name: venue.name, locationDescription: venue.locationDescription, timeZone: base.venue.timeZone,
      simultaneousMatchCapacity: venue.simultaneousMatchCapacity, restrictionNotes: venue.restrictionNotes,
    },
    pitches: amendment.pitches,
    dates: amendment.dates,
    roster: { minimum: base.roster.minimum, maximum: base.roster.maximum },
    registrationDeadline: {
      local: base.registrationDeadline.local, timeZone: base.registrationDeadline.timeZone, utcOffset: base.registrationDeadline.utcOffset, utc: base.registrationDeadline.utc,
    },
    rules: { version: base.rules.version, snapshot: base.rules.snapshot },
  };
  let plan: CompetitionPlanningPlan;
  try {
    plan = parsePlanningPlan(composed, base.formatKey);
  } catch (err) {
    if (err instanceof PlanningValidationError) throw new PlanAmendmentValidationError(err.violations);
    throw err;
  }
  return { plan, facts: factsOf(plan) };
}

/** The amendable facts as the database's propose operation takes them: snake_case, exactly the three sections. A fact beyond them is refused before anything is sent. */
export function planAmendmentRpcPayload(facts: PlanAmendmentFacts) {
  const shaped = assertAmendableShape(facts) as unknown as PlanAmendmentFacts;
  return {
    venue: {
      name: shaped.venue.name, location_description: shaped.venue.locationDescription, restriction_notes: shaped.venue.restrictionNotes,
      simultaneous_match_capacity: shaped.venue.simultaneousMatchCapacity,
    },
    pitches: shaped.pitches.map((p) => ({ label: p.label, usable: p.usable, supported_formats: [...p.supportedFormats], restriction_notes: p.restrictionNotes })),
    dates: shaped.dates.map((d) => ({ date: d.date, windows: d.windows.map((w) => ({ start: w.start, end: w.end })) })),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The digest
// ---------------------------------------------------------------------------------------------------------------------------------------------

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

export interface PlanAmendmentDigestInput {
  competitionId: string;
  freezeDigest: string;
  baseRevisionId: string;
  sequenceNumber: number;
  formatKey: SoccerFormatKey;
  plan: CompetitionPlanningPlan;
}

/** The digest of one proposal: see the canonical text in this file's header. Deterministic, and independent of the order of dates, windows and supported formats. */
export function computePlanAmendmentDigest(input: PlanAmendmentDigestInput): string {
  const { plan } = input;
  const offset = parseUtcOffset(plan.registrationDeadline.utcOffset);
  if (offset === null) throw new RangeError("The plan's registration deadline has no valid UTC offset.");
  const lines = [
    "URBANO-PLAN-AMENDMENT-V1",
    `competition:${input.competitionId}`,
    `freeze:${input.freezeDigest}`,
    `base:${input.baseRevisionId}`,
    `sequence:${input.sequenceNumber}`,
    `format:${input.formatKey}`,
    `roster:${plan.roster.minimum}-${plan.roster.maximum}`,
    `deadline:${plan.registrationDeadline.utc}`,
    `deadline-local:${plan.registrationDeadline.local}`,
    `deadline-offset:${offset}`,
    `rules-version:${plan.rules.version}`,
    `rules:${sha256(plan.rules.snapshot)}`,
    `timezone:${plan.venue.timeZone}`,
    `venue-name:${sha256(plan.venue.name)}`,
    `venue-location:${sha256(plan.venue.locationDescription)}`,
    `venue-notes:${sha256(plan.venue.restrictionNotes)}`,
    `capacity:${plan.venue.simultaneousMatchCapacity}`,
  ];
  plan.pitches.forEach((pitch, index) => {
    const formats = [...new Set(pitch.supportedFormats)].sort().join(",");
    lines.push(`pitch:${index + 1}|label:${sha256(pitch.label)}|usable:${pitch.usable ? "true" : "false"}|notes:${sha256(pitch.restrictionNotes)}|formats:${formats}`);
  });
  const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  for (const day of [...plan.dates].sort((a, b) => compare(a.date, b.date))) {
    const windows = [...day.windows].sort((a, b) => compare(a.start, b.start) || compare(a.end, b.end)).map((w) => `${w.start}-${w.end}`).join(",");
    lines.push(`date:${day.date}|windows:${windows}`);
  }
  return sha256(lines.join("\n"));
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The requests
// ---------------------------------------------------------------------------------------------------------------------------------------------

function checkEnvelopeKeys(body: Record<string, unknown>, allowed: readonly string[], violations: PlanningViolation[]) {
  for (const key of Object.keys(body)) {
    if (!allowed.includes(key)) add(violations, key, "UNKNOWN_FIELD", "This field is not part of the request.");
  }
}

function envelope(body: unknown): Record<string, unknown> {
  if (!isPlainObject(body)) throw new PlanAmendmentValidationError([{ field: "request", code: "REQUEST_NOT_OBJECT", message: "The request must be an object." }]);
  return body;
}

/** The body of a proposal: exactly a save identifier and the amendment. The organizer is always the verified caller; nothing else is accepted. */
export function parsePlanAmendmentRequest(body: unknown): { intentId: string; amendment: Record<string, unknown> } {
  const raw = envelope(body);
  const violations: PlanningViolation[] = [];
  checkEnvelopeKeys(raw, ["intentId", "amendment"], violations);
  if (typeof raw.intentId !== "string" || !UUID_PATTERN.test(raw.intentId)) add(violations, "intentId", "INTENT_INVALID", "A save identifier is required.");
  if (!isPlainObject(raw.amendment)) add(violations, "amendment", "AMENDMENT_NOT_OBJECT", "The plan change must be an object.");
  if (violations.length > 0) throw new PlanAmendmentValidationError(violations);
  return { intentId: raw.intentId as string, amendment: raw.amendment as Record<string, unknown> };
}

/** The body of a decision: exactly the proposal's digest and CONFIRMED or REJECTED. The captain is always the verified caller. */
export function parsePlanAmendmentDecisionRequest(body: unknown): { amendmentDigest: string; decision: PlanAmendmentDecision } {
  const raw = envelope(body);
  const violations: PlanningViolation[] = [];
  checkEnvelopeKeys(raw, ["amendmentDigest", "decision"], violations);
  if (typeof raw.amendmentDigest !== "string" || !DIGEST_PATTERN.test(raw.amendmentDigest)) add(violations, "amendmentDigest", "DIGEST_INVALID", "Name the plan change by its digest.");
  if (raw.decision !== "CONFIRMED" && raw.decision !== "REJECTED") add(violations, "decision", "DECISION_INVALID", "The answer is CONFIRMED or REJECTED.");
  if (violations.length > 0) throw new PlanAmendmentValidationError(violations);
  return { amendmentDigest: raw.amendmentDigest as string, decision: raw.decision as PlanAmendmentDecision };
}

/** The body of a withdrawal: exactly the proposal's digest. */
export function parsePlanAmendmentWithdrawRequest(body: unknown): { amendmentDigest: string } {
  const raw = envelope(body);
  const violations: PlanningViolation[] = [];
  checkEnvelopeKeys(raw, ["amendmentDigest"], violations);
  if (typeof raw.amendmentDigest !== "string" || !DIGEST_PATTERN.test(raw.amendmentDigest)) add(violations, "amendmentDigest", "DIGEST_INVALID", "Name the plan change by its digest.");
  if (violations.length > 0) throw new PlanAmendmentValidationError(violations);
  return { amendmentDigest: raw.amendmentDigest as string };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// What the database returns, and what a browser may see
// ---------------------------------------------------------------------------------------------------------------------------------------------

const iso = (value: unknown) => new Date(value as string).toISOString();

/**
 * A status never invites an action the server will refuse for a reason it already knows. A proposal is actionable only while it is pending AND the amendment
 * window is open — and the database closes the window for the organizer's revocation too — so whatever a payload said, a closed window or a proposal that is not
 * pending is never actionable. The captains keep their bounded read of a historical proposal; they are just not invited to act on it.
 */
function isActionable(windowOpen: boolean, status: PlanAmendmentStatus, reported: boolean): boolean {
  return reported && windowOpen && status === "PENDING";
}

/** The amendable facts as the database reports them (snake_case), in the application's own shape. */
export function planAmendmentFactsFromDatabase(raw: any): PlanAmendmentFacts {
  return {
    venue: {
      name: raw.venue.name, locationDescription: raw.venue.location_description, restrictionNotes: raw.venue.restriction_notes ?? "",
      simultaneousMatchCapacity: Number(raw.venue.simultaneous_match_capacity),
    },
    pitches: (raw.pitches ?? []).map((p: any) => ({ label: p.label, usable: p.usable === true, supportedFormats: [...(p.supported_formats ?? [])], restrictionNotes: p.restriction_notes ?? "" })),
    dates: (raw.dates ?? []).map((d: any) => ({ date: d.date, windows: (d.windows ?? []).map((w: any) => ({ start: w.start, end: w.end })) })),
  };
}

/** The database's answer to the status read, in the application's own shape; null stays null (no part in any plan change). */
export function planAmendmentStatusFromDatabase(raw: any): PlanAmendmentStatusRecord | null {
  if (!raw) return null;
  const a = raw.amendment;
  return {
    role: { organizer: raw.role?.organizer === true, captain: raw.role?.captain === true },
    windowOpen: raw.window_open === true,
    myTeamName: raw.my_team_name ?? null,
    amendment: a
      ? {
          digest: a.digest, sequenceNumber: Number(a.sequence_number), status: a.status as PlanAmendmentStatus,
          actionable: isActionable(raw.window_open === true, a.status as PlanAmendmentStatus, a.actionable === true),
          createdAt: iso(a.created_at), expiresAt: iso(a.expires_at), resolvedAt: a.resolved_at ? iso(a.resolved_at) : null,
          confirmedCount: Number(a.confirmed_count), requiredCount: Number(a.required_count),
          teams: (a.teams ?? []).map((t: any) => ({ teamName: t.team_name, decision: (t.decision ?? null) as PlanAmendmentDecision | null })),
          myDecision: (a.my_decision ?? null) as PlanAmendmentDecision | null,
          proposed: planAmendmentFactsFromDatabase(a.proposed),
          current: planAmendmentFactsFromDatabase(a.current),
        }
      : null,
    history: Array.isArray(raw.history)
      ? raw.history.map((h: any) => ({ sequenceNumber: Number(h.sequence_number), status: h.status as PlanAmendmentStatus, createdAt: iso(h.created_at), resolvedAt: h.resolved_at ? iso(h.resolved_at) : null }))
      : null,
  };
}

/** The status as a browser may see it: every field is copied by name, so no identifier of a team, member, proposal or revision can reach a response. */
export function publicPlanAmendmentStatus(record: PlanAmendmentStatusRecord) {
  const copyFacts = (f: PlanAmendmentFacts): PlanAmendmentFacts => ({
    venue: { name: f.venue.name, locationDescription: f.venue.locationDescription, restrictionNotes: f.venue.restrictionNotes, simultaneousMatchCapacity: f.venue.simultaneousMatchCapacity },
    pitches: f.pitches.map((p) => ({ label: p.label, usable: p.usable, supportedFormats: [...p.supportedFormats], restrictionNotes: p.restrictionNotes })),
    dates: f.dates.map((d) => ({ date: d.date, windows: d.windows.map((w) => ({ start: w.start, end: w.end })) })),
  });
  const a = record.amendment;
  return {
    role: { organizer: record.role.organizer, captain: record.role.captain },
    windowOpen: record.windowOpen,
    myTeamName: record.myTeamName,
    amendment: a
      ? {
          digest: a.digest, sequenceNumber: a.sequenceNumber, status: a.status, actionable: isActionable(record.windowOpen, a.status, a.actionable),
          createdAt: a.createdAt, expiresAt: a.expiresAt, resolvedAt: a.resolvedAt,
          confirmedCount: a.confirmedCount, requiredCount: a.requiredCount, teams: a.teams.map((t) => ({ teamName: t.teamName, decision: t.decision })),
          myDecision: a.myDecision, proposed: copyFacts(a.proposed), current: copyFacts(a.current),
        }
      : null,
    history: record.history ? record.history.map((h) => ({ sequenceNumber: h.sequenceNumber, status: h.status, createdAt: h.createdAt, resolvedAt: h.resolvedAt })) : null,
  };
}

/** A new or replayed proposal as a browser may see it. */
export function publicProposal(result: ProposePlanAmendmentResult) {
  return {
    digest: result.digest, sequenceNumber: result.sequenceNumber, createdAt: result.createdAt, expiresAt: result.expiresAt,
    alreadyProposed: result.alreadyProposed, supersededDigest: result.supersededDigest,
  };
}

/** The one sentence every route says when the caller has no part in a plan change. It names nothing: not the competition, the state, the roles or whether anything exists. */
export const PLAN_AMENDMENT_NOT_FOUND_MESSAGE = "A plan change was not found for this competition.";

/**
 * How a failed plan-change operation is answered. Everything that means "you have no part in this" — the uniform not-available, and the database's own ownership,
 * revocation and not-found refusals (which a race can still produce after the application's check) — is the same 404 with the same words, so nobody can tell an
 * unknown competition from a stranger, a former host from a current one. An invalid input is a 400 with every problem; every other typed refusal is a 409 with its
 * stable code and the application's bounded wording. Anything else is not this gate's to describe: null.
 */
export function planAmendmentFailure(err: unknown): { status: number; body: { error: string; code?: PlanAmendmentCode; problems?: readonly PlanningViolation[] } } | null {
  if (err instanceof PlanAmendmentValidationError) return { status: 400, body: { error: err.message, problems: err.violations } };
  if (err instanceof PlanAmendmentNotAvailableError || err instanceof CompetitionNotFoundError || err instanceof CompetitionAccessDeniedError || err instanceof HostAccessRevokedError) {
    return { status: 404, body: { error: PLAN_AMENDMENT_NOT_FOUND_MESSAGE } };
  }
  if (err instanceof PlanAmendmentError) return { status: 409, body: { error: err.message, code: err.code } };
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------------------------------------------------------

export type PlanAmendmentRepository = Pick<CompetitionsRepository, "getCompetitionById"> & Pick<CompetitionPlanningStore, "getCurrentPlanningRevision"> & CompetitionPlanAmendmentStore;

/**
 * PROPOSE_COMPETITION_PLAN_AMENDMENT. The same decisions are made again, atomically and under a lock, inside the database; these checks decide first so that a
 * caller who is not the active organizer never learns whether an amendment would have been valid (the amendment is not even read), and nothing is judged for a
 * competition that cannot take it. The organizer is always the verified caller; the preserved facts and the format come from the current revision, not the request.
 */
export async function proposeCompetitionPlanAmendment(
  repo: PlanAmendmentRepository,
  competitionId: string,
  callerGamingMemberId: string,
  intentId: string,
  rawAmendment: unknown
): Promise<ProposePlanAmendmentResult> {
  const competition = await repo.getCompetitionById(competitionId);
  if (!competition || !isActiveOrganizer(competition, callerGamingMemberId)) throw new PlanAmendmentNotAvailableError();
  // A competition that has not reached the freeze has never had a proposal, so the window can be refused here. Once it has left READY_TO_PUBLISH (published,
  // complete, cancelled) an EXACT RETRY of a recorded proposal must still be answered from the record, so the database — which judges that retry before the
  // lifecycle window, and everything else after it — is always asked.
  if (competition.state === "DRAFT" || competition.state === "TEAM_REGISTRATION_OPEN") throw new PlanAmendmentWindowClosedError();
  const base = await repo.getCurrentPlanningRevision(competitionId);
  if (!base) throw new PlanAmendmentWindowClosedError();
  const { facts } = composeAmendedPlan(base, rawAmendment);
  return repo.proposePlanAmendment(competitionId, callerGamingMemberId, intentId, facts);
}

/**
 * DECIDE_COMPETITION_PLAN_AMENDMENT. The application cannot tell a frozen captain from anyone else — only the database can, from the registration-freeze
 * snapshot — so it passes the verified caller through and lets the database answer, uniformly, for everyone who is not one.
 */
export function decideCompetitionPlanAmendment(
  repo: Pick<CompetitionPlanAmendmentStore, "decidePlanAmendment">,
  competitionId: string,
  callerGamingMemberId: string,
  amendmentDigest: string,
  decision: PlanAmendmentDecision
): Promise<DecidePlanAmendmentResult> {
  return repo.decidePlanAmendment(competitionId, callerGamingMemberId, amendmentDigest, decision);
}

/** WITHDRAW_COMPETITION_PLAN_AMENDMENT: the active organizer only (uniform not-available otherwise), bound to the proposal's exact digest. */
export async function withdrawCompetitionPlanAmendment(
  repo: PlanAmendmentRepository,
  competitionId: string,
  callerGamingMemberId: string,
  amendmentDigest: string
): Promise<WithdrawPlanAmendmentResult> {
  const competition = await repo.getCompetitionById(competitionId);
  if (!competition || !isActiveOrganizer(competition, callerGamingMemberId)) throw new PlanAmendmentNotAvailableError();
  return repo.withdrawPlanAmendment(competitionId, callerGamingMemberId, amendmentDigest);
}

/** READ_COMPETITION_PLAN_AMENDMENT: the database answers for the caller — null for anyone but the active organizer and the four frozen captains. */
export function readCompetitionPlanAmendment(
  repo: Pick<CompetitionPlanAmendmentStore, "getPlanAmendmentStatus">,
  competitionId: string,
  callerGamingMemberId: string
): Promise<PlanAmendmentStatusRecord | null> {
  return repo.getPlanAmendmentStatus(competitionId, callerGamingMemberId);
}
