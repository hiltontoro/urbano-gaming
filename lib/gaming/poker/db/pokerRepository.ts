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

/**
 * Poker Foundation persistence boundary — its own interface, parallel
 * to lib/session/db/sessionRepository.ts and
 * lib/gaming/predictions/db/predictionsRepository.ts, never merged
 * with either.
 */
export interface PokerRepository {
  createTable(record: PokerTableRecord): Promise<void>;
  getTableById(pokerTableId: string): Promise<PokerTableRecord | null>;
  getActiveTableByRoomCode(roomCode: string): Promise<PokerTableRecord | null>;

  /**
   * Atomic seat assignment: validates the table is open and not full,
   * enforces per-table normalized-display-name uniqueness, and
   * allocates the next seat_number, all under a lock on the table row.
   * No idempotent-return path — mirrors joinSession's own documented
   * behavior exactly: a genuine retry with the same display name is
   * rejected as PokerDisplayNameTakenError, not silently deduplicated.
   */
  joinTable(input: {
    pokerTableId: string;
    displayName: string;
    normalizedDisplayName: string;
    participantToken: string;
  }): Promise<PokerSeatRecord>;

  listSeatsForTable(pokerTableId: string): Promise<PokerSeatRecord[]>;

  /**
   * Atomic hand creation: idempotent per table for this phase — a
   * table may have at most one Hand until the gameplay phase adds
   * hand-completion/next-hand semantics (see 0071's migration comment).
   * A second call returns the existing Hand with alreadyDealt: true,
   * mirroring finalizeMatchResult's own already-finalized idempotency
   * convention, so a double-tapped "Deal" is always safe.
   */
  dealHand(input: {
    pokerTableId: string;
    dealerSeatNumber: number;
    dealtSeatNumbers: number[];
    deckOrder: string[];
  }): Promise<{ hand: PokerHandRecord; alreadyDealt: boolean }>;

  getCurrentHandForTable(pokerTableId: string): Promise<PokerHandRecord | null>;
  getHandById(pokerHandId: string): Promise<PokerHandRecord | null>;
  getMostRecentHandForTable(pokerTableId: string): Promise<PokerHandRecord | null>;

  /**
   * Posts blinds and begins a new Hand — supersedes dealHand for real
   * gameplay (0071/dealHand.ts are left untouched, still exercised by
   * the Poker Foundation's own tests). Idempotent per table: if the
   * table's most recent Hand is not yet street='COMPLETE', that Hand
   * is returned unchanged with alreadyStarted: true.
   */
  startHand(input: {
    pokerTableId: string;
    dealerSeatNumber: number;
    dealtSeatNumbers: number[];
    smallBlindSeatNumber: number;
    bigBlindSeatNumber: number;
    preFlopFirstActorSeatNumber: number;
    deckOrder: string[];
  }): Promise<{ hand: PokerHandRecord; alreadyStarted: boolean }>;

  getHandPlayers(pokerHandId: string): Promise<PokerHandPlayerRecord[]>;
  getHandPlayer(pokerHandId: string, seatNumber: number): Promise<PokerHandPlayerRecord | null>;

  /**
   * The single authoritative command for every player action. Stops
   * at street='SHOWDOWN' without settling (no hand evaluator in SQL) —
   * the caller (applyPlayerAction.ts) detects showdownReached and
   * calls settleShowdown next. Idempotent on a repeated idempotencyKey.
   */
  applyPlayerAction(input: {
    pokerHandId: string;
    seatNumber: number;
    actionType: PokerActionType;
    amount: number | null;
    idempotencyKey: string;
  }): Promise<{
    pokerHandId: string;
    street: PokerStreet;
    currentActorSeatNumber: number | null;
    currentBet: number;
    handOver: boolean;
    showdownReached: boolean;
    earlyWinWinnerSeatNumber: number | null;
    alreadyApplied: boolean;
  }>;

  listActionsForHand(pokerHandId: string): Promise<PokerHandActionRecord[]>;

  /**
   * Settles a Hand that has reached street='SHOWDOWN' — applies the
   * caller-computed pot payouts atomically, independently re-verifying
   * chip conservation (total payouts must equal total committed) before
   * trusting them. Idempotent: re-calling on an already-COMPLETE Hand
   * returns the existing result without paying out twice.
   */
  settleShowdown(input: {
    pokerHandId: string;
    board: string[];
    pots: PokerHandResultRecord["pots"];
    showdownHands: PokerHandResultRecord["showdownHands"];
  }): Promise<{ alreadySettled: boolean }>;

  getHandResult(pokerHandId: string): Promise<PokerHandResultRecord | null>;

  /**
   * Poker End Table Lifecycle Slice. Legal only "between hands" — no
   * Hand ever dealt, or the most recent Hand's street = 'COMPLETE'.
   * Idempotent per table (mirrors startHand's own alreadyStarted and
   * settleShowdown's own alreadySettled convention): a repeat call on
   * an already-closed table returns alreadyClosed: true rather than
   * throwing. Never mutates poker_hands/poker_hand_players/
   * poker_hand_actions/poker_hand_results — full Hand history remains
   * queryable indefinitely.
   */
  closeTable(pokerTableId: string): Promise<{ closedAt: string; alreadyClosed: boolean }>;
}
