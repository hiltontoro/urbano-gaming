import type { PredictionsRepository } from "./db/predictionsRepository";
import type { MatchRecord, MatchResultRecord, OfficialGoalEventRecord } from "./types";
import { MatchNotFoundError } from "./types";
import { computeMatchResultContentDigest, saveBaseToken } from "./resultIntegrity";

export type ResultView = MatchResultRecord & {
  goalEvents: OfficialGoalEventRecord[];
  /** Digest of exactly the score and goal events carried in this view. */
  contentDigest: string;
};

export class ResultChangedWhileLoadingError extends Error {
  constructor() {
    super("The result changed while it was loading. Try again.");
    this.name = "ResultChangedWhileLoadingError";
  }
}

const MAX_ATTEMPTS = 3;

/** One result read together with its events, or null when the two reads disagree. */
async function readVerifiedView(
  repo: PredictionsRepository,
  match: MatchRecord,
  record: MatchResultRecord
): Promise<ResultView | null> {
  const goalEvents = await repo.listGoalEventsForResult(record.matchResultId);
  const storedDigest = await repo.getMatchResultContentDigest(record.matchResultId);
  const shownDigest = computeMatchResultContentDigest({
    matchResultId: record.matchResultId,
    matchId: record.matchId,
    homeTeamId: match.homeTeamId,
    awayTeamId: match.awayTeamId,
    homeScore: record.homeScore,
    awayScore: record.awayScore,
    supersedesMatchResultId: record.supersedesMatchResultId,
    events: goalEvents,
  });
  if (storedDigest !== shownDigest) return null;
  return { ...record, goalEvents, contentDigest: shownDigest };
}

/**
 * The authoritative admin view of a Match's draft and current finalized
 * result. Reading a result is several queries, so a save landing in the
 * middle could pair one version's score with another version's digest —
 * and a finalizer would then approve content they never saw. Each view
 * is therefore verified: the digest the database computes must equal the
 * digest recomputed from the very rows carried in the view, and the read
 * is repeated if they differ. The digest a client is given always
 * describes exactly the content shown beside it.
 */
export async function readResultView(
  repo: PredictionsRepository,
  matchId: string
): Promise<{ draft: ResultView | null; currentFinalized: ResultView | null; saveBase: string }> {
  const match = await repo.getMatchById(matchId);
  if (!match) throw new MatchNotFoundError();

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const draftRecord = await repo.getDraftMatchResult(matchId);
    const finalizedRecord = await repo.getCurrentFinalizedMatchResult(matchId);

    const draft = draftRecord ? await readVerifiedView(repo, match, draftRecord) : null;
    const currentFinalized = finalizedRecord ? await readVerifiedView(repo, match, finalizedRecord) : null;

    if ((draftRecord === null || draft !== null) && (finalizedRecord === null || currentFinalized !== null)) {
      // The token a save must send back: it names the state shown here.
      return {
        draft,
        currentFinalized,
        saveBase: saveBaseToken({
          draftDigest: draft?.contentDigest ?? null,
          finalizedDigest: currentFinalized?.contentDigest ?? null,
        }),
      };
    }
  }

  throw new ResultChangedWhileLoadingError();
}
