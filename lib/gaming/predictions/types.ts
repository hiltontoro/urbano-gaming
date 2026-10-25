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

/**
 * How a Match's predictions are shaped, evaluated and rewarded. Versioned
 * per Match and frozen from the Match's first prediction or result.
 *   - COMPLETE_COUNT_V1: the historical contract. Every dimension is
 *     answered; null means "No Goal" for that dimension; the prize is the
 *     tier whose correct_dimension_count equals the number of correct
 *     dimensions. Nothing about it changes.
 *   - PROGRESSIVE_LADDER_V1: a consecutive prefix of categories (Easy
 *     scoreline, Medium first team, Hard any goalscorer, Legendary any
 *     goal minute) with an explicit state per category; the prize is the
 *     tier of the WON level (the consecutive correct prefix), and only
 *     levels the activation offers can be attempted.
 */
export type PredictionContract = "COMPLETE_COUNT_V1" | "PROGRESSIVE_LADDER_V1";

/**
 * State of one optional category in a progressive prediction. Distinct
 * on purpose: NOT_ATTEMPTED is a category the member did not reach (it is
 * never evaluated); NONE is the deliberate "no team / no player / no
 * minute" answer (correct exactly when there were no regulation goals);
 * PICKED is a concrete selection.
 */
export type CategoryState = "NOT_ATTEMPTED" | "NONE" | "PICKED";

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
  /**
   * The ROSTER fields, present only where a roster was loaded for the team (see rosters/). They describe the season's squad list, not the
   * player: the squad number can change between seasons, the player's identity is `playerId` and nothing else. Absent (or null) for a
   * player added by hand, and absent altogether while the database does not have the columns yet — every reader must tolerate that.
   * A roster is not a call-up: nothing here says a player is available for any match.
   */
  jerseyNumber?: number | null;
  position?: PlayerPosition | null;
  /** Where the roster entry was read and the date it was consulted: provenance, never shown to members. */
  rosterSource?: string | null;
  rosterConsultedOn?: string | null;
}

/** Normalised positions of a roster entry: goalkeeper, defender, midfielder, forward. */
export type PlayerPosition = "POR" | "DEF" | "MED" | "DEL";
export const PLAYER_POSITIONS: readonly PlayerPosition[] = ["POR", "DEF", "MED", "DEL"];

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
  /**
   * The Match's prediction contract. Defaults to COMPLETE_COUNT_V1 so
   * everything that existed keeps its meaning. Frozen from the first
   * prediction or result (the database enforces it).
   */
  predictionContract: PredictionContract;
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

/**
 * Exactly one of the two keys is set. correctDimensionCount keys a tier of
 * a COMPLETE_COUNT_V1 Match (the number of correct dimensions);
 * ladderLevel (1 to 4) keys a tier of a PROGRESSIVE_LADDER_V1 Match (the
 * level won). The two are never converted into each other: a historical
 * count tier is inert on a progressive Match.
 */
export interface PrizeTierRecord {
  prizeTierId: string;
  venueActivationId: string;
  correctDimensionCount: number | null;
  ladderLevel: number | null;
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
  /**
   * Contract of the Match this prediction was made under. For
   * COMPLETE_COUNT_V1 the three states and the accepted offer are null
   * and a null predicted_* above means "No Goal". For PROGRESSIVE_LADDER_V1
   * the states are explicit and a predicted_* is null whenever its state
   * is not PICKED — read the state, never the null.
   */
  predictionContract: PredictionContract;
  firstTeamState: CategoryState | null;
  goalscorerState: CategoryState | null;
  goalMinuteState: CategoryState | null;
  /** 1 + the optional categories attempted; null for COMPLETE_COUNT_V1. */
  attemptedLevel: number | null;
  /** Fingerprint of the prize offer the member accepted when sending; null for COMPLETE_COUNT_V1. */
  acceptedOfferDigest: string | null;
  /** Highest level the accepted offer allowed; null for COMPLETE_COUNT_V1. */
  acceptedOfferMaxLevel: number | null;
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

/**
 * A saved draft plus the digest of exactly the content that was saved
 * and whether the save started (or edited) a correction of an already
 * finalized result. The digest is what finalize/correct must be given:
 * it proves WHICH content was reviewed, never WHO may finalize it.
 */
export type SavedMatchResult = MatchResultRecord & {
  contentDigest: string;
  isCorrection: boolean;
};

/** One official goal, as supplied to draft result entry. */
export interface OfficialGoalEventInput {
  scorerPlayerId: string;
  minuteRegulation: number;
  minuteStoppage?: number | null;
  isOwnGoal?: boolean;
}

/**
 * One evaluation per prediction and result version. Under
 * PROGRESSIVE_LADDER_V1 an outcome is null for a category that was not
 * attempted (never true, never false); attemptedLevel and ladderLevel
 * (the won level, at most attemptedLevel) are set. Under
 * COMPLETE_COUNT_V1 all four outcomes are booleans and both levels are
 * null. correctDimensionCount is always the number of true outcomes.
 */
export interface EvaluationRecord {
  evaluationId: string;
  predictionId: string;
  matchResultId: string;
  predictionContract: PredictionContract;
  scorelineCorrect: boolean;
  goalscorerCorrect: boolean | null;
  goalMinuteCorrect: boolean | null;
  firstTeamToScoreCorrect: boolean | null;
  correctDimensionCount: number;
  attemptedLevel: number | null;
  ladderLevel: number | null;
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

/**
 * How the label stored with a delivery came to be known.
 *   - SNAPSHOT_AT_REDEMPTION — captured at the moment the prize was handed
 *     over. The only basis that can show a later entitlement is the same
 *     prize.
 *   - OBSERVED_AT_MIGRATION — a delivery recorded before delivery-time
 *     snapshots existed; the prize definition seen when the data was
 *     migrated is kept as legacyObservedPrizeLabel. It is a clue about what
 *     was probably handed over, never proof.
 *   - UNKNOWN — a legacy delivery with no readable prize definition.
 */
export type DeliveryEvidenceBasis = "SNAPSHOT_AT_REDEMPTION" | "OBSERVED_AT_MIGRATION" | "UNKNOWN";

/** Why an entitlement is held until a Consequential Finalizer releases it. */
export type PrizeHoldBasis =
  | "DELIVERED_PRIZE_CHANGED"
  | "DELIVERY_EQUIVALENCE_UNKNOWN"
  | "DELIVERY_ORDER_UNKNOWN"
  | "LEGACY_PENDING_TWIN";

/**
 * An entitlement to a prize, one per evaluation. Redemption evidence
 * (redeemedAt / redeemedByGamingMemberId / redeemedPrizeLabel and its
 * basis) is immutable once written. A correction never creates a second
 * physical delivery on its own:
 *   - fulfilledByPrizeQualificationId — the ORIGINAL redeemed row whose
 *     delivery already satisfies this entitlement. Only a delivery
 *     recorded AT redemption can satisfy one. A fulfilled row has no
 *     redemption event of its own and can never be redeemed.
 *   - heldAt / holdBasis / holdReason / holdPriorPrizeQualificationId — a
 *     replacement that cannot be delivered until a Consequential Finalizer
 *     releases it with a reason (releasedAt / releasedByGamingMemberId /
 *     releaseReason). The basis says why: the delivered prize changed, the
 *     delivery predates label snapshots so equivalence is unknown, or the
 *     order of deliveries could not be established.
 *
 * lineageOrdinal is the position of the entitlement's result in the
 * explicit supersession chain of results (0 for a first result). It — not
 * a timestamp, not an identifier — orders deliveries; null only for a
 * legacy row whose position cannot be established.
 */
export interface PrizeQualificationRecord {
  prizeQualificationId: string;
  evaluationId: string;
  gamingMemberId: string;
  venueActivationId: string;
  prizeTierId: string;
  redeemedAt: string | null;
  redeemedByGamingMemberId: string | null;
  /** The prize label as it stood at the moment of delivery (basis SNAPSHOT_AT_REDEMPTION only). */
  redeemedPrizeLabel: string | null;
  redeemedPrizeLabelBasis: DeliveryEvidenceBasis | null;
  /** Legacy deliveries only: the prize definition observed when the data was migrated. Not proof. */
  legacyObservedPrizeLabel: string | null;
  lineageOrdinal: number | null;
  supersededAt: string | null;
  replacesPrizeQualificationId: string | null;
  fulfilledByPrizeQualificationId: string | null;
  holdPriorPrizeQualificationId: string | null;
  heldAt: string | null;
  holdBasis: PrizeHoldBasis | null;
  holdReason: string | null;
  releasedAt: string | null;
  releasedByGamingMemberId: string | null;
  releaseReason: string | null;
  createdAt: string;
}

/**
 * A Prize Qualification plus the two human-readable facts an admin
 * needs to hand over a prize: who won and what they won. null only when
 * the referenced row is genuinely missing; superseded qualifications
 * keep their label, so a correction never blanks redemption history.
 */
export interface PrizeQualificationDetailRecord extends PrizeQualificationRecord {
  memberDisplayName: string | null;
  prizeLabel: string | null;
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

/** The approved participation window of this match has not opened yet (see participationWindow.ts). It says "not yet", never "no". */
export class ParticipationNotOpenError extends Error {
  readonly opensAt: Date;
  constructor(opensAt: Date) {
    super("Participation for this match has not opened yet.");
    this.name = "ParticipationNotOpenError";
    this.opensAt = opensAt;
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

export class MatchResultDigestRequiredError extends Error {
  constructor() {
    super("The digest of the reviewed result content is required.");
    this.name = "MatchResultDigestRequiredError";
  }
}

export class MatchResultDigestMismatchError extends Error {
  constructor() {
    super("The result changed since it was reviewed. Load it and review it again.");
    this.name = "MatchResultDigestMismatchError";
  }
}

export class MatchResultBaseRequiredError extends Error {
  constructor() {
    super("The save base from your last load of this result is required to save.");
    this.name = "MatchResultBaseRequiredError";
  }
}

export class MatchResultBaseStaleError extends Error {
  constructor() {
    super("The result changed since you loaded it (it was saved, finalized or corrected). Reload before saving.");
    this.name = "MatchResultBaseStaleError";
  }
}

export class InvalidMatchResultScoreError extends Error {
  constructor() {
    super("Scores must be non-negative whole numbers.");
    this.name = "InvalidMatchResultScoreError";
  }
}

export class InvalidMatchResultEventsError extends Error {
  constructor(detail?: string) {
    super(detail || "Official goal events are malformed.");
    this.name = "InvalidMatchResultEventsError";
  }
}

export class MatchResultEventMinuteInvalidError extends Error {
  constructor(detail?: string) {
    super(
      detail ||
        "A goal event minute must be a whole minute from 1 to 120, and a stoppage offset is only valid at minute 45, 90, 105 or 120."
    );
    this.name = "MatchResultEventMinuteInvalidError";
  }
}

export class MatchResultScorerNotInMatchError extends Error {
  constructor(detail?: string) {
    super(detail || "Every goal scorer must be a player on one of this match's two teams.");
    this.name = "MatchResultScorerNotInMatchError";
  }
}

export class MatchResultEventsContradictScoreError extends Error {
  constructor(detail?: string) {
    super(
      detail ||
        "The regulation-time goal events do not add up to the score. Own goals count for the opposing team; goals after minute 90 are not part of the score."
    );
    this.name = "MatchResultEventsContradictScoreError";
  }
}

export class MatchResultIsCorrectionError extends Error {
  constructor() {
    super("This result corrects a prior finalized result and must be finalized as a correction.");
    this.name = "MatchResultIsCorrectionError";
  }
}

export class MatchResultFinalizedImmutableError extends Error {
  constructor() {
    super("A finalized result and its goal evidence cannot be changed.");
    this.name = "MatchResultFinalizedImmutableError";
  }
}

export class PrizeQualificationHeldError extends Error {
  constructor() {
    super("This prize is on hold until a Consequential Finalizer releases it.");
    this.name = "PrizeQualificationHeldError";
  }
}

export class PrizeAlreadyFulfilledError extends Error {
  constructor() {
    super("An earlier delivery already satisfies this prize; it cannot be delivered again.");
    this.name = "PrizeAlreadyFulfilledError";
  }
}

export class PrizeQualificationNotHeldError extends Error {
  constructor() {
    super("This prize is not on hold.");
    this.name = "PrizeQualificationNotHeldError";
  }
}

// --- Progressive contract errors ----------------------------------------

export class ContractMismatchError extends Error {
  constructor(detail?: string) {
    super(detail || "This match uses a different prediction contract than the one in the request.");
    this.name = "ContractMismatchError";
  }
}

export class ContractFrozenError extends Error {
  constructor() {
    super("This match already has a prediction or a result, so its prediction contract can no longer change.");
    this.name = "ContractFrozenError";
  }
}

export class InvalidAttemptShapeError extends Error {
  constructor(detail?: string) {
    super(detail || "The prediction does not have a valid shape.");
    this.name = "InvalidAttemptShapeError";
  }
}

/**
 * The answers of a progressive prediction contradict each other: a first team or a goalscorer from a team with no goal in the
 * predicted scoreline, "none" next to goals, or a player/minute next to a 0-0. It is an InvalidAttemptShapeError (400) so every
 * existing handler already maps it; `code` tells the cases apart and the message is one of the fixed texts in prizeLadder.ts.
 */
export type IncoherenceCode =
  | "ONLY_NONE_WITH_NO_GOALS"
  | "NONE_NOT_ALLOWED_WITH_GOALS"
  | "FIRST_TEAM_WITHOUT_GOALS"
  | "SCORER_TEAM_WITHOUT_GOALS";

export class IncoherentAnswersError extends InvalidAttemptShapeError {
  readonly code: IncoherenceCode;
  constructor(code: IncoherenceCode, message: string) {
    super(message);
    this.name = "IncoherentAnswersError";
    this.code = code;
  }
}

export class LevelNotOfferedError extends Error {
  constructor() {
    super("That level is not offered at this venue.");
    this.name = "LevelNotOfferedError";
  }
}

export class OfferNotAvailableError extends Error {
  constructor() {
    super("This venue has no valid prize offer for this match, so it cannot take new predictions.");
    this.name = "OfferNotAvailableError";
  }
}

export class OfferChangedError extends Error {
  constructor() {
    super("The prizes offered at this venue changed since you loaded the page. Reload to see the current offer.");
    this.name = "OfferChangedError";
  }
}

export class OfferDigestRequiredError extends Error {
  constructor() {
    super("The fingerprint of the prize offer you saw is required to send a prediction.");
    this.name = "OfferDigestRequiredError";
  }
}

export class OfferFrozenError extends Error {
  constructor() {
    super("This venue's prizes can no longer change: participants have already accepted this offer.");
    this.name = "OfferFrozenError";
  }
}

export class ResultAlreadyFinalizedError extends Error {
  constructor() {
    super("This match already has a finalized result, so predictions can no longer be created or edited.");
    this.name = "ResultAlreadyFinalizedError";
  }
}

export class TierKeyContractMismatchError extends Error {
  constructor() {
    super("A prize tier of this match must use the key its prediction contract defines.");
    this.name = "TierKeyContractMismatchError";
  }
}

export class InvalidPrizeTierLadderLevelError extends Error {
  constructor() {
    super("Prize tier ladder level must be a whole number from 1 to 4.");
    this.name = "InvalidPrizeTierLadderLevelError";
  }
}
