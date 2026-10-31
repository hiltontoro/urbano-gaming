import { randomUUID } from "node:crypto";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import net from "node:net";
import path from "node:path";

import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { PUBLIC_PHOTO_CACHE_SECONDS } from "../lib/gaming/communityVoting/rounds/constants";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";
import { bind, candidates, castMany, contestants, newRound, openRound, pool, q, repo, serviceKey, sleep, supabaseUrl, voteAs } from "./helpers/roundsFixtures";
import { individuals, newContest, openCategory } from "./helpers/categoryFixtures";

/**
 * UG-IV-GATE-009 (finding F2 of GATE-008A) — Community Voting's public and per-user reads, through a REAL Next production build and its
 * REAL runtime, against REAL local Postgres and a REAL local Auth service (isolated loopback stack).
 *
 * Why this cannot be a unit test: the defect lives in Next's patched `fetch` and its Data Cache. In Next 14 the POST `rpc` call a repository
 * makes inside a GET route handler is stored for a YEAR unless the client opts out of the cache, so a public read keeps answering with the
 * first thing it ever saw. Neither a mocked repository nor an in-process call of the route function has that cache. Only a built, running
 * server does; so this file builds the app if the build is missing or older than the code (the check is the age of .next/BUILD_ID against
 * every file under lib/ and app/), starts `next start` ONCE on a free loopback port, and drives every read through HTTP while the round
 * changes underneath it — with no restart and no cache clearing in between.
 *
 * Pins: the public phase and the deadline follow the actual opening and closing (the countdown does not restart from a stale server
 * time); the publication is visible right after it happens; a hidden or withdrawn photograph leaves the gallery, the display and the
 * photograph itself at once; one person's state is never answered to another; and the Data Cache holds NO entry for any of those reads.
 * The photograph is the one response that stays cacheable on purpose (PUBLIC_PHOTO_CACHE_SECONDS); this file pins that exact window so
 * nothing promises an instantaneous removal that the response headers do not allow.
 */

requireLocalSupabase(supabaseUrl);
const anonKey = process.env.SUPABASE_ANON_KEY;
if (!anonKey) throw new Error("SUPABASE_ANON_KEY is required.");
vi.setConfig({ testTimeout: 240_000, hookTimeout: 1_200_000 });

const ROOT = process.cwd();
const NEXT_BIN = path.join(ROOT, "node_modules", "next", "dist", "bin", "next");
const BUILD_ID = path.join(ROOT, ".next", "BUILD_ID");
const FETCH_CACHE = path.join(ROOT, ".next", "cache", "fetch-cache");
const service = createClient(supabaseUrl, serviceKey as string, { auth: { persistSession: false, autoRefreshToken: false } });
const anon = createClient(supabaseUrl, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });

// ---------------------------------------------------------------- the production build and server

/** A scrubbed environment: no inherited secrets, nothing but what the server needs. */
const cleanEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, HOME: process.env.HOME, NEXT_TELEMETRY_DISABLED: "1", ...extra }) as unknown as NodeJS.ProcessEnv;

function newestSourceMtime(): number {
  let newest = 0;
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".next" || entry.name === ".git") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else newest = Math.max(newest, statSync(full).mtimeMs);
    }
  };
  for (const dir of ["lib", "app"]) walk(path.join(ROOT, dir));
  for (const file of ["package.json", "next.config.mjs", "next.config.cjs", "tsconfig.json"]) if (existsSync(path.join(ROOT, file))) newest = Math.max(newest, statSync(path.join(ROOT, file)).mtimeMs);
  return newest;
}

function ensureProductionBuild() {
  if (existsSync(BUILD_ID) && statSync(BUILD_ID).mtimeMs >= newestSourceMtime()) return;
  const built = spawnSync(process.execPath, [NEXT_BIN, "build"], { cwd: ROOT, env: cleanEnv(), encoding: "utf8", timeout: 900_000, maxBuffer: 64 * 1024 * 1024 });
  if (built.status !== 0) throw new Error(`next build failed (exit ${built.status}): ${String(built.stdout).split("\n").slice(-12).join("\n")}\n${String(built.stderr).slice(-600)}`);
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as net.AddressInfo;
      server.close(() => resolve(port));
    });
  });
}

const cacheEntries = (): string[] => (existsSync(FETCH_CACHE) ? readdirSync(FETCH_CACHE) : []);
function cachedUrls(names: string[]): string[] {
  return names.map((name) => {
    try {
      return String(JSON.parse(readFileSync(path.join(FETCH_CACHE, name), "utf8"))?.data?.url ?? "");
    } catch {
      return `(unreadable ${name})`;
    }
  });
}

let child: ChildProcess | null = null;
let base = "";
let cacheBefore: string[] = [];

async function startServer() {
  const port = await freePort();
  base = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, [NEXT_BIN, "start", "-p", String(port), "-H", "127.0.0.1"], {
    cwd: ROOT,
    env: cleanEnv({ SUPABASE_URL: supabaseUrl as string, SUPABASE_SERVICE_ROLE_KEY: serviceKey as string, SUPABASE_ANON_KEY: anonKey as string }),
    stdio: ["ignore", "pipe", "pipe"],
  });
  for (let i = 0; i < 120; i += 1) {
    try {
      if ((await fetch(`${base}/api/gaming/config`)).ok) return;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error("the production server did not start");
}

// ---------------------------------------------------------------- HTTP helpers (one running server, no restart)

type Json = Record<string, any>;
async function get(pathAndQuery: string, headers: Record<string, string> = {}) {
  const res = await fetch(`${base}${pathAndQuery}`, { headers, redirect: "manual" });
  const raw = Buffer.from(await res.arrayBuffer());
  let json: Json = {};
  if ((res.headers.get("content-type") ?? "").includes("json")) json = JSON.parse(raw.toString("utf8") || "{}");
  return { status: res.status, headers: res.headers, json, bytes: raw };
}
const route = (instanceId: string, tail: string) => `/api/gaming/community-voting/rounds/${instanceId}${tail}`;
const info = async (instanceId: string) => (await get(route(instanceId, "/info"))).json.info as Json;
const publicResults = async (instanceId: string) => (await get(route(instanceId, "/results"))).json;
const slideshow = async (instanceId: string) => ((await get(route(instanceId, "/slideshow"))).json.items as Array<{ alias: string }>).map((x) => x.alias);

/** A real local Auth user with a confirmed email and a Gaming Member, and a genuine access token. */
async function realVoter() {
  const password = `Pw-${randomUUID()}`;
  const email = `runtime-${randomUUID()}@example.invalid`;
  const created = await service.auth.admin.createUser({ email, password, email_confirm: true });
  if (created.error || !created.data.user) throw created.error ?? new Error("user not created");
  const signedIn = await anon.auth.signInWithPassword({ email, password });
  if (signedIn.error || !signedIn.data.session) throw signedIn.error ?? new Error("sign-in failed");
  const [row] = await q<{ gaming_member_id: string }>("insert into gaming_members (auth_user_id, display_name) values ($1, 'Synthetic') returning gaming_member_id", [created.data.user.id]);
  return { authUserId: created.data.user.id, gamingMemberId: row.gaming_member_id, token: signedIn.data.session.access_token, bearer: { authorization: `Bearer ${signedIn.data.session.access_token}` } };
}
const aliasesOf = async (instanceId: string) =>
  (await q<{ label: string; entry_id: string }>("select label, entry_id from community_voting_entries where instance_id = $1 order by ordinal", [instanceId])).map((r) => ({ alias: r.label.replace("#", ""), entryId: r.entry_id }));

beforeAll(async () => {
  cacheBefore = cacheEntries();
  ensureProductionBuild();
  await startServer();
});
afterAll(async () => {
  if (child && child.exitCode === null) {
    const exited = new Promise<void>((resolve) => child!.once("exit", () => resolve()));
    child.kill("SIGTERM");
    await Promise.race([exited, sleep(10_000)]);
    if (child.exitCode === null) child.kill("SIGKILL");
  }
  await pool.end();
});

// ---------------------------------------------------------------- the pins

describe("a real Next production build and runtime — Community Voting's public reads follow the database", () => {
  it("the public phase follows the actual opening and closing, and the countdown never restarts from a stale server time", async () => {
    const p = await newRound("PRELIMINARY");
    await contestants(p, 3);
    const before = await info(p.ctx.instanceId); // the read that, with the defect, was stored for a year
    expect(before.phase).toBe("NOT_OPEN");
    expect(before.approvedContestants).toBe(3);

    await openRound(p);
    const opened = await info(p.ctx.instanceId);
    expect(opened.phase).toBe("OPEN");
    expect(Date.parse(opened.serverNow)).toBeGreaterThan(Date.parse(before.serverNow));
    expect(opened.deadlineRemainingMs).toBeGreaterThan(0);

    await sleep(1_500);
    const later = await info(p.ctx.instanceId);
    expect(Date.parse(later.serverNow)).toBeGreaterThan(Date.parse(opened.serverNow));
    expect(later.deadlineRemainingMs).toBeLessThan(opened.deadlineRemainingMs - 1_000); // it counts DOWN from the real clock

    for (const c of await candidates(p)) await castMany(p, c.candidateId, 1);
    await repo.closeRound(p.ctx);
    expect((await info(p.ctx.instanceId)).phase).toBe("CLOSED");
  });

  it("a publication is visible right after it happens, with no count anywhere", async () => {
    const p = await newRound("PRELIMINARY");
    await contestants(p, 3);
    await openRound(p);
    for (const c of await candidates(p)) await castMany(p, c.candidateId, 1);
    await repo.closeRound(p.ctx);
    await repo.selectFinalists(p.ctx);
    await repo.recordRoundReview({ ...p.ctx });

    const unpublished = await publicResults(p.ctx.instanceId); // read BEFORE the transition
    expect(unpublished).toEqual({ published: false, kind: null, items: [] });
    expect((await info(p.ctx.instanceId)).published).toBe(false);

    await repo.publishRound(p.ctx);
    const published = await publicResults(p.ctx.instanceId);
    expect(published.published).toBe(true);
    expect(published.kind).toBe("FINALISTS");
    expect(published.items).toHaveLength(3);
    expect(JSON.stringify(published)).not.toMatch(/votes?|count|total|rank/i);
    expect((await info(p.ctx.instanceId)).published).toBe(true);
  });

  it("a hidden or withdrawn photograph leaves the gallery, the display and the photograph itself at once", async () => {
    // a round of the four-category contest: the public gallery shows each candidacy by its name and its code, and only the contest's rounds have candidacies
    const h = (await newContest()).rounds.FUNNIEST;
    const people = await individuals(h, 3);
    await openCategory(h);
    const voter = await realVoter();
    await repo.bindVoter({ instanceId: h.instanceId, authUserId: voter.authUserId }); // the gallery is for a person who is inside the round
    const [a0, a1, a2] = await aliasesOf(h.ctx.instanceId);
    const photo = (alias: string, headers: Record<string, string> = {}) => get(route(h.ctx.instanceId, `/photos/${alias}?v=thumb`), headers);

    // everything is shown, and the photograph is a cacheable response by design (the window is pinned below)
    expect((await slideshow(h.ctx.instanceId)).sort()).toEqual([a0.alias, a1.alias, a2.alias].sort());
    const shown = await photo(a0.alias);
    expect(shown.status).toBe(200);
    expect(shown.headers.get("content-type")).toBe("image/jpeg");
    const etag = shown.headers.get("etag") as string;
    expect(etag).toBeTruthy();
    expect(((await get(route(h.ctx.instanceId, "/gallery"), voter.bearer)).json.items as Array<{ alias: string }>).map((x) => x.alias).sort()).toEqual([a0.alias, a1.alias, a2.alias].sort());

    await repo.hideRoundPhoto({ ...h.ctx, entryId: people[0].entry.entryId, reason: "the person asked" });
    await repo.withdrawRoundCandidature({ ...h.ctx, entryId: people[1].entry.entryId, reason: "the person withdrew", hidePhoto: true });

    expect(await slideshow(h.ctx.instanceId)).toEqual([a2.alias]); // the display, at once
    expect(((await get(route(h.ctx.instanceId, "/gallery"), voter.bearer)).json.items as Array<{ alias: string }>).map((x) => x.alias)).toEqual([a2.alias]); // the gallery, at once
    expect((await photo(a0.alias)).status).toBe(404); // the photograph of the person who asked to hide it
    expect((await photo(a1.alias)).status).toBe(404); // the photograph of the withdrawn candidate
    expect((await photo(a0.alias, { "if-none-match": etag })).status).toBe(404); // a conditional request is not answered with "not modified"
    expect((await photo(a2.alias)).status).toBe(200); // the one still shown is unaffected
  });

  it("one person's state is never answered to another person, repeatedly and in any order", async () => {
    const u = await newRound("PRELIMINARY");
    const cs = await contestants(u, 3);
    await openRound(u);
    const [c0, c1] = await candidates(u);
    const a = await realVoter();
    const b = await realVoter();
    await voteAs(u, a, c0.candidateId);
    await voteAs(u, b, c1.candidateId);
    const status = async (headers: Record<string, string>) => get(route(u.ctx.instanceId, "/status"), headers);
    for (let i = 0; i < 3; i += 1) {
      expect((await status(a.bearer)).json.myCandidateId).toBe(c0.candidateId);
      expect((await status(b.bearer)).json.myCandidateId).toBe(c1.candidateId);
    }
    expect((await status({})).status).toBe(401);
    expect((await status({ authorization: "Bearer not-a-token" })).status).toBe(401);
    expect(cs).toHaveLength(3);
  });

  it("every read says no-store, except the photograph, whose window is the documented one", async () => {
    const r = await newRound("PRELIMINARY");
    await contestants(r, 2);
    await openRound(r);
    const voter = await realVoter();
    await bind(r, voter);
    const [first] = await aliasesOf(r.ctx.instanceId);
    for (const tail of ["/info", "/results", "/slideshow"]) expect((await get(route(r.ctx.instanceId, tail))).headers.get("cache-control"), tail).toMatch(/no-store/);
    for (const tail of ["/gallery", "/status"]) expect((await get(route(r.ctx.instanceId, tail), voter.bearer)).headers.get("cache-control"), tail).toMatch(/no-store/);
    const shown = await get(route(r.ctx.instanceId, `/photos/${first.alias}?v=thumb`));
    // a copy already fetched can outlive a hiding by up to this long, in a browser AND in a shared (edge) cache: that is the whole revocation delay
    expect(shown.headers.get("cache-control")).toBe(`public, max-age=${PUBLIC_PHOTO_CACHE_SECONDS}, s-maxage=${PUBLIC_PHOTO_CACHE_SECONDS}`);
    expect(PUBLIC_PHOTO_CACHE_SECONDS).toBe(60);
  });

  it("the Next Data Cache holds no entry for any of those reads (no route setting is what keeps them fresh)", async () => {
    const created = cachedUrls(cacheEntries().filter((name) => !cacheBefore.includes(name)));
    expect(created.filter((url) => /\/rest\/v1\/|\/auth\/v1\//.test(url))).toEqual([]);
    expect(created).toEqual([]);
  });
});
