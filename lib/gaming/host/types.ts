/**
 * Become a Host (UG-CR-GATE-088).
 *
 * A host application is how an external adult venue owner or organizer asks to
 * run ONE private pilot competition. Approval grants a narrow, revocable,
 * one-competition capability — never a platform authority class (see the
 * header of the competition_host_applications migration for why OPERATIONAL is
 * not reused). Nothing here is an identifier a browser may see: member ids
 * never leave the server, and an application is referred to by its opaque code.
 */

export type HostApplicationState = "PENDING" | "APPROVED" | "REJECTED" | "WITHDRAWN";
export type HostCapabilityState = "AVAILABLE" | "CONSUMED" | "REVOKED";
export type HostDecision = "APPROVE" | "REJECT";
export type HostReviewView = "PENDING" | "ACTIVE" | "HISTORY";

export interface HostApplicationInput {
  venueName: string;
  cityArea: string;
  playingFields: number;
  venueDescription: string;
  expectedWindow: string;
  expectedTeamCount: number;
  confirmAllAdults: boolean;
  confirmIndependentScorekeepers: boolean;
  confirmPilotExclusions: boolean;
}

/** Plain-language phase the applicant is in — never authority-system terminology. */
export type HostPhase =
  | "NOT_APPLIED"
  | "UNDER_REVIEW"
  | "APPROVED_READY"
  | "PILOT_CREATED"
  | "NOT_APPROVED"
  | "WITHDRAWN"
  | "ACCESS_REVOKED";

/** The applicant's own application as stored (no decision reason, no member id). */
export interface HostStatusRecord {
  publicCode: string;
  state: HostApplicationState;
  venueName: string;
  cityArea: string;
  playingFields: number;
  venueDescription: string;
  expectedWindow: string;
  expectedTeamCount: number;
  submittedAt: string;
  decidedAt: string | null;
  withdrawnAt: string | null;
  capabilityState: HostCapabilityState | null;
  competitionName: string | null;
  competitionPublicCode: string | null;
  competitionState: string | null;
}

export interface HostStatusView {
  phase: HostPhase;
  application: HostStatusRecord | null;
}

/** One row of the internal review surface: names and application text, never ids. */
export interface HostReviewRecord {
  publicCode: string;
  state: HostApplicationState;
  applicantDisplayName: string;
  venueName: string;
  cityArea: string;
  playingFields: number;
  venueDescription: string;
  expectedWindow: string;
  expectedTeamCount: number;
  submittedAt: string;
  decidedAt: string | null;
  decidedByDisplayName: string | null;
  decisionReason: string | null;
  withdrawnAt: string | null;
  capabilityState: HostCapabilityState | null;
  capabilityGrantedAt: string | null;
  capabilityConsumedAt: string | null;
  capabilityRevokedAt: string | null;
  capabilityRevokeReason: string | null;
  competitionName: string | null;
  competitionState: string | null;
}

export interface SubmitHostApplicationResult {
  publicCode: string;
  state: "PENDING";
  submittedAt: string;
}

export interface WithdrawHostApplicationResult {
  publicCode: string;
  state: "WITHDRAWN";
  alreadyWithdrawn: boolean;
}

export interface DecideHostApplicationResult {
  publicCode: string;
  state: HostApplicationState;
  capabilityState: HostCapabilityState | null;
  alreadyDecided: boolean;
}

export interface RevokeHostCapabilityResult {
  publicCode: string;
  capabilityState: "REVOKED";
  alreadyRevoked: boolean;
}

export interface CreateHostCompetitionResult {
  competitionId: string;
  state: string;
  createdAt: string;
}

export class InvalidHostApplicationError extends Error {
  constructor(public readonly field: string) {
    super(`The host application is not valid: ${field}.`);
  }
}

export class InvalidHostCompetitionError extends Error {
  constructor(public readonly field: string) {
    super(`The competition is not valid: ${field}.`);
  }
}

export class InvalidHostDecisionError extends Error {
  constructor() {
    super("The decision must be APPROVE or REJECT.");
  }
}

export class InvalidHostReviewViewError extends Error {
  constructor() {
    super("The review view must be PENDING, ACTIVE or HISTORY.");
  }
}

export class HostApplicationAlreadyActiveError extends Error {
  constructor() {
    super("You already have a host application that is under review or approved.");
  }
}

export class HostApplicationNotFoundError extends Error {
  constructor() {
    super("No such host application exists.");
  }
}

export class HostApplicationNotPendingError extends Error {
  constructor() {
    super("Only an application that is still under review can be withdrawn.");
  }
}

export class HostApplicationAlreadyDecidedError extends Error {
  constructor() {
    super("This application is no longer waiting for a decision.");
  }
}

export class HostSelfReviewForbiddenError extends Error {
  constructor() {
    super("A reviewer cannot decide their own host application.");
  }
}

export class HostCapabilityNotFoundError extends Error {
  constructor() {
    super("This application has no hosting access to revoke.");
  }
}

export class HostCapabilityRequiredError extends Error {
  constructor() {
    super("An approved host application is required to create a pilot competition.");
  }
}

export class HostCapabilityAlreadyConsumedError extends Error {
  constructor() {
    super("Your approved pilot has already been created.");
  }
}

export class HostCapabilityRevokedError extends Error {
  constructor() {
    super("Your hosting access has been revoked.");
  }
}

export class HostReasonRequiredError extends Error {
  constructor() {
    super("A reason is required for this action.");
  }
}

/** Plain language on purpose: this message reaches a browser, and must not name internal authority classes. */
export class HostReviewerAuthorityRequiredError extends Error {
  constructor() {
    super("You are not authorized to review host applications.");
  }
}
