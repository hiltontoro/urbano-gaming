import type {
  RutasActionEvent,
  RutasAttemptOutcome,
  RutasAttemptRecord,
  RutasDirection,
  RutasPiecePosition,
} from "../types";

/**
 * Rutas persistence boundary — its own interface, parallel to
 * lib/gaming/poker/db/pokerRepository.ts, never merged with it or with
 * Session's. Genuinely server-authoritative with a single legitimate
 * writer per attempt (no Host/Participant dual-actor arbitration to
 * design for, unlike Poker/Session) — so atomicity here exists to guard
 * against literal duplicate/retried submissions and lost updates under a
 * compare-and-swap, not to arbitrate two independent actors racing.
 */
export interface RutasRepository {
  createAttempt(input: {
    attemptId: string;
    scenarioId: string;
    scenarioVersion: number;
    initialPositions: Record<string, RutasPiecePosition>;
    restartOfAttemptId: string | null;
  }): Promise<RutasAttemptRecord>;

  getAttempt(attemptId: string): Promise<RutasAttemptRecord | null>;
  listActionsForAttempt(attemptId: string): Promise<RutasActionEvent[]>;

  /**
   * Atomic compare-and-swap MOVE commit. expectedCurrentPositions is the
   * state the caller (applyMove.ts) validated its computed newPositions
   * against — if the locked row's actual current_piece_positions no
   * longer matches, the repository must reject with
   * RutasStaleAttemptStateError rather than silently overwriting, so the
   * caller re-fetches and retries. Idempotent on idempotencyKey: a
   * repeated identical submission returns the previously-committed
   * result rather than double-applying.
   */
  commitMove(input: {
    attemptId: string;
    expectedCurrentPositions: Record<string, RutasPiecePosition>;
    newPositions: Record<string, RutasPiecePosition>;
    pieceId: string;
    direction: RutasDirection;
    distance: number;
    cleared: boolean;
    completes: boolean;
    idempotencyKey: string;
  }): Promise<{ attempt: RutasAttemptRecord; alreadyApplied: boolean }>;

  /**
   * Server-derived Undo: reverses the immediately preceding MOVE action
   * found in this attempt's own history — takes no client-supplied
   * target, since Undo is driven entirely by authoritative history, not
   * by anything the client claims. Rejects (RutasNothingToUndoError) if
   * the most recent action is not a MOVE (no moves yet, or the most
   * recent action is already an UNDO).
   */
  commitUndo(input: {
    attemptId: string;
    idempotencyKey: string;
  }): Promise<{ attempt: RutasAttemptRecord; alreadyApplied: boolean }>;

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
    initialPositions: Record<string, RutasPiecePosition>;
    idempotencyKey: string;
  }): Promise<{ newAttempt: RutasAttemptRecord; abandonedAttemptId: string; alreadyApplied: boolean }>;
}
