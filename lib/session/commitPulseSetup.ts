import type { SessionRepository } from "./db/sessionRepository";
import type { CommitPulseSetupResult, PulseForm } from "./types";

/**
 * COMMIT_SETUP command handler.
 *
 * URBANO Pulse Slice 001 (UG-CR-GATE-002). Participant-token authority
 * only, never a host token, mirroring submitDuelResponse.ts's own
 * precedent. This handler performs no fast-path validation of its
 * own — every check (duel existence/mechanic, competitor membership,
 * duel ACTIVE, idempotency, layout validity, commitment immutability,
 * and — on the second commit — activation) is authoritative only
 * inside the repository's own atomic operation, since the coin-flip
 * activation must be indivisible from the validity check that permits
 * it.
 */
export async function commitPulseSetup(
  repo: SessionRepository,
  duelId: string,
  participantToken: string,
  forms: PulseForm[],
  wasAssisted: boolean,
  idempotencyKey: string
): Promise<CommitPulseSetupResult> {
  const result = await repo.commitPulseSetup(duelId, participantToken, forms, wasAssisted, idempotencyKey);

  return {
    duelId,
    participantId: result.participantId,
    committedAt: result.committedAt,
    activated: result.activated,
    currentActorParticipantId: result.currentActorParticipantId,
    currentDeadline: result.currentDeadline,
    alreadyApplied: result.alreadyApplied,
  };
}
