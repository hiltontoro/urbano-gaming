import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadEnv } from "vite";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";

import { GET as listRoute } from "../app/api/gaming/competitions/lifetime-teams/route";
import { GET as inboxRoute } from "../app/api/gaming/competitions/lifetime-offers/route";
import { POST as proposeRoute } from "../app/api/gaming/competitions/lifetime-teams/[lifetimeTeamId]/memberships/route";
import { POST as endMembershipRoute } from "../app/api/gaming/competitions/lifetime-teams/[lifetimeTeamId]/memberships/end/route";
import { POST as offerLeadershipRoute } from "../app/api/gaming/competitions/lifetime-teams/[lifetimeTeamId]/leadership-offers/route";
import { POST as endLeadershipRoute } from "../app/api/gaming/competitions/lifetime-teams/[lifetimeTeamId]/leadership/end/route";
import { POST as decideMembershipRoute } from "../app/api/gaming/competitions/lifetime-memberships/[membershipId]/decision/route";
import { POST as withdrawRoute } from "../app/api/gaming/competitions/lifetime-offers/[offerId]/withdraw/route";
import { POST as decideLeadershipRoute } from "../app/api/gaming/competitions/lifetime-leaderships/[leadershipId]/decision/route";
import { LifetimeTeamError } from "../lib/gaming/competitions/lifetimeTeams";
import { createHarness, type Person } from "./helpers/lifetimeContract";

/**
 * UG-CR-GATE-CFM-010 — the authenticated HTTP surface of lifetime-team membership and leadership, against a real (disposable, loopback-only) Supabase: real Auth sessions,
 * the real route handlers called in-process, and the real 294-migration schema behind them.
 *
 * Proves: a captain invites a member and the invited member — and only that member — answers; a stranger, the inviter and every other wrong party learn nothing (one uniform
 * 404); the initiator withdraws a pending offer and nobody else on the other side can; a member leaves, a leader removes an ordinary member and a leader can never be removed;
 * the captain offers the sub-captain seat and the offered member — and only that member — takes it; a captain cannot leave without the sub-captain succeeding them, and the
 * successor must be the sub-captain; a lapsed offer is a conflict; no query, header or field can name another actor; and no browser role can write the lifetime tables or call
 * the operations the routes use. Every identity is synthetic and every row is removed again by the harness.
 */

// The shared contract-test guard (UG-CR-GATE-079) runs before anything is constructed: no target that is not loopback is ever touched.
const supabaseUrl = loadEnv("development", process.cwd(), "").SUPABASE_URL;
requireLocalSupabase(supabaseUrl);
// Real people, real tokens and real teams are built per scenario: none of them is a unit test, so one explicit budget for the whole file.
vi.setConfig({ testTimeout: 120_000 });

const h = createHarness("mh");
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

const BASE = "http://localhost/api/gaming/competitions";
const NO_STORE = "no-store, max-age=0";
const UNAVAILABLE_503 = "URBANO Gaming Competitions is temporarily unavailable while its database is being prepared.";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const messageOf = (code: ConstructorParameters<typeof LifetimeTeamError>[0]) => new LifetimeTeamError(code).message;
const TEAM_NOT_FOUND = "That team could not be found.";
const OFFER_NOT_FOUND = "That offer could not be found.";

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

const paths = {
  propose: (id: string) => `${BASE}/lifetime-teams/${id}/memberships`,
  decideMembership: (id: string) => `${BASE}/lifetime-memberships/${id}/decision`,
  withdraw: (id: string) => `${BASE}/lifetime-offers/${id}/withdraw`,
  endMembership: (id: string) => `${BASE}/lifetime-teams/${id}/memberships/end`,
  offerLeadership: (id: string) => `${BASE}/lifetime-teams/${id}/leadership-offers`,
  decideLeadership: (id: string) => `${BASE}/lifetime-leaderships/${id}/decision`,
  endLeadership: (id: string) => `${BASE}/lifetime-teams/${id}/leadership/end`,
};
interface Extra { url?: string; headers?: Record<string, string>; authorization?: string }
function route(label: string, handler: Handler, urlOf: (id: string) => string, param: string) {
  return (token: string | undefined, id: string, body?: unknown, extra: Extra = {}) =>
    call(label, handler, "POST", extra.url ?? urlOf(id), { token, authorization: extra.authorization, params: { [param]: id }, headers: extra.headers, body });
}
const proposeM = route("propose membership", proposeRoute, paths.propose, "lifetimeTeamId");
const decideM = route("decide membership", decideMembershipRoute, paths.decideMembership, "membershipId");
const withdraw = route("withdraw offer", withdrawRoute, paths.withdraw, "offerId");
const endM = route("end membership", endMembershipRoute, paths.endMembership, "lifetimeTeamId");
const offerL = route("offer leadership", offerLeadershipRoute, paths.offerLeadership, "lifetimeTeamId");
const decideL = route("decide leadership", decideLeadershipRoute, paths.decideLeadership, "leadershipId");
const endL = route("end leadership", endLeadershipRoute, paths.endLeadership, "lifetimeTeamId");
const list = (token: string | undefined) => call("list", listRoute, "GET", `${BASE}/lifetime-teams`, { token });
/** The member's own pending offers (CFM-012). */
const inbox = (token: string | undefined, extra: Extra = {}) => call("inbox", inboxRoute, "GET", extra.url ?? `${BASE}/lifetime-offers`, { token, authorization: extra.authorization, headers: extra.headers });

type Member = Person & { token: string };
/** A person with a genuine session. */
async function member(label: string): Promise<Member> {
  const person = await h.newPerson(label);
  return { ...person, token: await h.tokenFor(person) };
}
const withToken = async (person: Person): Promise<Member> => ({ ...person, token: await h.tokenFor(person) });

const snapshot = (a: Answer) => ({ status: a.status, headers: a.headers, text: a.text });
const forgedQuery = (url: string, actor: string) => `${url}?actor=${actor}&gamingMemberId=${actor}&captain=${actor}`;
const forgedHeaders = (actor: string) => ({ "x-gaming-member-id": actor, "x-actor": actor });

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

// What the database holds, read as its owner.
const membershipRow = async (id: string) => (await rawQuery("select lifetime_team_id, gaming_member_id, status, initiated_by_side, initiated_by_gaming_member_id, joined_at, ended_at, end_reason, decided_by_gaming_member_id, ended_by_gaming_member_id from lifetime_team_memberships where lifetime_team_membership_id = $1", [id]))[0];
const leadershipRow = async (id: string) => (await rawQuery("select lifetime_team_id, gaming_member_id, role, status, offered_by_gaming_member_id, started_at, ended_at, end_reason, ended_by_gaming_member_id, predecessor_leadership_id from lifetime_team_leaderships where lifetime_team_leadership_id = $1", [id]))[0];
const activeMembers = async (teamId: string) => (await rawQuery("select gaming_member_id from lifetime_team_memberships where lifetime_team_id = $1 and status = 'ACTIVE'", [teamId])).map((r) => r.gaming_member_id as string).sort();
const seats = async (teamId: string) => rawQuery("select role, gaming_member_id from lifetime_team_leaderships where lifetime_team_id = $1 and status = 'ACTIVE' order by role", [teamId]);
const teamState = async (teamId: string) => ({
  memberships: await rawQuery("select gaming_member_id, status, initiated_by_side, end_reason from lifetime_team_memberships where lifetime_team_id = $1 order by seq", [teamId]),
  leaderships: await rawQuery("select gaming_member_id, role, status, end_reason from lifetime_team_leaderships where lifetime_team_id = $1 order by seq", [teamId]),
  events: (await rawQuery<{ n: number }>("select count(*)::int as n from lifetime_team_events where lifetime_team_id = $1", [teamId]))[0].n,
});
const sorted = (...people: Person[]) => people.map((p) => p.gamingMemberId).sort();

// =============================================================================================================================================
describe("signed-out calls", () => {
  it("are rejected on all seven routes and on the offer inbox — whatever the credential — before anything is parsed, read or changed", async () => {
    const alice = await member("Alice");
    const bob = await h.newPerson("Bob");
    const team = await h.createTeam(alice);
    const offer = await h.one("propose_lifetime_team_membership_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: alice.gamingMemberId, p_subject_gaming_member_id: bob.gamingMemberId });
    const before = await teamState(team.teamId);
    const credentials: Array<string | undefined> = [undefined, "Bearer", "Bearer ", "Bearer not.a.jwt", `Bearer ${h.serviceKey}`, `Bearer ${h.anonKey}`, "Basic dXNlcjpwYXNz"];
    for (const authorization of credentials) {
      const label = JSON.stringify(authorization)?.replace(/eyJ[\w.-]+/g, "<jwt>") ?? "no header";
      const answers = [
        await proposeM(undefined, team.teamId, { gamingMemberId: bob.gamingMemberId }, { authorization }),
        await decideM(undefined, offer.lifetime_team_membership_id, { decision: "ACCEPT" }, { authorization }),
        await withdraw(undefined, offer.lifetime_team_membership_id, { kind: "MEMBERSHIP" }, { authorization }),
        await endM(undefined, team.teamId, { gamingMemberId: bob.gamingMemberId }, { authorization }),
        await offerL(undefined, team.teamId, { gamingMemberId: bob.gamingMemberId }, { authorization }),
        await decideL(undefined, randomUUID(), { decision: "ACCEPT" }, { authorization }),
        await endL(undefined, team.teamId, undefined, { authorization }),
        await decideM(undefined, "test-id", "not json {{{", { authorization }),
        await inbox(undefined, { authorization }),
      ];
      for (const answer of answers) {
        expect(answer.status, `${label}: ${answer.text}`).toBe(401);
        expectBounded(answer, label);
      }
    }
    expect(await teamState(team.teamId), "no signed-out call changed anything").toEqual(before);
  });
});

// =============================================================================================================================================
describe("the invitation, its answer and its withdrawal", () => {
  it("the captain invites a member; a wrong member cannot answer; the invited member accepts — and no query, header or field can name another actor", async () => {
    const alice = await member("Alice");
    const bob = await member("Bob");
    const eve = await member("Eve");
    const carol = await h.newPerson("Carol");
    const team = await h.createTeam(alice);
    const before = await teamState(team.teamId);

    // Fields that would name an actor, a role or a status are refused before anything happens.
    for (const field of ["actorGamingMemberId", "captainGamingMemberId", "status", "role", "initiatedBySide"]) {
      const forged = await proposeM(alice.token, team.teamId, { gamingMemberId: bob.gamingMemberId, [field]: eve.gamingMemberId });
      expect(forged.status, `${field}: ${forged.text}`).toBe(400);
      expectBounded(forged, field);
    }
    expect(await teamState(team.teamId), "nothing changed").toEqual(before);

    // The invitation: the actor is the session, whatever the query and the headers say.
    const invited = await proposeM(alice.token, team.teamId, { gamingMemberId: bob.gamingMemberId }, { url: forgedQuery(paths.propose(team.teamId), eve.gamingMemberId), headers: forgedHeaders(eve.gamingMemberId) });
    expect(invited.status, invited.text).toBe(201);
    expect(invited.cache).toBe(NO_STORE);
    expect(Object.keys(invited.json)).toEqual(["membership"]);
    expect(Object.keys(invited.json.membership)).toEqual(["lifetimeTeamMembershipId", "status", "initiatedBySide", "expiresAt"]);
    expect(invited.json.membership).toMatchObject({ status: "PENDING", initiatedBySide: "TEAM" });
    expect(invited.json.membership.lifetimeTeamMembershipId).toMatch(UUID);
    expect(Number.isNaN(Date.parse(invited.json.membership.expiresAt))).toBe(false);
    const offerId = invited.json.membership.lifetimeTeamMembershipId as string;
    expect(await membershipRow(offerId)).toMatchObject({ lifetime_team_id: team.teamId, gaming_member_id: bob.gamingMemberId, status: "PENDING", initiated_by_side: "TEAM", initiated_by_gaming_member_id: alice.gamingMemberId });
    expect(await rawQuery("select 1 from lifetime_team_memberships where gaming_member_id = $1", [eve.gamingMemberId]), "the member named in the query and the header got nothing").toHaveLength(0);

    // A wrong member cannot answer: the stranger, the inviter (an invitation is answered by the other side) — all one uniform 404, the same bytes as an unknown offer.
    const unknown = snapshot(await decideM(bob.token, randomUUID(), { decision: "ACCEPT" }));
    expect(unknown.status).toBe(404);
    expect(JSON.parse(unknown.text)).toEqual({ error: OFFER_NOT_FOUND });
    expect(unknown.headers).toContainEqual(["cache-control", NO_STORE]);
    expect(snapshot(await decideM(eve.token, offerId, { decision: "ACCEPT" })), "a stranger").toEqual(unknown);
    expect(snapshot(await decideM(alice.token, offerId, { decision: "ACCEPT" })), "the inviter cannot accept for the invitee").toEqual(unknown);
    expect(snapshot(await decideM(alice.token, offerId, { decision: "DECLINE" })), "…nor decline for them").toEqual(unknown);
    const forgedAnswer = await decideM(eve.token, offerId, { decision: "ACCEPT" }, { url: forgedQuery(paths.decideMembership(offerId), bob.gamingMemberId), headers: forgedHeaders(bob.gamingMemberId) });
    expect(snapshot(forgedAnswer), "a stranger who names the invitee as the actor is still the stranger").toEqual(unknown);
    expect((await membershipRow(offerId)).status, "nobody wrong changed the offer").toBe("PENDING");

    // The invited member accepts.
    const accepted = await decideM(bob.token, offerId, { decision: "ACCEPT" }, { headers: forgedHeaders(eve.gamingMemberId) });
    expect(accepted.status, accepted.text).toBe(200);
    expect(Object.keys(accepted.json)).toEqual(["membership"]);
    expect(Object.keys(accepted.json.membership)).toEqual(["lifetimeTeamMembershipId", "status", "joinedAt"]);
    expect(accepted.json.membership).toMatchObject({ lifetimeTeamMembershipId: offerId, status: "ACTIVE" });
    expect(Number.isNaN(Date.parse(accepted.json.membership.joinedAt))).toBe(false);
    expect(await membershipRow(offerId)).toMatchObject({ status: "ACTIVE", decided_by_gaming_member_id: bob.gamingMemberId });
    expect(await activeMembers(team.teamId)).toEqual(sorted(alice, bob));

    // An answered offer is a bounded conflict for its own party; the new member sees the team in their own list.
    const again = await decideM(bob.token, offerId, { decision: "ACCEPT" });
    expect(again.status, again.text).toBe(409);
    expect(again.json).toEqual({ error: messageOf("OFFER_NOT_PENDING") });
    expectBounded(again, "answered offer");
    expect((await list(bob.token)).json.teams.map((t: any) => t.lifetimeTeamId)).toEqual([team.teamId]);

    // Nobody but a leader invites: a stranger and an ordinary member get the 404 of an unknown team.
    const unknownTeam = snapshot(await proposeM(eve.token, randomUUID(), { gamingMemberId: carol.gamingMemberId }));
    expect(unknownTeam.status).toBe(404);
    expect(JSON.parse(unknownTeam.text)).toEqual({ error: TEAM_NOT_FOUND });
    expect(snapshot(await proposeM(eve.token, team.teamId, { gamingMemberId: carol.gamingMemberId })), "a stranger").toEqual(unknownTeam);
    expect(snapshot(await proposeM(bob.token, team.teamId, { gamingMemberId: carol.gamingMemberId })), "an ordinary member").toEqual(unknownTeam);
    expect(await rawQuery("select 1 from lifetime_team_memberships where gaming_member_id = $1", [carol.gamingMemberId])).toHaveLength(0);

    // The conflicts the database states stay bounded 409s: an existing member, an unknown person, a second pending offer.
    const existing = await proposeM(alice.token, team.teamId, { gamingMemberId: bob.gamingMemberId });
    expect(existing.status, existing.text).toBe(409);
    expect(existing.json).toEqual({ error: messageOf("ALREADY_MEMBER") });
    const ghost = await proposeM(alice.token, team.teamId, { gamingMemberId: randomUUID() });
    expect(ghost.status, ghost.text).toBe(409);
    expect(ghost.json).toEqual({ error: messageOf("PERSON_NOT_FOUND") });
    expect((await proposeM(alice.token, team.teamId, { gamingMemberId: carol.gamingMemberId })).status).toBe(201);
    const pending = await proposeM(alice.token, team.teamId, { gamingMemberId: carol.gamingMemberId });
    expect(pending.status, pending.text).toBe(409);
    expect(pending.json).toEqual({ error: messageOf("OFFER_ALREADY_PENDING") });
    for (const answer of [existing, ghost, pending]) expectBounded(answer, "conflict");
  });

  it("the invited member may decline, and the invitation is then over; a person's own request is answered by a leader and never by the person", async () => {
    const alice = await member("Alice");
    const bob = await member("Bob");
    const dave = await member("Dave");
    const eve = await member("Eve");
    const team = await h.createTeam(alice);

    const invitation = (await proposeM(alice.token, team.teamId, { gamingMemberId: bob.gamingMemberId })).json.membership.lifetimeTeamMembershipId as string;
    const declined = await decideM(bob.token, invitation, { decision: "DECLINE" });
    expect(declined.status, declined.text).toBe(200);
    expect(declined.json).toEqual({ membership: { lifetimeTeamMembershipId: invitation, status: "ENDED", joinedAt: null } });
    expect(await membershipRow(invitation)).toMatchObject({ status: "ENDED", end_reason: "DECLINED", decided_by_gaming_member_id: bob.gamingMemberId, joined_at: null });
    expect(await activeMembers(team.teamId)).toEqual(sorted(alice));
    expect((await decideM(bob.token, invitation, { decision: "ACCEPT" })).status, "a declined offer cannot be accepted").toBe(409);

    // A request: the person names themselves.
    const asked = await proposeM(dave.token, team.teamId, { gamingMemberId: dave.gamingMemberId });
    expect(asked.status, asked.text).toBe(201);
    expect(asked.json.membership).toMatchObject({ status: "PENDING", initiatedBySide: "PERSON" });
    const requestId = asked.json.membership.lifetimeTeamMembershipId as string;
    expect(await membershipRow(requestId)).toMatchObject({ gaming_member_id: dave.gamingMemberId, initiated_by_side: "PERSON", initiated_by_gaming_member_id: dave.gamingMemberId });
    // …but a person cannot name somebody else, and cannot answer their own request.
    const unknownTeam = snapshot(await proposeM(dave.token, randomUUID(), { gamingMemberId: eve.gamingMemberId }));
    expect(snapshot(await proposeM(dave.token, team.teamId, { gamingMemberId: eve.gamingMemberId })), "a person who is not a leader cannot invite another").toEqual(unknownTeam);
    const unknownOffer = snapshot(await decideM(dave.token, randomUUID(), { decision: "ACCEPT" }));
    expect(snapshot(await decideM(dave.token, requestId, { decision: "ACCEPT" })), "the asker cannot answer their own request").toEqual(unknownOffer);
    expect(snapshot(await decideM(eve.token, requestId, { decision: "ACCEPT" })), "a stranger cannot answer it").toEqual(unknownOffer);
    expect((await membershipRow(requestId)).status).toBe("PENDING");
    // The captain answers it.
    const approved = await decideM(alice.token, requestId, { decision: "ACCEPT" });
    expect(approved.status, approved.text).toBe(200);
    expect(approved.json.membership).toMatchObject({ lifetimeTeamMembershipId: requestId, status: "ACTIVE" });
    expect(await membershipRow(requestId)).toMatchObject({ status: "ACTIVE", decided_by_gaming_member_id: alice.gamingMemberId });
    expect(await activeMembers(team.teamId)).toEqual(sorted(alice, dave));
  });

  it("the initiator may withdraw a pending offer — and the person who was offered cannot, nor can a stranger; a withdrawn offer is over", async () => {
    const alice = await member("Alice");
    const carol = await member("Carol");
    const eve = await member("Eve");
    const frank = await member("Frank");
    const team = await h.createTeam(alice);
    const offerId = (await proposeM(alice.token, team.teamId, { gamingMemberId: carol.gamingMemberId })).json.membership.lifetimeTeamMembershipId as string;

    const unknown = snapshot(await withdraw(alice.token, randomUUID(), { kind: "MEMBERSHIP" }));
    expect(unknown.status).toBe(404);
    expect(JSON.parse(unknown.text)).toEqual({ error: OFFER_NOT_FOUND });
    expect(snapshot(await withdraw(carol.token, offerId, { kind: "MEMBERSHIP" })), "the person who was offered (they decline instead)").toEqual(unknown);
    expect(snapshot(await withdraw(eve.token, offerId, { kind: "MEMBERSHIP" })), "a stranger").toEqual(unknown);
    expect(snapshot(await withdraw(alice.token, offerId, { kind: "LEADERSHIP" })), "the right id, the wrong kind: that offer does not exist in the other table").toEqual(unknown);
    expect(snapshot(await withdraw(eve.token, offerId, { kind: "MEMBERSHIP" }, { url: forgedQuery(paths.withdraw(offerId), alice.gamingMemberId), headers: forgedHeaders(alice.gamingMemberId) })), "a stranger who names the initiator").toEqual(unknown);
    expect((await membershipRow(offerId)).status).toBe("PENDING");

    const withdrawn = await withdraw(alice.token, offerId, { kind: "MEMBERSHIP" }, { headers: forgedHeaders(eve.gamingMemberId) });
    expect(withdrawn.status, withdrawn.text).toBe(200);
    expect(withdrawn.json).toEqual({ offer: { offerId, status: "ENDED" } });
    expect(await membershipRow(offerId)).toMatchObject({ status: "ENDED", end_reason: "WITHDRAWN", ended_by_gaming_member_id: alice.gamingMemberId });
    const repeat = await withdraw(alice.token, offerId, { kind: "MEMBERSHIP" });
    expect(repeat.status, repeat.text).toBe(409);
    expect(repeat.json).toEqual({ error: messageOf("OFFER_NOT_PENDING") });
    const lateAnswer = await decideM(carol.token, offerId, { decision: "ACCEPT" });
    expect(lateAnswer.status, "the person offered still has a right to know it is over").toBe(409);
    expect(lateAnswer.json).toEqual({ error: messageOf("OFFER_NOT_PENDING") });

    // A request is withdrawn by the person who made it, and by nobody else outside the team.
    const request = (await proposeM(frank.token, team.teamId, { gamingMemberId: frank.gamingMemberId })).json.membership.lifetimeTeamMembershipId as string;
    expect(snapshot(await withdraw(eve.token, request, { kind: "MEMBERSHIP" })), "a stranger cannot withdraw another person's request").toEqual(unknown);
    const retracted = await withdraw(frank.token, request, { kind: "MEMBERSHIP" });
    expect(retracted.status, retracted.text).toBe(200);
    expect(await membershipRow(request)).toMatchObject({ status: "ENDED", end_reason: "WITHDRAWN", ended_by_gaming_member_id: frank.gamingMemberId });
  });

  it("a lapsed offer is a bounded conflict — to accept it and to decline it — and the same people may then be offered again", async () => {
    const alice = await member("Alice");
    const bob = await member("Bob");
    const team = await h.createTeam(alice);
    const offerId = (await proposeM(alice.token, team.teamId, { gamingMemberId: bob.gamingMemberId })).json.membership.lifetimeTeamMembershipId as string;
    await h.lapseOffer("MEMBERSHIP", offerId);
    for (const decision of ["ACCEPT", "DECLINE"]) {
      const lapsed = await decideM(bob.token, offerId, { decision });
      expect(lapsed.status, `${decision}: ${lapsed.text}`).toBe(409);
      expect(lapsed.json).toEqual({ error: messageOf("OFFER_EXPIRED") });
      expectBounded(lapsed, decision);
    }
    expect(await activeMembers(team.teamId)).toEqual(sorted(alice));
    const fresh = await proposeM(alice.token, team.teamId, { gamingMemberId: bob.gamingMemberId });
    expect(fresh.status, "a lapsed offer does not block the next one").toBe(201);
    expect((await membershipRow(offerId)).end_reason, "the lapse is dated and recorded by the database, not by the route").toBe("EXPIRED");
  });
});

// =============================================================================================================================================
describe("ending a membership", () => {
  it("a member leaves; a leader removes an ordinary member; nobody else can; a leader can never be removed; a stranger learns nothing", async () => {
    const team = await h.buildTeam("End", 5);
    const [m1, m2, m3] = team.members;
    const captain = await withToken(team.captain);
    const sub = await withToken(team.subCaptain!);
    const tm1 = await withToken(m1);
    const tm2 = await withToken(m2);
    const eve = await member("Eve");
    const unknownTeam = snapshot(await endM(eve.token, randomUUID(), { gamingMemberId: m3.gamingMemberId }));
    expect(unknownTeam.status).toBe(404);
    expect(JSON.parse(unknownTeam.text)).toEqual({ error: TEAM_NOT_FOUND });
    const before = await teamState(team.teamId);

    // Nobody outside the leadership removes anybody: a stranger, and an ordinary member naming another.
    expect(snapshot(await endM(eve.token, team.teamId, { gamingMemberId: m3.gamingMemberId })), "a stranger").toEqual(unknownTeam);
    expect(snapshot(await endM(tm2.token, team.teamId, { gamingMemberId: m3.gamingMemberId })), "an ordinary member").toEqual(unknownTeam);
    expect(snapshot(await endM(eve.token, team.teamId, { gamingMemberId: m3.gamingMemberId }, { url: forgedQuery(paths.endMembership(team.teamId), captain.gamingMemberId), headers: forgedHeaders(captain.gamingMemberId) })), "a stranger who names the captain").toEqual(unknownTeam);
    // A person who does not belong cannot "leave" either, and says nothing about whether the team exists: the same 404.
    expect(snapshot(await endM(eve.token, team.teamId, { gamingMemberId: eve.gamingMemberId })), "a non-member leaving").toEqual(unknownTeam);
    expect(await teamState(team.teamId), "nothing changed").toEqual(before);

    // A member leaves — and the named subject is the session itself.
    const left = await endM(tm1.token, team.teamId, { gamingMemberId: m1.gamingMemberId }, { headers: forgedHeaders(captain.gamingMemberId) });
    expect(left.status, left.text).toBe(200);
    expect(Object.keys(left.json)).toEqual(["membership"]);
    expect(Object.keys(left.json.membership)).toEqual(["lifetimeTeamMembershipId", "endedAt", "successorLeadershipId"]);
    expect(left.json.membership.successorLeadershipId).toBeNull();
    expect(await membershipRow(left.json.membership.lifetimeTeamMembershipId)).toMatchObject({ gaming_member_id: m1.gamingMemberId, status: "ENDED", end_reason: "LEFT", ended_by_gaming_member_id: m1.gamingMemberId });
    expect((await list(tm1.token)).text, "the person who left no longer lists the team").toBe('{"teams":[]}');
    expect(await activeMembers(team.teamId)).toEqual(sorted(team.captain, team.subCaptain!, m2, m3));

    // A leader removes an ordinary member.
    const removed = await endM(captain.token, team.teamId, { gamingMemberId: m2.gamingMemberId });
    expect(removed.status, removed.text).toBe(200);
    expect(await membershipRow(removed.json.membership.lifetimeTeamMembershipId)).toMatchObject({ gaming_member_id: m2.gamingMemberId, status: "ENDED", end_reason: "REMOVED", ended_by_gaming_member_id: captain.gamingMemberId });
    // The sub-captain is a leader too, and removes an ordinary member as well.
    const subRemoved = await endM(sub.token, team.teamId, { gamingMemberId: m3.gamingMemberId });
    expect(subRemoved.status, subRemoved.text).toBe(200);
    expect(await membershipRow(subRemoved.json.membership.lifetimeTeamMembershipId)).toMatchObject({ gaming_member_id: m3.gamingMemberId, end_reason: "REMOVED", ended_by_gaming_member_id: sub.gamingMemberId });
    expect(await activeMembers(team.teamId)).toEqual(sorted(team.captain, team.subCaptain!));

    // A leader is never removed — by the captain or by the other leader — and the refusal is a bounded conflict (the caller is a leader, so nothing is disclosed).
    for (const [by, who] of [[captain, sub], [sub, captain]] as const) {
      const refused = await endM(by.token, team.teamId, { gamingMemberId: who.gamingMemberId });
      expect(refused.status, refused.text).toBe(409);
      expect(refused.json).toEqual({ error: messageOf("LEADER_CANNOT_BE_REMOVED") });
      expectBounded(refused, "leader removal");
    }
    // Removing somebody who does not belong is the uniform 404 (the caller learns nothing about who belongs).
    expect(snapshot(await endM(captain.token, team.teamId, { gamingMemberId: m3.gamingMemberId })), "removing a person who already left").toEqual(unknownTeam);
    expect(await activeMembers(team.teamId)).toEqual(sorted(team.captain, team.subCaptain!));
  });
});

// =============================================================================================================================================
describe("leadership: the sub-captain seat", () => {
  it("the captain offers the seat; a wrong party cannot answer; the offered member accepts; nobody else can offer, and the seat is taken once", async () => {
    const team = await h.buildTeam("Lead", 4, { subCaptain: false });
    const [m1, m2] = team.members;
    const captain = await withToken(team.captain);
    const t1 = await withToken(m1);
    const t2 = await withToken(m2);
    const eve = await member("Eve");
    const unknownTeam = snapshot(await offerL(eve.token, randomUUID(), { gamingMemberId: m1.gamingMemberId }));
    expect(unknownTeam.status).toBe(404);
    expect(JSON.parse(unknownTeam.text)).toEqual({ error: TEAM_NOT_FOUND });

    // Only the captain offers it.
    expect(snapshot(await offerL(t1.token, team.teamId, { gamingMemberId: m2.gamingMemberId })), "an ordinary member").toEqual(unknownTeam);
    expect(snapshot(await offerL(eve.token, team.teamId, { gamingMemberId: m1.gamingMemberId })), "a stranger").toEqual(unknownTeam);
    expect(snapshot(await offerL(eve.token, team.teamId, { gamingMemberId: m1.gamingMemberId }, { url: forgedQuery(paths.offerLeadership(team.teamId), captain.gamingMemberId), headers: forgedHeaders(captain.gamingMemberId) })), "a stranger who names the captain").toEqual(unknownTeam);
    expect(await seats(team.teamId)).toEqual([{ role: "CAPTAIN", gaming_member_id: team.captain.gamingMemberId }]);
    // What the captain may not offer is a bounded conflict: the captain's own seat, a person who does not belong.
    const self = await offerL(captain.token, team.teamId, { gamingMemberId: captain.gamingMemberId });
    expect(self.status, self.text).toBe(409);
    expect(self.json).toEqual({ error: messageOf("SEAT_SUBJECT_INVALID") });
    const outsider = await offerL(captain.token, team.teamId, { gamingMemberId: eve.gamingMemberId });
    expect(outsider.status, outsider.text).toBe(409);
    expect(outsider.json).toEqual({ error: messageOf("NOT_A_MEMBER") });
    for (const answer of [self, outsider]) expectBounded(answer, "offer conflict");

    // The offer, with the actor forged in every place a client could try.
    const offered = await offerL(captain.token, team.teamId, { gamingMemberId: m1.gamingMemberId }, { url: forgedQuery(paths.offerLeadership(team.teamId), m2.gamingMemberId), headers: forgedHeaders(m2.gamingMemberId) });
    expect(offered.status, offered.text).toBe(201);
    expect(Object.keys(offered.json)).toEqual(["leadership"]);
    expect(Object.keys(offered.json.leadership)).toEqual(["lifetimeTeamLeadershipId", "status", "expiresAt"]);
    expect(offered.json.leadership.status).toBe("PENDING");
    const seatId = offered.json.leadership.lifetimeTeamLeadershipId as string;
    expect(await leadershipRow(seatId)).toMatchObject({ lifetime_team_id: team.teamId, gaming_member_id: m1.gamingMemberId, role: "SUB_CAPTAIN", status: "PENDING", offered_by_gaming_member_id: captain.gamingMemberId });
    const taken = await offerL(captain.token, team.teamId, { gamingMemberId: m2.gamingMemberId });
    expect(taken.status, "a pending offer holds the seat").toBe(409);
    expect(taken.json).toEqual({ error: messageOf("SEAT_TAKEN") });

    // A wrong party cannot answer: the captain who made the offer, another member, a stranger — the 404 of an unknown offer.
    const unknownOffer = snapshot(await decideL(t1.token, randomUUID(), { decision: "ACCEPT" }));
    expect(unknownOffer.status).toBe(404);
    expect(JSON.parse(unknownOffer.text)).toEqual({ error: OFFER_NOT_FOUND });
    expect(snapshot(await decideL(captain.token, seatId, { decision: "ACCEPT" })), "the captain who offered").toEqual(unknownOffer);
    expect(snapshot(await decideL(t2.token, seatId, { decision: "ACCEPT" })), "another member").toEqual(unknownOffer);
    expect(snapshot(await decideL(eve.token, seatId, { decision: "ACCEPT" })), "a stranger").toEqual(unknownOffer);
    expect(snapshot(await decideL(t2.token, seatId, { decision: "ACCEPT" }, { url: forgedQuery(paths.decideLeadership(seatId), m1.gamingMemberId), headers: forgedHeaders(m1.gamingMemberId) })), "another member who names the offered one").toEqual(unknownOffer);
    expect((await leadershipRow(seatId)).status).toBe("PENDING");

    // The offered member accepts.
    const accepted = await decideL(t1.token, seatId, { decision: "ACCEPT" }, { headers: forgedHeaders(captain.gamingMemberId) });
    expect(accepted.status, accepted.text).toBe(200);
    expect(Object.keys(accepted.json)).toEqual(["leadership"]);
    expect(Object.keys(accepted.json.leadership)).toEqual(["lifetimeTeamLeadershipId", "status", "startedAt"]);
    expect(accepted.json.leadership).toMatchObject({ lifetimeTeamLeadershipId: seatId, status: "ACTIVE" });
    expect(Number.isNaN(Date.parse(accepted.json.leadership.startedAt))).toBe(false);
    expect(await seats(team.teamId)).toEqual([{ role: "CAPTAIN", gaming_member_id: team.captain.gamingMemberId }, { role: "SUB_CAPTAIN", gaming_member_id: m1.gamingMemberId }].sort((a, b) => a.role.localeCompare(b.role)));
    const answeredAgain = await decideL(t1.token, seatId, { decision: "ACCEPT" });
    expect(answeredAgain.status, answeredAgain.text).toBe(409);
    expect(answeredAgain.json).toEqual({ error: messageOf("OFFER_NOT_PENDING") });
    const second = await offerL(captain.token, team.teamId, { gamingMemberId: m2.gamingMemberId });
    expect(second.status, "an active seat is taken too").toBe(409);
    expect(second.json).toEqual({ error: messageOf("SEAT_TAKEN") });
    // The sub-captain is a leader, but only the captain offers the seat.
    expect(snapshot(await offerL(t1.token, team.teamId, { gamingMemberId: m2.gamingMemberId })), "the sub-captain").toEqual(unknownTeam);
  });

  it("the seat offer may be withdrawn by the captain who made it and by nobody who was offered it; it may be declined; it may lapse", async () => {
    const team = await h.buildTeam("Seat", 4, { subCaptain: false });
    const [m1, m2, m3] = team.members;
    const captain = await withToken(team.captain);
    const t1 = await withToken(m1);
    const t2 = await withToken(m2);
    const t3 = await withToken(m3);

    const first = (await offerL(captain.token, team.teamId, { gamingMemberId: m1.gamingMemberId })).json.leadership.lifetimeTeamLeadershipId as string;
    const unknownOffer = snapshot(await withdraw(captain.token, randomUUID(), { kind: "LEADERSHIP" }));
    expect(unknownOffer.status).toBe(404);
    expect(snapshot(await withdraw(t1.token, first, { kind: "LEADERSHIP" })), "the member who was offered the seat").toEqual(unknownOffer);
    expect(snapshot(await withdraw(t2.token, first, { kind: "LEADERSHIP" })), "another member").toEqual(unknownOffer);
    expect(snapshot(await withdraw(captain.token, first, { kind: "MEMBERSHIP" })), "the right id, the wrong kind").toEqual(unknownOffer);
    const withdrawn = await withdraw(captain.token, first, { kind: "LEADERSHIP" });
    expect(withdrawn.status, withdrawn.text).toBe(200);
    expect(withdrawn.json).toEqual({ offer: { offerId: first, status: "ENDED" } });
    expect(await leadershipRow(first)).toMatchObject({ status: "ENDED", end_reason: "WITHDRAWN", ended_by_gaming_member_id: captain.gamingMemberId });
    expect((await decideL(t1.token, first, { decision: "ACCEPT" })).json, "the person offered is told it is over").toEqual({ error: messageOf("OFFER_NOT_PENDING") });

    const second = (await offerL(captain.token, team.teamId, { gamingMemberId: m2.gamingMemberId })).json.leadership.lifetimeTeamLeadershipId as string;
    const declined = await decideL(t2.token, second, { decision: "DECLINE" });
    expect(declined.status, declined.text).toBe(200);
    expect(declined.json).toEqual({ leadership: { lifetimeTeamLeadershipId: second, status: "ENDED", startedAt: null } });
    expect(await leadershipRow(second)).toMatchObject({ status: "ENDED", end_reason: "DECLINED" });

    const third = (await offerL(captain.token, team.teamId, { gamingMemberId: m3.gamingMemberId })).json.leadership.lifetimeTeamLeadershipId as string;
    await h.lapseOffer("LEADERSHIP", third);
    const lapsed = await decideL(t3.token, third, { decision: "ACCEPT" });
    expect(lapsed.status, lapsed.text).toBe(409);
    expect(lapsed.json).toEqual({ error: messageOf("OFFER_EXPIRED") });
    expect(await seats(team.teamId)).toEqual([{ role: "CAPTAIN", gaming_member_id: team.captain.gamingMemberId }]);
  });

  it("the seat ends: the sub-captain steps down, the captain removes the sub-captain, nobody else may, and an empty seat is a bounded conflict", async () => {
    const team = await h.buildTeam("Seat", 4);
    const sub = await withToken(team.subCaptain!);
    const [m2] = team.members;
    const captain = await withToken(team.captain);
    const t2 = await withToken(m2);
    const eve = await member("Eve");
    const unknownTeam = snapshot(await endL(eve.token, randomUUID()));
    expect(unknownTeam.status).toBe(404);
    expect(JSON.parse(unknownTeam.text)).toEqual({ error: TEAM_NOT_FOUND });
    const before = await teamState(team.teamId);

    expect(snapshot(await endL(t2.token, team.teamId)), "an ordinary member").toEqual(unknownTeam);
    expect(snapshot(await endL(eve.token, team.teamId)), "a stranger").toEqual(unknownTeam);
    expect(snapshot(await endL(eve.token, team.teamId, { actorGamingMemberId: captain.gamingMemberId, gamingMemberId: captain.gamingMemberId }, { url: forgedQuery(paths.endLeadership(team.teamId), captain.gamingMemberId), headers: forgedHeaders(captain.gamingMemberId) })), "a stranger who names the captain (the body is never read)").toEqual(unknownTeam);
    expect(await teamState(team.teamId), "nothing changed").toEqual(before);

    // The sub-captain steps down — and stays a member.
    const stepped = await endL(sub.token, team.teamId);
    expect(stepped.status, stepped.text).toBe(200);
    expect(Object.keys(stepped.json)).toEqual(["leadership"]);
    expect(Object.keys(stepped.json.leadership)).toEqual(["lifetimeTeamLeadershipId", "endedAt", "endReason"]);
    expect(stepped.json.leadership.endReason).toBe("STEPPED_DOWN");
    expect(await leadershipRow(stepped.json.leadership.lifetimeTeamLeadershipId)).toMatchObject({ gaming_member_id: sub.gamingMemberId, role: "SUB_CAPTAIN", status: "ENDED", end_reason: "STEPPED_DOWN", ended_by_gaming_member_id: sub.gamingMemberId });
    expect(await activeMembers(team.teamId)).toContain(sub.gamingMemberId);
    expect(await seats(team.teamId)).toEqual([{ role: "CAPTAIN", gaming_member_id: captain.gamingMemberId }]);
    // The former sub-captain is an ordinary member now: the uniform 404. An empty seat is a conflict for the captain, who is allowed to know.
    expect(snapshot(await endL(sub.token, team.teamId)), "the former sub-captain").toEqual(unknownTeam);
    const empty = await endL(captain.token, team.teamId);
    expect(empty.status, empty.text).toBe(409);
    expect(empty.json).toEqual({ error: messageOf("SEAT_EMPTY") });
    expectBounded(empty, "empty seat");

    // The captain removes a sub-captain.
    const seatId = await h.makeSubCaptain(team.teamId, team.captain, m2);
    const removed = await endL(captain.token, team.teamId, undefined, { headers: forgedHeaders(m2.gamingMemberId) });
    expect(removed.status, removed.text).toBe(200);
    expect(removed.json.leadership).toMatchObject({ lifetimeTeamLeadershipId: seatId, endReason: "REMOVED" });
    expect(await leadershipRow(seatId)).toMatchObject({ gaming_member_id: m2.gamingMemberId, status: "ENDED", end_reason: "REMOVED", ended_by_gaming_member_id: captain.gamingMemberId });
    expect(await activeMembers(team.teamId), "removing the seat is not removing the person").toContain(m2.gamingMemberId);
  });

  it("any current leader may withdraw an invitation, including one the other leader made", async () => {
    const team = await h.buildTeam("Withdraw", 4);
    const sub = await withToken(team.subCaptain!);
    const captain = await withToken(team.captain);
    const outsider = await member("Outsider");
    const offerId = (await proposeM(captain.token, team.teamId, { gamingMemberId: outsider.gamingMemberId })).json.membership.lifetimeTeamMembershipId as string;
    const withdrawn = await withdraw(sub.token, offerId, { kind: "MEMBERSHIP" });
    expect(withdrawn.status, withdrawn.text).toBe(200);
    expect(await membershipRow(offerId)).toMatchObject({ status: "ENDED", end_reason: "WITHDRAWN", ended_by_gaming_member_id: sub.gamingMemberId });
  });
});

// =============================================================================================================================================
describe("departure: a captain cannot leave without a successor, and the successor must be the sub-captain", () => {
  it("a captain with a sub-captain hands the captaincy over by leaving — a named successor must be the sub-captain — and the new captain cannot leave in turn without one", async () => {
    const team = await h.buildTeam("Hand", 4);
    const [m2] = team.members;
    const captain = await withToken(team.captain);
    const sub = await withToken(team.subCaptain!);
    const before = await teamState(team.teamId);

    // Naming anyone but the sub-captain is refused, and nothing changes.
    const wrong = await endM(captain.token, team.teamId, { gamingMemberId: captain.gamingMemberId, successorGamingMemberId: m2.gamingMemberId });
    expect(wrong.status, wrong.text).toBe(409);
    expect(wrong.json).toEqual({ error: messageOf("SUCCESSOR_INVALID") });
    expectBounded(wrong, "wrong successor");
    expect(await teamState(team.teamId), "a refused hand-over changes nothing").toEqual(before);

    // The default successor is the sub-captain.
    const left = await endM(captain.token, team.teamId, { gamingMemberId: captain.gamingMemberId }, { headers: forgedHeaders(m2.gamingMemberId) });
    expect(left.status, left.text).toBe(200);
    expect(left.json.membership.successorLeadershipId).toMatch(UUID);
    const successorSeat = left.json.membership.successorLeadershipId as string;
    expect(await leadershipRow(successorSeat)).toMatchObject({ gaming_member_id: sub.gamingMemberId, role: "CAPTAIN", status: "ACTIVE", ended_at: null });
    expect(await seats(team.teamId)).toEqual([{ role: "CAPTAIN", gaming_member_id: sub.gamingMemberId }]);
    expect(await membershipRow(left.json.membership.lifetimeTeamMembershipId)).toMatchObject({ gaming_member_id: captain.gamingMemberId, status: "ENDED", end_reason: "LEFT" });
    expect((await list(captain.token)).text, "the former captain no longer lists the team").toBe('{"teams":[]}');
    expect((await list(sub.token)).json.teams.map((t: any) => t.lifetimeTeamId), "the new captain does").toEqual([team.teamId]);

    // The new captain has no sub-captain: leaving needs one first.
    const needs = await endM(sub.token, team.teamId, { gamingMemberId: sub.gamingMemberId });
    expect(needs.status, needs.text).toBe(409);
    expect(needs.json).toEqual({ error: messageOf("CAPTAIN_NEEDS_SUCCESSOR") });
    expectBounded(needs, "captain needs a successor");
    expect(await seats(team.teamId)).toEqual([{ role: "CAPTAIN", gaming_member_id: sub.gamingMemberId }]);
    // The former captain is nobody to this team any more.
    const unknownTeam = snapshot(await endM(captain.token, randomUUID(), { gamingMemberId: captain.gamingMemberId }));
    expect(snapshot(await endM(captain.token, team.teamId, { gamingMemberId: sub.gamingMemberId })), "the former captain removing the new one").toEqual(unknownTeam);
  });

  it("a named successor that IS the sub-captain is accepted; a sub-captain who leaves steps down — and then the captain is again held to the successor rule", async () => {
    const named = await h.buildTeam("Named", 3);
    const namedCaptain = await withToken(named.captain);
    const done = await endM(namedCaptain.token, named.teamId, { gamingMemberId: namedCaptain.gamingMemberId, successorGamingMemberId: named.subCaptain!.gamingMemberId });
    expect(done.status, done.text).toBe(200);
    expect(await leadershipRow(done.json.membership.successorLeadershipId)).toMatchObject({ gaming_member_id: named.subCaptain!.gamingMemberId, role: "CAPTAIN", status: "ACTIVE" });

    const team = await h.buildTeam("Step", 3);
    const captain = await withToken(team.captain);
    const sub = await withToken(team.subCaptain!);
    const stepped = await endM(sub.token, team.teamId, { gamingMemberId: sub.gamingMemberId });
    expect(stepped.status, stepped.text).toBe(200);
    expect(stepped.json.membership.successorLeadershipId, "a sub-captain has nobody to hand over to").toBeNull();
    expect(await rawQuery("select status, end_reason from lifetime_team_leaderships where gaming_member_id = $1 and lifetime_team_id = $2 and role = 'SUB_CAPTAIN'", [sub.gamingMemberId, team.teamId])).toEqual([{ status: "ENDED", end_reason: "STEPPED_DOWN" }]);
    expect(await membershipRow(stepped.json.membership.lifetimeTeamMembershipId)).toMatchObject({ gaming_member_id: sub.gamingMemberId, end_reason: "LEFT" });
    const needs = await endM(captain.token, team.teamId, { gamingMemberId: captain.gamingMemberId });
    expect(needs.status, needs.text).toBe(409);
    expect(needs.json).toEqual({ error: messageOf("CAPTAIN_NEEDS_SUCCESSOR") });
    expect(await seats(team.teamId)).toEqual([{ role: "CAPTAIN", gaming_member_id: captain.gamingMemberId }]);
  });
});

// =============================================================================================================================================
describe("CFM-012 — the member's own pending offers (GET /lifetime-offers)", () => {
  const teamView = async (teamId: string) => {
    const [t] = await rawQuery("select public_code, name from lifetime_teams where lifetime_team_id = $1", [teamId]);
    return { lifetimeTeamId: teamId, publicCode: t.public_code as string, name: t.name as string };
  };
  const who = (p: Person) => ({ gamingMemberId: p.gamingMemberId, displayName: p.displayName });
  type Team = Awaited<ReturnType<typeof teamView>>;
  const entry = (kind: "MEMBERSHIP" | "LEADERSHIP", offerId: string, direction: "INCOMING" | "OUTGOING", team: Team, counterparty: ReturnType<typeof who> | null, expiresAt: string) =>
    ({ kind, offerId, direction, team, counterparty, expiresAt });
  const KEYS = ["kind", "offerId", "direction", "team", "counterparty", "expiresAt"];
  const offersOf = async (token: string, extra: Extra = {}) => {
    const answer = await inbox(token, extra);
    expect(answer.status, answer.text).toBe(200);
    expect(answer.cache).toBe(NO_STORE);
    expect(Object.keys(answer.json)).toEqual(["offers"]);
    for (const o of answer.json.offers) {
      expect(Object.keys(o)).toEqual(KEYS);
      expect(Object.keys(o.team)).toEqual(["lifetimeTeamId", "publicCode", "name"]);
      if (o.counterparty !== null) expect(Object.keys(o.counterparty)).toEqual(["gamingMemberId", "displayName"]);
    }
    return { offers: answer.json.offers as any[], text: answer.text };
  };
  const created = (answer: Answer) => { expect(answer.status, answer.text).toBe(201); return answer.json.membership ?? answer.json.leadership; };

  it("an invitation is OUTGOING for the leader who made it and INCOMING for the invited member — with exactly the other person as the counterparty, no PII, and nothing for anyone else, the other leader included", async () => {
    const team = await h.buildTeam("Inbox", 4);
    const captain = await withToken(team.captain);
    const sub = await withToken(team.subCaptain!);
    const [m1] = team.members;
    const t1 = await withToken(m1);
    const eve = await member("Eve");
    const ivan = await member("Ivan");
    const view = await teamView(team.teamId);

    expect((await offersOf(ivan.token)).text, "before any offer").toBe('{"offers":[]}');
    const invited = created(await proposeM(captain.token, team.teamId, { gamingMemberId: ivan.gamingMemberId }));
    const expected = (direction: "INCOMING" | "OUTGOING", counterparty: Person) => [entry("MEMBERSHIP", invited.lifetimeTeamMembershipId, direction, view, who(counterparty), invited.expiresAt)];

    const theirs = await offersOf(ivan.token);
    expect(theirs.offers, "the invited member").toEqual(expected("INCOMING", captain));
    const mine = await offersOf(captain.token);
    expect(mine.offers, "the leader who invited").toEqual(expected("OUTGOING", ivan));
    expect((await offersOf(sub.token)).offers, "the other leader never sees an invitation somebody else made").toEqual([]);
    expect((await offersOf(t1.token)).offers, "an ordinary member of the team").toEqual([]);
    expect((await offersOf(eve.token)).offers, "an unrelated member").toEqual([]);

    // Nothing but the contract's fields: no email, no auth id, no phone — in either answer, for anyone involved.
    for (const text of [theirs.text, mine.text]) {
      for (const person of [captain, ivan, sub, eve]) {
        expect(text).not.toContain(person.email);
        expect(text).not.toContain(person.authUserId);
      }
      expect(text).not.toMatch(/@example\.com|auth_user|email|phone|created|status|initiated/i);
    }
    // Once answered it is no longer pending: nobody sees it.
    expect((await decideM(ivan.token, invited.lifetimeTeamMembershipId, { decision: "ACCEPT" })).status).toBe(200);
    for (const person of [ivan, captain]) expect((await offersOf(person.token)).offers, "an accepted offer").toEqual([]);
  });

  it("a person's own join request is OUTGOING for that person (no counterparty) and INCOMING for the team's CURRENT captain and sub-captain — never for an ordinary member, a stranger, or a leader whose seat has ended", async () => {
    const team = await h.buildTeam("Request", 4);
    const captain = await withToken(team.captain);
    const sub = await withToken(team.subCaptain!);
    const t1 = await withToken(team.members[0]);
    const eve = await member("Eve");
    const dave = await member("Dave");
    const view = await teamView(team.teamId);
    const request = created(await proposeM(dave.token, team.teamId, { gamingMemberId: dave.gamingMemberId }));
    const id = request.lifetimeTeamMembershipId as string;

    expect((await offersOf(dave.token)).offers, "the requester").toEqual([entry("MEMBERSHIP", id, "OUTGOING", view, null, request.expiresAt)]);
    for (const leader of [captain, sub]) expect((await offersOf(leader.token)).offers, "a current leader").toEqual([entry("MEMBERSHIP", id, "INCOMING", view, who(dave), request.expiresAt)]);
    for (const outsider of [t1, eve]) expect((await offersOf(outsider.token)).offers, "an ordinary member or a stranger").toEqual([]);

    // The sub-captain steps down: the request is no longer theirs to see; the captain's inbox is unchanged.
    expect((await endL(sub.token, team.teamId)).status).toBe(200);
    expect((await offersOf(sub.token)).offers, "a former sub-captain").toEqual([]);
    expect((await offersOf(captain.token)).offers.map((o: any) => o.offerId)).toEqual([id]);
    // The captain answers it: it is gone for everybody.
    expect((await decideM(captain.token, id, { decision: "ACCEPT" })).status).toBe(200);
    for (const person of [dave, captain, sub]) expect((await offersOf(person.token)).offers).toEqual([]);
  });

  it("a seat offer is OUTGOING for the captain who made it and INCOMING for the member offered; every other member sees nothing — and the offer leaves the inbox when it is accepted, declined or withdrawn", async () => {
    const team = await h.buildTeam("Seat", 5, { subCaptain: false });
    const [m1, m2, m3] = team.members;
    const captain = await withToken(team.captain);
    const [t1, t2, t3] = await Promise.all([m1, m2, m3].map(withToken));
    const eve = await member("Eve");
    const view = await teamView(team.teamId);

    const offer = created(await offerL(captain.token, team.teamId, { gamingMemberId: m1.gamingMemberId }));
    const id = offer.lifetimeTeamLeadershipId as string;
    expect((await offersOf(captain.token)).offers).toEqual([entry("LEADERSHIP", id, "OUTGOING", view, who(m1), offer.expiresAt)]);
    expect((await offersOf(t1.token)).offers).toEqual([entry("LEADERSHIP", id, "INCOMING", view, who(captain), offer.expiresAt)]);
    for (const other of [t2, t3, eve]) expect((await offersOf(other.token)).offers, "another member of the team, or a stranger").toEqual([]);

    expect((await decideL(t1.token, id, { decision: "ACCEPT" })).status).toBe(200);
    for (const person of [captain, t1]) expect((await offersOf(person.token)).offers, "an accepted seat").toEqual([]);
    expect((await endL(t1.token, team.teamId)).status).toBe(200);

    const toWithdraw = created(await offerL(captain.token, team.teamId, { gamingMemberId: m2.gamingMemberId }));
    expect((await offersOf(t2.token)).offers.map((o: any) => o.offerId)).toEqual([toWithdraw.lifetimeTeamLeadershipId]);
    expect((await withdraw(captain.token, toWithdraw.lifetimeTeamLeadershipId, { kind: "LEADERSHIP" })).status).toBe(200);
    for (const person of [captain, t2]) expect((await offersOf(person.token)).offers, "a withdrawn seat offer").toEqual([]);

    const toDecline = created(await offerL(captain.token, team.teamId, { gamingMemberId: m3.gamingMemberId }));
    expect((await decideL(t3.token, toDecline.lifetimeTeamLeadershipId, { decision: "DECLINE" })).status).toBe(200);
    for (const person of [captain, t3]) expect((await offersOf(person.token)).offers, "a declined seat offer").toEqual([]);
  });

  it("an invitation that is declined or withdrawn, and one that lapsed and was replaced, are never shown", async () => {
    const team = await h.buildTeam("Ended", 3);
    const captain = await withToken(team.captain);
    const ivan = await member("Ivan");
    const view = await teamView(team.teamId);
    const gone = async (note: string) => { for (const person of [captain, ivan]) expect((await offersOf(person.token)).offers, note).toEqual([]); };

    const first = created(await proposeM(captain.token, team.teamId, { gamingMemberId: ivan.gamingMemberId }));
    expect((await decideM(ivan.token, first.lifetimeTeamMembershipId, { decision: "DECLINE" })).status).toBe(200);
    await gone("declined");
    const second = created(await proposeM(captain.token, team.teamId, { gamingMemberId: ivan.gamingMemberId }));
    expect((await offersOf(ivan.token)).offers.map((o: any) => o.offerId)).toEqual([second.lifetimeTeamMembershipId]);
    expect((await withdraw(captain.token, second.lifetimeTeamMembershipId, { kind: "MEMBERSHIP" })).status).toBe(200);
    await gone("withdrawn");
    // A lapsed offer is still PENDING until something dates its end; a new offer for the same person ends it, and only the new one is shown.
    const third = created(await proposeM(captain.token, team.teamId, { gamingMemberId: ivan.gamingMemberId }));
    await h.lapseOffer("MEMBERSHIP", third.lifetimeTeamMembershipId);
    const fourth = created(await proposeM(captain.token, team.teamId, { gamingMemberId: ivan.gamingMemberId }));
    expect((await offersOf(ivan.token)).offers).toEqual([entry("MEMBERSHIP", fourth.lifetimeTeamMembershipId, "INCOMING", view, who(captain), fourth.expiresAt)]);
    expect((await membershipRow(third.lifetimeTeamMembershipId)).end_reason).toBe("EXPIRED");
  });

  it("a pending offer whose expiry has PASSED is still listed — exactly as stored, with no 'actionable' or 'expired' invented — and the decision operation remains the authority on it", async () => {
    const team = await h.buildTeam("Lapsed", 3);
    const captain = await withToken(team.captain);
    const ivan = await member("Ivan");
    const view = await teamView(team.teamId);
    const invited = created(await proposeM(captain.token, team.teamId, { gamingMemberId: ivan.gamingMemberId }));
    await h.lapseOffer("MEMBERSHIP", invited.lifetimeTeamMembershipId);
    const [row] = await rawQuery("select expires_at from lifetime_team_memberships where lifetime_team_membership_id = $1", [invited.lifetimeTeamMembershipId]);
    const shown = await offersOf(ivan.token);
    expect(shown.offers).toHaveLength(1);
    expect(shown.offers[0]).toMatchObject({ kind: "MEMBERSHIP", offerId: invited.lifetimeTeamMembershipId, direction: "INCOMING", team: view });
    expect(Date.parse(shown.offers[0].expiresAt), "the stored instant, in the past").toBeLessThan(Date.now());
    expect(Math.abs(Date.parse(shown.offers[0].expiresAt) - row.expires_at.getTime())).toBeLessThanOrEqual(1);
    expect(shown.text, "no flag of any kind is added to the entry (judged by key: the synthetic team's own name contains words)").not.toMatch(/"(actionable|expired|status|lapsed|isExpired|canAccept)"\s*:/i);
    const decided = await decideM(ivan.token, invited.lifetimeTeamMembershipId, { decision: "ACCEPT" });
    expect(decided.status, "the decision operation, not the read, judges the expiry").toBe(409);
    expect(decided.json).toEqual({ error: messageOf("OFFER_EXPIRED") });
  });

  it("offers of another team are invisible: each member sees only the offers they are party to, or lead the team of — and an unrelated member gets the empty inbox", async () => {
    const one = await h.buildTeam("One", 3);
    const two = await h.buildTeam("Two", 3);
    const c1 = await withToken(one.captain);
    const c2 = await withToken(two.captain);
    const ivan = await member("Ivan");
    const eve = await member("Eve");
    const nobody = await member("Nobody");
    const asked = created(await proposeM(ivan.token, one.teamId, { gamingMemberId: ivan.gamingMemberId }));
    const invited = created(await proposeM(c2.token, two.teamId, { gamingMemberId: eve.gamingMemberId }));
    expect((await offersOf(c1.token)).offers.map((o: any) => o.offerId), "the first team's captain: its own request only").toEqual([asked.lifetimeTeamMembershipId]);
    expect((await offersOf(c2.token)).offers.map((o: any) => o.offerId), "the second team's captain: its own invitation only").toEqual([invited.lifetimeTeamMembershipId]);
    expect((await offersOf(ivan.token)).offers.map((o: any) => o.offerId)).toEqual([asked.lifetimeTeamMembershipId]);
    expect((await offersOf(eve.token)).offers.map((o: any) => o.offerId)).toEqual([invited.lifetimeTeamMembershipId]);
    for (const ordinary of [...one.members, ...two.members]) expect((await offersOf(await h.tokenFor(ordinary))).offers, "ordinary members of either team").toEqual([]);
    expect((await offersOf(nobody.token)).text).toBe('{"offers":[]}');
  });

  it("no query, header or body can redirect the inbox: it is always the verified member's own", async () => {
    const team = await h.buildTeam("Redirect", 3);
    const captain = await withToken(team.captain);
    const ivan = await member("Ivan");
    const eve = await member("Eve");
    const invited = created(await proposeM(captain.token, team.teamId, { gamingMemberId: ivan.gamingMemberId }));
    const aim = (target: Person) => ({
      url: `${BASE}/lifetime-offers?gamingMemberId=${target.gamingMemberId}&memberId=${target.gamingMemberId}&member=${target.gamingMemberId}&captain=${target.gamingMemberId}&teamId=${team.teamId}&offerId=${invited.lifetimeTeamMembershipId}&direction=OUTGOING&kind=MEMBERSHIP`,
      headers: { "x-gaming-member-id": target.gamingMemberId, "x-actor": target.gamingMemberId },
    });
    expect((await offersOf(eve.token, aim(captain))).offers, "a stranger aiming at the captain, or at the invitee").toEqual([]);
    expect((await offersOf(eve.token, aim(ivan))).offers).toEqual([]);
    expect((await offersOf(ivan.token, aim(eve))).offers.map((o: any) => [o.offerId, o.direction])).toEqual([[invited.lifetimeTeamMembershipId, "INCOMING"]]);
    expect((await offersOf(captain.token, aim(ivan))).offers.map((o: any) => [o.offerId, o.direction])).toEqual([[invited.lifetimeTeamMembershipId, "OUTGOING"]]);
    // knowing an offer's identifier shows nothing either: there is no lookup, and the withdrawal route gives a stranger the uniform 404
    expect((await withdraw(eve.token, invited.lifetimeTeamMembershipId, { kind: "MEMBERSHIP" })).status).toBe(404);
  });

  it("the order is the order of creation — across both kinds of offer — and it is the same every time", async () => {
    const [c1, c2, c3, c4] = await Promise.all(["Cap1", "Cap2", "Cap3", "Cap4"].map(member));
    const ivan = await member("Ivan");
    const t1 = await h.createTeam(c1);
    const t2 = await h.createTeam(c2);
    const t3 = await h.createTeam(c3);
    const t4 = await h.createTeam(c4);
    await h.addMember(t4.teamId, c4, ivan);                        // Ivan is an ordinary member of the fourth team
    const first = created(await proposeM(c1.token, t1.teamId, { gamingMemberId: ivan.gamingMemberId }));
    const second = created(await proposeM(c2.token, t2.teamId, { gamingMemberId: ivan.gamingMemberId }));
    const seat = created(await offerL(c4.token, t4.teamId, { gamingMemberId: ivan.gamingMemberId }));
    const third = created(await proposeM(c3.token, t3.teamId, { gamingMemberId: ivan.gamingMemberId }));
    const expected = [first.lifetimeTeamMembershipId, second.lifetimeTeamMembershipId, seat.lifetimeTeamLeadershipId, third.lifetimeTeamMembershipId];
    for (let round = 0; round < 3; round++) {
      const shown = await offersOf(ivan.token);
      expect(shown.offers.map((o: any) => o.offerId), `round ${round}`).toEqual(expected);
      expect(shown.offers.map((o: any) => [o.kind, o.direction])).toEqual([["MEMBERSHIP", "INCOMING"], ["MEMBERSHIP", "INCOMING"], ["LEADERSHIP", "INCOMING"], ["MEMBERSHIP", "INCOMING"]]);
    }
    const [early] = await rawQuery<{ n: number }>("select count(*)::int as n from lifetime_team_memberships where gaming_member_id = $1 and status = 'PENDING'", [ivan.gamingMemberId]);
    expect(early.n, "three invitations are pending (the seat offer is the fourth thing in the inbox)").toBe(3);
  });
});

// =============================================================================================================================================
describe("actor-forging fields do nothing, on any of the seven routes", () => {
  it("a stranger who names the authority as the actor — in the body, the query and the headers — is refused or is still the stranger, and nothing changes", async () => {
    const team = await h.buildTeam("Forge", 4);
    const captain = await withToken(team.captain);
    const sub = await withToken(team.subCaptain!);
    const [m2] = team.members;
    const eve = await member("Eve");
    const candidate = await h.newPerson("Candidate");
    const invitation = (await proposeM(captain.token, team.teamId, { gamingMemberId: candidate.gamingMemberId })).json.membership.lifetimeTeamMembershipId as string;
    const before = await teamState(team.teamId);

    const actorFields = (actor: string) => ({ actorGamingMemberId: actor, actor, captainGamingMemberId: actor, leaderGamingMemberId: actor, callerGamingMemberId: actor, authority: "CAPTAIN", role: "CAPTAIN", status: "ACTIVE" });
    for (const authority of [captain, sub]) {
      // In the body: refused as extra fields, on every route that reads one.
      const bodies = await Promise.all([
        proposeM(eve.token, team.teamId, { gamingMemberId: candidate.gamingMemberId, ...actorFields(authority.gamingMemberId) }),
        decideM(eve.token, invitation, { decision: "ACCEPT", ...actorFields(authority.gamingMemberId) }),
        withdraw(eve.token, invitation, { kind: "MEMBERSHIP", ...actorFields(authority.gamingMemberId) }),
        endM(eve.token, team.teamId, { gamingMemberId: m2.gamingMemberId, ...actorFields(authority.gamingMemberId) }),
        offerL(eve.token, team.teamId, { gamingMemberId: m2.gamingMemberId, ...actorFields(authority.gamingMemberId) }),
        decideL(eve.token, randomUUID(), { decision: "ACCEPT", ...actorFields(authority.gamingMemberId) }),
      ]);
      for (const answer of bodies) {
        expect(answer.status, answer.text).toBe(400);
        expectBounded(answer, "forged body");
      }
      // In the query and the headers: ignored — the caller is who the session says, a stranger.
      const forged = (url: string) => ({ url: forgedQuery(url, authority.gamingMemberId), headers: forgedHeaders(authority.gamingMemberId) });
      const unknownTeam = snapshot(await proposeM(eve.token, randomUUID(), { gamingMemberId: candidate.gamingMemberId }));
      const unknownOffer = snapshot(await decideM(eve.token, randomUUID(), { decision: "ACCEPT" }));
      expect(snapshot(await proposeM(eve.token, team.teamId, { gamingMemberId: candidate.gamingMemberId }, forged(paths.propose(team.teamId))))).toEqual(unknownTeam);
      expect(snapshot(await decideM(eve.token, invitation, { decision: "ACCEPT" }, forged(paths.decideMembership(invitation))))).toEqual(unknownOffer);
      expect(snapshot(await withdraw(eve.token, invitation, { kind: "MEMBERSHIP" }, forged(paths.withdraw(invitation))))).toEqual(unknownOffer);
      expect(snapshot(await endM(eve.token, team.teamId, { gamingMemberId: m2.gamingMemberId }, forged(paths.endMembership(team.teamId))))).toEqual(unknownTeam);
      expect(snapshot(await offerL(eve.token, team.teamId, { gamingMemberId: m2.gamingMemberId }, forged(paths.offerLeadership(team.teamId))))).toEqual(unknownTeam);
      expect(snapshot(await endL(eve.token, team.teamId, undefined, forged(paths.endLeadership(team.teamId))))).toEqual(unknownTeam);
    }
    expect(await teamState(team.teamId), "no forged call changed a single row").toEqual(before);
    expect((await membershipRow(invitation)).status).toBe("PENDING");
  });
});

// =============================================================================================================================================
describe("privileges and availability", () => {
  it("no browser role can write the lifetime tables or call the operations the routes use — and nothing they try changes a team", async () => {
    const alice = await member("Alice");
    const bob = await h.newPerson("Bob");
    const team = await h.createTeam(alice);
    const offerId = (await proposeM(alice.token, team.teamId, { gamingMemberId: bob.gamingMemberId })).json.membership.lifetimeTeamMembershipId as string;
    const before = await teamState(team.teamId);
    const clients: Array<[string, Awaited<ReturnType<typeof h.authenticatedClient>>]> = [["anon", h.anon], ["authenticated", await h.authenticatedClient()]];
    const tables = ["lifetime_team_memberships", "lifetime_team_leaderships", "lifetime_team_events"];
    // Well-formed requests with real column names, so the only thing that can refuse them is the privilege (a strict 42501, never an empty result or a schema error).
    const WRITES: Record<string, { insert: Record<string, unknown>; update: Record<string, unknown> }> = {
      lifetime_team_memberships: { insert: { lifetime_team_id: team.teamId, gaming_member_id: bob.gamingMemberId, status: "ACTIVE", initiated_by_side: "PERSON" }, update: { status: "ACTIVE" } },
      lifetime_team_leaderships: { insert: { lifetime_team_id: team.teamId, gaming_member_id: bob.gamingMemberId, role: "SUB_CAPTAIN", status: "ACTIVE" }, update: { status: "ENDED" } },
      lifetime_team_events: { insert: { lifetime_team_id: team.teamId, event_type: "MEMBERSHIP_ACTIVATED" }, update: { event_type: "MEMBERSHIP_ENDED" } },
    };
    const OPERATIONS: Array<[string, Record<string, unknown>]> = [
      ["propose_lifetime_team_membership_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: alice.gamingMemberId, p_subject_gaming_member_id: bob.gamingMemberId }],
      ["decide_lifetime_team_membership_atomically", { p_lifetime_team_membership_id: offerId, p_actor_gaming_member_id: bob.gamingMemberId, p_decision: "ACCEPT" }],
      ["withdraw_lifetime_team_offer_atomically", { p_offer_kind: "MEMBERSHIP", p_offer_id: offerId, p_actor_gaming_member_id: alice.gamingMemberId }],
      ["end_lifetime_team_membership_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: alice.gamingMemberId, p_subject_gaming_member_id: alice.gamingMemberId, p_successor_gaming_member_id: null }],
      ["offer_lifetime_team_leadership_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: alice.gamingMemberId, p_subject_gaming_member_id: bob.gamingMemberId }],
      ["decide_lifetime_team_leadership_atomically", { p_lifetime_team_leadership_id: randomUUID(), p_actor_gaming_member_id: bob.gamingMemberId, p_decision: "ACCEPT" }],
      ["end_lifetime_team_leadership_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: alice.gamingMemberId }],
    ];

    for (const [role, client] of clients) {
      for (const table of tables) {
        const write = WRITES[table];
        const inserted = await client.from(table).insert(write.insert);
        expect(inserted.error?.code, `${role} insert into ${table}: ${JSON.stringify(inserted.error)}`).toBe("42501");
        const updated = await client.from(table).update(write.update).eq("lifetime_team_id", team.teamId).select();
        expect(updated.error?.code, `${role} update ${table}: ${JSON.stringify(updated.error)}`).toBe("42501");
        const deleted = await client.from(table).delete().eq("lifetime_team_id", team.teamId).select();
        expect(deleted.error?.code, `${role} delete from ${table}: ${JSON.stringify(deleted.error)}`).toBe("42501");
        const read = await client.from(table).select("*").limit(1);
        expect(read.error?.code, `${role} select from ${table}: ${JSON.stringify(read.error)}`).toBe("42501");
      }
      for (const [name, args] of OPERATIONS) {
        const result = await client.rpc(name, args);
        expect(result.error?.code, `${role} ${name}: ${JSON.stringify(result.error)}`).toBe("42501");
      }
    }

    // The catalog says the same: only the service role may execute the seven operations, and no browser role holds any privilege on the tables.
    const operations = await rawQuery(
      `select p.proname, has_function_privilege('anon', p.oid, 'execute') as anon, has_function_privilege('authenticated', p.oid, 'execute') as authenticated,
              has_function_privilege('service_role', p.oid, 'execute') as service
         from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = any($1) order by p.proname`, [OPERATIONS.map(([name]) => name)]);
    expect(operations).toEqual(OPERATIONS.map(([name]) => ({ proname: name, anon: false, authenticated: false, service: true })).sort((a, b) => a.proname.localeCompare(b.proname)));
    for (const table of tables) {
      for (const role of ["anon", "authenticated"]) {
        for (const privilege of ["select", "insert", "update", "delete", "truncate", "references", "trigger"]) {
          const [{ held }] = await rawQuery<{ held: boolean }>("select has_table_privilege($1, $2, $3) as held", [role, `public.${table}`, privilege]);
          expect(held, `${role} must not hold ${privilege} on ${table}`).toBe(false);
        }
      }
    }
    expect(await teamState(team.teamId), "nothing a browser role tried changed the team").toEqual(before);
  });

  it("with the capability off, every route and the inbox answer the bounded 503 before anything happens — even for a valid session", async () => {
    const alice = await member("Alice");
    const bob = await h.newPerson("Bob");
    const team = await h.createTeam(alice);
    const offerId = (await proposeM(alice.token, team.teamId, { gamingMemberId: bob.gamingMemberId })).json.membership.lifetimeTeamMembershipId as string;
    const before = await teamState(team.teamId);
    process.env.COMPETITIONS_SCHEMA_READY = "false";
    try {
      const answers = [
        await proposeM(alice.token, team.teamId, { gamingMemberId: randomUUID() }),
        await decideM(alice.token, offerId, { decision: "DECLINE" }),
        await withdraw(alice.token, offerId, { kind: "MEMBERSHIP" }),
        await endM(alice.token, team.teamId, { gamingMemberId: alice.gamingMemberId }),
        await offerL(alice.token, team.teamId, { gamingMemberId: bob.gamingMemberId }),
        await decideL(alice.token, randomUUID(), { decision: "ACCEPT" }),
        await endL(alice.token, team.teamId),
        await proposeM(alice.token, "test-id", "not json {{{"),
        await inbox(alice.token),
      ];
      for (const answer of answers) {
        expect(answer.status, answer.text).toBe(503);
        expect(answer.json).toEqual({ error: UNAVAILABLE_503 });
        expect(answer.cache).toBe(NO_STORE);
      }
    } finally {
      process.env.COMPETITIONS_SCHEMA_READY = "true";
    }
    expect(await teamState(team.teamId), "a closed capability changes nothing").toEqual(before);
  });
});

// =============================================================================================================================================
describe("every response of this file", () => {
  it("was uncached and carried no secret, no token and no database text", () => {
    expect(log.length, "the earlier scenarios must have produced their responses").toBeGreaterThan(150);
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
