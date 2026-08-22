/**
 * Soccer Predictions — a native, persistent URBANO Gaming Experience,
 * built on Gaming Member identity (lib/gaming). Deliberately separate
 * from lib/session: Prediction has no Session, Segment, or Interaction
 * Instance — it is not Session gameplay, and nothing here is imported
 * by lib/session or vice versa.
 *
 * Corrected model (Founder UX pass): four independent Prediction
 * dimensions — Exact Scoreline, Any Goalscorer, Any Goal Minute, First
 * Team to Score — superseding the original full scorer/minute
 * reconstruction design. See SOCCER_PREDICTIONS_IMPLEMENTATION_RECORD.md
 * for the full history of that correction.
 */

export interface TeamRecord {
  teamId: string;
  name: string;
  createdAt: string;
}

/**
 * Selectable roster entry. active gates future selectability only —
 * there is no delete path anywhere in this domain, so a player_id
 * referenced by a historical Prediction or official goal event can
 * never dangle even after the player is deactivated.
 */
export interface PlayerRecord {
  playerId: string;
  teamId: string;
  name: string;
  active: boolean;
  createdAt: string;
}

export interface MatchRecord {
  matchId: string;
  homeTeamId: string;
  awayTeamId: string;
  competition: string;
  kickoffAt: string;
  cancelledAt: string | null;
  activityClassification: "TRAINING" | "CASUAL" | "RANKED" | "OFFICIAL" | null;
  /**
   * PLAYABLE MATCH != XP-ELIGIBLE MATCH. Independent of, and never
   * derivable from, activityClassification — a Match may be fully
   * playable (classified, activated, accepting Predictions) with this
   * left null indefinitely; Prediction submission has no dependency on
   * it. null = no eligibility decision made yet; true = declared
   * eligible for persistent Gaming XP; false = explicitly declared not
   * eligible. Locked (immutable) the instant Prediction or Result
   * evidence exists for this Match — see
   * set_match_xp_eligibility_atomically (0102).
   */
  xpEligible: boolean | null;
  createdAt: string;
}

export interface VenueRecord {
  venueId: string;
  name: string;
  latitude: number;
  longitude: number;
  radiusMeters: number;
  active: boolean;
  createdAt: string;
}

export interface VenueActivationRecord {
  venueActivationId: string;
  matchId: string;
  venueId: string;
  enabled: boolean;
  createdAt: string;
}

export interface PrizeTierRecord {
  prizeTierId: string;
  venueActivationId: string;
  correctDimensionCount: number;
  prizeLabel: string;
  createdAt: string;
}

/**
 * predictedGoalscorerPlayerId / predictedGoalMinuteRegulation /
 * predictedFirstTeamToScore are each independently nullable — every
 * Prediction answers all four dimensions atomically at submission time
 * (never progressively), so null is never ambiguous with "unanswered":
 * it always means the member deliberately selected "No Goal" for that
 * dimension. There is no goal-count invariant tying these to
 * predictedHomeScore/predictedAwayScore — a 4-3 predicted scoreline
 * still carries exactly one goalscorer pick, one minute pick, and one
 * first-team pick.
 *
 * predictedGoalMinuteRegulation / predictedGoalMinuteStoppage —
 * Predictions-v2. The same (regulation, stoppage) structural primitive
 * official_goal_events already uses, never a flattened elapsed-minute
 * integer: 0056's own original design summed regulation+stoppage for
 * comparison, which silently collided first-half stoppage with an
 * unrelated ordinary minute (45+10 and ordinary 55 both summed to 55).
 * "No Goal" is both fields null together; stoppage is only ever
 * non-null alongside a regulation minute of 45 or 90 (stoppage time is
 * only added at the end of a half) — enforced by
 * upsert_prediction_atomically and the predictions table's own CHECK
 * constraints (0094), not merely a TypeScript convention.
 */
export interface PredictionRecord {
  predictionId: string;
  matchId: string;
  gamingMemberId: string;
  venueActivationId: string;
  predictedHomeScore: number;
  predictedAwayScore: number;
  predictedGoalscorerPlayerId: string | null;
  predictedGoalMinuteRegulation: number | null;
  predictedGoalMinuteStoppage: number | null;
  predictedFirstTeamToScore: "HOME" | "AWAY" | null;
  geoVerifiedAt: string;
  measuredDistanceMeters: number;
  reportedAccuracyMeters: number | null;
  geoEligible: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MatchResultRecord {
  matchResultId: string;
  matchId: string;
  homeScore: number;
  awayScore: number;
  finalizedAt: string | null;
  supersedesMatchResultId: string | null;
  enteredByGamingMemberId: string;
  /**
   * The Consequential Finalizer who ran finalize/correct — null for
   * every Result finalized before Admin Control Plane A0 (never
   * backfilled) and for a still-open draft. See
   * Product/Authority_and_Audit_Foundation.md, "Result Finalization
   * Accountability."
   */
  finalizedByGamingMemberId: string | null;
  createdAt: string;
}

/**
 * The official record still needs a real structured goal event per
 * goal: scorerPlayerId references the same Players roster Predictions
 * select from — admin result entry never uses free text either. No
 * stored credited-Team column: for First Team to Score, the credited
 * Team is derived at settlement time from isOwnGoal + the scorer's own
 * Team + the Match's home/away Team ids (an own goal credits the
 * *opposing* Team on the scoreline) — "avoid redundant state if
 * derivable," the same principle already applied to Match's own lack
 * of a status column.
 */
export interface OfficialGoalEventRecord {
  officialGoalEventId: string;
  matchResultId: string;
  scorerPlayerId: string;
  minuteRegulation: number;
  minuteStoppage: number | null;
  isOwnGoal: boolean;
  ordinal: number;
}

/** One official goal, as supplied to draft result entry. */
export interface OfficialGoalEventInput {
  scorerPlayerId: string;
  minuteRegulation: number;
  minuteStoppage?: number | null;
  isOwnGoal?: boolean;
}

export interface EvaluationRecord {
  evaluationId: string;
  predictionId: string;
  matchResultId: string;
  scorelineCorrect: boolean;
  goalscorerCorrect: boolean;
  goalMinuteCorrect: boolean;
  firstTeamToScoreCorrect: boolean;
  correctDimensionCount: number;
  evaluatedAt: string;
}

export interface GamingProgressionEventRecord {
  gamingProgressionEventId: string;
  gamingMemberId: string;
  ruleKey: string;
  points: number;
  matchId: string | null;
  evaluationId: string | null;
  reversesGamingProgressionEventId: string | null;
  idempotencyKey: string;
  createdAt: string;
}

export interface PrizeQualificationRecord {
  prizeQualificationId: string;
  evaluationId: string;
  gamingMemberId: string;
  venueActivationId: string;
  prizeTierId: string;
  redeemedAt: string | null;
  redeemedByGamingMemberId: string | null;
  supersededAt: string | null;
  createdAt: string;
}

export interface LeaderboardEntry {
  gamingMemberId: string;
  displayName: string;
  totalPoints: number;
}

/** Geolocation evidence a client reports at Prediction submission time. */
export interface GeoSubmission {
  latitude: number;
  longitude: number;
  accuracyMeters: number | null;
}

// --- Errors -----------------------------------------------------------

export class MatchNotFoundError extends Error {
  constructor() {
    super("No match exists for this id.");
    this.name = "MatchNotFoundError";
  }
}

export class MatchCancelledError extends Error {
  constructor() {
    super("This match has been cancelled.");
    this.name = "MatchCancelledError";
  }
}

export class KickoffPassedError extends Error {
  constructor() {
    super("Predictions are locked for this match.");
    this.name = "KickoffPassedError";
  }
}

export class MatchNotClassifiedError extends Error {
  constructor() {
    super("This match has no declared Activity Classification and cannot accept predictions yet.");
    this.name = "MatchNotClassifiedError";
  }
}

export class ActivityClassificationLockedError extends Error {
  constructor() {
    super("This match already has Prediction or Result evidence and its Activity Classification cannot change.");
    this.name = "ActivityClassificationLockedError";
  }
}

export class XpEligibilityLockedError extends Error {
  constructor() {
    super("This match already has Prediction or Result evidence and its XP eligibility cannot change.");
    this.name = "XpEligibilityLockedError";
  }
}

export class VenueActivationNotFoundError extends Error {
  constructor() {
    super("No venue activation exists for this id.");
    this.name = "VenueActivationNotFoundError";
  }
}

export class VenueActivationMatchMismatchError extends Error {
  constructor() {
    super("This venue activation is not for the supplied match.");
    this.name = "VenueActivationMatchMismatchError";
  }
}

export class VenueActivationDisabledError extends Error {
  constructor() {
    super("This venue activation is not currently enabled.");
    this.name = "VenueActivationDisabledError";
  }
}

export class VenueActivationImmutableError extends Error {
  constructor() {
    super(
      "This prediction was first submitted through a different venue activation."
    );
    this.name = "VenueActivationImmutableError";
  }
}

export class GeoNotEligibleError extends Error {
  constructor() {
    super("Submission failed geolocation eligibility.");
    this.name = "GeoNotEligibleError";
  }
}

export class GeoUnavailableError extends Error {
  constructor() {
    super("Location could not be determined for this submission.");
    this.name = "GeoUnavailableError";
  }
}

export class InvalidPredictionScoreError extends Error {
  constructor() {
    super("Predicted scores must be non-negative.");
    this.name = "InvalidPredictionScoreError";
  }
}

export class InvalidGoalMinuteError extends Error {
  constructor() {
    super(
      "Predicted goal minute must be a regulation minute between 1 and 90, with a positive stoppage offset allowed only when the regulation minute is 45 or 90."
    );
    this.name = "InvalidGoalMinuteError";
  }
}

export class InvalidOfficialGoalMinuteError extends Error {
  constructor() {
    super(
      "An official goal event's stoppage offset is only valid when the regulation minute is a period boundary (45, 90, 105, or 120)."
    );
    this.name = "InvalidOfficialGoalMinuteError";
  }
}

export class InvalidFirstTeamError extends Error {
  constructor() {
    super("Predicted first team to score must be HOME, AWAY, or null.");
    this.name = "InvalidFirstTeamError";
  }
}

export class InvalidGoalscorerSelectionError extends Error {
  constructor() {
    super(
      "The selected goalscorer must be an active player on one of this match's two teams."
    );
    this.name = "InvalidGoalscorerSelectionError";
  }
}

export class MatchResultNotFoundError extends Error {
  constructor() {
    super("No draft result exists for this id.");
    this.name = "MatchResultNotFoundError";
  }
}

export class NotACorrectionError extends Error {
  constructor() {
    super("This result does not supersede a prior finalized result.");
    this.name = "NotACorrectionError";
  }
}

export class SupersededResultNotFinalizedError extends Error {
  constructor() {
    super("The result being corrected is not itself finalized.");
    this.name = "SupersededResultNotFinalizedError";
  }
}

export class PrizeQualificationNotFoundError extends Error {
  constructor() {
    super("No qualification exists for this id.");
    this.name = "PrizeQualificationNotFoundError";
  }
}

export class QualificationSupersededError extends Error {
  constructor() {
    super("This qualification is no longer supported by the current result.");
    this.name = "QualificationSupersededError";
  }
}

export class InvalidPrizeTierDimensionCountError extends Error {
  constructor() {
    super("Prize tier dimension count must be between 1 and 4.");
    this.name = "InvalidPrizeTierDimensionCountError";
  }
}

export class DraftResultAlreadyExistsError extends Error {
  constructor() {
    super("An un-finalized draft result already exists for this match.");
    this.name = "DraftResultAlreadyExistsError";
  }
}

export class NoFinalizedResultToCorrectError extends Error {
  constructor() {
    super("This match has no finalized result to correct yet.");
    this.name = "NoFinalizedResultToCorrectError";
  }
}

export class ResultAlreadyBeingCorrectedError extends Error {
  constructor() {
    super("The current finalized result already has a correction in progress.");
    this.name = "ResultAlreadyBeingCorrectedError";
  }
}
