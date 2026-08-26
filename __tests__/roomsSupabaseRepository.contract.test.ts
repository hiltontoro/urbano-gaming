import { loadEnv } from "vite";
import { createClient } from "@supabase/supabase-js";
import { randomUUID } from "crypto";
import { afterAll, describe, expect, it } from "vitest";

import { SupabaseRoomRepository } from "../lib/rooms/db/supabaseRoomRepository";
import { SupabaseSessionRepository } from "../lib/session/db/supabaseSessionRepository";
import { SupabasePokerRepository } from "../lib/gaming/poker/db/supabasePokerRepository";
import { createSession } from "../lib/session/createSession";
import { createTable } from "../lib/gaming/poker/createTable";
import { resolveRoom } from "../lib/rooms/resolveRoom";
import { RoomNotFoundError, AmbiguousRoomError } from "../lib/rooms/types";

const env = loadEnv("development", process.cwd(), "");
const supabaseUrl = env.SUPABASE_URL;
const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error(
    "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for contract tests."
  );
}

const roomsRepo = new SupabaseRoomRepository(supabaseUrl, supabaseServiceRoleKey);
const sessionRepo = new SupabaseSessionRepository(supabaseUrl, supabaseServiceRoleKey);
const pokerRepo = new SupabasePokerRepository(supabaseUrl, supabaseServiceRoleKey);
const cleanupClient = createClient(supabaseUrl, supabaseServiceRoleKey);

const createdSessionIds: string[] = [];
const createdPokerTableIds: string[] = [];

function freshRoomCode(prefix: string): string {
  // Deterministic-enough-for-a-single-test-run codes, distinct from the
  // real generateRoomCode() alphabet on purpose — these are used only
  // to force exact, chosen collisions the random generator could not
  // reliably be made to produce, never to simulate real allocation.
  return (prefix + randomUUID().replace(/-/g, "").toUpperCase()).slice(0, 12);
}

afterAll(async () => {
  // rooms rows reference sessions/poker_tables via a real FK — must be
  // deleted first, or the parent deletes below would be blocked.
  if (createdSessionIds.length > 0) {
    await cleanupClient.from("rooms").delete().in("session_id", createdSessionIds);
  }
  if (createdPokerTableIds.length > 0) {
    await cleanupClient.from("rooms").delete().in("poker_table_id", createdPokerTableIds);
  }
  if (createdSessionIds.length > 0) {
    await cleanupClient.from("session_events").delete().in("session_id", createdSessionIds);
    await cleanupClient.from("sessions").delete().in("session_id", createdSessionIds);
  }
  if (createdPokerTableIds.length > 0) {
    await cleanupClient.from("poker_tables").delete().in("poker_table_id", createdPokerTableIds);
  }
});

describe("Room Registry Slice 001 — SupabaseRoomRepository contract", () => {
  it("create_session_atomically registers a room in the same transaction, resolvable via resolveRoom", async () => {
    const session = await createSession(sessionRepo);
    createdSessionIds.push(session.sessionId);

    const roomRow = await roomsRepo.findByRoomCode(session.roomCode);
    expect(roomRow).not.toBeNull();
    expect(roomRow?.runtimeType).toBe("SESSION");
    expect(roomRow?.runtimeId).toBe(session.sessionId);

    const resolved = await resolveRoom(
      { rooms: roomsRepo, sessions: sessionRepo, poker: pokerRepo },
      session.roomCode
    );
    expect(resolved).toEqual({
      roomCode: session.roomCode,
      runtimeType: "SESSION",
      runtimeId: session.sessionId,
    });
  });

  it("create_poker_table_atomically registers a room in the same transaction, resolvable via resolveRoom", async () => {
    const table = await createTable(pokerRepo);
    createdPokerTableIds.push(table.pokerTableId);

    const roomRow = await roomsRepo.findByRoomCode(table.roomCode);
    expect(roomRow).not.toBeNull();
    expect(roomRow?.runtimeType).toBe("POKER_TABLE");
    expect(roomRow?.runtimeId).toBe(table.pokerTableId);

    const resolved = await resolveRoom(
      { rooms: roomsRepo, sessions: sessionRepo, poker: pokerRepo },
      table.roomCode
    );
    expect(resolved).toEqual({
      roomCode: table.roomCode,
      runtimeType: "POKER_TABLE",
      runtimeId: table.pokerTableId,
    });
  });

  // Note on which constraint actually fires: for a same-table (Session
  // vs. Session) collision specifically, sessions_room_code_active_unique
  // fires first — the sessions insert happens before the rooms insert
  // in create_session_atomically's own body (0153), and that pre-existing
  // constraint alone already catches this case. rooms_room_code_unique
  // is the constraint that matters for the case sessions' own index
  // cannot see at all — a genuine cross-runtime collision, proven in
  // the very next test below. What this test actually proves either
  // way: whichever constraint fires, the *whole transaction* rolls
  // back, confirmed by the second session's total absence afterward.
  it("create_session_atomically rolls back the whole transaction on a real room-code collision — nothing partially persists", async () => {
    const roomCode = freshRoomCode("RM");
    const firstSessionId = randomUUID();
    const secondSessionId = randomUUID();
    const now = new Date().toISOString();

    const first = await cleanupClient.rpc("create_session_atomically", {
      p_session_id: firstSessionId,
      p_room_code: roomCode,
      p_host_token: "contract-host-token-1",
      p_state: "LOBBY_OPEN",
      p_state_version: 1,
      p_pause_reason: null,
      p_created_at: now,
      p_updated_at: now,
      p_event_type: "SESSION_CREATED",
      p_event_payload: {},
      // Pre-existing schema quirk, unrelated to this Slice: 0029's own
      // CREATE OR REPLACE added this parameter without dropping the
      // original 10-param signature first, leaving two real overloads
      // of create_session_atomically in Postgres (confirmed via direct
      // pg_proc inspection). SupabaseSessionRepository.createSession()
      // already always passes this explicitly and is unaffected; a raw
      // RPC call omitting it hits PostgREST's own genuine overload-
      // resolution ambiguity (PGRST203). Passed explicitly throughout
      // this file for the same reason.
      p_predecessor_session_id: null,
    });
    expect(first.error).toBeNull();
    createdSessionIds.push(firstSessionId);

    const second = await cleanupClient.rpc("create_session_atomically", {
      p_session_id: secondSessionId,
      p_room_code: roomCode,
      p_host_token: "contract-host-token-2",
      p_state: "LOBBY_OPEN",
      p_state_version: 1,
      p_pause_reason: null,
      p_created_at: now,
      p_updated_at: now,
      p_event_type: "SESSION_CREATED",
      p_event_payload: {},
      p_predecessor_session_id: null,
    });
    expect(second.error).not.toBeNull();
    expect(second.error?.code).toBe("23505");
    expect(second.error?.message).toContain("sessions_room_code_active_unique");

    // The whole transaction rolled back, not just the rooms insert —
    // the second session must not exist at all.
    const { data: secondSessionRow } = await cleanupClient
      .from("sessions")
      .select("session_id")
      .eq("session_id", secondSessionId)
      .maybeSingle();
    expect(secondSessionRow).toBeNull();
  });

  it("create_poker_table_atomically rejects a real cross-runtime collision against an already-registered Session room code, with no partial persistence", async () => {
    const roomCode = freshRoomCode("XR");
    const now = new Date().toISOString();

    const sessionInsert = await cleanupClient.rpc("create_session_atomically", {
      p_session_id: randomUUID(),
      p_room_code: roomCode,
      p_host_token: "contract-host-token-3",
      p_state: "LOBBY_OPEN",
      p_state_version: 1,
      p_pause_reason: null,
      p_created_at: now,
      p_updated_at: now,
      p_event_type: "SESSION_CREATED",
      p_event_payload: {},
      p_predecessor_session_id: null,
    });
    expect(sessionInsert.error).toBeNull();
    const sessionRoom = await roomsRepo.findByRoomCode(roomCode);
    if (sessionRoom?.runtimeType === "SESSION") createdSessionIds.push(sessionRoom.runtimeId);

    const pokerTableId = randomUUID();
    const tableInsert = await cleanupClient.rpc("create_poker_table_atomically", {
      p_poker_table_id: pokerTableId,
      p_room_code: roomCode,
      p_host_token: "contract-poker-host-token",
      p_max_seats: 6,
      p_starting_stack: 1000,
      p_small_blind: 5,
      p_big_blind: 10,
    });
    expect(tableInsert.error).not.toBeNull();
    expect(tableInsert.error?.code).toBe("23505");
    expect(tableInsert.error?.message).toContain("rooms_room_code_unique");

    const { data: orphanTable } = await cleanupClient
      .from("poker_tables")
      .select("poker_table_id")
      .eq("poker_table_id", pokerTableId)
      .maybeSingle();
    expect(orphanTable).toBeNull(); // rolled back, not left dangling with no room

    // resolveRoom still correctly resolves to the Session that
    // legitimately holds the code — the rejected Poker attempt left no trace.
    const resolved = await resolveRoom(
      { rooms: roomsRepo, sessions: sessionRepo, poker: pokerRepo },
      roomCode
    );
    expect(resolved.runtimeType).toBe("SESSION");
  });

  it("real concurrency: two simultaneous create_session_atomically calls for the same room code — exactly one persists", async () => {
    const roomCode = freshRoomCode("CC");
    const idA = randomUUID();
    const idB = randomUUID();
    const now = new Date().toISOString();

    const call = (sessionId: string, hostToken: string) =>
      cleanupClient.rpc("create_session_atomically", {
        p_session_id: sessionId,
        p_room_code: roomCode,
        p_host_token: hostToken,
        p_state: "LOBBY_OPEN",
        p_state_version: 1,
        p_pause_reason: null,
        p_created_at: now,
        p_updated_at: now,
        p_event_type: "SESSION_CREATED",
        p_event_payload: {},
        p_predecessor_session_id: null,
      });

    const [resultA, resultB] = await Promise.allSettled([
      call(idA, "concurrent-host-a"),
      call(idB, "concurrent-host-b"),
    ]);

    const errors = [resultA, resultB].map((r) =>
      r.status === "fulfilled" ? r.value.error : r.reason
    );
    const successCount = errors.filter((e) => !e).length;
    expect(successCount).toBe(1);

    const winnerId = !errors[0] ? idA : idB;
    createdSessionIds.push(winnerId);

    const roomRow = await roomsRepo.findByRoomCode(roomCode);
    expect(roomRow?.runtimeId).toBe(winnerId);
  });

  it("legacy fallback: a Session row with no rooms row (simulating pre-Slice-001 data) still resolves", async () => {
    const roomCode = freshRoomCode("LG");
    const legacySessionId = randomUUID();
    const now = new Date().toISOString();

    // Raw insert, deliberately bypassing create_session_atomically —
    // this is exactly the shape of every row that existed before this
    // Slice's migrations ran.
    const { error } = await cleanupClient.from("sessions").insert({
      session_id: legacySessionId,
      room_code: roomCode,
      host_token: "legacy-host-token",
      state: "LOBBY_OPEN",
      state_version: 1,
      created_at: now,
      updated_at: now,
      declared_capabilities: [],
    });
    expect(error).toBeNull();
    createdSessionIds.push(legacySessionId);

    expect(await roomsRepo.findByRoomCode(roomCode)).toBeNull();

    const resolved = await resolveRoom(
      { rooms: roomsRepo, sessions: sessionRepo, poker: pokerRepo },
      roomCode
    );
    expect(resolved).toEqual({
      roomCode,
      runtimeType: "SESSION",
      runtimeId: legacySessionId,
    });
  });

  it("legacy collision: fails closed with AmbiguousRoomError when both a legacy Session and a legacy Poker table share a code", async () => {
    const roomCode = freshRoomCode("AM");
    const legacySessionId = randomUUID();
    const legacyPokerTableId = randomUUID();
    const now = new Date().toISOString();

    const sessionInsert = await cleanupClient.from("sessions").insert({
      session_id: legacySessionId,
      room_code: roomCode,
      host_token: "legacy-ambig-host-token",
      state: "LOBBY_OPEN",
      state_version: 1,
      created_at: now,
      updated_at: now,
      declared_capabilities: [],
    });
    expect(sessionInsert.error).toBeNull();
    createdSessionIds.push(legacySessionId);

    const tableInsert = await cleanupClient.from("poker_tables").insert({
      poker_table_id: legacyPokerTableId,
      room_code: roomCode,
      host_token: "legacy-ambig-poker-host-token",
      max_seats: 6,
      starting_stack: 1000,
      small_blind: 5,
      big_blind: 10,
    });
    expect(tableInsert.error).toBeNull();
    createdPokerTableIds.push(legacyPokerTableId);

    await expect(
      resolveRoom({ rooms: roomsRepo, sessions: sessionRepo, poker: pokerRepo }, roomCode)
    ).rejects.toBeInstanceOf(AmbiguousRoomError);
  });

  it("resolveRoom throws RoomNotFoundError for a code that has never existed", async () => {
    await expect(
      resolveRoom(
        { rooms: roomsRepo, sessions: sessionRepo, poker: pokerRepo },
        "ZZNEVER1"
      )
    ).rejects.toBeInstanceOf(RoomNotFoundError);
  });
});
