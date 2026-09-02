import type { SessionRepository } from "./db/sessionRepository";
import type { ClaimPulseTimeoutResult } from "./types";

/**
 * CLAIM_TIMEOUT command handler.
 *
 * URBANO Pulse Slice 001 (UG-CR-GATE-002). The CLOSE_QUIZ pattern
 * applied to Pulse's own 60-second turn deadline: dual-authority
 * (either competitor may call this — participant-token authority
 * only), lazy (no background job; only enactable once the
 * server-authoritative deadline has genuinely passed, re-verified
 * inside the repository's own atomic operation, never trusted from
 * this handler), and idempotent by construction (a call against an
 * already-COMPLETED duel simply returns the cached terminal facts
 * rather than re-resolving — no separate idempotency-key parameter is
 * needed, since "the duel is already terminal" is itself the complete,
 * sufficient idempotency signal for this action).
 */
export async function claimPulseTimeoutForfeit(
  repo: SessionRepository,
  duelId: string,
  participantToken: string
): Promise<ClaimPulseTimeoutResult> {
  const result = await repo.claimPulseTimeout(duelId, participantToken);

  return {
    duelId,
    terminal: result.terminal,
    terminalResolution: result.terminalResolution,
    winnerParticipantId: result.winnerParticipantId,
    alreadyApplied: result.alreadyApplied,
  };
}
