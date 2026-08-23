import type { SessionRepository } from "./db/sessionRepository";
import type { DuelExceptionalResolution, ResolveDuelResult } from "./types";
import {
  DuelNotFoundError,
  HostTokenMismatchError,
  DuelAlreadyResolvedError,
  InvalidDuelResolutionError,
  DuelReasonRequiredError,
} from "./types";

const VALID_RESOLUTIONS: DuelExceptionalResolution[] = [
  "CANCELLED",
  "VOID",
  "FORFEIT_A",
  "FORFEIT_B",
];

/**
 * RESOLVE_DUEL_EXCEPTIONALLY command handler.
 *
 * Duel / SESSION_SUBGAME v1 (Product/Duel_Architecture.md). The Host's
 * "exceptional resolution" authority tier — CANCELLED, VOID, or a
 * named competitor's FORFEIT — for a stalled, disputed, or otherwise
 * abnormal Duel. Never callable against an already-COMPLETED Duel: a
 * mechanic-derived (RESOLVE_DUEL) or prior exceptional result is never
 * silently overwritten. Correction/supersession of an already-terminal
 * Duel is explicitly deferred, not implemented in v1.
 *
 * Host-token and Duel-state authority: the getDuelById/host-token
 * lookups below are a fast-path check for immediate rejection — they
 * are NOT the sole guarantee. The repository's resolveDuelExceptionally
 * call is the authoritative check, re-verifying both inside the same
 * atomic operation that persists the result.
 */
export async function resolveDuelExceptionally(
  repo: SessionRepository,
  duelId: string,
  hostToken: string,
  resolution: DuelExceptionalResolution,
  reason: string | null
): Promise<ResolveDuelResult> {
  if (!VALID_RESOLUTIONS.includes(resolution)) {
    throw new InvalidDuelResolutionError();
  }

  if (
    (resolution === "FORFEIT_A" || resolution === "FORFEIT_B") &&
    (!reason || reason.trim().length === 0)
  ) {
    throw new DuelReasonRequiredError();
  }

  const duel = await repo.getDuelById(duelId);
  if (!duel) {
    throw new DuelNotFoundError();
  }

  const session = await repo.getSessionById(duel.sessionId);
  if (!session || session.hostToken !== hostToken) {
    throw new HostTokenMismatchError();
  }

  if (duel.lifecycleState === "COMPLETED") {
    throw new DuelAlreadyResolvedError();
  }

  const result = await repo.resolveDuelExceptionally(
    duelId,
    hostToken,
    resolution,
    reason
  );

  return {
    duelId: result.duelId,
    lifecycleState: result.lifecycleState,
    terminalResolution: result.terminalResolution,
    winnerParticipantId: result.winnerParticipantId,
  };
}
