import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { NextResponse } from "next/server";

/**
 * UG-CR-GATE-CFM-014 — the authenticated HTTP surface of a competition's lifetime-team entries: enable or switch off the entry flow, enter or withdraw a team, propose, answer and
 * release roster proposals, approve, reject or remove an entry, freeze the entries — and the three reads each participant needs to find their own records.
 *
 * These tests run the REAL route handlers, the REAL bounded adapter behind them and the REAL domain operations (the identifier, decision, reason and batch parsers, the binding of an
 * entry or a proposal to its competition, the typed refusals). Exactly two things are replaced, the same two seams the sibling route tests replace: the credentials / caller-identity
 * helpers (httpAuth — whose availability guard keeps its REAL implementation, so these tests prove the guard runs inside each real handler) and the lifetime repository, which
 * becomes a recorder so a test sees WHEN it is constructed and with WHAT it is called. The database behind the same routes is exercised in the loopback contract file.
 *
 * B1…B13 name the behaviours of the gate: B1 availability first · B2 order · B3 signed out · B4 the actor is the session · B5 the exact body · B6 the addressed ids ·
 * B7 the response is copied field by field · B8 the refusal table · B9 the privacy collapse · B10 raw failures never escape · B11 every response is uncached · B12 the surface is
 * exactly nine POST handlers and three GET · B13 the reads, derived from the verified member alone · B14 an entry or a proposal is only ever reached through ITS competition.
 */

vi.mock("@/lib/gaming/competitions/httpAuth", async () => {
  const actual = await vi.importActual<typeof import("../lib/gaming/competitions/httpAuth")>("../lib/gaming/competitions/httpAuth");
  return {
    getSupabaseCredentials: vi.fn(),
    buildCompetitionsRepo: vi.fn(),
    requireGamingMember: vi.fn(),
    statusForCompetitionsError: actual.statusForCompetitionsError,
    requireCompetitionsSchemaReady: actual.requireCompetitionsSchemaReady,
    isCompetitionsSchemaReady: actual.isCompetitionsSchemaReady,
    normalizeCompetitionsSchemaReady: actual.normalizeCompetitionsSchemaReady,
  };
});

const lifetime = vi.hoisted(() => ({
  constructed: [] as Array<{ url: string; key: string }>,
  order: [] as string[],
  store: {
    enableEntryFlow: vi.fn(),
    disableEntryFlow: vi.fn(),
    decideEntry: vi.fn(),
    freezeEntries: vi.fn(),
    enterTeam: vi.fn(),
    withdrawEntry: vi.fn(),
    proposeRosterClaims: vi.fn(),
    decideRosterClaim: vi.fn(),
    releaseRosterClaim: vi.fn(),
    getEntryCompetitionId: vi.fn(),
    getRosterClaimCompetitionId: vi.fn(),
    listLiveEntriesForOrganizer: vi.fn(),
    listLiveEntriesOfLedTeams: vi.fn(),
    listOpenClaimsOfMember: vi.fn(),
  } as Record<string, ReturnType<typeof vi.fn>>,
}));

vi.mock("@/lib/gaming/competitions/db/supabaseLifetimeTeamsRepository", async () => {
  const actual = await vi.importActual<typeof import("../lib/gaming/competitions/db/supabaseLifetimeTeamsRepository")>("../lib/gaming/competitions/db/supabaseLifetimeTeamsRepository");
  class RecordingRepository {
    constructor(url: string, key: string) {
      lifetime.constructed.push({ url, key });
      lifetime.order.push("construct");
    }
  }
  for (const name of Object.keys(lifetime.store)) {
    (RecordingRepository.prototype as unknown as Record<string, unknown>)[name] = function (...args: unknown[]) {
      lifetime.order.push("store");
      return lifetime.store[name](...args);
    };
  }
  return { ...actual, SupabaseLifetimeTeamsRepository: RecordingRepository };
});

import * as httpAuth from "../lib/gaming/competitions/httpAuth";
import { translateLifetimeError } from "../lib/gaming/competitions/db/supabaseLifetimeTeamsRepository";
import * as adapter from "../lib/gaming/competitions/lifetimeEntryHttp";
import { LIFETIME_DATABASE_CODES, LifetimeTeamError, type LifetimeProblem } from "../lib/gaming/competitions/lifetimeTeams";
import {
  AlreadyCaptainOrMemberError, CompetitionAccessDeniedError, CompetitionCancelledError, CompetitionNotFoundError, CompetitionRegistrationRequiredError, DuplicateTeamNameError,
  HostAccessRevokedError, TeamRegistrationNotOpenError,
} from "../lib/gaming/competitions/types";

const ROOT = path.resolve(__dirname, "..");
const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const COMPETITION = "c0c0c0c0-c1c1-4c2c-8c3c-c4c4c4c4c4c4";
const ELSEWHERE = "d0d0d0d0-d1d1-4d2d-8d3d-d4d4d4d4d4d4";
const ENTRY = "e0e0e0e0-e1e1-4e2e-8e3e-e4e4e4e4e4e4";
const CLAIM = "a0a0a0a0-a1a1-4a2a-8a3a-a4a4a4a4a4a4";
const TEAM = "3a3a3a3a-3b3b-4c3c-8d3d-3e3e3e3e3e3e";
const P1 = "99999999-9999-4999-8999-999999999999";
const P2 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AT = "2026-11-24T16:00:00.000Z";
const LATER = "2026-12-01T16:00:00.000Z";
const CODE = "p".repeat(22);
const CREDENTIALS = { url: "http://loopback.invalid", serviceKey: "service-key-not-a-secret" };
const NO_STORE = "no-store, max-age=0";
const UNAVAILABLE_503 = "URBANO Gaming Competitions is temporarily unavailable while its database is being prepared.";
const UNAUTHENTICATED_401 = "A valid Authorization header for an authenticated Gaming Member is required.";
const INVALID_JSON = "Request body must be valid JSON.";
const SAID = {
  competition: "That competition could not be found.",
  team: "That team could not be found.",
  entry: "That entry could not be found.",
  claim: "That roster proposal could not be found.",
  proposalIsAnswered: "A roster proposal is answered with a decision; only an accepted place is withdrawn.",
  enter: "Request body must be exactly one field, lifetimeTeamId, holding the team's id.",
  entryDecision: "Request body must be decision, with reasonCode (and optionally note) for a rejection or removal.",
  propose: "Request body must be exactly one field, gamingMemberIds, holding the ids of the people to propose.",
  claimDecision: "Request body must be exactly one field, decision, holding ACCEPT or REJECT.",
} as const;
const GENERIC_500 = new LifetimeTeamError("UNAVAILABLE").message;
const messageOf = (code: LifetimeProblem) => new LifetimeTeamError(code).message;

const BASE = "http://localhost/api/gaming/competitions";
type Handler = (request: Request, context?: unknown) => Promise<Response>;
type RouteModule = Record<string, unknown> & { GET?: Handler; POST?: Handler };

/** The place a refusal can come from: what the route's 404 is asked about. */
type Cause = "COMPETITION" | "TEAM_NOT_FOUND" | "ENTRY_NOT_FOUND" | "CLAIM_NOT_FOUND" | "NOT_A_LEADER" | "CLAIM_WRONG_PARTY";

interface Op {
  key: string;
  label: string;
  route: string;
  url: (competition: string, second: string) => string;
  params: (competition: string, second: string) => Record<string, string>;
  /** The second addressed id (an entry or a proposal) — none for the routes that address only a competition. */
  second: string | null;
  /** The store read that binds the second id to the competition first. */
  binds: "getEntryCompetitionId" | "getRosterClaimCompetitionId" | null;
  /** The one valid body (null: this operation reads no body at all). */
  body: Record<string, unknown> | null;
  /** The sentence a body of the wrong SHAPE is refused with. */
  sentence: string | null;
  /** The exact arguments of the store's mutating call for the default request. */
  call: unknown[];
  /** What the (mocked) store returns — with fields the caller must never see. */
  record: Record<string, unknown>;
  status: 200 | 201;
  /** The exact response body: the fields copied one by one. */
  shape: Record<string, unknown>;
  /** What this route's refusals of standing and existence answer — a cause that is absent is not classified here and fails closed. */
  notFound: Partial<Record<Cause, string>>;
}

const flowRoute = (name: string) => `../app/api/gaming/competitions/[competitionId]/lifetime-entry-flow/${name}/route`;
const entryRoute = (name: string) => `../app/api/gaming/competitions/[competitionId]/lifetime-entries/[competitionTeamId]/${name}/route`;
const claimRoute = (name: string) => `../app/api/gaming/competitions/[competitionId]/lifetime-roster-claims/[claimId]/${name}/route`;

const OPS: Op[] = [
  {
    key: "enableEntryFlow", label: "enable the flow", route: flowRoute("enable"), url: (c) => `${BASE}/${c}/lifetime-entry-flow/enable`, params: (c) => ({ competitionId: c }),
    second: null, binds: null, body: null, sentence: null, call: [COMPETITION, SESSION],
    record: { competitionId: COMPETITION, enabledAt: AT, alreadyEnabled: false, enabledByGamingMemberId: SESSION, internal: "never shown" },
    status: 200, shape: { flow: { competitionId: COMPETITION, enabledAt: AT, alreadyEnabled: false } }, notFound: { COMPETITION: SAID.competition },
  },
  {
    key: "disableEntryFlow", label: "disable the flow", route: flowRoute("disable"), url: (c) => `${BASE}/${c}/lifetime-entry-flow/disable`, params: (c) => ({ competitionId: c }),
    second: null, binds: null, body: null, sentence: null, call: [COMPETITION, SESSION],
    record: { competitionId: COMPETITION, disabledAt: AT, alreadyDisabled: false, internal: "never shown" },
    status: 200, shape: { flow: { competitionId: COMPETITION, disabledAt: AT, alreadyDisabled: false } }, notFound: { COMPETITION: SAID.competition },
  },
  {
    key: "freezeEntries", label: "freeze the entries", route: "../app/api/gaming/competitions/[competitionId]/lifetime-entries/freeze/route",
    url: (c) => `${BASE}/${c}/lifetime-entries/freeze`, params: (c) => ({ competitionId: c }),
    second: null, binds: null, body: null, sentence: null, call: [COMPETITION, SESSION],
    record: { competitionId: COMPETITION, frozenAt: AT, entryCount: 4, claimCount: 22, alreadyFrozen: false, frozenByGamingMemberId: SESSION, internal: "never shown" },
    status: 200, shape: { freeze: { competitionId: COMPETITION, frozenAt: AT, entryCount: 4, claimCount: 22, alreadyFrozen: false } }, notFound: { COMPETITION: SAID.competition },
  },
  {
    key: "decideEntry", label: "decide an entry", route: entryRoute("decision"), url: (c, e) => `${BASE}/${c}/lifetime-entries/${e}/decision`, params: (c, e) => ({ competitionId: c, competitionTeamId: e }),
    second: ENTRY, binds: null, body: { decision: "APPROVE" }, sentence: SAID.entryDecision, call: [COMPETITION, ENTRY, SESSION, "APPROVE", null, null],
    record: { competitionTeamId: ENTRY, status: "ACCEPTED", decision: "APPROVE", decidedAt: AT, releasedClaims: 0, decisionId: OTHER, internal: "never shown" },
    status: 200, shape: { entry: { competitionTeamId: ENTRY, status: "ACCEPTED", decision: "APPROVE", decidedAt: AT, releasedClaims: 0 } },
    notFound: { COMPETITION: SAID.competition, ENTRY_NOT_FOUND: SAID.entry },
  },
  {
    key: "enterTeam", label: "enter a team", route: "../app/api/gaming/competitions/[competitionId]/lifetime-entries/route", url: (c) => `${BASE}/${c}/lifetime-entries`, params: (c) => ({ competitionId: c }),
    second: null, binds: null, body: { lifetimeTeamId: TEAM }, sentence: SAID.enter, call: [COMPETITION, TEAM, SESSION],
    record: { competitionTeamId: ENTRY, publicCode: CODE, createdAt: AT, status: "PENDING_ORGANIZER_APPROVAL", internal: "never shown" },
    status: 201, shape: { entry: { competitionTeamId: ENTRY, publicCode: CODE, createdAt: AT } },
    notFound: { COMPETITION: SAID.competition, TEAM_NOT_FOUND: SAID.team, NOT_A_LEADER: SAID.team },
  },
  {
    key: "withdrawEntry", label: "withdraw an entry", route: entryRoute("withdraw"), url: (c, e) => `${BASE}/${c}/lifetime-entries/${e}/withdraw`, params: (c, e) => ({ competitionId: c, competitionTeamId: e }),
    second: ENTRY, binds: "getEntryCompetitionId", body: null, sentence: null, call: [ENTRY, SESSION],
    record: { competitionTeamId: ENTRY, status: "REJECTED", releasedClaims: 3, withdrawnByGamingMemberId: SESSION, internal: "never shown" },
    status: 200, shape: { entry: { competitionTeamId: ENTRY, status: "REJECTED", releasedClaims: 3 } }, notFound: { ENTRY_NOT_FOUND: SAID.entry, NOT_A_LEADER: SAID.entry },
  },
  {
    key: "proposeRosterClaims", label: "propose roster claims", route: entryRoute("roster-claims"), url: (c, e) => `${BASE}/${c}/lifetime-entries/${e}/roster-claims`, params: (c, e) => ({ competitionId: c, competitionTeamId: e }),
    second: ENTRY, binds: "getEntryCompetitionId", body: { gamingMemberIds: [P1, P2] }, sentence: SAID.propose, call: [ENTRY, SESSION, [P1, P2]],
    record: [
      { claimId: CLAIM, gamingMemberId: P1, status: "PROPOSED", expiresAt: LATER, proposedBy: SESSION, internal: "never shown" },
      { claimId: OTHER, gamingMemberId: P2, status: "PROPOSED", expiresAt: LATER },
    ] as unknown as Record<string, unknown>,
    status: 201, shape: { claims: [{ claimId: CLAIM, gamingMemberId: P1, status: "PROPOSED", expiresAt: LATER }, { claimId: OTHER, gamingMemberId: P2, status: "PROPOSED", expiresAt: LATER }] },
    notFound: { ENTRY_NOT_FOUND: SAID.entry, NOT_A_LEADER: SAID.entry },
  },
  {
    key: "decideRosterClaim", label: "answer a roster proposal", route: claimRoute("decision"), url: (c, k) => `${BASE}/${c}/lifetime-roster-claims/${k}/decision`, params: (c, k) => ({ competitionId: c, claimId: k }),
    second: CLAIM, binds: "getRosterClaimCompetitionId", body: { decision: "ACCEPT" }, sentence: SAID.claimDecision, call: [CLAIM, SESSION, "ACCEPT"],
    record: { claimId: CLAIM, status: "ACCEPTED", acceptedAt: AT, decidedByGamingMemberId: SESSION, internal: "never shown" },
    status: 200, shape: { claim: { claimId: CLAIM, status: "ACCEPTED", acceptedAt: AT } }, notFound: { CLAIM_NOT_FOUND: SAID.claim, CLAIM_WRONG_PARTY: SAID.claim },
  },
  {
    key: "releaseRosterClaim", label: "release a roster proposal", route: claimRoute("release"), url: (c, k) => `${BASE}/${c}/lifetime-roster-claims/${k}/release`, params: (c, k) => ({ competitionId: c, claimId: k }),
    second: CLAIM, binds: "getRosterClaimCompetitionId", body: null, sentence: null, call: [CLAIM, SESSION],
    record: { claimId: CLAIM, status: "REMOVED", releaseReason: "LEADER_REMOVED", releasedByGamingMemberId: SESSION, internal: "never shown" },
    status: 200, shape: { claim: { claimId: CLAIM, status: "REMOVED" } }, notFound: { CLAIM_NOT_FOUND: SAID.claim, NOT_A_LEADER: SAID.claim },
  },
];
const WITH_BODY = OPS.filter((op) => op.body !== null);
const BINDING = OPS.filter((op) => op.binds !== null);
const opNamed = (key: string) => OPS.find((op) => op.key === key)!;
const mutation = (op: Op) => lifetime.store[op.key];

interface Read {
  key: string;
  label: string;
  route: string;
  url: string;
  params?: Record<string, string>;
  /** The exact arguments of the store's read for the default request. */
  call: unknown[];
  field: "entries" | "claims";
  /** A well-formed row the store returns — with fields the caller must never see — and what the caller is shown of it. */
  row: Record<string, unknown>;
  shown: Record<string, unknown>;
  /** Mutations of the valid row that make it malformed: each is dropped, never shown, never repaired. */
  malformed: Array<[string, Record<string, unknown>]>;
}

const ORGANIZER_ROW = { competitionTeamId: ENTRY, publicCode: CODE, name: "Los Halcones", status: "PENDING_ORGANIZER_APPROVAL", createdAt: AT, acceptedPlayers: 5, proposedPlayers: 2, captainGamingMemberId: OTHER, email: "x@example.com" };
const LED_CLAIM = { claimId: CLAIM, gamingMemberId: P1, displayName: "Pedro", status: "PROPOSED", expiresAt: LATER, authUserId: "secret" };
const LED_ROW = { competitionTeamId: ENTRY, competitionId: COMPETITION, lifetimeTeamId: TEAM, publicCode: CODE, name: "Los Halcones", status: "ACCEPTED", createdAt: AT, claims: [LED_CLAIM], decidedBy: OTHER };
const OWN_ROW = { claimId: CLAIM, competitionId: COMPETITION, status: "PROPOSED", expiresAt: LATER, team: { lifetimeTeamId: TEAM, publicCode: CODE, name: "Los Halcones", status: "ACTIVE" }, proposedBy: OTHER };
const READS: Read[] = [
  {
    key: "listLiveEntriesForOrganizer", label: "the organizer's entries", route: "../app/api/gaming/competitions/[competitionId]/lifetime-entries/route", url: `${BASE}/${COMPETITION}/lifetime-entries`, params: { competitionId: COMPETITION },
    call: [COMPETITION, SESSION], field: "entries", row: ORGANIZER_ROW,
    shown: { competitionTeamId: ENTRY, publicCode: CODE, name: "Los Halcones", status: "PENDING_ORGANIZER_APPROVAL", createdAt: AT, acceptedPlayers: 5, proposedPlayers: 2 },
    malformed: [
      ["a malformed entry id", { competitionTeamId: "nope" }], ["a rejected entry (not live)", { status: "REJECTED" }], ["an unknown status", { status: "PENDING" }], ["a blank code", { publicCode: "  " }],
      ["a blank name", { name: "" }], ["no creation instant", { createdAt: "yesterday" }], ["a fractional count", { acceptedPlayers: 1.5 }], ["a negative count", { proposedPlayers: -1 }], ["a count that is not a number", { acceptedPlayers: "5" }],
    ],
  },
  {
    key: "listLiveEntriesOfLedTeams", label: "the leader's entries", route: "../app/api/gaming/competitions/lifetime-entries/route", url: `${BASE}/lifetime-entries`,
    call: [SESSION], field: "entries", row: LED_ROW,
    shown: { competitionTeamId: ENTRY, competitionId: COMPETITION, lifetimeTeamId: TEAM, publicCode: CODE, name: "Los Halcones", status: "ACCEPTED", createdAt: AT, claims: [{ claimId: CLAIM, gamingMemberId: P1, displayName: "Pedro", status: "PROPOSED", expiresAt: LATER }] },
    malformed: [
      ["a malformed competition id", { competitionId: "nope" }], ["a malformed team id", { lifetimeTeamId: 7 }], ["an unknown status", { status: "WITHDRAWN" }], ["claims that are not a list", { claims: {} }], ["a blank name", { name: " " }],
    ],
  },
  {
    key: "listOpenClaimsOfMember", label: "the person's own proposals", route: "../app/api/gaming/competitions/lifetime-roster-claims/route", url: `${BASE}/lifetime-roster-claims`,
    call: [SESSION], field: "claims", row: OWN_ROW,
    shown: { claimId: CLAIM, competitionId: COMPETITION, status: "PROPOSED", expiresAt: LATER, team: { lifetimeTeamId: TEAM, publicCode: CODE, name: "Los Halcones" } },
    malformed: [
      ["a malformed claim id", { claimId: "nope" }], ["a released claim (not open)", { status: "REMOVED" }], ["no expiry instant", { expiresAt: null }], ["no team", { team: null }], ["a team that is not a record", { team: "Los Halcones" }],
      ["a team with a malformed id", { team: { lifetimeTeamId: "nope", publicCode: CODE, name: "Los Halcones" } }], ["a team with a blank name", { team: { lifetimeTeamId: TEAM, publicCode: CODE, name: "" } }],
    ],
  },
];

const load = async (route: string) => (await import(route)) as RouteModule;

/** Every response a test provokes is recorded here, and afterEach insists that each of them was uncached — so "every response is uncached" holds for the whole file. */
const seen: Array<{ label: string; status: number; cache: string | null }> = [];
async function send(label: string, handler: Handler, request: Request, params?: Record<string, string>): Promise<Response> {
  const response = await handler(request, params ? { params } : undefined);
  seen.push({ label, status: response.status, cache: response.headers.get("cache-control") });
  return response;
}

interface Build { competition?: string; second?: string; body?: string; headers?: Record<string, string>; query?: string }
/** A POST for the operation. `body` is the raw request text (the operation's valid body when omitted; an operation that reads no body carries none). */
function build(op: Op, over: Build = {}): { request: Request; params: Record<string, string> } {
  const competition = over.competition ?? COMPETITION;
  const second = over.second ?? op.second ?? "";
  const text = over.body ?? (op.body ? JSON.stringify(op.body) : undefined);
  const headers: Record<string, string> = { authorization: "Bearer session-token", ...(text !== undefined ? { "content-type": "application/json" } : {}), ...over.headers };
  return { request: new Request(op.url(competition, second) + (over.query ?? ""), { method: "POST", headers, body: text }), params: op.params(competition, second) };
}
async function invoke(op: Op, over: Build = {}): Promise<{ res: Response; request: Request }> {
  const { POST } = await load(op.route);
  const { request, params } = build(op, over);
  return { res: await send(op.label, POST!, request, params), request };
}
async function read(r: Read, over: { url?: string; headers?: Record<string, string>; competition?: string } = {}): Promise<Response> {
  const { GET } = await load(r.route);
  const request = new Request(over.url ?? r.url, { method: "GET", headers: { authorization: "Bearer session-token", ...over.headers } });
  return send(r.label, GET!, request, r.params ? { competitionId: over.competition ?? r.params.competitionId } : undefined);
}
/** The same body with one more raw key (raw text, so that "__proto__" really is an own key of the parsed body). */
const withExtra = (op: Op, field: string, value: unknown) => `${JSON.stringify(op.body).slice(0, -1)},${JSON.stringify(field)}:${JSON.stringify(value)}}`;

const snapshot = async (res: Response) => ({ status: res.status, headers: [...res.headers.entries()].sort(([a], [b]) => a.localeCompare(b)), text: await res.text() });

/** A body is bounded when it is exactly {error} with plain English: no internal code token, no database word, no stack. */
const TOKEN_LIKE = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/;
const DATABASE_WORDS = /relation|violates|constraint|duplicate key|sqlstate|postgres|supabase|\bP0001\b|\blifetime_|\bpg_|\bat\s+\S+\s+\(|service[_ -]?role|apikey|revoked/i;
function expectBounded(body: unknown, label = "") {
  expect(Object.keys(body as object), label).toEqual(["error"]);
  const text = (body as { error: unknown }).error;
  expect(typeof text, label).toBe("string");
  expect(text as string, label).not.toMatch(TOKEN_LIKE);
  expect(text as string, label).not.toMatch(DATABASE_WORDS);
  expect((text as string).length, label).toBeLessThan(200);
}

const signedOut = () => vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ errorResponse: NextResponse.json({ error: UNAUTHENTICATED_401 }, { status: 401 }) });
const anyStoreCalled = () => Object.values(lifetime.store).some((fn) => fn.mock.calls.length > 0);

const ORIGINAL_READY = process.env.COMPETITIONS_SCHEMA_READY;
let consoleError: MockInstance<Parameters<typeof console.error>, void>;

beforeEach(() => {
  process.env.COMPETITIONS_SCHEMA_READY = "true";
  vi.clearAllMocks();
  for (const fn of Object.values(lifetime.store)) fn.mockReset();
  for (const op of OPS) mutation(op).mockResolvedValue(op.record);
  lifetime.store.getEntryCompetitionId.mockResolvedValue(COMPETITION);
  lifetime.store.getRosterClaimCompetitionId.mockResolvedValue(COMPETITION);
  for (const r of READS) lifetime.store[r.key].mockResolvedValue([r.row]);
  lifetime.constructed.length = 0;
  lifetime.order.length = 0;
  seen.length = 0;
  vi.mocked(httpAuth.getSupabaseCredentials).mockReturnValue(CREDENTIALS);
  vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ gamingMemberId: SESSION });
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
  // B11, for the whole file: nothing any test provoked was cacheable.
  for (const r of seen) expect(r.cache, `${r.label} (${r.status}) must be Cache-Control: ${NO_STORE}`).toBe(NO_STORE);
});

afterAll(() => {
  if (ORIGINAL_READY === undefined) delete process.env.COMPETITIONS_SCHEMA_READY;
  else process.env.COMPETITIONS_SCHEMA_READY = ORIGINAL_READY;
});

// =============================================================================================================================================
describe("B1, B2, B3 — the availability guard runs before credentials, authentication, parsing and repository construction; then credentials, authentication, the ids, the body, the repository, the store", () => {
  const VALUES: Array<string | undefined> = [undefined, "", "false", "TRUE", "True", "1", "yes", " true", "true ", "null"];
  const everySurface = (): Array<[string, () => Promise<Response>]> => [
    ...OPS.map((op): [string, () => Promise<Response>] => [op.label, async () => (await invoke(op, { body: "not json {{{" })).res]),
    ...READS.map((r): [string, () => Promise<Response>] => [r.label, () => read(r)]),
  ];

  it.each(VALUES)("COMPETITIONS_SCHEMA_READY=%s: every one of the twelve surfaces answers the bounded 503 and touches nothing", async (value) => {
    if (value === undefined) delete process.env.COMPETITIONS_SCHEMA_READY;
    else process.env.COMPETITIONS_SCHEMA_READY = value;
    expect(everySurface()).toHaveLength(12);
    for (const [label, call] of everySurface()) {
      const res = await call();
      expect(res.status, label).toBe(503);
      expect(await res.json(), label).toEqual({ error: UNAVAILABLE_503 });
    }
    expect(httpAuth.getSupabaseCredentials, "no credentials were read").not.toHaveBeenCalled();
    expect(httpAuth.requireGamingMember, "nobody was authenticated").not.toHaveBeenCalled();
    expect(lifetime.constructed, "no repository was built").toEqual([]);
    expect(anyStoreCalled()).toBe(false);
  });

  it.each(OPS.map((op) => [op.label, op] as const))("%s: a successful request goes credentials → authentication → repository → store, once each, in that order", async (_label, op) => {
    const { res } = await invoke(op);
    expect(res.status).toBe(op.status);
    const credentials = vi.mocked(httpAuth.getSupabaseCredentials).mock.invocationCallOrder;
    const auth = vi.mocked(httpAuth.requireGamingMember).mock.invocationCallOrder;
    expect(credentials).toHaveLength(1);
    expect(auth).toHaveLength(1);
    expect(credentials[0]).toBeLessThan(auth[0]);
    expect(lifetime.constructed).toEqual([{ url: CREDENTIALS.url, key: CREDENTIALS.serviceKey }]);
    // the repository is built once; then the binding read (when the route addresses an entry or a proposal), then the one mutation
    expect(lifetime.order).toEqual(["construct", ...(op.binds ? ["store"] : []), "store"]);
    expect(mutation(op)).toHaveBeenCalledTimes(1);
    expect(mutation(op).mock.calls[0]).toEqual(op.call);
    if (op.binds) expect(lifetime.store[op.binds].mock.calls).toEqual([[op.second]]);
  });

  it.each(OPS.map((op) => [op.label, op] as const))("%s: signed out is 401 and nothing else happens (no repository, no store)", async (_label, op) => {
    signedOut();
    const { res } = await invoke(op);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: UNAUTHENTICATED_401 });
    expect(lifetime.constructed).toEqual([]);
    expect(anyStoreCalled()).toBe(false);
  });

  it.each(READS.map((r) => [r.label, r] as const))("%s: signed out is 401, and no repository exists", async (_label, r) => {
    signedOut();
    const res = await read(r);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: UNAUTHENTICATED_401 });
    expect(lifetime.constructed).toEqual([]);
    expect(anyStoreCalled()).toBe(false);
  });

  it.each([...OPS.map((op) => [op.label, () => invoke(op).then((a) => a.res)] as const), ...READS.map((r) => [r.label, () => read(r)] as const)])("%s: missing server credentials is the generic 500 — nobody is authenticated and no repository exists", async (_label, call) => {
    vi.mocked(httpAuth.getSupabaseCredentials).mockReturnValue(null);
    const res = await call();
    expect(res.status).toBe(500);
    expectBounded(await res.json());
    expect(httpAuth.requireGamingMember).not.toHaveBeenCalled();
    expect(lifetime.constructed).toEqual([]);
  });

  it.each(WITH_BODY.map((op) => [op.label, op] as const))("%s: a malformed addressed id is refused BEFORE the body is read or a repository exists", async (_label, op) => {
    for (const over of [{ competition: "not-a-uuid" }, ...(op.second ? [{ second: "not-a-uuid" }] : [])]) {
      lifetime.constructed.length = 0;
      const { res } = await invoke(op, { ...over, body: "not json {{{" });
      expect(res.status, JSON.stringify(over)).toBe(400);
      expect(await res.json()).toEqual({ error: messageOf("INPUT_INVALID") });
      expect(lifetime.constructed).toEqual([]);
      expect(anyStoreCalled()).toBe(false);
    }
  });

  it.each(OPS.map((op) => [op.label, op] as const))("%s: a malformed addressed id is a bounded 400 and nothing is built", async (_label, op) => {
    for (const over of [{ competition: "not-a-uuid" }, ...(op.second ? [{ second: "not-a-uuid" }] : []), { competition: COMPETITION.slice(0, -1) }, { competition: `${COMPETITION} ` }]) {
      lifetime.constructed.length = 0;
      const { res } = await invoke(op, over);
      expect(res.status, JSON.stringify(over)).toBe(400);
      expect(await res.json()).toEqual({ error: messageOf("INPUT_INVALID") });
      expect(lifetime.constructed).toEqual([]);
    }
  });
});

// =============================================================================================================================================
describe("B4 — the actor is the session member: no path, query, header or body value ever names one", () => {
  it.each(OPS.map((op) => [op.label, op] as const))("%s: forged query values and headers change nothing — the store sees the session member only", async (_label, op) => {
    const forged = `?actor=${OTHER}&gamingMemberId=${OTHER}&organizerGamingMemberId=${OTHER}&captain=${OTHER}`;
    const { res } = await invoke(op, { query: forged, headers: { "x-gaming-member-id": OTHER, "x-actor": OTHER, "x-organizer": OTHER } });
    expect(res.status).toBe(op.status);
    expect(mutation(op).mock.calls[0]).toEqual(op.call);
    expect(JSON.stringify(mutation(op).mock.calls)).not.toContain(OTHER);
  });

  it.each(WITH_BODY.map((op) => [op.label, op] as const))("%s: a body field naming an actor, an organizer, a status or a time is refused (and nothing is called)", async (_label, op) => {
    for (const field of ["actor", "actorGamingMemberId", "organizerGamingMemberId", "gamingMemberId", "captainGamingMemberId", "status", "role", "approvedAt", "competitionId", "competitionTeamId", "claimId"]) {
      const { res } = await invoke(op, { body: withExtra(op, field, OTHER) });
      expect(res.status, field).toBe(400);
      expect(await res.json(), field).toEqual({ error: op.sentence });
    }
    expect(lifetime.constructed).toEqual([]);
    expect(anyStoreCalled()).toBe(false);
  });

  it.each(OPS.filter((op) => op.body === null).map((op) => [op.label, op] as const))("%s: reads no request body at all — a body that is not even JSON changes nothing", async (_label, op) => {
    const { res } = await invoke(op, { body: "not json {{{ {\"actor\":\"x\"}" });
    expect(res.status).toBe(op.status);
    expect(mutation(op).mock.calls[0]).toEqual(op.call);
  });

  it.each(READS.map((r) => [r.label, r] as const))("%s: no query, header or body can choose the member — the store is asked for the session member alone", async (_label, r) => {
    const res = await read(r, { url: `${r.url}?gamingMemberId=${OTHER}&actor=${OTHER}&competitionId=${ELSEWHERE}`, headers: { "x-gaming-member-id": OTHER, "x-actor": OTHER } });
    expect(res.status).toBe(200);
    expect(lifetime.store[r.key].mock.calls).toEqual([r.call]);
    expect(JSON.stringify(lifetime.store[r.key].mock.calls)).not.toContain(OTHER);
    expect(JSON.stringify(lifetime.store[r.key].mock.calls)).not.toContain(ELSEWHERE);
  });
});

// =============================================================================================================================================
describe("B5 — the exact body: exactly the fields the route names, and valid ones", () => {
  const bodies = (op: Op): Array<[string, string]> => [
    ["not JSON at all", "not json {{{"],
    ["an empty body", ""],
    ["an array", "[]"], ["a string", '"x"'], ["a number", "7"], ["null", "null"], ["true", "true"],
    ["an empty object", "{}"],
    ["a misspelled field", JSON.stringify({ [Object.keys(op.body!)[0] + "s"]: Object.values(op.body!)[0] })],
    ["an own __proto__ key", `{"__proto__":{"x":1},${JSON.stringify(op.body).slice(1)}`],
  ];
  it.each(WITH_BODY.map((op) => [op.label, op] as const))("%s: every body of the wrong shape is a bounded 400 with the route's own sentence, before any repository exists", async (_label, op) => {
    for (const [label, text] of bodies(op)) {
      lifetime.constructed.length = 0;
      const { res } = await invoke(op, { body: text });
      expect(res.status, label).toBe(400);
      const body = await res.json();
      expectBounded(body, label);
      expect(body, label).toEqual({ error: label === "not JSON at all" || label === "an empty body" ? INVALID_JSON : op.sentence });
      expect(lifetime.constructed, label).toEqual([]);
      expect(anyStoreCalled(), label).toBe(false);
    }
  });

  it("an entry decision names exactly one of three shapes — and never an approval with a reason or a note, nor a rejection without a reason", async () => {
    const op = opNamed("decideEntry");
    const SHAPES: Array<[string, unknown, unknown[] | number]> = [
      ["APPROVE", { decision: "APPROVE" }, [COMPETITION, ENTRY, SESSION, "APPROVE", null, null]],
      ["REJECT with a reason", { decision: "REJECT", reasonCode: "RULE_VIOLATION" }, [COMPETITION, ENTRY, SESSION, "REJECT", "RULE_VIOLATION", null]],
      ["REJECT with a reason and a note (normalized)", { decision: "REJECT", reasonCode: "OTHER_ORGANIZER_DECISION", note: "  Too   late \n now " }, [COMPETITION, ENTRY, SESSION, "REJECT", "OTHER_ORGANIZER_DECISION", "Too late now"]],
      ["REMOVE with a reason", { decision: "REMOVE", reasonCode: "COMPETITION_CAPACITY" }, [COMPETITION, ENTRY, SESSION, "REMOVE", "COMPETITION_CAPACITY", null]],
      ["REJECT with a null note", { decision: "REJECT", reasonCode: "INELIGIBLE_TEAM", note: null }, [COMPETITION, ENTRY, SESSION, "REJECT", "INELIGIBLE_TEAM", null]],
      ["APPROVE with a reason", { decision: "APPROVE", reasonCode: "INELIGIBLE_TEAM" }, 400],
      ["APPROVE with a note", { decision: "APPROVE", reasonCode: null, note: "ok" }, 400],
      ["REJECT without a reason", { decision: "REJECT" }, 400],
      ["REJECT with an unlisted reason", { decision: "REJECT", reasonCode: "BECAUSE" }, 400],
      ["REJECT with a blank note", { decision: "REJECT", reasonCode: "RULE_VIOLATION", note: "   " }, 400],
      ["REJECT with a note that is not text", { decision: "REJECT", reasonCode: "RULE_VIOLATION", note: 7 }, 400],
      ["REJECT with a control character in the note", { decision: "REJECT", reasonCode: "RULE_VIOLATION", note: "a\u0007b" }, 400],
      ["REJECT with a note of 281 characters", { decision: "REJECT", reasonCode: "RULE_VIOLATION", note: "x".repeat(281) }, 400],
      ["an unknown decision", { decision: "ACCEPT" }, 400],
      ["a lower-case decision", { decision: "approve" }, 400],
      ["a note without a reason", { decision: "REJECT", note: "late" }, 400],
    ];
    for (const [label, body, expected] of SHAPES) {
      mutation(op).mockClear();
      lifetime.constructed.length = 0;
      const { res } = await invoke(op, { body: JSON.stringify(body) });
      if (Array.isArray(expected)) {
        expect(res.status, label).toBe(200);
        expect(mutation(op).mock.calls, label).toEqual([expected]);
      } else {
        expect(res.status, label).toBe(expected);
        expectBounded(await res.json(), label);
        expect(mutation(op), label).not.toHaveBeenCalled();
      }
    }
  });

  it("a roster proposal batch is 1 to 32 DIFFERENT well-formed ids, and nothing else", async () => {
    const op = opNamed("proposeRosterClaims");
    const ids = (n: number) => Array.from({ length: n }, (_, i) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, "0")}`);
    const CASES: Array<[string, unknown, boolean]> = [
      ["one person", ids(1), true], ["thirty-two people", ids(32), true], ["no people", [], false], ["thirty-three people", ids(33), false],
      ["the same person twice", [P1, P1], false], ["the same person in two letter cases", [P1, P1.toUpperCase()], false], ["a malformed id", [P1, "nope"], false],
      ["a null among them", [P1, null], false], ["a number among them", [P1, 7], false], ["not a list", P1, false], ["an object", { 0: P1 }, false],
    ];
    for (const [label, value, ok] of CASES) {
      mutation(op).mockClear();
      const { res } = await invoke(op, { body: JSON.stringify({ gamingMemberIds: value }) });
      if (ok) {
        expect(res.status, label).toBe(201);
        expect(mutation(op).mock.calls, label).toEqual([[ENTRY, SESSION, value]]);
      } else {
        expect(res.status, label).toBe(400);
        expectBounded(await res.json(), label);
        expect(mutation(op), label).not.toHaveBeenCalled();
      }
    }
  });

  it("an answer to a roster proposal is exactly ACCEPT or REJECT", async () => {
    const op = opNamed("decideRosterClaim");
    for (const decision of ["ACCEPT", "REJECT"]) {
      mutation(op).mockClear();
      expect((await invoke(op, { body: JSON.stringify({ decision }) })).res.status).toBe(200);
      expect(mutation(op).mock.calls).toEqual([[CLAIM, SESSION, decision]]);
    }
    for (const decision of ["DECLINE", "accept", "APPROVE", "", null, 1, ["ACCEPT"], { v: "ACCEPT" }]) {
      mutation(op).mockClear();
      const { res } = await invoke(op, { body: JSON.stringify({ decision }) });
      expect(res.status, JSON.stringify(decision)).toBe(400);
      expectBounded(await res.json());
      expect(mutation(op)).not.toHaveBeenCalled();
    }
  });

  it("entering a team names exactly a well-formed team id", async () => {
    const op = opNamed("enterTeam");
    for (const value of ["nope", 7, null, "", ` ${TEAM}`, [TEAM]]) {
      const { res } = await invoke(op, { body: JSON.stringify({ lifetimeTeamId: value }) });
      expect(res.status, JSON.stringify(value)).toBe(400);
      expectBounded(await res.json());
    }
    expect(mutation(op)).not.toHaveBeenCalled();
  });
});

// =============================================================================================================================================
describe("B7 — a response is a copy of explicitly named fields", () => {
  it.each(OPS.map((op) => [op.label, op] as const))("%s: answers exactly its documented body — and never a field the store also held", async (_label, op) => {
    const { res } = await invoke(op);
    expect(res.status).toBe(op.status);
    const body = await res.json();
    expect(body).toEqual(op.shape);
    expect(JSON.stringify(body)).not.toMatch(/never shown|internal|decisionId|releaseReason|ByGamingMemberId|proposedBy|"status":"PENDING_ORGANIZER_APPROVAL"/);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
  });

  it("an organizer's decision answers each of the three outcomes with the store's own words", async () => {
    const op = opNamed("decideEntry");
    for (const [decision, status] of [["APPROVE", "ACCEPTED"], ["REJECT", "REJECTED"], ["REMOVE", "REJECTED"]] as const) {
      mutation(op).mockResolvedValue({ ...op.record, decision, status, releasedClaims: 4 });
      const body = decision === "APPROVE" ? { decision } : { decision, reasonCode: "RULE_VIOLATION" };
      const { res } = await invoke(op, { body: JSON.stringify(body) });
      expect(await res.json()).toEqual({ entry: { competitionTeamId: ENTRY, status, decision, decidedAt: AT, releasedClaims: 4 } });
    }
  });

  it("a flow, a freeze that already existed and a flow that was never on say so", async () => {
    mutation(opNamed("enableEntryFlow")).mockResolvedValue({ competitionId: COMPETITION, enabledAt: AT, alreadyEnabled: true });
    expect(await (await invoke(opNamed("enableEntryFlow"))).res.json()).toEqual({ flow: { competitionId: COMPETITION, enabledAt: AT, alreadyEnabled: true } });
    mutation(opNamed("disableEntryFlow")).mockResolvedValue({ competitionId: COMPETITION, disabledAt: null, alreadyDisabled: true });
    expect(await (await invoke(opNamed("disableEntryFlow"))).res.json()).toEqual({ flow: { competitionId: COMPETITION, disabledAt: null, alreadyDisabled: true } });
    mutation(opNamed("freezeEntries")).mockResolvedValue({ competitionId: COMPETITION, frozenAt: AT, entryCount: 2, claimCount: 10, alreadyFrozen: true });
    expect(await (await invoke(opNamed("freezeEntries"))).res.json()).toEqual({ freeze: { competitionId: COMPETITION, frozenAt: AT, entryCount: 2, claimCount: 10, alreadyFrozen: true } });
  });
});

// =============================================================================================================================================
describe("B8, B9, B10 — the refusal table, the privacy collapse, and raw failures that never escape", () => {
  /** The refusals of each cause, raised the way the repository raises them — with the database's own words inside, which must never come out. */
  const CAUSES: Record<Cause, () => unknown[]> = {
    COMPETITION: () => [new CompetitionNotFoundError(), new CompetitionAccessDeniedError("COMPETITION_ACCESS_DENIED: only this competition's own organizer may decide a lifetime entry"), new HostAccessRevokedError("HOST_ACCESS_REVOKED: this hosting access has been revoked")],
    TEAM_NOT_FOUND: () => [new LifetimeTeamError("TEAM_NOT_FOUND")],
    ENTRY_NOT_FOUND: () => [new LifetimeTeamError("ENTRY_NOT_FOUND")],
    CLAIM_NOT_FOUND: () => [new LifetimeTeamError("CLAIM_NOT_FOUND")],
    NOT_A_LEADER: () => [new LifetimeTeamError("NOT_A_LEADER")],
    CLAIM_WRONG_PARTY: () => [new LifetimeTeamError("CLAIM_WRONG_PARTY")],
  };
  const CAUSE_NAMES = Object.keys(CAUSES) as Cause[];

  const provoke = async (op: Op, error: unknown) => {
    mutation(op).mockRejectedValue(error);
    return invoke(op);
  };

  it.each(OPS.map((op) => [op.label, op] as const))("%s: what is unknown and what is not the caller's are ONE answer per route — and a cause that is not this route's fails closed", async (_label, op) => {
    for (const cause of CAUSE_NAMES) {
      const answers: string[] = [];
      for (const error of CAUSES[cause]()) {
        const { res } = await provoke(op, error);
        const snap = await snapshot(res);
        answers.push(`${snap.status} ${snap.text}`);
        const sentence = op.notFound[cause];
        if (cause === "CLAIM_WRONG_PARTY" && op.key === "releaseRosterClaim") {
          expect(snap.status, "a person naming their own proposal to release it has standing: a conflict").toBe(409);
          expect(JSON.parse(snap.text)).toEqual({ error: SAID.proposalIsAnswered });
        } else if (sentence !== undefined) {
          expect(snap.status, `${cause} → 404`).toBe(404);
          expect(JSON.parse(snap.text)).toEqual({ error: sentence });
        } else {
          expect(snap.status, `${cause} is not classified on this route: the generic 500`).toBe(500);
          expect(JSON.parse(snap.text)).toEqual({ error: GENERIC_500 });
        }
        expectBounded(JSON.parse(snap.text), cause);
      }
      expect(new Set(answers).size, `${cause}: every refusal of one cause answers alike (${answers.join(" | ")})`).toBe(1);
    }
  });

  it("a stranger, an unknown id and a revoked organizer cannot be told apart on any route that names a competition", async () => {
    for (const op of OPS.filter((o) => o.notFound.COMPETITION !== undefined)) {
      const answers = new Set<string>();
      for (const error of CAUSES.COMPETITION()) answers.add(await snapshot((await provoke(op, error)).res).then((s) => `${s.status} ${s.text} ${s.headers.map(([k, v]) => `${k}=${v}`).join(";")}`));
      expect(answers.size, op.label).toBe(1);
    }
  });

  const CONFLICTS: LifetimeProblem[] = [
    "TEAM_NOT_ACTIVE", "TEAM_DORMANT", "FLOW_NOT_ENABLED", "FLOW_CONFLICT", "FLOW_RECOVERY_BLOCKED", "FLOW_RECOVERY_UNSAFE_LEGACY_STATE", "ENTRY_NOT_LIVE", "ENTRY_ALREADY_EXISTS", "ENTRIES_FROZEN",
    "ENTRY_NOT_PENDING", "ENTRY_NOT_ACCEPTED", "ENTRY_CAPTAIN_CHANGED", "CLAIM_NOT_OPEN", "CLAIM_EXPIRED", "CLAIM_ALREADY_OPEN", "CLAIM_SUBJECT_NOT_MEMBER", "PERSON_ALREADY_CLAIMED",
    "PERSON_REPRESENTS_ANOTHER_TEAM", "ROSTER_FULL", "ADULT_ATTESTATION_REQUIRED", "FREEZE_PLAN_INVALID", "FREEZE_DEADLINE_NOT_REACHED", "FREEZE_PENDING_ENTRIES", "FREEZE_NOT_ENOUGH_ENTRIES",
    "FREEZE_ROSTER_BELOW_MINIMUM", "FREEZE_ROSTER_ABOVE_MAXIMUM", "INVARIANT_VIOLATION", "CONCURRENT_CHANGE",
  ];
  const BAD_REQUESTS: LifetimeProblem[] = ["INPUT_INVALID", "DECISION_INVALID", "CLAIM_BATCH_INVALID", "REASON_INVALID", "NOTE_INVALID"];
  const CLASSIFIED = new Set<LifetimeProblem>([...CONFLICTS, ...BAD_REQUESTS, "TEAM_NOT_FOUND", "ENTRY_NOT_FOUND", "CLAIM_NOT_FOUND", "NOT_A_LEADER", "CLAIM_WRONG_PARTY"]);
  const EVERY_PROBLEM = [...new Set<LifetimeProblem>([...LIFETIME_DATABASE_CODES.map(([, problem]) => problem), "INPUT_INVALID", "UNAVAILABLE"])];

  it("every refusal the foundation can raise is classified or is the generic 500 — the list of conflicts is exactly the one this file states", () => {
    expect(EVERY_PROBLEM.length).toBeGreaterThan(60);
    for (const code of CLASSIFIED) expect(EVERY_PROBLEM, code).toContain(code);
  });

  it.each(OPS.map((op) => [op.label, op] as const))("%s: a conflict is a 409 with the foundation's own bounded sentence; a bad request is a 400; every other refusal is the generic 500", async (_label, op) => {
    for (const code of EVERY_PROBLEM) {
      if (["TEAM_NOT_FOUND", "ENTRY_NOT_FOUND", "CLAIM_NOT_FOUND", "NOT_A_LEADER", "CLAIM_WRONG_PARTY"].includes(code)) continue; // the table above
      const error = ((): unknown => {
        // the three refusals that state a count are raised the way the database raises them, so that the numbers are the database's
        if (code === "FREEZE_NOT_ENOUGH_ENTRIES") return translateLifetimeError({ code: "P0001", message: "LIFETIME_FREEZE_NOT_ENOUGH_ENTRIES: at least two accepted entries are needed (found 1)" });
        if (code === "FREEZE_ROSTER_BELOW_MINIMUM") return translateLifetimeError({ code: "P0001", message: "LIFETIME_FREEZE_ROSTER_BELOW_MINIMUM: an entry has 3 accepted player(s); the minimum is 5" });
        if (code === "FREEZE_ROSTER_ABOVE_MAXIMUM") return translateLifetimeError({ code: "P0001", message: "LIFETIME_FREEZE_ROSTER_ABOVE_MAXIMUM: an entry has 9 accepted player(s); the maximum is 8" });
        return new LifetimeTeamError(code);
      })();
      const { res } = await provoke(op, error);
      const body = await res.json();
      if (CONFLICTS.includes(code)) {
        expect(res.status, code).toBe(409);
        expect(body, code).toEqual({ error: (error as Error).message });
        expectBounded(body, code);
      } else if (BAD_REQUESTS.includes(code)) {
        expect(res.status, code).toBe(400);
        expect(body, code).toEqual({ error: messageOf(code) });
      } else {
        expect(res.status, `${code} belongs to another operation: not classified here`).toBe(500);
        expect(body, code).toEqual({ error: GENERIC_500 });
      }
    }
  });

  it("the three freeze refusals that state a count carry the database's numbers, and only those", async () => {
    const op = opNamed("freezeEntries");
    const said = async (message: string) => (await (await provoke(op, translateLifetimeError({ code: "P0001", message }))).res.json()).error as string;
    expect(await said("LIFETIME_FREEZE_NOT_ENOUGH_ENTRIES: at least two accepted entries are needed (found 1)")).toBe("At least two accepted entries are needed (found 1).");
    expect(await said("LIFETIME_FREEZE_ROSTER_BELOW_MINIMUM: an entry has 3 accepted player(s); the minimum is 5")).toBe("An entry has 3 accepted players, below the roster minimum of 5.");
    expect(await said("LIFETIME_FREEZE_ROSTER_ABOVE_MAXIMUM: an entry has 9 accepted player(s); the maximum is 8")).toBe("An entry has 9 accepted players, above the roster maximum of 8.");
    expect(await said("LIFETIME_FREEZE_PENDING_ENTRIES: decide every pending entry before freezing")).toBe("Decide every pending entry before freezing the entries.");
    // a refusal without numbers says no number
    expect(await said("LIFETIME_FREEZE_NOT_ENOUGH_ENTRIES: nothing stated")).toBe("At least two accepted entries are needed.");
  });

  it.each([
    [new CompetitionCancelledError(), "This competition has been cancelled."],
    [new TeamRegistrationNotOpenError("TEAM_REGISTRATION_NOT_OPEN: the registration deadline for this competition has passed"), "Team registration is not open for this competition."],
    [new CompetitionRegistrationRequiredError(), "Register for this competition first."],
    [new DuplicateTeamNameError(), "A team with this name has already entered this competition."],
    [new AlreadyCaptainOrMemberError(), "This person already holds a team role in this competition."],
  ])("the competitions repository's own refusal %# is a 409 in this adapter's words — never the repository's", async (error, sentence) => {
    for (const op of OPS) {
      const { res } = await provoke(op, error);
      expect(res.status, op.label).toBe(409);
      expect(await res.json(), op.label).toEqual({ error: sentence });
    }
  });

  it("a refusal the competitions repository knows but these operations never raise is the generic 500, not a classification of its own", async () => {
    const { NotTeamCaptainError, JoinRequestNotFoundError } = await import("../lib/gaming/competitions/types");
    for (const error of [new NotTeamCaptainError("NOT_TEAM_CAPTAIN: secret"), new JoinRequestNotFoundError()]) {
      for (const op of OPS) {
        const { res } = await provoke(op, error);
        expect(res.status, op.label).toBe(500);
        expect(await res.json(), op.label).toEqual({ error: GENERIC_500 });
      }
    }
  });

  const RAW: Array<[string, unknown]> = [
    ["a raw Error carrying database text", new Error('relation "competition_teams" does not exist at character 14 (service_role apikey eyJhbGciOi)')],
    ["a PostgREST-shaped object", { code: "42P01", message: 'relation "lifetime_teams" does not exist', details: "secret", hint: "x" }],
    ["a TypeError", new TypeError("Cannot read properties of undefined (reading 'rows')")],
    ["a string", "boom: lifetime_team_memberships violates secret"], ["undefined", undefined], ["null", null], ["a number", 42],
    ["the foundation's own UNAVAILABLE", new LifetimeTeamError("UNAVAILABLE")],
  ];
  it.each(OPS.map((op) => [op.label, op] as const))("%s: any raw failure is the generic 500 — no database word, no stack, and the log carries one bounded token", async (_label, op) => {
    for (const [label, failure] of RAW) {
      consoleError.mockClear();
      const { res } = await provoke(op, failure);
      expect(res.status, label).toBe(500);
      const body = await res.json();
      expect(body, label).toEqual({ error: GENERIC_500 });
      expectBounded(body, label);
      for (const call of consoleError.mock.calls) {
        expect(String(call[0]), label).toMatch(/^GAMING_TEAM_ENTRY_HTTP [a-z-]+ failed:$/);
        expect(String(call[1] ?? ""), label).toMatch(/^[A-Za-z0-9_]{1,40}$/);
        expect(JSON.stringify(call), label).not.toMatch(/relation|secret|service_role|eyJ|character 14/);
      }
    }
  });

  it("a binding read that fails raw is the generic 500 too, and the mutation is never attempted", async () => {
    for (const op of BINDING) {
      lifetime.store[op.binds!].mockRejectedValue(new Error('relation "competition_teams" does not exist'));
      mutation(op).mockClear();
      const { res } = await invoke(op);
      expect(res.status, op.label).toBe(500);
      expect(await res.json(), op.label).toEqual({ error: GENERIC_500 });
      expect(mutation(op), op.label).not.toHaveBeenCalled();
    }
  });
});

// =============================================================================================================================================
describe("B14 — an entry or a proposal is reached only through ITS competition: another competition, an unknown id and a malformed answer are one 404, and nothing changes", () => {
  it.each(BINDING.map((op) => [op.label, op] as const))("%s: the mutation is attempted only when the entry or proposal belongs to the competition named (any letter case)", async (_label, op) => {
    const bind = lifetime.store[op.binds!];
    for (const [label, found] of [["the same competition", COMPETITION], ["the same competition in upper case", COMPETITION.toUpperCase()]] as const) {
      bind.mockResolvedValue(found);
      mutation(op).mockClear();
      expect((await invoke(op)).res.status, label).toBe(op.status);
      expect(mutation(op), label).toHaveBeenCalledTimes(1);
    }
  });

  it.each(BINDING.map((op) => [op.label, op] as const))("%s: ANOTHER competition's, an unknown and a malformed answer are the same 404 (bytes included) and the mutation is never attempted", async (_label, op) => {
    const bind = lifetime.store[op.binds!];
    const sentence = op.notFound.ENTRY_NOT_FOUND ?? op.notFound.CLAIM_NOT_FOUND;
    const answers = new Set<string>();
    for (const found of [ELSEWHERE, null, "not-a-uuid", "", undefined]) {
      bind.mockResolvedValue(found);
      mutation(op).mockClear();
      const { res } = await invoke(op);
      const snap = await snapshot(res);
      answers.add(`${snap.status} ${snap.text}`);
      expect(snap.status, String(found)).toBe(404);
      expect(JSON.parse(snap.text)).toEqual({ error: sentence });
      expect(mutation(op), String(found)).not.toHaveBeenCalled();
    }
    expect(answers.size, "one answer for every way of not being in this competition").toBe(1);
  });

  it.each(BINDING.map((op) => [op.label, op] as const))("%s: a request addressed through a competition the entry is NOT in cannot be rescued by the body, the query or a header", async (_label, op) => {
    lifetime.store[op.binds!].mockResolvedValue(ELSEWHERE);
    const { res } = await invoke(op, { query: `?competitionId=${ELSEWHERE}`, headers: { "x-competition-id": ELSEWHERE } });
    expect(res.status).toBe(404);
    expect(mutation(op)).not.toHaveBeenCalled();
  });

  it("the organizer's decision, the entry and the freeze name the competition to the database itself: it is part of every call, and no extra binding read is made", async () => {
    for (const key of ["decideEntry", "enterTeam", "enableEntryFlow", "disableEntryFlow", "freezeEntries"]) {
      const op = opNamed(key);
      const { res } = await invoke(op, { competition: ELSEWHERE });
      expect(res.status, key).toBe(op.status);
      expect(mutation(op).mock.calls[0][0], key).toBe(ELSEWHERE);
    }
    expect(lifetime.store.getEntryCompetitionId).not.toHaveBeenCalled();
    expect(lifetime.store.getRosterClaimCompetitionId).not.toHaveBeenCalled();
  });
});

// =============================================================================================================================================
describe("B13 — the reads: derived from the verified member alone, projected field by field, and never a conflict", () => {
  it.each(READS.map((r) => [r.label, r] as const))("%s: answers exactly the documented fields — and never one the store also held", async (_label, r) => {
    const res = await read(r);
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe(NO_STORE);
    const body = await res.json();
    expect(body).toEqual({ [r.field]: [r.shown] });
    expect(JSON.stringify(body)).not.toMatch(/example\.com|secret|authUserId|captainGamingMemberId|decidedBy|proposedBy|email|"status":"ACTIVE"/);
    expect(lifetime.store[r.key].mock.calls).toEqual([r.call]);
    expect(lifetime.order).toEqual(["construct", "store"]);
  });

  it.each(READS.map((r) => [r.label, r] as const))("%s: nothing at all is an empty list, in the order the store gave", async (_label, r) => {
    lifetime.store[r.key].mockResolvedValue([]);
    expect(await (await read(r)).json()).toEqual({ [r.field]: [] });
    const second = { ...r.row, ...(r.field === "entries" ? { competitionTeamId: OTHER } : { claimId: OTHER }) };
    lifetime.store[r.key].mockResolvedValue([r.row, second]);
    const body = await (await read(r)).json();
    expect(body[r.field]).toHaveLength(2);
    expect(JSON.stringify(body[r.field][0])).toContain(r.field === "entries" ? ENTRY : CLAIM);
    expect(JSON.stringify(body[r.field][1])).toContain(OTHER);
  });

  it.each(READS.map((r) => [r.label, r] as const))("%s: a row that is malformed in any field is dropped — never shown, never repaired — and the valid ones remain", async (_label, r) => {
    for (const [label, over] of r.malformed) {
      lifetime.store[r.key].mockResolvedValue([{ ...r.row, ...over }, r.row]);
      const body = await (await read(r)).json();
      expect(body, label).toEqual({ [r.field]: [r.shown] });
    }
    lifetime.store[r.key].mockResolvedValue([null, 7, "x", [], r.row]);
    expect(await (await read(r)).json()).toEqual({ [r.field]: [r.shown] });
  });

  it("a leader's entry drops a proposal that is malformed, and keeps the entry and its other proposals", async () => {
    const r = READS[1];
    const bad = [{ ...LED_CLAIM, claimId: "nope" }, { ...LED_CLAIM, displayName: " " }, { ...LED_CLAIM, status: "REMOVED" }, { ...LED_CLAIM, expiresAt: "soon" }, { ...LED_CLAIM, gamingMemberId: 3 }, null, "x", []];
    lifetime.store[r.key].mockResolvedValue([{ ...LED_ROW, claims: [...bad, { ...LED_CLAIM, status: "ACCEPTED" }] }]);
    expect(await (await read(r)).json()).toEqual({ entries: [{ ...r.shown, claims: [{ claimId: CLAIM, gamingMemberId: P1, displayName: "Pedro", status: "ACCEPTED", expiresAt: LATER }] }] });
  });

  it.each(READS.map((r) => [r.label, r] as const))("%s: a store answer that is not a list is the generic 500", async (_label, r) => {
    for (const answer of [null, undefined, {}, "rows", 7]) {
      lifetime.store[r.key].mockResolvedValue(answer);
      const res = await read(r);
      expect(res.status, String(answer)).toBe(500);
      expect(await res.json()).toEqual({ error: GENERIC_500 });
    }
  });

  it.each(READS.map((r) => [r.label, r] as const))("%s: whatever fails — a raw error, a conflict, anything — is the generic 500; a read is never a conflict", async (_label, r) => {
    for (const failure of [new Error('relation "competition_teams" does not exist'), new LifetimeTeamError("CONCURRENT_CHANGE"), new LifetimeTeamError("ENTRIES_FROZEN"), new LifetimeTeamError("NOT_A_LEADER"), "boom", undefined]) {
      lifetime.store[r.key].mockRejectedValue(failure);
      const res = await read(r);
      expect(res.status, String(failure)).toBe(500);
      const body = await res.json();
      expect(body).toEqual({ error: GENERIC_500 });
      expectBounded(body);
    }
  });

  it("the organizer's read: a competition that is unknown, somebody else's or whose organizer was revoked is ONE 404, and a malformed competition id is a 400 before a repository exists", async () => {
    const r = READS[0];
    const answers = new Set<string>();
    for (const failure of [new CompetitionNotFoundError(), new CompetitionAccessDeniedError("COMPETITION_ACCESS_DENIED: secret"), new HostAccessRevokedError("HOST_ACCESS_REVOKED: secret")]) {
      lifetime.store[r.key].mockRejectedValue(failure);
      const snap = await snapshot(await read(r));
      expect(snap.status).toBe(404);
      expect(JSON.parse(snap.text)).toEqual({ error: SAID.competition });
      answers.add(`${snap.status} ${snap.text}`);
    }
    expect(answers.size).toBe(1);
    lifetime.constructed.length = 0;
    const bad = await read(r, { url: `${BASE}/nope/lifetime-entries`, competition: "nope" });
    expect(bad.status).toBe(400);
    expect(await bad.json()).toEqual({ error: messageOf("INPUT_INVALID") });
    expect(lifetime.constructed).toEqual([]);
  });

  it("the member's own two reads treat a refusal of an unknown competition as a failure: they address no competition", async () => {
    for (const r of READS.slice(1)) {
      lifetime.store[r.key].mockRejectedValue(new CompetitionNotFoundError());
      const res = await read(r);
      expect(res.status, r.label).toBe(500);
      expect(await res.json()).toEqual({ error: GENERIC_500 });
    }
  });
});

// =============================================================================================================================================
describe("B12 — the surface is exactly twelve handlers: nine POST and three GET", () => {
  const code = (file: string) => readFileSync(path.join(ROOT, file), "utf8");

  it("the adapter exports exactly its twelve handlers and nothing else", () => {
    expect(Object.keys(adapter).sort()).toEqual([
      "handleDecideEntry", "handleDecideRosterClaim", "handleDisableEntryFlow", "handleEnableEntryFlow", "handleEnterTeam", "handleFreezeEntries", "handleListCompetitionEntries",
      "handleListMyRosterClaims", "handleListMyTeamEntries", "handleProposeRosterClaims", "handleReleaseRosterClaim", "handleWithdrawEntry",
    ]);
  });

  const ROUTES: Array<[string, string[]]> = [
    ["app/api/gaming/competitions/[competitionId]/lifetime-entry-flow/enable/route.ts", ["POST"]],
    ["app/api/gaming/competitions/[competitionId]/lifetime-entry-flow/disable/route.ts", ["POST"]],
    ["app/api/gaming/competitions/[competitionId]/lifetime-entries/route.ts", ["GET", "POST", "dynamic"]],
    ["app/api/gaming/competitions/[competitionId]/lifetime-entries/freeze/route.ts", ["POST"]],
    ["app/api/gaming/competitions/[competitionId]/lifetime-entries/[competitionTeamId]/decision/route.ts", ["POST"]],
    ["app/api/gaming/competitions/[competitionId]/lifetime-entries/[competitionTeamId]/withdraw/route.ts", ["POST"]],
    ["app/api/gaming/competitions/[competitionId]/lifetime-entries/[competitionTeamId]/roster-claims/route.ts", ["POST"]],
    ["app/api/gaming/competitions/[competitionId]/lifetime-roster-claims/[claimId]/decision/route.ts", ["POST"]],
    ["app/api/gaming/competitions/[competitionId]/lifetime-roster-claims/[claimId]/release/route.ts", ["POST"]],
    ["app/api/gaming/competitions/lifetime-entries/route.ts", ["GET", "dynamic"]],
    ["app/api/gaming/competitions/lifetime-roster-claims/route.ts", ["GET", "dynamic"]],
  ];

  it.each(ROUTES)("%s exports exactly %j, imports nothing but the adapter, and the read routes are never prerendered", async (file, exports) => {
    const mod = await import(`../${file.replace(/\.ts$/, "")}`);
    expect(Object.keys(mod).sort()).toEqual([...exports].sort());
    const source = code(file);
    expect([...source.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1])).toEqual(["@/lib/gaming/competitions/lifetimeEntryHttp"]);
    if (exports.includes("GET")) expect(mod.dynamic).toBe("force-dynamic");
    expect(source).not.toMatch(/\.rpc\s*\(|\.from\s*\(|createClient|process\.env|NextResponse|lifetimeTeams|requireGamingMember/);
  });

  it("twelve handlers in eleven route files — nine POST, three GET", async () => {
    let get = 0;
    let post = 0;
    for (const [file] of ROUTES) {
      const mod = await import(`../${file.replace(/\.ts$/, "")}`);
      if (typeof mod.GET === "function") get += 1;
      if (typeof mod.POST === "function") post += 1;
    }
    expect([ROUTES.length, get, post]).toEqual([11, 3, 9]);
  });

  it("every operation of the table is reached by exactly one route and every route by exactly one operation", () => {
    expect(OPS).toHaveLength(9);
    expect(new Set(OPS.map((op) => op.label)).size).toBe(9);
    expect(new Set([...OPS.map((op) => `${op.route}#POST#${op.key}`), ...READS.map((r) => `${r.route}#GET#${r.key}`)]).size).toBe(12);
    expect(READS).toHaveLength(3);
  });
});
