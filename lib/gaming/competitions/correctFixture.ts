import type { CompetitionsRepository } from "./db/competitionsRepository";
import type { GoalEventInput, AssistEventInput, CorrectFixtureResult } from "./types";

/** CORRECT_FIXTURE. Organizer only, reason always required. Supersedes the whole evidence bundle; triggers the semifinal-correction cascade when the winner changes (UG-CR-RPT-024 §7). */
export async function correctFixture(
  repo: CompetitionsRepository,
  competitionFixtureId: string,
  organizerGamingMemberId: string,
  reason: string,
  teamAScore: number,
  teamBScore: number,
  goalEvents: GoalEventInput[],
  assistEvents: AssistEventInput[],
  penaltyShootoutWinningTeamId: string | null
): Promise<CorrectFixtureResult> {
  return repo.correctFixture(
    competitionFixtureId, organizerGamingMemberId, reason, teamAScore, teamBScore,
    goalEvents, assistEvents, penaltyShootoutWinningTeamId
  );
}
