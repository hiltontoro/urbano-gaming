import type { HostRepository } from "./db/hostRepository";
import type { DecideHostApplicationResult, HostDecision } from "./types";
import { HostApplicationNotFoundError, HostReasonRequiredError, InvalidHostDecisionError } from "./types";
import { isWellFormedPublicCode } from "./publicCodeShape";
import { cleanReason } from "./cleanReason";

/**
 * DECIDE_HOST_APPLICATION. Whether the caller may decide at all (an active
 * PRODUCT_GOVERNANCE grant, never the applicant themself) is enforced inside
 * decide_host_application_atomically; this layer only checks the shape of the
 * request so a malformed one never reaches the database.
 */
export async function decideHostApplication(
  repo: HostRepository,
  reviewerGamingMemberId: string,
  publicCode: unknown,
  decision: unknown,
  reason: unknown
): Promise<DecideHostApplicationResult> {
  if (decision !== "APPROVE" && decision !== "REJECT") throw new InvalidHostDecisionError();
  if (!isWellFormedPublicCode(publicCode)) throw new HostApplicationNotFoundError();
  const trimmedReason = cleanReason(reason);
  if (decision === "REJECT" && trimmedReason === null) throw new HostReasonRequiredError();
  return repo.decideApplication(reviewerGamingMemberId, publicCode, decision as HostDecision, trimmedReason);
}
