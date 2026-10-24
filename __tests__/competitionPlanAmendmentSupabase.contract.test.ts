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
import { appointScorekeeper } from "../lib/gaming/competitions/appointScorekeeper";
import { declareRoster } from "../lib/gaming/competitions/declareRoster";
import { getCompetitionView } from "../lib/gaming/competitions/getCompetitionView";
import {
  CompetitionAccessDeniedError, CompetitionNotFoundError, CompetitionNotDraftError, HostAccessRevokedError, NotTeamCaptainError,
  TeamRegistrationNotOpenError, TeamRegistrationCapacityNotReachedError, UnsupportedActivityKeyError,
} from "../lib/gaming/competitions/types";
import type { SoccerFormatKey } from "../lib/gaming/competitions/formats";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";
// The REAL route handlers, called with real user access tokens against the real local database.
import { POST as hostCreateRoute } from "../app/api/gaming/host/competition/route";
import { POST as registerRoute } from "../app/api/gaming/competitions/[competitionId]/register/route";
import { POST as closeRoute } from "../app/api/gaming/competitions/[competitionId]/close-team-registration/route";
import { POST as openRoute } from "../app/api/gaming/competitions/[competitionId]/open-team-registration/route";
import { GET as viewRoute } from "../app/api/gaming/competitions/[competitionId]/route";
import { GET as listRoute, POST as generalCreateRoute } from "../app/api/gaming/competitions/route";

/**
 * UG-CR-GATE-SSS-011 — Post-Freeze Plan Amendment backend foundation, against a real (disposable, loopback-only) Postgres.
 *
 * Proves, in the database itself: a proposal is separate immutable evidence that never touches the current planning revision; only the four FROZEN captains
 * (from the registration-freeze snapshot) can confirm or reject it, all four must confirm, and the fourth confirmation atomically revalidates everything and
 * creates the next immutable revision; one rejection ends the proposal; the lifetime is the earlier of 24 hours or 12 hours before the first window, by the
 * database clock only; the organizer's proposal is the organizer's consent; withdrawal, supersession, expiry, replay and concurrency are exact; authority and
 * visibility are limited to the active organizer and the four captains; and the DRAFT planning save, the registration freeze and the format registry are unchanged.
 *
 * CLOCK. The decision instant is competition_registration_clock() (SSS-007): this file redefines it ONLY inside transactions it rolls back, to put the
 * database clock on an exact instant. Nothing public changes the clock. Service-side fixtures (the database owner) are used only to build the frozen
 * competition quickly, to age a proposal past its expiry, and to inject a state no public path can create — each is named where it is used.
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
const AMENDMENT_RPCS = [
  "propose_competition_plan_amendment_atomically", "decide_competition_plan_amendment_atomically", "withdraw_competition_plan_amendment_atomically", "get_competition_plan_amendment_status",
] as const;
const AMENDMENT_TABLES = ["competition_plan_change_proposals", "competition_plan_change_decisions", "competition_plan_change_resolutions"] as const;

// Loaded lazily: until the module exists, only the tests that need it can fail.
const loadFreeze = () => import("../lib/gaming/competitions/registrationFreeze");
const loadPlanning = () => import("../lib/gaming/competitions/planning");
const loadAmend = () => import("../lib/gaming/competitions/planAmendment");
const loadRoutes = async () => ({
  base: (await import("../app/api/gaming/competitions/[competitionId]/plan-amendment/route")) as unknown as Record<string, (r: Request, c: { params: { competitionId: string } }) => Promise<Response>>,
  decision: (await import("../app/api/gaming/competitions/[competitionId]/plan-amendment/decision/route")) as unknown as Record<string, (r: Request, c: { params: { competitionId: string } }) => Promise<Response>>,
  withdraw: (await import("../app/api/gaming/competitions/[competitionId]/plan-amendment/withdraw/route")) as unknown as Record<string, (r: Request, c: { params: { competitionId: string } }) => Promise<Response>>,
});

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
const localMinute = (utcMs: number, offsetMs = CR_OFFSET_MS) => new Date(utcMs + offsetMs).toISOString().slice(0, 16);
const localDate = (utcMs: number, offsetMs = CR_OFFSET_MS) => new Date(utcMs + offsetMs).toISOString().slice(0, 10);

function rawPlan(opts: { deadlineMs: number; format?: Format; minimum?: number; maximum?: number; timeZone?: string; offsetMs?: number }) {
  const format = opts.format ?? "SOCCER_5V5";
  const range = RANGES[format];
  // The configured roster: the format's default minimum and a maximum three above the range's low end (never beyond its high end).
  const maximum = opts.maximum ?? Math.min(range.maxHigh, range.maxLow + 3);
  return {
    venue: { name: `Cancha ${RUN}`, locationDescription: "Calle 5, San José, behind the central market", timeZone: opts.timeZone ?? "America/Costa_Rica", simultaneousMatchCapacity: 1, restrictionNotes: "No metal cleats." },
    pitches: [{ label: "A", usable: true, supportedFormats: [format], restrictionNotes: "" }],
    dates: [{ date: localDate(opts.deadlineMs + 3 * DAY, opts.offsetMs), windows: [{ start: "09:00", end: "13:00" }] }],
    roster: { minimum: opts.minimum ?? range.minLow, maximum },
    registrationDeadline: { local: localMinute(opts.deadlineMs, opts.offsetMs), timeZone: opts.timeZone ?? "America/Costa_Rica" },
    rules: { version: "draft-1", snapshot: "Draft registration rules, version one." },
  };
}

async function savePlan(competitionId: string, organizerId: string, opts: { deadlineMs: number; format?: Format; minimum?: number; maximum?: number; timeZone?: string; offsetMs?: number }) {
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
 * Service-side fixture: lets the deadline pass WITHOUT waiting, by recording a later revision (see supersedePlan) whose deadline is the START OF THE CURRENT
 * MINUTE. A minute-resolution instant is the only kind the public planning save can record, and an amendment re-judges the complete plan with the same
 * validation, so the frozen competition must carry a deadline that validation accepts. The returned instant is exactly what was stored.
 */
async function passDeadline(competitionId: string): Promise<string> {
  const stored = new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString();
  await supersedePlan(competitionId, stored);
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
async function setUp(label: string, opts: { format?: Format; deadlineMs?: number; open?: boolean; minimum?: number; maximum?: number; teamCount?: number; timeZone?: string; offsetMs?: number } = {}): Promise<Ctx> {
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
  await savePlan(created.competitionId, organizer.gamingMemberId, { deadlineMs, format, minimum: opts.minimum, maximum: opts.maximum, timeZone: opts.timeZone, offsetMs: opts.offsetMs });
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

const REQUIRED = 4;
type Facts = {
  venue: { name: string; locationDescription: string; restrictionNotes: string; simultaneousMatchCapacity: number };
  pitches: Array<{ label: string; usable: boolean; supportedFormats: SoccerFormatKey[]; restrictionNotes: string }>;
  dates: Array<{ date: string; windows: Array<{ start: string; end: string }> }>;
};
type Decision = "CONFIRMED" | "REJECTED";

/** A valid amendable proposal: a new venue, one pitch, and one date `daysAhead` days from now (venue-local), with one window. Nothing preserved is in it. */
function facts(over: Partial<Facts> & { daysAhead?: number; offsetMs?: number; start?: string; end?: string; name?: string } = {}): Facts {
  const base: Facts = {
    venue: { name: over.name ?? `Amended Venue ${RUN}`, locationDescription: "Calle 9, San José, behind the old market", restrictionNotes: "Lights off at 21:00.", simultaneousMatchCapacity: 1 },
    pitches: [{ label: "A", usable: true, supportedFormats: ["SOCCER_5V5"], restrictionNotes: "" }],
    dates: [{ date: localDate(Date.now() + (over.daysAhead ?? 6) * DAY, over.offsetMs), windows: [{ start: over.start ?? "10:00", end: over.end ?? "14:00" }] }],
  };
  return { venue: over.venue ?? base.venue, pitches: over.pitches ?? base.pitches, dates: over.dates ?? base.dates };
}
/** The same facts as the repository sends them to the database. */
const rpcPayload = (f: Facts) => ({
  venue: { name: f.venue.name, location_description: f.venue.locationDescription, restriction_notes: f.venue.restrictionNotes, simultaneous_match_capacity: f.venue.simultaneousMatchCapacity },
  pitches: f.pitches.map((p) => ({ label: p.label, usable: p.usable, supported_formats: p.supportedFormats, restriction_notes: p.restrictionNotes })),
  dates: f.dates.map((d) => ({ date: d.date, windows: d.windows.map((w) => ({ start: w.start, end: w.end })) })),
});
/** The instant the earliest window of these facts opens, given the venue's constant UTC offset. */
const firstWindowMs = (f: Facts, offsetMs = CR_OFFSET_MS) => Math.min(...f.dates.flatMap((d) => d.windows.map((w) => Date.parse(`${d.date}T${w.start}:00Z`) - offsetMs)));

/** A frozen competition: four organizer-created teams whose rosters were filled, the deadline passed (service-side fixture) and registration frozen through the real close. */
async function frozen(label: string, opts: { timeZone?: string; offsetMs?: number } = {}): Promise<Ctx> {
  const ctx = await setUp(label, { teamCount: 4, ...opts });
  await fillRosters(ctx, [5, 5, 5, 5]);
  await passDeadline(ctx.competitionId);
  expect((await closeTeamRegistration(compRepo, ctx.competitionId, ctx.organizer.gamingMemberId)).state).toBe("READY_TO_PUBLISH");
  return ctx;
}

const propose = (ctx: Ctx, f: Facts = facts(), intent: string = randomUUID()) => compRepo.proposePlanAmendment(ctx.competitionId, ctx.organizer.gamingMemberId, intent, f);
const decide = (ctx: Ctx, team: number, digest: string, decision: Decision) => compRepo.decidePlanAmendment(ctx.competitionId, ctx.teams[team].captain.gamingMemberId, digest, decision);
const withdraw = (ctx: Ctx, digest: string) => compRepo.withdrawPlanAmendment(ctx.competitionId, ctx.organizer.gamingMemberId, digest);
const statusFor = (ctx: Ctx, memberId: string) => compRepo.getPlanAmendmentStatus(ctx.competitionId, memberId);
const currentRevision = (competitionId: string) => compRepo.getCurrentPlanningRevision(competitionId);
const revisionCount = async (competitionId: string) => (await rawQuery("select count(*)::int n from competition_planning_revisions where competition_id = $1", [competitionId]))[0].n as number;
const amendmentRow = async (digest: string) => (await rawQuery("select * from competition_plan_change_proposals where amendment_digest = $1", [digest]))[0];
const resolutionOf = async (digest: string) => (await rawQuery("select r.* from competition_plan_change_resolutions r join competition_plan_change_proposals a on a.plan_amendment_id = r.plan_amendment_id where a.amendment_digest = $1", [digest]))[0] ?? null;
const decisionRows = async (digest: string) => rawQuery("select d.* from competition_plan_change_decisions d join competition_plan_change_proposals a on a.plan_amendment_id = d.plan_amendment_id where a.amendment_digest = $1 order by d.decided_at", [digest]);
const amendmentCounts = async (competitionId: string) => ({
  proposals: (await rawQuery("select count(*)::int n from competition_plan_change_proposals where competition_id = $1", [competitionId]))[0].n as number,
  decisions: (await rawQuery("select count(*)::int n from competition_plan_change_decisions where competition_id = $1", [competitionId]))[0].n as number,
  resolutions: (await rawQuery("select count(*)::int n from competition_plan_change_resolutions where competition_id = $1", [competitionId]))[0].n as number,
});
/** A hash of everything the freeze recorded for one competition: the header, its four teams and every member. It must never change. */
async function freezeEvidenceHash(competitionId: string): Promise<string> {
  const rows = await rawQuery(
    `select (select coalesce(jsonb_agg(to_jsonb(f) order by f.registration_freeze_id), '[]') from competition_registration_freezes f where f.competition_id = $1) as freezes,
            (select coalesce(jsonb_agg(to_jsonb(t) order by t.position), '[]') from competition_registration_freeze_teams t where t.competition_id = $1) as teams,
            (select coalesce(jsonb_agg(to_jsonb(m) order by m.gaming_member_id), '[]') from competition_registration_freeze_members m where m.competition_id = $1) as members`, [competitionId]);
  return createHash("sha256").update(JSON.stringify(rows[0])).digest("hex");
}
/** A hash of the planning facts the current revision holds (revision id and number, every column and every child). */
async function currentPlanHash(competitionId: string): Promise<string> {
  const rows = await rawQuery(
    `select to_jsonb(r) as rev,
            (select coalesce(jsonb_agg(to_jsonb(p) order by p.position), '[]') from competition_planning_pitches p where p.planning_revision_id = r.planning_revision_id) as pitches,
            (select coalesce(jsonb_agg(to_jsonb(d) order by d.position), '[]') from competition_planning_dates d where d.planning_revision_id = r.planning_revision_id) as dates,
            (select coalesce(jsonb_agg(to_jsonb(w) order by w.plan_date, w.window_index), '[]') from competition_planning_windows w where w.planning_revision_id = r.planning_revision_id) as windows
       from competition_planning_revisions r where r.competition_id = $1 order by r.revision_number desc limit 1`, [competitionId]);
  const row = rows[0];
  delete row.pitches; // pitch ids are random per revision; the revision id already pins them
  return createHash("sha256").update(JSON.stringify(row)).digest("hex");
}
/** Service-side fixture (the database owner, row triggers off): moves a proposal's creation and expiry into the past, as if the time had really gone by. */
async function age(digest: string, hours: number): Promise<void> {
  const db = new Client({ connectionString: supabaseDbUrl, statement_timeout: 60000 });
  await db.connect();
  try {
    await db.query("set session_replication_role = replica");
    await db.query("update competition_plan_change_proposals set created_at = created_at - ($2 || ' hours')::interval, expires_at = expires_at - ($2 || ' hours')::interval where amendment_digest = $1", [digest, String(hours)]);
  } finally { await db.end().catch(() => {}); }
}
/** Publishes the bracket (the competition leaves READY_TO_PUBLISH and fixtures exist). */
const publishNow = (ctx: Ctx) => publishCompetition(compRepo, ctx.competitionId, ctx.organizer.gamingMemberId, ctx.teams[0].teamId, ctx.teams[1].teamId, ctx.teams[2].teamId, ctx.teams[3].teamId,
  new Date(Date.now() + 3600_000).toISOString(), new Date(Date.now() + 7200_000).toISOString(), new Date(Date.now() + 10800_000).toISOString());
/** The existing cancellation (allowed in READY_TO_PUBLISH). */
const cancelNow = (ctx: Ctx) => cancelCompetition(compRepo, ctx.competitionId, ctx.organizer.gamingMemberId, "Closed after a plan change was recorded.");
/** A hash of every proposal, decision and resolution of one competition and the identity of its planning revisions: a retry must leave it exactly as it was. */
async function amendmentSnapshot(competitionId: string): Promise<string> {
  const rows = await rawQuery(
    `select (select coalesce(jsonb_agg(to_jsonb(a) order by a.sequence_number), '[]') from competition_plan_change_proposals a where a.competition_id = $1) as proposals,
            (select coalesce(jsonb_agg(to_jsonb(d) order by d.decided_at, d.competition_team_id), '[]') from competition_plan_change_decisions d where d.competition_id = $1) as decisions,
            (select coalesce(jsonb_agg(to_jsonb(r) order by r.resolved_at, r.plan_amendment_id), '[]') from competition_plan_change_resolutions r where r.competition_id = $1) as resolutions,
            (select coalesce(jsonb_agg(v.planning_revision_id order by v.revision_number), '[]') from competition_planning_revisions v where v.competition_id = $1) as revisions`, [competitionId]);
  return createHash("sha256").update(JSON.stringify(rows[0])).digest("hex");
}
const PROPOSE_SQL = "select propose_competition_plan_amendment_atomically($1, $2, $3, $4::jsonb) as r";
const DECIDE_SQL = "select decide_competition_plan_amendment_atomically($1, $2, $3, $4) as r";
const STATUS_SQL = "select get_competition_plan_amendment_status($1, $2) as r";
const typed = <E extends Error>(name: string) => async () => ((await loadAmend()) as unknown as Record<string, new (...args: any[]) => E>)[name];

// =============================================================================================================================================
// [fixture] control: the frozen competition every test below starts from really is one (this passes before the feature exists)
// =============================================================================================================================================

describe("[fixture] a frozen competition can be built through the public lifecycle", () => {
  it("READY_TO_PUBLISH, one freeze, four distinct captains, no fixture, and the planning chain is intact", async () => {
    const ctx = await frozen("Fixture");
    expect(await stateOf(ctx.competitionId)).toBe("READY_TO_PUBLISH");
    expect(await freezeRows(ctx.competitionId)).toHaveLength(1);
    const frozenTeams = await rawQuery("select captain_gaming_member_id from competition_registration_freeze_teams where competition_id = $1", [ctx.competitionId]);
    expect(new Set(frozenTeams.map((t) => t.captain_gaming_member_id)).size).toBe(4);
    expect((await rawQuery("select count(*)::int n from competition_fixtures where competition_id = $1", [ctx.competitionId]))[0].n).toBe(0);
    expect((await currentRevision(ctx.competitionId))?.revisionNumber).toBe(2); // the saved plan, then the deadline fixture's later revision
  }, 120000);
});

// =============================================================================================================================================
// [schema] server-only, append-only, internal helpers, and who can call what
// =============================================================================================================================================

describe("[schema] the amendment evidence is server-only and append-only; the helpers are internal; the four RPCs are service-role only", () => {
  it("[24] each table exists, has row-level security, no policy, and not even the server role can read or write it directly", async () => {
    const rows = await rawQuery(
      `select c.relname, c.relrowsecurity as rls, (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies,
              has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE') as anon, has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE') as auth,
              has_table_privilege('service_role', c.oid, 'SELECT') as svc_select, has_table_privilege('service_role', c.oid, 'INSERT,UPDATE,DELETE,TRUNCATE') as svc_write,
              (select count(*)::int from pg_class k, aclexplode(coalesce(k.relacl, acldefault('r', k.relowner))) a where k.oid = c.oid and a.grantee = 0) as public_grants
         from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname = any($1) order by c.relname`, [[...AMENDMENT_TABLES]]);
    expect(rows.map((r) => r.relname)).toEqual([...AMENDMENT_TABLES].sort());
    for (const r of rows) {
      expect(r.rls, r.relname).toBe(true);
      expect(r.policies, r.relname).toBe(0);
      expect([r.anon, r.auth, r.svc_select, r.svc_write, r.public_grants], r.relname).toEqual([false, false, false, false, 0]);
    }
  });

  it("[24] anon and a signed-in browser client are refused (42501) by every amendment table", async () => {
    const person = await newPerson("Amendment Table Probe");
    const signedIn = createClient(supabaseUrl, supabaseAnonKey, { global: { headers: { authorization: `Bearer ${await tokenFor(person)}` } }, auth: { persistSession: false, autoRefreshToken: false } });
    for (const table of AMENDMENT_TABLES) {
      for (const client of [anon, signedIn]) {
        expect((await client.from(table).select("*").limit(1)).error?.code, `${table} select`).toBe("42501");
        expect((await client.from(table).insert({}).select()).error?.code, `${table} insert`).toBe("42501");
        expect((await client.from(table).delete().neq("competition_id", randomUUID())).error?.code, `${table} delete`).toBe("42501");
      }
      expect((await service.from(table).select("*").limit(1)).error?.code, `${table} service select`).toBe("42501");
      expect((await service.from(table).insert({}).select()).error?.code, `${table} service insert`).toBe("42501");
    }
  });

  it("[24] UPDATE, DELETE and TRUNCATE are refused by trigger on every amendment table, even for the database owner (a rolled-back control on real rows)", async () => {
    const ctx = await frozen("Immutable");
    const p = await propose(ctx);
    for (let i = 0; i < 3; i++) await decide(ctx, i, p.digest, "CONFIRMED");
    await decide(ctx, 3, p.digest, "REJECTED");
    expect(await resolutionOf(p.digest)).not.toBeNull();
    for (const table of AMENDMENT_TABLES) {
      for (const statement of [`update ${table} set competition_id = competition_id where competition_id = '${ctx.competitionId}'`, `delete from ${table} where competition_id = '${ctx.competitionId}'`, `truncate table ${table} cascade`]) {
        const v = await violation(statement);
        expect(v?.message ?? "no error", `${table}: ${statement}`).toMatch(/PLAN_AMENDMENT_IMMUTABLE/);
      }
    }
  }, 120000);

  it("[24] every internal helper — and every trigger function — is executable by nobody (not PUBLIC, anon, authenticated or service_role) and pins its search_path", async () => {
    const rows = await rawQuery(
      `select p.oid, p.oid::regprocedure::text as signature, p.proconfig::text as cfg from pg_proc p
        where p.pronamespace = 'public'::regnamespace and p.prokind = 'f'
          and (p.proname ~ '^competition_plan_amendment_' or p.proname in ('competition_validate_planning_plan', 'competition_insert_planning_revision', 'competition_assert_plan_amendment_window', 'competition_registration_freeze_consistent'))
        order by 2`);
    expect(rows.length, rows.map((r) => r.signature).join(", ")).toBeGreaterThanOrEqual(8);
    for (const row of rows) {
      expect(row.cfg, row.signature).toContain("search_path=public");
      for (const role of ["anon", "authenticated", "service_role"]) {
        expect((await rawQuery("select has_function_privilege($1, $2::oid, 'EXECUTE') as ok", [role, row.oid]))[0].ok, `${role} must not execute ${row.signature}`).toBe(false);
      }
      expect((await rawQuery(`select count(*)::int as n from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = $1::oid and a.grantee = 0 and a.privilege_type = 'EXECUTE'`, [row.oid]))[0].n, `PUBLIC must not execute ${row.signature}`).toBe(0);
    }
  });

  it("[24] exactly four RPCs exist, each SECURITY DEFINER with a pinned search_path, executable by the server role alone, and none accepts a time of any kind", async () => {
    const rows = await rawQuery(
      `select p.oid, p.proname, p.prosecdef, p.proconfig::text as cfg, pg_get_function_arguments(p.oid) as args from pg_proc p
        where p.pronamespace = 'public'::regnamespace and p.proname ~ 'plan_amendment' and p.proname !~ '^competition_' and p.prokind = 'f' order by p.proname`);
    expect(rows.map((r) => r.proname)).toEqual([...AMENDMENT_RPCS].sort());
    for (const row of rows) {
      expect(row.prosecdef, row.proname).toBe(true);
      expect(row.cfg, row.proname).toContain("search_path=public");
      expect((await rawQuery("select has_function_privilege('service_role', $1::oid, 'EXECUTE') as ok", [row.oid]))[0].ok, row.proname).toBe(true);
      for (const role of ["anon", "authenticated"]) expect((await rawQuery("select has_function_privilege($1, $2::oid, 'EXECUTE') as ok", [role, row.oid]))[0].ok, `${role} must not execute ${row.proname}`).toBe(false);
      expect(String(row.args), row.proname).not.toMatch(/timestamp|date\b|interval|time\b/i);
    }
    const token = await tokenFor(await newPerson("RPC Probe"));
    const signedIn = createClient(supabaseUrl, supabaseAnonKey, { global: { headers: { authorization: `Bearer ${token}` } }, auth: { persistSession: false, autoRefreshToken: false } });
    for (const client of [anon, signedIn]) {
      expect((await client.rpc("get_competition_plan_amendment_status", { p_competition_id: randomUUID(), p_caller_gaming_member_id: randomUUID() })).error?.code).toBe("42501");
      expect((await client.rpc("decide_competition_plan_amendment_atomically", { p_competition_id: randomUUID(), p_captain_gaming_member_id: randomUUID(), p_amendment_digest: "x", p_decision: "CONFIRMED" })).error?.code).toBe("42501");
    }
  });

  it("[21] the DRAFT planning save now DELEGATES to the shared validator and inserter (and still has no insert of its own)", async () => {
    const [save] = await rawQuery("select pg_get_functiondef('public.save_competition_planning_revision_atomically(uuid, uuid, uuid, jsonb)'::regprocedure) as def");
    const def = String(save.def);
    expect(def).toContain("competition_validate_planning_plan(");
    expect(def).toContain("competition_insert_planning_revision(");
    expect(def).not.toMatch(/insert\s+into\s+competition_planning_(revisions|pitches|dates|windows|pitch_formats)/i);
    expect(def).toContain("COMPETITION_ACCESS_DENIED");
    expect(def).toContain("assert_competition_not_host_revoked(");
    expect(def.indexOf("pg_advisory_xact_lock")).toBeLessThan(def.indexOf("assert_competition_not_host_revoked("));
    expect(def.indexOf("COMPETITION_NOT_DRAFT")).toBeLessThan(def.indexOf("competition_validate_planning_plan("));
    const [grants] = await rawQuery("select has_function_privilege('service_role', 'public.save_competition_planning_revision_atomically(uuid, uuid, uuid, jsonb)'::regprocedure, 'EXECUTE') as svc, has_function_privilege('anon', 'public.save_competition_planning_revision_atomically(uuid, uuid, uuid, jsonb)'::regprocedure, 'EXECUTE') as anon");
    expect([grants.svc, grants.anon]).toEqual([true, false]);
  });
});

// =============================================================================================================================================
// [pending] a pending proposal never touches the current plan, the freeze, or the registration status
// =============================================================================================================================================

describe("[1][22] a pending proposal changes nothing that is current, and nothing the freeze recorded", () => {
  it("the current revision, its children, the registration status, the freeze evidence and the competition row are byte-identical while a proposal is pending", async () => {
    const ctx = await frozen("Isolation");
    const before = { plan: await currentPlanHash(ctx.competitionId), freeze: await freezeEvidenceHash(ctx.competitionId), revisions: await revisionCount(ctx.competitionId), current: (await currentRevision(ctx.competitionId))!.planningRevisionId,
      registration: await compRepo.getRegistrationStatus(ctx.competitionId), state: await stateOf(ctx.competitionId),
      competition: (await rawQuery("select * from competitions where competition_id = $1", [ctx.competitionId]))[0] };
    const p = await propose(ctx);
    expect(p.alreadyProposed).toBe(false);
    for (let i = 0; i < 3; i++) await decide(ctx, i, p.digest, "CONFIRMED");
    const after = { plan: await currentPlanHash(ctx.competitionId), freeze: await freezeEvidenceHash(ctx.competitionId), revisions: await revisionCount(ctx.competitionId), current: (await currentRevision(ctx.competitionId))!.planningRevisionId,
      registration: await compRepo.getRegistrationStatus(ctx.competitionId), state: await stateOf(ctx.competitionId),
      competition: (await rawQuery("select * from competitions where competition_id = $1", [ctx.competitionId]))[0] };
    expect(after).toEqual(before);
    expect((await amendmentCounts(ctx.competitionId))).toEqual({ proposals: 1, decisions: 3, resolutions: 0 });
    expect((await statusFor(ctx, ctx.organizer.gamingMemberId))?.amendment?.status).toBe("PENDING");
    // The SSS-004 planning route's own read and the SSS-007 helpers see the accepted plan, never the proposal.
    const [plan] = await rawQuery("select planning_revision_id from competition_current_registration_plan($1)", [ctx.competitionId]);
    expect(plan.planning_revision_id).toBe(before.current);
    expect((await currentRevision(ctx.competitionId))!.venue.name).not.toBe(facts().venue.name);
  }, 180000);
});

// =============================================================================================================================================
// [immutable] preserved facts can neither be supplied nor change
// =============================================================================================================================================

describe("[2][3] only the amendable sections are accepted; every preserved fact is composed from the current revision", () => {
  const RAW = (ctx: Ctx, amendment: unknown) => service.rpc("propose_competition_plan_amendment_atomically", { p_competition_id: ctx.competitionId, p_organizer_gaming_member_id: ctx.organizer.gamingMemberId, p_intent_id: randomUUID(), p_amendment: amendment });

  it("a preserved or system field at any level is refused by name by the database itself, and nothing is written", async () => {
    const ctx = await frozen("Immutable Fields");
    const ok = rpcPayload(facts());
    const attempts: Array<[string, Record<string, unknown>]> = [
      ["time_zone (top)", { ...ok, time_zone: "America/Chicago" }],
      ["roster", { ...ok, roster: { minimum: 6, maximum: 9 } }],
      ["registration_deadline", { ...ok, registration_deadline: { local: "2030-01-01T00:00", time_zone: "America/Costa_Rica", utc_offset_minutes: -360, utc: "2030-01-01T06:00:00.000Z" } }],
      ["rules", { ...ok, rules: { version: "x", snapshot: "y" } }],
      ["format", { ...ok, format: "SOCCER_6V6" }],
      ["activity_key", { ...ok, activity_key: "SOCCER_6V6" }],
      ["teams", { ...ok, teams: [] }],
      ["captains", { ...ok, captains: [] }],
      ["members", { ...ok, members: [] }],
      ["venue.time_zone", { ...ok, venue: { ...ok.venue, time_zone: "America/Chicago" } }],
    ];
    for (const [label, body] of attempts) {
      const { error } = await RAW(ctx, body);
      expect(error?.message ?? "no error", label).toMatch(/PLAN_AMENDMENT_INVALID: IMMUTABLE_FIELD/);
    }
    const unknown = await RAW(ctx, { ...ok, surprise: 1 });
    expect(unknown.error?.message ?? "no error").toMatch(/UNKNOWN_FIELD/);
    expect((await RAW(ctx, { ...ok, venue: { ...ok.venue, surprise: 1 } })).error?.message ?? "no error").toMatch(/UNKNOWN_FIELD/);
    expect((await RAW(ctx, "not an object")).error?.message ?? "no error").toMatch(/PLAN_AMENDMENT_INVALID/);
    expect(await amendmentCounts(ctx.competitionId)).toEqual({ proposals: 0, decisions: 0, resolutions: 0 });
  }, 120000);

  it("the application refuses the same fields before the database is asked, and sends only the three amendable sections", async () => {
    const ctx = await frozen("Immutable App");
    const { PlanAmendmentValidationError } = await loadAmend();
    const sneaky = { ...facts(), roster: { minimum: 6, maximum: 9 } } as unknown as Facts;
    await expectRejectsLazy(propose(ctx, sneaky), async () => PlanAmendmentValidationError);
    expect((await amendmentCounts(ctx.competitionId)).proposals).toBe(0);
  }, 120000);

  it("[3] every amendable section really changes on activation, and every preserved fact is identical to the previous revision (row and children)", async () => {
    const ctx = await frozen("Allowlist");
    const baseRev = (await rawQuery("select * from competition_planning_revisions where competition_id = $1 order by revision_number desc limit 1", [ctx.competitionId]))[0];
    const proposed: Facts = {
      venue: { name: `Brand New Venue ${RUN}`, locationDescription: "Avenida 3, Alajuela", restrictionNotes: "Bring your own water.", simultaneousMatchCapacity: 2 },
      pitches: [
        { label: "North", usable: true, supportedFormats: ["SOCCER_5V5", "SOCCER_6V6"], restrictionNotes: "Grass." },
        { label: "South", usable: true, supportedFormats: ["SOCCER_5V5"], restrictionNotes: "" },
        { label: "Spare", usable: false, supportedFormats: ["SOCCER_5V5"], restrictionNotes: "Under repair." },
      ],
      dates: [
        { date: localDate(Date.now() + 8 * DAY), windows: [{ start: "15:00", end: "18:00" }, { start: "09:00", end: "12:00" }] },
        { date: localDate(Date.now() + 7 * DAY), windows: [{ start: "10:00", end: "13:00" }] },
      ],
    };
    const p = await propose(ctx, proposed);
    for (let i = 0; i < 4; i++) await decide(ctx, i, p.digest, "CONFIRMED");
    const next = (await rawQuery("select * from competition_planning_revisions where competition_id = $1 order by revision_number desc limit 1", [ctx.competitionId]))[0];
    expect(next.revision_number).toBe(baseRev.revision_number + 1);
    expect(next.supersedes_revision_id).toBe(baseRev.planning_revision_id);
    for (const column of ["format_key", "roster_minimum", "roster_maximum", "registration_deadline_local", "registration_deadline_time_zone", "registration_deadline_utc_offset_minutes", "registration_deadline_utc", "rules_version", "rules_snapshot", "rules_snapshot_digest", "venue_time_zone", "competition_id"]) {
      expect(next[column], column).toEqual(baseRev[column]);
    }
    expect([next.venue_name, next.venue_location_description, next.venue_restriction_notes, next.simultaneous_match_capacity]).toEqual([proposed.venue.name, "Avenida 3, Alajuela", "Bring your own water.", 2]);
    const revision = (await currentRevision(ctx.competitionId))!;
    expect(revision.pitches.map((x) => [x.label, x.usable, x.supportedFormats, x.restrictionNotes])).toEqual([["North", true, ["SOCCER_5V5", "SOCCER_6V6"], "Grass."], ["South", true, ["SOCCER_5V5"], ""], ["Spare", false, ["SOCCER_5V5"], "Under repair."]]);
    expect(revision.dates.map((d) => [d.date, d.windows.map((w) => `${w.start}-${w.end}`)])).toEqual([[proposed.dates[1].date, ["10:00-13:00"]], [proposed.dates[0].date, ["09:00-12:00", "15:00-18:00"]]]);
    // The revision that is current was written by the organizer, linked to the exact previous revision, and the freeze still points at the one it froze.
    expect(next.authored_by_gaming_member_id).toBe(ctx.organizer.gamingMemberId);
    expect((await freezeRows(ctx.competitionId))[0].planning_revision_id).toBe(baseRev.planning_revision_id);
  }, 180000);
});

// =============================================================================================================================================
// [digest] one canonical text, the same in the application and in the database
// =============================================================================================================================================

describe("[4][5] the digest is the same in TypeScript and SQL, order-independent where the facts are unordered, and binds the exact proposal", () => {
  const VECTOR_PLAN = {
    venue: { name: "Cancha Nueva", location_description: "Calle 9, San José\nbehind the market", time_zone: "America/Costa_Rica", simultaneous_match_capacity: 1, restriction_notes: "No metal cleats." },
    pitches: [
      { label: "A", usable: true, supported_formats: ["SOCCER_5V5", "SOCCER_6V6"], restriction_notes: "" },
      { label: "B", usable: false, supported_formats: ["SOCCER_5V5"], restriction_notes: "Lights off after 21:00." },
    ],
    dates: [{ date: "2026-11-07", windows: [{ start: "09:00", end: "13:00" }] }, { date: "2026-11-08", windows: [{ start: "09:00", end: "13:00" }, { start: "15:00", end: "19:00" }] }],
    roster: { minimum: 5, maximum: 8 },
    registration_deadline: { local: "2026-10-31T18:00", time_zone: "America/Costa_Rica", utc_offset_minutes: -360, utc: "2026-11-01T00:00:00.000Z" },
    rules: { version: "draft-1", snapshot: "Draft planning rules." },
  };
  const sha = (t: string) => createHash("sha256").update(t, "utf8").digest("hex");
  const KNOWN = "808d065b2ba21925099be3858cbcf4a7e5cbe537073f4184881e8065e9a2f429";
  const digestSql = async (plan: unknown, seq = 3) => (await rawQuery("select competition_plan_amendment_digest($1, $2, $3, $4, 'SOCCER_5V5', $5::jsonb) as d",
    ["11111111-1111-4111-8111-111111111111", sha("freeze"), "22222222-2222-4222-8222-222222222222", seq, JSON.stringify(plan)]))[0].d as string;

  it("the database function returns the independently computed known answer — the same value the application's unit test pins", async () => {
    expect(await digestSql(VECTOR_PLAN)).toBe(KNOWN);
  });

  it("it does not depend on the order dates, windows and supported formats arrive in, and it changes with the sequence", async () => {
    const shuffled = JSON.parse(JSON.stringify(VECTOR_PLAN));
    shuffled.dates.reverse();
    for (const d of shuffled.dates) d.windows.reverse();
    for (const p of shuffled.pitches) p.supported_formats.reverse();
    expect(await digestSql(shuffled)).toBe(KNOWN);
    expect(await digestSql(VECTOR_PLAN, 4)).not.toBe(KNOWN);
    const hostile = JSON.parse(JSON.stringify(VECTOR_PLAN));
    hostile.venue.name = "x\nsequence:99\nformat:SOCCER_8V8";
    expect(await digestSql(hostile)).not.toBe(KNOWN);
  });

  it("the digest the database stored for a real proposal is the one the application recomputes from the facts it can read", async () => {
    const ctx = await frozen("Digest Parity");
    const p = await propose(ctx);
    const status = (await statusFor(ctx, ctx.organizer.gamingMemberId))!;
    expect(status.amendment!.digest).toBe(p.digest);
    const row = await amendmentRow(p.digest);
    const freeze = (await freezeRows(ctx.competitionId))[0];
    const baseRev = (await currentRevision(ctx.competitionId))!;
    const { computePlanAmendmentDigest, composeAmendedPlan } = await loadAmend();
    const { plan } = composeAmendedPlan(baseRev, status.amendment!.proposed as never);
    expect(computePlanAmendmentDigest({ competitionId: ctx.competitionId, freezeDigest: freeze.snapshot_digest, baseRevisionId: baseRev.planningRevisionId, sequenceNumber: row.sequence_number, formatKey: "SOCCER_5V5", plan })).toBe(p.digest);
    expect(p.digest).toMatch(/^[0-9a-f]{64}$/);
    // The same facts proposed again are another proposal (another sequence): confirmations can never carry between them.
    const again = await propose(ctx, facts());
    expect(again.digest).not.toBe(p.digest);
    expect(again.sequenceNumber).toBe(p.sequenceNumber + 1);
  }, 120000);

  it("[5] a decision names the exact digest: an unknown digest and a superseded one are both refused, and nothing is recorded", async () => {
    const ctx = await frozen("Stale Digest");
    const first = await propose(ctx);
    const second = await propose(ctx, facts({ name: `Second ${RUN}` }));
    const { PlanAmendmentStaleError, PlanAmendmentNotPendingError } = await loadAmend();
    await expectRejectsLazy(decide(ctx, 0, "0".repeat(64), "CONFIRMED"), async () => PlanAmendmentStaleError);
    await expectRejectsLazy(decide(ctx, 0, first.digest, "CONFIRMED"), async () => PlanAmendmentNotPendingError);
    expect((await amendmentCounts(ctx.competitionId)).decisions).toBe(0);
    await decide(ctx, 0, second.digest, "CONFIRMED");
    expect((await amendmentCounts(ctx.competitionId)).decisions).toBe(1);
  }, 120000);
});

// =============================================================================================================================================
// [lead] [expiry] database time only
// =============================================================================================================================================

describe("[6] a proposal is refused when its earliest window is 12 hours or less away by the database clock — exact equality fails closed", () => {
  it("12h exactly, 11h59m, a window in the past: refused; 12h plus one microsecond and 13h: accepted — all judged by the redefined database clock, nothing by the client", async () => {
    const ctx = await frozen("Lead Time");
    const f = facts({ daysAhead: 9, start: "10:00", end: "14:00" });
    const first = firstWindowMs(f);
    const args = (payload: Facts) => [ctx.competitionId, ctx.organizer.gamingMemberId, randomUUID(), JSON.stringify(rpcPayload(payload))];
    const at = (instantMs: number, microsAfter = 0) => (microsAfter ? shiftExact(new Date(instantMs).toISOString(), microsAfter) : new Date(instantMs).toISOString());
    const HOUR = 3600_000;

    for (const [label, instant] of [["exactly 12 hours", at(first - 12 * HOUR)], ["11 hours 59 minutes", at(first - 12 * HOUR + 60_000)], ["one microsecond inside 12 hours", at(first - 12 * HOUR, 1)], ["after the window opened", at(first + HOUR)]] as const) {
      const out = await atInstant(instant, PROPOSE_SQL, args(f));
      expect(out.ok, label).toBe(false);
      expect(!out.ok && out.message, label).toMatch(/PLAN_AMENDMENT_LEAD_TIME/);
    }
    for (const [label, instant] of [["12 hours plus one microsecond", at(first - 12 * HOUR, -1)], ["13 hours", at(first - 13 * HOUR)]] as const) {
      const out = await atInstant(instant, PROPOSE_SQL, args(f));
      expect(out.ok, `${label}: ${!out.ok ? out.message : ""}`).toBe(true);
    }
    expect((await amendmentCounts(ctx.competitionId)).proposals).toBe(0); // every probe was rolled back
    // The earliest of SEVERAL windows is the one judged.
    const two: Facts = { ...f, dates: [{ date: f.dates[0].date, windows: [{ start: "10:00", end: "14:00" }] }, { date: localDate(first + 3 * DAY), windows: [{ start: "09:00", end: "10:00" }] }] };
    expect((await atInstant(at(first - 12 * HOUR), PROPOSE_SQL, args(two))).ok).toBe(false);
    expect((await atInstant(at(first - 12 * HOUR, -1), PROPOSE_SQL, args(two))).ok).toBe(true);
    // And a real proposal, comfortably clear of it, is accepted by the real clock.
    expect((await propose(ctx, f)).sequenceNumber).toBe(1);
  }, 180000);
});

describe("[7] a proposal expires at the earlier of 24 hours after creation or 12 hours before its earliest window — by database time, with no job", () => {
  it("a far window: expiry is exactly creation + 24 hours", async () => {
    const ctx = await frozen("Expiry 24h");
    const p = await propose(ctx, facts({ daysAhead: 10 }));
    const [row] = await rawQuery("select expires_at - created_at = interval '24 hours' as ok, expires_at, created_at from competition_plan_change_proposals where amendment_digest = $1", [p.digest]);
    expect(row.ok).toBe(true);
    expect(new Date(p.expiresAt).getTime()).toBe(row.expires_at.getTime());
    expect(new Date(p.createdAt).getTime()).toBe(row.created_at.getTime());
  }, 120000);

  it("a near window: expiry is exactly 12 hours before the earliest window, and a decision is accepted one microsecond before it, refused at it and after it (activation included)", async () => {
    const ctx = await frozen("Expiry Window");
    const target = Math.ceil((Date.now() + 14 * 3600_000) / 60_000) * 60_000;
    const local = new Date(target + CR_OFFSET_MS).toISOString();
    const startHour = Number(local.slice(11, 13));
    const f = facts({ dates: [{ date: local.slice(0, 10), windows: [{ start: local.slice(11, 16), end: startHour >= 23 ? "23:59" : `${String(startHour + 1).padStart(2, "0")}:${local.slice(14, 16)}` }] }] });
    const p = await propose(ctx, f);
    const [row] = await rawQuery("select expires_at, created_at from competition_plan_change_proposals where amendment_digest = $1", [p.digest]);
    expect(row.expires_at.getTime()).toBe(firstWindowMs(f) - 12 * 3600_000);
    expect(row.expires_at.getTime()).toBeLessThan(row.created_at.getTime() + 24 * 3600_000);
    const expiresIso = row.expires_at.toISOString();
    for (let i = 0; i < 3; i++) await decide(ctx, i, p.digest, "CONFIRMED");

    const fourth = [ctx.competitionId, ctx.teams[3].captain.gamingMemberId, p.digest, "CONFIRMED"];
    const justBefore = await atInstant(shiftExact(expiresIso, -1), DECIDE_SQL, fourth);
    expect(justBefore.ok, !justBefore.ok ? justBefore.message : "").toBe(true);
    expect(justBefore.ok && justBefore.rows[0].r.status).toBe("ACTIVATED"); // the fourth confirmation, still in time, would activate (rolled back here)
    for (const [label, instant] of [["exactly at expiry", expiresIso], ["one microsecond after", shiftExact(expiresIso, 1)], ["a day after", new Date(row.expires_at.getTime() + DAY).toISOString()]] as const) {
      const out = await atInstant(instant, DECIDE_SQL, fourth);
      expect(out.ok, label).toBe(false);
      expect(!out.ok && out.message, label).toMatch(/PLAN_AMENDMENT_EXPIRED/);
    }
    // An expired proposal is expired by the clock alone (derived), shown as such, and still unresolved in the evidence.
    expect(((await atInstant(shiftExact(expiresIso, -1), STATUS_SQL, [ctx.competitionId, ctx.organizer.gamingMemberId])) as { ok: true; rows: any[] }).rows[0].r.amendment.status).toBe("PENDING");
    expect(((await atInstant(expiresIso, STATUS_SQL, [ctx.competitionId, ctx.organizer.gamingMemberId])) as { ok: true; rows: any[] }).rows[0].r.amendment.status).toBe("EXPIRED");
    expect(await resolutionOf(p.digest)).toBeNull();
    expect((await amendmentCounts(ctx.competitionId)).decisions).toBe(3);
  }, 180000);

  it("an expired proposal can receive no decision, cannot be withdrawn, does not block a new proposal, and stays unresolved", async () => {
    const ctx = await frozen("Expired Proposal");
    const p = await propose(ctx);
    await decide(ctx, 0, p.digest, "CONFIRMED");
    await age(p.digest, 30); // service-side fixture: the time has "passed"
    const { PlanAmendmentExpiredError } = await loadAmend();
    expect((await statusFor(ctx, ctx.organizer.gamingMemberId))!.amendment!.status).toBe("EXPIRED");
    expect((await statusFor(ctx, ctx.organizer.gamingMemberId))!.amendment!.actionable).toBe(false);
    await expectRejectsLazy(decide(ctx, 1, p.digest, "CONFIRMED"), async () => PlanAmendmentExpiredError);
    await expectRejectsLazy(decide(ctx, 1, p.digest, "REJECTED"), async () => PlanAmendmentExpiredError);
    await expectRejectsLazy(withdraw(ctx, p.digest), async () => PlanAmendmentExpiredError);
    const next = await propose(ctx, facts({ name: `After expiry ${RUN}` }));
    expect(next.sequenceNumber).toBe(2);
    expect(next.supersededDigest).toBeNull(); // nothing effective was superseded
    expect(await resolutionOf(p.digest)).toBeNull();
    expect((await currentRevision(ctx.competitionId))!.revisionNumber).toBe(2);
  }, 180000);
});

// =============================================================================================================================================
// [confirm] four distinct frozen captains, atomic activation, one rejection
// =============================================================================================================================================

describe("[8][9] four distinct frozen captains must confirm, and the fourth confirmation activates atomically", () => {
  it("three confirmations leave the proposal pending and the plan untouched; a captain confirming again counts once; the fourth distinct captain activates", async () => {
    const ctx = await frozen("Four Captains");
    const p = await propose(ctx);
    const baseId = (await currentRevision(ctx.competitionId))!.planningRevisionId;
    const r1 = await decide(ctx, 0, p.digest, "CONFIRMED");
    expect([r1.status, r1.confirmedCount, r1.requiredCount, r1.alreadyDecided, r1.activatedRevisionNumber]).toEqual(["PENDING", 1, REQUIRED, false, null]);
    const again = await decide(ctx, 0, p.digest, "CONFIRMED");
    expect([again.status, again.confirmedCount, again.alreadyDecided]).toEqual(["PENDING", 1, true]);
    await decide(ctx, 1, p.digest, "CONFIRMED");
    const r3 = await decide(ctx, 2, p.digest, "CONFIRMED");
    expect([r3.status, r3.confirmedCount]).toEqual(["PENDING", 3]);
    expect((await currentRevision(ctx.competitionId))!.planningRevisionId).toBe(baseId);
    expect(await resolutionOf(p.digest)).toBeNull();
    const view = (await statusFor(ctx, ctx.teams[0].captain.gamingMemberId))!.amendment!;
    expect([view.confirmedCount, view.requiredCount, view.status, view.actionable]).toEqual([3, 4, "PENDING", true]);
    expect(view.teams.filter((t) => t.decision === "CONFIRMED")).toHaveLength(3);
    expect(view.myDecision).toBe("CONFIRMED");

    const last = await decide(ctx, 3, p.digest, "CONFIRMED");
    expect([last.status, last.confirmedCount, last.activatedRevisionNumber]).toEqual(["ACTIVATED", 4, 3]);
    const revision = (await currentRevision(ctx.competitionId))!;
    expect([revision.revisionNumber, revision.supersedesRevisionNumber, revision.venue.name]).toEqual([3, 2, facts().venue.name]);
    const resolution = await resolutionOf(p.digest);
    expect(resolution.outcome).toBe("ACTIVATED");
    expect(resolution.activated_planning_revision_id).toBe(revision.planningRevisionId);
    expect(resolution.resolved_by_gaming_member_id).toBe(ctx.teams[3].captain.gamingMemberId);
    expect((await rawQuery("select count(*)::int n from competition_planning_revisions where supersedes_revision_id = $1", [baseId]))[0].n).toBe(1);
    expect((await statusFor(ctx, ctx.organizer.gamingMemberId))!.amendment!.status).toBe("ACTIVATED");
  }, 180000);

  it("the organizer, a team member, a registrant and a stranger are never counted; the four are exactly the frozen captains", async () => {
    const ctx = await frozen("Only Frozen Captains");
    const p = await propose(ctx);
    const { PlanAmendmentNotAvailableError } = await loadAmend();
    for (const actor of [ctx.organizer.gamingMemberId, pool[0].gamingMemberId, pool[40].gamingMemberId, randomUUID()]) {
      await expectRejectsLazy(compRepo.decidePlanAmendment(ctx.competitionId, actor, p.digest, "CONFIRMED"), async () => PlanAmendmentNotAvailableError);
    }
    // A NULL caller is nobody either.
    const nulled = await service.rpc("decide_competition_plan_amendment_atomically", { p_competition_id: ctx.competitionId, p_captain_gaming_member_id: null, p_amendment_digest: p.digest, p_decision: "CONFIRMED" });
    expect(nulled.error?.message ?? "no error").toMatch(/PLAN_AMENDMENT_NOT_AVAILABLE/);
    expect((await amendmentCounts(ctx.competitionId)).decisions).toBe(0);
  }, 180000);

  it("the fourth confirmation is atomic: if creating the revision fails, the decision, the resolution and the revision are all rolled back", async () => {
    const ctx = await frozen("Atomic Activation");
    const p = await propose(ctx);
    for (let i = 0; i < 3; i++) await decide(ctx, i, p.digest, "CONFIRMED");
    const before = { plan: await currentPlanHash(ctx.competitionId), counts: await amendmentCounts(ctx.competitionId), revisions: await revisionCount(ctx.competitionId) };
    await rawTransaction(async (db) => {
      await db.query(`create function pg_temp.refuse_revision() returns trigger language plpgsql as $$ begin raise exception 'INJECTED_FAILURE'; end $$`);
      await db.query("create trigger inject_failure before insert on competition_planning_revisions for each row execute function pg_temp.refuse_revision()");
      await expect(db.query(DECIDE_SQL, [ctx.competitionId, ctx.teams[3].captain.gamingMemberId, p.digest, "CONFIRMED"])).rejects.toThrow(/INJECTED_FAILURE/);
    });
    expect({ plan: await currentPlanHash(ctx.competitionId), counts: await amendmentCounts(ctx.competitionId), revisions: await revisionCount(ctx.competitionId) }).toEqual(before);
    expect((await decide(ctx, 3, p.digest, "CONFIRMED")).status).toBe("ACTIVATED"); // the same call, undisturbed, succeeds
  }, 180000);

  it("activation changes nothing the freeze recorded, keeps registration closed, and creates no fixture, draw or schedule", async () => {
    const ctx = await frozen("After Activation");
    const freezeBefore = await freezeEvidenceHash(ctx.competitionId);
    const registrationBefore = await compRepo.getRegistrationStatus(ctx.competitionId);
    const p = await propose(ctx);
    for (let i = 0; i < 4; i++) await decide(ctx, i, p.digest, "CONFIRMED");
    expect(await freezeEvidenceHash(ctx.competitionId)).toBe(freezeBefore);
    expect(await compRepo.getRegistrationStatus(ctx.competitionId)).toEqual(registrationBefore); // the same deadline, still frozen
    expect(await stateOf(ctx.competitionId)).toBe("READY_TO_PUBLISH");
    const { TeamRegistrationNotOpenError } = await import("../lib/gaming/competitions/types");
    await expectRejects(registerForCompetition(compRepo, ctx.competitionId, pool[41].gamingMemberId, true), TeamRegistrationNotOpenError);
    expect((await rawQuery("select count(*)::int n from competition_fixtures where competition_id = $1", [ctx.competitionId]))[0].n).toBe(0);
    expect(await rawQuery("select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relname ~ '(draw|pairing|schedule|fixture_slot|appeal|adjudicat|amend)' and relname !~ '^competition_plan_change_' order by relname")).toEqual([]);
  }, 180000);
});

describe("[10][11] one rejection terminates the proposal, and an unavailable captain has no override", () => {
  it("a single rejection writes the terminal REJECTED resolution; earlier confirmations do not activate; later decisions are refused; the plan is untouched", async () => {
    const ctx = await frozen("Rejection");
    const p = await propose(ctx);
    await decide(ctx, 0, p.digest, "CONFIRMED");
    await decide(ctx, 1, p.digest, "CONFIRMED");
    const baseId = (await currentRevision(ctx.competitionId))!.planningRevisionId;
    const rejected = await decide(ctx, 2, p.digest, "REJECTED");
    expect([rejected.status, rejected.decision]).toEqual(["REJECTED", "REJECTED"]);
    const resolution = await resolutionOf(p.digest);
    expect([resolution.outcome, resolution.resolved_by_gaming_member_id]).toEqual(["REJECTED", ctx.teams[2].captain.gamingMemberId]);
    const { PlanAmendmentNotPendingError } = await loadAmend();
    const { PlanAmendmentDecisionConflictError } = await loadAmend();
    await expectRejectsLazy(decide(ctx, 3, p.digest, "CONFIRMED"), async () => PlanAmendmentNotPendingError); // a captain who has not decided, on a terminal proposal
    await expectRejectsLazy(decide(ctx, 0, p.digest, "REJECTED"), async () => PlanAmendmentDecisionConflictError); // a conflicting retry of a captain who already confirmed
    expect((await decide(ctx, 2, p.digest, "REJECTED")).alreadyDecided).toBe(true); // the exact retry of the rejecting captain is idempotent
    expect((await currentRevision(ctx.competitionId))!.planningRevisionId).toBe(baseId);
    expect((await statusFor(ctx, ctx.organizer.gamingMemberId))!.amendment!.status).toBe("REJECTED");
    // The organizer may propose again afterwards.
    expect((await propose(ctx, facts({ name: `Again ${RUN}` }))).sequenceNumber).toBe(2);
  }, 180000);

  it("with one captain silent the proposal cannot activate by any path: nobody else can decide for them, and the only exits are withdrawal, expiry or the existing cancellation", async () => {
    const ctx = await frozen("Unavailable Captain");
    const p = await propose(ctx);
    for (let i = 0; i < 3; i++) await decide(ctx, i, p.digest, "CONFIRMED");
    const { PlanAmendmentNotAvailableError } = await loadAmend();
    // The organizer, the silent captain's own team members and every other caller are refused; there is no replacement or override function at all.
    for (const actor of [ctx.organizer.gamingMemberId, ...ctx.teams[3].members.slice(0, 2)]) {
      await expectRejectsLazy(compRepo.decidePlanAmendment(ctx.competitionId, actor, p.digest, "CONFIRMED"), async () => PlanAmendmentNotAvailableError);
    }
    expect(await rawQuery("select proname from pg_proc where pronamespace = 'public'::regnamespace and proname ~ '(amend|override|replace_captain|captain)' and proname !~ '^competition_' order by proname")).toEqual(
      [...AMENDMENT_RPCS].sort().map((proname) => ({ proname })));
    expect((await statusFor(ctx, ctx.organizer.gamingMemberId))!.amendment!.confirmedCount).toBe(3);
    expect(await resolutionOf(p.digest)).toBeNull();
    expect((await currentRevision(ctx.competitionId))!.revisionNumber).toBe(2);
    // Expiry ends it …
    await age(p.digest, 30);
    expect((await statusFor(ctx, ctx.organizer.gamingMemberId))!.amendment!.status).toBe("EXPIRED");
    // … and so does the existing cancellation, with no amendment function involved.
    await cancelCompetition(compRepo, ctx.competitionId, ctx.organizer.gamingMemberId, "A frozen captain never answered the proposed plan change.");
    expect(await stateOf(ctx.competitionId)).toBe("CANCELLED_WITHOUT_CHAMPION");
    const { PlanAmendmentWindowClosedError } = await loadAmend();
    await expectRejectsLazy(propose(ctx, facts({ name: `After cancel ${RUN}` })), async () => PlanAmendmentWindowClosedError);
  }, 240000);
});

describe("[12][13][14] withdrawal, supersession, exact replay and conflicting replay", () => {
  it("the organizer withdraws a pending proposal: terminal WITHDRAWN, no decision accepted afterwards, an exact repeat is idempotent, and others cannot withdraw", async () => {
    const ctx = await frozen("Withdraw");
    const p = await propose(ctx);
    await decide(ctx, 0, p.digest, "CONFIRMED");
    const { PlanAmendmentNotPendingError, PlanAmendmentStaleError } = await loadAmend();
    const { CompetitionAccessDeniedError } = await import("../lib/gaming/competitions/types");
    await expectRejects(compRepo.withdrawPlanAmendment(ctx.competitionId, ctx.teams[0].captain.gamingMemberId, p.digest), CompetitionAccessDeniedError);
    await expectRejects(compRepo.withdrawPlanAmendment(ctx.competitionId, randomUUID(), p.digest), CompetitionAccessDeniedError);
    await expectRejectsLazy(compRepo.withdrawPlanAmendment(ctx.competitionId, ctx.organizer.gamingMemberId, "1".repeat(64)), async () => PlanAmendmentStaleError);
    expect(await withdraw(ctx, p.digest)).toEqual({ status: "WITHDRAWN", alreadyWithdrawn: false });
    expect(await withdraw(ctx, p.digest)).toEqual({ status: "WITHDRAWN", alreadyWithdrawn: true });
    expect((await resolutionOf(p.digest)).outcome).toBe("WITHDRAWN");
    await expectRejectsLazy(decide(ctx, 1, p.digest, "CONFIRMED"), async () => PlanAmendmentNotPendingError);
    expect((await statusFor(ctx, ctx.teams[1].captain.gamingMemberId))!.amendment!.status).toBe("WITHDRAWN");
    expect((await currentRevision(ctx.competitionId))!.revisionNumber).toBe(2);
  }, 180000);

  it("a withdrawn, superseded, rejected or activated proposal cannot be withdrawn as if it were pending", async () => {
    const ctx = await frozen("Withdraw Terminal");
    const { PlanAmendmentNotPendingError } = await loadAmend();
    const a = await propose(ctx);
    const b = await propose(ctx, facts({ name: `B ${RUN}` })); // supersedes a
    await expectRejectsLazy(withdraw(ctx, a.digest), async () => PlanAmendmentNotPendingError);
    for (let i = 0; i < 4; i++) await decide(ctx, i, b.digest, "CONFIRMED");
    await expectRejectsLazy(withdraw(ctx, b.digest), async () => PlanAmendmentNotPendingError);
  }, 180000);

  it("a new valid proposal atomically supersedes the pending one; confirmations on the old digest never count for the new one; exactly one proposal is effective", async () => {
    const ctx = await frozen("Supersede");
    const first = await propose(ctx);
    for (let i = 0; i < 3; i++) await decide(ctx, i, first.digest, "CONFIRMED");
    const second = await propose(ctx, facts({ name: `Replacement ${RUN}` }));
    expect(second.supersededDigest).toBe(first.digest);
    expect(second.sequenceNumber).toBe(2);
    const old = await resolutionOf(first.digest);
    expect(old.outcome).toBe("SUPERSEDED");
    expect(old.superseded_by_plan_amendment_id).toBe((await amendmentRow(second.digest)).plan_amendment_id);
    const view = (await statusFor(ctx, ctx.teams[3].captain.gamingMemberId))!.amendment!;
    expect([view.digest, view.status, view.confirmedCount, view.myDecision]).toEqual([second.digest, "PENDING", 0, null]);
    expect(view.teams.every((t) => t.decision === null)).toBe(true);
    // The new proposal needs all four fresh confirmations; the three old ones were bound to the old digest.
    for (let i = 0; i < 3; i++) expect((await decide(ctx, i, second.digest, "CONFIRMED")).status).toBe("PENDING");
    expect((await currentRevision(ctx.competitionId))!.revisionNumber).toBe(2);
    expect((await decide(ctx, 3, second.digest, "CONFIRMED")).status).toBe("ACTIVATED");
    expect((await currentRevision(ctx.competitionId))!.venue.name).toBe(`Replacement ${RUN}`);
    expect((await rawQuery("select count(*)::int n from competition_plan_change_proposals a where a.competition_id = $1 and not exists (select 1 from competition_plan_change_resolutions r where r.plan_amendment_id = a.plan_amendment_id)", [ctx.competitionId]))[0].n).toBe(0);
  }, 240000);

  it("[14] exact replays are idempotent and conflicting replays are refused: the same intent with the same content, the same decision, the final captain's decision after activation", async () => {
    const ctx = await frozen("Replay");
    const intent = randomUUID();
    const p = await propose(ctx, facts(), intent);
    const replay = await propose(ctx, facts(), intent);
    expect([replay.alreadyProposed, replay.digest, replay.sequenceNumber, replay.expiresAt]).toEqual([true, p.digest, p.sequenceNumber, p.expiresAt]);
    expect((await amendmentCounts(ctx.competitionId)).proposals).toBe(1);
    const { PlanAmendmentIntentMismatchError, PlanAmendmentDecisionConflictError } = await loadAmend();
    await expectRejectsLazy(propose(ctx, facts({ name: `Different ${RUN}` }), intent), async () => PlanAmendmentIntentMismatchError);
    expect((await amendmentCounts(ctx.competitionId)).proposals).toBe(1);

    await decide(ctx, 0, p.digest, "CONFIRMED");
    expect((await decide(ctx, 0, p.digest, "CONFIRMED")).alreadyDecided).toBe(true);
    await expectRejectsLazy(decide(ctx, 0, p.digest, "REJECTED"), async () => PlanAmendmentDecisionConflictError);
    expect((await amendmentCounts(ctx.competitionId)).decisions).toBe(1);
    expect(await resolutionOf(p.digest)).toBeNull(); // the conflicting retry did not reject the proposal
    for (let i = 1; i < 4; i++) await decide(ctx, i, p.digest, "CONFIRMED");
    const afterwards = await decide(ctx, 3, p.digest, "CONFIRMED");
    expect([afterwards.alreadyDecided, afterwards.status, afterwards.activatedRevisionNumber]).toEqual([true, "ACTIVATED", 3]);
    expect(await revisionCount(ctx.competitionId)).toBe(3); // still exactly one new revision
    await expectRejectsLazy(decide(ctx, 3, p.digest, "REJECTED"), async () => PlanAmendmentDecisionConflictError);
    // The replay of an intent whose proposal has since been activated still returns it unchanged.
    expect((await propose(ctx, facts(), intent)).alreadyProposed).toBe(true);
  }, 240000);
});

// =============================================================================================================================================
// [retry] an exact retry returns what was recorded, after identity and revocation and before the lifecycle window
// =============================================================================================================================================

describe("[14A] an exact historical retry returns its recorded result whatever has happened since; identity and revocation are judged first, and anything that is not an exact retry still needs the window", () => {
  type Outcome = "ACTIVATED" | "REJECTED";
  type Ending = "publication" | "cancellation";
  const end = (ctx: Ctx, ending: Ending) => (ending === "publication" ? publishNow(ctx) : cancelNow(ctx));

  async function resolved(label: string, outcome: Outcome) {
    const ctx = await frozen(label);
    const p = await propose(ctx);
    if (outcome === "ACTIVATED") for (let i = 0; i < 4; i++) await decide(ctx, i, p.digest, "CONFIRMED");
    else { await decide(ctx, 0, p.digest, "CONFIRMED"); await decide(ctx, 1, p.digest, "REJECTED"); }
    return { ctx, p };
  }

  it("proposal: the same organizer, intent and content returns the original result while pending, after supersession, rejection, withdrawal and activation, and after publication; other content under the intent stays INTENT_MISMATCH; a new proposal needs the window", async () => {
    const { PlanAmendmentIntentMismatchError, PlanAmendmentWindowClosedError } = await loadAmend();
    const ctx = await frozen("Retry Propose");
    const sent: Array<{ label: string; intent: string; facts: Facts; first: Awaited<ReturnType<typeof propose>> }> = [];
    const send = async (label: string) => {
      const intent = randomUUID();
      const f = facts({ name: `${label} ${RUN}` });
      const first = await propose(ctx, f, intent);
      sent.push({ label, intent, facts: f, first });
      return first;
    };
    const a = await send("A");                                   // superseded by B
    const b = await send("B");                                   // rejected
    await decide(ctx, 0, b.digest, "CONFIRMED");
    await decide(ctx, 1, b.digest, "REJECTED");
    const c = await send("C");                                   // withdrawn
    await withdraw(ctx, c.digest);
    const d = await send("D");                                   // activated
    for (let i = 0; i < 4; i++) await decide(ctx, i, d.digest, "CONFIRMED");
    await send("E");                                             // still pending
    expect(b.supersededDigest).toBe(a.digest);
    const recorded = await amendmentSnapshot(ctx.competitionId);
    const retryAll = async (when: string) => {
      for (const s of sent) expect(await propose(ctx, s.facts, s.intent), `${when}: ${s.label}`).toEqual({ ...s.first, alreadyProposed: true });
    };
    await retryAll("while the window is open");
    expect(await amendmentSnapshot(ctx.competitionId)).toBe(recorded);

    await publishNow(ctx);
    expect(await stateOf(ctx.competitionId)).toBe("PUBLISHED");
    await retryAll("after publication");
    for (const s of sent) await expectRejectsLazy(propose(ctx, facts({ name: `Other ${s.label} ${RUN}` }), s.intent), async () => PlanAmendmentIntentMismatchError);
    await expectRejectsLazy(propose(ctx, facts({ name: `Fresh ${RUN}` })), async () => PlanAmendmentWindowClosedError);
    expect(await amendmentSnapshot(ctx.competitionId)).toBe(recorded);
  }, 600000);

  it("proposal: the same retry works after the competition is cancelled, with the same mismatch and window answers", async () => {
    const { PlanAmendmentIntentMismatchError, PlanAmendmentWindowClosedError } = await loadAmend();
    const ctx = await frozen("Retry Propose Cancelled");
    const intent = randomUUID();
    const f = facts({ name: `Cancelled ${RUN}` });
    const first = await propose(ctx, f, intent);
    await decide(ctx, 0, first.digest, "CONFIRMED");
    await cancelNow(ctx);
    expect(await stateOf(ctx.competitionId)).toBe("CANCELLED_WITHOUT_CHAMPION");
    const recorded = await amendmentSnapshot(ctx.competitionId);
    expect(await propose(ctx, f, intent)).toEqual({ ...first, alreadyProposed: true });
    await expectRejectsLazy(propose(ctx, facts({ name: `Other ${RUN}` }), intent), async () => PlanAmendmentIntentMismatchError);
    await expectRejectsLazy(propose(ctx, facts({ name: `Fresh ${RUN}` })), async () => PlanAmendmentWindowClosedError);
    expect(await amendmentSnapshot(ctx.competitionId)).toBe(recorded);
  }, 300000);

  for (const outcome of ["ACTIVATED", "REJECTED"] as const) for (const ending of ["publication", "cancellation"] as const) {
    it(`decision: after ${outcome === "ACTIVATED" ? "activation" : "rejection"} and then ${ending}, each captain's exact decision returns the recorded result, the opposite answer stays DECISION_CONFLICT, and a captain who has not answered (or an unknown digest) still needs the window`, async () => {
      const { PlanAmendmentDecisionConflictError, PlanAmendmentWindowClosedError } = await loadAmend();
      const { ctx, p } = await resolved(`Retry Decide ${outcome} ${ending}`.slice(0, 40), outcome);
      await end(ctx, ending);
      const recorded = await amendmentSnapshot(ctx.competitionId);
      const answered: Array<[number, Decision]> = outcome === "ACTIVATED" ? [[0, "CONFIRMED"], [1, "CONFIRMED"], [2, "CONFIRMED"], [3, "CONFIRMED"]] : [[0, "CONFIRMED"], [1, "REJECTED"]];
      for (const [team, decision] of answered) {
        const again = await decide(ctx, team, p.digest, decision);
        expect([again.decision, again.alreadyDecided, again.status, again.confirmedCount, again.activatedRevisionNumber], `captain ${team}`)
          .toEqual([decision, true, outcome, outcome === "ACTIVATED" ? 4 : 1, outcome === "ACTIVATED" ? 3 : null]);
        await expectRejectsLazy(decide(ctx, team, p.digest, decision === "CONFIRMED" ? "REJECTED" : "CONFIRMED"), async () => PlanAmendmentDecisionConflictError);
      }
      if (outcome === "REJECTED") {
        await expectRejectsLazy(decide(ctx, 2, p.digest, "CONFIRMED"), async () => PlanAmendmentWindowClosedError); // no recorded answer: not a retry
        await expectRejectsLazy(decide(ctx, 0, "0".repeat(64), "CONFIRMED"), async () => PlanAmendmentWindowClosedError);
      }
      expect(await amendmentSnapshot(ctx.competitionId)).toBe(recorded);
    }, 600000);
  }

  it("decision: a pending proposal's recorded answers are returned after cancellation too, and a captain who has not answered cannot add one", async () => {
    const { PlanAmendmentWindowClosedError } = await loadAmend();
    const ctx = await frozen("Retry Decide Pending");
    const p = await propose(ctx);
    await decide(ctx, 0, p.digest, "CONFIRMED");
    await decide(ctx, 1, p.digest, "CONFIRMED");
    await cancelNow(ctx);
    const recorded = await amendmentSnapshot(ctx.competitionId);
    const again = await decide(ctx, 0, p.digest, "CONFIRMED");
    expect([again.alreadyDecided, again.status, again.confirmedCount, again.activatedRevisionNumber]).toEqual([true, "PENDING", 2, null]);
    await expectRejectsLazy(decide(ctx, 2, p.digest, "CONFIRMED"), async () => PlanAmendmentWindowClosedError);
    expect(await amendmentSnapshot(ctx.competitionId)).toBe(recorded);
  }, 300000);

  for (const ending of ["publication", "cancellation"] as const) {
    it(`withdrawal: after ${ending} the same organizer's exact digest returns the recorded WITHDRAWN result; every other withdrawal — pending, rejected, unknown — still needs the window`, async () => {
      const { PlanAmendmentWindowClosedError } = await loadAmend();
      const ctx = await frozen(`Retry Withdraw ${ending}`.slice(0, 40));
      const withdrawn = await propose(ctx, facts({ name: `W ${RUN}` }));
      await withdraw(ctx, withdrawn.digest);
      const rejected = await propose(ctx, facts({ name: `R ${RUN}` }));
      await decide(ctx, 0, rejected.digest, "REJECTED");
      const pending = await propose(ctx, facts({ name: `P ${RUN}` }));
      expect(await withdraw(ctx, withdrawn.digest)).toEqual({ status: "WITHDRAWN", alreadyWithdrawn: true }); // the control, while open
      await end(ctx, ending);
      const recorded = await amendmentSnapshot(ctx.competitionId);
      expect(await withdraw(ctx, withdrawn.digest)).toEqual({ status: "WITHDRAWN", alreadyWithdrawn: true });
      for (const digest of [rejected.digest, pending.digest, "1".repeat(64)]) await expectRejectsLazy(withdraw(ctx, digest), async () => PlanAmendmentWindowClosedError);
      expect(await amendmentSnapshot(ctx.competitionId)).toBe(recorded);
    }, 300000);
  }

  it("through the real routes: after publication the same proposal, decision and withdrawal requests are 200 replays; other content under the intent is a coded 409; a new proposal or a first answer is WINDOW_CLOSED", async () => {
    const ctx = await frozen("Retry Routes");
    const routes = await loadRoutes();
    const organizerToken = await tokenFor(ctx.organizer);
    const post = async (body: unknown) => routes.base.POST(request(`${COMP}/${ctx.competitionId}/plan-amendment`, "POST", organizerToken, body), ctxOf(ctx.competitionId));
    const first = { intentId: randomUUID(), amendment: facts({ name: `Route A ${RUN}` }) };
    const second = { intentId: randomUUID(), amendment: facts({ name: `Route B ${RUN}` }) };
    const a = (await (await post(first)).json()).amendment;
    expect((await routes.withdraw.POST(request(`${COMP}/${ctx.competitionId}/plan-amendment/withdraw`, "POST", organizerToken, { amendmentDigest: a.digest }), ctxOf(ctx.competitionId))).status).toBe(200);
    const b = (await (await post(second)).json()).amendment;
    const answer = async (team: number, digest: string, decision: string) =>
      routes.decision.POST(request(`${COMP}/${ctx.competitionId}/plan-amendment/decision`, "POST", await tokenFor(ctx.teams[team].captain), { amendmentDigest: digest, decision }), ctxOf(ctx.competitionId));
    for (let i = 0; i < 4; i++) expect((await answer(i, b.digest, "CONFIRMED")).status).toBe(200);
    await publishNow(ctx);

    const replayA = await post(first);
    const replayB = await post(second);
    expect([replayA.status, (await replayA.json()).amendment.alreadyProposed, replayB.status, (await replayB.json()).amendment.alreadyProposed]).toEqual([200, true, 200, true]);
    const mismatch = await post({ intentId: first.intentId, amendment: facts({ name: `Route Other ${RUN}` }) });
    expect([mismatch.status, (await mismatch.json()).code]).toEqual([409, "INTENT_MISMATCH"]);
    const fresh = await post({ intentId: randomUUID(), amendment: facts({ name: `Route Fresh ${RUN}` }) });
    expect([fresh.status, (await fresh.json()).code]).toEqual([409, "WINDOW_CLOSED"]);

    const again = await answer(2, b.digest, "CONFIRMED");
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ decision: "CONFIRMED", status: "ACTIVATED", confirmedCount: 4, requiredCount: 4, alreadyDecided: true, activatedRevisionNumber: 3 });
    const conflict = await answer(2, b.digest, "REJECTED");
    expect([conflict.status, (await conflict.json()).code]).toEqual([409, "DECISION_CONFLICT"]);

    const withdrawAgain = await routes.withdraw.POST(request(`${COMP}/${ctx.competitionId}/plan-amendment/withdraw`, "POST", organizerToken, { amendmentDigest: a.digest }), ctxOf(ctx.competitionId));
    expect([withdrawAgain.status, await withdrawAgain.json()]).toEqual([200, { status: "WITHDRAWN", alreadyWithdrawn: true }]);
    const notRetry = await routes.withdraw.POST(request(`${COMP}/${ctx.competitionId}/plan-amendment/withdraw`, "POST", organizerToken, { amendmentDigest: b.digest }), ctxOf(ctx.competitionId));
    expect([notRetry.status, (await notRetry.json()).code]).toEqual([409, "WINDOW_CLOSED"]);
  }, 600000);
});

// =============================================================================================================================================
// [concurrency] one lock, one outcome
// =============================================================================================================================================

describe("[15][16] concurrent final confirmations create one revision; a confirmation racing a withdrawal has exactly one winner", () => {
  it("four captains confirming at the same moment: all four decisions are recorded, exactly one revision is created, exactly one call reports the activation", async () => {
    const ctx = await frozen("Race Four");
    const p = await propose(ctx);
    const results = await Promise.all([0, 1, 2, 3].map((i) => decide(ctx, i, p.digest, "CONFIRMED")));
    expect(results.filter((r) => r.status === "ACTIVATED")).toHaveLength(1);
    expect(results.filter((r) => r.status === "PENDING").every((r) => r.confirmedCount < 4)).toBe(true);
    expect(await amendmentCounts(ctx.competitionId)).toEqual({ proposals: 1, decisions: 4, resolutions: 1 });
    expect(await revisionCount(ctx.competitionId)).toBe(3);
    expect((await resolutionOf(p.digest)).outcome).toBe("ACTIVATED");
    expect((await currentRevision(ctx.competitionId))!.revisionNumber).toBe(3);
  }, 180000);

  it("the same captain submitting the same decision many times at once records one decision", async () => {
    const ctx = await frozen("Race Same Captain");
    const p = await propose(ctx);
    const results = await Promise.all(Array.from({ length: 6 }, () => decide(ctx, 0, p.digest, "CONFIRMED")));
    expect(results.filter((r) => !r.alreadyDecided)).toHaveLength(1);
    expect((await amendmentCounts(ctx.competitionId)).decisions).toBe(1);
  }, 180000);

  it("with three confirmations in, the fourth racing a withdrawal always ends in exactly one terminal outcome — and a revision exists if and only if it was the activation", async () => {
    const ctx = await frozen("Race Withdraw");
    const outcomes: string[] = [];
    for (let trial = 0; trial < 8; trial++) {
      const revisionsBefore = await revisionCount(ctx.competitionId);
      const p = await propose(ctx, facts({ name: `Trial ${trial} ${RUN}` }));
      for (let i = 0; i < 3; i++) await decide(ctx, i, p.digest, "CONFIRMED");
      const [confirm, withdrawn] = await Promise.allSettled([decide(ctx, 3, p.digest, "CONFIRMED"), withdraw(ctx, p.digest)]);
      const resolution = await resolutionOf(p.digest);
      expect(resolution, `trial ${trial}`).not.toBeNull();
      expect(["ACTIVATED", "WITHDRAWN"], `trial ${trial}`).toContain(resolution.outcome);
      outcomes.push(resolution.outcome);
      const decisions = await decisionRows(p.digest);
      if (resolution.outcome === "ACTIVATED") {
        expect([confirm.status, withdrawn.status], `trial ${trial}`).toEqual(["fulfilled", "rejected"]);
        expect(decisions).toHaveLength(4);
        expect(await revisionCount(ctx.competitionId), `trial ${trial}`).toBe(revisionsBefore + 1);
      } else {
        expect([confirm.status, withdrawn.status], `trial ${trial}`).toEqual(["rejected", "fulfilled"]);
        expect(decisions, `a fourth decision must not survive a withdrawal (trial ${trial})`).toHaveLength(3);
        expect(await revisionCount(ctx.competitionId), `trial ${trial}`).toBe(revisionsBefore);
      }
      expect((await rawQuery("select count(*)::int n from competition_plan_change_resolutions where plan_amendment_id = $1", [(await amendmentRow(p.digest)).plan_amendment_id]))[0].n).toBe(1);
    }
    expect(outcomes).toHaveLength(8);
  }, 600000);

  it("two organizer proposals at once serialize: both are recorded, the earlier is superseded, and exactly one is effective", async () => {
    const ctx = await frozen("Race Propose");
    const [a, b] = await Promise.all([propose(ctx, facts({ name: `Racer A ${RUN}` })), propose(ctx, facts({ name: `Racer B ${RUN}` }))]);
    expect(new Set([a.sequenceNumber, b.sequenceNumber])).toEqual(new Set([1, 2]));
    const rows = await rawQuery("select a.sequence_number, r.outcome from competition_plan_change_proposals a left join competition_plan_change_resolutions r on r.plan_amendment_id = a.plan_amendment_id where a.competition_id = $1 order by a.sequence_number", [ctx.competitionId]);
    expect(rows.map((r) => r.outcome)).toEqual(["SUPERSEDED", null]);
  }, 180000);
});

// =============================================================================================================================================
// [revocation] organizer revocation fails closed
// =============================================================================================================================================

describe("[17] a revoked host can propose nothing, withdraw nothing and activate nothing; the confirmations already given do not survive the revocation", () => {
  async function frozenPilot(label: string) {
    await ensurePool();
    const pilot = await hostPilot(label);
    const ctx: Ctx = { competitionId: pilot.competitionId, organizer: pilot.host, format: "SOCCER_5V5", deadlineMs: Date.now() + 2 * DAY, teams: [] };
    for (let i = 0; i < 4; i++) {
      const team = await addCompetitionTeam(compRepo, ctx.competitionId, pilot.host.gamingMemberId, `P${i} ${label.slice(0, 10)} ${RUN}`, captains[i].gamingMemberId);
      ctx.teams.push({ teamId: team.competitionTeamId, captain: captains[i], members: [] });
    }
    await savePlan(ctx.competitionId, pilot.host.gamingMemberId, { deadlineMs: ctx.deadlineMs });
    await openTeamRegistration(compRepo, ctx.competitionId, pilot.host.gamingMemberId);
    await fillRosters(ctx, [5, 5, 5, 5]);
    await passDeadline(ctx.competitionId);
    await closeTeamRegistration(compRepo, ctx.competitionId, pilot.host.gamingMemberId);
    return { ctx, pilot };
  }

  it("revoked before any proposal: the host is refused (HOST_ACCESS_REVOKED) for propose and withdraw, and reads nothing as organizer", async () => {
    const { ctx, pilot } = await frozenPilot("Revoked Before");
    const p = await propose(ctx); // a proposal made while the host was active
    expect((await statusFor(ctx, pilot.host.gamingMemberId))!.role.organizer).toBe(true);
    await pilot.revoke();
    const { HostAccessRevokedError } = await import("../lib/gaming/competitions/types");
    await expectRejects(propose(ctx, facts({ name: `Too late ${RUN}` })), HostAccessRevokedError);
    await expectRejects(withdraw(ctx, p.digest), HostAccessRevokedError);
    expect(await statusFor(ctx, pilot.host.gamingMemberId)).toBeNull(); // not a captain either: nothing to see
    expect(await amendmentCounts(ctx.competitionId)).toEqual({ proposals: 1, decisions: 0, resolutions: 0 });
  }, 240000);

  it("revoked after three confirmations: the fourth captain's confirmation is refused, nothing is recorded, the plan is untouched; the captains can still read", async () => {
    const { ctx, pilot } = await frozenPilot("Revoked Late");
    const p = await propose(ctx);
    for (let i = 0; i < 3; i++) await decide(ctx, i, p.digest, "CONFIRMED");
    const before = { plan: await currentPlanHash(ctx.competitionId), counts: await amendmentCounts(ctx.competitionId), revisions: await revisionCount(ctx.competitionId) };
    await pilot.revoke();
    const { HostAccessRevokedError } = await import("../lib/gaming/competitions/types");
    await expectRejects(decide(ctx, 3, p.digest, "CONFIRMED"), HostAccessRevokedError);
    await expectRejects(decide(ctx, 3, p.digest, "REJECTED"), HostAccessRevokedError);
    expect({ plan: await currentPlanHash(ctx.competitionId), counts: await amendmentCounts(ctx.competitionId), revisions: await revisionCount(ctx.competitionId) }).toEqual(before);
    const captainView = await statusFor(ctx, ctx.teams[0].captain.gamingMemberId);
    expect(captainView!.role).toEqual({ organizer: false, captain: true });
    expect(captainView!.amendment!.confirmedCount).toBe(3);
  }, 240000);

  it("[17A] after revocation the read is truthful: captains keep the bounded historical read but the window is closed and nothing is actionable; the revoked organizer reads nothing; every action is refused and nothing is recorded", async () => {
    const { ctx, pilot } = await frozenPilot("Revoked Truth");
    const { HostAccessRevokedError } = await import("../lib/gaming/competitions/types");
    const p = await propose(ctx);
    await decide(ctx, 0, p.digest, "CONFIRMED");
    // While the host is active the same read does invite the action — the control that makes "false" below mean something.
    const beforeOrganizer = (await statusFor(ctx, pilot.host.gamingMemberId))!;
    const beforeCaptain = (await statusFor(ctx, ctx.teams[1].captain.gamingMemberId))!;
    expect([beforeOrganizer.windowOpen, beforeOrganizer.amendment!.actionable, beforeCaptain.windowOpen, beforeCaptain.amendment!.actionable]).toEqual([true, true, true, true]);
    const before = { snapshot: await amendmentSnapshot(ctx.competitionId), plan: await currentPlanHash(ctx.competitionId) };

    await pilot.revoke();

    // READ: the four captains still see the proposal and its decision status — but truthfully.
    for (let i = 0; i < 4; i++) {
      const view = (await statusFor(ctx, ctx.teams[i].captain.gamingMemberId))!;
      expect(view.role, `captain ${i}`).toEqual({ organizer: false, captain: true });
      expect(view.windowOpen, `captain ${i}: window`).toBe(false);
      expect(view.amendment, `captain ${i}`).not.toBeNull();
      expect(view.amendment!.actionable, `captain ${i}: actionable`).toBe(false);
      expect([view.amendment!.status, view.amendment!.confirmedCount, view.amendment!.digest, view.history], `captain ${i}`).toEqual(["PENDING", 1, p.digest, null]);
    }
    expect(await statusFor(ctx, pilot.host.gamingMemberId)).toBeNull(); // the revoked organizer reads nothing as organizer
    // The same through the real routes, and through the addressed view's one signal.
    const routes = await loadRoutes();
    const get = await routes.base.GET(request(`${COMP}/${ctx.competitionId}/plan-amendment`, "GET", await tokenFor(ctx.teams[1].captain)), ctxOf(ctx.competitionId));
    expect(get.status).toBe(200);
    const shown = (await get.json()).amendment;
    expect([shown.windowOpen, shown.amendment.actionable, shown.amendment.status]).toEqual([false, false, "PENDING"]);
    expect((await routes.base.GET(request(`${COMP}/${ctx.competitionId}/plan-amendment`, "GET", await tokenFor(pilot.host)), ctxOf(ctx.competitionId))).status).toBe(404);
    expect((await getCompetitionView(compRepo, ctx.competitionId, ctx.teams[1].captain.gamingMemberId)).planAmendment).toEqual({ organizer: false, captain: true });
    expect("planAmendment" in (await getCompetitionView(compRepo, ctx.competitionId, pilot.host.gamingMemberId))).toBe(false);

    // ACTION: nothing the read no longer invites can be done.
    await expectRejects(decide(ctx, 1, p.digest, "CONFIRMED"), HostAccessRevokedError);
    await expectRejects(decide(ctx, 1, p.digest, "REJECTED"), HostAccessRevokedError);
    await expectRejects(decide(ctx, 3, p.digest, "CONFIRMED"), HostAccessRevokedError);
    await expectRejects(propose(ctx, facts({ name: `Revoked ${RUN}` })), HostAccessRevokedError);
    await expectRejects(withdraw(ctx, p.digest), HostAccessRevokedError);
    const decisionRoute = await routes.decision.POST(request(`${COMP}/${ctx.competitionId}/plan-amendment/decision`, "POST", await tokenFor(ctx.teams[1].captain), { amendmentDigest: p.digest, decision: "CONFIRMED" }), ctxOf(ctx.competitionId));
    expect(decisionRoute.status).toBe(404);
    expect({ snapshot: await amendmentSnapshot(ctx.competitionId), plan: await currentPlanHash(ctx.competitionId) }).toEqual(before);
  }, 300000);

  it("[17B] revocation takes precedence over every historical retry: a revoked organizer cannot replay a proposal or a withdrawal, a captain cannot replay a decision, and the records are untouched", async () => {
    const { ctx, pilot } = await frozenPilot("Revoked Retry");
    const { HostAccessRevokedError } = await import("../lib/gaming/competitions/types");
    const withdrawn = await propose(ctx, facts({ name: `W ${RUN}` }));
    await withdraw(ctx, withdrawn.digest);
    const intent = randomUUID();
    const f = facts({ name: `P ${RUN}` });
    const p = await propose(ctx, f, intent);
    await decide(ctx, 0, p.digest, "CONFIRMED");
    // The control: before the revocation every one of those retries is answered from the record.
    expect((await propose(ctx, f, intent)).alreadyProposed).toBe(true);
    expect(await withdraw(ctx, withdrawn.digest)).toEqual({ status: "WITHDRAWN", alreadyWithdrawn: true });
    expect((await decide(ctx, 0, p.digest, "CONFIRMED")).alreadyDecided).toBe(true);
    const before = { snapshot: await amendmentSnapshot(ctx.competitionId), plan: await currentPlanHash(ctx.competitionId) };

    await pilot.revoke();

    await expectRejects(propose(ctx, f, intent), HostAccessRevokedError);
    await expectRejects(withdraw(ctx, withdrawn.digest), HostAccessRevokedError);
    await expectRejects(decide(ctx, 0, p.digest, "CONFIRMED"), HostAccessRevokedError);
    await expectRejects(decide(ctx, 0, p.digest, "REJECTED"), HostAccessRevokedError);
    await expectRejects(decide(ctx, 2, p.digest, "CONFIRMED"), HostAccessRevokedError);
    expect({ snapshot: await amendmentSnapshot(ctx.competitionId), plan: await currentPlanHash(ctx.competitionId) }).toEqual(before);
  }, 300000);
});

// =============================================================================================================================================
// [authority] [visibility]
// =============================================================================================================================================

describe("[18][19] no authority and no visibility for anyone but the active organizer and the four frozen captains", () => {
  it("a stranger, another competition's organizer, a registrant, a team member, a scorekeeper and an OPERATIONAL holder get no authority, no read, and the same answers as for an unknown competition", async () => {
    const ctx = await setUp("Authority", { teamCount: 4 });
    await fillRosters(ctx, [5, 5, 5, 5]);
    const registrant = pool[41];
    await registerForCompetition(compRepo, ctx.competitionId, registrant.gamingMemberId, true); // registered before the freeze, on no team
    await passDeadline(ctx.competitionId);
    await closeTeamRegistration(compRepo, ctx.competitionId, ctx.organizer.gamingMemberId);

    // A scorekeeper of ANOTHER competition: a published bracket there, the appointment, and nothing here.
    const other = await frozen("Authority Other");
    const published = await publishCompetition(compRepo, other.competitionId, other.organizer.gamingMemberId, other.teams[0].teamId, other.teams[1].teamId, other.teams[2].teamId, other.teams[3].teamId,
      new Date(Date.now() + 3600_000).toISOString(), new Date(Date.now() + 7200_000).toISOString(), new Date(Date.now() + 10800_000).toISOString());
    const scorekeeper = await newPerson("Bystander Scorekeeper");
    await appointScorekeeper(compRepo, published.semifinal1FixtureId, other.organizer.gamingMemberId, scorekeeper.gamingMemberId);
    const bystanderOperator = await makeOperator("Bystander Operator");
    const stranger = await newPerson("Bystander Stranger");

    const p = await propose(ctx, facts({ name: `Secret Venue ${RUN}` }));
    await decide(ctx, 0, p.digest, "CONFIRMED");
    const { PlanAmendmentNotAvailableError } = await loadAmend();
    const { CompetitionAccessDeniedError } = await import("../lib/gaming/competitions/types");
    const actors: Array<[string, Person]> = [
      ["a stranger", stranger], ["another competition's organizer", other.organizer], ["a registrant on no team", pool[41]], ["a team member", pool[0]],
      ["a scorekeeper of another competition", scorekeeper], ["an OPERATIONAL holder", bystanderOperator],
    ];
    const token = async (person: Person) => tokenFor(person);
    const routes = await loadRoutes();
    const unknownId = randomUUID();
    const unknownBody = await (await routes.base.GET(request(`${COMP}/${unknownId}/plan-amendment`, "GET", await token(stranger)), ctxOf(unknownId))).text();
    for (const [label, actor] of actors) {
      await expectRejects(compRepo.proposePlanAmendment(ctx.competitionId, actor.gamingMemberId, randomUUID(), facts()), CompetitionAccessDeniedError);
      await expectRejects(compRepo.withdrawPlanAmendment(ctx.competitionId, actor.gamingMemberId, p.digest), CompetitionAccessDeniedError);
      await expectRejectsLazy(compRepo.decidePlanAmendment(ctx.competitionId, actor.gamingMemberId, p.digest, "CONFIRMED"), async () => PlanAmendmentNotAvailableError);
      expect(await compRepo.getPlanAmendmentStatus(ctx.competitionId, actor.gamingMemberId), label).toBeNull();
      // The real routes: the same 404, byte for byte, as for a competition that does not exist.
      const t = await token(actor);
      const get = await routes.base.GET(request(`${COMP}/${ctx.competitionId}/plan-amendment`, "GET", t), ctxOf(ctx.competitionId));
      expect([get.status, await get.text()], `${label}: GET`).toEqual([404, unknownBody]);
      const post = await routes.base.POST(request(`${COMP}/${ctx.competitionId}/plan-amendment`, "POST", t, { intentId: randomUUID(), amendment: facts() }), ctxOf(ctx.competitionId));
      expect(post.status, `${label}: propose`).toBe(404);
      const dec = await routes.decision.POST(request(`${COMP}/${ctx.competitionId}/plan-amendment/decision`, "POST", t, { amendmentDigest: p.digest, decision: "CONFIRMED" }), ctxOf(ctx.competitionId));
      expect(dec.status, `${label}: decision`).toBe(404);
      const wd = await routes.withdraw.POST(request(`${COMP}/${ctx.competitionId}/plan-amendment/withdraw`, "POST", t, { amendmentDigest: p.digest }), ctxOf(ctx.competitionId));
      expect(wd.status, `${label}: withdraw`).toBe(404);
      // The addressed view and the discovery list tell them nothing.
      const view = await viewRoute(request(`${COMP}/${ctx.competitionId}`, "GET", t), ctxOf(ctx.competitionId));
      const viewText = JSON.stringify(await view.json());
      expect(viewText, `${label}: view`).not.toMatch(/planAmendment|Secret Venue|amendment/i);
      const list = await listRoute(request(COMP, "GET", t));
      expect(JSON.stringify(await list.json()), `${label}: list`).not.toMatch(/planAmendment|Secret Venue|amendment/i);
    }
    expect(await amendmentCounts(ctx.competitionId)).toEqual({ proposals: 1, decisions: 1, resolutions: 0 });
    // NULL callers are nobody, in every function.
    const ids = { p_competition_id: ctx.competitionId };
    expect((await service.rpc("propose_competition_plan_amendment_atomically", { ...ids, p_organizer_gaming_member_id: null, p_intent_id: randomUUID(), p_amendment: rpcPayload(facts()) })).error?.message ?? "").toMatch(/COMPETITION_ACCESS_DENIED/);
    expect((await service.rpc("withdraw_competition_plan_amendment_atomically", { ...ids, p_organizer_gaming_member_id: null, p_amendment_digest: p.digest })).error?.message ?? "").toMatch(/COMPETITION_ACCESS_DENIED/);
    expect((await service.rpc("get_competition_plan_amendment_status", { ...ids, p_caller_gaming_member_id: null })).data).toBeNull();
  }, 600000);

  it("the active organizer and each frozen captain see the proposal and its decision status — and only they; the organizer alone sees the history; both view signals and routes agree", async () => {
    const ctx = await frozen("Visibility");
    const p = await propose(ctx, facts({ name: `Visible Venue ${RUN}` }));
    await decide(ctx, 1, p.digest, "CONFIRMED");
    const organizerView = (await statusFor(ctx, ctx.organizer.gamingMemberId))!;
    expect(organizerView.role).toEqual({ organizer: true, captain: false });
    expect(organizerView.history).toEqual([expect.objectContaining({ sequenceNumber: 1, status: "PENDING" })]);
    expect(organizerView.amendment!.proposed.venue.name).toBe(`Visible Venue ${RUN}`);
    expect(organizerView.amendment!.current.venue.name).toBe((await currentRevision(ctx.competitionId))!.venue.name);
    for (let i = 0; i < 4; i++) {
      const captainView = (await statusFor(ctx, ctx.teams[i].captain.gamingMemberId))!;
      expect(captainView.role).toEqual({ organizer: false, captain: true });
      expect(captainView.history).toBeNull();
      expect(captainView.myTeamName).toBe(`T${i} Visibility ${RUN}`.slice(0, `T${i} Visibility ${RUN}`.length));
      expect(captainView.amendment!.digest).toBe(p.digest);
      expect(captainView.amendment!.myDecision).toBe(i === 1 ? "CONFIRMED" : null);
      expect(captainView.amendment!.teams).toHaveLength(4);
    }
    // The real routes, with real tokens.
    const routes = await loadRoutes();
    const organizerGet = await routes.base.GET(request(`${COMP}/${ctx.competitionId}/plan-amendment`, "GET", await tokenFor(ctx.organizer)), ctxOf(ctx.competitionId));
    expect(organizerGet.status).toBe(200);
    expect(organizerGet.headers.get("cache-control")).toMatch(/no-store/);
    const body = await organizerGet.json();
    expect(body.amendment.amendment.digest).toBe(p.digest);
    expect(JSON.stringify(body)).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/);
    const captainGet = await routes.base.GET(request(`${COMP}/${ctx.competitionId}/plan-amendment`, "GET", await tokenFor(ctx.teams[2].captain)), ctxOf(ctx.competitionId));
    expect(captainGet.status).toBe(200);
    // The view signal, from the real view route.
    const viewAs = async (person: Person) => (await (await viewRoute(request(`${COMP}/${ctx.competitionId}`, "GET", await tokenFor(person)), ctxOf(ctx.competitionId))).json()).view;
    expect((await viewAs(ctx.organizer)).planAmendment).toEqual({ organizer: true, captain: false });
    expect((await viewAs(ctx.teams[0].captain)).planAmendment).toEqual({ organizer: false, captain: true });
    expect("planAmendment" in (await viewAs(pool[3]))).toBe(false);
    expect(JSON.stringify(await viewAs(ctx.teams[0].captain))).not.toMatch(/Visible Venue|digest/);
  }, 300000);

  it("end to end through the real routes: the organizer proposes, four captains confirm, the revision activates; every answer is bounded and uncached", async () => {
    const ctx = await frozen("Routes End To End");
    const routes = await loadRoutes();
    const organizerToken = await tokenFor(ctx.organizer);
    const intent = randomUUID();
    const proposeRes = await routes.base.POST(request(`${COMP}/${ctx.competitionId}/plan-amendment`, "POST", organizerToken, { intentId: intent, amendment: facts({ name: `Routed ${RUN}` }) }), ctxOf(ctx.competitionId));
    expect(proposeRes.status).toBe(201);
    const proposal = (await proposeRes.json()).amendment;
    const replay = await routes.base.POST(request(`${COMP}/${ctx.competitionId}/plan-amendment`, "POST", organizerToken, { intentId: intent, amendment: facts({ name: `Routed ${RUN}` }) }), ctxOf(ctx.competitionId));
    expect(replay.status).toBe(200);
    let last: any = null;
    for (let i = 0; i < 4; i++) {
      const res = await routes.decision.POST(request(`${COMP}/${ctx.competitionId}/plan-amendment/decision`, "POST", await tokenFor(ctx.teams[i].captain), { amendmentDigest: proposal.digest, decision: "CONFIRMED" }), ctxOf(ctx.competitionId));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toMatch(/no-store/);
      last = await res.json();
    }
    expect([last.status, last.confirmedCount, last.activatedRevisionNumber]).toEqual(["ACTIVATED", 4, 3]);
    expect((await currentRevision(ctx.competitionId))!.venue.name).toBe(`Routed ${RUN}`);
    // After activation the same proposal can no longer be withdrawn, and a stale decision is a bounded 409.
    const wd = await routes.withdraw.POST(request(`${COMP}/${ctx.competitionId}/plan-amendment/withdraw`, "POST", organizerToken, { amendmentDigest: proposal.digest }), ctxOf(ctx.competitionId));
    expect([wd.status, (await wd.json()).code]).toEqual([409, "NOT_PENDING"]);
    const stale = await routes.decision.POST(request(`${COMP}/${ctx.competitionId}/plan-amendment/decision`, "POST", await tokenFor(ctx.teams[0].captain), { amendmentDigest: "2".repeat(64), decision: "CONFIRMED" }), ctxOf(ctx.competitionId));
    expect([stale.status, (await stale.json()).code]).toEqual([409, "STALE"]);
    expect((await routes.base.POST(request(`${COMP}/${ctx.competitionId}/plan-amendment`, "POST", organizerToken, { intentId: randomUUID(), amendment: { ...facts(), venue: { ...facts().venue, timeZone: "America/Chicago" } } }), ctxOf(ctx.competitionId))).status).toBe(400);
    expect((await routes.base.GET(new Request(`${COMP}/${ctx.competitionId}/plan-amendment`), ctxOf(ctx.competitionId))).status).toBe(401);
  }, 300000);
});

// =============================================================================================================================================
// [window] the amendment surface exists only while the competition is frozen and nothing has been drawn, scheduled or played
// =============================================================================================================================================

describe("[20] the amendment window: READY_TO_PUBLISH, one freeze, an unchanged snapshot, and no fixture", () => {
  it("every other state refuses a proposal: DRAFT, TEAM_REGISTRATION_OPEN, a legacy READY_TO_PUBLISH with no freeze, PUBLISHED and CANCELLED", async () => {
    const { PlanAmendmentWindowClosedError } = await loadAmend();
    const draft = await setUp("Window Draft", { open: false });
    await expectRejectsLazy(propose(draft), async () => PlanAmendmentWindowClosedError);
    const open = await setUp("Window Open", { teamCount: 4 });
    await expectRejectsLazy(propose(open), async () => PlanAmendmentWindowClosedError);
    // A legacy shape (service-side): READY_TO_PUBLISH without a freeze — the state alone is not the window.
    await fillRosters(open, [5, 5, 5, 5]);
    await rawQuery("update competitions set state = 'READY_TO_PUBLISH' where competition_id = $1", [open.competitionId]);
    await expectRejectsLazy(propose(open), async () => PlanAmendmentWindowClosedError);
    const live = await frozen("Window Published");
    const pending = await propose(live);
    await publishCompetition(compRepo, live.competitionId, live.organizer.gamingMemberId, live.teams[0].teamId, live.teams[1].teamId, live.teams[2].teamId, live.teams[3].teamId,
      new Date(Date.now() + 3600_000).toISOString(), new Date(Date.now() + 7200_000).toISOString(), new Date(Date.now() + 10800_000).toISOString());
    expect(await stateOf(live.competitionId)).toBe("PUBLISHED");
    await expectRejectsLazy(propose(live, facts({ name: `After publish ${RUN}` })), async () => PlanAmendmentWindowClosedError);
    await expectRejectsLazy(decide(live, 0, pending.digest, "CONFIRMED"), async () => PlanAmendmentWindowClosedError);
    await expectRejectsLazy(withdraw(live, pending.digest), async () => PlanAmendmentWindowClosedError);
    const shown = (await statusFor(live, live.organizer.gamingMemberId))!;
    expect([shown.windowOpen, shown.amendment!.actionable]).toEqual([false, false]);
    expect((await currentRevision(live.competitionId))!.revisionNumber).toBe(2);
    const cancelled = await frozen("Window Cancelled");
    await cancelCompetition(compRepo, cancelled.competitionId, cancelled.organizer.gamingMemberId, "Cancelled before any amendment.");
    await expectRejectsLazy(propose(cancelled), async () => PlanAmendmentWindowClosedError);
  }, 600000);

  it("a fixture of any kind closes the window — for proposals, for decisions and for withdrawal; so do an inconsistent snapshot and a drifted captain", async () => {
    const { PlanAmendmentWindowClosedError, PlanAmendmentFreezeInconsistentError, PlanAmendmentNotAvailableError } = await loadAmend();
    const withFixture = await frozen("Window Fixture");
    const pending = await propose(withFixture);
    await decide(withFixture, 0, pending.digest, "CONFIRMED");
    // Service-side: a fixture row exists although the competition never left READY_TO_PUBLISH (what a later draw or schedule gate would leave behind).
    await rawQuery("insert into competition_fixtures (competition_id, fixture_role, scheduled_at, team_a_competition_team_id, team_b_competition_team_id, state) values ($1, 'SEMIFINAL_1', now() + interval '3 days', $2, $3, 'SCHEDULED')",
      [withFixture.competitionId, withFixture.teams[0].teamId, withFixture.teams[1].teamId]);
    await expectRejectsLazy(propose(withFixture, facts({ name: `Fixture ${RUN}` })), async () => PlanAmendmentWindowClosedError);
    await expectRejectsLazy(decide(withFixture, 1, pending.digest, "CONFIRMED"), async () => PlanAmendmentWindowClosedError);
    await expectRejectsLazy(withdraw(withFixture, pending.digest), async () => PlanAmendmentWindowClosedError);

    const drifted = await frozen("Window Snapshot");
    const p2 = await propose(drifted);
    // Service-side: a membership appears behind the freeze's back (no public path can do this).
    await rawQuery("insert into competition_team_memberships (competition_id, competition_team_id, gaming_member_id, approved_by_gaming_member_id) values ($1, $2, $3, $4)", [drifted.competitionId, drifted.teams[0].teamId, pool[42].gamingMemberId, drifted.organizer.gamingMemberId]);
    await expectRejectsLazy(propose(drifted, facts({ name: `Drift ${RUN}` })), async () => PlanAmendmentFreezeInconsistentError);
    await expectRejectsLazy(decide(drifted, 0, p2.digest, "CONFIRMED"), async () => PlanAmendmentFreezeInconsistentError);
    expect((await amendmentCounts(drifted.competitionId)).decisions).toBe(0);

    const swapped = await frozen("Window Captain");
    const p3 = await propose(swapped);
    const impostor = await newPerson("Impostor Captain");
    await rawQuery("update competition_teams set captain_gaming_member_id = $1 where competition_team_id = $2", [impostor.gamingMemberId, swapped.teams[0].teamId]); // service-side drift
    await expectRejectsLazy(decide(swapped, 0, p3.digest, "CONFIRMED"), async () => PlanAmendmentFreezeInconsistentError); // the frozen captain: the snapshot no longer matches
    await expectRejectsLazy(compRepo.decidePlanAmendment(swapped.competitionId, impostor.gamingMemberId, p3.digest, "CONFIRMED"), async () => PlanAmendmentNotAvailableError); // the new captain is not a frozen captain
    expect((await amendmentCounts(swapped.competitionId)).decisions).toBe(0);
  }, 600000);

  it("the frozen evidence must itself reproduce its recorded digest: a frozen member row removed behind its back (service-side, row triggers off) closes the window as inconsistent, though the live competition is untouched", async () => {
    const { PlanAmendmentFreezeInconsistentError } = await loadAmend();
    const ctx = await frozen("Window Evidence");
    const p = await propose(ctx);
    await decide(ctx, 0, p.digest, "CONFIRMED");
    const consistent = async () => (await rawQuery("select competition_registration_freeze_consistent($1) as ok", [ctx.competitionId]))[0].ok as boolean;
    expect(await consistent()).toBe(true);
    await rawTransaction(async (db) => {
      await db.query("set local session_replication_role = replica");
      await db.query("delete from competition_registration_freeze_members where ctid = (select ctid from competition_registration_freeze_members where competition_id = $1 limit 1)", [ctx.competitionId]);
      await db.query("commit");
    });
    expect(await consistent()).toBe(false);
    await expectRejectsLazy(propose(ctx, facts({ name: `Evidence ${RUN}` })), async () => PlanAmendmentFreezeInconsistentError);
    await expectRejectsLazy(decide(ctx, 1, p.digest, "CONFIRMED"), async () => PlanAmendmentFreezeInconsistentError);
    await expectRejectsLazy(withdraw(ctx, p.digest), async () => PlanAmendmentFreezeInconsistentError);
    expect(await amendmentCounts(ctx.competitionId)).toEqual({ proposals: 1, decisions: 1, resolutions: 0 });
    expect((await currentRevision(ctx.competitionId))!.revisionNumber).toBe(2);
  }, 240000);
});

// =============================================================================================================================================
// [dst] the venue's own clock changes
// =============================================================================================================================================

describe("[3] a window time that the venue's clock skips or repeats is refused by the database itself, in the venue's preserved time zone", () => {
  it("nonexistent and ambiguous local times are refused with the planning codes; a time on an ordinary day passes", async () => {
    const ctx = await frozen("Dst", { timeZone: "America/New_York", offsetMs: -4 * 3600_000 });
    const RAW = (date: string, start: string, end: string) => service.rpc("propose_competition_plan_amendment_atomically", {
      p_competition_id: ctx.competitionId, p_organizer_gaming_member_id: ctx.organizer.gamingMemberId, p_intent_id: randomUUID(),
      p_amendment: rpcPayload(facts({ dates: [{ date, windows: [{ start, end }] }] })),
    });
    expect((await RAW("2026-11-01", "01:30", "03:00")).error?.message ?? "no error").toMatch(/WINDOW_AMBIGUOUS_LOCAL_TIME/);
    expect((await RAW("2027-03-14", "02:30", "03:30")).error?.message ?? "no error").toMatch(/WINDOW_NONEXISTENT_LOCAL_TIME/);
    expect((await RAW("2026-11-01", "10:00", "02:00")).error?.message ?? "no error").toMatch(/WINDOW_CROSSES_MIDNIGHT/);
    expect((await amendmentCounts(ctx.competitionId)).proposals).toBe(0);
    const { PlanAmendmentValidationError } = await loadAmend();
    await expectRejectsLazy(propose(ctx, facts({ offsetMs: -4 * 3600_000, dates: [{ date: "2026-11-01", windows: [{ start: "01:30", end: "03:00" }] }] })), async () => PlanAmendmentValidationError);
    const ok = await propose(ctx, facts({ offsetMs: -4 * 3600_000, dates: [{ date: "2026-11-02", windows: [{ start: "10:00", end: "12:00" }] }] }));
    expect(ok.sequenceNumber).toBe(1);
    const stored = (await rawQuery("select proposed_plan -> 'venue' ->> 'time_zone' as tz from competition_plan_change_proposals where amendment_digest = $1", [ok.digest]))[0];
    expect(stored.tz).toBe("America/New_York"); // composed from the current revision, never from the request
  }, 300000);
});

// =============================================================================================================================================
// [regression] what must not change
// =============================================================================================================================================

describe("[21][22][23] the DRAFT planning save, the freeze evidence and the format registry are as they were", () => {
  it("DRAFT planning still saves, supersedes, replays and refuses exactly as before (the full SSS-004 suite is the complete evidence; this is a smoke check on the delegating function)", async () => {
    await ensurePool();
    const organizer = await makeOperator("Draft Regression");
    const created = await createCompetition(compRepo, organizer.gamingMemberId, `DraftRegression ${RUN}`, "SOCCER_5V5");
    competitionIds.push(created.competitionId);
    const first = await savePlan(created.competitionId, organizer.gamingMemberId, { deadlineMs: Date.now() + 3 * DAY });
    expect([first.revision.revisionNumber, first.alreadySaved, first.isCurrent]).toEqual([1, false, true]);
    const { parsePlanningPlan } = await loadPlanning();
    const plan = parsePlanningPlan(rawPlan({ deadlineMs: Date.now() + 3 * DAY }), "SOCCER_5V5");
    const intent = randomUUID();
    const a = await compRepo.savePlanningRevision(created.competitionId, organizer.gamingMemberId, intent, plan);
    const replay = await compRepo.savePlanningRevision(created.competitionId, organizer.gamingMemberId, intent, plan);
    expect([a.revision.revisionNumber, replay.alreadySaved, replay.revision.planningRevisionId]).toEqual([2, true, a.revision.planningRevisionId]);
    const stranger = await makeOperator("Draft Stranger");
    await expectRejects(compRepo.savePlanningRevision(created.competitionId, stranger.gamingMemberId, randomUUID(), plan), CompetitionAccessDeniedError);
    await openTeamRegistration(compRepo, created.competitionId, organizer.gamingMemberId);
    await expectRejects(compRepo.savePlanningRevision(created.competitionId, organizer.gamingMemberId, randomUUID(), plan), CompetitionNotDraftError);
    expect(await revisionCount(created.competitionId)).toBe(2);
  }, 180000);

  it("no new format becomes creatable or advertised, 5v5 creation is unchanged, and the format registry is byte-identical before and after everything this gate does", async () => {
    await ensurePool();
    const registry = async () => createHash("sha256").update(JSON.stringify(await rawQuery("select * from competition_format_rules order by format_key"))).digest("hex");
    const before = await registry();
    const operator = await makeOperator("Creation Probe");
    for (const format of ["SOCCER_6V6", "SOCCER_7V7", "SOCCER_8V8"]) {
      await expect(createCompetition(compRepo, operator.gamingMemberId, `Nope ${format} ${RUN}`, format)).rejects.toBeInstanceOf(UnsupportedActivityKeyError);
      const res = await generalCreateRoute(request(COMP, "POST", await tokenFor(operator), { name: `Nope ${format} ${RUN}`, activityKey: format }));
      expect(res.status).toBe(400);
    }
    const ok = await createCompetition(compRepo, operator.gamingMemberId, `Five ${RUN}`, "SOCCER_5V5");
    competitionIds.push(ok.competitionId);
    expect((await rawQuery("select activity_key from competitions where organizer_gaming_member_id = $1", [operator.gamingMemberId])).map((r) => r.activity_key)).toEqual(["SOCCER_5V5"]);
    expect(await registry()).toBe(before);
    expect((await rawQuery("select count(*)::int n from competition_format_rules"))[0].n).toBe(4);
    // A proposal can never carry a format: the competition's own is composed in.
    const ctx = await frozen("Format Guard");
    const p = await propose(ctx);
    expect((await rawQuery("select (proposed_plan ->> 'format') is null as none from competition_plan_change_proposals where amendment_digest = $1", [p.digest]))[0].none).toBe(true);
  }, 240000);
});
