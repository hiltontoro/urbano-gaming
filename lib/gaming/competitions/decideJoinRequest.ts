import type { CompetitionsRepository } from "./db/competitionsRepository";
import type { DecideJoinRequestResult } from "./types";

/** DECIDE_JOIN_REQUEST. Actor is the target team's captain, or the organizer overriding. */
export async function decideJoinRequest(
  repo: CompetitionsRepository,
  competitionJoinRequestId: string,
  decidingGamingMemberId: string,
  decision: "APPROVE" | "REJECT",
  isOrganizerOverride: boolean
): Promise<DecideJoinRequestResult> {
  return repo.decideJoinRequest(competitionJoinRequestId, decidingGamingMemberId, decision, isOrganizerOverride);
}
