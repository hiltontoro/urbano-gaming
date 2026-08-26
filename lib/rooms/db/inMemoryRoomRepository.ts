import { randomUUID } from "crypto";
import type { RoomRepository } from "./roomRepository";
import type { RoomRecord, RoomRuntimeType } from "../types";
import { RoomCodeRegistryCollisionError } from "../types";

/**
 * The shared authority InMemorySessionRepository and InMemoryPokerRepository
 * both register through, mirroring the single `rooms` table's own
 * cross-runtime authority at the SQL layer. Defaults to a private,
 * per-repository instance (existing Session-only or Poker-only tests
 * are unaffected — a lone repository's own room-code collisions are
 * still caught, just now redundantly by two checks instead of one).
 * Tests proving real cross-runtime behavior construct one store and
 * pass it explicitly to both repositories.
 *
 * register() is the sole write path — no separate "create a room"
 * method exists, for the same reason RoomRepository itself is
 * read-only (see that file's own comment): register() doubles as the
 * atomic check-and-set a real transaction gives the SQL path for free.
 * JavaScript's single-threaded execution makes a synchronous
 * check-then-push here equally race-free without needing a real lock.
 */
export class InMemoryRoomStore {
  private rooms: RoomRecord[] = [];

  findByRoomCode(roomCode: string): RoomRecord | null {
    return this.rooms.find((room) => room.roomCode === roomCode) ?? null;
  }

  register(roomCode: string, runtimeType: RoomRuntimeType, runtimeId: string): RoomRecord {
    if (this.findByRoomCode(roomCode)) {
      throw new RoomCodeRegistryCollisionError();
    }
    const record: RoomRecord = {
      roomId: randomUUID(),
      roomCode,
      runtimeType,
      runtimeId,
      createdAt: new Date().toISOString(),
    };
    this.rooms.push(record);
    return record;
  }
}

export class InMemoryRoomRepository implements RoomRepository {
  constructor(private store: InMemoryRoomStore = new InMemoryRoomStore()) {}

  async findByRoomCode(roomCode: string): Promise<RoomRecord | null> {
    return this.store.findByRoomCode(roomCode);
  }
}
