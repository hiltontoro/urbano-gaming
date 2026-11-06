import type { CompetitionsRepository } from "./db/competitionsRepository";
import type { PublishCompetitionResult } from "./types";

/**
 * PUBLISH_COMPETITION - LEGACY MANUAL PUBLICATION. Atomically creates the two semifinals (with resolved teams) and the final (with unresolved finalist slots) from teams and kickoff
 * times the caller supplies — UG-CR-RPT-024 §3. Its behavior is unchanged, and it is retained ONLY for competitions outside the schedule journey: the database refuses it
 * (SCHEDULE_PROPOSAL_PUBLICATION_REQUIRED) for every competition that has a registration freeze, a draw or a schedule proposal. A competition that belongs to the schedule journey
 * is published from its exact CURRENT schedule proposal by publishScheduledCompetition (schedulePublication.ts). This is not a way to publish a new competition.
 */
export async function publishCompetition(
  repo: CompetitionsRepository,
  competitionId: string,
  organizerGamingMemberId: string,
  semifinal1TeamAId: string,
  semifinal1TeamBId: string,
  semifinal2TeamAId: string,
  semifinal2TeamBId: string,
  semifinal1ScheduledAt: string,
  semifinal2ScheduledAt: string,
  finalScheduledAt: string
): Promise<PublishCompetitionResult> {
  return repo.publishCompetition(
    competitionId, organizerGamingMemberId,
    semifinal1TeamAId, semifinal1TeamBId, semifinal2TeamAId, semifinal2TeamBId,
    semifinal1ScheduledAt, semifinal2ScheduledAt, finalScheduledAt
  );
}
