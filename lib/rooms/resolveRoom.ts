import type { RoomRepository } from "./db/roomRepository";
import type { SessionRepository } from "../session/db/sessionRepository";
import type { PokerRepository } from "../gaming/poker/db/pokerRepository";
import type { ResolveRoomResult } from "./types";
import { RoomNotFoundError, AmbiguousRoomError } from "./types";

/**
 * RESOLVE_ROOM command handler.
 *
 * Answers exactly one question — "where does this human-facing code
 * lead?" — and nothing else. It never returns Session state, Poker
 * table state, host tokens, or any field beyond what a caller needs to
 * know which runtime-specific endpoint to call next (the same
 * runtimeId the caller would already pass to GET_SESSION or Poker's
 * own GET_TABLE_STATE). This is deliberate: leaking more than the
 * routing answer would make Room a second, competing read model for
 * data Session and Poker already own.
 *
 * Two paths, tried in order:
 *
 * 1. Fast path — a rooms row exists (every room created from Slice 001
 *    onward always has one, by construction: create_session_atomically
 *    (0153) and create_poker_table_atomically (0154) each register one
 *    in the same transaction as the runtime row itself).
 *
 * 2. Legacy fallback — no rooms row exists, meaning this code predates
 *    the registry. Falls back to the exact per-table lookups Session
 *    and Poker already exposed before this Slice
 *    (getActiveSessionByRoomCode / getActiveTableByRoomCode).
 *    Permanent by design, not a temporary shim — no backfill migration
 *    is planned; every pre-Slice-001 room remains reachable through
 *    this path indefinitely.
 *
 * Founder decision (Room Registry Slice 001 resolution): if the legacy
 * fallback finds an active match in *both* tables at once — the exact
 * cross-runtime collision this whole registry exists to prevent for
 * every future code — this function fails closed. It does not guess,
 * does not prefer either runtime, and does not route the participant.
 * Correct failure is preferable to silently routing a human into the
 * wrong experience. The caller is expected to log this occurrence for
 * investigation; this function only refuses to resolve.
 */
export async function resolveRoom(
  repos: {
    rooms: RoomRepository;
    sessions: SessionRepository;
    poker: PokerRepository;
  },
  roomCode: string
): Promise<ResolveRoomResult> {
  const room = await repos.rooms.findByRoomCode(roomCode);
  if (room) {
    return {
      roomCode: room.roomCode,
      runtimeType: room.runtimeType,
      runtimeId: room.runtimeId,
    };
  }

  const [session, pokerTable] = await Promise.all([
    repos.sessions.getActiveSessionByRoomCode(roomCode),
    repos.poker.getActiveTableByRoomCode(roomCode),
  ]);

  if (session && pokerTable) {
    throw new AmbiguousRoomError();
  }

  if (session) {
    return { roomCode, runtimeType: "SESSION", runtimeId: session.sessionId };
  }

  if (pokerTable) {
    return { roomCode, runtimeType: "POKER_TABLE", runtimeId: pokerTable.pokerTableId };
  }

  throw new RoomNotFoundError();
}
