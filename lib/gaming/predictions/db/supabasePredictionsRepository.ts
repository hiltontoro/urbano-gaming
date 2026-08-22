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
  OfficialGoalEventRecord,
  OfficialGoalEventInput,
  EvaluationRecord,
  GamingProgressionEventRecord,
  PrizeQualificationRecord,
  LeaderboardEntry,
} from "../types";
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
  DraftResultAlreadyExistsError,
} from "../types";
import { InsufficientPlatformAuthorityError, ReasonRequiredError } from "../../authority/types";

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
    scorelineCorrect: row.scoreline_correct,
    goalscorerCorrect: row.goalscorer_correct,
    goalMinuteCorrect: row.goal_minute_correct,
    firstTeamToScoreCorrect: row.first_team_to_score_correct,
    correctDimensionCount: row.correct_dimension_count,
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
    supersededAt: row.superseded_at,
    createdAt: row.created_at,
  };
}

/** Translates a P0001-coded exception, raised by name inside the body, into its typed error class. */
function translateNamedError(error: { code?: string; message?: string }): Error | null {
  if (error.code !== "P0001" || typeof error.message !== "string") return null;
  const table: Array<[string, () => Error]> = [
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
    if (error.message.includes(code)) return build();
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
  }): Promise<MatchRecord> {
    const { data, error } = await this.client
      .from("matches")
      .insert({
        home_team_id: input.homeTeamId,
        away_team_id: input.awayTeamId,
        competition: input.competition,
        kickoff_at: input.kickoffAt,
      })
      .select()
      .single();
    if (error) throw error;
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
    activityClassification: "TRAINING" | "CASUAL" | "RANKED" | "OFFICIAL"
  ): Promise<{ matchId: string; activityClassification: string; locked: boolean }> {
    const { data, error } = await this.client.rpc("set_match_activity_classification_atomically", {
      p_match_id: matchId,
      p_activity_classification: activityClassification,
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
    xpEligible: boolean
  ): Promise<{ matchId: string; xpEligible: boolean; locked: boolean }> {
    const { data, error } = await this.client.rpc("set_match_xp_eligibility_atomically", {
      p_match_id: matchId,
      p_xp_eligible: xpEligible,
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
    if (error) throw error;
    return mapPrizeTier(data);
  }

  async listPrizeTiersForActivation(venueActivationId: string): Promise<PrizeTierRecord[]> {
    const { data, error } = await this.client
      .from("prize_tiers")
      .select("*")
      .eq("venue_activation_id", venueActivationId)
      .order("correct_dimension_count");
    if (error) throw error;
    return (data ?? []).map(mapPrizeTier);
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

  async saveDraftMatchResult(input: {
    matchId: string;
    homeScore: number;
    awayScore: number;
    officialGoalEvents: OfficialGoalEventInput[];
    enteredByGamingMemberId: string;
    supersedesMatchResultId?: string | null;
  }): Promise<MatchResultRecord> {
    const existingDraft = await this.getDraftMatchResult(input.matchId);

    let matchResultId: string;
    let mappedResult: MatchResultRecord;

    if (existingDraft) {
      const { data, error } = await this.client
        .from("match_results")
        .update({ home_score: input.homeScore, away_score: input.awayScore })
        .eq("match_result_id", existingDraft.matchResultId)
        .select()
        .single();
      if (error) throw error;
      matchResultId = existingDraft.matchResultId;
      mappedResult = mapMatchResult(data);
    } else {
      const { data, error } = await this.client
        .from("match_results")
        .insert({
          match_id: input.matchId,
          home_score: input.homeScore,
          away_score: input.awayScore,
          entered_by_gaming_member_id: input.enteredByGamingMemberId,
          supersedes_match_result_id: input.supersedesMatchResultId ?? null,
        })
        .select()
        .single();
      if (error) {
        if (
          error.code === "23505" &&
          error.message.includes("match_results_one_draft_per_match")
        ) {
          throw new DraftResultAlreadyExistsError();
        }
        throw error;
      }
      matchResultId = data.match_result_id;
      mappedResult = mapMatchResult(data);
    }

    const { error: deleteError } = await this.client
      .from("official_goal_events")
      .delete()
      .eq("match_result_id", matchResultId);
    if (deleteError) throw deleteError;

    if (input.officialGoalEvents.length > 0) {
      const { error: insertError } = await this.client.from("official_goal_events").insert(
        input.officialGoalEvents.map((event, index) => ({
          match_result_id: matchResultId,
          scorer_player_id: event.scorerPlayerId,
          minute_regulation: event.minuteRegulation,
          minute_stoppage: event.minuteStoppage ?? null,
          is_own_goal: event.isOwnGoal ?? false,
          ordinal: index + 1,
        }))
      );
      if (insertError) throw insertError;
    }

    return mappedResult;
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
    // other finalized row supersedes yet — walking "not referenced as
    // a supersedes target by any row" is equivalent to and simpler
    // than following the chain forward.
    const { data, error } = await this.client
      .from("match_results")
      .select("*")
      .eq("match_id", matchId)
      .not("finalized_at", "is", null)
      .order("finalized_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data ? mapMatchResult(data) : null;
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
    reason: string | null
  ): Promise<{ matchResultId: string; finalizedAt: string; alreadyFinalized: boolean }> {
    const { data, error } = await this.client.rpc("finalize_match_result_atomically", {
      p_match_result_id: matchResultId,
      p_finalized_by_gaming_member_id: finalizedByGamingMemberId,
      p_reason: reason,
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
    reason: string
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
    const { data, error } = await this.client
      .from("evaluations")
      .select("*")
      .eq("prediction_id", predictionId)
      .order("evaluated_at", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data ? mapEvaluation(data) : null;
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

  async redeemPrizeQualification(
    prizeQualificationId: string,
    redeemedByGamingMemberId: string
  ): Promise<{ prizeQualificationId: string; redeemedAt: string; alreadyRedeemed: boolean }> {
    const { data, error } = await this.client.rpc("redeem_prize_qualification_atomically", {
      p_prize_qualification_id: prizeQualificationId,
      p_redeemed_by_gaming_member_id: redeemedByGamingMemberId,
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
}
