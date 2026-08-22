import { randomUUID } from "crypto";
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
import { InMemoryMetagameRepository } from "../../metagame/db/inMemoryMetagameRepository";
import { InMemoryAuditStore } from "../../audit/db/inMemoryAuditStore";
import { InMemoryAuthorityRepository } from "../../authority/db/inMemoryAuthorityRepository";
import { InsufficientPlatformAuthorityError, ReasonRequiredError } from "../../authority/types";
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

const PROGRESSION_RULE_KEYS = [
  "PREDICTION_PARTICIPATED",
  "PREDICTION_1_OF_4",
  "PREDICTION_2_OF_4",
  "PREDICTION_3_OF_4",
  "PREDICTION_4_OF_4",
];

/**
 * In-memory PredictionsRepository for behavioral tests — mirrors
 * lib/session/db/inMemorySessionRepository.ts's role: independently
 * re-implements the same invariants the real Postgres functions
 * enforce (roster-membership validation, kickoff lock, venue-activation
 * immutability, four-independent-dimension settlement, own-goal credit
 * derivation, chronological-first-goal derivation, append-only
 * progression compensation), not a thin passthrough.
 */
export class InMemoryPredictionsRepository implements PredictionsRepository {
  private teams = new Map<string, TeamRecord>();
  private players = new Map<string, PlayerRecord>();
  private matches = new Map<string, MatchRecord>();
  private venues = new Map<string, VenueRecord>();
  private activations = new Map<string, VenueActivationRecord>();
  private prizeTiers = new Map<string, PrizeTierRecord>();
  private predictions = new Map<string, PredictionRecord>();
  private matchResults = new Map<string, MatchResultRecord>();
  private goalEvents = new Map<string, OfficialGoalEventRecord[]>();
  private evaluations = new Map<string, EvaluationRecord>();
  private progressionEvents = new Map<string, GamingProgressionEventRecord>();
  private qualifications = new Map<string, PrizeQualificationRecord>();
  private progressionRulePoints = new Map<string, number>(
    PROGRESSION_RULE_KEYS.map((k) => [k, 0])
  );

  /**
   * Persistent Metagame Phase 1. Composed, not injected — mirrors how
   * finalize_match_result_atomically/correct_match_result_atomically
   * call record_experience_summary_atomically/
   * process_experience_summary_consequences_atomically as plain nested
   * function calls in the real Postgres implementation; this is that
   * same call relationship expressed in TypeScript. Exposed via a
   * getter so tests can inspect the ledger directly without a second,
   * separately-constructed repository instance that would silently
   * diverge from what finalize/correct actually wrote to.
   */
  private readonly metagame = new InMemoryMetagameRepository();
  get metagameRepository(): InMemoryMetagameRepository {
    return this.metagame;
  }

  /**
   * Admin Control Plane A0. Composed, not injected, mirroring metagame
   * above — auditStore is shared with authority so that grant/revoke
   * events and FINALIZE_RESULT/CORRECT_RESULT events land in the same
   * ledger, exactly as one Postgres transaction guarantees for the real
   * schema. Exposed via getters for the same reason metagameRepository
   * is: tests need to inspect the real instance finalize/correct wrote
   * to, not a second, silently-diverging one.
   */
  private readonly auditStore = new InMemoryAuditStore();
  private readonly authority = new InMemoryAuthorityRepository(this.auditStore);
  get authorityRepository(): InMemoryAuthorityRepository {
    return this.authority;
  }
  get auditStoreForTests(): InMemoryAuditStore {
    return this.auditStore;
  }

  /** Test-only seam: configure a progression rule's point value. */
  setRulePoints(ruleKey: string, points: number): void {
    this.progressionRulePoints.set(ruleKey, points);
  }

  async createTeam(input: { name: string }): Promise<TeamRecord> {
    const record: TeamRecord = {
      teamId: randomUUID(),
      name: input.name,
      createdAt: new Date().toISOString(),
    };
    this.teams.set(record.teamId, record);
    return record;
  }

  async getTeamById(teamId: string): Promise<TeamRecord | null> {
    return this.teams.get(teamId) ?? null;
  }

  async listTeams(): Promise<TeamRecord[]> {
    return [...this.teams.values()];
  }

  async createPlayer(input: { teamId: string; name: string }): Promise<PlayerRecord> {
    const record: PlayerRecord = {
      playerId: randomUUID(),
      teamId: input.teamId,
      name: input.name,
      active: true,
      createdAt: new Date().toISOString(),
    };
    this.players.set(record.playerId, record);
    return record;
  }

  async editPlayer(playerId: string, input: { name: string }): Promise<PlayerRecord> {
    const existing = this.players.get(playerId);
    if (!existing) throw new Error("Player not found.");
    const updated = { ...existing, name: input.name };
    this.players.set(playerId, updated);
    return updated;
  }

  async setPlayerActive(playerId: string, active: boolean): Promise<PlayerRecord> {
    const existing = this.players.get(playerId);
    if (!existing) throw new Error("Player not found.");
    const updated = { ...existing, active };
    this.players.set(playerId, updated);
    return updated;
  }

  async getPlayerById(playerId: string): Promise<PlayerRecord | null> {
    return this.players.get(playerId) ?? null;
  }

  async listPlayersForTeam(teamId: string): Promise<PlayerRecord[]> {
    return [...this.players.values()].filter((p) => p.teamId === teamId);
  }

  async createMatch(input: {
    homeTeamId: string;
    awayTeamId: string;
    competition: string;
    kickoffAt: string;
  }): Promise<MatchRecord> {
    const record: MatchRecord = {
      matchId: randomUUID(),
      homeTeamId: input.homeTeamId,
      awayTeamId: input.awayTeamId,
      competition: input.competition,
      kickoffAt: input.kickoffAt,
      cancelledAt: null,
      activityClassification: null,
      xpEligible: null,
      createdAt: new Date().toISOString(),
    };
    this.matches.set(record.matchId, record);
    return record;
  }

  async editMatch(
    matchId: string,
    input: { homeTeamId: string; awayTeamId: string; competition: string; kickoffAt: string }
  ): Promise<MatchRecord> {
    const existing = this.matches.get(matchId);
    if (!existing) throw new MatchNotFoundError();
    const updated = { ...existing, ...input };
    this.matches.set(matchId, updated);
    return updated;
  }

  async cancelMatch(matchId: string): Promise<MatchRecord> {
    const existing = this.matches.get(matchId);
    if (!existing) throw new MatchNotFoundError();
    const updated = { ...existing, cancelledAt: new Date().toISOString() };
    this.matches.set(matchId, updated);
    return updated;
  }

  async setMatchActivityClassification(
    matchId: string,
    activityClassification: "TRAINING" | "CASUAL" | "RANKED" | "OFFICIAL"
  ): Promise<{ matchId: string; activityClassification: string; locked: boolean }> {
    const existing = this.matches.get(matchId);
    if (!existing) throw new MatchNotFoundError();

    const hasPredictions = [...this.predictions.values()].some((p) => p.matchId === matchId);
    const hasResults = [...this.matchResults.values()].some((r) => r.matchId === matchId);

    if (hasPredictions || hasResults) {
      if (existing.activityClassification !== activityClassification) {
        throw new ActivityClassificationLockedError();
      }
      return { matchId, activityClassification: existing.activityClassification!, locked: true };
    }

    this.matches.set(matchId, { ...existing, activityClassification });
    return { matchId, activityClassification, locked: false };
  }

  async setMatchXpEligibility(
    matchId: string,
    xpEligible: boolean
  ): Promise<{ matchId: string; xpEligible: boolean; locked: boolean }> {
    const existing = this.matches.get(matchId);
    if (!existing) throw new MatchNotFoundError();

    const hasPredictions = [...this.predictions.values()].some((p) => p.matchId === matchId);
    const hasResults = [...this.matchResults.values()].some((r) => r.matchId === matchId);

    if (hasPredictions || hasResults) {
      if (existing.xpEligible !== xpEligible) {
        throw new XpEligibilityLockedError();
      }
      return { matchId, xpEligible: existing.xpEligible!, locked: true };
    }

    this.matches.set(matchId, { ...existing, xpEligible });
    return { matchId, xpEligible, locked: false };
  }

  async getMatchById(matchId: string): Promise<MatchRecord | null> {
    return this.matches.get(matchId) ?? null;
  }

  async listMatches(): Promise<MatchRecord[]> {
    return [...this.matches.values()];
  }

  async createVenue(input: {
    name: string;
    latitude: number;
    longitude: number;
    radiusMeters: number;
  }): Promise<VenueRecord> {
    const record: VenueRecord = {
      venueId: randomUUID(),
      name: input.name,
      latitude: input.latitude,
      longitude: input.longitude,
      radiusMeters: input.radiusMeters,
      active: true,
      createdAt: new Date().toISOString(),
    };
    this.venues.set(record.venueId, record);
    return record;
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
    const existing = this.venues.get(venueId);
    if (!existing) throw new Error("Venue not found.");
    const updated = { ...existing, ...input };
    this.venues.set(venueId, updated);
    return updated;
  }

  async getVenueById(venueId: string): Promise<VenueRecord | null> {
    return this.venues.get(venueId) ?? null;
  }

  async listVenues(): Promise<VenueRecord[]> {
    return [...this.venues.values()];
  }

  async createVenueActivation(input: {
    matchId: string;
    venueId: string;
  }): Promise<VenueActivationRecord> {
    const record: VenueActivationRecord = {
      venueActivationId: randomUUID(),
      matchId: input.matchId,
      venueId: input.venueId,
      enabled: true,
      createdAt: new Date().toISOString(),
    };
    this.activations.set(record.venueActivationId, record);
    return record;
  }

  async setVenueActivationEnabled(
    venueActivationId: string,
    enabled: boolean
  ): Promise<VenueActivationRecord> {
    const existing = this.activations.get(venueActivationId);
    if (!existing) throw new VenueActivationNotFoundError();
    const updated = { ...existing, enabled };
    this.activations.set(venueActivationId, updated);
    return updated;
  }

  async getVenueActivationById(
    venueActivationId: string
  ): Promise<VenueActivationRecord | null> {
    return this.activations.get(venueActivationId) ?? null;
  }

  async listVenueActivationsForMatch(matchId: string): Promise<VenueActivationRecord[]> {
    return [...this.activations.values()].filter((a) => a.matchId === matchId);
  }

  async createPrizeTier(input: {
    venueActivationId: string;
    correctDimensionCount: number;
    prizeLabel: string;
  }): Promise<PrizeTierRecord> {
    const record: PrizeTierRecord = {
      prizeTierId: randomUUID(),
      venueActivationId: input.venueActivationId,
      correctDimensionCount: input.correctDimensionCount,
      prizeLabel: input.prizeLabel,
      createdAt: new Date().toISOString(),
    };
    this.prizeTiers.set(record.prizeTierId, record);
    return record;
  }

  async listPrizeTiersForActivation(venueActivationId: string): Promise<PrizeTierRecord[]> {
    return [...this.prizeTiers.values()].filter(
      (t) => t.venueActivationId === venueActivationId
    );
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
    const match = this.matches.get(input.matchId);
    if (!match) throw new MatchNotFoundError();
    if (match.cancelledAt) throw new MatchCancelledError();
    if (match.activityClassification === null) throw new MatchNotClassifiedError();
    if (new Date() >= new Date(match.kickoffAt)) throw new KickoffPassedError();

    const activation = this.activations.get(input.venueActivationId);
    if (!activation) throw new VenueActivationNotFoundError();
    if (activation.matchId !== input.matchId) throw new VenueActivationMatchMismatchError();
    if (!activation.enabled) throw new VenueActivationDisabledError();

    if (!input.geoEligible) throw new GeoNotEligibleError();

    if (input.predictedHomeScore < 0 || input.predictedAwayScore < 0) {
      throw new InvalidPredictionScoreError();
    }

    if (
      input.predictedGoalMinuteRegulation !== null &&
      (input.predictedGoalMinuteRegulation < 1 || input.predictedGoalMinuteRegulation > 90)
    ) {
      throw new InvalidGoalMinuteError();
    }

    if (input.predictedGoalMinuteStoppage !== null && input.predictedGoalMinuteStoppage <= 0) {
      throw new InvalidGoalMinuteError();
    }

    if (
      input.predictedGoalMinuteStoppage !== null &&
      (input.predictedGoalMinuteRegulation === null ||
        (input.predictedGoalMinuteRegulation !== 45 && input.predictedGoalMinuteRegulation !== 90))
    ) {
      throw new InvalidGoalMinuteError();
    }

    if (
      input.predictedFirstTeamToScore !== null &&
      input.predictedFirstTeamToScore !== "HOME" &&
      input.predictedFirstTeamToScore !== "AWAY"
    ) {
      throw new InvalidFirstTeamError();
    }

    if (input.predictedGoalscorerPlayerId !== null) {
      const player = this.players.get(input.predictedGoalscorerPlayerId);
      if (!player) throw new InvalidGoalscorerSelectionError();
      if (player.teamId !== match.homeTeamId && player.teamId !== match.awayTeamId) {
        throw new InvalidGoalscorerSelectionError();
      }
      if (!player.active) throw new InvalidGoalscorerSelectionError();
    }

    const existing = [...this.predictions.values()].find(
      (p) => p.matchId === input.matchId && p.gamingMemberId === input.gamingMemberId
    );

    if (existing && existing.venueActivationId !== input.venueActivationId) {
      throw new VenueActivationImmutableError();
    }

    const now = new Date().toISOString();
    const record: PredictionRecord = {
      predictionId: existing?.predictionId ?? randomUUID(),
      matchId: input.matchId,
      gamingMemberId: input.gamingMemberId,
      venueActivationId: input.venueActivationId,
      predictedHomeScore: input.predictedHomeScore,
      predictedAwayScore: input.predictedAwayScore,
      predictedGoalscorerPlayerId: input.predictedGoalscorerPlayerId,
      predictedGoalMinuteRegulation: input.predictedGoalMinuteRegulation,
      predictedGoalMinuteStoppage: input.predictedGoalMinuteStoppage,
      predictedFirstTeamToScore: input.predictedFirstTeamToScore,
      geoVerifiedAt: input.geoVerifiedAt,
      measuredDistanceMeters: input.measuredDistanceMeters,
      reportedAccuracyMeters: input.reportedAccuracyMeters,
      geoEligible: input.geoEligible,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    this.predictions.set(record.predictionId, record);
    return record;
  }

  async getPredictionForMember(
    matchId: string,
    gamingMemberId: string
  ): Promise<PredictionRecord | null> {
    return (
      [...this.predictions.values()].find(
        (p) => p.matchId === matchId && p.gamingMemberId === gamingMemberId
      ) ?? null
    );
  }

  async listPredictionsForMatch(matchId: string): Promise<PredictionRecord[]> {
    return [...this.predictions.values()].filter((p) => p.matchId === matchId);
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

    let record: MatchResultRecord;
    if (existingDraft) {
      record = { ...existingDraft, homeScore: input.homeScore, awayScore: input.awayScore };
    } else {
      record = {
        matchResultId: randomUUID(),
        matchId: input.matchId,
        homeScore: input.homeScore,
        awayScore: input.awayScore,
        finalizedAt: null,
        supersedesMatchResultId: input.supersedesMatchResultId ?? null,
        enteredByGamingMemberId: input.enteredByGamingMemberId,
        finalizedByGamingMemberId: null,
        createdAt: new Date().toISOString(),
      };
    }
    this.matchResults.set(record.matchResultId, record);

    this.goalEvents.set(
      record.matchResultId,
      input.officialGoalEvents.map((event, index) => ({
        officialGoalEventId: randomUUID(),
        matchResultId: record.matchResultId,
        scorerPlayerId: event.scorerPlayerId,
        minuteRegulation: event.minuteRegulation,
        minuteStoppage: event.minuteStoppage ?? null,
        isOwnGoal: event.isOwnGoal ?? false,
        ordinal: index + 1,
      }))
    );

    return record;
  }

  async getMatchResultById(matchResultId: string): Promise<MatchResultRecord | null> {
    return this.matchResults.get(matchResultId) ?? null;
  }

  async getDraftMatchResult(matchId: string): Promise<MatchResultRecord | null> {
    return (
      [...this.matchResults.values()].find(
        (r) => r.matchId === matchId && r.finalizedAt === null
      ) ?? null
    );
  }

  async getCurrentFinalizedMatchResult(matchId: string): Promise<MatchResultRecord | null> {
    const finalized = [...this.matchResults.values()]
      .filter((r) => r.matchId === matchId && r.finalizedAt !== null)
      .sort((a, b) => (a.finalizedAt! < b.finalizedAt! ? 1 : -1));
    return finalized[0] ?? null;
  }

  async listGoalEventsForResult(matchResultId: string): Promise<OfficialGoalEventRecord[]> {
    return this.goalEvents.get(matchResultId) ?? [];
  }

  /**
   * Predictions-v2 regulation-time eligibility predicate, applied
   * identically everywhere official goal evidence is consulted for
   * settlement: an event is REGULATION-TIME ELIGIBLE iff
   * minuteRegulation is between 1 and 90 inclusive. This correctly
   * includes first-half stoppage (minuteRegulation === 45, any
   * stoppage offset) and second-half stoppage (minuteRegulation ===
   * 90, any stoppage offset) — both remain within 1-90 — while
   * excluding every extra-time event (minuteRegulation 91-120) from
   * all four Prediction dimensions, without removing extra-time
   * events from the official record itself (listGoalEventsForResult
   * still returns them unfiltered; only settlement's own reads apply
   * this predicate). Mirrors 0098's own identical SQL predicate.
   */
  private regulationTimeEligibleGoalEvents(matchResultId: string): OfficialGoalEventRecord[] {
    return (this.goalEvents.get(matchResultId) ?? []).filter(
      (e) => e.minuteRegulation >= 1 && e.minuteRegulation <= 90
    );
  }

  /**
   * Mirrors finalize_match_result_atomically's own once-per-Result-
   * Version facts: the total REGULATION-TIME-ELIGIBLE official goal
   * count, and the chronologically first *eligible* goal's credited
   * Team (HOME/AWAY/NO_GOAL) — ordered by effective elapsed minute,
   * then ordinal as a tiebreaker, exactly as the SQL function orders.
   * An own goal credits the *opposing* Team from the scorer's own
   * Team. An extra-time-only match therefore still correctly derives
   * zero eligible goals / NO_GOAL, exactly as Predictions-v2 requires.
   */
  private deriveOfficialFacts(
    matchId: string,
    matchResultId: string
  ): { goalCount: number; firstTeam: "HOME" | "AWAY" | "NO_GOAL" } {
    const match = this.matches.get(matchId)!;
    const events = this.regulationTimeEligibleGoalEvents(matchResultId).sort((a, b) => {
      const aMinute = a.minuteRegulation + (a.minuteStoppage ?? 0);
      const bMinute = b.minuteRegulation + (b.minuteStoppage ?? 0);
      if (aMinute !== bMinute) return aMinute - bMinute;
      return a.ordinal - b.ordinal;
    });

    if (events.length === 0) {
      return { goalCount: 0, firstTeam: "NO_GOAL" };
    }

    const first = events[0];
    const scorer = this.players.get(first.scorerPlayerId);
    const scorerTeamId = scorer?.teamId;
    let firstTeam: "HOME" | "AWAY";
    if (first.isOwnGoal) {
      firstTeam = scorerTeamId === match.homeTeamId ? "AWAY" : "HOME";
    } else {
      firstTeam = scorerTeamId === match.homeTeamId ? "HOME" : "AWAY";
    }

    return { goalCount: events.length, firstTeam };
  }

  /** Canonical, fixed dimension-key order — never derived from evaluation order. */
  private static readonly DIMENSION_KEY_ORDER = [
    ["scorelineCorrect", "EXACT_SCORELINE"],
    ["goalscorerCorrect", "ANY_GOALSCORER"],
    ["goalMinuteCorrect", "ANY_GOAL_MINUTE"],
    ["firstTeamToScoreCorrect", "FIRST_TEAM_TO_SCORE"],
  ] as const;

  private evaluatePrediction(
    prediction: PredictionRecord,
    result: MatchResultRecord,
    facts: { goalCount: number; firstTeam: "HOME" | "AWAY" | "NO_GOAL" },
    matchResultId: string
  ): {
    scorelineCorrect: boolean;
    goalscorerCorrect: boolean;
    goalMinuteCorrect: boolean;
    firstTeamToScoreCorrect: boolean;
    correctDimensionCount: number;
    correctDimensionKeys: string[];
  } {
    const events = this.regulationTimeEligibleGoalEvents(matchResultId);

    const scorelineCorrect =
      prediction.predictedHomeScore === result.homeScore &&
      prediction.predictedAwayScore === result.awayScore;

    // Own goal does NOT satisfy Any Goalscorer for the player who committed it.
    const goalscorerCorrect =
      prediction.predictedGoalscorerPlayerId === null
        ? facts.goalCount === 0
        : events.some((e) => e.scorerPlayerId === prediction.predictedGoalscorerPlayerId && !e.isOwnGoal);

    // Own goal DOES satisfy Any Goal Minute — it is still a legitimate
    // goal event at its own effective moment. Structural, null-safe
    // tuple comparison — never a summed elapsed-minute integer.
    const goalMinuteCorrect =
      prediction.predictedGoalMinuteRegulation === null
        ? facts.goalCount === 0
        : events.some(
            (e) =>
              e.minuteRegulation === prediction.predictedGoalMinuteRegulation &&
              (e.minuteStoppage ?? null) === (prediction.predictedGoalMinuteStoppage ?? null)
          );

    const firstTeamToScoreCorrect =
      prediction.predictedFirstTeamToScore === null
        ? facts.firstTeam === "NO_GOAL"
        : prediction.predictedFirstTeamToScore === facts.firstTeam;

    const correctDimensionCount =
      Number(scorelineCorrect) +
      Number(goalscorerCorrect) +
      Number(goalMinuteCorrect) +
      Number(firstTeamToScoreCorrect);

    const dimensionFlags: Record<string, boolean> = {
      scorelineCorrect,
      goalscorerCorrect,
      goalMinuteCorrect,
      firstTeamToScoreCorrect,
    };
    const correctDimensionKeys = InMemoryPredictionsRepository.DIMENSION_KEY_ORDER.filter(
      ([flag]) => dimensionFlags[flag]
    ).map(([, key]) => key);

    return {
      scorelineCorrect,
      goalscorerCorrect,
      goalMinuteCorrect,
      firstTeamToScoreCorrect,
      correctDimensionCount,
      correctDimensionKeys,
    };
  }

  private awardProgressionEvent(
    gamingMemberId: string,
    ruleKey: string,
    matchId: string,
    evaluationId: string,
    idempotencyKey: string,
    reversesGamingProgressionEventId: string | null = null,
    explicitPoints: number | null = null
  ): void {
    const alreadyExists = [...this.progressionEvents.values()].some(
      (e) => e.gamingMemberId === gamingMemberId && e.idempotencyKey === idempotencyKey
    );
    if (alreadyExists) {
      return;
    }
    const points = explicitPoints ?? this.progressionRulePoints.get(ruleKey) ?? 0;
    const record: GamingProgressionEventRecord = {
      gamingProgressionEventId: randomUUID(),
      gamingMemberId,
      ruleKey,
      points,
      matchId,
      evaluationId,
      reversesGamingProgressionEventId,
      idempotencyKey,
      createdAt: new Date().toISOString(),
    };
    this.progressionEvents.set(record.gamingProgressionEventId, record);
  }

  async finalizeMatchResult(
    matchResultId: string,
    finalizedByGamingMemberId: string,
    reason: string | null
  ): Promise<{ matchResultId: string; finalizedAt: string; alreadyFinalized: boolean }> {
    const result = this.matchResults.get(matchResultId);
    if (!result) throw new MatchResultNotFoundError();

    // Authority checked before any mutation and before the idempotent-
    // return branch — an unauthorized caller learns nothing about the
    // Result's state, mirroring the RPC's own ordering.
    const hasAuthority = await this.authority.hasActiveAuthority(
      finalizedByGamingMemberId,
      "CONSEQUENTIAL_FINALIZER"
    );
    if (!hasAuthority) throw new InsufficientPlatformAuthorityError("CONSEQUENTIAL_FINALIZER");

    if (result.finalizedAt) {
      return { matchResultId, finalizedAt: result.finalizedAt, alreadyFinalized: true };
    }

    // Checked before any mutation — unlike the SQL implementation
    // (where any later exception rolls back the whole transaction
    // including an earlier write), this in-memory Map has no
    // transactional rollback, so the cancelled-Match guard must run
    // before match_results is touched at all, not merely before this
    // function returns.
    const matchForGuard = this.matches.get(result.matchId)!;
    if (matchForGuard.cancelledAt) throw new MatchCancelledError();

    const finalizedAt = new Date().toISOString();
    this.matchResults.set(matchResultId, {
      ...result,
      finalizedAt,
      finalizedByGamingMemberId,
    });

    this.auditStore.record({
      actionType: "FINALIZE_RESULT",
      actorKind: "GAMING_MEMBER",
      actorId: finalizedByGamingMemberId,
      authorityClassUsed: "CONSEQUENTIAL_FINALIZER",
      targetType: "match_results",
      targetId: matchResultId,
      previousReference: null,
      resultingReference: { table: "match_results", id: matchResultId },
      outcome: "SUCCESS",
      reason,
    });

    const facts = this.deriveOfficialFacts(result.matchId, matchResultId);

    for (const prediction of [...this.predictions.values()].filter(
      (p) => p.matchId === result.matchId
    )) {
      const evaluated = this.evaluatePrediction(prediction, result, facts, matchResultId);

      const evaluation: EvaluationRecord = {
        evaluationId: randomUUID(),
        predictionId: prediction.predictionId,
        matchResultId,
        ...evaluated,
        evaluatedAt: new Date().toISOString(),
      };
      this.evaluations.set(evaluation.evaluationId, evaluation);

      const match = this.matches.get(result.matchId)!;
      const { experienceSummaryId } = await this.metagame.recordExperienceSummary({
        gamingMemberId: prediction.gamingMemberId,
        experienceKey: "SOCCER_PREDICTIONS",
        categoryKey: "SOCCER_PREDICTIONS",
        activityClassification: match.activityClassification!,
        authorityTier: "ADMIN_FINALIZED",
        occurredAt: prediction.createdAt,
        finalizedAt,
        meaningfulParticipation: true,
        performanceBandKey: `CORRECT_${evaluated.correctDimensionCount}_OF_4`,
        sourceReference: evaluation.evaluationId,
        rulesetVersion: "predictions-v2",
        supersedesExperienceSummaryId: null,
        idempotencyKey: evaluation.evaluationId,
        evidence: {
          correctDimensionCount: evaluated.correctDimensionCount,
          scorelineCorrect: evaluated.scorelineCorrect,
          goalscorerCorrect: evaluated.goalscorerCorrect,
          goalMinuteCorrect: evaluated.goalMinuteCorrect,
          firstTeamCorrect: evaluated.firstTeamToScoreCorrect,
        },
        correctDimensionCount: evaluated.correctDimensionCount,
        correctDimensionKeys: evaluated.correctDimensionKeys,
        xpEligible: match.xpEligible ?? false,
      });
      await this.metagame.processExperienceSummaryConsequences(experienceSummaryId);

      const tier = [...this.prizeTiers.values()].find(
        (t) =>
          t.venueActivationId === prediction.venueActivationId &&
          t.correctDimensionCount === evaluated.correctDimensionCount
      );
      if (tier) {
        const qualification: PrizeQualificationRecord = {
          prizeQualificationId: randomUUID(),
          evaluationId: evaluation.evaluationId,
          gamingMemberId: prediction.gamingMemberId,
          venueActivationId: prediction.venueActivationId,
          prizeTierId: tier.prizeTierId,
          redeemedAt: null,
          redeemedByGamingMemberId: null,
          supersededAt: null,
          createdAt: new Date().toISOString(),
        };
        this.qualifications.set(qualification.prizeQualificationId, qualification);
      }
    }

    return { matchResultId, finalizedAt, alreadyFinalized: false };
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
    if (!reason || reason.trim().length === 0) throw new ReasonRequiredError();

    const result = this.matchResults.get(matchResultId);
    if (!result) throw new MatchResultNotFoundError();
    if (!result.supersedesMatchResultId) throw new NotACorrectionError();

    const hasAuthority = await this.authority.hasActiveAuthority(
      finalizedByGamingMemberId,
      "CONSEQUENTIAL_FINALIZER"
    );
    if (!hasAuthority) throw new InsufficientPlatformAuthorityError("CONSEQUENTIAL_FINALIZER");

    if (result.finalizedAt) {
      return {
        matchResultId,
        finalizedAt: result.finalizedAt,
        supersedesMatchResultId: result.supersedesMatchResultId,
        alreadyFinalized: true,
      };
    }

    const supersedes = this.matchResults.get(result.supersedesMatchResultId);
    if (!supersedes || !supersedes.finalizedAt) {
      throw new SupersededResultNotFinalizedError();
    }

    // Checked before any mutation — same reasoning as
    // finalizeMatchResult: a cancelled Match may not produce a
    // settlement via correction either.
    const matchForGuard = this.matches.get(result.matchId)!;
    if (matchForGuard.cancelledAt) throw new MatchCancelledError();

    const finalizedAt = new Date().toISOString();
    const supersedesMatchResultId = result.supersedesMatchResultId;
    this.matchResults.set(matchResultId, {
      ...result,
      finalizedAt,
      finalizedByGamingMemberId,
    });

    this.auditStore.record({
      actionType: "CORRECT_RESULT",
      actorKind: "GAMING_MEMBER",
      actorId: finalizedByGamingMemberId,
      authorityClassUsed: "CONSEQUENTIAL_FINALIZER",
      targetType: "match_results",
      targetId: matchResultId,
      previousReference: { table: "match_results", id: supersedesMatchResultId },
      resultingReference: { table: "match_results", id: matchResultId },
      outcome: "SUCCESS",
      reason,
    });

    const facts = this.deriveOfficialFacts(result.matchId, matchResultId);

    for (const prediction of [...this.predictions.values()].filter(
      (p) => p.matchId === result.matchId
    )) {
      const oldEvaluation = [...this.evaluations.values()].find(
        (e) =>
          e.predictionId === prediction.predictionId &&
          e.matchResultId === result.supersedesMatchResultId
      );

      const evaluated = this.evaluatePrediction(prediction, result, facts, matchResultId);

      const newEvaluation: EvaluationRecord = {
        evaluationId: randomUUID(),
        predictionId: prediction.predictionId,
        matchResultId,
        ...evaluated,
        evaluatedAt: new Date().toISOString(),
      };
      this.evaluations.set(newEvaluation.evaluationId, newEvaluation);

      const match = this.matches.get(result.matchId)!;
      const oldExperienceSummary = oldEvaluation
        ? await this.metagame.getExperienceSummaryByIdempotencyKey("SOCCER_PREDICTIONS", oldEvaluation.evaluationId)
        : null;

      const { experienceSummaryId: newExperienceSummaryId } = await this.metagame.recordExperienceSummary({
        gamingMemberId: prediction.gamingMemberId,
        experienceKey: "SOCCER_PREDICTIONS",
        categoryKey: "SOCCER_PREDICTIONS",
        activityClassification: match.activityClassification!,
        authorityTier: "ADMIN_FINALIZED",
        occurredAt: prediction.createdAt,
        finalizedAt,
        meaningfulParticipation: true,
        performanceBandKey: `CORRECT_${evaluated.correctDimensionCount}_OF_4`,
        sourceReference: newEvaluation.evaluationId,
        rulesetVersion: "predictions-v2",
        supersedesExperienceSummaryId: oldExperienceSummary?.experienceSummaryId ?? null,
        idempotencyKey: newEvaluation.evaluationId,
        evidence: {
          correctDimensionCount: evaluated.correctDimensionCount,
          scorelineCorrect: evaluated.scorelineCorrect,
          goalscorerCorrect: evaluated.goalscorerCorrect,
          goalMinuteCorrect: evaluated.goalMinuteCorrect,
          firstTeamCorrect: evaluated.firstTeamToScoreCorrect,
          correction: true,
        },
        correctDimensionCount: evaluated.correctDimensionCount,
        correctDimensionKeys: evaluated.correctDimensionKeys,
        xpEligible: match.xpEligible ?? false,
      });
      await this.metagame.processExperienceSummaryConsequences(newExperienceSummaryId);

      if (oldEvaluation) {
        const oldQualification = [...this.qualifications.values()].find(
          (q) => q.evaluationId === oldEvaluation.evaluationId && !q.supersededAt
        );
        if (oldQualification) {
          this.qualifications.set(oldQualification.prizeQualificationId, {
            ...oldQualification,
            supersededAt: new Date().toISOString(),
          });
        }
      }

      const newTier = [...this.prizeTiers.values()].find(
        (t) =>
          t.venueActivationId === prediction.venueActivationId &&
          t.correctDimensionCount === evaluated.correctDimensionCount
      );
      if (newTier) {
        const qualification: PrizeQualificationRecord = {
          prizeQualificationId: randomUUID(),
          evaluationId: newEvaluation.evaluationId,
          gamingMemberId: prediction.gamingMemberId,
          venueActivationId: prediction.venueActivationId,
          prizeTierId: newTier.prizeTierId,
          redeemedAt: null,
          redeemedByGamingMemberId: null,
          supersededAt: null,
          createdAt: new Date().toISOString(),
        };
        this.qualifications.set(qualification.prizeQualificationId, qualification);
      }
    }

    return {
      matchResultId,
      finalizedAt,
      supersedesMatchResultId: result.supersedesMatchResultId,
      alreadyFinalized: false,
    };
  }

  async getEvaluation(
    predictionId: string,
    matchResultId: string
  ): Promise<EvaluationRecord | null> {
    return (
      [...this.evaluations.values()].find(
        (e) => e.predictionId === predictionId && e.matchResultId === matchResultId
      ) ?? null
    );
  }

  async getCurrentEvaluationForPrediction(
    predictionId: string
  ): Promise<EvaluationRecord | null> {
    const matches = [...this.evaluations.values()]
      .filter((e) => e.predictionId === predictionId)
      .sort((a, b) => (a.evaluatedAt < b.evaluatedAt ? 1 : -1));
    return matches[0] ?? null;
  }

  async listProgressionEventsForMember(
    gamingMemberId: string
  ): Promise<GamingProgressionEventRecord[]> {
    return [...this.progressionEvents.values()].filter(
      (e) => e.gamingMemberId === gamingMemberId
    );
  }

  async getLeaderboard(): Promise<LeaderboardEntry[]> {
    const totals = new Map<string, number>();
    for (const event of this.progressionEvents.values()) {
      totals.set(event.gamingMemberId, (totals.get(event.gamingMemberId) ?? 0) + event.points);
    }
    return [...totals.entries()]
      .map(([gamingMemberId, totalPoints]) => ({
        gamingMemberId,
        displayName: "Unknown",
        totalPoints,
      }))
      .sort((a, b) => b.totalPoints - a.totalPoints);
  }

  async getQualificationForEvaluation(
    evaluationId: string
  ): Promise<PrizeQualificationRecord | null> {
    return (
      [...this.qualifications.values()].find((q) => q.evaluationId === evaluationId) ?? null
    );
  }

  async listQualificationsForMember(
    gamingMemberId: string
  ): Promise<PrizeQualificationRecord[]> {
    return [...this.qualifications.values()].filter((q) => q.gamingMemberId === gamingMemberId);
  }

  async listQualificationsForActivation(
    venueActivationId: string
  ): Promise<PrizeQualificationRecord[]> {
    return [...this.qualifications.values()].filter(
      (q) => q.venueActivationId === venueActivationId
    );
  }

  async redeemPrizeQualification(
    prizeQualificationId: string,
    redeemedByGamingMemberId: string
  ): Promise<{ prizeQualificationId: string; redeemedAt: string; alreadyRedeemed: boolean }> {
    const existing = this.qualifications.get(prizeQualificationId);
    if (!existing) throw new PrizeQualificationNotFoundError();
    if (existing.redeemedAt) {
      return { prizeQualificationId, redeemedAt: existing.redeemedAt, alreadyRedeemed: true };
    }
    if (existing.supersededAt) throw new QualificationSupersededError();

    const redeemedAt = new Date().toISOString();
    this.qualifications.set(prizeQualificationId, {
      ...existing,
      redeemedAt,
      redeemedByGamingMemberId,
    });
    return { prizeQualificationId, redeemedAt, alreadyRedeemed: false };
  }
}
