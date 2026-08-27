import { loadEnv } from "vite";
import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";

import { randomUUID } from "crypto";

import { SupabasePokerRepository } from "../lib/gaming/poker/db/supabasePokerRepository";
import { createTable } from "../lib/gaming/poker/createTable";
import { joinTable } from "../lib/gaming/poker/joinTable";
import { dealHand } from "../lib/gaming/poker/dealHand";
import { startHand } from "../lib/gaming/poker/startHand";
import { applyPlayerAction } from "../lib/gaming/poker/applyPlayerAction";
import { closeTable } from "../lib/gaming/poker/closeTable";
import { getTableState } from "../lib/gaming/poker/getTableState";
import {
  PokerDisplayNameTakenError,
  PokerTableAccessDeniedError,
  PokerTableHasActiveHandError,
} from "../lib/gaming/poker/types";

const env = loadEnv("development", process.cwd(), "");
const supabaseUrl = env.SUPABASE_URL;
const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error(
    "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for contract tests."
  );
}

const repo = new SupabasePokerRepository(supabaseUrl, supabaseServiceRoleKey);
const cleanupClient = createClient(supabaseUrl, supabaseServiceRoleKey);

const createdTableIds: string[] = [];

afterAll(async () => {
  // Dependency order: poker_hands and poker_seats both reference
  // poker_tables with a plain FK (no cascade) — children first.
  for (const pokerTableId of createdTableIds) {
    await cleanupClient.from("poker_hands").delete().eq("poker_table_id", pokerTableId);
    await cleanupClient.from("poker_seats").delete().eq("poker_table_id", pokerTableId);
    await cleanupClient.from("poker_tables").delete().eq("poker_table_id", pokerTableId);
  }
});

describe("SupabasePokerRepository contract", () => {
  it("full foundation pipeline against real local Postgres: table, seats, deal, privacy, reconnect", async () => {
    const table = await createTable(repo);
    createdTableIds.push(table.pokerTableId);

    const alex = await joinTable(repo, table.roomCode, "Alex");
    const jordan = await joinTable(repo, table.roomCode, "Jordan");
    const sam = await joinTable(repo, table.roomCode, "Sam");
    expect([alex.seatNumber, jordan.seatNumber, sam.seatNumber]).toEqual([0, 1, 2]);

    await expect(joinTable(repo, table.roomCode, "alex")).rejects.toBeInstanceOf(
      PokerDisplayNameTakenError
    );

    const dealt = await dealHand(repo, table.pokerTableId);
    expect(dealt.alreadyDealt).toBe(false);
    expect(dealt.dealtSeatNumbers).toEqual([1, 2, 0]);

    const dealtAgain = await dealHand(repo, table.pokerTableId);
    expect(dealtAgain.alreadyDealt).toBe(true);
    expect(dealtAgain.pokerHandId).toBe(dealt.pokerHandId);

    const alexState = await getTableState(repo, table.pokerTableId, alex.participantToken);
    const jordanState = await getTableState(repo, table.pokerTableId, jordan.participantToken);
    const samState = await getTableState(repo, table.pokerTableId, sam.participantToken);
    const hostState = await getTableState(repo, table.pokerTableId, table.hostToken);

    expect(alexState.myHoleCards).toHaveLength(2);
    expect(jordanState.myHoleCards).toHaveLength(2);
    expect(samState.myHoleCards).toHaveLength(2);
    expect(hostState.myHoleCards).toBeNull();

    const allCards = [
      ...alexState.myHoleCards!,
      ...jordanState.myHoleCards!,
      ...samState.myHoleCards!,
    ];
    expect(new Set(allCards).size).toBe(6);

    // Direct network-payload privacy inspection against the real
    // repository's actual serialization, not a UI-rendering assumption.
    const alexJson = JSON.stringify(alexState);
    for (const card of [...jordanState.myHoleCards!, ...samState.myHoleCards!]) {
      expect(alexJson).not.toContain(`"${card}"`);
    }
    expect(alexJson).not.toContain("deckOrder");
    const hostJson = JSON.stringify(hostState);
    expect(hostJson).not.toContain("deckOrder");
    for (const card of allCards) {
      expect(hostJson).not.toContain(`"${card}"`);
    }

    // Reconnect: same token, same cards.
    const alexReconnected = await getTableState(repo, table.pokerTableId, alex.participantToken);
    expect(alexReconnected.myHoleCards).toEqual(alexState.myHoleCards);

    // Unknown token rejected.
    await expect(
      getTableState(repo, table.pokerTableId, "not-a-real-token")
    ).rejects.toBeInstanceOf(PokerTableAccessDeniedError);

    // Mid-hand join: seated but no cards yet.
    const casey = await joinTable(repo, table.roomCode, "Casey");
    const caseyState = await getTableState(repo, table.pokerTableId, casey.participantToken);
    expect(caseyState.myHoleCards).toBeNull();
  }, 30000);

  it("concurrent joins against the same table allocate distinct, gapless seat numbers", async () => {
    const table = await createTable(repo);
    createdTableIds.push(table.pokerTableId);

    const results = await Promise.all(
      ["P1", "P2", "P3", "P4"].map((name) => joinTable(repo, table.roomCode, name))
    );
    const seatNumbers = results.map((r) => r.seatNumber).sort((a, b) => a - b);
    expect(seatNumbers).toEqual([0, 1, 2, 3]);
    expect(new Set(seatNumbers).size).toBe(4);
  }, 30000);

  it("concurrent double-tapped deal never produces two Hands for the same table", async () => {
    const table = await createTable(repo);
    createdTableIds.push(table.pokerTableId);
    await joinTable(repo, table.roomCode, "Alex");
    await joinTable(repo, table.roomCode, "Jordan");

    const [first, second] = await Promise.all([
      dealHand(repo, table.pokerTableId),
      dealHand(repo, table.pokerTableId),
    ]);

    // Exactly one of the two calls performed the real deal; the other
    // observed it as already dealt — never two distinct Hand rows.
    const alreadyDealtCount = [first.alreadyDealt, second.alreadyDealt].filter(Boolean).length;
    expect(alreadyDealtCount).toBe(1);
    expect(first.pokerHandId).toBe(second.pokerHandId);

    const { count } = await cleanupClient
      .from("poker_hands")
      .select("poker_hand_id", { count: "exact", head: true })
      .eq("poker_table_id", table.pokerTableId);
    expect(count).toBe(1);
  }, 30000);

  it("closeTable persists closed_at against real Postgres and is idempotent", async () => {
    const table = await createTable(repo);
    createdTableIds.push(table.pokerTableId);
    await joinTable(repo, table.roomCode, "Alex");
    await joinTable(repo, table.roomCode, "Jordan");

    const first = await closeTable(repo, table.pokerTableId);
    expect(first.alreadyClosed).toBe(false);
    expect(first.closedAt).toBeTruthy();

    const { data: row } = await cleanupClient
      .from("poker_tables")
      .select("closed_at")
      .eq("poker_table_id", table.pokerTableId)
      .single();
    expect(row?.closed_at).toBeTruthy();

    const second = await closeTable(repo, table.pokerTableId);
    expect(second.alreadyClosed).toBe(true);
    expect(second.closedAt).toBe(first.closedAt);
  }, 30000);

  it("closing a table with an active (non-COMPLETE) hand rolls back with no mutation", async () => {
    const table = await createTable(repo, { startingStack: 500, smallBlind: 5, bigBlind: 10 });
    createdTableIds.push(table.pokerTableId);
    await joinTable(repo, table.roomCode, "Alex");
    await joinTable(repo, table.roomCode, "Jordan");
    await startHand(repo, table.pokerTableId);

    await expect(closeTable(repo, table.pokerTableId)).rejects.toBeInstanceOf(
      PokerTableHasActiveHandError
    );

    const { data: row } = await cleanupClient
      .from("poker_tables")
      .select("closed_at")
      .eq("poker_table_id", table.pokerTableId)
      .single();
    expect(row?.closed_at).toBeNull();
  }, 30000);

  it("table/seat/stack history remains fully queryable after close — nothing is deleted", async () => {
    const table = await createTable(repo, { startingStack: 500, smallBlind: 5, bigBlind: 10 });
    createdTableIds.push(table.pokerTableId);
    const alex = await joinTable(repo, table.roomCode, "Alex");
    const jordan = await joinTable(repo, table.roomCode, "Jordan");
    const hand = await startHand(repo, table.pokerTableId);
    await applyPlayerAction(repo, {
      pokerHandId: hand.pokerHandId, seatNumber: hand.currentActorSeatNumber!,
      actionType: "FOLD", amount: null, idempotencyKey: randomUUID(),
    });

    await closeTable(repo, table.pokerTableId);

    const state = await getTableState(repo, table.pokerTableId, table.hostToken);
    expect(state.closedAt).toBeTruthy();
    expect(state.seats.map((s) => s.seatNumber).sort()).toEqual(
      [alex.seatNumber, jordan.seatNumber].sort()
    );
    expect(state.handResult).not.toBeNull();

    const { count: handCount } = await cleanupClient
      .from("poker_hands")
      .select("poker_hand_id", { count: "exact", head: true })
      .eq("poker_table_id", table.pokerTableId);
    expect(handCount).toBe(1);
  }, 30000);

  it("closing an already-registered Room Registry room code leaves the rooms row untouched", async () => {
    const table = await createTable(repo);
    createdTableIds.push(table.pokerTableId);
    const { data: roomBefore } = await cleanupClient
      .from("rooms")
      .select("*")
      .eq("room_code", table.roomCode)
      .maybeSingle();
    expect(roomBefore).not.toBeNull();

    await closeTable(repo, table.pokerTableId);

    const { data: roomAfter } = await cleanupClient
      .from("rooms")
      .select("*")
      .eq("room_code", table.roomCode)
      .maybeSingle();
    expect(roomAfter).toEqual(roomBefore);

    // A second table can never claim the same, now-closed, room code —
    // rooms.room_code has no closed_at awareness at all (see
    // resolveRoom.ts), so this must fail exactly like any other
    // already-issued code, not merely like an already-closed table.
    const { error } = await cleanupClient.rpc("create_poker_table_atomically", {
      p_poker_table_id: randomUUID(),
      p_room_code: table.roomCode,
      p_host_token: randomUUID(),
      p_max_seats: 6,
      p_starting_stack: 1000,
      p_small_blind: 5,
      p_big_blind: 10,
    });
    expect(error).not.toBeNull();
    expect(error?.message).toContain("rooms_room_code_unique");
  }, 30000);
});
