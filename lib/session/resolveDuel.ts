import type { SessionRepository } from "./db/sessionRepository";
import type { ResolveDuelResult } from "./types";
import { DuelNotFoundError, HostTokenMismatchError, DuelAlreadyResolvedError } from "./types";

/**
 * RESOLVE_DUEL command handler.
 *
 * Duel / SESSION_SUBGAME v1 (Product/Duel_Architecture.md). The
 * normal, mechanic-derived resolution — Host-triggered pacing, no
 * timer, no background job, mirroring closeSubmissions.ts's own
 * precedent exactly. Deterministic winner logic lives in the
 * repository's atomic operation (see 0131's own migration comment for
 * the exact truth table); this handler only authenticates the caller
 * and re-verifies the Duel exists and is still ACTIVE before
 * delegating.
 *
 * Host-token and Duel-state authority: the getDuelById/host-token
 * lookups below are a fast-path check for immediate rejection — they
 * are NOT the sole guarantee. The repository's resolveDuel call is the
 * authoritative check, re-verifying both inside the same atomic
 * operation that computes and persists the result.
 */
export async function resolveDuel(
  repo: SessionRepository,
  duelId: string,
  hostToken: string
): Promise<ResolveDuelResult> {
  const duel = await repo.getDuelById(duelId);
  if (!duel) {
    throw new DuelNotFoundError();
  }

  const session = await repo.getSessionById(duel.sessionId);
  if (!session || session.hostToken !== hostToken) {
    throw new HostTokenMismatchError();
  }

  if (duel.lifecycleState !== "ACTIVE") {
    throw new DuelAlreadyResolvedError();
  }

  const result = await repo.resolveDuel(duelId, hostToken);

  return {
    duelId: result.duelId,
    lifecycleState: result.lifecycleState,
    terminalResolution: result.terminalResolution,
    winnerParticipantId: result.winnerParticipantId,
  };
}
