import { randomUUID } from "node:crypto";

import { loadEnv } from "vite";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SupabaseHostRepository } from "../lib/gaming/host/db/supabaseHostRepository";
import { SupabaseCompetitionsRepository, translateError } from "../lib/gaming/competitions/db/supabaseCompetitionsRepository";
import { SupabaseGamingRepository } from "../lib/gaming/db/supabaseGamingRepository";
import { submitHostApplication } from "../lib/gaming/host/submitHostApplication";
import { withdrawHostApplication } from "../lib/gaming/host/withdrawHostApplication";
import { decideHostApplication } from "../lib/gaming/host/decideHostApplication";
import { revokeHostCapability } from "../lib/gaming/host/revokeHostCapability";
import { listHostApplicationsForReview } from "../lib/gaming/host/listHostApplicationsForReview";
import { createHostCompetition } from "../lib/gaming/host/createHostCompetition";
import { getHostStatus } from "../lib/gaming/host/getHostStatus";
import {
  HostApplicationAlreadyActiveError,
  HostApplicationNotFoundError,
  HostApplicationNotPendingError,
  HostApplicationAlreadyDecidedError,
  HostSelfReviewForbiddenError,
  HostCapabilityRequiredError,
  HostCapabilityAlreadyConsumedError,
  HostCapabilityRevokedError,
  HostReasonRequiredError,
  HostReviewerAuthorityRequiredError,
  InvalidHostApplicationError,
  InvalidHostCompetitionError,
} from "../lib/gaming/host/types";
import type { HostApplicationInput } from "../lib/gaming/host/types";
import { createCompetition } from "../lib/gaming/competitions/createCompetition";
import { openTeamRegistration } from "../lib/gaming/competitions/openTeamRegistration";
import { closeTeamRegistration } from "../lib/gaming/competitions/closeTeamRegistration";
import { addCompetitionTeam } from "../lib/gaming/competitions/addCompetitionTeam";
import { publishCompetition } from "../lib/gaming/competitions/publishCompetition";
import { cancelCompetition } from "../lib/gaming/competitions/cancelCompetition";
import { decideCompetitionTeam } from "../lib/gaming/competitions/decideCompetitionTeam";
import { organizerReviewJoinRequest } from "../lib/gaming/competitions/organizerReviewJoinRequest";
import { decideJoinRequest } from "../lib/gaming/competitions/decideJoinRequest";
import { declareRoster } from "../lib/gaming/competitions/declareRoster";
import { appointScorekeeper } from "../lib/gaming/competitions/appointScorekeeper";
import { correctFixture } from "../lib/gaming/competitions/correctFixture";
import { finalizeFixture } from "../lib/gaming/competitions/finalizeFixture";
import { forfeitFixture } from "../lib/gaming/competitions/forfeitFixture";
import { voidFixture } from "../lib/gaming/competitions/voidFixture";
import { registerForCompetition } from "../lib/gaming/competitions/registerForCompetition";
import { requestJoinTeam } from "../lib/gaming/competitions/requestJoinTeam";
import { submitFixtureEvidence } from "../lib/gaming/competitions/submitFixtureEvidence";
import { getCompetitionView } from "../lib/gaming/competitions/getCompetitionView";
import { resolveCompetitionByPublicCode } from "../lib/gaming/competitions/resolveCompetitionByPublicCode";
import {
  CompetitionAccessDeniedError,
  CompetitionNotDraftError,
  HostAccessRevokedError,
  OperationalAuthorityRequiredError,
  FixtureNotInEvidencePhaseError,
} from "../lib/gaming/competitions/types";
import { parsePlanningPlan, planToRpcPayload } from "../lib/gaming/competitions/planning";
import { statusForCompetitionsError } from "../lib/gaming/competitions/httpAuth";
import { isActiveOrganizer, isListedFor } from "../lib/gaming/competitions/organizerAccess";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";

/**
 * UG-CR-GATE-088 — Become a Host, against real local Postgres.
 *
 * Proves (the numbers are the Founder's required-test list):
 *  [T2-T10] the application lifecycle, its single-decision and replay safety, and the
 *           governance-only review surface;
 *  [T11-T14, T16, T18] the one-competition capability, its atomic consumption, the host's
 *           own administration, and that an invitation or code confers no organizer power
 *           while internally created competitions behave exactly as before;
 *  [T15, T17] an ownership/revocation matrix over EVERY organizer RPC, driven by a catalog
 *           inventory so a new organizer path cannot appear unguarded;
 *  [T19]    immutable, complete, idempotent-safe audit;
 *  [T20]    RLS, privileges, search paths and execute grants;
 *  [T22]    no identifier leaks in anything a browser receives;
 * plus deterministic lock/serialization proofs on raw connections, and NEGATIVE CONTROLS:
 * each core enforcement is removed inside a rolled-back transaction and the same scenario
 * is shown to then violate the invariant, so the tests above cannot pass vacuously.
 *
 * Host applications, capabilities and HOST_* audit events are deliberately undeletable, so
 * this file cannot clean up after itself: every identity it creates is unique and every
 * assertion is scoped to rows it created. `npx supabase db reset` restores a clean database.
 * The reviewer's PRODUCT_GOVERNANCE grant exists only for the duration of each call (an
 * active Governance grant anywhere would break the authority suite's first-bootstrap test).
 */

const env = loadEnv("development", process.cwd(), "");
const supabaseUrl = env.SUPABASE_URL;
requireLocalSupabase(supabaseUrl);
const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAnonKey = env.SUPABASE_ANON_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey || !supabaseAnonKey) {
  throw new Error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are required for contract tests.");
}

// Raw pg is needed to hold a lock across statements and to run rolled-back
// negative controls. The URL is supplied explicitly, never read from .env.local,
// and must be a loopback Postgres URL.
const supabaseDbUrl = process.env.COMPETITIONS_LOCAL_DB_URL ?? "";
if (!/^postgresql:\/\/[^@]+@(127\.0\.0\.1|localhost|\[::1\]):\d+\//.test(supabaseDbUrl)) {
  throw new Error("COMPETITIONS_LOCAL_DB_URL must be set to a loopback Postgres URL for host contract tests.");
}

const hostRepo = new SupabaseHostRepository(supabaseUrl, supabaseServiceRoleKey);
const compRepo = new SupabaseCompetitionsRepository(supabaseUrl, supabaseServiceRoleKey);
const gamingRepo = new SupabaseGamingRepository(supabaseUrl, supabaseServiceRoleKey);
const serviceClient = createClient(supabaseUrl, supabaseServiceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
const anonClient = createClient(supabaseUrl, supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false } });

const UUID_PATTERN = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
// UG-CR-GATE-SSS-007A: what a bearer token looks like — THREE dot-separated base64url segments, the first starting "eyJ" (the encoding of `{"`), the last possibly
// empty (an unsigned token). The three letters "eyJ" alone are not a token: a random public code can contain them, and the earlier guard (`eyJ` plus ten
// characters) failed a run whenever one did.
const JWT_SHAPE = /eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]*/;
const RUN = randomUUID().slice(0, 8);

interface Member {
  authUserId: string;
  gamingMemberId: string;
  email: string;
}

const createdAuthUserIds: string[] = [];
const createdMemberIds: string[] = [];
const createdOperationalMemberIds: string[] = [];
let reviewer: Member;
let counter = 0;

async function createMember(displayName: string): Promise<Member> {
  const email = `host-contract-${RUN}-${counter++}-${randomUUID().slice(0, 6)}@example.com`;
  const { data, error } = await serviceClient.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("Failed to create test auth user.");
  createdAuthUserIds.push(data.user.id);
  const member = await gamingRepo.createGamingMember(data.user.id, displayName);
  createdMemberIds.push(member.gamingMemberId);
  return { authUserId: data.user.id, gamingMemberId: member.gamingMemberId, email };
}

async function grantOperational(memberId: string): Promise<void> {
  const { error } = await serviceClient.from("authority_grants").insert({ gaming_member_id: memberId, authority_class: "OPERATIONAL" });
  if (error) throw error;
  createdOperationalMemberIds.push(memberId);
}

/** A signed-in browser-equivalent client: the anon key plus a real user access token (role `authenticated`). */
async function authenticatedClient(member: Member): Promise<SupabaseClient> {
  const link = await serviceClient.auth.admin.generateLink({ type: "magiclink", email: member.email });
  if (!link.data.properties) throw new Error("generateLink did not return properties.");
  const throwaway = createClient(supabaseUrl, supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const verified = await throwaway.auth.verifyOtp({ token_hash: link.data.properties.hashed_token, type: "email" });
  const token = verified.data.session?.access_token;
  if (!token) throw new Error("Could not obtain a session for the test member.");
  return createClient(supabaseUrl, supabaseAnonKey, {
    auth: { persistSession: false, autoRefreshToken: false },
    global: { headers: { Authorization: `Bearer ${token}` } },
  });
}

/** Holds PRODUCT_GOVERNANCE for the reviewer ONLY while `fn` runs. */
async function withGovernance<T>(fn: () => Promise<T>, who: Member = reviewer): Promise<T> {
  const { error } = await serviceClient.from("authority_grants").insert({ gaming_member_id: who.gamingMemberId, authority_class: "PRODUCT_GOVERNANCE" });
  if (error) throw error;
  try {
    return await fn();
  } finally {
    await serviceClient.from("authority_grants").delete().eq("gaming_member_id", who.gamingMemberId).eq("authority_class", "PRODUCT_GOVERNANCE");
  }
}

function applicationInput(label: string, over: Partial<HostApplicationInput> = {}): HostApplicationInput {
  return {
    venueName: `Venue ${label} ${RUN}`,
    cityArea: "Fictional Heights",
    playingFields: 2,
    venueDescription: `A fictional venue (${label}) used only by the local contract suite; it runs imaginary leagues.`,
    expectedWindow: "weekend of 14 November",
    expectedTeamCount: 4,
    confirmAllAdults: true,
    confirmIndependentScorekeepers: true,
    confirmPilotExclusions: true,
    ...over,
  };
}

const approve = (code: string) => withGovernance(() => decideHostApplication(hostRepo, reviewer.gamingMemberId, code, "APPROVE", null));
const reject = (code: string, reason = "Not a fit for the pilot.") => withGovernance(() => decideHostApplication(hostRepo, reviewer.gamingMemberId, code, "REJECT", reason));
const revoke = (code: string, reason = "Rules were not followed.") => withGovernance(() => revokeHostCapability(hostRepo, reviewer.gamingMemberId, code, reason));

async function apply(member: Member, label = "x"): Promise<string> {
  return (await submitHostApplication(hostRepo, member.gamingMemberId, applicationInput(label))).publicCode;
}

async function approvedHost(label: string): Promise<{ member: Member; code: string }> {
  const member = await createMember(`Host ${label}`);
  const code = await apply(member, label);
  await approve(code);
  return { member, code };
}

async function applicationRow(code: string) {
  const { data, error } = await serviceClient.from("competition_host_applications").select("*").eq("public_code", code).single();
  if (error) throw error;
  return data;
}

async function capabilityRow(applicationId: string) {
  const { data, error } = await serviceClient.from("competition_host_capabilities").select("*").eq("host_application_id", applicationId).maybeSingle();
  if (error) throw error;
  return data;
}

async function auditFor(targetId: string) {
  const { data, error } = await serviceClient.from("admin_audit_events").select("*").eq("target_id", targetId).order("occurred_at", { ascending: true });
  if (error) throw error;
  return data ?? [];
}

async function connectRaw(): Promise<Client> {
  const client = new Client({ connectionString: supabaseDbUrl, statement_timeout: 20000 });
  await client.connect();
  return client;
}

async function expectRejection<T extends Error>(promise: Promise<unknown>, ErrorClass: new (...args: any[]) => T): Promise<T> {
  const outcome = await promise.then(
    () => null,
    (e: unknown) => e
  );
  expect(outcome, `expected a ${ErrorClass.name}, but the call succeeded`).not.toBeNull();
  expect(outcome).toBeInstanceOf(ErrorClass);
  return outcome as T;
}

beforeAll(async () => {
  reviewer = await createMember("Rita Reviewer");
}, 30000);

afterAll(async () => {
  // Host rows cannot be deleted, so leave none PENDING behind: the review queue is global and capped, and a long-lived
  // local database must not fill with this suite's abandoned applications.
  const { data: pending } = await serviceClient
    .from("competition_host_applications")
    .select("public_code, gaming_member_id")
    .in("gaming_member_id", createdMemberIds)
    .eq("state", "PENDING");
  for (const row of pending ?? []) {
    await hostRepo.withdrawApplication(row.gaming_member_id, row.public_code).catch(() => {});
  }
  // OPERATIONAL grants carry no history trigger and are removed; host rows, HOST_* audit events and the members that
  // reference them cannot be (by design), so their auth users are left for `supabase db reset`.
  if (createdOperationalMemberIds.length > 0) {
    await serviceClient.from("authority_grants").delete().in("gaming_member_id", createdOperationalMemberIds);
  }
  await serviceClient.from("authority_grants").delete().eq("gaming_member_id", reviewer.gamingMemberId);
  for (const authUserId of createdAuthUserIds) {
    await serviceClient.auth.admin.deleteUser(authUserId); // returns an error object (not thrown) when history references the member
  }
}, 120000);

// =============================================================================
// [T20] Row-level security, privileges, search paths, execute grants
// =============================================================================

const HOST_TABLES = ["competition_host_applications", "competition_host_capabilities"];
const HOST_RPCS: Array<[string, string]> = [
  ["submit_host_application_atomically", "uuid, text, text, integer, text, text, integer, boolean, boolean, boolean"],
  ["withdraw_host_application_atomically", "uuid, text"],
  ["decide_host_application_atomically", "uuid, text, text, text"],
  ["revoke_host_capability_atomically", "uuid, text, text"],
  ["create_host_competition_atomically", "uuid, text, text, text"],
  ["get_host_status", "uuid"],
  ["list_host_applications_for_review", "uuid, text"],
  ["assert_competition_not_host_revoked", "uuid"],
  ["assert_actor_not_revoked_host", "uuid, uuid"],
];

describe("[T20] RLS, privileges, function search paths and execute grants match the boundary", () => {
  it("both host tables have RLS enabled with NO policies (deny by default; the only reader is the trusted server)", async () => {
    const db = await connectRaw();
    try {
      const { rows } = await db.query(
        `select c.relname, c.relrowsecurity, c.relforcerowsecurity, (select count(*) from pg_policy p where p.polrelid = c.oid)::int as policies
           from pg_class c join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relname = any($1) order by c.relname`,
        [HOST_TABLES]
      );
      expect(rows.map((r) => r.relname)).toEqual(HOST_TABLES);
      for (const row of rows) {
        expect(row.relrowsecurity, row.relname).toBe(true);
        expect(row.policies, `${row.relname} must have no policy of any kind`).toBe(0);
      }
    } finally {
      await db.end();
    }
  });

  it("anon and authenticated hold NO privilege of any kind on the host tables; service_role holds exactly select/insert/update", async () => {
    const db = await connectRaw();
    try {
      for (const table of HOST_TABLES) {
        for (const role of ["anon", "authenticated"]) {
          for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
            const { rows } = await db.query("select has_table_privilege($1, $2, $3) as ok", [role, `public.${table}`, privilege]);
            expect(rows[0].ok, `${role} ${privilege} on ${table}`).toBe(false);
          }
        }
        const granted: string[] = [];
        for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
          const { rows } = await db.query("select has_table_privilege('service_role', $1, $2) as ok", [`public.${table}`, privilege]);
          if (rows[0].ok) granted.push(privilege);
        }
        expect(granted, `service_role on ${table}`).toEqual(["SELECT", "INSERT", "UPDATE"]);
      }
      // PUBLIC (the implicit role) holds nothing either.
      const { rows } = await db.query(
        `select count(*)::int as n from information_schema.role_table_grants where table_schema = 'public' and table_name = any($1) and grantee = 'PUBLIC'`,
        [HOST_TABLES]
      );
      expect(rows[0].n).toBe(0);
    } finally {
      await db.end();
    }
  });

  it("every host function: one exact signature, search_path locked, NOT executable by PUBLIC/anon/authenticated, executable by service_role, SECURITY INVOKER", async () => {
    const db = await connectRaw();
    try {
      for (const [name, args] of HOST_RPCS) {
        const { rows } = await db.query(
          `select p.oid, p.prosecdef, p.proconfig::text as cfg, pg_get_function_identity_arguments(p.oid) as args
             from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1`,
          [name]
        );
        expect(rows, `${name} must have exactly one overload`).toHaveLength(1);
        const row = rows[0];
        expect(row.cfg, `${name} search_path`).toContain("search_path=public");
        expect(row.prosecdef, `${name} must not be SECURITY DEFINER`).toBe(false);
        expect(row.args.split(",").length, `${name} signature`).toBe(args.split(",").length);
        for (const role of ["anon", "authenticated"]) {
          const { rows: x } = await db.query("select has_function_privilege($1, $2::oid, 'EXECUTE') as ok", [role, row.oid]);
          expect(x[0].ok, `${role} must not execute ${name}`).toBe(false);
        }
        const { rows: publicExec } = await db.query(
          `select count(*)::int as n from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = $1::oid and a.grantee = 0 and a.privilege_type = 'EXECUTE'`,
          [row.oid]
        );
        expect(publicExec[0].n, `PUBLIC must not execute ${name}`).toBe(0);
        const { rows: svc } = await db.query("select has_function_privilege('service_role', $1::oid, 'EXECUTE') as ok", [row.oid]);
        expect(svc[0].ok, `service_role must execute ${name}`).toBe(true);
      }
    } finally {
      await db.end();
    }
  });

  it("the trigger functions that protect history are also locked down and pinned to a search_path", async () => {
    const db = await connectRaw();
    try {
      const { rows } = await db.query(
        `select p.proname, p.proconfig::text as cfg, has_function_privilege('anon', p.oid, 'EXECUTE') as anon_x, has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_x
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = any($1) order by p.proname`,
        [["competition_host_reject_history_loss", "competition_host_guard_application_update", "competition_host_guard_capability_update", "admin_audit_events_reject_host_event_change"]]
      );
      expect(rows).toHaveLength(4);
      for (const row of rows) {
        expect(row.cfg, row.proname).toContain("search_path=public");
        expect(row.anon_x, row.proname).toBe(false);
        expect(row.auth_x, row.proname).toBe(false);
      }
    } finally {
      await db.end();
    }
  });

  it("every function in the public schema whose name mentions host has a locked search_path and no PUBLIC/anon/authenticated execute", async () => {
    const db = await connectRaw();
    try {
      const { rows } = await db.query(
        `select p.proname, p.proconfig::text as cfg, has_function_privilege('anon', p.oid, 'EXECUTE') as anon_x, has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_x
           from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname like '%host%'`
      );
      expect(rows.length).toBeGreaterThanOrEqual(13);
      for (const row of rows) {
        expect(row.cfg, `${row.proname} search_path`).toMatch(/search_path/);
        expect(row.anon_x, `${row.proname} anon`).toBe(false);
        expect(row.auth_x, `${row.proname} authenticated`).toBe(false);
      }
    } finally {
      await db.end();
    }
  });

  it("no public view exposes host data", async () => {
    const db = await connectRaw();
    try {
      const { rows } = await db.query(`select count(*)::int as n from pg_views where schemaname = 'public' and definition ilike '%competition_host_%'`);
      expect(rows[0].n).toBe(0);
    } finally {
      await db.end();
    }
  });

  it("the Data API as anon is denied on both tables and every RPC (42501)", async () => {
    for (const table of HOST_TABLES) {
      for (const op of [
        anonClient.from(table).select("*").limit(1),
        anonClient.from(table).insert({ gaming_member_id: randomUUID() }),
        anonClient.from(table).update({ state: "APPROVED" }).eq("state", "PENDING"),
        anonClient.from(table).delete().eq("state", "PENDING"),
      ]) {
        const { error } = await op;
        expect(error?.code, table).toBe("42501");
      }
    }
    const id = randomUUID();
    const calls: Array<[string, Record<string, unknown>]> = [
      ["submit_host_application_atomically", { p_gaming_member_id: id, p_venue_name: "x", p_city_area: "x", p_playing_fields: 1, p_venue_description: "x", p_expected_window: "x", p_expected_team_count: 4, p_confirm_all_adults: true, p_confirm_independent_scorekeepers: true, p_confirm_pilot_exclusions: true }],
      ["withdraw_host_application_atomically", { p_gaming_member_id: id, p_public_code: "x" }],
      ["decide_host_application_atomically", { p_reviewer_gaming_member_id: id, p_public_code: "x", p_decision: "APPROVE", p_reason: null }],
      ["revoke_host_capability_atomically", { p_reviewer_gaming_member_id: id, p_public_code: "x", p_reason: "x" }],
      ["create_host_competition_atomically", { p_host_gaming_member_id: id, p_name: "x", p_activity_key: "SOCCER_5V5", p_public_code: "x" }],
      ["get_host_status", { p_gaming_member_id: id }],
      ["list_host_applications_for_review", { p_reviewer_gaming_member_id: id, p_view: "PENDING" }],
      ["assert_competition_not_host_revoked", { p_competition_id: id }],
      ["assert_actor_not_revoked_host", { p_competition_id: id, p_actor_gaming_member_id: id }],
    ];
    for (const [fn, args] of calls) {
      const { error } = await anonClient.rpc(fn, args);
      expect(error?.code, fn).toBe("42501");
    }
  });

  it("the Data API as a SIGNED-IN member (role authenticated) is denied just the same — including for their own rows", async () => {
    const member = await createMember("Signed In Member");
    const code = await apply(member, "authn");
    const client = await authenticatedClient(member);
    for (const table of HOST_TABLES) {
      const read = await client.from(table).select("*").limit(5);
      expect(read.error?.code, `${table} select`).toBe("42501");
      const write = await client.from(table).update({ state: "APPROVED" }).eq("state", "PENDING");
      expect(write.error?.code, `${table} update`).toBe("42501");
    }
    const self = await client.rpc("decide_host_application_atomically", { p_reviewer_gaming_member_id: member.gamingMemberId, p_public_code: code, p_decision: "APPROVE", p_reason: null });
    expect(self.error?.code).toBe("42501");
    const status = await client.rpc("get_host_status", { p_gaming_member_id: member.gamingMemberId });
    expect(status.error?.code).toBe("42501");
    expect((await getHostStatus(hostRepo, member.gamingMemberId)).phase).toBe("UNDER_REVIEW");
    await withdrawHostApplication(hostRepo, member.gamingMemberId, code);
  }, 30000);

  it("a member whose user_metadata claims admin rights is still refused by the database: authority is read from grants, never from claims (the source-level ban on reading claims is asserted in hostApplications.test.ts)", async () => {
    const member = await createMember("Claim Forger");
    const code = await apply(member, "forge");
    await serviceClient.auth.admin.updateUserById(member.authUserId, { user_metadata: { role: "admin", is_governance: true, authority: "PRODUCT_GOVERNANCE" } });
    await expectRejection(decideHostApplication(hostRepo, member.gamingMemberId, code, "APPROVE", null), HostReviewerAuthorityRequiredError);
    await expectRejection(listHostApplicationsForReview(hostRepo, member.gamingMemberId, "PENDING"), HostReviewerAuthorityRequiredError);
    await withdrawHostApplication(hostRepo, member.gamingMemberId, code);
  }, 30000);
});

// =============================================================================
// [T2-T10, T19] Application lifecycle, the review surface, audit
// =============================================================================

describe("[T2, T3, T4] submission, duplicates, and privacy between applicants", () => {
  it("[T2] a member submits one valid application: PENDING, an opaque code, and a submission audit event", async () => {
    const member = await createMember("Applicant One");
    const result = await submitHostApplication(hostRepo, member.gamingMemberId, applicationInput("t2"));
    expect(result.state).toBe("PENDING");
    expect(result.publicCode).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const row = await applicationRow(result.publicCode);
    expect(row.state).toBe("PENDING");
    expect(row.gaming_member_id).toBe(member.gamingMemberId);
    expect(row.venue_name).toBe(`Venue t2 ${RUN}`);
    const events = (await auditFor(row.host_application_id)).filter((e) => e.action_type === "HOST_APPLICATION_SUBMITTED");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor_id: member.gamingMemberId, outcome: "SUCCESS", authority_class_used: null });
    expect(await getHostStatus(hostRepo, member.gamingMemberId)).toMatchObject({ phase: "UNDER_REVIEW" });
  }, 30000);

  it("[T3] a second active application is truthfully refused; sequential and concurrent duplicates leave exactly one row", async () => {
    const member = await createMember("Applicant Dup");
    await apply(member, "dup1");
    await expectRejection(submitHostApplication(hostRepo, member.gamingMemberId, applicationInput("dup2")), HostApplicationAlreadyActiveError);

    const racer = await createMember("Applicant Race");
    const settled = await Promise.allSettled([1, 2, 3, 4].map((i) => submitHostApplication(hostRepo, racer.gamingMemberId, applicationInput(`race${i}`))));
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    for (const s of settled.filter((x) => x.status === "rejected")) expect((s as PromiseRejectedResult).reason).toBeInstanceOf(HostApplicationAlreadyActiveError);
    const { data } = await serviceClient.from("competition_host_applications").select("host_application_id").eq("gaming_member_id", racer.gamingMemberId);
    expect(data).toHaveLength(1);
  }, 30000);

  it("[T3] the database itself rejects a second live application even if a caller bypassed the function (unique partial index)", async () => {
    const member = await createMember("Applicant Index");
    await apply(member, "idx");
    const { error } = await serviceClient.from("competition_host_applications").insert({
      gaming_member_id: member.gamingMemberId, venue_name: "Direct Insert", city_area: "Nowhere", playing_fields: 1,
      venue_description: "A direct insert that tries to skip the function entirely.", expected_window: "soon", expected_team_count: 4,
      confirm_all_adults: true, confirm_independent_scorekeepers: true, confirm_pilot_exclusions: true,
    });
    expect(error?.code).toBe("23505");
  }, 30000);

  it("[T3] the database refuses a submission whose confirmations are not all true, whatever the caller", async () => {
    const member = await createMember("Applicant Confirm");
    const { error } = await serviceClient.from("competition_host_applications").insert({
      gaming_member_id: member.gamingMemberId, venue_name: "No Consent", city_area: "Nowhere", playing_fields: 1,
      venue_description: "Confirmations are false so the check constraint must refuse.", expected_window: "soon", expected_team_count: 4,
      confirm_all_adults: true, confirm_independent_scorekeepers: false, confirm_pilot_exclusions: true,
    });
    expect(error?.code).toBe("23514");
    await expectRejection(
      hostRepo.submitApplication(member.gamingMemberId, { ...applicationInput("c"), confirmAllAdults: false }),
      InvalidHostApplicationError
    );
  }, 30000);

  it("[T3] each field is bounded by the database too (the function re-validates what the command layer already checked)", async () => {
    const member = await createMember("Applicant Bounds");
    const cases: Array<[Partial<HostApplicationInput>, string]> = [
      [{ venueName: "x" }, "venueName"], [{ cityArea: "y".repeat(81) }, "cityArea"], [{ playingFields: 0 }, "playingFields"],
      [{ playingFields: 51 }, "playingFields"], [{ venueDescription: "short" }, "venueDescription"], [{ expectedWindow: "ab" }, "expectedWindow"],
      [{ expectedTeamCount: 3 }, "expectedTeamCount"], [{ expectedTeamCount: 17 }, "expectedTeamCount"],
      // Emoji count as two UTF-16 units in JavaScript but one character in Postgres: only the database catches this one.
      [{ venueDescription: "😀".repeat(10) }, "venueDescription"],
    ];
    for (const [over, field] of cases) {
      const err = await expectRejection(hostRepo.submitApplication(member.gamingMemberId, { ...applicationInput("b"), ...over }), InvalidHostApplicationError);
      expect(err.field).toBe(field);
    }
    const { data } = await serviceClient.from("competition_host_applications").select("host_application_id").eq("gaming_member_id", member.gamingMemberId);
    expect(data).toHaveLength(0);
  }, 30000);

  it("[T4] a member can read only their own application: status is keyed on the caller, and nobody else's code can be withdrawn or even detected", async () => {
    const alice = await createMember("Alice A");
    const bob = await createMember("Bob B");
    const aliceCode = await apply(alice, "alice");
    expect(await getHostStatus(hostRepo, bob.gamingMemberId)).toMatchObject({ phase: "NOT_APPLIED", application: null });
    const bobCode = await apply(bob, "bob");
    expect((await getHostStatus(hostRepo, bob.gamingMemberId)).application?.publicCode).toBe(bobCode);
    expect((await getHostStatus(hostRepo, alice.gamingMemberId)).application?.publicCode).toBe(aliceCode);
    const missing = await expectRejection(withdrawHostApplication(hostRepo, bob.gamingMemberId, aliceCode), HostApplicationNotFoundError);
    const absent = await expectRejection(withdrawHostApplication(hostRepo, bob.gamingMemberId, "A".repeat(22)), HostApplicationNotFoundError);
    expect(missing.message).toBe(absent.message); // someone else's application is indistinguishable from none at all
    expect((await getHostStatus(hostRepo, alice.gamingMemberId)).phase).toBe("UNDER_REVIEW");
  }, 30000);

  it("[T4] the applicant's own view carries no decision reason, no reviewer, no member id and no UUID of any kind", async () => {
    const member = await createMember("Applicant Private");
    const code = await apply(member, "priv");
    await reject(code, "INTERNAL-ONLY reason that the applicant must never see");
    const status = await getHostStatus(hostRepo, member.gamingMemberId);
    const json = JSON.stringify(status);
    expect(status.phase).toBe("NOT_APPROVED");
    expect(json).not.toMatch(UUID_PATTERN);
    expect(json).not.toMatch(/INTERNAL-ONLY|Rita Reviewer|decision|reviewer|decided_by/i);
    const raw = await serviceClient.rpc("get_host_status", { p_gaming_member_id: member.gamingMemberId });
    expect(Object.keys((raw.data as Record<string, unknown>[])[0]).sort()).toEqual(
      ["capability_state", "city_area", "competition_name", "competition_public_code", "competition_state", "decided_at", "expected_team_count", "expected_window", "playing_fields", "public_code", "state", "submitted_at", "venue_description", "venue_name", "withdrawn_at"].sort()
    );
  }, 30000);
});

describe("[T5, T6, T7, T8] the review surface is governance-only, and decisions are single", () => {
  it("[T5, T6] a non-governance member can neither list, approve, reject nor revoke — and nothing changes", async () => {
    const applicant = await createMember("Applicant Denied");
    const outsider = await createMember("Outsider");
    const code = await apply(applicant, "denied");
    await expectRejection(listHostApplicationsForReview(hostRepo, outsider.gamingMemberId, "PENDING"), HostReviewerAuthorityRequiredError);
    await expectRejection(listHostApplicationsForReview(hostRepo, applicant.gamingMemberId, "HISTORY"), HostReviewerAuthorityRequiredError);
    await expectRejection(decideHostApplication(hostRepo, outsider.gamingMemberId, code, "APPROVE", null), HostReviewerAuthorityRequiredError);
    await expectRejection(decideHostApplication(hostRepo, applicant.gamingMemberId, code, "APPROVE", null), HostReviewerAuthorityRequiredError);
    await expectRejection(decideHostApplication(hostRepo, outsider.gamingMemberId, code, "REJECT", "no"), HostReviewerAuthorityRequiredError);
    await expectRejection(revokeHostCapability(hostRepo, outsider.gamingMemberId, code, "no"), HostReviewerAuthorityRequiredError);
    const row = await applicationRow(code);
    expect(row.state).toBe("PENDING");
    expect(row.decided_by_gaming_member_id).toBeNull();
    expect(await capabilityRow(row.host_application_id)).toBeNull();
    expect((await auditFor(row.host_application_id)).map((e) => e.action_type)).toEqual(["HOST_APPLICATION_SUBMITTED"]);
  }, 30000);

  it("[T5, T6] OPERATIONAL and CONSEQUENTIAL_FINALIZER authority do not grant review — only PRODUCT_GOVERNANCE does", async () => {
    const applicant = await createMember("Applicant Classes");
    const operator = await createMember("Operator Only");
    const code = await apply(applicant, "classes");
    await grantOperational(operator.gamingMemberId);
    await serviceClient.from("authority_grants").insert({ gaming_member_id: operator.gamingMemberId, authority_class: "CONSEQUENTIAL_FINALIZER" });
    try {
      await expectRejection(decideHostApplication(hostRepo, operator.gamingMemberId, code, "APPROVE", null), HostReviewerAuthorityRequiredError);
      await expectRejection(listHostApplicationsForReview(hostRepo, operator.gamingMemberId, "PENDING"), HostReviewerAuthorityRequiredError);
    } finally {
      await serviceClient.from("authority_grants").delete().eq("gaming_member_id", operator.gamingMemberId);
    }
  }, 30000);

  it("[T5, T6] a REVOKED governance grant no longer reviews", async () => {
    const applicant = await createMember("Applicant Revoked Reviewer");
    const code = await apply(applicant, "revrev");
    const { error } = await serviceClient.from("authority_grants").insert({ gaming_member_id: reviewer.gamingMemberId, authority_class: "PRODUCT_GOVERNANCE", revoked_at: new Date().toISOString() });
    // A revoked row may be refused outright by the table's own constraints; either way it must not authorize.
    void error;
    await expectRejection(decideHostApplication(hostRepo, reviewer.gamingMemberId, code, "APPROVE", null), HostReviewerAuthorityRequiredError);
    await serviceClient.from("authority_grants").delete().eq("gaming_member_id", reviewer.gamingMemberId);
  }, 30000);

  it("[T7] a governance reviewer lists by name and application text — and the list holds no identifier but the opaque code", async () => {
    const applicant = await createMember("Listed Applicant");
    const code = await apply(applicant, "list");
    const list = await withGovernance(() => listHostApplicationsForReview(hostRepo, reviewer.gamingMemberId, "PENDING"));
    const mine = list.find((r) => r.publicCode === code)!;
    expect(mine).toBeDefined();
    expect(mine.applicantDisplayName).toBe("Listed Applicant");
    expect(mine.venueName).toBe(`Venue list ${RUN}`);
    expect(JSON.stringify(list)).not.toMatch(UUID_PATTERN);
    expect(Object.keys(mine)).not.toEqual(expect.arrayContaining(["gamingMemberId"]));
    const history = await withGovernance(() => listHostApplicationsForReview(hostRepo, reviewer.gamingMemberId, "HISTORY"));
    expect(history.find((r) => r.publicCode === code)).toBeUndefined();
  }, 30000);

  it("[T7] governance approves exactly once; the replay creates nothing; the opposite decision is refused", async () => {
    const applicant = await createMember("Applicant Approve");
    const code = await apply(applicant, "approve");
    expect(await approve(code)).toMatchObject({ state: "APPROVED", capabilityState: "AVAILABLE", alreadyDecided: false });
    expect(await approve(code)).toMatchObject({ state: "APPROVED", capabilityState: "AVAILABLE", alreadyDecided: true });
    await expectRejection(reject(code, "changed my mind"), HostApplicationAlreadyDecidedError);
    const row = await applicationRow(code);
    const { data: caps } = await serviceClient.from("competition_host_capabilities").select("*").eq("host_application_id", row.host_application_id);
    expect(caps).toHaveLength(1);
    expect(caps![0]).toMatchObject({ state: "AVAILABLE", competition_id: null, granted_by_gaming_member_id: reviewer.gamingMemberId });
    expect(row).toMatchObject({ state: "APPROVED", decided_by_gaming_member_id: reviewer.gamingMemberId });
    expect(row.decided_at).toBeTruthy();
    const decisions = (await auditFor(row.host_application_id)).filter((e) => e.action_type === "HOST_APPLICATION_APPROVED");
    expect(decisions).toHaveLength(1);
    expect(decisions[0]).toMatchObject({ actor_id: reviewer.gamingMemberId, authority_class_used: "PRODUCT_GOVERNANCE", outcome: "SUCCESS" });
  }, 30000);

  it("[T7] a reviewer may not decide their own application", async () => {
    const code = await withGovernance(async () => (await submitHostApplication(hostRepo, reviewer.gamingMemberId, applicationInput("self"))).publicCode);
    await expectRejection(withGovernance(() => decideHostApplication(hostRepo, reviewer.gamingMemberId, code, "APPROVE", null)), HostSelfReviewForbiddenError);
    const row = await applicationRow(code);
    expect(row.state).toBe("PENDING");
    // Leave no live application behind for the shared reviewer member.
    await withdrawHostApplication(hostRepo, reviewer.gamingMemberId, code);
  }, 30000);

  it("[T8] rejection requires a reason — at the command layer AND in the database — and the reason is stored internally", async () => {
    const applicant = await createMember("Applicant Reason");
    const code = await apply(applicant, "reason");
    for (const bad of [undefined, null, "", "   ", "\u0000"]) {
      await expectRejection(withGovernance(() => decideHostApplication(hostRepo, reviewer.gamingMemberId, code, "REJECT", bad)), HostReasonRequiredError);
    }
    // Straight to the database, skipping the command layer entirely:
    await expectRejection(withGovernance(() => hostRepo.decideApplication(reviewer.gamingMemberId, code, "REJECT", null)), HostReasonRequiredError);
    await expectRejection(withGovernance(() => hostRepo.decideApplication(reviewer.gamingMemberId, code, "REJECT", "   ")), HostReasonRequiredError);
    expect((await applicationRow(code)).state).toBe("PENDING");
    await reject(code, "  Venue is too small.  ");
    const row = await applicationRow(code);
    expect(row).toMatchObject({ state: "REJECTED", decision_reason: "Venue is too small.", decided_by_gaming_member_id: reviewer.gamingMemberId });
    expect(await capabilityRow(row.host_application_id)).toBeNull();
    const events = (await auditFor(row.host_application_id)).filter((e) => e.action_type === "HOST_APPLICATION_REJECTED");
    expect(events).toHaveLength(1);
    expect(events[0].reason).toBe("Venue is too small.");
    expect((await getHostStatus(hostRepo, applicant.gamingMemberId)).phase).toBe("NOT_APPROVED");
  }, 30000);

  it("[T8] a rejected applicant may apply again; the earlier rejection stays as history", async () => {
    const applicant = await createMember("Applicant Again");
    const first = await apply(applicant, "again1");
    await reject(first);
    const second = await apply(applicant, "again2");
    expect(second).not.toBe(first);
    expect((await applicationRow(first)).state).toBe("REJECTED");
    expect((await applicationRow(second)).state).toBe("PENDING");
    await withdrawHostApplication(hostRepo, applicant.gamingMemberId, second);
  }, 30000);

  it("[T9] approval and rejection racing each other serialize to ONE terminal outcome with a consistent capability and one decision event", async () => {
    const rounds = 6;
    const outcomes = { approved: 0, rejected: 0 };
    await withGovernance(async () => {
      for (let i = 0; i < rounds; i++) {
        const applicant = await createMember(`Applicant Race ${i}`);
        const code = await apply(applicant, `rr${i}`);
        const settled = await Promise.allSettled([
          decideHostApplication(hostRepo, reviewer.gamingMemberId, code, "APPROVE", null),
          decideHostApplication(hostRepo, reviewer.gamingMemberId, code, "REJECT", "racing"),
        ]);
        expect(settled.filter((s) => s.status === "fulfilled"), `round ${i}`).toHaveLength(1);
        const loser = settled.find((s) => s.status === "rejected") as PromiseRejectedResult;
        expect(loser.reason).toBeInstanceOf(HostApplicationAlreadyDecidedError);
        const row = await applicationRow(code);
        const cap = await capabilityRow(row.host_application_id);
        const decisions = (await auditFor(row.host_application_id)).filter((e) => e.action_type === "HOST_APPLICATION_APPROVED" || e.action_type === "HOST_APPLICATION_REJECTED");
        expect(decisions, `round ${i}`).toHaveLength(1);
        if (row.state === "APPROVED") {
          outcomes.approved++;
          expect(cap, `round ${i}`).not.toBeNull();
          expect(decisions[0].action_type).toBe("HOST_APPLICATION_APPROVED");
        } else {
          outcomes.rejected++;
          expect(row.state).toBe("REJECTED");
          expect(cap, `round ${i}`).toBeNull();
          expect(decisions[0].action_type).toBe("HOST_APPLICATION_REJECTED");
        }
      }
    });
    expect(outcomes.approved + outcomes.rejected).toBe(rounds);
  }, 120000);

  it("[T9] concurrent approvals of one application create exactly ONE capability and one event [T10]", async () => {
    const applicant = await createMember("Applicant Double Approve");
    const code = await apply(applicant, "dbl");
    const settled = await withGovernance(() =>
      Promise.allSettled([1, 2, 3, 4, 5].map(() => decideHostApplication(hostRepo, reviewer.gamingMemberId, code, "APPROVE", null)))
    );
    expect(settled.every((s) => s.status === "fulfilled")).toBe(true);
    const values = settled.map((s) => (s as PromiseFulfilledResult<{ alreadyDecided: boolean }>).value);
    expect(values.filter((v) => !v.alreadyDecided)).toHaveLength(1);
    const row = await applicationRow(code);
    const { data: caps } = await serviceClient.from("competition_host_capabilities").select("host_capability_id").eq("host_application_id", row.host_application_id);
    expect(caps).toHaveLength(1);
    expect((await auditFor(row.host_application_id)).filter((e) => e.action_type === "HOST_APPLICATION_APPROVED")).toHaveLength(1);
  }, 60000);

  it("[T9] an approval racing a withdrawal also yields one terminal outcome", async () => {
    const applicant = await createMember("Applicant Withdraw Race");
    const code = await apply(applicant, "wr");
    const settled = await withGovernance(() =>
      Promise.allSettled([
        decideHostApplication(hostRepo, reviewer.gamingMemberId, code, "APPROVE", null),
        withdrawHostApplication(hostRepo, applicant.gamingMemberId, code),
      ])
    );
    expect(settled.filter((s) => s.status === "fulfilled")).toHaveLength(1);
    const row = await applicationRow(code);
    expect(["APPROVED", "WITHDRAWN"]).toContain(row.state);
    const cap = await capabilityRow(row.host_application_id);
    expect(cap !== null).toBe(row.state === "APPROVED");
  }, 60000);

  it("withdrawal: own pending only, idempotent, audited once, and not possible after a decision", async () => {
    const applicant = await createMember("Applicant Withdraw");
    const code = await apply(applicant, "wd");
    expect(await withdrawHostApplication(hostRepo, applicant.gamingMemberId, code)).toMatchObject({ state: "WITHDRAWN", alreadyWithdrawn: false });
    expect(await withdrawHostApplication(hostRepo, applicant.gamingMemberId, code)).toMatchObject({ alreadyWithdrawn: true });
    const row = await applicationRow(code);
    expect(row.withdrawn_at).toBeTruthy();
    expect((await auditFor(row.host_application_id)).filter((e) => e.action_type === "HOST_APPLICATION_WITHDRAWN")).toHaveLength(1);

    const other = await createMember("Applicant Withdraw After");
    const decidedCode = await apply(other, "wd2");
    await approve(decidedCode);
    await expectRejection(withdrawHostApplication(hostRepo, other.gamingMemberId, decidedCode), HostApplicationNotPendingError);
  }, 30000);

  it("[T10] approval creates exactly one UNUSED capability, never a platform authority", async () => {
    const applicant = await createMember("Applicant Scope");
    const code = await apply(applicant, "scope");
    await approve(code);
    const row = await applicationRow(code);
    const cap = await capabilityRow(row.host_application_id);
    expect(cap).toMatchObject({ state: "AVAILABLE", competition_id: null, consumed_at: null, revoked_at: null, gaming_member_id: applicant.gamingMemberId });
    const { data: grants } = await serviceClient.from("authority_grants").select("authority_class").eq("gaming_member_id", applicant.gamingMemberId);
    expect(grants).toEqual([]); // no OPERATIONAL, PRODUCT_GOVERNANCE or CONSEQUENTIAL_FINALIZER — nothing platform-wide
  }, 30000);
});

describe("[T19] the audit trail is complete, idempotent-safe and immutable", () => {
  it("records every lifecycle step once, in order, with actor, target, outcome and timestamp", async () => {
    const { member, code } = await approvedHost("audit");
    const created = await createHostCompetition(hostRepo, member.gamingMemberId, `Audit Pilot ${RUN}`);
    await revoke(code, "Audit trail check.");
    await revoke(code, "A replay must add nothing.");
    const row = await applicationRow(code);
    const appEvents = (await auditFor(row.host_application_id)).map((e) => e.action_type);
    expect(appEvents).toEqual(["HOST_APPLICATION_SUBMITTED", "HOST_APPLICATION_APPROVED"]);
    const cap = await capabilityRow(row.host_application_id);
    const capEvents = await auditFor(cap!.host_capability_id);
    expect(capEvents.map((e) => e.action_type)).toEqual(["HOST_CAPABILITY_CONSUMED", "HOST_CAPABILITY_REVOKED"]);
    for (const event of [...(await auditFor(row.host_application_id)), ...capEvents]) {
      expect(event.actor_id).toBeTruthy();
      expect(event.outcome).toBe("SUCCESS");
      expect(Number.isNaN(Date.parse(event.occurred_at))).toBe(false);
      expect(event.target_type).toMatch(/^competition_host_/);
    }
    const revokedEvent = capEvents[1];
    expect(revokedEvent).toMatchObject({ actor_id: reviewer.gamingMemberId, authority_class_used: "PRODUCT_GOVERNANCE", reason: "Audit trail check." });
    expect(revokedEvent.previous_reference).toMatchObject({ state: "CONSUMED" });
    expect(revokedEvent.resulting_reference).toMatchObject({ state: "REVOKED" });
    expect(capEvents[0].resulting_reference).toMatchObject({ table: "competitions", id: created.competitionId });
  }, 60000);

  it("a refused attempt writes no audit event", async () => {
    const applicant = await createMember("Applicant Quiet");
    const code = await apply(applicant, "quiet");
    const row = await applicationRow(code);
    const before = (await auditFor(row.host_application_id)).length;
    await expectRejection(decideHostApplication(hostRepo, applicant.gamingMemberId, code, "APPROVE", null), HostReviewerAuthorityRequiredError);
    await expectRejection(createHostCompetition(hostRepo, applicant.gamingMemberId, "Not Approved Pilot"), HostCapabilityRequiredError);
    await expectRejection(withdrawHostApplication(hostRepo, (await createMember("Stranger")).gamingMemberId, code), HostApplicationNotFoundError);
    expect((await auditFor(row.host_application_id)).length).toBe(before);
    await withdrawHostApplication(hostRepo, applicant.gamingMemberId, code);
  }, 30000);

  it("a HOST_* audit event cannot be updated or deleted — by service_role through the Data API, or by the table owner on a raw connection", async () => {
    const applicant = await createMember("Applicant Immutable");
    const code = await apply(applicant, "imm");
    const row = await applicationRow(code);
    const [event] = await auditFor(row.host_application_id);
    expect(event.action_type).toBe("HOST_APPLICATION_SUBMITTED");

    const viaApiUpdate = await serviceClient.from("admin_audit_events").update({ outcome: "FAILURE" }).eq("admin_audit_event_id", event.admin_audit_event_id);
    expect(viaApiUpdate.error?.message ?? "").toContain("AUDIT_EVENT_IMMUTABLE");
    const viaApiDelete = await serviceClient.from("admin_audit_events").delete().eq("admin_audit_event_id", event.admin_audit_event_id);
    expect(viaApiDelete.error?.message ?? "").toContain("AUDIT_EVENT_IMMUTABLE");

    const db = await connectRaw();
    try {
      await expect(db.query("update admin_audit_events set reason = 'tampered' where admin_audit_event_id = $1", [event.admin_audit_event_id])).rejects.toThrow(/AUDIT_EVENT_IMMUTABLE/);
      await expect(db.query("delete from admin_audit_events where admin_audit_event_id = $1", [event.admin_audit_event_id])).rejects.toThrow(/AUDIT_EVENT_IMMUTABLE/);
      await db.query("begin");
      await expect(db.query("truncate admin_audit_events")).rejects.toThrow(/AUDIT_EVENT_IMMUTABLE/);
      await db.query("rollback");
    } finally {
      await db.end();
    }
    const [unchanged] = await auditFor(row.host_application_id);
    expect(unchanged).toEqual(event);
    await withdrawHostApplication(hostRepo, applicant.gamingMemberId, code);
  }, 30000);

  it("audit events of OTHER (pre-existing) action types keep their previous behavior — the guard is scoped to HOST_*", async () => {
    const member = await createMember("Legacy Audit");
    const id = randomUUID();
    const { error } = await serviceClient.from("admin_audit_events").insert({
      action_type: "GRANT_AUTHORITY", actor_kind: "GAMING_MEMBER", actor_id: member.gamingMemberId, authority_class_used: null,
      target_type: "authority_grants", target_id: id, outcome: "SUCCESS", reason: "legacy row",
    });
    expect(error).toBeNull();
    const del = await serviceClient.from("admin_audit_events").delete().eq("target_id", id);
    expect(del.error).toBeNull();
  }, 30000);
});

describe("history cannot be erased or rewritten, even by the table owner", () => {
  it("service_role has no DELETE or TRUNCATE on the host tables (42501)", async () => {
    const applicant = await createMember("Applicant NoDelete");
    const code = await apply(applicant, "nodel");
    for (const table of HOST_TABLES) {
      const { error } = await serviceClient.from(table).delete().not("state", "is", null);
      expect(error?.code, `${table} delete`).toBe("42501");
    }
    const del = await serviceClient.from("competition_host_applications").delete().eq("public_code", code);
    expect(del.error?.code).toBe("42501");
    await withdrawHostApplication(hostRepo, applicant.gamingMemberId, code);
  }, 30000);

  it("triggers refuse DELETE, TRUNCATE, edits to a submitted application, and any move out of a terminal state — for the owner as well", async () => {
    const { member, code } = await approvedHost("trig");
    const row = await applicationRow(code);
    const cap = (await capabilityRow(row.host_application_id))!;
    const created = await createHostCompetition(hostRepo, member.gamingMemberId, `Trigger Pilot ${RUN}`);
    const db = await connectRaw();
    try {
      const attempts: Array<[string, unknown[], RegExp]> = [
        ["delete from competition_host_applications where host_application_id = $1", [row.host_application_id], /HOST_HISTORY_IMMUTABLE/],
        ["delete from competition_host_capabilities where host_capability_id = $1", [cap.host_capability_id], /HOST_HISTORY_IMMUTABLE/],
        ["update competition_host_applications set venue_name = 'Edited' where host_application_id = $1", [row.host_application_id], /HOST_HISTORY_IMMUTABLE/],
        ["update competition_host_applications set gaming_member_id = $2 where host_application_id = $1", [row.host_application_id, reviewer.gamingMemberId], /HOST_HISTORY_IMMUTABLE/],
        ["update competition_host_applications set state = 'PENDING', decided_at = null, decided_by_gaming_member_id = null where host_application_id = $1", [row.host_application_id], /HOST_HISTORY_IMMUTABLE/],
        ["update competition_host_applications set state = 'REJECTED', decision_reason = 'flip' where host_application_id = $1", [row.host_application_id], /HOST_HISTORY_IMMUTABLE/],
        ["update competition_host_capabilities set state = 'AVAILABLE', competition_id = null, consumed_at = null where host_capability_id = $1", [cap.host_capability_id], /HOST_HISTORY_IMMUTABLE/],
        ["update competition_host_capabilities set gaming_member_id = $2 where host_capability_id = $1", [cap.host_capability_id, reviewer.gamingMemberId], /HOST_HISTORY_IMMUTABLE/],
        ["update competition_host_capabilities set competition_id = null where host_capability_id = $1", [cap.host_capability_id], /HOST_HISTORY_IMMUTABLE|violates check constraint/],
      ];
      for (const [sql, params, expected] of attempts) {
        await expect(db.query(sql, params as any[]), sql).rejects.toThrow(expected);
      }
      for (const table of HOST_TABLES) {
        await db.query("begin");
        await expect(db.query(`truncate ${table} cascade`)).rejects.toThrow(/HOST_HISTORY_IMMUTABLE/);
        await db.query("rollback");
      }
    } finally {
      await db.end();
    }
    expect((await applicationRow(code)).state).toBe("APPROVED");
    expect((await capabilityRow(row.host_application_id))!.competition_id).toBe(created.competitionId);
  }, 60000);

  it("a consumed capability stays bound to its competition for good: it can only move to REVOKED, with the binding intact", async () => {
    const { member, code } = await approvedHost("bound");
    const created = await createHostCompetition(hostRepo, member.gamingMemberId, `Bound Pilot ${RUN}`);
    await revoke(code);
    const cap = (await capabilityRow((await applicationRow(code)).host_application_id))!;
    expect(cap).toMatchObject({ state: "REVOKED", competition_id: created.competitionId });
    expect(cap.consumed_at).toBeTruthy();
    expect(cap.revoked_at).toBeTruthy();
    expect(cap.revoked_by_gaming_member_id).toBe(reviewer.gamingMemberId);
    const db = await connectRaw();
    try {
      await expect(db.query("update competition_host_capabilities set state = 'CONSUMED', revoked_at = null, revoked_by_gaming_member_id = null, revoke_reason = null where host_capability_id = $1", [cap.host_capability_id])).rejects.toThrow(/HOST_HISTORY_IMMUTABLE/);
    } finally {
      await db.end();
    }
  }, 60000);
});

// =============================================================================
// [T11-T14, T16, T18] The one-competition capability
// =============================================================================

describe("[T11, T12, T13] the approved host creates exactly one competition, atomically", () => {
  it("[T11] creates the competition as its organizer; the capability is consumed in the same transaction and bound permanently", async () => {
    const { member, code } = await approvedHost("create");
    const created = await createHostCompetition(hostRepo, member.gamingMemberId, `  Riverside Pilot ${RUN}  `);
    expect(created.state).toBe("DRAFT");
    const record = (await compRepo.getCompetitionById(created.competitionId))!;
    expect(record).toMatchObject({ organizerGamingMemberId: member.gamingMemberId, name: `Riverside Pilot ${RUN}`, state: "DRAFT", activityKey: "SOCCER_5V5", hostBound: true, hostAccessRevoked: false });
    expect(record.publicCode).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const cap = (await capabilityRow((await applicationRow(code)).host_application_id))!;
    expect(cap).toMatchObject({ state: "CONSUMED", competition_id: created.competitionId });
    expect(cap.consumed_at).toBeTruthy();
    expect((await getHostStatus(hostRepo, member.gamingMemberId)).phase).toBe("PILOT_CREATED");
    const status = await getHostStatus(hostRepo, member.gamingMemberId);
    expect(status.application?.competitionName).toBe(`Riverside Pilot ${RUN}`);
    expect(status.application?.competitionPublicCode).toBe(record.publicCode);
  }, 30000);

  it("[T11] a second creation is refused (the host's one pilot already exists) and no second competition appears", async () => {
    const { member } = await approvedHost("second");
    await createHostCompetition(hostRepo, member.gamingMemberId, `First ${RUN}`);
    await expectRejection(createHostCompetition(hostRepo, member.gamingMemberId, `Second ${RUN}`), HostCapabilityAlreadyConsumedError);
    const { data } = await serviceClient.from("competitions").select("competition_id").eq("organizer_gaming_member_id", member.gamingMemberId);
    expect(data).toHaveLength(1);
  }, 30000);

  it("[T12] a failed creation consumes nothing: an invalid name, a bad activity, and a failure INSIDE the transaction (duplicate public code) all leave the capability AVAILABLE", async () => {
    const { member, code } = await approvedHost("fail");
    const capId = (await capabilityRow((await applicationRow(code)).host_application_id))!.host_capability_id;
    await expectRejection(createHostCompetition(hostRepo, member.gamingMemberId, "ab"), InvalidHostCompetitionError);
    await expectRejection(hostRepo.createHostCompetition(member.gamingMemberId, "Valid Name", "POKER", "C".repeat(22)), InvalidHostCompetitionError);
    await expectRejection(hostRepo.createHostCompetition(member.gamingMemberId, "Valid Name", "SOCCER_5V5", "   "), InvalidHostCompetitionError);

    // A failure after the capability has been read and locked: reuse another competition's public code (unique violation on insert).
    const other = await createMember("Internal Organizer For Collision");
    await grantOperational(other.gamingMemberId);
    const existing = await createCompetition(compRepo, other.gamingMemberId, `Collision Source ${RUN}`, "SOCCER_5V5");
    const { publicCode: takenCode } = (await compRepo.getCompetitionById(existing.competitionId))!;
    const err = await hostRepo.createHostCompetition(member.gamingMemberId, "Colliding Pilot", "SOCCER_5V5", takenCode).then(() => null, (e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err).not.toBeInstanceOf(HostCapabilityAlreadyConsumedError);
    expect((err as Error).message).toMatch(/duplicate key|unique/i); // the failure really was the public-code unique violation

    const cap = (await serviceClient.from("competition_host_capabilities").select("*").eq("host_capability_id", capId).single()).data!;
    expect(cap).toMatchObject({ state: "AVAILABLE", competition_id: null, consumed_at: null });
    const { data: comps } = await serviceClient.from("competitions").select("competition_id").eq("organizer_gaming_member_id", member.gamingMemberId);
    expect(comps).toEqual([]);
    expect((await auditFor(capId)).filter((e) => e.action_type === "HOST_CAPABILITY_CONSUMED")).toHaveLength(0);

    await expect(createHostCompetition(hostRepo, member.gamingMemberId, "Pilot After Failures")).resolves.toMatchObject({ state: "DRAFT" });
  }, 60000);

  it("[T12] atomicity: a failure AFTER the competition is inserted and the capability is consumed undoes BOTH, leaving the capability AVAILABLE and no orphan competition", async () => {
    const { member, code } = await approvedHost("atomic");
    const capId = (await capabilityRow((await applicationRow(code)).host_application_id))!.host_capability_id;
    const db = await connectRaw();
    try {
      await db.query("begin");
      await db.query("create function ug088_boom() returns trigger language plpgsql as $$ begin raise exception 'BOOM_AFTER_BOTH_WRITES'; end $$");
      // Fires once the capability row has been updated to CONSUMED — i.e. after the competition insert AND the consumption.
      await db.query("create trigger ug088_boom_t after update on competition_host_capabilities for each row when (new.state = 'CONSUMED') execute function ug088_boom()");
      await db.query("savepoint attempt");
      await expect(
        db.query("select * from create_host_competition_atomically($1, $2, 'SOCCER_5V5', $3)", [member.gamingMemberId, `Atomic Pilot ${RUN}`, `W${randomUUID().replace(/-/g, "").slice(0, 21)}`])
      ).rejects.toThrow(/BOOM_AFTER_BOTH_WRITES/);
      await db.query("rollback to savepoint attempt");
      const { rows: comps } = await db.query("select count(*)::int as n from competitions where organizer_gaming_member_id = $1", [member.gamingMemberId]);
      const { rows: caps } = await db.query("select state, competition_id, consumed_at from competition_host_capabilities where host_capability_id = $1", [capId]);
      const { rows: audit } = await db.query("select count(*)::int as n from admin_audit_events where target_id = $1 and action_type = 'HOST_CAPABILITY_CONSUMED'", [capId]);
      expect(comps[0].n).toBe(0);
      expect(caps[0]).toMatchObject({ state: "AVAILABLE", competition_id: null, consumed_at: null });
      expect(audit[0].n).toBe(0);
      await db.query("rollback");
    } finally {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
    // The trigger was never committed: the real creation still works.
    await expect(createHostCompetition(hostRepo, member.gamingMemberId, `Atomic Pilot After ${RUN}`)).resolves.toMatchObject({ state: "DRAFT" });
  }, 60000);

  it("[T13] concurrent creation attempts yield exactly ONE competition and one consumption event", async () => {
    for (let round = 0; round < 3; round++) {
      const { member, code } = await approvedHost(`conc${round}`);
      const settled = await Promise.allSettled(
        [1, 2, 3, 4, 5, 6].map((i) => createHostCompetition(hostRepo, member.gamingMemberId, `Concurrent Pilot ${round}-${i} ${RUN}`))
      );
      expect(settled.filter((s) => s.status === "fulfilled"), `round ${round}`).toHaveLength(1);
      for (const s of settled.filter((x) => x.status === "rejected")) expect((s as PromiseRejectedResult).reason).toBeInstanceOf(HostCapabilityAlreadyConsumedError);
      const { data } = await serviceClient.from("competitions").select("competition_id").eq("organizer_gaming_member_id", member.gamingMemberId);
      expect(data, `round ${round}`).toHaveLength(1);
      const capId = (await capabilityRow((await applicationRow(code)).host_application_id))!.host_capability_id;
      expect((await auditFor(capId)).filter((e) => e.action_type === "HOST_CAPABILITY_CONSUMED")).toHaveLength(1);
    }
  }, 120000);

  it("[T11] without an APPROVED application the host path is closed: never applied, pending, rejected, withdrawn", async () => {
    const stranger = await createMember("Never Applied");
    await expectRejection(createHostCompetition(hostRepo, stranger.gamingMemberId, "Stranger Pilot"), HostCapabilityRequiredError);
    const pending = await createMember("Pending Host");
    const pendingCode = await apply(pending, "pend");
    await expectRejection(createHostCompetition(hostRepo, pending.gamingMemberId, "Pending Pilot"), HostCapabilityRequiredError);
    await reject(pendingCode);
    await expectRejection(createHostCompetition(hostRepo, pending.gamingMemberId, "Rejected Pilot"), HostCapabilityRequiredError);
    const withdrawn = await createMember("Withdrawn Host");
    await withdrawHostApplication(hostRepo, withdrawn.gamingMemberId, await apply(withdrawn, "wdh"));
    await expectRejection(createHostCompetition(hostRepo, withdrawn.gamingMemberId, "Withdrawn Pilot"), HostCapabilityRequiredError);
  }, 60000);

  it("[T11] a revoked-before-use capability cannot create, and says so truthfully", async () => {
    const { member, code } = await approvedHost("unused-revoked");
    await revoke(code, "Could not verify the venue.");
    await expectRejection(createHostCompetition(hostRepo, member.gamingMemberId, "Too Late Pilot"), HostCapabilityRevokedError);
    expect((await getHostStatus(hostRepo, member.gamingMemberId)).phase).toBe("ACCESS_REVOKED");
  }, 30000);

  it("[T11] the database refuses a second capability for one application and a second competition for one capability (structural barriers)", async () => {
    const { member, code } = await approvedHost("struct");
    const row = await applicationRow(code);
    const dup = await serviceClient.from("competition_host_capabilities").insert({
      host_application_id: row.host_application_id, gaming_member_id: member.gamingMemberId, granted_by_gaming_member_id: reviewer.gamingMemberId,
    });
    expect(dup.error?.code).toBe("23505");
  }, 30000);

  it("[T10] a host cannot use the standard create path: holding a capability grants no OPERATIONAL authority", async () => {
    const { member } = await approvedHost("noop");
    await expectRejection(createCompetition(compRepo, member.gamingMemberId, `Via Standard Path ${RUN}`, "SOCCER_5V5"), OperationalAuthorityRequiredError);
    const { data } = await serviceClient.from("authority_grants").select("authority_class").eq("gaming_member_id", member.gamingMemberId);
    expect(data).toEqual([]);
  }, 30000);
});

describe("[T18] internal OPERATIONAL creation is unchanged", () => {
  it("an OPERATIONAL organizer still creates any number of competitions, none host-bound, none touched by revocation logic", async () => {
    const operator = await createMember("Internal Operator");
    await grantOperational(operator.gamingMemberId);
    const a = await createCompetition(compRepo, operator.gamingMemberId, `Internal A ${RUN}`, "SOCCER_5V5");
    const b = await createCompetition(compRepo, operator.gamingMemberId, `Internal B ${RUN}`, "SOCCER_5V5");
    expect(a.competitionId).not.toBe(b.competitionId);
    for (const id of [a.competitionId, b.competitionId]) {
      const record = (await compRepo.getCompetitionById(id))!;
      expect(record.hostBound).toBeUndefined();
      expect(record.hostAccessRevoked).toBeUndefined();
      expect(isActiveOrganizer(record, operator.gamingMemberId)).toBe(true);
      expect(isListedFor({ ...record, state: "TEAM_REGISTRATION_OPEN" }, "someone-else")).toBe(true);
    }
    await saveFixturePlan(a.competitionId, operator.gamingMemberId); // UG-CR-GATE-SSS-007: opening needs a plan
    const open = await openTeamRegistration(compRepo, a.competitionId, operator.gamingMemberId);
    expect(open.state).toBe("TEAM_REGISTRATION_OPEN");
    // The legacy three-argument create signature keeps working too, with its OPERATIONAL-only rule.
    const legacy = await serviceClient.rpc("create_competition_atomically", { p_organizer_gaming_member_id: operator.gamingMemberId, p_name: `Legacy ${RUN}`, p_activity_key: "SOCCER_5V5" });
    expect(legacy.error).toBeNull();
    const helperNoBinding = await (async () => {
      const db = await connectRaw();
      try {
        await db.query("select assert_competition_not_host_revoked($1)", [a.competitionId]);
        await db.query("select assert_actor_not_revoked_host($1, $2)", [a.competitionId, operator.gamingMemberId]);
        return true;
      } finally {
        await db.end();
      }
    })();
    expect(helperNoBinding).toBe(true);
  }, 60000);

  it("an OPERATIONAL organizer has no organizer power over a HOST's competition, and a host has none over theirs", async () => {
    const operator = await createMember("Operator Cross");
    await grantOperational(operator.gamingMemberId);
    const ctx = await buildHostCompetition("cross-op");
    await expectRejection(openTeamRegistration(compRepo, ctx.competitionId, operator.gamingMemberId), CompetitionAccessDeniedError);
    const own = await createCompetition(compRepo, operator.gamingMemberId, `Operator Own ${RUN}`, "SOCCER_5V5");
    await expectRejection(openTeamRegistration(compRepo, own.competitionId, ctx.host.gamingMemberId), CompetitionAccessDeniedError);
  }, 120000);
});

// =============================================================================
// Competition scaffolding shared by the matrix: a fully published bracket
// =============================================================================

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

interface CompetitionCtx {
  competitionId: string;
  publicCode: string;
  organizerId: string;
  host: Member;
  teams: Array<{ competitionTeamId: string; captainId: string }>;
  semifinal1FixtureId: string;
  semifinal2FixtureId: string;
  finalFixtureId: string;
  joinRequestId: string;
  someMemberId: string;
  hostCode: string | null;
}

const iso = (ms: number) => new Date(Date.now() + ms).toISOString();

// The dates are relative to the moment this file starts (computed ONCE, so every call in a run saves the same payload) and the deadline is in the future:
// UG-CR-GATE-SSS-007 refuses to open registration for a plan whose deadline has passed, and a fixed calendar date would rot.
const PLAN_START_MS = Date.now();
const planLocal = (ms: number) => new Date(ms - 6 * 3600_000).toISOString(); // America/Costa_Rica: UTC-06:00, no daylight saving
/** A valid Organizer Planning plan for a 5v5 competition (UG-CR-GATE-SSS-004): the one payload every planning call below saves. */
const planningPlan = () => parsePlanningPlan({
  venue: { name: `Matrix Venue ${RUN}`, locationDescription: "A fictional venue used only by the local contract suite.", timeZone: "America/Costa_Rica", simultaneousMatchCapacity: 1, restrictionNotes: "" },
  pitches: [{ label: "A", usable: true, supportedFormats: ["SOCCER_5V5"], restrictionNotes: "" }],
  dates: [{ date: planLocal(PLAN_START_MS + 33 * 24 * 3600_000).slice(0, 10), windows: [{ start: "09:00", end: "13:00" }] }],
  roster: { minimum: 5, maximum: 8 },
  registrationDeadline: { local: planLocal(PLAN_START_MS + 30 * 24 * 3600_000).slice(0, 16), timeZone: "America/Costa_Rica" },
  rules: { version: "matrix-1", snapshot: "Planning evidence for the organizer matrix." },
}, "SOCCER_5V5");

async function publishBracket(competitionId: string, organizerId: string, labelPrefix: string) {
  const captains: Member[] = [];
  for (let i = 0; i < 4; i++) captains.push(await createMember(`${labelPrefix} Captain ${i}`));
  const teams: CompetitionCtx["teams"] = [];
  for (let i = 0; i < 4; i++) {
    const team = await addCompetitionTeam(compRepo, competitionId, organizerId, `${labelPrefix} Team ${i} ${RUN}`, captains[i].gamingMemberId);
    teams.push({ competitionTeamId: team.competitionTeamId, captainId: captains[i].gamingMemberId });
  }
  // UG-CR-GATE-SSS-007: closing is the FREEZE. The rosters are built first; the matrix still needs a registrant with a join request, but a PENDING request would
  // (rightly) block the freeze, so the team's captain decides it (rejected) before the deadline passes — the organizer matrix then has a request to review.
  await buildRosters(competitionId, teams);
  const member = await createMember(`${labelPrefix} Registrant`);
  await registerForCompetition(compRepo, competitionId, member.gamingMemberId, true);
  const joinRequest = await requestJoinTeam(compRepo, competitionId, teams[0].competitionTeamId, member.gamingMemberId);
  await decideJoinRequest(compRepo, joinRequest.competitionJoinRequestId, teams[0].captainId, "REJECT", false);
  await passDeadlineFixture(competitionId);
  await closeTeamRegistration(compRepo, competitionId, organizerId);
  const published = await publishCompetition(
    compRepo, competitionId, organizerId,
    teams[0].competitionTeamId, teams[1].competitionTeamId, teams[2].competitionTeamId, teams[3].competitionTeamId,
    iso(3600_000), iso(7200_000), iso(10800_000)
  );
  return { teams, published, joinRequestId: joinRequest.competitionJoinRequestId, someMemberId: member.gamingMemberId };
}

/** An approved host whose single pilot is fully published (open -> 4 teams -> closed -> published) and has a pending join request. */
async function buildHostCompetition(label: string): Promise<CompetitionCtx> {
  const { member, code } = await approvedHost(label);
  const created = await createHostCompetition(hostRepo, member.gamingMemberId, `Pilot ${label} ${RUN}`);
  await saveFixturePlan(created.competitionId, member.gamingMemberId);
  await openTeamRegistration(compRepo, created.competitionId, member.gamingMemberId);
  const built = await publishBracket(created.competitionId, member.gamingMemberId, label);
  const record = (await compRepo.getCompetitionById(created.competitionId))!;
  return {
    competitionId: created.competitionId, publicCode: record.publicCode, organizerId: member.gamingMemberId, host: member,
    teams: built.teams,
    semifinal1FixtureId: built.published.semifinal1FixtureId, semifinal2FixtureId: built.published.semifinal2FixtureId, finalFixtureId: built.published.finalFixtureId,
    joinRequestId: built.joinRequestId, someMemberId: built.someMemberId, hostCode: code,
  };
}

/** The same shape, organized by an internal OPERATIONAL member (the pre-existing path). */
async function buildInternalCompetition(label: string): Promise<CompetitionCtx> {
  const operator = await createMember(`${label} Operator`);
  await grantOperational(operator.gamingMemberId);
  const created = await createCompetition(compRepo, operator.gamingMemberId, `Internal ${label} ${RUN}`, "SOCCER_5V5");
  await saveFixturePlan(created.competitionId, operator.gamingMemberId);
  await openTeamRegistration(compRepo, created.competitionId, operator.gamingMemberId);
  const built = await publishBracket(created.competitionId, operator.gamingMemberId, label);
  const record = (await compRepo.getCompetitionById(created.competitionId))!;
  return {
    competitionId: created.competitionId, publicCode: record.publicCode, organizerId: operator.gamingMemberId, host: operator,
    teams: built.teams,
    semifinal1FixtureId: built.published.semifinal1FixtureId, semifinal2FixtureId: built.published.semifinal2FixtureId, finalFixtureId: built.published.finalFixtureId,
    joinRequestId: built.joinRequestId, someMemberId: built.someMemberId, hostCode: null,
  };
}

// =============================================================================
// [T14, T15, T16, T17] Ownership and revocation across EVERY organizer RPC
// =============================================================================

interface OrganizerCall {
  rpc: string;
  label: string;
  call: (ctx: CompetitionCtx, actorId: string) => Promise<unknown>;
}

/**
 * The explicit inventory of organizer mutation paths. A catalog test below proves this list is
 * complete: every function in the public schema that can raise COMPETITION_ACCESS_DENIED must
 * appear here (or be the scorekeeper path, covered separately), so a new organizer RPC cannot
 * slip in unguarded and unlisted.
 */
const ORGANIZER_CALLS: OrganizerCall[] = [
  { rpc: "open_team_registration_atomically", label: "open team registration", call: (c, a) => openTeamRegistration(compRepo, c.competitionId, a) },
  { rpc: "close_team_registration_atomically", label: "close team registration", call: (c, a) => closeTeamRegistration(compRepo, c.competitionId, a) },
  { rpc: "add_competition_team_atomically", label: "add a team (current signature)", call: (c, a) => addCompetitionTeam(compRepo, c.competitionId, a, `Extra Team ${randomUUID().slice(0, 6)}`, c.someMemberId) },
  {
    rpc: "add_competition_team_atomically",
    label: "add a team (legacy 4-argument signature)",
    call: async (c, a) => {
      const { error } = await serviceClient.rpc("add_competition_team_atomically", { p_competition_id: c.competitionId, p_organizer_gaming_member_id: a, p_name: `Legacy Team ${randomUUID().slice(0, 6)}`, p_captain_gaming_member_id: c.someMemberId });
      if (error) throw translateError(error);
    },
  },
  { rpc: "decide_competition_team_atomically", label: "decide a proposed team", call: (c, a) => decideCompetitionTeam(compRepo, c.teams[1].competitionTeamId, a, "APPROVE", null) },
  {
    rpc: "publish_competition_atomically",
    label: "publish the bracket",
    call: (c, a) => publishCompetition(compRepo, c.competitionId, a, c.teams[0].competitionTeamId, c.teams[1].competitionTeamId, c.teams[2].competitionTeamId, c.teams[3].competitionTeamId, iso(3600_000), iso(7200_000), iso(10800_000)),
  },
  { rpc: "cancel_incomplete_competition_atomically", label: "cancel the competition", call: (c, a) => cancelCompetition(compRepo, c.competitionId, a, "Testing the boundary.") },
  { rpc: "appoint_competition_scorekeeper_atomically", label: "appoint a scorekeeper", call: (c, a) => appointScorekeeper(compRepo, c.semifinal1FixtureId, a, c.someMemberId) },
  { rpc: "organizer_review_join_request_atomically", label: "review a join request as organizer", call: (c, a) => organizerReviewJoinRequest(compRepo, c.joinRequestId, a, "APPROVE", "Testing the boundary.") },
  { rpc: "decide_join_request_atomically", label: "override a join-request decision (organizer branch)", call: (c, a) => decideJoinRequest(compRepo, c.joinRequestId, a, "APPROVE", true) },
  { rpc: "declare_competition_roster_atomically", label: "correct a roster (organizer branch)", call: (c, a) => declareRoster(compRepo, c.semifinal1FixtureId, c.teams[0].competitionTeamId, a, true, "Testing the boundary.", [c.teams[0].captainId]) },
  { rpc: "correct_competition_fixture_atomically", label: "correct fixture evidence", call: (c, a) => correctFixture(compRepo, c.semifinal1FixtureId, a, "Testing the boundary.", 1, 0, [], [], null) },
  { rpc: "finalize_competition_fixture_atomically", label: "finalize a fixture", call: (c, a) => finalizeFixture(compRepo, c.semifinal1FixtureId, a) },
  { rpc: "forfeit_competition_fixture_atomically", label: "forfeit a fixture", call: (c, a) => forfeitFixture(compRepo, c.semifinal1FixtureId, a, c.teams[0].competitionTeamId, "Testing the boundary.") },
  { rpc: "void_competition_fixture_atomically", label: "void a fixture (cancels the competition)", call: (c, a) => voidFixture(compRepo, c.semifinal2FixtureId, a, "Testing the boundary.") },
  // UG-CR-GATE-SSS-004: the Organizer Planning save. A published matrix competition is no longer a DRAFT, so for its OWN active organizer this reports the state
  // refusal (CompetitionNotDraftError) — after, never instead of, the ownership check and the host-revocation guard the rest of this matrix proves for it.
  { rpc: "save_competition_planning_revision_atomically", label: "save a draft planning revision", call: (c, a) => compRepo.savePlanningRevision(c.competitionId, a, randomUUID(), planningPlan()) },
];

/** Organizer-gated functions the catalog must find: exactly the names of the list above (the planning save included), plus the scorekeeper evidence path. */
const ORGANIZER_RPC_NAMES = Array.from(new Set(ORGANIZER_CALLS.map((c) => c.rpc))).sort();
const SCOREKEEPER_RPC = "submit_competition_fixture_evidence_atomically";

let ctxInternal: CompetitionCtx;
let ctxHostActive: CompetitionCtx;
let ctxHostRevoked: CompetitionCtx;
let matrixReady = false;

async function ensureMatrix() {
  if (matrixReady) return;
  ctxInternal = await buildInternalCompetition("mx-internal");
  ctxHostActive = await buildHostCompetition("mx-active");
  ctxHostRevoked = await buildHostCompetition("mx-revoked");
  matrixReady = true;
}

describe("[T14, T15, T16, T17] ownership and revocation hold on every organizer path", () => {
  it("the inventory is complete: the catalog's organizer-gated functions are exactly the ones this matrix exercises, each guarded in the right place", async () => {
    const db = await connectRaw();
    try {
      const { rows } = await db.query(
        // pg_get_functiondef rejects aggregates, so restrict to ordinary functions in a materialized step first.
        `with fns as materialized (
           select p.oid, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
            where n.nspname = 'public' and p.prokind = 'f'
         )
         select f.proname, pg_get_functiondef(f.oid) as def from fns f
          where pg_get_functiondef(f.oid) like '%COMPETITION_ACCESS_DENIED%'
          order by f.proname, f.oid`
      );
      const found = Array.from(new Set(rows.map((r) => r.proname as string))).sort();
      const participantOnly = new Set<string>(); // functions that can raise COMPETITION_ACCESS_DENIED but are not organizer-gated would be listed here
      expect(found.filter((n) => !participantOnly.has(n))).toEqual([...ORGANIZER_RPC_NAMES, SCOREKEEPER_RPC].sort());

      for (const row of rows) {
        const def: string = row.def;
        const isScorekeeper = row.proname === SCOREKEEPER_RPC;
        const guard = isScorekeeper ? "assert_actor_not_revoked_host(" : "assert_competition_not_host_revoked(";
        const guardAt = def.indexOf(guard);
        expect(guardAt, `${row.proname} must call ${guard}`).toBeGreaterThan(-1);
        // Same competition-scope serialization lock as before, taken FIRST, before the guard and before any write.
        const lockAt = def.indexOf("pg_advisory_xact_lock(hashtext('competition_scope:'");
        expect(lockAt, `${row.proname} competition_scope lock`).toBeGreaterThan(-1);
        expect(lockAt, `${row.proname}: lock before guard`).toBeLessThan(guardAt);
        // The guard comes after the ownership check and before the first write.
        const deniedAt = def.indexOf("COMPETITION_ACCESS_DENIED");
        expect(guardAt, `${row.proname}: ownership check before guard`).toBeGreaterThan(deniedAt);
        const firstWrite = def.search(/\binsert\s+into\b|\bdelete\s+from\b|(?<!for\s)\bupdate\s+[a-z_.]+\s+set\b/i);
        if (firstWrite !== -1) expect(guardAt, `${row.proname}: guard before the first write`).toBeLessThan(firstWrite);
        // Definer functions keep their pinned search_path and grants.
        expect(def, row.proname).toMatch(/SECURITY DEFINER/);
        expect(def, row.proname).toMatch(/SET search_path TO 'public'/);
      }
      // The legacy and current add_competition_team signatures are BOTH patched.
      const addTeam = rows.filter((r) => r.proname === "add_competition_team_atomically");
      expect(addTeam).toHaveLength(2);
      for (const r of addTeam) expect(r.def).toContain("assert_competition_not_host_revoked(");
    } finally {
      await db.end();
    }
  }, 30000);

  it("every organizer function keeps SECURITY DEFINER, a locked search_path, and service_role-only execute (per exact overload)", async () => {
    const db = await connectRaw();
    try {
      const { rows } = await db.query(
        `select p.oid, p.proname, p.prosecdef, p.proconfig::text as cfg from pg_proc p join pg_namespace n on n.oid = p.pronamespace
          where n.nspname = 'public' and p.proname = any($1)`,
        [[...ORGANIZER_RPC_NAMES, SCOREKEEPER_RPC]]
      );
      expect(rows.length).toBeGreaterThanOrEqual(ORGANIZER_RPC_NAMES.length + 2);
      for (const row of rows) {
        expect(row.prosecdef, row.proname).toBe(true);
        expect(row.cfg, row.proname).toContain("search_path=public");
        for (const role of ["anon", "authenticated"]) {
          const { rows: x } = await db.query("select has_function_privilege($1, $2::oid, 'EXECUTE') as ok", [role, row.oid]);
          expect(x[0].ok, `${role} must not execute ${row.proname}`).toBe(false);
        }
        const { rows: pub } = await db.query(
          `select count(*)::int as n from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = $1::oid and a.grantee = 0 and a.privilege_type = 'EXECUTE'`,
          [row.oid]
        );
        expect(pub[0].n, `PUBLIC must not execute ${row.proname}`).toBe(0);
      }
    } finally {
      await db.end();
    }
  }, 30000);

  it("[T14] positive control: the host's own sequence really works — open, add, close, publish, appoint a scorekeeper", async () => {
    const live = await buildHostCompetition("positive");
    const view = await getCompetitionView(compRepo, live.competitionId, live.organizerId);
    expect(view.competition.state).toBe("PUBLISHED");
    expect(view.isOrganizer).toBe(true);
    expect(view.fixtures).toHaveLength(3);
    const scorekeeper = await createMember("Independent Scorekeeper");
    await expect(appointScorekeeper(compRepo, live.semifinal1FixtureId, live.organizerId, scorekeeper.gamingMemberId)).resolves.toBeDefined();
  }, 120000);

  it("[T15] a host cannot mutate ANOTHER organizer's competition through any path (internal organizer's, or another host's)", async () => {
    await ensureMatrix();
    for (const target of [ctxInternal, ctxHostRevoked]) {
      for (const entry of ORGANIZER_CALLS) {
        const err = await expectRejection(entry.call(target, ctxHostActive.organizerId), CompetitionAccessDeniedError);
        void err;
      }
    }
  }, 240000);

  it("[T15] and nobody with an internal OPERATIONAL grant gains organizer power over a host's competition", async () => {
    await ensureMatrix();
    for (const entry of ORGANIZER_CALLS) {
      await expectRejection(entry.call(ctxHostActive, ctxInternal.organizerId), CompetitionAccessDeniedError);
    }
  }, 240000);

  it("[T15] a host cannot read another competition's organizer-only data, and cannot see that private pilot in the shared list", async () => {
    await ensureMatrix();
    const foreignView = await getCompetitionView(compRepo, ctxInternal.competitionId, ctxHostActive.organizerId);
    expect(foreignView.isOrganizer).toBe(false);
    expect(foreignView.pendingTeamProposals).toEqual([]);
    expect(foreignView.rejectedTeamProposals).toEqual([]);
    const all = await compRepo.listCompetitions();
    const listedForOther = all.filter((c) => isListedFor(c, ctxInternal.organizerId));
    expect(listedForOther.map((c) => c.competitionId)).not.toContain(ctxHostActive.competitionId);
    expect(listedForOther.map((c) => c.competitionId)).not.toContain(ctxHostRevoked.competitionId);
    const listedForHost = all.filter((c) => isListedFor(c, ctxHostActive.organizerId));
    expect(listedForHost.map((c) => c.competitionId)).toContain(ctxHostActive.competitionId);
    expect(listedForHost.map((c) => c.competitionId)).not.toContain(ctxHostRevoked.competitionId);
    expect(listedForHost.map((c) => c.competitionId)).toContain(ctxInternal.competitionId); // internal competitions keep their existing visibility
  }, 120000);

  it("[discoverability] a private pilot is found by the people who belong to it and by nobody else: scorekeeper, captain, registrant, join requester — not a stranger, not another host", async () => {
    const live = await buildHostCompetition("discover");
    const scorekeeper = await createMember("Assigned Scorekeeper");
    await appointScorekeeper(compRepo, live.semifinal1FixtureId, live.organizerId, scorekeeper.gamingMemberId);
    const stranger = await createMember("Curious Stranger");
    const otherHost = (await approvedHost("discover-other")).member;

    const all = await compRepo.listCompetitions();
    const pilot = all.find((c) => c.competitionId === live.competitionId)!;
    expect(pilot.hostBound).toBe(true);
    const visibleTo = async (memberId: string) => isListedFor(pilot, memberId, new Set(await compRepo.listCompetitionIdsInvolvingMember(memberId)));

    expect(await visibleTo(live.organizerId)).toBe(true);                 // the host
    expect(await visibleTo(scorekeeper.gamingMemberId)).toBe(true);       // appointed scorekeeper
    expect(await visibleTo(live.teams[0].captainId)).toBe(true);          // a team captain
    expect(await visibleTo(live.someMemberId)).toBe(true);                // a registrant who asked to join a team
    expect(await visibleTo(stranger.gamingMemberId)).toBe(false);         // nobody else
    expect(await visibleTo(otherHost.gamingMemberId)).toBe(false);        // not even another approved host
    expect(await visibleTo(ctxInternal?.organizerId ?? randomUUID())).toBe(false); // nor an internal organizer

    // The role lookup answers per member and never returns another member's competitions.
    expect(await compRepo.listCompetitionIdsInvolvingMember(stranger.gamingMemberId)).toEqual([]);
    const scorekeeperIds = await compRepo.listCompetitionIdsInvolvingMember(scorekeeper.gamingMemberId);
    expect(scorekeeperIds).toEqual([live.competitionId]);
  }, 120000);

  it("[T16] the competition's public code and the invitation links confer no organizer power", async () => {
    await ensureMatrix();
    const resolved = await resolveCompetitionByPublicCode(compRepo, ctxHostActive.publicCode);
    expect(resolved.competitionId).toBe(ctxHostActive.competitionId);
    const invited = await createMember("Invited With Link");
    for (const entry of ORGANIZER_CALLS) {
      await expectRejection(entry.call(ctxHostActive, invited.gamingMemberId), CompetitionAccessDeniedError);
    }
    const view = await getCompetitionView(compRepo, resolved.competitionId, invited.gamingMemberId);
    expect(view.isOrganizer).toBe(false);
    expect(view.pendingTeamProposals).toEqual([]);
    expect(view.competition.name).toContain("mx-active"); // the public truth is visible to the invited
  }, 120000);

  // NOTE: this test MUTATES ctxHostActive (it approves the join request, may finalize a fixture, and so on), so it runs
  // after every test that needs ctxHostActive pristine: some existing functions report a state refusal (for example
  // JOIN_REQUEST_NOT_PENDING) before they check who is asking.
  it("[T14] the host administers their own competition: organizer calls get past the ownership check and the revocation guard", async () => {
    await ensureMatrix();
    for (const entry of ORGANIZER_CALLS) {
      const outcome = await entry.call(ctxHostActive, ctxHostActive.organizerId).then(() => null, (e: unknown) => e);
      if (outcome !== null) {
        expect(outcome, `${entry.label}: an active host must not be refused as a stranger or as revoked`).not.toBeInstanceOf(CompetitionAccessDeniedError);
        expect(outcome, `${entry.label}`).not.toBeInstanceOf(HostAccessRevokedError);
        expect(statusForCompetitionsError(outcome), `${entry.label}: expected a known domain refusal (state), got ${(outcome as Error)?.name}`).not.toBeNull();
      }
    }
    const view = await getCompetitionView(compRepo, ctxHostActive.competitionId, ctxHostActive.organizerId);
    expect(view.isOrganizer).toBe(true);
  }, 240000);

  it("[T17] after revocation EVERY organizer path is refused with HOST_ACCESS_REVOKED — database level, not UI", async () => {
    await ensureMatrix();
    const code = ctxHostRevoked.hostCode!;
    // Before: the host can act.
    await expect(ORGANIZER_CALLS[0].call(ctxHostRevoked, ctxHostRevoked.organizerId).then(() => "ok", (e: Error) => e.constructor.name)).resolves.not.toBe("HostAccessRevokedError");
    await revoke(code, "Revocation matrix.");
    for (const entry of ORGANIZER_CALLS) {
      await expectRejection(entry.call(ctxHostRevoked, ctxHostRevoked.organizerId), HostAccessRevokedError);
    }
    // The error is a 403 with plain-language text, and it never echoes SQL.
    const err = await expectRejection(openTeamRegistration(compRepo, ctxHostRevoked.competitionId, ctxHostRevoked.organizerId), HostAccessRevokedError);
    expect(statusForCompetitionsError(err)).toBe(403);
    expect(err.message).toBe("Your hosting access has been revoked. You can no longer administer this competition.");
  }, 240000);

  it("[T17] revocation also ends read access to organizer-only data and the listing, while the public truth and all history remain", async () => {
    await ensureMatrix();
    const record = (await compRepo.getCompetitionById(ctxHostRevoked.competitionId))!;
    expect(record).toMatchObject({ hostBound: true, hostAccessRevoked: true, organizerGamingMemberId: ctxHostRevoked.organizerId });
    expect(isActiveOrganizer(record, ctxHostRevoked.organizerId)).toBe(false);
    const view = await getCompetitionView(compRepo, ctxHostRevoked.competitionId, ctxHostRevoked.organizerId);
    expect(view.isOrganizer).toBe(false);
    expect(view.pendingTeamProposals).toEqual([]);
    expect(view.competition.name).toContain("mx-revoked");
    expect(view.competition.state).toBe("PUBLISHED");
    // Everything is still there.
    const { data: teams } = await serviceClient.from("competition_teams").select("competition_team_id").eq("competition_id", ctxHostRevoked.competitionId);
    expect(teams).toHaveLength(4);
    const { data: fixtures } = await serviceClient.from("competition_fixtures").select("competition_fixture_id").eq("competition_id", ctxHostRevoked.competitionId);
    expect(fixtures).toHaveLength(3);
    const row = await applicationRow(ctxHostRevoked.hostCode!);
    expect(row.state).toBe("APPROVED");
    const cap = (await capabilityRow(row.host_application_id))!;
    expect(cap).toMatchObject({ state: "REVOKED", competition_id: ctxHostRevoked.competitionId });
    expect((await getHostStatus(hostRepo, ctxHostRevoked.organizerId)).phase).toBe("ACCESS_REVOKED");
  }, 120000);

  it("[T17] a host who appointed THEMSELVES scorekeeper loses that route too (evidence submission), while an independent scorekeeper is unaffected", async () => {
    const live = await buildHostCompetition("selfscore");
    const independent = await createMember("Independent Scorer");
    await appointScorekeeper(compRepo, live.semifinal1FixtureId, live.organizerId, live.organizerId);
    await appointScorekeeper(compRepo, live.semifinal2FixtureId, live.organizerId, independent.gamingMemberId);
    // Active: the host-as-scorekeeper gets past the guard (the fixture is not yet in its evidence phase).
    await expectRejection(submitFixtureEvidence(compRepo, live.semifinal1FixtureId, live.organizerId, 1, 0, [], [], [], null), FixtureNotInEvidencePhaseError);
    await revoke(live.hostCode!, "Self-appointed scorekeeper check.");
    await expectRejection(submitFixtureEvidence(compRepo, live.semifinal1FixtureId, live.organizerId, 1, 0, [], [], [], null), HostAccessRevokedError);
    await expectRejection(submitFixtureEvidence(compRepo, live.semifinal2FixtureId, independent.gamingMemberId, 1, 0, [], [], [], null), FixtureNotInEvidencePhaseError);
  }, 120000);

  it("[T17] a revocation after the competition has run keeps the public/member truth readable by participants", async () => {
    await ensureMatrix();
    const view = await getCompetitionView(compRepo, ctxHostRevoked.competitionId, ctxHostRevoked.someMemberId);
    expect(view.competition.competitionId).toBe(ctxHostRevoked.competitionId);
    expect(view.teams).toHaveLength(4);
    expect(view.fixtures).toHaveLength(3);
  }, 60000);
});

// =============================================================================
// Serialization: revocation vs in-flight organizer mutations, on raw connections
// =============================================================================

async function waitUntilBlockedOnLock(observer: Client, backendPid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const { rows } = await observer.query("select wait_event_type from pg_stat_activity where pid = $1", [backendPid]);
    if (rows[0]?.wait_event_type === "Lock") return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error("The statement never blocked on a lock.");
}

describe("serialization: revoke, create and organizer actions cannot interleave", () => {
  it("an in-flight organizer mutation makes a revocation WAIT (competition_scope), and the order of completion is preserved", async () => {
    const live = await buildHostCompetition("ser-a");
    const holder = await connectRaw();
    const revoker = await connectRaw();
    const observer = await connectRaw();
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtext('competition_scope:' || $1::text))", [live.competitionId]);
      await withGovernance(async () => {
        const { rows: pid } = await revoker.query("select pg_backend_pid() as pid");
        const pending = revoker.query("select * from revoke_host_capability_atomically($1, $2, $3)", [reviewer.gamingMemberId, live.hostCode, "Waits for the in-flight action."]);
        await waitUntilBlockedOnLock(observer, pid[0].pid);
        const cap = (await capabilityRow((await applicationRow(live.hostCode!)).host_application_id))!;
        expect(cap.state).toBe("CONSUMED"); // not yet revoked while the organizer action is in flight
        await holder.query("commit");
        const result = await pending;
        expect(result.rows[0]).toMatchObject({ capability_state: "REVOKED", already_revoked: false });
      });
    } finally {
      await holder.query("rollback").catch(() => {});
      await Promise.all([holder.end(), revoker.end(), observer.end()]);
    }
  }, 60000);

  it("a revocation in flight makes an organizer mutation WAIT, and the mutation then fails as revoked", async () => {
    const live = await buildHostCompetition("ser-b");
    const revoker = await connectRaw();
    const actor = await connectRaw();
    const observer = await connectRaw();
    try {
      await withGovernance(async () => {
        await revoker.query("begin");
        await revoker.query("select * from revoke_host_capability_atomically($1, $2, $3)", [reviewer.gamingMemberId, live.hostCode, "Revocation commits after the action starts."]);
        const { rows: pid } = await actor.query("select pg_backend_pid() as pid");
        const mutation = actor
          .query("select * from close_team_registration_atomically($1, $2)", [live.competitionId, live.organizerId])
          .then(() => "completed", (e: Error) => e.message);
        await waitUntilBlockedOnLock(observer, pid[0].pid);
        await revoker.query("commit");
        const outcome = await mutation;
        expect(outcome).toContain("HOST_ACCESS_REVOKED");
      });
    } finally {
      await revoker.query("rollback").catch(() => {});
      await Promise.all([revoker.end(), actor.end(), observer.end()]);
    }
  }, 60000);

  it("creation waits on the member's host_scope lock", async () => {
    const { member, code } = await approvedHost("ser-c");
    const holder = await connectRaw();
    const creator = await connectRaw();
    const observer = await connectRaw();
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtext('host_scope:' || $1::text))", [member.gamingMemberId]);
      const { rows: pid } = await creator.query("select pg_backend_pid() as pid");
      const pending = creator.query("select * from create_host_competition_atomically($1, $2, 'SOCCER_5V5', $3)", [member.gamingMemberId, `Lock Pilot ${RUN}`, `L${randomUUID().replace(/-/g, "").slice(0, 21)}`]);
      await waitUntilBlockedOnLock(observer, pid[0].pid);
      await holder.query("commit");
      const result = await pending;
      expect(result.rows[0].state).toBe("DRAFT");
      void code;
    } finally {
      await holder.query("rollback").catch(() => {});
      await Promise.all([holder.end(), creator.end(), observer.end()]);
    }
  }, 60000);
});

describe("serialization of decisions, withdrawals, and revoke-versus-create", () => {
  it("[T9] a decision waits on the applicant's host_scope lock, then completes (deterministic proof that approve/reject/withdraw serialize)", async () => {
    const applicant = await createMember("Applicant Lock Decide");
    const code = await apply(applicant, "lockdec");
    const holder = await connectRaw();
    const decider = await connectRaw();
    const observer = await connectRaw();
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtext('host_scope:' || $1::text))", [applicant.gamingMemberId]);
      await withGovernance(async () => {
        const { rows: pid } = await decider.query("select pg_backend_pid() as pid");
        const pending = decider.query("select * from decide_host_application_atomically($1, $2, 'APPROVE', null)", [reviewer.gamingMemberId, code]);
        await waitUntilBlockedOnLock(observer, pid[0].pid);
        expect((await applicationRow(code)).state).toBe("PENDING"); // nothing decided while the lock is held
        await holder.query("commit");
        expect((await pending).rows[0]).toMatchObject({ state: "APPROVED", already_decided: false });
      });
    } finally {
      await holder.query("rollback").catch(() => {});
      await Promise.all([holder.end(), decider.end(), observer.end()]);
    }
  }, 60000);

  it("[T9] a withdrawal waits on the same lock, and a decision that commits first wins: the withdrawal is then refused and the approval stands", async () => {
    const applicant = await createMember("Applicant Lock Withdraw");
    const code = await apply(applicant, "lockwd");
    const holder = await connectRaw();
    const withdrawer = await connectRaw();
    const observer = await connectRaw();
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtext('host_scope:' || $1::text))", [applicant.gamingMemberId]);
      await withGovernance(async () => {
        const { rows: pid } = await withdrawer.query("select pg_backend_pid() as pid");
        const withdrawal = withdrawer
          .query("select * from withdraw_host_application_atomically($1, $2)", [applicant.gamingMemberId, code])
          .then(() => "withdrawn", (e: Error) => e.message);
        await waitUntilBlockedOnLock(observer, pid[0].pid);
        // The holder stands in for a decision already in flight: it approves (re-entering the same lock) and commits.
        await holder.query("select * from decide_host_application_atomically($1, $2, 'APPROVE', null)", [reviewer.gamingMemberId, code]);
        await holder.query("commit");
        expect(await withdrawal).toContain("HOST_APPLICATION_NOT_PENDING");
      });
    } finally {
      await holder.query("rollback").catch(() => {});
      await Promise.all([holder.end(), withdrawer.end(), observer.end()]);
    }
    const row = await applicationRow(code);
    expect(row.state).toBe("APPROVED");
    expect(await capabilityRow(row.host_application_id)).not.toBeNull();
  }, 60000);

  it("revoke versus create, raced behind the same lock, always ends consistent: either the pilot exists and is bound and revoked, or it never existed and the capability is revoked unused", async () => {
    for (let round = 0; round < 3; round++) {
      const { member, code } = await approvedHost(`rvc${round}`);
      const holder = await connectRaw();
      const revoker = await connectRaw();
      const creator = await connectRaw();
      const observer = await connectRaw();
      try {
        await holder.query("begin");
        await holder.query("select pg_advisory_xact_lock(hashtext('host_scope:' || $1::text))", [member.gamingMemberId]);
        await withGovernance(async () => {
          const { rows: p1 } = await revoker.query("select pg_backend_pid() as pid");
          const { rows: p2 } = await creator.query("select pg_backend_pid() as pid");
          const revoking = revoker.query("select * from revoke_host_capability_atomically($1, $2, $3)", [reviewer.gamingMemberId, code, "Race with creation."]).then(() => "revoked", (e: Error) => e.message);
          const creating = creator
            .query("select * from create_host_competition_atomically($1, $2, 'SOCCER_5V5', $3)", [member.gamingMemberId, `Race Pilot ${round} ${RUN}`, `V${randomUUID().replace(/-/g, "").slice(0, 21)}`])
            .then(() => "created", (e: Error) => e.message);
          await Promise.all([waitUntilBlockedOnLock(observer, p1[0].pid), waitUntilBlockedOnLock(observer, p2[0].pid)]);
          await holder.query("commit");
          const [r, c] = await Promise.all([revoking, creating]);
          const cap = (await capabilityRow((await applicationRow(code)).host_application_id))!;
          const { data: comps } = await serviceClient.from("competitions").select("competition_id").eq("organizer_gaming_member_id", member.gamingMemberId);
          expect(cap.state, `round ${round}`).toBe("REVOKED"); // revocation always wins eventually and is never lost
          expect(r, `round ${round}`).toBe("revoked");
          if (c === "created") {
            expect(comps).toHaveLength(1); // created first: the pilot exists and stays bound to the revoked capability
            expect(cap.competition_id).toBe(comps![0].competition_id);
          } else {
            expect(c).toContain("HOST_CAPABILITY_REVOKED"); // revoked first: the creation was refused and nothing exists
            expect(comps).toHaveLength(0);
            expect(cap.competition_id).toBeNull();
          }
        });
      } finally {
        await holder.query("rollback").catch(() => {});
        await Promise.all([holder.end(), revoker.end(), creator.end(), observer.end()]);
      }
    }
  }, 120000);
});

describe("revocation stays reachable from the review lists, however much history exists", () => {
  it("a live host is always in Active hosts (uncapped); History holds only rejected/revoked decisions, newest 200, never withdrawn rows", async () => {
    const { member: liveHost, code: liveCode } = await approvedHost("reach-live");
    await createHostCompetition(hostRepo, liveHost.gamingMemberId, `Reachable Pilot ${RUN}`);

    // Flood: 205 withdrawn + 205 rejected applications from one member (rejected and withdrawn rows do not count against the
    // one-live-application rule), all dated in the past so that the revocation below is the newest history event.
    const flooder = await createMember("History Flooder");
    const db = await connectRaw();
    try {
      await db.query(
        `insert into competition_host_applications (gaming_member_id, venue_name, city_area, playing_fields, venue_description, expected_window, expected_team_count,
                                                   confirm_all_adults, confirm_independent_scorekeepers, confirm_pilot_exclusions, state, withdrawn_at, submitted_at)
         select $1, 'Flood W ' || g, 'Nowhere', 1, 'Synthetic withdrawn row used to saturate the history list.', 'soon', 4, true, true, true, 'WITHDRAWN', now() - interval '2 hours' + (g || ' seconds')::interval, now() - interval '3 hours'
           from generate_series(1, 205) g`,
        [flooder.gamingMemberId]
      );
      await db.query(
        `insert into competition_host_applications (gaming_member_id, venue_name, city_area, playing_fields, venue_description, expected_window, expected_team_count,
                                                   confirm_all_adults, confirm_independent_scorekeepers, confirm_pilot_exclusions, state, decided_at, decided_by_gaming_member_id, decision_reason, submitted_at)
         select $1, 'Flood R ' || g, 'Nowhere', 1, 'Synthetic rejected row used to saturate the history list.', 'soon', 4, true, true, true, 'REJECTED', now() - interval '2 hours' + (g || ' seconds')::interval, $2, 'flood', now() - interval '3 hours'
           from generate_series(1, 205) g`,
        [flooder.gamingMemberId, reviewer.gamingMemberId]
      );
    } finally {
      await db.end();
    }

    const active = await withGovernance(() => listHostApplicationsForReview(hostRepo, reviewer.gamingMemberId, "ACTIVE"));
    expect(active.map((r) => r.publicCode)).toContain(liveCode);
    expect(active.every((r) => r.state === "APPROVED" && (r.capabilityState === "AVAILABLE" || r.capabilityState === "CONSUMED"))).toBe(true);
    const history = await withGovernance(() => listHostApplicationsForReview(hostRepo, reviewer.gamingMemberId, "HISTORY"));
    expect(history).toHaveLength(200); // capped...
    expect(history.some((r) => r.state === "WITHDRAWN")).toBe(false); // ...and withdrawn rows never enter it
    expect(history.every((r) => r.state === "REJECTED" || (r.state === "APPROVED" && r.capabilityState === "REVOKED"))).toBe(true);
    expect(history.map((r) => r.publicCode)).not.toContain(liveCode); // the live host is not buried in History: it is in Active hosts
    const pending = await withGovernance(() => listHostApplicationsForReview(hostRepo, reviewer.gamingMemberId, "PENDING"));
    expect(pending.some((r) => r.state !== "PENDING")).toBe(false);

    // And it can be revoked from exactly that list; afterwards it moves to History, newest first.
    await revoke(liveCode, "Reached through the Active hosts list.");
    const activeAfter = await withGovernance(() => listHostApplicationsForReview(hostRepo, reviewer.gamingMemberId, "ACTIVE"));
    expect(activeAfter.map((r) => r.publicCode)).not.toContain(liveCode);
    const historyAfter = await withGovernance(() => listHostApplicationsForReview(hostRepo, reviewer.gamingMemberId, "HISTORY"));
    expect(historyAfter[0].publicCode).toBe(liveCode);
  }, 120000);
});

// =============================================================================
// [T21, T22] Hostile text and identifier hygiene at the data layer
// =============================================================================

describe("[T21, T22] hostile text is data, and nothing identifying leaves the server", () => {
  it("[T21] hostile application text is stored and returned character-for-character; no statement is ever interpreted", async () => {
    const hostile = {
      venueName: `<img src=x onerror="alert(1)"> '); drop table competition_host_applications; --`,
      cityArea: `" onmouseover="alert(1)" '`,
      venueDescription: `<script>alert(document.cookie)</script>\n\n'; delete from admin_audit_events; -- ${"é".repeat(10)} 😀 \\ %s $1 {{7*7}}`,
      expectedWindow: `javascript:alert(1)`,
    };
    const member = await createMember("<b>Bold</b> Name");
    const result = await submitHostApplication(hostRepo, member.gamingMemberId, applicationInput("hostile", hostile));
    const status = await getHostStatus(hostRepo, member.gamingMemberId);
    expect(status.application).toMatchObject(hostile);
    const list = await withGovernance(() => listHostApplicationsForReview(hostRepo, reviewer.gamingMemberId, "PENDING"));
    const row = list.find((r) => r.publicCode === result.publicCode)!;
    expect(row).toMatchObject(hostile);
    expect(row.applicantDisplayName).toBe("<b>Bold</b> Name");
    const { count } = await serviceClient.from("competition_host_applications").select("*", { count: "exact", head: true });
    expect(count).toBeGreaterThan(0); // the "drop table" in the text did nothing
    await withdrawHostApplication(hostRepo, member.gamingMemberId, result.publicCode);
  }, 30000);

  it("[T22] nothing the browser receives from the host surfaces holds a UUID, an email, a token, or a member name it should not", async () => {
    const { member, code } = await approvedHost("leak");
    await createHostCompetition(hostRepo, member.gamingMemberId, `Leak Pilot ${RUN}`);
    const status = JSON.stringify(await getHostStatus(hostRepo, member.gamingMemberId));
    const review = JSON.stringify(await withGovernance(() => listHostApplicationsForReview(hostRepo, reviewer.gamingMemberId, "HISTORY")));
    for (const body of [status, review]) {
      expect(body).not.toMatch(UUID_PATTERN);
      expect(body).not.toContain("@example.com");
      expect(body).not.toMatch(JWT_SHAPE); // no JWT
      expect(body).not.toContain(member.gamingMemberId);
      expect(body).not.toContain(member.authUserId);
    }
    expect(status).not.toContain(reviewer.gamingMemberId);
    void code;
  }, 60000);

  // UG-CR-GATE-SSS-007A Correction C. The guard above must recognise a structurally plausible token — three dot-separated base64url segments whose first
  // starts "eyJ" (the encoding of `{"`) — and not the three letters "eyJ" that a random 22-character public code happens to contain. These controls pin both.
  // (Red-first: this block first ran against the previous guard, which flagged the incidental code; PREVIOUS_GUARD below keeps that fact checked.)
  const GUARD = JWT_SHAPE;
  const PREVIOUS_GUARD = /eyJ[A-Za-z0-9_-]{10,}/;
  it("[T22] the JWT guard ignores the letters 'eyJ' inside an ordinary public code, wherever they fall", () => {
    const filler = "A1b2C3d4E5f6G7h8I9j0K1";
    for (let offset = 0; offset <= 9; offset++) {
      const code = (filler.slice(0, offset) + "eyJ" + filler.slice(offset + 3)).slice(0, 22);
      expect(code).toHaveLength(22);
      expect(code).toContain("eyJ");
      const body = JSON.stringify({ publicCode: `CR-p-${code}`, nested: [{ code }, { code: "eyJ" + filler.slice(3, 22) }] });
      expect(body, `incidental eyJ at offset ${offset}`).not.toMatch(GUARD);
      expect(body, `the control is meaningful: the previous guard flagged offset ${offset}`).toMatch(PREVIOUS_GUARD);
    }
    // Hyphens and underscores are legitimate inside a code and never make it a token.
    expect(JSON.stringify({ publicCode: "CR-p-eyJ_abc-DEFGH12345" })).not.toMatch(GUARD);
  });

  it("[T22] the JWT guard still detects a complete JWT-shaped value, quoted, bearer-prefixed or unsigned", () => {
    // Clearly synthetic: the header decodes to {"alg":"none","typ":"synthetic"}, the payload to {"sub":"synthetic-control-only"}; nothing here is a credential.
    const header = "eyJhbGciOiJub25lIiwidHlwIjoic3ludGhldGljIn0";
    const payload = "eyJzdWIiOiJzeW50aGV0aWMtY29udHJvbC1vbmx5In0";
    const signature = "c3ludGhldGljLXNpZ25hdHVyZS1jb250cm9sLW9ubHk";
    for (const value of [`${header}.${payload}.${signature}`, `${header}.${payload}.`]) {
      expect(JSON.stringify({ token: value }), value).toMatch(GUARD);
      expect(`Authorization: Bearer ${value}`, value).toMatch(GUARD);
      expect(JSON.stringify({ a: "CR-p-AbCdEfGhIjKlMnOpQrStUv", nested: { deep: [value] } }), value).toMatch(GUARD);
    }
  });

  it("[T22] the typed errors a browser can receive never carry SQL text, ids or the caller's data", async () => {
    const member = await createMember("Applicant Messages");
    const code = await apply(member, "msg");
    const errors: Error[] = [];
    errors.push(await expectRejection(submitHostApplication(hostRepo, member.gamingMemberId, applicationInput("again")), HostApplicationAlreadyActiveError));
    errors.push(await expectRejection(decideHostApplication(hostRepo, member.gamingMemberId, code, "APPROVE", null), HostReviewerAuthorityRequiredError));
    errors.push(await expectRejection(createHostCompetition(hostRepo, member.gamingMemberId, "No Capability Pilot"), HostCapabilityRequiredError));
    errors.push(await expectRejection(withdrawHostApplication(hostRepo, (await createMember("Msg Stranger")).gamingMemberId, code), HostApplicationNotFoundError));
    for (const e of errors) {
      expect(e.message).not.toMatch(UUID_PATTERN);
      expect(e.message).not.toMatch(/P0001|raise|function|constraint|relation|public\.|select |insert /i);
      expect(e.message).not.toContain(code);
    }
    await withdrawHostApplication(hostRepo, member.gamingMemberId, code);
  }, 30000);
});

// =============================================================================
// NEGATIVE CONTROLS — remove each core enforcement inside a rolled-back transaction and show the invariant breaks
// =============================================================================

async function functionDefinition(db: Client, name: string, argTypes: string): Promise<string> {
  const { rows } = await db.query("select pg_get_functiondef(($1 || '(' || $2 || ')')::regprocedure) as def", [name, argTypes]);
  return rows[0].def as string;
}

async function mutateFunction(db: Client, name: string, argTypes: string, edit: (def: string) => string): Promise<void> {
  const original = await functionDefinition(db, name, argTypes);
  const edited = edit(original);
  expect(edited, `the mutation of ${name} must actually change it (otherwise the control proves nothing)`).not.toBe(original);
  await db.query(edited);
}

describe("[SSS-004A] the Organizer Planning save holds to the same organizer boundary as every other organizer function", () => {
  const FN = "save_competition_planning_revision_atomically";
  const FIVE_TABLES = ["competition_planning_revisions", "competition_planning_pitches", "competition_planning_pitch_formats", "competition_planning_dates", "competition_planning_windows"];

  async function draftPilot(label: string) {
    const { member, code } = await approvedHost(label);
    const created = await createHostCompetition(hostRepo, member.gamingMemberId, `Plan Pilot ${label} ${RUN}`);
    return { member, code, competitionId: created.competitionId };
  }

  /** Every planning row this competition owns, counted table by table: a refusal must leave it exactly as it was. */
  async function footprint(competitionId: string): Promise<number[]> {
    const db = await connectRaw();
    try {
      const q = async (sql: string) => (await db.query(sql, [competitionId])).rows[0].n as number;
      return [
        await q("select count(*)::int as n from competition_planning_revisions where competition_id = $1"),
        await q("select count(*)::int as n from competition_planning_pitches p join competition_planning_revisions r using (planning_revision_id) where r.competition_id = $1"),
        await q("select count(*)::int as n from competition_planning_pitch_formats f join competition_planning_pitches p using (planning_pitch_id) join competition_planning_revisions r using (planning_revision_id) where r.competition_id = $1"),
        await q("select count(*)::int as n from competition_planning_dates d join competition_planning_revisions r using (planning_revision_id) where r.competition_id = $1"),
        await q("select count(*)::int as n from competition_planning_windows w join competition_planning_revisions r using (planning_revision_id) where r.competition_id = $1"),
      ];
    } finally {
      await db.end();
    }
  }
  const saveSql = "select * from save_competition_planning_revision_atomically($1, $2, $3, $4::jsonb)";

  it("is service-role-only, SECURITY DEFINER and pinned to a safe search_path, per the catalog (and its five tables are server-only)", async () => {
    const db = await connectRaw();
    try {
      const { rows } = await db.query(
        `select p.oid, p.prosecdef, p.proconfig::text as cfg, pg_get_function_identity_arguments(p.oid) as args from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = $1`, [FN]);
      expect(rows).toHaveLength(1);
      expect(rows[0].prosecdef).toBe(true);
      expect(rows[0].cfg).toContain("search_path=public");
      expect(rows[0].args).toBe("p_competition_id uuid, p_organizer_gaming_member_id uuid, p_intent_id uuid, p_plan jsonb");
      for (const role of ["anon", "authenticated"]) expect((await db.query("select has_function_privilege($1, $2::oid, 'EXECUTE') as ok", [role, rows[0].oid])).rows[0].ok, role).toBe(false);
      expect((await db.query("select has_function_privilege('service_role', $1::oid, 'EXECUTE') as ok", [rows[0].oid])).rows[0].ok).toBe(true);
      const pub = await db.query(`select count(*)::int as n from pg_proc p, aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where p.oid = $1::oid and a.grantee = 0 and a.privilege_type = 'EXECUTE'`, [rows[0].oid]);
      expect(pub.rows[0].n).toBe(0);
      for (const table of FIVE_TABLES) {
        const t = await db.query("select c.relrowsecurity, (select count(*)::int from pg_policies where tablename = c.relname) as policies from pg_class c where c.relname = $1 and c.relkind = 'r'", [table]);
        expect(t.rows[0], table).toEqual({ relrowsecurity: true, policies: 0 });
      }
    } finally {
      await db.end();
    }
  }, 60000);

  it("a host's DRAFT pilot: the organizer saves; an unrelated organizer (even with OPERATIONAL) is denied; the refusal changes nothing", async () => {
    const pilot = await draftPilot("plan-own");
    const stranger = await createMember("Plan Stranger");
    await grantOperational(stranger.gamingMemberId);
    expect(await footprint(pilot.competitionId)).toEqual([0, 0, 0, 0, 0]);
    await expectRejection(compRepo.savePlanningRevision(pilot.competitionId, stranger.gamingMemberId, randomUUID(), planningPlan()), CompetitionAccessDeniedError);
    expect(await footprint(pilot.competitionId)).toEqual([0, 0, 0, 0, 0]);
    const saved = await compRepo.savePlanningRevision(pilot.competitionId, pilot.member.gamingMemberId, randomUUID(), planningPlan());
    expect(saved.revision.revisionNumber).toBe(1);
    expect(await footprint(pilot.competitionId)).toEqual([1, 1, 1, 1, 1]);
  }, 120000);

  it("DRAFT is required: once registration opens, the organizer is refused with the state error (neither a stranger nor revoked) and nothing changes", async () => {
    const pilot = await draftPilot("plan-state");
    await compRepo.savePlanningRevision(pilot.competitionId, pilot.member.gamingMemberId, randomUUID(), planningPlan());
    await openTeamRegistration(compRepo, pilot.competitionId, pilot.member.gamingMemberId);
    const before = await footprint(pilot.competitionId);
    await expectRejection(compRepo.savePlanningRevision(pilot.competitionId, pilot.member.gamingMemberId, randomUUID(), planningPlan()), CompetitionNotDraftError);
    expect(await footprint(pilot.competitionId)).toEqual(before);
  }, 120000);

  it("a REVOKED host organizer is refused as revoked — before the state and before the plan is read — and nothing changes", async () => {
    const pilot = await draftPilot("plan-revoked");
    await compRepo.savePlanningRevision(pilot.competitionId, pilot.member.gamingMemberId, randomUUID(), planningPlan());
    await revoke(pilot.code, "Planning matrix.");
    const before = await footprint(pilot.competitionId);
    await expectRejection(compRepo.savePlanningRevision(pilot.competitionId, pilot.member.gamingMemberId, randomUUID(), planningPlan()), HostAccessRevokedError);
    const viaRpc = await serviceClient.rpc(FN, { p_competition_id: pilot.competitionId, p_organizer_gaming_member_id: pilot.member.gamingMemberId, p_intent_id: randomUUID(), p_plan: { nonsense: true } });
    expect(viaRpc.error?.message).toContain("HOST_ACCESS_REVOKED");
    expect(await footprint(pilot.competitionId)).toEqual(before);
  }, 120000);

  it("takes the competition lock before it decides anything: a save waits behind the competition_scope lock, then completes", async () => {
    const pilot = await draftPilot("plan-lock");
    const holder = await connectRaw();
    const actor = await connectRaw();
    const observer = await connectRaw();
    try {
      await holder.query("begin");
      await holder.query("select pg_advisory_xact_lock(hashtext('competition_scope:' || $1::text))", [pilot.competitionId]);
      const { rows: pid } = await actor.query("select pg_backend_pid() as pid");
      const pending = actor.query(saveSql, [pilot.competitionId, pilot.member.gamingMemberId, randomUUID(), JSON.stringify(planToRpcPayload(planningPlan()))]).then(() => "completed", (e: Error) => e.message);
      await waitUntilBlockedOnLock(observer, pid[0].pid);
      expect(await footprint(pilot.competitionId)).toEqual([0, 0, 0, 0, 0]);          // nothing was decided or written while the lock was held elsewhere
      await holder.query("commit");
      expect(await pending).toBe("completed");
      expect(await footprint(pilot.competitionId)).toEqual([1, 1, 1, 1, 1]);
    } finally {
      await holder.query("rollback").catch(() => {});
      await Promise.all([holder.end(), actor.end(), observer.end()]);
    }
  }, 60000);

  it("a revocation in flight makes a planning save WAIT, and the save then fails as revoked with nothing written", async () => {
    const pilot = await draftPilot("plan-lock-revoke");
    const revoker = await connectRaw();
    const actor = await connectRaw();
    const observer = await connectRaw();
    try {
      await withGovernance(async () => {
        await revoker.query("begin");
        await revoker.query("select * from revoke_host_capability_atomically($1, $2, $3)", [reviewer.gamingMemberId, pilot.code, "Revocation commits after the save starts."]);
        const { rows: pid } = await actor.query("select pg_backend_pid() as pid");
        const mutation = actor.query(saveSql, [pilot.competitionId, pilot.member.gamingMemberId, randomUUID(), JSON.stringify(planToRpcPayload(planningPlan()))]).then(() => "completed", (e: Error) => e.message);
        await waitUntilBlockedOnLock(observer, pid[0].pid);
        await revoker.query("commit");
        expect(await mutation).toContain("HOST_ACCESS_REVOKED");
      });
      expect(await footprint(pilot.competitionId)).toEqual([0, 0, 0, 0, 0]);
    } finally {
      await revoker.query("rollback").catch(() => {});
      await Promise.all([revoker.end(), actor.end(), observer.end()]);
    }
  }, 60000);
});

describe("negative controls: the tests above FAIL when the core enforcement is removed", () => {
  it("control 1 — remove the revocation guard: a revoked host's organizer call then SUCCEEDS (so [T17] would fail)", async () => {
    const live = await buildHostCompetition("ctl-revoke");
    await revoke(live.hostCode!, "Control 1.");
    const db = await connectRaw();
    try {
      // Sanity: with the guard in place the call is refused.
      await expect(db.query("select * from open_team_registration_atomically($1, $2)", [live.competitionId, live.organizerId])).rejects.toThrow(/HOST_ACCESS_REVOKED/);
      await db.query("begin");
      await mutateFunction(db, "assert_competition_not_host_revoked", "uuid", (def) =>
        def.replace(/if exists \([\s\S]*?\) then[\s\S]*?end if;/, "null;")
      );
      // With the guard removed, the SAME call gets past it (and fails only on the competition's state, not on revocation).
      const outcome = await db.query("select * from close_team_registration_atomically($1, $2)", [live.competitionId, live.organizerId]).then(() => "completed", (e: Error) => e.message);
      expect(outcome).not.toContain("HOST_ACCESS_REVOKED");
      await db.query("rollback");
      // Rolled back: the real guard is back and the call is refused again.
      await expect(db.query("select * from open_team_registration_atomically($1, $2)", [live.competitionId, live.organizerId])).rejects.toThrow(/HOST_ACCESS_REVOKED/);
    } finally {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  }, 120000);

  it("control 2 — remove the ownership check from an organizer RPC: a foreign host then CAN act on someone else's competition (so [T15] would fail)", async () => {
    await ensureMatrix();
    const stranger = ctxHostActive.organizerId;
    const target = ctxInternal; // a competition the stranger does not organize
    const db = await connectRaw();
    try {
      await expect(db.query("select * from cancel_incomplete_competition_atomically($1, $2, 'x')", [target.competitionId, stranger])).rejects.toThrow(/COMPETITION_ACCESS_DENIED/);
      await db.query("begin");
      await mutateFunction(db, "open_team_registration_atomically", "uuid, uuid", (def) =>
        def.replace(/if [\s\S]*? then\s+raise exception 'COMPETITION_ACCESS_DENIED[\s\S]*?end if;/, "null;")
      );
      const outcome = await db.query("select * from open_team_registration_atomically($1, $2)", [target.competitionId, stranger]).then(() => "completed", (e: Error) => e.message);
      expect(outcome).not.toContain("COMPETITION_ACCESS_DENIED");
      await db.query("rollback");
      await expect(db.query("select * from open_team_registration_atomically($1, $2)", [target.competitionId, stranger])).rejects.toThrow(/COMPETITION_ACCESS_DENIED/);
    } finally {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  }, 120000);

  it("control 3 — remove the one-competition enforcement: the same approved host then ends up with TWO competitions (so [T11]/[T13] would fail)", async () => {
    const { member } = await approvedHost("ctl-one");
    const db = await connectRaw();
    try {
      await db.query("begin");
      // Remove the enforcement inside the function: the already-consumed refusal and the consumption itself.
      await mutateFunction(db, "create_host_competition_atomically", "uuid, text, text, text", (def) =>
        def.replace(/if v_capability_state = 'CONSUMED' then[\s\S]*?end if;/, "null;")
           .replace(/update competition_host_capabilities c[\s\S]*?where c\.host_capability_id = v_capability_id;/, "null;")
      );
      const first = await db.query("select * from create_host_competition_atomically($1, $2, 'SOCCER_5V5', $3)", [member.gamingMemberId, `Control One ${RUN}`, `K${randomUUID().replace(/-/g, "").slice(0, 21)}`]);
      const second = await db.query("select * from create_host_competition_atomically($1, $2, 'SOCCER_5V5', $3)", [member.gamingMemberId, `Control Two ${RUN}`, `K${randomUUID().replace(/-/g, "").slice(0, 21)}`]);
      expect(first.rows[0].competition_id).not.toBe(second.rows[0].competition_id);
      const { rows } = await db.query("select count(*)::int as n from competitions where organizer_gaming_member_id = $1", [member.gamingMemberId]);
      expect(rows[0].n).toBe(2); // the invariant "exactly one" is now violated — the real tests assert it holds
      await db.query("rollback");
      const { rows: after } = await db.query("select count(*)::int as n from competitions where organizer_gaming_member_id = $1", [member.gamingMemberId]);
      expect(after[0].n).toBe(0);
    } finally {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
    // And, back in the real schema, the enforcement holds again.
    await createHostCompetition(hostRepo, member.gamingMemberId, `Real One ${RUN}`);
    await expectRejection(createHostCompetition(hostRepo, member.gamingMemberId, `Real Two ${RUN}`), HostCapabilityAlreadyConsumedError);
  }, 120000);

  it("control 4 — remove the governance check from the decision function: a plain member then CAN approve (so [T5]/[T6] would fail)", async () => {
    const applicant = await createMember("Applicant Control Four");
    const outsider = await createMember("Outsider Control Four");
    const code = await apply(applicant, "ctl4");
    const db = await connectRaw();
    try {
      await expect(db.query("select * from decide_host_application_atomically($1, $2, 'APPROVE', null)", [outsider.gamingMemberId, code])).rejects.toThrow(/GOVERNANCE_AUTHORITY_REQUIRED/);
      await db.query("begin");
      await mutateFunction(db, "decide_host_application_atomically", "uuid, text, text, text", (def) =>
        def.replace(/if not exists \([\s\S]*?'PRODUCT_GOVERNANCE'[\s\S]*?\) then[\s\S]*?end if;/, "null;")
      );
      const result = await db.query("select * from decide_host_application_atomically($1, $2, 'APPROVE', null)", [outsider.gamingMemberId, code]);
      expect(result.rows[0].state).toBe("APPROVED"); // an unauthorized member approved it
      await db.query("rollback");
      expect((await applicationRow(code)).state).toBe("PENDING");
      await expect(db.query("select * from decide_host_application_atomically($1, $2, 'APPROVE', null)", [outsider.gamingMemberId, code])).rejects.toThrow(/GOVERNANCE_AUTHORITY_REQUIRED/);
    } finally {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
    await withdrawHostApplication(hostRepo, applicant.gamingMemberId, code);
  }, 60000);

  it("control 5 — remove the database state-machine trigger (the last line behind the function's lock and row lock): two terminal outcomes can then be recorded (the lock-based proofs above cover the layer in front of it)", async () => {
    const applicant = await createMember("Applicant Control Five");
    const code = await apply(applicant, "ctl5");
    const row = await applicationRow(code);
    const db = await connectRaw();
    try {
      await db.query("begin");
      await db.query("drop trigger competition_host_applications_guard_update on competition_host_applications");
      await db.query("update competition_host_applications set state = 'APPROVED', decided_at = now(), decided_by_gaming_member_id = $2 where host_application_id = $1", [row.host_application_id, reviewer.gamingMemberId]);
      await db.query("update competition_host_applications set state = 'REJECTED', decision_reason = 'second terminal state' where host_application_id = $1", [row.host_application_id]);
      const { rows } = await db.query("select state from competition_host_applications where host_application_id = $1", [row.host_application_id]);
      expect(rows[0].state).toBe("REJECTED"); // two terminal outcomes in a row: only the trigger prevents this
      await db.query("rollback");
    } finally {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
    expect((await applicationRow(code)).state).toBe("PENDING");
    await withdrawHostApplication(hostRepo, applicant.gamingMemberId, code);
  }, 60000);

  it("control 6 — remove the scorekeeper-path guard: a revoked host's self-appointment then still writes evidence (so the [T17] scorekeeper test would fail)", async () => {
    const live = await buildHostCompetition("ctl-score");
    await appointScorekeeper(compRepo, live.semifinal1FixtureId, live.organizerId, live.organizerId);
    await revoke(live.hostCode!, "Control 6.");
    const db = await connectRaw();
    try {
      await db.query("begin");
      await mutateFunction(db, "assert_actor_not_revoked_host", "uuid, uuid", (def) => def.replace(/if exists \([\s\S]*?\) then[\s\S]*?end if;/, "null;"));
      const outcome = await db
        .query("select * from submit_competition_fixture_evidence_atomically($1, $2, 1, 0, '[]'::jsonb, '[]'::jsonb, '[]'::jsonb, null)", [live.semifinal1FixtureId, live.organizerId])
        .then(() => "completed", (e: Error) => e.message);
      expect(outcome).not.toContain("HOST_ACCESS_REVOKED");
      await db.query("rollback");
    } finally {
      await db.query("rollback").catch(() => {});
      await db.end();
    }
  }, 120000);

  it("the controls left no trace: after every rollback the real guards, functions and constraints are intact", async () => {
    const db = await connectRaw();
    try {
      for (const [name, args, marker] of [
        ["assert_competition_not_host_revoked", "uuid", "HOST_ACCESS_REVOKED"],
        ["assert_actor_not_revoked_host", "uuid, uuid", "HOST_ACCESS_REVOKED"],
        ["decide_host_application_atomically", "uuid, text, text, text", "GOVERNANCE_AUTHORITY_REQUIRED"],
        ["create_host_competition_atomically", "uuid, text, text, text", "HOST_CAPABILITY_ALREADY_CONSUMED"],
        ["open_team_registration_atomically", "uuid, uuid", "COMPETITION_ACCESS_DENIED"],
      ] as const) {
        expect(await functionDefinition(db, name, args), name).toContain(marker);
      }
      const { rows } = await db.query("select count(*)::int as n from pg_trigger where tgname = 'competition_host_applications_guard_update'");
      expect(rows[0].n).toBe(1);
    } finally {
      await db.end();
    }
  }, 30000);
});
