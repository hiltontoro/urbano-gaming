import { createHash } from "node:crypto";

import type { CompetitionSchedulePublicationStore } from "./db/competitionsRepository";
import type { PublishScheduledCompetitionResult, ScheduleFixtureRole, SchedulePublicationFixtureRecord, SchedulePublicationRecord } from "./types";
import type { PlanningViolation } from "./planning";

/**
 * UG-CR-GATE-SSS-025 — the atomic schedule publication, application side.
 *
 * A publication turns a frozen, drawn, four-team competition into a PUBLISHED one: the two semifinals and the final, created from the permanent draw and ONE exact CURRENT
 * schedule proposal. Every DECISION is the database's, made inside its one atomic operation: who may publish (the competition's own ACTIVE organizer — never a captain, a
 * scorekeeper, an ordinary member or a holder of OPERATIONAL authority alone — and never a revoked host, not even to replay), the exact replay, the lifecycle, the freeze, the
 * permanent draw and its evidence, a plan change that awaits the captains, the latest and CURRENT proposal, the reproduction of the proposal's own evidence, every scheduling rule
 * judged again at the publication instant, the three fixtures, the resolution and the single state transition. This module holds only what the application adds: the strict
 * request allowlist, the digest of a publication and the reproduction of a stored publication from its own evidence, the typed refusals with their stable codes, the bounded
 * shape a browser is shown, and the one command behind the route. It reads no clock and contains no source of randomness: the publication instant is the database's alone.
 *
 * WHAT A CLIENT CAN SEND is the digest of the proposal it reviewed — `{ "scheduleProposalDigest": "<64 lowercase hexadecimal digits>" }` — and nothing else. The teams and the
 * pairing are the draw's (positions one and two meet in the first semifinal, three and four in the second); the instants, the pitches, the venue, the zone, the capacity and the
 * format are the proposal's, which the database judged again against the plan and the format registry; the actor is the verified caller. While the manual publication still
 * exists for competitions outside the schedule journey, the request may instead be exactly its seven legacy fields; the two shapes are never mixed.
 *
 * THE DIGEST of a publication is the lowercase hexadecimal SHA-256 of the canonical text, in UTF-8, lines joined by a newline with none at the end:
 *   URBANO-COMPETITION-SCHEDULE-PUBLICATION-V1 / competition:<id> / proposal:<sequence>,<proposal digest> / planning-revision:<id> / draw:<id>,<draw digest> /
 *   published-by:<member id> / published-at:<YYYY-MM-DDTHH:MM:SS.uuuuuuZ> / then one line per fixture in role order:
 *   fixture:<role>,<fixture id>,<start UTC as YYYY-MM-DDTHH:MM:SS.mmmZ>,<team A id>,<team B id>   (a semifinal: its two teams)
 *   fixture:FINAL,<fixture id>,<start UTC>,<source fixture A id>,<source fixture B id>             (the final: the two semifinals)
 * The database function competition_schedule_publication_digest computes the very same value; both are pinned by known answers that an independent Python program wrote.
 *
 * Errors are defined here, not in types.ts: the route owns their wording and status, and none of the database's words reaches a browser.
 */

export const SCHEDULE_PUBLICATION_DIGEST_VERSION = "URBANO-COMPETITION-SCHEDULE-PUBLICATION-V1";

const ROLES: readonly ScheduleFixtureRole[] = Object.freeze(["SEMIFINAL_1", "SEMIFINAL_2", "FINAL"] as const);
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTANT_MS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const INSTANT_US_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const isUuid = (value: unknown): value is string => typeof value === "string" && UUID_PATTERN.test(value);
const isDigest = (value: unknown): value is string => typeof value === "string" && DIGEST_PATTERN.test(value);
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Typed refusals
// ---------------------------------------------------------------------------------------------------------------------------------------------

export type SchedulePublicationCode =
  | "WRONG_STATE" | "FREEZE_REQUIRED" | "FREEZE_INCONSISTENT" | "DRAW_REQUIRED" | "PLAN_REQUIRED" | "AMENDMENT_PENDING" | "DRAW_NOT_VERIFIABLE"
  | "PROPOSAL_NOT_FOUND" | "PROPOSAL_SUPERSEDED" | "PROPOSAL_STALE" | "PROPOSAL_NOT_VERIFIABLE" | "PUBLICATION_CONFLICT" | "PUBLICATION_NOT_VERIFIABLE"
  | "SCHEDULE_PROPOSAL_PUBLICATION_REQUIRED";

const MESSAGES: Record<SchedulePublicationCode, string> = {
  WRONG_STATE: "A competition can be published from a schedule proposal only while it is ready to publish, before anything has been scheduled or played.",
  FREEZE_REQUIRED: "Registration must be closed and frozen before the competition can be published.",
  FREEZE_INCONSISTENT: "The frozen registration no longer matches this competition, so it cannot be published.",
  DRAW_REQUIRED: "The draw must be made before the competition can be published.",
  PLAN_REQUIRED: "The competition has no accepted plan to publish against.",
  AMENDMENT_PENDING: "A plan change is still waiting for the captains' answers. Wait until it is decided, withdrawn or has expired before publishing.",
  DRAW_NOT_VERIFIABLE: "The draw could not be verified, so the competition cannot be published.",
  PROPOSAL_NOT_FOUND: "This competition has no schedule proposal with that digest.",
  PROPOSAL_SUPERSEDED: "A later schedule proposal exists. Review the latest proposal and publish that one.",
  PROPOSAL_STALE: "The plan or the draw has changed since this schedule proposal was made. Propose the schedule again and publish the new proposal.",
  PROPOSAL_NOT_VERIFIABLE: "The schedule proposal could not be verified, so the competition cannot be published from it.",
  PUBLICATION_CONFLICT: "This competition was already published from a different schedule proposal.",
  PUBLICATION_NOT_VERIFIABLE: "The publication could not be verified and was not made. Nothing was changed.",
  SCHEDULE_PROPOSAL_PUBLICATION_REQUIRED: "This competition is published from its schedule proposal, not from teams and times entered by hand. Review the latest schedule proposal and publish it with its digest.",
};

/** A refusal of a publication. The code is stable and bounded; the wording is the application's, never the database's. */
export class SchedulePublicationError extends Error {
  readonly code: SchedulePublicationCode;
  constructor(code: SchedulePublicationCode) {
    super(MESSAGES[code]);
    this.name = "SchedulePublicationError";
    this.code = code;
  }
}

/** The schedule can no longer be published as proposed — most often because a kickoff is no longer in the future. Carries the stable code of every rule it breaks. */
export class SchedulePublicationNotPublishableError extends Error {
  readonly violations: readonly PlanningViolation[];
  constructor(violations: readonly PlanningViolation[]) {
    super("This schedule can no longer be published as proposed. Propose the schedule again and publish the new proposal.");
    this.name = "SchedulePublicationNotPublishableError";
    this.violations = violations;
  }
}

/** Every reason a request is not acceptable. Always a 400 at the boundary. */
export class SchedulePublicationRequestError extends Error {
  readonly violations: readonly PlanningViolation[];
  constructor(violations: readonly PlanningViolation[]) {
    super("Invalid publish payload.");
    this.name = "SchedulePublicationRequestError";
    this.violations = violations;
  }
}

const DATABASE_CODES: Array<[string, SchedulePublicationCode]> = [
  ["SCHEDULE_PUBLICATION_WRONG_STATE", "WRONG_STATE"],
  ["SCHEDULE_PUBLICATION_FREEZE_REQUIRED", "FREEZE_REQUIRED"],
  ["SCHEDULE_PUBLICATION_FREEZE_INCONSISTENT", "FREEZE_INCONSISTENT"],
  ["SCHEDULE_PUBLICATION_DRAW_REQUIRED", "DRAW_REQUIRED"],
  ["SCHEDULE_PUBLICATION_PLAN_REQUIRED", "PLAN_REQUIRED"],
  ["SCHEDULE_PUBLICATION_AMENDMENT_PENDING", "AMENDMENT_PENDING"],
  ["SCHEDULE_PUBLICATION_DRAW_NOT_VERIFIABLE", "DRAW_NOT_VERIFIABLE"],
  ["SCHEDULE_PUBLICATION_PROPOSAL_NOT_FOUND", "PROPOSAL_NOT_FOUND"],
  ["SCHEDULE_PUBLICATION_PROPOSAL_SUPERSEDED", "PROPOSAL_SUPERSEDED"],
  ["SCHEDULE_PUBLICATION_PROPOSAL_STALE", "PROPOSAL_STALE"],
  ["SCHEDULE_PUBLICATION_PROPOSAL_NOT_VERIFIABLE", "PROPOSAL_NOT_VERIFIABLE"],
  ["SCHEDULE_PUBLICATION_CONFLICT", "PUBLICATION_CONFLICT"],
  ["SCHEDULE_PROPOSAL_PUBLICATION_REQUIRED", "SCHEDULE_PROPOSAL_PUBLICATION_REQUIRED"],
];

const sentence = (text: string) => {
  const trimmed = text.trim();
  return trimmed.charAt(0).toUpperCase() + trimmed.slice(1) + (/[.!?]$/.test(trimmed) ? "" : ".");
};

/** The typed error for a refusal raised inside the database, or null when the message is not one of this gate's. Only the codes — never the words — are used. */
export function schedulePublicationErrorFromDatabase(message: string): SchedulePublicationError | SchedulePublicationNotPublishableError | SchedulePublicationRequestError | null {
  if (typeof message !== "string" || message === "") return null;
  const notPublishable = /SCHEDULE_PUBLICATION_NOT_PUBLISHABLE: ([A-Z_]+): ([^\n]*)/.exec(message);
  if (notPublishable) return new SchedulePublicationNotPublishableError([{ field: "schedule", code: notPublishable[1], message: sentence(notPublishable[2]) }]);
  if (message.includes("SCHEDULE_PUBLICATION_NOT_PUBLISHABLE")) {
    return new SchedulePublicationNotPublishableError([{ field: "schedule", code: "NOT_PUBLISHABLE", message: "The schedule can no longer be published as proposed." }]);
  }
  const invalid = /SCHEDULE_PUBLICATION_INVALID: ([A-Z_]+): ([^\n]*)/.exec(message);
  if (invalid && invalid[1] === "DIGEST_INVALID") {
    return new SchedulePublicationRequestError([{ field: "scheduleProposalDigest", code: "DIGEST_INVALID", message: "The schedule proposal digest must be 64 lowercase hexadecimal digits." }]);
  }
  // Every other invalid-resolution code is the commit-time verification refusing a resolution that does not match what it names: the whole publication was rolled back.
  if (message.includes("SCHEDULE_PUBLICATION_INVALID")) return new SchedulePublicationError("PUBLICATION_NOT_VERIFIABLE");
  for (const [databaseCode, code] of DATABASE_CODES) {
    if (message.includes(databaseCode)) return new SchedulePublicationError(code);
  }
  return null;
}

/**
 * How a failed publication is answered. An invalid request is a 400 with every problem; a proposal that is not there is a 404; a schedule that can no longer be published and every
 * other typed refusal is a 409 with its stable code and the application's bounded wording. The competition-level refusals that mean "you have no part in this" — access denied,
 * a former host, an unknown competition — are the existing ones, answered by the route's shared status table; anything else is not this module's to describe: null.
 */
export function schedulePublicationFailure(err: unknown): { status: number; body: { error: string; code?: string; problems?: readonly PlanningViolation[] } } | null {
  if (err instanceof SchedulePublicationRequestError) return { status: 400, body: { error: err.message, problems: err.violations } };
  if (err instanceof SchedulePublicationNotPublishableError) return { status: 409, body: { error: err.message, code: "SCHEDULE_NOT_PUBLISHABLE", problems: err.violations } };
  if (err instanceof SchedulePublicationError) return { status: err.code === "PROPOSAL_NOT_FOUND" ? 404 : 409, body: { error: err.message, code: err.code } };
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------------------------------------------------------------------------

export const LEGACY_PUBLISH_FIELDS = [
  "semifinal1TeamAId", "semifinal1TeamBId", "semifinal2TeamAId", "semifinal2TeamBId", "semifinal1ScheduledAt", "semifinal2ScheduledAt", "finalScheduledAt",
] as const;
type LegacyField = (typeof LEGACY_PUBLISH_FIELDS)[number];
const LEGACY_SET: ReadonlySet<string> = new Set(LEGACY_PUBLISH_FIELDS);
const DIGEST_FIELD = "scheduleProposalDigest";

/** Every fact the server derives or owns, under the names a client might try. Refused by name so that the refusal says why. */
const FORBIDDEN_FIELDS: ReadonlySet<string> = new Set([
  "teams", "team", "teamIds", "teamAId", "teamBId", "pairing", "pairings", "drawOrder", "drawPosition", "bracket", "semifinals", "semifinal1", "semifinal2", "final",
  "kickoff", "kickoffs", "kickoffTimes", "scheduledAt", "startsAt", "startUtc", "endsAt", "startTime", "planDate", "date", "dates", "time",
  "pitch", "pitches", "pitchId", "planningPitchId", "venue", "venueName", "location",
  "timeZone", "timezone", "tz", "utcOffset", "duration", "durationMinutes", "occupancy", "capacity", "simultaneousMatchCapacity",
  "format", "formatKey", "activityKey", "timing", "rules",
  "draw", "drawId", "drawDigest", "planningRevision", "planningRevisionId", "planningRevisionNumber", "proposal", "proposalId", "scheduleProposalId", "scheduleProposalSequence",
  "fixtureId", "fixtureIds", "semifinal1FixtureId", "semifinal2FixtureId", "finalFixtureId", "competitionFixtureId",
  "competitionId", "organizerGamingMemberId", "gamingMemberId", "actor", "actorId", "authority", "role", "publishedBy", "publishedAt", "state", "status", "publicationDigest", "intentId",
]);

export interface LegacyPublishRequest extends Record<LegacyField, string> { kind: "LEGACY" }
export type PublishRequest = { kind: "SCHEDULE"; scheduleProposalDigest: string } | LegacyPublishRequest;

const problem = (field: string, code: string, message: string): PlanningViolation => ({ field, code, message });

/**
 * The request is exactly `{ scheduleProposalDigest }` — 64 lowercase hexadecimal digits — or, for a competition outside the schedule journey, exactly the seven legacy manual
 * fields. A body that mixes the two, names a field the server derives, or carries any field at all beyond one of those two shapes is refused with every problem listed.
 */
export function parsePublishRequest(body: unknown): PublishRequest {
  if (!isPlainObject(body)) throw new SchedulePublicationRequestError([problem("body", "REQUEST_NOT_OBJECT", "The request must be a JSON object.")]);
  const keys = Object.keys(body);
  const violations: PlanningViolation[] = [];
  if (keys.includes(DIGEST_FIELD)) {
    for (const key of keys) {
      if (key === DIGEST_FIELD) continue;
      if (LEGACY_SET.has(key)) violations.push(problem(key, "MIXED_SHAPES", "A schedule publication carries only the digest of the proposal; the manual teams and times cannot be sent with it."));
      else if (FORBIDDEN_FIELDS.has(key)) violations.push(problem(key, "FORBIDDEN_FIELD", "This is decided by the server from the draw, the proposal and the plan, and can never be sent."));
      else violations.push(problem(key, "UNKNOWN_FIELD", "This field is not part of the request."));
    }
    if (!isDigest(body[DIGEST_FIELD])) violations.push(problem(DIGEST_FIELD, "DIGEST_INVALID", "The schedule proposal digest must be 64 lowercase hexadecimal digits."));
    if (violations.length > 0) throw new SchedulePublicationRequestError(violations);
    return { kind: "SCHEDULE", scheduleProposalDigest: body[DIGEST_FIELD] as string };
  }
  for (const key of keys) {
    if (LEGACY_SET.has(key)) continue;
    if (FORBIDDEN_FIELDS.has(key)) violations.push(problem(key, "FORBIDDEN_FIELD", "This is decided by the server and can never be sent."));
    else violations.push(problem(key, "UNKNOWN_FIELD", "This field is not part of the request."));
  }
  for (const field of LEGACY_PUBLISH_FIELDS) {
    if (!keys.includes(field)) violations.push(problem(field, "FIELD_REQUIRED", "This field is required."));
    else if (typeof body[field] !== "string") violations.push(problem(field, "FIELD_INVALID", "This field must be text."));
  }
  if (violations.length > 0) throw new SchedulePublicationRequestError(violations);
  return { kind: "LEGACY", ...(Object.fromEntries(LEGACY_PUBLISH_FIELDS.map((field) => [field, body[field] as string])) as Record<LegacyField, string>) };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The digest and the reproduction of a stored publication
// ---------------------------------------------------------------------------------------------------------------------------------------------

export type SchedulePublicationDigestInput = Omit<SchedulePublicationRecord, "publicationDigest">;

const ROLE_INDEX: ReadonlyMap<string, number> = new Map(ROLES.map((role, i) => [role, i]));

/** The canonical text a publication's digest is computed from (see the header of this file). */
export function schedulePublicationCanonicalText(competitionId: string, input: SchedulePublicationDigestInput): string {
  const lines = [
    SCHEDULE_PUBLICATION_DIGEST_VERSION,
    `competition:${competitionId}`,
    `proposal:${input.scheduleProposalSequence},${input.scheduleProposalDigest}`,
    `planning-revision:${input.planningRevisionId}`,
    `draw:${input.drawId},${input.drawDigest}`,
    `published-by:${input.publishedByGamingMemberId}`,
    `published-at:${input.publishedAt}`,
  ];
  const ordered = [...input.fixtures].sort((a, b) => (ROLE_INDEX.get(a.fixtureRole) ?? 9) - (ROLE_INDEX.get(b.fixtureRole) ?? 9));
  for (const f of ordered) {
    const isFinal = f.fixtureRole === "FINAL";
    lines.push(`fixture:${f.fixtureRole},${f.competitionFixtureId},${f.startsAt},${(isFinal ? f.sourceFixtureAId : f.teamAId) ?? ""},${(isFinal ? f.sourceFixtureBId : f.teamBId) ?? ""}`);
  }
  return lines.join("\n");
}

export function computeSchedulePublicationDigest(competitionId: string, input: SchedulePublicationDigestInput): string {
  return sha256(schedulePublicationCanonicalText(competitionId, input));
}

export type SchedulePublicationVerification = { ok: true } | { ok: false; reason: string };

/**
 * Reproduces a stored publication from its own evidence: the shape of every fact, the three fixtures in role order with their roles' links (a semifinal's two distinct teams and no
 * source; the final's two sources — the semifinals, in order — and no team), and the digest, recomputed. Evidence that does not reproduce is never handed on.
 */
export function verifySchedulePublication(competitionId: string, record: SchedulePublicationRecord): SchedulePublicationVerification {
  const fail = (reason: string): SchedulePublicationVerification => ({ ok: false, reason });
  if (!isUuid(competitionId)) return fail("the competition identifier is not an identifier");
  if (!Number.isInteger(record.scheduleProposalSequence) || record.scheduleProposalSequence < 1) return fail("the proposal sequence is not a whole number from one");
  if (!isDigest(record.scheduleProposalDigest)) return fail("the proposal digest is not 64 lowercase hexadecimal digits");
  if (!isDigest(record.drawDigest)) return fail("the draw digest is not 64 lowercase hexadecimal digits");
  if (!isDigest(record.publicationDigest)) return fail("the publication digest is not 64 lowercase hexadecimal digits");
  if (!isUuid(record.planningRevisionId) || !isUuid(record.drawId) || !isUuid(record.publishedByGamingMemberId)) return fail("an identifier is not an identifier");
  if (typeof record.publishedAt !== "string" || !INSTANT_US_PATTERN.test(record.publishedAt)) return fail("the publication instant is not UTC with six fractional digits");
  const fixtures = record.fixtures;
  if (!Array.isArray(fixtures) || fixtures.length !== 3) return fail("a publication has exactly three fixtures");
  const ids = new Set<string>();
  const teams = new Set<string>();
  for (let i = 0; i < 3; i++) {
    const f = fixtures[i];
    if (!f || f.fixtureRole !== ROLES[i]) return fail("the fixtures are not in role order");
    if (!isUuid(f.competitionFixtureId)) return fail("a fixture identifier is not an identifier");
    ids.add(f.competitionFixtureId);
    if (typeof f.startsAt !== "string" || !INSTANT_MS_PATTERN.test(f.startsAt)) return fail("a start is not UTC with three fractional digits");
    if (i < 2) {
      if (!isUuid(f.teamAId) || !isUuid(f.teamBId)) return fail("a semifinal has two teams");
      if (f.sourceFixtureAId !== null || f.sourceFixtureBId !== null) return fail("a semifinal has no source fixture");
      teams.add(f.teamAId);
      teams.add(f.teamBId);
    } else {
      if (f.teamAId !== null || f.teamBId !== null) return fail("the final has no team yet");
      if (f.sourceFixtureAId !== fixtures[0].competitionFixtureId || f.sourceFixtureBId !== fixtures[1].competitionFixtureId) return fail("the final's sources are the two semifinals, in order");
    }
  }
  if (ids.size !== 3) return fail("the three fixtures are not distinct");
  if (teams.size !== 4) return fail("the four teams are not distinct");
  if (computeSchedulePublicationDigest(competitionId, record) !== record.publicationDigest) return fail("the digest does not match the evidence");
  return { ok: true };
}

/** The repository's check before it returns evidence: a publication that does not reproduce is an error, never data. */
export function assertSchedulePublicationVerifies(competitionId: string, record: SchedulePublicationRecord): void {
  const verdict = verifySchedulePublication(competitionId, record);
  if (!verdict.ok) throw new Error(`The recorded schedule publication could not be verified: ${verdict.reason}.`);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// What the database returns, judged strictly
// ---------------------------------------------------------------------------------------------------------------------------------------------

const unreadable = () => new Error("The recorded schedule publication could not be read.");
const text = (value: unknown): string => { if (typeof value !== "string") throw unreadable(); return value; };
const identifier = (value: unknown): string => { if (!isUuid(value)) throw unreadable(); return value; };
const nullableIdentifier = (value: unknown): string | null => { if (value === null) return null; return identifier(value); };
const digest = (value: unknown): string => { if (!isDigest(value)) throw unreadable(); return value; };
const instant = (value: unknown, pattern: RegExp): string => { if (typeof value !== "string" || !pattern.test(value)) throw unreadable(); return value; };
const whole = (value: unknown): number => { if (typeof value !== "number" || !Number.isInteger(value) || value < 1) throw unreadable(); return value; };
const role = (value: unknown): ScheduleFixtureRole => { if (typeof value !== "string" || !ROLE_INDEX.has(value)) throw unreadable(); return value as ScheduleFixtureRole; };

function fixtureFromDatabase(raw: unknown): SchedulePublicationFixtureRecord {
  if (!isPlainObject(raw)) throw unreadable();
  return {
    fixtureRole: role(raw.fixture_role),
    competitionFixtureId: identifier(raw.fixture_id),
    startsAt: instant(raw.start_utc, INSTANT_MS_PATTERN),
    teamAId: nullableIdentifier(raw.team_a_id),
    teamBId: nullableIdentifier(raw.team_b_id),
    sourceFixtureAId: nullableIdentifier(raw.source_fixture_a_id),
    sourceFixtureBId: nullableIdentifier(raw.source_fixture_b_id),
  };
}

/** A publication exactly as the database's evidence function returns it. Anything that is not exactly that is an error, never "nothing yet". */
export function schedulePublicationRecordFromDatabase(raw: unknown): SchedulePublicationRecord {
  if (!isPlainObject(raw)) throw unreadable();
  if (!Array.isArray(raw.fixtures) || raw.fixtures.length !== 3) throw unreadable();
  return {
    scheduleProposalSequence: whole(raw.schedule_proposal_sequence),
    scheduleProposalDigest: digest(raw.schedule_proposal_digest),
    planningRevisionId: identifier(raw.planning_revision_id),
    drawId: identifier(raw.draw_id),
    drawDigest: digest(raw.draw_digest),
    publishedByGamingMemberId: identifier(raw.published_by),
    publishedAt: instant(raw.published_at, INSTANT_US_PATTERN),
    publicationDigest: digest(raw.publication_digest),
    fixtures: raw.fixtures.map(fixtureFromDatabase),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// What a browser may see
// ---------------------------------------------------------------------------------------------------------------------------------------------

/**
 * The publication as a browser is shown it: every field is copied by name, so nothing the server holds beyond this list can reach a response. `result` is the shape the manual
 * publication always answered with, so a caller that read it keeps working; `publication` is the bounded evidence. No plan revision, draw, team, member or seed is in it.
 */
export function publicScheduledPublication(result: PublishScheduledCompetitionResult) {
  const [first, second, final] = result.publication.fixtures;
  return {
    result: {
      competitionId: result.competitionId,
      state: "PUBLISHED" as const,
      publishedAt: result.publication.publishedAt,
      semifinal1FixtureId: first.competitionFixtureId,
      semifinal2FixtureId: second.competitionFixtureId,
      finalFixtureId: final.competitionFixtureId,
    },
    publication: {
      alreadyPublished: result.alreadyPublished === true,
      scheduleProposalDigest: result.publication.scheduleProposalDigest,
      publicationDigest: result.publication.publicationDigest,
      publishedAt: result.publication.publishedAt,
      fixtures: result.publication.fixtures.map((f) => ({ fixtureRole: f.fixtureRole, competitionFixtureId: f.competitionFixtureId, startsAt: f.startsAt })),
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The command
// ---------------------------------------------------------------------------------------------------------------------------------------------

/**
 * PUBLISH_COMPETITION from a schedule proposal. It passes the competition, the verified caller and the digest — and nothing else — to the one atomic operation, which makes every
 * decision itself, so this function is never the only guard. It reads no clock and builds no fixture.
 */
export async function publishScheduledCompetition(
  repo: CompetitionSchedulePublicationStore,
  competitionId: string,
  organizerGamingMemberId: string,
  request: { scheduleProposalDigest: string }
): Promise<PublishScheduledCompetitionResult> {
  if (!isDigest(request?.scheduleProposalDigest)) {
    throw new SchedulePublicationRequestError([problem(DIGEST_FIELD, "DIGEST_INVALID", "The schedule proposal digest must be 64 lowercase hexadecimal digits.")]);
  }
  return repo.publishScheduledCompetition(competitionId, organizerGamingMemberId, request.scheduleProposalDigest);
}
