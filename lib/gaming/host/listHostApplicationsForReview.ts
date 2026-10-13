import type { HostRepository } from "./db/hostRepository";
import type { HostReviewRecord, HostReviewView } from "./types";
import { InvalidHostReviewViewError } from "./types";

/** LIST_HOST_APPLICATIONS_FOR_REVIEW — governance only, enforced inside the database function. */
export async function listHostApplicationsForReview(
  repo: HostRepository,
  reviewerGamingMemberId: string,
  view: unknown
): Promise<HostReviewRecord[]> {
  if (view !== "PENDING" && view !== "ACTIVE" && view !== "HISTORY") throw new InvalidHostReviewViewError();
  return repo.listForReview(reviewerGamingMemberId, view as HostReviewView);
}
