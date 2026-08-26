import { describe, expect, it } from "vitest";

import { createSession } from "../lib/session/createSession";
import { InMemorySessionRepository } from "../lib/session/db/inMemorySessionRepository";
import { createTable } from "../lib/gaming/poker/createTable";
import { InMemoryPokerRepository } from "../lib/gaming/poker/db/inMemoryPokerRepository";
import { InMemoryRoomStore, InMemoryRoomRepository } from "../lib/rooms/db/inMemoryRoomRepository";
import { resolveRoom } from "../lib/rooms/resolveRoom";
import { RoomNotFoundError, AmbiguousRoomError, RoomCodeRegistryCollisionError } from "../lib/rooms/types";

describe("Room Registry Slice 001", () => {
  describe("registration on creation", () => {
    it("registers a room when a Session is created, resolvable to that Session", async () => {
      const sharedStore = new InMemoryRoomStore();
      const sessionRepo = new InMemorySessionRepository(sharedStore);
      const pokerRepo = new InMemoryPokerRepository(sharedStore);

      const session = await createSession(sessionRepo);

      const result = await resolveRoom(
        { rooms: new InMemoryRoomRepository(sharedStore), sessions: sessionRepo, poker: pokerRepo },
        session.roomCode
      );

      expect(result).toEqual({
        roomCode: session.roomCode,
        runtimeType: "SESSION",
        runtimeId: session.sessionId,
      });
    });

    it("registers a room when a Poker table is created, resolvable to that table", async () => {
      const sharedStore = new InMemoryRoomStore();
      const sessionRepo = new InMemorySessionRepository(sharedStore);
      const pokerRepo = new InMemoryPokerRepository(sharedStore);

      const table = await createTable(pokerRepo);

      const result = await resolveRoom(
        { rooms: new InMemoryRoomRepository(sharedStore), sessions: sessionRepo, poker: pokerRepo },
        table.roomCode
      );

      expect(result).toEqual({
        roomCode: table.roomCode,
        runtimeType: "POKER_TABLE",
        runtimeId: table.pokerTableId,
      });
    });
  });

  describe("cross-runtime collision at allocation time (the defect this Slice closes)", () => {
    it("rejects a Poker table creation that collides with an already-issued Session room code", async () => {
      const sharedStore = new InMemoryRoomStore();
      const sessionRepo = new InMemorySessionRepository(sharedStore);
      const pokerRepo = new InMemoryPokerRepository(sharedStore);

      const now = new Date().toISOString();
      await sessionRepo.createSession(
        {
          sessionId: "11111111-1111-1111-1111-111111111111",
          roomCode: "SHARED1",
          hostToken: "host-token",
          state: "LOBBY_OPEN",
          stateVersion: 1,
          pauseReason: null,
          currentPromptId: null,
          predecessorSessionId: null,
          createdAt: now,
          updatedAt: now,
          declaredCapabilities: [],
        },
        { sessionId: "11111111-1111-1111-1111-111111111111", eventType: "SESSION_CREATED", payload: {} }
      );

      await expect(
        pokerRepo.createTable({
          pokerTableId: "22222222-2222-2222-2222-222222222222",
          roomCode: "SHARED1",
          hostToken: "poker-host-token",
          maxSeats: 6,
          closedAt: null,
          createdAt: now,
          startingStack: 1000,
          smallBlind: 5,
          bigBlind: 10,
        })
      ).rejects.toBeInstanceOf(RoomCodeRegistryCollisionError);

      // Nothing partially persisted from the rejected attempt — the
      // same "no mutation before every validation succeeds" guarantee
      // create_poker_table_atomically (0154) gives for free via a real
      // transaction.
      expect(await pokerRepo.getTableById("22222222-2222-2222-2222-222222222222")).toBeNull();
    });

    it("rejects a Session creation that collides with an already-issued Poker table room code (symmetric case)", async () => {
      const sharedStore = new InMemoryRoomStore();
      const sessionRepo = new InMemorySessionRepository(sharedStore);
      const pokerRepo = new InMemoryPokerRepository(sharedStore);

      const now = new Date().toISOString();
      await pokerRepo.createTable({
        pokerTableId: "33333333-3333-3333-3333-333333333333",
        roomCode: "SHARED2",
        hostToken: "poker-host-token",
        maxSeats: 6,
        closedAt: null,
        createdAt: now,
        startingStack: 1000,
        smallBlind: 5,
        bigBlind: 10,
      });

      await expect(
        sessionRepo.createSession(
          {
            sessionId: "44444444-4444-4444-4444-444444444444",
            roomCode: "SHARED2",
            hostToken: "host-token",
            state: "LOBBY_OPEN",
            stateVersion: 1,
            pauseReason: null,
            currentPromptId: null,
            predecessorSessionId: null,
            createdAt: now,
            updatedAt: now,
            declaredCapabilities: [],
          },
          { sessionId: "44444444-4444-4444-4444-444444444444", eventType: "SESSION_CREATED", payload: {} }
        )
      ).rejects.toBeInstanceOf(RoomCodeRegistryCollisionError);

      expect(await sessionRepo.getSessionById("44444444-4444-4444-4444-444444444444")).toBeNull();
    });
  });

  describe("legacy fallback (pre-Slice-001 records with no rooms row)", () => {
    // A repository whose Session/Poker records were created without
    // going through the shared room registry — exactly what every
    // pre-Slice-001 production row looks like. Achieved by giving the
    // resolver's own `rooms` lookup a *different*, disconnected store
    // than whatever store the repositories themselves may have
    // registered into: getActiveSessionByRoomCode/getActiveTableByRoomCode
    // never touch the room store at all (unmodified by this Slice), so
    // this precisely simulates a legacy record with no test-only
    // backdoor needed on the repositories themselves.

    it("resolves a legacy Session with no rooms row via the fallback lookup", async () => {
      const sessionRepo = new InMemorySessionRepository();
      const pokerRepo = new InMemoryPokerRepository();
      const session = await createSession(sessionRepo);

      const disconnectedRoomsRepo = new InMemoryRoomRepository(new InMemoryRoomStore());

      const result = await resolveRoom(
        { rooms: disconnectedRoomsRepo, sessions: sessionRepo, poker: pokerRepo },
        session.roomCode
      );

      expect(result).toEqual({
        roomCode: session.roomCode,
        runtimeType: "SESSION",
        runtimeId: session.sessionId,
      });
    });

    it("resolves a legacy Poker table with no rooms row via the fallback lookup", async () => {
      const sessionRepo = new InMemorySessionRepository();
      const pokerRepo = new InMemoryPokerRepository();
      const table = await createTable(pokerRepo);

      const disconnectedRoomsRepo = new InMemoryRoomRepository(new InMemoryRoomStore());

      const result = await resolveRoom(
        { rooms: disconnectedRoomsRepo, sessions: sessionRepo, poker: pokerRepo },
        table.roomCode
      );

      expect(result).toEqual({
        roomCode: table.roomCode,
        runtimeType: "POKER_TABLE",
        runtimeId: table.pokerTableId,
      });
    });

    it("throws RoomNotFoundError when no room, Session, or Poker table matches the code", async () => {
      const sessionRepo = new InMemorySessionRepository();
      const pokerRepo = new InMemoryPokerRepository();
      const roomsRepo = new InMemoryRoomRepository();

      await expect(
        resolveRoom({ rooms: roomsRepo, sessions: sessionRepo, poker: pokerRepo }, "NOPE99")
      ).rejects.toBeInstanceOf(RoomNotFoundError);
    });

    // Founder decision (Room Registry Slice 001 resolution): fail
    // closed. A legacy code found active in both tables at once must
    // never be silently routed toward either runtime.
    it("fails closed with AmbiguousRoomError when a legacy code matches both an active Session and an active Poker table", async () => {
      const sessionRepo = new InMemorySessionRepository(); // own private room store
      const pokerRepo = new InMemoryPokerRepository(); // own private room store — independent, so they don't collide with each other while being set up
      const now = new Date().toISOString();

      await sessionRepo.createSession(
        {
          sessionId: "55555555-5555-5555-5555-555555555555",
          roomCode: "AMBIG01",
          hostToken: "host-token",
          state: "LOBBY_OPEN",
          stateVersion: 1,
          pauseReason: null,
          currentPromptId: null,
          predecessorSessionId: null,
          createdAt: now,
          updatedAt: now,
          declaredCapabilities: [],
        },
        { sessionId: "55555555-5555-5555-5555-555555555555", eventType: "SESSION_CREATED", payload: {} }
      );
      await pokerRepo.createTable({
        pokerTableId: "66666666-6666-6666-6666-666666666666",
        roomCode: "AMBIG01",
        hostToken: "poker-host-token",
        maxSeats: 6,
        closedAt: null,
        createdAt: now,
        startingStack: 1000,
        smallBlind: 5,
        bigBlind: 10,
      });

      const disconnectedRoomsRepo = new InMemoryRoomRepository(new InMemoryRoomStore());

      await expect(
        resolveRoom(
          { rooms: disconnectedRoomsRepo, sessions: sessionRepo, poker: pokerRepo },
          "AMBIG01"
        )
      ).rejects.toBeInstanceOf(AmbiguousRoomError);
    });
  });
});
