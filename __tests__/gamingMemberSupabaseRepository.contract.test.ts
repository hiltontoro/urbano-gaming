import { randomUUID } from "node:crypto";

import { loadEnv } from "vite";
import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";

import { SupabaseGamingRepository } from "../lib/gaming/db/supabaseGamingRepository";
import {
  EmptyGamingDisplayNameError,
} from "../lib/gaming/types";
import { SupabaseSessionRepository } from "../lib/session/db/supabaseSessionRepository";
import { GamingMemberAlreadyInSessionError } from "../lib/session/types";
import type { ParticipantRecord } from "../lib/session/db/sessionRepository";
import type { SessionRecord } from "../lib/session/types";

const env = loadEnv("development", process.cwd(), "");

const supabaseUrl = env.SUPABASE_URL;
const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error(
    "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for contract tests."
  );
}

const gamingRepository = new SupabaseGamingRepository(
  supabaseUrl,
  supabaseServiceRoleKey
);
const sessionRepository = new SupabaseSessionRepository(
  supabaseUrl,
  supabaseServiceRoleKey
);
const cleanupClient = createClient(supabaseUrl, supabaseServiceRoleKey);

const createdAuthUserIds: string[] = [];
const createdSessionIds: string[] = [];

/**
 * Creates a real auth.users row via the Admin API — this contract
 * suite only ever runs against the local Supabase stack (see the
 * established convention this file follows: SUPABASE_URL/
 * SUPABASE_SERVICE_ROLE_KEY passed as explicit shell env vars pointed
 * at local, .env.local's production value never touched). Gaming
 * Member cascade-delete (0045) is only provable against a genuine
 * auth.users row, not a fabricated uuid.
 */
async function createRealAuthUser(): Promise<string> {
  const email = `gaming-contract-${randomUUID()}@example.com`;
  const { data, error } = await cleanupClient.auth.admin.createUser({
    email,
    email_confirm: true,
  });
  if (error || !data.user) {
    throw error ?? new Error("Failed to create test auth user.");
  }
  createdAuthUserIds.push(data.user.id);
  return data.user.id;
}

function generateRoomCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => {
    const index = Math.floor(Math.random() * alphabet.length);
    return alphabet[index];
  }).join("");
}

function buildSessionRecord(overrides: Partial<SessionRecord> = {}): SessionRecord {
  const now = new Date().toISOString();
  return {
    sessionId: randomUUID(),
    roomCode: generateRoomCode(),
    hostToken: `gaming-contract-host-token-${randomUUID()}`,
    state: "LOBBY_OPEN",
    stateVersion: 1,
    pauseReason: null,
    currentPromptId: null,
    predecessorSessionId: null,
    createdAt: now,
    updatedAt: now,
    declaredCapabilities: [],
    ...overrides,
  };
}

function buildParticipantRecord(
  sessionId: string,
  overrides: Partial<ParticipantRecord> = {}
): ParticipantRecord {
  const displayName =
    overrides.displayName ?? `GamingContract-${randomUUID().slice(0, 8)}`;
  return {
    participantId: randomUUID(),
    sessionId,
    displayName,
    normalizedDisplayName: displayName.toLowerCase(),
    participantToken: `gaming-contract-participant-token-${randomUUID()}`,
    joinedAt: new Date().toISOString(),
    gamingMemberId: null,
    ...overrides,
  };
}

afterAll(async () => {
  if (createdSessionIds.length > 0) {
    await cleanupClient
      .from("session_events")
      .delete()
      .in("session_id", createdSessionIds);
    await cleanupClient
      .from("sessions")
      .delete()
      .in("session_id", createdSessionIds);
  }

  // Cascades to gaming_members (0045) automatically — this is itself
  // part of what several tests below prove, not just cleanup.
  for (const authUserId of createdAuthUserIds) {
    await cleanupClient.auth.admin.deleteUser(authUserId);
  }
});

describe("SupabaseGamingRepository contract", () => {
  it("creates a Gaming Member against a real auth.users row", async () => {
    const authUserId = await createRealAuthUser();

    const member = await gamingRepository.createGamingMember(
      authUserId,
      "Contract Member"
    );

    expect(member.authUserId).toBe(authUserId);
    expect(member.displayName).toBe("Contract Member");

    const resolved = await gamingRepository.resolveGamingMemberByAuthUserId(
      authUserId
    );
    expect(resolved).toEqual(member);
  });

  it("rejects auth_user_id values that do not reference a real auth.users row (FK enforcement)", async () => {
    const fakeAuthUserId = randomUUID();

    let caught: unknown;
    try {
      await gamingRepository.createGamingMember(fakeAuthUserId, "Ghost");
    } catch (err) {
      caught = err;
    }

    expect(caught).toBeDefined();
    expect((caught as { code?: string }).code).toBe("23503");
  });

  it("enforces the display_name length check constraint — empty name rejected", async () => {
    const authUserId = await createRealAuthUser();

    await expect(
      gamingRepository.createGamingMember(authUserId, "")
    ).rejects.toBeInstanceOf(EmptyGamingDisplayNameError);
  });

  it("is idempotent under concurrent creation for the same auth_user_id — exactly one row, first display_name wins", async () => {
    const authUserId = await createRealAuthUser();

    const [first, second] = await Promise.all([
      gamingRepository.createGamingMember(authUserId, "First"),
      gamingRepository.createGamingMember(authUserId, "Second"),
    ]);

    expect(first.gamingMemberId).toBe(second.gamingMemberId);
    expect([first.displayName, second.displayName]).toEqual([
      first.displayName,
      first.displayName,
    ]);

    const { count, error } = await cleanupClient
      .from("gaming_members")
      .select("gaming_member_id", { count: "exact", head: true })
      .eq("auth_user_id", authUserId);
    expect(error).toBeNull();
    expect(count).toBe(1);
  });

  it("cascades: deleting the auth.users row deletes the Gaming Member", async () => {
    const authUserId = await createRealAuthUser();
    await gamingRepository.createGamingMember(authUserId, "Soon Deleted");

    const { error: deleteError } = await cleanupClient.auth.admin.deleteUser(
      authUserId
    );
    expect(deleteError).toBeNull();
    createdAuthUserIds.splice(createdAuthUserIds.indexOf(authUserId), 1);

    const resolved = await gamingRepository.resolveGamingMemberByAuthUserId(
      authUserId
    );
    expect(resolved).toBeNull();
  });

  // The former gaming_admins/isGamingAdmin binary authority was retired
  // in Predictions A1 — superseded by Admin Control Plane A0's
  // authority_grants (see __tests__/adminAuthoritySupabaseRepository.
  // contract.test.ts for the equivalent live-Postgres coverage).

  it("join_participant_atomically links a real Gaming Member to a new Participant", async () => {
    const authUserId = await createRealAuthUser();
    const member = await gamingRepository.createGamingMember(
      authUserId,
      "Joins For Real"
    );

    const session = buildSessionRecord();
    createdSessionIds.push(session.sessionId);
    await sessionRepository.createSession(session, {
      sessionId: session.sessionId,
      eventType: "SESSION_CREATED",
      payload: { roomCode: session.roomCode },
    });
    await sessionRepository.setSessionCapabilities(session.sessionId, session.hostToken, [
      "OPEN_RESPONSE",
      "VOTING",
      "TRIVIA",
      "QUIZ",
    ]);

    const record = buildParticipantRecord(session.sessionId, {
      gamingMemberId: member.gamingMemberId,
    });
    await sessionRepository.joinParticipant(record, {
      sessionId: session.sessionId,
      eventType: "PARTICIPANT_JOINED",
      payload: { participantId: record.participantId, displayName: record.displayName },
    });

    const participants = await sessionRepository.getParticipantsForSession(
      session.sessionId
    );
    const linked = participants.find(
      (p) => p.participantId === record.participantId
    );
    expect(linked?.gamingMemberId).toBe(member.gamingMemberId);
  });

  it("participants_session_gaming_member_unique rejects a second Participant for the same Gaming Member in the same Session", async () => {
    const authUserId = await createRealAuthUser();
    const member = await gamingRepository.createGamingMember(
      authUserId,
      "Duplicate Attempt"
    );

    const session = buildSessionRecord();
    createdSessionIds.push(session.sessionId);
    await sessionRepository.createSession(session, {
      sessionId: session.sessionId,
      eventType: "SESSION_CREATED",
      payload: { roomCode: session.roomCode },
    });
    await sessionRepository.setSessionCapabilities(session.sessionId, session.hostToken, [
      "OPEN_RESPONSE",
      "VOTING",
      "TRIVIA",
      "QUIZ",
    ]);

    const first = buildParticipantRecord(session.sessionId, {
      gamingMemberId: member.gamingMemberId,
    });
    await sessionRepository.joinParticipant(first, {
      sessionId: session.sessionId,
      eventType: "PARTICIPANT_JOINED",
      payload: { participantId: first.participantId, displayName: first.displayName },
    });

    const second = buildParticipantRecord(session.sessionId, {
      gamingMemberId: member.gamingMemberId,
    });

    await expect(
      sessionRepository.joinParticipant(second, {
        sessionId: session.sessionId,
        eventType: "PARTICIPANT_JOINED",
        payload: { participantId: second.participantId, displayName: second.displayName },
      })
    ).rejects.toBeInstanceOf(GamingMemberAlreadyInSessionError);
  });

  it("deleting a Gaming Member SET NULLs its historical Participant linkage, without deleting the Participant", async () => {
    const authUserId = await createRealAuthUser();
    const member = await gamingRepository.createGamingMember(
      authUserId,
      "Later Removed"
    );

    const session = buildSessionRecord();
    createdSessionIds.push(session.sessionId);
    await sessionRepository.createSession(session, {
      sessionId: session.sessionId,
      eventType: "SESSION_CREATED",
      payload: { roomCode: session.roomCode },
    });
    await sessionRepository.setSessionCapabilities(session.sessionId, session.hostToken, [
      "OPEN_RESPONSE",
      "VOTING",
      "TRIVIA",
      "QUIZ",
    ]);

    const record = buildParticipantRecord(session.sessionId, {
      gamingMemberId: member.gamingMemberId,
    });
    await sessionRepository.joinParticipant(record, {
      sessionId: session.sessionId,
      eventType: "PARTICIPANT_JOINED",
      payload: { participantId: record.participantId, displayName: record.displayName },
    });

    // Delete the Gaming Member directly (not via auth cascade) to
    // isolate ON DELETE SET NULL from ON DELETE CASCADE.
    await cleanupClient
      .from("gaming_members")
      .delete()
      .eq("gaming_member_id", member.gamingMemberId);
    createdAuthUserIds.splice(createdAuthUserIds.indexOf(authUserId), 1);
    await cleanupClient.auth.admin.deleteUser(authUserId);

    const participants = await sessionRepository.getParticipantsForSession(
      session.sessionId
    );
    const survivor = participants.find(
      (p) => p.participantId === record.participantId
    );
    expect(survivor).toBeDefined();
    expect(survivor?.gamingMemberId).toBeNull();
    expect(survivor?.displayName).toBe(record.displayName);
  });
});
