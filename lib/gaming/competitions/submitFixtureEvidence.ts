import type { CompetitionsRepository } from "./db/competitionsRepository";
import type { GoalEventInput, AssistEventInput, ParticipationAttestationInput, SubmitFixtureEvidenceResult } from "./types";

/** SUBMIT_FIXTURE_EVIDENCE. One atomic bundle — score, goal/assist events, attestations, and the shootout winner when tied (UG-CR-REV-021 decision 4). The only way a shootout is ever first submitted. */
export async function submitFixtureEvidence(
  repo: CompetitionsRepository,
  competitionFixtureId: string,
  scorekeeperGamingMemberId: string,
  teamAScore: number,
  teamBScore: number,
  goalEvents: GoalEventInput[],
  assistEvents: AssistEventInput[],
  participationAttestations: ParticipationAttestationInput[],
  penaltyShootoutWinningTeamId: string | null
): Promise<SubmitFixtureEvidenceResult> {
  return repo.submitFixtureEvidence(
    competitionFixtureId, scorekeeperGamingMemberId, teamAScore, teamBScore,
    goalEvents, assistEvents, participationAttestations, penaltyShootoutWinningTeamId
  );
}
