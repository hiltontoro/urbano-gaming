import type { HostRepository } from "./db/hostRepository";
import type { RevokeHostCapabilityResult } from "./types";
import { HostApplicationNotFoundError, HostReasonRequiredError } from "./types";
import { isWellFormedPublicCode } from "./publicCodeShape";
import { cleanReason } from "./cleanReason";

/** REVOKE_HOST_CAPABILITY — governance only (enforced in the database); a reason is required. */
export async function revokeHostCapability(
  repo: HostRepository,
  reviewerGamingMemberId: string,
  publicCode: unknown,
  reason: unknown
): Promise<RevokeHostCapabilityResult> {
  if (!isWellFormedPublicCode(publicCode)) throw new HostApplicationNotFoundError();
  const cleaned = cleanReason(reason);
  if (cleaned === null) throw new HostReasonRequiredError();
  return repo.revokeCapability(reviewerGamingMemberId, publicCode, cleaned);
}
