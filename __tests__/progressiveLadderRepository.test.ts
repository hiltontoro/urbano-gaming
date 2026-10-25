import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";

import { InMemoryPredictionsRepository } from "../lib/gaming/predictions/db/inMemoryPredictionsRepository";
import { submitPrediction } from "../lib/gaming/predictions/submitPrediction";
import { computeLadderOffer } from "../lib/gaming/predictions/prizeLadder";
import { statusForPredictionsError } from "../lib/gaming/predictions/httpAuth";
import * as domainTypes from "../lib/gaming/predictions/types";
import {
  ContractFrozenError,
  ContractMismatchError,
  GeoNotEligibleError,
  GeoUnavailableError,
  InvalidAttemptShapeError,
  InvalidGoalscorerSelectionError,
  KickoffPassedError,
  LevelNotOfferedError,
  MatchCancelledError,
  OfferChangedError,
  OfferDigestRequiredError,
  OfferFrozenError,
  OfferNotAvailableError,
  PrizeQualificationHeldError,
  ResultAlreadyFinalizedError,
  TierKeyContractMismatchError,
  VenueActivationDisabledError,
  VenueActivationImmutableError,
} from "../lib/gaming/predictions/types";
import {
  NEAR,
  answersFor,
  buildLadderWorld,
  expectSettled,
  goallessCases,
  offerDigestOf,
  officialGoals,
  settle,
  submitAs,
  twoOneCases,
  type LadderCase,
  type LadderEnv,
  type LadderWorld,
} from "./helpers/progressiveLadderScenarios";
import { progressivePredictionView } from "../lib/gaming/predictions/prizeLadder";
import { finalizeMatchResult, saveResult, currentSaveBase } from "./helpers/predictionsResultFixtures";

// The routes under test talk to the repository through this module only; the
// repository behind it is the real in-memory implementation.
vi.mock("@/lib/gaming/predictions/httpAuth", async () => {
  const actual = await vi.importActual<typeof import("../lib/gaming/predictions/httpAuth")>(
    "../lib/gaming/predictions/httpAuth"
  );
  return {
    ...actual,
    getSupabaseCredentials: vi.fn(),
    buildPredictionsRepo: vi.fn(),
    requireGamingMember: vi.fn(),
    requireAnyAdminAuthority: vi.fn(),
    requirePlatformAuthorityHttp: vi.fn(),
  };
});
import * as httpAuth from "../lib/gaming/predictions/httpAuth";

const FINALIZER = "gm-finalizer";

function freshEnv(): { env: LadderEnv; repo: InMemoryPredictionsRepository } {
  const repo = new InMemoryPredictionsRepository();
  repo.authorityRepository.seedAuthority(FINALIZER, "CONSEQUENTIAL_FINALIZER");
  return {
    repo,
    env: { repo, newMember: async (label) => `${label}-${randomUUID().slice(0, 8)}`, finalizerId: FINALIZER, operatorId: FINALIZER },
  };
}

function useRepo(repo: InMemoryPredictionsRepository) {
  vi.mocked(httpAuth.getSupabaseCredentials).mockReturnValue({ url: "http://127.0.0.1:1", serviceKey: "x" });
  vi.mocked(httpAuth.buildPredictionsRepo).mockReturnValue(repo as never);
}

// ---------------------------------------------------------------------------
// The scenario tables, on the in-memory repository
// ---------------------------------------------------------------------------

describe("scenario tables on the in-memory repository", () => {
  async function runGroup(cases: LadderCase[], official: "TWO_ONE" | "GOALLESS") {
    const { env } = freshEnv();
    const world = await buildLadderWorld(env, { offeredLevels: [1, 2, 3, 4] });
    const members: string[] = [];
    const predictions = [];
    for (const c of cases) {
      const memberId = await env.newMember("member");
      members.push(memberId);
      predictions.push(await submitAs(env, world, memberId, c.build(world)));
    }
    await settle(env, world, official);
    for (let i = 0; i < cases.length; i++) {
      await expectSettled(env, world, members[i], cases[i], predictions[i]);
    }
    return { env, world, members, predictions };
  }

  it("settles the 30 prefix cases (the 16 complete attempts are the level-4 ones) by the consecutive correct prefix", async () => {
    const cases = twoOneCases();
    expect(cases.filter((c) => c.expected.attempted === 4).length).toBe(16 + 1);
    await runGroup(cases, "TWO_ONE");
  });

  it("settles the goalless match: a NONE is right, a pick is wrong, a category not attempted is neither", async () => {
    await runGroup(goallessCases(), "GOALLESS");
  });

  it("0-0 with every category NONE reaches Legendary when all four levels are offered", async () => {
    const { world, members, env } = await runGroup(goallessCases(), "GOALLESS");
    const evaluation = await env.repo.getCurrentEvaluationForPrediction(
      (await env.repo.getPredictionForMember(world.matchId, members[0]))!.predictionId
    );
    expect(evaluation!.ladderLevel).toBe(4);
    const qualification = await env.repo.getQualificationForEvaluation(evaluation!.evaluationId);
    expect(qualification!.prizeTierId).toBe(world.tierIdByLevel[4]);
  });

  it("never creates more than one qualification per participation, and none that crosses levels", async () => {
    const { env, world, members } = await runGroup(twoOneCases(), "TWO_ONE");
    const all = await env.repo.listQualificationsForActivation(world.activationId);
    expect(new Set(all.map((q) => q.evaluationId)).size).toBe(all.length);
    for (const memberId of members) {
      expect(all.filter((q) => q.gamingMemberId === memberId && q.supersededAt === null).length).toBeLessThanOrEqual(1);
    }
  });
});

// ---------------------------------------------------------------------------
// The offer: only a consecutive prefix starting at Easy takes participations
// ---------------------------------------------------------------------------

describe("the offered levels", () => {
  const pickAt = (world: LadderWorld, level: number) => answersFor(world, level, { S: true, F: true, G: true, M: true });

  it.each([[[1]], [[1, 2]], [[1, 2, 3]], [[1, 2, 3, 4]]])("levels %j: up to the last one can be attempted, nothing above", async (levels) => {
    const { env } = freshEnv();
    const world = await buildLadderWorld(env, { offeredLevels: levels });
    const max = levels.length;
    for (let level = 1; level <= max; level++) {
      const member = await env.newMember("m");
      const prediction = await submitAs(env, world, member, pickAt(world, level));
      expect(prediction.attemptedLevel).toBe(level);
      expect(prediction.acceptedOfferMaxLevel).toBe(max);
    }
    if (max < 4) {
      const member = await env.newMember("m");
      await expect(submitAs(env, world, member, pickAt(world, max + 1))).rejects.toBeInstanceOf(LevelNotOfferedError);
      expect(await env.repo.getPredictionForMember(world.matchId, member)).toBeNull();
    }
  });

  it.each([
    ["no prizes at all", [] as number[]],
    ["Medium alone", [2]],
    ["Easy and Hard without Medium", [1, 3]],
    ["Easy, Medium and Legendary without Hard", [1, 2, 4]],
    ["Hard and Legendary without Easy", [3, 4]],
    ["Legendary alone", [4]],
  ])("an activation with %s takes no new participation, at any level", async (_name, levels) => {
    const { env } = freshEnv();
    const world = await buildLadderWorld(env, { offeredLevels: levels });
    const offer = computeLadderOffer(await env.repo.listPrizeTiersForActivation(world.activationId));
    expect(offer.available).toBe(false);
    for (const level of [1, 2, 3, 4]) {
      const member = await env.newMember("m");
      await expect(
        submitAs(env, world, member, pickAt(world, level), { offerDigest: "anything-at-all" })
      ).rejects.toBeInstanceOf(OfferNotAvailableError);
      expect(await env.repo.getPredictionForMember(world.matchId, member)).toBeNull();
    }
  });

  it("does not descend to another prize: a level without a tier has none, and is never offered", async () => {
    const { env } = freshEnv();
    const world = await buildLadderWorld(env, { offeredLevels: [1, 2] });
    const member = await env.newMember("m");
    // Level 3 would need a Hard prize; the venue offers none, so it cannot even be attempted.
    await expect(submitAs(env, world, member, pickAt(world, 3))).rejects.toBeInstanceOf(LevelNotOfferedError);
  });

  it("refuses a historical count tier on a progressive match and a ladder tier on a historical one", async () => {
    const { env, repo } = freshEnv();
    const world = await buildLadderWorld(env, { offeredLevels: [1] });
    await expect(
      repo.createPrizeTier({ venueActivationId: world.activationId, correctDimensionCount: 4, prizeLabel: "Jersey" })
    ).rejects.toBeInstanceOf(TierKeyContractMismatchError);

    const home = await repo.createTeam({ name: "H" });
    const away = await repo.createTeam({ name: "A" });
    const legacy = await repo.createMatch({ homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Old", kickoffAt: new Date(Date.now() + 3600_000).toISOString() });
    expect(legacy.predictionContract).toBe("COMPLETE_COUNT_V1");
    const venue = await repo.createVenue({ name: "V", latitude: 10, longitude: 10, radiusMeters: 100 });
    const activation = await repo.createVenueActivation({ matchId: legacy.matchId, venueId: venue.venueId });
    await expect(
      repo.createLadderPrizeTier({ venueActivationId: activation.venueActivationId, ladderLevel: 1, prizeLabel: "Easy" })
    ).rejects.toBeInstanceOf(TierKeyContractMismatchError);
    await expect(
      repo.createLadderPrizeTier({ venueActivationId: world.activationId, ladderLevel: 5, prizeLabel: "x" })
    ).rejects.toBeInstanceOf(domainTypes.InvalidPrizeTierLadderLevelError);
  });
});

// ---------------------------------------------------------------------------
// Protecting the accepted offer
// ---------------------------------------------------------------------------

describe("the accepted offer cannot change silently", () => {
  it("records the fingerprint and the highest level the member accepted", async () => {
    const { env } = freshEnv();
    const world = await buildLadderWorld(env, { offeredLevels: [1, 2, 3] });
    const member = await env.newMember("m");
    const prediction = await submitAs(env, world, member, answersFor(world, 2, { S: true, F: true, G: true, M: true }));
    expect(prediction.acceptedOfferDigest).toBe(await offerDigestOf(env, world));
    expect(prediction.acceptedOfferMaxLevel).toBe(3);
  });

  it("requires the fingerprint of the offer the member saw", async () => {
    const { env } = freshEnv();
    const world = await buildLadderWorld(env, { offeredLevels: [1, 2] });
    const member = await env.newMember("m");
    await expect(submitAs(env, world, member, answersFor(world, 1, { S: true, F: true, G: true, M: true }), { offerDigest: null })).rejects.toBeInstanceOf(
      OfferDigestRequiredError
    );
    await expect(submitAs(env, world, member, answersFor(world, 1, { S: true, F: true, G: true, M: true }), { offerDigest: "" })).rejects.toBeInstanceOf(
      OfferDigestRequiredError
    );
  });

  it("refuses a submission made against an offer that has since changed (before anyone accepted it)", async () => {
    const { env } = freshEnv();
    const world = await buildLadderWorld(env, { offeredLevels: [1, 2] });
    const seen = await offerDigestOf(env, world);
    // The venue adds a level after the page was loaded.
    await env.repo.createLadderPrizeTier({ venueActivationId: world.activationId, ladderLevel: 3, prizeLabel: "A new Hard prize" });
    const member = await env.newMember("m");
    await expect(
      submitAs(env, world, member, answersFor(world, 1, { S: true, F: true, G: true, M: true }), { offerDigest: seen })
    ).rejects.toBeInstanceOf(OfferChangedError);
    expect(await env.repo.getPredictionForMember(world.matchId, member)).toBeNull();
    // With the fingerprint of the current offer it goes through.
    const ok = await submitAs(env, world, member, answersFor(world, 3, { S: true, F: true, G: true, M: true }));
    expect(ok.acceptedOfferMaxLevel).toBe(3);
  });

  it("freezes the levels, the labels and the highest level offered from the first prediction", async () => {
    const { env, repo } = freshEnv();
    const world = await buildLadderWorld(env, { offeredLevels: [1, 2] });
    const first = await env.newMember("m");
    await submitAs(env, world, first, answersFor(world, 2, { S: true, F: true, G: true, M: true }));

    // A higher level cannot be added (that would change the highest level offered)...
    await expect(
      repo.createLadderPrizeTier({ venueActivationId: world.activationId, ladderLevel: 3, prizeLabel: "Late Hard" })
    ).rejects.toBeInstanceOf(OfferFrozenError);
    // ...and a label cannot be edited.
    expect(() => repo.setPrizeLabelForTests(world.tierIdByLevel[1], "Cheaper prize")).toThrow(OfferFrozenError);
    expect(() => repo.setPrizeLabelForTests(world.tierIdByLevel[2], "Cheaper prize")).toThrow(OfferFrozenError);

    // Nothing changed: the offer is what the first participant accepted.
    const prediction = await repo.getPredictionForMember(world.matchId, first);
    expect(prediction!.acceptedOfferDigest).toBe(await offerDigestOf(env, world));
    expect((await repo.listPrizeTiersForActivation(world.activationId)).map((t) => t.prizeLabel).sort()).toEqual(["Prize L1", "Prize L2"]);
  });

  it("freezes each activation on its own: another venue of the same match stays configurable until its first prediction", async () => {
    const { env, repo } = freshEnv();
    const world = await buildLadderWorld(env, { offeredLevels: [1] });
    const second = await repo.createVenueActivation({ matchId: world.matchId, venueId: world.venueId });
    await repo.createLadderPrizeTier({ venueActivationId: second.venueActivationId, ladderLevel: 1, prizeLabel: "Other Easy" });
    const member = await env.newMember("m");
    await submitAs(env, world, member, answersFor(world, 1, { S: true, F: true, G: true, M: true }));
    // The first activation is frozen; the second is not.
    await expect(
      repo.createLadderPrizeTier({ venueActivationId: world.activationId, ladderLevel: 2, prizeLabel: "x" })
    ).rejects.toBeInstanceOf(OfferFrozenError);
    await expect(
      repo.createLadderPrizeTier({ venueActivationId: second.venueActivationId, ladderLevel: 2, prizeLabel: "Other Medium" })
    ).resolves.toBeTruthy();
  });

  it("keeps a revision on the same offer: the stored fingerprint is the same after an edit", async () => {
    const { env } = freshEnv();
    const world = await buildLadderWorld(env, { offeredLevels: [1, 2] });
    const member = await env.newMember("m");
    const first = await submitAs(env, world, member, answersFor(world, 1, { S: true, F: true, G: true, M: true }));
    const second = await submitAs(env, world, member, answersFor(world, 2, { S: true, F: true, G: true, M: true }));
    expect(second.acceptedOfferDigest).toBe(first.acceptedOfferDigest);
    expect(second.predictionId).toBe(first.predictionId);
  });

  it("does not freeze a historical match: its prizes can still be edited, as before", async () => {
    const { repo } = freshEnv();
    const home = await repo.createTeam({ name: "H" });
    const away = await repo.createTeam({ name: "A" });
    const match = await repo.createMatch({ homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Old", kickoffAt: new Date(Date.now() + 3600_000).toISOString() });
    const venue = await repo.createVenue({ name: "V", latitude: 10, longitude: 10, radiusMeters: 100 });
    const activation = await repo.createVenueActivation({ matchId: match.matchId, venueId: venue.venueId });
    const tier = await repo.createPrizeTier({ venueActivationId: activation.venueActivationId, correctDimensionCount: 4, prizeLabel: "Jersey" });
    expect(() => repo.setPrizeLabelForTests(tier.prizeTierId, "Better Jersey")).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// The contract of a match
// ---------------------------------------------------------------------------

describe("the prediction contract of a match", () => {
  it("is frozen from the first prediction", async () => {
    const { env, repo } = freshEnv();
    const world = await buildLadderWorld(env, { offeredLevels: [1] });
    const member = await env.newMember("m");
    await submitAs(env, world, member, answersFor(world, 1, { S: true, F: true, G: true, M: true }));
    await expect(repo.setMatchPredictionContract(world.matchId, "COMPLETE_COUNT_V1")).rejects.toBeInstanceOf(ContractFrozenError);
    expect((await repo.getMatchById(world.matchId))!.predictionContract).toBe("PROGRESSIVE_LADDER_V1");
  });

  it("is frozen from the first result, even a draft", async () => {
    const { env, repo } = freshEnv();
    const world = await buildLadderWorld(env, { offeredLevels: [1] });
    await saveResult(repo, { matchId: world.matchId, homeScore: 0, awayScore: 0, officialGoalEvents: [], enteredByGamingMemberId: FINALIZER });
    await expect(repo.setMatchPredictionContract(world.matchId, "COMPLETE_COUNT_V1")).rejects.toBeInstanceOf(ContractFrozenError);
  });

  it("can still change on a match with no prediction and no result, in either direction", async () => {
    const { repo } = freshEnv();
    const home = await repo.createTeam({ name: "H" });
    const away = await repo.createTeam({ name: "A" });
    const match = await repo.createMatch({ homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Open", kickoffAt: new Date(Date.now() + 3600_000).toISOString() });
    expect(match.predictionContract).toBe("COMPLETE_COUNT_V1");
    expect((await repo.setMatchPredictionContract(match.matchId, "PROGRESSIVE_LADDER_V1")).predictionContract).toBe("PROGRESSIVE_LADDER_V1");
    expect((await repo.setMatchPredictionContract(match.matchId, "COMPLETE_COUNT_V1")).predictionContract).toBe("COMPLETE_COUNT_V1");
  });

  it("refuses a historical prediction on a progressive match and a progressive one on a historical match", async () => {
    const { env, repo } = freshEnv();
    const world = await buildLadderWorld(env, { offeredLevels: [1] });
    const member = await env.newMember("m");
    await expect(
      submitPrediction(repo, {
        matchId: world.matchId, gamingMemberId: member, venueActivationId: world.activationId,
        predictedHomeScore: 1, predictedAwayScore: 0, predictedGoalscorerPlayerId: null,
        predictedGoalMinuteRegulation: null, predictedGoalMinuteStoppage: null, predictedFirstTeamToScore: null, geo: NEAR,
      })
    ).rejects.toBeInstanceOf(ContractMismatchError);

    const home = await repo.createTeam({ name: "H" });
    const away = await repo.createTeam({ name: "A" });
    const legacy = await repo.createMatch({ homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Old", kickoffAt: new Date(Date.now() + 3600_000).toISOString() });
    await repo.setMatchActivityClassification(legacy.matchId, "TRAINING", FINALIZER, null);
    const venue = await repo.createVenue({ name: "V2", latitude: 10, longitude: 10, radiusMeters: 100 });
    const activation = await repo.createVenueActivation({ matchId: legacy.matchId, venueId: venue.venueId });
    await expect(
      repo.upsertProgressivePrediction({
        matchId: legacy.matchId, gamingMemberId: member, venueActivationId: activation.venueActivationId,
        answers: { attemptedLevel: 1, scoreline: { home: 1, away: 0 } }, offerDigest: "x",
        geoVerifiedAt: new Date().toISOString(), measuredDistanceMeters: 1, reportedAccuracyMeters: null, geoEligible: true,
      })
    ).rejects.toBeInstanceOf(ContractMismatchError);
  });
});

// ---------------------------------------------------------------------------
// Backtracking, editing and reducing the level never leaves a hidden answer
// ---------------------------------------------------------------------------

describe("editing, reducing and sending again", () => {
  const all = { S: true, F: true, G: true, M: true };

  it("reducing the attempted level clears every higher answer, in the stored row", async () => {
    const { env, repo } = freshEnv();
    const world = await buildLadderWorld(env, { offeredLevels: [1, 2, 3, 4] });
    const member = await env.newMember("m");
    const full = await submitAs(env, world, member, answersFor(world, 4, all));
    expect(full.goalscorerState).toBe("PICKED");
    expect(full.predictedGoalscorerPlayerId).toBe(world.players.mbappe);
    expect(full.predictedGoalMinuteRegulation).toBe(30);

    const reduced = await submitAs(env, world, member, answersFor(world, 2, all));
    expect(reduced.predictionId).toBe(full.predictionId);
    expect(reduced.attemptedLevel).toBe(2);
    expect(reduced.firstTeamState).toBe("PICKED");
    expect(reduced.goalscorerState).toBe("NOT_ATTEMPTED");
    expect(reduced.goalMinuteState).toBe("NOT_ATTEMPTED");
    expect(reduced.predictedGoalscorerPlayerId).toBeNull();
    expect(reduced.predictedGoalMinuteRegulation).toBeNull();
    expect(reduced.predictedGoalMinuteStoppage).toBeNull();

    // Reload shows only what is saved; the view has no trace of the dropped answers.
    const reloaded = await repo.getPredictionForMember(world.matchId, member);
    const view = progressivePredictionView(reloaded!);
    expect(view.attemptedLevel).toBe(2);
    expect("goalscorer" in view).toBe(false);
    expect("goalMinute" in view).toBe(false);
  });

  it("going back up does not bring a dropped answer back", async () => {
    const { env } = freshEnv();
    const world = await buildLadderWorld(env, { offeredLevels: [1, 2, 3, 4] });
    const member = await env.newMember("m");
    await submitAs(env, world, member, answersFor(world, 4, all));
    await submitAs(env, world, member, answersFor(world, 1, all));
    const back = await submitAs(env, world, member, {
      attemptedLevel: 2,
      scoreline: { home: 2, away: 1 },
      firstTeam: { kind: "PICKED", team: "HOME" },
    });
    expect(back.firstTeamState).toBe("PICKED");
    expect(back.goalscorerState).toBe("NOT_ATTEMPTED");
    expect(back.predictedGoalscorerPlayerId).toBeNull();
    expect(back.goalMinuteState).toBe("NOT_ATTEMPTED");
  });

  it("an answer dropped by reducing is never evaluated, even when it would have been right", async () => {
    const { env } = freshEnv();
    const world = await buildLadderWorld(env, { offeredLevels: [1, 2, 3, 4] });
    const member = await env.newMember("m");
    const full = await submitAs(env, world, member, answersFor(world, 4, all)); // would win Legendary
    await submitAs(env, world, member, answersFor(world, 2, all));
    await settle(env, world, "TWO_ONE");
    const evaluation = await env.repo.getCurrentEvaluationForPrediction(full.predictionId);
    expect(evaluation!.attemptedLevel).toBe(2);
    expect(evaluation!.ladderLevel).toBe(2);
    expect(evaluation!.goalscorerCorrect).toBeNull();
    expect(evaluation!.goalMinuteCorrect).toBeNull();
    const qualification = await env.repo.getQualificationForEvaluation(evaluation!.evaluationId);
    expect(qualification!.prizeTierId).toBe(world.tierIdByLevel[2]);
  });

  it("sending the same request again is idempotent: one prediction, the same identity", async () => {
    const { env, repo } = freshEnv();
    const world = await buildLadderWorld(env, { offeredLevels: [1, 2, 3] });
    const member = await env.newMember("m");
    const answers = answersFor(world, 3, all);
    const one = await submitAs(env, world, member, answers);
    const two = await submitAs(env, world, member, answers);
    const three = await Promise.all([submitAs(env, world, member, answers), submitAs(env, world, member, answers)]);
    expect(two.predictionId).toBe(one.predictionId);
    expect(three.every((p) => p.predictionId === one.predictionId)).toBe(true);
    expect((await repo.listPredictionsForMatch(world.matchId)).filter((p) => p.gamingMemberId === member)).toHaveLength(1);
    expect(two.createdAt).toBe(one.createdAt);
  });

  it("keeps the venue activation once chosen", async () => {
    const { env, repo } = freshEnv();
    const world = await buildLadderWorld(env, { offeredLevels: [1] });
    const other = await repo.createVenueActivation({ matchId: world.matchId, venueId: world.venueId });
    await repo.createLadderPrizeTier({ venueActivationId: other.venueActivationId, ladderLevel: 1, prizeLabel: "Other" });
    const member = await env.newMember("m");
    await submitAs(env, world, member, answersFor(world, 1, all));
    await expect(
      submitAs(env, world, member, answersFor(world, 1, all), { activationId: other.venueActivationId, offerDigest: computeLadderOffer(await repo.listPrizeTiersForActivation(other.venueActivationId)).digest })
    ).rejects.toBeInstanceOf(VenueActivationImmutableError);
  });

  it("validates the goalscorer against the roster of this match", async () => {
    const { env } = freshEnv();
    const world = await buildLadderWorld(env, { offeredLevels: [1, 2, 3] });
    const member = await env.newMember("m");
    await expect(
      submitAs(env, world, member, {
        attemptedLevel: 3, scoreline: { home: 1, away: 0 }, firstTeam: { kind: "PICKED", team: "HOME" },
        goalscorer: { kind: "PICKED", playerId: randomUUID() },
      })
    ).rejects.toBeInstanceOf(InvalidGoalscorerSelectionError);
  });
});

// ---------------------------------------------------------------------------
// Closing: kickoff, and a finalized result
// ---------------------------------------------------------------------------

describe("closing", () => {
  const all = { S: true, F: true, G: true, M: true };

  it("closes at kickoff for a first prediction and for an edit", async () => {
    const { env, repo } = freshEnv();
    const world = await buildLadderWorld(env, { offeredLevels: [1, 2] });
    const early = await env.newMember("early");
    await submitAs(env, world, early, answersFor(world, 1, all));
    const match = (await repo.getMatchById(world.matchId))!;
    await repo.editMatch(world.matchId, { homeTeamId: match.homeTeamId, awayTeamId: match.awayTeamId, competition: match.competition, kickoffAt: new Date(Date.now() - 1000).toISOString() });
    await expect(submitAs(env, world, early, answersFor(world, 2, all))).rejects.toBeInstanceOf(KickoffPassedError);
    const late = await env.newMember("late");
    await expect(submitAs(env, world, late, answersFor(world, 1, all))).rejects.toBeInstanceOf(KickoffPassedError);
  });

  it("rejects new predictions and edits once a result is finalized, even if the kickoff is moved later", async () => {
    const { env, repo } = freshEnv();
    const world = await buildLadderWorld(env, { offeredLevels: [1, 2] });
    const member = await env.newMember("m");
    await submitAs(env, world, member, answersFor(world, 1, all));
    await settle(env, world, "TWO_ONE");

    const match = (await repo.getMatchById(world.matchId))!;
    await repo.editMatch(world.matchId, { homeTeamId: match.homeTeamId, awayTeamId: match.awayTeamId, competition: match.competition, kickoffAt: new Date(Date.now() + 86_400_000).toISOString() });

    await expect(submitAs(env, world, member, answersFor(world, 2, all))).rejects.toBeInstanceOf(ResultAlreadyFinalizedError);
    const newcomer = await env.newMember("new");
    await expect(submitAs(env, world, newcomer, answersFor(world, 1, all))).rejects.toBeInstanceOf(ResultAlreadyFinalizedError);
    // The evaluation of the existing prediction is untouched.
    const prediction = (await repo.getPredictionForMember(world.matchId, member))!;
    expect(prediction.attemptedLevel).toBe(1);
    expect((await repo.getCurrentEvaluationForPrediction(prediction.predictionId))!.attemptedLevel).toBe(1);
  });

  it("applies the same rule to a historical match", async () => {
    const { repo } = freshEnv();
    const home = await repo.createTeam({ name: "H" });
    const away = await repo.createTeam({ name: "A" });
    const scorer = await repo.createPlayer({ teamId: home.teamId, name: "Scorer" });
    const match = await repo.createMatch({ homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Old", kickoffAt: new Date(Date.now() + 3600_000).toISOString() });
    await repo.setMatchActivityClassification(match.matchId, "TRAINING", FINALIZER, null);
    const venue = await repo.createVenue({ name: "V", latitude: 10, longitude: 10, radiusMeters: 100 });
    const activation = await repo.createVenueActivation({ matchId: match.matchId, venueId: venue.venueId });
    const legacy = (member: string) =>
      submitPrediction(repo, {
        matchId: match.matchId, gamingMemberId: member, venueActivationId: activation.venueActivationId,
        predictedHomeScore: 1, predictedAwayScore: 0, predictedGoalscorerPlayerId: null,
        predictedGoalMinuteRegulation: null, predictedGoalMinuteStoppage: null, predictedFirstTeamToScore: null, geo: NEAR,
      });
    await legacy("legacy-a");
    const saved = await saveResult(repo, {
      matchId: match.matchId, homeScore: 1, awayScore: 0,
      officialGoalEvents: [{ scorerPlayerId: scorer.playerId, minuteRegulation: 10 }], enteredByGamingMemberId: FINALIZER,
    });
    await finalizeMatchResult(repo, saved.matchResultId, FINALIZER);
    await repo.editMatch(match.matchId, { homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Old", kickoffAt: new Date(Date.now() + 86_400_000).toISOString() });
    await expect(legacy("legacy-a")).rejects.toBeInstanceOf(ResultAlreadyFinalizedError);
    await expect(legacy("legacy-b")).rejects.toBeInstanceOf(ResultAlreadyFinalizedError);
  });

  it("requires a position: no location, or outside the venue, is refused", async () => {
    const { env } = freshEnv();
    const world = await buildLadderWorld(env, { offeredLevels: [1] });
    const member = await env.newMember("m");
    await expect(submitAs(env, world, member, answersFor(world, 1, all), { geo: null })).rejects.toBeInstanceOf(GeoUnavailableError);
    await expect(
      submitAs(env, world, member, answersFor(world, 1, all), { geo: { latitude: 40, longitude: 40, accuracyMeters: 5 } })
    ).rejects.toBeInstanceOf(GeoNotEligibleError);
  });
});

// ---------------------------------------------------------------------------
// F-1: an exact replay of the accepted request is not a new edit
// F-2: the historical write path never creates or edits a progressive prediction
// ---------------------------------------------------------------------------

describe("an exact replay of the accepted request returns the confirmed row; anything else is an edit", () => {
  const all = { S: true, F: true, G: true, M: true };
  const FAR = { latitude: 40, longitude: 40, accuracyMeters: 5 };
  const pause = (ms = 8) => new Promise((resolve) => setTimeout(resolve, ms));

  async function accepted(levels = [1, 2, 3, 4], level = 2) {
    const { env, repo } = freshEnv();
    const world = await buildLadderWorld(env, { offeredLevels: levels });
    const member = await env.newMember("m");
    const answers = answersFor(world, level, all);
    const first = await submitAs(env, world, member, answers);
    await pause(); // so a rewritten row could not carry the same timestamp by chance
    return { env, repo, world, member, answers, first };
  }
  const moveKickoff = async (repo: InMemoryPredictionsRepository, matchId: string, at: Date) => {
    const match = (await repo.getMatchById(matchId))!;
    await repo.editMatch(matchId, { homeTeamId: match.homeTeamId, awayTeamId: match.awayTeamId, competition: match.competition, kickoffAt: at.toISOString() });
  };

  it("returns the stored row exactly: the same identity, timestamps and geolocation evidence, even when the repeat carries another position and accuracy", async () => {
    const { env, repo, world, member, answers, first } = await accepted();
    const repeat = await submitAs(env, world, member, answers, { geo: { latitude: 10.0002, longitude: 10.0003, accuracyMeters: 41 } });
    expect(repeat).toEqual(first);
    expect(await repo.getPredictionForMember(world.matchId, member)).toEqual(first);
    expect(repeat.updatedAt).toBe(first.updatedAt);
    expect(repeat.geoVerifiedAt).toBe(first.geoVerifiedAt);
    expect(repeat.measuredDistanceMeters).toBe(first.measuredDistanceMeters);
    expect(repeat.reportedAccuracyMeters).toBe(first.reportedAccuracyMeters);
    expect((await repo.listPredictionsForMatch(world.matchId)).filter((p) => p.gamingMemberId === member)).toHaveLength(1);
  });

  it("still returns it after kickoff, while a changed request is refused and the stored row stays as it was", async () => {
    const { env, repo, world, member, answers, first } = await accepted();
    await moveKickoff(repo, world.matchId, new Date(Date.now() - 1000));
    expect(await submitAs(env, world, member, answers)).toEqual(first);
    await expect(submitAs(env, world, member, answersFor(world, 3, all))).rejects.toBeInstanceOf(KickoffPassedError);
    await expect(submitAs(env, world, member, { ...answers, scoreline: { home: 9, away: 9 } })).rejects.toBeInstanceOf(KickoffPassedError);
    expect(await repo.getPredictionForMember(world.matchId, member)).toEqual(first);
  });

  it("still returns it after the activation is closed, while a changed request is refused", async () => {
    const { env, repo, world, member, answers, first } = await accepted();
    await repo.setVenueActivationEnabled(world.activationId, false);
    expect(await submitAs(env, world, member, answers)).toEqual(first);
    await expect(submitAs(env, world, member, answersFor(world, 3, all))).rejects.toBeInstanceOf(VenueActivationDisabledError);
    expect(await repo.getPredictionForMember(world.matchId, member)).toEqual(first);
  });

  it("still returns it after the match is cancelled, while a changed request is refused", async () => {
    const { env, repo, world, member, answers, first } = await accepted();
    await repo.cancelMatch(world.matchId);
    expect(await submitAs(env, world, member, answers)).toEqual(first);
    await expect(submitAs(env, world, member, answersFor(world, 3, all))).rejects.toBeInstanceOf(MatchCancelledError);
    expect(await repo.getPredictionForMember(world.matchId, member)).toEqual(first);
  });

  it("still returns it after a result is finalized, even with the kickoff moved later; a changed request is refused and the evaluation is untouched", async () => {
    const { env, repo, world, member, answers, first } = await accepted();
    await settle(env, world, "TWO_ONE");
    const evaluationBefore = await repo.getCurrentEvaluationForPrediction(first.predictionId);
    await moveKickoff(repo, world.matchId, new Date(Date.now() + 86_400_000));
    expect(await submitAs(env, world, member, answers)).toEqual(first);
    await expect(submitAs(env, world, member, answersFor(world, 3, all))).rejects.toBeInstanceOf(ResultAlreadyFinalizedError);
    expect(await repo.getPredictionForMember(world.matchId, member)).toEqual(first);
    expect(await repo.getCurrentEvaluationForPrediction(first.predictionId)).toEqual(evaluationBefore);
  });

  it("does not depend on where the repeat is sent from: outside the radius it still returns the confirmed row, but a changed request from there, and a first request from there, are refused", async () => {
    const { env, repo, world, member, answers, first } = await accepted();
    expect(await submitAs(env, world, member, answers, { geo: FAR })).toEqual(first);
    await expect(submitAs(env, world, member, answersFor(world, 3, all), { geo: FAR })).rejects.toBeInstanceOf(GeoNotEligibleError);
    const stranger = await env.newMember("outside");
    await expect(submitAs(env, world, stranger, answers, { geo: FAR })).rejects.toBeInstanceOf(GeoNotEligibleError);
    expect(await repo.getPredictionForMember(world.matchId, stranger)).toBeNull();
    expect(await repo.getPredictionForMember(world.matchId, member)).toEqual(first);
  });

  it("is a replay only for the same member: the same answers from someone else are that person's own first prediction", async () => {
    const { env, repo, world, answers, first } = await accepted();
    const other = await env.newMember("other");
    const theirs = await submitAs(env, world, other, answers);
    expect(theirs.predictionId).not.toBe(first.predictionId);
    expect(theirs.gamingMemberId).toBe(other);
    expect(await repo.listPredictionsForMatch(world.matchId)).toHaveLength(2);
  });

  describe("what makes a request a different one: every answer, the level, the venue and the fingerprint", () => {
    const variations: Array<[string, (w: LadderWorld) => unknown]> = [
      ["the home score", (w) => ({ ...answersFor(w, 4, all), scoreline: { home: 3, away: 1 } })],
      ["the away score", (w) => ({ ...answersFor(w, 4, all), scoreline: { home: 2, away: 2 } })],
      ["the first team", (w) => ({ ...answersFor(w, 4, all), firstTeam: { kind: "PICKED", team: "AWAY" } })],
      ["the goalscorer", (w) => ({ ...answersFor(w, 4, all), goalscorer: { kind: "PICKED", playerId: w.players.lewa } })],
      ["the goal minute", (w) => ({ ...answersFor(w, 4, all), goalMinute: { kind: "PICKED", regulation: 31, stoppage: null } })],
      ["added time on a boundary minute", (w) => ({ ...answersFor(w, 4, all), goalMinute: { kind: "PICKED", regulation: 45, stoppage: 2 } })],
      // A NONE can only accompany a 0-0 scoreline now, so the "turned into none" variations are one: the whole prediction turned into 0-0 and none.
      ["the whole prediction turned into 0-0 with none for team, player and minute", () => ({ attemptedLevel: 4, scoreline: { home: 0, away: 0 }, firstTeam: { kind: "NONE" }, goalscorer: { kind: "NONE" }, goalMinute: { kind: "NONE" } })],
      ["the level, reduced", (w) => answersFor(w, 3, all)],
    ];
    it.each(variations)("%s: a new edit — accepted before kickoff, replacing the stored row, never returned as a replay", async (_label, build) => {
      const { env, repo, world, member, first } = await accepted([1, 2, 3, 4], 4);
      const variant = build(world);
      const edited = await submitAs(env, world, member, variant);
      expect(edited.predictionId).toBe(first.predictionId);
      expect(edited.updatedAt).not.toBe(first.updatedAt);
      expect(progressivePredictionView(edited)).not.toEqual(progressivePredictionView(first));
      expect(await repo.getPredictionForMember(world.matchId, member)).toEqual(edited);
    });

    it("a different venue is refused as the venue cannot change; a different or missing fingerprint is refused, not returned", async () => {
      const { env, repo, world, member, answers, first } = await accepted();
      const venue2 = await repo.createVenue({ name: "Second venue", latitude: 10, longitude: 10, radiusMeters: 100 });
      const activation2 = await repo.createVenueActivation({ matchId: world.matchId, venueId: venue2.venueId });
      for (const level of [1, 2]) await repo.createLadderPrizeTier({ venueActivationId: activation2.venueActivationId, ladderLevel: level, prizeLabel: `Prize L${level}` });
      const digest2 = computeLadderOffer(await repo.listPrizeTiersForActivation(activation2.venueActivationId)).digest!;
      await expect(submitAs(env, world, member, answers, { activationId: activation2.venueActivationId, offerDigest: digest2 })).rejects.toBeInstanceOf(VenueActivationImmutableError);
      await expect(submitAs(env, world, member, answers, { offerDigest: "0".repeat(64) })).rejects.toBeInstanceOf(OfferChangedError);
      await expect(submitAs(env, world, member, answers, { offerDigest: null })).rejects.toBeInstanceOf(OfferDigestRequiredError);
      expect(await repo.getPredictionForMember(world.matchId, member)).toEqual(first);
    });

    it("a malformed request is never answered with the stored row, even when its useful part is the same", async () => {
      const { env, repo, world, member, answers, first } = await accepted();
      await expect(submitAs(env, world, member, { ...(answers as object), extra: true })).rejects.toBeInstanceOf(InvalidAttemptShapeError);
      await expect(submitAs(env, world, member, { ...(answers as object), goalscorer: { kind: "NONE" } })).rejects.toBeInstanceOf(InvalidAttemptShapeError);
      expect(await repo.getPredictionForMember(world.matchId, member)).toEqual(first);
    });
  });

  it("is a guarantee about the request currently accepted, not an idempotency key: an older request sent late is a new edit before kickoff and refused after it", async () => {
    const { env, repo, world, member, answers: second } = await accepted([1, 2, 3, 4], 2);
    const older = answersFor(world, 1, all);
    const reverted = await submitAs(env, world, member, older); // the stored row is the level-2 one, so this is an edit
    expect(reverted.attemptedLevel).toBe(1);
    await moveKickoff(repo, world.matchId, new Date(Date.now() - 1000));
    await expect(submitAs(env, world, member, second)).rejects.toBeInstanceOf(KickoffPassedError); // not the stored request any more
    expect(await submitAs(env, world, member, older)).toEqual(reverted);
  });

  it("does not hide the contract: a progressive request on a historical match is still refused, with or without a stored row", async () => {
    const { env, repo, world, member, answers } = await accepted();
    const home = await repo.createTeam({ name: "H" });
    const away = await repo.createTeam({ name: "A" });
    const legacy = await repo.createMatch({ homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Old", kickoffAt: new Date(Date.now() + 3600_000).toISOString() });
    await repo.setMatchActivityClassification(legacy.matchId, "TRAINING", FINALIZER, null);
    const venue = await repo.createVenue({ name: "V9", latitude: 10, longitude: 10, radiusMeters: 100 });
    const activation = await repo.createVenueActivation({ matchId: legacy.matchId, venueId: venue.venueId });
    await expect(submitAs(env, { ...world, matchId: legacy.matchId, activationId: activation.venueActivationId }, member, answers, { offerDigest: "x" })).rejects.toBeInstanceOf(ContractMismatchError);
  });
});

describe("the historical write path never creates or edits a progressive prediction", () => {
  const all = { S: true, F: true, G: true, M: true };
  const historical = (repo: InMemoryPredictionsRepository, world: LadderWorld, member: string, over: Record<string, unknown> = {}) =>
    submitPrediction(repo, {
      matchId: world.matchId, gamingMemberId: member, venueActivationId: world.activationId,
      predictedHomeScore: 2, predictedAwayScore: 1, predictedGoalscorerPlayerId: null,
      predictedGoalMinuteRegulation: null, predictedGoalMinuteStoppage: null, predictedFirstTeamToScore: null, geo: NEAR,
      ...over,
    });

  it("refuses to create one, and to edit one that exists — including the edit that changes only the scoreline, which the table's own checks cannot see", async () => {
    const { env, repo } = freshEnv();
    const world = await buildLadderWorld(env, { offeredLevels: [1, 2] });
    const member = await env.newMember("m");
    const stranger = await env.newMember("s");
    await expect(historical(repo, world, stranger)).rejects.toBeInstanceOf(ContractMismatchError);
    expect(await repo.getPredictionForMember(world.matchId, stranger)).toBeNull();

    const stored = await submitAs(env, world, member, { attemptedLevel: 2, scoreline: { home: 2, away: 1 }, firstTeam: { kind: "PICKED", team: "HOME" } });
    await expect(historical(repo, world, member, { predictedHomeScore: 5 })).rejects.toBeInstanceOf(ContractMismatchError);
    await expect(historical(repo, world, member)).rejects.toBeInstanceOf(ContractMismatchError);
    expect(await repo.getPredictionForMember(world.matchId, member)).toEqual(stored);
  });

  it("says so before anything else: after kickoff, for a closed activation and from outside the radius, the answer is still the contract", async () => {
    const { env, repo } = freshEnv();
    const world = await buildLadderWorld(env, { offeredLevels: [1] });
    const member = await env.newMember("m");
    await submitAs(env, world, member, answersFor(world, 1, all));
    const match = (await repo.getMatchById(world.matchId))!;
    await repo.editMatch(world.matchId, { homeTeamId: match.homeTeamId, awayTeamId: match.awayTeamId, competition: match.competition, kickoffAt: new Date(Date.now() - 1000).toISOString() });
    await repo.setVenueActivationEnabled(world.activationId, false);
    await expect(historical(repo, world, member, { geo: { latitude: 40, longitude: 40, accuracyMeters: 5 } })).rejects.toBeInstanceOf(ContractMismatchError);
  });

  it("is mapped to 409 like every other contract refusal", () => {
    expect(statusForPredictionsError(new ContractMismatchError())).toBe(409);
  });
});

// ---------------------------------------------------------------------------
// Payloads: the same refusals through the repository layer
// ---------------------------------------------------------------------------

describe("malicious and contradictory payloads at the repository", () => {
  const uuid = randomUUID();
  const CASES: Array<[string, unknown]> = [
    ["a gap (level 3 without the first team)", { attemptedLevel: 3, scoreline: { home: 1, away: 0 }, goalscorer: { kind: "NONE" } }],
    ["a category above the level", { attemptedLevel: 1, scoreline: { home: 1, away: 0 }, firstTeam: { kind: "NONE" } }],
    ["a bare null for a category", { attemptedLevel: 2, scoreline: { home: 1, away: 0 }, firstTeam: null }],
    ["NONE carrying a value", { attemptedLevel: 2, scoreline: { home: 1, away: 0 }, firstTeam: { kind: "NONE", team: "HOME" } }],
    ["PICKED without a value", { attemptedLevel: 2, scoreline: { home: 1, away: 0 }, firstTeam: { kind: "PICKED" } }],
    ["a missing scoreline score", { attemptedLevel: 1, scoreline: { home: 1 } }],
    ["a negative score", { attemptedLevel: 1, scoreline: { home: -1, away: 0 } }],
    ["a level of 5", { attemptedLevel: 5, scoreline: { home: 1, away: 0 } }],
    ["a goal minute of 91", { attemptedLevel: 4, scoreline: { home: 1, away: 0 }, firstTeam: { kind: "NONE" }, goalscorer: { kind: "NONE" }, goalMinute: { kind: "PICKED", regulation: 91, stoppage: null } }],
    ["added time at minute 30", { attemptedLevel: 4, scoreline: { home: 1, away: 0 }, firstTeam: { kind: "NONE" }, goalscorer: { kind: "PICKED", playerId: uuid }, goalMinute: { kind: "PICKED", regulation: 30, stoppage: 2 } }],
  ];

  it.each(CASES)("refuses %s without writing anything", async (_name, answers) => {
    const { env, repo } = freshEnv();
    const world = await buildLadderWorld(env, { offeredLevels: [1, 2, 3, 4] });
    const member = await env.newMember("m");
    await expect(submitAs(env, world, member, answers)).rejects.toBeInstanceOf(InvalidAttemptShapeError);
    // Straight to the repository, bypassing the domain function's own parse.
    await expect(
      repo.upsertProgressivePrediction({
        matchId: world.matchId, gamingMemberId: member, venueActivationId: world.activationId,
        answers: answers as never, offerDigest: await offerDigestOf(env, world),
        geoVerifiedAt: new Date().toISOString(), measuredDistanceMeters: 1, reportedAccuracyMeters: null, geoEligible: true,
      })
    ).rejects.toBeInstanceOf(InvalidAttemptShapeError);
    expect(await repo.getPredictionForMember(world.matchId, member)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Settlement and correction: one prize, no second delivery
// ---------------------------------------------------------------------------

describe("finalization and correction under the ladder", () => {
  /**
   * Four members on the 2-1 match (home scored first), all four levels offered:
   *   a: attempted 2, Easy and Medium right          -> won 2 (Prize L2)
   *   b: attempted 1, scoreline right                -> won 1 (Prize L1)
   *   c: attempted 4, scoreline wrong                -> won 0
   *   d: attempted 2, scoreline right, picked AWAY   -> won 1 (Prize L1)
   * The correction: the same 2-1 but the AWAY team scored first.
   *   a: Medium now wrong -> won 1       b: unchanged, won 1
   *   c: unchanged, won 0                d: Medium now right -> won 2
   */
  async function world() {
    const { env, repo } = freshEnv();
    const w = await buildLadderWorld(env, { offeredLevels: [1, 2, 3, 4] });
    const ids = {
      a: await env.newMember("a"), b: await env.newMember("b"), c: await env.newMember("c"), d: await env.newMember("d"),
    };
    const preds = {
      a: await submitAs(env, w, ids.a, answersFor(w, 2, { S: true, F: true, G: true, M: true })),
      b: await submitAs(env, w, ids.b, answersFor(w, 1, { S: true, F: true, G: true, M: true })),
      c: await submitAs(env, w, ids.c, answersFor(w, 4, { S: false, F: true, G: true, M: true })),
      d: await submitAs(env, w, ids.d, { attemptedLevel: 2, scoreline: { home: 2, away: 1 }, firstTeam: { kind: "PICKED", team: "AWAY" } }),
    };
    await settle(env, w, "TWO_ONE");
    return { env, repo, w, ids, preds };
  }

  async function current(repo: InMemoryPredictionsRepository, w: LadderWorld, memberId: string) {
    const rows = (await repo.listQualificationsForActivation(w.activationId)).filter((q) => q.gamingMemberId === memberId);
    return { all: rows, active: rows.filter((q) => q.supersededAt === null) };
  }

  it("issues exactly the prize of the won level before any correction", async () => {
    const { repo, w, ids } = await world();
    expect((await current(repo, w, ids.a)).active.map((q) => q.prizeTierId)).toEqual([w.tierIdByLevel[2]]);
    expect((await current(repo, w, ids.b)).active.map((q) => q.prizeTierId)).toEqual([w.tierIdByLevel[1]]);
    expect((await current(repo, w, ids.c)).all).toHaveLength(0);
    expect((await current(repo, w, ids.d)).active.map((q) => q.prizeTierId)).toEqual([w.tierIdByLevel[1]]);
  });

  it("a correction without any delivery replaces the unredeemed entitlements and keeps one per member", async () => {
    const { env, repo, w, ids } = await world();
    await settle(env, w, "TWO_ONE_AWAY_FIRST", "Official sheet corrected");
    const a = await current(repo, w, ids.a);
    expect(a.active.map((q) => q.prizeTierId)).toEqual([w.tierIdByLevel[1]]);
    expect(a.all).toHaveLength(2); // history kept, the old one superseded
    expect((await current(repo, w, ids.b)).active.map((q) => q.prizeTierId)).toEqual([w.tierIdByLevel[1]]);
    expect((await current(repo, w, ids.c)).all).toHaveLength(0);
    expect((await current(repo, w, ids.d)).active.map((q) => q.prizeTierId)).toEqual([w.tierIdByLevel[2]]);
    for (const id of Object.values(ids)) expect((await current(repo, w, id)).active.length).toBeLessThanOrEqual(1);
  });

  it("a delivered prize that the correction changes is held, never delivered a second time, and says 'level N of 4'", async () => {
    const { env, repo, w, ids } = await world();
    const a0 = (await current(repo, w, ids.a)).active[0];
    await repo.redeemPrizeQualification(a0.prizeQualificationId, FINALIZER, null);

    await settle(env, w, "TWO_ONE_AWAY_FIRST", "Official sheet corrected");
    const a = await current(repo, w, ids.a);
    expect(a.active).toHaveLength(1);
    const held = a.active[0];
    expect(held.prizeTierId).toBe(w.tierIdByLevel[1]);
    expect(held.heldAt).not.toBeNull();
    expect(held.holdBasis).toBe("DELIVERED_PRIZE_CHANGED");
    expect(held.holdReason).toContain('Delivered: "Prize L2" (level 2 of 4)');
    expect(held.holdReason).toContain('Now entitled to: "Prize L1" (level 1 of 4)');
    expect(held.holdReason).not.toContain("of 4 correct");
    await expect(repo.redeemPrizeQualification(held.prizeQualificationId, FINALIZER, null)).rejects.toBeInstanceOf(PrizeQualificationHeldError);
  });

  it("a delivered prize the correction leaves the same is fulfilled by the original delivery, not delivered again", async () => {
    const { env, repo, w, ids } = await world();
    const b0 = (await current(repo, w, ids.b)).active[0];
    await repo.redeemPrizeQualification(b0.prizeQualificationId, FINALIZER, null);
    await settle(env, w, "TWO_ONE_AWAY_FIRST", "Official sheet corrected");
    const b = await current(repo, w, ids.b);
    expect(b.active).toHaveLength(1);
    expect(b.active[0].fulfilledByPrizeQualificationId).toBe(b0.prizeQualificationId);
    await expect(repo.redeemPrizeQualification(b.active[0].prizeQualificationId, FINALIZER, null)).rejects.toBeInstanceOf(domainTypes.PrizeAlreadyFulfilledError);
  });

  it("a correction that lifts the won level after Easy was delivered is held at the higher level", async () => {
    const { env, repo, w, ids } = await world();
    const d0 = (await current(repo, w, ids.d)).active[0];
    expect(d0.prizeTierId).toBe(w.tierIdByLevel[1]);
    await repo.redeemPrizeQualification(d0.prizeQualificationId, FINALIZER, null);
    await settle(env, w, "TWO_ONE_AWAY_FIRST", "Official sheet corrected");
    const held = (await current(repo, w, ids.d)).active[0];
    expect(held.prizeTierId).toBe(w.tierIdByLevel[2]);
    expect(held.holdBasis).toBe("DELIVERED_PRIZE_CHANGED");
    expect(held.holdReason).toContain("(level 1 of 4)");
    expect(held.holdReason).toContain("(level 2 of 4)");
  });

  it("a correction to a level without a prize leaves history and issues nothing new", async () => {
    const { env, repo, w, ids } = await world();
    await settle(env, w, "GOALLESS", "Match annulled");
    for (const id of [ids.a, ids.b, ids.c, ids.d]) {
      const rows = await current(repo, w, id);
      expect(rows.active).toHaveLength(0); // 2-1 predictions against a 0-0 result: nothing won
    }
    expect((await current(repo, w, ids.a)).all).toHaveLength(1); // the superseded original is kept
  });

  it("evaluates a correction against the stored states, not against anything the member could have hidden", async () => {
    const { env, repo, w, preds } = await world();
    await settle(env, w, "TWO_ONE_AWAY_FIRST", "Official sheet corrected");
    const current = await repo.getCurrentEvaluationForPrediction(preds.c.predictionId);
    expect(current!.attemptedLevel).toBe(4);
    expect(current!.ladderLevel).toBe(0);
    // Scoreline wrong and, after the correction, the first team wrong too; the goalscorer and the
    // minute are still right: two hits, and still level 0 — the count is not a ladder level.
    expect(current!.correctDimensionCount).toBe(2);
    expect(current!.scorelineCorrect).toBe(false);
    expect(current!.firstTeamToScoreCorrect).toBe(false);
    expect(current!.goalscorerCorrect).toBe(true);
    expect(current!.goalMinuteCorrect).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Concurrency in the in-memory model
// ---------------------------------------------------------------------------

describe("concurrent work", () => {
  it("finalizing the same result twice at once settles it once", async () => {
    const { env, repo } = freshEnv();
    const w = await buildLadderWorld(env, { offeredLevels: [1, 2] });
    const m = await env.newMember("m");
    await submitAs(env, w, m, answersFor(w, 2, { S: true, F: true, G: true, M: true }));
    const spec = officialGoals(w, "TWO_ONE");
    const saved = await repo.saveDraftMatchResult({
      matchId: w.matchId, homeScore: spec.home, awayScore: spec.away, officialGoalEvents: spec.events,
      enteredByGamingMemberId: FINALIZER, saveBase: await currentSaveBase(repo, w.matchId),
    });
    const outcomes = await Promise.allSettled([
      repo.finalizeMatchResult(saved.matchResultId, FINALIZER, null, saved.contentDigest),
      repo.finalizeMatchResult(saved.matchResultId, FINALIZER, null, saved.contentDigest),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled").length).toBe(2); // the second is an idempotent replay
    const qualifications = await repo.listQualificationsForActivation(w.activationId);
    expect(qualifications).toHaveLength(1);
  });

  it("two independent first submissions by one member leave one prediction", async () => {
    const { env, repo } = freshEnv();
    const w = await buildLadderWorld(env, { offeredLevels: [1, 2, 3] });
    const m = await env.newMember("m");
    const results = await Promise.all([
      submitAs(env, w, m, answersFor(w, 3, { S: true, F: true, G: true, M: true })),
      submitAs(env, w, m, answersFor(w, 1, { S: true, F: true, G: true, M: true })),
    ]);
    expect(results[0].predictionId).toBe(results[1].predictionId);
    expect((await repo.listPredictionsForMatch(w.matchId)).filter((p) => p.gamingMemberId === m)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Historical contract: no reinterpretation
// ---------------------------------------------------------------------------

describe("the historical contract is not reinterpreted", () => {
  it("keeps count tiers, null-means-No-Goal, the count-keyed prize and no levels", async () => {
    const { repo } = freshEnv();
    const home = await repo.createTeam({ name: "H" });
    const away = await repo.createTeam({ name: "A" });
    const scorer = await repo.createPlayer({ teamId: home.teamId, name: "Scorer" });
    const match = await repo.createMatch({ homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Old", kickoffAt: new Date(Date.now() + 3600_000).toISOString() });
    await repo.setMatchActivityClassification(match.matchId, "TRAINING", FINALIZER, null);
    const venue = await repo.createVenue({ name: "V", latitude: 10, longitude: 10, radiusMeters: 100 });
    const activation = await repo.createVenueActivation({ matchId: match.matchId, venueId: venue.venueId });
    const tier4 = await repo.createPrizeTier({ venueActivationId: activation.venueActivationId, correctDimensionCount: 4, prizeLabel: "Jersey" });
    const tier2 = await repo.createPrizeTier({ venueActivationId: activation.venueActivationId, correctDimensionCount: 2, prizeLabel: "Cap" });
    expect(tier4.ladderLevel).toBeNull();

    // Scoreline wrong, but "No Goalscorer", "No minute" and "No Goal" are right on a goalless draw... here a 1-0.
    const member = "legacy-member";
    const prediction = await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: member, venueActivationId: activation.venueActivationId,
      predictedHomeScore: 1, predictedAwayScore: 0, predictedGoalscorerPlayerId: scorer.playerId,
      predictedGoalMinuteRegulation: 10, predictedGoalMinuteStoppage: null, predictedFirstTeamToScore: "HOME", geo: NEAR,
    });
    expect(prediction.predictionContract).toBe("COMPLETE_COUNT_V1");
    expect(prediction.firstTeamState).toBeNull();
    expect(prediction.attemptedLevel).toBeNull();
    expect(prediction.acceptedOfferDigest).toBeNull();

    const saved = await saveResult(repo, {
      matchId: match.matchId, homeScore: 1, awayScore: 0,
      officialGoalEvents: [{ scorerPlayerId: scorer.playerId, minuteRegulation: 10 }], enteredByGamingMemberId: FINALIZER,
    });
    await finalizeMatchResult(repo, saved.matchResultId, FINALIZER);
    const evaluation = (await repo.getCurrentEvaluationForPrediction(prediction.predictionId))!;
    expect(evaluation.predictionContract).toBe("COMPLETE_COUNT_V1");
    expect(evaluation.attemptedLevel).toBeNull();
    expect(evaluation.ladderLevel).toBeNull();
    expect(evaluation.correctDimensionCount).toBe(4);
    const qualification = await repo.getQualificationForEvaluation(evaluation.evaluationId);
    expect(qualification!.prizeTierId).toBe(tier4.prizeTierId);
    expect(qualification!.prizeTierId).not.toBe(tier2.prizeTierId);
  });
});

// ---------------------------------------------------------------------------
// Every error is mapped to an HTTP status
// ---------------------------------------------------------------------------

describe("error mapping", () => {
  const NEW_ERRORS = [
    [domainTypes.ContractMismatchError, 409],
    [domainTypes.ContractFrozenError, 409],
    [domainTypes.OfferNotAvailableError, 409],
    [domainTypes.OfferChangedError, 409],
    [domainTypes.OfferFrozenError, 409],
    [domainTypes.ResultAlreadyFinalizedError, 409],
    [domainTypes.InvalidAttemptShapeError, 400],
    [domainTypes.LevelNotOfferedError, 400],
    [domainTypes.OfferDigestRequiredError, 400],
    [domainTypes.TierKeyContractMismatchError, 400],
    [domainTypes.InvalidPrizeTierLadderLevelError, 400],
  ] as const;

  it.each(NEW_ERRORS.map(([cls, status]) => [cls.name, cls, status] as const))("%s maps to HTTP %i", (_name, cls, status) => {
    expect(statusForPredictionsError(new (cls as new () => Error)())).toBe(status);
  });
});

// ---------------------------------------------------------------------------
// The routes
// ---------------------------------------------------------------------------

describe("routes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function post(body: unknown) {
    return new Request("http://localhost/api/gaming/predictions/matches/x/predict", {
      method: "POST",
      headers: { authorization: "Bearer t", "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  async function setup(offeredLevels = [1, 2, 3, 4]) {
    const { env, repo } = freshEnv();
    const w = await buildLadderWorld(env, { offeredLevels });
    useRepo(repo);
    const memberId = await env.newMember("route");
    vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ gamingMemberId: memberId } as never);
    const digest = (await offerDigestOf(env, w))!;
    const POST = (await import("../app/api/gaming/predictions/matches/[matchId]/predict/route")).POST;
    return { env, repo, w, memberId, digest, POST };
  }

  it("accepts a progressive request and answers with the explicit form, with no bare null", async () => {
    const { w, digest, POST, repo, memberId } = await setup();
    const res = await POST(
      post({
        venueActivationId: w.activationId, offerDigest: digest, attemptedLevel: 3,
        scoreline: { home: 2, away: 1 }, firstTeam: { kind: "PICKED", team: "HOME" }, goalscorer: { kind: "PICKED", playerId: w.players.mbappe },
        latitude: NEAR.latitude, longitude: NEAR.longitude, accuracyMeters: 5,
      }),
      { params: { matchId: w.matchId } }
    );
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.prediction.attemptedLevel).toBe(3);
    expect(body.prediction.firstTeam).toEqual({ kind: "PICKED", team: "HOME" });
    expect("goalMinute" in body.prediction).toBe(false);
    expect(JSON.stringify(body.prediction)).not.toContain(":null");
    expect((await repo.getPredictionForMember(w.matchId, memberId))!.attemptedLevel).toBe(3);
  });

  const GEO = { latitude: 10.0001, longitude: 10.0001 };
  const REFUSALS: Array<[string, number[], (w: LadderWorld, digest: string) => unknown, number]> = [
    ["the historical shape on a progressive match", [1, 2, 3, 4], (w) => ({ venueActivationId: w.activationId, predictedHomeScore: 1, predictedAwayScore: 0, predictedGoalscorerPlayerId: null, predictedGoalMinuteRegulation: null, predictedGoalMinuteStoppage: null, predictedFirstTeamToScore: null, ...GEO }), 409],
    ["a mix of both shapes", [1, 2, 3, 4], (w, d) => ({ venueActivationId: w.activationId, offerDigest: d, attemptedLevel: 1, scoreline: { home: 1, away: 0 }, predictedHomeScore: 1, ...GEO }), 409],
    ["an unknown field", [1, 2, 3, 4], (w, d) => ({ venueActivationId: w.activationId, offerDigest: d, attemptedLevel: 1, scoreline: { home: 1, away: 0 }, admin: true, ...GEO }), 400],
    ["a gap", [1, 2, 3, 4], (w, d) => ({ venueActivationId: w.activationId, offerDigest: d, attemptedLevel: 3, scoreline: { home: 1, away: 0 }, goalscorer: { kind: "NONE" }, ...GEO }), 400],
    ["a bare null category", [1, 2, 3, 4], (w, d) => ({ venueActivationId: w.activationId, offerDigest: d, attemptedLevel: 2, scoreline: { home: 1, away: 0 }, firstTeam: null, ...GEO }), 400],
    ["a level above the offer", [1, 2], (w, d) => ({ venueActivationId: w.activationId, offerDigest: d, attemptedLevel: 3, scoreline: { home: 1, away: 0 }, firstTeam: { kind: "NONE" }, goalscorer: { kind: "NONE" }, ...GEO }), 400],
    ["a missing fingerprint", [1, 2, 3, 4], (w) => ({ venueActivationId: w.activationId, attemptedLevel: 1, scoreline: { home: 1, away: 0 }, ...GEO }), 400],
    ["a stale fingerprint", [1, 2, 3, 4], (w) => ({ venueActivationId: w.activationId, offerDigest: "0".repeat(64), attemptedLevel: 1, scoreline: { home: 1, away: 0 }, ...GEO }), 409],
    ["no location", [1, 2, 3, 4], (w, d) => ({ venueActivationId: w.activationId, offerDigest: d, attemptedLevel: 1, scoreline: { home: 1, away: 0 } }), 400],
    ["no venue activation", [1, 2, 3, 4], (_w, d) => ({ offerDigest: d, attemptedLevel: 1, scoreline: { home: 1, away: 0 }, ...GEO }), 400],
    ["a non-object body", [1, 2, 3, 4], () => "level 1", 400],
  ];

  it.each(REFUSALS)("refuses %s", async (_name, levels, build, status) => {
    const { w, digest, POST, repo, memberId } = await setup(levels);
    const res = await POST(post(build(w, digest)), { params: { matchId: w.matchId } });
    expect(res.status).toBe(status);
    expect(await repo.getPredictionForMember(w.matchId, memberId)).toBeNull();
  });

  it("refuses the progressive shape on a historical match", async () => {
    const { repo } = freshEnv();
    useRepo(repo);
    const home = await repo.createTeam({ name: "H" });
    const away = await repo.createTeam({ name: "A" });
    const match = await repo.createMatch({ homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Old", kickoffAt: new Date(Date.now() + 3600_000).toISOString() });
    vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ gamingMemberId: "m" } as never);
    const POST = (await import("../app/api/gaming/predictions/matches/[matchId]/predict/route")).POST;
    const res = await POST(post({ venueActivationId: randomUUID(), offerDigest: "d", attemptedLevel: 1, scoreline: { home: 1, away: 0 } }), { params: { matchId: match.matchId } });
    expect(res.status).toBe(409);
  });

  it("answers 404 for an unknown match and keeps the historical shape working on a historical match", async () => {
    const { env, repo } = freshEnv();
    useRepo(repo);
    vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ gamingMemberId: "m" } as never);
    const POST = (await import("../app/api/gaming/predictions/matches/[matchId]/predict/route")).POST;
    expect((await POST(post({}), { params: { matchId: randomUUID() } })).status).toBe(404);

    const home = await repo.createTeam({ name: "H" });
    const away = await repo.createTeam({ name: "A" });
    const match = await repo.createMatch({ homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Old", kickoffAt: new Date(Date.now() + 3600_000).toISOString() });
    await repo.setMatchActivityClassification(match.matchId, "TRAINING", FINALIZER, null);
    const venue = await repo.createVenue({ name: "V", latitude: 10, longitude: 10, radiusMeters: 100 });
    const activation = await repo.createVenueActivation({ matchId: match.matchId, venueId: venue.venueId });
    const res = await POST(
      post({
        venueActivationId: activation.venueActivationId, predictedHomeScore: 1, predictedAwayScore: 0, predictedGoalscorerPlayerId: null,
        predictedGoalMinuteRegulation: null, predictedGoalMinuteStoppage: null, predictedFirstTeamToScore: null,
        latitude: 10.0001, longitude: 10.0001, accuracyMeters: 5,
      }),
      { params: { matchId: match.matchId } }
    );
    expect(res.status).toBe(201);
    expect((await res.json()).prediction.predictionContract).toBe("COMPLETE_COUNT_V1");
    void env;
  });

  it("GET matches exposes the contract and, for a progressive match, each activation's offer", async () => {
    const { env, repo } = freshEnv();
    const w = await buildLadderWorld(env, { offeredLevels: [1, 2] });
    const bare = await repo.createVenueActivation({ matchId: w.matchId, venueId: w.venueId });
    useRepo(repo);
    const { GET } = await import("../app/api/gaming/predictions/matches/route");
    const body = await (await GET()).json();
    const match = body.matches.find((m: { matchId: string }) => m.matchId === w.matchId);
    expect(match.predictionContract).toBe("PROGRESSIVE_LADDER_V1");
    const offered = match.venueActivations.find((a: { venueActivationId: string }) => a.venueActivationId === w.activationId);
    expect(offered.offer).toMatchObject({ available: true, maxLevel: 2 });
    expect(offered.offer.levels).toEqual([{ level: 1, label: "Prize L1" }, { level: 2, label: "Prize L2" }]);
    expect(offered.offer.digest).toBe(await offerDigestOf(env, w));
    const empty = match.venueActivations.find((a: { venueActivationId: string }) => a.venueActivationId === bare.venueActivationId);
    expect(empty.offer).toMatchObject({ available: false, maxLevel: 0, digest: null, problem: "NO_LEVELS" });
  });

  it("GET mine returns the explicit view of a progressive prediction", async () => {
    const { env, repo } = freshEnv();
    const w = await buildLadderWorld(env, { offeredLevels: [1, 2, 3] });
    const memberId = await env.newMember("mine");
    await submitAs(env, w, memberId, { attemptedLevel: 2, scoreline: { home: 0, away: 0 }, firstTeam: { kind: "NONE" } });
    useRepo(repo);
    vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ gamingMemberId: memberId } as never);
    const { GET } = await import("../app/api/gaming/predictions/matches/[matchId]/mine/route");
    const body = await (await GET(new Request("http://localhost/x", { headers: { authorization: "Bearer t" } }), { params: { matchId: w.matchId } })).json();
    expect(body.prediction.attemptedLevel).toBe(2);
    expect(body.prediction.firstTeam).toEqual({ kind: "NONE" });
    expect("goalscorer" in body.prediction).toBe(false);
    expect("predictedGoalscorerPlayerId" in body.prediction).toBe(false);
  });

  it("admin: a new match is created progressive unless the historical contract is named; a tier needs exactly one key", async () => {
    const { repo } = freshEnv();
    useRepo(repo);
    vi.mocked(httpAuth.requirePlatformAuthorityHttp).mockResolvedValue({ gamingMemberId: FINALIZER } as never);
    const home = await repo.createTeam({ name: "H" });
    const away = await repo.createTeam({ name: "A" });
    const { POST: createMatchRoute } = await import("../app/api/gaming/predictions/admin/matches/route");
    const matchRequest = (extra: object) =>
      new Request("http://localhost/x", { method: "POST", body: JSON.stringify({ homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "C", kickoffAt: new Date(Date.now() + 3600_000).toISOString(), ...extra }) });
    const created = await (await createMatchRoute(matchRequest({}))).json();
    expect(created.match.predictionContract).toBe("PROGRESSIVE_LADDER_V1");
    const historical = await (await createMatchRoute(matchRequest({ predictionContract: "COMPLETE_COUNT_V1" }))).json();
    expect(historical.match.predictionContract).toBe("COMPLETE_COUNT_V1");
    expect((await createMatchRoute(matchRequest({ predictionContract: "SOMETHING_ELSE" }))).status).toBe(400);

    const venue = await repo.createVenue({ name: "V", latitude: 10, longitude: 10, radiusMeters: 100 });
    const activation = await repo.createVenueActivation({ matchId: created.match.matchId, venueId: venue.venueId });
    const { POST: tierRoute } = await import("../app/api/gaming/predictions/admin/activations/[activationId]/prize-tiers/route");
    const tierRequest = (body: object) => tierRoute(new Request("http://localhost/x", { method: "POST", body: JSON.stringify(body) }), { params: { activationId: activation.venueActivationId } });
    expect((await tierRequest({ ladderLevel: 1, prizeLabel: "Easy prize" })).status).toBe(201);
    expect((await tierRequest({ ladderLevel: 1, prizeLabel: "dup" })).status).toBeGreaterThanOrEqual(400);
    expect((await tierRequest({ correctDimensionCount: 4, prizeLabel: "Jersey" })).status).toBe(400); // wrong key for this contract
    expect((await tierRequest({ ladderLevel: 2, correctDimensionCount: 2, prizeLabel: "both" })).status).toBe(400);
    expect((await tierRequest({ prizeLabel: "none" })).status).toBe(400);
    expect((await tierRequest({ ladderLevel: 9, prizeLabel: "high" })).status).toBe(400);

    const { GET: listActivations } = await import("../app/api/gaming/predictions/admin/activations/route");
    vi.mocked(httpAuth.requireAnyAdminAuthority).mockResolvedValue({ gamingMemberId: FINALIZER } as never);
    const listed = await (await listActivations(new Request("http://localhost/x"))).json();
    const row = listed.activations.find((a: { venueActivationId: string }) => a.venueActivationId === activation.venueActivationId);
    expect(row.predictionContract).toBe("PROGRESSIVE_LADDER_V1");
    expect(row.offer).toMatchObject({ available: true, maxLevel: 1 });
    expect(NextResponse).toBeDefined();
  });
});
