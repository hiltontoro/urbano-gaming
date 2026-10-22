import { randomUUID } from "node:crypto";

import { loadEnv } from "vite";
import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { SupabasePredictionsRepository } from "../lib/gaming/predictions/db/supabasePredictionsRepository";
import { SupabaseGamingRepository } from "../lib/gaming/db/supabaseGamingRepository";
import { submitPrediction } from "../lib/gaming/predictions/submitPrediction";
import { redeemPrizeQualification } from "../lib/gaming/predictions/redeemPrizeQualification";
import { cancelMatch } from "../lib/gaming/predictions/adminCatalog";
import {
  InvalidGoalscorerSelectionError,
  InvalidGoalMinuteError,
  MatchCancelledError,
  XpEligibilityLockedError,
  MatchResultEventMinuteInvalidError,
} from "../lib/gaming/predictions/types";
import { SupabaseAuditRepository } from "../lib/gaming/audit/db/supabaseAuditRepository";
import { InsufficientPlatformAuthorityError, ReasonRequiredError } from "../lib/gaming/authority/types";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";
import { finalizeMatchResult, correctMatchResult, currentSaveBase } from "./helpers/predictionsResultFixtures";
import { localSettlementDatabaseUrl, purgeSettlementEvidence } from "./helpers/localSettlementCleanup";

const env = loadEnv("development", process.cwd(), "");
const supabaseUrl = env.SUPABASE_URL;
requireLocalSupabase(supabaseUrl);
const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error(
    "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for contract tests."
  );
}

const settlementDatabaseUrl = localSettlementDatabaseUrl();

const repo = new SupabasePredictionsRepository(supabaseUrl, supabaseServiceRoleKey);
const gamingRepo = new SupabaseGamingRepository(supabaseUrl, supabaseServiceRoleKey);
const cleanupClient = createClient(supabaseUrl, supabaseServiceRoleKey);
const auditRepo = new SupabaseAuditRepository(supabaseUrl, supabaseServiceRoleKey);

const createdAuthUserIds: string[] = [];
const createdGamingMemberIds: string[] = [];
const createdMatchIds: string[] = [];
const createdVenueIds: string[] = [];
const createdTeamIds: string[] = [];

async function createRealGamingMember(displayName: string): Promise<{ authUserId: string; gamingMemberId: string }> {
  const email = `predictions-contract-${randomUUID()}@example.com`;
  const { data, error } = await cleanupClient.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("Failed to create test auth user.");
  createdAuthUserIds.push(data.user.id);
  const member = await gamingRepo.createGamingMember(data.user.id, displayName);
  createdGamingMemberIds.push(member.gamingMemberId);
  return { authUserId: data.user.id, gamingMemberId: member.gamingMemberId };
}

/**
 * Admin Control Plane A0. Direct authority_grants insert, for tests that
 * need an already-authorized Consequential Finalizer and are not
 * themselves proving the grant/revoke workflow.
 */
async function grantFinalizerAuthority(gamingMemberId: string): Promise<void> {
  const { error } = await cleanupClient
    .from("authority_grants")
    .insert({ gaming_member_id: gamingMemberId, authority_class: "CONSEQUENTIAL_FINALIZER" });
  if (error) throw error;
}

/** Two Teams, two Players each — the same minimal proving case used throughout the behavioral suite. */
async function createTeamsAndRoster() {
  const home = await repo.createTeam({ name: `Real Madrid ${randomUUID().slice(0, 8)}` });
  const away = await repo.createTeam({ name: `Barcelona ${randomUUID().slice(0, 8)}` });
  createdTeamIds.push(home.teamId, away.teamId);
  const mbappe = await repo.createPlayer({ teamId: home.teamId, name: "Mbappe" });
  const vini = await repo.createPlayer({ teamId: home.teamId, name: "Vini" });
  const lewa = await repo.createPlayer({ teamId: away.teamId, name: "Lewandowski" });
  return { home, away, mbappe, vini, lewa };
}

/**
 * Saves a draft through the repository directly (no domain-layer
 * validation in front of it), reading the stored draft's digest as the
 * base — what the admin page does after loading. Whether the draft is a
 * first result or a correction is decided by the database.
 */
async function saveDraftDirect(input: {
  matchId: string;
  homeScore: number;
  awayScore: number;
  officialGoalEvents: Array<{ scorerPlayerId: string; minuteRegulation: number; minuteStoppage?: number | null; isOwnGoal?: boolean }>;
  enteredByGamingMemberId: string;
}) {
  return repo.saveDraftMatchResult({ ...input, saveBase: await currentSaveBase(repo, input.matchId) });
}

function futureIso(ms = 3600_000): string {
  return new Date(Date.now() + ms).toISOString();
}

afterAll(async () => {
  // Finalized results, their goal events, evaluations and prize
  // entitlements are immutable through every ordinary path, so teardown
  // removes THIS suite's evidence through a loopback-only superuser
  // connection, scoped to the matches it created.
  await purgeSettlementEvidence(settlementDatabaseUrl, createdMatchIds);

  await cleanupClient
    .from("progression_rule_points")
    .update({ points: 0 })
    .eq("rule_key", "PREDICTION_4_OF_4");
  await cleanupClient
    .from("progression_rule_points")
    .update({ points: 0 })
    .eq("rule_key", "PREDICTION_3_OF_4");

  // Deleted in dependency order (children first) — every FK here is a
  // deliberate plain reference (no ON DELETE CASCADE) for the real
  // schema's own correctness, so this test's own cleanup must respect
  // it explicitly rather than relying on a cascade that doesn't exist.
  for (const matchId of createdMatchIds) {
    const { data: results } = await cleanupClient
      .from("match_results")
      .select("match_result_id")
      .eq("match_id", matchId);
    const matchResultIds = (results ?? []).map((r) => r.match_result_id);

    const { data: predictions } = await cleanupClient
      .from("predictions")
      .select("prediction_id")
      .eq("match_id", matchId);
    const predictionIds = (predictions ?? []).map((p) => p.prediction_id);

    if (predictionIds.length > 0) {
      const { data: evaluations } = await cleanupClient
        .from("evaluations")
        .select("evaluation_id")
        .in("prediction_id", predictionIds);
      const evaluationIds = (evaluations ?? []).map((e) => e.evaluation_id);
      if (evaluationIds.length > 0) {
        await cleanupClient.from("prize_qualifications").delete().in("evaluation_id", evaluationIds);
        await cleanupClient.from("gaming_progression_events").delete().in("evaluation_id", evaluationIds);
      }
      await cleanupClient.from("evaluations").delete().in("prediction_id", predictionIds);
    }
    await cleanupClient.from("gaming_progression_events").delete().eq("match_id", matchId);
    await cleanupClient.from("predictions").delete().eq("match_id", matchId);

    if (matchResultIds.length > 0) {
      await cleanupClient.from("official_goal_events").delete().in("match_result_id", matchResultIds);
    }
    await cleanupClient.from("match_results").delete().eq("match_id", matchId);
    await cleanupClient.from("prize_tiers").delete().in(
      "venue_activation_id",
      (await cleanupClient.from("venue_activations").select("venue_activation_id").eq("match_id", matchId)).data?.map(
        (a) => a.venue_activation_id
      ) ?? []
    );
    await cleanupClient.from("venue_activations").delete().eq("match_id", matchId);
    await cleanupClient.from("matches").delete().eq("match_id", matchId);
  }
  for (const venueId of createdVenueIds) {
    await cleanupClient.from("venues").delete().eq("venue_id", venueId);
  }
  for (const teamId of createdTeamIds) {
    await cleanupClient.from("players").delete().eq("team_id", teamId);
    await cleanupClient.from("teams").delete().eq("team_id", teamId);
  }
  // Persistent Metagame Phase 1: gaming_xp_events/experience_summaries
  // reference gaming_members with no ON DELETE CASCADE (XP is
  // participation evidence, never silently cascade-deleted — see
  // 0088's own migration comment) — deleted explicitly here, in
  // dependency order, before the auth user delete that would otherwise
  // be blocked by that same deliberate FK restriction.
  if (createdGamingMemberIds.length > 0) {
    // Admin Control Plane A0: authority_grants/admin_audit_events also
    // reference gaming_members with no cascade, for the same reason
    // gaming_xp_events/experience_summaries below do not — deleted
    // first, in dependency order.
    await cleanupClient.from("admin_audit_events").delete().in("actor_id", createdGamingMemberIds);
    await cleanupClient.from("authority_grants").delete().in("gaming_member_id", createdGamingMemberIds);
    await cleanupClient.from("gaming_xp_events").delete().in("gaming_member_id", createdGamingMemberIds);
    await cleanupClient.from("experience_summaries").delete().in("gaming_member_id", createdGamingMemberIds);
  }
  await cleanupClient.from("gaming_xp_rules").delete().eq("category_key", "SOCCER_PREDICTIONS");
  await cleanupClient.from("gaming_category_participation_policy").delete().eq("category_key", "SOCCER_PREDICTIONS");

  for (const authUserId of createdAuthUserIds) {
    await cleanupClient.auth.admin.deleteUser(authUserId);
  }
});

describe("SupabasePredictionsRepository contract", () => {
  it("full settlement pipeline against real local Postgres: four independent dimensions, own-goal credit, progression, prize qualification, correction", async () => {
    // progression_rule_points is seeded at 0 for every key by migration
    // 0060 (a genuine "not yet decided" placeholder) — set real,
    // non-zero values here so the compensating-reversal assertion below
    // is meaningful, without asserting anything about what value the
    // founder eventually configures.
    // Persistent Metagame Phase 1: real fixture rows against the real
    // canonical XP ledger tables — never a Product-authorized value,
    // just enough to make the compensating-reversal assertion below
    // meaningful.
    await cleanupClient
      .from("gaming_category_participation_policy")
      .insert({ category_key: "SOCCER_PREDICTIONS", daily_participation_allowance: 1000 });
    await cleanupClient.from("gaming_xp_rules").insert([
      { category_key: "SOCCER_PREDICTIONS", consequence_class: "PARTICIPATION", performance_band_key: null, points: 5 },
      { category_key: "SOCCER_PREDICTIONS", consequence_class: "PERFORMANCE", performance_band_key: "CORRECT_4_OF_4", points: 100 },
      { category_key: "SOCCER_PREDICTIONS", consequence_class: "PERFORMANCE", performance_band_key: "CORRECT_3_OF_4", points: 10 },
    ]);

    const admin = await createRealGamingMember("ContractAdmin");
    await grantFinalizerAuthority(admin.gamingMemberId);
    const alex = await createRealGamingMember("ContractAlex");
    const { home, away, mbappe, vini } = await createTeamsAndRoster();

    const match = await repo.createMatch({
      homeTeamId: home.teamId,
      awayTeamId: away.teamId,
      competition: "Contract Test",
      kickoffAt: futureIso(),
    });
    createdMatchIds.push(match.matchId);
    await repo.setMatchActivityClassification(match.matchId, "RANKED", admin.gamingMemberId, null);
    // XP-eligibility gate (Slice: XP Eligibility / Calibration Support):
    // fixture only, not Product config — without this, the real
    // finalize/correct RPCs now correctly produce zero XP regardless
    // of the fixture rules below.
    await repo.setMatchXpEligibility(match.matchId, true, admin.gamingMemberId, null);

    const venue = await repo.createVenue({
      name: "Contract Venue",
      latitude: 10,
      longitude: 10,
      radiusMeters: 100,
    });
    createdVenueIds.push(venue.venueId);

    const activation = await repo.createVenueActivation({
      matchId: match.matchId,
      venueId: venue.venueId,
    });

    await repo.createPrizeTier({
      venueActivationId: activation.venueActivationId,
      correctDimensionCount: 4,
      prizeLabel: "Jersey",
    });
    await repo.createPrizeTier({
      venueActivationId: activation.venueActivationId,
      correctDimensionCount: 3,
      prizeLabel: "Sticker",
    });

    const prediction = await submitPrediction(repo, {
      matchId: match.matchId,
      gamingMemberId: alex.gamingMemberId,
      venueActivationId: activation.venueActivationId,
      predictedHomeScore: 2,
      predictedAwayScore: 0,
      predictedGoalscorerPlayerId: mbappe.playerId,
      predictedGoalMinuteRegulation: 20, predictedGoalMinuteStoppage: null,
      predictedFirstTeamToScore: "HOME",
      geo: { latitude: 10.0001, longitude: 10.0001, accuracyMeters: 5 },
    });
    expect(prediction.geoEligible).toBe(true);

    const draft = await saveDraftDirect({
      matchId: match.matchId,
      homeScore: 2,
      awayScore: 0,
      officialGoalEvents: [
        { scorerPlayerId: mbappe.playerId, minuteRegulation: 20 },
        { scorerPlayerId: vini.playerId, minuteRegulation: 70 },
      ],
      enteredByGamingMemberId: admin.gamingMemberId,
    });

    const finalizeResult = await finalizeMatchResult(repo, draft.matchResultId, admin.gamingMemberId);
    expect(finalizeResult.alreadyFinalized).toBe(false);

    const evaluation = await repo.getEvaluation(prediction.predictionId, draft.matchResultId);
    expect(evaluation!.scorelineCorrect).toBe(true);
    expect(evaluation!.goalscorerCorrect).toBe(true);
    expect(evaluation!.goalMinuteCorrect).toBe(true);
    expect(evaluation!.firstTeamToScoreCorrect).toBe(true);
    expect(evaluation!.correctDimensionCount).toBe(4);

    const qualification = await repo.getQualificationForEvaluation(evaluation!.evaluationId);
    expect(qualification).not.toBeNull();

    const redeemResult = await redeemPrizeQualification(repo, qualification!.prizeQualificationId, admin.gamingMemberId);
    expect(redeemResult.alreadyRedeemed).toBe(false);

    // Correction: official result was actually 1-0 (Vini's goal disallowed).
    const correctionDraft = await saveDraftDirect({
      matchId: match.matchId,
      homeScore: 1,
      awayScore: 0,
      officialGoalEvents: [{ scorerPlayerId: mbappe.playerId, minuteRegulation: 20 }],
      enteredByGamingMemberId: admin.gamingMemberId,
    });
    const correctionResult = await correctMatchResult(
      repo,
      correctionDraft.matchResultId,
      admin.gamingMemberId,
      "Vini's goal disallowed on video review."
    );
    expect(correctionResult.alreadyFinalized).toBe(false);

    const oldEvaluationStillIntact = await repo.getEvaluation(prediction.predictionId, draft.matchResultId);
    expect(oldEvaluationStillIntact!.correctDimensionCount).toBe(4);

    const newEvaluation = await repo.getEvaluation(prediction.predictionId, correctionDraft.matchResultId);
    // Scoreline now wrong (predicted 2-0, corrected 1-0); goalscorer,
    // goal minute, and first-team-to-score remain correct — 3/4.
    expect(newEvaluation!.correctDimensionCount).toBe(3);

    const oldQualificationAfterCorrection = await repo.getQualificationForEvaluation(evaluation!.evaluationId);
    expect(oldQualificationAfterCorrection!.supersededAt).not.toBeNull();
    expect(oldQualificationAfterCorrection!.redeemedAt).not.toBeNull();

    const newQualification = await repo.getQualificationForEvaluation(newEvaluation!.evaluationId);
    expect(newQualification).not.toBeNull();

    // gaming_progression_events (0061) receives no new writes as of
    // this phase — the canonical Gaming XP ledger is gaming_xp_events,
    // consumed only through the Metagame's own record/process functions,
    // never queried by Predictions directly.
    expect(await repo.listProgressionEventsForMember(alex.gamingMemberId)).toHaveLength(0);

    const { data: xpEvents } = await cleanupClient
      .from("gaming_xp_events")
      .select("*")
      .eq("gaming_member_id", alex.gamingMemberId);
    const netTotal = (xpEvents ?? []).reduce((sum, e) => sum + e.points, 0);
    expect(netTotal).toBe(5 + 10); // participation (5) + corrected 3/4 performance (10)

    const xpReversal = (xpEvents ?? []).find((e) => e.reverses_gaming_xp_event_id !== null);
    expect(xpReversal).toBeDefined();
    expect(xpReversal!.points).toBe(-100);
    expect(xpReversal!.consequence_class).toBe("PERFORMANCE");

    const participationEvents = (xpEvents ?? []).filter((e) => e.consequence_class === "PARTICIPATION");
    expect(participationEvents).toHaveLength(1); // preserved, never reversed by an ordinary correctness correction
  }, 30000);

  it("an own goal credits the opposing Team for First Team to Score, evaluated against the real database", async () => {
    const admin = await createRealGamingMember("ContractOwnGoalAdmin");
    await grantFinalizerAuthority(admin.gamingMemberId);
    const alex = await createRealGamingMember("ContractOwnGoalAlex");
    const { home, away, vini } = await createTeamsAndRoster();

    const match = await repo.createMatch({
      homeTeamId: home.teamId,
      awayTeamId: away.teamId,
      competition: "Contract Test",
      kickoffAt: futureIso(),
    });
    createdMatchIds.push(match.matchId);
    await repo.setMatchActivityClassification(match.matchId, "RANKED", admin.gamingMemberId, null);

    const venue = await repo.createVenue({ name: "Own Goal Venue", latitude: 10, longitude: 10, radiusMeters: 100 });
    createdVenueIds.push(venue.venueId);
    const activation = await repo.createVenueActivation({ matchId: match.matchId, venueId: venue.venueId });

    // Vini plays for Home; an own goal by Vini must credit AWAY.
    const prediction = await submitPrediction(repo, {
      matchId: match.matchId,
      gamingMemberId: alex.gamingMemberId,
      venueActivationId: activation.venueActivationId,
      predictedHomeScore: 0,
      predictedAwayScore: 1,
      predictedGoalscorerPlayerId: null,
      predictedGoalMinuteRegulation: null, predictedGoalMinuteStoppage: null,
      predictedFirstTeamToScore: "AWAY",
      geo: { latitude: 10.0001, longitude: 10.0001, accuracyMeters: 5 },
    });

    const draft = await saveDraftDirect({
      matchId: match.matchId,
      homeScore: 0,
      awayScore: 1,
      officialGoalEvents: [{ scorerPlayerId: vini.playerId, minuteRegulation: 30, isOwnGoal: true }],
      enteredByGamingMemberId: admin.gamingMemberId,
    });
    await finalizeMatchResult(repo, draft.matchResultId, admin.gamingMemberId);

    const evaluation = await repo.getEvaluation(prediction.predictionId, draft.matchResultId);
    expect(evaluation!.firstTeamToScoreCorrect).toBe(true);
  }, 30000);

  it("rejects a goalscorer who does not belong to either Match Team via the real database check", async () => {
    const alex = await createRealGamingMember("ContractRosterMismatch");
    const admin = await createRealGamingMember("ContractRosterMismatchAdmin");
    await grantFinalizerAuthority(admin.gamingMemberId);
    const { home, away } = await createTeamsAndRoster();
    const outsiderTeam = await repo.createTeam({ name: `Outsiders ${randomUUID().slice(0, 8)}` });
    createdTeamIds.push(outsiderTeam.teamId);
    const outsider = await repo.createPlayer({ teamId: outsiderTeam.teamId, name: "Outsider" });

    const match = await repo.createMatch({
      homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Contract Test", kickoffAt: futureIso(),
    });
    createdMatchIds.push(match.matchId);
    await repo.setMatchActivityClassification(match.matchId, "RANKED", admin.gamingMemberId, null);
    const venue = await repo.createVenue({ name: "V", latitude: 10, longitude: 10, radiusMeters: 100 });
    createdVenueIds.push(venue.venueId);
    const activation = await repo.createVenueActivation({ matchId: match.matchId, venueId: venue.venueId });

    await expect(
      submitPrediction(repo, {
        matchId: match.matchId,
        gamingMemberId: alex.gamingMemberId,
        venueActivationId: activation.venueActivationId,
        predictedHomeScore: 1,
        predictedAwayScore: 0,
        predictedGoalscorerPlayerId: outsider.playerId,
        predictedGoalMinuteRegulation: 1, predictedGoalMinuteStoppage: null,
        predictedFirstTeamToScore: "HOME",
        geo: { latitude: 10.0001, longitude: 10.0001, accuracyMeters: 5 },
      })
    ).rejects.toBeInstanceOf(InvalidGoalscorerSelectionError);
  });

  // The former "admin authority" test against requireGamingAdmin/
  // gaming_admins was retired in Predictions A1 — every admin route now
  // uses requirePlatformAuthorityHttp/requireAnyAdminAuthority against
  // authority_grants; see __tests__/adminAuthoritySupabaseRepository.
  // contract.test.ts's "HTTP-shaped authority checks" block for the
  // equivalent non-authorized-rejected / authorized-accepted /
  // revocation-immediate coverage against a real Authorization header.

  // --- PREDICTIONS-V2 -------------------------------------------------

  it("Predictions-v2: an invalid Goal-Time shape (stoppage without a 45/90 base) is rejected by the real database CHECK constraint", async () => {
    const alex = await createRealGamingMember("ContractGoalTimeInvalid");
    const admin = await createRealGamingMember("ContractGoalTimeInvalidAdmin");
    await grantFinalizerAuthority(admin.gamingMemberId);
    const { home, away } = await createTeamsAndRoster();
    const match = await repo.createMatch({
      homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Contract Test", kickoffAt: futureIso(),
    });
    createdMatchIds.push(match.matchId);
    await repo.setMatchActivityClassification(match.matchId, "RANKED", admin.gamingMemberId, null);
    const venue = await repo.createVenue({ name: "V", latitude: 10, longitude: 10, radiusMeters: 100 });
    createdVenueIds.push(venue.venueId);
    const activation = await repo.createVenueActivation({ matchId: match.matchId, venueId: venue.venueId });

    await expect(
      submitPrediction(repo, {
        matchId: match.matchId,
        gamingMemberId: alex.gamingMemberId,
        venueActivationId: activation.venueActivationId,
        predictedHomeScore: 1,
        predictedAwayScore: 0,
        predictedGoalscorerPlayerId: null,
        predictedGoalMinuteRegulation: 46, predictedGoalMinuteStoppage: 1,
        predictedFirstTeamToScore: null,
        geo: { latitude: 10.0001, longitude: 10.0001, accuracyMeters: 5 },
      })
    ).rejects.toBeInstanceOf(InvalidGoalMinuteError);
  }, 30000);

  it("Predictions-v2 acceptance gate (0100): a non-boundary official stoppage tuple (46, 1) is rejected by the save function AND by the real official_goal_events CHECK constraint", async () => {
    const admin = await createRealGamingMember("ContractOfficialBoundaryInvalid");
    await grantFinalizerAuthority(admin.gamingMemberId);
    const { home, away, mbappe } = await createTeamsAndRoster();
    const match = await repo.createMatch({
      homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Contract Test", kickoffAt: futureIso(),
    });
    createdMatchIds.push(match.matchId);
    await repo.setMatchActivityClassification(match.matchId, "RANKED", admin.gamingMemberId, null);

    // Through the repository directly (bypassing adminCatalog's own
    // guard): the atomic save validates the tuple before it writes.
    await expect(
      saveDraftDirect({
        matchId: match.matchId,
        homeScore: 1,
        awayScore: 0,
        officialGoalEvents: [{ scorerPlayerId: mbappe.playerId, minuteRegulation: 46, minuteStoppage: 1 }],
        enteredByGamingMemberId: admin.gamingMemberId,
      })
    ).rejects.toBeInstanceOf(MatchResultEventMinuteInvalidError);
    expect(await repo.getDraftMatchResult(match.matchId)).toBeNull();

    // The table CHECK constraint (0100) is the independent backstop: a
    // privileged direct insert of the same tuple into a real draft is
    // still refused by the constraint itself.
    const draft = await saveDraftDirect({
      matchId: match.matchId, homeScore: 0, awayScore: 0, officialGoalEvents: [],
      enteredByGamingMemberId: admin.gamingMemberId,
    });
    const direct = new Client({ connectionString: settlementDatabaseUrl, statement_timeout: 20000 });
    await direct.connect();
    try {
      await expect(
        direct.query(
          `insert into official_goal_events (match_result_id, scorer_player_id, minute_regulation, minute_stoppage, is_own_goal, ordinal)
           values ($1, $2, 46, 1, false, 1)`,
          [draft.matchResultId, mbappe.playerId]
        )
      ).rejects.toThrow(/official_goal_events_minute_stoppage_requires_boundary/);
    } finally {
      await direct.end();
    }
  }, 30000);

  it("Predictions-v2 acceptance gate (0100): legal period-boundary stoppage tuples, including extra-time (105, 120), are accepted by the real database", async () => {
    const admin = await createRealGamingMember("ContractOfficialBoundaryValid");
    await grantFinalizerAuthority(admin.gamingMemberId);
    const { home, away, mbappe } = await createTeamsAndRoster();
    const match = await repo.createMatch({
      homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Contract Test", kickoffAt: futureIso(),
    });
    createdMatchIds.push(match.matchId);
    await repo.setMatchActivityClassification(match.matchId, "RANKED", admin.gamingMemberId, null);

    const draft = await saveDraftDirect({
      matchId: match.matchId,
      // Regulation score: only the 45+2 and 90+7 goals count; the
      // 105+1 and 120+3 goals are extra-time evidence.
      homeScore: 2,
      awayScore: 0,
      officialGoalEvents: [
        { scorerPlayerId: mbappe.playerId, minuteRegulation: 45, minuteStoppage: 2 },
        { scorerPlayerId: mbappe.playerId, minuteRegulation: 90, minuteStoppage: 7 },
        { scorerPlayerId: mbappe.playerId, minuteRegulation: 105, minuteStoppage: 1 },
        { scorerPlayerId: mbappe.playerId, minuteRegulation: 120, minuteStoppage: 3 },
      ],
      enteredByGamingMemberId: admin.gamingMemberId,
    });
    const events = await repo.listGoalEventsForResult(draft.matchResultId);
    expect(events).toHaveLength(4);
  }, 30000);

  it("Predictions-v2: structural Goal Minute comparison distinguishes ordinary 46 from the true (45, stoppage 1) pair against real Postgres", async () => {
    const admin = await createRealGamingMember("ContractStoppageAdmin");
    await grantFinalizerAuthority(admin.gamingMemberId);
    const ordinaryGuesser = await createRealGamingMember("ContractStoppageOrdinary");
    const stoppageGuesser = await createRealGamingMember("ContractStoppageExact");
    const { home, away, mbappe } = await createTeamsAndRoster();

    const match = await repo.createMatch({
      homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Contract Test", kickoffAt: futureIso(),
    });
    createdMatchIds.push(match.matchId);
    await repo.setMatchActivityClassification(match.matchId, "RANKED", admin.gamingMemberId, null);
    const venue = await repo.createVenue({ name: "Stoppage Venue", latitude: 10, longitude: 10, radiusMeters: 100 });
    createdVenueIds.push(venue.venueId);
    const activation = await repo.createVenueActivation({ matchId: match.matchId, venueId: venue.venueId });
    const geo = { latitude: 10.0001, longitude: 10.0001, accuracyMeters: 5 };

    const ordinaryPrediction = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: ordinaryGuesser.gamingMemberId, venueActivationId: activation.venueActivationId,
      predictedHomeScore: 1, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: null, predictedGoalMinuteRegulation: 46, predictedGoalMinuteStoppage: null,
      predictedFirstTeamToScore: null, geo,
    });
    const stoppagePrediction = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: stoppageGuesser.gamingMemberId, venueActivationId: activation.venueActivationId,
      predictedHomeScore: 1, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: null, predictedGoalMinuteRegulation: 45, predictedGoalMinuteStoppage: 1,
      predictedFirstTeamToScore: null, geo,
    });

    // The one real official goal is genuinely first-half stoppage:
    // (45, stoppage 1) — summed elapsed minute 46, the exact collision
    // the old flattened `predicted_goal_minute` scheme could not see.
    const draft = await saveDraftDirect({
      matchId: match.matchId, homeScore: 1, awayScore: 0,
      officialGoalEvents: [{ scorerPlayerId: mbappe.playerId, minuteRegulation: 45, minuteStoppage: 1 }],
      enteredByGamingMemberId: admin.gamingMemberId,
    });
    await finalizeMatchResult(repo, draft.matchResultId, admin.gamingMemberId);

    const ordinaryEvaluation = await repo.getEvaluation(ordinaryPrediction.predictionId, draft.matchResultId);
    expect(ordinaryEvaluation!.goalMinuteCorrect).toBe(false);

    const stoppageEvaluation = await repo.getEvaluation(stoppagePrediction.predictionId, draft.matchResultId);
    expect(stoppageEvaluation!.goalMinuteCorrect).toBe(true);
  }, 30000);

  it("Predictions-v2: an own goal is excluded from Any Goalscorer but included for Any Goal Minute against real Postgres", async () => {
    const admin = await createRealGamingMember("ContractOwnGoalDimensionsAdmin");
    await grantFinalizerAuthority(admin.gamingMemberId);
    const alex = await createRealGamingMember("ContractOwnGoalDimensionsAlex");
    const { home, away, vini } = await createTeamsAndRoster();

    const match = await repo.createMatch({
      homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Contract Test", kickoffAt: futureIso(),
    });
    createdMatchIds.push(match.matchId);
    await repo.setMatchActivityClassification(match.matchId, "RANKED", admin.gamingMemberId, null);
    const venue = await repo.createVenue({ name: "Own Goal Dimensions Venue", latitude: 10, longitude: 10, radiusMeters: 100 });
    createdVenueIds.push(venue.venueId);
    const activation = await repo.createVenueActivation({ matchId: match.matchId, venueId: venue.venueId });

    const prediction = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: alex.gamingMemberId, venueActivationId: activation.venueActivationId,
      predictedHomeScore: 0, predictedAwayScore: 1,
      predictedGoalscorerPlayerId: vini.playerId, predictedGoalMinuteRegulation: 30, predictedGoalMinuteStoppage: null,
      predictedFirstTeamToScore: "AWAY",
      geo: { latitude: 10.0001, longitude: 10.0001, accuracyMeters: 5 },
    });

    const draft = await saveDraftDirect({
      matchId: match.matchId, homeScore: 0, awayScore: 1,
      officialGoalEvents: [{ scorerPlayerId: vini.playerId, minuteRegulation: 30, isOwnGoal: true }],
      enteredByGamingMemberId: admin.gamingMemberId,
    });
    await finalizeMatchResult(repo, draft.matchResultId, admin.gamingMemberId);

    const evaluation = await repo.getEvaluation(prediction.predictionId, draft.matchResultId);
    expect(evaluation!.goalscorerCorrect).toBe(false); // Vini's own goal does not satisfy predicting Vini as scorer
    expect(evaluation!.goalMinuteCorrect).toBe(true); // the same own goal DOES satisfy the matching minute
    expect(evaluation!.firstTeamToScoreCorrect).toBe(true); // credits AWAY, the receiving side
  }, 30000);

  it("Predictions-v2: a cancelled Match cannot be finalized against real Postgres, and produces zero Evaluation rows", async () => {
    const admin = await createRealGamingMember("ContractCancelledAdmin");
    await grantFinalizerAuthority(admin.gamingMemberId);
    const alex = await createRealGamingMember("ContractCancelledAlex");
    const { home, away, mbappe } = await createTeamsAndRoster();

    const match = await repo.createMatch({
      homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Contract Test", kickoffAt: futureIso(),
    });
    createdMatchIds.push(match.matchId);
    await repo.setMatchActivityClassification(match.matchId, "RANKED", admin.gamingMemberId, null);
    const venue = await repo.createVenue({ name: "Cancelled Venue", latitude: 10, longitude: 10, radiusMeters: 100 });
    createdVenueIds.push(venue.venueId);
    const activation = await repo.createVenueActivation({ matchId: match.matchId, venueId: venue.venueId });

    const prediction = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: alex.gamingMemberId, venueActivationId: activation.venueActivationId,
      predictedHomeScore: 1, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: mbappe.playerId, predictedGoalMinuteRegulation: 10, predictedGoalMinuteStoppage: null,
      predictedFirstTeamToScore: "HOME",
      geo: { latitude: 10.0001, longitude: 10.0001, accuracyMeters: 5 },
    });

    const draft = await saveDraftDirect({
      matchId: match.matchId, homeScore: 1, awayScore: 0,
      officialGoalEvents: [{ scorerPlayerId: mbappe.playerId, minuteRegulation: 10 }],
      enteredByGamingMemberId: admin.gamingMemberId,
    });

    await cancelMatch(repo, match.matchId);

    await expect(finalizeMatchResult(repo, draft.matchResultId, admin.gamingMemberId)).rejects.toBeInstanceOf(
      MatchCancelledError
    );

    const evaluation = await repo.getEvaluation(prediction.predictionId, draft.matchResultId);
    expect(evaluation).toBeNull();
  }, 30000);

  // --- XP ELIGIBILITY / CALIBRATION SUPPORT ----------------------------

  it("XP eligibility: declaration succeeds pre-evidence, locks after a Prediction exists, and rejects a change against the real database", async () => {
    const alex = await createRealGamingMember("ContractXpEligLock");
    const admin = await createRealGamingMember("ContractXpEligLockAdmin");
    await grantFinalizerAuthority(admin.gamingMemberId);
    const { home, away } = await createTeamsAndRoster();
    const match = await repo.createMatch({
      homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Contract Test", kickoffAt: futureIso(),
    });
    createdMatchIds.push(match.matchId);
    await repo.setMatchActivityClassification(match.matchId, "RANKED", admin.gamingMemberId, null);

    const fetchedBeforeDeclaration = await repo.getMatchById(match.matchId);
    expect(fetchedBeforeDeclaration!.xpEligible).toBeNull();

    const declared = await repo.setMatchXpEligibility(match.matchId, true, admin.gamingMemberId, null);
    expect(declared).toEqual({ matchId: match.matchId, xpEligible: true, locked: false });

    const venue = await repo.createVenue({ name: "V", latitude: 10, longitude: 10, radiusMeters: 100 });
    createdVenueIds.push(venue.venueId);
    const activation = await repo.createVenueActivation({ matchId: match.matchId, venueId: venue.venueId });

    await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: alex.gamingMemberId, venueActivationId: activation.venueActivationId,
      predictedHomeScore: 0, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: null, predictedGoalMinuteRegulation: null, predictedGoalMinuteStoppage: null,
      predictedFirstTeamToScore: null,
      geo: { latitude: 10.0001, longitude: 10.0001, accuracyMeters: 5 },
    });

    // Idempotent redeclaration of the now-locked value succeeds.
    const redeclared = await repo.setMatchXpEligibility(match.matchId, true, admin.gamingMemberId, null);
    expect(redeclared).toEqual({ matchId: match.matchId, xpEligible: true, locked: true });

    // A change is rejected by the real database.
    await expect(
      repo.setMatchXpEligibility(match.matchId, false, admin.gamingMemberId, null)
    ).rejects.toBeInstanceOf(XpEligibilityLockedError);
  }, 30000);

  it("XP eligibility: a non-eligible Match produces zero XP against the real database even with real fixture policy/rules configured; an eligible Match produces the applicable XP, and the Summary round-trips the fact", async () => {
    await cleanupClient
      .from("gaming_category_participation_policy")
      .insert({ category_key: "SOCCER_PREDICTIONS", daily_participation_allowance: 1000 });
    await cleanupClient
      .from("gaming_xp_rules")
      .insert({ category_key: "SOCCER_PREDICTIONS", consequence_class: "PARTICIPATION", performance_band_key: null, points: 5 });

    const admin = await createRealGamingMember("ContractXpEligAdmin");
    await grantFinalizerAuthority(admin.gamingMemberId);
    const eligibleMember = await createRealGamingMember("ContractXpEligYes");
    const noneligibleMember = await createRealGamingMember("ContractXpEligNo");
    const { home, away, mbappe } = await createTeamsAndRoster();

    async function setupMatch(xpEligible: boolean) {
      const match = await repo.createMatch({
        homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Contract Test", kickoffAt: futureIso(),
      });
      createdMatchIds.push(match.matchId);
      await repo.setMatchActivityClassification(match.matchId, "RANKED", admin.gamingMemberId, null);
      await repo.setMatchXpEligibility(match.matchId, xpEligible, admin.gamingMemberId, null);
      const venue = await repo.createVenue({ name: "V", latitude: 10, longitude: 10, radiusMeters: 100 });
      createdVenueIds.push(venue.venueId);
      const activation = await repo.createVenueActivation({ matchId: match.matchId, venueId: venue.venueId });
      return { match, activation };
    }

    const eligible = await setupMatch(true);
    const noneligible = await setupMatch(false);

    // Deliberately a fully-wrong (0/4) prediction against a real
    // scoreless (0-0) Result: this file has other tests that leave
    // standing PERFORMANCE rule fixtures for CORRECT_3_OF_4/CORRECT_4_OF_4
    // in this same shared SOCCER_PREDICTIONS category — a correct
    // prediction here would non-deterministically pick up one of those
    // and defeat this test's own PARTICIPATION-only point. 0/4 has no
    // fixture rule anywhere in this file, so only PARTICIPATION (this
    // test's own rule, 5 points) can possibly fire.
    const eligiblePrediction = await submitPrediction(repo, {
      matchId: eligible.match.matchId, gamingMemberId: eligibleMember.gamingMemberId,
      venueActivationId: eligible.activation.venueActivationId,
      predictedHomeScore: 1, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: mbappe.playerId, predictedGoalMinuteRegulation: 10, predictedGoalMinuteStoppage: null,
      predictedFirstTeamToScore: "HOME",
      geo: { latitude: 10.0001, longitude: 10.0001, accuracyMeters: 5 },
    });
    const noneligiblePrediction = await submitPrediction(repo, {
      matchId: noneligible.match.matchId, gamingMemberId: noneligibleMember.gamingMemberId,
      venueActivationId: noneligible.activation.venueActivationId,
      predictedHomeScore: 1, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: mbappe.playerId, predictedGoalMinuteRegulation: 10, predictedGoalMinuteStoppage: null,
      predictedFirstTeamToScore: "HOME",
      geo: { latitude: 10.0001, longitude: 10.0001, accuracyMeters: 5 },
    });

    const eligibleDraft = await saveDraftDirect({
      matchId: eligible.match.matchId, homeScore: 0, awayScore: 0, officialGoalEvents: [],
      enteredByGamingMemberId: admin.gamingMemberId,
    });
    await finalizeMatchResult(repo, eligibleDraft.matchResultId, admin.gamingMemberId);
    const noneligibleDraft = await saveDraftDirect({
      matchId: noneligible.match.matchId, homeScore: 0, awayScore: 0, officialGoalEvents: [],
      enteredByGamingMemberId: admin.gamingMemberId,
    });
    await finalizeMatchResult(repo, noneligibleDraft.matchResultId, admin.gamingMemberId);

    const eligibleEvaluation = await repo.getEvaluation(eligiblePrediction.predictionId, eligibleDraft.matchResultId);
    const eligibleSummary = await cleanupClient
      .from("experience_summaries")
      .select("xp_eligible")
      .eq("experience_key", "SOCCER_PREDICTIONS")
      .eq("idempotency_key", eligibleEvaluation!.evaluationId)
      .single();
    expect(eligibleSummary.data!.xp_eligible).toBe(true);

    const noneligibleEvaluation = await repo.getEvaluation(noneligiblePrediction.predictionId, noneligibleDraft.matchResultId);
    const noneligibleSummary = await cleanupClient
      .from("experience_summaries")
      .select("xp_eligible")
      .eq("experience_key", "SOCCER_PREDICTIONS")
      .eq("idempotency_key", noneligibleEvaluation!.evaluationId)
      .single();
    expect(noneligibleSummary.data!.xp_eligible).toBe(false);

    const { data: eligibleEvents } = await cleanupClient
      .from("gaming_xp_events")
      .select("*")
      .eq("gaming_member_id", eligibleMember.gamingMemberId);
    expect(eligibleEvents).toHaveLength(1);
    expect(eligibleEvents![0].points).toBe(5);

    const { data: noneligibleEvents } = await cleanupClient
      .from("gaming_xp_events")
      .select("*")
      .eq("gaming_member_id", noneligibleMember.gamingMemberId);
    expect(noneligibleEvents).toHaveLength(0);
    // gaming_xp_rules / gaming_category_participation_policy for
    // SOCCER_PREDICTIONS are cleaned up by this file's own shared
    // afterAll, not here — an earlier test in this same file (the full
    // settlement pipeline) already inserted its own gaming_xp_events
    // referencing the same category's rule rows, so deleting those
    // rules mid-suite would risk a foreign key violation against that
    // still-standing evidence.
  }, 30000);
});

async function setupFinalizableMatch(displayNamePrefix: string) {
  const admin = await createRealGamingMember(`${displayNamePrefix}Admin`);
  await grantFinalizerAuthority(admin.gamingMemberId);
  const member = await createRealGamingMember(`${displayNamePrefix}Member`);
  const { home, away, mbappe, vini } = await createTeamsAndRoster();

  const match = await repo.createMatch({
    homeTeamId: home.teamId,
    awayTeamId: away.teamId,
    competition: "Contract Test — A0",
    kickoffAt: futureIso(),
  });
  createdMatchIds.push(match.matchId);
  await repo.setMatchActivityClassification(match.matchId, "RANKED", admin.gamingMemberId, null);
  await repo.setMatchXpEligibility(match.matchId, true, admin.gamingMemberId, null);

  const venue = await repo.createVenue({ name: "A0 Contract Venue", latitude: 10, longitude: 10, radiusMeters: 100 });
  createdVenueIds.push(venue.venueId);
  const activation = await repo.createVenueActivation({ matchId: match.matchId, venueId: venue.venueId });

  await submitPrediction(repo, {
    matchId: match.matchId,
    gamingMemberId: member.gamingMemberId,
    venueActivationId: activation.venueActivationId,
    predictedHomeScore: 0,
    predictedAwayScore: 0,
    predictedGoalscorerPlayerId: null,
    predictedGoalMinuteRegulation: null,
    predictedGoalMinuteStoppage: null,
    predictedFirstTeamToScore: null,
    geo: { latitude: 10.0001, longitude: 10.0001, accuracyMeters: 5 },
  });

  return { admin, match, mbappe, vini };
}

describe("SupabasePredictionsRepository contract — Admin Control Plane A0 First Consequential Integration against live Postgres", () => {
  it("finalize without Consequential Finalizer authority is rejected at the RPC layer itself, not merely by the TS wrapper", async () => {
    const notFinalizer = await createRealGamingMember("ContractA0NotFinalizer");
    const { match } = await setupFinalizableMatch("ContractA0Unauthorized");
    const draft = await saveDraftDirect({
      matchId: match.matchId,
      homeScore: 0,
      awayScore: 0,
      officialGoalEvents: [],
      enteredByGamingMemberId: notFinalizer.gamingMemberId,
    });
    // Calls the repository directly, bypassing the finalizeMatchResult
    // TS command wrapper entirely, to prove enforcement lives at the
    // RPC — the true, unbypassable boundary — not only in TypeScript.
    await expect(
      repo.finalizeMatchResult(draft.matchResultId, notFinalizer.gamingMemberId, null, draft.contentDigest)
    ).rejects.toBeInstanceOf(
      InsufficientPlatformAuthorityError
    );
  });

  it("finalize persists the acting Consequential Finalizer's identity onto match_results", async () => {
    const { admin, match } = await setupFinalizableMatch("ContractA0Finalize");
    const draft = await saveDraftDirect({
      matchId: match.matchId,
      homeScore: 0,
      awayScore: 0,
      officialGoalEvents: [],
      enteredByGamingMemberId: admin.gamingMemberId,
    });
    await finalizeMatchResult(repo, draft.matchResultId, admin.gamingMemberId, "Confirmed via official broadcast.");

    const stored = await repo.getMatchResultById(draft.matchResultId);
    expect(stored!.finalizedByGamingMemberId).toBe(admin.gamingMemberId);

    const events = await auditRepo.listEventsForTarget("match_results", draft.matchResultId);
    const finalizeEvents = events.filter((e) => e.actionType === "FINALIZE_RESULT");
    expect(finalizeEvents).toHaveLength(1);
    expect(finalizeEvents[0].actorId).toBe(admin.gamingMemberId);
    expect(finalizeEvents[0].authorityClassUsed).toBe("CONSEQUENTIAL_FINALIZER");
    expect(finalizeEvents[0].resultingReference).toEqual({ table: "match_results", id: draft.matchResultId });
    expect(finalizeEvents[0].reason).toBe("Confirmed via official broadcast.");
  });

  it("correction without a reason is rejected at the RPC layer itself, before any mutation", async () => {
    const { admin, match, mbappe } = await setupFinalizableMatch("ContractA0NoReason");
    const draft = await saveDraftDirect({
      matchId: match.matchId,
      homeScore: 1,
      awayScore: 0,
      officialGoalEvents: [{ scorerPlayerId: mbappe.playerId, minuteRegulation: 10 }],
      enteredByGamingMemberId: admin.gamingMemberId,
    });
    await finalizeMatchResult(repo, draft.matchResultId, admin.gamingMemberId);

    const correctionDraft = await saveDraftDirect({
      matchId: match.matchId,
      homeScore: 2,
      awayScore: 0,
      officialGoalEvents: [
        { scorerPlayerId: mbappe.playerId, minuteRegulation: 10 },
        { scorerPlayerId: mbappe.playerId, minuteRegulation: 60 },
      ],
      enteredByGamingMemberId: admin.gamingMemberId,
    });

    // Calls the repository directly, bypassing correctMatchResult's own
    // TS-level reason check, to prove the RPC enforces it independently.
    await expect(
      repo.correctMatchResult(correctionDraft.matchResultId, admin.gamingMemberId, "", correctionDraft.contentDigest)
    ).rejects.toBeInstanceOf(
      ReasonRequiredError
    );

    const stillDraft = await repo.getMatchResultById(correctionDraft.matchResultId);
    expect(stillDraft!.finalizedAt).toBeNull();
  });

  it("correction persists the corrector's identity and produces one CORRECT_RESULT event referencing both Result versions", async () => {
    const { admin, match, mbappe } = await setupFinalizableMatch("ContractA0Correct");
    const draft = await saveDraftDirect({
      matchId: match.matchId,
      homeScore: 1,
      awayScore: 0,
      officialGoalEvents: [{ scorerPlayerId: mbappe.playerId, minuteRegulation: 10 }],
      enteredByGamingMemberId: admin.gamingMemberId,
    });
    await finalizeMatchResult(repo, draft.matchResultId, admin.gamingMemberId);

    const correctionDraft = await saveDraftDirect({
      matchId: match.matchId,
      homeScore: 2,
      awayScore: 0,
      officialGoalEvents: [
        { scorerPlayerId: mbappe.playerId, minuteRegulation: 10 },
        { scorerPlayerId: mbappe.playerId, minuteRegulation: 60 },
      ],
      enteredByGamingMemberId: admin.gamingMemberId,
    });
    await correctMatchResult(repo, correctionDraft.matchResultId, admin.gamingMemberId, "Second goal confirmed on review.");

    const corrected = await repo.getMatchResultById(correctionDraft.matchResultId);
    expect(corrected!.finalizedByGamingMemberId).toBe(admin.gamingMemberId);

    const original = await repo.getMatchResultById(draft.matchResultId);
    expect(original!.homeScore).toBe(1);

    const events = await auditRepo.listEventsForTarget("match_results", correctionDraft.matchResultId);
    const correctionEvents = events.filter((e) => e.actionType === "CORRECT_RESULT");
    expect(correctionEvents).toHaveLength(1);
    expect(correctionEvents[0].previousReference).toEqual({ table: "match_results", id: draft.matchResultId });
    expect(correctionEvents[0].resultingReference).toEqual({ table: "match_results", id: correctionDraft.matchResultId });
    expect(correctionEvents[0].reason).toBe("Second goal confirmed on review.");
  });

  it("Activity Classification declaration without Consequential Finalizer authority is rejected at the RPC layer", async () => {
    const notFinalizer = await createRealGamingMember("ContractA1ClassNotFinalizer");
    const { home, away } = await createTeamsAndRoster();
    const match = await repo.createMatch({
      homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Contract Test — A1", kickoffAt: futureIso(),
    });
    createdMatchIds.push(match.matchId);

    await expect(
      repo.setMatchActivityClassification(match.matchId, "RANKED", notFinalizer.gamingMemberId, null)
    ).rejects.toBeInstanceOf(InsufficientPlatformAuthorityError);
  });

  it("Activity Classification declaration by a Finalizer produces exactly one DECLARE_ACTIVITY_CLASSIFICATION audit event", async () => {
    const admin = await createRealGamingMember("ContractA1ClassAdmin");
    await grantFinalizerAuthority(admin.gamingMemberId);
    const { home, away } = await createTeamsAndRoster();
    const match = await repo.createMatch({
      homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Contract Test — A1", kickoffAt: futureIso(),
    });
    createdMatchIds.push(match.matchId);

    await repo.setMatchActivityClassification(match.matchId, "RANKED", admin.gamingMemberId, "Friendly exhibition.");

    const events = await auditRepo.listEventsForTarget("matches", match.matchId);
    const declareEvents = events.filter((e) => e.actionType === "DECLARE_ACTIVITY_CLASSIFICATION");
    expect(declareEvents).toHaveLength(1);
    expect(declareEvents[0].actorId).toBe(admin.gamingMemberId);
    expect(declareEvents[0].authorityClassUsed).toBe("CONSEQUENTIAL_FINALIZER");
    expect(declareEvents[0].reason).toBe("Friendly exhibition.");
  });

  it("XP Eligibility declaration without Consequential Finalizer authority is rejected at the RPC layer", async () => {
    const notFinalizer = await createRealGamingMember("ContractA1XpNotFinalizer");
    const { home, away } = await createTeamsAndRoster();
    const match = await repo.createMatch({
      homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Contract Test — A1", kickoffAt: futureIso(),
    });
    createdMatchIds.push(match.matchId);

    await expect(
      repo.setMatchXpEligibility(match.matchId, true, notFinalizer.gamingMemberId, null)
    ).rejects.toBeInstanceOf(InsufficientPlatformAuthorityError);
  });

  it("XP Eligibility declaration by a Finalizer produces exactly one DECLARE_XP_ELIGIBILITY audit event, distinct from Activity Classification's", async () => {
    const admin = await createRealGamingMember("ContractA1XpAdmin");
    await grantFinalizerAuthority(admin.gamingMemberId);
    const { home, away } = await createTeamsAndRoster();
    const match = await repo.createMatch({
      homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Contract Test — A1", kickoffAt: futureIso(),
    });
    createdMatchIds.push(match.matchId);

    await repo.setMatchActivityClassification(match.matchId, "RANKED", admin.gamingMemberId, null);
    await repo.setMatchXpEligibility(match.matchId, true, admin.gamingMemberId, null);

    const events = await auditRepo.listEventsForTarget("matches", match.matchId);
    expect(events.map((e) => e.actionType).sort()).toEqual([
      "DECLARE_ACTIVITY_CLASSIFICATION",
      "DECLARE_XP_ELIGIBILITY",
    ]);
    // Gaming XP remains untouched by this declaration.
    const { count } = await cleanupClient
      .from("gaming_xp_events")
      .select("gaming_xp_event_id", { count: "exact", head: true })
      .eq("gaming_member_id", admin.gamingMemberId);
    expect(count).toBe(0);
  });

  it("Prize redemption without Consequential Finalizer authority is rejected at the RPC layer", async () => {
    const admin = await createRealGamingMember("ContractA1RedeemAdmin");
    await grantFinalizerAuthority(admin.gamingMemberId);
    const alex = await createRealGamingMember("ContractA1RedeemAlex");
    const { home, away, mbappe, vini } = await createTeamsAndRoster();

    const match = await repo.createMatch({
      homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Contract Test — A1", kickoffAt: futureIso(),
    });
    createdMatchIds.push(match.matchId);
    await repo.setMatchActivityClassification(match.matchId, "RANKED", admin.gamingMemberId, null);

    const venue = await repo.createVenue({ name: "A1 Redeem Venue", latitude: 10, longitude: 10, radiusMeters: 100 });
    createdVenueIds.push(venue.venueId);
    const activation = await repo.createVenueActivation({ matchId: match.matchId, venueId: venue.venueId });
    await repo.createPrizeTier({ venueActivationId: activation.venueActivationId, correctDimensionCount: 4, prizeLabel: "Jersey" });

    const prediction = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: alex.gamingMemberId, venueActivationId: activation.venueActivationId,
      predictedHomeScore: 0, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: null, predictedGoalMinuteRegulation: null, predictedGoalMinuteStoppage: null,
      predictedFirstTeamToScore: null,
      geo: { latitude: 10.0001, longitude: 10.0001, accuracyMeters: 5 },
    });
    const draft = await saveDraftDirect({
      matchId: match.matchId, homeScore: 0, awayScore: 0, officialGoalEvents: [],
      enteredByGamingMemberId: admin.gamingMemberId,
    });
    await finalizeMatchResult(repo, draft.matchResultId, admin.gamingMemberId);
    const evaluation = await repo.getEvaluation(prediction.predictionId, draft.matchResultId);
    const qualification = await repo.getQualificationForEvaluation(evaluation!.evaluationId);

    const notFinalizer = await createRealGamingMember("ContractA1RedeemNotFinalizer");
    await expect(
      repo.redeemPrizeQualification(qualification!.prizeQualificationId, notFinalizer.gamingMemberId, null)
    ).rejects.toBeInstanceOf(InsufficientPlatformAuthorityError);

    const finalized = await redeemPrizeQualification(
      repo,
      qualification!.prizeQualificationId,
      admin.gamingMemberId,
      "Collected at venue counter."
    );
    expect(finalized.alreadyRedeemed).toBe(false);

    const events = await auditRepo.listEventsForTarget("prize_qualifications", qualification!.prizeQualificationId);
    const redemptionEvents = events.filter((e) => e.actionType === "CONFIRM_PRIZE_REDEMPTION");
    expect(redemptionEvents).toHaveLength(1);
    expect(redemptionEvents[0].actorId).toBe(admin.gamingMemberId);
    expect(redemptionEvents[0].reason).toBe("Collected at venue counter.");
  });
});

describe("SupabasePredictionsRepository contract — listQualificationDetailsForActivation against live Postgres", () => {
  const GOALLESS_PREDICTION = {
    predictedGoalscorerPlayerId: null,
    predictedGoalMinuteRegulation: null,
    predictedGoalMinuteStoppage: null,
    predictedFirstTeamToScore: null,
    geo: { latitude: 10.0001, longitude: 10.0001, accuracyMeters: 5 },
  } as const;

  async function setupTwoActivations() {
    const admin = await createRealGamingMember("ContractQDAdmin");
    await grantFinalizerAuthority(admin.gamingMemberId);
    const alex = await createRealGamingMember("ContractQDAlex");
    const carol = await createRealGamingMember("ContractQDCarol");
    const bea = await createRealGamingMember("ContractQDBea");
    const { home, away, mbappe } = await createTeamsAndRoster();

    const match = await repo.createMatch({
      homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Contract Test — QD", kickoffAt: futureIso(),
    });
    createdMatchIds.push(match.matchId);
    await repo.setMatchActivityClassification(match.matchId, "RANKED", admin.gamingMemberId, null);

    const venueA = await repo.createVenue({ name: "QD Venue A", latitude: 10, longitude: 10, radiusMeters: 100 });
    const venueB = await repo.createVenue({ name: "QD Venue B", latitude: 10, longitude: 10, radiusMeters: 100 });
    const venueC = await repo.createVenue({ name: "QD Venue C", latitude: 10, longitude: 10, radiusMeters: 100 });
    createdVenueIds.push(venueA.venueId, venueB.venueId, venueC.venueId);
    const activationA = await repo.createVenueActivation({ matchId: match.matchId, venueId: venueA.venueId });
    const activationB = await repo.createVenueActivation({ matchId: match.matchId, venueId: venueB.venueId });
    const activationC = await repo.createVenueActivation({ matchId: match.matchId, venueId: venueC.venueId });

    await repo.createPrizeTier({ venueActivationId: activationA.venueActivationId, correctDimensionCount: 4, prizeLabel: "QD Jersey" });
    await repo.createPrizeTier({ venueActivationId: activationA.venueActivationId, correctDimensionCount: 3, prizeLabel: "QD Sticker" });
    await repo.createPrizeTier({ venueActivationId: activationB.venueActivationId, correctDimensionCount: 4, prizeLabel: "QD Gift Card" });

    // Against a 0-0 official result: alex (0-0) is 4/4, carol (1-0) is 3/4
    // — both in A — and bea (0-0) is 4/4 in B.
    await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: alex.gamingMemberId, venueActivationId: activationA.venueActivationId,
      predictedHomeScore: 0, predictedAwayScore: 0, ...GOALLESS_PREDICTION,
    });
    await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: carol.gamingMemberId, venueActivationId: activationA.venueActivationId,
      predictedHomeScore: 1, predictedAwayScore: 0, ...GOALLESS_PREDICTION,
    });
    await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: bea.gamingMemberId, venueActivationId: activationB.venueActivationId,
      predictedHomeScore: 0, predictedAwayScore: 0, ...GOALLESS_PREDICTION,
    });

    const draft = await saveDraftDirect({
      matchId: match.matchId, homeScore: 0, awayScore: 0, officialGoalEvents: [],
      enteredByGamingMemberId: admin.gamingMemberId,
    });
    await finalizeMatchResult(repo, draft.matchResultId, admin.gamingMemberId);

    return { admin, alex, carol, bea, mbappe, match, draft, activationA, activationB, activationC };
  }

  it("joins each qualification to its own winner's display name and its own prize label, with no leakage across activations", async () => {
    const { alex, carol, bea, activationA, activationB } = await setupTwoActivations();

    const baseA = await repo.listQualificationsForActivation(activationA.venueActivationId);
    const detailsA = await repo.listQualificationDetailsForActivation(activationA.venueActivationId);
    const detailsB = await repo.listQualificationDetailsForActivation(activationB.venueActivationId);

    expect(detailsA).toHaveLength(2);
    expect(detailsA.every((d) => d.venueActivationId === activationA.venueActivationId)).toBe(true);
    const byMemberA = new Map(detailsA.map((d) => [d.gamingMemberId, d]));
    expect(byMemberA.get(alex.gamingMemberId)).toMatchObject({ memberDisplayName: "ContractQDAlex", prizeLabel: "QD Jersey" });
    expect(byMemberA.get(carol.gamingMemberId)).toMatchObject({ memberDisplayName: "ContractQDCarol", prizeLabel: "QD Sticker" });
    expect(byMemberA.has(bea.gamingMemberId)).toBe(false);

    expect(detailsB).toHaveLength(1);
    expect(detailsB[0]).toMatchObject({
      gamingMemberId: bea.gamingMemberId,
      venueActivationId: activationB.venueActivationId,
      memberDisplayName: "ContractQDBea",
      prizeLabel: "QD Gift Card",
    });

    // Every existing field is carried through unchanged.
    const byId = (a: { prizeQualificationId: string }, b: { prizeQualificationId: string }) =>
      a.prizeQualificationId.localeCompare(b.prizeQualificationId);
    const stripped = detailsA.map(({ memberDisplayName: _n, prizeLabel: _l, ...rest }) => rest).sort(byId);
    expect(stripped).toEqual([...baseA].sort(byId));
  }, 60000);

  it("a redeemed qualification superseded by a correction still resolves its display name and prize label", async () => {
    const { admin, alex, mbappe, match, draft, activationA } = await setupTwoActivations();
    const [alexQualification] = (await repo.listQualificationsForActivation(activationA.venueActivationId)).filter(
      (q) => q.gamingMemberId === alex.gamingMemberId
    );
    await redeemPrizeQualification(repo, alexQualification.prizeQualificationId, admin.gamingMemberId);

    // 1-0 with a goal: alex's goalless 0-0 pick is now 0/4, so the 4/4 qualification is superseded with no replacement.
    const correctionDraft = await saveDraftDirect({
      matchId: match.matchId, homeScore: 1, awayScore: 0,
      officialGoalEvents: [{ scorerPlayerId: mbappe.playerId, minuteRegulation: 10 }],
      enteredByGamingMemberId: admin.gamingMemberId,
    });
    await correctMatchResult(repo, correctionDraft.matchResultId, admin.gamingMemberId, "Goal confirmed on review.");

    const details = await repo.listQualificationDetailsForActivation(activationA.venueActivationId);
    const alexDetail = details.find((d) => d.prizeQualificationId === alexQualification.prizeQualificationId)!;

    expect(alexDetail.supersededAt).not.toBeNull();
    expect(alexDetail.redeemedAt).not.toBeNull();
    expect(alexDetail.memberDisplayName).toBe("ContractQDAlex");
    expect(alexDetail.prizeLabel).toBe("QD Jersey");
  }, 60000);

  it("an activation with no qualifications, and an unknown activation id, both yield an empty list", async () => {
    const { activationC } = await setupTwoActivations();

    expect(await repo.listQualificationDetailsForActivation(activationC.venueActivationId)).toEqual([]);
    expect(await repo.listQualificationDetailsForActivation(randomUUID())).toEqual([]);
  }, 60000);
});
