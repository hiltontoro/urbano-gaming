import type { CompetitionsRepository } from "./db/competitionsRepository";
import type { CheckInResult } from "./types";

/** CHECK_IN. Presence only, never participation (UG-CR-RPT-016 §6). */
export async function checkIn(repo: CompetitionsRepository, competitionFixtureId: string, gamingMemberId: string): Promise<CheckInResult> {
  return repo.checkIn(competitionFixtureId, gamingMemberId);
}
