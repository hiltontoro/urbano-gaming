import { createHash } from "node:crypto";

import type { CompetitionsRepository, CompetitionScheduleProposalStore } from "./db/competitionsRepository";
import type {
  CreateScheduleProposalResult, ScheduleContextRecord, ScheduleFixtureRole, ScheduleProposalPlacementRecord, ScheduleProposalRead, ScheduleProposalRecord, ScheduleProposalStatus,
  ScheduleProposalSummary, ScheduleRequestPlacement, ScheduleTimingRecord,
} from "./types";
import { CompetitionAccessDeniedError, CompetitionNotFoundError, HostAccessRevokedError } from "./types";
import { getSoccerFormatRule, isSoccerFormatKey } from "./formats";
import type { SoccerFormatKey } from "./formats";
import { isActiveOrganizer } from "./organizerAccess";
import { isValidIanaTimeZone, resolveLocalTime } from "./planning";
import type { PlanningViolation } from "./planning";

/**
 * UG-CR-GATE-SSS-022 — the four-team schedule proposal, backend foundation (application side).
 *
 * A proposal is the organizer's complete schedule for the two semifinals and the final of a drawn, frozen, four-team competition: where and when each is played. It is a
 * recorded PROPOSAL and nothing more — it creates no fixture, publishes nothing, changes no state and is not yet what a publication reads.
 *
 * The decisions are the database's, made inside its one atomic operation: who may propose (the competition's own ACTIVE organizer — never a captain, a scorekeeper, an
 * ordinary member or a holder of OPERATIONAL authority alone), the lifecycle, the one permanent draw, the current accepted plan, a plan change that genuinely awaits the
 * captains, the idempotency of an intent, the gap-free sequence, the supersession, and every scheduling rule. This module holds only what the application adds: the strict
 * request allowlist, the pure evaluator the database also implements (so a stored proposal can be reproduced, and checked, outside the database, and the two
 * implementations compared row for row), the timing taken from the format registry, the digests, the typed refusals with their stable codes, the bounded shapes a browser is
 * shown, and the two commands behind the route. It reads no clock and contains no source of randomness: the decision instant is the database's alone.
 *
 * WHAT A CLIENT CAN SEND is an intent and exactly three placements — the first semifinal, the second semifinal and the final — each exactly a planning pitch identifier, a
 * plan date and a venue-local start time. Everything else is derived by the server: the teams and the pairing from the permanent draw (positions one and two meet in the first
 * semifinal, three and four in the second); the venue, the zone, the capacity, the dates, the windows and the pitches from the current accepted planning revision; the timing
 * from the format registry; the actor from the verified caller.
 *
 * THE RULES, all judged on real elapsed time (instants, never wall-clock arithmetic), in this order — the database raises the first violation in the same order:
 *   per placement, in role order: the pitch is the plan's, is usable and takes the format; the date is the plan's; the local time exists once in the venue's zone (a time the
 *   clocks skip or repeat is refused, never shifted); the start is strictly after the decision instant; the whole occupancy lies inside one accepted window.
 *   then across the placements: the same pitch is never occupied twice at once and a kickoff on it is never sooner than the occupancy plus the format's pitch transition after
 *   another's (pairs in the order first/second semifinal, first semifinal/final, second semifinal/final); no more matches are on at once than the venue's capacity; and the final
 *   starts no sooner than the format's team rest after the LATER semifinal's reserved occupancy ends (both possible finalists are protected). A match that ends early shortens
 *   nothing: the occupancy is reserved in full, shootout reserve included.
 *
 * THE DIGESTS. Both are the lowercase hexadecimal SHA-256 of the canonical text, in UTF-8, lines joined by a newline with none at the end.
 *   request (version 1):  URBANO-COMPETITION-SCHEDULE-REQUEST-V1 / competition:<id> / intent:<id> / one line per placement in role order:
 *                         placement:<role>,<pitch id>,<plan date>,<local start HH:MM>
 *   proposal (version 1): URBANO-COMPETITION-SCHEDULE-PROPOSAL-V1 / competition:<id> / sequence:<n> / supersedes:<previous proposal's digest, or none> / request-digest:<hex> /
 *                         planning-revision:<id> / draw:<id> / draw-digest:<hex> / format:<key> / time-zone:<IANA name> / capacity:<n> / occupancy-minutes:<n> /
 *                         pitch-transition-minutes:<n> / team-rest-minutes:<n> / one line per placement in role order:
 *                         placement:<role>,<pitch id>,<plan date>,<local start>,<start UTC>,<occupancy end UTC>,<window start UTC>,<window end UTC>
 *                         (every instant as YYYY-MM-DDTHH:MM:SS.mmmZ).
 * The database functions competition_schedule_request_digest and competition_schedule_proposal_digest compute the very same values; both are pinned by known answers.
 *
 * Errors are defined here, not in types.ts: the route owns their wording and status, and none of the database's words reaches a browser.
 */

export const SCHEDULE_REQUEST_DIGEST_VERSION = "URBANO-COMPETITION-SCHEDULE-REQUEST-V1";
export const SCHEDULE_PROPOSAL_DIGEST_VERSION = "URBANO-COMPETITION-SCHEDULE-PROPOSAL-V1";
export const FIXTURE_ROLES: readonly ScheduleFixtureRole[] = Object.freeze(["SEMIFINAL_1", "SEMIFINAL_2", "FINAL"] as const);
export const SCHEDULE_PLACEMENT_COUNT = 3;
/** The most proposals of one competition a single read returns in its history, newest first. */
export const SCHEDULE_HISTORY_LIMIT = 50;

const ROLE_INDEX: ReadonlyMap<string, number> = new Map(FIXTURE_ROLES.map((role, i) => [role, i]));
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const INSTANT_MS_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const INSTANT_US_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
const FIRST_YEAR = 2020;
const LAST_YEAR = 2099;
const MINUTE_MS = 60_000;
const STATUSES: ReadonlySet<string> = new Set(["CURRENT", "STALE", "SUPERSEDED"]);

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
const instant = (ms: number) => new Date(ms).toISOString();
const lower = (id: string) => id.toLowerCase();

function isRealDate(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const match = DATE_PATTERN.exec(value);
  if (!match) return false;
  const [y, m, d] = [Number(match[1]), Number(match[2]), Number(match[3])];
  if (y < FIRST_YEAR || y > LAST_YEAR) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}
const isLocalTime = (value: unknown): value is string => typeof value === "string" && TIME_PATTERN.test(value);
const isUuid = (value: unknown): value is string => typeof value === "string" && UUID_PATTERN.test(value);

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The timing: taken from the format registry, never typed in
// ---------------------------------------------------------------------------------------------------------------------------------------------

export interface ScheduleTiming extends ScheduleTimingRecord {
  /** The earliest a kickoff may follow another kickoff on the SAME pitch: the full reserved occupancy plus the pitch transition. */
  samePitchKickoffGapMinutes: number;
  /** The earliest the final may kick off after the LATER semifinal's kickoff: that semifinal's full reserved occupancy plus the format's team rest. */
  finalAfterSemifinalKickoffMinutes: number;
}

/**
 * The reserved timing of one match of a format: first half + halftime + second half + the FULL shootout reserve is what the pitch is held for; the pitch transition follows
 * it before the same pitch is used again; the team rest follows it before a finalist plays again. A format the registry does not know has no timing (never a default).
 */
export function scheduleTimingFor(formatKey: unknown): ScheduleTiming {
  const t = getSoccerFormatRule(formatKey).timing;
  const occupancy = t.halves * t.minutesPerHalf + t.halftimeMinutes + t.knockoutShootoutReserveMinutes;
  return {
    occupancyMinutes: occupancy,
    pitchTransitionMinutes: t.pitchTransitionMinutes,
    minimumTeamRestMinutes: t.minimumTeamRestMinutes,
    samePitchKickoffGapMinutes: occupancy + t.pitchTransitionMinutes,
    finalAfterSemifinalKickoffMinutes: occupancy + t.minimumTeamRestMinutes,
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Typed refusals
// ---------------------------------------------------------------------------------------------------------------------------------------------

export type ScheduleProposalCode = "NOT_AVAILABLE" | "WRONG_STATE" | "FREEZE_REQUIRED" | "FREEZE_INCONSISTENT" | "DRAW_REQUIRED" | "PLAN_REQUIRED" | "AMENDMENT_PENDING" | "INTENT_MISMATCH";

const MESSAGES: Record<ScheduleProposalCode, string> = {
  NOT_AVAILABLE: "There is no schedule proposal here that you can act on.",
  WRONG_STATE: "A schedule can be proposed only while the competition is ready to publish, before anything has been scheduled or played.",
  FREEZE_REQUIRED: "Registration must be closed and frozen before a schedule can be proposed.",
  FREEZE_INCONSISTENT: "The frozen registration no longer matches this competition, so a schedule cannot be proposed.",
  DRAW_REQUIRED: "The draw must be made before a schedule can be proposed.",
  PLAN_REQUIRED: "The competition has no accepted plan to schedule against.",
  AMENDMENT_PENDING: "A plan change is still waiting for the captains' answers. Wait until it is decided, withdrawn or has expired before proposing a schedule.",
  INTENT_MISMATCH: "This request identifier was already used for a different schedule. Review the proposals and send the new schedule with a new identifier.",
};

/** A refusal of a schedule proposal. The code is stable and bounded; the wording is the application's, never the database's. */
export class ScheduleProposalError extends Error {
  readonly code: ScheduleProposalCode;
  constructor(code: ScheduleProposalCode) {
    super(MESSAGES[code]);
    this.name = "ScheduleProposalError";
    this.code = code;
  }
}

/** The one uniform answer for everything the caller has no part in: a stranger, an unknown competition, a former host, a captain, a scorekeeper. */
export class ScheduleProposalNotAvailableError extends ScheduleProposalError {
  constructor() {
    super("NOT_AVAILABLE");
    this.name = "ScheduleProposalNotAvailableError";
  }
}

/** Every reason a request is not acceptable. Always a 400 at the boundary. */
export class ScheduleProposalValidationError extends Error {
  readonly violations: readonly PlanningViolation[];
  constructor(violations: readonly PlanningViolation[]) {
    super("The schedule proposal is not valid.");
    this.name = "ScheduleProposalValidationError";
    this.violations = violations;
  }
}

const DATABASE_CODES: Array<[string, ScheduleProposalCode]> = [
  ["SCHEDULE_PROPOSAL_WRONG_STATE", "WRONG_STATE"],
  ["SCHEDULE_PROPOSAL_FREEZE_REQUIRED", "FREEZE_REQUIRED"],
  ["SCHEDULE_PROPOSAL_FREEZE_INCONSISTENT", "FREEZE_INCONSISTENT"],
  ["SCHEDULE_PROPOSAL_DRAW_REQUIRED", "DRAW_REQUIRED"],
  ["SCHEDULE_PROPOSAL_PLAN_REQUIRED", "PLAN_REQUIRED"],
  ["SCHEDULE_PROPOSAL_AMENDMENT_PENDING", "AMENDMENT_PENDING"],
  ["SCHEDULE_PROPOSAL_INTENT_MISMATCH", "INTENT_MISMATCH"],
];

/** The typed error for a refusal raised inside the database, or null when the message is not one of this gate's. Only the codes — never the words — are used. */
export function scheduleProposalErrorFromDatabase(message: string): ScheduleProposalError | ScheduleProposalValidationError | null {
  if (typeof message !== "string" || message === "") return null;
  const invalid = /SCHEDULE_PROPOSAL_INVALID: ([A-Z_]+): ([^\n]*)/.exec(message);
  if (invalid) {
    const text = invalid[2].trim();
    return new ScheduleProposalValidationError([{ field: "schedule", code: invalid[1], message: text.charAt(0).toUpperCase() + text.slice(1) + (/[.!?]$/.test(text) ? "" : ".") }]);
  }
  if (message.includes("SCHEDULE_PROPOSAL_INVALID")) {
    return new ScheduleProposalValidationError([{ field: "schedule", code: "INVALID", message: "The schedule proposal is not valid." }]);
  }
  for (const [databaseCode, code] of DATABASE_CODES) {
    if (message.includes(databaseCode)) return new ScheduleProposalError(code);
  }
  return null;
}

/** The one sentence the route says when the caller has no part in a schedule proposal. It names nothing: not the competition, the state, the roles or whether anything exists. */
export const SCHEDULE_PROPOSAL_NOT_FOUND_MESSAGE = "A schedule proposal was not found for this competition.";

/**
 * How a failed proposal operation is answered. Everything that means "you have no part in this" — the uniform not-available, and the database's own ownership, revocation
 * and not-found refusals (which a race can still produce after the application's check) — is the same 404 with the same words, so nobody can tell an unknown competition
 * from a stranger, a former host from a current one. An invalid schedule or request is a 400 with every problem; every other typed refusal is a 409 with its stable code and
 * the application's bounded wording. Anything else is not this module's to describe: null.
 */
export function scheduleProposalFailure(err: unknown): { status: number; body: { error: string; code?: ScheduleProposalCode; problems?: readonly PlanningViolation[] } } | null {
  if (err instanceof ScheduleProposalValidationError) return { status: 400, body: { error: err.message, problems: err.violations } };
  if (err instanceof ScheduleProposalNotAvailableError || err instanceof CompetitionNotFoundError || err instanceof CompetitionAccessDeniedError || err instanceof HostAccessRevokedError) {
    return { status: 404, body: { error: SCHEDULE_PROPOSAL_NOT_FOUND_MESSAGE } };
  }
  if (err instanceof ScheduleProposalError) return { status: 409, body: { error: err.message, code: err.code } };
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------------------------------------------------------------------------

export interface ScheduleProposalRequest {
  intentId: string;
  /** Exactly three, in role order. */
  placements: ScheduleRequestPlacement[];
}

/**
 * Everything a client might send to name teams or an order, to state a time the server derives, a duration, a capacity, a venue fact, a format, a timing value, an actor or a
 * fixture. Naming one is refused as such (not merely as "unknown").
 */
const FORBIDDEN_FIELDS: ReadonlySet<string> = new Set([
  "teams", "team", "teamIds", "teamA", "teamB", "pairing", "pairings", "semifinals", "bracket", "drawOrder", "drawPosition", "order", "seed",
  "startUtc", "endUtc", "utc", "startsAt", "endsAt", "scheduledAt", "timeZone", "timezone", "tz", "utcOffset", "offset", "duration", "durationMinutes", "occupancy", "occupancyMinutes",
  "transition", "rest", "restMinutes", "capacity", "simultaneousMatchCapacity", "venue", "venueName", "venueTimeZone", "windows", "window",
  "format", "formatKey", "activityKey", "timing", "halves", "minutesPerHalf", "halftimeMinutes", "pitchTransitionMinutes", "minimumTeamRestMinutes", "knockoutShootoutReserveMinutes",
  "organizer", "organizerId", "organizerGamingMemberId", "gamingMemberId", "memberId", "actor", "actorId", "authority", "capability",
  "fixtureId", "competitionFixtureId", "fixtures", "competitionId", "planningRevisionId", "planningRevision", "drawId", "drawDigest", "sequence", "sequenceNumber", "supersedes", "digest", "state", "now",
]);
const PLACEMENT_KEYS: ReadonlySet<string> = new Set(["fixtureRole", "planningPitchId", "planDate", "startTime"]);

function unknownField(key: string, field: string): PlanningViolation {
  return FORBIDDEN_FIELDS.has(key)
    ? { field, code: "FORBIDDEN_FIELD", message: "The server derives this from the draw, the plan and the format; it cannot be supplied." }
    : { field, code: "UNKNOWN_FIELD", message: "This field is not part of the request." };
}

/**
 * The body of a schedule proposal request: exactly an intent and three placements, one per role, each exactly a planning pitch identifier, a plan date and a venue-local
 * start time. The organizer is always the verified caller and nothing else is accepted. Every problem is reported at once; the placements come back in role order with the
 * pitch identifier in lowercase, whatever order they were sent in.
 */
export function parseScheduleProposalRequest(body: unknown): ScheduleProposalRequest {
  if (!isPlainObject(body)) throw new ScheduleProposalValidationError([{ field: "request", code: "REQUEST_NOT_OBJECT", message: "The request must be an object." }]);
  const violations: PlanningViolation[] = [];
  for (const key of Object.keys(body)) {
    if (key !== "intentId" && key !== "placements") violations.push(unknownField(key, key));
  }
  if (!isUuid(body.intentId)) violations.push({ field: "intentId", code: "INTENT_INVALID", message: "A request identifier is required." });

  const parsed: ScheduleRequestPlacement[] = [];
  const list = body.placements;
  if (!Array.isArray(list) || list.length !== SCHEDULE_PLACEMENT_COUNT) {
    violations.push({ field: "placements", code: "PLACEMENTS_INVALID", message: "Exactly three placements are required: the first semifinal, the second semifinal and the final." });
  } else {
    const seen = new Set<string>();
    list.forEach((raw: unknown, i: number) => {
      const at = `placements[${i}]`;
      if (!isPlainObject(raw)) {
        violations.push({ field: at, code: "PLACEMENT_NOT_OBJECT", message: "Each placement must be an object." });
        return;
      }
      for (const key of Object.keys(raw)) {
        if (!PLACEMENT_KEYS.has(key)) violations.push(unknownField(key, `${at}.${key}`));
      }
      let clean = true;
      const role = raw.fixtureRole;
      if (typeof role !== "string" || !ROLE_INDEX.has(role)) {
        violations.push({ field: `${at}.fixtureRole`, code: "ROLE_INVALID", message: "The role must be SEMIFINAL_1, SEMIFINAL_2 or FINAL." });
        clean = false;
      } else if (seen.has(role)) {
        violations.push({ field: `${at}.fixtureRole`, code: "ROLE_DUPLICATE", message: "Each role must appear exactly once." });
        clean = false;
      } else {
        seen.add(role);
      }
      if (!isUuid(raw.planningPitchId)) {
        violations.push({ field: `${at}.planningPitchId`, code: "PITCH_INVALID", message: "A planning pitch identifier is required." });
        clean = false;
      }
      if (!isRealDate(raw.planDate)) {
        violations.push({ field: `${at}.planDate`, code: "DATE_INVALID", message: "The plan date must be a real calendar day written YYYY-MM-DD." });
        clean = false;
      }
      if (!isLocalTime(raw.startTime)) {
        violations.push({ field: `${at}.startTime`, code: "TIME_INVALID", message: "The start time must be written HH:MM on a 24-hour clock, in the venue's time." });
        clean = false;
      }
      if (clean) parsed.push({ fixtureRole: role as ScheduleFixtureRole, planningPitchId: lower(raw.planningPitchId as string), planDate: raw.planDate as string, startTime: raw.startTime as string });
    });
    for (const role of FIXTURE_ROLES) {
      if (!seen.has(role)) violations.push({ field: "placements", code: "ROLE_MISSING", message: `The ${role} placement is missing.` });
    }
  }
  if (violations.length > 0) throw new ScheduleProposalValidationError(violations);
  parsed.sort((a, b) => ROLE_INDEX.get(a.fixtureRole)! - ROLE_INDEX.get(b.fixtureRole)!);
  return { intentId: lower(body.intentId as string), placements: parsed };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The evaluator: one complete schedule, judged against the plan's facts
// ---------------------------------------------------------------------------------------------------------------------------------------------

/** The facts of a plan revision the rules are judged against. In the database these come from the current accepted planning revision; here they are plain data. */
export interface ScheduleFacts {
  formatKey: SoccerFormatKey;
  timeZone: string;
  simultaneousMatchCapacity: number;
  pitches: ReadonlyArray<{ planningPitchId: string; label: string; usable: boolean; supportedFormats: readonly string[] }>;
  dates: ReadonlyArray<{ date: string; windows: ReadonlyArray<{ start: string; end: string }> }>;
}

export type DerivedPlacement = Omit<ScheduleProposalPlacementRecord, "teamA" | "teamB">;
export type ScheduleEvaluation = { ok: true; placements: DerivedPlacement[] } | { ok: false; violations: PlanningViolation[] };

interface Slot { role: ScheduleFixtureRole; pitch: string; startMs: number; endMs: number }

/** The rules that compare placements with each other, over instants. Shared by the evaluator and by the reproduction of stored evidence. */
function crossViolations(slots: readonly Slot[], timing: ScheduleTiming, capacity: number): PlanningViolation[] {
  const found: PlanningViolation[] = [];
  const add = (code: string, message: string) => {
    if (!found.some((v) => v.code === code)) found.push({ field: "schedule", code, message });
  };
  const gapMs = timing.samePitchKickoffGapMinutes * MINUTE_MS;
  for (const [i, j] of [[0, 1], [0, 2], [1, 2]]) {
    const a = slots[i];
    const b = slots[j];
    if (a.pitch !== b.pitch) continue;
    if (a.startMs < b.endMs && b.startMs < a.endMs) add("PITCH_OVERLAP", `Two matches would use the same pitch at the same time (${a.role} and ${b.role}).`);
    else if (Math.abs(a.startMs - b.startMs) < gapMs) add("PITCH_TRANSITION", `The same pitch needs ${timing.pitchTransitionMinutes} minutes after a match before the next one (${a.role} and ${b.role}).`);
  }
  for (const slot of slots) {
    const running = slots.filter((other) => other.startMs <= slot.startMs && slot.startMs < other.endMs).length;
    if (running > capacity) add("CAPACITY_EXCEEDED", `More matches would be on at once than the venue can host (${capacity}).`);
  }
  const earliestFinal = Math.max(slots[0].endMs, slots[1].endMs) + timing.minimumTeamRestMinutes * MINUTE_MS;
  if (slots[2].startMs < earliestFinal) add("FINAL_REST", `The final must start at least ${timing.minimumTeamRestMinutes} minutes after the later semifinal's reserved time ends.`);
  return found;
}

/**
 * Judges ONE complete schedule — the three placements, in role order — against the plan's facts and the format's timing, at the decision instant `nowMs` (null: do not judge
 * the future, as when stored evidence is re-examined). It returns either the derived schedule (the instants, and the accepted window each placement lies in) or every
 * violation in the order the database would raise them, the first being the one it raises. A placement is never altered to make it fit.
 */
export function evaluateScheduleProposal(facts: ScheduleFacts, placements: readonly ScheduleRequestPlacement[], nowMs: number | null): ScheduleEvaluation {
  if (!Array.isArray(placements) || placements.length !== SCHEDULE_PLACEMENT_COUNT) throw new RangeError("Exactly three placements are evaluated.");
  const timing = scheduleTimingFor(facts.formatKey);
  const occupancyMs = timing.occupancyMinutes * MINUTE_MS;
  const violations: PlanningViolation[] = [];
  const slots: Slot[] = [];
  const derived: DerivedPlacement[] = [];

  placements.forEach((p, i) => {
    const at = `placements[${i}]`;
    const fail = (field: string, code: string, message: string) => { violations.push({ field: `${at}.${field}`, code, message }); };
    const pitch = facts.pitches.find((x) => lower(x.planningPitchId) === lower(p.planningPitchId));
    if (!pitch) return fail("planningPitchId", "PITCH_NOT_IN_PLAN", "This pitch is not one of the pitches in the accepted plan.");
    if (!pitch.usable) return fail("planningPitchId", "PITCH_NOT_USABLE", "This pitch is marked as not usable in the accepted plan.");
    if (!pitch.supportedFormats.includes(facts.formatKey)) return fail("planningPitchId", "PITCH_FORMAT_UNSUPPORTED", "This pitch does not take this competition's format.");
    const day = facts.dates.find((d) => d.date === p.planDate);
    if (!day) return fail("planDate", "DATE_NOT_IN_PLAN", "This date is not one of the tournament dates in the accepted plan.");
    const local = resolveLocalTime(`${p.planDate}T${p.startTime}`, facts.timeZone);
    if (local.kind === "nonexistent") return fail("startTime", "LOCAL_TIME_NONEXISTENT", "This time does not exist on that date at the venue: the clocks skip it.");
    if (local.kind === "ambiguous") return fail("startTime", "LOCAL_TIME_AMBIGUOUS", "This time happens twice on that date at the venue: the clocks repeat it.");
    const startMs = Date.parse(local.instants[0].utc);
    if (nowMs !== null && !(startMs > nowMs)) return fail("startTime", "START_NOT_FUTURE", "The match must start after the moment this schedule is proposed.");
    const endMs = startMs + occupancyMs;
    let window: [number, number] | null = null;
    for (const w of day.windows) {
      const opens = resolveLocalTime(`${p.planDate}T${w.start}`, facts.timeZone);
      const closes = resolveLocalTime(`${p.planDate}T${w.end}`, facts.timeZone);
      if (opens.kind !== "ok" || closes.kind !== "ok") continue;
      const [a, b] = [Date.parse(opens.instants[0].utc), Date.parse(closes.instants[0].utc)];
      if (a <= startMs && endMs <= b) { window = [a, b]; break; }
    }
    if (!window) return fail("startTime", "OUTSIDE_WINDOW", "The match, with its full reserved time, does not fit inside one operating window of that date.");
    slots.push({ role: p.fixtureRole, pitch: lower(p.planningPitchId), startMs, endMs });
    derived.push({
      fixtureRole: p.fixtureRole, planningPitchId: lower(p.planningPitchId), pitchLabel: pitch.label, planDate: p.planDate, startTime: p.startTime,
      startUtc: instant(startMs), endUtc: instant(endMs), windowStartUtc: instant(window[0]), windowEndUtc: instant(window[1]),
    });
  });

  if (violations.length === 0) violations.push(...crossViolations(slots, timing, facts.simultaneousMatchCapacity));
  return violations.length === 0 ? { ok: true, placements: derived } : { ok: false, violations };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The digests
// ---------------------------------------------------------------------------------------------------------------------------------------------

/** The digest of one request: see the canonical text in this file's header. Independent of the order the placements arrive in and of the case of an identifier. */
export function computeScheduleRequestDigest(competitionId: string, intentId: string, placements: readonly ScheduleRequestPlacement[]): string {
  const ordered = [...placements].sort((a, b) => ROLE_INDEX.get(a.fixtureRole)! - ROLE_INDEX.get(b.fixtureRole)!);
  return sha256([
    SCHEDULE_REQUEST_DIGEST_VERSION, `competition:${lower(competitionId)}`, `intent:${lower(intentId)}`,
    ...ordered.map((p) => `placement:${p.fixtureRole},${lower(p.planningPitchId)},${p.planDate},${p.startTime}`),
  ].join("\n"));
}

type DigestInput = Pick<ScheduleProposalRecord, "sequenceNumber" | "supersedesDigest" | "requestDigest" | "planningRevisionId" | "drawId" | "drawDigest" | "formatKey" | "timeZone"
  | "simultaneousMatchCapacity" | "timing"> & { placements: ReadonlyArray<Omit<ScheduleProposalPlacementRecord, "pitchLabel" | "teamA" | "teamB">> };

/** The digest of one proposal: see the canonical text in this file's header. It binds the plan revision, the draw and its digest, the timing and every instant — and nothing a browser is shown on top. */
export function computeScheduleProposalDigest(competitionId: string, record: DigestInput): string {
  const ordered = [...record.placements].sort((a, b) => ROLE_INDEX.get(a.fixtureRole)! - ROLE_INDEX.get(b.fixtureRole)!);
  return sha256([
    SCHEDULE_PROPOSAL_DIGEST_VERSION, `competition:${lower(competitionId)}`, `sequence:${record.sequenceNumber}`, `supersedes:${record.supersedesDigest ?? "none"}`,
    `request-digest:${record.requestDigest}`, `planning-revision:${lower(record.planningRevisionId)}`, `draw:${lower(record.drawId)}`, `draw-digest:${record.drawDigest}`,
    `format:${record.formatKey}`, `time-zone:${record.timeZone}`, `capacity:${record.simultaneousMatchCapacity}`,
    `occupancy-minutes:${record.timing.occupancyMinutes}`, `pitch-transition-minutes:${record.timing.pitchTransitionMinutes}`, `team-rest-minutes:${record.timing.minimumTeamRestMinutes}`,
    ...ordered.map((p) => `placement:${p.fixtureRole},${lower(p.planningPitchId)},${p.planDate},${p.startTime},${p.startUtc},${p.endUtc},${p.windowStartUtc},${p.windowEndUtc}`),
  ].join("\n"));
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The reproduction of a proposal from its stored evidence
// ---------------------------------------------------------------------------------------------------------------------------------------------

export type ScheduleVerification = { ok: true } | { ok: false; reason: string };

/**
 * Reproduces a proposal from its stored evidence ALONE — the shapes, the timing the registry gives the format, every instant from the local time and the venue's zone, the
 * occupancy, the window each placement lies in, every rule that compares placements, the teams the draw gave, and the digest of the whole — and reports the first thing that
 * does not hold. It never throws: evidence that cannot be evaluated does not verify.
 */
export function verifyScheduleProposal(competitionId: string, record: ScheduleProposalRecord): ScheduleVerification {
  const fail = (reason: string): ScheduleVerification => ({ ok: false, reason });
  try {
    if (!isPlainObject(record)) return fail("the evidence is not an object");
    const r = record as unknown as Record<string, any>;
    if (!Number.isInteger(r.sequenceNumber) || r.sequenceNumber < 1) return fail("the sequence number is not a positive whole number");
    if (typeof r.createdAt !== "string" || !INSTANT_US_PATTERN.test(r.createdAt)) return fail("the creation time is not a canonical instant");
    if (typeof r.status !== "string" || !STATUSES.has(r.status)) return fail("the status is not one of the known statuses");
    if (typeof r.planningRevisionCurrent !== "boolean" || typeof r.drawDigestMatches !== "boolean") return fail("a live fact is not a boolean");
    if (r.status === "CURRENT" && !(r.planningRevisionCurrent && r.drawDigestMatches)) return fail("a current proposal must rest on the current plan and the same draw");
    if (r.status === "STALE" && r.planningRevisionCurrent && r.drawDigestMatches) return fail("a proposal marked stale must have lost its plan or its draw");
    for (const key of ["proposalDigest", "requestDigest", "drawDigest"]) {
      if (typeof r[key] !== "string" || !DIGEST_PATTERN.test(r[key])) return fail(`the ${key} is malformed`);
    }
    if (r.supersedesDigest !== null && (typeof r.supersedesDigest !== "string" || !DIGEST_PATTERN.test(r.supersedesDigest))) return fail("the superseded digest is malformed");
    if ((r.sequenceNumber === 1) !== (r.supersedesDigest === null)) return fail("only the first proposal supersedes nothing");
    if (!isUuid(r.planningRevisionId) || !isUuid(r.drawId)) return fail("the plan revision or the draw is not identified");
    if (!Number.isInteger(r.planningRevisionNumber) || r.planningRevisionNumber < 1) return fail("the plan revision number is not a positive whole number");
    if (!isSoccerFormatKey(r.formatKey)) return fail("the format is not one the registry knows");
    if (!isValidIanaTimeZone(r.timeZone)) return fail("the time zone is not an IANA name");
    if (!Number.isInteger(r.simultaneousMatchCapacity) || r.simultaneousMatchCapacity < 1 || r.simultaneousMatchCapacity > 16) return fail("the capacity is outside one to sixteen");
    const timing = scheduleTimingFor(r.formatKey);
    if (!isPlainObject(r.timing) || r.timing.occupancyMinutes !== timing.occupancyMinutes || r.timing.pitchTransitionMinutes !== timing.pitchTransitionMinutes
      || r.timing.minimumTeamRestMinutes !== timing.minimumTeamRestMinutes) return fail("the timing is not the registry's for this format");

    if (!Array.isArray(r.placements) || r.placements.length !== SCHEDULE_PLACEMENT_COUNT) return fail("there must be exactly three placements");
    const slots: Slot[] = [];
    const teamIds: string[] = [];
    for (let i = 0; i < SCHEDULE_PLACEMENT_COUNT; i++) {
      const raw: unknown = r.placements[i];
      if (!isPlainObject(raw) || raw.fixtureRole !== FIXTURE_ROLES[i]) return fail("the placements are not one per role, in role order");
      const p = raw as Record<string, any>;
      if (!isUuid(p.planningPitchId)) return fail("a placement's pitch is not identified");
      if (typeof p.pitchLabel !== "string" || p.pitchLabel === "") return fail("a placement's pitch has no label");
      if (!isRealDate(p.planDate) || !isLocalTime(p.startTime)) return fail("a placement's date or local time is malformed");
      for (const key of ["startUtc", "endUtc", "windowStartUtc", "windowEndUtc"]) {
        if (typeof p[key] !== "string" || !INSTANT_MS_PATTERN.test(p[key])) return fail(`a placement's ${key} is not a canonical instant`);
      }
      const local = resolveLocalTime(`${p.planDate}T${p.startTime}`, r.timeZone);
      if (local.kind !== "ok" || local.instants[0].utc !== p.startUtc) return fail("a placement's start does not follow from its local time and the venue's zone");
      const startMs = Date.parse(p.startUtc);
      const endMs = Date.parse(p.endUtc);
      if (endMs !== startMs + timing.occupancyMinutes * MINUTE_MS) return fail("a placement's end is not its start plus the reserved occupancy");
      if (!(Date.parse(p.windowStartUtc) <= startMs && endMs <= Date.parse(p.windowEndUtc))) return fail("a placement's occupancy does not lie inside its window");
      const semifinal = i < 2;
      if (semifinal) {
        for (const side of [p.teamA, p.teamB]) {
          if (!isPlainObject(side) || !isUuid(side.teamId) || typeof side.teamName !== "string" || side.teamName === "") return fail("a semifinal does not name its two teams");
          teamIds.push(lower(side.teamId));
        }
      } else if (p.teamA !== null || p.teamB !== null) {
        return fail("the final already names teams, though its finalists are not known");
      }
      slots.push({ role: p.fixtureRole, pitch: lower(p.planningPitchId), startMs, endMs });
    }
    if (new Set(teamIds).size !== 4) return fail("the four teams of the semifinals are not four different teams");
    const broken = crossViolations(slots, timing, r.simultaneousMatchCapacity);
    if (broken.length > 0) return fail(`the schedule breaks a rule (${broken[0].code})`);
    if (computeScheduleProposalDigest(competitionId, r as ScheduleProposalRecord) !== r.proposalDigest) return fail("the proposal digest does not match the evidence");
    return { ok: true };
  } catch {
    return fail("the evidence could not be evaluated");
  }
}

/** Evidence that does not reproduce itself is never shown or returned: it is a failure, never a guess. */
export function assertScheduleProposalVerifies(competitionId: string, record: ScheduleProposalRecord): void {
  const result = verifyScheduleProposal(competitionId, record);
  if (!result.ok) throw new Error(`The recorded schedule proposal could not be verified: ${result.reason}.`);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// What the database returns, and what a browser may see
// ---------------------------------------------------------------------------------------------------------------------------------------------

const unreadable = () => new Error("The recorded schedule proposal could not be read.");
function text(value: unknown): string {
  if (typeof value !== "string" || value === "") throw unreadable();
  return value;
}
function whole(value: unknown): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw unreadable();
  return value;
}
function bool(value: unknown): boolean {
  if (typeof value !== "boolean") throw unreadable();
  return value;
}
function status(value: unknown): ScheduleProposalStatus {
  if (typeof value !== "string" || !STATUSES.has(value)) throw unreadable();
  return value as ScheduleProposalStatus;
}
function timingFrom(raw: unknown): ScheduleTimingRecord {
  if (!isPlainObject(raw)) throw unreadable();
  return { occupancyMinutes: whole(raw.occupancy_minutes), pitchTransitionMinutes: whole(raw.pitch_transition_minutes), minimumTeamRestMinutes: whole(raw.minimum_team_rest_minutes) };
}
function teamFrom(raw: unknown): { teamId: string; teamName: string } | null {
  if (raw === null) return null;
  if (!isPlainObject(raw)) throw unreadable();
  return { teamId: text(raw.team_id), teamName: text(raw.team_name) };
}

/** The database's evidence in the application's own shape. Every field is copied by name and judged strictly; evidence that is not exactly this shape is a failure. */
export function scheduleProposalRecordFromDatabase(raw: unknown): ScheduleProposalRecord {
  if (!isPlainObject(raw)) throw unreadable();
  if (!Array.isArray(raw.placements) || raw.placements.length !== SCHEDULE_PLACEMENT_COUNT) throw unreadable();
  const supersedes = raw.supersedes_digest;
  if (supersedes !== null && (typeof supersedes !== "string" || supersedes === "")) throw unreadable();
  return {
    sequenceNumber: whole(raw.sequence_number),
    createdAt: text(raw.created_at),
    status: status(raw.status),
    planningRevisionCurrent: bool(raw.planning_revision_current),
    drawDigestMatches: bool(raw.draw_digest_matches),
    proposalDigest: text(raw.proposal_digest),
    requestDigest: text(raw.request_digest),
    supersedesDigest: supersedes as string | null,
    planningRevisionId: text(raw.planning_revision_id),
    planningRevisionNumber: whole(raw.planning_revision_number),
    drawId: text(raw.draw_id),
    drawDigest: text(raw.draw_digest),
    formatKey: text(raw.format_key) as SoccerFormatKey,
    timeZone: text(raw.time_zone),
    simultaneousMatchCapacity: whole(raw.simultaneous_match_capacity),
    timing: timingFrom(raw.timing),
    placements: raw.placements.map((p: unknown) => {
      if (!isPlainObject(p)) throw unreadable();
      return {
        fixtureRole: text(p.fixture_role) as ScheduleFixtureRole,
        planningPitchId: text(p.planning_pitch_id),
        pitchLabel: text(p.pitch_label),
        planDate: text(p.plan_date),
        startTime: text(p.start_time),
        startUtc: text(p.start_utc),
        endUtc: text(p.end_utc),
        windowStartUtc: text(p.window_start_utc),
        windowEndUtc: text(p.window_end_utc),
        teamA: teamFrom(p.team_a),
        teamB: teamFrom(p.team_b),
      };
    }),
  };
}

/** The plan the proposals are judged against, in the application's shape; anything that is not exactly this shape is a failure. */
export function scheduleContextFromDatabase(raw: unknown): ScheduleContextRecord {
  if (!isPlainObject(raw) || !Array.isArray(raw.pitches) || !Array.isArray(raw.dates)) throw unreadable();
  return {
    planningRevisionNumber: whole(raw.planning_revision_number),
    formatKey: text(raw.format_key) as SoccerFormatKey,
    timeZone: text(raw.time_zone),
    simultaneousMatchCapacity: whole(raw.simultaneous_match_capacity),
    timing: timingFrom(raw.timing),
    pitches: raw.pitches.map((p: unknown) => {
      if (!isPlainObject(p) || !Array.isArray(p.supported_formats)) throw unreadable();
      return { planningPitchId: text(p.planning_pitch_id), label: text(p.label), usable: bool(p.usable), supportedFormats: p.supported_formats.map(text) };
    }),
    dates: raw.dates.map((d: unknown) => {
      if (!isPlainObject(d) || !Array.isArray(d.windows)) throw unreadable();
      return {
        date: text(d.date),
        windows: d.windows.map((w: unknown) => {
          if (!isPlainObject(w)) throw unreadable();
          return { start: text(w.start), end: text(w.end) };
        }),
      };
    }),
  };
}

/** What the database tells the active organizer: the plan, the latest proposal in full, and the bounded history. A response without any of the three keys is a failure, never "nothing yet". */
export function scheduleReadFromDatabase(raw: unknown): ScheduleProposalRead {
  if (!isPlainObject(raw)) throw unreadable();
  if (!("context" in raw) || !("proposal" in raw) || !("history" in raw) || raw.context === undefined || raw.proposal === undefined || !Array.isArray(raw.history)) throw unreadable();
  const history: ScheduleProposalSummary[] = raw.history.map((h: unknown) => {
    if (!isPlainObject(h)) throw unreadable();
    return { sequenceNumber: whole(h.sequence_number), createdAt: text(h.created_at), status: status(h.status), proposalDigest: text(h.proposal_digest) };
  });
  return {
    context: raw.context === null ? null : scheduleContextFromDatabase(raw.context),
    proposal: raw.proposal === null ? null : scheduleProposalRecordFromDatabase(raw.proposal),
    history,
  };
}

/** The request placements in the database's own words. */
export function scheduleRpcPlacements(placements: readonly ScheduleRequestPlacement[]) {
  return placements.map((p) => ({ fixture_role: p.fixtureRole, planning_pitch_id: p.planningPitchId, plan_date: p.planDate, start_time: p.startTime }));
}

/**
 * The proposal as a browser may see it: every field is copied by name, so no identifier of a plan revision, a draw, a request, an intent or a member can reach a response.
 * The pairing is derived from the draw (a bracket slot, never a rank); the final names no team, because its finalists are not known.
 */
export function publicScheduleProposal(record: ScheduleProposalRecord) {
  return {
    sequenceNumber: record.sequenceNumber,
    createdAt: record.createdAt,
    status: record.status,
    planningRevisionCurrent: record.planningRevisionCurrent,
    drawDigestMatches: record.drawDigestMatches,
    proposalDigest: record.proposalDigest,
    supersedesDigest: record.supersedesDigest,
    planningRevisionNumber: record.planningRevisionNumber,
    drawDigest: record.drawDigest,
    formatKey: record.formatKey,
    timeZone: record.timeZone,
    simultaneousMatchCapacity: record.simultaneousMatchCapacity,
    timing: {
      occupancyMinutes: record.timing.occupancyMinutes, pitchTransitionMinutes: record.timing.pitchTransitionMinutes, minimumTeamRestMinutes: record.timing.minimumTeamRestMinutes,
    },
    placements: record.placements.map((p) => ({
      fixtureRole: p.fixtureRole,
      planningPitchId: p.planningPitchId,
      pitchLabel: p.pitchLabel,
      planDate: p.planDate,
      startTime: p.startTime,
      startUtc: p.startUtc,
      endUtc: p.endUtc,
      windowStartUtc: p.windowStartUtc,
      windowEndUtc: p.windowEndUtc,
      teamA: p.teamA ? { teamId: p.teamA.teamId, teamName: p.teamA.teamName } : null,
      teamB: p.teamB ? { teamId: p.teamB.teamId, teamName: p.teamB.teamName } : null,
    })),
  };
}

/** The plan as the organizer needs it to compose a proposal: the pitches with their identifiers, the dates and windows, the zone, the capacity and the registry timing. */
export function publicScheduleContext(context: ScheduleContextRecord) {
  return {
    planningRevisionNumber: context.planningRevisionNumber,
    formatKey: context.formatKey,
    timeZone: context.timeZone,
    simultaneousMatchCapacity: context.simultaneousMatchCapacity,
    timing: {
      occupancyMinutes: context.timing.occupancyMinutes, pitchTransitionMinutes: context.timing.pitchTransitionMinutes, minimumTeamRestMinutes: context.timing.minimumTeamRestMinutes,
    },
    pitches: context.pitches.map((p) => ({ planningPitchId: p.planningPitchId, label: p.label, usable: p.usable, supportedFormats: [...p.supportedFormats] })),
    dates: context.dates.map((d) => ({ date: d.date, windows: d.windows.map((w) => ({ start: w.start, end: w.end })) })),
  };
}

export function publicScheduleRead(read: ScheduleProposalRead) {
  return {
    context: read.context ? publicScheduleContext(read.context) : null,
    proposal: read.proposal ? publicScheduleProposal(read.proposal) : null,
    history: read.history.map((h) => ({ sequenceNumber: h.sequenceNumber, createdAt: h.createdAt, status: h.status, proposalDigest: h.proposalDigest })),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------------------------------------------------------

export type ScheduleProposalRepository = Pick<CompetitionsRepository, "getCompetitionById"> & CompetitionScheduleProposalStore;

/**
 * PROPOSE_COMPETITION_SCHEDULE. The same decisions are made again, atomically and under a lock, inside the database; this check decides first so that a caller who is not the
 * active organizer never learns anything about the competition (the database is not even asked). The organizer is always the verified caller.
 */
export async function createScheduleProposal(
  repo: ScheduleProposalRepository,
  competitionId: string,
  callerGamingMemberId: string,
  request: ScheduleProposalRequest
): Promise<CreateScheduleProposalResult> {
  const competition = await repo.getCompetitionById(competitionId);
  if (!competition || !isActiveOrganizer(competition, callerGamingMemberId)) throw new ScheduleProposalNotAvailableError();
  return repo.createScheduleProposal(competitionId, callerGamingMemberId, request.intentId, request.placements);
}

/** READ_COMPETITION_SCHEDULE_PROPOSALS: the database answers for the caller — null for anyone but the active organizer. */
export function readScheduleProposals(
  repo: Pick<CompetitionScheduleProposalStore, "getScheduleProposals">,
  competitionId: string,
  callerGamingMemberId: string
): Promise<ScheduleProposalRead | null> {
  return repo.getScheduleProposals(competitionId, callerGamingMemberId);
}
