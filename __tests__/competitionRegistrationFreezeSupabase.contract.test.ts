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
import { proposeCompetitionTeam } from "../lib/gaming/competitions/proposeCompetitionTeam";
import { decideCompetitionTeam } from "../lib/gaming/competitions/decideCompetitionTeam";
import { registerForCompetition } from "../lib/gaming/competitions/registerForCompetition";
import { requestJoinTeam } from "../lib/gaming/competitions/requestJoinTeam";
import { decideJoinRequest } from "../lib/gaming/competitions/decideJoinRequest";
import { organizerReviewJoinRequest } from "../lib/gaming/competitions/organizerReviewJoinRequest";
import { publishCompetition } from "../lib/gaming/competitions/publishCompetition";
import { cancelCompetition } from "../lib/gaming/competitions/cancelCompetition";
import { declareRoster } from "../lib/gaming/competitions/declareRoster";
import { getCompetitionView } from "../lib/gaming/competitions/getCompetitionView";
import {
  CompetitionAccessDeniedError, CompetitionNotFoundError, CompetitionNotDraftError, HostAccessRevokedError, NotTeamCaptainError,
  TeamRegistrationNotOpenError, TeamRegistrationCapacityNotReachedError, UnsupportedActivityKeyError,
} from "../lib/gaming/competitions/types";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";
// The REAL route handlers, called with real user access tokens against the real local database.
import { POST as hostCreateRoute } from "../app/api/gaming/host/competition/route";
import { POST as registerRoute } from "../app/api/gaming/competitions/[competitionId]/register/route";
import { POST as closeRoute } from "../app/api/gaming/competitions/[competitionId]/close-team-registration/route";
import { POST as openRoute } from "../app/api/gaming/competitions/[competitionId]/open-team-registration/route";
import { GET as viewRoute } from "../app/api/gaming/competitions/[competitionId]/route";
import { GET as listRoute, POST as generalCreateRoute } from "../app/api/gaming/competitions/route";

/**
 * UG-CR-GATE-SSS-007 — Registration Deadline and Competition Freeze Foundation, against a real (disposable, loopback-only) Postgres.
 *
 * Proves, in the database itself: the authoritative deadline is the UTC instant of the CURRENT Organizer Planning revision, judged by the
 * database clock inside each atomic operation (no cron, no client time, no cached UI state); registration cannot open without a usable plan;
 * a new registration, organizer-added team, member-proposed team and team-join request are refused at and after the deadline; work received
 * before the deadline can still be decided afterwards (and work stamped at or after it never can); the close operation is the one atomic,
 * append-only, server-only freeze; an exact retry returns the existing freeze; nothing that changes membership works afterwards; and
 * no draw, fixture or schedule is created.
 *
 * CLOCK. The decision instant comes from one internal function, competition_registration_clock(), whose body is clock_timestamp(). Nobody
 * but the database owner can call or redefine it; this file redefines it ONLY inside transactions it rolls back, to put the database clock on
 * an exact instant (one microsecond before the deadline, exactly on it, after it). Nothing public changes the clock and production reads no
 * setting or table to decide it. The straddle test uses the real clock and a real minute boundary.
 *
 * Rosters of other formats, and an extra accepted team, are BOUNDED SERVICE-SIDE CONTRACT FIXTURES (rows written as the database owner, as in
 * the format-foundation suite). No public creation path is used or widened.
 */

const env = loadEnv("development", process.cwd(), "");
const supabaseUrl = env.SUPABASE_URL;
requireLocalSupabase(supabaseUrl);
const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAnonKey = env.SUPABASE_ANON_KEY;
if (!supabaseUrl || !supabaseServiceRoleKey || !supabaseAnonKey) {
  throw new Error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are required for contract tests.");
}
// Raw pg runs the rolled-back clock seam, the fixtures and the catalog checks. The URL is supplied explicitly, never read from .env.local, and must be loopback.
const supabaseDbUrl = process.env.COMPETITIONS_LOCAL_DB_URL ?? "";
if (!/^postgresql:\/\/[^@]+@(127\.0\.0\.1|localhost|\[::1\]):\d+\//.test(supabaseDbUrl)) {
  throw new Error("COMPETITIONS_LOCAL_DB_URL must be set to a loopback Postgres URL for the registration-freeze contract tests.");
}

const compRepo = new SupabaseCompetitionsRepository(supabaseUrl, supabaseServiceRoleKey);
const hostRepo = new SupabaseHostRepository(supabaseUrl, supabaseServiceRoleKey);
const gamingRepo = new SupabaseGamingRepository(supabaseUrl, supabaseServiceRoleKey);
const service = createClient(supabaseUrl, supabaseServiceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
const anon = createClient(supabaseUrl, supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false } });

const RUN = randomUUID().slice(0, 8);
const DAY = 24 * 3600_000;
const FORMATS = ["SOCCER_5V5", "SOCCER_6V6", "SOCCER_7V7", "SOCCER_8V8"] as const;
type Format = (typeof FORMATS)[number];
/** The registry's roster ranges (competition_format_rules), the ones a plan may configure within. */
const RANGES: Record<Format, { minLow: number; minHigh: number; maxLow: number; maxHigh: number }> = {
  SOCCER_5V5: { minLow: 5, minHigh: 8, maxLow: 5, maxHigh: 10 },
  SOCCER_6V6: { minLow: 6, minHigh: 10, maxLow: 6, maxHigh: 12 },
  SOCCER_7V7: { minLow: 7, minHigh: 12, maxLow: 7, maxHigh: 14 },
  SOCCER_8V8: { minLow: 8, minHigh: 14, maxLow: 8, maxHigh: 16 },
};
const NINE = [
  "open_team_registration_atomically", "register_for_competition_atomically", "add_competition_team_atomically", "propose_competition_team_atomically",
  "request_join_competition_team_atomically", "decide_competition_team_atomically", "decide_join_request_atomically",
  "organizer_review_join_request_atomically", "close_team_registration_atomically",
] as const;
const FREEZE_TABLES = ["competition_registration_freezes", "competition_registration_freeze_teams", "competition_registration_freeze_members"] as const;
const INTERNAL_HELPERS = [
  "competition_registration_clock()", "competition_registration_deadline_reached(timestamptz, timestamptz)", "competition_current_registration_plan(uuid)",
  "competition_registration_frozen(uuid)", "competition_assert_registration_intake_open(uuid)", "competition_assert_registration_decision_allowed(uuid, text, timestamptz)",
  "competition_registration_freeze_digest(uuid, uuid, text, integer, integer, timestamptz, jsonb)",
  "competition_registration_plan_usable(text, text, integer, integer, timestamptz)",
] as const;

// Loaded lazily: until the module exists, only the tests that need it can fail.
const loadFreeze = () => import("../lib/gaming/competitions/registrationFreeze");
const loadPlanning = () => import("../lib/gaming/competitions/planning");

// ---------------------------------------------------------------------------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------------------------------------------------------------------------

interface Person { authUserId: string; gamingMemberId: string; email: string }
const authUsers: string[] = [];
const operators: string[] = [];
const competitionIds: string[] = [];
let counter = 0;

async function newPerson(label: string): Promise<Person> {
  const email = `freeze-${RUN}-${counter++}@example.com`;
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
const POOL_SIZE = 44;
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

/** Runs one statement inside a transaction that is always rolled back, and returns the database error it raised (or null). */
async function violation(statement: string, params: unknown[] = []): Promise<{ code?: string; constraint?: string; message: string } | null> {
  return rawTransaction(async (db) => {
    try {
      await db.query(statement, params);
      return null;
    } catch (err) {
      const e = err as { code?: string; constraint?: string; message?: string };
      return { code: e.code, constraint: e.constraint, message: e.message ?? "" };
    }
  });
}

type Outcome = { ok: true; rows: Record<string, any>[] } | { ok: false; message: string; code?: string };

/**
 * Calls one statement with the database clock put on an exact instant, in a transaction that is ALWAYS rolled back. Only the database owner can
 * redefine the internal clock; nothing is committed, so no other test ever sees the changed clock.
 */
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

/** An ISO-8601 UTC instant a given number of microseconds from another (the offset is within one second). */
function shiftMicros(isoSecond: string, micros: number): string {
  const base = new Date(isoSecond);
  const ms = base.getTime();
  if (micros >= 0) return new Date(ms).toISOString().replace(".000Z", `.${String(micros).padStart(6, "0")}Z`);
  return new Date(ms - 1000).toISOString().replace(".000Z", `.${String(1_000_000 + micros).padStart(6, "0")}Z`);
}
const before1us = (iso: string) => shiftMicros(iso, -1);
const after1us = (iso: string) => shiftMicros(iso, 1);

/**
 * UG-CR-GATE-SSS-007A: an exact instant a given number of microseconds from a millisecond-precision instant, written with six fractional digits. (shiftMicros
 * above only knows whole seconds; a deadline may now be any instant to the millisecond.)
 */
function shiftExact(iso: string, deltaMicros: number): string {
  const total = BigInt(Date.parse(iso)) * BigInt(1000) + BigInt(deltaMicros);
  const seconds = total / BigInt(1_000_000);
  const micros = total % BigInt(1_000_000);
  return `${new Date(Number(seconds) * 1000).toISOString().slice(0, 19)}.${micros.toString().padStart(6, "0")}Z`;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------------------------------------------------------------------------

const CR_OFFSET_MS = -6 * 3600_000; // America/Costa_Rica has no daylight saving: always UTC-06:00
const localMinute = (utcMs: number) => new Date(utcMs + CR_OFFSET_MS).toISOString().slice(0, 16);
const localDate = (utcMs: number) => new Date(utcMs + CR_OFFSET_MS).toISOString().slice(0, 10);

function rawPlan(opts: { deadlineMs: number; format?: Format; minimum?: number; maximum?: number }) {
  const format = opts.format ?? "SOCCER_5V5";
  const range = RANGES[format];
  // The configured roster: the format's default minimum and a maximum three above the range's low end (never beyond its high end).
  const maximum = opts.maximum ?? Math.min(range.maxHigh, range.maxLow + 3);
  return {
    venue: { name: `Cancha ${RUN}`, locationDescription: "Calle 5, San José, behind the central market", timeZone: "America/Costa_Rica", simultaneousMatchCapacity: 1, restrictionNotes: "No metal cleats." },
    pitches: [{ label: "A", usable: true, supportedFormats: [format], restrictionNotes: "" }],
    dates: [{ date: localDate(opts.deadlineMs + 3 * DAY), windows: [{ start: "09:00", end: "13:00" }] }],
    roster: { minimum: opts.minimum ?? range.minLow, maximum },
    registrationDeadline: { local: localMinute(opts.deadlineMs), timeZone: "America/Costa_Rica" },
    rules: { version: "draft-1", snapshot: "Draft registration rules, version one." },
  };
}

async function savePlan(competitionId: string, organizerId: string, opts: { deadlineMs: number; format?: Format; minimum?: number; maximum?: number }) {
  const { parsePlanningPlan } = await loadPlanning();
  const plan = parsePlanningPlan(rawPlan(opts), (opts.format ?? "SOCCER_5V5") as never);
  return compRepo.savePlanningRevision(competitionId, organizerId, randomUUID(), plan);
}

/** What a service-side fixture may change about the plan it records: the roster bounds, or (with foreign keys off) the format. Everything else is copied. */
interface PlanOverride { rosterMinimum?: number; rosterMaximum?: number; formatKey?: string }

/**
 * Service-side fixture: records a later planning revision as the database owner, with exactly the deadline given (any instant, to the microsecond). The
 * revision chain, the children and every constraint are the real ones; only the save operation (which needs a DRAFT and a minute-resolution local deadline) is
 * bypassed. A format override is the one thing the real constraints forbid, so it runs with foreign keys off, for that one row.
 */
async function supersedePlan(competitionId: string, deadlineIso: string, override: PlanOverride = {}): Promise<void> {
  await rawTransaction(async (db) => {
    if (override.formatKey) await db.query("set local session_replication_role = replica");
    const cur = (await db.query("select * from competition_planning_revisions where competition_id = $1 order by revision_number desc limit 1", [competitionId])).rows[0];
    const next = (await db.query(
      `insert into competition_planning_revisions (competition_id, format_key, revision_number, supersedes_revision_id, authored_by_gaming_member_id, intent_id, payload_digest,
         venue_name, venue_location_description, venue_time_zone, simultaneous_match_capacity, venue_restriction_notes, roster_minimum, roster_maximum,
         registration_deadline_local, registration_deadline_time_zone, registration_deadline_utc_offset_minutes, registration_deadline_utc, rules_version, rules_snapshot, rules_snapshot_digest)
       values ($1,$2,$3,$4,$5,gen_random_uuid(),$6,$7,$8,$9,$10,$11,$12,$13, ($14::timestamptz at time zone $15), $15, $16, $14::timestamptz, $17,$18,$19) returning planning_revision_id`,
      [competitionId, override.formatKey ?? cur.format_key, cur.revision_number + 1, cur.planning_revision_id, cur.authored_by_gaming_member_id, cur.payload_digest, cur.venue_name, cur.venue_location_description,
        cur.venue_time_zone, cur.simultaneous_match_capacity, cur.venue_restriction_notes, override.rosterMinimum ?? cur.roster_minimum, override.rosterMaximum ?? cur.roster_maximum, deadlineIso, cur.registration_deadline_time_zone,
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

/**
 * Service-side fixture: lets the deadline pass WITHOUT waiting, by recording a later revision (see supersedePlan) whose deadline is the first whole second after
 * the competition's newest registration-related row, plus `fractionMs` milliseconds (UG-CR-GATE-SSS-007A: a deadline may have any millisecond). Every row already
 * written is therefore stamped before it. The returned instant is exactly what was stored.
 */
async function passDeadline(competitionId: string, fractionMs = 0, override: PlanOverride = {}, extraMicros = 0): Promise<string> {
  const [{ latest }] = await rawQuery<{ latest: Date }>(
    `select greatest(
       coalesce((select max(registered_at) from competition_registrations where competition_id = $1), 'epoch'),
       coalesce((select max(created_at) from competition_teams where competition_id = $1), 'epoch'),
       coalesce((select max(created_at) from competition_join_requests where competition_id = $1), 'epoch'),
       coalesce((select max(approved_at) from competition_team_memberships where competition_id = $1), 'epoch'),
       coalesce((select max(created_at) from competition_planning_revisions where competition_id = $1), 'epoch')) as latest`, [competitionId]);
  const deadline = new Date((Math.floor(latest.getTime() / 1000) + 1) * 1000 + fractionMs);
  const wait = deadline.getTime() - Date.now() + 60;
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  const stored = extraMicros ? shiftExact(deadline.toISOString(), extraMicros) : deadline.toISOString();
  await supersedePlan(competitionId, stored, override);
  return stored;
}

/**
 * Service-side fixture (the database owner, with row triggers off — the plan history is append-only for everyone else): removes every planning revision of one
 * competition. It reproduces the shape of a competition that was opened before Organizer Planning existed: no revision at all.
 */
async function removePlans(competitionId: string): Promise<void> {
  const db = new Client({ connectionString: supabaseDbUrl, statement_timeout: 60000 });
  await db.connect();
  try {
    await db.query("set session_replication_role = replica");
    const revs = "(select planning_revision_id from competition_planning_revisions where competition_id = $1)";
    for (const statement of [
      `delete from competition_planning_windows where planning_revision_id in ${revs}`,
      `delete from competition_planning_dates where planning_revision_id in ${revs}`,
      `delete from competition_planning_pitch_formats where planning_pitch_id in (select planning_pitch_id from competition_planning_pitches where planning_revision_id in ${revs})`,
      `delete from competition_planning_pitches where planning_revision_id in ${revs}`,
      "delete from competition_planning_revisions where competition_id = $1",
    ]) await db.query(statement, [competitionId]);
  } finally {
    await db.end().catch(() => {});
  }
}

const rowCounts = async (competitionId: string) => (await rawQuery(
  `select (select count(*)::int from competition_registrations where competition_id = $1) registrations, (select count(*)::int from competition_teams where competition_id = $1) teams,
          (select count(*)::int from competition_join_requests where competition_id = $1) join_requests, (select count(*)::int from competition_team_memberships where competition_id = $1) memberships`, [competitionId]))[0];

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Competitions
// ---------------------------------------------------------------------------------------------------------------------------------------------

interface Ctx { competitionId: string; organizer: Person; format: Format; deadlineMs: number; teams: Array<{ teamId: string; captain: Person; members: string[] }> }

/** A competition with a saved plan and (optionally) open registration. A non-5v5 format is a bounded service-side fixture, applied BEFORE the plan. */
async function setUp(label: string, opts: { format?: Format; deadlineMs?: number; open?: boolean; minimum?: number; maximum?: number; teamCount?: number } = {}): Promise<Ctx> {
  await ensurePool();
  const format = opts.format ?? "SOCCER_5V5";
  const deadlineMs = opts.deadlineMs ?? Date.now() + 2 * DAY;
  const organizer = await makeOperator(`${label} Organizer`);
  const created = await createCompetition(compRepo, organizer.gamingMemberId, `Freeze ${label} ${RUN}`, "SOCCER_5V5");
  competitionIds.push(created.competitionId);
  if (format !== "SOCCER_5V5") {
    const { data, error } = await service.from("competitions").update({ activity_key: format }).eq("competition_id", created.competitionId).select("activity_key");
    if (error) throw error;
    expect(data).toEqual([{ activity_key: format }]);
  }
  const teams: Ctx["teams"] = [];
  for (let i = 0; i < (opts.teamCount ?? 0); i++) {
    const team = await addCompetitionTeam(compRepo, created.competitionId, organizer.gamingMemberId, `T${i} ${label.slice(0, 12)} ${RUN}`, captains[i].gamingMemberId);
    teams.push({ teamId: team.competitionTeamId, captain: captains[i], members: [] });
  }
  await savePlan(created.competitionId, organizer.gamingMemberId, { deadlineMs, format, minimum: opts.minimum, maximum: opts.maximum });
  if (opts.open !== false) await openTeamRegistration(compRepo, created.competitionId, organizer.gamingMemberId);
  return { competitionId: created.competitionId, organizer, format, deadlineMs, teams };
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

/** Fills every team in order; teams are built before any later one so the slices stay disjoint. */
async function fillRosters(ctx: Ctx, sizes: number[]) {
  for (let i = 0; i < sizes.length; i++) await giveMembers(ctx, i, sizes[i]);
}

async function stateOf(competitionId: string): Promise<string> {
  return (await rawQuery("select state from competitions where competition_id = $1", [competitionId]))[0].state as string;
}
const freezeRows = (competitionId: string) => rawQuery("select * from competition_registration_freezes where competition_id = $1", [competitionId]);
const counts = async (competitionId: string) => ({
  freezes: (await rawQuery("select count(*)::int n from competition_registration_freezes where competition_id = $1", [competitionId]))[0].n as number,
  teams: (await rawQuery("select count(*)::int n from competition_registration_freeze_teams where competition_id = $1", [competitionId]))[0].n as number,
  members: (await rawQuery("select count(*)::int n from competition_registration_freeze_members where competition_id = $1", [competitionId]))[0].n as number,
});
const currentDeadlineIso = async (competitionId: string) => (await rawQuery("select registration_deadline_utc from competition_planning_revisions where competition_id = $1 order by revision_number desc limit 1", [competitionId]))[0].registration_deadline_utc.toISOString() as string;

async function expectRejects<E extends Error>(promise: Promise<unknown>, type: new (...args: any[]) => E): Promise<E> {
  try {
    await promise;
  } catch (err) {
    expect(err).toBeInstanceOf(type);
    return err as E;
  }
  throw new Error(`Expected a ${type.name} rejection, but the call resolved.`);
}

/** Like expectRejects, but the error class is loaded lazily: the call must FIRST be refused (the behavior), and only then is the class judged. */
async function expectRejectsLazy<E extends Error>(promise: Promise<unknown>, loadType: () => Promise<new (...args: any[]) => E>): Promise<E> {
  let caught: unknown = null;
  let resolved = false;
  try {
    await promise;
    resolved = true;
  } catch (err) {
    caught = err;
  }
  expect(resolved, "the call must be refused, but it resolved").toBe(false);
  const type = await loadType();
  expect(caught).toBeInstanceOf(type);
  return caught as E;
}
const OpeningError = () => loadFreeze().then((m) => m.RegistrationOpeningError);
const FreezeError = () => loadFreeze().then((m) => m.RegistrationFreezeError);

const COMP = "http://localhost/api/gaming/competitions";
const request = (url: string, method: string, token: string, body?: unknown) =>
  new Request(url, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const ctxOf = (competitionId: string) => ({ params: { competitionId } });

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
  const revoke = () => asGovernance(() => revokeHostCapability(hostRepo, reviewer.gamingMemberId, submitted.publicCode, "Freeze contract test."));
  return { host, competitionId, revoke };
}

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

// Evidence rows are append-only, so the owner removes them with row triggers off (replica role). Every statement runs on its own: one that cannot run
// (a table this run never needed) must not stop the rest, or a failed statement inside one transaction would silently leave EVERYTHING behind — and a
// leftover non-five-a-side competition would break an unrelated suite. Best effort beyond that: a database reset restores a clean state.
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
// [schema] the freeze evidence is server-only and append-only; the helpers and the clock are internal
// =============================================================================================================================================

describe("[schema] freeze evidence is server-only and append-only; helpers and the clock are internal", () => {
  it("each freeze table has row-level security, no policy, no browser privilege and no direct service-role write", async () => {
    const rows = await rawQuery(
      `select c.relname, c.relrowsecurity as rls,
              (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies,
              has_table_privilege('anon', c.oid, 'SELECT') as anon_select, has_table_privilege('authenticated', c.oid, 'SELECT') as auth_select,
              has_table_privilege('anon', c.oid, 'INSERT,UPDATE,DELETE') as anon_write, has_table_privilege('authenticated', c.oid, 'INSERT,UPDATE,DELETE') as auth_write,
              has_table_privilege('service_role', c.oid, 'SELECT') as service_select, has_table_privilege('service_role', c.oid, 'INSERT') as service_insert,
              has_table_privilege('service_role', c.oid, 'UPDATE') as service_update, has_table_privilege('service_role', c.oid, 'DELETE') as service_delete,
              has_table_privilege('service_role', c.oid, 'TRUNCATE') as service_truncate
         from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname = any($1) order by c.relname`, [[...FREEZE_TABLES]]);
    expect(rows.map((r) => r.relname)).toEqual([...FREEZE_TABLES].sort());
    for (const r of rows) {
      expect(r.rls, r.relname).toBe(true);
      expect(r.policies, r.relname).toBe(0);
      expect([r.anon_select, r.auth_select, r.anon_write, r.auth_write], r.relname).toEqual([false, false, false, false]);
      expect(r.service_select, r.relname).toBe(true);
      expect([r.service_insert, r.service_update, r.service_delete, r.service_truncate], r.relname).toEqual([false, false, false, false]);
    }
  });

  it("anon and a signed-in browser client get a permission error (42501) from every freeze table", async () => {
    const person = await newPerson("Table Probe");
    const signedIn = createClient(supabaseUrl, supabaseAnonKey, { global: { headers: { authorization: `Bearer ${await tokenFor(person)}` } }, auth: { persistSession: false, autoRefreshToken: false } });
    for (const table of FREEZE_TABLES) {
      for (const client of [anon, signedIn]) {
        const { error } = await client.from(table).select("*").limit(1);
        expect(error?.code, table).toBe("42501");
      }
    }
  });

  it("the server role can read the tables but a direct write is refused by privilege", async () => {
    for (const table of FREEZE_TABLES) {
      expect((await service.from(table).select("*").limit(1)).error, table).toBeNull();
      expect((await service.from(table).insert({}).select()).error?.code, `${table} insert`).toBe("42501");
    }
  });

  it("UPDATE, DELETE and TRUNCATE are refused by trigger on every freeze table, even for the database owner (a rolled-back control)", async () => {
    for (const table of FREEZE_TABLES) {
      // TRUNCATE ... CASCADE makes the database fire the statement-level trigger on every table it would empty (a bare TRUNCATE of a referenced table is
      // refused earlier, by the foreign key, before any trigger could speak). On an empty table a row trigger has nothing to fire on, so for the row verbs
      // the triggers must exist and be enabled (checked next), which is what makes a populated table immutable.
      const truncated = await violation(`truncate table ${table} cascade`);
      expect(truncated?.message ?? "no error", `${table}: truncate`).toMatch(/REGISTRATION_FREEZE_IMMUTABLE/);
      const triggers = await rawQuery(
        `select tgname, tgtype, tgenabled from pg_trigger where tgrelid = $1::regclass and not tgisinternal and tgname like '%immutable%' order by tgname`, [`public.${table}`]);
      expect(triggers.map((t) => t.tgenabled), table).toEqual(["O", "O"]);
    }
  });

  it("each freeze row, once written, cannot be updated or deleted (a rolled-back control on a real freeze)", async () => {
    const ctx = await setUp("Immutable", { teamCount: 4 });
    await fillRosters(ctx, [5, 5, 5, 5]);
    await passDeadline(ctx.competitionId);
    await closeTeamRegistration(compRepo, ctx.competitionId, ctx.organizer.gamingMemberId);
    for (const table of FREEZE_TABLES) {
      for (const statement of [`update ${table} set competition_id = competition_id where competition_id = '${ctx.competitionId}'`, `delete from ${table} where competition_id = '${ctx.competitionId}'`]) {
        const v = await violation(statement);
        expect(v?.message ?? "no error", `${table}: ${statement}`).toMatch(/REGISTRATION_FREEZE_IMMUTABLE/);
      }
    }
  }, 120000);

  it("one freeze per competition, exactly four teams, a frozen timestamp that is never before the deadline, and a hex digest are enforced by the table itself", async () => {
    const defs = await rawQuery(`select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'public.competition_registration_freezes'::regclass order by conname`);
    const text = defs.map((d) => `${d.conname} ${d.def}`).join("\n");
    expect(text).toMatch(/UNIQUE \(competition_id\)/);
    expect(text).toMatch(/team_count = 4/);
    expect(text).toMatch(/frozen_at >= registration_deadline_utc/);
    expect(text).toMatch(/\^\[0-9a-f\]\{64\}\$/);
    expect(text).toMatch(/FOREIGN KEY \(competition_id, planning_revision_id\) REFERENCES competition_planning_revisions\(competition_id, planning_revision_id\)/);
    expect(text).toMatch(/FOREIGN KEY \(competition_id, format_key\) REFERENCES competitions\(competition_id, activity_key\)/);
    const members = await rawQuery(`select pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'public.competition_registration_freeze_members'::regclass and contype = 'p'`);
    expect(members.map((m) => m.def)).toEqual(["PRIMARY KEY (registration_freeze_id, gaming_member_id)"]);
  });

  it("every internal helper is executable by nobody (not PUBLIC, anon, authenticated or service_role) and pins its search_path", async () => {
    for (const signature of INTERNAL_HELPERS) {
      const [row] = await rawQuery(
        `select p.oid, p.proconfig::text as cfg, p.prosecdef as definer from pg_proc p where p.oid = $1::regprocedure`, [`public.${signature}`]);
      expect(row, signature).toBeDefined();
      expect(row.cfg, signature).toContain("search_path=public");
      for (const role of ["anon", "authenticated", "service_role"]) {
        const [x] = await rawQuery("select has_function_privilege($1, $2::oid, 'EXECUTE') as ok", [role, row.oid]);
        expect(x.ok, `${role} must not execute ${signature}`).toBe(false);
      }
      const [pub] = await rawQuery(`select count(*)::int as n from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = $1::oid and a.grantee = 0 and a.privilege_type = 'EXECUTE'`, [row.oid]);
      expect(pub.n, `PUBLIC must not execute ${signature}`).toBe(0);
    }
  });

  it("the clock is exactly clock_timestamp(): no setting, table, cache or client value can move it", async () => {
    const [row] = await rawQuery("select prosrc, provolatile from pg_proc where oid = 'public.competition_registration_clock()'::regprocedure");
    expect(String(row.prosrc).replace(/\s+/g, " ").trim().toLowerCase()).toBe("select clock_timestamp()");
    expect(row.provolatile).toBe("v");
    // Through the real API: nobody but the server can even call it.
    const viaApi = await service.rpc("competition_registration_clock", {});
    expect(viaApi.error?.code ?? viaApi.error?.message).toBeTruthy();
    expect((await anon.rpc("competition_registration_clock", {})).error).not.toBeNull();
  });

  it("no registration function accepts a time of any kind: the client cannot supply the clock", async () => {
    const rows = await rawQuery(
      `select p.proname, pg_get_function_arguments(p.oid) as args from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = any($1)
          and exists (select 1 from unnest(p.proargtypes::oid[]) t where t in ('timestamptz'::regtype::oid, 'timestamp'::regtype::oid, 'date'::regtype::oid, 'time'::regtype::oid, 'interval'::regtype::oid))`, [[...NINE]]);
    expect(rows).toEqual([]);
  });

  it("all nine registration functions (both overloads of two) keep SECURITY DEFINER, a pinned search_path and service-role-only execution", async () => {
    const rows = await rawQuery(`select p.oid, p.proname, p.prosecdef, p.proconfig::text as cfg from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = any($1)`, [[...NINE]]);
    expect(rows).toHaveLength(11);
    for (const row of rows) {
      expect(row.prosecdef, row.proname).toBe(true);
      expect(row.cfg, row.proname).toContain("search_path=public");
      for (const role of ["anon", "authenticated"]) {
        const [x] = await rawQuery("select has_function_privilege($1, $2::oid, 'EXECUTE') as ok", [role, row.oid]);
        expect(x.ok, `${role} must not execute ${row.proname}`).toBe(false);
      }
    }
  });

  it("every function that decides on the deadline calls the one clock or a helper that does, and no function reads a client time", async () => {
    const defs = await rawQuery(`select p.proname, pg_get_function_arguments(p.oid) as args, pg_get_functiondef(p.oid) as def from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = any($1)`, [[...NINE]]);
    const need: Record<string, string> = {
      open_team_registration_atomically: "competition_registration_clock()",
      close_team_registration_atomically: "competition_registration_clock()",
      register_for_competition_atomically: "competition_assert_registration_intake_open(",
      add_competition_team_atomically: "competition_assert_registration_intake_open(",
      propose_competition_team_atomically: "competition_assert_registration_intake_open(",
      request_join_competition_team_atomically: "competition_assert_registration_intake_open(",
      decide_competition_team_atomically: "competition_assert_registration_decision_allowed(",
      decide_join_request_atomically: "competition_assert_registration_decision_allowed(",
      organizer_review_join_request_atomically: "competition_assert_registration_decision_allowed(",
    };
    for (const row of defs) {
      expect(row.def, `${row.proname}(${row.args})`).toContain(need[row.proname]);
      expect(String(row.def), `${row.proname}(${row.args}) must not read now() or a setting`).not.toMatch(/\bnow\(\)\s*[<>]=?\s*|current_setting\(/i);
    }
  });
});

// =============================================================================================================================================
// [opening] registration cannot open without a usable plan
// =============================================================================================================================================

describe("[opening] team registration opens only with a usable plan and a future deadline", () => {
  it("[1] a competition with no plan cannot open registration (the state stays DRAFT)", async () => {
    await ensurePool();
    const organizer = await makeOperator("NoPlan Organizer");
    const created = await createCompetition(compRepo, organizer.gamingMemberId, `NoPlan ${RUN}`, "SOCCER_5V5");
    competitionIds.push(created.competitionId);
    const err = await expectRejectsLazy(openTeamRegistration(compRepo, created.competitionId, organizer.gamingMemberId), OpeningError);
    expect(err.code).toBe("PLAN_MISSING");
    expect(await stateOf(created.competitionId)).toBe("DRAFT");
    const raw = await service.rpc("open_team_registration_atomically", { p_competition_id: created.competitionId, p_organizer_gaming_member_id: organizer.gamingMemberId });
    expect(raw.error?.message ?? "").toContain("REGISTRATION_OPENING_PLAN_MISSING");
  });

  it("[2] an expired deadline cannot open registration; the exact deadline instant is expired, one microsecond before is not", async () => {
    const organizer = await makeOperator("Expired Organizer");
    const created = await createCompetition(compRepo, organizer.gamingMemberId, `Expired ${RUN}`, "SOCCER_5V5");
    competitionIds.push(created.competitionId);
    await savePlan(created.competitionId, organizer.gamingMemberId, { deadlineMs: Date.now() - 2 * DAY });
    const err = await expectRejectsLazy(openTeamRegistration(compRepo, created.competitionId, organizer.gamingMemberId), OpeningError);
    expect(err.code).toBe("DEADLINE_EXPIRED");
    expect(await stateOf(created.competitionId)).toBe("DRAFT");

    const fresh = await makeOperator("Boundary Organizer");
    const c2 = await createCompetition(compRepo, fresh.gamingMemberId, `Boundary ${RUN}`, "SOCCER_5V5");
    competitionIds.push(c2.competitionId);
    await savePlan(c2.competitionId, fresh.gamingMemberId, { deadlineMs: Date.now() + 2 * DAY });
    const deadline = await currentDeadlineIso(c2.competitionId);
    const call = "select * from open_team_registration_atomically($1, $2)";
    const args = [c2.competitionId, fresh.gamingMemberId];
    const onTheInstant = await atInstant(deadline, call, args);
    expect(onTheInstant.ok).toBe(false);
    expect(!onTheInstant.ok && onTheInstant.message).toContain("REGISTRATION_OPENING_DEADLINE_EXPIRED");
    const justBefore = await atInstant(before1us(deadline), call, args);
    expect(justBefore.ok).toBe(true);
    expect(await stateOf(c2.competitionId)).toBe("DRAFT"); // both were rolled back
  });

  it("[3] a plan with a valid future deadline opens registration", async () => {
    const ctx = await setUp("OpenOk");
    expect(await stateOf(ctx.competitionId)).toBe("TEAM_REGISTRATION_OPEN");
  });

  it("[3b] a plan whose roster bounds fall outside the format's registry range is not a usable plan (service-side fixture)", async () => {
    const organizer = await makeOperator("Bounds Organizer");
    const created = await createCompetition(compRepo, organizer.gamingMemberId, `Bounds ${RUN}`, "SOCCER_5V5");
    competitionIds.push(created.competitionId);
    await savePlan(created.competitionId, organizer.gamingMemberId, { deadlineMs: Date.now() + 2 * DAY });
    // The save operation would refuse this plan; the open operation must judge the stored plan on its own, so a later (superseding) row that bypasses the save is refused.
    await rawQuery(
      `insert into competition_planning_revisions (competition_id, format_key, revision_number, supersedes_revision_id, authored_by_gaming_member_id, intent_id, payload_digest,
         venue_name, venue_location_description, venue_time_zone, simultaneous_match_capacity, venue_restriction_notes, roster_minimum, roster_maximum,
         registration_deadline_local, registration_deadline_time_zone, registration_deadline_utc_offset_minutes, registration_deadline_utc, rules_version, rules_snapshot, rules_snapshot_digest)
       select competition_id, format_key, revision_number + 1, planning_revision_id, authored_by_gaming_member_id, gen_random_uuid(), payload_digest, venue_name, venue_location_description,
         venue_time_zone, simultaneous_match_capacity, venue_restriction_notes, 1, 2, registration_deadline_local, registration_deadline_time_zone, registration_deadline_utc_offset_minutes,
         registration_deadline_utc, rules_version, rules_snapshot, rules_snapshot_digest
       from competition_planning_revisions where competition_id = $1 order by revision_number desc limit 1`, [created.competitionId]);
    const err = await expectRejectsLazy(openTeamRegistration(compRepo, created.competitionId, organizer.gamingMemberId), OpeningError);
    expect(err.code).toBe("PLAN_INVALID");
    expect(await stateOf(created.competitionId)).toBe("DRAFT");
  });

  it("[4] a wrong, null or revoked organizer is refused for its own reason BEFORE anything about the plan is disclosed", async () => {
    await ensurePool();
    const owner = await makeOperator("Owner");
    const created = await createCompetition(compRepo, owner.gamingMemberId, `Order ${RUN}`, "SOCCER_5V5");
    competitionIds.push(created.competitionId); // deliberately NO plan
    const stranger = await makeOperator("Stranger");
    await expectRejects(openTeamRegistration(compRepo, created.competitionId, stranger.gamingMemberId), CompetitionAccessDeniedError);
    const nullActor = await service.rpc("open_team_registration_atomically", { p_competition_id: created.competitionId, p_organizer_gaming_member_id: null });
    expect(nullActor.error?.message ?? "").toContain("COMPETITION_ACCESS_DENIED");
    expect(nullActor.error?.message ?? "").not.toMatch(/PLAN|DEADLINE/);
    await expectRejects(openTeamRegistration(compRepo, randomUUID(), owner.gamingMemberId), CompetitionNotFoundError);

    const pilot = await hostPilot("OpenRevoked");
    await pilot.revoke();
    await expectRejects(openTeamRegistration(compRepo, pilot.competitionId, pilot.host.gamingMemberId), HostAccessRevokedError);

    // Once open, the state refusal still comes first for the owner: the plan is never consulted.
    const open = await setUp("OpenTwice");
    await expectRejects(openTeamRegistration(compRepo, open.competitionId, open.organizer.gamingMemberId), CompetitionNotDraftError);
  }, 120000);
});

/**
 * The six write operations that introduce NEW competitive entries (two of them have two signatures), each with the setup it needs and the exact call. The
 * deadline tests and the fractional-deadline tests run the same list, so a fractional deadline is held to every one of them.
 */
interface Op { name: string; statement: string; args: (ctx: Ctx, extra: Record<string, string>) => unknown[]; setup: (ctx: Ctx) => Promise<Record<string, string>>; table: string }
const INTAKE_OPS: Op[] = [
  {
    name: "a competition-member registration", table: "competition_registrations",
    statement: "select * from register_for_competition_atomically($1, $2, true)",
    setup: async () => ({ member: pool[0].gamingMemberId }),
    args: (ctx, x) => [ctx.competitionId, x.member],
  },
  {
    name: "an organizer-added team (current signature)", table: "competition_teams",
    statement: "select * from add_competition_team_atomically($1, $2, $3, $4, $5)",
    setup: async () => ({}),
    args: (ctx) => [ctx.competitionId, ctx.organizer.gamingMemberId, `Added ${randomUUID().slice(0, 6)}`, captains[0].gamingMemberId, `pc${randomUUID().replace(/-/g, "").slice(0, 20)}`],
  },
  {
    name: "an organizer-added team (legacy signature)", table: "competition_teams",
    statement: "select * from add_competition_team_atomically($1, $2, $3, $4)",
    setup: async () => ({}),
    args: (ctx) => [ctx.competitionId, ctx.organizer.gamingMemberId, `Legacy ${randomUUID().slice(0, 6)}`, captains[0].gamingMemberId],
  },
  {
    name: "a member-proposed team (current signature)", table: "competition_teams",
    statement: "select * from propose_competition_team_atomically($1, $2, $3, $4)",
    setup: async (ctx) => { await registerForCompetition(compRepo, ctx.competitionId, pool[1].gamingMemberId, true); return { member: pool[1].gamingMemberId }; },
    args: (ctx, x) => [ctx.competitionId, `Proposed ${randomUUID().slice(0, 6)}`, x.member, `pc${randomUUID().replace(/-/g, "").slice(0, 20)}`],
  },
  {
    name: "a member-proposed team (legacy signature)", table: "competition_teams",
    statement: "select * from propose_competition_team_atomically($1, $2, $3)",
    setup: async (ctx) => { await registerForCompetition(compRepo, ctx.competitionId, pool[2].gamingMemberId, true); return { member: pool[2].gamingMemberId }; },
    args: (ctx, x) => [ctx.competitionId, `LegacyProp ${randomUUID().slice(0, 6)}`, x.member],
  },
  {
    name: "a team-join request", table: "competition_join_requests",
    statement: "select * from request_join_competition_team_atomically($1, $2, $3)",
    setup: async (ctx) => {
      const team = await addCompetitionTeam(compRepo, ctx.competitionId, ctx.organizer.gamingMemberId, `Join ${randomUUID().slice(0, 6)}`, captains[3].gamingMemberId);
      await registerForCompetition(compRepo, ctx.competitionId, pool[3].gamingMemberId, true);
      return { team: team.competitionTeamId, member: pool[3].gamingMemberId };
    },
    args: (ctx, x) => [ctx.competitionId, x.team, x.member],
  },
];

// =============================================================================================================================================
// [deadline] the database clock closes registration at the exact deadline instant
// =============================================================================================================================================

describe("[deadline] new registrations, teams, proposals and join requests are refused at and after the deadline", () => {
  const DEADLINE_RE = /TEAM_REGISTRATION_NOT_OPEN/;

  for (const op of INTAKE_OPS) {
    it(`[5-8] ${op.name}: one microsecond before the deadline is accepted; the exact deadline and every later instant are refused`, async () => {
      const ctx = await setUp(`Dl ${op.name.slice(0, 18)}`);
      const extra = await op.setup(ctx);
      const deadline = await currentDeadlineIso(ctx.competitionId);
      const rowsBefore = (await rawQuery(`select count(*)::int n from ${op.table} where competition_id = $1`, [ctx.competitionId]))[0].n;

      const accepted = await atInstant(before1us(deadline), op.statement, op.args(ctx, extra));
      expect(accepted, "one microsecond before the deadline").toMatchObject({ ok: true });

      for (const [label, instant] of [["exactly the deadline", deadline], ["one microsecond after", after1us(deadline)], ["a week after", new Date(Date.parse(deadline) + 7 * DAY).toISOString()]] as const) {
        const refused = await atInstant(instant, op.statement, op.args(ctx, extra));
        expect(refused.ok, label).toBe(false);
        expect(!refused.ok && refused.message, label).toMatch(DEADLINE_RE);
        expect(!refused.ok && refused.message, label).toMatch(/deadline/i);
      }
      // Every probe was rolled back: nothing was written for real.
      expect((await rawQuery(`select count(*)::int n from ${op.table} where competition_id = $1`, [ctx.competitionId]))[0].n).toBe(rowsBefore);
    }, 120000);
  }

  it("[5-8] an existing registration is returned unchanged after the deadline (a replay is not a new registration)", async () => {
    const ctx = await setUp("DlReplay");
    await registerForCompetition(compRepo, ctx.competitionId, pool[0].gamingMemberId, true);
    await passDeadline(ctx.competitionId);
    const again = await registerForCompetition(compRepo, ctx.competitionId, pool[0].gamingMemberId, true);
    expect(again.alreadyRegistered).toBe(true);
    await expectRejects(registerForCompetition(compRepo, ctx.competitionId, pool[1].gamingMemberId, true), TeamRegistrationNotOpenError);
  });

  it("[5] with a plan in DRAFT, an organizer-added team is also refused once that plan's deadline has passed (registration is closed at the instant, whatever the state)", async () => {
    await ensurePool();
    const organizer = await makeOperator("DraftDl Organizer");
    const created = await createCompetition(compRepo, organizer.gamingMemberId, `DraftDl ${RUN}`, "SOCCER_5V5");
    competitionIds.push(created.competitionId);
    await addCompetitionTeam(compRepo, created.competitionId, organizer.gamingMemberId, `Before plan ${RUN}`, captains[0].gamingMemberId); // legacy: no plan yet, allowed
    await savePlan(created.competitionId, organizer.gamingMemberId, { deadlineMs: Date.now() - 2 * DAY });
    await expectRejects(addCompetitionTeam(compRepo, created.competitionId, organizer.gamingMemberId, `After plan ${RUN}`, captains[1].gamingMemberId), TeamRegistrationNotOpenError);
    // A new revision with a future deadline reopens the draft's door.
    await savePlan(created.competitionId, organizer.gamingMemberId, { deadlineMs: Date.now() + 2 * DAY });
    await addCompetitionTeam(compRepo, created.competitionId, organizer.gamingMemberId, `After revision ${RUN}`, captains[1].gamingMemberId);
  });

  it("[9] a client clock cannot change the result: fields claiming another time are ignored by the real register route", async () => {
    const ctx = await setUp("ClientClock");
    const member = pool[4];
    const token = await tokenFor(member);
    await passDeadline(ctx.competitionId);
    const claimed = new Date(Date.now() - 30 * DAY).toISOString();
    const res = await registerRoute(request(`${COMP}/${ctx.competitionId}/register`, "POST", token, { isAdultSelfAttested: true, now: claimed, registeredAt: claimed, deadline: claimed, serverTime: claimed }), ctxOf(ctx.competitionId));
    expect(res.status).toBe(409);
    expect((await rawQuery("select count(*)::int n from competition_registrations where competition_id = $1 and gaming_member_id = $2", [ctx.competitionId, member.gamingMemberId]))[0].n).toBe(0);
  });

  it("[10] requests straddling a real deadline: every accepted write is stamped before it, every later one is refused, and both outcomes occur", async () => {
    await ensurePool();
    // A real minute boundary at least 25 seconds away: deadlines have minute precision.
    const now = Date.now();
    let deadlineMs = Math.ceil((now + 25_000) / 60_000) * 60_000;
    const ctx = await setUp("Straddle", { deadlineMs, teamCount: 0 });
    deadlineMs = Date.parse(await currentDeadlineIso(ctx.competitionId));
    const registrants = pool.slice(10, 28);
    const proposers = pool.slice(28, 36);
    for (const proposer of proposers) await registerForCompetition(compRepo, ctx.competitionId, proposer.gamingMemberId, true);

    type Attempt = { kind: string; ok: boolean; message: string };
    const attempts: Attempt[] = [];
    const attempt = async (kind: string, run: () => Promise<unknown>) => {
      try { await run(); attempts.push({ kind, ok: true, message: "" }); } catch (err) { attempts.push({ kind, ok: false, message: (err as Error).message }); }
    };
    const waitUntil = async (ms: number) => { const d = ms - Date.now(); if (d > 0) await new Promise((r) => setTimeout(r, d)); };
    await waitUntil(deadlineMs - 7_000);
    // Six waves of concurrent requests, from seven seconds before to five seconds after the boundary.
    for (let wave = 0; wave < 6; wave++) {
      await waitUntil(deadlineMs - 7_000 + wave * 2_400);
      const tasks: Promise<void>[] = [];
      for (const member of registrants.slice(wave * 3, wave * 3 + 3)) tasks.push(attempt("register", () => registerForCompetition(compRepo, ctx.competitionId, member.gamingMemberId, true)));
      if (proposers[wave]) tasks.push(attempt("propose", () => proposeCompetitionTeam(compRepo, ctx.competitionId, `Wave ${wave} ${RUN}`, proposers[wave].gamingMemberId)));
      await Promise.all(tasks);
    }
    const accepted = attempts.filter((a) => a.ok);
    const refused = attempts.filter((a) => !a.ok);
    expect(accepted.length, "some writes landed before the boundary").toBeGreaterThan(0);
    expect(refused.length, "some writes arrived after it").toBeGreaterThan(0);
    for (const a of refused) expect(a.message, a.kind).toMatch(/TEAM_REGISTRATION_NOT_OPEN|deadline/i);
    const lateRegistrations = await rawQuery("select count(*)::int n from competition_registrations where competition_id = $1 and registered_at >= $2", [ctx.competitionId, new Date(deadlineMs).toISOString()]);
    const lateTeams = await rawQuery("select count(*)::int n from competition_teams where competition_id = $1 and created_at >= $2", [ctx.competitionId, new Date(deadlineMs).toISOString()]);
    expect(lateRegistrations[0].n).toBe(0);
    expect(lateTeams[0].n).toBe(0);
  }, 240000);
});

// =============================================================================================================================================
// [pending] work received before the deadline is decided explicitly afterwards; work stamped at or after it never is
// =============================================================================================================================================

describe("[pending] pre-deadline proposals and join requests are decided after the deadline, within their existing authority", () => {
  it("[11] a pre-deadline proposal can be approved or rejected after the deadline", async () => {
    const ctx = await setUp("PendProp");
    const a = pool[0], b = pool[1];
    await registerForCompetition(compRepo, ctx.competitionId, a.gamingMemberId, true);
    await registerForCompetition(compRepo, ctx.competitionId, b.gamingMemberId, true);
    const pa = await proposeCompetitionTeam(compRepo, ctx.competitionId, `Alpha ${RUN}`, a.gamingMemberId);
    const pb = await proposeCompetitionTeam(compRepo, ctx.competitionId, `Beta ${RUN}`, b.gamingMemberId);
    await passDeadline(ctx.competitionId);
    const approved = await decideCompetitionTeam(compRepo, pa.competitionTeamId, ctx.organizer.gamingMemberId, "APPROVE", null);
    expect(approved.status).toBe("ACCEPTED");
    expect(approved.competitionTeamMembershipId).not.toBeNull();
    const rejected = await decideCompetitionTeam(compRepo, pb.competitionTeamId, ctx.organizer.gamingMemberId, "REJECT", "Too late to field a full roster.");
    expect(rejected.status).toBe("REJECTED");
  });

  it("[12] a proposal stamped at or after the deadline cannot be approved or rejected (a service-side fixture: no public path can create it)", async () => {
    const ctx = await setUp("PendLate");
    await passDeadline(ctx.competitionId);
    const deadline = await currentDeadlineIso(ctx.competitionId);
    const stamped = async (offsetMs: number) => {
      const [row] = await rawQuery(
        `insert into competition_teams (competition_id, name, captain_gaming_member_id, status, provenance, created_at)
         values ($1, $2, $3, 'PENDING_ORGANIZER_APPROVAL', 'MEMBER_PROPOSED', $4::timestamptz + ($5 || ' milliseconds')::interval) returning competition_team_id`,
        [ctx.competitionId, `Late ${randomUUID().slice(0, 6)}`, captains[offsetMs === 0 ? 0 : 1].gamingMemberId, deadline, String(offsetMs)]);
      return row.competition_team_id as string;
    };
    const atDeadline = await stamped(0);
    const afterDeadline = await stamped(5000);
    for (const teamId of [atDeadline, afterDeadline]) {
      await expectRejects(decideCompetitionTeam(compRepo, teamId, ctx.organizer.gamingMemberId, "APPROVE", null), TeamRegistrationNotOpenError);
      await expectRejects(decideCompetitionTeam(compRepo, teamId, ctx.organizer.gamingMemberId, "REJECT", "Not eligible."), TeamRegistrationNotOpenError);
    }
    expect((await rawQuery("select status from competition_teams where competition_team_id = any($1) order by status", [[atDeadline, afterDeadline]])).map((r) => r.status)).toEqual(["PENDING_ORGANIZER_APPROVAL", "PENDING_ORGANIZER_APPROVAL"]);
    // The same row, stamped one microsecond BEFORE the deadline, is eligible.
    const [early] = await rawQuery(
      `insert into competition_teams (competition_id, name, captain_gaming_member_id, status, provenance, created_at)
       values ($1, $2, $3, 'PENDING_ORGANIZER_APPROVAL', 'MEMBER_PROPOSED', $4::timestamptz - interval '1 microsecond') returning competition_team_id`,
      [ctx.competitionId, `Early ${randomUUID().slice(0, 6)}`, captains[2].gamingMemberId, deadline]);
    const ok = await decideCompetitionTeam(compRepo, early.competition_team_id, ctx.organizer.gamingMemberId, "REJECT", "Recorded one microsecond before the deadline.");
    expect(ok.status).toBe("REJECTED");
  });

  it("[13] a pre-deadline join request is decided after the deadline (approve and reject); one stamped at the deadline is not eligible", async () => {
    const ctx = await setUp("PendJoin", { teamCount: 2 });
    for (const m of [pool[0], pool[1]]) await registerForCompetition(compRepo, ctx.competitionId, m.gamingMemberId, true);
    const r1 = await requestJoinTeam(compRepo, ctx.competitionId, ctx.teams[0].teamId, pool[0].gamingMemberId);
    const r2 = await requestJoinTeam(compRepo, ctx.competitionId, ctx.teams[1].teamId, pool[1].gamingMemberId);
    await passDeadline(ctx.competitionId);
    const approved = await decideJoinRequest(compRepo, r1.competitionJoinRequestId, ctx.teams[0].captain.gamingMemberId, "APPROVE", false);
    expect(approved.status).toBe("APPROVED");
    expect(approved.competitionTeamMembershipId).not.toBeNull();
    const rejected = await decideJoinRequest(compRepo, r2.competitionJoinRequestId, ctx.teams[1].captain.gamingMemberId, "REJECT", false);
    expect(rejected.status).toBe("REJECTED");
    // The organizer's one review of a rejected request is the same kind of decision and follows the same rule.
    const deadline = await currentDeadlineIso(ctx.competitionId);
    const [late] = await rawQuery(
      `insert into competition_join_requests (competition_id, competition_team_id, requesting_gaming_member_id, status, created_at, decided_by_gaming_member_id, decided_at)
       values ($1, $2, $3, 'REJECTED', $4::timestamptz, $5, $4::timestamptz) returning competition_join_request_id`,
      [ctx.competitionId, ctx.teams[1].teamId, pool[5].gamingMemberId, deadline, ctx.teams[1].captain.gamingMemberId]);
    await expectRejects(organizerReviewJoinRequest(compRepo, late.competition_join_request_id, ctx.organizer.gamingMemberId, "APPROVE", "Second look."), TeamRegistrationNotOpenError);
    const reviewed = await organizerReviewJoinRequest(compRepo, r2.competitionJoinRequestId, ctx.organizer.gamingMemberId, "APPROVE", "Pre-deadline request, organizer review.");
    expect(reviewed.status).toBe("APPROVED");
    // A request stamped at the deadline can never be decided by a captain either.
    const [pending] = await rawQuery(
      `insert into competition_join_requests (competition_id, competition_team_id, requesting_gaming_member_id, status, created_at) values ($1, $2, $3, 'REQUESTED', $4::timestamptz) returning competition_join_request_id`,
      [ctx.competitionId, ctx.teams[0].teamId, pool[6].gamingMemberId, deadline]);
    await expectRejects(decideJoinRequest(compRepo, pending.competition_join_request_id, ctx.teams[0].captain.gamingMemberId, "APPROVE", false), TeamRegistrationNotOpenError);
    await expectRejects(decideJoinRequest(compRepo, pending.competition_join_request_id, ctx.organizer.gamingMemberId, "REJECT", true), TeamRegistrationNotOpenError);
  }, 120000);

  it("[14] after the deadline the existing authority boundaries hold, and an authority failure is never replaced by a deadline error", async () => {
    const ctx = await setUp("PendAuth", { teamCount: 1 });
    await registerForCompetition(compRepo, ctx.competitionId, pool[0].gamingMemberId, true);
    await registerForCompetition(compRepo, ctx.competitionId, pool[1].gamingMemberId, true);
    const proposal = await proposeCompetitionTeam(compRepo, ctx.competitionId, `Auth ${RUN}`, pool[1].gamingMemberId);
    const request = await requestJoinTeam(compRepo, ctx.competitionId, ctx.teams[0].teamId, pool[0].gamingMemberId);
    await passDeadline(ctx.competitionId);
    const stranger = await makeOperator("Auth Stranger");
    await expectRejects(decideCompetitionTeam(compRepo, proposal.competitionTeamId, stranger.gamingMemberId, "APPROVE", null), CompetitionAccessDeniedError);
    await expectRejects(decideCompetitionTeam(compRepo, proposal.competitionTeamId, pool[1].gamingMemberId, "APPROVE", null), CompetitionAccessDeniedError);
    await expectRejects(decideJoinRequest(compRepo, request.competitionJoinRequestId, stranger.gamingMemberId, "APPROVE", false), NotTeamCaptainError);
    await expectRejects(decideJoinRequest(compRepo, request.competitionJoinRequestId, stranger.gamingMemberId, "APPROVE", true), CompetitionAccessDeniedError);
    // The same holds for an item that is NOT eligible: the stranger still learns nothing about eligibility.
    const deadline = await currentDeadlineIso(ctx.competitionId);
    const [ineligible] = await rawQuery(
      `insert into competition_join_requests (competition_id, competition_team_id, requesting_gaming_member_id, status, created_at) values ($1, $2, $3, 'REQUESTED', $4::timestamptz) returning competition_join_request_id`,
      [ctx.competitionId, ctx.teams[0].teamId, pool[7].gamingMemberId, deadline]);
    await expectRejects(decideJoinRequest(compRepo, ineligible.competition_join_request_id, stranger.gamingMemberId, "APPROVE", false), NotTeamCaptainError);
    // And the legitimate decisions still work.
    expect((await decideCompetitionTeam(compRepo, proposal.competitionTeamId, ctx.organizer.gamingMemberId, "APPROVE", null)).status).toBe("ACCEPTED");
    expect((await decideJoinRequest(compRepo, request.competitionJoinRequestId, ctx.teams[0].captain.gamingMemberId, "APPROVE", false)).status).toBe("APPROVED");
  }, 120000);
});

// =============================================================================================================================================
// [freeze] the close operation is the atomic freeze checkpoint
// =============================================================================================================================================

describe("[freeze] the close operation freezes registration atomically, once, and records immutable evidence", () => {
  async function ready(label: string, sizes = [5, 5, 5, 5], opts: Parameters<typeof setUp>[1] = {}) {
    const ctx = await setUp(label, { teamCount: 4, ...opts });
    await fillRosters(ctx, sizes);
    return ctx;
  }
  const close = (ctx: Ctx, actor = ctx.organizer.gamingMemberId) => closeTeamRegistration(compRepo, ctx.competitionId, actor);

  it("[16] a freeze before the deadline is refused and changes nothing", async () => {
    const ctx = await ready("FzEarly");
    const err = await expectRejectsLazy(close(ctx), FreezeError);
    expect(err.code).toBe("DEADLINE_NOT_REACHED");
    expect(await stateOf(ctx.competitionId)).toBe("TEAM_REGISTRATION_OPEN");
    expect(await counts(ctx.competitionId)).toEqual({ freezes: 0, teams: 0, members: 0 });
    // The exact instant is reached, one microsecond before is not (rolled back).
    const deadline = await currentDeadlineIso(ctx.competitionId);
    const call = "select * from close_team_registration_atomically($1, $2)";
    const args = [ctx.competitionId, ctx.organizer.gamingMemberId];
    const justBefore = await atInstant(before1us(deadline), call, args);
    expect(!justBefore.ok && justBefore.message).toContain("REGISTRATION_FREEZE_DEADLINE_NOT_REACHED");
    const onTheInstant = await atInstant(deadline, call, args);
    expect(onTheInstant.ok).toBe(true);
    expect(await stateOf(ctx.competitionId)).toBe("TEAM_REGISTRATION_OPEN"); // both rolled back
  }, 120000);

  it("[17-18] three accepted teams are refused, five accepted teams are refused, and exactly four is required", async () => {
    const three = await setUp("FzThree", { teamCount: 3 });
    await fillRosters(three, [5, 5, 5]);
    await passDeadline(three.competitionId);
    const err = await expectRejects(close(three), TeamRegistrationCapacityNotReachedError);
    expect(err.message).toMatch(/found 3/);

    // Five accepted teams cannot be built through the public operations (capacity is four): a service-side fixture adds one directly.
    const five = await ready("FzFive");
    await rawQuery("insert into competition_teams (competition_id, name, captain_gaming_member_id, status, provenance) values ($1, $2, $3, 'ACCEPTED', 'ORGANIZER_CREATED')", [five.competitionId, `Fifth ${RUN}`, captains[4].gamingMemberId]);
    await passDeadline(five.competitionId);
    const err5 = await expectRejects(close(five), TeamRegistrationCapacityNotReachedError);
    expect(err5.message).toMatch(/found 5/);
    for (const c of [three, five]) expect(await counts(c.competitionId)).toEqual({ freezes: 0, teams: 0, members: 0 });
  }, 120000);

  it("[19] an unresolved team proposal refuses the freeze, and rejecting it explicitly lets the freeze proceed", async () => {
    const ctx = await ready("FzProp");
    await registerForCompetition(compRepo, ctx.competitionId, pool[40].gamingMemberId, true);
    const proposal = await proposeCompetitionTeam(compRepo, ctx.competitionId, `Pending ${RUN}`, pool[40].gamingMemberId);
    await passDeadline(ctx.competitionId);
    const err = await expectRejectsLazy(close(ctx), FreezeError);
    expect(err.code).toBe("PENDING_PROPOSALS");
    await decideCompetitionTeam(compRepo, proposal.competitionTeamId, ctx.organizer.gamingMemberId, "REJECT", "Capacity is already four.");
    expect((await close(ctx)).state).toBe("READY_TO_PUBLISH");
  }, 120000);

  it("[20] an unresolved join request for an accepted team refuses the freeze, and deciding it explicitly lets the freeze proceed", async () => {
    const ctx = await ready("FzJoin");
    await registerForCompetition(compRepo, ctx.competitionId, pool[41].gamingMemberId, true);
    const req = await requestJoinTeam(compRepo, ctx.competitionId, ctx.teams[0].teamId, pool[41].gamingMemberId);
    await passDeadline(ctx.competitionId);
    const err = await expectRejectsLazy(close(ctx), FreezeError);
    expect(err.code).toBe("PENDING_JOIN_REQUESTS");
    await decideJoinRequest(compRepo, req.competitionJoinRequestId, ctx.teams[0].captain.gamingMemberId, "REJECT", false);
    expect((await close(ctx)).state).toBe("READY_TO_PUBLISH");
  }, 120000);

  for (const format of FORMATS) {
    const r = RANGES[format];
    // The plan's configured bounds: the default minimum and a maximum three above it (never beyond the format's own range).
    const min = r.minLow;
    const max = Math.min(r.maxHigh, r.maxLow + 3);
    it(`[21-22] ${format}: a roster below the configured minimum (${min}) and above the configured maximum (${max}) refuses the freeze; exactly the bounds freezes`, async () => {
      const below = await ready(`${format.slice(7)}Below`, [min - 1, min, min, min], { format });
      await passDeadline(below.competitionId);
      const e1 = await expectRejectsLazy(close(below), FreezeError);
      expect(e1.code).toBe("ROSTER_BELOW_MINIMUM");
      expect(e1.message).toContain(String(min - 1));
      expect(await stateOf(below.competitionId)).toBe("TEAM_REGISTRATION_OPEN");

      const above = await ready(`${format.slice(7)}Above`, [max + 1, min, min, min], { format });
      await passDeadline(above.competitionId);
      const e2 = await expectRejectsLazy(close(above), FreezeError);
      expect(e2.code).toBe("ROSTER_ABOVE_MAXIMUM");
      expect(e2.message).toContain(String(max + 1));

      const exact = await ready(`${format.slice(7)}Exact`, [max, min, min, max], { format });
      await passDeadline(exact.competitionId);
      expect((await close(exact)).state).toBe("READY_TO_PUBLISH");
      const [freeze] = await freezeRows(exact.competitionId);
      expect(freeze.format_key).toBe(format);
      expect([freeze.roster_minimum, freeze.roster_maximum]).toEqual([min, max]);
      expect(freeze.member_count).toBe(max + min + min + max);
      for (const c of [below, above]) expect(await counts(c.competitionId)).toEqual({ freezes: 0, teams: 0, members: 0 });
    }, 240000);
  }

  it("[23-25] four valid rosters freeze: the snapshot is exactly the accepted teams, their captains and every membership, with a digest that recomputes", async () => {
    const ctx = await ready("FzOk", [5, 6, 7, 8]);
    await passDeadline(ctx.competitionId);
    const result = await close(ctx);
    expect(result.state).toBe("READY_TO_PUBLISH");
    expect(await stateOf(ctx.competitionId)).toBe("READY_TO_PUBLISH");

    const evidence = await compRepo.getRegistrationFreeze(ctx.competitionId);
    expect(evidence).not.toBeNull();
    const live = await rawQuery(
      `select t.competition_team_id, t.captain_gaming_member_id, coalesce(array_agg(m.gaming_member_id order by m.gaming_member_id::text collate "C") filter (where m.gaming_member_id is not null), '{}') as members
         from competition_teams t left join competition_team_memberships m on m.competition_team_id = t.competition_team_id where t.competition_id = $1 and t.status = 'ACCEPTED' group by t.competition_team_id order by t.competition_team_id::text collate "C"`, [ctx.competitionId]);
    expect(evidence!.teams).toHaveLength(4);
    expect(evidence!.teams.map((t) => t.competitionTeamId)).toEqual(live.map((l) => l.competition_team_id));
    expect(evidence!.teams.map((t) => t.captainGamingMemberId)).toEqual(live.map((l) => l.captain_gaming_member_id));
    expect(evidence!.teams.map((t) => t.memberGamingMemberIds)).toEqual(live.map((l) => l.members));
    expect(evidence!.teams.map((t) => t.position)).toEqual([1, 2, 3, 4]);
    expect(evidence!.teamCount).toBe(4);
    expect(evidence!.memberCount).toBe(5 + 6 + 7 + 8);
    // Every field the gate lists.
    const [planning] = await rawQuery("select planning_revision_id, registration_deadline_utc, roster_minimum, roster_maximum from competition_planning_revisions where competition_id = $1 order by revision_number desc limit 1", [ctx.competitionId]);
    expect(evidence!.competitionId).toBe(ctx.competitionId);
    expect(evidence!.planningRevisionId).toBe(planning.planning_revision_id);
    expect(evidence!.formatKey).toBe("SOCCER_5V5");
    expect([evidence!.rosterMinimum, evidence!.rosterMaximum]).toEqual([planning.roster_minimum, planning.roster_maximum]);
    expect(new Date(evidence!.registrationDeadlineUtc).toISOString()).toBe(planning.registration_deadline_utc.toISOString());
    expect(evidence!.frozenByGamingMemberId).toBe(ctx.organizer.gamingMemberId);
    expect(Date.parse(evidence!.frozenAt)).toBeGreaterThanOrEqual(planning.registration_deadline_utc.getTime());
    // The frozen timestamp is the DATABASE clock: close to now, never client supplied.
    expect(Math.abs(Date.now() - Date.parse(evidence!.frozenAt))).toBeLessThan(60_000);

    // The digest is deterministic: the application recomputes it from the evidence alone, and the database recomputes it from the stored children.
    const { computeRegistrationFreezeDigest, verifyRegistrationFreeze } = await loadFreeze();
    expect(computeRegistrationFreezeDigest(evidence!)).toBe(evidence!.snapshotDigest);
    expect(verifyRegistrationFreeze(evidence!)).toBe(true);
    expect(verifyRegistrationFreeze({ ...evidence!, rosterMaximum: evidence!.rosterMaximum + 1 })).toBe(false);
    const teamsJson = evidence!.teams.map((t) => ({ team: t.competitionTeamId, captain: t.captainGamingMemberId, members: t.memberGamingMemberIds }));
    const [viaDb] = await rawQuery("select competition_registration_freeze_digest($1, $2, $3, $4, $5, $6::timestamptz, $7::jsonb) as d",
      [evidence!.competitionId, evidence!.planningRevisionId, evidence!.formatKey, evidence!.rosterMinimum, evidence!.rosterMaximum, evidence!.registrationDeadlineUtc, JSON.stringify([...teamsJson].reverse())]);
    expect(viaDb.d).toBe(evidence!.snapshotDigest); // input order never matters

    // One member, one team: the frozen members are unique per freeze and equal the live memberships.
    const frozenMembers = await rawQuery("select gaming_member_id from competition_registration_freeze_members where competition_id = $1", [ctx.competitionId]);
    expect(new Set(frozenMembers.map((m) => m.gaming_member_id)).size).toBe(frozenMembers.length);
    const liveMembers = await rawQuery("select gaming_member_id from competition_team_memberships where competition_id = $1", [ctx.competitionId]);
    expect(frozenMembers.map((m) => m.gaming_member_id).sort()).toEqual(liveMembers.map((m) => m.gaming_member_id).sort());
  }, 120000);

  it("[25] a person who appears in two teams (a member of one, captain of another) refuses the freeze", async () => {
    const ctx = await ready("FzConflict");
    // The organizer chose a captain who is already a member of team 0: a state the public operations never check at team creation.
    await rawQuery("update competition_teams set captain_gaming_member_id = $1 where competition_team_id = $2", [ctx.teams[0].members[0], ctx.teams[1].teamId]);
    await passDeadline(ctx.competitionId);
    const err = await expectRejectsLazy(close(ctx), FreezeError);
    expect(err.code).toBe("MEMBER_CONFLICT");
    expect(await counts(ctx.competitionId)).toEqual({ freezes: 0, teams: 0, members: 0 });
  }, 120000);

  it("[26] an exact retry returns the same freeze, writes nothing, and never rebuilds the snapshot from changed data", async () => {
    const ctx = await ready("FzRetry");
    await passDeadline(ctx.competitionId);
    await close(ctx);
    const first = await compRepo.getRegistrationFreeze(ctx.competitionId);
    const before = await counts(ctx.competitionId);
    const again = await close(ctx);
    expect(again.state).toBe("READY_TO_PUBLISH");
    expect(await compRepo.getRegistrationFreeze(ctx.competitionId)).toEqual(first);
    expect(await counts(ctx.competitionId)).toEqual(before);
    // The live data changes behind the freeze (a service-side fixture): the retry still returns the ORIGINAL snapshot.
    await rawQuery("insert into competition_team_memberships (competition_id, competition_team_id, gaming_member_id, approved_by_gaming_member_id) values ($1, $2, $3, $4)", [ctx.competitionId, ctx.teams[0].teamId, pool[42].gamingMemberId, ctx.organizer.gamingMemberId]);
    await close(ctx);
    expect(await compRepo.getRegistrationFreeze(ctx.competitionId)).toEqual(first);
    expect(await counts(ctx.competitionId)).toEqual(before);
    // A retry by someone who is not the organizer is refused for that reason, and shows nothing.
    const stranger = await makeOperator("Retry Stranger");
    await expectRejects(close(ctx, stranger.gamingMemberId), CompetitionAccessDeniedError);
  }, 120000);

  it("[27] concurrent freezes create exactly one snapshot", async () => {
    const ctx = await ready("FzRace");
    await passDeadline(ctx.competitionId);
    const results = await Promise.allSettled(Array.from({ length: 8 }, () => close(ctx)));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(8);
    expect(await counts(ctx.competitionId)).toEqual({ freezes: 1, teams: 4, members: 20 });
    expect(new Set((await rawQuery("select snapshot_digest from competition_registration_freezes where competition_id = $1", [ctx.competitionId])).map((r) => r.snapshot_digest)).size).toBe(1);
  }, 120000);

  it("[28] an unrelated organizer, a non-organizer member, a null actor, an unknown or malformed competition and a revoked host cannot freeze", async () => {
    const ctx = await ready("FzAuth");
    await passDeadline(ctx.competitionId);
    const other = await makeOperator("Other Organizer");
    await expectRejects(close(ctx, other.gamingMemberId), CompetitionAccessDeniedError);
    await expectRejects(close(ctx, ctx.teams[0].captain.gamingMemberId), CompetitionAccessDeniedError); // a team captain (and any scorekeeper-only member) holds no organizer authority
    await expectRejects(close(ctx, pool[43].gamingMemberId), CompetitionAccessDeniedError);
    const nullActor = await service.rpc("close_team_registration_atomically", { p_competition_id: ctx.competitionId, p_organizer_gaming_member_id: null });
    expect(nullActor.error?.message ?? "").toContain("COMPETITION_ACCESS_DENIED");
    await expectRejects(closeTeamRegistration(compRepo, randomUUID(), ctx.organizer.gamingMemberId), CompetitionNotFoundError);
    await expect(closeTeamRegistration(compRepo, "not-a-uuid", ctx.organizer.gamingMemberId)).rejects.toBeInstanceOf(Error);
    expect(await counts(ctx.competitionId)).toEqual({ freezes: 0, teams: 0, members: 0 });

    // A former host: HOST_ACCESS_REVOKED, for the revoked host only, and nothing is frozen.
    const pilot = await hostPilot("FreezeRevoked");
    await savePlan(pilot.competitionId, pilot.host.gamingMemberId, { deadlineMs: Date.now() + 2 * DAY });
    await openTeamRegistration(compRepo, pilot.competitionId, pilot.host.gamingMemberId);
    await pilot.revoke();
    await expectRejects(closeTeamRegistration(compRepo, pilot.competitionId, pilot.host.gamingMemberId), HostAccessRevokedError);
    expect((await freezeRows(pilot.competitionId))).toHaveLength(0);
    // The real route says the same to a signed-in stranger and never reveals anything about the plan or the teams.
    const res = await closeRoute(request(`${COMP}/${ctx.competitionId}/close-team-registration`, "POST", await tokenFor(other)), ctxOf(ctx.competitionId));
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toMatch(/deadline|roster|plan\b|freez|digest|snapshot|member count/i);
  }, 180000);

  it("[29] executing the freeze changes only what the freeze accepts: the state moves to READY_TO_PUBLISH and one freeze (its four teams and every member) is recorded — no amendment proposal, decision or resolution, no fixture, draw, pairing, schedule, appeal or adjudication record, no further planning revision, and no other change to the competition", async () => {
    const ctx = await ready("FzNoFixtures");
    await passDeadline(ctx.competitionId);
    // Every public table that carries a competition_id, counted for THIS competition (names come from the catalog, never from the request), and the competition row itself.
    const scanned = (await rawQuery<{ table_name: string }>(
      `select c.table_name from information_schema.columns c join information_schema.tables t on t.table_schema = c.table_schema and t.table_name = c.table_name
        where c.table_schema = 'public' and c.column_name = 'competition_id' and t.table_type = 'BASE TABLE' order by c.table_name`)).map((r) => r.table_name);
    for (const name of scanned) expect(name).toMatch(/^[a-z0-9_]+$/);
    const snapshot = async () => {
      const counts: Record<string, number> = {};
      for (const name of scanned) counts[name] = (await rawQuery<{ n: number }>(`select count(*)::int as n from "${name}" where competition_id = $1`, [ctx.competitionId]))[0].n;
      const [competition] = await rawQuery("select * from competitions where competition_id = $1", [ctx.competitionId]);
      const revisions = createHash("sha256").update(JSON.stringify(await rawQuery("select * from competition_planning_revisions where competition_id = $1 order by revision_number", [ctx.competitionId]))).digest("hex");
      return { counts, competition, revisions };
    };
    const before = await snapshot();
    await close(ctx);
    expect(await stateOf(ctx.competitionId)).toBe("READY_TO_PUBLISH");
    const after = await snapshot();

    // The scan really sees these tables (so "unchanged" below is not vacuous), among them everything the later gates add that this freeze must not touch.
    for (const name of ["competitions", "competition_fixtures", "competition_planning_revisions", "competition_registration_freezes", "competition_plan_change_proposals", "competition_plan_change_decisions", "competition_plan_change_resolutions"]) {
      if (name !== "competitions") expect(scanned, name).toContain(name);
    }
    // The only row counts that change are the freeze's own: one freeze, its four teams, and one member row per membership the competition had.
    const changed = Object.fromEntries(Object.keys(after.counts).filter((name) => after.counts[name] !== before.counts[name]).map((name) => [name, after.counts[name] - before.counts[name]]));
    expect(changed).toEqual({
      competition_registration_freezes: 1,
      competition_registration_freeze_teams: 4,
      competition_registration_freeze_members: before.counts.competition_team_memberships,
    });
    // No fixture, and no amendment proposal, decision or resolution, exists afterwards.
    expect([after.counts.competition_fixtures, after.counts.competition_plan_change_proposals, after.counts.competition_plan_change_decisions, after.counts.competition_plan_change_resolutions]).toEqual([0, 0, 0, 0]);
    // The planning history is exactly what it was, and the competition row differs in its state alone.
    expect(after.revisions).toBe(before.revisions);
    const differing = Object.keys(after.competition).filter((column) => JSON.stringify(after.competition[column]) !== JSON.stringify(before.competition[column]));
    expect(differing).toEqual(["state"]);
    expect([before.competition.state, after.competition.state]).toEqual(["TEAM_REGISTRATION_OPEN", "READY_TO_PUBLISH"]);
  }, 120000);

  it("[30] after the freeze nothing that changes membership works: registration, teams, proposals, join requests and approvals are all refused", async () => {
    const ctx = await ready("FzAfter");
    await registerForCompetition(compRepo, ctx.competitionId, pool[40].gamingMemberId, true);
    await passDeadline(ctx.competitionId);
    // A rejected request that the organizer could otherwise still review (pre-deadline, rejected): its approval would change membership.
    const [rejected] = await rawQuery(
      `insert into competition_join_requests (competition_id, competition_team_id, requesting_gaming_member_id, status, created_at, decided_by_gaming_member_id, decided_at)
       values ($1, $2, $3, 'REJECTED', now() - interval '1 hour', $4, now() - interval '1 hour') returning competition_join_request_id`,
      [ctx.competitionId, ctx.teams[0].teamId, pool[41].gamingMemberId, ctx.teams[0].captain.gamingMemberId]);
    await close(ctx);
    const frozenBefore = await compRepo.getRegistrationFreeze(ctx.competitionId);
    const membershipsBefore = (await rawQuery("select count(*)::int n from competition_team_memberships where competition_id = $1", [ctx.competitionId]))[0].n;

    const attempts: Array<[string, () => Promise<unknown>]> = [
      ["register a new member", () => registerForCompetition(compRepo, ctx.competitionId, pool[42].gamingMemberId, true)],
      ["add a team", () => addCompetitionTeam(compRepo, ctx.competitionId, ctx.organizer.gamingMemberId, `Late ${RUN}`, captains[4].gamingMemberId)],
      ["propose a team", () => proposeCompetitionTeam(compRepo, ctx.competitionId, `Late ${RUN}`, pool[40].gamingMemberId)],
      ["request to join", () => requestJoinTeam(compRepo, ctx.competitionId, ctx.teams[0].teamId, pool[40].gamingMemberId)],
      ["review a rejected request", () => organizerReviewJoinRequest(compRepo, rejected.competition_join_request_id, ctx.organizer.gamingMemberId, "APPROVE", "After the freeze.")],
    ];
    for (const [label, run] of attempts) {
      await expect(run(), label).rejects.toBeInstanceOf(Error);
    }
    await expectRejects(registerForCompetition(compRepo, ctx.competitionId, pool[42].gamingMemberId, true), TeamRegistrationNotOpenError);
    await expectRejects(requestJoinTeam(compRepo, ctx.competitionId, ctx.teams[0].teamId, pool[40].gamingMemberId), TeamRegistrationNotOpenError);
    await expectRejects(organizerReviewJoinRequest(compRepo, rejected.competition_join_request_id, ctx.organizer.gamingMemberId, "APPROVE", "After the freeze."), TeamRegistrationNotOpenError);
    expect((await rawQuery("select count(*)::int n from competition_team_memberships where competition_id = $1", [ctx.competitionId]))[0].n).toBe(membershipsBefore);
    expect(await compRepo.getRegistrationFreeze(ctx.competitionId)).toEqual(frozenBefore);

    // Still true once the bracket is published: the freeze, not the state, is what keeps registration closed.
    const published = await publishCompetition(compRepo, ctx.competitionId, ctx.organizer.gamingMemberId, ctx.teams[0].teamId, ctx.teams[1].teamId, ctx.teams[2].teamId, ctx.teams[3].teamId,
      new Date(Date.now() + 3600_000).toISOString(), new Date(Date.now() + 7200_000).toISOString(), new Date(Date.now() + 10800_000).toISOString());
    expect(published.state).toBe("PUBLISHED");
    await expectRejects(registerForCompetition(compRepo, ctx.competitionId, pool[42].gamingMemberId, true), TeamRegistrationNotOpenError);
    await expectRejects(requestJoinTeam(compRepo, ctx.competitionId, ctx.teams[0].teamId, pool[40].gamingMemberId), TeamRegistrationNotOpenError);
    // The frozen roster is what fixtures are declared from.
    const declared = await declareRoster(compRepo, published.semifinal1FixtureId, ctx.teams[0].teamId, ctx.teams[0].captain.gamingMemberId, false, null, ctx.teams[0].members);
    expect(declared.competitionRosterRevisionId).toBeTruthy();
  }, 180000);

  it("[28b] a freeze that is not the open state's is refused for the state (no freeze exists for a draft, and a draft cannot be frozen)", async () => {
    const draft = await setUp("FzDraft", { open: false });
    await expectRejects(closeTeamRegistration(compRepo, draft.competitionId, draft.organizer.gamingMemberId), TeamRegistrationNotOpenError);
    expect(await counts(draft.competitionId)).toEqual({ freezes: 0, teams: 0, members: 0 });
  });
});

// =============================================================================================================================================
// [reads] the addressed view reports the deadline truthfully; discovery is unchanged
// =============================================================================================================================================

describe("[reads] the addressed competition view reports the server-derived registration status", () => {
  it("[31] before the deadline registration is accepting; after it, not; after the freeze, frozen; and the status is exactly the bounded set", async () => {
    const ctx = await setUp("ViewStatus", { teamCount: 4 });
    await fillRosters(ctx, [5, 5, 5, 5]);
    const viewer = pool[43];
    const open = await getCompetitionView(compRepo, ctx.competitionId, viewer.gamingMemberId);
    const deadline = await currentDeadlineIso(ctx.competitionId);
    expect(open.registration).toEqual({
      deadlineUtc: deadline, timeZone: "America/Costa_Rica", deadlineLocal: localMinute(ctx.deadlineMs), deadlinePassed: false, acceptingNewWrites: true, frozen: false,
    });
    expect(Object.keys(open.registration!).sort()).toEqual(["acceptingNewWrites", "deadlineLocal", "deadlinePassed", "deadlineUtc", "frozen", "timeZone"]);
    await passDeadline(ctx.competitionId);
    const passed = await getCompetitionView(compRepo, ctx.competitionId, viewer.gamingMemberId);
    expect(passed.registration).toMatchObject({ deadlinePassed: true, acceptingNewWrites: false, frozen: false });
    await closeTeamRegistration(compRepo, ctx.competitionId, ctx.organizer.gamingMemberId);
    const frozen = await getCompetitionView(compRepo, ctx.competitionId, viewer.gamingMemberId);
    expect(frozen.registration).toMatchObject({ deadlinePassed: true, acceptingNewWrites: false, frozen: true });
    // What a member sees never carries the plan's other contents, internal ids, a digest or authority.
    const text = JSON.stringify(frozen.registration);
    expect(text).not.toMatch(/venue|pitch|roster|restriction|digest|revision|gaming_member|organizer|[0-9a-f]{8}-[0-9a-f]{4}-/i);
    expect(JSON.stringify(frozen.fixtures)).toBe("[]");
    // The organizer alone also sees the freeze summary: team names and counts, no ids or digest.
    const organizerView = await getCompetitionView(compRepo, ctx.competitionId, ctx.organizer.gamingMemberId);
    expect(organizerView.registrationFreeze).toMatchObject({ teamCount: 4, memberCount: 20, rosterMinimum: 5 });
    expect(JSON.stringify(organizerView.registrationFreeze)).not.toMatch(/digest|[0-9a-f]{8}-[0-9a-f]{4}-/i);
    expect(frozen.registrationFreeze ?? null).toBeNull();
  }, 120000);

  it("[31b] a DRAFT competition shows no registration status (its plan is still a draft), and a competition with no plan shows none", async () => {
    const draft = await setUp("ViewDraft", { open: false });
    expect((await getCompetitionView(compRepo, draft.competitionId, pool[43].gamingMemberId)).registration).toBeNull();
    await ensurePool();
    const organizer = await makeOperator("Legacy View");
    const legacy = await createCompetition(compRepo, organizer.gamingMemberId, `LegacyView ${RUN}`, "SOCCER_5V5");
    competitionIds.push(legacy.competitionId);
    expect((await getCompetitionView(compRepo, legacy.competitionId, organizer.gamingMemberId)).registration).toBeNull();
  });

  it("[31c] the real view route returns the status uncached, and the status read is a server-only operation", async () => {
    const ctx = await setUp("ViewRoute");
    const token = await tokenFor(pool[43]);
    const res = await viewRoute(request(`${COMP}/${ctx.competitionId}`, "GET", token), ctxOf(ctx.competitionId));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    const body = await res.json();
    expect(body.view.registration).toMatchObject({ acceptingNewWrites: true, frozen: false, deadlinePassed: false });
    expect((await anon.rpc("get_competition_registration_status", { p_competition_id: ctx.competitionId })).error?.code).toBe("42501");
    const signedIn = createClient(supabaseUrl, supabaseAnonKey, { global: { headers: { authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } });
    expect((await signedIn.rpc("get_competition_registration_status", { p_competition_id: ctx.competitionId })).error?.code).toBe("42501");
    // Signed out: the existing refusal, unchanged.
    expect((await viewRoute(new Request(`${COMP}/${ctx.competitionId}`), ctxOf(ctx.competitionId))).status).toBe(401);
  });

  it("[32] general discovery is unchanged: the competition list carries no registration or freeze data", async () => {
    const ctx = await setUp("Discovery");
    const res = await listRoute(request(COMP, "GET", await tokenFor(pool[43])));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(Array.isArray(body.competitions)).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/registrationDeadline|registrationFreeze|acceptingNewWrites|deadlinePassed|snapshotDigest|deadlineUtc/);
    for (const c of body.competitions) {
      expect(Object.keys(c)).not.toContain("registration");
      expect(Object.keys(c)).not.toContain("registrationFreeze");
    }
    expect(body.competitions.some((c: { competitionId: string }) => c.competitionId === ctx.competitionId)).toBe(true);
  });
});

// =============================================================================================================================================
// [closed] UG-CR-GATE-SSS-007A Correction A — a competition without a usable plan is a CLOSED registration
// =============================================================================================================================================

describe("[closed] a competition that is not a draft and has no usable plan accepts nothing new and decides nothing pending (fail closed)", () => {
  /**
   * The legacy shape, built through the PUBLIC operations and then stripped of its plan by the database owner: open for team registration, two accepted
   * teams, registered members, one pending team proposal, one pending join request and one rejected join request, and NO planning revision at all.
   */
  async function legacyOpen(label: string) {
    const ctx = await setUp(label, { teamCount: 2 });
    for (const m of [pool[0], pool[1], pool[2], pool[3]]) await registerForCompetition(compRepo, ctx.competitionId, m.gamingMemberId, true);
    const proposal = await proposeCompetitionTeam(compRepo, ctx.competitionId, `Pending ${label.slice(0, 10)} ${RUN}`, pool[0].gamingMemberId);
    const request = await requestJoinTeam(compRepo, ctx.competitionId, ctx.teams[0].teamId, pool[1].gamingMemberId);
    const toReject = await requestJoinTeam(compRepo, ctx.competitionId, ctx.teams[1].teamId, pool[2].gamingMemberId);
    await decideJoinRequest(compRepo, toReject.competitionJoinRequestId, ctx.teams[1].captain.gamingMemberId, "REJECT", false);
    await removePlans(ctx.competitionId);
    expect((await rawQuery("select count(*)::int n from competition_planning_revisions where competition_id = $1", [ctx.competitionId]))[0].n).toBe(0);
    expect(await stateOf(ctx.competitionId)).toBe("TEAM_REGISTRATION_OPEN");
    return { ctx, proposal, request, rejected: toReject };
  }
  const NOT_OPEN = /TEAM_REGISTRATION_NOT_OPEN/;
  const DISCLOSES = /plan|deadline|roster|revision|venue|pitch|format/i;

  it("[A1] refuses a new registration, an organizer-added team (both signatures), a proposed team (both signatures) and a join request — and writes nothing", async () => {
    const { ctx } = await legacyOpen("ClosedIntake");
    const before = await rowCounts(ctx.competitionId);
    await expectRejects(registerForCompetition(compRepo, ctx.competitionId, pool[20].gamingMemberId, true), TeamRegistrationNotOpenError);
    await expectRejects(addCompetitionTeam(compRepo, ctx.competitionId, ctx.organizer.gamingMemberId, `Added ${RUN}`, captains[3].gamingMemberId), TeamRegistrationNotOpenError);
    await expectRejects(proposeCompetitionTeam(compRepo, ctx.competitionId, `Nope ${RUN}`, pool[3].gamingMemberId), TeamRegistrationNotOpenError);
    await expectRejects(requestJoinTeam(compRepo, ctx.competitionId, ctx.teams[1].teamId, pool[3].gamingMemberId), TeamRegistrationNotOpenError);
    // The older signatures too: an old overload must not be a way around the rule.
    const raw = [
      await service.rpc("add_competition_team_atomically", { p_competition_id: ctx.competitionId, p_organizer_gaming_member_id: ctx.organizer.gamingMemberId, p_name: `Old ${RUN}`, p_captain_gaming_member_id: captains[3].gamingMemberId }),
      await service.rpc("propose_competition_team_atomically", { p_competition_id: ctx.competitionId, p_name: `OldP ${RUN}`, p_proposing_gaming_member_id: pool[3].gamingMemberId }),
      await service.rpc("register_for_competition_atomically", { p_competition_id: ctx.competitionId, p_gaming_member_id: pool[21].gamingMemberId, p_is_adult_self_attested: true }),
      await service.rpc("request_join_competition_team_atomically", { p_competition_id: ctx.competitionId, p_competition_team_id: ctx.teams[1].teamId, p_requesting_gaming_member_id: pool[3].gamingMemberId }),
    ];
    for (const r of raw) {
      expect(r.error?.message ?? "no error").toMatch(NOT_OPEN);
      // Bounded: a caller who is told "closed" is told nothing about why, nor anything of the plan.
      expect(r.error?.message ?? "").not.toMatch(DISCLOSES);
    }
    expect(await rowCounts(ctx.competitionId)).toEqual(before);
    // An existing registration is still returned unchanged: a replay is not a new registration.
    expect((await registerForCompetition(compRepo, ctx.competitionId, pool[0].gamingMemberId, true)).alreadyRegistered).toBe(true);
  }, 120000);

  it("[A2] a pending proposal and pending join requests cannot be decided without the plan that dates them — and authority is still judged first", async () => {
    const { ctx, proposal, request, rejected } = await legacyOpen("ClosedDecide");
    const stranger = await makeOperator("Closed Stranger");
    // Authority first: nobody who is not entitled learns anything, plan or no plan.
    await expectRejects(decideCompetitionTeam(compRepo, proposal.competitionTeamId, stranger.gamingMemberId, "APPROVE", null), CompetitionAccessDeniedError);
    await expectRejects(decideJoinRequest(compRepo, request.competitionJoinRequestId, stranger.gamingMemberId, "APPROVE", false), NotTeamCaptainError);
    await expectRejects(decideJoinRequest(compRepo, request.competitionJoinRequestId, stranger.gamingMemberId, "APPROVE", true), CompetitionAccessDeniedError);
    await expectRejects(organizerReviewJoinRequest(compRepo, rejected.competitionJoinRequestId, stranger.gamingMemberId, "APPROVE", "Second look."), CompetitionAccessDeniedError);
    // The entitled callers are refused because registration is closed.
    for (const decision of ["APPROVE", "REJECT"] as const) {
      await expectRejects(decideCompetitionTeam(compRepo, proposal.competitionTeamId, ctx.organizer.gamingMemberId, decision, decision === "REJECT" ? "Closed." : null), TeamRegistrationNotOpenError);
      await expectRejects(decideJoinRequest(compRepo, request.competitionJoinRequestId, ctx.teams[0].captain.gamingMemberId, decision, false), TeamRegistrationNotOpenError);
      await expectRejects(decideJoinRequest(compRepo, request.competitionJoinRequestId, ctx.organizer.gamingMemberId, decision, true), TeamRegistrationNotOpenError);
      await expectRejects(organizerReviewJoinRequest(compRepo, rejected.competitionJoinRequestId, ctx.organizer.gamingMemberId, decision, "Second look."), TeamRegistrationNotOpenError);
    }
    const statuses = async () => ({
      proposal: (await rawQuery("select status from competition_teams where competition_team_id = $1", [proposal.competitionTeamId]))[0].status,
      request: (await rawQuery("select status from competition_join_requests where competition_join_request_id = $1", [request.competitionJoinRequestId]))[0].status,
      rejected: (await rawQuery("select status, organizer_reviewed_at from competition_join_requests where competition_join_request_id = $1", [rejected.competitionJoinRequestId]))[0],
      memberships: (await rowCounts(ctx.competitionId)).memberships,
    });
    expect(await statuses()).toEqual({ proposal: "PENDING_ORGANIZER_APPROVAL", request: "REQUESTED", rejected: { status: "REJECTED", organizer_reviewed_at: null }, memberships: 0 });
    // The one safe operational exit for such a competition is its existing cancellation.
    await cancelCompetition(compRepo, ctx.competitionId, ctx.organizer.gamingMemberId, "Opened before registration planning existed; no usable plan.");
    expect(await stateOf(ctx.competitionId)).toBe("CANCELLED_WITHOUT_CHAMPION");
  }, 120000);

  it("[A3] the freeze is refused too (the plan is missing), and the view reports no status — so a page cannot offer a control", async () => {
    const { ctx } = await legacyOpen("ClosedView");
    const err = await expectRejects(closeTeamRegistration(compRepo, ctx.competitionId, ctx.organizer.gamingMemberId), TeamRegistrationCapacityNotReachedError); // two teams only: the count answers first, unchanged
    expect(err.message).toMatch(/found 2/);
    const view = await getCompetitionView(compRepo, ctx.competitionId, pool[0].gamingMemberId);
    expect(view.registration).toBeNull();
    expect(view.registrationReadiness ?? null).toBeNull();
    expect(await compRepo.getRegistrationStatus(ctx.competitionId)).toBeNull();
    const body = await (await viewRoute(request(`${COMP}/${ctx.competitionId}`, "GET", await tokenFor(pool[0])), ctxOf(ctx.competitionId))).json();
    expect(body.view.registration ?? null).toBeNull();
    expect(JSON.stringify(body.view)).not.toMatch(/acceptingNewWrites/);
  }, 120000);

  it("[A4] a competition whose state follows an open one, and which has no plan and no freeze, accepts nothing either", async () => {
    for (const state of ["READY_TO_PUBLISH", "PUBLISHED"]) {
      const { ctx } = await legacyOpen(`Closed${state.slice(0, 5)}`);
      // A bounded service-side fixture: the legacy lifecycle (before the freeze existed) reached these states without a plan or a freeze.
      await rawQuery("update competitions set state = $2 where competition_id = $1", [ctx.competitionId, state]);
      const before = await rowCounts(ctx.competitionId);
      await expectRejects(registerForCompetition(compRepo, ctx.competitionId, pool[20].gamingMemberId, true), TeamRegistrationNotOpenError);
      await expectRejects(requestJoinTeam(compRepo, ctx.competitionId, ctx.teams[1].teamId, pool[3].gamingMemberId), TeamRegistrationNotOpenError);
      expect(await rowCounts(ctx.competitionId), state).toEqual(before);
    }
  }, 180000);

  it("[A6] the two rules themselves never return successfully without a current plan, in any state — a draft's team preparation is allowed by the operation that owns it, not by the rules", async () => {
    await ensurePool();
    const organizer = await makeOperator("Strict Rules");
    const draft = await createCompetition(compRepo, organizer.gamingMemberId, `StrictRules ${RUN}`, "SOCCER_5V5");
    competitionIds.push(draft.competitionId);
    const { ctx } = await legacyOpen("StrictOpen");
    for (const [label, id] of [["a draft with no plan", draft.competitionId], ["a legacy open competition with no plan", ctx.competitionId], ["a competition that does not exist", randomUUID()]] as const) {
      for (const statement of [
        `select competition_assert_registration_intake_open('${id}')`,
        `select competition_assert_registration_decision_allowed('${id}', 'APPROVE', now() - interval '1 day')`,
        `select competition_assert_registration_decision_allowed('${id}', 'REJECT', now() - interval '1 day')`,
      ]) {
        const refused = await violation(statement);
        expect(refused?.message ?? "no error", `${label}: ${statement}`).toMatch(/TEAM_REGISTRATION_NOT_OPEN/);
        expect(refused?.message ?? "", `${label}`).not.toMatch(DISCLOSES);
      }
    }
    // The draft's organizer can still prepare its teams (registration has not opened, so nothing is judged by the deadline rule) …
    await addCompetitionTeam(compRepo, draft.competitionId, organizer.gamingMemberId, `Prepared ${RUN}`, captains[0].gamingMemberId);
    // … but nobody can register for, propose into or join a draft, and the answer is the same bounded one.
    await expectRejects(registerForCompetition(compRepo, draft.competitionId, pool[0].gamingMemberId, true), Error);
    const [team] = await rawQuery("select competition_team_id from competition_teams where competition_id = $1", [draft.competitionId]);
    await expectRejects(requestJoinTeam(compRepo, draft.competitionId, team.competition_team_id, pool[0].gamingMemberId), TeamRegistrationNotOpenError);
    expect((await rawQuery("select count(*)::int n from competition_registrations where competition_id = $1", [draft.competitionId]))[0].n).toBe(0);
  }, 120000);

  const UNUSABLE: Array<[string, PlanOverride, number]> = [
    ["roster bounds outside the format's registry range (1 to 2)", { rosterMinimum: 1, rosterMaximum: 2 }, 0],
    ["a roster minimum above the registry's range for the format (9 to 10)", { rosterMinimum: 9, rosterMaximum: 10 }, 0],
    ["a format that is not the competition's own", { formatKey: "SOCCER_6V6" }, 0],
    ["a deadline finer than a millisecond", {}, 500],
  ];
  for (const [label, override, micros] of UNUSABLE) {
    it(`[A5] a malformed plan is closed: ${label} accepts no new entry, decides nothing pending, shows no status and cannot be frozen`, async () => {
      const ctx = await setUp(`Bad${label.slice(0, 8)}`, { teamCount: 4 });
      await fillRosters(ctx, [5, 5, 5, 5]);
      await registerForCompetition(compRepo, ctx.competitionId, pool[30].gamingMemberId, true);
      const proposal = await proposeCompetitionTeam(compRepo, ctx.competitionId, `BadP ${RUN}`, pool[30].gamingMemberId);
      await registerForCompetition(compRepo, ctx.competitionId, pool[32].gamingMemberId, true);
      const pendingJoin = await requestJoinTeam(compRepo, ctx.competitionId, ctx.teams[0].teamId, pool[32].gamingMemberId);
      // A deadline still ahead (so only the plan's own validity can close the door), recorded with the malformed content.
      const future = micros > 0 ? shiftExact(new Date(Date.now() + 2 * DAY).toISOString().slice(0, 19) + ".000Z", micros) : new Date(Date.now() + 2 * DAY).toISOString();
      await supersedePlan(ctx.competitionId, future, override);
      const before = await rowCounts(ctx.competitionId);
      await expectRejects(registerForCompetition(compRepo, ctx.competitionId, pool[31].gamingMemberId, true), TeamRegistrationNotOpenError);
      await expectRejects(proposeCompetitionTeam(compRepo, ctx.competitionId, `BadQ ${RUN}`, pool[31].gamingMemberId), TeamRegistrationNotOpenError);
      await expectRejects(addCompetitionTeam(compRepo, ctx.competitionId, ctx.organizer.gamingMemberId, `BadA ${RUN}`, captains[4].gamingMemberId), TeamRegistrationNotOpenError);
      await expectRejects(requestJoinTeam(compRepo, ctx.competitionId, ctx.teams[1].teamId, pool[31].gamingMemberId), TeamRegistrationNotOpenError);
      await expectRejects(decideCompetitionTeam(compRepo, proposal.competitionTeamId, ctx.organizer.gamingMemberId, "REJECT", "Closed."), TeamRegistrationNotOpenError);
      await expectRejects(decideJoinRequest(compRepo, pendingJoin.competitionJoinRequestId, ctx.teams[0].captain.gamingMemberId, "APPROVE", false), TeamRegistrationNotOpenError);
      await expectRejects(decideJoinRequest(compRepo, pendingJoin.competitionJoinRequestId, ctx.organizer.gamingMemberId, "REJECT", true), TeamRegistrationNotOpenError);
      expect(await rowCounts(ctx.competitionId)).toEqual(before);
      expect(await compRepo.getRegistrationStatus(ctx.competitionId)).toBeNull();
      // And the freeze: with the deadline passed, the plan is still the problem. (A service-side fixture resolves the one pending proposal that the closed
      // plan refuses to decide, so that the freeze's own refusal is the plan's and not the pending work's.)
      await rawQuery("update competition_teams set status = 'REJECTED', rejection_reason = 'fixture', decided_at = now(), decided_by_gaming_member_id = $2 where competition_team_id = $1", [proposal.competitionTeamId, ctx.organizer.gamingMemberId]);
      await rawQuery("update competition_join_requests set status = 'REJECTED', decided_at = now(), decided_by_gaming_member_id = $2 where competition_join_request_id = $1", [pendingJoin.competitionJoinRequestId, ctx.teams[0].captain.gamingMemberId]);
      await passDeadline(ctx.competitionId, 0, override, micros);
      const err = await expectRejectsLazy(closeTeamRegistration(compRepo, ctx.competitionId, ctx.organizer.gamingMemberId), FreezeError);
      expect(err.code).toBe("PLAN_INVALID");
      expect(await counts(ctx.competitionId)).toEqual({ freezes: 0, teams: 0, members: 0 });
      expect(await stateOf(ctx.competitionId)).toBe("TEAM_REGISTRATION_OPEN");
    }, 180000);
  }
});

// =============================================================================================================================================
// [precision] UG-CR-GATE-SSS-007A Correction B — a deadline keeps its exact instant through the millisecond
// =============================================================================================================================================

describe("[precision] a deadline with milliseconds opens, closes registration at equality, freezes, and keeps the fraction in its digest", () => {
  const FRACTIONS = [0, 100, 250, 999];
  const futureWithFraction = (fractionMs: number) => new Date(Math.ceil((Date.now() + 2 * DAY) / 1000) * 1000 + fractionMs).toISOString();

  it("[B1] the public save keeps accepting what Organizer Planning accepted and widens nothing: a zero fraction passes; a non-zero fraction that is not the local minute, or more than three digits, is refused", async () => {
    const { planToRpcPayload, parsePlanningPlan } = await loadPlanning();
    const organizer = await makeOperator("Precision Public");
    const created = await createCompetition(compRepo, organizer.gamingMemberId, `PrecisionPublic ${RUN}`, "SOCCER_5V5");
    competitionIds.push(created.competitionId);
    const payload = JSON.parse(JSON.stringify(planToRpcPayload(parsePlanningPlan(rawPlan({ deadlineMs: Date.now() + 3 * DAY }), "SOCCER_5V5"))));
    const baseUtc = String(payload.registration_deadline.utc).replace(/\.\d+Z$/, "");
    const save = (utc: string) => service.rpc("save_competition_planning_revision_atomically", {
      p_competition_id: created.competitionId, p_organizer_gaming_member_id: organizer.gamingMemberId, p_intent_id: randomUUID(),
      p_plan: { ...payload, registration_deadline: { ...payload.registration_deadline, utc } },
    });
    for (const fraction of ["", ".0", ".00", ".000"]) expect((await save(`${baseUtc}${fraction}Z`)).error, `${fraction || "none"}`).toBeNull();
    for (const fraction of [".1", ".25", ".250", ".999"]) expect((await save(`${baseUtc}${fraction}Z`)).error?.message ?? "no error", fraction).toMatch(/DEADLINE_UTC_MISMATCH/);
    for (const fraction of [".0000", ".2500", ".123456"]) expect((await save(`${baseUtc}${fraction}Z`)).error?.message ?? "no error", fraction).toMatch(/DEADLINE_UTC_INVALID/);
  }, 120000);

  for (const fraction of FRACTIONS) {
    const label = `.${String(fraction).padStart(3, "0")}Z`;

    it(`[B2] ${label}: the status reports the exact instant, and every new-entry operation is accepted one microsecond before it and refused at it and after it`, async () => {
      const ctx = await setUp(`Fx${fraction}`);
      const deadline = futureWithFraction(fraction);
      await supersedePlan(ctx.competitionId, deadline);
      expect(await currentDeadlineIso(ctx.competitionId)).toBe(deadline);
      const view = await getCompetitionView(compRepo, ctx.competitionId, pool[43].gamingMemberId);
      expect(view.registration).toMatchObject({ deadlineUtc: deadline, deadlinePassed: false, acceptingNewWrites: true, frozen: false });
      for (const op of INTAKE_OPS) {
        const extra = await op.setup(ctx);
        const rowsBefore = (await rawQuery(`select count(*)::int n from ${op.table} where competition_id = $1`, [ctx.competitionId]))[0].n;
        const accepted = await atInstant(shiftExact(deadline, -1), op.statement, op.args(ctx, extra));
        expect(accepted, `${op.name}: one microsecond before ${deadline}`).toMatchObject({ ok: true });
        for (const [when, instant] of [["exactly the deadline", deadline], ["one microsecond after", shiftExact(deadline, 1)], ["one millisecond after", shiftExact(deadline, 1000)]] as const) {
          const refused = await atInstant(instant, op.statement, op.args(ctx, extra));
          expect(refused.ok, `${op.name}: ${when} (${deadline})`).toBe(false);
          expect(!refused.ok && refused.message, `${op.name}: ${when}`).toMatch(/TEAM_REGISTRATION_NOT_OPEN/);
        }
        expect((await rawQuery(`select count(*)::int n from ${op.table} where competition_id = $1`, [ctx.competitionId]))[0].n, op.name).toBe(rowsBefore);
      }
    }, 240000);

    it(`[B6] ${label}: a draft whose current plan carries the fraction opens registration — the opening judges the exact instant, to the microsecond`, async () => {
      const organizer = await makeOperator(`Open Fx${fraction}`);
      const created = await createCompetition(compRepo, organizer.gamingMemberId, `OpenFx ${fraction} ${RUN}`, "SOCCER_5V5");
      competitionIds.push(created.competitionId);
      await savePlan(created.competitionId, organizer.gamingMemberId, { deadlineMs: Date.now() + 3 * DAY });
      const deadline = futureWithFraction(fraction);
      await supersedePlan(created.competitionId, deadline);
      const call = "select * from open_team_registration_atomically($1, $2)";
      const args = [created.competitionId, organizer.gamingMemberId];
      expect(await atInstant(shiftExact(deadline, -1), call, args), `one microsecond before ${deadline}`).toMatchObject({ ok: true });
      const onIt = await atInstant(deadline, call, args);
      expect(onIt.ok, `exactly ${deadline}`).toBe(false);
      expect(!onIt.ok && onIt.message).toContain("REGISTRATION_OPENING_DEADLINE_EXPIRED");
      expect(await stateOf(created.competitionId)).toBe("DRAFT"); // both were rolled back
      expect((await openTeamRegistration(compRepo, created.competitionId, organizer.gamingMemberId)).state).toBe("TEAM_REGISTRATION_OPEN");
      const view = await getCompetitionView(compRepo, created.competitionId, pool[43].gamingMemberId);
      expect(view.registration).toMatchObject({ deadlineUtc: deadline, acceptingNewWrites: true });
    }, 120000);

    it(`[B3] ${label}: the freeze is refused one microsecond before the deadline and reached at it; then a real freeze records the exact instant and a digest that keeps the fraction`, async () => {
      const ctx = await setUp(`Fz${fraction}`, { teamCount: 4 });
      await fillRosters(ctx, [5, 6, 7, 8]);
      const deadline = futureWithFraction(fraction);
      await supersedePlan(ctx.competitionId, deadline);
      const call = "select * from close_team_registration_atomically($1, $2)";
      const args = [ctx.competitionId, ctx.organizer.gamingMemberId];
      const early = await atInstant(shiftExact(deadline, -1), call, args);
      expect(!early.ok && early.message).toContain("REGISTRATION_FREEZE_DEADLINE_NOT_REACHED");
      const onIt = await atInstant(deadline, call, args);
      expect(onIt, `the freeze at exactly ${deadline}`).toMatchObject({ ok: true });

      // A real freeze, with a deadline that has passed by the real clock and carries the same fraction.
      const passed = await passDeadline(ctx.competitionId, fraction);
      expect(passed.endsWith(label)).toBe(true);
      expect((await closeTeamRegistration(compRepo, ctx.competitionId, ctx.organizer.gamingMemberId)).state).toBe("READY_TO_PUBLISH");
      const evidence = await compRepo.getRegistrationFreeze(ctx.competitionId);
      expect(new Date(evidence!.registrationDeadlineUtc).toISOString()).toBe(passed);
      const [stored] = await freezeRows(ctx.competitionId);
      expect(stored.registration_deadline_utc.toISOString()).toBe(passed);
      expect(Date.parse(evidence!.frozenAt)).toBeGreaterThanOrEqual(Date.parse(passed));
      const { computeRegistrationFreezeDigest } = await loadFreeze();
      expect(computeRegistrationFreezeDigest(evidence!)).toBe(evidence!.snapshotDigest);
      const teamsJson = evidence!.teams.map((t) => ({ team: t.competitionTeamId, captain: t.captainGamingMemberId, members: t.memberGamingMemberIds }));
      const [viaDb] = await rawQuery("select competition_registration_freeze_digest($1, $2, $3, $4, $5, $6::timestamptz, $7::jsonb) as d",
        [evidence!.competitionId, evidence!.planningRevisionId, evidence!.formatKey, evidence!.rosterMinimum, evidence!.rosterMaximum, passed, JSON.stringify(teamsJson)]);
      expect(viaDb.d).toBe(evidence!.snapshotDigest);
      // The deadline line of the canonical text is the instant to the millisecond.
      const sameInstantOtherMilli = await rawQuery("select competition_registration_freeze_digest($1, $2, $3, $4, $5, ($6::timestamptz + interval '1 millisecond'), $7::jsonb) as d",
        [evidence!.competitionId, evidence!.planningRevisionId, evidence!.formatKey, evidence!.rosterMinimum, evidence!.rosterMaximum, passed, JSON.stringify(teamsJson)]);
      expect(sameInstantOtherMilli[0].d).not.toBe(evidence!.snapshotDigest);
    }, 240000);
  }

  it("[B4] the digest keeps every millisecond apart: .000, .100, .250 and .999 never share one, in the database and in the application, and the two agree", async () => {
    const { computeRegistrationFreezeDigest } = await loadFreeze();
    const ids = { c: randomUUID(), r: randomUUID(), t: randomUUID(), cap: randomUUID(), m: randomUUID() };
    const seen = new Map<string, string>();
    for (const fraction of FRACTIONS) {
      const deadline = `2026-11-01T00:00:00.${String(fraction).padStart(3, "0")}Z`;
      const [viaDb] = await rawQuery("select competition_registration_freeze_digest($1, $2, 'SOCCER_5V5', 5, 8, $3::timestamptz, $4::jsonb) as d",
        [ids.c, ids.r, deadline, JSON.stringify([{ team: ids.t, captain: ids.cap, members: [ids.m] }])]);
      const viaApp = computeRegistrationFreezeDigest({
        competitionId: ids.c, planningRevisionId: ids.r, formatKey: "SOCCER_5V5", rosterMinimum: 5, rosterMaximum: 8, registrationDeadlineUtc: deadline,
        teams: [{ competitionTeamId: ids.t, captainGamingMemberId: ids.cap, memberGamingMemberIds: [ids.m] }],
      });
      expect(viaDb.d, deadline).toBe(viaApp);
      expect(seen.has(viaDb.d), `${deadline} must not collide with ${seen.get(viaDb.d)}`).toBe(false);
      seen.set(viaDb.d, deadline);
    }
    expect(seen.size).toBe(4);
    // A deadline finer than a millisecond is refused by the digest itself: nothing is ever rounded into another instant's digest.
    const fine = await violation("select competition_registration_freeze_digest($1, $2, 'SOCCER_5V5', 5, 8, '2026-11-01T00:00:00.0005Z'::timestamptz, '[]'::jsonb)", [ids.c, ids.r]);
    expect(fine?.message ?? "no error").toMatch(/REGISTRATION_FREEZE_INVALID/);
  });

  it("[B5] the freeze table itself holds the precision: a stored deadline is a whole number of milliseconds", async () => {
    const defs = await rawQuery(`select conname, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'public.competition_registration_freezes'::regclass and contype = 'c'`);
    expect(defs.map((d) => `${d.conname} ${d.def}`).join("\n")).toMatch(/registration_deadline_utc = date_trunc\('milliseconds'/);
    const ctx = await setUp("PrecisionTable", { teamCount: 4 });
    await fillRosters(ctx, [5, 5, 5, 5]);
    await passDeadline(ctx.competitionId, 250);
    await closeTeamRegistration(compRepo, ctx.competitionId, ctx.organizer.gamingMemberId);
    const [row] = await freezeRows(ctx.competitionId);
    const fine = await violation(
      `insert into competition_registration_freezes (competition_id, planning_revision_id, format_key, roster_minimum, roster_maximum, registration_deadline_utc, frozen_at, frozen_by_gaming_member_id, team_count, member_count, snapshot_digest)
       values ($1, $2, $3, $4, $5, $6::timestamptz + interval '500 microseconds', now(), $7, 4, 0, $8)`,
      [row.competition_id, row.planning_revision_id, row.format_key, row.roster_minimum, row.roster_maximum, row.registration_deadline_utc.toISOString(), row.frozen_by_gaming_member_id, row.snapshot_digest]);
    expect(fine?.code).toBe("23514");
    expect(fine?.constraint ?? "").toMatch(/deadline_precision/);
  }, 120000);
});

// =============================================================================================================================================
// [regression] the existing 5v5 flow, ordering, invitations and creation paths
// =============================================================================================================================================

describe("[regression] existing behavior that must not change", () => {
  it("[39] the existing five-a-side four-team flow still runs end to end when it is given a valid plan", async () => {
    const ctx = await setUp("Flow5", { teamCount: 4 });
    // Members join through the real operations, before the deadline.
    for (let t = 0; t < 4; t++) {
      for (let k = 0; k < 5; k++) {
        const member = pool[t * 5 + k];
        await registerForCompetition(compRepo, ctx.competitionId, member.gamingMemberId, true);
        const req = await requestJoinTeam(compRepo, ctx.competitionId, ctx.teams[t].teamId, member.gamingMemberId);
        const decided = await decideJoinRequest(compRepo, req.competitionJoinRequestId, ctx.teams[t].captain.gamingMemberId, "APPROVE", false);
        expect(decided.competitionTeamMembershipId).not.toBeNull();
        ctx.teams[t].members.push(member.gamingMemberId);
      }
    }
    await passDeadline(ctx.competitionId);
    expect((await closeTeamRegistration(compRepo, ctx.competitionId, ctx.organizer.gamingMemberId)).state).toBe("READY_TO_PUBLISH");
    const published = await publishCompetition(compRepo, ctx.competitionId, ctx.organizer.gamingMemberId, ctx.teams[0].teamId, ctx.teams[1].teamId, ctx.teams[2].teamId, ctx.teams[3].teamId,
      new Date(Date.now() + 3600_000).toISOString(), new Date(Date.now() + 7200_000).toISOString(), new Date(Date.now() + 10800_000).toISOString());
    expect(published.state).toBe("PUBLISHED");
    const roster = await declareRoster(compRepo, published.semifinal1FixtureId, ctx.teams[0].teamId, ctx.teams[0].captain.gamingMemberId, false, null, ctx.teams[0].members);
    expect(roster.fixtureState).toBe("SCHEDULED");
  }, 240000);

  it("[40] formats other than five-a-side stay unavailable through every public creation path", async () => {
    await ensurePool();
    const operator = await makeOperator("Creation Probe");
    for (const format of ["SOCCER_6V6", "SOCCER_7V7", "SOCCER_8V8"]) {
      await expect(createCompetition(compRepo, operator.gamingMemberId, `Nope ${format} ${RUN}`, format)).rejects.toBeInstanceOf(UnsupportedActivityKeyError);
      const res = await generalCreateRoute(request(COMP, "POST", await tokenFor(operator), { name: `Nope ${format} ${RUN}`, activityKey: format }));
      expect(res.status).toBe(400);
    }
    const { data } = await service.from("competitions").select("activity_key").eq("organizer_gaming_member_id", operator.gamingMemberId);
    expect(data).toEqual([]);
  });

  it("[37] the organizer/revocation ordering is intact in all nine functions: lock, then ownership, then host guard, then the deadline rule, then any write", async () => {
    const defs = await rawQuery(`select p.proname, pg_get_function_arguments(p.oid) as args, pg_get_functiondef(p.oid) as def from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = any($1)`, [[...NINE]]);
    const organizerGated = new Set(["open_team_registration_atomically", "close_team_registration_atomically", "add_competition_team_atomically", "decide_competition_team_atomically", "decide_join_request_atomically", "organizer_review_join_request_atomically"]);
    for (const row of defs.filter((d) => organizerGated.has(d.proname))) {
      const def: string = row.def;
      const lock = def.indexOf("pg_advisory_xact_lock(hashtext('competition_scope:'");
      const denied = def.indexOf("COMPETITION_ACCESS_DENIED");
      const guard = def.indexOf("assert_competition_not_host_revoked(");
      const firstWrite = def.search(/\binsert\s+into\b|\bdelete\s+from\b|(?<!for\s)\bupdate\s+[a-z_.]+\s+set\b/i);
      expect(lock, row.proname).toBeGreaterThan(-1);
      expect(lock, `${row.proname} lock before guard`).toBeLessThan(guard);
      expect(guard, `${row.proname} ownership before guard`).toBeGreaterThan(denied);
      expect(guard, `${row.proname} guard before first write`).toBeLessThan(firstWrite);
      // The FIRST place the function applies the deadline rule (a helper or the clock itself) comes after the host guard.
      const rule = Math.min(...[def.indexOf("competition_assert_registration_"), def.indexOf("competition_registration_clock()")].filter((i) => i > -1));
      expect(rule, `${row.proname} deadline rule after the host guard`).toBeGreaterThan(guard);
    }
  });

  it("[38] invitation and public-code resolution are unchanged by the freeze", async () => {
    const ctx = await setUp("Invite", { teamCount: 1 });
    const [{ public_code }] = await rawQuery("select public_code from competitions where competition_id = $1", [ctx.competitionId]);
    const [{ public_code: teamCode }] = await rawQuery("select public_code from competition_teams where competition_team_id = $1", [ctx.teams[0].teamId]);
    const resolved = await service.rpc("resolve_competition_team_public_code_atomically", { p_competition_public_code: public_code, p_team_public_code: teamCode });
    expect(resolved.error).toBeNull();
    await passDeadline(ctx.competitionId);
    const afterDeadline = await service.rpc("resolve_competition_team_public_code_atomically", { p_competition_public_code: public_code, p_team_public_code: teamCode });
    expect(afterDeadline.error).toBeNull(); // resolving a code grants nothing and the deadline does not touch it
    const open = await openRoute(request(`${COMP}/${ctx.competitionId}/open-team-registration`, "POST", await tokenFor(ctx.organizer)), ctxOf(ctx.competitionId));
    expect(open.status).toBe(409); // already open: the existing state refusal, with the plan never consulted
  });
});
