import type { RutasRepository } from "./rutasRepository";
import type {
  RutasActionEvent,
  RutasAttemptRecord,
  RutasDirection,
  RutasMoveActionPayload,
  RutasPiecePosition,
  RutasRestartActionPayload,
} from "../types";
import {
  RutasAttemptNotFoundError,
  RutasAttemptNotInProgressError,
  RutasAttemptAlreadyAbandonedError,
  RutasNothingToUndoError,
  RutasStaleAttemptStateError,
} from "../types";

/**
 * In-memory RutasRepository for behavioral tests — independently
 * reimplements the same compare-and-swap/idempotency/history-derived-undo
 * invariants the real Postgres functions enforce, mirroring
 * InMemoryPokerRepository's own role exactly (a separate implementation
 * proven to agree with the real one via the shared behavioral+contract
 * test suites, not a thin passthrough).
 */
export class InMemoryRutasRepository implements RutasRepository {
  private attempts = new Map<string, RutasAttemptRecord>();
  private actions = new Map<string, RutasActionEvent[]>(); // key: attemptId

  private positionsEqual(
    a: Record<string, RutasPiecePosition>,
    b: Record<string, RutasPiecePosition>
  ): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  async createAttempt(input: {
    attemptId: string;
    scenarioId: string;
    scenarioVersion: number;
    initialPositions: Record<string, RutasPiecePosition>;
    restartOfAttemptId: string | null;
  }): Promise<RutasAttemptRecord> {
    const record: RutasAttemptRecord = {
      attemptId: input.attemptId,
      scenarioId: input.scenarioId,
      scenarioVersion: input.scenarioVersion,
      currentPiecePositions: input.initialPositions,
      moveCount: 0,
      undoCount: 0,
      restartOfAttemptId: input.restartOfAttemptId,
      startedAt: null,
      completedAt: null,
      outcome: "IN_PROGRESS",
      createdAt: new Date().toISOString(),
    };
    this.attempts.set(record.attemptId, record);
    this.actions.set(record.attemptId, []);
    return record;
  }

  async getAttempt(attemptId: string): Promise<RutasAttemptRecord | null> {
    return this.attempts.get(attemptId) ?? null;
  }

  async listActionsForAttempt(attemptId: string): Promise<RutasActionEvent[]> {
    return [...(this.actions.get(attemptId) ?? [])].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  }

  private nextSequenceNumber(attemptId: string): number {
    const list = this.actions.get(attemptId) ?? [];
    return list.length === 0 ? 1 : Math.max(...list.map((a) => a.sequenceNumber)) + 1;
  }

  private findByIdempotencyKey(attemptId: string, idempotencyKey: string): RutasActionEvent | undefined {
    return (this.actions.get(attemptId) ?? []).find((a) => a.idempotencyKey === idempotencyKey);
  }

  async commitMove(input: {
    attemptId: string;
    expectedCurrentPositions: Record<string, RutasPiecePosition>;
    newPositions: Record<string, RutasPiecePosition>;
    pieceId: string;
    direction: RutasDirection;
    distance: number;
    cleared: boolean;
    completes: boolean;
    idempotencyKey: string;
  }): Promise<{ attempt: RutasAttemptRecord; alreadyApplied: boolean }> {
    const existing = this.findByIdempotencyKey(input.attemptId, input.idempotencyKey);
    if (existing) {
      const attempt = this.attempts.get(input.attemptId);
      if (!attempt) throw new RutasAttemptNotFoundError();
      return { attempt, alreadyApplied: true };
    }

    const attempt = this.attempts.get(input.attemptId);
    if (!attempt) throw new RutasAttemptNotFoundError();
    if (attempt.outcome !== "IN_PROGRESS") {
      throw new RutasAttemptNotInProgressError(); // caller already checked; defensive re-check under "lock"
    }
    if (!this.positionsEqual(attempt.currentPiecePositions, input.expectedCurrentPositions)) {
      throw new RutasStaleAttemptStateError();
    }

    const now = new Date().toISOString();
    const payload: RutasMoveActionPayload = {
      pieceId: input.pieceId,
      direction: input.direction,
      distance: input.distance,
      previousPositions: attempt.currentPiecePositions,
      resultingPositions: input.newPositions,
      cleared: input.cleared,
    };
    const event: RutasActionEvent = {
      sequenceNumber: this.nextSequenceNumber(input.attemptId),
      type: "MOVE",
      payload,
      idempotencyKey: input.idempotencyKey,
      createdAt: now,
    };
    this.actions.get(input.attemptId)!.push(event);

    const updated: RutasAttemptRecord = {
      ...attempt,
      currentPiecePositions: input.newPositions,
      moveCount: attempt.moveCount + 1,
      startedAt: attempt.startedAt ?? now,
      completedAt: input.completes ? now : attempt.completedAt,
      outcome: input.completes ? "COMPLETE" : attempt.outcome,
    };
    this.attempts.set(input.attemptId, updated);

    return { attempt: updated, alreadyApplied: false };
  }

  async commitUndo(input: {
    attemptId: string;
    idempotencyKey: string;
  }): Promise<{ attempt: RutasAttemptRecord; alreadyApplied: boolean }> {
    const existing = this.findByIdempotencyKey(input.attemptId, input.idempotencyKey);
    if (existing) {
      const attempt = this.attempts.get(input.attemptId);
      if (!attempt) throw new RutasAttemptNotFoundError();
      return { attempt, alreadyApplied: true };
    }

    const attempt = this.attempts.get(input.attemptId);
    if (!attempt) throw new RutasAttemptNotFoundError();
    if (attempt.outcome !== "IN_PROGRESS") {
      throw new RutasAttemptNotInProgressError(); // caller already checked; defensive re-check under "lock"
    }

    const history = this.actions.get(input.attemptId) ?? [];
    const mostRecent = history.length > 0 ? history[history.length - 1] : undefined;
    if (!mostRecent || mostRecent.type !== "MOVE") {
      throw new RutasNothingToUndoError();
    }
    const movePayload = mostRecent.payload as RutasMoveActionPayload;

    const now = new Date().toISOString();
    const event: RutasActionEvent = {
      sequenceNumber: this.nextSequenceNumber(input.attemptId),
      type: "UNDO",
      payload: { undoesSequenceNumber: mostRecent.sequenceNumber },
      idempotencyKey: input.idempotencyKey,
      createdAt: now,
    };
    this.actions.get(input.attemptId)!.push(event);

    const updated: RutasAttemptRecord = {
      ...attempt,
      currentPiecePositions: movePayload.previousPositions,
      undoCount: attempt.undoCount + 1,
    };
    this.attempts.set(input.attemptId, updated);

    return { attempt: updated, alreadyApplied: false };
  }

  async commitRestart(input: {
    oldAttemptId: string;
    newAttemptId: string;
    scenarioId: string;
    scenarioVersion: number;
    initialPositions: Record<string, RutasPiecePosition>;
    idempotencyKey: string;
  }): Promise<{ newAttempt: RutasAttemptRecord; abandonedAttemptId: string; alreadyApplied: boolean }> {
    const existing = this.findByIdempotencyKey(input.oldAttemptId, input.idempotencyKey);
    if (existing) {
      const successorId = (existing.payload as RutasRestartActionPayload).successorAttemptId;
      const newAttempt = this.attempts.get(successorId);
      if (!newAttempt) throw new RutasAttemptNotFoundError();
      return { newAttempt, abandonedAttemptId: input.oldAttemptId, alreadyApplied: true };
    }

    const oldAttempt = this.attempts.get(input.oldAttemptId);
    if (!oldAttempt) throw new RutasAttemptNotFoundError();
    if (oldAttempt.outcome === "ABANDONED") {
      throw new RutasAttemptAlreadyAbandonedError();
    }

    if (oldAttempt.outcome === "IN_PROGRESS") {
      this.attempts.set(input.oldAttemptId, { ...oldAttempt, outcome: "ABANDONED" });
    }

    const now = new Date().toISOString();
    const event: RutasActionEvent = {
      sequenceNumber: this.nextSequenceNumber(input.oldAttemptId),
      type: "RESTART",
      payload: { successorAttemptId: input.newAttemptId },
      idempotencyKey: input.idempotencyKey,
      createdAt: now,
    };
    this.actions.get(input.oldAttemptId)!.push(event);

    const newAttempt = await this.createAttempt({
      attemptId: input.newAttemptId,
      scenarioId: input.scenarioId,
      scenarioVersion: input.scenarioVersion,
      initialPositions: input.initialPositions,
      restartOfAttemptId: input.oldAttemptId,
    });

    return { newAttempt, abandonedAttemptId: input.oldAttemptId, alreadyApplied: false };
  }
}
