import type { CompetitionsRepository } from "./db/competitionsRepository";
import type { VoidFixtureResult } from "./types";

/** VOID_FIXTURE. Organizer only, reason required. Voiding any required knockout fixture immediately cancels the whole competition as CANCELLED_WITHOUT_CHAMPION (UG-CR-REV-019) — no rematch flow, no data erased. */
export async function voidFixture(repo: CompetitionsRepository, competitionFixtureId: string, organizerGamingMemberId: string, reason: string): Promise<VoidFixtureResult> {
  return repo.voidFixture(competitionFixtureId, organizerGamingMemberId, reason);
}
