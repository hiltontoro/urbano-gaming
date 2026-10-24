/// <reference types="vite/client" />
import { randomUUID } from "node:crypto";

import { loadEnv } from "vite";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SupabaseAuthorityRepository } from "../lib/gaming/authority/db/supabaseAuthorityRepository";
import { SupabaseGamingRepository } from "../lib/gaming/db/supabaseGamingRepository";
import { bootstrapGovernanceAuthority } from "../lib/gaming/authority/bootstrapGovernanceAuthority";
import { grantPlatformAuthority } from "../lib/gaming/authority/grantPlatformAuthority";
import { GET as publicMatches } from "../app/api/gaming/predictions/matches/route";
import { GET as teamsGET } from "../app/api/gaming/predictions/admin/teams/route";
import { GET as playersGET } from "../app/api/gaming/predictions/admin/teams/[teamId]/players/route";
import { GET as matchesGET } from "../app/api/gaming/predictions/admin/matches/route";
import { GET as venuesGET } from "../app/api/gaming/predictions/admin/venues/route";
import { GET as activationsGET } from "../app/api/gaming/predictions/admin/activations/route";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";
import { buildCatalogWorld, type CatalogWorld } from "./fixtureCatalogWorld";

/**
 * The temporary fixture exclusion and the fixed administrative return, against a real LOCAL Supabase: real Postgres, real Auth, the real
 * route handlers. The catalog is the equivalent of the Production one (36 matches, 82 teams, 122 players, 30 venues, 24 activations, 2
 * tiers) built with the EXACT ids of the manifest, so the real exclusion applies to it; the same catalog is also seeded under ids the
 * manifest does not list, which is what the routes do today without the exclusion.
 *
 * What this adds to the in-memory suites: the number of requests each route really sends to PostgREST and to Auth (counted at the network
 * boundary) and the local wall time. The times are LOCAL (no cross-region hop): they show the shape, not what a person will wait in
 * Production, and no assertion depends on them. Writes only ever go to the local database the guard allows; everything seeded is removed.
 */

const env = loadEnv("development", process.cwd(), "");
const supabaseUrl = env.SUPABASE_URL;
requireLocalSupabase(supabaseUrl);
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = env.SUPABASE_ANON_KEY;
if (!supabaseUrl || !serviceKey) throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for contract tests.");

const admin = createClient(supabaseUrl, serviceKey);
const gamingRepo = new SupabaseGamingRepository(supabaseUrl, serviceKey);
const authorityRepo = new SupabaseAuthorityRepository(supabaseUrl, serviceKey);

const SCORE_ADMIN_RETURN = "https://gaming.urbanohn.com/predictions-admin.html";
const MAILPIT = env.MAILPIT_URL || "http://127.0.0.1:54834";

// ---- counting at the network boundary -------------------------------------------------------------------------------------------
const realFetch = globalThis.fetch;
const counter = { rest: 0, auth: 0 };
const countedFetch: typeof fetch = (input, init) => {
  const url = typeof input === "string" ? input : input instanceof URL ? input.href : (input as Request).url;
  if (url.includes("/rest/v1/")) counter.rest += 1;
  else if (url.includes("/auth/v1/")) counter.auth += 1;
  return realFetch(input as RequestInfo, init);
};
async function measured<T>(work: () => Promise<T>): Promise<{ value: T; rest: number; auth: number; ms: number }> {
  counter.rest = 0;
  counter.auth = 0;
  const started = performance.now();
  const value = await work();
  return { value, rest: counter.rest, auth: counter.auth, ms: Math.round(performance.now() - started) };
}

// ---- seeding --------------------------------------------------------------------------------------------------------------------
const seeded = { matches: [] as string[], teams: [] as string[], players: [] as string[], venues: [] as string[], activations: [] as string[], tiers: [] as string[] };
const createdAuthUserIds: string[] = [];
const createdMemberIds: string[] = [];

async function must<T>(label: string, promise: PromiseLike<{ data: T; error: { message: string } | null }>): Promise<T> {
  const { data, error } = await promise;
  if (error) throw new Error(`${label}: ${error.message}`);
  return data;
}

const chunks = <T,>(rows: T[], size = 100) => Array.from({ length: Math.ceil(rows.length / size) }, (_, i) => rows.slice(i * size, (i + 1) * size));

async function seed(world: CatalogWorld): Promise<void> {
  for (const part of chunks(world.teams)) await must("teams", admin.from("teams").insert(part.map((t) => ({ team_id: t.teamId, name: t.name, created_at: t.createdAt }))).select("team_id"));
  seeded.teams.push(...world.teams.map((t) => t.teamId));
  for (const part of chunks(world.players)) await must("players", admin.from("players").insert(part.map((p) => ({ player_id: p.playerId, team_id: p.teamId, name: p.name, active: p.active, created_at: p.createdAt }))).select("player_id"));
  seeded.players.push(...world.players.map((p) => p.playerId));
  for (const part of chunks(world.venues)) await must("venues", admin.from("venues").insert(part.map((v) => ({ venue_id: v.venueId, name: v.name, latitude: v.latitude, longitude: v.longitude, radius_meters: v.radiusMeters, active: v.active, created_at: v.createdAt }))).select("venue_id"));
  seeded.venues.push(...world.venues.map((v) => v.venueId));
  for (const part of chunks(world.matches)) {
    await must("matches", admin.from("matches").insert(part.map((m) => ({
      match_id: m.matchId, home_team_id: m.homeTeamId, away_team_id: m.awayTeamId, competition: m.competition, kickoff_at: m.kickoffAt, cancelled_at: m.cancelledAt,
      prediction_contract: m.predictionContract, created_at: m.createdAt,
    }))).select("match_id"));
  }
  seeded.matches.push(...world.matches.map((m) => m.matchId));
  for (const part of chunks(world.activations)) await must("activations", admin.from("venue_activations").insert(part.map((a) => ({ venue_activation_id: a.venueActivationId, match_id: a.matchId, venue_id: a.venueId, enabled: a.enabled, created_at: a.createdAt }))).select("venue_activation_id"));
  seeded.activations.push(...world.activations.map((a) => a.venueActivationId));
  for (const tier of world.tiers) {
    const progressive = tier.ladderLevel !== null;
    await must("tiers", admin.from("prize_tiers").insert({
      prize_tier_id: tier.prizeTierId, venue_activation_id: tier.venueActivationId, prize_label: tier.prizeLabel, created_at: tier.createdAt,
      ...(progressive ? { ladder_level: tier.ladderLevel } : { correct_dimension_count: tier.correctDimensionCount }),
    }).select("prize_tier_id"));
    seeded.tiers.push(tier.prizeTierId);
  }
}

async function unseed(): Promise<void> {
  // children first; only ever by the ids that were seeded here
  const del = async (table: string, column: string, ids: string[]) => { for (const part of chunks(ids, 50)) await admin.from(table).delete().in(column, part); };
  await del("prize_tiers", "prize_tier_id", seeded.tiers);
  await del("venue_activations", "venue_activation_id", seeded.activations);
  await del("matches", "match_id", seeded.matches);
  await del("players", "player_id", seeded.players);
  await del("teams", "team_id", seeded.teams);
  await del("venues", "venue_id", seeded.venues);
  for (const key of Object.keys(seeded) as Array<keyof typeof seeded>) seeded[key] = [];
}

// ---- an administrator ------------------------------------------------------------------------------------------------------------
async function signInToken(email: string): Promise<string> {
  const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
  if (!link.data.properties) throw new Error("generateLink did not return properties.");
  // A client that verifies a code becomes that person: it must never be the one that seeds data with the service key.
  const verified = await createClient(supabaseUrl!, serviceKey!, { auth: { persistSession: false, autoRefreshToken: false } }).auth.verifyOtp({ token_hash: link.data.properties.hashed_token, type: "email" });
  if (!verified.data.session) throw new Error("verifyOtp returned no session.");
  return verified.data.session.access_token;
}

async function createAdminToken(): Promise<string> {
  const email = `fixture-view-${randomUUID()}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("Failed to create the test auth user.");
  createdAuthUserIds.push(data.user.id);
  const member = await gamingRepo.createGamingMember(data.user.id, `FixtureView-${randomUUID().slice(0, 8)}`);
  createdMemberIds.push(member.gamingMemberId);
  const { data: existing } = await admin.from("authority_grants").select("gaming_member_id").eq("authority_class", "PRODUCT_GOVERNANCE").is("revoked_at", null).limit(1).maybeSingle();
  let actor = existing?.gaming_member_id as string | undefined;
  if (!actor) {
    await bootstrapGovernanceAuthority(authorityRepo, member.gamingMemberId, "Fixture view contract: bootstrap.");
    actor = member.gamingMemberId;
  }
  await grantPlatformAuthority(authorityRepo, actor, member.gamingMemberId, "OPERATIONAL", "Fixture view contract: read the lists.");
  return signInToken(email);
}

/** What the database already holds that is not ours (other suites share it): the tests assert on the difference we add. */
async function baseline() {
  const count = async (table: string) => (await admin.from(table).select("*", { count: "exact", head: true })).count ?? 0;
  const publicList = (await (await publicMatches()).json()) as { matches: unknown[] };
  return { teams: await count("teams"), matches: await count("matches"), venues: await count("venues"), activations: await count("venue_activations"), publicMatches: publicList.matches.length };
}

const asRequest = (url: string, token: string) => new Request(url, { headers: { authorization: `Bearer ${token}`, "content-type": "application/json" } });
const BASE = "http://localhost/api/gaming/predictions";

beforeAll(() => {
  process.env.SUPABASE_URL = supabaseUrl;
  process.env.SUPABASE_SERVICE_ROLE_KEY = serviceKey;
  globalThis.fetch = countedFetch;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await unseed();
  if (createdMemberIds.length > 0) {
    await admin.from("admin_audit_events").delete().in("actor_id", createdMemberIds);
    await admin.from("authority_grants").delete().in("gaming_member_id", createdMemberIds);
    await admin.from("gaming_members").delete().in("gaming_member_id", createdMemberIds);
  }
  for (const id of createdAuthUserIds) await admin.auth.admin.deleteUser(id);
});

// ---------------------------------------------------------------------------------------------------------------------------------

describe("public list: the verified fixtures are left out before anything that depends on them is read", () => {
  it("with the exclusion the route sends a fraction of the requests, lists only legitimate matches, and the same catalog without it is listed whole", async () => {
    const base = await baseline();
    const withManifest = buildCatalogWorld();
    await seed(withManifest);
    const after = await measured(async () => (await (await publicMatches()).json()) as { matches: Array<{ matchId: string }> });
    await unseed();

    const ids = after.value.matches.map((m) => m.matchId).sort();
    const { oldMatchId, lookAlikeMatchId, newMatchId, cancelledMatchId } = withManifest.legit;
    expect(ids).toHaveLength(base.publicMatches + 3);
    for (const id of [oldMatchId, lookAlikeMatchId, newMatchId]) expect(ids).toContain(id); // old, look-alike and new are legitimate
    expect(ids).not.toContain(cancelledMatchId); // the cancelled one stays out, as before
    for (const id of withManifest.fixtureIds.matches) expect(ids).not.toContain(id);

    const withoutManifest = buildCatalogWorld({ unlistedFixtures: true });
    await seed(withoutManifest);
    const before = await measured(async () => (await (await publicMatches()).json()) as { matches: Array<{ matchId: string }> });
    await unseed();

    expect(before.value.matches).toHaveLength(base.publicMatches + 37); // 34 non-cancelled fixtures + 3 legitimate
    expect(after.rest).toBeLessThan(before.rest / 5);
    console.log("PUBLIC LIST  GET /matches  PostgREST requests: without the exclusion =", before.rest, "| with it =", after.rest, "|| local wall ms:", before.ms, "->", after.ms);
  }, 120_000);

  it("a catalog with no fixtures at all costs the same as the excluded one (requests = those of the legitimate matches)", async () => {
    const base = await baseline();
    const clean = buildCatalogWorld({ withoutFixtures: true });
    await seed(clean);
    const run = await measured(async () => (await (await publicMatches()).json()) as { matches: unknown[] });
    await unseed();
    expect(run.value.matches).toHaveLength(base.publicMatches + 3);
    const withManifest = buildCatalogWorld();
    await seed(withManifest);
    const excluded = await measured(async () => (await (await publicMatches()).json()) as { matches: unknown[] });
    await unseed();
    // the excluded run reads the match list once, which includes the fixtures' rows; nothing else differs
    expect(excluded.rest).toBe(run.rest);
    console.log("PUBLIC LIST  catalog without fixtures =", run.rest, "requests | catalog with excluded fixtures =", excluded.rest);
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------------------------------------------

describe("administration lists, in the order the portal asks for them", () => {
  async function portalLoad(token: string, query: string) {
    return measured(async () => {
      const teams = (await (await teamsGET(asRequest(`${BASE}/admin/teams${query}`, token))).json()) as { teams: Array<{ teamId: string }> };
      for (const team of teams.teams) await playersGET(asRequest(`${BASE}/admin/teams/${team.teamId}/players`, token), { params: { teamId: team.teamId } });
      const matches = (await (await matchesGET(asRequest(`${BASE}/admin/matches${query}`, token))).json()) as { matches: unknown[] };
      const venues = (await (await venuesGET(asRequest(`${BASE}/admin/venues${query}`, token))).json()) as { venues: unknown[] };
      const activations = (await (await activationsGET(asRequest(`${BASE}/admin/activations${query}`, token))).json()) as { activations: unknown[] };
      return { teams: teams.teams.length, matches: matches.matches.length, venues: venues.venues.length, activations: activations.activations.length };
    });
  }

  it("the operational view needs a handful of requests; the historical view needs one roster per team", async () => {
    const token = await createAdminToken();
    const base = await baseline();
    const world = buildCatalogWorld();
    await seed(world);
    const operational = await portalLoad(token, "");
    const historical = await portalLoad(token, "?includeFixtures=1");
    await unseed();

    expect(operational.value).toEqual({ teams: base.teams + 6, matches: base.matches + 4, venues: base.venues + 2, activations: base.activations + 3 });
    expect(historical.value).toEqual({ teams: base.teams + 88, matches: base.matches + 40, venues: base.venues + 32, activations: base.activations + 27 });
    // teams + one roster per team shown + matches + venues + activations; each admin request pays one Auth check and its own reads
    expect(operational.auth).toBe(4 + base.teams + 6);
    expect(historical.auth).toBe(4 + base.teams + 88);
    expect(operational.rest).toBeLessThan(historical.rest / 3);
    console.log("ADMIN LISTS  operational view: admin requests =", operational.auth, "| PostgREST requests =", operational.rest, "| local ms =", operational.ms);
    console.log("ADMIN LISTS  historical view:  admin requests =", historical.auth, "| PostgREST requests =", historical.rest, "| local ms =", historical.ms);
  }, 180_000);

  it("an administrator without the flag never receives a fixture id, and with it receives every one", async () => {
    const token = await createAdminToken();
    const world = buildCatalogWorld();
    await seed(world);
    const lists = async (query: string) => {
      const teams = (await (await teamsGET(asRequest(`${BASE}/admin/teams${query}`, token))).json()) as { teams: Array<{ teamId: string }> };
      const matches = (await (await matchesGET(asRequest(`${BASE}/admin/matches${query}`, token))).json()) as { matches: Array<{ matchId: string }> };
      const venues = (await (await venuesGET(asRequest(`${BASE}/admin/venues${query}`, token))).json()) as { venues: Array<{ venueId: string }> };
      const activations = (await (await activationsGET(asRequest(`${BASE}/admin/activations${query}`, token))).json()) as { activations: Array<{ venueActivationId: string }> };
      return { teams: teams.teams.map((t) => t.teamId), matches: matches.matches.map((m) => m.matchId), venues: venues.venues.map((v) => v.venueId), activations: activations.activations.map((a) => a.venueActivationId) };
    };
    const operational = await lists("");
    const historical = await lists("?includeFixtures=1");
    await unseed();
    expect(operational.teams.some((id) => world.fixtureIds.teams.has(id))).toBe(false);
    expect(operational.matches.some((id) => world.fixtureIds.matches.has(id))).toBe(false);
    expect(operational.venues.some((id) => world.fixtureIds.venues.has(id))).toBe(false);
    expect(operational.activations.some((id) => world.fixtureIds.activations.has(id))).toBe(false);
    expect(operational.matches).toContain(world.legit.oldMatchId); // an old legitimate match is not hidden by its age
    expect(operational.matches).toContain(world.legit.newMatchId);
    for (const id of world.fixtureIds.matches) expect(historical.matches).toContain(id);
    for (const id of world.fixtureIds.teams) expect(historical.teams).toContain(id);
  }, 180_000);

  it("the authority check still comes first: no token, no lists", async () => {
    const world = buildCatalogWorld();
    await seed(world);
    const anonymous = await teamsGET(new Request(`${BASE}/admin/teams?includeFixtures=1`));
    await unseed();
    expect(anonymous.status).toBe(401);
  }, 120_000);

  it("the fixtures are only hidden from the lists: every row is still there afterwards", async () => {
    const world = buildCatalogWorld();
    await seed(world);
    const token = await createAdminToken();
    await teamsGET(asRequest(`${BASE}/admin/teams`, token));
    await matchesGET(asRequest(`${BASE}/admin/matches`, token));
    await publicMatches();
    const counts = await Promise.all([
      admin.from("matches").select("*", { count: "exact", head: true }).in("match_id", [...world.fixtureIds.matches]),
      admin.from("teams").select("*", { count: "exact", head: true }).in("team_id", [...world.fixtureIds.teams]),
      admin.from("venues").select("*", { count: "exact", head: true }).in("venue_id", [...world.fixtureIds.venues]),
      admin.from("venue_activations").select("*", { count: "exact", head: true }).in("venue_activation_id", [...world.fixtureIds.activations]),
    ]);
    await unseed();
    expect(counts.map((c) => c.count)).toEqual([36, 82, 30, 24]);
  }, 120_000);
});

// ---------------------------------------------------------------------------------------------------------------------------------

describe("the fixed administrative return, with the real local Auth server", () => {
  async function mailLinkFor(email: string, since: number): Promise<URL> {
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const listed = (await (await realFetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`)).json()) as { messages?: Array<{ ID: string; Created: string }> };
      const fresh = (listed.messages ?? []).find((m) => Date.parse(m.Created) >= since - 2000);
      if (fresh) {
        const detail = (await (await realFetch(`${MAILPIT}/api/v1/message/${fresh.ID}`)).json()) as { HTML?: string; Text?: string };
        const found = `${detail.HTML ?? ""} ${detail.Text ?? ""}`.match(/https?:\/\/[^"'\s<>]*\/auth\/v1\/verify\?[^"'\s<>]+/);
        if (found) return new URL(found[0].replace(/&amp;/g, "&"));
      }
      await new Promise((r) => setTimeout(r, 250));
    }
    throw new Error("the sign-in email never reached the mail catcher");
  }

  async function mailpitReachable(): Promise<boolean> {
    try { return (await realFetch(`${MAILPIT}/api/v1/messages`)).ok; } catch { return false; }
  }

  it.skipIf(!anonKey)("a sign-in requested with the fixed portal address carries it in the email link; an address of any other kind falls back to the Site URL", async () => {
    if (!(await mailpitReachable())) throw new Error(`the local mail catcher is not reachable at ${MAILPIT}`);
    const anon = createClient(supabaseUrl, anonKey!);
    const email = `return-${randomUUID()}@example.com`;
    const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
    if (error || !data.user) throw error ?? new Error("Failed to create the test auth user.");
    createdAuthUserIds.push(data.user.id);

    const t0 = Date.now();
    const fixed = await anon.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: SCORE_ADMIN_RETURN } });
    expect(fixed.error).toBeNull();
    const fixedLink = await mailLinkFor(email, t0);
    // This stack lists the fixed address on its Redirect URLs (see the header comment); Production must list it too (a release step).
    expect(fixedLink.searchParams.get("redirect_to")).toBe(SCORE_ADMIN_RETURN);

    await new Promise((r) => setTimeout(r, 1500)); // the server spaces two codes for the same address
    const t1 = Date.now();
    const evil = await anon.auth.signInWithOtp({ email, options: { shouldCreateUser: false, emailRedirectTo: "https://evil.example/steal" } });
    expect(evil.error).toBeNull();
    const evilLink = await mailLinkFor(email, t1);
    expect(evilLink.searchParams.get("redirect_to")).not.toContain("evil.example"); // an address the project does not list is never honoured

    await new Promise((r) => setTimeout(r, 1500));
    const t2 = Date.now();
    const plain = await anon.auth.signInWithOtp({ email, options: { shouldCreateUser: false } });
    expect(plain.error).toBeNull();
    const plainLink = await mailLinkFor(email, t2);
    expect(plainLink.searchParams.get("redirect_to")).not.toBe(SCORE_ADMIN_RETURN); // a request that names nothing gets the Site URL, as every public page does
    console.log("RETURN  fixed ->", fixedLink.searchParams.get("redirect_to"), "| hostile ->", evilLink.searchParams.get("redirect_to"), "| none ->", plainLink.searchParams.get("redirect_to"));
  }, 60_000);
});
