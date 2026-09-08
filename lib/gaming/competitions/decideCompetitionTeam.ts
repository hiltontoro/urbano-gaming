import type { CompetitionsRepository } from "./db/competitionsRepository";
import type { DecideCompetitionTeamResult } from "./types";

/**
 * DECIDE_COMPETITION_TEAM. Organizer only. On APPROVE, atomically
 * confirms the proposer as captain and creates their one confirmed team
 * membership — the same call, never a separate join-request/approval
 * step (accepted decisions §9). On REJECT, a reason is required and the
 * proposal row is retained, never deleted (accepted decisions §4).
 */
export async function decideCompetitionTeam(
  repo: CompetitionsRepository,
  competitionTeamId: string,
  organizerGamingMemberId: string,
  decision: "APPROVE" | "REJECT",
  reason: string | null
): Promise<DecideCompetitionTeamResult> {
  return repo.decideCompetitionTeam(competitionTeamId, organizerGamingMemberId, decision, reason);
}
