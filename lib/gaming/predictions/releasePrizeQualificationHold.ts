import type { PredictionsRepository } from "./db/predictionsRepository";
import { ReasonRequiredError } from "../authority/types";

/**
 * RELEASE_PRIZE_HOLD — the reasoned Founder decision that a replacement
 * entitlement, created on hold because a correction changed a prize that
 * had already been delivered, may now be delivered.
 *
 * Releasing delivers nothing: the entitlement becomes redeemable through
 * the ordinary redemption, which stays a separate explicit act, so a
 * correction can never authorize a second physical delivery on its own.
 *
 * CONSEQUENTIAL_FINALIZER authority is enforced inside the RPC (same
 * reasoning as redeemPrizeQualification). A reason is mandatory; it is
 * checked here as a fast path and again inside the RPC, and is stored on
 * the entitlement and on an attributable admin_audit_events row.
 */
export async function releasePrizeQualificationHold(
  repo: PredictionsRepository,
  prizeQualificationId: string,
  releasedByGamingMemberId: string,
  reason: string
): Promise<{ prizeQualificationId: string; releasedAt: string; alreadyReleased: boolean }> {
  if (!reason || reason.trim().length === 0) {
    throw new ReasonRequiredError();
  }
  return repo.releasePrizeQualificationHold(prizeQualificationId, releasedByGamingMemberId, reason.trim());
}
