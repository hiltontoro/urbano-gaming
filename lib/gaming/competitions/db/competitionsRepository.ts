import type {
  CompetitionRecord,
  CompetitionTeamRecord,
  CompetitionRegistrationRecord,
  CompetitionJoinRequestRecord,
  CompetitionTeamMembershipRecord,
  CompetitionFixtureRecord,
  CompetitionRosterRevisionRecord,
  CompetitionCheckInRecord,
  CompetitionParticipationAttestationRecord,
  CompetitionFixtureEvidenceRecord,
  SoccerGoalEventRecord,
  SoccerAssistEventRecord,
  SoccerPenaltyShootoutRecord,
  CompetitionDisputeRecord,
  CompetitionFixtureFinalizationRecord,
  CompetitionMemberParticipationRecord,
  GoalEventInput,
  AssistEventInput,
  ParticipationAttestationInput,
  StartCompetitionResult,
  AddCompetitionTeamResult,
  OpenTeamRegistrationResult,
  ProposeCompetitionTeamResult,
  DecideCompetitionTeamResult,
  CloseTeamRegistrationResult,
  PublishCompetitionResult,
  RegisterForCompetitionResult,
  RequestJoinTeamResult,
  DecideJoinRequestResult,
  OrganizerReviewJoinRequestResult,
  DeclareRosterResult,
  CheckInResult,
  AppointScorekeeperResult,
  SubmitFixtureEvidenceResult,
  RaiseDisputeResult,
  CorrectFixtureResult,
  FinalizeFixtureResult,
  ForfeitFixtureResult,
  VoidFixtureResult,
} from "../types";

/**
 * URBANO Gaming Competitions — Soccer Slice 001 repository boundary.
 * Mirrors the established repository-interface convention (see
 * lib/gaming/predictions/db/predictionsRepository.ts): one interface,
 * one InMemory implementation, one Supabase implementation, each
 * command's authoritative check living inside the atomic operation
 * itself — never a fast-path-only guarantee.
 */
export interface CompetitionsRepository {
  createCompetition(organizerGamingMemberId: string, name: string, activityKey: string): Promise<StartCompetitionResult>;
  addCompetitionTeam(competitionId: string, organizerGamingMemberId: string, name: string, captainGamingMemberId: string): Promise<AddCompetitionTeamResult>;
  openTeamRegistration(competitionId: string, organizerGamingMemberId: string): Promise<OpenTeamRegistrationResult>;
  proposeCompetitionTeam(competitionId: string, name: string, proposingGamingMemberId: string): Promise<ProposeCompetitionTeamResult>;
  decideCompetitionTeam(competitionTeamId: string, organizerGamingMemberId: string, decision: "APPROVE" | "REJECT", reason: string | null): Promise<DecideCompetitionTeamResult>;
  closeTeamRegistration(competitionId: string, organizerGamingMemberId: string): Promise<CloseTeamRegistrationResult>;
  publishCompetition(
    competitionId: string,
    organizerGamingMemberId: string,
    semifinal1TeamAId: string,
    semifinal1TeamBId: string,
    semifinal2TeamAId: string,
    semifinal2TeamBId: string,
    semifinal1ScheduledAt: string,
    semifinal2ScheduledAt: string,
    finalScheduledAt: string
  ): Promise<PublishCompetitionResult>;

  registerForCompetition(competitionId: string, gamingMemberId: string, isAdultSelfAttested: boolean): Promise<RegisterForCompetitionResult>;
  requestJoinTeam(competitionId: string, competitionTeamId: string, requestingGamingMemberId: string): Promise<RequestJoinTeamResult>;
  decideJoinRequest(competitionJoinRequestId: string, decidingGamingMemberId: string, decision: "APPROVE" | "REJECT", isOrganizerOverride: boolean): Promise<DecideJoinRequestResult>;
  organizerReviewJoinRequest(competitionJoinRequestId: string, organizerGamingMemberId: string, decision: "APPROVE" | "REJECT", reason: string): Promise<OrganizerReviewJoinRequestResult>;

  declareRoster(
    competitionFixtureId: string,
    competitionTeamId: string,
    declaringGamingMemberId: string,
    isOrganizerAction: boolean,
    reason: string | null,
    gamingMemberIds: string[]
  ): Promise<DeclareRosterResult>;

  checkIn(competitionFixtureId: string, gamingMemberId: string): Promise<CheckInResult>;
  appointScorekeeper(competitionFixtureId: string, organizerGamingMemberId: string, scorekeeperGamingMemberId: string): Promise<AppointScorekeeperResult>;

  submitFixtureEvidence(
    competitionFixtureId: string,
    scorekeeperGamingMemberId: string,
    teamAScore: number,
    teamBScore: number,
    goalEvents: GoalEventInput[],
    assistEvents: AssistEventInput[],
    participationAttestations: ParticipationAttestationInput[],
    penaltyShootoutWinningTeamId: string | null
  ): Promise<SubmitFixtureEvidenceResult>;

  raiseDispute(competitionFixtureId: string, raisedByGamingMemberId: string, targetFactType: string, targetFactId: string, reason: string): Promise<RaiseDisputeResult>;

  correctFixture(
    competitionFixtureId: string,
    organizerGamingMemberId: string,
    reason: string,
    teamAScore: number,
    teamBScore: number,
    goalEvents: GoalEventInput[],
    assistEvents: AssistEventInput[],
    penaltyShootoutWinningTeamId: string | null
  ): Promise<CorrectFixtureResult>;

  finalizeFixture(competitionFixtureId: string, organizerGamingMemberId: string): Promise<FinalizeFixtureResult>;
  forfeitFixture(competitionFixtureId: string, organizerGamingMemberId: string, forfeitingCompetitionTeamId: string, reason: string): Promise<ForfeitFixtureResult>;
  voidFixture(competitionFixtureId: string, organizerGamingMemberId: string, reason: string): Promise<VoidFixtureResult>;

  // Read accessors — role-aware projection is built above these by
  // getCompetitionView.ts, never by a route reading raw rows directly.
  listCompetitions(): Promise<CompetitionRecord[]>;
  getCompetitionById(competitionId: string): Promise<CompetitionRecord | null>;
  getCompetitionTeams(competitionId: string): Promise<CompetitionTeamRecord[]>;
  getCompetitionTeamById(competitionTeamId: string): Promise<CompetitionTeamRecord | null>;
  getCompetitionFixtures(competitionId: string): Promise<CompetitionFixtureRecord[]>;
  getFixtureById(competitionFixtureId: string): Promise<CompetitionFixtureRecord | null>;
  getMyRegistration(competitionId: string, gamingMemberId: string): Promise<CompetitionRegistrationRecord | null>;
  getMyTeamMembership(competitionId: string, gamingMemberId: string): Promise<CompetitionTeamMembershipRecord | null>;
  getMyPendingJoinRequest(competitionId: string, gamingMemberId: string): Promise<CompetitionJoinRequestRecord | null>;
  getPendingJoinRequestsForTeam(competitionTeamId: string): Promise<CompetitionJoinRequestRecord[]>;
  getTeamMemberships(competitionTeamId: string): Promise<CompetitionTeamMembershipRecord[]>;
  /** Batched display-name lookup — never a per-id round trip. Missing ids (a deleted/never-created member) are simply absent from the returned map. */
  getDisplayNames(gamingMemberIds: string[]): Promise<Record<string, string>>;
  getCurrentRoster(competitionFixtureId: string, competitionTeamId: string): Promise<CompetitionRosterRevisionRecord | null>;
  getCheckIns(competitionFixtureId: string): Promise<CompetitionCheckInRecord[]>;
  getCurrentAttestations(competitionFixtureId: string): Promise<CompetitionParticipationAttestationRecord[]>;
  getCurrentEvidence(competitionFixtureId: string): Promise<CompetitionFixtureEvidenceRecord | null>;
  getCurrentGoalEvents(competitionFixtureId: string): Promise<SoccerGoalEventRecord[]>;
  getCurrentAssistEvents(competitionFixtureId: string): Promise<SoccerAssistEventRecord[]>;
  getCurrentShootout(competitionFixtureId: string): Promise<SoccerPenaltyShootoutRecord | null>;
  getDisputes(competitionFixtureId: string): Promise<CompetitionDisputeRecord[]>;
  getCurrentFinalization(competitionFixtureId: string): Promise<CompetitionFixtureFinalizationRecord | null>;
  getMemberParticipationRecords(competitionId: string, gamingMemberId: string): Promise<CompetitionMemberParticipationRecord[]>;
}
