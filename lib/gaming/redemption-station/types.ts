/**
 * THE REDEMPTION STATION — a restricted mobile page, behind a shared PIN, for the staff of ONE venue to mark the prizes of ONE match as
 * delivered. It acts under its OWN identity (a member with no platform authority) and delivers through its own database function, which
 * decides the scope itself; whether a prize is delivered is whatever prize_qualifications says.
 */

export interface StationRecord {
  stationId: string;
  slug: string;
  label: string;
  venueActivationId: string;
  matchId: string;
  /** The identity of the station: a member with no platform authority that cannot sign in. It is the "who" of a delivery made here. */
  actorGamingMemberId: string;
  /** null until the PIN is set: nobody can open a session before that. */
  pinSalt: string | null;
  pinHash: string | null;
  /** 0 = no PIN yet. Moves one step at every change; a session is valid only for the version it was opened under. */
  pinVersion: number;
  /** Salt of the hash of the client address (kept apart from the PIN salt). */
  ipSalt: string;
  sessionTtlMinutes: number;
  expiresAt: string;
  revokedAt: string | null;
}

export interface StationSessionRecord {
  sessionId: string;
  stationId: string;
  /** The PIN version this session was opened under. */
  pinVersion: number;
  expiresAt: string;
  revokedAt: string | null;
}

export interface AttemptDecision {
  allowed: boolean;
  attemptId: string | null;
  retryAfterSeconds: number;
}

export type StationEventOutcome = "REDEEMED" | "ALREADY_REDEEMED" | "REFUSED";

export interface StationEventRecord {
  eventId: string;
  stationId: string;
  sessionId: string;
  prizeQualificationId: string;
  /** Only for a delivery this station made (REDEEMED); null for the other outcomes. */
  declaredOperator: string | null;
  outcome: StationEventOutcome;
  detail: string | null;
  occurredAt: string;
}

/** What the database says about one attempt to deliver a prize on behalf of a session. */
export interface ScopedRedemptionResult {
  outcome: StationEventOutcome;
  /** REDEEMED and ALREADY_REDEEMED. */
  redeemedAt: string | null;
  /** REFUSED: SUPERSEDED, FULFILLED or HELD. */
  refusal: string | null;
  eventId: string;
}

export interface PinChangeRecord {
  changeId: string;
  stationId: string;
  changedByGamingMemberId: string;
  newPinVersion: number;
  sessionsRevoked: number;
  changedAt: string;
}

/** What the administration page may know about a station: never the PIN nor its hash. */
export interface StationAdminStatus {
  slug: string;
  label: string;
  expiresAt: string;
  revokedAt: string | null;
  pinSet: boolean;
  pinVersion: number;
  /** Sessions that would still open the page right now. */
  activeSessions: number;
  lastPinChangeAt: string | null;
}

/** What the page may show of a prize, and nothing else: the visible name, the public code, the prize and the state. */
export type PrizeStatus = "PENDING" | "REDEEMED" | "UNAVAILABLE";

export interface StationPrizeView {
  code: string;
  displayName: string;
  prizeLabel: string;
  status: PrizeStatus;
  /** Only when REDEEMED. */
  redeemedAt: string | null;
}

export interface StationLimits {
  /** Failed PIN attempts allowed per client in the window. */
  perClient: number;
  /** Failed PIN attempts allowed for the whole station in the window. */
  perStation: number;
  windowSeconds: number;
}

export const DEFAULT_LIMITS: StationLimits = { perClient: 5, perStation: 30, windowSeconds: 15 * 60 };

export class StationNotFoundError extends Error {
  constructor() { super("There is no redemption station with that name."); this.name = "StationNotFoundError"; }
}
/** Revoked or past its end instant. */
export class StationClosedError extends Error {
  constructor() { super("This redemption station is closed."); this.name = "StationClosedError"; }
}
/** The station exists but nobody has set its PIN yet. */
export class StationNotActivatedError extends Error {
  constructor() { super("This redemption station has no PIN yet."); this.name = "StationNotActivatedError"; }
}
export class StationLockedError extends Error {
  constructor(public readonly retryAfterSeconds: number) { super("Too many attempts. Try again later."); this.name = "StationLockedError"; }
}
export class InvalidPinError extends Error {
  constructor() { super("The PIN is not correct."); this.name = "InvalidPinError"; }
}
export class StationUnauthorizedError extends Error {
  constructor() { super("The session is not valid."); this.name = "StationUnauthorizedError"; }
}
export class InvalidStationRequestError extends Error {
  constructor(message: string) { super(message); this.name = "InvalidStationRequestError"; }
}
/** A code that is not one of this station's prizes. */
export class PrizeCodeNotFoundError extends Error {
  constructor() { super("That code is not a prize of this station."); this.name = "PrizeCodeNotFoundError"; }
}
/** Superseded, on hold or already satisfied by an earlier delivery: it cannot be delivered from here. */
export class PrizeNotAvailableError extends Error {
  constructor() { super("This prize cannot be delivered from here. Ask URBANO."); this.name = "PrizeNotAvailableError"; }
}
/** The station cannot operate as configured (for example its identity holds an authority): it refuses rather than run. */
export class StationMisconfiguredError extends Error {
  constructor() { super("The redemption station cannot operate."); this.name = "StationMisconfiguredError"; }
}
/** Two prizes would get the same public code: the station refuses to run rather than hand out an ambiguous code. */
export class PublicCodeCollisionError extends Error {
  constructor() { super("Two prizes share a public code."); this.name = "PublicCodeCollisionError"; }
}
