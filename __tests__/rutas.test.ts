import { describe, expect, it } from "vitest";

import { InMemoryRutasRepository } from "../lib/gaming/rutas/db/inMemoryRutasRepository";
import { startAttempt } from "../lib/gaming/rutas/startAttempt";
import { applyMove } from "../lib/gaming/rutas/applyMove";
import { undoMove } from "../lib/gaming/rutas/undoMove";
import { restartAttempt } from "../lib/gaming/rutas/restartAttempt";
import { getAttempt } from "../lib/gaming/rutas/getAttempt";
import { validateAndApplyMove } from "../lib/gaming/rutas/geometry";
import type { RutasScenario } from "../lib/gaming/rutas/types";
import {
  RutasAttemptNotFoundError,
  RutasAttemptNotInProgressError,
  RutasIllegalMoveError,
  RutasNothingToUndoError,
} from "../lib/gaming/rutas/types";

let idCounter = 0;
function key(): string {
  idCounter += 1;
  return `test-key-${idCounter}`;
}

async function startScenario1(repo: InMemoryRutasRepository) {
  const { attempt } = await startAttempt(repo, { scenarioId: "rutas-001", scenarioVersion: 1 });
  return attempt;
}

async function startScenario2(repo: InMemoryRutasRepository) {
  const { attempt } = await startAttempt(repo, { scenarioId: "rutas-002", scenarioVersion: 1 });
  return attempt;
}

describe("URBANO Rutas Slice 001", () => {
  it("legal moves N/S/E/W each move the piece the requested distance", async () => {
    const repo = new InMemoryRutasRepository();
    const attempt = await startScenario1(repo);

    // r1 starts at (2,2). Move E by 1 -> (3,2).
    const east = await applyMove(repo, {
      attemptId: attempt.attemptId,
      pieceId: "r1",
      direction: "E",
      distance: 1,
      idempotencyKey: key(),
    });
    expect(east.attempt.currentPiecePositions.r1).toEqual({ col: 3, row: 2 });

    // Move N by 1 -> (3,1).
    const north = await applyMove(repo, {
      attemptId: attempt.attemptId,
      pieceId: "r1",
      direction: "N",
      distance: 1,
      idempotencyKey: key(),
    });
    expect(north.attempt.currentPiecePositions.r1).toEqual({ col: 3, row: 1 });

    // Move W by 1 -> (2,1).
    const west = await applyMove(repo, {
      attemptId: attempt.attemptId,
      pieceId: "r1",
      direction: "W",
      distance: 1,
      idempotencyKey: key(),
    });
    expect(west.attempt.currentPiecePositions.r1).toEqual({ col: 2, row: 1 });

    // Move S by 1 -> (2,2), back to start.
    const south = await applyMove(repo, {
      attemptId: attempt.attemptId,
      pieceId: "r1",
      direction: "S",
      distance: 1,
      idempotencyKey: key(),
    });
    expect(south.attempt.currentPiecePositions.r1).toEqual({ col: 2, row: 2 });
  });

  it("free partial-distance movement: the player may rest short of the maximum legal distance", async () => {
    const repo = new InMemoryRutasRepository();
    const attempt = await startScenario1(repo);

    const result = await applyMove(repo, {
      attemptId: attempt.attemptId,
      pieceId: "r1",
      direction: "E",
      distance: 1,
      idempotencyKey: key(),
    });
    expect(result.attempt.currentPiecePositions.r1).toEqual({ col: 3, row: 2 });
    expect(result.cleared).toBe(false);
    expect(result.completed).toBe(false);
  });

  it("maximum-distance move clears the piece through its compatible exit", async () => {
    const repo = new InMemoryRutasRepository();
    const attempt = await startScenario1(repo);

    const result = await applyMove(repo, {
      attemptId: attempt.attemptId,
      pieceId: "r1",
      direction: "E",
      distance: 3,
      idempotencyKey: key(),
    });
    expect(result.cleared).toBe(true);
    expect(result.completed).toBe(true);
    expect(result.attempt.currentPiecePositions.r1).toBe("CLEARED");
    expect(result.attempt.outcome).toBe("COMPLETE");
  });

  it("two valid move orderings reach the same solution: partial-then-finish equals direct-to-exit", async () => {
    const repo = new InMemoryRutasRepository();

    // Ordering A: one direct move.
    const attemptA = await startScenario1(repo);
    const direct = await applyMove(repo, {
      attemptId: attemptA.attemptId,
      pieceId: "r1",
      direction: "E",
      distance: 3,
      idempotencyKey: key(),
    });
    expect(direct.completed).toBe(true);

    // Ordering B: partial, then finish.
    const attemptB = await startScenario1(repo);
    const partial = await applyMove(repo, {
      attemptId: attemptB.attemptId,
      pieceId: "r1",
      direction: "E",
      distance: 1,
      idempotencyKey: key(),
    });
    expect(partial.completed).toBe(false);
    const finish = await applyMove(repo, {
      attemptId: attemptB.attemptId,
      pieceId: "r1",
      direction: "E",
      distance: 2,
      idempotencyKey: key(),
    });
    expect(finish.completed).toBe(true);
  });

  it("rectangular footprint (1x2) sweeps both cells and moves as one rigid unit", async () => {
    const repo = new InMemoryRutasRepository();
    const attempt = await startScenario2(repo);

    // r2 starts anchored at (1,1), footprint 1x2 -> occupies (1,1) and (1,2).
    const result = await applyMove(repo, {
      attemptId: attempt.attemptId,
      pieceId: "r2",
      direction: "E",
      distance: 1,
      idempotencyKey: key(),
    });
    expect(result.attempt.currentPiecePositions.r2).toEqual({ col: 2, row: 1 });
  });

  it("an absurdly large distance is rejected as a sanity bound, not silently treated as a legal clear", async () => {
    // Found during the Final Local Acceptance gate's client-tampering
    // pressure test: distance values with no upper bound would force
    // validateAndApplyMove's loop to run that many synchronous
    // iterations. A moderately-oversized distance (99, far beyond the
    // 5x5 board's own span) is semantically harmless to reject outright.
    const repo = new InMemoryRutasRepository();
    const attempt = await startScenario1(repo);
    await expect(
      applyMove(repo, {
        attemptId: attempt.attemptId,
        pieceId: "r1",
        direction: "E",
        distance: 99,
        idempotencyKey: key(),
      })
    ).rejects.toBeInstanceOf(RutasIllegalMoveError);
  });

  it("mid-path collision: a blocker limits legal travel distance", async () => {
    const repo = new InMemoryRutasRepository();
    const attempt = await startScenario1(repo);

    // b1 sits at (0,2). r1 at (2,2) moving W: distance 1 -> (1,2) legal, distance 2 -> blocked by b1.
    await expect(
      applyMove(repo, {
        attemptId: attempt.attemptId,
        pieceId: "r1",
        direction: "W",
        distance: 2,
        idempotencyKey: key(),
      })
    ).rejects.toBeInstanceOf(RutasIllegalMoveError);

    const legal = await applyMove(repo, {
      attemptId: attempt.attemptId,
      pieceId: "r1",
      direction: "W",
      distance: 1,
      idempotencyKey: key(),
    });
    expect(legal.attempt.currentPiecePositions.r1).toEqual({ col: 1, row: 2 });
  });

  it("incompatible edge exit is rejected even though the cell is otherwise off-board-reachable", async () => {
    const repo = new InMemoryRutasRepository();
    const attempt = await startScenario1(repo);

    // South edge at col 2 has a SAPPHIRE gate, but r1 is RUBY.
    await expect(
      applyMove(repo, {
        attemptId: attempt.attemptId,
        pieceId: "r1",
        direction: "S",
        distance: 3,
        idempotencyKey: key(),
      })
    ).rejects.toBeInstanceOf(RutasIllegalMoveError);
  });

  it("full multi-cell gate-span is required to clear scenario 2's height-2 footprint (both row positions present)", async () => {
    const repo = new InMemoryRutasRepository();
    const attempt = await startScenario2(repo);
    const result = await applyMove(repo, {
      attemptId: attempt.attemptId,
      pieceId: "r2",
      direction: "E",
      distance: 3,
      idempotencyKey: key(),
    });
    expect(result.cleared).toBe(true);
    expect(result.attempt.currentPiecePositions.r2).toBe("CLEARED");
  });

  it("only one of two required gate positions present: a height-2 footprint cannot exit through a partial span", () => {
    const scenario: RutasScenario = {
      scenarioId: "test-partial-span",
      scenarioVersion: 1,
      boardWidth: 4,
      boardHeight: 4,
      pieces: [
        { pieceId: "p1", footprint: { width: 1, height: 2 }, startAnchor: { col: 1, row: 1 }, identity: "EMERALD", isRequired: true },
      ],
      gates: [
        // Only row 1 has a matching gate — row 2 (the piece's other
        // occupied row once it crosses) does not. The exit must be
        // rejected even though half the span matches.
        { gateId: "g1", edge: "E", position: 1, identity: "EMERALD" },
      ],
    };
    const result = validateAndApplyMove(
      scenario,
      { p1: { col: 1, row: 1 } },
      "p1",
      "E",
      3
    );
    expect(result.legal).toBe(false);
  });

  it("a footprint may never finish straddling the board boundary, even when the crossing cell's own gate matches", () => {
    // Width-2 piece moving East: at distance 3 its footprint spans one
    // on-board cell and one off-board cell (which has a matching gate)
    // — this must still be rejected because the OTHER cell of the same
    // rigid footprint is still on-board. At distance 4 the whole
    // footprint has crossed and both cells map to the same East-edge
    // row position (height 1), so a single gate is enough to clear.
    const scenario: RutasScenario = {
      scenarioId: "test-straddle",
      scenarioVersion: 1,
      boardWidth: 5,
      boardHeight: 5,
      pieces: [
        { pieceId: "p1", footprint: { width: 2, height: 1 }, startAnchor: { col: 1, row: 2 }, identity: "SAPPHIRE", isRequired: true },
      ],
      gates: [{ gateId: "g1", edge: "E", position: 2, identity: "SAPPHIRE" }],
    };
    const positions = { p1: { col: 1, row: 2 } };

    const straddled = validateAndApplyMove(scenario, positions, "p1", "E", 3);
    expect(straddled.legal).toBe(false);
    expect(straddled.reason).toContain("straddling");

    const cleared = validateAndApplyMove(scenario, positions, "p1", "E", 4);
    expect(cleared.legal).toBe(true);
    expect(cleared.cleared).toBe(true);
  });

  it("distance 3 in scenario 2 fully clears (both gate positions match) — the non-straddle exit path", async () => {
    const repo = new InMemoryRutasRepository();
    const attempt = await startScenario2(repo);
    const result = await applyMove(repo, {
      attemptId: attempt.attemptId,
      pieceId: "r2",
      direction: "E",
      distance: 3,
      idempotencyKey: key(),
    });
    expect(result.cleared).toBe(true);
  });

  it("completion occurs only once every required piece is cleared", async () => {
    const repo = new InMemoryRutasRepository();
    const { attempt } = await startAttempt(repo, { scenarioId: "rutas-003", scenarioVersion: 1 });

    const first = await applyMove(repo, {
      attemptId: attempt.attemptId,
      pieceId: "r3a",
      direction: "W",
      distance: 2,
      idempotencyKey: key(),
    });
    expect(first.cleared).toBe(true);
    expect(first.completed).toBe(false); // r3b still on board

    const second = await applyMove(repo, {
      attemptId: attempt.attemptId,
      pieceId: "r3b",
      direction: "E",
      distance: 2,
      idempotencyKey: key(),
    });
    expect(second.cleared).toBe(true);
    expect(second.completed).toBe(true);
  });

  it("non-required blockers may remain on the board after completion", async () => {
    const repo = new InMemoryRutasRepository();
    const attempt = await startScenario1(repo);

    const result = await applyMove(repo, {
      attemptId: attempt.attemptId,
      pieceId: "r1",
      direction: "E",
      distance: 3,
      idempotencyKey: key(),
    });
    expect(result.completed).toBe(true);
    expect(result.attempt.currentPiecePositions.b1).toEqual({ col: 0, row: 2 });
  });

  it("timer is null before the first legal MOVE", async () => {
    const repo = new InMemoryRutasRepository();
    const attempt = await startScenario1(repo);
    expect(attempt.startedAt).toBeNull();
  });

  it("timer starts on the first accepted legal MOVE", async () => {
    const repo = new InMemoryRutasRepository();
    const attempt = await startScenario1(repo);
    const result = await applyMove(repo, {
      attemptId: attempt.attemptId,
      pieceId: "r1",
      direction: "E",
      distance: 1,
      idempotencyKey: key(),
    });
    expect(result.attempt.startedAt).not.toBeNull();
  });

  it("an illegal move does not start the timer", async () => {
    const repo = new InMemoryRutasRepository();
    const attempt = await startScenario1(repo);
    await expect(
      applyMove(repo, {
        attemptId: attempt.attemptId,
        pieceId: "r1",
        direction: "W",
        distance: 5,
        idempotencyKey: key(),
      })
    ).rejects.toBeInstanceOf(RutasIllegalMoveError);
    const reloaded = await getAttempt(repo, attempt.attemptId);
    expect(reloaded.startedAt).toBeNull();
  });

  it("single Undo restores the immediately preceding position", async () => {
    const repo = new InMemoryRutasRepository();
    const attempt = await startScenario1(repo);
    await applyMove(repo, {
      attemptId: attempt.attemptId,
      pieceId: "r1",
      direction: "E",
      distance: 1,
      idempotencyKey: key(),
    });
    const undone = await undoMove(repo, { attemptId: attempt.attemptId, idempotencyKey: key() });
    expect(undone.attempt.currentPiecePositions.r1).toEqual({ col: 2, row: 2 });
    expect(undone.attempt.undoCount).toBe(1);
  });

  it("Undo may restore a previously cleared piece if that was the immediately preceding MOVE (and did not complete the attempt)", async () => {
    // Scenario 3 has two required pieces, so clearing r3a alone does not
    // complete the attempt — leaving room to Undo the clear itself,
    // unlike scenario 1 where clearing the sole required piece
    // simultaneously completes the attempt (Undo is correctly forbidden
    // after completion — see the dedicated "Undo after completion" test).
    const repo = new InMemoryRutasRepository();
    const { attempt } = await startAttempt(repo, { scenarioId: "rutas-003", scenarioVersion: 1 });
    const cleared = await applyMove(repo, {
      attemptId: attempt.attemptId,
      pieceId: "r3a",
      direction: "W",
      distance: 2,
      idempotencyKey: key(),
    });
    expect(cleared.attempt.currentPiecePositions.r3a).toBe("CLEARED");
    expect(cleared.completed).toBe(false);

    const undone = await undoMove(repo, { attemptId: attempt.attemptId, idempotencyKey: key() });
    expect(undone.attempt.currentPiecePositions.r3a).toEqual({ col: 1, row: 2 });
  });

  it("a second consecutive Undo without an intervening MOVE is rejected", async () => {
    const repo = new InMemoryRutasRepository();
    const attempt = await startScenario1(repo);
    await applyMove(repo, {
      attemptId: attempt.attemptId,
      pieceId: "r1",
      direction: "E",
      distance: 1,
      idempotencyKey: key(),
    });
    await undoMove(repo, { attemptId: attempt.attemptId, idempotencyKey: key() });
    await expect(
      undoMove(repo, { attemptId: attempt.attemptId, idempotencyKey: key() })
    ).rejects.toBeInstanceOf(RutasNothingToUndoError);
  });

  it("Undo with no prior MOVE at all is rejected", async () => {
    const repo = new InMemoryRutasRepository();
    const attempt = await startScenario1(repo);
    await expect(
      undoMove(repo, { attemptId: attempt.attemptId, idempotencyKey: key() })
    ).rejects.toBeInstanceOf(RutasNothingToUndoError);
  });

  it("Undo after completion is rejected", async () => {
    const repo = new InMemoryRutasRepository();
    const attempt = await startScenario1(repo);
    await applyMove(repo, {
      attemptId: attempt.attemptId,
      pieceId: "r1",
      direction: "E",
      distance: 3,
      idempotencyKey: key(),
    });
    await expect(
      undoMove(repo, { attemptId: attempt.attemptId, idempotencyKey: key() })
    ).rejects.toBeInstanceOf(RutasAttemptNotInProgressError);
  });

  it("Undo does not alter elapsed time (startedAt is unaffected)", async () => {
    const repo = new InMemoryRutasRepository();
    const attempt = await startScenario1(repo);
    const moved = await applyMove(repo, {
      attemptId: attempt.attemptId,
      pieceId: "r1",
      direction: "E",
      distance: 1,
      idempotencyKey: key(),
    });
    const undone = await undoMove(repo, { attemptId: attempt.attemptId, idempotencyKey: key() });
    expect(undone.attempt.startedAt).toBe(moved.attempt.startedAt);
  });

  it("Restart creates a new attempt with fresh state and no history", async () => {
    const repo = new InMemoryRutasRepository();
    const attempt = await startScenario1(repo);
    await applyMove(repo, {
      attemptId: attempt.attemptId,
      pieceId: "r1",
      direction: "E",
      distance: 1,
      idempotencyKey: key(),
    });

    const restarted = await restartAttempt(repo, { attemptId: attempt.attemptId, idempotencyKey: key() });
    expect(restarted.newAttempt.attemptId).not.toBe(attempt.attemptId);
    expect(restarted.newAttempt.currentPiecePositions.r1).toEqual({ col: 2, row: 2 });
    expect(restarted.newAttempt.actionHistory).toHaveLength(0);
    expect(restarted.newAttempt.startedAt).toBeNull();
    expect(restarted.newAttempt.restartOfAttemptId).toBe(attempt.attemptId);
  });

  it("the prior attempt becomes ABANDONED after Restart, and its history is preserved", async () => {
    const repo = new InMemoryRutasRepository();
    const attempt = await startScenario1(repo);
    await applyMove(repo, {
      attemptId: attempt.attemptId,
      pieceId: "r1",
      direction: "E",
      distance: 1,
      idempotencyKey: key(),
    });
    await restartAttempt(repo, { attemptId: attempt.attemptId, idempotencyKey: key() });

    const oldReloaded = await getAttempt(repo, attempt.attemptId);
    expect(oldReloaded.outcome).toBe("ABANDONED");
    expect(oldReloaded.actionHistory.length).toBeGreaterThanOrEqual(2); // MOVE + RESTART
  });

  it("Restart from a COMPLETE attempt leaves it COMPLETE, not ABANDONED", async () => {
    const repo = new InMemoryRutasRepository();
    const attempt = await startScenario1(repo);
    await applyMove(repo, {
      attemptId: attempt.attemptId,
      pieceId: "r1",
      direction: "E",
      distance: 3,
      idempotencyKey: key(),
    });
    await restartAttempt(repo, { attemptId: attempt.attemptId, idempotencyKey: key() });
    const oldReloaded = await getAttempt(repo, attempt.attemptId);
    expect(oldReloaded.outcome).toBe("COMPLETE");
  });

  it("replay determinism: the same scenario and same ordered moves always produce identical state", async () => {
    const repo = new InMemoryRutasRepository();

    const attemptA = await startScenario1(repo);
    await applyMove(repo, { attemptId: attemptA.attemptId, pieceId: "r1", direction: "W", distance: 1, idempotencyKey: key() });
    await applyMove(repo, { attemptId: attemptA.attemptId, pieceId: "r1", direction: "E", distance: 4, idempotencyKey: key() });
    const finalA = await getAttempt(repo, attemptA.attemptId);

    const attemptB = await startScenario1(repo);
    await applyMove(repo, { attemptId: attemptB.attemptId, pieceId: "r1", direction: "W", distance: 1, idempotencyKey: key() });
    await applyMove(repo, { attemptId: attemptB.attemptId, pieceId: "r1", direction: "E", distance: 4, idempotencyKey: key() });
    const finalB = await getAttempt(repo, attemptB.attemptId);

    expect(finalA.currentPiecePositions).toEqual(finalB.currentPiecePositions);
    expect(finalA.outcome).toBe(finalB.outcome);
  });

  it("a duplicate MOVE submission (same idempotencyKey) does not double-apply", async () => {
    const repo = new InMemoryRutasRepository();
    const attempt = await startScenario1(repo);
    const sharedKey = key();

    const first = await applyMove(repo, {
      attemptId: attempt.attemptId,
      pieceId: "r1",
      direction: "E",
      distance: 1,
      idempotencyKey: sharedKey,
    });
    expect(first.alreadyApplied).toBe(false);

    const second = await applyMove(repo, {
      attemptId: attempt.attemptId,
      pieceId: "r1",
      direction: "E",
      distance: 1,
      idempotencyKey: sharedKey,
    });
    expect(second.alreadyApplied).toBe(true);
    expect(second.attempt.moveCount).toBe(1);
    expect(second.attempt.currentPiecePositions.r1).toEqual({ col: 3, row: 2 });
  });

  it("a duplicate Undo submission (same idempotencyKey) does not double-undo", async () => {
    const repo = new InMemoryRutasRepository();
    const attempt = await startScenario1(repo);
    await applyMove(repo, { attemptId: attempt.attemptId, pieceId: "r1", direction: "E", distance: 1, idempotencyKey: key() });
    await applyMove(repo, { attemptId: attempt.attemptId, pieceId: "r1", direction: "E", distance: 1, idempotencyKey: key() });

    const sharedKey = key();
    const first = await undoMove(repo, { attemptId: attempt.attemptId, idempotencyKey: sharedKey });
    expect(first.alreadyApplied).toBe(false);
    expect(first.attempt.undoCount).toBe(1);

    const second = await undoMove(repo, { attemptId: attempt.attemptId, idempotencyKey: sharedKey });
    expect(second.alreadyApplied).toBe(true);
    expect(second.attempt.undoCount).toBe(1);
  });

  it("a duplicate Restart submission (same idempotencyKey) returns the same successor, not a second one", async () => {
    const repo = new InMemoryRutasRepository();
    const attempt = await startScenario1(repo);
    const sharedKey = key();

    const first = await restartAttempt(repo, { attemptId: attempt.attemptId, idempotencyKey: sharedKey });
    const second = await restartAttempt(repo, { attemptId: attempt.attemptId, idempotencyKey: sharedKey });

    expect(second.alreadyRestarted).toBe(true);
    expect(second.newAttempt.attemptId).toBe(first.newAttempt.attemptId);
  });

  it("a move against a nonexistent attempt is rejected", async () => {
    const repo = new InMemoryRutasRepository();
    await expect(
      applyMove(repo, {
        attemptId: "does-not-exist",
        pieceId: "r1",
        direction: "E",
        distance: 1,
        idempotencyKey: key(),
      })
    ).rejects.toBeInstanceOf(RutasAttemptNotFoundError);
  });

  it("a move against a completed attempt is rejected", async () => {
    const repo = new InMemoryRutasRepository();
    const attempt = await startScenario1(repo);
    await applyMove(repo, { attemptId: attempt.attemptId, pieceId: "r1", direction: "E", distance: 3, idempotencyKey: key() });
    await expect(
      applyMove(repo, { attemptId: attempt.attemptId, pieceId: "r1", direction: "W", distance: 1, idempotencyKey: key() })
    ).rejects.toBeInstanceOf(RutasAttemptNotInProgressError);
  });

  it("a move against an abandoned attempt is rejected", async () => {
    const repo = new InMemoryRutasRepository();
    const attempt = await startScenario1(repo);
    await restartAttempt(repo, { attemptId: attempt.attemptId, idempotencyKey: key() });
    await expect(
      applyMove(repo, { attemptId: attempt.attemptId, pieceId: "r1", direction: "E", distance: 1, idempotencyKey: key() })
    ).rejects.toBeInstanceOf(RutasAttemptNotInProgressError);
  });

  it("restarting an already-abandoned attempt is rejected", async () => {
    const repo = new InMemoryRutasRepository();
    const attempt = await startScenario1(repo);
    await restartAttempt(repo, { attemptId: attempt.attemptId, idempotencyKey: key() });
    await expect(
      restartAttempt(repo, { attemptId: attempt.attemptId, idempotencyKey: key() })
    ).rejects.toThrow();
  });
});
