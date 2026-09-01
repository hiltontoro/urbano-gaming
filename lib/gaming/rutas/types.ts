/**
 * URBANO Rutas Slice 001 — Solo puzzle domain types.
 *
 * BOUNDED_GAME_RUNTIME, not a Session capability and not a Poker-style
 * Dedicated Experience: exactly one player per attempt, no Host, no
 * Participant, no room code, no Room Registry involvement. Scenarios are
 * code-owned curated content (see scenarios.ts) — never stored in the
 * database, never player-authored, never procedurally generated. See
 * RUTAS_SLICE_001_IMPLEMENTATION_RECORD.md for the full readiness/
 * correction/closure gate history behind every decision fixed here.
 */

export type RutasDirection = "N" | "S" | "E" | "W";

/**
 * A small, code-owned, portfolio-shared identity palette. Every identity
 * carries a color AND a shape/icon AND a short label — color is never the
 * sole compatibility signal, by construction (Founder accessibility
 * requirement, Product-correctness not deferred polish).
 */
export type IdentityKey = "RUBY" | "SAPPHIRE" | "EMERALD" | "AMBER" | "AMETHYST" | "TOPAZ";

export interface RutasCell {
  col: number;
  row: number;
}

export interface RutasFootprint {
  width: number;
  height: number;
}

/**
 * Scenario definition — immutable per (scenarioId, scenarioVersion).
 * Anchor is the piece's top-left cell; the whole footprint translates
 * rigidly. No rotation exists in Slice 001 — footprint width/height never
 * swap during play.
 */
export interface RutasScenarioPiece {
  pieceId: string;
  footprint: RutasFootprint;
  startAnchor: RutasCell;
  identity: IdentityKey;
  isRequired: boolean;
}

/**
 * One gate = one single edge-cell position. A multi-cell piece exiting
 * through an edge needs a matching gate at every edge-cell position its
 * footprint crosses — there is no separate "wide gate" concept; a wide
 * exit is simply several ordinary single-cell gates that happen to align.
 */
export interface RutasScenarioGate {
  gateId: string;
  edge: RutasDirection;
  position: number;
  identity: IdentityKey;
}

export interface RutasScenario {
  scenarioId: string;
  scenarioVersion: number;
  boardWidth: number;
  boardHeight: number;
  pieces: RutasScenarioPiece[];
  gates: RutasScenarioGate[];
}

// --- Runtime attempt state ------------------------------------------------

export type RutasPiecePosition = RutasCell | "CLEARED";

export type RutasAttemptOutcome = "IN_PROGRESS" | "COMPLETE" | "ABANDONED";

export type RutasActionEventType = "MOVE" | "UNDO" | "RESTART";

export interface RutasMoveActionPayload {
  pieceId: string;
  direction: RutasDirection;
  distance: number;
  previousPositions: Record<string, RutasPiecePosition>;
  resultingPositions: Record<string, RutasPiecePosition>;
  cleared: boolean;
}

export interface RutasUndoActionPayload {
  undoesSequenceNumber: number;
}

export interface RutasRestartActionPayload {
  successorAttemptId: string;
}

export interface RutasActionEvent {
  sequenceNumber: number;
  type: RutasActionEventType;
  payload: RutasMoveActionPayload | RutasUndoActionPayload | RutasRestartActionPayload;
  idempotencyKey: string;
  createdAt: string;
}

export interface RutasAttemptRecord {
  attemptId: string;
  scenarioId: string;
  scenarioVersion: number;
  currentPiecePositions: Record<string, RutasPiecePosition>;
  moveCount: number;
  undoCount: number;
  restartOfAttemptId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  outcome: RutasAttemptOutcome;
  createdAt: string;
}

export interface RutasAttemptView extends RutasAttemptRecord {
  actionHistory: RutasActionEvent[];
}

// --- Command results -------------------------------------------------------

export interface StartRutasAttemptResult {
  attempt: RutasAttemptView;
}

export interface ApplyRutasMoveResult {
  attempt: RutasAttemptView;
  cleared: boolean;
  completed: boolean;
  alreadyApplied: boolean;
}

export interface UndoRutasMoveResult {
  attempt: RutasAttemptView;
  alreadyApplied: boolean;
}

export interface RestartRutasAttemptResult {
  newAttempt: RutasAttemptView;
  abandonedAttemptId: string;
  alreadyRestarted: boolean;
}

// --- Errors ------------------------------------------------------------

export class RutasScenarioNotFoundError extends Error {
  constructor() {
    super("No Rutas scenario exists for this id/version.");
    this.name = "RutasScenarioNotFoundError";
  }
}

export class RutasAttemptNotFoundError extends Error {
  constructor() {
    super("No Rutas attempt exists for this id.");
    this.name = "RutasAttemptNotFoundError";
  }
}

export class RutasAttemptNotInProgressError extends Error {
  constructor() {
    super("This Rutas attempt is not in progress.");
    this.name = "RutasAttemptNotInProgressError";
  }
}

export class RutasPieceNotFoundError extends Error {
  constructor() {
    super("No such piece exists in this Rutas attempt.");
    this.name = "RutasPieceNotFoundError";
  }
}

export class RutasPieceAlreadyClearedError extends Error {
  constructor() {
    super("This Rutas piece has already been cleared.");
    this.name = "RutasPieceAlreadyClearedError";
  }
}

export class RutasInvalidDistanceError extends Error {
  constructor() {
    super("Rutas move distance must be a positive integer.");
    this.name = "RutasInvalidDistanceError";
  }
}

export class RutasIllegalMoveError extends Error {
  constructor(message: string = "This Rutas move is not legal.") {
    super(message);
    this.name = "RutasIllegalMoveError";
  }
}

export class RutasStaleAttemptStateError extends Error {
  constructor() {
    super("This Rutas attempt's state has changed since it was last read; retry against current state.");
    this.name = "RutasStaleAttemptStateError";
  }
}

export class RutasNothingToUndoError extends Error {
  constructor() {
    super("There is no move to undo in this Rutas attempt.");
    this.name = "RutasNothingToUndoError";
  }
}

export class RutasAttemptAlreadyAbandonedError extends Error {
  constructor() {
    super("This Rutas attempt has already been superseded by a restart and cannot be restarted again.");
    this.name = "RutasAttemptAlreadyAbandonedError";
  }
}
