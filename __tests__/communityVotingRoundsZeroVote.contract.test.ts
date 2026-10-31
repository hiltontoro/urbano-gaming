import { afterAll, describe, expect, it, vi } from "vitest";

import {
  INSIDE,
  approve,
  candidates,
  castMany,
  closedPreliminary,
  contestants,
  expectCode,
  expectDbError,
  newRound,
  openRound,
  POLICY_VALUES,
  pool,
  q,
  rawClient,
  repo,
  sessionRepo,
  supabaseUrl,
  votesIn,
  type Round,
} from "./helpers/roundsFixtures";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";

// The target is refused unless it is loopback. The shared fixtures apply the same guard as soon as they load; this explicit call is what the
// contract-registry inventory (requireLocalSupabase.test.ts) requires of every registered contract file, so no file relies on another to be safe.
requireLocalSupabase(supabaseUrl);

/**
 * UG-IV-GATE-006 — a FINAL WITH NO VALID VOTES HAS NO RESULT. Against REAL local Postgres (isolated loopback stack).
 *
 * THESE TESTS WERE WRITTEN BEFORE THE CORRECTION THEY COVER and run first against the candidate as reviewed (its failures are recorded
 * in the implementation record and in the durable evidence folder). The rule: shared winners exist only when the highest VALID vote count is
 * greater than zero. A valid vote is a vote for a contestant who has not withdrawn — the same definition the finalist cut uses; a vote
 * for a contestant who withdrew stays in the Voting store as evidence but is not valid. When a final has none, publication is refused with
 * a stable code (NO_VALID_RESULT), nothing is announced and nothing is written; no cancellation, reopening, extension or manual choice of a
 * winner exists in the system.
 */

afterAll(async () => {
  await pool.end();
});
vi.setConfig({ testTimeout: 180_000 });

/** A preliminary with three finalists, and a final of those three that has been opened (nobody has voted yet). */
async function openedFinal() {
  const { p } = await closedPreliminary([3, 2, 1]);
  await repo.selectFinalists(p.ctx);
  const f = await newRound("FINAL", { source: p, operator: p.operator });
  await repo.prepareFinal(f.ctx);
  await openRound(f);
  const fc = await candidates(f);
  expect(fc).toHaveLength(3);
  return { p, f, fc };
}

const withdraw = (r: Round, entryId: string) => repo.withdrawRoundCandidature({ ...r.ctx, entryId, reason: "Retiro", hidePhoto: false });
const count = async (sql: string, params: unknown[]) => Number((await q<{ n: string }>(sql, params))[0].n);

/** Everything a publication would leave behind, and everything a refusal must preserve. */
async function snapshot(f: Round) {
  const [{ state }] = await q<{ state: string }>("select state from interaction_instances where interaction_instance_id = $1", [f.started?.interactionInstanceId]);
  return {
    interactionState: state,
    publications: await count("select count(*) n from community_voting_publications where instance_id = $1", [f.ctx.instanceId]),
    announced: await count("select count(*) n from community_voting_published_results where instance_id = $1", [f.ctx.instanceId]),
    revealEvents: await count("select count(*) n from session_events where session_id = $1 and event_type = 'RESULTS_REVEALED'", [f.session.sessionId]),
    closures: await count("select count(*) n from community_voting_closures where instance_id = $1", [f.ctx.instanceId]),
    votes: await votesIn(f),
    publicResults: await repo.readRoundPublicResults(f.ctx.instanceId),
    published: (await repo.readRoundPublicInfo(f.ctx.instanceId))?.published,
  };
}
const NOTHING_PUBLISHED = { interactionState: "SUBMISSIONS_CLOSED", publications: 0, announced: 0, revealEvents: 0, closures: 1, publicResults: [], published: false };

// =====================================================================================================================
// 1. Zero submissions
// =====================================================================================================================

describe("a final nobody voted in has no result", () => {
  it("refuses to publish with a stable code, announces nobody, writes nothing and keeps the round's evidence", async () => {
    const { f } = await openedFinal();
    const closure = await repo.closeRound(f.ctx);
    expect(closure.validVoteCount).toBe(0);
    await repo.recordRoundReview(f.ctx); // a review is evidence that the operator looked; it cannot create a result

    await expectCode(repo.publishRound(f.ctx), "NO_VALID_RESULT");
    expect(await snapshot(f)).toEqual({ ...NOTHING_PUBLISHED, votes: 0 });
    expect((await repo.readRoundEvidence(f.ctx)).closed).toBe(true);
    expect((await repo.readRoundEvidence(f.ctx)).publication).toBeNull();
  });

  it("does not call anyone a winner: every contestant is at rank 1 with zero votes, and the operator's view says so", async () => {
    const { f } = await openedFinal();
    await repo.closeRound(f.ctx);
    const rows = await repo.readRoundResults(f.ctx);
    expect(rows.map((r) => [r.votes, r.competitionRank])).toEqual([[0, 1], [0, 1], [0, 1]]);
    expect(rows.filter((r) => r.winner)).toEqual([]);
    const overview = await repo.readRoundOverview(f.ctx);
    expect(overview.noValidResult).toBe(true);
    expect(overview.published).toBe(false);
  });

  it("states the definition in the database: no valid vote counted, and the final flagged as having no result", async () => {
    const { f } = await openedFinal();
    await repo.closeRound(f.ctx);
    const [row] = await q<{ n: string; none: boolean }>("select community_voting_valid_vote_count($1)::text n, community_voting_has_no_valid_result($1) none", [f.ctx.instanceId]);
    expect(row).toEqual({ n: "0", none: true });
  });
});

// =====================================================================================================================
// 2. Votes exist, but none of them is valid any more
// =====================================================================================================================

describe("a final whose votes are all for contestants who withdrew has no result", () => {
  it("counts a vote for a contestant who withdrew as no valid vote: publication is refused and every vote is kept", async () => {
    const { f, fc } = await openedFinal();
    await castMany(f, fc[0].candidateId, 3, INSIDE);
    await repo.closeRound(f.ctx);
    await repo.recordRoundReview(f.ctx);
    await withdraw(f, fc[0].entryId);

    const [row] = await q<{ n: string; none: boolean }>("select community_voting_valid_vote_count($1)::text n, community_voting_has_no_valid_result($1) none", [f.ctx.instanceId]);
    expect(row).toEqual({ n: "0", none: true });
    expect(await count("select count(*) n from votes where candidate_id = $1", [fc[0].candidateId])).toBe(3); // evidence preserved
    const rows = await repo.readRoundResults(f.ctx);
    expect(rows.find((r) => r.candidateId === fc[0].candidateId)).toMatchObject({ withdrawn: true, votes: 3, competitionRank: null, winner: false });
    expect(rows.filter((r) => r.winner)).toEqual([]);

    await expectCode(repo.publishRound(f.ctx), "NO_VALID_RESULT");
    expect(await snapshot(f)).toEqual({ ...NOTHING_PUBLISHED, votes: 3 });
    expect((await repo.readRoundOverview(f.ctx)).noValidResult).toBe(true);
  });

  it("is refused the same way once the Product decision about the withdrawn finalist is recorded: a decision about a withdrawal cannot create a result", async () => {
    const { p, f, fc } = await openedFinal();
    await castMany(f, fc[1].candidateId, 2, INSIDE);
    await repo.closeRound(f.ctx);
    await withdraw(f, fc[1].entryId);
    await approve(p, "FINALIST_WITHDRAWAL_AFTER_SELECTION", POLICY_VALUES.FINALIST_WITHDRAWAL_AFTER_SELECTION);
    await repo.recordRoundReview(f.ctx);
    await expectCode(repo.publishRound(f.ctx), "NO_VALID_RESULT");
    expect(await snapshot(f)).toEqual({ ...NOTHING_PUBLISHED, votes: 2 });
  });

  it("a valid vote elsewhere is enough: only the contestants who withdrew are excluded, and the remaining top count is the winner", async () => {
    const { p, f, fc } = await openedFinal();
    await castMany(f, fc[0].candidateId, 3, INSIDE);
    await castMany(f, fc[1].candidateId, 1, INSIDE);
    await repo.closeRound(f.ctx);
    await withdraw(f, fc[0].entryId);
    await approve(p, "FINALIST_WITHDRAWAL_AFTER_SELECTION", POLICY_VALUES.FINALIST_WITHDRAWAL_AFTER_SELECTION);
    await repo.recordRoundReview(f.ctx);
    await repo.publishRound(f.ctx);
    expect((await repo.readRoundPublicResults(f.ctx.instanceId)).map((w) => w.alias)).toEqual([fc[1].label]);
  });
});

// =====================================================================================================================
// 3. Shared winners are for a positive count only
// =====================================================================================================================

describe("shared winners need a positive highest count", () => {
  it("a tie at a positive count still publishes shared winners — and only those who tie, not the contestant with none", async () => {
    const { f, fc } = await openedFinal();
    await castMany(f, fc[0].candidateId, 1, INSIDE);
    await castMany(f, fc[1].candidateId, 1, INSIDE);
    await repo.closeRound(f.ctx);
    const rows = await repo.readRoundResults(f.ctx);
    expect(rows.filter((r) => r.winner).map((r) => r.candidateId).sort()).toEqual([fc[0].candidateId, fc[1].candidateId].sort());
    expect((await repo.readRoundOverview(f.ctx)).noValidResult).toBe(false);
    await repo.recordRoundReview(f.ctx);
    await repo.publishRound(f.ctx);
    const winners = await repo.readRoundPublicResults(f.ctx.instanceId);
    expect(winners.map((w) => w.kind)).toEqual(["WINNERS", "WINNERS"]);
    expect(winners.map((w) => w.alias).sort()).toEqual([fc[0].label, fc[1].label].sort());
  });

  it("a single vote is a result: one winner", async () => {
    const { f, fc } = await openedFinal();
    await castMany(f, fc[2].candidateId, 1, INSIDE);
    await repo.closeRound(f.ctx);
    await repo.recordRoundReview(f.ctx);
    await repo.publishRound(f.ctx);
    expect((await repo.readRoundPublicResults(f.ctx.instanceId)).map((w) => w.alias)).toEqual([fc[2].label]);
  });

  it("the preliminary is not affected: with the cut's own Product decision recorded it still publishes its finalists", async () => {
    const { p } = await closedPreliminary([0, 0, 0]);
    await approve(p, "ZERO_VALID_VOTES_PRELIMINARY", POLICY_VALUES.ZERO_VALID_VOTES_PRELIMINARY);
    await repo.selectFinalists(p.ctx);
    await repo.recordRoundReview(p.ctx);
    await repo.publishRound(p.ctx);
    expect((await repo.readRoundPublicResults(p.ctx.instanceId)).map((x) => x.kind)).toEqual(["FINALISTS", "FINALISTS", "FINALISTS"]);
  });
});

// =====================================================================================================================
// 4. A stale review cannot be used around the guard
// =====================================================================================================================

describe("the guard does not depend on the review", () => {
  it("a review taken while the result was valid, made stale by withdrawals that leave no valid vote, is refused with the guard's code — not a path around it", async () => {
    const { f, fc } = await openedFinal();
    await castMany(f, fc[0].candidateId, 2, INSIDE);
    await castMany(f, fc[1].candidateId, 1, INSIDE);
    await repo.closeRound(f.ctx);
    const stale = await repo.recordRoundReview(f.ctx); // valid and current at this moment
    await withdraw(f, fc[0].entryId);
    await withdraw(f, fc[1].entryId);
    await withdraw(f, fc[2].entryId);

    await expectCode(repo.publishRound(f.ctx), "NO_VALID_RESULT");
    const fresh = await repo.recordRoundReview(f.ctx); // re-reviewing the empty result does not make it publishable
    expect(fresh.resultsDigest).not.toBe(stale.resultsDigest);
    await expectCode(repo.publishRound(f.ctx), "NO_VALID_RESULT");
    expect(await snapshot(f)).toEqual({ ...NOTHING_PUBLISHED, votes: 3 });
  });

  it("a final that was never reviewed is also refused with the guard's code first: the operator is told there is no result, not that a review is missing", async () => {
    const { f } = await openedFinal();
    await repo.closeRound(f.ctx);
    await expectCode(repo.publishRound(f.ctx), "NO_VALID_RESULT");
  });

  it("the guard does not hide the other refusals of a final that is NOT closed", async () => {
    const { f } = await openedFinal();
    await expectCode(repo.publishRound(f.ctx), "RESULTS_NOT_AVAILABLE");
  });

  // Added after the mutation check Z09 survived: a final that is still being voted has no result YET, which is not the same as having none.
  it("a final that is still open is never reported as having no valid result: the flag only exists once the round has closed", async () => {
    const { f } = await openedFinal();
    expect((await q<{ n: boolean }>("select community_voting_has_no_valid_result($1) as n", [f.ctx.instanceId]))[0].n).toBe(false);
    expect((await repo.readRoundOverview(f.ctx)).noValidResult).toBe(false);
    await repo.closeRound(f.ctx);
    expect((await q<{ n: boolean }>("select community_voting_has_no_valid_result($1) as n", [f.ctx.instanceId]))[0].n).toBe(true);
    expect((await repo.readRoundOverview(f.ctx)).noValidResult).toBe(true);
  });
});

// =====================================================================================================================
// 5. It cannot be bypassed through another supported route or function
// =====================================================================================================================

describe("no other path publishes a final that has no valid result", () => {
  async function closedEmptyFinal() {
    const { f } = await openedFinal();
    await repo.closeRound(f.ctx);
    const review = await repo.recordRoundReview(f.ctx);
    return { f, review };
  }

  it("the Session's own reveal is refused outside the round's publication", async () => {
    const { f } = await closedEmptyFinal();
    await expectDbError("select * from reveal_results_atomically($1, $2, 'RESULTS_REVEALED', '{}'::jsonb)", [f.session.sessionId, f.session.hostToken], "ROUND_PATH_REQUIRED");
    expect((await snapshot(f)).interactionState).toBe("SUBMISSIONS_CLOSED");
  });

  it("not even a writer holding the publication marker can record a publication for it: the table refuses", async () => {
    const { f, review } = await closedEmptyFinal();
    const c = await rawClient();
    try {
      await c.query("begin");
      await c.query("select set_config('urbano.community_voting_round_publish', $1, true)", [f.session.sessionId]);
      await c.query("select * from reveal_results_atomically($1, $2, 'RESULTS_REVEALED', '{}'::jsonb)", [f.session.sessionId, f.session.hostToken]);
      const outcome = await c
        .query(
          "insert into community_voting_publications (instance_id, review_id, results_digest, published_by_member_id) values ($1, $2, $3, $4)",
          [f.ctx.instanceId, review.reviewId, review.resultsDigest, f.operator.gamingMemberId]
        )
        .then(() => "INSERTED", (e: Error) => e.message);
      expect(outcome).toMatch(/NO_VALID_RESULT/);
    } finally {
      await c.query("rollback").catch(() => undefined);
      await c.end();
    }
    expect(await snapshot(f)).toEqual({ ...NOTHING_PUBLISHED, votes: 0 });
  });

  it("and the announced-result table refuses winners for it as a second, independent layer", async () => {
    const { f, review } = await closedEmptyFinal();
    const [entry] = await q<{ entry_id: string; label: string }>("select entry_id, label from community_voting_entries where instance_id = $1 order by ordinal limit 1", [f.ctx.instanceId]);
    const c = await rawClient();
    try {
      await c.query("begin");
      // as the table owner, with the publication guard out of the way: the snapshot table must still refuse
      await c.query("alter table community_voting_publications disable trigger community_voting_publications_guard");
      await c.query("select set_config('urbano.community_voting_round_publish', $1, true)", [f.session.sessionId]);
      await c.query("select * from reveal_results_atomically($1, $2, 'RESULTS_REVEALED', '{}'::jsonb)", [f.session.sessionId, f.session.hostToken]);
      await c.query("insert into community_voting_publications (instance_id, review_id, results_digest, published_by_member_id) values ($1, $2, $3, $4)", [f.ctx.instanceId, review.reviewId, review.resultsDigest, f.operator.gamingMemberId]);
      const outcome = await c
        .query("insert into community_voting_published_results (instance_id, entry_id, kind, alias, ordinal) values ($1, $2, 'WINNERS', $3, 1)", [f.ctx.instanceId, entry.entry_id, entry.label])
        .then(() => "INSERTED", (e: Error) => e.message);
      expect(outcome).toMatch(/NO_VALID_RESULT/);
    } finally {
      await c.query("rollback").catch(() => undefined);
      await c.end();
    }
    expect(await snapshot(f)).toEqual({ ...NOTHING_PUBLISHED, votes: 0 });
  });

  it("the publication function itself — the only supported writer — refuses when called directly at the database", async () => {
    const { f } = await closedEmptyFinal();
    await expectDbError("select * from publish_community_voting_round_atomically($1, $2, $3)", [f.ctx.instanceId, f.ctx.hostToken, f.ctx.operatorMemberId], "CV_NO_VALID_RESULT");
    expect(await snapshot(f)).toEqual({ ...NOTHING_PUBLISHED, votes: 0 });
  });

  it("the refusal is repeatable and leaves the final exactly as it was: nothing partial, nothing consumed", async () => {
    const { f } = await closedEmptyFinal();
    const before = await snapshot(f);
    for (let i = 0; i < 3; i++) await expectCode(repo.publishRound(f.ctx), "NO_VALID_RESULT");
    expect(await snapshot(f)).toEqual(before);
    const actions = (await repo.readRoundEvidence(f.ctx)).operatorActions.map((a) => a.action);
    expect(actions).not.toContain("PUBLISH_RESULTS");
  });
});

void sessionRepo;
void contestants;
