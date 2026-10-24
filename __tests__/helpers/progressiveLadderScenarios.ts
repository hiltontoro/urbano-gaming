import { expect } from "vitest";

import type { PredictionsRepository } from "../../lib/gaming/predictions/db/predictionsRepository";
import { submitProgressivePrediction } from "../../lib/gaming/predictions/submitPrediction";
import {
  PROGRESSIVE_PREDICTION_CONTRACT,
  computeLadderOffer,
  wonLevelOf,
  type CategoryOutcomes,
  type ProgressiveAnswers,
} from "../../lib/gaming/predictions/prizeLadder";
import type { PredictionRecord } from "../../lib/gaming/predictions/types";
import { currentSaveBase } from "./predictionsResultFixtures";

/**
 * Shared scenario tables for the progressive prediction contract. The very
 * same tables drive the in-memory repository (behavioral suite) and the SQL
 * functions (contract suite), so the two cannot drift: a case is built with
 * real roster players, submitted through the real write path, settled by the
 * real finalize, and checked against what the ladder rules say by hand.
 */

// --- Hand-written expectations ----------------------------------------------

export interface Flags {
  S: boolean;
  F: boolean;
  G: boolean;
  M: boolean;
}

/** Every combination of the four hits, scoreline most significant. */
export const FLAG_COMBINATIONS_16: Flags[] = Array.from({ length: 16 }, (_, n) => ({
  S: (n & 8) !== 0,
  F: (n & 4) !== 0,
  G: (n & 2) !== 0,
  M: (n & 1) !== 0,
}));

export interface PrefixCase {
  name: string;
  level: 1 | 2 | 3 | 4;
  flags: Flags;
}

/** Levels 1 to 4 with every combination of the categories that level attempts: 2 + 4 + 8 + 16 = 30. */
export function prefixCases(): PrefixCase[] {
  const cases: PrefixCase[] = [];
  for (const level of [1, 2, 3, 4] as const) {
    for (const flags of FLAG_COMBINATIONS_16) {
      // Categories above the level are not attempted: keep only the combinations where they are "false".
      if (level < 2 && flags.F) continue;
      if (level < 3 && flags.G) continue;
      if (level < 4 && flags.M) continue;
      const bits = `${+flags.S}${+flags.F}${+flags.G}${+flags.M}`.slice(0, level);
      cases.push({ name: `attempted level ${level}, correct ${bits}`, level, flags });
    }
  }
  return cases;
}

export interface Expectation {
  attempted: number;
  won: number;
  outcomes: CategoryOutcomes;
  hits: number;
}

/** What the ladder rules say for an attempt of `level` categories whose categories hit as `flags` say. */
export function scenarioExpectation(level: number, flags: Flags): Expectation {
  const outcomes: CategoryOutcomes = {
    scoreline: flags.S,
    firstTeam: level >= 2 ? flags.F : null,
    goalscorer: level >= 3 ? flags.G : null,
    goalMinute: level >= 4 ? flags.M : null,
  };
  const hits = [outcomes.scoreline, outcomes.firstTeam, outcomes.goalscorer, outcomes.goalMinute].filter((o) => o === true).length;
  return { attempted: level, won: wonLevelOf(outcomes), outcomes, hits };
}

// --- The world -----------------------------------------------------------

export interface LadderEnv {
  repo: PredictionsRepository;
  /** Creates a member (a real Auth user and Gaming Member for the database, a plain id in memory). */
  newMember(label: string): Promise<string>;
  finalizerId: string;
  operatorId: string;
}

export interface LadderWorld {
  matchId: string;
  activationId: string;
  venueId: string;
  players: { mbappe: string; vini: string; lewa: string; pedri: string };
  homeTeamId: string;
  awayTeamId: string;
  offeredLevels: number[];
  tierIdByLevel: Record<number, string>;
  labelByLevel: Record<number, string>;
}

export const NEAR = { latitude: 10.0001, longitude: 10.0001, accuracyMeters: 5 };

export function labelFor(level: number): string {
  return `Prize L${level}`;
}

export function unique(label: string): string {
  return `${label} ${Math.random().toString(16).slice(2, 10)}`;
}

/**
 * Two teams with two players each, one progressive match with an activation
 * and ladder tiers for exactly `offeredLevels`. `tiers: "none"` creates the
 * activation without prizes.
 */
export async function buildLadderWorld(
  env: LadderEnv,
  options: { offeredLevels: number[]; kickoffAt?: string }
): Promise<LadderWorld> {
  const { repo } = env;
  const home = await repo.createTeam({ name: unique("Madrid") });
  const away = await repo.createTeam({ name: unique("Barca") });
  const mbappe = await repo.createPlayer({ teamId: home.teamId, name: "Mbappe" });
  const vini = await repo.createPlayer({ teamId: home.teamId, name: "Vini" });
  const lewa = await repo.createPlayer({ teamId: away.teamId, name: "Lewandowski" });
  const pedri = await repo.createPlayer({ teamId: away.teamId, name: "Pedri" });
  const match = await repo.createMatch({
    homeTeamId: home.teamId,
    awayTeamId: away.teamId,
    competition: "Ladder Scenarios",
    kickoffAt: options.kickoffAt ?? new Date(Date.now() + 3600_000).toISOString(),
    predictionContract: PROGRESSIVE_PREDICTION_CONTRACT,
  });
  await repo.setMatchActivityClassification(match.matchId, "TRAINING", env.finalizerId, null);
  const venue = await repo.createVenue({ name: unique("Ladder Venue"), latitude: 10, longitude: 10, radiusMeters: 100 });
  const activation = await repo.createVenueActivation({ matchId: match.matchId, venueId: venue.venueId });
  const tierIdByLevel: Record<number, string> = {};
  const labelByLevel: Record<number, string> = {};
  for (const level of options.offeredLevels) {
    const tier = await repo.createLadderPrizeTier({
      venueActivationId: activation.venueActivationId,
      ladderLevel: level,
      prizeLabel: labelFor(level),
    });
    tierIdByLevel[level] = tier.prizeTierId;
    labelByLevel[level] = tier.prizeLabel;
  }
  return {
    matchId: match.matchId,
    activationId: activation.venueActivationId,
    venueId: venue.venueId,
    players: { mbappe: mbappe.playerId, vini: vini.playerId, lewa: lewa.playerId, pedri: pedri.playerId },
    homeTeamId: home.teamId,
    awayTeamId: away.teamId,
    offeredLevels: options.offeredLevels,
    tierIdByLevel,
    labelByLevel,
  };
}

export async function offerDigestOf(env: LadderEnv, world: LadderWorld): Promise<string | null> {
  return computeLadderOffer(await env.repo.listPrizeTiersForActivation(world.activationId)).digest;
}

/** Submits through the real domain write path with the fingerprint of the offer as it stands. */
export async function submitAs(
  env: LadderEnv,
  world: LadderWorld,
  memberId: string,
  answers: unknown,
  options: { offerDigest?: string | null; geo?: typeof NEAR | null; activationId?: string } = {}
): Promise<PredictionRecord> {
  return submitProgressivePrediction(env.repo, {
    matchId: world.matchId,
    gamingMemberId: memberId,
    venueActivationId: options.activationId ?? world.activationId,
    answers,
    offerDigest: options.offerDigest === undefined ? await offerDigestOf(env, world) : options.offerDigest,
    geo: options.geo === undefined ? NEAR : options.geo,
  });
}

// --- Official results ---------------------------------------------------------

export type OfficialKey = "TWO_ONE" | "TWO_ONE_AWAY_FIRST" | "GOALLESS";

/**
 * TWO_ONE: 2-1, Mbappe 10' (home, first), Lewandowski 30' (away), Vini 70' (home).
 * TWO_ONE_AWAY_FIRST: the same 2-1 with the away team scoring first: Lewandowski 5', Mbappe 30', Vini 70'.
 * GOALLESS: 0-0.
 */
export function officialGoals(world: LadderWorld, key: OfficialKey) {
  if (key === "GOALLESS") return { home: 0, away: 0, events: [] as Array<{ scorerPlayerId: string; minuteRegulation: number }> };
  if (key === "TWO_ONE_AWAY_FIRST") {
    return {
      home: 2,
      away: 1,
      events: [
        { scorerPlayerId: world.players.lewa, minuteRegulation: 5 },
        { scorerPlayerId: world.players.mbappe, minuteRegulation: 30 },
        { scorerPlayerId: world.players.vini, minuteRegulation: 70 },
      ],
    };
  }
  return {
    home: 2,
    away: 1,
    events: [
      { scorerPlayerId: world.players.mbappe, minuteRegulation: 10 },
      { scorerPlayerId: world.players.lewa, minuteRegulation: 30 },
      { scorerPlayerId: world.players.vini, minuteRegulation: 70 },
    ],
  };
}

/** Saves the draft and finalizes (or corrects) it, as the admin does: digest of exactly what was saved. */
export async function settle(env: LadderEnv, world: LadderWorld, key: OfficialKey, reason = "Official match sheet") {
  const spec = officialGoals(world, key);
  const saved = await env.repo.saveDraftMatchResult({
    matchId: world.matchId,
    homeScore: spec.home,
    awayScore: spec.away,
    officialGoalEvents: spec.events,
    enteredByGamingMemberId: env.operatorId,
    saveBase: await currentSaveBase(env.repo, world.matchId),
  });
  if (saved.isCorrection) {
    await env.repo.correctMatchResult(saved.matchResultId, env.finalizerId, reason, saved.contentDigest);
  } else {
    await env.repo.finalizeMatchResult(saved.matchResultId, env.finalizerId, null, saved.contentDigest);
  }
  return saved;
}

// --- Cases -----------------------------------------------------------------

/** Picks that make each category of the 2-1 match right or wrong, independently. */
export function answersFor(world: LadderWorld, level: number, flags: Flags): ProgressiveAnswers {
  const answers: ProgressiveAnswers = {
    attemptedLevel: level as 1 | 2 | 3 | 4,
    scoreline: flags.S ? { home: 2, away: 1 } : { home: 1, away: 0 },
  };
  if (level >= 2) answers.firstTeam = { kind: "PICKED", team: flags.F ? "HOME" : "AWAY" };
  if (level >= 3) answers.goalscorer = { kind: "PICKED", playerId: flags.G ? world.players.mbappe : world.players.pedri };
  if (level >= 4) answers.goalMinute = { kind: "PICKED", regulation: flags.M ? 30 : 55, stoppage: null };
  return answers;
}

export interface LadderCase {
  official: OfficialKey;
  name: string;
  build(world: LadderWorld): ProgressiveAnswers;
  expected: Expectation;
}

function outcomesOf(S: boolean | null, F: boolean | null, G: boolean | null, M: boolean | null): CategoryOutcomes {
  return { scoreline: S, firstTeam: F, goalscorer: G, goalMinute: M };
}

function expectationOf(attempted: number, outcomes: CategoryOutcomes): Expectation {
  const hits = [outcomes.scoreline, outcomes.firstTeam, outcomes.goalscorer, outcomes.goalMinute].filter((o) => o === true).length;
  return { attempted, won: wonLevelOf(outcomes), outcomes, hits };
}

const NONE = { kind: "NONE" } as const;

/** The 30 prefix cases (the 16 complete attempts are the level-4 ones) on the 2-1 match. */
export function twoOneCases(): LadderCase[] {
  const prefixes: LadderCase[] = prefixCases().map((c) => ({
    official: "TWO_ONE",
    name: c.name,
    build: (world) => answersFor(world, c.level, c.flags),
    expected: scenarioExpectation(c.level, c.flags),
  }));
  const none: LadderCase[] = [
    {
      official: "TWO_ONE",
      name: "level 4: right scoreline, then NONE for team, player and minute on a match WITH goals (all three wrong)",
      build: () => ({ attemptedLevel: 4, scoreline: { home: 2, away: 1 }, firstTeam: NONE, goalscorer: NONE, goalMinute: NONE }),
      expected: expectationOf(4, outcomesOf(true, false, false, false)),
    },
    {
      official: "TWO_ONE",
      name: "level 2: right scoreline, NONE for the first team on a match WITH goals (wrong)",
      build: () => ({ attemptedLevel: 2, scoreline: { home: 2, away: 1 }, firstTeam: NONE }),
      expected: expectationOf(2, outcomesOf(true, false, null, null)),
    },
    {
      official: "TWO_ONE",
      name: "level 3: right scoreline and first team, NONE for the goalscorer on a match WITH goals (wrong)",
      build: () => ({ attemptedLevel: 3, scoreline: { home: 2, away: 1 }, firstTeam: { kind: "PICKED", team: "HOME" }, goalscorer: NONE }),
      expected: expectationOf(3, outcomesOf(true, true, false, null)),
    },
  ];
  return [...prefixes, ...none];
}

/** 0-0 with no goals: a NONE is right, a pick is wrong, and what was not attempted is neither. */
export function goallessCases(): LadderCase[] {
  const zero = { home: 0, away: 0 };
  return [
    {
      official: "GOALLESS",
      name: "0-0 with every category NONE reaches level 4",
      build: () => ({ attemptedLevel: 4, scoreline: zero, firstTeam: NONE, goalscorer: NONE, goalMinute: NONE }),
      expected: expectationOf(4, outcomesOf(true, true, true, true)),
    },
    {
      official: "GOALLESS",
      name: "0-0 and NONE team, attempted level 2: the goalscorer and the minute are NOT attempted, so not right",
      build: () => ({ attemptedLevel: 2, scoreline: zero, firstTeam: NONE }),
      expected: expectationOf(2, outcomesOf(true, true, null, null)),
    },
    {
      official: "GOALLESS",
      name: "0-0, NONE team and NONE goalscorer, attempted level 3: the minute is NOT attempted",
      build: () => ({ attemptedLevel: 3, scoreline: zero, firstTeam: NONE, goalscorer: NONE }),
      expected: expectationOf(3, outcomesOf(true, true, true, null)),
    },
    {
      official: "GOALLESS",
      name: "scoreline wrong with every NONE right: three hits, nothing won",
      build: () => ({ attemptedLevel: 4, scoreline: { home: 1, away: 0 }, firstTeam: NONE, goalscorer: NONE, goalMinute: NONE }),
      expected: expectationOf(4, outcomesOf(false, true, true, true)),
    },
    {
      official: "GOALLESS",
      name: "a picked first team is wrong when there are no goals: level 1 only, though two NONEs are right",
      build: (world) => ({
        attemptedLevel: 4,
        scoreline: zero,
        firstTeam: { kind: "PICKED", team: "HOME" },
        goalscorer: NONE,
        goalMinute: NONE,
      }),
      expected: expectationOf(4, outcomesOf(true, false, true, true)),
    },
    {
      official: "GOALLESS",
      name: "a picked goalscorer is wrong when there are no goals",
      build: (world) => ({
        attemptedLevel: 4,
        scoreline: zero,
        firstTeam: NONE,
        goalscorer: { kind: "PICKED", playerId: world.players.mbappe },
        goalMinute: NONE,
      }),
      expected: expectationOf(4, outcomesOf(true, true, false, true)),
    },
    {
      official: "GOALLESS",
      name: "0-0 only, attempted level 1",
      build: () => ({ attemptedLevel: 1, scoreline: zero }),
      expected: expectationOf(1, outcomesOf(true, null, null, null)),
    },
  ];
}

/** The prize label a won level maps to, given the levels the activation offers; no descent. */
export function expectedPrize(world: LadderWorld, won: number): string | null {
  return won >= 1 && world.labelByLevel[won] !== undefined ? world.labelByLevel[won] : null;
}

/** Checks one settled prediction against its case: the explicit outcomes, both levels and the single prize. */
export async function expectSettled(env: LadderEnv, world: LadderWorld, memberId: string, c: LadderCase, prediction: PredictionRecord) {
  const evaluation = await env.repo.getCurrentEvaluationForPrediction(prediction.predictionId);
  expect(evaluation, c.name).not.toBeNull();
  const e = evaluation!;
  expect(e.predictionContract, c.name).toBe("PROGRESSIVE_LADDER_V1");
  expect(e.attemptedLevel, c.name).toBe(c.expected.attempted);
  expect(e.ladderLevel, c.name).toBe(c.expected.won);
  expect(e.scorelineCorrect, c.name).toBe(c.expected.outcomes.scoreline);
  expect(e.firstTeamToScoreCorrect, c.name).toBe(c.expected.outcomes.firstTeam);
  expect(e.goalscorerCorrect, c.name).toBe(c.expected.outcomes.goalscorer);
  expect(e.goalMinuteCorrect, c.name).toBe(c.expected.outcomes.goalMinute);
  expect(e.correctDimensionCount, c.name).toBe(c.expected.hits);
  expect(e.ladderLevel as number, c.name).toBeLessThanOrEqual(e.attemptedLevel as number);

  const qualification = await env.repo.getQualificationForEvaluation(e.evaluationId);
  const prize = expectedPrize(world, c.expected.won);
  if (prize === null) {
    expect(qualification, c.name).toBeNull();
  } else {
    expect(qualification, c.name).not.toBeNull();
    expect(qualification!.prizeTierId, c.name).toBe(world.tierIdByLevel[c.expected.won]);
    expect(qualification!.gamingMemberId, c.name).toBe(memberId);
  }
}
