import { createHash } from "node:crypto";

import type { CompetitionsRepository, CompetitionDrawStore } from "./db/competitionsRepository";
import type { CompetitionDrawRead, CompetitionDrawRecord, CreateCompetitionDrawResult } from "./types";
import { isActiveOrganizer } from "./organizerAccess";
import { CompetitionAccessDeniedError, CompetitionNotFoundError, HostAccessRevokedError } from "./types";
import type { PlanningViolation } from "./planning";

/**
 * UG-CR-GATE-SSS-019 — the auditable four-team draw, backend foundation (application side).
 *
 * The decisions are the database's, made inside its one atomic operation: who may draw (the competition's own ACTIVE organizer — never a captain, a scorekeeper,
 * an ordinary member or a holder of OPERATIONAL authority alone), the lifecycle, the consistent freeze of exactly four accepted teams, a plan change that
 * genuinely awaits the captains, the entropy, the one permanent record, the exact replay and the conflict. This module holds only what the application adds: the
 * pure algorithm the database also implements (so the stored evidence can be reproduced, and checked, outside the database), the digest, the strict request
 * allowlist, the typed refusals with their stable codes, the bounded shapes a browser is shown, and the two commands behind the route. It reads no clock and
 * contains no source of randomness: the draw's entropy is generated inside the database operation and nowhere else.
 *
 * What a client can NEVER send: a seed, teams, an order, a pairing, a format, an organizer or member identifier, a permutation index, a reroll. The request is
 * exactly a draw identifier; the actor is always the verified caller; the teams are always the registration freeze's.
 *
 * THE ALGORITHM (URBANO-DRAW-PERMUTATION-V1). The input is the four frozen teams in CANONICAL ORDER — the byte order of their identifiers, which is the freeze's
 * own position order. A seed is 32 random bytes (64 lowercase hexadecimal digits). The draw selects one of the 24 possible orders, each with probability exactly
 * 1/24, by rejection sampling:
 *
 *   word(seed, c)  = the first four bytes, big-endian, of SHA-256(the 32 seed bytes || c as four big-endian bytes), for c = 0, 1, 2, ...
 *   a word below 4294967280 (= 24 × 178956970, the largest multiple of 24 not above 2^32) is accepted, and the index is word mod 24;
 *   a word of 4294967280 or more is REJECTED (sixteen of 2^32 values), and the next counter is tried. At most 64 counters are tried.
 *
 * The index (0–23) is decoded in the factorial number system: with the four input positions listed in canonical order, d1 = floor(index / 6) picks the first team
 * from the four, d2 = floor((index mod 6) / 2) picks the second from the remaining three, d3 = index mod 2 picks the third from the remaining two, and the last is
 * the fourth. Index i is therefore the i-th permutation in lexicographic order, so the 24 indexes give all 24 orders, each once.
 *
 * DRAW POSITIONS are bracket slots and nothing else: positions 1 and 2 meet in Semifinal 1 (position 1 is its team A), positions 3 and 4 in Semifinal 2. They
 * are no ranking, no seeding, no priority and no schedule.
 *
 * THE DIGEST (version 1). The canonical text is these lines, joined by a newline with none at the end, and the digest is the lowercase hexadecimal SHA-256 of
 * that text in UTF-8:
 *
 *   URBANO-COMPETITION-DRAW-V1
 *   competition:<competition id>
 *   freeze-digest:<the registration freeze's own digest>
 *   algorithm:URBANO-DRAW-PERMUTATION-V1
 *   seed:<64 lowercase hexadecimal digits>
 *   index:<0–23>
 *   input:<the four team ids in canonical order, comma separated>
 *   order:<the four team ids in drawn order, comma separated>
 *
 * The database function competition_draw_digest computes the very same value; both are pinned by one known answer.
 *
 * Errors are defined here, not in types.ts: the draw route owns their wording and status, and none of the database's words reaches a browser.
 */

export const DRAW_ALGORITHM_VERSION = "URBANO-DRAW-PERMUTATION-V1";
export const DRAW_DIGEST_VERSION = "URBANO-COMPETITION-DRAW-V1";
export const DRAW_TEAM_COUNT = 4;
export const DRAW_PERMUTATION_COUNT = 24;
/** 24 × 178956970: the largest multiple of 24 not above 2^32. A word at or above it is rejected, so every index is exactly equally likely. */
export const DRAW_WORD_LIMIT = 4294967280;
export const DRAW_MAX_ATTEMPTS = 64;

const SEED_PATTERN = /^[0-9a-f]{64}$/;
const DIGEST_PATTERN = /^[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const INSTANT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Byte order for the ASCII identifiers used here: the same order the database's "C" collation gives. */
const byteOrder = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The algorithm
// ---------------------------------------------------------------------------------------------------------------------------------------------

/** The sampled word for one counter: the first four bytes, big-endian, of SHA-256(the seed's 32 bytes || the counter as four big-endian bytes). */
export function drawWord(seed: string, counter: number): number {
  if (typeof seed !== "string" || !SEED_PATTERN.test(seed)) throw new RangeError("The seed must be 64 lowercase hexadecimal digits.");
  if (!Number.isInteger(counter) || counter < 0 || counter >= DRAW_MAX_ATTEMPTS) throw new RangeError("The counter must be a whole number from 0 to 63.");
  const block = Buffer.alloc(36);
  Buffer.from(seed, "hex").copy(block, 0);
  block.writeUInt32BE(counter, 32);
  return createHash("sha256").update(block).digest().readUInt32BE(0);
}

/** The index a word gives (word mod 24), or null when the word is in the rejected band. A word that is not a 32-bit unsigned integer is refused, never reduced. */
export function acceptDrawWord(word: number): number | null {
  if (typeof word !== "number" || !Number.isInteger(word) || word < 0 || word > 0xffffffff) throw new RangeError("A sampled word is a 32-bit unsigned integer.");
  return word < DRAW_WORD_LIMIT ? word % DRAW_PERMUTATION_COUNT : null;
}

/** The permutation index (0–23) a seed draws: the first accepted word's index, trying counters 0, 1, 2, ... */
export function permutationIndexFromSeed(seed: string): number {
  for (let counter = 0; counter < DRAW_MAX_ATTEMPTS; counter++) {
    const index = acceptDrawWord(drawWord(seed, counter));
    if (index !== null) return index;
  }
  throw new RangeError("No permutation index could be drawn from this seed.");
}

/** The drawn order of four distinct teams given in canonical order: index i is the i-th permutation in lexicographic order. The input is not modified. */
export function permuteTeams<T>(canonicalInput: readonly T[], index: number): T[] {
  if (typeof index !== "number" || !Number.isInteger(index) || index < 0 || index >= DRAW_PERMUTATION_COUNT) throw new RangeError("The permutation index is a whole number from 0 to 23.");
  if (!Array.isArray(canonicalInput) || canonicalInput.length !== DRAW_TEAM_COUNT || new Set(canonicalInput).size !== DRAW_TEAM_COUNT) throw new RangeError("Exactly four distinct teams are drawn.");
  const rest = [...canonicalInput];
  const order: T[] = [];
  let remaining = index;
  for (const weight of [6, 2, 1]) {
    const digit = Math.floor(remaining / weight);
    remaining %= weight;
    order.push(rest.splice(digit, 1)[0]);
  }
  order.push(rest[0]);
  return order;
}

/** Four team identifiers in canonical order: lowercase, compared by bytes. Refuses a duplicate, a malformed identifier and anything but four. */
export function canonicalTeamOrder(teamIds: readonly string[]): string[] {
  if (!Array.isArray(teamIds) || teamIds.length !== DRAW_TEAM_COUNT) throw new RangeError("Exactly four teams are drawn.");
  const lowered = teamIds.map((id) => {
    if (typeof id !== "string" || !UUID_PATTERN.test(id)) throw new RangeError("A team is identified by a UUID.");
    return id.toLowerCase();
  });
  if (new Set(lowered).size !== lowered.length) throw new RangeError("A team cannot be drawn twice.");
  return lowered.sort(byteOrder);
}

/** The two semifinals of a drawn order: positions 1–2 are Semifinal 1 (position 1 is team A), positions 3–4 are Semifinal 2. A position is a slot, never a rank. */
export function deriveSemifinals<T>(drawnOrder: readonly T[]): [{ fixtureRole: "SEMIFINAL_1"; teamA: T; teamB: T }, { fixtureRole: "SEMIFINAL_2"; teamA: T; teamB: T }] {
  if (!Array.isArray(drawnOrder) || drawnOrder.length !== DRAW_TEAM_COUNT) throw new RangeError("Exactly four drawn teams form the two semifinals.");
  return [
    { fixtureRole: "SEMIFINAL_1", teamA: drawnOrder[0], teamB: drawnOrder[1] },
    { fixtureRole: "SEMIFINAL_2", teamA: drawnOrder[2], teamB: drawnOrder[3] },
  ];
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The digest, and the reproduction of a draw from its stored evidence
// ---------------------------------------------------------------------------------------------------------------------------------------------

export interface DrawDigestInput {
  competitionId: string;
  freezeDigest: string;
  seed: string;
  permutationIndex: number;
  inputTeamIds: readonly string[];
  orderTeamIds: readonly string[];
}

/** The digest of one draw: see the canonical text in this file's header. Deterministic; the identifiers are compared as lowercase. */
export function computeDrawDigest(input: DrawDigestInput): string {
  const lines = [
    DRAW_DIGEST_VERSION,
    `competition:${input.competitionId.toLowerCase()}`,
    `freeze-digest:${input.freezeDigest}`,
    `algorithm:${DRAW_ALGORITHM_VERSION}`,
    `seed:${input.seed}`,
    `index:${input.permutationIndex}`,
    `input:${input.inputTeamIds.map((id) => id.toLowerCase()).join(",")}`,
    `order:${input.orderTeamIds.map((id) => id.toLowerCase()).join(",")}`,
  ];
  return createHash("sha256").update(lines.join("\n"), "utf8").digest("hex");
}

export type DrawVerification = { ok: true } | { ok: false; reason: string };

/**
 * Reproduces a draw from its stored evidence ALONE — the seed gives the index, the index and the canonical input give the order, and the whole gives the
 * digest — and reports the first thing that does not hold. It never throws: evidence that cannot be evaluated does not verify.
 */
export function verifyDraw(competitionId: string, record: CompetitionDrawRecord): DrawVerification {
  const fail = (reason: string): DrawVerification => ({ ok: false, reason });
  try {
    if (!isPlainObject(record)) return fail("the evidence is not an object");
    const r = record as unknown as Record<string, any>;
    if (r.algorithm !== DRAW_ALGORITHM_VERSION) return fail("the algorithm version is not the one this draw was made with");
    if (typeof r.seed !== "string" || !SEED_PATTERN.test(r.seed)) return fail("the seed is not 64 lowercase hexadecimal digits");
    if (!Number.isInteger(r.permutationIndex) || r.permutationIndex < 0 || r.permutationIndex >= DRAW_PERMUTATION_COUNT) return fail("the permutation index is out of range");
    if (typeof r.drawnAt !== "string" || !INSTANT_PATTERN.test(r.drawnAt)) return fail("the draw time is not a canonical instant");
    if (typeof r.freezeDigest !== "string" || !DIGEST_PATTERN.test(r.freezeDigest) || typeof r.drawDigest !== "string" || !DIGEST_PATTERN.test(r.drawDigest)) return fail("a digest is malformed");
    if (!Array.isArray(r.input) || r.input.length !== DRAW_TEAM_COUNT || !Array.isArray(r.order) || r.order.length !== DRAW_TEAM_COUNT) return fail("there must be exactly four teams, in the input and in the order");

    const inputIds: string[] = [];
    for (let i = 0; i < DRAW_TEAM_COUNT; i++) {
      const team = r.input[i];
      if (!isPlainObject(team) || team.inputPosition !== i + 1 || typeof team.teamId !== "string" || !UUID_PATTERN.test(team.teamId) || team.teamId !== team.teamId.toLowerCase()) return fail("an input team is malformed or out of position");
      inputIds.push(team.teamId);
    }
    if (new Set(inputIds).size !== DRAW_TEAM_COUNT) return fail("an input team appears twice");
    if (inputIds.some((id, i) => id !== [...inputIds].sort(byteOrder)[i])) return fail("the input is not in canonical order");

    const orderIds: string[] = [];
    for (let i = 0; i < DRAW_TEAM_COUNT; i++) {
      const team = r.order[i];
      if (!isPlainObject(team) || team.drawPosition !== i + 1 || !Number.isInteger(team.inputPosition) || (team.inputPosition as number) < 1 || (team.inputPosition as number) > DRAW_TEAM_COUNT) return fail("a drawn team is malformed or out of position");
      if (typeof team.teamId !== "string" || team.teamId !== inputIds[(team.inputPosition as number) - 1]) return fail("a drawn team is not the input team its position names");
      orderIds.push(team.teamId);
    }
    if (new Set(orderIds).size !== DRAW_TEAM_COUNT) return fail("a team was drawn twice");

    if (permutationIndexFromSeed(r.seed) !== r.permutationIndex) return fail("the permutation index does not follow from the seed");
    const expected = permuteTeams(inputIds, r.permutationIndex);
    if (expected.some((id, i) => id !== orderIds[i])) return fail("the drawn order does not follow from the permutation index");
    const digest = computeDrawDigest({ competitionId, freezeDigest: r.freezeDigest, seed: r.seed, permutationIndex: r.permutationIndex, inputTeamIds: inputIds, orderTeamIds: orderIds });
    if (digest !== r.drawDigest) return fail("the draw digest does not match the evidence");
    return { ok: true };
  } catch {
    return fail("the evidence could not be evaluated");
  }
}

/** Evidence that does not reproduce itself is never shown or returned: it is a failure, never a guess. */
export function assertDrawVerifies(competitionId: string, record: CompetitionDrawRecord): void {
  const result = verifyDraw(competitionId, record);
  if (!result.ok) throw new Error(`The recorded draw could not be verified: ${result.reason}.`);
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Typed refusals
// ---------------------------------------------------------------------------------------------------------------------------------------------

export type CompetitionDrawCode = "NOT_AVAILABLE" | "WRONG_STATE" | "FREEZE_REQUIRED" | "FREEZE_INCONSISTENT" | "AMENDMENT_PENDING" | "ALREADY_DRAWN";

const MESSAGES: Record<CompetitionDrawCode, string> = {
  NOT_AVAILABLE: "There is no draw here that you can act on.",
  WRONG_STATE: "The draw can be made only while the competition is ready to publish, before anything has been scheduled or played.",
  FREEZE_REQUIRED: "Registration must be closed and frozen before the draw can be made.",
  FREEZE_INCONSISTENT: "The frozen registration no longer matches this competition, so the draw cannot be made.",
  AMENDMENT_PENDING: "A plan change is still waiting for the captains' answers. Wait until it is decided, withdrawn or has expired before making the draw.",
  ALREADY_DRAWN: "The draw has already been made and cannot be repeated.",
};

/** A refusal of the draw. The code is stable and bounded; the wording is the application's, never the database's. */
export class CompetitionDrawError extends Error {
  readonly code: CompetitionDrawCode;
  constructor(code: CompetitionDrawCode) {
    super(MESSAGES[code]);
    this.name = "CompetitionDrawError";
    this.code = code;
  }
}

/** The one uniform answer for everything the caller has no part in: a stranger, an unknown competition, a former host, a captain, a scorekeeper. */
export class CompetitionDrawNotAvailableError extends CompetitionDrawError {
  constructor() {
    super("NOT_AVAILABLE");
    this.name = "CompetitionDrawNotAvailableError";
  }
}

/** Every reason a request is not acceptable. Always a 400 at the boundary. */
export class CompetitionDrawValidationError extends Error {
  readonly violations: readonly PlanningViolation[];
  constructor(violations: readonly PlanningViolation[]) {
    super("The draw request is not valid.");
    this.name = "CompetitionDrawValidationError";
    this.violations = violations;
  }
}

const DATABASE_CODES: Array<[string, CompetitionDrawCode]> = [
  ["COMPETITION_DRAW_WRONG_STATE", "WRONG_STATE"],
  ["COMPETITION_DRAW_FREEZE_REQUIRED", "FREEZE_REQUIRED"],
  ["COMPETITION_DRAW_FREEZE_INCONSISTENT", "FREEZE_INCONSISTENT"],
  ["COMPETITION_DRAW_AMENDMENT_PENDING", "AMENDMENT_PENDING"],
  ["COMPETITION_DRAW_ALREADY_DRAWN", "ALREADY_DRAWN"],
];

/** The typed error for a refusal raised inside the database, or null when the message is not one of this gate's. Only the codes — never the words — are used. */
export function drawErrorFromDatabase(message: string): CompetitionDrawError | null {
  if (typeof message !== "string" || message === "") return null;
  for (const [databaseCode, code] of DATABASE_CODES) {
    if (message.includes(databaseCode)) return new CompetitionDrawError(code);
  }
  return null;
}

/** The one sentence the route says when the caller has no part in a draw. It names nothing: not the competition, the state, the roles or whether anything exists. */
export const DRAW_NOT_FOUND_MESSAGE = "A draw was not found for this competition.";

/**
 * How a failed draw operation is answered. Everything that means "you have no part in this" — the uniform not-available, and the database's own ownership,
 * revocation and not-found refusals (which a race can still produce after the application's check) — is the same 404 with the same words, so nobody can tell an
 * unknown competition from a stranger, a former host from a current one. An invalid input is a 400 with every problem; every other typed refusal is a 409 with its
 * stable code and the application's bounded wording. Anything else is not this gate's to describe: null.
 */
export function drawFailure(err: unknown): { status: number; body: { error: string; code?: CompetitionDrawCode; problems?: readonly PlanningViolation[] } } | null {
  if (err instanceof CompetitionDrawValidationError) return { status: 400, body: { error: err.message, problems: err.violations } };
  if (err instanceof CompetitionDrawNotAvailableError || err instanceof CompetitionNotFoundError || err instanceof CompetitionAccessDeniedError || err instanceof HostAccessRevokedError) {
    return { status: 404, body: { error: DRAW_NOT_FOUND_MESSAGE } };
  }
  if (err instanceof CompetitionDrawError) return { status: 409, body: { error: err.message, code: err.code } };
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The request
// ---------------------------------------------------------------------------------------------------------------------------------------------

/** Everything a client might send to choose, steer or repeat a draw, or to name who is drawing. Naming one is refused as such (not merely as "unknown"). */
const FORBIDDEN_FIELDS: ReadonlySet<string> = new Set([
  "seed", "entropy", "nonce", "counter", "random", "teams", "team", "teamIds", "order", "drawOrder", "pairing", "pairings", "semifinals", "bracket", "format", "formatKey", "activityKey",
  "organizer", "organizerId", "organizerGamingMemberId", "gamingMemberId", "memberId", "member", "captain", "captainId", "actor", "actorId", "reroll", "redraw", "rerun", "again",
  "permutation", "permutationIndex", "index", "algorithm", "freeze", "freezeId", "freezeDigest", "digest", "drawDigest", "drawnAt", "now", "state", "competitionId",
]);

/** The body of a draw request: exactly a draw identifier. The organizer is always the verified caller; nothing else is accepted. */
export function parseDrawRequest(body: unknown): { intentId: string } {
  if (!isPlainObject(body)) throw new CompetitionDrawValidationError([{ field: "request", code: "REQUEST_NOT_OBJECT", message: "The request must be an object." }]);
  const violations: PlanningViolation[] = [];
  for (const key of Object.keys(body)) {
    if (key === "intentId") continue;
    if (FORBIDDEN_FIELDS.has(key)) violations.push({ field: key, code: "FORBIDDEN_FIELD", message: "The draw is made by the server alone; this cannot be supplied." });
    else violations.push({ field: key, code: "UNKNOWN_FIELD", message: "This field is not part of the request." });
  }
  if (typeof body.intentId !== "string" || !UUID_PATTERN.test(body.intentId)) violations.push({ field: "intentId", code: "INTENT_INVALID", message: "A draw identifier is required." });
  if (violations.length > 0) throw new CompetitionDrawValidationError(violations);
  return { intentId: body.intentId as string };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// What the database returns, and what a browser may see
// ---------------------------------------------------------------------------------------------------------------------------------------------

/** The database's evidence in the application's own shape. Every field is copied by name and judged strictly; evidence that is not exactly this shape is a failure. */
export function drawRecordFromDatabase(raw: unknown): CompetitionDrawRecord {
  const bad = () => new Error("The recorded draw could not be read.");
  const text = (value: unknown): string => {
    if (typeof value !== "string" || value === "") throw bad();
    return value;
  };
  const whole = (value: unknown, low: number, high: number): number => {
    if (typeof value !== "number" || !Number.isInteger(value) || value < low || value > high) throw bad();
    return value;
  };
  if (!isPlainObject(raw)) throw bad();
  if (!Array.isArray(raw.input) || raw.input.length !== DRAW_TEAM_COUNT || !Array.isArray(raw.order) || raw.order.length !== DRAW_TEAM_COUNT) throw bad();
  return {
    algorithm: text(raw.algorithm),
    drawnAt: text(raw.drawn_at),
    seed: text(raw.seed),
    permutationIndex: whole(raw.permutation_index, 0, DRAW_PERMUTATION_COUNT - 1),
    freezeDigest: text(raw.freeze_digest),
    drawDigest: text(raw.draw_digest),
    input: raw.input.map((t: unknown) => {
      if (!isPlainObject(t)) throw bad();
      return { inputPosition: whole(t.input_position, 1, DRAW_TEAM_COUNT), teamId: text(t.team_id), teamName: text(t.team_name) };
    }),
    order: raw.order.map((t: unknown) => {
      if (!isPlainObject(t)) throw bad();
      return { drawPosition: whole(t.draw_position, 1, DRAW_TEAM_COUNT), inputPosition: whole(t.input_position, 1, DRAW_TEAM_COUNT), teamId: text(t.team_id), teamName: text(t.team_name) };
    }),
  };
}

/**
 * The draw as a browser may see it: every field is copied by name, so no identifier of a member, an intent or a freeze record can reach a response. The two
 * semifinals are derived here from the drawn order; a position is a bracket slot, never a rank.
 */
export function publicDraw(record: CompetitionDrawRecord) {
  const teams = record.order.map((t) => ({ drawPosition: t.drawPosition, inputPosition: t.inputPosition, teamId: t.teamId, teamName: t.teamName }));
  const slot = (t: { drawPosition: number; teamId: string; teamName: string }) => ({ drawPosition: t.drawPosition, teamId: t.teamId, teamName: t.teamName });
  const [first, second] = deriveSemifinals(teams);
  return {
    algorithm: record.algorithm,
    drawnAt: record.drawnAt,
    seed: record.seed,
    permutationIndex: record.permutationIndex,
    freezeDigest: record.freezeDigest,
    drawDigest: record.drawDigest,
    inputOrder: record.input.map((t) => ({ inputPosition: t.inputPosition, teamId: t.teamId, teamName: t.teamName })),
    teams,
    semifinals: [
      { fixtureRole: first.fixtureRole, teamA: slot(first.teamA), teamB: slot(first.teamB) },
      { fixtureRole: second.fixtureRole, teamA: slot(second.teamA), teamB: slot(second.teamB) },
    ],
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------------------------------------------------------

export type DrawRepository = Pick<CompetitionsRepository, "getCompetitionById"> & CompetitionDrawStore;

/**
 * MAKE_COMPETITION_DRAW. The same decisions are made again, atomically and under a lock, inside the database; this check decides first so that a caller who is
 * not the active organizer never learns anything about the competition (the database is not even asked). The organizer is always the verified caller.
 */
export async function createCompetitionDraw(
  repo: DrawRepository,
  competitionId: string,
  callerGamingMemberId: string,
  intentId: string
): Promise<CreateCompetitionDrawResult> {
  const competition = await repo.getCompetitionById(competitionId);
  if (!competition || !isActiveOrganizer(competition, callerGamingMemberId)) throw new CompetitionDrawNotAvailableError();
  return repo.createCompetitionDraw(competitionId, callerGamingMemberId, intentId);
}

/** READ_COMPETITION_DRAW: the database answers for the caller — null for anyone but the active organizer and, once a draw exists, the four frozen captains. */
export function readCompetitionDraw(
  repo: Pick<CompetitionDrawStore, "getCompetitionDraw">,
  competitionId: string,
  callerGamingMemberId: string
): Promise<CompetitionDrawRead | null> {
  return repo.getCompetitionDraw(competitionId, callerGamingMemberId);
}
