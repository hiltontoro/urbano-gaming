/**
 * URBANO Gaming Competitions — Soccer Slice 001.
 *
 * Independently-owned domain (UG-CR-REV-017 decision 4): every entity
 * here is deliberately distinct from Predictions'/Session's own
 * entities of similar shape (UG-CR-RPT-018's naming-collision finding).
 * Organizer/captain/scorekeeper authority is scoped directly via
 * foreign-key fields on these records, never the global
 * authority_grants/PlatformAuthorityClass system — the sole exception
 * is that *creating* a competition requires the caller to independently
 * hold active platform OPERATIONAL authority (UG-CR-REV-026 condition
 * 1), checked once, server-side, never stored here.
 */

export type CompetitionState = "DRAFT" | "PUBLISHED" | "COMPLETE" | "CANCELLED_WITHOUT_CHAMPION";

export interface CompetitionRecord {
  competitionId: string;
  activityKey: "SOCCER_5V5";
  name: string;
  organizerGamingMemberId: string;
  state: CompetitionState;
  cancelledReason: string | null;
  createdAt: string;
  publishedAt: string | null;
}

export interface CompetitionTeamRecord {
  competitionTeamId: string;
  competitionId: string;
  name: string;
  captainGamingMemberId: string;
  createdAt: string;
}

export interface CompetitionRegistrationRecord {
  competitionRegistrationId: string;
  competitionId: string;
  gamingMemberId: string;
  isAdultSelfAttested: boolean;
  registeredAt: string;
}

export type JoinRequestStatus = "REQUESTED" | "APPROVED" | "REJECTED";

export interface CompetitionJoinRequestRecord {
  competitionJoinRequestId: string;
  competitionId: string;
  competitionTeamId: string;
  requestingGamingMemberId: string;
  status: JoinRequestStatus;
  decidedByGamingMemberId: string | null;
  decidedAt: string | null;
  organizerReviewedAt: string | null;
  organizerReviewedByGamingMemberId: string | null;
  createdAt: string;
}

export interface CompetitionTeamMembershipRecord {
  competitionTeamMembershipId: string;
  competitionId: string;
  competitionTeamId: string;
  gamingMemberId: string;
  approvedAt: string;
  approvedByGamingMemberId: string;
}

export type FixtureRole = "SEMIFINAL_1" | "SEMIFINAL_2" | "FINAL";
export type FixtureState =
  | "SCHEDULED"
  | "ROSTER_DECLARED"
  | "CHECKIN_OPEN"
  | "EVIDENCE_SUBMITTED"
  | "UNDER_REVIEW"
  | "FINALIZED"
  | "CORRECTED_AND_FINALIZED"
  | "VOID"
  | "FORFEIT_FINALIZED";

export interface CompetitionFixtureRecord {
  competitionFixtureId: string;
  competitionId: string;
  fixtureRole: FixtureRole;
  scheduledAt: string;
  teamACompetitionTeamId: string | null;
  teamBCompetitionTeamId: string | null;
  teamASourceFixtureId: string | null;
  teamBSourceFixtureId: string | null;
  state: FixtureState;
  scorekeeperGamingMemberId: string | null;
  createdAt: string;
}

export interface CompetitionRosterRevisionRecord {
  competitionRosterRevisionId: string;
  competitionFixtureId: string;
  competitionTeamId: string;
  declaredByGamingMemberId: string;
  declaredAt: string;
  reason: string | null;
  supersedesRevisionId: string | null;
  isCurrent: boolean;
  gamingMemberIds: string[];
}

export interface CompetitionCheckInRecord {
  competitionCheckinId: string;
  competitionFixtureId: string;
  gamingMemberId: string;
  checkedInAt: string;
}

export interface CompetitionParticipationAttestationRecord {
  competitionParticipationAttestationId: string;
  competitionFixtureId: string;
  gamingMemberId: string;
  actuallyParticipated: boolean;
  attestedByGamingMemberId: string;
  attestedAt: string;
  supersedesAttestationId: string | null;
  isCurrent: boolean;
}

export interface CompetitionFixtureEvidenceRecord {
  competitionFixtureEvidenceId: string;
  competitionFixtureId: string;
  teamAScore: number;
  teamBScore: number;
  enteredByGamingMemberId: string;
  enteredAt: string;
  supersedesEvidenceId: string | null;
  isCurrent: boolean;
}

export interface SoccerGoalEventRecord {
  soccerGoalEventId: string;
  competitionFixtureId: string;
  scorerGamingMemberId: string;
  competitionTeamId: string;
  enteredByGamingMemberId: string;
  enteredAt: string;
  isCurrent: boolean;
}

export interface SoccerAssistEventRecord {
  soccerAssistEventId: string;
  competitionFixtureId: string;
  assistingGamingMemberId: string;
  assistedGoalEventId: string;
  enteredByGamingMemberId: string;
  enteredAt: string;
  isCurrent: boolean;
}

export interface SoccerPenaltyShootoutRecord {
  soccerPenaltyShootoutId: string;
  competitionFixtureId: string;
  winningCompetitionTeamId: string;
  enteredByGamingMemberId: string;
  enteredAt: string;
  isCurrent: boolean;
}

export type DisputeTargetFactType = "PARTICIPATION_ATTESTATION" | "SCORE" | "GOAL_EVENT" | "ASSIST_EVENT";
export type DisputeResolutionAction = "CORRECTED" | "VOIDED" | "FINALIZED_AS_SUBMITTED";

export interface CompetitionDisputeRecord {
  competitionDisputeId: string;
  competitionFixtureId: string;
  raisedByGamingMemberId: string;
  targetFactType: DisputeTargetFactType;
  targetFactId: string;
  reason: string;
  raisedAt: string;
  resolvedAt: string | null;
  resolvedByGamingMemberId: string | null;
  resolutionAction: DisputeResolutionAction | null;
}

export type FixtureFinalizationOutcome = "NORMAL" | "FORFEIT" | "VOID";

export interface CompetitionFixtureFinalizationRecord {
  competitionFixtureFinalizationId: string;
  competitionFixtureId: string;
  finalizedByGamingMemberId: string;
  finalizedAt: string;
  outcomeType: FixtureFinalizationOutcome;
  winningCompetitionTeamId: string | null;
  reason: string | null;
  supersedesFinalizationId: string | null;
  isCurrent: boolean;
}

export interface CompetitionMemberParticipationRecord {
  competitionMemberParticipationRecordId: string;
  competitionId: string;
  competitionFixtureId: string;
  gamingMemberId: string;
  appeared: boolean;
  goals: number;
  assists: number;
  derivedFromFinalizationId: string;
  derivedAt: string;
  isCurrent: boolean;
}

/** One goal-event input within an evidence submission or correction. */
export interface GoalEventInput {
  scorerGamingMemberId: string;
  competitionTeamId: string;
}

/** goalEventIndex indexes the goalEvents array of the same submission. */
export interface AssistEventInput {
  assistingGamingMemberId: string;
  goalEventIndex: number;
}

export interface ParticipationAttestationInput {
  gamingMemberId: string;
  actuallyParticipated: boolean;
}

export interface StartCompetitionResult {
  competitionId: string;
  state: CompetitionState;
  createdAt: string;
}

export interface AddCompetitionTeamResult {
  competitionTeamId: string;
  createdAt: string;
}

export interface PublishCompetitionResult {
  competitionId: string;
  state: CompetitionState;
  publishedAt: string;
  semifinal1FixtureId: string;
  semifinal2FixtureId: string;
  finalFixtureId: string;
}

export interface RegisterForCompetitionResult {
  competitionRegistrationId: string;
  registeredAt: string;
  alreadyRegistered: boolean;
}

export interface RequestJoinTeamResult {
  competitionJoinRequestId: string;
  status: JoinRequestStatus;
  createdAt: string;
}

export interface DecideJoinRequestResult {
  competitionJoinRequestId: string;
  status: JoinRequestStatus;
  decidedAt: string;
  competitionTeamMembershipId: string | null;
}

export interface OrganizerReviewJoinRequestResult {
  competitionJoinRequestId: string;
  status: JoinRequestStatus;
  organizerReviewedAt: string;
  competitionTeamMembershipId: string | null;
}

export interface DeclareRosterResult {
  competitionRosterRevisionId: string;
  declaredAt: string;
  fixtureState: FixtureState;
}

export interface CheckInResult {
  competitionCheckinId: string;
  checkedInAt: string;
  alreadyCheckedIn: boolean;
}

export interface AppointScorekeeperResult {
  competitionFixtureId: string;
  scorekeeperGamingMemberId: string;
}

export interface SubmitFixtureEvidenceResult {
  competitionFixtureEvidenceId: string;
  fixtureState: FixtureState;
  alreadySubmitted: boolean;
}

export interface RaiseDisputeResult {
  competitionDisputeId: string;
  raisedAt: string;
}

export type CascadeOutcome = "NONE" | "FINALIST_REPLACED_BEFORE_CHECKIN" | "COMPETITION_CANCELLED_AFTER_FINAL_CHECKIN";

export interface CorrectFixtureResult {
  competitionFixtureEvidenceId: string;
  newWinningCompetitionTeamId: string | null;
  competitionState: CompetitionState;
  cascadeOutcome: CascadeOutcome;
}

export interface FinalizeFixtureResult {
  competitionFixtureFinalizationId: string;
  outcomeType: FixtureFinalizationOutcome;
  winningCompetitionTeamId: string | null;
  alreadyFinalized: boolean;
}

export interface ForfeitFixtureResult {
  competitionFixtureFinalizationId: string;
  winningCompetitionTeamId: string;
  alreadyFinalized: boolean;
}

export interface VoidFixtureResult {
  competitionFixtureFinalizationId: string;
  competitionState: CompetitionState;
  alreadyFinalized: boolean;
}

/** Role-aware read model for GET_COMPETITION — see getCompetitionView.ts. */
export interface CompetitionView {
  competition: CompetitionRecord;
  teams: CompetitionTeamRecord[];
  fixtures: CompetitionFixtureViewEntry[];
  myRegistration: CompetitionRegistrationRecord | null;
  myTeamMembership: CompetitionTeamMembershipRecord | null;
  myPendingJoinRequest: CompetitionJoinRequestRecord | null;
  myPersistentRecords: CompetitionMemberParticipationRecord[];
}

export interface CompetitionFixtureViewEntry {
  fixture: CompetitionFixtureRecord;
  myRoster: string[] | null;
  opponentRosterDeclared: boolean;
  score: { competitionFixtureEvidenceId: string; teamAScore: number; teamBScore: number } | null;
  goalScorers: Array<{ gamingMemberId: string; competitionTeamId: string }> | null;
  assistProviders: Array<{ gamingMemberId: string; goalEventIndex: number }> | null;
  finalization: CompetitionFixtureFinalizationRecord | null;
  /**
   * The AUTHENTICATED VIEWER's own current, disputable facts for this
   * fixture — never another member's (UG-CR-GATE-033). Populated only
   * once evidence is visible; each id here is CURRENT (a superseded
   * fact is never included, since it is filtered from the same
   * already-current-only queries score/goalScorers/assistProviders
   * themselves read from). null outside evidence-visible states,
   * mirroring score/goalScorers/assistProviders.
   */
  myDisputableFacts: {
    participationAttestationId: string | null;
    goalEventIds: string[];
    assistEventIds: string[];
  } | null;
}

// ---------------------------------------------------------------------
// Error classes — mirror the established XNotFoundError/XAccessDeniedError
// convention used throughout this repository's Session/Duel/Predictions
// domains.
// ---------------------------------------------------------------------

export class CompetitionNotFoundError extends Error {
  constructor() { super("No such competition exists."); this.name = "CompetitionNotFoundError"; }
}
export class CompetitionAccessDeniedError extends Error {
  constructor(message = "Access denied for this competition action.") { super(message); this.name = "CompetitionAccessDeniedError"; }
}
export class OperationalAuthorityRequiredError extends Error {
  constructor() { super("Creating a competition requires active platform OPERATIONAL authority."); this.name = "OperationalAuthorityRequiredError"; }
}
export class CompetitionNotDraftError extends Error {
  constructor() { super("This action is only available while the competition is DRAFT."); this.name = "CompetitionNotDraftError"; }
}
export class CompetitionTeamCountInvalidError extends Error {
  constructor(message: string) { super(message); this.name = "CompetitionTeamCountInvalidError"; }
}
export class CompetitionPairingInvalidError extends Error {
  constructor(message: string) { super(message); this.name = "CompetitionPairingInvalidError"; }
}
export class CompetitionNotPublishedError extends Error {
  constructor() { super("Registration is only open while the competition is PUBLISHED."); this.name = "CompetitionNotPublishedError"; }
}
export class CompetitionTeamNotFoundError extends Error {
  constructor() { super("No such team exists in this competition."); this.name = "CompetitionTeamNotFoundError"; }
}
export class CompetitionRegistrationRequiredError extends Error {
  constructor() { super("Register for this competition before requesting a team."); this.name = "CompetitionRegistrationRequiredError"; }
}
export class AlreadyTeamMemberError extends Error {
  constructor() { super("This member already holds a team membership in this competition."); this.name = "AlreadyTeamMemberError"; }
}
export class DuplicatePendingJoinRequestError extends Error {
  constructor() { super("This member already has a pending join request in this competition."); this.name = "DuplicatePendingJoinRequestError"; }
}
export class JoinRequestNotFoundError extends Error {
  constructor() { super("No such join request exists."); this.name = "JoinRequestNotFoundError"; }
}
export class JoinRequestNotPendingError extends Error {
  constructor() { super("This join request has already been decided."); this.name = "JoinRequestNotPendingError"; }
}
export class NotTeamCaptainError extends Error {
  constructor(message = "Only this team's own captain may perform this action.") { super(message); this.name = "NotTeamCaptainError"; }
}
export class JoinRequestNotRejectedError extends Error {
  constructor() { super("Organizer review only applies to an already-rejected request."); this.name = "JoinRequestNotRejectedError"; }
}
export class JoinRequestAlreadyReviewedError extends Error {
  constructor() { super("This request has already received its one organizer review."); this.name = "JoinRequestAlreadyReviewedError"; }
}
export class ReasonRequiredError extends Error {
  constructor(message = "This action requires a reason.") { super(message); this.name = "ReasonRequiredError"; }
}
export class InvalidDecisionError extends Error {
  constructor() { super("Decision must be APPROVE or REJECT."); this.name = "InvalidDecisionError"; }
}
export class FixtureNotFoundError extends Error {
  constructor() { super("No such fixture exists."); this.name = "FixtureNotFoundError"; }
}
export class FixtureNotOpenForRosterError extends Error {
  constructor() { super("This fixture is no longer open for roster declaration."); this.name = "FixtureNotOpenForRosterError"; }
}
export class RosterMemberNotApprovedError extends Error {
  constructor(message = "A roster entry has no approved membership on this team.") { super(message); this.name = "RosterMemberNotApprovedError"; }
}
export class EmptyRosterError extends Error {
  constructor() { super("A roster must include at least one gaming member."); this.name = "EmptyRosterError"; }
}
export class DuplicateRosterEntryError extends Error {
  constructor() { super("A roster may not list the same gaming member more than once."); this.name = "DuplicateRosterEntryError"; }
}
export class ScorekeeperConflictOfInterestError extends Error {
  constructor(message = "This member has a scorekeeper conflict of interest for this fixture.") { super(message); this.name = "ScorekeeperConflictOfInterestError"; }
}
export class FixtureNotReadyForCheckinError extends Error {
  constructor() { super("This fixture is not currently open for check-in."); this.name = "FixtureNotReadyForCheckinError"; }
}
export class NotOnRosterError extends Error {
  constructor() { super("This member is not on either team's current roster for this fixture."); this.name = "NotOnRosterError"; }
}
export class FixtureNotInEvidencePhaseError extends Error {
  constructor() { super("This fixture is not ready to receive evidence."); this.name = "FixtureNotInEvidencePhaseError"; }
}
export class InvalidScoreError extends Error {
  constructor(message = "Scores must be non-negative.") { super(message); this.name = "InvalidScoreError"; }
}
export class ShootoutRequiredError extends Error {
  constructor() { super("Regulation ended level — a penalty-shootout winner is required."); this.name = "ShootoutRequiredError"; }
}
export class InvalidShootoutWinnerError extends Error {
  constructor() { super("The shootout winner must be one of the two competing teams."); this.name = "InvalidShootoutWinnerError"; }
}
export class InvalidGoalTeamError extends Error {
  constructor(message = "A goal event does not name one of the two competing teams.") { super(message); this.name = "InvalidGoalTeamError"; }
}
export class EvidenceParticipantNotAttestedError extends Error {
  constructor(message = "A credited player is not attested as actually participating.") { super(message); this.name = "EvidenceParticipantNotAttestedError"; }
}
export class InvalidAssistError extends Error {
  constructor() { super("An assist may not be credited to the same player as the goal, or the referenced goal does not exist."); this.name = "InvalidAssistError"; }
}
export class RegulationScoreEventMismatchError extends Error {
  constructor() { super("The regulation score must equal the count of attributed goal events per team."); this.name = "RegulationScoreEventMismatchError"; }
}
export class MinimumParticipationNotMetError extends Error {
  constructor() { super("Each team requires at least 4 actually-participating rostered members for a normal result — use forfeit or void instead."); this.name = "MinimumParticipationNotMetError"; }
}
export class FixtureNotReadyToFinalizeError extends Error {
  constructor() { super("Evidence must be submitted before a fixture can be finalized."); this.name = "FixtureNotReadyToFinalizeError"; }
}
export class EvidenceMissingError extends Error {
  constructor() { super("No current evidence exists for this fixture."); this.name = "EvidenceMissingError"; }
}
export class InvalidForfeitingTeamError extends Error {
  constructor() { super("The forfeiting team must be one of the two competing teams."); this.name = "InvalidForfeitingTeamError"; }
}
export class UnsupportedActivityKeyError extends Error {
  constructor() { super("Only SOCCER_5V5 is supported in Slice 001."); this.name = "UnsupportedActivityKeyError"; }
}
export class UnsupportedTargetFactTypeError extends Error {
  constructor() { super("This target fact type cannot be disputed."); this.name = "UnsupportedTargetFactTypeError"; }
}
export class TargetFactNotFoundError extends Error {
  constructor(message = "No such target fact exists.") { super(message); this.name = "TargetFactNotFoundError"; }
}
export class TargetFactFixtureMismatchError extends Error {
  constructor() { super("The target fact does not belong to this fixture."); this.name = "TargetFactFixtureMismatchError"; }
}
export class TargetFactNotCurrentError extends Error {
  constructor() { super("A superseded fact cannot receive a new dispute."); this.name = "TargetFactNotCurrentError"; }
}
export class DisputeNotAuthorizedError extends Error {
  constructor() { super("You are not authorized to dispute this fact."); this.name = "DisputeNotAuthorizedError"; }
}
