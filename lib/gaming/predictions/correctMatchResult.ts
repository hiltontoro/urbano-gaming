import type { PredictionsRepository } from "./db/predictionsRepository";
import { ReasonRequiredError } from "../authority/types";

/**
 * FINALIZE_CORRECTION — the correction counterpart to
 * finalizeMatchResult. matchResultId must already be a draft created
 * with supersedesMatchResultId set (via saveDraftResult in
 * adminCatalog.ts) — all compensation/supersession logic lives inside
 * correct_match_result_atomically itself.
 *
 * CONSEQUENTIAL_FINALIZER authority is enforced inside the RPC (same
 * reasoning as finalizeMatchResult). reason is mandatory for
 * correction, per Product/Authority_and_Audit_Foundation.md's reason
 * policy — checked here as a genuine fast path (a plain string check,
 * zero data dependency, unlike the authority check) as well as inside
 * the RPC itself, so a caller that somehow bypasses this wrapper is
 * still rejected before any mutation.
 */
export async function correctMatchResult(
  repo: PredictionsRepository,
  matchResultId: string,
  finalizedByGamingMemberId: string,
  reason: string
): Promise<{
  matchResultId: string;
  finalizedAt: string;
  supersedesMatchResultId: string;
  alreadyFinalized: boolean;
}> {
  if (!reason || reason.trim().length === 0) {
    throw new ReasonRequiredError();
  }
  return repo.correctMatchResult(matchResultId, finalizedByGamingMemberId, reason);
}
