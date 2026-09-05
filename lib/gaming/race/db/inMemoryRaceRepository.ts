import { randomUUID } from "crypto";
import type { RaceRepository } from "./raceRepository";
import { InMemoryTowersRepository } from "../../towers/db/inMemoryTowersRepository";
import type { TowersStacks } from "../../towers/types";
import type {
  ApplyRaceMoveResult,
  ApplyRaceUndoResult,
  ConfirmRaceReadinessResult,
  CreateRaceEventResult,
  JoinRaceEventResult,
  RaceBoardView,
  RaceCompetitorSlot,
  RaceEventRecord,
  RequestRaceCancellationResult,
} from "../types";
import {
  RaceEventFullError,
  RaceEventNotFoundError,
  RaceIdempotencyKeyConflictError,
  RaceIllegalMoveError,
  RaceInvalidTokenError,
  RaceNotYetStartedError,
  RaceNothingToUndoError,
  RaceOrganizerCannotCancelAfterCountdownError,
  RaceStaleAttemptStateError,
} from "../types";

const READINESS_WINDOW_MS = 5 * 60 * 1000;
const RUNNING_WINDOW_MS = 10 * 60 * 1000;
const COUNTDOWN_MS = 3 * 1000;

interface LedgerEntry {
  command: "JOIN" | "MOVE" | "UNDO" | "CANCEL";
  callerToken: string;
  payloadFingerprint: string;
  result: any;
}

/**
 * In-memory RaceRepository for behavioral tests — independently
 * reimplements the same lock-then-invoke-child-then-terminalize
 * invariants the real Postgres functions enforce (see
 * supabase/migrations/20260904085843_create_race_functions.sql),
 * mirroring InMemoryTowersRepository's own role. Node.js's single
 * threaded execution model makes the explicit row lock unnecessary here
 * — every method body already runs to completion without interleaving —
 * but the SAME ordering (ledger replay check, then lazy expiry, then
 * post-terminal short-circuit, then authorization, then timing, then
 * child mutation, then durable ledger write) is preserved so behavioral
 * tests exercise the same state machine the real-Postgres contract
 * tests exercise, including the durable Race-owned idempotency ledger
 * (UG-CR-GATE-025 Correction A) independent of Towers' own per-attempt
 * idempotency. The real, independent-execution-context concurrency
 * proof lives only in the contract tests, per the gate's own
 * requirement that sequential promises in one execution path are
 * insufficient for that specific claim.
 *
 * No opponent-completion comparison branch exists here, matching the
 * real function: under this repository's own single-threaded execution
 * (a strictly stronger guarantee than the real lock, since nothing can
 * ever interleave at all), a second unresolved completion can never
 * coexist with an already-recorded one, so TIE is not a producible
 * outcome — see types.ts's own comment.
 */
export class InMemoryRaceRepository implements RaceRepository {
  private events = new Map<string, RaceEventRecord>();
  private creations = new Map<string, CreateRaceEventResult>();
  private operations = new Map<string, Map<string, LedgerEntry>>();
  towersRepo = new InMemoryTowersRepository();

  private applyLazyExpiry(event: RaceEventRecord): RaceEventRecord {
    if (event.terminalResolution) return event;
    const now = Date.now();
    if (event.sharedStartAt && now - new Date(event.sharedStartAt).getTime() >= RUNNING_WINDOW_MS) {
      const updated: RaceEventRecord = {
        ...event,
        terminalResolution: "NO_CONTEST",
        terminalReason: "MAX_DURATION_EXCEEDED",
        endedAt: new Date().toISOString(),
      };
      this.events.set(event.raceEventId, updated);
      return updated;
    }
    if (
      !event.sharedStartAt &&
      event.secondCompetitorAssignedAt &&
      now - new Date(event.secondCompetitorAssignedAt).getTime() >= READINESS_WINDOW_MS
    ) {
      const updated: RaceEventRecord = {
        ...event,
        terminalResolution: "CANCELLED",
        terminalReason: "READINESS_EXPIRED",
        endedAt: new Date().toISOString(),
      };
      this.events.set(event.raceEventId, updated);
      return updated;
    }
    return event;
  }

  private checkLedger(raceEventId: string, idempotencyKey: string): LedgerEntry | undefined {
    return this.operations.get(raceEventId)?.get(idempotencyKey);
  }

  private writeLedger(raceEventId: string, idempotencyKey: string, entry: LedgerEntry): void {
    if (!this.operations.has(raceEventId)) this.operations.set(raceEventId, new Map());
    this.operations.get(raceEventId)!.set(idempotencyKey, entry);
  }

  async createEvent(input: {
    idempotencyKey: string;
    scenarioId: string;
    scenarioVersion: number;
  }): Promise<CreateRaceEventResult> {
    const existing = this.creations.get(input.idempotencyKey);
    if (existing) {
      if (existing.scenarioId !== input.scenarioId || existing.scenarioVersion !== input.scenarioVersion) {
        throw new RaceIdempotencyKeyConflictError();
      }
      return existing;
    }

    const record: RaceEventRecord = {
      raceEventId: randomUUID(),
      organizerToken: randomUUID(),
      childGame: "TOWERS",
      scenarioId: input.scenarioId,
      scenarioVersion: input.scenarioVersion,
      competitorAToken: null,
      competitorBToken: null,
      competitorAAttemptId: null,
      competitorBAttemptId: null,
      competitorAReady: false,
      competitorBReady: false,
      competitorACancelRequested: false,
      competitorBCancelRequested: false,
      secondCompetitorAssignedAt: null,
      sharedStartAt: null,
      terminalResolution: null,
      winnerSlot: null,
      terminalReason: null,
      endedAt: null,
      createdAt: new Date().toISOString(),
    };
    this.events.set(record.raceEventId, record);

    const result: CreateRaceEventResult = {
      raceEventId: record.raceEventId,
      organizerToken: record.organizerToken,
      scenarioId: record.scenarioId,
      scenarioVersion: record.scenarioVersion,
    };
    this.creations.set(input.idempotencyKey, result);
    return result;
  }

  async joinEvent(input: { raceEventId: string; idempotencyKey: string }): Promise<JoinRaceEventResult> {
    const event = this.events.get(input.raceEventId);
    if (!event) throw new RaceEventNotFoundError();

    const existing = this.checkLedger(input.raceEventId, input.idempotencyKey);
    if (existing) {
      if (existing.command !== "JOIN") throw new RaceIdempotencyKeyConflictError();
      return existing.result as JoinRaceEventResult;
    }

    if (event.terminalResolution) throw new RaceEventFullError();

    const token = randomUUID();
    let slot: RaceCompetitorSlot;
    if (!event.competitorAToken) {
      slot = "A";
      this.events.set(event.raceEventId, { ...event, competitorAToken: token });
    } else if (!event.competitorBToken) {
      slot = "B";
      this.events.set(event.raceEventId, {
        ...event,
        competitorBToken: token,
        secondCompetitorAssignedAt: new Date().toISOString(),
      });
    } else {
      throw new RaceEventFullError();
    }

    const result: JoinRaceEventResult = { competitorSlot: slot, competitorToken: token };
    this.writeLedger(input.raceEventId, input.idempotencyKey, { command: "JOIN", callerToken: token, payloadFingerprint: "", result });
    return result;
  }

  async getEvent(raceEventId: string): Promise<RaceEventRecord | null> {
    const event = this.events.get(raceEventId);
    if (!event) return null;
    return this.applyLazyExpiry(event);
  }

  async getBoard(attemptId: string): Promise<RaceBoardView | null> {
    const attempt = await this.towersRepo.getAttempt(attemptId);
    if (!attempt) return null;
    return {
      currentStacks: attempt.currentStacks,
      moveCount: attempt.moveCount,
      undoCount: attempt.undoCount,
      outcome: attempt.outcome,
    };
  }

  async peekMoveReplay(input: {
    raceEventId: string;
    competitorToken: string;
    fromTowerId: string;
    toTowerId: string;
    idempotencyKey: string;
  }): Promise<ApplyRaceMoveResult | null> {
    const existing = this.checkLedger(input.raceEventId, input.idempotencyKey);
    if (!existing) return null;
    const fingerprint = `${input.fromTowerId}>${input.toTowerId}`;
    if (existing.command !== "MOVE" || existing.callerToken !== input.competitorToken || existing.payloadFingerprint !== fingerprint) {
      throw new RaceIdempotencyKeyConflictError();
    }
    return { ...(existing.result as ApplyRaceMoveResult), alreadyApplied: true };
  }

  async peekUndoReplay(input: {
    raceEventId: string;
    competitorToken: string;
    idempotencyKey: string;
  }): Promise<ApplyRaceUndoResult | null> {
    const existing = this.checkLedger(input.raceEventId, input.idempotencyKey);
    if (!existing) return null;
    if (existing.command !== "UNDO" || existing.callerToken !== input.competitorToken) {
      throw new RaceIdempotencyKeyConflictError();
    }
    return { ...(existing.result as ApplyRaceUndoResult), alreadyApplied: true };
  }

  private resolveSlot(event: RaceEventRecord, token: string): RaceCompetitorSlot {
    if (token === event.competitorAToken) return "A";
    if (token === event.competitorBToken) return "B";
    throw new RaceInvalidTokenError();
  }

  async confirmReadiness(input: {
    raceEventId: string;
    competitorToken: string;
    initialStacks: TowersStacks;
  }): Promise<ConfirmRaceReadinessResult> {
    let event = this.events.get(input.raceEventId);
    if (!event) throw new RaceEventNotFoundError();
    event = this.applyLazyExpiry(event);
    if (event.terminalResolution) {
      return { bothReady: false, sharedStartAt: event.sharedStartAt, terminalResolution: event.terminalResolution };
    }

    const slot = this.resolveSlot(event, input.competitorToken);
    let updated: RaceEventRecord = {
      ...event,
      competitorAReady: slot === "A" ? true : event.competitorAReady,
      competitorBReady: slot === "B" ? true : event.competitorBReady,
    };

    if (updated.competitorAReady && updated.competitorBReady && !updated.sharedStartAt) {
      const startedAt = new Date(Date.now() + COUNTDOWN_MS).toISOString();
      const attemptA = await this.towersRepo.createAttempt({
        attemptId: randomUUID(),
        scenarioId: event.scenarioId,
        scenarioVersion: event.scenarioVersion,
        initialStacks: input.initialStacks,
        restartOfAttemptId: null,
      });
      const attemptB = await this.towersRepo.createAttempt({
        attemptId: randomUUID(),
        scenarioId: event.scenarioId,
        scenarioVersion: event.scenarioVersion,
        initialStacks: input.initialStacks,
        restartOfAttemptId: null,
      });
      updated = {
        ...updated,
        competitorAAttemptId: attemptA.attemptId,
        competitorBAttemptId: attemptB.attemptId,
        sharedStartAt: startedAt,
      };
      this.events.set(event.raceEventId, updated);
      return { bothReady: true, sharedStartAt: startedAt, terminalResolution: null };
    }

    this.events.set(event.raceEventId, updated);
    return {
      bothReady: updated.competitorAReady && updated.competitorBReady,
      sharedStartAt: updated.sharedStartAt,
      terminalResolution: null,
    };
  }

  async commitMove(input: {
    raceEventId: string;
    competitorToken: string;
    expectedStacks: TowersStacks;
    newStacks: TowersStacks;
    fromTowerId: string;
    toTowerId: string;
    pieceRank: number;
    completes: boolean;
    idempotencyKey: string;
  }): Promise<ApplyRaceMoveResult> {
    let event = this.events.get(input.raceEventId);
    if (!event) throw new RaceEventNotFoundError();

    const slot = this.resolveSlot(event, input.competitorToken);
    const fingerprint = `${input.fromTowerId}>${input.toTowerId}`;

    // Durable Race-owned idempotency check FIRST — before any
    // terminal-state rejection or child mutation, mirroring the real
    // function's own ordering exactly.
    const existingOp = this.checkLedger(input.raceEventId, input.idempotencyKey);
    if (existingOp) {
      if (existingOp.command !== "MOVE" || existingOp.callerToken !== input.competitorToken || existingOp.payloadFingerprint !== fingerprint) {
        throw new RaceIdempotencyKeyConflictError();
      }
      return { ...(existingOp.result as ApplyRaceMoveResult), alreadyApplied: true };
    }

    event = this.applyLazyExpiry(event);

    if (event.terminalResolution) {
      return {
        towersOutcome: "RACE_EVENT_ALREADY_TERMINAL",
        currentStacks: null,
        moveCount: null,
        raceTerminalResolution: event.terminalResolution,
        raceWinnerSlot: event.winnerSlot,
        alreadyApplied: false,
      };
    }

    const attemptId = slot === "A" ? event.competitorAAttemptId : event.competitorBAttemptId;

    if (!event.sharedStartAt || Date.now() < new Date(event.sharedStartAt).getTime()) {
      throw new RaceNotYetStartedError();
    }
    if (!attemptId) throw new RaceNotYetStartedError();

    const towersIdempotencyKey = `race:${input.raceEventId}:${input.idempotencyKey}`;
    let result;
    try {
      result = await this.towersRepo.commitMove({
        attemptId,
        expectedCurrentStacks: input.expectedStacks,
        newStacks: input.newStacks,
        fromTowerId: input.fromTowerId,
        toTowerId: input.toTowerId,
        pieceRank: input.pieceRank,
        completes: input.completes,
        idempotencyKey: towersIdempotencyKey,
      });
    } catch (err: any) {
      if (err?.name === "TowersStaleAttemptStateError") throw new RaceStaleAttemptStateError();
      if (err?.name === "TowersAttemptNotInProgressError") throw new RaceIllegalMoveError("This Race competitor's board is no longer in progress.");
      throw err;
    }

    let raceResult: ApplyRaceMoveResult;
    if (result.attempt.outcome === "COMPLETE" && !result.alreadyApplied) {
      // First (and, under this repository's own single-threaded
      // execution, only) genuine completion wins outright — no
      // opponent-comparison branch; see the class-level comment.
      const now = new Date().toISOString();
      const elapsedMs = new Date(now).getTime() - new Date(event.sharedStartAt).getTime();

      const updated: RaceEventRecord = {
        ...event,
        terminalResolution: "WON_LOST",
        winnerSlot: slot,
        terminalReason: "COMPLETED_FIRST",
        endedAt: now,
      };
      this.events.set(event.raceEventId, updated);

      raceResult = {
        towersOutcome: result.attempt.outcome,
        currentStacks: result.attempt.currentStacks,
        moveCount: result.attempt.moveCount,
        raceTerminalResolution: "WON_LOST",
        raceWinnerSlot: slot,
        alreadyApplied: false,
      };
      void elapsedMs;
    } else {
      raceResult = {
        towersOutcome: result.attempt.outcome,
        currentStacks: result.attempt.currentStacks,
        moveCount: result.attempt.moveCount,
        raceTerminalResolution: null,
        raceWinnerSlot: null,
        alreadyApplied: result.alreadyApplied,
      };
    }

    this.writeLedger(input.raceEventId, input.idempotencyKey, {
      command: "MOVE",
      callerToken: input.competitorToken,
      payloadFingerprint: fingerprint,
      result: raceResult,
    });

    return raceResult;
  }

  async commitUndo(input: {
    raceEventId: string;
    competitorToken: string;
    idempotencyKey: string;
  }): Promise<ApplyRaceUndoResult> {
    let event = this.events.get(input.raceEventId);
    if (!event) throw new RaceEventNotFoundError();

    const slot = this.resolveSlot(event, input.competitorToken);

    const existingOp = this.checkLedger(input.raceEventId, input.idempotencyKey);
    if (existingOp) {
      if (existingOp.command !== "UNDO" || existingOp.callerToken !== input.competitorToken) {
        throw new RaceIdempotencyKeyConflictError();
      }
      return { ...(existingOp.result as ApplyRaceUndoResult), alreadyApplied: true };
    }

    event = this.applyLazyExpiry(event);

    if (event.terminalResolution) {
      return {
        towersOutcome: "RACE_EVENT_ALREADY_TERMINAL",
        currentStacks: null,
        moveCount: null,
        undoCount: null,
        raceTerminalResolution: event.terminalResolution,
        alreadyApplied: false,
      };
    }

    const attemptId = slot === "A" ? event.competitorAAttemptId : event.competitorBAttemptId;
    if (!event.sharedStartAt || Date.now() < new Date(event.sharedStartAt).getTime()) {
      throw new RaceNotYetStartedError();
    }
    if (!attemptId) throw new RaceNotYetStartedError();

    const towersIdempotencyKey = `race:${input.raceEventId}:${input.idempotencyKey}`;
    let result;
    try {
      result = await this.towersRepo.commitUndo({ attemptId, idempotencyKey: towersIdempotencyKey });
    } catch (err: any) {
      if (err?.name === "TowersNothingToUndoError") throw new RaceNothingToUndoError();
      throw err;
    }

    const raceResult: ApplyRaceUndoResult = {
      towersOutcome: result.attempt.outcome,
      currentStacks: result.attempt.currentStacks,
      moveCount: result.attempt.moveCount,
      undoCount: result.attempt.undoCount,
      raceTerminalResolution: null,
      alreadyApplied: result.alreadyApplied,
    };

    this.writeLedger(input.raceEventId, input.idempotencyKey, {
      command: "UNDO",
      callerToken: input.competitorToken,
      payloadFingerprint: "",
      result: raceResult,
    });

    return raceResult;
  }

  async requestCancellation(input: {
    raceEventId: string;
    callerToken: string;
    idempotencyKey: string;
  }): Promise<RequestRaceCancellationResult> {
    let event = this.events.get(input.raceEventId);
    if (!event) throw new RaceEventNotFoundError();

    const existingOp = this.checkLedger(input.raceEventId, input.idempotencyKey);
    if (existingOp) {
      if (existingOp.command !== "CANCEL" || existingOp.callerToken !== input.callerToken) {
        throw new RaceIdempotencyKeyConflictError();
      }
      return existingOp.result as RequestRaceCancellationResult;
    }

    event = this.applyLazyExpiry(event);

    if (event.terminalResolution) {
      return { terminalResolution: event.terminalResolution, cancelPending: false };
    }

    let result: RequestRaceCancellationResult;

    if (input.callerToken === event.organizerToken) {
      if (!event.sharedStartAt) {
        const updated: RaceEventRecord = {
          ...event,
          terminalResolution: "CANCELLED",
          terminalReason: "ORGANIZER_CANCELLED_PRE_COUNTDOWN",
          endedAt: new Date().toISOString(),
        };
        this.events.set(event.raceEventId, updated);
        result = { terminalResolution: "CANCELLED", cancelPending: false };
      } else {
        throw new RaceOrganizerCannotCancelAfterCountdownError();
      }
    } else {
      const slot = this.resolveSlot(event, input.callerToken);
      let updated: RaceEventRecord = {
        ...event,
        competitorACancelRequested: slot === "A" ? true : event.competitorACancelRequested,
        competitorBCancelRequested: slot === "B" ? true : event.competitorBCancelRequested,
      };

      if (updated.competitorACancelRequested && updated.competitorBCancelRequested) {
        updated = {
          ...updated,
          terminalResolution: "CANCELLED",
          terminalReason: "MUTUAL_LIVE_CANCELLATION",
          endedAt: new Date().toISOString(),
        };
        this.events.set(event.raceEventId, updated);
        result = { terminalResolution: "CANCELLED", cancelPending: false };
      } else {
        this.events.set(event.raceEventId, updated);
        result = { terminalResolution: null, cancelPending: true };
      }
    }

    this.writeLedger(input.raceEventId, input.idempotencyKey, {
      command: "CANCEL",
      callerToken: input.callerToken,
      payloadFingerprint: "",
      result,
    });

    return result;
  }
}
