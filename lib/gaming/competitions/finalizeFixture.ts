import type { CompetitionsRepository } from "./db/competitionsRepository";
import type { FinalizeFixtureResult } from "./types";

/** FINALIZE_FIXTURE. Organizer only. Atomically resolves every then-open dispute as FINALIZED_AS_SUBMITTED and derives persistent records (UG-CR-RPT-024 §9). */
export async function finalizeFixture(repo: CompetitionsRepository, competitionFixtureId: string, organizerGamingMemberId: string): Promise<FinalizeFixtureResult> {
  return repo.finalizeFixture(competitionFixtureId, organizerGamingMemberId);
}
