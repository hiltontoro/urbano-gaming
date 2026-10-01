import { randomUUID } from "node:crypto";

import { loadEnv } from "vite";
import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";

import { SupabaseMetagameRepository } from "../lib/gaming/metagame/db/supabaseMetagameRepository";
import { SupabaseGamingRepository } from "../lib/gaming/db/supabaseGamingRepository";
import { recordExperienceSummary } from "../lib/gaming/metagame/recordExperienceSummary";
import { processExperienceSummaryConsequences } from "../lib/gaming/metagame/processExperienceSummaryConsequences";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";

const env = loadEnv("development", process.cwd(), "");
const supabaseUrl = env.SUPABASE_URL;
requireLocalSupabase(supabaseUrl);
const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for contract tests.");
}

const repo = new SupabaseMetagameRepository(supabaseUrl, supabaseServiceRoleKey);
const gamingRepo = new SupabaseGamingRepository(supabaseUrl, supabaseServiceRoleKey);
const cleanupClient = createClient(supabaseUrl, supabaseServiceRoleKey);

const CATEGORY = "METAGAME_CONTRACT_TEST";
const LEADERBOARD_CATEGORY = "METAGAME_LEADERBOARD_CONTRACT_TEST";

const createdAuthUserIds: string[] = [];
const createdGamingMemberIds: string[] = [];

async function createRealGamingMember(displayName: string): Promise<string> {
  const email = `metagame-contract-${randomUUID()}@example.com`;
  const { data, error } = await cleanupClient.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("Failed to create test auth user.");
  createdAuthUserIds.push(data.user.id);
  const member = await gamingRepo.createGamingMember(data.user.id, displayName);
  createdGamingMemberIds.push(member.gamingMemberId);
  return member.gamingMemberId;
}

afterAll(async () => {
  if (createdGamingMemberIds.length > 0) {
    await cleanupClient.from("gaming_xp_events").delete().in("gaming_member_id", createdGamingMemberIds);
    await cleanupClient.from("experience_summaries").delete().in("gaming_member_id", createdGamingMemberIds);
  }
  await cleanupClient.from("gaming_xp_rules").delete().eq("category_key", CATEGORY);
  await cleanupClient.from("gaming_category_participation_policy").delete().eq("category_key", CATEGORY);
  await cleanupClient.from("gaming_xp_rules").delete().eq("category_key", LEADERBOARD_CATEGORY);
  for (const authUserId of createdAuthUserIds) {
    await cleanupClient.auth.admin.deleteUser(authUserId);
  }
});

describe("SupabaseMetagameRepository contract — real Postgres", () => {
  it("is idempotent per (experienceKey, idempotencyKey) against the real unique constraint", async () => {
    const gamingMemberId = await createRealGamingMember("MetagameIdempotency");
    const input = {
      gamingMemberId,
      experienceKey: "METAGAME_CONTRACT",
      categoryKey: CATEGORY,
      activityClassification: "RANKED" as const,
      authorityTier: "ADMIN_FINALIZED" as const,
      occurredAt: new Date().toISOString(),
      finalizedAt: new Date().toISOString(),
      meaningfulParticipation: true, xpEligible: true,
      performanceBandKey: null,
      sourceReference: "idem-1",
      rulesetVersion: "v1",
      supersedesExperienceSummaryId: null,
      idempotencyKey: "idem-1",
      evidence: {},
    };
    const first = await recordExperienceSummary(repo, input);
    const second = await recordExperienceSummary(repo, input);
    expect(second.experienceSummaryId).toBe(first.experienceSummaryId);
    expect(second.alreadyRecorded).toBe(true);
  });

  it("Predictions-v2: correct_dimension_count/correct_dimension_keys round-trip through the real record_experience_summary_atomically RPC and table", async () => {
    const gamingMemberId = await createRealGamingMember("MetagameDimensionFacts");
    const idempotencyKey = `dimfacts-${randomUUID()}`;
    const { experienceSummaryId } = await recordExperienceSummary(repo, {
      gamingMemberId,
      experienceKey: "METAGAME_CONTRACT",
      categoryKey: CATEGORY,
      activityClassification: "RANKED",
      authorityTier: "ADMIN_FINALIZED",
      occurredAt: new Date().toISOString(),
      finalizedAt: new Date().toISOString(),
      meaningfulParticipation: true, xpEligible: true,
      performanceBandKey: "CORRECT_2_OF_4",
      sourceReference: idempotencyKey,
      rulesetVersion: "predictions-v2",
      supersedesExperienceSummaryId: null,
      idempotencyKey,
      evidence: {},
      correctDimensionCount: 2,
      correctDimensionKeys: ["EXACT_SCORELINE", "ANY_GOAL_MINUTE"],
    });
    const summary = await repo.getExperienceSummary(experienceSummaryId);
    expect(summary!.correctDimensionCount).toBe(2);
    expect(summary!.correctDimensionKeys).toEqual(["EXACT_SCORELINE", "ANY_GOAL_MINUTE"]);
  });

  it("Predictions-v2: the real 0095 CHECK constraint rejects a cardinality-inconsistent count/keys pair", async () => {
    const gamingMemberId = await createRealGamingMember("MetagameDimensionFactsInvalid");
    const idempotencyKey = `dimfacts-invalid-${randomUUID()}`;
    await expect(
      recordExperienceSummary(repo, {
        gamingMemberId,
        experienceKey: "METAGAME_CONTRACT",
        categoryKey: CATEGORY,
        activityClassification: "RANKED",
        authorityTier: "ADMIN_FINALIZED",
        occurredAt: new Date().toISOString(),
        finalizedAt: new Date().toISOString(),
        meaningfulParticipation: true, xpEligible: true,
        performanceBandKey: "CORRECT_1_OF_4",
        sourceReference: idempotencyKey,
        rulesetVersion: "predictions-v2",
        supersedesExperienceSummaryId: null,
        idempotencyKey,
        evidence: {},
        // count says 1, but two keys are supplied — the real table CHECK
        // constraint (0095) must reject this, not merely the in-memory
        // mirror's own runtime validation.
        correctDimensionCount: 1,
        correctDimensionKeys: ["EXACT_SCORELINE", "ANY_GOAL_MINUTE"],
      })
    ).rejects.toThrow();
  });

  it("NO CONFIGURATION: zero policy/rule rows against the real database — no error, zero XP events, a valid Summary still records", async () => {
    const gamingMemberId = await createRealGamingMember("MetagameNoPolicy");
    const { experienceSummaryId, alreadyRecorded } = await recordExperienceSummary(repo, {
      gamingMemberId,
      experienceKey: "METAGAME_CONTRACT",
      categoryKey: "METAGAME_CONTRACT_NEVER_CONFIGURED",
      activityClassification: "RANKED",
      authorityTier: "ADMIN_FINALIZED",
      occurredAt: new Date().toISOString(),
      finalizedAt: new Date().toISOString(),
      meaningfulParticipation: true, xpEligible: true,
      performanceBandKey: null,
      sourceReference: "nopolicy-1",
      rulesetVersion: "v1",
      supersedesExperienceSummaryId: null,
      idempotencyKey: "nopolicy-1",
      evidence: {},
    });
    expect(alreadyRecorded).toBe(false);
    // Must not throw — the missing-policy boundary correction: absence
    // of configuration is a valid Product state, not an invalid Result.
    const events = await processExperienceSummaryConsequences(repo, experienceSummaryId);
    expect(events).toHaveLength(0);
  });

  it("PARTIAL CONFIGURATION: policy exists with no PARTICIPATION rule, against the real database — no error, zero XP events", async () => {
    const category = "METAGAME_CONTRACT_POLICY_ONLY";
    await cleanupClient
      .from("gaming_category_participation_policy")
      .insert({ category_key: category, daily_participation_allowance: 10 });

    const gamingMemberId = await createRealGamingMember("MetagamePolicyOnly");
    const { experienceSummaryId } = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "METAGAME_CONTRACT", categoryKey: category,
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt: new Date().toISOString(), finalizedAt: new Date().toISOString(),
      meaningfulParticipation: true, xpEligible: true, performanceBandKey: null,
      sourceReference: "policyonly-1", rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey: "policyonly-1", evidence: {},
    });
    const events = await processExperienceSummaryConsequences(repo, experienceSummaryId);
    expect(events).toHaveLength(0);

    await cleanupClient.from("gaming_category_participation_policy").delete().eq("category_key", category);
  });

  it("America/Tegucigalpa Gaming Day boundary, computed server-side by real Postgres, ignores any client-side notion of timezone", async () => {
    await cleanupClient
      .from("gaming_category_participation_policy")
      .insert({ category_key: CATEGORY, daily_participation_allowance: 1 });
    await cleanupClient
      .from("gaming_xp_rules")
      .insert({ category_key: CATEGORY, consequence_class: "PARTICIPATION", performance_band_key: null, points: 5 });

    const gamingMemberId = await createRealGamingMember("MetagameGamingDay");

    // 05:59 UTC = 2026-... 23:59 America/Tegucigalpa (UTC-6, no DST) — the PRIOR calendar day there.
    const before = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "METAGAME_CONTRACT", categoryKey: CATEGORY,
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt: "2027-03-10T05:59:00.000Z", finalizedAt: "2027-03-10T05:59:00.000Z",
      meaningfulParticipation: true, xpEligible: true, performanceBandKey: null,
      sourceReference: "day-before", rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey: "day-before", evidence: {},
    });
    const beforeEvents = await processExperienceSummaryConsequences(repo, before.experienceSummaryId);
    expect(beforeEvents).toHaveLength(1);

    // 06:01 UTC same date = 00:01 America/Tegucigalpa — a different Gaming Day, so the N=1 allowance is fresh again.
    const after = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "METAGAME_CONTRACT", categoryKey: CATEGORY,
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt: "2027-03-10T06:01:00.000Z", finalizedAt: "2027-03-10T06:01:00.000Z",
      meaningfulParticipation: true, xpEligible: true, performanceBandKey: null,
      sourceReference: "day-after", rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey: "day-after", evidence: {},
    });
    const afterEvents = await processExperienceSummaryConsequences(repo, after.experienceSummaryId);
    expect(afterEvents).toHaveLength(1);
  });

  it("TRAINING produces zero XP events against the real database, regardless of reported facts", async () => {
    await cleanupClient
      .from("gaming_xp_rules")
      .insert({ category_key: CATEGORY, consequence_class: "PERFORMANCE", performance_band_key: "MAX_BAND", points: 100 });
    const gamingMemberId = await createRealGamingMember("MetagameTraining");
    const { experienceSummaryId } = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "METAGAME_CONTRACT", categoryKey: CATEGORY,
      activityClassification: "TRAINING", authorityTier: "ADMIN_FINALIZED",
      occurredAt: new Date().toISOString(), finalizedAt: new Date().toISOString(),
      meaningfulParticipation: true, xpEligible: true, performanceBandKey: "MAX_BAND",
      sourceReference: "training-1", rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey: "training-1", evidence: {},
    });
    const events = await processExperienceSummaryConsequences(repo, experienceSummaryId);
    expect(events).toHaveLength(0);
  });

  it("a rule-value change does not reinterpret an already-awarded event's historical points, against the real database", async () => {
    await cleanupClient
      .from("gaming_xp_rules")
      .insert({ category_key: CATEGORY, consequence_class: "PERFORMANCE", performance_band_key: "VERSIONED_BAND", points: 50 });
    const gamingMemberId = await createRealGamingMember("MetagameRuleVersioning");
    const occurredAt = new Date().toISOString();

    const first = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "METAGAME_CONTRACT", categoryKey: CATEGORY,
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt, finalizedAt: occurredAt, meaningfulParticipation: false, xpEligible: true, performanceBandKey: "VERSIONED_BAND",
      sourceReference: "rv-1", rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey: "rv-1", evidence: {},
    });
    const firstEvents = await processExperienceSummaryConsequences(repo, first.experienceSummaryId);
    expect(firstEvents[0].points).toBe(50);

    await cleanupClient
      .from("gaming_xp_rules")
      .insert({ category_key: CATEGORY, consequence_class: "PERFORMANCE", performance_band_key: "VERSIONED_BAND", points: 999 });

    const { data: stillFifty } = await cleanupClient
      .from("gaming_xp_events")
      .select("points")
      .eq("gaming_xp_event_id", firstEvents[0].gamingXpEventId)
      .single();
    expect(stillFifty!.points).toBe(50);

    // A genuinely NEW instant, after the rule change — resolution is
    // always "as of occurred_at," so this must use a later occurredAt
    // than the first award to legitimately pick up the new rule value.
    // Reusing the same occurredAt would (correctly) still resolve to
    // the original rule, since it wasn't yet in effect at that instant
    // — that is the historical-fidelity guarantee working as intended,
    // not a bug, and reusing it here would prove nothing.
    const laterOccurredAt = new Date(Date.now() + 1000).toISOString();
    const second = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "METAGAME_CONTRACT", categoryKey: CATEGORY,
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt: laterOccurredAt, finalizedAt: laterOccurredAt, meaningfulParticipation: false, xpEligible: true, performanceBandKey: "VERSIONED_BAND",
      sourceReference: "rv-2", rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey: "rv-2", evidence: {},
    });
    const secondEvents = await processExperienceSummaryConsequences(repo, second.experienceSummaryId);
    expect(secondEvents[0].points).toBe(999);
  });

  it("a reversed participation award restores the effective daily allowance, against the real database, without deleting either row", async () => {
    const gamingMemberId = await createRealGamingMember("MetagameReversalRestoresAllowance");
    const occurredAt = new Date().toISOString();

    const original = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "METAGAME_CONTRACT", categoryKey: CATEGORY,
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt, finalizedAt: occurredAt, meaningfulParticipation: true, xpEligible: true, performanceBandKey: null,
      sourceReference: "reversal-1", rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey: "reversal-1", evidence: {},
    });
    await processExperienceSummaryConsequences(repo, original.experienceSummaryId);

    const blocked = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "METAGAME_CONTRACT", categoryKey: CATEGORY,
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt, finalizedAt: occurredAt, meaningfulParticipation: true, xpEligible: true, performanceBandKey: null,
      sourceReference: "reversal-2", rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey: "reversal-2", evidence: {},
    });
    expect(await processExperienceSummaryConsequences(repo, blocked.experienceSummaryId)).toHaveLength(0);

    const correction = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "METAGAME_CONTRACT", categoryKey: CATEGORY,
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt, finalizedAt: new Date().toISOString(), meaningfulParticipation: false, xpEligible: true, performanceBandKey: null,
      sourceReference: "reversal-1-corrected", rulesetVersion: "v1",
      supersedesExperienceSummaryId: original.experienceSummaryId,
      idempotencyKey: "reversal-1-corrected", evidence: {},
    });
    const correctionEvents = await processExperienceSummaryConsequences(repo, correction.experienceSummaryId);
    expect(correctionEvents).toHaveLength(1);
    expect(correctionEvents[0].points).toBeLessThan(0);

    const { data: allEvents } = await cleanupClient
      .from("gaming_xp_events")
      .select("*")
      .eq("gaming_member_id", gamingMemberId);
    expect((allEvents ?? []).length).toBeGreaterThanOrEqual(2); // original + reversal, neither deleted

    const retry = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "METAGAME_CONTRACT", categoryKey: CATEGORY,
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt, finalizedAt: occurredAt, meaningfulParticipation: true, xpEligible: true, performanceBandKey: null,
      sourceReference: "reversal-3", rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey: "reversal-3", evidence: {},
    });
    expect(await processExperienceSummaryConsequences(repo, retry.experienceSummaryId)).toHaveLength(1);
  });

  it("mandatory concurrency correction: two simultaneous consequence-processing calls for the same member/category/day cannot both exceed a N=1 allowance", async () => {
    await cleanupClient
      .from("gaming_category_participation_policy")
      .insert({ category_key: CATEGORY, daily_participation_allowance: 1 });
    await cleanupClient
      .from("gaming_xp_rules")
      .insert({ category_key: CATEGORY, consequence_class: "PARTICIPATION", performance_band_key: null, points: 5 });

    const gamingMemberId = await createRealGamingMember("MetagameConcurrency");
    const occurredAt = new Date().toISOString();

    const summaryA = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "METAGAME_CONTRACT", categoryKey: CATEGORY,
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt, finalizedAt: occurredAt, meaningfulParticipation: true, xpEligible: true, performanceBandKey: null,
      sourceReference: "race-a", rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey: "race-a", evidence: {},
    });
    const summaryB = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "METAGAME_CONTRACT", categoryKey: CATEGORY,
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt, finalizedAt: occurredAt, meaningfulParticipation: true, xpEligible: true, performanceBandKey: null,
      sourceReference: "race-b", rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey: "race-b", evidence: {},
    });

    // Genuinely concurrent — both requests fire against real Postgres at
    // once. The gaming_members row lock inside
    // process_experience_summary_consequences_atomically must serialize
    // these, not merely "usually work" under low contention.
    const [resultA, resultB] = await Promise.all([
      processExperienceSummaryConsequences(repo, summaryA.experienceSummaryId),
      processExperienceSummaryConsequences(repo, summaryB.experienceSummaryId),
    ]);

    const totalAwarded = resultA.length + resultB.length;
    expect(totalAwarded).toBe(1); // exactly one of the two raced participation attempts wins the single N=1 slot

    const { data: xpEvents } = await cleanupClient
      .from("gaming_xp_events")
      .select("*")
      .eq("gaming_member_id", gamingMemberId)
      .eq("category_key", CATEGORY)
      .eq("consequence_class", "PARTICIPATION")
      .gt("points", 0);
    expect(xpEvents).toHaveLength(1); // the allowance was never exceeded despite the race
  }, 30000);
});

describe("Global Gaming XP Leaderboard — real Postgres, get_global_gaming_xp_leaderboard()", () => {
  // The full leaderboard reflects every real Gaming Member/XP event in
  // this database, including ones created by other tests/files sharing
  // it — so every assertion below filters to this describe block's own
  // uniquely-named fixture members and asserts relative facts about
  // just them, never the full returned array or an absolute rank.
  function findEntry(entries: { rank: number; displayName: string; globalXp: number }[], displayName: string) {
    return entries.find((e) => e.displayName === displayName);
  }

  it("aggregates correctly, ranks by competition ranking, and excludes a fully-reversed net-zero member — all in one real read", async () => {
    const alexId = await createRealGamingMember("LB-Contract-Alex");
    const jordanId = await createRealGamingMember("LB-Contract-Jordan");
    const voidedId = await createRealGamingMember("LB-Contract-Voided");

    await cleanupClient
      .from("gaming_xp_rules")
      .insert({ category_key: LEADERBOARD_CATEGORY, consequence_class: "PERFORMANCE", performance_band_key: "TIE_BAND", points: 100 });
    await cleanupClient
      .from("gaming_xp_rules")
      .insert({ category_key: LEADERBOARD_CATEGORY, consequence_class: "PERFORMANCE", performance_band_key: "VOID_BAND", points: 100 });

    const occurredAt = new Date().toISOString();
    async function award(gamingMemberId: string, band: string, key: string) {
      const { experienceSummaryId } = await recordExperienceSummary(repo, {
        gamingMemberId, experienceKey: "LB_CONTRACT", categoryKey: LEADERBOARD_CATEGORY,
        activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
        occurredAt, finalizedAt: occurredAt, meaningfulParticipation: false, xpEligible: true, performanceBandKey: band,
        sourceReference: key, rulesetVersion: "v1", supersedesExperienceSummaryId: null,
        idempotencyKey: key, evidence: {},
      });
      await processExperienceSummaryConsequences(repo, experienceSummaryId);
      return experienceSummaryId;
    }

    // Alex and Jordan tie at 100.
    await award(alexId, "TIE_BAND", `lb-tie-alex-${alexId}`);
    await award(jordanId, "TIE_BAND", `lb-tie-jordan-${jordanId}`);

    // Voided gets +100 then a pure invalidation correction (no new band) -> net 0.
    const original = await award(voidedId, "VOID_BAND", `lb-void-${voidedId}`);
    const correction = await recordExperienceSummary(repo, {
      gamingMemberId: voidedId, experienceKey: "LB_CONTRACT", categoryKey: LEADERBOARD_CATEGORY,
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt, finalizedAt: new Date().toISOString(), meaningfulParticipation: false, xpEligible: true, performanceBandKey: null,
      sourceReference: `lb-void-corrected-${voidedId}`, rulesetVersion: "v1", supersedesExperienceSummaryId: original,
      idempotencyKey: `lb-void-corrected-${voidedId}`, evidence: {},
    });
    await processExperienceSummaryConsequences(repo, correction.experienceSummaryId);

    const entries = await repo.getGlobalLeaderboard();

    const alexEntry = findEntry(entries, "LB-Contract-Alex");
    const jordanEntry = findEntry(entries, "LB-Contract-Jordan");
    const voidedEntry = findEntry(entries, "LB-Contract-Voided");

    expect(alexEntry?.globalXp).toBe(100);
    expect(jordanEntry?.globalXp).toBe(100);
    expect(alexEntry?.rank).toBe(jordanEntry?.rank); // competition ranking: an exact tie shares one rank
    expect(voidedEntry).toBeUndefined(); // net-zero after full reversal — absent, not shown at 0

    // No Gaming Member UUID anywhere in the returned, JSON-serialized shape.
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(alexId);
    expect(serialized).not.toContain(jordanId);
    expect(serialized).not.toContain(voidedId);
  }, 30000);

  it("returns the correct COMPLETE total for a ledger exceeding PostgREST's row cap, where a raw select would silently truncate", async () => {
    const gamingMemberId = await createRealGamingMember("LB-Contract-BigLedger");

    const { data: rule, error: ruleErr } = await cleanupClient
      .from("gaming_xp_rules")
      .insert({ category_key: LEADERBOARD_CATEGORY, consequence_class: "PARTICIPATION", performance_band_key: null, points: 1 })
      .select()
      .single();
    if (ruleErr) throw ruleErr;

    const { data: summary, error: summaryErr } = await cleanupClient
      .from("experience_summaries")
      .insert({
        gaming_member_id: gamingMemberId,
        experience_key: "LB_CONTRACT_BIG",
        category_key: LEADERBOARD_CATEGORY,
        activity_classification: "RANKED",
        authority_tier: "ADMIN_FINALIZED",
        occurred_at: new Date().toISOString(),
        finalized_at: new Date().toISOString(),
        meaningful_participation: true,
        performance_band_key: null,
        source_reference: "lb-big-ledger",
        ruleset_version: "v1",
        idempotency_key: "lb-big-ledger",
      })
      .select()
      .single();
    if (summaryErr) throw summaryErr;

    // 1500 rows, all for this one member, 1 point each — well past
    // PostgREST's configured max_rows (1000 locally; supabase/config.toml).
    const ROW_COUNT = 1500;
    const rows = Array.from({ length: ROW_COUNT }, (_, i) => ({
      gaming_member_id: gamingMemberId,
      category_key: LEADERBOARD_CATEGORY,
      consequence_class: "PARTICIPATION",
      points: 1,
      experience_summary_id: summary.experience_summary_id,
      gaming_xp_rule_id: rule.gaming_xp_rule_id,
      gaming_day: "2027-01-01",
      idempotency_key: `lb-big-ledger-${i}`,
    }));
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const { error: insErr } = await cleanupClient.from("gaming_xp_events").insert(rows.slice(i, i + CHUNK));
      if (insErr) throw insErr;
    }

    // Evidence: a raw, unpaginated select over just this member's rows
    // already silently truncates at PostgREST's row cap.
    const { data: rawRows } = await cleanupClient
      .from("gaming_xp_events")
      .select("points")
      .eq("gaming_member_id", gamingMemberId);
    expect(rawRows!.length).toBeLessThan(ROW_COUNT);
    const naiveSum = rawRows!.reduce((s, r: any) => s + r.points, 0);
    expect(naiveSum).not.toBe(ROW_COUNT); // proves the naive approach would be silently wrong

    // The canonical read model, going through the actual repository
    // under test, must still return the correct COMPLETE total.
    const entries = await repo.getGlobalLeaderboard();
    const bigLedgerEntry = findEntry(entries, "LB-Contract-BigLedger");
    expect(bigLedgerEntry?.globalXp).toBe(ROW_COUNT);
  }, 60000);
});
