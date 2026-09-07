import type { CompetitionsRepository } from "./db/competitionsRepository";
import type { AppointScorekeeperResult } from "./types";

/** APPOINT_SCOREKEEPER. Organizer only; conflict-of-interest checked inside the atomic RPC (checkpoint 1 of 5 — UG-CR-RPT-024 §5). */
export async function appointScorekeeper(
  repo: CompetitionsRepository,
  competitionFixtureId: string,
  organizerGamingMemberId: string,
  scorekeeperGamingMemberId: string
): Promise<AppointScorekeeperResult> {
  return repo.appointScorekeeper(competitionFixtureId, organizerGamingMemberId, scorekeeperGamingMemberId);
}
