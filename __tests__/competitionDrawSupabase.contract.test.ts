import { createHash, randomUUID } from "node:crypto";

import { loadEnv } from "vite";
import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SupabaseCompetitionsRepository } from "../lib/gaming/competitions/db/supabaseCompetitionsRepository";
import { SupabaseHostRepository } from "../lib/gaming/host/db/supabaseHostRepository";
import { SupabaseGamingRepository } from "../lib/gaming/db/supabaseGamingRepository";
import { submitHostApplication } from "../lib/gaming/host/submitHostApplication";
import { decideHostApplication } from "../lib/gaming/host/decideHostApplication";
import { revokeHostCapability } from "../lib/gaming/host/revokeHostCapability";
import { createCompetition } from "../lib/gaming/competitions/createCompetition";
import { addCompetitionTeam } from "../lib/gaming/competitions/addCompetitionTeam";
import { openTeamRegistration } from "../lib/gaming/competitions/openTeamRegistration";
import { closeTeamRegistration } from "../lib/gaming/competitions/closeTeamRegistration";
import { registerForCompetition } from "../lib/gaming/competitions/registerForCompetition";
import { publishCompetition } from "../lib/gaming/competitions/publishCompetition";
import { cancelCompetition } from "../lib/gaming/competitions/cancelCompetition";
import { appointScorekeeper } from "../lib/gaming/competitions/appointScorekeeper";
import { getCompetitionView } from "../lib/gaming/competitions/getCompetitionView";
import { CompetitionAccessDeniedError, CompetitionNotFoundError, HostAccessRevokedError, UnsupportedActivityKeyError } from "../lib/gaming/competitions/types";
import type { SoccerFormatKey } from "../lib/gaming/competitions/formats";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";
// The REAL route handlers, called with real user access tokens against the real local database.
import { POST as hostCreateRoute } from "../app/api/gaming/host/competition/route";

/**
 * UG-CR-GATE-SSS-019 — Auditable Four-Team Draw backend foundation, against a real (disposable, loopback-only) Postgres.
 *
 * Proves, in the database itself: only the competition's own ACTIVE organizer can draw (a revoked host, a frozen captain, a scorekeeper, an ordinary member
 * and a member holding only OPERATIONAL authority cannot); no draw before a consistent registration freeze of exactly four accepted teams, and none while a
 * plan change genuinely awaits the captains (an expired, rejected, withdrawn, superseded or activated one does not block); the entropy is generated inside
 * the one atomic operation and nothing a client sends can influence it; exactly one permanent draw exists, an exact replay returns it and anything else is a
 * conflict that changes nothing; the stored evidence reproduces the draw (index, order, digest), tampering with it is refused, and it is immutable; only the
 * organizer and the four frozen captains can read it; and the draw creates no fixture, publishes nothing, changes no state and changes nothing the freeze, the
 * plan, the amendments, discovery or the view carry — a later activated plan change leaves the draw exactly as it was.
 *
 * THE ORACLE. The algorithm's literals (seed vectors, the rejected-word seed, the 24-seed-thousand counts, the digest known answer) were computed by Python
 * (hashlib, itertools), not by the code under test. The SQL helpers are internal and executable by nobody; they are probed here with the database owner.
 *
 * CLOCK. The decision instant is competition_registration_clock() (SSS-007): this file redefines it ONLY inside transactions it rolls back. Service-side
 * fixtures (the database owner) are used only to build the frozen competition quickly, to age a proposal, to put a competition into a state no public path
 * can reach, and to forge evidence the operations never would — each is named where it is used.
 */

const env = loadEnv("development", process.cwd(), "");
const supabaseUrl = env.SUPABASE_URL;
requireLocalSupabase(supabaseUrl);
const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAnonKey = env.SUPABASE_ANON_KEY;
if (!supabaseUrl || !supabaseServiceRoleKey || !supabaseAnonKey) {
  throw new Error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are required for contract tests.");
}
// Raw pg runs the rolled-back clock seam, the fixtures, the forged evidence and the catalog checks. The URL is supplied explicitly, never read from .env.local,
// and must be loopback.
const supabaseDbUrl = process.env.COMPETITIONS_LOCAL_DB_URL ?? "";
if (!/^postgresql:\/\/[^@]+@(127\.0\.0\.1|localhost|\[::1\]):\d+\//.test(supabaseDbUrl)) {
  throw new Error("COMPETITIONS_LOCAL_DB_URL must be set to a loopback Postgres URL for the four-team draw contract tests.");
}

const compRepo = new SupabaseCompetitionsRepository(supabaseUrl, supabaseServiceRoleKey);
const hostRepo = new SupabaseHostRepository(supabaseUrl, supabaseServiceRoleKey);
const gamingRepo = new SupabaseGamingRepository(supabaseUrl, supabaseServiceRoleKey);
const service = createClient(supabaseUrl, supabaseServiceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
const anon = createClient(supabaseUrl, supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false } });

const RUN = randomUUID().slice(0, 8);
const DAY = 24 * 3600_000;
const DRAW_TABLES = ["competition_draws", "competition_draw_entries"] as const;
const DRAW_RPCS = ["create_competition_draw_atomically", "get_competition_draw"] as const;
const DRAW_HELPERS = [
  "competition_draw_accept_word", "competition_draw_digest", "competition_draw_eligibility_problem", "competition_draw_entry_verify_row", "competition_draw_evidence",
  "competition_draw_order", "competition_draw_permutation_index", "competition_draw_reject_change", "competition_draw_verify", "competition_draw_verify_row", "competition_draw_word",
] as const;

// Loaded lazily: until the module exists, only the tests that need it can fail.
const loadDraw = () => import("../lib/gaming/competitions/draw");
const loadRoute = async () => (await import("../app/api/gaming/competitions/[competitionId]/draw/route")) as unknown as Record<string, (r: Request, c: { params: { competitionId: string } }) => Promise<Response>>;

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The independent oracle (Python hashlib / itertools) — see competitionDraw.test.ts for the specification.
// ---------------------------------------------------------------------------------------------------------------------------------------------

const SEED_VECTORS: Array<{ seed: string; word0: number; index: number }> = [
  { seed: "0000000000000000000000000000000000000000000000000000000000000000", word0: 1840668629, index: 5 },
  { seed: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", word0: 417982684, index: 4 },
  { seed: "0100000000000000000000000000000000000000000000000000000000000000", word0: 297537884, index: 20 },
  { seed: "abababababababababababababababababababababababababababababababab", word0: 1403299552, index: 16 },
  { seed: "80d4278cdeda8cd9f38395272d82bd1fc78b43433aff35c700cfb5903eeea6e7", word0: 2862083036, index: 20 },
  { seed: "fbf2d96ec0174ae3f2434b7181ad7469d94253cc305714e83c00fca12ed01263", word0: 1107983618, index: 2 },
  { seed: "3a04fbe99713e2e823645d331fbe9441c4c6bc84586a7f13e16a90f18cddcf68", word0: 2649533133, index: 21 },
  { seed: "67e02b61dafba7f44f6aa7cf10bc3466ee6cd05377148aa9803f129a742aed79", word0: 1103456211, index: 3 },
  { seed: "f8fd80ddce7f195fe672a0436af50ebe4fc496edbfc5b8ef06b9adc25cfa1153", word0: 3949706855, index: 23 },
  { seed: "bb20a42448d8143e6fc50b1a2ef420410048023e526bec2091adb0b326658846", word0: 703952750, index: 14 },
  { seed: "88ab9d555359ccd3c2e7b983e1c2cd73b749ec969b1b219bf58a9f940cf5fc1a", word0: 3764207070, index: 6 },
  { seed: "e83c92cebce954679d8ba433d789cc9743bfc06177220402a5ad8776fdb06c7f", word0: 2135698041, index: 9 },
];
/** Counter 0 gives 4294967282 (REJECTED); counter 1 gives 270744965 -> index 5. */
const REJECTION_SEED = "0000000000000000000000000000000000000000000000000000000016a220aa";
const BOUNDARY: Array<[number, number | null]> = [
  [0, 0], [1, 1], [23, 23], [24, 0], [25, 1], [4294967255, 23], [4294967256, 0], [4294967278, 22], [4294967279, 23], [4294967280, null], [4294967281, null], [4294967295, null],
];
const UNIFORM_COUNTS = [965, 999, 985, 950, 1032, 997, 1003, 972, 1012, 970, 1002, 1017, 977, 997, 1054, 987, 945, 1046, 1054, 1058, 1016, 986, 960, 1016];
const KAT = {
  competition: "11111111-1111-4111-8111-111111111111",
  freezeDigest: createHash("sha256").update("freeze", "utf8").digest("hex"),
  seed: SEED_VECTORS[3].seed,
  index: 16,
  input: ["1b0a7c5e-3d24-4c1f-9a53-0e8d2f6b7a01", "3f9d2a10-7b6e-4d85-8c42-5a1e9b0c3d02", "8c41e7d9-0a35-4b6f-a1d8-2c7e5f9b4a03", "d2e6b8f1-5c97-4a30-b4e2-9f1a6d8c0b04"],
  digest: "6e8a187d5973a87a226f04d4a2758a073f472463c25efcf935c7c81cbc9aa6b8",
};
/** Every ordering of the items, lexicographically — written here, independently of the code under test. */
function allOrders<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  const out: T[][] = [];
  items.forEach((item, i) => {
    for (const rest of allOrders(items.filter((_, j) => j !== i))) out.push([item, ...rest]);
  });
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------------------------------------------------------------------------

interface Person { authUserId: string; gamingMemberId: string; email: string }
const authUsers: string[] = [];
const operators: string[] = [];
const competitionIds: string[] = [];
let counter = 0;

async function newPerson(label: string): Promise<Person> {
  const email = `draw-${RUN}-${counter++}@example.com`;
  const { data, error } = await service.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("Could not create a test auth user.");
  authUsers.push(data.user.id);
  const member = await gamingRepo.createGamingMember(data.user.id, `${label.slice(0, 26)} ${RUN}-${counter}`);
  return { authUserId: data.user.id, gamingMemberId: member.gamingMemberId, email };
}

async function makeOperator(label: string): Promise<Person> {
  const person = await newPerson(label);
  const { error } = await service.from("authority_grants").insert({ gaming_member_id: person.gamingMemberId, authority_class: "OPERATIONAL" });
  if (error) throw error;
  operators.push(person.gamingMemberId);
  return person;
}

let reviewer: Person;
async function asGovernance<T>(fn: () => Promise<T>): Promise<T> {
  const { error } = await service.from("authority_grants").insert({ gaming_member_id: reviewer.gamingMemberId, authority_class: "PRODUCT_GOVERNANCE" });
  if (error) throw error;
  try {
    return await fn();
  } finally {
    await service.from("authority_grants").delete().eq("gaming_member_id", reviewer.gamingMemberId).eq("authority_class", "PRODUCT_GOVERNANCE");
  }
}

async function tokenFor(person: Person): Promise<string> {
  const link = await service.auth.admin.generateLink({ type: "magiclink", email: person.email });
  if (!link.data.properties) throw new Error("No link properties for the test member.");
  const client = createClient(supabaseUrl, supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const verified = await client.auth.verifyOtp({ token_hash: link.data.properties.hashed_token, type: "email" });
  const token = verified.data.session?.access_token;
  if (!token) throw new Error("No session for the test member.");
  return token;
}

// A shared pool: a member can belong to one team per competition, so each competition draws disjoint slices from the same people.
const POOL_SIZE = 26;
let captains: Person[] = [];
let pool: Person[] = [];
async function ensurePool() {
  if (pool.length > 0) return;
  captains = await Promise.all([0, 1, 2, 3, 4].map((i) => newPerson(`Captain ${i}`)));
  const made: Person[] = [];
  for (let i = 0; i < POOL_SIZE; i += 8) {
    made.push(...(await Promise.all(Array.from({ length: Math.min(8, POOL_SIZE - i) }, (_, k) => newPerson(`Player ${i + k}`)))));
  }
  pool = made;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Raw database access (the database owner), fixtures and the rolled-back clock
// ---------------------------------------------------------------------------------------------------------------------------------------------

async function rawTransaction<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  const db = new Client({ connectionString: supabaseDbUrl, statement_timeout: 60000 });
  await db.connect();
  try {
    await db.query("begin");
    return await fn(db);
  } finally {
    await db.query("rollback").catch(() => {});
    await db.end().catch(() => {});
  }
}

async function rawQuery<T extends Record<string, any> = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const db = new Client({ connectionString: supabaseDbUrl, statement_timeout: 60000 });
  await db.connect();
  try {
    return (await db.query(sql, params)).rows as T[];
  } finally {
    await db.end().catch(() => {});
  }
}

interface DbViolation { code?: string; constraint?: string; message: string }
/** Runs statements inside a transaction that is always rolled back, forcing every deferred check to run before the end; returns the database error (or null). */
async function violationOf(fn: (db: Client) => Promise<void>): Promise<DbViolation | null> {
  return rawTransaction(async (db) => {
    try {
      await fn(db);
      await db.query("set constraints all immediate");
      return null;
    } catch (err) {
      const e = err as { code?: string; constraint?: string; message?: string };
      return { code: e.code, constraint: e.constraint, message: e.message ?? "" };
    }
  });
}

type Outcome = { ok: true; rows: Record<string, any>[] } | { ok: false; message: string; code?: string };
/** Calls one statement with the database clock put on an exact instant, in a transaction that is ALWAYS rolled back. */
async function atInstant(instant: string, statement: string, params: unknown[] = []): Promise<Outcome> {
  return rawTransaction(async (db) => {
    await db.query(`create or replace function public.competition_registration_clock() returns timestamptz language sql volatile set search_path to 'public' as $clock$ select '${instant}'::timestamptz $clock$`);
    try {
      return { ok: true, rows: (await db.query(statement, params)).rows };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      return { ok: false, message: e.message ?? "", code: e.code };
    }
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Plans and competitions
// ---------------------------------------------------------------------------------------------------------------------------------------------

const CR_OFFSET_MS = -6 * 3600_000; // America/Costa_Rica has no daylight saving: always UTC-06:00
const localMinute = (utcMs: number) => new Date(utcMs + CR_OFFSET_MS).toISOString().slice(0, 16);
const localDate = (utcMs: number) => new Date(utcMs + CR_OFFSET_MS).toISOString().slice(0, 10);

function rawPlan(opts: { deadlineMs: number }) {
  return {
    venue: { name: `Cancha ${RUN}`, locationDescription: "Calle 5, San José, behind the central market", timeZone: "America/Costa_Rica", simultaneousMatchCapacity: 1, restrictionNotes: "No metal cleats." },
    pitches: [{ label: "A", usable: true, supportedFormats: ["SOCCER_5V5"], restrictionNotes: "" }],
    dates: [{ date: localDate(opts.deadlineMs + 3 * DAY), windows: [{ start: "09:00", end: "13:00" }] }],
    roster: { minimum: 5, maximum: 8 },
    registrationDeadline: { local: localMinute(opts.deadlineMs), timeZone: "America/Costa_Rica" },
    rules: { version: "draft-1", snapshot: "Draft registration rules, version one." },
  };
}

async function savePlan(competitionId: string, organizerId: string, deadlineMs: number) {
  const { parsePlanningPlan } = await import("../lib/gaming/competitions/planning");
  return compRepo.savePlanningRevision(competitionId, organizerId, randomUUID(), parsePlanningPlan(rawPlan({ deadlineMs }), "SOCCER_5V5"));
}

/**
 * Service-side fixture: records a later planning revision as the database owner, with exactly the deadline given (and, optionally, other roster bounds). The
 * revision chain, the children and every constraint are the real ones; only the save operation (which needs a DRAFT and a minute-resolution deadline) is bypassed.
 */
async function supersedePlan(competitionId: string, deadlineIso: string, override: { rosterMinimum?: number } = {}): Promise<void> {
  await rawTransaction(async (db) => {
    const cur = (await db.query("select * from competition_planning_revisions where competition_id = $1 order by revision_number desc limit 1", [competitionId])).rows[0];
    const next = (await db.query(
      `insert into competition_planning_revisions (competition_id, format_key, revision_number, supersedes_revision_id, authored_by_gaming_member_id, intent_id, payload_digest,
         venue_name, venue_location_description, venue_time_zone, simultaneous_match_capacity, venue_restriction_notes, roster_minimum, roster_maximum,
         registration_deadline_local, registration_deadline_time_zone, registration_deadline_utc_offset_minutes, registration_deadline_utc, rules_version, rules_snapshot, rules_snapshot_digest)
       values ($1,$2,$3,$4,$5,gen_random_uuid(),$6,$7,$8,$9,$10,$11,$12,$13, ($14::timestamptz at time zone $15), $15, $16, $14::timestamptz, $17,$18,$19) returning planning_revision_id`,
      [competitionId, cur.format_key, cur.revision_number + 1, cur.planning_revision_id, cur.authored_by_gaming_member_id, cur.payload_digest, cur.venue_name, cur.venue_location_description,
        cur.venue_time_zone, cur.simultaneous_match_capacity, cur.venue_restriction_notes, override.rosterMinimum ?? cur.roster_minimum, cur.roster_maximum, deadlineIso, cur.registration_deadline_time_zone,
        cur.registration_deadline_utc_offset_minutes, cur.rules_version, cur.rules_snapshot, cur.rules_snapshot_digest])).rows[0].planning_revision_id;
    await db.query("insert into competition_planning_pitches (planning_revision_id, position, label, is_usable, restriction_notes) select $2::uuid, position, label, is_usable, restriction_notes from competition_planning_pitches where planning_revision_id = $1::uuid", [cur.planning_revision_id, next]);
    await db.query(
      `insert into competition_planning_pitch_formats (planning_pitch_id, format_key)
       select np.planning_pitch_id, f.format_key from competition_planning_pitches op join competition_planning_pitch_formats f on f.planning_pitch_id = op.planning_pitch_id
         join competition_planning_pitches np on np.planning_revision_id = $2::uuid and np.position = op.position where op.planning_revision_id = $1::uuid`, [cur.planning_revision_id, next]);
    await db.query("insert into competition_planning_dates (planning_revision_id, plan_date, position) select $2::uuid, plan_date, position from competition_planning_dates where planning_revision_id = $1::uuid", [cur.planning_revision_id, next]);
    await db.query("insert into competition_planning_windows (planning_revision_id, plan_date, window_index, start_time, end_time) select $2::uuid, plan_date, window_index, start_time, end_time from competition_planning_windows where planning_revision_id = $1::uuid", [cur.planning_revision_id, next]);
    await db.query("commit");
  });
}

/** Service-side fixture: lets the deadline pass WITHOUT waiting, by recording a later revision whose deadline is the start of the current minute. */
async function passDeadline(competitionId: string): Promise<void> {
  await supersedePlan(competitionId, new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString());
}

interface Ctx { competitionId: string; organizer: Person; deadlineMs: number; teams: Array<{ teamId: string; captain: Person; members: string[] }> }

/** A competition with a saved plan, four organizer-created teams and (optionally) open registration. */
async function setUp(label: string, opts: { open?: boolean; teamCount?: number } = {}): Promise<Ctx> {
  await ensurePool();
  const deadlineMs = Date.now() + 2 * DAY;
  const organizer = await makeOperator(`${label} Organizer`);
  const created = await createCompetition(compRepo, organizer.gamingMemberId, `Draw ${label} ${RUN}`, "SOCCER_5V5");
  competitionIds.push(created.competitionId);
  const teams: Ctx["teams"] = [];
  for (let i = 0; i < (opts.teamCount ?? 4); i++) {
    const team = await addCompetitionTeam(compRepo, created.competitionId, organizer.gamingMemberId, `T${i} ${label.slice(0, 12)} ${RUN}`, captains[i].gamingMemberId);
    teams.push({ teamId: team.competitionTeamId, captain: captains[i], members: [] });
  }
  await savePlan(created.competitionId, organizer.gamingMemberId, deadlineMs);
  if (opts.open !== false) await openTeamRegistration(compRepo, created.competitionId, organizer.gamingMemberId);
  return { competitionId: created.competitionId, organizer, deadlineMs, teams };
}

/** Service-side fixture: approved memberships for a team, drawn from a disjoint slice of the shared pool. */
async function giveMembers(ctx: Ctx, teamIndex: number, count: number): Promise<string[]> {
  const start = ctx.teams.slice(0, teamIndex).reduce((n, t) => n + t.members.length, 0);
  const slice = pool.slice(start, start + count).map((p) => p.gamingMemberId);
  expect(slice).toHaveLength(count);
  await rawQuery(
    "insert into competition_team_memberships (competition_id, competition_team_id, gaming_member_id, approved_by_gaming_member_id) select $1, $2, unnest($3::uuid[]), $4",
    [ctx.competitionId, ctx.teams[teamIndex].teamId, slice, ctx.organizer.gamingMemberId]);
  ctx.teams[teamIndex].members.push(...slice);
  return slice;
}
async function fillRosters(ctx: Ctx, size = 5) { for (let i = 0; i < ctx.teams.length; i++) await giveMembers(ctx, i, size); }

/** A frozen competition: four teams whose rosters were filled, the deadline passed (service-side fixture) and registration frozen through the real close. */
async function frozen(label: string): Promise<Ctx> {
  const ctx = await setUp(label);
  await fillRosters(ctx);
  await passDeadline(ctx.competitionId);
  expect((await closeTeamRegistration(compRepo, ctx.competitionId, ctx.organizer.gamingMemberId)).state).toBe("READY_TO_PUBLISH");
  return ctx;
}

/** An approved host's one private pilot (a DRAFT, host-bound competition) and a way to revoke the host. */
async function hostPilot(label: string) {
  const host = await newPerson(`${label} Host`);
  const application = {
    venueName: `Venue ${RUN}`, cityArea: "Fictional Heights", playingFields: 2,
    venueDescription: "A fictional venue used only by the local contract suite; it runs imaginary leagues.",
    expectedWindow: "weekend of 14 November", expectedTeamCount: 4,
    confirmAllAdults: true, confirmIndependentScorekeepers: true, confirmPilotExclusions: true,
  };
  const submitted = await submitHostApplication(hostRepo, host.gamingMemberId, application);
  await asGovernance(() => decideHostApplication(hostRepo, reviewer.gamingMemberId, submitted.publicCode, "APPROVE", null));
  process.env.BECOME_A_HOST_SCHEMA_READY = "true";
  let competitionId = "";
  try {
    const res = await hostCreateRoute(request("http://localhost/api/gaming/host/competition", "POST", await tokenFor(host), { name: `Host Pilot ${label} ${RUN}` }));
    expect(res.status).toBe(201);
    competitionId = (await res.json()).competition.competitionId;
  } finally {
    delete process.env.BECOME_A_HOST_SCHEMA_READY;
  }
  competitionIds.push(competitionId);
  const revoke = () => asGovernance(() => revokeHostCapability(hostRepo, reviewer.gamingMemberId, submitted.publicCode, "Draw contract test."));
  return { host, competitionId, revoke };
}

async function frozenPilot(label: string) {
  await ensurePool();
  const pilot = await hostPilot(label);
  const ctx: Ctx = { competitionId: pilot.competitionId, organizer: pilot.host, deadlineMs: Date.now() + 2 * DAY, teams: [] };
  for (let i = 0; i < 4; i++) {
    const team = await addCompetitionTeam(compRepo, ctx.competitionId, pilot.host.gamingMemberId, `P${i} ${label.slice(0, 10)} ${RUN}`, captains[i].gamingMemberId);
    ctx.teams.push({ teamId: team.competitionTeamId, captain: captains[i], members: [] });
  }
  await savePlan(ctx.competitionId, pilot.host.gamingMemberId, ctx.deadlineMs);
  await openTeamRegistration(compRepo, ctx.competitionId, pilot.host.gamingMemberId);
  await fillRosters(ctx);
  await passDeadline(ctx.competitionId);
  await closeTeamRegistration(compRepo, ctx.competitionId, pilot.host.gamingMemberId);
  return { ctx, pilot };
}

const COMP = "http://localhost/api/gaming/competitions";
const request = (url: string, method: string, token: string, body?: unknown) =>
  new Request(url, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const ctxOf = (competitionId: string) => ({ params: { competitionId } });

const ENV_KEYS = ["COMPETITIONS_SCHEMA_READY", "BECOME_A_HOST_SCHEMA_READY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY"] as const;
const originalEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
  process.env.COMPETITIONS_SCHEMA_READY = "true";
  delete process.env.BECOME_A_HOST_SCHEMA_READY;
  process.env.SUPABASE_URL ??= supabaseUrl;
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= supabaseServiceRoleKey;
  process.env.SUPABASE_ANON_KEY ??= supabaseAnonKey;
  reviewer = await newPerson("Reviewer");
}, 180000);

// Evidence rows are append-only, so the owner removes them with row triggers off (replica role). Every statement runs on its own: one that cannot run must
// not stop the rest. Best effort beyond that: a database reset restores a clean state. The draw's rows go FIRST (they reference what follows).
afterAll(async () => {
  if (competitionIds.length > 0) {
    const db = new Client({ connectionString: supabaseDbUrl, statement_timeout: 60000 });
    try {
      await db.connect();
      await db.query("set session_replication_role = replica");
      const ids = [competitionIds];
      const revs = "(select planning_revision_id from competition_planning_revisions where competition_id = any($1))";
      const fx = "(select competition_fixture_id from competition_fixtures where competition_id = any($1))";
      const statements = [
        "delete from competition_draw_entries where competition_id = any($1)",
        "delete from competition_draws where competition_id = any($1)",
        "delete from competition_plan_change_resolutions where competition_id = any($1)",
        "delete from competition_plan_change_decisions where competition_id = any($1)",
        "delete from competition_plan_change_proposals where competition_id = any($1)",
        "delete from competition_registration_freeze_members where competition_id = any($1)",
        "delete from competition_registration_freeze_teams where competition_id = any($1)",
        "delete from competition_registration_freezes where competition_id = any($1)",
        `delete from competition_planning_windows where planning_revision_id in ${revs}`,
        `delete from competition_planning_dates where planning_revision_id in ${revs}`,
        `delete from competition_planning_pitch_formats where planning_pitch_id in (select planning_pitch_id from competition_planning_pitches where planning_revision_id in ${revs})`,
        `delete from competition_planning_pitches where planning_revision_id in ${revs}`,
        "delete from competition_planning_revisions where competition_id = any($1)",
        `delete from competition_roster_revision_entries where competition_roster_revision_id in (select competition_roster_revision_id from competition_roster_revisions where competition_fixture_id in ${fx})`,
        `delete from competition_roster_revisions where competition_fixture_id in ${fx}`,
        `delete from competition_checkins where competition_fixture_id in ${fx}`,
        `delete from competition_member_participation_records where competition_fixture_id in ${fx}`,
        "delete from competition_fixtures where competition_id = any($1)",
        "delete from competition_team_memberships where competition_id = any($1)",
        "delete from competition_join_requests where competition_id = any($1)",
        "delete from competition_registrations where competition_id = any($1)",
        "delete from competition_teams where competition_id = any($1)",
        "delete from competition_host_capabilities where competition_id = any($1)",
        "delete from competitions where competition_id = any($1)",
      ];
      for (const statement of statements) await db.query(statement, ids).catch(() => {});
    } catch {
      /* best effort */
    } finally {
      await db.end().catch(() => {});
    }
  }
  if (operators.length > 0) await service.from("authority_grants").delete().in("gaming_member_id", operators);
  if (reviewer) await service.from("authority_grants").delete().eq("gaming_member_id", reviewer.gamingMemberId);
  for (const id of authUsers) await service.auth.admin.deleteUser(id).catch(() => {});
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
}, 600000);

// =============================================================================================================================================
// Helpers of this gate
// =============================================================================================================================================

const draw = (ctx: Ctx, intent: string = randomUUID(), caller: string = ctx.organizer.gamingMemberId) => compRepo.createCompetitionDraw(ctx.competitionId, caller, intent);
const readDraw = (ctx: Ctx, memberId: string) => compRepo.getCompetitionDraw(ctx.competitionId, memberId);
const drawRows = (competitionId: string) => rawQuery("select * from competition_draws where competition_id = $1", [competitionId]);
const entryRows = (competitionId: string) => rawQuery("select * from competition_draw_entries where competition_id = $1 order by draw_position", [competitionId]);
const drawCount = async (competitionId: string) => (await rawQuery("select (select count(*)::int from competition_draws where competition_id = $1) as draws, (select count(*)::int from competition_draw_entries where competition_id = $1) as entries", [competitionId]))[0] as { draws: number; entries: number };
const NO_DRAW = { draws: 0, entries: 0 };
const stateOf = async (competitionId: string) => (await rawQuery("select state, published_at from competitions where competition_id = $1", [competitionId]))[0] as { state: string; published_at: Date | null };
const fixtureCount = async (competitionId: string) => (await rawQuery("select count(*)::int n from competition_fixtures where competition_id = $1", [competitionId]))[0].n as number;
const sha = (text: string) => createHash("sha256").update(text).digest("hex");

/** A hash of the draw's own rows (the evidence, byte for byte): a retry or a later change elsewhere must leave it exactly as it was. */
async function drawEvidenceHash(competitionId: string): Promise<string> {
  const rows = await rawQuery(
    `select (select coalesce(jsonb_agg(to_jsonb(d) order by to_jsonb(d)::text), '[]') from competition_draws d where d.competition_id = $1) as draws,
            (select coalesce(jsonb_agg(to_jsonb(e) order by to_jsonb(e)::text), '[]') from competition_draw_entries e where e.competition_id = $1) as entries`, [competitionId]);
  return sha(JSON.stringify(rows[0]));
}

/**
 * A hash of EVERYTHING else a competition carries: the competition row, its teams, memberships, registrations, join requests, fixtures, the registration freeze, every
 * planning revision and child, and every plan change (proposals, decisions, resolutions), and its host capability. A draw must leave all of it byte-identical.
 */
async function collateralHash(competitionId: string): Promise<string> {
  const agg = (table: string, key = "competition_id") => `(select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]') from ${table} x where x.${key} = $1)`;
  const rows = await rawQuery(
    `select (select to_jsonb(c) from competitions c where c.competition_id = $1) as competition,
            ${agg("competition_teams")} as teams, ${agg("competition_team_memberships")} as memberships, ${agg("competition_registrations")} as registrations,
            ${agg("competition_join_requests")} as join_requests, ${agg("competition_fixtures")} as fixtures, ${agg("competition_registration_freezes")} as freezes,
            ${agg("competition_registration_freeze_teams")} as freeze_teams, ${agg("competition_registration_freeze_members")} as freeze_members,
            ${agg("competition_planning_revisions")} as revisions, ${agg("competition_plan_change_proposals")} as proposals, ${agg("competition_plan_change_decisions")} as decisions,
            ${agg("competition_plan_change_resolutions")} as resolutions, ${agg("competition_host_capabilities")} as hosts`, [competitionId]);
  return sha(JSON.stringify(rows[0]));
}

async function expectRejects<E extends Error>(promise: Promise<unknown>, type: new (...args: any[]) => E): Promise<E> {
  let caught: unknown = null;
  let resolved = false;
  try {
    await promise;
    resolved = true;
  } catch (err) {
    caught = err;
  }
  expect(resolved, `the call must be refused with ${type.name}, but it resolved`).toBe(false);
  expect(caught).toBeInstanceOf(type);
  return caught as E;
}

/** The draw must be refused with the typed refusal carrying this stable code. */
async function expectRefusal(promise: Promise<unknown>, code: string) {
  let caught: unknown = null;
  let resolved = false;
  try {
    await promise;
    resolved = true;
  } catch (err) {
    caught = err;
  }
  expect(resolved, `the draw must be refused with ${code}, but it succeeded`).toBe(false);
  const { CompetitionDrawError } = await loadDraw();
  expect(caught).toBeInstanceOf(CompetitionDrawError);
  expect((caught as { code: string }).code).toBe(code);
}

/** An amendable proposal: a new venue, one pitch, and one date six days out (venue-local). */
function facts(name = `Amended Venue ${RUN}`) {
  return {
    venue: { name, locationDescription: "Calle 9, San José, behind the old market", restrictionNotes: "Lights off at 21:00.", simultaneousMatchCapacity: 1 },
    pitches: [{ label: "A", usable: true, supportedFormats: ["SOCCER_5V5"] as SoccerFormatKey[], restrictionNotes: "" }],
    dates: [{ date: localDate(Date.now() + 6 * DAY), windows: [{ start: "10:00", end: "14:00" }] }],
  };
}
const propose = (ctx: Ctx, f = facts(), intent: string = randomUUID()) => compRepo.proposePlanAmendment(ctx.competitionId, ctx.organizer.gamingMemberId, intent, f);
const decide = (ctx: Ctx, team: number, digest: string, decision: "CONFIRMED" | "REJECTED") => compRepo.decidePlanAmendment(ctx.competitionId, ctx.teams[team].captain.gamingMemberId, digest, decision);
const withdraw = (ctx: Ctx, digest: string) => compRepo.withdrawPlanAmendment(ctx.competitionId, ctx.organizer.gamingMemberId, digest);
const revisionCount = async (competitionId: string) => (await rawQuery("select count(*)::int n from competition_planning_revisions where competition_id = $1", [competitionId]))[0].n as number;
const statusOfProposal = async (digest: string) => (await rawQuery("select competition_plan_amendment_status_of(a.plan_amendment_id, competition_registration_clock()) as s from competition_plan_change_proposals a where a.amendment_digest = $1", [digest]))[0].s as string;
/** Service-side fixture (the database owner, row triggers off): moves a proposal's creation and expiry into the past, as if the time had really gone by. */
async function age(digest: string, hours: number): Promise<void> {
  const db = new Client({ connectionString: supabaseDbUrl, statement_timeout: 60000 });
  await db.connect();
  try {
    await db.query("set session_replication_role = replica");
    await db.query("update competition_plan_change_proposals set created_at = created_at - ($2 || ' hours')::interval, expires_at = expires_at - ($2 || ' hours')::interval where amendment_digest = $1", [digest, String(hours)]);
  } finally { await db.end().catch(() => {}); }
}
/** The REAL manual publication call (the legacy path): chosen teams and times. The database now refuses it for every competition that has a freeze, a draw or a proposal. */
const manualPublish = (ctx: Ctx, order = [0, 1, 2, 3]) => publishCompetition(compRepo, ctx.competitionId, ctx.organizer.gamingMemberId, ctx.teams[order[0]].teamId, ctx.teams[order[1]].teamId, ctx.teams[order[2]].teamId, ctx.teams[order[3]].teamId,
  new Date(Date.now() + 3600_000).toISOString(), new Date(Date.now() + 7200_000).toISOString(), new Date(Date.now() + 10800_000).toISOString());

/**
 * Publishes the bracket "the OLD way" (the competition leaves READY_TO_PUBLISH and fixtures exist) by a SERVICE-SIDE FIXTURE (UG-CR-GATE-SSS-025). The manual publication now serves
 * only competitions outside the schedule journey - the database refuses it for any competition with a freeze, a draw or a proposal - but a competition that was drawn and then
 * published by hand BEFORE that gate (the manual path was open) is still a real shape, and the draw's refusals after publication have to hold for it. This writes exactly what the
 * manual publication wrote: three fixtures (the semifinals' teams as chosen, the final's slots empty and its sources the semifinals) and the PUBLISHED state with its instant.
 * It carries no publication resolution, as such a competition never had one.
 */
async function publishNow(ctx: Ctx, order = [0, 1, 2, 3]) {
  const team = (i: number) => ctx.teams[order[i]].teamId;
  const insert = async (role: string, hours: number, a: string | null, b: string | null, sa: string | null, sb: string | null) => (await rawQuery(
    "insert into competition_fixtures (competition_id, fixture_role, scheduled_at, team_a_competition_team_id, team_b_competition_team_id, team_a_source_fixture_id, team_b_source_fixture_id, state) values ($1, $2, now() + ($3 || ' hours')::interval, $4, $5, $6, $7, 'SCHEDULED') returning competition_fixture_id",
    [ctx.competitionId, role, String(hours), a, b, sa, sb]))[0].competition_fixture_id as string;
  const sf1 = await insert("SEMIFINAL_1", 1, team(0), team(1), null, null);
  const sf2 = await insert("SEMIFINAL_2", 2, team(2), team(3), null, null);
  const fin = await insert("FINAL", 3, null, null, sf1, sf2);
  const [row] = await rawQuery("update competitions set state = 'PUBLISHED', published_at = now() where competition_id = $1 returning published_at", [ctx.competitionId]);
  return { competitionId: ctx.competitionId, state: "PUBLISHED" as const, publishedAt: (row.published_at as Date).toISOString(), semifinal1FixtureId: sf1, semifinal2FixtureId: sf2, finalFixtureId: fin };
}

const CREATE_SQL = "select create_competition_draw_atomically($1, $2, $3) as r";
const READ_SQL = "select get_competition_draw($1, $2) as r";

// =============================================================================================================================================
// [fixture] control
// =============================================================================================================================================

describe("[fixture] a frozen competition can be built through the public lifecycle (this passes before the feature exists)", () => {
  it("READY_TO_PUBLISH, one freeze of four teams, four distinct captains, no fixture, no draw table row", async () => {
    const ctx = await frozen("Fixture");
    expect((await stateOf(ctx.competitionId)).state).toBe("READY_TO_PUBLISH");
    const frozenTeams = await rawQuery("select captain_gaming_member_id, position, competition_team_id from competition_registration_freeze_teams where competition_id = $1 order by position", [ctx.competitionId]);
    expect(frozenTeams).toHaveLength(4);
    expect(new Set(frozenTeams.map((t) => t.captain_gaming_member_id)).size).toBe(4);
    // The freeze's position is the UUID byte order of the teams (what "canonical input order" means for the draw).
    expect(frozenTeams.map((t) => t.competition_team_id)).toEqual([...frozenTeams.map((t) => t.competition_team_id)].sort());
    expect(await fixtureCount(ctx.competitionId)).toBe(0);
  }, 120000);
});

// =============================================================================================================================================
// [schema] server-only, append-only, internal helpers, and who can call what
// =============================================================================================================================================

describe("[schema] the draw's evidence is server-only and append-only; the helpers are internal; the two operations are service-role only", () => {
  it("[21] both tables exist, have row-level security, no policy, and not even the server role can read or write them directly", async () => {
    const rows = await rawQuery(
      `select c.relname, c.relrowsecurity as rls, (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies,
              has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE') as anon, has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE') as auth,
              has_table_privilege('service_role', c.oid, 'SELECT') as svc_select, has_table_privilege('service_role', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE') as svc_write,
              (select count(*)::int from pg_class k, aclexplode(coalesce(k.relacl, acldefault('r', k.relowner))) a where k.oid = c.oid and a.grantee = 0) as public_grants
         from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname = any($1) order by c.relname`, [[...DRAW_TABLES]]);
    expect(rows.map((r) => r.relname)).toEqual([...DRAW_TABLES].sort());
    for (const r of rows) {
      expect(r.rls, r.relname).toBe(true);
      expect(r.policies, r.relname).toBe(0);
      expect([r.anon, r.auth, r.svc_select, r.svc_write, r.public_grants], r.relname).toEqual([false, false, false, false, 0]);
    }
  });

  it("[21] anon and a signed-in browser client are refused (42501) by both tables, and so is the server role", async () => {
    const person = await newPerson("Draw Table Probe");
    const signedIn = createClient(supabaseUrl, supabaseAnonKey, { global: { headers: { authorization: `Bearer ${await tokenFor(person)}` } }, auth: { persistSession: false, autoRefreshToken: false } });
    for (const table of DRAW_TABLES) {
      for (const client of [anon, signedIn]) {
        expect((await client.from(table).select("*").limit(1)).error?.code, `${table} select`).toBe("42501");
        expect((await client.from(table).insert({}).select()).error?.code, `${table} insert`).toBe("42501");
        expect((await client.from(table).delete().neq("competition_id", randomUUID())).error?.code, `${table} delete`).toBe("42501");
      }
      expect((await service.from(table).select("*").limit(1)).error?.code, `${table} service select`).toBe("42501");
      expect((await service.from(table).insert({}).select()).error?.code, `${table} service insert`).toBe("42501");
    }
  });

  it("[21] UPDATE, DELETE and TRUNCATE are refused by trigger on both tables, even for the database owner (a rolled-back control on real rows)", async () => {
    const ctx = await frozen("Immutable");
    await draw(ctx);
    expect(await drawCount(ctx.competitionId)).toEqual({ draws: 1, entries: 4 });
    for (const table of DRAW_TABLES) {
      for (const statement of [`update ${table} set competition_id = competition_id where competition_id = '${ctx.competitionId}'`, `delete from ${table} where competition_id = '${ctx.competitionId}'`, `truncate table ${table} cascade`]) {
        const v = await violationOf(async (db) => { await db.query(statement); });
        expect(v?.message ?? "no error", `${table}: ${statement}`).toMatch(/COMPETITION_DRAW_IMMUTABLE/);
      }
    }
    expect(await drawCount(ctx.competitionId)).toEqual({ draws: 1, entries: 4 });
  }, 120000);

  it("every internal helper — and every trigger function — exists exactly as listed, is executable by nobody (not PUBLIC, anon, authenticated or service_role) and pins its search_path", async () => {
    const rows = await rawQuery(
      `select p.oid, p.proname, p.oid::regprocedure::text as signature, p.proconfig::text as cfg from pg_proc p
        where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and p.proname ~ '^competition_draw_' order by 2`);
    expect(rows.map((r) => r.proname)).toEqual([...DRAW_HELPERS].sort());
    for (const row of rows) {
      expect(row.cfg, row.signature).toContain("search_path=public");
      for (const role of ["anon", "authenticated", "service_role"]) {
        expect((await rawQuery("select has_function_privilege($1, $2::oid, 'EXECUTE') as ok", [role, row.oid]))[0].ok, `${role} must not execute ${row.signature}`).toBe(false);
      }
      expect((await rawQuery(`select count(*)::int as n from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = $1::oid and a.grantee = 0 and a.privilege_type = 'EXECUTE'`, [row.oid]))[0].n, `PUBLIC must not execute ${row.signature}`).toBe(0);
    }
  });

  it("[8][9] exactly two operations exist, each SECURITY DEFINER with a pinned search_path, executable by the server role alone, and none accepts a seed, team, order, pairing, format or time", async () => {
    const rows = await rawQuery(
      `select p.oid, p.proname, p.prosecdef, p.proconfig::text as cfg, pg_get_function_identity_arguments(p.oid) as args from pg_proc p
        where p.pronamespace = 'public'::regnamespace and p.proname ~ 'competition_draw' and p.proname !~ '^competition_draw_' and p.prokind = 'f' order by p.proname`);
    expect(rows.map((r) => r.proname)).toEqual([...DRAW_RPCS].sort());
    const args = Object.fromEntries(rows.map((r) => [r.proname, r.args]));
    expect(args.create_competition_draw_atomically).toBe("p_competition_id uuid, p_organizer_gaming_member_id uuid, p_intent_id uuid");
    expect(args.get_competition_draw).toBe("p_competition_id uuid, p_caller_gaming_member_id uuid");
    for (const row of rows) {
      expect(row.prosecdef, row.proname).toBe(true);
      expect(row.cfg, row.proname).toContain("search_path=public");
      expect((await rawQuery("select has_function_privilege('service_role', $1::oid, 'EXECUTE') as ok", [row.oid]))[0].ok, row.proname).toBe(true);
      for (const role of ["anon", "authenticated"]) expect((await rawQuery("select has_function_privilege($1, $2::oid, 'EXECUTE') as ok", [role, row.oid]))[0].ok, `${role} must not execute ${row.proname}`).toBe(false);
      expect(String(row.args), row.proname).not.toMatch(/seed|team|order|pairing|format|timestamp|date\b|interval|time\b|index/i);
    }
    const token = await tokenFor(await newPerson("Draw RPC Probe"));
    const signedIn = createClient(supabaseUrl, supabaseAnonKey, { global: { headers: { authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } });
    for (const client of [anon, signedIn]) {
      expect((await client.rpc("get_competition_draw", { p_competition_id: randomUUID(), p_caller_gaming_member_id: randomUUID() })).error?.code).toBe("42501");
      expect((await client.rpc("create_competition_draw_atomically", { p_competition_id: randomUUID(), p_organizer_gaming_member_id: randomUUID(), p_intent_id: randomUUID() })).error?.code).toBe("42501");
    }
  });

  it("[9] a seed, a team list, an order or a pairing cannot be passed even by the server role: the database finds no function with such an argument", async () => {
    const ctx = await frozen("No Client Input");
    for (const extra of [{ p_seed: "ab".repeat(32) }, { p_teams: [randomUUID()] }, { p_order: [randomUUID()] }, { p_pairing: "x" }, { p_permutation_index: 3 }, { p_drawn_at: "2026-01-01T00:00:00Z" }]) {
      const res = await service.rpc("create_competition_draw_atomically", { p_competition_id: ctx.competitionId, p_organizer_gaming_member_id: ctx.organizer.gamingMemberId, p_intent_id: randomUUID(), ...extra });
      expect(res.error?.code, Object.keys(extra)[0]).toBe("PGRST202");
    }
    expect(await drawCount(ctx.competitionId)).toEqual(NO_DRAW);
  }, 120000);

  it("[8] the entropy is the database's alone: only the create operation draws any, from gen_random_uuid(); nothing in the schema uses random(), setseed, tablesample or an extension", async () => {
    const rows = await rawQuery(`select p.proname, p.prosrc, p.provolatile from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname ~ 'competition_draw' order by 1`);
    expect(rows).toHaveLength(DRAW_HELPERS.length + DRAW_RPCS.length);
    for (const row of rows) {
      const source = String(row.prosrc);
      expect(source, row.proname).not.toMatch(/\brandom\s*\(|setseed|tablesample|gen_random_bytes|pgcrypto|uuid_generate|dblink|http_/i);
      const usesEntropy = /gen_random_uuid\(\)/.test(source);
      expect(usesEntropy, `${row.proname} entropy`).toBe(row.proname === "create_competition_draw_atomically");
    }
    // The one source of entropy is PostgreSQL core's own generator. (The Supabase image also carries pgcrypto's namesake in the extensions schema, so the claim is about
    // what the draw's functions RESOLVE: under their pinned search_path - pg_catalog is searched first, pg_temp last - the name is pg_catalog's internal gen_random_uuid.)
    const resolved = await rawTransaction(async (db) => {
      await db.query("set local search_path to public, pg_temp");
      return (await db.query(`select p.pronamespace::regnamespace::text as nsp, l.lanname from pg_proc p join pg_language l on l.oid = p.prolang where p.oid = to_regprocedure('gen_random_uuid()')`)).rows;
    });
    expect(resolved).toEqual([{ nsp: "pg_catalog", lanname: "internal" }]);
    // The pure helpers are deterministic: the same input is always the same answer, so the draw can be reproduced. The four that use only their arguments and core pure
    // functions are IMMUTABLE; the digest is STABLE, as the freeze and amendment digests are (it formats arrays and encodes text).
    for (const row of rows.filter((r) => ["competition_draw_word", "competition_draw_accept_word", "competition_draw_permutation_index", "competition_draw_order"].includes(r.proname))) {
      expect(row.provolatile, row.proname).toBe("i");
    }
    expect(["i", "s"]).toContain(rows.find((r) => r.proname === "competition_draw_digest")!.provolatile);
  });

  it("[10][20][21] the constraints and the deferred verification exist: one draw per competition, positions 1-4, shapes, foreign keys to the freeze, deferrable constraint triggers", async () => {
    const constraints = (await rawQuery(
      `select conrelid::regclass::text as tbl, conname, contype from pg_constraint where conrelid in ('public.competition_draws'::regclass, 'public.competition_draw_entries'::regclass) order by 1, 2`));
    const names = new Set(constraints.map((c) => `${c.tbl}.${c.conname}`));
    for (const expected of [
      "competition_draws.competition_draws_one_per_competition", "competition_draws.competition_draws_intent_key", "competition_draws.competition_draws_freeze_fkey",
      "competition_draws.competition_draws_seed_shape", "competition_draws.competition_draws_index_range", "competition_draws.competition_draws_algorithm",
      "competition_draw_entries.competition_draw_entries_pkey", "competition_draw_entries.competition_draw_entries_team_key", "competition_draw_entries.competition_draw_entries_input_key",
      "competition_draw_entries.competition_draw_entries_frozen_team_fkey", "competition_draw_entries.competition_draw_entries_draw_position", "competition_draw_entries.competition_draw_entries_input_position",
    ]) expect(names, expected).toContain(expected);
    const triggers = await rawQuery(
      `select t.tgname, t.tgrelid::regclass::text as tbl, t.tgdeferrable as deferrable, t.tginitdeferred as deferred, t.tgconstraint <> 0 as is_constraint, (t.tgtype & 2) <> 0 as before_row
         from pg_trigger t where not t.tgisinternal and t.tgrelid in ('public.competition_draws'::regclass, 'public.competition_draw_entries'::regclass)`);
    const verify = triggers.filter((t) => t.is_constraint);
    expect(verify).toHaveLength(2);
    for (const t of verify) expect([t.deferrable, t.deferred], t.tgname).toEqual([true, true]);
    expect(triggers.filter((t) => !t.is_constraint)).toHaveLength(4); // row + truncate, on each table
  });
});

// =============================================================================================================================================
// [algorithm] the SQL implementation against the independent oracle, and against the application's
// =============================================================================================================================================

describe("[15][16][17][19] the algorithm in the database matches the independent oracle exactly", () => {
  it("the first sampled word and the drawn index of every pinned seed vector are what Python computed", async () => {
    for (const v of SEED_VECTORS) {
      const [row] = await rawQuery("select competition_draw_word($1, 0) as w, competition_draw_permutation_index($1) as i", [v.seed]);
      expect([Number(row.w), Number(row.i)], v.seed).toEqual([v.word0, v.index]);
    }
  });

  it("[16] the rejection boundary: 4294967279 is accepted, 4294967280 and everything above it is rejected; nothing below it is", async () => {
    for (const [word, expected] of BOUNDARY) {
      const [row] = await rawQuery("select competition_draw_accept_word($1::bigint) as a", [word]);
      expect(row.a === null ? null : Number(row.a), String(word)).toBe(expected);
    }
  });

  it("[16] a rejected first word advances the counter: the pinned seed's counter-0 word is rejected and counter 1 decides, giving index 5", async () => {
    const [row] = await rawQuery("select competition_draw_word($1, 0) as w0, competition_draw_word($1, 1) as w1, competition_draw_accept_word(competition_draw_word($1, 0)) as a0, competition_draw_permutation_index($1) as i", [REJECTION_SEED]);
    expect([Number(row.w0), Number(row.w1), row.a0, Number(row.i)]).toEqual([4294967282, 270744965, null, 5]);
  });

  it("[15] index i is the i-th permutation in lexicographic order for all 24, so the 24 indexes give 24 distinct, valid orders (every order reachable, none twice)", async () => {
    const oracle = allOrders([...KAT.input]);
    expect(oracle).toHaveLength(24);
    const seen = new Set<string>();
    for (let i = 0; i < 24; i++) {
      const [row] = await rawQuery("select competition_draw_order($1::uuid[], $2) as o", [KAT.input, i]);
      expect(row.o, `index ${i}`).toEqual(oracle[i]);
      expect(new Set(row.o).size).toBe(4);
      seen.add(row.o.join(","));
    }
    expect(seen.size).toBe(24);
  });

  it("[15][16] over 24,000 deterministic seeds the database draws every index with exactly the counts an independent implementation gives", async () => {
    const rows = await rawQuery(
      `select i, count(*)::int n from (select competition_draw_permutation_index(encode(sha256(convert_to(g::text, 'UTF8')), 'hex')) as i from generate_series(1, 24000) g) s group by i order by i`);
    expect(rows.map((r) => Number(r.i))).toEqual(Array.from({ length: 24 }, (_, i) => i));
    expect(rows.map((r) => r.n)).toEqual(UNIFORM_COUNTS);
  });

  it("[19] the digest is the independently computed known answer, and changes with every bound fact", async () => {
    const order = [KAT.input[2], KAT.input[3], KAT.input[0], KAT.input[1]];
    const digest = async (over: Partial<{ c: string; f: string; s: string; i: number; input: string[]; order: string[] }> = {}) =>
      (await rawQuery("select competition_draw_digest($1, $2, $3, $4, $5::uuid[], $6::uuid[]) as d", [over.c ?? KAT.competition, over.f ?? KAT.freezeDigest, over.s ?? KAT.seed, over.i ?? KAT.index, over.input ?? KAT.input, over.order ?? order]))[0].d as string;
    expect(await digest()).toBe(KAT.digest);
    const changed = new Set([KAT.digest]);
    for (const over of [{ c: "11111111-1111-4111-8111-111111111112" }, { f: sha("other") }, { s: SEED_VECTORS[4].seed }, { i: 17 }, { input: [KAT.input[1], KAT.input[0], KAT.input[2], KAT.input[3]] }, { order: [order[1], order[0], order[2], order[3]] }]) {
      changed.add(await digest(over));
    }
    expect(changed.size).toBe(7);
  });

  it("the helpers refuse impossible input: a malformed seed, a counter outside 0..63, an index outside 0..23, anything but four distinct teams", async () => {
    const good = SEED_VECTORS[0].seed;
    for (const [sql, params] of [
      ["select competition_draw_word($1, 0)", ["abc"]], ["select competition_draw_word($1, 0)", [good.toUpperCase().replace(/0/g, "A")]], ["select competition_draw_word($1, 64)", [good]],
      ["select competition_draw_word($1, -1)", [good]], ["select competition_draw_permutation_index($1)", [good.slice(1)]],
      ["select competition_draw_order($1::uuid[], 24)", [KAT.input]], ["select competition_draw_order($1::uuid[], -1)", [KAT.input]],
      ["select competition_draw_order($1::uuid[], 0)", [KAT.input.slice(0, 3)]], ["select competition_draw_order($1::uuid[], 0)", [[KAT.input[0], KAT.input[0], KAT.input[1], KAT.input[2]]]],
    ] as Array<[string, unknown[]]>) {
      const v = await violationOf(async (db) => { await db.query(sql, params); });
      expect(v?.message ?? "no error", sql).toMatch(/COMPETITION_DRAW_INVALID/);
    }
  });

  it("the application's implementation and the database's agree on 300 further seeds (the two are one algorithm)", async () => {
    const { permutationIndexFromSeed } = await loadDraw();
    const seeds = Array.from({ length: 300 }, (_, n) => sha(`parity-${RUN}-${n}`));
    const rows = await rawQuery("select s, competition_draw_permutation_index(s) as i from unnest($1::text[]) s", [seeds]);
    expect(rows).toHaveLength(300);
    for (const row of rows) expect(permutationIndexFromSeed(row.s), row.s).toBe(Number(row.i));
  });
});

// =============================================================================================================================================
// [eligibility] [5] [6] [7]
// =============================================================================================================================================

describe("[5][6] no draw before a valid registration closure and a consistent freeze of exactly four accepted teams", () => {
  async function refusedWith(ctx: Ctx, code: string) {
    const before = await collateralHash(ctx.competitionId);
    await expectRefusal(draw(ctx), code);
    expect(await drawCount(ctx.competitionId)).toEqual(NO_DRAW);
    expect(await collateralHash(ctx.competitionId)).toBe(before);
  }

  it("a DRAFT competition, and a competition whose registration is still open (not frozen), are refused as the wrong state", async () => {
    const draft = await setUp("Draft", { open: false });
    expect((await stateOf(draft.competitionId)).state).toBe("DRAFT");
    await refusedWith(draft, "WRONG_STATE");
    const open = await setUp("Open");
    await fillRosters(open);
    expect((await stateOf(open.competitionId)).state).toBe("TEAM_REGISTRATION_OPEN");
    await refusedWith(open, "WRONG_STATE");
  }, 180000);

  it("a READY_TO_PUBLISH competition WITHOUT a freeze (a competition closed before freezes existed) is refused: the freeze is required", async () => {
    const ctx = await frozen("No Freeze");
    const db = new Client({ connectionString: supabaseDbUrl, statement_timeout: 60000 });
    await db.connect();
    try { // service-side fixture: removes the freeze evidence (append-only for everyone else) to reproduce the legacy shape
      await db.query("set session_replication_role = replica");
      for (const t of ["competition_registration_freeze_members", "competition_registration_freeze_teams", "competition_registration_freezes"]) await db.query(`delete from ${t} where competition_id = $1`, [ctx.competitionId]);
    } finally { await db.end().catch(() => {}); }
    expect((await stateOf(ctx.competitionId)).state).toBe("READY_TO_PUBLISH");
    await refusedWith(ctx, "FREEZE_REQUIRED");
  }, 120000);

  it("a published competition, a cancelled one, a completed one and one with a fixture already present are refused as the wrong state (nothing is drawn after publication)", async () => {
    const published = await frozen("Published");
    await publishNow(published);
    await refusedWith(published, "WRONG_STATE");
    const cancelled = await frozen("Cancelled");
    await cancelCompetition(compRepo, cancelled.competitionId, cancelled.organizer.gamingMemberId, "Closed before the draw was made.");
    await refusedWith(cancelled, "WRONG_STATE");
    const complete = await frozen("Complete");
    await rawQuery("update competitions set state = 'COMPLETE' where competition_id = $1", [complete.competitionId]); // service-side fixture
    await refusedWith(complete, "WRONG_STATE");
    const fixture = await frozen("Stray Fixture");
    await rawQuery( // service-side fixture: a fixture in a READY competition, which no public path can create
      "insert into competition_fixtures (competition_id, fixture_role, scheduled_at, team_a_competition_team_id, team_b_competition_team_id) values ($1, 'SEMIFINAL_1', now() + interval '1 day', $2, $3)",
      [fixture.competitionId, fixture.teams[0].teamId, fixture.teams[1].teamId]);
    await refusedWith(fixture, "WRONG_STATE");
  }, 240000);

  it("[5] the freeze is judged in BOTH directions: the live competition drifting from the freeze, and the frozen evidence drifting from its digest, each refuse the draw", async () => {
    // live -> frozen: a person added to a frozen team after the freeze
    const member = await frozen("Drift Member");
    await rawQuery("insert into competition_team_memberships (competition_id, competition_team_id, gaming_member_id, approved_by_gaming_member_id) values ($1, $2, $3, $4)",
      [member.competitionId, member.teams[0].teamId, pool[POOL_SIZE - 1].gamingMemberId, member.organizer.gamingMemberId]);
    await refusedWith(member, "FREEZE_INCONSISTENT");
    // live -> frozen: a frozen team's captain changed
    const captain = await frozen("Drift Captain");
    await rawQuery("update competition_teams set captain_gaming_member_id = $2 where competition_team_id = $1", [captain.teams[1].teamId, pool[POOL_SIZE - 2].gamingMemberId]);
    await refusedWith(captain, "FREEZE_INCONSISTENT");
    // frozen -> digest: the frozen evidence itself altered (owner, triggers off)
    const evidence = await frozen("Drift Evidence");
    const db = new Client({ connectionString: supabaseDbUrl, statement_timeout: 60000 });
    await db.connect();
    try {
      await db.query("set session_replication_role = replica");
      await db.query("update competition_registration_freeze_teams set captain_gaming_member_id = $2 where competition_id = $1 and position = 1", [evidence.competitionId, pool[POOL_SIZE - 3].gamingMemberId]);
    } finally { await db.end().catch(() => {}); }
    await refusedWith(evidence, "FREEZE_INCONSISTENT");
  }, 240000);

  it("[6] exactly four ACCEPTED teams: three or five live accepted teams refuse the draw", async () => {
    const three = await frozen("Three Teams");
    await rawQuery("update competition_teams set status = 'REJECTED' where competition_team_id = $1", [three.teams[3].teamId]); // service-side fixture
    await refusedWith(three, "FREEZE_INCONSISTENT");
    const five = await frozen("Five Teams");
    await rawQuery("insert into competition_teams (competition_id, name, captain_gaming_member_id) values ($1, $2, $3)", [five.competitionId, `Fifth ${RUN}`, pool[POOL_SIZE - 4].gamingMemberId]); // service-side fixture
    await refusedWith(five, "FREEZE_INCONSISTENT");
  }, 180000);

  it("the plan must still carry what the freeze recorded: a later revision with other roster bounds refuses the draw", async () => {
    const ctx = await frozen("Plan Drift");
    await supersedePlan(ctx.competitionId, (await rawQuery("select registration_deadline_utc from competition_planning_revisions where competition_id = $1 order by revision_number desc limit 1", [ctx.competitionId]))[0].registration_deadline_utc.toISOString(), { rosterMinimum: 6 });
    await refusedWith(ctx, "FREEZE_INCONSISTENT");
  }, 120000);

  it("the refusals are decided in a fixed order — the wrong state, then the freeze, then a pending plan change — and each is atomic (nothing is written)", async () => {
    const both = await frozen("Order Both");
    const p = await propose(both);
    expect(await statusOfProposal(p.digest)).toBe("PENDING");
    await rawQuery("insert into competition_team_memberships (competition_id, competition_team_id, gaming_member_id, approved_by_gaming_member_id) values ($1, $2, $3, $4)",
      [both.competitionId, both.teams[0].teamId, pool[POOL_SIZE - 1].gamingMemberId, both.organizer.gamingMemberId]);
    await refusedWith(both, "FREEZE_INCONSISTENT"); // inconsistent AND pending: the freeze is judged first
    const published = await frozen("Order Published");
    await propose(published);
    await publishNow(published);
    await refusedWith(published, "WRONG_STATE"); // published AND pending: the state is judged first
  }, 180000);
});

describe("[6][7] a plan change that genuinely awaits the captains blocks the draw; one that has ended — however it ended — does not", () => {
  it("[6] a PENDING proposal blocks the draw (even with three of four confirmations in), and writes nothing", async () => {
    const ctx = await frozen("Pending");
    const p = await propose(ctx);
    for (let i = 0; i < 3; i++) await decide(ctx, i, p.digest, "CONFIRMED");
    expect(await statusOfProposal(p.digest)).toBe("PENDING");
    const before = await collateralHash(ctx.competitionId);
    await expectRefusal(draw(ctx), "AMENDMENT_PENDING");
    expect(await drawCount(ctx.competitionId)).toEqual(NO_DRAW);
    expect(await collateralHash(ctx.competitionId)).toBe(before);
  }, 180000);

  it("[7] a REJECTED proposal no longer blocks: one rejection ends it, and the draw can be made", async () => {
    const ctx = await frozen("Rejected");
    const p = await propose(ctx);
    await decide(ctx, 0, p.digest, "CONFIRMED");
    await decide(ctx, 1, p.digest, "REJECTED");
    expect(await statusOfProposal(p.digest)).toBe("REJECTED");
    const result = await draw(ctx);
    expect(result.alreadyDrawn).toBe(false);
    expect(await drawCount(ctx.competitionId)).toEqual({ draws: 1, entries: 4 });
  }, 180000);

  it("[7] a WITHDRAWN proposal no longer blocks", async () => {
    const ctx = await frozen("Withdrawn");
    const p = await propose(ctx);
    await withdraw(ctx, p.digest);
    expect(await statusOfProposal(p.digest)).toBe("WITHDRAWN");
    expect((await draw(ctx)).alreadyDrawn).toBe(false);
  }, 180000);

  it("[7] a SUPERSEDED proposal does not block, but the proposal that superseded it does — until that one ends too", async () => {
    const ctx = await frozen("Superseded");
    const first = await propose(ctx);
    const second = await propose(ctx, facts(`Second Venue ${RUN}`));
    expect(await statusOfProposal(first.digest)).toBe("SUPERSEDED");
    expect(await statusOfProposal(second.digest)).toBe("PENDING");
    await expectRefusal(draw(ctx), "AMENDMENT_PENDING");
    await withdraw(ctx, second.digest);
    expect((await draw(ctx)).alreadyDrawn).toBe(false);
  }, 180000);

  it("[7] an EXPIRED proposal no longer blocks: the database clock alone ends it", async () => {
    const ctx = await frozen("Expired");
    const p = await propose(ctx);
    await age(p.digest, 25);
    expect(await statusOfProposal(p.digest)).toBe("EXPIRED");
    expect((await draw(ctx)).alreadyDrawn).toBe(false);
  }, 180000);

  it("[7] the expiry boundary is exact: one microsecond before expires_at the proposal still blocks; at expires_at it has ended", async () => {
    const ctx = await frozen("Expiry Boundary");
    const p = await propose(ctx);
    const [t] = await rawQuery(
      `select to_char(a.expires_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as at_expiry,
              to_char((a.expires_at - interval '1 microsecond') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') as just_before
         from competition_plan_change_proposals a where a.amendment_digest = $1`, [p.digest]);
    const before = await atInstant(t.just_before, CREATE_SQL, [ctx.competitionId, ctx.organizer.gamingMemberId, randomUUID()]);
    expect(before.ok).toBe(false);
    expect((before as { message: string }).message).toMatch(/COMPETITION_DRAW_AMENDMENT_PENDING/);
    const atExpiry = await atInstant(t.at_expiry, CREATE_SQL, [ctx.competitionId, ctx.organizer.gamingMemberId, randomUUID()]);
    expect(atExpiry.ok, atExpiry.ok ? "" : (atExpiry as { message: string }).message).toBe(true);
    expect(await drawCount(ctx.competitionId)).toEqual(NO_DRAW); // both ran in rolled-back transactions
  }, 180000);

  it("[7] an ACTIVATED proposal does not block, and the draw works on the plan it activated (the preserved facts still match the freeze)", async () => {
    const ctx = await frozen("Activated");
    const revisions = await revisionCount(ctx.competitionId);
    const p = await propose(ctx);
    for (let i = 0; i < 4; i++) await decide(ctx, i, p.digest, "CONFIRMED");
    expect(await statusOfProposal(p.digest)).toBe("ACTIVATED");
    expect(await revisionCount(ctx.competitionId)).toBe(revisions + 1);
    expect((await draw(ctx)).alreadyDrawn).toBe(false);
  }, 180000);
});

// =============================================================================================================================================
// [authority] [2] [3] [4]
// =============================================================================================================================================

describe("[2][3][4] only the competition's own ACTIVE organizer may draw", () => {
  it("[2] the organizer draws; and the draw is recorded as theirs", async () => {
    const ctx = await frozen("Organizer");
    const result = await draw(ctx);
    expect(result.alreadyDrawn).toBe(false);
    const [row] = await drawRows(ctx.competitionId);
    expect(row.drawn_by_gaming_member_id).toBe(ctx.organizer.gamingMemberId);
  }, 120000);

  it("[4] a frozen captain, a registrant, an ordinary member, a member holding only OPERATIONAL authority, another competition's organizer and an unknown member are all refused, and nothing is written", async () => {
    const ctx = await frozen("Authority");
    const other = await frozen("Authority Other");
    const operational = await makeOperator("Operational Only");
    const registrant = await newPerson("Registrant");
    const before = await collateralHash(ctx.competitionId);
    const callers: Array<[string, string]> = [
      ["a frozen captain", ctx.teams[0].captain.gamingMemberId], ["another frozen captain", ctx.teams[3].captain.gamingMemberId], ["a player on a team", ctx.teams[1].members[0]],
      ["a member holding only OPERATIONAL authority", operational.gamingMemberId], ["a member with no role", registrant.gamingMemberId],
      ["another competition's organizer", other.organizer.gamingMemberId], ["an unknown member", randomUUID()],
    ];
    for (const [label, caller] of callers) {
      await expectRejects(compRepo.createCompetitionDraw(ctx.competitionId, caller, randomUUID()), CompetitionAccessDeniedError).then(() => undefined, (e) => { throw new Error(`${label}: ${e.message}`); });
    }
    expect(await drawCount(ctx.competitionId)).toEqual(NO_DRAW);
    expect(await collateralHash(ctx.competitionId)).toBe(before);
    // A missing caller (SQL NULL) is refused too — never skipped (the comparison is null-safe).
    const nullCaller = await atInstant(new Date().toISOString(), CREATE_SQL, [ctx.competitionId, null, randomUUID()]);
    expect(nullCaller.ok).toBe(false);
    expect((nullCaller as { message: string }).message).toMatch(/COMPETITION_ACCESS_DENIED/);
  }, 240000);

  it("an unknown competition is refused as not found", async () => {
    const ctx = await frozen("Unknown");
    await expectRejects(compRepo.createCompetitionDraw(randomUUID(), ctx.organizer.gamingMemberId, randomUUID()), CompetitionNotFoundError);
  }, 120000);

  it("[4] a scorekeeper of the competition's own fixtures has no draw authority either (and cannot read the draw)", async () => {
    const ctx = await frozen("Scorekeeper");
    const result = await draw(ctx);
    await publishNow(ctx); // the OLD publication path, only to create fixtures a scorekeeper can be appointed to
    const fixtures = await compRepo.getCompetitionFixtures(ctx.competitionId);
    const scorekeeper = pool[POOL_SIZE - 5];
    await appointScorekeeper(compRepo, fixtures.find((f) => f.fixtureRole === "SEMIFINAL_1")!.competitionFixtureId, ctx.organizer.gamingMemberId, scorekeeper.gamingMemberId);
    await expectRejects(compRepo.createCompetitionDraw(ctx.competitionId, scorekeeper.gamingMemberId, randomUUID()), CompetitionAccessDeniedError);
    expect(await readDraw(ctx, scorekeeper.gamingMemberId)).toBeNull();
    expect((await readDraw(ctx, ctx.organizer.gamingMemberId))!.draw).toEqual(result.draw);
  }, 240000);

  it("[3] a REVOKED host organizer is refused (and the replay of their own earlier draw too), reads nothing, and the captains keep their read", async () => {
    const { ctx, pilot } = await frozenPilot("Revoked Host");
    const first = await draw(ctx); // active: allowed
    const evidence = await drawEvidenceHash(ctx.competitionId);
    await pilot.revoke();
    await expectRejects(compRepo.createCompetitionDraw(ctx.competitionId, pilot.host.gamingMemberId, randomUUID()), HostAccessRevokedError);
    await expectRejects(compRepo.createCompetitionDraw(ctx.competitionId, pilot.host.gamingMemberId, (await drawRows(ctx.competitionId))[0].intent_id), HostAccessRevokedError); // authority before replay
    expect(await readDraw(ctx, pilot.host.gamingMemberId)).toBeNull();
    expect((await readDraw(ctx, ctx.teams[0].captain.gamingMemberId))!.draw).toEqual(first.draw);
    expect(await drawEvidenceHash(ctx.competitionId)).toBe(evidence);
  }, 300000);

  it("[3] a host revoked BEFORE the draw can never make it: refused, nothing written", async () => {
    const { ctx, pilot } = await frozenPilot("Revoked Before");
    await pilot.revoke();
    await expectRejects(draw(ctx), HostAccessRevokedError);
    expect(await drawCount(ctx.competitionId)).toEqual(NO_DRAW);
  }, 300000);
});

// =============================================================================================================================================
// [the draw] [8] [9] [10] [14] [15] [17] [18]
// =============================================================================================================================================

describe("[8][10][15][17][18][19] the draw: server-side entropy, one permanent record that reproduces itself", () => {
  it("makes a draw whose stored evidence reproduces the result — in the application's implementation AND the database's — and ties it to the freeze", async () => {
    const ctx = await frozen("Evidence");
    const intent = randomUUID();
    const { computeDrawDigest, verifyDraw, permutationIndexFromSeed, DRAW_ALGORITHM_VERSION } = await loadDraw();
    const result = await draw(ctx, intent);
    expect(result.alreadyDrawn).toBe(false);
    const record = result.draw;
    const [d] = await drawRows(ctx.competitionId);
    const [freeze] = await rawQuery("select registration_freeze_id, snapshot_digest from competition_registration_freezes where competition_id = $1", [ctx.competitionId]);
    const frozenTeams = await rawQuery("select competition_team_id, position from competition_registration_freeze_teams where registration_freeze_id = $1 order by position", [freeze.registration_freeze_id]);
    const inputIds = frozenTeams.map((t) => t.competition_team_id as string);
    // the stored row
    expect(d.algorithm_version).toBe(DRAW_ALGORITHM_VERSION);
    expect(d.seed).toMatch(/^[0-9a-f]{64}$/);
    expect(d.permutation_index).toBeGreaterThanOrEqual(0);
    expect(d.permutation_index).toBeLessThanOrEqual(23);
    expect(d.registration_freeze_id).toBe(freeze.registration_freeze_id);
    expect(d.freeze_digest).toBe(freeze.snapshot_digest);
    expect(d.drawn_by_gaming_member_id).toBe(ctx.organizer.gamingMemberId);
    expect(d.intent_id).toBe(intent);
    expect(Math.abs(d.drawn_at.getTime() - Date.now())).toBeLessThan(60_000);
    // four entries: every frozen team exactly once, the input position the freeze's, the draw positions 1..4
    const entries = await entryRows(ctx.competitionId);
    expect(entries.map((e) => e.draw_position)).toEqual([1, 2, 3, 4]);
    expect(new Set(entries.map((e) => e.competition_team_id))).toEqual(new Set(inputIds));
    for (const e of entries) expect(e.input_position).toBe(frozenTeams.find((t) => t.competition_team_id === e.competition_team_id)!.position);
    // the INPUT ORDER is the canonical (byte) order of the team ids, and the drawn order is what the independent lexicographic oracle gives for the stored index
    expect(inputIds).toEqual([...inputIds].sort());
    expect(entries.map((e) => e.competition_team_id)).toEqual(allOrders(inputIds)[d.permutation_index]);
    // the SQL helpers reproduce the stored index and digest from the stored seed; so does the application
    const [sql] = await rawQuery("select competition_draw_permutation_index($1) as i, competition_draw_digest($2, $3, $1, $4, $5::uuid[], $6::uuid[]) as d", [d.seed, ctx.competitionId, d.freeze_digest, d.permutation_index, inputIds, entries.map((e) => e.competition_team_id)]);
    expect(Number(sql.i)).toBe(d.permutation_index);
    expect(sql.d).toBe(d.draw_digest);
    expect(permutationIndexFromSeed(d.seed)).toBe(d.permutation_index);
    expect(computeDrawDigest({ competitionId: ctx.competitionId, freezeDigest: d.freeze_digest, seed: d.seed, permutationIndex: d.permutation_index, inputTeamIds: inputIds, orderTeamIds: entries.map((e) => e.competition_team_id) })).toBe(d.draw_digest);
    // and what the caller was given is exactly that evidence, and verifies on its own
    expect(record.seed).toBe(d.seed);
    expect(record.permutationIndex).toBe(d.permutation_index);
    expect(record.drawDigest).toBe(d.draw_digest);
    expect(record.freezeDigest).toBe(d.freeze_digest);
    expect(record.input.map((t) => t.teamId)).toEqual(inputIds);
    expect(record.order.map((t) => t.teamId)).toEqual(entries.map((e) => e.competition_team_id));
    expect(record.drawnAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/);
    expect(verifyDraw(ctx.competitionId, record)).toEqual({ ok: true });
  }, 120000);

  it("[14][15][18] positions 1-2 meet in Semifinal 1 and positions 3-4 in Semifinal 2, every team exactly once", async () => {
    const ctx = await frozen("Pairing");
    const { publicDraw } = await loadDraw();
    const shown = publicDraw((await draw(ctx)).draw);
    const ids = shown.teams.map((t) => t.teamId);
    expect(shown.semifinals).toEqual([
      { fixtureRole: "SEMIFINAL_1", teamA: expect.objectContaining({ drawPosition: 1, teamId: ids[0] }), teamB: expect.objectContaining({ drawPosition: 2, teamId: ids[1] }) },
      { fixtureRole: "SEMIFINAL_2", teamA: expect.objectContaining({ drawPosition: 3, teamId: ids[2] }), teamB: expect.objectContaining({ drawPosition: 4, teamId: ids[3] }) },
    ]);
    expect(new Set(ids)).toEqual(new Set(ctx.teams.map((t) => t.teamId)));
    expect(ids).toHaveLength(4);
  }, 120000);

  it("[8] the entropy is real and fresh: draws on different competitions have different seeds", async () => {
    const seeds = new Set<string>();
    for (const label of ["Seed A", "Seed B", "Seed C"]) seeds.add((await draw(await frozen(label))).draw.seed);
    expect(seeds.size).toBe(3);
  }, 300000);

  it("[15] the real entropy path reaches every order: 400 draws (each rolled back) give 400 distinct seeds and (all but at most two of) the 24 indexes, with no gross bias", async () => {
    const ctx = await frozen("Entropy");
    const db = new Client({ connectionString: supabaseDbUrl, statement_timeout: 60000 });
    await db.connect();
    const seeds = new Set<string>();
    const counts = new Array(24).fill(0);
    try {
      for (let n = 0; n < 400; n++) {
        await db.query("begin");
        const r = (await db.query(CREATE_SQL, [ctx.competitionId, ctx.organizer.gamingMemberId, randomUUID()])).rows[0].r;
        await db.query("rollback");
        seeds.add(r.draw.seed);
        counts[r.draw.permutation_index] += 1;
      }
    } finally { await db.end().catch(() => {}); }
    expect(seeds.size).toBe(400);
    expect(counts.filter((c) => c > 0).length).toBeGreaterThanOrEqual(22);
    const chiSquare = counts.reduce((s, c) => s + (c - 400 / 24) ** 2 / (400 / 24), 0);
    expect(chiSquare).toBeLessThan(80); // 23 degrees of freedom: a fair draw exceeds this with probability ~1e-8
    expect(await drawCount(ctx.competitionId)).toEqual(NO_DRAW);
  }, 300000);
});

// =============================================================================================================================================
// [replay and conflict] [10] [11] [12] [13]
// =============================================================================================================================================

describe("[10][11][12][13] one permanent draw: an exact replay returns it, anything else is a conflict that changes nothing", () => {
  it("[11] the same intent returns the existing draw, flagged as already drawn, and writes nothing", async () => {
    const ctx = await frozen("Replay");
    const intent = randomUUID();
    const first = await draw(ctx, intent);
    const evidence = await drawEvidenceHash(ctx.competitionId);
    const collateral = await collateralHash(ctx.competitionId);
    for (let i = 0; i < 3; i++) {
      const again = await draw(ctx, intent);
      expect(again.alreadyDrawn).toBe(true);
      expect(again.draw).toEqual(first.draw);
    }
    expect(await drawEvidenceHash(ctx.competitionId)).toBe(evidence);
    expect(await collateralHash(ctx.competitionId)).toBe(collateral);
    expect(await drawCount(ctx.competitionId)).toEqual({ draws: 1, entries: 4 });
  }, 120000);

  it("[12][13] a different intent after the draw is a conflict (ALREADY_DRAWN) and alters no evidence — no reroll, no replacement, no second draw", async () => {
    const ctx = await frozen("Conflict");
    const first = await draw(ctx);
    const evidence = await drawEvidenceHash(ctx.competitionId);
    for (let i = 0; i < 3; i++) await expectRefusal(draw(ctx), "ALREADY_DRAWN");
    expect(await drawEvidenceHash(ctx.competitionId)).toBe(evidence);
    expect(await drawCount(ctx.competitionId)).toEqual({ draws: 1, entries: 4 });
    expect((await readDraw(ctx, ctx.organizer.gamingMemberId))!.draw).toEqual(first.draw);
  }, 120000);

  it("[10][11] there is no way to delete, replace or re-make the draw: not by the operations, not through PostgREST", async () => {
    const ctx = await frozen("Permanent");
    await draw(ctx);
    const evidence = await drawEvidenceHash(ctx.competitionId);
    for (const table of DRAW_TABLES) {
      expect((await service.from(table).delete().eq("competition_id", ctx.competitionId)).error?.code).toBe("42501");
      expect((await service.from(table).update({ competition_id: ctx.competitionId }).eq("competition_id", ctx.competitionId)).error?.code).toBe("42501");
    }
    expect(await drawEvidenceHash(ctx.competitionId)).toBe(evidence);
  }, 120000);

  it("a replay is answered from the record after the competition has moved on (published, cancelled): the same intent still gets the draw; a new one is still ALREADY_DRAWN, not a lifecycle error", async () => {
    const published = await frozen("Replay Published");
    const intent = randomUUID();
    const first = await draw(published, intent);
    await publishNow(published);
    expect((await draw(published, intent)).draw).toEqual(first.draw);
    await expectRefusal(draw(published), "ALREADY_DRAWN");
    const cancelled = await frozen("Replay Cancelled");
    const second = await draw(cancelled, intent);
    await cancelCompetition(compRepo, cancelled.competitionId, cancelled.organizer.gamingMemberId, "Closed after the draw was made.");
    expect((await draw(cancelled, intent)).draw).toEqual(second.draw);
    await expectRefusal(draw(cancelled), "ALREADY_DRAWN");
  }, 240000);

  it("the same intent used on ANOTHER competition is a different draw (the identifier is scoped to its competition)", async () => {
    const intent = randomUUID();
    const a = await draw(await frozen("Scope A"), intent);
    const b = await draw(await frozen("Scope B"), intent);
    expect([a.alreadyDrawn, b.alreadyDrawn]).toEqual([false, false]);
    expect(a.draw.drawDigest).not.toBe(b.draw.drawDigest);
  }, 240000);
});

// =============================================================================================================================================
// [concurrency] [13] [14]
// =============================================================================================================================================

describe("[13][14] concurrency: the competition lock makes exactly one draw", () => {
  it("[13] eight parallel requests with the SAME intent: one creates, seven replay, all see the identical evidence, one row", async () => {
    const ctx = await frozen("Parallel Same");
    const intent = randomUUID();
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => draw(ctx, intent)));
    expect(results.map((r) => r.status)).toEqual(new Array(8).fill("fulfilled"));
    const values = results.map((r) => (r as PromiseFulfilledResult<Awaited<ReturnType<typeof draw>>>).value);
    expect(values.filter((v) => !v.alreadyDrawn)).toHaveLength(1);
    expect(values.filter((v) => v.alreadyDrawn)).toHaveLength(7);
    for (const v of values) expect(v.draw).toEqual(values[0].draw);
    expect(await drawCount(ctx.competitionId)).toEqual({ draws: 1, entries: 4 });
  }, 180000);

  it("[14] eight parallel requests with DISTINCT intents: exactly one wins, the other seven are ALREADY_DRAWN, and the stored intent is the winner's", async () => {
    const ctx = await frozen("Parallel Distinct");
    const intents = Array.from({ length: 8 }, () => randomUUID());
    const results = await Promise.allSettled(intents.map((intent) => draw(ctx, intent)));
    const winners = results.map((r, i) => [r, i] as const).filter(([r]) => r.status === "fulfilled");
    expect(winners).toHaveLength(1);
    const { CompetitionDrawError } = await loadDraw();
    for (const [r] of results.map((r) => [r] as const).filter(([r]) => r.status === "rejected")) {
      const reason = (r as PromiseRejectedResult).reason;
      expect(reason).toBeInstanceOf(CompetitionDrawError);
      expect(reason.code).toBe("ALREADY_DRAWN");
    }
    expect(await drawCount(ctx.competitionId)).toEqual({ draws: 1, entries: 4 });
    expect((await drawRows(ctx.competitionId))[0].intent_id).toBe(intents[winners[0][1]]);
  }, 180000);

  it("the draw waits on the SAME lock every organizer operation takes: while the competition lock is held it does not complete, and when it is released it does", async () => {
    const ctx = await frozen("Lock");
    const holder = new Client({ connectionString: supabaseDbUrl, statement_timeout: 60000 });
    const observer = new Client({ connectionString: supabaseDbUrl, statement_timeout: 60000 });
    await holder.connect();
    await observer.connect();
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtext('competition_scope:' || $1::text))", [ctx.competitionId]);
      let done = false;
      const pending = draw(ctx).then((r) => { done = true; return r; });
      const deadline = Date.now() + 15_000;
      let blocked = false;
      while (Date.now() < deadline && !blocked) {
        const { rows } = await observer.query("select count(*)::int n from pg_stat_activity where wait_event_type = 'Lock' and query ilike '%create_competition_draw_atomically%'");
        blocked = rows[0].n > 0;
        if (!blocked) await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(blocked, "the draw must be observed waiting on a lock").toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(done).toBe(false);
      expect(await drawCount(ctx.competitionId)).toEqual(NO_DRAW);
      await holder.query("commit");
      expect((await pending).alreadyDrawn).toBe(false);
    } finally {
      await holder.query("rollback").catch(() => {});
      await holder.end().catch(() => {});
      await observer.end().catch(() => {});
    }
  }, 120000);
});

// =============================================================================================================================================
// [amendments] [17] [26]
// =============================================================================================================================================

describe("[17][26] a later plan change may change the venue, pitches, dates and windows, but can never alter the draw", () => {
  it("after the draw a proposal can still be made, confirmed by all four captains and activated: the new plan is in force and the draw is byte-identical", async () => {
    const ctx = await frozen("Amend After");
    const made = await draw(ctx);
    const evidence = await drawEvidenceHash(ctx.competitionId);
    const revisions = await revisionCount(ctx.competitionId);
    const p = await propose(ctx, facts(`After The Draw ${RUN}`)); // the amendment window is NOT closed by the draw
    for (let i = 0; i < 4; i++) await decide(ctx, i, p.digest, "CONFIRMED");
    expect(await statusOfProposal(p.digest)).toBe("ACTIVATED");
    expect(await revisionCount(ctx.competitionId)).toBe(revisions + 1);
    expect((await compRepo.getCurrentPlanningRevision(ctx.competitionId))!.venue.name).toBe(`After The Draw ${RUN}`);
    expect(await drawEvidenceHash(ctx.competitionId)).toBe(evidence);
    expect((await readDraw(ctx, ctx.organizer.gamingMemberId))!.draw).toEqual(made.draw);
    expect((await draw(ctx, (await drawRows(ctx.competitionId))[0].intent_id)).draw).toEqual(made.draw); // and a replay still returns it
    expect((await stateOf(ctx.competitionId)).state).toBe("READY_TO_PUBLISH");
  }, 300000);

  it("a proposal that is still pending after the draw does not disturb it either, and a rejected or withdrawn one leaves it untouched", async () => {
    const ctx = await frozen("Amend Pending After");
    const made = await draw(ctx);
    const evidence = await drawEvidenceHash(ctx.competitionId);
    const pending = await propose(ctx);
    expect((await readDraw(ctx, ctx.teams[0].captain.gamingMemberId))!.draw).toEqual(made.draw);
    await decide(ctx, 0, pending.digest, "REJECTED");
    const second = await propose(ctx, facts(`Second ${RUN}`));
    await withdraw(ctx, second.digest);
    expect(await drawEvidenceHash(ctx.competitionId)).toBe(evidence);
    expect((await readDraw(ctx, ctx.organizer.gamingMemberId))!.draw).toEqual(made.draw);
  }, 300000);
});

// =============================================================================================================================================
// [reads] [22] [23]
// =============================================================================================================================================

describe("[22][23] only the active organizer and the four frozen captains can read the draw, and what they read is bounded", () => {
  it("[22] before the draw the organizer is told there is none, and everyone else is told nothing at all", async () => {
    const ctx = await frozen("Read Before");
    expect(await readDraw(ctx, ctx.organizer.gamingMemberId)).toEqual({ draw: null });
    for (const t of ctx.teams) expect(await readDraw(ctx, t.captain.gamingMemberId), "a frozen captain before any draw").toBeNull();
    expect(await readDraw(ctx, randomUUID())).toBeNull();
  }, 120000);

  it("[22] after the draw the organizer and each of the four frozen captains read the identical, bounded evidence", async () => {
    const ctx = await frozen("Read After");
    const made = await draw(ctx);
    const seen = [await readDraw(ctx, ctx.organizer.gamingMemberId), ...(await Promise.all(ctx.teams.map((t) => readDraw(ctx, t.captain.gamingMemberId))))];
    for (const s of seen) expect(s).toEqual({ draw: made.draw });
    // bounded: exactly the evidence — no identifier of a member, the intent, the freeze or the competition, and no word about authority, applications or schedules
    expect(Object.keys(made.draw).sort()).toEqual(["algorithm", "drawDigest", "drawnAt", "freezeDigest", "input", "order", "permutationIndex", "seed"]);
    const text = JSON.stringify(made.draw);
    const [row] = await drawRows(ctx.competitionId);
    const memberIds = [ctx.organizer.gamingMemberId, ...ctx.teams.map((t) => t.captain.gamingMemberId), ...ctx.teams.flatMap((t) => t.members)];
    for (const id of [...memberIds, row.intent_id, row.registration_freeze_id, row.competition_draw_id, ctx.competitionId]) expect(text, id).not.toContain(id);
    expect(text).not.toMatch(/intent|organizer|captain|member|capabilit|application|schedul|pitch|venue|fixture/i);
  }, 120000);

  it("[23] a stranger, an ordinary member, a member holding only OPERATIONAL authority and another competition's organizer are all told nothing (null — a uniform 404)", async () => {
    const ctx = await frozen("Read Strangers");
    const other = await frozen("Read Strangers Other");
    await draw(ctx);
    await draw(other);
    const operational = await makeOperator("Read Operational");
    // (Another competition's captains are not listed: the pool is shared, so they are THIS competition's frozen captains too.)
    for (const [label, who] of [["an operational-only member", operational.gamingMemberId], ["a member with no role", pool[POOL_SIZE - 6].gamingMemberId],
      ["another competition's organizer", other.organizer.gamingMemberId], ["an unknown member", randomUUID()]] as const) {
      expect(await readDraw(ctx, who), label).toBeNull();
    }
    expect(await compRepo.getCompetitionDraw(randomUUID(), ctx.organizer.gamingMemberId)).toBeNull();
    // SQL NULL caller
    const nullCaller = await atInstant(new Date().toISOString(), READ_SQL, [ctx.competitionId, null]);
    expect(nullCaller.ok).toBe(true);
    expect((nullCaller as unknown as { rows: Array<{ r: unknown }> }).rows[0].r).toBeNull();
  }, 240000);

  it("[22] a captain needs CURRENT access: once they are no longer the live captain of their frozen team, they read nothing — and the new captain, who was never frozen, reads nothing either", async () => {
    const ctx = await frozen("Read Current");
    await draw(ctx);
    expect(await readDraw(ctx, ctx.teams[2].captain.gamingMemberId)).not.toBeNull();
    const replacement = pool[POOL_SIZE - 7];
    await rawQuery("update competition_teams set captain_gaming_member_id = $2 where competition_team_id = $1", [ctx.teams[2].teamId, replacement.gamingMemberId]); // service-side fixture
    expect(await readDraw(ctx, ctx.teams[2].captain.gamingMemberId)).toBeNull();
    expect(await readDraw(ctx, replacement.gamingMemberId)).toBeNull();
    expect(await readDraw(ctx, ctx.teams[0].captain.gamingMemberId)).not.toBeNull();
  }, 180000);
});

// =============================================================================================================================================
// [tamper] [19] [20] [21]
// =============================================================================================================================================

describe("[20][21] evidence that does not reproduce itself is refused at commit; recorded evidence cannot be changed", () => {
  interface Forged { seed?: string; index?: number; order?: string[]; digest?: string; freezeDigest?: string; drawnBy?: string; algorithm?: string; entries?: Array<[number, number, string]>; competitionId?: string; freezeId?: string }

  /** Inserts a draw and its four entries directly, as the database owner, from the SQL helpers — every field overridable. With no override it is exactly what the operation would write. */
  async function forge(db: Client, ctx: Ctx, over: Forged = {}) {
    const freeze = (await db.query("select registration_freeze_id, snapshot_digest from competition_registration_freezes where competition_id = $1", [ctx.competitionId])).rows[0];
    const input: string[] = (await db.query("select competition_team_id from competition_registration_freeze_teams where registration_freeze_id = $1 order by position", [freeze.registration_freeze_id])).rows.map((r) => r.competition_team_id);
    const seed = over.seed ?? SEED_VECTORS[0].seed;
    const index = over.index ?? Number((await db.query("select competition_draw_permutation_index($1) as i", [seed])).rows[0].i);
    const order: string[] = over.order ?? (await db.query("select competition_draw_order($1::uuid[], $2) as o", [input, index])).rows[0].o;
    const freezeDigest = over.freezeDigest ?? freeze.snapshot_digest;
    const digest = over.digest ?? (await db.query("select competition_draw_digest($1, $2, $3, $4, $5::uuid[], $6::uuid[]) as d", [ctx.competitionId, freezeDigest, seed, index, input, order])).rows[0].d;
    const drawId = randomUUID();
    await db.query(
      `insert into competition_draws (competition_draw_id, competition_id, registration_freeze_id, freeze_digest, algorithm_version, seed, permutation_index, drawn_by_gaming_member_id, intent_id, drawn_at, draw_digest)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now(), $10)`,
      [drawId, over.competitionId ?? ctx.competitionId, over.freezeId ?? freeze.registration_freeze_id, freezeDigest, over.algorithm ?? "URBANO-DRAW-PERMUTATION-V1", seed, index, over.drawnBy ?? ctx.organizer.gamingMemberId, randomUUID(), digest]);
    const entries = over.entries ?? order.map((team, i) => [i + 1, input.indexOf(team) + 1, team] as [number, number, string]);
    for (const [position, inputPosition, team] of entries) {
      await db.query("insert into competition_draw_entries (competition_draw_id, competition_id, registration_freeze_id, draw_position, input_position, competition_team_id) values ($1, $2, $3, $4, $5, $6)",
        [drawId, ctx.competitionId, freeze.registration_freeze_id, position, inputPosition, team]);
    }
  }

  it("the control: a draw forged with every field exactly right IS accepted — so each refusal below is for the one thing that was made wrong", async () => {
    const ctx = await frozen("Forge Control");
    expect(await violationOf((db) => forge(db, ctx))).toBeNull();
  }, 120000);

  it("[20] a wrong permutation index, a wrong order, a wrong digest, a wrong freeze digest and a wrong actor are each refused when the transaction commits", async () => {
    const ctx = await frozen("Forge Wrong");
    const [seed0, seed1] = [SEED_VECTORS[0].seed, SEED_VECTORS[4].seed]; // indexes 5 and 20
    const input: string[] = (await rawQuery("select competition_team_id from competition_registration_freeze_teams where competition_id = $1 order by position", [ctx.competitionId])).map((r) => r.competition_team_id);
    const cases: Array<[string, Forged]> = [
      ["an index that does not follow from the seed", { seed: seed0, index: 6 }],
      ["a seed that does not give the index", { seed: seed1, index: 5 }],
      ["an order that does not follow from the index", { seed: seed0, index: 5, order: allOrders(input)[6] }],
      ["a digest that is not the digest of the evidence", { digest: sha("forged") }],
      ["a freeze digest that is not the freeze's", { freezeDigest: sha("forged freeze") }],
      ["a draw attributed to someone who is not the organizer", { drawnBy: ctx.teams[0].captain.gamingMemberId }],
    ];
    for (const [label, over] of cases) {
      const v = await violationOf((db) => forge(db, ctx, over));
      expect(v?.message ?? "no error", label).toMatch(/COMPETITION_DRAW_INVALID/);
    }
  }, 180000);

  it("[20] entries that are not exactly the four frozen teams in a consistent order are refused: missing, a team twice, a stranger, a wrong input position", async () => {
    const ctx = await frozen("Forge Entries");
    const input: string[] = (await rawQuery("select competition_team_id from competition_registration_freeze_teams where competition_id = $1 order by position", [ctx.competitionId])).map((r) => r.competition_team_id);
    const order = allOrders(input)[5];
    const asEntries = (teams: string[]) => teams.map((team, i) => [i + 1, input.indexOf(team) + 1, team] as [number, number, string]);
    const stranger = (await rawQuery("select competition_team_id from competition_teams where competition_id <> $1 limit 1", [ctx.competitionId]))[0].competition_team_id as string;
    const withSeed = { seed: SEED_VECTORS[0].seed, index: 5 };
    const swapped = asEntries(order);
    [swapped[0][1], swapped[1][1]] = [swapped[1][1], swapped[0][1]]; // the first two entries name each other's frozen position
    const wrongInput = swapped;
    const cases: Array<[string, Forged, RegExp]> = [
      ["no entries at all", { ...withSeed, entries: [] }, /COMPETITION_DRAW_INVALID/],
      ["three entries", { ...withSeed, entries: asEntries(order).slice(0, 3) }, /COMPETITION_DRAW_INVALID/],
      ["a team twice", { ...withSeed, entries: [[1, 1, input[0]], [2, 1, input[0]], [3, 3, input[2]], [4, 4, input[3]]] }, /duplicate key|unique/i],
      ["a team that is not frozen", { ...withSeed, entries: asEntries(order).map(([p, i, t], n) => (n === 3 ? [p, i, stranger] : [p, i, t]) as [number, number, string]) }, /foreign key|violates/i],
      ["a wrong input position", { ...withSeed, entries: wrongInput }, /COMPETITION_DRAW_INVALID/],
      ["a fifth position", { ...withSeed, entries: [...asEntries(order), [5, 1, input[0]]] }, /check constraint|violates/i],
      ["position 0", { ...withSeed, entries: asEntries(order).map(([p, i, t], n) => (n === 0 ? [0, i, t] : [p, i, t]) as [number, number, string]) }, /check constraint|violates/i],
    ];
    for (const [label, over, expected] of cases) {
      const v = await violationOf((db) => forge(db, ctx, over));
      expect(v?.message ?? "no error", label).toMatch(expected);
    }
  }, 180000);

  it("a malformed seed, an index outside 0-23, an unknown algorithm version and a malformed digest are refused by constraint; a second draw for the competition is refused; another competition's freeze is refused", async () => {
    const ctx = await frozen("Forge Shape");
    const other = await frozen("Forge Shape Other");
    const input: string[] = (await rawQuery("select competition_team_id from competition_registration_freeze_teams where competition_id = $1 order by position", [ctx.competitionId])).map((r) => r.competition_team_id);
    const given = { order: allOrders(input)[5], digest: sha("a digest of the right shape") }; // every field explicit: no helper may reject the input first
    const cases: Array<[string, Forged, string]> = [
      ["an uppercase seed", { ...given, seed: SEED_VECTORS[0].seed.replace(/0/g, "A"), index: 5 }, "competition_draws_seed_shape"],
      ["an index of 24", { ...given, index: 24 }, "competition_draws_index_range"],
      ["an unknown algorithm version", { algorithm: "URBANO-DRAW-PERMUTATION-V0" }, "competition_draws_algorithm"],
      ["a malformed digest", { digest: "not-a-digest" }, "competition_draws_digest_shape"],
    ];
    for (const [label, over, constraint] of cases) {
      const v = await violationOf((db) => forge(db, ctx, over));
      expect(v?.constraint ?? v?.message ?? "no error", label).toBe(constraint);
    }
    const foreignFreeze = (await rawQuery("select registration_freeze_id from competition_registration_freezes where competition_id = $1", [other.competitionId]))[0].registration_freeze_id as string;
    expect((await violationOf((db) => forge(db, ctx, { freezeId: foreignFreeze })))?.code, "another competition's freeze").toBe("23503");
    await draw(ctx);
    expect((await violationOf((db) => forge(db, ctx)))?.constraint, "a second draw").toBe("competition_draws_one_per_competition");
    expect(await drawCount(ctx.competitionId)).toEqual({ draws: 1, entries: 4 });
  }, 240000);
});

// =============================================================================================================================================
// [collateral] [24] [25] [27] [28]
// =============================================================================================================================================

describe("[18][24][25][27] the draw creates no fixture, publishes nothing, changes no state and changes nothing else the competition carries", () => {
  it("everything else — the competition row, teams, memberships, registrations, freeze, plan revisions, plan changes, host capability — is byte-identical before and after the draw", async () => {
    const ctx = await frozen("Collateral");
    const before = await collateralHash(ctx.competitionId);
    expect(await fixtureCount(ctx.competitionId)).toBe(0);
    await draw(ctx);
    expect(await collateralHash(ctx.competitionId)).toBe(before);
    expect(await fixtureCount(ctx.competitionId)).toBe(0);
    expect(await stateOf(ctx.competitionId)).toEqual({ state: "READY_TO_PUBLISH", published_at: null });
  }, 120000);

  it("[27] discovery and the addressed view are unchanged: the same listing entry, and the same view for the organizer, a captain and a stranger", async () => {
    const ctx = await frozen("Discovery");
    const stranger = pool[POOL_SIZE - 8].gamingMemberId;
    const listing = async () => JSON.stringify((await compRepo.listCompetitions()).find((c) => c.competitionId === ctx.competitionId));
    const views = async () => JSON.stringify(await Promise.all([ctx.organizer.gamingMemberId, ctx.teams[0].captain.gamingMemberId, stranger].map((id) => getCompetitionView(compRepo, ctx.competitionId, id))));
    const [listBefore, viewsBefore] = [await listing(), await views()];
    expect(listBefore).toContain(ctx.competitionId);
    await draw(ctx);
    expect(await listing()).toBe(listBefore);
    expect(await views()).toBe(viewsBefore);
    // The view carries no draw evidence under any key (the word may appear in a competition's NAME, which is a value, never a key).
    expect(viewsBefore + (await views())).not.toMatch(/"(seed|permutationIndex|drawDigest|freezeDigest|inputOrder|semifinals|draw|drawn[A-Za-z]*)"\s*:/);
  }, 180000);

  it("[28] no format other than five-a-side becomes creatable: 6v6, 7v7 and 8v8 are still refused by the creation operation, and the registry is unchanged", async () => {
    const operator = await makeOperator("Format Probe");
    for (const format of ["SOCCER_6V6", "SOCCER_7V7", "SOCCER_8V8"]) {
      await expectRejects(createCompetition(compRepo, operator.gamingMemberId, `Format ${format} ${RUN}`, format), UnsupportedActivityKeyError);
    }
    const rules = await rawQuery("select format_key from competition_format_rules order by format_key");
    expect(rules.map((r) => r.format_key)).toEqual(["SOCCER_5V5", "SOCCER_6V6", "SOCCER_7V7", "SOCCER_8V8"]);
  }, 120000);

  it("[closed by UG-CR-GATE-SSS-025] the draw is now binding on publication: the manual publication is REFUSED for a drawn competition — whatever pairing it is sent, the drawn one included — and the draw stays exactly as it was", async () => {
    const ctx = await frozen("Binding");
    const made = await draw(ctx);
    const evidence = await drawEvidenceHash(ctx.competitionId);
    const drawnOrder = made.draw.order.map((t) => t.teamId);
    const byId = (id: string) => ctx.teams.findIndex((t) => t.teamId === id);
    // a pairing that is NOT the drawn one (the first and the last team of the draw meet in Semifinal 1), and the drawn pairing itself: neither may be sent by hand
    for (const order of [[byId(drawnOrder[0]), byId(drawnOrder[3]), byId(drawnOrder[1]), byId(drawnOrder[2])], [byId(drawnOrder[0]), byId(drawnOrder[1]), byId(drawnOrder[2]), byId(drawnOrder[3])]]) {
      await expect(manualPublish(ctx, order)).rejects.toMatchObject({ code: "SCHEDULE_PROPOSAL_PUBLICATION_REQUIRED" });
    }
    expect((await stateOf(ctx.competitionId)).state).toBe("READY_TO_PUBLISH");
    expect(await fixtureCount(ctx.competitionId)).toBe(0);
    expect(await drawEvidenceHash(ctx.competitionId)).toBe(evidence);
    expect((await readDraw(ctx, ctx.organizer.gamingMemberId))!.draw).toEqual(made.draw);
  }, 240000);
});

// =============================================================================================================================================
// [routes] end to end, with real tokens against the real database
// =============================================================================================================================================

describe("the real route, with real tokens: 401, 503, the uniform 404, 201 / 200 / 409, the bounded body", () => {
  it("POST: the organizer's draw is a 201, an exact replay a 200, a different intent a 409 ALREADY_DRAWN — and the bodies are exactly the bounded draw", async () => {
    const ctx = await frozen("Route Organizer");
    const { POST } = await loadRoute();
    const { publicDraw } = await loadDraw();
    const token = await tokenFor(ctx.organizer);
    const intent = randomUUID();
    const created = await POST(request(`${COMP}/${ctx.competitionId}/draw`, "POST", token, { intentId: intent }), ctxOf(ctx.competitionId));
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toMatch(/no-store/);
    const body = await created.json();
    expect(Object.keys(body).sort()).toEqual(["alreadyDrawn", "draw"]);
    expect(body.alreadyDrawn).toBe(false);
    expect(Object.keys(body.draw).sort()).toEqual(["algorithm", "drawDigest", "drawnAt", "freezeDigest", "inputOrder", "permutationIndex", "seed", "semifinals", "teams"]);
    const replay = await POST(request(`${COMP}/${ctx.competitionId}/draw`, "POST", token, { intentId: intent }), ctxOf(ctx.competitionId));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ draw: body.draw, alreadyDrawn: true });
    const conflict = await POST(request(`${COMP}/${ctx.competitionId}/draw`, "POST", token, { intentId: randomUUID() }), ctxOf(ctx.competitionId));
    expect(conflict.status).toBe(409);
    expect((await conflict.json()).code).toBe("ALREADY_DRAWN");
    expect(body.draw).toEqual(publicDraw((await readDraw(ctx, ctx.organizer.gamingMemberId))!.draw!));
    expect(await drawCount(ctx.competitionId)).toEqual({ draws: 1, entries: 4 });
  }, 180000);

  it("POST: the lifecycle refusals are 409 with their stable codes, and nothing is written", async () => {
    const { POST } = await loadRoute();
    const fresh = await setUp("Route Open");
    await fillRosters(fresh);
    const res = await POST(request(`${COMP}/${fresh.competitionId}/draw`, "POST", await tokenFor(fresh.organizer), { intentId: randomUUID() }), ctxOf(fresh.competitionId));
    expect([res.status, (await res.json()).code]).toEqual([409, "WRONG_STATE"]);
    const pending = await frozen("Route Pending");
    await propose(pending);
    const blocked = await POST(request(`${COMP}/${pending.competitionId}/draw`, "POST", await tokenFor(pending.organizer), { intentId: randomUUID() }), ctxOf(pending.competitionId));
    expect([blocked.status, (await blocked.json()).code]).toEqual([409, "AMENDMENT_PENDING"]);
    expect(await drawCount(fresh.competitionId)).toEqual(NO_DRAW);
    expect(await drawCount(pending.competitionId)).toEqual(NO_DRAW);
  }, 240000);

  it("POST: a captain, a stranger, an operational-only member and an unknown competition all get the same 404 — and no draw is made", async () => {
    const ctx = await frozen("Route Strangers");
    const { POST } = await loadRoute();
    const operational = await makeOperator("Route Operational");
    const stranger = await newPerson("Route Stranger");
    const answers: Array<[number, string]> = [];
    for (const [who, id] of [[ctx.teams[0].captain, ctx.competitionId], [operational, ctx.competitionId], [stranger, ctx.competitionId], [ctx.organizer, randomUUID()]] as const) {
      const res = await POST(request(`${COMP}/${id}/draw`, "POST", await tokenFor(who), { intentId: randomUUID() }), ctxOf(id));
      answers.push([res.status, await res.text()]);
      expect(res.headers.get("cache-control")).toMatch(/no-store/);
    }
    expect(new Set(answers.map((a) => a[0]))).toEqual(new Set([404]));
    expect(new Set(answers.map((a) => a[1])).size).toBe(1);
    expect(await drawCount(ctx.competitionId)).toEqual(NO_DRAW);
  }, 240000);

  it("POST: every field a client could use to influence the draw is a 400, and nothing is drawn", async () => {
    const ctx = await frozen("Route Body");
    const { POST } = await loadRoute();
    const token = await tokenFor(ctx.organizer);
    for (const extra of [{ seed: "ab".repeat(32) }, { teams: [ctx.teams[0].teamId] }, { order: [1, 2, 3, 4] }, { pairing: "x" }, { format: "SOCCER_5V5" }, { organizerGamingMemberId: ctx.organizer.gamingMemberId }, { reroll: true }]) {
      const res = await POST(request(`${COMP}/${ctx.competitionId}/draw`, "POST", token, { intentId: randomUUID(), ...extra }), ctxOf(ctx.competitionId));
      expect(res.status, Object.keys(extra)[0]).toBe(400);
    }
    expect((await POST(request(`${COMP}/${ctx.competitionId}/draw`, "POST", token, {}), ctxOf(ctx.competitionId))).status).toBe(400);
    expect(await drawCount(ctx.competitionId)).toEqual(NO_DRAW);
  }, 180000);

  it("401 without a token, 503 with the schema not ready — each answered before anything else, and uncached", async () => {
    const ctx = await frozen("Route Gates");
    const { GET, POST } = await loadRoute();
    const bare = (method: string) => new Request(`${COMP}/${ctx.competitionId}/draw`, { method, headers: { "content-type": "application/json" }, body: method === "POST" ? JSON.stringify({ intentId: randomUUID() }) : undefined });
    for (const [method, handler] of [["GET", GET], ["POST", POST]] as const) {
      const res = await handler(bare(method), ctxOf(ctx.competitionId));
      expect(res.status, method).toBe(401);
      expect(res.headers.get("cache-control")).toMatch(/no-store/);
    }
    const token = await tokenFor(ctx.organizer);
    const previous = process.env.COMPETITIONS_SCHEMA_READY;
    try {
      for (const value of [undefined, "false", "TRUE"]) {
        if (value === undefined) delete process.env.COMPETITIONS_SCHEMA_READY; else process.env.COMPETITIONS_SCHEMA_READY = value;
        for (const [method, handler] of [["GET", GET], ["POST", POST]] as const) {
          const res = await handler(request(`${COMP}/${ctx.competitionId}/draw`, method, token, method === "POST" ? { intentId: randomUUID() } : undefined), ctxOf(ctx.competitionId));
          expect([method, res.status]).toEqual([method, 503]);
          expect(res.headers.get("cache-control")).toMatch(/no-store/);
        }
      }
    } finally {
      process.env.COMPETITIONS_SCHEMA_READY = previous;
    }
    expect(await drawCount(ctx.competitionId)).toEqual(NO_DRAW);
  }, 180000);

  it("GET: the organizer before the draw gets { draw: null }; after it, the organizer and a frozen captain get the draw; everyone else the one identical 404", async () => {
    const ctx = await frozen("Route Read");
    const { GET, POST } = await loadRoute();
    const organizerToken = await tokenFor(ctx.organizer);
    const captainToken = await tokenFor(ctx.teams[1].captain);
    const strangerToken = await tokenFor(await newPerson("Route Read Stranger"));
    const url = `${COMP}/${ctx.competitionId}/draw`;
    const before = await GET(request(url, "GET", organizerToken), ctxOf(ctx.competitionId));
    expect([before.status, await before.json()]).toEqual([200, { draw: null }]);
    const captainBefore = await GET(request(url, "GET", captainToken), ctxOf(ctx.competitionId));
    const strangerBefore = await GET(request(url, "GET", strangerToken), ctxOf(ctx.competitionId));
    expect([captainBefore.status, strangerBefore.status]).toEqual([404, 404]);
    const strangerBeforeText = await strangerBefore.text();
    expect(await captainBefore.text()).toBe(strangerBeforeText);
    const created = await (await POST(request(url, "POST", organizerToken, { intentId: randomUUID() }), ctxOf(ctx.competitionId))).json();
    for (const token of [organizerToken, captainToken]) {
      const res = await GET(request(url, "GET", token), ctxOf(ctx.competitionId));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toMatch(/no-store/);
      expect(await res.json()).toEqual({ draw: created.draw });
    }
    const stranger = await GET(request(url, "GET", strangerToken), ctxOf(ctx.competitionId));
    expect(stranger.status).toBe(404);
    expect(await stranger.text()).toBe(strangerBeforeText);
  }, 240000);
});
