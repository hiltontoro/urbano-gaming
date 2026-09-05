import { randomUUID } from "crypto";
import { loadEnv } from "vite";
import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";

import { SupabaseRaceRepository } from "../lib/gaming/race/db/supabaseRaceRepository";
import { createEvent } from "../lib/gaming/race/createEvent";
import { joinEvent } from "../lib/gaming/race/joinEvent";
import { confirmReadiness } from "../lib/gaming/race/confirmReadiness";
import { applyRaceMove } from "../lib/gaming/race/applyMove";
import { undoRaceMove } from "../lib/gaming/race/undoMove";
import { requestRaceCancellation } from "../lib/gaming/race/requestCancellation";
import { getRaceEventProjection } from "../lib/gaming/race/getProjection";
import {
  RaceEventAlreadyTerminalError,
  RaceIdempotencyKeyConflictError,
  RaceInvalidTokenError,
} from "../lib/gaming/race/types";

const env = loadEnv("development", process.cwd(), "");
const supabaseUrl = env.SUPABASE_URL;
const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for contract tests.");
}
// This project's committed .env.local targets the linked REMOTE Supabase
// project; contract tests must run only against the confirmed local
// stack. Fail loudly rather than silently mutating a non-local database
// if SUPABASE_URL was not explicitly overridden to 127.0.0.1 for this
// run (see UG-CR-RPT-025's baseline-verification section).
if (!/127\.0\.0\.1|localhost/.test(supabaseUrl)) {
  throw new Error(
    `Refusing to run Race contract tests against a non-local SUPABASE_URL (${supabaseUrl}). ` +
      "Export SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY for the local stack before running this file."
  );
}

const repo = new SupabaseRaceRepository(supabaseUrl, supabaseServiceRoleKey);
const independentRepo = new SupabaseRaceRepository(supabaseUrl, supabaseServiceRoleKey);
const cleanupClient = createClient(supabaseUrl, supabaseServiceRoleKey);

const createdRaceEventIds: string[] = [];
const createdAttemptIds: string[] = [];
// A real UUID — idempotency_key is a `uuid`-typed column against real
// Postgres (UG-CR-GATE-026's key validation boundary); a non-UUID
// string would be rejected by the database itself, not merely produce
// a misleading test result.
function key(): string {
  return randomUUID();
}

afterAll(async () => {
  // race_completions and race_event_operations cascade on race_events
  // delete; towers_attempts has no FK to race_events (the reference
  // points the other way), so it is safe to delete race_events first,
  // then the created Towers attempts (actions first, same FK-direction
  // concern as the Towers/Rutas contract tests' own cleanup).
  // race_event_creations references race_events too and is cleaned up
  // implicitly wherever it is not (it has no cascade, but its rows are
  // harmless orphan-free ledger entries scoped to test-only keys).
  for (const raceEventId of createdRaceEventIds) {
    await cleanupClient.from("race_events").delete().eq("race_event_id", raceEventId);
  }
  for (const attemptId of createdAttemptIds) {
    await cleanupClient.from("towers_attempt_actions").delete().eq("attempt_id", attemptId);
  }
  for (const attemptId of [...createdAttemptIds].reverse()) {
    await cleanupClient.from("towers_attempts").delete().eq("attempt_id", attemptId);
  }
});

const SCENARIO_1_SOLUTION: Array<[string, string]> = [
  ["T1", "T3"],
  ["T1", "T2"],
  ["T3", "T2"],
  ["T1", "T3"],
  ["T2", "T1"],
  ["T2", "T3"],
  ["T1", "T3"],
];

async function setUpReadyEvent(usingRepo = repo) {
  const created = await createEvent(usingRepo, { idempotencyKey: key(), scenarioId: "towers-001", scenarioVersion: 1 });
  createdRaceEventIds.push(created.raceEventId);
  const a = await joinEvent(usingRepo, { raceEventId: created.raceEventId, idempotencyKey: key() });
  const b = await joinEvent(usingRepo, { raceEventId: created.raceEventId, idempotencyKey: key() });
  await confirmReadiness(usingRepo, { raceEventId: created.raceEventId, competitorToken: a.competitorToken });
  const readyResult = await confirmReadiness(usingRepo, {
    raceEventId: created.raceEventId,
    competitorToken: b.competitorToken,
  });

  const event = await usingRepo.getEvent(created.raceEventId);
  if (event?.competitorAAttemptId) createdAttemptIds.push(event.competitorAAttemptId);
  if (event?.competitorBAttemptId) createdAttemptIds.push(event.competitorBAttemptId);

  // Real Postgres, real wall clock: wait out the genuine 3-second
  // countdown rather than backdating shared_start_at, so this exercises
  // the actual scheduled value at least once end to end.
  const waitMs = Math.max(0, new Date(readyResult.sharedStartAt!).getTime() - Date.now()) + 250;
  await new Promise((resolve) => setTimeout(resolve, waitMs));

  return { created, a, b, sharedStartAt: readyResult.sharedStartAt! };
}

async function playMoves(
  usingRepo: SupabaseRaceRepository,
  raceEventId: string,
  competitorToken: string,
  moves: Array<[string, string]>
) {
  let last;
  for (const [fromTowerId, toTowerId] of moves) {
    last = await applyRaceMove(usingRepo, { raceEventId, competitorToken, fromTowerId, toTowerId, idempotencyKey: key() });
  }
  return last!;
}

describe("SupabaseRaceRepository contract", () => {
  it(
    "full event pipeline against real local Postgres: create, join, ready, shared countdown, move, undo, completion, winner",
    async () => {
      const { created, a, b } = await setUpReadyEvent();

      const beforeMove = await applyRaceMove(repo, {
        raceEventId: created.raceEventId,
        competitorToken: a.competitorToken,
        fromTowerId: "T1",
        toTowerId: "T3",
        idempotencyKey: key(),
      });
      expect(beforeMove.moveCount).toBe(1);
      expect(beforeMove.currentStacks).toEqual({ T1: [3, 2], T2: [], T3: [1] });

      const afterUndo = await undoRaceMove(repo, {
        raceEventId: created.raceEventId,
        competitorToken: a.competitorToken,
        idempotencyKey: key(),
      });
      expect(afterUndo.currentStacks).toEqual({ T1: [3, 2, 1], T2: [], T3: [] });

      const finalMove = await playMoves(repo, created.raceEventId, a.competitorToken, SCENARIO_1_SOLUTION);
      expect(finalMove.towersOutcome).toBe("COMPLETE");
      expect(finalMove.raceTerminalResolution).toBe("WON_LOST");
      expect(finalMove.raceWinnerSlot).toBe("A");

      const projection = await getRaceEventProjection(repo, { raceEventId: created.raceEventId, callerToken: null });
      expect(projection.terminalResolution).toBe("WON_LOST");
      expect(projection.winnerSlot).toBe("A");

      // The loser's own attempt was never touched: no post-terminal
      // Towers mutation.
      const bProjection = await getRaceEventProjection(repo, {
        raceEventId: created.raceEventId,
        callerToken: b.competitorToken,
      });
      await expect(
        applyRaceMove(repo, {
          raceEventId: created.raceEventId,
          competitorToken: b.competitorToken,
          fromTowerId: "T1",
          toTowerId: "T3",
          idempotencyKey: key(),
        })
      ).rejects.toBeInstanceOf(RaceEventAlreadyTerminalError);
      expect(bProjection.you?.board?.moveCount).toBe(0);
      expect(bProjection.you?.board?.outcome).toBe("IN_PROGRESS");
    },
    15000
  );

  it("raw Towers attempt ids and the opponent's own credential never appear in the projection response body", async () => {
    const { created, a, b } = await setUpReadyEvent();
    const projection = await getRaceEventProjection(repo, {
      raceEventId: created.raceEventId,
      callerToken: a.competitorToken,
    });
    const serialized = JSON.stringify(projection);
    expect(serialized).not.toMatch(/attemptId/i);
    expect(serialized).not.toMatch(/attempt_id/i);
    expect(serialized).not.toContain(b.competitorToken);
    expect(serialized).not.toContain(created.organizerToken);
  }, 15000);

  it("rejects a move using an unrecognized competitor token", async () => {
    const { created } = await setUpReadyEvent();
    await expect(
      applyRaceMove(repo, {
        raceEventId: created.raceEventId,
        competitorToken: "not-a-real-token",
        fromTowerId: "T1",
        toTowerId: "T3",
        idempotencyKey: key(),
      })
    ).rejects.toBeInstanceOf(RaceInvalidTokenError);
  }, 15000);

  describe("key validation boundary (UG-CR-GATE-026): the database rejects a malformed key without any state mutation", () => {
    it("rejects a malformed idempotency key at the create_race_event_atomically column type boundary", async () => {
      const before = await cleanupClient.from("race_events").select("race_event_id", { count: "exact", head: true });
      await expect(
        cleanupClient.rpc("create_race_event_atomically", {
          p_idempotency_key: "not-a-uuid",
          p_scenario_id: "towers-001",
          p_scenario_version: 1,
        })
      ).resolves.toMatchObject({ error: expect.anything() });
      const after = await cleanupClient.from("race_events").select("race_event_id", { count: "exact", head: true });
      expect(after.count).toBe(before.count);
    }, 15000);

    it("rejects an oversized/malformed idempotency key at the join_race_event_atomically column type boundary, without consuming a slot", async () => {
      const created = await createEvent(repo, { idempotencyKey: key(), scenarioId: "towers-001", scenarioVersion: 1 });
      createdRaceEventIds.push(created.raceEventId);

      const oversizedKey = "x".repeat(500);
      await expect(
        cleanupClient.rpc("join_race_event_atomically", {
          p_race_event_id: created.raceEventId,
          p_idempotency_key: oversizedKey,
        })
      ).resolves.toMatchObject({ error: expect.anything() });

      const event = await repo.getEvent(created.raceEventId);
      expect(event!.competitorAToken).toBeNull();
      expect(event!.competitorBToken).toBeNull();
    }, 15000);
  });

  describe("durable Race-owned idempotency (UG-CR-GATE-025 Correction A) against real local Postgres", () => {
    it("a lost-response CREATE retry returns one event and the same organizer token", async () => {
      const sharedKey = key();
      const first = await createEvent(repo, { idempotencyKey: sharedKey, scenarioId: "towers-001", scenarioVersion: 1 });
      createdRaceEventIds.push(first.raceEventId);
      const retry = await createEvent(repo, { idempotencyKey: sharedKey, scenarioId: "towers-001", scenarioVersion: 1 });
      expect(retry.raceEventId).toBe(first.raceEventId);
      expect(retry.organizerToken).toBe(first.organizerToken);

      const { data } = await cleanupClient.from("race_events").select("race_event_id").eq("organizer_token", first.organizerToken);
      expect(data).toHaveLength(1);
    }, 15000);

    it("a lost-response JOIN retry returns the same slot/token and leaves the other slot open", async () => {
      const created = await createEvent(repo, { idempotencyKey: key(), scenarioId: "towers-001", scenarioVersion: 1 });
      createdRaceEventIds.push(created.raceEventId);
      const sharedKey = key();
      const first = await joinEvent(repo, { raceEventId: created.raceEventId, idempotencyKey: sharedKey });
      const retry = await joinEvent(repo, { raceEventId: created.raceEventId, idempotencyKey: sharedKey });
      expect(retry.competitorSlot).toBe(first.competitorSlot);
      expect(retry.competitorToken).toBe(first.competitorToken);

      const event = await repo.getEvent(created.raceEventId);
      expect(event!.competitorAToken).toBe(first.competitorToken);
      expect(event!.competitorBToken).toBeNull();
    }, 15000);

    it("rejects the same idempotency key reused with a different payload, caller, or command, deterministically", async () => {
      const { created, a } = await setUpReadyEvent();

      const moveKey = key();
      await applyRaceMove(repo, {
        raceEventId: created.raceEventId,
        competitorToken: a.competitorToken,
        fromTowerId: "T1",
        toTowerId: "T3",
        idempotencyKey: moveKey,
      });

      // different payload
      await expect(
        applyRaceMove(repo, {
          raceEventId: created.raceEventId,
          competitorToken: a.competitorToken,
          fromTowerId: "T1",
          toTowerId: "T2",
          idempotencyKey: moveKey,
        })
      ).rejects.toBeInstanceOf(RaceIdempotencyKeyConflictError);

      // different command entirely (undo reusing a move's key)
      await expect(
        undoRaceMove(repo, { raceEventId: created.raceEventId, competitorToken: a.competitorToken, idempotencyKey: moveKey })
      ).rejects.toBeInstanceOf(RaceIdempotencyKeyConflictError);
    }, 15000);

    it("READY retry does not recreate attempts or change shared_start_at", async () => {
      const created = await createEvent(repo, { idempotencyKey: key(), scenarioId: "towers-001", scenarioVersion: 1 });
      createdRaceEventIds.push(created.raceEventId);
      const a = await joinEvent(repo, { raceEventId: created.raceEventId, idempotencyKey: key() });
      const b = await joinEvent(repo, { raceEventId: created.raceEventId, idempotencyKey: key() });
      await confirmReadiness(repo, { raceEventId: created.raceEventId, competitorToken: a.competitorToken });
      const first = await confirmReadiness(repo, { raceEventId: created.raceEventId, competitorToken: b.competitorToken });

      const eventAfterFirst = await repo.getEvent(created.raceEventId);
      if (eventAfterFirst?.competitorAAttemptId) createdAttemptIds.push(eventAfterFirst.competitorAAttemptId);
      if (eventAfterFirst?.competitorBAttemptId) createdAttemptIds.push(eventAfterFirst.competitorBAttemptId);

      const retry = await confirmReadiness(repo, { raceEventId: created.raceEventId, competitorToken: b.competitorToken });
      expect(retry.sharedStartAt).toBe(first.sharedStartAt);

      const eventAfterRetry = await repo.getEvent(created.raceEventId);
      expect(eventAfterRetry!.competitorAAttemptId).toBe(eventAfterFirst!.competitorAAttemptId);
      expect(eventAfterRetry!.competitorBAttemptId).toBe(eventAfterFirst!.competitorBAttemptId);
    }, 15000);

    it("a completing-move retry after terminalization against real Postgres returns the original success, winner, board, and alreadyApplied — not a 409", async () => {
      const { created, a } = await setUpReadyEvent();
      const setupMoves = SCENARIO_1_SOLUTION.slice(0, 6);
      await playMoves(repo, created.raceEventId, a.competitorToken, setupMoves);

      const winningKey = key();
      const finalMove = SCENARIO_1_SOLUTION[6];
      const first = await applyRaceMove(repo, {
        raceEventId: created.raceEventId,
        competitorToken: a.competitorToken,
        fromTowerId: finalMove[0],
        toTowerId: finalMove[1],
        idempotencyKey: winningKey,
      });
      expect(first.raceTerminalResolution).toBe("WON_LOST");

      const retry = await applyRaceMove(repo, {
        raceEventId: created.raceEventId,
        competitorToken: a.competitorToken,
        fromTowerId: finalMove[0],
        toTowerId: finalMove[1],
        idempotencyKey: winningKey,
      });
      expect(retry.alreadyApplied).toBe(true);
      expect(retry.raceTerminalResolution).toBe("WON_LOST");
      expect(retry.raceWinnerSlot).toBe("A");
      expect(retry.towersOutcome).toBe("COMPLETE");
      expect(retry.currentStacks).toEqual(first.currentStacks);

      const { data: completions } = await cleanupClient
        .from("race_completions")
        .select("*")
        .eq("race_event_id", created.raceEventId);
      expect(completions).toHaveLength(1);
    }, 20000);

    it("an UNDO retry against real Postgres performs exactly one undo", async () => {
      const { created, a } = await setUpReadyEvent();
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

      const event = await repo.getEvent(created.raceEventId);
      const board = await repo.getBoard(event!.competitorAAttemptId!);
      expect(board!.undoCount).toBe(1);
    }, 15000);

    it(
      "two independent clients submitting the SAME completing move idempotency key concurrently create exactly one Towers action, one Race operation result, and one completion record",
      async () => {
        const { created, a } = await setUpReadyEvent();
        const setupMoves = SCENARIO_1_SOLUTION.slice(0, 6);
        await playMoves(repo, created.raceEventId, a.competitorToken, setupMoves);

        const sharedKey = key();
        const finalMove = SCENARIO_1_SOLUTION[6];
        const call = (usingRepo: SupabaseRaceRepository) =>
          applyRaceMove(usingRepo, {
            raceEventId: created.raceEventId,
            competitorToken: a.competitorToken,
            fromTowerId: finalMove[0],
            toTowerId: finalMove[1],
            idempotencyKey: sharedKey,
          });

        const [r1, r2] = await Promise.all([call(repo), call(independentRepo)]);
        expect(r1.raceWinnerSlot).toBe("A");
        expect(r2.raceWinnerSlot).toBe("A");
        // Exactly one of the two calls actually executed the mutation;
        // the other necessarily observed alreadyApplied, since the
        // ledger's own primary key makes a duplicate insert impossible
        // and the row lock serializes the two calls.
        expect([r1.alreadyApplied, r2.alreadyApplied].filter(Boolean)).toHaveLength(1);

        const { data: completions } = await cleanupClient
          .from("race_completions")
          .select("*")
          .eq("race_event_id", created.raceEventId);
        expect(completions).toHaveLength(1);

        const { data: operations } = await cleanupClient
          .from("race_event_operations")
          .select("*")
          .eq("race_event_id", created.raceEventId)
          .eq("idempotency_key", sharedKey);
        expect(operations).toHaveLength(1);
      },
      20000
    );

    it(
      "two independent clients submitting the SAME ORDINARY (non-completing) move idempotency key concurrently produce one Towers action and identical Race results",
      async () => {
        const { created, a } = await setUpReadyEvent();

        const sharedKey = key();
        const call = (usingRepo: SupabaseRaceRepository) =>
          applyRaceMove(usingRepo, {
            raceEventId: created.raceEventId,
            competitorToken: a.competitorToken,
            fromTowerId: "T1",
            toTowerId: "T3",
            idempotencyKey: sharedKey,
          });

        const [r1, r2] = await Promise.all([call(repo), call(independentRepo)]);
        expect(r1.currentStacks).toEqual(r2.currentStacks);
        expect(r1.moveCount).toBe(1);
        expect(r2.moveCount).toBe(1);
        expect([r1.alreadyApplied, r2.alreadyApplied].filter(Boolean)).toHaveLength(1);

        const event = await repo.getEvent(created.raceEventId);
        const board = await repo.getBoard(event!.competitorAAttemptId!);
        expect(board!.moveCount).toBe(1);
      },
      20000
    );

    it("cancellation retries preserve one terminal result without duplicating evidence", async () => {
      const created = await createEvent(repo, { idempotencyKey: key(), scenarioId: "towers-001", scenarioVersion: 1 });
      createdRaceEventIds.push(created.raceEventId);
      await joinEvent(repo, { raceEventId: created.raceEventId, idempotencyKey: key() });
      const cancelKey = key();
      const first = await requestRaceCancellation(repo, { raceEventId: created.raceEventId, callerToken: created.organizerToken, idempotencyKey: cancelKey });
      const retry = await requestRaceCancellation(repo, { raceEventId: created.raceEventId, callerToken: created.organizerToken, idempotencyKey: cancelKey });
      expect(retry).toEqual(first);
    }, 15000);
  });

  it(
    "two genuinely concurrent completing requests from independent database clients (different competitors, different keys) produce exactly one immutable winner, and the loser's Towers attempt is left untouched",
    async () => {
      const { created, a, b } = await setUpReadyEvent();

      // Bring both competitors to exactly one move away from completion,
      // sequentially (no race here — only the final move is raced).
      const setupMoves = SCENARIO_1_SOLUTION.slice(0, 6);
      await playMoves(repo, created.raceEventId, a.competitorToken, setupMoves);
      await playMoves(independentRepo, created.raceEventId, b.competitorToken, setupMoves);

      const finalMove = SCENARIO_1_SOLUTION[6];

      // Two SEPARATE SupabaseRaceRepository instances (each backed by its
      // own createClient call, its own HTTP connection to PostgREST, and
      // its own underlying Postgres connection) submit their final,
      // completing move at the same time. Sequential promises on one
      // client would not prove this — this is the independent-execution-
      // context proof the gate requires.
      const [resultA, resultB] = await Promise.allSettled([
        applyRaceMove(repo, {
          raceEventId: created.raceEventId,
          competitorToken: a.competitorToken,
          fromTowerId: finalMove[0],
          toTowerId: finalMove[1],
          idempotencyKey: key(),
        }),
        applyRaceMove(independentRepo, {
          raceEventId: created.raceEventId,
          competitorToken: b.competitorToken,
          fromTowerId: finalMove[0],
          toTowerId: finalMove[1],
          idempotencyKey: key(),
        }),
      ]);

      // Exactly one side observes itself as the winner (raceWinnerSlot
      // set on a COMPLETE outcome); the other is either rejected
      // (already terminal, if it acquired the lock second) or, if it
      // happened to acquire the lock first for its OWN completing move,
      // IT is the winner instead — under real row-level locking there is
      // no scheduling order this test can pin down in advance, so both
      // orderings are accepted, but never both winning and never neither.
      const outcomes = [resultA, resultB].map((r) =>
        r.status === "fulfilled" ? r.value : { rejected: true, reason: r.reason }
      );
      const winners = outcomes.filter((o: any) => o.raceWinnerSlot != null);
      expect(winners).toHaveLength(1);

      const projection = await getRaceEventProjection(repo, { raceEventId: created.raceEventId, callerToken: null });
      expect(projection.terminalResolution).toBe("WON_LOST");
      expect(["A", "B"]).toContain(projection.winnerSlot);

      const { data: completions } = await cleanupClient
        .from("race_completions")
        .select("*")
        .eq("race_event_id", created.raceEventId);
      expect(completions).toHaveLength(1);

      // The losing competitor's own final move was never relayed to
      // Towers — its attempt remains IN_PROGRESS at move_count 6, not 7 —
      // and it is not directly rewritten to ABANDONED either (Race
      // permanently blocks further official mutation; it does not
      // fabricate a Towers-level terminal state for the loser).
      const loserSlot = projection.winnerSlot === "A" ? "B" : "A";
      const loserToken = loserSlot === "A" ? a.competitorToken : b.competitorToken;
      const loserProjection = await getRaceEventProjection(repo, {
        raceEventId: created.raceEventId,
        callerToken: loserToken,
      });
      expect(loserProjection.you?.board?.outcome).toBe("IN_PROGRESS");
      expect(loserProjection.you?.board?.moveCount).toBe(6);
    },
    20000
  );

  it("ordinary execution against real Postgres cannot fabricate a tie: the first genuine completion always declares a definite winner", async () => {
    const { created, a } = await setUpReadyEvent();
    const finalResult = await playMoves(repo, created.raceEventId, a.competitorToken, SCENARIO_1_SOLUTION);
    expect(finalResult.raceTerminalResolution).toBe("WON_LOST");
    expect(finalResult.raceWinnerSlot).not.toBeNull();
    // 'TIE' is not a member of the terminal_resolution CHECK constraint
    // at all any more (see the events migration) — there is no
    // artificially-injected predecessor-completion test left to remove
    // any further; this is the full, honest replacement.
  }, 15000);

  it(
    "request-admission and completion-observation timestamps have the corrected semantics: a request admitted just under the deadline still wins even if real time crosses it during its own processing",
    async () => {
      const { created, a } = await setUpReadyEvent();
      const setupMoves = SCENARIO_1_SOLUTION.slice(0, 6);
      await playMoves(repo, created.raceEventId, a.competitorToken, setupMoves);

      // Backdate shared_start_at so admission (now(), evaluated once at
      // the top of the function) lands just under the 10-minute deadline.
      const { error } = await cleanupClient
        .from("race_events")
        .update({ shared_start_at: new Date(Date.now() - 10 * 60 * 1000 + 500).toISOString() })
        .eq("race_event_id", created.raceEventId);
      if (error) throw error;

      const finalMove = SCENARIO_1_SOLUTION[6];
      const result = await applyRaceMove(repo, {
        raceEventId: created.raceEventId,
        competitorToken: a.competitorToken,
        fromTowerId: finalMove[0],
        toTowerId: finalMove[1],
        idempotencyKey: key(),
      });

      // Admitted (just) before the deadline: still wins.
      expect(result.raceTerminalResolution).toBe("WON_LOST");

      const { data: eventRow } = await cleanupClient
        .from("race_events")
        .select("shared_start_at, ended_at")
        .eq("race_event_id", created.raceEventId)
        .single();
      const { data: completionRow } = await cleanupClient
        .from("race_completions")
        .select("race_observed_completed_at, elapsed_ms")
        .eq("race_event_id", created.raceEventId)
        .single();

      // The completion-observation timestamp (clock_timestamp(), stored
      // as race_observed_completed_at / ended_at) genuinely reflects
      // real wall-clock time and is coherent with the stored elapsed_ms
      // — both anchored to the real shared_start_at, not frozen at some
      // single transaction-start value that never advanced.
      const observedElapsed =
        new Date(completionRow!.race_observed_completed_at).getTime() - new Date(eventRow!.shared_start_at).getTime();
      expect(Math.abs(observedElapsed - completionRow!.elapsed_ms)).toBeLessThan(50);
      expect(eventRow!.ended_at).toBe(completionRow!.race_observed_completed_at);
    },
    20000
  );

  it("readiness expiry: cancels without a winner once the five-minute readiness window elapses", async () => {
    const created = await createEvent(repo, { idempotencyKey: key(), scenarioId: "towers-001", scenarioVersion: 1 });
    createdRaceEventIds.push(created.raceEventId);
    const a = await joinEvent(repo, { raceEventId: created.raceEventId, idempotencyKey: key() });
    await joinEvent(repo, { raceEventId: created.raceEventId, idempotencyKey: key() });

    const { error } = await cleanupClient
      .from("race_events")
      .update({ second_competitor_assigned_at: new Date(Date.now() - 6 * 60 * 1000).toISOString() })
      .eq("race_event_id", created.raceEventId);
    if (error) throw error;

    const result = await confirmReadiness(repo, { raceEventId: created.raceEventId, competitorToken: a.competitorToken });
    expect(result.terminalResolution).toBe("CANCELLED");

    const projection = await getRaceEventProjection(repo, { raceEventId: created.raceEventId, callerToken: null });
    expect(projection.terminalResolution).toBe("CANCELLED");
  }, 15000);

  it("cancellation authority: organizer cancels freely pre-countdown; post-countdown requires both competitors", async () => {
    const preCountdown = await createEvent(repo, { idempotencyKey: key(), scenarioId: "towers-001", scenarioVersion: 1 });
    createdRaceEventIds.push(preCountdown.raceEventId);
    await joinEvent(repo, { raceEventId: preCountdown.raceEventId, idempotencyKey: key() });
    const preResult = await requestRaceCancellation(repo, {
      raceEventId: preCountdown.raceEventId,
      callerToken: preCountdown.organizerToken,
      idempotencyKey: key(),
    });
    expect(preResult.terminalResolution).toBe("CANCELLED");

    const { created, a, b } = await setUpReadyEvent();
    const afterA = await requestRaceCancellation(repo, { raceEventId: created.raceEventId, callerToken: a.competitorToken, idempotencyKey: key() });
    expect(afterA.cancelPending).toBe(true);
    const afterB = await requestRaceCancellation(repo, { raceEventId: created.raceEventId, callerToken: b.competitorToken, idempotencyKey: key() });
    expect(afterB.terminalResolution).toBe("CANCELLED");

    const projection = await getRaceEventProjection(repo, { raceEventId: created.raceEventId, callerToken: null });
    expect(projection.terminalResolution).toBe("CANCELLED");
  }, 15000);

  it("reload reconstruction: a fresh GET_PROJECTION after moves reflects the same authoritative state with no opponent-board leakage", async () => {
    const { created, a, b } = await setUpReadyEvent();
    await applyRaceMove(repo, {
      raceEventId: created.raceEventId,
      competitorToken: a.competitorToken,
      fromTowerId: "T1",
      toTowerId: "T3",
      idempotencyKey: key(),
    });

    const reloadedA = await getRaceEventProjection(repo, { raceEventId: created.raceEventId, callerToken: a.competitorToken });
    expect(reloadedA.you?.board?.moveCount).toBe(1);

    const reloadedB = await getRaceEventProjection(repo, { raceEventId: created.raceEventId, callerToken: b.competitorToken });
    expect(reloadedB.you?.board?.moveCount).toBe(0);
    expect(JSON.stringify(reloadedB)).not.toMatch(/T3.*1|"T3":\[1\]/);
  }, 15000);
});
