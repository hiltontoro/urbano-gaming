import type { PredictionsRepository } from "./db/predictionsRepository";

/**
 * REDEEM_PRIZE_QUALIFICATION — v1 redemption: a single admin action,
 * exactly once, idempotent on retry. Never claws back a redeemed
 * qualification even if a later correction supersedes it.
 *
 * CONSEQUENTIAL_FINALIZER authority is enforced inside the RPC (same
 * reasoning as finalizeMatchResult/correctMatchResult — no TS-layer
 * fast-path duplicate check). reason is optional, matching every
 * CONSEQUENTIAL_FINALIZER action except correction.
 */
export async function redeemPrizeQualification(
  repo: PredictionsRepository,
  prizeQualificationId: string,
  redeemedByGamingMemberId: string,
  reason?: string | null
): Promise<{ prizeQualificationId: string; redeemedAt: string; alreadyRedeemed: boolean }> {
  return repo.redeemPrizeQualification(prizeQualificationId, redeemedByGamingMemberId, reason ?? null);
}
