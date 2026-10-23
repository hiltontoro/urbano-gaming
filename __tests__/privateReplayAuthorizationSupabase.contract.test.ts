import { randomUUID } from "node:crypto";

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
import { finalizeFixture } from "../lib/gaming/competitions/finalizeFixture";
import { forfeitFixture } from "../lib/gaming/competitions/forfeitFixture";
import { voidFixture } from "../lib/gaming/competitions/voidFixture";
import { CompetitionAccessDeniedError, FixtureNotReadyToFinalizeError, HostAccessRevokedError, InvalidForfeitingTeamError } from "../lib/gaming/competitions/types";
import type { GoalEventInput, ParticipationAttestationInput } from "../lib/gaming/competitions/types";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";

/**
 * UG-CR-GATE-091 Correction B — authorization BEFORE the idempotent replay, against real local Postgres.
 *
 * finalize_competition_fixture_atomically, forfeit_competition_fixture_atomically and void_competition_fixture_atomically used to answer a
 * replay before they asked who was calling. A non-NULL authenticated stranger who knew a finalized fixture's id therefore received the
 * existing finalization id and outcome (and, for void, the competition's state) through the service route — incompatible with private
 * competitions. They now lock and load the fixture, derive its competition and authorized organizer, and validate the exact caller (and a
 * host's capability) BEFORE returning either a replay or a new result. Proven here for all three functions:
 *
 *  1 the valid organizer's replay succeeds and stays idempotent      5 a denial discloses nothing of the private result
 *  2 an unrelated authenticated member's replay is denied            6 a denial leaves zero new rows or audit events
 *  3 an organizer of another competition is denied                   7 negative controls that reproduce the previous disclosure
 *  4 a revoked host's replay is denied
 *
 * plus: NULL callers, the same bounded refusal whether or not a result exists, unchanged lifecycle / cancellation / result behavior for
 * authorized callers, and concurrency. Synthetic identities are unique per run; a database reset restores a clean state.
 */

const env = loadEnv("development", process.cwd(), "");
const supabaseUrl = env.SUPABASE_URL;
requireLocalSupabase(supabaseUrl);
const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAnonKey = env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey || !supabaseAnonKey) {
  throw new Error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are required for contract tests.");
}

// Raw pg holds a lock across statements, races real connections, and runs rolled-back negative controls. The URL is supplied explicitly,
// never read from .env.local, and must be loopback.
const supabaseDbUrl = process.env.COMPETITIONS_LOCAL_DB_URL ?? "";
if (!/^postgresql:\/\/[^@]+@(127\.0\.0\.1|localhost|\[::1\]):\d+\//.test(supabaseDbUrl)) {
  throw new Error("COMPETITIONS_LOCAL_DB_URL must be set to a loopback Postgres URL for private-replay contract tests.");
}

const compRepo = new SupabaseCompetitionsRepository(supabaseUrl, supabaseServiceRoleKey);
const hostRepo = new SupabaseHostRepository(supabaseUrl, supabaseServiceRoleKey);
const gamingRepo = new SupabaseGamingRepository(supabaseUrl, supabaseServiceRoleKey);
const serviceClient = createClient(supabaseUrl, supabaseServiceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

const RUN = randomUUID().slice(0, 8);
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const DENIED = /COMPETITION_ACCESS_DENIED/;
const REVOKED = /HOST_ACCESS_REVOKED/;

interface Member { authUserId: string; gamingMemberId: string }
const createdAuthUserIds: string[] = [];
const grantedMemberIds: string[] = [];
let reviewer: Member;
let counter = 0;

async function createMember(displayName: string): Promise<Member> {
  const email = `replay-auth-${RUN}-${counter++}-${randomUUID().slice(0, 6)}@example.com`;
  const { data, error } = await serviceClient.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("Failed to create test auth user.");
  createdAuthUserIds.push(data.user.id);
  const member = await gamingRepo.createGamingMember(data.user.id, displayName);
  return { authUserId: data.user.id, gamingMemberId: member.gamingMemberId };
}

async function grantOperational(memberId: string): Promise<void> {
  const { error } = await serviceClient.from("authority_grants").insert({ gaming_member_id: memberId, authority_class: "OPERATIONAL" });
  if (error) throw error;
  grantedMemberIds.push(memberId);
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

// Best effort only: finalizations and audit rows pin their members, so a failed delete is expected and silent by design. A database
// reset restores a clean state, and this file's identities are unique per run.
afterAll(async () => {
  for (let i = 0; i < grantedMemberIds.length; i += 50) {
    await serviceClient.from("authority_grants").delete().in("gaming_member_id", grantedMemberIds.slice(i, i + 50));
  }
  for (const id of createdAuthUserIds) await serviceClient.auth.admin.deleteUser(id);
}, 300000);

// -----------------------------------------------------------------------------------------------------------------------------
// World
// -----------------------------------------------------------------------------------------------------------------------------

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
interface Bracket { competitionId: string; organizerId: string; teams: Team[]; sf1: string; sf2: string; final: string; hostCode?: string; rosters: string[][]; cursor: number[] }

let hostNumber = 0;
/** A published four-team bracket run either by an internal OPERATIONAL organizer or by an approved host in their ONE bound pilot. */
async function buildBracket(label: string, kind: "internal" | "host"): Promise<Bracket> {
  let organizerId: string;
  let competitionId: string;
  let hostCode: string | undefined;
  if (kind === "internal") {
    const operator = await createMember(`${label} Operator`);
    await grantOperational(operator.gamingMemberId);
    const created = await createCompetition(compRepo, operator.gamingMemberId, `Replay ${label} ${RUN}`, "SOCCER_5V5");
    organizerId = operator.gamingMemberId;
    competitionId = created.competitionId;
  } else {
    const host = await createMember(`${label} Host`);
    const application = await submitHostApplication(hostRepo, host.gamingMemberId, {
      venueName: `Replay Venue ${label} ${RUN} ${hostNumber++}`, cityArea: "Fictional Heights", playingFields: 1,
      venueDescription: "A fictional venue used only by the private-replay contract suite for local testing.",
      expectedWindow: "soon", expectedTeamCount: 4, confirmAllAdults: true, confirmIndependentScorekeepers: true, confirmPilotExclusions: true,
    });
    await withGovernance(() => decideHostApplication(hostRepo, reviewer.gamingMemberId, application.publicCode, "APPROVE", null));
    const pilot = await createHostCompetition(hostRepo, host.gamingMemberId, `Replay Pilot ${label} ${RUN}`);
    organizerId = host.gamingMemberId;
    competitionId = pilot.competitionId;
    hostCode = application.publicCode;
  }
  await saveFixturePlan(competitionId, organizerId);
  await openTeamRegistration(compRepo, competitionId, organizerId);
  const teams: Team[] = [];
  for (let i = 0; i < 4; i++) {
    const captainId = (await createMember(`${label} Captain ${i}`)).gamingMemberId;
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
  return { competitionId, organizerId, teams, sf1: published.semifinal1FixtureId, sf2: published.semifinal2FixtureId, final: published.finalFixtureId, hostCode, rosters, cursor: [0, 0, 0, 0] };
}

async function memberOnTeam(b: Bracket, teamIndex: number, _label: string): Promise<string> {
  return nextFrozenMember(b.rosters, b.cursor, teamIndex);
}

/** Rosters declared, a scorekeeper appointed and valid evidence submitted on semifinal 1: ready to finalize. */
async function submitEvidence(b: Bracket, label: string): Promise<void> {
  const a: string[] = [];
  const bMembers: string[] = [];
  for (let i = 0; i < 5; i++) a.push(await memberOnTeam(b, 0, `${label}-A${i}`));
  for (let i = 0; i < 5; i++) bMembers.push(await memberOnTeam(b, 1, `${label}-B${i}`));
  await declareRoster(compRepo, b.sf1, b.teams[0].competitionTeamId, b.teams[0].captainId, false, null, a);
  await declareRoster(compRepo, b.sf1, b.teams[1].competitionTeamId, b.teams[1].captainId, false, null, bMembers);
  const scorekeeper = (await createMember(`${label} Scorekeeper`)).gamingMemberId;
  await appointScorekeeper(compRepo, b.sf1, b.organizerId, scorekeeper);
  const goals: GoalEventInput[] = [
    { scorerGamingMemberId: a[0], competitionTeamId: b.teams[0].competitionTeamId },
    { scorerGamingMemberId: a[1], competitionTeamId: b.teams[0].competitionTeamId },
  ];
  const attestations: ParticipationAttestationInput[] = [...a, ...bMembers].map((gamingMemberId) => ({ gamingMemberId, actuallyParticipated: true }));
  const out = await submitFixtureEvidence(compRepo, b.sf1, scorekeeper, 2, 0, goals, [], attestations, null);
  expect(out.fixtureState).toBe("EVIDENCE_SUBMITTED");
}

// -----------------------------------------------------------------------------------------------------------------------------
// The three operations
// -----------------------------------------------------------------------------------------------------------------------------

type Row = Record<string, any>;
interface Op {
  name: "finalize" | "forfeit" | "void";
  fn: string;
  sig: string;
  denial: string; // the function's own bounded refusal
  prepare(b: Bracket, label: string): Promise<void>;
  rpc(b: Bracket, actor: string | null): ReturnType<typeof serviceClient.rpc>;
  raw(b: Bracket): { text: string; params: unknown[] }; // the same call with a NULL-able actor in $2
  useCase(b: Bracket, actor: string): Promise<unknown>;
  /** What a replay would disclose: the finalization id plus the outcome-bearing columns. */
  secrets(row: Row): string[];
}
const OPS: Op[] = [
  {
    name: "finalize", fn: "finalize_competition_fixture_atomically", sig: "finalize_competition_fixture_atomically(uuid, uuid)", denial: "only the organizer may finalize a fixture",
    prepare: (b, label) => submitEvidence(b, label),
    rpc: (b, actor) => serviceClient.rpc("finalize_competition_fixture_atomically", { p_competition_fixture_id: b.sf1, p_organizer_gaming_member_id: actor }),
    raw: (b) => ({ text: "select * from finalize_competition_fixture_atomically($1, $2)", params: [b.sf1] }),
    useCase: (b, actor) => finalizeFixture(compRepo, b.sf1, actor),
    secrets: (row) => [row.competition_fixture_finalization_id, row.winning_competition_team_id, row.outcome_type].filter(Boolean),
  },
  {
    name: "forfeit", fn: "forfeit_competition_fixture_atomically", sig: "forfeit_competition_fixture_atomically(uuid, uuid, uuid, text)", denial: "only the organizer may forfeit a fixture",
    prepare: async () => {},
    rpc: (b, actor) => serviceClient.rpc("forfeit_competition_fixture_atomically", { p_competition_fixture_id: b.sf1, p_organizer_gaming_member_id: actor, p_forfeiting_competition_team_id: b.teams[0].competitionTeamId, p_reason: "Team did not arrive." }),
    raw: (b) => ({ text: `select * from forfeit_competition_fixture_atomically($1, $2, '${b.teams[0].competitionTeamId}', 'Team did not arrive.')`, params: [b.sf1] }),
    useCase: (b, actor) => forfeitFixture(compRepo, b.sf1, actor, b.teams[0].competitionTeamId, "Team did not arrive."),
    secrets: (row) => [row.competition_fixture_finalization_id, row.winning_competition_team_id].filter(Boolean),
  },
  {
    name: "void", fn: "void_competition_fixture_atomically", sig: "void_competition_fixture_atomically(uuid, uuid, text)", denial: "only the organizer may void a fixture",
    prepare: async () => {},
    rpc: (b, actor) => serviceClient.rpc("void_competition_fixture_atomically", { p_competition_fixture_id: b.sf1, p_organizer_gaming_member_id: actor, p_reason: "Pitch unavailable." }),
    raw: (b) => ({ text: "select * from void_competition_fixture_atomically($1, $2, 'Pitch unavailable.')", params: [b.sf1] }),
    useCase: (b, actor) => voidFixture(compRepo, b.sf1, actor, "Pitch unavailable."),
    secrets: (row) => [row.competition_fixture_finalization_id, row.competition_state].filter(Boolean),
  },
];

const firstRow = (data: unknown): Row => (Array.isArray(data) ? data[0] : data) as Row;
const msg = (r: { error: { message?: string } | null }) => r.error?.message ?? "";

const finalizationRows = async (fixtureId: string) => {
  const { count, error } = await serviceClient.from("competition_fixture_finalizations").select("*", { count: "exact", head: true }).eq("competition_fixture_id", fixtureId);
  if (error) throw error;
  return count ?? 0;
};
/** Everything a denied attempt could have touched. */
async function footprint(b: Bracket) {
  const { data: fixture } = await serviceClient.from("competition_fixtures").select("state").eq("competition_fixture_id", b.sf1).single();
  const { data: competition } = await serviceClient.from("competitions").select("state").eq("competition_id", b.competitionId).single();
  const { count: audit } = await serviceClient.from("admin_audit_events").select("*", { count: "exact", head: true }).eq("target_id", b.competitionId);
  const { count: disputes } = await serviceClient.from("competition_disputes").select("*", { count: "exact", head: true }).eq("competition_fixture_id", b.sf1).not("resolved_at", "is", null);
  const { count: finals } = await serviceClient.from("competition_fixture_finalizations").select("*", { count: "exact", head: true }).eq("competition_fixture_id", b.sf1);
  return { fixtureState: fixture!.state, competitionState: competition!.state, audit: audit ?? 0, resolvedDisputes: disputes ?? 0, finalizations: finals ?? 0 };
}

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
/** The previous behavior: the idempotent replay answered BEFORE the authorization block. */
const ORG_AND_REPLAY = /(  -- UG-CR-GATE-091: authorization comes BEFORE[\s\S]*?perform assert_competition_not_host_revoked\(v_competition_id\);\n\n)(  select competition_fixture_finalizations\.[\s\S]*?  if v_existing_finalization_id is not null then\n    return query [^\n]*\n    return;\n  end if;\n\n)/;
const replayBeforeAuthorization = (def: string) => def.replace(ORG_AND_REPLAY, (_m, org: string, replay: string) => replay + org);
const withoutHostGuard = (def: string) => def.replace("  perform assert_competition_not_host_revoked(v_competition_id);\n", "");
const bareComparison = (def: string) => def.replace("p_organizer_gaming_member_id is distinct from v_organizer_id", "p_organizer_gaming_member_id <> v_organizer_id");

async function waitUntilBlockedOnLock(observer: Client, backendPid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { rows } = await observer.query("select wait_event_type from pg_stat_activity where pid = $1", [backendPid]);
    if (rows[0]?.wait_event_type === "Lock") return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("The statement never blocked on a lock.");
}

let other: Bracket; // a different competition with its own organizer
beforeAll(async () => {
  reviewer = await createMember("Replay Reviewer");
  other = await buildBracket("replayOther", "internal");
}, 240000);

// =============================================================================================================================
// Inventory and ordering
// =============================================================================================================================

describe("inventory: authorization precedes the replay in all three functions, by construction", () => {
  it("each has exactly one signature, is SECURITY DEFINER with search_path=public, and only service_role can execute it", async () => {
    const db = await connectRaw();
    try {
      for (const op of OPS) {
        const { rows } = await db.query(`select p.oid, p.prosecdef, p.proconfig::text as cfg from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1`, [op.fn]);
        expect(rows, op.fn).toHaveLength(1);
        expect(rows[0].prosecdef).toBe(true);
        expect(rows[0].cfg).toContain("search_path=public");
        for (const role of ["anon", "authenticated"]) {
          const { rows: x } = await db.query("select has_function_privilege($1, $2::oid, 'EXECUTE') as ok", [role, rows[0].oid]);
          expect(x[0].ok, `${role} ${op.fn}`).toBe(false);
        }
        const { rows: pub } = await db.query(`select count(*)::int as n from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = $1::oid and a.grantee = 0 and a.privilege_type = 'EXECUTE'`, [rows[0].oid]);
        expect(pub[0].n).toBe(0);
        const { rows: svc } = await db.query("select has_function_privilege('service_role', $1::oid, 'EXECUTE') as ok", [rows[0].oid]);
        expect(svc[0].ok).toBe(true);
      }
    } finally {
      await db.end();
    }
  }, 30000);

  it("order: scope lock → fixture row lock → organizer derived from the fixture's own competition → exact-caller check → host revocation guard → REPLAY → cancellation check → first write", async () => {
    const db = await connectRaw();
    try {
      for (const op of OPS) {
        const def = await functionDefinition(db, op.sig);
        const at = (needle: string | RegExp) => (typeof needle === "string" ? def.indexOf(needle) : def.search(needle));
        const lock = at("pg_advisory_xact_lock(hashtext('competition_scope:'");
        const rowLock = at("for update");
        const organizerLookup = at("select competitions.organizer_gaming_member_id, competitions.state");
        const exactCaller = at("p_organizer_gaming_member_id is distinct from v_organizer_id");
        const hostGuard = at("perform assert_competition_not_host_revoked(v_competition_id)");
        const replaySelect = at("from competition_fixture_finalizations");
        const replayReturn = at("return query select v_existing_finalization_id");
        const cancelled = at("COMPETITION_CANCELLED");
        const firstWrite = at(/insert\s+into\s+competition_fixture_finalizations/i);
        const order = { lock, rowLock, organizerLookup, exactCaller, hostGuard, replaySelect, replayReturn, cancelled, firstWrite };
        for (const [name, i] of Object.entries(order)) expect(i, `${op.fn} ${name}`).toBeGreaterThan(-1);
        const values = Object.values(order);
        expect(values, `${op.fn}: ${JSON.stringify(order)}`).toEqual([...values].sort((x, y) => x - y));
        expect((def.match(/p_organizer_gaming_member_id is distinct from v_organizer_id/g) ?? []).length).toBe(1);
        expect(def, "the GATE-090 explicit NULL test was folded into the exact-caller check").not.toContain("if p_organizer_gaming_member_id is null then");
        expect(def).not.toMatch(/p_organizer_gaming_member_id\s*(<>|!=)/);
        expect((def.match(new RegExp(`COMPETITION_ACCESS_DENIED: ${op.denial}`, "g")) ?? []).length, `${op.fn} has exactly one denial`).toBe(1);
      }
    } finally {
      await db.end();
    }
  }, 30000);
});

// =============================================================================================================================
// Per operation
// =============================================================================================================================

describe.each(OPS)("$name", (op) => {
  let A: Bracket; // run by an internal organizer; the operation is performed in the first test and replayed after
  let U: Bracket; // run by an internal organizer; nothing has been finalized
  let first: Row;
  let stranger: string;

  beforeAll(async () => {
    A = await buildBracket(`${op.name}A`, "internal");
    await op.prepare(A, `${op.name}A`);
    U = await buildBracket(`${op.name}U`, "internal");
    await op.prepare(U, `${op.name}U`);
    stranger = (await createMember(`${op.name} Stranger`)).gamingMemberId;
  }, 300000);

  it("[1] the VALID ORGANIZER's first call creates the result and the retry is IDEMPOTENT: same finalization, already_finalized, no second row", async () => {
    const a = await op.rpc(A, A.organizerId);
    expect(a.error).toBeNull();
    first = firstRow(a.data);
    expect(first.already_finalized).toBe(false);
    expect(first.competition_fixture_finalization_id).toBeTruthy();
    expect(await finalizationRows(A.sf1)).toBe(1);
    for (let i = 0; i < 2; i++) {
      const again = await op.rpc(A, A.organizerId);
      expect(again.error).toBeNull();
      const row = firstRow(again.data);
      expect(row.already_finalized).toBe(true);
      expect(row.competition_fixture_finalization_id).toBe(first.competition_fixture_finalization_id);
    }
    expect(await finalizationRows(A.sf1)).toBe(1);
    // The typed use-case path agrees.
    expect(await op.useCase(A, A.organizerId)).toMatchObject({ alreadyFinalized: true, competitionFixtureFinalizationId: first.competition_fixture_finalization_id });
  }, 120000);

  it("[2] an UNRELATED AUTHENTICATED MEMBER's replay is DENIED — through the RPC and through the typed service path", async () => {
    const out = await op.rpc(A, stranger);
    expect(msg(out)).toBe(`COMPETITION_ACCESS_DENIED: ${op.denial}`);
    expect(out.data).toBeNull();
    await expectRejection(op.useCase(A, stranger), CompetitionAccessDeniedError);
  }, 60000);

  it("[3] an ORGANIZER FROM ANOTHER COMPETITION is denied; so is the team's own captain, and a NULL caller", async () => {
    expect(msg(await op.rpc(A, other.organizerId))).toBe(`COMPETITION_ACCESS_DENIED: ${op.denial}`);
    await expectRejection(op.useCase(A, other.organizerId), CompetitionAccessDeniedError);
    expect(msg(await op.rpc(A, A.teams[0].captainId))).toBe(`COMPETITION_ACCESS_DENIED: ${op.denial}`);
    const nullCaller = await op.rpc(A, null);
    expect(msg(nullCaller)).toBe(`COMPETITION_ACCESS_DENIED: ${op.denial}`);
    expect(nullCaller.data).toBeNull();
  }, 60000);

  it("[5] a denial DISCLOSES NOTHING: it is the same bounded refusal whether or not a result exists, and carries no finalization id, winner, outcome or competition state", async () => {
    const onFinalized = await op.rpc(A, stranger);
    const onUnfinalized = await op.rpc(U, stranger);
    expect(msg(onFinalized)).toBe(msg(onUnfinalized)); // the response cannot tell a private result exists
    expect(JSON.stringify({ data: onFinalized.data, error: onFinalized.error })).toBe(JSON.stringify({ data: onUnfinalized.data, error: onUnfinalized.error }));
    const wire = JSON.stringify({ data: onFinalized.data, error: onFinalized.error });
    for (const secret of op.secrets(first)) expect(wire, `a denial leaked ${String(secret).slice(0, 8)}…`).not.toContain(String(secret));
    expect(wire).not.toMatch(/NORMAL|FORFEIT|VOID|CANCELLED_WITHOUT_CHAMPION|finalization|already_finalized|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}/);
    // Every kind of caller who is not the organizer sees that same refusal.
    for (const actor of [other.organizerId, A.teams[1].captainId, null]) {
      expect(msg(await op.rpc(A, actor))).toBe(msg(onFinalized));
      expect(msg(await op.rpc(U, actor))).toBe(msg(onFinalized));
    }
  }, 120000);

  it("[6] a denial leaves ZERO new rows or audit events: finalizations, fixture and competition state, audit events and resolved disputes are all unchanged", async () => {
    const before = await footprint(A);
    const beforeU = await footprint(U);
    for (const actor of [stranger, other.organizerId, A.teams[0].captainId, null]) {
      for (let i = 0; i < 2; i++) {
        expect(msg(await op.rpc(A, actor))).toMatch(DENIED);
        expect(msg(await op.rpc(U, actor))).toMatch(DENIED);
      }
    }
    expect(await footprint(A)).toEqual(before);
    expect(await footprint(U)).toEqual(beforeU);
    expect(beforeU.finalizations).toBe(0);
  }, 120000);

  it("authorized behavior is UNCHANGED: lifecycle refusals reach the organizer, and the organizer's replay still returns the existing result after the competition has been cancelled", async () => {
    // Lifecycle (organizer on the un-finalized bracket): the existing refusals, not an authorization error.
    if (op.name === "finalize") {
      const noEvidence = await buildBracket("finalizeNoEvidence", "internal");
      await expectRejection(finalizeFixture(compRepo, noEvidence.sf1, noEvidence.organizerId), FixtureNotReadyToFinalizeError);
    }
    if (op.name === "forfeit") {
      await expectRejection(forfeitFixture(compRepo, U.sf1, U.organizerId, A.teams[2].competitionTeamId, "Not a team of this fixture."), InvalidForfeitingTeamError);
    }
    // Replay after cancellation: the authorized caller still gets the existing result (the replay precedes the cancellation check, as before).
    if (op.name !== "void") await voidFixture(compRepo, A.sf2, A.organizerId, "Cancelling the competition via the other semifinal.");
    const { data: competition } = await serviceClient.from("competitions").select("state").eq("competition_id", A.competitionId).single();
    expect(competition!.state).toBe("CANCELLED_WITHOUT_CHAMPION");
    const replay = await op.rpc(A, A.organizerId);
    expect(replay.error).toBeNull();
    expect(firstRow(replay.data)).toMatchObject({ already_finalized: true, competition_fixture_finalization_id: first.competition_fixture_finalization_id });
    // …and the stranger on that cancelled competition learns nothing about it either.
    expect(msg(await op.rpc(A, stranger))).toBe(`COMPETITION_ACCESS_DENIED: ${op.denial}`);
  }, 240000);

  it("[7] NEGATIVE CONTROL — with the replay put back BEFORE the authorization, the previous disclosure returns: a stranger is handed the finalization id and outcome", async () => {
    const db = await connectRaw();
    try {
      const { text, params } = op.raw(A);
      await expect(db.query(text, [...params, stranger])).rejects.toThrow(DENIED);
      await db.query("begin");
      await mutate(db, op.sig, replayBeforeAuthorization);
      const leaked = await db.query(text, [...params, stranger]);
      const row = leaked.rows[0];
      expect(row.already_finalized).toBe(true);
      expect(row.competition_fixture_finalization_id).toBe(first.competition_fixture_finalization_id); // the private finalization id
      for (const secret of op.secrets(firstRow(leaked.rows))) expect(secret).toBeTruthy();
      if (op.name === "finalize") { expect(row.outcome_type).toBe("NORMAL"); expect(row.winning_competition_team_id).toBeTruthy(); }
      if (op.name === "forfeit") expect(row.winning_competition_team_id).toBe(A.teams[1].competitionTeamId);
      if (op.name === "void") expect(row.competition_state).toBe("CANCELLED_WITHOUT_CHAMPION");
      // A NULL caller is handed it as well, which is what GATE-090 had to patch around.
      const leakedToNull = await db.query(text, [...params, null]);
      expect(leakedToNull.rows[0].already_finalized).toBe(true);
      await db.query("rollback");
      await expect(db.query(text, [...params, stranger])).rejects.toThrow(DENIED); // restored
    } finally {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  }, 120000);

  it("[7b] NEGATIVE CONTROL — with the bare `<>` put back (authorization still first), a NULL caller passes the check and is handed the existing result: the null-safe comparison matters on the replay path", async () => {
    const db = await connectRaw();
    try {
      const { text, params } = op.raw(A);
      await expect(db.query(text, [...params, null])).rejects.toThrow(DENIED);
      await db.query("begin");
      await mutate(db, op.sig, bareComparison);
      const out = await db.query(text, [...params, null]);
      expect(out.rows[0].already_finalized).toBe(true);
      await db.query("rollback");
    } finally {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  }, 120000);

  it("[4] a REVOKED HOST's replay is DENIED (HOST_ACCESS_REVOKED) while the capability's own earlier replay was answered; a stranger is denied throughout; and removing the guard reproduces the old disclosure", async () => {
    const H = await buildBracket(`${op.name}H`, "host");
    await op.prepare(H, `${op.name}H`);
    const done = await op.rpc(H, H.organizerId);
    expect(done.error).toBeNull();
    const hostFirst = firstRow(done.data);
    expect(hostFirst.already_finalized).toBe(false);
    // While the capability stands the host's retry is idempotent, a stranger is denied, and a foreign organizer is denied.
    const replay = await op.rpc(H, H.organizerId);
    expect(firstRow(replay.data)).toMatchObject({ already_finalized: true, competition_fixture_finalization_id: hostFirst.competition_fixture_finalization_id });
    expect(msg(await op.rpc(H, stranger))).toBe(`COMPETITION_ACCESS_DENIED: ${op.denial}`);
    expect(msg(await op.rpc(H, other.organizerId))).toBe(`COMPETITION_ACCESS_DENIED: ${op.denial}`);

    await withGovernance(() => revokeHostCapability(hostRepo, reviewer.gamingMemberId, H.hostCode!, "Private-replay suite: revoke."));
    const before = await footprint(H);
    const afterRevoke = await op.rpc(H, H.organizerId);
    expect(msg(afterRevoke)).toMatch(REVOKED);
    expect(afterRevoke.data).toBeNull();
    await expectRejection(op.useCase(H, H.organizerId), HostAccessRevokedError);
    expect(msg(await op.rpc(H, stranger))).toBe(`COMPETITION_ACCESS_DENIED: ${op.denial}`); // not "revoked": a stranger learns nothing about the host
    expect(msg(await op.rpc(H, null))).toBe(`COMPETITION_ACCESS_DENIED: ${op.denial}`);
    expect(await footprint(H)).toEqual(before);

    // Control: with the revocation guard removed, the revoked host's retry is answered again.
    const db = await connectRaw();
    try {
      const { text, params } = op.raw(H);
      await db.query("begin");
      await mutate(db, op.sig, withoutHostGuard);
      const answered = await db.query(text, [...params, H.organizerId]);
      expect(answered.rows[0].already_finalized).toBe(true);
      expect(answered.rows[0].competition_fixture_finalization_id).toBe(hostFirst.competition_fixture_finalization_id);
      await db.query("rollback");
      await expect(db.query(text, [...params, H.organizerId])).rejects.toThrow(REVOKED);
    } finally {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  }, 400000);
});

// =============================================================================================================================
// Concurrency
// =============================================================================================================================

describe("concurrency", () => {
  it("two simultaneous calls by the organizer create exactly ONE result and ONE idempotent replay; a stranger racing them is always denied", async () => {
    for (let round = 0; round < 3; round++) {
      const b = await buildBracket(`race${round}`, "internal");
      const stranger = (await createMember("Race Stranger")).gamingMemberId;
      const call = (actor: string | null) => `select * from forfeit_competition_fixture_atomically('${b.sf1}', ${actor ? `'${actor}'` : "null"}, '${b.teams[0].competitionTeamId}', 'Team did not arrive.')`;
      const conns: Client[] = [];
      for (let i = 0; i < 4; i++) conns.push(await connectRaw());
      try {
        const outcomes = await Promise.allSettled([conns[0].query(call(b.organizerId)), conns[1].query(call(b.organizerId)), conns[2].query(call(stranger)), conns[3].query(call(null))]);
        expect(outcomes[0].status).toBe("fulfilled");
        expect(outcomes[1].status).toBe("fulfilled");
        const flags = [outcomes[0], outcomes[1]].map((o) => (o as PromiseFulfilledResult<any>).value.rows[0].already_finalized).sort();
        expect(flags, `round ${round}: one new result and one replay`).toEqual([false, true]);
        for (const i of [2, 3]) {
          expect(outcomes[i].status).toBe("rejected");
          expect((outcomes[i] as PromiseRejectedResult).reason.message).toBe("COMPETITION_ACCESS_DENIED: only the organizer may forfeit a fixture");
        }
        expect(await finalizationRows(b.sf1)).toBe(1);
      } finally {
        await Promise.all(conns.map((c) => c.end()));
      }
    }
  }, 300000);

  it("DETERMINISTIC: a stranger waiting on the competition's scope lock while the organizer's result commits is DENIED when it runs — the result that appeared meanwhile is never shown to them", async () => {
    const b = await buildBracket("lockproof", "internal");
    const stranger = (await createMember("Lock Stranger")).gamingMemberId;
    const holder = await connectRaw();
    const waiter = await connectRaw();
    const observer = await connectRaw();
    const call = (actor: string) => `select * from forfeit_competition_fixture_atomically('${b.sf1}', '${actor}', '${b.teams[0].competitionTeamId}', 'Team did not arrive.')`;
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtext('competition_scope:' || $1::text))", [b.competitionId]);
      const { rows: pid } = await waiter.query("select pg_backend_pid() as pid");
      const waiting = waiter.query(call(stranger)).then(() => "ANSWERED", (e: Error) => e.message);
      await waitUntilBlockedOnLock(observer, pid[0].pid);
      const made = await holder.query(call(b.organizerId)); // re-entrant on the held lock: the organizer's result is created while the stranger waits
      expect(made.rows[0].already_finalized).toBe(false);
      await holder.query("commit");
      expect(await waiting).toBe("COMPETITION_ACCESS_DENIED: only the organizer may forfeit a fixture");
      expect(await finalizationRows(b.sf1)).toBe(1);
    } finally {
      await holder.query("rollback").catch(() => {});
      await Promise.all([holder.end(), waiter.end(), observer.end()]);
    }
  }, 180000);
});

// =============================================================================================================================
// The controls left no trace
// =============================================================================================================================

describe("the negative controls left no trace", () => {
  it("all three functions still authorize before the replay, still compare null-safely, still keep the host guard, and keep exactly their grants", async () => {
    const db = await connectRaw();
    try {
      for (const op of OPS) {
        const def = await functionDefinition(db, op.sig);
        expect(def.indexOf("p_organizer_gaming_member_id is distinct from v_organizer_id")).toBeLessThan(def.indexOf("return query select v_existing_finalization_id"));
        expect(def.indexOf("perform assert_competition_not_host_revoked(v_competition_id)")).toBeLessThan(def.indexOf("return query select v_existing_finalization_id"));
        const { rows } = await db.query(
          `select has_function_privilege('service_role', p.oid, 'EXECUTE') as svc, has_function_privilege('anon', p.oid, 'EXECUTE') as anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1`, [op.fn]);
        expect(rows[0]).toEqual({ svc: true, anon: false, auth: false });
      }
    } finally {
      await db.end();
    }
  }, 30000);
});
