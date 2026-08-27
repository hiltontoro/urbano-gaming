import { describe, expect, it } from "vitest";

import { randomUUID } from "crypto";

import { InMemoryPokerRepository } from "../lib/gaming/poker/db/inMemoryPokerRepository";
import { createTable } from "../lib/gaming/poker/createTable";
import { joinTable } from "../lib/gaming/poker/joinTable";
import { dealHand } from "../lib/gaming/poker/dealHand";
import { startHand } from "../lib/gaming/poker/startHand";
import { applyPlayerAction } from "../lib/gaming/poker/applyPlayerAction";
import { closeTable } from "../lib/gaming/poker/closeTable";
import { getTableState } from "../lib/gaming/poker/getTableState";
import { buildStandardDeck, shuffleDeck, isValidStandardDeck } from "../lib/gaming/poker/deck";
import {
  PokerTableNotFoundError,
  PokerTableFullError,
  PokerTableClosedError,
  PokerDisplayNameTakenError,
  PokerTableAccessDeniedError,
  PokerTableHasActiveHandError,
  NotEnoughSeatedPlayersError,
} from "../lib/gaming/poker/types";

async function setupTableWithThreeSeats(repo: InMemoryPokerRepository) {
  const table = await createTable(repo);
  const alex = await joinTable(repo, table.roomCode, "Alex");
  const jordan = await joinTable(repo, table.roomCode, "Jordan");
  const sam = await joinTable(repo, table.roomCode, "Sam");
  return { table, alex, jordan, sam };
}

describe("Poker Table", () => {
  it("host authority: hostToken is unique per table and returned only at creation", async () => {
    const repo = new InMemoryPokerRepository();
    const a = await createTable(repo);
    const b = await createTable(repo);
    expect(a.hostToken).not.toBe(b.hostToken);
    expect(a.roomCode).not.toBe(b.roomCode);
  });

  it("max-seat boundary: the seat past maxSeats is rejected", async () => {
    const repo = new InMemoryPokerRepository();
    const table = await createTable(repo, { maxSeats: 2 });
    await joinTable(repo, table.roomCode, "Alex");
    await joinTable(repo, table.roomCode, "Jordan");
    await expect(joinTable(repo, table.roomCode, "Sam")).rejects.toBeInstanceOf(
      PokerTableFullError
    );
  });

  it("seat uniqueness: seat numbers are allocated sequentially, no gaps, no duplicates", async () => {
    const repo = new InMemoryPokerRepository();
    const { alex, jordan, sam } = await setupTableWithThreeSeats(repo);
    expect([alex.seatNumber, jordan.seatNumber, sam.seatNumber]).toEqual([0, 1, 2]);
  });

  it("join retry with the same display name is rejected, not silently deduplicated", async () => {
    const repo = new InMemoryPokerRepository();
    const table = await createTable(repo);
    await joinTable(repo, table.roomCode, "Alex");
    await expect(joinTable(repo, table.roomCode, "alex")).rejects.toBeInstanceOf(
      PokerDisplayNameTakenError
    );
  });

  it("join while a Hand is active is still accepted, but the new seat is not part of the current Hand", async () => {
    const repo = new InMemoryPokerRepository();
    const { table } = await setupTableWithThreeSeats(repo);
    await dealHand(repo, table.pokerTableId);

    const casey = await joinTable(repo, table.roomCode, "Casey");
    const state = await getTableState(repo, table.pokerTableId, casey.participantToken);
    expect(state.myHoleCards).toBeNull();
    const caseySummary = state.seats.find((s) => s.seatNumber === casey.seatNumber);
    expect(caseySummary?.inCurrentHand).toBe(false);
  });

  it("joining a nonexistent table is rejected", async () => {
    const repo = new InMemoryPokerRepository();
    await expect(joinTable(repo, "ZZZZZZ", "Alex")).rejects.toBeInstanceOf(
      PokerTableNotFoundError
    );
  });
});

describe("Deck", () => {
  it("a standard deck has exactly 52 unique valid cards, no jokers", () => {
    const deck = buildStandardDeck();
    expect(deck).toHaveLength(52);
    expect(new Set(deck).size).toBe(52);
    expect(isValidStandardDeck(deck)).toBe(true);
  });

  it("shuffling preserves every card exactly once", () => {
    const deck = buildStandardDeck();
    const shuffled = shuffleDeck(deck);
    expect(shuffled).toHaveLength(52);
    expect(new Set(shuffled)).toEqual(new Set(deck));
    expect(isValidStandardDeck(shuffled)).toBe(true);
  });

  it("isValidStandardDeck rejects a duplicate-with-one-missing deck", () => {
    const deck = buildStandardDeck();
    const tampered = [...deck.slice(1), deck[1]]; // drops card 0, duplicates card 1
    expect(isValidStandardDeck(tampered)).toBe(false);
  });

  it("isValidStandardDeck rejects a short deck", () => {
    expect(isValidStandardDeck(buildStandardDeck().slice(0, 51))).toBe(false);
  });

  it("dealing gives exactly two hole cards to every seat included in the Hand", async () => {
    const repo = new InMemoryPokerRepository();
    const { table, alex, jordan, sam } = await setupTableWithThreeSeats(repo);
    await dealHand(repo, table.pokerTableId);

    for (const seat of [alex, jordan, sam]) {
      const state = await getTableState(repo, table.pokerTableId, seat.participantToken);
      expect(state.myHoleCards).toHaveLength(2);
    }
  });

  it("a double-tapped deal does not produce a second Hand or re-shuffle", async () => {
    const repo = new InMemoryPokerRepository();
    const { table } = await setupTableWithThreeSeats(repo);
    const first = await dealHand(repo, table.pokerTableId);
    const second = await dealHand(repo, table.pokerTableId);
    expect(first.alreadyDealt).toBe(false);
    expect(second.alreadyDealt).toBe(true);
    expect(second.pokerHandId).toBe(first.pokerHandId);
  });

  it("dealing requires at least two seated players", async () => {
    const repo = new InMemoryPokerRepository();
    const table = await createTable(repo);
    await joinTable(repo, table.roomCode, "Alex");
    await expect(dealHand(repo, table.pokerTableId)).rejects.toBeInstanceOf(
      NotEnoughSeatedPlayersError
    );
  });

  it("dealing order starts left of the dealer (lowest seat number) and wraps around", async () => {
    const repo = new InMemoryPokerRepository();
    const { table, alex, jordan, sam } = await setupTableWithThreeSeats(repo);
    const dealt = await dealHand(repo, table.pokerTableId);
    expect(dealt.dealerSeatNumber).toBe(alex.seatNumber);
    expect(dealt.dealtSeatNumbers).toEqual([jordan.seatNumber, sam.seatNumber, alex.seatNumber]);
  });
});

describe("Privacy — the load-bearing boundary", () => {
  it("each player sees exactly their own two hole cards", async () => {
    const repo = new InMemoryPokerRepository();
    const { table, alex, jordan, sam } = await setupTableWithThreeSeats(repo);
    await dealHand(repo, table.pokerTableId);

    const alexState = await getTableState(repo, table.pokerTableId, alex.participantToken);
    const jordanState = await getTableState(repo, table.pokerTableId, jordan.participantToken);
    const samState = await getTableState(repo, table.pokerTableId, sam.participantToken);

    expect(alexState.myHoleCards).toHaveLength(2);
    expect(jordanState.myHoleCards).toHaveLength(2);
    expect(samState.myHoleCards).toHaveLength(2);

    const all = [...alexState.myHoleCards!, ...jordanState.myHoleCards!, ...samState.myHoleCards!];
    expect(new Set(all).size).toBe(6);
  });

  it("no participant's payload contains any other participant's cards", async () => {
    const repo = new InMemoryPokerRepository();
    const { table, alex, jordan, sam } = await setupTableWithThreeSeats(repo);
    await dealHand(repo, table.pokerTableId);

    const alexState = await getTableState(repo, table.pokerTableId, alex.participantToken);
    const jordanState = await getTableState(repo, table.pokerTableId, jordan.participantToken);
    const samState = await getTableState(repo, table.pokerTableId, sam.participantToken);
    const alexJson = JSON.stringify(alexState);

    // Every dealt card is unique by construction (one 52-card
    // permutation, no repeats), so Jordan's and Sam's cards can never
    // legitimately coincide with Alex's own — a plain absence check is
    // sufficient and correct.
    for (const card of [...jordanState.myHoleCards!, ...samState.myHoleCards!]) {
      expect(alexJson).not.toContain(`"${card}"`);
    }
  });

  it("the host does not automatically receive any seat's hole cards", async () => {
    const repo = new InMemoryPokerRepository();
    const { table } = await setupTableWithThreeSeats(repo);
    await dealHand(repo, table.pokerTableId);

    const hostState = await getTableState(repo, table.pokerTableId, table.hostToken);
    expect(hostState.myHoleCards).toBeNull();
  });

  it("no raw deck field ever appears in any projection, for any caller", async () => {
    const repo = new InMemoryPokerRepository();
    const { table, alex } = await setupTableWithThreeSeats(repo);
    await dealHand(repo, table.pokerTableId);

    const alexState = await getTableState(repo, table.pokerTableId, alex.participantToken);
    const hostState = await getTableState(repo, table.pokerTableId, table.hostToken);

    expect(Object.keys(alexState)).not.toContain("deckOrder");
    expect(Object.keys(hostState)).not.toContain("deckOrder");
    expect(JSON.stringify(alexState)).not.toContain("deckOrder");
    expect(JSON.stringify(hostState)).not.toContain("deckOrder");
  });

  it("before any Hand is dealt, myHoleCards is null for everyone", async () => {
    const repo = new InMemoryPokerRepository();
    const { table, alex } = await setupTableWithThreeSeats(repo);
    const state = await getTableState(repo, table.pokerTableId, alex.participantToken);
    expect(state.myHoleCards).toBeNull();
  });
});

describe("Authority", () => {
  it("an unknown/invalid token is rejected with PokerTableAccessDeniedError", async () => {
    const repo = new InMemoryPokerRepository();
    const { table } = await setupTableWithThreeSeats(repo);
    await expect(
      getTableState(repo, table.pokerTableId, "not-a-real-token")
    ).rejects.toBeInstanceOf(PokerTableAccessDeniedError);
  });

  it("a seat token from one table is rejected when used against a different table", async () => {
    const repo = new InMemoryPokerRepository();
    const { alex } = await setupTableWithThreeSeats(repo);
    const otherTable = await createTable(repo);
    await expect(
      getTableState(repo, otherTable.pokerTableId, alex.participantToken)
    ).rejects.toBeInstanceOf(PokerTableAccessDeniedError);
  });

  it("GET_TABLE_STATE requesting a nonexistent table id is rejected", async () => {
    const repo = new InMemoryPokerRepository();
    await expect(
      getTableState(repo, "00000000-0000-0000-0000-000000000000", "any-token")
    ).rejects.toBeInstanceOf(PokerTableNotFoundError);
  });
});

describe("Reconnect", () => {
  it("the same participant token recovers the same seat and the same hole cards", async () => {
    const repo = new InMemoryPokerRepository();
    const { table, alex } = await setupTableWithThreeSeats(repo);
    await dealHand(repo, table.pokerTableId);

    const first = await getTableState(repo, table.pokerTableId, alex.participantToken);
    const second = await getTableState(repo, table.pokerTableId, alex.participantToken);
    expect(second.myHoleCards).toEqual(first.myHoleCards);
  });

  it("the host token recovers current table state after a reload", async () => {
    const repo = new InMemoryPokerRepository();
    const { table } = await setupTableWithThreeSeats(repo);
    const dealt = await dealHand(repo, table.pokerTableId);

    const hostState = await getTableState(repo, table.pokerTableId, table.hostToken);
    expect(hostState.currentHandId).toBe(dealt.pokerHandId);
    expect(hostState.seats).toHaveLength(3);
  });
});

describe("End Table lifecycle", () => {
  it("closing before any Hand has ever been dealt succeeds — 'between hands' includes before the first hand", async () => {
    const repo = new InMemoryPokerRepository();
    const { table } = await setupTableWithThreeSeats(repo);
    const result = await closeTable(repo, table.pokerTableId);
    expect(result.alreadyClosed).toBe(false);
    expect(result.closedAt).toBeTruthy();

    const state = await getTableState(repo, table.pokerTableId, table.hostToken);
    expect(state.closedAt).toBe(result.closedAt);
  });

  it("closing between completed hands succeeds", async () => {
    const repo = new InMemoryPokerRepository();
    const { table } = await setupTableWithThreeSeats(repo);
    const hand = await startHand(repo, table.pokerTableId);
    // Fold whoever the current actor is, twice: with 3 seated players
    // this reaches an early win (fold to one) and drives street
    // straight to COMPLETE — the same mechanism pokerGameplay.test.ts's
    // own "Early win" suite already exercises, but following the
    // server's own turn order rather than assuming dealtSeatNumbers[0]
    // is always first to act (it isn't, 3-handed).
    let actor = hand.currentActorSeatNumber!;
    let r = await applyPlayerAction(repo, {
      pokerHandId: hand.pokerHandId,
      seatNumber: actor,
      actionType: "FOLD",
      amount: null,
      idempotencyKey: randomUUID(),
    });
    actor = r.currentActorSeatNumber!;
    await applyPlayerAction(repo, {
      pokerHandId: hand.pokerHandId,
      seatNumber: actor,
      actionType: "FOLD",
      amount: null,
      idempotencyKey: randomUUID(),
    });

    const result = await closeTable(repo, table.pokerTableId);
    expect(result.alreadyClosed).toBe(false);
  });

  it("closing while a hand is active (not yet COMPLETE) is rejected", async () => {
    const repo = new InMemoryPokerRepository();
    const { table } = await setupTableWithThreeSeats(repo);
    await startHand(repo, table.pokerTableId);
    await expect(closeTable(repo, table.pokerTableId)).rejects.toBeInstanceOf(
      PokerTableHasActiveHandError
    );
  });

  it("a repeat close is idempotent — reports alreadyClosed, does not error", async () => {
    const repo = new InMemoryPokerRepository();
    const { table } = await setupTableWithThreeSeats(repo);
    const first = await closeTable(repo, table.pokerTableId);
    const second = await closeTable(repo, table.pokerTableId);
    expect(second.alreadyClosed).toBe(true);
    expect(second.closedAt).toBe(first.closedAt);
  });

  it("closing a nonexistent table is rejected", async () => {
    const repo = new InMemoryPokerRepository();
    await expect(
      closeTable(repo, "00000000-0000-0000-0000-000000000000")
    ).rejects.toBeInstanceOf(PokerTableNotFoundError);
  });

  it("a closed table rejects a new join", async () => {
    const repo = new InMemoryPokerRepository();
    const { table } = await setupTableWithThreeSeats(repo);
    await closeTable(repo, table.pokerTableId);
    await expect(joinTable(repo, table.roomCode, "Casey")).rejects.toBeInstanceOf(
      PokerTableNotFoundError
    );
  });

  it("a closed table rejects Start Hand", async () => {
    const repo = new InMemoryPokerRepository();
    const { table } = await setupTableWithThreeSeats(repo);
    await closeTable(repo, table.pokerTableId);
    await expect(startHand(repo, table.pokerTableId)).rejects.toBeInstanceOf(
      PokerTableClosedError
    );
  });

  it("a closed table rejects the legacy Deal Hand path", async () => {
    const repo = new InMemoryPokerRepository();
    const { table } = await setupTableWithThreeSeats(repo);
    await closeTable(repo, table.pokerTableId);
    await expect(dealHand(repo, table.pokerTableId)).rejects.toBeInstanceOf(
      PokerTableClosedError
    );
  });

  it("table state remains readable after closure, with final seats/stacks preserved", async () => {
    const repo = new InMemoryPokerRepository();
    const { table, alex, jordan, sam } = await setupTableWithThreeSeats(repo);
    const hand = await startHand(repo, table.pokerTableId);
    let actor = hand.currentActorSeatNumber!;
    let r = await applyPlayerAction(repo, {
      pokerHandId: hand.pokerHandId,
      seatNumber: actor,
      actionType: "FOLD",
      amount: null,
      idempotencyKey: randomUUID(),
    });
    actor = r.currentActorSeatNumber!;
    await applyPlayerAction(repo, {
      pokerHandId: hand.pokerHandId,
      seatNumber: actor,
      actionType: "FOLD",
      amount: null,
      idempotencyKey: randomUUID(),
    });

    const beforeClose = await getTableState(repo, table.pokerTableId, table.hostToken);
    const stacksBefore = beforeClose.seats.map((s) => ({ seatNumber: s.seatNumber, stack: s.stack }));

    await closeTable(repo, table.pokerTableId);

    const afterClose = await getTableState(repo, table.pokerTableId, table.hostToken);
    expect(afterClose.closedAt).not.toBeNull();
    const stacksAfter = afterClose.seats.map((s) => ({ seatNumber: s.seatNumber, stack: s.stack }));
    expect(stacksAfter).toEqual(stacksBefore);
    // Every seat identity (alex/jordan/sam) is still present and readable.
    expect(afterClose.seats.map((s) => s.seatNumber).sort()).toEqual(
      [alex.seatNumber, jordan.seatNumber, sam.seatNumber].sort()
    );
  });
});
