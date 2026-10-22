import type { PredictionsRepository } from "../../lib/gaming/predictions/db/predictionsRepository";
import { saveMatchResultDraft } from "../../lib/gaming/predictions/adminCatalog";
import { finalizeMatchResult as finalizeMatchResultDomain } from "../../lib/gaming/predictions/finalizeMatchResult";
import { correctMatchResult as correctMatchResultDomain } from "../../lib/gaming/predictions/correctMatchResult";
import { saveBaseToken } from "../../lib/gaming/predictions/resultIntegrity";
import type { OfficialGoalEventInput } from "../../lib/gaming/predictions/types";

/**
 * Behavioral-test helpers that do what the admin page does around the
 * result endpoints: load the stored draft, take the digest of exactly
 * what was loaded, and act on that. They keep the many scenario tests
 * about settlement and prizes focused on those rules, while the
 * digest/staleness behavior itself is tested explicitly in
 * resultIntegrity.test.ts.
 */

export async function currentSaveBase(repo: PredictionsRepository, matchId: string): Promise<string> {
  const draft = await repo.getDraftMatchResult(matchId);
  const finalized = await repo.getCurrentFinalizedMatchResult(matchId);
  return saveBaseToken({
    draftDigest: draft ? await repo.getMatchResultContentDigest(draft.matchResultId) : null,
    finalizedDigest: finalized ? await repo.getMatchResultContentDigest(finalized.matchResultId) : null,
  });
}

type DraftInput = {
  matchId: string;
  homeScore: number;
  awayScore: number;
  officialGoalEvents: OfficialGoalEventInput[];
  enteredByGamingMemberId: string;
};

/** Saves the match's draft (a first result or a correction) over whatever draft is stored. */
export async function saveResult(repo: PredictionsRepository, input: DraftInput) {
  return saveMatchResultDraft(repo, {
    ...input,
    saveBase: await currentSaveBase(repo, input.matchId),
  });
}

export const saveDraftResult = saveResult;
export const startResultCorrection = saveResult;

/** Finalizes the stored content of a result, as reviewed at the moment of the call. */
export async function finalizeMatchResult(
  repo: PredictionsRepository,
  matchResultId: string,
  finalizedByGamingMemberId: string,
  reason?: string | null
) {
  const digest = (await repo.getMatchResultContentDigest(matchResultId)) ?? "MISSING";
  return finalizeMatchResultDomain(repo, matchResultId, finalizedByGamingMemberId, digest, reason);
}

export async function correctMatchResult(
  repo: PredictionsRepository,
  matchResultId: string,
  finalizedByGamingMemberId: string,
  reason: string
) {
  const digest = (await repo.getMatchResultContentDigest(matchResultId)) ?? "MISSING";
  return correctMatchResultDomain(repo, matchResultId, finalizedByGamingMemberId, digest, reason);
}
