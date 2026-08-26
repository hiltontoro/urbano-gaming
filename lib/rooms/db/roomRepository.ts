import type { RoomRecord } from "../types";

/**
 * Room's own persistence boundary — its own interface, parallel to
 * lib/session/db/sessionRepository.ts and
 * lib/gaming/poker/db/pokerRepository.ts, never merged with either.
 *
 * Deliberately read-only. Room rows are never created through this
 * interface: they are created inside create_session_atomically (0153)
 * and create_poker_table_atomically (0154), in the same transaction as
 * the runtime row they point to — see resolveRoom.ts's own comment for
 * why a separate "create a room" write path is not offered here, and
 * would in fact be the wrong shape (it could not honor the one-
 * transaction requirement this whole registry exists to guarantee).
 */
export interface RoomRepository {
  findByRoomCode(roomCode: string): Promise<RoomRecord | null>;
}
