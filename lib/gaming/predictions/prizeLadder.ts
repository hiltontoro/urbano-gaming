import { createHash } from "node:crypto";

import type { CategoryState, PredictionContract, PredictionRecord } from "./types";
import { InvalidAttemptShapeError, IncoherentAnswersError } from "./types";
import type { IncoherenceCode } from "./types";

/**
 * URBANO Score — the progressive prediction contract and its prize
 * ladder.
 *
 * Two things are kept apart on purpose:
 *   - the ATTEMPTED level: how many categories, in order, the member
 *     completed and sent (a consecutive prefix of 1 to 4);
 *   - the WON level: how many of those, in order, were correct (the
 *     consecutive correct prefix). The won level never exceeds the
 *     attempted level, because a category that was not attempted has no
 *     outcome at all (null) and null stops the prefix.
 * correct_dimension_count is a different, older fact — how many
 * dimensions were correct — and is never reused as a ladder level.
 *
 * Category order is fixed and not configurable:
 *   1 Easy      Exact scoreline
 *   2 Medium    First team to score
 *   3 Hard      Any goalscorer
 *   4 Legendary Any goal minute
 *
 * A category that was not attempted (NOT_ATTEMPTED) is different from a
 * deliberate "no team / no player / no minute" selection (NONE), which is
 * an answer: it is correct exactly when the official record has no
 * regulation-time goals. Neither is ever represented by a bare null in
 * a request or in a progressive row.
 */

export const LEGACY_PREDICTION_CONTRACT: PredictionContract = "COMPLETE_COUNT_V1";
export const PROGRESSIVE_PREDICTION_CONTRACT: PredictionContract = "PROGRESSIVE_LADDER_V1";

export const MAX_LADDER_LEVEL = 4;

export type LadderLevel = 1 | 2 | 3 | 4;
export type WonLevel = 0 | LadderLevel;
export type LadderCategory = "SCORELINE" | "FIRST_TEAM" | "GOALSCORER" | "GOAL_MINUTE";

/** The ladder, in the only order it exists. */
export const LADDER_LEVELS: ReadonlyArray<{ level: LadderLevel; key: "EASY" | "MEDIUM" | "HARD" | "LEGENDARY"; category: LadderCategory }> = [
  { level: 1, key: "EASY", category: "SCORELINE" },
  { level: 2, key: "MEDIUM", category: "FIRST_TEAM" },
  { level: 3, key: "HARD", category: "GOALSCORER" },
  { level: 4, key: "LEGENDARY", category: "GOAL_MINUTE" },
];

export const LADDER_LEVEL_NAMES: Record<"es" | "en", readonly [string, string, string, string]> = {
  es: ["Fácil", "Mediana", "Difícil", "Legendaria"],
  en: ["Easy", "Medium", "Hard", "Legendary"],
};

/** Largest value a PostgreSQL integer column accepts; keeps a hostile number a 400, never a database error. */
const MAX_INTEGER = 2147483647;
const UUID_PATTERN = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

// --- Requests ----------------------------------------------------------

export type FirstTeamAnswer = { kind: "PICKED"; team: "HOME" | "AWAY" } | { kind: "NONE" };
export type GoalscorerAnswer = { kind: "PICKED"; playerId: string } | { kind: "NONE" };
export type GoalMinuteAnswer =
  | { kind: "PICKED"; regulation: number; stoppage: number | null }
  | { kind: "NONE" };

/**
 * A validated progressive prediction. A category above the attempted
 * level is ABSENT (undefined) — never null. Below or at the attempted
 * level it is always present.
 */
export interface ProgressiveAnswers {
  attemptedLevel: LadderLevel;
  scoreline: { home: number; away: number };
  firstTeam?: FirstTeamAnswer;
  goalscorer?: GoalscorerAnswer;
  goalMinute?: GoalMinuteAnswer;
}

/** The three optional categories as stored: an explicit state plus, only when PICKED, a value. */
export interface ProgressiveCategoryColumns {
  firstTeamState: CategoryState;
  firstTeam: "HOME" | "AWAY" | null;
  goalscorerState: CategoryState;
  goalscorerPlayerId: string | null;
  goalMinuteState: CategoryState;
  goalMinuteRegulation: number | null;
  goalMinuteStoppage: number | null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function rejectUnknownKeys(label: string, value: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) {
      throw new InvalidAttemptShapeError(`${label} carries an unexpected field "${key}".`);
    }
  }
}

function wholeNumber(label: string, value: unknown, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new InvalidAttemptShapeError(`${label} must be a whole number from ${min} to ${max}.`);
  }
  return value;
}

function parseFirstTeam(value: unknown): FirstTeamAnswer {
  if (!isPlainObject(value)) throw new InvalidAttemptShapeError("firstTeam must be an object.");
  if (value.kind === "NONE") {
    rejectUnknownKeys("firstTeam", value, ["kind"]);
    return { kind: "NONE" };
  }
  if (value.kind === "PICKED") {
    rejectUnknownKeys("firstTeam", value, ["kind", "team"]);
    if (value.team !== "HOME" && value.team !== "AWAY") {
      throw new InvalidAttemptShapeError("firstTeam.team must be HOME or AWAY.");
    }
    return { kind: "PICKED", team: value.team };
  }
  throw new InvalidAttemptShapeError("firstTeam.kind must be PICKED or NONE.");
}

function parseGoalscorer(value: unknown): GoalscorerAnswer {
  if (!isPlainObject(value)) throw new InvalidAttemptShapeError("goalscorer must be an object.");
  if (value.kind === "NONE") {
    rejectUnknownKeys("goalscorer", value, ["kind"]);
    return { kind: "NONE" };
  }
  if (value.kind === "PICKED") {
    rejectUnknownKeys("goalscorer", value, ["kind", "playerId"]);
    if (typeof value.playerId !== "string" || !UUID_PATTERN.test(value.playerId)) {
      throw new InvalidAttemptShapeError("goalscorer.playerId must be a player id.");
    }
    return { kind: "PICKED", playerId: value.playerId };
  }
  throw new InvalidAttemptShapeError("goalscorer.kind must be PICKED or NONE.");
}

function parseGoalMinute(value: unknown): GoalMinuteAnswer {
  if (!isPlainObject(value)) throw new InvalidAttemptShapeError("goalMinute must be an object.");
  if (value.kind === "NONE") {
    rejectUnknownKeys("goalMinute", value, ["kind"]);
    return { kind: "NONE" };
  }
  if (value.kind === "PICKED") {
    rejectUnknownKeys("goalMinute", value, ["kind", "regulation", "stoppage"]);
    const regulation = wholeNumber("goalMinute.regulation", value.regulation, 1, 90);
    let stoppage: number | null = null;
    if (value.stoppage !== undefined && value.stoppage !== null) {
      stoppage = wholeNumber("goalMinute.stoppage", value.stoppage, 1, MAX_INTEGER);
      if (regulation !== 45 && regulation !== 90) {
        throw new InvalidAttemptShapeError("goalMinute.stoppage is only allowed with minute 45 or 90.");
      }
    }
    return { kind: "PICKED", regulation, stoppage };
  }
  throw new InvalidAttemptShapeError("goalMinute.kind must be PICKED or NONE.");
}

/**
 * Validates the answers part of a progressive request. Rejects: a missing
 * or out-of-range attempted level; an incomplete or invalid scoreline; a
 * category above the attempted level (present, even as null); a category
 * at or below it that is missing (a gap) or null; an unknown kind; a NONE
 * that carries a value; a PICKED that carries none. A bare null is never
 * an answer.
 */
export function parseProgressiveAnswers(input: unknown): ProgressiveAnswers {
  if (!isPlainObject(input)) throw new InvalidAttemptShapeError("The prediction must be an object.");
  rejectUnknownKeys("The prediction", input, ["attemptedLevel", "scoreline", "firstTeam", "goalscorer", "goalMinute"]);

  const attemptedLevel = wholeNumber("attemptedLevel", input.attemptedLevel, 1, MAX_LADDER_LEVEL) as LadderLevel;

  if (!isPlainObject(input.scoreline)) throw new InvalidAttemptShapeError("scoreline must be an object with home and away.");
  rejectUnknownKeys("scoreline", input.scoreline, ["home", "away"]);
  const scoreline = {
    home: wholeNumber("scoreline.home", input.scoreline.home, 0, MAX_INTEGER),
    away: wholeNumber("scoreline.away", input.scoreline.away, 0, MAX_INTEGER),
  };

  const categories: Array<{ key: "firstTeam" | "goalscorer" | "goalMinute"; level: LadderLevel }> = [
    { key: "firstTeam", level: 2 },
    { key: "goalscorer", level: 3 },
    { key: "goalMinute", level: 4 },
  ];
  for (const { key, level } of categories) {
    const value = input[key];
    if (attemptedLevel >= level) {
      if (value === undefined) {
        throw new InvalidAttemptShapeError(`${key} is missing: a level cannot be attempted without every category before it.`);
      }
    } else if (value !== undefined) {
      throw new InvalidAttemptShapeError(`${key} is above the attempted level ${attemptedLevel}.`);
    }
  }

  const answers: ProgressiveAnswers = { attemptedLevel, scoreline };
  if (attemptedLevel >= 2) answers.firstTeam = parseFirstTeam(input.firstTeam);
  if (attemptedLevel >= 3) answers.goalscorer = parseGoalscorer(input.goalscorer);
  if (attemptedLevel >= 4) answers.goalMinute = parseGoalMinute(input.goalMinute);
  return answers;
}

// --- Coherence between answers --------------------------------------------
//
// The categories are independent questions, but one scoreline has to be able to produce them all:
//   - 0-0: a category that is attempted can only be answered with an explicit NONE (no team scores, no player scores, no minute);
//   - any goal: NONE is not an answer (there will be a first team, a scorer and a minute);
//   - the first team to score needs at least one goal in the predicted scoreline;
//   - the goalscorer must belong to a team with at least one predicted goal.
// The goalscorer and the minute need not refer to the same goal. A category that was not attempted is not an answer and is never
// completed here, and the attempted level is never raised. These rules judge a NEW answer or an EDIT; an exact repeat of a prediction
// already accepted is a replay (isExactProgressiveReplay) and keeps its confirmation semantics, whatever it contains.

export const INCOHERENCE_MESSAGES: Record<IncoherenceCode, string> = {
  ONLY_NONE_WITH_NO_GOALS: "With a 0-0 scoreline, a later category can only be answered with none.",
  NONE_NOT_ALLOWED_WITH_GOALS: "With goals in the scoreline, none is not a valid answer for a later category.",
  FIRST_TEAM_WITHOUT_GOALS: "The first team to score must have at least one goal in the predicted scoreline.",
  SCORER_TEAM_WITHOUT_GOALS: "The goalscorer must belong to a team with at least one goal in the predicted scoreline.",
};

export type ScorerSide = "HOME" | "AWAY";

export interface CoherenceProblem {
  code: IncoherenceCode;
  category: "firstTeam" | "goalscorer" | "goalMinute";
}

/**
 * Every contradiction in the answers, in ladder order; an empty list means they are coherent. scorerSide is the side of the picked
 * goalscorer's team in THIS match, or null when it is not known (then only the rules that do not need it are applied).
 */
export function progressiveCoherenceProblems(answers: ProgressiveAnswers, scorerSide: ScorerSide | null): CoherenceProblem[] {
  const { home, away } = answers.scoreline;
  const goals = home + away;
  const problems: CoherenceProblem[] = [];
  const check = (category: CoherenceProblem["category"], answer: { kind: "PICKED" | "NONE" } | undefined) => {
    if (answer === undefined) return; // not attempted: not an answer, nothing to contradict
    if (goals === 0 && answer.kind === "PICKED") problems.push({ code: "ONLY_NONE_WITH_NO_GOALS", category });
    else if (goals > 0 && answer.kind === "NONE") problems.push({ code: "NONE_NOT_ALLOWED_WITH_GOALS", category });
  };
  check("firstTeam", answers.firstTeam);
  check("goalscorer", answers.goalscorer);
  check("goalMinute", answers.goalMinute);
  if (answers.firstTeam && answers.firstTeam.kind === "PICKED") {
    const scored = answers.firstTeam.team === "HOME" ? home : away;
    if (goals > 0 && scored === 0) problems.push({ code: "FIRST_TEAM_WITHOUT_GOALS", category: "firstTeam" });
  }
  if (answers.goalscorer && answers.goalscorer.kind === "PICKED" && scorerSide !== null) {
    const scored = scorerSide === "HOME" ? home : away;
    if (goals > 0 && scored === 0) problems.push({ code: "SCORER_TEAM_WITHOUT_GOALS", category: "goalscorer" });
  }
  return problems;
}

/** Throws IncoherentAnswersError for the first contradiction; returns when the answers are coherent. */
export function assertCoherentAnswers(answers: ProgressiveAnswers, scorerSide: ScorerSide | null): void {
  const [first] = progressiveCoherenceProblems(answers, scorerSide);
  if (first) throw new IncoherentAnswersError(first.code, INCOHERENCE_MESSAGES[first.code]);
}

/**
 * true when `answers` sent for `venueActivationId` with `offerDigest` are, in every answer, the prediction already stored: the same
 * test the database function uses for a replay. A replay changes nothing (no new edit, no new measurement), so it is never judged
 * again, not even by rules that came after the stored prediction was accepted.
 */
export function isExactProgressiveReplay(
  stored: PredictionRecord | null,
  venueActivationId: string,
  answers: ProgressiveAnswers,
  offerDigest: string | null
): boolean {
  if (!stored || stored.predictionContract !== PROGRESSIVE_PREDICTION_CONTRACT) return false;
  if (typeof offerDigest !== "string" || offerDigest.length === 0 || stored.acceptedOfferDigest !== offerDigest) return false;
  const columns = progressiveColumnsOf(answers);
  return (
    stored.venueActivationId === venueActivationId &&
    stored.attemptedLevel === answers.attemptedLevel &&
    stored.predictedHomeScore === answers.scoreline.home &&
    stored.predictedAwayScore === answers.scoreline.away &&
    stored.firstTeamState === columns.firstTeamState &&
    stored.predictedFirstTeamToScore === columns.firstTeam &&
    stored.goalscorerState === columns.goalscorerState &&
    stored.predictedGoalscorerPlayerId === columns.goalscorerPlayerId &&
    stored.goalMinuteState === columns.goalMinuteState &&
    stored.predictedGoalMinuteRegulation === columns.goalMinuteRegulation &&
    stored.predictedGoalMinuteStoppage === columns.goalMinuteStoppage
  );
}

/** The stored form of the answers: explicit state per category, a value only when PICKED. */
export function progressiveColumnsOf(answers: ProgressiveAnswers): ProgressiveCategoryColumns {
  const firstTeam = answers.firstTeam;
  const goalscorer = answers.goalscorer;
  const goalMinute = answers.goalMinute;
  return {
    firstTeamState: firstTeam === undefined ? "NOT_ATTEMPTED" : firstTeam.kind === "NONE" ? "NONE" : "PICKED",
    firstTeam: firstTeam !== undefined && firstTeam.kind === "PICKED" ? firstTeam.team : null,
    goalscorerState: goalscorer === undefined ? "NOT_ATTEMPTED" : goalscorer.kind === "NONE" ? "NONE" : "PICKED",
    goalscorerPlayerId: goalscorer !== undefined && goalscorer.kind === "PICKED" ? goalscorer.playerId : null,
    goalMinuteState: goalMinute === undefined ? "NOT_ATTEMPTED" : goalMinute.kind === "NONE" ? "NONE" : "PICKED",
    goalMinuteRegulation: goalMinute !== undefined && goalMinute.kind === "PICKED" ? goalMinute.regulation : null,
    goalMinuteStoppage: goalMinute !== undefined && goalMinute.kind === "PICKED" ? goalMinute.stoppage : null,
  };
}

/** 1 + the optional categories that are not NOT_ATTEMPTED. Only meaningful for a prefix-closed set of states. */
export function attemptedLevelOf(states: { firstTeamState: CategoryState; goalscorerState: CategoryState; goalMinuteState: CategoryState }): LadderLevel {
  return (1 +
    (states.firstTeamState !== "NOT_ATTEMPTED" ? 1 : 0) +
    (states.goalscorerState !== "NOT_ATTEMPTED" ? 1 : 0) +
    (states.goalMinuteState !== "NOT_ATTEMPTED" ? 1 : 0)) as LadderLevel;
}

// --- Evaluation ---------------------------------------------------------

/**
 * One outcome per category: true / false for an attempted category, null
 * for one that was not attempted. A null is never "correct".
 */
export interface CategoryOutcomes {
  scoreline: boolean | null;
  firstTeam: boolean | null;
  goalscorer: boolean | null;
  goalMinute: boolean | null;
}

/**
 * The won level: the length of the consecutive run of true outcomes, in
 * ladder order, starting at the scoreline. Anything that is not true —
 * false or not attempted — stops the run.
 */
export function wonLevelOf(outcomes: CategoryOutcomes): WonLevel {
  if (outcomes.scoreline !== true) return 0;
  if (outcomes.firstTeam !== true) return 1;
  if (outcomes.goalscorer !== true) return 2;
  if (outcomes.goalMinute !== true) return 3;
  return 4;
}

/** How many outcomes are true (the historical dimension count; never a ladder level). */
export function hitCountOf(outcomes: CategoryOutcomes): number {
  return [outcomes.scoreline, outcomes.firstTeam, outcomes.goalscorer, outcomes.goalMinute].filter((o) => o === true).length;
}

/**
 * Outcome of one attempted-or-not category. NOT_ATTEMPTED -> null;
 * NONE -> correct exactly when there were no regulation-time goals;
 * PICKED -> whether the pick matched.
 */
export function categoryOutcome(state: CategoryState, pickedMatches: boolean, officialRegulationGoalCount: number): boolean | null {
  if (state === "NOT_ATTEMPTED") return null;
  if (state === "NONE") return officialRegulationGoalCount === 0;
  return pickedMatches;
}

// --- Offer -------------------------------------------------------------

export type OfferProblem = "NO_LEVELS" | "GAP";

export interface LadderOffer {
  /** Highest level that can be attempted at this activation; 0 when the offer is not available. */
  maxLevel: 0 | LadderLevel;
  /** The configured prize levels, in order (with a gap, only what is configured). */
  levels: Array<{ level: number; label: string }>;
  /** Fingerprint of exactly the offered levels and labels; null when the offer is not available. */
  digest: string | null;
  available: boolean;
  problem: OfferProblem | null;
}

/**
 * The canonical text the digest is taken over. The SQL function
 * progressive_offer_digest builds the same string, so the two agree
 * byte for byte (a test compares them): one line per level in order,
 * "level|length-of-label-in-characters|label".
 */
export function offerCanonicalText(levels: Array<{ level: number; label: string }>): string {
  return levels.map((entry) => `${entry.level}|${[...entry.label].length}|${entry.label}`).join("\n");
}

export function offerDigestOf(levels: Array<{ level: number; label: string }>): string {
  return createHash("sha256").update(offerCanonicalText(levels), "utf8").digest("hex");
}

/**
 * What an activation offers, from its prize tiers. Only ladder tiers
 * count (historical count tiers are inert here). The offer is available
 * only when the configured levels are exactly 1..n for some n from 1 to
 * 4 — Easy; Easy+Medium; Easy+Medium+Hard; or all four. No prizes, or
 * a gap (for example Easy and Hard without Medium), makes it
 * unavailable. There is never a descent to a different prize.
 */
export function computeLadderOffer(tiers: Array<{ ladderLevel: number | null; prizeLabel: string }>): LadderOffer {
  const levels = tiers
    .filter((tier): tier is { ladderLevel: number; prizeLabel: string } => tier.ladderLevel !== null)
    .map((tier) => ({ level: tier.ladderLevel, label: tier.prizeLabel }))
    .sort((a, b) => a.level - b.level);

  if (levels.length === 0) {
    return { maxLevel: 0, levels, digest: null, available: false, problem: "NO_LEVELS" };
  }
  const prefix = levels.every((entry, index) => entry.level === index + 1);
  if (!prefix) {
    return { maxLevel: 0, levels, digest: null, available: false, problem: "GAP" };
  }
  return {
    maxLevel: levels.length as LadderLevel,
    levels,
    digest: offerDigestOf(levels),
    available: true,
    problem: null,
  };
}

// --- What a member sees of their own progressive prediction -------------

/**
 * A member's own progressive prediction in explicit form: a category the
 * member did not attempt is ABSENT, never null, and a deliberate "none"
 * is {kind: "NONE"}. A bare null in a value column of the stored row is
 * never exposed.
 */
export interface ProgressivePredictionView {
  predictionId: string;
  matchId: string;
  venueActivationId: string;
  predictionContract: "PROGRESSIVE_LADDER_V1";
  attemptedLevel: number;
  scoreline: { home: number; away: number };
  firstTeam?: FirstTeamAnswer;
  goalscorer?: GoalscorerAnswer;
  goalMinute?: GoalMinuteAnswer;
  acceptedOffer: { maxLevel: number; digest: string };
  createdAt: string;
  updatedAt: string;
}

export function progressivePredictionView(record: PredictionRecord): ProgressivePredictionView {
  const view: ProgressivePredictionView = {
    predictionId: record.predictionId,
    matchId: record.matchId,
    venueActivationId: record.venueActivationId,
    predictionContract: "PROGRESSIVE_LADDER_V1",
    attemptedLevel: record.attemptedLevel as number,
    scoreline: { home: record.predictedHomeScore, away: record.predictedAwayScore },
    acceptedOffer: {
      maxLevel: record.acceptedOfferMaxLevel as number,
      digest: record.acceptedOfferDigest as string,
    },
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
  if (record.firstTeamState === "NONE") view.firstTeam = { kind: "NONE" };
  else if (record.firstTeamState === "PICKED" && record.predictedFirstTeamToScore !== null) {
    view.firstTeam = { kind: "PICKED", team: record.predictedFirstTeamToScore };
  }
  if (record.goalscorerState === "NONE") view.goalscorer = { kind: "NONE" };
  else if (record.goalscorerState === "PICKED" && record.predictedGoalscorerPlayerId !== null) {
    view.goalscorer = { kind: "PICKED", playerId: record.predictedGoalscorerPlayerId };
  }
  if (record.goalMinuteState === "NONE") view.goalMinute = { kind: "NONE" };
  else if (record.goalMinuteState === "PICKED" && record.predictedGoalMinuteRegulation !== null) {
    view.goalMinute = {
      kind: "PICKED",
      regulation: record.predictedGoalMinuteRegulation,
      stoppage: record.predictedGoalMinuteStoppage,
    };
  }
  return view;
}
