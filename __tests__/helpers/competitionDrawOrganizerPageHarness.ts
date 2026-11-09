import { createHash } from "node:crypto";

import { CID, TEAM_NAMES } from "./competitionPlanAmendmentPageHarness";
import type { AmendReply } from "./competitionPlanAmendmentPageHarness";
import {
  CompetitionDrawError, CompetitionDrawNotAvailableError, DRAW_ALGORITHM_VERSION, computeDrawDigest, drawFailure, parseDrawRequest, permutationIndexFromSeed, permuteTeams, publicDraw,
  verifyDraw,
} from "../../lib/gaming/competitions/draw";
import type { CompetitionDrawCode } from "../../lib/gaming/competitions/draw";
import type { CompetitionDrawRecord } from "../../lib/gaming/competitions/types";

/**
 * UG-CR-GATE-SSS-031 — test support for the organizer's four-team draw surface on the SHIPPED /competitions-admin.html, run whole in jsdom.
 *
 * EVERYTHING HERE IS A DOUBLE. The page is the real page; the network and authentication are supplied by the test. What makes these doubles worth having is that
 * they are not hand-typed look-alikes of the server's answers: every draw below is produced by the REAL, already contract-tested server functions (the sampling
 * of the permutation index from a seed, the factorial decoding of the order, the digest, the public mapper a browser is shown) and is VERIFIED by the server's own
 * verifier (`verifyDraw`, which reproduces the index, the order and the digest from the evidence alone) before any page sees it. The mini server judges every request
 * the page sends with the real strict parser (`parseDrawRequest`) and answers every refusal with the real mapper (`drawFailure`), so a request the real route
 * would refuse is refused here too, with the very status and body the route gives.
 *
 * What this is not: it is not evidence about the real database, which decides who may draw, the lifecycle, the freeze, the entropy, replay and conflict inside one
 * atomic operation and is exercised separately by the loopback Supabase contract suite (competitionDrawSupabase.contract.test.ts). It is evidence about what the PAGE
 * does with the answers a server gives it.
 *
 * This module is a leaf on purpose: it imports nothing from the schedule harness, so that harness can import it for its default (an existing, verified draw)
 * without a cycle.
 */

export const DRAW_URL = `/api/gaming/competitions/${CID}/draw`;

/** The four frozen teams, in the canonical (byte) order of their identifiers — the order the draw's input is in, and the schedule harness's TEAM_IDS. */
export const DRAW_TEAM_IDS = [
  "10000000-0000-4000-8000-000000000001", "10000000-0000-4000-8000-000000000002", "10000000-0000-4000-8000-000000000003", "10000000-0000-4000-8000-000000000004",
];
export const DEFAULT_DRAWN_AT = "2026-11-07T14:20:00.654321Z";

const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
export const FREEZE_DIGEST = sha("freeze");
export const wire = <T,>(value: T): any => JSON.parse(JSON.stringify(value));

const seeds = new Map<number, string>();
/** A seed that the real sampling maps to the given permutation index (0–23): found by a deterministic search, so a fixture never depends on a hand-copied seed. */
export function seedFor(index: number): string {
  const known = seeds.get(index);
  if (known) return known;
  for (let g = 0; g < 200000; g++) {
    const seed = sha(`sss-031-draw-fixture-${g}`);
    if (permutationIndexFromSeed(seed) === index) { seeds.set(index, seed); return seed; }
  }
  throw new Error(`no seed found for permutation index ${index}`);
}

export interface DrawRecordOptions {
  /** The permutation index the seed is searched for (default 0: the drawn order is the canonical input order). Ignored when `seed` is given. */
  index?: number;
  seed?: string;
  teamNames?: string[];
  teamIds?: string[];
  drawnAt?: string;
  competitionId?: string;
  freezeDigest?: string;
}

/** A REAL stored draw: the index from the seed, the order from the index, the digest from all of it — then checked by the server's own verifier. */
export function makeDrawRecord(o: DrawRecordOptions = {}): CompetitionDrawRecord {
  const ids = o.teamIds ?? DRAW_TEAM_IDS;
  const names = o.teamNames ?? TEAM_NAMES;
  const seed = o.seed ?? seedFor(o.index ?? 0);
  const competitionId = o.competitionId ?? CID;
  const freezeDigest = o.freezeDigest ?? FREEZE_DIGEST;
  const permutationIndex = permutationIndexFromSeed(seed);
  const orderIds = permuteTeams(ids, permutationIndex);
  const input = ids.map((teamId, i) => ({ inputPosition: i + 1, teamId, teamName: names[i] }));
  const order = orderIds.map((teamId, i) => {
    const k = ids.indexOf(teamId);
    return { drawPosition: i + 1, inputPosition: k + 1, teamId, teamName: names[k] };
  });
  const drawDigest = computeDrawDigest({ competitionId, freezeDigest, seed, permutationIndex, inputTeamIds: ids, orderTeamIds: orderIds });
  const record: CompetitionDrawRecord = { algorithm: DRAW_ALGORITHM_VERSION, drawnAt: o.drawnAt ?? DEFAULT_DRAWN_AT, seed, permutationIndex, freezeDigest, drawDigest, input, order };
  const verdict = verifyDraw(competitionId, record);
  if (!verdict.ok) throw new Error(`the fixture draw does not verify: ${verdict.reason}`);
  return record;
}

/** The draw exactly as the route's public mapper presents it, as it crosses the wire. */
export const drawWire = (record: CompetitionDrawRecord): any => wire(publicDraw(record));
/** The default draw every schedule scenario starts from: verified, the identity order, so its semifinals are the teams the schedule fixtures name. */
export const defaultDrawWire = (): any => drawWire(makeDrawRecord());

/** A refusal exactly as the real route answers it (status and body from the real mapper). */
export function refusalReply(code: CompetitionDrawCode | "NOT_AVAILABLE"): AmendReply {
  const failure = drawFailure(code === "NOT_AVAILABLE" ? new CompetitionDrawNotAvailableError() : new CompetitionDrawError(code));
  if (!failure) throw new Error(`no failure for ${code}`);
  return { status: failure.status, json: wire(failure.body) };
}

/** Every refusal code the real route can answer with a 409, in the order the route's module declares them. */
export const REFUSAL_CODES: CompetitionDrawCode[] = ["WRONG_STATE", "FREEZE_REQUIRED", "FREEZE_INCONSISTENT", "AMENDMENT_PENDING", "ALREADY_DRAWN"];

export interface MiniDrawServerOptions {
  /** The draw that already exists (null: none yet). */
  draw?: CompetitionDrawRecord | null;
  /** The intent the existing draw was made with (so an exact replay of it answers 200). */
  drawIntent?: string | null;
  /** The entropy the "database" will use when it draws. The page can never reach it; a test chooses it so the outcome is known. */
  seed?: string;
  teamNames?: string[];
}

/**
 * A faithful stand-in for the draw route behind which sit the REAL server functions. It judges the body of every POST with the real strict parser (a client cannot
 * name a seed, team, order, pairing, format or actor), answers an exact replay of the draw's own intent with 200 and `alreadyDrawn: true`, answers any other request
 * once a draw exists with the 409 ALREADY_DRAWN, and otherwise either refuses with the code a test has set (the database's lifecycle decisions) or makes the one
 * permanent draw from ITS OWN seed and answers 201 and `alreadyDrawn: false`. It has no clock of its own.
 */
export class MiniDrawServer {
  draw: CompetitionDrawRecord | null;
  drawIntent: string | null;
  /** When set, the next attempt to draw is refused with this code (the draw is not made). */
  refuse: CompetitionDrawCode | "NOT_AVAILABLE" | null = null;
  seed: string;
  teamNames: string[];
  readonly log: Array<{ route: "GET" | "POST"; body?: unknown }> = [];

  constructor(options: MiniDrawServerOptions = {}) {
    this.draw = options.draw === undefined ? null : options.draw;
    this.drawIntent = options.drawIntent === undefined ? null : options.drawIntent;
    this.seed = options.seed ?? seedFor(0);
    this.teamNames = options.teamNames ?? TEAM_NAMES;
  }

  /** GET /draw: `{ draw: null }` before the draw, the bounded draw after it. */
  get(): AmendReply {
    this.log.push({ route: "GET" });
    return { status: 200, json: { draw: this.draw ? drawWire(this.draw) : null } };
  }

  /** POST /draw. */
  post(body: unknown): AmendReply {
    this.log.push({ route: "POST", body });
    let intentId: string;
    try {
      intentId = parseDrawRequest(body).intentId;
    } catch (err) {
      const failure = drawFailure(err);
      if (!failure) throw err;
      return { status: failure.status, json: wire(failure.body) };
    }
    if (this.draw) {
      if (this.drawIntent !== null && this.drawIntent === intentId.toLowerCase()) return { status: 200, json: { draw: drawWire(this.draw), alreadyDrawn: true } };
      return refusalReply("ALREADY_DRAWN");
    }
    if (this.refuse) return refusalReply(this.refuse);
    this.draw = makeDrawRecord({ seed: this.seed, teamNames: this.teamNames });
    this.drawIntent = intentId.toLowerCase();
    return { status: 201, json: { draw: drawWire(this.draw), alreadyDrawn: false } };
  }

  /** The POST requests the server received, as their bodies. */
  posts(): unknown[] { return this.log.filter((entry) => entry.route === "POST").map((entry) => entry.body); }
}
