import type { TowersRepository } from "./db/towersRepository";
import type { UndoTowersMoveResult } from "./types";
import { TowersAttemptNotFoundError, TowersAttemptNotInProgressError } from "./types";

/**
 * UNDO_MOVE command handler. Single-step Undo — reverses only the
 * immediately preceding MOVE. Entirely server-derived: no client-
 * supplied target, since the repository determines what to undo purely
 * from this attempt's own authoritative history. A second consecutive
 * Undo without an intervening MOVE surfaces as TowersNothingToUndoError
 * from the repository, since the most recent action would then be an
 * UNDO, not a MOVE. Undo after completion is rejected here because
 * outcome is no longer IN_PROGRESS.
 */
export async function undoMove(
  repo: TowersRepository,
  input: { attemptId: string; idempotencyKey: string }
): Promise<UndoTowersMoveResult> {
  const attempt = await repo.getAttempt(input.attemptId);
  if (!attempt) {
    throw new TowersAttemptNotFoundError();
  }
  if (attempt.outcome !== "IN_PROGRESS") {
    throw new TowersAttemptNotInProgressError();
  }

  const { attempt: committed, alreadyApplied } = await repo.commitUndo({
    attemptId: input.attemptId,
    idempotencyKey: input.idempotencyKey,
  });

  const actionHistory = await repo.listActionsForAttempt(input.attemptId);
  return { attempt: { ...committed, actionHistory }, alreadyApplied };
}
