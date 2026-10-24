import type { SoccerFormatKey } from "./formats";

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

/**
 * DRAFT -> TEAM_REGISTRATION_OPEN -> READY_TO_PUBLISH -> PUBLISHED ->
 * COMPLETE | CANCELLED_WITHOUT_CHAMPION (UG-CR-RPT-041 §3/§4; Founder
 * decision 1 — one unified lifecycle for both organizer-created and
 * member-proposed teams). TEAM_REGISTRATION_OPEN and READY_TO_PUBLISH
 * are the two states this correction inserts between the original
 * DRAFT and PUBLISHED; every other transition is unchanged.
 */
export type CompetitionState = "DRAFT" | "TEAM_REGISTRATION_OPEN" | "READY_TO_PUBLISH" | "PUBLISHED" | "COMPLETE" | "CANCELLED_WITHOUT_CHAMPION";

export interface CompetitionRecord {
  competitionId: string;
  /** Opaque, non-identifying public identifier (UG-CR-GATE-081 Phase 3A) — the only competition identifier ever placed in a user-visible URL or invitation. Never derived from competitionId; see lib/gaming/competitions/publicCode.ts. */
  publicCode: string;
  /**
   * The competition's soccer format key. Every creation path still accepts only SOCCER_5V5; the type is the registry's closed set because
   * the database now records formats through a foreign key to competition_format_rules (UG-CR-GATE-SSS-001).
   */
  activityKey: SoccerFormatKey;
  name: string;
  organizerGamingMemberId: string;
  state: CompetitionState;
  cancelledReason: string | null;
  createdAt: string;
  publishedAt: string | null;
  /**
   * UG-CR-GATE-088 (Become a Host). True when this competition is the single
   * pilot created through an approved host capability. It is then a private,
   * unlisted competition reached through its invitation link, never through
   * the shared competition list. Absent/false for every internally created
   * (OPERATIONAL) competition, whose behavior is unchanged.
   */
  hostBound?: boolean;
  /**
   * UG-CR-GATE-088. True when the host capability bound to this competition
   * has been revoked. The organizer id is kept (history is preserved), but the
   * former host no longer holds organizer access: every TypeScript-side
   * organizer check goes through isActiveOrganizer(), and every organizer RPC
   * refuses with HOST_ACCESS_REVOKED.
   */
  hostAccessRevoked?: boolean;
}

/**
 * status/provenance (UG-CR-RPT-041 §4): every organizer-created row
 * (add_competition_team_atomically) is ACCEPTED/ORGANIZER_CREATED from
 * insertion; a member-proposed row (propose_competition_team_atomically)
 * starts PENDING_ORGANIZER_APPROVAL/MEMBER_PROPOSED and only becomes
 * ACCEPTED (or REJECTED, permanently, with a required reason) via
 * decide_competition_team_atomically. captainGamingMemberId is always
 * the proposer for a MEMBER_PROPOSED row — there is no separate
 * "proposed by" field, since Founder decision 9 makes the proposer and
 * the eventual captain the same person by construction.
 */
export type CompetitionTeamStatus = "PENDING_ORGANIZER_APPROVAL" | "ACCEPTED" | "REJECTED";
export type CompetitionTeamProvenance = "ORGANIZER_CREATED" | "MEMBER_PROPOSED";

export interface CompetitionTeamRecord {
  competitionTeamId: string;
  /** Opaque, non-identifying public identifier (UG-CR-GATE-081 Phase 3A) — paired with the owning competition's own publicCode to form an invitation link; never derived from competitionTeamId. */
  publicCode: string;
  competitionId: string;
  name: string;
  captainGamingMemberId: string;
  captainDisplayName?: string;
  status: CompetitionTeamStatus;
  provenance: CompetitionTeamProvenance;
  decidedAt: string | null;
  decidedByGamingMemberId: string | null;
  rejectionReason: string | null;
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
  requestingGamingMemberDisplayName?: string;
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
  gamingMemberDisplayName?: string;
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

export interface OpenTeamRegistrationResult {
  competitionId: string;
  state: CompetitionState;
}

export interface ProposeCompetitionTeamResult {
  competitionTeamId: string;
  status: CompetitionTeamStatus;
  createdAt: string;
}

export interface DecideCompetitionTeamResult {
  competitionTeamId: string;
  status: CompetitionTeamStatus;
  decidedAt: string;
  competitionTeamMembershipId: string | null;
}

export interface CloseTeamRegistrationResult {
  competitionId: string;
  state: CompetitionState;
  /**
   * UG-CR-GATE-SSS-007. The close operation is the registration FREEZE checkpoint. When the competition has a recorded freeze, this is what the
   * organizer is shown of it: team names and counts only — never an identifier, the digest or the actor. Absent for a competition with no freeze.
   */
  freeze?: RegistrationFreezeSummary;
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

/** RESOLVE_COMPETITION_PUBLIC_CODE (UG-CR-GATE-081 Phase 3A) — the bare real id, nothing else; authorization for whatever happens next is unaffected by this lookup. */
export interface ResolveCompetitionPublicCodeResult {
  competitionId: string;
}

/** RESOLVE_COMPETITION_TEAM_PUBLIC_CODE — both bare real ids, nothing else. */
export interface ResolveCompetitionTeamPublicCodeResult {
  competitionId: string;
  competitionTeamId: string;
}

/** CANCEL_INCOMPLETE_COMPETITION (UG-CR-GATE-081 Phase 3E). */
export interface CancelCompetitionResult {
  competitionId: string;
  state: CompetitionState;
  cancelledReason: string;
  alreadyCancelled: boolean;
}

/**
 * Role-aware read model for GET_COMPETITION — see getCompetitionView.ts.
 *
 * UG-CR-RPT-041 §7/§10: `teams` is always ACCEPTED-only, for every
 * viewer — a pending or rejected proposal never appears there,
 * regardless of who is looking, so "the real teams in this tournament"
 * keeps one truthful meaning independent of role. `pendingTeamProposals`
 * and `rejectedTeamProposals` are organizer-only (empty arrays for
 * every other viewer) — the review queue and rejection history.
 * `myTeamProposals` is the one proposer-visibility exception: every
 * viewer, organizer or not, sees their OWN pending/rejected proposals
 * (with reason) here, and only their own — never another member's
 * rejected attempt. `myTeamMemberships` lists the confirmed members
 * (with display names) of the caller's OWN current team, when they
 * have one — never another team's roster of members.
 */
export interface CompetitionView {
  competition: CompetitionRecord;
  teams: CompetitionTeamRecord[];
  pendingTeamProposals: CompetitionTeamRecord[];
  rejectedTeamProposals: CompetitionTeamRecord[];
  myTeamProposals: CompetitionTeamRecord[];
  fixtures: CompetitionFixtureViewEntry[];
  myRegistration: CompetitionRegistrationRecord | null;
  myTeamMembership: CompetitionTeamMembershipRecord | null;
  myTeamMemberships: CompetitionTeamMembershipRecord[];
  myPendingJoinRequest: CompetitionJoinRequestRecord | null;
  myPersistentRecords: CompetitionMemberParticipationRecord[];
  isOrganizer: boolean;
  /**
   * UG-CR-GATE-100 — the ids of the fixtures of THIS competition the viewer is currently appointed to score (empty when none). The member
   * competition page offers its scorekeeper action only when this is non-empty; the scorekeeper-administration route re-confirms it.
   */
  myScorekeeperFixtureIds: string[];
  /**
   * UG-CR-GATE-SSS-007 — the bounded registration status of THIS addressed competition, derived by the server (and the database clock). It is the
   * only place a member learns the deadline; the general list never carries it. null for a draft (its plan is still a draft) and for a competition that
   * has no usable plan — and for a competition that is not a draft, null means CLOSED: nothing is offered and the database refuses every new write. The
   * browser renders it and never decides from it that a write is allowed: the database decides every write.
   */
  registration: RegistrationStatus | null;
  /** Organizer only, while registration is open: what the freeze still needs, as counts. null for everyone else and once frozen. */
  registrationReadiness: RegistrationReadiness | null;
  /** Organizer only, once frozen: team names and counts. null for everyone else. */
  registrationFreeze: RegistrationFreezeSummary | null;
  /**
   * UG-CR-GATE-SSS-011 — present ONLY while the competition is ready to publish with registration frozen, and only for the active organizer and the
   * frozen captains: which of the two the caller is. The key is absent (not null) for everyone else, so the view of anyone unrelated is unchanged. It
   * carries no proposal, no digest and no decision: the amendment route answers those, for these two roles alone.
   */
  planAmendment?: { organizer: boolean; captain: boolean };
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
  constructor() { super("Registration is only open once the organizer has opened team registration."); this.name = "CompetitionNotPublishedError"; }
}
export class CompetitionNotReadyToPublishError extends Error {
  constructor() { super("A competition may only be published once team registration has been closed with exactly four accepted teams."); this.name = "CompetitionNotReadyToPublishError"; }
}
export class TeamRegistrationNotOpenError extends Error {
  constructor(message = "Team registration is not currently open.") { super(message); this.name = "TeamRegistrationNotOpenError"; }
}
export class TeamRegistrationCapacityNotReachedError extends Error {
  constructor(message = "Exactly four accepted teams are required to close team registration.") { super(message); this.name = "TeamRegistrationCapacityNotReachedError"; }
}
export class TeamCapacityReachedError extends Error {
  constructor() { super("Four teams have already been accepted for this competition."); this.name = "TeamCapacityReachedError"; }
}
export class TeamDecisionAlreadyMadeError extends Error {
  constructor() { super("This team proposal has already been decided."); this.name = "TeamDecisionAlreadyMadeError"; }
}
export class DuplicateTeamNameError extends Error {
  constructor() { super("A team with this name already exists in this competition."); this.name = "DuplicateTeamNameError"; }
}
export class AlreadyCaptainOrMemberError extends Error {
  constructor() { super("This member already holds an active team role in this competition."); this.name = "AlreadyCaptainOrMemberError"; }
}
export class TeamNotAcceptedError extends Error {
  constructor() { super("This team has not yet been accepted for this competition."); this.name = "TeamNotAcceptedError"; }
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
  /**
   * `minimum` is the threshold of the competition's OWN format (UG-CR-GATE-SSS-001). The default is 5v5's historical four, so the
   * no-argument error is exactly the message it always was. `null` means the threshold could not be read from the database message;
   * the error then states no number rather than guessing one.
   */
  constructor(minimum: number | null = 4) {
    super(
      minimum === null
        ? "Each team requires its format's minimum number of actually-participating rostered members for a normal result — use forfeit or void instead."
        : `Each team requires at least ${minimum} actually-participating rostered members for a normal result — use forfeit or void instead.`
    );
    this.name = "MinimumParticipationNotMetError";
  }
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
export class CompetitionNotCancellableError extends Error {
  constructor(message = "Only a draft, registering, or ready-to-publish competition may be cancelled this way.") { super(message); this.name = "CompetitionNotCancellableError"; }
}
/** UG-CR-GATE-082 (REV-053 #3) — raised by every mutation this domain's cancellation must deny once a competition is CANCELLED_WITHOUT_CHAMPION. */
export class CompetitionCancelledError extends Error {
  constructor() { super("This competition has been cancelled and no longer accepts this action."); this.name = "CompetitionCancelledError"; }
}

/** UG-CR-GATE-088 — a former host acted on a competition after their hosting access was revoked. */
export class HostAccessRevokedError extends Error {
  constructor(message = "Your hosting access has been revoked. You can no longer administer this competition.") { super(message); this.name = "HostAccessRevokedError"; }
}

/**
 * UG-CR-GATE-089 — a roster was declared for a team that is not one of the fixture's two team slots, or that belongs to
 * another competition. One stable, bounded error for every identifier mismatch (including an unknown fixture): it says
 * nothing about which fixtures, teams or competitions exist.
 */
export class FixtureTeamScopeError extends Error {
  constructor() { super("This team is not part of this fixture."); this.name = "FixtureTeamScopeError"; }
}

// ---------------------------------------------------------------------
// UG-CR-GATE-SSS-004 — Organizer Planning foundation.
//
// A competition-specific DRAFT PLAN, recorded as an append-only sequence of immutable revisions. These are plain data shapes only; the
// validation, the typed planning errors and the commands live in planning.ts (an error exported from this file would have to be mapped in
// httpAuth.ts's status table, and a planning refusal is judged by the planning route, which owns its own wording).
//
// A plan is not venue approval, not a verified claim about a venue, and not a schedule: it records validated planning capacity only.
// The format is never a plan input — it is the competition's own, and each revision records it.
// ---------------------------------------------------------------------

export interface CompetitionPlanningVenue {
  name: string;
  locationDescription: string;
  /** A confirmed IANA time zone; every date, window and the registration deadline are in it. */
  timeZone: string;
  /** How many matches the venue can host at once: from one up to the number of usable pitches. */
  simultaneousMatchCapacity: number;
  restrictionNotes: string;
}

export interface CompetitionPlanningPitch {
  /** Unique (ignoring case) within one revision. */
  label: string;
  usable: boolean;
  /** A closed subset of the registry's format keys. */
  supportedFormats: SoccerFormatKey[];
  restrictionNotes: string;
}

export interface CompetitionPlanningWindow {
  /** Venue-local, 24-hour HH:MM; the window never crosses midnight. */
  start: string;
  end: string;
}

export interface CompetitionPlanningDate {
  /** A real calendar day, YYYY-MM-DD, in the venue's time zone. */
  date: string;
  windows: CompetitionPlanningWindow[];
}

export interface CompetitionPlanningDeadline {
  /** The venue-local wall-clock time, YYYY-MM-DDTHH:MM. */
  local: string;
  timeZone: string;
  /** The UTC offset in force at that local time, ±HH:MM. */
  utcOffset: string;
  /** The one authoritative instant, as an ISO-8601 UTC timestamp. Always consistent with the three fields above. */
  utc: string;
}

/** What an organizer may state in a plan, validated and normalized. Roster values are explicit (registry defaults are filled in). */
export interface CompetitionPlanningPlan {
  venue: CompetitionPlanningVenue;
  pitches: CompetitionPlanningPitch[];
  dates: CompetitionPlanningDate[];
  roster: { minimum: number; maximum: number };
  registrationDeadline: CompetitionPlanningDeadline;
  rules: { version: string; snapshot: string };
}

/** A saved revision as the server holds it. Never returned to a browser as is: see publicRevision() in planning.ts. */
export interface CompetitionPlanningRevisionRecord extends CompetitionPlanningPlan {
  planningRevisionId: string;
  competitionId: string;
  /** Immutable: the competition's own format when the revision was saved. */
  formatKey: SoccerFormatKey;
  revisionNumber: number;
  supersedesRevisionNumber: number | null;
  authoredByGamingMemberId: string;
  createdAt: string;
  rules: { version: string; snapshot: string; snapshotDigest: string };
}

export interface SavePlanningRevisionResult {
  revision: CompetitionPlanningRevisionRecord;
  /** True when the same intent and payload had already been saved: nothing new was written. */
  alreadySaved: boolean;
  /** False only for a replay of an earlier revision that a newer one has since superseded. */
  isCurrent: boolean;
}

// ---------------------------------------------------------------------
// UG-CR-GATE-SSS-007 — Registration Deadline and Competition Freeze foundation.
//
// The authoritative deadline is the UTC instant of a competition's CURRENT Organizer Planning revision, judged by the database clock inside each
// atomic operation. These are plain data shapes only; the typed refusals, the digest and the summaries live in registrationFreeze.ts (an error
// exported from this file would have to be mapped in httpAuth.ts's status table, and the freeze refusals are judged by the two routes that raise them).
// ---------------------------------------------------------------------

/**
 * What the server read about a competition's registration: the deadline facts and whether the DATABASE says new entries are accepted right now.
 * The roster bounds are the plan's own and are for the organizer's readiness only: they are never part of {@link RegistrationStatus}.
 */
export interface RegistrationStatusRead {
  /** The one authoritative instant, ISO-8601 UTC. */
  deadlineUtc: string;
  /** The venue's IANA time zone. */
  timeZone: string;
  /** The deadline as the venue's wall clock, YYYY-MM-DDTHH:MM. */
  deadlineLocal: string;
  /** True when the database clock is at or after the deadline. */
  deadlinePassed: boolean;
  /** True only while the competition is open, not frozen and before the deadline, by the database clock. */
  acceptingNewWrites: boolean;
  frozen: boolean;
  rosterMinimum: number;
  rosterMaximum: number;
}

/** The bounded registration status a member is shown: exactly these six facts, and nothing else of the plan. */
export type RegistrationStatus = Pick<RegistrationStatusRead, "deadlineUtc" | "timeZone" | "deadlineLocal" | "deadlinePassed" | "acceptingNewWrites" | "frozen">;

/** A team's name and how many competitive members it has: all an organizer's readiness or freeze summary says about a team. */
export interface RegistrationTeamCount {
  name: string;
  memberCount: number;
}

/** What the freeze still needs, for the organizer. The server judges every one of these again when the freeze is requested. */
export interface RegistrationReadiness {
  deadlinePassed: boolean;
  acceptedTeamCount: number;
  pendingProposalCount: number;
  pendingJoinRequestCount: number;
  rosterMinimum: number;
  rosterMaximum: number;
  teams: RegistrationTeamCount[];
}

/** The recorded freeze as an organizer is shown it: names and counts. No identifier, no digest, no actor. */
export interface RegistrationFreezeSummary {
  frozenAt: string;
  registrationDeadlineUtc: string;
  rosterMinimum: number;
  rosterMaximum: number;
  teamCount: number;
  memberCount: number;
  teams: RegistrationTeamCount[];
}

/** A recorded freeze exactly as the server holds it (never returned to a browser as is). Teams are in their frozen order; members are sorted. */
export interface RegistrationFreezeRecord {
  registrationFreezeId: string;
  competitionId: string;
  planningRevisionId: string;
  formatKey: SoccerFormatKey;
  rosterMinimum: number;
  rosterMaximum: number;
  registrationDeadlineUtc: string;
  frozenAt: string;
  frozenByGamingMemberId: string;
  teamCount: number;
  memberCount: number;
  snapshotDigest: string;
  teams: Array<{
    position: number;
    competitionTeamId: string;
    captainGamingMemberId: string;
    memberCount: number;
    memberGamingMemberIds: string[];
  }>;
}

// ---------------------------------------------------------------------
// UG-CR-GATE-SSS-011 — Post-Freeze Plan Amendment backend foundation.
//
// After registration is frozen the organizer may PROPOSE a change to the venue's description, the pitches and the dates and windows; the four frozen
// captains must all confirm it before it becomes the next immutable planning revision. These are plain data shapes only; the typed refusals, the digest,
// the allowlist and the commands live in planAmendment.ts (an error exported from this file would have to be mapped in httpAuth.ts's status table, and an
// amendment refusal is judged by the three amendment routes, which own their wording and status).
// ---------------------------------------------------------------------

/** The amendable facts of a plan, and nothing else: the venue's description, the pitches and the dates. Everything else is preserved from the current revision. */
export interface PlanAmendmentFacts {
  venue: { name: string; locationDescription: string; restrictionNotes: string; simultaneousMatchCapacity: number };
  pitches: CompetitionPlanningPitch[];
  dates: CompetitionPlanningDate[];
}

/** A proposal's status is DERIVED: its resolution, else EXPIRED by the database clock alone, else PENDING. */
export type PlanAmendmentStatus = "PENDING" | "ACTIVATED" | "REJECTED" | "WITHDRAWN" | "SUPERSEDED" | "EXPIRED";
export type PlanAmendmentDecision = "CONFIRMED" | "REJECTED";

export interface ProposePlanAmendmentResult {
  digest: string;
  sequenceNumber: number;
  createdAt: string;
  expiresAt: string;
  /** True for an exact replay of an earlier proposal: nothing new was written. */
  alreadyProposed: boolean;
  /** The digest of the proposal this one superseded, if one was still effective. */
  supersededDigest: string | null;
}

export interface DecidePlanAmendmentResult {
  decision: PlanAmendmentDecision;
  status: PlanAmendmentStatus;
  confirmedCount: number;
  requiredCount: number;
  /** True when this team had already given this very answer: nothing new was written. */
  alreadyDecided: boolean;
  /** The number of the planning revision this confirmation created, once the proposal is activated. */
  activatedRevisionNumber: number | null;
}

export interface WithdrawPlanAmendmentResult {
  status: "WITHDRAWN";
  alreadyWithdrawn: boolean;
}

/** What the database tells ONE caller about the latest proposal (server shape; see publicPlanAmendmentStatus in planAmendment.ts for what a browser may see). */
export interface PlanAmendmentStatusRecord {
  role: { organizer: boolean; captain: boolean };
  /** True while the amendment window is open: ready to publish, frozen, consistent, and nothing drawn, scheduled or played. */
  windowOpen: boolean;
  /** The caller's own frozen team's name, for a captain. */
  myTeamName: string | null;
  amendment: {
    digest: string;
    sequenceNumber: number;
    status: PlanAmendmentStatus;
    /** True only while the proposal is pending and the window is open. */
    actionable: boolean;
    createdAt: string;
    expiresAt: string;
    resolvedAt: string | null;
    confirmedCount: number;
    requiredCount: number;
    /** One entry per frozen team, in frozen order; the decision is null until that team has answered. */
    teams: Array<{ teamName: string; decision: PlanAmendmentDecision | null }>;
    /** The caller's own team's answer, for a captain. */
    myDecision: PlanAmendmentDecision | null;
    proposed: PlanAmendmentFacts;
    current: PlanAmendmentFacts;
  } | null;
  /** Organizer only: the most recent proposals, oldest first. null for a captain. */
  history: Array<{ sequenceNumber: number; status: PlanAmendmentStatus; createdAt: string; resolvedAt: string | null }> | null;
}
