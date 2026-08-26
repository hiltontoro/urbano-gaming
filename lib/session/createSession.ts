import { randomUUID } from "crypto";
import { generateRoomCode } from "./roomCode";
import { generateHostToken } from "./hostToken";
import type { SessionRepository } from "./db/sessionRepository";
import type { CreateSessionResult, SessionRecord } from "./types";
import { RoomCodeCollisionError } from "./types";
import { RoomCodeRegistryCollisionError } from "../rooms/types";

/**
 * CREATE_SESSION command handler.
 *
 * Scope: creates exactly one session record in LOBBY_OPEN with
 * state_version = 1, pause_reason = null, a unique active room code,
 * and a host token. Writes one event log entry. Nothing else.
 *
 * This function contains no transport concerns (HTTP, auth headers) —
 * those belong to the API route that calls it. This keeps the command
 * logic testable independent of Next.js or Supabase specifics.
 */

const MAX_ROOM_CODE_RETRIES = 5;

export async function createSession(
  repo: SessionRepository
): Promise<CreateSessionResult> {
  let lastError: unknown;

  for (let attempt = 0; attempt < MAX_ROOM_CODE_RETRIES; attempt++) {
    const now = new Date().toISOString();
    const record: SessionRecord = {
      sessionId: randomUUID(),
      roomCode: generateRoomCode(),
      hostToken: generateHostToken(),
      state: "LOBBY_OPEN",
      stateVersion: 1,
      pauseReason: null,
      currentPromptId: null,
      predecessorSessionId: null,
      createdAt: now,
      updatedAt: now,
      declaredCapabilities: [],
    };

    try {
      await repo.createSession(record, {
  sessionId: record.sessionId,
  eventType: "SESSION_CREATED",
  payload: {
    roomCode: record.roomCode,
  },
});

      return {
        sessionId: record.sessionId,
        roomCode: record.roomCode,
        hostToken: record.hostToken,
        state: record.state,
        stateVersion: record.stateVersion,
      };
    } catch (err) {
      // Room Registry Slice 001: a collision can now also surface as
      // RoomCodeRegistryCollisionError — this exact code was already
      // issued to some other runtime, active or historical, a case
      // sessions_room_code_active_unique alone cannot see (rooms.
      // room_code is global and non-reusable, per the Founder's own
      // Room Registry Slice 001 resolution). Both error classes mean
      // exactly the same thing to this loop: regenerate and retry.
      if (err instanceof RoomCodeCollisionError || err instanceof RoomCodeRegistryCollisionError) {
        lastError = err;
        continue; // regenerate and retry, per finalized data model
      }
      throw err;
    }
  }

  throw new Error(
    `Failed to allocate a unique room code after ${MAX_ROOM_CODE_RETRIES} attempts.`
  );
  // lastError intentionally not re-thrown directly — this message is more
  // actionable for operators than surfacing the final collision alone.
  void lastError;
}
