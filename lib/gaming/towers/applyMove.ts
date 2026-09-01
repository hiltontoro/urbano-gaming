import type { TowersRepository } from "./db/towersRepository";
import type { ApplyTowersMoveResult } from "./types";
import {
  TowersAttemptNotFoundError,
  TowersAttemptNotInProgressError,
  TowersIllegalMoveError,
  TowersScenarioNotFoundError,
} from "./types";
import { findScenario } from "./scenarios";
import { isComplete, validateAndApplyMove } from "./moveLogic";

/**
 * APPLY_MOVE command handler — the server-side half of the trust
 * boundary. Reads the CURRENT authoritative attempt state, independently
 * re-derives and validates MOVE_TOP_PIECE against it (the client never
 * supplies which piece moves, only fromTowerId/toTowerId), then hands
 * the computed result to the repository's atomic compare-and-swap
 * commit. The repository re-checks the row hasn't changed since this
 * read (TowersStaleAttemptStateError) — callers should treat that as a
 * signal to re-fetch and retry.
 *
 * The idempotencyKey is checked against this attempt's own action
 * history FIRST, before any validation or outcome check — deliberately
 * mirroring the order the repository's own commitMove already uses
 * internally. Validating first would be wrong: a duplicate submission of
 * the exact move that just completed the attempt (a genuine, expected
 * retry case — e.g. a client that never saw the first response) would
 * otherwise be re-validated against the NOW-mutated state and incorrectly
 * rejected (attempt no longer IN_PROGRESS, or the same top-of-tower
 * transfer no longer legal from the new position) instead of returning
 * the already-committed result.
 */
export async function applyMove(
  repo: TowersRepository,
  input: { attemptId: string; fromTowerId: string; toTowerId: string; idempotencyKey: string }
): Promise<ApplyTowersMoveResult> {
  const attempt = await repo.getAttempt(input.attemptId);
  if (!attempt) {
    throw new TowersAttemptNotFoundError();
  }

  const actionHistory = await repo.listActionsForAttempt(input.attemptId);
  if (actionHistory.some((a) => a.idempotencyKey === input.idempotencyKey)) {
    return {
      attempt: { ...attempt, actionHistory },
      completed: attempt.outcome === "COMPLETE",
      alreadyApplied: true,
    };
  }

  if (attempt.outcome !== "IN_PROGRESS") {
    throw new TowersAttemptNotInProgressError();
  }

  const scenario = findScenario(attempt.scenarioId, attempt.scenarioVersion);
  if (!scenario) {
    throw new TowersScenarioNotFoundError();
  }

  const validation = validateAndApplyMove(scenario, attempt.currentStacks, input.fromTowerId, input.toTowerId);
  if (!validation.legal) {
    throw new TowersIllegalMoveError(validation.reason);
  }

  const completes = isComplete(scenario, validation.resultingStacks!);

  const { attempt: committed, alreadyApplied } = await repo.commitMove({
    attemptId: input.attemptId,
    expectedCurrentStacks: attempt.currentStacks,
    newStacks: validation.resultingStacks!,
    fromTowerId: input.fromTowerId,
    toTowerId: input.toTowerId,
    pieceRank: validation.movedPieceRank!,
    completes,
    idempotencyKey: input.idempotencyKey,
  });

  const updatedActionHistory = await repo.listActionsForAttempt(input.attemptId);
  return {
    attempt: { ...committed, actionHistory: updatedActionHistory },
    completed: committed.outcome === "COMPLETE",
    alreadyApplied,
  };
}
