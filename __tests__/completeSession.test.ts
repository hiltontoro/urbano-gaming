import { describe, expect, it } from "vitest";

import { createSession } from "../lib/session/createSession";
import { setSessionCapabilities } from "../lib/session/setSessionCapabilities";
import { joinSession } from "../lib/session/joinSession";
import { lockLobby } from "../lib/session/lockLobby";
import { getSession } from "../lib/session/getSession";
import { completeSession } from "../lib/session/completeSession";
import { InMemorySessionRepository } from "../lib/session/db/inMemorySessionRepository";
import {
  SessionNotFoundError,
  HostTokenMismatchError,
  SessionAlreadyCompleteError,
} from "../lib/session/types";
import { RoomCodeRegistryCollisionError } from "../lib/rooms/types";

describe("COMPLETE_SESSION", () => {
  it("transitions a LOBBY_OPEN session to SESSION_COMPLETE and increments state_version", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);

    const result = await completeSession(repo, session.sessionId, session.hostToken);

    expect(result.sessionId).toBe(session.sessionId);
    expect(result.state).toBe("SESSION_COMPLETE");
    expect(result.stateVersion).toBe(session.stateVersion + 1);
  });

  it("transitions a LOBBY_LOCKED session to SESSION_COMPLETE — Interpretation 2 allows any non-complete source state", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);
    await lockLobby(repo, session.sessionId, session.hostToken);

    const result = await completeSession(repo, session.sessionId, session.hostToken);

    expect(result.state).toBe("SESSION_COMPLETE");
    expect(result.stateVersion).toBe(3); // 1 (create) -> 2 (lock) -> 3 (complete)
  });

  it("writes a SESSION_COMPLETED event", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);

    await completeSession(repo, session.sessionId, session.hostToken);
    const events = repo._getEventsForSession(session.sessionId);

    expect(events.find((e) => e.eventType === "SESSION_COMPLETED")).toBeDefined();
  });

  it("rejects a mismatched host token, leaving state unchanged", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);

    await expect(
      completeSession(repo, session.sessionId, "wrong-token")
    ).rejects.toBeInstanceOf(HostTokenMismatchError);

    const stored = await repo.getSessionById(session.sessionId);
    expect(stored?.state).toBe("LOBBY_OPEN");
    expect(stored?.stateVersion).toBe(session.stateVersion);
  });

  it("does not write a SESSION_COMPLETED event on a rejected host-token mismatch", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);

    await expect(
      completeSession(repo, session.sessionId, "wrong-token")
    ).rejects.toBeInstanceOf(HostTokenMismatchError);

    const events = repo._getEventsForSession(session.sessionId);
    expect(events.find((e) => e.eventType === "SESSION_COMPLETED")).toBeUndefined();
  });

  it("rejects a nonexistent session id", async () => {
    const repo = new InMemorySessionRepository();

    await expect(
      completeSession(repo, "11111111-1111-1111-1111-111111111111", "any-token")
    ).rejects.toBeInstanceOf(SessionNotFoundError);
  });

  it("rejects completing a session that is already SESSION_COMPLETE", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);
    await completeSession(repo, session.sessionId, session.hostToken);

    await expect(
      completeSession(repo, session.sessionId, session.hostToken)
    ).rejects.toBeInstanceOf(SessionAlreadyCompleteError);
  });

  describe("repository-level authority (closes the TOCTOU gap)", () => {
    it("in-memory proof: concurrent completion attempts on the same session yield exactly one success", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);

      const attempts = await Promise.allSettled([
        completeSession(repo, session.sessionId, session.hostToken),
        completeSession(repo, session.sessionId, session.hostToken),
      ]);

      const successes = attempts.filter((a) => a.status === "fulfilled");
      const failures = attempts.filter((a) => a.status === "rejected");

      expect(successes).toHaveLength(1);
      expect(failures).toHaveLength(1);

      const stored = await repo.getSessionById(session.sessionId);
      expect(stored?.stateVersion).toBe(session.stateVersion + 1);
    });

    it("in-memory proof: completeSession independently rejects an already-complete session, even when called directly (bypassing the domain fast-path)", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);
      repo._forceComplete(session.sessionId);

      const event = {
        sessionId: session.sessionId,
        eventType: "SESSION_COMPLETED" as const,
        payload: {},
      };

      await expect(
        repo.completeSession(session.sessionId, session.hostToken, event)
      ).rejects.toBeInstanceOf(SessionAlreadyCompleteError);
    });

    it("in-memory proof: completeSession independently rejects a mismatched host token, even when called directly", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);

      const event = {
        sessionId: session.sessionId,
        eventType: "SESSION_COMPLETED" as const,
        payload: {},
      };

      await expect(
        repo.completeSession(session.sessionId, "wrong-token", event)
      ).rejects.toBeInstanceOf(HostTokenMismatchError);
    });

    it(
      "real Postgres contract proof NOT available in this environment — " +
        "complete_session_atomically's row-locked re-check (0006 migration) " +
        "requires a live database connection to verify serialization behavior " +
        "under true concurrency. The tests above prove the logic path; " +
        "they do not prove Postgres row-lock serialization itself.",
      () => {
        expect(true).toBe(true);
      }
    );
  });

  describe("room-code reuse (the motivating gap this slice closes; Room Registry Slice 001 correction below)", () => {
    it("frees the room code at the sessions_room_code_active_unique layer once the original session is completed through the real command — but Room Registry v1 still forbids reuse", async () => {
      const repo = new InMemorySessionRepository();
      const first = await createSession(repo);
      await setSessionCapabilities(repo, first.sessionId, first.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);

      await completeSession(repo, first.sessionId, first.hostToken);

      // getActiveSessionByRoomCode must no longer resolve the completed
      // session for its own room code — this is the exact mechanism
      // sessions_room_code_active_unique depends on in production, and
      // remains true and untouched by the Room Registry.
      const activeMatch = await repo.getActiveSessionByRoomCode(first.roomCode);
      expect(activeMatch).toBeNull();

      // Room Registry Slice 001 correction: this test previously
      // stopped here and asserted that reuse succeeds — true only at
      // the sessions_room_code_active_unique layer just proven above.
      // The Founder's own Room Registry Slice 001 resolution deliberately
      // supersedes it system-wide: "once URBANO Gaming has issued a room
      // code through the Room Registry, that code never identifies
      // another runtime." rooms' own global, non-partial uniqueness
      // constraint is what now correctly forbids this, independently of
      // sessions' own already-freed view.
      const reusedSessionId = "22222222-2222-2222-2222-222222222222";
      const now = new Date().toISOString();
      await expect(
        repo.createSession(
          {
            sessionId: reusedSessionId,
            roomCode: first.roomCode,
            hostToken: "reuse-fixture-host-token",
            state: "LOBBY_OPEN",
            stateVersion: 1,
            pauseReason: null,
            currentPromptId: null,
            predecessorSessionId: null,
            createdAt: now,
            updatedAt: now,
            declaredCapabilities: [],
          },
          {
            sessionId: reusedSessionId,
            eventType: "SESSION_CREATED",
            payload: { roomCode: first.roomCode },
          }
        )
      ).rejects.toBeInstanceOf(RoomCodeRegistryCollisionError);
    });

    it("JOIN_SESSION rejects a room code whose session was completed through the real command", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);
      await completeSession(repo, session.sessionId, session.hostToken);

      await expect(
        joinSession(repo, session.roomCode, "TooLate")
      ).rejects.toBeInstanceOf(SessionNotFoundError);
    });

    it("GET_SESSION still returns state and participants after real completion", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);
      const participant = await joinSession(repo, session.roomCode, "Casey");
      await completeSession(repo, session.sessionId, session.hostToken);

      const result = await getSession(repo, session.sessionId, session.hostToken);

      expect(result.state).toBe("SESSION_COMPLETE");
      expect(result.participants).toEqual([
        { participantId: participant.participantId, displayName: "Casey" },
      ]);
    });
  });
});
