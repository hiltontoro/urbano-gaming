import type { CompetitionsRepository } from "./db/competitionsRepository";
import type { AddCompetitionTeamResult } from "./types";
import { generatePublicCode } from "./publicCode";

/**
 * ADD_COMPETITION_TEAM. Organizer only, DRAFT only — enforced inside
 * the atomic RPC. Generates the opaque public_code (UG-CR-GATE-081
 * Phase 3A) the same way createCompetition does.
 */
export async function addCompetitionTeam(
  repo: CompetitionsRepository,
  competitionId: string,
  organizerGamingMemberId: string,
  name: string,
  captainGamingMemberId: string
): Promise<AddCompetitionTeamResult> {
  return repo.addCompetitionTeam(competitionId, organizerGamingMemberId, name, captainGamingMemberId, generatePublicCode());
}
