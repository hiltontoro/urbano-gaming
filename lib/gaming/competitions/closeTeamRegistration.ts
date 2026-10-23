import type { CompetitionsRepository } from "./db/competitionsRepository";
import type { CloseTeamRegistrationResult } from "./types";
import { summarizeRegistrationFreeze } from "./registrationFreeze";

/**
 * CLOSE_TEAM_REGISTRATION — the registration FREEZE checkpoint (UG-CR-GATE-SSS-007). Organizer only; every condition (the deadline has passed by the
 * database clock, exactly four accepted teams, nothing pending, every roster within the plan's bounds, everyone on one team) is judged inside the one
 * atomic operation, which also records the immutable freeze. An exact retry returns the freeze that exists.
 *
 * What comes back is the operation's own result plus, when a freeze is recorded, its summary for the organizer: team names and counts, never an
 * identifier, the digest or the actor. A competition with no freeze (an older one) returns the plain result.
 */
export async function closeTeamRegistration(
  repo: CompetitionsRepository,
  competitionId: string,
  organizerGamingMemberId: string
): Promise<CloseTeamRegistrationResult> {
  const result = await repo.closeTeamRegistration(competitionId, organizerGamingMemberId);
  const evidence = await repo.getRegistrationFreeze(competitionId);
  if (!evidence) return result;
  const teams = await repo.getCompetitionTeams(competitionId);
  return { ...result, freeze: summarizeRegistrationFreeze(evidence, teams) };
}
