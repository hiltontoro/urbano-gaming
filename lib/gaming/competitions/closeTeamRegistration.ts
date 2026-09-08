import type { CompetitionsRepository } from "./db/competitionsRepository";
import type { CloseTeamRegistrationResult } from "./types";

/** CLOSE_TEAM_REGISTRATION. Organizer only, exactly four accepted teams required — enforced inside the atomic RPC. */
export async function closeTeamRegistration(
  repo: CompetitionsRepository,
  competitionId: string,
  organizerGamingMemberId: string
): Promise<CloseTeamRegistrationResult> {
  return repo.closeTeamRegistration(competitionId, organizerGamingMemberId);
}
