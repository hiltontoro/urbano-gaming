import type {
  TeamRecord,
  PlayerRecord,
  MatchRecord,
  VenueRecord,
  VenueActivationRecord,
  PrizeTierRecord,
  PredictionRecord,
  MatchResultRecord,
  SavedMatchResult,
  OfficialGoalEventRecord,
  OfficialGoalEventInput,
  EvaluationRecord,
  GamingProgressionEventRecord,
  PrizeQualificationRecord,
  PrizeQualificationDetailRecord,
  LeaderboardEntry,
  PredictionContract,
} from "../types";
import type { ProgressiveAnswers } from "../prizeLadder";

/**
 * Soccer Predictions persistence boundary — its own interface, parallel
 * to lib/session/db/sessionRepository.ts, never merged with it.
 */
export interface PredictionsRepository {
  // Teams + Players (roster model — smallest v1 capability, no league
  // management, no sports-data-provider integration; a future provider
  // seam maps into these same stable internal ids, never becomes them)
  createTeam(input: { name: string }): Promise<TeamRecord>;
  getTeamById(teamId: string): Promise<TeamRecord | null>;
  listTeams(): Promise<TeamRecord[]>;

  createPlayer(input: { teamId: string; name: string }): Promise<PlayerRecord>;
  editPlayer(playerId: string, input: { name: string }): Promise<PlayerRecord>;
  setPlayerActive(playerId: string, active: boolean): Promise<PlayerRecord>;
  getPlayerById(playerId: string): Promise<PlayerRecord | null>;
  listPlayersForTeam(teamId: string): Promise<PlayerRecord[]>;

  // Matches
  createMatch(input: {
    homeTeamId: string;
    awayTeamId: string;
    competition: string;
    kickoffAt: string;
    /** Defaults to COMPLETE_COUNT_V1 — the historical contract. */
    predictionContract?: PredictionContract;
  }): Promise<MatchRecord>;
  /**
   * Changes a Match's prediction contract. Refused (ContractFrozenError)
   * once the Match has any prediction or any result: the contract is
   * frozen from the first of either.
   */
  setMatchPredictionContract(matchId: string, predictionContract: PredictionContract): Promise<MatchRecord>;
  editMatch(
    matchId: string,
    input: {
      homeTeamId: string;
      awayTeamId: string;
      competition: string;
      kickoffAt: string;
    }
  ): Promise<MatchRecord>;
  cancelMatch(matchId: string): Promise<MatchRecord>;
  getMatchById(matchId: string): Promise<MatchRecord | null>;
  listMatches(): Promise<MatchRecord[]>;
  setMatchActivityClassification(
    matchId: string,
    activityClassification: "TRAINING" | "CASUAL" | "RANKED" | "OFFICIAL",
    actorGamingMemberId: string,
    reason: string | null
  ): Promise<{ matchId: string; activityClassification: string; locked: boolean }>;
  setMatchXpEligibility(
    matchId: string,
    xpEligible: boolean,
    actorGamingMemberId: string,
    reason: string | null
  ): Promise<{ matchId: string; xpEligible: boolean; locked: boolean }>;

  // Venues
  createVenue(input: {
    name: string;
    latitude: number;
    longitude: number;
    radiusMeters: number;
  }): Promise<VenueRecord>;
  editVenue(
    venueId: string,
    input: {
      name: string;
      latitude: number;
      longitude: number;
      radiusMeters: number;
      active: boolean;
    }
  ): Promise<VenueRecord>;
  getVenueById(venueId: string): Promise<VenueRecord | null>;
  listVenues(): Promise<VenueRecord[]>;

  // Venue Activations + Prize Tiers
  createVenueActivation(input: {
    matchId: string;
    venueId: string;
  }): Promise<VenueActivationRecord>;
  setVenueActivationEnabled(
    venueActivationId: string,
    enabled: boolean
  ): Promise<VenueActivationRecord>;
  getVenueActivationById(
    venueActivationId: string
  ): Promise<VenueActivationRecord | null>;
  listVenueActivationsForMatch(matchId: string): Promise<VenueActivationRecord[]>;

  createPrizeTier(input: {
    venueActivationId: string;
    correctDimensionCount: number;
    prizeLabel: string;
  }): Promise<PrizeTierRecord>;
  /**
   * Adds a ladder tier (level 1 to 4) to an activation of a
   * PROGRESSIVE_LADDER_V1 Match. Refused (OfferFrozenError) once any
   * prediction exists for the activation: from the first prediction the
   * offered levels, their labels and the highest level offered cannot change.
   */
  createLadderPrizeTier(input: {
    venueActivationId: string;
    ladderLevel: number;
    prizeLabel: string;
  }): Promise<PrizeTierRecord>;
  listPrizeTiersForActivation(
    venueActivationId: string
  ): Promise<PrizeTierRecord[]>;

  // Predictions
  upsertPrediction(input: {
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
  }): Promise<PredictionRecord>;
  /**
   * The single write path for a prediction under PROGRESSIVE_LADDER_V1,
   * first submission and every revision before kickoff. The whole row is
   * replaced each time: a lower attempted level clears every higher
   * category. offerDigest is the fingerprint of the prize offer the
   * member saw; a different current offer is refused (OfferChangedError).
   */
  upsertProgressivePrediction(input: {
    matchId: string;
    gamingMemberId: string;
    venueActivationId: string;
    answers: ProgressiveAnswers;
    offerDigest: string | null;
    geoVerifiedAt: string;
    measuredDistanceMeters: number;
    reportedAccuracyMeters: number | null;
    geoEligible: boolean;
  }): Promise<PredictionRecord>;
  getPredictionForMember(
    matchId: string,
    gamingMemberId: string
  ): Promise<PredictionRecord | null>;
  listPredictionsForMatch(matchId: string): Promise<PredictionRecord[]>;

  // Match Results. Draft save, finalize and correct are all atomic RPCs
  // serialized per match: the save decides initial draft versus
  // correction under the same lock that finalize/correct take.
  /**
   * Saves the Match's one un-finalized draft in a single transaction.
   * saveBase is the digest of the draft the caller loaded (or
   * NO_RESULT_SAVE_BASE when it loaded none); a save over a draft that
   * changed since is rejected, as is any score/event inconsistency, with
   * the prior draft left untouched. Whether the draft is a first result
   * or a correction of the current finalized one is decided inside the
   * transaction, never by the caller.
   */
  saveDraftMatchResult(input: {
    matchId: string;
    homeScore: number;
    awayScore: number;
    officialGoalEvents: OfficialGoalEventInput[];
    enteredByGamingMemberId: string;
    saveBase: string;
  }): Promise<SavedMatchResult>;
  getMatchResultById(matchResultId: string): Promise<MatchResultRecord | null>;
  /** The digest of the result's exact content (null when the result does not exist). */
  getMatchResultContentDigest(matchResultId: string): Promise<string | null>;
  getDraftMatchResult(matchId: string): Promise<MatchResultRecord | null>;
  /** The latest finalized, non-superseded Result Version for a Match. */
  getCurrentFinalizedMatchResult(
    matchId: string
  ): Promise<MatchResultRecord | null>;
  listGoalEventsForResult(
    matchResultId: string
  ): Promise<OfficialGoalEventRecord[]>;

  /**
   * reason is optional for first finalization — pass null when the
   * caller supplies none. expectedDigest is the digest of the content the
   * caller reviewed; a missing or stale one is rejected. An
   * already-finalized result replays idempotently only for that content.
   */
  finalizeMatchResult(
    matchResultId: string,
    finalizedByGamingMemberId: string,
    reason: string | null,
    expectedDigest: string
  ): Promise<{ matchResultId: string; finalizedAt: string; alreadyFinalized: boolean }>;
  /** reason is mandatory for correction — enforced both here and at the RPC layer. */
  correctMatchResult(
    matchResultId: string,
    finalizedByGamingMemberId: string,
    reason: string,
    expectedDigest: string
  ): Promise<{
    matchResultId: string;
    finalizedAt: string;
    supersedesMatchResultId: string;
    alreadyFinalized: boolean;
  }>;

  // Evaluations
  getEvaluation(
    predictionId: string,
    matchResultId: string
  ): Promise<EvaluationRecord | null>;
  /** The evaluation belonging to the match's currently-authoritative Result Version, if any. */
  getCurrentEvaluationForPrediction(
    predictionId: string
  ): Promise<EvaluationRecord | null>;

  // Gaming Progression
  listProgressionEventsForMember(
    gamingMemberId: string
  ): Promise<GamingProgressionEventRecord[]>;
  getLeaderboard(): Promise<LeaderboardEntry[]>;

  // Prize Qualifications
  getQualificationForEvaluation(
    evaluationId: string
  ): Promise<PrizeQualificationRecord | null>;
  listQualificationsForMember(
    gamingMemberId: string
  ): Promise<PrizeQualificationRecord[]>;
  listQualificationsForActivation(
    venueActivationId: string
  ): Promise<PrizeQualificationRecord[]>;
  /**
   * listQualificationsForActivation plus the winner's display name and
   * the prize label, resolved in a bounded number of queries. Admin
   * surface only — display names must stay behind admin authority.
   */
  listQualificationDetailsForActivation(
    venueActivationId: string
  ): Promise<PrizeQualificationDetailRecord[]>;
  /**
   * Redeems an entitlement. Rejects a superseded, held or already
   * fulfilled one; a replay of an already-redeemed one is idempotent.
   */
  redeemPrizeQualification(
    prizeQualificationId: string,
    redeemedByGamingMemberId: string,
    reason: string | null
  ): Promise<{ prizeQualificationId: string; redeemedAt: string; alreadyRedeemed: boolean }>;
  /**
   * Releases the hold on a replacement entitlement whose prize changed
   * after the original was delivered. Requires CONSEQUENTIAL_FINALIZER
   * authority and a reason; releasing does not deliver anything — the
   * entitlement is then redeemable through the ordinary redemption.
   */
  releasePrizeQualificationHold(
    prizeQualificationId: string,
    releasedByGamingMemberId: string,
    reason: string
  ): Promise<{ prizeQualificationId: string; releasedAt: string; alreadyReleased: boolean }>;
}
