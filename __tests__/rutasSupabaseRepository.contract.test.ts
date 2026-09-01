import { loadEnv } from "vite";
import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";

import { SupabaseRutasRepository } from "../lib/gaming/rutas/db/supabaseRutasRepository";
import { startAttempt } from "../lib/gaming/rutas/startAttempt";
import { applyMove } from "../lib/gaming/rutas/applyMove";
import { undoMove } from "../lib/gaming/rutas/undoMove";
import { restartAttempt } from "../lib/gaming/rutas/restartAttempt";
import { getAttempt } from "../lib/gaming/rutas/getAttempt";
import { RutasIllegalMoveError, RutasNothingToUndoError } from "../lib/gaming/rutas/types";

const env = loadEnv("development", process.cwd(), "");
const supabaseUrl = env.SUPABASE_URL;
const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for contract tests.");
}

const repo = new SupabaseRutasRepository(supabaseUrl, supabaseServiceRoleKey);
const cleanupClient = createClient(supabaseUrl, supabaseServiceRoleKey);

const createdAttemptIds: string[] = [];
let idCounter = 0;
function key(): string {
  idCounter += 1;
  return `contract-key-${idCounter}-${Date.now()}`;
}

afterAll(async () => {
  // Dependency order: rutas_attempt_actions references rutas_attempts
  // with on delete cascade, but delete explicitly anyway for clarity.
  // rutas_attempts also self-references via restart_of_attempt_id with
  // NO cascade (a predecessor must never be deletable out from under a
  // successor that still points at it) — so a predecessor pushed before
  // its successor cannot be deleted first. Delete attempts in REVERSE
  // push order (successors, which were always pushed after their
  // predecessor, are deleted before the predecessor they reference).
  for (const attemptId of createdAttemptIds) {
    await cleanupClient.from("rutas_attempt_actions").delete().eq("attempt_id", attemptId);
  }
  for (const attemptId of [...createdAttemptIds].reverse()) {
    await cleanupClient.from("rutas_attempts").delete().eq("attempt_id", attemptId);
  }
});

describe("SupabaseRutasRepository contract", () => {
  it("full attempt pipeline against real local Postgres: create, move, timer, reload, undo, restart", async () => {
    const { attempt: created } = await startAttempt(repo, { scenarioId: "rutas-001", scenarioVersion: 1 });
    createdAttemptIds.push(created.attemptId);

    expect(created.outcome).toBe("IN_PROGRESS");
    expect(created.startedAt).toBeNull();
    expect(created.currentPiecePositions.r1).toEqual({ col: 2, row: 2 });

    // Atomic MOVE persists and starts the timer on first legal move.
    const moved = await applyMove(repo, {
      attemptId: created.attemptId,
      pieceId: "r1",
      direction: "E",
      distance: 1,
      idempotencyKey: key(),
    });
    expect(moved.attempt.currentPiecePositions.r1).toEqual({ col: 3, row: 2 });
    expect(moved.attempt.startedAt).not.toBeNull();

    // Authoritative reload reconstructs identical state.
    const reloaded = await getAttempt(repo, created.attemptId);
    expect(reloaded.currentPiecePositions).toEqual(moved.attempt.currentPiecePositions);
    expect(reloaded.startedAt).toBe(moved.attempt.startedAt);
    expect(reloaded.actionHistory).toHaveLength(1);
    expect(reloaded.actionHistory[0].type).toBe("MOVE");

    // Idempotent duplicate MOVE (same key) does not double-apply.
    const dupeKey = key();
    const first = await applyMove(repo, { attemptId: created.attemptId, pieceId: "r1", direction: "W", distance: 1, idempotencyKey: dupeKey });
    expect(first.alreadyApplied).toBe(false);
    const dupe = await applyMove(repo, { attemptId: created.attemptId, pieceId: "r1", direction: "W", distance: 1, idempotencyKey: dupeKey });
    expect(dupe.alreadyApplied).toBe(true);
    expect(dupe.attempt.moveCount).toBe(2);
    expect(dupe.attempt.currentPiecePositions.r1).toEqual({ col: 2, row: 2 });

    // Blocked move is genuinely rejected against real Postgres validation.
    await expect(
      applyMove(repo, { attemptId: created.attemptId, pieceId: "r1", direction: "W", distance: 2, idempotencyKey: key() })
    ).rejects.toBeInstanceOf(RutasIllegalMoveError);

    // Undo persists correctly.
    const undone = await undoMove(repo, { attemptId: created.attemptId, idempotencyKey: key() });
    expect(undone.attempt.currentPiecePositions.r1).toEqual({ col: 3, row: 2 });
    expect(undone.attempt.undoCount).toBe(1);

    // Second consecutive Undo genuinely rejected by real Postgres.
    await expect(
      undoMove(repo, { attemptId: created.attemptId, idempotencyKey: key() })
    ).rejects.toBeInstanceOf(RutasNothingToUndoError);

    // Completion sets completedAt exactly once.
    const cleared = await applyMove(repo, { attemptId: created.attemptId, pieceId: "r1", direction: "E", distance: 2, idempotencyKey: key() });
    expect(cleared.completed).toBe(true);
    expect(cleared.attempt.completedAt).not.toBeNull();
    const afterComplete = await getAttempt(repo, created.attemptId);
    expect(afterComplete.outcome).toBe("COMPLETE");
    expect(afterComplete.completedAt).toBe(cleared.attempt.completedAt);

    // Restart linkage/preservation.
    const restarted = await restartAttempt(repo, { attemptId: created.attemptId, idempotencyKey: key() });
    createdAttemptIds.push(restarted.newAttempt.attemptId);
    expect(restarted.newAttempt.restartOfAttemptId).toBe(created.attemptId);
    expect(restarted.newAttempt.currentPiecePositions.r1).toEqual({ col: 2, row: 2 });

    const oldAfterRestart = await getAttempt(repo, created.attemptId);
    // Was already COMPLETE before restart — stays COMPLETE, not ABANDONED.
    expect(oldAfterRestart.outcome).toBe("COMPLETE");
  });

  it("rectangular footprint (1x2) and multi-position gate span persist correctly against real Postgres", async () => {
    const { attempt: created } = await startAttempt(repo, { scenarioId: "rutas-002", scenarioVersion: 1 });
    createdAttemptIds.push(created.attemptId);

    const result = await applyMove(repo, {
      attemptId: created.attemptId,
      pieceId: "r2",
      direction: "E",
      distance: 3,
      idempotencyKey: key(),
    });
    expect(result.cleared).toBe(true);
    expect(result.completed).toBe(true);
    expect(result.attempt.currentPiecePositions.r2).toBe("CLEARED");
  });

  it("a fresh IN_PROGRESS attempt that abandons via Restart is correctly marked ABANDONED, not COMPLETE", async () => {
    const { attempt: created } = await startAttempt(repo, { scenarioId: "rutas-001", scenarioVersion: 1 });
    createdAttemptIds.push(created.attemptId);
    await applyMove(repo, { attemptId: created.attemptId, pieceId: "r1", direction: "E", distance: 1, idempotencyKey: key() });

    const restarted = await restartAttempt(repo, { attemptId: created.attemptId, idempotencyKey: key() });
    createdAttemptIds.push(restarted.newAttempt.attemptId);

    const oldAfterRestart = await getAttempt(repo, created.attemptId);
    expect(oldAfterRestart.outcome).toBe("ABANDONED");
  });
});
