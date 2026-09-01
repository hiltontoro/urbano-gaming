import type { TowerId, TowersActionEvent, TowersAttemptRecord, TowersStacks } from "../types";

/**
 * Towers persistence boundary — its own interface, parallel to
 * lib/gaming/rutas/db/rutasRepository.ts, never merged with it or with
 * Poker's/Session's. Exactly one legitimate writer per attempt (no
 * Host/Participant dual-actor arbitration to design for) — atomicity
 * exists to guard against duplicate/retried submissions and lost updates
 * under a compare-and-swap, not to arbitrate two independent actors
 * racing, mirroring rutasRepository.ts's own reasoning exactly.
 */
export interface TowersRepository {
  createAttempt(input: {
    attemptId: string;
    scenarioId: string;
    scenarioVersion: number;
    initialStacks: TowersStacks;
    restartOfAttemptId: string | null;
  }): Promise<TowersAttemptRecord>;

  getAttempt(attemptId: string): Promise<TowersAttemptRecord | null>;
  listActionsForAttempt(attemptId: string): Promise<TowersActionEvent[]>;

  /**
   * Atomic compare-and-swap MOVE commit. expectedCurrentStacks is the
   * state the caller (applyMove.ts) validated its computed newStacks
   * against — if the locked row's actual current_stacks no longer
   * matches, the repository must reject with TowersStaleAttemptStateError
   * rather than silently overwriting, so the caller re-fetches and
   * retries. This guards against rapid duplicate/near-simultaneous
   * submissions computed against the same stale read, not against
   * legality (legality is always derived from the current top of
   * fromTowerId, so a stale read can never itself produce an illegal
   * accepted move — only a lost-update race). Idempotent on
   * idempotencyKey: a repeated identical submission returns the
   * previously-committed result rather than double-applying.
   */
  commitMove(input: {
    attemptId: string;
    expectedCurrentStacks: TowersStacks;
    newStacks: TowersStacks;
    fromTowerId: TowerId;
    toTowerId: TowerId;
    pieceRank: number;
    completes: boolean;
    idempotencyKey: string;
  }): Promise<{ attempt: TowersAttemptRecord; alreadyApplied: boolean }>;

  /**
   * Server-derived Undo: reverses the immediately preceding MOVE action
   * found in this attempt's own history — takes no client-supplied
   * target. Rejects (TowersNothingToUndoError) if the most recent action
   * is not a MOVE (no moves yet, or the most recent action is already an
   * UNDO).
   */
  commitUndo(input: {
    attemptId: string;
    idempotencyKey: string;
  }): Promise<{ attempt: TowersAttemptRecord; alreadyApplied: boolean }>;

  /**
   * Atomically finalizes the old attempt (ABANDONED, only if it was
   * still IN_PROGRESS — a COMPLETE attempt stays COMPLETE forever) and
   * creates the new attempt, linked via restartOfAttemptId. Idempotent
   * on idempotencyKey, scoped to the OLD attempt's own action history.
   */
  commitRestart(input: {
    oldAttemptId: string;
    newAttemptId: string;
    scenarioId: string;
    scenarioVersion: number;
    initialStacks: TowersStacks;
    idempotencyKey: string;
  }): Promise<{ newAttempt: TowersAttemptRecord; abandonedAttemptId: string; alreadyApplied: boolean }>;
}
