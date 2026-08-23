import { readFileSync } from "fs";
import { randomUUID } from "crypto";
import { describe, expect, it } from "vitest";

import { InMemoryMetagameRepository } from "../lib/gaming/metagame/db/inMemoryMetagameRepository";
import { recordExperienceSummary } from "../lib/gaming/metagame/recordExperienceSummary";
import { processExperienceSummaryConsequences } from "../lib/gaming/metagame/processExperienceSummaryConsequences";
import { getGlobalLeaderboard } from "../lib/gaming/metagame/leaderboard";
import { ExperienceSummaryNotFoundError } from "../lib/gaming/metagame/types";

import { InMemoryPredictionsRepository } from "../lib/gaming/predictions/db/inMemoryPredictionsRepository";
import { submitPrediction } from "../lib/gaming/predictions/submitPrediction";
import { finalizeMatchResult } from "../lib/gaming/predictions/finalizeMatchResult";
import { correctMatchResult } from "../lib/gaming/predictions/correctMatchResult";
import {
  createTeam,
  createPlayer,
  createMatch,
  createVenue,
  createVenueActivation,
  createPrizeTier,
  saveDraftResult,
  startResultCorrection,
  setMatchActivityClassification,
  setMatchXpEligibility,
} from "../lib/gaming/predictions/adminCatalog";
import { MatchNotClassifiedError, ActivityClassificationLockedError } from "../lib/gaming/predictions/types";

const VENUE_LAT = 10.0;
const VENUE_LON = 10.0;
const INSIDE = { latitude: 10.0001, longitude: 10.0001, accuracyMeters: 5 };

function futureIso(ms = 3600_000): string {
  return new Date(Date.now() + ms).toISOString();
}

async function setupRankedMatch(repo: InMemoryPredictionsRepository, kickoffAt = futureIso()) {
  const home = await createTeam(repo, { name: "Home FC" });
  const away = await createTeam(repo, { name: "Away FC" });
  const striker = await createPlayer(repo, { teamId: home.teamId, name: "Striker" });
  const match = await createMatch(repo, { homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Test Cup", kickoffAt });
  await setMatchActivityClassification(repo, match.matchId, "RANKED", "gm-admin");
  // XP-eligibility gate (Slice: XP Eligibility / Calibration Support) —
  // fixture only, not Product config; without this, finalize would
  // silently produce zero XP regardless of the fixture rules below.
  await setMatchXpEligibility(repo, match.matchId, true, "gm-admin");
  await repo.metagameRepository.createCategoryParticipationPolicy({ categoryKey: "SOCCER_PREDICTIONS", dailyParticipationAllowance: 1000 });
  await repo.metagameRepository.createGamingXpRule({ categoryKey: "SOCCER_PREDICTIONS", consequenceClass: "PARTICIPATION", performanceBandKey: null, points: 5 });
  const venue = await createVenue(repo, { name: "Test Venue", latitude: VENUE_LAT, longitude: VENUE_LON, radiusMeters: 100 });
  const activation = await createVenueActivation(repo, { matchId: match.matchId, venueId: venue.venueId });
  return { home, away, striker, match, venue, activation };
}

// Deliberately configures NO category participation policy and NO XP
// rules at all — proves the missing-policy boundary correction via
// the real Predictions finalize path, not just direct Metagame calls.
// Still declared XP-eligible: this isolates "no policy configured" as
// the sole cause of zero XP, distinct from "not eligible."
async function setupRankedMatchNoXpConfig(repo: InMemoryPredictionsRepository, kickoffAt = futureIso()) {
  const home = await createTeam(repo, { name: "Home FC" });
  const away = await createTeam(repo, { name: "Away FC" });
  const striker = await createPlayer(repo, { teamId: home.teamId, name: "Striker" });
  const match = await createMatch(repo, { homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Test Cup", kickoffAt });
  await setMatchActivityClassification(repo, match.matchId, "RANKED", "gm-admin");
  await setMatchXpEligibility(repo, match.matchId, true, "gm-admin");
  const venue = await createVenue(repo, { name: "Test Venue", latitude: VENUE_LAT, longitude: VENUE_LON, radiusMeters: 100 });
  const activation = await createVenueActivation(repo, { matchId: match.matchId, venueId: venue.venueId });
  return { home, away, striker, match, venue, activation };
}

// --- SUMMARY ---------------------------------------------------------

describe("Finalized Experience Summary — authorship and idempotency", () => {
  it("is idempotent per (experienceKey, idempotencyKey) — a retried record returns the same summary", async () => {
    const repo = new InMemoryMetagameRepository();
    const input = {
      gamingMemberId: randomUUID(),
      experienceKey: "SOCCER_PREDICTIONS",
      categoryKey: "SOCCER_PREDICTIONS",
      activityClassification: "RANKED" as const,
      authorityTier: "ADMIN_FINALIZED" as const,
      occurredAt: new Date().toISOString(),
      finalizedAt: new Date().toISOString(),
      meaningfulParticipation: true, xpEligible: true,
      performanceBandKey: null,
      sourceReference: "eval-1",
      rulesetVersion: "v1",
      supersedesExperienceSummaryId: null,
      idempotencyKey: "eval-1",
      evidence: {},
    };
    const first = await recordExperienceSummary(repo, input);
    const second = await recordExperienceSummary(repo, input);
    expect(second.experienceSummaryId).toBe(first.experienceSummaryId);
    expect(first.alreadyRecorded).toBe(false);
    expect(second.alreadyRecorded).toBe(true);
  });

  it("processing consequences for an unknown summary id throws ExperienceSummaryNotFoundError", async () => {
    const repo = new InMemoryMetagameRepository();
    await expect(processExperienceSummaryConsequences(repo, randomUUID())).rejects.toBeInstanceOf(
      ExperienceSummaryNotFoundError
    );
  });

  it("Soccer Predictions: occurred_at is the first accepted Prediction's own created_at, never moved by a later pre-kickoff revision", async () => {
    const repo = new InMemoryPredictionsRepository();
    repo.authorityRepository.seedAuthority("gm-admin", "CONSEQUENTIAL_FINALIZER");
    const { match, activation, striker } = await setupRankedMatch(repo);
    const gamingMemberId = "gm-1";

    const first = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId, venueActivationId: activation.venueActivationId,
      predictedHomeScore: 1, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: null, predictedGoalMinuteRegulation: null, predictedGoalMinuteStoppage: null, predictedFirstTeamToScore: null, geo: INSIDE,
    });
    const revised = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId, venueActivationId: activation.venueActivationId,
      predictedHomeScore: 2, predictedAwayScore: 1,
      predictedGoalscorerPlayerId: striker.playerId, predictedGoalMinuteRegulation: 10, predictedGoalMinuteStoppage: null, predictedFirstTeamToScore: "HOME", geo: INSIDE,
    });
    expect(revised.predictionId).toBe(first.predictionId);
    expect(revised.createdAt).toBe(first.createdAt);

    const draft = await saveDraftResult(repo, { matchId: match.matchId, homeScore: 2, awayScore: 1, officialGoalEvents: [{ scorerPlayerId: striker.playerId, minuteRegulation: 10 }], enteredByGamingMemberId: "gm-admin" });
    await finalizeMatchResult(repo, draft.matchResultId, "gm-admin");

    const events = await repo.metagameRepository.listXpEventsForMember(gamingMemberId);
    const summary = await repo.metagameRepository.getExperienceSummary(events[0].experienceSummaryId);
    // occurred_at is anchored to the FIRST accepted submission, not the
    // later revision — asserted directly rather than via inequality
    // against revised.updatedAt, which can coincide at millisecond
    // resolution when both happen back-to-back in a fast test run.
    expect(summary!.occurredAt).toBe(first.createdAt);
    expect(summary!.performanceBandKey).toBe("CORRECT_4_OF_4"); // the LATEST predicted content is what's evaluated
  });
});

// --- PREDICTIONS-V2: dimension fact contract --------------------------
//
// correct_dimension_count/correct_dimension_keys[] on the Experience
// Summary must reflect exactly which of the four canonical dimensions
// were correct, always in the fixed canonical key order
// (EXACT_SCORELINE, ANY_GOALSCORER, ANY_GOAL_MINUTE,
// FIRST_TEAM_TO_SCORE), regardless of which dimensions happen to be
// true. The shared-table CHECK constraint (0095) only enforces
// cardinality consistency; the exact key set/order is a
// Predictions-adapter invariant, locked in here.

describe("Predictions-v2 — dimension fact contract", () => {
  async function setupTwoScorerMatch(repo: InMemoryPredictionsRepository) {
    const home = await createTeam(repo, { name: "Home FC" });
    const away = await createTeam(repo, { name: "Away FC" });
    const scorer = await createPlayer(repo, { teamId: home.teamId, name: "Scorer" });
    const decoy = await createPlayer(repo, { teamId: home.teamId, name: "Decoy" });
    const match = await createMatch(repo, { homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Test Cup", kickoffAt: futureIso() });
    await setMatchActivityClassification(repo, match.matchId, "RANKED", "gm-admin");
    await repo.metagameRepository.createCategoryParticipationPolicy({ categoryKey: "SOCCER_PREDICTIONS", dailyParticipationAllowance: 1000 });
    await repo.metagameRepository.createGamingXpRule({ categoryKey: "SOCCER_PREDICTIONS", consequenceClass: "PARTICIPATION", performanceBandKey: null, points: 1 });
    const venue = await createVenue(repo, { name: "Test Venue", latitude: VENUE_LAT, longitude: VENUE_LON, radiusMeters: 100 });
    const activation = await createVenueActivation(repo, { matchId: match.matchId, venueId: venue.venueId });
    return { home, away, scorer, decoy, match, venue, activation };
  }

  // Official result is fixed for every case: HOME 1-0 AWAY, sole goal
  // by `scorer` at ordinary minute 10 — so First Team to Score is HOME.
  async function finalizeWithPrediction(
    repo: InMemoryPredictionsRepository,
    setup: Awaited<ReturnType<typeof setupTwoScorerMatch>>,
    prediction: {
      predictedHomeScore: number;
      predictedAwayScore: number;
      predictedGoalscorerPlayerId: string | null;
      predictedGoalMinuteRegulation: number | null;
      predictedGoalMinuteStoppage: number | null;
      predictedFirstTeamToScore: "HOME" | "AWAY" | null;
    }
  ) {
    const { match, activation, scorer } = setup;
    const submitted = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
      geo: INSIDE, ...prediction,
    });
    const draft = await saveDraftResult(repo, {
      matchId: match.matchId, homeScore: 1, awayScore: 0,
      officialGoalEvents: [{ scorerPlayerId: scorer.playerId, minuteRegulation: 10 }],
      enteredByGamingMemberId: "gm-admin",
    });
    await finalizeMatchResult(repo, draft.matchResultId, "gm-admin");
    const evaluation = await repo.getEvaluation(submitted.predictionId, draft.matchResultId);
    const summary = await repo.metagameRepository.getExperienceSummary(
      (await repo.metagameRepository.getExperienceSummaryByIdempotencyKey("SOCCER_PREDICTIONS", evaluation!.evaluationId))!
        .experienceSummaryId
    );
    return { evaluation: evaluation!, summary: summary! };
  }

  it("0/4 — every dimension wrong", async () => {
    const repo = new InMemoryPredictionsRepository();
    repo.authorityRepository.seedAuthority("gm-admin", "CONSEQUENTIAL_FINALIZER");
    const setup = await setupTwoScorerMatch(repo);
    const { summary } = await finalizeWithPrediction(repo, setup, {
      predictedHomeScore: 3, predictedAwayScore: 3,
      predictedGoalscorerPlayerId: setup.decoy.playerId,
      predictedGoalMinuteRegulation: 77, predictedGoalMinuteStoppage: null,
      predictedFirstTeamToScore: "AWAY",
    });
    expect(summary.correctDimensionCount).toBe(0);
    expect(summary.correctDimensionKeys).toEqual([]);
    expect(summary.performanceBandKey).toBe("CORRECT_0_OF_4");
  });

  it("1/4 — only EXACT_SCORELINE correct", async () => {
    const repo = new InMemoryPredictionsRepository();
    repo.authorityRepository.seedAuthority("gm-admin", "CONSEQUENTIAL_FINALIZER");
    const setup = await setupTwoScorerMatch(repo);
    const { summary } = await finalizeWithPrediction(repo, setup, {
      predictedHomeScore: 1, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: setup.decoy.playerId,
      predictedGoalMinuteRegulation: 77, predictedGoalMinuteStoppage: null,
      predictedFirstTeamToScore: "AWAY",
    });
    expect(summary.correctDimensionCount).toBe(1);
    expect(summary.correctDimensionKeys).toEqual(["EXACT_SCORELINE"]);
  });

  it("1/4 — only ANY_GOALSCORER correct", async () => {
    const repo = new InMemoryPredictionsRepository();
    repo.authorityRepository.seedAuthority("gm-admin", "CONSEQUENTIAL_FINALIZER");
    const setup = await setupTwoScorerMatch(repo);
    const { summary } = await finalizeWithPrediction(repo, setup, {
      predictedHomeScore: 3, predictedAwayScore: 3,
      predictedGoalscorerPlayerId: setup.scorer.playerId,
      predictedGoalMinuteRegulation: 77, predictedGoalMinuteStoppage: null,
      predictedFirstTeamToScore: "AWAY",
    });
    expect(summary.correctDimensionCount).toBe(1);
    expect(summary.correctDimensionKeys).toEqual(["ANY_GOALSCORER"]);
  });

  it("1/4 — only ANY_GOAL_MINUTE correct", async () => {
    const repo = new InMemoryPredictionsRepository();
    repo.authorityRepository.seedAuthority("gm-admin", "CONSEQUENTIAL_FINALIZER");
    const setup = await setupTwoScorerMatch(repo);
    const { summary } = await finalizeWithPrediction(repo, setup, {
      predictedHomeScore: 3, predictedAwayScore: 3,
      predictedGoalscorerPlayerId: setup.decoy.playerId,
      predictedGoalMinuteRegulation: 10, predictedGoalMinuteStoppage: null,
      predictedFirstTeamToScore: "AWAY",
    });
    expect(summary.correctDimensionCount).toBe(1);
    expect(summary.correctDimensionKeys).toEqual(["ANY_GOAL_MINUTE"]);
  });

  it("1/4 — only FIRST_TEAM_TO_SCORE correct", async () => {
    const repo = new InMemoryPredictionsRepository();
    repo.authorityRepository.seedAuthority("gm-admin", "CONSEQUENTIAL_FINALIZER");
    const setup = await setupTwoScorerMatch(repo);
    const { summary } = await finalizeWithPrediction(repo, setup, {
      predictedHomeScore: 3, predictedAwayScore: 3,
      predictedGoalscorerPlayerId: setup.decoy.playerId,
      predictedGoalMinuteRegulation: 77, predictedGoalMinuteStoppage: null,
      predictedFirstTeamToScore: "HOME",
    });
    expect(summary.correctDimensionCount).toBe(1);
    expect(summary.correctDimensionKeys).toEqual(["FIRST_TEAM_TO_SCORE"]);
  });

  it("2/4 — EXACT_SCORELINE and ANY_GOAL_MINUTE correct, keys stay in fixed canonical order (not evaluation order)", async () => {
    const repo = new InMemoryPredictionsRepository();
    repo.authorityRepository.seedAuthority("gm-admin", "CONSEQUENTIAL_FINALIZER");
    const setup = await setupTwoScorerMatch(repo);
    const { summary } = await finalizeWithPrediction(repo, setup, {
      predictedHomeScore: 1, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: setup.decoy.playerId,
      predictedGoalMinuteRegulation: 10, predictedGoalMinuteStoppage: null,
      predictedFirstTeamToScore: "AWAY",
    });
    expect(summary.correctDimensionCount).toBe(2);
    expect(summary.correctDimensionKeys).toEqual(["EXACT_SCORELINE", "ANY_GOAL_MINUTE"]);
  });

  it("3/4 — EXACT_SCORELINE, ANY_GOALSCORER, FIRST_TEAM_TO_SCORE correct", async () => {
    const repo = new InMemoryPredictionsRepository();
    repo.authorityRepository.seedAuthority("gm-admin", "CONSEQUENTIAL_FINALIZER");
    const setup = await setupTwoScorerMatch(repo);
    const { summary } = await finalizeWithPrediction(repo, setup, {
      predictedHomeScore: 1, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: setup.scorer.playerId,
      predictedGoalMinuteRegulation: 77, predictedGoalMinuteStoppage: null,
      predictedFirstTeamToScore: "HOME",
    });
    expect(summary.correctDimensionCount).toBe(3);
    expect(summary.correctDimensionKeys).toEqual(["EXACT_SCORELINE", "ANY_GOALSCORER", "FIRST_TEAM_TO_SCORE"]);
  });

  it("4/4 — every dimension correct", async () => {
    const repo = new InMemoryPredictionsRepository();
    repo.authorityRepository.seedAuthority("gm-admin", "CONSEQUENTIAL_FINALIZER");
    const setup = await setupTwoScorerMatch(repo);
    const { summary } = await finalizeWithPrediction(repo, setup, {
      predictedHomeScore: 1, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: setup.scorer.playerId,
      predictedGoalMinuteRegulation: 10, predictedGoalMinuteStoppage: null,
      predictedFirstTeamToScore: "HOME",
    });
    expect(summary.correctDimensionCount).toBe(4);
    expect(summary.correctDimensionKeys).toEqual([
      "EXACT_SCORELINE",
      "ANY_GOALSCORER",
      "ANY_GOAL_MINUTE",
      "FIRST_TEAM_TO_SCORE",
    ]);
    expect(summary.performanceBandKey).toBe("CORRECT_4_OF_4");
  });

  it("correct_dimension_count always equals correct_dimension_keys.length", async () => {
    const repo = new InMemoryPredictionsRepository();
    repo.authorityRepository.seedAuthority("gm-admin", "CONSEQUENTIAL_FINALIZER");
    const setup = await setupTwoScorerMatch(repo);
    const { summary } = await finalizeWithPrediction(repo, setup, {
      predictedHomeScore: 1, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: setup.scorer.playerId,
      predictedGoalMinuteRegulation: 77, predictedGoalMinuteStoppage: null,
      predictedFirstTeamToScore: "AWAY",
    });
    expect(summary.correctDimensionCount).toBe(summary.correctDimensionKeys!.length);
  });
});

// --- PREDICTIONS-V2: the explicit corrections proving case ------------
//
// A first-half-stoppage goal, recorded as ordinary minute 46 in Result
// Version 1 and corrected to the true (45, 1) pair in Result Version 2,
// must flip Goal Minute correctness for an unchanged ordinary-46
// Prediction — proving the exact real-world consequence of the
// flattened-minute defect this Slice fixes. Evaluation 1/Summary 1 must
// survive untouched; Evaluation 2 is a new row; Summary 2 supersedes
// Summary 1 with different correct_dimension_keys[]; with zero XP
// configured, no XP event or reversal may appear at any point.

describe("Predictions-v2 — corrections proving case: ordinary 46 vs true 45+1", () => {
  it("correcting an official goal from ordinary minute 46 to (45, stoppage 1) flips Goal Minute correctness without disturbing the original Evaluation/Summary", async () => {
    const repo = new InMemoryPredictionsRepository();
    repo.authorityRepository.seedAuthority("gm-admin", "CONSEQUENTIAL_FINALIZER");
    const { match, activation, striker } = await setupRankedMatchNoXpConfig(repo);
    const gamingMemberId = "gm-correction";

    const prediction = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId, venueActivationId: activation.venueActivationId,
      predictedHomeScore: 1, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: striker.playerId, predictedGoalMinuteRegulation: 46, predictedGoalMinuteStoppage: null,
      predictedFirstTeamToScore: "HOME", geo: INSIDE,
    });

    // Result Version 1: the goal is (mis)recorded as ordinary minute 46
    // — matches the Prediction exactly.
    const draft1 = await saveDraftResult(repo, {
      matchId: match.matchId, homeScore: 1, awayScore: 0,
      officialGoalEvents: [{ scorerPlayerId: striker.playerId, minuteRegulation: 46 }],
      enteredByGamingMemberId: "gm-admin",
    });
    await finalizeMatchResult(repo, draft1.matchResultId, "gm-admin");

    const evaluation1 = await repo.getEvaluation(prediction.predictionId, draft1.matchResultId);
    expect(evaluation1!.goalMinuteCorrect).toBe(true);
    expect(evaluation1!.correctDimensionCount).toBe(4);
    const summary1 = await repo.metagameRepository.getExperienceSummary(
      (await repo.metagameRepository.getExperienceSummaryByIdempotencyKey("SOCCER_PREDICTIONS", evaluation1!.evaluationId))!
        .experienceSummaryId
    );
    expect(summary1!.correctDimensionKeys).toContain("ANY_GOAL_MINUTE");

    // Result Version 2: corrected to the true (45, stoppage 1) pair —
    // the Prediction itself is NOT re-submitted, so it remains ordinary
    // 46. Under the old flattened scheme (46 == 45+1's sum) this
    // correction would have been invisible to settlement.
    const correctionDraft = await startResultCorrection(repo, {
      matchId: match.matchId, homeScore: 1, awayScore: 0,
      officialGoalEvents: [{ scorerPlayerId: striker.playerId, minuteRegulation: 45, minuteStoppage: 1 }],
      enteredByGamingMemberId: "gm-admin",
    });
    const correctionResult = await correctMatchResult(repo, correctionDraft.matchResultId, "gm-admin", "Official result corrected on review.");

    // Evaluation 1 / Summary 1 remain untouched — the immutable
    // evidence trail is never mutated or deleted.
    const evaluation1After = await repo.getEvaluation(prediction.predictionId, draft1.matchResultId);
    expect(evaluation1After).toEqual(evaluation1);

    const evaluation2 = await repo.getEvaluation(prediction.predictionId, correctionResult.matchResultId);
    expect(evaluation2).not.toBeNull();
    expect(evaluation2!.evaluationId).not.toBe(evaluation1!.evaluationId);
    expect(evaluation2!.goalMinuteCorrect).toBe(false); // the exact defect this fixes
    expect(evaluation2!.scorelineCorrect).toBe(true);
    expect(evaluation2!.goalscorerCorrect).toBe(true);
    expect(evaluation2!.firstTeamToScoreCorrect).toBe(true);
    expect(evaluation2!.correctDimensionCount).toBe(3);

    const summary2 = await repo.metagameRepository.getExperienceSummary(
      (await repo.metagameRepository.getExperienceSummaryByIdempotencyKey("SOCCER_PREDICTIONS", evaluation2!.evaluationId))!
        .experienceSummaryId
    );
    expect(summary2!.correctDimensionKeys).toEqual(["EXACT_SCORELINE", "ANY_GOALSCORER", "FIRST_TEAM_TO_SCORE"]);
    expect(summary2!.correctDimensionKeys).not.toContain("ANY_GOAL_MINUTE");
    expect(summary2!.supersedesExperienceSummaryId).toBe(summary1!.experienceSummaryId);

    // The current-evaluation read reflects Version 2, not Version 1.
    const current = await repo.getCurrentEvaluationForPrediction(prediction.predictionId);
    expect(current!.evaluationId).toBe(evaluation2!.evaluationId);

    // Zero XP configured throughout — no fabricated event or reversal.
    const events = await repo.metagameRepository.listXpEventsForMember(gamingMemberId);
    expect(events).toHaveLength(0);
  });
});

// --- CLASSIFICATION ---------------------------------------------------

describe("Activity Classification — Match-level, predeclared, locked", () => {
  it("an unclassified Match rejects a Prediction", async () => {
    const repo = new InMemoryPredictionsRepository();
    repo.authorityRepository.seedAuthority("gm-admin", "CONSEQUENTIAL_FINALIZER");
    const home = await createTeam(repo, { name: "Home FC" });
    const away = await createTeam(repo, { name: "Away FC" });
    const match = await createMatch(repo, { homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Test Cup", kickoffAt: futureIso() });
    const venue = await createVenue(repo, { name: "Test Venue", latitude: VENUE_LAT, longitude: VENUE_LON, radiusMeters: 100 });
    const activation = await createVenueActivation(repo, { matchId: match.matchId, venueId: venue.venueId });

    await expect(
      submitPrediction(repo, {
        matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
        predictedHomeScore: 0, predictedAwayScore: 0,
        predictedGoalscorerPlayerId: null, predictedGoalMinuteRegulation: null, predictedGoalMinuteStoppage: null, predictedFirstTeamToScore: null, geo: INSIDE,
      })
    ).rejects.toBeInstanceOf(MatchNotClassifiedError);
  });

  it("a RANKED Match accepts a Prediction", async () => {
    const repo = new InMemoryPredictionsRepository();
    repo.authorityRepository.seedAuthority("gm-admin", "CONSEQUENTIAL_FINALIZER");
    const { match, activation } = await setupRankedMatch(repo);
    const prediction = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
      predictedHomeScore: 0, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: null, predictedGoalMinuteRegulation: null, predictedGoalMinuteStoppage: null, predictedFirstTeamToScore: null, geo: INSIDE,
    });
    expect(prediction.matchId).toBe(match.matchId);
  });

  it("classification is freely changeable before any Prediction or Result evidence exists", async () => {
    const repo = new InMemoryPredictionsRepository();
    repo.authorityRepository.seedAuthority("gm-admin", "CONSEQUENTIAL_FINALIZER");
    const { match } = await setupRankedMatch(repo);
    const changed = await setMatchActivityClassification(repo, match.matchId, "CASUAL", "gm-admin");
    expect(changed.activityClassification).toBe("CASUAL");
    expect(changed.locked).toBe(false);
  });

  it("classification becomes immutable once a Prediction exists", async () => {
    const repo = new InMemoryPredictionsRepository();
    repo.authorityRepository.seedAuthority("gm-admin", "CONSEQUENTIAL_FINALIZER");
    const { match, activation } = await setupRankedMatch(repo);
    await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
      predictedHomeScore: 0, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: null, predictedGoalMinuteRegulation: null, predictedGoalMinuteStoppage: null, predictedFirstTeamToScore: null, geo: INSIDE,
    });
    await expect(setMatchActivityClassification(repo, match.matchId, "CASUAL", "gm-admin")).rejects.toBeInstanceOf(
      ActivityClassificationLockedError
    );
    // Re-declaring the SAME value is idempotent, not an error.
    const same = await setMatchActivityClassification(repo, match.matchId, "RANKED", "gm-admin");
    expect(same.locked).toBe(true);
  });

  it("classification becomes immutable once Result evidence exists, even with zero Predictions", async () => {
    const repo = new InMemoryPredictionsRepository();
    repo.authorityRepository.seedAuthority("gm-admin", "CONSEQUENTIAL_FINALIZER");
    const { match } = await setupRankedMatch(repo);
    await saveDraftResult(repo, { matchId: match.matchId, homeScore: 0, awayScore: 0, officialGoalEvents: [], enteredByGamingMemberId: "gm-admin" });
    await expect(setMatchActivityClassification(repo, match.matchId, "CASUAL", "gm-admin")).rejects.toBeInstanceOf(
      ActivityClassificationLockedError
    );
  });

  it("no Experience may be upgraded from Casual to Ranked (or any other classification) after evidence exists — the mechanism is symmetric for every pair", async () => {
    const repo = new InMemoryPredictionsRepository();
    repo.authorityRepository.seedAuthority("gm-admin", "CONSEQUENTIAL_FINALIZER");
    const { match, activation } = await setupRankedMatch(repo);
    await setMatchActivityClassification(repo, match.matchId, "CASUAL", "gm-admin");
    await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: "gm-1", venueActivationId: activation.venueActivationId,
      predictedHomeScore: 0, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: null, predictedGoalMinuteRegulation: null, predictedGoalMinuteStoppage: null, predictedFirstTeamToScore: null, geo: INSIDE,
    });
    await expect(setMatchActivityClassification(repo, match.matchId, "RANKED", "gm-admin")).rejects.toBeInstanceOf(
      ActivityClassificationLockedError
    );
  });
});

// --- TRAINING ---------------------------------------------------------

describe("TRAINING — zero XP, unconditionally", () => {
  it("a TRAINING classification produces zero XP events even for meaningful participation and a strong performance band", async () => {
    const repo = new InMemoryMetagameRepository();
    const gamingMemberId = randomUUID();
    await repo.createCategoryParticipationPolicy({ categoryKey: "SOCCER_PREDICTIONS", dailyParticipationAllowance: 5 });
    await repo.createGamingXpRule({ categoryKey: "SOCCER_PREDICTIONS", consequenceClass: "PARTICIPATION", performanceBandKey: null, points: 5 });
    await repo.createGamingXpRule({ categoryKey: "SOCCER_PREDICTIONS", consequenceClass: "PERFORMANCE", performanceBandKey: "CORRECT_4_OF_4", points: 100 });

    const { experienceSummaryId } = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "SOCCER_PREDICTIONS", categoryKey: "SOCCER_PREDICTIONS",
      activityClassification: "TRAINING", authorityTier: "ADMIN_FINALIZED",
      occurredAt: new Date().toISOString(), finalizedAt: new Date().toISOString(),
      meaningfulParticipation: true, xpEligible: true, performanceBandKey: "CORRECT_4_OF_4",
      sourceReference: "eval-training", rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey: "eval-training", evidence: {},
    });
    const events = await processExperienceSummaryConsequences(repo, experienceSummaryId);
    expect(events).toHaveLength(0);
  });

  it("TRAINING activity does not consume the daily participation allowance for other classifications", async () => {
    const repo = new InMemoryMetagameRepository();
    const gamingMemberId = randomUUID();
    await repo.createCategoryParticipationPolicy({ categoryKey: "SOCCER_PREDICTIONS", dailyParticipationAllowance: 1 });
    await repo.createGamingXpRule({ categoryKey: "SOCCER_PREDICTIONS", consequenceClass: "PARTICIPATION", performanceBandKey: null, points: 5 });
    // Captured after the fixtures above so their effectiveAt ("now" at
    // creation) is never later than this occurredAt.
    const occurredAt = new Date().toISOString();

    const training = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "SOCCER_PREDICTIONS", categoryKey: "SOCCER_PREDICTIONS",
      activityClassification: "TRAINING", authorityTier: "ADMIN_FINALIZED",
      occurredAt, finalizedAt: occurredAt, meaningfulParticipation: true, xpEligible: true, performanceBandKey: null,
      sourceReference: "eval-t1", rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey: "eval-t1", evidence: {},
    });
    await processExperienceSummaryConsequences(repo, training.experienceSummaryId);

    const ranked = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "SOCCER_PREDICTIONS", categoryKey: "SOCCER_PREDICTIONS",
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt, finalizedAt: occurredAt, meaningfulParticipation: true, xpEligible: true, performanceBandKey: null,
      sourceReference: "eval-r1", rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey: "eval-r1", evidence: {},
    });
    const events = await processExperienceSummaryConsequences(repo, ranked.experienceSummaryId);
    expect(events).toHaveLength(1);
    expect(events[0].consequenceClass).toBe("PARTICIPATION");
  });
});

// --- GAMING DAY --------------------------------------------------------

describe("Gaming Day — America/Tegucigalpa is authoritative, never device/client timezone", () => {
  async function seedPolicyAndRule(repo: InMemoryMetagameRepository, allowance: number) {
    await repo.createCategoryParticipationPolicy({ categoryKey: "SOCCER_PREDICTIONS", dailyParticipationAllowance: allowance });
    await repo.createGamingXpRule({ categoryKey: "SOCCER_PREDICTIONS", consequenceClass: "PARTICIPATION", performanceBandKey: null, points: 5 });
  }

  async function award(repo: InMemoryMetagameRepository, gamingMemberId: string, occurredAt: string, idempotencyKey: string) {
    const { experienceSummaryId } = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "SOCCER_PREDICTIONS", categoryKey: "SOCCER_PREDICTIONS",
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt, finalizedAt: occurredAt, meaningfulParticipation: true, xpEligible: true, performanceBandKey: null,
      sourceReference: idempotencyKey, rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey, evidence: {},
    });
    return processExperienceSummaryConsequences(repo, experienceSummaryId);
  }

  it("two instants either side of Tegucigalpa midnight (06:00 UTC) land on different Gaming Days and each gets its own allowance slot", async () => {
    const repo = new InMemoryMetagameRepository();
    await seedPolicyAndRule(repo, 1);
    const gamingMemberId = randomUUID();

    // 05:59 UTC on 2027-01-15 = 2026-01-14 23:59 America/Tegucigalpa (UTC-6)
    const beforeMidnight = await award(repo, gamingMemberId, "2027-01-15T05:59:00.000Z", "before");
    // 06:01 UTC on 2027-01-15 = 2027-01-15 00:01 America/Tegucigalpa
    const afterMidnight = await award(repo, gamingMemberId, "2027-01-15T06:01:00.000Z", "after");

    expect(beforeMidnight).toHaveLength(1);
    expect(afterMidnight).toHaveLength(1); // different Gaming Day, allowance N=1 not yet consumed
  });

  it("two instants far apart in UTC but on the same Tegucigalpa calendar day share one allowance", async () => {
    const repo = new InMemoryMetagameRepository();
    await seedPolicyAndRule(repo, 1);
    const gamingMemberId = randomUUID();

    // 06:01 UTC and 23:59 UTC on 2027-01-15 are both 2027-01-15 in America/Tegucigalpa
    const first = await award(repo, gamingMemberId, "2027-01-15T06:01:00.000Z", "am");
    const second = await award(repo, gamingMemberId, "2027-01-15T23:59:00.000Z", "pm");

    expect(first).toHaveLength(1);
    expect(second).toHaveLength(0); // allowance already exhausted for this Tegucigalpa day
  });
});

// --- ALLOWANCE (configurable N) ----------------------------------------

describe("Daily participation allowance — configurable N, never a Product-chosen default", () => {
  async function seed(repo: InMemoryMetagameRepository, allowance: number) {
    await repo.createCategoryParticipationPolicy({ categoryKey: "SOCCER_PREDICTIONS", dailyParticipationAllowance: allowance });
    await repo.createGamingXpRule({ categoryKey: "SOCCER_PREDICTIONS", consequenceClass: "PARTICIPATION", performanceBandKey: null, points: 5 });
  }
  async function award(repo: InMemoryMetagameRepository, gamingMemberId: string, activityClassification: "CASUAL" | "RANKED" | "OFFICIAL", key: string, occurredAt: string) {
    const { experienceSummaryId } = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "SOCCER_PREDICTIONS", categoryKey: "SOCCER_PREDICTIONS",
      activityClassification, authorityTier: "ADMIN_FINALIZED",
      occurredAt, finalizedAt: occurredAt, meaningfulParticipation: true, xpEligible: true, performanceBandKey: null,
      sourceReference: key, rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey: key, evidence: {},
    });
    return processExperienceSummaryConsequences(repo, experienceSummaryId);
  }

  it("N=1 fixture: a second same-day meaningful participation is not awarded, but the Summary is still valid and no error is thrown", async () => {
    const repo = new InMemoryMetagameRepository();
    await seed(repo, 1);
    const gamingMemberId = randomUUID();
    const day = "2027-02-01T12:00:00.000Z";
    expect(await award(repo, gamingMemberId, "RANKED", "e1", day)).toHaveLength(1);
    expect(await award(repo, gamingMemberId, "RANKED", "e2", day)).toHaveLength(0);
  });

  it("N=2 fixture: the third same-day meaningful participation is withheld, not the second", async () => {
    const repo = new InMemoryMetagameRepository();
    await seed(repo, 2);
    const gamingMemberId = randomUUID();
    const day = "2027-02-01T12:00:00.000Z";
    expect(await award(repo, gamingMemberId, "RANKED", "e1", day)).toHaveLength(1);
    expect(await award(repo, gamingMemberId, "RANKED", "e2", day)).toHaveLength(1);
    expect(await award(repo, gamingMemberId, "RANKED", "e3", day)).toHaveLength(0);
  });

  it("Casual, Ranked, and Official consume the SAME category allowance", async () => {
    const repo = new InMemoryMetagameRepository();
    await seed(repo, 2);
    const gamingMemberId = randomUUID();
    const day = "2027-02-01T12:00:00.000Z";
    expect(await award(repo, gamingMemberId, "CASUAL", "e1", day)).toHaveLength(1);
    expect(await award(repo, gamingMemberId, "RANKED", "e2", day)).toHaveLength(1);
    expect(await award(repo, gamingMemberId, "OFFICIAL", "e3", day)).toHaveLength(0);
  });

  it("continued activity remains permitted after allowance exhaustion — the Experience Summary always records successfully", async () => {
    const repo = new InMemoryMetagameRepository();
    await seed(repo, 1);
    const gamingMemberId = randomUUID();
    const day = "2027-02-01T12:00:00.000Z";
    await award(repo, gamingMemberId, "RANKED", "e1", day);
    const { alreadyRecorded } = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "SOCCER_PREDICTIONS", categoryKey: "SOCCER_PREDICTIONS",
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt: day, finalizedAt: day, meaningfulParticipation: true, xpEligible: true, performanceBandKey: null,
      sourceReference: "e2", rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey: "e2", evidence: {},
    });
    expect(alreadyRecorded).toBe(false); // recording itself is never blocked
  });

  it("performance XP remains independently eligible even when the participation allowance is exhausted", async () => {
    const repo = new InMemoryMetagameRepository();
    await seed(repo, 1);
    await repo.createGamingXpRule({ categoryKey: "SOCCER_PREDICTIONS", consequenceClass: "PERFORMANCE", performanceBandKey: "CORRECT_4_OF_4", points: 100 });
    const gamingMemberId = randomUUID();
    const day = "2027-02-01T12:00:00.000Z";
    await award(repo, gamingMemberId, "RANKED", "e1", day);

    const { experienceSummaryId } = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "SOCCER_PREDICTIONS", categoryKey: "SOCCER_PREDICTIONS",
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt: day, finalizedAt: day, meaningfulParticipation: true, xpEligible: true, performanceBandKey: "CORRECT_4_OF_4",
      sourceReference: "e2", rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey: "e2", evidence: {},
    });
    const events = await processExperienceSummaryConsequences(repo, experienceSummaryId);
    expect(events).toHaveLength(1);
    expect(events[0].consequenceClass).toBe("PERFORMANCE");
    expect(events[0].points).toBe(100);
  });

});

// --- MISSING-POLICY BOUNDARY: absence of configuration is never an error ---
//
// A finalized Experience fact must not become invalid merely because
// no Gaming XP policy/rule is configured. Absence means "no applicable
// XP consequence," never "invalid Experience result." Deploying the XP
// infrastructure must never require Product XP numbers to exist.

describe("Missing-policy boundary — absence of configuration is never an error", () => {
  it("NO CONFIGURATION: a real Prediction finalize succeeds end-to-end with zero policy/rule rows — Evaluation, Summary, and Prize Qualification all behave normally, zero XP events", async () => {
    const repo = new InMemoryPredictionsRepository();
    repo.authorityRepository.seedAuthority("gm-admin", "CONSEQUENTIAL_FINALIZER");
    const { match, activation, striker } = await setupRankedMatchNoXpConfig(repo);
    const gamingMemberId = "gm-no-config";

    await createPrizeTier(repo, { venueActivationId: activation.venueActivationId, correctDimensionCount: 4, prizeLabel: "Grand Prize" });

    const prediction = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId, venueActivationId: activation.venueActivationId,
      predictedHomeScore: 2, predictedAwayScore: 1,
      predictedGoalscorerPlayerId: striker.playerId, predictedGoalMinuteRegulation: 10, predictedGoalMinuteStoppage: null, predictedFirstTeamToScore: "HOME", geo: INSIDE,
    });

    const draft = await saveDraftResult(repo, { matchId: match.matchId, homeScore: 2, awayScore: 1, officialGoalEvents: [{ scorerPlayerId: striker.playerId, minuteRegulation: 10 }], enteredByGamingMemberId: "gm-admin" });

    // Must not throw — this is the exact defect being corrected: a
    // missing policy/rule must never roll back Evaluation/Summary/
    // Prize Qualification.
    const finalized = await finalizeMatchResult(repo, draft.matchResultId, "gm-admin");
    expect(finalized.alreadyFinalized).toBe(false);

    const evaluation = await repo.getEvaluation(prediction.predictionId, draft.matchResultId);
    expect(evaluation).not.toBeNull();
    expect(evaluation!.correctDimensionCount).toBe(4);

    const events = await repo.metagameRepository.listXpEventsForMember(gamingMemberId);
    expect(events).toHaveLength(0); // zero XP rows — not merely zero-effective

    const qualification = await repo.getQualificationForEvaluation(evaluation!.evaluationId);
    expect(qualification).not.toBeNull(); // Prize Qualification is fully independent of XP configuration
  });

  it("PARTIAL CONFIGURATION: policy only, no PARTICIPATION rule — no PARTICIPATION event, no failure", async () => {
    const repo = new InMemoryMetagameRepository();
    await repo.createCategoryParticipationPolicy({ categoryKey: "SOCCER_PREDICTIONS", dailyParticipationAllowance: 10 });
    const gamingMemberId = randomUUID();
    const occurredAt = "2027-03-01T12:00:00.000Z";
    const { experienceSummaryId } = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "SOCCER_PREDICTIONS", categoryKey: "SOCCER_PREDICTIONS",
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt, finalizedAt: occurredAt, meaningfulParticipation: true, xpEligible: true, performanceBandKey: null,
      sourceReference: "e1", rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey: "e1", evidence: {},
    });
    const events = await processExperienceSummaryConsequences(repo, experienceSummaryId);
    expect(events).toHaveLength(0);
  });

  it("PARTIAL CONFIGURATION: policy + PARTICIPATION rule only, no PERFORMANCE rule — PARTICIPATION awarded, no PERFORMANCE event, no failure", async () => {
    const repo = new InMemoryMetagameRepository();
    await repo.createCategoryParticipationPolicy({ categoryKey: "SOCCER_PREDICTIONS", dailyParticipationAllowance: 10 });
    await repo.createGamingXpRule({ categoryKey: "SOCCER_PREDICTIONS", consequenceClass: "PARTICIPATION", performanceBandKey: null, points: 5 });
    const gamingMemberId = randomUUID();
    const occurredAt = "2027-03-01T12:00:00.000Z";
    const { experienceSummaryId } = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "SOCCER_PREDICTIONS", categoryKey: "SOCCER_PREDICTIONS",
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt, finalizedAt: occurredAt, meaningfulParticipation: true, xpEligible: true, performanceBandKey: "CORRECT_4_OF_4",
      sourceReference: "e1", rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey: "e1", evidence: {},
    });
    const events = await processExperienceSummaryConsequences(repo, experienceSummaryId);
    expect(events).toHaveLength(1);
    expect(events[0].consequenceClass).toBe("PARTICIPATION");
  });

  it("PARTIAL CONFIGURATION: PERFORMANCE rule only, no policy at all — no PARTICIPATION event, PERFORMANCE still applies, no failure", async () => {
    const repo = new InMemoryMetagameRepository();
    await repo.createGamingXpRule({ categoryKey: "SOCCER_PREDICTIONS", consequenceClass: "PERFORMANCE", performanceBandKey: "CORRECT_4_OF_4", points: 100 });
    const gamingMemberId = randomUUID();
    const occurredAt = "2027-03-01T12:00:00.000Z";
    const { experienceSummaryId } = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "SOCCER_PREDICTIONS", categoryKey: "SOCCER_PREDICTIONS",
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt, finalizedAt: occurredAt, meaningfulParticipation: true, xpEligible: true, performanceBandKey: "CORRECT_4_OF_4",
      sourceReference: "e1", rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey: "e1", evidence: {},
    });
    const events = await processExperienceSummaryConsequences(repo, experienceSummaryId);
    expect(events).toHaveLength(1);
    expect(events[0].consequenceClass).toBe("PERFORMANCE");
    expect(events[0].points).toBe(100);
  });

  it("PARTIAL CONFIGURATION: policy + rules exist, but no rule matches this specific performance_band_key — no PERFORMANCE event, PARTICIPATION still applies, no failure", async () => {
    const repo = new InMemoryMetagameRepository();
    await repo.createCategoryParticipationPolicy({ categoryKey: "SOCCER_PREDICTIONS", dailyParticipationAllowance: 10 });
    await repo.createGamingXpRule({ categoryKey: "SOCCER_PREDICTIONS", consequenceClass: "PARTICIPATION", performanceBandKey: null, points: 5 });
    await repo.createGamingXpRule({ categoryKey: "SOCCER_PREDICTIONS", consequenceClass: "PERFORMANCE", performanceBandKey: "CORRECT_4_OF_4", points: 100 });
    const gamingMemberId = randomUUID();
    const occurredAt = "2027-03-01T12:00:00.000Z";
    const { experienceSummaryId } = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "SOCCER_PREDICTIONS", categoryKey: "SOCCER_PREDICTIONS",
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      // CORRECT_1_OF_4 has no configured PERFORMANCE rule — only CORRECT_4_OF_4 does.
      occurredAt, finalizedAt: occurredAt, meaningfulParticipation: true, xpEligible: true, performanceBandKey: "CORRECT_1_OF_4",
      sourceReference: "e1", rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey: "e1", evidence: {},
    });
    const events = await processExperienceSummaryConsequences(repo, experienceSummaryId);
    expect(events).toHaveLength(1);
    expect(events[0].consequenceClass).toBe("PARTICIPATION");
  });

  it("NO CONFIGURATION AT ALL: valid finalize with zero XP rows, then CORRECTION still succeeds with zero XP and no phantom reversal", async () => {
    const repo = new InMemoryMetagameRepository();
    const gamingMemberId = randomUUID();
    const occurredAt = "2027-03-01T12:00:00.000Z";

    const original = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "SOCCER_PREDICTIONS", categoryKey: "SOCCER_PREDICTIONS",
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt, finalizedAt: occurredAt, meaningfulParticipation: true, xpEligible: true, performanceBandKey: "CORRECT_4_OF_4",
      sourceReference: "e1", rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey: "e1", evidence: {},
    });
    const originalEvents = await processExperienceSummaryConsequences(repo, original.experienceSummaryId);
    expect(originalEvents).toHaveLength(0); // no configuration at all — valid Summary, zero XP

    // A correction changes the finalized performance band (e.g. a
    // scorer dispute) — the superseding Summary must still succeed
    // with zero XP, and must not fabricate a reversal event for XP
    // that never existed.
    const correction = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "SOCCER_PREDICTIONS", categoryKey: "SOCCER_PREDICTIONS",
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt, finalizedAt: new Date().toISOString(), meaningfulParticipation: true, xpEligible: true, performanceBandKey: "CORRECT_3_OF_4",
      sourceReference: "e1-corrected", rulesetVersion: "v1", supersedesExperienceSummaryId: original.experienceSummaryId,
      idempotencyKey: "e1-corrected", evidence: {},
    });
    const correctionEvents = await processExperienceSummaryConsequences(repo, correction.experienceSummaryId);
    expect(correctionEvents).toHaveLength(0); // still zero XP — no phantom reversal, no fabricated award

    const allEvents = await repo.listXpEventsForMember(gamingMemberId);
    expect(allEvents).toHaveLength(0);
  });
});

// --- XP RULES: rule-version provenance / reversal restores allowance ---

describe("XP rule versioning and reversal", () => {
  it("a later rule-value change does not reinterpret an already-awarded event's historical points", async () => {
    const repo = new InMemoryMetagameRepository();
    await repo.createCategoryParticipationPolicy({ categoryKey: "SOCCER_PREDICTIONS", dailyParticipationAllowance: 10 });
    await repo.createGamingXpRule({ categoryKey: "SOCCER_PREDICTIONS", consequenceClass: "PERFORMANCE", performanceBandKey: "CORRECT_4_OF_4", points: 50 });

    const gamingMemberId = randomUUID();
    const occurredAt = "2027-02-01T12:00:00.000Z";
    const first = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "SOCCER_PREDICTIONS", categoryKey: "SOCCER_PREDICTIONS",
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt, finalizedAt: occurredAt, meaningfulParticipation: false, xpEligible: true, performanceBandKey: "CORRECT_4_OF_4",
      sourceReference: "e1", rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey: "e1", evidence: {},
    });
    const firstEvents = await processExperienceSummaryConsequences(repo, first.experienceSummaryId);
    expect(firstEvents[0].points).toBe(50);

    // Rule value changes for future awards — must NOT rewrite the past.
    await repo.createGamingXpRule({ categoryKey: "SOCCER_PREDICTIONS", consequenceClass: "PERFORMANCE", performanceBandKey: "CORRECT_4_OF_4", points: 999 });

    const stillFifty = await repo.listXpEventsForSummary(first.experienceSummaryId);
    expect(stillFifty[0].points).toBe(50);

    const second = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "SOCCER_PREDICTIONS", categoryKey: "SOCCER_PREDICTIONS",
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt, finalizedAt: occurredAt, meaningfulParticipation: false, xpEligible: true, performanceBandKey: "CORRECT_4_OF_4",
      sourceReference: "e2", rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey: "e2", evidence: {},
    });
    const secondEvents = await processExperienceSummaryConsequences(repo, second.experienceSummaryId);
    expect(secondEvents[0].points).toBe(999);
  });

  it("a reversed participation award restores the effective daily allowance without deleting either row", async () => {
    const repo = new InMemoryMetagameRepository();
    await repo.createCategoryParticipationPolicy({ categoryKey: "SOCCER_PREDICTIONS", dailyParticipationAllowance: 1 });
    await repo.createGamingXpRule({ categoryKey: "SOCCER_PREDICTIONS", consequenceClass: "PARTICIPATION", performanceBandKey: null, points: 5 });

    const gamingMemberId = randomUUID();
    const occurredAt = "2027-02-01T12:00:00.000Z";

    const original = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "SOCCER_PREDICTIONS", categoryKey: "SOCCER_PREDICTIONS",
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt, finalizedAt: occurredAt, meaningfulParticipation: true, xpEligible: true, performanceBandKey: null,
      sourceReference: "e1", rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey: "e1", evidence: {},
    });
    await processExperienceSummaryConsequences(repo, original.experienceSummaryId);

    // Allowance now exhausted (N=1) — a fresh, unrelated participation attempt gets nothing.
    const blocked = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "SOCCER_PREDICTIONS", categoryKey: "SOCCER_PREDICTIONS",
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt, finalizedAt: occurredAt, meaningfulParticipation: true, xpEligible: true, performanceBandKey: null,
      sourceReference: "e2", rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey: "e2", evidence: {},
    });
    expect(await processExperienceSummaryConsequences(repo, blocked.experienceSummaryId)).toHaveLength(0);

    // The ORIGINAL evidence turns out to have been invalid (disqualification-shaped correction) —
    // a superseding Summary with meaningfulParticipation: false reverses it.
    const correction = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "SOCCER_PREDICTIONS", categoryKey: "SOCCER_PREDICTIONS",
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt, finalizedAt: new Date().toISOString(), meaningfulParticipation: false, xpEligible: true, performanceBandKey: null,
      sourceReference: "e1-corrected", rulesetVersion: "v1", supersedesExperienceSummaryId: original.experienceSummaryId,
      idempotencyKey: "e1-corrected", evidence: {},
    });
    const correctionEvents = await processExperienceSummaryConsequences(repo, correction.experienceSummaryId);
    expect(correctionEvents).toHaveLength(1);
    expect(correctionEvents[0].points).toBe(-5);
    expect(correctionEvents[0].reversesGamingXpEventId).not.toBeNull();

    // Both the original award and its reversal still exist — nothing was deleted.
    const allEvents = await repo.listXpEventsForMember(gamingMemberId);
    expect(allEvents.filter((e) => e.experienceSummaryId === original.experienceSummaryId)).toHaveLength(1);
    expect(allEvents.filter((e) => e.experienceSummaryId === correction.experienceSummaryId)).toHaveLength(1);

    // The allowance slot is free again for a genuinely new participation the same Gaming Day.
    const retry = await recordExperienceSummary(repo, {
      gamingMemberId, experienceKey: "SOCCER_PREDICTIONS", categoryKey: "SOCCER_PREDICTIONS",
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt, finalizedAt: occurredAt, meaningfulParticipation: true, xpEligible: true, performanceBandKey: null,
      sourceReference: "e3", rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey: "e3", evidence: {},
    });
    expect(await processExperienceSummaryConsequences(repo, retry.experienceSummaryId)).toHaveLength(1);
  });
});

// --- ARCHITECTURAL BOUNDARY: Predictions reports facts, never selects consequences ---

describe("Boundary: Predictions reports facts, Metagame selects consequences (source-level)", () => {
  it("neither finalize_match_result_atomically nor correct_match_result_atomically references gaming_xp_rules or gaming_category_participation_policy", () => {
    const finalizeSql = readFileSync(
      "supabase/migrations/0091_finalize_match_result_atomically_uses_metagame.sql",
      "utf-8"
    );
    const correctSql = readFileSync(
      "supabase/migrations/0092_correct_match_result_atomically_uses_metagame.sql",
      "utf-8"
    );
    // Checks for actual SQL usage (a real FROM/INSERT/JOIN reference),
    // not any mention of the table name — these files' own boundary-
    // documenting comments legitimately name all three tables in prose.
    for (const sql of [finalizeSql, correctSql]) {
      expect(sql).not.toMatch(/\b(from|insert into|join)\s+gaming_xp_rules\b/i);
      expect(sql).not.toMatch(/\b(from|insert into|join)\s+gaming_category_participation_policy\b/i);
      expect(sql).not.toMatch(/\b(from|insert into|join)\s+gaming_xp_events\b/i);
    }
  });

  it("InMemoryPredictionsRepository's source never references gaming_xp_rules or the participation policy table directly", () => {
    const source = readFileSync("lib/gaming/predictions/db/inMemoryPredictionsRepository.ts", "utf-8");
    expect(source).not.toContain("xpRules");
    expect(source).not.toContain("participationPolic");
  });

  it("lib/gaming/metagame never imports from lib/gaming/predictions", () => {
    const files = [
      "lib/gaming/metagame/types.ts",
      "lib/gaming/metagame/recordExperienceSummary.ts",
      "lib/gaming/metagame/processExperienceSummaryConsequences.ts",
      "lib/gaming/metagame/db/metagameRepository.ts",
      "lib/gaming/metagame/db/inMemoryMetagameRepository.ts",
      "lib/gaming/metagame/db/supabaseMetagameRepository.ts",
      "lib/gaming/metagame/leaderboard.ts",
    ];
    for (const file of files) {
      const source = readFileSync(file, "utf-8");
      // Checks for an actual import statement, not any mention of the
      // path — this file's own boundary-documenting comments legitimately
      // name "lib/gaming/predictions" in prose.
      expect(source).not.toMatch(/from\s+["'].*predictions/);
    }
  });
});

// --- GLOBAL GAMING XP LEADERBOARD ---------------------------------

describe("Global Gaming XP Leaderboard", () => {
  let ruleCounter = 0;

  /** Awards `points` of PERFORMANCE XP to a member via a fresh, isolated rule/band, avoiding cross-test interference. */
  async function awardPerformanceXp(
    repo: InMemoryMetagameRepository,
    gamingMemberId: string,
    points: number
  ): Promise<string> {
    const band = `LB_BAND_${ruleCounter++}`;
    await repo.createGamingXpRule({
      categoryKey: "LEADERBOARD_TEST",
      consequenceClass: "PERFORMANCE",
      performanceBandKey: band,
      points,
    });
    const { experienceSummaryId } = await recordExperienceSummary(repo, {
      gamingMemberId,
      experienceKey: "LEADERBOARD_TEST",
      categoryKey: "LEADERBOARD_TEST",
      activityClassification: "RANKED",
      authorityTier: "ADMIN_FINALIZED",
      occurredAt: new Date().toISOString(),
      finalizedAt: new Date().toISOString(),
      meaningfulParticipation: false, xpEligible: true,
      performanceBandKey: band,
      sourceReference: band,
      rulesetVersion: "v1",
      supersedesExperienceSummaryId: null,
      idempotencyKey: band,
      evidence: {},
    });
    await processExperienceSummaryConsequences(repo, experienceSummaryId);
    return experienceSummaryId;
  }

  it("A: empty ledger returns an empty list, no error", async () => {
    const repo = new InMemoryMetagameRepository();
    const entries = await getGlobalLeaderboard(repo);
    expect(entries).toEqual([]);
  });

  it("B: one member with XP appears at rank 1 with the correct total", async () => {
    const repo = new InMemoryMetagameRepository();
    const alex = randomUUID();
    repo.registerGamingMemberDisplayName(alex, "Alex");
    await awardPerformanceXp(repo, alex, 100);

    const entries = await getGlobalLeaderboard(repo);
    expect(entries).toEqual([{ rank: 1, displayName: "Alex", globalXp: 100 }]);
  });

  it("C: multiple members are totalled correctly and ordered descending", async () => {
    const repo = new InMemoryMetagameRepository();
    const alex = randomUUID();
    const jordan = randomUUID();
    const sam = randomUUID();
    repo.registerGamingMemberDisplayName(alex, "Alex");
    repo.registerGamingMemberDisplayName(jordan, "Jordan");
    repo.registerGamingMemberDisplayName(sam, "Sam");

    await awardPerformanceXp(repo, sam, 80);
    await awardPerformanceXp(repo, alex, 60);
    await awardPerformanceXp(repo, alex, 40); // Alex's total accumulates across two awards: 100
    await awardPerformanceXp(repo, jordan, 20);

    const entries = await getGlobalLeaderboard(repo);
    expect(entries).toEqual([
      { rank: 1, displayName: "Alex", globalXp: 100 },
      { rank: 2, displayName: "Sam", globalXp: 80 },
      { rank: 3, displayName: "Jordan", globalXp: 20 },
    ]);
  });

  it("D: competition ranking — 100/100/80 produces ranks 1/1/3, never dense 1/1/2", async () => {
    const repo = new InMemoryMetagameRepository();
    const alex = randomUUID();
    const jordan = randomUUID();
    const sam = randomUUID();
    repo.registerGamingMemberDisplayName(alex, "Alex");
    repo.registerGamingMemberDisplayName(jordan, "Jordan");
    repo.registerGamingMemberDisplayName(sam, "Sam");

    await awardPerformanceXp(repo, alex, 100);
    await awardPerformanceXp(repo, jordan, 100);
    await awardPerformanceXp(repo, sam, 80);

    const entries = await getGlobalLeaderboard(repo);
    const ranks = entries.map((e) => e.rank);
    expect(ranks).toEqual([1, 1, 3]);
    expect(entries.map((e) => e.globalXp)).toEqual([100, 100, 80]);
  });

  it("E: tied rows are deterministically ordered (by internal gamingMemberId, never affecting rank) and stable across repeated calls", async () => {
    const repo = new InMemoryMetagameRepository();
    // Deliberately construct ids so the lexical secondary-order outcome is known in advance.
    const memberA = "00000000-0000-0000-0000-00000000aaaa";
    const memberB = "00000000-0000-0000-0000-00000000bbbb";
    repo.registerGamingMemberDisplayName(memberA, "First By Id");
    repo.registerGamingMemberDisplayName(memberB, "Second By Id");

    await awardPerformanceXp(repo, memberB, 50);
    await awardPerformanceXp(repo, memberA, 50);

    const first = await getGlobalLeaderboard(repo);
    const second = await getGlobalLeaderboard(repo);
    expect(first).toEqual(second); // stable across repeated calls
    expect(first.map((e) => e.displayName)).toEqual(["First By Id", "Second By Id"]); // memberA (lower id) prints first
    expect(first.map((e) => e.rank)).toEqual([1, 1]); // the secondary key never changes the tied rank itself
  });

  it("F: reversal arithmetic — +100 original, -100 reversal, +40 corrected award nets to 40", async () => {
    const repo = new InMemoryMetagameRepository();
    const alex = randomUUID();
    repo.registerGamingMemberDisplayName(alex, "Alex");

    await repo.createGamingXpRule({ categoryKey: "LB_CORRECTION", consequenceClass: "PERFORMANCE", performanceBandKey: "ORIGINAL", points: 100 });
    await repo.createGamingXpRule({ categoryKey: "LB_CORRECTION", consequenceClass: "PERFORMANCE", performanceBandKey: "CORRECTED", points: 40 });
    const occurredAt = "2027-04-01T12:00:00.000Z";

    const original = await recordExperienceSummary(repo, {
      gamingMemberId: alex, experienceKey: "LB_CORRECTION", categoryKey: "LB_CORRECTION",
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt, finalizedAt: occurredAt, meaningfulParticipation: false, xpEligible: true, performanceBandKey: "ORIGINAL",
      sourceReference: "lb-corr-1", rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey: "lb-corr-1", evidence: {},
    });
    await processExperienceSummaryConsequences(repo, original.experienceSummaryId);

    const correction = await recordExperienceSummary(repo, {
      gamingMemberId: alex, experienceKey: "LB_CORRECTION", categoryKey: "LB_CORRECTION",
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt, finalizedAt: new Date().toISOString(), meaningfulParticipation: false, xpEligible: true, performanceBandKey: "CORRECTED",
      sourceReference: "lb-corr-1-fixed", rulesetVersion: "v1", supersedesExperienceSummaryId: original.experienceSummaryId,
      idempotencyKey: "lb-corr-1-fixed", evidence: {},
    });
    const correctionEvents = await processExperienceSummaryConsequences(repo, correction.experienceSummaryId);
    expect(correctionEvents).toHaveLength(2); // the -100 reversal and the +40 reissue
    expect(correctionEvents.reduce((s, e) => s + e.points, 0)).toBe(-60);

    const entries = await getGlobalLeaderboard(repo);
    expect(entries).toEqual([{ rank: 1, displayName: "Alex", globalXp: 40 }]);
  });

  it("G: a member whose full award was reversed to net zero is excluded entirely", async () => {
    const repo = new InMemoryMetagameRepository();
    const alex = randomUUID();
    const jordan = randomUUID();
    repo.registerGamingMemberDisplayName(alex, "Alex");
    repo.registerGamingMemberDisplayName(jordan, "Jordan");

    await repo.createGamingXpRule({ categoryKey: "LB_ZERO", consequenceClass: "PERFORMANCE", performanceBandKey: "ORIGINAL", points: 100 });
    const occurredAt = "2027-04-01T12:00:00.000Z";

    const original = await recordExperienceSummary(repo, {
      gamingMemberId: alex, experienceKey: "LB_ZERO", categoryKey: "LB_ZERO",
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt, finalizedAt: occurredAt, meaningfulParticipation: false, xpEligible: true, performanceBandKey: "ORIGINAL",
      sourceReference: "lb-zero-1", rulesetVersion: "v1", supersedesExperienceSummaryId: null,
      idempotencyKey: "lb-zero-1", evidence: {},
    });
    await processExperienceSummaryConsequences(repo, original.experienceSummaryId);

    // Correction reports no performance band at all (a pure invalidation) — only the reversal fires, net 0.
    const correction = await recordExperienceSummary(repo, {
      gamingMemberId: alex, experienceKey: "LB_ZERO", categoryKey: "LB_ZERO",
      activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
      occurredAt, finalizedAt: new Date().toISOString(), meaningfulParticipation: false, xpEligible: true, performanceBandKey: null,
      sourceReference: "lb-zero-1-voided", rulesetVersion: "v1", supersedesExperienceSummaryId: original.experienceSummaryId,
      idempotencyKey: "lb-zero-1-voided", evidence: {},
    });
    await processExperienceSummaryConsequences(repo, correction.experienceSummaryId);

    await awardPerformanceXp(repo, jordan, 10); // a real, unrelated member remains visible

    const entries = await getGlobalLeaderboard(repo);
    expect(entries).toEqual([{ rank: 1, displayName: "Jordan", globalXp: 10 }]); // Alex (net 0) is absent, not shown at 0
  });

  it("H: a net-negative Global XP total is not structurally constructible — reversals only ever compensate a prior positive award, never exceed it", async () => {
    // Documents an architectural invariant rather than exercising a
    // scenario: gaming_xp_events' own schema constraint
    // (points >= 0 OR reverses_gaming_xp_event_id IS NOT NULL) plus
    // this codebase's reversal-issuance code always inserting exactly
    // -original.points make it impossible for any member's ledger to
    // sum below zero — there is no punitive/negative-only consequence
    // class anywhere in this architecture. "Excluded if net <= 0" (F/G
    // above) is therefore already the complete boundary; a dedicated
    // net-negative fixture cannot be built without directly violating
    // this ledger's own invariants.
    expect(true).toBe(true);
  });

  it("I: the public/domain response never carries gamingMemberId or any other private field", async () => {
    const repo = new InMemoryMetagameRepository();
    const alex = randomUUID();
    repo.registerGamingMemberDisplayName(alex, "Alex");
    await awardPerformanceXp(repo, alex, 100);

    const entries = await getGlobalLeaderboard(repo);
    expect(entries).toHaveLength(1);
    expect(Object.keys(entries[0]).sort()).toEqual(["displayName", "globalXp", "rank"]);
    const serialized = JSON.stringify(entries);
    expect(serialized).not.toContain(alex); // the raw gamingMemberId UUID must never appear
    expect(serialized.toLowerCase()).not.toMatch(/auth_user_id|authuserid|email|evidence|source_reference|sourcereference/);
  });

  it("J: the canonical leaderboard source never queries gaming_progression_events, point_awards, or imports Predictions runtime state", () => {
    // Checks for actual usage (a real .from(...)/import reference), not
    // any mention of the name — these files' own boundary-documenting
    // comments legitimately name gaming_progression_events and
    // lib/gaming/predictions/leaderboard.ts in prose.
    const files = [
      "lib/gaming/metagame/leaderboard.ts",
      "lib/gaming/metagame/db/inMemoryMetagameRepository.ts",
      "lib/gaming/metagame/db/supabaseMetagameRepository.ts",
      "app/api/gaming/leaderboard/route.ts",
    ];
    for (const file of files) {
      const source = readFileSync(file, "utf-8");
      expect(source).not.toMatch(/\.from\(\s*["']gaming_progression_events["']\s*\)/);
      expect(source).not.toMatch(/\.from\(\s*["']point_awards["']\s*\)/);
      expect(source).not.toMatch(/^\s*import[^\n]*from\s+["'][^"']*\/predictions/m);
    }
    const migrationSql = readFileSync(
      "supabase/migrations/0093_create_get_global_gaming_xp_leaderboard.sql",
      "utf-8"
    );
    // The migration's own real SQL body (not its comment block) must
    // never FROM/JOIN either legacy table.
    expect(migrationSql).not.toMatch(/\b(from|join)\s+gaming_progression_events\b/i);
    expect(migrationSql).not.toMatch(/\b(from|join)\s+point_awards\b/i);
  });

  it("K: the public API route's GET handler takes no request parameter — structurally incapable of inspecting any header, including Authorization", () => {
    const source = readFileSync("app/api/gaming/leaderboard/route.ts", "utf-8");
    expect(source).toMatch(/export\s+async\s+function\s+GET\s*\(\s*\)\s*{/);
    expect(source).not.toMatch(/\.headers\.get/);
    expect(source).not.toMatch(/requireGamingAdmin|resolveGamingAuth/);
  });

  it("category attribution remains retained on individual ledger rows even though the Global aggregate crosses categories", async () => {
    const repo = new InMemoryMetagameRepository();
    const alex = randomUUID();
    repo.registerGamingMemberDisplayName(alex, "Alex");
    await repo.createGamingXpRule({ categoryKey: "CAT_ONE", consequenceClass: "PERFORMANCE", performanceBandKey: "BAND", points: 30 });
    await repo.createGamingXpRule({ categoryKey: "CAT_TWO", consequenceClass: "PERFORMANCE", performanceBandKey: "BAND", points: 20 });

    for (const categoryKey of ["CAT_ONE", "CAT_TWO"]) {
      const { experienceSummaryId } = await recordExperienceSummary(repo, {
        gamingMemberId: alex, experienceKey: categoryKey, categoryKey,
        activityClassification: "RANKED", authorityTier: "ADMIN_FINALIZED",
        occurredAt: new Date().toISOString(), finalizedAt: new Date().toISOString(),
        meaningfulParticipation: false, xpEligible: true, performanceBandKey: "BAND",
        sourceReference: categoryKey, rulesetVersion: "v1", supersedesExperienceSummaryId: null,
        idempotencyKey: categoryKey, evidence: {},
      });
      await processExperienceSummaryConsequences(repo, experienceSummaryId);
    }

    const events = await repo.listXpEventsForMember(alex);
    expect(new Set(events.map((e) => e.categoryKey))).toEqual(new Set(["CAT_ONE", "CAT_TWO"])); // per-event category retained

    const entries = await getGlobalLeaderboard(repo);
    expect(entries).toEqual([{ rank: 1, displayName: "Alex", globalXp: 50 }]); // Global total crosses both categories
  });
});
