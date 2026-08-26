import { randomUUID } from "crypto";
import { generateRoomCode } from "../../session/roomCode";
import { generateHostToken } from "../../session/hostToken";
import type { PokerRepository } from "./db/pokerRepository";
import type { CreatePokerTableResult, PokerTableRecord } from "./types";
import { PokerRoomCodeCollisionError } from "./types";
import { RoomCodeRegistryCollisionError } from "../../rooms/types";

/**
 * CREATE_POKER_TABLE command handler. Mirrors createSession.ts's own
 * generate-and-retry room code allocation shape in the domain layer.
 * Reuses generateRoomCode/generateHostToken directly (pure,
 * dependency-free utilities) rather than duplicating them — the one
 * piece of Session's own code this module imports, deliberately, per
 * the readiness gate's own finding that these two functions are
 * genuinely reusable primitives with zero coupling to Session's
 * tables.
 *
 * Room Registry Slice 001: repo.createTable() itself became atomic
 * (create_poker_table_atomically, 0154) — the original "no atomic
 * function needed, only a collision to retry past" reasoning stops
 * holding the moment table creation must jointly claim a code from the
 * same registry Session writes to; see 0154's own migration comment.
 * This function's own retry shape is otherwise unchanged.
 */

const MAX_ROOM_CODE_RETRIES = 5;
const DEFAULT_MAX_SEATS = 6;
const MIN_MAX_SEATS = 2;
const DEFAULT_STARTING_STACK = 1000;
const DEFAULT_SMALL_BLIND = 5;
const DEFAULT_BIG_BLIND = 10;

export async function createTable(
  repo: PokerRepository,
  input: { maxSeats?: number; startingStack?: number; smallBlind?: number; bigBlind?: number } = {}
): Promise<CreatePokerTableResult> {
  const maxSeats = input.maxSeats ?? DEFAULT_MAX_SEATS;
  if (!Number.isInteger(maxSeats) || maxSeats < MIN_MAX_SEATS || maxSeats > DEFAULT_MAX_SEATS) {
    throw new Error("Poker table max seats must be an integer between 2 and 6.");
  }

  const startingStack = input.startingStack ?? DEFAULT_STARTING_STACK;
  const smallBlind = input.smallBlind ?? DEFAULT_SMALL_BLIND;
  const bigBlind = input.bigBlind ?? DEFAULT_BIG_BLIND;
  if (!Number.isInteger(startingStack) || startingStack <= 0) {
    throw new Error("Poker table starting stack must be a positive integer.");
  }
  if (!Number.isInteger(smallBlind) || smallBlind <= 0) {
    throw new Error("Poker table small blind must be a positive integer.");
  }
  if (!Number.isInteger(bigBlind) || bigBlind <= smallBlind) {
    throw new Error("Poker table big blind must be a positive integer greater than the small blind.");
  }

  for (let attempt = 0; attempt < MAX_ROOM_CODE_RETRIES; attempt++) {
    const record: PokerTableRecord = {
      pokerTableId: randomUUID(),
      roomCode: generateRoomCode(),
      hostToken: generateHostToken(),
      maxSeats,
      closedAt: null,
      createdAt: new Date().toISOString(),
      startingStack,
      smallBlind,
      bigBlind,
    };

    try {
      await repo.createTable(record);
      return {
        pokerTableId: record.pokerTableId,
        roomCode: record.roomCode,
        hostToken: record.hostToken,
        maxSeats: record.maxSeats,
        startingStack: record.startingStack,
        smallBlind: record.smallBlind,
        bigBlind: record.bigBlind,
      };
    } catch (err) {
      // Room Registry Slice 001: a collision can now also surface as
      // RoomCodeRegistryCollisionError (see this file's own top
      // comment) — treated identically to Poker's own pre-existing
      // collision error.
      if (err instanceof PokerRoomCodeCollisionError || err instanceof RoomCodeRegistryCollisionError) {
        continue;
      }
      throw err;
    }
  }

  throw new Error(
    `Failed to allocate a unique poker table room code after ${MAX_ROOM_CODE_RETRIES} attempts.`
  );
}
