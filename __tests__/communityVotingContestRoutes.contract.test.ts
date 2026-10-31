import { randomUUID } from "node:crypto";

import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { SupabaseSessionRepository } from "../lib/session/db/supabaseSessionRepository";
import { createSession } from "../lib/session/createSession";
import { setSessionCapabilities } from "../lib/session/setSessionCapabilities";
import { lockLobby } from "../lib/session/lockLobby";
import { GALLERY_CONSENT_VERSION } from "../lib/gaming/communityVoting/rounds/constants";
import { DELIVERY_VERSION, REQUIREMENTS_VERSION } from "../lib/gaming/communityVoting/contest/registration";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";
import { SYNTHETIC_JPEG_B64 } from "./helpers/syntheticPhoto";

import { POST as registerCategoryRoute } from "../app/api/gaming/community-voting/rounds/route";
import { PUT as scheduleRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/schedule/route";
import { POST as registrationRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/registration/route";
import { POST as bindingRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/binding/route";
import { GET as statusRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/status/route";
import { GET as galleryRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/gallery/route";
import { POST as intentsRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/intents/route";
import { POST as votesRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/votes/route";
import { GET as publicResultsRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/results/route";
import { GET as slideshowRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/slideshow/route";
import { GET as photoRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/photos/[alias]/route";
import { GET as overviewRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/operator/overview/route";
import { GET as findRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/operator/candidacies/route";
import { POST as photoUploadRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/operator/entries/[entryId]/photo/route";
import { POST as consentRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/operator/entries/[entryId]/consent/route";
import { POST as decisionRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/operator/entries/[entryId]/decision/route";
import { POST as confirmationRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/operator/entries/[entryId]/confirmation/route";
import { PUT as nameRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/operator/entries/[entryId]/name/route";
import { POST as contactRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/operator/entries/[entryId]/contact/route";
import { POST as deliveryRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/operator/entries/[entryId]/delivery/route";
import { POST as openRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/operator/open/route";
import { POST as closeRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/operator/close/route";
import { GET as operatorResultsRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/operator/results/route";
import { POST as reviewRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/operator/review/route";
import { POST as publishRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/operator/publish/route";
import { PUT as listingRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/operator/listing/route";
import { GET as contestRoute } from "../app/api/gaming/community-voting/contests/[contestId]/route";
import { GET as mineRoute } from "../app/api/gaming/community-voting/contests/[contestId]/mine/route";
import { GET as fichaRoute } from "../app/api/gaming/community-voting/contests/[contestId]/candidacies/[code]/route";
import { GET as featuredRoute } from "../app/api/gaming/community-voting/contests/featured/route";
import { POST as memberPost } from "../app/api/gaming/member/route";

/**
 * UG-IV-GATE-018 — the contest's HTTP edge, against REAL local Postgres and a REAL local Auth service (isolated loopback stack). Tokens are genuine Supabase
 * access tokens; the profile is completed through the EXISTING Gaming Member route, exactly as public/urbanoAuth.js does it. Everything is synthetic.
 *
 * What it proves that the database suites cannot: that each route takes the identity from the verified token and never from the body, that the operator
 * needs BOTH credentials, that the public routes carry no number and no identity, that the delivery number leaves the server by exactly one route, and that
 * a contest can be created, registered into, completed at the station, opened, voted, closed, reviewed and published purely through its own routes.
 */

const supabaseUrl = process.env.SUPABASE_URL;
requireLocalSupabase(supabaseUrl);
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
const dbUrl = process.env.COMMUNITY_VOTING_LOCAL_DB_URL ?? "";
if (!serviceKey || !anonKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are required.");
if (!/^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost|\[::1\]):\d+\//.test(dbUrl)) throw new Error("COMMUNITY_VOTING_LOCAL_DB_URL must be a loopback Postgres URL.");

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const sessionRepo = new SupabaseSessionRepository(supabaseUrl as string, serviceKey);
const service = createClient(supabaseUrl as string, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const anon = createClient(supabaseUrl as string, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
const pool = new Pool({ connectionString: dbUrl, max: 6 });
afterAll(async () => {
  await pool.end();
});

const HOUR = 3_600_000;
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();
const KEYS = ["MOST_ELABORATE", "SEXIEST", "BEST_GROUP", "FUNNIEST"] as const;
type Key = (typeof KEYS)[number];
const NUMBER = "+50499887766";

// ---------------------------------------------------------------- HTTP helper

type Handler = (req: Request, ctx: never) => Promise<Response>;
async function call(handler: Handler, params: Record<string, string>, init: { method?: string; headers?: Record<string, string>; body?: unknown; query?: string } = {}) {
  const request = new Request(`http://localhost/api/test${init.query ?? ""}`, {
    method: init.method ?? "POST",
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
    body: init.body === undefined ? undefined : typeof init.body === "string" ? init.body : JSON.stringify(init.body),
  });
  const response = await handler(request, { params } as never);
  const raw = Buffer.from(await response.arrayBuffer());
  let json: Record<string, any> = {};
  if ((response.headers.get("content-type") ?? "").includes("json")) json = JSON.parse(raw.toString("utf8") || "{}");
  return { status: response.status, headers: response.headers, json, raw, text: raw.toString("utf8") };
}
const get = (handler: Handler, params: Record<string, string>, headers: Record<string, string> = {}, query?: string) => call(handler, params, { method: "GET", headers, query });

// ---------------------------------------------------------------- identities (real local Auth, the existing profile route)

async function emailUser(opts: { confirmed?: boolean } = {}) {
  const password = `Pw-${randomUUID()}`;
  const email = `contest-route-${randomUUID()}@example.invalid`;
  const created = await service.auth.admin.createUser({ email, password, email_confirm: opts.confirmed !== false });
  if (created.error || !created.data.user) throw created.error ?? new Error("user not created");
  const signedIn = await anon.auth.signInWithPassword({ email, password });
  if (signedIn.error || !signedIn.data.session) throw signedIn.error ?? new Error("sign-in failed");
  const token = signedIn.data.session.access_token;
  return { authUserId: created.data.user.id, email, token, bearer: { authorization: `Bearer ${token}` } };
}
async function fullUser(name = "Persona") {
  const person = await emailUser();
  const res = await call(memberPost, {}, { headers: person.bearer, body: { displayName: name } });
  if (res.status !== 201 && res.status !== 200) throw new Error(`profile failed ${res.status} ${res.text}`);
  return { ...person, gamingMemberId: res.json.gamingMember.gamingMemberId as string };
}
type Person = Awaited<ReturnType<typeof fullUser>>;

// ---------------------------------------------------------------- a contest, created ONLY through the routes

interface Round { key: Key; instanceId: string; sessionId: string; hostToken: string }
let operator: Person;
let savedAllowlist: string | undefined;
beforeAll(async () => {
  savedAllowlist = process.env.COMMUNITY_VOTING_OPERATOR_MEMBER_IDS;
  operator = await fullUser("Operador");
  process.env.COMMUNITY_VOTING_OPERATOR_MEMBER_IDS = operator.gamingMemberId;
});
afterAll(() => {
  if (savedAllowlist === undefined) delete process.env.COMMUNITY_VOTING_OPERATOR_MEMBER_IDS;
  else process.env.COMMUNITY_VOTING_OPERATOR_MEMBER_IDS = savedAllowlist;
});

async function newContest(schedule: { registrationOpensAt: string | null; contestantCutoffAt: string | null; votingOpensAt: string | null; votingClosesAt: string | null }) {
  const rounds = {} as Record<Key, Round>;
  let contestId: string | null = null;
  for (const key of KEYS) {
    const session = await createSession(sessionRepo);
    await setSessionCapabilities(sessionRepo, session.sessionId, session.hostToken, ["VOTING"] as never);
    const res = await call(registerCategoryRoute, {}, { headers: { ...operator.bearer, "x-host-token": session.hostToken }, body: { sessionId: session.sessionId, categoryKey: key, ...(contestId ? { contestId } : {}) } });
    expect(res.status, `${key}: ${res.text}`).toBe(201);
    contestId = res.json.round.contestId;
    rounds[key] = { key, instanceId: res.json.round.instanceId, sessionId: session.sessionId, hostToken: session.hostToken };
    const sch = await call(scheduleRoute, { instanceId: rounds[key].instanceId }, { method: "PUT", headers: { ...operator.bearer, "x-host-token": session.hostToken }, body: { ...schedule, status: "TENTATIVE" } });
    expect(sch.status, sch.text).toBe(200);
  }
  return { contestId: contestId as string, rounds };
}
const opHeaders = (r: Round, who: Person = operator) => ({ ...who.bearer, "x-host-token": r.hostToken });
const operatorCall = (handler: Handler, r: Round, params: Record<string, string> = {}, init: { method?: string; body?: unknown; query?: string; headers?: Record<string, string> } = {}) =>
  call(handler, { instanceId: r.instanceId, ...params }, { ...init, headers: init.headers ?? opHeaders(r) });

/** Registers a person through the route, then does at the station exactly what the operator does: verify, photograph, consent, approve. */
async function registered(contest: Awaited<ReturnType<typeof newContest>>, key: Key, name: string, number = NUMBER) {
  const person = await fullUser(name);
  const reg = await call(registrationRoute, { instanceId: contest.rounds[key].instanceId }, { headers: person.bearer, body: registrationBody(name, number) });
  expect(reg.status, reg.text).toBe(201);
  return { person, entryId: reg.json.candidacy.entryId as string, code: reg.json.candidacy.publicCode as string };
}
const registrationBody = (name: string, whatsapp = NUMBER) => ({
  publicName: name, adultConfirmed: true, requirementsAccepted: true, requirementsVersion: REQUIREMENTS_VERSION, whatsapp, whatsappConfirmed: true, deliveryAuthorized: true, deliveryVersion: DELIVERY_VERSION,
});
async function atStation(r: Round, entryId: string) {
  const p = { instanceId: r.instanceId, entryId };
  expect((await operatorCall(confirmationRoute, r, p, {})).status).toBe(200);
  const up = await operatorCall(photoUploadRoute, r, p, { body: { fullImage: SYNTHETIC_JPEG_B64, thumbImage: SYNTHETIC_JPEG_B64 } });
  expect(up.status, up.text).toBe(201);
  expect((await operatorCall(consentRoute, r, p, { body: { photoId: up.json.photoId, consentVersion: GALLERY_CONSENT_VERSION, accepted: true, ageConfirmed: true } })).status).toBe(201);
  expect((await operatorCall(decisionRoute, r, p, { body: { photoId: up.json.photoId, decision: "APPROVED" } })).status).toBe(200);
}

// ================================================================ registering a category

describe("the operator registers the contest's categories: only the designated operator, only the four categories", () => {
  it("refuses everyone but the allow-listed operator, fails closed with no allow-list, and creates ONE contest that the other three categories join", async () => {
    const stranger = await fullUser("Otra persona");
    const session = await createSession(sessionRepo);
    await setSessionCapabilities(sessionRepo, session.sessionId, session.hostToken, ["VOTING"] as never);
    const body = { sessionId: session.sessionId, categoryKey: "SEXIEST" };
    expect((await call(registerCategoryRoute, {}, { headers: { "x-host-token": session.hostToken }, body })).status).toBe(401);
    expect((await call(registerCategoryRoute, {}, { headers: stranger.bearer, body })).status).toBe(401); // no host token
    const notListed = await call(registerCategoryRoute, {}, { headers: { ...stranger.bearer, "x-host-token": session.hostToken }, body });
    expect(notListed.status).toBe(403);
    expect(notListed.json.code).toBe("OPERATOR_REQUIRED");
    delete process.env.COMMUNITY_VOTING_OPERATOR_MEMBER_IDS;
    const noList = await call(registerCategoryRoute, {}, { headers: { ...operator.bearer, "x-host-token": session.hostToken }, body });
    expect(noList.status).toBe(503);
    expect(noList.json.code).toBe("OPERATOR_NOT_CONFIGURED");
    process.env.COMMUNITY_VOTING_OPERATOR_MEMBER_IDS = operator.gamingMemberId;
    expect((await call(registerCategoryRoute, {}, { headers: { ...operator.bearer, "x-host-token": session.hostToken }, body: { ...body, categoryKey: "BEST_COUPLE" } })).status).toBe(400);
    expect((await call(registerCategoryRoute, {}, { headers: { ...operator.bearer, "x-host-token": session.hostToken }, body: { ...body, windowSeconds: 300 } })).status).toBe(400);

    const contest = await newContest({ registrationOpensAt: inMs(-HOUR), contestantCutoffAt: inMs(2 * HOUR), votingOpensAt: inMs(2 * HOUR), votingClosesAt: inMs(4 * HOUR) });
    const info = await get(contestRoute, { contestId: contest.contestId });
    expect(info.status).toBe(200);
    expect(info.json.categories.map((c: { key: string }) => c.key)).toEqual([...KEYS]);
    expect(info.json.registration.phase).toBe("OPEN");
    expect(info.json.texts.requirements.version).toBe(REQUIREMENTS_VERSION);
    expect(info.json.categories.every((c: { phase: string }) => c.phase === "NOT_OPEN")).toBe(true);
    // (the delivery authorization's TEXT is public on purpose — it names WhatsApp; what is never public is a number, an identity, a token or a position)
    expect(JSON.stringify(info.json)).not.toMatch(/hostToken|host_token|authUser|whatsapp_e164|\+\d{8,}|latitude|geofence/i);
    // registering a category twice in one contest is refused
    const dup = await createSession(sessionRepo);
    await setSessionCapabilities(sessionRepo, dup.sessionId, dup.hostToken, ["VOTING"] as never);
    const twice = await call(registerCategoryRoute, {}, { headers: { ...operator.bearer, "x-host-token": dup.hostToken }, body: { sessionId: dup.sessionId, categoryKey: "SEXIEST", contestId: contest.contestId } });
    expect(twice.status).toBe(409);
    expect(twice.json.code).toBe("CATEGORY_ALREADY_REGISTERED");
  });
});

// ================================================================ the contestant's self-registration

describe("self-registration at the HTTP edge: the identity is the verified token's and nothing in the body", () => {
  let contest: Awaited<ReturnType<typeof newContest>>;
  beforeAll(async () => {
    contest = await newContest({ registrationOpensAt: inMs(-HOUR), contestantCutoffAt: inMs(2 * HOUR), votingOpensAt: inMs(2 * HOUR), votingClosesAt: inMs(4 * HOUR) });
  });

  it("refuses without a token, with an unverified e-mail and without a Gaming profile; and refuses a body that tries to choose an identity, a role, a category or a position", async () => {
    const r = contest.rounds.MOST_ELABORATE;
    expect((await call(registrationRoute, { instanceId: r.instanceId }, { body: registrationBody("Ana") })).status).toBe(401);
    expect((await call(registrationRoute, { instanceId: r.instanceId }, { headers: { authorization: "Bearer not-a-token" }, body: registrationBody("Ana") })).status).toBe(401);
    const unverified = await emailUser({ confirmed: false }).catch(() => null);
    if (unverified) expect((await call(registrationRoute, { instanceId: r.instanceId }, { headers: unverified.bearer, body: registrationBody("Ana") })).status).toBe(403);
    const noProfile = await emailUser();
    const np = await call(registrationRoute, { instanceId: r.instanceId }, { headers: noProfile.bearer, body: registrationBody("Ana") });
    expect(np.status).toBe(403);
    expect(np.json.code).toBe("PROFILE_INCOMPLETE");
    const person = await fullUser("Ana");
    for (const forbidden of ["location", "latitude", "authUserId", "gamingMemberId", "role", "categoryKey"]) {
      const res = await call(registrationRoute, { instanceId: r.instanceId }, { headers: person.bearer, body: { ...registrationBody("Ana"), [forbidden]: "x" } });
      expect(res.status, forbidden).toBe(400);
    }
    expect((await call(registrationRoute, { instanceId: r.instanceId }, { headers: person.bearer, body: { ...registrationBody("Ana"), requirementsVersion: "older" } })).status).toBe(400);
    expect((await call(registrationRoute, { instanceId: r.instanceId }, { headers: person.bearer, body: { ...registrationBody("Ana"), deliveryAuthorized: false } })).status).toBe(409);
    expect((await call(registrationRoute, { instanceId: r.instanceId }, { headers: person.bearer, body: { ...registrationBody("Ana"), whatsapp: "99887766" } })).status).toBe(400);
    expect(JSON.parse((await get(mineRoute, { contestId: contest.contestId }, person.bearer)).text).candidacy).toBeNull(); // nothing was written
  });

  it("registers the person, binds them, answers with the code and the link — never the number — and the same person cannot register twice, anywhere in the contest", async () => {
    const person = await fullUser("Drácula");
    const r = contest.rounds.MOST_ELABORATE;
    const res = await call(registrationRoute, { instanceId: r.instanceId }, { headers: person.bearer, body: registrationBody("  Drácula de Tegucigalpa ") });
    expect(res.status, res.text).toBe(201);
    expect(res.json.candidacy).toMatchObject({ categoryKey: "MOST_ELABORATE", publicName: "Drácula de Tegucigalpa", kind: "INDIVIDUAL", state: "REGISTERED", deliveryStatus: "PENDING" });
    expect(res.json.candidacy.publicCode).toMatch(/^HAL-[2-9A-HJKMNP-TV-Z]{5}$/);
    expect(res.json.candidacy.ficheUrl).toBe(`/community-voting-round.html?c=${contest.contestId}&codigo=${res.json.candidacy.publicCode}`);
    expect(res.text).not.toMatch(/9988|whatsapp|authUser|email/i);
    expect(res.headers.get("cache-control")).toBe("no-store");
    const twice = await call(registrationRoute, { instanceId: r.instanceId }, { headers: person.bearer, body: registrationBody("Otra vez") });
    expect(twice.status).toBe(409);
    expect(twice.json.code).toBe("ALREADY_CANDIDATE");
    const other = await call(registrationRoute, { instanceId: contest.rounds.FUNNIEST.instanceId }, { headers: person.bearer, body: registrationBody("Otra categoría") });
    expect(other.status).toBe(409);
    expect(other.json.code).toBe("ALREADY_CANDIDATE");
    const mine = await get(mineRoute, { contestId: contest.contestId }, person.bearer);
    expect(mine.status).toBe(200);
    expect(mine.json.candidacy).toMatchObject({ publicCode: res.json.candidacy.publicCode, state: "REGISTERED", role: "INDIVIDUAL", categoryName: { es: "Más Elaborado" } });
    expect(mine.text).not.toMatch(/9988|whatsapp|authUser|email/i);
    expect((await get(mineRoute, { contestId: contest.contestId })).status).toBe(401);
  });

  it("says that registration ended after the cutoff — and takes no new candidacy", async () => {
    const closed = await newContest({ registrationOpensAt: inMs(-3 * HOUR), contestantCutoffAt: inMs(-1000), votingOpensAt: inMs(-1000), votingClosesAt: inMs(2 * HOUR) });
    const person = await fullUser("Tarde");
    const res = await call(registrationRoute, { instanceId: closed.rounds.SEXIEST.instanceId }, { headers: person.bearer, body: registrationBody("Tarde") });
    expect(res.status).toBe(409);
    expect(res.json.code).toBe("CUTOFF_PASSED");
    const info = await get(contestRoute, { contestId: closed.contestId });
    expect(info.json.registration.phase).toBe("CLOSED");
    const early = await newContest({ registrationOpensAt: inMs(HOUR), contestantCutoffAt: inMs(2 * HOUR), votingOpensAt: inMs(2 * HOUR), votingClosesAt: inMs(4 * HOUR) });
    const e = await call(registrationRoute, { instanceId: early.rounds.SEXIEST.instanceId }, { headers: (await fullUser("Pronto")).bearer, body: registrationBody("Pronto") });
    expect(e.status).toBe(409);
    expect(e.json.code).toBe("REGISTRATION_NOT_OPEN");
  });
});

// ================================================================ the station, the ficha, the delivery

describe("the station and the public ficha: nothing is public until the person is verified, photographed and approved", () => {
  let contest: Awaited<ReturnType<typeof newContest>>;
  beforeAll(async () => {
    contest = await newContest({ registrationOpensAt: inMs(-HOUR), contestantCutoffAt: inMs(2 * HOUR), votingOpensAt: inMs(2 * HOUR), votingClosesAt: inMs(4 * HOUR) });
  });

  it("the operator needs BOTH credentials — the bearer of the designated member and THIS category's host token — for every station route", async () => {
    const r = contest.rounds.SEXIEST;
    const cand = await registered(contest, "SEXIEST", "Vampiresa");
    const stranger = await fullUser("Intrusa");
    for (const [label, headers, status, code] of [
      ["no credentials", {}, 401, "AUTHENTICATION_REQUIRED"],
      ["only the bearer", operator.bearer, 401, "AUTHENTICATION_REQUIRED"],
      ["only the host token", { "x-host-token": r.hostToken }, 401, "AUTHENTICATION_REQUIRED"],
      ["another category's host token", { ...operator.bearer, "x-host-token": contest.rounds.FUNNIEST.hostToken }, 403, null],
      ["a member who is not the operator", { ...stranger.bearer, "x-host-token": r.hostToken }, 403, "OPERATOR_REQUIRED"],
    ] as const) {
      const res = await operatorCall(findRoute, r, {}, { method: "GET", query: `?code=${cand.code}`, headers: headers as Record<string, string> });
      expect(res.status, label).toBe(status);
      if (code) expect(res.json.code, label).toBe(code);
    }
    const ok = await operatorCall(findRoute, r, {}, { method: "GET", query: `?code=${cand.code.toLowerCase()}` });
    expect(ok.status).toBe(200);
    expect(ok.json.candidacy).toMatchObject({ entryId: cand.entryId, categoryKey: "SEXIEST", publicName: "Vampiresa", selfRegistered: true, hasWhatsapp: true, deliveryStatus: "PENDING", withdrawn: false });
    expect(ok.text).not.toMatch(/9988|\+504|whatsapp_e164|authUser|email/i);
    expect((await operatorCall(findRoute, r, {}, { method: "GET", query: "?code=HAL-0OIL1" })).json).toEqual({ valid: false, candidacy: null });
    expect((await operatorCall(findRoute, r, {}, { method: "GET", query: "?code=HAL-22222" })).json).toEqual({ valid: true, candidacy: null });
  });

  it("a candidacy is not public before it is complete, and becomes public — by name, code and photograph — exactly when the station completes it", async () => {
    const r = contest.rounds.SEXIEST;
    const cand = await registered(contest, "SEXIEST", "Diablita Elegante");
    expect((await get(fichaRoute, { contestId: contest.contestId, code: cand.code })).status).toBe(404); // registered, not yet verified
    const p = { instanceId: r.instanceId, entryId: cand.entryId };
    expect((await operatorCall(confirmationRoute, r, p, {})).status).toBe(200);
    expect((await get(fichaRoute, { contestId: contest.contestId, code: cand.code })).status).toBe(404); // verified, but no approved photograph
    const up = await operatorCall(photoUploadRoute, r, p, { body: { fullImage: SYNTHETIC_JPEG_B64, thumbImage: SYNTHETIC_JPEG_B64 } });
    expect(up.status, up.text).toBe(201);
    expect((await get(fichaRoute, { contestId: contest.contestId, code: cand.code })).status).toBe(404); // photographed, no consent, no approval
    expect((await operatorCall(consentRoute, r, p, { body: { photoId: up.json.photoId, consentVersion: GALLERY_CONSENT_VERSION, accepted: true, ageConfirmed: true } })).status).toBe(201);
    expect((await get(fichaRoute, { contestId: contest.contestId, code: cand.code })).status).toBe(404);
    expect((await operatorCall(decisionRoute, r, p, { body: { photoId: up.json.photoId, decision: "APPROVED" } })).status).toBe(200);

    const ficha = await get(fichaRoute, { contestId: contest.contestId, code: cand.code.toLowerCase() }); // no credentials at all
    expect(ficha.status, ficha.text).toBe(200);
    expect(ficha.json.candidacy).toMatchObject({ code: cand.code, name: "Diablita Elegante", category: { key: "SEXIEST", kind: "INDIVIDUAL" } });
    expect(ficha.json.voting).toMatchObject({ phase: "NOT_OPEN", published: false });
    expect(ficha.text).not.toMatch(/9988|whatsapp|authUser|email|candidateId|binding/i);
    const alias = (ficha.json.candidacy.imageUrl as string).match(/photos\/(\d{4})\?v=full/)![1];
    const photo = await get(photoRoute, { instanceId: r.instanceId, alias }, {}, "?v=full");
    expect(photo.status).toBe(200);
    expect(photo.headers.get("content-type")).toBe("image/jpeg");
    expect(photo.raw.length).toBeGreaterThan(1000);
    // the code only LOCATES: an unknown code, a look-alike and another contest's candidacy all say the same
    for (const code of ["HAL-22222", "HAL-0OIL1", "not a code"]) expect((await get(fichaRoute, { contestId: contest.contestId, code })).status, code).toBe(404);
    const elsewhere = await newContest({ registrationOpensAt: inMs(-HOUR), contestantCutoffAt: inMs(2 * HOUR), votingOpensAt: inMs(2 * HOUR), votingClosesAt: inMs(4 * HOUR) });
    expect((await get(fichaRoute, { contestId: elsewhere.contestId, code: cand.code })).status).toBe(404);
    // and the person sees their candidacy as public
    expect((await get(mineRoute, { contestId: contest.contestId }, cand.person.bearer)).json.candidacy.state).toBe("PUBLIC");
  });

  it("the name is corrected at the station before voting opens, and only through its route", async () => {
    const r = contest.rounds.SEXIEST;
    const cand = await registered(contest, "SEXIEST", "Nombre feo");
    const p = { instanceId: r.instanceId, entryId: cand.entryId };
    expect((await operatorCall(nameRoute, r, p, { method: "PUT", body: { publicName: "X" } })).status).toBe(400);
    const ok = await operatorCall(nameRoute, r, p, { method: "PUT", body: { publicName: "  Nombre lindo " } });
    expect(ok.status, ok.text).toBe(200);
    expect(ok.json.publicName).toBe("Nombre lindo");
    expect((await operatorCall(nameRoute, r, p, { method: "PUT", body: { publicName: "Sin credenciales" }, headers: {} })).status).toBe(401);
    const rows = await pool.query("select public_name from community_voting_candidacies where entry_id = $1", [cand.entryId]);
    expect(rows.rows[0].public_name).toBe("Nombre lindo");
  });

  it("the delivery number leaves the server by exactly ONE route, to the designated operator, audited without it — and «delivered» is recorded only by the operator's act", async () => {
    const r = contest.rounds.SEXIEST;
    const cand = await registered(contest, "SEXIEST", "Gato Negro", NUMBER);
    await atStation(r, cand.entryId);
    const p = { instanceId: r.instanceId, entryId: cand.entryId };
    // every other read of this candidacy is free of the number
    for (const res of [
      await get(fichaRoute, { contestId: contest.contestId, code: cand.code }),
      await get(mineRoute, { contestId: contest.contestId }, cand.person.bearer),
      await operatorCall(overviewRoute, r, {}, { method: "GET" }),
      await operatorCall(findRoute, r, {}, { method: "GET", query: `?code=${cand.code}` }),
      await get(contestRoute, { contestId: contest.contestId }),
      await get(slideshowRoute, { instanceId: r.instanceId }),
    ]) expect(res.text).not.toMatch(/9988|99887766|whatsapp_e164/);
    // the one that returns it
    expect((await operatorCall(contactRoute, r, p, { headers: {} })).status).toBe(401);
    expect((await operatorCall(contactRoute, r, p, { headers: { ...(await fullUser("X")).bearer, "x-host-token": r.hostToken } })).status).toBe(403);
    const res = await operatorCall(contactRoute, r, p, { headers: opHeaders(r) });
    expect(res.status, res.text).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.json).toMatchObject({ whatsapp: NUMBER, deliveryStatus: "PENDING", publicCode: cand.code, publicName: "Gato Negro" });
    expect(res.json.whatsappUrl).toMatch(/^https:\/\/wa\.me\/50499887766\?text=/);
    expect(res.json.message).toContain(cand.code);
    expect(res.json.message).not.toMatch(/adjunt|foto/i);
    const audit = await pool.query("select action, detail from community_voting_operator_actions where entry_id = $1 and action = 'READ_CONTACT'", [cand.entryId]);
    expect(audit.rows).toHaveLength(1);
    expect(JSON.stringify(audit.rows)).not.toMatch(/9988/);
    // reading it recorded nothing about delivery
    expect((await operatorCall(findRoute, r, {}, { method: "GET", query: `?code=${cand.code}` })).json.candidacy.deliveryStatus).toBe("PENDING");
    const done = await operatorCall(deliveryRoute, r, p, {});
    expect(done.status, done.text).toBe(200);
    expect(done.json.deliveryStatus).toBe("DELIVERED");
    expect((await operatorCall(deliveryRoute, r, p, {})).json.deliveredAt).toBe(done.json.deliveredAt); // idempotent
    expect((await get(mineRoute, { contestId: contest.contestId }, cand.person.bearer)).json.candidacy.deliveryStatus).toBe("DELIVERED");
  });

  it("the operator's overview carries each candidacy's code, name and delivery state — and never an identity", async () => {
    const r = contest.rounds.SEXIEST;
    const res = await operatorCall(overviewRoute, r, {}, { method: "GET" });
    expect(res.status).toBe(200);
    const entries = res.json.entries as Array<Record<string, unknown>>;
    expect(entries.length).toBeGreaterThan(0);
    for (const e of entries) {
      expect(Object.keys(e)).toEqual(expect.arrayContaining(["entryId", "kind", "publicCode", "publicName", "selfRegistered", "hasWhatsapp", "deliveryStatus", "association", "media"]));
      expect(JSON.stringify(e)).not.toMatch(/authUser|email|binding|whatsapp_e164|\+504/);
    }
  });
});

// ================================================================ opening, voting, closing, publishing

describe("one category, from open to published, through the contest's own routes", () => {
  it("opens only when every candidacy is ready, votes by name and code, refuses a self-vote, lets a vote change, closes, is reviewed and publishes the winner by name — with no count", async () => {
    const contest = await newContest({ registrationOpensAt: inMs(-HOUR), contestantCutoffAt: inMs(2 * HOUR), votingOpensAt: inMs(2 * HOUR), votingClosesAt: inMs(4 * HOUR) });
    const r = contest.rounds.FUNNIEST;
    const a = await registered(contest, "FUNNIEST", "Pizza con Piña");
    const b = await registered(contest, "FUNNIEST", "Momia con Resfrío");
    await atStation(r, a.entryId);
    const prompt = { promptText: "Elegí el disfraz más chistoso." };
    await lockLobby(sessionRepo, r.sessionId, r.hostToken);
    const early = await operatorCall(openRoute, r, {}, { body: prompt });
    expect(early.status).toBe(409); // b has not been to the station: nothing opens, nothing is dropped
    expect(early.json.code).toBe("PREPARATION_INCOMPLETE");
    await atStation(r, b.entryId);
    const opened = await operatorCall(openRoute, r, {}, { body: prompt });
    expect(opened.status, opened.text).toBe(201);
    // registration is over for good the moment voting opens
    const late = await call(registrationRoute, { instanceId: r.instanceId }, { headers: (await fullUser("Tarde")).bearer, body: registrationBody("Tarde") });
    expect(late.status).toBe(409);
    expect(late.json.code).toBe("PREPARATION_CLOSED");

    const voter = await fullUser("Votante");
    const params = { instanceId: r.instanceId };
    expect((await call(bindingRoute, params, { headers: voter.bearer, body: {} })).status).toBeLessThan(300);
    const gallery = await get(galleryRoute, params, voter.bearer);
    expect(gallery.status, gallery.text).toBe(200);
    const items = gallery.json.items as Array<{ name: string; code: string; candidateId: string; mine: boolean; alias: string }>;
    expect(items.map((i) => i.name).sort()).toEqual(["Momia con Resfrío", "Pizza con Piña"]);
    expect(items.map((i) => i.code).sort()).toEqual([a.code, b.code].sort());
    const vote = async (who: Person, candidateId: string) => {
      const binding = await call(bindingRoute, params, { headers: who.bearer, body: {} });
      const intent = await call(intentsRoute, params, { headers: who.bearer, body: {} });
      return call(votesRoute, params, { headers: who.bearer, body: { bindingId: binding.json.bindingId, intentNo: intent.json.intentNo, interactionInstanceId: gallery.json.interactionInstanceId, candidateId } });
    };
    const pizza = items.find((i) => i.name === "Pizza con Piña")!;
    const momia = items.find((i) => i.name === "Momia con Resfrío")!;
    // a contestant cannot vote for themselves, and sees their own costume flagged
    const ownGallery = await get(galleryRoute, params, a.person.bearer);
    expect((ownGallery.json.items as Array<{ name: string; mine: boolean }>).find((i) => i.name === "Pizza con Piña")!.mine).toBe(true);
    await call(bindingRoute, params, { headers: a.person.bearer, body: {} });
    const self = await vote(a.person, pizza.candidateId);
    expect(self.status).toBe(400);
    expect(self.json.code).toBe("SELF_VOTE_NOT_ALLOWED");
    // the others vote; one changes their mind
    expect((await vote(voter, pizza.candidateId)).status).toBe(200);
    expect((await vote(await fullUser("V2"), pizza.candidateId)).status).toBe(200);
    expect((await vote(await fullUser("V3"), momia.candidateId)).status).toBe(200);
    const changed = await vote(voter, momia.candidateId);
    expect(changed.status).toBe(200);
    expect((await get(statusRoute, params, voter.bearer)).json.myCandidateId).toBe(momia.candidateId);
    // nothing shows a count or a total to a voter or to the public while voting is open
    expect(gallery.text).not.toMatch(/voteCount|votes|total|rank/i);
    expect((await get(publicResultsRoute, params)).json).toEqual({ published: false, kind: null, items: [] });

    expect((await operatorCall(closeRoute, r, {}, { body: {} })).status).toBeLessThan(300);
    const rows = await operatorCall(operatorResultsRoute, r, {}, { method: "GET" });
    expect(rows.status, rows.text).toBe(200);
    // Momia: 2 (its own first voter, who changed their mind, and one more); Pizza: 1 — the one with the most valid votes wins, and the contestant's own vote never counted
    expect((rows.json.rows as Array<{ votes: number; winner: boolean }>).map((x) => [x.votes, x.winner]).sort()).toEqual([[1, false], [2, true]]);
  });
});

// ================================================================ Home

describe("Home's contest: nothing until the operator lists it, then the contest's id and its two entries", () => {
  it("answers null while no contest is listed by this operator, lists it on the operator's explicit act and takes it down again", async () => {
    const contest = await newContest({ registrationOpensAt: inMs(-HOUR), contestantCutoffAt: inMs(2 * HOUR), votingOpensAt: inMs(2 * HOUR), votingClosesAt: inMs(4 * HOUR) });
    const r = contest.rounds.MOST_ELABORATE;
    expect((await operatorCall(listingRoute, r, {}, { method: "PUT", body: { listed: true }, headers: {} })).status).toBe(401);
    expect((await operatorCall(listingRoute, r, {}, { method: "PUT", body: { listed: "yes" } })).status).toBe(400);
    const listed = await operatorCall(listingRoute, r, {}, { method: "PUT", body: { listed: true } });
    expect(listed.status, listed.text).toBe(200);
    const featured = await get(featuredRoute, {});
    expect(featured.status).toBe(200);
    expect(featured.json.featured).toMatchObject({
      contestId: contest.contestId, voteUrl: `/community-voting-round.html?c=${contest.contestId}`, registerUrl: `/community-voting-round.html?c=${contest.contestId}&participar=1`,
      phase: "NOT_OPEN", registration: { phase: "OPEN" },
    });
    expect(featured.text).not.toMatch(/hostToken|authUser|whatsapp|latitude|geofence/i);
    const off = await operatorCall(listingRoute, r, {}, { method: "PUT", body: { listed: false } });
    expect(off.status).toBe(200);
    const after = await get(featuredRoute, {});
    expect(after.json.featured === null || after.json.featured.contestId !== contest.contestId).toBe(true);
  });
});
