import { randomUUID } from "crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import vm from "node:vm";
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";

// Hoisted by Vitest above every import in this file. Race has no shared
// HTTP-boundary module the way Competitions' httpAuth.ts does — every
// route constructs SupabaseRaceRepository directly — so this mock exists
// solely to prove, for the Race Availability Containment Gate's own
// disabled-mode coverage test below, that the repository is never even
// constructed when the guard blocks a request. It is a bare constructor
// spy, never given real method behavior, since the guard fires before
// any handler would ever call a method on it.
vi.mock("@/lib/gaming/race/db/supabaseRaceRepository", () => ({
  SupabaseRaceRepository: vi.fn(),
}));

import { SupabaseRaceRepository } from "../lib/gaming/race/db/supabaseRaceRepository";
import { normalizeRaceSchemaReady, isRaceSchemaReady, requireRaceSchemaReady } from "../lib/gaming/race/schemaAvailability";
import { InMemoryRaceRepository } from "../lib/gaming/race/db/inMemoryRaceRepository";
import { createEvent } from "../lib/gaming/race/createEvent";
import { joinEvent } from "../lib/gaming/race/joinEvent";
import { confirmReadiness } from "../lib/gaming/race/confirmReadiness";
import { applyRaceMove } from "../lib/gaming/race/applyMove";
import { undoRaceMove } from "../lib/gaming/race/undoMove";
import { requestRaceCancellation } from "../lib/gaming/race/requestCancellation";
import { getRaceEventProjection } from "../lib/gaming/race/getProjection";
import { isValidIdempotencyKey } from "../lib/gaming/race/idempotencyKey";
import { classifyRaceResponseStatus } from "../lib/gaming/race/httpResponseClassification";
import {
  RaceEventAlreadyTerminalError,
  RaceEventFullError,
  RaceEventNotFoundError,
  RaceIdempotencyKeyConflictError,
  RaceIllegalMoveError,
  RaceInvalidTokenError,
  RaceNotYetStartedError,
  RaceOrganizerCannotCancelAfterCountdownError,
} from "../lib/gaming/race/types";

// A real UUID, not a placeholder string — UG-CR-GATE-026 makes
// idempotency_key a `uuid`-typed database column (see
// supabase/migrations/20260904085836_create_race_events.sql), so this
// in-memory suite's own keys must satisfy the same shared contract the
// browser and the real database enforce, not merely be "any string".
function key(): string {
  return randomUUID();
}

// Same hand-verified optimal 7-move solution used by towers.test.ts.
const SCENARIO_1_SOLUTION: Array<[string, string]> = [
  ["T1", "T3"],
  ["T1", "T2"],
  ["T3", "T2"],
  ["T1", "T3"],
  ["T2", "T1"],
  ["T2", "T3"],
  ["T1", "T3"],
];

async function setUpReadyEvent(repo: InMemoryRaceRepository) {
  const created = await createEvent(repo, { idempotencyKey: key(), scenarioId: "towers-001", scenarioVersion: 1 });
  const a = await joinEvent(repo, { raceEventId: created.raceEventId, idempotencyKey: key() });
  const b = await joinEvent(repo, { raceEventId: created.raceEventId, idempotencyKey: key() });
  await confirmReadiness(repo, { raceEventId: created.raceEventId, competitorToken: a.competitorToken });
  const readyResult = await confirmReadiness(repo, {
    raceEventId: created.raceEventId,
    competitorToken: b.competitorToken,
  });
  return { created, a, b, sharedStartAt: readyResult.sharedStartAt! };
}

async function playToCompletion(
  repo: InMemoryRaceRepository,
  raceEventId: string,
  competitorToken: string,
  moves: Array<[string, string]> = SCENARIO_1_SOLUTION
) {
  let last;
  for (const [fromTowerId, toTowerId] of moves) {
    last = await applyRaceMove(repo, { raceEventId, competitorToken, fromTowerId, toTowerId, idempotencyKey: key() });
  }
  return last!;
}

describe("Race Slice 001 — event creation, joining, and slot rules", () => {
  it("creates an event and issues a private organizer token", async () => {
    const repo = new InMemoryRaceRepository();
    const created = await createEvent(repo, { idempotencyKey: key(), scenarioId: "towers-001", scenarioVersion: 1 });
    expect(created.raceEventId).toBeTruthy();
    expect(created.organizerToken).toBeTruthy();
    expect(created.organizerToken).not.toBe(created.raceEventId);
  });

  it("allows exactly two competitors to join, assigning slot A then B", async () => {
    const repo = new InMemoryRaceRepository();
    const created = await createEvent(repo, { idempotencyKey: key(), scenarioId: "towers-001", scenarioVersion: 1 });
    const a = await joinEvent(repo, { raceEventId: created.raceEventId, idempotencyKey: key() });
    const b = await joinEvent(repo, { raceEventId: created.raceEventId, idempotencyKey: key() });
    expect(a.competitorSlot).toBe("A");
    expect(b.competitorSlot).toBe("B");
    expect(a.competitorToken).not.toBe(b.competitorToken);
  });

  it("rejects a third join attempt once both slots are filled", async () => {
    const repo = new InMemoryRaceRepository();
    const created = await createEvent(repo, { idempotencyKey: key(), scenarioId: "towers-001", scenarioVersion: 1 });
    await joinEvent(repo, { raceEventId: created.raceEventId, idempotencyKey: key() });
    await joinEvent(repo, { raceEventId: created.raceEventId, idempotencyKey: key() });
    await expect(joinEvent(repo, { raceEventId: created.raceEventId, idempotencyKey: key() })).rejects.toThrow(RaceEventFullError);
  });

  it("allows the organizer to also occupy a competitor slot using a separate credential", async () => {
    const repo = new InMemoryRaceRepository();
    const created = await createEvent(repo, { idempotencyKey: key(), scenarioId: "towers-001", scenarioVersion: 1 });
    const asCompetitor = await joinEvent(repo, { raceEventId: created.raceEventId, idempotencyKey: key() });
    expect(asCompetitor.competitorToken).not.toBe(created.organizerToken);
    const projectionAsOrganizer = await getRaceEventProjection(repo, {
      raceEventId: created.raceEventId,
      callerToken: created.organizerToken,
    });
    expect(projectionAsOrganizer.you?.role).toBe("ORGANIZER");
    const projectionAsCompetitor = await getRaceEventProjection(repo, {
      raceEventId: created.raceEventId,
      callerToken: asCompetitor.competitorToken,
    });
    expect(projectionAsCompetitor.you?.role).toBe("COMPETITOR");
  });
});

describe("Race Slice 001 — durable idempotency (UG-CR-GATE-025 Correction A)", () => {
  it("a lost-response CREATE retry returns the same event and organizer token, never a second event", async () => {
    const repo = new InMemoryRaceRepository();
    const sharedKey = key();
    const first = await createEvent(repo, { idempotencyKey: sharedKey, scenarioId: "towers-001", scenarioVersion: 1 });
    const retry = await createEvent(repo, { idempotencyKey: sharedKey, scenarioId: "towers-001", scenarioVersion: 1 });
    expect(retry.raceEventId).toBe(first.raceEventId);
    expect(retry.organizerToken).toBe(first.organizerToken);
  });

  it("rejects a CREATE key reused with different scenario parameters", async () => {
    const repo = new InMemoryRaceRepository();
    const sharedKey = key();
    await createEvent(repo, { idempotencyKey: sharedKey, scenarioId: "towers-001", scenarioVersion: 1 });
    await expect(
      createEvent(repo, { idempotencyKey: sharedKey, scenarioId: "towers-002", scenarioVersion: 1 })
    ).rejects.toThrow(RaceIdempotencyKeyConflictError);
  });

  it("a lost-response JOIN retry returns the same slot and token, and never consumes the other slot", async () => {
    const repo = new InMemoryRaceRepository();
    const created = await createEvent(repo, { idempotencyKey: key(), scenarioId: "towers-001", scenarioVersion: 1 });
    const sharedKey = key();
    const first = await joinEvent(repo, { raceEventId: created.raceEventId, idempotencyKey: sharedKey });
    const retry = await joinEvent(repo, { raceEventId: created.raceEventId, idempotencyKey: sharedKey });
    expect(retry.competitorSlot).toBe(first.competitorSlot);
    expect(retry.competitorToken).toBe(first.competitorToken);

    const event = await repo.getEvent(created.raceEventId);
    expect(event!.competitorAToken).toBe(first.competitorToken);
    expect(event!.competitorBToken).toBeNull();
  });

  it("rejects a JOIN key reused for a different command", async () => {
    const repo = new InMemoryRaceRepository();
    const created = await createEvent(repo, { idempotencyKey: key(), scenarioId: "towers-001", scenarioVersion: 1 });
    const sharedKey = key();
    const a = await joinEvent(repo, { raceEventId: created.raceEventId, idempotencyKey: sharedKey });
    void a;
    await expect(
      requestRaceCancellation(repo, { raceEventId: created.raceEventId, callerToken: created.organizerToken, idempotencyKey: sharedKey })
    ).rejects.toThrow(RaceIdempotencyKeyConflictError);
  });

  it("READY retry does not recreate attempts or reschedule the countdown", async () => {
    const repo = new InMemoryRaceRepository();
    const created = await createEvent(repo, { idempotencyKey: key(), scenarioId: "towers-001", scenarioVersion: 1 });
    const a = await joinEvent(repo, { raceEventId: created.raceEventId, idempotencyKey: key() });
    const b = await joinEvent(repo, { raceEventId: created.raceEventId, idempotencyKey: key() });
    await confirmReadiness(repo, { raceEventId: created.raceEventId, competitorToken: a.competitorToken });
    const first = await confirmReadiness(repo, { raceEventId: created.raceEventId, competitorToken: b.competitorToken });

    const eventAfterFirst = await repo.getEvent(created.raceEventId);
    const attemptAAfterFirst = eventAfterFirst!.competitorAAttemptId;
    const attemptBAfterFirst = eventAfterFirst!.competitorBAttemptId;

    // Repeated delivery of B's own readiness confirmation.
    const retry = await confirmReadiness(repo, { raceEventId: created.raceEventId, competitorToken: b.competitorToken });
    expect(retry.sharedStartAt).toBe(first.sharedStartAt);

    const eventAfterRetry = await repo.getEvent(created.raceEventId);
    expect(eventAfterRetry!.competitorAAttemptId).toBe(attemptAAfterFirst);
    expect(eventAfterRetry!.competitorBAttemptId).toBe(attemptBAfterFirst);
  });

  it("an ordinary MOVE retry returns the original board/result without another Towers action", async () => {
    const repo = new InMemoryRaceRepository();
    const { created, a } = await setUpReadyEvent(repo);
    vi.useFakeTimers();
    vi.advanceTimersByTime(4000);
    try {
      const sharedKey = key();
      const first = await applyRaceMove(repo, {
        raceEventId: created.raceEventId,
        competitorToken: a.competitorToken,
        fromTowerId: "T1",
        toTowerId: "T3",
        idempotencyKey: sharedKey,
      });
      const retry = await applyRaceMove(repo, {
        raceEventId: created.raceEventId,
        competitorToken: a.competitorToken,
        fromTowerId: "T1",
        toTowerId: "T3",
        idempotencyKey: sharedKey,
      });
      expect(retry.alreadyApplied).toBe(true);
      expect(retry.moveCount).toBe(first.moveCount);
      expect(retry.currentStacks).toEqual(first.currentStacks);

      const board = await repo.getBoard((await repo.getEvent(created.raceEventId))!.competitorAAttemptId!);
      expect(board!.moveCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a MOVE key reused with a different payload", async () => {
    const repo = new InMemoryRaceRepository();
    const { created, a } = await setUpReadyEvent(repo);
    vi.useFakeTimers();
    vi.advanceTimersByTime(4000);
    try {
      const sharedKey = key();
      await applyRaceMove(repo, {
        raceEventId: created.raceEventId,
        competitorToken: a.competitorToken,
        fromTowerId: "T1",
        toTowerId: "T3",
        idempotencyKey: sharedKey,
      });
      await expect(
        applyRaceMove(repo, {
          raceEventId: created.raceEventId,
          competitorToken: a.competitorToken,
          fromTowerId: "T1",
          toTowerId: "T2",
          idempotencyKey: sharedKey,
        })
      ).rejects.toThrow(RaceIdempotencyKeyConflictError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects a MOVE key reused by a different caller", async () => {
    const repo = new InMemoryRaceRepository();
    const { created, a, b } = await setUpReadyEvent(repo);
    vi.useFakeTimers();
    vi.advanceTimersByTime(4000);
    try {
      const sharedKey = key();
      await applyRaceMove(repo, {
        raceEventId: created.raceEventId,
        competitorToken: a.competitorToken,
        fromTowerId: "T1",
        toTowerId: "T3",
        idempotencyKey: sharedKey,
      });
      await expect(
        applyRaceMove(repo, {
          raceEventId: created.raceEventId,
          competitorToken: b.competitorToken,
          fromTowerId: "T1",
          toTowerId: "T3",
          idempotencyKey: sharedKey,
        })
      ).rejects.toThrow(RaceIdempotencyKeyConflictError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("a completing-move retry after terminalization returns the original success, winner, board, and alreadyApplied — not a generic rejection", async () => {
    const repo = new InMemoryRaceRepository();
    const { created, a } = await setUpReadyEvent(repo);
    vi.useFakeTimers();
    vi.advanceTimersByTime(4000);
    try {
      const winningKey = key();
      const moves = SCENARIO_1_SOLUTION.slice(0, 6);
      for (const [fromTowerId, toTowerId] of moves) {
        await applyRaceMove(repo, { raceEventId: created.raceEventId, competitorToken: a.competitorToken, fromTowerId, toTowerId, idempotencyKey: key() });
      }
      const final = SCENARIO_1_SOLUTION[6];
      const first = await applyRaceMove(repo, {
        raceEventId: created.raceEventId,
        competitorToken: a.competitorToken,
        fromTowerId: final[0],
        toTowerId: final[1],
        idempotencyKey: winningKey,
      });
      expect(first.raceTerminalResolution).toBe("WON_LOST");
      expect(first.raceWinnerSlot).toBe("A");

      // Retry the EXACT winning move with the SAME key, now that the
      // event is terminal — must replay the original success, not a
      // generic RaceEventAlreadyTerminalError.
      const retry = await applyRaceMove(repo, {
        raceEventId: created.raceEventId,
        competitorToken: a.competitorToken,
        fromTowerId: final[0],
        toTowerId: final[1],
        idempotencyKey: winningKey,
      });
      expect(retry.alreadyApplied).toBe(true);
      expect(retry.raceTerminalResolution).toBe("WON_LOST");
      expect(retry.raceWinnerSlot).toBe("A");
      expect(retry.towersOutcome).toBe("COMPLETE");
      expect(retry.currentStacks).toEqual(first.currentStacks);
    } finally {
      vi.useRealTimers();
    }
  });

  it("an UNDO retry performs exactly one undo", async () => {
    const repo = new InMemoryRaceRepository();
    const { created, a } = await setUpReadyEvent(repo);
    vi.useFakeTimers();
    vi.advanceTimersByTime(4000);
    try {
      await applyRaceMove(repo, {
        raceEventId: created.raceEventId,
        competitorToken: a.competitorToken,
        fromTowerId: "T1",
        toTowerId: "T3",
        idempotencyKey: key(),
      });
      const undoKey = key();
      const first = await undoRaceMove(repo, { raceEventId: created.raceEventId, competitorToken: a.competitorToken, idempotencyKey: undoKey });
      const retry = await undoRaceMove(repo, { raceEventId: created.raceEventId, competitorToken: a.competitorToken, idempotencyKey: undoKey });
      expect(retry.alreadyApplied).toBe(true);
      expect(retry.undoCount).toBe(first.undoCount);

      const board = await repo.getBoard((await repo.getEvent(created.raceEventId))!.competitorAAttemptId!);
      expect(board!.undoCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancellation retries preserve one terminal result without duplicating evidence", async () => {
    const repo = new InMemoryRaceRepository();
    const created = await createEvent(repo, { idempotencyKey: key(), scenarioId: "towers-001", scenarioVersion: 1 });
    await joinEvent(repo, { raceEventId: created.raceEventId, idempotencyKey: key() });
    const cancelKey = key();
    const first = await requestRaceCancellation(repo, { raceEventId: created.raceEventId, callerToken: created.organizerToken, idempotencyKey: cancelKey });
    const retry = await requestRaceCancellation(repo, { raceEventId: created.raceEventId, callerToken: created.organizerToken, idempotencyKey: cancelKey });
    expect(retry).toEqual(first);
    expect(retry.terminalResolution).toBe("CANCELLED");
  });
});

describe("Race Slice 001 — credential isolation and cross-slot denial", () => {
  it("rejects a move using an unrecognized token", async () => {
    const repo = new InMemoryRaceRepository();
    const { created } = await setUpReadyEvent(repo);
    await expect(
      applyRaceMove(repo, {
        raceEventId: created.raceEventId,
        competitorToken: "not-a-real-token",
        fromTowerId: "T1",
        toTowerId: "T3",
        idempotencyKey: key(),
      })
    ).rejects.toThrow(RaceInvalidTokenError);
  });

  it("resolves the caller's slot from the token alone, never from a client-supplied slot claim", async () => {
    const repo = new InMemoryRaceRepository();
    const { created, a, b } = await setUpReadyEvent(repo);
    vi.useFakeTimers();
    vi.advanceTimersByTime(4000);
    try {
      const asA = await applyRaceMove(repo, {
        raceEventId: created.raceEventId,
        competitorToken: a.competitorToken,
        fromTowerId: "T1",
        toTowerId: "T3",
        idempotencyKey: key(),
      });
      const asB = await applyRaceMove(repo, {
        raceEventId: created.raceEventId,
        competitorToken: b.competitorToken,
        fromTowerId: "T1",
        toTowerId: "T3",
        idempotencyKey: key(),
      });
      expect(asA.currentStacks).toEqual(asB.currentStacks);
      expect(asA.moveCount).toBe(1);
      expect(asB.moveCount).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects the organizer token used as a competitor move credential", async () => {
    const repo = new InMemoryRaceRepository();
    const { created } = await setUpReadyEvent(repo);
    await expect(
      applyRaceMove(repo, {
        raceEventId: created.raceEventId,
        competitorToken: created.organizerToken,
        fromTowerId: "T1",
        toTowerId: "T3",
        idempotencyKey: key(),
      })
    ).rejects.toThrow(RaceInvalidTokenError);
  });

  it("never returns the opponent's board to a competitor's own projection", async () => {
    const repo = new InMemoryRaceRepository();
    const { created, a } = await setUpReadyEvent(repo);
    const projection = await getRaceEventProjection(repo, {
      raceEventId: created.raceEventId,
      callerToken: a.competitorToken,
    });
    expect(projection.you?.slot).toBe("A");
    expect(projection.you?.board).toBeTruthy();
    expect(Object.keys(projection)).not.toContain("opponentBoard");
  });
});

describe("Race Slice 001 — raw Towers attempt identity and all credentials stay absent from projections", () => {
  it("never serializes a raw attemptId anywhere in the projection JSON", async () => {
    const repo = new InMemoryRaceRepository();
    const { created, a } = await setUpReadyEvent(repo);
    const projection = await getRaceEventProjection(repo, {
      raceEventId: created.raceEventId,
      callerToken: a.competitorToken,
    });
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toMatch(/attemptId/i);
    expect(serialized).not.toMatch(/attempt_id/i);
  });

  it("never returns the opponent's own bearer token in a projection", async () => {
    const repo = new InMemoryRaceRepository();
    const { created, a, b } = await setUpReadyEvent(repo);
    const projection = await getRaceEventProjection(repo, {
      raceEventId: created.raceEventId,
      callerToken: a.competitorToken,
    });
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toContain(b.competitorToken);
    expect(serialized).not.toContain(created.organizerToken);
  });
});

describe("Race Slice 001 — shared start and pre-start rejection", () => {
  it("schedules one shared future start only once both competitors are ready", async () => {
    const repo = new InMemoryRaceRepository();
    const created = await createEvent(repo, { idempotencyKey: key(), scenarioId: "towers-001", scenarioVersion: 1 });
    const a = await joinEvent(repo, { raceEventId: created.raceEventId, idempotencyKey: key() });
    const b = await joinEvent(repo, { raceEventId: created.raceEventId, idempotencyKey: key() });

    const afterA = await confirmReadiness(repo, { raceEventId: created.raceEventId, competitorToken: a.competitorToken });
    expect(afterA.bothReady).toBe(false);
    expect(afterA.sharedStartAt).toBeNull();

    const afterB = await confirmReadiness(repo, { raceEventId: created.raceEventId, competitorToken: b.competitorToken });
    expect(afterB.bothReady).toBe(true);
    expect(afterB.sharedStartAt).toBeTruthy();
    expect(new Date(afterB.sharedStartAt!).getTime()).toBeGreaterThan(Date.now());
  });

  it("rejects a move submitted before the shared start time", async () => {
    const repo = new InMemoryRaceRepository();
    const { created, a } = await setUpReadyEvent(repo);
    await expect(
      applyRaceMove(repo, {
        raceEventId: created.raceEventId,
        competitorToken: a.competitorToken,
        fromTowerId: "T1",
        toTowerId: "T3",
        idempotencyKey: key(),
      })
    ).rejects.toThrow(RaceNotYetStartedError);
  });
});

describe("Race Slice 001 — move/undo preserve Towers rules and one official attempt", () => {
  it("rejects an illegal move using Towers' own unmodified legality rules", async () => {
    const repo = new InMemoryRaceRepository();
    const { created, a } = await setUpReadyEvent(repo);
    vi.useFakeTimers();
    vi.advanceTimersByTime(4000);
    try {
      await expect(
        applyRaceMove(repo, {
          raceEventId: created.raceEventId,
          competitorToken: a.competitorToken,
          fromTowerId: "T2",
          toTowerId: "T3",
          idempotencyKey: key(),
        })
      ).rejects.toThrow(RaceIllegalMoveError);
    } finally {
      vi.useRealTimers();
    }
  });

  it("plays a full legal solution through to completion and declares a winner", async () => {
    const repo = new InMemoryRaceRepository();
    const { created, a } = await setUpReadyEvent(repo);
    vi.useFakeTimers();
    vi.advanceTimersByTime(4000);
    let result;
    try {
      result = await playToCompletion(repo, created.raceEventId, a.competitorToken);
    } finally {
      vi.useRealTimers();
    }
    expect(result.towersOutcome).toBe("COMPLETE");
    expect(result.raceTerminalResolution).toBe("WON_LOST");
    expect(result.raceWinnerSlot).toBe("A");
  });

  it("undo reverses the competitor's own most recent move without pausing or resetting the race clock", async () => {
    const repo = new InMemoryRaceRepository();
    const { created, a, sharedStartAt } = await setUpReadyEvent(repo);
    vi.useFakeTimers();
    vi.advanceTimersByTime(4000);
    try {
      const afterMove = await applyRaceMove(repo, {
        raceEventId: created.raceEventId,
        competitorToken: a.competitorToken,
        fromTowerId: "T1",
        toTowerId: "T3",
        idempotencyKey: key(),
      });
      expect(afterMove.moveCount).toBe(1);

      const afterUndo = await undoRaceMove(repo, {
        raceEventId: created.raceEventId,
        competitorToken: a.competitorToken,
        idempotencyKey: key(),
      });
      expect(afterUndo.undoCount).toBe(1);
      expect(afterUndo.currentStacks).toEqual({ T1: [3, 2, 1], T2: [], T3: [] });

      const projection = await getRaceEventProjection(repo, { raceEventId: created.raceEventId, callerToken: null });
      expect(projection.sharedStartAt).toBe(sharedStartAt);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Race Slice 001 — post-terminal mutation is blocked and the loser's board is preserved", () => {
  it("rejects any further move once the Race has already terminalized, and the loser's own board is left untouched", async () => {
    const repo = new InMemoryRaceRepository();
    const { created, a, b } = await setUpReadyEvent(repo);
    vi.useFakeTimers();
    vi.advanceTimersByTime(4000);
    try {
      await playToCompletion(repo, created.raceEventId, a.competitorToken);

      await expect(
        applyRaceMove(repo, {
          raceEventId: created.raceEventId,
          competitorToken: b.competitorToken,
          fromTowerId: "T1",
          toTowerId: "T3",
          idempotencyKey: key(),
        })
      ).rejects.toThrow(RaceEventAlreadyTerminalError);

      const bProjection = await getRaceEventProjection(repo, {
        raceEventId: created.raceEventId,
        callerToken: b.competitorToken,
      });
      expect(bProjection.you?.board?.moveCount).toBe(0);
      expect(bProjection.you?.board?.outcome).toBe("IN_PROGRESS");
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Race Slice 001 — lazy expiry", () => {
  it("cancels without a winner when readiness expires before both competitors are ready", async () => {
    const repo = new InMemoryRaceRepository();
    const created = await createEvent(repo, { idempotencyKey: key(), scenarioId: "towers-001", scenarioVersion: 1 });
    const a = await joinEvent(repo, { raceEventId: created.raceEventId, idempotencyKey: key() });
    await joinEvent(repo, { raceEventId: created.raceEventId, idempotencyKey: key() });

    vi.useFakeTimers();
    vi.advanceTimersByTime(5 * 60 * 1000 + 1000);
    try {
      const result = await confirmReadiness(repo, { raceEventId: created.raceEventId, competitorToken: a.competitorToken });
      expect(result.terminalResolution).toBe("CANCELLED");
      const projection = await getRaceEventProjection(repo, { raceEventId: created.raceEventId, callerToken: null });
      expect(projection.terminalResolution).toBe("CANCELLED");
      expect(projection.winnerSlot).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it("resolves NO_CONTEST when neither competitor completes within the maximum duration", async () => {
    const repo = new InMemoryRaceRepository();
    const { created, a } = await setUpReadyEvent(repo);

    vi.useFakeTimers();
    vi.advanceTimersByTime(10 * 60 * 1000 + 10 * 1000);
    try {
      await expect(
        applyRaceMove(repo, {
          raceEventId: created.raceEventId,
          competitorToken: a.competitorToken,
          fromTowerId: "T1",
          toTowerId: "T3",
          idempotencyKey: key(),
        })
      ).rejects.toThrow(RaceEventAlreadyTerminalError);

      const projection = await getRaceEventProjection(repo, { raceEventId: created.raceEventId, callerToken: null });
      expect(projection.terminalResolution).toBe("NO_CONTEST");
      expect(projection.winnerSlot).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Race Slice 001 — cancellation authority", () => {
  it("lets the organizer cancel freely before the countdown is scheduled", async () => {
    const repo = new InMemoryRaceRepository();
    const created = await createEvent(repo, { idempotencyKey: key(), scenarioId: "towers-001", scenarioVersion: 1 });
    await joinEvent(repo, { raceEventId: created.raceEventId, idempotencyKey: key() });
    const result = await requestRaceCancellation(repo, { raceEventId: created.raceEventId, callerToken: created.organizerToken, idempotencyKey: key() });
    expect(result.terminalResolution).toBe("CANCELLED");
  });

  it("rejects a unilateral organizer cancellation once the countdown is scheduled", async () => {
    const repo = new InMemoryRaceRepository();
    const { created } = await setUpReadyEvent(repo);
    await expect(
      requestRaceCancellation(repo, { raceEventId: created.raceEventId, callerToken: created.organizerToken, idempotencyKey: key() })
    ).rejects.toThrow(RaceOrganizerCannotCancelAfterCountdownError);
  });

  it("requires both competitors' agreement to cancel once the countdown is scheduled", async () => {
    const repo = new InMemoryRaceRepository();
    const { created, a, b } = await setUpReadyEvent(repo);

    const afterA = await requestRaceCancellation(repo, { raceEventId: created.raceEventId, callerToken: a.competitorToken, idempotencyKey: key() });
    expect(afterA.cancelPending).toBe(true);
    expect(afterA.terminalResolution).toBeNull();

    const afterB = await requestRaceCancellation(repo, { raceEventId: created.raceEventId, callerToken: b.competitorToken, idempotencyKey: key() });
    expect(afterB.terminalResolution).toBe("CANCELLED");
  });
});

describe("Race Slice 001 — ordinary execution cannot produce a fabricated tie", () => {
  it("declares a definite winner (never a tie) on the first genuine completion", async () => {
    const repo = new InMemoryRaceRepository();
    const { created, a } = await setUpReadyEvent(repo);
    vi.useFakeTimers();
    vi.advanceTimersByTime(4000);
    try {
      const result = await playToCompletion(repo, created.raceEventId, a.competitorToken);
      expect(result.raceTerminalResolution).toBe("WON_LOST");
      expect(result.raceWinnerSlot).not.toBeNull();
      // 'TIE' is not even a member of RaceTerminalResolution any more —
      // this is enforced at the type level (see types.ts's own comment)
      // as well as behaviorally here.
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("Race Slice 001 — not-found handling", () => {
  it("throws RaceEventNotFoundError for an unknown race event id", async () => {
    const repo = new InMemoryRaceRepository();
    await expect(getRaceEventProjection(repo, { raceEventId: "00000000-0000-0000-0000-000000000000", callerToken: null })).rejects.toThrow(
      RaceEventNotFoundError
    );
  });
});

describe("Race Slice 001 — shared idempotency-key contract (UG-CR-GATE-026)", () => {
  it("accepts well-formed UUIDs of any case", () => {
    expect(isValidIdempotencyKey(randomUUID())).toBe(true);
    expect(isValidIdempotencyKey("F47AC10B-58CC-4372-A567-0E02B2C3D479")).toBe(true);
    expect(isValidIdempotencyKey("f47ac10b-58cc-4372-a567-0e02b2c3d479")).toBe(true);
  });

  it("rejects missing, empty, malformed, and oversized values", () => {
    expect(isValidIdempotencyKey(undefined)).toBe(false);
    expect(isValidIdempotencyKey(null)).toBe(false);
    expect(isValidIdempotencyKey("")).toBe(false);
    expect(isValidIdempotencyKey("not-a-uuid")).toBe(false);
    expect(isValidIdempotencyKey("test-key-1")).toBe(false);
    expect(isValidIdempotencyKey(randomUUID() + "x")).toBe(false);
    expect(isValidIdempotencyKey("x".repeat(500))).toBe(false);
    expect(isValidIdempotencyKey(12345)).toBe(false);
    expect(isValidIdempotencyKey({})).toBe(false);
  });
});

describe("Race Slice 001 — deliberate HTTP response classification (UG-CR-GATE-027 Defect 3)", () => {
  it("classifies network-unavailable/server-side outcomes as ambiguous: 5xx", () => {
    expect(classifyRaceResponseStatus(500)).toBe("ambiguous");
    expect(classifyRaceResponseStatus(502)).toBe("ambiguous");
    expect(classifyRaceResponseStatus(503)).toBe("ambiguous");
    expect(classifyRaceResponseStatus(599)).toBe("ambiguous");
  });

  it("classifies timeout and throttling as ambiguous, not definitive, even though both are 4xx", () => {
    expect(classifyRaceResponseStatus(408)).toBe("ambiguous");
    expect(classifyRaceResponseStatus(429)).toBe("ambiguous");
  });

  it("classifies validation, auth, not-found, illegal-move, stale-state, and idempotency-conflict as definite", () => {
    expect(classifyRaceResponseStatus(400)).toBe("definite");
    expect(classifyRaceResponseStatus(401)).toBe("definite");
    expect(classifyRaceResponseStatus(403)).toBe("definite");
    expect(classifyRaceResponseStatus(404)).toBe("definite");
    expect(classifyRaceResponseStatus(409)).toBe("definite");
    expect(classifyRaceResponseStatus(422)).toBe("definite");
  });
});

describe("Race production-availability guard (Race Availability Containment Gate)", () => {
  describe("normalizeRaceSchemaReady — the fail-closed truth table", () => {
    const cases: Array<[string, string | undefined, boolean]> = [
      ["undefined (the variable is absent)", undefined, false],
      ["empty string", "", false],
      ['"false"', "false", false],
      ['"true" — the only accepted value', "true", true],
      ["uppercase TRUE", "TRUE", false],
      ["leading space", " true", false],
      ["trailing space", "true ", false],
      ['numeric "1"', "1", false],
      ['"yes"', "yes", false],
      ["mixed case True", "True", false],
      ["an arbitrary malformed string", "enabled-please", false],
    ];
    it.each(cases)("%s -> %s", (_label, input, expected) => {
      expect(normalizeRaceSchemaReady(input)).toBe(expected);
    });
  });

  describe("isRaceSchemaReady / requireRaceSchemaReady — reading the real environment variable", () => {
    const ORIGINAL = process.env.RACE_SCHEMA_READY;
    afterEach(() => {
      if (ORIGINAL === undefined) delete process.env.RACE_SCHEMA_READY;
      else process.env.RACE_SCHEMA_READY = ORIGINAL;
    });

    it("missing variable returns a guard response with status 503", () => {
      delete process.env.RACE_SCHEMA_READY;
      expect(isRaceSchemaReady()).toBe(false);
      const res = requireRaceSchemaReady();
      expect(res).not.toBeNull();
      expect(res!.status).toBe(503);
    });

    it("empty value returns 503", () => {
      process.env.RACE_SCHEMA_READY = "";
      expect(requireRaceSchemaReady()!.status).toBe(503);
    });

    it('"false" returns 503', () => {
      process.env.RACE_SCHEMA_READY = "false";
      expect(requireRaceSchemaReady()!.status).toBe(503);
    });

    it("a malformed value returns 503", () => {
      process.env.RACE_SCHEMA_READY = "TRUE";
      expect(requireRaceSchemaReady()!.status).toBe(503);
    });

    it('only "true" enables execution — the guard returns null, not a response', () => {
      process.env.RACE_SCHEMA_READY = "true";
      expect(isRaceSchemaReady()).toBe(true);
      expect(requireRaceSchemaReady()).toBeNull();
    });

    it("the unavailable response carries exactly one field, a truthful non-sensitive message, and never a stack trace, relation name, migration number, or provider identifier", async () => {
      delete process.env.RACE_SCHEMA_READY;
      const res = requireRaceSchemaReady()!;
      const body = (await res.json()) as Record<string, unknown>;
      expect(Object.keys(body)).toEqual(["error"]);
      expect(body.error).toBe("URBANO Race is temporarily unavailable while its database is being prepared.");
      const text = JSON.stringify(body);
      expect(text).not.toMatch(/relation|does not exist|supabase|postgres|migration|race_events|race_functions|stack|at Object|at eval/i);
    });
  });

  describe("no readiness value is ever returned through /api/gaming/config or any other public config surface", () => {
    it("GET /api/gaming/config never mentions RACE_SCHEMA_READY, regardless of the variable's value", async () => {
      process.env.RACE_SCHEMA_READY = "true";
      process.env.SUPABASE_URL = "http://fake";
      process.env.SUPABASE_ANON_KEY = "fake-anon-key";
      const { GET } = await import("../app/api/gaming/config/route");
      const res = await GET();
      const body = (await res.json()) as Record<string, unknown>;
      expect(JSON.stringify(body)).not.toMatch(/RACE_SCHEMA_READY/i);
    });
  });

  describe("every Race route handler is guarded — structural coverage, not a source-text search", () => {
    // Discovers every app/api/gaming/race/**/route.ts file from the real
    // filesystem (never a hand-maintained list) and every param name from
    // the path itself (e.g. "[raceEventId]") — a future handler added
    // without this loop being updated is still discovered and still
    // tested; if it lacks the guard, the assertions below fail for real.
    function findRouteFiles(dir: string): string[] {
      let files: string[] = [];
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) files = files.concat(findRouteFiles(full));
        else if (entry === "route.ts") files.push(full);
      }
      return files;
    }

    const raceDir = join(process.cwd(), "app/api/gaming/race");
    const routeFiles = findRouteFiles(raceDir);
    const routeSpecifiers = routeFiles.map((f) => "../" + relative(process.cwd(), f).replace(/\.ts$/, ""));

    const ORIGINAL_READY = process.env.RACE_SCHEMA_READY;
    const ORIGINAL_URL = process.env.SUPABASE_URL;
    const ORIGINAL_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    beforeEach(() => {
      vi.clearAllMocks();
    });
    afterEach(() => {
      if (ORIGINAL_READY === undefined) delete process.env.RACE_SCHEMA_READY; else process.env.RACE_SCHEMA_READY = ORIGINAL_READY;
      if (ORIGINAL_URL === undefined) delete process.env.SUPABASE_URL; else process.env.SUPABASE_URL = ORIGINAL_URL;
      if (ORIGINAL_KEY === undefined) delete process.env.SUPABASE_SERVICE_ROLE_KEY; else process.env.SUPABASE_SERVICE_ROLE_KEY = ORIGINAL_KEY;
    });

    it("discovered exactly the 7 known route files (canary — bump this alongside the review if a route is genuinely added or removed)", () => {
      expect(routeFiles).toHaveLength(7);
    });

    it("with readiness disabled (and even with valid Supabase credentials present), every discovered handler returns 503 immediately, WITHOUT authenticating, parsing the request body, or constructing a repository", async () => {
      delete process.env.RACE_SCHEMA_READY;
      process.env.SUPABASE_URL = "http://fake";
      process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-role-key";
      let handlersTested = 0;

      for (const specifier of routeSpecifiers) {
        const mod = (await import(specifier)) as Record<string, unknown>;
        const paramNames = [...specifier.matchAll(/\[(\w+)\]/g)].map((m) => m[1]);
        const params = Object.fromEntries(paramNames.map((name) => [name, "test-id"]));

        for (const method of ["GET", "POST"] as const) {
          const handler = mod[method];
          if (typeof handler !== "function") continue;
          handlersTested += 1;
          vi.mocked(SupabaseRaceRepository).mockClear();

          // A deliberately UNPARSEABLE body and a bogus bearer token: if the
          // guard failed to run first, a POST handler would either hit
          // `request.json()` (producing a 400) or the auth-header check
          // (producing a 401), never a 503 — proving conclusively that
          // neither ever happened.
          const request = new Request("http://localhost/probe", {
            method,
            headers: { authorization: "Bearer bogus-token" },
            body: method === "POST" ? "not valid json {{{" : undefined,
          });

          const res = await (handler as (req: Request, ctx?: unknown) => Promise<Response>)(request, { params });

          expect(res.status, `${specifier} [${method}] should return 503 when readiness is disabled`).toBe(503);
          const body = (await res.json()) as Record<string, unknown>;
          expect(body.error, `${specifier} [${method}]`).toBe(
            "URBANO Race is temporarily unavailable while its database is being prepared."
          );
          expect(SupabaseRaceRepository, `${specifier} [${method}] must not construct a repository`).not.toHaveBeenCalled();
        }
      }

      expect(handlersTested).toBe(7);
    });

    it("with readiness enabled, no handler short-circuits with the guard's own 503 — each reaches its own pre-existing logic instead", async () => {
      process.env.RACE_SCHEMA_READY = "true";
      process.env.SUPABASE_URL = "http://fake";
      process.env.SUPABASE_SERVICE_ROLE_KEY = "fake-service-role-key";
      let handlersTested = 0;

      for (const specifier of routeSpecifiers) {
        const mod = (await import(specifier)) as Record<string, unknown>;
        const paramNames = [...specifier.matchAll(/\[(\w+)\]/g)].map((m) => m[1]);
        const params = Object.fromEntries(paramNames.map((name) => [name, "test-id"]));

        for (const method of ["GET", "POST"] as const) {
          const handler = mod[method];
          if (typeof handler !== "function") continue;
          handlersTested += 1;

          const request = new Request("http://localhost/probe", {
            method,
            headers: { authorization: "Bearer bogus-token" },
            body: method === "POST" ? "{}" : undefined,
          });

          const res = await (handler as (req: Request, ctx?: unknown) => Promise<Response>)(request, { params });
          expect(res.status, `${specifier} [${method}] must not be 503 once readiness is enabled`).not.toBe(503);
        }
      }

      expect(handlersTested).toBe(7);
    });
  });
});

describe("public/race.html — truthful unavailable state, no new retry loop (Race Availability Containment Gate)", () => {
  const html = readFileSync("public/race.html", "utf-8");

  it("refreshProjection checks err.status === 503 and routes it through setUnavailable (which shows the truthful banner), distinct from its own pre-existing silent-swallow for every other failure", () => {
    // Race Disabled-State UI and Polling Containment Correction relocated
    // the truthful-message rendering into the shared setUnavailable()
    // function (also used by checkAvailability's own probe path) — this
    // assertion follows that relocation rather than assuming the literal
    // message string still appears inline inside refreshProjection itself.
    const fnStart = html.indexOf("async function refreshProjection() {");
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = html.indexOf("\n}", html.indexOf("applyProjection(projection);", fnStart));
    const body = html.slice(fnStart, fnEnd);
    expect(body).toContain("err.status === 503");
    expect(body).toContain("setUnavailable(");
    expect(html).toContain(
      '"URBANO Race is temporarily unavailable while its database is being prepared."'
    );
  });

  it("the unavailable banner is only ever shown by setUnavailable when no mutation is currently in flight — it never fights an active operation's own banner", () => {
    const fnStart = html.indexOf("function setUnavailable(message) {");
    expect(fnStart).toBeGreaterThan(-1);
    const fnEnd = html.indexOf("\n}", fnStart);
    const body = html.slice(fnStart, fnEnd);
    expect(body).toContain("!operationInFlight");
  });

  it("does not introduce any new setInterval/setTimeout — exactly the 3 pre-existing timers remain (projection poll, countdown tick, remaining-time tick), none of them added or altered by this gate", () => {
    const intervalCalls = [...html.matchAll(/setInterval\(/g)];
    expect(intervalCalls).toHaveLength(3);
    expect(html).toContain("pollInterval = setInterval(refreshProjection, 1500);");
    expect(html).toContain("countdownInterval = setInterval(tick, 200);");
    expect(html).toContain("remainingInterval = setInterval(tick, 1000);");
  });

  it("classifyResponseStatus (client) and classifyRaceResponseStatus (server) are both left unmodified by this gate — 503 remains classified ambiguous, never redesigned into a new category", () => {
    expect(html).toContain("if (status >= 500) return \"ambiguous\";");
  });
});

describe("public/race.html — disabled-state UI and polling containment (Race Disabled-State UI and Polling Containment Correction)", () => {
  const raceHtml = readFileSync("public/race.html", "utf-8");

  /**
   * Extracts the page's inline <script> and strips its own trailing
   * `initializePage();` auto-invoke so each test controls invocation
   * timing explicitly (the production file's own auto-invoke line is
   * untouched — this only affects how the TEST harness loads the script).
   * Throws loudly if that exact marker ever moves, rather than silently
   * mis-loading a stale copy of the page's behavior.
   */
  function extractRaceScript(html: string): string {
    const scriptStart = html.indexOf("<script>") + "<script>".length;
    const scriptEnd = html.indexOf("</script>", scriptStart);
    const raw = html.slice(scriptStart, scriptEnd);
    const marker = "\ninitializePage();\n";
    const idx = raw.lastIndexOf(marker);
    if (idx === -1) {
      throw new Error(
        "race.html's trailing 'initializePage();' auto-invoke was not found where expected — update extractRaceScript."
      );
    }
    return raw.slice(0, idx) + "\n";
  }
  const RACE_SCRIPT_SOURCE = extractRaceScript(raceHtml);

  // --- A minimal, dependency-free fake DOM (Node's own vm module, no
  // jsdom/happy-dom) sufficient to actually EXECUTE race.html's script and
  // observe real behavior — element disabled/hidden state, real fetch call
  // counts, and real setInterval/clearInterval call counts — rather than
  // only inspecting the source text as the sibling describe block above
  // does. Behavioral counts (exact request counts, exact interval counts,
  // "no duplicate interval") are not reliably provable by text matching
  // alone, which is why this harness exists.
  class FakeClassList {
    private set = new Set<string>();
    add(c: string) { this.set.add(c); }
    remove(c: string) { this.set.delete(c); }
    toggle(c: string, force?: boolean) {
      const has = this.set.has(c);
      const next = force === undefined ? !has : force;
      if (next) this.set.add(c); else this.set.delete(c);
    }
    contains(c: string) { return this.set.has(c); }
  }

  class FakeElement {
    tagName: string;
    id = "";
    className = "";
    hidden = false;
    disabled = false;
    textContent = "";
    value = "";
    type = "";
    style: Record<string, string> = {};
    dataset: Record<string, string> = {};
    children: FakeElement[] = [];
    parentNode: FakeElement | null = null;
    classList = new FakeClassList();
    private attrs: Record<string, string> = {};
    private listeners: Record<string, Array<(evt: unknown) => void>> = {};
    private html = "";

    constructor(tag?: string) {
      this.tagName = (tag || "div").toUpperCase();
    }
    get innerHTML() { return this.html; }
    set innerHTML(v: string) { this.html = v; this.children = []; }
    setAttribute(name: string, value: unknown) { this.attrs[name] = String(value); }
    getAttribute(name: string) { return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null; }
    removeAttribute(name: string) { delete this.attrs[name]; }
    appendChild(child: FakeElement) { this.children.push(child); child.parentNode = this; return child; }
    addEventListener(type: string, handler: (evt: unknown) => void) {
      (this.listeners[type] = this.listeners[type] || []).push(handler);
    }
    removeEventListener(type: string, handler: (evt: unknown) => void) {
      if (!this.listeners[type]) return;
      this.listeners[type] = this.listeners[type].filter((h) => h !== handler);
    }
    dispatch(type: string, evt?: unknown) {
      (this.listeners[type] || []).forEach((h) => h(evt || {}));
    }
    /** Real browsers never fire click handlers on a disabled control — modeled here so a test that clicks a disabled button is a meaningful assertion, not a false pass. */
    click() {
      if (this.disabled) return;
      this.dispatch("click", { preventDefault() {} });
    }
  }

  function findDescendantById(root: FakeElement, id: string): FakeElement | null {
    for (const child of root.children) {
      if (child.id === id) return child;
      const found = findDescendantById(child, id);
      if (found) return found;
    }
    return null;
  }
  function findDescendantsByTextContent(root: FakeElement, text: string): FakeElement[] {
    const out: FakeElement[] = [];
    for (const child of root.children) {
      if (child.textContent === text) out.push(child);
      out.push(...findDescendantsByTextContent(child, text));
    }
    return out;
  }

  /** Bespoke fake timers, isolated from vitest's own global timer mocking — setInterval/clearInterval never actually schedule; tests advance them explicitly and can count calls precisely. */
  function makeFakeTimers() {
    let nextId = 1;
    const intervals = new Map<number, { fn: () => unknown }>();
    let setIntervalCallCount = 0;
    let clearIntervalCallCount = 0;
    return {
      setInterval: (fn: () => unknown, _ms: number) => {
        setIntervalCallCount += 1;
        const id = nextId++;
        intervals.set(id, { fn });
        return id;
      },
      clearInterval: (id: number) => {
        clearIntervalCallCount += 1;
        intervals.delete(id);
      },
      setTimeout: (fn: () => unknown, _ms: number) => nextId++,
      clearTimeout: (_id: number) => {},
      /** Fires every CURRENTLY registered interval's callback once per simulated 1500ms period contained in ms — sufficient for these tests, which only ever have the projection pollInterval running. */
      async advanceMs(ms: number) {
        const ticks = Math.floor(ms / 1500);
        for (let i = 0; i < ticks; i++) {
          for (const { fn } of Array.from(intervals.values())) {
            await fn();
          }
        }
      },
      get intervalCount() { return intervals.size; },
      get setIntervalCallCount() { return setIntervalCallCount; },
      get clearIntervalCallCount() { return clearIntervalCallCount; },
    };
  }

  function fakeResponse(status: number, body: unknown) {
    return { ok: status >= 200 && status < 300, status, json: async () => body };
  }
  function json503(message?: string) {
    return fakeResponse(503, { error: message || "URBANO Race is temporarily unavailable while its database is being prepared." });
  }
  function json404(message?: string) {
    return fakeResponse(404, { error: message || "Race event not found." });
  }
  function json200(body: Record<string, unknown>) {
    return fakeResponse(200, body);
  }
  function json201(body: Record<string, unknown>) {
    return fakeResponse(201, body);
  }

  const ELEMENT_DEFAULTS: Record<string, { tag: string; hidden?: boolean; disabled?: boolean }> = {
    "op-banner": { tag: "div", hidden: true },
    "landing-card": { tag: "div" },
    "setup-card": { tag: "div", hidden: true },
    "ready-card": { tag: "div", hidden: true },
    "countdown-card": { tag: "div", hidden: true },
    "game-card": { tag: "div", hidden: true },
    "scenario-picker": { tag: "div" },
    "btn-create": { tag: "button", disabled: true },
    "join-code-input": { tag: "input", disabled: true },
    "btn-join": { tag: "button", disabled: true },
    "event-id-display": { tag: "div" },
    "dot-a": { tag: "span" },
    "dot-b": { tag: "span" },
    "label-a": { tag: "span" },
    "label-b": { tag: "span" },
    "btn-organizer-join": { tag: "button" },
    "btn-organizer-cancel": { tag: "button" },
    "ready-heading": { tag: "div" },
    "ready-sub": { tag: "div" },
    "btn-ready": { tag: "button" },
    "countdown-value": { tag: "div" },
    "hud-moves": { tag: "span" },
    "hud-remaining": { tag: "span" },
    "hud-opponent": { tag: "span" },
    "board-wrap": { tag: "div" },
    "illegal-banner": { tag: "div" },
    "btn-undo": { tag: "button", disabled: true },
    "btn-live-cancel": { tag: "button" },
    "terminal-banner-live": { tag: "div", hidden: true },
  };

  function makeSessionStorage(seed?: Record<string, string>) {
    const store = new Map<string, string>(Object.entries(seed || {}));
    return {
      getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
      setItem: (k: string, v: string) => { store.set(k, String(v)); },
      removeItem: (k: string) => { store.delete(k); },
    };
  }

  function createRaceSandbox(opts: { fetchImpl?: (...args: unknown[]) => unknown; sessionStorageSeed?: Record<string, string> } = {}) {
    const timers = makeFakeTimers();
    const elements: Record<string, FakeElement> = {};
    Object.entries(ELEMENT_DEFAULTS).forEach(([id, cfg]) => {
      const el = new FakeElement(cfg.tag);
      el.id = id;
      if (cfg.hidden) el.hidden = true;
      if (cfg.disabled) el.disabled = true;
      elements[id] = el;
    });
    const sessionStorage = makeSessionStorage(opts.sessionStorageSeed);
    const fetchMock = opts.fetchImpl || vi.fn();

    let uuidCounter = 0;
    const sandbox: Record<string, unknown> = {
      document: {
        getElementById: (id: string) => elements[id] || null,
        createElement: (tag: string) => new FakeElement(tag),
      },
      window: {
        crypto: {
          randomUUID: () => {
            uuidCounter += 1;
            return `00000000-0000-4000-8000-${uuidCounter.toString(16).padStart(12, "0")}`;
          },
        },
      },
      sessionStorage,
      fetch: fetchMock,
      console,
      AbortController: globalThis.AbortController,
      setInterval: timers.setInterval,
      clearInterval: timers.clearInterval,
      setTimeout: timers.setTimeout,
      clearTimeout: timers.clearTimeout,
    };
    const context = vm.createContext(sandbox);
    vm.runInContext(RACE_SCRIPT_SOURCE, context);
    return { context: context as any, elements, sessionStorage, fetchMock: fetchMock as ReturnType<typeof vi.fn>, timers };
  }

  async function flush(times = 10) {
    for (let i = 0; i < times; i++) await Promise.resolve();
  }

  describe("client availability state model — fresh landing (no stored session, no pending operation)", () => {
    it("initial page load performs exactly one availability probe; a 503 sets the unavailable state, disables every mutation control, and renders exactly one Check Again control", async () => {
      const fetchMock = vi.fn().mockResolvedValue(json503());
      const { context, elements } = createRaceSandbox({ fetchImpl: fetchMock });
      await context.initializePage();
      await flush();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toContain("/api/gaming/race/events/00000000-0000-0000-0000-000000000000");

      expect(elements["op-banner"].hidden).toBe(false);
      const checkAgainButtons = findDescendantsByTextContent(elements["op-banner"], "Check Again");
      expect(checkAgainButtons).toHaveLength(1);
      expect(findDescendantById(elements["op-banner"], "btn-check-again")).not.toBeNull();
      expect(findDescendantsByTextContent(elements["op-banner"], "Retry")).toHaveLength(0);

      expect(elements["btn-create"].disabled).toBe(true);
      expect(elements["btn-join"].disabled).toBe(true);
      expect(elements["join-code-input"].disabled).toBe(true);
      elements["scenario-picker"].children.forEach((btn) => expect(btn.disabled).toBe(true));
    });

    it("clicking the disabled Create/Join controls through the DOM produces zero additional fetch calls while unavailable", async () => {
      const fetchMock = vi.fn().mockResolvedValue(json503());
      const { context, elements } = createRaceSandbox({ fetchImpl: fetchMock });
      await context.initializePage();
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      elements["btn-create"].click();
      elements["btn-join"].click();
      elements["scenario-picker"].children[0].click();
      await flush();

      expect(fetchMock).toHaveBeenCalledTimes(1); // unchanged — every click was a no-op
    });

    it("a successful availability probe (a definite 404 for the synthetic probe id) enables Create/Join/scenario controls and shows no banner", async () => {
      const fetchMock = vi.fn().mockResolvedValue(json404());
      const { context, elements } = createRaceSandbox({ fetchImpl: fetchMock });
      await context.initializePage();
      await flush();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(elements["op-banner"].hidden).toBe(true);
      expect(elements["btn-create"].disabled).toBe(false);
      expect(elements["btn-join"].disabled).toBe(false);
      expect(elements["join-code-input"].disabled).toBe(false);
      expect(elements["scenario-picker"].children).toHaveLength(3);
      elements["scenario-picker"].children.forEach((btn) => expect(btn.disabled).toBe(false));
    });

    it("a genuine network-level failure (no HTTP status at all) is never reclassified as schema-unavailable — no banner, controls remain in their safe default-blocked state", async () => {
      const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
      const { context, elements } = createRaceSandbox({ fetchImpl: fetchMock });
      await context.initializePage();
      await flush();

      expect(elements["op-banner"].hidden).toBe(true); // no unavailable banner was ever rendered
      expect(elements["btn-create"].disabled).toBe(true); // never force-enabled without a confirmed "available"
    });
  });

  describe("polling-stop and Check Again recovery — an existing stored Race session", () => {
    function seedStoredSession(overrides?: Record<string, string>) {
      return {
        urbano_race_event_id: "e1",
        urbano_race_organizer_token: "org-1",
        urbano_race_competitor_token: "",
        ...overrides,
      };
    }

    it("the first confirmed 503 during polling stops the interval immediately and requests nothing further across several would-be polling periods", async () => {
      const fetchMock = vi.fn().mockResolvedValue(json503());
      const { context, timers } = createRaceSandbox({ fetchImpl: fetchMock, sessionStorageSeed: seedStoredSession() });
      await context.initializePage();
      await flush();

      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(timers.intervalCount).toBe(0);

      await timers.advanceMs(1500 * 5);
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(1); // no automatic retry loop — zero growth
    });

    it("one Check Again click while still unavailable produces exactly one request and polling remains stopped", async () => {
      const fetchMock = vi.fn().mockResolvedValue(json503());
      const { context, elements, timers } = createRaceSandbox({ fetchImpl: fetchMock, sessionStorageSeed: seedStoredSession() });
      await context.initializePage();
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const checkAgain = findDescendantById(elements["op-banner"], "btn-check-again");
      expect(checkAgain).not.toBeNull();
      checkAgain!.click();
      await flush();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(timers.intervalCount).toBe(0); // still 503 — remains stopped, no interval created
      expect(findDescendantById(elements["op-banner"], "btn-check-again")).not.toBeNull(); // still offered
    });

    it("a successful Check Again transitions to available, renders the current projection, clears the banner, and starts exactly one polling interval", async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(json503())
        .mockResolvedValueOnce(json200({ phase: "AWAITING_COMPETITORS", raceEventId: "e1", competitorASlotFilled: true, competitorBSlotFilled: false }));
      const { context, elements, timers } = createRaceSandbox({ fetchImpl: fetchMock, sessionStorageSeed: seedStoredSession() });
      await context.initializePage();
      await flush();
      expect(timers.intervalCount).toBe(0);

      const checkAgain = findDescendantById(elements["op-banner"], "btn-check-again")!;
      checkAgain.click();
      await flush();

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(elements["op-banner"].hidden).toBe(true);
      expect(timers.intervalCount).toBe(1);
      expect(elements["btn-organizer-join"].disabled).toBe(false);
      expect(elements["btn-organizer-cancel"].disabled).toBe(false);
      expect(elements["label-a"].textContent).toContain("joined"); // real projection was actually applied, not skipped
    });

    it("repeated recovery/render triggers (simulating unrelated success/auth/render events) never create more than one concurrent interval", async () => {
      const fetchMock = vi.fn().mockResolvedValue(json200({ phase: "AWAITING_COMPETITORS", raceEventId: "e1", competitorASlotFilled: false, competitorBSlotFilled: false }));
      const { context, timers } = createRaceSandbox({ fetchImpl: fetchMock, sessionStorageSeed: seedStoredSession() });
      await context.initializePage();
      await flush();
      expect(timers.intervalCount).toBe(1);

      await context.startPolling();
      await context.startPolling();
      await context.handleCheckAgain();
      await flush();

      expect(timers.intervalCount).toBe(1); // never more than one, regardless of how many times polling is (re)started
    });

    it("Check Again never replays a separately pending, still-ambiguous mutation envelope", async () => {
      const pendingMove = JSON.stringify({
        operationKind: "MOVE",
        raceEventId: "e1",
        payload: { fromTowerId: "T1", toTowerId: "T2" },
        idempotencyKey: "00000000-0000-4000-8000-000000000099",
        callerToken: "comp-1",
        status: "AMBIGUOUS",
        createdAt: Date.now(),
      });
      const fetchMock = vi.fn().mockResolvedValue(json200({ phase: "LIVE", raceEventId: "e1", scenarioId: "towers-001" }));
      const { context, sessionStorage } = createRaceSandbox({
        fetchImpl: fetchMock,
        sessionStorageSeed: { ...seedStoredSession({ urbano_race_competitor_token: "comp-1" }), urbano_race_pending_operation: pendingMove },
      });

      // restoreFromStorage() and handleCheckAgain() are exercised directly
      // (bypassing initializePage()'s own pending-operation-resume-first
      // ordering, which is pre-existing, unrelated, and already covered by
      // its own accepted tests) specifically to isolate this correction's
      // own claim: neither ever touches urbano_race_pending_operation.
      await context.restoreFromStorage();
      await context.handleCheckAgain();
      await flush();

      const urls = fetchMock.mock.calls.map((c: unknown[]) => String(c[0]));
      expect(urls.every((u: string) => !u.includes("/move"))).toBe(true);
      expect(sessionStorage.getItem("urbano_race_pending_operation")).toBe(pendingMove); // byte-for-byte unchanged
    });
  });

  describe("Move is gated by availability even though it has no dedicated button", () => {
    it("onTowerTap's fail-closed availability check (UG-CR-GATE-040 Defect 2) is the literal first executable statement, ahead of the pre-existing outcome/operationInFlight checks, and blocks both 'unknown' and 'unavailable' — not merely 'unavailable'", () => {
      const fnStart = raceHtml.indexOf("function onTowerTap(towerId) {");
      expect(fnStart).toBeGreaterThan(-1);
      const fnBody = raceHtml.slice(fnStart, raceHtml.indexOf("\n}", fnStart));
      const firstStatementLine = fnBody
        .split("\n")
        .slice(1)
        .find((line) => line.trim().length > 0 && !line.trim().startsWith("//"));
      expect(firstStatementLine).toContain('raceAvailability !== "available"');
      // Must appear strictly before the pre-existing outcome/operationInFlight guards.
      expect(fnBody.indexOf('raceAvailability !== "available"')).toBeLessThan(fnBody.indexOf('outcome !== "IN_PROGRESS"'));
      expect(fnBody.indexOf('raceAvailability !== "available"')).toBeLessThan(fnBody.indexOf("operationInFlight"));
    });

    it("a direct onTowerTap call while unavailable issues no fetch", async () => {
      const fetchMock = vi.fn().mockResolvedValue(json503());
      const { context } = createRaceSandbox({
        fetchImpl: fetchMock,
        sessionStorageSeed: { urbano_race_event_id: "e1", urbano_race_organizer_token: "", urbano_race_competitor_token: "comp-1" },
      });
      await context.initializePage();
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      context.onTowerTap("T1");
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(1); // unchanged
    });
  });

  describe("beginOperation's own defense-in-depth guard", () => {
    it("beginOperation refuses to start a new mutation while raceAvailability is unavailable, even called directly (bypassing a disabled button)", async () => {
      const fetchMock = vi.fn().mockResolvedValue(json503());
      const { context } = createRaceSandbox({ fetchImpl: fetchMock });
      await context.initializePage();
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const result = await context.beginOperation("CREATE", { payload: { scenarioId: "towers-001", scenarioVersion: 1 } });
      expect(result).toMatchObject({ ok: false, blocked: true, unavailable: true });
      expect(fetchMock).toHaveBeenCalledTimes(1); // no new POST was ever attempted
    });
  });

  describe("enabled mode preserves the existing Race lifecycle and idempotency behavior", () => {
    it("CREATE still succeeds end-to-end once availability is confirmed, and the pre-existing success/session/polling wiring is completely unchanged", async () => {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(json404()) // initial landing probe -> available
        .mockResolvedValueOnce(json201({ raceEventId: "e9", organizerToken: "org-9", scenarioId: "towers-001", scenarioVersion: 1 })) // CREATE
        .mockResolvedValueOnce(json200({ phase: "AWAITING_COMPETITORS", raceEventId: "e9", competitorASlotFilled: false, competitorBSlotFilled: false })); // enterOrganizerSetup's own startPolling
      const { context, elements, sessionStorage } = createRaceSandbox({ fetchImpl: fetchMock });

      await context.initializePage();
      await flush();
      expect(elements["btn-create"].disabled).toBe(false);

      const result = await context.beginOperation("CREATE", { payload: { scenarioId: "towers-001", scenarioVersion: 1 } });
      await flush();

      expect(result).toMatchObject({ ok: true });
      expect(fetchMock).toHaveBeenCalledTimes(3);
      expect(sessionStorage.getItem("urbano_race_event_id")).toBe("e9");
      expect(sessionStorage.getItem("urbano_race_pending_operation")).toBeNull(); // finalizeSuccess's existing clear-on-success, unaffected
      expect(elements["setup-card"].hidden).toBe(false);
      expect(elements["event-id-display"].textContent).toBe("e9");
    });
  });

  function seedStoredSession(overrides?: Record<string, string>) {
    return {
      urbano_race_event_id: "e1",
      urbano_race_organizer_token: "org-1",
      urbano_race_competitor_token: "",
      ...overrides,
    };
  }

  describe("UG-CR-GATE-040 Defect 1 — availability before pending-operation recovery", () => {
    it("reload with an AMBIGUOUS pending Move while Race is unavailable: issues no mutation, preserves the envelope byte-for-byte, and shows the truthful unavailable state (never an auto-invoked Retry)", async () => {
      const pendingMove = JSON.stringify({
        operationKind: "MOVE",
        raceEventId: "e1",
        payload: { fromTowerId: "T1", toTowerId: "T2" },
        idempotencyKey: "00000000-0000-4000-8000-000000000099",
        callerToken: "comp-1",
        status: "AMBIGUOUS",
        createdAt: Date.now(),
      });
      const fetchMock = vi.fn().mockResolvedValue(json503());
      const { context, sessionStorage, elements } = createRaceSandbox({
        fetchImpl: fetchMock,
        sessionStorageSeed: { ...seedStoredSession({ urbano_race_competitor_token: "comp-1" }), urbano_race_pending_operation: pendingMove },
      });

      await context.initializePage();
      await flush();

      // Exactly one request — a read-only availability probe against the
      // pending envelope's own raceEventId — never a POST to /move.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [url, options] = fetchMock.mock.calls[0];
      expect(String(url)).toContain("/api/gaming/race/events/e1");
      expect((options as { method?: string } | undefined)?.method).not.toBe("POST");

      // The envelope is untouched — byte-for-byte identical to what was seeded.
      expect(sessionStorage.getItem("urbano_race_pending_operation")).toBe(pendingMove);

      // The truthful unavailable state is shown (Check Again), not the
      // move's own Retry affordance — nothing was auto-invoked.
      expect(elements["op-banner"].hidden).toBe(false);
      expect(findDescendantById(elements["op-banner"], "btn-check-again")).not.toBeNull();
      expect(findDescendantsByTextContent(elements["op-banner"], "Retry")).toHaveLength(0);
    });

    it("reload with a SUCCESS_RECEIVED pending Create while Race is unavailable: does not finalize, discard, or replay it — credentials remain unstored and the envelope is preserved", async () => {
      const pendingCreate = JSON.stringify({
        operationKind: "CREATE",
        raceEventId: null,
        payload: { scenarioId: "towers-001", scenarioVersion: 1 },
        idempotencyKey: "00000000-0000-4000-8000-000000000077",
        callerToken: null,
        status: "SUCCESS_RECEIVED",
        result: { raceEventId: "e5", organizerToken: "org-5", scenarioId: "towers-001", scenarioVersion: 1 },
        createdAt: Date.now(),
      });
      const fetchMock = vi.fn().mockResolvedValue(json503());
      const { context, sessionStorage, elements } = createRaceSandbox({
        fetchImpl: fetchMock,
        sessionStorageSeed: { urbano_race_pending_operation: pendingCreate },
      });

      await context.initializePage();
      await flush();

      // The probe target is derived from the envelope's OWN post-success
      // result.raceEventId (Create has no raceEventId field of its own
      // until success) — never a mutation request.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(String(fetchMock.mock.calls[0][0])).toContain("/api/gaming/race/events/e5");

      // Never finalized: no credential was ever stored, nothing discarded.
      expect(sessionStorage.getItem("urbano_race_organizer_token")).toBeNull();
      expect(sessionStorage.getItem("urbano_race_event_id")).toBeNull();
      expect(sessionStorage.getItem("urbano_race_pending_operation")).toBe(pendingCreate);
      expect(elements["setup-card"].hidden).toBe(true);
      expect(elements["op-banner"].hidden).toBe(false);
      expect(findDescendantById(elements["op-banner"], "btn-check-again")).not.toBeNull();
    });

    it("once availability is confirmed, a preserved SUCCESS_RECEIVED envelope surfaces its own explicit Recover action — never auto-applied — and clicking it applies the stored result with NO further network request", async () => {
      const pendingCreate = JSON.stringify({
        operationKind: "CREATE",
        raceEventId: null,
        payload: { scenarioId: "towers-001", scenarioVersion: 1 },
        idempotencyKey: "00000000-0000-4000-8000-000000000077",
        callerToken: null,
        status: "SUCCESS_RECEIVED",
        result: { raceEventId: "e7", organizerToken: "org-7", scenarioId: "towers-001", scenarioVersion: 1 },
        createdAt: Date.now(),
      });
      const fetchMock = vi.fn().mockResolvedValue(json200({ phase: "AWAITING_COMPETITORS", raceEventId: "e7", competitorASlotFilled: false, competitorBSlotFilled: false }));
      const { context, sessionStorage, elements } = createRaceSandbox({
        fetchImpl: fetchMock,
        sessionStorageSeed: { urbano_race_pending_operation: pendingCreate },
      });

      await context.initializePage();
      await flush();

      // Available, but NOT auto-applied: credentials still unstored.
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(sessionStorage.getItem("urbano_race_organizer_token")).toBeNull();
      expect(sessionStorage.getItem("urbano_race_pending_operation")).toBe(pendingCreate);
      expect(elements["op-banner"].hidden).toBe(false);
      const recoverButtons = findDescendantsByTextContent(elements["op-banner"], "Retry");
      expect(recoverButtons).toHaveLength(1);

      recoverButtons[0].click();
      await flush();

      // finalizeSuccess itself never re-hits the network to apply an
      // already-known result — the one additional call here is
      // enterOrganizerSetup's own OWN pre-existing, legitimate
      // startPolling() (a read-only projection GET, establishing live
      // polling for the just-recovered session), never a second POST of
      // the Create mutation itself.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][1]?.method ?? "GET").not.toBe("POST");
      expect(sessionStorage.getItem("urbano_race_organizer_token")).toBe("org-7");
      expect(sessionStorage.getItem("urbano_race_event_id")).toBe("e7");
      expect(sessionStorage.getItem("urbano_race_pending_operation")).toBeNull();
      expect(elements["setup-card"].hidden).toBe(false);
    });

    it("a successful explicit Check Again exposes the pending Move's Retry affordance without auto-invoking it; the explicit click reuses the original key, payload, and caller", async () => {
      const originalKey = "00000000-0000-4000-8000-0000000000aa";
      const pendingMove = JSON.stringify({
        operationKind: "MOVE",
        raceEventId: "e1",
        payload: { fromTowerId: "T1", toTowerId: "T3" },
        idempotencyKey: originalKey,
        callerToken: "comp-1",
        status: "AMBIGUOUS",
        createdAt: Date.now(),
      });
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(json503()) // initializePage's own probe (unavailable)
        .mockResolvedValueOnce(json200({ phase: "LIVE", raceEventId: "e1", scenarioId: "towers-001", you: { slot: "A", board: { currentStacks: { T1: [3, 2, 1], T2: [], T3: [] }, outcome: "IN_PROGRESS", moveCount: 0 } } })) // Check Again's own probe (available)
        .mockResolvedValueOnce(json200({ currentStacks: { T1: [3, 2], T2: [], T3: [1] }, moveCount: 1, towersOutcome: "IN_PROGRESS" })); // the explicit Retry's actual move
      const { context, sessionStorage, elements } = createRaceSandbox({
        fetchImpl: fetchMock,
        sessionStorageSeed: { ...seedStoredSession({ urbano_race_competitor_token: "comp-1" }), urbano_race_pending_operation: pendingMove },
      });

      await context.initializePage();
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const checkAgain = findDescendantById(elements["op-banner"], "btn-check-again")!;
      checkAgain.click();
      await flush();

      // Available now, but the Move was NOT auto-replayed — only its own
      // explicit Retry affordance is offered.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[1][1]?.method ?? "GET").not.toBe("POST");
      expect(sessionStorage.getItem("urbano_race_pending_operation")).toBe(pendingMove);
      const retryButtons = findDescendantsByTextContent(elements["op-banner"], "Retry");
      expect(retryButtons).toHaveLength(1);

      retryButtons[0].click();
      await flush();

      // The explicit click reuses the ORIGINAL key, payload, and caller —
      // never a freshly generated one.
      expect(fetchMock).toHaveBeenCalledTimes(3);
      const [moveUrl, moveOptions] = fetchMock.mock.calls[2];
      expect(String(moveUrl)).toContain("/api/gaming/race/events/e1/move");
      expect((moveOptions as { headers?: Record<string, string> }).headers?.Authorization).toBe("Bearer comp-1");
      const sentBody = JSON.parse((moveOptions as { body: string }).body);
      expect(sentBody).toEqual({ fromTowerId: "T1", toTowerId: "T3", idempotencyKey: originalKey });
      expect(sessionStorage.getItem("urbano_race_pending_operation")).toBeNull();
    });
  });

  describe("UG-CR-GATE-040 Defect 2 — fail closed for 'unknown', not merely 'unavailable'", () => {
    it("direct invocation of every mutating operation while availability is still 'unknown' (before any probe has ever resolved) sends no request and generates no key", async () => {
      const fetchMock = vi.fn();
      const { context, sessionStorage } = createRaceSandbox({ fetchImpl: fetchMock });
      // initializePage() is deliberately never called — raceAvailability
      // remains at its initial "unknown" value, exactly as it is before
      // the very first probe on a real page load ever resolves.

      const createResult = await context.beginOperation("CREATE", { payload: { scenarioId: "towers-001", scenarioVersion: 1 } });
      const joinResult = await context.beginOperation("JOIN", { raceEventId: "e1", buttonId: "btn-join" });
      const readyResult = await context.beginOperation("READY", { raceEventId: "e1", callerToken: "comp-1" });
      const undoResult = await context.beginOperation("UNDO", { raceEventId: "e1", callerToken: "comp-1" });
      const organizerCancelResult = await context.beginOperation("ORGANIZER_CANCEL", { raceEventId: "e1", callerToken: "org-1" });
      const liveCancelResult = await context.beginOperation("LIVE_CANCEL", { raceEventId: "e1", callerToken: "comp-1" });
      context.onTowerTap("T1"); // Move has no dedicated button — this is its own gate

      await flush();

      for (const result of [createResult, joinResult, readyResult, undoResult, organizerCancelResult, liveCancelResult]) {
        expect(result).toMatchObject({ ok: false, blocked: true, unknown: true, unavailable: false });
      }
      expect(fetchMock).not.toHaveBeenCalled();
      expect(sessionStorage.getItem("urbano_race_pending_operation")).toBeNull();
    });

    it("beginOperation's blocked result distinguishes 'unknown' from a genuinely confirmed 'unavailable'", async () => {
      const fetchMock = vi.fn().mockResolvedValue(json503());
      const { context } = createRaceSandbox({ fetchImpl: fetchMock });
      await context.initializePage();
      await flush();

      const result = await context.beginOperation("CREATE", { payload: { scenarioId: "towers-001", scenarioVersion: 1 } });
      expect(result).toMatchObject({ ok: false, blocked: true, unavailable: true, unknown: false });
    });

    it("onTowerTap is inert while availability is still 'unknown', not only while confirmed 'unavailable'", async () => {
      const fetchMock = vi.fn();
      const { context } = createRaceSandbox({ fetchImpl: fetchMock });
      context.onTowerTap("T1");
      await flush();
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("UG-CR-GATE-040 Defect 3 — exactly one availability probe before polling, even under a slow response", () => {
    it("a Check Again whose response takes longer than one 1500ms polling period still produces exactly one request and creates zero intervals", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(json503());
      const { context, timers, elements } = createRaceSandbox({ fetchImpl: fetchMock, sessionStorageSeed: seedStoredSession() });
      await context.initializePage();
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(1);
      expect(timers.intervalCount).toBe(0);

      let resolveDelayed: (v: unknown) => void = () => {};
      const delayed = new Promise((resolve) => { resolveDelayed = resolve; });
      fetchMock.mockReturnValueOnce(delayed);

      const checkAgain = findDescendantById(elements["op-banner"], "btn-check-again")!;
      checkAgain.click();
      await flush();

      expect(fetchMock).toHaveBeenCalledTimes(2); // the single probe WAS issued
      expect(timers.intervalCount).toBe(0); // not yet settled

      // More than one polling period elapses while that single probe is
      // still unresolved — this must never produce a second request or a
      // premature interval.
      await timers.advanceMs(1500 * 3);
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(timers.intervalCount).toBe(0);

      resolveDelayed(json503());
      await flush();

      // The slow response finally settles as unavailable — still exactly
      // one request total, and still zero intervals.
      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(timers.intervalCount).toBe(0);
    });

    it("a slow response that eventually resolves AVAILABLE creates exactly one interval only after settling — never before", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(json503());
      const { context, timers, elements } = createRaceSandbox({ fetchImpl: fetchMock, sessionStorageSeed: seedStoredSession() });
      await context.initializePage();
      await flush();

      let resolveDelayed: (v: unknown) => void = () => {};
      const delayed = new Promise((resolve) => { resolveDelayed = resolve; });
      fetchMock.mockReturnValueOnce(delayed);

      const checkAgain = findDescendantById(elements["op-banner"], "btn-check-again")!;
      checkAgain.click();
      await flush();
      await timers.advanceMs(1500 * 2);
      await flush();
      expect(timers.intervalCount).toBe(0); // still pending — no interval created preemptively

      resolveDelayed(json200({ phase: "AWAITING_COMPETITORS", raceEventId: "e1", competitorASlotFilled: false, competitorBSlotFilled: false }));
      await flush();

      expect(timers.intervalCount).toBe(1); // created only now, once the single probe actually settled available
    });

    it("rapid, overlapping Check Again clicks issue only one in-flight probe at a time and never create more than one interval", async () => {
      const fetchMock = vi.fn().mockResolvedValue(json503());
      const { context, elements, timers } = createRaceSandbox({ fetchImpl: fetchMock, sessionStorageSeed: seedStoredSession() });
      await context.initializePage();
      await flush();
      expect(fetchMock).toHaveBeenCalledTimes(1);

      const checkAgain = findDescendantById(elements["op-banner"], "btn-check-again")!;
      // Genuinely overlapping — fired back to back with no await between
      // them, not sequential awaited calls.
      checkAgain.click();
      checkAgain.click();
      checkAgain.click();
      await flush();

      expect(fetchMock).toHaveBeenCalledTimes(2); // only ONE of the three overlapping clicks actually issued a request
      expect(timers.intervalCount).toBe(0);
    });
  });
});
