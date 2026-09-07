import type { CompetitionsRepository } from "./db/competitionsRepository";
import type { StartCompetitionResult } from "./types";

/** CREATE_COMPETITION. Requires the caller to hold active platform OPERATIONAL authority — enforced inside the atomic RPC, not here. */
export async function createCompetition(
  repo: CompetitionsRepository,
  organizerGamingMemberId: string,
  name: string,
  activityKey: string
): Promise<StartCompetitionResult> {
  return repo.createCompetition(organizerGamingMemberId, name, activityKey);
}
