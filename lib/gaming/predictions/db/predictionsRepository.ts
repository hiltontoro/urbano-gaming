import type {
  TeamRecord,
  PlayerRecord,
  MatchRecord,
  VenueRecord,
  VenueActivationRecord,
  PrizeTierRecord,
  PredictionRecord,
  MatchResultRecord,
  OfficialGoalEventRecord,
  OfficialGoalEventInput,
  EvaluationRecord,
  GamingProgressionEventRecord,
  PrizeQualificationRecord,
  LeaderboardEntry,
} from "../types";

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
  }): Promise<MatchRecord>;
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
    activityClassification: "TRAINING" | "CASUAL" | "RANKED" | "OFFICIAL"
  ): Promise<{ matchId: string; activityClassification: string; locked: boolean }>;
  setMatchXpEligibility(
    matchId: string,
    xpEligible: boolean
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
  getPredictionForMember(
    matchId: string,
    gamingMemberId: string
  ): Promise<PredictionRecord | null>;
  listPredictionsForMatch(matchId: string): Promise<PredictionRecord[]>;

  // Match Results (draft entry is plain CRUD; finalize/correct below are RPCs)
  saveDraftMatchResult(input: {
    matchId: string;
    homeScore: number;
    awayScore: number;
    officialGoalEvents: OfficialGoalEventInput[];
    enteredByGamingMemberId: string;
    supersedesMatchResultId?: string | null;
  }): Promise<MatchResultRecord>;
  getMatchResultById(matchResultId: string): Promise<MatchResultRecord | null>;
  getDraftMatchResult(matchId: string): Promise<MatchResultRecord | null>;
  /** The latest finalized, non-superseded Result Version for a Match. */
  getCurrentFinalizedMatchResult(
    matchId: string
  ): Promise<MatchResultRecord | null>;
  listGoalEventsForResult(
    matchResultId: string
  ): Promise<OfficialGoalEventRecord[]>;

  /** reason is optional for first finalization — pass null when the caller supplies none. */
  finalizeMatchResult(
    matchResultId: string,
    finalizedByGamingMemberId: string,
    reason: string | null
  ): Promise<{ matchResultId: string; finalizedAt: string; alreadyFinalized: boolean }>;
  /** reason is mandatory for correction — enforced both here and at the RPC layer. */
  correctMatchResult(
    matchResultId: string,
    finalizedByGamingMemberId: string,
    reason: string
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
  redeemPrizeQualification(
    prizeQualificationId: string,
    redeemedByGamingMemberId: string
  ): Promise<{ prizeQualificationId: string; redeemedAt: string; alreadyRedeemed: boolean }>;
}
