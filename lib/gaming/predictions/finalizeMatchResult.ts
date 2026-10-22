import type { PredictionsRepository } from "./db/predictionsRepository";

/**
 * FINALIZE_RESULT — the authoritative settlement boundary for a
 * Match's first Result. All settlement logic (evaluation, progression
 * awarding, prize qualification) lives inside
 * finalize_match_result_atomically itself, transactionally — this
 * wrapper exists only for the same reason every other command in this
 * codebase gets one: a stable, testable seam between the API route and
 * the repository.
 *
 * expectedDigest is the digest of the exact content the finalizer
 * reviewed (see resultIntegrity.ts). Finalizing without one, or with a
 * digest that no longer matches the draft, is rejected — so content that
 * was not reviewed can never be settled. The digest says WHICH content
 * was reviewed; it is not authorization.
 *
 * CONSEQUENTIAL_FINALIZER authority is enforced inside the RPC itself
 * (the sole enforcement boundary — no fast-path duplicate check here,
 * since this function has no data already in hand to check against
 * without an extra round trip the RPC's own atomic check makes
 * unnecessary). reason is optional for first finalization, per
 * Product/Authority_and_Audit_Foundation.md's reason policy.
 */
export async function finalizeMatchResult(
  repo: PredictionsRepository,
  matchResultId: string,
  finalizedByGamingMemberId: string,
  expectedDigest: string,
  reason?: string | null
): Promise<{ matchResultId: string; finalizedAt: string; alreadyFinalized: boolean }> {
  return repo.finalizeMatchResult(matchResultId, finalizedByGamingMemberId, reason ?? null, expectedDigest);
}
