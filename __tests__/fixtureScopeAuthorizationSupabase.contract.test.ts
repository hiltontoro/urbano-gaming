import { randomUUID } from "node:crypto";

import { loadEnv } from "vite";
import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { SupabaseCompetitionsRepository } from "../lib/gaming/competitions/db/supabaseCompetitionsRepository";
import { SupabaseHostRepository } from "../lib/gaming/host/db/supabaseHostRepository";
import { SupabaseGamingRepository } from "../lib/gaming/db/supabaseGamingRepository";
import { submitHostApplication } from "../lib/gaming/host/submitHostApplication";
import { decideHostApplication } from "../lib/gaming/host/decideHostApplication";
import { revokeHostCapability } from "../lib/gaming/host/revokeHostCapability";
import { createHostCompetition } from "../lib/gaming/host/createHostCompetition";
import { createCompetition } from "../lib/gaming/competitions/createCompetition";
import { openTeamRegistration } from "../lib/gaming/competitions/openTeamRegistration";
import { closeTeamRegistration } from "../lib/gaming/competitions/closeTeamRegistration";
import { addCompetitionTeam } from "../lib/gaming/competitions/addCompetitionTeam";
import { publishCompetition } from "../lib/gaming/competitions/publishCompetition";
import { registerForCompetition } from "../lib/gaming/competitions/registerForCompetition";
import { requestJoinTeam } from "../lib/gaming/competitions/requestJoinTeam";
import { decideJoinRequest } from "../lib/gaming/competitions/decideJoinRequest";
import { declareRoster } from "../lib/gaming/competitions/declareRoster";
import { appointScorekeeper } from "../lib/gaming/competitions/appointScorekeeper";
import { submitFixtureEvidence } from "../lib/gaming/competitions/submitFixtureEvidence";
import {
  CompetitionAccessDeniedError,
  CompetitionCancelledError,
  FixtureNotInEvidencePhaseError,
  FixtureTeamScopeError,
  HostAccessRevokedError,
  NotTeamCaptainError,
} from "../lib/gaming/competitions/types";
import type { GoalEventInput, ParticipationAttestationInput } from "../lib/gaming/competitions/types";
import { statusForCompetitionsError } from "../lib/gaming/competitions/httpAuth";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";

/**
 * UG-CR-GATE-089 — Fixture-scope and scorekeeper authorization hardening, against real local Postgres.
 *
 * Two defects reported in UG-CR-RPT-088 are proven closed here:
 *  A. declare_competition_roster_atomically accepted a team that was not part of the fixture;
 *  B. submit_competition_fixture_evidence_atomically skipped its denial when no scorekeeper was appointed.
 *
 * Every claim is tied to an explicit inventory, read from the catalog rather than remembered: the functions that can
 * write roster revisions and official evidence, each with every overload. Every new check also has a negative
 * control: it is removed inside a rolled-back transaction and the same scenario is shown to succeed, so the test
 * above it cannot pass vacuously.
 *
 * Host rows and HOST_* audit events are undeletable by design, so this file cannot clean up after itself; every
 * identity it creates is unique and every assertion is scoped to rows it created. A database reset restores a clean
 * state. A Governance grant is held only for the duration of each reviewer call.
 */

const env = loadEnv("development", process.cwd(), "");
const supabaseUrl = env.SUPABASE_URL;
requireLocalSupabase(supabaseUrl);
const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAnonKey = env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey || !supabaseAnonKey) {
  throw new Error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are required for contract tests.");
}

// Raw pg holds a lock across statements and runs rolled-back negative controls. The URL is supplied explicitly,
// never read from .env.local, and must be a loopback Postgres URL.
const supabaseDbUrl = process.env.COMPETITIONS_LOCAL_DB_URL ?? "";
if (!/^postgresql:\/\/[^@]+@(127\.0\.0\.1|localhost|\[::1\]):\d+\//.test(supabaseDbUrl)) {
  throw new Error("COMPETITIONS_LOCAL_DB_URL must be set to a loopback Postgres URL for fixture-scope contract tests.");
}

const compRepo = new SupabaseCompetitionsRepository(supabaseUrl, supabaseServiceRoleKey);
const hostRepo = new SupabaseHostRepository(supabaseUrl, supabaseServiceRoleKey);
const gamingRepo = new SupabaseGamingRepository(supabaseUrl, supabaseServiceRoleKey);
const serviceClient = createClient(supabaseUrl, supabaseServiceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

const RUN = randomUUID().slice(0, 8);
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

interface Member { authUserId: string; gamingMemberId: string }
const createdAuthUserIds: string[] = [];
const operationalMemberIds: string[] = [];
let reviewer: Member;
let counter = 0;

async function createMember(displayName: string): Promise<Member> {
  const email = `fixture-scope-${RUN}-${counter++}-${randomUUID().slice(0, 6)}@example.com`;
  const { data, error } = await serviceClient.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("Failed to create test auth user.");
  createdAuthUserIds.push(data.user.id);
  const member = await gamingRepo.createGamingMember(data.user.id, displayName);
  return { authUserId: data.user.id, gamingMemberId: member.gamingMemberId };
}

async function grantOperational(memberId: string): Promise<void> {
  const { error } = await serviceClient.from("authority_grants").insert({ gaming_member_id: memberId, authority_class: "OPERATIONAL" });
  if (error) throw error;
  operationalMemberIds.push(memberId);
}

async function withGovernance<T>(fn: () => Promise<T>): Promise<T> {
  const { error } = await serviceClient.from("authority_grants").insert({ gaming_member_id: reviewer.gamingMemberId, authority_class: "PRODUCT_GOVERNANCE" });
  if (error) throw error;
  try {
    return await fn();
  } finally {
    await serviceClient.from("authority_grants").delete().eq("gaming_member_id", reviewer.gamingMemberId).eq("authority_class", "PRODUCT_GOVERNANCE");
  }
}

async function connectRaw(): Promise<Client> {
  const client = new Client({ connectionString: supabaseDbUrl, statement_timeout: 20000 });
  await client.connect();
  return client;
}

async function expectRejection<T extends Error>(promise: Promise<unknown>, ErrorClass: new (...args: any[]) => T): Promise<T> {
  const outcome = await promise.then(() => null, (e: unknown) => e);
  expect(outcome, `expected a ${ErrorClass.name}, but the call succeeded`).not.toBeNull();
  expect(outcome).toBeInstanceOf(ErrorClass);
  return outcome as T;
}

afterAll(async () => {
  if (operationalMemberIds.length > 0) await serviceClient.from("authority_grants").delete().in("gaming_member_id", operationalMemberIds);
  await serviceClient.from("authority_grants").delete().eq("gaming_member_id", reviewer.gamingMemberId);
  for (const id of createdAuthUserIds) await serviceClient.auth.admin.deleteUser(id); // an error object (not thrown) when history references the member
}, 120000);

// -----------------------------------------------------------------------------------------------------------------
// Scaffolding: a published bracket, with approved members and declared rosters where a test needs them
// -----------------------------------------------------------------------------------------------------------------

// ---------------------------------------------------------------------------------------------------------------------------------------------
// UG-CR-GATE-SSS-007 fixtures. Opening team registration now needs a usable plan (a saved Organizer Planning revision whose deadline is still ahead), and the
// freeze (CLOSE_TEAM_REGISTRATION) needs that deadline to have passed and every roster to be within the plan's bounds. These helpers give a competition a REAL
// plan through the real save operation and — only when a flow needs "the deadline has passed" — record a LATER revision as the database owner (a service-side
// fixture: the save operation itself needs a DRAFT) whose deadline is the first whole second after the competition's newest registration-related row, so every
// row already written is stamped before it. Rosters are built through the real operations (register, ask to join, the captain approves), all BEFORE the
// freeze: afterwards nobody can register, ask to join or be approved. Nothing here waits for a real deadline.
// ---------------------------------------------------------------------------------------------------------------------------------------------
const FIXTURE_DAY = 24 * 3600_000;
const COSTA_RICA_OFFSET_MS = -6 * 3600_000; // America/Costa_Rica has no daylight saving: always UTC-06:00

async function saveFixturePlan(competitionId: string, organizerId: string, deadlineInMs = 30 * FIXTURE_DAY) {
  const { parsePlanningPlan } = await import("../lib/gaming/competitions/planning");
  const deadlineMs = Date.now() + deadlineInMs;
  const local = (ms: number) => new Date(ms + COSTA_RICA_OFFSET_MS).toISOString();
  const plan = parsePlanningPlan({
    venue: { name: "Cancha Contract", locationDescription: "Calle 5, San Jose, behind the central market", timeZone: "America/Costa_Rica", simultaneousMatchCapacity: 1, restrictionNotes: "" },
    pitches: [{ label: "A", usable: true, supportedFormats: ["SOCCER_5V5"], restrictionNotes: "" }],
    dates: [{ date: local(deadlineMs + 3 * FIXTURE_DAY).slice(0, 10), windows: [{ start: "09:00", end: "13:00" }] }],
    roster: { minimum: 5, maximum: 8 },
    registrationDeadline: { local: local(deadlineMs).slice(0, 16), timeZone: "America/Costa_Rica" },
    rules: { version: "draft-1", snapshot: "Draft registration rules, version one." },
  }, "SOCCER_5V5");
  return compRepo.savePlanningRevision(competitionId, organizerId, randomUUID(), plan);
}

async function passDeadlineFixture(competitionId: string): Promise<void> {
  const db = new Client({ connectionString: supabaseDbUrl, statement_timeout: 30000 });
  await db.connect();
  try {
    const latest = (await db.query(
      `select greatest(
         coalesce((select max(registered_at) from competition_registrations where competition_id = $1), 'epoch'),
         coalesce((select max(created_at) from competition_teams where competition_id = $1), 'epoch'),
         coalesce((select max(created_at) from competition_join_requests where competition_id = $1), 'epoch'),
         coalesce((select max(approved_at) from competition_team_memberships where competition_id = $1), 'epoch'),
         coalesce((select max(created_at) from competition_planning_revisions where competition_id = $1), 'epoch')) as latest`, [competitionId])).rows[0].latest as Date;
    const deadline = new Date((Math.floor(latest.getTime() / 1000) + 1) * 1000);
    const wait = deadline.getTime() - Date.now() + 60;
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    await db.query("begin");
    const cur = (await db.query("select * from competition_planning_revisions where competition_id = $1 order by revision_number desc limit 1", [competitionId])).rows[0];
    const next = (await db.query(
      `insert into competition_planning_revisions (competition_id, format_key, revision_number, supersedes_revision_id, authored_by_gaming_member_id, intent_id, payload_digest,
         venue_name, venue_location_description, venue_time_zone, simultaneous_match_capacity, venue_restriction_notes, roster_minimum, roster_maximum,
         registration_deadline_local, registration_deadline_time_zone, registration_deadline_utc_offset_minutes, registration_deadline_utc, rules_version, rules_snapshot, rules_snapshot_digest)
       values ($1,$2,$3,$4,$5,gen_random_uuid(),$6,$7,$8,$9,$10,$11,$12,$13, ($14::timestamptz at time zone $15), $15, $16, $14::timestamptz, $17,$18,$19) returning planning_revision_id`,
      [competitionId, cur.format_key, cur.revision_number + 1, cur.planning_revision_id, cur.authored_by_gaming_member_id, cur.payload_digest, cur.venue_name, cur.venue_location_description,
        cur.venue_time_zone, cur.simultaneous_match_capacity, cur.venue_restriction_notes, cur.roster_minimum, cur.roster_maximum, deadline.toISOString(), cur.registration_deadline_time_zone,
        cur.registration_deadline_utc_offset_minutes, cur.rules_version, cur.rules_snapshot, cur.rules_snapshot_digest])).rows[0].planning_revision_id;
    await db.query("insert into competition_planning_pitches (planning_revision_id, position, label, is_usable, restriction_notes) select $2::uuid, position, label, is_usable, restriction_notes from competition_planning_pitches where planning_revision_id = $1::uuid", [cur.planning_revision_id, next]);
    await db.query(
      `insert into competition_planning_pitch_formats (planning_pitch_id, format_key)
       select np.planning_pitch_id, f.format_key from competition_planning_pitches op join competition_planning_pitch_formats f on f.planning_pitch_id = op.planning_pitch_id
         join competition_planning_pitches np on np.planning_revision_id = $2::uuid and np.position = op.position where op.planning_revision_id = $1::uuid`, [cur.planning_revision_id, next]);
    await db.query("insert into competition_planning_dates (planning_revision_id, plan_date, position) select $2::uuid, plan_date, position from competition_planning_dates where planning_revision_id = $1::uuid", [cur.planning_revision_id, next]);
    await db.query("insert into competition_planning_windows (planning_revision_id, plan_date, window_index, start_time, end_time) select $2::uuid, plan_date, window_index, start_time, end_time from competition_planning_windows where planning_revision_id = $1::uuid", [cur.planning_revision_id, next]);
    await db.query("commit");
  } finally {
    await db.end().catch(() => undefined);
  }
}

const TEAM_ROSTER_SIZE = 5; // the five-a-side roster minimum the fixture plan configures
const ROSTER_POOL: Member[] = []; // shared people: a member belongs to one team per competition, so the same twenty fill the rosters of every bracket this file builds
async function ensureRosterPool(): Promise<void> {
  while (ROSTER_POOL.length < 4 * TEAM_ROSTER_SIZE) {
    const base = ROSTER_POOL.length;
    ROSTER_POOL.push(...(await Promise.all(Array.from({ length: 5 }, (_, i) => createMember(`Pool Player ${base + i}`)))));
  }
}

/** Each team's roster, built through the real operations while registration is still open. Returns the members approved on each team, in order. */
async function buildRosters(competitionId: string, teams: Array<{ competitionTeamId: string; captainId: string }>): Promise<string[][]> {
  await ensureRosterPool();
  return Promise.all(teams.map(async (team, t) => {
    const members: string[] = [];
    for (let k = 0; k < TEAM_ROSTER_SIZE; k++) {
      const person = ROSTER_POOL[t * TEAM_ROSTER_SIZE + k];
      await registerForCompetition(compRepo, competitionId, person.gamingMemberId, true);
      const request = await requestJoinTeam(compRepo, competitionId, team.competitionTeamId, person.gamingMemberId);
      await decideJoinRequest(compRepo, request.competitionJoinRequestId, team.captainId, "APPROVE", false);
      members.push(person.gamingMemberId);
    }
    return members;
  }));
}

/** The next member of a team's FROZEN roster (wrapping around): joining is a pre-freeze operation, so a flow that needs "a member approved on this team" afterwards takes one the freeze recorded. */
function nextFrozenMember(rosters: string[][], cursor: number[], teamIndex: number): string {
  const roster = rosters[teamIndex];
  return roster[cursor[teamIndex]++ % roster.length];
}

interface Team { competitionTeamId: string; captainId: string }
interface Ctx {
  competitionId: string;
  organizerId: string;
  teams: Team[];
  sf1: string; // team 0 vs team 1
  sf2: string; // team 2 vs team 3
  final: string; // slots start empty
  rosters: string[][]; // the members each team's frozen roster holds (built before the freeze)
  cursor: number[];
}

async function publishBracket(competitionId: string, organizerId: string, label: string, captainOverride?: string): Promise<Ctx> {
  const teams: Team[] = [];
  for (let i = 0; i < 4; i++) {
    const captainId = i === 0 && captainOverride ? captainOverride : (await createMember(`${label} Captain ${i}`)).gamingMemberId;
    const team = await addCompetitionTeam(compRepo, competitionId, organizerId, `${label} Team ${i} ${RUN}`, captainId);
    teams.push({ competitionTeamId: team.competitionTeamId, captainId });
  }
  // UG-CR-GATE-SSS-007: closing is the FREEZE — the rosters are built first, the deadline passes, and nobody can join afterwards.
  const rosters = await buildRosters(competitionId, teams);
  await passDeadlineFixture(competitionId);
  await closeTeamRegistration(compRepo, competitionId, organizerId);
  const published = await publishCompetition(
    compRepo, competitionId, organizerId,
    teams[0].competitionTeamId, teams[1].competitionTeamId, teams[2].competitionTeamId, teams[3].competitionTeamId,
    iso(3600_000), iso(7200_000), iso(10800_000)
  );
  return { competitionId, organizerId, teams, sf1: published.semifinal1FixtureId, sf2: published.semifinal2FixtureId, final: published.finalFixtureId, rosters, cursor: [0, 0, 0, 0] };
}

async function buildInternal(label: string): Promise<Ctx> {
  const operator = await createMember(`${label} Operator`);
  await grantOperational(operator.gamingMemberId);
  const created = await createCompetition(compRepo, operator.gamingMemberId, `Scope ${label} ${RUN}`, "SOCCER_5V5");
  await saveFixturePlan(created.competitionId, operator.gamingMemberId);
  await openTeamRegistration(compRepo, created.competitionId, operator.gamingMemberId);
  return publishBracket(created.competitionId, operator.gamingMemberId, label);
}

/** A registered member who asked to join the team and was approved by its captain. */
async function memberOnTeam(ctx: Ctx, teamIndex: number, _label: string): Promise<string> {
  return nextFrozenMember(ctx.rosters, ctx.cursor, teamIndex);
}

async function membersOnTeam(ctx: Ctx, teamIndex: number, n: number, label: string): Promise<string[]> {
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(await memberOnTeam(ctx, teamIndex, `${label} P${i}`));
  return out;
}

interface Ready { a: string[]; b: string[]; fixtureId: string; teamA: Team; teamB: Team }

/** Five approved members per side and both rosters declared: the fixture is in its evidence phase. */
async function readyFixture(ctx: Ctx, which: "sf1" | "sf2", label: string): Promise<Ready> {
  const [ia, ib] = which === "sf1" ? [0, 1] : [2, 3];
  const a = await membersOnTeam(ctx, ia, 5, `${label}-A`);
  const b = await membersOnTeam(ctx, ib, 5, `${label}-B`);
  const fixtureId = ctx[which];
  const first = await declareRoster(compRepo, fixtureId, ctx.teams[ia].competitionTeamId, ctx.teams[ia].captainId, false, null, a);
  expect(first.fixtureState).toBe("SCHEDULED");
  const second = await declareRoster(compRepo, fixtureId, ctx.teams[ib].competitionTeamId, ctx.teams[ib].captainId, false, null, b);
  expect(second.fixtureState).toBe("ROSTER_DECLARED");
  return { a, b, fixtureId, teamA: ctx.teams[ia], teamB: ctx.teams[ib] };
}

function validEvidence(r: Ready): { goals: GoalEventInput[]; attestations: ParticipationAttestationInput[] } {
  return {
    goals: [{ scorerGamingMemberId: r.a[0], competitionTeamId: r.teamA.competitionTeamId }, { scorerGamingMemberId: r.a[1], competitionTeamId: r.teamA.competitionTeamId }],
    attestations: [...r.a, ...r.b].map((gamingMemberId) => ({ gamingMemberId, actuallyParticipated: true })),
  };
}

async function approvedHost(label: string) {
  const member = await createMember(`Host ${label}`);
  const application = await submitHostApplication(hostRepo, member.gamingMemberId, {
    venueName: `Scope Venue ${label} ${RUN}`, cityArea: "Fictional Heights", playingFields: 1,
    venueDescription: "A fictional venue used only by the fixture-scope contract suite for local testing.",
    expectedWindow: "soon", expectedTeamCount: 4, confirmAllAdults: true, confirmIndependentScorekeepers: true, confirmPilotExclusions: true,
  });
  await withGovernance(() => decideHostApplication(hostRepo, reviewer.gamingMemberId, application.publicCode, "APPROVE", null));
  return { member, code: application.publicCode };
}

/** The RPT-088 attacker: an approved host who is captain of a team in their OWN pilot, with an approved teammate they control. */
async function buildHostPilot(label: string) {
  const { member: host, code } = await approvedHost(label);
  const pilot = await createHostCompetition(hostRepo, host.gamingMemberId, `Scope Pilot ${label} ${RUN}`);
  await saveFixturePlan(pilot.competitionId, host.gamingMemberId);
  await openTeamRegistration(compRepo, pilot.competitionId, host.gamingMemberId);
  const ctx = await publishBracket(pilot.competitionId, host.gamingMemberId, label, host.gamingMemberId);
  const teammate = await memberOnTeam(ctx, 0, `${label} Teammate`);
  return { host, code, ctx, hostTeam: ctx.teams[0], teammate };
}

const rosterRows = async (fixtureId: string, teamId?: string) => {
  let q = serviceClient.from("competition_roster_revisions").select("competition_roster_revision_id").eq("competition_fixture_id", fixtureId);
  if (teamId) q = q.eq("competition_team_id", teamId);
  const { data, error } = await q;
  if (error) throw error;
  return data?.length ?? 0;
};

async function evidenceFootprint(fixtureId: string) {
  const count = async (table: string, col = "competition_fixture_id") => {
    const { count: n, error } = await serviceClient.from(table).select("*", { count: "exact", head: true }).eq(col, fixtureId);
    if (error) throw error;
    return n ?? 0;
  };
  const { data: fixture } = await serviceClient.from("competition_fixtures").select("state").eq("competition_fixture_id", fixtureId).single();
  return {
    evidence: await count("competition_fixture_evidence"),
    goals: await count("soccer_goal_events"),
    assists: await count("soccer_assist_events"),
    attestations: await count("competition_participation_attestations"),
    shootouts: await count("soccer_penalty_shootouts"),
    audit: await count("admin_audit_events", "target_id"),
    state: fixture!.state as string,
  };
}

let ctxX: Ctx;
let ctxY: Ctx;
let readySf1: Ready;
let readySf2: Ready;
let scorekeeperSf1: string;
let scorekeeperSf2: string;
let ready = false;

async function ensureContexts() {
  if (ready) return;
  reviewer = reviewer ?? (await createMember("Rita Reviewer"));
  ctxX = await buildInternal("scope-x");
  ctxY = await buildInternal("scope-y");
  readySf1 = await readyFixture(ctxX, "sf1", "x1");
  readySf2 = await readyFixture(ctxX, "sf2", "x2");
  scorekeeperSf1 = (await createMember("Scorer SF1")).gamingMemberId;
  scorekeeperSf2 = (await createMember("Scorer SF2")).gamingMemberId;
  await appointScorekeeper(compRepo, ctxX.sf1, ctxX.organizerId, scorekeeperSf1);
  await appointScorekeeper(compRepo, ctxX.sf2, ctxX.organizerId, scorekeeperSf2);
  ready = true;
}

// =================================================================================================================
// Inventory: every function and overload that can write roster revisions or official evidence
// =================================================================================================================

describe("inventory: the entrypoints that can write roster revisions and official evidence are exactly the ones this suite covers", () => {
  const ROSTER_WRITERS = ["correct_competition_fixture_atomically", "declare_competition_roster_atomically"];
  const EVIDENCE_WRITERS = ["correct_competition_fixture_atomically", "submit_competition_fixture_evidence_atomically"];

  it("the catalog finds exactly those writers, each with exactly one signature (no overload, no legacy copy)", async () => {
    const db = await connectRaw();
    try {
      const { rows } = await db.query(
        `with fns as materialized (
           select p.oid, p.proname, pg_get_function_identity_arguments(p.oid) as args from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.prokind = 'f')
         select f.proname, f.args,
                pg_get_functiondef(f.oid) ~* 'insert\\s+into\\s+(public\\.)?competition_roster_revisions(_entries)?|update\\s+(public\\.)?competition_roster_revisions' as writes_roster,
                pg_get_functiondef(f.oid) ~* 'insert\\s+into\\s+(public\\.)?competition_fixture_evidence' as writes_evidence
           from fns f order by f.proname`
      );
      const rosterWriters = Array.from(new Set(rows.filter((r) => r.writes_roster).map((r) => r.proname as string))).sort();
      const evidenceWriters = Array.from(new Set(rows.filter((r) => r.writes_evidence).map((r) => r.proname as string))).sort();
      expect(rosterWriters).toEqual(ROSTER_WRITERS);
      expect(evidenceWriters).toEqual(EVIDENCE_WRITERS);
      for (const name of new Set([...ROSTER_WRITERS, ...EVIDENCE_WRITERS])) {
        expect(rows.filter((r) => r.proname === name), `${name} must have exactly one signature`).toHaveLength(1);
      }
      // The table the scope guard protects can only be written by the two functions above and, structurally, by nothing else.
      const { rows: direct } = await db.query(
        `select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.prokind = 'f' and p.proname not in ('declare_competition_roster_atomically', 'correct_competition_fixture_atomically')
            and pg_get_functiondef(p.oid) ~* 'insert\\s+into\\s+(public\\.)?competition_roster_revisions'`
      );
      expect(direct[0].n).toBe(0);
    } finally {
      await db.end();
    }
  }, 30000);

  it("roster declaration: the scope check comes after the fixture is locked and read, before the organizer/captain decision, before every lifecycle check, and before the first write", async () => {
    const db = await connectRaw();
    try {
      const { rows } = await db.query("select pg_get_functiondef('declare_competition_roster_atomically'::regproc) as def");
      const def: string = rows[0].def;
      const at = (needle: string | RegExp) => (typeof needle === "string" ? def.indexOf(needle) : def.search(needle));
      const lock = at("pg_advisory_xact_lock(hashtext('competition_scope:'");
      const load = at("for update;");
      const scope = at("FIXTURE_TEAM_SCOPE_MISMATCH: this team is not part of this fixture' using errcode = 'P0001';\n  end if;\n\n  -- UG-CR-GATE-089");
      const check = at("v_team_competition_id is distinct from v_competition_id");
      const lifecycle = at("FIXTURE_NOT_OPEN_FOR_ROSTER");
      const cancelled = at("COMPETITION_CANCELLED");
      const organizer = at("COMPETITION_ACCESS_DENIED: only the organizer may correct a roster");
      const captain = at("NOT_TEAM_CAPTAIN");
      const firstWrite = at(/insert\s+into\s+competition_roster_revisions|update\s+competition_roster_revisions/i);
      for (const [name, idx] of Object.entries({ lock, load, check, lifecycle, cancelled, organizer, captain, firstWrite })) expect(idx, name).toBeGreaterThan(-1);
      expect(lock).toBeLessThan(load);
      expect(load).toBeLessThan(check);
      expect(check).toBeLessThan(lifecycle);
      expect(check).toBeLessThan(cancelled);
      expect(check).toBeLessThan(organizer);
      expect(check).toBeLessThan(captain);
      expect(check).toBeLessThan(firstWrite);
      expect(scope).toBeGreaterThan(-1);
      // Null-safe by construction: no bare `=`/`<>` comparison of the team against a slot.
      expect(def).toMatch(/p_competition_team_id is distinct from v_team_a_id and p_competition_team_id is distinct from v_team_b_id/);
      expect(def).not.toMatch(/p_competition_team_id\s*(<>|!=)\s*v_team_[ab]_id/);
    } finally {
      await db.end();
    }
  }, 30000);

  it("evidence submission: authorization is the first decision after the fixture is locked and read — before the replay, the cancellation and state checks, and every write — and no NULL comparison can authorize", async () => {
    const db = await connectRaw();
    try {
      const { rows } = await db.query("select pg_get_functiondef('submit_competition_fixture_evidence_atomically'::regproc) as def");
      const def: string = rows[0].def;
      const idx = (s: string) => def.indexOf(s);
      const lock = idx("pg_advisory_xact_lock(hashtext('competition_scope:'");
      const load = idx("for update;");
      const authorization = idx("if v_appointed_scorekeeper is null");
      const host = idx("perform assert_actor_not_revoked_host(");
      const replay = idx("return query select v_existing_evidence_id, v_fixture_state, true;");
      const cancelled = idx("COMPETITION_CANCELLED");
      const phase = idx("FIXTURE_NOT_IN_EVIDENCE_PHASE");
      const firstWrite = def.search(/insert\s+into\s+competition_fixture_evidence/i);
      for (const [name, i] of Object.entries({ lock, load, authorization, host, replay, cancelled, phase, firstWrite })) expect(i, name).toBeGreaterThan(-1);
      expect(lock).toBeLessThan(load);
      expect(load).toBeLessThan(authorization);
      expect(authorization).toBeLessThan(host);
      expect(host).toBeLessThan(replay);
      expect(authorization).toBeLessThan(cancelled);
      expect(authorization).toBeLessThan(phase);
      expect(authorization).toBeLessThan(firstWrite);
      expect(def).not.toMatch(/<>\s*v_appointed_scorekeeper/); // the NULL-unsafe comparison is gone
      expect(def).toMatch(/p_scorekeeper_gaming_member_id is distinct from v_appointed_scorekeeper/);
      expect((def.match(/only this fixture''s appointed scorekeeper may submit evidence/g) ?? []).length).toBe(1);
    } finally {
      await db.end();
    }
  }, 30000);

  it("[NULL-safety] none of the three entrypoints compares its caller to a stored authority with a bare <> or !=: every such comparison is IS DISTINCT FROM", async () => {
    const db = await connectRaw();
    try {
      for (const name of ["declare_competition_roster_atomically", "submit_competition_fixture_evidence_atomically", "correct_competition_fixture_atomically"]) {
        const { rows } = await db.query("select pg_get_functiondef($1::regproc) as def", [name]);
        const def: string = rows[0].def;
        expect(def, `${name}: a bare comparison of the caller to a stored authority`).not.toMatch(/p_\w*gaming_member_id\s*(<>|!=)\s*v_(organizer_id|captain_id|appointed_scorekeeper)\b/);
        expect(def, `${name}: uses IS DISTINCT FROM for the caller`).toMatch(/p_\w*gaming_member_id is distinct from v_(organizer_id|captain_id|appointed_scorekeeper)\b/);
      }
    } finally {
      await db.end();
    }
  }, 30000);

  it("[20] all three corrected functions and the new trigger function keep exact grants, SECURITY DEFINER where already justified, a locked search_path, and service-role-only execution", async () => {
    const db = await connectRaw();
    try {
      for (const [name, definer] of [
        ["declare_competition_roster_atomically", true],
        ["submit_competition_fixture_evidence_atomically", true],
        ["correct_competition_fixture_atomically", true],
        ["competition_roster_revisions_require_fixture_team", false],
      ] as const) {
        const { rows } = await db.query(
          `select p.oid, p.prosecdef, p.proconfig::text as cfg from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1`,
          [name]
        );
        expect(rows, `${name} must have exactly one signature`).toHaveLength(1);
        expect(rows[0].prosecdef, `${name} security mode`).toBe(definer);
        expect(rows[0].cfg, `${name} search_path`).toContain("search_path=public");
        for (const role of ["anon", "authenticated"]) {
          const { rows: x } = await db.query("select has_function_privilege($1, $2::oid, 'EXECUTE') as ok", [role, rows[0].oid]);
          expect(x[0].ok, `${role} must not execute ${name}`).toBe(false);
        }
        const { rows: pub } = await db.query(
          `select count(*)::int as n from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = $1::oid and a.grantee = 0 and a.privilege_type = 'EXECUTE'`,
          [rows[0].oid]
        );
        expect(pub[0].n, `PUBLIC must not execute ${name}`).toBe(0);
        const { rows: svc } = await db.query("select has_function_privilege('service_role', $1::oid, 'EXECUTE') as ok", [rows[0].oid]);
        expect(svc[0].ok, `service_role must execute ${name}`).toBe(true);
      }
      const { rows: trg } = await db.query(
        `select t.tgenabled, pg_get_triggerdef(t.oid) as def from pg_trigger t where t.tgname = 'competition_roster_revisions_fixture_team_scope' and not t.tgisinternal`
      );
      expect(trg).toHaveLength(1);
      expect(trg[0].tgenabled).toBe("O");
      expect(trg[0].def).toMatch(/BEFORE INSERT OR UPDATE OF competition_fixture_id, competition_team_id ON/);
    } finally {
      await db.end();
    }
  }, 30000);

  it("the organizer's documented correction path is a separate, unchanged entrypoint: authority derived from the fixture's own competition, and it only INVALIDATES roster rows (never inserts one)", async () => {
    const db = await connectRaw();
    try {
      const { rows } = await db.query("select pg_get_functiondef('correct_competition_fixture_atomically'::regproc) as def");
      const def: string = rows[0].def;
      expect(def).toContain("COMPETITION_ACCESS_DENIED: only the organizer may correct fixture evidence");
      expect(def).toContain("assert_competition_not_host_revoked(");
      expect(def).not.toMatch(/insert\s+into\s+competition_roster_revisions/i);
      expect(def).toMatch(/update\s+competition_roster_revisions\s+set is_current = false/i);
    } finally {
      await db.end();
    }
  }, 30000);
});

// =================================================================================================================
// Correction A — roster fixture scope
// =================================================================================================================

describe("correction A: a roster is accepted only for a team that is a slot of THIS fixture and belongs to THIS competition", () => {
  it("[1] the captain of Team A declares Team A's roster for a fixture that contains Team A", async () => {
    await ensureContexts();
    const members = await membersOnTeam(ctxY, 0, 2, "y-r1");
    const out = await declareRoster(compRepo, ctxY.sf1, ctxY.teams[0].competitionTeamId, ctxY.teams[0].captainId, false, null, members);
    expect(out.fixtureState).toBe("SCHEDULED");
    expect(await rosterRows(ctxY.sf1, ctxY.teams[0].competitionTeamId)).toBe(1);
  }, 90000);

  it("[2] the captain of Team A cannot declare Team B's roster (Team B is a slot, so the refusal is the captain check)", async () => {
    await ensureContexts();
    const members = await membersOnTeam(ctxY, 1, 1, "y-r2");
    await expectRejection(declareRoster(compRepo, ctxY.sf1, ctxY.teams[1].competitionTeamId, ctxY.teams[0].captainId, false, null, members), NotTeamCaptainError);
    expect(await rosterRows(ctxY.sf1, ctxY.teams[1].competitionTeamId)).toBe(0);
  }, 90000);

  it("[3] the captain of Team A cannot declare their own team's roster for a fixture that does not contain that team (same competition, other semifinal)", async () => {
    await ensureContexts();
    const members = await membersOnTeam(ctxX, 0, 1, "x-r3");
    const err = await expectRejection(declareRoster(compRepo, ctxX.sf2, ctxX.teams[0].competitionTeamId, ctxX.teams[0].captainId, false, null, members), FixtureTeamScopeError);
    expect(statusForCompetitionsError(err)).toBe(403);
    expect(await rosterRows(ctxX.sf2, ctxX.teams[0].competitionTeamId)).toBe(0);
  }, 90000);

  it("[3b] the Final's empty slots can never match: a team that will eventually play there cannot declare for it early", async () => {
    await ensureContexts();
    const members = await membersOnTeam(ctxY, 2, 1, "y-r3b");
    await expectRejection(declareRoster(compRepo, ctxY.final, ctxY.teams[2].competitionTeamId, ctxY.teams[2].captainId, false, null, members), FixtureTeamScopeError);
    expect(await rosterRows(ctxY.final)).toBe(0);
  }, 90000);

  it("[4] an approved host cannot use a host-created team — with the host or an accomplice as captain — to write into another competition", async () => {
    await ensureContexts();
    const { host, ctx: pilot, hostTeam, teammate } = await buildHostPilot("r4");
    const sf1Before = await rosterRows(ctxX.sf1);
    const sf2Before = await rosterRows(ctxX.sf2);
    // Host as captain of their own team; their teammate is an approved member of that team.
    await expectRejection(declareRoster(compRepo, ctxX.sf1, hostTeam.competitionTeamId, host.gamingMemberId, false, null, [teammate]), FixtureTeamScopeError);
    // A team the host created for an accomplice to captain behaves the same.
    const accomplice = (await createMember("Accomplice Captain")).gamingMemberId;
    const extra = await compRepo.addCompetitionTeam(pilot.competitionId, host.gamingMemberId, `Extra ${RUN}`, accomplice, `E${randomUUID().replace(/-/g, "").slice(0, 21)}`).catch(() => null);
    if (extra) await expectRejection(declareRoster(compRepo, ctxX.sf2, extra.competitionTeamId, accomplice, false, null, [accomplice]), FixtureTeamScopeError);
    // And the host acting as an ORGANIZER cannot reach another competition's fixture either.
    await expectRejection(declareRoster(compRepo, ctxX.sf1, hostTeam.competitionTeamId, host.gamingMemberId, true, "Attempt", [teammate]), FixtureTeamScopeError);
    expect(await rosterRows(ctxX.sf1, hostTeam.competitionTeamId)).toBe(0);
    expect(await rosterRows(ctxX.sf1)).toBe(sf1Before);
    expect(await rosterRows(ctxX.sf2)).toBe(sf2Before);
    // The same team still works where it belongs: the host's own fixture.
    const own = await declareRoster(compRepo, pilot.sf1, hostTeam.competitionTeamId, host.gamingMemberId, false, null, [teammate]);
    expect(own.fixtureState).toBe("SCHEDULED");
  }, 240000);

  it("[5] internal OPERATIONAL organizer authority does not bypass fixture/team consistency, and still works for a team that belongs", async () => {
    await ensureContexts();
    // Organizer of X, organizer-branch correction, with a team of ANOTHER competition and with a non-slot team of their own.
    const member = await memberOnTeam(ctxX, 2, "x-r5");
    await expectRejection(declareRoster(compRepo, ctxX.sf1, ctxY.teams[0].competitionTeamId, ctxX.organizerId, true, "Correction", [member]), FixtureTeamScopeError);
    await expectRejection(declareRoster(compRepo, ctxX.sf1, ctxX.teams[2].competitionTeamId, ctxX.organizerId, true, "Correction", [member]), FixtureTeamScopeError);
    expect(await rosterRows(ctxX.sf1, ctxX.teams[2].competitionTeamId)).toBe(0);
    // Compatibility: the organizer's correction of a roster for a team that IS a slot still works.
    const out = await declareRoster(compRepo, ctxX.sf1, readySf1.teamA.competitionTeamId, ctxX.organizerId, true, "Corrected after check-in.", readySf1.a);
    expect(out.competitionRosterRevisionId).toBeTruthy();
  }, 120000);

  it("[6] mismatched competition, fixture and team identifiers all fail with the SAME bounded error, whichever relationship is wrong", async () => {
    await ensureContexts();
    const member = await memberOnTeam(ctxX, 0, "x-r6");
    const cases: Array<[string, () => Promise<unknown>]> = [
      ["a team of another competition", () => declareRoster(compRepo, ctxX.sf1, ctxY.teams[0].competitionTeamId, ctxY.teams[0].captainId, false, null, [member])],
      ["a team of this competition that is not a slot", () => declareRoster(compRepo, ctxX.sf1, ctxX.teams[3].competitionTeamId, ctxX.teams[3].captainId, false, null, [member])],
      ["a team id that exists nowhere", () => declareRoster(compRepo, ctxX.sf1, randomUUID(), ctxX.teams[0].captainId, false, null, [member])],
      ["a fixture of another competition for this competition's team", () => declareRoster(compRepo, ctxY.sf1, ctxX.teams[0].competitionTeamId, ctxX.teams[0].captainId, false, null, [member])],
      ["a fixture id that exists nowhere", () => declareRoster(compRepo, randomUUID(), ctxX.teams[0].competitionTeamId, ctxX.teams[0].captainId, false, null, [member])],
      ["the Final with empty slots", () => declareRoster(compRepo, ctxX.final, ctxX.teams[0].competitionTeamId, ctxX.teams[0].captainId, false, null, [member])],
    ];
    const messages = new Set<string>();
    for (const [label, call] of cases) {
      const err = await expectRejection(call(), FixtureTeamScopeError);
      messages.add(err.message);
      expect(statusForCompetitionsError(err), label).toBe(403);
    }
    expect(messages.size).toBe(1); // one stable message: nothing about what exists
    const [message] = Array.from(messages);
    expect(message).toBe("This team is not part of this fixture.");
    expect(message).not.toMatch(/competition|fixture [0-9a-f]{8}|exist|not found|[0-9a-f]{8}-[0-9a-f]{4}/i);

    // A NULL team id sent straight to the database is the same refusal.
    const { error } = await serviceClient.rpc("declare_competition_roster_atomically", {
      p_competition_fixture_id: ctxX.sf1, p_competition_team_id: null, p_declaring_gaming_member_id: ctxX.teams[0].captainId,
      p_is_organizer_action: false, p_reason: null, p_gaming_member_ids: [member],
    });
    expect(error?.message ?? "").toContain("FIXTURE_TEAM_SCOPE_MISMATCH");
  }, 120000);

  it("[7] a concurrent change of the fixture's slots cannot produce a cross-scope write: the relationship is re-read AFTER the lock, so a stale authorization is refused", async () => {
    await ensureContexts();
    const members = await membersOnTeam(ctxX, 0, 1, "x-r7"); // approved members of team 0
    const [t0, t1] = [ctxX.teams[0], ctxX.teams[1]];
    const holder = await connectRaw();
    const declarer = await connectRaw();
    const observer = await connectRaw();
    try {
      // Scenario 1: the Final starts with Team 0 seated. An in-flight change re-seats it while the declaration waits.
      await observer.query("update competition_fixtures set team_a_competition_team_id = $2, team_b_competition_team_id = null, state = 'SCHEDULED' where competition_fixture_id = $1", [ctxX.final, t0.competitionTeamId]);
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtext('competition_scope:' || $1::text))", [ctxX.competitionId]);
      const { rows: pid } = await declarer.query("select pg_backend_pid() as pid");
      const stale = declarer
        .query("select * from declare_competition_roster_atomically($1, $2, $3, false, null, $4::uuid[])", [ctxX.final, t0.competitionTeamId, t0.captainId, members])
        .then(() => "written", (e: Error) => e.message);
      await waitUntilBlockedOnLock(observer, pid[0].pid);
      await holder.query("update competition_fixtures set team_a_competition_team_id = $2 where competition_fixture_id = $1", [ctxX.final, t1.competitionTeamId]);
      await holder.query("commit");
      expect(await stale).toContain("FIXTURE_TEAM_SCOPE_MISMATCH");
      expect(await rosterRows(ctxX.final, t0.competitionTeamId)).toBe(0);

      // Scenario 2 (the check follows CURRENT state, in both directions): a seat that arrives while the declaration waits is honoured.
      await observer.query("update competition_fixtures set team_a_competition_team_id = null, team_b_competition_team_id = null where competition_fixture_id = $1", [ctxX.final]);
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtext('competition_scope:' || $1::text))", [ctxX.competitionId]);
      const { rows: pid2 } = await declarer.query("select pg_backend_pid() as pid");
      const fresh = declarer
        .query("select * from declare_competition_roster_atomically($1, $2, $3, false, null, $4::uuid[])", [ctxX.final, t0.competitionTeamId, t0.captainId, members])
        .then(() => "written", (e: Error) => e.message);
      await waitUntilBlockedOnLock(observer, pid2[0].pid);
      await holder.query("update competition_fixtures set team_a_competition_team_id = $2 where competition_fixture_id = $1", [ctxX.final, t0.competitionTeamId]);
      await holder.query("commit");
      expect(await fresh).toBe("written");
      expect(await rosterRows(ctxX.final, t0.competitionTeamId)).toBe(1);
    } finally {
      await holder.query("rollback").catch(() => {});
      await observer.query("update competition_fixtures set team_a_competition_team_id = null, team_b_competition_team_id = null where competition_fixture_id = $1", [ctxX.final]).catch(() => {});
      await Promise.all([holder.end(), declarer.end(), observer.end()]);
    }
  }, 120000);

  it("[8] the exact RPT-088 reproduction probe now fails and writes ZERO revision rows (host-captain with an approved teammate, foreign fixture)", async () => {
    await ensureContexts();
    const { host, hostTeam, teammate } = await buildHostPilot("r8");
    const foreignFixture = ctxX.sf2;
    const before = await rosterRows(foreignFixture);
    const err = await expectRejection(declareRoster(compRepo, foreignFixture, hostTeam.competitionTeamId, host.gamingMemberId, false, null, [teammate]), FixtureTeamScopeError);
    expect(statusForCompetitionsError(err)).toBe(403);
    expect(await rosterRows(foreignFixture)).toBe(before);
    expect(await rosterRows(foreignFixture, hostTeam.competitionTeamId)).toBe(0);
  }, 240000);

  it("[table guard] the same relationship is enforced at the table: a direct insert or re-pointing of a roster revision to a foreign team is refused for service_role and for the owner", async () => {
    await ensureContexts();
    const member = ctxX.teams[0].captainId;
    const insertForeign = await serviceClient.from("competition_roster_revisions").insert({
      competition_fixture_id: ctxX.sf2, competition_team_id: ctxX.teams[0].competitionTeamId, declared_by_gaming_member_id: member, is_current: true,
    });
    expect(insertForeign.error?.message ?? "").toContain("FIXTURE_TEAM_SCOPE_MISMATCH");
    const insertAcrossCompetitions = await serviceClient.from("competition_roster_revisions").insert({
      competition_fixture_id: ctxX.sf1, competition_team_id: ctxY.teams[0].competitionTeamId, declared_by_gaming_member_id: member, is_current: true,
    });
    expect(insertAcrossCompetitions.error?.message ?? "").toContain("FIXTURE_TEAM_SCOPE_MISMATCH");
    const db = await connectRaw();
    try {
      const { rows } = await db.query("select competition_roster_revision_id from competition_roster_revisions where competition_fixture_id = $1 limit 1", [ctxX.sf1]);
      expect(rows.length).toBe(1);
      await expect(
        db.query("update competition_roster_revisions set competition_team_id = $2 where competition_roster_revision_id = $1", [rows[0].competition_roster_revision_id, ctxY.teams[0].competitionTeamId])
      ).rejects.toThrow(/FIXTURE_TEAM_SCOPE_MISMATCH/);
      await expect(
        db.query("insert into competition_roster_revisions (competition_fixture_id, competition_team_id, declared_by_gaming_member_id, is_current) values ($1, $2, $3, true)", [ctxX.sf2, ctxX.teams[0].competitionTeamId, member])
      ).rejects.toThrow(/FIXTURE_TEAM_SCOPE_MISMATCH/);
      // is_current maintenance (what the functions do on replacement) is not blocked.
      await db.query("begin");
      await db.query("update competition_roster_revisions set is_current = is_current where competition_roster_revision_id = $1", [rows[0].competition_roster_revision_id]);
      await db.query("rollback");
    } finally {
      await db.end();
    }
    expect(await rosterRows(ctxX.sf2, ctxX.teams[0].competitionTeamId)).toBe(0);
  }, 120000);

  it("[19] revocation still blocks a revoked host's organizer-branch roster correction on their OWN fixture, after the scope check passes", async () => {
    await ensureContexts();
    const { host, code, ctx: pilot, hostTeam, teammate } = await buildHostPilot("r19");
    const active = await declareRoster(compRepo, pilot.sf1, hostTeam.competitionTeamId, host.gamingMemberId, true, "Correction while active.", [teammate]);
    expect(active.competitionRosterRevisionId).toBeTruthy();
    await withGovernance(() => revokeHostCapability(hostRepo, reviewer.gamingMemberId, code, "Fixture-scope suite: revoke."));
    await expectRejection(declareRoster(compRepo, pilot.sf1, hostTeam.competitionTeamId, host.gamingMemberId, true, "Correction after revoke.", [teammate]), HostAccessRevokedError);
  }, 240000);
});

// =================================================================================================================
// Correction B — scorekeeper evidence fails closed
// =================================================================================================================

describe("correction B: only the scorekeeper appointed to THIS fixture may submit official evidence, and nothing else can stand in", () => {
  it("[9] evidence is refused when NO scorekeeper is appointed — even though the fixture is in its evidence phase and the evidence is valid", async () => {
    await ensureContexts();
    const ctx = await buildInternal("e9");
    const r = await readyFixture(ctx, "sf1", "e9");
    const { goals, attestations } = validEvidence(r);
    const stranger = (await createMember("Stranger E9")).gamingMemberId;
    const before = await evidenceFootprint(r.fixtureId);
    expect(before.state).toBe("ROSTER_DECLARED");
    const err = await expectRejection(submitFixtureEvidence(compRepo, r.fixtureId, stranger, 2, 0, goals, [], attestations, null), CompetitionAccessDeniedError);
    expect(statusForCompetitionsError(err)).toBe(403);
    expect(await evidenceFootprint(r.fixtureId)).toEqual(before);
    // The organizer, a captain, a player and a host-like organizer-of-nothing do not substitute for an appointment either.
    for (const who of [ctx.organizerId, r.teamA.captainId, r.teamB.captainId, r.a[0], r.b[0]]) {
      await expectRejection(submitFixtureEvidence(compRepo, r.fixtureId, who, 2, 0, goals, [], attestations, null), CompetitionAccessDeniedError);
    }
    // A NULL caller sent straight to the database is refused at the same boundary.
    const { error } = await serviceClient.rpc("submit_competition_fixture_evidence_atomically", {
      p_competition_fixture_id: r.fixtureId, p_scorekeeper_gaming_member_id: null, p_team_a_score: 2, p_team_b_score: 0,
      p_goal_events: goals, p_assist_events: [], p_participation_attestations: attestations, p_penalty_shootout_winning_team_id: null,
    });
    expect(error?.message ?? "").toContain("COMPETITION_ACCESS_DENIED");
    expect(await evidenceFootprint(r.fixtureId)).toEqual(before);
  }, 240000);

  it("[10, 15] an unrelated member is denied BEFORE any evidence write: zero evidence, goal, assist, attestation, shootout or audit rows, and the fixture state is untouched", async () => {
    await ensureContexts();
    const stranger = (await createMember("Stranger E10")).gamingMemberId;
    const { goals, attestations } = validEvidence(readySf1);
    const before = await evidenceFootprint(readySf1.fixtureId);
    for (let i = 0; i < 3; i++) {
      await expectRejection(submitFixtureEvidence(compRepo, readySf1.fixtureId, stranger, 2, 0, goals, [], attestations, null), CompetitionAccessDeniedError);
    }
    const after = await evidenceFootprint(readySf1.fixtureId);
    expect(after).toEqual(before);
    expect(after.evidence + after.goals + after.assists + after.attestations + after.shootouts + after.audit).toBe(0);
    expect(after.state).toBe("ROSTER_DECLARED");
  }, 120000);

  it("[11] a scorekeeper appointed to ANOTHER fixture — in this competition or in another competition — is denied", async () => {
    await ensureContexts();
    const { goals, attestations } = validEvidence(readySf1);
    // SF2's scorekeeper tries SF1.
    await expectRejection(submitFixtureEvidence(compRepo, readySf1.fixtureId, scorekeeperSf2, 2, 0, goals, [], attestations, null), CompetitionAccessDeniedError);
    // A scorekeeper appointed in a different competition tries SF1.
    const foreignScorer = (await createMember("Foreign Scorer")).gamingMemberId;
    await appointScorekeeper(compRepo, ctxY.sf2, ctxY.organizerId, foreignScorer);
    await expectRejection(submitFixtureEvidence(compRepo, readySf1.fixtureId, foreignScorer, 2, 0, goals, [], attestations, null), CompetitionAccessDeniedError);
    const footprint = await evidenceFootprint(readySf1.fixtureId);
    expect(footprint.evidence + footprint.goals + footprint.attestations).toBe(0);
  }, 120000);

  it("[13] cancelled and invalid states remain enforced for the AUTHORIZED scorekeeper, and an unauthorized caller learns neither", async () => {
    await ensureContexts();
    // Not yet in the evidence phase (a fresh fixture with no rosters): the appointed scorekeeper gets the state error, a stranger gets the authorization error.
    const ctx = await buildInternal("e13");
    const scorer = (await createMember("Scorer E13")).gamingMemberId;
    await appointScorekeeper(compRepo, ctx.sf1, ctx.organizerId, scorer);
    await expectRejection(submitFixtureEvidence(compRepo, ctx.sf1, scorer, 1, 0, [], [], [], null), FixtureNotInEvidencePhaseError);
    const stranger = (await createMember("Stranger E13")).gamingMemberId;
    await expectRejection(submitFixtureEvidence(compRepo, ctx.sf1, stranger, 1, 0, [], [], [], null), CompetitionAccessDeniedError);
    // Cancelled competition: the appointed scorekeeper gets COMPETITION_CANCELLED; a stranger still only sees the authorization error.
    const r = await readyFixture(ctx, "sf2", "e13");
    const scorer2 = (await createMember("Scorer E13b")).gamingMemberId;
    await appointScorekeeper(compRepo, r.fixtureId, ctx.organizerId, scorer2);
    // Cancellation is only offered before publication, so a published competition is put into its cancelled state through the owner connection.
    const db = await connectRaw();
    try {
      await db.query("update competitions set state = 'CANCELLED_WITHOUT_CHAMPION' where competition_id = $1", [ctx.competitionId]);
    } finally {
      await db.end();
    }
    const { goals, attestations } = validEvidence(r);
    await expectRejection(submitFixtureEvidence(compRepo, r.fixtureId, scorer2, 2, 0, goals, [], attestations, null), CompetitionCancelledError);
    await expectRejection(submitFixtureEvidence(compRepo, r.fixtureId, stranger, 2, 0, goals, [], attestations, null), CompetitionAccessDeniedError);
  }, 240000);

  it("[12] the correctly appointed scorekeeper submits valid evidence in the valid state, and an idempotent retry still works for them — but a stranger's replay is refused, not answered", async () => {
    await ensureContexts();
    const { goals, attestations } = validEvidence(readySf2);
    const first = await submitFixtureEvidence(compRepo, readySf2.fixtureId, scorekeeperSf2, 2, 0, goals, [], attestations, null);
    expect(first).toMatchObject({ fixtureState: "EVIDENCE_SUBMITTED", alreadySubmitted: false });
    const footprint = await evidenceFootprint(readySf2.fixtureId);
    expect(footprint).toMatchObject({ evidence: 1, goals: 2, state: "EVIDENCE_SUBMITTED" });
    expect(footprint.attestations).toBe(10);
    const retry = await submitFixtureEvidence(compRepo, readySf2.fixtureId, scorekeeperSf2, 2, 0, goals, [], attestations, null);
    expect(retry).toMatchObject({ alreadySubmitted: true, competitionFixtureEvidenceId: first.competitionFixtureEvidenceId });
    // Replay used to be answered to anyone before authorization; it is now refused.
    const stranger = (await createMember("Stranger E12")).gamingMemberId;
    await expectRejection(submitFixtureEvidence(compRepo, readySf2.fixtureId, stranger, 2, 0, goals, [], attestations, null), CompetitionAccessDeniedError);
    expect(await evidenceFootprint(readySf2.fixtureId)).toEqual(footprint);
  }, 240000);

  it("[14] the exact RPT-088 fail-open probe now fails AT THE AUTHORIZATION BOUNDARY — not at a later lifecycle check — with no appointment, on a fixture that is not yet in its evidence phase", async () => {
    await ensureContexts();
    const ctx = await buildInternal("e14"); // published, no scorekeeper appointed, fixtures SCHEDULED
    const stranger = (await createMember("Stranger E14")).gamingMemberId;
    const { error } = await serviceClient.rpc("submit_competition_fixture_evidence_atomically", {
      p_competition_fixture_id: ctx.sf1, p_scorekeeper_gaming_member_id: stranger, p_team_a_score: 1, p_team_b_score: 0,
      p_goal_events: [], p_assist_events: [], p_participation_attestations: [], p_penalty_shootout_winning_team_id: null,
    });
    expect(error?.message ?? "").toContain("COMPETITION_ACCESS_DENIED"); // before: FIXTURE_NOT_IN_EVIDENCE_PHASE
    expect(error?.message ?? "").not.toContain("FIXTURE_NOT_IN_EVIDENCE_PHASE");
    expect(await evidenceFootprint(ctx.sf1)).toMatchObject({ evidence: 0, goals: 0, assists: 0, attestations: 0, audit: 0, state: "SCHEDULED" });
  }, 120000);

  it("a concurrent change of the appointment cannot leave a stale authorization: a scorekeeper removed while their submission waits is refused", async () => {
    await ensureContexts();
    const ctx = await buildInternal("e-race");
    const r = await readyFixture(ctx, "sf1", "erace");
    const first = (await createMember("Scorer Race A")).gamingMemberId;
    const second = (await createMember("Scorer Race B")).gamingMemberId;
    await appointScorekeeper(compRepo, r.fixtureId, ctx.organizerId, first);
    const { goals, attestations } = validEvidence(r);
    const holder = await connectRaw();
    const submitter = await connectRaw();
    const observer = await connectRaw();
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtext('competition_scope:' || $1::text))", [ctx.competitionId]);
      const { rows: pid } = await submitter.query("select pg_backend_pid() as pid");
      const waiting = submitter
        .query("select * from submit_competition_fixture_evidence_atomically($1, $2, 2, 0, $3::jsonb, '[]'::jsonb, $4::jsonb, null)", [r.fixtureId, first, JSON.stringify(goals), JSON.stringify(attestations)])
        .then(() => "written", (e: Error) => e.message);
      await waitUntilBlockedOnLock(observer, pid[0].pid);
      await holder.query("update competition_fixtures set scorekeeper_gaming_member_id = $2 where competition_fixture_id = $1", [r.fixtureId, second]);
      await holder.query("commit");
      expect(await waiting).toContain("COMPETITION_ACCESS_DENIED");
      expect(await evidenceFootprint(r.fixtureId)).toMatchObject({ evidence: 0, goals: 0, attestations: 0 });
    } finally {
      await holder.query("rollback").catch(() => {});
      await Promise.all([holder.end(), submitter.end(), observer.end()]);
    }
  }, 240000);

  it("[16, 17] compatibility: an internal organizer's own appointment flow, a host's own self-appointment, and revocation behave as before", async () => {
    await ensureContexts();
    // Internal OPERATIONAL organizer: appointment then evidence works (readySf2 above); the organizer is not the scorekeeper unless appointed.
    const { host, code, ctx: pilot } = await buildHostPilot("e16");
    await appointScorekeeper(compRepo, pilot.sf2, host.gamingMemberId, host.gamingMemberId);
    // Appointed (self) and still in the pilot: authorization passes, and only the fixture-state check refuses.
    await expectRejection(submitFixtureEvidence(compRepo, pilot.sf2, host.gamingMemberId, 1, 0, [], [], [], null), FixtureNotInEvidencePhaseError);
    // Not appointed to SF1: refused at authorization.
    await expectRejection(submitFixtureEvidence(compRepo, pilot.sf1, host.gamingMemberId, 1, 0, [], [], [], null), CompetitionAccessDeniedError);
    // Revoked: the appointed host is stopped by the host guard, which follows authorization.
    await withGovernance(() => revokeHostCapability(hostRepo, reviewer.gamingMemberId, code, "Fixture-scope suite: revoke."));
    await expectRejection(submitFixtureEvidence(compRepo, pilot.sf2, host.gamingMemberId, 1, 0, [], [], [], null), HostAccessRevokedError);
  }, 240000);
});

// =================================================================================================================
// NULL caller — the same fail-closed standard for every roster/evidence entrypoint
// =================================================================================================================

describe("a NULL caller is refused at the authorization boundary by every roster and evidence entrypoint, with no write", () => {
  const rosterCall = (actor: string | null, organizer: boolean) =>
    serviceClient.rpc("declare_competition_roster_atomically", {
      p_competition_fixture_id: readySf1.fixtureId, p_competition_team_id: readySf1.teamA.competitionTeamId, p_declaring_gaming_member_id: actor,
      p_is_organizer_action: organizer, p_reason: organizer ? "NULL caller probe" : null, p_gaming_member_ids: readySf1.a,
    });

  it("roster declaration: a NULL declaring member is refused in BOTH branches (captain: NOT_TEAM_CAPTAIN, organizer: COMPETITION_ACCESS_DENIED) and the current roster is untouched", async () => {
    await ensureContexts();
    const before = await rosterRows(readySf1.fixtureId, readySf1.teamA.competitionTeamId);
    const captainBranch = await rosterCall(null, false);
    expect(captainBranch.error?.message ?? "").toContain("NOT_TEAM_CAPTAIN");
    const organizerBranch = await rosterCall(null, true);
    expect(organizerBranch.error?.message ?? "").toContain("COMPETITION_ACCESS_DENIED");
    expect(await rosterRows(readySf1.fixtureId, readySf1.teamA.competitionTeamId)).toBe(before);
    const { data } = await serviceClient.from("competition_roster_revisions").select("is_current").eq("competition_fixture_id", readySf1.fixtureId).eq("competition_team_id", readySf1.teamA.competitionTeamId);
    expect((data ?? []).filter((r) => r.is_current).length).toBe(1); // the prior current revision was not invalidated
  }, 120000);

  it("correction (the organizer's override, an evidence writer): a NULL organizer is refused at the authorization boundary and no evidence row is written", async () => {
    await ensureContexts();
    const before = await evidenceFootprint(readySf1.fixtureId);
    const { error } = await serviceClient.rpc("correct_competition_fixture_atomically", {
      p_competition_fixture_id: readySf1.fixtureId, p_organizer_gaming_member_id: null, p_reason: "NULL caller probe", p_team_a_score: 1, p_team_b_score: 0,
      p_goal_events: [], p_assist_events: [], p_penalty_shootout_winning_team_id: null,
    });
    expect(error?.message ?? "").toContain("COMPETITION_ACCESS_DENIED");
    expect(await evidenceFootprint(readySf1.fixtureId)).toEqual(before);
    // The documented override still works for the real organizer and is still refused for everyone else.
    const stranger = (await createMember("Stranger NULL-correction")).gamingMemberId;
    const asStranger = await serviceClient.rpc("correct_competition_fixture_atomically", {
      p_competition_fixture_id: readySf1.fixtureId, p_organizer_gaming_member_id: stranger, p_reason: "Not the organizer", p_team_a_score: 1, p_team_b_score: 0,
      p_goal_events: [], p_assist_events: [], p_penalty_shootout_winning_team_id: null,
    });
    expect(asStranger.error?.message ?? "").toContain("COMPETITION_ACCESS_DENIED");
  }, 120000);
});

// =================================================================================================================
// Serialization helper
// =================================================================================================================

async function waitUntilBlockedOnLock(observer: Client, backendPid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { rows } = await observer.query("select wait_event_type from pg_stat_activity where pid = $1", [backendPid]);
    if (rows[0]?.wait_event_type === "Lock") return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("The statement never blocked on a lock.");
}

// =================================================================================================================
// NEGATIVE CONTROLS — remove each new check inside a rolled-back transaction and show the scenario then succeeds
// =================================================================================================================

async function functionDefinition(db: Client, signature: string): Promise<string> {
  const { rows } = await db.query("select pg_get_functiondef($1::regprocedure) as def", [signature]);
  return rows[0].def as string;
}

async function mutate(db: Client, signature: string, edit: (def: string) => string): Promise<void> {
  const original = await functionDefinition(db, signature);
  const edited = edit(original);
  expect(edited, "the mutation must actually change the function (otherwise the control proves nothing)").not.toBe(original);
  await db.query(edited);
}

const ROSTER_SIG = "declare_competition_roster_atomically(uuid, uuid, uuid, boolean, text, uuid[])";
const EVIDENCE_SIG = "submit_competition_fixture_evidence_atomically(uuid, uuid, integer, integer, jsonb, jsonb, jsonb, uuid)";
const DROP_TRIGGER = "drop trigger competition_roster_revisions_fixture_team_scope on competition_roster_revisions";

describe("[21] negative controls: removing each new check lets the corresponding attack through, so the tests above cannot pass vacuously", () => {
  it("control 1 — remove the SLOT predicate (and the table guard): a team of the right competition that is not a slot of the fixture can then declare a roster", async () => {
    await ensureContexts();
    const members = await membersOnTeam(ctxX, 0, 1, "ctl1");
    const db = await connectRaw();
    try {
      await expect(
        db.query("select * from declare_competition_roster_atomically($1, $2, $3, false, null, $4::uuid[])", [ctxX.sf2, ctxX.teams[0].competitionTeamId, ctxX.teams[0].captainId, members])
      ).rejects.toThrow(/FIXTURE_TEAM_SCOPE_MISMATCH/);
      await db.query("begin");
      await db.query(DROP_TRIGGER);
      await mutate(db, ROSTER_SIG, (d) => d.replace("\n     or (p_competition_team_id is distinct from v_team_a_id and p_competition_team_id is distinct from v_team_b_id) then", " then"));
      const out = await db.query("select * from declare_competition_roster_atomically($1, $2, $3, false, null, $4::uuid[])", [ctxX.sf2, ctxX.teams[0].competitionTeamId, ctxX.teams[0].captainId, members]);
      expect(out.rows[0].competition_roster_revision_id).toBeTruthy(); // the cross-fixture write now succeeds
      await db.query("rollback");
      expect(await rosterRows(ctxX.sf2, ctxX.teams[0].competitionTeamId)).toBe(0);
    } finally {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  }, 120000);

  it("control 2 — remove the SAME-COMPETITION predicate (and the table guard): a foreign team that has been seated in a slot can then declare a roster", async () => {
    await ensureContexts();
    const foreign = ctxY.teams[1];
    const foreignMember = await memberOnTeam(ctxY, 1, "ctl2");
    const db = await connectRaw();
    try {
      await db.query("begin");
      // Seat the foreign team in a slot (the state the review's low-severity correction finding could leave behind).
      await db.query("update competition_fixtures set team_b_competition_team_id = $2 where competition_fixture_id = $1", [ctxX.sf1, foreign.competitionTeamId]);
      await db.query("savepoint seated");
      await expect(
        db.query("select * from declare_competition_roster_atomically($1, $2, $3, false, null, $4::uuid[])", [ctxX.sf1, foreign.competitionTeamId, foreign.captainId, [foreignMember]])
      ).rejects.toThrow(/FIXTURE_TEAM_SCOPE_MISMATCH/); // the slot predicate passes; the same-competition predicate refuses
      await db.query("rollback to savepoint seated");
      await db.query(DROP_TRIGGER);
      await mutate(db, ROSTER_SIG, (d) => d.replace("if v_team_competition_id is distinct from v_competition_id\n     or (", "if ("));
      const out = await db.query("select * from declare_competition_roster_atomically($1, $2, $3, false, null, $4::uuid[])", [ctxX.sf1, foreign.competitionTeamId, foreign.captainId, [foreignMember]]);
      expect(out.rows[0].competition_roster_revision_id).toBeTruthy();
      await db.query("rollback");
      expect(await rosterRows(ctxX.sf1, foreign.competitionTeamId)).toBe(0);
    } finally {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  }, 120000);

  it("control 3 — remove the function-level check but KEEP the table guard: the attack is still refused (defense in depth), and the guard alone is removable only together with the check", async () => {
    await ensureContexts();
    const members = await membersOnTeam(ctxX, 0, 1, "ctl3");
    const db = await connectRaw();
    try {
      await db.query("begin");
      await mutate(db, ROSTER_SIG, (d) => d.replace(/  if v_team_competition_id is distinct from v_competition_id[\s\S]*?end if;\n/, "  null;\n"));
      await expect(
        db.query("select * from declare_competition_roster_atomically($1, $2, $3, false, null, $4::uuid[])", [ctxX.sf2, ctxX.teams[0].competitionTeamId, ctxX.teams[0].captainId, members])
      ).rejects.toThrow(/FIXTURE_TEAM_SCOPE_MISMATCH/); // refused by the TRIGGER
      await db.query("rollback");
    } finally {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  }, 120000);

  it("control 4 — put back the NULL-unsafe comparison: a stranger then passes the access check on a fixture with NO scorekeeper and WRITES official evidence", async () => {
    await ensureContexts();
    const ctx = await buildInternal("ctl4");
    const r = await readyFixture(ctx, "sf1", "ctl4"); // evidence phase, nobody appointed
    const { goals, attestations } = validEvidence(r);
    const stranger = (await createMember("Stranger ctl4")).gamingMemberId;
    const call = (db: Client) =>
      db.query("select * from submit_competition_fixture_evidence_atomically($1, $2, 2, 0, $3::jsonb, '[]'::jsonb, $4::jsonb, null)", [r.fixtureId, stranger, JSON.stringify(goals), JSON.stringify(attestations)]);
    const db = await connectRaw();
    try {
      await expect(call(db)).rejects.toThrow(/COMPETITION_ACCESS_DENIED/);
      await db.query("begin");
      await mutate(db, EVIDENCE_SIG, (d) =>
        d.replace(/  if v_appointed_scorekeeper is null\n     or p_scorekeeper_gaming_member_id is null\n     or p_scorekeeper_gaming_member_id is distinct from v_appointed_scorekeeper then/, "  if p_scorekeeper_gaming_member_id <> v_appointed_scorekeeper then")
      );
      const out = await call(db);
      expect(out.rows[0].already_submitted).toBe(false); // the fail-open: official evidence written by a stranger
      const { rows } = await db.query("select count(*)::int as n from competition_fixture_evidence where competition_fixture_id = $1", [r.fixtureId]);
      expect(rows[0].n).toBe(1);
      await db.query("rollback");
      expect((await evidenceFootprint(r.fixtureId)).evidence).toBe(0);
    } finally {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  }, 240000);

  it("control 5 — remove the EXACT-APPOINTMENT predicate: a scorekeeper appointed to another fixture can then submit evidence here", async () => {
    await ensureContexts();
    const ctx = await buildInternal("ctl5");
    const r = await readyFixture(ctx, "sf1", "ctl5");
    const appointed = (await createMember("Appointed ctl5")).gamingMemberId;
    const other = (await createMember("Other fixture ctl5")).gamingMemberId;
    await appointScorekeeper(compRepo, r.fixtureId, ctx.organizerId, appointed);
    await appointScorekeeper(compRepo, ctx.sf2, ctx.organizerId, other);
    const { goals, attestations } = validEvidence(r);
    const call = (db: Client) =>
      db.query("select * from submit_competition_fixture_evidence_atomically($1, $2, 2, 0, $3::jsonb, '[]'::jsonb, $4::jsonb, null)", [r.fixtureId, other, JSON.stringify(goals), JSON.stringify(attestations)]);
    const db = await connectRaw();
    try {
      await expect(call(db)).rejects.toThrow(/COMPETITION_ACCESS_DENIED/);
      await db.query("begin");
      await mutate(db, EVIDENCE_SIG, (d) => d.replace("\n     or p_scorekeeper_gaming_member_id is distinct from v_appointed_scorekeeper then", " then"));
      const out = await call(db);
      expect(out.rows[0].already_submitted).toBe(false);
      await db.query("rollback");
    } finally {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  }, 240000);

  it("control 6 — remove the authorization that now runs BEFORE the replay: a stranger is then handed the existing evidence (the previous replay-before-authorization behavior)", async () => {
    await ensureContexts();
    const ctx = await buildInternal("ctl6");
    const r = await readyFixture(ctx, "sf1", "ctl6");
    const scorer = (await createMember("Scorer ctl6")).gamingMemberId;
    await appointScorekeeper(compRepo, r.fixtureId, ctx.organizerId, scorer);
    const { goals, attestations } = validEvidence(r);
    await submitFixtureEvidence(compRepo, r.fixtureId, scorer, 2, 0, goals, [], attestations, null);
    const stranger = (await createMember("Stranger ctl6")).gamingMemberId;
    const call = (db: Client) =>
      db.query("select * from submit_competition_fixture_evidence_atomically($1, $2, 2, 0, $3::jsonb, '[]'::jsonb, $4::jsonb, null)", [r.fixtureId, stranger, JSON.stringify(goals), JSON.stringify(attestations)]);
    const db = await connectRaw();
    try {
      await expect(call(db)).rejects.toThrow(/COMPETITION_ACCESS_DENIED/);
      await db.query("begin");
      await mutate(db, EVIDENCE_SIG, (d) => {
        const block = d.match(/  if v_appointed_scorekeeper is null[\s\S]*?perform assert_actor_not_revoked_host\(v_competition_id, p_scorekeeper_gaming_member_id\);\n/);
        expect(block, "the authorization block must be found").not.toBeNull();
        // Without it the function answers a replay before it ever asks who is calling, as it did before GATE-089.
        return d.replace(block![0], "");
      });
      const out = await call(db);
      expect(out.rows[0].already_submitted).toBe(true); // a stranger was handed the existing evidence
      await db.query("rollback");
    } finally {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  }, 240000);

  it("control 7 — put back the bare <> on the caller: a NULL caller then SKIPS the denial in the roster and correction functions and is stopped only by a later NOT NULL write", async () => {
    await ensureContexts();
    const CORRECT_SIG = "correct_competition_fixture_atomically(uuid, uuid, text, integer, integer, jsonb, jsonb, uuid)";
    const rosterNull = (db: Client) =>
      db.query("select * from declare_competition_roster_atomically($1, $2, null, false, null, $3::uuid[])", [readySf1.fixtureId, readySf1.teamA.competitionTeamId, readySf1.a]);
    const correctionNull = (db: Client) =>
      db.query("select * from correct_competition_fixture_atomically($1, null, 'NULL caller probe', 1, 0, '[]'::jsonb, '[]'::jsonb, null)", [readySf1.fixtureId]);
    const db = await connectRaw();
    try {
      await expect(rosterNull(db)).rejects.toThrow(/NOT_TEAM_CAPTAIN/);
      await expect(correctionNull(db)).rejects.toThrow(/COMPETITION_ACCESS_DENIED/);
      await db.query("begin");
      await mutate(db, ROSTER_SIG, (d) => d.replace("p_declaring_gaming_member_id is distinct from v_captain_id", "p_declaring_gaming_member_id <> v_captain_id"));
      await db.query("savepoint s1");
      await expect(rosterNull(db)).rejects.toThrow(/null value in column/); // denial skipped; the NOT NULL write is the only thing left
      await db.query("rollback to savepoint s1");
      await mutate(db, CORRECT_SIG, (d) => d.replace("p_organizer_gaming_member_id is distinct from v_organizer_id", "p_organizer_gaming_member_id <> v_organizer_id"));
      await db.query("savepoint s2");
      let skipped: Error | null = null;
      try { await correctionNull(db); } catch (e) { skipped = e as Error; }
      expect(skipped, "the NULL caller must get past the authorization check once the comparison is bare again").not.toBeNull();
      expect(skipped!.message).not.toMatch(/COMPETITION_ACCESS_DENIED/);
      await db.query("rollback to savepoint s2");
      await db.query("rollback");
    } finally {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  }, 120000);

  it("the controls left no trace: the real checks, trigger and functions are intact after every rollback", async () => {
    const db = await connectRaw();
    try {
      expect(await functionDefinition(db, ROSTER_SIG)).toContain("v_team_competition_id is distinct from v_competition_id");
      expect(await functionDefinition(db, EVIDENCE_SIG)).toContain("p_scorekeeper_gaming_member_id is distinct from v_appointed_scorekeeper");
      expect(await functionDefinition(db, "correct_competition_fixture_atomically(uuid, uuid, text, integer, integer, jsonb, jsonb, uuid)")).toContain("p_organizer_gaming_member_id is distinct from v_organizer_id");
      const { rows } = await db.query("select count(*)::int as n from pg_trigger where tgname = 'competition_roster_revisions_fixture_team_scope' and tgenabled = 'O'");
      expect(rows[0].n).toBe(1);
    } finally {
      await db.end();
    }
  }, 30000);
});
