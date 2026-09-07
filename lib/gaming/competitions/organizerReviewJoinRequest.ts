import type { CompetitionsRepository } from "./db/competitionsRepository";
import type { OrganizerReviewJoinRequestResult } from "./types";

/** ORGANIZER_REVIEW_JOIN_REQUEST. The one-shot review path for an already-rejected request (REV-015 decision 3) — no further transition possible afterward. */
export async function organizerReviewJoinRequest(
  repo: CompetitionsRepository,
  competitionJoinRequestId: string,
  organizerGamingMemberId: string,
  decision: "APPROVE" | "REJECT",
  reason: string
): Promise<OrganizerReviewJoinRequestResult> {
  return repo.organizerReviewJoinRequest(competitionJoinRequestId, organizerGamingMemberId, decision, reason);
}
