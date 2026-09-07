import type { CompetitionsRepository } from "./db/competitionsRepository";
import type { DeclareRosterResult } from "./types";

/** DECLARE_ROSTER. Append-only revision (UG-CR-REV-021 decision 2) — never mutates a prior roster in place. */
export async function declareRoster(
  repo: CompetitionsRepository,
  competitionFixtureId: string,
  competitionTeamId: string,
  declaringGamingMemberId: string,
  isOrganizerAction: boolean,
  reason: string | null,
  gamingMemberIds: string[]
): Promise<DeclareRosterResult> {
  return repo.declareRoster(competitionFixtureId, competitionTeamId, declaringGamingMemberId, isOrganizerAction, reason, gamingMemberIds);
}
