import { randomUUID } from "node:crypto";

import { loadEnv } from "vite";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SupabaseHostRepository } from "../lib/gaming/host/db/supabaseHostRepository";
import { SupabaseCompetitionsRepository } from "../lib/gaming/competitions/db/supabaseCompetitionsRepository";
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
import { appointScorekeeper } from "../lib/gaming/competitions/appointScorekeeper";
import { cancelCompetition } from "../lib/gaming/competitions/cancelCompetition";
import { Client } from "pg";
import { registerForCompetition } from "../lib/gaming/competitions/registerForCompetition";
import { requestJoinTeam } from "../lib/gaming/competitions/requestJoinTeam";
import { decideJoinRequest } from "../lib/gaming/competitions/decideJoinRequest";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";
// The REAL route handlers, called with real user access tokens against the real local database.
import { GET as generalListRoute } from "../app/api/gaming/competitions/route";
import { GET as organizerAccessRoute } from "../app/api/gaming/competitions/organizer-access/route";
import { GET as administrationRoute } from "../app/api/gaming/competitions/administration/route";
import { POST as cancelRoute } from "../app/api/gaming/competitions/[competitionId]/cancel/route";
import { GET as adminDetailRoute } from "../app/api/gaming/competitions/fixtures/[fixtureId]/admin-detail/route";
import { GET as hostStatusRoute } from "../app/api/gaming/host/status/route";
import { GET as competitionViewRoute } from "../app/api/gaming/competitions/[competitionId]/route";
import { GET as scorekeeperAdministrationRoute } from "../app/api/gaming/competitions/[competitionId]/scorekeeper-administration/route";
import { GET as resolveRoute } from "../app/api/gaming/competitions/resolve/route";
import { openAdminPage, openMemberPage, type PageTransport } from "./helpers/competitionAdminPageHarness";

/**
 * UG-CR-GATE-100 — Competition Organizer entry and scoped administration (bounded organizer-access correction), against a real Postgres.
 *
 * Every audience is a real member with a real session token. The three new routes are the real handlers, called with real user tokens; the
 * general member-discovery route is exercised too, only to prove it is unchanged and to demonstrate that feeding it to an organizer page would
 * reproduce the defect that motivated the original gate (negative control).
 *
 * ACTIVE organizer authority is what Organizer Access and the default administrative source mean. An approved-but-unused capability, a
 * scorekeeper appointment, a captaincy, a registration, an application, the OPERATIONAL authority alone, and a COMPLETE or cancelled
 * competition are none of it; scorekeeper access exists only for ONE addressed competition, re-confirmed by the server.
 */

const env = loadEnv("development", process.cwd(), "");
const supabaseUrl = env.SUPABASE_URL;
requireLocalSupabase(supabaseUrl);
const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAnonKey = env.SUPABASE_ANON_KEY;
if (!supabaseUrl || !supabaseServiceRoleKey || !supabaseAnonKey) {
  throw new Error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are required for contract tests.");
}
// Raw pg runs the deadline fixture (UG-CR-GATE-SSS-007). The URL is supplied explicitly, never read from .env.local, and must be loopback.
const supabaseDbUrl = process.env.COMPETITIONS_LOCAL_DB_URL ?? "";
if (!/^postgresql:\/\/[^@]+@(127\.0\.0\.1|localhost|\[::1\]):\d+\//.test(supabaseDbUrl)) {
  throw new Error("COMPETITIONS_LOCAL_DB_URL must be set to a loopback Postgres URL for the organizer-access contract tests.");
}

const hostRepo = new SupabaseHostRepository(supabaseUrl, supabaseServiceRoleKey);
const compRepo = new SupabaseCompetitionsRepository(supabaseUrl, supabaseServiceRoleKey);
const gamingRepo = new SupabaseGamingRepository(supabaseUrl, supabaseServiceRoleKey);
const service = createClient(supabaseUrl, supabaseServiceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

const RUN = randomUUID().slice(0, 8);
const NO_STORE = "no-store, max-age=0";

interface Person { authUserId: string; gamingMemberId: string; email: string }
const authUsers: string[] = [];
const operators: string[] = [];
let counter = 0;

async function newPerson(label: string): Promise<Person> {
  const email = `admin-gate-${RUN}-${counter++}@example.com`;
  const { data, error } = await service.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("Could not create a test auth user.");
  authUsers.push(data.user.id);
  const member = await gamingRepo.createGamingMember(data.user.id, `${label} ${RUN}`);
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

/** The reviewer holds platform governance ONLY while `fn` runs. */
async function asGovernance<T>(fn: () => Promise<T>): Promise<T> {
  const { error } = await service.from("authority_grants").insert({ gaming_member_id: reviewer.gamingMemberId, authority_class: "PRODUCT_GOVERNANCE" });
  if (error) throw error;
  try {
    return await fn();
  } finally {
    await service.from("authority_grants").delete().eq("gaming_member_id", reviewer.gamingMemberId).eq("authority_class", "PRODUCT_GOVERNANCE");
  }
}

function application(label: string) {
  return {
    venueName: `Venue ${label} ${RUN}`, cityArea: "Fictional Heights", playingFields: 2,
    venueDescription: `A fictional venue (${label}) used only by the local contract suite; it runs imaginary leagues.`,
    expectedWindow: "weekend of 14 November", expectedTeamCount: 4,
    confirmAllAdults: true, confirmIndependentScorekeepers: true, confirmPilotExclusions: true,
  };
}

async function apply(person: Person, label: string): Promise<string> {
  return (await submitHostApplication(hostRepo, person.gamingMemberId, application(label))).publicCode;
}

async function approvedHost(label: string): Promise<{ person: Person; code: string }> {
  const person = await newPerson(label);
  const code = await apply(person, label);
  await asGovernance(() => decideHostApplication(hostRepo, reviewer.gamingMemberId, code, "APPROVE", null));
  return { person, code };
}

const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();

// ---------------------------------------------------------------------------------------------------------------------------------------------
// UG-CR-GATE-SSS-007 fixtures. Opening team registration now needs a usable plan (a saved Organizer Planning revision whose deadline is still ahead), and the
// freeze (CLOSE_TEAM_REGISTRATION) needs that deadline to have passed and every roster to be within the plan's bounds. These helpers give a competition a REAL
// plan through the real save operation and — only when a test needs "the deadline has passed" — record a LATER revision as the database owner (a service-side
// fixture: the save operation itself needs a DRAFT) whose deadline is the first whole second after the competition's newest registration-related row, so every
// row already written is stamped before it. Nothing here waits for a real deadline. (UG-CR-GATE-SSS-007A: the deadline fixture is the ONE service-side step in these lifecycles; every registration, join, approval and the freeze itself go through the real operations.)
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

/** Builds `size` members on each given team through the real operations (register, ask to join, the captain approves) — the rosters a freeze needs, which cannot be built afterwards. */
async function buildRostersBeforeFreeze(competitionId: string, teams: Array<{ id: string; captainId: string }>, makeMember: (label: string) => Promise<{ gamingMemberId: string }>, size = 5): Promise<string[][]> {
  return Promise.all(teams.map(async (team, t) => {
    const members: string[] = [];
    for (let k = 0; k < size; k++) {
      const member = await makeMember(`Roster ${t}-${k}`);
      await registerForCompetition(compRepo, competitionId, member.gamingMemberId, true);
      const request = await requestJoinTeam(compRepo, competitionId, team.id, member.gamingMemberId);
      await decideJoinRequest(compRepo, request.competitionJoinRequestId, team.captainId, "APPROVE", false);
      members.push(member.gamingMemberId);
    }
    return members;
  }));
}

/** Opens registration (it needs a plan), adds four captained teams, builds their rosters, lets the deadline pass, freezes registration and publishes the bracket. */
async function publishedBracket(competitionId: string, organizerId: string, label: string) {
  await saveFixturePlan(competitionId, organizerId);
  await openTeamRegistration(compRepo, competitionId, organizerId);
  const teamIds: string[] = [];
  const teamsForRoster: Array<{ id: string; captainId: string }> = [];
  for (let i = 0; i < 4; i++) {
    const captain = await newPerson(`${label} Cap${i}`);
    const team = await addCompetitionTeam(compRepo, competitionId, organizerId, `${label} Team ${i} ${RUN}`, captain.gamingMemberId);
    teamIds.push(team.competitionTeamId);
    teamsForRoster.push({ id: team.competitionTeamId, captainId: captain.gamingMemberId });
  }
  await buildRostersBeforeFreeze(competitionId, teamsForRoster, newPerson);
  await passDeadlineFixture(competitionId);
  await closeTeamRegistration(compRepo, competitionId, organizerId);
  return publishCompetition(compRepo, competitionId, organizerId, teamIds[0], teamIds[1], teamIds[2], teamIds[3], inMs(3_600_000), inMs(7_200_000), inMs(10_800_000));
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

const bearer = (token: string | null, method = "GET", body?: unknown) =>
  new Request("http://localhost/probe", {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function organizerAccessOf(person: Person | null, rawToken?: string) {
  const res = await organizerAccessRoute(bearer(person ? await tokenFor(person) : (rawToken ?? null)));
  return { status: res.status, text: await res.text(), cache: res.headers.get("cache-control") };
}

interface Entry { competitionId: string; name: string; state: string; access: string }
interface Operations { createCompetition: boolean }

async function administeredBy(person: Person | null, rawToken?: string) {
  const res = await administrationRoute(bearer(person ? await tokenFor(person) : (rawToken ?? null)));
  const text = await res.text();
  let competitions: Entry[] = [];
  let operations: Operations | undefined;
  try {
    const parsed = JSON.parse(text) as { competitions?: Entry[]; operations?: Operations };
    competitions = parsed.competitions ?? [];
    operations = parsed.operations;
  } catch { /* not JSON */ }
  return { status: res.status, text, cache: res.headers.get("cache-control"), competitions, operations };
}

async function generallyListedFor(person: Person) {
  const res = await generalListRoute(bearer(await tokenFor(person)));
  return { status: res.status, names: ((await res.json()) as { competitions: Array<{ name: string }> }).competitions.map((c) => c.name) };
}

async function stateOf(competitionId: string): Promise<string> {
  const { data, error } = await service.from("competitions").select("state").eq("competition_id", competitionId).single();
  if (error) throw error;
  return data.state as string;
}

interface World {
  operatorA: Person; intA: { competitionId: string; name: string; sf1: string; sf2: string };
  operatorB: Person; intB: { competitionId: string; name: string };
  scorer: Person;                                             // appointed to semifinal 1 of Internal A only
  scorerReplaced: Person; scorerNew: Person;                  // scorerReplaced was appointed to semifinal 2, then REPLACED by scorerNew
  hostActive: Person; pilotActive: { competitionId: string; name: string };
  hostRevoked: Person;
  hostSelfScorer: Person;
  hostUnused: Person;
  applicant: Person; applicantCode: string;
  rejected: Person;
  withdrawn: Person;                                          // applied, then withdrew (never approved)
  hostCancelled: Person; pilotCancelled: { competitionId: string; name: string }; // approved, created the pilot, then cancelled it; capability CONSUMED, not revoked
  operatorEmpty: Person;                                      // holds OPERATIONAL authority, organizes nothing yet
  operatorDone: Person; intDone: { competitionId: string; name: string }; // organizes exactly one competition, and it is COMPLETE
  operatorRevoked: Person;                                    // held OPERATIONAL authority, which has since been revoked
  plain: Person;
}
let world: World;

const ENV_KEYS = ["COMPETITIONS_SCHEMA_READY", "BECOME_A_HOST_SCHEMA_READY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY"] as const;
const originalEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
  process.env.COMPETITIONS_SCHEMA_READY = "true";
  delete process.env.BECOME_A_HOST_SCHEMA_READY; // applications CLOSED, the default
  process.env.SUPABASE_URL ??= supabaseUrl;
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= supabaseServiceRoleKey;
  process.env.SUPABASE_ANON_KEY ??= supabaseAnonKey;

  reviewer = await newPerson("Reviewer");

  // An internal competition, published, with a scorekeeper appointed to ONE fixture.
  const operatorA = await makeOperator("OpA");
  const a = await createCompetition(compRepo, operatorA.gamingMemberId, `Internal A ${RUN}`, "SOCCER_5V5");
  const bracketA = await publishedBracket(a.competitionId, operatorA.gamingMemberId, "A");
  const scorer = await newPerson("Scorer");
  await appointScorekeeper(compRepo, bracketA.semifinal1FixtureId, operatorA.gamingMemberId, scorer.gamingMemberId);
  const scorerReplaced = await newPerson("ScorerReplaced");
  await appointScorekeeper(compRepo, bracketA.semifinal2FixtureId, operatorA.gamingMemberId, scorerReplaced.gamingMemberId);
  const scorerNew = await newPerson("ScorerNew");
  await appointScorekeeper(compRepo, bracketA.semifinal2FixtureId, operatorA.gamingMemberId, scorerNew.gamingMemberId); // replaces scorerReplaced

  // An unrelated internal competition, open for team registration (the shape of the preserved pilot).
  const operatorB = await makeOperator("OpB");
  const b = await createCompetition(compRepo, operatorB.gamingMemberId, `Internal B ${RUN}`, "SOCCER_5V5");
  await saveFixturePlan(b.competitionId, operatorB.gamingMemberId);
  await openTeamRegistration(compRepo, b.competitionId, operatorB.gamingMemberId);

  // Hosts: active (a DRAFT pilot), revoked, revoked-after-self-appointing-as-scorekeeper, and one whose capability is still unused.
  const active = await approvedHost("HostActive");
  const pilot = await createHostCompetition(hostRepo, active.person.gamingMemberId, `Pilot Active ${RUN}`);
  const revoked = await approvedHost("HostRevoked");
  await createHostCompetition(hostRepo, revoked.person.gamingMemberId, `Pilot Revoked ${RUN}`);
  await asGovernance(() => revokeHostCapability(hostRepo, reviewer.gamingMemberId, revoked.code, "Rules were not followed."));
  const selfScorer = await approvedHost("HostSelfScore");
  const selfPilot = await createHostCompetition(hostRepo, selfScorer.person.gamingMemberId, `Pilot SelfScore ${RUN}`);
  const selfBracket = await publishedBracket(selfPilot.competitionId, selfScorer.person.gamingMemberId, "S");
  await appointScorekeeper(compRepo, selfBracket.semifinal1FixtureId, selfScorer.person.gamingMemberId, selfScorer.person.gamingMemberId);
  await asGovernance(() => revokeHostCapability(hostRepo, reviewer.gamingMemberId, selfScorer.code, "Rules were not followed."));
  const unused = await approvedHost("HostUnused");

  const applicant = await newPerson("Applicant");
  const applicantCode = await apply(applicant, "pending");
  const rejected = await newPerson("Rejected");
  const rejectedCode = await apply(rejected, "rejected");
  await asGovernance(() => decideHostApplication(hostRepo, reviewer.gamingMemberId, rejectedCode, "REJECT", "Not a fit for the pilot."));
  const withdrawn = await newPerson("Withdrawn");
  const withdrawnCode = await apply(withdrawn, "withdrawn");
  await hostRepo.withdrawApplication(withdrawn.gamingMemberId, withdrawnCode);
  const cancelled = await approvedHost("HostCancelled");
  const cancelledPilot = await createHostCompetition(hostRepo, cancelled.person.gamingMemberId, `Pilot Cancelled ${RUN}`);
  await cancelCompetition(compRepo, cancelledPilot.competitionId, cancelled.person.gamingMemberId, "Cancelled by the contract suite.");
  const operatorEmpty = await makeOperator("OpEmpty");
  const operatorDone = await makeOperator("OpDone");
  const done = await createCompetition(compRepo, operatorDone.gamingMemberId, `Internal Done ${RUN}`, "SOCCER_5V5");
  // The terminal state itself is what is under test, so it is written directly on this one test competition (local database only).
  { const { error } = await service.from("competitions").update({ state: "COMPLETE" }).eq("competition_id", done.competitionId); if (error) throw error; }

  const operatorRevoked = await newPerson("OpRevoked");
  { const { error } = await service.from("authority_grants").insert({ gaming_member_id: operatorRevoked.gamingMemberId, authority_class: "OPERATIONAL", revoked_at: new Date().toISOString(), revoked_by: reviewer.gamingMemberId }); if (error) throw error; }
  operators.push(operatorRevoked.gamingMemberId);

  world = {
    operatorA, intA: { competitionId: a.competitionId, name: `Internal A ${RUN}`, sf1: bracketA.semifinal1FixtureId, sf2: bracketA.semifinal2FixtureId },
    operatorB, intB: { competitionId: b.competitionId, name: `Internal B ${RUN}` },
    scorer, scorerReplaced, scorerNew,
    hostActive: active.person, pilotActive: { competitionId: pilot.competitionId, name: `Pilot Active ${RUN}` },
    hostRevoked: revoked.person, hostSelfScorer: selfScorer.person, hostUnused: unused.person,
    applicant, applicantCode, rejected, withdrawn,
    hostCancelled: cancelled.person, pilotCancelled: { competitionId: cancelledPilot.competitionId, name: `Pilot Cancelled ${RUN}` },
    operatorEmpty, operatorRevoked, operatorDone, intDone: { competitionId: done.competitionId, name: `Internal Done ${RUN}` },
    plain: await newPerson("Plain"),
  };
}, 600000);

afterAll(async () => {
  // Host rows cannot be deleted by design; leave nothing PENDING behind, remove only what carries no history.
  if (world) await hostRepo.withdrawApplication(world.applicant.gamingMemberId, world.applicantCode).catch(() => {});
  if (operators.length > 0) await service.from("authority_grants").delete().in("gaming_member_id", operators);
  if (reviewer) await service.from("authority_grants").delete().eq("gaming_member_id", reviewer.gamingMemberId);
  for (const id of authUsers) await service.auth.admin.deleteUser(id);
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
}, 300000);

const NONE: Operations = { createCompetition: false };
const EMPTY_BODY = '{"competitions":[],"operations":{"createCompetition":false}}';

/** The bounded scorekeeper route, as the real handler with a real user token. */
async function scorekeeperAdministrationOf(person: Person | null, competitionId: string, rawToken?: string) {
  const res = await scorekeeperAdministrationRoute(bearer(person ? await tokenFor(person) : (rawToken ?? null)), { params: { competitionId } });
  return { status: res.status, text: await res.text(), cache: res.headers.get("cache-control") };
}

/** The member competition view (the addressed-competition surface's own read), as the real handler. */
async function viewOf(person: Person, competitionId: string) {
  const res = await competitionViewRoute(bearer(await tokenFor(person)), { params: { competitionId } });
  const body = (await res.json()) as { view?: { myScorekeeperFixtureIds?: unknown; fixtures?: unknown[] } };
  return { status: res.status, view: body.view };
}

describe("[signal] GET /api/gaming/competitions/organizer-access", () => {
  it("is true for each ACTIVE Competition Organizer and false for everyone else — as exactly one uncached boolean", async () => {
    const expectations: Array<[string, Person, boolean]> = [
      ["an internal organizer (a)", world.operatorA, true],
      ["an internal organizer (b)", world.operatorB, true],
      ["an approved host with an active pilot", world.hostActive, true],
      ["an approved host whose one pilot is still to be created (capability unused)", world.hostUnused, false],
      ["an approved host whose pilot was created and then cancelled (terminal only)", world.hostCancelled, false],
      ["an internal organizer whose only competition is COMPLETE (terminal only)", world.operatorDone, false],
      ["a revoked host", world.hostRevoked, false],
      ["a revoked host who had appointed themselves scorekeeper", world.hostSelfScorer, false],
      ["an appointed scorekeeper only", world.scorer, false],
      ["an internal operator with no competition of their own", world.operatorEmpty, false],
      ["a member whose OPERATIONAL authority was revoked", world.operatorRevoked, false],
      ["an applicant whose application is pending", world.applicant, false],
      ["a rejected applicant", world.rejected, false],
      ["a withdrawn applicant", world.withdrawn, false],
      ["a member with no application", world.plain, false],
    ];
    for (const [label, person, expected] of expectations) {
      const out = await organizerAccessOf(person);
      expect(out.status, label).toBe(200);
      expect(out.text, label).toBe(`{"organizerAccess":${expected}}`);
      expect(out.cache, label).toBe(NO_STORE);
    }
  }, 300000);

  it("a signed-out request and an invalid token follow the existing bounded 401 and never produce the boolean", async () => {
    for (const out of [await organizerAccessOf(null), await organizerAccessOf(null, "not-a-real-token")]) {
      expect(out.status).toBe(401);
      expect(out.cache).toBe(NO_STORE);
      expect(out.text).not.toContain("organizerAccess");
    }
  }, 60000);

  it("whatever the application-availability flag holds, a real organizer stays true and an approved-unused member stays false — while the application routes stay closed", async () => {
    const organizerToken = await tokenFor(world.hostActive);
    const unusedToken = await tokenFor(world.hostUnused);
    delete process.env.BECOME_A_HOST_SCHEMA_READY;                       // applications CLOSED: the application routes refuse...
    expect((await hostStatusRoute(bearer(organizerToken))).status).toBe(503);
    for (const flag of [undefined, "", "false", "TRUE", "1", "garbage", "true"]) {
      if (flag === undefined) delete process.env.BECOME_A_HOST_SCHEMA_READY;
      else process.env.BECOME_A_HOST_SCHEMA_READY = flag;
      expect(await (await organizerAccessRoute(bearer(organizerToken))).text(), `organizer, flag=${flag}`).toBe('{"organizerAccess":true}');
      expect(await (await organizerAccessRoute(bearer(unusedToken))).text(), `approved-unused, flag=${flag}`).toBe('{"organizerAccess":false}');
    }
    delete process.env.BECOME_A_HOST_SCHEMA_READY;
  }, 120000);
});

describe("[administration] GET /api/gaming/competitions/administration — the competitions the caller ACTIVELY organizes", () => {
  it("returns an organizer only their own active competitions — never an unrelated open or internal one", async () => {
    const hostActive = await administeredBy(world.hostActive);
    expect(hostActive.status).toBe(200);
    expect(hostActive.cache).toBe(NO_STORE);
    expect(hostActive.competitions).toEqual([{ competitionId: world.pilotActive.competitionId, name: world.pilotActive.name, state: "DRAFT", access: "ORGANIZER" }]);
    expect(hostActive.operations).toEqual(NONE);                           // a host pilot is not the internal OPERATIONAL authority

    const a = await administeredBy(world.operatorA);
    expect(a.competitions.map((c) => [c.name, c.access])).toEqual([[world.intA.name, "ORGANIZER"]]);
    const b = await administeredBy(world.operatorB);
    expect(b.competitions.map((c) => [c.name, c.access])).toEqual([[world.intB.name, "ORGANIZER"]]);
  }, 180000);

  it("returns a scorekeeper NOTHING — an appointment is not an administration target, and no competition they score in is enumerated", async () => {
    for (const person of [world.scorer, world.scorerNew]) {
      const out = await administeredBy(person);
      expect(out.status).toBe(200);
      expect(out.text).toBe(EMPTY_BODY);
      expect(out.text).not.toContain(world.intA.name);
      expect(out.text).not.toContain(world.intA.sf1);
      expect(out.text).not.toContain(world.intA.sf2);
    }
  }, 120000);

  it("returns exactly the same bounded body to every member without active organizer authority — and nothing about what exists", async () => {
    const plain = await administeredBy(world.plain);
    expect(plain.text).toBe(EMPTY_BODY);
    for (const [label, person] of [
      ["an approved host whose capability is unused", world.hostUnused],
      ["a revoked host", world.hostRevoked],
      ["a revoked host who appointed themselves scorekeeper", world.hostSelfScorer],
      ["a host whose only pilot was cancelled", world.hostCancelled],
      ["a scorekeeper whose appointment was replaced", world.scorerReplaced],
      ["a pending applicant", world.applicant],
      ["a rejected applicant", world.rejected],
      ["a withdrawn applicant", world.withdrawn],
    ] as Array<[string, Person]>) {
      const out = await administeredBy(person);
      expect(out.status, label).toBe(200);
      expect(out.text, label).toBe(plain.text);
      expect(out.cache, label).toBe(NO_STORE);
    }
  }, 300000);

  it("a COMPLETE competition is not an active target, and the OPERATIONAL authority that remains is independent of it", async () => {
    const out = await administeredBy(world.operatorDone);
    expect(out.competitions).toEqual([]);
    expect(out.text).not.toContain(world.intDone.name);
    expect(out.operations).toEqual({ createCompetition: true });
  }, 60000);

  it("Create Competition is offered only to the active OPERATIONAL authority — and to nobody for any other reason", async () => {
    for (const [label, person, expected] of [
      ["operator with a running competition", world.operatorB, true], ["operator with no competition", world.operatorEmpty, true], ["operator whose competition is complete", world.operatorDone, true],
      ["member whose OPERATIONAL authority was revoked", world.operatorRevoked, false],
      ["active host organizer", world.hostActive, false], ["approved-unused host", world.hostUnused, false], ["scorekeeper", world.scorer, false],
      ["revoked host", world.hostRevoked, false], ["pending applicant", world.applicant, false], ["plain member", world.plain, false],
    ] as Array<[string, Person, boolean]>) {
      expect((await administeredBy(person)).operations, label).toEqual({ createCompetition: expected });
    }
  }, 300000);

  it("each entry carries only competitionId, name, state and access: no organizer id, public code, fixture list or count", async () => {
    for (const person of [world.hostActive, world.operatorA, world.operatorB]) {
      const out = await administeredBy(person);
      expect(out.competitions.length).toBeGreaterThan(0);
      for (const entry of out.competitions) expect(Object.keys(entry).sort()).toEqual(["access", "competitionId", "name", "state"]);
      expect(out.text).not.toMatch(/organizerGamingMemberId|publicCode|hostBound|hostAccessRevoked|cancelledReason|scorekeeper/);
    }
  }, 180000);

  it("a signed-out request and an invalid token get the bounded 401 and no list", async () => {
    for (const out of [await administeredBy(null), await administeredBy(null, "not-a-real-token")]) {
      expect(out.status).toBe(401);
      expect(out.cache).toBe(NO_STORE);
      expect(out.text).not.toContain("competitions\":");
      expect(out.text).not.toContain("operations");
    }
  }, 60000);
});

describe("[scorekeeper] GET /api/gaming/competitions/[competitionId]/scorekeeper-administration — contextual to ONE addressed competition", () => {
  it("returns the scorekeeper that one competition and ONLY the fixture they are currently appointed to — with only that fixture's teams", async () => {
    const out = await scorekeeperAdministrationOf(world.scorer, world.intA.competitionId);
    expect(out.status).toBe(200);
    expect(out.cache).toBe(NO_STORE);
    const body = JSON.parse(out.text) as { competition: Record<string, unknown>; teams: Array<Record<string, unknown>>; fixtures: Array<Record<string, unknown>> };
    expect(body.competition).toEqual({ competitionId: world.intA.competitionId, name: world.intA.name, state: "PUBLISHED" });
    expect(body.fixtures.map((f) => f.competitionFixtureId)).toEqual([world.intA.sf1]);
    expect(Object.keys(body.fixtures[0]).sort()).toEqual(["competitionFixtureId", "fixtureRole", "scheduledAt", "state", "teamACompetitionTeamId", "teamBCompetitionTeamId"]);
    expect(body.teams).toHaveLength(2);                                                         // the two teams of semifinal 1, not all four
    expect(out.text).not.toContain(world.intA.sf2);
    expect(out.text).not.toContain(world.intB.name);
    expect(out.text).not.toMatch(/organizerGamingMemberId|publicCode|scorekeeperGamingMemberId|SourceFixtureId|hostBound/);
  }, 120000);

  it("a REPLACED appointment moves with the fixture: the new scorekeeper gets it, the replaced one gets nothing", async () => {
    const mine = await scorekeeperAdministrationOf(world.scorerNew, world.intA.competitionId);
    expect(mine.status).toBe(200);
    expect((JSON.parse(mine.text) as { fixtures: Array<{ competitionFixtureId: string }> }).fixtures.map((f) => f.competitionFixtureId)).toEqual([world.intA.sf2]);
    expect((await scorekeeperAdministrationOf(world.scorerReplaced, world.intA.competitionId)).status).toBe(404);
  }, 120000);

  it("the identical 404 for everyone who is not currently appointed in THAT competition — a wrong competition reveals nothing", async () => {
    const UNKNOWN = "99999999-9999-4999-8999-999999999999";
    const selfPilot = await service.from("competitions").select("competition_id").eq("organizer_gaming_member_id", world.hostSelfScorer.gamingMemberId).single();
    if (selfPilot.error) throw selfPilot.error;
    const cases: Array<[string, Person, string]> = [
      ["the scorekeeper, asking about a competition they do not score in", world.scorer, world.intB.competitionId],
      ["the scorekeeper, asking about a competition that does not exist", world.scorer, UNKNOWN],
      ["a plain member", world.plain, world.intA.competitionId],
      ["the competition's own organizer (organizing is not scorekeeping)", world.operatorA, world.intA.competitionId],
      ["an approved host with an unused capability", world.hostUnused, world.intA.competitionId],
      ["a revoked host who appointed themselves scorekeeper, asking about their own pilot", world.hostSelfScorer, selfPilot.data.competition_id as string],
      ["a pending applicant", world.applicant, world.intA.competitionId],
      ["an operator", world.operatorEmpty, world.intA.competitionId],
    ];
    const bodies = new Set<string>();
    for (const [label, person, id] of cases) {
      const out = await scorekeeperAdministrationOf(person, id);
      expect(out.status, label).toBe(404);
      expect(out.cache, label).toBe(NO_STORE);
      bodies.add(out.text);
    }
    expect(bodies.size).toBe(1);
    expect([...bodies][0]).toBe('{"error":"Scorekeeper access was not found for this competition."}');
  }, 300000);

  it("a malformed id is the same 404; a signed-out request and an invalid token follow the existing 401", async () => {
    for (const bad of ["not-a-uuid", "../../x", "' or 1=1 --", "11111111-1111-4111-8111-11111111111"]) {
      const out = await scorekeeperAdministrationOf(world.scorer, bad);
      expect(out.status, bad).toBe(404);
      expect(out.text, bad).toBe('{"error":"Scorekeeper access was not found for this competition."}');
    }
    for (const out of [await scorekeeperAdministrationOf(null, world.intA.competitionId), await scorekeeperAdministrationOf(null, world.intA.competitionId, "not-a-real-token")]) {
      expect(out.status).toBe(401);
      expect(out.cache).toBe(NO_STORE);
      expect(out.text).not.toContain(world.intA.name);
    }
  }, 120000);

  it("the addressed competition's own view carries the caller's scorekeeper fixtures — and only theirs", async () => {
    const mine = await viewOf(world.scorer, world.intA.competitionId);
    expect(mine.status).toBe(200);
    expect(mine.view?.myScorekeeperFixtureIds).toEqual([world.intA.sf1]);
    expect((await viewOf(world.scorerNew, world.intA.competitionId)).view?.myScorekeeperFixtureIds).toEqual([world.intA.sf2]);
    for (const [label, person] of [["a plain member", world.plain], ["the organizer", world.operatorA], ["a replaced scorekeeper", world.scorerReplaced], ["an approved-unused host", world.hostUnused]] as Array<[string, Person]>) {
      const out = await viewOf(person, world.intA.competitionId);
      expect(out.status, label).toBe(200);
      expect(out.view?.myScorekeeperFixtureIds, label).toEqual([]);
    }
    expect((await viewOf(world.scorer, world.intB.competitionId)).view?.myScorekeeperFixtureIds).toEqual([]);   // a different competition: none
    // the ordinary view is otherwise what it always was: every fixture is still part of it
    expect(mine.view?.fixtures).toHaveLength(3);
  }, 180000);

  it("a revoked host gains no scorekeeper route by having appointed themselves — in the view or in the route", async () => {
    const pilot = await service.from("competitions").select("competition_id").eq("organizer_gaming_member_id", world.hostSelfScorer.gamingMemberId).single();
    if (pilot.error) throw pilot.error;
    const id = pilot.data.competition_id as string;
    expect((await viewOf(world.hostSelfScorer, id)).view?.myScorekeeperFixtureIds).toEqual([]);
    expect((await scorekeeperAdministrationOf(world.hostSelfScorer, id)).status).toBe(404);
  }, 120000);

  it("the scorekeeper's evidence workflow stays exactly what it was: the assigned fixture's detail is readable, any other fixture's is refused", async () => {
    const token = await tokenFor(world.scorer);
    expect((await adminDetailRoute(bearer(token), { params: { fixtureId: world.intA.sf1 } })).status).toBe(200);
    expect((await adminDetailRoute(bearer(token), { params: { fixtureId: world.intA.sf2 } })).status).toBe(403);
  }, 120000);
});

describe("[boundaries] discovery is unchanged, the defect is reproducible from the general list, and unauthorized actions stay refused", () => {
  it("general member discovery is exactly as before: an open internal competition is listed to every member; a host's private pilot is not", async () => {
    const plain = await generallyListedFor(world.plain);
    expect(plain.status).toBe(200);
    expect(plain.names).toContain(world.intB.name);                 // open internal competition: listed to any signed-in member (unchanged)
    expect(plain.names).toContain(world.intA.name);                 // a published internal competition likewise
    expect(plain.names).not.toContain(world.pilotActive.name);     // a host's private pilot: never enumerable (unchanged)
    const owner = await generallyListedFor(world.hostActive);
    expect(owner.names).toContain(world.pilotActive.name);         // its own organizer still finds it
  }, 120000);

  it("general discovery does not depend on administrative standing: a scorekeeper, a completed-competition organizer and a cancelled pilot's host are all still found where they were", async () => {
    const scorer = await generallyListedFor(world.scorer);
    expect(scorer.names).toContain(world.intA.name);
    expect((await generallyListedFor(world.operatorDone)).names).toContain(world.intDone.name);      // a COMPLETE competition stays ordinarily discoverable
    expect((await generallyListedFor(world.hostCancelled)).names).toContain(world.pilotCancelled.name); // its host still finds their own (ordinary rule for the organizer)
  }, 180000);

  it("NEGATIVE CONTROL: the general list shows an approved host with no role the unrelated open competition; the administrative source shows them nothing", async () => {
    const general = await generallyListedFor(world.hostUnused);
    expect(general.names).toContain(world.intB.name);              // the observed defect, if an organizer page were fed this list
    expect(general.names).toContain(world.intA.name);
    const administered = await administeredBy(world.hostUnused);
    expect(administered.competitions).toEqual([]);
    expect(administered.text).not.toContain(world.intB.name);
  }, 120000);

  it("a scorekeeper receives no organizer power: the server refuses every organizer action and leaves state untouched", async () => {
    const before = { a: await stateOf(world.intA.competitionId), b: await stateOf(world.intB.competitionId) };
    expect(before.b).toBe("TEAM_REGISTRATION_OPEN");
    const token = await tokenFor(world.scorer);
    const reason = { reason: "Unauthorized probe." };
    expect((await cancelRoute(bearer(token, "POST", reason), { params: { competitionId: world.intA.competitionId } })).status).toBe(403);
    expect((await cancelRoute(bearer(token, "POST", reason), { params: { competitionId: world.intB.competitionId } })).status).toBe(403);
    expect(await stateOf(world.intA.competitionId)).toBe(before.a);
    expect(await stateOf(world.intB.competitionId)).toBe(before.b);
  }, 120000);

  it("an approved host with an unused capability, and a plain member, cannot act on an unrelated open competition", async () => {
    for (const person of [world.hostUnused, world.plain]) {
      const res = await cancelRoute(bearer(await tokenFor(person), "POST", { reason: "Unauthorized probe." }), { params: { competitionId: world.intB.competitionId } });
      expect(res.status).toBe(403);
    }
    expect(await stateOf(world.intB.competitionId)).toBe("TEAM_REGISTRATION_OPEN");
  }, 120000);

  it("the read-only routes mutate nothing: every competition, fixture appointment and authority row is exactly as it was after a full round of reads", async () => {
    const snapshot = async () => ({
      competitions: (await service.from("competitions").select("competition_id,state,organizer_gaming_member_id").order("competition_id")).data,
      fixtures: (await service.from("competition_fixtures").select("competition_fixture_id,scorekeeper_gaming_member_id,state").order("competition_fixture_id")).data,
      grants: (await service.from("authority_grants").select("authority_grant_id,revoked_at").order("authority_grant_id")).data,
      capabilities: (await service.from("competition_host_capabilities").select("host_capability_id,state").order("host_capability_id")).data,
    });
    const before = await snapshot();
    for (const person of [world.plain, world.scorer, world.hostActive, world.hostUnused, world.operatorA, world.operatorDone]) {
      await organizerAccessOf(person);
      await administeredBy(person);
      await scorekeeperAdministrationOf(person, world.intA.competitionId);
      await viewOf(person, world.intA.competitionId);
    }
    expect(await snapshot()).toEqual(before);
  }, 300000);
});

// =============================================================================
// Lifecycle and direct-page contract (what each caller can SEE and press, on the real routes)
// =============================================================================

describe("[lifecycle] from application to the first pilot and beyond, on the real routes", () => {
  it("walks one member through every step; Organizer Access and the available operations are right at each one", async () => {
    const walker = await newPerson("Walker");
    const seen: Array<[string, boolean, Operations | undefined, number]> = [];
    const probe = async (step: string) => {
      const access = JSON.parse((await organizerAccessOf(walker)).text).organizerAccess as boolean;
      const admin = await administeredBy(walker);
      seen.push([step, access, admin.operations, admin.competitions.length]);
    };
    await probe("1 plain member");
    const code = await apply(walker, "walker");
    await probe("2 application pending");
    await asGovernance(() => decideHostApplication(hostRepo, reviewer.gamingMemberId, code, "APPROVE", null));
    await probe("3 approved, capability unused, no competition");
    delete process.env.BECOME_A_HOST_SCHEMA_READY;
    await probe("3b the same, applications closed");
    process.env.BECOME_A_HOST_SCHEMA_READY = "true";
    await probe("3c the same, applications open");
    delete process.env.BECOME_A_HOST_SCHEMA_READY;
    const pilot = await createHostCompetition(hostRepo, walker.gamingMemberId, `Pilot Walker ${RUN}`);
    await probe("4 pilot created, running");
    await cancelCompetition(compRepo, pilot.competitionId, walker.gamingMemberId, "Cancelled by the contract suite.");
    await probe("5 pilot cancelled");
    await asGovernance(() => revokeHostCapability(hostRepo, reviewer.gamingMemberId, code, "Rules were not followed."));
    await probe("6 access revoked");
    expect(seen).toEqual([
      ["1 plain member", false, NONE, 0],
      ["2 application pending", false, NONE, 0],
      ["3 approved, capability unused, no competition", false, NONE, 0],
      ["3b the same, applications closed", false, NONE, 0],
      ["3c the same, applications open", false, NONE, 0],
      ["4 pilot created, running", true, NONE, 1],
      ["5 pilot cancelled", false, NONE, 0],
      ["6 access revoked", false, NONE, 0],
    ]);
  }, 300000);

  it("reports each audience with the actual server relationship behind it", async () => {
    const observed: Record<string, boolean> = {};
    const cases: Array<[string, Person]> = [
      ["approved, capability unused, no competition", world.hostUnused],
      ["capability consumed, competition active", world.hostActive],
      ["capability consumed, competition cancelled", world.hostCancelled],
      ["capability revoked", world.hostRevoked],
      ["application rejected", world.rejected],
      ["application withdrawn", world.withdrawn],
      ["application pending", world.applicant],
      ["plain authenticated member", world.plain],
      ["appointed scorekeeper only", world.scorer],
      ["internal organizer, competition complete", world.operatorDone],
      ["internal operator, no competition yet (no new policy: not an applicant, not an organizer)", world.operatorEmpty],
    ];
    for (const [label, person] of cases) observed[label] = JSON.parse((await organizerAccessOf(person)).text).organizerAccess;
    expect(observed).toEqual({
      "approved, capability unused, no competition": false,
      "capability consumed, competition active": true,
      "capability consumed, competition cancelled": false,
      "capability revoked": false,
      "application rejected": false,
      "application withdrawn": false,
      "application pending": false,
      "plain authenticated member": false,
      "appointed scorekeeper only": false,
      "internal organizer, competition complete": false,
      "internal operator, no competition yet (no new policy: not an applicant, not an organizer)": false,
    });
  }, 300000);
});

describe("[direct page] what each caller can see and press — the real pages on the real routes", () => {
  const SIGNED_IN = (person: Person) => ({ status: "authenticated", email: person.email, gamingMemberId: person.gamingMemberId, displayName: "Test Caller" });

  /** Every route either page may call, as the real handlers with the caller's real token. Anything else is a failed request. */
  function routeTransport(): PageTransport {
    return async (req) => {
      const request = new Request(`http://localhost${req.url}`, { method: req.method, headers: req.headers as Record<string, string>, body: req.body });
      let match: RegExpMatchArray | null;
      let res: Response;
      if (req.url === "/api/gaming/competitions/administration") res = await administrationRoute(request);
      else if (req.url.startsWith("/api/gaming/competitions/resolve?")) res = await resolveRoute(request);
      else if ((match = req.url.match(/^\/api\/gaming\/competitions\/([0-9a-f-]{36})\/scorekeeper-administration$/))) res = await scorekeeperAdministrationRoute(request, { params: { competitionId: match[1] } });
      else if ((match = req.url.match(/^\/api\/gaming\/competitions\/fixtures\/([^/]+)\/admin-detail$/))) res = await adminDetailRoute(request, { params: { fixtureId: match[1] } });
      else if ((match = req.url.match(/^\/api\/gaming\/competitions\/([0-9a-f-]{36})$/))) res = await competitionViewRoute(request, { params: { competitionId: match[1] } });
      else return { status: 404, json: { error: `unexpected page request ${req.url}` } };
      return { status: res.status, json: await res.json() };
    };
  }

  async function pageFor(person: Person | null, search = "") {
    return openAdminPage({ auth: person ? SIGNED_IN(person) : { status: "unauthenticated" }, accessToken: person ? await tokenFor(person) : undefined, transport: routeTransport(), search });
  }

  /** What the caller sees the moment the organizer page has finished loading. */
  async function initialControls(person: Person | null): Promise<string[]> {
    const page = await pageFor(person);
    if (person) await page.settle(() => page.requests.some((r) => r.url === "/api/gaming/competitions/administration") && (page.text().length > 0), "the administrative source");
    await new Promise((r) => setTimeout(r, 150));
    const controls = page.controls();
    // Whatever the caller is, the default experience may only ever have asked the administrative source (and a competition they opened).
    expect(page.requests.filter((r) => r.url === "/api/gaming/competitions" && r.method === "GET")).toEqual([]);
    expect(page.requests.filter((r) => r.url.includes("scorekeeper-administration") || r.url.includes("/resolve"))).toEqual([]);
    page.close();
    return controls;
  }

  const NAV_ONLY = ["a[Explore Competitions]", "a[Apply to Host Competitions]"];
  const CREATE_FORM = ["input#c-name", "select#c-activity", "button#btn-create-competition"];
  const FORBIDDEN_FOR_NON_ADMINISTRATORS = ["#c-name", "#c-activity", "#btn-create-competition", "#comp-select", "#btn-load-competition", "#btn-open-registration", "#btn-publish", "#btn-open-cancel", "first-pilot"];

  it("signed out: nothing administrative at all", async () => {
    expect(await initialControls(null)).toEqual([]);
  }, 60000);

  it("every audience without active organizer authority or OPERATIONAL authority sees no creation or organizer control — only the two ways onward", async () => {
    for (const [label, person] of [
      ["plain member", world.plain], ["pending applicant", world.applicant], ["rejected applicant", world.rejected], ["withdrawn applicant", world.withdrawn],
      ["approved applicant whose capability is unused", world.hostUnused], ["scorekeeper only", world.scorer], ["replaced scorekeeper", world.scorerReplaced],
      ["revoked organizer", world.hostRevoked], ["revoked organizer who had appointed themselves scorekeeper", world.hostSelfScorer],
      ["host whose only pilot was cancelled", world.hostCancelled], ["member whose OPERATIONAL authority was revoked", world.operatorRevoked],
    ] as Array<[string, Person]>) {
      const controls = await initialControls(person);
      expect(controls, label).toEqual(NAV_ONLY);
      for (const forbidden of FORBIDDEN_FOR_NON_ADMINISTRATORS) expect(controls.join(" "), `${label} must not see ${forbidden}`).not.toContain(forbidden);
    }
  }, 600000);

  it("an active host organizer sees the selector but NOT the create form; once the pilot is loaded, the organizer controls its state allows", async () => {
    const page = await pageFor(world.hostActive);
    await page.settle(() => page.doc.querySelectorAll("#comp-select option").length === 1, "the selector");
    expect(page.controls()).toEqual(["select#comp-select", "button#btn-load-competition"]);
    (page.doc.getElementById("btn-load-competition") as HTMLButtonElement).click();
    await page.settle(() => (page.doc.getElementById("comp-title")?.textContent ?? "") === world.pilotActive.name, "the pilot");
    expect(page.controls()).toEqual(["select#comp-select", "button#btn-load-competition", "button#btn-open-registration", "button#btn-open-cancel"]);
    page.close();
  }, 120000);

  it("the create form is for the OPERATIONAL authority only — with a running competition, with none, and with only a completed one — and for nobody else", async () => {
    expect(await initialControls(world.operatorEmpty)).toEqual(CREATE_FORM);
    expect(await initialControls(world.operatorDone)).toEqual(CREATE_FORM);                       // the completed competition is not an active target
    expect(await initialControls(world.operatorB)).toEqual([...CREATE_FORM, "select#comp-select", "button#btn-load-competition"]);
  }, 180000);

  it("an organizer's page lists no scorekeeper-only competition, even for an organizer who also scores elsewhere", async () => {
    const page = await pageFor(world.operatorA);
    await page.settle(() => page.doc.querySelectorAll("#comp-select option").length >= 1, "the selector");
    expect([...page.doc.querySelectorAll("#comp-select option")].map((o) => o.textContent)).toEqual([`${world.intA.name} (In progress)`]);
    page.close();
  }, 60000);

  describe("the scorekeeper journey: from the ONE addressed competition, to its assigned fixtures", () => {
    async function memberPageFor(person: Person, competitionId: string) {
      const found = await compRepo.getCompetitionById(competitionId);
      const code = found!.publicCode;
      const page = await openMemberPage({ auth: SIGNED_IN(person), accessToken: await tokenFor(person), transport: routeTransport(), search: `?c=${code}` });
      await page.settle(() => (page.doc.getElementById("content")?.textContent ?? "").includes(found!.name), "the addressed competition");
      await new Promise((r) => setTimeout(r, 30));
      return { page, code };
    }

    it("the addressed competition offers the action to the scorekeeper — and not to the organizer, a plain member, a replaced scorekeeper, or in another competition", async () => {
      const mine = await memberPageFor(world.scorer, world.intA.competitionId);
      const action = mine.page.doc.getElementById("scorekeeper-action") as HTMLAnchorElement | null;
      expect(action).not.toBeNull();
      expect(action!.getAttribute("href")).toBe(`/competitions-admin.html?c=${mine.code}`);
      mine.page.close();
      for (const [label, person, competitionId] of [
        ["the organizer", world.operatorA, world.intA.competitionId], ["a plain member", world.plain, world.intA.competitionId],
        ["a replaced scorekeeper", world.scorerReplaced, world.intA.competitionId], ["the scorekeeper, in a competition they do not score in", world.scorer, world.intB.competitionId],
      ] as Array<[string, Person, string]>) {
        const { page } = await memberPageFor(person, competitionId);
        expect(page.doc.getElementById("scorekeeper-action"), label).toBeNull();
        page.close();
      }
    }, 300000);

    it("following the action: only that competition and its assigned fixture; the evidence workflow only; and the default source is never asked", async () => {
      const { code } = await memberPageFor(world.scorer, world.intA.competitionId).then(async (r) => { r.page.close(); return r; });
      const page = await pageFor(world.scorer, `?c=${code}`);
      await page.settle(() => page.doc.querySelectorAll("#fixtures-list .btn-load-detail").length === 1, "the assigned fixture");
      expect(page.controls()).toEqual(["button[Load Fixture Detail]"]);
      expect(page.doc.getElementById("comp-title")!.textContent).toBe(world.intA.name);
      expect(page.requests.map((r) => r.url)).toEqual([`/api/gaming/competitions/resolve?c=${code}`, `/api/gaming/competitions/${world.intA.competitionId}/scorekeeper-administration`]);
      (page.doc.querySelector("#fixtures-list .btn-load-detail") as HTMLButtonElement).click();
      await page.settle(() => page.doc.querySelector("#fixtures-list fieldset") !== null, "the fixture detail");
      expect([...page.doc.querySelectorAll("#fixtures-list legend")].map((l) => l.textContent)).toEqual(["Submit Evidence (Scorekeeper)"]);
      const controls = page.controls().join(" ");
      for (const organizerOnly of ["btn-appoint", "btn-correct", "btn-finalize", "btn-forfeit", "btn-void", "btn-dispute", "btn-open-registration", "btn-publish", "btn-open-cancel", "btn-create-competition", "comp-select"]) {
        expect(controls, organizerOnly).not.toContain(organizerOnly);
      }
      page.close();
    }, 180000);

    it("the same link, followed by anyone not currently appointed in that competition, opens nothing and reveals nothing", async () => {
      const found = await compRepo.getCompetitionById(world.intA.competitionId);
      for (const [label, person] of [
        ["a plain member", world.plain], ["the organizer", world.operatorA], ["a replaced scorekeeper", world.scorerReplaced], ["an approved-unused host", world.hostUnused],
      ] as Array<[string, Person]>) {
        const page = await pageFor(person, `?c=${found!.publicCode}`);
        await page.settle(() => (page.doc.getElementById("admin-gate")?.textContent ?? "").length > 0, "the closed state");
        expect(page.doc.getElementById("admin-gate")!.textContent, label).toBe("You are not currently appointed to score any fixture in this competition.");
        expect(page.controls(), label).toEqual([]);
        expect(page.text(), label).not.toContain(world.intA.name);
        page.close();
      }
    }, 300000);
  });
});
