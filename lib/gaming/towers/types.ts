/**
 * URBANO Towers Slice 001 — Solo stack-transfer puzzle domain types.
 *
 * BOUNDED_GAME_RUNTIME, same runtime classification as Rutas — no Host,
 * no Participant, no room code, no Room Registry involvement. Exactly
 * one legitimate writer per attempt; attemptId alone is the addressing
 * key. Scenarios are code-owned curated content (see scenarios.ts) —
 * never stored in the database, never player-authored, never
 * procedurally generated. See the URBANO Towers Founder Product
 * Definition Gate for the full readiness/decision history behind every
 * contract fixed here.
 */

export type TowerId = string;

/**
 * A tower's stack, ordered bottom-to-top. Index 0 is the bottom (largest
 * legal piece); the last element is the top (the only piece that may
 * ever move). Every stack is a valid Hanoi-ordered arrangement at every
 * point in time by construction — a legal move can only ever place a
 * piece on an empty tower or a strictly larger one, so no move can ever
 * produce an invalid ordering.
 */
export type TowersStacks = Record<TowerId, number[]>;

/**
 * Scenario definition — immutable per (scenarioId, scenarioVersion).
 * towerIds is explicit (not just a count) so a scenario can name its own
 * towers; every Slice 001 shipped scenario uses exactly 3. initialStacks
 * lets content vary the starting arrangement (including split-start
 * scenarios) without changing the rules engine or the completion check.
 */
export interface TowersScenario {
  scenarioId: string;
  scenarioVersion: number;
  towerIds: TowerId[];
  initialStacks: TowersStacks;
  destinationTowerId: TowerId;
  knownMinimumMoves: number | null;
}

// --- Runtime attempt state ------------------------------------------------

export type TowersAttemptOutcome = "IN_PROGRESS" | "COMPLETE" | "ABANDONED";

export type TowersActionEventType = "MOVE" | "UNDO" | "RESTART";

export interface TowersMoveActionPayload {
  fromTowerId: TowerId;
  toTowerId: TowerId;
  pieceRank: number;
  previousStacks: TowersStacks;
  resultingStacks: TowersStacks;
}

export interface TowersUndoActionPayload {
  undoesSequenceNumber: number;
}

export interface TowersRestartActionPayload {
  successorAttemptId: string;
}

export interface TowersActionEvent {
  sequenceNumber: number;
  type: TowersActionEventType;
  payload: TowersMoveActionPayload | TowersUndoActionPayload | TowersRestartActionPayload;
  idempotencyKey: string;
  createdAt: string;
}

export interface TowersAttemptRecord {
  attemptId: string;
  scenarioId: string;
  scenarioVersion: number;
  currentStacks: TowersStacks;
  moveCount: number;
  undoCount: number;
  restartOfAttemptId: string | null;
  startedAt: string | null;
  completedAt: string | null;
  outcome: TowersAttemptOutcome;
  createdAt: string;
}

export interface TowersAttemptView extends TowersAttemptRecord {
  actionHistory: TowersActionEvent[];
}

// --- Command results -------------------------------------------------------

export interface StartTowersAttemptResult {
  attempt: TowersAttemptView;
}

export interface ApplyTowersMoveResult {
  attempt: TowersAttemptView;
  completed: boolean;
  alreadyApplied: boolean;
}

export interface UndoTowersMoveResult {
  attempt: TowersAttemptView;
  alreadyApplied: boolean;
}

export interface RestartTowersAttemptResult {
  newAttempt: TowersAttemptView;
  abandonedAttemptId: string;
  alreadyRestarted: boolean;
}

// --- Errors ------------------------------------------------------------

export class TowersScenarioNotFoundError extends Error {
  constructor() {
    super("No Towers scenario exists for this id/version.");
    this.name = "TowersScenarioNotFoundError";
  }
}

export class TowersAttemptNotFoundError extends Error {
  constructor() {
    super("No Towers attempt exists for this id.");
    this.name = "TowersAttemptNotFoundError";
  }
}

export class TowersAttemptNotInProgressError extends Error {
  constructor() {
    super("This Towers attempt is not in progress.");
    this.name = "TowersAttemptNotInProgressError";
  }
}

export class TowersIllegalMoveError extends Error {
  constructor(message: string = "This Towers move is not legal.") {
    super(message);
    this.name = "TowersIllegalMoveError";
  }
}

export class TowersStaleAttemptStateError extends Error {
  constructor() {
    super("This Towers attempt's state has changed since it was last read; retry against current state.");
    this.name = "TowersStaleAttemptStateError";
  }
}

export class TowersNothingToUndoError extends Error {
  constructor() {
    super("There is no move to undo in this Towers attempt.");
    this.name = "TowersNothingToUndoError";
  }
}

export class TowersAttemptAlreadyAbandonedError extends Error {
  constructor() {
    super("This Towers attempt has already been superseded by a restart and cannot be restarted again.");
    this.name = "TowersAttemptAlreadyAbandonedError";
  }
}
