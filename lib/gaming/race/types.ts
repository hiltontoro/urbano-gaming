/**
 * URBANO Race Slice 001 — Towers-specific synchronous Live Race domain
 * types.
 *
 * Race is its own Format-dimension runtime (UG-CR-TAX-001), not a
 * Session capability, not a generic multi-child engine. This Slice
 * proves exactly one Towers-specific Race. Race owns competitor slots,
 * readiness, the shared countdown, timing comparison, and event
 * lifecycle; Towers remains the sole owner of scenario rules, move
 * validation, undo, and per-attempt evidence. Raw Towers attemptId
 * values are server-internal only — RaceCallerView carries them so the
 * domain layer can read/relay through Towers, but no projection type
 * below ever includes one, and no API route may serialize one.
 */

import type { TowersStacks } from "../towers/types";

export type RaceCompetitorSlot = "A" | "B";

/**
 * 'TIE' is deliberately absent. Under this Slice's own transaction
 * boundary (the Race event row is locked before the nested Towers
 * call, for the whole duration of one competitor's official move), a
 * second unresolved completion can never coexist with an already-
 * recorded one — no genuine two-competitor execution can produce a
 * tie. An earlier candidate's tie-comparison branch was only reachable
 * via artificially injected evidence in a test, never through any real
 * path; claiming it as validated behavior was corrected (UG-CR-REV-022,
 * UG-CR-GATE-025). A future Product rule may reintroduce TIE
 * deliberately; it is not reserved here as a dead value.
 */
export type RaceTerminalResolution = "WON_LOST" | "NO_CONTEST" | "CANCELLED";

/**
 * Derived, never persisted — mirrors this repository's existing Pulse
 * SETUP/ACTIVE phase-derivation convention.
 */
export type RaceLifecyclePhase =
  | "AWAITING_COMPETITORS"
  | "AWAITING_READINESS"
  | "COUNTDOWN"
  | "LIVE"
  | "COMPLETED";

export interface RaceEventRecord {
  raceEventId: string;
  organizerToken: string;
  childGame: "TOWERS";
  scenarioId: string;
  scenarioVersion: number;
  competitorAToken: string | null;
  competitorBToken: string | null;
  competitorAAttemptId: string | null;
  competitorBAttemptId: string | null;
  competitorAReady: boolean;
  competitorBReady: boolean;
  competitorACancelRequested: boolean;
  competitorBCancelRequested: boolean;
  secondCompetitorAssignedAt: string | null;
  sharedStartAt: string | null;
  terminalResolution: RaceTerminalResolution | null;
  winnerSlot: RaceCompetitorSlot | null;
  terminalReason: string | null;
  endedAt: string | null;
  createdAt: string;
}

/** Board state for a single competitor slot, read from Towers (read-only). */
export interface RaceBoardView {
  currentStacks: TowersStacks;
  moveCount: number;
  undoCount: number;
  outcome: "IN_PROGRESS" | "COMPLETE" | "ABANDONED";
}

/** What the caller (identified by an optional bearer token) may see. */
export interface RaceEventProjection {
  raceEventId: string;
  childGame: "TOWERS";
  scenarioId: string;
  scenarioVersion: number;
  phase: RaceLifecyclePhase;
  competitorASlotFilled: boolean;
  competitorBSlotFilled: boolean;
  competitorAReady: boolean;
  competitorBReady: boolean;
  secondCompetitorAssignedAt: string | null;
  readinessExpiresAt: string | null;
  sharedStartAt: string | null;
  runningExpiresAt: string | null;
  terminalResolution: RaceTerminalResolution | null;
  winnerSlot: RaceCompetitorSlot | null;
  terminalReason: string | null;
  endedAt: string | null;
  createdAt: string;
  you: {
    role: "ORGANIZER" | "COMPETITOR";
    slot: RaceCompetitorSlot | null;
    cancelRequested: boolean;
    board: RaceBoardView | null;
  } | null;
}

export interface CreateRaceEventResult {
  raceEventId: string;
  organizerToken: string;
  scenarioId: string;
  scenarioVersion: number;
}

export interface JoinRaceEventResult {
  competitorSlot: RaceCompetitorSlot;
  competitorToken: string;
}

export interface ConfirmRaceReadinessResult {
  bothReady: boolean;
  sharedStartAt: string | null;
  terminalResolution: RaceTerminalResolution | null;
}

export interface ApplyRaceMoveResult {
  towersOutcome: string;
  currentStacks: TowersStacks | null;
  moveCount: number | null;
  raceTerminalResolution: RaceTerminalResolution | null;
  raceWinnerSlot: RaceCompetitorSlot | null;
  alreadyApplied: boolean;
}

export interface ApplyRaceUndoResult {
  towersOutcome: string;
  currentStacks: TowersStacks | null;
  moveCount: number | null;
  undoCount: number | null;
  raceTerminalResolution: RaceTerminalResolution | null;
  alreadyApplied: boolean;
}

export interface RequestRaceCancellationResult {
  terminalResolution: RaceTerminalResolution | null;
  cancelPending: boolean;
}

// --- Errors -----------------------------------------------------------

export class RaceScenarioNotFoundError extends Error {
  constructor() {
    super("No Towers scenario exists for this id/version.");
    this.name = "RaceScenarioNotFoundError";
  }
}

export class RaceEventNotFoundError extends Error {
  constructor() {
    super("No Race event exists for this id.");
    this.name = "RaceEventNotFoundError";
  }
}

export class RaceEventAlreadyTerminalError extends Error {
  constructor(
    public readonly terminalResolution: RaceTerminalResolution,
    public readonly winnerSlot: RaceCompetitorSlot | null
  ) {
    super("This Race event has already ended.");
    this.name = "RaceEventAlreadyTerminalError";
  }
}

export class RaceEventFullError extends Error {
  constructor() {
    super("Both competitor slots are already assigned for this Race event.");
    this.name = "RaceEventFullError";
  }
}

export class RaceInvalidTokenError extends Error {
  constructor(message: string = "This token does not match a role on this Race event.") {
    super(message);
    this.name = "RaceInvalidTokenError";
  }
}

export class RaceNotYetStartedError extends Error {
  constructor() {
    super("This Race event has not reached its shared start time.");
    this.name = "RaceNotYetStartedError";
  }
}

export class RaceIllegalMoveError extends Error {
  constructor(message: string = "This Race move is not legal.") {
    super(message);
    this.name = "RaceIllegalMoveError";
  }
}

export class RaceStaleAttemptStateError extends Error {
  constructor() {
    super("This Race competitor's board has changed since it was last read; retry against current state.");
    this.name = "RaceStaleAttemptStateError";
  }
}

export class RaceNothingToUndoError extends Error {
  constructor() {
    super("There is no move to undo for this Race competitor.");
    this.name = "RaceNothingToUndoError";
  }
}

export class RaceOrganizerCannotCancelAfterCountdownError extends Error {
  constructor() {
    super("Cancellation after the countdown is scheduled requires both competitors' agreement.");
    this.name = "RaceOrganizerCannotCancelAfterCountdownError";
  }
}

/**
 * The durable Race-owned idempotency ledger found this exact key
 * already used for a different command, caller, or payload than the
 * current request. This is a deterministic rejection, not a silent
 * replay of the wrong result and not a silent re-execution.
 */
export class RaceIdempotencyKeyConflictError extends Error {
  constructor(message: string = "This idempotency key was already used with a different command, caller, or payload.") {
    super(message);
    this.name = "RaceIdempotencyKeyConflictError";
  }
}
