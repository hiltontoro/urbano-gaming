import type { SessionRepository } from "./db/sessionRepository";
import type { SubmitDuelResponseResult } from "./types";
import {
  DuelNotFoundError,
  DuelNotActiveError,
  DuelAccessDeniedError,
  InvalidDuelOptionSelectionError,
} from "./types";

/**
 * SUBMIT_DUEL_RESPONSE command handler.
 *
 * Duel / SESSION_SUBGAME v1. Scope: authenticates the caller as a
 * Session participant via their participant token — never a host
 * token, mirroring submitResponse.ts's own precedent exactly — and
 * requires that resolved participant to be one of this Duel's two
 * bound competitors. "Last write wins" on retry (idempotent upsert),
 * the same MVP decision submitResponse.ts already made.
 *
 * Duel-existence and Duel-state authority: the getDuelById lookup
 * below is a fast-path check for immediate rejection — it is NOT the
 * sole guarantee. The repository's submitDuelResponse call is the
 * authoritative check, re-verifying the Duel's state and the caller's
 * competitor status inside the same atomic operation that persists
 * the response.
 */
export async function submitDuelResponse(
  repo: SessionRepository,
  duelId: string,
  participantToken: string,
  selectedOptionIndex: number
): Promise<SubmitDuelResponseResult> {
  const duel = await repo.getDuelById(duelId);
  if (!duel) {
    throw new DuelNotFoundError();
  }

  if (duel.lifecycleState !== "ACTIVE") {
    throw new DuelNotActiveError(duel.lifecycleState);
  }

  const result = await repo.submitDuelResponse(
    duelId,
    participantToken,
    selectedOptionIndex
  );

  return {
    duelId,
    participantId: result.participantId,
    answeredAt: result.answeredAt,
  };
}

// Re-exported so callers that only import from this module still have
// access to every error this command may raise.
export {
  DuelNotFoundError,
  DuelNotActiveError,
  DuelAccessDeniedError,
  InvalidDuelOptionSelectionError,
};
