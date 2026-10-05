import type { CompetitionsRepository } from "./db/competitionsRepository";
import type { ResolveCompetitionPublicCodeResult } from "./types";

/**
 * RESOLVE_COMPETITION_PUBLIC_CODE (UG-CR-GATE-081 Phase 3A). Turns an
 * opaque, user-visible public_code into the real competitionId the rest
 * of this domain's existing, already-authorized routes expect — nothing
 * else. This lookup grants nothing by itself: whatever the caller does
 * next (view a competition, open an invitation preview) is still
 * independently authorized exactly as before.
 */
export async function resolveCompetitionByPublicCode(
  repo: CompetitionsRepository,
  publicCode: string
): Promise<ResolveCompetitionPublicCodeResult> {
  return repo.resolveCompetitionByPublicCode(publicCode);
}
