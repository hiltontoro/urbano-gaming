import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { CompetitionsRepository } from "./competitionsRepository";
import type {
  CompetitionRecord, CompetitionTeamRecord, CompetitionRegistrationRecord, CompetitionJoinRequestRecord,
  CompetitionTeamMembershipRecord, CompetitionFixtureRecord, CompetitionRosterRevisionRecord,
  CompetitionCheckInRecord, CompetitionParticipationAttestationRecord, CompetitionFixtureEvidenceRecord,
  SoccerGoalEventRecord, SoccerAssistEventRecord, SoccerPenaltyShootoutRecord, CompetitionDisputeRecord,
  CompetitionFixtureFinalizationRecord, CompetitionMemberParticipationRecord, GoalEventInput, AssistEventInput,
  ParticipationAttestationInput,
} from "../types";
import {
  CompetitionNotFoundError, CompetitionAccessDeniedError, OperationalAuthorityRequiredError, CompetitionNotDraftError,
  CompetitionTeamCountInvalidError, CompetitionPairingInvalidError, CompetitionNotPublishedError, CompetitionTeamNotFoundError,
  CompetitionRegistrationRequiredError, AlreadyTeamMemberError, DuplicatePendingJoinRequestError, JoinRequestNotFoundError,
  JoinRequestNotPendingError, NotTeamCaptainError, JoinRequestNotRejectedError, JoinRequestAlreadyReviewedError,
  ReasonRequiredError, InvalidDecisionError, FixtureNotFoundError, FixtureNotOpenForRosterError, RosterMemberNotApprovedError, EmptyRosterError, DuplicateRosterEntryError,
  ScorekeeperConflictOfInterestError, FixtureNotReadyForCheckinError, NotOnRosterError, FixtureNotInEvidencePhaseError,
  InvalidScoreError, ShootoutRequiredError, InvalidShootoutWinnerError, InvalidGoalTeamError, EvidenceParticipantNotAttestedError,
  InvalidAssistError, RegulationScoreEventMismatchError, FixtureNotReadyToFinalizeError, EvidenceMissingError,
  InvalidForfeitingTeamError, UnsupportedActivityKeyError, MinimumParticipationNotMetError,
  UnsupportedTargetFactTypeError, TargetFactNotFoundError, TargetFactFixtureMismatchError,
  TargetFactNotCurrentError, DisputeNotAuthorizedError,
  CompetitionNotReadyToPublishError, TeamRegistrationNotOpenError, TeamRegistrationCapacityNotReachedError,
  TeamCapacityReachedError, TeamDecisionAlreadyMadeError, DuplicateTeamNameError, AlreadyCaptainOrMemberError,
  TeamNotAcceptedError,
} from "../types";

/** Translates a P0001-coded RPC error into its typed domain error. */
function translateError(error: { code?: string; message?: string }): Error {
  const msg = typeof error.message === "string" ? error.message : "";
  const table: Array<[string, () => Error]> = [
    ["OPERATIONAL_AUTHORITY_REQUIRED", () => new OperationalAuthorityRequiredError()],
    ["UNSUPPORTED_ACTIVITY_KEY", () => new UnsupportedActivityKeyError()],
    ["COMPETITION_NOT_FOUND", () => new CompetitionNotFoundError()],
    ["COMPETITION_ACCESS_DENIED", () => new CompetitionAccessDeniedError(msg)],
    ["COMPETITION_NOT_DRAFT", () => new CompetitionNotDraftError()],
    ["COMPETITION_TEAM_COUNT_INVALID", () => new CompetitionTeamCountInvalidError(msg)],
    ["COMPETITION_PAIRING_INVALID", () => new CompetitionPairingInvalidError(msg)],
    ["COMPETITION_NOT_PUBLISHED", () => new CompetitionNotPublishedError()],
    ["COMPETITION_TEAM_NOT_FOUND", () => new CompetitionTeamNotFoundError()],
    ["COMPETITION_REGISTRATION_REQUIRED", () => new CompetitionRegistrationRequiredError()],
    ["ALREADY_TEAM_MEMBER", () => new AlreadyTeamMemberError()],
    ["DUPLICATE_PENDING_JOIN_REQUEST", () => new DuplicatePendingJoinRequestError()],
    ["JOIN_REQUEST_NOT_FOUND", () => new JoinRequestNotFoundError()],
    ["JOIN_REQUEST_NOT_PENDING", () => new JoinRequestNotPendingError()],
    ["NOT_TEAM_CAPTAIN", () => new NotTeamCaptainError(msg)],
    ["JOIN_REQUEST_NOT_REJECTED", () => new JoinRequestNotRejectedError()],
    ["JOIN_REQUEST_ALREADY_REVIEWED", () => new JoinRequestAlreadyReviewedError()],
    ["REASON_REQUIRED", () => new ReasonRequiredError(msg)],
    ["INVALID_DECISION", () => new InvalidDecisionError()],
    ["FIXTURE_NOT_FOUND", () => new FixtureNotFoundError()],
    ["FIXTURE_NOT_OPEN_FOR_ROSTER", () => new FixtureNotOpenForRosterError()],
    ["ROSTER_MEMBER_NOT_APPROVED", () => new RosterMemberNotApprovedError(msg)],
    ["EMPTY_ROSTER", () => new EmptyRosterError()],
    ["DUPLICATE_ROSTER_ENTRY", () => new DuplicateRosterEntryError()],
    ["SCOREKEEPER_CONFLICT_OF_INTEREST", () => new ScorekeeperConflictOfInterestError(msg)],
    ["FIXTURE_NOT_READY_FOR_CHECKIN", () => new FixtureNotReadyForCheckinError()],
    ["NOT_ON_ROSTER", () => new NotOnRosterError()],
    ["FIXTURE_NOT_IN_EVIDENCE_PHASE", () => new FixtureNotInEvidencePhaseError()],
    ["INVALID_SCORE", () => new InvalidScoreError()],
    ["SHOOTOUT_REQUIRED", () => new ShootoutRequiredError()],
    ["INVALID_SHOOTOUT_WINNER", () => new InvalidShootoutWinnerError()],
    ["INVALID_GOAL_TEAM", () => new InvalidGoalTeamError(msg)],
    ["EVIDENCE_PARTICIPANT_NOT_ATTESTED", () => new EvidenceParticipantNotAttestedError(msg)],
    ["INVALID_ASSIST", () => new InvalidAssistError()],
    ["REGULATION_SCORE_EVENT_MISMATCH", () => new RegulationScoreEventMismatchError()],
    ["MINIMUM_PARTICIPATION_NOT_MET", () => new MinimumParticipationNotMetError()],
    ["FIXTURE_NOT_READY_TO_FINALIZE", () => new FixtureNotReadyToFinalizeError()],
    ["EVIDENCE_MISSING", () => new EvidenceMissingError()],
    ["INVALID_FORFEITING_TEAM", () => new InvalidForfeitingTeamError()],
    ["UNSUPPORTED_TARGET_FACT_TYPE", () => new UnsupportedTargetFactTypeError()],
    ["TARGET_FACT_NOT_FOUND", () => new TargetFactNotFoundError(msg)],
    ["TARGET_FACT_FIXTURE_MISMATCH", () => new TargetFactFixtureMismatchError()],
    ["TARGET_FACT_NOT_CURRENT", () => new TargetFactNotCurrentError()],
    ["DISPUTE_NOT_AUTHORIZED", () => new DisputeNotAuthorizedError()],
    ["COMPETITION_NOT_READY_TO_PUBLISH", () => new CompetitionNotReadyToPublishError()],
    ["TEAM_REGISTRATION_NOT_OPEN", () => new TeamRegistrationNotOpenError(msg)],
    ["TEAM_REGISTRATION_CAPACITY_NOT_REACHED", () => new TeamRegistrationCapacityNotReachedError(msg)],
    ["TEAM_CAPACITY_REACHED", () => new TeamCapacityReachedError()],
    ["TEAM_DECISION_ALREADY_MADE", () => new TeamDecisionAlreadyMadeError()],
    ["DUPLICATE_TEAM_NAME", () => new DuplicateTeamNameError()],
    ["ALREADY_CAPTAIN_OR_MEMBER", () => new AlreadyCaptainOrMemberError()],
    ["TEAM_NOT_ACCEPTED", () => new TeamNotAcceptedError()],
  ];
  for (const [code, build] of table) {
    if (error.code === "P0001" && msg.includes(code)) return build();
  }
  return new Error(msg || "Unknown Competitions repository error.");
}

export class SupabaseCompetitionsRepository implements CompetitionsRepository {
  private client: SupabaseClient;

  constructor(supabaseUrl: string, supabaseServiceKey: string) {
    this.client = createClient(supabaseUrl, supabaseServiceKey, {
      global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store" } as RequestInit) },
    });
  }

  async createCompetition(organizerGamingMemberId: string, name: string, activityKey: string) {
    const { data, error } = await this.client.rpc("create_competition_atomically", {
      p_organizer_gaming_member_id: organizerGamingMemberId, p_name: name, p_activity_key: activityKey,
    });
    if (error) throw translateError(error);
    const row = Array.isArray(data) ? data[0] : data;
    return { competitionId: row.competition_id, state: row.state, createdAt: row.created_at };
  }

  async addCompetitionTeam(competitionId: string, organizerGamingMemberId: string, name: string, captainGamingMemberId: string) {
    const { data, error } = await this.client.rpc("add_competition_team_atomically", {
      p_competition_id: competitionId, p_organizer_gaming_member_id: organizerGamingMemberId, p_name: name,
      p_captain_gaming_member_id: captainGamingMemberId,
    });
    if (error) throw translateError(error);
    const row = Array.isArray(data) ? data[0] : data;
    return { competitionTeamId: row.competition_team_id, createdAt: row.created_at };
  }

  async openTeamRegistration(competitionId: string, organizerGamingMemberId: string) {
    const { data, error } = await this.client.rpc("open_team_registration_atomically", {
      p_competition_id: competitionId, p_organizer_gaming_member_id: organizerGamingMemberId,
    });
    if (error) throw translateError(error);
    const row = Array.isArray(data) ? data[0] : data;
    return { competitionId: row.competition_id, state: row.state };
  }

  async proposeCompetitionTeam(competitionId: string, name: string, proposingGamingMemberId: string) {
    const { data, error } = await this.client.rpc("propose_competition_team_atomically", {
      p_competition_id: competitionId, p_name: name, p_proposing_gaming_member_id: proposingGamingMemberId,
    });
    if (error) throw translateError(error);
    const row = Array.isArray(data) ? data[0] : data;
    return { competitionTeamId: row.competition_team_id, status: row.status, createdAt: row.created_at };
  }

  async decideCompetitionTeam(competitionTeamId: string, organizerGamingMemberId: string, decision: "APPROVE" | "REJECT", reason: string | null) {
    const { data, error } = await this.client.rpc("decide_competition_team_atomically", {
      p_competition_team_id: competitionTeamId, p_organizer_gaming_member_id: organizerGamingMemberId,
      p_decision: decision, p_reason: reason,
    });
    if (error) throw translateError(error);
    const row = Array.isArray(data) ? data[0] : data;
    return { competitionTeamId: row.competition_team_id, status: row.status, decidedAt: row.decided_at, competitionTeamMembershipId: row.competition_team_membership_id ?? null };
  }

  async closeTeamRegistration(competitionId: string, organizerGamingMemberId: string) {
    const { data, error } = await this.client.rpc("close_team_registration_atomically", {
      p_competition_id: competitionId, p_organizer_gaming_member_id: organizerGamingMemberId,
    });
    if (error) throw translateError(error);
    const row = Array.isArray(data) ? data[0] : data;
    return { competitionId: row.competition_id, state: row.state };
  }

  async publishCompetition(
    competitionId: string, organizerGamingMemberId: string,
    semifinal1TeamAId: string, semifinal1TeamBId: string, semifinal2TeamAId: string, semifinal2TeamBId: string,
    semifinal1ScheduledAt: string, semifinal2ScheduledAt: string, finalScheduledAt: string
  ) {
    const { data, error } = await this.client.rpc("publish_competition_atomically", {
      p_competition_id: competitionId, p_organizer_gaming_member_id: organizerGamingMemberId,
      p_semifinal_1_team_a_id: semifinal1TeamAId, p_semifinal_1_team_b_id: semifinal1TeamBId,
      p_semifinal_2_team_a_id: semifinal2TeamAId, p_semifinal_2_team_b_id: semifinal2TeamBId,
      p_semifinal_1_scheduled_at: semifinal1ScheduledAt, p_semifinal_2_scheduled_at: semifinal2ScheduledAt,
      p_final_scheduled_at: finalScheduledAt,
    });
    if (error) throw translateError(error);
    const row = Array.isArray(data) ? data[0] : data;
    return {
      competitionId: row.competition_id, state: row.state, publishedAt: row.published_at,
      semifinal1FixtureId: row.semifinal_1_fixture_id, semifinal2FixtureId: row.semifinal_2_fixture_id, finalFixtureId: row.final_fixture_id,
    };
  }

  async registerForCompetition(competitionId: string, gamingMemberId: string, isAdultSelfAttested: boolean) {
    const { data, error } = await this.client.rpc("register_for_competition_atomically", {
      p_competition_id: competitionId, p_gaming_member_id: gamingMemberId, p_is_adult_self_attested: isAdultSelfAttested,
    });
    if (error) throw translateError(error);
    const row = Array.isArray(data) ? data[0] : data;
    return { competitionRegistrationId: row.competition_registration_id, registeredAt: row.registered_at, alreadyRegistered: row.already_registered };
  }

  async requestJoinTeam(competitionId: string, competitionTeamId: string, requestingGamingMemberId: string) {
    const { data, error } = await this.client.rpc("request_join_competition_team_atomically", {
      p_competition_id: competitionId, p_competition_team_id: competitionTeamId, p_requesting_gaming_member_id: requestingGamingMemberId,
    });
    if (error) throw translateError(error);
    const row = Array.isArray(data) ? data[0] : data;
    return { competitionJoinRequestId: row.competition_join_request_id, status: row.status, createdAt: row.created_at };
  }

  async decideJoinRequest(competitionJoinRequestId: string, decidingGamingMemberId: string, decision: "APPROVE" | "REJECT", isOrganizerOverride: boolean) {
    const { data, error } = await this.client.rpc("decide_join_request_atomically", {
      p_competition_join_request_id: competitionJoinRequestId, p_deciding_gaming_member_id: decidingGamingMemberId,
      p_decision: decision, p_is_organizer_override: isOrganizerOverride,
    });
    if (error) throw translateError(error);
    const row = Array.isArray(data) ? data[0] : data;
    return { competitionJoinRequestId: row.competition_join_request_id, status: row.status, decidedAt: row.decided_at, competitionTeamMembershipId: row.competition_team_membership_id ?? null };
  }

  async organizerReviewJoinRequest(competitionJoinRequestId: string, organizerGamingMemberId: string, decision: "APPROVE" | "REJECT", reason: string) {
    const { data, error } = await this.client.rpc("organizer_review_join_request_atomically", {
      p_competition_join_request_id: competitionJoinRequestId, p_organizer_gaming_member_id: organizerGamingMemberId,
      p_decision: decision, p_reason: reason,
    });
    if (error) throw translateError(error);
    const row = Array.isArray(data) ? data[0] : data;
    return { competitionJoinRequestId: row.competition_join_request_id, status: row.status, organizerReviewedAt: row.organizer_reviewed_at, competitionTeamMembershipId: row.competition_team_membership_id ?? null };
  }

  async declareRoster(competitionFixtureId: string, competitionTeamId: string, declaringGamingMemberId: string, isOrganizerAction: boolean, reason: string | null, gamingMemberIds: string[]) {
    const { data, error } = await this.client.rpc("declare_competition_roster_atomically", {
      p_competition_fixture_id: competitionFixtureId, p_competition_team_id: competitionTeamId,
      p_declaring_gaming_member_id: declaringGamingMemberId, p_is_organizer_action: isOrganizerAction,
      p_reason: reason, p_gaming_member_ids: gamingMemberIds,
    });
    if (error) throw translateError(error);
    const row = Array.isArray(data) ? data[0] : data;
    return { competitionRosterRevisionId: row.competition_roster_revision_id, declaredAt: row.declared_at, fixtureState: row.fixture_state };
  }

  async checkIn(competitionFixtureId: string, gamingMemberId: string) {
    const { data, error } = await this.client.rpc("check_in_competition_fixture_atomically", {
      p_competition_fixture_id: competitionFixtureId, p_gaming_member_id: gamingMemberId,
    });
    if (error) throw translateError(error);
    const row = Array.isArray(data) ? data[0] : data;
    return { competitionCheckinId: row.competition_checkin_id, checkedInAt: row.checked_in_at, alreadyCheckedIn: row.already_checked_in };
  }

  async appointScorekeeper(competitionFixtureId: string, organizerGamingMemberId: string, scorekeeperGamingMemberId: string) {
    const { data, error } = await this.client.rpc("appoint_competition_scorekeeper_atomically", {
      p_competition_fixture_id: competitionFixtureId, p_organizer_gaming_member_id: organizerGamingMemberId,
      p_scorekeeper_gaming_member_id: scorekeeperGamingMemberId,
    });
    if (error) throw translateError(error);
    const row = Array.isArray(data) ? data[0] : data;
    return { competitionFixtureId: row.competition_fixture_id, scorekeeperGamingMemberId: row.scorekeeper_gaming_member_id };
  }

  async submitFixtureEvidence(
    competitionFixtureId: string, scorekeeperGamingMemberId: string, teamAScore: number, teamBScore: number,
    goalEvents: GoalEventInput[], assistEvents: AssistEventInput[], participationAttestations: ParticipationAttestationInput[],
    penaltyShootoutWinningTeamId: string | null
  ) {
    const { data, error } = await this.client.rpc("submit_competition_fixture_evidence_atomically", {
      p_competition_fixture_id: competitionFixtureId, p_scorekeeper_gaming_member_id: scorekeeperGamingMemberId,
      p_team_a_score: teamAScore, p_team_b_score: teamBScore, p_goal_events: goalEvents, p_assist_events: assistEvents,
      p_participation_attestations: participationAttestations, p_penalty_shootout_winning_team_id: penaltyShootoutWinningTeamId,
    });
    if (error) throw translateError(error);
    const row = Array.isArray(data) ? data[0] : data;
    return { competitionFixtureEvidenceId: row.competition_fixture_evidence_id, fixtureState: row.fixture_state, alreadySubmitted: row.already_submitted };
  }

  async raiseDispute(competitionFixtureId: string, raisedByGamingMemberId: string, targetFactType: string, targetFactId: string, reason: string) {
    const { data, error } = await this.client.rpc("raise_competition_dispute_atomically", {
      p_competition_fixture_id: competitionFixtureId, p_raised_by_gaming_member_id: raisedByGamingMemberId,
      p_target_fact_type: targetFactType, p_target_fact_id: targetFactId, p_reason: reason,
    });
    if (error) throw translateError(error);
    const row = Array.isArray(data) ? data[0] : data;
    return { competitionDisputeId: row.competition_dispute_id, raisedAt: row.raised_at };
  }

  async correctFixture(
    competitionFixtureId: string, organizerGamingMemberId: string, reason: string, teamAScore: number, teamBScore: number,
    goalEvents: GoalEventInput[], assistEvents: AssistEventInput[], penaltyShootoutWinningTeamId: string | null
  ) {
    const { data, error } = await this.client.rpc("correct_competition_fixture_atomically", {
      p_competition_fixture_id: competitionFixtureId, p_organizer_gaming_member_id: organizerGamingMemberId, p_reason: reason,
      p_team_a_score: teamAScore, p_team_b_score: teamBScore, p_goal_events: goalEvents, p_assist_events: assistEvents,
      p_penalty_shootout_winning_team_id: penaltyShootoutWinningTeamId,
    });
    if (error) throw translateError(error);
    const row = Array.isArray(data) ? data[0] : data;
    return { competitionFixtureEvidenceId: row.competition_fixture_evidence_id, newWinningCompetitionTeamId: row.new_winning_competition_team_id, competitionState: row.competition_state, cascadeOutcome: row.cascade_outcome };
  }

  async finalizeFixture(competitionFixtureId: string, organizerGamingMemberId: string) {
    const { data, error } = await this.client.rpc("finalize_competition_fixture_atomically", {
      p_competition_fixture_id: competitionFixtureId, p_organizer_gaming_member_id: organizerGamingMemberId,
    });
    if (error) throw translateError(error);
    const row = Array.isArray(data) ? data[0] : data;
    return { competitionFixtureFinalizationId: row.competition_fixture_finalization_id, outcomeType: row.outcome_type, winningCompetitionTeamId: row.winning_competition_team_id, alreadyFinalized: row.already_finalized };
  }

  async forfeitFixture(competitionFixtureId: string, organizerGamingMemberId: string, forfeitingCompetitionTeamId: string, reason: string) {
    const { data, error } = await this.client.rpc("forfeit_competition_fixture_atomically", {
      p_competition_fixture_id: competitionFixtureId, p_organizer_gaming_member_id: organizerGamingMemberId,
      p_forfeiting_competition_team_id: forfeitingCompetitionTeamId, p_reason: reason,
    });
    if (error) throw translateError(error);
    const row = Array.isArray(data) ? data[0] : data;
    return { competitionFixtureFinalizationId: row.competition_fixture_finalization_id, winningCompetitionTeamId: row.winning_competition_team_id, alreadyFinalized: row.already_finalized };
  }

  async voidFixture(competitionFixtureId: string, organizerGamingMemberId: string, reason: string) {
    const { data, error } = await this.client.rpc("void_competition_fixture_atomically", {
      p_competition_fixture_id: competitionFixtureId, p_organizer_gaming_member_id: organizerGamingMemberId, p_reason: reason,
    });
    if (error) throw translateError(error);
    const row = Array.isArray(data) ? data[0] : data;
    return { competitionFixtureFinalizationId: row.competition_fixture_finalization_id, competitionState: row.competition_state, alreadyFinalized: row.already_finalized };
  }

  // --- Reads (direct table access via the service-role client, which
  // bypasses RLS by design — this is the one place service-role
  // credentials are used, entirely server-side; see UG-CR-RPT-024 §8) ---

  async listCompetitions(): Promise<CompetitionRecord[]> {
    const { data, error } = await this.client.from("competitions").select("*").order("created_at", { ascending: false });
    if (error) throw error;
    return (data ?? []).map((data) => ({
      competitionId: data.competition_id, activityKey: data.activity_key, name: data.name,
      organizerGamingMemberId: data.organizer_gaming_member_id, state: data.state, cancelledReason: data.cancelled_reason ?? null,
      createdAt: data.created_at, publishedAt: data.published_at ?? null,
    }));
  }

  async getCompetitionById(competitionId: string): Promise<CompetitionRecord | null> {
    const { data, error } = await this.client.from("competitions").select("*").eq("competition_id", competitionId).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return {
      competitionId: data.competition_id, activityKey: data.activity_key, name: data.name,
      organizerGamingMemberId: data.organizer_gaming_member_id, state: data.state, cancelledReason: data.cancelled_reason ?? null,
      createdAt: data.created_at, publishedAt: data.published_at ?? null,
    };
  }

  async getCompetitionTeams(competitionId: string): Promise<CompetitionTeamRecord[]> {
    const { data, error } = await this.client.from("competition_teams").select("*").eq("competition_id", competitionId);
    if (error) throw error;
    return (data ?? []).map(mapTeam);
  }

  async getCompetitionTeamById(competitionTeamId: string): Promise<CompetitionTeamRecord | null> {
    const { data, error } = await this.client.from("competition_teams").select("*").eq("competition_team_id", competitionTeamId).maybeSingle();
    if (error) throw error;
    return data ? mapTeam(data) : null;
  }

  async getTeamMemberships(competitionTeamId: string): Promise<CompetitionTeamMembershipRecord[]> {
    const { data, error } = await this.client.from("competition_team_memberships").select("*").eq("competition_team_id", competitionTeamId);
    if (error) throw error;
    return (data ?? []).map((r) => ({
      competitionTeamMembershipId: r.competition_team_membership_id, competitionId: r.competition_id, competitionTeamId: r.competition_team_id,
      gamingMemberId: r.gaming_member_id, approvedAt: r.approved_at, approvedByGamingMemberId: r.approved_by_gaming_member_id,
    }));
  }

  async getDisplayNames(gamingMemberIds: string[]): Promise<Record<string, string>> {
    const uniqueIds = Array.from(new Set(gamingMemberIds));
    if (uniqueIds.length === 0) return {};
    const { data, error } = await this.client.from("gaming_members").select("gaming_member_id, display_name").in("gaming_member_id", uniqueIds);
    if (error) throw error;
    const map: Record<string, string> = {};
    for (const row of data ?? []) map[row.gaming_member_id as string] = row.display_name as string;
    return map;
  }

  async getCompetitionFixtures(competitionId: string): Promise<CompetitionFixtureRecord[]> {
    const { data, error } = await this.client.from("competition_fixtures").select("*").eq("competition_id", competitionId);
    if (error) throw error;
    return (data ?? []).map(mapFixture);
  }

  async getFixtureById(competitionFixtureId: string): Promise<CompetitionFixtureRecord | null> {
    const { data, error } = await this.client.from("competition_fixtures").select("*").eq("competition_fixture_id", competitionFixtureId).maybeSingle();
    if (error) throw error;
    return data ? mapFixture(data) : null;
  }

  async getMyRegistration(competitionId: string, gamingMemberId: string): Promise<CompetitionRegistrationRecord | null> {
    const { data, error } = await this.client.from("competition_registrations").select("*").eq("competition_id", competitionId).eq("gaming_member_id", gamingMemberId).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return { competitionRegistrationId: data.competition_registration_id, competitionId: data.competition_id, gamingMemberId: data.gaming_member_id, isAdultSelfAttested: data.is_adult_self_attested, registeredAt: data.registered_at };
  }

  async getMyTeamMembership(competitionId: string, gamingMemberId: string): Promise<CompetitionTeamMembershipRecord | null> {
    const { data, error } = await this.client.from("competition_team_memberships").select("*").eq("competition_id", competitionId).eq("gaming_member_id", gamingMemberId).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return { competitionTeamMembershipId: data.competition_team_membership_id, competitionId: data.competition_id, competitionTeamId: data.competition_team_id, gamingMemberId: data.gaming_member_id, approvedAt: data.approved_at, approvedByGamingMemberId: data.approved_by_gaming_member_id };
  }

  async getMyPendingJoinRequest(competitionId: string, gamingMemberId: string): Promise<CompetitionJoinRequestRecord | null> {
    const { data, error } = await this.client.from("competition_join_requests").select("*").eq("competition_id", competitionId).eq("requesting_gaming_member_id", gamingMemberId).eq("status", "REQUESTED").maybeSingle();
    if (error) throw error;
    return data ? mapJoinRequest(data) : null;
  }

  async getPendingJoinRequestsForTeam(competitionTeamId: string): Promise<CompetitionJoinRequestRecord[]> {
    const { data, error } = await this.client.from("competition_join_requests").select("*").eq("competition_team_id", competitionTeamId).eq("status", "REQUESTED");
    if (error) throw error;
    return (data ?? []).map(mapJoinRequest);
  }

  async getCurrentRoster(competitionFixtureId: string, competitionTeamId: string): Promise<CompetitionRosterRevisionRecord | null> {
    const { data, error } = await this.client.from("competition_roster_revisions").select("*, competition_roster_revision_entries(gaming_member_id)")
      .eq("competition_fixture_id", competitionFixtureId).eq("competition_team_id", competitionTeamId).eq("is_current", true).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return {
      competitionRosterRevisionId: data.competition_roster_revision_id, competitionFixtureId: data.competition_fixture_id,
      competitionTeamId: data.competition_team_id, declaredByGamingMemberId: data.declared_by_gaming_member_id, declaredAt: data.declared_at,
      reason: data.reason, supersedesRevisionId: data.supersedes_revision_id, isCurrent: data.is_current,
      gamingMemberIds: (data.competition_roster_revision_entries ?? []).map((e: { gaming_member_id: string }) => e.gaming_member_id),
    };
  }

  async getCheckIns(competitionFixtureId: string): Promise<CompetitionCheckInRecord[]> {
    const { data, error } = await this.client.from("competition_checkins").select("*").eq("competition_fixture_id", competitionFixtureId);
    if (error) throw error;
    return (data ?? []).map((r) => ({ competitionCheckinId: r.competition_checkin_id, competitionFixtureId: r.competition_fixture_id, gamingMemberId: r.gaming_member_id, checkedInAt: r.checked_in_at }));
  }

  async getCurrentAttestations(competitionFixtureId: string): Promise<CompetitionParticipationAttestationRecord[]> {
    const { data, error } = await this.client.from("competition_participation_attestations").select("*").eq("competition_fixture_id", competitionFixtureId).eq("is_current", true);
    if (error) throw error;
    return (data ?? []).map((r) => ({
      competitionParticipationAttestationId: r.competition_participation_attestation_id, competitionFixtureId: r.competition_fixture_id,
      gamingMemberId: r.gaming_member_id, actuallyParticipated: r.actually_participated, attestedByGamingMemberId: r.attested_by_gaming_member_id,
      attestedAt: r.attested_at, supersedesAttestationId: r.supersedes_attestation_id, isCurrent: r.is_current,
    }));
  }

  async getCurrentEvidence(competitionFixtureId: string): Promise<CompetitionFixtureEvidenceRecord | null> {
    const { data, error } = await this.client.from("competition_fixture_evidence").select("*").eq("competition_fixture_id", competitionFixtureId).eq("is_current", true).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return { competitionFixtureEvidenceId: data.competition_fixture_evidence_id, competitionFixtureId: data.competition_fixture_id, teamAScore: data.team_a_score, teamBScore: data.team_b_score, enteredByGamingMemberId: data.entered_by_gaming_member_id, enteredAt: data.entered_at, supersedesEvidenceId: data.supersedes_evidence_id, isCurrent: data.is_current };
  }

  async getCurrentGoalEvents(competitionFixtureId: string): Promise<SoccerGoalEventRecord[]> {
    const { data, error } = await this.client.from("soccer_goal_events").select("*").eq("competition_fixture_id", competitionFixtureId).eq("is_current", true);
    if (error) throw error;
    return (data ?? []).map((r) => ({ soccerGoalEventId: r.soccer_goal_event_id, competitionFixtureId: r.competition_fixture_id, scorerGamingMemberId: r.scorer_gaming_member_id, competitionTeamId: r.competition_team_id, enteredByGamingMemberId: r.entered_by_gaming_member_id, enteredAt: r.entered_at, isCurrent: r.is_current }));
  }

  async getCurrentAssistEvents(competitionFixtureId: string): Promise<SoccerAssistEventRecord[]> {
    const { data, error } = await this.client.from("soccer_assist_events").select("*").eq("competition_fixture_id", competitionFixtureId).eq("is_current", true);
    if (error) throw error;
    return (data ?? []).map((r) => ({ soccerAssistEventId: r.soccer_assist_event_id, competitionFixtureId: r.competition_fixture_id, assistingGamingMemberId: r.assisting_gaming_member_id, assistedGoalEventId: r.assisted_goal_event_id, enteredByGamingMemberId: r.entered_by_gaming_member_id, enteredAt: r.entered_at, isCurrent: r.is_current }));
  }

  async getCurrentShootout(competitionFixtureId: string): Promise<SoccerPenaltyShootoutRecord | null> {
    const { data, error } = await this.client.from("soccer_penalty_shootouts").select("*").eq("competition_fixture_id", competitionFixtureId).eq("is_current", true).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return { soccerPenaltyShootoutId: data.soccer_penalty_shootout_id, competitionFixtureId: data.competition_fixture_id, winningCompetitionTeamId: data.winning_competition_team_id, enteredByGamingMemberId: data.entered_by_gaming_member_id, enteredAt: data.entered_at, isCurrent: data.is_current };
  }

  async getDisputes(competitionFixtureId: string): Promise<CompetitionDisputeRecord[]> {
    const { data, error } = await this.client.from("competition_disputes").select("*").eq("competition_fixture_id", competitionFixtureId);
    if (error) throw error;
    return (data ?? []).map((r) => ({
      competitionDisputeId: r.competition_dispute_id, competitionFixtureId: r.competition_fixture_id, raisedByGamingMemberId: r.raised_by_gaming_member_id,
      targetFactType: r.target_fact_type, targetFactId: r.target_fact_id, reason: r.reason, raisedAt: r.raised_at,
      resolvedAt: r.resolved_at, resolvedByGamingMemberId: r.resolved_by_gaming_member_id, resolutionAction: r.resolution_action,
    }));
  }

  async getCurrentFinalization(competitionFixtureId: string): Promise<CompetitionFixtureFinalizationRecord | null> {
    const { data, error } = await this.client.from("competition_fixture_finalizations").select("*").eq("competition_fixture_id", competitionFixtureId).eq("is_current", true).maybeSingle();
    if (error) throw error;
    if (!data) return null;
    return {
      competitionFixtureFinalizationId: data.competition_fixture_finalization_id, competitionFixtureId: data.competition_fixture_id,
      finalizedByGamingMemberId: data.finalized_by_gaming_member_id, finalizedAt: data.finalized_at, outcomeType: data.outcome_type,
      winningCompetitionTeamId: data.winning_competition_team_id, reason: data.reason, supersedesFinalizationId: data.supersedes_finalization_id, isCurrent: data.is_current,
    };
  }

  async getMemberParticipationRecords(competitionId: string, gamingMemberId: string): Promise<CompetitionMemberParticipationRecord[]> {
    const { data, error } = await this.client.from("competition_member_participation_records").select("*").eq("competition_id", competitionId).eq("gaming_member_id", gamingMemberId).eq("is_current", true);
    if (error) throw error;
    return (data ?? []).map((r) => ({
      competitionMemberParticipationRecordId: r.competition_member_participation_record_id, competitionId: r.competition_id,
      competitionFixtureId: r.competition_fixture_id, gamingMemberId: r.gaming_member_id, appeared: r.appeared, goals: r.goals,
      assists: r.assists, derivedFromFinalizationId: r.derived_from_finalization_id, derivedAt: r.derived_at, isCurrent: r.is_current,
    }));
  }
}

function mapTeam(r: Record<string, unknown>): CompetitionTeamRecord {
  return {
    competitionTeamId: r.competition_team_id as string, competitionId: r.competition_id as string, name: r.name as string,
    captainGamingMemberId: r.captain_gaming_member_id as string,
    status: r.status as CompetitionTeamRecord["status"], provenance: r.provenance as CompetitionTeamRecord["provenance"],
    decidedAt: (r.decided_at as string | null) ?? null, decidedByGamingMemberId: (r.decided_by_gaming_member_id as string | null) ?? null,
    rejectionReason: (r.rejection_reason as string | null) ?? null, createdAt: r.created_at as string,
  };
}

function mapFixture(r: Record<string, unknown>): CompetitionFixtureRecord {
  return {
    competitionFixtureId: r.competition_fixture_id as string, competitionId: r.competition_id as string,
    fixtureRole: r.fixture_role as CompetitionFixtureRecord["fixtureRole"], scheduledAt: r.scheduled_at as string,
    teamACompetitionTeamId: (r.team_a_competition_team_id as string | null) ?? null,
    teamBCompetitionTeamId: (r.team_b_competition_team_id as string | null) ?? null,
    teamASourceFixtureId: (r.team_a_source_fixture_id as string | null) ?? null,
    teamBSourceFixtureId: (r.team_b_source_fixture_id as string | null) ?? null,
    state: r.state as CompetitionFixtureRecord["state"], scorekeeperGamingMemberId: (r.scorekeeper_gaming_member_id as string | null) ?? null,
    createdAt: r.created_at as string,
  };
}

function mapJoinRequest(r: Record<string, unknown>): CompetitionJoinRequestRecord {
  return {
    competitionJoinRequestId: r.competition_join_request_id as string, competitionId: r.competition_id as string,
    competitionTeamId: r.competition_team_id as string, requestingGamingMemberId: r.requesting_gaming_member_id as string,
    status: r.status as CompetitionJoinRequestRecord["status"], decidedByGamingMemberId: (r.decided_by_gaming_member_id as string | null) ?? null,
    decidedAt: (r.decided_at as string | null) ?? null, organizerReviewedAt: (r.organizer_reviewed_at as string | null) ?? null,
    organizerReviewedByGamingMemberId: (r.organizer_reviewed_by_gaming_member_id as string | null) ?? null, createdAt: r.created_at as string,
  };
}
