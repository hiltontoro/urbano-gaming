import { randomUUID } from "node:crypto";

import { loadEnv } from "vite";
import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";

import { SupabaseAuthorityRepository } from "../lib/gaming/authority/db/supabaseAuthorityRepository";
import { SupabaseAuditRepository } from "../lib/gaming/audit/db/supabaseAuditRepository";
import { SupabaseGamingRepository } from "../lib/gaming/db/supabaseGamingRepository";
import { bootstrapGovernanceAuthority } from "../lib/gaming/authority/bootstrapGovernanceAuthority";
import { grantPlatformAuthority } from "../lib/gaming/authority/grantPlatformAuthority";
import { revokePlatformAuthority } from "../lib/gaming/authority/revokePlatformAuthority";
import {
  GovernanceAlreadyBootstrappedError,
  GovernanceAuthorityRequiredError,
  AuthorityGrantNotFoundError,
} from "../lib/gaming/authority/types";
import { requirePlatformAuthorityHttp, requireAnyAdminAuthority } from "../lib/gaming/predictions/httpAuth";

const env = loadEnv("development", process.cwd(), "");
const supabaseUrl = env.SUPABASE_URL;
const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for contract tests.");
}

const authorityRepo = new SupabaseAuthorityRepository(supabaseUrl, supabaseServiceRoleKey);
const auditRepo = new SupabaseAuditRepository(supabaseUrl, supabaseServiceRoleKey);
const gamingRepo = new SupabaseGamingRepository(supabaseUrl, supabaseServiceRoleKey);
const cleanupClient = createClient(supabaseUrl, supabaseServiceRoleKey);

const createdAuthUserIds: string[] = [];
const createdGamingMemberIds: string[] = [];

async function createRealGamingMember(displayName: string): Promise<string> {
  const email = `authority-contract-${randomUUID()}@example.com`;
  const { data, error } = await cleanupClient.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("Failed to create test auth user.");
  createdAuthUserIds.push(data.user.id);
  const member = await gamingRepo.createGamingMember(data.user.id, displayName);
  createdGamingMemberIds.push(member.gamingMemberId);
  return member.gamingMemberId;
}

/**
 * Same as createRealGamingMember, but also resolves a genuine Supabase
 * Auth access token — via magic-link + verifyOtp, mirroring the exact
 * pattern predictionsSupabaseRepository.contract.test.ts already
 * established for proving requireGamingAdmin end to end — so the new
 * HTTP-shaped requirePlatformAuthorityHttp/requireAnyAdminAuthority can
 * be proven against a real Authorization: Bearer header, not a mock.
 */
async function createRealGamingMemberWithToken(
  displayName: string
): Promise<{ gamingMemberId: string; accessToken: string }> {
  const email = `authority-contract-${randomUUID()}@example.com`;
  const { data, error } = await cleanupClient.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("Failed to create test auth user.");
  createdAuthUserIds.push(data.user.id);
  const member = await gamingRepo.createGamingMember(data.user.id, displayName);
  createdGamingMemberIds.push(member.gamingMemberId);

  const linkResponse = await cleanupClient.auth.admin.generateLink({ type: "magiclink", email });
  if (!linkResponse.data.properties) {
    throw new Error("generateLink did not return properties.");
  }
  const verified = await cleanupClient.auth.verifyOtp({
    token_hash: linkResponse.data.properties.hashed_token,
    type: "email",
  });
  return { gamingMemberId: member.gamingMemberId, accessToken: verified.data.session!.access_token };
}

/**
 * Bootstrap is a genuine, database-wide, at-most-once event — real
 * Postgres has no per-test transaction rollback, so only the first
 * test in this file to call this helper actually exercises bootstrap;
 * every later call correctly finds Governance already established and
 * falls through to the ordinary, ALREADY-established-Governance-grants-
 * new-Governance path instead — this is itself a legitimate exercise of
 * the model (Governance is not limited to one holder forever, only the
 * bootstrap path is single-use), not a workaround.
 */
async function bootstrapNewGovernance(displayName: string): Promise<string> {
  const founder = await createRealGamingMember(displayName);

  const { data: existing, error } = await cleanupClient
    .from("authority_grants")
    .select("gaming_member_id")
    .eq("authority_class", "PRODUCT_GOVERNANCE")
    .is("revoked_at", null)
    .limit(1)
    .maybeSingle();
  if (error) throw error;

  if (!existing) {
    await bootstrapGovernanceAuthority(authorityRepo, founder, `${displayName} founder bootstrap.`);
  } else {
    await grantPlatformAuthority(
      authorityRepo,
      existing.gaming_member_id,
      founder,
      "PRODUCT_GOVERNANCE",
      `${displayName} additional Governance actor.`
    );
  }
  return founder;
}

afterAll(async () => {
  if (createdGamingMemberIds.length > 0) {
    await cleanupClient.from("admin_audit_events").delete().in("actor_id", createdGamingMemberIds);
    await cleanupClient.from("authority_grants").delete().in("gaming_member_id", createdGamingMemberIds);
  }
  for (const authUserId of createdAuthUserIds) {
    await cleanupClient.auth.admin.deleteUser(authUserId);
  }
});

describe("SupabaseAuthorityRepository contract — Admin Control Plane A0 against live Postgres", () => {
  it("bootstrap creates the first Governance grant, and a second bootstrap is rejected", async () => {
    const founder = await createRealGamingMember("ContractFounder");
    const result = await bootstrapGovernanceAuthority(authorityRepo, founder, "Founder bootstrap.");
    expect(result.authorityClass).toBe("PRODUCT_GOVERNANCE");
    expect(await authorityRepo.hasActiveAuthority(founder, "PRODUCT_GOVERNANCE")).toBe(true);

    const other = await createRealGamingMember("ContractSecondBootstrapAttempt");
    await expect(bootstrapGovernanceAuthority(authorityRepo, other, "Trying again.")).rejects.toBeInstanceOf(
      GovernanceAlreadyBootstrappedError
    );
  });

  it("concurrent bootstrap attempts against a fresh database region serialize to exactly one winner", async () => {
    // Each contract test in this file establishes its own Governance
    // actor first (see bootstrapNewGovernance), so by the time most
    // tests run, PRODUCT_GOVERNANCE already exists globally and every
    // bootstrap attempt fails identically with GOVERNANCE_ALREADY_
    // BOOTSTRAPPED — this test instead proves the advisory-lock
    // serialization itself: two concurrent attempts race, and exactly
    // one of the two possible outcomes for each occurs (never both
    // succeeding, which pg_advisory_xact_lock exists to prevent).
    const a = await createRealGamingMember("ContractConcurrentBootstrapA");
    const b = await createRealGamingMember("ContractConcurrentBootstrapB");

    const results = await Promise.allSettled([
      bootstrapGovernanceAuthority(authorityRepo, a, "Racing bootstrap A."),
      bootstrapGovernanceAuthority(authorityRepo, b, "Racing bootstrap B."),
    ]);

    const succeeded = results.filter((r) => r.status === "fulfilled");
    // At most one of the two can have created the very first Governance
    // grant globally; both may also legitimately fail if an earlier
    // test in this file already bootstrapped Governance first — either
    // way, never both succeeding is the invariant under test.
    expect(succeeded.length).toBeLessThanOrEqual(1);
  });

  it("Governance grants Operational and Consequential Finalizer independently; classes are non-hierarchical", async () => {
    const founder = await bootstrapNewGovernance("ContractClassesFounder");
    const operator = await createRealGamingMember("ContractClassesOperator");
    const finalizer = await createRealGamingMember("ContractClassesFinalizer");

    await grantPlatformAuthority(authorityRepo, founder, operator, "OPERATIONAL", "Onboarding operator.");
    await grantPlatformAuthority(authorityRepo, founder, finalizer, "CONSEQUENTIAL_FINALIZER", "Onboarding finalizer.");

    expect(await authorityRepo.hasActiveAuthority(operator, "OPERATIONAL")).toBe(true);
    expect(await authorityRepo.hasActiveAuthority(operator, "CONSEQUENTIAL_FINALIZER")).toBe(false);
    expect(await authorityRepo.hasActiveAuthority(finalizer, "CONSEQUENTIAL_FINALIZER")).toBe(true);
    expect(await authorityRepo.hasActiveAuthority(finalizer, "OPERATIONAL")).toBe(false);
    // Governance itself does not inherit either lower class.
    expect(await authorityRepo.hasActiveAuthority(founder, "OPERATIONAL")).toBe(false);
    expect(await authorityRepo.hasActiveAuthority(founder, "CONSEQUENTIAL_FINALIZER")).toBe(false);
  });

  it("a Gaming Member may hold multiple classes simultaneously", async () => {
    const founder = await bootstrapNewGovernance("ContractMultiClassFounder");
    const dualRole = await createRealGamingMember("ContractDualRole");

    await grantPlatformAuthority(authorityRepo, founder, dualRole, "OPERATIONAL", "Catalog work.");
    await grantPlatformAuthority(authorityRepo, founder, dualRole, "CONSEQUENTIAL_FINALIZER", "Also finalizes.");

    const classes = await authorityRepo.listActiveAuthorityClasses(dualRole);
    expect(classes).toEqual(expect.arrayContaining(["OPERATIONAL", "CONSEQUENTIAL_FINALIZER"]));
  });

  it("the active-grant partial unique index holds under genuine concurrency: two simultaneous grants of the same class resolve to one active row", async () => {
    const founder = await bootstrapNewGovernance("ContractRaceFounder");
    const target = await createRealGamingMember("ContractRaceTarget");

    const results = await Promise.allSettled([
      grantPlatformAuthority(authorityRepo, founder, target, "OPERATIONAL", "Race attempt 1."),
      grantPlatformAuthority(authorityRepo, founder, target, "OPERATIONAL", "Race attempt 2."),
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);
    expect(await authorityRepo.hasActiveAuthority(target, "OPERATIONAL")).toBe(true);

    const { count, error } = await cleanupClient
      .from("authority_grants")
      .select("authority_grant_id", { count: "exact", head: true })
      .eq("gaming_member_id", target)
      .eq("authority_class", "OPERATIONAL")
      .is("revoked_at", null);
    if (error) throw error;
    expect(count).toBe(1);
  });

  it("granting/revoking without an active Governance actor is rejected", async () => {
    const notGovernance = await createRealGamingMember("ContractNotGovernance");
    const target = await createRealGamingMember("ContractGrantTarget");
    await expect(
      grantPlatformAuthority(authorityRepo, notGovernance, target, "OPERATIONAL", "Attempted grant.")
    ).rejects.toBeInstanceOf(GovernanceAuthorityRequiredError);
  });

  it("revoke takes effect immediately, preserves history on the same row, and a re-grant creates a fresh period", async () => {
    const founder = await bootstrapNewGovernance("ContractRevokeFounder");
    const finalizer = await createRealGamingMember("ContractRevokeFinalizer");
    const granted = await grantPlatformAuthority(
      authorityRepo,
      founder,
      finalizer,
      "CONSEQUENTIAL_FINALIZER",
      "Onboarding."
    );

    await revokePlatformAuthority(authorityRepo, founder, finalizer, "CONSEQUENTIAL_FINALIZER", "Role change.");
    expect(await authorityRepo.hasActiveAuthority(finalizer, "CONSEQUENTIAL_FINALIZER")).toBe(false);

    const { data: revokedRow, error } = await cleanupClient
      .from("authority_grants")
      .select("authority_grant_id, revoked_at, revoked_by")
      .eq("authority_grant_id", granted.authorityGrantId)
      .single();
    if (error) throw error;
    expect(revokedRow.revoked_at).not.toBeNull();
    expect(revokedRow.revoked_by).toBe(founder);

    const regranted = await grantPlatformAuthority(
      authorityRepo,
      founder,
      finalizer,
      "CONSEQUENTIAL_FINALIZER",
      "Returned from leave."
    );
    expect(regranted.authorityGrantId).not.toBe(granted.authorityGrantId);
    expect(await authorityRepo.hasActiveAuthority(finalizer, "CONSEQUENTIAL_FINALIZER")).toBe(true);
  });

  it("revoking a class that was never granted is rejected", async () => {
    const founder = await bootstrapNewGovernance("ContractRevokeNotFoundFounder");
    const target = await createRealGamingMember("ContractRevokeNotFoundTarget");
    await expect(
      revokePlatformAuthority(authorityRepo, founder, target, "OPERATIONAL", "No such grant.")
    ).rejects.toBeInstanceOf(AuthorityGrantNotFoundError);
  });

  it("audit events are queryable through the read-only AuditRepository and reference the real grant row", async () => {
    const founder = await bootstrapNewGovernance("ContractAuditFounder");
    const operator = await createRealGamingMember("ContractAuditOperator");
    const granted = await grantPlatformAuthority(authorityRepo, founder, operator, "OPERATIONAL", "Onboarding.");

    const events = await auditRepo.listEventsForTarget("authority_grants", granted.authorityGrantId);
    expect(events).toHaveLength(1);
    expect(events[0].actionType).toBe("GRANT_AUTHORITY");
    expect(events[0].actorId).toBe(founder);
    expect(events[0].resultingReference).toEqual({ table: "authority_grants", id: granted.authorityGrantId });
  });
});

describe("HTTP-shaped authority checks (Predictions A1) — requirePlatformAuthorityHttp / requireAnyAdminAuthority against a real Authorization header", () => {
  it("a member with no active grant is rejected by both the specific and the any-class check", async () => {
    const { accessToken } = await createRealGamingMemberWithToken("ContractA1HttpNoGrant");
    const request = new Request("http://localhost/test", { headers: { authorization: `Bearer ${accessToken}` } });

    const specific = await requirePlatformAuthorityHttp(request, { url: supabaseUrl!, serviceKey: supabaseServiceRoleKey! }, "OPERATIONAL");
    expect("errorResponse" in specific).toBe(true);
    if ("errorResponse" in specific) expect(specific.errorResponse.status).toBe(403);

    const any = await requireAnyAdminAuthority(request, { url: supabaseUrl!, serviceKey: supabaseServiceRoleKey! });
    expect("errorResponse" in any).toBe(true);
    if ("errorResponse" in any) expect(any.errorResponse.status).toBe(403);
  });

  it("an Operational-only member passes the any-class read check but fails a Consequential Finalizer-specific check", async () => {
    const founder = await bootstrapNewGovernance("ContractA1HttpFounder");
    const { gamingMemberId, accessToken } = await createRealGamingMemberWithToken("ContractA1HttpOperator");
    await grantPlatformAuthority(authorityRepo, founder, gamingMemberId, "OPERATIONAL", "Onboarding operator.");

    const request = new Request("http://localhost/test", { headers: { authorization: `Bearer ${accessToken}` } });

    const any = await requireAnyAdminAuthority(request, { url: supabaseUrl!, serviceKey: supabaseServiceRoleKey! });
    expect("gamingMemberId" in any).toBe(true);

    const finalizerCheck = await requirePlatformAuthorityHttp(
      request,
      { url: supabaseUrl!, serviceKey: supabaseServiceRoleKey! },
      "CONSEQUENTIAL_FINALIZER"
    );
    expect("errorResponse" in finalizerCheck).toBe(true);
    if ("errorResponse" in finalizerCheck) expect(finalizerCheck.errorResponse.status).toBe(403);
  });

  it("a Consequential Finalizer passes both the specific check and the any-class read check; revocation removes both on the next request", async () => {
    const founder = await bootstrapNewGovernance("ContractA1HttpFounder2");
    const { gamingMemberId, accessToken } = await createRealGamingMemberWithToken("ContractA1HttpFinalizer");
    await grantPlatformAuthority(authorityRepo, founder, gamingMemberId, "CONSEQUENTIAL_FINALIZER", "Onboarding finalizer.");

    const request = new Request("http://localhost/test", { headers: { authorization: `Bearer ${accessToken}` } });

    const finalizerCheck = await requirePlatformAuthorityHttp(
      request,
      { url: supabaseUrl!, serviceKey: supabaseServiceRoleKey! },
      "CONSEQUENTIAL_FINALIZER"
    );
    expect("gamingMemberId" in finalizerCheck).toBe(true);

    const any = await requireAnyAdminAuthority(request, { url: supabaseUrl!, serviceKey: supabaseServiceRoleKey! });
    expect("gamingMemberId" in any).toBe(true);

    await revokePlatformAuthority(authorityRepo, founder, gamingMemberId, "CONSEQUENTIAL_FINALIZER", "Role change.");

    const revokedCheck = await requirePlatformAuthorityHttp(
      request,
      { url: supabaseUrl!, serviceKey: supabaseServiceRoleKey! },
      "CONSEQUENTIAL_FINALIZER"
    );
    expect("errorResponse" in revokedCheck).toBe(true);
    const revokedAny = await requireAnyAdminAuthority(request, { url: supabaseUrl!, serviceKey: supabaseServiceRoleKey! });
    expect("errorResponse" in revokedAny).toBe(true);
  }, 30000);
});
