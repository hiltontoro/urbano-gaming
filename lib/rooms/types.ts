/**
 * Room Registry Slice 001 (Unified Entry Architecture).
 *
 * Room is a pure addressing abstraction — see rooms.sql (0152) and
 * RESOLVE_ROOM's own comment (resolveRoom.ts) for the full boundary.
 * Nothing here owns gameplay, lifecycle, scoring, or sequencing;
 * Session and Poker Table each keep their entire existing domain
 * exactly as it is today.
 */

export type RoomRuntimeType = "SESSION" | "POKER_TABLE";

/**
 * runtimeType is deliberately not a persisted column anywhere — it is
 * always derived from which of sessionId / pokerTableId is present,
 * mirroring point_awards' own "duel_id is not null is the provenance
 * signal" precedent rather than storing a second, driftable tag.
 */
export interface RoomRecord {
  roomId: string;
  roomCode: string;
  runtimeType: RoomRuntimeType;
  runtimeId: string;
  createdAt: string;
}

/**
 * RESOLVE_ROOM's own return shape — deliberately smaller than
 * RoomRecord. roomId/createdAt are Room's own internal bookkeeping and
 * are never returned to a caller; only enough is exposed to know where
 * to dispatch next (the same runtimeId the caller would already pass
 * to GET_SESSION or Poker's own GET_TABLE_STATE).
 */
export interface ResolveRoomResult {
  roomCode: string;
  runtimeType: RoomRuntimeType;
  runtimeId: string;
}

/** No active room — new or legacy — exists for this code. */
export class RoomNotFoundError extends Error {
  constructor() {
    super("No active room for this code.");
    this.name = "RoomNotFoundError";
  }
}

/**
 * Legacy-fallback-only failure: a code predating the Room registry
 * exists as an active row in both sessions and poker_tables at once —
 * the exact cross-runtime collision this whole registry exists to
 * prevent for every code issued from now on. Founder decision (Room
 * Registry Slice 001 resolution): fail closed. Never guess, never
 * route toward either runtime — correct failure is preferable to
 * silently routing a human into the wrong experience.
 */
export class AmbiguousRoomError extends Error {
  constructor() {
    super("This room code matches more than one active experience.");
    this.name = "AmbiguousRoomError";
  }
}

/** Raised when a generated room code collides with any room ever issued. */
export class RoomCodeRegistryCollisionError extends Error {
  constructor() {
    super("Room code collision against the room registry.");
    this.name = "RoomCodeRegistryCollisionError";
  }
}
