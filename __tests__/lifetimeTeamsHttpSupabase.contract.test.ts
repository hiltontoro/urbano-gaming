import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadEnv } from "vite";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";

import { GET as listRoute, POST as createRoute } from "../app/api/gaming/competitions/lifetime-teams/route";
import { POST as disbandRoute } from "../app/api/gaming/competitions/lifetime-teams/[lifetimeTeamId]/disband/route";
import { LifetimeTeamError } from "../lib/gaming/competitions/lifetimeTeams";
import { createHarness, type Person } from "./helpers/lifetimeContract";

/**
 * UG-CR-GATE-CFM-007 — the authenticated HTTP core of lifetime teams, against a real (disposable, loopback-only) Supabase: real Auth sessions, the real route handlers
 * called in-process, and the real 294-migration schema behind them.
 *
 * Proves: a normal authenticated member creates a team and becomes its captain and member under the existing database contract; the same caller lists it and nobody
 * else does; an unauthorized member cannot disband it and learns nothing about it; the captain disbands a team without live entries; a team with a live competition entry
 * cannot be disbanded; name uniqueness and malformed input stay bounded; signed-out calls are rejected; and no browser role can write the lifetime tables or call the
 * operations the routes use. Every identity is synthetic and every row is removed again by the harness.
 */

// The shared contract-test guard (UG-CR-GATE-079) runs before anything is constructed: no target that is not loopback is ever touched.
const supabaseUrl = loadEnv("development", process.cwd(), "").SUPABASE_URL;
requireLocalSupabase(supabaseUrl);
// Real people, real tokens and real teams are built per scenario: none of them is a unit test, so one explicit budget for the whole file.
vi.setConfig({ testTimeout: 90_000 });

const h = createHarness("lh");
const { rawQuery } = h;

afterAll(() => h.cleanup(), 300000);

// The in-process route handlers read these at call time: set what they need and put the process back as it was.
const ENV_KEYS = ["COMPETITIONS_SCHEMA_READY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY"] as const;
const originalEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
  process.env.COMPETITIONS_SCHEMA_READY = "true";
  process.env.SUPABASE_URL ??= h.supabaseUrl;
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= h.serviceKey;
  process.env.SUPABASE_ANON_KEY ??= h.anonKey;
});
afterAll(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Calling the real handlers
// ---------------------------------------------------------------------------------------------------------------------------------------------

const LIST_URL = "http://localhost/api/gaming/competitions/lifetime-teams";
const disbandUrl = (id: string) => `${LIST_URL}/${id}/disband`;
const NO_STORE = "no-store, max-age=0";
const UNAVAILABLE_503 = "URBANO Gaming Competitions is temporarily unavailable while its database is being prepared.";
const SUMMARY_KEYS = ["lifetimeTeamId", "publicCode", "name", "status", "joinedAt", "isLegacy", "role"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const messageOf = (code: ConstructorParameters<typeof LifetimeTeamError>[0]) => new LifetimeTeamError(code).message;
const NOT_FOUND_MESSAGE = "That team could not be found.";

interface Answer { status: number; text: string; json: any; cache: string | null; headers: Array<[string, string]> }
const log: Array<{ label: string; status: number; cache: string | null; text: string }> = [];

type Handler = (request: Request, context?: any) => Promise<Response>;
async function call(label: string, handler: Handler, method: "GET" | "POST", url: string, opts: { token?: string; authorization?: string; body?: unknown; params?: Record<string, string>; headers?: Record<string, string> } = {}): Promise<Answer> {
  const headers: Record<string, string> = { ...opts.headers };
  if (opts.token) headers.authorization = `Bearer ${opts.token}`;
  if (opts.authorization !== undefined) headers.authorization = opts.authorization;
  let body: string | undefined;
  if (opts.body !== undefined) {
    body = typeof opts.body === "string" ? opts.body : JSON.stringify(opts.body);
    headers["content-type"] = "application/json";
  }
  const response = await handler(new Request(url, { method, headers, body }), opts.params ? { params: opts.params } : undefined);
  const text = await response.text();
  let json: any = null;
  try { json = JSON.parse(text); } catch { /* not JSON: json stays null and the assertions say so */ }
  const answer: Answer = { status: response.status, text, json, cache: response.headers.get("cache-control"), headers: [...response.headers.entries()].sort(([a], [b]) => a.localeCompare(b)) };
  log.push({ label, status: answer.status, cache: answer.cache, text });
  return answer;
}

const create = (token: string | undefined, body: unknown, extra: { url?: string; headers?: Record<string, string> } = {}) =>
  call("create", createRoute, "POST", extra.url ?? LIST_URL, { token, body, headers: extra.headers });
const list = (token: string | undefined, url = LIST_URL) => call("list", listRoute, "GET", url, { token });
const disband = (token: string | undefined, teamId: string, extra: { url?: string; headers?: Record<string, string>; body?: unknown } = {}) =>
  call("disband", disbandRoute, "POST", extra.url ?? disbandUrl(teamId), { token, params: { lifetimeTeamId: teamId }, headers: extra.headers, body: extra.body });

/** A person with a genuine session. */
async function member(label: string): Promise<Person & { token: string }> {
  const person = await h.newPerson(label);
  return { ...person, token: await h.tokenFor(person) };
}

/** A team created through the real route, tracked for cleanup. */
async function teamOf(owner: { token: string }, label: string) {
  const name = h.uniqueName(label);
  const answer = await create(owner.token, { name });
  expect(answer.status, answer.text).toBe(201);
  h.trackTeam(answer.json.team.lifetimeTeamId);
  return { teamId: answer.json.team.lifetimeTeamId as string, publicCode: answer.json.team.publicCode as string, name, createdAt: answer.json.team.createdAt as string };
}

const teamRow = async (teamId: string) => (await rawQuery("select name, status, origin, public_code, created_by_gaming_member_id, disbanded_at, disbanded_by_gaming_member_id from lifetime_teams where lifetime_team_id = $1", [teamId]))[0];
const teamsOfRun = async () => (await rawQuery<{ n: number }>("select count(*)::int as n from lifetime_teams where name like '%' || $1 || '%'", [h.RUN]))[0].n;

const TOKEN_LIKE = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/;
const DATABASE_WORDS = /relation|violates|constraint|duplicate key|sqlstate|postgres|supabase|\bP0001\b|\blifetime_|\bpg_|PGRST|\bat\s+\S+\s+\(|service[_ -]?role|apikey/i;
function expectBounded(answer: Answer, label: string) {
  expect(answer.json, `${label}: ${answer.text}`).not.toBeNull();
  expect(Object.keys(answer.json), label).toEqual(["error"]);
  expect(typeof answer.json.error, label).toBe("string");
  expect(answer.json.error, label).not.toMatch(TOKEN_LIKE);
  expect(answer.json.error, label).not.toMatch(DATABASE_WORDS);
  expect(answer.cache, label).toBe(NO_STORE);
}

/** Every object key in a JSON document, at any depth. */
const allKeys = (value: unknown, found = new Set<string>()): Set<string> => {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, found));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { found.add(k); allKeys(v, found); }
  return found;
};

// =============================================================================================================================================
describe("signed-out calls", () => {
  it("are rejected on all three routes — whatever the credential — before anything is parsed or created", async () => {
    const before = await teamsOfRun();
    const credentials: Array<string | undefined> = [undefined, "Bearer", "Bearer ", "Bearer not.a.jwt", `Bearer ${h.serviceKey}`, `Bearer ${h.anonKey}`, "Basic dXNlcjpwYXNz"];
    for (const authorization of credentials) {
      const label = JSON.stringify(authorization)?.replace(/eyJ[\w.-]+/g, "<jwt>") ?? "no header";
      const answers = [
        await call("create", createRoute, "POST", LIST_URL, { authorization, body: { name: h.uniqueName("SignedOut") } }),
        await call("create (garbage body)", createRoute, "POST", LIST_URL, { authorization, body: "not json {{{" }),
        await call("list", listRoute, "GET", LIST_URL, { authorization }),
        await call("disband", disbandRoute, "POST", disbandUrl(randomUUID()), { authorization, params: { lifetimeTeamId: randomUUID() } }),
        await call("disband (malformed id)", disbandRoute, "POST", disbandUrl("test-id"), { authorization, params: { lifetimeTeamId: "test-id" } }),
      ];
      for (const answer of answers) {
        expect(answer.status, `${label}: ${answer.text}`).toBe(401);
        expectBounded(answer, label);
      }
    }
    expect(await teamsOfRun(), "no team was created by a signed-out call").toBe(before);
  });
});

// =============================================================================================================================================
describe("create, list and the database contract", () => {
  it("a normal authenticated member creates a team: 201 with exactly three fields, and the database makes them its captain and its member", async () => {
    const alice = await member("Alice");
    const bob = await h.newPerson("Bob");
    const name = h.uniqueName("Los Lobos");
    // Extra whitespace around and inside the name, and every way a client might try to name somebody else: the creator is the session, the name is normalized.
    const answer = await create(alice.token, { name: `  ${name.replace(" ", "   ")}  ` }, { url: `${LIST_URL}?gamingMemberId=${bob.gamingMemberId}&captain=${bob.gamingMemberId}`, headers: { "x-gaming-member-id": bob.gamingMemberId } });
    expect(answer.status, answer.text).toBe(201);
    expect(answer.cache).toBe(NO_STORE);
    expect(Object.keys(answer.json)).toEqual(["team"]);
    expect(Object.keys(answer.json.team)).toEqual(["lifetimeTeamId", "publicCode", "createdAt"]);
    expect(answer.json.team.lifetimeTeamId).toMatch(UUID);
    expect(answer.json.team.publicCode).toEqual(expect.any(String));
    expect(answer.json.team.publicCode.length).toBeGreaterThan(0);
    expect(Number.isNaN(Date.parse(answer.json.team.createdAt))).toBe(false);
    const teamId = answer.json.team.lifetimeTeamId as string;
    h.trackTeam(teamId);

    const team = await teamRow(teamId);
    expect(team.status).toBe("ACTIVE");
    expect(team.origin).toBe("NEW");
    expect(team.name, "the name is stored normalized").toBe(name);
    expect(team.public_code).toBe(answer.json.team.publicCode);
    expect(team.created_by_gaming_member_id, "the creator is the verified session, never a supplied member").toBe(alice.gamingMemberId);

    const memberships = await rawQuery("select gaming_member_id, status, initiated_by_side from lifetime_team_memberships where lifetime_team_id = $1", [teamId]);
    expect(memberships).toEqual([{ gaming_member_id: alice.gamingMemberId, status: "ACTIVE", initiated_by_side: "PERSON" }]);
    const leaderships = await rawQuery("select gaming_member_id, role, status from lifetime_team_leaderships where lifetime_team_id = $1", [teamId]);
    expect(leaderships).toEqual([{ gaming_member_id: alice.gamingMemberId, role: "CAPTAIN", status: "ACTIVE" }]);
    expect(await rawQuery("select 1 from lifetime_team_memberships where gaming_member_id = $1", [bob.gamingMemberId]), "the member named in the query, the header and nowhere else got nothing").toHaveLength(0);
  });

  it("the same caller lists that team with exactly the summary fields; another member does not receive it; no query can redirect the list", async () => {
    const alice = await member("Alice");
    const bob = await member("Bob");
    const carol = await member("Carol");
    const alices = await teamOf(alice, "Lobos");
    const bobs = await teamOf(bob, "Gatos");

    const mine = await list(alice.token);
    expect(mine.status, mine.text).toBe(200);
    expect(mine.cache).toBe(NO_STORE);
    expect(Object.keys(mine.json)).toEqual(["teams"]);
    expect(mine.json.teams).toHaveLength(1);
    expect(Object.keys(mine.json.teams[0])).toEqual(SUMMARY_KEYS);
    expect([...allKeys(mine.json)].sort(), "no member id, leader, roster, offer or entry detail at any depth").toEqual(["teams", ...SUMMARY_KEYS].sort());
    const [membership] = await rawQuery("select joined_at, is_legacy from lifetime_team_memberships where lifetime_team_id = $1 and gaming_member_id = $2", [alices.teamId, alice.gamingMemberId]);
    expect(mine.json.teams[0]).toEqual({
      lifetimeTeamId: alices.teamId, publicCode: alices.publicCode, name: alices.name, status: "ACTIVE", joinedAt: mine.json.teams[0].joinedAt, isLegacy: false, role: "CAPTAIN",
    });
    expect(Math.abs(Date.parse(mine.json.teams[0].joinedAt) - membership.joined_at.getTime())).toBeLessThanOrEqual(1);
    expect(membership.is_legacy).toBe(false);

    const bobsList = await list(bob.token);
    expect(bobsList.json.teams.map((t: any) => t.lifetimeTeamId)).toEqual([bobs.teamId]);
    expect(JSON.stringify(bobsList.json), "another member's list never carries my team").not.toContain(alices.teamId);
    expect(JSON.stringify(mine.json), "…nor mine theirs").not.toContain(bobs.teamId);

    const nobody = await list(carol.token);
    expect(nobody.status).toBe(200);
    expect(nobody.text).toBe('{"teams":[]}');

    // Nothing the request carries can change whose list it is.
    const redirected = await list(alice.token, `${LIST_URL}?gamingMemberId=${bob.gamingMemberId}&memberId=${bob.gamingMemberId}&member=${bob.gamingMemberId}`);
    expect(redirected.json.teams.map((t: any) => t.lifetimeTeamId)).toEqual([alices.teamId]);
    const redirectedBack = await list(bob.token, `${LIST_URL}?gamingMemberId=${alice.gamingMemberId}`);
    expect(redirectedBack.json.teams.map((t: any) => t.lifetimeTeamId)).toEqual([bobs.teamId]);
  });

  it("CFM-012: each listed team carries the caller's own role — CAPTAIN, SUB_CAPTAIN or MEMBER — derived from the ACTIVE seat alone: an offered, withdrawn, declined or ended seat grants nothing, and no query can claim one", async () => {
    const team = await h.buildTeam("Roles", 5, { subCaptain: false });
    const [m1, m2, m3, m4] = team.members;
    const [captain, t1, t2, t3, t4] = await Promise.all([team.captain, m1, m2, m3, m4].map(async (p) => ({ ...p, token: await h.tokenFor(p) })));
    const roleOf = async (who: { token: string }, url = LIST_URL) => {
      const answer = await list(who.token, url);
      expect(answer.status, answer.text).toBe(200);
      return answer.json.teams.map((t: any) => [t.lifetimeTeamId, t.role]);
    };
    const mine = (role: string) => [[team.teamId, role]];

    // The captain who created the team, and four ordinary members.
    expect(await roleOf(captain)).toEqual(mine("CAPTAIN"));
    for (const who of [t1, t2, t3, t4]) expect(await roleOf(who)).toEqual(mine("MEMBER"));

    // A seat that is only OFFERED grants nothing: the offered member is still a member, the captain still the captain.
    const offer = await h.one("offer_lifetime_team_leadership_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: captain.gamingMemberId, p_subject_gaming_member_id: m1.gamingMemberId });
    expect(await roleOf(t1), "a pending seat offer").toEqual(mine("MEMBER"));
    expect(await roleOf(captain)).toEqual(mine("CAPTAIN"));
    // …and a role cannot be claimed by asking for it.
    expect(await roleOf(t1, `${LIST_URL}?role=SUB_CAPTAIN&leadership=true&asRole=CAPTAIN`), "a claimed role").toEqual(mine("MEMBER"));

    // Accepted: now the seat is ACTIVE.
    await h.one("decide_lifetime_team_leadership_atomically", { p_lifetime_team_leadership_id: offer.lifetime_team_leadership_id, p_actor_gaming_member_id: m1.gamingMemberId, p_decision: "ACCEPT" });
    expect(await roleOf(t1), "an accepted seat").toEqual(mine("SUB_CAPTAIN"));
    expect(await roleOf(captain)).toEqual(mine("CAPTAIN"));
    for (const who of [t2, t3, t4]) expect(await roleOf(who), "nobody else's role moved").toEqual(mine("MEMBER"));

    // The sub-captain steps down: the seat is ENDED and grants nothing (the person is still a member).
    await h.one("end_lifetime_team_leadership_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: m1.gamingMemberId });
    expect(await roleOf(t1), "an ended seat").toEqual(mine("MEMBER"));

    // An offer that is withdrawn, and one that is declined, grant nothing either.
    const withdrawn = await h.one("offer_lifetime_team_leadership_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: captain.gamingMemberId, p_subject_gaming_member_id: m2.gamingMemberId });
    await h.one("withdraw_lifetime_team_offer_atomically", { p_offer_kind: "LEADERSHIP", p_offer_id: withdrawn.lifetime_team_leadership_id, p_actor_gaming_member_id: captain.gamingMemberId });
    expect(await roleOf(t2), "a withdrawn seat offer").toEqual(mine("MEMBER"));
    const declined = await h.one("offer_lifetime_team_leadership_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: captain.gamingMemberId, p_subject_gaming_member_id: m3.gamingMemberId });
    await h.one("decide_lifetime_team_leadership_atomically", { p_lifetime_team_leadership_id: declined.lifetime_team_leadership_id, p_actor_gaming_member_id: m3.gamingMemberId, p_decision: "DECLINE" });
    expect(await roleOf(t3), "a declined seat offer").toEqual(mine("MEMBER"));

    // The captaincy changes hands: the former captain leaves (no team left to list), the sub-captain is the captain.
    await h.makeSubCaptain(team.teamId, team.captain, m4);
    expect(await roleOf(t4)).toEqual(mine("SUB_CAPTAIN"));
    await h.one("end_lifetime_team_membership_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: captain.gamingMemberId, p_subject_gaming_member_id: captain.gamingMemberId });
    expect(await roleOf(t4), "the successor").toEqual(mine("CAPTAIN"));
    expect(await roleOf(captain), "the former captain belongs to nothing now").toEqual([]);
    for (const who of [t2, t3]) expect(await roleOf(who)).toEqual(mine("MEMBER"));
  });

  it("CFM-012: a member of two teams is judged team by team and listed in the order they joined; a leader belongs to one team only, so a seat can never appear on the other", async () => {
    const alice = await member("Alice");
    const bob = await member("Bob");
    const carol = await member("Carol");
    const lobos = await teamOf(alice, "Lobos");
    const gatos = await teamOf(bob, "Gatos");
    await h.addMember(lobos.teamId, alice, carol);
    await h.addMember(gatos.teamId, bob, carol);
    const both = await list(carol.token);
    expect(both.json.teams.map((t: any) => [t.lifetimeTeamId, t.role]), "joined first, listed first; ordinary in both").toEqual([[lobos.teamId, "MEMBER"], [gatos.teamId, "MEMBER"]]);
    // A seat needs a membership of THAT team and no other: she may be offered it, but accepting is refused while she belongs to two teams — and neither step grants a role.
    const offer = await h.one("offer_lifetime_team_leadership_atomically", { p_lifetime_team_id: lobos.teamId, p_actor_gaming_member_id: alice.gamingMemberId, p_subject_gaming_member_id: carol.gamingMemberId });
    await h.refused("decide_lifetime_team_leadership_atomically", { p_lifetime_team_leadership_id: offer.lifetime_team_leadership_id, p_actor_gaming_member_id: carol.gamingMemberId, p_decision: "ACCEPT" }, "LIFETIME_LEADER_MUST_BELONG_TO_ONE_TEAM");
    expect((await list(carol.token)).json.teams.map((t: any) => t.role), "an offered seat and a refused acceptance").toEqual(["MEMBER", "MEMBER"]);
    // She leaves one team and accepts the same, still pending, offer: only the team whose seat she holds lists her as a sub-captain.
    await h.one("end_lifetime_team_membership_atomically", { p_lifetime_team_id: gatos.teamId, p_actor_gaming_member_id: carol.gamingMemberId, p_subject_gaming_member_id: carol.gamingMemberId });
    await h.one("decide_lifetime_team_leadership_atomically", { p_lifetime_team_leadership_id: offer.lifetime_team_leadership_id, p_actor_gaming_member_id: carol.gamingMemberId, p_decision: "ACCEPT" });
    expect((await list(carol.token)).json.teams.map((t: any) => [t.lifetimeTeamId, t.role])).toEqual([[lobos.teamId, "SUB_CAPTAIN"]]);
  });

  it("keeps name uniqueness and malformed input bounded: 409 for a taken name and for a captain who already has a team, 400 for the rest — never database text", async () => {
    const alice = await member("Alice");
    const bob = await member("Bob");
    const alices = await teamOf(alice, "Lobos");

    const taken = await create(bob.token, { name: alices.name });
    expect(taken.status, taken.text).toBe(409);
    expect(taken.json).toEqual({ error: messageOf("NAME_TAKEN") });
    expectBounded(taken, "taken name");

    const second = await create(alice.token, { name: h.uniqueName("Segundo") });
    expect(second.status, second.text).toBe(409);
    expect(second.json).toEqual({ error: messageOf("LEADER_MUST_BELONG_TO_ONE_TEAM") });
    expectBounded(second, "a captain who already has a team");

    const malformed: Array<[string, unknown]> = [
      ["malformed JSON", "{"], ["not JSON at all", "not json {{{"], ["an empty body", ""], ["no name", {}], ["a numeric name", { name: 7 }], ["a null name", { name: null }],
      ["an extra field", { name: h.uniqueName("Extra"), gamingMemberId: bob.gamingMemberId }], ["a client-supplied captain", { name: h.uniqueName("Extra"), captainGamingMemberId: bob.gamingMemberId }],
      ["a client-supplied status", { name: h.uniqueName("Extra"), status: "ACTIVE" }], ["a client-supplied code", { name: h.uniqueName("Extra"), publicCode: "LT-FAKE00" }],
      ["a client-supplied timestamp", { name: h.uniqueName("Extra"), createdAt: "2020-01-01T00:00:00Z" }], ["a one-character name", { name: "A" }],
      ["a 61-character name", { name: "x".repeat(61) }], ["a control character", { name: "bad\u0007name" }], ["only spaces", { name: "     " }],
    ];
    const before = await teamsOfRun();
    for (const [label, body] of malformed) {
      const answer = await create(bob.token, body);
      expect(answer.status, `${label}: ${answer.text}`).toBe(400);
      expectBounded(answer, label);
    }
    expect(await teamsOfRun(), "no malformed request created a team").toBe(before);
    expect(await rawQuery("select 1 from lifetime_team_memberships where gaming_member_id = $1", [bob.gamingMemberId]), "the rejected member still has no team").toHaveLength(0);
  });
});

// =============================================================================================================================================
describe("disband", () => {
  it("an unauthorized member cannot disband it, and learns nothing: a non-member, a non-captain member, an unknown team and a malformed id are one and the same 404", async () => {
    const alice = await member("Alice");
    const dave = await member("Dave");
    const eve = await member("Eve");
    const alices = await teamOf(alice, "Lobos");
    await h.addMember(alices.teamId, alice, dave);

    const snapshot = (a: Answer) => ({ status: a.status, headers: a.headers, text: a.text });
    const baseline = snapshot(await disband(alice.token, randomUUID()));
    expect(baseline.status).toBe(404);
    expect(JSON.parse(baseline.text)).toEqual({ error: NOT_FOUND_MESSAGE });
    expect(baseline.headers).toContainEqual(["cache-control", NO_STORE]);

    expect(snapshot(await disband(eve.token, alices.teamId)), "a stranger").toEqual(baseline);
    expect(snapshot(await disband(dave.token, alices.teamId)), "a member who is not the captain").toEqual(baseline);
    expect(snapshot(await disband(alice.token, "test-id")), "a malformed id").toEqual(baseline);
    expect(snapshot(await disband(alice.token, alices.teamId.slice(0, -1))), "a truncated id").toEqual(baseline);
    expect(snapshot(await disband(eve.token, alices.teamId.toUpperCase())), "a stranger, upper-case id").toEqual(baseline);
    // A stranger who names the captain as the actor — in the query, a header and a body — is still the stranger: the actor is the session and nothing else.
    const forged = await disband(eve.token, alices.teamId, {
      url: `${disbandUrl(alices.teamId)}?actor=${alice.gamingMemberId}&gamingMemberId=${alice.gamingMemberId}`, headers: { "x-gaming-member-id": alice.gamingMemberId },
      body: { gamingMemberId: alice.gamingMemberId, actor: alice.gamingMemberId, captainGamingMemberId: alice.gamingMemberId },
    });
    expect(snapshot(forged), "a stranger naming the captain as the actor").toEqual(baseline);

    const unauthenticated = await disband(undefined, alices.teamId);
    expect(unauthenticated.status).toBe(401);

    // Nothing changed: the team is active, the captain still leads it and both people still belong.
    const team = await teamRow(alices.teamId);
    expect(team.status).toBe("ACTIVE");
    expect(team.disbanded_at).toBeNull();
    expect(await rawQuery("select gaming_member_id, role from lifetime_team_leaderships where lifetime_team_id = $1 and status = 'ACTIVE'", [alices.teamId])).toEqual([{ gaming_member_id: alice.gamingMemberId, role: "CAPTAIN" }]);
    expect(await rawQuery("select count(*)::int as n from lifetime_team_memberships where lifetime_team_id = $1 and status = 'ACTIVE'", [alices.teamId])).toEqual([{ n: 2 }]);
  });

  it("the captain disbands a team without live entries: 200 with exactly three fields, it leaves every list, a repeat is the uniform 404, and its name is free again", async () => {
    const alice = await member("Alice");
    const dave = await member("Dave");
    const alices = await teamOf(alice, "Lobos");
    await h.addMember(alices.teamId, alice, dave);
    const unknown = await disband(alice.token, randomUUID());

    const answer = await disband(alice.token, alices.teamId, { url: `${disbandUrl(alices.teamId)}?actor=${dave.gamingMemberId}&gamingMemberId=${dave.gamingMemberId}`, headers: { "x-gaming-member-id": dave.gamingMemberId }, body: { gamingMemberId: dave.gamingMemberId, actor: dave.gamingMemberId } });
    expect(answer.status, answer.text).toBe(200);
    expect(answer.cache).toBe(NO_STORE);
    expect(Object.keys(answer.json)).toEqual(["team"]);
    expect(Object.keys(answer.json.team)).toEqual(["lifetimeTeamId", "status", "disbandedAt"]);
    expect(answer.json.team.lifetimeTeamId).toBe(alices.teamId);
    expect(answer.json.team.status).toBe("DISBANDED");
    expect(Number.isNaN(Date.parse(answer.json.team.disbandedAt))).toBe(false);

    const team = await teamRow(alices.teamId);
    expect(team.status).toBe("DISBANDED");
    expect(team.disbanded_by_gaming_member_id, "the actor is the verified session, not a member named in the query").toBe(alice.gamingMemberId);
    expect(await rawQuery("select status, end_reason from lifetime_team_memberships where lifetime_team_id = $1 order by seq", [alices.teamId])).toEqual([
      { status: "ENDED", end_reason: "TEAM_DISBANDED" }, { status: "ENDED", end_reason: "TEAM_DISBANDED" },
    ]);
    expect(await rawQuery("select status from lifetime_team_leaderships where lifetime_team_id = $1", [alices.teamId])).toEqual([{ status: "ENDED" }]);

    expect((await list(alice.token)).text).toBe('{"teams":[]}');
    expect((await list(dave.token)).text).toBe('{"teams":[]}');

    // A disbanded team has no leaders, so a repeat is "not the captain" to the database — and the one uniform 404 to the caller.
    const repeat = await disband(alice.token, alices.teamId);
    expect({ status: repeat.status, headers: repeat.headers, text: repeat.text }).toEqual({ status: unknown.status, headers: unknown.headers, text: unknown.text });

    // Only ACTIVE names are unique, and the former captain is free to lead again.
    const again = await create(alice.token, { name: alices.name });
    expect(again.status, again.text).toBe(201);
    h.trackTeam(again.json.team.lifetimeTeamId);
  });

  it("a team with a live competition entry cannot be disbanded (409), and can once the entry is withdrawn", async () => {
    const competition = await h.setUpCompetition("Live");
    const team = await h.buildTeam("Entrants", 6);
    const captain = { ...team.captain, token: await h.tokenFor(team.captain) };
    const { entryId } = await h.enterTeam(competition, team);

    const refused = await disband(captain.token, team.teamId);
    expect(refused.status, refused.text).toBe(409);
    expect(refused.json).toEqual({ error: messageOf("TEAM_HAS_LIVE_ENTRIES") });
    expectBounded(refused, "live entries");
    expect((await teamRow(team.teamId)).status).toBe("ACTIVE");
    expect((await rawQuery("select status from competition_teams where competition_team_id = $1", [entryId]))[0].status).not.toBe("REJECTED");
    expect((await list(captain.token)).json.teams.map((t: any) => t.lifetimeTeamId)).toEqual([team.teamId]);

    await h.one("withdraw_lifetime_competition_entry_atomically", { p_competition_team_id: entryId, p_actor_gaming_member_id: team.captain.gamingMemberId });
    const allowed = await disband(captain.token, team.teamId);
    expect(allowed.status, allowed.text).toBe(200);
    expect(allowed.json.team).toEqual({ lifetimeTeamId: team.teamId, status: "DISBANDED", disbandedAt: allowed.json.team.disbandedAt });
    expect((await teamRow(team.teamId)).status).toBe("DISBANDED");
  });
});

// =============================================================================================================================================
describe("privileges and availability", () => {
  it("no browser role can write the lifetime tables or call the operations the routes use — and nothing they try changes a team", async () => {
    const alice = await member("Alice");
    const alices = await teamOf(alice, "Lobos");
    const before = { teams: await teamsOfRun(), team: await teamRow(alices.teamId) };
    const clients: Array<[string, Awaited<ReturnType<typeof h.authenticatedClient>>]> = [["anon", h.anon], ["authenticated", await h.authenticatedClient()]];
    const tables = ["lifetime_teams", "lifetime_team_memberships", "lifetime_team_leaderships", "lifetime_team_events"];
    // Well-formed requests with real column names, so the only thing that can refuse them is the privilege (a strict 42501, never an empty result or a schema error).
    const WRITES: Record<string, { insert: Record<string, unknown>; update: Record<string, unknown> }> = {
      lifetime_teams: { insert: { name: h.uniqueName("Browser"), created_by_gaming_member_id: alice.gamingMemberId }, update: { name: "hijacked" } },
      lifetime_team_memberships: { insert: { lifetime_team_id: alices.teamId, gaming_member_id: alice.gamingMemberId, status: "ACTIVE", initiated_by_side: "PERSON" }, update: { status: "ENDED" } },
      lifetime_team_leaderships: { insert: { lifetime_team_id: alices.teamId, gaming_member_id: alice.gamingMemberId, role: "CAPTAIN", status: "ACTIVE" }, update: { status: "ENDED" } },
      lifetime_team_events: { insert: { lifetime_team_id: alices.teamId, event_type: "TEAM_CREATED" }, update: { event_type: "TEAM_DISBANDED" } },
    };

    for (const [role, client] of clients) {
      for (const table of tables) {
        const write = WRITES[table];
        const inserted = await client.from(table).insert(write.insert);
        expect(inserted.error?.code, `${role} insert into ${table}: ${JSON.stringify(inserted.error)}`).toBe("42501");
        const updated = await client.from(table).update(write.update).eq("lifetime_team_id", alices.teamId).select();
        expect(updated.error?.code, `${role} update ${table}: ${JSON.stringify(updated.error)}`).toBe("42501");
        const deleted = await client.from(table).delete().eq("lifetime_team_id", alices.teamId).select();
        expect(deleted.error?.code, `${role} delete from ${table}: ${JSON.stringify(deleted.error)}`).toBe("42501");
        const read = await client.from(table).select("*").limit(1);
        expect(read.error?.code, `${role} select from ${table}: ${JSON.stringify(read.error)}`).toBe("42501");
      }
      const created = await client.rpc("create_lifetime_team_atomically", { p_creator_gaming_member_id: alice.gamingMemberId, p_name: h.uniqueName("Browser") });
      expect(created.error?.code, `${role} create operation: ${JSON.stringify(created.error)}`).toBe("42501");
      const disbanded = await client.rpc("disband_lifetime_team_atomically", { p_lifetime_team_id: alices.teamId, p_actor_gaming_member_id: alice.gamingMemberId });
      expect(disbanded.error?.code, `${role} disband operation: ${JSON.stringify(disbanded.error)}`).toBe("42501");
    }

    // The catalog says the same: only the service role may execute the operations, and no browser role holds any privilege on the tables.
    const operations = await rawQuery(
      `select p.proname, has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
              has_function_privilege('service_role', p.oid, 'execute') as service
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname in ('create_lifetime_team_atomically', 'disband_lifetime_team_atomically') order by p.proname`);
    expect(operations).toEqual([
      { proname: "create_lifetime_team_atomically", anon: false, authenticated: false, service: true },
      { proname: "disband_lifetime_team_atomically", anon: false, authenticated: false, service: true },
    ]);
    for (const table of tables) {
      for (const role of ["anon", "authenticated"]) {
        for (const privilege of ["select", "insert", "update", "delete", "truncate", "references", "trigger"]) {
          const [{ held }] = await rawQuery<{ held: boolean }>("select has_table_privilege($1, $2, $3) as held", [role, `public.${table}`, privilege]);
          expect(held, `${role} must not hold ${privilege} on ${table}`).toBe(false);
        }
      }
    }

    expect(await teamsOfRun(), "no browser attempt created a team").toBe(before.teams);
    expect(await teamRow(alices.teamId), "…or changed one").toEqual(before.team);
  });

  it("with the capability off, every route answers the bounded 503 before anything happens — even for a valid session", async () => {
    const alice = await member("Alice");
    const before = await teamsOfRun();
    process.env.COMPETITIONS_SCHEMA_READY = "false";
    try {
      const answers = [
        await create(alice.token, { name: h.uniqueName("Closed") }),
        await list(alice.token),
        await disband(alice.token, randomUUID()),
      ];
      for (const answer of answers) {
        expect(answer.status, answer.text).toBe(503);
        expect(answer.json).toEqual({ error: UNAVAILABLE_503 });
        expect(answer.cache).toBe(NO_STORE);
      }
    } finally {
      process.env.COMPETITIONS_SCHEMA_READY = "true";
    }
    expect(await teamsOfRun(), "a closed capability creates nothing").toBe(before);
  });
});

// =============================================================================================================================================
describe("every response of this file", () => {
  it("was uncached and carried no secret, no token and no database text", () => {
    expect(log.length, "the earlier scenarios must have produced their responses").toBeGreaterThan(40);
    const secrets = [h.serviceKey, h.anonKey, process.env.SUPABASE_SERVICE_ROLE_KEY ?? "", h.dbUrl];
    for (const entry of log) {
      expect(entry.cache, `${entry.label} (${entry.status}) must be uncached`).toBe(NO_STORE);
      for (const secret of secrets) if (secret) expect(entry.text, `${entry.label} must not carry a credential`).not.toContain(secret);
      expect(entry.text, `${entry.label} must not carry a token`).not.toMatch(/eyJ[\w-]{10,}\./);
      expect(entry.text, `${entry.label} must carry no database text`).not.toMatch(DATABASE_WORDS);
      expect(entry.status, `${entry.label}: a database failure must never surface as a 500 in these scenarios`).not.toBe(500);
    }
  });
});
