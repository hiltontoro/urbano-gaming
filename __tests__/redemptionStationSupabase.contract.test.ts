/// <reference types="vite/client" />
import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";

import { loadEnv } from "vite";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";

import { SupabasePredictionsRepository } from "../lib/gaming/predictions/db/supabasePredictionsRepository";
import { SupabaseGamingRepository } from "../lib/gaming/db/supabaseGamingRepository";
import { SupabaseStationRepository } from "../lib/gaming/redemption-station/db/supabaseStationRepository";
import { generateSalt, hashPin } from "../lib/gaming/redemption-station/pin";
import { prizePublicCode } from "../lib/gaming/redemption-station/publicCode";
import { InvalidStationRequestError, PrizeCodeNotFoundError, StationClosedError, StationMisconfiguredError, StationUnauthorizedError } from "../lib/gaming/redemption-station/types";
import { POST as sessionPOST } from "../app/api/gaming/canje/[slug]/session/route";
import { GET as prizesGET } from "../app/api/gaming/canje/[slug]/prizes/route";
import { POST as redeemPOST } from "../app/api/gaming/canje/[slug]/redeem/route";
import { POST as revokePOST } from "../app/api/gaming/canje/[slug]/revoke/route";
import { GET as pinGET, POST as pinPOST } from "../app/api/gaming/canje/[slug]/pin/route";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";
import { localSettlementDatabaseUrl, purgeSettlementEvidence, requireLoopbackDatabaseUrl } from "./helpers/localSettlementCleanup";
import { answersFor, buildLadderWorld, settle, submitAs, type LadderEnv, type LadderWorld } from "./helpers/progressiveLadderScenarios";

/**
 * THE REDEMPTION STATION against the real LOCAL database: the table constraints and triggers of the station itself, the PIN change and the
 * end of the sessions under real concurrency, the attempt limit, the delivery function called DIRECTLY (the data layer decides the scope, the
 * session and the rules whatever the caller sends) and compared with the existing redemption, and the whole flow through the routes with the
 * real prize repository. Nothing is stubbed. Every record is invented, on the disposable local database.
 */

const env = loadEnv("development", process.cwd(), "");
const supabaseUrl = env.SUPABASE_URL;
requireLocalSupabase(supabaseUrl);
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = env.SUPABASE_ANON_KEY;
if (!supabaseUrl || !serviceKey || !anonKey) throw new Error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are required for contract tests.");
const databaseUrl = localSettlementDatabaseUrl();
process.env.SUPABASE_URL = supabaseUrl;
process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey;
process.env.SUPABASE_ANON_KEY = anonKey;

const PIN = "73920184";
const NEW_PIN = "56018347";
const repo = new SupabasePredictionsRepository(supabaseUrl, serviceKey);
const gamingRepo = new SupabaseGamingRepository(supabaseUrl, serviceKey);
const stationRepo = new SupabaseStationRepository(supabaseUrl, serviceKey);
const admin: SupabaseClient = createClient(supabaseUrl, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
const sha256 = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");

const created = { authUsers: [] as string[], members: [] as string[], matches: [] as string[], venues: [] as string[], teams: [] as string[], stations: [] as string[] };

afterAll(async () => {
  requireLoopbackDatabaseUrl(databaseUrl);
  if (created.stations.length > 0) {
    const client = new Client({ connectionString: databaseUrl, statement_timeout: 20000 });
    await client.connect();
    try {
      await client.query("begin");
      await client.query("set local session_replication_role = replica"); // the station log is immutable by design; test teardown only
      for (const table of ["redemption_station_events", "redemption_station_pin_changes", "redemption_station_attempts", "redemption_station_sessions"]) await client.query(`delete from ${table} where station_id = any($1::uuid[])`, [created.stations]);
      await client.query("delete from redemption_stations where station_id = any($1::uuid[])", [created.stations]);
      await client.query("commit");
    } finally {
      await client.end();
    }
  }
  await purgeSettlementEvidence(databaseUrl, created.matches);
  for (const matchId of created.matches) {
    await admin.from("gaming_progression_events").delete().eq("match_id", matchId);
    await admin.from("predictions").delete().eq("match_id", matchId);
    const { data: activations } = await admin.from("venue_activations").select("venue_activation_id").eq("match_id", matchId);
    const ids = (activations ?? []).map((a) => a.venue_activation_id);
    if (ids.length > 0) await admin.from("prize_tiers").delete().in("venue_activation_id", ids);
    await admin.from("venue_activations").delete().eq("match_id", matchId);
    await admin.from("matches").delete().eq("match_id", matchId);
  }
  for (const venueId of created.venues) await admin.from("venues").delete().eq("venue_id", venueId);
  for (const teamId of created.teams) {
    await admin.from("players").delete().eq("team_id", teamId);
    await admin.from("teams").delete().eq("team_id", teamId);
  }
  if (created.members.length > 0) {
    await admin.from("admin_audit_events").delete().in("actor_id", created.members);
    await admin.from("authority_grants").delete().in("gaming_member_id", created.members);
    await admin.from("gaming_xp_events").delete().in("gaming_member_id", created.members);
    await admin.from("experience_summaries").delete().in("gaming_member_id", created.members);
  }
  for (const id of created.authUsers) await admin.auth.admin.deleteUser(id);
}, 180000);

async function realMember(displayName: string, withToken = false) {
  const email = `station-contract-${randomUUID()}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("auth user");
  created.authUsers.push(data.user.id);
  const member = await gamingRepo.createGamingMember(data.user.id, displayName);
  created.members.push(member.gamingMemberId);
  if (!withToken) return member.gamingMemberId;
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (!link.data.properties) throw new Error("generateLink did not return properties.");
  // a throwaway client for the sign-in: verifying a code on the service client would turn it into that member for every call after it
  const signIn = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const verified = await signIn.auth.verifyOtp({ token_hash: link.data.properties.hashed_token, type: "email" });
  return { id: member.gamingMemberId, token: verified.data.session!.access_token };
}

async function grant(memberId: string, authorityClass: "CONSEQUENTIAL_FINALIZER" | "OPERATIONAL" = "CONSEQUENTIAL_FINALIZER") {
  const { error } = await admin.from("authority_grants").insert({ gaming_member_id: memberId, authority_class: authorityClass });
  if (error) throw error;
}

interface World {
  env: LadderEnv;
  world: LadderWorld;
  otherWorld: LadderWorld;
  /** The finalizer who settles the match: a person with general authority. The station never acts as them. */
  actor: string;
  /** The identity of the station: a member with NO authority at all. */
  stationActor: string;
  prizes: Record<"ana1" | "ana2" | "bruno", string>;
  extra: string[];
  otherPrize: string;
}

async function buildWorld(extraWinners = 0): Promise<World> {
  const actor = (await realMember("Finalizador (persona)")) as string;
  await grant(actor);
  const stationActor = (await realMember("Estación de canje (prueba)")) as string;
  const ladderEnv: LadderEnv = { repo, newMember: (label) => realMember(label) as Promise<string>, finalizerId: actor, operatorId: actor };
  const world = await buildLadderWorld(ladderEnv, { offeredLevels: [1, 2, 3, 4] });
  const otherWorld = await buildLadderWorld(ladderEnv, { offeredLevels: [1, 2, 3, 4] });
  for (const w of [world, otherWorld]) { created.matches.push(w.matchId); created.venues.push(w.venueId); created.teams.push(w.homeTeamId, w.awayTeamId); }
  const entries: Array<readonly [string, number, { S: boolean; F: boolean; G: boolean; M: boolean }]> = [
    ["Ana", 1, { S: true, F: false, G: false, M: false }],
    ["Ana", 1, { S: true, F: false, G: false, M: false }],
    ["Bruno", 4, { S: true, F: true, G: true, M: false }],
    ["Perdedor", 1, { S: false, F: false, G: false, M: false }],
    ...Array.from({ length: extraWinners }, (_, i) => [`Extra${i}`, 1, { S: true, F: false, G: false, M: false }] as const),
  ];
  for (const [name, level, flags] of entries) await submitAs(ladderEnv, world, (await realMember(name)) as string, answersFor(world, level, flags));
  await submitAs(ladderEnv, otherWorld, (await realMember("Carla")) as string, answersFor(otherWorld, 1, { S: true, F: false, G: false, M: false }));
  await settle(ladderEnv, world, "TWO_ONE");
  await settle(ladderEnv, otherWorld, "TWO_ONE");
  const mine = await repo.listQualificationDetailsForActivation(world.activationId);
  const other = await repo.listQualificationDetailsForActivation(otherWorld.activationId);
  const named = (n: string) => mine.filter((q) => q.memberDisplayName === n);
  return {
    env: ladderEnv, world, otherWorld, actor, stationActor,
    prizes: { ana1: named("Ana")[0]!.prizeQualificationId, ana2: named("Ana")[1]!.prizeQualificationId, bruno: named("Bruno")[0]!.prizeQualificationId },
    extra: mine.filter((q) => (q.memberDisplayName ?? "").startsWith("Extra")).map((q) => q.prizeQualificationId),
    otherPrize: other[0]!.prizeQualificationId,
  };
}

async function newStation(w: World, overrides: Record<string, unknown> = {}) {
  const salt = generateSalt();
  const slug = `contract-${randomUUID().slice(0, 8)}`;
  const { data, error } = await admin
    .from("redemption_stations")
    .insert({
      slug,
      label: "The Pub · contrato",
      venue_activation_id: w.world.activationId,
      match_id: w.world.matchId,
      actor_gaming_member_id: w.stationActor,
      pin_salt: salt,
      pin_hash: hashPin(PIN, salt),
      pin_version: 1,
      expires_at: new Date(Date.now() + 2 * 24 * 3600_000).toISOString(),
      ...overrides,
    })
    .select()
    .single();
  if (error) throw error;
  created.stations.push(data.station_id);
  return { slug, stationId: data.station_id as string };
}

/** A session straight into the table, for the tests that call the delivery function directly. */
async function directSession(stationId: string, options: { pinVersion?: number; expiresInMs?: number } = {}) {
  const token = randomUUID() + randomUUID();
  const tokenSha256 = sha256(token);
  const session = await stationRepo.createSession({ stationId, tokenSha256, pinVersion: options.pinVersion ?? 1, expiresAt: new Date(Date.now() + (options.expiresInMs ?? 3600_000)).toISOString() });
  return { token, tokenSha256, sessionId: session.sessionId };
}

const redeemRaw = (tokenSha256: string, prize: string, operator = "Josué D") =>
  admin.rpc("redemption_station_redeem", { p_session_token_sha256: tokenSha256, p_prize_qualification_id: prize, p_declared_operator: operator });

const URL_OF = (slug: string) => `https://gaming.urbanohn.com/api/gaming/canje/${slug}`;
const p = (slug: string) => ({ params: { slug } });
const postReq = (url: string, body: unknown, headers: Record<string, string> = {}) =>
  new Request(url, { method: "POST", headers: { "content-type": "application/json", host: "gaming.urbanohn.com", ...headers }, body: JSON.stringify(body) });
const getReq = (url: string, headers: Record<string, string> = {}) => new Request(url, { headers: { host: "gaming.urbanohn.com", ...headers } });
async function openSession(slug: string, ip = "10.0.0.1", pin = PIN) {
  const res = await sessionPOST(postReq(URL_OF(slug) + "/session", { pin }, { "x-forwarded-for": ip }), p(slug));
  expect(res.status).toBe(200);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}
async function withDb<T>(run: (client: Client) => Promise<T>) {
  const client = new Client({ connectionString: databaseUrl, statement_timeout: 30000 });
  await client.connect();
  try { return await run(client); } finally { await client.end(); }
}
/** Sets a prize into a state that only a correction can create in practice (test setup only: triggers off inside this transaction). */
async function forcePrizeState(prizeId: string, sets: string, values: unknown[] = []) {
  await withDb(async (c) => {
    await c.query("begin");
    await c.query("set local session_replication_role = replica");
    await c.query(`update prize_qualifications set ${sets} where prize_qualification_id = $${values.length + 1}`, [...values, prizeId]);
    await c.query("commit");
  });
}

let shared: World;
async function world() { return (shared ??= await buildWorld()); }

describe("the station's own tables", () => {
  it("a station's activation must belong to its match, and its identity must hold NO authority (a person's account cannot be the actor)", async () => {
    const w = await world();
    const salt = generateSalt();
    const base = { slug: `bad-${randomUUID().slice(0, 8)}`, label: "x", pin_salt: salt, pin_hash: hashPin(PIN, salt), pin_version: 1, expires_at: new Date(Date.now() + 3600_000).toISOString() };
    const scope = { venue_activation_id: w.world.activationId, match_id: w.world.matchId };
    const crossed = await admin.from("redemption_stations").insert({ ...base, venue_activation_id: w.world.activationId, match_id: w.otherWorld.matchId, actor_gaming_member_id: w.stationActor });
    expect(crossed.error?.message).toMatch(/REDEMPTION_STATION_SCOPE/);
    // the finalizer (who holds the general authority the old design borrowed) is refused as the identity of a station
    const withFinalizer = await admin.from("redemption_stations").insert({ ...base, ...scope, actor_gaming_member_id: w.actor });
    expect(withFinalizer.error?.message).toMatch(/REDEMPTION_STATION_ACTOR/);
    // so is any other authority class
    const operational = (await realMember("Operativo")) as string;
    await grant(operational, "OPERATIONAL");
    expect((await admin.from("redemption_stations").insert({ ...base, ...scope, actor_gaming_member_id: operational })).error?.message).toMatch(/REDEMPTION_STATION_ACTOR/);
    // a member with no authority is the one that works
    const fine = await admin.from("redemption_stations").insert({ ...base, ...scope, actor_gaming_member_id: w.stationActor }).select().single();
    expect(fine.error).toBeNull();
    created.stations.push(fine.data!.station_id);
    expect((await admin.from("redemption_stations").insert({ ...base, slug: "Mal Slug", ...scope, actor_gaming_member_id: w.stationActor })).error).not.toBeNull();
    expect((await admin.from("redemption_stations").insert({ ...base, session_ttl_minutes: 5, ...scope, actor_gaming_member_id: w.stationActor })).error).not.toBeNull();
  });

  it("the PIN columns keep a consistent shape: no PIN means version 0, a PIN means a salt, a hash and a version of at least 1", async () => {
    const w = await world();
    const salt = generateSalt();
    const hash = hashPin(PIN, salt);
    const bad: Array<Record<string, unknown>> = [
      { pin_salt: salt, pin_hash: null, pin_version: 1 },
      { pin_salt: null, pin_hash: hash, pin_version: 1 },
      { pin_salt: null, pin_hash: null, pin_version: 1 },
      { pin_salt: salt, pin_hash: hash, pin_version: 0 },
      { pin_salt: "zz", pin_hash: hash, pin_version: 1 },
      { pin_salt: salt, pin_hash: "short", pin_version: 1 },
    ];
    for (const patch of bad) {
      const res = await admin.from("redemption_stations").insert({ slug: `bad-${randomUUID().slice(0, 8)}`, label: "x", venue_activation_id: w.world.activationId, match_id: w.world.matchId, actor_gaming_member_id: w.stationActor, expires_at: new Date(Date.now() + 3600_000).toISOString(), ...patch });
      expect(res.error, JSON.stringify(patch)).not.toBeNull();
    }
    const noPin = await newStation(w, { pin_salt: null, pin_hash: null, pin_version: 0 });
    expect((await stationRepo.getStationBySlug(noPin.slug))).toMatchObject({ pinSalt: null, pinHash: null, pinVersion: 0 });
  });

  it("a station is its configuration: after creation only its revocation and (through the function) its PIN can change; it is never deleted", async () => {
    const w = await world();
    const s = await newStation(w);
    for (const patch of [{ pin_hash: "a".repeat(64) }, { pin_version: 5 }, { pin_salt: "b".repeat(64) }, { ip_salt: "c".repeat(64) }, { expires_at: new Date(Date.now() + 999 * 3600_000).toISOString() }, { match_id: w.otherWorld.matchId }, { actor_gaming_member_id: w.actor }, { label: "otro" }, { session_ttl_minutes: 700 }]) {
      const res = await admin.from("redemption_stations").update(patch).eq("station_id", s.stationId);
      expect(res.error?.message, JSON.stringify(patch)).toMatch(/REDEMPTION_STATION_IMMUTABLE/);
    }
    // even with the permission to change the PIN on, the version moves one step at a time
    await withDb(async (c) => {
      await c.query("begin");
      await c.query("select set_config('redemption_station.pin_change', 'on', true)");
      await expect(c.query("update redemption_stations set pin_version = pin_version + 2, pin_salt = $2, pin_hash = $3 where station_id = $1", [s.stationId, "d".repeat(64), "e".repeat(128)])).rejects.toThrow(/one step at a time/);
      await c.query("rollback");
    });
    // a perfectly well-formed PIN change written straight into the table (new salt, new hash, the next version) is refused too
    const wellFormed = await admin.from("redemption_stations").update({ pin_salt: "d".repeat(64), pin_hash: "e".repeat(128), pin_version: 2 }).eq("station_id", s.stationId);
    expect(wellFormed.error?.message).toMatch(/the PIN changes only through redemption_station_set_pin/);
    expect((await stationRepo.getStationBySlug(s.slug))!.pinVersion).toBe(1);
    expect((await admin.from("redemption_stations").update({ revoked_at: new Date().toISOString() }).eq("station_id", s.stationId)).error).toBeNull();
    expect((await admin.from("redemption_stations").update({ revoked_at: null }).eq("station_id", s.stationId)).error?.message).toMatch(/REDEMPTION_STATION_IMMUTABLE/);
    expect((await admin.from("redemption_stations").delete().eq("station_id", s.stationId)).error?.message).toMatch(/REDEMPTION_STATION_IMMUTABLE/);
    expect((await stationRepo.getStationBySlug(s.slug))!.pinVersion).toBe(1);
  });

  it("the attempt limit holds under real concurrency: 20 parallel wrong attempts from one client — only 5 are allowed through", async () => {
    const w = await world();
    const s = await newStation(w);
    const results = await Promise.all(Array.from({ length: 20 }, () => stationRepo.beginAttempt(s.stationId, "ip-hash-one", { perClient: 5, perStation: 30, windowSeconds: 900 })));
    expect(results.filter((r) => r.allowed)).toHaveLength(5);
    const refused = results.filter((r) => !r.allowed);
    expect(refused).toHaveLength(15);
    for (const r of refused) { expect(r.retryAfterSeconds).toBeGreaterThan(0); expect(r.retryAfterSeconds).toBeLessThanOrEqual(900); expect(r.attemptId).toBeNull(); }
    expect((await stationRepo.beginAttempt(s.stationId, "ip-hash-two", { perClient: 5, perStation: 30, windowSeconds: 900 })).allowed).toBe(true);
    const wide = await newStation(w);
    const many = await Promise.all(Array.from({ length: 40 }, (_, i) => stationRepo.beginAttempt(wide.stationId, `client-${i}`, { perClient: 5, perStation: 30, windowSeconds: 900 })));
    expect(many.filter((r) => r.allowed)).toHaveLength(30);
  });

  it("a successful attempt does not count against the limit", async () => {
    const w = await world();
    const s = await newStation(w);
    for (let i = 0; i < 8; i++) {
      const d = await stationRepo.beginAttempt(s.stationId, "ip-ok", { perClient: 5, perStation: 30, windowSeconds: 900 });
      expect(d.allowed).toBe(true);
      await stationRepo.markAttemptSucceeded(d.attemptId!);
    }
  });

  it("attempts older than 24 hours are deleted when the next attempt is recorded, only for that station; revoking the station deletes the rest", async () => {
    const w = await world();
    const s = await newStation(w);
    const other = await newStation(w);
    await withDb(async (c) => {
      for (const id of [s.stationId, other.stationId]) await c.query("insert into redemption_station_attempts (station_id, ip_hash, attempted_at) values ($1, 'old-hash', now() - interval '25 hours'), ($1, 'recent-hash', now() - interval '23 hours')", [id]);
    });
    await stationRepo.beginAttempt(s.stationId, "new-hash", { perClient: 5, perStation: 30, windowSeconds: 900 });
    const rows = (id: string) => withDb((c) => c.query("select ip_hash from redemption_station_attempts where station_id = $1 order by ip_hash", [id])).then((r) => r.rows.map((x) => x.ip_hash));
    expect(await rows(s.stationId)).toEqual(["new-hash", "recent-hash"]);
    expect(await rows(other.stationId)).toEqual(["old-hash", "recent-hash"]); // another station is not touched by this one
    await stationRepo.revokeStation(s.stationId);
    expect(await rows(s.stationId)).toEqual([]);
    expect(await rows(other.stationId)).toEqual(["old-hash", "recent-hash"]);
  });

  it("is reachable only with the service key: nothing public or member-side can read or call any of it", async () => {
    const w = await world();
    const s = await newStation(w);
    const anon = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    for (const table of ["redemption_stations", "redemption_station_sessions", "redemption_station_attempts", "redemption_station_events", "redemption_station_pin_changes"]) {
      expect((await anon.from(table).select("*")).error, table).not.toBeNull();
      expect((await anon.from(table).insert({})).error, table).not.toBeNull();
    }
    const member = (await realMember("Miembro con sesión", true)) as { id: string; token: string };
    const asMember = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${member.token}` } } });
    expect((await asMember.from("redemption_stations").select("*")).error).not.toBeNull();
    const calls: Array<[string, Record<string, unknown>]> = [
      ["redemption_station_attempt_begin", { p_station_id: s.stationId, p_ip_hash: "x", p_ip_limit: 5, p_station_limit: 30, p_window_seconds: 900 }],
      ["redemption_station_revoke", { p_station_id: s.stationId }],
      ["redemption_station_attempt_succeed", { p_attempt_id: 1 }],
      ["redemption_station_set_pin", { p_station_id: s.stationId, p_pin_salt: "a".repeat(64), p_pin_hash: "b".repeat(128), p_changed_by_gaming_member_id: member.id }],
      ["redemption_station_redeem", { p_session_token_sha256: "a".repeat(64), p_prize_qualification_id: w.prizes.bruno, p_declared_operator: "Josué D" }],
    ];
    const deniedByPrivilege = (error: { code?: string; message?: string } | null) => error !== null && (error.code === "42501" || /permission denied/i.test(error.message ?? ""));
    for (const [name, args] of calls) {
      expect(deniedByPrivilege((await anon.rpc(name, args)).error), "anon " + name).toBe(true);
      expect(deniedByPrivilege((await asMember.rpc(name, args)).error), "member " + name).toBe(true);
    }
    expect((await stationRepo.getStationBySlug(s.slug))).toMatchObject({ pinVersion: 1, revokedAt: null });
  });
});

describe("the PIN: changing it ends every earlier session, with no deployment", () => {
  it("setPin moves the version, revokes every session of that station only, logs who changed it and never keeps the PIN", async () => {
    const w = await world();
    const s = await newStation(w);
    const other = await newStation(w);
    const a = await directSession(s.stationId);
    const b = await directSession(s.stationId);
    const alien = await directSession(other.stationId);
    const changer = (await realMember("Quien cambia el PIN")) as string;
    const salt = generateSalt();
    const result = await stationRepo.setPin({ stationId: s.stationId, pinSalt: salt, pinHash: hashPin(NEW_PIN, salt), changedByGamingMemberId: changer });
    expect(result).toEqual({ pinVersion: 2, sessionsRevoked: 2 });
    const st = (await stationRepo.getStationBySlug(s.slug))!;
    expect(st.pinVersion).toBe(2);
    expect(st.pinSalt).toBe(salt);
    const revoked = await admin.from("redemption_station_sessions").select("session_id, revoked_at").in("session_id", [a.sessionId, b.sessionId, alien.sessionId]);
    const byId = new Map((revoked.data ?? []).map((r) => [r.session_id, r.revoked_at]));
    expect(byId.get(a.sessionId)).not.toBeNull();
    expect(byId.get(b.sessionId)).not.toBeNull();
    expect(byId.get(alien.sessionId)).toBeNull(); // another station is untouched
    const log = await stationRepo.listPinChanges(s.stationId);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ changedByGamingMemberId: changer, newPinVersion: 2, sessionsRevoked: 2 });
    // the PIN is nowhere in any station table
    const everything = await withDb(async (c) => {
      const tables = ["redemption_stations", "redemption_station_sessions", "redemption_station_attempts", "redemption_station_events", "redemption_station_pin_changes"];
      const out: string[] = [];
      for (const t of tables) out.push(JSON.stringify((await c.query(`select * from ${t} where ${t === "redemption_stations" ? "station_id" : "station_id"} = $1`, [s.stationId])).rows));
      return out.join("\n");
    });
    expect(everything).not.toContain(NEW_PIN);
    expect(everything).not.toContain(PIN);
    // the old sessions cannot deliver any more
    for (const old of [a, b]) expect((await redeemRaw(old.tokenSha256, w.prizes.bruno)).error?.message).toMatch(/REDEMPTION_STATION_SESSION_INVALID/);
  });

  it("a session that was opened under the old PIN but written after the change is dead on arrival (the version, not the revocation, kills it)", async () => {
    const w = await world();
    const s = await newStation(w);
    const changer = (await realMember("Quien cambia")) as string;
    const salt = generateSalt();
    await stationRepo.setPin({ stationId: s.stationId, pinSalt: salt, pinHash: hashPin(NEW_PIN, salt), changedByGamingMemberId: changer });
    const late = await directSession(s.stationId, { pinVersion: 1 }); // what a login that finished late would write
    expect((await admin.from("redemption_station_sessions").select("revoked_at").eq("session_id", late.sessionId).single()).data!.revoked_at).toBeNull();
    expect((await redeemRaw(late.tokenSha256, w.prizes.bruno)).error?.message).toMatch(/REDEMPTION_STATION_SESSION_INVALID/);
    const current = await directSession(s.stationId, { pinVersion: 2 });
    expect((await redeemRaw(current.tokenSha256, "00000000-0000-0000-0000-000000000000")).error?.message).toMatch(/REDEMPTION_STATION_SCOPE/); // it passes the session check and stops at the scope
  });

  it("ten PIN changes at the same moment end in ten orderly versions, ten log rows and no live session", async () => {
    const w = await world();
    const s = await newStation(w);
    const sessions = await Promise.all([directSession(s.stationId), directSession(s.stationId), directSession(s.stationId)]);
    const changer = (await realMember("Cambios en paralelo")) as string;
    const results = await Promise.all(Array.from({ length: 10 }, () => {
      const salt = generateSalt();
      return stationRepo.setPin({ stationId: s.stationId, pinSalt: salt, pinHash: hashPin(NEW_PIN, salt), changedByGamingMemberId: changer });
    }));
    expect(results.map((r) => r.pinVersion).sort((x, y) => x - y)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(results.reduce((sum, r) => sum + r.sessionsRevoked, 0)).toBe(3);
    expect((await stationRepo.getStationBySlug(s.slug))!.pinVersion).toBe(11);
    expect((await stationRepo.listPinChanges(s.stationId)).map((c) => c.newPinVersion)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    for (const session of sessions) expect((await redeemRaw(session.tokenSha256, w.prizes.bruno)).error?.message).toMatch(/SESSION_INVALID/);
  });

  it("a closed station (revoked or past its end) keeps its PIN as it was; an unknown station is refused; the change log is never edited", async () => {
    const w = await world();
    const changer = (await realMember("Cambia el PIN")) as string;
    const salt = generateSalt();
    const input = (stationId: string) => ({ stationId, pinSalt: salt, pinHash: hashPin(NEW_PIN, salt), changedByGamingMemberId: changer });
    const revoked = await newStation(w);
    await stationRepo.revokeStation(revoked.stationId);
    await expect(stationRepo.setPin(input(revoked.stationId))).rejects.toBeInstanceOf(StationClosedError);
    const past = await newStation(w, { expires_at: new Date(Date.now() - 1000).toISOString() });
    await expect(stationRepo.setPin(input(past.stationId))).rejects.toBeInstanceOf(StationClosedError);
    await expect(stationRepo.setPin(input(randomUUID()))).rejects.toThrow();
    expect((await stationRepo.getStationBySlug(revoked.slug))!.pinVersion).toBe(1);
    expect((await stationRepo.getStationBySlug(past.slug))!.pinVersion).toBe(1);
    const open = await newStation(w);
    await stationRepo.setPin(input(open.stationId));
    const entry = (await stationRepo.listPinChanges(open.stationId))[0]!;
    expect((await admin.from("redemption_station_pin_changes").update({ sessions_revoked: 99 }).eq("change_id", entry.changeId)).error?.message).toMatch(/REDEMPTION_STATION_EVENT_IMMUTABLE/);
    expect((await admin.from("redemption_station_pin_changes").delete().eq("change_id", entry.changeId)).error?.message).toMatch(/REDEMPTION_STATION_EVENT_IMMUTABLE/);
  });

  it("through the routes: only OPERATIONAL authority sets the PIN; the station's own identity and a plain member are refused; the old cookie dies and the new PIN works", async () => {
    const w = await buildWorld();
    const s = await newStation(w);
    const cookie = await openSession(s.slug, "10.9.0.1");
    expect((await prizesGET(getReq(URL_OF(s.slug) + "/prizes", { cookie }), p(s.slug))).status).toBe(200);
    const body = { pin: NEW_PIN, confirmPin: NEW_PIN };
    const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

    expect((await pinPOST(postReq(URL_OF(s.slug) + "/pin", body), p(s.slug))).status).toBe(401); // nobody
    const plain = (await realMember("Miembro común", true)) as { id: string; token: string };
    expect((await pinPOST(postReq(URL_OF(s.slug) + "/pin", body, bearer(plain.token)), p(s.slug))).status).toBe(403);
    expect((await pinGET(getReq(URL_OF(s.slug) + "/pin", bearer(plain.token)), p(s.slug))).status).toBe(403);
    // a person with ANOTHER authority class (the finalizer) cannot set the PIN either: it is OPERATIONAL only
    const finalizer = (await realMember("Finalizador con sesión", true)) as { id: string; token: string };
    await grant(finalizer.id, "CONSEQUENTIAL_FINALIZER");
    expect((await pinPOST(postReq(URL_OF(s.slug) + "/pin", body, bearer(finalizer.token)), p(s.slug))).status).toBe(403);
    expect((await revokePOST(postReq(URL_OF(s.slug) + "/revoke", {}, bearer(plain.token)), p(s.slug))).status).toBe(403);
    expect((await prizesGET(getReq(URL_OF(s.slug) + "/prizes", { cookie }), p(s.slug))).status).toBe(200); // nothing changed
    expect((await stationRepo.getStationBySlug(s.slug))!.pinVersion).toBe(1);

    const operator = (await realMember("Operador", true)) as { id: string; token: string };
    await grant(operator.id, "OPERATIONAL");
    const state = await pinGET(getReq(URL_OF(s.slug) + "/pin", bearer(operator.token)), p(s.slug));
    expect(state.status).toBe(200);
    expect(await state.json()).toMatchObject({ pinSet: true, pinVersion: 1, activeSessions: 1 });
    const done = await pinPOST(postReq(URL_OF(s.slug) + "/pin", body, bearer(operator.token)), p(s.slug));
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ ok: true, pinVersion: 2, sessionsRevoked: 1 });
    expect((await prizesGET(getReq(URL_OF(s.slug) + "/prizes", { cookie }), p(s.slug))).status).toBe(401);
    expect((await sessionPOST(postReq(URL_OF(s.slug) + "/session", { pin: PIN }, { "x-forwarded-for": "10.9.0.2" }), p(s.slug))).status).toBe(401);
    const fresh = await openSession(s.slug, "10.9.0.3", NEW_PIN);
    expect((await prizesGET(getReq(URL_OF(s.slug) + "/prizes", { cookie: fresh }), p(s.slug))).status).toBe(200);
    expect((await stationRepo.listPinChanges(s.stationId))[0]).toMatchObject({ changedByGamingMemberId: operator.id, newPinVersion: 2 });
  });

  it("a station created without a PIN lets nobody in until the PIN is set, and then only the PIN that was set", async () => {
    const w = await world();
    const s = await newStation(w, { pin_salt: null, pin_hash: null, pin_version: 0 });
    const res = await sessionPOST(postReq(URL_OF(s.slug) + "/session", { pin: PIN }, { "x-forwarded-for": "10.9.1.1" }), p(s.slug));
    expect(res.status).toBe(409);
    expect(res.headers.get("set-cookie")).toBeNull();
    expect(await withDb((c) => c.query("select count(*)::int as n from redemption_station_attempts where station_id = $1", [s.stationId])).then((r) => r.rows[0].n)).toBe(0);
    const changer = (await realMember("Pone el PIN")) as string;
    const salt = generateSalt();
    await stationRepo.setPin({ stationId: s.stationId, pinSalt: salt, pinHash: hashPin(NEW_PIN, salt), changedByGamingMemberId: changer });
    expect((await sessionPOST(postReq(URL_OF(s.slug) + "/session", { pin: PIN }, { "x-forwarded-for": "10.9.1.2" }), p(s.slug))).status).toBe(401);
    expect((await sessionPOST(postReq(URL_OF(s.slug) + "/session", { pin: NEW_PIN }, { "x-forwarded-for": "10.9.1.3" }), p(s.slug))).status).toBe(200);
  });
});

describe("the delivery function, called DIRECTLY: the data layer decides, whatever the caller sends", () => {
  it("refuses a session that is unknown, revoked, expired or of an old PIN version, and a station that is closed", async () => {
    const w = await world();
    const s = await newStation(w);
    const ok = await directSession(s.stationId);
    const expired = await directSession(s.stationId, { expiresInMs: -1000 });
    const revoked = await directSession(s.stationId);
    await stationRepo.revokeSession(revoked.sessionId);
    const stale = await directSession(s.stationId, { pinVersion: 7 });
    for (const bad of [sha256("never-issued"), expired.tokenSha256, revoked.tokenSha256, stale.tokenSha256, "", "x"]) {
      expect((await redeemRaw(bad, w.prizes.bruno)).error?.message, bad).toMatch(/REDEMPTION_STATION_SESSION_INVALID/);
    }
    const past = await newStation(w, { expires_at: new Date(Date.now() - 1000).toISOString() });
    const inPast = await directSession(past.stationId, { expiresInMs: 3600_000 });
    expect((await redeemRaw(inPast.tokenSha256, w.prizes.bruno)).error?.message).toMatch(/REDEMPTION_STATION_CLOSED/);
    const closed = await newStation(w);
    const closedSession = await directSession(closed.stationId);
    await withDb((c) => c.query("update redemption_stations set revoked_at = now() where station_id = $1", [closed.stationId])); // revoked without the function: the session is still "good", the station is not
    expect((await redeemRaw(closedSession.tokenSha256, w.prizes.bruno)).error?.message).toMatch(/REDEMPTION_STATION_CLOSED/);
    expect(ok.tokenSha256).toBeTruthy();
    expect((await repo.listQualificationDetailsForActivation(w.world.activationId)).every((d) => d.redeemedAt === null)).toBe(true);
  });

  it("is limited to the station's activation and match: a prize of ANOTHER match, an unknown one, or one named by another station's session is refused and nothing changes", async () => {
    const w = await buildWorld(); // its own match: the other match's station delivers its own prize here
    const s = await newStation(w);
    const session = await directSession(s.stationId);
    const before = await withDb((c) => c.query("select count(*)::int as n from admin_audit_events where action_type = 'CONFIRM_PRIZE_REDEMPTION'")).then((r) => r.rows[0].n);
    for (const prize of [w.otherPrize, randomUUID(), "00000000-0000-0000-0000-000000000000"]) {
      expect((await redeemRaw(session.tokenSha256, prize)).error?.message, prize).toMatch(/REDEMPTION_STATION_SCOPE/);
    }
    // a station of the OTHER match cannot deliver this match's prizes, and the other way round
    const otherStation = await newStation(w, { venue_activation_id: w.otherWorld.activationId, match_id: w.otherWorld.matchId });
    const otherSession = await directSession(otherStation.stationId);
    expect((await redeemRaw(otherSession.tokenSha256, w.prizes.bruno)).error?.message).toMatch(/REDEMPTION_STATION_SCOPE/);
    expect((await redeemRaw(otherSession.tokenSha256, w.otherPrize)).data?.[0]?.outcome).toBe("REDEEMED"); // its own prize is its to deliver (tested here once, on the other match)
    const after = await withDb((c) => c.query("select count(*)::int as n from admin_audit_events where action_type = 'CONFIRM_PRIZE_REDEMPTION'")).then((r) => r.rows[0].n);
    expect(after - before).toBe(1);
    expect((await repo.listQualificationDetailsForActivation(w.world.activationId)).every((d) => d.redeemedAt === null)).toBe(true);
    expect(await stationRepo.listEvents(s.stationId)).toHaveLength(0);
  });

  it("through the repository the same refusals become the station's own errors (not found, unauthorized, closed, misconfigured, invalid)", async () => {
    const w = await buildWorld();
    const s = await newStation(w);
    const session = await directSession(s.stationId);
    const call = (token: string, prize: string, name = "Josué D") => stationRepo.redeemInScope({ sessionTokenSha256: token, prizeQualificationId: prize, declaredOperator: name });
    await expect(call(session.tokenSha256, w.otherPrize)).rejects.toBeInstanceOf(PrizeCodeNotFoundError);
    await expect(call(sha256("nope"), w.prizes.bruno)).rejects.toBeInstanceOf(StationUnauthorizedError);
    await expect(call(session.tokenSha256, w.prizes.bruno, "a\u0007b")).rejects.toBeInstanceOf(InvalidStationRequestError);
    await grant(w.stationActor); // the identity must never hold authority: the station refuses to run
    await expect(call(session.tokenSha256, w.prizes.bruno)).rejects.toBeInstanceOf(StationMisconfiguredError);
    await admin.from("authority_grants").update({ revoked_at: new Date().toISOString() }).eq("gaming_member_id", w.stationActor);
    await expect(call(session.tokenSha256, w.prizes.bruno)).resolves.toMatchObject({ outcome: "REDEEMED" });
  });

  it("the declared name is checked again in the data layer (2 to 40 characters, no control characters) and no event is written for a refused call", async () => {
    const w = await buildWorld();
    const s = await newStation(w);
    const session = await directSession(s.stationId);
    for (const name of ["", " ", "J", "x".repeat(41), "a\u0000b".replace("\u0000", "\u0001"), "a\nb"]) {
      expect((await redeemRaw(session.tokenSha256, w.prizes.bruno, name)).error?.message, JSON.stringify(name)).toMatch(/REDEMPTION_STATION_OPERATOR/);
    }
    expect(await stationRepo.listEvents(s.stationId)).toHaveLength(0);
    expect((await repo.listQualificationDetailsForActivation(w.world.activationId)).every((d) => d.redeemedAt === null)).toBe(true);
  });

  it("delivers under the STATION's identity: redeemed_by is the station, the audit event has no authority class and no personal name, and the name is kept apart, once", async () => {
    const w = await buildWorld();
    const s = await newStation(w);
    const session = await directSession(s.stationId);
    const res = await redeemRaw(session.tokenSha256, w.prizes.bruno, "Josué DiBrasco");
    expect(res.error).toBeNull();
    const row = res.data![0];
    expect(row).toMatchObject({ outcome: "REDEEMED", refusal: null });
    const pq = await withDb((c) => c.query("select redeemed_at, redeemed_by_gaming_member_id, redeemed_prize_label, redeemed_prize_label_basis, legacy_observed_prize_label from prize_qualifications where prize_qualification_id = $1", [w.prizes.bruno])).then((r) => r.rows[0]);
    expect(pq.redeemed_by_gaming_member_id).toBe(w.stationActor);
    expect(pq.redeemed_by_gaming_member_id).not.toBe(w.actor);
    expect(pq.redeemed_prize_label).toBe("Prize L3");
    expect(pq.redeemed_prize_label_basis).toBe("SNAPSHOT_AT_REDEMPTION");
    expect(pq.legacy_observed_prize_label).toBeNull();
    expect(new Date(pq.redeemed_at).toISOString()).toBe(new Date(row.redeemed_at).toISOString());
    const audit = await withDb((c) => c.query("select actor_kind, actor_id, authority_class_used, outcome, reason, resulting_reference from admin_audit_events where target_id = $1 and action_type = 'CONFIRM_PRIZE_REDEMPTION'", [w.prizes.bruno]));
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0]).toMatchObject({ actor_kind: "GAMING_MEMBER", actor_id: w.stationActor, authority_class_used: null, outcome: "SUCCESS" });
    expect(audit.rows[0].resulting_reference).toEqual({ table: "prize_qualifications", id: w.prizes.bruno });
    expect(audit.rows[0].reason).toContain("PIN compartido");
    expect(audit.rows[0].reason).toContain("no acredita individualmente quién operó");
    expect(audit.rows[0].reason).toContain(row.event_id);
    expect(audit.rows[0].reason).not.toContain("Josué");
    const log = await stationRepo.listEvents(s.stationId);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ eventId: row.event_id, outcome: "REDEEMED", declaredOperator: "Josué DiBrasco", prizeQualificationId: w.prizes.bruno, sessionId: session.sessionId });
  });

  it("applies the SAME rules as the existing redemption: a repeat returns the same delivery with no second audit event, in both orders", async () => {
    const w = await buildWorld();
    const s = await newStation(w);
    const session = await directSession(s.stationId);
    // station first, then the existing function
    const viaStation = (await redeemRaw(session.tokenSha256, w.prizes.ana1, "Primera Persona")).data![0];
    const again = (await redeemRaw(session.tokenSha256, w.prizes.ana1, "Segunda Persona")).data![0];
    expect(again).toMatchObject({ outcome: "ALREADY_REDEEMED", refusal: null });
    expect(new Date(again.redeemed_at).toISOString()).toBe(new Date(viaStation.redeemed_at).toISOString());
    const existing = await admin.rpc("redeem_prize_qualification_atomically", { p_prize_qualification_id: w.prizes.ana1, p_redeemed_by_gaming_member_id: w.actor, p_reason: "equivalencia" });
    expect(existing.data![0]).toMatchObject({ already_redeemed: true });
    expect(new Date(existing.data![0].redeemed_at).toISOString()).toBe(new Date(viaStation.redeemed_at).toISOString());
    // the existing function first, then the station
    const direct = await admin.rpc("redeem_prize_qualification_atomically", { p_prize_qualification_id: w.prizes.ana2, p_redeemed_by_gaming_member_id: w.actor, p_reason: "equivalencia" });
    expect(direct.data![0]).toMatchObject({ already_redeemed: false });
    const afterDirect = (await redeemRaw(session.tokenSha256, w.prizes.ana2, "Tercera Persona")).data![0];
    expect(afterDirect).toMatchObject({ outcome: "ALREADY_REDEEMED" });
    expect(new Date(afterDirect.redeemed_at).toISOString()).toBe(new Date(direct.data![0].redeemed_at).toISOString());
    for (const prize of [w.prizes.ana1, w.prizes.ana2]) {
      expect((await withDb((c) => c.query("select count(*)::int as n from admin_audit_events where target_id = $1 and action_type = 'CONFIRM_PRIZE_REDEMPTION'", [prize]))).rows[0].n).toBe(1);
    }
    // the same evidence by either way: a snapshot of the prize label at that moment
    const evidence = await withDb((c) => c.query("select prize_qualification_id, redeemed_prize_label, redeemed_prize_label_basis, legacy_observed_prize_label, redeemed_by_gaming_member_id from prize_qualifications where prize_qualification_id = any($1::uuid[])", [[w.prizes.ana1, w.prizes.ana2]]));
    const by = Object.fromEntries(evidence.rows.map((r) => [r.prize_qualification_id, r]));
    expect(by[w.prizes.ana1]).toMatchObject({ redeemed_prize_label: "Prize L1", redeemed_prize_label_basis: "SNAPSHOT_AT_REDEMPTION", legacy_observed_prize_label: null, redeemed_by_gaming_member_id: w.stationActor });
    expect(by[w.prizes.ana2]).toMatchObject({ redeemed_prize_label: "Prize L1", redeemed_prize_label_basis: "SNAPSHOT_AT_REDEMPTION", legacy_observed_prize_label: null, redeemed_by_gaming_member_id: w.actor });
    // the station's log has the names only where this station delivered
    expect((await stationRepo.listEvents(s.stationId)).map((e) => [e.outcome, e.declaredOperator])).toEqual([["REDEEMED", "Primera Persona"], ["ALREADY_REDEEMED", null], ["ALREADY_REDEEMED", null]]);
  });

  it("refuses what the existing redemption refuses, in the same order of precedence, and logs the refusal without a name", async () => {
    const w = await buildWorld(6);
    const s = await newStation(w);
    const session = await directSession(s.stationId);
    const [superseded, fulfilled, held, supersededAndHeld, supersededAndFulfilled, released] = w.extra;
    const later = w.prizes.bruno; // the "fulfilled by" target: any other prize
    await forcePrizeState(superseded!, "superseded_at = now()");
    await forcePrizeState(fulfilled!, "fulfilled_by_prize_qualification_id = $1", [later]);
    await forcePrizeState(held!, "held_at = now(), hold_basis = 'DELIVERY_ORDER_UNKNOWN', hold_reason = 'prueba'");
    await forcePrizeState(supersededAndHeld!, "superseded_at = now(), held_at = now(), hold_basis = 'DELIVERY_ORDER_UNKNOWN', hold_reason = 'prueba'");
    await forcePrizeState(supersededAndFulfilled!, "superseded_at = now(), fulfilled_by_prize_qualification_id = $1", [later]);
    const cases: Array<[string, string, string]> = [
      [superseded!, "SUPERSEDED", "QUALIFICATION_SUPERSEDED"],
      [fulfilled!, "FULFILLED", "PRIZE_ALREADY_FULFILLED"],
      [held!, "HELD", "PRIZE_QUALIFICATION_HELD"],
      [supersededAndHeld!, "SUPERSEDED", "QUALIFICATION_SUPERSEDED"],
      [supersededAndFulfilled!, "SUPERSEDED", "QUALIFICATION_SUPERSEDED"],
    ];
    for (const [prize, refusal, existingCode] of cases) {
      const station = await redeemRaw(session.tokenSha256, prize, "Josué D");
      expect(station.error, prize).toBeNull();
      expect(station.data![0], prize).toMatchObject({ outcome: "REFUSED", refusal, redeemed_at: null });
      const existing = await admin.rpc("redeem_prize_qualification_atomically", { p_prize_qualification_id: prize, p_redeemed_by_gaming_member_id: w.actor, p_reason: "equivalencia" });
      expect(existing.error?.message, prize).toMatch(new RegExp("^" + existingCode));
    }
    expect((await withDb((c) => c.query("select count(*)::int as n from prize_qualifications where prize_qualification_id = any($1::uuid[]) and redeemed_at is not null", [cases.map((c) => c[0])]))).rows[0].n).toBe(0);
    expect((await withDb((c) => c.query("select count(*)::int as n from admin_audit_events where target_id = any($1::uuid[]) and action_type = 'CONFIRM_PRIZE_REDEMPTION'", [cases.map((c) => c[0])]))).rows[0].n).toBe(0);
    const refusals = (await stationRepo.listEvents(s.stationId)).filter((e) => e.outcome === "REFUSED");
    expect(refusals).toHaveLength(5);
    expect(refusals.every((e) => e.declaredOperator === null)).toBe(true);
    // a hold that a finalizer released is deliverable again, by either way
    await forcePrizeState(released!, "held_at = now(), hold_basis = 'DELIVERY_ORDER_UNKNOWN', hold_reason = 'prueba', released_at = now(), released_by_gaming_member_id = $1, release_reason = 'liberado'", [w.actor]);
    expect((await redeemRaw(session.tokenSha256, released!, "Josué D")).data![0]).toMatchObject({ outcome: "REDEEMED" });
  });

  it("ten parallel deliveries of one prize end in ONE delivery, ONE audit event and ONE named record", async () => {
    const w = await buildWorld();
    const s = await newStation(w);
    const sessions = [await directSession(s.stationId), await directSession(s.stationId), await directSession(s.stationId)];
    const replies = await Promise.all(Array.from({ length: 10 }, (_, i) => redeemRaw(sessions[i % 3]!.tokenSha256, w.prizes.bruno, `Encargado ${i}`)));
    expect(replies.every((r) => r.error === null)).toBe(true);
    const outcomes = replies.map((r) => r.data![0].outcome);
    expect(outcomes.filter((o) => o === "REDEEMED")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "ALREADY_REDEEMED")).toHaveLength(9);
    expect(new Set(replies.map((r) => new Date(r.data![0].redeemed_at).toISOString())).size).toBe(1);
    expect((await withDb((c) => c.query("select count(*)::int as n from admin_audit_events where target_id = $1 and action_type = 'CONFIRM_PRIZE_REDEMPTION'", [w.prizes.bruno]))).rows[0].n).toBe(1);
    const log = await stationRepo.listEvents(s.stationId);
    expect(log).toHaveLength(10);
    expect(log.filter((e) => e.declaredOperator !== null)).toHaveLength(1);
  });

  it("a PIN change racing a delivery: whichever is first, a delivery after the change is refused and one before it stands", async () => {
    const w = await buildWorld(3);
    const s = await newStation(w);
    const sessions = await Promise.all(w.extra.map(() => directSession(s.stationId)));
    const changer = (await realMember("Cambia mientras se entrega")) as string;
    const salt = generateSalt();
    const [change, ...deliveries] = await Promise.allSettled([
      stationRepo.setPin({ stationId: s.stationId, pinSalt: salt, pinHash: hashPin(NEW_PIN, salt), changedByGamingMemberId: changer }),
      ...w.extra.map((prize, i) => redeemRaw(sessions[i]!.tokenSha256, prize, "Josué D")),
    ]);
    expect(change!.status).toBe("fulfilled");
    const delivered = deliveries.filter((d) => d.status === "fulfilled" && (d.value as { error: unknown }).error === null);
    const refused = deliveries.filter((d) => d.status === "fulfilled" && (d.value as { error: { message: string } | null }).error?.message?.match(/SESSION_INVALID/));
    expect(delivered.length + refused.length).toBe(3);
    // every delivery that stands is recorded with its name; nothing delivered without its record
    const redeemed = (await withDb((c) => c.query("select count(*)::int as n from prize_qualifications where prize_qualification_id = any($1::uuid[]) and redeemed_at is not null", [w.extra]))).rows[0].n;
    expect(redeemed).toBe(delivered.length);
    expect((await stationRepo.listEvents(s.stationId)).filter((e) => e.outcome === "REDEEMED")).toHaveLength(delivered.length);
    // and afterwards every old session is dead
    for (const session of sessions) expect((await redeemRaw(session.tokenSha256, w.prizes.bruno)).error?.message).toMatch(/SESSION_INVALID/);
  });

  it("a delivery waits for a revocation that is in progress and then finds the station closed (the station row is locked while it delivers)", async () => {
    const w = await buildWorld();
    const s = await newStation(w);
    const session = await directSession(s.stationId);
    const holder = new Client({ connectionString: databaseUrl, statement_timeout: 30000 });
    await holder.connect();
    try {
      await holder.query("begin");
      await holder.query("update redemption_stations set revoked_at = clock_timestamp() where station_id = $1", [s.stationId]); // not committed yet
      let settled = false;
      const pending = redeemRaw(session.tokenSha256, w.prizes.bruno, "Josué D").then((r) => { settled = true; return r; });
      await new Promise((resolve) => setTimeout(resolve, 1500));
      expect(settled).toBe(false); // it is held back by the lock, not answered from the old state
      await holder.query("commit");
      const result = await pending;
      expect(result.error?.message).toMatch(/REDEMPTION_STATION_CLOSED/);
    } finally {
      await holder.end();
    }
    expect((await repo.listQualificationDetailsForActivation(w.world.activationId)).every((d) => d.redeemedAt === null)).toBe(true);
    expect(await stationRepo.listEvents(s.stationId)).toHaveLength(0);
  });

  it("the station's events keep their shape: a name only for a delivery, never edited or deleted", async () => {
    const w = await buildWorld();
    const s = await newStation(w);
    const session = await directSession(s.stationId);
    const insert = (row: Record<string, unknown>) => admin.from("redemption_station_events").insert({ station_id: s.stationId, session_id: session.sessionId, prize_qualification_id: w.prizes.bruno, ...row });
    expect((await insert({ outcome: "REFUSED", declared_operator: "Josué D" })).error).not.toBeNull();
    expect((await insert({ outcome: "ALREADY_REDEEMED", declared_operator: "Josué D" })).error).not.toBeNull();
    expect((await insert({ outcome: "REDEEMED", declared_operator: null })).error).not.toBeNull();
    expect((await insert({ outcome: "REDEEMED", declared_operator: "J" })).error).not.toBeNull();
    expect((await insert({ outcome: "OTHER" })).error).not.toBeNull();
    const okRow = await insert({ outcome: "REFUSED", detail: "HELD" }).select().single();
    expect(okRow.error).toBeNull();
    expect((await admin.from("redemption_station_events").update({ declared_operator: "otro" }).eq("event_id", okRow.data!.event_id)).error?.message).toMatch(/REDEMPTION_STATION_EVENT_IMMUTABLE/);
    expect((await admin.from("redemption_station_events").delete().eq("event_id", okRow.data!.event_id)).error?.message).toMatch(/REDEMPTION_STATION_EVENT_IMMUTABLE/);
  });
});

describe("the identity of the station has no general authority", () => {
  it("the existing redemption refuses it, the administration routes refuse it, and it holds no grant of any class", async () => {
    const w = await buildWorld();
    const identity = (await realMember("Identidad con sesión (solo prueba)", true)) as { id: string; token: string };
    const s = await newStation(w, { actor_gaming_member_id: identity.id });
    const refused = await admin.rpc("redeem_prize_qualification_atomically", { p_prize_qualification_id: w.prizes.bruno, p_redeemed_by_gaming_member_id: identity.id, p_reason: "intento" });
    expect(refused.error?.message).toMatch(/^CONSEQUENTIAL_FINALIZER_AUTHORITY_REQUIRED/);
    const bearer = { authorization: `Bearer ${identity.token}` };
    expect((await pinGET(getReq(URL_OF(s.slug) + "/pin", bearer), p(s.slug))).status).toBe(403);
    expect((await pinPOST(postReq(URL_OF(s.slug) + "/pin", { pin: NEW_PIN, confirmPin: NEW_PIN }, bearer), p(s.slug))).status).toBe(403);
    expect((await revokePOST(postReq(URL_OF(s.slug) + "/revoke", {}, bearer), p(s.slug))).status).toBe(403);
    expect((await withDb((c) => c.query("select count(*)::int as n from authority_grants where gaming_member_id = $1", [identity.id]))).rows[0].n).toBe(0);
    expect((await repo.listQualificationDetailsForActivation(w.world.activationId)).every((d) => d.redeemedAt === null)).toBe(true);
  });
});

describe("the whole flow, through the routes", () => {
  it("a correct PIN opens a session; the list is ONLY this activation's prizes, as name, code, prize and state", async () => {
    const w = await buildWorld();
    const s = await newStation(w);
    const cookie = await openSession(s.slug, "10.1.0.1");
    const res = await prizesGET(getReq(URL_OF(s.slug) + "/prizes", { cookie }), p(s.slug));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.prizes).toHaveLength(3);
    expect(body.prizes.map((x: { displayName: string }) => x.displayName).sort()).toEqual(["Ana", "Ana", "Bruno"]);
    for (const prize of body.prizes) { expect(Object.keys(prize).sort()).toEqual(["code", "displayName", "prizeLabel", "redeemedAt", "status"]); expect(prize.status).toBe("PENDING"); }
    expect(new Set(body.prizes.map((x: { code: string }) => x.code)).size).toBe(3);
    expect(JSON.stringify(body)).not.toMatch(/Carla|Perdedor|@example|[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect((await sessionPOST(postReq(URL_OF(s.slug) + "/session", { pin: "00000000" }, { "x-forwarded-for": "10.1.0.2" }), p(s.slug))).status).toBe(401);
    expect((await sessionPOST(postReq(URL_OF("no-existe") + "/session", { pin: PIN }), p("no-existe"))).status).toBe(404);
  });

  it("delivering writes the prize's OWN delivery under the station and ONE audit event; a repeat changes nothing; the name is kept apart", async () => {
    const w = await buildWorld();
    const s = await newStation(w);
    const cookie = await openSession(s.slug, "10.2.0.1");
    const list = (await (await prizesGET(getReq(URL_OF(s.slug) + "/prizes", { cookie }), p(s.slug))).json()).prizes;
    const ana = list.filter((x: { displayName: string }) => x.displayName === "Ana")[0];
    const first = await redeemPOST(postReq(URL_OF(s.slug) + "/redeem", { code: ana.code, operatorName: "Josué DiBrasco", confirm: true }, { cookie }), p(s.slug));
    expect(first.status).toBe(200);
    expect(await first.json()).toMatchObject({ outcome: "REDEEMED", prize: { status: "REDEEMED" } });
    const again = await redeemPOST(postReq(URL_OF(s.slug) + "/redeem", { code: ana.code, operatorName: "Otra Persona", confirm: true }, { cookie }), p(s.slug));
    expect(await again.json()).toMatchObject({ outcome: "ALREADY_REDEEMED" });

    const q = (await repo.listQualificationDetailsForActivation(w.world.activationId)).filter((d) => d.redeemedAt !== null);
    expect(q).toHaveLength(1);
    expect(q[0]!.redeemedByGamingMemberId).toBe(w.stationActor);
    expect(q[0]!.redeemedPrizeLabelBasis).toBe("SNAPSHOT_AT_REDEMPTION");
    expect(prizePublicCode(q[0]!.prizeQualificationId)).toBe(ana.code);
    const audit = await withDb((c) => c.query("select reason, actor_id, authority_class_used from admin_audit_events where target_id = $1 and action_type = 'CONFIRM_PRIZE_REDEMPTION'", [q[0]!.prizeQualificationId]));
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].actor_id).toBe(w.stationActor);
    expect(audit.rows[0].authority_class_used).toBeNull();
    expect(audit.rows[0].reason).not.toContain("Josué");
    const log = await stationRepo.listEvents(s.stationId);
    expect(log.map((e) => [e.outcome, e.declaredOperator])).toEqual([["REDEEMED", "Josué DiBrasco"], ["ALREADY_REDEEMED", null]]);
    expect((await repo.listQualificationDetailsForActivation(w.otherWorld.activationId)).every((d) => d.redeemedAt === null)).toBe(true);
    const after = (await (await prizesGET(getReq(URL_OF(s.slug) + "/prizes", { cookie }), p(s.slug))).json()).prizes;
    expect(after.filter((x: { status: string }) => x.status === "REDEEMED")).toHaveLength(1);
  });

  it("ten people confirming the same prize at the same moment, from two sessions, end in ONE delivery and ONE audit event", async () => {
    const w = await buildWorld();
    const s = await newStation(w);
    const cookies = [await openSession(s.slug, "10.3.0.1"), await openSession(s.slug, "10.3.0.2")];
    const list = (await (await prizesGET(getReq(URL_OF(s.slug) + "/prizes", { cookie: cookies[0]! }), p(s.slug))).json()).prizes;
    const bruno = list.find((x: { displayName: string }) => x.displayName === "Bruno");
    const replies = await Promise.all(Array.from({ length: 10 }, (_, i) => redeemPOST(postReq(URL_OF(s.slug) + "/redeem", { code: bruno.code, operatorName: `Encargado ${i}`, confirm: true }, { cookie: cookies[i % 2]! }), p(s.slug))));
    expect(replies.map((r) => r.status)).toEqual(Array(10).fill(200));
    const outcomes = (await Promise.all(replies.map((r) => r.json()))).map((b) => b.outcome);
    expect(outcomes.filter((o) => o === "REDEEMED")).toHaveLength(1);
    expect(outcomes.filter((o) => o === "ALREADY_REDEEMED")).toHaveLength(9);
    const audit = await withDb((c) => c.query("select reason from admin_audit_events where target_id = $1 and action_type = 'CONFIRM_PRIZE_REDEMPTION'", [w.prizes.bruno]));
    expect(audit.rows).toHaveLength(1);
    const log = await stationRepo.listEvents(s.stationId);
    expect(log.length).toBe(10);
    expect(log.filter((e) => e.declaredOperator !== null)).toHaveLength(1);
  });

  it("a code of another match's prize, or an invented one, is refused and nothing is delivered", async () => {
    const w = await world();
    const s = await newStation(w);
    const cookie = await openSession(s.slug, "10.4.0.1");
    for (const code of [prizePublicCode(w.otherPrize), "CL-ZZZZZZ", w.otherPrize]) {
      const res = await redeemPOST(postReq(URL_OF(s.slug) + "/redeem", { code, operatorName: "Josué D", confirm: true }, { cookie }), p(s.slug));
      expect(res.status).toBe(404);
    }
    expect((await repo.listQualificationDetailsForActivation(w.otherWorld.activationId)).every((d) => d.redeemedAt === null)).toBe(true);
  });

  it("revoking the station closes it, every session and the attempts at once; an expired station refuses the PIN", async () => {
    const w = await world();
    const s = await newStation(w);
    const cookie = await openSession(s.slug, "10.5.0.1");
    expect((await prizesGET(getReq(URL_OF(s.slug) + "/prizes", { cookie }), p(s.slug))).status).toBe(200);
    await stationRepo.revokeStation(s.stationId);
    await stationRepo.revokeStation(s.stationId); // idempotent
    expect((await prizesGET(getReq(URL_OF(s.slug) + "/prizes", { cookie }), p(s.slug))).status).toBe(401);
    expect((await sessionPOST(postReq(URL_OF(s.slug) + "/session", { pin: PIN }, { "x-forwarded-for": "10.5.0.2" }), p(s.slug))).status).toBe(410);
    const sessions = await admin.from("redemption_station_sessions").select("revoked_at").eq("station_id", s.stationId);
    expect((sessions.data ?? []).every((row) => row.revoked_at !== null)).toBe(true);
    expect((await withDb((c) => c.query("select count(*)::int as n from redemption_station_attempts where station_id = $1", [s.stationId]))).rows[0].n).toBe(0);
    const past = await newStation(w, { expires_at: new Date(Date.now() - 1000).toISOString() });
    expect((await sessionPOST(postReq(URL_OF(past.slug) + "/session", { pin: PIN }), p(past.slug))).status).toBe(410);
  });

  it("when the identity of the station is later given an authority, it stops delivering (and the error says nothing about the prize)", async () => {
    const w = await buildWorld();
    const s = await newStation(w);
    const cookie = await openSession(s.slug, "10.6.0.1");
    const list = (await (await prizesGET(getReq(URL_OF(s.slug) + "/prizes", { cookie }), p(s.slug))).json()).prizes;
    await grant(w.stationActor, "OPERATIONAL");
    const res = await redeemPOST(postReq(URL_OF(s.slug) + "/redeem", { code: list[0].code, operatorName: "Josué D", confirm: true }, { cookie }), p(s.slug));
    expect(res.status).toBe(503);
    expect(await res.json()).toMatchObject({ code: "STATION_UNAVAILABLE" });
    expect((await repo.listQualificationDetailsForActivation(w.world.activationId)).every((d) => d.redeemedAt === null)).toBe(true);
    vi.restoreAllMocks();
  });
});

describe("the migrations", () => {
  const strip = (sql: string) => sql.replace(/^\s*--.*$/gm, "");
  it("the schema migration adds only the station's own tables, writes the delivery from ONE function and never touches the prize tables otherwise", () => {
    const sql = strip(readFileSync("supabase/migrations/20261028120000_create_redemption_station.sql", "utf8"));
    expect([...sql.matchAll(/create table (\w+)/g)].map((m) => m[1])).toEqual(["redemption_stations", "redemption_station_sessions", "redemption_station_attempts", "redemption_station_events", "redemption_station_pin_changes"]);
    expect(sql).not.toMatch(/alter table prize_qualifications|insert into prize_qualifications|delete from prize_qualifications/i);
    expect([...sql.matchAll(/update prize_qualifications/gi)]).toHaveLength(1);
    const delivery = sql.slice(sql.indexOf("create function redemption_station_redeem"));
    expect(delivery).toContain("update prize_qualifications");
    expect(sql.slice(0, sql.indexOf("create function redemption_station_redeem"))).not.toMatch(/update prize_qualifications/i);
    expect(sql).not.toMatch(/authority_grants\s*\(|insert into authority_grants|redeem_prize_qualification_atomically/i);
    expect(sql).not.toMatch(/pin\s*=\s*'\d|'\d{6,}'/i);
  });

  const dataSql = () => readFileSync("supabase/migrations/20261028121000_create_clasico_the_pub_redemption_station.sql", "utf8");
  /** The data migration with its fixed identifiers replaced, to run it against the invented world of the test. */
  function adapted(slug: string, activation: string, match: string, authUser: string, member: string) {
    return dataSql()
      .replace("'clasico-the-pub-2026-10-25'", `'${slug}'`)
      .replace("'5f9ea3d1-9892-4d72-a1d0-c5c1d458d93a'", `'${activation}'`)
      .replace("'ad72e2e2-dad0-48ef-8e7a-7d8369d37af6'", `'${match}'`)
      .replace("'dc6ef12a-3013-4278-8f5c-db1c75848795'", `'${authUser}'`)
      .replace("'ece459ad-4256-4941-b981-96284bdc7b9b'", `'${member}'`);
  }

  it("the data migration does nothing in a database that does not hold the Clásico activation", async () => {
    const w = await world();
    const slug = `data-absent-${randomUUID().slice(0, 8)}`;
    const authUser = randomUUID();
    await withDb((c) => c.query(adapted(slug, randomUUID(), w.world.matchId, authUser, randomUUID())));
    expect((await withDb((c) => c.query("select count(*)::int as n from redemption_stations where slug = $1", [slug]))).rows[0].n).toBe(0);
    expect((await withDb((c) => c.query("select count(*)::int as n from auth.users where id = $1", [authUser]))).rows[0].n).toBe(0);
  });

  it("the data migration creates the identity (no authority, cannot sign in) and the station (no PIN, scoped, ends at the close of 31 October in Honduras) once, and replays harmlessly", async () => {
    const w = await world();
    const slug = `data-ok-${randomUUID().slice(0, 8)}`;
    const authUser = randomUUID();
    const member = randomUUID();
    const sql = adapted(slug, w.world.activationId, w.world.matchId, authUser, member);
    created.authUsers.push(authUser);
    created.members.push(member);
    await withDb((c) => c.query(sql));
    await withDb((c) => c.query(sql)); // a replay does nothing
    const stationRow = (await withDb((c) => c.query("select * from redemption_stations where slug = $1", [slug]))).rows;
    expect(stationRow).toHaveLength(1);
    created.stations.push(stationRow[0].station_id);
    expect(stationRow[0]).toMatchObject({ venue_activation_id: w.world.activationId, match_id: w.world.matchId, actor_gaming_member_id: member, pin_salt: null, pin_hash: null, pin_version: 0, session_ttl_minutes: 240, revoked_at: null });
    expect(new Date(stationRow[0].expires_at).toISOString()).toBe("2026-11-01T06:00:00.000Z");
    // the identity holds nothing and cannot sign in
    expect((await withDb((c) => c.query("select count(*)::int as n from authority_grants where gaming_member_id = $1", [member]))).rows[0].n).toBe(0);
    const user = (await withDb((c) => c.query("select email, phone, encrypted_password, banned_until, is_anonymous from auth.users where id = $1", [authUser]))).rows[0];
    expect(user).toMatchObject({ email: null, phone: null, encrypted_password: null });
    expect(new Date(user.banned_until).getTime()).toBeGreaterThan(Date.now() + 99 * 365 * 24 * 3600_000);
    expect((await withDb((c) => c.query("select count(*)::int as n from auth.identities where user_id = $1", [authUser]))).rows[0].n).toBe(0);
    expect((await gamingRepo.resolveGamingMemberByAuthUserId(authUser))?.displayName).toBe("Estación de canje · The Pub");
    const fetched = await admin.auth.admin.getUserById(authUser); // the auth service can read the row it did not write
    expect(fetched.error).toBeNull();
    // nobody can open a session on it until a PIN is set
    const res = await sessionPOST(postReq(URL_OF(slug) + "/session", { pin: PIN }, { "x-forwarded-for": "10.8.0.1" }), p(slug));
    expect(res.status).toBe(409);
  });

  it("the data migration never grants an authority and never touches prizes, results or evaluations", () => {
    const sql = strip(dataSql());
    expect(sql).not.toMatch(/insert\s+into\s+authority_grants|prize_qualifications|match_results|evaluations|prize_tiers/i);
    expect([...sql.matchAll(/insert into (\S+)/gi)].map((m) => m[1])).toEqual(["auth.users", "gaming_members", "redemption_stations"]);
  });
});
