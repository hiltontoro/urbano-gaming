import type { RutasRepository } from "./db/rutasRepository";
import type { ApplyRutasMoveResult, RutasDirection } from "./types";
import {
  RutasAttemptNotFoundError,
  RutasAttemptNotInProgressError,
  RutasIllegalMoveError,
  RutasInvalidDistanceError,
  RutasScenarioNotFoundError,
} from "./types";
import { findScenario } from "./scenarios";
import { isComplete, validateAndApplyMove } from "./geometry";

/**
 * APPLY_MOVE command handler — the server-side half of the trust
 * boundary. Reads the CURRENT authoritative attempt state, independently
 * re-validates the submitted (pieceId, direction, distance) against the
 * scenario's own geometry (never trusts any client-claimed resulting
 * position), then hands the computed result to the repository's atomic
 * compare-and-swap commit. The repository re-checks the row hasn't
 * changed since this read (RutasStaleAttemptStateError) — callers should
 * treat that as a signal to re-fetch and retry, exactly like a
 * concurrent-modification conflict anywhere else in this codebase.
 */
export async function applyMove(
  repo: RutasRepository,
  input: { attemptId: string; pieceId: string; direction: RutasDirection; distance: number; idempotencyKey: string }
): Promise<ApplyRutasMoveResult> {
  if (!Number.isInteger(input.distance) || input.distance < 1) {
    throw new RutasInvalidDistanceError();
  }

  const attempt = await repo.getAttempt(input.attemptId);
  if (!attempt) {
    throw new RutasAttemptNotFoundError();
  }
  if (attempt.outcome !== "IN_PROGRESS") {
    throw new RutasAttemptNotInProgressError();
  }

  const scenario = findScenario(attempt.scenarioId, attempt.scenarioVersion);
  if (!scenario) {
    throw new RutasScenarioNotFoundError();
  }

  const validation = validateAndApplyMove(
    scenario,
    attempt.currentPiecePositions,
    input.pieceId,
    input.direction,
    input.distance
  );
  if (!validation.legal) {
    throw new RutasIllegalMoveError(validation.reason);
  }

  const completes = isComplete(scenario, validation.resultingPositions!);

  const { attempt: committed, alreadyApplied } = await repo.commitMove({
    attemptId: input.attemptId,
    expectedCurrentPositions: attempt.currentPiecePositions,
    newPositions: validation.resultingPositions!,
    pieceId: input.pieceId,
    direction: input.direction,
    distance: input.distance,
    cleared: validation.cleared!,
    completes,
    idempotencyKey: input.idempotencyKey,
  });

  const actionHistory = await repo.listActionsForAttempt(input.attemptId);
  return {
    attempt: { ...committed, actionHistory },
    cleared: validation.cleared!,
    completed: committed.outcome === "COMPLETE",
    alreadyApplied,
  };
}
