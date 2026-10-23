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
import { openTeamRegistration } from "../lib/gaming/competitions/openTeamRegistration";
import { closeTeamRegistration } from "../lib/gaming/competitions/closeTeamRegistration";
import { addCompetitionTeam } from "../lib/gaming/competitions/addCompetitionTeam";
import { publishCompetition } from "../lib/gaming/competitions/publishCompetition";
import { registerForCompetition } from "../lib/gaming/competitions/registerForCompetition";
import { appointScorekeeper } from "../lib/gaming/competitions/appointScorekeeper";
import { cancelCompetition } from "../lib/gaming/competitions/cancelCompetition";
import { CompetitionAccessDeniedError, CompetitionNotDraftError, HostAccessRevokedError, UnsupportedActivityKeyError } from "../lib/gaming/competitions/types";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";
// The REAL route handlers, called with real user access tokens against the real local database.
import { POST as generalCreateRoute } from "../app/api/gaming/competitions/route";
import { POST as hostCreateRoute } from "../app/api/gaming/host/competition/route";
import { GET as administrationRoute } from "../app/api/gaming/competitions/administration/route";

/**
 * UG-CR-GATE-SSS-004 — Small-Sided Soccer Organizer Planning Foundation, against a real (disposable, loopback-only) Postgres.
 *
 * Proves, in the database itself: the planning tables are server-only (row-level security, no browser privilege, no direct service-role
 * write), every revision and child row is append-only, the one atomic save operation applies the accepted authorization order (lock, exact
 * null-safe ownership, host-revocation guard, DRAFT, registry rule) and validates the COMPLETE payload on its own (not only in TypeScript),
 * derives the format from the locked competition, answers an exact replay idempotently, refuses an intent reused with a different payload, and
 * serializes concurrent saves without a duplicate or skipped revision number. It also proves, through the real route handlers and real user
 * tokens, that planning grants no authority to a scorekeeper, registrant, applicant, unrelated organizer or former host, and that creation
 * remains 5v5-only and discovery is untouched.
 *
 * A competition with a non-5v5 format is a BOUNDED SERVICE-SIDE CONTRACT FIXTURE (one service-role row update, as in the format-foundation
 * suite): no public creation path is used or widened.
 */

const env = loadEnv("development", process.cwd(), "");
const supabaseUrl = env.SUPABASE_URL;
requireLocalSupabase(supabaseUrl);
const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAnonKey = env.SUPABASE_ANON_KEY;
if (!supabaseUrl || !supabaseServiceRoleKey || !supabaseAnonKey) {
  throw new Error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are required for contract tests.");
}

// Raw pg runs rolled-back DDL/negative controls and the catalog checks. The URL is supplied explicitly, never read from .env.local, and must be loopback.
const supabaseDbUrl = process.env.COMPETITIONS_LOCAL_DB_URL ?? "";
if (!/^postgresql:\/\/[^@]+@(127\.0\.0\.1|localhost|\[::1\]):\d+\//.test(supabaseDbUrl)) {
  throw new Error("COMPETITIONS_LOCAL_DB_URL must be set to a loopback Postgres URL for the organizer-planning contract tests.");
}

const compRepo = new SupabaseCompetitionsRepository(supabaseUrl, supabaseServiceRoleKey);
const hostRepo = new SupabaseHostRepository(supabaseUrl, supabaseServiceRoleKey);
const gamingRepo = new SupabaseGamingRepository(supabaseUrl, supabaseServiceRoleKey);
const service = createClient(supabaseUrl, supabaseServiceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

const RUN = randomUUID().slice(0, 8);
const SAVE_FN = "save_competition_planning_revision_atomically";
const TABLES = [
  "competition_planning_revisions", "competition_planning_pitches", "competition_planning_pitch_formats",
  "competition_planning_dates", "competition_planning_windows",
] as const;

// Loaded lazily: until the module exists, only the tests that need it can fail.
const loadPlanning = () => import("../lib/gaming/competitions/planning");
const loadPlanningRoute = () => import("../app/api/gaming/competitions/[competitionId]/planning/route");

interface Person { authUserId: string; gamingMemberId: string; email: string }
const authUsers: string[] = [];
const operators: string[] = [];
let counter = 0;

async function newPerson(label: string): Promise<Person> {
  const email = `planning-${RUN}-${counter++}@example.com`;
  const { data, error } = await service.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("Could not create a test auth user.");
  authUsers.push(data.user.id);
  // A display name may not exceed 40 characters.
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
  const anon = createClient(supabaseUrl, supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const verified = await anon.auth.verifyOtp({ token_hash: link.data.properties.hashed_token, type: "email" });
  const token = verified.data.session?.access_token;
  if (!token) throw new Error("No session for the test member.");
  return token;
}

const COMP = "http://localhost/api/gaming/competitions";
const request = (url: string, method: string, token: string, body?: unknown) =>
  new Request(url, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const planningUrl = (competitionId: string) => `${COMP}/${competitionId}/planning`;
const ctx = (competitionId: string) => ({ params: { competitionId } });

async function rawTransaction<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  const db = new Client({ connectionString: supabaseDbUrl, statement_timeout: 30000 });
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
  const db = new Client({ connectionString: supabaseDbUrl, statement_timeout: 30000 });
  await db.connect();
  try {
    return (await db.query(sql, params)).rows as T[];
  } finally {
    await db.end().catch(() => {});
  }
}

/** Runs one statement inside a transaction that is always rolled back, and returns the database error it raised (or null). */
async function violation(statement: string): Promise<{ code?: string; constraint?: string; message: string } | null> {
  return rawTransaction(async (db) => {
    try {
      await db.query(statement);
      return null;
    } catch (err) {
      const e = err as { code?: string; constraint?: string; message?: string };
      return { code: e.code, constraint: e.constraint, message: e.message ?? "" };
    }
  });
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
}, 120000);

// Best effort only: some rows these flows create pin their members, so a failed delete is expected and silent by design. A database reset restores a
// clean state, and this file's identities are unique per run.
afterAll(async () => {
  if (operators.length > 0) await service.from("authority_grants").delete().in("gaming_member_id", operators);
  if (reviewer) await service.from("authority_grants").delete().eq("gaming_member_id", reviewer.gamingMemberId);
  for (const id of authUsers) await service.auth.admin.deleteUser(id).catch(() => {});
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
}, 300000);

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Plans
// ---------------------------------------------------------------------------------------------------------------------------------------------

const SNAPSHOT = "Draft planning rules, version one. Full public rules are pending.";
function rawPlan(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    venue: { name: `Cancha ${RUN}`, locationDescription: "Calle 5, San José, behind the central market", timeZone: "America/Costa_Rica", simultaneousMatchCapacity: 2, restrictionNotes: "No metal cleats." },
    pitches: [
      { label: "A", usable: true, supportedFormats: ["SOCCER_5V5"], restrictionNotes: "" },
      { label: "B", usable: true, supportedFormats: ["SOCCER_5V5", "SOCCER_6V6"], restrictionNotes: "Lights off after 21:00." },
    ],
    dates: [
      { date: "2026-11-07", windows: [{ start: "09:00", end: "13:00" }, { start: "15:00", end: "19:00" }] },
      { date: "2026-11-08", windows: [{ start: "09:00", end: "13:00" }] },
    ],
    roster: { minimum: 5, maximum: 8 },
    registrationDeadline: { local: "2026-11-01T18:00", timeZone: "America/Costa_Rica" },
    rules: { version: "draft-1", snapshot: SNAPSHOT },
    ...overrides,
  };
}

async function validPlan(overrides: Record<string, unknown> = {}, format = "SOCCER_5V5") {
  const { parsePlanningPlan } = await loadPlanning();
  return parsePlanningPlan(rawPlan(overrides), format as never);
}
async function payloadOf(overrides: Record<string, unknown> = {}, format = "SOCCER_5V5"): Promise<Record<string, any>> {
  const { planToRpcPayload } = await loadPlanning();
  return JSON.parse(JSON.stringify(planToRpcPayload(await validPlan(overrides, format))));
}

async function rpc(competitionId: string, organizerId: string | null, intentId: string, plan: unknown) {
  return service.rpc(SAVE_FN, { p_competition_id: competitionId, p_organizer_gaming_member_id: organizerId, p_intent_id: intentId, p_plan: plan });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Competitions
// ---------------------------------------------------------------------------------------------------------------------------------------------

async function draftCompetition(label: string): Promise<{ competitionId: string; organizer: Person }> {
  const organizer = await makeOperator(`${label} Organizer`);
  const created = await createCompetition(compRepo, organizer.gamingMemberId, `Plan ${label} ${RUN}`, "SOCCER_5V5");
  return { competitionId: created.competitionId, organizer };
}

async function publishedBracket(label: string) {
  const organizer = await makeOperator(`${label} Organizer`);
  const created = await createCompetition(compRepo, organizer.gamingMemberId, `Plan ${label} ${RUN}`, "SOCCER_5V5");
  await openTeamRegistration(compRepo, created.competitionId, organizer.gamingMemberId);
  const teams: string[] = [];
  for (let i = 0; i < 4; i++) {
    const captain = await newPerson(`${label} Captain ${i}`);
    const team = await addCompetitionTeam(compRepo, created.competitionId, organizer.gamingMemberId, `${label} Team ${i} ${RUN}`, captain.gamingMemberId);
    teams.push(team.competitionTeamId);
  }
  await closeTeamRegistration(compRepo, created.competitionId, organizer.gamingMemberId);
  const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();
  const published = await publishCompetition(compRepo, created.competitionId, organizer.gamingMemberId, teams[0], teams[1], teams[2], teams[3], inMs(3600_000), inMs(7200_000), inMs(10800_000));
  return { competitionId: created.competitionId, organizer, fixtureId: published.semifinal1FixtureId };
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
  const revoke = () => asGovernance(() => revokeHostCapability(hostRepo, reviewer.gamingMemberId, submitted.publicCode, "Planning contract test."));
  return { host, competitionId, revoke };
}

/** Every row of every planning table for one revision, in a stable order. */
async function revisionSnapshot(planningRevisionId: string): Promise<string> {
  const out: Record<string, unknown> = {};
  out.revision = await rawQuery("select * from competition_planning_revisions where planning_revision_id = $1", [planningRevisionId]);
  out.pitches = await rawQuery("select * from competition_planning_pitches where planning_revision_id = $1 order by position", [planningRevisionId]);
  out.formats = await rawQuery(
    "select f.* from competition_planning_pitch_formats f join competition_planning_pitches p using (planning_pitch_id) where p.planning_revision_id = $1 order by f.planning_pitch_id, f.format_key", [planningRevisionId]);
  out.dates = await rawQuery("select * from competition_planning_dates where planning_revision_id = $1 order by plan_date", [planningRevisionId]);
  out.windows = await rawQuery("select * from competition_planning_windows where planning_revision_id = $1 order by plan_date, window_index", [planningRevisionId]);
  return JSON.stringify(out);
}
const revisionRows = (competitionId: string) => rawQuery<{ planning_revision_id: string; revision_number: number; supersedes_revision_id: string | null }>(
  "select planning_revision_id, revision_number, supersedes_revision_id from competition_planning_revisions where competition_id = $1 order by revision_number", [competitionId]);
const countRows = async (competitionId: string) => (await rawQuery("select count(*)::int as n from competition_planning_revisions where competition_id = $1", [competitionId]))[0].n as number;

// ---------------------------------------------------------------------------------------------------------------------------------------------
// [schema] server-only, append-only
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("[schema] the planning tables are server-only and append-only", () => {
  it("exactly the five planning tables exist; each has row-level security on and no policy", async () => {
    const tables = await rawQuery<{ relname: string; relrowsecurity: boolean }>(
      "select c.relname, c.relrowsecurity from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and c.relname like 'competition\\_planning\\_%' order by 1");
    expect(tables.map((t) => t.relname)).toEqual([...TABLES].sort());
    for (const t of tables) expect(t.relrowsecurity, t.relname).toBe(true);
    const policies = await rawQuery("select tablename from pg_policies where schemaname = 'public' and tablename like 'competition\\_planning\\_%'");
    expect(policies).toEqual([]);
  });

  it("no browser role holds any privilege; the server role may read and nothing else; PUBLIC holds nothing", async () => {
    for (const table of TABLES) {
      for (const role of ["anon", "authenticated"]) {
        for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
          const [{ has }] = await rawQuery<{ has: boolean }>(`select has_table_privilege('${role}', 'public.${table}', '${privilege}') as has`);
          expect(has, `${role} ${privilege} ${table}`).toBe(false);
        }
      }
      for (const privilege of ["INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
        const [{ has }] = await rawQuery<{ has: boolean }>(`select has_table_privilege('service_role', 'public.${table}', '${privilege}') as has`);
        expect(has, `service_role ${privilege} ${table}`).toBe(false);
      }
      const [{ has }] = await rawQuery<{ has: boolean }>(`select has_table_privilege('service_role', 'public.${table}', 'SELECT') as has`);
      expect(has, `service_role SELECT ${table}`).toBe(true);
      const acl = await rawQuery<{ grantee: string }>("select grantee from information_schema.role_table_grants where table_schema = 'public' and table_name = $1 and grantee = 'PUBLIC'", [table]);
      expect(acl, table).toEqual([]);
    }
  });

  it("a browser caller cannot read the tables or call the save operation, and the service role cannot write a table directly", async () => {
    const anon = createClient(supabaseUrl, supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false } });
    for (const table of TABLES) {
      const read = await anon.from(table).select("*").limit(1);
      expect(read.error, table).not.toBeNull();
      expect(read.data ?? []).toEqual([]);
    }
    const { competitionId, organizer } = await draftCompetition("browser");
    const payload = await payloadOf();
    const asAnon = await anon.rpc(SAVE_FN, { p_competition_id: competitionId, p_organizer_gaming_member_id: organizer.gamingMemberId, p_intent_id: randomUUID(), p_plan: payload });
    expect(asAnon.error).not.toBeNull();
    const userClient = createClient(supabaseUrl, supabaseAnonKey, { global: { headers: { Authorization: `Bearer ${await tokenFor(organizer)}` } }, auth: { persistSession: false, autoRefreshToken: false } });
    const asUser = await userClient.rpc(SAVE_FN, { p_competition_id: competitionId, p_organizer_gaming_member_id: organizer.gamingMemberId, p_intent_id: randomUUID(), p_plan: payload });
    expect(asUser.error).not.toBeNull();
    const userRead = await userClient.from("competition_planning_revisions").select("*").limit(1);
    expect(userRead.error).not.toBeNull();
    const direct = await service.from("competition_planning_revisions").insert({ competition_id: competitionId, venue_name: "x" });
    expect(direct.error).not.toBeNull();
    expect(await countRows(competitionId)).toBe(0);
  }, 120000);

  it("the save operation is SECURITY DEFINER with a pinned search_path; only the server role may execute it; its trigger helpers are executable by nobody", async () => {
    const executable = async (role: string, name: string) =>
      (await rawQuery<{ has: boolean }>(
        `select has_function_privilege('${role}', p.oid, 'EXECUTE') as has from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = '${name}'`)).map((r) => r.has);
    const [fn] = await rawQuery<{ prosecdef: boolean; proconfig: string[] | null }>(
      `select p.prosecdef, p.proconfig from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = '${SAVE_FN}'`);
    expect(fn).toBeDefined();
    expect(fn.prosecdef).toBe(true);
    expect(fn.proconfig ?? []).toContain("search_path=public, pg_temp");
    for (const role of ["anon", "authenticated", "public"]) expect(await executable(role, SAVE_FN), role).toEqual([false]);
    expect(await executable("service_role", SAVE_FN)).toEqual([true]);
    const helpers = await rawQuery<{ proname: string }>(
      `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like 'competition\\_planning\\_%'`);
    expect(helpers.map((h) => h.proname).sort()).toEqual([
      "competition_planning_assert_keys", "competition_planning_check_date_limits", "competition_planning_check_window_overlap",
      "competition_planning_clean_text", "competition_planning_local_time_kind", "competition_planning_reject_change",
    ]);
    for (const h of helpers) for (const role of ["anon", "authenticated", "service_role", "public"]) {
      expect(await executable(role, h.proname), `${role} ${h.proname}`).toEqual([false]);
    }
  });

  it("19. a saved revision and every child row can never change: UPDATE, DELETE and TRUNCATE are refused on all five tables", async () => {
    const { competitionId, organizer } = await draftCompetition("immutable");
    const saved = await compRepo.savePlanningRevision(competitionId, organizer.gamingMemberId, randomUUID(), await validPlan());
    const [row] = await revisionRows(competitionId);
    expect(row.planning_revision_id).toBeTruthy();
    expect(saved.revision.revisionNumber).toBe(1);
    const before = await revisionSnapshot(row.planning_revision_id);
    const updates: Record<string, string> = {
      competition_planning_revisions: "update competition_planning_revisions set venue_name = 'changed'",
      competition_planning_pitches: "update competition_planning_pitches set label = 'changed'",
      competition_planning_pitch_formats: "update competition_planning_pitch_formats set format_key = 'SOCCER_8V8'",
      competition_planning_dates: "update competition_planning_dates set plan_date = '2030-01-01'",
      competition_planning_windows: "update competition_planning_windows set start_time = '01:00'",
    };
    for (const table of TABLES) {
      const u = await violation(updates[table]);
      expect(u?.message, `update ${table}`).toContain("PLANNING_REVISION_IMMUTABLE");
      const d = await violation(`delete from ${table}`);
      expect(d?.message, `delete ${table}`).toContain("PLANNING_REVISION_IMMUTABLE");
      const t = await violation(`truncate ${table} cascade`);
      expect(t?.message, `truncate ${table}`).toContain("PLANNING_REVISION_IMMUTABLE");
    }
    expect(await revisionSnapshot(row.planning_revision_id)).toBe(before);
  }, 120000);

  it("the stored format is tied to the competition's own by a composite foreign key, so it can never disagree or drift", async () => {
    const { competitionId, organizer } = await draftCompetition("format-fk");
    const other = await draftCompetition("format-fk-other");
    await compRepo.savePlanningRevision(competitionId, organizer.gamingMemberId, randomUUID(), await validPlan());
    const mismatched = await violation(`
      insert into competition_planning_revisions (competition_id, format_key, revision_number, authored_by_gaming_member_id, intent_id, payload_digest,
        venue_name, venue_location_description, venue_time_zone, simultaneous_match_capacity, venue_restriction_notes, roster_minimum, roster_maximum,
        registration_deadline_local, registration_deadline_time_zone, registration_deadline_utc_offset_minutes, registration_deadline_utc,
        rules_version, rules_snapshot, rules_snapshot_digest)
      select '${other.competitionId}'::uuid, 'SOCCER_6V6', 1, authored_by_gaming_member_id, gen_random_uuid(), payload_digest,
        venue_name, venue_location_description, venue_time_zone, simultaneous_match_capacity, venue_restriction_notes, roster_minimum, roster_maximum,
        registration_deadline_local, registration_deadline_time_zone, registration_deadline_utc_offset_minutes, registration_deadline_utc,
        rules_version, rules_snapshot, rules_snapshot_digest
      from competition_planning_revisions where competition_id = '${competitionId}'`);
    expect(mismatched?.code).toBe("23503");
    expect(mismatched?.constraint).toBe("competition_planning_revisions_competition_format_fkey");
    const drift = await violation(`update competitions set activity_key = 'SOCCER_6V6' where competition_id = '${competitionId}'`);
    expect(drift?.code).toBe("23503");
  });

  it("the revision chain is structural: one revision per number, one successor per revision, the superseded revision belongs to the same competition", async () => {
    const a = await draftCompetition("chain-a");
    const b = await draftCompetition("chain-b");
    await compRepo.savePlanningRevision(a.competitionId, a.organizer.gamingMemberId, randomUUID(), await validPlan());
    await compRepo.savePlanningRevision(b.competitionId, b.organizer.gamingMemberId, randomUUID(), await validPlan());
    const [ra] = await revisionRows(a.competitionId);
    const [rb] = await revisionRows(b.competitionId);
    const copy = (competitionId: string, number: number, supersedes: string | null, intent = "gen_random_uuid()") => `
      insert into competition_planning_revisions (competition_id, format_key, revision_number, supersedes_revision_id, authored_by_gaming_member_id, intent_id, payload_digest,
        venue_name, venue_location_description, venue_time_zone, simultaneous_match_capacity, venue_restriction_notes, roster_minimum, roster_maximum,
        registration_deadline_local, registration_deadline_time_zone, registration_deadline_utc_offset_minutes, registration_deadline_utc,
        rules_version, rules_snapshot, rules_snapshot_digest)
      select competition_id, format_key, ${number}, ${supersedes ? `'${supersedes}'` : "null"}, authored_by_gaming_member_id, ${intent}, payload_digest,
        venue_name, venue_location_description, venue_time_zone, simultaneous_match_capacity, venue_restriction_notes, roster_minimum, roster_maximum,
        registration_deadline_local, registration_deadline_time_zone, registration_deadline_utc_offset_minutes, registration_deadline_utc,
        rules_version, rules_snapshot, rules_snapshot_digest
      from competition_planning_revisions where competition_id = '${competitionId}' and revision_number = 1`;
    expect((await violation(copy(a.competitionId, 1, null)))?.code).toBe("23505");                         // a duplicate number
    expect((await violation(copy(a.competitionId, 2, rb.planning_revision_id)))?.code).toBe("23503");      // supersedes another competition's revision
    const forkRows = await violation(`${copy(a.competitionId, 2, ra.planning_revision_id)}; ${copy(a.competitionId, 3, ra.planning_revision_id)}`);
    expect(forkRows?.code).toBe("23505");                                                                  // two successors of one revision
    expect((await violation(copy(a.competitionId, 0, null)))?.code).toBe("23514");                         // numbers start at one
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// [save] the atomic operation: a revision and its facts
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("[save] the organizer saves an immutable, versioned plan for their DRAFT competition", () => {
  it("20. persists one revision with every fact explicit: the format from the competition, the author, the roster, the deadline in three forms, the rules and their digest", async () => {
    const { competitionId, organizer } = await draftCompetition("facts");
    const intent = randomUUID();
    const saved = await compRepo.savePlanningRevision(competitionId, organizer.gamingMemberId, intent, await validPlan({ roster: undefined }));
    expect(saved).toMatchObject({ alreadySaved: false, isCurrent: true });
    expect(saved.revision.revisionNumber).toBe(1);
    expect(saved.revision.supersedesRevisionNumber).toBeNull();
    expect(saved.revision.formatKey).toBe("SOCCER_5V5");

    const [rev] = await rawQuery("select * from competition_planning_revisions where competition_id = $1", [competitionId]);
    expect(rev).toMatchObject({
      competition_id: competitionId, format_key: "SOCCER_5V5", revision_number: 1, supersedes_revision_id: null, authored_by_gaming_member_id: organizer.gamingMemberId,
      intent_id: intent, venue_name: `Cancha ${RUN}`, venue_location_description: "Calle 5, San José, behind the central market", venue_time_zone: "America/Costa_Rica",
      simultaneous_match_capacity: 2, venue_restriction_notes: "No metal cleats.",
      roster_minimum: 5, roster_maximum: 8,                                                           // the registry defaults, persisted explicitly
      registration_deadline_time_zone: "America/Costa_Rica", registration_deadline_utc_offset_minutes: -360,
      rules_version: "draft-1", rules_snapshot: SNAPSHOT,
    });
    expect(rev.created_at).toBeInstanceOf(Date);
    expect(rev.registration_deadline_utc.toISOString()).toBe("2026-11-02T00:00:00.000Z");
    expect(rev.rules_snapshot_digest).toBe(createHash("sha256").update(SNAPSHOT, "utf8").digest("hex"));
    expect(rev.payload_digest).toMatch(/^[0-9a-f]{64}$/);
    // The local representation is stored as the wall-clock time the organizer entered.
    const [{ local }] = await rawQuery<{ local: string }>("select to_char(registration_deadline_local, 'YYYY-MM-DD\"T\"HH24:MI') as local from competition_planning_revisions where competition_id = $1", [competitionId]);
    expect(local).toBe("2026-11-01T18:00");

    const pitches = await rawQuery("select p.position, p.label, p.is_usable, p.restriction_notes, array_agg(f.format_key order by f.format_key) as formats from competition_planning_pitches p join competition_planning_pitch_formats f using (planning_pitch_id) where p.planning_revision_id = $1 group by 1,2,3,4 order by 1", [rev.planning_revision_id]);
    expect(pitches).toEqual([
      { position: 1, label: "A", is_usable: true, restriction_notes: "", formats: ["SOCCER_5V5"] },
      { position: 2, label: "B", is_usable: true, restriction_notes: "Lights off after 21:00.", formats: ["SOCCER_5V5", "SOCCER_6V6"] },
    ]);
    const dates = await rawQuery("select to_char(plan_date, 'YYYY-MM-DD') as d, position from competition_planning_dates where planning_revision_id = $1 order by position", [rev.planning_revision_id]);
    expect(dates).toEqual([{ d: "2026-11-07", position: 1 }, { d: "2026-11-08", position: 2 }]);
    const windows = await rawQuery("select to_char(plan_date, 'YYYY-MM-DD') as d, window_index, to_char(start_time, 'HH24:MI') as s, to_char(end_time, 'HH24:MI') as e from competition_planning_windows where planning_revision_id = $1 order by plan_date, window_index", [rev.planning_revision_id]);
    expect(windows).toEqual([
      { d: "2026-11-07", window_index: 1, s: "09:00", e: "13:00" }, { d: "2026-11-07", window_index: 2, s: "15:00", e: "19:00" }, { d: "2026-11-08", window_index: 1, s: "09:00", e: "13:00" },
    ]);

    const read = await compRepo.getCurrentPlanningRevision(competitionId);
    expect(read).toEqual(saved.revision);
    expect(read?.registrationDeadline).toEqual({ local: "2026-11-01T18:00", timeZone: "America/Costa_Rica", utcOffset: "-06:00", utc: "2026-11-02T00:00:00.000Z" });
    expect(read?.rules.snapshotDigest).toBe(rev.rules_snapshot_digest);
  }, 120000);

  it("a competition draft plan creates nothing else: no fixture, no draw, no state change, no venue or capability row", async () => {
    const { competitionId, organizer } = await draftCompetition("nothing-else");
    const before = await rawQuery("select state, activity_key, organizer_gaming_member_id, published_at from competitions where competition_id = $1", [competitionId]);
    const venueCounts = () => rawQuery("select (select count(*)::int from venues) as venues, (select count(*)::int from venue_activations) as activations");
    const venuesBefore = await venueCounts();
    await compRepo.savePlanningRevision(competitionId, organizer.gamingMemberId, randomUUID(), await validPlan());
    expect(await venueCounts()).toEqual(venuesBefore);
    expect(await rawQuery("select state, activity_key, organizer_gaming_member_id, published_at from competitions where competition_id = $1", [competitionId])).toEqual(before);
    expect((await rawQuery("select count(*)::int as n from competition_fixtures where competition_id = $1", [competitionId]))[0].n).toBe(0);
    expect((await rawQuery("select count(*)::int as n from competition_teams where competition_id = $1", [competitionId]))[0].n).toBe(0);
    expect((await rawQuery("select count(*)::int as n from competition_host_capabilities where competition_id = $1", [competitionId]))[0].n).toBe(0);
    // No reusable venue exists in planning: no planning table references any other venue table, and saving changes none of them.
    const references = await rawQuery<{ referenced: string }>(
      `select distinct confrelid::regclass::text as referenced from pg_constraint where contype = 'f' and conrelid::regclass::text like 'competition\\_planning\\_%'`);
    expect(references.map((r) => r.referenced).sort()).toEqual([
      "competition_format_rules", "competition_planning_dates", "competition_planning_pitches", "competition_planning_revisions", "competitions", "gaming_members",
    ]);
    const tables = await rawQuery<{ relname: string }>("select c.relname from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and (c.relname like '%format\\_capab%' or c.relname like '%approved%format%' or c.relname like 'competition\\_draw%' or c.relname like 'competition\\_schedule%')");
    expect(tables).toEqual([]);
  });

  it("a second save is revision 2 and supersedes revision 1, which is byte-for-byte what it was", async () => {
    const { competitionId, organizer } = await draftCompetition("supersede");
    await compRepo.savePlanningRevision(competitionId, organizer.gamingMemberId, randomUUID(), await validPlan());
    const [first] = await revisionRows(competitionId);
    const firstBefore = await revisionSnapshot(first.planning_revision_id);
    const second = await compRepo.savePlanningRevision(competitionId, organizer.gamingMemberId, randomUUID(), await validPlan({ venue: { ...rawPlan().venue, name: `Cancha Norte ${RUN}` } }));
    expect(second.revision.revisionNumber).toBe(2);
    expect(second.revision.supersedesRevisionNumber).toBe(1);
    expect(second.isCurrent).toBe(true);
    const rows = await revisionRows(competitionId);
    expect(rows.map((r) => [r.revision_number, r.supersedes_revision_id])).toEqual([[1, null], [2, first.planning_revision_id]]);
    expect(await revisionSnapshot(first.planning_revision_id)).toBe(firstBefore);
    expect((await compRepo.getCurrentPlanningRevision(competitionId))?.venue.name).toBe(`Cancha Norte ${RUN}`);
  });

  it("the rules snapshot of a saved revision is never rewritten by a later save", async () => {
    const { competitionId, organizer } = await draftCompetition("rules-snapshot");
    await compRepo.savePlanningRevision(competitionId, organizer.gamingMemberId, randomUUID(), await validPlan());
    await compRepo.savePlanningRevision(competitionId, organizer.gamingMemberId, randomUUID(), await validPlan({ rules: { version: "draft-2", snapshot: "A different snapshot." } }));
    const rows = await rawQuery("select revision_number, rules_version, rules_snapshot, rules_snapshot_digest from competition_planning_revisions where competition_id = $1 order by 1", [competitionId]);
    expect(rows.map((r) => [r.revision_number, r.rules_version, r.rules_snapshot])).toEqual([[1, "draft-1", SNAPSHOT], [2, "draft-2", "A different snapshot."]]);
    expect(rows[0].rules_snapshot_digest).toBe(createHash("sha256").update(SNAPSHOT, "utf8").digest("hex"));
    expect(rows[1].rules_snapshot_digest).toBe(createHash("sha256").update("A different snapshot.", "utf8").digest("hex"));
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// [replay] idempotency and intent reuse
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("[replay] an exact replay is idempotent; an intent reused with a different payload is refused", () => {
  it("26. the same intent with the same payload returns the same revision and writes nothing — even after a newer revision exists", async () => {
    const { competitionId, organizer } = await draftCompetition("replay");
    const intent = randomUUID();
    const plan = await validPlan();
    const first = await compRepo.savePlanningRevision(competitionId, organizer.gamingMemberId, intent, plan);
    const rowsBefore = await rawQuery("select (select count(*)::int from competition_planning_revisions) as r, (select count(*)::int from competition_planning_pitches) as p, (select count(*)::int from competition_planning_windows) as w");
    const again = await compRepo.savePlanningRevision(competitionId, organizer.gamingMemberId, intent, plan);
    expect(again).toMatchObject({ alreadySaved: true, isCurrent: true });
    expect(again.revision).toEqual(first.revision);
    expect(await rawQuery("select (select count(*)::int from competition_planning_revisions) as r, (select count(*)::int from competition_planning_pitches) as p, (select count(*)::int from competition_planning_windows) as w")).toEqual(rowsBefore);

    const newer = await compRepo.savePlanningRevision(competitionId, organizer.gamingMemberId, randomUUID(), await validPlan({ venue: { ...rawPlan().venue, name: `Changed ${RUN}` } }));
    expect(newer.revision.revisionNumber).toBe(2);
    const old = await compRepo.savePlanningRevision(competitionId, organizer.gamingMemberId, intent, plan);
    expect(old).toMatchObject({ alreadySaved: true, isCurrent: false });
    expect(old.revision.revisionNumber).toBe(1);
    expect(await countRows(competitionId)).toBe(2);
  });

  it("an equivalent plan (registry defaults omitted, the same facts) is the same payload and therefore an exact replay", async () => {
    const { competitionId, organizer } = await draftCompetition("replay-equivalent");
    const intent = randomUUID();
    await compRepo.savePlanningRevision(competitionId, organizer.gamingMemberId, intent, await validPlan({ roster: undefined }));
    const again = await compRepo.savePlanningRevision(competitionId, organizer.gamingMemberId, intent, await validPlan({ roster: { minimum: 5, maximum: 8 } }));
    expect(again.alreadySaved).toBe(true);
    expect(await countRows(competitionId)).toBe(1);
  });

  it("27. the same intent with a changed payload is refused, writes nothing, and reveals nothing of the earlier save", async () => {
    const { PlanningIntentMismatchError } = await loadPlanning();
    const { competitionId, organizer } = await draftCompetition("replay-mismatch");
    const intent = randomUUID();
    await compRepo.savePlanningRevision(competitionId, organizer.gamingMemberId, intent, await validPlan());
    const changed = await validPlan({ venue: { ...rawPlan().venue, name: `Other ${RUN}` } });
    const outcome = await compRepo.savePlanningRevision(competitionId, organizer.gamingMemberId, intent, changed).then(() => null, (e: unknown) => e);
    expect(outcome).toBeInstanceOf(PlanningIntentMismatchError);
    expect(JSON.stringify((outcome as Error).message)).not.toContain(`Cancha ${RUN}`);
    expect(await countRows(competitionId)).toBe(1);
    // An intent belongs to one competition: the same value on another competition is a different save.
    const other = await draftCompetition("replay-other");
    const fresh = await compRepo.savePlanningRevision(other.competitionId, other.organizer.gamingMemberId, intent, changed);
    expect(fresh).toMatchObject({ alreadySaved: false });
  });

  it("only the organizer may replay: the exact intent and payload from anyone else is denied before anything is returned", async () => {
    const { competitionId, organizer } = await draftCompetition("replay-private");
    const stranger = await makeOperator("Replay Stranger");
    const intent = randomUUID();
    const plan = await validPlan();
    await compRepo.savePlanningRevision(competitionId, organizer.gamingMemberId, intent, plan);
    await expect(compRepo.savePlanningRevision(competitionId, stranger.gamingMemberId, intent, plan)).rejects.toBeInstanceOf(CompetitionAccessDeniedError);
    const viaRpc = await rpc(competitionId, stranger.gamingMemberId, intent, await payloadOf());
    expect(viaRpc.error?.message).toContain("COMPETITION_ACCESS_DENIED");
    expect(viaRpc.data).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// [concurrency]
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("[concurrency] concurrent saves serialize", () => {
  it("28. eight simultaneous saves with different intents become revisions 1 to 8 exactly once each, in one unbroken chain", async () => {
    const { competitionId, organizer } = await draftCompetition("concurrent");
    const plans = await Promise.all(Array.from({ length: 8 }, (_, i) => validPlan({ venue: { ...rawPlan().venue, name: `Concurrent ${i} ${RUN}` } })));
    const results = await Promise.all(plans.map((plan) => compRepo.savePlanningRevision(competitionId, organizer.gamingMemberId, randomUUID(), plan)));
    expect(results.map((r) => r.revision.revisionNumber).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(results.every((r) => r.alreadySaved === false)).toBe(true);
    const rows = await revisionRows(competitionId);
    expect(rows.map((r) => r.revision_number)).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(rows[0].supersedes_revision_id).toBeNull();
    for (let i = 1; i < rows.length; i++) expect(rows[i].supersedes_revision_id).toBe(rows[i - 1].planning_revision_id);
    expect(results.filter((r) => r.isCurrent).map((r) => r.revision.revisionNumber).length).toBeGreaterThanOrEqual(1);
    const current = await compRepo.getCurrentPlanningRevision(competitionId);
    expect(current?.revisionNumber).toBe(8);
  }, 120000);

  it("eight simultaneous saves of the SAME intent and payload create exactly one revision; seven are replays", async () => {
    const { competitionId, organizer } = await draftCompetition("concurrent-same");
    const intent = randomUUID();
    const plan = await validPlan();
    const results = await Promise.all(Array.from({ length: 8 }, () => compRepo.savePlanningRevision(competitionId, organizer.gamingMemberId, intent, plan)));
    expect(results.filter((r) => !r.alreadySaved)).toHaveLength(1);
    expect(results.filter((r) => r.alreadySaved)).toHaveLength(7);
    expect(new Set(results.map((r) => r.revision.revisionNumber))).toEqual(new Set([1]));
    expect(await countRows(competitionId)).toBe(1);
  }, 120000);

  it("simultaneous saves on two competitions never block or mix: each has its own numbering", async () => {
    const a = await draftCompetition("concurrent-a");
    const b = await draftCompetition("concurrent-b");
    const plans = await Promise.all([1, 2, 3].map((i) => validPlan({ venue: { ...rawPlan().venue, name: `Mix ${i} ${RUN}` } })));
    await Promise.all([
      ...plans.map((plan) => compRepo.savePlanningRevision(a.competitionId, a.organizer.gamingMemberId, randomUUID(), plan)),
      ...plans.map((plan) => compRepo.savePlanningRevision(b.competitionId, b.organizer.gamingMemberId, randomUUID(), plan)),
    ]);
    expect((await revisionRows(a.competitionId)).map((r) => r.revision_number)).toEqual([1, 2, 3]);
    expect((await revisionRows(b.competitionId)).map((r) => r.revision_number)).toEqual([1, 2, 3]);
  }, 120000);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// [authority]
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("[authority] ordinary organizer planning needs organizer ownership and nothing else", () => {
  it("21. an unrelated organizer, even one holding OPERATIONAL, is denied and nothing is written", async () => {
    const { competitionId } = await draftCompetition("authority-owner");
    const stranger = await makeOperator("Authority Stranger");
    await expect(compRepo.savePlanningRevision(competitionId, stranger.gamingMemberId, randomUUID(), await validPlan())).rejects.toBeInstanceOf(CompetitionAccessDeniedError);
    expect(await countRows(competitionId)).toBe(0);
  });

  it("the organizer does NOT need a current OPERATIONAL grant: ownership alone authorizes competition-specific planning", async () => {
    const { competitionId, organizer } = await draftCompetition("authority-no-grant");
    await service.from("authority_grants").delete().eq("gaming_member_id", organizer.gamingMemberId);
    const saved = await compRepo.savePlanningRevision(competitionId, organizer.gamingMemberId, randomUUID(), await validPlan());
    expect(saved.revision.revisionNumber).toBe(1);
  });

  it("22. a scorekeeper-only member is denied — on the competition they score in, and on any other", async () => {
    const bracket = await publishedBracket("authority-scorekeeper");
    const scorekeeper = await newPerson("Scorekeeper");
    await appointScorekeeper(compRepo, bracket.fixtureId, bracket.organizer.gamingMemberId, scorekeeper.gamingMemberId);
    const draft = await draftCompetition("authority-scorekeeper-other");
    await expect(compRepo.savePlanningRevision(bracket.competitionId, scorekeeper.gamingMemberId, randomUUID(), await validPlan())).rejects.toBeInstanceOf(CompetitionAccessDeniedError);
    await expect(compRepo.savePlanningRevision(draft.competitionId, scorekeeper.gamingMemberId, randomUUID(), await validPlan())).rejects.toBeInstanceOf(CompetitionAccessDeniedError);
    expect(await countRows(bracket.competitionId)).toBe(0);
    expect(await countRows(draft.competitionId)).toBe(0);
  }, 120000);

  it("23. a registrant, a captain candidate, an applicant and a holder of an unused host capability are denied", async () => {
    const organizer = await makeOperator("Authority Open Organizer");
    const created = await createCompetition(compRepo, organizer.gamingMemberId, `Plan open ${RUN}`, "SOCCER_5V5");
    await openTeamRegistration(compRepo, created.competitionId, organizer.gamingMemberId);
    const registrant = await newPerson("Registrant");
    await registerForCompetition(compRepo, created.competitionId, registrant.gamingMemberId, true);
    await expect(compRepo.savePlanningRevision(created.competitionId, registrant.gamingMemberId, randomUUID(), await validPlan())).rejects.toBeInstanceOf(CompetitionAccessDeniedError);

    const draft = await draftCompetition("authority-applicant");
    const applicant = await newPerson("Applicant");
    const approved = await newPerson("Capability Holder");
    const application = {
      venueName: `Venue ${RUN}`, cityArea: "Fictional Heights", playingFields: 2,
      venueDescription: "A fictional venue used only by the local contract suite; it runs imaginary leagues.",
      expectedWindow: "weekend of 14 November", expectedTeamCount: 4, confirmAllAdults: true, confirmIndependentScorekeepers: true, confirmPilotExclusions: true,
    };
    await submitHostApplication(hostRepo, applicant.gamingMemberId, application);
    const second = await submitHostApplication(hostRepo, approved.gamingMemberId, application);
    await asGovernance(() => decideHostApplication(hostRepo, reviewer.gamingMemberId, second.publicCode, "APPROVE", null));
    for (const person of [applicant, approved]) {
      await expect(compRepo.savePlanningRevision(draft.competitionId, person.gamingMemberId, randomUUID(), await validPlan())).rejects.toBeInstanceOf(CompetitionAccessDeniedError);
    }
    expect(await countRows(draft.competitionId)).toBe(0);
    expect(await countRows(created.competitionId)).toBe(0);
  }, 120000);

  it("a NULL caller is denied at the authorization boundary and nothing is written (the null-safe comparison)", async () => {
    const { competitionId } = await draftCompetition("authority-null");
    const viaRpc = await rpc(competitionId, null, randomUUID(), await payloadOf());
    expect(viaRpc.error?.message).toContain("COMPETITION_ACCESS_DENIED");
    expect(await countRows(competitionId)).toBe(0);
    expect((await rpc(randomUUID(), randomUUID(), randomUUID(), await payloadOf())).error?.message).toContain("COMPETITION_NOT_FOUND");
  });

  it("24. a revoked host organizer is refused by the host-revocation guard; an active host organizer may plan; the revocation does not rewrite what was saved", async () => {
    const pilot = await hostPilot("authority-host");
    const saved = await compRepo.savePlanningRevision(pilot.competitionId, pilot.host.gamingMemberId, randomUUID(), await validPlan());
    expect(saved.revision.revisionNumber).toBe(1);
    await pilot.revoke();
    await expect(compRepo.savePlanningRevision(pilot.competitionId, pilot.host.gamingMemberId, randomUUID(), await validPlan({ venue: { ...rawPlan().venue, name: "After revocation" } }))).rejects.toBeInstanceOf(HostAccessRevokedError);
    expect(await countRows(pilot.competitionId)).toBe(1);
    expect((await revisionRows(pilot.competitionId)).length).toBe(1);
  }, 120000);

  it("25. a competition that is no longer a DRAFT refuses planning: open registration, ready to publish, published, and cancelled", async () => {
    const open = await draftCompetition("state-open");
    await openTeamRegistration(compRepo, open.competitionId, open.organizer.gamingMemberId);
    await expect(compRepo.savePlanningRevision(open.competitionId, open.organizer.gamingMemberId, randomUUID(), await validPlan())).rejects.toBeInstanceOf(CompetitionNotDraftError);

    const published = await publishedBracket("state-published");
    await expect(compRepo.savePlanningRevision(published.competitionId, published.organizer.gamingMemberId, randomUUID(), await validPlan())).rejects.toBeInstanceOf(CompetitionNotDraftError);

    const cancelled = await draftCompetition("state-cancelled");
    await cancelCompetition(compRepo, cancelled.competitionId, cancelled.organizer.gamingMemberId, "Planning contract test.");
    await expect(compRepo.savePlanningRevision(cancelled.competitionId, cancelled.organizer.gamingMemberId, randomUUID(), await validPlan())).rejects.toBeInstanceOf(CompetitionNotDraftError);

    // A plan saved while the competition was a draft stays readable after it moves on, and cannot be replayed into a new revision.
    const moved = await draftCompetition("state-moved");
    const intent = randomUUID();
    const plan = await validPlan();
    await compRepo.savePlanningRevision(moved.competitionId, moved.organizer.gamingMemberId, intent, plan);
    await openTeamRegistration(compRepo, moved.competitionId, moved.organizer.gamingMemberId);
    await expect(compRepo.savePlanningRevision(moved.competitionId, moved.organizer.gamingMemberId, intent, plan)).rejects.toBeInstanceOf(CompetitionNotDraftError);
    expect((await compRepo.getCurrentPlanningRevision(moved.competitionId))?.revisionNumber).toBe(1);
  }, 180000);

  it("the accepted authorization order holds: ownership before host revocation before DRAFT before validation — each refusal beats every later one", async () => {
    const stranger = await makeOperator("Order Stranger");
    const published = await publishedBracket("order");
    const invalid = { nonsense: true };
    // Not the organizer on a non-draft competition with an invalid plan: ownership is decided first.
    expect((await rpc(published.competitionId, stranger.gamingMemberId, randomUUID(), invalid)).error?.message).toContain("COMPETITION_ACCESS_DENIED");
    // The organizer on a non-draft competition with an invalid plan: the state is decided before the plan is read.
    expect((await rpc(published.competitionId, published.organizer.gamingMemberId, randomUUID(), invalid)).error?.message).toContain("COMPETITION_NOT_DRAFT");
    // The organizer on a draft with an invalid plan: only now is the plan judged.
    const draft = await draftCompetition("order-draft");
    expect((await rpc(draft.competitionId, draft.organizer.gamingMemberId, randomUUID(), invalid)).error?.message).toContain("PLANNING_INVALID");
    // A revoked host on a non-draft or invalid request is refused as revoked, before the state or the plan.
    const pilot = await hostPilot("order-host");
    await pilot.revoke();
    expect((await rpc(pilot.competitionId, pilot.host.gamingMemberId, randomUUID(), invalid)).error?.message).toContain("HOST_ACCESS_REVOKED");
  }, 180000);

  it("30. no cross-competition read or write: a plan is addressed by its competition, and another competition's organizer sees and changes nothing of it", async () => {
    const a = await draftCompetition("cross-a");
    const b = await draftCompetition("cross-b");
    await compRepo.savePlanningRevision(a.competitionId, a.organizer.gamingMemberId, randomUUID(), await validPlan({ venue: { ...rawPlan().venue, name: `Only A ${RUN}` } }));
    expect(await compRepo.getCurrentPlanningRevision(b.competitionId)).toBeNull();
    await compRepo.savePlanningRevision(b.competitionId, b.organizer.gamingMemberId, randomUUID(), await validPlan({ venue: { ...rawPlan().venue, name: `Only B ${RUN}` } }));
    expect((await compRepo.getCurrentPlanningRevision(a.competitionId))?.venue.name).toBe(`Only A ${RUN}`);
    expect((await compRepo.getCurrentPlanningRevision(b.competitionId))?.venue.name).toBe(`Only B ${RUN}`);
    await expect(compRepo.savePlanningRevision(a.competitionId, b.organizer.gamingMemberId, randomUUID(), await validPlan())).rejects.toBeInstanceOf(CompetitionAccessDeniedError);
    expect(await countRows(a.competitionId)).toBe(1);
  });

  it("29. malformed identifiers fail closed at the database too", async () => {
    const { competitionId, organizer } = await draftCompetition("malformed");
    const payload = await payloadOf();
    for (const [competition, member, intent] of [
      ["not-a-uuid", organizer.gamingMemberId, randomUUID()], [competitionId, "not-a-uuid", randomUUID()], [competitionId, organizer.gamingMemberId, "not-a-uuid"],
    ] as const) {
      const res = await rpc(competition, member, intent, payload);
      expect(res.error).not.toBeNull();
      expect(res.data).toBeNull();
    }
    expect((await rpc(competitionId, organizer.gamingMemberId, null as never, payload)).error?.message).toContain("PLANNING_INVALID");
    expect(await countRows(competitionId)).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// [validation] the database validates the complete payload on its own
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("[validation] the atomic operation judges the whole payload itself, whatever reached it", () => {
  type Mutate = (p: Record<string, any>) => void;
  const CASES: Array<[string, string, Mutate]> = [
    ["a payload that is not an object", "PLAN_NOT_OBJECT", () => {}],
    ["an unknown top-level field", "UNKNOWN_FIELD", (p) => { p.timing = { minutes_per_half: 20 }; }],
    ["a format smuggled into the plan", "UNKNOWN_FIELD", (p) => { p.format_key = "SOCCER_8V8"; }],
    ["an unknown venue field", "UNKNOWN_FIELD", (p) => { p.venue.owner = "x"; }],
    ["a missing venue", "REQUIRED", (p) => { delete p.venue; }],
    ["an empty venue name", "REQUIRED", (p) => { p.venue.name = "  "; }],
    ["an over-long venue name", "TOO_LONG", (p) => { p.venue.name = "x".repeat(121); }],
    ["a control character in the venue name", "INVALID_TEXT", (p) => { p.venue.name = "a\u0007b"; }],
    ["an over-long location", "TOO_LONG", (p) => { p.venue.location_description = "x".repeat(301); }],
    ["an unknown time zone", "INVALID_TIMEZONE", (p) => { p.venue.time_zone = "Mars/Olympus"; p.registration_deadline.time_zone = "Mars/Olympus"; }],
    ["an abbreviated time zone", "INVALID_TIMEZONE", (p) => { p.venue.time_zone = "EST"; p.registration_deadline.time_zone = "EST"; }],
    ["capacity zero", "CAPACITY_INVALID", (p) => { p.venue.simultaneous_match_capacity = 0; }],
    ["capacity above the usable pitches", "CAPACITY_INVALID", (p) => { p.venue.simultaneous_match_capacity = 3; }],
    ["a fractional capacity", "CAPACITY_INVALID", (p) => { p.venue.simultaneous_match_capacity = 1.5; }],
    ["a string capacity", "CAPACITY_INVALID", (p) => { p.venue.simultaneous_match_capacity = "2"; }],
    ["no pitches", "NO_PITCHES", (p) => { p.pitches = []; }],
    ["no usable pitch", "NO_USABLE_PITCH", (p) => { p.pitches.forEach((x: any) => { x.usable = false; }); p.venue.simultaneous_match_capacity = 1; }],
    ["seventeen pitches", "TOO_MANY_PITCHES", (p) => { p.pitches = Array.from({ length: 17 }, (_, i) => ({ label: `P${i}`, usable: true, supported_formats: ["SOCCER_5V5"], restriction_notes: "" })); }],
    ["duplicate pitch labels (ignoring case)", "DUPLICATE_LABEL", (p) => { p.pitches[1].label = " a "; }],
    ["an empty pitch label", "REQUIRED", (p) => { p.pitches[1].label = ""; }],
    ["an unsupported pitch format key", "UNSUPPORTED_FORMAT_KEY", (p) => { p.pitches[1].supported_formats = ["SOCCER_9V9"]; }],
    ["a usable pitch with no format", "REQUIRED", (p) => { p.pitches[1].supported_formats = []; }],
    ["no usable pitch for the competition's format", "FORMAT_NOT_SUPPORTED_BY_ANY_USABLE_PITCH", (p) => { p.pitches.forEach((x: any) => { x.supported_formats = ["SOCCER_7V7"]; }); }],
    ["no dates", "DATE_COUNT_INVALID", (p) => { p.dates = []; }],
    ["four dates", "DATE_COUNT_INVALID", (p) => { p.dates = ["2026-11-07", "2026-11-08", "2026-11-09", "2026-11-10"].map((date) => ({ date, windows: [{ start: "09:00", end: "10:00" }] })); }],
    ["a repeated date", "DUPLICATE_DATE", (p) => { p.dates[1].date = "2026-11-07"; }],
    ["a date that is not a calendar day", "INVALID_DATE", (p) => { p.dates[1].date = "2026-02-30"; }],
    ["a span of fifteen days", "DATE_SPAN_TOO_LONG", (p) => { p.dates = [{ date: "2026-11-07", windows: [{ start: "09:00", end: "10:00" }] }, { date: "2026-11-21", windows: [{ start: "09:00", end: "10:00" }] }]; }],
    ["a date with no window", "WINDOW_COUNT_INVALID", (p) => { p.dates[1].windows = []; }],
    ["a date with three windows", "WINDOW_COUNT_INVALID", (p) => { p.dates[0].windows = [{ start: "08:00", end: "09:00" }, { start: "10:00", end: "11:00" }, { start: "12:00", end: "13:00" }]; }],
    ["overlapping windows", "WINDOW_OVERLAP", (p) => { p.dates[0].windows = [{ start: "09:00", end: "13:00" }, { start: "12:00", end: "15:00" }]; }],
    ["a window crossing midnight", "WINDOW_CROSSES_MIDNIGHT", (p) => { p.dates[1].windows = [{ start: "22:00", end: "02:00" }]; }],
    ["a malformed window time", "INVALID_TIME", (p) => { p.dates[1].windows = [{ start: "9:00", end: "13:00" }]; }],
    ["a roster minimum below the players on the field", "ROSTER_MINIMUM_OUT_OF_RANGE", (p) => { p.roster.minimum = 4; }],
    ["a roster maximum above the absolute maximum", "ROSTER_MAXIMUM_OUT_OF_RANGE", (p) => { p.roster.maximum = 11; }],
    ["a roster minimum above its maximum", "ROSTER_MINIMUM_ABOVE_MAXIMUM", (p) => { p.roster.minimum = 8; p.roster.maximum = 7; }],
    ["a roster value that is not a whole number", "ROSTER_VALUE_INVALID", (p) => { p.roster.minimum = 5.5; }],
    ["a missing roster value (the plan must carry it explicitly)", "ROSTER_VALUE_INVALID", (p) => { p.roster = { minimum: 5 }; }],
    ["a deadline whose local time does not exist", "DEADLINE_UTC_MISMATCH", (p) => {
      p.venue.time_zone = "America/New_York"; p.registration_deadline = { local: "2026-03-08T02:30", time_zone: "America/New_York", utc_offset_minutes: -240, utc: "2026-03-08T06:30:00.000Z" };
    }],
    ["a deadline whose UTC instant disagrees with the local time", "DEADLINE_UTC_MISMATCH", (p) => { p.registration_deadline.utc = "2026-11-02T01:00:00.000Z"; }],
    ["a deadline whose offset disagrees", "DEADLINE_OFFSET_MISMATCH", (p) => { p.registration_deadline.utc_offset_minutes = -300; }],
    ["a deadline in another time zone than the venue's", "DEADLINE_TIMEZONE_MISMATCH", (p) => { p.registration_deadline.time_zone = "America/New_York"; }],
    ["a malformed deadline", "DEADLINE_INVALID", (p) => { p.registration_deadline.local = "2026-11-01 18:00"; }],
    ["a deadline at or after the first window", "DEADLINE_NOT_BEFORE_FIRST_WINDOW", (p) => { p.registration_deadline = { local: "2026-11-07T09:00", time_zone: "America/Costa_Rica", utc_offset_minutes: -360, utc: "2026-11-07T15:00:00.000Z" }; }],
    ["a missing rules version", "REQUIRED", (p) => { delete p.rules.version; }],
    ["a malformed rules version", "INVALID", (p) => { p.rules.version = "has space"; }],
    ["a missing rules snapshot", "REQUIRED", (p) => { p.rules.snapshot = "  "; }],
    ["an over-long rules snapshot", "TOO_LONG", (p) => { p.rules.snapshot = "x".repeat(4001); }],
  ];

  it.each(CASES)("30b. refuses %s with PLANNING_INVALID %s and writes nothing", async (_label, code, mutate) => {
    const { competitionId, organizer } = await draftCompetition("validation");
    const payload = await payloadOf();
    mutate(payload);
    const plan = _label === "a payload that is not an object" ? [] : payload;
    const res = await rpc(competitionId, organizer.gamingMemberId, randomUUID(), plan);
    expect(res.error?.message, _label).toContain(`PLANNING_INVALID: ${code}`);
    expect(res.data).toBeNull();
    expect(await countRows(competitionId)).toBe(0);
  }, 60000);

  it("the same database rules accept the boundary cases: 3 dates over 14 days, 2 windows per date, adjacent windows, 16 pitches, capacity equal to the usable pitches", async () => {
    const { competitionId, organizer } = await draftCompetition("validation-bounds");
    const payload = await payloadOf();
    payload.dates = [
      { date: "2026-11-07", windows: [{ start: "09:00", end: "12:00" }, { start: "12:00", end: "15:00" }] },
      { date: "2026-11-12", windows: [{ start: "00:00", end: "23:59" }] },
      { date: "2026-11-20", windows: [{ start: "09:00", end: "10:00" }] },
    ];
    payload.pitches = Array.from({ length: 16 }, (_, i) => ({ label: `P${i}`, usable: true, supported_formats: ["SOCCER_5V5"], restriction_notes: "" }));
    payload.venue.simultaneous_match_capacity = 16;
    const res = await rpc(competitionId, organizer.gamingMemberId, randomUUID(), payload);
    expect(res.error).toBeNull();
    expect(await countRows(competitionId)).toBe(1);
  });

  it("an ambiguous local time is stored with the explicit offset that resolves it; each offset keeps its own UTC instant", async () => {
    const { competitionId, organizer } = await draftCompetition("validation-ambiguous");
    const ny = { venue: { ...rawPlan().venue, timeZone: "America/New_York" }, dates: [{ date: "2026-11-07", windows: [{ start: "09:00", end: "13:00" }] }] };
    const first = await compRepo.savePlanningRevision(competitionId, organizer.gamingMemberId, randomUUID(), await validPlan({ ...ny, registrationDeadline: { local: "2026-11-01T01:30", timeZone: "America/New_York", utcOffset: "-04:00" } }));
    const second = await compRepo.savePlanningRevision(competitionId, organizer.gamingMemberId, randomUUID(), await validPlan({ ...ny, registrationDeadline: { local: "2026-11-01T01:30", timeZone: "America/New_York", utcOffset: "-05:00" } }));
    expect(first.revision.registrationDeadline).toEqual({ local: "2026-11-01T01:30", timeZone: "America/New_York", utcOffset: "-04:00", utc: "2026-11-01T05:30:00.000Z" });
    expect(second.revision.registrationDeadline).toEqual({ local: "2026-11-01T01:30", timeZone: "America/New_York", utcOffset: "-05:00", utc: "2026-11-01T06:30:00.000Z" });
  });

  it("the format comes from the locked competition: a 7v7 fixture competition is judged by the 7v7 registry rule and stores that format, whatever the plan says", async () => {
    const { competitionId, organizer } = await draftCompetition("format-derived");
    // A bounded service-side fixture, run entirely inside one transaction that is always rolled back: a competition row with another format would
    // otherwise outlive this test (a saved revision pins its competition's format), and other suites assume every competition row is 5v5.
    const save = (db: Client, plan: unknown) => db.query("select * from save_competition_planning_revision_atomically($1, $2, $3, $4::jsonb)", [competitionId, organizer.gamingMemberId, randomUUID(), JSON.stringify(plan)]);
    const refused = async (db: Client, plan: unknown): Promise<string> => {
      await db.query("savepoint attempt");
      try { await save(db, plan); return ""; } catch (err) { return (err as Error).message; } finally { await db.query("rollback to savepoint attempt"); }
    };
    const sevenPitches = [{ label: "A", usable: true, supportedFormats: ["SOCCER_7V7"] }, { label: "B", usable: true, supportedFormats: ["SOCCER_7V7"] }];
    const fiveShaped = await payloadOf();
    const sevenShaped = await payloadOf({ pitches: sevenPitches, roster: { minimum: 7, maximum: 12 } }, "SOCCER_7V7");
    const outOfRange = JSON.parse(JSON.stringify(sevenShaped));
    outOfRange.roster.maximum = 15;

    await rawTransaction(async (db) => {
      await db.query("update competitions set activity_key = 'SOCCER_7V7' where competition_id = $1", [competitionId]);
      // A 5v5-shaped plan is refused for a 7v7 competition: its roster defaults and the pitches' support are 5v5's.
      expect(await refused(db, fiveShaped)).toContain("PLANNING_INVALID");
      expect((await db.query("select count(*)::int as n from competition_planning_revisions where competition_id = $1", [competitionId])).rows[0].n).toBe(0);
      // The roster bounds follow the registry of THIS format.
      expect(await refused(db, outOfRange)).toContain("ROSTER_MAXIMUM_OUT_OF_RANGE");
      // A 7v7-shaped plan is accepted, and the revision records the competition's own format.
      await save(db, sevenShaped);
      const row = (await db.query("select format_key, roster_minimum, roster_maximum from competition_planning_revisions where competition_id = $1", [competitionId])).rows[0];
      expect(row).toEqual({ format_key: "SOCCER_7V7", roster_minimum: 7, roster_maximum: 12 });
    });
    // Nothing of it survived: the competition is still 5v5 and has no revision.
    expect((await rawQuery("select activity_key from competitions where competition_id = $1", [competitionId]))[0].activity_key).toBe("SOCCER_5V5");
    expect(await countRows(competitionId)).toBe(0);
  }, 120000);

  it("the plan cannot carry the fixed timing in any form: the database has no place to put it", async () => {
    const columns = await rawQuery<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'public' and table_name like 'competition\\_planning\\_%'");
    for (const { column_name } of columns) expect(column_name).not.toMatch(/minutes_per_half|halftime|transition|team_rest|shootout|halves/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// [registry] the supported formats of a pitch are the authoritative registry's, by foreign key
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("[registry] SSS-004A: planning is tied to the authoritative format registry by the database itself", () => {
  it("a pitch's supported format is a foreign key to competition_format_rules(format_key) — and no duplicated list of keys stands in for it", async () => {
    const fks = await rawQuery<{ conname: string; target: string; cols: string; refcols: string; convalidated: boolean }>(
      `select c.conname, c.confrelid::regclass::text as target, c.convalidated,
              (select string_agg(a.attname, ',' order by u.ord) from unnest(c.conkey) with ordinality u(attnum, ord) join pg_attribute a on a.attrelid = c.conrelid and a.attnum = u.attnum) as cols,
              (select string_agg(a.attname, ',' order by u.ord) from unnest(c.confkey) with ordinality u(attnum, ord) join pg_attribute a on a.attrelid = c.confrelid and a.attnum = u.attnum) as refcols
         from pg_constraint c where c.contype = 'f' and c.conrelid = 'public.competition_planning_pitch_formats'::regclass order by 1`);
    expect(fks).toContainEqual({ conname: "competition_planning_pitch_formats_format_registry_fkey", target: "competition_format_rules", cols: "format_key", refcols: "format_key", convalidated: true });
    const checks = await rawQuery<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where contype = 'c' and conrelid = 'public.competition_planning_pitch_formats'::regclass");
    expect(checks.filter((c) => /SOCCER_/.test(c.def))).toEqual([]);
  });

  it("the foreign key is what refuses an unregistered format (23503 naming that constraint) — a registry key is accepted", async () => {
    const { competitionId, organizer } = await draftCompetition("registry-fk");
    await compRepo.savePlanningRevision(competitionId, organizer.gamingMemberId, randomUUID(), await validPlan());
    const insert = (key: string) => `insert into competition_planning_pitch_formats (planning_pitch_id, format_key)
        select p.planning_pitch_id, '${key}' from competition_planning_pitches p join competition_planning_revisions r using (planning_revision_id)
         where r.competition_id = '${competitionId}' and p.position = 1 and not exists (select 1 from competition_planning_pitch_formats f where f.planning_pitch_id = p.planning_pitch_id and f.format_key = '${key}')`;
    for (const bad of ["SOCCER_9V9", "soccer_5v5", "SOCCER_5V5 ", "FUTSAL_5V5"]) {
      const err = await violation(insert(bad));
      expect(err?.code, bad).toBe("23503");
      expect(err?.constraint, bad).toBe("competition_planning_pitch_formats_format_registry_fkey");
    }
    // A registry key the pitch lacks satisfies the foreign key (this transaction is rolled back, so nothing persists).
    expect(await violation(insert("SOCCER_7V7"))).toBeNull();
  });

  it("the save operation still judges every pitch format against the registry's own rows at run time (an unregistered key is refused before anything is written)", async () => {
    const { competitionId, organizer } = await draftCompetition("registry-runtime");
    const payload = await payloadOf();
    payload.pitches[1].supported_formats = ["SOCCER_5V5", "SOCCER_9V9"];
    const res = await rpc(competitionId, organizer.gamingMemberId, randomUUID(), payload);
    expect(res.error?.message).toContain("PLANNING_INVALID: UNSUPPORTED_FORMAT_KEY");
    expect(await countRows(competitionId)).toBe(0);
  });

  it("the revision's format is still tied to its competition's own by the composite foreign key", async () => {
    const [fk] = await rawQuery<{ def: string }>("select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'competition_planning_revisions_competition_format_fkey'");
    expect(fk.def).toBe("FOREIGN KEY (competition_id, format_key) REFERENCES competitions(competition_id, activity_key)");
  });

  it("the registry itself is untouched: still the four accepted rows, still read-only for the server role", async () => {
    const rows = await rawQuery("select format_key from competition_format_rules order by 1");
    expect(rows.map((r) => r.format_key)).toEqual(["SOCCER_5V5", "SOCCER_6V6", "SOCCER_7V7", "SOCCER_8V8"]);
    for (const privilege of ["INSERT", "UPDATE", "DELETE", "TRUNCATE"]) {
      const [{ has }] = await rawQuery<{ has: boolean }>(`select has_table_privilege('service_role', 'public.competition_format_rules', '${privilege}') as has`);
      expect(has, privilege).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// [windows] operating-window endpoints are judged against the venue's own clock changes
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("[windows] SSS-004A: a window endpoint that a clock change skips or repeats is refused by the database itself, never silently shifted", () => {
  const NONEXISTENT = "WINDOW_NONEXISTENT_LOCAL_TIME";
  const AMBIGUOUS = "WINDOW_AMBIGUOUS_LOCAL_TIME";
  const DEADLINE = "2026-02-20T18:00";
  const NY = "America/New_York";

  /** A valid payload for the zone (built by the application's own validator on an ordinary date), then its one date and window replaced verbatim. */
  async function payloadWithWindows(zone: string, date: string, windows: Array<[string, string]>) {
    const payload = await payloadOf({
      venue: { ...rawPlan().venue, timeZone: zone },
      dates: [{ date: "2026-03-10", windows: [{ start: "09:00", end: "10:00" }] }],
      registrationDeadline: { local: DEADLINE, timeZone: zone },
    });
    payload.dates = [{ date, windows: windows.map(([start, end]) => ({ start, end })) }];
    return payload;
  }
  const storedWindows = (competitionId: string) => rawQuery<{ plan_date: string; s: string; e: string }>(
    `select to_char(w.plan_date, 'YYYY-MM-DD') as plan_date, to_char(w.start_time, 'HH24:MI') as s, to_char(w.end_time, 'HH24:MI') as e
       from competition_planning_windows w join competition_planning_revisions r using (planning_revision_id) where r.competition_id = $1 order by 1, 2`, [competitionId]);

  const REFUSED: Array<[string, string, string, [string, string], string]> = [
    ["a nonexistent START (New York, spring forward)", NY, "2026-03-08", ["02:30", "04:00"], NONEXISTENT],
    ["a nonexistent END (New York)", NY, "2026-03-08", ["01:00", "02:30"], NONEXISTENT],
    ["an ambiguous START (New York, fall back)", NY, "2026-11-01", ["01:30", "03:00"], AMBIGUOUS],
    ["an ambiguous END (New York)", NY, "2026-11-01", ["00:30", "01:15"], AMBIGUOUS],
    ["a nonexistent START in Madrid", "Europe/Madrid", "2026-03-29", ["02:30", "05:00"], NONEXISTENT],
    ["an ambiguous START in Madrid", "Europe/Madrid", "2026-10-25", ["02:30", "05:00"], AMBIGUOUS],
    ["a nonexistent START in Lord Howe (a half-hour change)", "Australia/Lord_Howe", "2026-10-04", ["02:15", "05:00"], NONEXISTENT],
    ["an ambiguous START in Lord Howe (a half-hour change)", "Australia/Lord_Howe", "2026-04-05", ["01:45", "05:00"], AMBIGUOUS],
    ["the very first skipped minute (New York 02:00 on the spring-forward day)", NY, "2026-03-08", ["02:00", "04:00"], NONEXISTENT],
    ["the last skipped minute (New York 02:59)", NY, "2026-03-08", ["02:59", "04:00"], NONEXISTENT],
    ["the first repeated minute (New York 01:00 on the fall-back day)", NY, "2026-11-01", ["01:00", "03:00"], AMBIGUOUS],
    ["the last repeated minute (New York 01:59)", NY, "2026-11-01", ["01:59", "03:00"], AMBIGUOUS],
  ];

  it.each(REFUSED)("refuses %s with PLANNING_INVALID and saves nothing", async (_label, zone, date, [start, end], code) => {
    const { competitionId, organizer } = await draftCompetition("window-refused");
    const res = await rpc(competitionId, organizer.gamingMemberId, randomUUID(), await payloadWithWindows(zone, date, [[start, end]]));
    expect(res.error?.message, _label).toContain(`PLANNING_INVALID: ${code}`);
    expect(res.data).toBeNull();
    expect(await countRows(competitionId)).toBe(0);
    expect(await storedWindows(competitionId)).toEqual([]);
  }, 60000);

  it("refuses an ambiguous end on the fall-back day too, and a second window's bad endpoint, each by its own code", async () => {
    const { competitionId, organizer } = await draftCompetition("window-second");
    const bad = await payloadWithWindows(NY, "2026-11-01", [["00:10", "00:50"], ["01:10", "01:50"]]);
    expect((await rpc(competitionId, organizer.gamingMemberId, randomUUID(), bad)).error?.message).toContain(`PLANNING_INVALID: ${AMBIGUOUS}`);
    const skipped = await payloadWithWindows(NY, "2026-03-08", [["00:10", "00:50"], ["02:10", "02:50"]]);
    expect((await rpc(competitionId, organizer.gamingMemberId, randomUUID(), skipped)).error?.message).toContain(`PLANNING_INVALID: ${NONEXISTENT}`);
    expect(await countRows(competitionId)).toBe(0);
  });

  const ACCEPTED: Array<[string, string, string, Array<[string, string]>]> = [
    ["an ordinary date in the SAME transition-observing zone (spring)", NY, "2026-03-09", [["02:30", "04:00"]]],
    ["an ordinary date in the same zone (fall)", NY, "2026-11-02", [["01:30", "03:00"]]],
    ["the times just outside the skipped hour", NY, "2026-03-08", [["01:00", "01:59"], ["03:00", "05:00"]]],
    ["the times just outside the repeated hour", NY, "2026-11-01", [["00:00", "00:59"], ["02:00", "03:00"]]],
    ["the same date and time in a zone WITHOUT that transition (Phoenix)", "America/Phoenix", "2026-03-08", [["02:30", "04:00"]]],
    ["the same date and time in Costa Rica", "America/Costa_Rica", "2026-03-08", [["02:30", "04:00"]]],
    ["the same date and time in Kolkata", "Asia/Kolkata", "2026-11-01", [["01:30", "03:00"]]],
    ["Lord Howe just after its half-hour gap", "Australia/Lord_Howe", "2026-10-04", [["02:30", "04:00"]]],
    ["Lord Howe just after its repeated half hour", "Australia/Lord_Howe", "2026-04-05", [["02:00", "03:00"]]],
  ];

  it.each(ACCEPTED)("accepts %s and stores exactly the times entered", async (_label, zone, date, windows) => {
    const { competitionId, organizer } = await draftCompetition("window-ok");
    const res = await rpc(competitionId, organizer.gamingMemberId, randomUUID(), await payloadWithWindows(zone, date, windows));
    expect(res.error, _label).toBeNull();
    expect(await storedWindows(competitionId)).toEqual(windows.map(([s0, e0]) => ({ plan_date: date, s: s0, e: e0 })).sort((a, b) => (a.s < b.s ? -1 : 1)));
  }, 60000);

  it("keeps the existing window rules: no midnight crossing and no overlap on a transition date, with adjacent windows still allowed", async () => {
    const { competitionId, organizer } = await draftCompetition("window-rules");
    // Both endpoints exist, so only the midnight rule can refuse it; a window that ALSO ends in a skipped hour is refused too (the clock fault is reported first).
    expect((await rpc(competitionId, organizer.gamingMemberId, randomUUID(), await payloadWithWindows(NY, "2026-03-08", [["13:00", "09:00"]]))).error?.message).toContain("WINDOW_CROSSES_MIDNIGHT");
    expect((await rpc(competitionId, organizer.gamingMemberId, randomUUID(), await payloadWithWindows(NY, "2026-03-08", [["22:00", "02:00"]]))).error?.message).toContain("PLANNING_INVALID");
    expect((await rpc(competitionId, organizer.gamingMemberId, randomUUID(), await payloadWithWindows(NY, "2026-03-08", [["09:00", "13:00"], ["12:00", "15:00"]]))).error?.message).toContain("WINDOW_OVERLAP");
    expect((await rpc(competitionId, organizer.gamingMemberId, randomUUID(), await payloadWithWindows(NY, "2026-03-08", [["09:00", "12:00"], ["12:00", "15:00"]]))).error).toBeNull();
  });

  it("introduces no per-window instant or offset: the window table holds a date, an index and two local times, as before", async () => {
    const columns = await rawQuery<{ column_name: string }>("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'competition_planning_windows' order by ordinal_position");
    expect(columns.map((c) => c.column_name)).toEqual(["planning_window_id", "planning_revision_id", "plan_date", "window_index", "start_time", "end_time"]);
  });

  it("the TypeScript and database layers agree on EVERY local time across the 2026 clock changes of sixteen zones (fixed IANA fixtures, 5-minute steps)", async () => {
    const { resolveLocalTime } = await loadPlanning();
    const ZONES = [
      "America/New_York", "America/Chicago", "America/Los_Angeles", "Europe/Madrid", "Europe/London", "Europe/Dublin", "Australia/Sydney", "Australia/Lord_Howe",
      "Pacific/Chatham", "America/St_Johns", "Asia/Kathmandu", "Asia/Tehran", "Asia/Kolkata", "America/Costa_Rica", "America/Phoenix", "Pacific/Auckland",
    ];
    // Independent of planning.ts: the zone's offset at an instant, read straight from Intl.
    const offsetAt = (zone: string, ms: number) => {
      const parts = new Intl.DateTimeFormat("en-US", { timeZone: zone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric" }).formatToParts(new Date(ms));
      const p = (t: string) => Number(parts.find((x) => x.type === t)!.value);
      return Date.UTC(p("year"), p("month") - 1, p("day"), p("hour") % 24, p("minute"), p("second")) - Math.floor(ms / 1000) * 1000;
    };
    const pad = (n: number) => String(n).padStart(2, "0");
    const local = (ms: number) => { const d = new Date(ms); return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`; };
    const summary: Record<string, { ambiguous: number; nonexistent: number }> = {};
    for (const zone of ZONES) {
      // Every day of 2026 on which the offset changes, then every 5 minutes of the day before, the day itself and the day after.
      const changeDays: number[] = [];
      for (let d = Date.UTC(2026, 0, 1); d < Date.UTC(2027, 0, 1); d += 86_400_000) if (offsetAt(zone, d) !== offsetAt(zone, d + 86_400_000)) changeDays.push(d);
      const points: string[] = [];
      for (const day0 of changeDays) for (let m = day0 - 86_400_000; m < day0 + 3 * 86_400_000; m += 300_000) points.push(local(m));
      // Fixed-offset zones have no change day: still sweep one ordinary week so "ok" is exercised everywhere.
      if (changeDays.length === 0) for (let m = Date.UTC(2026, 2, 6); m < Date.UTC(2026, 2, 13); m += 300_000) points.push(local(m));
      const unique = [...new Set(points)];
      const db = await rawQuery<{ local: string; kind: string }>(
        "select to_char(p, 'YYYY-MM-DD\"T\"HH24:MI') as local, competition_planning_local_time_kind(p, $2) as kind from unnest($1::timestamp[]) as p", [unique.map((x) => x.replace("T", " ")), zone]);
      expect(db.length, zone).toBe(unique.length);
      const disagreements = db.filter((row) => resolveLocalTime(row.local, zone).kind !== row.kind).slice(0, 5);
      expect(disagreements.map((d) => `${zone} ${d.local}: database ${d.kind}, application ${resolveLocalTime(d.local, zone).kind}`), zone).toEqual([]);
      summary[zone] = { ambiguous: db.filter((r) => r.kind === "ambiguous").length, nonexistent: db.filter((r) => r.kind === "nonexistent").length };
    }
    // The comparison is not vacuous: zones with clock changes have skipped and repeated times; zones without them have none.
    expect(summary["America/New_York"]).toEqual({ ambiguous: 12, nonexistent: 12 });
    expect(summary["Australia/Lord_Howe"].ambiguous).toBe(6);
    expect(summary["Australia/Lord_Howe"].nonexistent).toBe(6);
    for (const fixed of ["Asia/Kolkata", "America/Costa_Rica", "America/Phoenix", "Asia/Tehran", "Asia/Kathmandu"]) expect(summary[fixed], fixed).toEqual({ ambiguous: 0, nonexistent: 0 });
  }, 280000);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// [routes] the real handlers with real user tokens
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("[routes] the planning routes, with real tokens against the real database", () => {
  it("20/26/27. the organizer saves, replays and reads their draft; the responses carry no internal identifier and are uncacheable", async () => {
    const { competitionId, organizer } = await draftCompetition("routes");
    const route = await loadPlanningRoute();
    const token = await tokenFor(organizer);
    const intentId = randomUUID();
    const body = { intentId, plan: rawPlan() };

    const empty = await route.GET(request(planningUrl(competitionId), "GET", token), ctx(competitionId));
    expect(empty.status).toBe(200);                                   // SSS-004A: the initial planning state is a success, not a not-found
    expect(empty.headers.get("cache-control")).toMatch(/no-store/);
    const emptyJson = await empty.json();
    expect(Object.keys(emptyJson).sort()).toEqual(["context", "revision"]);
    expect(emptyJson.revision).toBeNull();
    expect(emptyJson.context.formatKey).toBe("SOCCER_5V5");

    const created = await route.POST(request(planningUrl(competitionId), "POST", token, body), ctx(competitionId));
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toMatch(/no-store/);
    const createdJson = await created.json();
    expect(createdJson).toMatchObject({ alreadySaved: false, isCurrent: true });
    expect(createdJson.revision.revisionNumber).toBe(1);
    expect(createdJson.revision.roster).toEqual({ minimum: 5, maximum: 8 });

    const replay = await route.POST(request(planningUrl(competitionId), "POST", token, body), ctx(competitionId));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ alreadySaved: true });

    const mismatch = await route.POST(request(planningUrl(competitionId), "POST", token, { intentId, plan: rawPlan({ venue: { ...rawPlan().venue, name: "Different" } }) }), ctx(competitionId));
    expect(mismatch.status).toBe(409);

    const read = await route.GET(request(planningUrl(competitionId), "GET", token), ctx(competitionId));
    expect(read.status).toBe(200);
    const readText = JSON.stringify(await read.json());
    for (const forbidden of [competitionId, organizer.gamingMemberId, organizer.authUserId, "planning_revision_id", "planningRevisionId", "authoredBy", "authored_by"]) expect(readText).not.toContain(forbidden);
    expect(await countRows(competitionId)).toBe(1);
  }, 120000);

  it("21/22/23/24/30. every other caller gets the same uniform not-found on read and no write: unrelated organizer, scorekeeper, registrant, applicant, former host, signed-out", async () => {
    const route = await loadPlanningRoute();
    const { competitionId, organizer } = await draftCompetition("routes-denied");
    await compRepo.savePlanningRevision(competitionId, organizer.gamingMemberId, randomUUID(), await validPlan());
    const stranger = await makeOperator("Routes Stranger");
    const registrant = await newPerson("Routes Registrant");
    const bracket = await publishedBracket("routes-scorer");
    const scorekeeper = await newPerson("Routes Scorekeeper");
    await appointScorekeeper(compRepo, bracket.fixtureId, bracket.organizer.gamingMemberId, scorekeeper.gamingMemberId);
    const pilot = await hostPilot("routes-host");
    await compRepo.savePlanningRevision(pilot.competitionId, pilot.host.gamingMemberId, randomUUID(), await validPlan());
    await pilot.revoke();

    const bodies = new Set<string>();
    const attempts: Array<[string, string, string]> = [
      ["unrelated organizer", competitionId, await tokenFor(stranger)], ["registrant", competitionId, await tokenFor(registrant)],
      ["scorekeeper", competitionId, await tokenFor(scorekeeper)], ["scorekeeper on their own competition", bracket.competitionId, await tokenFor(scorekeeper)],
      ["former host", pilot.competitionId, await tokenFor(pilot.host)], ["unknown competition", randomUUID(), await tokenFor(stranger)],
    ];
    for (const [label, id, token] of attempts) {
      const read = await route.GET(request(planningUrl(id), "GET", token), ctx(id));
      expect(read.status, label).toBe(404);
      bodies.add(JSON.stringify(await read.json()));
      const write = await route.POST(request(planningUrl(id), "POST", token, { intentId: randomUUID(), plan: rawPlan({ venue: { ...rawPlan().venue, name: `Intruder ${label}` } }) }), ctx(id));
      expect([403, 404, 409], label).toContain(write.status);
    }
    expect(bodies.size).toBe(1);
    const unauthenticated = await route.GET(new Request(planningUrl(competitionId)), ctx(competitionId));
    expect(unauthenticated.status).toBe(401);
    expect(await countRows(competitionId)).toBe(1);
    expect(await countRows(bracket.competitionId)).toBe(0);
    expect(await countRows(pilot.competitionId)).toBe(1);
  }, 240000);

  it("25. a competition that left DRAFT answers a save with 409 and its saved plan stays readable", async () => {
    const route = await loadPlanningRoute();
    const { competitionId, organizer } = await draftCompetition("routes-state");
    const token = await tokenFor(organizer);
    await route.POST(request(planningUrl(competitionId), "POST", token, { intentId: randomUUID(), plan: rawPlan() }), ctx(competitionId));
    await openTeamRegistration(compRepo, competitionId, organizer.gamingMemberId);
    const refused = await route.POST(request(planningUrl(competitionId), "POST", token, { intentId: randomUUID(), plan: rawPlan() }), ctx(competitionId));
    expect(refused.status).toBe(409);
    const read = await route.GET(request(planningUrl(competitionId), "GET", token), ctx(competitionId));
    expect(read.status).toBe(200);
  }, 120000);
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// [availability] creation stays 5v5-only; discovery is untouched
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("[availability] planning does not make any other format creatable, selectable or discoverable", () => {
  const NON_5V5 = ["SOCCER_6V6", "SOCCER_7V7", "SOCCER_8V8"] as const;

  it("31. every creation path still accepts only 5v5: the general route, the creation RPC, and the approved host's one pilot", async () => {
    const operator = await makeOperator("Availability Operator");
    const token = await tokenFor(operator);
    for (const key of NON_5V5) {
      const res = await generalCreateRoute(request(`${COMP}`, "POST", token, { name: `Refused ${key} ${RUN}`, activityKey: key }));
      expect(res.status, key).toBe(400);
      await expect(createCompetition(compRepo, operator.gamingMemberId, `RPC ${key} ${RUN}`, key)).rejects.toBeInstanceOf(UnsupportedActivityKeyError);
    }
    const ok = await generalCreateRoute(request(`${COMP}`, "POST", token, { name: `Allowed ${RUN}`, activityKey: "SOCCER_5V5" }));
    expect(ok.status).toBe(201);
    const pilot = await hostPilot("availability-host");
    const [row] = await rawQuery("select activity_key from competitions where competition_id = $1", [pilot.competitionId]);
    expect(row.activity_key).toBe("SOCCER_5V5");
    const { data } = await service.from("competitions").select("activity_key").eq("organizer_gaming_member_id", operator.gamingMemberId);
    expect(data).toEqual([{ activity_key: "SOCCER_5V5" }]);
  }, 180000);

  it("33. no approved-format capability exists: no table, column or function carries one", async () => {
    const hits = await rawQuery<{ name: string }>(
      `select table_name || '.' || column_name as name from information_schema.columns where table_schema = 'public' and (column_name ~* 'approved.*format|format.*capab|capab.*format')
       union all select tablename from pg_tables where schemaname = 'public' and tablename ~* 'approved.*format|format.*capab|capab.*format'
       union all select proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and proname ~* 'approved.*format|format.*capab|capab.*format'`);
    expect(hits).toEqual([]);
  });

  it("the format registry is exactly as the foundation left it: four rows, and no one can write them", async () => {
    const rows = await rawQuery("select format_key, players_on_field, roster_default_minimum, roster_default_maximum, minutes_per_half from competition_format_rules order by format_key");
    expect(rows).toEqual([
      { format_key: "SOCCER_5V5", players_on_field: 5, roster_default_minimum: 5, roster_default_maximum: 8, minutes_per_half: 10 },
      { format_key: "SOCCER_6V6", players_on_field: 6, roster_default_minimum: 6, roster_default_maximum: 10, minutes_per_half: 12 },
      { format_key: "SOCCER_7V7", players_on_field: 7, roster_default_minimum: 7, roster_default_maximum: 12, minutes_per_half: 15 },
      { format_key: "SOCCER_8V8", players_on_field: 8, roster_default_minimum: 8, roster_default_maximum: 14, minutes_per_half: 15 },
    ]);
    const [{ has }] = await rawQuery<{ has: boolean }>("select has_table_privilege('service_role', 'public.competition_format_rules', 'INSERT') or has_table_privilege('service_role', 'public.competition_format_rules', 'UPDATE') as has");
    expect(has).toBe(false);
  });

  it("34/37. discovery and the organizer-access source carry no planning: the administrative list answers exactly what it did, with nothing about the plan", async () => {
    const { competitionId, organizer } = await draftCompetition("discovery");
    const token = await tokenFor(organizer);
    const before = await administrationRoute(request(`${COMP}/administration`, "GET", token));
    expect(before.status).toBe(200);
    const beforeJson = await before.json();
    await compRepo.savePlanningRevision(competitionId, organizer.gamingMemberId, randomUUID(), await validPlan({ venue: { ...rawPlan().venue, name: `Venue sentinel ${RUN}` } }));
    const after = await administrationRoute(request(`${COMP}/administration`, "GET", token));
    expect(await after.json()).toEqual(beforeJson);
    expect(JSON.stringify(beforeJson)).not.toMatch(/planning|venue|sentinel/i);
    expect((beforeJson.competitions as Array<{ competitionId: string; access: string }>).find((c) => c.competitionId === competitionId)?.access).toBe("ORGANIZER");
  }, 120000);
});
