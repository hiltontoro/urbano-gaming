import type { CompetitionsRepository } from "./db/competitionsRepository";
import type { ProposeCompetitionTeamResult } from "./types";

/**
 * PROPOSE_COMPETITION_TEAM. proposingGamingMemberId is always the
 * verified caller's own — the creator becomes the proposed captain by
 * construction (accepted decisions §5/§9); the route layer never accepts
 * any other actor id for this call. Registration/open-registration/
 * capacity/name-uniqueness/captaincy-exclusivity are all enforced inside
 * the atomic RPC.
 */
export async function proposeCompetitionTeam(
  repo: CompetitionsRepository,
  competitionId: string,
  name: string,
  proposingGamingMemberId: string
): Promise<ProposeCompetitionTeamResult> {
  return repo.proposeCompetitionTeam(competitionId, name, proposingGamingMemberId);
}
