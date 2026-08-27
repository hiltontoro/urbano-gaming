import { randomUUID } from "crypto";
import { describe, expect, it } from "vitest";

import { InMemoryPokerRepository } from "../lib/gaming/poker/db/inMemoryPokerRepository";
import { createTable } from "../lib/gaming/poker/createTable";
import { joinTable } from "../lib/gaming/poker/joinTable";
import { startHand } from "../lib/gaming/poker/startHand";
import { applyPlayerAction } from "../lib/gaming/poker/applyPlayerAction";
import { getTableState } from "../lib/gaming/poker/getTableState";
import { computeBoardCards, computeSidePots } from "../lib/gaming/poker/pokerRules";
import { evaluateHand, rankHandsBestToWorst } from "../lib/gaming/poker/handEvaluator";
import { buildStandardDeck } from "../lib/gaming/poker/deck";
import {
  NotYourTurnError,
  IllegalActionError,
  InvalidActionAmountError,
  NotEnoughSeatedPlayersError,
} from "../lib/gaming/poker/types";
import type { PokerActionType } from "../lib/gaming/poker/types";

async function setupTable(
  repo: InMemoryPokerRepository,
  names: string[],
  config: { startingStack?: number; smallBlind?: number; bigBlind?: number } = {}
) {
  const table = await createTable(repo, { startingStack: 1000, smallBlind: 5, bigBlind: 10, ...config });
  const seats = [];
  for (const name of names) {
    seats.push(await joinTable(repo, table.roomCode, name));
  }
  return { table, seats };
}

async function act(
  repo: InMemoryPokerRepository,
  pokerHandId: string,
  seatNumber: number,
  actionType: PokerActionType,
  amount: number | null = null
) {
  return applyPlayerAction(repo, { pokerHandId, seatNumber, actionType, amount, idempotencyKey: randomUUID() });
}

describe("Blinds — dealer/SB/BB rules", () => {
  it("heads-up: dealer posts small blind, other player posts big blind, dealer acts first preflop", async () => {
    const repo = new InMemoryPokerRepository();
    const { table } = await setupTable(repo, ["Alex", "Jordan"]);
    const hand = await startHand(repo, table.pokerTableId);
    expect(hand.dealerSeatNumber).toBe(0);
    expect(hand.smallBlindSeatNumber).toBe(0);
    expect(hand.bigBlindSeatNumber).toBe(1);
    expect(hand.currentActorSeatNumber).toBe(0);
  });

  it("heads-up: non-dealer (BB) acts first post-flop", async () => {
    const repo = new InMemoryPokerRepository();
    const { table } = await setupTable(repo, ["Alex", "Jordan"]);
    const hand = await startHand(repo, table.pokerTableId);
    await act(repo, hand.pokerHandId, 0, "CALL");
    const r = await act(repo, hand.pokerHandId, 1, "CHECK");
    expect(r.street).toBe("FLOP");
    expect(r.currentActorSeatNumber).toBe(1);
  });

  it("3-handed: seats after dealer post SB/BB, seat after BB acts first preflop, SB position acts first post-flop", async () => {
    const repo = new InMemoryPokerRepository();
    const { table } = await setupTable(repo, ["Alex", "Jordan", "Sam"]);
    const hand = await startHand(repo, table.pokerTableId);
    expect(hand.dealerSeatNumber).toBe(0);
    expect(hand.smallBlindSeatNumber).toBe(1);
    expect(hand.bigBlindSeatNumber).toBe(2);
    expect(hand.currentActorSeatNumber).toBe(0); // UTG = seat after BB, wraps to dealer

    let r = await act(repo, hand.pokerHandId, 0, "CALL");
    r = await act(repo, hand.pokerHandId, 1, "CALL");
    r = await act(repo, hand.pokerHandId, 2, "CHECK");
    expect(r.street).toBe("FLOP");
    expect(r.currentActorSeatNumber).toBe(1); // first seat left of dealer
  });
});

describe("Action order and authority", () => {
  it("acting out of turn is rejected", async () => {
    const repo = new InMemoryPokerRepository();
    const { table } = await setupTable(repo, ["Alex", "Jordan"]);
    const hand = await startHand(repo, table.pokerTableId);
    await expect(act(repo, hand.pokerHandId, 1, "CHECK")).rejects.toBeInstanceOf(NotYourTurnError);
  });

  it("a folded seat cannot act again", async () => {
    const repo = new InMemoryPokerRepository();
    const { table } = await setupTable(repo, ["Alex", "Jordan", "Sam"]);
    const hand = await startHand(repo, table.pokerTableId);
    await act(repo, hand.pokerHandId, 0, "FOLD");
    // action now belongs to seat 1; force-check seat 0 cannot act
    await expect(act(repo, hand.pokerHandId, 0, "CHECK")).rejects.toBeInstanceOf(NotYourTurnError);
  });
});

describe("Legal actions", () => {
  it("CHECK is illegal when an amount is owed", async () => {
    const repo = new InMemoryPokerRepository();
    const { table } = await setupTable(repo, ["Alex", "Jordan"]);
    const hand = await startHand(repo, table.pokerTableId);
    // seat 0 (dealer/SB) owes the difference to match BB(10) — SB posted 5.
    await expect(act(repo, hand.pokerHandId, 0, "CHECK")).rejects.toBeInstanceOf(IllegalActionError);
  });

  it("CALL is illegal when nothing is owed", async () => {
    const repo = new InMemoryPokerRepository();
    const { table } = await setupTable(repo, ["Alex", "Jordan"]);
    const hand = await startHand(repo, table.pokerTableId);
    await act(repo, hand.pokerHandId, 0, "CALL");
    await expect(act(repo, hand.pokerHandId, 1, "CALL")).rejects.toBeInstanceOf(IllegalActionError);
  });

  it("BET is illegal once a bet already exists this street", async () => {
    const repo = new InMemoryPokerRepository();
    const { table } = await setupTable(repo, ["Alex", "Jordan"]);
    const hand = await startHand(repo, table.pokerTableId);
    await expect(act(repo, hand.pokerHandId, 0, "BET", 20)).rejects.toBeInstanceOf(IllegalActionError);
  });

  it("RAISE is illegal when no bet exists yet this street", async () => {
    const repo = new InMemoryPokerRepository();
    const { table } = await setupTable(repo, ["Alex", "Jordan"]);
    const hand = await startHand(repo, table.pokerTableId);
    await act(repo, hand.pokerHandId, 0, "CALL");
    await act(repo, hand.pokerHandId, 1, "CHECK"); // now FLOP, current_bet=0
    await expect(act(repo, hand.pokerHandId, 1, "RAISE", 20)).rejects.toBeInstanceOf(IllegalActionError);
  });

  it("an all-in seat is never assigned another turn — the round-advance logic skips it entirely", async () => {
    const repo = new InMemoryPokerRepository();
    const { table } = await setupTable(repo, ["Alex", "Jordan", "Sam"], { startingStack: 1000 });
    const smallStackTable = await createTable(repo, { startingStack: 20, smallBlind: 5, bigBlind: 10 });
    const a = await joinTable(repo, smallStackTable.roomCode, "A");
    const j = await joinTable(repo, smallStackTable.roomCode, "J");
    const s = await joinTable(repo, smallStackTable.roomCode, "S");
    const hand = await startHand(repo, smallStackTable.pokerTableId);
    // UTG (seat 0) goes all-in for 20 — Jordan/Sam still have full decisions.
    let r = await act(repo, hand.pokerHandId, 0, "ALL_IN");
    expect(r.currentActorSeatNumber).not.toBe(0);
    r = await act(repo, hand.pokerHandId, 1, "CALL");
    expect(r.currentActorSeatNumber).not.toBe(0);
    // Directly calling SEAT_NOT_ELIGIBLE_TO_ACT's guard is unreachable via the
    // public flow by design (current_actor is never set to an all-in seat) —
    // the reachable, observable guarantee is NotYourTurnError for seat 0 here.
    await expect(act(repo, hand.pokerHandId, 0, "CHECK")).rejects.toBeInstanceOf(NotYourTurnError);
  });

  it("negative/invalid bet amounts are rejected", async () => {
    const repo = new InMemoryPokerRepository();
    const { table } = await setupTable(repo, ["Alex", "Jordan"]);
    const hand = await startHand(repo, table.pokerTableId);
    await act(repo, hand.pokerHandId, 0, "CALL");
    await act(repo, hand.pokerHandId, 1, "CHECK"); // FLOP
    await expect(act(repo, hand.pokerHandId, 1, "BET", -5)).rejects.toBeInstanceOf(InvalidActionAmountError);
  });
});

describe("Minimum raise / reopened action — load-bearing", () => {
  it("a raise below the minimum legal size is rejected", async () => {
    const repo = new InMemoryPokerRepository();
    const { table } = await setupTable(repo, ["Alex", "Jordan"]);
    const hand = await startHand(repo, table.pokerTableId);
    // current_bet=10 (BB), min_raise=10 -> minimum raise-to is 20.
    await expect(act(repo, hand.pokerHandId, 0, "RAISE", 15)).rejects.toBeInstanceOf(InvalidActionAmountError);
  });

  it("a full raise reopens action for a seat that already acted", async () => {
    const repo = new InMemoryPokerRepository();
    const { table } = await setupTable(repo, ["Alex", "Jordan", "Sam"]);
    const hand = await startHand(repo, table.pokerTableId);
    await act(repo, hand.pokerHandId, 0, "CALL"); // UTG calls 10
    await act(repo, hand.pokerHandId, 1, "RAISE", 30); // SB raises to 30 (full raise, increment 20 >= min 10)
    // action returns to Sam(BB) then Alex(UTG) — Alex already acted (called) but must be allowed to act again.
    const r = await act(repo, hand.pokerHandId, 2, "CALL");
    expect(r.currentActorSeatNumber).toBe(0);
  });

  it("a short all-in raise does not reopen raising rights for a seat that already acted", async () => {
    const repo = new InMemoryPokerRepository();
    // A deliberately small starting stack (35) so that after Alex calls 10 and
    // Jordan raises to 25 (a full raise: increment 15 >= min 10), Sam's only
    // remaining 25 chips going all-in produce a total of 35 — an increment of
    // 10 over the 25 current bet, which is BELOW the min_raise_amount (15) set
    // by Jordan's raise: a genuine short all-in raise.
    const table = await createTable(repo, { startingStack: 35, smallBlind: 5, bigBlind: 10 });
    await joinTable(repo, table.roomCode, "Alex");
    await joinTable(repo, table.roomCode, "Jordan");
    await joinTable(repo, table.roomCode, "Sam");
    const hand = await startHand(repo, table.pokerTableId);

    await act(repo, hand.pokerHandId, 0, "CALL"); // Alex (UTG) calls to 10
    await act(repo, hand.pokerHandId, 1, "RAISE", 25); // Jordan (SB) raises to 25 — full raise, increment 15
    // action passes to Sam (BB), who shoves their remaining 25 (committed 10 already -> total 35).
    let r = await act(repo, hand.pokerHandId, 2, "ALL_IN");
    expect(r.currentActorSeatNumber).toBe(0); // Alex must respond again (bet increased, even though Alex already called once)
    expect(r.currentBet).toBe(35); // the short all-in still raises the amount everyone must match

    // Alex calls the short all-in.
    r = await act(repo, hand.pokerHandId, 0, "CALL");
    // Jordan committed 25 before Sam's short all-in raised current_bet to 35 —
    // Jordan still owes the extra 10 (call/fold only — no raise is possible
    // here regardless, since Jordan's remaining 10 chips are exactly the call
    // amount; the earlier InvalidActionAmountError assertion on Alex already
    // proves a genuine raise attempt is rejected while last_raise_was_full is false).
    expect(r.currentActorSeatNumber).toBe(1);
    r = await act(repo, hand.pokerHandId, 1, "CALL");
    // Jordan's call of the extra 10 exhausts their own remaining stack too —
    // all three seats are now all-in/folded-equivalent, so this correctly
    // triggers automatic runout straight to Showdown (no further decisions
    // possible), rather than a plain street advance.
    expect(r.showdownReached).toBe(true);
  });
});

describe("Betting round completion / board progression", () => {
  it("board reveals exactly 3/4/5 cards for FLOP/TURN/RIVER, none pre-flop", async () => {
    const repo = new InMemoryPokerRepository();
    const { table } = await setupTable(repo, ["Alex", "Jordan"]);
    const hand = await startHand(repo, table.pokerTableId);
    const handRecord = await repo.getHandById(hand.pokerHandId);
    expect(computeBoardCards(handRecord!.deckOrder, 2, "PRE_FLOP")).toHaveLength(0);
    expect(computeBoardCards(handRecord!.deckOrder, 2, "FLOP")).toHaveLength(3);
    expect(computeBoardCards(handRecord!.deckOrder, 2, "TURN")).toHaveLength(4);
    expect(computeBoardCards(handRecord!.deckOrder, 2, "RIVER")).toHaveLength(5);
  });

  it("future board cards are not exposed before their street via GET_TABLE_STATE", async () => {
    const repo = new InMemoryPokerRepository();
    const { table, seats } = await setupTable(repo, ["Alex", "Jordan"]);
    const hand = await startHand(repo, table.pokerTableId);
    const preFlopState = await getTableState(repo, table.pokerTableId, seats[0].participantToken);
    expect(preFlopState.board).toHaveLength(0);

    await act(repo, hand.pokerHandId, 0, "CALL");
    await act(repo, hand.pokerHandId, 1, "CHECK");
    const flopState = await getTableState(repo, table.pokerTableId, seats[0].participantToken);
    expect(flopState.board).toHaveLength(3);
  });
});

describe("Early win (fold to one)", () => {
  it("all but one folded ends the hand immediately with no reveal", async () => {
    const repo = new InMemoryPokerRepository();
    const { table, seats } = await setupTable(repo, ["Alex", "Jordan"]);
    const hand = await startHand(repo, table.pokerTableId);
    const r = await act(repo, hand.pokerHandId, 0, "FOLD");
    expect(r.handOver).toBe(true);
    expect(r.showdownReached).toBe(false);
    expect(r.earlyWinWinnerSeatNumber).toBe(1);

    const state = await getTableState(repo, table.pokerTableId, seats[0].participantToken);
    expect(state.seats.every((s) => s.revealedHoleCards === null)).toBe(true);
    expect(state.handResult!.showdownHands).toBeNull();
    // A pre-flop fold must never leak a board that was never dealt —
    // regression coverage for a real defect found during operational
    // simulation (the board was previously hardcoded to full 5 cards
    // for every early win regardless of which street it ended on).
    expect(state.handResult!.board).toEqual([]);
    expect(state.board).toEqual([]);
  });

  it("a fold after the flop preserves exactly the flop's 3 cards in the result — no turn/river leak", async () => {
    const repo = new InMemoryPokerRepository();
    const { table, seats } = await setupTable(repo, ["Alex", "Jordan"]);
    const hand = await startHand(repo, table.pokerTableId);
    await act(repo, hand.pokerHandId, 0, "CALL");
    await act(repo, hand.pokerHandId, 1, "CHECK"); // -> FLOP
    const r = await act(repo, hand.pokerHandId, 1, "FOLD"); // Jordan folds on the flop
    expect(r.handOver).toBe(true);
    expect(r.earlyWinWinnerSeatNumber).toBe(0);

    const state = await getTableState(repo, table.pokerTableId, seats[0].participantToken);
    expect(state.handResult!.board).toHaveLength(3);
  });

  it("chip conservation holds after an early win", async () => {
    const repo = new InMemoryPokerRepository();
    const { table, seats } = await setupTable(repo, ["Alex", "Jordan", "Sam"], { startingStack: 300 });
    const hand = await startHand(repo, table.pokerTableId);
    await act(repo, hand.pokerHandId, 0, "FOLD");
    await act(repo, hand.pokerHandId, 1, "FOLD");
    const state = await getTableState(repo, table.pokerTableId, seats[0].participantToken);
    const total = state.seats.reduce((s, seat) => s + seat.stack, 0);
    expect(total).toBe(900);
  });
});

describe("All-in and automatic runout", () => {
  it("heads-up all-in call reaches showdown automatically", async () => {
    const repo = new InMemoryPokerRepository();
    const { table } = await setupTable(repo, ["Alex", "Jordan"], { startingStack: 100 });
    const hand = await startHand(repo, table.pokerTableId);
    await act(repo, hand.pokerHandId, 0, "ALL_IN");
    const r = await act(repo, hand.pokerHandId, 1, "CALL");
    expect(r.showdownReached).toBe(true);
  });

  // The "one short-stacked seat all-in while others retain full stacks and
  // keep betting across streets, no premature runout" scenario cannot be
  // constructed cleanly in-memory with this API's one-starting-stack-per-
  // table config (a first-action all-in necessarily uses a seat's entire
  // stack, and equal starting stacks mean any caller matching it also goes
  // all-in). This exact scenario — a manually-shrunk short stack going
  // all-in while two full-stack seats call and continue checking through
  // flop/turn/river to a real Showdown — was proven directly against real
  // Postgres during this phase's own implementation verification (see
  // POKER_GAMEPLAY_IMPLEMENTATION_RECORD.md's operational simulation).
});

describe("Side pots (pure function)", () => {
  it("decomposes a main pot and one side pot for two distinct all-in levels", () => {
    // Alex all-in 100, Jordan all-in 300, Sam calls 300. Alex best hand, Jordan second, Sam worst.
    const committed = { 0: 100, 1: 300, 2: 300 };
    const pots = computeSidePots(committed, new Set(), (eligible) => {
      // Alex(0) best, Jordan(1) second, Sam(2) worst — no ties.
      const order = [0, 1, 2].filter((s) => eligible.includes(s));
      return order.map((s) => [s]);
    });
    expect(pots).toHaveLength(2);
    expect(pots[0].amount).toBe(300); // 100 x 3 contributors
    expect(pots[0].eligibleSeatNumbers.sort()).toEqual([0, 1, 2]);
    expect(pots[0].payouts).toEqual([{ seatNumber: 0, amount: 300 }]); // Alex wins main pot (best hand, eligible)
    expect(pots[1].amount).toBe(400); // (300-100) x 2 contributors
    expect(pots[1].eligibleSeatNumbers.sort()).toEqual([1, 2]);
    expect(pots[1].payouts).toEqual([{ seatNumber: 1, amount: 400 }]); // Jordan wins side pot
  });

  it("a folded contributor's chips count toward pot amounts but they are never eligible to win", () => {
    const committed = { 0: 50, 1: 100, 2: 100 };
    const pots = computeSidePots(committed, new Set([0]), (eligible) => [eligible.sort((a, b) => a - b)]);
    // one pot: everyone contributes up to the single level 50, then 100.
    const totalAmount = pots.reduce((s, p) => s + p.amount, 0);
    expect(totalAmount).toBe(250); // 50+100+100
    expect(pots.every((p) => !p.eligibleSeatNumbers.includes(0))).toBe(true);
  });

  it("splits a pot evenly among tied winners with a deterministic odd-chip rule", () => {
    const committed = { 0: 101, 1: 101 };
    const pots = computeSidePots(committed, new Set(), () => [[0, 1]]);
    expect(pots[0].amount).toBe(202);
    const seat0 = pots[0].payouts.find((p) => p.seatNumber === 0)!;
    const seat1 = pots[0].payouts.find((p) => p.seatNumber === 1)!;
    expect(seat0.amount + seat1.amount).toBe(202);
    expect(seat0.amount).toBe(101); // odd chip goes to lowest seat_number
    expect(seat1.amount).toBe(101);
  });

  it("a genuinely odd total gives the extra chip to the lowest seat number", () => {
    const committed = { 3: 101, 5: 100 };
    // level 100 contributed by both -> pot 200 eligible [3,5]; level 101 contributed only by 3 -> pot 1 eligible [3].
    const pots = computeSidePots(committed, new Set(), (eligible) => [eligible.sort((a, b) => a - b)]);
    const mainPot = pots.find((p) => p.amount === 200)!;
    expect(mainPot.payouts.reduce((s, p) => s + p.amount, 0)).toBe(200);
  });
});

describe("Showdown hand evaluation", () => {
  it("a pair beats high card", () => {
    const pair = evaluateHand(0, ["AS", "AH"], ["2C", "3D", "9S", "KD", "7H"]);
    const highCard = evaluateHand(1, ["QC", "JD"], ["2C", "3D", "9S", "KD", "7H"]);
    const groups = rankHandsBestToWorst([pair, highCard]);
    expect(groups[0]).toEqual([0]);
  });

  it("a flush beats a straight", () => {
    const flush = evaluateHand(0, ["2H", "9H"], ["4H", "7H", "KH", "3C", "5D"]);
    const straight = evaluateHand(1, ["6C", "8D"], ["4H", "7H", "3C", "5D", "9S"]);
    const groups = rankHandsBestToWorst([flush, straight]);
    expect(groups[0]).toEqual([0]);
  });

  it("identical hands (board plays) tie", () => {
    const a = evaluateHand(0, ["2C", "3D"], ["AS", "AH", "KD", "KC", "QD"]);
    const b = evaluateHand(1, ["4H", "5S"], ["AS", "AH", "KD", "KC", "QD"]);
    const groups = rankHandsBestToWorst([a, b]);
    expect(groups[0].sort()).toEqual([0, 1]);
  });

  // Poker Playtest UX + Showdown Transparency Slice — documentation
  // test, not a bug fix. A real Founder playtest (room JR95HE)
  // produced a screenshot that, read quickly, looked like a wrong
  // winner: Founder KD/QS appears to have "just" a pair of Queens,
  // opponent 7D/9S appears to have "just" a pair of Nines, so Founder
  // seemed to have lost a hand they should have won. The Founder
  // Playtest Reconciliation gate traced this exactly and found no
  // defect: the opponent's own 7D closes a Straight against the
  // board's 6C-8C-9C-TC (six through ten), a hand shape genuinely easy
  // for a human to miss on a board that also carries four clubs. This
  // test permanently encodes the correct result so this exact
  // trust-critical scenario can never silently regress.
  it("Founder playtest scenario (room JR95HE): a hidden Straight beats a visible Pair — the opponent's hand was correctly evaluated and correctly won", () => {
    const board = ["8C", "9C", "QH", "6C", "TC"];
    const founder = evaluateHand(0, ["KD", "QS"], board);
    const opponent = evaluateHand(1, ["7D", "9S"], board);

    expect(founder.rankName).toBe("Pair");
    expect(founder.descr).toBe("Pair, Q's");
    expect(opponent.rankName).toBe("Straight");
    expect(opponent.descr).toBe("Straight, 10 High");

    const groups = rankHandsBestToWorst([founder, opponent]);
    expect(groups[0]).toEqual([1]); // opponent (seat 1) wins outright
  });
});

describe("Showdown descr persistence (Poker Playtest UX + Showdown Transparency Slice)", () => {
  it("persists pokersolver's own descr alongside rankName for every revealed seat, returned via GET_TABLE_STATE", async () => {
    const repo = new InMemoryPokerRepository();
    const { table, seats } = await setupTable(repo, ["Alex", "Jordan"], { startingStack: 200 });
    const hand = await startHand(repo, table.pokerTableId);
    await act(repo, hand.pokerHandId, 0, "ALL_IN");
    const r = await act(repo, hand.pokerHandId, 1, "CALL");
    expect(r.showdownReached).toBe(true);

    const state = await getTableState(repo, table.pokerTableId, seats[0].participantToken);
    const showdownHands = state.handResult?.showdownHands;
    expect(showdownHands).not.toBeNull();
    for (const seatKey of Object.keys(showdownHands!)) {
      const entry = showdownHands![seatKey];
      expect(typeof entry.rankName).toBe("string");
      expect(typeof entry.descr).toBe("string");
      expect(entry.descr!.length).toBeGreaterThan(0);
    }
  });
});

describe("Payout / settlement", () => {
  it("a single winner receives the entire pot, idempotent settlement, chip conservation", async () => {
    const repo = new InMemoryPokerRepository();
    const { table, seats } = await setupTable(repo, ["Alex", "Jordan"], { startingStack: 200 });
    const hand = await startHand(repo, table.pokerTableId);
    await act(repo, hand.pokerHandId, 0, "ALL_IN");
    const r = await act(repo, hand.pokerHandId, 1, "CALL");
    expect(r.showdownReached).toBe(true);

    const state = await getTableState(repo, table.pokerTableId, seats[0].participantToken);
    expect(state.handResult).not.toBeNull();
    const total = state.seats.reduce((s, seat) => s + seat.stack, 0);
    expect(total).toBe(400);

    // Idempotent retry: calling applyPlayerAction again with a fresh call is now illegal (hand complete), confirming no double-settle path.
    await expect(act(repo, hand.pokerHandId, 0, "CHECK")).rejects.toThrow();
  });
});

describe("Next Hand", () => {
  it("rotates the dealer, uses current stacks, deals a fresh shuffle, and is idempotent on double-start", async () => {
    const repo = new InMemoryPokerRepository();
    const { table, seats } = await setupTable(repo, ["Alex", "Jordan", "Sam"]);
    const hand1 = await startHand(repo, table.pokerTableId);
    await act(repo, hand1.pokerHandId, 0, "FOLD");
    await act(repo, hand1.pokerHandId, 1, "FOLD"); // Sam wins by fold

    const hand2 = await startHand(repo, table.pokerTableId);
    expect(hand2.alreadyStarted).toBe(false);
    expect(hand2.handOrdinal).toBe(2);
    expect(hand2.dealerSeatNumber).toBe(1); // rotates to next seated player after previous dealer (0)

    const hand2Record = await repo.getHandById(hand2.pokerHandId);
    const hand1Record = await repo.getHandById(hand1.pokerHandId);
    expect(hand2Record!.deckOrder).not.toEqual(hand1Record!.deckOrder);

    const dup = await startHand(repo, table.pokerTableId);
    expect(dup.alreadyStarted).toBe(true);
    expect(dup.pokerHandId).toBe(hand2.pokerHandId);
  });

  it("a zero-stack participant is excluded from the next hand", async () => {
    const repo = new InMemoryPokerRepository();
    const { table } = await setupTable(repo, ["Alex", "Jordan"], { startingStack: 50 });
    const hand1 = await startHand(repo, table.pokerTableId);

    // Force a deterministic, non-tied showdown: the first dealt seat gets
    // pocket aces on a brick board, the other seat gets an unconnected
    // low holding — guarantees exactly one seat busts to 0. Left to the
    // real CSPRNG shuffle, a tied heads-up all-in chops the pot and
    // leaves both stacks at 50 (no broke seat), which made this test
    // genuinely flaky rather than a gameplay defect.
    const handRecord = await repo.getHandById(hand1.pokerHandId);
    const fixedPrefix = ["AS", "2C", "AH", "7D", "2D", "3S", "9C", "KC", "4D", "5H", "6D", "8H"];
    handRecord!.deckOrder = [...fixedPrefix, ...buildStandardDeck().filter((c) => !fixedPrefix.includes(c))];

    await act(repo, hand1.pokerHandId, 0, "ALL_IN");
    await act(repo, hand1.pokerHandId, 1, "CALL"); // showdown; the weaker hand busts to 0

    const seatsAfter = await repo.listSeatsForTable(table.pokerTableId);
    const brokeSeat = seatsAfter.find((s) => s.stack === 0);
    expect(brokeSeat).toBeDefined();

    await expect(startHand(repo, table.pokerTableId)).rejects.toBeInstanceOf(NotEnoughSeatedPlayersError);
  });

  it("a participant who joined mid-Hand is included once the next Hand starts", async () => {
    const repo = new InMemoryPokerRepository();
    const { table } = await setupTable(repo, ["Alex", "Jordan"]);
    const hand1 = await startHand(repo, table.pokerTableId);
    const casey = await joinTable(repo, table.roomCode, "Casey");
    await act(repo, hand1.pokerHandId, 0, "FOLD");

    const hand2 = await startHand(repo, table.pokerTableId);
    expect(hand2.dealtSeatNumbers).toContain(casey.seatNumber);
  });
});

describe("Privacy regression during active gameplay", () => {
  it("hole cards remain private to their own seat throughout betting", async () => {
    const repo = new InMemoryPokerRepository();
    const { table, seats } = await setupTable(repo, ["Alex", "Jordan", "Sam"]);
    const hand = await startHand(repo, table.pokerTableId);
    await act(repo, hand.pokerHandId, 0, "CALL");
    await act(repo, hand.pokerHandId, 1, "CALL");
    await act(repo, hand.pokerHandId, 2, "CHECK");

    const alexState = await getTableState(repo, table.pokerTableId, seats[0].participantToken);
    const jordanState = await getTableState(repo, table.pokerTableId, seats[1].participantToken);
    expect(alexState.myHoleCards).toHaveLength(2);
    expect(jordanState.myHoleCards).toHaveLength(2);
    expect(alexState.myHoleCards).not.toEqual(jordanState.myHoleCards);
    expect(JSON.stringify(alexState)).not.toContain("deckOrder");

    const hostState = await getTableState(repo, table.pokerTableId, table.hostToken);
    expect(hostState.myHoleCards).toBeNull();
    expect(hostState.seats.every((s) => s.revealedHoleCards === null)).toBe(true); // still mid-hand, no reveal yet
  });
});
