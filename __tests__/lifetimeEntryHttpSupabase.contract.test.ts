import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadEnv } from "vite";
import { Client } from "pg";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";

import { POST as enableRoute } from "../app/api/gaming/competitions/[competitionId]/lifetime-entry-flow/enable/route";
import { POST as disableRoute } from "../app/api/gaming/competitions/[competitionId]/lifetime-entry-flow/disable/route";
import { GET as organizerListRoute, POST as enterRoute } from "../app/api/gaming/competitions/[competitionId]/lifetime-entries/route";
import { POST as freezeRoute } from "../app/api/gaming/competitions/[competitionId]/lifetime-entries/freeze/route";
import { POST as decideEntryRoute } from "../app/api/gaming/competitions/[competitionId]/lifetime-entries/[competitionTeamId]/decision/route";
import { POST as withdrawRoute } from "../app/api/gaming/competitions/[competitionId]/lifetime-entries/[competitionTeamId]/withdraw/route";
import { POST as proposeRoute } from "../app/api/gaming/competitions/[competitionId]/lifetime-entries/[competitionTeamId]/roster-claims/route";
import { POST as decideClaimRoute } from "../app/api/gaming/competitions/[competitionId]/lifetime-roster-claims/[claimId]/decision/route";
import { POST as releaseRoute } from "../app/api/gaming/competitions/[competitionId]/lifetime-roster-claims/[claimId]/release/route";
import { GET as leaderListRoute } from "../app/api/gaming/competitions/lifetime-entries/route";
import { GET as playerListRoute } from "../app/api/gaming/competitions/lifetime-roster-claims/route";
// the V1 routes this gate must leave exactly as they were
import { POST as v1RegisterRoute } from "../app/api/gaming/competitions/[competitionId]/register/route";
import { POST as v1ProposeTeamRoute } from "../app/api/gaming/competitions/[competitionId]/teams/propose/route";
import { GET as v1ViewRoute } from "../app/api/gaming/competitions/[competitionId]/route";
import { LifetimeTeamError } from "../lib/gaming/competitions/lifetimeTeams";
import { createHarness, type BuiltTeam, type LifetimeTestCompetition, type Person } from "./helpers/lifetimeContract";

/**
 * UG-CR-GATE-CFM-014 — the authenticated HTTP surface of a competition's lifetime-team entries, against a real (disposable, loopback-only) Supabase: real Auth sessions, the real
 * route handlers called in-process, and the real 294-migration schema behind them.
 *
 * Proves, end to end: the organizer enables the flow, teams enter, a leader proposes people, each person — and only that person — accepts, the organizer approves (and an approval
 * accepts nobody's place), a pending entry blocks the freeze until the organizer decides it, and the freeze counts what was accepted; every refusal of a stranger, of the wrong
 * team, of the wrong person and of an organizer whose hosting access was revoked is ONE uniform 404 that changes nothing; an entry or a proposal addressed through another
 * competition is the same 404; V1 competitions, routes and legacy teams are untouched; every participant finds their own records without being handed an identifier; and no
 * response says more than its bounded fields. Every identity is synthetic and every row is removed again by the harness.
 */

// The shared contract-test guard (UG-CR-GATE-079) runs before anything is constructed: no target that is not loopback is ever touched.
const supabaseUrl = loadEnv("development", process.cwd(), "").SUPABASE_URL;
requireLocalSupabase(supabaseUrl);
// Real people, real tokens, real teams and a real deadline are built per scenario: none of them is a unit test, so one explicit budget for the whole file.
vi.setConfig({ testTimeout: 300_000 });

const h = createHarness("eh");
const { rawQuery } = h;

const hostApplications: string[] = [];
afterAll(async () => {
  // One hook, in this order, because hooks of the same kind run side by side: the capability rows go first (the harness deletes them too), then the applications they point at.
  const db = new Client({ connectionString: h.dbUrl, statement_timeout: 60000 });
  try {
    await db.connect();
    await db.query("set session_replication_role = replica");
    if (hostApplications.length > 0) {
      await db.query("delete from competition_host_capabilities where host_application_id = any($1)", [hostApplications]);
      await db.query("delete from competition_host_applications where host_application_id = any($1)", [hostApplications]);
    }
  } finally {
    await db.end().catch(() => {});
  }
  await h.cleanup();
}, 300000);

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

const BASE = "http://localhost/api/gaming/competitions";
const NO_STORE = "no-store, max-age=0";
const UNAVAILABLE_503 = "URBANO Gaming Competitions is temporarily unavailable while its database is being prepared.";
const messageOf = (code: ConstructorParameters<typeof LifetimeTeamError>[0]) => new LifetimeTeamError(code).message;
const SAID = {
  competition: "That competition could not be found.",
  team: "That team could not be found.",
  entry: "That entry could not be found.",
  claim: "That roster proposal could not be found.",
  proposalIsAnswered: "A roster proposal is answered with a decision; only an accepted place is withdrawn.",
  frozen: messageOf("ENTRIES_FROZEN"),
  notEnabled: messageOf("FLOW_NOT_ENABLED"),
  registrationClosed: "Team registration is not open for this competition.",
} as const;

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

interface Extra { query?: string; headers?: Record<string, string>; authorization?: string }
type Token = string | undefined;
const at = (competitionId: string, path: string, extra: Extra = {}) => `${BASE}/${competitionId}/${path}${extra.query ?? ""}`;

// the organizer's
const enableFlow = (token: Token, c: string, x: Extra = {}) => call("enable flow", enableRoute, "POST", at(c, "lifetime-entry-flow/enable", x), { token, authorization: x.authorization, headers: x.headers, params: { competitionId: c } });
const disableFlow = (token: Token, c: string, x: Extra = {}) => call("disable flow", disableRoute, "POST", at(c, "lifetime-entry-flow/disable", x), { token, authorization: x.authorization, headers: x.headers, params: { competitionId: c } });
const freeze = (token: Token, c: string, x: Extra = {}) => call("freeze", freezeRoute, "POST", at(c, "lifetime-entries/freeze", x), { token, authorization: x.authorization, headers: x.headers, params: { competitionId: c } });
const decideEntry = (token: Token, c: string, entry: string, body: unknown, x: Extra = {}) => call("decide entry", decideEntryRoute, "POST", at(c, `lifetime-entries/${entry}/decision`, x), { token, authorization: x.authorization, headers: x.headers, body, params: { competitionId: c, competitionTeamId: entry } });
const organizerList = (token: Token, c: string, x: Extra = {}) => call("organizer list", organizerListRoute, "GET", at(c, "lifetime-entries", x), { token, authorization: x.authorization, headers: x.headers, params: { competitionId: c } });
// a leader's
const enter = (token: Token, c: string, lifetimeTeamId: unknown, x: Extra = {}) => call("enter", enterRoute, "POST", at(c, "lifetime-entries", x), { token, authorization: x.authorization, headers: x.headers, body: { lifetimeTeamId }, params: { competitionId: c } });
const withdraw = (token: Token, c: string, entry: string, x: Extra = {}) => call("withdraw", withdrawRoute, "POST", at(c, `lifetime-entries/${entry}/withdraw`, x), { token, authorization: x.authorization, headers: x.headers, params: { competitionId: c, competitionTeamId: entry } });
const propose = (token: Token, c: string, entry: string, gamingMemberIds: unknown, x: Extra = {}) => call("propose", proposeRoute, "POST", at(c, `lifetime-entries/${entry}/roster-claims`, x), { token, authorization: x.authorization, headers: x.headers, body: { gamingMemberIds }, params: { competitionId: c, competitionTeamId: entry } });
const myTeamEntries = (token: Token, x: Extra = {}) => call("leader list", leaderListRoute, "GET", `${BASE}/lifetime-entries${x.query ?? ""}`, { token, authorization: x.authorization, headers: x.headers });
// a person's
const decideClaim = (token: Token, c: string, claim: string, decision: unknown, x: Extra = {}) => call("decide claim", decideClaimRoute, "POST", at(c, `lifetime-roster-claims/${claim}/decision`, x), { token, authorization: x.authorization, headers: x.headers, body: { decision }, params: { competitionId: c, claimId: claim } });
const release = (token: Token, c: string, claim: string, x: Extra = {}) => call("release", releaseRoute, "POST", at(c, `lifetime-roster-claims/${claim}/release`, x), { token, authorization: x.authorization, headers: x.headers, params: { competitionId: c, claimId: claim } });
const myClaims = (token: Token, x: Extra = {}) => call("player list", playerListRoute, "GET", `${BASE}/lifetime-roster-claims${x.query ?? ""}`, { token, authorization: x.authorization, headers: x.headers });
// V1
const v1Register = (token: Token, c: string) => call("v1 register", v1RegisterRoute, "POST", `${BASE}/${c}/register`, { token, body: { isAdultSelfAttested: true }, params: { competitionId: c } });
const v1ProposeTeam = (token: Token, c: string, name: string) => call("v1 propose team", v1ProposeTeamRoute, "POST", `${BASE}/${c}/teams/propose`, { token, body: { name }, params: { competitionId: c } });
const v1View = (token: Token, c: string) => call("v1 view", v1ViewRoute, "GET", `${BASE}/${c}`, { token, params: { competitionId: c } });

// ---------------------------------------------------------------------------------------------------------------------------------------------
// People with genuine sessions
// ---------------------------------------------------------------------------------------------------------------------------------------------

type Member = Person & { token: string };
const everyone: Person[] = [];
const know = (...people: Person[]) => { everyone.push(...people); };
const tokens = new Map<string, string>();
/** A person with a genuine session (one sign-in per person, however often they act). */
async function asMember(person: Person): Promise<Member> {
  let token = tokens.get(person.gamingMemberId);
  if (token === undefined) {
    token = await h.tokenFor(person);
    tokens.set(person.gamingMemberId, token);
  }
  return { ...person, token };
}
async function member(label: string): Promise<Member> {
  const person = await h.newPerson(label);
  know(person);
  return asMember(person);
}
const id = (p: Person) => p.gamingMemberId;
const ids = (...people: Person[]) => people.map(id);

/** What the organizer's own operations do, called with the real database as the reference. */
const snapshot = (a: Answer) => ({ status: a.status, headers: a.headers, text: a.text });
const TOKEN_LIKE = /\b[A-Z][A-Z0-9]*_[A-Z0-9_]+\b/;
const DATABASE_WORDS = /relation|violates|constraint|duplicate key|sqlstate|postgres|supabase|\bP0001\b|\blifetime_|\bpg_|PGRST|\bat\s+\S+\s+\(|service[_ -]?role|apikey|revoked/i;
function expectBounded(answer: Answer, label: string) {
  expect(answer.json, `${label}: ${answer.text}`).not.toBeNull();
  expect(Object.keys(answer.json), label).toEqual(["error"]);
  expect(typeof answer.json.error, label).toBe("string");
  expect(answer.json.error, label).not.toMatch(TOKEN_LIKE);
  expect(answer.json.error, label).not.toMatch(DATABASE_WORDS);
  expect(answer.cache, label).toBe(NO_STORE);
}
/** An answer that is a refusal, with exactly this status and sentence. */
function expectRefusal(answer: Answer, status: number, sentence: string, label: string) {
  expect({ status: answer.status, error: answer.json?.error }, `${label}: ${answer.text}`).toEqual({ status, error: sentence });
  expectBounded(answer, label);
}
/** A V1 answer (not this gate's): only its status — the V1 routes keep the headers they always had. */
function expectV1(answer: Answer, status: number, label: string): any {
  expect(answer.status, `${label}: ${answer.text}`).toBe(status);
  return answer.json;
}
/** An answer that succeeded with exactly this status. */
function expectOk(answer: Answer, status: number, label: string): any {
  expect(answer.status, `${label}: ${answer.text}`).toBe(status);
  expect(answer.cache, label).toBe(NO_STORE);
  return answer.json;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// What the database holds, read as its owner
// ---------------------------------------------------------------------------------------------------------------------------------------------

const entryRow = async (entryId: string) => (await rawQuery("select status, decided_at, decided_by_gaming_member_id, rejection_reason from competition_teams where competition_team_id = $1", [entryId]))[0];
const claimsOf = async (entryId: string) => rawQuery("select gaming_member_id, status, release_reason from competition_lifetime_roster_claims where competition_team_id = $1 order by seq", [entryId]);
const claimRow = async (claimId: string) => (await rawQuery("select status, release_reason, accepted_at from competition_lifetime_roster_claims where competition_lifetime_roster_claim_id = $1", [claimId]))[0];
const flowOf = async (competitionId: string) => (await rawQuery("select enabled_at from competition_lifetime_flows where competition_id = $1", [competitionId]))[0] ?? null;
const freezeOf = async (competitionId: string) => (await rawQuery("select entry_count, claim_count from competition_lifetime_freezes where competition_id = $1", [competitionId]))[0] ?? null;
/** Everything the lifetime operations can change in a competition, so that "nothing changed" is a comparison and not a feeling. */
const stateOf = async (competitionId: string) => ({
  entries: await rawQuery("select competition_team_id, status, decided_by_gaming_member_id from competition_teams where competition_id = $1 order by created_at, competition_team_id", [competitionId]),
  claims: await rawQuery("select competition_lifetime_roster_claim_id, status, release_reason from competition_lifetime_roster_claims where competition_id = $1 order by seq", [competitionId]),
  flow: await flowOf(competitionId),
  freeze: await freezeOf(competitionId),
  decisions: (await rawQuery<{ n: number }>("select count(*)::int as n from competition_lifetime_entry_decisions where competition_id = $1", [competitionId]))[0].n,
  events: (await rawQuery<{ n: number }>("select count(*)::int as n from competition_lifetime_flow_events where competition_id = $1", [competitionId]))[0].n,
});

/** Records a REVOKED hosting capability for the competition as the database owner and COMMITS it: the route handlers run on their own connections. */
async function revokeHosting(competition: LifetimeTestCompetition) {
  const member = competition.organizer.gamingMemberId;
  const db = new Client({ connectionString: h.dbUrl, statement_timeout: 60000 });
  await db.connect();
  try {
    await db.query("begin");
    const application = (await db.query(
      `insert into competition_host_applications (gaming_member_id, state, venue_name, city_area, playing_fields, venue_description, expected_window, expected_team_count,
         confirm_all_adults, confirm_independent_scorekeepers, confirm_pilot_exclusions, decided_by_gaming_member_id, decided_at)
       values ($1, 'APPROVED', 'Fictional venue', 'Fictional area', 2, 'A fictional venue that exists only inside a disposable contract test.', 'a weekend', 4, true, true, true, $1, now())
       returning host_application_id`, [member])).rows[0].host_application_id as string;
    hostApplications.push(application);
    await db.query(
      `insert into competition_host_capabilities (host_application_id, gaming_member_id, state, competition_id, granted_by_gaming_member_id, consumed_at, revoked_at, revoked_by_gaming_member_id, revoke_reason)
       values ($1, $2, 'REVOKED', $3, $2, now(), now(), $2, 'Revoked by a disposable contract test.')`, [application, member, competition.competitionId]);
    await db.query("commit");
  } finally {
    await db.query("rollback").catch(() => {});
    await db.end().catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Scenario builders — everything below goes through the real routes; the harness only creates people, teams and registrations
// ---------------------------------------------------------------------------------------------------------------------------------------------

interface Standing {
  competition: LifetimeTestCompetition;
  organizer: Member;
  stranger: Member;
  A: BuiltTeam; B: BuiltTeam;
  captainA: Member; subA: Member; memberA: Member; captainB: Member;
  entryA: string; entryB: string;
}
/** A competition with the flow ENABLED THROUGH THE ROUTE, two teams of three, each entered by its captain through the route. */
async function standing(label: string, opts: { enterBoth?: boolean } = {}): Promise<Standing> {
  const competition = await h.setUpCompetition(label, { lifetimeFlow: false });
  const organizer = await asMember(competition.organizer);
  const stranger = await member(`${label} Stranger`);
  const A = await h.buildTeam(`${label}A`, 3);
  const B = await h.buildTeam(`${label}B`, 3);
  know(competition.organizer, ...A.everyone, ...B.everyone);
  const [captainA, subA, memberA, captainB] = [await asMember(A.captain), await asMember(A.subCaptain!), await asMember(A.members[0]), await asMember(B.captain)];
  expectOk(await enableFlow(organizer.token, competition.competitionId), 200, `${label}: enable`);
  await h.register(competition, A.captain, B.captain);
  const a = expectOk(await enter(captainA.token, competition.competitionId, A.teamId), 201, `${label}: A enters`);
  const entryA = a.entry.competitionTeamId as string;
  let entryB = "";
  if (opts.enterBoth !== false) entryB = expectOk(await enter(captainB.token, competition.competitionId, B.teamId), 201, `${label}: B enters`).entry.competitionTeamId as string;
  return { competition, organizer, stranger, A, B, captainA, subA, memberA, captainB, entryA, entryB };
}

// =============================================================================================================================================
describe("[1] the connected journey: the flow, the entries, the proposals, each person's own answer, the organizer's decisions, a pending entry that blocks the freeze, the freeze", () => {
  it("runs from the organizer enabling the flow to the freeze counting what was accepted — every actor finding their own records, none of them handed an identifier by another", async () => {
    const competition = await h.setUpCompetition("Journey", { lifetimeFlow: false });
    const c = competition.competitionId;
    const organizer = await asMember(competition.organizer);
    const stranger = await member("Journey Stranger");
    const A = await h.buildTeam("JA", 6);
    const B = await h.buildTeam("JB", 6);
    const C = await h.buildTeam("JC", 6);
    know(competition.organizer, ...A.everyone, ...B.everyone, ...C.everyone);
    const [captainA, subB, captainC] = [await asMember(A.captain), await asMember(B.subCaptain!), await asMember(C.captain)];

    // --- the organizer enables team entries (the flow is off until then)
    expectRefusal(await enter(captainA.token, c, A.teamId), 409, SAID.notEnabled, "entering before the flow is on");
    expectRefusal(await enableFlow(stranger.token, c), 404, SAID.competition, "a stranger enabling the flow");
    expect(await flowOf(c), "the stranger changed nothing").toBeNull();
    const enabled = expectOk(await enableFlow(organizer.token, c), 200, "enable");
    expect(enabled).toEqual({ flow: { competitionId: c, enabledAt: expect.any(String), alreadyEnabled: false } });
    expect(await flowOf(c)).not.toBeNull();
    expect(expectOk(await enableFlow(organizer.token, c), 200, "enable again")).toEqual({ flow: { competitionId: c, enabledAt: enabled.flow.enabledAt, alreadyEnabled: true } });

    // --- nothing has been entered: every participant's own read is empty
    expect(expectOk(await organizerList(organizer.token, c), 200, "organizer list").entries).toEqual([]);
    expect(expectOk(await myTeamEntries(captainA.token), 200, "leader list").entries).toEqual([]);
    expect(expectOk(await myClaims((await asMember(A.members[1])).token), 200, "player list").claims).toEqual([]);

    // --- three teams enter: a captain, a sub-captain, a captain (each leader registered first, with the adult attestation)
    await h.register(competition, A.captain, B.subCaptain!, C.captain);
    const entered = expectOk(await enter(captainA.token, c, A.teamId), 201, "A enters");
    expect(Object.keys(entered)).toEqual(["entry"]);
    expect(Object.keys(entered.entry)).toEqual(["competitionTeamId", "publicCode", "createdAt"]);
    const entryA = entered.entry.competitionTeamId as string;
    const entryB = expectOk(await enter(subB.token, c, B.teamId), 201, "B enters, through its sub-captain").entry.competitionTeamId as string;
    const entryC = expectOk(await enter(captainC.token, c, C.teamId), 201, "C enters").entry.competitionTeamId as string;
    expectRefusal(await enter(captainA.token, c, A.teamId), 409, messageOf("ENTRY_ALREADY_EXISTS"), "A enters twice");
    expectRefusal(await enter((await asMember(A.members[1])).token, c, B.teamId), 404, SAID.team, "an ordinary member entering another team");
    expectRefusal(await enter(captainA.token, c, randomUUID()), 404, SAID.team, "entering a team that does not exist");
    expect((await entryRow(entryA)).status).toBe("PENDING_ORGANIZER_APPROVAL");

    // --- the organizer finds the pending entries by himself, in the order they were made; a leader finds only the team they lead; an ordinary member finds nothing
    const listed = expectOk(await organizerList(organizer.token, c), 200, "organizer list").entries;
    expect(listed.map((e: any) => e.competitionTeamId)).toEqual([entryA, entryB, entryC]);
    expect(listed.map((e: any) => e.name)).toEqual([A.name, B.name, C.name]);
    for (const e of listed) expect(e).toEqual({ competitionTeamId: expect.any(String), publicCode: expect.any(String), name: expect.any(String), status: "PENDING_ORGANIZER_APPROVAL", createdAt: expect.any(String), acceptedPlayers: 0, proposedPlayers: 0 });
    expectRefusal(await organizerList(stranger.token, c), 404, SAID.competition, "a stranger reading the organizer's list");
    const ledA = expectOk(await myTeamEntries(captainA.token), 200, "A's captain's list").entries;
    expect(ledA).toEqual([{ competitionTeamId: entryA, competitionId: c, lifetimeTeamId: A.teamId, publicCode: entered.entry.publicCode, name: A.name, status: "PENDING_ORGANIZER_APPROVAL", createdAt: entered.entry.createdAt, claims: [] }]);
    expect(expectOk(await myTeamEntries(subB.token), 200, "B's sub-captain's list").entries.map((e: any) => e.competitionTeamId), "a sub-captain leads too").toEqual([entryB]);
    expect(expectOk(await myTeamEntries((await asMember(A.members[1])).token), 200, "an ordinary member's list").entries, "an ordinary member leads nothing").toEqual([]);
    expect(expectOk(await myTeamEntries(stranger.token), 200, "a stranger's list").entries).toEqual([]);

    // --- each leader proposes the whole team (captain and sub-captain included); a proposal claims nobody
    const claimsA = new Map<string, string>();
    for (const [team, entry, leader] of [[A, entryA, captainA], [B, entryB, subB], [C, entryC, captainC]] as const) {
      const proposed = expectOk(await propose(leader.token, c, entry, ids(...team.everyone)), 201, `${team.name}: propose`);
      expect(proposed.claims).toHaveLength(6);
      for (const claim of proposed.claims) {
        expect(Object.keys(claim)).toEqual(["claimId", "gamingMemberId", "status", "expiresAt"]);
        expect(claim.status).toBe("PROPOSED");
        if (team === A) claimsA.set(claim.gamingMemberId, claim.claimId);
      }
    }
    expect((await claimsOf(entryA)).map((r) => r.status)).toEqual(Array(6).fill("PROPOSED"));
    expectRefusal(await propose(captainA.token, c, entryA, [A.members[1].gamingMemberId]), 409, messageOf("CLAIM_ALREADY_OPEN"), "proposing the same person twice");

    // --- a person finds their own proposal without being handed an identifier — and only theirs
    const person = await asMember(A.members[1]);
    const mine = expectOk(await myClaims(person.token), 200, "the invited person's list").claims;
    expect(mine).toEqual([{ claimId: claimsA.get(id(person)), competitionId: c, status: "PROPOSED", expiresAt: expect.any(String), team: { lifetimeTeamId: A.teamId, publicCode: expect.any(String), name: A.name } }]);
    expect(expectOk(await myClaims(stranger.token), 200, "a stranger's list").claims).toEqual([]);
    // a leader finds the proposals on their entry, with the people's display names
    const proposedView = expectOk(await myTeamEntries(captainA.token), 200, "A's captain's list").entries[0].claims;
    expect(proposedView).toHaveLength(6);
    for (const p of A.everyone) expect(proposedView.find((x: any) => x.gamingMemberId === id(p))).toEqual({ claimId: claimsA.get(id(p)), gamingMemberId: id(p), displayName: p.displayName, status: "PROPOSED", expiresAt: expect.any(String) });

    // --- THE ORGANIZER'S APPROVAL ACCEPTS NOBODY'S PLACE
    const approvedA = expectOk(await decideEntry(organizer.token, c, entryA, { decision: "APPROVE" }), 200, "approve A");
    expect(approvedA).toEqual({ entry: { competitionTeamId: entryA, status: "ACCEPTED", decision: "APPROVE", decidedAt: expect.any(String), releasedClaims: 0 } });
    expectOk(await decideEntry(organizer.token, c, entryB, { decision: "APPROVE" }), 200, "approve B");
    expect((await entryRow(entryA)).status).toBe("ACCEPTED");
    expect((await claimsOf(entryA)).map((r) => r.status), "every proposal is still only a proposal").toEqual(Array(6).fill("PROPOSED"));
    const afterApproval = expectOk(await organizerList(organizer.token, c), 200, "organizer list after the approvals").entries;
    expect(afterApproval.find((e: any) => e.competitionTeamId === entryA)).toMatchObject({ status: "ACCEPTED", acceptedPlayers: 0, proposedPlayers: 6 });
    // nobody can accept in the person's place: not the organizer, not the leader who proposed, not another member
    const someClaim = claimsA.get(id(person))!;
    for (const [who, token] of [["the organizer", organizer.token], ["the proposing captain", captainA.token], ["a stranger", stranger.token]] as const) {
      expectRefusal(await decideClaim(token, c, someClaim, "ACCEPT"), 404, SAID.claim, `${who} answering for the person`);
    }
    expect((await claimRow(someClaim)).status, "the proposal is untouched").toBe("PROPOSED");

    // --- each person answers their own proposal: A and B accept, in full; two of C's accept, the rest wait
    await h.register(competition, ...A.everyone, ...B.everyone, ...C.members.slice(0, 2));
    for (const p of A.everyone) {
      const answered = expectOk(await decideClaim((await asMember(p)).token, c, claimsA.get(id(p))!, "ACCEPT"), 200, `${p.label} accepts`);
      expect(answered).toEqual({ claim: { claimId: claimsA.get(id(p)), status: "ACCEPTED", acceptedAt: expect.any(String) } });
    }
    const proposedB = (await claimsOf(entryB)).map((r) => r.gaming_member_id);
    const claimIdsB = new Map((await rawQuery("select gaming_member_id, competition_lifetime_roster_claim_id as claim_id from competition_lifetime_roster_claims where competition_team_id = $1", [entryB])).map((r) => [r.gaming_member_id as string, r.claim_id as string]));
    expect(proposedB).toHaveLength(6);
    for (const p of B.everyone) expectOk(await decideClaim((await asMember(p)).token, c, claimIdsB.get(id(p))!, "ACCEPT"), 200, `${p.label} accepts`);
    const claimIdsC = new Map((await rawQuery("select gaming_member_id, competition_lifetime_roster_claim_id as claim_id from competition_lifetime_roster_claims where competition_team_id = $1", [entryC])).map((r) => [r.gaming_member_id as string, r.claim_id as string]));
    for (const p of C.members.slice(0, 2)) expectOk(await decideClaim((await asMember(p)).token, c, claimIdsC.get(id(p))!, "ACCEPT"), 200, `${p.label} accepts`);
    expectRefusal(await decideClaim((await asMember(A.members[1])).token, c, someClaim, "ACCEPT"), 409, messageOf("CLAIM_NOT_OPEN"), "answering twice");
    expect((await claimsOf(entryA)).map((r) => r.status)).toEqual(Array(6).fill("ACCEPTED"));

    // --- the organizer sees the counts, the leader sees every place with its person, the person sees their place
    const counted = expectOk(await organizerList(organizer.token, c), 200, "organizer list after the answers").entries;
    expect(counted.map((e: any) => [e.name, e.status, e.acceptedPlayers, e.proposedPlayers])).toEqual([[A.name, "ACCEPTED", 6, 0], [B.name, "ACCEPTED", 6, 0], [C.name, "PENDING_ORGANIZER_APPROVAL", 2, 4]]);
    const placed = expectOk(await myTeamEntries(captainA.token), 200, "A's captain's list").entries[0];
    expect(placed.status).toBe("ACCEPTED");
    expect(placed.claims.map((x: any) => x.status)).toEqual(Array(6).fill("ACCEPTED"));
    expect(expectOk(await myClaims(person.token), 200, "the person's list").claims[0]).toMatchObject({ status: "ACCEPTED", team: { name: A.name } });

    // --- the deadline passes; a late entry is refused; a PENDING entry blocks the freeze
    await h.passDeadline(c);
    expectRefusal(await enter(captainA.token, c, A.teamId), 409, SAID.registrationClosed, "entering after the deadline");
    expectRefusal(await freeze(stranger.token, c), 404, SAID.competition, "a stranger freezing");
    expectRefusal(await freeze(organizer.token, c), 409, messageOf("FREEZE_PENDING_ENTRIES"), "freezing with an entry still pending");
    expect(await freezeOf(c), "the freeze was refused: nothing was frozen").toBeNull();
    // the organizer decides the pending entry — after the deadline a REJECTION is still allowed; an approval is not
    const afterDeadline = await decideEntry(organizer.token, c, entryC, { decision: "APPROVE" });
    expect([afterDeadline.status, afterDeadline.json.error], "an approval after the deadline is refused").toEqual([409, SAID.registrationClosed]);
    expectRefusal(await decideEntry(organizer.token, c, entryC, { decision: "REJECT" }), 400, messageOf("REASON_INVALID"), "a rejection without a reason");
    expectRefusal(await decideEntry(organizer.token, c, entryC, { decision: "REJECT", reasonCode: "INCOMPLETE_ENTRY", note: "x".repeat(281) }), 400, messageOf("NOTE_INVALID"), "a note that is too long");
    const rejected = expectOk(await decideEntry(organizer.token, c, entryC, { decision: "REJECT", reasonCode: "INCOMPLETE_ENTRY", note: "  The   roster is incomplete. " }), 200, "reject C");
    expect(rejected).toEqual({ entry: { competitionTeamId: entryC, status: "REJECTED", decision: "REJECT", decidedAt: expect.any(String), releasedClaims: 6 } });
    expect(Object.keys(rejected.entry)).not.toContain("decisionId");
    expect((await entryRow(entryC)).status).toBe("REJECTED");
    expect((await claimsOf(entryC)).map((r) => r.status).sort(), "two accepted places were removed and four proposals withdrawn").toEqual(["REMOVED", "REMOVED", "WITHDRAWN", "WITHDRAWN", "WITHDRAWN", "WITHDRAWN"]);
    expect((await rawQuery("select note, reason_code from competition_lifetime_entry_decisions where competition_team_id = $1 and decision = 'REJECTED'", [entryC]))[0]).toEqual({ note: "The roster is incomplete.", reason_code: "INCOMPLETE_ENTRY" });
    // the rejected entry has left every participant's list
    expect(expectOk(await organizerList(organizer.token, c), 200, "organizer list").entries.map((e: any) => e.name)).toEqual([A.name, B.name]);
    expect(expectOk(await myTeamEntries(captainC.token), 200, "C's captain's list").entries).toEqual([]);
    expect(expectOk(await myClaims((await asMember(C.members[0])).token), 200, "a rejected team's player's list").claims).toEqual([]);
    expectRefusal(await decideEntry(organizer.token, c, entryC, { decision: "REJECT", reasonCode: "INCOMPLETE_ENTRY" }), 409, messageOf("ENTRY_NOT_PENDING"), "deciding an entry twice");

    // --- the freeze counts what was accepted; a retry answers the freeze that exists
    const frozen = expectOk(await freeze(organizer.token, c), 200, "freeze");
    expect(frozen).toEqual({ freeze: { competitionId: c, frozenAt: expect.any(String), entryCount: 2, claimCount: 12, alreadyFrozen: false } });
    expect(await freezeOf(c)).toMatchObject({ entry_count: 2, claim_count: 12 });
    expect(expectOk(await freeze(organizer.token, c), 200, "freeze again")).toEqual({ freeze: { ...frozen.freeze, alreadyFrozen: true } });

    // --- after the freeze nothing about an entry or a place can change, and the flow cannot be switched off
    expectRefusal(await withdraw(captainA.token, c, entryA), 409, SAID.frozen, "withdrawing after the freeze");
    expectRefusal(await release((await asMember(A.members[1])).token, c, someClaim), 409, SAID.frozen, "releasing a place after the freeze");
    expectRefusal(await propose(captainA.token, c, entryA, [A.members[1].gamingMemberId]), 409, SAID.frozen, "proposing after the freeze");
    expectRefusal(await decideEntry(organizer.token, c, entryA, { decision: "REMOVE", reasonCode: "RULE_VIOLATION" }), 409, SAID.frozen, "removing an entry after the freeze");
    expectRefusal(await disableFlow(organizer.token, c), 409, messageOf("FLOW_RECOVERY_BLOCKED"), "switching the flow off after it was used");
    expect(expectOk(await enableFlow(organizer.token, c), 200, "enabling again").flow.alreadyEnabled).toBe(true);
    expect((await claimsOf(entryA)).map((r) => r.status), "the places stand").toEqual(Array(6).fill("ACCEPTED"));
    // the two entries and their twelve places are what the participants see to the end
    expect(expectOk(await organizerList(organizer.token, c), 200, "organizer list").entries.map((e: any) => [e.status, e.acceptedPlayers])).toEqual([["ACCEPTED", 6], ["ACCEPTED", 6]]);

    // --- V1 does not notice: the competition's V1 view still answers, and the lifetime entries are what it shows as teams (the existing behaviour, untouched)
    expect((await v1View(organizer.token, c)).status).toBe(200);
  });
});

// =============================================================================================================================================
describe("[2] wrong actors: a stranger, the wrong team, the wrong person and a former leader learn nothing and change nothing", () => {
  it("organizer routes: nobody but the organizer — not a stranger, not a leader, not a player — is told anything; every refusal is the answer for a competition that does not exist", async () => {
    const w = await standing("OrgOnly");
    const c = w.competition.competitionId;
    const before = await stateOf(c);
    const unknown = randomUUID();
    for (const [who, actor] of [["a stranger", w.stranger], ["a captain", w.captainA], ["a sub-captain", w.subA], ["an ordinary player", w.memberA], ["another team's captain", w.captainB]] as const) {
      const attempts: Array<[string, (competition: string) => Promise<Answer>]> = [
        ["enable", (comp) => enableFlow(actor.token, comp)], ["disable", (comp) => disableFlow(actor.token, comp)], ["freeze", (comp) => freeze(actor.token, comp)],
        ["approve", (comp) => decideEntry(actor.token, comp, w.entryA, { decision: "APPROVE" })], ["reject", (comp) => decideEntry(actor.token, comp, w.entryA, { decision: "REJECT", reasonCode: "OTHER_ORGANIZER_DECISION" })],
        ["remove", (comp) => decideEntry(actor.token, comp, w.entryA, { decision: "REMOVE", reasonCode: "RULE_VIOLATION" })], ["list", (comp) => organizerList(actor.token, comp)],
      ];
      for (const [what, run] of attempts) {
        const real = await run(c);
        expectRefusal(real, 404, SAID.competition, `${who} → ${what}`);
        expect(snapshot(real), `${who} → ${what}: the same answer as for a competition that does not exist`).toEqual(snapshot(await run(unknown)));
      }
    }
    expect(await stateOf(c), "nothing at all changed").toEqual(before);
  });

  it("no query value, header or body field can borrow the organizer's standing", async () => {
    const w = await standing("Forged", { enterBoth: false });
    const c = w.competition.competitionId;
    const before = await stateOf(c);
    const forged: Extra = { query: `?actor=${id(w.organizer)}&gamingMemberId=${id(w.organizer)}&organizerGamingMemberId=${id(w.organizer)}`, headers: { "x-gaming-member-id": id(w.organizer), "x-actor": id(w.organizer) } };
    expectRefusal(await freeze(w.stranger.token, c, forged), 404, SAID.competition, "forged freeze");
    expectRefusal(await enableFlow(w.captainA.token, c, forged), 404, SAID.competition, "forged enable");
    expectRefusal(await organizerList(w.captainA.token, c, forged), 404, SAID.competition, "forged list");
    expectRefusal(await decideEntry(w.stranger.token, c, w.entryA, { decision: "APPROVE" }, forged), 404, SAID.competition, "forged decision");
    for (const field of ["organizerGamingMemberId", "actorGamingMemberId", "gamingMemberId", "competitionId", "status"]) {
      const answer = await decideEntry(w.organizer.token, c, w.entryA, `{"decision":"APPROVE","${field}":"${id(w.organizer)}"}`);
      expect(answer.status, field).toBe(400);
      expectBounded(answer, field);
    }
    expect(await stateOf(c), "nothing changed").toEqual(before);
    expect((await myTeamEntries(w.stranger.token, forged)).json, "a forged query cannot make a stranger a leader").toEqual({ entries: [] });
    expect((await myClaims(w.stranger.token, forged)).json, "nor a person").toEqual({ claims: [] });
  });

  it("leader routes: only a leader of the team enters it, withdraws its entry or proposes for it — and every other caller gets the answer for an entry that does not exist", async () => {
    const w = await standing("LeaderOnly");
    const c = w.competition.competitionId;
    const before = await stateOf(c);
    const [unknownEntry, unknownTeam] = [randomUUID(), randomUUID()];
    for (const [who, actor] of [["a stranger", w.stranger], ["an ordinary member of the team", w.memberA], ["another team's captain", w.captainB], ["the organizer", w.organizer]] as const) {
      const attempts: Array<[string, (entry: string) => Promise<Answer>]> = [
        ["withdraw", (entry) => withdraw(actor.token, c, entry)], ["propose", (entry) => propose(actor.token, c, entry, [id(w.memberA)])],
      ];
      for (const [what, run] of attempts) {
        const real = await run(w.entryA);
        expectRefusal(real, 404, SAID.entry, `${who} → ${what}`);
        expect(snapshot(real), `${who} → ${what}: the answer for an entry that does not exist`).toEqual(snapshot(await run(unknownEntry)));
      }
      const entering = await enter(actor.token, c, w.A.teamId);
      expectRefusal(entering, 404, SAID.team, `${who} → enter`);
      expect(snapshot(entering), `${who} → enter: the answer for a team that does not exist`).toEqual(snapshot(await enter(actor.token, c, unknownTeam)));
    }
    expect(await stateOf(c), "nothing at all changed").toEqual(before);
    // the leaders themselves may: the sub-captain proposes, and the captain withdraws
    expectOk(await propose(w.subA.token, c, w.entryA, [id(w.memberA)]), 201, "the sub-captain proposes");
  });

  it("person routes: only the person a proposal names answers it; only that person or a leader of the team releases it — everybody else gets the answer for a proposal that does not exist", async () => {
    const w = await standing("PersonOnly");
    const c = w.competition.competitionId;
    const claims = expectOk(await propose(w.captainA.token, c, w.entryA, ids(w.A.members[0], w.A.subCaptain!)), 201, "propose").claims as Array<{ claimId: string; gamingMemberId: string }>;
    const claimOfPlayer = claims.find((x) => x.gamingMemberId === id(w.memberA))!.claimId;
    const before = await stateOf(c);
    const unknownClaim = randomUUID();
    for (const [who, actor] of [["the organizer", w.organizer], ["the proposing captain", w.captainA], ["the sub-captain, who is a leader but not the person", w.subA], ["another team's captain", w.captainB], ["a stranger", w.stranger]] as const) {
      const real = await decideClaim(actor.token, c, claimOfPlayer, "ACCEPT");
      expectRefusal(real, 404, SAID.claim, `${who} answering for the person`);
      expect(snapshot(real), `${who}: the answer for a proposal that does not exist`).toEqual(snapshot(await decideClaim(actor.token, c, unknownClaim, "ACCEPT")));
    }
    for (const [who, actor] of [["the organizer", w.organizer], ["another team's captain", w.captainB], ["a stranger", w.stranger]] as const) {
      const real = await release(actor.token, c, claimOfPlayer);
      expectRefusal(real, 404, SAID.claim, `${who} releasing`);
      expect(snapshot(real), `${who}: the answer for a proposal that does not exist`).toEqual(snapshot(await release(actor.token, c, unknownClaim)));
    }
    expect(await stateOf(c), "nothing at all changed").toEqual(before);
    expect((await claimRow(claimOfPlayer)).status).toBe("PROPOSED");

    // the person does have standing to their own proposal: releasing it is a conflict (it is answered with a decision), not a stranger's refusal
    expectRefusal(await release(w.memberA.token, c, claimOfPlayer), 409, SAID.proposalIsAnswered, "the person releasing their own proposal");
    expect((await claimRow(claimOfPlayer)).status).toBe("PROPOSED");
    // a leader withdraws a proposal; the person is then told it is no longer open
    const withdrawn = expectOk(await release(w.subA.token, c, claimOfPlayer), 200, "a leader withdraws the proposal");
    expect(withdrawn).toEqual({ claim: { claimId: claimOfPlayer, status: "WITHDRAWN" } });
    expect((await claimRow(claimOfPlayer)).release_reason).toBe("LEADER_WITHDREW_PROPOSAL");
    expectRefusal(await decideClaim(w.memberA.token, c, claimOfPlayer, "ACCEPT"), 409, messageOf("CLAIM_NOT_OPEN"), "answering a withdrawn proposal");
    expect(expectOk(await myClaims(w.memberA.token), 200, "the person's list").claims, "a withdrawn proposal leaves the person's list").toEqual([]);

    // proposed again, the person registers, accepts — and withdraws their own accepted place; a leader removes another
    const again = expectOk(await propose(w.captainA.token, c, w.entryA, [id(w.memberA)]), 201, "propose again").claims[0].claimId as string;
    await h.register(w.competition, w.A.members[0], w.A.subCaptain!);
    expectOk(await decideClaim(w.memberA.token, c, again, "ACCEPT"), 200, "the person accepts");
    expect(expectOk(await release(w.memberA.token, c, again), 200, "the person withdraws their place")).toEqual({ claim: { claimId: again, status: "WITHDRAWN" } });
    expect((await claimRow(again)).release_reason).toBe("PERSON_WITHDREW");
    const subClaim = claims.find((x) => x.gamingMemberId === id(w.subA))!.claimId;
    expectOk(await decideClaim(w.subA.token, c, subClaim, "ACCEPT"), 200, "the sub-captain accepts");
    expect(expectOk(await release(w.captainA.token, c, subClaim), 200, "a leader removes the place")).toEqual({ claim: { claimId: subClaim, status: "REMOVED" } });
    expect((await claimRow(subClaim)).release_reason).toBe("LEADER_REMOVED");
  });

  it("a leader's standing is read from the CURRENT seat: a sub-captain who steps down loses the entry, the proposals and the reads at once", async () => {
    const w = await standing("Former", { enterBoth: false });
    const c = w.competition.competitionId;
    expect(expectOk(await myTeamEntries(w.subA.token), 200, "the sub-captain's list").entries.map((e: any) => e.competitionTeamId)).toEqual([w.entryA]);
    await h.one("end_lifetime_team_leadership_atomically", { p_lifetime_team_id: w.A.teamId, p_actor_gaming_member_id: id(w.subA) });
    expect(expectOk(await myTeamEntries(w.subA.token), 200, "the former sub-captain's list").entries).toEqual([]);
    expectRefusal(await withdraw(w.subA.token, c, w.entryA), 404, SAID.entry, "a former leader withdrawing");
    expectRefusal(await propose(w.subA.token, c, w.entryA, [id(w.memberA)]), 404, SAID.entry, "a former leader proposing");
    expect(expectOk(await myTeamEntries(w.captainA.token), 200, "the captain's list").entries.map((e: any) => e.competitionTeamId)).toEqual([w.entryA]);
  });

  it("an entry is withdrawn by its leader, which settles every place on it; the entry leaves every participant's reads", async () => {
    const w = await standing("Withdraw", { enterBoth: false });
    const c = w.competition.competitionId;
    expectOk(await propose(w.captainA.token, c, w.entryA, ids(w.A.members[0], w.A.subCaptain!)), 201, "propose");
    await h.register(w.competition, w.A.members[0]);
    const mine = expectOk(await myClaims(w.memberA.token), 200, "the person's list").claims[0].claimId as string;
    expectOk(await decideClaim(w.memberA.token, c, mine, "ACCEPT"), 200, "accept");
    const withdrawn = expectOk(await withdraw(w.captainA.token, c, w.entryA), 200, "withdraw");
    expect(withdrawn).toEqual({ entry: { competitionTeamId: w.entryA, status: "REJECTED", releasedClaims: 2 } });
    expect((await claimsOf(w.entryA)).map((r) => r.status).sort()).toEqual(["REMOVED", "WITHDRAWN"]);
    expect(expectOk(await organizerList(w.organizer.token, c), 200, "organizer list").entries).toEqual([]);
    expect(expectOk(await myTeamEntries(w.captainA.token), 200, "leader list").entries).toEqual([]);
    expect(expectOk(await myClaims(w.memberA.token), 200, "person list").claims).toEqual([]);
    expectRefusal(await withdraw(w.captainA.token, c, w.entryA), 409, messageOf("ENTRY_NOT_LIVE"), "withdrawing twice");
    // the team may enter again (a withdrawn entry is over)
    expectOk(await enter(w.captainA.token, c, w.A.teamId), 201, "entering again");
  });
});

// =============================================================================================================================================
describe("[3] a revoked organizer is refused exactly like a stranger — and nothing says that access was revoked", () => {
  it("every organizer route answers the revoked organizer with the stranger's answer, byte for byte, and changes nothing; the leaders' routes are unaffected", async () => {
    const w = await standing("Revoked");
    const c = w.competition.competitionId;
    expect(expectOk(await organizerList(w.organizer.token, c), 200, "the organizer, before").entries).toHaveLength(2);
    expectOk(await decideEntry(w.organizer.token, c, w.entryA, { decision: "APPROVE" }), 200, "the organizer approves, before");
    await revokeHosting(w.competition);
    const before = await stateOf(c);
    const attempts: Array<[string, (token: string) => Promise<Answer>]> = [
      ["enable", (t) => enableFlow(t, c)], ["disable", (t) => disableFlow(t, c)], ["freeze", (t) => freeze(t, c)], ["list", (t) => organizerList(t, c)],
      ["approve", (t) => decideEntry(t, c, w.entryB, { decision: "APPROVE" })], ["reject", (t) => decideEntry(t, c, w.entryB, { decision: "REJECT", reasonCode: "INELIGIBLE_TEAM" })],
      ["remove", (t) => decideEntry(t, c, w.entryA, { decision: "REMOVE", reasonCode: "RULE_VIOLATION" })],
    ];
    for (const [what, run] of attempts) {
      const revoked = await run(w.organizer.token);
      expectRefusal(revoked, 404, SAID.competition, `the revoked organizer → ${what}`);
      expect(snapshot(revoked), `the revoked organizer → ${what}: the stranger's answer`).toEqual(snapshot(await run(w.stranger.token)));
      expect(revoked.text.toLowerCase(), what).not.toMatch(/revoke|hosting|host access/);
    }
    expect(await stateOf(c), "a revoked organizer changed nothing").toEqual(before);
    // the participants are not the organizer: a leader still withdraws and a person still answers
    expectOk(await withdraw(w.captainB.token, c, w.entryB), 200, "a leader withdraws, whatever happened to the organizer");
  });
});

// =============================================================================================================================================
describe("[4] cross-competition scoping: an entry or a proposal addressed through another competition is the answer for one that does not exist — and nothing changes", () => {
  it("every route that names a competition and an entry or a proposal binds them: through the wrong competition nothing is reachable, through the right one everything is", async () => {
    const X = await standing("ScopeX");
    const Y = await standing("ScopeY");
    const [cx, cy] = [X.competition.competitionId, Y.competition.competitionId];
    const claimX = expectOk(await propose(X.captainA.token, cx, X.entryA, [id(X.memberA)]), 201, "propose in X").claims[0].claimId as string;
    await h.register(X.competition, X.A.members[0]);
    const beforeX = await stateOf(cx);
    const beforeY = await stateOf(cy);
    const unknown = randomUUID();

    // the entry of X, addressed through Y — by the very people who may act on it in X
    const throughY: Array<[string, Answer]> = [
      ["the leader withdrawing", await withdraw(X.captainA.token, cy, X.entryA)],
      ["the leader proposing", await propose(X.captainA.token, cy, X.entryA, [id(X.subA)])],
      ["the person accepting", await decideClaim(X.memberA.token, cy, claimX, "ACCEPT")],
      ["a leader releasing", await release(X.captainA.token, cy, claimX)],
    ];
    for (const [what, answer] of throughY) {
      expect(answer.status, what).toBe(404);
      expectBounded(answer, what);
    }
    expect(snapshot(throughY[0][1]), "an entry of another competition is the answer for an entry that does not exist").toEqual(snapshot(await withdraw(X.captainA.token, cy, unknown)));
    expect(snapshot(throughY[1][1])).toEqual(snapshot(await propose(X.captainA.token, cy, unknown, [id(X.subA)])));
    expect(snapshot(throughY[2][1]), "a proposal of another competition is the answer for a proposal that does not exist").toEqual(snapshot(await decideClaim(X.memberA.token, cy, unknown, "ACCEPT")));
    expect(snapshot(throughY[3][1])).toEqual(snapshot(await release(X.captainA.token, cy, unknown)));
    // the organizers: the organizer of X is a stranger to Y; the organizer of Y finds no such entry in Y
    expectRefusal(await decideEntry(X.organizer.token, cy, X.entryA, { decision: "APPROVE" }), 404, SAID.competition, "X's organizer deciding X's entry through Y");
    expectRefusal(await decideEntry(Y.organizer.token, cy, X.entryA, { decision: "APPROVE" }), 404, SAID.entry, "Y's organizer deciding X's entry through Y");
    expectRefusal(await decideEntry(Y.organizer.token, cx, X.entryA, { decision: "APPROVE" }), 404, SAID.competition, "Y's organizer deciding X's entry through X");
    expect(await stateOf(cx), "X is unchanged").toEqual(beforeX);
    expect(await stateOf(cy), "Y is unchanged").toEqual(beforeY);
    expect(expectOk(await organizerList(Y.organizer.token, cy), 200, "Y's list").entries.map((e: any) => e.name), "Y's list holds Y's entries only").toEqual([Y.A.name, Y.B.name]);

    // through the right competition every one of them works
    expectOk(await decideClaim(X.memberA.token, cx, claimX, "ACCEPT"), 200, "the person accepts, through X");
    expectOk(await propose(X.captainA.token, cx, X.entryA, [id(X.subA)]), 201, "the leader proposes, through X");
    expectOk(await decideEntry(X.organizer.token, cx, X.entryA, { decision: "APPROVE" }), 200, "X's organizer approves, through X");
    expectOk(await withdraw(X.captainA.token, cx, X.entryA), 200, "the leader withdraws, through X");
  });
});

// =============================================================================================================================================
describe("[5] V1 isolation: a competition that never enabled the flow, a competition with legacy teams, and the V1 routes themselves are untouched", () => {
  it("a V1 competition: team entries are 'not enabled' (a conflict the caller may be told), the organizer's reads are empty, the flow's recovery writes nothing — and the V1 routes work as before", async () => {
    const competition = await h.setUpCompetition("V1", { lifetimeFlow: false });
    const c = competition.competitionId;
    const organizer = await asMember(competition.organizer);
    const A = await h.buildTeam("V1A", 3);
    know(competition.organizer, ...A.everyone);
    const captain = await asMember(A.captain);
    const before = await stateOf(c);
    // (the flow is judged before the registration: a leader who has not registered yet is told the flow is off)
    expectRefusal(await enter(captain.token, c, A.teamId), 409, SAID.notEnabled, "entering a competition that never enabled the flow");
    expectRefusal(await freeze(organizer.token, c), 409, SAID.notEnabled, "freezing without the flow");
    expectRefusal(await decideEntry(organizer.token, c, randomUUID(), { decision: "APPROVE" }), 409, SAID.notEnabled, "deciding without the flow");
    expect(expectOk(await organizerList(organizer.token, c), 200, "organizer list").entries).toEqual([]);
    expect(expectOk(await disableFlow(organizer.token, c), 200, "disable").flow).toEqual({ competitionId: c, disabledAt: null, alreadyDisabled: true });
    expect(await stateOf(c), "none of it wrote anything").toEqual(before);

    // the V1 routes work on it exactly as they always did
    expectV1(await v1Register(captain.token, c), 201, "V1 register");
    const team = expectV1(await v1ProposeTeam(captain.token, c, `V1 Team ${h.RUN}`), 201, "V1 propose team");
    expect(team.team).toMatchObject({ status: "PENDING_ORGANIZER_APPROVAL" });
    expect((await rawQuery("select name, entry_flow from competition_teams where competition_team_id = $1", [team.team.competitionTeamId]))[0]).toEqual({ name: `V1 Team ${h.RUN}`, entry_flow: "V1" });
    expect((await v1View(organizer.token, c)).status).toBe(200);

    // a competition that already has a legacy team cannot switch the lifetime flow on, and the refusal is a bounded conflict
    expectRefusal(await enableFlow(organizer.token, c), 409, messageOf("FLOW_CONFLICT"), "enabling over a legacy team");
    expect(await flowOf(c), "no flow was created").toBeNull();
    expect((await rawQuery("select entry_flow from competition_teams where competition_id = $1", [c])).map((r) => r.entry_flow), "the legacy team is still legacy").toEqual(["V1"]);
  });

  it("a lifetime competition refuses the V1 team proposal — by the database's existing guard — and the flow's own recovery is safe: off while nothing came of it, on again, then blocked", async () => {
    const competition = await h.setUpCompetition("V1Guard", { lifetimeFlow: false });
    const c = competition.competitionId;
    const organizer = await asMember(competition.organizer);
    const A = await h.buildTeam("V1G", 3);
    know(competition.organizer, ...A.everyone);
    const captain = await asMember(A.captain);
    await h.register(competition, A.captain);
    expectOk(await enableFlow(organizer.token, c), 200, "enable");
    const refused = await v1ProposeTeam(captain.token, c, `V1 Late ${h.RUN}`);
    // the database's own guard answers "registration is closed", which the V1 route has always mapped to a 409 — unchanged by this gate
    expect(refused.status, `the V1 proposal is refused on a lifetime competition: ${refused.text}`).toBe(409);
    expect(await rawQuery("select 1 from competition_teams where competition_id = $1", [c]), "no legacy team was created").toHaveLength(0);
    // the safe way back: nothing has come of the flow, so it may be switched off — and on again
    const off = expectOk(await disableFlow(organizer.token, c), 200, "disable");
    expect(off.flow).toEqual({ competitionId: c, disabledAt: expect.any(String), alreadyDisabled: false });
    expect(await flowOf(c)).toBeNull();
    expect(expectOk(await disableFlow(organizer.token, c), 200, "disable again").flow).toEqual({ competitionId: c, disabledAt: null, alreadyDisabled: true });
    expect((await rawQuery<{ n: number }>("select count(*)::int as n from competition_lifetime_flow_events where competition_id = $1", [c]))[0].n, "the switch left its events").toBe(2);
    expectOk(await enableFlow(organizer.token, c), 200, "enable again");
    expectOk(await enter(captain.token, c, A.teamId), 201, "entering");
    expectRefusal(await disableFlow(organizer.token, c), 409, messageOf("FLOW_RECOVERY_BLOCKED"), "switching off after an entry exists");
    expect(await flowOf(c), "the flow stands").not.toBeNull();
    // the V1 view of the competition still answers
    expect((await v1View(organizer.token, c)).status).toBe(200);
  });
});

// =============================================================================================================================================
describe("[6] the availability guard, authentication, and the exact request shapes — against the real database", () => {
  it("signed out is a bounded 401 and a closed capability a bounded 503 on every one of the twelve routes — and neither touches a row", async () => {
    const w = await standing("Guard", { enterBoth: false });
    const c = w.competition.competitionId;
    const before = await stateOf(c);
    const unauthenticated = "A valid Authorization header for an authenticated Gaming Member is required.";
    const everyRoute = (token: Token, x: Extra = {}): Array<[string, () => Promise<Answer>]> => [
      ["enable", () => enableFlow(token, c, x)], ["disable", () => disableFlow(token, c, x)], ["freeze", () => freeze(token, c, x)], ["decide entry", () => decideEntry(token, c, w.entryA, { decision: "APPROVE" }, x)],
      ["enter", () => enter(token, c, w.A.teamId, x)], ["withdraw", () => withdraw(token, c, w.entryA, x)], ["propose", () => propose(token, c, w.entryA, [id(w.memberA)], x)],
      ["decide claim", () => decideClaim(token, c, randomUUID(), "ACCEPT", x)], ["release", () => release(token, c, randomUUID(), x)],
      ["organizer list", () => organizerList(token, c, x)], ["leader list", () => myTeamEntries(token, x)], ["player list", () => myClaims(token, x)],
    ];
    expect(everyRoute(undefined)).toHaveLength(12);
    for (const [what, run] of everyRoute(undefined)) {
      const answer = await run();
      expect([answer.status, answer.json?.error], `${what}: no credential`).toEqual([401, unauthenticated]);
      expect(answer.cache, what).toBe(NO_STORE);
    }
    for (const [what, run] of everyRoute("not-a-real-token")) {
      const answer = await run();
      expect([answer.status, answer.json?.error], `${what}: a token that is not a session`).toEqual([401, unauthenticated]);
    }
    const open = process.env.COMPETITIONS_SCHEMA_READY;
    try {
      for (const value of [undefined, "false", "TRUE"]) {
        if (value === undefined) delete process.env.COMPETITIONS_SCHEMA_READY;
        else process.env.COMPETITIONS_SCHEMA_READY = value;
        for (const [what, run] of everyRoute(w.organizer.token)) {
          const answer = await run();
          expect([answer.status, answer.json?.error], `${what}: capability ${String(value)}`).toEqual([503, UNAVAILABLE_503]);
          expect(answer.cache, what).toBe(NO_STORE);
        }
      }
    } finally {
      process.env.COMPETITIONS_SCHEMA_READY = open;
    }
    expect(await stateOf(c), "nothing was written").toEqual(before);
  });

  it("exact request shapes: a body of the wrong shape, an unlisted reason and a malformed identifier are bounded 400s before anything is read or written", async () => {
    const w = await standing("Shapes", { enterBoth: false });
    const c = w.competition.competitionId;
    const before = await stateOf(c);
    expectRefusal(await enter(w.captainA.token, c, "not-a-uuid"), 400, messageOf("INPUT_INVALID"), "a malformed team id");
    const notJson = await call("enter, not JSON", enterRoute, "POST", at(c, "lifetime-entries"), { token: w.captainA.token, body: "not json {{{", params: { competitionId: c } });
    expect([notJson.status, notJson.json?.error]).toEqual([400, "Request body must be valid JSON."]);
    expect((await call("enter, extra field", enterRoute, "POST", at(c, "lifetime-entries"), { token: w.captainA.token, body: { lifetimeTeamId: w.A.teamId, actor: id(w.organizer) }, params: { competitionId: c } })).status).toBe(400);
    expectRefusal(await decideEntry(w.organizer.token, c, w.entryA, { decision: "MAYBE" }), 400, messageOf("DECISION_INVALID"), "an unknown decision");
    expectRefusal(await decideEntry(w.organizer.token, c, w.entryA, { decision: "REJECT", reasonCode: "BECAUSE" }), 400, messageOf("REASON_INVALID"), "an unlisted reason");
    expectRefusal(await decideEntry(w.organizer.token, c, w.entryA, { decision: "APPROVE", reasonCode: "INELIGIBLE_TEAM" }), 400, messageOf("REASON_INVALID"), "an approval with a reason");
    expectRefusal(await decideEntry(w.organizer.token, c, "not-a-uuid", { decision: "APPROVE" }), 400, messageOf("INPUT_INVALID"), "a malformed entry id");
    expectRefusal(await propose(w.captainA.token, c, w.entryA, []), 400, messageOf("CLAIM_BATCH_INVALID"), "an empty batch");
    expectRefusal(await propose(w.captainA.token, c, w.entryA, [id(w.memberA), id(w.memberA)]), 400, messageOf("CLAIM_BATCH_INVALID"), "the same person twice");
    expectRefusal(await propose(w.captainA.token, c, w.entryA, Array.from({ length: 33 }, () => randomUUID())), 400, messageOf("CLAIM_BATCH_INVALID"), "thirty-three people");
    expectRefusal(await decideClaim(w.memberA.token, c, randomUUID(), "DECLINE"), 400, messageOf("DECISION_INVALID"), "an offer's answer given to a proposal");
    expectRefusal(await organizerList(w.organizer.token, "not-a-uuid"), 400, messageOf("INPUT_INVALID"), "a malformed competition id");
    // a person who is not a member of the team cannot be proposed; a person who has not registered cannot accept — both are bounded conflicts the leader and the person may be told
    expectRefusal(await propose(w.captainA.token, c, w.entryA, [id(w.stranger)]), 409, messageOf("CLAIM_SUBJECT_NOT_MEMBER"), "proposing somebody who is not on the team");
    const claim = expectOk(await propose(w.captainA.token, c, w.entryA, [id(w.memberA)]), 201, "propose").claims[0].claimId as string;
    expectRefusal(await decideClaim(w.memberA.token, c, claim, "ACCEPT"), 409, "Register for this competition first.", "accepting without being registered for the competition");
    expect((await claimRow(claim)).status).toBe("PROPOSED");
    expect(await flowOf(c)).not.toBeNull();
    const after = await stateOf(c);
    expect(after.entries, "no entry changed").toEqual(before.entries);
  });
});

// =============================================================================================================================================
describe("[7] every response of this file: uncached, bounded, and carrying nothing about anybody's account", () => {
  it("is Cache-Control: no-store on every response, an error is only {error: one bounded sentence}, and no email, authentication identity or contact detail appeared anywhere", () => {
    // The V1 routes (register, team proposal, view) are called to prove they are untouched; they are not this gate's responses and keep the headers they always had.
    const mine = log.filter((r) => !r.label.startsWith("v1 "));
    expect(log.length - mine.length, "the V1 routes were called").toBeGreaterThan(3);
    expect(mine.length, "the scenarios above made a real number of calls").toBeGreaterThan(300);
    for (const r of mine) expect(r.cache, `${r.label} (${r.status})`).toBe(NO_STORE);
    for (const r of mine) {
      if (r.status >= 400) {
        const body = JSON.parse(r.text);
        expect(Object.keys(body), `${r.label} (${r.status}): ${r.text}`).toEqual(["error"]);
        expect(body.error, r.label).not.toMatch(TOKEN_LIKE);
        expect(body.error, r.label).not.toMatch(DATABASE_WORDS);
      }
    }
    const leaks = new Set<string>();
    const all = mine.map((r) => r.text).join("\n");
    for (const person of everyone) for (const secret of [person.email, person.authUserId]) if (all.includes(secret)) leaks.add(secret);
    expect([...leaks]).toEqual([]);
    expect(all).not.toMatch(/example\.com|auth_user_id|authUserId|"email"|"phone"|service_role|apikey|PGRST|P0001|LIFETIME_/);
  });
});
