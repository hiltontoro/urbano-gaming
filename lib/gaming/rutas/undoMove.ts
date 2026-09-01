import type { RutasRepository } from "./db/rutasRepository";
import type { UndoRutasMoveResult } from "./types";
import { RutasAttemptNotFoundError, RutasAttemptNotInProgressError } from "./types";

/**
 * UNDO_MOVE command handler. Single-step Undo (Founder default,
 * RUTAS_SLICE_001 closure gate) — reverses only the immediately
 * preceding MOVE. Entirely server-derived: no client-supplied target,
 * since the repository determines what to undo purely from this
 * attempt's own authoritative history (see rutasRepository.ts's own
 * comment). A second consecutive Undo without an intervening MOVE
 * surfaces as RutasNothingToUndoError from the repository, since the
 * most recent action would then be an UNDO, not a MOVE.
 */
export async function undoMove(
  repo: RutasRepository,
  input: { attemptId: string; idempotencyKey: string }
): Promise<UndoRutasMoveResult> {
  const attempt = await repo.getAttempt(input.attemptId);
  if (!attempt) {
    throw new RutasAttemptNotFoundError();
  }
  if (attempt.outcome !== "IN_PROGRESS") {
    throw new RutasAttemptNotInProgressError();
  }

  const { attempt: committed, alreadyApplied } = await repo.commitUndo({
    attemptId: input.attemptId,
    idempotencyKey: input.idempotencyKey,
  });

  const actionHistory = await repo.listActionsForAttempt(input.attemptId);
  return { attempt: { ...committed, actionHistory }, alreadyApplied };
}
