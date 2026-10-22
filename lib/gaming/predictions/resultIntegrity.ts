import { createHash } from "crypto";

import type { OfficialGoalEventInput } from "./types";
import {
  InvalidMatchResultEventsError,
  InvalidMatchResultScoreError,
  InvalidOfficialGoalMinuteError,
  MatchResultEventMinuteInvalidError,
  MatchResultEventsContradictScoreError,
  MatchResultScorerNotInMatchError,
} from "./types";

/**
 * Result integrity rules, shared by the in-memory repository and the
 * request-layer validation. The Postgres functions in migration
 * 20261020150100 enforce the same rules authoritatively; the contract
 * suite checks that the digest below equals the database's digest for
 * the same content.
 *
 * REGULATION TIME. A match score is the score after 90 minutes plus
 * first- and second-half stoppage. A goal event is in scope when its
 * regulation minute is 1-90 (stoppage at 45 and 90 included). Events at
 * minute 91-120 (extra time) may be kept as evidence but are excluded
 * from the score check and from all four prediction dimensions.
 */
export const REGULATION_LAST_MINUTE = 90;

/**
 * The save base is an optimistic-concurrency token over the WHOLE result
 * state of a match, as the editor last loaded it:
 *   - the digest of the draft, when a draft exists;
 *   - otherwise FINAL:<digest of the current finalized result> (the
 *     editor is starting a correction of that result);
 *   - otherwise NONE (no result at all: a first result).
 * The database compares it against the state it finds under the match
 * lock, so a save can never silently become a second first-result or a
 * correction the editor did not know about.
 */
export const NO_RESULT_SAVE_BASE = "NONE";

export function saveBaseToken(state: {
  draftDigest: string | null;
  finalizedDigest: string | null;
}): string {
  if (state.draftDigest) return state.draftDigest;
  if (state.finalizedDigest) return `FINAL:${state.finalizedDigest}`;
  return NO_RESULT_SAVE_BASE;
}

const STOPPAGE_BOUNDARY_MINUTES = [45, 90, 105, 120];

export interface DigestEvent {
  ordinal: number;
  scorerPlayerId: string;
  minuteRegulation: number;
  minuteStoppage: number | null;
  isOwnGoal: boolean;
}

export interface DigestInput {
  matchResultId: string;
  matchId: string;
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number;
  awayScore: number;
  supersedesMatchResultId: string | null;
  events: DigestEvent[];
}

/**
 * Deterministic sha256 of exactly the content a Consequential Finalizer
 * reviews: the result and match identity, both teams, the score, what it
 * supersedes, and the ordered goal events. It is identical to
 * match_result_content_digest() in the database. Possession of a digest
 * is evidence of WHICH content was reviewed, never authorization.
 */
export function computeMatchResultContentDigest(input: DigestInput): string {
  const events = [...input.events]
    .sort((a, b) => a.ordinal - b.ordinal)
    .map(
      (e) =>
        `${e.ordinal}:${e.scorerPlayerId}:${e.minuteRegulation}:${e.minuteStoppage ?? ""}:${e.isOwnGoal ? "1" : "0"}`
    )
    .join(";");
  const canonical = [
    "v1",
    input.matchResultId,
    input.matchId,
    input.homeTeamId,
    input.awayTeamId,
    String(input.homeScore),
    String(input.awayScore),
    input.supersedesMatchResultId ?? "",
    events,
  ].join("|");
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export function validateResultScores(homeScore: unknown, awayScore: unknown): void {
  for (const score of [homeScore, awayScore]) {
    if (typeof score !== "number" || !Number.isInteger(score) || score < 0) {
      throw new InvalidMatchResultScoreError();
    }
  }
}

/**
 * Shape and minute rules for goal events as submitted. Mirrors the
 * checks save_draft_match_result_atomically makes before it writes, so
 * a malformed event is rejected here with a typed error and in the
 * database with the same one.
 */
export function validateGoalEventInputs(events: OfficialGoalEventInput[]): void {
  if (!Array.isArray(events)) {
    throw new InvalidMatchResultEventsError("Official goal events must be a list.");
  }
  events.forEach((event, index) => {
    const label = `Goal event ${index + 1}`;
    if (!event || typeof event !== "object") {
      throw new InvalidMatchResultEventsError(`${label} is malformed.`);
    }
    if (typeof event.scorerPlayerId !== "string" || event.scorerPlayerId.trim().length === 0) {
      throw new InvalidMatchResultEventsError(`${label} needs a scorer.`);
    }
    if (event.isOwnGoal != null && typeof event.isOwnGoal !== "boolean") {
      throw new InvalidMatchResultEventsError(`${label} has an invalid own-goal flag.`);
    }
    const minute = event.minuteRegulation;
    if (typeof minute !== "number" || !Number.isInteger(minute) || minute < 1 || minute > 120) {
      throw new MatchResultEventMinuteInvalidError(
        `${label} needs a whole minute from 1 to 120.`
      );
    }
    const stoppage = event.minuteStoppage;
    if (stoppage != null) {
      if (typeof stoppage !== "number" || !Number.isInteger(stoppage) || stoppage < 1) {
        throw new MatchResultEventMinuteInvalidError(
          `${label} has an invalid stoppage offset.`
        );
      }
      if (!STOPPAGE_BOUNDARY_MINUTES.includes(minute)) {
        throw new InvalidOfficialGoalMinuteError();
      }
    }
  });
}

export interface IntegrityInput {
  homeTeamId: string;
  awayTeamId: string;
  homeScore: number;
  awayScore: number;
  events: Array<{ scorerPlayerId: string; minuteRegulation: number; isOwnGoal: boolean }>;
  /** The team a player belongs to, or null when the player is unknown. */
  teamOfPlayer: (playerId: string) => string | null;
}

/**
 * Every scorer belongs to one of the match's two teams, and the
 * regulation-time goals credited per team (an own goal credits the
 * opponent of the scorer's team) equal the score.
 */
export function assertMatchResultIntegrity(input: IntegrityInput): void {
  for (const event of input.events) {
    const team = input.teamOfPlayer(event.scorerPlayerId);
    if (team === null || (team !== input.homeTeamId && team !== input.awayTeamId)) {
      throw new MatchResultScorerNotInMatchError();
    }
  }

  let creditedHome = 0;
  let creditedAway = 0;
  for (const event of input.events) {
    if (event.minuteRegulation > REGULATION_LAST_MINUTE) continue;
    const scorerOnHome = input.teamOfPlayer(event.scorerPlayerId) === input.homeTeamId;
    if (scorerOnHome !== event.isOwnGoal) creditedHome += 1;
    else creditedAway += 1;
  }

  if (creditedHome !== input.homeScore || creditedAway !== input.awayScore) {
    throw new MatchResultEventsContradictScoreError(
      `Regulation-time goal events credit ${creditedHome} home and ${creditedAway} away, but the score is ${input.homeScore}-${input.awayScore}.`
    );
  }
}

/** Chronological order of goal events: minute, then stoppage, then entry order. */
export function compareGoalEventsChronologically(
  a: { minuteRegulation: number; minuteStoppage: number | null; ordinal: number },
  b: { minuteRegulation: number; minuteStoppage: number | null; ordinal: number }
): number {
  if (a.minuteRegulation !== b.minuteRegulation) return a.minuteRegulation - b.minuteRegulation;
  const aStoppage = a.minuteStoppage ?? 0;
  const bStoppage = b.minuteStoppage ?? 0;
  if (aStoppage !== bStoppage) return aStoppage - bStoppage;
  return a.ordinal - b.ordinal;
}
