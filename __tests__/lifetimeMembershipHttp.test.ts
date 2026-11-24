import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { NextResponse } from "next/server";

/**
 * UG-CR-GATE-CFM-010 — the authenticated HTTP surface of lifetime-team membership and leadership: propose a membership, decide it, withdraw an offer, end a membership,
 * offer the sub-captain seat, decide that offer, end the seat.
 *
 * These tests run the REAL route handlers, the REAL bounded adapter behind them and the REAL domain operations (the seven operations, the identifier and decision parsers,
 * the typed refusals). Exactly two things are replaced, the same two seams the Competitions route sweep and the CFM-007 route tests replace: the credentials / caller-identity
 * helpers (httpAuth — whose availability guard keeps its REAL implementation, so these tests prove the guard runs inside each real handler) and the lifetime repository,
 * which becomes a recorder so a test sees WHEN it is constructed and with WHAT it is called. The database behind the same routes is exercised in the loopback contract file.
 *
 * B1…B12 name the behaviours of the gate: B1 availability first · B2 order · B3 signed out · B4 the actor is the session · B5 the exact body · B6 the addressed id ·
 * B7 the response is copied field by field · B8 the refusal table · B9 the privacy collapse · B10 raw failures never escape · B11 every response is uncached ·
 * B12 the surface is exactly seven POST handlers.
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
    proposeMembership: vi.fn(),
    decideMembership: vi.fn(),
    withdrawOffer: vi.fn(),
    endMembership: vi.fn(),
    offerLeadership: vi.fn(),
    decideLeadership: vi.fn(),
    endLeadership: vi.fn(),
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
import { LIFETIME_DATABASE_CODES, LifetimeTeamError, type LifetimeProblem } from "../lib/gaming/competitions/lifetimeTeams";
import { CompetitionAccessDeniedError } from "../lib/gaming/competitions/types";

const ROOT = path.resolve(__dirname, "..");
const SESSION = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const TEAM = "3a3a3a3a-3b3b-4c3c-8d3d-3e3e3e3e3e3e";
const MEMBERSHIP = "6a6a6a6a-6b6b-4c6c-8d6d-6e6e6e6e6e6e";
const OFFER = "7a7a7a7a-7b7b-4c7c-8d7d-7e7e7e7e7e7e";
const LEADERSHIP = "8a8a8a8a-8b8b-4c8c-8d8d-8e8e8e8e8e8e";
const SUBJECT = "99999999-9999-4999-8999-999999999999";
const SUCCESSOR = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AT = "2026-11-24T16:00:00.000Z";
const LATER = "2026-12-01T16:00:00.000Z";
const CREDENTIALS = { url: "http://loopback.invalid", serviceKey: "service-key-not-a-secret" };
const NO_STORE = "no-store, max-age=0";
const UNAVAILABLE_503 = "URBANO Gaming Competitions is temporarily unavailable while its database is being prepared.";
const UNAUTHENTICATED_401 = "A valid Authorization header for an authenticated Gaming Member is required.";
const TEAM_NOT_FOUND_TEXT = "That team could not be found.";
const OFFER_NOT_FOUND_TEXT = "That offer could not be found.";
const INVALID_JSON = "Request body must be valid JSON.";
const SENTENCE = {
  subject: "Request body must be exactly one field, gamingMemberId, holding the member's id.",
  decision: "Request body must be exactly one field, decision, holding ACCEPT or DECLINE.",
  kind: "Request body must be exactly one field, kind, holding MEMBERSHIP or LEADERSHIP.",
  endMembership: "Request body must be gamingMemberId, and optionally successorGamingMemberId.",
} as const;
const GENERIC_500 = new LifetimeTeamError("UNAVAILABLE").message;
const messageOf = (code: LifetimeProblem) => new LifetimeTeamError(code).message;

const BASE = "http://localhost/api/gaming/competitions";
type Handler = (request: Request, context?: unknown) => Promise<Response>;
type RouteModule = Record<string, unknown> & { GET?: Handler; POST?: Handler };

type StoreMethod = "proposeMembership" | "decideMembership" | "withdrawOffer" | "endMembership" | "offerLeadership" | "decideLeadership" | "endLeadership";
interface Op {
  key: StoreMethod;
  label: string;
  route: string;
  url: (id: string) => string;
  param: string;
  /** The default addressed id. */
  id: string;
  /** The one valid body (null: this operation reads no body at all). */
  body: Record<string, unknown> | null;
  /** The sentence a body of the wrong SHAPE is refused with. */
  sentence: string | null;
  /** The keys a body may carry (every other key is client-supplied authority and is refused). */
  accepted: string[];
  /** The exact arguments of the store call for the default request. */
  call: unknown[];
  /** What the (mocked) store returns — with fields the caller must never see. */
  record: Record<string, unknown>;
  status: 200 | 201;
  /** The exact response body: the fields copied one by one. */
  shape: Record<string, unknown>;
  /** The uniform 404 sentence of this route. */
  notFound: string;
  /** Problems that are the uniform 404 on THIS route only. */
  extraNotFound: LifetimeProblem[];
}

const OPS: Op[] = [
  {
    key: "proposeMembership", label: "propose membership", route: "../app/api/gaming/competitions/lifetime-teams/[lifetimeTeamId]/memberships/route",
    url: (id) => `${BASE}/lifetime-teams/${id}/memberships`, param: "lifetimeTeamId", id: TEAM,
    body: { gamingMemberId: SUBJECT }, sentence: SENTENCE.subject, accepted: ["gamingMemberId"], call: [TEAM, SESSION, SUBJECT],
    record: { lifetimeTeamMembershipId: MEMBERSHIP, status: "PENDING", initiatedBySide: "TEAM", expiresAt: LATER, initiatedByGamingMemberId: SESSION, internal: "never shown" },
    status: 201, shape: { membership: { lifetimeTeamMembershipId: MEMBERSHIP, status: "PENDING", initiatedBySide: "TEAM", expiresAt: LATER } }, notFound: TEAM_NOT_FOUND_TEXT, extraNotFound: [],
  },
  {
    key: "decideMembership", label: "decide membership", route: "../app/api/gaming/competitions/lifetime-memberships/[membershipId]/decision/route",
    url: (id) => `${BASE}/lifetime-memberships/${id}/decision`, param: "membershipId", id: MEMBERSHIP,
    body: { decision: "ACCEPT" }, sentence: SENTENCE.decision, accepted: ["decision"], call: [MEMBERSHIP, SESSION, "ACCEPT"],
    record: { lifetimeTeamMembershipId: MEMBERSHIP, status: "ACTIVE", joinedAt: AT, decidedByGamingMemberId: SESSION, internal: "never shown" },
    status: 200, shape: { membership: { lifetimeTeamMembershipId: MEMBERSHIP, status: "ACTIVE", joinedAt: AT } }, notFound: OFFER_NOT_FOUND_TEXT, extraNotFound: [],
  },
  {
    key: "withdrawOffer", label: "withdraw offer", route: "../app/api/gaming/competitions/lifetime-offers/[offerId]/withdraw/route",
    url: (id) => `${BASE}/lifetime-offers/${id}/withdraw`, param: "offerId", id: OFFER,
    body: { kind: "MEMBERSHIP" }, sentence: SENTENCE.kind, accepted: ["kind"], call: ["MEMBERSHIP", OFFER, SESSION],
    record: { offerId: OFFER, status: "ENDED", withdrawnByGamingMemberId: SESSION, internal: "never shown" },
    status: 200, shape: { offer: { offerId: OFFER, status: "ENDED" } }, notFound: OFFER_NOT_FOUND_TEXT, extraNotFound: [],
  },
  {
    key: "endMembership", label: "end membership", route: "../app/api/gaming/competitions/lifetime-teams/[lifetimeTeamId]/memberships/end/route",
    url: (id) => `${BASE}/lifetime-teams/${id}/memberships/end`, param: "lifetimeTeamId", id: TEAM,
    body: { gamingMemberId: SUBJECT }, sentence: SENTENCE.endMembership, accepted: ["gamingMemberId", "successorGamingMemberId"], call: [TEAM, SESSION, SUBJECT, null],
    record: { lifetimeTeamMembershipId: MEMBERSHIP, endedAt: AT, successorLeadershipId: null, endedByGamingMemberId: SESSION, internal: "never shown" },
    status: 200, shape: { membership: { lifetimeTeamMembershipId: MEMBERSHIP, endedAt: AT, successorLeadershipId: null } }, notFound: TEAM_NOT_FOUND_TEXT, extraNotFound: ["NOT_A_MEMBER"],
  },
  {
    key: "offerLeadership", label: "offer leadership", route: "../app/api/gaming/competitions/lifetime-teams/[lifetimeTeamId]/leadership-offers/route",
    url: (id) => `${BASE}/lifetime-teams/${id}/leadership-offers`, param: "lifetimeTeamId", id: TEAM,
    body: { gamingMemberId: SUBJECT }, sentence: SENTENCE.subject, accepted: ["gamingMemberId"], call: [TEAM, SESSION, SUBJECT],
    record: { lifetimeTeamLeadershipId: LEADERSHIP, status: "PENDING", expiresAt: LATER, role: "SUB_CAPTAIN", internal: "never shown" },
    status: 201, shape: { leadership: { lifetimeTeamLeadershipId: LEADERSHIP, status: "PENDING", expiresAt: LATER } }, notFound: TEAM_NOT_FOUND_TEXT, extraNotFound: [],
  },
  {
    key: "decideLeadership", label: "decide leadership", route: "../app/api/gaming/competitions/lifetime-leaderships/[leadershipId]/decision/route",
    url: (id) => `${BASE}/lifetime-leaderships/${id}/decision`, param: "leadershipId", id: LEADERSHIP,
    body: { decision: "DECLINE" }, sentence: SENTENCE.decision, accepted: ["decision"], call: [LEADERSHIP, SESSION, "DECLINE"],
    record: { lifetimeTeamLeadershipId: LEADERSHIP, status: "ENDED", startedAt: null, decidedByGamingMemberId: SESSION, internal: "never shown" },
    status: 200, shape: { leadership: { lifetimeTeamLeadershipId: LEADERSHIP, status: "ENDED", startedAt: null } }, notFound: OFFER_NOT_FOUND_TEXT, extraNotFound: [],
  },
  {
    key: "endLeadership", label: "end leadership", route: "../app/api/gaming/competitions/lifetime-teams/[lifetimeTeamId]/leadership/end/route",
    url: (id) => `${BASE}/lifetime-teams/${id}/leadership/end`, param: "lifetimeTeamId", id: TEAM,
    body: null, sentence: null, accepted: [], call: [TEAM, SESSION],
    record: { lifetimeTeamLeadershipId: LEADERSHIP, endedAt: AT, endReason: "STEPPED_DOWN", endedByGamingMemberId: SESSION, internal: "never shown" },
    status: 200, shape: { leadership: { lifetimeTeamLeadershipId: LEADERSHIP, endedAt: AT, endReason: "STEPPED_DOWN" } }, notFound: TEAM_NOT_FOUND_TEXT, extraNotFound: [],
  },
];
const WITH_BODY = OPS.filter((op) => op.body !== null);
const SUBJECT_OPS = OPS.filter((op) => op.accepted.includes("gamingMemberId"));
const DECISION_OPS = OPS.filter((op) => op.accepted.includes("decision"));
const opNamed = (key: StoreMethod) => OPS.find((op) => op.key === key)!;
const storeOf = (op: Op) => lifetime.store[op.key];

const load = async (op: Op) => (await import(op.route)) as RouteModule;

/** Every response a test provokes is recorded here, and afterEach insists that each of them was uncached — so "every response is uncached" holds for the whole file. */
const seen: Array<{ label: string; status: number; cache: string | null }> = [];
async function send(label: string, handler: Handler, request: Request, params?: Record<string, string>): Promise<Response> {
  const response = await handler(request, params ? { params } : undefined);
  seen.push({ label, status: response.status, cache: response.headers.get("cache-control") });
  return response;
}

interface Build { id?: string; body?: string; headers?: Record<string, string>; query?: string }
/** A POST for the operation. `body` is the raw request text (the operation's valid body when omitted; an operation that reads no body carries none). */
function build(op: Op, over: Build = {}): { request: Request; params: Record<string, string> } {
  const id = over.id ?? op.id;
  const text = over.body ?? (op.body ? JSON.stringify(op.body) : undefined);
  const headers: Record<string, string> = { authorization: "Bearer session-token", ...(text !== undefined ? { "content-type": "application/json" } : {}), ...over.headers };
  return { request: new Request(op.url(id) + (over.query ?? ""), { method: "POST", headers, body: text }), params: { [op.param]: id } };
}
async function invoke(op: Op, over: Build = {}): Promise<{ res: Response; request: Request }> {
  const { POST } = await load(op);
  const { request, params } = build(op, over);
  return { res: await send(op.label, POST!, request, params), request };
}
/** The same body with one more raw key (raw text, so that "__proto__" really is an own key of the parsed body). */
const withExtra = (op: Op, field: string, value: unknown) => `${JSON.stringify(op.body).slice(0, -1)},${JSON.stringify(field)}:${JSON.stringify(value)}}`;

const snapshot = async (res: Response) => ({ status: res.status, headers: [...res.headers.entries()].sort(([a], [b]) => a.localeCompare(b)), text: await res.text() });

/** A body is bounded when it is exactly {error} with plain English: no internal code token, no database word, no stack. */
const TOKEN_LIKE = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/;
const DATABASE_WORDS = /relation|violates|constraint|duplicate key|sqlstate|postgres|supabase|\bP0001\b|\blifetime_|\bpg_|\bat\s+\S+\s+\(|service[_ -]?role|apikey/i;
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
describe("B1, B2 — the availability guard runs before credentials, authentication, parsing and repository construction; then credentials, authentication, the body, the repository, the store", () => {
  const VALUES: Array<string | undefined> = [undefined, "", "false", "TRUE", "True", "1", "yes", " true", "true ", "null"];

  it.each(VALUES)("B1: with COMPETITIONS_SCHEMA_READY=%j every one of the seven surfaces answers the bounded 503 and touches nothing", async (value) => {
    if (value === undefined) delete process.env.COMPETITIONS_SCHEMA_READY;
    else process.env.COMPETITIONS_SCHEMA_READY = value;
    for (const op of OPS) {
      vi.clearAllMocks();
      lifetime.constructed.length = 0;
      const { res, request } = await invoke(op, { body: "not json {{{" });
      expect(res.status, op.label).toBe(503);
      expect(await res.json(), op.label).toEqual({ error: UNAVAILABLE_503 });
      expect(httpAuth.getSupabaseCredentials, `${op.label}: credentials must not be read`).not.toHaveBeenCalled();
      expect(httpAuth.requireGamingMember, `${op.label}: must not authenticate`).not.toHaveBeenCalled();
      expect(request.bodyUsed, `${op.label}: must not parse the body`).toBe(false);
      expect(lifetime.constructed, `${op.label}: must not construct the repository`).toHaveLength(0);
      expect(anyStoreCalled(), `${op.label}: must not reach the store`).toBe(false);
    }
  });

  it.each(OPS)("B2: $label — with the capability on the order is credentials, authentication (before the body is read), the repository, then the store", async (op) => {
    storeOf(op).mockResolvedValue(op.record);
    vi.mocked(httpAuth.getSupabaseCredentials).mockImplementation(() => { lifetime.order.push("credentials"); return CREDENTIALS; });
    vi.mocked(httpAuth.requireGamingMember).mockImplementation(async (request: Request) => { lifetime.order.push(request.bodyUsed ? "auth-after-body" : "auth"); return { gamingMemberId: SESSION }; });
    const { res } = await invoke(op);
    expect(res.status).toBe(op.status);
    expect(lifetime.order).toEqual(["credentials", "auth", "construct", "store"]);
  });

  it.each(WITH_BODY)("B2: $label — a refused body or id never constructs the repository: the order stops after authentication", async (op) => {
    await invoke(op, { body: "not json {{{" });
    await invoke(op, { body: JSON.stringify({ [op.accepted[0]]: 7 }) });
    await invoke(op, { id: "test-id" });
    expect(lifetime.constructed).toHaveLength(0);
    expect(anyStoreCalled()).toBe(false);
  });
});

// =============================================================================================================================================
describe("B3 — a signed-out caller never constructs the repository and nothing is read from the request", () => {
  it.each(OPS)("$label: 401, uncached, nothing constructed or called, the body unread (authentication comes before parsing)", async (op) => {
    signedOut();
    const { res, request } = await invoke(op, { body: "not json {{{" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: UNAUTHENTICATED_401 });
    expect(request.bodyUsed).toBe(false);
    expect(lifetime.constructed).toHaveLength(0);
    expect(anyStoreCalled()).toBe(false);
  });

  it.each(OPS)("$label: a malformed id from a signed-out caller is still a 401 — authentication comes before the id is looked at", async (op) => {
    signedOut();
    const { res } = await invoke(op, { id: "test-id" });
    expect(res.status).toBe(401);
    expect(lifetime.constructed).toHaveLength(0);
  });

  it("a missing credential is a bounded, uncached 500 that names no provider and authenticates nobody", async () => {
    vi.mocked(httpAuth.getSupabaseCredentials).mockReturnValue(null);
    for (const op of OPS) {
      const { res } = await invoke(op);
      expect(res.status, op.label).toBe(500);
      const body = await res.json();
      expect(body, op.label).toEqual({ error: GENERIC_500 });
      expectBounded(body, op.label);
    }
    expect(httpAuth.requireGamingMember).not.toHaveBeenCalled();
    expect(lifetime.constructed).toHaveLength(0);
  });
});

// =============================================================================================================================================
describe("B4, B7 — the actor is always the verified caller, the response is copied field by field", () => {
  it.each(OPS)("$label: calls the existing operation with the session member and the addressed or named values only — whatever else the request carries", async (op) => {
    storeOf(op).mockResolvedValue(op.record);
    const { res } = await invoke(op, { query: `?gamingMemberId=${OTHER}&actor=${OTHER}&captain=${OTHER}&status=ACTIVE`, headers: { "x-gaming-member-id": OTHER, "x-actor": OTHER } });
    expect(res.status).toBe(op.status);
    expect(storeOf(op)).toHaveBeenCalledTimes(1);
    expect(storeOf(op)).toHaveBeenCalledWith(...op.call);
    expect(Object.values(lifetime.store).filter((fn) => fn.mock.calls.length > 0), "exactly one store operation was called").toHaveLength(1);
    expect(httpAuth.requireGamingMember).toHaveBeenCalledTimes(1);
    expect(lifetime.constructed).toEqual([{ url: CREDENTIALS.url, key: CREDENTIALS.serviceKey }]);
    const text = await res.text();
    expect(text, "exactly the named fields, in their order — nothing else the store held").toBe(JSON.stringify(op.shape));
    expect(text).not.toContain(OTHER);
    expect(text).not.toContain(SESSION);
    expect(text).not.toContain(CREDENTIALS.serviceKey);
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
  });

  it.each(OPS)("B6: $label — the addressed id is well formed in either letter case, and the repository receives it as sent", async (op) => {
    storeOf(op).mockResolvedValue(op.record);
    const { res } = await invoke(op, { id: op.id.toUpperCase() });
    expect(res.status).toBe(op.status);
    const sent = op.call.map((value) => (value === op.id ? op.id.toUpperCase() : value));
    expect(storeOf(op)).toHaveBeenCalledWith(...sent);
  });

  it.each(SUBJECT_OPS)("B4: $label — the named member is a well-formed identifier in either letter case, passed as sent; naming oneself is the database's business, not the adapter's", async (op) => {
    storeOf(op).mockResolvedValue(op.record);
    const upper = await invoke(op, { body: JSON.stringify({ gamingMemberId: SUBJECT.toUpperCase() }) });
    expect(upper.res.status).toBe(op.status);
    expect(storeOf(op).mock.calls[0].filter((value: unknown) => typeof value === "string")).toContain(SUBJECT.toUpperCase());
    storeOf(op).mockClear();
    const self = await invoke(op, { body: JSON.stringify({ gamingMemberId: SESSION }) });
    expect(self.res.status).toBe(op.status);
    expect(storeOf(op).mock.calls[0].slice(0, 3)).toEqual([TEAM, SESSION, SESSION]);
  });

  it.each(DECISION_OPS)("B5: $label — both ACCEPT and DECLINE are accepted and passed through as the parsed decision", async (op) => {
    storeOf(op).mockResolvedValue(op.record);
    for (const decision of ["ACCEPT", "DECLINE"]) {
      storeOf(op).mockClear();
      const { res } = await invoke(op, { body: JSON.stringify({ decision }) });
      expect(res.status, decision).toBe(200);
      expect(storeOf(op)).toHaveBeenCalledWith(op.id, SESSION, decision);
    }
  });

  it("B5: withdraw — both offer kinds are accepted and passed through", async () => {
    const op = opNamed("withdrawOffer");
    storeOf(op).mockResolvedValue(op.record);
    for (const kind of ["MEMBERSHIP", "LEADERSHIP"]) {
      storeOf(op).mockClear();
      const { res } = await invoke(op, { body: JSON.stringify({ kind }) });
      expect(res.status, kind).toBe(200);
      expect(storeOf(op)).toHaveBeenCalledWith(kind, OFFER, SESSION);
    }
  });

  it("B4, B7: end membership — a named successor is passed through; the order of the two keys does not matter; the successor leadership the database answered is copied", async () => {
    const op = opNamed("endMembership");
    storeOf(op).mockResolvedValue({ ...op.record, successorLeadershipId: LEADERSHIP });
    const named = await invoke(op, { body: JSON.stringify({ gamingMemberId: SUBJECT, successorGamingMemberId: SUCCESSOR }) });
    expect(named.res.status).toBe(200);
    expect(storeOf(op)).toHaveBeenCalledWith(TEAM, SESSION, SUBJECT, SUCCESSOR);
    expect(await named.res.json()).toEqual({ membership: { lifetimeTeamMembershipId: MEMBERSHIP, endedAt: AT, successorLeadershipId: LEADERSHIP } });
    storeOf(op).mockClear();
    const reversed = await invoke(op, { body: JSON.stringify({ successorGamingMemberId: SUCCESSOR, gamingMemberId: SUBJECT }) });
    expect(reversed.res.status).toBe(200);
    expect(storeOf(op)).toHaveBeenCalledWith(TEAM, SESSION, SUBJECT, SUCCESSOR);
    storeOf(op).mockClear();
    const alone = await invoke(op, { body: JSON.stringify({ gamingMemberId: SUBJECT }) });
    expect(alone.res.status).toBe(200);
    expect(storeOf(op)).toHaveBeenCalledWith(TEAM, SESSION, SUBJECT, null);
  });

  it("B4: end leadership reads no body at all — not even a body that names somebody else as the actor", async () => {
    const op = opNamed("endLeadership");
    storeOf(op).mockResolvedValue(op.record);
    for (const body of ["not json {{{", JSON.stringify({ actorGamingMemberId: OTHER, gamingMemberId: OTHER, captainGamingMemberId: OTHER }), ""]) {
      storeOf(op).mockClear();
      const { res, request } = await invoke(op, { body });
      expect(res.status).toBe(200);
      expect(request.bodyUsed, "the body is never read").toBe(false);
      expect(storeOf(op)).toHaveBeenCalledTimes(1);
      expect(storeOf(op)).toHaveBeenCalledWith(TEAM, SESSION);
    }
  });
});

// =============================================================================================================================================
describe("B5 — the body is exactly what the route names: no extra field, no client-supplied authority, before any repository exists", () => {
  const AUTHORITY_FIELDS = [
    "actor", "actorGamingMemberId", "callerGamingMemberId", "memberGamingMemberId", "captainGamingMemberId", "captain", "leaderGamingMemberId", "subCaptainGamingMemberId", "ownerGamingMemberId",
    "initiatedByGamingMemberId", "decidedByGamingMemberId", "role", "status", "authority", "permission", "side", "initiatedBySide", "joinedAt", "startedAt", "endedAt", "expiresAt", "decidedAt",
    "membershipId", "leadershipId", "offerId", "lifetimeTeamId", "successorLeadershipId", "isLegacy", "members", "__proto__",
    "gamingMemberId", "successorGamingMemberId", "decision", "kind",
  ];
  const extrasOf = (op: Op) => AUTHORITY_FIELDS.filter((field) => !op.accepted.includes(field));

  it.each(WITH_BODY)("$label: every client-supplied field the route does not name is refused with a bounded 400 — beside the valid body, and alone", async (op) => {
    for (const field of extrasOf(op)) {
      for (const text of [withExtra(op, field, OTHER), `{${JSON.stringify(field)}:${JSON.stringify(OTHER)}}`]) {
        vi.clearAllMocks();
        lifetime.constructed.length = 0;
        const { res } = await invoke(op, { body: text });
        expect(res.status, `${field}: ${text}`).toBe(400);
        const body = await res.json();
        expect(body, field).toEqual({ error: op.sentence });
        expectBounded(body, field);
        expect(lifetime.constructed, `${field}: no repository`).toHaveLength(0);
        expect(anyStoreCalled(), `${field}: no store call`).toBe(false);
      }
    }
  });

  it("the check is exact, not a filter: end membership refuses a third key, a missing subject and a successor without the subject — and accepts only the two documented shapes", async () => {
    const op = opNamed("endMembership");
    const refused = [
      JSON.stringify({ gamingMemberId: SUBJECT, successorGamingMemberId: SUCCESSOR, actorGamingMemberId: OTHER }),
      JSON.stringify({ successorGamingMemberId: SUCCESSOR }),
      JSON.stringify({ successorGamingMemberId: SUCCESSOR, actor: OTHER }),
      JSON.stringify({ gamingMemberId: SUBJECT, successor: SUCCESSOR }),
    ];
    for (const text of refused) {
      const { res } = await invoke(op, { body: text });
      expect(res.status, text).toBe(400);
      expect(await res.json(), text).toEqual({ error: SENTENCE.endMembership });
    }
    expect(lifetime.constructed).toHaveLength(0);
    expect(anyStoreCalled()).toBe(false);
  });

  const UNPARSABLE = ["", "not json {{{", "{", "{'gamingMemberId':'x'}", "undefined", "{\"gamingMemberId\":}"];
  const WRONG_SHAPE = ["null", "[]", "true", "42", '"text"', "{}", '{"":""}', "[{}]"];
  it.each(WITH_BODY)("$label: a body that is not JSON, or not an object with exactly the named keys, is a bounded 400 before any repository exists", async (op) => {
    for (const text of UNPARSABLE) {
      const { res } = await invoke(op, { body: text });
      expect(res.status, JSON.stringify(text)).toBe(400);
      expect(await res.json(), JSON.stringify(text)).toEqual({ error: INVALID_JSON });
    }
    for (const text of WRONG_SHAPE) {
      const { res } = await invoke(op, { body: text });
      expect(res.status, text).toBe(400);
      expect(await res.json(), text).toEqual({ error: op.sentence });
    }
    expect(lifetime.constructed).toHaveLength(0);
    expect(anyStoreCalled()).toBe(false);
  });

  it("a POST with no body at all is the same bounded 400 on every operation that reads one", async () => {
    for (const op of WITH_BODY) {
      const { POST } = await load(op);
      const res = await send(op.label, POST!, new Request(op.url(op.id), { method: "POST", headers: { authorization: "Bearer session-token" } }), { [op.param]: op.id });
      expect(res.status, op.label).toBe(400);
      expect(await res.json(), op.label).toEqual({ error: INVALID_JSON });
    }
    expect(lifetime.constructed).toHaveLength(0);
  });

  const BAD_SUBJECTS: unknown[] = ["", "not-a-uuid", 123, null, [SUBJECT], {}, true, `${SUBJECT}0`, SUBJECT.slice(0, -1), ` ${SUBJECT}`, `${SUBJECT}\n`, SUBJECT.replace(/-/g, "")];
  it.each(SUBJECT_OPS)("$label: a named member that is not a well-formed identifier is a bounded 400", async (op) => {
    for (const value of BAD_SUBJECTS) {
      const { res } = await invoke(op, { body: JSON.stringify({ gamingMemberId: value }) });
      expect(res.status, JSON.stringify(value)).toBe(400);
      expect(await res.json(), JSON.stringify(value)).toEqual({ error: messageOf("INPUT_INVALID") });
    }
    expect(lifetime.constructed).toHaveLength(0);
    expect(anyStoreCalled()).toBe(false);
  });

  const BAD_SUCCESSORS: unknown[] = [null, "", "x", 5, [SUCCESSOR], {}, true, `${SUCCESSOR}0`];
  it("end membership: a successor that is null, empty or not a well-formed identifier is a bounded 400 (the absent successor is the documented default, an explicit null is not)", async () => {
    const op = opNamed("endMembership");
    for (const value of BAD_SUCCESSORS) {
      const { res } = await invoke(op, { body: JSON.stringify({ gamingMemberId: SUBJECT, successorGamingMemberId: value }) });
      expect(res.status, JSON.stringify(value)).toBe(400);
      expect(await res.json(), JSON.stringify(value)).toEqual({ error: messageOf("INPUT_INVALID") });
    }
    expect(lifetime.constructed).toHaveLength(0);
    expect(anyStoreCalled()).toBe(false);
  });

  const BAD_DECISIONS: unknown[] = ["accept", "ACCEPTED", "DECLINE ", " ACCEPT", "REJECT", "APPROVE", 1, null, true, "", ["ACCEPT"], {}];
  it.each(DECISION_OPS)("$label: only the domain's own decisions are accepted — anything else is a bounded 400", async (op) => {
    for (const value of BAD_DECISIONS) {
      const { res } = await invoke(op, { body: JSON.stringify({ decision: value }) });
      expect(res.status, JSON.stringify(value)).toBe(400);
      expect(await res.json(), JSON.stringify(value)).toEqual({ error: messageOf("DECISION_INVALID") });
    }
    expect(lifetime.constructed).toHaveLength(0);
    expect(anyStoreCalled()).toBe(false);
  });

  const BAD_KINDS: unknown[] = ["membership", "OFFER", "TEAM", "MEMBERSHIP ", 1, null, "", ["MEMBERSHIP"], {}];
  it("withdraw: only the two offer kinds are accepted — anything else is a bounded 400", async () => {
    const op = opNamed("withdrawOffer");
    for (const value of BAD_KINDS) {
      const { res } = await invoke(op, { body: JSON.stringify({ kind: value }) });
      expect(res.status, JSON.stringify(value)).toBe(400);
      expect(await res.json(), JSON.stringify(value)).toEqual({ error: messageOf("DECISION_INVALID") });
    }
    expect(lifetime.constructed).toHaveLength(0);
    expect(anyStoreCalled()).toBe(false);
  });
});

// =============================================================================================================================================
describe("B6 — a malformed addressed id is a bounded 400 after authentication, before the body is read and before any repository exists", () => {
  const BAD_IDS = ["test-id", "not-a-uuid", "0", TEAM.slice(0, -1), `${TEAM}0`, TEAM.replace(/-/g, ""), " " + TEAM, "00000000-0000-0000-0000-00000000000g", "%00"];

  it.each(OPS)("$label", async (op) => {
    for (const id of BAD_IDS) {
      const { res, request } = await invoke(op, { id });
      expect(res.status, id).toBe(400);
      const body = await res.json();
      expect(body, id).toEqual({ error: messageOf("INPUT_INVALID") });
      expectBounded(body, id);
      expect(request.bodyUsed, `${id}: the body is not read for an id that cannot name anything`).toBe(false);
    }
    expect(httpAuth.requireGamingMember).toHaveBeenCalledTimes(BAD_IDS.length);
    expect(lifetime.constructed).toHaveLength(0);
    expect(anyStoreCalled()).toBe(false);
  });

  it.each(OPS)("$label: a request that carries no addressed id at all is the same bounded 400", async (op) => {
    const { POST } = await load(op);
    // No route context at all, and a context whose params do not hold the id.
    for (const params of [undefined, {} as Record<string, string>]) {
      const res = await send(op.label, POST!, build(op).request, params);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: messageOf("INPUT_INVALID") });
    }
    expect(lifetime.constructed).toHaveLength(0);
    expect(anyStoreCalled()).toBe(false);
  });
});

// =============================================================================================================================================
describe("B8, B9 — the refusal table: one centralized, explicit, bounded, fail-closed mapping; the 'who are you to this' answers are one and the same 404", () => {
  const ALL_PROBLEMS = [...new Set([...LIFETIME_DATABASE_CODES.map(([, problem]) => problem), "INPUT_INVALID", "UNAVAILABLE"])] as LifetimeProblem[];
  // What the gate states (CFM-010 §5). Everything that is not here is a problem of ANOTHER operation (a team's own lifecycle, an entry, a claim, the freeze) or a raw
  // failure: mapping it would invent policy this gate does not own, so it fails closed as the generic 500.
  const BAD_REQUEST: LifetimeProblem[] = ["INPUT_INVALID", "DECISION_INVALID"];
  const UNIFORM_NOT_FOUND: LifetimeProblem[] = ["TEAM_NOT_FOUND", "OFFER_NOT_FOUND", "NOT_A_LEADER", "NOT_THE_CAPTAIN", "OFFER_WRONG_PARTY"];
  const CONFLICT: LifetimeProblem[] = [
    "TEAM_NOT_ACTIVE", "PERSON_NOT_FOUND", "NOT_A_MEMBER", "ALREADY_MEMBER", "OFFER_NOT_PENDING", "OFFER_EXPIRED", "OFFER_ALREADY_PENDING", "MEMBERSHIP_CAP_REACHED", "REQUEST_NOT_ACCEPTABLE",
    "LEADER_CANNOT_JOIN_OTHER_TEAM", "LEADER_MUST_BELONG_TO_ONE_TEAM", "LEADER_CANNOT_BE_REMOVED", "CAPTAIN_NEEDS_SUCCESSOR", "SUCCESSOR_INVALID", "SEAT_TAKEN", "SEAT_EMPTY", "SEAT_SUBJECT_INVALID",
    "TEAM_HAS_LIVE_ENTRIES", "INVARIANT_VIOLATION", "CONCURRENT_CHANGE",
  ];
  const expected = (op: Op, code: LifetimeProblem): { status: number; body: { error: string } } => {
    if (UNIFORM_NOT_FOUND.includes(code) || op.extraNotFound.includes(code)) return { status: 404, body: { error: op.notFound } };
    if (BAD_REQUEST.includes(code)) return { status: 400, body: { error: messageOf(code) } };
    if (CONFLICT.includes(code)) return { status: 409, body: { error: messageOf(code) } };
    return { status: 500, body: { error: GENERIC_500 } };
  };

  it("covers every problem the foundation can raise", () => {
    expect(ALL_PROBLEMS.length).toBeGreaterThan(60);
    for (const code of [...BAD_REQUEST, ...UNIFORM_NOT_FOUND, ...CONFLICT]) expect(ALL_PROBLEMS, code).toContain(code);
    expect(new Set([...BAD_REQUEST, ...UNIFORM_NOT_FOUND, ...CONFLICT]).size, "a problem belongs to exactly one class").toBe(BAD_REQUEST.length + UNIFORM_NOT_FOUND.length + CONFLICT.length);
  });

  describe.each(OPS)("$label", (op) => {
    it.each(ALL_PROBLEMS)("%s", async (code) => {
      storeOf(op).mockRejectedValue(new LifetimeTeamError(code));
      const { res } = await invoke(op);
      const want = expected(op, code);
      expect(res.status).toBe(want.status);
      const body = await res.json();
      expect(body).toEqual(want.body);
      expectBounded(body, code);
    });
  });

  it.each(OPS)("B9: $label — unknown, not-yours and every other 'who are you to this' answer are ONE response: same status, same headers, same bytes", async (op) => {
    const causes = [...UNIFORM_NOT_FOUND, ...op.extraNotFound];
    const snaps: Array<{ code: string; snap: Awaited<ReturnType<typeof snapshot>> }> = [];
    for (const code of causes) {
      storeOf(op).mockRejectedValue(new LifetimeTeamError(code));
      const { res } = await invoke(op);
      snaps.push({ code, snap: await snapshot(res) });
    }
    expect(snaps[0].snap.status).toBe(404);
    expect(JSON.parse(snaps[0].snap.text)).toEqual({ error: op.notFound });
    expect(snaps[0].snap.headers).toContainEqual(["cache-control", NO_STORE]);
    for (const { code, snap } of snaps) expect(snap, code).toEqual(snaps[0].snap);
  });

  it("B9: a wrong party is never a 403 and never a 409 — it is the 404 of an offer that does not exist", async () => {
    for (const key of ["decideMembership", "withdrawOffer", "decideLeadership"] as const) {
      const op = opNamed(key);
      storeOf(op).mockRejectedValue(new LifetimeTeamError("OFFER_WRONG_PARTY"));
      const wrong = await snapshot((await invoke(op)).res);
      storeOf(op).mockRejectedValue(new LifetimeTeamError("OFFER_NOT_FOUND"));
      const unknown = await snapshot((await invoke(op)).res);
      expect(wrong.status, op.label).toBe(404);
      expect(wrong, op.label).toEqual(unknown);
    }
    for (const key of ["proposeMembership", "endMembership", "endLeadership"] as const) {
      const op = opNamed(key);
      storeOf(op).mockRejectedValue(new LifetimeTeamError("NOT_A_LEADER"));
      const stranger = await snapshot((await invoke(op)).res);
      storeOf(op).mockRejectedValue(new LifetimeTeamError("TEAM_NOT_FOUND"));
      const unknown = await snapshot((await invoke(op)).res);
      expect(stranger.status, op.label).toBe(404);
      expect(stranger, op.label).toEqual(unknown);
    }
    const offer = opNamed("offerLeadership");
    storeOf(offer).mockRejectedValue(new LifetimeTeamError("NOT_THE_CAPTAIN"));
    const notCaptain = await snapshot((await invoke(offer)).res);
    storeOf(offer).mockRejectedValue(new LifetimeTeamError("TEAM_NOT_FOUND"));
    expect(notCaptain).toEqual(await snapshot((await invoke(offer)).res));
    expect(notCaptain.status).toBe(404);
  });

  it("B9: 'this person does not belong to the team' is the uniform 404 where a stranger can reach it (end membership) and a bounded 409 where only an authorized caller can (the seat offer and its answer)", async () => {
    const cases: Array<[StoreMethod, number]> = [["endMembership", 404], ["offerLeadership", 409], ["decideLeadership", 409]];
    for (const [key, status] of cases) {
      const op = opNamed(key);
      storeOf(op).mockRejectedValue(new LifetimeTeamError("NOT_A_MEMBER"));
      const { res } = await invoke(op);
      expect(res.status, key).toBe(status);
      expect(await res.json(), key).toEqual({ error: status === 404 ? op.notFound : messageOf("NOT_A_MEMBER") });
    }
  });

  it("the conflicts the gate names keep their bounded sentence: an answered or lapsed offer, an existing member, a pending duplicate, the cap, a taken seat, a successor, a live entry, a concurrent change", async () => {
    const named: Array<[StoreMethod, LifetimeProblem]> = [
      ["decideMembership", "OFFER_NOT_PENDING"], ["decideMembership", "OFFER_EXPIRED"], ["proposeMembership", "ALREADY_MEMBER"], ["proposeMembership", "OFFER_ALREADY_PENDING"],
      ["proposeMembership", "MEMBERSHIP_CAP_REACHED"], ["offerLeadership", "SEAT_TAKEN"], ["endMembership", "CAPTAIN_NEEDS_SUCCESSOR"], ["endMembership", "SUCCESSOR_INVALID"],
      ["endMembership", "LEADER_CANNOT_BE_REMOVED"], ["endLeadership", "SEAT_EMPTY"], ["decideLeadership", "LEADER_MUST_BELONG_TO_ONE_TEAM"], ["endMembership", "TEAM_HAS_LIVE_ENTRIES"],
      ["decideMembership", "CONCURRENT_CHANGE"], ["offerLeadership", "INVARIANT_VIOLATION"], ["decideMembership", "REQUEST_NOT_ACCEPTABLE"],
    ];
    for (const [key, code] of named) {
      const op = opNamed(key);
      storeOf(op).mockRejectedValue(new LifetimeTeamError(code));
      const { res } = await invoke(op);
      expect(res.status, `${key} ${code}`).toBe(409);
      expect(await res.json(), `${key} ${code}`).toEqual({ error: messageOf(code) });
    }
  });

  // The refusals as the database writes them, through the REAL translator the repository uses — so the chain "database text → typed refusal → HTTP" is proved end to end
  // without a database.
  const DATABASE_TEXT: Array<[StoreMethod, string, number]> = [
    ["proposeMembership", "LIFETIME_TEAM_NOT_FOUND: no such team exists", 404],
    ["proposeMembership", "LIFETIME_NOT_A_LEADER: only a captain or sub-captain can do this", 404],
    ["proposeMembership", "LIFETIME_TEAM_NOT_ACTIVE: this team has been disbanded", 409],
    ["proposeMembership", "LIFETIME_PERSON_NOT_FOUND: no such member exists", 409],
    ["proposeMembership", "LIFETIME_ALREADY_MEMBER: this person already belongs to the team", 409],
    ["proposeMembership", "LIFETIME_LEADER_CANNOT_JOIN_OTHER_TEAM: a captain or sub-captain belongs to one team only", 409],
    ["proposeMembership", "LIFETIME_MEMBERSHIP_CAP_REACHED: a person may belong to at most two teams at once", 409],
    ["proposeMembership", "LIFETIME_OFFER_ALREADY_PENDING: an offer for this person and team is already waiting for an answer", 409],
    ["decideMembership", "LIFETIME_OFFER_NOT_FOUND: no such offer exists", 404],
    ["decideMembership", "LIFETIME_OFFER_WRONG_PARTY: only the other side of this offer can answer it", 404],
    ["decideMembership", "LIFETIME_OFFER_NOT_PENDING: this offer has already been answered or withdrawn", 409],
    ["decideMembership", "LIFETIME_OFFER_EXPIRED: this offer has lapsed", 409],
    ["decideMembership", "LIFETIME_REQUEST_NOT_ACCEPTABLE: this request cannot be accepted", 409],
    ["decideMembership", "LIFETIME_DECISION_INVALID: the decision must be ACCEPT or DECLINE", 400],
    ["withdrawOffer", "LIFETIME_OFFER_NOT_FOUND: no such offer exists", 404],
    ["withdrawOffer", "LIFETIME_OFFER_WRONG_PARTY: only the side that made this offer can withdraw it", 404],
    ["withdrawOffer", "LIFETIME_OFFER_NOT_PENDING: this offer has already been answered or withdrawn", 409],
    ["endMembership", "LIFETIME_NOT_A_LEADER: only a captain or sub-captain can do this", 404],
    ["endMembership", "LIFETIME_NOT_A_MEMBER: this person does not belong to the team", 404],
    ["endMembership", "LIFETIME_LEADER_CANNOT_BE_REMOVED: a captain or sub-captain leaves only by handing over", 409],
    ["endMembership", "LIFETIME_CAPTAIN_NEEDS_SUCCESSOR: a captain who leaves must first have a sub-captain to succeed them", 409],
    ["endMembership", "LIFETIME_SUCCESSOR_INVALID: the successor must be the sub-captain", 409],
    ["endMembership", "LIFETIME_CONCURRENT_CHANGE: the sub-captain changed while this was being processed; try again", 409],
    ["offerLeadership", "LIFETIME_NOT_THE_CAPTAIN: only the captain can do this", 404],
    ["offerLeadership", "LIFETIME_SEAT_SUBJECT_INVALID: the captain cannot also hold the sub-captain seat", 409],
    ["offerLeadership", "LIFETIME_NOT_A_MEMBER: only an active member of the team can be offered the seat", 409],
    ["offerLeadership", "LIFETIME_SEAT_TAKEN: the sub-captain seat is taken or already offered", 409],
    ["decideLeadership", "LIFETIME_OFFER_WRONG_PARTY: only the person offered the seat can answer it", 404],
    ["decideLeadership", "LIFETIME_LEADER_MUST_BELONG_TO_ONE_TEAM: leave your other teams before taking a seat", 409],
    ["decideLeadership", "LIFETIME_NOT_A_MEMBER: only an active member of the team can take the seat", 409],
    ["endLeadership", "LIFETIME_NOT_A_LEADER: only a captain or sub-captain can do this", 404],
    ["endLeadership", "LIFETIME_SEAT_EMPTY: there is no sub-captain to remove", 409],
    // a guard raised while the database settled the change, and refusals that belong to other operations: the first is a conflict, the rest are not this gate's to classify
    ["decideMembership", "LIFETIME_INVARIANT_VIOLATION: a membership record moves forward only", 409],
    ["endMembership", "LIFETIME_ENTRIES_FROZEN: the entries of this competition are frozen and can no longer change", 500],
    ["endMembership", "LIFETIME_ENTRY_NOT_LIVE: this entry has been withdrawn", 500],
    ["proposeMembership", "SOMETHING_NEW: surprising", 500],
    ["proposeMembership", "LIFETIME_TEAM_DORMANT: a team needs at least two members to enter a competition", 500],
  ];
  it.each(DATABASE_TEXT)("%s: the database says %j → HTTP %i", async (key, message, status) => {
    const op = opNamed(key);
    storeOf(op).mockRejectedValue(translateLifetimeError({ code: "P0001", message }));
    const { res } = await invoke(op);
    expect(res.status).toBe(status);
    const body = await res.json();
    expectBounded(body);
    if (status === 404) expect(body).toEqual({ error: op.notFound });
  });

  const RAW_DATABASE: Array<[string, { code: string; message: string }]> = [
    ["a raw unique violation", { code: "23505", message: 'duplicate key value violates unique constraint "lifetime_team_memberships_one_active"' }],
    ["a missing relation", { code: "42P01", message: 'relation "lifetime_team_memberships" does not exist' }],
    ["a permission failure", { code: "42501", message: "permission denied for function propose_lifetime_team_membership_atomically" }],
    ["an internal failure", { code: "XX000", message: "internal error in end_lifetime_team_membership_atomically" }],
    ["a shared competitions refusal", { code: "P0001", message: "COMPETITION_ACCESS_DENIED: not allowed" }],
  ];
  it.each(OPS.flatMap((op) => RAW_DATABASE.map(([label, error]) => [op.key, label, error] as const)))("%s: %s is the generic bounded 500", async (key, _label, error) => {
    const op = opNamed(key);
    storeOf(op).mockRejectedValue(translateLifetimeError(error));
    const { res } = await invoke(op);
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: GENERIC_500 });
  });
});

// =============================================================================================================================================
describe("B10 — raw failures never escape: not in a response, not in a log line", () => {
  const RAW: Array<[string, unknown]> = [
    ["a raw Error with SQL text", new Error('relation "lifetime_team_memberships" does not exist')],
    ["a PostgREST-shaped object", { code: "23505", message: 'duplicate key value violates unique constraint "lifetime_team_memberships_one_active"', details: "Key (gaming_member_id)=(x) already exists." }],
    ["a string", "LIFETIME_TEAM_NOT_FOUND: no such team exists"],
    ["null", null],
    ["undefined", undefined],
    ["a TypeError", new TypeError("Cannot read properties of undefined (reading 'rpc')")],
    ["a shared Competitions refusal", new CompetitionAccessDeniedError()],
    ["an error with a hostile code property", Object.assign(new Error("boom"), { code: "SELECT * FROM auth.users" })],
    ["the foundation's own UNAVAILABLE", new LifetimeTeamError("UNAVAILABLE")],
  ];
  const FRAGMENTS = ["lifetime_team", "duplicate key", "Key (gaming", "rpc", "auth.users", "boom", "LIFETIME_TEAM_NOT_FOUND", "relation", "Access denied", "SELECT", "COMPETITION_ACCESS"];

  it.each(RAW)("%s becomes the generic bounded 500 on every surface, and the log carries no raw text", async (_label, failure) => {
    for (const mode of ["rejects", "throws"] as const) {
      const fail = mode === "rejects" ? () => Promise.reject(failure) : () => { throw failure; };
      for (const op of OPS) {
        storeOf(op).mockImplementation(fail);
        const { res } = await invoke(op);
        expect(res.status, `${op.label} ${mode}`).toBe(500);
        expect(await res.json(), `${op.label} ${mode}`).toEqual({ error: GENERIC_500 });
      }
    }
    const logged = JSON.stringify(consoleError.mock.calls);
    for (const fragment of FRAGMENTS) expect(logged, `the log must not carry ${fragment}`).not.toContain(fragment);
    expect(consoleError).toHaveBeenCalled();
  });

  it("a refusal the caller is meant to see is not logged as a failure", async () => {
    for (const [key, code] of [["decideMembership", "OFFER_EXPIRED"], ["proposeMembership", "ALREADY_MEMBER"], ["decideLeadership", "OFFER_WRONG_PARTY"]] as const) {
      const op = opNamed(key);
      storeOf(op).mockRejectedValue(new LifetimeTeamError(code));
      await invoke(op);
    }
    expect(consoleError).not.toHaveBeenCalled();
  });

  it("an unexpected record (a store that answers nothing) is a bounded 500, never a guess", async () => {
    for (const op of OPS) {
      storeOf(op).mockResolvedValue(undefined);
      const { res } = await invoke(op);
      expect(res.status, op.label).toBe(500);
      expect(await res.json(), op.label).toEqual({ error: GENERIC_500 });
    }
  });
});

// =============================================================================================================================================
describe("B11 — every response is uncached (the whole file also enforces this in afterEach)", () => {
  it("each class of response — 201, 200, 400, 401, 404, 409, 500, 503 — carries Cache-Control: no-store, max-age=0", async () => {
    const results: Record<string, number> = {};
    const record = async (label: string, op: Op, over: Build = {}) => {
      const { res } = await invoke(op, over);
      results[label] = res.status;
      expect(res.headers.get("cache-control"), label).toBe(NO_STORE);
    };
    for (const op of OPS) storeOf(op).mockResolvedValue(op.record);
    await record("201", opNamed("proposeMembership"));
    await record("200", opNamed("decideMembership"));
    await record("400", opNamed("withdrawOffer"), { body: "{" });
    storeOf(opNamed("endLeadership")).mockRejectedValue(new LifetimeTeamError("NOT_A_LEADER"));
    await record("404", opNamed("endLeadership"));
    storeOf(opNamed("offerLeadership")).mockRejectedValue(new LifetimeTeamError("SEAT_TAKEN"));
    await record("409", opNamed("offerLeadership"));
    storeOf(opNamed("endMembership")).mockRejectedValue(new Error("raw"));
    await record("500", opNamed("endMembership"));
    signedOut();
    await record("401", opNamed("decideLeadership"));
    delete process.env.COMPETITIONS_SCHEMA_READY;
    await record("503", opNamed("proposeMembership"));
    expect(results).toEqual({ "201": 201, "200": 200, "400": 400, "404": 404, "409": 409, "500": 500, "401": 401, "503": 503 });
  });
});

// =============================================================================================================================================
describe("B12 — the existing routes are unchanged, and the new surface is exactly seven POST handlers that reach nothing but the bounded adapter", () => {
  const findRouteFiles = (dir: string): string[] => readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? findRouteFiles(full) : entry === "route.ts" ? [full] : [];
  });
  const unix = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");
  const OWN = OPS.map((op) => unix(path.join(ROOT, "__tests__", op.route + ".ts")));

  it("the seven routes are exactly the seven named in the gate", () => {
    expect([...OWN].sort()).toEqual([
      "app/api/gaming/competitions/lifetime-leaderships/[leadershipId]/decision/route.ts",
      "app/api/gaming/competitions/lifetime-memberships/[membershipId]/decision/route.ts",
      "app/api/gaming/competitions/lifetime-offers/[offerId]/withdraw/route.ts",
      "app/api/gaming/competitions/lifetime-teams/[lifetimeTeamId]/leadership-offers/route.ts",
      "app/api/gaming/competitions/lifetime-teams/[lifetimeTeamId]/leadership/end/route.ts",
      "app/api/gaming/competitions/lifetime-teams/[lifetimeTeamId]/memberships/end/route.ts",
      "app/api/gaming/competitions/lifetime-teams/[lifetimeTeamId]/memberships/route.ts",
    ]);
    for (const file of OWN) expect(statSync(path.join(ROOT, file)).isFile(), file).toBe(true);
  });

  it.each(OPS)("$label: the route exports exactly POST — no lookup, no other verb, no cache directive", async (op) => {
    const route = await load(op);
    expect(Object.keys(route)).toEqual(["POST"]);
  });

  it("no pre-existing route file mentions the membership adapter, the foundation or the new surface", () => {
    const own = new Set(OWN);
    const others = findRouteFiles(path.join(ROOT, "app", "api")).map(unix).filter((f) => !own.has(f));
    expect(others.length).toBeGreaterThan(100);
    expect(others.filter((f) => /lifetimeMembershipHttp|lifetime-memberships|lifetime-offers|lifetime-leaderships|SupabaseLifetime/.test(readFileSync(path.join(ROOT, f), "utf8")))).toEqual([]);
  });

  it("the seven routes import nothing but the adapter and call exactly one of its handlers each", () => {
    for (const file of OWN) {
      const code = readFileSync(path.join(ROOT, file), "utf8");
      expect([...code.matchAll(/^\s*import\b[^;]*from\s+["']([^"']+)["']/gm)].map((m) => m[1]), file).toEqual(["@/lib/gaming/competitions/lifetimeMembershipHttp"]);
      expect(code.match(/\bhandle[A-Z]\w*\(/g) ?? [], file).toHaveLength(1);
    }
  });
});
