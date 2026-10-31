import { afterAll, describe, expect, it, vi } from "vitest";

import { GALLERY_CONSENT_TEXT, PROMO_CONSENT_TEXT } from "../lib/gaming/communityVoting/rounds/constants";
import {
  INSIDE,
  approve,
  approvedEntry,
  bind,
  candidates,
  castInput,
  castMany,
  closedPreliminary,
  contestant,
  contestants,
  expectCode,
  expectDbError,
  inMs,
  lockRound,
  newPerson,
  newRound,
  openRound,
  photoArgs,
  POLICY_VALUES,
  pool,
  q,
  rawClient,
  repo,
  sleep,
  supabaseUrl,
  voteAs,
  votesIn,
} from "./helpers/roundsFixtures";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";

// The target is refused unless it is loopback. The shared fixtures apply the same guard as soon as they load; this explicit call is what the
// contract-registry inventory (requireLocalSupabase.test.ts) requires of every registered contract file, so no file relies on another to be safe.
requireLocalSupabase(supabaseUrl);

/**
 * UG-IV-GATE-005 / 005A — the corrections, against REAL local Postgres (isolated loopback stack).
 *
 * THESE TESTS WERE WRITTEN BEFORE THE CORRECTIONS THEY COVER and run first against the uncorrected candidate (their failures are recorded
 * in the implementation record). They state the corrected contract: one supported two-round path with no superseded runtime installed;
 * unresolved Product policies that fail closed; a binding schedule; photo visibility, candidature withdrawal, vote evidence, finalist
 * selection, reviewed result and published result as six separate things.
 */

afterAll(async () => {
  await pool.end();
});
vi.setConfig({ testTimeout: 180_000 });

// =====================================================================================================================
// 1. One supported path: the superseded Ranked runtime is not installed
// =====================================================================================================================

describe("the superseded runtime is not installed", () => {
  it("has no five-option ballot tables and no telephone-possession columns", async () => {
    const tables = await q<{ relname: string }>("select relname from pg_class where relkind = 'r' and relname in ('community_voting_ballots', 'community_voting_ballot_picks', 'community_voting_ballot_attempts')");
    expect(tables).toEqual([]);
    const cols = await q<{ column_name: string }>("select column_name from information_schema.columns where table_name = 'community_voting_voter_bindings' and column_name like 'phone%'");
    expect(cols).toEqual([]);
  });

  it("has no function of the ranked ballot, the telephone steps or a retention purge", async () => {
    const fns = await q<{ proname: string }>("select proname from pg_proc where pronamespace = 'public'::regnamespace and (proname ~ 'ranked|phone|ballot|purge') and proname ~ 'community_voting|ranked_phone|submit_'");
    expect(fns.map((f) => f.proname)).toEqual([]);
  });

  it("cannot hold a RANKED_TOP_5 Instance: the only modes are the GATE-003 foundation's and the pilot's", async () => {
    const [def] = await q<{ def: string }>("select pg_get_constraintdef(oid) def from pg_constraint where conname = 'community_voting_instances_ballot_mode_values'");
    expect(def.def).toContain("FAVORITE_ROUND");
    expect(def.def).toContain("SINGLE_CHOICE");
    expect(def.def).not.toContain("RANKED_TOP_5");
  });

  it("keeps no retention clock: a closure has no removal instant and a photograph has no expiry reason", async () => {
    const cols = await q<{ column_name: string }>("select column_name from information_schema.columns where table_name = 'community_voting_closures'");
    expect(cols.map((c) => c.column_name)).not.toContain("removal_due_at");
    const defs = await q<{ def: string }>("select pg_get_constraintdef(oid) def from pg_constraint where conrelid = 'community_voting_entry_photos'::regclass");
    expect(defs.map((d) => d.def).join(" ")).not.toContain("RETENTION_EXPIRED");
  });

  it("states no retention period in what a contestant is asked to accept", () => {
    expect(GALLERY_CONSENT_TEXT).not.toMatch(/72|horas/i);
    expect(PROMO_CONSENT_TEXT).not.toMatch(/72|horas/i);
  });
});

// =====================================================================================================================
// 2. Unresolved Product policies fail closed
// =====================================================================================================================

describe("policy approvals", () => {
  it("record only a supported value, with the reference of the decision, once, append-only — and name the key that is missing", async () => {
    const r = await newRound("PRELIMINARY");
    await expectCode(repo.recordPolicyApproval({ ...r.ctx, policyKey: "NOT_A_POLICY" as never, policyValue: "X", approvalReference: "DEC-1" }), "INVALID_REQUEST");
    await expectCode(repo.recordPolicyApproval({ ...r.ctx, policyKey: "ZERO_VALID_VOTES_PRELIMINARY", policyValue: "SOMETHING_ELSE", approvalReference: "DEC-1" }), "INVALID_REQUEST");
    await expectCode(repo.recordPolicyApproval({ ...r.ctx, policyKey: "ZERO_VALID_VOTES_PRELIMINARY", policyValue: POLICY_VALUES.ZERO_VALID_VOTES_PRELIMINARY, approvalReference: "  " }), "INVALID_REQUEST");
    const ok = await repo.recordPolicyApproval({ ...r.ctx, policyKey: "ZERO_VALID_VOTES_PRELIMINARY", policyValue: POLICY_VALUES.ZERO_VALID_VOTES_PRELIMINARY, approvalReference: "DECISION-2026-10-30-A" });
    expect(ok.policyKey).toBe("ZERO_VALID_VOTES_PRELIMINARY");
    await expectCode(repo.recordPolicyApproval({ ...r.ctx, policyKey: "ZERO_VALID_VOTES_PRELIMINARY", policyValue: POLICY_VALUES.ZERO_VALID_VOTES_PRELIMINARY, approvalReference: "DECISION-2026-10-30-B" }), "POLICY_ALREADY_RECORDED");
    await expectDbError("update community_voting_policy_approvals set policy_value = 'X' where instance_id = $1", [r.ctx.instanceId], "cannot be changed");
    await expectDbError("delete from community_voting_policy_approvals where instance_id = $1", [r.ctx.instanceId], "cannot be deleted");
    const overview = await repo.readRoundOverview(r.ctx);
    expect(overview.policies.find((p) => p.key === "ZERO_VALID_VOTES_PRELIMINARY")).toMatchObject({ approved: true, value: "ALL_ENTRIES_ADVANCE", approvalReference: "DECISION-2026-10-30-A" });
    expect(overview.policies.filter((p) => !p.approved).map((p) => p.key).sort()).toEqual(["FINALIST_WITHDRAWAL_AFTER_SELECTION", "ZERO_VOTE_ENTRIES_AT_CUTOFF"]);
  });

  it("only the designated operator can record one", async () => {
    const r = await newRound("PRELIMINARY");
    const stranger = await newPerson();
    await expectCode(repo.recordPolicyApproval({ ...r.ctx, operatorMemberId: stranger.gamingMemberId as string, policyKey: "ZERO_VALID_VOTES_PRELIMINARY", policyValue: "ALL_ENTRIES_ADVANCE", approvalReference: "DEC-1" }), "OPERATOR_REQUIRED");
  });
});

describe("zero votes at the cut do not advance anyone until the policy is approved", () => {
  it("BLOCKS the cut when nobody voted — no selection is written, nobody advances — and advances everyone only once that policy is approved", async () => {
    const { p } = await closedPreliminary([0, 0, 0]);
    await expect(repo.selectFinalists(p.ctx)).rejects.toMatchObject({ code: "POLICY_REQUIRED", message: expect.stringContaining("ZERO_VALID_VOTES_PRELIMINARY") });
    expect(await q("select 1 from community_voting_finalist_selections where preliminary_instance_id = $1", [p.ctx.instanceId])).toHaveLength(0);
    expect(await q("select 1 from community_voting_finalists where preliminary_instance_id = $1", [p.ctx.instanceId])).toHaveLength(0);
    await approve(p, "ZERO_VALID_VOTES_PRELIMINARY", POLICY_VALUES.ZERO_VALID_VOTES_PRELIMINARY);
    expect((await repo.selectFinalists(p.ctx)).finalistCount).toBe(3);
  });

  it("BLOCKS the cut when a zero-vote entry would advance, and names the other policy; contestants with votes advance without any policy", async () => {
    const blocked = await closedPreliminary([3, 2, 0]);
    await expect(repo.selectFinalists(blocked.p.ctx)).rejects.toMatchObject({ code: "POLICY_REQUIRED", message: expect.stringContaining("ZERO_VOTE_ENTRIES_AT_CUTOFF") });
    // approving the OTHER policy does not unblock it
    await approve(blocked.p, "ZERO_VALID_VOTES_PRELIMINARY", POLICY_VALUES.ZERO_VALID_VOTES_PRELIMINARY);
    await expect(repo.selectFinalists(blocked.p.ctx)).rejects.toMatchObject({ code: "POLICY_REQUIRED" });
    await approve(blocked.p, "ZERO_VOTE_ENTRIES_AT_CUTOFF", POLICY_VALUES.ZERO_VOTE_ENTRIES_AT_CUTOFF);
    expect((await repo.selectFinalists(blocked.p.ctx)).finalistCount).toBe(3);

    const clean = await closedPreliminary([3, 2, 1]);
    expect((await repo.selectFinalists(clean.p.ctx)).finalistCount).toBe(3);
  });

  it("BLOCKS a tie at the cutoff that is made of zero-vote entries, in a field larger than ten", async () => {
    // 12 contestants: 8 with votes, 4 with none tied at rank 9 -> they would advance only by the tie rule
    const { p } = await closedPreliminary([4, 3, 3, 2, 2, 1, 1, 1, 0, 0, 0, 0]);
    await expect(repo.selectFinalists(p.ctx)).rejects.toMatchObject({ code: "POLICY_REQUIRED", message: expect.stringContaining("ZERO_VOTE_ENTRIES_AT_CUTOFF") });
    expect(await q("select 1 from community_voting_finalist_selections where preliminary_instance_id = $1", [p.ctx.instanceId])).toHaveLength(0);
  });

  it("counts a vote for a contestant who withdrew as no valid vote", async () => {
    const { p, cands } = await closedPreliminary([2, 0]);
    await repo.withdrawRoundCandidature({ ...p.ctx, entryId: cands[0].entryId, reason: "Retiro", hidePhoto: false });
    await expect(repo.selectFinalists(p.ctx)).rejects.toMatchObject({ code: "POLICY_REQUIRED" });
  });
});

describe("a withdrawal after the cut neither alters nor refills the selection", () => {
  async function selected() {
    // 12 contestants: ranks 1,2,3,4,4,6,6,6,9,9,11,11 -> ten finalists, two outside (the two without votes fall below the cutoff)
    const c = await closedPreliminary([6, 5, 4, 3, 3, 2, 2, 2, 1, 1, 0, 0]);
    const sel = await repo.selectFinalists(c.p.ctx);
    return { ...c, sel };
  }

  it("keeps the confirmed selection exactly as it was, adds nobody in the withdrawn contestant's place, and says what is pending", async () => {
    const { p, cands, sel } = await selected();
    const before = await q("select entry_id, competition_rank, votes_at_selection from community_voting_finalists where preliminary_instance_id = $1 order by entry_id", [p.ctx.instanceId]);
    await repo.withdrawRoundCandidature({ ...p.ctx, entryId: cands[0].entryId, reason: "Retiro", hidePhoto: false });
    const after = await q("select entry_id, competition_rank, votes_at_selection from community_voting_finalists where preliminary_instance_id = $1 order by entry_id", [p.ctx.instanceId]);
    expect(after).toEqual(before);
    expect((await repo.selectFinalists(p.ctx)).selectionDigest).toBe(sel.selectionDigest);
    const overview = await repo.readRoundOverview(p.ctx);
    expect(overview.pendingResolutions.map((x) => x.key)).toEqual(["FINALIST_WITHDRAWAL_AFTER_SELECTION"]);
  });

  it("BLOCKS preparing the final until the policy is approved, then carries the confirmed finalists who have not withdrawn — nobody else", async () => {
    const { p, cands } = await selected();
    await repo.withdrawRoundCandidature({ ...p.ctx, entryId: cands[1].entryId, reason: "Retiro", hidePhoto: false });
    const f = await newRound("FINAL", { source: p, operator: p.operator });
    await expect(repo.prepareFinal(f.ctx)).rejects.toMatchObject({ code: "POLICY_REQUIRED", message: expect.stringContaining("FINALIST_WITHDRAWAL_AFTER_SELECTION") });
    expect(await q("select 1 from community_voting_entries where instance_id = $1", [f.ctx.instanceId])).toHaveLength(0);
    await approve(p, "FINALIST_WITHDRAWAL_AFTER_SELECTION", POLICY_VALUES.FINALIST_WITHDRAWAL_AFTER_SELECTION);
    expect(await repo.prepareFinal(f.ctx)).toEqual({ carriedCount: 9, alreadyPrepared: false });
  });

  it("BLOCKS opening a prepared final when a finalist withdrew since, until the policy is approved", async () => {
    const { p, cands } = await selected();
    const f = await newRound("FINAL", { source: p, operator: p.operator });
    await repo.prepareFinal(f.ctx);
    await repo.withdrawRoundCandidature({ ...p.ctx, entryId: cands[2].entryId, reason: "Retiro", hidePhoto: false });
    await lockRound(f);
    await expect(repo.startRound({ ...f.ctx, promptText: "Final" })).rejects.toMatchObject({ code: "POLICY_REQUIRED", message: expect.stringContaining("FINALIST_WITHDRAWAL_AFTER_SELECTION") });
    await approve(f, "FINALIST_WITHDRAWAL_AFTER_SELECTION", POLICY_VALUES.FINALIST_WITHDRAWAL_AFTER_SELECTION);
    expect((await repo.startRound({ ...f.ctx, promptText: "Final" })).candidateCount).toBe(9);
  });

  it("BLOCKS the publication of the preliminary's finalists while a finalist's withdrawal is unresolved — even with a current review", async () => {
    const { p, cands } = await selected();
    await repo.withdrawRoundCandidature({ ...p.ctx, entryId: cands[3].entryId, reason: "Retiro", hidePhoto: false });
    await repo.recordRoundReview(p.ctx);
    await expect(repo.publishRound(p.ctx)).rejects.toMatchObject({ code: "POLICY_REQUIRED", message: expect.stringContaining("FINALIST_WITHDRAWAL_AFTER_SELECTION") });
    await approve(p, "FINALIST_WITHDRAWAL_AFTER_SELECTION", POLICY_VALUES.FINALIST_WITHDRAWAL_AFTER_SELECTION);
    // the approval is a change the review did not cover: the review must be made again
    await expectCode(repo.publishRound(p.ctx), "REVIEW_STALE");
    await repo.recordRoundReview(p.ctx);
    expect((await repo.publishRound(p.ctx)).publishedAt).toBeTruthy();
  });

  it("BLOCKS the publication of the final when a finalist withdrew during it and the policy is unresolved", async () => {
    const { p } = await selected();
    const f = await newRound("FINAL", { source: p, operator: p.operator });
    await repo.prepareFinal(f.ctx);
    await openRound(f);
    const fc = await candidates(f);
    await castMany(f, fc[0].candidateId, 2, INSIDE);
    // GATE-006: a valid vote for ANOTHER contestant, so that the result survives the withdrawal below and the refusal under test is the Product
    // decision. (Before, every vote was for the contestant who withdrew; that final now has no valid result and is refused earlier, with
    // NO_VALID_RESULT — covered by communityVotingRoundsZeroVote.contract.test.ts.)
    await castMany(f, fc[1].candidateId, 3, INSIDE);
    await repo.closeRound(f.ctx);
    await repo.withdrawRoundCandidature({ ...f.ctx, entryId: fc[0].entryId, reason: "Retiro", hidePhoto: false });
    await repo.recordRoundReview(f.ctx);
    await expect(repo.publishRound(f.ctx)).rejects.toMatchObject({ code: "POLICY_REQUIRED" });
  });
});

// =====================================================================================================================
// 3. The schedule binds
// =====================================================================================================================

describe("deadline boundary", () => {
  it("is open strictly BEFORE the deadline: one microsecond before, at, and after", async () => {
    const [row] = await q<{ before: boolean; at: boolean; after: boolean; nul: boolean | null }>(
      `select community_voting_deadline_open(d, d - interval '1 microsecond') as before,
              community_voting_deadline_open(d, d) as at,
              community_voting_deadline_open(d, d + interval '1 microsecond') as after,
              community_voting_deadline_open(null, d) as nul
       from (select '2026-11-01 03:30:00+00'::timestamptz as d) t`
    );
    expect(row).toEqual({ before: true, at: false, after: false, nul: false });
  });
});

describe("the preliminary's deadline", () => {
  it("cannot be opened without a configured deadline, nor with one already past", async () => {
    const none = await newRound("PRELIMINARY", { closesAt: null });
    await contestants(none, 2);
    await lockRound(none);
    await expectCode(repo.startRound({ ...none.ctx, promptText: "Mejor disfraz" }), "SCHEDULE_REQUIRED");
    const past = await newRound("PRELIMINARY", { closesAt: inMs(-60_000) });
    await contestants(past, 2);
    await lockRound(past);
    await expectCode(repo.startRound({ ...past.ctx, promptText: "Mejor disfraz" }), "SCHEDULE_REQUIRED");
  });

  it("is editable any number of times before the round opens, and frozen the moment it opens (function and table)", async () => {
    const r = await newRound("PRELIMINARY");
    await contestants(r, 2);
    const t = (ms: number) => ({ registrationOpensAt: inMs(-3_600_000), contestantCutoffAt: inMs(-1000), votingOpensAt: inMs(1000), votingClosesAt: inMs(ms), status: "CONFIRMED" as const });
    await repo.setRoundSchedule({ ...r.ctx, schedule: t(7_200_000) });
    await repo.setRoundSchedule({ ...r.ctx, schedule: t(9_000_000) });
    await openRound(r);
    await expectCode(repo.setRoundSchedule({ ...r.ctx, schedule: t(99_000_000) }), "PREPARATION_CLOSED");
    await expectDbError("update community_voting_schedules set voting_closes_at = now() + interval '30 days' where instance_id = $1", [r.ctx.instanceId], "can no longer change");
    const info = await repo.readRoundPublicInfo(r.ctx.instanceId);
    expect(Date.parse(info?.deadlineAt as string)).toBe(Date.parse(r.started?.deadlineAt as string));
  });

  it("refuses an incoherent schedule: registration, cutoff, opening and closing must be in that order", async () => {
    const r = await newRound("PRELIMINARY");
    const at = (n: number) => inMs(n * 60_000);
    await expectCode(repo.setRoundSchedule({ ...r.ctx, schedule: { registrationOpensAt: at(10), contestantCutoffAt: at(5), votingOpensAt: null, votingClosesAt: null, status: "TENTATIVE" } }), "SCHEDULE_INVALID");
    await expectCode(repo.setRoundSchedule({ ...r.ctx, schedule: { registrationOpensAt: null, contestantCutoffAt: at(30), votingOpensAt: at(20), votingClosesAt: null, status: "TENTATIVE" } }), "SCHEDULE_INVALID");
    await expectCode(repo.setRoundSchedule({ ...r.ctx, schedule: { registrationOpensAt: null, contestantCutoffAt: null, votingOpensAt: at(40), votingClosesAt: at(40), status: "TENTATIVE" } }), "SCHEDULE_INVALID");
  });

  it("accepts NO vote at or after the deadline even though the operator has not closed — and still answers a replay of an accepted vote", async () => {
    const r = await newRound("PRELIMINARY");
    await contestants(r, 2);
    await repo.setRoundSchedule({ ...r.ctx, schedule: { registrationOpensAt: null, contestantCutoffAt: null, votingOpensAt: null, votingClosesAt: inMs(6000), status: "CONFIRMED" } });
    await openRound(r);
    const [c1, c2] = await candidates(r);
    const earlyPerson = await newPerson();
    const early = await voteAs(r, earlyPerson, c1.candidateId);
    expect(early.cast.outcome).toBe("APPLIED");
    const late = await newPerson();
    const lateBinding = await bind(r, late);
    const lateIntent = await repo.issueIntent({ instanceId: r.ctx.instanceId, authUserId: late.authUserId });
    await sleep(Math.max(0, Date.parse(r.started?.deadlineAt as string) - Date.now()) + 400);
    await expectCode(repo.castRoundVote(castInput(r, late, lateBinding, lateIntent.intentNo, c2.candidateId, null)), "VOTING_WINDOW_ELAPSED");
    expect(await votesIn(r)).toBe(1);
    const replay = await repo.castRoundVote(castInput(r, earlyPerson, early.binding, early.intent.intentNo, c1.candidateId, null));
    expect(replay.outcome).toBe("REPLAYED");
  });

  it("is not extended by a late opening: the deadline stays the configured one and the window is what is left", async () => {
    const r = await newRound("PRELIMINARY");
    await contestants(r, 2);
    const configured = inMs(7000);
    await repo.setRoundSchedule({ ...r.ctx, schedule: { registrationOpensAt: null, contestantCutoffAt: null, votingOpensAt: inMs(-60_000), votingClosesAt: configured, status: "CONFIRMED" } });
    await sleep(2500); // the operator is late
    await openRound(r);
    expect(Date.parse(r.started?.deadlineAt as string)).toBe(Date.parse(configured));
    const [c1] = await candidates(r);
    expect((await voteAs(r, await newPerson(), c1.candidateId)).cast.outcome).toBe("APPLIED");
  });

  it("holds a request that waits for the session lock to the deadline: released AFTER it, the vote is refused and stores nothing; released BEFORE it, the same request is accepted", async () => {
    for (const mode of ["after", "before"] as const) {
      const r = await newRound("PRELIMINARY");
      await contestants(r, 2);
      await repo.setRoundSchedule({ ...r.ctx, schedule: { registrationOpensAt: null, contestantCutoffAt: null, votingOpensAt: null, votingClosesAt: inMs(mode === "after" ? 7000 : 20_000), status: "CONFIRMED" } });
      await openRound(r);
      const [c1] = await candidates(r);
      const voter = await newPerson();
      const binding = await bind(r, voter);
      const intent = await repo.issueIntent({ instanceId: r.ctx.instanceId, authUserId: voter.authUserId });
      const holder = await rawClient();
      try {
        await holder.query("begin");
        await holder.query("select 1 from sessions where session_id = $1 for update", [r.session.sessionId]);
        const pending = repo.castRoundVote(castInput(r, voter, binding, intent.intentNo, c1.candidateId, null)).then((v) => ({ v }), (e: unknown) => ({ e }));
        await sleep(mode === "after" ? Math.max(0, Date.parse(r.started?.deadlineAt as string) - Date.now()) + 600 : 800);
        await holder.query("commit");
        const out = (await pending) as { v?: { outcome: string }; e?: { code?: string } };
        if (mode === "after") {
          expect(out.e?.code).toBe("VOTING_WINDOW_ELAPSED");
          expect(await votesIn(r)).toBe(0);
        } else {
          expect(out.v?.outcome).toBe("APPLIED");
          expect(await votesIn(r)).toBe(1);
        }
      } finally {
        await holder.end().catch(() => undefined);
      }
    }
  });

  it("binds registration and photographs to the cutoff: nothing new is accepted at or after it", async () => {
    const r = await newRound("PRELIMINARY");
    const entry = await repo.createRoundEntry(r.ctx);
    await repo.setRoundSchedule({ ...r.ctx, schedule: { registrationOpensAt: null, contestantCutoffAt: inMs(2500), votingOpensAt: null, votingClosesAt: inMs(3_600_000), status: "CONFIRMED" } });
    const photo = await repo.uploadEntryPhoto({ ...r.ctx, entryId: entry.entryId, ...photoArgs(901) });
    expect(photo.photoId).toBeTruthy();
    await sleep(3000);
    await expectCode(repo.createRoundEntry(r.ctx), "CUTOFF_PASSED");
    await expectCode(repo.uploadEntryPhoto({ ...r.ctx, entryId: entry.entryId, ...photoArgs(902) }), "CUTOFF_PASSED");
  });
});

describe("the final's deadline", () => {
  it("is measured from the explicit opening, not from registration or preparation, and cannot be edited afterwards", async () => {
    const { p } = await closedPreliminary([3, 2, 1]);
    await repo.selectFinalists(p.ctx);
    const f = await newRound("FINAL", { source: p, operator: p.operator, windowSeconds: 10 });
    await repo.prepareFinal(f.ctx);
    await sleep(2500); // time passes between preparation and opening
    const before = Date.now();
    const started = await openRound(f);
    expect(Date.parse(started.deadlineAt as string) - Date.parse(started.openedAt)).toBe(10_000);
    expect(Date.parse(started.openedAt)).toBeGreaterThanOrEqual(before - 50);
    await expectCode(repo.setRoundSchedule({ ...f.ctx, schedule: { registrationOpensAt: null, contestantCutoffAt: null, votingOpensAt: null, votingClosesAt: inMs(3_600_000), status: "CONFIRMED" } }), "PREPARATION_CLOSED");
  });

  it("holds a request waiting for the session lock to the window: released after the 10 seconds it is refused and stores nothing", async () => {
    const { p } = await closedPreliminary([3, 2, 1]);
    await repo.selectFinalists(p.ctx);
    const f = await newRound("FINAL", { source: p, operator: p.operator, windowSeconds: 10 });
    await repo.prepareFinal(f.ctx);
    const started = await openRound(f);
    const [c1] = await candidates(f);
    const voter = await newPerson();
    const binding = await bind(f, voter);
    const intent = await repo.issueIntent({ instanceId: f.ctx.instanceId, authUserId: voter.authUserId });
    // The REST layer cancels a statement after 8 seconds (SQLSTATE 57014, nothing stored), so the lock is taken shortly before the window ends:
    // the request waits ACROSS the deadline, which is what is being proven, without waiting out the whole window.
    await sleep(Math.max(0, Date.parse(started.deadlineAt as string) - Date.now() - 3500));
    const holder = await rawClient();
    try {
      await holder.query("begin");
      await holder.query("select 1 from sessions where session_id = $1 for update", [f.session.sessionId]);
      const pending = repo.castRoundVote(castInput(f, voter, binding, intent.intentNo, c1.candidateId, INSIDE)).then((v) => ({ v }), (e: unknown) => ({ e }));
      await sleep(Math.max(0, Date.parse(started.deadlineAt as string) - Date.now()) + 600);
      await holder.query("commit");
      const out = (await pending) as { v?: unknown; e?: { code?: string; message?: string } };
      expect(out.e ?? out.v).toMatchObject({ code: "VOTING_WINDOW_ELAPSED" });
      expect(await votesIn(f)).toBe(0);
    } finally {
      await holder.end().catch(() => undefined);
    }
  });
});

// =====================================================================================================================
// 4. Six separate things: photo visibility, candidature, vote evidence, selection, review, publication
// =====================================================================================================================

describe("photo visibility is separate from candidature, from vote evidence and from the selection", () => {
  it("hiding a photograph removes it from view and erases its bytes WITHOUT withdrawing the candidature, touching a vote or altering the selection", async () => {
    const { p, people, cands } = await closedPreliminary([4, 3, 2]);
    const sel = await repo.selectFinalists(p.ctx);
    const votesBefore = await q("select candidate_id, count(*) n from votes group by candidate_id having candidate_id = any($1) order by candidate_id", [cands.map((c) => c.candidateId)]);
    const hidden = await repo.hideRoundPhoto({ ...p.ctx, entryId: people[0].entry.entryId, reason: "La persona lo pidió" });
    expect(hidden.actionId).toBeTruthy();
    const [photo] = await q("select full_bytes, bytes_deleted_reason from community_voting_entry_photos where entry_id = $1", [people[0].entry.entryId]);
    expect(photo).toMatchObject({ full_bytes: null, bytes_deleted_reason: "PRIVACY_REQUEST" });
    expect(await repo.readRoundPhoto({ instanceId: p.ctx.instanceId, alias: cands[0].label.slice(1), variant: "thumb" })).toBeNull();
    expect((await repo.readRoundGallery(p.ctx.instanceId)).map((g) => g.alias)).not.toContain(cands[0].label);
    expect(await q("select 1 from community_voting_withdrawals where entry_id = $1", [cands[0].entryId])).toHaveLength(0);
    expect(await q("select candidate_id, count(*) n from votes group by candidate_id having candidate_id = any($1) order by candidate_id", [cands.map((c) => c.candidateId)])).toEqual(votesBefore);
    expect((await repo.selectFinalists(p.ctx)).selectionDigest).toBe(sel.selectionDigest);
    const overview = await repo.readRoundOverview(p.ctx);
    expect(overview.entries.find((e) => e.entryId === people[0].entry.entryId)).toMatchObject({ media: "HIDDEN", withdrawn: false });
    expect(overview.pendingResolutions).toEqual([]);
    expect((await repo.readRoundEvidence(p.ctx)).operatorActions.map((a) => a.action)).toContain("HIDE_PHOTO");
  });

  it("is possible at any time, and the hidden photograph is hidden in BOTH rounds", async () => {
    const { p, people } = await closedPreliminary([4, 3, 2]);
    await repo.selectFinalists(p.ctx);
    const f = await newRound("FINAL", { source: p, operator: p.operator });
    await repo.prepareFinal(f.ctx);
    await repo.hideRoundPhoto({ ...p.ctx, entryId: people[0].entry.entryId, reason: "Privacidad" });
    const label = (await q<{ label: string }>("select label from community_voting_entries where entry_id = $1", [people[0].entry.entryId]))[0].label;
    expect(await repo.readRoundPhoto({ instanceId: f.ctx.instanceId, alias: label.slice(1), variant: "full" })).toBeNull();
    expect((await repo.readRoundGallery(f.ctx.instanceId)).map((g) => g.alias)).not.toContain(label);
  });

  it("is refused for an entry that is not the round's, and recorded append-only", async () => {
    const r = await newRound("PRELIMINARY");
    const [c] = await contestants(r, 1);
    const other = await newRound("PRELIMINARY");
    await expectCode(repo.hideRoundPhoto({ ...other.ctx, entryId: c.entry.entryId, reason: "x" }), "ENTRY_NOT_FOUND");
    await repo.hideRoundPhoto({ ...r.ctx, entryId: c.entry.entryId, reason: "Privacidad" });
    await expectDbError("update community_voting_photo_privacy_actions set reason = 'y' where instance_id = $1", [r.ctx.instanceId], "cannot be changed");
  });
});

describe("candidature withdrawal is separate from the photograph and never deletes vote evidence", () => {
  it("withdraws the candidature without erasing the photograph unless that is asked for, and preserves every vote", async () => {
    const { p, people, cands } = await closedPreliminary([3, 2, 1]);
    const votesOf = async () => Number((await q<{ n: string }>("select count(*) n from votes where candidate_id = $1", [cands[0].candidateId]))[0].n);
    expect(await votesOf()).toBe(3);
    await repo.withdrawRoundCandidature({ ...p.ctx, entryId: cands[0].entryId, reason: "Retiro", hidePhoto: false });
    const [kept] = await q("select full_bytes is not null as has_bytes from community_voting_entry_photos where entry_id = $1", [people[0].entry.entryId]);
    expect(kept.has_bytes).toBe(true);
    expect(await repo.readRoundPhoto({ instanceId: p.ctx.instanceId, alias: cands[0].label.slice(1), variant: "thumb" })).toBeNull(); // not shown
    expect(await votesOf()).toBe(3);

    await repo.withdrawRoundCandidature({ ...p.ctx, entryId: cands[1].entryId, reason: "Retiro y borrar", hidePhoto: true });
    const [erased] = await q("select full_bytes, bytes_deleted_reason from community_voting_entry_photos where entry_id = $1", [people[1].entry.entryId]);
    expect(erased).toMatchObject({ full_bytes: null, bytes_deleted_reason: "PRIVACY_REQUEST" });
    expect(await q("select 1 from community_voting_photo_privacy_actions where entry_id = $1", [people[1].entry.entryId])).toHaveLength(1);
    expect(Number((await q<{ n: string }>("select count(*) n from votes where candidate_id = $1", [cands[1].candidateId]))[0].n)).toBe(2);
    // excluded from the tally, kept as evidence
    const rows = await repo.readRoundResults(p.ctx);
    expect(rows.filter((r) => r.withdrawn).map((r) => r.votes).sort()).toEqual([2, 3]);
  });
});

describe("photograph publication and voting are separate permissions", () => {
  it("shows an approved, consented, associated photograph BEFORE the round opens — while voting still needs the round open", async () => {
    const r = await newRound("PRELIMINARY");
    const [c] = await contestants(r, 2);
    const unconfirmed = await approvedEntry(r);
    const gallery = await repo.readRoundGallery(r.ctx.instanceId);
    expect(gallery).toHaveLength(2); // the two confirmed contestants; the approved-but-unassociated entry is not shown
    const label = (await q<{ label: string }>("select label from community_voting_entries where entry_id = $1", [c.entry.entryId]))[0].label;
    expect((await repo.readRoundPhoto({ instanceId: r.ctx.instanceId, alias: label.slice(1), variant: "thumb" }))?.contentType).toBe("image/jpeg");
    expect(await repo.readRoundPhoto({ instanceId: r.ctx.instanceId, alias: unconfirmed.entry.label.slice(1), variant: "thumb" })).toBeNull();
    const voter = await newPerson();
    await bind(r, voter);
    await expectCode(repo.issueIntent({ instanceId: r.ctx.instanceId, authUserId: voter.authUserId }), "VOTING_NOT_OPEN");
  });

  it("does not show a photograph that has no consent, is not approved, or whose association is pending", async () => {
    const r = await newRound("PRELIMINARY");
    const entry = await repo.createRoundEntry(r.ctx);
    await repo.uploadEntryPhoto({ ...r.ctx, entryId: entry.entryId, ...photoArgs(931) });
    expect(await repo.readRoundGallery(r.ctx.instanceId)).toEqual([]);
    expect(await repo.readRoundPhoto({ instanceId: r.ctx.instanceId, alias: entry.label.slice(1), variant: "thumb" })).toBeNull();
  });
});

describe("a reviewed result is invalidated by any change to who is eligible", () => {
  it("cannot be published after a withdrawal that followed its review, and needs a new review", async () => {
    const { p, cands } = await closedPreliminary([3, 2, 1]);
    await repo.selectFinalists(p.ctx);
    await repo.recordRoundReview(p.ctx);
    await repo.withdrawRoundCandidature({ ...p.ctx, entryId: cands[2].entryId, reason: "Retiro", hidePhoto: false });
    await expectCode(repo.publishRound(p.ctx), "REVIEW_STALE");
    await expect((await repo.readRoundOverview(p.ctx)).review).toMatchObject({ current: false });
    await approve(p, "FINALIST_WITHDRAWAL_AFTER_SELECTION", POLICY_VALUES.FINALIST_WITHDRAWAL_AFTER_SELECTION);
    await expectCode(repo.publishRound(p.ctx), "REVIEW_STALE");
    await repo.recordRoundReview(p.ctx);
    expect((await repo.publishRound(p.ctx)).publishedAt).toBeTruthy();
  });
});

describe("a published result is a snapshot that nothing rewrites", () => {
  it("keeps the announced finalists, without counts, when a finalist withdraws afterwards — and flags the operator instead", async () => {
    const { p, people, cands } = await closedPreliminary([3, 2, 1]);
    await repo.selectFinalists(p.ctx);
    await repo.recordRoundReview(p.ctx);
    await repo.publishRound(p.ctx);
    const published = await repo.readRoundPublicResults(p.ctx.instanceId);
    expect(published.map((x) => x.alias).sort()).toEqual(cands.map((c) => c.label).sort());
    for (const row of published) expect(Object.keys(row).sort()).toEqual(["alias", "kind", "ordinal"]);
    expect(JSON.stringify(published)).not.toMatch(/vote|count|rank|total/i);

    await repo.withdrawRoundCandidature({ ...p.ctx, entryId: cands[0].entryId, reason: "Retiro posterior a la publicación", hidePhoto: true });
    expect(await repo.readRoundPublicResults(p.ctx.instanceId)).toEqual(published);
    const overview = await repo.readRoundOverview(p.ctx);
    expect(overview.publishedAffected.map((x) => x.alias)).toEqual([cands[0].label]);
    expect(await repo.readRoundPhoto({ instanceId: p.ctx.instanceId, alias: cands[0].label.slice(1), variant: "thumb" })).toBeNull(); // the photograph is gone even though the number was announced
    expect(people).toHaveLength(3);
    await expectDbError("update community_voting_published_results set alias = '#0000' where instance_id = $1", [p.ctx.instanceId], "cannot be changed");
    await expectDbError("delete from community_voting_published_results where instance_id = $1", [p.ctx.instanceId], "cannot be deleted");
  });

  it("announces the final's shared winners from the snapshot, without counts, whatever happens to a winner afterwards", async () => {
    const { p } = await closedPreliminary([3, 2, 1]);
    await repo.selectFinalists(p.ctx);
    const f = await newRound("FINAL", { source: p, operator: p.operator });
    await repo.prepareFinal(f.ctx);
    await openRound(f);
    const fc = await candidates(f);
    await castMany(f, fc[0].candidateId, 2, INSIDE);
    await castMany(f, fc[1].candidateId, 2, INSIDE);
    await castMany(f, fc[2].candidateId, 1, INSIDE);
    await repo.closeRound(f.ctx);
    await repo.recordRoundReview(f.ctx);
    await repo.publishRound(f.ctx);
    const winners = await repo.readRoundPublicResults(f.ctx.instanceId);
    expect(winners.map((w) => w.kind)).toEqual(["WINNERS", "WINNERS"]);
    expect(JSON.stringify(winners)).not.toMatch(/vote|count|rank|total/i);
    await repo.withdrawRoundCandidature({ ...f.ctx, entryId: fc[0].entryId, reason: "Retiro", hidePhoto: false });
    expect(await repo.readRoundPublicResults(f.ctx.instanceId)).toEqual(winners);
  });
});

describe("a promotional consent withdrawn after an external use is a recorded request and a pending task", () => {
  it("creates one pending operational task, says the system does not delete external publications, and records its resolution", async () => {
    const r = await newRound("PRELIMINARY");
    const [c] = await contestants(r, 2);
    const promo = (decision: "ACCEPTED" | "DECLINED" | "WITHDRAWN") =>
      repo.recordPromoConsent({ ...r.ctx, entryId: c.entry.entryId, decision, consentVersion: "halloween-2026-v2-promo", statementSha256: "a".repeat(64) });
    await promo("DECLINED");
    expect((await repo.readRoundOverview(r.ctx)).tasks).toEqual([]);
    await promo("ACCEPTED");
    expect((await repo.readRoundOverview(r.ctx)).tasks).toEqual([]);
    await promo("WITHDRAWN");
    const [task] = (await repo.readRoundOverview(r.ctx)).tasks;
    expect(task).toMatchObject({ kind: "EXTERNAL_PROMO_REMOVAL", status: "PENDING" });
    expect(task.description).toMatch(/no elimina publicaciones externas/i);
    expect(task.description).toMatch(/Instagram/);
    await repo.resolveFollowupTask({ ...r.ctx, taskId: task.taskId, note: "Se retiró la publicación a mano" });
    expect((await repo.readRoundOverview(r.ctx)).tasks[0]).toMatchObject({ status: "DONE" });
    await expectCode(repo.resolveFollowupTask({ ...r.ctx, taskId: task.taskId, note: "otra vez" }), "ALREADY_CLOSED");
  });
});

describe("contestants", () => {
  it("still compete without any promotional decision, and the preliminary cannot be opened by a lone contestant", async () => {
    const r = await newRound("PRELIMINARY");
    await contestant(r);
    await lockRound(r);
    await expectCode(repo.startRound({ ...r.ctx, promptText: "Mejor disfraz" }), "PREPARATION_INCOMPLETE");
  });
});

// =====================================================================================================================
// 5. The guards the corrections rely on hold for a writer that goes around the functions
//    (added after the mutation checks showed these were only covered indirectly)
// =====================================================================================================================

describe("table guards behind the corrections", () => {
  it("a policy approval is refused at the table when the pair of rounds already has it — recorded on the OTHER round", async () => {
    const p = await newRound("PRELIMINARY");
    await approve(p, "ZERO_VALID_VOTES_PRELIMINARY", POLICY_VALUES.ZERO_VALID_VOTES_PRELIMINARY);
    const f = await newRound("FINAL", { source: p, operator: p.operator });
    await expectDbError(
      "insert into community_voting_policy_approvals (instance_id, policy_key, policy_value, approval_reference, approved_by_member_id) values ($1, 'ZERO_VALID_VOTES_PRELIMINARY', 'ALL_ENTRIES_ADVANCE', 'DIRECT-WRITE', $2)",
      [f.ctx.instanceId, p.operator.gamingMemberId],
      "already been approved"
    );
  });

  it("the announced result is written only by the publication: a direct insert is refused before anything else", async () => {
    const { p } = await closedPreliminary([3, 2, 1]);
    await repo.selectFinalists(p.ctx);
    await repo.recordRoundReview(p.ctx);
    await repo.publishRound(p.ctx);
    const [row] = await q<{ entry_id: string }>("select entry_id from community_voting_published_results where instance_id = $1 limit 1", [p.ctx.instanceId]);
    await expectDbError(
      "insert into community_voting_published_results (instance_id, entry_id, kind, alias, ordinal) values ($1, $2, 'FINALISTS', '#0000', 99)",
      [p.ctx.instanceId, row.entry_id],
      "ROUND_PATH_REQUIRED"
    );
  });

  it("a privacy record written around the function still hides the photograph, even though its bytes were not erased", async () => {
    const r = await newRound("PRELIMINARY");
    const [c] = await contestants(r, 2);
    expect((await repo.readRoundGallery(r.ctx.instanceId)).map((g) => g.alias)).toContain(c.entry.label);
    await q("insert into community_voting_photo_privacy_actions (instance_id, entry_id, reason, performed_by_member_id) values ($1, $2, 'escrito a mano', $3)", [r.ctx.instanceId, c.entry.entryId, r.operator.gamingMemberId]);
    const [bytes] = await q<{ kept: boolean }>("select full_bytes is not null as kept from community_voting_entry_photos where entry_id = $1", [c.entry.entryId]);
    expect(bytes.kept).toBe(true); // nothing erased them: the record alone must be enough to stop showing it
    expect((await repo.readRoundGallery(r.ctx.instanceId)).map((g) => g.alias)).not.toContain(c.entry.label);
    expect(await repo.readRoundPhoto({ instanceId: r.ctx.instanceId, alias: c.entry.label.slice(1), variant: "full" })).toBeNull();
  });

  it("no new photograph is accepted for a person who asked for theirs to be hidden", async () => {
    const r = await newRound("PRELIMINARY");
    const [c] = await contestants(r, 1);
    await repo.hideRoundPhoto({ ...r.ctx, entryId: c.entry.entryId, reason: "Privacidad" });
    await expectCode(repo.uploadEntryPhoto({ ...r.ctx, entryId: c.entry.entryId, ...photoArgs(940) }), "PHOTO_HIDDEN");
  });

  it("votes of a round cannot be deleted, whoever writes", async () => {
    const { p } = await closedPreliminary([2, 1]);
    const before = await votesIn(p);
    await expectDbError("delete from votes where interaction_instance_id = $1", [p.started?.interactionInstanceId], "ROUND_PATH_REQUIRED");
    expect(await votesIn(p)).toBe(before);
  });
});
