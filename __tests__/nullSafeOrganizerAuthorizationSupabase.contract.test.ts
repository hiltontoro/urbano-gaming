import { randomUUID } from "node:crypto";

import { loadEnv } from "vite";
import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SupabaseCompetitionsRepository } from "../lib/gaming/competitions/db/supabaseCompetitionsRepository";
import { SupabaseGamingRepository } from "../lib/gaming/db/supabaseGamingRepository";
import { createCompetition } from "../lib/gaming/competitions/createCompetition";
import { openTeamRegistration } from "../lib/gaming/competitions/openTeamRegistration";
import { closeTeamRegistration } from "../lib/gaming/competitions/closeTeamRegistration";
import { addCompetitionTeam } from "../lib/gaming/competitions/addCompetitionTeam";
import { publishCompetition } from "../lib/gaming/competitions/publishCompetition";
import { registerForCompetition } from "../lib/gaming/competitions/registerForCompetition";
import { proposeCompetitionTeam } from "../lib/gaming/competitions/proposeCompetitionTeam";
import { decideCompetitionTeam } from "../lib/gaming/competitions/decideCompetitionTeam";
import { requestJoinTeam } from "../lib/gaming/competitions/requestJoinTeam";
import { decideJoinRequest } from "../lib/gaming/competitions/decideJoinRequest";
import { declareRoster } from "../lib/gaming/competitions/declareRoster";
import { appointScorekeeper } from "../lib/gaming/competitions/appointScorekeeper";
import { submitFixtureEvidence } from "../lib/gaming/competitions/submitFixtureEvidence";
import { finalizeFixture } from "../lib/gaming/competitions/finalizeFixture";
import { forfeitFixture } from "../lib/gaming/competitions/forfeitFixture";
import { voidFixture } from "../lib/gaming/competitions/voidFixture";
import { cancelCompetition } from "../lib/gaming/competitions/cancelCompetition";
import { generatePublicCode } from "../lib/gaming/competitions/publicCode";
import type { GoalEventInput, ParticipationAttestationInput } from "../lib/gaming/competitions/types";
import { CompetitionAccessDeniedError } from "../lib/gaming/competitions/types";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";

/**
 * UG-CR-GATE-090 Correction B — the five remaining organizer functions are null-safe, against real local Postgres.
 *
 * appoint_competition_scorekeeper_atomically, decide_competition_team_atomically, finalize_competition_fixture_atomically,
 * forfeit_competition_fixture_atomically and void_competition_fixture_atomically each compared `caller <> organizer`. For a NULL
 * caller that is NULL, PL/pgSQL treats a NULL condition as false, and the denial was skipped. These tests prove, per function,
 * that a NULL caller is denied at the authorization boundary with no mutation, that every valid non-NULL actor behaves exactly as
 * before, and — through rolled-back negative controls that put the original defect back — that the tests would notice if it
 * returned.
 *
 * finalize, forfeit and void used to answer an idempotent REPLAY before they reached the organizer check. GATE-090 refused a NULL caller
 * ahead of the replay with one explicit NULL test; GATE-091 superseded that by moving the whole authorization (exact organizer, IS DISTINCT
 * FROM, host revocation guard) ahead of the replay, so NULL and every other unauthorized caller are refused there. The full private-replay
 * proof lives in privateReplayAuthorizationSupabase.contract.test.ts; this file keeps the NULL-caller and valid-actor behavior per function.
 *
 * UG-CR-GATE-094 extends the same proof to the five legacy organizer functions (six signatures) that wrote the organizer check in the
 * other operand order (`v_organizer_id <> p_organizer_gaming_member_id`) and were therefore not seen by the parameter-first scan above:
 * add_competition_team_atomically (both overloads), cancel_incomplete_competition_atomically, close_team_registration_atomically,
 * open_team_registration_atomically and publish_competition_atomically. Its section also holds a catalog scan for BOTH operand orders;
 * its exact coverage and limits are stated in that section, its text-level behavior is pinned by a self-test, and its catalog-level limits
 * (other schemas, procedures, application code) are stated and not tested.
 *
 * Synthetic identities are unique per run and every assertion is scoped to rows this file created; a database reset restores a
 * clean state.
 */

const env = loadEnv("development", process.cwd(), "");
const supabaseUrl = env.SUPABASE_URL;
requireLocalSupabase(supabaseUrl);
const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAnonKey = env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey || !supabaseAnonKey) {
  throw new Error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are required for contract tests.");
}

// Raw pg runs the rolled-back negative controls. The URL is supplied explicitly, never read from .env.local, and must be loopback.
const supabaseDbUrl = process.env.COMPETITIONS_LOCAL_DB_URL ?? "";
if (!/^postgresql:\/\/[^@]+@(127\.0\.0\.1|localhost|\[::1\]):\d+\//.test(supabaseDbUrl)) {
  throw new Error("COMPETITIONS_LOCAL_DB_URL must be set to a loopback Postgres URL for null-safe organizer contract tests.");
}

const compRepo = new SupabaseCompetitionsRepository(supabaseUrl, supabaseServiceRoleKey);
const gamingRepo = new SupabaseGamingRepository(supabaseUrl, supabaseServiceRoleKey);
const serviceClient = createClient(supabaseUrl, supabaseServiceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

const RUN = randomUUID().slice(0, 8);
const iso = (ms: number) => new Date(Date.now() + ms).toISOString();
const DENIED = /COMPETITION_ACCESS_DENIED/;
const PENDING = "PENDING_ORGANIZER_APPROVAL"; // a member-proposed team awaiting the organizer

interface Member { authUserId: string; gamingMemberId: string }
const createdAuthUserIds: string[] = [];
const grantedMemberIds: string[] = [];
let counter = 0;

async function createMember(displayName: string): Promise<Member> {
  const email = `null-safe-${RUN}-${counter++}-${randomUUID().slice(0, 6)}@example.com`;
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

// Best effort only: some rows these flows create (finalizations, audit events) pin their members, so a failed delete here is
// expected and silent by design. This file's identities are unique, and a database reset restores a clean state.
afterAll(async () => {
  if (grantedMemberIds.length > 0) {
    for (let i = 0; i < grantedMemberIds.length; i += 50) {
      await serviceClient.from("authority_grants").delete().in("gaming_member_id", grantedMemberIds.slice(i, i + 50));
    }
  }
  for (const id of createdAuthUserIds) await serviceClient.auth.admin.deleteUser(id);
}, 240000);

// -----------------------------------------------------------------------------------------------------------------------------
// Scaffolding
// -----------------------------------------------------------------------------------------------------------------------------

interface Team { competitionTeamId: string; captainId: string }
interface Bracket { competitionId: string; organizerId: string; teams: Team[]; sf1: string; sf2: string; final: string }

/** A published four-team bracket run by an internal OPERATIONAL organizer. */
async function buildBracket(label: string): Promise<Bracket> {
  const operator = await createMember(`${label} Operator`);
  await grantOperational(operator.gamingMemberId);
  const created = await createCompetition(compRepo, operator.gamingMemberId, `NullSafe ${label} ${RUN}`, "SOCCER_5V5");
  await openTeamRegistration(compRepo, created.competitionId, operator.gamingMemberId);
  const teams: Team[] = [];
  for (let i = 0; i < 4; i++) {
    const captainId = (await createMember(`${label} Captain ${i}`)).gamingMemberId;
    const team = await addCompetitionTeam(compRepo, created.competitionId, operator.gamingMemberId, `${label} Team ${i} ${RUN}`, captainId);
    teams.push({ competitionTeamId: team.competitionTeamId, captainId });
  }
  await closeTeamRegistration(compRepo, created.competitionId, operator.gamingMemberId);
  const published = await publishCompetition(
    compRepo, created.competitionId, operator.gamingMemberId,
    teams[0].competitionTeamId, teams[1].competitionTeamId, teams[2].competitionTeamId, teams[3].competitionTeamId,
    iso(3600_000), iso(7200_000), iso(10800_000)
  );
  return { competitionId: created.competitionId, organizerId: operator.gamingMemberId, teams, sf1: published.semifinal1FixtureId, sf2: published.semifinal2FixtureId, final: published.finalFixtureId };
}

async function memberOnTeam(b: Bracket, teamIndex: number, label: string): Promise<string> {
  const member = await createMember(label);
  await registerForCompetition(compRepo, b.competitionId, member.gamingMemberId, true);
  const request = await requestJoinTeam(compRepo, b.competitionId, b.teams[teamIndex].competitionTeamId, member.gamingMemberId);
  await decideJoinRequest(compRepo, request.competitionJoinRequestId, b.teams[teamIndex].captainId, "APPROVE", false);
  return member.gamingMemberId;
}

/** Five approved members per side, both rosters declared, a scorekeeper appointed and valid evidence submitted: ready to finalize. */
async function evidenceSubmittedFixture(b: Bracket, label: string): Promise<{ fixtureId: string; teamA: Team; teamB: Team; scorekeeper: string }> {
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
  const evidence = await submitFixtureEvidence(compRepo, b.sf1, scorekeeper, 2, 0, goals, [], attestations, null);
  expect(evidence.fixtureState).toBe("EVIDENCE_SUBMITTED");
  return { fixtureId: b.sf1, teamA: b.teams[0], teamB: b.teams[1], scorekeeper };
}

/** A competition with registration open and one PENDING member-proposed team. */
async function pendingProposal(label: string): Promise<{ competitionId: string; organizerId: string; teamId: string; proposerId: string }> {
  const operator = await createMember(`${label} Operator`);
  await grantOperational(operator.gamingMemberId);
  const created = await createCompetition(compRepo, operator.gamingMemberId, `NullSafe ${label} ${RUN}`, "SOCCER_5V5");
  await openTeamRegistration(compRepo, created.competitionId, operator.gamingMemberId);
  const proposer = await createMember(`${label} Proposer`);
  await registerForCompetition(compRepo, created.competitionId, proposer.gamingMemberId, true);
  const team = await proposeCompetitionTeam(compRepo, created.competitionId, `${label} Proposed ${RUN}`, proposer.gamingMemberId);
  expect(team.status).toBe(PENDING);
  return { competitionId: created.competitionId, organizerId: operator.gamingMemberId, teamId: team.competitionTeamId, proposerId: proposer.gamingMemberId };
}

const fixtureRow = async (fixtureId: string) => {
  const { data, error } = await serviceClient.from("competition_fixtures").select("state, scorekeeper_gaming_member_id").eq("competition_fixture_id", fixtureId).single();
  if (error) throw error;
  return data!;
};
const finalizationRows = async (fixtureId: string) => {
  const { count, error } = await serviceClient.from("competition_fixture_finalizations").select("*", { count: "exact", head: true }).eq("competition_fixture_id", fixtureId);
  if (error) throw error;
  return count ?? 0;
};
const competitionState = async (competitionId: string) => {
  const { data, error } = await serviceClient.from("competitions").select("state").eq("competition_id", competitionId).single();
  if (error) throw error;
  return data!.state as string;
};
const teamStatus = async (teamId: string) => {
  const { data, error } = await serviceClient.from("competition_teams").select("status").eq("competition_team_id", teamId).single();
  if (error) throw error;
  return data!.status as string;
};

const SIGS = {
  appoint: "appoint_competition_scorekeeper_atomically(uuid, uuid, uuid)",
  decide: "decide_competition_team_atomically(uuid, uuid, text, text)",
  finalize: "finalize_competition_fixture_atomically(uuid, uuid)",
  forfeit: "forfeit_competition_fixture_atomically(uuid, uuid, uuid, text)",
  void: "void_competition_fixture_atomically(uuid, uuid, text)",
} as const;
const FIVE = ["appoint_competition_scorekeeper_atomically", "decide_competition_team_atomically", "finalize_competition_fixture_atomically", "forfeit_competition_fixture_atomically", "void_competition_fixture_atomically"];

async function functionDefinition(db: Client, signature: string): Promise<string> {
  const { rows } = await db.query("select pg_get_functiondef($1::regprocedure) as def", [signature]);
  return rows[0].def as string;
}

/** Redefines the function inside the caller's open transaction; the mutation must really change the text, or the control proves nothing. */
async function mutate(db: Client, signature: string, edit: (def: string) => string): Promise<void> {
  const original = await functionDefinition(db, signature);
  const edited = edit(original);
  expect(edited, "the mutation must actually change the function (otherwise the control proves nothing)").not.toBe(original);
  await db.query(edited);
}

const restoreBareComparison = (def: string) => def.replace("p_organizer_gaming_member_id is distinct from v_organizer_id", "p_organizer_gaming_member_id <> v_organizer_id");
// GATE-091 folded the GATE-090 explicit NULL test into the exact-caller check (authorization now precedes the replay), so the function as it
// was before GATE-090 differs from today's only by the bare comparison.
const original = restoreBareComparison;

// =============================================================================================================================
// Inventory
// =============================================================================================================================

describe("inventory: the five organizer functions, every active signature, before and after", () => {
  it("each has exactly ONE signature (no overload, no compatibility copy), is SECURITY DEFINER with search_path=public, and only service_role can execute it", async () => {
    const db = await connectRaw();
    try {
      for (const name of FIVE) {
        const { rows } = await db.query(
          `select p.oid, pg_get_function_identity_arguments(p.oid) as args, p.prosecdef, p.proconfig::text as cfg
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1`,
          [name]
        );
        expect(rows, `${name} must have exactly one signature`).toHaveLength(1);
        expect(rows[0].prosecdef, `${name} security mode`).toBe(true);
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
    } finally {
      await db.end();
    }
  }, 30000);

  // Scope, stated exactly: functions whose NAME contains `competition`, and only the PARAMETER-FIRST order `p_..gaming_member_id <> v_..`.
  // It does not see `v_.. <> p_..gaming_member_id` (the GATE-094 section below scans both orders across the whole schema), and the
  // title below says so; an earlier title claimed more than this query covers.
  it("no function whose name contains `competition` has the PARAMETER-FIRST bare form `p_..gaming_member_id <> v_..` (or `!=`); the five GATE-090 functions use IS DISTINCT FROM — the both-order, all-function scan is in the GATE-094 section", async () => {
    const db = await connectRaw();
    try {
      const { rows } = await db.query(`select p.proname, pg_get_functiondef(p.oid) as def from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.prokind = 'f' and p.proname like '%competition%'`);
      expect(rows.length).toBeGreaterThan(20);
      const offenders = rows
        .filter((r) => /p_\w*gaming_member_id\s*(<>|!=)\s*v_\w+/.test((r.def as string).replace(/--.*$/gm, "")))
        .map((r) => r.proname as string);
      expect(offenders).toEqual([]);
      for (const name of FIVE) {
        const def = rows.find((r) => r.proname === name)!.def as string;
        expect(def, name).toMatch(/p_organizer_gaming_member_id is distinct from v_organizer_id/);
      }
    } finally {
      await db.end();
    }
  }, 30000);

  it("finalize, forfeit and void: the exact-caller check (IS DISTINCT FROM, so NULL can never pass) sits after the fixture is locked and read and BEFORE the idempotent replay; no separate NULL test remains", async () => {
    const db = await connectRaw();
    try {
      for (const signature of [SIGS.finalize, SIGS.forfeit, SIGS.void]) {
        const def = await functionDefinition(db, signature);
        const lock = def.indexOf("pg_advisory_xact_lock(hashtext('competition_scope:'");
        const load = def.indexOf("for update");
        const check = def.indexOf("p_organizer_gaming_member_id is distinct from v_organizer_id");
        const replay = def.indexOf("competition_fixture_finalizations");
        for (const [name, i] of Object.entries({ lock, load, check, replay })) expect(i, `${signature} ${name}`).toBeGreaterThan(-1);
        expect(lock).toBeLessThan(load);
        expect(load).toBeLessThan(check);
        expect(check).toBeLessThan(replay); // GATE-091: authorization first. (The full ordering is pinned in privateReplayAuthorizationSupabase.contract.test.ts.)
        expect(def, signature).not.toContain("if p_organizer_gaming_member_id is null then");
      }
      // appoint and decide never answer a replay before the check, so the comparison alone is the boundary there.
      for (const signature of [SIGS.appoint, SIGS.decide]) {
        expect(await functionDefinition(db, signature)).not.toContain("if p_organizer_gaming_member_id is null then");
      }
    } finally {
      await db.end();
    }
  }, 30000);
});

// =============================================================================================================================
// 1. appoint_competition_scorekeeper_atomically
// =============================================================================================================================

describe("appoint_competition_scorekeeper_atomically", () => {
  let b: Bracket;
  let candidate: string;
  beforeAll(async () => {
    b = await buildBracket("appoint");
    candidate = (await createMember("Appoint Candidate")).gamingMemberId;
  }, 120000);

  const callWith = (actor: string | null, target = candidate) =>
    serviceClient.rpc("appoint_competition_scorekeeper_atomically", { p_competition_fixture_id: b.sf1, p_organizer_gaming_member_id: actor, p_scorekeeper_gaming_member_id: target });

  it("a NULL organizer is denied at the authorization boundary and appoints nobody", async () => {
    expect((await fixtureRow(b.sf1)).scorekeeper_gaming_member_id).toBeNull();
    const { error } = await callWith(null);
    expect(error?.message ?? "").toMatch(DENIED);
    expect((await fixtureRow(b.sf1)).scorekeeper_gaming_member_id).toBeNull();
  }, 60000);

  it("[negative control] with the bare `<>` put back, a NULL organizer APPOINTS a scorekeeper with no authorization at all", async () => {
    const db = await connectRaw();
    try {
      const call = () => db.query("select * from appoint_competition_scorekeeper_atomically($1, null, $2)", [b.sf1, candidate]);
      await expect(call()).rejects.toThrow(DENIED);
      await db.query("begin");
      await mutate(db, SIGS.appoint, restoreBareComparison);
      const out = await call();
      expect(out.rows[0].scorekeeper_gaming_member_id).toBe(candidate); // the attack succeeds
      await db.query("rollback");
      expect((await fixtureRow(b.sf1)).scorekeeper_gaming_member_id).toBeNull();
    } finally {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  }, 60000);

  it("valid actors are unchanged: a stranger is denied, the real organizer appoints, and a NULL organizer still cannot replace them", async () => {
    const stranger = (await createMember("Appoint Stranger")).gamingMemberId;
    const asStranger = await callWith(stranger);
    expect(asStranger.error?.message ?? "").toMatch(DENIED);
    expect((await fixtureRow(b.sf1)).scorekeeper_gaming_member_id).toBeNull();
    const out = await appointScorekeeper(compRepo, b.sf1, b.organizerId, candidate);
    expect(out.scorekeeperGamingMemberId).toBe(candidate);
    expect((await fixtureRow(b.sf1)).scorekeeper_gaming_member_id).toBe(candidate);
    const other = (await createMember("Appoint Other")).gamingMemberId;
    const { error } = await callWith(null, other);
    expect(error?.message ?? "").toMatch(DENIED);
    expect((await fixtureRow(b.sf1)).scorekeeper_gaming_member_id).toBe(candidate); // not replaced
  }, 120000);
});

// =============================================================================================================================
// 2. decide_competition_team_atomically
// =============================================================================================================================

describe("decide_competition_team_atomically", () => {
  let p: Awaited<ReturnType<typeof pendingProposal>>;
  beforeAll(async () => { p = await pendingProposal("decide"); }, 120000);

  const callWith = (actor: string | null, decision: "APPROVE" | "REJECT" = "REJECT") =>
    serviceClient.rpc("decide_competition_team_atomically", { p_competition_team_id: p.teamId, p_organizer_gaming_member_id: actor, p_decision: decision, p_reason: decision === "REJECT" ? "NULL caller probe" : null });

  it("a NULL organizer is denied at the authorization boundary and the proposal stays pending", async () => {
    for (const decision of ["REJECT", "APPROVE"] as const) {
      const { error } = await callWith(null, decision);
      expect(error?.message ?? "", decision).toMatch(DENIED);
      expect(await teamStatus(p.teamId)).toBe(PENDING);
    }
  }, 60000);

  it("[negative control] with the bare `<>` put back, a NULL organizer REJECTS a member's team proposal with no authorization at all", async () => {
    const db = await connectRaw();
    try {
      const call = () => db.query("select * from decide_competition_team_atomically($1, null, 'REJECT', 'NULL caller probe')", [p.teamId]);
      await expect(call()).rejects.toThrow(DENIED);
      await db.query("begin");
      await mutate(db, SIGS.decide, restoreBareComparison);
      const out = await call();
      expect(out.rows[0].status).toBe("REJECTED"); // the attack succeeds
      await db.query("rollback");
      expect(await teamStatus(p.teamId)).toBe(PENDING);
    } finally {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  }, 60000);

  it("valid actors are unchanged: a stranger is denied, the real organizer decides, and the decision is idempotent", async () => {
    const stranger = (await createMember("Decide Stranger")).gamingMemberId;
    expect((await callWith(stranger, "APPROVE")).error?.message ?? "").toMatch(DENIED);
    expect(await teamStatus(p.teamId)).toBe(PENDING);
    const approved = await decideCompetitionTeam(compRepo, p.teamId, p.organizerId, "APPROVE", null);
    expect(approved.status).toBe("ACCEPTED");
    const again = await decideCompetitionTeam(compRepo, p.teamId, p.organizerId, "APPROVE", null);
    expect(again.status).toBe("ACCEPTED");
    expect(await teamStatus(p.teamId)).toBe("ACCEPTED");
    const { error } = await callWith(null, "APPROVE"); // NULL after the decision is still refused, not answered
    expect(error?.message ?? "").toMatch(DENIED);
  }, 120000);
});

// =============================================================================================================================
// 3. finalize_competition_fixture_atomically  (answers an idempotent replay before the organizer check)
// =============================================================================================================================

describe("finalize_competition_fixture_atomically", () => {
  let b: Bracket;
  let f: Awaited<ReturnType<typeof evidenceSubmittedFixture>>;
  beforeAll(async () => {
    b = await buildBracket("finalize");
    f = await evidenceSubmittedFixture(b, "fin");
  }, 240000);

  const callWith = (actor: string | null) => serviceClient.rpc("finalize_competition_fixture_atomically", { p_competition_fixture_id: f.fixtureId, p_organizer_gaming_member_id: actor });
  const rawCall = (db: Client) => db.query("select * from finalize_competition_fixture_atomically($1, null)", [f.fixtureId]);

  it("a NULL organizer is denied at the authorization boundary: nothing is finalized and the fixture is untouched", async () => {
    const before = await fixtureRow(f.fixtureId);
    const { error } = await callWith(null);
    expect(error?.message ?? "").toMatch(DENIED);
    expect(await finalizationRows(f.fixtureId)).toBe(0);
    expect(await fixtureRow(f.fixtureId)).toEqual(before);
    expect(before.state).toBe("EVIDENCE_SUBMITTED");
  }, 60000);

  it("[negative control] the function with the original `<>` comparison: a NULL organizer gets past the authorization check", async () => {
    const db = await connectRaw();
    try {
      await expect(rawCall(db)).rejects.toThrow(DENIED);
      await db.query("begin");
      await mutate(db, SIGS.finalize, original);
      let outcome: { ok: boolean; message: string };
      try { await rawCall(db); outcome = { ok: true, message: "" }; } catch (e) { outcome = { ok: false, message: (e as Error).message }; }
      expect(outcome.message, "the NULL caller must no longer be stopped by the authorization check").not.toMatch(DENIED);
      await db.query("rollback");
      expect(await finalizationRows(f.fixtureId)).toBe(0);
    } finally {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  }, 60000);

  it("valid actors are unchanged: a stranger is denied before finalization, and the real organizer finalizes", async () => {
    const stranger = (await createMember("Finalize Stranger")).gamingMemberId;
    expect((await callWith(stranger)).error?.message ?? "").toMatch(DENIED);
    expect(await finalizationRows(f.fixtureId)).toBe(0);
    const out = await finalizeFixture(compRepo, f.fixtureId, b.organizerId);
    expect(out).toMatchObject({ outcomeType: "NORMAL", winningCompetitionTeamId: f.teamA.competitionTeamId, alreadyFinalized: false });
    expect(await finalizationRows(f.fixtureId)).toBe(1);
  }, 120000);

  it("a NULL organizer is denied on the REPLAY path too — it is not handed the existing result", async () => {
    const before = await finalizationRows(f.fixtureId);
    const { data, error } = await callWith(null);
    expect(error?.message ?? "").toMatch(DENIED);
    expect(data).toBeNull();
    expect(await finalizationRows(f.fixtureId)).toBe(before);
  }, 60000);

  it("[GATE-091] the organizer's retry is still idempotent, and a stranger's replay is no longer answered (the full private-replay proof is in privateReplayAuthorizationSupabase.contract.test.ts)", async () => {
    const replay = await finalizeFixture(compRepo, f.fixtureId, b.organizerId);
    expect(replay.alreadyFinalized).toBe(true);
    const stranger = (await createMember("Finalize Replay Stranger")).gamingMemberId;
    await expectRejection(finalizeFixture(compRepo, f.fixtureId, stranger), CompetitionAccessDeniedError);
    expect(await finalizationRows(f.fixtureId)).toBe(1);
  }, 60000);
});

// =============================================================================================================================
// 4. forfeit_competition_fixture_atomically  (answers an idempotent replay before the organizer check)
// =============================================================================================================================

describe("forfeit_competition_fixture_atomically", () => {
  let b: Bracket;
  beforeAll(async () => { b = await buildBracket("forfeit"); }, 120000);

  const args = () => ({ fixture: b.sf1, forfeiting: b.teams[0].competitionTeamId });
  const callWith = (actor: string | null) =>
    serviceClient.rpc("forfeit_competition_fixture_atomically", { p_competition_fixture_id: args().fixture, p_organizer_gaming_member_id: actor, p_forfeiting_competition_team_id: args().forfeiting, p_reason: "NULL caller probe" });
  const rawCall = (db: Client) => db.query("select * from forfeit_competition_fixture_atomically($1, null, $2, 'NULL caller probe')", [args().fixture, args().forfeiting]);

  it("a NULL organizer is denied at the authorization boundary: nothing is forfeited and the fixture is untouched", async () => {
    const before = await fixtureRow(b.sf1);
    const { error } = await callWith(null);
    expect(error?.message ?? "").toMatch(DENIED);
    expect(await finalizationRows(b.sf1)).toBe(0);
    expect(await fixtureRow(b.sf1)).toEqual(before);
  }, 60000);

  it("[negative control] the function with the original `<>` comparison: a NULL organizer gets past the authorization check and FORFEITS the fixture", async () => {
    const db = await connectRaw();
    try {
      await expect(rawCall(db)).rejects.toThrow(DENIED);
      await db.query("begin");
      await mutate(db, SIGS.forfeit, original);
      let message = "";
      let wrote = false;
      try { const out = await rawCall(db); wrote = out.rows[0].already_finalized === false; } catch (e) { message = (e as Error).message; }
      expect(message).not.toMatch(DENIED);
      if (wrote) {
        const { rows } = await db.query("select count(*)::int as n from competition_fixture_finalizations where competition_fixture_id = $1", [b.sf1]);
        expect(rows[0].n).toBe(1);
      }
      await db.query("rollback");
      expect(await finalizationRows(b.sf1)).toBe(0);
    } finally {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  }, 60000);

  it("valid actors are unchanged: a stranger is denied, and the real organizer forfeits", async () => {
    const stranger = (await createMember("Forfeit Stranger")).gamingMemberId;
    expect((await callWith(stranger)).error?.message ?? "").toMatch(DENIED);
    expect(await finalizationRows(b.sf1)).toBe(0);
    const out = await forfeitFixture(compRepo, b.sf1, b.organizerId, b.teams[0].competitionTeamId, "Team did not arrive.");
    expect(out.alreadyFinalized).toBe(false);
    expect(out.winningCompetitionTeamId).toBe(b.teams[1].competitionTeamId);
    expect(await finalizationRows(b.sf1)).toBe(1);
  }, 120000);

  it("a NULL organizer is denied on the REPLAY path too — it is not handed the existing result", async () => {
    const { data, error } = await callWith(null);
    expect(error?.message ?? "").toMatch(DENIED);
    expect(data).toBeNull();
    expect(await finalizationRows(b.sf1)).toBe(1);
  }, 60000);

  it("[GATE-091] the organizer's retry is still idempotent, and a stranger's replay is no longer answered", async () => {
    const replay = await forfeitFixture(compRepo, b.sf1, b.organizerId, b.teams[0].competitionTeamId, "Team did not arrive.");
    expect(replay.alreadyFinalized).toBe(true);
    const stranger = (await createMember("Forfeit Replay Stranger")).gamingMemberId;
    await expectRejection(forfeitFixture(compRepo, b.sf1, stranger, b.teams[0].competitionTeamId, "Team did not arrive."), CompetitionAccessDeniedError);
    expect(await finalizationRows(b.sf1)).toBe(1);
  }, 60000);
});

// =============================================================================================================================
// 5. void_competition_fixture_atomically  (answers an idempotent replay before the organizer check)
// =============================================================================================================================

describe("void_competition_fixture_atomically", () => {
  let b: Bracket;
  beforeAll(async () => { b = await buildBracket("void"); }, 120000);

  const callWith = (actor: string | null) => serviceClient.rpc("void_competition_fixture_atomically", { p_competition_fixture_id: b.sf1, p_organizer_gaming_member_id: actor, p_reason: "NULL caller probe" });
  const rawCall = (db: Client) => db.query("select * from void_competition_fixture_atomically($1, null, 'NULL caller probe')", [b.sf1]);

  it("a NULL organizer is denied at the authorization boundary: nothing is voided and the competition is NOT cancelled", async () => {
    const before = await fixtureRow(b.sf1);
    const stateBefore = await competitionState(b.competitionId);
    const { error } = await callWith(null);
    expect(error?.message ?? "").toMatch(DENIED);
    expect(await finalizationRows(b.sf1)).toBe(0);
    expect(await fixtureRow(b.sf1)).toEqual(before);
    expect(await competitionState(b.competitionId)).toBe(stateBefore);
    expect(stateBefore).not.toBe("CANCELLED_WITHOUT_CHAMPION");
  }, 60000);

  it("[negative control] the function with the original `<>` comparison: a NULL organizer gets past the authorization check and CANCELS the competition", async () => {
    const db = await connectRaw();
    try {
      await expect(rawCall(db)).rejects.toThrow(DENIED);
      await db.query("begin");
      await mutate(db, SIGS.void, original);
      let message = "";
      try { await rawCall(db); } catch (e) { message = (e as Error).message; }
      expect(message).not.toMatch(DENIED);
      if (message === "") {
        const { rows } = await db.query("select state from competitions where competition_id = $1", [b.competitionId]);
        expect(rows[0].state).toBe("CANCELLED_WITHOUT_CHAMPION"); // the attack succeeds
      }
      await db.query("rollback");
      expect(await competitionState(b.competitionId)).not.toBe("CANCELLED_WITHOUT_CHAMPION");
    } finally {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  }, 60000);

  it("valid actors are unchanged: a stranger is denied, and the real organizer voids", async () => {
    const stranger = (await createMember("Void Stranger")).gamingMemberId;
    expect((await callWith(stranger)).error?.message ?? "").toMatch(DENIED);
    expect(await finalizationRows(b.sf1)).toBe(0);
    const out = await voidFixture(compRepo, b.sf1, b.organizerId, "Pitch unavailable.");
    expect(out).toMatchObject({ alreadyFinalized: false, competitionState: "CANCELLED_WITHOUT_CHAMPION" });
    expect(await competitionState(b.competitionId)).toBe("CANCELLED_WITHOUT_CHAMPION");
  }, 120000);

  it("a NULL organizer is denied on the REPLAY path too — it is not handed the existing result", async () => {
    const { data, error } = await callWith(null);
    expect(error?.message ?? "").toMatch(DENIED);
    expect(data).toBeNull();
    expect(await finalizationRows(b.sf1)).toBe(1);
  }, 60000);

  it("[GATE-091] the organizer's retry is still idempotent, and a stranger's replay is no longer answered", async () => {
    const replay = await voidFixture(compRepo, b.sf1, b.organizerId, "Pitch unavailable.");
    expect(replay.alreadyFinalized).toBe(true);
    const stranger = (await createMember("Void Replay Stranger")).gamingMemberId;
    await expectRejection(voidFixture(compRepo, b.sf1, stranger, "Pitch unavailable."), CompetitionAccessDeniedError);
    expect(await finalizationRows(b.sf1)).toBe(1);
  }, 60000);
});

// =============================================================================================================================
// The controls left no trace
// =============================================================================================================================

describe("the negative controls left no trace", () => {
  it("every function still has its null-safe comparison, the three replay functions still authorize before the replay, and the grants are intact", async () => {
    const db = await connectRaw();
    try {
      for (const signature of Object.values(SIGS)) {
        expect(await functionDefinition(db, signature), signature).toContain("p_organizer_gaming_member_id is distinct from v_organizer_id");
      }
      for (const signature of [SIGS.finalize, SIGS.forfeit, SIGS.void]) {
        const def = await functionDefinition(db, signature);
        expect(def.indexOf("p_organizer_gaming_member_id is distinct from v_organizer_id"), signature).toBeLessThan(def.indexOf("return query select v_existing_finalization_id"));
      }
      for (const name of FIVE) {
        const { rows } = await db.query(
          `select has_function_privilege('service_role', p.oid, 'EXECUTE') as svc, has_function_privilege('anon', p.oid, 'EXECUTE') as anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1`,
          [name]
        );
        expect(rows[0]).toEqual({ svc: true, anon: false, auth: false });
      }
    } finally {
      await db.end();
    }
  }, 30000);
});

// =============================================================================================================================
// UG-CR-GATE-094 — the five legacy organizer functions (six signatures)
// =============================================================================================================================
//
// These functions wrote the organizer check as `v_organizer_id <> p_organizer_gaming_member_id`. For a NULL caller that is NULL, the
// PL/pgSQL condition is false, and the denial was skipped; the host revocation guard that follows is keyed on the competition id, so
// the NULL caller carried on as the organizer. Nothing in the application passes a NULL actor and the functions are executable only by
// service_role, so this is defense in depth. The migration changes exactly that one line in each function.
//
// Like the sections above, the tests inside each describe below are COUPLED BY DECLARATION ORDER: the probes run first and the final
// 'valid actors' test consumes the fixture (for example it opens, closes, publishes or cancels it). They are not written to run alone or shuffled.

const LEGACY = {
  open: "open_team_registration_atomically(uuid, uuid)",
  close: "close_team_registration_atomically(uuid, uuid)",
  publish: "publish_competition_atomically(uuid, uuid, uuid, uuid, uuid, uuid, timestamp with time zone, timestamp with time zone, timestamp with time zone)",
  cancel: "cancel_incomplete_competition_atomically(uuid, uuid, text)",
  add4: "add_competition_team_atomically(uuid, uuid, text, uuid)",
  add5: "add_competition_team_atomically(uuid, uuid, text, uuid, text)",
} as const;
const LEGACY_NAMES = ["add_competition_team_atomically", "cancel_incomplete_competition_atomically", "close_team_registration_atomically", "open_team_registration_atomically", "publish_competition_atomically"];
const NULL_SAFE_ORGANIZER_CHECK = "p_organizer_gaming_member_id is distinct from v_organizer_id";
const BARE_LEGACY_ORGANIZER_CHECK = "v_organizer_id <> p_organizer_gaming_member_id";
/** The function exactly as it was before GATE-094: the verified definition differs from today's only by this one comparison. */
const restoreLegacyBare = (def: string) => def.replace(NULL_SAFE_ORGANIZER_CHECK, BARE_LEGACY_ORGANIZER_CHECK);
const compact = (signature: string) => signature.replace(/\s+/g, "");

// -----------------------------------------------------------------------------------------------------------------------------
// The catalog scan — exactly what it covers
// -----------------------------------------------------------------------------------------------------------------------------
//
// COVERS: the definition text (pg_get_functiondef) of EVERY function in schema `public` with prokind 'f' (ordinary and trigger functions;
// not procedures, aggregates or window functions). Comments are removed first, in ONE left-to-right pass, so a `/*` inside a `--` comment,
// or a `--` inside a '...' string literal, is not mistaken for a comment. A function is reported when its text contains a `<>` or `!=`
// whose two operands, written directly against the operator as BARE identifiers, are (a) a PARAMETER named
// `p_<ASCII letters, digits or underscores>gaming_member_id` and (b) a PL/pgSQL VARIABLE named `v_<ASCII letters, digits or underscores>`,
// in EITHER operand order. "Bare" means nothing is attached to the identifier: it is not preceded by `.`, `$` or an identifier character
// and not followed by `.`, `$`, `(`, `[`, `:` or an identifier character.
//
// DOES NOT COVER: comparisons written with `=` or `NOT (a = b)`; parameters not named `p_*gaming_member_id` and variables not named `v_*`
// (for example the host-token and caller-token comparisons in the Games and Race functions, which this file does not assess); operands
// wrapped in parentheses or carrying a cast, a field selection (`v_rec.col`), a subscript or a function call, and any expression around an
// operand (`v_x + 1`), none of which are interpreted; `<>` between two parameters; identifiers with `$` or non-ASCII letters; other
// schemas; procedures, aggregates and window functions; the application code.
//
// KNOWN WAYS A REAL COMPARISON CAN BE HIDDEN (a false negative, the serious direction): the scan understands standard '...' strings and
// `--` and `/* */` comments only. `E'..'` escape strings (backslash-quote), dollar-quoted text and double-quoted identifiers are not
// parsed, so a `--` or `/*` inside them is taken for a comment start and hides a real comparison on the same line (or up to a later `*/`),
// and an apostrophe inside them can unbalance the string tracking and hide the rest of a later line. A lone CR line ending does not end a
// `--` comment. These are stated limits, each pinned by one example in the self-test; the scan does not handle them. Two further behaviors
// only ADD spurious flags: the text of a standard string literal is kept and scanned as if it were code, and nested block comments are not
// parsed.
//
// A clean result is therefore a statement about this pattern in this catalog query, nothing wider.
//
// WHAT IS PINNED AND WHAT IS NOT: the self-test below pins the TEXT-LEVEL behavior: both operand orders, `!=`, comments and standard
// strings, bare versus attached operands (parenthesised, cast, field-selected, subscripted, qualified, called, `$`-suffixed), `=`,
// NOT(..=..), the p_ / v_ prefix and digit rules for names, two parameters, and the spurious-flag and hidden-comparison limits listed
// above. NOT pinned by any test, stated only: identifiers with non-ASCII letters; the CATALOG-LEVEL limits (other schemas, procedures,
// aggregates and window functions, which are properties of the query in scanPublicSchema; and the application code). The live controls
// show only that ordinary functions in schema `public` ARE scanned.

// An operand is a BARE identifier: nothing attached before it or after it (see COVERS).
const BEFORE_OPERAND = "(?<![\\w.$])";
const AFTER_OPERAND = "(?![\\w.$(\\[:])";
const GAMING_MEMBER_PARAMETER = BEFORE_OPERAND + "p_[a-z0-9_]*gaming_member_id" + AFTER_OPERAND;
const STORED_VARIABLE = BEFORE_OPERAND + "v_[a-z0-9_]+" + AFTER_OPERAND;
const BARE_OPERATOR = "\\s*(?:<>|!=)\\s*";
const PARAMETER_FIRST = new RegExp(GAMING_MEMBER_PARAMETER + BARE_OPERATOR + STORED_VARIABLE, "i");
const VARIABLE_FIRST = new RegExp(STORED_VARIABLE + BARE_OPERATOR + GAMING_MEMBER_PARAMETER, "i");

/**
 * Removes `--` line comments and slash-star block comments in a single left-to-right pass (whichever of a line comment, a block comment or a
 * single-quoted string starts first wins). String literals are matched only so that comment markers inside them are not mistaken for
 * comments; their text is kept, so it is still scanned.
 */
function withoutSqlComments(sql: string): string {
  return sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'/g, (match) => (match.startsWith("'") ? match : " "));
}

type Orientation = "parameter-first" | "variable-first";

function bareGamingMemberComparisons(definition: string): Orientation[] {
  const text = withoutSqlComments(definition);
  const found: Orientation[] = [];
  if (PARAMETER_FIRST.test(text)) found.push("parameter-first");
  if (VARIABLE_FIRST.test(text)) found.push("variable-first");
  return found;
}

async function scanPublicSchema(db: Client): Promise<{ scanned: number; offenders: { signature: string; orientations: Orientation[] }[] }> {
  const { rows } = await db.query(
    `select p.oid::regprocedure::text as signature, pg_get_functiondef(p.oid) as def
       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'public' and p.prokind = 'f' order by 1`
  );
  const offenders = rows
    .map((r) => ({ signature: r.signature as string, orientations: bareGamingMemberComparisons(r.def as string) }))
    .filter((r) => r.orientations.length > 0);
  return { scanned: rows.length, offenders };
}

// -----------------------------------------------------------------------------------------------------------------------------
// Scaffolding
// -----------------------------------------------------------------------------------------------------------------------------

interface Comp { competitionId: string; organizerId: string }
type OpenComp = Comp & { teamIds: string[] };

let captainPool: Promise<string[]> | undefined;
/** Four captains, shared by the competitions below (a captaincy is unique per competition, not across them). */
function captains(): Promise<string[]> {
  if (!captainPool) {
    captainPool = (async () => {
      const ids: string[] = [];
      for (let i = 0; i < 4; i++) ids.push((await createMember(`Legacy Captain ${i}`)).gamingMemberId);
      return ids;
    })();
  }
  return captainPool;
}
let strangerPromise: Promise<string> | undefined;
function strangerId(): Promise<string> {
  if (!strangerPromise) strangerPromise = createMember("Legacy Stranger").then((m) => m.gamingMemberId);
  return strangerPromise;
}
let publishedPromise: Promise<Bracket> | undefined;
/** One PUBLISHED four-team bracket, shared as the "no longer in the early lifecycle" competition. Nothing here mutates it. */
function publishedBracket(): Promise<Bracket> {
  if (!publishedPromise) publishedPromise = buildBracket("legacy-published");
  return publishedPromise;
}

/** A DRAFT competition with its own OPERATIONAL organizer. */
async function newCompetition(label: string): Promise<Comp> {
  const operator = await createMember(`${label} Operator`);
  await grantOperational(operator.gamingMemberId);
  const created = await createCompetition(compRepo, operator.gamingMemberId, `NullSafe94 ${label} ${RUN}`, "SOCCER_5V5");
  return { competitionId: created.competitionId, organizerId: operator.gamingMemberId };
}
/** Registration open, with `howMany` accepted teams. */
async function openCompetition(label: string, howMany: number): Promise<OpenComp> {
  const c = await newCompetition(label);
  await openTeamRegistration(compRepo, c.competitionId, c.organizerId);
  const pool = await captains();
  const teamIds: string[] = [];
  for (let i = 0; i < howMany; i++) {
    teamIds.push((await addCompetitionTeam(compRepo, c.competitionId, c.organizerId, `${label} Team ${i} ${RUN}`, pool[i])).competitionTeamId);
  }
  return { ...c, teamIds };
}

async function countRows(table: string, filters: Record<string, string>): Promise<number> {
  let query = serviceClient.from(table).select("*", { count: "exact", head: true });
  for (const [column, value] of Object.entries(filters)) query = query.eq(column, value);
  const { count, error } = await query;
  if (error) throw error;
  return count ?? 0;
}
const teamCount = (competitionId: string) => countRows("competition_teams", { competition_id: competitionId });
const fixtureCount = (competitionId: string) => countRows("competition_fixtures", { competition_id: competitionId });
const cancelAuditCount = (competitionId: string) => countRows("admin_audit_events", { action_type: "CANCEL_INCOMPLETE_COMPETITION", target_id: competitionId });

type Attempt = { ok: true; rows: Record<string, any>[] } | { ok: false; message: string };
/** One statement inside an open transaction, isolated by a savepoint so a raised error does not abort the transaction. */
async function attempt(db: Client, sql: string, values: unknown[]): Promise<Attempt> {
  await db.query("savepoint probe");
  try {
    const result = await db.query(sql, values);
    await db.query("release savepoint probe");
    return { ok: true, rows: result.rows };
  } catch (e) {
    await db.query("rollback to savepoint probe");
    return { ok: false, message: (e as Error).message };
  }
}

/** Runs `run` against `signature` put back to its pre-GATE-094 text, inside a transaction that is ALWAYS rolled back. */
async function withBareComparison(signature: string, run: (db: Client) => Promise<void>): Promise<void> {
  const db = await connectRaw();
  try {
    await db.query("begin");
    await mutate(db, signature, restoreLegacyBare);
    await run(db);
  } finally {
    await db.query("rollback").catch(() => {});
    await db.end();
  }
}

/** The committed function refuses the same NULL call the negative control then lets through, so the control starts from the fix. */
async function expectCommittedDenies(sql: string, values: unknown[]): Promise<void> {
  const db = await connectRaw();
  try {
    // Inside a transaction that is always rolled back: if the migration were ever absent, this call would perform the very attack the
    // control then demonstrates, and must not leave the file's own fixture changed.
    await db.query("begin");
    await expect(db.query(sql, values)).rejects.toThrow(DENIED);
  } finally {
    await db.query("rollback").catch(() => {});
    await db.end();
  }
}

type RpcResult = { error: { message: string } | null; data?: unknown };
/** A NULL organizer must get exactly the answer a stranger gets: the denial, and nothing about the competition's state. */
async function expectSameDenialAsStranger(call: (actor: string | null) => PromiseLike<RpcResult>, stranger: string): Promise<void> {
  const asNull = await call(null);
  const asStranger = await call(stranger);
  expect(asNull.error?.message ?? "").toMatch(DENIED);
  expect(asNull.error?.message).toBe(asStranger.error?.message);
  expect(asNull.data ?? null).toBeNull();
}

// =============================================================================================================================
// Inventory
// =============================================================================================================================

describe("GATE-094 inventory: the five legacy organizer functions, every active signature", () => {
  it("six signatures (add_competition_team has two): each SECURITY DEFINER with search_path=public, anon/authenticated/PUBLIC cannot execute and service_role can, IS DISTINCT FROM exactly once, and not the exact old bare line", async () => {
    const db = await connectRaw();
    try {
      const seen: string[] = [];
      for (const name of LEGACY_NAMES) {
        const { rows } = await db.query(
          `select p.oid, p.oid::regprocedure::text as signature, p.prosecdef, p.proconfig::text as cfg, pg_get_functiondef(p.oid) as def
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1`,
          [name]
        );
        expect(rows, `${name}: number of signatures`).toHaveLength(name === "add_competition_team_atomically" ? 2 : 1);
        for (const row of rows) {
          seen.push(row.signature as string);
          const def = row.def as string;
          expect(row.prosecdef, `${row.signature} security mode`).toBe(true);
          expect(row.cfg, `${row.signature} search_path`).toContain("search_path=public");
          expect(def.split(NULL_SAFE_ORGANIZER_CHECK).length - 1, `${row.signature}: null-safe comparison count`).toBe(1);
          expect(def, `${row.signature}: bare comparison`).not.toContain(BARE_LEGACY_ORGANIZER_CHECK);
          for (const role of ["anon", "authenticated"]) {
            const { rows: x } = await db.query("select has_function_privilege($1, $2::oid, 'EXECUTE') as ok", [role, row.oid]);
            expect(x[0].ok, `${role} must not execute ${row.signature}`).toBe(false);
          }
          const { rows: pub } = await db.query(
            `select count(*)::int as n from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = $1::oid and a.grantee = 0 and a.privilege_type = 'EXECUTE'`,
            [row.oid]
          );
          expect(pub[0].n, `PUBLIC must not execute ${row.signature}`).toBe(0);
          const { rows: svc } = await db.query("select has_function_privilege('service_role', $1::oid, 'EXECUTE') as ok", [row.oid]);
          expect(svc[0].ok, `service_role must execute ${row.signature}`).toBe(true);
        }
      }
      expect(seen.map(compact).sort()).toEqual(Object.values(LEGACY).map(compact).sort());
    } finally {
      await db.end();
    }
  }, 30000);

  it("the order is pinned: scope lock, row lock, not-found, exact-caller check, host revocation guard, and only then the first lifecycle or state check", async () => {
    const db = await connectRaw();
    try {
      const firstLifecycle: Record<keyof typeof LEGACY, string> = {
        open: "if v_state <> 'DRAFT' then",
        close: "if v_state <> 'TEAM_REGISTRATION_OPEN' then",
        publish: "if v_state <> 'READY_TO_PUBLISH' then",
        cancel: "if v_state = 'CANCELLED_WITHOUT_CHAMPION' then",
        add4: "if v_state not in ('DRAFT', 'TEAM_REGISTRATION_OPEN') then",
        add5: "if v_state not in ('DRAFT', 'TEAM_REGISTRATION_OPEN') then",
      };
      for (const [key, signature] of Object.entries(LEGACY) as [keyof typeof LEGACY, string][]) {
        const def = await functionDefinition(db, signature);
        const at = {
          lock: def.indexOf("pg_advisory_xact_lock(hashtext('competition_scope:'"),
          rowLock: def.indexOf("for update"),
          notFound: def.indexOf("COMPETITION_NOT_FOUND"),
          check: def.indexOf(NULL_SAFE_ORGANIZER_CHECK),
          guard: def.indexOf("perform assert_competition_not_host_revoked(p_competition_id);"),
          lifecycle: def.indexOf(firstLifecycle[key]),
        };
        for (const [name, i] of Object.entries(at)) expect(i, `${key} ${name}`).toBeGreaterThan(-1);
        expect(at.lock, `${key}`).toBeLessThan(at.rowLock);
        expect(at.rowLock, `${key}`).toBeLessThan(at.notFound);
        expect(at.notFound, `${key}`).toBeLessThan(at.check);
        expect(at.check, `${key}`).toBeLessThan(at.guard);
        expect(at.guard, `${key}`).toBeLessThan(at.lifecycle);
      }
    } finally {
      await db.end();
    }
  }, 30000);
});

// =============================================================================================================================
// The whole-schema scan, its self-test and its live controls
// =============================================================================================================================

describe("GATE-094 catalog scan for bare gaming-member authorization comparisons", () => {
  it("[detector self-test] pins the TEXT-LEVEL behavior of the scan: `<>` and `!=` between a BARE p_*gaming_member_id parameter and a BARE v_* variable are flagged in BOTH operand orders; comments, null-safe forms, `=`, other names and attached or wrapped operands are not; the known spurious flags AND the known hidden-comparison limits are pinned too — the catalog-level limits (schema, prokind, application code) are NOT tested here", () => {
    // Covered shapes: flagged, with the orientation(s) reported.
    const flagged: [string, Orientation[]][] = [
      ["if p_organizer_gaming_member_id <> v_organizer_id then", ["parameter-first"]],
      ["if p_organizer_gaming_member_id != v_organizer_id then", ["parameter-first"]],
      ["if v_organizer_id <> p_organizer_gaming_member_id then", ["variable-first"]],
      ["if v_captain_id != p_deciding_gaming_member_id then", ["variable-first"]],
      ["if v_organizer_id\n     <>\n     p_organizer_gaming_member_id then", ["variable-first"]],
      ["if v_organizer_id<>p_organizer_gaming_member_id then", ["variable-first"]],
      ["IF V_ORGANIZER_ID <> P_ORGANIZER_GAMING_MEMBER_ID THEN", ["variable-first"]],
      ["if v_organizer_id /* why */ <> p_organizer_gaming_member_id then", ["variable-first"]],
      ["if p_organizer_gaming_member_id <> v_a or v_b <> p_organizer_gaming_member_id then", ["parameter-first", "variable-first"]],
      // Name rules: the bare name p_gaming_member_id, digits in either name, and a real variable name such as v_sf1_id.
      ["if v_a <> p_gaming_member_id then", ["variable-first"]],
      ["if p_gaming_member_id <> v_a then", ["parameter-first"]],
      ["if v_a2 <> p_org2_gaming_member_id then", ["variable-first"]],
      ["if v_sf1_id <> p_organizer_gaming_member_id then", ["variable-first"]],
      // Comment handling must not hide code (a false negative inside the stated coverage).
      ["v_note := '--'; if v_organizer_id <> p_organizer_gaming_member_id then", ["variable-first"]],
      ["-- see the /* note\nif v_organizer_id <> p_organizer_gaming_member_id then raise exception 'x'; end if;\n/* later */ return;", ["variable-first"]],
    ];
    for (const [text, expected] of flagged) expect(bareGamingMemberComparisons(text), text).toEqual(expected);

    // Not flagged. The first four are the scan working; the rest are its stated limits, written as tests so that nobody reads a clean
    // result as wider than it is.
    const notFlagged: [string, string][] = [
      ["if p_organizer_gaming_member_id is distinct from v_organizer_id then", "the null-safe form"],
      ["if v_organizer_id is distinct from p_organizer_gaming_member_id then", "the null-safe form, other order"],
      ["-- if v_organizer_id <> p_organizer_gaming_member_id then", "a line comment"],
      ["/* if p_organizer_gaming_member_id <> v_organizer_id then */", "a block comment"],
      ["if v_host_token <> p_host_token then", "OUT OF SCOPE: a parameter not named p_*gaming_member_id"],
      ["if v_organizer_id <> organizer_gaming_member_id then", "OUT OF SCOPE: a parameter without the p_ prefix"],
      ["if l_organizer_id <> p_organizer_gaming_member_id then", "OUT OF SCOPE: a variable without the v_ prefix"],
      ["if v_organizer_id = p_organizer_gaming_member_id then", "OUT OF SCOPE: `=` is not scanned"],
      ["if not (v_organizer_id = p_organizer_gaming_member_id) then", "OUT OF SCOPE: NOT (a = b) is not scanned"],
      ["if competitions.organizer_gaming_member_id <> p_organizer_gaming_member_id then", "OUT OF SCOPE: a column operand"],
      ["if p_a_gaming_member_id <> p_b_gaming_member_id then", "OUT OF SCOPE: two parameters"],
      // Attached or wrapped operands are not interpreted, and behave the same in both orders.
      ["if (v_organizer_id) <> p_organizer_gaming_member_id then", "OUT OF SCOPE: a parenthesised operand"],
      ["if p_organizer_gaming_member_id <> (v_organizer_id) then", "OUT OF SCOPE: a parenthesised operand, other order"],
      ["if v_organizer_id::uuid <> p_organizer_gaming_member_id then", "OUT OF SCOPE: a cast"],
      ["if p_organizer_gaming_member_id <> v_organizer_id::uuid then", "OUT OF SCOPE: a cast, other order"],
      ["if v_rec.organizer_gaming_member_id <> p_organizer_gaming_member_id then", "OUT OF SCOPE: a field selection"],
      ["if p_organizer_gaming_member_id <> v_rec.organizer_gaming_member_id then", "OUT OF SCOPE: a field selection, other order"],
      ["if v_ids[1] <> p_organizer_gaming_member_id then", "OUT OF SCOPE: a subscript"],
      ["if p_organizer_gaming_member_id <> v_ids[1] then", "OUT OF SCOPE: a subscript, other order"],
      ["if rec.v_total <> p_organizer_gaming_member_id then", "OUT OF SCOPE: a qualified name"],
      ["if v_f(1) <> p_organizer_gaming_member_id then", "OUT OF SCOPE: a called operand"],
      ["if p_organizer_gaming_member_id <> v_f(1) then", "OUT OF SCOPE: a called operand, other order"],
      ["if v_a$ <> p_organizer_gaming_member_id then", "OUT OF SCOPE: an identifier containing $"],
      // Names that merely contain or resemble the prefixes must not match.
      ["if lv_x <> p_organizer_gaming_member_id then", "a name that merely contains v_"],
      ["if xp_organizer_gaming_member_id <> v_x then", "a name that merely contains p_"],
      ["if vendor_id <> p_organizer_gaming_member_id then", "a name that starts with v but not v_"],
      ["if v_x <> payer_gaming_member_id then", "a name that starts with p but not p_"],
    ];
    for (const [text, why] of notFlagged) expect(bareGamingMemberComparisons(text), `${why}: ${text}`).toEqual([]);

    // Known limits that FLAG (a spurious flag is loud), pinned so they stay visible.
    const spurious: [string, Orientation[], string][] = [
      ["raise exception 'v_x != p_organizer_gaming_member_id';", ["variable-first"], "the text of a string literal is scanned as if it were code"],
      ["/* a /* b */ if v_x <> p_organizer_gaming_member_id then */ return;", ["variable-first"], "nested block comments are not parsed (PostgreSQL nests them)"],
      ["if p_organizer_gaming_member_id <> v_x + 1 then", ["parameter-first"], "an expression around an operand is not interpreted; this order happens to match, its mirror does not"],
    ];
    for (const [text, expected, why] of spurious) expect(bareGamingMemberComparisons(text), `${why}: ${text}`).toEqual(expected);

    // Known limits that HIDE a real comparison (a false negative, the serious direction). The scan does not handle these. Every input below
    // contains a real bare comparison and yet reports nothing; each is pinned by one example so the limit stays visible and nobody reads a
    // clean result as covering them.
    const hiddenByLimit: [string, string][] = [
      ["E'a\\''; v_s := '--'; if v_a <> p_x_gaming_member_id then", "an E'..' string with a backslash-quote flips the quote parity, so the later -- starts a comment"],
      ["$q$ -- $q$; if v_a <> p_x_gaming_member_id then", "dollar-quoted text containing --"],
      ["$q$ /* $q$; if v_a <> p_x_gaming_member_id then /* end */", "dollar-quoted text containing /*"],
      ["select \"a--b\" into v_x; if v_a <> p_x_gaming_member_id then", "a double-quoted identifier containing --"],
      ["-- note\r if v_a <> p_x_gaming_member_id then", "a lone CR does not end a -- comment"],
    ];
    for (const [text, why] of hiddenByLimit) expect(bareGamingMemberComparisons(text), `KNOWN HIDDEN (false negative): ${why}`).toEqual([]);
  });

  it("catalog scan of schema `public` (every function with prokind 'f'; comments removed; bare identifiers only): no `<>` or `!=` joins a p_*gaming_member_id parameter and a v_* variable, in either operand order — it does NOT cover `=` or NOT(..=..) forms, other names, wrapped or attached operands, other schemas, or the application code", async () => {
    const db = await connectRaw();
    try {
      const { scanned, offenders } = await scanPublicSchema(db);
      expect(scanned, "the scan must actually have read the catalog").toBeGreaterThan(50);
      expect(offenders).toEqual([]);
    } finally {
      await db.end();
    }
  }, 30000);

  it("[live control] putting the bare comparison back into each of the six signatures makes this same catalog scan report exactly that signature, as variable-first, and nothing else", async () => {
    for (const signature of Object.values(LEGACY)) {
      await withBareComparison(signature, async (db) => {
        const { offenders } = await scanPublicSchema(db);
        expect(offenders.map((o) => ({ signature: compact(o.signature), orientations: o.orientations }))).toEqual([{ signature: compact(signature), orientations: ["variable-first"] }]);
      });
    }
    const db = await connectRaw();
    try {
      expect((await scanPublicSchema(db)).offenders).toEqual([]);
    } finally {
      await db.end();
    }
  }, 120000);

  it("[live control] a throwaway function written in each operand order is reported by the same scan, and is gone after the rollback", async () => {
    const db = await connectRaw();
    try {
      await db.query("begin");
      await db.query(`create function public.gate094_probe_parameter_first(p_probe_gaming_member_id uuid) returns boolean language plpgsql as $f$
        declare v_probe_owner uuid := gen_random_uuid();
        begin
          if p_probe_gaming_member_id <> v_probe_owner then return false; end if;
          return true;
        end $f$`);
      await db.query(`create function public.gate094_probe_variable_first(p_probe_gaming_member_id uuid) returns boolean language plpgsql as $f$
        declare v_probe_owner uuid := gen_random_uuid();
        begin
          if v_probe_owner != p_probe_gaming_member_id then return false; end if;
          return true;
        end $f$`);
      const { offenders } = await scanPublicSchema(db);
      expect(offenders.map((o) => ({ signature: o.signature, orientations: o.orientations }))).toEqual([
        { signature: "gate094_probe_parameter_first(uuid)", orientations: ["parameter-first"] },
        { signature: "gate094_probe_variable_first(uuid)", orientations: ["variable-first"] },
      ]);
      await db.query("rollback");
      const { rows } = await db.query("select count(*)::int as n from pg_proc where proname like 'gate094_probe%'");
      expect(rows[0].n).toBe(0);
    } finally {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  }, 30000);
});

// =============================================================================================================================
// 1. open_team_registration_atomically
// =============================================================================================================================

describe("open_team_registration_atomically (GATE-094)", () => {
  let draft: Comp;
  let published: Bracket;
  let stranger: string;
  beforeAll(async () => {
    draft = await newCompetition("open");
    published = await publishedBracket();
    stranger = await strangerId();
  }, 240000);

  const call = (competitionId: string, actor: string | null) =>
    serviceClient.rpc("open_team_registration_atomically", { p_competition_id: competitionId, p_organizer_gaming_member_id: actor });
  const RAW = "select * from open_team_registration_atomically($1, null)";

  it("a NULL organizer is denied at the authorization boundary: the DRAFT competition stays DRAFT", async () => {
    expect(await competitionState(draft.competitionId)).toBe("DRAFT");
    const { error } = await call(draft.competitionId, null);
    expect(error?.message ?? "").toMatch(DENIED);
    expect(await competitionState(draft.competitionId)).toBe("DRAFT");
  }, 60000);

  it("the denial comes BEFORE any state disclosure: on a PUBLISHED competition a NULL organizer is told exactly what a stranger is told, not COMPETITION_NOT_DRAFT", async () => {
    await expectSameDenialAsStranger((actor) => call(published.competitionId, actor), stranger);
    expect(await competitionState(published.competitionId)).toBe("PUBLISHED");
  }, 60000);

  it("[negative control] with the previous bare comparison put back, a NULL organizer OPENS a DRAFT competition and is TOLD the state of a PUBLISHED one", async () => {
    await expectCommittedDenies(RAW, [draft.competitionId]);
    await withBareComparison(LEGACY.open, async (db) => {
      const told = await attempt(db, RAW, [published.competitionId]);
      expect(told.ok).toBe(false);
      expect(told.ok ? "" : told.message).toMatch(/COMPETITION_NOT_DRAFT/); // the state disclosure
      expect(told.ok ? "" : told.message).not.toMatch(DENIED);
      const opened = await attempt(db, RAW, [draft.competitionId]);
      expect(opened.ok, "the NULL organizer must get past the organizer check").toBe(true);
      expect(opened.ok ? opened.rows[0].state : "").toBe("TEAM_REGISTRATION_OPEN"); // the attack succeeds
      const { rows } = await db.query("select state from competitions where competition_id = $1", [draft.competitionId]);
      expect(rows[0].state).toBe("TEAM_REGISTRATION_OPEN");
    });
    expect(await competitionState(draft.competitionId)).toBe("DRAFT");
  }, 60000);

  it("valid actors are unchanged: a stranger is denied, the real organizer opens registration, and opening it again is the lifecycle refusal for the organizer only", async () => {
    expect((await call(draft.competitionId, stranger)).error?.message ?? "").toMatch(DENIED);
    expect(await competitionState(draft.competitionId)).toBe("DRAFT");
    const opened = await openTeamRegistration(compRepo, draft.competitionId, draft.organizerId);
    expect(opened.state).toBe("TEAM_REGISTRATION_OPEN");
    expect((await call(draft.competitionId, draft.organizerId)).error?.message ?? "").toMatch(/COMPETITION_NOT_DRAFT/);
    expect((await call(draft.competitionId, null)).error?.message ?? "").toMatch(DENIED);
    expect(await competitionState(draft.competitionId)).toBe("TEAM_REGISTRATION_OPEN");
  }, 120000);
});

// =============================================================================================================================
// 2. close_team_registration_atomically
// =============================================================================================================================

describe("close_team_registration_atomically (GATE-094)", () => {
  let o: OpenComp;
  let published: Bracket;
  let stranger: string;
  let fourthCaptain: string;
  beforeAll(async () => {
    o = await openCompetition("close", 3);
    published = await publishedBracket();
    stranger = await strangerId();
    fourthCaptain = (await captains())[3];
  }, 240000);

  const call = (competitionId: string, actor: string | null) =>
    serviceClient.rpc("close_team_registration_atomically", { p_competition_id: competitionId, p_organizer_gaming_member_id: actor });
  const RAW = "select * from close_team_registration_atomically($1, null)";

  it("with three accepted teams a NULL organizer is denied, and is NOT told how many teams there are (no `found 3`)", async () => {
    expect(await teamCount(o.competitionId)).toBe(3);
    await expectSameDenialAsStranger((actor) => call(o.competitionId, actor), stranger);
    expect(await competitionState(o.competitionId)).toBe("TEAM_REGISTRATION_OPEN");
  }, 60000);

  it("on a PUBLISHED competition a NULL organizer is told exactly what a stranger is told, not TEAM_REGISTRATION_NOT_OPEN", async () => {
    await expectSameDenialAsStranger((actor) => call(published.competitionId, actor), stranger);
    expect(await competitionState(published.competitionId)).toBe("PUBLISHED");
  }, 60000);

  it("[negative control] with the previous bare comparison put back, a NULL organizer is TOLD the team count and the registration state", async () => {
    await expectCommittedDenies(RAW, [o.competitionId]);
    await withBareComparison(LEGACY.close, async (db) => {
      const count = await attempt(db, RAW, [o.competitionId]);
      expect(count.ok).toBe(false);
      expect(count.ok ? "" : count.message).toMatch(/TEAM_REGISTRATION_CAPACITY_NOT_REACHED.*found 3/); // the disclosed count
      const state = await attempt(db, RAW, [published.competitionId]);
      expect(state.ok).toBe(false);
      expect(state.ok ? "" : state.message).toMatch(/TEAM_REGISTRATION_NOT_OPEN/);
      expect(state.ok ? "" : state.message).not.toMatch(DENIED);
    });
    expect(await competitionState(o.competitionId)).toBe("TEAM_REGISTRATION_OPEN");
  }, 60000);

  it("with four accepted teams a NULL organizer is still denied and closes nothing; [negative control] with the bare comparison it CLOSES the competition", async () => {
    await addCompetitionTeam(compRepo, o.competitionId, o.organizerId, `close Team 3 ${RUN}`, fourthCaptain);
    expect(await teamCount(o.competitionId)).toBe(4);
    const { error } = await call(o.competitionId, null);
    expect(error?.message ?? "").toMatch(DENIED);
    expect(await competitionState(o.competitionId)).toBe("TEAM_REGISTRATION_OPEN");
    await withBareComparison(LEGACY.close, async (db) => {
      const closed = await attempt(db, RAW, [o.competitionId]);
      expect(closed.ok, "the NULL organizer must get past the organizer check").toBe(true);
      expect(closed.ok ? closed.rows[0].state : "").toBe("READY_TO_PUBLISH"); // the attack succeeds
    });
    expect(await competitionState(o.competitionId)).toBe("TEAM_REGISTRATION_OPEN");
  }, 120000);

  it("valid actors are unchanged: a stranger is denied, the real organizer closes registration, and a NULL organizer cannot touch it afterwards", async () => {
    expect((await call(o.competitionId, stranger)).error?.message ?? "").toMatch(DENIED);
    expect(await competitionState(o.competitionId)).toBe("TEAM_REGISTRATION_OPEN");
    const closed = await closeTeamRegistration(compRepo, o.competitionId, o.organizerId);
    expect(closed.state).toBe("READY_TO_PUBLISH");
    expect((await call(o.competitionId, o.organizerId)).error?.message ?? "").toMatch(/TEAM_REGISTRATION_NOT_OPEN/);
    expect((await call(o.competitionId, null)).error?.message ?? "").toMatch(DENIED);
    expect(await competitionState(o.competitionId)).toBe("READY_TO_PUBLISH");
  }, 120000);
});

// =============================================================================================================================
// 3. publish_competition_atomically
// =============================================================================================================================

describe("publish_competition_atomically (GATE-094)", () => {
  let ready: OpenComp;
  let published: Bracket;
  let stranger: string;
  const times = [iso(3600_000), iso(7200_000), iso(10800_000)];
  beforeAll(async () => {
    ready = await openCompetition("publish", 4);
    await closeTeamRegistration(compRepo, ready.competitionId, ready.organizerId);
    published = await publishedBracket();
    stranger = await strangerId();
  }, 240000);

  const pairing = (teamIds: string[]) => [teamIds[0], teamIds[1], teamIds[2], teamIds[3]];
  const call = (competitionId: string, actor: string | null, teams: string[]) =>
    serviceClient.rpc("publish_competition_atomically", {
      p_competition_id: competitionId,
      p_organizer_gaming_member_id: actor,
      p_semifinal_1_team_a_id: teams[0],
      p_semifinal_1_team_b_id: teams[1],
      p_semifinal_2_team_a_id: teams[2],
      p_semifinal_2_team_b_id: teams[3],
      p_semifinal_1_scheduled_at: times[0],
      p_semifinal_2_scheduled_at: times[1],
      p_final_scheduled_at: times[2],
    });
  const RAW = "select * from publish_competition_atomically($1, null, $2, $3, $4, $5, $6::timestamptz, $7::timestamptz, $8::timestamptz)";
  const rawValues = (competitionId: string, teams: string[]) => [competitionId, ...pairing(teams), ...times];
  const duplicatePairing = () => [ready.teamIds[0], ready.teamIds[0], ready.teamIds[1], ready.teamIds[2]];

  it("a NULL organizer is denied at the authorization boundary: the competition stays READY_TO_PUBLISH and no fixture is created", async () => {
    expect(await competitionState(ready.competitionId)).toBe("READY_TO_PUBLISH");
    const { error } = await call(ready.competitionId, null, ready.teamIds);
    expect(error?.message ?? "").toMatch(DENIED);
    expect(await competitionState(ready.competitionId)).toBe("READY_TO_PUBLISH");
    expect(await fixtureCount(ready.competitionId)).toBe(0);
  }, 60000);

  it("the denial comes BEFORE any state or pairing disclosure: a PUBLISHED competition and an invalid pairing both get exactly a stranger's answer", async () => {
    await expectSameDenialAsStranger((actor) => call(published.competitionId, actor, published.teams.map((t) => t.competitionTeamId)), stranger); // not COMPETITION_NOT_READY_TO_PUBLISH
    await expectSameDenialAsStranger((actor) => call(ready.competitionId, actor, duplicatePairing()), stranger); // not COMPETITION_PAIRING_INVALID
    expect(await fixtureCount(ready.competitionId)).toBe(0);
  }, 60000);

  it("[negative control] with the previous bare comparison put back, a NULL organizer is TOLD the state and the pairing rule, and PUBLISHES the competition", async () => {
    await expectCommittedDenies(RAW, rawValues(ready.competitionId, ready.teamIds));
    await withBareComparison(LEGACY.publish, async (db) => {
      const state = await attempt(db, RAW, rawValues(published.competitionId, published.teams.map((t) => t.competitionTeamId)));
      expect(state.ok ? "" : state.message).toMatch(/COMPETITION_NOT_READY_TO_PUBLISH/);
      const pairingDisclosed = await attempt(db, RAW, rawValues(ready.competitionId, duplicatePairing()));
      expect(pairingDisclosed.ok ? "" : pairingDisclosed.message).toMatch(/COMPETITION_PAIRING_INVALID/);
      const out = await attempt(db, RAW, rawValues(ready.competitionId, ready.teamIds));
      expect(out.ok, "the NULL organizer must get past the organizer check").toBe(true);
      expect(out.ok ? out.rows[0].state : "").toBe("PUBLISHED"); // the attack succeeds
      const { rows } = await db.query("select count(*)::int as n from competition_fixtures where competition_id = $1", [ready.competitionId]);
      expect(rows[0].n).toBe(3);
    });
    expect(await competitionState(ready.competitionId)).toBe("READY_TO_PUBLISH");
    expect(await fixtureCount(ready.competitionId)).toBe(0);
  }, 60000);

  it("valid actors are unchanged: a stranger is denied, the real organizer publishes, and a NULL organizer cannot touch the published competition", async () => {
    expect((await call(ready.competitionId, stranger, ready.teamIds)).error?.message ?? "").toMatch(DENIED);
    expect(await fixtureCount(ready.competitionId)).toBe(0);
    const out = await publishCompetition(compRepo, ready.competitionId, ready.organizerId, ready.teamIds[0], ready.teamIds[1], ready.teamIds[2], ready.teamIds[3], times[0], times[1], times[2]);
    expect(out.state).toBe("PUBLISHED");
    expect(await fixtureCount(ready.competitionId)).toBe(3);
    expect((await call(ready.competitionId, null, ready.teamIds)).error?.message ?? "").toMatch(DENIED);
    expect(await fixtureCount(ready.competitionId)).toBe(3);
  }, 120000);
});

// =============================================================================================================================
// 4. cancel_incomplete_competition_atomically
// =============================================================================================================================

describe("cancel_incomplete_competition_atomically (GATE-094)", () => {
  let draft: Comp;
  let done: Comp;
  let published: Bracket;
  let stranger: string;
  const DONE_REASON = "Cancelled before the NULL-actor probes.";
  beforeAll(async () => {
    draft = await newCompetition("cancel-draft");
    done = await newCompetition("cancel-done");
    await cancelCompetition(compRepo, done.competitionId, done.organizerId, DONE_REASON);
    published = await publishedBracket();
    stranger = await strangerId();
  }, 240000);

  const call = (competitionId: string, actor: string | null) =>
    serviceClient.rpc("cancel_incomplete_competition_atomically", { p_competition_id: competitionId, p_organizer_gaming_member_id: actor, p_reason: "NULL caller probe" });
  const RAW = "select * from cancel_incomplete_competition_atomically($1, null, 'NULL caller probe')";

  it("a NULL organizer is denied at the authorization boundary: the DRAFT competition is not cancelled and no audit event is written", async () => {
    expect(await cancelAuditCount(draft.competitionId)).toBe(0);
    const { error } = await call(draft.competitionId, null);
    expect(error?.message ?? "").toMatch(DENIED);
    expect(await competitionState(draft.competitionId)).toBe("DRAFT");
    expect(await cancelAuditCount(draft.competitionId)).toBe(0);
  }, 60000);

  it("the denial comes BEFORE the idempotent replay and the state check: an already-cancelled competition does not hand a NULL organizer its reason, and a PUBLISHED one is not reported as not cancellable", async () => {
    expect(await cancelAuditCount(done.competitionId)).toBe(1);
    await expectSameDenialAsStranger((actor) => call(done.competitionId, actor), stranger); // not the replay row (already_cancelled, cancelled_reason)
    await expectSameDenialAsStranger((actor) => call(published.competitionId, actor), stranger); // not COMPETITION_NOT_CANCELLABLE
    expect(await competitionState(published.competitionId)).toBe("PUBLISHED");
    expect(await cancelAuditCount(done.competitionId)).toBe(1);
  }, 60000);

  it("[negative control] with the previous bare comparison put back, a NULL organizer is handed the cancellation REPLAY and its reason, is told a PUBLISHED competition is not cancellable, and on a DRAFT one is stopped only by the audit row's shape constraint", async () => {
    await expectCommittedDenies(RAW, [done.competitionId]);
    await withBareComparison(LEGACY.cancel, async (db) => {
      const replay = await attempt(db, RAW, [done.competitionId]);
      expect(replay.ok, "the NULL organizer must get past the organizer check").toBe(true);
      expect(replay.ok ? replay.rows[0] : null).toMatchObject({ already_cancelled: true, cancelled_reason: DONE_REASON }); // the disclosed reason
      const told = await attempt(db, RAW, [published.competitionId]);
      expect(told.ok ? "" : told.message).toMatch(/COMPETITION_NOT_CANCELLABLE/);
      expect(told.ok ? "" : told.message).not.toMatch(DENIED);
      // On a DRAFT competition the NULL organizer also gets past the organizer check, but the write that follows is refused: the audit row's
      // shape constraint requires an actor for a GAMING_MEMBER event. So for cancel it is a later constraint, not the organizer check, that
      // stops the cancellation itself; the replay and the state disclosure above are what the missing denial let through.
      const crossed = await attempt(db, RAW, [draft.competitionId]);
      expect(crossed.ok).toBe(false);
      expect(crossed.ok ? "" : crossed.message).toMatch(/admin_audit_events_actor_shape/);
      expect(crossed.ok ? "" : crossed.message).not.toMatch(DENIED);
    });
    expect(await competitionState(draft.competitionId)).toBe("DRAFT");
    expect(await cancelAuditCount(draft.competitionId)).toBe(0);
  }, 60000);

  it("valid actors are unchanged: a stranger is denied, the real organizer cancels, the retry is idempotent, and a NULL organizer cannot read the replay", async () => {
    expect((await call(draft.competitionId, stranger)).error?.message ?? "").toMatch(DENIED);
    expect(await competitionState(draft.competitionId)).toBe("DRAFT");
    const first = await cancelCompetition(compRepo, draft.competitionId, draft.organizerId, "Organizer cancelled.");
    expect(first).toMatchObject({ state: "CANCELLED_WITHOUT_CHAMPION", alreadyCancelled: false });
    expect(await cancelAuditCount(draft.competitionId)).toBe(1);
    const retry = await cancelCompetition(compRepo, draft.competitionId, draft.organizerId, "Organizer cancelled.");
    expect(retry.alreadyCancelled).toBe(true);
    expect(await cancelAuditCount(draft.competitionId)).toBe(1);
    expect((await call(draft.competitionId, null)).error?.message ?? "").toMatch(DENIED);
  }, 120000);
});

// =============================================================================================================================
// 5. add_competition_team_atomically — both overloads
// =============================================================================================================================

describe.each([
  ["4-argument legacy overload", "add4"],
  ["5-argument overload with a public code", "add5"],
] as const)("add_competition_team_atomically, %s (GATE-094)", (_label, which) => {
  let empty: OpenComp;
  let full: OpenComp;
  let published: Bracket;
  let stranger: string;
  let captain: string;
  beforeAll(async () => {
    empty = await openCompetition(`${which}-empty`, 0);
    full = await openCompetition(`${which}-full`, 4);
    published = await publishedBracket();
    stranger = await strangerId();
    captain = (await captains())[0];
  }, 240000);

  const call = (competitionId: string, actor: string | null, name: string, captainId: string) =>
    serviceClient.rpc("add_competition_team_atomically", {
      p_competition_id: competitionId,
      p_organizer_gaming_member_id: actor,
      p_name: name,
      p_captain_gaming_member_id: captainId,
      ...(which === "add5" ? { p_public_code: generatePublicCode() } : {}),
    });
  const RAW = which === "add5"
    ? "select * from add_competition_team_atomically($1, null, $2, $3, $4)"
    : "select * from add_competition_team_atomically($1, null, $2, $3)";
  const rawValues = (competitionId: string, name: string) => (which === "add5" ? [competitionId, name, captain, generatePublicCode()] : [competitionId, name, captain]);

  it("a NULL organizer is denied at the authorization boundary: no team is added", async () => {
    expect(await teamCount(empty.competitionId)).toBe(0);
    const { error } = await call(empty.competitionId, null, `NULL probe ${RUN}`, captain);
    expect(error?.message ?? "").toMatch(DENIED);
    expect(await teamCount(empty.competitionId)).toBe(0);
  }, 60000);

  it("the denial comes BEFORE any state or capacity disclosure: a full competition and a PUBLISHED one both get exactly a stranger's answer", async () => {
    await expectSameDenialAsStranger((actor) => call(full.competitionId, actor, `NULL probe ${RUN}`, captain), stranger); // not TEAM_CAPACITY_REACHED
    await expectSameDenialAsStranger((actor) => call(published.competitionId, actor, `NULL probe ${RUN}`, captain), stranger); // not COMPETITION_NOT_DRAFT
    expect(await teamCount(full.competitionId)).toBe(4);
    expect(await teamCount(published.competitionId)).toBe(4);
  }, 60000);

  it("[negative control] with the previous bare comparison put back, a NULL organizer is TOLD the capacity and the state, and ADDS a team", async () => {
    await expectCommittedDenies(RAW, rawValues(empty.competitionId, `NULL probe ${RUN}`));
    await withBareComparison(LEGACY[which], async (db) => {
      const state = await attempt(db, RAW, rawValues(published.competitionId, `NULL probe ${RUN}`));
      expect(state.ok ? "" : state.message).toMatch(/COMPETITION_NOT_DRAFT/);
      const capacity = await attempt(db, RAW, rawValues(full.competitionId, `NULL probe ${RUN}`));
      expect(capacity.ok ? "" : capacity.message).toMatch(/TEAM_CAPACITY_REACHED/);
      const added = await attempt(db, RAW, rawValues(empty.competitionId, `NULL probe ${RUN}`));
      expect(added.ok, "the NULL organizer must get past the organizer check").toBe(true); // the attack succeeds
      const { rows } = await db.query("select count(*)::int as n from competition_teams where competition_id = $1", [empty.competitionId]);
      expect(rows[0].n).toBe(1);
    });
    expect(await teamCount(empty.competitionId)).toBe(0);
  }, 60000);

  it("valid actors are unchanged: a stranger is denied, the real organizer adds a team through this overload, and a NULL organizer cannot add another", async () => {
    expect((await call(empty.competitionId, stranger, `Stranger ${RUN}`, captain)).error?.message ?? "").toMatch(DENIED);
    expect(await teamCount(empty.competitionId)).toBe(0);
    const added = await call(empty.competitionId, empty.organizerId, `Organizer Team ${which} ${RUN}`, captain);
    expect(added.error, "the real organizer's call").toBeNull();
    expect(await teamCount(empty.competitionId)).toBe(1);
    expect((await call(empty.competitionId, null, `NULL again ${RUN}`, (await captains())[1])).error?.message ?? "").toMatch(DENIED);
    expect(await teamCount(empty.competitionId)).toBe(1);
  }, 120000);
});

// =============================================================================================================================
// The GATE-094 controls left no trace
// =============================================================================================================================

describe("the GATE-094 negative controls left no trace", () => {
  it("all six signatures still use IS DISTINCT FROM and none the bare comparison, no probe function survives, the grants are intact, and the catalog scan is clean", async () => {
    const db = await connectRaw();
    try {
      for (const signature of Object.values(LEGACY)) {
        const def = await functionDefinition(db, signature);
        expect(def, signature).toContain(NULL_SAFE_ORGANIZER_CHECK);
        expect(def, signature).not.toContain(BARE_LEGACY_ORGANIZER_CHECK);
      }
      for (const name of LEGACY_NAMES) {
        const { rows } = await db.query(
          `select has_function_privilege('service_role', p.oid, 'EXECUTE') as svc, has_function_privilege('anon', p.oid, 'EXECUTE') as anon, has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1`,
          [name]
        );
        for (const row of rows) expect(row, name).toEqual({ svc: true, anon: false, auth: false });
      }
      expect((await db.query("select count(*)::int as n from pg_proc where proname like 'gate094_probe%'")).rows[0].n).toBe(0);
      expect((await scanPublicSchema(db)).offenders).toEqual([]);
    } finally {
      await db.end();
    }
  }, 30000);
});
