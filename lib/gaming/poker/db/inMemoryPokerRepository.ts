import { randomUUID } from "crypto";
import { InMemoryRoomStore } from "../../../rooms/db/inMemoryRoomRepository";
import type { PokerRepository } from "./pokerRepository";
import type {
  PokerTableRecord,
  PokerSeatRecord,
  PokerHandRecord,
  PokerHandPlayerRecord,
  PokerHandActionRecord,
  PokerHandResultRecord,
  PokerActionType,
  PokerStreet,
} from "../types";
import {
  PokerRoomCodeCollisionError,
  PokerTableNotFoundError,
  PokerTableClosedError,
  PokerTableFullError,
  PokerDisplayNameTakenError,
  NotEnoughSeatedPlayersError,
  InvalidDeckError,
  PokerHandNotFoundError,
  HandNotAcceptingActionsError,
  NotYourTurnError,
  SeatNotInHandError,
  SeatNotEligibleToActError,
  IllegalActionError,
  InvalidActionAmountError,
  HandNotAtShowdownError,
  ChipConservationViolationError,
} from "../types";
import { isValidStandardDeck } from "../deck";
import { computeBoardCards } from "../pokerRules";

interface ActionOutcome {
  pokerHandId: string;
  street: PokerStreet;
  currentActorSeatNumber: number | null;
  currentBet: number;
  handOver: boolean;
  showdownReached: boolean;
  earlyWinWinnerSeatNumber: number | null;
  alreadyApplied: boolean;
}

/**
 * In-memory PokerRepository for behavioral tests — independently
 * re-implements the same invariants the real Postgres functions
 * enforce (seat allocation under a lock, display-name uniqueness,
 * table-full rejection, blind posting, the full betting-action state
 * machine including the minimum-raise/reopened-action rule, automatic
 * street advancement, automatic runout, early-win and showdown
 * settlement with chip conservation), not a thin passthrough. Mirrors
 * InMemoryPredictionsRepository's own role exactly — this is a
 * SEPARATE implementation from apply_player_action_atomically (0080),
 * proven to agree with it via the same worked examples exercised by
 * both the behavioral suite (against this file) and the contract
 * suite (against real Postgres).
 */
export class InMemoryPokerRepository implements PokerRepository {
  /** Room Registry Slice 001 — see InMemorySessionRepository's identical field comment. */
  private roomStore: InMemoryRoomStore;

  constructor(roomStore: InMemoryRoomStore = new InMemoryRoomStore()) {
    this.roomStore = roomStore;
  }

  private tables = new Map<string, PokerTableRecord>();
  private seats = new Map<string, PokerSeatRecord>();
  private hands = new Map<string, PokerHandRecord>();
  private handPlayers = new Map<string, PokerHandPlayerRecord>(); // key: `${handId}:${seatNumber}`
  private handActions: PokerHandActionRecord[] = [];
  private handResults = new Map<string, PokerHandResultRecord>();

  private hpKey(pokerHandId: string, seatNumber: number): string {
    return `${pokerHandId}:${seatNumber}`;
  }

  async createTable(record: PokerTableRecord): Promise<void> {
    const collision = [...this.tables.values()].some(
      (t) => t.roomCode === record.roomCode && t.closedAt === null
    );
    if (collision) throw new PokerRoomCodeCollisionError();
    // Room Registry Slice 001: registered first, mirroring
    // InMemorySessionRepository's identical ordering — if this throws
    // (the code was already issued to some other runtime, active or
    // historical), this.tables is not yet mutated, matching
    // create_poker_table_atomically's (0154) real transactional
    // rollback.
    this.roomStore.register(record.roomCode, "POKER_TABLE", record.pokerTableId);
    this.tables.set(record.pokerTableId, record);
  }

  async getTableById(pokerTableId: string): Promise<PokerTableRecord | null> {
    return this.tables.get(pokerTableId) ?? null;
  }

  async getActiveTableByRoomCode(roomCode: string): Promise<PokerTableRecord | null> {
    return (
      [...this.tables.values()].find(
        (t) => t.roomCode === roomCode && t.closedAt === null
      ) ?? null
    );
  }

  async joinTable(input: {
    pokerTableId: string;
    displayName: string;
    normalizedDisplayName: string;
    participantToken: string;
  }): Promise<PokerSeatRecord> {
    const table = this.tables.get(input.pokerTableId);
    if (!table) throw new PokerTableNotFoundError();
    if (table.closedAt !== null) throw new PokerTableClosedError();

    const existingSeats = [...this.seats.values()].filter(
      (s) => s.pokerTableId === input.pokerTableId
    );

    if (existingSeats.length >= table.maxSeats) {
      throw new PokerTableFullError();
    }

    if (
      existingSeats.some(
        (s) => s.normalizedDisplayName === input.normalizedDisplayName
      )
    ) {
      throw new PokerDisplayNameTakenError();
    }

    const nextSeatNumber =
      existingSeats.length === 0
        ? 0
        : Math.max(...existingSeats.map((s) => s.seatNumber)) + 1;

    const record: PokerSeatRecord = {
      pokerSeatId: randomUUID(),
      pokerTableId: input.pokerTableId,
      seatNumber: nextSeatNumber,
      displayName: input.displayName,
      normalizedDisplayName: input.normalizedDisplayName,
      participantToken: input.participantToken,
      joinedAt: new Date().toISOString(),
      stack: table.startingStack,
    };
    this.seats.set(record.pokerSeatId, record);
    return record;
  }

  async listSeatsForTable(pokerTableId: string): Promise<PokerSeatRecord[]> {
    return [...this.seats.values()]
      .filter((s) => s.pokerTableId === pokerTableId)
      .sort((a, b) => a.seatNumber - b.seatNumber);
  }

  private getSeat(pokerTableId: string, seatNumber: number): PokerSeatRecord {
    const seat = [...this.seats.values()].find(
      (s) => s.pokerTableId === pokerTableId && s.seatNumber === seatNumber
    );
    if (!seat) throw new Error(`Seat ${seatNumber} not found for table ${pokerTableId}`);
    return seat;
  }

  private setSeatStack(pokerTableId: string, seatNumber: number, stack: number): void {
    const seat = [...this.seats.values()].find(
      (s) => s.pokerTableId === pokerTableId && s.seatNumber === seatNumber
    )!;
    this.seats.set(seat.pokerSeatId, { ...seat, stack });
  }

  async dealHand(input: {
    pokerTableId: string;
    dealerSeatNumber: number;
    dealtSeatNumbers: number[];
    deckOrder: string[];
  }): Promise<{ hand: PokerHandRecord; alreadyDealt: boolean }> {
    const table = this.tables.get(input.pokerTableId);
    if (!table) throw new PokerTableNotFoundError();
    if (table.closedAt !== null) throw new PokerTableClosedError();

    const existing = [...this.hands.values()].find(
      (h) => h.pokerTableId === input.pokerTableId
    );
    if (existing) {
      return { hand: existing, alreadyDealt: true };
    }

    const seatedNumbers = new Set(
      [...this.seats.values()]
        .filter((s) => s.pokerTableId === input.pokerTableId)
        .map((s) => s.seatNumber)
    );
    const dealtSet = new Set(input.dealtSeatNumbers);
    const dealtAreAllSeated = [...dealtSet].every((n) => seatedNumbers.has(n));

    if (dealtSet.size < 2 || !dealtAreAllSeated) {
      throw new NotEnoughSeatedPlayersError();
    }

    if (!isValidStandardDeck(input.deckOrder)) {
      throw new InvalidDeckError();
    }

    const record: PokerHandRecord = {
      pokerHandId: randomUUID(),
      pokerTableId: input.pokerTableId,
      handOrdinal: 1,
      dealerSeatNumber: input.dealerSeatNumber,
      dealtSeatNumbers: input.dealtSeatNumbers,
      deckOrder: input.deckOrder,
      dealtAt: new Date().toISOString(),
      street: "PRE_FLOP",
      smallBlindSeatNumber: input.dealtSeatNumbers[0],
      bigBlindSeatNumber: input.dealtSeatNumbers[1] ?? input.dealtSeatNumbers[0],
      currentBet: 0,
      minRaiseAmount: 0,
      lastRaiseWasFull: true,
      currentActorSeatNumber: null,
      completedAt: null,
    };
    this.hands.set(record.pokerHandId, record);
    return { hand: record, alreadyDealt: false };
  }

  async getCurrentHandForTable(pokerTableId: string): Promise<PokerHandRecord | null> {
    return this.getMostRecentHandForTable(pokerTableId);
  }

  async getMostRecentHandForTable(pokerTableId: string): Promise<PokerHandRecord | null> {
    const hands = [...this.hands.values()]
      .filter((h) => h.pokerTableId === pokerTableId)
      .sort((a, b) => b.handOrdinal - a.handOrdinal);
    return hands[0] ?? null;
  }

  async getHandById(pokerHandId: string): Promise<PokerHandRecord | null> {
    return this.hands.get(pokerHandId) ?? null;
  }

  async startHand(input: {
    pokerTableId: string;
    dealerSeatNumber: number;
    dealtSeatNumbers: number[];
    smallBlindSeatNumber: number;
    bigBlindSeatNumber: number;
    preFlopFirstActorSeatNumber: number;
    deckOrder: string[];
  }): Promise<{ hand: PokerHandRecord; alreadyStarted: boolean }> {
    const table = this.tables.get(input.pokerTableId);
    if (!table) throw new PokerTableNotFoundError();
    if (table.closedAt !== null) throw new PokerTableClosedError();

    const mostRecent = await this.getMostRecentHandForTable(input.pokerTableId);
    if (mostRecent && mostRecent.street !== "COMPLETE") {
      return { hand: mostRecent, alreadyStarted: true };
    }

    if (input.dealtSeatNumbers.length < 2) {
      throw new NotEnoughSeatedPlayersError();
    }
    const allSeatedWithStack = input.dealtSeatNumbers.every((n) => {
      const s = [...this.seats.values()].find(
        (x) => x.pokerTableId === input.pokerTableId && x.seatNumber === n
      );
      return s !== undefined && s.stack > 0;
    });
    if (!allSeatedWithStack) throw new NotEnoughSeatedPlayersError();

    if (!isValidStandardDeck(input.deckOrder)) {
      throw new InvalidDeckError();
    }

    const handOrdinal = (mostRecent?.handOrdinal ?? 0) + 1;
    const pokerHandId = randomUUID();

    for (const seatNumber of input.dealtSeatNumbers) {
      this.handPlayers.set(this.hpKey(pokerHandId, seatNumber), {
        pokerHandId,
        seatNumber,
        committedThisHand: 0,
        committedThisStreet: 0,
        folded: false,
        allIn: false,
        actedThisStreet: false,
      });
    }

    const sbSeat = this.getSeat(input.pokerTableId, input.smallBlindSeatNumber);
    const sbPost = Math.min(table.smallBlind, sbSeat.stack);
    this.postBlind(pokerHandId, input.smallBlindSeatNumber, sbPost, sbSeat.stack, "POST_SMALL_BLIND", "PRE_FLOP");

    const bbSeat = this.getSeat(input.pokerTableId, input.bigBlindSeatNumber);
    const bbPost = Math.min(table.bigBlind, bbSeat.stack);
    this.postBlind(pokerHandId, input.bigBlindSeatNumber, bbPost, bbSeat.stack, "POST_BIG_BLIND", "PRE_FLOP");

    const hand: PokerHandRecord = {
      pokerHandId,
      pokerTableId: input.pokerTableId,
      handOrdinal,
      dealerSeatNumber: input.dealerSeatNumber,
      dealtSeatNumbers: input.dealtSeatNumbers,
      deckOrder: input.deckOrder,
      dealtAt: new Date().toISOString(),
      street: "PRE_FLOP",
      smallBlindSeatNumber: input.smallBlindSeatNumber,
      bigBlindSeatNumber: input.bigBlindSeatNumber,
      currentBet: bbPost,
      minRaiseAmount: table.bigBlind,
      lastRaiseWasFull: true,
      currentActorSeatNumber: input.preFlopFirstActorSeatNumber,
      completedAt: null,
    };
    this.hands.set(pokerHandId, hand);
    return { hand, alreadyStarted: false };
  }

  private postBlind(
    pokerHandId: string,
    seatNumber: number,
    amount: number,
    seatStack: number,
    actionType: PokerActionType,
    street: PokerStreet
  ): void {
    const hp = this.handPlayers.get(this.hpKey(pokerHandId, seatNumber))!;
    this.handPlayers.set(this.hpKey(pokerHandId, seatNumber), {
      ...hp,
      committedThisHand: amount,
      committedThisStreet: amount,
      allIn: amount >= seatStack,
    });
    this.handActions.push({
      pokerHandActionId: randomUUID(),
      pokerHandId,
      actionOrdinal: this.handActions.filter((a) => a.pokerHandId === pokerHandId).length + 1,
      street,
      seatNumber,
      actionType,
      amount,
      idempotencyKey: `hand:${pokerHandId}:${actionType === "POST_SMALL_BLIND" ? "sb" : "bb"}`,
      createdAt: new Date().toISOString(),
    });
  }

  async getHandPlayers(pokerHandId: string): Promise<PokerHandPlayerRecord[]> {
    return [...this.handPlayers.values()]
      .filter((p) => p.pokerHandId === pokerHandId)
      .sort((a, b) => a.seatNumber - b.seatNumber);
  }

  async getHandPlayer(pokerHandId: string, seatNumber: number): Promise<PokerHandPlayerRecord | null> {
    return this.handPlayers.get(this.hpKey(pokerHandId, seatNumber)) ?? null;
  }

  async listActionsForHand(pokerHandId: string): Promise<PokerHandActionRecord[]> {
    return this.handActions
      .filter((a) => a.pokerHandId === pokerHandId)
      .sort((a, b) => a.actionOrdinal - b.actionOrdinal);
  }

  async getHandResult(pokerHandId: string): Promise<PokerHandResultRecord | null> {
    return this.handResults.get(pokerHandId) ?? null;
  }

  async applyPlayerAction(input: {
    pokerHandId: string;
    seatNumber: number;
    actionType: PokerActionType;
    amount: number | null;
    idempotencyKey: string;
  }): Promise<ActionOutcome> {
    const hand = this.hands.get(input.pokerHandId);
    if (!hand) throw new PokerHandNotFoundError();

    const alreadyApplied = this.handActions.find(
      (a) => a.pokerHandId === input.pokerHandId && a.idempotencyKey === input.idempotencyKey
    );
    if (alreadyApplied) {
      const current = this.hands.get(input.pokerHandId)!;
      return {
        pokerHandId: input.pokerHandId,
        street: current.street,
        currentActorSeatNumber: current.currentActorSeatNumber,
        currentBet: current.currentBet,
        handOver: current.street === "SHOWDOWN" || current.street === "COMPLETE",
        showdownReached: current.street === "SHOWDOWN",
        earlyWinWinnerSeatNumber: null,
        alreadyApplied: true,
      };
    }

    if (hand.street === "SHOWDOWN" || hand.street === "COMPLETE") {
      throw new HandNotAcceptingActionsError();
    }
    if (hand.currentActorSeatNumber !== input.seatNumber) {
      throw new NotYourTurnError();
    }

    const table = this.tables.get(hand.pokerTableId)!;
    const hpKey = this.hpKey(input.pokerHandId, input.seatNumber);
    const hp = this.handPlayers.get(hpKey);
    if (!hp) throw new SeatNotInHandError();
    if (hp.folded || hp.allIn) throw new SeatNotEligibleToActError();

    const seat = this.getSeat(hand.pokerTableId, input.seatNumber);
    const toCall = hand.currentBet - hp.committedThisStreet;
    const remainingStack = seat.stack - hp.committedThisHand;

    let newCommittedStreet = hp.committedThisStreet;
    let newCommittedHand = hp.committedThisHand;
    let newAllIn = false;
    let newFolded = false;
    let newCurrentBet = hand.currentBet;
    let newMinRaise = hand.minRaiseAmount;
    let newLastRaiseFull = hand.lastRaiseWasFull;
    let reopen = false;

    switch (input.actionType) {
      case "FOLD": {
        newFolded = true;
        break;
      }
      case "CHECK": {
        if (toCall !== 0) throw new IllegalActionError("CHECK is not legal — an amount is owed");
        break;
      }
      case "CALL": {
        if (toCall <= 0) throw new IllegalActionError("CALL is not legal — nothing is owed, use CHECK");
        const amt = Math.min(toCall, remainingStack);
        newCommittedStreet += amt;
        newCommittedHand += amt;
        newAllIn = amt === remainingStack;
        break;
      }
      case "BET": {
        if (hand.currentBet !== 0) throw new IllegalActionError("BET is not legal — a bet already exists, use RAISE");
        if (remainingStack <= 0) throw new IllegalActionError("no chips remaining to bet");
        if (input.amount === null || input.amount <= 0) throw new InvalidActionAmountError("bet amount must be positive");
        const amt = Math.min(input.amount, remainingStack);
        if (amt < remainingStack && amt < table.bigBlind) {
          throw new InvalidActionAmountError("bet must be at least the big blind unless going all-in for less");
        }
        newCommittedStreet = amt;
        newCommittedHand += amt;
        newAllIn = amt === remainingStack;
        newCurrentBet = amt;
        newMinRaise = Math.max(amt, table.bigBlind);
        newLastRaiseFull = true;
        reopen = true;
        break;
      }
      case "RAISE": {
        if (hand.currentBet === 0) throw new IllegalActionError("RAISE is not legal — no bet yet, use BET");
        if (input.amount === null) throw new InvalidActionAmountError("raise-to amount is required");
        let target = input.amount;
        let additionalNeeded = target - hp.committedThisStreet;
        if (additionalNeeded <= 0) throw new InvalidActionAmountError("raise-to amount must exceed the current bet");
        let isAllIn = false;
        if (additionalNeeded >= remainingStack) {
          target = hp.committedThisStreet + remainingStack;
          additionalNeeded = remainingStack;
          isAllIn = true;
        }
        const increment = target - hand.currentBet;
        if (!isAllIn && increment < hand.minRaiseAmount) {
          throw new InvalidActionAmountError("raise is below the minimum legal raise");
        }
        newCommittedStreet = target;
        newCommittedHand += additionalNeeded;
        newAllIn = isAllIn;
        newCurrentBet = target;
        if (increment >= hand.minRaiseAmount) {
          newMinRaise = increment;
          newLastRaiseFull = true;
          reopen = true;
        } else {
          newLastRaiseFull = false;
        }
        break;
      }
      case "ALL_IN": {
        if (remainingStack <= 0) throw new IllegalActionError("no chips remaining to push all-in");
        const target = hp.committedThisStreet + remainingStack;
        newCommittedHand += remainingStack;
        newAllIn = true;
        if (hand.currentBet === 0) {
          newCommittedStreet = target;
          newCurrentBet = target;
          newMinRaise = Math.max(target, table.bigBlind);
          newLastRaiseFull = true;
          reopen = true;
        } else {
          const increment = target - hand.currentBet;
          newCommittedStreet = target;
          if (increment > 0) {
            newCurrentBet = target;
            if (increment >= hand.minRaiseAmount) {
              newMinRaise = increment;
              newLastRaiseFull = true;
              reopen = true;
            } else {
              newLastRaiseFull = false;
            }
          }
        }
        break;
      }
      default:
        throw new InvalidActionAmountError(`${input.actionType} is not a recognized action`);
    }

    const actionAmount = newCommittedHand - hp.committedThisHand;
    this.handPlayers.set(hpKey, {
      ...hp,
      committedThisStreet: newCommittedStreet,
      committedThisHand: newCommittedHand,
      folded: newFolded,
      allIn: newAllIn,
      actedThisStreet: true,
    });

    this.handActions.push({
      pokerHandActionId: randomUUID(),
      pokerHandId: input.pokerHandId,
      actionOrdinal: this.handActions.filter((a) => a.pokerHandId === input.pokerHandId).length + 1,
      street: hand.street,
      seatNumber: input.seatNumber,
      actionType: input.actionType,
      amount: actionAmount,
      idempotencyKey: input.idempotencyKey,
      createdAt: new Date().toISOString(),
    });

    if (reopen) {
      for (const seatNumber of hand.dealtSeatNumbers) {
        if (seatNumber === input.seatNumber) continue;
        const otherKey = this.hpKey(input.pokerHandId, seatNumber);
        const other = this.handPlayers.get(otherKey)!;
        if (!other.folded && !other.allIn) {
          this.handPlayers.set(otherKey, { ...other, actedThisStreet: false });
        }
      }
    }
    this.hands.set(input.pokerHandId, { ...hand, currentBet: newCurrentBet, minRaiseAmount: newMinRaise, lastRaiseWasFull: newLastRaiseFull });

    return this.advanceAfterAction(input.pokerHandId, input.seatNumber);
  }

  private advanceAfterAction(pokerHandId: string, actingSeatNumber: number): ActionOutcome {
    const hand = this.hands.get(pokerHandId)!;
    const dealt = hand.dealtSeatNumbers;
    const players = dealt.map((n) => this.handPlayers.get(this.hpKey(pokerHandId, n))!);

    const nonFolded = players.filter((p) => !p.folded);
    if (nonFolded.length === 1) {
      const winner = nonFolded[0].seatNumber;
      const totalPot = players.reduce((s, p) => s + p.committedThisHand, 0);
      for (const p of players) {
        const seat = this.getSeat(hand.pokerTableId, p.seatNumber);
        const delta = -p.committedThisHand + (p.seatNumber === winner ? totalPot : 0);
        this.setSeatStack(hand.pokerTableId, p.seatNumber, seat.stack + delta);
      }
      // The board actually reached before the fold ended the Hand —
      // never assume a full board just because the Hand is now
      // COMPLETE (mirrors the identical fix in
      // apply_player_action_atomically, 0080).
      const earlyWinBoard = computeBoardCards(
        hand.deckOrder,
        dealt.length,
        hand.street === "PRE_FLOP" || hand.street === "FLOP" || hand.street === "TURN" || hand.street === "RIVER"
          ? hand.street
          : "PRE_FLOP"
      );
      this.handResults.set(pokerHandId, {
        pokerHandId,
        board: earlyWinBoard,
        pots: [
          {
            amount: totalPot,
            eligibleSeatNumbers: [winner],
            payouts: [{ seatNumber: winner, amount: totalPot }],
          },
        ],
        showdownHands: null,
        completedAt: new Date().toISOString(),
      });
      this.hands.set(pokerHandId, { ...hand, street: "COMPLETE", currentActorSeatNumber: null, completedAt: new Date().toISOString() });
      return {
        pokerHandId,
        street: "COMPLETE",
        currentActorSeatNumber: null,
        currentBet: hand.currentBet,
        handOver: true,
        showdownReached: false,
        earlyWinWinnerSeatNumber: winner,
        alreadyApplied: false,
      };
    }

    const activeNeedingAction = players.filter(
      (p) => !p.folded && !p.allIn && (!p.actedThisStreet || p.committedThisStreet !== hand.currentBet)
    );
    if (activeNeedingAction.length > 0) {
      const startIdx = dealt.indexOf(actingSeatNumber);
      let nextActor: number | null = null;
      for (let i = 1; i <= dealt.length; i++) {
        const candidate = dealt[(startIdx + i) % dealt.length];
        const cp = this.handPlayers.get(this.hpKey(pokerHandId, candidate))!;
        if (!cp.folded && !cp.allIn) {
          nextActor = candidate;
          break;
        }
      }
      this.hands.set(pokerHandId, { ...hand, currentActorSeatNumber: nextActor });
      return {
        pokerHandId,
        street: hand.street,
        currentActorSeatNumber: nextActor,
        currentBet: hand.currentBet,
        handOver: false,
        showdownReached: false,
        earlyWinWinnerSeatNumber: null,
        alreadyApplied: false,
      };
    }

    const nonFoldedNonAllIn = nonFolded.filter((p) => !p.allIn);
    if (nonFoldedNonAllIn.length <= 1 && hand.street !== "RIVER") {
      this.hands.set(pokerHandId, { ...hand, street: "SHOWDOWN", currentActorSeatNumber: null });
      return {
        pokerHandId,
        street: "SHOWDOWN",
        currentActorSeatNumber: null,
        currentBet: hand.currentBet,
        handOver: false,
        showdownReached: true,
        earlyWinWinnerSeatNumber: null,
        alreadyApplied: false,
      };
    }

    const streets: PokerStreet[] = ["PRE_FLOP", "FLOP", "TURN", "RIVER", "SHOWDOWN"];
    const nextStreet = streets[streets.indexOf(hand.street) + 1];

    if (nextStreet === "SHOWDOWN") {
      this.hands.set(pokerHandId, { ...hand, street: "SHOWDOWN", currentActorSeatNumber: null });
      return {
        pokerHandId,
        street: "SHOWDOWN",
        currentActorSeatNumber: null,
        currentBet: hand.currentBet,
        handOver: false,
        showdownReached: true,
        earlyWinWinnerSeatNumber: null,
        alreadyApplied: false,
      };
    }

    for (const p of players) {
      if (!p.folded && !p.allIn) {
        this.handPlayers.set(this.hpKey(pokerHandId, p.seatNumber), { ...p, committedThisStreet: 0, actedThisStreet: false });
      }
    }
    const nextActor = dealt.find((n) => {
      const p = this.handPlayers.get(this.hpKey(pokerHandId, n))!;
      return !p.folded && !p.allIn;
    })!;
    const table = this.tables.get(hand.pokerTableId)!;
    this.hands.set(pokerHandId, {
      ...hand,
      street: nextStreet,
      currentBet: 0,
      minRaiseAmount: table.bigBlind,
      lastRaiseWasFull: true,
      currentActorSeatNumber: nextActor,
    });
    return {
      pokerHandId,
      street: nextStreet,
      currentActorSeatNumber: nextActor,
      currentBet: 0,
      handOver: false,
      showdownReached: false,
      earlyWinWinnerSeatNumber: null,
      alreadyApplied: false,
    };
  }

  async settleShowdown(input: {
    pokerHandId: string;
    board: string[];
    pots: PokerHandResultRecord["pots"];
    showdownHands: PokerHandResultRecord["showdownHands"];
  }): Promise<{ alreadySettled: boolean }> {
    const hand = this.hands.get(input.pokerHandId);
    if (!hand) throw new PokerHandNotFoundError();
    if (hand.street === "COMPLETE") return { alreadySettled: true };
    if (hand.street !== "SHOWDOWN") throw new HandNotAtShowdownError();

    const players = hand.dealtSeatNumbers.map((n) => this.handPlayers.get(this.hpKey(input.pokerHandId, n))!);
    const totalCommitted = players.reduce((s, p) => s + p.committedThisHand, 0);
    const totalPayouts = input.pots.reduce(
      (s, pot) => s + pot.payouts.reduce((s2, p) => s2 + p.amount, 0),
      0
    );
    if (totalPayouts !== totalCommitted) {
      throw new ChipConservationViolationError();
    }

    for (const p of players) {
      const payout = input.pots.reduce(
        (s, pot) => s + pot.payouts.filter((x) => x.seatNumber === p.seatNumber).reduce((s2, x) => s2 + x.amount, 0),
        0
      );
      const seat = this.getSeat(hand.pokerTableId, p.seatNumber);
      this.setSeatStack(hand.pokerTableId, p.seatNumber, seat.stack - p.committedThisHand + payout);
    }

    this.handResults.set(input.pokerHandId, {
      pokerHandId: input.pokerHandId,
      board: input.board,
      pots: input.pots,
      showdownHands: input.showdownHands,
      completedAt: new Date().toISOString(),
    });
    this.hands.set(input.pokerHandId, { ...hand, street: "COMPLETE", currentActorSeatNumber: null, completedAt: new Date().toISOString() });

    return { alreadySettled: false };
  }
}
