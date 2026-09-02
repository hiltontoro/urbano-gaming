import type { SessionRepository } from "./db/sessionRepository";
import type { ApplyPulseTargetResult } from "./types";

/**
 * TARGET_CELL command handler.
 *
 * URBANO Pulse Slice 001 (UG-CR-GATE-002). Participant-token authority
 * only. Every authoritative check — idempotency (checked first, the
 * mandatory Towers lesson: a completing-target retry must return the
 * original result rather than being rejected because the duel is no
 * longer ACTIVE), duel/mechanic existence, competitor membership, duel
 * ACTIVE, the lazy deadline check (PulseTurnExpiredError — never
 * resolved as a side effect here; see claimPulseTimeoutForfeit.ts),
 * current-actor enforcement, bounds, duplicate-coordinate rejection,
 * server-derived hit/miss/completed-form result, atomic evidence
 * append, terminal evaluation, and turn advance — lives inside the
 * repository's own atomic operation. This handler performs no
 * fast-path re-implementation of any of it.
 */
export async function targetPulseCell(
  repo: SessionRepository,
  duelId: string,
  participantToken: string,
  row: number,
  col: number,
  idempotencyKey: string
): Promise<ApplyPulseTargetResult> {
  const result = await repo.applyPulseTarget(duelId, participantToken, row, col, idempotencyKey);

  return {
    duelId,
    result: result.result,
    completedFormId: result.completedFormId,
    terminal: result.terminal,
    winnerParticipantId: result.winnerParticipantId,
    currentActorParticipantId: result.nextActorParticipantId,
    currentDeadline: result.nextDeadline,
    alreadyApplied: result.alreadyApplied,
  };
}
