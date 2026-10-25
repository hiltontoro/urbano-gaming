import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

import type { PredictionsRepository } from "./predictionsRepository";
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
import { progressiveColumnsOf } from "../prizeLadder";
import {
  MatchNotFoundError,
  MatchCancelledError,
  KickoffPassedError,
  MatchNotClassifiedError,
  ActivityClassificationLockedError,
  XpEligibilityLockedError,
  VenueActivationNotFoundError,
  VenueActivationMatchMismatchError,
  VenueActivationDisabledError,
  VenueActivationImmutableError,
  GeoNotEligibleError,
  InvalidPredictionScoreError,
  InvalidGoalMinuteError,
  InvalidFirstTeamError,
  InvalidGoalscorerSelectionError,
  MatchResultNotFoundError,
  NotACorrectionError,
  SupersededResultNotFinalizedError,
  PrizeQualificationNotFoundError,
  QualificationSupersededError,
  ResultAlreadyBeingCorrectedError,
  MatchResultBaseRequiredError,
  MatchResultBaseStaleError,
  MatchResultDigestRequiredError,
  MatchResultDigestMismatchError,
  InvalidMatchResultScoreError,
  InvalidMatchResultEventsError,
  MatchResultEventMinuteInvalidError,
  MatchResultScorerNotInMatchError,
  MatchResultEventsContradictScoreError,
  MatchResultIsCorrectionError,
  MatchResultFinalizedImmutableError,
  PrizeQualificationHeldError,
  PrizeAlreadyFulfilledError,
  PrizeQualificationNotHeldError,
  ContractMismatchError,
  ContractFrozenError,
  InvalidAttemptShapeError,
  LevelNotOfferedError,
  OfferNotAvailableError,
  OfferChangedError,
  OfferDigestRequiredError,
  OfferFrozenError,
  ResultAlreadyFinalizedError,
  TierKeyContractMismatchError,
} from "../types";
import { InsufficientPlatformAuthorityError, ReasonRequiredError } from "../../authority/types";
import { attachQualificationDetails, chunk } from "../qualificationDetails";
import { lineageOrdinalOf } from "../deliveryPolicy";

// PostgREST carries .in() ids in the request URL; chunking keeps a
// large activation from exceeding the gateway's URL length limit.
const IN_LOOKUP_CHUNK_SIZE = 100;

function mapTeam(row: any): TeamRecord {
  return {
    teamId: row.team_id,
    name: row.name,
    createdAt: row.created_at,
  };
}

function mapPlayer(row: any): PlayerRecord {
  return {
    playerId: row.player_id,
    teamId: row.team_id,
    name: row.name,
    active: row.active,
    createdAt: row.created_at,
    // Reads select "*", so a database that does not have the roster columns yet simply yields undefined here: never an error.
    jerseyNumber: typeof row.jersey_number === "number" ? row.jersey_number : null,
    position: typeof row.position === "string" ? row.position : null,
    rosterSource: typeof row.roster_source === "string" ? row.roster_source : null,
    rosterConsultedOn: typeof row.roster_consulted_on === "string" ? row.roster_consulted_on : null,
  };
}

function mapMatch(row: any): MatchRecord {
  return {
    matchId: row.match_id,
    homeTeamId: row.home_team_id,
    awayTeamId: row.away_team_id,
    competition: row.competition,
    kickoffAt: row.kickoff_at,
    cancelledAt: row.cancelled_at,
    activityClassification: row.activity_classification,
    xpEligible: row.xp_eligible,
    // A row that has no contract column at all (a database that has not been migrated yet) is historical by definition.
    predictionContract: row.prediction_contract ?? "COMPLETE_COUNT_V1",
    createdAt: row.created_at,
  };
}

function mapVenue(row: any): VenueRecord {
  return {
    venueId: row.venue_id,
    name: row.name,
    latitude: Number(row.latitude),
    longitude: Number(row.longitude),
    radiusMeters: Number(row.radius_meters),
    active: row.active,
    createdAt: row.created_at,
  };
}

function mapActivation(row: any): VenueActivationRecord {
  return {
    venueActivationId: row.venue_activation_id,
    matchId: row.match_id,
    venueId: row.venue_id,
    enabled: row.enabled,
    createdAt: row.created_at,
  };
}

function mapPrizeTier(row: any): PrizeTierRecord {
  return {
    prizeTierId: row.prize_tier_id,
    venueActivationId: row.venue_activation_id,
    correctDimensionCount: row.correct_dimension_count,
    ladderLevel: row.ladder_level ?? null,
    prizeLabel: row.prize_label,
    createdAt: row.created_at,
  };
}

function mapPrediction(row: any): PredictionRecord {
  return {
    predictionId: row.prediction_id,
    matchId: row.match_id,
    gamingMemberId: row.gaming_member_id,
    venueActivationId: row.venue_activation_id,
    predictedHomeScore: row.predicted_home_score,
    predictedAwayScore: row.predicted_away_score,
    predictedGoalscorerPlayerId: row.predicted_goalscorer_player_id,
    predictedGoalMinuteRegulation: row.predicted_goal_minute_regulation,
    predictedGoalMinuteStoppage: row.predicted_goal_minute_stoppage,
    predictedFirstTeamToScore: row.predicted_first_team_to_score,
    predictionContract: row.prediction_contract ?? "COMPLETE_COUNT_V1",
    firstTeamState: row.first_team_state ?? null,
    goalscorerState: row.goalscorer_state ?? null,
    goalMinuteState: row.goal_minute_state ?? null,
    attemptedLevel: row.attempted_level ?? null,
    acceptedOfferDigest: row.accepted_offer_digest ?? null,
    acceptedOfferMaxLevel: row.accepted_offer_max_level ?? null,
    geoVerifiedAt: row.geo_verified_at,
    measuredDistanceMeters: Number(row.measured_distance_meters),
    reportedAccuracyMeters:
      row.reported_accuracy_meters === null ? null : Number(row.reported_accuracy_meters),
    geoEligible: row.geo_eligible,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapMatchResult(row: any): MatchResultRecord {
  return {
    matchResultId: row.match_result_id,
    matchId: row.match_id,
    homeScore: row.home_score,
    awayScore: row.away_score,
    finalizedAt: row.finalized_at,
    supersedesMatchResultId: row.supersedes_match_result_id,
    enteredByGamingMemberId: row.entered_by_gaming_member_id,
    finalizedByGamingMemberId: row.finalized_by_gaming_member_id,
    createdAt: row.created_at,
  };
}

function mapGoalEvent(row: any): OfficialGoalEventRecord {
  return {
    officialGoalEventId: row.official_goal_event_id,
    matchResultId: row.match_result_id,
    scorerPlayerId: row.scorer_player_id,
    minuteRegulation: row.minute_regulation,
    minuteStoppage: row.minute_stoppage,
    isOwnGoal: row.is_own_goal,
    ordinal: row.ordinal,
  };
}

function mapEvaluation(row: any): EvaluationRecord {
  return {
    evaluationId: row.evaluation_id,
    predictionId: row.prediction_id,
    matchResultId: row.match_result_id,
    predictionContract: row.prediction_contract ?? "COMPLETE_COUNT_V1",
    scorelineCorrect: row.scoreline_correct,
    goalscorerCorrect: row.goalscorer_correct,
    goalMinuteCorrect: row.goal_minute_correct,
    firstTeamToScoreCorrect: row.first_team_to_score_correct,
    correctDimensionCount: row.correct_dimension_count,
    attemptedLevel: row.attempted_level ?? null,
    ladderLevel: row.ladder_level ?? null,
    evaluatedAt: row.evaluated_at,
  };
}

function mapProgressionEvent(row: any): GamingProgressionEventRecord {
  return {
    gamingProgressionEventId: row.gaming_progression_event_id,
    gamingMemberId: row.gaming_member_id,
    ruleKey: row.rule_key,
    points: row.points,
    matchId: row.match_id,
    evaluationId: row.evaluation_id,
    reversesGamingProgressionEventId: row.reverses_gaming_progression_event_id,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  };
}

function mapQualification(row: any): PrizeQualificationRecord {
  return {
    prizeQualificationId: row.prize_qualification_id,
    evaluationId: row.evaluation_id,
    gamingMemberId: row.gaming_member_id,
    venueActivationId: row.venue_activation_id,
    prizeTierId: row.prize_tier_id,
    redeemedAt: row.redeemed_at,
    redeemedByGamingMemberId: row.redeemed_by_gaming_member_id,
    redeemedPrizeLabel: row.redeemed_prize_label ?? null,
    redeemedPrizeLabelBasis: row.redeemed_prize_label_basis ?? null,
    legacyObservedPrizeLabel: row.legacy_observed_prize_label ?? null,
    lineageOrdinal: row.lineage_ordinal ?? null,
    supersededAt: row.superseded_at,
    replacesPrizeQualificationId: row.replaces_prize_qualification_id ?? null,
    fulfilledByPrizeQualificationId: row.fulfilled_by_prize_qualification_id ?? null,
    holdPriorPrizeQualificationId: row.hold_prior_prize_qualification_id ?? null,
    heldAt: row.held_at ?? null,
    holdBasis: row.hold_basis ?? null,
    holdReason: row.hold_reason ?? null,
    releasedAt: row.released_at ?? null,
    releasedByGamingMemberId: row.released_by_gaming_member_id ?? null,
    releaseReason: row.release_reason ?? null,
    createdAt: row.created_at,
  };
}

/** The text after "CODE: " in a P0001 message — the human detail the function raised. */
function detailAfter(message: string, code: string): string | undefined {
  const marker = `${code}: `;
  const at = message.indexOf(marker);
  if (at < 0) return undefined;
  const detail = message.slice(at + marker.length).trim();
  return detail.length > 0 ? detail : undefined;
}

/** Translates a P0001-coded exception, raised by name inside the body, into its typed error class. */
function translateNamedError(error: { code?: string; message?: string }): Error | null {
  if (error.code !== "P0001" || typeof error.message !== "string") return null;
  const message = error.message;
  // Longer, more specific codes first: matching is by substring.
  const table: Array<[string, (detail: string | undefined) => Error]> = [
    ["MATCH_RESULT_BASE_REQUIRED", () => new MatchResultBaseRequiredError()],
    ["MATCH_RESULT_BASE_STALE", () => new MatchResultBaseStaleError()],
    ["MATCH_RESULT_DIGEST_REQUIRED", () => new MatchResultDigestRequiredError()],
    ["MATCH_RESULT_DIGEST_MISMATCH", () => new MatchResultDigestMismatchError()],
    ["MATCH_RESULT_SCORE_INVALID", () => new InvalidMatchResultScoreError()],
    ["MATCH_RESULT_EVENTS_INVALID", (detail) => new InvalidMatchResultEventsError(detail)],
    ["MATCH_RESULT_EVENT_MINUTE_INVALID", (detail) => new MatchResultEventMinuteInvalidError(detail)],
    ["MATCH_RESULT_SCORER_NOT_IN_MATCH", (detail) => new MatchResultScorerNotInMatchError(detail)],
    ["MATCH_RESULT_EVENTS_CONTRADICT_SCORE", (detail) => new MatchResultEventsContradictScoreError(detail)],
    ["MATCH_RESULT_IS_CORRECTION", () => new MatchResultIsCorrectionError()],
    ["MATCH_RESULT_FINALIZED_IMMUTABLE", () => new MatchResultFinalizedImmutableError()],
    ["RESULT_ALREADY_BEING_CORRECTED", () => new ResultAlreadyBeingCorrectedError()],
    ["PRIZE_QUALIFICATION_NOT_HELD", () => new PrizeQualificationNotHeldError()],
    ["PRIZE_QUALIFICATION_HELD", () => new PrizeQualificationHeldError()],
    ["PRIZE_ALREADY_FULFILLED", () => new PrizeAlreadyFulfilledError()],
    ["TIER_KEY_CONTRACT_MISMATCH", () => new TierKeyContractMismatchError()],
    ["CONTRACT_MISMATCH", (detail) => new ContractMismatchError(detail)],
    ["CONTRACT_FROZEN", () => new ContractFrozenError()],
    ["INVALID_ATTEMPT_SHAPE", (detail) => new InvalidAttemptShapeError(detail)],
    ["LEVEL_NOT_OFFERED", () => new LevelNotOfferedError()],
    ["OFFER_NOT_AVAILABLE", () => new OfferNotAvailableError()],
    ["OFFER_DIGEST_REQUIRED", () => new OfferDigestRequiredError()],
    ["OFFER_CHANGED", () => new OfferChangedError()],
    ["OFFER_FROZEN", () => new OfferFrozenError()],
    ["RESULT_ALREADY_FINALIZED", () => new ResultAlreadyFinalizedError()],
    ["MATCH_NOT_FOUND", () => new MatchNotFoundError()],
    ["MATCH_CANCELLED", () => new MatchCancelledError()],
    ["MATCH_NOT_CLASSIFIED", () => new MatchNotClassifiedError()],
    ["ACTIVITY_CLASSIFICATION_LOCKED", () => new ActivityClassificationLockedError()],
    ["XP_ELIGIBILITY_LOCKED", () => new XpEligibilityLockedError()],
    ["KICKOFF_PASSED", () => new KickoffPassedError()],
    ["VENUE_ACTIVATION_NOT_FOUND", () => new VenueActivationNotFoundError()],
    ["VENUE_ACTIVATION_MATCH_MISMATCH", () => new VenueActivationMatchMismatchError()],
    ["VENUE_ACTIVATION_DISABLED", () => new VenueActivationDisabledError()],
    ["VENUE_ACTIVATION_IMMUTABLE", () => new VenueActivationImmutableError()],
    ["GEO_NOT_ELIGIBLE", () => new GeoNotEligibleError()],
    ["INVALID_SCORE", () => new InvalidPredictionScoreError()],
    ["INVALID_GOAL_MINUTE", () => new InvalidGoalMinuteError()],
    ["INVALID_FIRST_TEAM", () => new InvalidFirstTeamError()],
    ["INVALID_GOALSCORER_SELECTION", () => new InvalidGoalscorerSelectionError()],
    ["MATCH_RESULT_NOT_FOUND", () => new MatchResultNotFoundError()],
    ["NOT_A_CORRECTION", () => new NotACorrectionError()],
    ["SUPERSEDED_RESULT_NOT_FINALIZED", () => new SupersededResultNotFinalizedError()],
    ["PRIZE_QUALIFICATION_NOT_FOUND", () => new PrizeQualificationNotFoundError()],
    ["QUALIFICATION_SUPERSEDED", () => new QualificationSupersededError()],
    ["CONSEQUENTIAL_FINALIZER_AUTHORITY_REQUIRED", () => new InsufficientPlatformAuthorityError("CONSEQUENTIAL_FINALIZER")],
    ["REASON_REQUIRED", () => new ReasonRequiredError()],
  ];
  for (const [code, build] of table) {
    if (message.includes(code)) return build(detailAfter(message, code));
  }
  return null;
}

export class SupabasePredictionsRepository implements PredictionsRepository {
  private client: SupabaseClient;

  constructor(supabaseUrl: string, supabaseServiceKey: string) {
    // Next.js App Router patches the global fetch with its own Data
    // Cache, which supabase-js's underlying HTTP calls are otherwise
    // subject to — a plain GET route handler with no dynamic segment
    // and no request-object access (e.g. matches/route.ts) can read
    // back a cached, stale (even empty) result across requests despite
    // `export const dynamic = "force-dynamic"` on the route itself.
    // Found and fixed during this phase's own operational simulation:
    // a freshly-created venue_activations row was invisible through
    // this exact path until this override was added. Explicit
    // cache: "no-store" makes every request this repository makes
    // genuinely uncached, independent of the calling route's own
    // dynamic/static classification.
    this.client = createClient(supabaseUrl, supabaseServiceKey, {
      global: {
        // `cache` is a real, valid RequestInit member at runtime (both
        // in Next.js's patched fetch and in the underlying Node/undici
        // implementation) — the `as RequestInit` cast works around
        // @types/node's own fetch typings not yet declaring it.
        fetch: (input, init) =>
          fetch(input, { ...init, cache: "no-store" } as RequestInit),
      },
    });
  }

  async createTeam(input: { name: string }): Promise<TeamRecord> {
    const { data, error } = await this.client
      .from("teams")
      .insert({ name: input.name })
      .select()
      .single();
    if (error) throw error;
    return mapTeam(data);
  }

  async getTeamById(teamId: string): Promise<TeamRecord | null> {
    const { data, error } = await this.client
      .from("teams")
      .select("*")
      .eq("team_id", teamId)
      .maybeSingle();
    if (error) throw error;
    return data ? mapTeam(data) : null;
  }

  async listTeams(): Promise<TeamRecord[]> {
    const { data, error } = await this.client.from("teams").select("*").order("name");
    if (error) throw error;
    return (data ?? []).map(mapTeam);
  }

  async createPlayer(input: { teamId: string; name: string }): Promise<PlayerRecord> {
    const { data, error } = await this.client
      .from("players")
      .insert({ team_id: input.teamId, name: input.name })
      .select()
      .single();
    if (error) throw error;
    return mapPlayer(data);
  }

  async editPlayer(playerId: string, input: { name: string }): Promise<PlayerRecord> {
    const { data, error } = await this.client
      .from("players")
      .update({ name: input.name })
      .eq("player_id", playerId)
      .select()
      .single();
    if (error) throw error;
    return mapPlayer(data);
  }

  async setPlayerActive(playerId: string, active: boolean): Promise<PlayerRecord> {
    const { data, error } = await this.client
      .from("players")
      .update({ active })
      .eq("player_id", playerId)
      .select()
      .single();
    if (error) throw error;
    return mapPlayer(data);
  }

  async getPlayerById(playerId: string): Promise<PlayerRecord | null> {
    const { data, error } = await this.client
      .from("players")
      .select("*")
      .eq("player_id", playerId)
      .maybeSingle();
    if (error) throw error;
    return data ? mapPlayer(data) : null;
  }

  async listPlayersForTeam(teamId: string): Promise<PlayerRecord[]> {
    const { data, error } = await this.client
      .from("players")
      .select("*")
      .eq("team_id", teamId)
      .order("name");
    if (error) throw error;
    return (data ?? []).map(mapPlayer);
  }

  async createMatch(input: {
    homeTeamId: string;
    awayTeamId: string;
    competition: string;
    kickoffAt: string;
    predictionContract?: PredictionContract;
  }): Promise<MatchRecord> {
    const { data, error } = await this.client
      .from("matches")
      .insert({
        home_team_id: input.homeTeamId,
        away_team_id: input.awayTeamId,
        competition: input.competition,
        kickoff_at: input.kickoffAt,
        // Omitted, the column default (the historical contract) applies.
        ...(input.predictionContract ? { prediction_contract: input.predictionContract } : {}),
      })
      .select()
      .single();
    if (error) throw error;
    return mapMatch(data);
  }

  async setMatchPredictionContract(
    matchId: string,
    predictionContract: PredictionContract
  ): Promise<MatchRecord> {
    const { data, error } = await this.client
      .from("matches")
      .update({ prediction_contract: predictionContract })
      .eq("match_id", matchId)
      .select()
      .maybeSingle();
    if (error) {
      const translated = translateNamedError(error);
      if (translated) throw translated;
      throw error;
    }
    if (!data) throw new MatchNotFoundError();
    return mapMatch(data);
  }

  async editMatch(
    matchId: string,
    input: { homeTeamId: string; awayTeamId: string; competition: string; kickoffAt: string }
  ): Promise<MatchRecord> {
    const { data, error } = await this.client
      .from("matches")
      .update({
        home_team_id: input.homeTeamId,
        away_team_id: input.awayTeamId,
        competition: input.competition,
        kickoff_at: input.kickoffAt,
      })
      .eq("match_id", matchId)
      .select()
      .single();
    if (error) throw error;
    return mapMatch(data);
  }

  async cancelMatch(matchId: string): Promise<MatchRecord> {
    const { data, error } = await this.client
      .from("matches")
      .update({ cancelled_at: new Date().toISOString() })
      .eq("match_id", matchId)
      .select()
      .single();
    if (error) throw error;
    return mapMatch(data);
  }

  async setMatchActivityClassification(
    matchId: string,
    activityClassification: "TRAINING" | "CASUAL" | "RANKED" | "OFFICIAL",
    actorGamingMemberId: string,
    reason: string | null
  ): Promise<{ matchId: string; activityClassification: string; locked: boolean }> {
    const { data, error } = await this.client.rpc("set_match_activity_classification_atomically", {
      p_match_id: matchId,
      p_activity_classification: activityClassification,
      p_actor_gaming_member_id: actorGamingMemberId,
      p_reason: reason,
    });
    if (error) {
      const translated = translateNamedError(error);
      throw translated ?? error;
    }
    const row = data[0];
    return { matchId: row.match_id, activityClassification: row.activity_classification, locked: row.locked };
  }

  async setMatchXpEligibility(
    matchId: string,
    xpEligible: boolean,
    actorGamingMemberId: string,
    reason: string | null
  ): Promise<{ matchId: string; xpEligible: boolean; locked: boolean }> {
    const { data, error } = await this.client.rpc("set_match_xp_eligibility_atomically", {
      p_match_id: matchId,
      p_xp_eligible: xpEligible,
      p_actor_gaming_member_id: actorGamingMemberId,
      p_reason: reason,
    });
    if (error) {
      const translated = translateNamedError(error);
      throw translated ?? error;
    }
    const row = data[0];
    return { matchId: row.match_id, xpEligible: row.xp_eligible, locked: row.locked };
  }

  async getMatchById(matchId: string): Promise<MatchRecord | null> {
    const { data, error } = await this.client
      .from("matches")
      .select("*")
      .eq("match_id", matchId)
      .maybeSingle();
    if (error) throw error;
    return data ? mapMatch(data) : null;
  }

  async listMatches(): Promise<MatchRecord[]> {
    const { data, error } = await this.client
      .from("matches")
      .select("*")
      .order("kickoff_at", { ascending: false });
    if (error) throw error;
    return (data ?? []).map(mapMatch);
  }

  async createVenue(input: {
    name: string;
    latitude: number;
    longitude: number;
    radiusMeters: number;
  }): Promise<VenueRecord> {
    const { data, error } = await this.client
      .from("venues")
      .insert({
        name: input.name,
        latitude: input.latitude,
        longitude: input.longitude,
        radius_meters: input.radiusMeters,
      })
      .select()
      .single();
    if (error) throw error;
    return mapVenue(data);
  }

  async editVenue(
    venueId: string,
    input: {
      name: string;
      latitude: number;
      longitude: number;
      radiusMeters: number;
      active: boolean;
    }
  ): Promise<VenueRecord> {
    const { data, error } = await this.client
      .from("venues")
      .update({
        name: input.name,
        latitude: input.latitude,
        longitude: input.longitude,
        radius_meters: input.radiusMeters,
        active: input.active,
      })
      .eq("venue_id", venueId)
      .select()
      .single();
    if (error) throw error;
    return mapVenue(data);
  }

  async getVenueById(venueId: string): Promise<VenueRecord | null> {
    const { data, error } = await this.client
      .from("venues")
      .select("*")
      .eq("venue_id", venueId)
      .maybeSingle();
    if (error) throw error;
    return data ? mapVenue(data) : null;
  }

  async listVenues(): Promise<VenueRecord[]> {
    const { data, error } = await this.client.from("venues").select("*").order("name");
    if (error) throw error;
    return (data ?? []).map(mapVenue);
  }

  async createVenueActivation(input: {
    matchId: string;
    venueId: string;
  }): Promise<VenueActivationRecord> {
    const { data, error } = await this.client
      .from("venue_activations")
      .insert({ match_id: input.matchId, venue_id: input.venueId })
      .select()
      .single();
    if (error) throw error;
    return mapActivation(data);
  }

  async setVenueActivationEnabled(
    venueActivationId: string,
    enabled: boolean
  ): Promise<VenueActivationRecord> {
    const { data, error } = await this.client
      .from("venue_activations")
      .update({ enabled })
      .eq("venue_activation_id", venueActivationId)
      .select()
      .single();
    if (error) throw error;
    return mapActivation(data);
  }

  async getVenueActivationById(
    venueActivationId: string
  ): Promise<VenueActivationRecord | null> {
    const { data, error } = await this.client
      .from("venue_activations")
      .select("*")
      .eq("venue_activation_id", venueActivationId)
      .maybeSingle();
    if (error) throw error;
    return data ? mapActivation(data) : null;
  }

  async listVenueActivationsForMatch(matchId: string): Promise<VenueActivationRecord[]> {
    const { data, error } = await this.client
      .from("venue_activations")
      .select("*")
      .eq("match_id", matchId);
    if (error) throw error;
    return (data ?? []).map(mapActivation);
  }

  async createPrizeTier(input: {
    venueActivationId: string;
    correctDimensionCount: number;
    prizeLabel: string;
  }): Promise<PrizeTierRecord> {
    const { data, error } = await this.client
      .from("prize_tiers")
      .insert({
        venue_activation_id: input.venueActivationId,
        correct_dimension_count: input.correctDimensionCount,
        prize_label: input.prizeLabel,
      })
      .select()
      .single();
    if (error) {
      const translated = translateNamedError(error);
      if (translated) throw translated;
      throw error;
    }
    return mapPrizeTier(data);
  }

  async createLadderPrizeTier(input: {
    venueActivationId: string;
    ladderLevel: number;
    prizeLabel: string;
  }): Promise<PrizeTierRecord> {
    const { data, error } = await this.client
      .from("prize_tiers")
      .insert({
        venue_activation_id: input.venueActivationId,
        ladder_level: input.ladderLevel,
        prize_label: input.prizeLabel,
      })
      .select()
      .single();
    if (error) {
      const translated = translateNamedError(error);
      if (translated) throw translated;
      throw error;
    }
    return mapPrizeTier(data);
  }

  async listPrizeTiersForActivation(venueActivationId: string): Promise<PrizeTierRecord[]> {
    const { data, error } = await this.client
      .from("prize_tiers")
      .select("*")
      .eq("venue_activation_id", venueActivationId);
    if (error) throw error;
    // Ordered here, not in the query, so that listing never names a column an unmigrated database does not have.
    return (data ?? [])
      .map(mapPrizeTier)
      .sort((a, b) => (a.correctDimensionCount ?? 0) - (b.correctDimensionCount ?? 0) || (a.ladderLevel ?? 0) - (b.ladderLevel ?? 0));
  }

  async upsertPrediction(input: {
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
  }): Promise<PredictionRecord> {
    const { data, error } = await this.client.rpc("upsert_prediction_atomically", {
      p_match_id: input.matchId,
      p_gaming_member_id: input.gamingMemberId,
      p_venue_activation_id: input.venueActivationId,
      p_predicted_home_score: input.predictedHomeScore,
      p_predicted_away_score: input.predictedAwayScore,
      p_predicted_goalscorer_player_id: input.predictedGoalscorerPlayerId,
      p_predicted_goal_minute_regulation: input.predictedGoalMinuteRegulation,
      p_predicted_goal_minute_stoppage: input.predictedGoalMinuteStoppage,
      p_predicted_first_team_to_score: input.predictedFirstTeamToScore,
      p_geo_verified_at: input.geoVerifiedAt,
      p_measured_distance_meters: input.measuredDistanceMeters,
      p_reported_accuracy_meters: input.reportedAccuracyMeters,
      p_geo_eligible: input.geoEligible,
    });

    if (error) {
      const translated = translateNamedError(error);
      if (translated) throw translated;
      throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;
    return mapPrediction(row);
  }

  async upsertProgressivePrediction(input: {
    matchId: string;
    gamingMemberId: string;
    venueActivationId: string;
    answers: ProgressiveAnswers;
    offerDigest: string | null;
    geoVerifiedAt: string;
    measuredDistanceMeters: number;
    reportedAccuracyMeters: number | null;
    geoEligible: boolean;
  }): Promise<PredictionRecord> {
    // The states are sent explicitly: a missing category is NOT_ATTEMPTED,
    // never a null the function would have to interpret.
    const columns = progressiveColumnsOf(input.answers);
    const { data, error } = await this.client.rpc("upsert_progressive_prediction_atomically", {
      p_match_id: input.matchId,
      p_gaming_member_id: input.gamingMemberId,
      p_venue_activation_id: input.venueActivationId,
      p_attempted_level: input.answers.attemptedLevel,
      p_predicted_home_score: input.answers.scoreline.home,
      p_predicted_away_score: input.answers.scoreline.away,
      p_first_team_state: columns.firstTeamState,
      p_first_team: columns.firstTeam,
      p_goalscorer_state: columns.goalscorerState,
      p_goalscorer_player_id: columns.goalscorerPlayerId,
      p_goal_minute_state: columns.goalMinuteState,
      p_goal_minute_regulation: columns.goalMinuteRegulation,
      p_goal_minute_stoppage: columns.goalMinuteStoppage,
      p_offer_digest: input.offerDigest,
      p_geo_verified_at: input.geoVerifiedAt,
      p_measured_distance_meters: input.measuredDistanceMeters,
      p_reported_accuracy_meters: input.reportedAccuracyMeters,
      p_geo_eligible: input.geoEligible,
    });

    if (error) {
      const translated = translateNamedError(error);
      if (translated) throw translated;
      throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;
    return mapPrediction(row);
  }

  async getPredictionForMember(
    matchId: string,
    gamingMemberId: string
  ): Promise<PredictionRecord | null> {
    const { data, error } = await this.client
      .from("predictions")
      .select("*")
      .eq("match_id", matchId)
      .eq("gaming_member_id", gamingMemberId)
      .maybeSingle();
    if (error) throw error;
    return data ? mapPrediction(data) : null;
  }

  async listPredictionsForMatch(matchId: string): Promise<PredictionRecord[]> {
    const { data, error } = await this.client
      .from("predictions")
      .select("*")
      .eq("match_id", matchId);
    if (error) throw error;
    return (data ?? []).map(mapPrediction);
  }

  async listPredictionsForMember(gamingMemberId: string, limit = 50): Promise<PredictionRecord[]> {
    const { data, error } = await this.client
      .from("predictions")
      .select("*")
      .eq("gaming_member_id", gamingMemberId)
      .order("created_at", { ascending: false })
      .limit(Math.max(1, Math.min(limit, 200)));
    if (error) throw error;
    return (data ?? []).map(mapPrediction);
  }

  // Batch reads for a member's history (see the interface): ONE request per table for the whole list of ids (split only when a list
  // is long enough to make the address too big), instead of one request per record.
  private async readByIds(table: string, column: string, ids: string[]): Promise<any[]> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return [];
    const chunks: string[][] = [];
    for (let i = 0; i < unique.length; i += 100) chunks.push(unique.slice(i, i + 100));
    const pages = await Promise.all(
      chunks.map(async (chunk) => {
        const { data, error } = await this.client.from(table).select("*").in(column, chunk);
        if (error) throw error;
        return data ?? [];
      })
    );
    return pages.flat();
  }

  async getMatchesByIds(matchIds: string[]): Promise<MatchRecord[]> {
    return (await this.readByIds("matches", "match_id", matchIds)).map(mapMatch);
  }

  async getTeamsByIds(teamIds: string[]): Promise<TeamRecord[]> {
    return (await this.readByIds("teams", "team_id", teamIds)).map(mapTeam);
  }

  async getPlayersByIds(playerIds: string[]): Promise<PlayerRecord[]> {
    return (await this.readByIds("players", "player_id", playerIds)).map(mapPlayer);
  }

  async getVenueActivationsByIds(venueActivationIds: string[]): Promise<VenueActivationRecord[]> {
    return (await this.readByIds("venue_activations", "venue_activation_id", venueActivationIds)).map(mapActivation);
  }

  async getVenuesByIds(venueIds: string[]): Promise<VenueRecord[]> {
    return (await this.readByIds("venues", "venue_id", venueIds)).map(mapVenue);
  }

  async listPrizeTiersForActivations(venueActivationIds: string[]): Promise<PrizeTierRecord[]> {
    return (await this.readByIds("prize_tiers", "venue_activation_id", venueActivationIds)).map(mapPrizeTier);
  }

  async getCurrentEvaluationsForPredictions(predictionIds: string[]): Promise<EvaluationRecord[]> {
    const rows = await this.readByIds("evaluations", "prediction_id", predictionIds);
    const byPrediction = new Map<string, any[]>();
    for (const row of rows) {
      const list = byPrediction.get(row.prediction_id as string) ?? [];
      list.push(row);
      byPrediction.set(row.prediction_id as string, list);
    }
    const current: EvaluationRecord[] = [];
    for (const [predictionId, evaluations] of byPrediction) {
      if (evaluations.length === 1) {
        current.push(mapEvaluation(evaluations[0]));
        continue;
      }
      // More than one evaluation means the result was corrected: which one is current is decided by the explicit supersession chain,
      // which the single-record read already resolves. It is used for these predictions only, so the common case stays one request.
      const resolved = await this.getCurrentEvaluationForPrediction(predictionId);
      if (resolved) current.push(resolved);
    }
    return current;
  }

  async saveDraftMatchResult(input: {
    matchId: string;
    homeScore: number;
    awayScore: number;
    officialGoalEvents: OfficialGoalEventInput[];
    enteredByGamingMemberId: string;
    saveBase: string;
  }): Promise<SavedMatchResult> {
    // One transaction in Postgres: the match is locked, initial draft
    // versus correction is decided under that lock, the input is
    // validated, and the draft's goal events are replaced together with
    // the draft row. A failure leaves the prior draft untouched.
    const { data, error } = await this.client.rpc("save_draft_match_result_atomically", {
      p_match_id: input.matchId,
      p_entered_by_gaming_member_id: input.enteredByGamingMemberId,
      p_home_score: input.homeScore,
      p_away_score: input.awayScore,
      p_events: input.officialGoalEvents.map((event) => ({
        scorerPlayerId: event.scorerPlayerId,
        minuteRegulation: event.minuteRegulation,
        minuteStoppage: event.minuteStoppage ?? null,
        isOwnGoal: event.isOwnGoal ?? false,
      })),
      p_save_base: input.saveBase,
    });
    if (error) {
      const translated = translateNamedError(error);
      if (translated) throw translated;
      throw error;
    }
    const row = Array.isArray(data) ? data[0] : data;
    return {
      matchResultId: row.match_result_id,
      matchId: row.match_id,
      homeScore: row.home_score,
      awayScore: row.away_score,
      finalizedAt: null,
      supersedesMatchResultId: row.supersedes_match_result_id,
      enteredByGamingMemberId: row.entered_by_gaming_member_id,
      finalizedByGamingMemberId: null,
      createdAt: row.created_at,
      contentDigest: row.content_digest,
      isCorrection: row.is_correction,
    };
  }

  async getMatchResultById(matchResultId: string): Promise<MatchResultRecord | null> {
    const { data, error } = await this.client
      .from("match_results")
      .select("*")
      .eq("match_result_id", matchResultId)
      .maybeSingle();
    if (error) throw error;
    return data ? mapMatchResult(data) : null;
  }

  async getMatchResultContentDigest(matchResultId: string): Promise<string | null> {
    const { data, error } = await this.client.rpc("match_result_content_digest", {
      p_match_result_id: matchResultId,
    });
    if (error) throw error;
    return typeof data === "string" ? data : null;
  }

  async getDraftMatchResult(matchId: string): Promise<MatchResultRecord | null> {
    const { data, error } = await this.client
      .from("match_results")
      .select("*")
      .eq("match_id", matchId)
      .is("finalized_at", null)
      .maybeSingle();
    if (error) throw error;
    return data ? mapMatchResult(data) : null;
  }

  async getCurrentFinalizedMatchResult(matchId: string): Promise<MatchResultRecord | null> {
    // The currently-authoritative finalized version is the one no
    // other finalized row supersedes yet — the same supersession-chain
    // definition save_draft_match_result_atomically uses, independent
    // of finalization timestamps.
    const { data, error } = await this.client
      .from("match_results")
      .select("*")
      .eq("match_id", matchId)
      .not("finalized_at", "is", null);
    if (error) throw error;
    const finalized = (data ?? []).map(mapMatchResult);
    return (
      finalized.find(
        (candidate) =>
          !finalized.some((other) => other.supersedesMatchResultId === candidate.matchResultId)
      ) ?? null
    );
  }

  async listGoalEventsForResult(matchResultId: string): Promise<OfficialGoalEventRecord[]> {
    const { data, error } = await this.client
      .from("official_goal_events")
      .select("*")
      .eq("match_result_id", matchResultId)
      .order("ordinal");
    if (error) throw error;
    return (data ?? []).map(mapGoalEvent);
  }

  async finalizeMatchResult(
    matchResultId: string,
    finalizedByGamingMemberId: string,
    reason: string | null,
    expectedDigest: string
  ): Promise<{ matchResultId: string; finalizedAt: string; alreadyFinalized: boolean }> {
    const { data, error } = await this.client.rpc("finalize_match_result_atomically", {
      p_match_result_id: matchResultId,
      p_finalized_by_gaming_member_id: finalizedByGamingMemberId,
      p_reason: reason,
      p_expected_digest: expectedDigest,
    });
    if (error) {
      const translated = translateNamedError(error);
      if (translated) throw translated;
      throw error;
    }
    const row = Array.isArray(data) ? data[0] : data;
    return {
      matchResultId: row.match_result_id,
      finalizedAt: row.finalized_at,
      alreadyFinalized: row.already_finalized,
    };
  }

  async correctMatchResult(
    matchResultId: string,
    finalizedByGamingMemberId: string,
    reason: string,
    expectedDigest: string
  ): Promise<{
    matchResultId: string;
    finalizedAt: string;
    supersedesMatchResultId: string;
    alreadyFinalized: boolean;
  }> {
    const { data, error } = await this.client.rpc("correct_match_result_atomically", {
      p_match_result_id: matchResultId,
      p_finalized_by_gaming_member_id: finalizedByGamingMemberId,
      p_reason: reason,
      p_expected_digest: expectedDigest,
    });
    if (error) {
      const translated = translateNamedError(error);
      if (translated) throw translated;
      throw error;
    }
    const row = Array.isArray(data) ? data[0] : data;
    return {
      matchResultId: row.match_result_id,
      finalizedAt: row.finalized_at,
      supersedesMatchResultId: row.supersedes_match_result_id,
      alreadyFinalized: row.already_finalized,
    };
  }

  async getEvaluation(
    predictionId: string,
    matchResultId: string
  ): Promise<EvaluationRecord | null> {
    const { data, error } = await this.client
      .from("evaluations")
      .select("*")
      .eq("prediction_id", predictionId)
      .eq("match_result_id", matchResultId)
      .maybeSingle();
    if (error) throw error;
    return data ? mapEvaluation(data) : null;
  }

  async getCurrentEvaluationForPrediction(
    predictionId: string
  ): Promise<EvaluationRecord | null> {
    // The current evaluation is the one for the result at the highest
    // position of the explicit supersession chain — never the latest
    // timestamp (transaction-start times cannot order a chain).
    const { data, error } = await this.client
      .from("evaluations")
      .select("*, predictions!inner(match_id)")
      .eq("prediction_id", predictionId);
    if (error) throw error;
    const evaluations = data ?? [];
    if (evaluations.length === 0) return null;
    if (evaluations.length === 1) return mapEvaluation(evaluations[0]);

    const matchId = (evaluations[0] as any).predictions.match_id as string;
    const { data: results, error: resultsError } = await this.client
      .from("match_results")
      .select("match_result_id, supersedes_match_result_id")
      .eq("match_id", matchId);
    if (resultsError) throw resultsError;
    const parentOf = new Map<string, string | null>(
      (results ?? []).map((r: any) => [r.match_result_id as string, (r.supersedes_match_result_id as string | null) ?? null])
    );

    let current: any = null;
    let currentLineage = -1;
    for (const evaluation of evaluations) {
      const lineage = lineageOrdinalOf(evaluation.match_result_id, (id) => parentOf.get(id));
      if (lineage === null) throw new Error("evaluation order cannot be established: unreadable result chain");
      if (lineage > currentLineage) {
        current = evaluation;
        currentLineage = lineage;
      }
    }
    return mapEvaluation(current);
  }

  async listProgressionEventsForMember(
    gamingMemberId: string
  ): Promise<GamingProgressionEventRecord[]> {
    const { data, error } = await this.client
      .from("gaming_progression_events")
      .select("*")
      .eq("gaming_member_id", gamingMemberId)
      .order("created_at");
    if (error) throw error;
    return (data ?? []).map(mapProgressionEvent);
  }

  async getLeaderboard(): Promise<LeaderboardEntry[]> {
    const { data, error } = await this.client
      .from("gaming_progression_events")
      .select("gaming_member_id, points, gaming_members(display_name)");
    if (error) throw error;

    const totals = new Map<string, { displayName: string; totalPoints: number }>();
    for (const row of data ?? []) {
      const gamingMemberId = (row as any).gaming_member_id as string;
      const displayName = (row as any).gaming_members?.display_name ?? "Unknown";
      const points = (row as any).points as number;
      const existing = totals.get(gamingMemberId);
      if (existing) {
        existing.totalPoints += points;
      } else {
        totals.set(gamingMemberId, { displayName, totalPoints: points });
      }
    }

    return [...totals.entries()]
      .map(([gamingMemberId, v]) => ({ gamingMemberId, ...v }))
      .sort((a, b) => b.totalPoints - a.totalPoints);
  }

  async getQualificationForEvaluation(
    evaluationId: string
  ): Promise<PrizeQualificationRecord | null> {
    const { data, error } = await this.client
      .from("prize_qualifications")
      .select("*")
      .eq("evaluation_id", evaluationId)
      .maybeSingle();
    if (error) throw error;
    return data ? mapQualification(data) : null;
  }

  async listQualificationsForMember(
    gamingMemberId: string
  ): Promise<PrizeQualificationRecord[]> {
    const { data, error } = await this.client
      .from("prize_qualifications")
      .select("*")
      .eq("gaming_member_id", gamingMemberId);
    if (error) throw error;
    return (data ?? []).map(mapQualification);
  }

  async listQualificationsForActivation(
    venueActivationId: string
  ): Promise<PrizeQualificationRecord[]> {
    const { data, error } = await this.client
      .from("prize_qualifications")
      .select("*")
      .eq("venue_activation_id", venueActivationId);
    if (error) throw error;
    return (data ?? []).map(mapQualification);
  }

  async listQualificationDetailsForActivation(
    venueActivationId: string
  ): Promise<PrizeQualificationDetailRecord[]> {
    const qualifications = await this.listQualificationsForActivation(venueActivationId);
    if (qualifications.length === 0) return [];

    const memberIds = [...new Set(qualifications.map((q) => q.gamingMemberId))];
    const tierIds = [...new Set(qualifications.map((q) => q.prizeTierId))];

    const [memberResults, tierResults] = await Promise.all([
      Promise.all(
        chunk(memberIds, IN_LOOKUP_CHUNK_SIZE).map((ids) =>
          this.client
            .from("gaming_members")
            .select("gaming_member_id, display_name")
            .in("gaming_member_id", ids)
        )
      ),
      Promise.all(
        chunk(tierIds, IN_LOOKUP_CHUNK_SIZE).map((ids) =>
          this.client
            .from("prize_tiers")
            .select("prize_tier_id, prize_label")
            .in("prize_tier_id", ids)
        )
      ),
    ]);

    const memberDisplayNames = new Map<string, string>();
    for (const { data, error } of memberResults) {
      if (error) throw error;
      for (const row of data ?? []) memberDisplayNames.set(row.gaming_member_id, row.display_name);
    }
    const prizeLabels = new Map<string, string>();
    for (const { data, error } of tierResults) {
      if (error) throw error;
      for (const row of data ?? []) prizeLabels.set(row.prize_tier_id, row.prize_label);
    }

    return attachQualificationDetails(qualifications, memberDisplayNames, prizeLabels);
  }

  async redeemPrizeQualification(
    prizeQualificationId: string,
    redeemedByGamingMemberId: string,
    reason: string | null
  ): Promise<{ prizeQualificationId: string; redeemedAt: string; alreadyRedeemed: boolean }> {
    const { data, error } = await this.client.rpc("redeem_prize_qualification_atomically", {
      p_prize_qualification_id: prizeQualificationId,
      p_redeemed_by_gaming_member_id: redeemedByGamingMemberId,
      p_reason: reason,
    });
    if (error) {
      const translated = translateNamedError(error);
      if (translated) throw translated;
      throw error;
    }
    const row = Array.isArray(data) ? data[0] : data;
    return {
      prizeQualificationId: row.prize_qualification_id,
      redeemedAt: row.redeemed_at,
      alreadyRedeemed: row.already_redeemed,
    };
  }

  async releasePrizeQualificationHold(
    prizeQualificationId: string,
    releasedByGamingMemberId: string,
    reason: string
  ): Promise<{ prizeQualificationId: string; releasedAt: string; alreadyReleased: boolean }> {
    const { data, error } = await this.client.rpc("release_prize_qualification_hold_atomically", {
      p_prize_qualification_id: prizeQualificationId,
      p_released_by_gaming_member_id: releasedByGamingMemberId,
      p_reason: reason,
    });
    if (error) {
      const translated = translateNamedError(error);
      if (translated) throw translated;
      throw error;
    }
    const row = Array.isArray(data) ? data[0] : data;
    return {
      prizeQualificationId: row.prize_qualification_id,
      releasedAt: row.released_at,
      alreadyReleased: row.already_released,
    };
  }
}
