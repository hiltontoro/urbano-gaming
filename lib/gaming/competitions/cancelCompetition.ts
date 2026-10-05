import type { CompetitionsRepository } from "./db/competitionsRepository";
import type { CancelCompetitionResult } from "./types";

/**
 * CANCEL_INCOMPLETE_COMPETITION (UG-CR-GATE-081 Phase 3E). Organizer
 * only, DRAFT/TEAM_REGISTRATION_OPEN/READY_TO_PUBLISH only, reason
 * required, idempotent against an already-cancelled competition — every
 * check enforced inside the atomic RPC, mirroring every other command
 * in this domain. Never deletes anything; sets the same
 * CANCELLED_WITHOUT_CHAMPION state and cancelled_reason the existing
 * fixture-void cascade already uses for a published competition.
 */
export async function cancelCompetition(
  repo: CompetitionsRepository,
  competitionId: string,
  organizerGamingMemberId: string,
  reason: string
): Promise<CancelCompetitionResult> {
  return repo.cancelCompetition(competitionId, organizerGamingMemberId, reason);
}
