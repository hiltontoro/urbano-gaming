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
import {
  LEGACY_PREDICTION_CONTRACT,
  PROGRESSIVE_PREDICTION_CONTRACT,
  attemptedLevelOf,
  categoryOutcome,
  computeLadderOffer,
  hitCountOf,
  parseProgressiveAnswers,
  assertCoherentAnswers,
  progressiveColumnsOf,
  wonLevelOf,
  type ProgressiveAnswers,
} from "../prizeLadder";
import { attachQualificationDetails } from "../qualificationDetails";
import {
  assertPrizeQualificationShape,
  decideCorrectionPrize,
  lineageOrdinalOf,
  type DeliveredEntitlement,
} from "../deliveryPolicy";
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
  ResultAlreadyBeingCorrectedError,
  MatchResultBaseRequiredError,
  MatchResultBaseStaleError,
  MatchResultDigestRequiredError,
  MatchResultDigestMismatchError,
  InvalidMatchResultEventsError,
  MatchResultIsCorrectionError,
  PrizeQualificationHeldError,
  PrizeAlreadyFulfilledError,
  PrizeQualificationNotHeldError,
  ContractMismatchError,
  ContractFrozenError,
  LevelNotOfferedError,
  OfferNotAvailableError,
  OfferChangedError,
  OfferDigestRequiredError,
  OfferFrozenError,
  ResultAlreadyFinalizedError,
  TierKeyContractMismatchError,
  InvalidPrizeTierLadderLevelError,
} from "../types";
import {
  assertMatchResultIntegrity,
  compareGoalEventsChronologically,
  computeMatchResultContentDigest,
  saveBaseToken,
  validateGoalEventInputs,
  validateResultScores,
} from "../resultIntegrity";

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
  private memberDisplayNames = new Map<string, string>();
  /**
   * Mirrors the per-match transaction lock the Postgres functions take:
   * every mutation of result and entitlement state runs one at a time,
   * and re-reads state only after it holds its turn.
   */
  private lockChain: Promise<unknown> = Promise.resolve();
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.lockChain.then(work, work);
    this.lockChain = run.catch(() => undefined);
    return run;
  }
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

  /** Test-only seam: this repository owns no Gaming Member store, so display names are seeded. */
  setMemberDisplayName(gamingMemberId: string, displayName: string): void {
    this.memberDisplayNames.set(gamingMemberId, displayName);
  }

  /**
   * Test-only seam: edit a prize definition after the fact. The database
   * allows the same edit (prize_tiers is plain data), so a correction
   * must not mistake an edited prize for an unchanged one.
   */
  setPrizeLabelForTests(prizeTierId: string, prizeLabel: string): void {
    const tier = this.prizeTiers.get(prizeTierId);
    if (!tier) throw new Error(`No prize tier ${prizeTierId}`);
    // The database refuses the same edit once participants have accepted
    // a progressive offer (prize_tiers_offer_guard).
    this.assertOfferNotFrozen(tier.venueActivationId);
    this.prizeTiers.set(prizeTierId, { ...tier, prizeLabel });
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

  /**
   * Seeds the roster fields of a player (squad number, position, provenance). It is NOT on the repository interface: in the real system only
   * the local roster loader writes those columns, so this exists for the behavioural tests alone.
   */
  setRosterFields(
    playerId: string,
    fields: { jerseyNumber: number | null; position: PlayerRecord["position"]; rosterSource?: string | null; rosterConsultedOn?: string | null }
  ): PlayerRecord {
    const record = this.players.get(playerId);
    if (!record) throw new Error(`Unknown player ${playerId}`);
    const next: PlayerRecord = { ...record, ...fields, rosterSource: fields.rosterSource ?? null, rosterConsultedOn: fields.rosterConsultedOn ?? null };
    this.players.set(playerId, next);
    return next;
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
    predictionContract?: PredictionContract;
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
      predictionContract: input.predictionContract ?? LEGACY_PREDICTION_CONTRACT,
      createdAt: new Date().toISOString(),
    };
    this.matches.set(record.matchId, record);
    return record;
  }

  /**
   * The database's matches_contract_freeze trigger: the contract is frozen
   * from the first prediction or the first result (draft or finalized).
   */
  async setMatchPredictionContract(
    matchId: string,
    predictionContract: PredictionContract
  ): Promise<MatchRecord> {
    const existing = this.matches.get(matchId);
    if (!existing) throw new MatchNotFoundError();
    if (existing.predictionContract === predictionContract) return existing;
    const hasPrediction = [...this.predictions.values()].some((p) => p.matchId === matchId);
    const hasResult = [...this.matchResults.values()].some((r) => r.matchId === matchId);
    if (hasPrediction || hasResult) throw new ContractFrozenError();
    const updated = { ...existing, predictionContract };
    this.matches.set(matchId, updated);
    return updated;
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
    activityClassification: "TRAINING" | "CASUAL" | "RANKED" | "OFFICIAL",
    actorGamingMemberId: string,
    reason: string | null
  ): Promise<{ matchId: string; activityClassification: string; locked: boolean }> {
    const existing = this.matches.get(matchId);
    if (!existing) throw new MatchNotFoundError();

    const hasAuthority = await this.authority.hasActiveAuthority(actorGamingMemberId, "CONSEQUENTIAL_FINALIZER");
    if (!hasAuthority) throw new InsufficientPlatformAuthorityError("CONSEQUENTIAL_FINALIZER");

    const hasPredictions = [...this.predictions.values()].some((p) => p.matchId === matchId);
    const hasResults = [...this.matchResults.values()].some((r) => r.matchId === matchId);

    if (hasPredictions || hasResults) {
      if (existing.activityClassification !== activityClassification) {
        throw new ActivityClassificationLockedError();
      }
      return { matchId, activityClassification: existing.activityClassification!, locked: true };
    }

    this.matches.set(matchId, { ...existing, activityClassification });

    this.auditStore.record({
      actionType: "DECLARE_ACTIVITY_CLASSIFICATION",
      actorKind: "GAMING_MEMBER",
      actorId: actorGamingMemberId,
      authorityClassUsed: "CONSEQUENTIAL_FINALIZER",
      targetType: "matches",
      targetId: matchId,
      previousReference: null,
      resultingReference: { table: "matches", id: matchId },
      outcome: "SUCCESS",
      reason,
    });

    return { matchId, activityClassification, locked: false };
  }

  async setMatchXpEligibility(
    matchId: string,
    xpEligible: boolean,
    actorGamingMemberId: string,
    reason: string | null
  ): Promise<{ matchId: string; xpEligible: boolean; locked: boolean }> {
    const existing = this.matches.get(matchId);
    if (!existing) throw new MatchNotFoundError();

    const hasAuthority = await this.authority.hasActiveAuthority(actorGamingMemberId, "CONSEQUENTIAL_FINALIZER");
    if (!hasAuthority) throw new InsufficientPlatformAuthorityError("CONSEQUENTIAL_FINALIZER");

    const hasPredictions = [...this.predictions.values()].some((p) => p.matchId === matchId);
    const hasResults = [...this.matchResults.values()].some((r) => r.matchId === matchId);

    if (hasPredictions || hasResults) {
      if (existing.xpEligible !== xpEligible) {
        throw new XpEligibilityLockedError();
      }
      return { matchId, xpEligible: existing.xpEligible!, locked: true };
    }

    this.matches.set(matchId, { ...existing, xpEligible });

    this.auditStore.record({
      actionType: "DECLARE_XP_ELIGIBILITY",
      actorKind: "GAMING_MEMBER",
      actorId: actorGamingMemberId,
      authorityClassUsed: "CONSEQUENTIAL_FINALIZER",
      targetType: "matches",
      targetId: matchId,
      previousReference: null,
      resultingReference: { table: "matches", id: matchId },
      outcome: "SUCCESS",
      reason,
    });

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
    // A count-keyed tier belongs to a COMPLETE_COUNT_V1 Match only.
    if (this.contractOfActivation(input.venueActivationId) === PROGRESSIVE_PREDICTION_CONTRACT) {
      throw new TierKeyContractMismatchError();
    }
    const record: PrizeTierRecord = {
      prizeTierId: randomUUID(),
      venueActivationId: input.venueActivationId,
      correctDimensionCount: input.correctDimensionCount,
      ladderLevel: null,
      prizeLabel: input.prizeLabel,
      createdAt: new Date().toISOString(),
    };
    this.prizeTiers.set(record.prizeTierId, record);
    return record;
  }

  async createLadderPrizeTier(input: {
    venueActivationId: string;
    ladderLevel: number;
    prizeLabel: string;
  }): Promise<PrizeTierRecord> {
    if (!Number.isInteger(input.ladderLevel) || input.ladderLevel < 1 || input.ladderLevel > 4) {
      throw new InvalidPrizeTierLadderLevelError();
    }
    if (this.contractOfActivation(input.venueActivationId) !== PROGRESSIVE_PREDICTION_CONTRACT) {
      throw new TierKeyContractMismatchError();
    }
    this.assertOfferNotFrozen(input.venueActivationId);
    const clash = [...this.prizeTiers.values()].some(
      (t) => t.venueActivationId === input.venueActivationId && t.ladderLevel === input.ladderLevel
    );
    if (clash) throw new Error("prize_tiers_activation_ladder_level_key violated");
    const record: PrizeTierRecord = {
      prizeTierId: randomUUID(),
      venueActivationId: input.venueActivationId,
      correctDimensionCount: null,
      ladderLevel: input.ladderLevel,
      prizeLabel: input.prizeLabel,
      createdAt: new Date().toISOString(),
    };
    this.prizeTiers.set(record.prizeTierId, record);
    return record;
  }

  private contractOfActivation(venueActivationId: string): PredictionContract | null {
    const activation = this.activations.get(venueActivationId);
    if (!activation) return null;
    return this.matches.get(activation.matchId)?.predictionContract ?? null;
  }

  /** prize_tiers_offer_guard: a progressive offer cannot change once any prediction exists for the activation. */
  private assertOfferNotFrozen(venueActivationId: string): void {
    if (this.contractOfActivation(venueActivationId) !== PROGRESSIVE_PREDICTION_CONTRACT) return;
    const accepted = [...this.predictions.values()].some((p) => p.venueActivationId === venueActivationId);
    if (accepted) throw new OfferFrozenError();
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
    // The historical write path writes the historical contract only: a progressive Match is refused first, whether the call would
    // create a prediction or edit one (upsert_prediction_atomically, which the database function now does in the same place).
    if (match.predictionContract !== LEGACY_PREDICTION_CONTRACT) throw new ContractMismatchError();
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

    // The database's predictions_guard trigger, which also covers this
    // historical path: no prediction is created or edited once a result
    // is finalized (the contract was already checked above).
    this.assertNoFinalizedResult(input.matchId);

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
      predictionContract: LEGACY_PREDICTION_CONTRACT,
      firstTeamState: null,
      goalscorerState: null,
      goalMinuteState: null,
      attemptedLevel: null,
      acceptedOfferDigest: null,
      acceptedOfferMaxLevel: null,
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

  private assertNoFinalizedResult(matchId: string): void {
    const finalized = [...this.matchResults.values()].some(
      (r) => r.matchId === matchId && r.finalizedAt !== null
    );
    if (finalized) throw new ResultAlreadyFinalizedError();
  }

  /**
   * The request already accepted for this member and match, if this call is exactly it: same venue activation, same answers (every
   * category's state and value) and the same offer fingerprint. Geolocation is not part of it. A request that cannot be parsed is not
   * a replay (it falls through to the checks that refuse it).
   */
  private findExactReplay(input: { matchId: string; gamingMemberId: string; venueActivationId: string; answers: ProgressiveAnswers; offerDigest: string | null }): PredictionRecord | null {
    const existing = [...this.predictions.values()].find((p) => p.matchId === input.matchId && p.gamingMemberId === input.gamingMemberId);
    if (!existing || existing.predictionContract !== PROGRESSIVE_PREDICTION_CONTRACT) return null;
    if (existing.venueActivationId !== input.venueActivationId) return null;
    if (typeof input.offerDigest !== "string" || input.offerDigest.length === 0 || existing.acceptedOfferDigest !== input.offerDigest) return null;
    let answers: ProgressiveAnswers;
    try {
      answers = parseProgressiveAnswers(input.answers);
    } catch {
      return null;
    }
    const columns = progressiveColumnsOf(answers);
    const same =
      existing.attemptedLevel === answers.attemptedLevel &&
      existing.predictedHomeScore === answers.scoreline.home &&
      existing.predictedAwayScore === answers.scoreline.away &&
      existing.firstTeamState === columns.firstTeamState &&
      existing.predictedFirstTeamToScore === columns.firstTeam &&
      existing.goalscorerState === columns.goalscorerState &&
      existing.predictedGoalscorerPlayerId === columns.goalscorerPlayerId &&
      existing.goalMinuteState === columns.goalMinuteState &&
      existing.predictedGoalMinuteRegulation === columns.goalMinuteRegulation &&
      existing.predictedGoalMinuteStoppage === columns.goalMinuteStoppage;
    return same ? existing : null;
  }

  /**
   * upsert_progressive_prediction_atomically. Validation order is the
   * function's: match exists, contract, then an exact replay of the
   * accepted request (returned as stored, nothing written), then match
   * state (cancelled, kickoff), finalized result, activation,
   * geolocation, shape, offer, roster, and last the stored row —
   * replaced whole, so a lower attempted level leaves no higher answer
   * behind.
   */
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
    const match = this.matches.get(input.matchId);
    if (!match) throw new MatchNotFoundError();
    if (match.predictionContract !== PROGRESSIVE_PREDICTION_CONTRACT) throw new ContractMismatchError();
    // An exact replay of the accepted request changes nothing, so it is returned as stored (no new updatedAt, no new geolocation
    // evidence) before the checks that close a match: nothing that happened since can refuse it. Anything different is an edit.
    const replay = this.findExactReplay(input);
    if (replay) return replay;
    if (match.cancelledAt) throw new MatchCancelledError();
    if (match.activityClassification === null) throw new MatchNotClassifiedError();
    if (new Date() >= new Date(match.kickoffAt)) throw new KickoffPassedError();
    this.assertNoFinalizedResult(input.matchId);

    const activation = this.activations.get(input.venueActivationId);
    if (!activation) throw new VenueActivationNotFoundError();
    if (activation.matchId !== input.matchId) throw new VenueActivationMatchMismatchError();
    if (!activation.enabled) throw new VenueActivationDisabledError();

    if (!input.geoEligible) throw new GeoNotEligibleError();

    // Re-validated here, not trusted from the caller: this is the layer
    // the SQL function mirrors.
    const answers = parseProgressiveAnswers(input.answers);

    const offer = computeLadderOffer(
      [...this.prizeTiers.values()].filter((t) => t.venueActivationId === input.venueActivationId)
    );
    if (!offer.available) throw new OfferNotAvailableError();
    if (answers.attemptedLevel > offer.maxLevel) throw new LevelNotOfferedError();
    if (typeof input.offerDigest !== "string" || input.offerDigest.length === 0) throw new OfferDigestRequiredError();
    if (input.offerDigest !== offer.digest) throw new OfferChangedError();

    if (answers.goalscorer !== undefined && answers.goalscorer.kind === "PICKED") {
      const player = this.players.get(answers.goalscorer.playerId);
      if (!player) throw new InvalidGoalscorerSelectionError();
      if (player.teamId !== match.homeTeamId && player.teamId !== match.awayTeamId) {
        throw new InvalidGoalscorerSelectionError();
      }
      if (!player.active) throw new InvalidGoalscorerSelectionError();
    }

    // Coherence between the answers (a new answer or an edit; an exact replay returned above). Mirrors the database function.
    assertCoherentAnswers(
      answers,
      answers.goalscorer !== undefined && answers.goalscorer.kind === "PICKED"
        ? this.players.get(answers.goalscorer.playerId)!.teamId === match.homeTeamId
          ? "HOME"
          : "AWAY"
        : null
    );

    const existing = [...this.predictions.values()].find(
      (p) => p.matchId === input.matchId && p.gamingMemberId === input.gamingMemberId
    );
    if (existing && existing.venueActivationId !== input.venueActivationId) {
      throw new VenueActivationImmutableError();
    }

    const columns = progressiveColumnsOf(answers);
    const now = new Date().toISOString();
    const record: PredictionRecord = {
      predictionId: existing?.predictionId ?? randomUUID(),
      matchId: input.matchId,
      gamingMemberId: input.gamingMemberId,
      venueActivationId: input.venueActivationId,
      predictedHomeScore: answers.scoreline.home,
      predictedAwayScore: answers.scoreline.away,
      predictedGoalscorerPlayerId: columns.goalscorerPlayerId,
      predictedGoalMinuteRegulation: columns.goalMinuteRegulation,
      predictedGoalMinuteStoppage: columns.goalMinuteStoppage,
      predictedFirstTeamToScore: columns.firstTeam,
      predictionContract: PROGRESSIVE_PREDICTION_CONTRACT,
      firstTeamState: columns.firstTeamState,
      goalscorerState: columns.goalscorerState,
      goalMinuteState: columns.goalMinuteState,
      attemptedLevel: attemptedLevelOf(columns),
      acceptedOfferDigest: offer.digest,
      acceptedOfferMaxLevel: offer.maxLevel,
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

  async listPredictionsForMember(gamingMemberId: string, limit = 50): Promise<PredictionRecord[]> {
    return [...this.predictions.values()]
      .filter((p) => p.gamingMemberId === gamingMemberId)
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .slice(0, Math.max(1, Math.min(limit, 200)));
  }

  // Batch reads for a member's history (see the interface): the same records the single reads return, for a list of ids.
  async getMatchesByIds(matchIds: string[]): Promise<MatchRecord[]> {
    return [...new Set(matchIds)].map((id) => this.matches.get(id)).filter((record): record is MatchRecord => record !== undefined);
  }

  async getTeamsByIds(teamIds: string[]): Promise<TeamRecord[]> {
    return [...new Set(teamIds)].map((id) => this.teams.get(id)).filter((record): record is TeamRecord => record !== undefined);
  }

  async getPlayersByIds(playerIds: string[]): Promise<PlayerRecord[]> {
    return [...new Set(playerIds)].map((id) => this.players.get(id)).filter((record): record is PlayerRecord => record !== undefined);
  }

  async getVenueActivationsByIds(venueActivationIds: string[]): Promise<VenueActivationRecord[]> {
    return [...new Set(venueActivationIds)].map((id) => this.activations.get(id)).filter((record): record is VenueActivationRecord => record !== undefined);
  }

  async getVenuesByIds(venueIds: string[]): Promise<VenueRecord[]> {
    return [...new Set(venueIds)].map((id) => this.venues.get(id)).filter((record): record is VenueRecord => record !== undefined);
  }

  async listPrizeTiersForActivations(venueActivationIds: string[]): Promise<PrizeTierRecord[]> {
    const wanted = new Set(venueActivationIds);
    return [...this.prizeTiers.values()].filter((tier) => wanted.has(tier.venueActivationId));
  }

  async getCurrentEvaluationsForPredictions(predictionIds: string[]): Promise<EvaluationRecord[]> {
    const found: EvaluationRecord[] = [];
    for (const id of new Set(predictionIds)) {
      const current = await this.getCurrentEvaluationForPrediction(id);
      if (current) found.push(current);
    }
    return found;
  }

  async saveDraftMatchResult(input: {
    matchId: string;
    homeScore: number;
    awayScore: number;
    officialGoalEvents: OfficialGoalEventInput[];
    enteredByGamingMemberId: string;
    saveBase: string;
  }): Promise<SavedMatchResult> {
    return this.serialize(async () => {
      if (typeof input.saveBase !== "string" || input.saveBase.trim().length === 0) {
        throw new MatchResultBaseRequiredError();
      }
      validateResultScores(input.homeScore, input.awayScore);
      if (!Array.isArray(input.officialGoalEvents)) {
        throw new InvalidMatchResultEventsError("Official goal events must be a list.");
      }

      const match = this.matches.get(input.matchId);
      if (!match) throw new MatchNotFoundError();

      // Initial draft vs correction is decided here, from the
      // supersession chain, under the same turn finalize/correct take.
      const currentFinalized = this.currentFinalizedFor(input.matchId);
      const draft =
        [...this.matchResults.values()].find(
          (r) => r.matchId === input.matchId && r.finalizedAt === null
        ) ?? null;
      const supersedes = currentFinalized?.matchResultId ?? null;
      if (draft && draft.supersedesMatchResultId !== supersedes) {
        throw new ResultAlreadyBeingCorrectedError();
      }

      const expectedBase = saveBaseToken({
        draftDigest: draft ? this.digestFor(draft.matchResultId) : null,
        finalizedDigest: currentFinalized ? this.digestFor(currentFinalized.matchResultId) : null,
      });
      if (input.saveBase !== expectedBase) throw new MatchResultBaseStaleError();

      validateGoalEventInputs(input.officialGoalEvents);

      // Build the candidate, validate it, and only then commit: a
      // rejected save leaves the prior draft exactly as it was.
      const record: MatchResultRecord = draft
        ? { ...draft, homeScore: input.homeScore, awayScore: input.awayScore }
        : {
            matchResultId: randomUUID(),
            matchId: input.matchId,
            homeScore: input.homeScore,
            awayScore: input.awayScore,
            finalizedAt: null,
            supersedesMatchResultId: supersedes,
            enteredByGamingMemberId: input.enteredByGamingMemberId,
            finalizedByGamingMemberId: null,
            createdAt: new Date().toISOString(),
          };
      const events: OfficialGoalEventRecord[] = input.officialGoalEvents.map((event, index) => ({
        officialGoalEventId: randomUUID(),
        matchResultId: record.matchResultId,
        scorerPlayerId: event.scorerPlayerId,
        minuteRegulation: event.minuteRegulation,
        minuteStoppage: event.minuteStoppage ?? null,
        isOwnGoal: event.isOwnGoal ?? false,
        ordinal: index + 1,
      }));

      assertMatchResultIntegrity({
        homeTeamId: match.homeTeamId,
        awayTeamId: match.awayTeamId,
        homeScore: record.homeScore,
        awayScore: record.awayScore,
        events,
        teamOfPlayer: (playerId) => this.players.get(playerId)?.teamId ?? null,
      });

      this.matchResults.set(record.matchResultId, record);
      this.goalEvents.set(record.matchResultId, events);

      return {
        ...record,
        contentDigest: this.digestFor(record.matchResultId),
        isCorrection: supersedes !== null,
      };
    });
  }

  /** The finalized result no other finalized result supersedes. */
  private currentFinalizedFor(matchId: string): MatchResultRecord | null {
    const finalized = [...this.matchResults.values()].filter(
      (r) => r.matchId === matchId && r.finalizedAt !== null
    );
    return (
      finalized.find(
        (candidate) => !finalized.some((other) => other.supersedesMatchResultId === candidate.matchResultId)
      ) ?? null
    );
  }

  private digestFor(matchResultId: string): string {
    const result = this.matchResults.get(matchResultId)!;
    const match = this.matches.get(result.matchId)!;
    return computeMatchResultContentDigest({
      matchResultId,
      matchId: result.matchId,
      homeTeamId: match.homeTeamId,
      awayTeamId: match.awayTeamId,
      homeScore: result.homeScore,
      awayScore: result.awayScore,
      supersedesMatchResultId: result.supersedesMatchResultId,
      events: this.goalEvents.get(matchResultId) ?? [],
    });
  }

  async getMatchResultContentDigest(matchResultId: string): Promise<string | null> {
    return this.matchResults.has(matchResultId) ? this.digestFor(matchResultId) : null;
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
    return this.currentFinalizedFor(matchId);
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
    // (minute, stoppage, entry order): summing minute + stoppage would tie
    // first-half stoppage 45+10 with ordinary minute 55.
    const events = this.regulationTimeEligibleGoalEvents(matchResultId).sort(
      compareGoalEventsChronologically
    );

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
    predictionContract: PredictionContract;
    scorelineCorrect: boolean;
    goalscorerCorrect: boolean | null;
    goalMinuteCorrect: boolean | null;
    firstTeamToScoreCorrect: boolean | null;
    correctDimensionCount: number;
    correctDimensionKeys: string[];
    attemptedLevel: number | null;
    ladderLevel: number | null;
  } {
    const events = this.regulationTimeEligibleGoalEvents(matchResultId);

    const scorelineCorrect =
      prediction.predictedHomeScore === result.homeScore &&
      prediction.predictedAwayScore === result.awayScore;

    if (prediction.predictionContract === PROGRESSIVE_PREDICTION_CONTRACT) {
      // A category that was NOT attempted has no outcome (null) and stops
      // the ladder; NONE is an answer, correct exactly when there were no
      // regulation goals; PICKED is compared. State is read, never a null.
      const goalscorerCorrect = categoryOutcome(
        prediction.goalscorerState!,
        events.some((e) => e.scorerPlayerId === prediction.predictedGoalscorerPlayerId && !e.isOwnGoal),
        facts.goalCount
      );
      const goalMinuteCorrect = categoryOutcome(
        prediction.goalMinuteState!,
        events.some(
          (e) =>
            e.minuteRegulation === prediction.predictedGoalMinuteRegulation &&
            (e.minuteStoppage ?? null) === (prediction.predictedGoalMinuteStoppage ?? null)
        ),
        facts.goalCount
      );
      const firstTeamToScoreCorrect =
        prediction.firstTeamState === "NOT_ATTEMPTED"
          ? null
          : prediction.firstTeamState === "NONE"
            ? facts.firstTeam === "NO_GOAL"
            : prediction.predictedFirstTeamToScore === facts.firstTeam;
      const outcomes = {
        scoreline: scorelineCorrect,
        firstTeam: firstTeamToScoreCorrect,
        goalscorer: goalscorerCorrect,
        goalMinute: goalMinuteCorrect,
      };
      const flags: Record<string, boolean | null> = {
        scorelineCorrect,
        goalscorerCorrect,
        goalMinuteCorrect,
        firstTeamToScoreCorrect,
      };
      return {
        predictionContract: PROGRESSIVE_PREDICTION_CONTRACT,
        scorelineCorrect,
        goalscorerCorrect,
        goalMinuteCorrect,
        firstTeamToScoreCorrect,
        correctDimensionCount: hitCountOf(outcomes),
        correctDimensionKeys: InMemoryPredictionsRepository.DIMENSION_KEY_ORDER.filter(([flag]) => flags[flag] === true).map(
          ([, key]) => key
        ),
        attemptedLevel: prediction.attemptedLevel,
        ladderLevel: wonLevelOf(outcomes),
      };
    }

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
      predictionContract: LEGACY_PREDICTION_CONTRACT,
      scorelineCorrect,
      goalscorerCorrect,
      goalMinuteCorrect,
      firstTeamToScoreCorrect,
      correctDimensionCount,
      correctDimensionKeys,
      attemptedLevel: null,
      ladderLevel: null,
    };
  }

  /**
   * The prize tier an evaluation maps to. COMPLETE_COUNT_V1: equality on
   * the number of correct dimensions. PROGRESSIVE_LADDER_V1: the tier of
   * the WON level — a level with no tier (including level 0) has no prize,
   * and there is never a descent to another level's prize.
   */
  private findPrizeTier(
    prediction: PredictionRecord,
    evaluated: { correctDimensionCount: number; ladderLevel: number | null }
  ): PrizeTierRecord | undefined {
    if (prediction.predictionContract === PROGRESSIVE_PREDICTION_CONTRACT) {
      if (evaluated.ladderLevel === null || evaluated.ladderLevel < 1) return undefined;
      return [...this.prizeTiers.values()].find(
        (t) => t.venueActivationId === prediction.venueActivationId && t.ladderLevel === evaluated.ladderLevel
      );
    }
    return [...this.prizeTiers.values()].find(
      (t) =>
        t.venueActivationId === prediction.venueActivationId &&
        t.correctDimensionCount === evaluated.correctDimensionCount
    );
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
    reason: string | null,
    expectedDigest: string
  ): Promise<{ matchResultId: string; finalizedAt: string; alreadyFinalized: boolean }> {
    return this.serialize(async () => {
      if (!this.matchResults.get(matchResultId)) throw new MatchResultNotFoundError();

      // Authority is checked before the digest, the replay branch and
      // any mutation — an unauthorized caller learns nothing about the
      // result's state. Possession of a digest is not authorization.
      const hasAuthority = await this.authority.hasActiveAuthority(
        finalizedByGamingMemberId,
        "CONSEQUENTIAL_FINALIZER"
      );
      if (!hasAuthority) throw new InsufficientPlatformAuthorityError("CONSEQUENTIAL_FINALIZER");

      if (typeof expectedDigest !== "string" || expectedDigest.trim().length === 0) {
        throw new MatchResultDigestRequiredError();
      }

      const result = this.matchResults.get(matchResultId)!;
      if (result.supersedesMatchResultId) throw new MatchResultIsCorrectionError();

      if (result.finalizedAt) {
        if (expectedDigest !== this.digestFor(matchResultId)) throw new MatchResultDigestMismatchError();
        return { matchResultId, finalizedAt: result.finalizedAt, alreadyFinalized: true };
      }

      // Checked before any mutation — unlike the SQL implementation
      // (where any later exception rolls back the whole transaction
      // including an earlier write), this in-memory Map has no
      // transactional rollback, so every guard must run before
      // match_results is touched at all.
      const match = this.matches.get(result.matchId)!;
      if (match.cancelledAt) throw new MatchCancelledError();

      if (expectedDigest !== this.digestFor(matchResultId)) throw new MatchResultDigestMismatchError();

      assertMatchResultIntegrity({
        homeTeamId: match.homeTeamId,
        awayTeamId: match.awayTeamId,
        homeScore: result.homeScore,
        awayScore: result.awayScore,
        events: this.goalEvents.get(matchResultId) ?? [],
        teamOfPlayer: (playerId) => this.players.get(playerId)?.teamId ?? null,
      });

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

        const tier = this.findPrizeTier(prediction, evaluated);
        if (tier) {
          this.storeNewQualification(
            this.newQualification({
              evaluationId: evaluation.evaluationId,
              gamingMemberId: prediction.gamingMemberId,
              venueActivationId: prediction.venueActivationId,
              prizeTierId: tier.prizeTierId,
              lineageOrdinal: this.lineageOf(matchResultId),
            })
          );
        }
      }

      return { matchResultId, finalizedAt, alreadyFinalized: false };
    });
  }

  private newQualification(
    fields: Pick<
      PrizeQualificationRecord,
      "evaluationId" | "gamingMemberId" | "venueActivationId" | "prizeTierId"
    > &
      Partial<PrizeQualificationRecord>
  ): PrizeQualificationRecord {
    const record: PrizeQualificationRecord = {
      prizeQualificationId: randomUUID(),
      redeemedAt: null,
      redeemedByGamingMemberId: null,
      redeemedPrizeLabel: null,
      redeemedPrizeLabelBasis: null,
      legacyObservedPrizeLabel: null,
      lineageOrdinal: null,
      supersededAt: null,
      replacesPrizeQualificationId: null,
      fulfilledByPrizeQualificationId: null,
      holdPriorPrizeQualificationId: null,
      heldAt: null,
      holdBasis: null,
      holdReason: null,
      releasedAt: null,
      releasedByGamingMemberId: null,
      releaseReason: null,
      createdAt: new Date().toISOString(),
      ...fields,
    };
    return record;
  }

  /** Position of a result in the explicit supersession chain (the database's match_result_lineage_ordinal). */
  private lineageOf(matchResultId: string): number | null {
    return lineageOrdinalOf(matchResultId, (id) => {
      const result = this.matchResults.get(id);
      return result ? result.supersedesMatchResultId : undefined;
    });
  }

  /**
   * The only way an entitlement row is created. Applies the row-shape
   * rules and the (member, activation, lineage position) uniqueness the
   * database enforces, so this repository cannot hold a row Postgres would
   * refuse.
   */
  private storeNewQualification(qualification: PrizeQualificationRecord): PrizeQualificationRecord {
    assertPrizeQualificationShape(qualification);
    if (qualification.lineageOrdinal !== null) {
      const clash = [...this.qualifications.values()].some(
        (q) =>
          q.gamingMemberId === qualification.gamingMemberId &&
          q.venueActivationId === qualification.venueActivationId &&
          q.lineageOrdinal === qualification.lineageOrdinal
      );
      if (clash) throw new Error("prize_qualifications_lineage_position_key violated");
    }
    this.qualifications.set(qualification.prizeQualificationId, qualification);
    return qualification;
  }

  /**
   * TEST SEAM — never called by application code. Restates an existing
   * entitlement the way the data migration leaves a pre-existing one: a
   * delivery recorded before delivery-time label snapshots (basis
   * OBSERVED_AT_MIGRATION or UNKNOWN), and/or no lineage position. Lets
   * tests give this repository the same legacy rows the Postgres tests
   * build (there under session_replication_role = replica), so both can be
   * proven to follow the same rules. The row-shape rules still apply.
   */
  restateQualificationForTest(
    prizeQualificationId: string,
    patch: Partial<PrizeQualificationRecord>
  ): PrizeQualificationRecord {
    const existing = this.qualifications.get(prizeQualificationId);
    if (!existing) throw new PrizeQualificationNotFoundError();
    const restated: PrizeQualificationRecord = { ...existing, ...patch };
    assertPrizeQualificationShape(restated);
    this.qualifications.set(prizeQualificationId, restated);
    return restated;
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
    return this.serialize(async () => {
      if (!reason || reason.trim().length === 0) throw new ReasonRequiredError();

      const found = this.matchResults.get(matchResultId);
      if (!found) throw new MatchResultNotFoundError();
      if (!found.supersedesMatchResultId) throw new NotACorrectionError();

      const hasAuthority = await this.authority.hasActiveAuthority(
        finalizedByGamingMemberId,
        "CONSEQUENTIAL_FINALIZER"
      );
      if (!hasAuthority) throw new InsufficientPlatformAuthorityError("CONSEQUENTIAL_FINALIZER");

      if (typeof expectedDigest !== "string" || expectedDigest.trim().length === 0) {
        throw new MatchResultDigestRequiredError();
      }

      const result = this.matchResults.get(matchResultId)!;
      const supersedesMatchResultId = result.supersedesMatchResultId!;

      if (result.finalizedAt) {
        if (expectedDigest !== this.digestFor(matchResultId)) throw new MatchResultDigestMismatchError();
        return {
          matchResultId,
          finalizedAt: result.finalizedAt,
          supersedesMatchResultId,
          alreadyFinalized: true,
        };
      }

      // Every guard runs before the first mutation (see finalizeMatchResult).
      const match = this.matches.get(result.matchId)!;
      if (match.cancelledAt) throw new MatchCancelledError();

      const supersedes = this.matchResults.get(supersedesMatchResultId);
      if (!supersedes || !supersedes.finalizedAt) {
        throw new SupersededResultNotFinalizedError();
      }

      if (expectedDigest !== this.digestFor(matchResultId)) throw new MatchResultDigestMismatchError();

      assertMatchResultIntegrity({
        homeTeamId: match.homeTeamId,
        awayTeamId: match.awayTeamId,
        homeScore: result.homeScore,
        awayScore: result.awayScore,
        events: this.goalEvents.get(matchResultId) ?? [],
        teamOfPlayer: (playerId) => this.players.get(playerId)?.teamId ?? null,
      });

      const finalizedAt = new Date().toISOString();
      this.matchResults.set(matchResultId, {
        ...result,
        finalizedAt,
        finalizedByGamingMemberId,
      });
      // This correction's place in the explicit supersession chain.
      const correctionLineage = this.lineageOf(matchResultId);

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
            e.matchResultId === supersedesMatchResultId
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

        // Prize policy: the old entitlement is always superseded (history
        // kept); what replaces it depends on what was PHYSICALLY DELIVERED
        // for this member and activation, never on the old row alone.
        const oldQualification = oldEvaluation
          ? [...this.qualifications.values()].find((q) => q.evaluationId === oldEvaluation.evaluationId)
          : undefined;
        if (oldQualification && !oldQualification.supersededAt) {
          this.qualifications.set(oldQualification.prizeQualificationId, {
            ...oldQualification,
            supersededAt: finalizedAt,
          });
        }

        const newTier = this.findPrizeTier(prediction, evaluated);
        if (!newTier) continue; // no longer qualifies: history kept, no clawback

        const delivered: DeliveredEntitlement[] = [...this.qualifications.values()]
          .filter(
            (q) =>
              q.gamingMemberId === prediction.gamingMemberId &&
              q.venueActivationId === prediction.venueActivationId &&
              q.redeemedAt !== null
          )
          .map((q) => ({
            prizeQualificationId: q.prizeQualificationId,
            prizeTierId: q.prizeTierId,
            lineageOrdinal: q.lineageOrdinal,
            basis: q.redeemedPrizeLabelBasis!,
            redeemedPrizeLabel: q.redeemedPrizeLabel,
            legacyObservedPrizeLabel: q.legacyObservedPrizeLabel,
            tierDimensionCount:
              prediction.predictionContract === PROGRESSIVE_PREDICTION_CONTRACT
                ? (this.prizeTiers.get(q.prizeTierId)?.ladderLevel ?? null)
                : (this.prizeTiers.get(q.prizeTierId)?.correctDimensionCount ?? null),
          }));

        // The rules live in deliveryPolicy.ts, shared with the SQL contract
        // tests: ordering is lineage position, never a timestamp.
        const decision = decideCorrectionPrize({
          delivered,
          correctionLineage,
          newTierId: newTier.prizeTierId,
          newTierLabel: newTier.prizeLabel,
          newDimensionCount:
            prediction.predictionContract === PROGRESSIVE_PREDICTION_CONTRACT
              ? (evaluated.ladderLevel as number)
              : evaluated.correctDimensionCount,
          scale: prediction.predictionContract === PROGRESSIVE_PREDICTION_CONTRACT ? "LADDER" : "COUNT",
        });

        const base = {
          evaluationId: newEvaluation.evaluationId,
          gamingMemberId: prediction.gamingMemberId,
          venueActivationId: prediction.venueActivationId,
          prizeTierId: newTier.prizeTierId,
          replacesPrizeQualificationId: oldQualification?.prizeQualificationId ?? null,
          lineageOrdinal: correctionLineage,
        };

        if (decision.kind === "REPLACE_UNREDEEMED") {
          this.storeNewQualification(this.newQualification(base));
        } else if (decision.kind === "FULFILLED") {
          // The delivery actor and time are NOT copied.
          this.storeNewQualification(
            this.newQualification({
              ...base,
              fulfilledByPrizeQualificationId: decision.fulfilledByPrizeQualificationId,
            })
          );
        } else {
          this.storeNewQualification(
            this.newQualification({
              ...base,
              holdPriorPrizeQualificationId: decision.holdPriorPrizeQualificationId,
              heldAt: finalizedAt,
              holdBasis: decision.basis,
              holdReason: decision.reason,
            })
          );
        }
      }

      return {
        matchResultId,
        finalizedAt,
        supersedesMatchResultId,
        alreadyFinalized: false,
      };
    });
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
    // The current evaluation is the one for the result at the highest
    // position of the supersession chain — never the latest timestamp.
    let current: EvaluationRecord | null = null;
    let currentLineage = -1;
    for (const evaluation of this.evaluations.values()) {
      if (evaluation.predictionId !== predictionId) continue;
      const lineage = this.lineageOf(evaluation.matchResultId);
      if (lineage === null) throw new Error("evaluation order cannot be established: unreadable result chain");
      if (lineage > currentLineage) {
        current = evaluation;
        currentLineage = lineage;
      }
    }
    return current;
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

  async listQualificationDetailsForActivation(
    venueActivationId: string
  ): Promise<PrizeQualificationDetailRecord[]> {
    const qualifications = await this.listQualificationsForActivation(venueActivationId);
    const prizeLabels = new Map(
      [...this.prizeTiers.values()].map((tier) => [tier.prizeTierId, tier.prizeLabel])
    );
    return attachQualificationDetails(qualifications, this.memberDisplayNames, prizeLabels);
  }

  async redeemPrizeQualification(
    prizeQualificationId: string,
    redeemedByGamingMemberId: string,
    reason: string | null
  ): Promise<{ prizeQualificationId: string; redeemedAt: string; alreadyRedeemed: boolean }> {
    return this.serialize(async () => {
      if (!this.qualifications.get(prizeQualificationId)) throw new PrizeQualificationNotFoundError();

      const hasAuthority = await this.authority.hasActiveAuthority(redeemedByGamingMemberId, "CONSEQUENTIAL_FINALIZER");
      if (!hasAuthority) throw new InsufficientPlatformAuthorityError("CONSEQUENTIAL_FINALIZER");

      // Every decision is made against the row as it stands when this
      // call has its turn.
      const existing = this.qualifications.get(prizeQualificationId)!;
      if (existing.redeemedAt) {
        return { prizeQualificationId, redeemedAt: existing.redeemedAt, alreadyRedeemed: true };
      }
      if (existing.supersededAt) throw new QualificationSupersededError();
      if (existing.fulfilledByPrizeQualificationId) throw new PrizeAlreadyFulfilledError();
      if (existing.heldAt && !existing.releasedAt) throw new PrizeQualificationHeldError();

      const redeemedAt = new Date().toISOString();
      const redeemed: PrizeQualificationRecord = {
        ...existing,
        redeemedAt,
        redeemedByGamingMemberId,
        redeemedPrizeLabel: this.prizeTiers.get(existing.prizeTierId)?.prizeLabel ?? null,
        redeemedPrizeLabelBasis: "SNAPSHOT_AT_REDEMPTION",
        legacyObservedPrizeLabel: null,
      };
      assertPrizeQualificationShape(redeemed);
      this.qualifications.set(prizeQualificationId, redeemed);

      this.auditStore.record({
        actionType: "CONFIRM_PRIZE_REDEMPTION",
        actorKind: "GAMING_MEMBER",
        actorId: redeemedByGamingMemberId,
        authorityClassUsed: "CONSEQUENTIAL_FINALIZER",
        targetType: "prize_qualifications",
        targetId: prizeQualificationId,
        previousReference: null,
        resultingReference: { table: "prize_qualifications", id: prizeQualificationId },
        outcome: "SUCCESS",
        reason,
      });

      return { prizeQualificationId, redeemedAt, alreadyRedeemed: false };
    });
  }

  async releasePrizeQualificationHold(
    prizeQualificationId: string,
    releasedByGamingMemberId: string,
    reason: string
  ): Promise<{ prizeQualificationId: string; releasedAt: string; alreadyReleased: boolean }> {
    return this.serialize(async () => {
      if (!reason || reason.trim().length === 0) throw new ReasonRequiredError();
      if (!this.qualifications.get(prizeQualificationId)) throw new PrizeQualificationNotFoundError();

      const hasAuthority = await this.authority.hasActiveAuthority(releasedByGamingMemberId, "CONSEQUENTIAL_FINALIZER");
      if (!hasAuthority) throw new InsufficientPlatformAuthorityError("CONSEQUENTIAL_FINALIZER");

      const existing = this.qualifications.get(prizeQualificationId)!;
      if (!existing.heldAt) throw new PrizeQualificationNotHeldError();
      if (existing.releasedAt) {
        return { prizeQualificationId, releasedAt: existing.releasedAt, alreadyReleased: true };
      }
      if (existing.supersededAt) throw new QualificationSupersededError();

      const releasedAt = new Date().toISOString();
      const released: PrizeQualificationRecord = {
        ...existing,
        releasedAt,
        releasedByGamingMemberId,
        releaseReason: reason,
      };
      assertPrizeQualificationShape(released);
      this.qualifications.set(prizeQualificationId, released);

      this.auditStore.record({
        actionType: "RELEASE_PRIZE_HOLD",
        actorKind: "GAMING_MEMBER",
        actorId: releasedByGamingMemberId,
        authorityClassUsed: "CONSEQUENTIAL_FINALIZER",
        targetType: "prize_qualifications",
        targetId: prizeQualificationId,
        previousReference: existing.holdPriorPrizeQualificationId
          ? { table: "prize_qualifications", id: existing.holdPriorPrizeQualificationId }
          : null,
        resultingReference: { table: "prize_qualifications", id: prizeQualificationId },
        outcome: "SUCCESS",
        reason,
      });

      return { prizeQualificationId, releasedAt, alreadyReleased: false };
    });
  }
}
