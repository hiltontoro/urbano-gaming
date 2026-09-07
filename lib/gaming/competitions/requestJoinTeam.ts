import type { CompetitionsRepository } from "./db/competitionsRepository";
import type { RequestJoinTeamResult } from "./types";

/** REQUEST_JOIN_TEAM. Requires an existing registration; at most one pending request per member per competition — enforced inside the atomic RPC. */
export async function requestJoinTeam(
  repo: CompetitionsRepository,
  competitionId: string,
  competitionTeamId: string,
  requestingGamingMemberId: string
): Promise<RequestJoinTeamResult> {
  return repo.requestJoinTeam(competitionId, competitionTeamId, requestingGamingMemberId);
}
