import type { CompetitionsRepository } from "./db/competitionsRepository";
import type { OpenTeamRegistrationResult } from "./types";

/** OPEN_TEAM_REGISTRATION. Organizer only, DRAFT only — enforced inside the atomic RPC. */
export async function openTeamRegistration(
  repo: CompetitionsRepository,
  competitionId: string,
  organizerGamingMemberId: string
): Promise<OpenTeamRegistrationResult> {
  return repo.openTeamRegistration(competitionId, organizerGamingMemberId);
}
