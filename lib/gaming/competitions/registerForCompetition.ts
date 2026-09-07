import type { CompetitionsRepository } from "./db/competitionsRepository";
import type { RegisterForCompetitionResult } from "./types";

/** REGISTER_FOR_COMPETITION. isAdultSelfAttested is synthetic self-attestation only — never verified age/identity (UG-CR-REV-026 condition/decision 5). */
export async function registerForCompetition(
  repo: CompetitionsRepository,
  competitionId: string,
  gamingMemberId: string,
  isAdultSelfAttested: boolean
): Promise<RegisterForCompetitionResult> {
  return repo.registerForCompetition(competitionId, gamingMemberId, isAdultSelfAttested);
}
