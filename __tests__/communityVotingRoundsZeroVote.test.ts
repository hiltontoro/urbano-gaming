import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { communityVotingErrorBody, statusForCommunityVotingError } from "../lib/gaming/communityVoting/httpSupport";
import { CommunityVotingError } from "../lib/gaming/communityVoting/types";
import { roundResultsDigest, selectWinners, validVoteCount, type RoundTally } from "../lib/gaming/communityVoting/rounds/finalists";

/**
 * UG-IV-GATE-006 — the pure side of "a final with no valid votes has no result". WRITTEN BEFORE the correction (see the implementation record
 * for what failed first). The database twin of every rule here is in communityVotingRoundsZeroVote.contract.test.ts.
 */

const tally = (votes: number[], withdrawn: number[] = []): RoundTally[] => votes.map((v, i) => ({ ordinal: i + 1, label: `#${1000 + i}`, withdrawn: withdrawn.includes(i), votes: v }));

describe("valid votes: a vote for a contestant who has not withdrawn", () => {
  it("counts only the votes of contestants who have not withdrawn", () => {
    expect(validVoteCount(tally([3, 2, 1]))).toBe(6);
    expect(validVoteCount(tally([3, 2, 1], [0]))).toBe(3);
    expect(validVoteCount(tally([3, 2, 1], [0, 1, 2]))).toBe(0);
    expect(validVoteCount(tally([0, 0, 0]))).toBe(0);
    expect(validVoteCount([])).toBe(0);
  });
});

describe("shared winners need a positive highest count", () => {
  it("nobody wins a final with no valid votes — not all of the contestants at rank 1", () => {
    expect(selectWinners(tally([0, 0, 0]))).toEqual([]);
    expect(selectWinners(tally([3, 2, 1], [0, 1, 2]))).toEqual([]);
    expect(selectWinners(tally([5, 0, 0], [0]))).toEqual([]); // the only votes were for a contestant who withdrew
    expect(selectWinners([])).toEqual([]);
  });

  it("a tie at a positive count is shared, and only among those who tie", () => {
    expect(selectWinners(tally([1, 1, 0])).map((r) => r.ordinal)).toEqual([1, 2]);
    expect(selectWinners(tally([2, 2, 2])).map((r) => r.ordinal)).toEqual([1, 2, 3]);
    expect(selectWinners(tally([0, 4, 4])).map((r) => r.ordinal)).toEqual([2, 3]);
  });

  it("a single vote is a result", () => {
    expect(selectWinners(tally([0, 1, 0])).map((r) => r.ordinal)).toEqual([2]);
  });

  it("a withdrawn contestant never wins, and the highest VALID count decides", () => {
    expect(selectWinners(tally([9, 2, 1], [0])).map((r) => r.ordinal)).toEqual([2]);
  });

  it("the digest of the round still commits to the zero-vote result (the evidence is the same whether or not anyone may announce it)", () => {
    expect(roundResultsDigest("FINAL", 0, tally([0, 0, 0]))).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("the refusal is a stable, explicit, typed error", () => {
  it("maps NO_VALID_RESULT to a conflict (409) with its own stable code and a fixed message that claims no award", () => {
    const err = new CommunityVotingError("NO_VALID_RESULT");
    expect(statusForCommunityVotingError(err)).toEqual({ status: 409, code: "NO_VALID_RESULT" });
    const body = communityVotingErrorBody(new CommunityVotingError("NO_VALID_RESULT", "The final has no valid votes, so there is no result to publish."));
    expect(body.code).toBe("NO_VALID_RESULT");
    expect(body.error).not.toMatch(/winner(s)? (is|are)|ganador(es)? (es|son)|awarded|congrat/i);
  });
});

describe("the operator is told plainly what happened and what the system does NOT do", () => {
  const source = readFileSync(path.join(process.cwd(), "public/communityVotingRoundOperator.js"), "utf8");
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const O = new Function(`${source}\nreturn CommunityVotingRoundOperator;`)() as {
    describeError(code: string): string;
    nextSteps(overview: Record<string, unknown>): Array<{ key: string; enabled: boolean; done: boolean; reason: string | null }>;
    NO_VALID_RESULT_NOTICE: string;
  };

  const closedFinal = (over: Record<string, unknown> = {}) => ({
    roundRole: "FINAL", opened: true, closed: true, published: false, finalistsSelected: false, windowSeconds: 300, deadlineAt: null, serverNow: "2026-11-01T03:40:00.000Z",
    schedule: null, pendingResolutions: [], review: null, policies: [], tasks: [], publishedAffected: [], noValidResult: true,
    entries: [{ entryId: "e1", label: "#1111", association: "CONFIRMED", media: "APPROVED", withdrawn: false, carried: true }, { entryId: "e2", label: "#2222", association: "CONFIRMED", media: "APPROVED", withdrawn: false, carried: true }],
    counters: { boundVoters: 0, votes: 0, entries: 2, withdrawn: 0 },
    ...over,
  });
  const stepOf = (steps: ReturnType<typeof O.nextSteps>, key: string) => steps.find((s) => s.key === key)!;

  it("explains that the final has no valid votes, that votes and evidence are kept, and that it needs an explicit resolution", () => {
    const text = O.describeError("NO_VALID_RESULT");
    expect(text).toMatch(/ningún voto válido/);
    expect(text).toMatch(/resolución explícita/);
    expect(text).toMatch(/se conservan/);
    expect(O.NO_VALID_RESULT_NOTICE).toMatch(/ningún voto válido/);
    expect(O.NO_VALID_RESULT_NOTICE).toMatch(/resolución explícita/);
  });

  it("does not invent a way out: it names no cancellation, reopening, extension or manual choice as something the system offers", () => {
    for (const text of [O.describeError("NO_VALID_RESULT"), O.NO_VALID_RESULT_NOTICE]) {
      expect(text).toMatch(/no (ofrece|cancela|reabre|extiende|elige)/i);
      expect(text).not.toMatch(/puedes (cancelar|reabrir|extender|elegir)|usa (el botón|la opción)/i);
    }
  });

  it("offers neither the review nor the publication of a final with no valid result, and says why", () => {
    const steps = O.nextSteps(closedFinal());
    expect(stepOf(steps, "PUBLISH")).toMatchObject({ enabled: false, done: false, reason: expect.stringMatching(/ningún voto válido/) });
    expect(stepOf(steps, "REVIEW")).toMatchObject({ enabled: false, reason: expect.stringMatching(/ningún voto válido/) });
  });

  it("is unchanged for a final that has a result", () => {
    // GATE-014: a review the server holds for the current results is shown as DONE (and nothing is left to do there); before any review the step is open
    const steps = O.nextSteps(closedFinal({ noValidResult: false, review: { reviewedAt: "x", digest: "d", current: true } }));
    expect(stepOf(steps, "REVIEW")).toMatchObject({ done: true, enabled: false });
    expect(stepOf(steps, "PUBLISH")).toMatchObject({ enabled: true, reason: null });
    expect(stepOf(O.nextSteps(closedFinal({ noValidResult: false, review: null })), "REVIEW")).toMatchObject({ done: false, enabled: true });
  });
});
