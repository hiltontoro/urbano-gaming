import type { TowersRepository } from "./towersRepository";
import type {
  TowerId,
  TowersActionEvent,
  TowersAttemptRecord,
  TowersMoveActionPayload,
  TowersRestartActionPayload,
  TowersStacks,
} from "../types";
import {
  TowersAttemptNotFoundError,
  TowersAttemptNotInProgressError,
  TowersAttemptAlreadyAbandonedError,
  TowersNothingToUndoError,
  TowersStaleAttemptStateError,
} from "../types";

/**
 * In-memory TowersRepository for behavioral tests — independently
 * reimplements the same compare-and-swap/idempotency/history-derived-undo
 * invariants the real Postgres functions enforce, mirroring
 * InMemoryRutasRepository's own role exactly.
 */
export class InMemoryTowersRepository implements TowersRepository {
  private attempts = new Map<string, TowersAttemptRecord>();
  private actions = new Map<string, TowersActionEvent[]>(); // key: attemptId

  private stacksEqual(a: TowersStacks, b: TowersStacks): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
  }

  async createAttempt(input: {
    attemptId: string;
    scenarioId: string;
    scenarioVersion: number;
    initialStacks: TowersStacks;
    restartOfAttemptId: string | null;
  }): Promise<TowersAttemptRecord> {
    const record: TowersAttemptRecord = {
      attemptId: input.attemptId,
      scenarioId: input.scenarioId,
      scenarioVersion: input.scenarioVersion,
      currentStacks: input.initialStacks,
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

  async getAttempt(attemptId: string): Promise<TowersAttemptRecord | null> {
    return this.attempts.get(attemptId) ?? null;
  }

  async listActionsForAttempt(attemptId: string): Promise<TowersActionEvent[]> {
    return [...(this.actions.get(attemptId) ?? [])].sort((a, b) => a.sequenceNumber - b.sequenceNumber);
  }

  private nextSequenceNumber(attemptId: string): number {
    const list = this.actions.get(attemptId) ?? [];
    return list.length === 0 ? 1 : Math.max(...list.map((a) => a.sequenceNumber)) + 1;
  }

  private findByIdempotencyKey(attemptId: string, idempotencyKey: string): TowersActionEvent | undefined {
    return (this.actions.get(attemptId) ?? []).find((a) => a.idempotencyKey === idempotencyKey);
  }

  async commitMove(input: {
    attemptId: string;
    expectedCurrentStacks: TowersStacks;
    newStacks: TowersStacks;
    fromTowerId: TowerId;
    toTowerId: TowerId;
    pieceRank: number;
    completes: boolean;
    idempotencyKey: string;
  }): Promise<{ attempt: TowersAttemptRecord; alreadyApplied: boolean }> {
    const existing = this.findByIdempotencyKey(input.attemptId, input.idempotencyKey);
    if (existing) {
      const attempt = this.attempts.get(input.attemptId);
      if (!attempt) throw new TowersAttemptNotFoundError();
      return { attempt, alreadyApplied: true };
    }

    const attempt = this.attempts.get(input.attemptId);
    if (!attempt) throw new TowersAttemptNotFoundError();
    if (attempt.outcome !== "IN_PROGRESS") {
      throw new TowersAttemptNotInProgressError(); // caller already checked; defensive re-check under "lock"
    }
    if (!this.stacksEqual(attempt.currentStacks, input.expectedCurrentStacks)) {
      throw new TowersStaleAttemptStateError();
    }

    const now = new Date().toISOString();
    const payload: TowersMoveActionPayload = {
      fromTowerId: input.fromTowerId,
      toTowerId: input.toTowerId,
      pieceRank: input.pieceRank,
      previousStacks: attempt.currentStacks,
      resultingStacks: input.newStacks,
    };
    const event: TowersActionEvent = {
      sequenceNumber: this.nextSequenceNumber(input.attemptId),
      type: "MOVE",
      payload,
      idempotencyKey: input.idempotencyKey,
      createdAt: now,
    };
    this.actions.get(input.attemptId)!.push(event);

    const updated: TowersAttemptRecord = {
      ...attempt,
      currentStacks: input.newStacks,
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
  }): Promise<{ attempt: TowersAttemptRecord; alreadyApplied: boolean }> {
    const existing = this.findByIdempotencyKey(input.attemptId, input.idempotencyKey);
    if (existing) {
      const attempt = this.attempts.get(input.attemptId);
      if (!attempt) throw new TowersAttemptNotFoundError();
      return { attempt, alreadyApplied: true };
    }

    const attempt = this.attempts.get(input.attemptId);
    if (!attempt) throw new TowersAttemptNotFoundError();
    if (attempt.outcome !== "IN_PROGRESS") {
      throw new TowersAttemptNotInProgressError(); // caller already checked; defensive re-check under "lock"
    }

    const history = this.actions.get(input.attemptId) ?? [];
    const mostRecent = history.length > 0 ? history[history.length - 1] : undefined;
    if (!mostRecent || mostRecent.type !== "MOVE") {
      throw new TowersNothingToUndoError();
    }
    const movePayload = mostRecent.payload as TowersMoveActionPayload;

    const now = new Date().toISOString();
    const event: TowersActionEvent = {
      sequenceNumber: this.nextSequenceNumber(input.attemptId),
      type: "UNDO",
      payload: { undoesSequenceNumber: mostRecent.sequenceNumber },
      idempotencyKey: input.idempotencyKey,
      createdAt: now,
    };
    this.actions.get(input.attemptId)!.push(event);

    const updated: TowersAttemptRecord = {
      ...attempt,
      currentStacks: movePayload.previousStacks,
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
    initialStacks: TowersStacks;
    idempotencyKey: string;
  }): Promise<{ newAttempt: TowersAttemptRecord; abandonedAttemptId: string; alreadyApplied: boolean }> {
    const existing = this.findByIdempotencyKey(input.oldAttemptId, input.idempotencyKey);
    if (existing) {
      const successorId = (existing.payload as TowersRestartActionPayload).successorAttemptId;
      const newAttempt = this.attempts.get(successorId);
      if (!newAttempt) throw new TowersAttemptNotFoundError();
      return { newAttempt, abandonedAttemptId: input.oldAttemptId, alreadyApplied: true };
    }

    const oldAttempt = this.attempts.get(input.oldAttemptId);
    if (!oldAttempt) throw new TowersAttemptNotFoundError();
    if (oldAttempt.outcome === "ABANDONED") {
      throw new TowersAttemptAlreadyAbandonedError();
    }

    if (oldAttempt.outcome === "IN_PROGRESS") {
      this.attempts.set(input.oldAttemptId, { ...oldAttempt, outcome: "ABANDONED" });
    }

    const now = new Date().toISOString();
    const event: TowersActionEvent = {
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
      initialStacks: input.initialStacks,
      restartOfAttemptId: input.oldAttemptId,
    });

    return { newAttempt, abandonedAttemptId: input.oldAttemptId, alreadyApplied: false };
  }
}
