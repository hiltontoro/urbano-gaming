import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { createClient } from "@supabase/supabase-js";
import { Pool } from "pg";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SupabaseSessionRepository } from "../lib/session/db/supabaseSessionRepository";
import { createSession } from "../lib/session/createSession";
import { setSessionCapabilities } from "../lib/session/setSessionCapabilities";
import { lockLobby } from "../lib/session/lockLobby";
import { FINAL_WINDOW_SECONDS, GALLERY_CONSENT_VERSION, PROMO_CONSENT_VERSION } from "../lib/gaming/communityVoting/rounds/constants";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";

import { POST as registerRoute } from "../app/api/gaming/community-voting/rounds/route";
import { GET as infoRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/info/route";
import { PUT as scheduleRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/schedule/route";
import { POST as bindingRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/binding/route";
import { POST as claimsRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/claims/route";
import { GET as statusRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/status/route";
import { GET as galleryRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/gallery/route";
import { GET as slideshowRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/slideshow/route";
import { GET as photoRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/photos/[alias]/route";
import { GET as publicResultsRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/results/route";
import { POST as intentsRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/intents/route";
import { POST as votesRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/votes/route";
import { GET as overviewRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/operator/overview/route";
import { POST as entriesRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/operator/entries/route";
import { POST as photoUploadRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/operator/entries/[entryId]/photo/route";
import { POST as consentRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/operator/entries/[entryId]/consent/route";
import { POST as promoRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/operator/entries/[entryId]/promo-consent/route";
import { POST as decisionRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/operator/entries/[entryId]/decision/route";
import { POST as associationRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/operator/entries/[entryId]/association/route";
import { POST as withdrawalRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/operator/entries/[entryId]/withdrawal/route";
import { POST as openRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/operator/open/route";
import { POST as closeRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/operator/close/route";
import { GET as resultsRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/operator/results/route";
import { POST as finalistsRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/operator/finalists/route";
import { POST as prepareFinalRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/operator/prepare-final/route";
import { POST as reviewRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/operator/review/route";
import { POST as publishRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/operator/publish/route";
import { POST as hidePhotoRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/operator/entries/[entryId]/photo-hide/route";
import { POST as policiesRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/operator/policies/route";
import { POST as taskRoute } from "../app/api/gaming/community-voting/rounds/[instanceId]/operator/tasks/[taskId]/route";
// the EXISTING pieces the pilot reuses, driven as a browser would drive them
import { GET as memberGet, POST as memberPost } from "../app/api/gaming/member/route";
import { POST as gate003BindingRoute } from "../app/api/gaming/community-voting/instances/[instanceId]/binding/route";

/**
 * Two-round pilot (UG-IV-GATE-004 / 004A) — the HTTP edge, against REAL local Postgres and a REAL local Auth service (isolated
 * loopback stack). Tokens are genuine Supabase access tokens obtained with the password grant; the profile is completed through the
 * EXISTING Gaming Member route, exactly as public/urbanoAuth.js does it. Everything is synthetic; no provider is involved.
 */

const supabaseUrl = process.env.SUPABASE_URL;
requireLocalSupabase(supabaseUrl);
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = process.env.SUPABASE_ANON_KEY;
const dbUrl = process.env.COMMUNITY_VOTING_LOCAL_DB_URL ?? "";
if (!serviceKey || !anonKey) throw new Error("SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are required.");
if (!/^postgres(ql)?:\/\/[^@]+@(127\.0\.0\.1|localhost|\[::1\]):\d+\//.test(dbUrl)) throw new Error("COMMUNITY_VOTING_LOCAL_DB_URL must be a loopback Postgres URL.");

vi.setConfig({ testTimeout: 120_000 });

const sessionRepo = new SupabaseSessionRepository(supabaseUrl, serviceKey);
const service = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const anon = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
const pool = new Pool({ connectionString: dbUrl, max: 6 });
afterAll(async () => {
  await pool.end();
});
async function q<T extends Record<string, unknown> = Record<string, unknown>>(sql: string, params: unknown[] = []): Promise<T[]> {
  return (await pool.query(sql, params)).rows as T[];
}

const savedEnv: Record<string, string | undefined> = {};
beforeEach(() => {
  savedEnv.ops = process.env.COMMUNITY_VOTING_OPERATOR_MEMBER_IDS;
});
afterEach(() => {
  if (savedEnv.ops === undefined) delete process.env.COMMUNITY_VOTING_OPERATOR_MEMBER_IDS;
  else process.env.COMMUNITY_VOTING_OPERATOR_MEMBER_IDS = savedEnv.ops;
});

// ---------------------------------------------------------------- HTTP helper

type Handler = (req: Request, ctx: never) => Promise<Response>;
async function call(
  handler: Handler,
  params: Record<string, string>,
  init: { method?: string; headers?: Record<string, string>; body?: unknown; query?: string } = {}
) {
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

/** A real Supabase session whose email is confirmed. NO Gaming Member yet — the person has only verified the email. */
async function emailUser() {
  const password = `Pw-${randomUUID()}`;
  const email = `pilot-route-${randomUUID()}@example.invalid`;
  const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error || !created.data.user) throw created.error ?? new Error("user not created");
  const signedIn = await anon.auth.signInWithPassword({ email, password });
  if (signedIn.error || !signedIn.data.session) throw signedIn.error ?? new Error("sign-in failed");
  const token = signedIn.data.session.access_token;
  return { authUserId: created.data.user.id, email, token, header: `Bearer ${token}`, bearer: { authorization: `Bearer ${token}` } };
}
type Person = Awaited<ReturnType<typeof emailUser>>;

/** The profile step as the browser performs it: POST /api/gaming/member with the person's own token. */
async function completeProfile(person: Person, displayName = "Marta") {
  const res = await call(memberPost, {}, { headers: person.bearer, body: { displayName } });
  if (res.status !== 201 && res.status !== 200) throw new Error(`profile failed ${res.status} ${res.text}`);
  return res.json.gamingMember as { gamingMemberId: string; displayName: string };
}
async function fullUser(): Promise<Person & { gamingMemberId: string }> {
  const person = await emailUser();
  const member = await completeProfile(person);
  return { ...person, gamingMemberId: member.gamingMemberId };
}
async function phoneOnlyUser() {
  const password = `Pw-${randomUUID()}`;
  const phone = `+1555${String(Math.floor(Math.random() * 9_000_000) + 1_000_000)}`;
  const { data, error } = await anon.auth.signUp({ phone, password });
  if (error || !data.session || !data.user) throw error ?? new Error("phone sign-up failed");
  return { authUserId: data.user.id, bearer: { authorization: `Bearer ${data.session.access_token}` } };
}

// ---------------------------------------------------------------- photographs

function buildJpeg(opts: { width?: number; height?: number; seed?: number; filler?: number } = {}): Buffer {
  const parts: number[] = [0xff, 0xd8];
  const segment = (marker: number, payload: number[]) => parts.push(0xff, marker, ((payload.length + 2) >> 8) & 0xff, (payload.length + 2) & 0xff, ...payload);
  segment(0xe0, [...Buffer.from("JFIF\0"), 1, 1, 0, 0, 1, 0, 1, 0, 0]);
  segment(0xdb, [0, ...Array.from({ length: 64 }, () => 3)]);
  const w = opts.width ?? 640, h = opts.height ?? 480;
  segment(0xc0, [8, (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff, 1, 1, 0x11, 0]);
  segment(0xc4, [0, ...Array.from({ length: 16 }, () => 0), 0]);
  segment(0xda, [1, 1, 0, 0, 63, 0]);
  const seed = opts.seed ?? 1;
  for (let i = 0; i < 40 + (opts.filler ?? 0); i++) parts.push((seed * 7 + i) % 250);
  parts.push(0xff, 0x00, 0x12, 0xff, 0xd9);
  return Buffer.from(parts);
}

// ---------------------------------------------------------------- rounds, driven only through the HTTP edge

const VENUE = { venueLatitude: 15.5, venueLongitude: -88.0, venueRadiusMeters: 100, maxAccuracyMeters: 50, insideMarginFactor: 1, outsideMarginFactor: 1 };
const INSIDE = { latitude: 15.5, longitude: -88.0, accuracyMeters: 10 };
const OUTSIDE = { latitude: 15.6, longitude: -88.0, accuracyMeters: 10 };

let seedCounter = 100;

async function newOperator() {
  const op = await fullUser();
  process.env.COMMUNITY_VOTING_OPERATOR_MEMBER_IDS = op.gamingMemberId;
  return op;
}
async function newRound(role: "PRELIMINARY" | "FINAL", opts: { op?: Awaited<ReturnType<typeof newOperator>>; source?: Round } = {}) {
  const op = opts.op ?? (await newOperator());
  process.env.COMMUNITY_VOTING_OPERATOR_MEMBER_IDS = op.gamingMemberId;
  const session = await createSession(sessionRepo);
  await setSessionCapabilities(sessionRepo, session.sessionId, session.hostToken, ["VOTING"] as never);
  const host = { ...op.bearer, "x-host-token": session.hostToken };
  const body = role === "PRELIMINARY" ? { sessionId: session.sessionId, roundRole: role } : { sessionId: session.sessionId, roundRole: role, sourceInstanceId: opts.source!.id, venue: VENUE };
  const registered = await call(registerRoute, {}, { headers: host, body });
  if (registered.status !== 201) throw new Error(`registration failed: ${registered.status} ${registered.text}`);
  const id = registered.json.instance.instanceId as string;
  return { role, op, session, host, id, p: { instanceId: id }, interactionInstanceId: null as null | string };
}
type Round = Awaited<ReturnType<typeof newRound>>;

async function bindAs(r: Round, person: Person) {
  const bound = await call(bindingRoute, r.p, { headers: person.bearer });
  if (![200, 201].includes(bound.status)) throw new Error(`bind failed ${bound.status} ${bound.text}`);
  return bound.json as { bindingId: string; created: boolean };
}

async function contestantEntry(r: Round) {
  const created = await call(entriesRoute, r.p, { headers: r.host, body: {} });
  expect(created.status, created.text).toBe(201);
  const entry = created.json.entry as { entryId: string; label: string; claimCode: string };
  const seed = seedCounter++;
  const entryParams = { ...r.p, entryId: entry.entryId };
  const uploaded = await call(photoUploadRoute, entryParams, {
    headers: r.host,
    body: { fullImage: buildJpeg({ seed, filler: 800 }).toString("base64"), thumbImage: buildJpeg({ seed: seed + 1, width: 320, height: 240 }).toString("base64") },
  });
  expect(uploaded.status, uploaded.text).toBe(201);
  const photoId = uploaded.json.photoId as string;
  expect((await call(consentRoute, entryParams, { headers: r.host, body: { photoId, consentVersion: GALLERY_CONSENT_VERSION, ageConfirmed: true, accepted: true } })).status).toBe(201);
  expect((await call(decisionRoute, entryParams, { headers: r.host, body: { photoId, decision: "APPROVED" } })).status).toBe(200);
  const person = await fullUser();
  await bindAs(r, person);
  const claimed = await call(claimsRoute, r.p, { headers: person.bearer, body: { claimCode: entry.claimCode } });
  expect(claimed.status, claimed.text).toBe(201);
  const confirmed = await call(associationRoute, entryParams, { headers: r.host, body: { confirmationCode: claimed.json.confirmationCode } });
  expect(confirmed.status, confirmed.text).toBe(200);
  return { entry, person, photoId, entryParams };
}
/** The PRELIMINARY cannot open without a configured closing time in the future: that time is its deadline for voting. */
async function configureClosing(r: Round, closesInMs = 4 * 3_600_000) {
  const set = await call(scheduleRoute, r.p, { method: "PUT", headers: r.host, body: { registrationOpensAt: null, contestantCutoffAt: null, votingOpensAt: null, votingClosesAt: new Date(Date.now() + closesInMs).toISOString(), status: "CONFIRMED" } });
  expect(set.status, set.text).toBe(200);
}
async function open(r: Round) {
  if (r.role === "PRELIMINARY") await configureClosing(r);
  await lockLobby(sessionRepo, r.session.sessionId, r.session.hostToken);
  const opened = await call(openRoute, r.p, { headers: r.host, body: { promptText: "Mejor disfraz" } });
  expect(opened.status, opened.text).toBe(201);
  r.interactionInstanceId = opened.json.started.interactionInstanceId as string;
  return opened.json.started as { interactionInstanceId: string; openedAt: string; deadlineAt: string | null; candidateCount: number };
}
async function openedRound(role: "PRELIMINARY" | "FINAL", n: number, opts: { op?: Awaited<ReturnType<typeof newOperator>>; source?: Round } = {}) {
  const r = await newRound(role, opts);
  const contestants: Awaited<ReturnType<typeof contestantEntry>>[] = [];
  if (role === "PRELIMINARY") for (let i = 0; i < n; i++) contestants.push(await contestantEntry(r));
  else {
    const prepared = await call(prepareFinalRoute, r.p, { headers: r.host });
    expect(prepared.status, prepared.text).toBe(200);
  }
  const started = await open(r);
  return { r, contestants, started };
}
async function candidatesOf(r: Round, person: Person) {
  await bindAs(r, person); // the page binds first (idempotent), then browses
  const g = await get(galleryRoute, r.p, person.bearer);
  expect(g.status, g.text).toBe(200);
  return g.json.items as Array<{ alias: string; candidateId: string; thumbUrl: string; fullUrl: string; mine: boolean }>;
}

/** The three steps a browser performs for one vote: bind (idempotent), intent, vote. */
async function vote(r: Round, person: Person, candidateId: string, location?: unknown) {
  const binding = await bindAs(r, person);
  const intent = await call(intentsRoute, r.p, { headers: person.bearer });
  expect(intent.status, intent.text).toBe(201);
  const cast = await call(votesRoute, r.p, {
    headers: person.bearer,
    body: { bindingId: binding.bindingId, intentNo: intent.json.intentNo, interactionInstanceId: r.interactionInstanceId, candidateId, ...(location === undefined ? {} : { location }) },
  });
  return { binding, intent: intent.json, cast };
}
const votesIn = async (r: Round) => Number((await q<{ n: string }>("select count(*) n from votes where interaction_instance_id = $1", [r.interactionInstanceId]))[0].n);

// =====================================================================================================================
// Identity at the HTTP edge: verified email + Gaming Member, nothing else
// =====================================================================================================================

describe("who may vote", () => {
  it("rejects a missing, malformed or forged token on every voter route (401), and touches nothing", async () => {
    const { r } = await openedRound("PRELIMINARY", 2);
    const voterRoutes: Array<[string, Handler, string]> = [
      ["binding", bindingRoute, "POST"], ["intents", intentsRoute, "POST"], ["votes", votesRoute, "POST"],
      ["status", statusRoute, "GET"], ["gallery", galleryRoute, "GET"], ["claims", claimsRoute, "POST"],
    ];
    const badHeaders: Array<Record<string, string>> = [{}, { authorization: "Bearer" }, { authorization: "Basic abc" }, { authorization: "Bearer not.a.jwt" }, { authorization: `Bearer ${"a".repeat(64)}` }];
    for (const headers of badHeaders) {
      for (const [name, handler, method] of voterRoutes) {
        const res = await call(handler, r.p, { method, headers, body: method === "POST" ? {} : undefined });
        expect({ name, status: res.status, code: res.json.code }).toEqual({ name, status: 401, code: "AUTHENTICATION_REQUIRED" });
      }
    }
    expect(await votesIn(r)).toBe(0);
  });

  it("an email that is not verified cannot bind, take an intent, vote or browse — on every voter route (403 VERIFIED_EMAIL_REQUIRED) — and leaves no trace", async () => {
    const { r, contestants } = await openedRound("PRELIMINARY", 2);
    const person = await fullUser();
    const [cand] = await candidatesOf(r, contestants[0].person);
    // the person had a valid session; the email stops being confirmed (nothing else changes)
    await q("update auth.users set email_confirmed_at = null where id = $1", [person.authUserId]);
    for (const [name, handler, method] of [["binding", bindingRoute, "POST"], ["intents", intentsRoute, "POST"], ["votes", votesRoute, "POST"], ["status", statusRoute, "GET"], ["gallery", galleryRoute, "GET"]] as Array<[string, Handler, string]>) {
      const res = await call(handler, r.p, { method, headers: person.bearer, body: method === "POST" ? { bindingId: randomUUID(), intentNo: 1, interactionInstanceId: r.interactionInstanceId, candidateId: cand.candidateId } : undefined });
      expect({ name, status: res.status, code: res.json.code }).toEqual({ name, status: 403, code: "VERIFIED_EMAIL_REQUIRED" });
    }
    expect(await q("select 1 from community_voting_voter_bindings where instance_id = $1 and auth_user_id = $2", [r.id, person.authUserId])).toHaveLength(0);
    expect(await votesIn(r)).toBe(0);
  });

  it("a telephone-only session is not a voter either: no email, no vote", async () => {
    const { r } = await openedRound("PRELIMINARY", 2);
    const phone = await phoneOnlyUser();
    const res = await call(bindingRoute, r.p, { headers: phone.bearer });
    expect({ status: res.status, code: res.json.code }).toEqual({ status: 403, code: "VERIFIED_EMAIL_REQUIRED" });
  });

  it("a verified email WITHOUT a profile cannot vote (403 PROFILE_INCOMPLETE); completing the profile through the existing route lets the same session continue and vote", async () => {
    const { r, contestants } = await openedRound("PRELIMINARY", 3);
    const [first] = await candidatesOf(r, contestants[0].person);
    const person = await emailUser();
    // the profile is what is missing: the existing route says so, and so does every voting route
    const before = await call(memberGet, {}, { method: "GET", headers: person.bearer });
    expect(before.json.gamingMember).toBeNull();
    for (const [name, handler, method] of [["binding", bindingRoute, "POST"], ["intents", intentsRoute, "POST"], ["votes", votesRoute, "POST"], ["status", statusRoute, "GET"], ["gallery", galleryRoute, "GET"]] as Array<[string, Handler, string]>) {
      const res = await call(handler, r.p, { method, headers: person.bearer, body: method === "POST" ? { bindingId: randomUUID(), intentNo: 1, interactionInstanceId: r.interactionInstanceId, candidateId: first.candidateId } : undefined });
      expect({ name, status: res.status, code: res.json.code }).toEqual({ name, status: 403, code: "PROFILE_INCOMPLETE" });
    }
    expect(await q("select 1 from community_voting_voter_bindings where instance_id = $1 and auth_user_id = $2", [r.id, person.authUserId])).toHaveLength(0);
    expect(await q("select 1 from participants where session_id = $1 and display_name like 'cv-%'", [r.session.sessionId])).toHaveLength(3); // only the three contestants' own

    // ... the person completes the profile (the existing flow) and carries on with the SAME token
    const member = await completeProfile(person, "Lucía");
    const voted = await vote(r, person, first.candidateId);
    expect(voted.cast.status, voted.cast.text).toBe(200);
    expect(voted.cast.json.outcome).toBe("APPLIED");
    const [binding] = await q<{ gaming_member_id: string }>("select gaming_member_id from community_voting_voter_bindings where binding_id = $1", [voted.binding.bindingId]);
    expect(binding.gaming_member_id).toBe(member.gamingMemberId);
    expect(await q("select 1 from gaming_members where auth_user_id = $1", [person.authUserId])).toHaveLength(1);
  });

  it("derives the identity from the token alone: another member's id in the body or headers changes nothing", async () => {
    const { r, contestants } = await openedRound("PRELIMINARY", 2);
    const [cand] = await candidatesOf(r, contestants[0].person);
    const mine = await fullUser();
    const other = await fullUser();
    const binding = await bindAs(r, mine);
    const intent = await call(intentsRoute, r.p, { headers: { ...mine.bearer, "x-gaming-member-id": other.gamingMemberId } });
    const cast = await call(votesRoute, r.p, {
      headers: mine.bearer,
      body: { bindingId: binding.bindingId, intentNo: intent.json.intentNo, interactionInstanceId: r.interactionInstanceId, candidateId: cand.candidateId, gamingMemberId: other.gamingMemberId, authUserId: other.authUserId },
    });
    expect(cast.status).toBe(200);
    const rows = await q<{ auth_user_id: string; gaming_member_id: string }>("select auth_user_id, gaming_member_id from community_voting_voter_bindings where binding_id = $1", [binding.bindingId]);
    expect(rows[0]).toEqual({ auth_user_id: mine.authUserId, gaming_member_id: mine.gamingMemberId });
    expect(await q("select 1 from community_voting_voter_bindings where instance_id = $1 and auth_user_id = $2", [r.id, other.authUserId])).toHaveLength(0);
  });

  it("GATE-003's telephone policy is untouched: its own binding route still demands a confirmed phone of an email-only user", async () => {
    const person = await fullUser();
    const session = await createSession(sessionRepo);
    await setSessionCapabilities(sessionRepo, session.sessionId, session.hostToken, ["VOTING"] as never);
    const single = await (await import("../lib/gaming/communityVoting/db/supabaseCommunityVotingRepository")).SupabaseCommunityVotingRepository.prototype.registerInstance.call(
      new (await import("../lib/gaming/communityVoting/db/supabaseCommunityVotingRepository")).SupabaseCommunityVotingRepository(supabaseUrl!, serviceKey!),
      { sessionId: session.sessionId, hostToken: session.hostToken, config: VENUE, ruleVersion: 1 }
    );
    const res = await call(gate003BindingRoute, { instanceId: single.instanceId }, { headers: person.bearer });
    expect({ status: res.status, code: res.json.code }).toEqual({ status: 403, code: "VERIFIED_PHONE_REQUIRED" });
  });
});

// =====================================================================================================================
// The preliminary at the HTTP edge: anywhere, one favorite, revisable
// =====================================================================================================================

describe("preliminary round over HTTP", () => {
  it("announces that no location is needed, and accepts a vote without one — then lets the voter change it, with one row per voter", async () => {
    const { r, contestants } = await openedRound("PRELIMINARY", 3);
    const info = await get(infoRoute, r.p);
    expect(info.status).toBe(200);
    expect(info.json.info).toMatchObject({ roundRole: "PRELIMINARY", phase: "OPEN", locationRequired: false, windowSeconds: null });
    expect(typeof info.json.info.deadlineAt).toBe("string"); // the preliminary's binding deadline is the configured closing
    expect(info.json.info.deadlineRemainingMs).toBeGreaterThan(3 * 3_600_000);
    expect(info.json.texts.galleryConsent.version).toBe(GALLERY_CONSENT_VERSION);
    expect(info.json.texts.promoConsent.version).toBe(PROMO_CONSENT_VERSION);

    const voter = await fullUser();
    const items = await candidatesOf(r, voter);
    expect(items).toHaveLength(3);
    const first = await vote(r, voter, items[0].candidateId);
    expect(first.cast.status).toBe(200);
    expect(first.cast.json.outcome).toBe("APPLIED");
    const status1 = await get(statusRoute, r.p, voter.bearer);
    expect(status1.json).toMatchObject({ bound: true, roundRole: "PRELIMINARY", phase: "OPEN", locationRequired: false, myCandidateId: items[0].candidateId });

    const revised = await vote(r, voter, items[1].candidateId);
    expect(revised.cast.json.outcome).toBe("APPLIED");
    expect((await get(statusRoute, r.p, voter.bearer)).json.myCandidateId).toBe(items[1].candidateId);
    expect((await vote(r, voter, items[1].candidateId)).cast.json.outcome).toBe("UNCHANGED");
    expect(await votesIn(r)).toBe(1);
    void contestants;
  });

  it("never reads a location in the preliminary: a reading sent anyway — even a malformed one — is ignored and nothing of it is stored", async () => {
    const { r } = await openedRound("PRELIMINARY", 2);
    const voter = await fullUser();
    const [c] = await candidatesOf(r, voter);
    const garbage = await vote(r, voter, c.candidateId, { latitude: "nope", longitude: 999, accuracyMeters: -3 });
    expect(garbage.cast.status, garbage.cast.text).toBe(200);
    const faraway = await vote(r, await fullUser(), c.candidateId, OUTSIDE);
    expect(faraway.cast.status).toBe(200);
    const evidence = await q("select applied_distance_meters, applied_accuracy_meters from community_voting_voter_bindings where instance_id = $1 and applied_intent_no > 0", [r.id]);
    expect(evidence).toHaveLength(2);
    for (const row of evidence) expect(row).toEqual({ applied_distance_meters: null, applied_accuracy_meters: null });
  });

  it("shows a voter no standing at all: no count, rank, total, leader or tally anywhere the voter or the public can read", async () => {
    const { r, contestants } = await openedRound("PRELIMINARY", 3);
    const voters = [await fullUser(), await fullUser(), await fullUser()];
    const items = await candidatesOf(r, voters[0]);
    for (const v of voters) await vote(r, v, items[0].candidateId);
    const readable = [
      (await get(infoRoute, r.p)).text,
      (await get(statusRoute, r.p, voters[0].bearer)).text,
      (await get(galleryRoute, r.p, voters[0].bearer)).text,
      (await get(slideshowRoute, r.p)).text,
      (await get(publicResultsRoute, r.p)).text,
    ].join("\n");
    expect(readable).not.toMatch(/\bvotes?\b.*:\s*\d|rank|tally|total|leader|winner|count/i);
    // the operator's overview carries one aggregate counter and no per-contestant figure; results are refused until the close
    const overview = await get(overviewRoute, r.p, r.host);
    expect(overview.json.counters.votes).toBe(3);
    expect(JSON.stringify(overview.json.entries)).not.toMatch(/vote|rank|total|count/i);
    const results = await get(resultsRoute, r.p, r.host);
    expect({ status: results.status, code: results.json.code }).toEqual({ status: 409, code: "RESULTS_NOT_AVAILABLE" });
    void contestants;
  });

  it("serves the discovery gallery in a per-voter order, with photographs only by their opaque number", async () => {
    const { r } = await openedRound("PRELIMINARY", 5);
    const a = await fullUser();
    const b = await fullUser();
    const ga = await candidatesOf(r, a);
    const gb = await candidatesOf(r, b);
    expect(ga.map((x) => x.alias).sort()).toEqual(gb.map((x) => x.alias).sort());
    expect(ga.map((x) => x.alias)).toEqual((await candidatesOf(r, a)).map((x) => x.alias)); // reproducible for the same voter
    for (const item of ga) {
      expect(item.thumbUrl).toMatch(new RegExp(`/rounds/${r.id}/photos/${item.alias}\\?v=thumb$`));
      const photo = await get(photoRoute, { ...r.p, alias: item.alias }, {}, "?v=thumb");
      expect(photo.status).toBe(200);
      expect(photo.headers.get("content-type")).toBe("image/jpeg");
    }
    expect((await get(photoRoute, { ...r.p, alias: "0000" }, {}, "?v=thumb")).status).toBe(404);
    expect((await get(photoRoute, { ...r.p, alias: ga[0].alias }, {}, "?v=huge")).status).toBe(404);
  });
});

// =====================================================================================================================
// Both rounds, one identity: the preliminary, the cut, the final
// =====================================================================================================================

describe("the whole journey over HTTP", () => {
  it("one identity votes in BOTH rounds without being duplicated; the final starts from zero, asks for a location with every vote, and enforces its window", async () => {
    const op = await newOperator();
    const { r: p, contestants } = await openedRound("PRELIMINARY", 3, { op });
    const shared = await fullUser();
    const items = await candidatesOf(p, shared);
    // votes in the preliminary: 2 for item 0, 1 for item 1, from the shared identity plus one other
    const sharedVote = await vote(p, shared, items[0].candidateId);
    expect(sharedVote.cast.status).toBe(200);
    await vote(p, await fullUser(), items[0].candidateId);
    await vote(p, await fullUser(), items[1].candidateId);

    // close (explicit), results (operator only, after the close), the cut, the review, the publication
    expect((await get(resultsRoute, p.p, p.host)).status).toBe(409);
    const closed = await call(closeRoute, p.p, { headers: p.host });
    expect(closed.status, closed.text).toBe(200);
    expect(closed.json.closure.validVoteCount).toBe(3);
    expect((await call(closeRoute, p.p, { headers: p.host })).json.code).toBe("ALREADY_CLOSED");
    const late = await vote(p, await fullUser(), items[2].candidateId).catch(() => null);
    expect(late).toBeNull(); // nobody new is admitted after the close
    const results = await get(resultsRoute, p.p, p.host);
    expect(results.status, results.text).toBe(200);
    expect(results.json.rows.map((x: { votes: number }) => x.votes).sort()).toEqual([0, 1, 2]);
    expect((await call(reviewRoute, p.p, { headers: p.host, body: {} })).json.code).toBe("FINALISTS_NOT_SELECTED");
    // one contestant received no vote: the cut fails closed until Product's decision is recorded, citing it
    const blockedCut = await call(finalistsRoute, p.p, { headers: p.host });
    expect({ status: blockedCut.status, code: blockedCut.json.code }).toEqual({ status: 409, code: "POLICY_REQUIRED" });
    expect(blockedCut.json.error).toContain("ZERO_VOTE_ENTRIES_AT_CUTOFF");
    expect((await get(overviewRoute, p.p, p.host)).json.pendingResolutions).toEqual([{ key: "ZERO_VOTE_ENTRIES_AT_CUTOFF" }]);
    expect((await call(policiesRoute, p.p, { headers: p.host, body: { policyKey: "ZERO_VOTE_ENTRIES_AT_CUTOFF", policyValue: "TIED_ZERO_VOTE_ENTRIES_ADVANCE", approvalReference: "ACTA-PRODUCTO-1" } })).status).toBe(201);
    const cut = await call(finalistsRoute, p.p, { headers: p.host });
    expect(cut.status, cut.text).toBe(200);
    expect(cut.json.selection).toMatchObject({ finalistCount: 3, eligibleCount: 3, alreadySelected: false });
    expect((await call(publishRoute, p.p, { headers: p.host })).json.code).toBe("REVIEW_REQUIRED");
    expect((await call(reviewRoute, p.p, { headers: p.host, body: { note: "Revisión operativa" } })).status).toBe(201);
    expect((await call(publishRoute, p.p, { headers: p.host })).status).toBe(201);
    const announced = await get(publicResultsRoute, p.p);
    expect(announced.json).toMatchObject({ published: true, kind: "FINALISTS" });
    expect(announced.json.items).toHaveLength(3);

    // the final: registered from the preliminary, prepared from the cut, opened by the operator
    const f = await newRound("FINAL", { op, source: p });
    const { started } = await (async () => {
      const prepared = await call(prepareFinalRoute, f.p, { headers: f.host });
      expect(prepared.status, prepared.text).toBe(200);
      expect(prepared.json.prepared).toEqual({ carriedCount: 3, alreadyPrepared: false });
      const s = await open(f);
      return { started: s };
    })();
    expect(new Date(started.deadlineAt!).getTime() - new Date(started.openedAt).getTime()).toBe(FINAL_WINDOW_SECONDS * 1000);
    const finfo = await get(infoRoute, f.p);
    expect(finfo.json.info).toMatchObject({ roundRole: "FINAL", phase: "OPEN", locationRequired: true, windowSeconds: 300 });
    expect(finfo.json.info.deadlineRemainingMs).toBeGreaterThan(290_000);

    // the same identity binds in the final (a binding per round), and its preliminary vote does not count here
    const fitems = await candidatesOf(f, shared);
    expect(fitems).toHaveLength(3);
    expect(await votesIn(f)).toBe(0);
    const noLocation = await vote(f, shared, fitems[1].candidateId);
    expect({ status: noLocation.cast.status, code: noLocation.cast.json.code }).toEqual({ status: 400, code: "INVALID_LOCATION_READING" });
    const outside = await vote(f, shared, fitems[1].candidateId, OUTSIDE);
    expect({ status: outside.cast.status, code: outside.cast.json.code }).toEqual({ status: 403, code: "LOCATION_OUTSIDE" });
    const inside = await vote(f, shared, fitems[1].candidateId, INSIDE);
    expect(inside.cast.status, inside.cast.text).toBe(200);
    expect(inside.cast.json.outcome).toBe("APPLIED");
    // the revision needs a location again; a refused one leaves the standing vote
    const revOutside = await vote(f, shared, fitems[2].candidateId, OUTSIDE);
    expect(revOutside.cast.status).toBe(403);
    expect((await get(statusRoute, f.p, shared.bearer)).json.myCandidateId).toBe(fitems[1].candidateId);
    const last = await vote(f, shared, fitems[2].candidateId, INSIDE);
    expect(last.cast.json.outcome).toBe("APPLIED");

    // one row per round for the shared identity; nothing accumulated in either direction
    const rows = await q<{ interaction_instance_id: string }>(
      "select v.interaction_instance_id from votes v join community_voting_voter_bindings b on b.participant_id = v.participant_id where b.auth_user_id = $1",
      [shared.authUserId]
    );
    expect(rows.map((x) => x.interaction_instance_id).sort()).toEqual([p.interactionInstanceId, f.interactionInstanceId].sort());
    expect(await votesIn(f)).toBe(1);

    // the server's clock ends the window: ten minutes later, whatever any screen shows
    await q("update interaction_instances set created_at = created_at - interval '301 seconds' where interaction_instance_id = $1", [f.interactionInstanceId]);
    const tooLate = await vote(f, await fullUser(), fitems[0].candidateId, INSIDE);
    expect({ status: tooLate.cast.status, code: tooLate.cast.json.code }).toEqual({ status: 409, code: "VOTING_WINDOW_ELAPSED" });
    expect((await get(infoRoute, f.p)).json.info).toMatchObject({ phase: "CLOSED", deadlineRemainingMs: 0 });
    // ... yet the voter who already voted can still recover the confirmation of that vote
    const replay = await call(votesRoute, f.p, {
      headers: shared.bearer,
      body: { bindingId: last.binding.bindingId, intentNo: last.intent.intentNo, interactionInstanceId: f.interactionInstanceId, candidateId: fitems[2].candidateId, location: INSIDE },
    });
    expect(replay.status).toBe(200);
    expect(replay.json.outcome).toBe("REPLAYED");
    // an older intent is stale, never reported as a success
    const stale = await call(votesRoute, f.p, {
      headers: shared.bearer,
      body: { bindingId: inside.binding.bindingId, intentNo: inside.intent.intentNo, interactionInstanceId: f.interactionInstanceId, candidateId: fitems[1].candidateId, location: INSIDE },
    });
    expect({ status: stale.status, code: stale.json.code, outcome: stale.json.intentOutcome }).toEqual({ status: 409, code: "STALE_INTENT", outcome: "HISTORICAL_OUTCOME_UNAVAILABLE" });

    // close, review, publish; the winners are announced, with no count
    expect((await call(closeRoute, f.p, { headers: f.host })).status).toBe(200);
    const fres = await get(resultsRoute, f.p, f.host);
    expect(fres.json.rows.filter((x: { winner: boolean }) => x.winner)).toHaveLength(1);
    expect((await call(reviewRoute, f.p, { headers: f.host, body: {} })).status).toBe(201);
    expect((await call(publishRoute, f.p, { headers: f.host })).status).toBe(201);
    const winners = await get(publicResultsRoute, f.p);
    expect(winners.json).toMatchObject({ published: true, kind: "WINNERS" });
    expect(winners.json.items).toHaveLength(1);
    void contestants;
  });

  it("the operator routes demand BOTH the host token and the designated Gaming Member — a voter, another member or a wrong token is refused", async () => {
    const { r } = await openedRound("PRELIMINARY", 2);
    const voter = await fullUser();
    const otherMember = await fullUser();
    const attempts: Array<[string, Handler, string]> = [
      ["overview", overviewRoute, "GET"], ["results", resultsRoute, "GET"], ["close", closeRoute, "POST"], ["finalists", finalistsRoute, "POST"],
      ["review", reviewRoute, "POST"], ["publish", publishRoute, "POST"], ["policies", policiesRoute, "POST"], ["entries", entriesRoute, "POST"], ["open", openRoute, "POST"],
    ];
    for (const [name, handler, method] of attempts) {
      const postBody = name === "open" ? { promptText: "Mejor disfraz" } : name === "policies" ? { policyKey: "ZERO_VALID_VOTES_PRELIMINARY", policyValue: "ALL_ENTRIES_ADVANCE", approvalReference: "ACTA-9" } : {};
      const common = { method, body: method === "POST" ? postBody : undefined };
      expect((await call(handler, r.p, { ...common, headers: {} })).status, `${name} anonymous`).toBe(401);
      expect((await call(handler, r.p, { ...common, headers: { "x-host-token": r.host["x-host-token"] } })).status, `${name} token only`).toBe(401);
      expect((await call(handler, r.p, { ...common, headers: r.op.bearer })).status, `${name} bearer only`).toBe(401);
      expect((await call(handler, r.p, { ...common, headers: { ...voter.bearer, "x-host-token": r.host["x-host-token"] } })).status, `${name} voter`).toBe(403);
      expect((await call(handler, r.p, { ...common, headers: { ...otherMember.bearer, "x-host-token": r.host["x-host-token"] } })).json.code, `${name} other member`).toBe("OPERATOR_REQUIRED");
      expect((await call(handler, r.p, { ...common, headers: { ...r.op.bearer, "x-host-token": "wrong" } })).status, `${name} wrong token`).toBe(403);
    }
    expect((await call(scheduleRoute, r.p, { method: "PUT", headers: voter.bearer, body: { status: "TENTATIVE" } })).status).toBe(401);
    expect((await get(overviewRoute, r.p, r.host)).status).toBe(200);
    // nothing above closed or changed the round
    expect((await q<{ state: string }>("select state from interaction_instances where interaction_instance_id = $1", [r.interactionInstanceId]))[0].state).toBe("PROMPT_ACTIVE");
  });

  it("the schedule BINDS: the preliminary cannot open without a closing in the future, an opened round's schedule is frozen, and the withdrawal and the promotional decision go through their own routes", async () => {
    const r = await newRound("PRELIMINARY");
    const c1 = await contestantEntry(r);
    await contestantEntry(r);
    await lockLobby(sessionRepo, r.session.sessionId, r.session.hostToken);
    const earlier = new Date(Date.now() - 7_200_000).toISOString();
    const past = new Date(Date.now() - 3_600_000).toISOString();

    // no closing at all, then a closing already past: neither opens
    expect((await call(openRoute, r.p, { headers: r.host, body: { promptText: "Mejor disfraz" } })).json.code).toBe("SCHEDULE_REQUIRED");
    expect((await call(scheduleRoute, r.p, { method: "PUT", headers: r.host, body: { registrationOpensAt: null, contestantCutoffAt: null, votingOpensAt: earlier, votingClosesAt: past, status: "TENTATIVE" } })).status).toBe(200);
    expect((await call(openRoute, r.p, { headers: r.host, body: { promptText: "Mejor disfraz" } })).json.code).toBe("SCHEDULE_REQUIRED");
    // an incoherent schedule is refused
    expect((await call(scheduleRoute, r.p, { method: "PUT", headers: r.host, body: { registrationOpensAt: null, contestantCutoffAt: null, votingOpensAt: past, votingClosesAt: earlier, status: "TENTATIVE" } })).json.code).toBe("SCHEDULE_INVALID");

    const promo = await call(promoRoute, c1.entryParams, { headers: r.host, body: { consentVersion: PROMO_CONSENT_VERSION, decision: "DECLINED" } });
    expect(promo.status, promo.text).toBe(201);
    const closesAt = new Date(Date.now() + 3_600_000).toISOString();
    expect((await call(scheduleRoute, r.p, { method: "PUT", headers: r.host, body: { registrationOpensAt: null, contestantCutoffAt: null, votingOpensAt: earlier, votingClosesAt: closesAt, status: "CONFIRMED" } })).status).toBe(200);
    const opened = await call(openRoute, r.p, { headers: r.host, body: { promptText: "Mejor disfraz" } });
    expect(opened.status, opened.text).toBe(201);
    expect(opened.json.started.deadlineAt).toBe(closesAt);
    const info = await get(infoRoute, r.p);
    expect(info.json.info).toMatchObject({ phase: "OPEN", tentative: false, votingClosesAt: closesAt, votingOpensAt: earlier, deadlineAt: closesAt });
    // frozen once it has opened
    expect((await call(scheduleRoute, r.p, { method: "PUT", headers: r.host, body: { registrationOpensAt: null, contestantCutoffAt: null, votingOpensAt: earlier, votingClosesAt: new Date(Date.now() + 86_400_000).toISOString(), status: "CONFIRMED" } })).json.code).toBe("PREPARATION_CLOSED");

    const gone = await call(withdrawalRoute, c1.entryParams, { headers: r.host, body: { reason: "Retiro" } });
    expect(gone.status, gone.text).toBe(201);
    expect(gone.json).toMatchObject({ photoHidden: false });
    const items = await candidatesOf(r, await fullUser());
    expect(items).toHaveLength(1);
    const photo = await get(photoRoute, { ...r.p, alias: c1.entry.label.slice(1) }, {}, "?v=thumb");
    expect(photo.status).toBe(404);
  });

  it("hides a photograph, withdraws a candidature and resolves a follow-up task through their own routes — each operator only", async () => {
    const r = await newRound("PRELIMINARY");
    const c1 = await contestantEntry(r);
    const c2 = await contestantEntry(r);
    const stranger = await fullUser();
    const body = { reason: "La persona lo pidió" };
    expect((await call(hidePhotoRoute, c1.entryParams, { headers: stranger.bearer, body })).status).toBe(401);
    expect((await call(hidePhotoRoute, c1.entryParams, { headers: { ...stranger.bearer, "x-host-token": r.host["x-host-token"] }, body })).json.code).toBe("OPERATOR_REQUIRED");
    const hidden = await call(hidePhotoRoute, c1.entryParams, { headers: r.host, body });
    expect(hidden.status, hidden.text).toBe(201);
    expect((await call(hidePhotoRoute, c1.entryParams, { headers: r.host, body })).json.code).toBe("PHOTO_HIDDEN");
    expect((await get(photoRoute, { ...r.p, alias: c1.entry.label.slice(1) }, {}, "?v=thumb")).status).toBe(404);
    expect((await call(hidePhotoRoute, c1.entryParams, { headers: r.host, body: {} })).status).toBe(400);

    const withErase = await call(withdrawalRoute, c2.entryParams, { headers: r.host, body: { reason: "Retiro y borrar", hidePhoto: true } });
    expect(withErase.json).toMatchObject({ photoHidden: true });
    expect((await call(withdrawalRoute, c2.entryParams, { headers: r.host, body: { reason: "x", hidePhoto: "yes" } })).status).toBe(400);

    // a withdrawn promotional consent opens a task, which is resolved once with a note
    const r2 = await newRound("PRELIMINARY");
    const c3 = await contestantEntry(r2);
    for (const decision of ["ACCEPTED", "WITHDRAWN"]) expect((await call(promoRoute, c3.entryParams, { headers: r2.host, body: { consentVersion: PROMO_CONSENT_VERSION, decision } })).status).toBe(201);
    const ov = await get(overviewRoute, r2.p, r2.host);
    const [task] = ov.json.tasks as Array<{ taskId: string; description: string }>;
    expect(task.description).toMatch(/no elimina publicaciones externas/);
    expect((await call(taskRoute, { ...r2.p, taskId: task.taskId }, { headers: r2.host, body: {} })).status).toBe(400);
    expect((await call(taskRoute, { ...r2.p, taskId: task.taskId }, { headers: r2.host, body: { note: "Retirada a mano" } })).status).toBe(200);
    expect((await call(taskRoute, { ...r2.p, taskId: task.taskId }, { headers: r2.host, body: { note: "otra vez" } })).json.code).toBe("ALREADY_CLOSED");
  });

  it("records a Product decision only with a supported value and its reference, once", async () => {
    const r = await newRound("PRELIMINARY");
    const ok = { policyKey: "ZERO_VALID_VOTES_PRELIMINARY", policyValue: "ALL_ENTRIES_ADVANCE", approvalReference: "ACTA-1" };
    expect((await call(policiesRoute, r.p, { headers: r.host, body: { ...ok, policyKey: "NOPE" } })).status).toBe(400);
    expect((await call(policiesRoute, r.p, { headers: r.host, body: { ...ok, policyValue: "SOMETHING" } })).status).toBe(400);
    expect((await call(policiesRoute, r.p, { headers: r.host, body: { ...ok, approvalReference: "  " } })).status).toBe(400);
    expect((await call(policiesRoute, r.p, { headers: r.host, body: ok })).status).toBe(201);
    expect((await call(policiesRoute, r.p, { headers: r.host, body: ok })).json.code).toBe("POLICY_ALREADY_RECORDED");
    const ov = await get(overviewRoute, r.p, r.host);
    expect(ov.json.policies.find((p: { key: string }) => p.key === "ZERO_VALID_VOTES_PRELIMINARY")).toMatchObject({ approved: true, approvalReference: "ACTA-1" });
  });

  it("answers a deleted route with 404: nothing serves a photograph purge", async () => {
    const root2 = join(__dirname, "..");
    expect(() => readdirSync(join(root2, "app/api/gaming/community-voting/rounds/[instanceId]/operator/media-purge"))).toThrow();
  });
});

// =====================================================================================================================
// UG-IV-GATE-006: a final with no valid votes has no result — at the HTTP edge
// =====================================================================================================================

describe("a final with no valid votes over HTTP", () => {
  it("refuses to publish with 409 NO_VALID_RESULT, announces nobody, keeps the evidence and tells the operator there is no result", async () => {
    const { r: p } = await openedRound("PRELIMINARY", 3);
    const items = await candidatesOf(p, await fullUser());
    for (const item of items) await vote(p, await fullUser(), item.candidateId); // every finalist has a vote, so the cut needs no Product decision
    expect((await call(closeRoute, p.p, { headers: p.host })).status).toBe(200);
    expect((await call(finalistsRoute, p.p, { headers: p.host })).status).toBe(200);
    expect((await call(reviewRoute, p.p, { headers: p.host, body: {} })).status).toBe(201);
    expect((await call(publishRoute, p.p, { headers: p.host })).status).toBe(201);

    const f = await newRound("FINAL", { op: p.op, source: p });
    expect((await call(prepareFinalRoute, f.p, { headers: f.host })).status).toBe(200);
    await open(f);
    expect((await call(closeRoute, f.p, { headers: f.host })).status).toBe(200); // nobody voted in the final
    const results = await get(resultsRoute, f.p, f.host);
    expect(results.status, results.text).toBe(200);
    expect(results.json.rows.filter((x: { winner: boolean }) => x.winner)).toEqual([]);
    expect((await call(reviewRoute, f.p, { headers: f.host, body: {} })).status).toBe(201);

    const refused = await call(publishRoute, f.p, { headers: f.host });
    expect({ status: refused.status, code: refused.json.code }).toEqual({ status: 409, code: "NO_VALID_RESULT" });
    expect(refused.json.error).toMatch(/no valid votes/i);

    const announced = await get(publicResultsRoute, f.p);
    expect(announced.json).toMatchObject({ published: false, items: [] });
    expect((await get(overviewRoute, f.p, f.host)).json).toMatchObject({ noValidResult: true, published: false });
    expect((await q<{ state: string }>("select state from interaction_instances where interaction_instance_id = $1", [f.interactionInstanceId]))[0].state).toBe("SUBMISSIONS_CLOSED");
    expect(await q("select 1 from community_voting_published_results where instance_id = $1", [f.id])).toHaveLength(0);
    expect(await q("select 1 from community_voting_publications where instance_id = $1", [f.id])).toHaveLength(0);
    expect(await votesIn(f)).toBe(0);
  });
});

// =====================================================================================================================
// Scope: nothing about the telephone, the five-option ballot or Instagram is part of the pilot's surface
// =====================================================================================================================

describe("the pilot's surface", () => {
  const root = join(__dirname, "..");
  const walk = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      return statSync(full).isDirectory() ? walk(full) : [full];
    });

  it("exposes no route about a telephone, WhatsApp, SMS, a ballot or Instagram", () => {
    const routes = walk(join(root, "app/api/gaming/community-voting/rounds")).map((f) => relative(root, f));
    expect(routes.length).toBeGreaterThan(20);
    for (const route of routes) expect(route).not.toMatch(/phone|whatsapp|sms|ballot|instagram/i);
  });

  it("imports nothing from the telephone provider, the ballot rules or the ranked results", () => {
    const sources = [...walk(join(root, "lib/gaming/communityVoting/rounds")), ...walk(join(root, "app/api/gaming/community-voting/rounds"))].filter((f) => f.endsWith(".ts"));
    for (const file of sources) {
      const text = readFileSync(file, "utf8");
      expect(text, relative(root, file)).not.toMatch(/phoneProvider|phoneNumber|ballotRules|ranked\/results|beginPhoneVerification|twilio|whatsapp|instagram/i);
    }
  });
});
