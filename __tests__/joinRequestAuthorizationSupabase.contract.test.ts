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
import { addCompetitionTeam } from "../lib/gaming/competitions/addCompetitionTeam";
import { registerForCompetition } from "../lib/gaming/competitions/registerForCompetition";
import { requestJoinTeam } from "../lib/gaming/competitions/requestJoinTeam";
import { decideJoinRequest } from "../lib/gaming/competitions/decideJoinRequest";
import { organizerReviewJoinRequest } from "../lib/gaming/competitions/organizerReviewJoinRequest";
import { cancelCompetition } from "../lib/gaming/competitions/cancelCompetition";
import {
  CompetitionAccessDeniedError,
  CompetitionCancelledError,
  HostAccessRevokedError,
  JoinRequestAlreadyReviewedError,
  JoinRequestNotPendingError,
  NotTeamCaptainError,
} from "../lib/gaming/competitions/types";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";

/**
 * UG-CR-GATE-091 Correction A — the two remaining null-unsafe join-request functions, against real local Postgres.
 *
 * decide_join_request_atomically and organizer_review_join_request_atomically compared the caller with `<>`. For a NULL caller that is
 * NULL, PL/pgSQL treats a NULL condition as false, and the denial was skipped: a NULL caller could record a decision with no
 * authorization at all. Each comparison is now `IS DISTINCT FROM`. These tests prove, for both functions: a NULL caller is refused before
 * any decision or write; the organizer override requires the EXACT organizer of that request's competition; a captain decision requires
 * the EXACT captain of the request's target team; a host acts only inside the competition bound to them and stops on revocation; valid
 * actors behave exactly as before (lifecycle, cancellation guard, return shape, idempotency); concurrent attempts leave one consistent
 * outcome; every denial leaves zero residual writes; and — through rolled-back negative controls that put the defect back — that these
 * tests would notice if it returned.
 *
 * Neither function has an idempotent replay: a decided request raises JOIN_REQUEST_NOT_PENDING, an already-reviewed one raises
 * JOIN_REQUEST_ALREADY_REVIEWED, so no earlier return can answer a NULL caller. UG-CR-GATE-092 (the last describe block) additionally proves
 * decide_join_request_atomically authorizes BEFORE it says anything about the request's lifecycle: an unauthorized caller holding a request id
 * gets the same bounded denial whether the request is pending, decided, attached to a cancelled competition, or does not exist. Synthetic
 * identities are unique per run; a database reset restores a clean state.
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
  throw new Error("COMPETITIONS_LOCAL_DB_URL must be set to a loopback Postgres URL for join-request contract tests.");
}

const compRepo = new SupabaseCompetitionsRepository(supabaseUrl, supabaseServiceRoleKey);
const hostRepo = new SupabaseHostRepository(supabaseUrl, supabaseServiceRoleKey);
const gamingRepo = new SupabaseGamingRepository(supabaseUrl, supabaseServiceRoleKey);
const serviceClient = createClient(supabaseUrl, supabaseServiceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

const RUN = randomUUID().slice(0, 8);
const DENIED = /COMPETITION_ACCESS_DENIED/;
const NOT_CAPTAIN = /NOT_TEAM_CAPTAIN/;
const NOT_PENDING = /JOIN_REQUEST_NOT_PENDING/;

interface Member { authUserId: string; gamingMemberId: string }
const createdAuthUserIds: string[] = [];
const grantedMemberIds: string[] = [];
let reviewer: Member;
let counter = 0;

async function createMember(displayName: string): Promise<Member> {
  const email = `join-auth-${RUN}-${counter++}-${randomUUID().slice(0, 6)}@example.com`;
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

// Best effort only: rows these flows create pin their members, so a failed delete is expected and silent by design. A database reset
// restores a clean state, and this file's identities are unique per run.
afterAll(async () => {
  for (let i = 0; i < grantedMemberIds.length; i += 50) {
    await serviceClient.from("authority_grants").delete().in("gaming_member_id", grantedMemberIds.slice(i, i + 50));
  }
  for (const id of createdAuthUserIds) await serviceClient.auth.admin.deleteUser(id);
}, 240000);

// -----------------------------------------------------------------------------------------------------------------------------
// World
// -----------------------------------------------------------------------------------------------------------------------------

interface Team { id: string; captainId: string }
interface Comp { competitionId: string; organizerId: string; teamA: Team; teamB: Team }

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

/** A competition with registration open and two accepted teams, run by an internal OPERATIONAL organizer. */
async function buildCompetition(label: string): Promise<Comp> {
  const operator = await createMember(`${label} Operator`);
  await grantOperational(operator.gamingMemberId);
  const created = await createCompetition(compRepo, operator.gamingMemberId, `JoinAuth ${label} ${RUN}`, "SOCCER_5V5");
  await saveFixturePlan(created.competitionId, operator.gamingMemberId);
  await openTeamRegistration(compRepo, created.competitionId, operator.gamingMemberId);
  const teams: Team[] = [];
  for (const letter of ["A", "B"]) {
    const captainId = (await createMember(`${label} Captain ${letter}`)).gamingMemberId;
    const team = await addCompetitionTeam(compRepo, created.competitionId, operator.gamingMemberId, `${label} Team ${letter} ${RUN}`, captainId);
    teams.push({ id: team.competitionTeamId, captainId });
  }
  return { competitionId: created.competitionId, organizerId: operator.gamingMemberId, teamA: teams[0], teamB: teams[1] };
}

/** A registered member who has asked to join the team: a REQUESTED join request. */
async function newRequest(comp: Comp, team: Team): Promise<{ requestId: string; memberId: string }> {
  const member = await createMember("Requester");
  await registerForCompetition(compRepo, comp.competitionId, member.gamingMemberId, true);
  const request = await requestJoinTeam(compRepo, comp.competitionId, team.id, member.gamingMemberId);
  return { requestId: request.competitionJoinRequestId, memberId: member.gamingMemberId };
}

/** A request the team's captain has REJECTED — the only kind the organizer may review. */
async function rejectedRequest(comp: Comp, team: Team): Promise<{ requestId: string; memberId: string }> {
  const r = await newRequest(comp, team);
  await decideJoinRequest(compRepo, r.requestId, team.captainId, "REJECT", false);
  return r;
}

let hostNumber = 0;
/** An approved host with their ONE bound pilot, registration open, and a team of their own (the host is its captain). */
async function buildHostPilot(label: string) {
  const member = await createMember(`Host ${label}`);
  const application = await submitHostApplication(hostRepo, member.gamingMemberId, {
    venueName: `Join Venue ${label} ${RUN} ${hostNumber++}`, cityArea: "Fictional Heights", playingFields: 1,
    venueDescription: "A fictional venue used only by the join-request contract suite for local testing.",
    expectedWindow: "soon", expectedTeamCount: 4, confirmAllAdults: true, confirmIndependentScorekeepers: true, confirmPilotExclusions: true,
  });
  await withGovernance(() => decideHostApplication(hostRepo, reviewer.gamingMemberId, application.publicCode, "APPROVE", null));
  const pilot = await createHostCompetition(hostRepo, member.gamingMemberId, `Join Pilot ${label} ${RUN}`);
  await saveFixturePlan(pilot.competitionId, member.gamingMemberId);
  await openTeamRegistration(compRepo, pilot.competitionId, member.gamingMemberId);
  const ownTeam = await addCompetitionTeam(compRepo, pilot.competitionId, member.gamingMemberId, `Host Team ${label} ${RUN}`, member.gamingMemberId);
  const otherCaptain = (await createMember(`${label} Pilot Captain`)).gamingMemberId;
  const otherTeam = await addCompetitionTeam(compRepo, pilot.competitionId, member.gamingMemberId, `Pilot Team ${label} ${RUN}`, otherCaptain);
  const comp: Comp = {
    competitionId: pilot.competitionId, organizerId: member.gamingMemberId,
    teamA: { id: ownTeam.competitionTeamId, captainId: member.gamingMemberId },
    teamB: { id: otherTeam.competitionTeamId, captainId: otherCaptain },
  };
  return { hostId: member.gamingMemberId, code: application.publicCode, comp };
}

const requestRow = async (id: string) => {
  const { data, error } = await serviceClient.from("competition_join_requests")
    .select("status, decided_by_gaming_member_id, decided_at, organizer_reviewed_at, organizer_reviewed_by_gaming_member_id").eq("competition_join_request_id", id).single();
  if (error) throw error;
  return data!;
};
const membershipRows = async (competitionId: string, memberId: string) => {
  const { count, error } = await serviceClient.from("competition_team_memberships").select("*", { count: "exact", head: true }).eq("competition_id", competitionId).eq("gaming_member_id", memberId);
  if (error) throw error;
  return count ?? 0;
};
const auditRows = async (competitionId: string) => {
  const { count, error } = await serviceClient.from("admin_audit_events").select("*", { count: "exact", head: true }).eq("target_id", competitionId);
  if (error) throw error;
  return count ?? 0;
};

/** Everything a denied attempt could have touched, snapshotted: the request row, the requester's membership, and the competition's audit events. */
async function snapshot(comp: Comp, r: { requestId: string; memberId: string }) {
  return { row: await requestRow(r.requestId), memberships: await membershipRows(comp.competitionId, r.memberId), audit: await auditRows(comp.competitionId) };
}

const decideRpc = (requestId: string, actor: string | null, decision: "APPROVE" | "REJECT", override: boolean) =>
  serviceClient.rpc("decide_join_request_atomically", { p_competition_join_request_id: requestId, p_deciding_gaming_member_id: actor, p_decision: decision, p_is_organizer_override: override });
const reviewRpc = (requestId: string, actor: string | null, decision: "APPROVE" | "REJECT", reason = "Organizer review probe") =>
  serviceClient.rpc("organizer_review_join_request_atomically", { p_competition_join_request_id: requestId, p_organizer_gaming_member_id: actor, p_decision: decision, p_reason: reason });
const msg = (r: { error: { message?: string } | null }) => r.error?.message ?? "";

const DECIDE_SIG = "decide_join_request_atomically(uuid, uuid, text, boolean)";
const REVIEW_SIG = "organizer_review_join_request_atomically(uuid, uuid, text, text)";

async function functionDefinition(db: Client, signature: string): Promise<string> {
  const { rows } = await db.query("select pg_get_functiondef($1::regprocedure) as def", [signature]);
  return rows[0].def as string;
}
/** Redefines the function inside the caller's open transaction; the mutation must change the text or the control proves nothing. */
async function mutate(db: Client, signature: string, edit: (def: string) => string): Promise<void> {
  const original = await functionDefinition(db, signature);
  const edited = edit(original);
  expect(edited, "the mutation must actually change the function (otherwise the control proves nothing)").not.toBe(original);
  await db.query(edited);
}

let X: Comp;
let Y: Comp;
let hostPilot: Awaited<ReturnType<typeof buildHostPilot>>;
beforeAll(async () => {
  reviewer = await createMember("Join Reviewer");
  X = await buildCompetition("joinX");
  Y = await buildCompetition("joinY");
  hostPilot = await buildHostPilot("jh");
}, 240000);

// =============================================================================================================================
// Inventory
// =============================================================================================================================

describe("inventory: both functions, every active signature, before and after", () => {
  it("each has exactly ONE signature (no overload, no compatibility copy), is SECURITY DEFINER with search_path=public, and only service_role can execute it", async () => {
    const db = await connectRaw();
    try {
      for (const name of ["decide_join_request_atomically", "organizer_review_join_request_atomically"]) {
        const { rows } = await db.query(
          `select p.oid, p.prosecdef, p.proconfig::text as cfg from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1`, [name]);
        expect(rows, `${name} must have exactly one signature`).toHaveLength(1);
        expect(rows[0].prosecdef).toBe(true);
        expect(rows[0].cfg).toContain("search_path=public");
        for (const role of ["anon", "authenticated"]) {
          const { rows: x } = await db.query("select has_function_privilege($1, $2::oid, 'EXECUTE') as ok", [role, rows[0].oid]);
          expect(x[0].ok, `${role} must not execute ${name}`).toBe(false);
        }
        const { rows: pub } = await db.query(
          `select count(*)::int as n from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = $1::oid and a.grantee = 0 and a.privilege_type = 'EXECUTE'`, [rows[0].oid]);
        expect(pub[0].n).toBe(0);
        const { rows: svc } = await db.query("select has_function_privilege('service_role', $1::oid, 'EXECUTE') as ok", [rows[0].oid]);
        expect(svc[0].ok).toBe(true);
      }
      // Nothing else in the schema is a join-request decision entrypoint under another name.
      const { rows: others } = await db.query(
        `select p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f'
            and pg_get_functiondef(p.oid) ~* 'update\\s+(public\\.)?competition_join_requests\\s+set\\s+status' order by 1`);
      expect(others.map((r) => r.proname)).toEqual(["decide_join_request_atomically", "organizer_review_join_request_atomically"]);
    } finally {
      await db.end();
    }
  }, 30000);

  // Scope, stated exactly: every function in schema `public`, but ONLY the PARAMETER-FIRST order `p_..gaming_member_id <> v_..` (or `!=`).
  // The order `v_.. <> p_..gaming_member_id` is not matched here; the both-order scan, with its coverage stated and self-tested, is in
  // nullSafeOrganizerAuthorizationSupabase.contract.test.ts (GATE-094). An earlier title claimed more than this query covers.
  it("no function in schema `public` has the PARAMETER-FIRST bare form `p_..gaming_member_id <> v_..` (or `!=`); the join-request functions use IS DISTINCT FROM — the both-order scan is in the GATE-094 section of the null-safe organizer file", async () => {
    const db = await connectRaw();
    try {
      const { rows } = await db.query(`select p.proname, pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f'`);
      expect(rows.length, "the scan must really cover the schema").toBeGreaterThan(50);
      expect(rows.map((r) => r.proname)).toEqual(expect.arrayContaining(["decide_join_request_atomically", "finalize_competition_fixture_atomically", "declare_competition_roster_atomically"]));
      const offenders = rows.filter((r) => /p_[a-z_]*gaming_member_id\s*(<>|!=)\s*v_[a-z_]+/.test((r.def as string).replace(/--.*$/gm, ""))).map((r) => r.proname as string);
      expect(offenders).toEqual([]);
      const decide = rows.find((r) => r.proname === "decide_join_request_atomically")!.def as string;
      expect(decide).toMatch(/p_deciding_gaming_member_id is distinct from v_organizer_id/);
      expect(decide).toMatch(/p_deciding_gaming_member_id is distinct from v_captain_id/);
      expect(rows.find((r) => r.proname === "organizer_review_join_request_atomically")!.def as string).toMatch(/p_organizer_gaming_member_id is distinct from v_organizer_id/);
    } finally {
      await db.end();
    }
  }, 30000);

  it("the authorization decision still sits after the scope lock and the row lock and BEFORE the first write, in both functions, and the host revocation guard still follows the organizer check", async () => {
    const db = await connectRaw();
    try {
      for (const signature of [DECIDE_SIG, REVIEW_SIG]) {
        const def = await functionDefinition(db, signature);
        const lock = def.indexOf("pg_advisory_xact_lock(hashtext('competition_scope:'");
        const rowLock = def.indexOf("for update");
        const organizer = def.search(/is distinct from v_organizer_id/);
        const guard = def.indexOf("assert_competition_not_host_revoked(v_competition_id)");
        const firstWrite = def.search(/\n\s*update competition_join_requests/);
        for (const [name, i] of Object.entries({ lock, rowLock, organizer, guard, firstWrite })) expect(i, `${signature} ${name}`).toBeGreaterThan(-1);
        expect(lock).toBeLessThan(rowLock);
        expect(rowLock).toBeLessThan(organizer);
        expect(organizer).toBeLessThan(guard);
        expect(guard).toBeLessThan(firstWrite);
      }
      const decide = await functionDefinition(db, DECIDE_SIG);
      expect(decide.search(/is distinct from v_captain_id/)).toBeLessThan(decide.search(/\n\s*update competition_join_requests/));
    } finally {
      await db.end();
    }
  }, 30000);
});

// =============================================================================================================================
// decide_join_request_atomically
// =============================================================================================================================

describe("decide_join_request_atomically", () => {
  it("a NULL caller is refused in BOTH branches (captain: NOT_TEAM_CAPTAIN, organizer override: COMPETITION_ACCESS_DENIED) before any decision, with zero residual writes", async () => {
    const r = await newRequest(X, X.teamA);
    const before = await snapshot(X, r);
    expect(before.row.status).toBe("REQUESTED");
    for (const decision of ["APPROVE", "REJECT"] as const) {
      expect(msg(await decideRpc(r.requestId, null, decision, false)), `captain branch ${decision}`).toMatch(NOT_CAPTAIN);
      expect(msg(await decideRpc(r.requestId, null, decision, true)), `override branch ${decision}`).toMatch(DENIED);
    }
    expect(await snapshot(X, r)).toEqual(before);
    expect((await requestRow(r.requestId)).decided_by_gaming_member_id).toBeNull();
  }, 120000);

  it("an UNRELATED ORGANIZER is refused: the organizer of another competition, and the real organizer acting without the override flag (the captain branch requires the exact captain)", async () => {
    const r = await newRequest(X, X.teamA);
    const before = await snapshot(X, r);
    expect(msg(await decideRpc(r.requestId, Y.organizerId, "APPROVE", true))).toMatch(DENIED);
    expect(msg(await decideRpc(r.requestId, Y.organizerId, "REJECT", false))).toMatch(NOT_CAPTAIN);
    expect(msg(await decideRpc(r.requestId, X.organizerId, "APPROVE", false))).toMatch(NOT_CAPTAIN);
    await expectRejection(decideJoinRequest(compRepo, r.requestId, Y.organizerId, "APPROVE", true), CompetitionAccessDeniedError);
    expect(await snapshot(X, r)).toEqual(before);
  }, 120000);

  it("an UNRELATED CAPTAIN is refused: another team's captain in the same competition, a captain in another competition, the requester themselves, and a captain who claims the override", async () => {
    const r = await newRequest(X, X.teamA);
    const before = await snapshot(X, r);
    expect(msg(await decideRpc(r.requestId, X.teamB.captainId, "APPROVE", false))).toMatch(NOT_CAPTAIN);
    expect(msg(await decideRpc(r.requestId, Y.teamA.captainId, "APPROVE", false))).toMatch(NOT_CAPTAIN);
    expect(msg(await decideRpc(r.requestId, r.memberId, "APPROVE", false))).toMatch(NOT_CAPTAIN);
    expect(msg(await decideRpc(r.requestId, X.teamA.captainId, "APPROVE", true))).toMatch(DENIED); // the captain is not the organizer
    await expectRejection(decideJoinRequest(compRepo, r.requestId, X.teamB.captainId, "REJECT", false), NotTeamCaptainError);
    expect(await snapshot(X, r)).toEqual(before);
  }, 120000);

  it("a CROSS-COMPETITION HOST is refused: an approved host cannot override a join request outside their bound pilot, nor decide as the captain of their own pilot's team", async () => {
    const r = await newRequest(X, X.teamA);
    const before = await snapshot(X, r);
    expect(msg(await decideRpc(r.requestId, hostPilot.hostId, "APPROVE", true))).toMatch(DENIED);
    expect(msg(await decideRpc(r.requestId, hostPilot.hostId, "APPROVE", false))).toMatch(NOT_CAPTAIN); // captain of ANOTHER competition's team
    expect(await snapshot(X, r)).toEqual(before);
    // …and inside the pilot the same host holds exactly the authority of the exact organizer.
    const own = await newRequest(hostPilot.comp, hostPilot.comp.teamB);
    expect(msg(await decideRpc(own.requestId, hostPilot.hostId, "REJECT", true))).toBe("");
    expect((await requestRow(own.requestId)).status).toBe("REJECTED");
  }, 180000);

  it("a VALID CAPTAIN decides their own team's request (approve creates the membership, reject does not), and the return shape is unchanged", async () => {
    const a = await newRequest(X, X.teamA);
    const approved = await decideRpc(a.requestId, X.teamA.captainId, "APPROVE", false);
    expect(approved.error).toBeNull();
    const row = (approved.data as Array<Record<string, unknown>>)[0];
    expect(Object.keys(row).sort()).toEqual(["competition_join_request_id", "competition_team_membership_id", "decided_at", "status"]);
    expect(row.status).toBe("APPROVED");
    expect(row.competition_team_membership_id).toBeTruthy();
    expect(await membershipRows(X.competitionId, a.memberId)).toBe(1);
    expect((await requestRow(a.requestId)).decided_by_gaming_member_id).toBe(X.teamA.captainId);
    const b = await newRequest(X, X.teamB);
    const rejected = await decideJoinRequest(compRepo, b.requestId, X.teamB.captainId, "REJECT", false);
    expect(rejected).toMatchObject({ status: "REJECTED", competitionTeamMembershipId: null });
    expect(await membershipRows(X.competitionId, b.memberId)).toBe(0);
  }, 180000);

  it("a VALID ORGANIZER overrides (approve and reject), recorded against the organizer", async () => {
    const a = await newRequest(X, X.teamA);
    const approved = await decideJoinRequest(compRepo, a.requestId, X.organizerId, "APPROVE", true);
    expect(approved.status).toBe("APPROVED");
    expect((await requestRow(a.requestId)).decided_by_gaming_member_id).toBe(X.organizerId);
    expect(await membershipRows(X.competitionId, a.memberId)).toBe(1);
    const b = await newRequest(X, X.teamB);
    expect((await decideJoinRequest(compRepo, b.requestId, X.organizerId, "REJECT", true)).status).toBe("REJECTED");
  }, 180000);

  it("REPLAY (a second decision): the AUTHORIZED captain and organizer are refused with JOIN_REQUEST_NOT_PENDING, and every UNAUTHORIZED caller — NULL, a foreign organizer, a stranger — gets the bounded denial instead, so a decided request is never confirmed to them", async () => {
    const r = await newRequest(X, X.teamA);
    await decideJoinRequest(compRepo, r.requestId, X.teamA.captainId, "APPROVE", false);
    const before = await snapshot(X, r);
    // Authorized: the lifecycle refusal, exactly as before.
    await expectRejection(decideJoinRequest(compRepo, r.requestId, X.teamA.captainId, "APPROVE", false), JoinRequestNotPendingError);
    await expectRejection(decideJoinRequest(compRepo, r.requestId, X.organizerId, "REJECT", true), JoinRequestNotPendingError);
    // Unauthorized (UG-CR-GATE-092): the denial, never "not pending" — GATE-091 had left this lifecycle response in front of the authorization.
    expect(msg(await decideRpc(r.requestId, null, "REJECT", false))).toMatch(NOT_CAPTAIN);
    expect(msg(await decideRpc(r.requestId, null, "REJECT", true))).toMatch(DENIED);
    expect(msg(await decideRpc(r.requestId, Y.organizerId, "REJECT", true))).toMatch(DENIED);
    expect(msg(await decideRpc(r.requestId, Y.teamA.captainId, "REJECT", false))).toMatch(NOT_CAPTAIN);
    for (const text of [msg(await decideRpc(r.requestId, null, "REJECT", false)), msg(await decideRpc(r.requestId, Y.organizerId, "REJECT", true))]) expect(text).not.toMatch(NOT_PENDING);
    expect(await snapshot(X, r)).toEqual(before);
  }, 180000);

  it("the cancellation guard is preserved, and the host revocation guard still blocks a revoked host's organizer override (participant roles are unaffected, by design)", async () => {
    const z = await buildCompetition("joinZ");
    const r = await newRequest(z, z.teamA);
    await cancelCompetition(compRepo, z.competitionId, z.organizerId, "Cancelled for the join-request suite.");
    await expectRejection(decideJoinRequest(compRepo, r.requestId, z.teamA.captainId, "APPROVE", false), CompetitionCancelledError);
    await expectRejection(decideJoinRequest(compRepo, r.requestId, z.organizerId, "APPROVE", true), CompetitionCancelledError);
    expect((await requestRow(r.requestId)).status).toBe("REQUESTED");

    const h = await buildHostPilot("jr1");
    const mine = await newRequest(h.comp, h.comp.teamB);
    const other = await newRequest(h.comp, h.comp.teamB);
    await decideJoinRequest(compRepo, mine.requestId, h.hostId, "REJECT", true); // works while the capability stands
    await withGovernance(() => revokeHostCapability(hostRepo, reviewer.gamingMemberId, h.code, "Join-request suite: revoke."));
    await expectRejection(decideJoinRequest(compRepo, other.requestId, h.hostId, "APPROVE", true), HostAccessRevokedError);
    expect((await requestRow(other.requestId)).status).toBe("REQUESTED");
    expect(msg(await decideRpc(other.requestId, null, "APPROVE", true))).toMatch(DENIED);
    // A participant's own authority survives revocation: the non-host captain of the pilot's team still decides.
    expect((await decideJoinRequest(compRepo, other.requestId, h.comp.teamB.captainId, "APPROVE", false)).status).toBe("APPROVED");
  }, 300000);

  it("CONCURRENCY: captain, organizer and two NULL callers racing on one request leave exactly one consistent outcome, and no NULL caller ever succeeds", async () => {
    const callers: Client[] = [];
    for (let i = 0; i < 4; i++) callers.push(await connectRaw());
    try {
      for (let round = 0; round < 5; round++) {
        const r = await newRequest(X, X.teamA);
        const outcomes = await Promise.allSettled([
          callers[0].query("select * from decide_join_request_atomically($1, $2, 'APPROVE', false)", [r.requestId, X.teamA.captainId]),
          callers[1].query("select * from decide_join_request_atomically($1, $2, 'REJECT', true)", [r.requestId, X.organizerId]),
          callers[2].query("select * from decide_join_request_atomically($1, null, 'APPROVE', false)", [r.requestId]),
          callers[3].query("select * from decide_join_request_atomically($1, null, 'REJECT', true)", [r.requestId]),
        ]);
        expect(outcomes[2].status, `round ${round}: a NULL captain-branch caller must be refused`).toBe("rejected");
        expect(outcomes[3].status, `round ${round}: a NULL override caller must be refused`).toBe("rejected");
        const winners = [outcomes[0], outcomes[1]].filter((o) => o.status === "fulfilled");
        expect(winners, `round ${round}: exactly one real decision wins`).toHaveLength(1);
        const loser = [outcomes[0], outcomes[1]].find((o) => o.status === "rejected") as PromiseRejectedResult;
        expect(loser.reason.message).toMatch(NOT_PENDING);
        const row = await requestRow(r.requestId);
        const captainWon = outcomes[0].status === "fulfilled";
        expect(row.status).toBe(captainWon ? "APPROVED" : "REJECTED");
        expect(row.decided_by_gaming_member_id).toBe(captainWon ? X.teamA.captainId : X.organizerId);
        expect(await membershipRows(X.competitionId, r.memberId)).toBe(captainWon ? 1 : 0);
      }
    } finally {
      await Promise.all(callers.map((c) => c.end()));
    }
  }, 240000);

  it("CONCURRENCY (deterministic): a NULL caller waiting on the competition's scope lock is refused when it runs, never answered, even though a real decision committed meanwhile", async () => {
    const r = await newRequest(X, X.teamA);
    const holder = await connectRaw();
    const nullCaller = await connectRaw();
    const observer = await connectRaw();
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtext('competition_scope:' || $1::text))", [X.competitionId]);
      const { rows: pid } = await nullCaller.query("select pg_backend_pid() as pid");
      const waiting = nullCaller.query("select * from decide_join_request_atomically($1, null, 'APPROVE', false)", [r.requestId]).then(() => "answered", (e: Error) => e.message);
      await waitUntilBlockedOnLock(observer, pid[0].pid);
      await holder.query("select * from decide_join_request_atomically($1, $2, 'APPROVE', false)", [r.requestId, X.teamA.captainId]); // re-entrant on the held lock
      await holder.query("commit");
      expect(await waiting).toMatch(NOT_CAPTAIN); // the bounded denial, not "not pending": authorization comes before the lifecycle
      expect(await membershipRows(X.competitionId, r.memberId)).toBe(1);
      expect((await requestRow(r.requestId)).decided_by_gaming_member_id).toBe(X.teamA.captainId);
    } finally {
      await holder.query("rollback").catch(() => {});
      await Promise.all([holder.end(), nullCaller.end(), observer.end()]);
    }
  }, 120000);
});

// =============================================================================================================================
// organizer_review_join_request_atomically
// =============================================================================================================================

describe("organizer_review_join_request_atomically", () => {
  it("a NULL organizer is refused at the authorization boundary, with zero residual writes, and the request stays rejected and un-reviewed", async () => {
    const r = await rejectedRequest(X, X.teamA);
    const before = await snapshot(X, r);
    for (const decision of ["APPROVE", "REJECT"] as const) expect(msg(await reviewRpc(r.requestId, null, decision))).toMatch(DENIED);
    expect(await snapshot(X, r)).toEqual(before);
    expect(before.row).toMatchObject({ status: "REJECTED", organizer_reviewed_at: null, organizer_reviewed_by_gaming_member_id: null });
  }, 120000);

  it("everyone who is not the EXACT organizer of the request's competition is refused: another competition's organizer, the team's captain, the requester, a stranger, and a cross-competition host", async () => {
    const r = await rejectedRequest(X, X.teamA);
    const stranger = (await createMember("Review Stranger")).gamingMemberId;
    const before = await snapshot(X, r);
    for (const [label, actor] of [["organizer of another competition", Y.organizerId], ["the team's captain", X.teamA.captainId], ["another team's captain", X.teamB.captainId], ["the requester", r.memberId], ["a stranger", stranger], ["a host outside their pilot", hostPilot.hostId]] as const) {
      expect(msg(await reviewRpc(r.requestId, actor, "APPROVE")), label).toMatch(DENIED);
    }
    await expectRejection(organizerReviewJoinRequest(compRepo, r.requestId, Y.organizerId, "APPROVE", "Not mine to review."), CompetitionAccessDeniedError);
    expect(await snapshot(X, r)).toEqual(before);
  }, 180000);

  it("the VALID ORGANIZER reviews exactly once (approve creates the membership, recorded against them), the return shape is unchanged, and a second review is JOIN_REQUEST_ALREADY_REVIEWED", async () => {
    const r = await rejectedRequest(X, X.teamA);
    const out = await reviewRpc(r.requestId, X.organizerId, "APPROVE");
    expect(out.error).toBeNull();
    const row = (out.data as Array<Record<string, unknown>>)[0];
    expect(Object.keys(row).sort()).toEqual(["competition_join_request_id", "competition_team_membership_id", "organizer_reviewed_at", "status"]);
    expect(row.status).toBe("APPROVED");
    expect(await membershipRows(X.competitionId, r.memberId)).toBe(1);
    expect((await requestRow(r.requestId)).organizer_reviewed_by_gaming_member_id).toBe(X.organizerId);
    expect(msg(await reviewRpc(r.requestId, X.organizerId, "REJECT", "Second review."))).toMatch(/JOIN_REQUEST_NOT_REJECTED/); // an approved request is no longer reviewable
    // A review that leaves the request rejected uses up the single review.
    const q = await rejectedRequest(X, X.teamB);
    expect(msg(await reviewRpc(q.requestId, X.organizerId, "REJECT"))).toBe("");
    await expectRejection(organizerReviewJoinRequest(compRepo, q.requestId, X.organizerId, "APPROVE", "A second review."), JoinRequestAlreadyReviewedError);
  }, 240000);

  it("an unauthorized caller is NOT told whether the request was already reviewed: the denial comes first, identical for a reviewed and an un-reviewed request, NULL included", async () => {
    const fresh = await rejectedRequest(X, X.teamA);
    const used = await rejectedRequest(X, X.teamA);
    await reviewRpc(used.requestId, X.organizerId, "REJECT");
    const stranger = (await createMember("Review Stranger 2")).gamingMemberId;
    for (const actor of [stranger, Y.organizerId, null]) {
      const a = msg(await reviewRpc(fresh.requestId, actor, "APPROVE"));
      const b = msg(await reviewRpc(used.requestId, actor, "APPROVE"));
      expect(a).toMatch(DENIED);
      expect(b).toBe(a);
      expect(b).not.toMatch(/ALREADY_REVIEWED|NOT_REJECTED/);
    }
  }, 180000);

  it("the cancellation guard is preserved and the revoked host is stopped (HOST_ACCESS_REVOKED) while the NULL caller is still refused first", async () => {
    const z = await buildCompetition("reviewZ");
    const r = await rejectedRequest(z, z.teamA);
    await cancelCompetition(compRepo, z.competitionId, z.organizerId, "Cancelled for the review suite.");
    await expectRejection(organizerReviewJoinRequest(compRepo, r.requestId, z.organizerId, "APPROVE", "Too late."), CompetitionCancelledError);
    expect(msg(await reviewRpc(r.requestId, null, "APPROVE"))).toMatch(DENIED);

    const h = await buildHostPilot("jr2");
    const hr = await rejectedRequest(h.comp, h.comp.teamB);
    await withGovernance(() => revokeHostCapability(hostRepo, reviewer.gamingMemberId, h.code, "Review suite: revoke."));
    await expectRejection(organizerReviewJoinRequest(compRepo, hr.requestId, h.hostId, "APPROVE", "After revoke."), HostAccessRevokedError);
    expect((await requestRow(hr.requestId)).organizer_reviewed_at).toBeNull();
  }, 300000);

  it("CONCURRENCY: two organizer reviews and two NULL callers racing leave exactly one review, consistent state, and no NULL caller ever succeeds", async () => {
    const callers: Client[] = [];
    for (let i = 0; i < 4; i++) callers.push(await connectRaw());
    try {
      for (let round = 0; round < 4; round++) {
        const r = await rejectedRequest(X, X.teamB);
        const outcomes = await Promise.allSettled([
          callers[0].query("select * from organizer_review_join_request_atomically($1, $2, 'APPROVE', 'race a')", [r.requestId, X.organizerId]),
          callers[1].query("select * from organizer_review_join_request_atomically($1, $2, 'REJECT', 'race b')", [r.requestId, X.organizerId]),
          callers[2].query("select * from organizer_review_join_request_atomically($1, null, 'APPROVE', 'race c')", [r.requestId]),
          callers[3].query("select * from organizer_review_join_request_atomically($1, null, 'REJECT', 'race d')", [r.requestId]),
        ]);
        expect(outcomes[2].status).toBe("rejected");
        expect(outcomes[3].status).toBe("rejected");
        expect((outcomes[2] as PromiseRejectedResult).reason.message).toMatch(DENIED);
        expect((outcomes[3] as PromiseRejectedResult).reason.message).toMatch(DENIED);
        const winners = [outcomes[0], outcomes[1]].filter((o) => o.status === "fulfilled");
        expect(winners, `round ${round}: exactly one review wins`).toHaveLength(1);
        const approveWon = outcomes[0].status === "fulfilled";
        const row = await requestRow(r.requestId);
        expect(row.status).toBe(approveWon ? "APPROVED" : "REJECTED");
        expect(row.organizer_reviewed_by_gaming_member_id).toBe(X.organizerId);
        expect(await membershipRows(X.competitionId, r.memberId)).toBe(approveWon ? 1 : 0);
      }
    } finally {
      await Promise.all(callers.map((c) => c.end()));
    }
  }, 240000);
});

// =============================================================================================================================
// UG-CR-GATE-092 — decide_join_request_atomically authorizes BEFORE any lifecycle or not-found response
// =============================================================================================================================

const CAPTAIN_DENIAL = "NOT_TEAM_CAPTAIN: only this team's own captain may decide this request";
const OVERRIDE_DENIAL = "COMPETITION_ACCESS_DENIED: only the organizer may override a join-request decision";
const LIFECYCLE_OR_NOT_FOUND = /JOIN_REQUEST_NOT_PENDING|COMPETITION_CANCELLED|JOIN_REQUEST_NOT_FOUND|already been decided|cancelled|no such/i;

// The old ordering, rebuilt from today's function text: the lifecycle checks BEFORE the organizer/captain check (and "not found" for a missing request).
const NOT_PENDING_BLOCK = "  if v_current_status <> 'REQUESTED' then\n    raise exception 'JOIN_REQUEST_NOT_PENDING: this join request has already been decided' using errcode = 'P0001';\n  end if;\n\n";
const CANCELLED_BLOCK = "  if v_competition_state = 'CANCELLED_WITHOUT_CHAMPION' then\n    raise exception 'COMPETITION_CANCELLED: this competition has been cancelled and no longer accepts this action'\n      using errcode = 'P0001';\n  end if;\n\n";
const ORG_SELECT_BLOCK = "  select competitions.organizer_gaming_member_id, competitions.state\n    into v_organizer_id, v_competition_state\n    from competitions where competitions.competition_id = v_competition_id;\n\n";
const BRANCH_DENIAL_BLOCK =
  "    if p_is_organizer_override then\n      raise exception 'COMPETITION_ACCESS_DENIED: only the organizer may override a join-request decision' using errcode = 'P0001';\n    end if;\n" +
  "    raise exception 'NOT_TEAM_CAPTAIN: only this team''s own captain may decide this request' using errcode = 'P0001';\n";
const lifecycleBeforeAuthorization = (def: string) => def.replace(NOT_PENDING_BLOCK, "").replace(CANCELLED_BLOCK, "").replace(ORG_SELECT_BLOCK, NOT_PENDING_BLOCK + ORG_SELECT_BLOCK + CANCELLED_BLOCK);
const notFoundForMissing = (def: string) => def.split(BRANCH_DENIAL_BLOCK).join("    raise exception 'JOIN_REQUEST_NOT_FOUND: no such join request exists' using errcode = 'P0001';\n");

describe("decide_join_request_atomically — authorization comes BEFORE any lifecycle or not-found response (UG-CR-GATE-092)", () => {
  interface Case { label: string; comp: Comp; requestId: string; memberId: string | null }
  let cases: Case[];
  let outsider: string;
  /** Callers who are NOT authorized for any of the cases below (none is the exact organizer or exact captain of any case's competition/team). */
  const unauthorizedFor = (c: Case): Array<[string, string | null]> => [
    ["an authenticated stranger", outsider],
    ["the organizer of another competition", Y.organizerId],
    ["a captain of another competition", Y.teamA.captainId],
    ["another team's captain in the same competition", X.teamB.captainId],
    ["an approved host outside their pilot", hostPilot.hostId],
    ["the requester themselves", c.memberId ?? outsider],
    ["a NULL caller", null],
  ];

  beforeAll(async () => {
    outsider = (await createMember("Disclosure Outsider")).gamingMemberId;
    const pending = await newRequest(X, X.teamA);
    const approved = await newRequest(X, X.teamA);
    await decideJoinRequest(compRepo, approved.requestId, X.teamA.captainId, "APPROVE", false);
    const rejected = await newRequest(X, X.teamA);
    await decideJoinRequest(compRepo, rejected.requestId, X.teamA.captainId, "REJECT", false);
    const z1 = await buildCompetition("discZ1");
    const cancelledPending = await newRequest(z1, z1.teamA);
    await cancelCompetition(compRepo, z1.competitionId, z1.organizerId, "Cancelled for the disclosure suite (pending).");
    const z2 = await buildCompetition("discZ2");
    const cancelledDecided = await newRequest(z2, z2.teamA);
    await decideJoinRequest(compRepo, cancelledDecided.requestId, z2.teamA.captainId, "APPROVE", false);
    await cancelCompetition(compRepo, z2.competitionId, z2.organizerId, "Cancelled for the disclosure suite (decided).");
    cases = [
      { label: "pending", comp: X, ...pending },
      { label: "decided (approved)", comp: X, ...approved },
      { label: "decided (rejected)", comp: X, ...rejected },
      { label: "pending, in a cancelled competition", comp: z1, ...cancelledPending },
      { label: "decided, in a cancelled competition", comp: z2, ...cancelledDecided },
      { label: "does not exist", comp: X, requestId: randomUUID(), memberId: null },
    ];
  }, 400000);

  it("an unauthorized caller gets the SAME bounded denial whether the request is pending, decided, attached to a cancelled competition, or missing — in both branches, for every kind of unauthorized caller", async () => {
    for (const override of [false, true]) {
      const expected = override ? OVERRIDE_DENIAL : CAPTAIN_DENIAL;
      const seen = new Map<string, string[]>();
      for (const c of cases) {
        for (const [who, actor] of unauthorizedFor(c)) {
          const out = await decideRpc(c.requestId, actor, "APPROVE", override);
          expect(out.data, `${who} on a request that is ${c.label} (override=${override}) was handed data`).toBeNull();
          const text = msg(out);
          expect(text, `${who} on a request that is ${c.label} (override=${override})`).not.toMatch(LIFECYCLE_OR_NOT_FOUND);
          seen.set(text, [...(seen.get(text) ?? []), `${who} / ${c.label}`]);
        }
      }
      expect(Array.from(seen.keys()), `override=${override}: every state and caller must see one message`).toEqual([expected]);
    }
  }, 300000);

  it("the typed service path agrees: a stranger gets the 403-class denial for every state (an organizer claim and a captain claim alike), never a 404 or a lifecycle error", async () => {
    for (const c of cases) {
      await expectRejection(decideJoinRequest(compRepo, c.requestId, outsider, "APPROVE", true), CompetitionAccessDeniedError);
      await expectRejection(decideJoinRequest(compRepo, c.requestId, outsider, "APPROVE", false), NotTeamCaptainError);
    }
  }, 180000);

  it("a denial leaves ZERO residual writes: every existing request's row, membership and audit footprint is unchanged after all those attempts", async () => {
    const real = cases.filter((c) => c.memberId !== null);
    const before = await Promise.all(real.map((c) => snapshot(c.comp, { requestId: c.requestId, memberId: c.memberId! })));
    for (const c of cases) for (const [, actor] of unauthorizedFor(c)) for (const override of [false, true]) await decideRpc(c.requestId, actor, "REJECT", override);
    const after = await Promise.all(real.map((c) => snapshot(c.comp, { requestId: c.requestId, memberId: c.memberId! })));
    expect(after).toEqual(before);
    expect(before.map((b) => b.row.status)).toEqual(["REQUESTED", "APPROVED", "REJECTED", "REQUESTED", "APPROVED"]);
  }, 300000);

  it("AUTHORIZED behavior is unchanged: the exact captain and organizer still get the lifecycle responses, in their original order", async () => {
    const [pending, approved, , cancelledPending, cancelledDecided] = cases;
    // Captain.
    await expectRejection(decideJoinRequest(compRepo, approved.requestId, X.teamA.captainId, "APPROVE", false), JoinRequestNotPendingError);
    await expectRejection(decideJoinRequest(compRepo, cancelledPending.requestId, cancelledPending.comp.teamA.captainId, "APPROVE", false), CompetitionCancelledError);
    await expectRejection(decideJoinRequest(compRepo, cancelledDecided.requestId, cancelledDecided.comp.teamA.captainId, "APPROVE", false), JoinRequestNotPendingError); // "not pending" still precedes "cancelled"
    // Organizer override.
    await expectRejection(decideJoinRequest(compRepo, approved.requestId, X.organizerId, "REJECT", true), JoinRequestNotPendingError);
    await expectRejection(decideJoinRequest(compRepo, cancelledPending.requestId, cancelledPending.comp.organizerId, "APPROVE", true), CompetitionCancelledError);
    await expectRejection(decideJoinRequest(compRepo, cancelledDecided.requestId, cancelledDecided.comp.organizerId, "APPROVE", true), JoinRequestNotPendingError);
    // And the normal decision still works for both, with the unchanged return shape.
    const byCaptain = await decideRpc(pending.requestId, X.teamA.captainId, "APPROVE", false);
    expect(byCaptain.error).toBeNull();
    expect(Object.keys((byCaptain.data as Array<Record<string, unknown>>)[0]).sort()).toEqual(["competition_join_request_id", "competition_team_membership_id", "decided_at", "status"]);
    const fresh = await newRequest(X, X.teamB);
    expect((await decideJoinRequest(compRepo, fresh.requestId, X.organizerId, "REJECT", true)).status).toBe("REJECTED");
  }, 240000);

  it("a request that does not exist has no organizer or captain: even the organizer and a captain get the bounded denial for it (an intended difference: no 'not found' for anyone)", async () => {
    const nowhere = randomUUID();
    expect(msg(await decideRpc(nowhere, X.organizerId, "APPROVE", true))).toBe(OVERRIDE_DENIAL);
    expect(msg(await decideRpc(nowhere, X.teamA.captainId, "APPROVE", false))).toBe(CAPTAIN_DENIAL);
    expect(msg(await decideRpc(nowhere, null, "APPROVE", true))).toBe(OVERRIDE_DENIAL);
    // A NULL or absent override flag takes the captain branch, as it always did.
    const nullFlag = await serviceClient.rpc("decide_join_request_atomically", { p_competition_join_request_id: nowhere, p_deciding_gaming_member_id: outsider, p_decision: "APPROVE", p_is_organizer_override: null });
    expect(msg(nullFlag)).toBe(CAPTAIN_DENIAL);
    // Input validation depends on nothing stored, so it still answers first and identically for everyone.
    expect(msg(await serviceClient.rpc("decide_join_request_atomically", { p_competition_join_request_id: nowhere, p_deciding_gaming_member_id: outsider, p_decision: "MAYBE", p_is_organizer_override: false }))).toMatch(/INVALID_DECISION/);
  }, 120000);

  it("a REVOKED HOST's override is refused with HOST_ACCESS_REVOKED in every request state (guard before lifecycle), while a stranger on the same requests learns nothing about the host", async () => {
    const h = await buildHostPilot("jdisc");
    const pendingReq = await newRequest(h.comp, h.comp.teamB);
    const decidedReq = await newRequest(h.comp, h.comp.teamB);
    await decideJoinRequest(compRepo, decidedReq.requestId, h.comp.teamB.captainId, "APPROVE", false);
    await cancelCompetition(compRepo, h.comp.competitionId, h.hostId, "Cancelled before revocation, for the disclosure suite.");
    await withGovernance(() => revokeHostCapability(hostRepo, reviewer.gamingMemberId, h.code, "Disclosure suite: revoke."));
    for (const r of [pendingReq, decidedReq]) {
      await expectRejection(decideJoinRequest(compRepo, r.requestId, h.hostId, "APPROVE", true), HostAccessRevokedError);
      expect(msg(await decideRpc(r.requestId, outsider, "APPROVE", true))).toBe(OVERRIDE_DENIAL); // a stranger is not told the host was revoked
      expect(msg(await decideRpc(r.requestId, null, "APPROVE", true))).toBe(OVERRIDE_DENIAL);
    }
    expect((await requestRow(pendingReq.requestId)).status).toBe("REQUESTED");
  }, 400000);

  it("CONCURRENCY (deterministic): a stranger waiting on the scope lock while the captain's decision commits is DENIED when it runs — it is never told the request has just been decided", async () => {
    const r = await newRequest(X, X.teamA);
    const holder = await connectRaw();
    const waiter = await connectRaw();
    const observer = await connectRaw();
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtext('competition_scope:' || $1::text))", [X.competitionId]);
      const { rows: pid } = await waiter.query("select pg_backend_pid() as pid");
      const waiting = waiter.query("select * from decide_join_request_atomically($1, $2, 'APPROVE', false)", [r.requestId, outsider]).then(() => "answered", (e: Error) => e.message);
      await waitUntilBlockedOnLock(observer, pid[0].pid);
      await holder.query("select * from decide_join_request_atomically($1, $2, 'APPROVE', false)", [r.requestId, X.teamA.captainId]); // re-entrant on the held lock
      await holder.query("commit");
      expect(await waiting).toBe(CAPTAIN_DENIAL);
      expect((await requestRow(r.requestId)).status).toBe("APPROVED");
    } finally {
      await holder.query("rollback").catch(() => {});
      await Promise.all([holder.end(), waiter.end(), observer.end()]);
    }
  }, 120000);

  it("ORDER is pinned: validation → lookup → scope lock → row lock → organizer/captain derived → exact-caller check → host guard → NOT_PENDING → CANCELLED → first write; and 'not found' is gone", async () => {
    const db = await connectRaw();
    try {
      const def = await functionDefinition(db, DECIDE_SIG);
      const at = (needle: string | RegExp) => (typeof needle === "string" ? def.indexOf(needle) : def.search(needle));
      const order = {
        validation: at("INVALID_DECISION"),
        lock: at("pg_advisory_xact_lock(hashtext('competition_scope:'"),
        rowLock: at("for update"),
        organizerLookup: at("select competitions.organizer_gaming_member_id"),
        captainLookup: at("select competition_teams.captain_gaming_member_id"),
        organizerCheck: at("p_deciding_gaming_member_id is distinct from v_organizer_id"),
        hostGuard: at("assert_competition_not_host_revoked(v_competition_id)"),
        captainCheck: at("p_deciding_gaming_member_id is distinct from v_captain_id"),
        notPending: at("JOIN_REQUEST_NOT_PENDING"),
        cancelled: at("COMPETITION_CANCELLED"),
        firstWrite: at(/\n\s*update competition_join_requests/),
      };
      for (const [name, i] of Object.entries(order)) expect(i, name).toBeGreaterThan(-1);
      const values = Object.values(order);
      expect(values, JSON.stringify(order)).toEqual([...values].sort((a, b) => a - b));
      expect(def, "a request that does not exist is now a denial, never 'not found'").not.toContain("JOIN_REQUEST_NOT_FOUND");
      expect((def.match(/COMPETITION_ACCESS_DENIED: only the organizer may override a join-request decision/g) ?? []).length).toBe(3); // the check plus the two missing-request paths
      expect((def.match(/NOT_TEAM_CAPTAIN: only this team''s own captain may decide this request/g) ?? []).length).toBe(3);
    } finally {
      await db.end();
    }
  }, 30000);

  it("[negative control] with the lifecycle checks put back IN FRONT of the authorization, the previous disclosure returns: a stranger is told a request is decided, and that its competition is cancelled", async () => {
    const decided = cases[1];
    const cancelled = cases[3];
    const db = await connectRaw();
    try {
      const call = (id: string) => db.query("select * from decide_join_request_atomically($1, $2, 'APPROVE', true)", [id, outsider]);
      for (const c of [decided, cancelled]) await expect(call(c.requestId)).rejects.toThrow(DENIED); // the real function refuses both with the bounded denial
      await db.query("begin");
      await mutate(db, DECIDE_SIG, lifecycleBeforeAuthorization);
      await db.query("savepoint probe");
      await expect(call(decided.requestId)).rejects.toThrow(NOT_PENDING); // disclosed: "already decided"
      await db.query("rollback to savepoint probe");
      await expect(call(cancelled.requestId)).rejects.toThrow(/COMPETITION_CANCELLED/); // disclosed: "its competition has been cancelled"
      await db.query("rollback to savepoint probe");
      await db.query("rollback");
      for (const c of [decided, cancelled]) await expect(call(c.requestId)).rejects.toThrow(DENIED); // restored
    } finally {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  }, 120000);

  it("[negative control] with 'not found' put back for a missing request, a stranger can tell an id that exists from one that does not", async () => {
    const db = await connectRaw();
    try {
      const missing = randomUUID();
      const call = (id: string, override: boolean) => db.query("select * from decide_join_request_atomically($1, $2, 'APPROVE', $3)", [id, outsider, override]);
      await expect(call(missing, true)).rejects.toThrow(DENIED);
      await db.query("begin");
      await mutate(db, DECIDE_SIG, notFoundForMissing);
      await db.query("savepoint probe");
      await expect(call(missing, true)).rejects.toThrow(/JOIN_REQUEST_NOT_FOUND/); // disclosed: "this id does not exist"
      await db.query("rollback to savepoint probe");
      await expect(call(cases[0].requestId, true)).rejects.toThrow(DENIED); // an existing id still says "denied": the two now differ
      await db.query("rollback");
      await expect(call(missing, true)).rejects.toThrow(DENIED);
    } finally {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  }, 120000);
});

// =============================================================================================================================
// Negative controls
// =============================================================================================================================

async function waitUntilBlockedOnLock(observer: Client, backendPid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { rows } = await observer.query("select wait_event_type from pg_stat_activity where pid = $1", [backendPid]);
    if (rows[0]?.wait_event_type === "Lock") return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("The statement never blocked on a lock.");
}

describe("negative controls: with the bare `<>` put back, a NULL caller decides with no authorization at all, so the tests above cannot pass vacuously", () => {
  const bareDecideOrganizer = (d: string) => d.replace("p_deciding_gaming_member_id is distinct from v_organizer_id", "p_deciding_gaming_member_id <> v_organizer_id");
  const bareDecideCaptain = (d: string) => d.replace("p_deciding_gaming_member_id is distinct from v_captain_id", "p_deciding_gaming_member_id <> v_captain_id");
  const bareReview = (d: string) => d.replace("p_organizer_gaming_member_id is distinct from v_organizer_id", "p_organizer_gaming_member_id <> v_organizer_id");

  it("control 1 — captain branch: a NULL caller REJECTS someone's join request", async () => {
    const r = await newRequest(X, X.teamA);
    const call = (db: Client) => db.query("select * from decide_join_request_atomically($1, null, 'REJECT', false)", [r.requestId]);
    const db = await connectRaw();
    try {
      await expect(call(db)).rejects.toThrow(NOT_CAPTAIN);
      await db.query("begin");
      await mutate(db, DECIDE_SIG, bareDecideCaptain);
      const out = await call(db);
      expect(out.rows[0].status).toBe("REJECTED"); // the attack succeeds
      await db.query("rollback");
      expect((await requestRow(r.requestId)).status).toBe("REQUESTED");
    } finally {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  }, 120000);

  it("control 2 — organizer-override branch: a NULL caller OVERRIDES a join-request decision as if it were the organizer", async () => {
    const r = await newRequest(X, X.teamB);
    const call = (db: Client) => db.query("select * from decide_join_request_atomically($1, null, 'REJECT', true)", [r.requestId]);
    const db = await connectRaw();
    try {
      await expect(call(db)).rejects.toThrow(DENIED);
      await db.query("begin");
      await mutate(db, DECIDE_SIG, bareDecideOrganizer);
      const out = await call(db);
      expect(out.rows[0].status).toBe("REJECTED");
      await db.query("rollback");
      expect((await requestRow(r.requestId)).status).toBe("REQUESTED");
    } finally {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  }, 120000);

  it("control 3 — organizer review: a NULL caller REVIEWS a rejected request, recording a review that nobody authorized", async () => {
    const r = await rejectedRequest(X, X.teamA);
    const call = (db: Client) => db.query("select * from organizer_review_join_request_atomically($1, null, 'REJECT', 'NULL caller probe')", [r.requestId]);
    const db = await connectRaw();
    try {
      await expect(call(db)).rejects.toThrow(DENIED);
      await db.query("begin");
      await mutate(db, REVIEW_SIG, bareReview);
      const out = await call(db);
      expect(out.rows[0].status).toBe("REJECTED");
      const { rows } = await db.query("select organizer_reviewed_at, organizer_reviewed_by_gaming_member_id from competition_join_requests where competition_join_request_id = $1", [r.requestId]);
      expect(rows[0].organizer_reviewed_at).not.toBeNull(); // the single organizer review is now spent, by no one
      expect(rows[0].organizer_reviewed_by_gaming_member_id).toBeNull();
      await db.query("rollback");
      expect((await requestRow(r.requestId)).organizer_reviewed_at).toBeNull();
    } finally {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  }, 120000);

  it("the controls left no trace: both functions keep their null-safe comparisons and their grants", async () => {
    const db = await connectRaw();
    try {
      expect(await functionDefinition(db, DECIDE_SIG)).toContain("p_deciding_gaming_member_id is distinct from v_organizer_id");
      expect(await functionDefinition(db, DECIDE_SIG)).toContain("p_deciding_gaming_member_id is distinct from v_captain_id");
      expect(await functionDefinition(db, REVIEW_SIG)).toContain("p_organizer_gaming_member_id is distinct from v_organizer_id");
      for (const name of ["decide_join_request_atomically", "organizer_review_join_request_atomically"]) {
        const { rows } = await db.query(
          `select has_function_privilege('service_role', p.oid, 'EXECUTE') as svc, has_function_privilege('anon', p.oid, 'EXECUTE') as anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1`, [name]);
        expect(rows[0]).toEqual({ svc: true, anon: false, auth: false });
      }
    } finally {
      await db.end();
    }
  }, 30000);
});
