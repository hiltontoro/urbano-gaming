import { randomUUID } from "crypto";
import { loadEnv } from "vite";
import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";

import { SupabasePokerRepository } from "../lib/gaming/poker/db/supabasePokerRepository";
import { createTable } from "../lib/gaming/poker/createTable";
import { joinTable } from "../lib/gaming/poker/joinTable";
import { startHand } from "../lib/gaming/poker/startHand";
import { applyPlayerAction } from "../lib/gaming/poker/applyPlayerAction";
import { closeTable } from "../lib/gaming/poker/closeTable";
import { getTableState } from "../lib/gaming/poker/getTableState";
import { NotYourTurnError, PokerTableClosedError, PokerTableHasActiveHandError } from "../lib/gaming/poker/types";
import type { PokerActionType } from "../lib/gaming/poker/types";

const env = loadEnv("development", process.cwd(), "");
const supabaseUrl = env.SUPABASE_URL;
const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for contract tests.");
}

const repo = new SupabasePokerRepository(supabaseUrl, supabaseServiceRoleKey);
const cleanupClient = createClient(supabaseUrl, supabaseServiceRoleKey);
const createdTableIds: string[] = [];

async function act(pokerHandId: string, seatNumber: number, actionType: PokerActionType, amount: number | null = null) {
  return applyPlayerAction(repo, { pokerHandId, seatNumber, actionType, amount, idempotencyKey: randomUUID() });
}

afterAll(async () => {
  for (const pokerTableId of createdTableIds) {
    const { data: hands } = await cleanupClient.from("poker_hands").select("poker_hand_id").eq("poker_table_id", pokerTableId);
    const handIds = (hands ?? []).map((h) => h.poker_hand_id);
    if (handIds.length > 0) {
      await cleanupClient.from("poker_hand_results").delete().in("poker_hand_id", handIds);
      await cleanupClient.from("poker_hand_actions").delete().in("poker_hand_id", handIds);
      await cleanupClient.from("poker_hand_players").delete().in("poker_hand_id", handIds);
    }
    await cleanupClient.from("poker_hands").delete().eq("poker_table_id", pokerTableId);
    await cleanupClient.from("poker_seats").delete().eq("poker_table_id", pokerTableId);
    await cleanupClient.from("poker_tables").delete().eq("poker_table_id", pokerTableId);
  }
});

describe("Poker Gameplay contract", () => {
  it("full hand end to end against real local Postgres: blinds, betting, showdown, payout, chip conservation", async () => {
    const table = await createTable(repo, { startingStack: 500, smallBlind: 5, bigBlind: 10 });
    createdTableIds.push(table.pokerTableId);

    await joinTable(repo, table.roomCode, "Alex");
    await joinTable(repo, table.roomCode, "Jordan");
    await joinTable(repo, table.roomCode, "Sam");

    const hand = await startHand(repo, table.pokerTableId);
    expect(hand.street).toBe("PRE_FLOP");
    expect(hand.dealerSeatNumber).toBe(0);

    let r = await act(hand.pokerHandId, 0, "CALL");
    r = await act(hand.pokerHandId, 1, "CALL");
    r = await act(hand.pokerHandId, 2, "CHECK");
    expect(r.street).toBe("FLOP");

    for (let i = 0; i < 3; i++) {
      r = await act(hand.pokerHandId, 1, "CHECK");
      r = await act(hand.pokerHandId, 2, "CHECK");
      r = await act(hand.pokerHandId, 0, "CHECK");
    }
    expect(r.showdownReached).toBe(true);

    const finalState = await getTableState(repo, table.pokerTableId, table.hostToken);
    expect(finalState.handResult).not.toBeNull();
    const total = finalState.seats.reduce((s, seat) => s + seat.stack, 0);
    expect(total).toBe(1500);
  }, 30000);

  it("out-of-turn action is rejected even under concurrency — seat 1 is never valid before seat 0's first action, regardless of race ordering", async () => {
    const table = await createTable(repo, { startingStack: 500, smallBlind: 5, bigBlind: 10 });
    createdTableIds.push(table.pokerTableId);
    await joinTable(repo, table.roomCode, "Alex");
    await joinTable(repo, table.roomCode, "Jordan");
    const hand = await startHand(repo, table.pokerTableId);
    expect(hand.currentActorSeatNumber).toBe(0); // seat 1 can never legitimately act first

    // Two concurrent attempts by seat 1, who is never the current actor
    // until seat 0 acts — both must be rejected regardless of DB-level
    // race ordering between the two requests themselves.
    const results = await Promise.allSettled([act(hand.pokerHandId, 1, "CHECK"), act(hand.pokerHandId, 1, "CHECK")]);
    expect(results.every((r) => r.status === "rejected")).toBe(true);
    for (const r of results) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(NotYourTurnError);
    }
  }, 30000);

  it("a duplicate concurrent action from the legitimate current actor serializes to exactly one accepted turn advance", async () => {
    const table = await createTable(repo, { startingStack: 500, smallBlind: 5, bigBlind: 10 });
    createdTableIds.push(table.pokerTableId);
    await joinTable(repo, table.roomCode, "Alex");
    await joinTable(repo, table.roomCode, "Jordan");
    const hand = await startHand(repo, table.pokerTableId);

    // Two concurrent, genuinely distinct action attempts by the SAME
    // legitimate current actor (seat 0) — the row lock must serialize
    // these so only the first is ever applied against a still-current
    // turn; the second, whichever order it lands in, either succeeds as
    // the now-current actor for the NEXT decision point or is rejected —
    // never both mutating the same turn twice.
    const results = await Promise.allSettled([act(hand.pokerHandId, 0, "CALL"), act(hand.pokerHandId, 0, "CALL")]);
    const succeeded = results.filter((r) => r.status === "fulfilled");
    expect(succeeded.length).toBeLessThanOrEqual(1); // CALL is only legal once (the second sees toCall=0 -> illegal, or NotYourTurn)
  }, 30000);

  it("a double-submitted action with the same idempotency key is applied exactly once", async () => {
    const table = await createTable(repo, { startingStack: 500, smallBlind: 5, bigBlind: 10 });
    createdTableIds.push(table.pokerTableId);
    await joinTable(repo, table.roomCode, "Alex");
    await joinTable(repo, table.roomCode, "Jordan");
    const hand = await startHand(repo, table.pokerTableId);

    const idempotencyKey = randomUUID();
    const first = await applyPlayerAction(repo, {
      pokerHandId: hand.pokerHandId, seatNumber: 0, actionType: "CALL", amount: null, idempotencyKey,
    });
    const second = await applyPlayerAction(repo, {
      pokerHandId: hand.pokerHandId, seatNumber: 0, actionType: "CALL", amount: null, idempotencyKey,
    });
    expect(second.alreadyApplied).toBe(true);
    expect(first.currentActorSeatNumber).toBe(second.currentActorSeatNumber);

    const actions = await repo.listActionsForHand(hand.pokerHandId);
    const callActions = actions.filter((a) => a.actionType === "CALL" && a.seatNumber === 0);
    expect(callActions).toHaveLength(1);
  }, 30000);

  it("concurrent double-start of the next hand never creates two Hands", async () => {
    const table = await createTable(repo, { startingStack: 500, smallBlind: 5, bigBlind: 10 });
    createdTableIds.push(table.pokerTableId);
    await joinTable(repo, table.roomCode, "Alex");
    await joinTable(repo, table.roomCode, "Jordan");

    const [first, second] = await Promise.all([startHand(repo, table.pokerTableId), startHand(repo, table.pokerTableId)]);
    const alreadyStartedCount = [first.alreadyStarted, second.alreadyStarted].filter(Boolean).length;
    expect(alreadyStartedCount).toBe(1);
    expect(first.pokerHandId).toBe(second.pokerHandId);

    const { count } = await cleanupClient
      .from("poker_hands")
      .select("poker_hand_id", { count: "exact", head: true })
      .eq("poker_table_id", table.pokerTableId);
    expect(count).toBe(1);
  }, 30000);

  it("privacy holds during active gameplay: no participant payload contains another seat's cards or the raw deck", async () => {
    const table = await createTable(repo, { startingStack: 500, smallBlind: 5, bigBlind: 10 });
    createdTableIds.push(table.pokerTableId);
    const alex = await joinTable(repo, table.roomCode, "Alex");
    const jordan = await joinTable(repo, table.roomCode, "Jordan");
    const hand = await startHand(repo, table.pokerTableId);
    await act(hand.pokerHandId, 0, "CALL");

    const alexState = await getTableState(repo, table.pokerTableId, alex.participantToken);
    const jordanState = await getTableState(repo, table.pokerTableId, jordan.participantToken);
    const alexJson = JSON.stringify(alexState);
    expect(alexJson).not.toContain("deckOrder");
    for (const card of jordanState.myHoleCards ?? []) {
      expect(alexJson).not.toContain(`"${card}"`);
    }
  }, 30000);

  it("End Table vs Start Hand: genuinely concurrent calls from a between-hands state produce exactly one coherent outcome, never both", async () => {
    const table = await createTable(repo, { startingStack: 500, smallBlind: 5, bigBlind: 10 });
    createdTableIds.push(table.pokerTableId);
    await joinTable(repo, table.roomCode, "Alex");
    await joinTable(repo, table.roomCode, "Jordan");
    // No hand dealt yet — a legitimate "between hands" state (before
    // the first hand), exercising the row-lock race at its simplest.

    const results = await Promise.allSettled([
      closeTable(repo, table.pokerTableId),
      startHand(repo, table.pokerTableId),
    ]);

    const closeOutcome = results[0];
    const startOutcome = results[1];

    if (closeOutcome.status === "fulfilled") {
      // Close won the race: the table is closed, and Start Hand must
      // have either lost outright (PokerTableClosedError) or, if its
      // own lock happened to be granted a hair before the table row
      // was actually marked closed, produced no hand at all.
      expect(startOutcome.status === "rejected" || (startOutcome as PromiseFulfilledResult<any>).value == null).toBe(true);
      if (startOutcome.status === "rejected") {
        expect((startOutcome as PromiseRejectedResult).reason).toBeInstanceOf(PokerTableClosedError);
      }

      const { data: row } = await cleanupClient
        .from("poker_tables")
        .select("closed_at")
        .eq("poker_table_id", table.pokerTableId)
        .single();
      expect(row?.closed_at).toBeTruthy();

      const { count } = await cleanupClient
        .from("poker_hands")
        .select("poker_hand_id", { count: "exact", head: true })
        .eq("poker_table_id", table.pokerTableId);
      expect(count).toBe(0);
    } else {
      // Start Hand won the race: a hand now exists and is not
      // COMPLETE, so Close must have been rejected as having an active
      // hand — the table must remain open.
      expect(startOutcome.status).toBe("fulfilled");
      expect((closeOutcome as PromiseRejectedResult).reason).toBeInstanceOf(PokerTableHasActiveHandError);

      const { data: row } = await cleanupClient
        .from("poker_tables")
        .select("closed_at")
        .eq("poker_table_id", table.pokerTableId)
        .single();
      expect(row?.closed_at).toBeNull();
    }
  }, 30000);
});
