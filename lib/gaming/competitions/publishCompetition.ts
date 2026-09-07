import type { CompetitionsRepository } from "./db/competitionsRepository";
import type { PublishCompetitionResult } from "./types";

/** PUBLISH_COMPETITION. Atomically creates the two semifinals (with resolved teams) and the final (with unresolved finalist slots) — UG-CR-RPT-024 §3. */
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
