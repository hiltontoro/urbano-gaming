import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { afterAll, afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { NextResponse } from "next/server";

/**
 * UG-CR-GATE-CFM-007 — the authenticated HTTP core of lifetime teams: create one, list my active ones, disband one. UG-CR-GATE-CFM-007A reconciled the scope.
 *
 * These tests run the REAL route handlers, the REAL bounded adapter behind them and the REAL domain operations (createLifetimeTeam, disbandLifetimeTeam, the name and
 * identifier parsers). Exactly two things are replaced, the same two seams the existing Competitions route sweep replaces: the credentials / caller-identity helpers
 * (httpAuth — whose availability guard keeps its REAL implementation, so these tests prove the guard runs inside each real handler) and the lifetime repository, which
 * becomes a recorder so a test sees WHEN it is constructed and with WHAT it is called. The database behind the same routes is exercised in the loopback contract file.
 *
 * F1…F15 name the red-first behaviours of the gate; the 007A decisions (the uniform disband 404, PERSON_NOT_FOUND as a bounded 409, the ACTIVE-only projection) have
 * their own blocks.
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
  create: vi.fn(),
  disband: vi.fn(),
  list: vi.fn(),
}));

vi.mock("@/lib/gaming/competitions/db/supabaseLifetimeTeamsRepository", async () => {
  const actual = await vi.importActual<typeof import("../lib/gaming/competitions/db/supabaseLifetimeTeamsRepository")>("../lib/gaming/competitions/db/supabaseLifetimeTeamsRepository");
  class RecordingRepository {
    constructor(url: string, key: string) {
      lifetime.constructed.push({ url, key });
      lifetime.order.push("construct");
    }
    createLifetimeTeam(...args: unknown[]) { lifetime.order.push("store"); return lifetime.create(...args); }
    disbandLifetimeTeam(...args: unknown[]) { lifetime.order.push("store"); return lifetime.disband(...args); }
    listActiveTeamsOfMember(...args: unknown[]) { lifetime.order.push("store"); return lifetime.list(...args); }
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
const TEAM_2 = "44444444-4444-4444-8444-444444444444";
const TEAM_3 = "55555555-5555-4555-8555-555555555555";
const CREATED_AT = "2026-11-23T16:00:00.000Z";
const CREDENTIALS = { url: "http://loopback.invalid", serviceKey: "service-key-not-a-secret" };
const NO_STORE = "no-store, max-age=0";
const UNAVAILABLE_503 = "URBANO Gaming Competitions is temporarily unavailable while its database is being prepared.";
const UNAUTHENTICATED_401 = "A valid Authorization header for an authenticated Gaming Member is required.";
const NOT_FOUND_MESSAGE = "That team could not be found.";
const GENERIC_500 = new LifetimeTeamError("UNAVAILABLE").message;
const messageOf = (code: LifetimeProblem) => new LifetimeTeamError(code).message;

const LIST_URL = "http://localhost/api/gaming/competitions/lifetime-teams";
const disbandUrl = (id: string) => `${LIST_URL}/${id}/disband`;
const LIST_ROUTE = "../app/api/gaming/competitions/lifetime-teams/route";
const DISBAND_ROUTE = "../app/api/gaming/competitions/lifetime-teams/[lifetimeTeamId]/disband/route";
const V1_PROPOSE_ROUTE = "../app/api/gaming/competitions/[competitionId]/teams/propose/route";

type Handler = (request: Request, context?: unknown) => Promise<Response>;
type RouteModule = Record<string, unknown> & { GET?: Handler; POST?: Handler };
const load = async (specifier: string) => (await import(specifier)) as RouteModule;

/** Every response a test provokes is recorded here, and afterEach insists that each of them was uncached — so "every response is uncached" holds for the whole file. */
const seen: Array<{ label: string; status: number; cache: string | null }> = [];
async function send(label: string, handler: Handler, request: Request, params?: Record<string, string>): Promise<Response> {
  const response = await handler(request, params ? { params } : undefined);
  seen.push({ label, status: response.status, cache: response.headers.get("cache-control") });
  return response;
}

function req(method: "GET" | "POST", url: string, init: { body?: string; headers?: Record<string, string> } = {}): Request {
  return new Request(url, { method, headers: { authorization: "Bearer session-token", ...init.headers }, body: init.body });
}
const post = (body: unknown, init: { url?: string; headers?: Record<string, string> } = {}) =>
  req("POST", init.url ?? LIST_URL, { body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json", ...init.headers } });

interface Surface { label: string; build: (body?: string) => Promise<{ handler: Handler; request: Request; params?: Record<string, string> }> }
const SURFACES: Surface[] = [
  { label: "GET list", build: async () => ({ handler: (await load(LIST_ROUTE)).GET!, request: req("GET", LIST_URL) }) },
  { label: "POST create", build: async (body = "not json {{{") => ({ handler: (await load(LIST_ROUTE)).POST!, request: post(body) }) },
  { label: "POST disband", build: async (body = "not json {{{") => ({ handler: (await load(DISBAND_ROUTE)).POST!, request: req("POST", disbandUrl(TEAM), { body }), params: { lifetimeTeamId: TEAM } }) },
];

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

const summary = (over: Record<string, unknown> = {}) => ({ lifetimeTeamId: TEAM, publicCode: "LT-AB12CD", name: "Los Lobos", status: "ACTIVE", joinedAt: "2026-11-20T10:00:00.000Z", isLegacy: false, ...over });
const SUMMARY_KEYS = ["lifetimeTeamId", "publicCode", "name", "status", "joinedAt", "isLegacy"];
const signedOut = () => vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ errorResponse: NextResponse.json({ error: UNAUTHENTICATED_401 }, { status: 401 }) });

const ORIGINAL_READY = process.env.COMPETITIONS_SCHEMA_READY;
let consoleError: MockInstance<Parameters<typeof console.error>, void>;

beforeEach(() => {
  process.env.COMPETITIONS_SCHEMA_READY = "true";
  vi.clearAllMocks();
  for (const fn of [lifetime.create, lifetime.disband, lifetime.list]) fn.mockReset();
  lifetime.constructed.length = 0;
  lifetime.order.length = 0;
  seen.length = 0;
  vi.mocked(httpAuth.getSupabaseCredentials).mockReturnValue(CREDENTIALS);
  vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ gamingMemberId: SESSION });
  consoleError = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  consoleError.mockRestore();
  // F11, for the whole file: nothing any test provoked was cacheable.
  for (const r of seen) expect(r.cache, `${r.label} (${r.status}) must be Cache-Control: ${NO_STORE}`).toBe(NO_STORE);
});

afterAll(() => {
  if (ORIGINAL_READY === undefined) delete process.env.COMPETITIONS_SCHEMA_READY;
  else process.env.COMPETITIONS_SCHEMA_READY = ORIGINAL_READY;
});

// =============================================================================================================================================
describe("F12 — the availability guard runs before credentials, authentication, parsing and repository construction", () => {
  const VALUES: Array<string | undefined> = [undefined, "", "false", "TRUE", "True", "1", "yes", " true", "true ", "null"];

  it.each(VALUES)("with COMPETITIONS_SCHEMA_READY=%j every surface answers the bounded 503 and touches nothing", async (value) => {
    if (value === undefined) delete process.env.COMPETITIONS_SCHEMA_READY;
    else process.env.COMPETITIONS_SCHEMA_READY = value;
    for (const surface of SURFACES) {
      vi.clearAllMocks();
      lifetime.constructed.length = 0;
      const { handler, request, params } = await surface.build();
      const res = await send(surface.label, handler, request, params);
      expect(res.status, surface.label).toBe(503);
      expect(await res.json(), surface.label).toEqual({ error: UNAVAILABLE_503 });
      expect(httpAuth.getSupabaseCredentials, `${surface.label}: credentials must not be read`).not.toHaveBeenCalled();
      expect(httpAuth.requireGamingMember, `${surface.label}: must not authenticate`).not.toHaveBeenCalled();
      expect(request.bodyUsed, `${surface.label}: must not parse the body`).toBe(false);
      expect(lifetime.constructed, `${surface.label}: must not construct the repository`).toHaveLength(0);
    }
  });

  it("when the capability is on, the order is: credentials, authentication (before the body is read), then the repository, then the store", async () => {
    lifetime.create.mockResolvedValue({ lifetimeTeamId: TEAM, publicCode: "LT-AB12CD", createdAt: CREATED_AT });
    vi.mocked(httpAuth.getSupabaseCredentials).mockImplementation(() => { lifetime.order.push("credentials"); return CREDENTIALS; });
    vi.mocked(httpAuth.requireGamingMember).mockImplementation(async (request: Request) => { lifetime.order.push(request.bodyUsed ? "auth-after-body" : "auth"); return { gamingMemberId: SESSION }; });
    const { POST } = await load(LIST_ROUTE);
    const res = await send("create", POST!, post({ name: "Los Lobos" }));
    expect(res.status).toBe(201);
    expect(lifetime.order).toEqual(["credentials", "auth", "construct", "store"]);
  });
});

// =============================================================================================================================================
describe("F1–F3, F11 — POST create: the creator is always the verified caller and the body is exactly {name}", () => {
  it("F1: calls the existing create operation with the session member and the normalized name, whatever else the request carries", async () => {
    lifetime.create.mockResolvedValue({ lifetimeTeamId: TEAM, publicCode: "LT-AB12CD", createdAt: CREATED_AT, captainGamingMemberId: OTHER, status: "ACTIVE" });
    const { POST } = await load(LIST_ROUTE);
    const res = await send("create", POST!, post({ name: "  Los   Lobos " }, { url: `${LIST_URL}?gamingMemberId=${OTHER}&captain=${OTHER}`, headers: { "x-gaming-member-id": OTHER } }));
    expect(res.status).toBe(201);
    expect(lifetime.create).toHaveBeenCalledTimes(1);
    expect(lifetime.create).toHaveBeenCalledWith(SESSION, "Los Lobos");
    expect(httpAuth.requireGamingMember).toHaveBeenCalledTimes(1);
    expect(lifetime.constructed).toEqual([{ url: CREDENTIALS.url, key: CREDENTIALS.serviceKey }]);
    const text = await res.text();
    expect(text).toBe(JSON.stringify({ team: { lifetimeTeamId: TEAM, publicCode: "LT-AB12CD", createdAt: CREATED_AT } }));
    expect(text).not.toContain(OTHER);
    expect(text).not.toContain(CREDENTIALS.serviceKey);
  });

  it("F1: a name is counted in characters (code points), as the database counts them: 60 emoji are 60 characters although 120 UTF-16 units; 61 are too long", async () => {
    lifetime.create.mockResolvedValue({ lifetimeTeamId: TEAM, publicCode: "LT-AB12CD", createdAt: CREATED_AT });
    const { POST } = await load(LIST_ROUTE);
    expect((await send("create", POST!, post({ name: "😀".repeat(60) }))).status).toBe(201);
    const tooLong = await send("create", POST!, post({ name: "😀".repeat(61) }));
    expect(tooLong.status).toBe(400);
    expect(await tooLong.json()).toEqual({ error: messageOf("NAME_INVALID") });
  });

  const CLIENT_SUPPLIED = ["gamingMemberId", "creatorGamingMemberId", "captainGamingMemberId", "captain", "members", "authority", "publicCode", "status", "createdAt", "lifetimeTeamId", "origin", "isLegacy", "id", "__proto__"];
  it.each(CLIENT_SUPPLIED)("F2: a client-supplied %s is refused with a bounded 400 before any repository exists", async (field) => {
    const { POST } = await load(LIST_ROUTE);
    // Raw JSON text, so that "__proto__" really is an own key of the parsed body.
    for (const text of [`{"name":"Los Lobos","${field}":${field === "members" ? JSON.stringify([OTHER]) : JSON.stringify(OTHER)}}`, `{"${field}":${JSON.stringify(OTHER)}}`]) {
      const res = await send("create", POST!, post(text));
      expect(res.status, text).toBe(400);
      expectBounded(await res.json(), text);
    }
    expect(lifetime.constructed).toHaveLength(0);
    expect(lifetime.create).not.toHaveBeenCalled();
  });

  const BAD_BODIES = [
    "", "{", "not json", "null", "[]", '["Los Lobos"]', '"Los Lobos"', "123", "true", "{}", '{"name":null}', '{"name":123}', '{"name":["x"]}', '{"name":{}}', '{"Name":"Los Lobos"}',
    '{"name":"Los Lobos",}', '{"name":"A"}', `{"name":"${"x".repeat(61)}"}`, '{"name":"bad\\u0007name"}', '{"name":"   "}',
  ];
  it.each(BAD_BODIES)("F3: the body %j fails with a bounded 400 before any repository exists", async (body) => {
    const { POST } = await load(LIST_ROUTE);
    const res = await send("create", POST!, post(body));
    expect(res.status).toBe(400);
    expectBounded(await res.json());
    expect(lifetime.constructed).toHaveLength(0);
    expect(lifetime.create).not.toHaveBeenCalled();
  });

  it("F3: an empty request body (no body at all) is the same bounded 400", async () => {
    const { POST } = await load(LIST_ROUTE);
    const res = await send("create", POST!, req("POST", LIST_URL));
    expect(res.status).toBe(400);
    expectBounded(await res.json());
    expect(lifetime.constructed).toHaveLength(0);
  });

  it("F11: the credentials missing is a bounded, uncached 500 that names no provider and authenticates nobody", async () => {
    vi.mocked(httpAuth.getSupabaseCredentials).mockReturnValue(null);
    for (const surface of SURFACES) {
      const { handler, request, params } = await surface.build('{"name":"Los Lobos"}');
      const res = await send(surface.label, handler, request, params);
      expect(res.status, surface.label).toBe(500);
      expect(await res.json(), surface.label).toEqual({ error: GENERIC_500 });
    }
    expect(httpAuth.requireGamingMember).not.toHaveBeenCalled();
    expect(lifetime.constructed).toHaveLength(0);
  });
});

// =============================================================================================================================================
describe("F4–F6 — GET list: only the session member's own active teams, exactly the summary fields", () => {
  it("F4: asks the repository for the session member and nobody else — no query, header or body can name another member", async () => {
    lifetime.list.mockResolvedValue([]);
    const { GET } = await load(LIST_ROUTE);
    const request = req("GET", `${LIST_URL}?gamingMemberId=${OTHER}&memberId=${OTHER}&member=${OTHER}&captain=${OTHER}&status=DISBANDED&limit=1`, { headers: { "x-gaming-member-id": OTHER } });
    for (const reader of ["json", "text", "formData", "arrayBuffer", "blob"] as const) vi.spyOn(request, reader);
    const res = await send("list", GET!, request);
    expect(res.status).toBe(200);
    expect(lifetime.list).toHaveBeenCalledTimes(1);
    expect(lifetime.list.mock.calls[0]).toEqual([SESSION]);
    expect(request.bodyUsed).toBe(false);
    for (const reader of ["json", "text", "formData", "arrayBuffer", "blob"] as const) expect(request[reader], reader).not.toHaveBeenCalled();
  });

  it("F5: exposes exactly the six summary fields, copied one by one — nothing else the repository holds reaches the response", async () => {
    lifetime.list.mockResolvedValue([
      { ...summary(), gamingMemberId: OTHER, email: "someone@example.com", leaders: [{ gamingMemberId: OTHER }], members: [{ gamingMemberId: OTHER }], origin: "LEGACY_BACKFILL", createdAt: CREATED_AT, disbandedAt: null, pendingOffers: [1] },
    ]);
    const { GET } = await load(LIST_ROUTE);
    const res = await send("list", GET!, req("GET", LIST_URL));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe(JSON.stringify({ teams: [summary()] }));
    expect(Object.keys(JSON.parse(text).teams[0])).toEqual(SUMMARY_KEYS);
    for (const planted of [OTHER, "someone@example.com", "LEGACY_BACKFILL", "pendingOffers", "leaders", "members"]) expect(text).not.toContain(planted);
  });

  it("F6: an empty membership is a successful {teams: []}", async () => {
    lifetime.list.mockResolvedValue([]);
    const { GET } = await load(LIST_ROUTE);
    const res = await send("list", GET!, req("GET", LIST_URL));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"teams":[]}');
  });

  it("keeps the repository's order", async () => {
    lifetime.list.mockResolvedValue([summary({ lifetimeTeamId: TEAM_3, name: "C" }), summary({ lifetimeTeamId: TEAM, name: "A" }), summary({ lifetimeTeamId: TEAM_2, name: "B" })]);
    const { GET } = await load(LIST_ROUTE);
    const body = (await (await send("list", GET!, req("GET", LIST_URL))).json()) as { teams: Array<{ name: string }> };
    expect(body.teams.map((t) => t.name)).toEqual(["C", "A", "B"]);
  });

  it("007A: only a row whose projected status is exactly ACTIVE and whose fields are well formed appears — a disbanded, malformed or unexpected row never does", async () => {
    lifetime.list.mockResolvedValue([
      summary(),
      summary({ lifetimeTeamId: TEAM_2, status: "DISBANDED" }),
      summary({ lifetimeTeamId: TEAM_3, name: "Los Gatos", isLegacy: true, joinedAt: "2026-11-21T10:00:00.123456+00:00" }),
      summary({ status: "active" }), summary({ status: "ACTIVE " }), summary({ status: undefined }), summary({ status: "PENDING" }), summary({ status: true }),
      summary({ lifetimeTeamId: "not-a-uuid" }), summary({ lifetimeTeamId: undefined }), summary({ lifetimeTeamId: 7 }),
      summary({ name: "" }), summary({ name: "   " }), summary({ name: 7 }), summary({ name: undefined }),
      summary({ publicCode: "" }), summary({ publicCode: 7 }), summary({ publicCode: undefined }),
      summary({ joinedAt: "yesterday" }), summary({ joinedAt: "undefined" }), summary({ joinedAt: undefined }), summary({ joinedAt: 1700000000000 }),
      summary({ isLegacy: "yes" }), summary({ isLegacy: undefined }), summary({ isLegacy: 1 }),
      null, undefined, "ACTIVE", 42, [], [summary()],
    ]);
    const { GET } = await load(LIST_ROUTE);
    const res = await send("list", GET!, req("GET", LIST_URL));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ teams: [summary(), summary({ lifetimeTeamId: TEAM_3, name: "Los Gatos", isLegacy: true, joinedAt: "2026-11-21T10:00:00.123456+00:00" })] });
  });

  it("007A: an answer that is not a list is a bounded 500, never a guess", async () => {
    const { GET } = await load(LIST_ROUTE);
    for (const answer of [null, undefined, {}, "teams", 3]) {
      lifetime.list.mockResolvedValue(answer);
      const res = await send("list", GET!, req("GET", LIST_URL));
      expect(res.status, JSON.stringify(answer)).toBe(500);
      expect(await res.json()).toEqual({ error: GENERIC_500 });
    }
  });
});

// =============================================================================================================================================
describe("F7–F10 — POST disband: the path team and the session actor, no body, and one uniform not-found", () => {
  it("F7: calls the existing disband operation with the path team and the session member only, reads no body, and returns exactly three fields", async () => {
    lifetime.disband.mockResolvedValue({ lifetimeTeamId: TEAM, status: "DISBANDED", disbandedAt: CREATED_AT, captainGamingMemberId: OTHER });
    const { POST } = await load(DISBAND_ROUTE);
    const request = req("POST", `${disbandUrl(TEAM)}?actor=${OTHER}&gamingMemberId=${OTHER}`, {
      body: JSON.stringify({ gamingMemberId: OTHER, actor: OTHER, status: "ACTIVE" }), headers: { "content-type": "application/json", "x-gaming-member-id": OTHER },
    });
    const res = await send("disband", POST!, request, { lifetimeTeamId: TEAM });
    expect(res.status).toBe(200);
    expect(lifetime.disband).toHaveBeenCalledTimes(1);
    expect(lifetime.disband).toHaveBeenCalledWith(TEAM, SESSION);
    expect(request.bodyUsed).toBe(false);
    const text = await res.text();
    expect(text).toBe(JSON.stringify({ team: { lifetimeTeamId: TEAM, status: "DISBANDED", disbandedAt: CREATED_AT } }));
    expect(text).not.toContain(OTHER);
  });

  it("F7: a body that is not even JSON changes nothing — it is never read", async () => {
    lifetime.disband.mockResolvedValue({ lifetimeTeamId: TEAM, status: "DISBANDED", disbandedAt: CREATED_AT });
    const { POST } = await load(DISBAND_ROUTE);
    const request = req("POST", disbandUrl(TEAM), { body: "not json {{{" });
    const res = await send("disband", POST!, request, { lifetimeTeamId: TEAM });
    expect(res.status).toBe(200);
    expect(request.bodyUsed).toBe(false);
  });

  it("F7: the team id is a well-formed UUID in either letter case — and the repository receives it as sent", async () => {
    lifetime.disband.mockResolvedValue({ lifetimeTeamId: TEAM, status: "DISBANDED", disbandedAt: CREATED_AT });
    const { POST } = await load(DISBAND_ROUTE);
    const res = await send("disband", POST!, req("POST", disbandUrl(TEAM.toUpperCase())), { lifetimeTeamId: TEAM.toUpperCase() });
    expect(res.status).toBe(200);
    expect(lifetime.disband).toHaveBeenCalledWith(TEAM.toUpperCase(), SESSION);
  });

  const MALFORMED_IDS: Array<string | undefined> = [
    "test-id", "", " ", "not-a-uuid", "3a3a3a3a-3b3b-4c3c-8d3d-3e3e3e3e3e3", "3a3a3a3a-3b3b-4c3c-8d3d-3e3e3e3e3e3e3", "3a3a3a3a-3b3b-4c3c-8d3d-3e3e3e3e3e3g", `${TEAM} `, ` ${TEAM}`,
    "../../x", "%00", "'; drop table lifetime_teams;--", "{{lifetimeTeamId}}", undefined,
  ];

  it("F8, 007A: a malformed id, an unknown team, a team the caller does not captain and a non-leader are ONE response — same status, same headers, same bytes", async () => {
    const { POST } = await load(DISBAND_ROUTE);
    const snap = async (res: Response) => ({ status: res.status, headers: [...res.headers.entries()].sort(([a], [b]) => a.localeCompare(b)), body: await res.text() });
    const answer = async (id: string | undefined) => snap(await send("disband", POST!, req("POST", disbandUrl("x")), id === undefined ? undefined : { lifetimeTeamId: id }));

    lifetime.disband.mockRejectedValue(new LifetimeTeamError("TEAM_NOT_FOUND"));
    const baseline = await answer(TEAM_2);
    expect(baseline.status).toBe(404);
    expect(JSON.parse(baseline.body)).toEqual({ error: NOT_FOUND_MESSAGE });
    expect(baseline.headers).toContainEqual(["cache-control", NO_STORE]);

    lifetime.constructed.length = 0;
    for (const id of MALFORMED_IDS) expect(await answer(id), `malformed id ${JSON.stringify(id)}`).toEqual(baseline);
    expect(lifetime.constructed, "a malformed id never reaches a repository").toHaveLength(0);

    for (const code of ["NOT_THE_CAPTAIN", "NOT_A_LEADER", "INPUT_INVALID"] as const) {
      lifetime.disband.mockRejectedValue(new LifetimeTeamError(code));
      expect(await answer(TEAM), code).toEqual(baseline);
    }
    expect(baseline.body).not.toMatch(/captain|leader|exist/i);
  });

  it("F8: a malformed id from a signed-out caller is still a 401 — authentication comes before the id is looked at", async () => {
    signedOut();
    const { POST } = await load(DISBAND_ROUTE);
    const res = await send("disband", POST!, req("POST", disbandUrl("x")), { lifetimeTeamId: "test-id" });
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: UNAUTHENTICATED_401 });
  });

  it("F9, 007A: a caller who is not the captain is refused with the uniform 404 — never a 403 that says the team exists", async () => {
    lifetime.disband.mockRejectedValue(new LifetimeTeamError("NOT_THE_CAPTAIN"));
    const { POST } = await load(DISBAND_ROUTE);
    const res = await send("disband", POST!, req("POST", disbandUrl(TEAM)), { lifetimeTeamId: TEAM });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: NOT_FOUND_MESSAGE });
    expect(lifetime.disband).toHaveBeenCalledWith(TEAM, SESSION);
  });

  it.each(["TEAM_HAS_LIVE_ENTRIES", "TEAM_NOT_ACTIVE", "CONCURRENT_CHANGE", "INVARIANT_VIOLATION"] as const)("F10: %s stays a 409 conflict with its bounded message", async (code) => {
    lifetime.disband.mockRejectedValue(new LifetimeTeamError(code));
    const { POST } = await load(DISBAND_ROUTE);
    const res = await send("disband", POST!, req("POST", disbandUrl(TEAM)), { lifetimeTeamId: TEAM });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: messageOf(code) });
  });
});

// =============================================================================================================================================
describe("F14 — a signed-out caller never constructs the lifetime repository", () => {
  it.each(SURFACES.map((s) => [s.label, s] as const))("%s: 401, uncached, nothing constructed or called, the body unread (authentication comes before parsing)", async (_label, surface) => {
    signedOut();
    const { handler, request, params } = await surface.build();
    const res = await send(surface.label, handler, request, params);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: UNAUTHENTICATED_401 });
    expect(request.bodyUsed).toBe(false);
    expect(lifetime.constructed).toHaveLength(0);
    expect(lifetime.create).not.toHaveBeenCalled();
    expect(lifetime.disband).not.toHaveBeenCalled();
    expect(lifetime.list).not.toHaveBeenCalled();
  });
});

// =============================================================================================================================================
describe("error mapping — one centralized table, explicit, bounded, fail-closed", () => {
  const ALL_PROBLEMS = [...new Set([...LIFETIME_DATABASE_CODES.map(([, problem]) => problem), "INPUT_INVALID", "UNAVAILABLE"])] as LifetimeProblem[];
  // What the gate states (CFM-007 §C and 007A §4). Everything that is not here is a problem of ANOTHER operation (an offer, a seat, an entry, a claim, the freeze):
  // mapping those would invent policy this gate does not own, so they fail closed.
  const GENERAL: Partial<Record<LifetimeProblem, number>> = {
    NAME_INVALID: 400, INPUT_INVALID: 400,
    NOT_THE_CAPTAIN: 403, NOT_A_LEADER: 403,
    TEAM_NOT_FOUND: 404,
    NAME_TAKEN: 409, PERSON_NOT_FOUND: 409, TEAM_NOT_ACTIVE: 409, TEAM_HAS_LIVE_ENTRIES: 409, LEADER_MUST_BELONG_TO_ONE_TEAM: 409, LEADER_CANNOT_JOIN_OTHER_TEAM: 409, MEMBERSHIP_CAP_REACHED: 409,
    INVARIANT_VIOLATION: 409, CONCURRENT_CHANGE: 409,
    UNAVAILABLE: 500,
  };
  // 007A §4: on the addressed disband route the three "who are you to this team" answers and a malformed id collapse into the one 404.
  const DISBAND: Partial<Record<LifetimeProblem, number>> = { ...GENERAL, TEAM_NOT_FOUND: 404, NOT_THE_CAPTAIN: 404, NOT_A_LEADER: 404, INPUT_INVALID: 404 };
  const expectedBody = (status: number, code: LifetimeProblem, collapsed: boolean) =>
    status === 500 ? { error: GENERIC_500 } : collapsed && status === 404 ? { error: NOT_FOUND_MESSAGE } : { error: code === "TEAM_NOT_FOUND" ? NOT_FOUND_MESSAGE : messageOf(code) };

  it("covers every problem the foundation can raise", () => {
    expect(ALL_PROBLEMS.length).toBeGreaterThan(60);
    for (const code of Object.keys(GENERAL)) expect(ALL_PROBLEMS, code).toContain(code);
  });

  it.each(ALL_PROBLEMS)("create: %s", async (code) => {
    lifetime.create.mockRejectedValue(new LifetimeTeamError(code));
    const { POST } = await load(LIST_ROUTE);
    const res = await send("create", POST!, post({ name: "Los Lobos" }));
    const status = GENERAL[code] ?? 500;
    expect(res.status).toBe(status);
    const body = await res.json();
    expect(body).toEqual(expectedBody(status, code, false));
    expectBounded(body, code);
  });

  it.each(ALL_PROBLEMS)("disband: %s", async (code) => {
    lifetime.disband.mockRejectedValue(new LifetimeTeamError(code));
    const { POST } = await load(DISBAND_ROUTE);
    const res = await send("disband", POST!, req("POST", disbandUrl(TEAM)), { lifetimeTeamId: TEAM });
    const status = DISBAND[code] ?? 500;
    expect(res.status).toBe(status);
    const body = await res.json();
    expect(body).toEqual(expectedBody(status, code, true));
    expectBounded(body, code);
  });

  it.each(ALL_PROBLEMS)("list: %s is a bounded failure (this operation has no refusal of its own: anything is an unavailable list)", async (code) => {
    lifetime.list.mockRejectedValue(new LifetimeTeamError(code));
    const { GET } = await load(LIST_ROUTE);
    const res = await send("list", GET!, req("GET", LIST_URL));
    expect(res.status).toBe(500);
    expect(await res.json()).toEqual({ error: GENERIC_500 });
  });

  it("007A: PERSON_NOT_FOUND after successful authentication is a bounded 409, not a 404 and not a 500", async () => {
    lifetime.create.mockRejectedValue(new LifetimeTeamError("PERSON_NOT_FOUND"));
    const { POST } = await load(LIST_ROUTE);
    const res = await send("create", POST!, post({ name: "Los Lobos" }));
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body).toEqual({ error: messageOf("PERSON_NOT_FOUND") });
    expectBounded(body);
    expect(httpAuth.requireGamingMember).toHaveBeenCalledTimes(1);
  });

  it("F10: a name that is taken, and a captain who already has a team, are 409 conflicts", async () => {
    const { POST } = await load(LIST_ROUTE);
    for (const code of ["NAME_TAKEN", "LEADER_MUST_BELONG_TO_ONE_TEAM"] as const) {
      lifetime.create.mockRejectedValue(new LifetimeTeamError(code));
      const res = await send("create", POST!, post({ name: "Los Lobos" }));
      expect(res.status, code).toBe(409);
      expect(await res.json(), code).toEqual({ error: messageOf(code) });
    }
  });

  // The refusals as the database writes them, through the REAL translator the repository uses — so the chain "database text → typed refusal → HTTP" is proved end to end
  // without a database.
  const DATABASE_TEXT: Array<[string, { code: string; message: string }, number]> = [
    ["a taken name", { code: "P0001", message: "LIFETIME_NAME_TAKEN: an active team already has this name" }, 409],
    ["a leader who must belong to one team", { code: "P0001", message: "LIFETIME_LEADER_MUST_BELONG_TO_ONE_TEAM: leave your other teams before creating one" }, 409],
    ["a missing person", { code: "P0001", message: "LIFETIME_PERSON_NOT_FOUND: no such member exists" }, 409],
    ["an invalid name", { code: "P0001", message: "LIFETIME_NAME_INVALID: a team name has 2 to 60 characters and no control characters" }, 400],
    ["an unknown coded refusal", { code: "P0001", message: "SOMETHING_NEW: surprising" }, 500],
    ["a raw unique violation", { code: "23505", message: 'duplicate key value violates unique constraint "lifetime_teams_pkey"' }, 500],
    ["a missing relation", { code: "42P01", message: 'relation "lifetime_teams" does not exist' }, 500],
    ["a permission failure", { code: "42501", message: "permission denied for function create_lifetime_team_atomically" }, 500],
  ];
  it.each(DATABASE_TEXT)("create: the database says %j → HTTP %#", async (_label, databaseError, status) => {
    lifetime.create.mockRejectedValue(translateLifetimeError(databaseError));
    const { POST } = await load(LIST_ROUTE);
    const res = await send("create", POST!, post({ name: "Los Lobos" }));
    expect(res.status).toBe(status);
    expectBounded(await res.json());
  });

  const DATABASE_TEXT_DISBAND: Array<[string, { code: string; message: string }, number]> = [
    ["no such team", { code: "P0001", message: "LIFETIME_TEAM_NOT_FOUND: no such team exists" }, 404],
    ["not the captain", { code: "P0001", message: "LIFETIME_NOT_THE_CAPTAIN: only the captain can do this" }, 404],
    ["a team that is not active", { code: "P0001", message: "LIFETIME_TEAM_NOT_ACTIVE: this team has been disbanded" }, 409],
    ["live entries", { code: "P0001", message: "LIFETIME_TEAM_HAS_LIVE_ENTRIES: withdraw the team from its competitions before disbanding it" }, 409],
    ["a raw failure", { code: "XX000", message: "internal error in disband_lifetime_team_atomically" }, 500],
  ];
  it.each(DATABASE_TEXT_DISBAND)("disband: the database says %j → HTTP %#", async (_label, databaseError, status) => {
    lifetime.disband.mockRejectedValue(translateLifetimeError(databaseError));
    const { POST } = await load(DISBAND_ROUTE);
    const res = await send("disband", POST!, req("POST", disbandUrl(TEAM)), { lifetimeTeamId: TEAM });
    expect(res.status).toBe(status);
    const body = await res.json();
    expectBounded(body);
    if (status === 404) expect(body).toEqual({ error: NOT_FOUND_MESSAGE });
  });
});

// =============================================================================================================================================
describe("F13 — raw failures never escape: not in a response, not in a log line", () => {
  const RAW: Array<[string, unknown]> = [
    ["a raw Error with SQL text", new Error('relation "lifetime_teams" does not exist')],
    ["a PostgREST-shaped object", { code: "23505", message: 'duplicate key value violates unique constraint "lifetime_teams_active_name_key"', details: "Key (name)=(Los Lobos) already exists." }],
    ["a string", "LIFETIME_TEAM_NOT_FOUND: no such team exists"],
    ["null", null],
    ["undefined", undefined],
    ["a TypeError", new TypeError("Cannot read properties of undefined (reading 'rpc')")],
    ["a shared Competitions refusal", new CompetitionAccessDeniedError()],
    ["an error with a hostile code property", Object.assign(new Error("boom"), { code: "SELECT * FROM auth.users" })],
    ["the foundation's own UNAVAILABLE", new LifetimeTeamError("UNAVAILABLE")],
  ];
  const FRAGMENTS = ["lifetime_teams", "duplicate key", "Key (name)", "rpc", "auth.users", "boom", "LIFETIME_TEAM_NOT_FOUND", "relation", "Access denied", "SELECT"];

  it.each(RAW)("%s becomes the generic bounded 500 on every surface, and the log carries no raw text", async (_label, failure) => {
    for (const mode of ["rejects", "throws"] as const) {
      const fail = mode === "rejects" ? () => Promise.reject(failure) : () => { throw failure; };
      lifetime.create.mockImplementation(fail);
      lifetime.disband.mockImplementation(fail);
      lifetime.list.mockImplementation(fail);
      for (const surface of SURFACES) {
        const { handler, request, params } = await surface.build(surface.label === "POST create" ? '{"name":"Los Lobos"}' : undefined);
        const res = await send(surface.label, handler, request, params);
        expect(res.status, `${surface.label} ${mode}`).toBe(500);
        expect(await res.json(), `${surface.label} ${mode}`).toEqual({ error: GENERIC_500 });
      }
    }
    const logged = JSON.stringify(consoleError.mock.calls);
    for (const fragment of FRAGMENTS) expect(logged, `the log must not carry ${fragment}`).not.toContain(fragment);
    expect(consoleError).toHaveBeenCalled();
  });

  it("a refusal the caller is meant to see is not logged as a failure", async () => {
    lifetime.create.mockRejectedValue(new LifetimeTeamError("NAME_TAKEN"));
    const { POST } = await load(LIST_ROUTE);
    await send("create", POST!, post({ name: "Los Lobos" }));
    expect(consoleError).not.toHaveBeenCalled();
  });
});

// =============================================================================================================================================
describe("F11 — every response is uncached (the whole file also enforces this in afterEach)", () => {
  it("each class of response — 201, 200, 400, 401, 404, 409, 500, 503 — carries Cache-Control: no-store, max-age=0", async () => {
    const list = await load(LIST_ROUTE);
    const disband = await load(DISBAND_ROUTE);
    const results: Record<string, number> = {};
    const record = async (label: string, handler: Handler, request: Request, params?: Record<string, string>) => {
      const res = await send(label, handler, request, params);
      results[label] = res.status;
      expect(res.headers.get("cache-control"), label).toBe(NO_STORE);
    };

    lifetime.create.mockResolvedValue({ lifetimeTeamId: TEAM, publicCode: "LT-AB12CD", createdAt: CREATED_AT });
    lifetime.disband.mockResolvedValue({ lifetimeTeamId: TEAM, status: "DISBANDED", disbandedAt: CREATED_AT });
    lifetime.list.mockResolvedValue([]);
    await record("201", list.POST!, post({ name: "Los Lobos" }));
    await record("200 list", list.GET!, req("GET", LIST_URL));
    await record("200 disband", disband.POST!, req("POST", disbandUrl(TEAM)), { lifetimeTeamId: TEAM });
    await record("400", list.POST!, post("{"));
    await record("404", disband.POST!, req("POST", disbandUrl("x")), { lifetimeTeamId: "x" });
    lifetime.create.mockRejectedValue(new LifetimeTeamError("NAME_TAKEN"));
    await record("409", list.POST!, post({ name: "Los Lobos" }));
    lifetime.create.mockRejectedValue(new Error("raw"));
    await record("500", list.POST!, post({ name: "Los Lobos" }));
    signedOut();
    await record("401", list.GET!, req("GET", LIST_URL));
    delete process.env.COMPETITIONS_SCHEMA_READY;
    await record("503", list.GET!, req("GET", LIST_URL));

    expect(results).toEqual({ "201": 201, "200 list": 200, "200 disband": 200, "400": 400, "404": 404, "409": 409, "500": 500, "401": 401, "503": 503 });
  });
});

// =============================================================================================================================================
describe("F15 — the existing routes and the V1 behaviour are unchanged, and the new surface is exactly three handlers", () => {
  const findRouteFiles = (dir: string): string[] => readdirSync(dir).flatMap((entry) => {
    const full = path.join(dir, entry);
    return statSync(full).isDirectory() ? findRouteFiles(full) : entry === "route.ts" ? [full] : [];
  });
  const unix = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");

  it("the V1 team-proposal route still answers as it always did and never touches the lifetime repository", async () => {
    const { POST } = await load(V1_PROPOSE_ROUTE);
    const params = { competitionId: "c-1" };
    const garbage = await POST!(new Request("http://localhost/x", { method: "POST", headers: { authorization: "Bearer t" }, body: "not json" }), { params });
    expect(garbage.status).toBe(400);
    expect(await garbage.json()).toEqual({ error: "Request body must be valid JSON." });
    const nameless = await POST!(new Request("http://localhost/x", { method: "POST", headers: { authorization: "Bearer t" }, body: "{}" }), { params });
    expect(nameless.status).toBe(400);
    expect(await nameless.json()).toEqual({ error: "A team name is required." });
    signedOut();
    const refused = await POST!(new Request("http://localhost/x", { method: "POST", headers: { authorization: "Bearer t" }, body: '{"name":"Los Lobos"}' }), { params });
    expect(refused.status).toBe(401);
    expect(lifetime.constructed).toHaveLength(0);
    delete process.env.COMPETITIONS_SCHEMA_READY;
    const closed = await POST!(new Request("http://localhost/x", { method: "POST", body: "{}" }), { params });
    expect(closed.status).toBe(503);
  });

  it("no pre-existing route file mentions the lifetime adapter or the foundation", () => {
    const own = new Set(["app/api/gaming/competitions/lifetime-teams/route.ts", "app/api/gaming/competitions/lifetime-teams/[lifetimeTeamId]/disband/route.ts"]);
    const others = findRouteFiles(path.join(ROOT, "app", "api")).map(unix).filter((f) => !own.has(f));
    expect(others.length).toBeGreaterThan(100);
    expect(others.filter((f) => /lifetimeHttp|lifetimeTeams|LifetimeTeam|SupabaseLifetime/.test(readFileSync(path.join(ROOT, f), "utf8")))).toEqual([]);
  });

  it("the new routes export exactly GET and POST (list, create) and POST (disband) — no lookup, no other verb, and the list route is never cached by the framework", async () => {
    const list = await load(LIST_ROUTE);
    const disband = await load(DISBAND_ROUTE);
    expect(Object.keys(list).sort()).toEqual(["GET", "POST", "dynamic"]);
    expect(list.dynamic).toBe("force-dynamic");
    expect(Object.keys(disband).sort()).toEqual(["POST"]);
  });
});
