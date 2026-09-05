import { randomUUID } from "crypto";
import { describe, expect, it, vi } from "vitest";

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
