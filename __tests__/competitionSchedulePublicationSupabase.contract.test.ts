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
import { publishCompetition } from "../lib/gaming/competitions/publishCompetition";
import { declareRoster } from "../lib/gaming/competitions/declareRoster";
import { appointScorekeeper } from "../lib/gaming/competitions/appointScorekeeper";
import { submitFixtureEvidence } from "../lib/gaming/competitions/submitFixtureEvidence";
import { finalizeFixture } from "../lib/gaming/competitions/finalizeFixture";
import { forfeitFixture } from "../lib/gaming/competitions/forfeitFixture";
import { voidFixture } from "../lib/gaming/competitions/voidFixture";
import { correctFixture } from "../lib/gaming/competitions/correctFixture";
import { CompetitionAccessDeniedError, CompetitionNotFoundError, HostAccessRevokedError, UnsupportedActivityKeyError } from "../lib/gaming/competitions/types";
import type { GoalEventInput, ParticipationAttestationInput } from "../lib/gaming/competitions/types";
import type { SoccerFormatKey } from "../lib/gaming/competitions/formats";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";
// The REAL route handlers, called with real user access tokens against the real local database.
import { POST as hostCreateRoute } from "../app/api/gaming/host/competition/route";

/**
 * UG-CR-GATE-SSS-025 — the atomic schedule publication, against a real (disposable, loopback-only) Postgres.
 *
 * Proves, in the database itself: a frozen, drawn four-team competition is published by ONE operation from the exact latest CURRENT schedule proposal the organizer names by its
 * digest — and from nothing a client can steer: only the competition's own ACTIVE organizer (never a captain, a scorekeeper, an ordinary member, a holder of OPERATIONAL authority
 * alone, another competition's organizer, nobody) and never a revoked host, even to replay; the lifecycle in the gate's order (the wrong state, the freeze, the permanent draw and its
 * evidence, a plan change awaiting the captains), a proposal that is superseded, stale (the plan moved on, the draw no longer matches), not found in THIS competition, or whose own
 * evidence does not reproduce; every scheduling rule judged again at the publication instant on the accepted clock seam (a kickoff at or before it is refused); exactly three
 * fixtures — the semifinals with the teams of draw positions one and two, three and four, the final with unresolved slots and the two semifinals as its sources — one resolution
 * recorded and the competition PUBLISHED at the very same database instant; an exact replay by the still-authorized organizer that writes nothing, a conflicting one that fails
 * closed, concurrent calls that leave one publication; every failure point rolled back whole; the resolution append-only, verified at commit and impossible to forge; no browser or
 * server role able to touch the table; the manual publication refused in the database for every competition with a freeze, a draw or a proposal and unchanged for every one
 * without; and the existing finalize, forfeit, void and correction propagation unchanged on the fixtures this operation creates.
 *
 * CLOCK. The decision instant is competition_registration_clock() (SSS-007): this file redefines it ONLY inside transactions it rolls back, and derives every instant from the
 * stored proposal, so nothing depends on the calendar. Service-side fixtures (the database owner) are used only to build the planned, frozen, drawn and proposed competition quickly,
 * to put a competition into a state no public path can reach, to forge evidence the operation never would and to inject failures — each is named where it is used.
 */

const env = loadEnv("development", process.cwd(), "");
const supabaseUrl = env.SUPABASE_URL;
requireLocalSupabase(supabaseUrl);
const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAnonKey = env.SUPABASE_ANON_KEY;
if (!supabaseUrl || !supabaseServiceRoleKey || !supabaseAnonKey) {
  throw new Error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are required for contract tests.");
}
// Raw pg runs the rolled-back clock seam, the fixtures, the forged evidence, the injected failures and the catalog checks. The URL is supplied explicitly, never read from .env.local,
// and must be loopback.
const supabaseDbUrl = process.env.COMPETITIONS_LOCAL_DB_URL ?? "";
if (!/^postgresql:\/\/[^@]+@(127\.0\.0\.1|localhost|\[::1\]):\d+\//.test(supabaseDbUrl)) {
  throw new Error("COMPETITIONS_LOCAL_DB_URL must be set to a loopback Postgres URL for the schedule publication contract tests.");
}

const compRepo = new SupabaseCompetitionsRepository(supabaseUrl, supabaseServiceRoleKey);
const hostRepo = new SupabaseHostRepository(supabaseUrl, supabaseServiceRoleKey);
const gamingRepo = new SupabaseGamingRepository(supabaseUrl, supabaseServiceRoleKey);
const service = createClient(supabaseUrl, supabaseServiceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
const anon = createClient(supabaseUrl, supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false } });

const RUN = randomUUID().slice(0, 8);
const DAY = 24 * 3600_000;
const TABLE = "competition_schedule_publications" as const;
const RPC = "publish_competition_schedule_atomically" as const;
const HELPERS = [
  "competition_schedule_publication_digest", "competition_schedule_publication_evidence", "competition_schedule_publication_reject_change",
  "competition_schedule_publication_verify", "competition_schedule_publication_verify_row",
] as const;
const ALL4 = ["SOCCER_5V5", "SOCCER_6V6", "SOCCER_7V7", "SOCCER_8V8"];
const ROLES = ["SEMIFINAL_1", "SEMIFINAL_2", "FINAL"] as const;
type Role = (typeof ROLES)[number];

// Loaded lazily: until the module exists, only the tests that need it can fail.
const loadPub = () => import("../lib/gaming/competitions/schedulePublication");
const loadPublishRoute = async () => (await import("../app/api/gaming/competitions/[competitionId]/publish/route")) as unknown as { POST: (r: Request, c: { params: { competitionId: string } }) => Promise<Response> };

// Independent known answers (oracle_publication.py — Python hashlib over the gate's canonical text).
const KAT = {
  competition: "11111111-1111-4111-8111-111111111111", revision: "22222222-2222-4222-8222-222222222222", draw: "55555555-5555-4555-8555-555555555555",
  organizer: "66666666-6666-4666-8666-666666666666", proposalDigest: createHash("sha256").update("proposal-two", "utf8").digest("hex"), drawDigest: createHash("sha256").update("draw", "utf8").digest("hex"),
  publication1: "ee51d34128c55cdc4ba91108c8f58fb9437503c1e0a1f681bc33556e7b244cec", publication2: "f13d58cdc1bd8354fd01ac7dabda22bdb8ac0cfe4cda7b189449a934310e2faf",
};

// ---------------------------------------------------------------------------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------------------------------------------------------------------------

interface Person { authUserId: string; gamingMemberId: string; email: string }
const authUsers: string[] = [];
const operators: string[] = [];
const competitionIds: string[] = [];
let counter = 0;

async function newPerson(label: string): Promise<Person> {
  const email = `pub-${RUN}-${counter++}@example.com`;
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
// Raw database access (the database owner), outcomes and the rolled-back clock
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
const CLOCK_DEFINITION = (instant: string) => `create or replace function public.competition_registration_clock() returns timestamptz language sql volatile set search_path to 'public' as $clock$ select '${instant}'::timestamptz $clock$`;
const PUBLISH_SQL = `select ${RPC}($1, $2, $3) as r`;

/**
 * One call of the operation inside a transaction that is ALWAYS rolled back, after optional service-side statements (run with row triggers off, then with them back on, so
 * the operation itself always runs with every trigger enabled) and optionally with the database clock put on an exact instant. When the call succeeds, every deferred check
 * (the commit-time verification of the resolution) is forced to run before the rollback, so a success here means the transaction would COMMIT.
 */
async function publishInTransaction(ctx: { competitionId: string; organizer: Person }, digest: string, opts: { statements?: string[]; instant?: string; caller?: string | null } = {}): Promise<Outcome> {
  const caller = opts.caller === undefined ? ctx.organizer.gamingMemberId : opts.caller;
  return rawTransaction(async (db) => {
    try {
      if (opts.statements?.length) {
        await db.query("set session_replication_role = replica");
        for (const statement of opts.statements) await db.query(statement);
        await db.query("set session_replication_role = origin");
      }
      if (opts.instant) await db.query(CLOCK_DEFINITION(opts.instant));
      const rows = (await db.query(PUBLISH_SQL, [ctx.competitionId, caller, digest])).rows;
      await db.query("set constraints all immediate");
      return { ok: true, rows };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      return { ok: false, message: e.message ?? "", code: e.code };
    }
  });
}

/** The stable word a refusal carries: a publication code, the legacy guard's code, or the competition's own. */
function refusalCode(outcome: Outcome): string {
  if (outcome.ok) return "OK";
  const invalid = /SCHEDULE_PUBLICATION_(?:INVALID|NOT_PUBLISHABLE): ([A-Z_]+):/.exec(outcome.message);
  if (invalid) return invalid[1];
  const publication = /SCHEDULE_PUBLICATION_([A-Z_]+)/.exec(outcome.message);
  if (publication) return publication[1];
  const typed = /(SCHEDULE_PROPOSAL_PUBLICATION_REQUIRED|COMPETITION_[A-Z_]+|HOST_ACCESS_REVOKED)/.exec(outcome.message);
  return typed ? typed[1] : `UNRECOGNISED: ${outcome.message}`;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Plans and competitions (as in the schedule proposal suite)
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

interface PlanSpec {
  timeZone: string;
  capacity: number;
  pitches: Array<{ label: string; usable: boolean; formats: string[] }>;
  dates: Array<{ date: string; windows: Array<{ start: string; end: string }> }>;
  /** The registration deadline, as a UTC instant, with the zone's offset in force then; it must be in the past (the real close needs it) and before the first window. */
  deadlineIso: string;
  deadlineOffsetMinutes: number;
}

/**
 * Service-side fixture: records a later planning revision as the database owner, exactly as the plan spec says (venue zone, capacity, pitches with the formats each takes, dates
 * and windows, the deadline). The revision chain, the children and every constraint are the real ones; only the save operation (which needs a DRAFT, a future deadline and a
 * minute-resolution deadline) is bypassed. Used BEFORE the freeze, so the freeze records exactly this revision.
 */
async function recordPlan(competitionId: string, spec: PlanSpec): Promise<string> {
  return rawTransaction(async (db) => {
    const cur = (await db.query("select * from competition_planning_revisions where competition_id = $1 order by revision_number desc limit 1", [competitionId])).rows[0];
    const next = (await db.query(
      `insert into competition_planning_revisions (competition_id, format_key, revision_number, supersedes_revision_id, authored_by_gaming_member_id, intent_id, payload_digest,
         venue_name, venue_location_description, venue_time_zone, simultaneous_match_capacity, venue_restriction_notes, roster_minimum, roster_maximum,
         registration_deadline_local, registration_deadline_time_zone, registration_deadline_utc_offset_minutes, registration_deadline_utc, rules_version, rules_snapshot, rules_snapshot_digest)
       values ($1,$2,$3,$4,$5,gen_random_uuid(),$6,$7,$8,$9,$10,$11,$12,$13, ($14::timestamptz at time zone $9), $9, $15, $14::timestamptz, $16,$17,$18) returning planning_revision_id`,
      [competitionId, cur.format_key, cur.revision_number + 1, cur.planning_revision_id, cur.authored_by_gaming_member_id, cur.payload_digest, cur.venue_name, cur.venue_location_description,
        spec.timeZone, spec.capacity, cur.venue_restriction_notes, cur.roster_minimum, cur.roster_maximum, spec.deadlineIso, spec.deadlineOffsetMinutes,
        cur.rules_version, cur.rules_snapshot, cur.rules_snapshot_digest])).rows[0].planning_revision_id as string;
    for (let i = 0; i < spec.pitches.length; i++) {
      const pitch = spec.pitches[i];
      const id = (await db.query("insert into competition_planning_pitches (planning_revision_id, position, label, is_usable, restriction_notes) values ($1,$2,$3,$4,'') returning planning_pitch_id", [next, i + 1, pitch.label, pitch.usable])).rows[0].planning_pitch_id as string;
      for (const format of pitch.formats) await db.query("insert into competition_planning_pitch_formats (planning_pitch_id, format_key) values ($1,$2)", [id, format]);
    }
    const dates = [...spec.dates].sort((a, b) => (a.date < b.date ? -1 : 1));
    for (let i = 0; i < dates.length; i++) {
      await db.query("insert into competition_planning_dates (planning_revision_id, plan_date, position) values ($1,$2,$3)", [next, dates[i].date, i + 1]);
      const windows = [...dates[i].windows].sort((a, b) => (a.start < b.start ? -1 : 1));
      for (let j = 0; j < windows.length; j++) {
        await db.query("insert into competition_planning_windows (planning_revision_id, plan_date, window_index, start_time, end_time) values ($1,$2,$3,$4,$5)", [next, dates[i].date, j + 1, windows[j].start, windows[j].end]);
      }
    }
    await db.query("commit");
    return next;
  });
}

/**
 * The live plans' registration deadline: ten whole minutes before the start of this minute. The real close judges "the deadline has been reached" on the DATABASE's clock, while this
 * test picks the deadline on the HOST's clock; a deadline only seconds ago would make that judgment depend on the sub-second difference between the two clocks (a virtual machine's
 * clock can lag the host's), and so on how far into the minute the fixture happened to be built. Ten minutes makes it independent of any such difference.
 */
const livePlanDeadline = () => new Date(Math.floor(Date.now() / 60_000) * 60_000 - 10 * 60_000).toISOString();
const PITCHES_5V5_MIXED = [
  { label: "A", usable: true, formats: ALL4 }, { label: "B", usable: true, formats: ALL4 }, { label: "C", usable: true, formats: ["SOCCER_5V5"] },
  { label: "E", usable: false, formats: ["SOCCER_5V5"] }, { label: "F", usable: true, formats: ["SOCCER_6V6"] },
];
/** A plan whose dates are relative to the real clock (five and six days ahead): every proposal here is made and published against the real calendar. */
function liveSpec(capacity = 2): PlanSpec {
  return {
    timeZone: "America/Costa_Rica", capacity, pitches: PITCHES_5V5_MIXED, deadlineIso: livePlanDeadline(), deadlineOffsetMinutes: -360,
    dates: [
      { date: localDate(Date.now() + 5 * DAY), windows: [{ start: "09:00", end: "12:00" }, { start: "13:00", end: "16:00" }] },
      { date: localDate(Date.now() + 6 * DAY), windows: [{ start: "09:00", end: "10:00" }, { start: "10:05", end: "12:00" }] },
    ],
  };
}

interface Ctx {
  competitionId: string; organizer: Person; deadlineMs: number; teams: Array<{ teamId: string; captain: Person; members: string[] }>;
  /** label -> planning pitch id of the plan revision the freeze recorded */
  pitch: Record<string, string>;
  /** "1", "2" -> the plan's dates, in order; "3" is a date that is NOT in the plan */
  dates: Record<string, string>;
  revisionId: string;
}
interface PCtx extends Ctx { digest: string; sequence: number }

/** A competition with a saved plan, four organizer-created teams and (optionally) open registration. */
async function setUp(label: string, opts: { open?: boolean; teamCount?: number } = {}): Promise<Omit<Ctx, "pitch" | "dates" | "revisionId">> {
  await ensurePool();
  const deadlineMs = Date.now() + 2 * DAY;
  const organizer = await makeOperator(`${label} Organizer`);
  const created = await createCompetition(compRepo, organizer.gamingMemberId, `Publication ${label} ${RUN}`, "SOCCER_5V5");
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
async function giveMembers(ctx: { competitionId: string; organizer: Person; teams: Ctx["teams"] }, teamIndex: number, count: number): Promise<string[]> {
  const start = ctx.teams.slice(0, teamIndex).reduce((n, t) => n + t.members.length, 0);
  const slice = pool.slice(start, start + count).map((p) => p.gamingMemberId);
  expect(slice).toHaveLength(count);
  await rawQuery(
    "insert into competition_team_memberships (competition_id, competition_team_id, gaming_member_id, approved_by_gaming_member_id) select $1, $2, unnest($3::uuid[]), $4",
    [ctx.competitionId, ctx.teams[teamIndex].teamId, slice, ctx.organizer.gamingMemberId]);
  ctx.teams[teamIndex].members.push(...slice);
  return slice;
}
async function fillRosters(ctx: { competitionId: string; organizer: Person; teams: Ctx["teams"] }, size = 5) { for (let i = 0; i < ctx.teams.length; i++) await giveMembers(ctx, i, size); }

async function pitchIds(competitionId: string): Promise<{ pitch: Record<string, string>; dates: Record<string, string>; revisionId: string }> {
  const rev = (await rawQuery("select planning_revision_id from competition_planning_revisions where competition_id = $1 order by revision_number desc limit 1", [competitionId]))[0].planning_revision_id as string;
  const pitches = await rawQuery("select label, planning_pitch_id from competition_planning_pitches where planning_revision_id = $1", [rev]);
  const dates = await rawQuery("select to_char(plan_date, 'YYYY-MM-DD') as d from competition_planning_dates where planning_revision_id = $1 order by position", [rev]);
  const byIndex: Record<string, string> = {};
  dates.forEach((d, i) => { byIndex[String(i + 1)] = d.d as string; });
  byIndex["3"] = new Date(Date.parse(`${dates[dates.length - 1].d as string}T00:00:00Z`) + 2 * DAY).toISOString().slice(0, 10);
  return { pitch: { ...Object.fromEntries(pitches.map((p) => [p.label as string, p.planning_pitch_id as string])), X: randomUUID() }, dates: byIndex, revisionId: rev };
}

/** A frozen competition on this plan: four teams whose rosters were filled, the plan recorded (service-side), and registration frozen through the real close. NOT yet drawn. */
async function frozenOn(label: string, spec: PlanSpec): Promise<Ctx> {
  const base = await setUp(label);
  await fillRosters(base);
  await recordPlan(base.competitionId, spec);
  expect((await closeTeamRegistration(compRepo, base.competitionId, base.organizer.gamingMemberId)).state).toBe("READY_TO_PUBLISH");
  return { ...base, ...(await pitchIds(base.competitionId)) };
}
/** A frozen, DRAWN competition: the state in which an organizer may propose a schedule. */
async function drawnOn(label: string, spec: PlanSpec): Promise<Ctx> {
  const ctx = await frozenOn(label, spec);
  await compRepo.createCompetitionDraw(ctx.competitionId, ctx.organizer.gamingMemberId, randomUUID());
  return ctx;
}

/** "A 1 09:00" = pitch A, plan date 1, venue-local 09:00, in the competition's own plan. */
function req(ctx: Ctx, a: string, b: string, c: string) {
  return [["SEMIFINAL_1", a], ["SEMIFINAL_2", b], ["FINAL", c]].map(([role, spec]) => {
    const [label, day, time] = spec.split(" ");
    return { fixtureRole: role, planningPitchId: ctx.pitch[label], planDate: ctx.dates[day], startTime: time };
  });
}
const GOOD = (ctx: Ctx) => req(ctx, "A 1 09:00", "B 1 09:00", "A 1 10:08");
const SEQUENTIAL = (ctx: Ctx) => req(ctx, "A 1 09:00", "A 1 09:48", "A 1 10:56");
const propose = (ctx: Ctx, placements: ReturnType<typeof req>, intent: string = randomUUID()) => compRepo.createScheduleProposal(ctx.competitionId, ctx.organizer.gamingMemberId, intent, placements as never);

/** A frozen, drawn competition with one CURRENT schedule proposal: the state in which the organizer may publish. */
async function proposed(label: string, spec: PlanSpec = liveSpec(2)): Promise<PCtx> {
  const ctx = await drawnOn(label, spec);
  const made = await propose(ctx, GOOD(ctx));
  return { ...ctx, digest: made.proposal.proposalDigest, sequence: made.proposal.sequenceNumber };
}
const publish = (ctx: { competitionId: string; organizer: Person }, digest: string, caller: string = ctx.organizer.gamingMemberId) => compRepo.publishScheduledCompetition(ctx.competitionId, caller, digest);

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
  const revoke = () => asGovernance(() => revokeHostCapability(hostRepo, reviewer.gamingMemberId, submitted.publicCode, "Schedule publication contract test."));
  return { host, competitionId, revoke };
}

/** A host pilot taken through plan, registration, rosters, the freeze and the draw, with one CURRENT proposal made by the host. */
async function proposedPilot(label: string) {
  await ensurePool();
  const pilot = await hostPilot(label);
  const ctx = { competitionId: pilot.competitionId, organizer: pilot.host, deadlineMs: Date.now() + 2 * DAY, teams: [] as Ctx["teams"] };
  for (let i = 0; i < 4; i++) {
    const team = await addCompetitionTeam(compRepo, ctx.competitionId, pilot.host.gamingMemberId, `P${i} ${label.slice(0, 10)} ${RUN}`, captains[i].gamingMemberId);
    ctx.teams.push({ teamId: team.competitionTeamId, captain: captains[i], members: [] });
  }
  await savePlan(ctx.competitionId, pilot.host.gamingMemberId, ctx.deadlineMs);
  await openTeamRegistration(compRepo, ctx.competitionId, pilot.host.gamingMemberId);
  await fillRosters(ctx);
  await recordPlan(ctx.competitionId, liveSpec(2));
  await closeTeamRegistration(compRepo, ctx.competitionId, pilot.host.gamingMemberId);
  await compRepo.createCompetitionDraw(ctx.competitionId, pilot.host.gamingMemberId, randomUUID());
  const full: Ctx = { ...ctx, ...(await pitchIds(ctx.competitionId)) };
  const made = await propose(full, GOOD(full));
  return { ctx: { ...full, digest: made.proposal.proposalDigest, sequence: made.proposal.sequenceNumber } as PCtx, pilot };
}

/** An amendable proposal (a plan change): a new venue, the same pitch labels, one new date. */
function amendmentFacts(name = `Amended Venue ${RUN}`) {
  return {
    venue: { name, locationDescription: "Calle 9, San José, behind the old market", restrictionNotes: "Lights off at 21:00.", simultaneousMatchCapacity: 2 },
    pitches: [{ label: "A", usable: true, supportedFormats: ALL4 as SoccerFormatKey[], restrictionNotes: "" }, { label: "B", usable: true, supportedFormats: ALL4 as SoccerFormatKey[], restrictionNotes: "" }],
    dates: [{ date: localDate(Date.now() + 7 * DAY), windows: [{ start: "09:00", end: "13:00" }] }],
  };
}
const proposeChange = (ctx: Ctx, f = amendmentFacts()) => compRepo.proposePlanAmendment(ctx.competitionId, ctx.organizer.gamingMemberId, randomUUID(), f);
const decideChange = (ctx: Ctx, team: number, digest: string, decision: "CONFIRMED" | "REJECTED") => compRepo.decidePlanAmendment(ctx.competitionId, ctx.teams[team].captain.gamingMemberId, digest, decision);
const withdrawChange = (ctx: Ctx, digest: string) => compRepo.withdrawPlanAmendment(ctx.competitionId, ctx.organizer.gamingMemberId, digest);
async function activateChange(ctx: Ctx): Promise<void> {
  const p = await proposeChange(ctx);
  for (let i = 0; i < 4; i++) await decideChange(ctx, i, p.digest, "CONFIRMED");
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Routes, environment and clean-up
// ---------------------------------------------------------------------------------------------------------------------------------------------

const COMP = "http://localhost/api/gaming/competitions";
const request = (url: string, method: string, token: string | null, body?: unknown) =>
  new Request(url, { method, headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
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

// Evidence rows are append-only, so the owner removes them with row triggers off (replica role). Every statement runs on its own: one that cannot run must not stop the rest.
// Best effort beyond that: a database reset restores a clean state. The publications' rows go FIRST (they reference the fixtures, the proposals and the draw), then the proposals'.
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
        "delete from competition_schedule_publications where competition_id = any($1)",
        "delete from competition_schedule_proposal_placements where competition_id = any($1)",
        "delete from competition_schedule_proposals where competition_id = any($1)",
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
        ...["soccer_goal_events", "soccer_assist_events", "soccer_penalty_shootouts", "competition_participation_attestations", "competition_member_participation_records", "competition_fixture_corrections",
          "competition_disputes", "competition_fixture_finalizations", "competition_fixture_evidence", "competition_checkins"].map((table) => `delete from ${table} where competition_fixture_id in ${fx}`),
        `delete from competition_roster_revision_entries where competition_roster_revision_id in (select competition_roster_revision_id from competition_roster_revisions where competition_fixture_id in ${fx})`,
        `delete from competition_roster_revisions where competition_fixture_id in ${fx}`,
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

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const USTAMP = `'YYYY-MM-DD"T"HH24:MI:SS.US"Z"'`;
const MSTAMP = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

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
/** The publication must be refused with the typed refusal carrying this stable code. */
async function expectRefusal(promise: Promise<unknown>, code: string) {
  let caught: unknown = null;
  let resolved = false;
  try {
    await promise;
    resolved = true;
  } catch (err) {
    caught = err;
  }
  expect(resolved, `the publication must be refused with ${code}, but it succeeded`).toBe(false);
  const { SchedulePublicationError } = await loadPub();
  expect(caught, String((caught as Error)?.message)).toBeInstanceOf(SchedulePublicationError);
  expect((caught as { code: string }).code).toBe(code);
}
/** The publication must be refused because the schedule can no longer be published, with the stable code of the rule it breaks. */
async function expectNotPublishable(promise: Promise<unknown>, rule: string) {
  let caught: unknown = null;
  try { await promise; } catch (err) { caught = err; }
  const { SchedulePublicationNotPublishableError } = await loadPub();
  expect(caught, `the publication must be refused as ${rule}`).toBeInstanceOf(SchedulePublicationNotPublishableError);
  expect((caught as { violations: Array<{ code: string }> }).violations.map((v) => v.code)).toEqual([rule]);
}

interface FixtureRow { id: string; role: Role; a: string | null; b: string | null; sa: string | null; sb: string | null; state: string; sk: string | null; starts: string }
async function fixturesOf(competitionId: string): Promise<Record<Role, FixtureRow>> {
  const rows = await rawQuery(
    `select competition_fixture_id as id, fixture_role as role, team_a_competition_team_id as a, team_b_competition_team_id as b, team_a_source_fixture_id as sa, team_b_source_fixture_id as sb,
            state, scorekeeper_gaming_member_id as sk, to_char(scheduled_at at time zone 'UTC', ${MSTAMP}) as starts
       from competition_fixtures where competition_id = $1`, [competitionId]);
  return Object.fromEntries(rows.map((r) => [r.role, r])) as Record<Role, FixtureRow>;
}
const fixtureCount = async (competitionId: string) => (await rawQuery("select count(*)::int n from competition_fixtures where competition_id = $1", [competitionId]))[0].n as number;
const publicationRows = (competitionId: string) => rawQuery(`select * from ${TABLE} where competition_id = $1`, [competitionId]);
const stateOf = async (competitionId: string) => (await rawQuery(`select state, published_at, to_char(published_at at time zone 'UTC', ${USTAMP}) as published_stamp from competitions where competition_id = $1`, [competitionId]))[0] as { state: string; published_at: Date | null; published_stamp: string | null };
const drawOrder = async (competitionId: string) => (await rawQuery("select competition_team_id from competition_draw_entries where competition_id = $1 order by draw_position", [competitionId])).map((r) => r.competition_team_id as string);
const placementStarts = async (digest: string) => {
  const rows = await rawQuery(
    `select x.fixture_role as role, to_char(x.starts_at at time zone 'UTC', ${MSTAMP}) as starts from competition_schedule_proposal_placements x
      join competition_schedule_proposals p on p.schedule_proposal_id = x.schedule_proposal_id where p.proposal_digest = $1`, [digest]);
  return Object.fromEntries(rows.map((r) => [r.role, r.starts])) as Record<Role, string>;
};

/** A hash of each part of everything a competition carries; a retry or a refused call must leave every part byte-identical. */
async function snapshot(competitionId: string): Promise<Record<string, string>> {
  const agg = (table: string) => `(select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]') from ${table} x where x.competition_id = $1)`;
  const row = (await rawQuery(
    `select (select to_jsonb(c) from competitions c where c.competition_id = $1) as competition,
            ${agg("competition_teams")} as teams, ${agg("competition_team_memberships")} as memberships, ${agg("competition_registrations")} as registrations,
            ${agg("competition_join_requests")} as join_requests, ${agg("competition_fixtures")} as fixtures, ${agg("competition_registration_freezes")} as freezes,
            ${agg("competition_registration_freeze_teams")} as freeze_teams, ${agg("competition_registration_freeze_members")} as freeze_members,
            ${agg("competition_draws")} as draws, ${agg("competition_draw_entries")} as draw_entries,
            ${agg("competition_planning_revisions")} as revisions, ${agg("competition_plan_change_proposals")} as amendments, ${agg("competition_plan_change_decisions")} as decisions,
            ${agg("competition_plan_change_resolutions")} as resolutions, ${agg("competition_host_capabilities")} as hosts,
            ${agg("competition_schedule_proposals")} as proposals, ${agg("competition_schedule_proposal_placements")} as placements,
            ${agg("competition_schedule_publications")} as publications`, [competitionId]))[0];
  return Object.fromEntries(Object.entries(row).map(([k, v]) => [k, sha(JSON.stringify(v))]));
}
const changedParts = (a: Record<string, string>, b: Record<string, string>) => Object.keys(a).filter((k) => a[k] !== b[k]).sort();
const NOTHING_CHANGED: string[] = [];

const SQL_CREATE_FAIL = `create or replace function public.zz_fail_publication_${RUN}() returns trigger language plpgsql as $f$ begin raise exception 'INJECTED_FAILURE %', tg_argv[0]; end $f$`;

// ---------------------------------------------------------------------------------------------------------------------------------------------
// [fixture] control
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("[fixture] a drawn competition with one CURRENT proposal can be built through the public lifecycle (this passes before the feature exists)", () => {
  it("READY_TO_PUBLISH, one freeze of four teams, one permanent draw of those four teams, one CURRENT proposal, no fixture", async () => {
    const ctx = await proposed("Fixture");
    expect((await stateOf(ctx.competitionId)).state).toBe("READY_TO_PUBLISH");
    expect((await stateOf(ctx.competitionId)).published_at).toBeNull();
    expect(await rawQuery("select count(*)::int n from competition_registration_freeze_teams where competition_id = $1", [ctx.competitionId])).toEqual([{ n: 4 }]);
    expect(await rawQuery("select count(*)::int n from competition_draw_entries where competition_id = $1", [ctx.competitionId])).toEqual([{ n: 4 }]);
    expect(await fixtureCount(ctx.competitionId)).toBe(0);
    const read = await compRepo.getScheduleProposals(ctx.competitionId, ctx.organizer.gamingMemberId);
    expect(read?.proposal?.status).toBe("CURRENT");
    expect(read?.proposal?.proposalDigest).toBe(ctx.digest);
    expect(ctx.digest).toMatch(/^[0-9a-f]{64}$/);
  }, 180000);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// [23] the data boundary
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("[23] the data boundary: one server-only append-only table, one service-role operation, internal helpers nobody can run", () => {
  it("the table exists with row-level security on, no policy and no privilege for anyone — not even the server role", async () => {
    const [table] = await rawQuery("select c.relrowsecurity as rls, c.relkind as kind from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relname = $1", [TABLE]);
    expect(table, "the publication table exists").toBeDefined();
    expect(table.kind).toBe("r");
    expect(table.rls).toBe(true);
    expect(await rawQuery("select policyname from pg_policies where schemaname = 'public' and tablename = $1", [TABLE])).toEqual([]);
    for (const role of ["anon", "authenticated", "service_role"]) {
      for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
        const [row] = await rawQuery("select has_table_privilege($1, $2, $3) as allowed", [role, `public.${TABLE}`, privilege]);
        expect(row.allowed, `${role} ${privilege}`).toBe(false);
      }
    }
    expect(await rawQuery("select grantee from information_schema.role_table_grants where table_schema = 'public' and table_name = $1 and grantee in ('PUBLIC','anon','authenticated','service_role')", [TABLE])).toEqual([]);
  });

  it("the migration adds exactly these functions: the one operation and the internal helpers — nothing else with 'schedule_publication' in its name", async () => {
    const rows = await rawQuery("select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and (p.proname like '%schedule_publication%' or p.proname = $1) order by 1", [RPC]);
    expect(rows.map((r) => r.proname)).toEqual([...HELPERS, RPC].sort());
  });

  it("the operation is SECURITY DEFINER with a pinned search_path and executable by the server role alone; every helper by nobody", async () => {
    const [op] = await rawQuery("select p.prosecdef, p.proconfig, p.pronargs from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1", [RPC]);
    expect(op, "the operation exists").toBeDefined();
    expect(op.prosecdef).toBe(true);
    expect(op.pronargs).toBe(3);
    expect((op.proconfig as string[]).some((c) => /^search_path=public, pg_temp$/.test(c))).toBe(true);
    const signature = `public.${RPC}(uuid, uuid, text)`;
    expect((await rawQuery("select has_function_privilege('service_role', $1, 'EXECUTE') as a", [signature]))[0].a).toBe(true);
    for (const role of ["anon", "authenticated"]) expect((await rawQuery("select has_function_privilege($1, $2, 'EXECUTE') as a", [role, signature]))[0].a, role).toBe(false);
    for (const helper of HELPERS) {
      const [h] = await rawQuery("select p.oid::regprocedure::text as sig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1", [helper]);
      expect(h, helper).toBeDefined();
      for (const role of ["anon", "authenticated", "service_role"]) expect((await rawQuery("select has_function_privilege($1, $2, 'EXECUTE') as a", [role, h.sig]))[0].a, `${helper} for ${role}`).toBe(false);
    }
  });

  it("no browser role can read or write a publication through the API, with or without a signed-in user; the server role cannot write one directly either", async () => {
    // The table must EXIST first: a refusal for a table that is not there proves nothing.
    expect(await rawQuery("select 1 from pg_class where relname = $1 and relnamespace = 'public'::regnamespace and relkind = 'r'", [TABLE])).toHaveLength(1);
    const user = await newPerson("Table Probe");
    const signedIn = createClient(supabaseUrl, supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${await tokenFor(user)}` } } });
    const row = { competition_id: randomUUID(), schedule_proposal_id: randomUUID() };
    for (const [who, client] of [["anon", anon], ["signed-in member", signedIn], ["service role", service]] as const) {
      const read = await client.from(TABLE).select("*").limit(1);
      expect(read.error?.code, `${who} select`).toBe("42501"); // permission denied for the table — not 'no such table'
      expect(read.data ?? [], `${who} select data`).toEqual([]);
      expect((await client.from(TABLE).insert(row)).error?.code, `${who} insert`).toBe("42501");
      expect((await client.from(TABLE).update({ published_at: new Date().toISOString() }).eq("competition_id", row.competition_id)).error?.code, `${who} update`).toBe("42501");
      expect((await client.from(TABLE).delete().eq("competition_id", row.competition_id)).error?.code, `${who} delete`).toBe("42501");
    }
    for (const client of [anon, signedIn]) {
      const call = await client.rpc(RPC, { p_competition_id: randomUUID(), p_organizer_gaming_member_id: randomUUID(), p_schedule_proposal_digest: "0".repeat(64) });
      expect(call.error, "the operation is not callable from a browser").not.toBeNull();
    }
  }, 60000);

  it("only the operation's own family of functions mentions the publication table: no discovery, view or administration function reads it", async () => {
    const rows = await rawQuery("select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prosrc like $1 order by 1", [`%${TABLE}%`]);
    const names = rows.map((r) => r.proname as string);
    expect(names.length).toBeGreaterThan(0);
    for (const name of names) expect(name === RPC || /^competition_schedule_publication/.test(name), name).toBe(true);
  });

  it("the legacy manual publication is still executable by the server role alone — the privileges of the replaced function are exactly what they were", async () => {
    const [fn] = await rawQuery("select p.oid::regprocedure::text as sig, p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'publish_competition_atomically'");
    expect(fn.prosecdef).toBe(true);
    expect((await rawQuery("select has_function_privilege('service_role', $1, 'EXECUTE') as a", [fn.sig]))[0].a).toBe(true);
    for (const role of ["anon", "authenticated"]) expect((await rawQuery("select has_function_privilege($1, $2, 'EXECUTE') as a", [role, fn.sig]))[0].a, role).toBe(false);
    expect((fn.proconfig as string[]).some((c) => /^search_path=/.test(c))).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// [3] [4] who may publish
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("[3] only the competition's own ACTIVE organizer may publish; everyone else is told the same thing, before anything else is looked at", () => {
  let ctx: PCtx;
  let other: PCtx;
  beforeAll(async () => {
    ctx = await proposed("Authority");
    other = await proposed("Authority Other");
  }, 360000);

  it("a frozen captain, a player, a member holding only OPERATIONAL authority, another competition's organizer, a stranger and an unknown member are all refused as access denied, and nothing is written", async () => {
    const operatorOnly = await makeOperator("Operational Only");
    const stranger = await newPerson("Stranger");
    const before = await snapshot(ctx.competitionId);
    for (const [who, id] of [
      ["a frozen captain", ctx.teams[0].captain.gamingMemberId], ["a player", ctx.teams[0].members[0]], ["a member holding only OPERATIONAL authority", operatorOnly.gamingMemberId],
      ["another competition's organizer", other.organizer.gamingMemberId], ["a stranger", stranger.gamingMemberId], ["an unknown member", randomUUID()],
    ] as const) {
      await expectRejects(publish(ctx, ctx.digest, id), CompetitionAccessDeniedError).catch((e) => { throw new Error(`${who}: ${e.message}`); });
    }
    expect(changedParts(before, await snapshot(ctx.competitionId))).toEqual(NOTHING_CHANGED);
    expect(await fixtureCount(ctx.competitionId)).toBe(0);
  }, 120000);

  it("a NULL caller is refused as access denied, never skipped — through the repository and through the database directly", async () => {
    await expectRejects(compRepo.publishScheduledCompetition(ctx.competitionId, null as never, ctx.digest), CompetitionAccessDeniedError);
    const direct = await publishInTransaction(ctx, ctx.digest, { caller: null });
    expect(refusalCode(direct)).toBe("COMPETITION_ACCESS_DENIED");
    expect(await fixtureCount(ctx.competitionId)).toBe(0);
  });

  it("the denial comes BEFORE any digest, state or proposal disclosure: a stranger gets exactly the same answer for the right digest, a wrong one and a malformed one", async () => {
    const stranger = await newPerson("Stranger Disclosure");
    const answers: string[] = [];
    for (const digest of [ctx.digest, "f".repeat(64), "not a digest", other.digest]) {
      const outcome = await publishInTransaction(ctx, digest, { caller: stranger.gamingMemberId });
      answers.push(refusalCode(outcome));
    }
    expect(new Set(answers)).toEqual(new Set(["COMPETITION_ACCESS_DENIED"]));
    // the same for a competition whose state could otherwise be told
    const wrongState = await publishInTransaction(ctx, ctx.digest, { caller: stranger.gamingMemberId, statements: ["update competitions set state = 'CANCELLED_WITHOUT_CHAMPION' where competition_id = '" + ctx.competitionId + "'"] });
    expect(refusalCode(wrongState)).toBe("COMPETITION_ACCESS_DENIED");
  });

  it("an unknown competition is refused as not found", async () => {
    await expectRejects(compRepo.publishScheduledCompetition(randomUUID(), ctx.organizer.gamingMemberId, ctx.digest), CompetitionNotFoundError);
  });

  it("the operation is the same for the competition's real organizer: the organizer's own call goes through the very same checks and publishes (positive control)", async () => {
    const outcome = await publishInTransaction(other, other.digest);
    expect(outcome.ok, outcome.ok ? "" : outcome.message).toBe(true);
  });
});

describe("[4] a REVOKED host organizer cannot publish — and cannot even replay their own earlier publication", () => {
  it("a host revoked after proposing is refused, and nothing is written", async () => {
    const { ctx, pilot } = await proposedPilot("Revoked Before");
    await pilot.revoke();
    const before = await snapshot(ctx.competitionId);
    await expectRejects(publish(ctx, ctx.digest), HostAccessRevokedError);
    expect(changedParts(before, await snapshot(ctx.competitionId))).toEqual(NOTHING_CHANGED);
    expect(await fixtureCount(ctx.competitionId)).toBe(0);
    expect((await stateOf(ctx.competitionId)).state).toBe("READY_TO_PUBLISH");
  }, 360000);

  it("a host who published and is then revoked is refused on the exact replay of their own publication — authorization and revocation are checked before the replay", async () => {
    const { ctx, pilot } = await proposedPilot("Revoked After");
    const first = await publish(ctx, ctx.digest);
    expect(first.alreadyPublished).toBe(false);
    await pilot.revoke();
    const before = await snapshot(ctx.competitionId);
    await expectRejects(publish(ctx, ctx.digest), HostAccessRevokedError);
    expect(changedParts(before, await snapshot(ctx.competitionId))).toEqual(NOTHING_CHANGED);
    expect(await fixtureCount(ctx.competitionId)).toBe(3);
  }, 360000);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// [1] the request at the database
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("[1] the operation takes exactly the competition, the verified caller and one digest of 64 lowercase hexadecimal digits", () => {
  it("a malformed digest is refused as invalid AFTER the caller is judged: uppercase, short, long, padded, non-hex, empty and NULL — and nothing is written", async () => {
    const ctx = await proposed("Digest Shape");
    const before = await snapshot(ctx.competitionId);
    for (const bad of [ctx.digest.toUpperCase(), ctx.digest.slice(1), `${ctx.digest}0`, ` ${ctx.digest}`, `${ctx.digest}\n`, "g".repeat(64), "", "x", null]) {
      const outcome = await publishInTransaction(ctx, bad as never);
      expect(refusalCode(outcome), String(bad)).toBe("DIGEST_INVALID");
    }
    expect(changedParts(before, await snapshot(ctx.competitionId))).toEqual(NOTHING_CHANGED);
  }, 240000);

  it("the operation's signature offers no way to name a team, a pairing, a time, a pitch, a venue, a zone, a duration, a capacity, a format, a draw, a plan revision or an actor beyond the caller", async () => {
    const [op] = await rawQuery("select pg_get_function_arguments(p.oid) as args from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1", [RPC]);
    expect(op.args).toBe("p_competition_id uuid, p_organizer_gaming_member_id uuid, p_schedule_proposal_digest text");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// [5] [6] the lifecycle, in the gate's order
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("[5] a proposal can be published only from READY_TO_PUBLISH, with a consistent freeze, the one permanent draw (whose evidence reproduces), the current accepted plan and no fixture", () => {
  let ctx: PCtx;
  const id = () => `'${ctx.competitionId}'`;
  beforeAll(async () => { ctx = await proposed("Lifecycle"); }, 240000);

  it("the wrong state is refused for any state but READY_TO_PUBLISH, for a competition already carrying a published instant and for one that already has a fixture", async () => {
    for (const [name, statement] of [
      ["a draft", `update competitions set state = 'DRAFT' where competition_id = ${id()}`],
      ["registration open", `update competitions set state = 'TEAM_REGISTRATION_OPEN' where competition_id = ${id()}`],
      ["published by another way", `update competitions set state = 'PUBLISHED', published_at = now() where competition_id = ${id()}`],
      ["cancelled", `update competitions set state = 'CANCELLED_WITHOUT_CHAMPION' where competition_id = ${id()}`],
      ["complete", `update competitions set state = 'COMPLETE' where competition_id = ${id()}`],
      ["a published instant already set", `update competitions set published_at = now() where competition_id = ${id()}`],
      ["a fixture already present", `insert into competition_fixtures (competition_id, fixture_role, scheduled_at, state) values (${id()}, 'SEMIFINAL_1', now() + interval '1 day', 'SCHEDULED')`],
    ] as const) {
      expect(refusalCode(await publishInTransaction(ctx, ctx.digest, { statements: [statement] })), name).toBe("WRONG_STATE");
    }
    expect(await fixtureCount(ctx.competitionId)).toBe(0);
  });

  it("no freeze: a READY_TO_PUBLISH competition without a freeze (a state no public path reaches) refuses with FREEZE_REQUIRED", async () => {
    const outcome = await publishInTransaction(ctx, ctx.digest, { statements: [
      `delete from competition_registration_freeze_members where competition_id = ${id()}`,
      `delete from competition_registration_freeze_teams where competition_id = ${id()}`,
      `delete from competition_registration_freezes where competition_id = ${id()}`,
    ] });
    expect(refusalCode(outcome)).toBe("FREEZE_REQUIRED");
  });

  it("no accepted plan: a frozen, drawn competition whose plan revisions are gone refuses with PLAN_REQUIRED", async () => {
    const outcome = await publishInTransaction(ctx, ctx.digest, { statements: [`delete from competition_planning_revisions where competition_id = ${id()}`] });
    expect(refusalCode(outcome)).toBe("PLAN_REQUIRED");
  });

  it("the freeze is judged: a freeze that no longer matches the plan or the teams refuses with FREEZE_INCONSISTENT", async () => {
    expect(refusalCode(await publishInTransaction(ctx, ctx.digest, { statements: [`update competition_registration_freezes set roster_minimum = roster_minimum + 1 where competition_id = ${id()}`] }))).toBe("FREEZE_INCONSISTENT");
    expect(refusalCode(await publishInTransaction(ctx, ctx.digest, { statements: [`update competition_teams set status = 'REJECTED' where competition_team_id = (select competition_team_id from competition_teams where competition_id = ${id()} limit 1)`] }))).toBe("FREEZE_INCONSISTENT");
  });

  it("no draw: a frozen competition whose draw is gone refuses with DRAW_REQUIRED", async () => {
    const outcome = await publishInTransaction(ctx, ctx.digest, { statements: [`delete from competition_draw_entries where competition_id = ${id()}`, `delete from competition_draws where competition_id = ${id()}`] });
    expect(refusalCode(outcome)).toBe("DRAW_REQUIRED");
  });

  it("a draw whose evidence no longer reproduces itself cannot be built on: DRAW_NOT_VERIFIABLE, and nothing is written", async () => {
    const outcome = await publishInTransaction(ctx, ctx.digest, { statements: [`update competition_draws set draw_digest = '${sha("not the draw")}' where competition_id = ${id()}`] });
    expect(refusalCode(outcome)).toBe("DRAW_NOT_VERIFIABLE");
  });

  it("no proposal at all: a frozen, drawn competition with no proposal refuses any digest as PROPOSAL_NOT_FOUND", async () => {
    const drawn = await drawnOn("No Proposal", liveSpec(2));
    const before = await snapshot(drawn.competitionId);
    await expectRefusal(publish(drawn, sha("nothing")), "PROPOSAL_NOT_FOUND");
    expect(changedParts(before, await snapshot(drawn.competitionId))).toEqual(NOTHING_CHANGED);
  }, 240000);

  it("the wrong state is judged before the freeze, the freeze before the draw, the draw before a pending plan change: each refusal is the first one in the gate's order", async () => {
    expect(refusalCode(await publishInTransaction(ctx, ctx.digest, { statements: [
      `update competitions set state = 'DRAFT' where competition_id = ${id()}`, `delete from competition_draw_entries where competition_id = ${id()}`, `delete from competition_draws where competition_id = ${id()}`,
    ] }))).toBe("WRONG_STATE");
    expect(refusalCode(await publishInTransaction(ctx, ctx.digest, { statements: [
      `delete from competition_registration_freeze_members where competition_id = ${id()}`, `delete from competition_registration_freeze_teams where competition_id = ${id()}`,
      `delete from competition_registration_freezes where competition_id = ${id()}`, `delete from competition_draw_entries where competition_id = ${id()}`, `delete from competition_draws where competition_id = ${id()}`,
    ] }))).toBe("FREEZE_REQUIRED");
  });
});

describe("[6] a plan change awaiting the captains refuses the publication; once it is no longer pending the same proposal publishes", () => {
  it("a PENDING plan change refuses with AMENDMENT_PENDING and nothing is written; a withdrawn one does not block", async () => {
    const ctx = await proposed("Pending Change");
    const change = await proposeChange(ctx);
    const before = await snapshot(ctx.competitionId);
    await expectRefusal(publish(ctx, ctx.digest), "AMENDMENT_PENDING");
    expect(changedParts(before, await snapshot(ctx.competitionId))).toEqual(NOTHING_CHANGED);
    await withdrawChange(ctx, change.digest);
    const published = await publish(ctx, ctx.digest);
    expect(published.alreadyPublished).toBe(false);
    expect(await fixtureCount(ctx.competitionId)).toBe(3);
  }, 360000);

  it("the draw's evidence is judged BEFORE a pending plan change: a corrupted draw beside a pending change is a DRAW_NOT_VERIFIABLE, not an AMENDMENT_PENDING", async () => {
    const ctx = await proposed("Pending And Draw");
    await proposeChange(ctx);
    const outcome = await publishInTransaction(ctx, ctx.digest, { statements: [`update competition_draws set draw_digest = '${sha("corrupt")}' where competition_id = '${ctx.competitionId}'`] });
    expect(refusalCode(outcome)).toBe("DRAW_NOT_VERIFIABLE");
  }, 360000);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// [7] .. [12] which proposal
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("[7][11] only the exact LATEST proposal can be published: a superseded or non-latest one is refused and the latest still publishes", () => {
  it("version 1 of 2 is refused as superseded; version 2 publishes", async () => {
    const ctx = await proposed("Superseded");
    const second = await propose(ctx, SEQUENTIAL(ctx));
    const before = await snapshot(ctx.competitionId);
    await expectRefusal(publish(ctx, ctx.digest), "PROPOSAL_SUPERSEDED");
    expect(changedParts(before, await snapshot(ctx.competitionId))).toEqual(NOTHING_CHANGED);
    const published = await publish(ctx, second.proposal.proposalDigest);
    expect(published.publication.scheduleProposalSequence).toBe(2);
    expect(published.publication.scheduleProposalDigest).toBe(second.proposal.proposalDigest);
  }, 360000);

  it("with three versions the middle and the first are refused as non-latest; only the third publishes", async () => {
    const ctx = await proposed("Non Latest");
    const second = await propose(ctx, SEQUENTIAL(ctx));
    const third = await propose(ctx, req(ctx, "B 1 09:00", "A 1 09:00", "B 1 10:08"));
    for (const digest of [ctx.digest, second.proposal.proposalDigest]) await expectRefusal(publish(ctx, digest), "PROPOSAL_SUPERSEDED");
    expect(await fixtureCount(ctx.competitionId)).toBe(0);
    const published = await publish(ctx, third.proposal.proposalDigest);
    expect(published.publication.scheduleProposalSequence).toBe(3);
  }, 360000);
});

describe("[8] a proposal made on a plan that is no longer the current accepted plan is stale and cannot be published; a new proposal on the new plan can", () => {
  it("a plan change activated after the proposal makes it STALE; a proposal on the new revision supersedes it and publishes", async () => {
    const ctx = await proposed("Stale Plan");
    await activateChange(ctx);
    const read = await compRepo.getScheduleProposals(ctx.competitionId, ctx.organizer.gamingMemberId);
    expect(read?.proposal?.status).toBe("STALE");
    const before = await snapshot(ctx.competitionId);
    await expectRefusal(publish(ctx, ctx.digest), "PROPOSAL_STALE");
    expect(changedParts(before, await snapshot(ctx.competitionId))).toEqual(NOTHING_CHANGED);
    const renewed = { ...ctx, ...(await pitchIds(ctx.competitionId)) };
    const fresh = await propose(renewed, req(renewed, "A 1 09:00", "B 1 09:00", "A 1 10:08"));
    const published = await publish(ctx, fresh.proposal.proposalDigest);
    expect(published.alreadyPublished).toBe(false);
    expect(published.publication.planningRevisionId).toBe(renewed.revisionId);
    await expectRefusal(publish(ctx, ctx.digest), "PUBLICATION_CONFLICT"); // after publication the stale one is simply not what was published
  }, 480000);
});

describe("[9] a draw that no longer matches the proposal's is refused", () => {
  let ctx: PCtx;
  beforeAll(async () => { ctx = await proposed("Draw Digest"); }, 240000);

  it("a proposal that records a different draw digest than the draw's is STALE and refused (the draw itself still reproduces)", async () => {
    const outcome = await publishInTransaction(ctx, ctx.digest, { statements: [`update competition_schedule_proposals set draw_digest = '${sha("another draw")}' where competition_id = '${ctx.competitionId}'`] });
    expect(refusalCode(outcome)).toBe("PROPOSAL_STALE");
  });

  it("a draw whose own digest no longer matches its evidence is refused before the proposal is even considered", async () => {
    const outcome = await publishInTransaction(ctx, ctx.digest, { statements: [`update competition_draws set draw_digest = '${sha("another draw digest")}' where competition_id = '${ctx.competitionId}'`] });
    expect(refusalCode(outcome)).toBe("DRAW_NOT_VERIFIABLE");
  });
});

describe("[10] the proposal's digest is the proposal: a digest that names no proposal, or a proposal whose evidence does not reproduce, is refused", () => {
  let ctx: PCtx;
  beforeAll(async () => { ctx = await proposed("Proposal Digest"); }, 240000);

  it("a changed digest — one digit different — names no proposal of this competition: PROPOSAL_NOT_FOUND", async () => {
    const changed = `${ctx.digest.slice(0, 63)}${ctx.digest[63] === "0" ? "1" : "0"}`;
    expect(refusalCode(await publishInTransaction(ctx, changed))).toBe("PROPOSAL_NOT_FOUND");
    await expectRefusal(publish(ctx, changed), "PROPOSAL_NOT_FOUND");
  });

  it("a stored proposal whose evidence was altered is found by its digest but does not reproduce: PROPOSAL_NOT_VERIFIABLE", async () => {
    const outcome = await publishInTransaction(ctx, ctx.digest, { statements: [`update competition_schedule_proposals set occupancy_minutes = occupancy_minutes + 1 where competition_id = '${ctx.competitionId}'`] });
    expect(refusalCode(outcome)).toBe("PROPOSAL_NOT_VERIFIABLE");
  });

  it("a stored proposal whose own digest was altered: the old digest no longer names it, and the new one names a proposal that does not reproduce", async () => {
    const forged = sha("a forged proposal digest");
    const statements = [`update competition_schedule_proposals set proposal_digest = '${forged}' where competition_id = '${ctx.competitionId}'`];
    expect(refusalCode(await publishInTransaction(ctx, ctx.digest, { statements }))).toBe("PROPOSAL_NOT_FOUND");
    expect(refusalCode(await publishInTransaction(ctx, forged, { statements }))).toBe("PROPOSAL_NOT_VERIFIABLE");
  });
});

describe("[12] a proposal of ANOTHER competition is not a proposal of this one", () => {
  it("another competition's digest is PROPOSAL_NOT_FOUND here; its organizer is access denied here; and each still publishes its own", async () => {
    const a = await proposed("Cross A");
    const b = await proposed("Cross B");
    await expectRefusal(publish(a, b.digest), "PROPOSAL_NOT_FOUND");
    await expectRefusal(publish(b, a.digest), "PROPOSAL_NOT_FOUND");
    await expectRejects(publish(a, b.digest, b.organizer.gamingMemberId), CompetitionAccessDeniedError);
    expect(await fixtureCount(a.competitionId) + (await fixtureCount(b.competitionId))).toBe(0);
    expect((await publish(a, a.digest)).alreadyPublished).toBe(false);
    expect((await publish(b, b.digest)).alreadyPublished).toBe(false);
  }, 480000);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// [13] [14] the rules, judged again at the publication instant
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("[13] every scheduling rule is judged again at publication, on the stored proposal, by the very same evaluator", () => {
  let ctx: PCtx;
  beforeAll(async () => { ctx = await proposed("Revalidation"); }, 240000);

  it("the operation reproduces the proposal's evidence and re-evaluates its three placements with the publication instant (static facts of the live function)", async () => {
    const [fn] = await rawQuery("select p.prosrc from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1", [RPC]);
    expect(fn.prosrc).toMatch(/competition_schedule_proposal_verify\(/);
    expect(fn.prosrc).toMatch(/competition_schedule_evaluate\(p_competition_id, v_proposal\.planning_revision_id, v_proposal\.format_key, v_requested, v_now\)/);
  });

  it("a plan that moved under the proposal is refused whichever rule it breaks: capacity, an unusable pitch, a pitch that no longer takes the format, a window that shrank", async () => {
    const id = `'${ctx.competitionId}'`;
    const revision = `(select planning_revision_id from competition_planning_revisions where competition_id = ${id} order by revision_number desc limit 1)`;
    const pitchB = `(select planning_pitch_id from competition_planning_pitches where planning_revision_id = ${revision} and label = 'B')`;
    for (const [name, statement] of [
      ["capacity lowered to one", `update competition_planning_revisions set simultaneous_match_capacity = 1 where planning_revision_id = ${revision}`],
      ["a pitch made unusable", `update competition_planning_pitches set is_usable = false where planning_pitch_id = ${pitchB}`],
      ["a pitch that no longer takes the format", `delete from competition_planning_pitch_formats where planning_pitch_id = ${pitchB} and format_key = 'SOCCER_5V5'`],
      ["a window that shrank", `update competition_planning_windows set end_time = '09:30' where planning_revision_id = ${revision} and window_index = 1 and plan_date = (select plan_date from competition_planning_dates where planning_revision_id = ${revision} order by position limit 1)`],
    ] as const) {
      const outcome = await publishInTransaction(ctx, ctx.digest, { statements: [statement] });
      expect(["PROPOSAL_NOT_VERIFIABLE", "OUTSIDE_WINDOW", "PITCH_NOT_USABLE", "PITCH_FORMAT_UNSUPPORTED", "CAPACITY_EXCEEDED"], `${name}: ${refusalCode(outcome)}`).toContain(refusalCode(outcome));
      expect(outcome.ok, name).toBe(false);
    }
  });
});

describe("[14] all three kickoffs must be strictly in the future at the accepted database clock; one at or before it is refused", () => {
  let ctx: PCtx;
  let starts: Record<Role, string>;
  beforeAll(async () => { ctx = await proposed("Clock"); starts = await placementStarts(ctx.digest); }, 240000);
  const at = (ms: number, iso: string) => new Date(Date.parse(iso) + ms).toISOString();

  it("a clock one millisecond before the first kickoff publishes (rolled back, with the commit-time verification forced): the strict future is exact", async () => {
    const outcome = await publishInTransaction(ctx, ctx.digest, { instant: at(-1, starts.SEMIFINAL_1) });
    expect(outcome.ok, outcome.ok ? "" : outcome.message).toBe(true);
  });

  it("a clock exactly ON the first kickoff is refused as not publishable, with the rule START_NOT_FUTURE", async () => {
    const outcome = await publishInTransaction(ctx, ctx.digest, { instant: starts.SEMIFINAL_1 });
    expect(refusalCode(outcome)).toBe("START_NOT_FUTURE");
    expect((outcome as { message: string }).message).toMatch(/SCHEDULE_PUBLICATION_NOT_PUBLISHABLE/);
  });

  it("a clock on or after the second kickoff or the final is refused the same way — the first kickoff has passed too", async () => {
    for (const role of ["SEMIFINAL_2", "FINAL"] as const) {
      expect(refusalCode(await publishInTransaction(ctx, ctx.digest, { instant: starts[role] })), role).toBe("START_NOT_FUTURE");
      expect(refusalCode(await publishInTransaction(ctx, ctx.digest, { instant: at(60_000, starts[role]) })), `${role} + 1 minute`).toBe("START_NOT_FUTURE");
    }
  });

  it("through the repository, a proposal whose stored kickoffs were moved into the past (service-side, row triggers off) no longer reproduces and is refused — and nothing is written", async () => {
    const ctx2 = await proposed("Clock Real");
    const db = new Client({ connectionString: supabaseDbUrl, statement_timeout: 60000 });
    await db.connect();
    try {
      await db.query("set session_replication_role = replica");
      await db.query("update competition_schedule_proposal_placements set starts_at = starts_at - interval '30 days', occupancy_ends_at = occupancy_ends_at - interval '30 days', window_starts_at = window_starts_at - interval '30 days', window_ends_at = window_ends_at - interval '30 days' where competition_id = $1", [ctx2.competitionId]);
    } finally { await db.end().catch(() => {}); }
    const before = await snapshot(ctx2.competitionId);
    await expectRefusal(publish(ctx2, ctx2.digest), "PROPOSAL_NOT_VERIFIABLE");
    expect(await fixtureCount(ctx2.competitionId)).toBe(0);
    expect(changedParts(before, await snapshot(ctx2.competitionId))).toEqual(NOTHING_CHANGED);
  }, 360000);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// [15] .. [17] what a publication creates
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("[15][16][17] a publication creates exactly three fixtures from the draw's positions and the proposal's instants, records one resolution and publishes the competition at that very instant", () => {
  let ctx: PCtx;
  let before: Record<string, string>;
  let result: Awaited<ReturnType<typeof publish>>;
  let competitionBefore: Record<string, any>;
  beforeAll(async () => {
    ctx = await proposed("Creates");
    before = await snapshot(ctx.competitionId);
    competitionBefore = (await rawQuery("select * from competitions where competition_id = $1", [ctx.competitionId]))[0];
    result = await publish(ctx, ctx.digest);
  }, 360000);

  it("[15] the semifinals have the teams of draw positions one and two, and three and four — as team A and team B — and no other pairing", async () => {
    const order = await drawOrder(ctx.competitionId);
    expect(order).toHaveLength(4);
    const f = await fixturesOf(ctx.competitionId);
    expect([f.SEMIFINAL_1.a, f.SEMIFINAL_1.b]).toEqual([order[0], order[1]]);
    expect([f.SEMIFINAL_2.a, f.SEMIFINAL_2.b]).toEqual([order[2], order[3]]);
    expect(result.publication.fixtures.slice(0, 2).map((x) => [x.teamAId, x.teamBId])).toEqual([[order[0], order[1]], [order[2], order[3]]]);
  });

  it("[15] across several competitions the pairing follows the draw every time (and the draw's order, not the freeze's, is what is used)", async () => {
    const samples: PCtx[] = [ctx];
    for (const label of ["Pairing B", "Pairing C", "Pairing D"]) samples.push(await proposed(label));
    const differs: boolean[] = [];
    for (const sample of samples) {
      if (sample !== ctx) await publish(sample, sample.digest);
      const order = await drawOrder(sample.competitionId);
      const f = await fixturesOf(sample.competitionId);
      expect([f.SEMIFINAL_1.a, f.SEMIFINAL_1.b, f.SEMIFINAL_2.a, f.SEMIFINAL_2.b]).toEqual(order);
      const frozen = (await rawQuery("select competition_team_id from competition_registration_freeze_teams where competition_id = $1 order by position", [sample.competitionId])).map((r) => r.competition_team_id as string);
      differs.push(JSON.stringify(frozen) !== JSON.stringify(order));
    }
    expect(differs.some(Boolean), "at least one of four independent draws is not the frozen order (1 in 24^4 otherwise)").toBe(true);
  }, 900000);

  it("[16] the final's team slots are unresolved and both its source links point at the two semifinals, in order", async () => {
    const f = await fixturesOf(ctx.competitionId);
    expect(f.FINAL.a).toBeNull();
    expect(f.FINAL.b).toBeNull();
    expect(f.FINAL.sa).toBe(f.SEMIFINAL_1.id);
    expect(f.FINAL.sb).toBe(f.SEMIFINAL_2.id);
    expect(f.SEMIFINAL_1.sa).toBeNull();
    expect(f.SEMIFINAL_1.sb).toBeNull();
    expect(f.SEMIFINAL_2.sa).toBeNull();
    expect(f.SEMIFINAL_2.sb).toBeNull();
  });

  it("[17] exactly three fixtures, each SCHEDULED with no scorekeeper, at the proposal's UTC starts", async () => {
    expect(await fixtureCount(ctx.competitionId)).toBe(3);
    const f = await fixturesOf(ctx.competitionId);
    const starts = await placementStarts(ctx.digest);
    for (const role of ROLES) {
      expect(f[role].state, role).toBe("SCHEDULED");
      expect(f[role].sk, role).toBeNull();
      expect(f[role].starts, role).toBe(starts[role]);
    }
    expect(new Set(ROLES.map((r) => f[r].id)).size).toBe(3);
  });

  it("[17] one resolution, and the competition is PUBLISHED at exactly the resolution's database instant", async () => {
    const rows = await publicationRows(ctx.competitionId);
    expect(rows).toHaveLength(1);
    const state = await stateOf(ctx.competitionId);
    expect(state.state).toBe("PUBLISHED");
    expect(state.published_stamp).toBe(result.publication.publishedAt);
    expect(rows[0].published_at.toISOString()).toBe(state.published_at!.toISOString());
    const f = await fixturesOf(ctx.competitionId);
    expect([rows[0].semifinal_1_fixture_id, rows[0].semifinal_2_fixture_id, rows[0].final_fixture_id]).toEqual([f.SEMIFINAL_1.id, f.SEMIFINAL_2.id, f.FINAL.id]);
    expect(rows[0].published_by_gaming_member_id).toBe(ctx.organizer.gamingMemberId);
    expect(rows[0].schedule_proposal_digest).toBe(ctx.digest);
    expect(rows[0].schedule_proposal_sequence).toBe(ctx.sequence);
    expect(rows[0].planning_revision_id).toBe(ctx.revisionId);
    expect(rows[0].draw_digest).toBe((await rawQuery("select draw_digest from competition_draws where competition_id = $1", [ctx.competitionId]))[0].draw_digest);
  });

  it("[17] the returned evidence is the resolution: the three fixture identifiers, the proposal and the digest the application recomputes", async () => {
    const { verifySchedulePublication } = await loadPub();
    expect(verifySchedulePublication(ctx.competitionId, result.publication)).toEqual({ ok: true });
    const f = await fixturesOf(ctx.competitionId);
    expect(result.publication.fixtures.map((x) => x.competitionFixtureId)).toEqual(ROLES.map((r) => f[r].id));
    expect(result.alreadyPublished).toBe(false);
    expect(result.competitionId).toBe(ctx.competitionId);
  });

  it("[17] one state transition and nothing else: only the competition (its state and published instant), its fixtures and its resolution changed", async () => {
    expect(changedParts(before, await snapshot(ctx.competitionId))).toEqual(["competition", "fixtures", "publications"]);
    const after = (await rawQuery("select * from competitions where competition_id = $1", [ctx.competitionId]))[0];
    const differing = Object.keys(after).filter((k) => JSON.stringify(after[k]) !== JSON.stringify(competitionBefore[k])).sort();
    expect(differing).toEqual(["published_at", "state"]);
  });

  it("the proposal is untouched and still reads as the latest, with its plan and draw unchanged", async () => {
    const read = await compRepo.getScheduleProposals(ctx.competitionId, ctx.organizer.gamingMemberId);
    expect(read?.proposal?.proposalDigest).toBe(ctx.digest);
    expect(read?.proposal?.planningRevisionCurrent).toBe(true);
    expect(read?.proposal?.drawDigestMatches).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// [18] [19] replay and conflict
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("[18][19] an exact replay by the still-authorized organizer returns the existing publication and writes nothing; every conflicting call fails closed", () => {
  let ctx: PCtx;
  let other: PCtx;
  let first: Awaited<ReturnType<typeof publish>>;
  let second: Awaited<ReturnType<typeof propose>>;
  beforeAll(async () => {
    ctx = await proposed("Replay");
    second = await propose(ctx, SEQUENTIAL(ctx));
    other = await proposed("Replay Other");
    first = await publish(ctx, second.proposal.proposalDigest);
  }, 480000);

  it("[18] the replay returns IDENTICAL evidence and the same fixture identifiers, flagged as a replay, and every row of the competition is byte-identical afterwards", async () => {
    const before = await snapshot(ctx.competitionId);
    const again = await publish(ctx, second.proposal.proposalDigest);
    expect(again.alreadyPublished).toBe(true);
    expect(again.publication).toEqual(first.publication);
    expect(changedParts(before, await snapshot(ctx.competitionId))).toEqual(NOTHING_CHANGED);
    expect(await fixtureCount(ctx.competitionId)).toBe(3);
    expect(await publicationRows(ctx.competitionId)).toHaveLength(1);
  });

  it("[18] the replay is answered from the record after the competition has moved on (here: completed), for the organizer only", async () => {
    await rawQuery("update competitions set state = 'COMPLETE' where competition_id = $1", [ctx.competitionId]);
    try {
      const again = await publish(ctx, second.proposal.proposalDigest);
      expect(again.alreadyPublished).toBe(true);
      expect(again.publication).toEqual(first.publication);
    } finally {
      await rawQuery("update competitions set state = 'PUBLISHED' where competition_id = $1", [ctx.competitionId]);
    }
  });

  it("[19] another proposal after publication is a PUBLICATION_CONFLICT: a superseded one, and a stale one, are not what was published", async () => {
    await expectRefusal(publish(ctx, ctx.digest), "PUBLICATION_CONFLICT"); // proposal 1, superseded by 2 before publication
  });

  it("[19] a digest that names no proposal of this competition is PROPOSAL_NOT_FOUND even after publication; so is another competition's", async () => {
    await expectRefusal(publish(ctx, sha("nothing at all")), "PROPOSAL_NOT_FOUND");
    await expectRefusal(publish(ctx, other.digest), "PROPOSAL_NOT_FOUND");
  });

  it("[19] a replay by anyone else is access denied — a captain, a player, another competition's organizer, a stranger, an appointed scorekeeper, nobody", async () => {
    const f = await fixturesOf(ctx.competitionId);
    const scorekeeper = await newPerson("Replay Scorekeeper");
    await appointScorekeeper(compRepo, f.SEMIFINAL_1.id, ctx.organizer.gamingMemberId, scorekeeper.gamingMemberId);
    const stranger = await newPerson("Replay Stranger");
    for (const id of [ctx.teams[1].captain.gamingMemberId, ctx.teams[1].members[0], other.organizer.gamingMemberId, stranger.gamingMemberId, scorekeeper.gamingMemberId, randomUUID()]) {
      await expectRejects(publish(ctx, second.proposal.proposalDigest, id), CompetitionAccessDeniedError);
    }
    await expectRejects(compRepo.publishScheduledCompetition(ctx.competitionId, null as never, second.proposal.proposalDigest), CompetitionAccessDeniedError);
  });

  it("[19] none of the refusals changed anything", async () => {
    const before = await snapshot(ctx.competitionId);
    await publish(ctx, ctx.digest).catch(() => {});
    await publish(ctx, sha("zzz")).catch(() => {});
    expect(changedParts(before, await snapshot(ctx.competitionId))).toEqual(NOTHING_CHANGED);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// [20] concurrency
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("[20] concurrent publications leave exactly one resolution, three fixtures, one state transition and identical successful results", () => {
  it("eight simultaneous calls with the same digest: exactly one creates, seven replay, all return the same evidence", async () => {
    const ctx = await proposed("Race Same");
    const results = await Promise.all(Array.from({ length: 8 }, () => publish(ctx, ctx.digest)));
    expect(results.filter((r) => !r.alreadyPublished)).toHaveLength(1);
    expect(results.filter((r) => r.alreadyPublished)).toHaveLength(7);
    for (const r of results) expect(r.publication).toEqual(results[0].publication);
    expect(await publicationRows(ctx.competitionId)).toHaveLength(1);
    expect(await fixtureCount(ctx.competitionId)).toBe(3);
    expect((await stateOf(ctx.competitionId)).published_stamp).toBe(results[0].publication.publishedAt);
  }, 360000);

  it("simultaneous calls naming different proposals: the latest publishes, the others are refused, and there is still exactly one resolution", async () => {
    const ctx = await proposed("Race Different");
    const second = await propose(ctx, SEQUENTIAL(ctx));
    const settled = await Promise.allSettled([
      publish(ctx, ctx.digest), publish(ctx, second.proposal.proposalDigest), publish(ctx, ctx.digest), publish(ctx, second.proposal.proposalDigest),
    ]);
    expect(settled.filter((s) => s.status === "fulfilled").length).toBeGreaterThanOrEqual(1);
    for (const s of settled) {
      if (s.status === "fulfilled") expect(s.value.publication.scheduleProposalDigest).toBe(second.proposal.proposalDigest);
      else expect(["PROPOSAL_SUPERSEDED", "PUBLICATION_CONFLICT"]).toContain((s.reason as { code?: string }).code);
    }
    expect(await publicationRows(ctx.competitionId)).toHaveLength(1);
    expect(await fixtureCount(ctx.competitionId)).toBe(3);
  }, 360000);

  it("a publication racing a new proposal: never both — either the new version supersedes before and the publication is refused, or the publication wins and the new version is refused", async () => {
    const ctx = await proposed("Race Propose");
    const [published, proposedAgain] = await Promise.allSettled([publish(ctx, ctx.digest), propose(ctx, SEQUENTIAL(ctx))]);
    const proposals = (await rawQuery("select count(*)::int n from competition_schedule_proposals where competition_id = $1", [ctx.competitionId]))[0].n as number;
    if (published.status === "fulfilled") {
      expect(proposedAgain.status, "the publication won: the new version must be refused").toBe("rejected");
      expect(proposals).toBe(1);
      expect(await publicationRows(ctx.competitionId)).toHaveLength(1);
    } else {
      expect(proposedAgain.status, "the new version won: the publication must be refused").toBe("fulfilled");
      expect((published.reason as { code?: string }).code).toBe("PROPOSAL_SUPERSEDED");
      expect(proposals).toBe(2);
      expect(await publicationRows(ctx.competitionId)).toHaveLength(0);
      expect(await fixtureCount(ctx.competitionId)).toBe(0);
    }
  }, 360000);

  it("a publication racing the activation of a plan change: refused as stale in one order, and the change refused in the other — never a publication on a plan that is not current", async () => {
    const ctx = await proposed("Race Change");
    const change = await proposeChange(ctx);
    await decideChange(ctx, 0, change.digest, "CONFIRMED");
    await decideChange(ctx, 1, change.digest, "CONFIRMED");
    await decideChange(ctx, 2, change.digest, "CONFIRMED");
    const settled = await Promise.allSettled([decideChange(ctx, 3, change.digest, "CONFIRMED"), publish(ctx, ctx.digest)]);
    const state = await stateOf(ctx.competitionId);
    const revisions = (await rawQuery("select count(*)::int n from competition_planning_revisions where competition_id = $1", [ctx.competitionId]))[0].n as number;
    if (state.state === "PUBLISHED") {
      expect(settled[1].status).toBe("fulfilled");
      expect(await publicationRows(ctx.competitionId)).toHaveLength(1);
      const row = (await publicationRows(ctx.competitionId))[0];
      expect(row.planning_revision_id).toBe(ctx.revisionId);
    } else {
      expect(settled[1].status).toBe("rejected");
      expect(["PROPOSAL_STALE", "AMENDMENT_PENDING"]).toContain(((settled[1] as PromiseRejectedResult).reason as { code?: string }).code);
      expect(await publicationRows(ctx.competitionId)).toHaveLength(0);
    }
    expect(revisions).toBeGreaterThanOrEqual(1);
  }, 480000);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// [21] atomicity
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("[21] every failure point rolls the whole publication back: no fixture, no resolution, no state change survives, and the competition stays publishable", () => {
  it("a failure injected at each write — the first, second and third fixture, the competition's state change, the resolution, and the commit itself — leaves everything exactly as it was", async () => {
    const ctx = await proposed("Atomic");
    const id = ctx.competitionId;
    const before = await snapshot(id);
    const points: Array<[string, string]> = [
      ["first_fixture", `create trigger zz_fail_first_${RUN} before insert on competition_fixtures for each row when (new.competition_id = '${id}' and new.fixture_role = 'SEMIFINAL_1') execute function public.zz_fail_publication_${RUN}('first')`],
      ["second_fixture", `create trigger zz_fail_second_${RUN} before insert on competition_fixtures for each row when (new.competition_id = '${id}' and new.fixture_role = 'SEMIFINAL_2') execute function public.zz_fail_publication_${RUN}('second')`],
      ["third_fixture", `create trigger zz_fail_third_${RUN} before insert on competition_fixtures for each row when (new.competition_id = '${id}' and new.fixture_role = 'FINAL') execute function public.zz_fail_publication_${RUN}('third')`],
      ["resolution", `create trigger zz_fail_resolution_${RUN} before insert on ${TABLE} for each row when (new.competition_id = '${id}') execute function public.zz_fail_publication_${RUN}('resolution')`],
      ["state_change", `create trigger zz_fail_state_${RUN} before update on competitions for each row when (new.competition_id = '${id}' and new.state = 'PUBLISHED') execute function public.zz_fail_publication_${RUN}('state')`],
      ["commit", `create constraint trigger zz_fail_commit_${RUN} after insert on ${TABLE} deferrable initially deferred for each row when (new.competition_id = '${id}') execute function public.zz_fail_publication_${RUN}('commit')`],
    ];
    await rawQuery(SQL_CREATE_FAIL);
    try {
      for (const [name, createTrigger] of points) {
        const triggerName = /create (?:constraint )?trigger (\w+)/.exec(createTrigger)![1];
        const table = name === "state_change" ? "competitions" : name === "resolution" || name === "commit" ? TABLE : "competition_fixtures";
        await rawQuery(createTrigger);
        try {
          let caught: unknown = null;
          try { await publish(ctx, ctx.digest); } catch (err) { caught = err; }
          expect(caught, `${name}: the publication must fail`).not.toBeNull();
          expect(await fixtureCount(id), `${name}: fixtures`).toBe(0);
          expect(await publicationRows(id), `${name}: resolutions`).toHaveLength(0);
          const state = await stateOf(id);
          expect(state.state, `${name}: state`).toBe("READY_TO_PUBLISH");
          expect(state.published_at, `${name}: published instant`).toBeNull();
          expect(changedParts(before, await snapshot(id)), `${name}: every row`).toEqual(NOTHING_CHANGED);
        } finally {
          await rawQuery(`drop trigger if exists ${triggerName} on ${table}`);
        }
      }
    } finally {
      await rawQuery(`drop function if exists public.zz_fail_publication_${RUN}() cascade`);
    }
    // nothing was lost on the way: the very same proposal still publishes
    const published = await publish(ctx, ctx.digest);
    expect(published.alreadyPublished).toBe(false);
    expect(await fixtureCount(id)).toBe(3);
    expect(await publicationRows(id)).toHaveLength(1);
  }, 600000);

  it("a refusal anywhere before the writes leaves nothing: the lifecycle refusals above each changed no row", async () => {
    const ctx = await proposed("Atomic Refusal");
    const before = await snapshot(ctx.competitionId);
    for (const digest of [sha("none"), ctx.digest.toUpperCase()]) await publish(ctx, digest).catch(() => {});
    await publish(ctx, ctx.digest, randomUUID()).catch(() => {});
    expect(changedParts(before, await snapshot(ctx.competitionId))).toEqual(NOTHING_CHANGED);
  }, 240000);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// [22] the resolution is append-only, verified at commit and cannot be forged
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("[22] the resolution is immutable even to the database owner, and its digest agrees across SQL, TypeScript and Python", () => {
  let ctx: PCtx;
  beforeAll(async () => { ctx = await proposed("Immutable"); await publish(ctx, ctx.digest); }, 360000);

  it("UPDATE, DELETE and TRUNCATE of a resolution are all refused", async () => {
    for (const statement of [`update ${TABLE} set published_at = published_at + interval '1 second'`, `delete from ${TABLE}`, `truncate ${TABLE}`]) {
      const violation = await violationOf(async (db) => { await db.query(statement); });
      expect(violation, statement).not.toBeNull();
      expect(violation!.message, statement).toMatch(/SCHEDULE_PUBLICATION_IMMUTABLE|violates foreign key|cannot truncate/);
    }
    const updated = await violationOf(async (db) => { await db.query(`update ${TABLE} set publication_digest = $1 where competition_id = $2`, [sha("x"), ctx.competitionId]); });
    expect(updated!.message).toMatch(/SCHEDULE_PUBLICATION_IMMUTABLE/);
    expect(await publicationRows(ctx.competitionId)).toHaveLength(1);
  });

  it("the database's digest helper gives the independent known answers: SQL, TypeScript and Python hashlib agree", async () => {
    const { computeSchedulePublicationDigest } = await loadPub();
    const fixtures = (starts: [string, string, string]) => JSON.stringify([
      { fixture_role: "SEMIFINAL_1", fixture_id: "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a101", start_utc: starts[0], team_a_id: "b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b101", team_b_id: "b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b202", source_fixture_a_id: null, source_fixture_b_id: null },
      { fixture_role: "SEMIFINAL_2", fixture_id: "a2a2a2a2-a2a2-42a2-82a2-a2a2a2a2a202", start_utc: starts[1], team_a_id: "b3b3b3b3-b3b3-43b3-83b3-b3b3b3b3b303", team_b_id: "b4b4b4b4-b4b4-44b4-84b4-b4b4b4b4b404", source_fixture_a_id: null, source_fixture_b_id: null },
      { fixture_role: "FINAL", fixture_id: "a3a3a3a3-a3a3-43a3-83a3-a3a3a3a3a303", start_utc: starts[2], team_a_id: null, team_b_id: null, source_fixture_a_id: "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a101", source_fixture_b_id: "a2a2a2a2-a2a2-42a2-82a2-a2a2a2a2a202" },
    ]);
    const SQL = "select competition_schedule_publication_digest($1::uuid, $2::int, $3::text, $4::uuid, $5::uuid, $6::text, $7::uuid, $8::timestamptz, $9::jsonb) as d";
    const one = (await rawQuery(SQL, [KAT.competition, 2, KAT.proposalDigest, KAT.revision, KAT.draw, KAT.drawDigest, KAT.organizer, "2026-11-12T15:30:45.123456Z", fixtures(["2026-11-14T15:00:00.000Z", "2026-11-14T15:48:00.000Z", "2026-11-14T16:56:00.000Z"])]))[0].d;
    const two = (await rawQuery(SQL, [KAT.competition, 1, KAT.proposalDigest, KAT.revision, KAT.draw, KAT.drawDigest, KAT.organizer, "2026-11-12T15:30:45.000001Z", fixtures(["2026-11-14T15:00:00.000Z", "2026-11-14T15:00:00.000Z", "2026-11-14T16:08:00.000Z"])]))[0].d;
    expect(one).toBe(KAT.publication1);
    expect(two).toBe(KAT.publication2);
    const ts = (sequence: number, publishedAt: string, starts: [string, string, string]) => computeSchedulePublicationDigest(KAT.competition, {
      scheduleProposalSequence: sequence, scheduleProposalDigest: KAT.proposalDigest, planningRevisionId: KAT.revision, drawId: KAT.draw, drawDigest: KAT.drawDigest, publishedByGamingMemberId: KAT.organizer, publishedAt,
      fixtures: [
        { fixtureRole: "SEMIFINAL_1", competitionFixtureId: "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a101", startsAt: starts[0], teamAId: "b1b1b1b1-b1b1-41b1-81b1-b1b1b1b1b101", teamBId: "b2b2b2b2-b2b2-42b2-82b2-b2b2b2b2b202", sourceFixtureAId: null, sourceFixtureBId: null },
        { fixtureRole: "SEMIFINAL_2", competitionFixtureId: "a2a2a2a2-a2a2-42a2-82a2-a2a2a2a2a202", startsAt: starts[1], teamAId: "b3b3b3b3-b3b3-43b3-83b3-b3b3b3b3b303", teamBId: "b4b4b4b4-b4b4-44b4-84b4-b4b4b4b4b404", sourceFixtureAId: null, sourceFixtureBId: null },
        { fixtureRole: "FINAL", competitionFixtureId: "a3a3a3a3-a3a3-43a3-83a3-a3a3a3a3a303", startsAt: starts[2], teamAId: null, teamBId: null, sourceFixtureAId: "a1a1a1a1-a1a1-41a1-81a1-a1a1a1a1a101", sourceFixtureBId: "a2a2a2a2-a2a2-42a2-82a2-a2a2a2a2a202" },
      ],
    } as never);
    expect(ts(2, "2026-11-12T15:30:45.123456Z", ["2026-11-14T15:00:00.000Z", "2026-11-14T15:48:00.000Z", "2026-11-14T16:56:00.000Z"])).toBe(KAT.publication1);
    expect(ts(1, "2026-11-12T15:30:45.000001Z", ["2026-11-14T15:00:00.000Z", "2026-11-14T15:00:00.000Z", "2026-11-14T16:08:00.000Z"])).toBe(KAT.publication2);
  });

  it("the stored resolution reproduces itself: the database's digest over the stored facts equals the stored digest and the application's", async () => {
    const [row] = await publicationRows(ctx.competitionId);
    const evidence = (await rawQuery("select competition_schedule_publication_evidence($1) as e", [row.schedule_publication_id]))[0].e;
    expect(evidence.publication_digest).toBe(row.publication_digest);
    const { schedulePublicationRecordFromDatabase, verifySchedulePublication } = await loadPub();
    expect(verifySchedulePublication(ctx.competitionId, schedulePublicationRecordFromDatabase(evidence))).toEqual({ ok: true });
  });
});

describe("[22] a forged resolution is refused at commit — for the one thing that is wrong with it — even when written by the database owner", () => {
  let ctx: PCtx;
  let twice: PCtx;
  let secondDigest: string;
  let foreign: PCtx;
  beforeAll(async () => {
    ctx = await proposed("Forge");
    twice = await proposed("Forge Two");
    secondDigest = (await propose(twice, SEQUENTIAL(twice))).proposal.proposalDigest;
    foreign = await proposed("Forge Foreign");
  }, 600000);

  /**
   * Builds, in the caller's rolled-back transaction, what the operation would build — three fixtures, the competition PUBLISHED, one resolution sealed with its own digest — with
   * ONE defect chosen by name. With no defect it is exactly the operation's result, so every refusal below is for the thing it changes and nothing else.
   */
  const FORGE = `
    create function pg_temp.forge(p_competition_id uuid, p_digest text, p_defect text, p_other_revision uuid, p_other_fixture uuid) returns void language plpgsql as $f$
    declare
      v_p competition_schedule_proposals%rowtype; v_d competition_draws%rowtype; v_c competitions%rowtype;
      v_t uuid[]; v_s timestamptz[]; v_now timestamptz := clock_timestamp();
      v_sf1 uuid; v_sf2 uuid; v_fin uuid; v_pub uuid := gen_random_uuid();
      v_a1 uuid; v_b1 uuid; v_a2 uuid; v_b2 uuid; v_fa uuid; v_fb uuid;
      v_actor uuid; v_published timestamptz; v_seq integer; v_pdig text; v_rev uuid; v_ddig text; v_state text := 'SCHEDULED'; v_sk uuid;
      v_row1 uuid; v_row2 uuid; v_rowf uuid; v_digest text; v_json jsonb;
    begin
      select * into v_p from competition_schedule_proposals where competition_id = p_competition_id and proposal_digest = p_digest;
      select * into v_d from competition_draws where competition_id = p_competition_id;
      select * into v_c from competitions where competition_id = p_competition_id;
      select array_agg(e.competition_team_id order by e.draw_position) into v_t from competition_draw_entries e where e.competition_draw_id = v_d.competition_draw_id;
      select array_agg(x.starts_at order by array_position(array['SEMIFINAL_1','SEMIFINAL_2','FINAL'], x.fixture_role)) into v_s from competition_schedule_proposal_placements x where x.schedule_proposal_id = v_p.schedule_proposal_id;
      v_a1 := v_t[1]; v_b1 := v_t[2]; v_a2 := v_t[3]; v_b2 := v_t[4];
      v_actor := v_c.organizer_gaming_member_id; v_published := v_now; v_seq := v_p.sequence_number; v_pdig := v_p.proposal_digest; v_rev := v_p.planning_revision_id; v_ddig := v_d.draw_digest;
      if p_defect = 'swapped_teams' then v_a1 := v_t[2]; v_b1 := v_t[1]; end if;
      if p_defect = 'wrong_pairing' then v_b1 := v_t[3]; v_a2 := v_t[2]; end if;
      if p_defect = 'wrong_start' then v_s[1] := v_s[1] + interval '1 minute'; end if;
      if p_defect = 'wrong_actor' then v_actor := (select t.captain_gaming_member_id from competition_teams t where t.competition_id = p_competition_id limit 1); end if;
      if p_defect = 'wrong_sequence' then v_seq := v_seq + 1; end if;
      if p_defect = 'wrong_proposal_digest' then v_pdig := repeat('a', 64); end if;
      if p_defect = 'wrong_revision' then v_rev := p_other_revision; end if;
      if p_defect = 'wrong_draw_digest' then v_ddig := repeat('b', 64); end if;
      if p_defect = 'scorekeeper_set' then v_sk := v_c.organizer_gaming_member_id; end if;
      if p_defect = 'fixture_state' then v_state := 'ROSTER_DECLARED'; end if;
      insert into competition_fixtures (competition_id, fixture_role, scheduled_at, team_a_competition_team_id, team_b_competition_team_id, state, scorekeeper_gaming_member_id)
        values (p_competition_id, 'SEMIFINAL_1', v_s[1], v_a1, v_b1, v_state, v_sk) returning competition_fixture_id into v_sf1;
      insert into competition_fixtures (competition_id, fixture_role, scheduled_at, team_a_competition_team_id, team_b_competition_team_id, state)
        values (p_competition_id, 'SEMIFINAL_2', v_s[2], v_a2, v_b2, 'SCHEDULED') returning competition_fixture_id into v_sf2;
      v_fa := v_sf1; v_fb := v_sf2;
      if p_defect = 'final_wrong_source' then v_fb := v_sf1; end if;
      if p_defect = 'final_sources_swapped' then v_fa := v_sf2; v_fb := v_sf1; end if;
      if p_defect = 'final_slot_filled' then
        insert into competition_fixtures (competition_id, fixture_role, scheduled_at, team_a_competition_team_id, team_a_source_fixture_id, team_b_source_fixture_id, state)
          values (p_competition_id, 'FINAL', v_s[3], v_a1, v_fa, v_fb, 'SCHEDULED') returning competition_fixture_id into v_fin;
      else
        insert into competition_fixtures (competition_id, fixture_role, scheduled_at, team_a_source_fixture_id, team_b_source_fixture_id, state)
          values (p_competition_id, 'FINAL', v_s[3], v_fa, v_fb, 'SCHEDULED') returning competition_fixture_id into v_fin;
      end if;
      if p_defect <> 'not_published' then
        update competitions set state = 'PUBLISHED', published_at = v_now where competition_id = p_competition_id;
      end if;
      if p_defect = 'wrong_instant' then v_published := v_now + interval '1 microsecond'; end if;
      v_row1 := v_sf1; v_row2 := v_sf2; v_rowf := v_fin;
      if p_defect = 'fixture_ids_swapped' then v_row1 := v_sf2; v_row2 := v_sf1; end if;
      if p_defect = 'foreign_fixture' then v_rowf := p_other_fixture; end if;
      v_json := jsonb_build_array(
        jsonb_build_object('fixture_role', 'SEMIFINAL_1', 'fixture_id', v_row1, 'start_utc', to_char(v_p_start(v_p.schedule_proposal_id, 'SEMIFINAL_1') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'team_a_id', v_t[1], 'team_b_id', v_t[2], 'source_fixture_a_id', null, 'source_fixture_b_id', null),
        jsonb_build_object('fixture_role', 'SEMIFINAL_2', 'fixture_id', v_row2, 'start_utc', to_char(v_p_start(v_p.schedule_proposal_id, 'SEMIFINAL_2') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'team_a_id', v_t[3], 'team_b_id', v_t[4], 'source_fixture_a_id', null, 'source_fixture_b_id', null),
        jsonb_build_object('fixture_role', 'FINAL', 'fixture_id', v_rowf, 'start_utc', to_char(v_p_start(v_p.schedule_proposal_id, 'FINAL') at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
          'team_a_id', null, 'team_b_id', null, 'source_fixture_a_id', v_row1, 'source_fixture_b_id', v_row2));
      v_digest := public.competition_schedule_publication_digest(p_competition_id, v_seq, v_pdig, v_rev, v_d.competition_draw_id, v_ddig, v_actor, v_published, v_json);
      if p_defect = 'bad_digest' then v_digest := repeat('c', 64); end if;
      insert into competition_schedule_publications (schedule_publication_id, competition_id, schedule_proposal_id, schedule_proposal_sequence, schedule_proposal_digest, planning_revision_id,
          competition_draw_id, draw_digest, published_by_gaming_member_id, published_at, semifinal_1_fixture_id, semifinal_2_fixture_id, final_fixture_id, publication_digest)
        values (v_pub, p_competition_id, v_p.schedule_proposal_id, v_seq, v_pdig, v_rev, v_d.competition_draw_id, v_ddig, v_actor, v_published, v_row1, v_row2, v_rowf, v_digest);
    end $f$`;
  // the proposal's own starts, by role, as a tiny helper the forger shares
  const START_HELPER = `create function pg_temp.v_p_start(p_proposal uuid, p_role text) returns timestamptz language sql as $f$ select x.starts_at from competition_schedule_proposal_placements x where x.schedule_proposal_id = p_proposal and x.fixture_role = p_role $f$`;

  const forged = (target: Ctx & { digest?: string }, digest: string, defect: string) => violationOf(async (db) => {
    await db.query(START_HELPER);
    await db.query(FORGE.replace(/v_p_start\(/g, "pg_temp.v_p_start("));
    await db.query("select pg_temp.forge($1, $2, $3, $4, $5)", [target.competitionId, digest, defect, foreign.revisionId, randomUUID()]);
  });
  const code = (violation: DbViolation | null) => (violation ? (/SCHEDULE_PUBLICATION_INVALID: ([A-Z_]+):/.exec(violation.message)?.[1] ?? `OTHER: ${violation.code} ${violation.constraint ?? ""} ${violation.message.slice(0, 120)}`) : "ACCEPTED");

  it("[control] a correctly sealed resolution, written by the owner exactly as the operation writes it, is accepted: so every refusal below is for the thing it changes and nothing else", async () => {
    expect(code(await forged(ctx, ctx.digest, "none"))).toBe("ACCEPTED");
  });

  it("the competition's state and published instant must be the resolution's: a competition not published, and an instant that differs by one microsecond, are refused", async () => {
    expect(code(await forged(ctx, ctx.digest, "not_published"))).toBe("COMPETITION");
    expect(code(await forged(ctx, ctx.digest, "wrong_instant"))).toBe("COMPETITION");
  });

  it("the publisher must be the competition's organizer", async () => {
    expect(code(await forged(ctx, ctx.digest, "wrong_actor"))).toBe("ACTOR");
  });

  it("the proposal must be the competition's own, with its own sequence and digest, and the latest", async () => {
    expect(code(await forged(ctx, ctx.digest, "wrong_sequence"))).toBe("PROPOSAL");
    expect(code(await forged(ctx, ctx.digest, "wrong_proposal_digest"))).toBe("PROPOSAL");
    expect(code(await forged(twice, twice.digest, "none")), "version 1 of 2 is not the latest").toBe("PROPOSAL");
    expect(code(await forged(twice, secondDigest, "none")), "version 2 of 2 is the latest").toBe("ACCEPTED");
  });

  it("the plan revision must be the proposal's and the competition's current one, and the draw's digest the draw's", async () => {
    expect(code(await forged(ctx, ctx.digest, "wrong_revision"))).toBe("PLAN");
    expect(code(await forged(ctx, ctx.digest, "wrong_draw_digest"))).toBe("DRAW");
  });

  it("the fixtures must be exactly the draw's pairing at the proposal's instants, unresolved final slots, the two semifinals as its sources, SCHEDULED and unassigned", async () => {
    for (const defect of ["swapped_teams", "wrong_pairing", "wrong_start", "final_slot_filled", "final_wrong_source", "final_sources_swapped", "fixture_state", "scorekeeper_set", "fixture_ids_swapped"]) {
      expect(code(await forged(ctx, ctx.digest, defect)), defect).toBe("FIXTURES");
    }
  });

  it("the digest must be the digest of everything the resolution carries", async () => {
    expect(code(await forged(ctx, ctx.digest, "bad_digest"))).toBe("DIGEST");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// [24] [25] the manual publication
// ---------------------------------------------------------------------------------------------------------------------------------------------

const manualArgs = (ctx: Ctx) => [ctx.teams[0].teamId, ctx.teams[1].teamId, ctx.teams[2].teamId, ctx.teams[3].teamId, new Date(Date.now() + 3600_000).toISOString(), new Date(Date.now() + 7200_000).toISOString(), new Date(Date.now() + 10800_000).toISOString()] as const;
const manual = (ctx: Ctx, caller: string = ctx.organizer.gamingMemberId) => publishCompetition(compRepo, ctx.competitionId, caller, ...manualArgs(ctx));

describe("[24] the manual publication is refused, in the database, for every competition with a registration freeze, a draw or a schedule proposal — whoever asks and however", () => {
  it("a frozen competition (no draw yet) cannot be published with chosen teams and times", async () => {
    const ctx = await frozenOn("Manual Frozen", liveSpec(2));
    const before = await snapshot(ctx.competitionId);
    await expectRefusal(manual(ctx), "SCHEDULE_PROPOSAL_PUBLICATION_REQUIRED");
    expect(changedParts(before, await snapshot(ctx.competitionId))).toEqual(NOTHING_CHANGED);
    expect(await fixtureCount(ctx.competitionId)).toBe(0);
    expect((await stateOf(ctx.competitionId)).state).toBe("READY_TO_PUBLISH");
  }, 240000);

  it("a drawn competition, and a drawn competition with a CURRENT proposal, cannot either", async () => {
    const drawn = await drawnOn("Manual Drawn", liveSpec(2));
    await expectRefusal(manual(drawn), "SCHEDULE_PROPOSAL_PUBLICATION_REQUIRED");
    const withProposal = await proposed("Manual Proposed");
    const before = await snapshot(withProposal.competitionId);
    await expectRefusal(manual(withProposal), "SCHEDULE_PROPOSAL_PUBLICATION_REQUIRED");
    expect(changedParts(before, await snapshot(withProposal.competitionId))).toEqual(NOTHING_CHANGED);
    // and in the order the pairing would have been chosen: the draw's pairing is not a licence to send it
    const order = await drawOrder(withProposal.competitionId);
    await expectRefusal(publishCompetition(compRepo, withProposal.competitionId, withProposal.organizer.gamingMemberId, order[0], order[1], order[2], order[3],
      new Date(Date.now() + 3600_000).toISOString(), new Date(Date.now() + 7200_000).toISOString(), new Date(Date.now() + 10800_000).toISOString()), "SCHEDULE_PROPOSAL_PUBLICATION_REQUIRED");
    expect(await fixtureCount(withProposal.competitionId)).toBe(0);
  }, 480000);

  it("each of the three markers alone closes the manual path: the freeze, the draw and the proposal (judged one at a time on service-side shapes)", async () => {
    const ctx = await proposed("Manual Markers");
    const id = `'${ctx.competitionId}'`;
    const run = async (statements: string[]) => rawTransaction(async (db) => {
      try {
        await db.query("set session_replication_role = replica");
        for (const s of statements) await db.query(s);
        await db.query("set session_replication_role = origin");
        const rows = (await db.query("select * from publish_competition_atomically($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9::timestamptz)", [ctx.competitionId, ctx.organizer.gamingMemberId, ...manualArgs(ctx)])).rows;
        return { ok: true, rows } as Outcome;
      } catch (err) { return { ok: false, message: (err as Error).message } as Outcome; }
    });
    const removeProposals = [`delete from competition_schedule_proposal_placements where competition_id = ${id}`, `delete from competition_schedule_proposals where competition_id = ${id}`];
    const removeDraw = [`delete from competition_draw_entries where competition_id = ${id}`, `delete from competition_draws where competition_id = ${id}`];
    const removeFreeze = [`delete from competition_registration_freeze_members where competition_id = ${id}`, `delete from competition_registration_freeze_teams where competition_id = ${id}`, `delete from competition_registration_freezes where competition_id = ${id}`];
    expect(refusalCode(await run([...removeDraw.slice(0, 0)])), "all three present").toBe("SCHEDULE_PROPOSAL_PUBLICATION_REQUIRED");
    expect(refusalCode(await run([...removeProposals, ...removeDraw])), "only the freeze left").toBe("SCHEDULE_PROPOSAL_PUBLICATION_REQUIRED");
    expect(refusalCode(await run([...removeProposals, ...removeFreeze])), "only the draw left").toBe("SCHEDULE_PROPOSAL_PUBLICATION_REQUIRED");
    expect(refusalCode(await run([...removeDraw, ...removeFreeze])), "only the proposal left").toBe("SCHEDULE_PROPOSAL_PUBLICATION_REQUIRED");
    const none = await run([...removeProposals, ...removeDraw, ...removeFreeze]);
    expect(none.ok, "with none of the three, the legacy path works: " + (none.ok ? "" : none.message)).toBe(true);
  }, 360000);

  it("the guard comes after the ownership and revocation checks and before the state check: a stranger is access denied, a revoked host is revoked, an organizer is told the code — and a NULL caller is denied", async () => {
    const ctx = await proposed("Manual Order");
    const stranger = await newPerson("Manual Stranger");
    await expectRejects(manual(ctx, stranger.gamingMemberId), CompetitionAccessDeniedError);
    await expectRejects(manual(ctx, ctx.teams[0].captain.gamingMemberId), CompetitionAccessDeniedError);
    await expectRejects(publishCompetition(compRepo, ctx.competitionId, null as never, ...manualArgs(ctx)), CompetitionAccessDeniedError);
    await expectRefusal(manual(ctx), "SCHEDULE_PROPOSAL_PUBLICATION_REQUIRED");
    const { ctx: pilotCtx, pilot } = await proposedPilot("Manual Revoked");
    await pilot.revoke();
    await expectRejects(manual(pilotCtx), HostAccessRevokedError);
    // even a state the legacy path would refuse first is answered by the guard for the organizer: the guard precedes the state check
    const outcome = await rawTransaction(async (db) => {
      try {
        await db.query("update competitions set state = 'DRAFT' where competition_id = $1", [ctx.competitionId]);
        await db.query("select * from publish_competition_atomically($1, $2, $3, $4, $5, $6, $7::timestamptz, $8::timestamptz, $9::timestamptz)", [ctx.competitionId, ctx.organizer.gamingMemberId, ...manualArgs(ctx)]);
        return { ok: true, rows: [] } as Outcome;
      } catch (err) { return { ok: false, message: (err as Error).message } as Outcome; }
    });
    expect(refusalCode(outcome)).toBe("SCHEDULE_PROPOSAL_PUBLICATION_REQUIRED");
  }, 600000);

  it("through the HTTP route, the manual body for such a competition is a 409 with the stable code, and the schedule body is the way; a mixed body is a 400 and touches nothing", async () => {
    const ctx = await proposed("Manual Route");
    const { POST } = await loadPublishRoute();
    const token = await tokenFor(ctx.organizer);
    const [t0, t1, t2, t3, s1, s2, s3] = manualArgs(ctx);
    const legacyBody = { semifinal1TeamAId: t0, semifinal1TeamBId: t1, semifinal2TeamAId: t2, semifinal2TeamBId: t3, semifinal1ScheduledAt: s1, semifinal2ScheduledAt: s2, finalScheduledAt: s3 };
    const refused = await POST(request(`${COMP}/${ctx.competitionId}/publish`, "POST", token, legacyBody), ctxOf(ctx.competitionId));
    expect(refused.status).toBe(409);
    expect((await refused.json()).code).toBe("SCHEDULE_PROPOSAL_PUBLICATION_REQUIRED");
    const mixed = await POST(request(`${COMP}/${ctx.competitionId}/publish`, "POST", token, { ...legacyBody, scheduleProposalDigest: ctx.digest }), ctxOf(ctx.competitionId));
    expect(mixed.status).toBe(400);
    expect(await fixtureCount(ctx.competitionId)).toBe(0);
    expect((await stateOf(ctx.competitionId)).state).toBe("READY_TO_PUBLISH");
  }, 360000);
});

describe("[25] the manual publication is unchanged for a legacy competition outside the schedule journey", () => {
  /** Service-side fixture: the shape of a competition from before the registration freeze existed — READY_TO_PUBLISH reached with no freeze, no draw and no proposal. */
  async function legacyShaped(label: string): Promise<Ctx> {
    const base = await setUp(label);
    await fillRosters(base);
    await rawQuery("update competitions set state = 'READY_TO_PUBLISH' where competition_id = $1 and state = 'TEAM_REGISTRATION_OPEN'", [base.competitionId]);
    return { ...base, ...(await pitchIds(base.competitionId)) };
  }

  it("it publishes exactly as it always did: the chosen pairing and times, three fixtures, the final unresolved, PUBLISHED — and creates no resolution", async () => {
    const ctx = await legacyShaped("Legacy Works");
    const [a, b, c, d, s1, s2, s3] = manualArgs(ctx);
    const before = await snapshot(ctx.competitionId);
    const out = await publishCompetition(compRepo, ctx.competitionId, ctx.organizer.gamingMemberId, a, b, c, d, s1, s2, s3);
    expect(out.state).toBe("PUBLISHED");
    const f = await fixturesOf(ctx.competitionId);
    expect([f.SEMIFINAL_1.a, f.SEMIFINAL_1.b, f.SEMIFINAL_2.a, f.SEMIFINAL_2.b]).toEqual([a, b, c, d]);
    expect([f.SEMIFINAL_1.starts, f.SEMIFINAL_2.starts, f.FINAL.starts]).toEqual([s1, s2, s3].map((s) => new Date(s).toISOString()));
    expect(f.FINAL.sa).toBe(f.SEMIFINAL_1.id);
    expect(f.FINAL.sb).toBe(f.SEMIFINAL_2.id);
    expect([f.FINAL.a, f.FINAL.b]).toEqual([null, null]);
    expect(out.semifinal1FixtureId).toBe(f.SEMIFINAL_1.id);
    expect(await publicationRows(ctx.competitionId)).toHaveLength(0);
    expect(changedParts(before, await snapshot(ctx.competitionId))).toEqual(["competition", "fixtures"]);
  }, 240000);

  it("its refusals are unchanged: a duplicate pairing, a stranger, and a second publication", async () => {
    const ctx = await legacyShaped("Legacy Refusals");
    const [a, , c, d, s1, s2, s3] = manualArgs(ctx);
    const { CompetitionPairingInvalidError, CompetitionNotReadyToPublishError } = await import("../lib/gaming/competitions/types");
    await expectRejects(publishCompetition(compRepo, ctx.competitionId, ctx.organizer.gamingMemberId, a, a, c, d, s1, s2, s3), CompetitionPairingInvalidError);
    const stranger = await newPerson("Legacy Stranger");
    await expectRejects(manual(ctx, stranger.gamingMemberId), CompetitionAccessDeniedError);
    await manual(ctx);
    await expectRejects(manual(ctx), CompetitionNotReadyToPublishError);
    expect(await fixtureCount(ctx.competitionId)).toBe(3);
  }, 240000);

  it("the schedule operation does not publish a legacy competition: there is no proposal to name", async () => {
    const ctx = await legacyShaped("Legacy No Schedule");
    await expectRefusal(publish(ctx, sha("nothing")), "PROPOSAL_NOT_FOUND");
    expect(await fixtureCount(ctx.competitionId)).toBe(0);
  }, 240000);

  it("through the HTTP route the manual body still publishes a legacy competition: 200 { result }", async () => {
    const ctx = await legacyShaped("Legacy Route");
    const { POST } = await loadPublishRoute();
    const [t0, t1, t2, t3, s1, s2, s3] = manualArgs(ctx);
    const res = await POST(request(`${COMP}/${ctx.competitionId}/publish`, "POST", await tokenFor(ctx.organizer), {
      semifinal1TeamAId: t0, semifinal1TeamBId: t1, semifinal2TeamAId: t2, semifinal2TeamBId: t3, semifinal1ScheduledAt: s1, semifinal2ScheduledAt: s2, finalScheduledAt: s3,
    }), ctxOf(ctx.competitionId));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.result.state).toBe("PUBLISHED");
    expect(Object.keys(body)).toEqual(["result"]);
  }, 240000);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The route with real access tokens
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("the route, with real access tokens against the real database", () => {
  let ctx: PCtx;
  beforeAll(async () => { ctx = await proposed("Route"); }, 240000);

  it("[1] POST exactly { scheduleProposalDigest } publishes: 201 with the bounded publication, and the fixture identifiers are the real ones", async () => {
    const { POST } = await loadPublishRoute();
    const res = await POST(request(`${COMP}/${ctx.competitionId}/publish`, "POST", await tokenFor(ctx.organizer), { scheduleProposalDigest: ctx.digest }), ctxOf(ctx.competitionId));
    expect(res.status).toBe(201);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    const body = await res.json();
    const f = await fixturesOf(ctx.competitionId);
    expect(body.result).toEqual({ competitionId: ctx.competitionId, state: "PUBLISHED", publishedAt: expect.any(String), semifinal1FixtureId: f.SEMIFINAL_1.id, semifinal2FixtureId: f.SEMIFINAL_2.id, finalFixtureId: f.FINAL.id });
    expect(body.publication.alreadyPublished).toBe(false);
    expect(body.publication.scheduleProposalDigest).toBe(ctx.digest);
    expect(Object.keys(body.publication).sort()).toEqual(["alreadyPublished", "fixtures", "publicationDigest", "publishedAt", "scheduleProposalDigest"]);
    const text = JSON.stringify(body);
    for (const secret of [ctx.revisionId, ctx.organizer.gamingMemberId, ...(await drawOrder(ctx.competitionId))]) expect(text).not.toContain(secret);
  });

  it("[18] the same call again is a 200 replay with the same body but for the flag; a stranger's token is 403; no token is 401; a mixed or unknown body is 400", async () => {
    const { POST } = await loadPublishRoute();
    const token = await tokenFor(ctx.organizer);
    const replay = await POST(request(`${COMP}/${ctx.competitionId}/publish`, "POST", token, { scheduleProposalDigest: ctx.digest }), ctxOf(ctx.competitionId));
    expect(replay.status).toBe(200);
    expect((await replay.json()).publication.alreadyPublished).toBe(true);
    const stranger = await newPerson("Route Stranger");
    expect((await POST(request(`${COMP}/${ctx.competitionId}/publish`, "POST", await tokenFor(stranger), { scheduleProposalDigest: ctx.digest }), ctxOf(ctx.competitionId))).status).toBe(403);
    expect((await POST(request(`${COMP}/${ctx.competitionId}/publish`, "POST", null, { scheduleProposalDigest: ctx.digest }), ctxOf(ctx.competitionId))).status).toBe(401);
    for (const body of [{ scheduleProposalDigest: ctx.digest, teams: [] }, { scheduleProposalDigest: ctx.digest, semifinal1TeamAId: "x" }, { scheduleProposalDigest: ctx.digest.toUpperCase() }, {}, { whatever: 1 }]) {
      expect((await POST(request(`${COMP}/${ctx.competitionId}/publish`, "POST", token, body), ctxOf(ctx.competitionId))).status, JSON.stringify(body).slice(0, 60)).toBe(400);
    }
    expect(await fixtureCount(ctx.competitionId)).toBe(3);
  });

  it("a conflicting digest after publication is a 409 PUBLICATION_CONFLICT, an unknown one a 404 PROPOSAL_NOT_FOUND, an unknown competition a 404", async () => {
    const { POST } = await loadPublishRoute();
    const token = await tokenFor(ctx.organizer);
    const unknown = await POST(request(`${COMP}/${ctx.competitionId}/publish`, "POST", token, { scheduleProposalDigest: sha("unknown") }), ctxOf(ctx.competitionId));
    expect(unknown.status).toBe(404);
    expect((await unknown.json()).code).toBe("PROPOSAL_NOT_FOUND");
    expect((await POST(request(`${COMP}/${randomUUID()}/publish`, "POST", token, { scheduleProposalDigest: ctx.digest }), ctxOf(randomUUID()))).status).toBe(404);
    expect((await POST(request(`${COMP}/not-a-uuid/publish`, "POST", token, { scheduleProposalDigest: ctx.digest }), ctxOf("not-a-uuid"))).status).toBe(404);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// [26] [27] nothing public is expanded
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("[27] 6v6, 7v7 and 8v8 remain unavailable through every public creation path; the operation takes its format from the competition alone", () => {
  for (const format of ["SOCCER_6V6", "SOCCER_7V7", "SOCCER_8V8"]) {
    it(`${format} cannot be created: the application and the database both refuse it, and no competition is made`, async () => {
      await ensurePool();
      const operator = await makeOperator(`Creation Probe ${format}`);
      await expectRejects(createCompetition(compRepo, operator.gamingMemberId, `Nope ${format} ${RUN}`, format), UnsupportedActivityKeyError);
      const direct = await compRepo.createCompetition(operator.gamingMemberId, `Nope ${format} ${RUN}`, format, `nope-${format.toLowerCase()}-${RUN}`).then(() => "created", (e: unknown) => (e as Error).constructor.name);
      expect(direct).not.toBe("created");
      const { data } = await service.from("competitions").select("activity_key").eq("organizer_gaming_member_id", operator.gamingMemberId);
      expect(data).toEqual([]);
    });
  }

  it("the registry still holds exactly the four formats, and the competition's format is unchanged by a publication", async () => {
    const rows = await rawQuery("select format_key from competition_format_rules order by format_key");
    expect(rows.map((r) => r.format_key)).toEqual(ALL4);
    const ctx = await proposed("Format Unchanged");
    await publish(ctx, ctx.digest);
    expect((await rawQuery("select activity_key from competitions where competition_id = $1", [ctx.competitionId]))[0].activity_key).toBe("SOCCER_5V5");
  }, 360000);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// [28] the existing finalize, forfeit, void and correction propagation, unchanged on the fixtures this operation creates
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("[28] the existing propagation is unchanged on schedule-published fixtures: finalize, shootout, forfeit, void and correction", () => {
  const teamOf = (ctx: Ctx, teamId: string) => ctx.teams.find((t) => t.teamId === teamId)!;
  /** Declares both rosters from the freeze's members, appoints an independent scorekeeper, submits valid evidence and finalizes — the existing operations only. */
  async function play(ctx: Ctx, fixtureId: string, teamAId: string, teamBId: string, a: number, b: number, shootoutWinnerTeamId: string | null, label: string) {
    const teamA = teamOf(ctx, teamAId);
    const teamB = teamOf(ctx, teamBId);
    await declareRoster(compRepo, fixtureId, teamAId, teamA.captain.gamingMemberId, false, null, teamA.members);
    await declareRoster(compRepo, fixtureId, teamBId, teamB.captain.gamingMemberId, false, null, teamB.members);
    const scorekeeper = await newPerson(`${label} Scorekeeper`);
    await appointScorekeeper(compRepo, fixtureId, ctx.organizer.gamingMemberId, scorekeeper.gamingMemberId);
    const attestations: ParticipationAttestationInput[] = [...teamA.members, ...teamB.members].map((gamingMemberId) => ({ gamingMemberId, actuallyParticipated: true }));
    const goals: GoalEventInput[] = [];
    for (let i = 0; i < a; i++) goals.push({ scorerGamingMemberId: teamA.members[i % 5], competitionTeamId: teamAId });
    for (let i = 0; i < b; i++) goals.push({ scorerGamingMemberId: teamB.members[i % 5], competitionTeamId: teamBId });
    const evidence = await submitFixtureEvidence(compRepo, fixtureId, scorekeeper.gamingMemberId, a, b, goals, [], attestations, shootoutWinnerTeamId);
    const finalized = await finalizeFixture(compRepo, fixtureId, ctx.organizer.gamingMemberId);
    return { evidence, finalized, teamA, teamB };
  }

  it("a normal result and a shootout result fill the final's slots in order, and the final completes the competition", async () => {
    const ctx = await proposed("Propagation Journey");
    const published = await publish(ctx, ctx.digest);
    const f = await fixturesOf(ctx.competitionId);
    const sf1 = await play(ctx, f.SEMIFINAL_1.id, f.SEMIFINAL_1.a!, f.SEMIFINAL_1.b!, 2, 1, null, "SF1");
    expect(sf1.finalized.winningCompetitionTeamId).toBe(f.SEMIFINAL_1.a);
    expect((await fixturesOf(ctx.competitionId)).FINAL.a).toBe(f.SEMIFINAL_1.a);
    expect((await fixturesOf(ctx.competitionId)).FINAL.b).toBeNull();
    const sf2 = await play(ctx, f.SEMIFINAL_2.id, f.SEMIFINAL_2.a!, f.SEMIFINAL_2.b!, 1, 1, f.SEMIFINAL_2.b!, "SF2");
    expect(sf2.finalized.winningCompetitionTeamId).toBe(f.SEMIFINAL_2.b);
    const final = (await fixturesOf(ctx.competitionId)).FINAL;
    expect([final.a, final.b]).toEqual([f.SEMIFINAL_1.a, f.SEMIFINAL_2.b]);
    expect(final.sa).toBe(f.SEMIFINAL_1.id);
    expect(final.sb).toBe(f.SEMIFINAL_2.id);
    const decided = await play(ctx, published.publication.fixtures[2].competitionFixtureId, final.a!, final.b!, 3, 1, null, "FINAL");
    expect(decided.finalized.winningCompetitionTeamId).toBe(final.a);
    expect((await stateOf(ctx.competitionId)).state).toBe("COMPLETE");
    expect(await publicationRows(ctx.competitionId)).toHaveLength(1);
  }, 600000);

  it("a winner-changing correction before the final's check-in swaps the finalist atomically; both finalizations survive", async () => {
    const ctx = await proposed("Propagation Correction");
    await publish(ctx, ctx.digest);
    const f = await fixturesOf(ctx.competitionId);
    const sf1 = await play(ctx, f.SEMIFINAL_1.id, f.SEMIFINAL_1.a!, f.SEMIFINAL_1.b!, 1, 0, null, "SF1");
    await play(ctx, f.SEMIFINAL_2.id, f.SEMIFINAL_2.a!, f.SEMIFINAL_2.b!, 1, 0, null, "SF2");
    expect((await fixturesOf(ctx.competitionId)).FINAL.a).toBe(f.SEMIFINAL_1.a);
    const corrected = await correctFixture(compRepo, f.SEMIFINAL_1.id, ctx.organizer.gamingMemberId, "Scorekeeper mis-recorded the winner.", 0, 1,
      [{ scorerGamingMemberId: sf1.teamB.members[0], competitionTeamId: f.SEMIFINAL_1.b! }], [], null);
    expect(corrected.cascadeOutcome).toBe("FINALIST_REPLACED_BEFORE_CHECKIN");
    expect(corrected.newWinningCompetitionTeamId).toBe(f.SEMIFINAL_1.b);
    const after = (await fixturesOf(ctx.competitionId)).FINAL;
    expect(after.a).toBe(f.SEMIFINAL_1.b);
    expect(after.state).toBe("SCHEDULED");
    expect((await rawQuery("select count(*)::int n from competition_fixture_finalizations where competition_fixture_id = $1", [f.SEMIFINAL_1.id]))[0].n).toBe(2);
  }, 600000);

  it("a forfeit and a void work exactly as before: the forfeit names the opposite team the winner, the void cancels the competition without a champion", async () => {
    const ctx = await proposed("Propagation Forfeit");
    await publish(ctx, ctx.digest);
    const f = await fixturesOf(ctx.competitionId);
    const forfeited = await forfeitFixture(compRepo, f.SEMIFINAL_1.id, ctx.organizer.gamingMemberId, f.SEMIFINAL_1.a!, "Team A could not field the minimum.");
    expect(forfeited.alreadyFinalized).toBe(false);
    expect(forfeited.winningCompetitionTeamId).toBe(f.SEMIFINAL_1.b);
    expect((await fixturesOf(ctx.competitionId)).FINAL.a).toBe(f.SEMIFINAL_1.b);
    const voided = await voidFixture(compRepo, f.SEMIFINAL_2.id, ctx.organizer.gamingMemberId, "Neither team could field the minimum.");
    expect(voided.competitionState).toBe("CANCELLED_WITHOUT_CHAMPION");
    expect((await stateOf(ctx.competitionId)).state).toBe("CANCELLED_WITHOUT_CHAMPION");
    expect((await fixturesOf(ctx.competitionId)).SEMIFINAL_2.state).toBe("VOID");
    expect((await voidFixture(compRepo, f.SEMIFINAL_2.id, ctx.organizer.gamingMemberId, "retry")).alreadyFinalized).toBe(true);
    expect(await publicationRows(ctx.competitionId)).toHaveLength(1); // the resolution is history: cancellation does not touch it
  }, 600000);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The existing finalize path, host-pilot form: the SSS journey reaches PUBLISHED for hosts as well
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("a host's private pilot publishes through the very same operation while the host is active", () => {
  it("the host publishes their drawn, proposed pilot; the replay is identical; the competition is PUBLISHED with three fixtures", async () => {
    const { ctx } = await proposedPilot("Host Publishes");
    const first = await publish(ctx, ctx.digest);
    const again = await publish(ctx, ctx.digest);
    expect(again.alreadyPublished).toBe(true);
    expect(again.publication).toEqual(first.publication);
    expect(await fixtureCount(ctx.competitionId)).toBe(3);
    expect((await stateOf(ctx.competitionId)).state).toBe("PUBLISHED");
  }, 360000);
});
