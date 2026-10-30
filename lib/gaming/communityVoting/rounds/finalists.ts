import { createHash } from "node:crypto";

import { FINALIST_CUTOFF } from "./constants";
import type { PolicyKey } from "./types";

/**
 * The pilot's tally rules as pure functions: the TypeScript twin of community_voting_compute_round_results, the finalist cut, the
 * pending-policy requirement and the digests of 20261029100100. The database is the authority; the contract suite asserts both agree on
 * the same vectors, and the behavioral suite pins the rules themselves (ties at the cutoff, fewer than ten entries, shared winners,
 * withdrawn contestants, the cuts that need a Product decision).
 *
 * Votes are ONE per identity per round (the Voting store's own uniqueness), so a contestant's total is simply the number of vote rows
 * naming it. Nothing is weighted, nothing accumulates across rounds, and a withdrawn contestant has no rank and is in no total.
 */

export type { PolicyKey };

export interface RoundTally {
  ordinal: number;
  label: string;
  withdrawn: boolean;
  votes: number;
}

export interface TallyWithRank extends RoundTally {
  /** Standard competition rank among contestants who have NOT withdrawn (1, 1, 3 ...); null for a withdrawn contestant. */
  rank: number | null;
}

/** 1 + the number of contestants (not withdrawn) with strictly more votes. Equal votes share a rank and the next rank is skipped. */
export function competitionRanks(rows: readonly RoundTally[]): TallyWithRank[] {
  const active = rows.filter((r) => !r.withdrawn);
  return rows
    .map((r) => ({
      ...r,
      rank: r.withdrawn ? null : 1 + active.filter((o) => o.votes > r.votes).length,
    }))
    .sort((a, b) => a.ordinal - b.ordinal);
}

/**
 * The finalists: every contestant who has not withdrawn whose competition rank is at most the cutoff. Because the rule is "rank at most
 * the cutoff", every contestant tied with the last one advances (so there can be more than ten), and when there are ten or fewer
 * contestants all of them advance. The caller supplies no list and no discretion exists.
 */
export function selectFinalists(rows: readonly RoundTally[], cutoff: number = FINALIST_CUTOFF): TallyWithRank[] {
  return competitionRanks(rows).filter((r) => r.rank !== null && r.rank <= cutoff);
}

/**
 * The valid votes of a round: the votes for contestants who have not withdrawn. A vote for a contestant who withdrew stays on record as
 * evidence but counts for nothing here, exactly as it counts for nothing in the finalist cut.
 */
export function validVoteCount(rows: readonly RoundTally[]): number {
  return rows.filter((r) => !r.withdrawn).reduce((sum, r) => sum + r.votes, 0);
}

/**
 * The winners of the final: everyone at rank 1 among the contestants who have not withdrawn, PROVIDED that rank is held with at least one
 * valid vote. A tie is shared, never broken — but a tie of zeros is not a tie for first place, it is the absence of a result: a final with
 * no valid votes has no winners, and nobody is ever announced from it.
 */
export function selectWinners(rows: readonly RoundTally[]): TallyWithRank[] {
  return competitionRanks(rows).filter((r) => r.rank === 1 && r.votes > 0);
}

/**
 * Which Product decision, if any, the finalist cut cannot proceed without. Read conservatively: any path by which a contestant without a
 * single vote would advance needs the decision, so the cut is blocked rather than guessed.
 *   * nobody voted for an eligible contestant (a vote for a contestant who withdrew is no vote) -> ZERO_VALID_VOTES_PRELIMINARY
 *   * a would-be finalist has no votes (a small field, or a tie of zeros at the cutoff)           -> ZERO_VOTE_ENTRIES_AT_CUTOFF
 */
export function cutPolicyRequirement(rows: readonly RoundTally[], cutoff: number = FINALIST_CUTOFF): PolicyKey | null {
  const active = rows.filter((r) => !r.withdrawn);
  if (active.length === 0) return null;
  if (validVoteCount(rows) === 0) return "ZERO_VALID_VOTES_PRELIMINARY";
  if (selectFinalists(rows, cutoff).some((r) => r.votes === 0)) return "ZERO_VOTE_ENTRIES_AT_CUTOFF";
  return null;
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** sha256('cvrnd1|<role>|<valid votes>|' || <ordinal>:<votes>:<rank> per contestant who has not withdrawn, by ordinal, ';'-joined). */
export function roundResultsDigest(role: "PRELIMINARY" | "FINAL", validVotes: number, rows: readonly RoundTally[]): string {
  const body = competitionRanks(rows)
    .filter((r) => !r.withdrawn)
    .map((r) => `${r.ordinal}:${r.votes}:${r.rank}`)
    .join(";");
  return sha256(`cvrnd1|${role}|${validVotes}|${body}`);
}

/** sha256('cvfin1|<cutoff>|' || <ordinal>:<rank>:<votes> per finalist, by ordinal, ';'-joined). */
export function finalistSelectionDigest(rows: readonly RoundTally[], cutoff: number = FINALIST_CUTOFF): string {
  const body = selectFinalists(rows, cutoff)
    .map((r) => `${r.ordinal}:${r.rank}:${r.votes}`)
    .join(";");
  return sha256(`cvfin1|${cutoff}|${body}`);
}

/**
 * What the operator reviews and what a publication must match. It commits to the closed result, to the finalist cut (preliminary), to
 * WHO HAS WITHDRAWN and to the Product decisions in force, so any change to who is eligible, or to a decision, makes an earlier review stale:
 *   sha256('cvrev2|' || round digest || '|' || selection digest or '' || '|' || withdrawn ordinals ',' || '|' || key=value ';')
 */
export function reviewDigest(
  roundDigest: string,
  selectionDigest: string | null,
  withdrawnOrdinals: readonly number[],
  policies: ReadonlyArray<{ key: string; value: string }>
): string {
  const withdrawn = [...withdrawnOrdinals].sort((a, b) => a - b).join(",");
  const decided = [...policies]
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((p) => `${p.key}=${p.value}`)
    .join(";");
  return sha256(`cvrev2|${roundDigest}|${selectionDigest ?? ""}|${withdrawn}|${decided}`);
}
