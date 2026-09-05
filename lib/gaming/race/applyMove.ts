import type { RaceRepository } from "./db/raceRepository";
import type { ApplyRaceMoveResult } from "./types";
import {
  RaceEventAlreadyTerminalError,
  RaceEventNotFoundError,
  RaceIllegalMoveError,
  RaceInvalidTokenError,
  RaceNotYetStartedError,
  RaceScenarioNotFoundError,
} from "./types";
import { findScenario } from "../towers/scenarios";
import { isComplete, validateAndApplyMove } from "../towers/moveLogic";

/**
 * APPLY_MOVE command handler — mirrors Towers' own applyMove.ts exactly
 * one level up: reads the caller's OWN current board (never the
 * opponent's — attemptId is resolved server-side from the caller's
 * competitor_token, never client-supplied), independently re-derives
 * and validates MOVE_TOP_PIECE against it using Towers' own unmodified
 * pure helpers, then hands the computed result to the repository's
 * single atomic Race+Towers transaction. That transaction re-checks the
 * Race-owned operation ledger for an exact replay, the board hasn't
 * changed since this read (RaceStaleAttemptStateError), and is the sole
 * place that authorizes the competitor slot, validates timing, and
 * resolves any terminal transition — this handler's own early checks
 * are a fast-fail convenience, not the safety boundary.
 *
 * This handler's own prevalidation reads the board and derives legality
 * against it BEFORE knowing whether the request is a genuine retry —
 * because a retry's own idempotencyKey is only meaningful once matched
 * against the Race-owned ledger, and the fastest common case (a fresh,
 * legal move) never needs that lookup at all. If this prevalidation is
 * about to reject the request as illegal, or the board is about to be
 * reported as already-terminal, it safely re-checks the durable Race
 * operation ledger first (UG-CR-GATE-025 Correction A) — a retry of the
 * exact move that already succeeded, submitted against a board that has
 * since moved on (including one that has since terminalized the Race),
 * must never be incorrectly rejected instead of replaying its original
 * result. This peek is a best-effort optimization only, backed by a
 * plain (unlocked) read — the atomic RPC's own locked ledger check
 * remains the sole authoritative safety net for genuine concurrency.
 */
export async function applyRaceMove(
  repo: RaceRepository,
  input: {
    raceEventId: string;
    competitorToken: string;
    fromTowerId: string;
    toTowerId: string;
    idempotencyKey: string;
  }
): Promise<ApplyRaceMoveResult> {
  const event = await repo.getEvent(input.raceEventId);
  if (!event) throw new RaceEventNotFoundError();

  let attemptId: string | null;
  if (input.competitorToken === event.competitorAToken) attemptId = event.competitorAAttemptId;
  else if (input.competitorToken === event.competitorBToken) attemptId = event.competitorBAttemptId;
  else throw new RaceInvalidTokenError();

  if (event.terminalResolution) {
    const replay = await repo.peekMoveReplay({
      raceEventId: input.raceEventId,
      competitorToken: input.competitorToken,
      fromTowerId: input.fromTowerId,
      toTowerId: input.toTowerId,
      idempotencyKey: input.idempotencyKey,
    });
    if (replay) return replay;
    throw new RaceEventAlreadyTerminalError(event.terminalResolution, event.winnerSlot);
  }
  if (!attemptId) throw new RaceNotYetStartedError();

  const board = await repo.getBoard(attemptId);
  if (!board) throw new RaceNotYetStartedError();

  const scenario = findScenario(event.scenarioId, event.scenarioVersion);
  if (!scenario) throw new RaceScenarioNotFoundError();

  const validation = validateAndApplyMove(scenario, board.currentStacks, input.fromTowerId, input.toTowerId);
  if (!validation.legal) {
    const replay = await repo.peekMoveReplay({
      raceEventId: input.raceEventId,
      competitorToken: input.competitorToken,
      fromTowerId: input.fromTowerId,
      toTowerId: input.toTowerId,
      idempotencyKey: input.idempotencyKey,
    });
    if (replay) return replay;
    throw new RaceIllegalMoveError(validation.reason);
  }
  const completes = isComplete(scenario, validation.resultingStacks!);

  return repo.commitMove({
    raceEventId: input.raceEventId,
    competitorToken: input.competitorToken,
    expectedStacks: board.currentStacks,
    newStacks: validation.resultingStacks!,
    fromTowerId: input.fromTowerId,
    toTowerId: input.toTowerId,
    pieceRank: validation.movedPieceRank!,
    completes,
    idempotencyKey: input.idempotencyKey,
  });
}
