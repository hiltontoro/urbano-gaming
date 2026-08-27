/**
 * Poker Foundation (Phase 1) — Poker Table / seating / authoritative
 * deck / private hole cards / role-aware projection only. No betting,
 * no chips, no streets, no showdown — see
 * POKER_FOUNDATION_IMPLEMENTATION_RECORD.md for the exact phase
 * boundary and why this is a standalone module rather than a new
 * Session Engine.
 */

export interface PokerTableRecord {
  pokerTableId: string;
  roomCode: string;
  hostToken: string;
  maxSeats: number;
  closedAt: string | null;
  createdAt: string;
  startingStack: number;
  smallBlind: number;
  bigBlind: number;
}

export interface PokerSeatRecord {
  pokerSeatId: string;
  pokerTableId: string;
  seatNumber: number;
  displayName: string;
  normalizedDisplayName: string;
  participantToken: string;
  joinedAt: string;
  stack: number;
}

/**
 * dealtSeatNumbers: the seats included in this Hand, in dealing order
 * (starting immediately after dealerSeatNumber, wrapping around) —
 * frozen at deal time per the "join between Hands only" rule. deckOrder
 * is the full authoritative 52-card shuffled permutation; it is
 * server-only state and must never appear in any client-facing
 * projection (see getTableState.ts). Hole cards for the player at
 * dealtSeatNumbers[i] are deckOrder[i] and deckOrder[dealtSeatNumbers.length + i]
 * — one card to each active player in turn, twice around, mirroring
 * real dealing order rather than dealing two consecutive cards to each
 * player.
 */
export type PokerStreet = "PRE_FLOP" | "FLOP" | "TURN" | "RIVER" | "SHOWDOWN" | "COMPLETE";

export interface PokerHandRecord {
  pokerHandId: string;
  pokerTableId: string;
  handOrdinal: number;
  dealerSeatNumber: number;
  dealtSeatNumbers: number[];
  deckOrder: string[];
  dealtAt: string;
  street: PokerStreet;
  smallBlindSeatNumber: number;
  bigBlindSeatNumber: number;
  currentBet: number;
  minRaiseAmount: number;
  lastRaiseWasFull: boolean;
  currentActorSeatNumber: number | null;
  completedAt: string | null;
}

/** Live, per-Hand betting state for one seat. Current in-hand chips = seat.stack - committedThisHand (derived). */
export interface PokerHandPlayerRecord {
  pokerHandId: string;
  seatNumber: number;
  committedThisHand: number;
  committedThisStreet: number;
  folded: boolean;
  allIn: boolean;
  actedThisStreet: boolean;
}

export type PokerActionType =
  | "POST_SMALL_BLIND"
  | "POST_BIG_BLIND"
  | "FOLD"
  | "CHECK"
  | "CALL"
  | "BET"
  | "RAISE"
  | "ALL_IN";

export interface PokerHandActionRecord {
  pokerHandActionId: string;
  pokerHandId: string;
  actionOrdinal: number;
  street: PokerStreet;
  seatNumber: number;
  actionType: PokerActionType;
  amount: number;
  idempotencyKey: string;
  createdAt: string;
}

export interface PokerHandResultRecord {
  pokerHandId: string;
  board: string[];
  pots: Array<{
    amount: number;
    eligibleSeatNumbers: number[];
    payouts: Array<{ seatNumber: number; amount: number }>;
  }>;
  // descr is optional: a hand settled before the Poker Playtest UX +
  // Showdown Transparency Slice persisted only rankName — real
  // existing rows in production have no descr field at all, and the
  // participant client falls back to rankName for those.
  showdownHands: Record<string, { cards: [string, string]; rankName: string; descr?: string }> | null;
  completedAt: string;
}

export interface CreatePokerTableResult {
  pokerTableId: string;
  roomCode: string;
  hostToken: string;
  maxSeats: number;
  startingStack: number;
  smallBlind: number;
  bigBlind: number;
}

export interface JoinPokerTableResult {
  pokerSeatId: string;
  pokerTableId: string;
  seatNumber: number;
  displayName: string;
  participantToken: string;
  stack: number;
}

export interface DealPokerHandResult {
  pokerHandId: string;
  pokerTableId: string;
  handOrdinal: number;
  dealerSeatNumber: number;
  dealtSeatNumbers: number[];
  alreadyDealt: boolean;
}

export interface StartPokerHandResult {
  pokerHandId: string;
  pokerTableId: string;
  handOrdinal: number;
  dealerSeatNumber: number;
  dealtSeatNumbers: number[];
  smallBlindSeatNumber: number;
  bigBlindSeatNumber: number;
  currentActorSeatNumber: number | null;
  street: PokerStreet;
  alreadyStarted: boolean;
}

export interface CloseTableResult {
  pokerTableId: string;
  closedAt: string;
  alreadyClosed: boolean;
}

export interface PlayerActionResult {
  pokerHandId: string;
  street: PokerStreet;
  currentActorSeatNumber: number | null;
  currentBet: number;
  handOver: boolean;
  showdownReached: boolean;
  earlyWinWinnerSeatNumber: number | null;
  alreadyApplied: boolean;
}

/** A seat as exposed by GET_TABLE_STATE — no participantToken. */
export interface SeatSummary {
  seatNumber: number;
  displayName: string;
  isDealer: boolean;
  inCurrentHand: boolean;
  stack: number;
  committedThisHand: number;
  committedThisStreet: number;
  folded: boolean;
  allIn: boolean;
  isCurrentActor: boolean;
  /**
   * Populated ONLY once poker_hand_results.showdown_hands legitimately
   * reveals this seat (the Hand reached a real Showdown and this seat
   * did not fold) — never for a live/in-progress Hand, never for a
   * folded seat at any point, never for an early-win (fold-to-one)
   * Hand. See getTableState.ts's own comment for the exact rule.
   */
  revealedHoleCards: [string, string] | null;
}

/**
 * The role-aware read projection. myHoleCards is populated only for
 * the calling participant's own seat, only once a Hand has been dealt
 * and their seat was included in it — never for the host, never for
 * any other seat. See getTableState.ts's own comment for the full
 * privacy rule and why the host does not automatically see hole cards.
 *
 * showdownHands mirrors poker_hand_results.showdown_hands exactly:
 * present only once a Hand has reached street = 'COMPLETE' via a real
 * Showdown, containing only the seats that did not fold — an early
 * win (fold-to-one) never populates this, per the chosen v1 reveal
 * rule (see POKER_GAMEPLAY_IMPLEMENTATION_RECORD.md).
 */
export interface GetTableStateResult {
  pokerTableId: string;
  roomCode: string;
  maxSeats: number;
  closedAt: string | null;
  startingStack: number;
  smallBlind: number;
  bigBlind: number;
  seats: SeatSummary[];
  currentHandId: string | null;
  currentHandOrdinal: number | null;
  street: PokerStreet | null;
  board: string[];
  pot: number;
  myHoleCards: [string, string] | null;
  myLegalActions: import("./pokerRules").LegalActions | null;
  handResult: PokerHandResultRecord | null;
}

// --- Errors -------------------------------------------------------------

export class PokerRoomCodeCollisionError extends Error {
  constructor() {
    super("Room code collision against an active poker table.");
    this.name = "PokerRoomCodeCollisionError";
  }
}

export class PokerTableNotFoundError extends Error {
  constructor() {
    super("No poker table exists for this id.");
    this.name = "PokerTableNotFoundError";
  }
}

export class PokerTableClosedError extends Error {
  constructor() {
    super("This poker table is closed.");
    this.name = "PokerTableClosedError";
  }
}

export class PokerTableFullError extends Error {
  constructor() {
    super("This poker table already has the maximum number of seats filled.");
    this.name = "PokerTableFullError";
  }
}

export class PokerDisplayNameTakenError extends Error {
  constructor() {
    super("This display name is already seated at this table.");
    this.name = "PokerDisplayNameTakenError";
  }
}

export class PokerEmptyDisplayNameError extends Error {
  constructor() {
    super("Display name cannot be empty.");
    this.name = "PokerEmptyDisplayNameError";
  }
}

export class PokerDisplayNameTooLongError extends Error {
  constructor() {
    super("Display name cannot exceed 40 characters.");
    this.name = "PokerDisplayNameTooLongError";
  }
}

export class PokerTableAccessDeniedError extends Error {
  constructor() {
    super("This token does not grant access to this poker table.");
    this.name = "PokerTableAccessDeniedError";
  }
}

export class NotEnoughSeatedPlayersError extends Error {
  constructor() {
    super("At least two seated players are required to deal a hand.");
    this.name = "NotEnoughSeatedPlayersError";
  }
}

export class PokerTableHasActiveHandError extends Error {
  constructor() {
    super("This poker table has a hand in progress and cannot be closed until it finishes.");
    this.name = "PokerTableHasActiveHandError";
  }
}

export class InvalidDeckError extends Error {
  constructor() {
    super("The supplied deck is not a valid 52-card permutation.");
    this.name = "InvalidDeckError";
  }
}

export class PokerHandNotFoundError extends Error {
  constructor() {
    super("No poker hand exists for this id.");
    this.name = "PokerHandNotFoundError";
  }
}

export class HandNotAcceptingActionsError extends Error {
  constructor() {
    super("This hand is no longer accepting actions.");
    this.name = "HandNotAcceptingActionsError";
  }
}

export class NotYourTurnError extends Error {
  constructor() {
    super("It is not this seat's turn to act.");
    this.name = "NotYourTurnError";
  }
}

export class SeatNotInHandError extends Error {
  constructor() {
    super("This seat is not part of this hand.");
    this.name = "SeatNotInHandError";
  }
}

export class SeatNotEligibleToActError extends Error {
  constructor() {
    super("This seat has already folded or is already all-in.");
    this.name = "SeatNotEligibleToActError";
  }
}

export class IllegalActionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "IllegalActionError";
  }
}

export class InvalidActionAmountError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidActionAmountError";
  }
}

export class HandNotAtShowdownError extends Error {
  constructor() {
    super("This hand has not reached showdown.");
    this.name = "HandNotAtShowdownError";
  }
}

export class ChipConservationViolationError extends Error {
  constructor() {
    super("Total payouts do not match total committed chips.");
    this.name = "ChipConservationViolationError";
  }
}
