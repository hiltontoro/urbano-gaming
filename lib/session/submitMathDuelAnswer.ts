import type { SessionRepository } from "./db/sessionRepository";
import type { SubmitMathDuelAnswerResult } from "./types";
import {
  DuelNotFoundError,
  DuelNotActiveError,
  DuelAccessDeniedError,
  InvalidMathDuelOrdinalError,
  InvalidMathDuelAnswerError,
  MathDuelChallengesExhaustedError,
} from "./types";

/**
 * SUBMIT_MATH_DUEL_ANSWER command handler.
 *
 * Math Duel Slice 001. Mirrors submitDuelResponse.ts's own thin,
 * fast-path-plus-authoritative-repository-call structure exactly.
 * Participant-token authority only, never a host token. Unlike
 * Multiple Choice's own upsert, a repeat call for an already-answered
 * ordinal is not a retried edit — it is treated as idempotent replay
 * inside the repository's own atomic operation (see
 * submit_math_duel_answer_atomically's own migration comment); this
 * handler does not need to, and does not, distinguish that case
 * itself.
 *
 * Duel-existence/mechanic/state authority: the getDuelById fast-path
 * check below is not the sole guarantee — the repository's
 * submitMathDuelAnswer call re-verifies everything (mechanic, Duel
 * state, competitor authorization, ordinal authorization) inside the
 * same atomic operation that records the response and, if this is the
 * answer that completes a shared condition, resolves the Duel.
 */
export async function submitMathDuelAnswer(
  repo: SessionRepository,
  duelId: string,
  participantToken: string,
  challengeOrdinal: number,
  submittedAnswer: number
): Promise<SubmitMathDuelAnswerResult> {
  const duel = await repo.getDuelById(duelId);
  if (!duel || duel.mechanicKey !== "MATH_DUEL") {
    throw new DuelNotFoundError();
  }

  if (duel.lifecycleState !== "ACTIVE") {
    throw new DuelNotActiveError(duel.lifecycleState);
  }

  const result = await repo.submitMathDuelAnswer(
    duelId,
    participantToken,
    challengeOrdinal,
    submittedAnswer
  );

  return {
    duelId,
    participantId: result.participantId,
    challengeOrdinal: result.challengeOrdinal,
    answeredAt: result.answeredAt,
  };
}

// Re-exported so callers that only import from this module still have
// access to every error this command may raise.
export {
  DuelNotFoundError,
  DuelNotActiveError,
  DuelAccessDeniedError,
  InvalidMathDuelOrdinalError,
  InvalidMathDuelAnswerError,
  MathDuelChallengesExhaustedError,
};
