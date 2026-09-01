import { loadEnv } from "vite";
import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";

import { SupabaseTowersRepository } from "../lib/gaming/towers/db/supabaseTowersRepository";
import { startAttempt } from "../lib/gaming/towers/startAttempt";
import { applyMove } from "../lib/gaming/towers/applyMove";
import { undoMove } from "../lib/gaming/towers/undoMove";
import { restartAttempt } from "../lib/gaming/towers/restartAttempt";
import { getAttempt } from "../lib/gaming/towers/getAttempt";
import { TowersIllegalMoveError, TowersNothingToUndoError } from "../lib/gaming/towers/types";

const env = loadEnv("development", process.cwd(), "");
const supabaseUrl = env.SUPABASE_URL;
const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for contract tests.");
}

const repo = new SupabaseTowersRepository(supabaseUrl, supabaseServiceRoleKey);
const cleanupClient = createClient(supabaseUrl, supabaseServiceRoleKey);

const createdAttemptIds: string[] = [];
let idCounter = 0;
function key(): string {
  idCounter += 1;
  return `contract-key-${idCounter}-${Date.now()}`;
}

afterAll(async () => {
  // Same FK-direction concern as rutasSupabaseRepository.contract.test.ts:
  // towers_attempts self-references via restart_of_attempt_id with NO
  // cascade, so a predecessor pushed before its successor cannot be
  // deleted first. Delete attempts in REVERSE push order.
  for (const attemptId of createdAttemptIds) {
    await cleanupClient.from("towers_attempt_actions").delete().eq("attempt_id", attemptId);
  }
  for (const attemptId of [...createdAttemptIds].reverse()) {
    await cleanupClient.from("towers_attempts").delete().eq("attempt_id", attemptId);
  }
});

describe("SupabaseTowersRepository contract", () => {
  it("full attempt pipeline against real local Postgres: create, move, timer, reload, undo, restart, completion", async () => {
    const { attempt: created } = await startAttempt(repo, { scenarioId: "towers-001", scenarioVersion: 1 });
    createdAttemptIds.push(created.attemptId);

    expect(created.outcome).toBe("IN_PROGRESS");
    expect(created.startedAt).toBeNull();
    expect(created.currentStacks).toEqual({ T1: [3, 2, 1], T2: [], T3: [] });

    // Atomic MOVE persists and starts the timer on first legal move.
    const moved = await applyMove(repo, { attemptId: created.attemptId, fromTowerId: "T1", toTowerId: "T3", idempotencyKey: key() });
    expect(moved.attempt.currentStacks).toEqual({ T1: [3, 2], T2: [], T3: [1] });
    expect(moved.attempt.startedAt).not.toBeNull();

    // Authoritative reload reconstructs identical state — this is the
    // exact read path the mandatory cache/staleness proof exercises live
    // against the running Next.js server; here it proves correctness
    // against Postgres directly.
    const reloaded = await getAttempt(repo, created.attemptId);
    expect(reloaded.currentStacks).toEqual(moved.attempt.currentStacks);
    expect(reloaded.startedAt).toBe(moved.attempt.startedAt);
    expect(reloaded.actionHistory).toHaveLength(1);
    expect(reloaded.actionHistory[0].type).toBe("MOVE");

    // Idempotent duplicate MOVE (same key) does not double-apply.
    const dupeKey = key();
    const first = await applyMove(repo, { attemptId: created.attemptId, fromTowerId: "T1", toTowerId: "T2", idempotencyKey: dupeKey });
    expect(first.alreadyApplied).toBe(false);
    const dupe = await applyMove(repo, { attemptId: created.attemptId, fromTowerId: "T1", toTowerId: "T2", idempotencyKey: dupeKey });
    expect(dupe.alreadyApplied).toBe(true);
    expect(dupe.attempt.moveCount).toBe(2);
    expect(dupe.attempt.currentStacks).toEqual({ T1: [3], T2: [2], T3: [1] });

    // Illegal move (larger-on-smaller) genuinely rejected by real Postgres validation.
    await expect(
      applyMove(repo, { attemptId: created.attemptId, fromTowerId: "T1", toTowerId: "T3", idempotencyKey: key() })
    ).rejects.toBeInstanceOf(TowersIllegalMoveError);

    // Undo persists correctly.
    const undone = await undoMove(repo, { attemptId: created.attemptId, idempotencyKey: key() });
    expect(undone.attempt.currentStacks).toEqual({ T1: [3, 2], T2: [], T3: [1] });
    expect(undone.attempt.undoCount).toBe(1);

    // Second consecutive Undo genuinely rejected by real Postgres.
    await expect(
      undoMove(repo, { attemptId: created.attemptId, idempotencyKey: key() })
    ).rejects.toBeInstanceOf(TowersNothingToUndoError);

    // Undo left us back at T1=[3,2],T2=[],T3=[1] (state after the first
    // move only). Redo the same transfer (a fresh MOVE, new idempotency
    // key — this is not a repeat of the undone one) to reach T1=[3],
    // T2=[2],T3=[1], then replay the verified scenario-1 solution's
    // remaining moves 3-7 from there through to completion.
    await applyMove(repo, { attemptId: created.attemptId, fromTowerId: "T1", toTowerId: "T2", idempotencyKey: key() }); // T1=[3] T2=[2] T3=[1]
    await applyMove(repo, { attemptId: created.attemptId, fromTowerId: "T3", toTowerId: "T2", idempotencyKey: key() }); // T1=[3] T2=[2,1] T3=[]
    await applyMove(repo, { attemptId: created.attemptId, fromTowerId: "T1", toTowerId: "T3", idempotencyKey: key() }); // T1=[] T2=[2,1] T3=[3]
    await applyMove(repo, { attemptId: created.attemptId, fromTowerId: "T2", toTowerId: "T1", idempotencyKey: key() }); // T1=[1] T2=[2] T3=[3]
    await applyMove(repo, { attemptId: created.attemptId, fromTowerId: "T2", toTowerId: "T3", idempotencyKey: key() }); // T1=[1] T2=[] T3=[3,2]
    const cleared = await applyMove(repo, { attemptId: created.attemptId, fromTowerId: "T1", toTowerId: "T3", idempotencyKey: key() }); // T3=[3,2,1]
    expect(cleared.completed).toBe(true);
    expect(cleared.attempt.completedAt).not.toBeNull();
    // moveCount is a monotonic counter of every committed MOVE, including
    // the one later undone: 2 (before undo) + 6 more through completion = 8.
    expect(cleared.attempt.moveCount).toBe(8);
    const afterComplete = await getAttempt(repo, created.attemptId);
    expect(afterComplete.outcome).toBe("COMPLETE");
    expect(afterComplete.completedAt).toBe(cleared.attempt.completedAt);
    expect(afterComplete.currentStacks).toEqual({ T1: [], T2: [], T3: [3, 2, 1] });

    // Restart linkage/preservation.
    const restarted = await restartAttempt(repo, { attemptId: created.attemptId, idempotencyKey: key() });
    createdAttemptIds.push(restarted.newAttempt.attemptId);
    expect(restarted.newAttempt.restartOfAttemptId).toBe(created.attemptId);
    expect(restarted.newAttempt.currentStacks).toEqual({ T1: [3, 2, 1], T2: [], T3: [] });

    const oldAfterRestart = await getAttempt(repo, created.attemptId);
    // Was already COMPLETE before restart — stays COMPLETE, not ABANDONED.
    expect(oldAfterRestart.outcome).toBe("COMPLETE");
  });

  it("a fresh IN_PROGRESS attempt that abandons via Restart is correctly marked ABANDONED, not COMPLETE", async () => {
    const { attempt: created } = await startAttempt(repo, { scenarioId: "towers-001", scenarioVersion: 1 });
    createdAttemptIds.push(created.attemptId);
    await applyMove(repo, { attemptId: created.attemptId, fromTowerId: "T1", toTowerId: "T3", idempotencyKey: key() });

    const restarted = await restartAttempt(repo, { attemptId: created.attemptId, idempotencyKey: key() });
    createdAttemptIds.push(restarted.newAttempt.attemptId);

    const oldAfterRestart = await getAttempt(repo, created.attemptId);
    expect(oldAfterRestart.outcome).toBe("ABANDONED");
  });

  it("split-start Scenario 3 persists a non-single-origin initial arrangement correctly against real Postgres", async () => {
    const { attempt: created } = await startAttempt(repo, { scenarioId: "towers-003", scenarioVersion: 1 });
    createdAttemptIds.push(created.attemptId);
    expect(created.currentStacks).toEqual({ T1: [3, 1], T2: [2], T3: [] });

    const result = await applyMove(repo, { attemptId: created.attemptId, fromTowerId: "T1", toTowerId: "T2", idempotencyKey: key() });
    expect(result.attempt.currentStacks).toEqual({ T1: [3], T2: [2, 1], T3: [] });
  });
});
