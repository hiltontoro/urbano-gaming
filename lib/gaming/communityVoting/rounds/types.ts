import type { CastCommunityVoteResult, VoterBindingResult } from "../types";

/** Types of the two-round pilot. Nothing here carries an email, an Auth id, a token, a coordinate or a storage path. */

/** The operator context every operator operation carries. The member id comes from a server-verified identity, never a browser. */
export interface OperatorContext {
  instanceId: string;
  hostToken: string;
  operatorMemberId: string;
}

export type RoundRole = "PRELIMINARY" | "FINAL";

export interface RoundInstanceRecord {
  instanceId: string;
  sessionId: string;
  roundRole: RoundRole;
  ruleVersion: number;
  sourceInstanceId: string | null;
  windowSeconds: number | null;
  /** A test (rehearsal) round: fixed when the round is registered and never changed afterwards. */
  isTest: boolean;
  createdAt: string;
}

/** The geofence of the final, entered by the operator. There is no default: the venue's real values are the venue's to give. */
export interface RoundVenue {
  venueLatitude: number;
  venueLongitude: number;
  venueRadiusMeters: number;
  maxAccuracyMeters: number;
  insideMarginFactor: number;
  outsideMarginFactor: number;
}

export interface RegisterRoundInput {
  sessionId: string;
  hostToken: string;
  operatorMemberId: string;
  ruleVersion: number;
  roundRole: RoundRole;
  /** FINAL only: the preliminary it descends from. */
  sourceInstanceId: string | null;
  /** FINAL only. */
  venue: RoundVenue | null;
  /** FINAL only. */
  windowSeconds: number | null;
  /** Register this round as a TEST event. Fixed at registration; there is no operation that changes it later. Absent means a real round. */
  testMode?: boolean;
}

/** A saved geofence, with the instant the save was recorded. */
export interface SavedVenue extends RoundVenue {
  configuredAt: string;
}

/**
 * What the eligibility test says about ONE reading, evaluated by the same database function the vote uses. It carries the decision, the distance
 * and accuracy the server saw (rounded as a vote's evidence is) and the thresholds it used — never a coordinate.
 */
export interface GeofenceTestResult {
  decision: "INSIDE" | "OUTSIDE" | "AMBIGUOUS" | "ACCURACY_EXCESSIVE";
  distanceMeters: number;
  accuracyMeters: number;
  radiusMeters: number;
  maxAccuracyMeters: number;
}

// ---------------------------------------------------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------------------------------------------------

export type ScheduleStatus = "TENTATIVE" | "CONFIRMED";

/**
 * Configuration until the round opens, binding afterwards. Instants (ISO-8601); the event's zone is a presentation fact of the pages.
 * `contestantCutoffAt` refuses new contestants and photographs at or after it; `votingClosesAt` is the PRELIMINARY's deadline.
 * `registrationOpensAt` and `votingOpensAt` are information only: opening is always the operator's explicit act.
 */
export interface Schedule {
  registrationOpensAt: string | null;
  contestantCutoffAt: string | null;
  votingOpensAt: string | null;
  votingClosesAt: string | null;
  status: ScheduleStatus;
  updatedAt: string;
}

export interface ScheduleInput {
  registrationOpensAt: string | null;
  contestantCutoffAt: string | null;
  votingOpensAt: string | null;
  votingClosesAt: string | null;
  status: ScheduleStatus;
}

// ---------------------------------------------------------------------------------------------------------------------
// Entries, photographs, consent
// ---------------------------------------------------------------------------------------------------------------------

export interface RoundEntryCreated {
  entryId: string;
  /** The opaque public contestant number, e.g. "#4827". */
  label: string;
  /** Shown to the operator ONCE; 12 characters from a 32-symbol alphabet. */
  claimCode: string;
  claimExpiresAt: string;
}

export interface UploadedPhoto {
  photoId: string;
  fullSha256: string;
  thumbSha256: string;
}

/** The review state of a photograph, or HIDDEN once the person asked for it to be hidden. A candidature withdrawal is a separate fact. */
export type MediaState = "NONE" | "PENDING_CONSENT" | "PENDING_REVIEW" | "APPROVED" | "REJECTED" | "HIDDEN";

export type PhotoDecision = "APPROVED" | "REJECTED";

export interface GalleryRow {
  alias: string;
  /** Null until voting has opened (an approved entry is not yet a candidate). */
  candidateId: string | null;
  ordinal: number;
  /** A category of the contest shows its candidacies by name and by code (the code only LOCATES: it claims, edits and authorizes nothing). */
  publicCode?: string;
  publicName?: string | null;
}

export interface PhotoBytes {
  contentType: string;
  bytes: Buffer;
  sha256: string;
}

export type PromoDecision = "ACCEPTED" | "DECLINED" | "WITHDRAWN";
export type PromoState = PromoDecision | "NOT_ASKED";

// ---------------------------------------------------------------------------------------------------------------------
// Pending Product policies
// ---------------------------------------------------------------------------------------------------------------------

/**
 * Three questions are Product's to answer and have NOT been answered, so the operations that depend on them fail closed (POLICY_REQUIRED)
 * until an approval is recorded with the reference of the decision:
 *   ZERO_VALID_VOTES_PRELIMINARY        nobody voted for an eligible contestant: may everyone advance?
 *   ZERO_VOTE_ENTRIES_AT_CUTOFF         may a contestant with no votes advance because of the cut?
 *   FINALIST_WITHDRAWAL_AFTER_SELECTION a finalist withdrew after the cut: the final goes on without them, nobody takes their place.
 */
export type PolicyKey = "ZERO_VALID_VOTES_PRELIMINARY" | "ZERO_VOTE_ENTRIES_AT_CUTOFF" | "FINALIST_WITHDRAWAL_AFTER_SELECTION";

export interface PolicyApproval {
  approvalId: string;
  policyKey: PolicyKey;
  policyValue: string;
  approvedAt: string;
}

export interface PolicyStatus {
  key: PolicyKey;
  approved: boolean;
  value: string | null;
  approvalReference: string | null;
}

/** A Product decision that blocks an operation right now. */
export interface PendingResolution {
  key: PolicyKey;
}

export interface FollowupTask {
  taskId: string;
  kind: "EXTERNAL_PROMO_REMOVAL";
  status: "PENDING" | "DONE";
  /** States plainly that the system records the request and does not delete anything published outside it. */
  description: string;
  createdAt: string;
  resolvedAt: string | null;
  resolutionNote: string | null;
}

// ---------------------------------------------------------------------------------------------------------------------
// What the public may see, what a voter may see
// ---------------------------------------------------------------------------------------------------------------------

/** What anyone may see about a round before signing in: no identity, no count that reveals standing, no venue coordinates. */
export interface RoundPublicInfo {
  roundRole: RoundRole;
  sessionState: string;
  interactionState: string | null;
  openedAt: string | null;
  windowSeconds: number | null;
  /** When voting stops: the configured closing (preliminary) or the opening plus the window (final). Null while unknown. */
  deadlineAt: string | null;
  /** The server's clock at the moment of the answer: the browser derives its counter from it and never trusts its own. */
  serverNow: string;
  /** True for the final: the browser must send a location reading with every vote. False for the preliminary: it must never ask for one. */
  locationRequired: boolean;
  registrationOpensAt: string | null;
  contestantCutoffAt: string | null;
  votingOpensAt: string | null;
  votingClosesAt: string | null;
  scheduleStatus: ScheduleStatus | null;
  approvedContestants: number;
  closed: boolean;
  published: boolean;
  /** A test (rehearsal) round: every public page labels it so it can never be read as the real event. */
  isTest: boolean;
}

/** The caller's OWN snapshot. No token, no Participant id, no other voter, no tally. */
export interface RoundVoterStatus {
  instanceId: string;
  bindingId: string;
  roundRole: RoundRole;
  sessionState: string;
  interactionInstanceId: string | null;
  interactionState: string | null;
  issuedIntentNo: number;
  appliedIntentNo: number;
  myCandidateId: string | null;
  myEntry: { label: string; state: "PENDING_CONFIRMATION" | "CONFIRMED" } | null;
  openedAt: string | null;
  deadlineAt: string | null;
  serverNow: string;
  closed: boolean;
  published: boolean;
}

// ---------------------------------------------------------------------------------------------------------------------
// Operator operations
// ---------------------------------------------------------------------------------------------------------------------

export interface RoundClosure {
  closedAt: string;
  validVoteCount: number;
  resultsDigest: string;
}

export interface RoundStarted {
  interactionInstanceId: string;
  promptId: string;
  state: "PROMPT_ACTIVE";
  segmentNumber: number;
  candidateCount: number;
  openedAt: string;
  deadlineAt: string | null;
}

export interface RoundResultRow {
  candidateId: string;
  entryId: string;
  label: string;
  ordinal: number;
  withdrawn: boolean;
  votes: number;
  competitionRank: number | null;
  finalist: boolean;
  winner: boolean;
}

export interface FinalistSelection {
  finalistCount: number;
  eligibleCount: number;
  selectionDigest: string;
  selectedAt: string;
  alreadySelected: boolean;
}

export interface RoundReview {
  reviewId: string;
  resultsDigest: string;
  reviewedAt: string;
}

export interface RoundPublication {
  publishedAt: string;
  resultsDigest: string;
}

export interface RoundOverviewEntry {
  entryId: string;
  label: string;
  association: "UNCLAIMED" | "PENDING_CONFIRMATION" | "CONFIRMED";
  media: MediaState;
  photoId: string | null;
  promotional: PromoState;
  withdrawn: boolean;
  carried: boolean;
  claimable: boolean;
  claimExpiresAt: string | null;
}

export interface RoundOverview {
  roundRole: RoundRole;
  isTest: boolean;
  sessionState: string;
  interactionState: string | null;
  opened: boolean;
  closed: boolean;
  published: boolean;
  serverNow: string;
  windowSeconds: number | null;
  deadlineAt: string | null;
  /** The final's venue geofence (null for the preliminary): `editable` until the final has ever opened; `savedAt` is the last save, null while it still holds the registration's values. */
  geofence: (RoundVenue & { editable: boolean; savedAt: string | null }) | null;
  schedule: Omit<Schedule, "updatedAt"> | null;
  counters: { boundVoters: number; votes: number; entries: number; withdrawn: number };
  finalistsSelected: boolean;
  /** A closed final with no valid vote: there is no result to review or publish, and nothing here resolves it. */
  noValidResult: boolean;
  policies: PolicyStatus[];
  /** Decisions that block the next step right now (empty when nothing is pending). */
  pendingResolutions: PendingResolution[];
  /** The latest review and whether it still matches the current state; any change to who is eligible makes it stale. */
  review: { reviewedAt: string; digest: string; current: boolean } | null;
  tasks: FollowupTask[];
  /** Announced contestants who have withdrawn since. What was announced is not rewritten; the operator is told instead. */
  publishedAffected: Array<{ alias: string; ordinal: number }>;
  entries: RoundOverviewEntry[];
}

export interface RoundEvidence {
  roundRole: RoundRole;
  openedAt: string | null;
  windowSeconds: number | null;
  deadlineAt: string | null;
  closed: boolean;
  closedAt: string | null;
  resultsDigest: string | null;
  validVotesAtClose: number | null;
  currentReviewDigest: string | null;
  finalists: { selectedAt: string; cutoff: number; eligible: number; finalists: number; digest: string } | null;
  review: { reviewedAt: string; digest: string } | null;
  publication: { publishedAt: string; digest: string } | null;
  policies: Array<{ key: PolicyKey; value: string; approvalReference: string; approvedAt: string }>;
  withdrawals: Array<{ label: string; withdrawnAt: string; afterClose: boolean; duringVoting: boolean }>;
  privacyActions: Array<{ label: string; at: string }>;
  operatorActions: Array<{ action: string; at: string }>;
}

/** The candidature withdrawal: the contestant leaves every ranking and gallery; votes are kept as evidence. */
export interface RoundWithdrawal {
  withdrawalId: string;
  entryId: string;
  withdrawnAt: string;
  duringVoting: boolean;
  cascaded: number;
  photoHidden: boolean;
}

/** The privacy action: the photograph stops being shown in every round; nothing about the competition changes. */
export interface PhotoHiddenResult {
  actionId: string;
  entryId: string;
  performedAt: string;
}

export interface PublicRoundResult {
  kind: "FINALISTS" | "WINNERS";
  alias: string;
  ordinal: number;
}

export type { CastCommunityVoteResult, VoterBindingResult };
