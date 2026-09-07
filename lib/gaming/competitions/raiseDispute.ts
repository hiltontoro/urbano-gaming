import type { CompetitionsRepository } from "./db/competitionsRepository";
import type { RaiseDisputeResult } from "./types";

/** RAISE_DISPUTE. Never itself changes a fact — only requests organizer review. */
export async function raiseDispute(
  repo: CompetitionsRepository,
  competitionFixtureId: string,
  raisedByGamingMemberId: string,
  targetFactType: string,
  targetFactId: string,
  reason: string
): Promise<RaiseDisputeResult> {
  return repo.raiseDispute(competitionFixtureId, raisedByGamingMemberId, targetFactType, targetFactId, reason);
}
