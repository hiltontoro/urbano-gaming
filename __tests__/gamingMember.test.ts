import { describe, expect, it } from "vitest";

import { createSession } from "../lib/session/createSession";
import { setSessionCapabilities } from "../lib/session/setSessionCapabilities";
import { joinSession } from "../lib/session/joinSession";
import { submitResponse } from "../lib/session/submitResponse";
import { startSession } from "../lib/session/startSession";
import { InMemorySessionRepository } from "../lib/session/db/inMemorySessionRepository";
import {
  DisplayNameTakenError,
  GamingMemberAlreadyInSessionError,
} from "../lib/session/types";

import { resolveGamingMember } from "../lib/gaming/resolveGamingMember";
import { createGamingMember } from "../lib/gaming/createGamingMember";
import { InMemoryGamingRepository } from "../lib/gaming/db/inMemoryGamingRepository";
import {
  EmptyGamingDisplayNameError,
  GamingDisplayNameTooLongError,
} from "../lib/gaming/types";
import {
  resolveGamingAuth,
  type AuthUserVerifier,
} from "../lib/gaming/auth";

/** Deterministic fake — maps known bearer tokens to authUserIds only. */
class FakeAuthUserVerifier implements AuthUserVerifier {
  constructor(private tokenToAuthUserId: Record<string, string>) {}

  async verifyAccessToken(
    accessToken: string
  ): Promise<{ authUserId: string } | null> {
    const authUserId = this.tokenToAuthUserId[accessToken];
    return authUserId ? { authUserId } : null;
  }
}

describe("Gaming Member — CREATE_GAMING_MEMBER", () => {
  it("creates a Gaming Member with a valid, trimmed display name", async () => {
    const repo = new InMemoryGamingRepository();

    const member = await createGamingMember(repo, "auth-1", "  Alex  ");

    expect(member.gamingMemberId).toBeTruthy();
    expect(member.authUserId).toBe("auth-1");
    expect(member.displayName).toBe("Alex");
    expect(member.createdAt).toBeTruthy();
  });

  it("is idempotent under a duplicate/concurrent create for the same authUserId — returns the original row, never overwritten", async () => {
    const repo = new InMemoryGamingRepository();

    const first = await createGamingMember(repo, "auth-2", "Original Name");
    const second = await createGamingMember(repo, "auth-2", "Different Name");

    expect(second.gamingMemberId).toBe(first.gamingMemberId);
    expect(second.displayName).toBe("Original Name");
  });

  it("rejects an empty (post-trim) display name", async () => {
    const repo = new InMemoryGamingRepository();

    await expect(
      createGamingMember(repo, "auth-3", "   ")
    ).rejects.toBeInstanceOf(EmptyGamingDisplayNameError);
  });

  it("rejects a display name exceeding 40 characters after trimming", async () => {
    const repo = new InMemoryGamingRepository();
    const tooLong = "x".repeat(41);

    await expect(
      createGamingMember(repo, "auth-4", tooLong)
    ).rejects.toBeInstanceOf(GamingDisplayNameTooLongError);
  });

  it("never creates a placeholder row — a row's existence always carries a real display_name", async () => {
    const repo = new InMemoryGamingRepository();

    await expect(
      createGamingMember(repo, "auth-5", "")
    ).rejects.toBeInstanceOf(EmptyGamingDisplayNameError);

    const resolved = await resolveGamingMember(repo, "auth-5");
    expect(resolved).toBeNull();
  });
});

describe("Gaming Member — RESOLVE_GAMING_MEMBER", () => {
  it("resolves an existing Gaming Member by authUserId", async () => {
    const repo = new InMemoryGamingRepository();
    const created = await createGamingMember(repo, "auth-6", "Riley");

    const resolved = await resolveGamingMember(repo, "auth-6");

    expect(resolved).toEqual(created);
  });

  it("returns null (not an error) for an auth user with no completed profile — resolve never creates", async () => {
    const repo = new InMemoryGamingRepository();

    const resolved = await resolveGamingMember(repo, "never-seen-auth-user");

    expect(resolved).toBeNull();
  });
});

describe("Gaming Auth — resolveGamingAuth", () => {
  it("returns 'guest' when no Authorization header is present", async () => {
    const repo = new InMemoryGamingRepository();
    const verifier = new FakeAuthUserVerifier({});

    const state = await resolveGamingAuth(repo, verifier, null);

    expect(state.status).toBe("guest");
  });

  it("returns 'invalid_token' for a forged/unrecognized bearer token", async () => {
    const repo = new InMemoryGamingRepository();
    const verifier = new FakeAuthUserVerifier({ "real-token": "auth-7" });

    const state = await resolveGamingAuth(
      repo,
      verifier,
      "Bearer forged-token-not-issued-by-supabase"
    );

    expect(state.status).toBe("invalid_token");
  });

  it("returns 'invalid_token' for a malformed Authorization header (missing Bearer scheme)", async () => {
    const repo = new InMemoryGamingRepository();
    const verifier = new FakeAuthUserVerifier({ "real-token": "auth-7" });

    const state = await resolveGamingAuth(repo, verifier, "real-token");

    expect(state.status).toBe("invalid_token");
  });

  it("returns 'profile_incomplete' for a verified auth user with no Gaming Member yet", async () => {
    const repo = new InMemoryGamingRepository();
    const verifier = new FakeAuthUserVerifier({ "valid-token": "auth-8" });

    const state = await resolveGamingAuth(repo, verifier, "Bearer valid-token");

    expect(state).toEqual({ status: "profile_incomplete", authUserId: "auth-8" });
  });

  it("returns 'authenticated' with the resolved Gaming Member for a returning member", async () => {
    const repo = new InMemoryGamingRepository();
    const created = await createGamingMember(repo, "auth-9", "Morgan");
    const verifier = new FakeAuthUserVerifier({ "valid-token": "auth-9" });

    const state = await resolveGamingAuth(repo, verifier, "Bearer valid-token");

    expect(state).toEqual({ status: "authenticated", gamingMember: created });
  });
});

// The former "Gaming Admin" binary authority (isGamingAdmin/gaming_admins)
// was retired in Predictions A1 — superseded by Admin Control Plane A0's
// platform authority classes (see __tests__/adminAuthority.test.ts and
// __tests__/adminAuthoritySupabaseRepository.contract.test.ts for the
// equivalent fresh-every-call, immediate-revocation coverage).

describe("Participant linkage — JOIN_SESSION with a Gaming Member", () => {
  it("Guest join leaves gamingMemberId null — the exact pre-Identity-Foundation path, unchanged", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);

    const result = await joinSession(repo, session.roomCode, "GuestOnly");

    expect(result.gamingMemberId).toBeNull();
  });

  it("an authenticated join links the correct Gaming Member to the new Participant", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);

    const result = await joinSession(
      repo,
      session.roomCode,
      "AuthedAlex",
      "gm-alex"
    );

    expect(result.gamingMemberId).toBe("gm-alex");
    const participants = await repo.getParticipantsForSession(
      session.sessionId
    );
    expect(participants[0].gamingMemberId).toBe("gm-alex");
  });

  it("rejects a second Participant for the same Gaming Member in the same Session", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);

    await joinSession(repo, session.roomCode, "FirstJoin", "gm-dup");

    await expect(
      joinSession(repo, session.roomCode, "SecondJoinDifferentName", "gm-dup")
    ).rejects.toBeInstanceOf(GamingMemberAlreadyInSessionError);
  });

  it("permits the same Gaming Member to join a DIFFERENT Session", async () => {
    const repo = new InMemorySessionRepository();
    const sessionA = await createSession(repo);
    await setSessionCapabilities(repo, sessionA.sessionId, sessionA.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);
    const sessionB = await createSession(repo);
    await setSessionCapabilities(repo, sessionB.sessionId, sessionB.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);

    const resultA = await joinSession(
      repo,
      sessionA.roomCode,
      "SameMember",
      "gm-multi-session"
    );
    const resultB = await joinSession(
      repo,
      sessionB.roomCode,
      "SameMember",
      "gm-multi-session"
    );

    expect(resultA.gamingMemberId).toBe("gm-multi-session");
    expect(resultB.gamingMemberId).toBe("gm-multi-session");
    expect(resultA.sessionId).not.toBe(resultB.sessionId);
  });

  it("Guests and an authenticated member coexist freely in the same Session", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);

    await joinSession(repo, session.roomCode, "GuestOne");
    await joinSession(repo, session.roomCode, "GuestTwo");
    const member = await joinSession(
      repo,
      session.roomCode,
      "AuthedMember",
      "gm-coexist"
    );

    const participants = await repo.getParticipantsForSession(
      session.sessionId
    );
    expect(participants).toHaveLength(3);
    expect(
      participants.filter((p) => p.gamingMemberId === null)
    ).toHaveLength(2);
    expect(member.gamingMemberId).toBe("gm-coexist");
  });

  it("an authenticated member's display name collision with an existing participant uses the existing DisplayNameTakenError — never a silent rename", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);

    await joinSession(repo, session.roomCode, "Taken");

    await expect(
      joinSession(repo, session.roomCode, "taken", "gm-collide")
    ).rejects.toBeInstanceOf(DisplayNameTakenError);
  });

  it("legacy flat Guest call (3-arg, no gamingMemberId) behaves byte-identically to before this phase", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);

    const result = await joinSession(repo, session.roomCode, "LegacyCaller");

    expect(result.gamingMemberId).toBeNull();
    expect(result.displayName).toBe("LegacyCaller");
    expect(result.sessionState).toBe("LOBBY_OPEN");
  });
});

describe("Existing gameplay regression — Gaming Member linkage does not alter gameplay commands", () => {
  it("an authenticated Participant still submits responses using participantId, exactly like a Guest", async () => {
    const repo = new InMemorySessionRepository();
    const session = await createSession(repo);
    await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE", "VOTING", "TRIVIA", "QUIZ"]);
    const member = await joinSession(
      repo,
      session.roomCode,
      "PlaysNormally",
      "gm-regression"
    );
    const { lockLobby } = await import("../lib/session/lockLobby");
    await lockLobby(repo, session.sessionId, session.hostToken);
    await startSession(repo, session.sessionId, session.hostToken, {
      engineType: "OPEN_RESPONSE",
      promptText: "Regression check?",
    });

    const result = await submitResponse(
      repo,
      session.sessionId,
      member.participantToken,
      "still works"
    );

    expect(result.participantId).toBe(member.participantId);
    expect(result.text).toBe("still works");
  });
});
