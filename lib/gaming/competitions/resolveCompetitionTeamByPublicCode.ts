import type { CompetitionsRepository } from "./db/competitionsRepository";
import type { ResolveCompetitionTeamPublicCodeResult } from "./types";

/**
 * RESOLVE_COMPETITION_TEAM_PUBLIC_CODE (UG-CR-GATE-081 Phase 3A). The
 * invitation-link counterpart of resolveCompetitionByPublicCode: turns
 * an opaque (competition public_code, team public_code) pair into both
 * real ids the existing invitation-preview route expects. Grants
 * nothing by itself — invitation-preview's own, already-accepted
 * unauthenticated-read boundary is unchanged.
 */
export async function resolveCompetitionTeamByPublicCode(
  repo: CompetitionsRepository,
  competitionPublicCode: string,
  teamPublicCode: string
): Promise<ResolveCompetitionTeamPublicCodeResult> {
  return repo.resolveCompetitionTeamByPublicCode(competitionPublicCode, teamPublicCode);
}
