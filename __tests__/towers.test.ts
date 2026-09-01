import { describe, expect, it } from "vitest";

import { InMemoryTowersRepository } from "../lib/gaming/towers/db/inMemoryTowersRepository";
import { startAttempt } from "../lib/gaming/towers/startAttempt";
import { applyMove } from "../lib/gaming/towers/applyMove";
import { undoMove } from "../lib/gaming/towers/undoMove";
import { restartAttempt } from "../lib/gaming/towers/restartAttempt";
import { getAttempt } from "../lib/gaming/towers/getAttempt";
import { isComplete, validateAndApplyMove } from "../lib/gaming/towers/moveLogic";
import type { TowersScenario } from "../lib/gaming/towers/types";
import {
  TowersAttemptNotFoundError,
  TowersAttemptNotInProgressError,
  TowersIllegalMoveError,
  TowersNothingToUndoError,
} from "../lib/gaming/towers/types";

let idCounter = 0;
function key(): string {
  idCounter += 1;
  return `test-key-${idCounter}`;
}

async function startScenario1(repo: InMemoryTowersRepository) {
  const { attempt } = await startAttempt(repo, { scenarioId: "towers-001", scenarioVersion: 1 });
  return attempt;
}

async function startScenario3(repo: InMemoryTowersRepository) {
  const { attempt } = await startAttempt(repo, { scenarioId: "towers-003", scenarioVersion: 1 });
  return attempt;
}

// Hand-verified optimal 7-move solution for the classic 3-disk case
// (source T1, auxiliary T2, destination T3) — see scenarios.ts.
const SCENARIO_1_SOLUTION: Array<[string, string]> = [
  ["T1", "T3"],
  ["T1", "T2"],
  ["T3", "T2"],
  ["T1", "T3"],
  ["T2", "T1"],
  ["T2", "T3"],
  ["T1", "T3"],
];

// Hand-verified optimal 15-move solution for the classic 4-disk case —
// see scenarios.ts / the Towers Slice 001 implementation record.
const SCENARIO_2_SOLUTION: Array<[string, string]> = [
  ["T1", "T2"],
  ["T1", "T3"],
  ["T2", "T3"],
  ["T1", "T2"],
  ["T3", "T1"],
  ["T3", "T2"],
  ["T1", "T2"],
  ["T1", "T3"],
  ["T2", "T3"],
  ["T2", "T1"],
  ["T3", "T1"],
  ["T2", "T3"],
  ["T1", "T2"],
  ["T1", "T3"],
  ["T2", "T3"],
];

// Hand-verified 5-move solution for the split-start case (T1=[3,1],
// T2=[2], T3=[]) — see scenarios.ts's own worked comment.
const SCENARIO_3_SOLUTION: Array<[string, string]> = [
  ["T1", "T2"],
  ["T1", "T3"],
  ["T2", "T1"],
  ["T2", "T3"],
  ["T1", "T3"],
];

async function playSolution(repo: InMemoryTowersRepository, attemptId: string, moves: Array<[string, string]>) {
  let last;
  for (const [fromTowerId, toTowerId] of moves) {
    last = await applyMove(repo, { attemptId, fromTowerId, toTowerId, idempotencyKey: key() });
  }
  return last!;
}

describe("URBANO Towers Slice 001", () => {
  // --- Legal move contract -------------------------------------------

  it("a legal top-piece transfer moves the piece and updates both towers", async () => {
    const repo = new InMemoryTowersRepository();
    const attempt = await startScenario1(repo);

    const result = await applyMove(repo, { attemptId: attempt.attemptId, fromTowerId: "T1", toTowerId: "T3", idempotencyKey: key() });
    expect(result.attempt.currentStacks.T1).toEqual([3, 2]);
    expect(result.attempt.currentStacks.T3).toEqual([1]);
    expect(result.attempt.moveCount).toBe(1);
  });

  it("rejects placing a larger piece on top of a smaller piece", async () => {
    const repo = new InMemoryTowersRepository();
    const attempt = await startScenario1(repo);
    // Move disk 1 to T2, then disk 2 (still on T1, larger) cannot land on T2's disk 1.
    await applyMove(repo, { attemptId: attempt.attemptId, fromTowerId: "T1", toTowerId: "T2", idempotencyKey: key() });

    await expect(
      applyMove(repo, { attemptId: attempt.attemptId, fromTowerId: "T1", toTowerId: "T2", idempotencyKey: key() })
    ).rejects.toBeInstanceOf(TowersIllegalMoveError);
  });

  it("allows placing a smaller piece on top of a larger piece", async () => {
    const repo = new InMemoryTowersRepository();
    const attempt = await startScenario1(repo);
    await applyMove(repo, { attemptId: attempt.attemptId, fromTowerId: "T1", toTowerId: "T3", idempotencyKey: key() }); // disk1 -> T3
    const result = await applyMove(repo, { attemptId: attempt.attemptId, fromTowerId: "T1", toTowerId: "T2", idempotencyKey: key() }); // disk2 -> T2 (empty)
    expect(result.attempt.currentStacks.T2).toEqual([2]);
    const onLarger = await applyMove(repo, { attemptId: attempt.attemptId, fromTowerId: "T3", toTowerId: "T2", idempotencyKey: key() }); // disk1 onto disk2
    expect(onLarger.attempt.currentStacks.T2).toEqual([2, 1]);
  });

  it("rejects a move from an empty source tower", async () => {
    const repo = new InMemoryTowersRepository();
    const attempt = await startScenario1(repo);
    await expect(
      applyMove(repo, { attemptId: attempt.attemptId, fromTowerId: "T2", toTowerId: "T3", idempotencyKey: key() })
    ).rejects.toBeInstanceOf(TowersIllegalMoveError);
  });

  it("rejects a move where source and destination are the same tower", async () => {
    const repo = new InMemoryTowersRepository();
    const attempt = await startScenario1(repo);
    await expect(
      applyMove(repo, { attemptId: attempt.attemptId, fromTowerId: "T1", toTowerId: "T1", idempotencyKey: key() })
    ).rejects.toBeInstanceOf(TowersIllegalMoveError);
  });

  it("rejects a move referencing a tower that does not exist in the scenario", async () => {
    const repo = new InMemoryTowersRepository();
    const attempt = await startScenario1(repo);
    await expect(
      applyMove(repo, { attemptId: attempt.attemptId, fromTowerId: "T1", toTowerId: "T9", idempotencyKey: key() })
    ).rejects.toBeInstanceOf(TowersIllegalMoveError);
    await expect(
      applyMove(repo, { attemptId: attempt.attemptId, fromTowerId: "T9", toTowerId: "T1", idempotencyKey: key() })
    ).rejects.toBeInstanceOf(TowersIllegalMoveError);
  });

  it("only ever moves the top piece of the source tower, by construction", async () => {
    // The move contract has no piece-identity parameter at all — a
    // client cannot request moving a buried piece even in principle.
    // This test proves the derived piece is always the current top.
    const repo = new InMemoryTowersRepository();
    const attempt = await startScenario1(repo);
    const result = await applyMove(repo, { attemptId: attempt.attemptId, fromTowerId: "T1", toTowerId: "T3", idempotencyKey: key() });
    // Top of T1 was rank 1 (smallest); confirm exactly rank 1 moved, not 2 or 3.
    expect(result.attempt.currentStacks.T1).toEqual([3, 2]);
    expect(result.attempt.currentStacks.T3).toEqual([1]);
  });

  // --- Timer contract ---------------------------------------------------

  it("timer is null before any legal move", async () => {
    const repo = new InMemoryTowersRepository();
    const attempt = await startScenario1(repo);
    expect(attempt.startedAt).toBeNull();
  });

  it("an illegal move attempt does not start the timer", async () => {
    const repo = new InMemoryTowersRepository();
    const attempt = await startScenario1(repo);
    await expect(
      applyMove(repo, { attemptId: attempt.attemptId, fromTowerId: "T2", toTowerId: "T3", idempotencyKey: key() })
    ).rejects.toBeInstanceOf(TowersIllegalMoveError);
    const reloaded = await getAttempt(repo, attempt.attemptId);
    expect(reloaded.startedAt).toBeNull();
  });

  it("the first accepted legal move sets startedAt, and it remains stable thereafter", async () => {
    const repo = new InMemoryTowersRepository();
    const attempt = await startScenario1(repo);
    const first = await applyMove(repo, { attemptId: attempt.attemptId, fromTowerId: "T1", toTowerId: "T3", idempotencyKey: key() });
    expect(first.attempt.startedAt).not.toBeNull();
    const startedAt = first.attempt.startedAt;

    const second = await applyMove(repo, { attemptId: attempt.attemptId, fromTowerId: "T1", toTowerId: "T2", idempotencyKey: key() });
    expect(second.attempt.startedAt).toBe(startedAt);
  });

  // --- Completion contract -----------------------------------------------

  it("completes only when every piece sits on the destination tower in valid order and all other towers are empty", async () => {
    const scenario: TowersScenario = {
      scenarioId: "test-mid", scenarioVersion: 1, towerIds: ["T1", "T2", "T3"],
      initialStacks: { T1: [2, 1], T2: [], T3: [] }, destinationTowerId: "T3", knownMinimumMoves: 3,
    };
    // Partial state: not complete (piece remains off destination).
    expect(isComplete(scenario, { T1: [2], T2: [], T3: [1] })).toBe(false);
    // Full valid completion.
    expect(isComplete(scenario, { T1: [], T2: [], T3: [2, 1] })).toBe(true);
  });

  it("Scenario 1 (classic minimal, 3 pieces) reaches COMPLETE via its verified 7-move solution", async () => {
    const repo = new InMemoryTowersRepository();
    const attempt = await startScenario1(repo);
    const last = await playSolution(repo, attempt.attemptId, SCENARIO_1_SOLUTION);
    expect(last.completed).toBe(true);
    expect(last.attempt.outcome).toBe("COMPLETE");
    expect(last.attempt.moveCount).toBe(7);
    expect(last.attempt.currentStacks.T3).toEqual([3, 2, 1]);
    expect(last.attempt.completedAt).not.toBeNull();
  });

  it("Scenario 2 (classic deeper, 4 pieces) reaches COMPLETE via its verified 15-move solution", async () => {
    const repo = new InMemoryTowersRepository();
    const { attempt } = await startAttempt(repo, { scenarioId: "towers-002", scenarioVersion: 1 });
    const last = await playSolution(repo, attempt.attemptId, SCENARIO_2_SOLUTION);
    expect(last.completed).toBe(true);
    expect(last.attempt.moveCount).toBe(15);
    expect(last.attempt.currentStacks.T3).toEqual([4, 3, 2, 1]);
  });

  it("Scenario 3 (split start across two non-destination towers) reaches COMPLETE via its verified 5-move solution", async () => {
    const repo = new InMemoryTowersRepository();
    const attempt = await startScenario3(repo);
    expect(attempt.currentStacks).toEqual({ T1: [3, 1], T2: [2], T3: [] });
    const last = await playSolution(repo, attempt.attemptId, SCENARIO_3_SOLUTION);
    expect(last.completed).toBe(true);
    expect(last.attempt.moveCount).toBe(5);
    expect(last.attempt.currentStacks.T3).toEqual([3, 2, 1]);
  });

  // --- Undo contract -------------------------------------------------

  it("single-step Undo reverses exactly the immediately preceding move", async () => {
    const repo = new InMemoryTowersRepository();
    const attempt = await startScenario1(repo);
    await applyMove(repo, { attemptId: attempt.attemptId, fromTowerId: "T1", toTowerId: "T3", idempotencyKey: key() });
    const undone = await undoMove(repo, { attemptId: attempt.attemptId, idempotencyKey: key() });
    expect(undone.attempt.currentStacks).toEqual({ T1: [3, 2, 1], T2: [], T3: [] });
    expect(undone.attempt.undoCount).toBe(1);
  });

  it("rejects a second consecutive Undo with no intervening move", async () => {
    const repo = new InMemoryTowersRepository();
    const attempt = await startScenario1(repo);
    await applyMove(repo, { attemptId: attempt.attemptId, fromTowerId: "T1", toTowerId: "T3", idempotencyKey: key() });
    await undoMove(repo, { attemptId: attempt.attemptId, idempotencyKey: key() });
    await expect(undoMove(repo, { attemptId: attempt.attemptId, idempotencyKey: key() })).rejects.toBeInstanceOf(TowersNothingToUndoError);
  });

  it("rejects Undo before any move has ever been made", async () => {
    const repo = new InMemoryTowersRepository();
    const attempt = await startScenario1(repo);
    await expect(undoMove(repo, { attemptId: attempt.attemptId, idempotencyKey: key() })).rejects.toBeInstanceOf(TowersNothingToUndoError);
  });

  it("rejects Undo after the attempt has completed", async () => {
    const repo = new InMemoryTowersRepository();
    const attempt = await startScenario1(repo);
    await playSolution(repo, attempt.attemptId, SCENARIO_1_SOLUTION);
    await expect(undoMove(repo, { attemptId: attempt.attemptId, idempotencyKey: key() })).rejects.toBeInstanceOf(TowersAttemptNotInProgressError);
  });

  // --- Restart contract ------------------------------------------------

  it("Restart from IN_PROGRESS abandons the predecessor and creates a fresh successor", async () => {
    const repo = new InMemoryTowersRepository();
    const attempt = await startScenario1(repo);
    await applyMove(repo, { attemptId: attempt.attemptId, fromTowerId: "T1", toTowerId: "T3", idempotencyKey: key() });

    const restarted = await restartAttempt(repo, { attemptId: attempt.attemptId, idempotencyKey: key() });
    expect(restarted.newAttempt.restartOfAttemptId).toBe(attempt.attemptId);
    expect(restarted.newAttempt.currentStacks).toEqual({ T1: [3, 2, 1], T2: [], T3: [] });
    expect(restarted.newAttempt.startedAt).toBeNull();
    expect(restarted.newAttempt.moveCount).toBe(0);

    const oldAfter = await getAttempt(repo, attempt.attemptId);
    expect(oldAfter.outcome).toBe("ABANDONED");
  });

  it("Restart from COMPLETE preserves the predecessor as COMPLETE (not ABANDONED)", async () => {
    const repo = new InMemoryTowersRepository();
    const attempt = await startScenario1(repo);
    await playSolution(repo, attempt.attemptId, SCENARIO_1_SOLUTION);

    const restarted = await restartAttempt(repo, { attemptId: attempt.attemptId, idempotencyKey: key() });
    const oldAfter = await getAttempt(repo, attempt.attemptId);
    expect(oldAfter.outcome).toBe("COMPLETE");
    expect(restarted.newAttempt.outcome).toBe("IN_PROGRESS");
  });

  it("Restart is idempotent: a repeated idempotencyKey returns the same successor rather than creating a second one", async () => {
    const repo = new InMemoryTowersRepository();
    const attempt = await startScenario1(repo);
    const dupeKey = key();
    const first = await restartAttempt(repo, { attemptId: attempt.attemptId, idempotencyKey: dupeKey });
    const second = await restartAttempt(repo, { attemptId: attempt.attemptId, idempotencyKey: dupeKey });
    expect(second.newAttempt.attemptId).toBe(first.newAttempt.attemptId);
    expect(second.alreadyRestarted).toBe(true);
  });

  // --- Idempotency --------------------------------------------------

  it("MOVE idempotency: a repeated idempotencyKey returns the same result rather than double-applying", async () => {
    const repo = new InMemoryTowersRepository();
    const attempt = await startScenario1(repo);
    const dupeKey = key();
    const first = await applyMove(repo, { attemptId: attempt.attemptId, fromTowerId: "T1", toTowerId: "T3", idempotencyKey: dupeKey });
    expect(first.alreadyApplied).toBe(false);
    const dupe = await applyMove(repo, { attemptId: attempt.attemptId, fromTowerId: "T1", toTowerId: "T3", idempotencyKey: dupeKey });
    expect(dupe.alreadyApplied).toBe(true);
    expect(dupe.attempt.moveCount).toBe(1);
    expect(dupe.attempt.currentStacks).toEqual(first.attempt.currentStacks);
  });

  it("MOVE idempotency survives a retry of the exact move that completed the attempt (regression: idempotency must be checked before re-validation, not after)", async () => {
    const repo = new InMemoryTowersRepository();
    const attempt = await startScenario1(repo);
    const finalKey = key();
    // Play the first 6 moves of the verified solution normally.
    for (const [fromTowerId, toTowerId] of SCENARIO_1_SOLUTION.slice(0, 6)) {
      await applyMove(repo, { attemptId: attempt.attemptId, fromTowerId, toTowerId, idempotencyKey: key() });
    }
    const [fromTowerId, toTowerId] = SCENARIO_1_SOLUTION[6];
    const first = await applyMove(repo, { attemptId: attempt.attemptId, fromTowerId, toTowerId, idempotencyKey: finalKey });
    expect(first.completed).toBe(true);
    expect(first.alreadyApplied).toBe(false);

    // Retry with the SAME idempotencyKey against the now-COMPLETE
    // attempt. Before the fix, this re-validated fromTowerId/toTowerId
    // against the (now empty) source tower and threw instead of
    // returning the cached completion result.
    const retry = await applyMove(repo, { attemptId: attempt.attemptId, fromTowerId, toTowerId, idempotencyKey: finalKey });
    expect(retry.alreadyApplied).toBe(true);
    expect(retry.completed).toBe(true);
    expect(retry.attempt.outcome).toBe("COMPLETE");
    expect(retry.attempt.currentStacks).toEqual(first.attempt.currentStacks);
  });

  it("UNDO idempotency: a repeated idempotencyKey returns the same result rather than double-undoing", async () => {
    const repo = new InMemoryTowersRepository();
    const attempt = await startScenario1(repo);
    await applyMove(repo, { attemptId: attempt.attemptId, fromTowerId: "T1", toTowerId: "T3", idempotencyKey: key() });
    const dupeKey = key();
    const first = await undoMove(repo, { attemptId: attempt.attemptId, idempotencyKey: dupeKey });
    expect(first.alreadyApplied).toBe(false);
    const dupe = await undoMove(repo, { attemptId: attempt.attemptId, idempotencyKey: dupeKey });
    expect(dupe.alreadyApplied).toBe(true);
    expect(dupe.attempt.undoCount).toBe(1);
  });

  // --- Truthful rejection on nonexistent/completed attempts ----------

  it("rejects every mutation against a nonexistent attemptId", async () => {
    const repo = new InMemoryTowersRepository();
    await expect(
      applyMove(repo, { attemptId: "does-not-exist", fromTowerId: "T1", toTowerId: "T3", idempotencyKey: key() })
    ).rejects.toBeInstanceOf(TowersAttemptNotFoundError);
    await expect(
      undoMove(repo, { attemptId: "does-not-exist", idempotencyKey: key() })
    ).rejects.toBeInstanceOf(TowersAttemptNotFoundError);
    await expect(
      restartAttempt(repo, { attemptId: "does-not-exist", idempotencyKey: key() })
    ).rejects.toBeInstanceOf(TowersAttemptNotFoundError);
    await expect(getAttempt(repo, "does-not-exist")).rejects.toBeInstanceOf(TowersAttemptNotFoundError);
  });

  it("rejects a MOVE against an attempt that has already completed", async () => {
    const repo = new InMemoryTowersRepository();
    const attempt = await startScenario1(repo);
    await playSolution(repo, attempt.attemptId, SCENARIO_1_SOLUTION);
    await expect(
      applyMove(repo, { attemptId: attempt.attemptId, fromTowerId: "T3", toTowerId: "T1", idempotencyKey: key() })
    ).rejects.toBeInstanceOf(TowersAttemptNotInProgressError);
  });

  // --- Deterministic replay -------------------------------------------

  it("action history replays deterministically: reload reconstructs identical state to the last committed result", async () => {
    const repo = new InMemoryTowersRepository();
    const attempt = await startScenario1(repo);
    await applyMove(repo, { attemptId: attempt.attemptId, fromTowerId: "T1", toTowerId: "T3", idempotencyKey: key() });
    const moved = await applyMove(repo, { attemptId: attempt.attemptId, fromTowerId: "T1", toTowerId: "T2", idempotencyKey: key() });
    const reloaded = await getAttempt(repo, attempt.attemptId);
    expect(reloaded.currentStacks).toEqual(moved.attempt.currentStacks);
    expect(reloaded.moveCount).toBe(moved.attempt.moveCount);
    expect(reloaded.actionHistory).toHaveLength(2);
    expect(reloaded.actionHistory.map((a) => a.type)).toEqual(["MOVE", "MOVE"]);
  });

  // --- Pure moveLogic edge cases (bespoke fixtures, not shipped scenarios) ---

  it("moveLogic: validateAndApplyMove never mutates its input stacks", () => {
    const scenario: TowersScenario = {
      scenarioId: "fixture", scenarioVersion: 1, towerIds: ["T1", "T2", "T3"],
      initialStacks: { T1: [2, 1], T2: [], T3: [] }, destinationTowerId: "T3", knownMinimumMoves: null,
    };
    const before = { T1: [2, 1], T2: [], T3: [] };
    const snapshot = JSON.stringify(before);
    validateAndApplyMove(scenario, before, "T1", "T2");
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it("moveLogic: a scenario with more than 3 towers is still validated correctly (schema supports it even though shipped content does not use it)", () => {
    const scenario: TowersScenario = {
      scenarioId: "fixture-4tower", scenarioVersion: 1, towerIds: ["T1", "T2", "T3", "T4"],
      initialStacks: { T1: [2, 1], T2: [], T3: [], T4: [] }, destinationTowerId: "T4", knownMinimumMoves: null,
    };
    const result = validateAndApplyMove(scenario, scenario.initialStacks, "T1", "T4");
    expect(result.legal).toBe(true);
    expect(result.resultingStacks?.T4).toEqual([1]);
  });
});
