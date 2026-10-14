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

  it("NO function whose name contains `competition` compares its caller to a stored authority with a bare <> or != any more — every such comparison is IS DISTINCT FROM", async () => {
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
