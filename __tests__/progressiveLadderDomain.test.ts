import { describe, expect, it } from "vitest";

import {
  LADDER_LEVELS,
  attemptedLevelOf,
  categoryOutcome,
  computeLadderOffer,
  hitCountOf,
  offerCanonicalText,
  offerDigestOf,
  parseProgressiveAnswers,
  progressiveColumnsOf,
  progressivePredictionView,
  wonLevelOf,
  type CategoryOutcomes,
} from "../lib/gaming/predictions/prizeLadder";
import { InvalidAttemptShapeError, type PredictionRecord } from "../lib/gaming/predictions/types";
import { FLAG_COMBINATIONS_16, prefixCases, scenarioExpectation } from "./helpers/progressiveLadderScenarios";

/**
 * URBANO Score — the ladder in its pure form: the won level is the
 * consecutive correct prefix over scoreline, first team, goalscorer, goal
 * minute; a category that was not attempted has no outcome and stops the
 * ladder; the prize offer is a consecutive prefix starting at Easy; and a
 * progressive request is validated strictly (no gaps, nothing above the
 * declared level, no bare nulls).
 */

const UUID_A = "11111111-1111-4111-8111-111111111111";

describe("the ladder order is fixed", () => {
  it("is scoreline (Easy), first team (Medium), goalscorer (Hard), goal minute (Legendary)", () => {
    expect(LADDER_LEVELS.map((l) => [l.level, l.key, l.category])).toEqual([
      [1, "EASY", "SCORELINE"],
      [2, "MEDIUM", "FIRST_TEAM"],
      [3, "HARD", "GOALSCORER"],
      [4, "LEGENDARY", "GOAL_MINUTE"],
    ]);
  });
});

describe("won level — the 16 combinations of a complete attempt", () => {
  // Expected, written out by hand: the consecutive correct prefix over (S, F, G, M).
  const EXPECTED: Array<[string, number, number]> = [
    // S F G M  -> won level, hits (the historical count)
    ["0000", 0, 0],
    ["0001", 0, 1],
    ["0010", 0, 1],
    ["0011", 0, 2],
    ["0100", 0, 1],
    ["0101", 0, 2],
    ["0110", 0, 2],
    ["0111", 0, 3],
    ["1000", 1, 1],
    ["1001", 1, 2],
    ["1010", 1, 2],
    ["1011", 1, 3],
    ["1100", 2, 2],
    ["1101", 2, 3],
    ["1110", 3, 3],
    ["1111", 4, 4],
  ];

  it("covers every one of the 16 combinations exactly once", () => {
    expect(EXPECTED.length).toBe(16);
    expect(new Set(EXPECTED.map(([bits]) => bits)).size).toBe(16);
    expect(FLAG_COMBINATIONS_16.map((f) => `${+f.S}${+f.F}${+f.G}${+f.M}`).sort()).toEqual(EXPECTED.map(([b]) => b).sort());
  });

  it.each(EXPECTED)("%s -> won level %i (hits %i)", (bits, won, hits) => {
    const outcomes: CategoryOutcomes = {
      scoreline: bits[0] === "1",
      firstTeam: bits[1] === "1",
      goalscorer: bits[2] === "1",
      goalMinute: bits[3] === "1",
    };
    expect(wonLevelOf(outcomes)).toBe(won);
    expect(hitCountOf(outcomes)).toBe(hits);
  });

  it("differs from the historical count in exactly the 11 combinations where a failure breaks the ladder before later hits", () => {
    const differing = EXPECTED.filter(([, won, hits]) => won !== hits).map(([bits]) => bits);
    expect(differing.length).toBe(11);
    expect(differing).toContain("0111"); // three hits, but the scoreline failed: nothing won
    expect(differing).toContain("1011"); // three hits, but first team failed: only Easy won
  });

  it("keeps a later hit from skipping a failed level", () => {
    expect(wonLevelOf({ scoreline: true, firstTeam: false, goalscorer: true, goalMinute: true })).toBe(1);
    expect(wonLevelOf({ scoreline: false, firstTeam: true, goalscorer: true, goalMinute: true })).toBe(0);
  });
});

describe("won level — every valid prefix of 1 to 4 attempted categories (30 cases)", () => {
  const cases = prefixCases();

  it("is 2 + 4 + 8 + 16 = 30 cases", () => {
    expect(cases.length).toBe(30);
    expect(cases.filter((c) => c.level === 1).length).toBe(2);
    expect(cases.filter((c) => c.level === 2).length).toBe(4);
    expect(cases.filter((c) => c.level === 3).length).toBe(8);
    expect(cases.filter((c) => c.level === 4).length).toBe(16);
  });

  it.each(cases.map((c) => [c.name, c] as const))("%s", (_name, c) => {
    const expected = scenarioExpectation(c.level, c.flags);
    expect(wonLevelOf(expected.outcomes)).toBe(expected.won);
    expect(expected.won).toBeLessThanOrEqual(c.level);
    // A category beyond the attempted level has no outcome at all.
    if (c.level < 2) expect(expected.outcomes.firstTeam).toBeNull();
    if (c.level < 3) expect(expected.outcomes.goalscorer).toBeNull();
    if (c.level < 4) expect(expected.outcomes.goalMinute).toBeNull();
  });

  it("never reaches Hard or Legendary when only two categories are attempted, however many are correct", () => {
    for (const c of cases.filter((x) => x.level === 2)) {
      expect(scenarioExpectation(2, { S: true, F: true, G: true, M: true }).won).toBe(2);
      expect(scenarioExpectation(2, c.flags).won).toBeLessThanOrEqual(2);
    }
  });

  it("a complete attempt agrees with the 16-combination table", () => {
    for (const flags of FLAG_COMBINATIONS_16) {
      const prefix = flags.S ? (flags.F ? (flags.G ? (flags.M ? 4 : 3) : 2) : 1) : 0;
      expect(scenarioExpectation(4, flags).won).toBe(prefix);
    }
  });
});

describe("category outcome — not attempted is not a goalless answer", () => {
  it("a category that was not attempted has no outcome, whatever the official record says", () => {
    expect(categoryOutcome("NOT_ATTEMPTED", true, 0)).toBeNull();
    expect(categoryOutcome("NOT_ATTEMPTED", false, 0)).toBeNull();
    expect(categoryOutcome("NOT_ATTEMPTED", true, 3)).toBeNull();
  });

  it("NONE is correct exactly when there were no regulation goals", () => {
    expect(categoryOutcome("NONE", false, 0)).toBe(true);
    expect(categoryOutcome("NONE", false, 1)).toBe(false);
    expect(categoryOutcome("NONE", true, 2)).toBe(false);
  });

  it("PICKED is correct exactly when the pick matched", () => {
    expect(categoryOutcome("PICKED", true, 2)).toBe(true);
    expect(categoryOutcome("PICKED", false, 2)).toBe(false);
    expect(categoryOutcome("PICKED", true, 0)).toBe(true);
  });

  it("an unattempted category stops the ladder where a NONE that is right would not", () => {
    const attemptedTwo: CategoryOutcomes = {
      scoreline: true,
      firstTeam: categoryOutcome("NONE", false, 0),
      goalscorer: categoryOutcome("NOT_ATTEMPTED", false, 0),
      goalMinute: categoryOutcome("NOT_ATTEMPTED", false, 0),
    };
    const attemptedFour: CategoryOutcomes = {
      scoreline: true,
      firstTeam: categoryOutcome("NONE", false, 0),
      goalscorer: categoryOutcome("NONE", false, 0),
      goalMinute: categoryOutcome("NONE", false, 0),
    };
    expect(wonLevelOf(attemptedTwo)).toBe(2);
    expect(wonLevelOf(attemptedFour)).toBe(4);
  });
});

describe("stored columns of an answer set", () => {
  it("writes an explicit state per category and a value only when PICKED", () => {
    const answers = parseProgressiveAnswers({
      attemptedLevel: 4,
      scoreline: { home: 0, away: 0 },
      firstTeam: { kind: "NONE" },
      goalscorer: { kind: "PICKED", playerId: UUID_A },
      goalMinute: { kind: "PICKED", regulation: 45, stoppage: 3 },
    });
    expect(progressiveColumnsOf(answers)).toEqual({
      firstTeamState: "NONE",
      firstTeam: null,
      goalscorerState: "PICKED",
      goalscorerPlayerId: UUID_A,
      goalMinuteState: "PICKED",
      goalMinuteRegulation: 45,
      goalMinuteStoppage: 3,
    });
  });

  it("marks every category above the attempted level NOT_ATTEMPTED with no value", () => {
    const answers = parseProgressiveAnswers({ attemptedLevel: 1, scoreline: { home: 2, away: 1 } });
    const columns = progressiveColumnsOf(answers);
    expect(columns).toEqual({
      firstTeamState: "NOT_ATTEMPTED",
      firstTeam: null,
      goalscorerState: "NOT_ATTEMPTED",
      goalscorerPlayerId: null,
      goalMinuteState: "NOT_ATTEMPTED",
      goalMinuteRegulation: null,
      goalMinuteStoppage: null,
    });
    expect(attemptedLevelOf(columns)).toBe(1);
  });

  it.each([
    [1, { firstTeamState: "NOT_ATTEMPTED", goalscorerState: "NOT_ATTEMPTED", goalMinuteState: "NOT_ATTEMPTED" }],
    [2, { firstTeamState: "NONE", goalscorerState: "NOT_ATTEMPTED", goalMinuteState: "NOT_ATTEMPTED" }],
    [3, { firstTeamState: "PICKED", goalscorerState: "NONE", goalMinuteState: "NOT_ATTEMPTED" }],
    [4, { firstTeamState: "PICKED", goalscorerState: "PICKED", goalMinuteState: "NONE" }],
  ] as const)("attempted level of the states for level %i", (level, states) => {
    expect(attemptedLevelOf(states)).toBe(level);
  });
});

describe("parseProgressiveAnswers — what a valid request looks like", () => {
  it("accepts a prefix of every length, with the scoreline first", () => {
    expect(parseProgressiveAnswers({ attemptedLevel: 1, scoreline: { home: 0, away: 0 } }).attemptedLevel).toBe(1);
    expect(
      parseProgressiveAnswers({ attemptedLevel: 2, scoreline: { home: 1, away: 0 }, firstTeam: { kind: "PICKED", team: "AWAY" } })
        .firstTeam
    ).toEqual({ kind: "PICKED", team: "AWAY" });
    expect(
      parseProgressiveAnswers({
        attemptedLevel: 3,
        scoreline: { home: 1, away: 0 },
        firstTeam: { kind: "NONE" },
        goalscorer: { kind: "NONE" },
      }).goalscorer
    ).toEqual({ kind: "NONE" });
    const full = parseProgressiveAnswers({
      attemptedLevel: 4,
      scoreline: { home: 3, away: 3 },
      firstTeam: { kind: "PICKED", team: "HOME" },
      goalscorer: { kind: "PICKED", playerId: UUID_A },
      goalMinute: { kind: "PICKED", regulation: 90, stoppage: null },
    });
    expect(full.goalMinute).toEqual({ kind: "PICKED", regulation: 90, stoppage: null });
  });

  it("treats an absent stoppage as no added time, and 0-0 as a valid scoreline", () => {
    const answers = parseProgressiveAnswers({
      attemptedLevel: 4,
      scoreline: { home: 0, away: 0 },
      firstTeam: { kind: "NONE" },
      goalscorer: { kind: "NONE" },
      goalMinute: { kind: "PICKED", regulation: 12 },
    });
    expect(answers.scoreline).toEqual({ home: 0, away: 0 });
    expect(answers.goalMinute).toEqual({ kind: "PICKED", regulation: 12, stoppage: null });
  });
});

describe("parseProgressiveAnswers — what is refused", () => {
  const scoreline = { home: 1, away: 0 };
  const first = { kind: "PICKED", team: "HOME" };
  const scorer = { kind: "PICKED", playerId: UUID_A };
  const minute = { kind: "PICKED", regulation: 30, stoppage: null };

  const REJECTED: Array<[string, unknown]> = [
    ["not an object", "level 1"],
    ["an array", []],
    ["null", null],
    ["no attempted level", { scoreline }],
    ["attempted level 0", { attemptedLevel: 0, scoreline }],
    ["attempted level 5", { attemptedLevel: 5, scoreline }],
    ["attempted level 1.5", { attemptedLevel: 1.5, scoreline }],
    ["attempted level as text", { attemptedLevel: "1", scoreline }],
    ["attempted level null", { attemptedLevel: null, scoreline }],
    ["no scoreline", { attemptedLevel: 1 }],
    ["scoreline null", { attemptedLevel: 1, scoreline: null }],
    ["scoreline without away", { attemptedLevel: 1, scoreline: { home: 1 } }],
    ["scoreline with a null score", { attemptedLevel: 1, scoreline: { home: 1, away: null } }],
    ["scoreline with a negative score", { attemptedLevel: 1, scoreline: { home: -1, away: 0 } }],
    ["scoreline with a fractional score", { attemptedLevel: 1, scoreline: { home: 1.5, away: 0 } }],
    ["scoreline with a text score", { attemptedLevel: 1, scoreline: { home: "1", away: 0 } }],
    ["scoreline with an absurd score", { attemptedLevel: 1, scoreline: { home: 1e12, away: 0 } }],
    ["scoreline with an extra field", { attemptedLevel: 1, scoreline: { home: 1, away: 0, extra: 1 } }],
    ["level 2 without the first team (a gap)", { attemptedLevel: 2, scoreline }],
    ["level 3 with a goalscorer but no first team (a gap)", { attemptedLevel: 3, scoreline, goalscorer: scorer }],
    ["level 3 without the goalscorer", { attemptedLevel: 3, scoreline, firstTeam: first }],
    ["level 4 without the goal minute", { attemptedLevel: 4, scoreline, firstTeam: first, goalscorer: scorer }],
    ["level 4 with a minute but no goalscorer (a gap)", { attemptedLevel: 4, scoreline, firstTeam: first, goalMinute: minute }],
    ["the first team above level 1", { attemptedLevel: 1, scoreline, firstTeam: first }],
    ["the goalscorer above level 2", { attemptedLevel: 2, scoreline, firstTeam: first, goalscorer: scorer }],
    ["the goal minute above level 3", { attemptedLevel: 3, scoreline, firstTeam: first, goalscorer: scorer, goalMinute: minute }],
    ["a null category above the level", { attemptedLevel: 1, scoreline, firstTeam: null }],
    ["a null first team at the level", { attemptedLevel: 2, scoreline, firstTeam: null }],
    ["a null goalscorer at the level", { attemptedLevel: 3, scoreline, firstTeam: first, goalscorer: null }],
    ["a null goal minute at the level", { attemptedLevel: 4, scoreline, firstTeam: first, goalscorer: scorer, goalMinute: null }],
    ["a category as a bare string", { attemptedLevel: 2, scoreline, firstTeam: "HOME" }],
    ["first team with an unknown kind", { attemptedLevel: 2, scoreline, firstTeam: { kind: "MAYBE" } }],
    ["first team PICKED without a team", { attemptedLevel: 2, scoreline, firstTeam: { kind: "PICKED" } }],
    ["first team PICKED with a bad team", { attemptedLevel: 2, scoreline, firstTeam: { kind: "PICKED", team: "DRAW" } }],
    ["first team NONE carrying a team", { attemptedLevel: 2, scoreline, firstTeam: { kind: "NONE", team: "HOME" } }],
    ["goalscorer PICKED without a player", { attemptedLevel: 3, scoreline, firstTeam: first, goalscorer: { kind: "PICKED" } }],
    ["goalscorer PICKED with a non-id", { attemptedLevel: 3, scoreline, firstTeam: first, goalscorer: { kind: "PICKED", playerId: "mbappe" } }],
    ["goalscorer PICKED with a null player", { attemptedLevel: 3, scoreline, firstTeam: first, goalscorer: { kind: "PICKED", playerId: null } }],
    ["goalscorer NONE carrying a player", { attemptedLevel: 3, scoreline, firstTeam: first, goalscorer: { kind: "NONE", playerId: UUID_A } }],
    ["goal minute PICKED without a minute", { attemptedLevel: 4, scoreline, firstTeam: first, goalscorer: scorer, goalMinute: { kind: "PICKED" } }],
    ["goal minute 0", { attemptedLevel: 4, scoreline, firstTeam: first, goalscorer: scorer, goalMinute: { kind: "PICKED", regulation: 0 } }],
    ["goal minute 91", { attemptedLevel: 4, scoreline, firstTeam: first, goalscorer: scorer, goalMinute: { kind: "PICKED", regulation: 91 } }],
    ["goal minute 12.5", { attemptedLevel: 4, scoreline, firstTeam: first, goalscorer: scorer, goalMinute: { kind: "PICKED", regulation: 12.5 } }],
    ["added time at minute 30", { attemptedLevel: 4, scoreline, firstTeam: first, goalscorer: scorer, goalMinute: { kind: "PICKED", regulation: 30, stoppage: 2 } }],
    ["added time of 0", { attemptedLevel: 4, scoreline, firstTeam: first, goalscorer: scorer, goalMinute: { kind: "PICKED", regulation: 45, stoppage: 0 } }],
    ["goal minute NONE carrying a minute", { attemptedLevel: 4, scoreline, firstTeam: first, goalscorer: scorer, goalMinute: { kind: "NONE", regulation: 30 } }],
    ["an unexpected top-level field", { attemptedLevel: 1, scoreline, predictedHomeScore: 1 }],
  ];

  it.each(REJECTED)("rejects %s", (_name, payload) => {
    expect(() => parseProgressiveAnswers(payload)).toThrow(InvalidAttemptShapeError);
  });

  it("rejects at least forty distinct malformed requests", () => {
    expect(REJECTED.length).toBeGreaterThanOrEqual(40);
  });
});

describe("computeLadderOffer — only a consecutive prefix starting at Easy is offered", () => {
  const tier = (ladderLevel: number | null, prizeLabel: string) => ({ ladderLevel, prizeLabel });

  it.each([
    [[1], 1],
    [[1, 2], 2],
    [[1, 2, 3], 3],
    [[1, 2, 3, 4], 4],
  ])("levels %j are offered up to level %i", (levels, max) => {
    const offer = computeLadderOffer(levels.map((l) => tier(l, `Prize ${l}`)));
    expect(offer.available).toBe(true);
    expect(offer.maxLevel).toBe(max);
    expect(offer.problem).toBeNull();
    expect(offer.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ["no prizes", [] as number[], "NO_LEVELS"],
    ["Medium alone", [2], "GAP"],
    ["Easy and Hard (a gap)", [1, 3], "GAP"],
    ["Easy, Medium and Legendary (a gap)", [1, 2, 4], "GAP"],
    ["Hard and Legendary without Easy", [3, 4], "GAP"],
    ["Legendary alone", [4], "GAP"],
  ])("%s is not available", (_name, levels, problem) => {
    const offer = computeLadderOffer(levels.map((l) => tier(l, `Prize ${l}`)));
    expect(offer.available).toBe(false);
    expect(offer.maxLevel).toBe(0);
    expect(offer.digest).toBeNull();
    expect(offer.problem).toBe(problem);
  });

  it("ignores historical count tiers: they are inert on a progressive match", () => {
    const offer = computeLadderOffer([tier(null, "Old Jersey"), tier(null, "Old Cap")]);
    expect(offer.available).toBe(false);
    expect(offer.problem).toBe("NO_LEVELS");
    const mixed = computeLadderOffer([tier(null, "Old Jersey"), tier(1, "New Easy")]);
    expect(mixed.maxLevel).toBe(1);
  });

  it("does not depend on the order the tiers are listed in", () => {
    const a = computeLadderOffer([tier(1, "One"), tier(2, "Two"), tier(3, "Three")]);
    const b = computeLadderOffer([tier(3, "Three"), tier(1, "One"), tier(2, "Two")]);
    expect(a.digest).toBe(b.digest);
    expect(a.levels).toEqual(b.levels);
  });

  it("changes the fingerprint when a label, a level or the highest level offered changes", () => {
    const base = computeLadderOffer([tier(1, "One"), tier(2, "Two")]).digest;
    expect(computeLadderOffer([tier(1, "One"), tier(2, "Two!")]).digest).not.toBe(base);
    expect(computeLadderOffer([tier(1, "One")]).digest).not.toBe(base);
    expect(computeLadderOffer([tier(1, "One"), tier(2, "Two"), tier(3, "Three")]).digest).not.toBe(base);
    expect(computeLadderOffer([tier(1, "Two"), tier(2, "One")]).digest).not.toBe(base);
  });

  it("cannot be confused by a label that looks like another line of the offer", () => {
    const a = computeLadderOffer([tier(1, "A"), tier(2, "B")]);
    const b = computeLadderOffer([tier(1, "A\n2|1|B")]);
    expect(offerCanonicalText(a.levels)).not.toBe(offerCanonicalText(b.levels));
    expect(a.digest).not.toBe(b.digest);
  });

  it("states the canonical text the SQL function builds (level|characters|label, newline-separated)", () => {
    expect(offerCanonicalText([{ level: 1, label: "Jersey" }, { level: 2, label: "Camiseta 🎽" }])).toBe("1|6|Jersey\n2|10|Camiseta 🎽");
    expect(offerDigestOf([{ level: 1, label: "Jersey" }])).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("progressivePredictionView — absent is not none", () => {
  const record = (patch: Partial<PredictionRecord>): PredictionRecord => ({
    predictionId: "p",
    matchId: "m",
    gamingMemberId: "g",
    venueActivationId: "a",
    predictedHomeScore: 0,
    predictedAwayScore: 0,
    predictedGoalscorerPlayerId: null,
    predictedGoalMinuteRegulation: null,
    predictedGoalMinuteStoppage: null,
    predictedFirstTeamToScore: null,
    predictionContract: "PROGRESSIVE_LADDER_V1",
    firstTeamState: "NOT_ATTEMPTED",
    goalscorerState: "NOT_ATTEMPTED",
    goalMinuteState: "NOT_ATTEMPTED",
    attemptedLevel: 1,
    acceptedOfferDigest: "d",
    acceptedOfferMaxLevel: 4,
    geoVerifiedAt: "",
    measuredDistanceMeters: 0,
    reportedAccuracyMeters: null,
    geoEligible: true,
    createdAt: "c",
    updatedAt: "u",
    ...patch,
  });

  it("omits a category the member did not attempt", () => {
    const view = progressivePredictionView(record({}));
    expect(view.attemptedLevel).toBe(1);
    expect("firstTeam" in view).toBe(false);
    expect("goalscorer" in view).toBe(false);
    expect("goalMinute" in view).toBe(false);
    expect(Object.values(view).includes(null as never)).toBe(false);
  });

  it("shows a deliberate none as NONE, distinct from an absent category", () => {
    const view = progressivePredictionView(
      record({ attemptedLevel: 3, firstTeamState: "NONE", goalscorerState: "NONE", goalMinuteState: "NOT_ATTEMPTED" })
    );
    expect(view.firstTeam).toEqual({ kind: "NONE" });
    expect(view.goalscorer).toEqual({ kind: "NONE" });
    expect("goalMinute" in view).toBe(false);
  });

  it("shows picked values", () => {
    const view = progressivePredictionView(
      record({
        attemptedLevel: 4,
        firstTeamState: "PICKED",
        predictedFirstTeamToScore: "AWAY",
        goalscorerState: "PICKED",
        predictedGoalscorerPlayerId: UUID_A,
        goalMinuteState: "PICKED",
        predictedGoalMinuteRegulation: 45,
        predictedGoalMinuteStoppage: 2,
      })
    );
    expect(view.firstTeam).toEqual({ kind: "PICKED", team: "AWAY" });
    expect(view.goalscorer).toEqual({ kind: "PICKED", playerId: UUID_A });
    expect(view.goalMinute).toEqual({ kind: "PICKED", regulation: 45, stoppage: 2 });
  });
});
