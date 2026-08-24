import type { SessionRepository } from "./db/sessionRepository";
import type { SubmitMathDuelAnswerResult } from "./types";
import {
  DuelNotFoundError,
  DuelNotActiveError,
  DuelAccessDeniedError,
  InvalidMathDuelOrdinalError,
  InvalidMathDuelAnswerError,
  InvalidMathDuelChallengesError,
  MathDuelChallengesExhaustedError,
} from "./types";
import { generateSuddenDeathChallenge } from "./mathDuelFixture";

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
 *
 * Pre-Deployment Product-Invariant Correction: sudden death is no
 * longer pre-materialized (see mathDuelFixture.ts's own top comment),
 * so every call speculatively computes the *candidate* content for
 * challengeOrdinal + 1 and passes it through — used by the repository
 * only if this specific submission turns out to be the one that
 * confirms a tie at challengeOrdinal; discarded otherwise. Computing
 * it unconditionally rather than only "when needed" mirrors
 * startMathDuel's own precedent of always selecting content up front
 * in the domain layer, never inside the RPC — content only ever gets
 * persisted once, atomically, at the exact moment the repository
 * confirms it is actually required.
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

  const nextChallengeCandidate = generateSuddenDeathChallenge(
    duelId,
    challengeOrdinal + 1
  );

  const result = await repo.submitMathDuelAnswer(
    duelId,
    participantToken,
    challengeOrdinal,
    submittedAnswer,
    nextChallengeCandidate
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
  InvalidMathDuelChallengesError,
  MathDuelChallengesExhaustedError,
};
