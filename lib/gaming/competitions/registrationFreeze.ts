import { createHash } from "node:crypto";

import type {
  CompetitionState, CompetitionTeamRecord, RegistrationFreezeRecord, RegistrationFreezeSummary, RegistrationReadiness, RegistrationStatus, RegistrationStatusRead,
} from "./types";
import {
  CompetitionAccessDeniedError, CompetitionCancelledError, CompetitionNotFoundError, HostAccessRevokedError, TeamRegistrationCapacityNotReachedError, TeamRegistrationNotOpenError,
} from "./types";

/**
 * UG-CR-GATE-SSS-007 — Registration Deadline and Competition Freeze foundation (application side).
 *
 * The decisions are the database's: the deadline is the UTC instant of the competition's CURRENT planning revision, judged by the database clock inside
 * each atomic operation, and the close operation is the one atomic, append-only freeze (see the migration of this gate). This module holds only what
 * the application adds: the typed refusals with their stable codes, the deterministic digest of the frozen data, the bounded status a member is shown,
 * and the summaries an organizer is shown. It reads no clock of its own and decides nothing about whether a write is allowed.
 *
 * Neither error is exported from types.ts: the shared status table (httpAuth.ts) does not know them, and the two routes that can raise them answer for them.
 */

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Opening registration
// ---------------------------------------------------------------------------------------------------------------------------------------------

export type RegistrationOpeningProblem = "PLAN_MISSING" | "PLAN_INVALID" | "DEADLINE_EXPIRED";

const OPENING_MESSAGES: Record<RegistrationOpeningProblem, string> = {
  PLAN_MISSING: "Save a registration plan with a future deadline before opening team registration.",
  PLAN_INVALID: "The saved registration plan cannot be used to open registration. Save the plan again.",
  DEADLINE_EXPIRED: "The registration deadline has already passed. Save a plan with a future deadline to open registration.",
};

/** Team registration cannot open: there is no usable plan, or its deadline is no longer in the future. */
export class RegistrationOpeningError extends Error {
  readonly code: RegistrationOpeningProblem;
  constructor(code: RegistrationOpeningProblem) {
    super(OPENING_MESSAGES[code]);
    this.name = "RegistrationOpeningError";
    this.code = code;
  }
}

const OPENING_DATABASE_CODES: Array<[string, RegistrationOpeningProblem]> = [
  ["REGISTRATION_OPENING_PLAN_MISSING", "PLAN_MISSING"],
  ["REGISTRATION_OPENING_PLAN_INVALID", "PLAN_INVALID"],
  ["REGISTRATION_OPENING_DEADLINE_EXPIRED", "DEADLINE_EXPIRED"],
];

/** The typed error for a database refusal to open registration, or null when the message is not one of them. The database's own words are never passed on. */
export function registrationOpeningErrorFromDatabase(message: string): RegistrationOpeningError | null {
  for (const [databaseCode, code] of OPENING_DATABASE_CODES) {
    if (message.includes(databaseCode)) return new RegistrationOpeningError(code);
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Freezing registration
// ---------------------------------------------------------------------------------------------------------------------------------------------

export type RegistrationFreezeProblem =
  | "PLAN_MISSING" | "PLAN_INVALID" | "DEADLINE_NOT_REACHED" | "PENDING_PROPOSALS" | "PENDING_JOIN_REQUESTS"
  | "ROSTER_BELOW_MINIMUM" | "ROSTER_ABOVE_MAXIMUM" | "MEMBER_CONFLICT";

interface FreezeDetail { count?: number; limit?: number }

function freezeMessage(code: RegistrationFreezeProblem, detail: FreezeDetail = {}): string {
  const n = detail.count;
  switch (code) {
    case "PLAN_MISSING": return "This competition has no registration plan, so registration cannot be frozen.";
    case "PLAN_INVALID": return "The registration plan cannot be used to freeze registration.";
    case "DEADLINE_NOT_REACHED": return "The registration deadline has not been reached yet. Registration can be frozen only after it.";
    case "PENDING_PROPOSALS": return n === undefined ? "Accept or reject every pending team proposal before freezing registration." : `${n} team proposal${n === 1 ? " is" : "s are"} still pending. Accept or reject each one before freezing registration.`;
    case "PENDING_JOIN_REQUESTS": return n === undefined ? "Approve or reject every pending join request before freezing registration." : `${n} join request${n === 1 ? " is" : "s are"} still pending. Approve or reject each one before freezing registration.`;
    case "ROSTER_BELOW_MINIMUM": return n === undefined || detail.limit === undefined ? "At least one team has fewer members than the roster minimum." : `A team has ${n} member${n === 1 ? "" : "s"}, below the roster minimum of ${detail.limit}.`;
    case "ROSTER_ABOVE_MAXIMUM": return n === undefined || detail.limit === undefined ? "At least one team has more members than the roster maximum." : `A team has ${n} member${n === 1 ? "" : "s"}, above the roster maximum of ${detail.limit}.`;
    case "MEMBER_CONFLICT": return "A person appears in more than one team, so registration cannot be frozen.";
  }
}

/** Registration cannot be frozen yet. The code is stable and bounded; the message says what to do and carries only counts the database stated. */
export class RegistrationFreezeError extends Error {
  readonly code: RegistrationFreezeProblem;
  constructor(code: RegistrationFreezeProblem, detail: FreezeDetail = {}) {
    super(freezeMessage(code, detail));
    this.name = "RegistrationFreezeError";
    this.code = code;
  }
}

const FREEZE_DATABASE_CODES: Array<[string, RegistrationFreezeProblem]> = [
  ["REGISTRATION_FREEZE_PLAN_MISSING", "PLAN_MISSING"],
  ["REGISTRATION_FREEZE_PLAN_INVALID", "PLAN_INVALID"],
  ["REGISTRATION_FREEZE_DEADLINE_NOT_REACHED", "DEADLINE_NOT_REACHED"],
  ["REGISTRATION_FREEZE_PENDING_PROPOSALS", "PENDING_PROPOSALS"],
  ["REGISTRATION_FREEZE_PENDING_JOIN_REQUESTS", "PENDING_JOIN_REQUESTS"],
  ["REGISTRATION_FREEZE_ROSTER_BELOW_MINIMUM", "ROSTER_BELOW_MINIMUM"],
  ["REGISTRATION_FREEZE_ROSTER_ABOVE_MAXIMUM", "ROSTER_ABOVE_MAXIMUM"],
  ["REGISTRATION_FREEZE_MEMBER_CONFLICT", "MEMBER_CONFLICT"],
];

/** The whole numbers a database refusal states after its code, in order ("a team has 4 member(s); the minimum is 5" is [4, 5]). */
function statedNumbers(message: string, databaseCode: string): number[] {
  const after = message.slice(message.indexOf(databaseCode) + databaseCode.length);
  return (after.match(/\d{1,6}/g) ?? []).map(Number).filter(Number.isSafeInteger);
}

/** The typed error for a database refusal to freeze, or null when the message is not one of them. Only the numbers the database stated reach the wording. */
export function registrationFreezeErrorFromDatabase(message: string): RegistrationFreezeError | null {
  for (const [databaseCode, code] of FREEZE_DATABASE_CODES) {
    if (!message.includes(databaseCode)) continue;
    const numbers = statedNumbers(message, databaseCode);
    if (code === "ROSTER_BELOW_MINIMUM" || code === "ROSTER_ABOVE_MAXIMUM") {
      return new RegistrationFreezeError(code, numbers.length >= 2 ? { count: numbers[0], limit: numbers[1] } : {});
    }
    if (code === "PENDING_PROPOSALS" || code === "PENDING_JOIN_REQUESTS") {
      return new RegistrationFreezeError(code, numbers.length >= 1 ? { count: numbers[0] } : {});
    }
    return new RegistrationFreezeError(code);
  }
  return null;
}

/**
 * The stable code the close route reports for any refusal of the freeze checkpoint: the freeze's own, or one for a refusal the status table already
 * knows (so the organizer page can say something bounded for every case). null for an error that is not a refusal of this action.
 */
export function closeFailureCode(err: unknown): string | null {
  if (err instanceof RegistrationFreezeError) return err.code;
  if (err instanceof TeamRegistrationCapacityNotReachedError) return "TEAM_COUNT";
  if (err instanceof TeamRegistrationNotOpenError) return "WRONG_STATE";
  if (err instanceof HostAccessRevokedError) return "ORGANIZER_REVOKED";
  if (err instanceof CompetitionAccessDeniedError) return "NOT_ORGANIZER";
  if (err instanceof CompetitionNotFoundError) return "NOT_FOUND";
  if (err instanceof CompetitionCancelledError) return "CANCELLED";
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The digest of the frozen competitive data
// ---------------------------------------------------------------------------------------------------------------------------------------------

export const REGISTRATION_FREEZE_DIGEST_VERSION = "URBANO-REGISTRATION-FREEZE-V1";

/** The competitive facts the digest covers. Who froze it, when, and the freeze's own id are not competitive data. */
export interface RegistrationFreezeDigestInput {
  competitionId: string;
  planningRevisionId: string;
  formatKey: string;
  rosterMinimum: number;
  rosterMaximum: number;
  registrationDeadlineUtc: string;
  teams: Array<{ competitionTeamId: string; captainGamingMemberId: string; memberGamingMemberIds: string[] }>;
}

/** Byte order for the ASCII identifiers used here: the same order the database's "C" collation gives. */
const byteOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * The deadline as the canonical text the database builds: the exact UTC instant to the millisecond, with exactly three fractional digits and a final Z
 * (for example 2026-11-01T00:00:00.250Z). Every spelling of one instant — with or without a fraction, "Z" or an offset, however many zero digits the
 * database printed — gives the same text, and two instants that differ only in milliseconds never do. An instant finer than a millisecond, or a value that is
 * not a real instant, is refused (RangeError): it is never rounded or truncated into another instant's digest.
 */
export function canonicalRegistrationDeadline(value: string): string {
  const instant = typeof value === "string" ? Date.parse(value) : Number.NaN;
  if (Number.isNaN(instant)) throw new RangeError("The registration deadline is not a real instant.");
  const fraction = /\.(\d+)/.exec(value);
  if (fraction && fraction[1].length > 3 && /[1-9]/.test(fraction[1].slice(3))) throw new RangeError("The registration deadline must be an exact instant to the millisecond.");
  return new Date(instant).toISOString();
}

/**
 * SHA-256 (hex) of this canonical text, one item per line and no trailing newline — exactly the text the database builds:
 *   URBANO-REGISTRATION-FREEZE-V1 / competition:<id> / revision:<id> / format:<key> / roster:<min>-<max> / deadline:<UTC, exactly three fractional digits, Z>
 *   then, for each team ordered by team id: team:<id>|captain:<id>|members:<member ids ordered by id, comma separated>
 * The order teams and members arrive in never matters.
 */
export function computeRegistrationFreezeDigest(input: RegistrationFreezeDigestInput): string {
  const deadline = canonicalRegistrationDeadline(input.registrationDeadlineUtc);
  const lines = [
    REGISTRATION_FREEZE_DIGEST_VERSION,
    `competition:${input.competitionId}`,
    `revision:${input.planningRevisionId}`,
    `format:${input.formatKey}`,
    `roster:${input.rosterMinimum}-${input.rosterMaximum}`,
    `deadline:${deadline}`,
  ];
  for (const team of [...input.teams].sort((a, b) => byteOrder(a.competitionTeamId, b.competitionTeamId))) {
    lines.push(`team:${team.competitionTeamId}|captain:${team.captainGamingMemberId}|members:${[...team.memberGamingMemberIds].sort(byteOrder).join(",")}`);
  }
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}

/** True only when the stored digest is the digest of the stored facts. */
export function verifyRegistrationFreeze(record: RegistrationFreezeDigestInput & { snapshotDigest: string }): boolean {
  return computeRegistrationFreezeDigest(record) === record.snapshotDigest;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// What a member and an organizer are shown
// ---------------------------------------------------------------------------------------------------------------------------------------------

/**
 * The bounded status a member is shown, from what the server read. Exactly six facts and nothing else of the plan. Every flag is read strictly
 * (anything but `true` is false), and writes are reported open only for a competition that is itself open: a closed state is never turned into an
 * open action. A draft has no status (its plan is still a draft), and neither has a competition with no usable plan — and for a competition that is not a
 * draft, no status means CLOSED (UG-CR-GATE-SSS-007A): the page offers nothing and the database refuses every new write. A read that is not the expected shape
 * is a failure, never a guess.
 */
export function toRegistrationStatus(read: RegistrationStatusRead | null | undefined, state: CompetitionState): RegistrationStatus | null {
  if (state === "DRAFT" || read === null || read === undefined) return null;
  if (typeof read !== "object" || typeof read.deadlineUtc !== "string" || typeof read.timeZone !== "string" || typeof read.deadlineLocal !== "string") {
    throw new Error("The registration status could not be read.");
  }
  const deadlinePassed = read.deadlinePassed === true;
  const frozen = read.frozen === true;
  return {
    deadlineUtc: read.deadlineUtc,
    timeZone: read.timeZone,
    deadlineLocal: read.deadlineLocal,
    deadlinePassed,
    acceptingNewWrites: state === "TEAM_REGISTRATION_OPEN" && read.acceptingNewWrites === true && !deadlinePassed && !frozen,
    frozen,
  };
}

/** What the freeze still needs, as counts, for the organizer. The database judges every one of these again when the freeze is requested. */
export function buildRegistrationReadiness(
  read: RegistrationStatusRead,
  acceptedTeams: Array<{ name: string; memberCount: number }>,
  pendingProposalCount: number,
  pendingJoinRequestCount: number
): RegistrationReadiness {
  return {
    deadlinePassed: read.deadlinePassed === true,
    acceptedTeamCount: acceptedTeams.length,
    pendingProposalCount,
    pendingJoinRequestCount,
    rosterMinimum: Number(read.rosterMinimum),
    rosterMaximum: Number(read.rosterMaximum),
    teams: acceptedTeams.map((t) => ({ name: t.name, memberCount: t.memberCount })),
  };
}

/** The recorded freeze as an organizer is shown it: team names and counts. No identifier, no digest, no actor. */
export function summarizeRegistrationFreeze(
  record: RegistrationFreezeRecord,
  teams: Array<Pick<CompetitionTeamRecord, "competitionTeamId" | "name">>
): RegistrationFreezeSummary {
  const names = new Map(teams.map((t) => [t.competitionTeamId, t.name]));
  return {
    frozenAt: new Date(record.frozenAt).toISOString(),
    registrationDeadlineUtc: new Date(record.registrationDeadlineUtc).toISOString(),
    rosterMinimum: record.rosterMinimum,
    rosterMaximum: record.rosterMaximum,
    teamCount: record.teamCount,
    memberCount: record.memberCount,
    teams: [...record.teams].sort((a, b) => a.position - b.position).map((t) => ({
      name: names.get(t.competitionTeamId) ?? "Team",
      memberCount: t.memberGamingMemberIds.length,
    })),
  };
}
