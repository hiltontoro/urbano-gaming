import type { CompetitionsRepository } from "./db/competitionsRepository";
import type { ForfeitFixtureResult } from "./types";

/** FORFEIT_FIXTURE. Organizer only, reason required. Produces only a team-level winner — never an invented individual fact. */
export async function forfeitFixture(
  repo: CompetitionsRepository,
  competitionFixtureId: string,
  organizerGamingMemberId: string,
  forfeitingCompetitionTeamId: string,
  reason: string
): Promise<ForfeitFixtureResult> {
  return repo.forfeitFixture(competitionFixtureId, organizerGamingMemberId, forfeitingCompetitionTeamId, reason);
}
