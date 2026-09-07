import type { CompetitionsRepository } from "./db/competitionsRepository";
import type { AddCompetitionTeamResult } from "./types";

/** ADD_COMPETITION_TEAM. Organizer only, DRAFT only — enforced inside the atomic RPC. */
export async function addCompetitionTeam(
  repo: CompetitionsRepository,
  competitionId: string,
  organizerGamingMemberId: string,
  name: string,
  captainGamingMemberId: string
): Promise<AddCompetitionTeamResult> {
  return repo.addCompetitionTeam(competitionId, organizerGamingMemberId, name, captainGamingMemberId);
}
