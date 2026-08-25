import type { SessionRepository } from "./db/sessionRepository";
import type { AwardPointsResult } from "./types";

/**
 * AWARD_POINTS command handler.
 *
 * Scope: the host awards a participant a positive number of points for
 * a specific, currently-revealed interaction instance, idempotently.
 *
 * Deliberately thin — unlike every other command in this repo, this
 * function performs no fast-path validation of its own before calling
 * the repository. Every other command validates eagerly here (e.g.
 * startSession.ts trims and validates prompt text) precisely because
 * that validation is unconditionally correct to run. AWARD_POINTS is
 * different: whether *any* validation should run at all — host
 * authority, session state, interaction eligibility, participant
 * membership, points — depends entirely on whether the supplied
 * idempotencyKey already has a persisted result, and only the
 * repository (looking at the point_awards table) can know that. A
 * fast-path check here could reject a request that the repository
 * would have accepted as a valid replay, or duplicate a validation
 * that the repository is required to skip. So all of it, including
 * input validation, is deferred entirely to the repository's atomic
 * operation. This is a deliberate, one-off departure from this
 * repository's usual domain/repository split, made for this reason
 * alone.
 */
export async function awardPoints(
  repo: SessionRepository,
  sessionId: string,
  hostToken: string,
  interactionInstanceId: string,
  participantId: string,
  points: number,
  idempotencyKey: string
): Promise<AwardPointsResult> {
  const result = await repo.awardPoints(
    sessionId,
    hostToken,
    interactionInstanceId,
    participantId,
    points,
    idempotencyKey
  );

  return {
    pointAwardId: result.pointAwardId,
    sessionId: result.sessionId,
    // AWARD_POINTS only ever creates or replays an Interaction-sourced
    // award (repo.awardPoints's own signature requires
    // interactionInstanceId) — never null, unlike a Duel-sourced
    // PointAwardRecord (Ordinary Duel Session Scoring Slice 001).
    interactionInstanceId: result.interactionInstanceId!,
    participantId: result.participantId,
    points: result.points,
    createdAt: result.createdAt,
  };
}
