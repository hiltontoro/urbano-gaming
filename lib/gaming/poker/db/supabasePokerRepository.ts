import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";

import type { PokerRepository } from "./pokerRepository";
import { RoomCodeRegistryCollisionError } from "../../../rooms/types";
import type {
  PokerTableRecord,
  PokerSeatRecord,
  PokerHandRecord,
  PokerHandPlayerRecord,
  PokerHandActionRecord,
  PokerHandResultRecord,
  PokerActionType,
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
  PokerTableHasActiveHandError,
} from "../types";

function mapTable(row: any): PokerTableRecord {
  return {
    pokerTableId: row.poker_table_id,
    roomCode: row.room_code,
    hostToken: row.host_token,
    maxSeats: row.max_seats,
    closedAt: row.closed_at,
    createdAt: row.created_at,
    startingStack: row.starting_stack,
    smallBlind: row.small_blind,
    bigBlind: row.big_blind,
  };
}

function mapSeat(row: any): PokerSeatRecord {
  return {
    pokerSeatId: row.poker_seat_id,
    pokerTableId: row.poker_table_id,
    seatNumber: row.seat_number,
    displayName: row.display_name,
    normalizedDisplayName: row.normalized_display_name,
    participantToken: row.participant_token,
    joinedAt: row.joined_at,
    stack: row.stack,
  };
}

/**
 * deckOrder is only ever read here from a `poker_hands` row this
 * repository itself fetched — never spread from a raw `.select("*")`
 * row into any DTO that could reach an API route without passing
 * through getTableState.ts's own explicit-projection discipline first.
 */
function mapHand(row: any): PokerHandRecord {
  return {
    pokerHandId: row.poker_hand_id,
    pokerTableId: row.poker_table_id,
    handOrdinal: row.hand_ordinal,
    dealerSeatNumber: row.dealer_seat_number,
    dealtSeatNumbers: row.dealt_seat_numbers,
    deckOrder: row.deck_order,
    dealtAt: row.dealt_at ?? row.created_at,
    street: row.street,
    smallBlindSeatNumber: row.small_blind_seat_number,
    bigBlindSeatNumber: row.big_blind_seat_number,
    currentBet: row.current_bet,
    minRaiseAmount: row.min_raise_amount,
    lastRaiseWasFull: row.last_raise_was_full,
    currentActorSeatNumber: row.current_actor_seat_number,
    completedAt: row.completed_at,
  };
}

function mapHandPlayer(row: any): PokerHandPlayerRecord {
  return {
    pokerHandId: row.poker_hand_id,
    seatNumber: row.seat_number,
    committedThisHand: row.committed_this_hand,
    committedThisStreet: row.committed_this_street,
    folded: row.folded,
    allIn: row.all_in,
    actedThisStreet: row.acted_this_street,
  };
}

function mapHandAction(row: any): PokerHandActionRecord {
  return {
    pokerHandActionId: row.poker_hand_action_id,
    pokerHandId: row.poker_hand_id,
    actionOrdinal: row.action_ordinal,
    street: row.street,
    seatNumber: row.seat_number,
    actionType: row.action_type,
    amount: row.amount,
    idempotencyKey: row.idempotency_key,
    createdAt: row.created_at,
  };
}

function mapHandResult(row: any): PokerHandResultRecord {
  return {
    pokerHandId: row.poker_hand_id,
    board: row.board,
    pots: row.pots,
    showdownHands: row.showdown_hands,
    completedAt: row.completed_at,
  };
}

function translateNamedError(error: { code?: string; message?: string }): Error | null {
  if (error.code !== "P0001" || typeof error.message !== "string") return null;
  const table: Array<[string, () => Error]> = [
    ["POKER_TABLE_NOT_FOUND", () => new PokerTableNotFoundError()],
    ["POKER_TABLE_CLOSED", () => new PokerTableClosedError()],
    ["POKER_TABLE_FULL", () => new PokerTableFullError()],
    ["NOT_ENOUGH_SEATED_PLAYERS", () => new NotEnoughSeatedPlayersError()],
    ["INVALID_DECK", () => new InvalidDeckError()],
    ["POKER_HAND_NOT_FOUND", () => new PokerHandNotFoundError()],
    ["HAND_NOT_ACCEPTING_ACTIONS", () => new HandNotAcceptingActionsError()],
    ["NOT_YOUR_TURN", () => new NotYourTurnError()],
    ["SEAT_NOT_IN_HAND", () => new SeatNotInHandError()],
    ["SEAT_NOT_ELIGIBLE_TO_ACT", () => new SeatNotEligibleToActError()],
    ["ILLEGAL_ACTION", () => new IllegalActionError(error.message!.split("ILLEGAL_ACTION: ")[1] ?? error.message!)],
    ["INVALID_AMOUNT", () => new InvalidActionAmountError(error.message!.split("INVALID_AMOUNT: ")[1] ?? error.message!)],
    ["INVALID_ACTION_TYPE", () => new InvalidActionAmountError(error.message!)],
    ["HAND_NOT_AT_SHOWDOWN", () => new HandNotAtShowdownError()],
    ["CHIP_CONSERVATION_VIOLATION", () => new ChipConservationViolationError()],
    ["POKER_TABLE_HAS_ACTIVE_HAND", () => new PokerTableHasActiveHandError()],
  ];
  for (const [code, build] of table) {
    if (error.message.includes(code)) return build();
  }
  return null;
}

export class SupabasePokerRepository implements PokerRepository {
  private client: SupabaseClient;

  constructor(supabaseUrl: string, supabaseServiceKey: string) {
    // Same Next.js Data Cache workaround already established for
    // Predictions (see supabasePredictionsRepository.ts's own comment)
    // — applied here proactively rather than rediscovered the same way.
    this.client = createClient(supabaseUrl, supabaseServiceKey, {
      global: {
        fetch: (input, init) =>
          fetch(input, { ...init, cache: "no-store" } as RequestInit),
      },
    });
  }

  // Room Registry Slice 001: was a plain insert; now an atomic RPC
  // (create_poker_table_atomically, 0154) that also registers this
  // table's room code in the same transaction as the poker_tables
  // insert itself — either both persist or neither does. Same columns,
  // same values this method already sent before this Slice; no Poker
  // gameplay behavior changes.
  async createTable(record: PokerTableRecord): Promise<void> {
    const { error } = await this.client.rpc("create_poker_table_atomically", {
      p_poker_table_id: record.pokerTableId,
      p_room_code: record.roomCode,
      p_host_token: record.hostToken,
      p_max_seats: record.maxSeats,
      p_starting_stack: record.startingStack,
      p_small_blind: record.smallBlind,
      p_big_blind: record.bigBlind,
    });
    if (error) {
      if (error.code === "23505" && error.message.includes("poker_tables_room_code_active_unique")) {
        throw new PokerRoomCodeCollisionError();
      }
      if (error.code === "23505" && error.message.includes("rooms_room_code_unique")) {
        throw new RoomCodeRegistryCollisionError();
      }
      throw error;
    }
  }

  async getTableById(pokerTableId: string): Promise<PokerTableRecord | null> {
    const { data, error } = await this.client
      .from("poker_tables")
      .select("*")
      .eq("poker_table_id", pokerTableId)
      .maybeSingle();
    if (error) throw error;
    return data ? mapTable(data) : null;
  }

  async getActiveTableByRoomCode(roomCode: string): Promise<PokerTableRecord | null> {
    const { data, error } = await this.client
      .from("poker_tables")
      .select("*")
      .eq("room_code", roomCode)
      .is("closed_at", null)
      .maybeSingle();
    if (error) throw error;
    return data ? mapTable(data) : null;
  }

  async joinTable(input: {
    pokerTableId: string;
    displayName: string;
    normalizedDisplayName: string;
    participantToken: string;
  }): Promise<PokerSeatRecord> {
    const { data, error } = await this.client.rpc("join_poker_table_atomically", {
      p_poker_seat_id: randomUUID(),
      p_poker_table_id: input.pokerTableId,
      p_display_name: input.displayName,
      p_normalized_display_name: input.normalizedDisplayName,
      p_participant_token: input.participantToken,
      p_joined_at: new Date().toISOString(),
    });

    if (error) {
      const translated = translateNamedError(error);
      if (translated) throw translated;
      if (
        error.code === "23505" &&
        error.message.includes("poker_seats_table_display_name_unique")
      ) {
        throw new PokerDisplayNameTakenError();
      }
      throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;
    return mapSeat(row);
  }

  async listSeatsForTable(pokerTableId: string): Promise<PokerSeatRecord[]> {
    const { data, error } = await this.client
      .from("poker_seats")
      .select("*")
      .eq("poker_table_id", pokerTableId)
      .order("seat_number");
    if (error) throw error;
    return (data ?? []).map(mapSeat);
  }

  async dealHand(input: {
    pokerTableId: string;
    dealerSeatNumber: number;
    dealtSeatNumbers: number[];
    deckOrder: string[];
  }): Promise<{ hand: PokerHandRecord; alreadyDealt: boolean }> {
    const { data, error } = await this.client.rpc("deal_poker_hand_atomically", {
      p_poker_hand_id: randomUUID(),
      p_poker_table_id: input.pokerTableId,
      p_dealer_seat_number: input.dealerSeatNumber,
      p_dealt_seat_numbers: input.dealtSeatNumbers,
      p_deck_order: input.deckOrder,
    });

    if (error) {
      const translated = translateNamedError(error);
      if (translated) throw translated;
      throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;
    const alreadyDealt = row.already_dealt as boolean;

    // The RPC's own return shape deliberately omits deck_order (it was
    // never selected as an output column in 0071) — already_dealt:true
    // still needs the full Hand (including deck_order) for
    // getTableState.ts to compute hole cards, so it is fetched
    // explicitly here rather than trusted from the RPC response.
    const hand = await this.getCurrentHandForTable(input.pokerTableId);
    if (!hand) {
      throw new Error("deal_poker_hand_atomically reported success but no Hand row was found.");
    }

    return { hand, alreadyDealt };
  }

  async getCurrentHandForTable(pokerTableId: string): Promise<PokerHandRecord | null> {
    return this.getMostRecentHandForTable(pokerTableId);
  }

  async getMostRecentHandForTable(pokerTableId: string): Promise<PokerHandRecord | null> {
    const { data, error } = await this.client
      .from("poker_hands")
      .select("*")
      .eq("poker_table_id", pokerTableId)
      .order("hand_ordinal", { ascending: false })
      .limit(1)
      .maybeSingle();
    if (error) throw error;
    return data ? mapHand(data) : null;
  }

  async getHandById(pokerHandId: string): Promise<PokerHandRecord | null> {
    const { data, error } = await this.client
      .from("poker_hands")
      .select("*")
      .eq("poker_hand_id", pokerHandId)
      .maybeSingle();
    if (error) throw error;
    return data ? mapHand(data) : null;
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
    const { data, error } = await this.client.rpc("start_poker_hand_atomically", {
      p_poker_hand_id: randomUUID(),
      p_poker_table_id: input.pokerTableId,
      p_dealer_seat_number: input.dealerSeatNumber,
      p_dealt_seat_numbers: input.dealtSeatNumbers,
      p_small_blind_seat_number: input.smallBlindSeatNumber,
      p_big_blind_seat_number: input.bigBlindSeatNumber,
      p_pre_flop_first_actor_seat_number: input.preFlopFirstActorSeatNumber,
      p_deck_order: input.deckOrder,
    });

    if (error) {
      const translated = translateNamedError(error);
      if (translated) throw translated;
      throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;
    const alreadyStarted = row.already_started as boolean;

    const hand = await this.getHandById(row.poker_hand_id);
    if (!hand) {
      throw new Error("start_poker_hand_atomically reported success but no Hand row was found.");
    }
    return { hand, alreadyStarted };
  }

  async getHandPlayers(pokerHandId: string): Promise<PokerHandPlayerRecord[]> {
    const { data, error } = await this.client
      .from("poker_hand_players")
      .select("*")
      .eq("poker_hand_id", pokerHandId)
      .order("seat_number");
    if (error) throw error;
    return (data ?? []).map(mapHandPlayer);
  }

  async getHandPlayer(pokerHandId: string, seatNumber: number): Promise<PokerHandPlayerRecord | null> {
    const { data, error } = await this.client
      .from("poker_hand_players")
      .select("*")
      .eq("poker_hand_id", pokerHandId)
      .eq("seat_number", seatNumber)
      .maybeSingle();
    if (error) throw error;
    return data ? mapHandPlayer(data) : null;
  }

  async applyPlayerAction(input: {
    pokerHandId: string;
    seatNumber: number;
    actionType: PokerActionType;
    amount: number | null;
    idempotencyKey: string;
  }) {
    const { data, error } = await this.client.rpc("apply_player_action_atomically", {
      p_poker_hand_id: input.pokerHandId,
      p_seat_number: input.seatNumber,
      p_action_type: input.actionType,
      p_amount: input.amount,
      p_idempotency_key: input.idempotencyKey,
    });

    if (error) {
      const translated = translateNamedError(error);
      if (translated) throw translated;
      throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;
    return {
      pokerHandId: row.poker_hand_id,
      street: row.street,
      currentActorSeatNumber: row.current_actor_seat_number,
      currentBet: row.current_bet,
      handOver: row.hand_over,
      showdownReached: row.showdown_reached,
      earlyWinWinnerSeatNumber: row.early_win_winner_seat_number,
      alreadyApplied: row.already_applied,
    };
  }

  async listActionsForHand(pokerHandId: string): Promise<PokerHandActionRecord[]> {
    const { data, error } = await this.client
      .from("poker_hand_actions")
      .select("*")
      .eq("poker_hand_id", pokerHandId)
      .order("action_ordinal");
    if (error) throw error;
    return (data ?? []).map(mapHandAction);
  }

  async settleShowdown(input: {
    pokerHandId: string;
    board: string[];
    pots: PokerHandResultRecord["pots"];
    showdownHands: PokerHandResultRecord["showdownHands"];
  }): Promise<{ alreadySettled: boolean }> {
    const { data, error } = await this.client.rpc("settle_showdown_atomically", {
      p_poker_hand_id: input.pokerHandId,
      p_board: input.board,
      p_pots: input.pots,
      p_showdown_hands: input.showdownHands,
    });

    if (error) {
      const translated = translateNamedError(error);
      if (translated) throw translated;
      throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;
    return { alreadySettled: row.already_settled as boolean };
  }

  async getHandResult(pokerHandId: string): Promise<PokerHandResultRecord | null> {
    const { data, error } = await this.client
      .from("poker_hand_results")
      .select("*")
      .eq("poker_hand_id", pokerHandId)
      .maybeSingle();
    if (error) throw error;
    return data ? mapHandResult(data) : null;
  }

  async closeTable(pokerTableId: string): Promise<{ closedAt: string; alreadyClosed: boolean }> {
    const { data, error } = await this.client.rpc("close_poker_table_atomically", {
      p_poker_table_id: pokerTableId,
    });

    if (error) {
      const translated = translateNamedError(error);
      if (translated) throw translated;
      throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;
    return { closedAt: row.closed_at, alreadyClosed: row.already_closed as boolean };
  }
}
