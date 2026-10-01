import { randomUUID } from "node:crypto";

import { loadEnv } from "vite";
import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";

import { SupabaseSessionRepository } from "../lib/session/db/supabaseSessionRepository";
import type { ParticipantRecord } from "../lib/session/db/sessionRepository";
import {
  RoomCodeCollisionError,
  PredecessorAlreadyHasSuccessorError,
  InvalidCapabilityKeyError,
  CapabilitiesLockedError,
  SessionCapabilitiesNotDeclaredError,
  CapabilityNotAuthorizedError,
  type SessionRecord,
} from "../lib/session/types";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";
const env = loadEnv("development", process.cwd(), "");

const supabaseUrl = env.SUPABASE_URL;
requireLocalSupabase(supabaseUrl);
const supabaseServiceRoleKey =
  env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error(
    "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for contract tests."
  );
}


const repository = new SupabaseSessionRepository(
  supabaseUrl,
  supabaseServiceRoleKey
);

const cleanupClient = createClient(
  supabaseUrl,
  supabaseServiceRoleKey
);

const createdSessionIds: string[] = [];

function generateRoomCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

  return Array.from({ length: 6 }, () => {
    const index = Math.floor(Math.random() * alphabet.length);
    return alphabet[index];
  }).join("");
}

function buildSessionRecord(
  overrides: Partial<SessionRecord> = {}
): SessionRecord {
  const now = new Date().toISOString();

  return {
    sessionId: randomUUID(),
    roomCode: generateRoomCode(),
    hostToken: `contract-host-token-${randomUUID()}`,
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

function buildInitialEvent(record: SessionRecord) {
  return {
    sessionId: record.sessionId,
    eventType: "SESSION_CREATED",
    payload: {
      roomCode: record.roomCode,
    },
  };
}

function buildParticipantRecord(
  sessionId: string,
  overrides: Partial<ParticipantRecord> = {}
): ParticipantRecord {
  const displayName = overrides.displayName ?? `Contract-${randomUUID().slice(0, 8)}`;

  return {
    participantId: randomUUID(),
    sessionId,
    displayName,
    normalizedDisplayName: displayName.toLowerCase(),
    participantToken: `contract-participant-token-${randomUUID()}`,
    joinedAt: new Date().toISOString(),
    gamingMemberId: null,
    ...overrides,
  };
}

function buildJoinedEvent(record: ParticipantRecord) {
  return {
    sessionId: record.sessionId,
    eventType: "PARTICIPANT_JOINED" as const,
    payload: {
      participantId: record.participantId,
      displayName: record.displayName,
    },
  };
}

afterAll(async () => {
  if (createdSessionIds.length === 0) {
    return;
  }

  const { error: eventsCleanupError } = await cleanupClient
    .from("session_events")
    .delete()
    .in("session_id", createdSessionIds);

  if (eventsCleanupError) {
    throw eventsCleanupError;
  }

  const { error: sessionsCleanupError } = await cleanupClient
    .from("sessions")
    .delete()
    .in("session_id", createdSessionIds);

  if (sessionsCleanupError) {
    throw sessionsCleanupError;
  }
});

describe("SupabaseSessionRepository contract", () => {
  it("translates an active room-code unique violation into RoomCodeCollisionError", async () => {
    const first = buildSessionRecord();
    createdSessionIds.push(first.sessionId);

    await repository.createSession(
      first,
      buildInitialEvent(first)
    );

    const duplicateRoomCode = buildSessionRecord({
      roomCode: first.roomCode,
    });

    await expect(
      repository.createSession(
        duplicateRoomCode,
        buildInitialEvent(duplicateRoomCode)
      )
    ).rejects.toBeInstanceOf(RoomCodeCollisionError);

    const failedSession = await repository.getSessionById(
      duplicateRoomCode.sessionId
    );

    expect(failedSession).toBeNull();
  });

  it("does not translate a host-token unique violation into RoomCodeCollisionError", async () => {
    const first = buildSessionRecord();
    createdSessionIds.push(first.sessionId);

    await repository.createSession(
      first,
      buildInitialEvent(first)
    );

    const duplicateHostToken = buildSessionRecord({
      hostToken: first.hostToken,
    });

    try {
      await repository.createSession(
        duplicateHostToken,
        buildInitialEvent(duplicateHostToken)
      );

      throw new Error(
        "Expected duplicate host token persistence to fail."
      );
    } catch (error: unknown) {
      expect(error).not.toBeInstanceOf(
        RoomCodeCollisionError
      );

      expect(error).toMatchObject({
        code: "23505",
      });
    }

    const failedSession = await repository.getSessionById(
      duplicateHostToken.sessionId
    );

    expect(failedSession).toBeNull();
  });
});

/**
 * These tests exist to prove each atomic Postgres function actually
 * executes and returns the expected shape against a real, live
 * database — not to re-cover the exhaustive edge cases and error paths
 * already exercised by the in-memory repository's 121 behavioral
 * tests. One coherent, realistic sequence per concern, not a matrix.
 *
 * Motivation: a live human playtest found two real bugs (ambiguous
 * column references between RETURNS TABLE output parameters and
 * identically-named source columns) in lockLobby/startSession/
 * completeSession/closeSubmissions/revealResults and submitResponse —
 * bugs that passing in-memory tests could never have caught, since SQL
 * identifier resolution doesn't exist in a plain JS test double. This
 * suite exists specifically to catch that class of bug automatically,
 * going forward, rather than depending on a human to manually click
 * through the full loop again.
 *
 * Slice 001 (Session / Interaction separation): startSession,
 * submitResponse, closeSubmissions, and revealResults now resolve and
 * mutate the session's *current interaction instance*, not the
 * session's own state/state_version — the session stays LOBBY_LOCKED
 * (state_version 2, set by LOCK_LOBBY) through every interaction it
 * runs, only moving again at COMPLETE_SESSION.
 */
describe("SupabaseSessionRepository contract — full lifecycle against live Postgres", () => {
  it("exercises every remaining atomic function through one complete, realistic session lifecycle, including a second sequential interaction", async () => {
    // This test performs roughly a dozen sequential live round trips to
    // Supabase, which occasionally exceeds vitest's default 5000ms
    // per-test timeout depending on network conditions — a pre-existing
    // property of this test's shape (unrelated to any Slice 002 change),
    // surfaced while running the full contract suite live for Slice 002.
    // Extending the timeout rather than restructuring the test, since
    // the sequential round trips are the point: proving the full
    // Slice 001 lifecycle actually works end to end against real
    // Postgres, not a synthetic shortcut.
    // CREATE_SESSION
    const session = buildSessionRecord();
    createdSessionIds.push(session.sessionId);
    await repository.createSession(session, buildInitialEvent(session));
    await repository.setSessionCapabilities(session.sessionId, session.hostToken, [
      "OPEN_RESPONSE",
      "VOTING",
      "TRIVIA",
      "QUIZ",
    ]);

    // JOIN_SESSION
    const participant = buildParticipantRecord(session.sessionId);
    await repository.joinParticipant(participant, buildJoinedEvent(participant));

    const resolvedByRoomCode = await repository.getActiveSessionByRoomCode(session.roomCode);
    expect(resolvedByRoomCode?.sessionId).toBe(session.sessionId);

    const participants = await repository.getParticipantsForSession(session.sessionId);
    expect(participants).toHaveLength(1);
    expect(participants[0].participantId).toBe(participant.participantId);

    // LOCK_LOBBY
    const lockResult = await repository.lockLobby(session.sessionId, session.hostToken, {
      sessionId: session.sessionId,
      eventType: "LOBBY_LOCKED",
      payload: {},
    });
    expect(lockResult).toEqual({ state: "LOBBY_LOCKED", stateVersion: 2 });

    // START_SESSION — first interaction
    const firstStart = await repository.startSession(
      session.sessionId,
      session.hostToken,
      { engineType: "OPEN_RESPONSE", promptText: "Initial contract-test prompt" }
    );
    expect(firstStart.state).toBe("PROMPT_ACTIVE");
    expect(firstStart.interactionInstanceId).toBeTruthy();
    expect(firstStart.promptId).toBeTruthy();

    // GET_SESSION's prompt hydration path
    const prompt = await repository.getPromptById(firstStart.promptId);
    expect(prompt).not.toBeNull();
    expect(prompt?.promptId).toBe(firstStart.promptId);
    expect(prompt?.text).toBe("Initial contract-test prompt");

    // Session's own state/state_version are untouched by START_SESSION.
    const afterFirstStart = await repository.getSessionById(session.sessionId);
    expect(afterFirstStart?.state).toBe("LOBBY_LOCKED");
    expect(afterFirstStart?.stateVersion).toBe(2);

    // SUBMIT_RESPONSE — initial submission
    const firstSubmit = await repository.submitResponse(
      session.sessionId,
      participant.participantId,
      participant.participantToken,
      "Initial contract-test response"
    );
    expect(firstSubmit.submissionId).toBeTruthy();
    expect(firstSubmit.interactionInstanceId).toBe(firstStart.interactionInstanceId);
    expect(firstSubmit.promptId).toBe(firstStart.promptId);

    // SUBMIT_RESPONSE — revision, proving the live ON CONFLICT upsert
    // ("last write wins") actually works against real Postgres, not
    // just in the in-memory double's plain Map overwrite.
    const secondSubmit = await repository.submitResponse(
      session.sessionId,
      participant.participantId,
      participant.participantToken,
      "Revised contract-test response"
    );
    expect(secondSubmit.submissionId).toBe(firstSubmit.submissionId);

    const firstInteractionSubmissions =
      await repository.getSubmissionsForInteractionInstance(
        firstStart.interactionInstanceId
      );
    expect(firstInteractionSubmissions).toHaveLength(1);
    expect(firstInteractionSubmissions[0].text).toBe("Revised contract-test response");

    // CLOSE_SUBMISSIONS
    const closeResult = await repository.closeSubmissions(session.sessionId, session.hostToken, {
      sessionId: session.sessionId,
      eventType: "SUBMISSIONS_CLOSED",
      payload: {},
    });
    expect(closeResult).toEqual({
      interactionInstanceId: firstStart.interactionInstanceId,
      state: "SUBMISSIONS_CLOSED",
    });

    // REVEAL_RESULTS
    const revealResult = await repository.revealResults(session.sessionId, session.hostToken, {
      sessionId: session.sessionId,
      eventType: "RESULTS_REVEALED",
      payload: {},
    });
    expect(revealResult).toEqual({
      interactionInstanceId: firstStart.interactionInstanceId,
      state: "RESULT_REVEAL",
    });

    // START_SESSION — second interaction, proving the re-invocable
    // Slice 001 capability against real Postgres: re-invoking START_SESSION
    // is only legal once the previous interaction instance is RESULT_REVEAL,
    // and the row-locked re-check inside start_session_atomically must
    // authoritatively confirm that, not just this test's own lookups.
    const secondStart = await repository.startSession(
      session.sessionId,
      session.hostToken,
      { engineType: "OPEN_RESPONSE", promptText: "Second contract-test prompt" }
    );
    expect(secondStart.state).toBe("PROMPT_ACTIVE");
    expect(secondStart.interactionInstanceId).not.toBe(firstStart.interactionInstanceId);
    expect(secondStart.promptId).not.toBe(firstStart.promptId);

    const instances = await repository.getInteractionInstancesForSession(session.sessionId);
    expect(instances).toHaveLength(2);
    expect(instances[0].interactionInstanceId).toBe(firstStart.interactionInstanceId);
    expect(instances[0].state).toBe("RESULT_REVEAL");
    expect(instances[1].interactionInstanceId).toBe(secondStart.interactionInstanceId);
    expect(instances[1].state).toBe("PROMPT_ACTIVE");

    // The first interaction's submissions must not bleed into the second.
    const secondInteractionSubmissionsBeforeSubmit =
      await repository.getSubmissionsForInteractionInstance(
        secondStart.interactionInstanceId
      );
    expect(secondInteractionSubmissionsBeforeSubmit).toHaveLength(0);

    await repository.submitResponse(
      session.sessionId,
      participant.participantId,
      participant.participantToken,
      "Second interaction response"
    );
    await repository.closeSubmissions(session.sessionId, session.hostToken, {
      sessionId: session.sessionId,
      eventType: "SUBMISSIONS_CLOSED",
      payload: {},
    });
    const secondReveal = await repository.revealResults(session.sessionId, session.hostToken, {
      sessionId: session.sessionId,
      eventType: "RESULTS_REVEALED",
      payload: {},
    });
    expect(secondReveal.interactionInstanceId).toBe(secondStart.interactionInstanceId);
    expect(secondReveal.state).toBe("RESULT_REVEAL");

    // Session's own state/state_version remain untouched by any of the
    // interaction-level activity above.
    const beforeComplete = await repository.getSessionById(session.sessionId);
    expect(beforeComplete?.state).toBe("LOBBY_LOCKED");
    expect(beforeComplete?.stateVersion).toBe(2);

    // COMPLETE_SESSION
    const completeResult = await repository.completeSession(session.sessionId, session.hostToken, {
      sessionId: session.sessionId,
      eventType: "SESSION_COMPLETED",
      payload: {},
    });
    expect(completeResult).toEqual({ state: "SESSION_COMPLETE", stateVersion: 3 });

    // Room-code reuse mechanism, proven live: a completed session's
    // room code is no longer resolvable as active.
    const resolvedAfterComplete = await repository.getActiveSessionByRoomCode(session.roomCode);
    expect(resolvedAfterComplete).toBeNull();
  }, 20000);
});

/**
 * Slice 002 (Scored Multi-Round Experience). award_points_atomically
 * has two behaviors that specifically cannot be proven by the
 * in-memory double, which is single-threaded and cannot race two
 * requests against each other: (1) idempotent replay after the
 * session has genuinely progressed, verified here against a second,
 * real interaction instance and a real COMPLETE_SESSION transition,
 * not a simulated one; (2) two concurrent requests carrying the same
 * (session_id, idempotency_key) racing against Postgres's actual
 * unique constraint and ON CONFLICT handling, which only exists once
 * this runs against a real database with real transaction isolation.
 */
describe("SupabaseSessionRepository contract — AWARD_POINTS against live Postgres", () => {
  it("awards points, replays idempotently after the session progresses and completes, and never creates a second row", async () => {
    const session = buildSessionRecord();
    createdSessionIds.push(session.sessionId);
    await repository.createSession(session, buildInitialEvent(session));
    await repository.setSessionCapabilities(session.sessionId, session.hostToken, [
      "OPEN_RESPONSE",
      "VOTING",
      "TRIVIA",
      "QUIZ",
    ]);

    const participant = buildParticipantRecord(session.sessionId);
    await repository.joinParticipant(participant, buildJoinedEvent(participant));

    await repository.lockLobby(session.sessionId, session.hostToken, {
      sessionId: session.sessionId,
      eventType: "LOBBY_LOCKED",
      payload: {},
    });

    const firstInteraction = await repository.startSession(
      session.sessionId,
      session.hostToken,
      { engineType: "OPEN_RESPONSE", promptText: "Award-points contract prompt" }
    );
    await repository.closeSubmissions(session.sessionId, session.hostToken, {
      sessionId: session.sessionId,
      eventType: "SUBMISSIONS_CLOSED",
      payload: {},
    });
    await repository.revealResults(session.sessionId, session.hostToken, {
      sessionId: session.sessionId,
      eventType: "RESULTS_REVEALED",
      payload: {},
    });

    const idempotencyKey = randomUUID();
    const firstAward = await repository.awardPoints(
      session.sessionId,
      session.hostToken,
      firstInteraction.interactionInstanceId,
      participant.participantId,
      10,
      idempotencyKey
    );
    expect(firstAward.points).toBe(10);
    expect(firstAward.interactionInstanceId).toBe(firstInteraction.interactionInstanceId);

    // Progress the session to a second interaction — the original
    // interaction is no longer current.
    const secondInteraction = await repository.startSession(
      session.sessionId,
      session.hostToken,
      { engineType: "OPEN_RESPONSE", promptText: "Second award-points contract prompt" }
    );

    // Replay: identical (sessionId, idempotencyKey), every other
    // argument deliberately wrong. Must return the original award
    // unchanged rather than erroring or re-validating.
    const replayDuringSecondInteraction = await repository.awardPoints(
      session.sessionId,
      session.hostToken,
      secondInteraction.interactionInstanceId,
      participant.participantId,
      999,
      idempotencyKey
    );
    expect(replayDuringSecondInteraction).toEqual(firstAward);

    await repository.closeSubmissions(session.sessionId, session.hostToken, {
      sessionId: session.sessionId,
      eventType: "SUBMISSIONS_CLOSED",
      payload: {},
    });
    await repository.revealResults(session.sessionId, session.hostToken, {
      sessionId: session.sessionId,
      eventType: "RESULTS_REVEALED",
      payload: {},
    });
    await repository.completeSession(session.sessionId, session.hostToken, {
      sessionId: session.sessionId,
      eventType: "SESSION_COMPLETED",
      payload: {},
    });

    // Replay again, now after SESSION_COMPLETE — still returns the
    // original award unchanged.
    const replayAfterCompletion = await repository.awardPoints(
      session.sessionId,
      "wrong-host-token",
      "11111111-1111-1111-1111-111111111111",
      participant.participantId,
      -50,
      idempotencyKey
    );
    expect(replayAfterCompletion).toEqual(firstAward);

    const allAwards = await repository.getPointAwardsForSession(session.sessionId);
    expect(allAwards).toHaveLength(1);
  });

  it("two concurrent requests with the same idempotency key produce exactly one row and both return the same result", async () => {
    const session = buildSessionRecord();
    createdSessionIds.push(session.sessionId);
    await repository.createSession(session, buildInitialEvent(session));
    await repository.setSessionCapabilities(session.sessionId, session.hostToken, [
      "OPEN_RESPONSE",
      "VOTING",
      "TRIVIA",
      "QUIZ",
    ]);

    const participant = buildParticipantRecord(session.sessionId);
    await repository.joinParticipant(participant, buildJoinedEvent(participant));

    await repository.lockLobby(session.sessionId, session.hostToken, {
      sessionId: session.sessionId,
      eventType: "LOBBY_LOCKED",
      payload: {},
    });

    const interaction = await repository.startSession(
      session.sessionId,
      session.hostToken,
      { engineType: "OPEN_RESPONSE", promptText: "Concurrent award-points contract prompt" }
    );
    await repository.closeSubmissions(session.sessionId, session.hostToken, {
      sessionId: session.sessionId,
      eventType: "SUBMISSIONS_CLOSED",
      payload: {},
    });
    await repository.revealResults(session.sessionId, session.hostToken, {
      sessionId: session.sessionId,
      eventType: "RESULTS_REVEALED",
      payload: {},
    });

    const idempotencyKey = randomUUID();
    const [first, second] = await Promise.all([
      repository.awardPoints(
        session.sessionId,
        session.hostToken,
        interaction.interactionInstanceId,
        participant.participantId,
        15,
        idempotencyKey
      ),
      repository.awardPoints(
        session.sessionId,
        session.hostToken,
        interaction.interactionInstanceId,
        participant.participantId,
        15,
        idempotencyKey
      ),
    ]);

    expect(first).toEqual(second);

    const allAwards = await repository.getPointAwardsForSession(session.sessionId);
    expect(allAwards).toHaveLength(1);
  });

  it("allows multiple independent awards for the same participant and interaction, and derives the correct sum", async () => {
    const session = buildSessionRecord();
    createdSessionIds.push(session.sessionId);
    await repository.createSession(session, buildInitialEvent(session));
    await repository.setSessionCapabilities(session.sessionId, session.hostToken, [
      "OPEN_RESPONSE",
      "VOTING",
      "TRIVIA",
      "QUIZ",
    ]);

    const participant = buildParticipantRecord(session.sessionId);
    await repository.joinParticipant(participant, buildJoinedEvent(participant));

    await repository.lockLobby(session.sessionId, session.hostToken, {
      sessionId: session.sessionId,
      eventType: "LOBBY_LOCKED",
      payload: {},
    });

    const interaction = await repository.startSession(
      session.sessionId,
      session.hostToken,
      { engineType: "OPEN_RESPONSE", promptText: "Multiple-awards contract prompt" }
    );
    await repository.closeSubmissions(session.sessionId, session.hostToken, {
      sessionId: session.sessionId,
      eventType: "SUBMISSIONS_CLOSED",
      payload: {},
    });
    await repository.revealResults(session.sessionId, session.hostToken, {
      sessionId: session.sessionId,
      eventType: "RESULTS_REVEALED",
      payload: {},
    });

    await repository.awardPoints(
      session.sessionId,
      session.hostToken,
      interaction.interactionInstanceId,
      participant.participantId,
      10,
      randomUUID()
    );
    await repository.awardPoints(
      session.sessionId,
      session.hostToken,
      interaction.interactionInstanceId,
      participant.participantId,
      7,
      randomUUID()
    );

    const allAwards = await repository.getPointAwardsForSession(session.sessionId);
    expect(allAwards).toHaveLength(2);
    expect(allAwards.reduce((sum, a) => sum + a.points, 0)).toBe(17);
  });
});

/**
 * Slice 003 (Second Interaction Engine). reveal_results_atomically now
 * evaluates and scores Multiple Choice submissions inside the exact
 * same transaction as the RESULT_REVEAL state transition (see 0027).
 * The property that specifically cannot be proven by the single-
 * threaded in-memory double is that this is genuinely one atomic unit
 * against a real database — a concurrent reveal race and the
 * deterministic md5-derived idempotency key both only mean something
 * against Postgres's actual transaction and uniqueness guarantees.
 */
describe("SupabaseSessionRepository contract — Multiple Choice atomic reveal+evaluate against live Postgres", () => {
  it("scores correct participants automatically as part of REVEAL_RESULTS, in the same call", async () => {
    const session = buildSessionRecord();
    createdSessionIds.push(session.sessionId);
    await repository.createSession(session, buildInitialEvent(session));
    await repository.setSessionCapabilities(session.sessionId, session.hostToken, [
      "OPEN_RESPONSE",
      "VOTING",
      "TRIVIA",
      "QUIZ",
    ]);

    const alex = buildParticipantRecord(session.sessionId, { displayName: "Alex-MC" });
    const jordan = buildParticipantRecord(session.sessionId, { displayName: "Jordan-MC" });
    await repository.joinParticipant(alex, buildJoinedEvent(alex));
    await repository.joinParticipant(jordan, buildJoinedEvent(jordan));

    await repository.lockLobby(session.sessionId, session.hostToken, {
      sessionId: session.sessionId,
      eventType: "LOBBY_LOCKED",
      payload: {},
    });

    const [prepared] = await repository.createPreparedQuestions(session.sessionId, [
      {
        promptText: "Best pizza topping?",
        options: ["Pepperoni", "Mushroom", "Pineapple"],
        correctOptionIndex: 0,
        pointsForCorrect: 25,
      },
    ]);

    const interaction = await repository.startSession(
      session.sessionId,
      session.hostToken,
      { engineType: "MULTIPLE_CHOICE", preparedQuestionId: prepared.preparedQuestionId }
    );
    expect(interaction.engineType).toBe("MULTIPLE_CHOICE");

    await repository.submitResponse(
      session.sessionId,
      alex.participantId,
      alex.participantToken,
      "0"
    );
    await repository.submitResponse(
      session.sessionId,
      jordan.participantId,
      jordan.participantToken,
      "1"
    );

    await repository.closeSubmissions(session.sessionId, session.hostToken, {
      sessionId: session.sessionId,
      eventType: "SUBMISSIONS_CLOSED",
      payload: {},
    });

    await repository.revealResults(session.sessionId, session.hostToken, {
      sessionId: session.sessionId,
      eventType: "RESULTS_REVEALED",
      payload: {},
    });

    const awards = await repository.getPointAwardsForSession(session.sessionId);
    const alexAward = awards.find((a) => a.participantId === alex.participantId);
    const jordanAward = awards.find((a) => a.participantId === jordan.participantId);

    expect(alexAward?.points).toBe(25);
    expect(jordanAward).toBeUndefined();
  });

  it("does not double-award if REVEAL_RESULTS were somehow invoked twice for the same already-revealed interaction", async () => {
    const session = buildSessionRecord();
    createdSessionIds.push(session.sessionId);
    await repository.createSession(session, buildInitialEvent(session));
    await repository.setSessionCapabilities(session.sessionId, session.hostToken, [
      "OPEN_RESPONSE",
      "VOTING",
      "TRIVIA",
      "QUIZ",
    ]);

    const alex = buildParticipantRecord(session.sessionId, { displayName: "Alex-MC-retry" });
    await repository.joinParticipant(alex, buildJoinedEvent(alex));

    await repository.lockLobby(session.sessionId, session.hostToken, {
      sessionId: session.sessionId,
      eventType: "LOBBY_LOCKED",
      payload: {},
    });

    const [prepared] = await repository.createPreparedQuestions(session.sessionId, [
      {
        promptText: "Cats or dogs?",
        options: ["Cats", "Dogs"],
        correctOptionIndex: 1,
        pointsForCorrect: 15,
      },
    ]);

    const interaction = await repository.startSession(
      session.sessionId,
      session.hostToken,
      { engineType: "MULTIPLE_CHOICE", preparedQuestionId: prepared.preparedQuestionId }
    );

    await repository.submitResponse(
      session.sessionId,
      alex.participantId,
      alex.participantToken,
      "1"
    );

    await repository.closeSubmissions(session.sessionId, session.hostToken, {
      sessionId: session.sessionId,
      eventType: "SUBMISSIONS_CLOSED",
      payload: {},
    });

    await repository.revealResults(session.sessionId, session.hostToken, {
      sessionId: session.sessionId,
      eventType: "RESULTS_REVEALED",
      payload: {},
    });

    // A second call is rejected by the SUBMISSIONS_CLOSED precondition
    // (the interaction is already RESULT_REVEAL) — proving reveal
    // itself is not blindly re-runnable — but this also confirms, via
    // getPointAwardsForSession below, that the first call's scoring
    // was not left in some partial state a retry would need to repair.
    await expect(
      repository.revealResults(session.sessionId, session.hostToken, {
        sessionId: session.sessionId,
        eventType: "RESULTS_REVEALED",
        payload: {},
      })
    ).rejects.toThrow();

    const awards = await repository.getPointAwardsForSession(session.sessionId);
    const alexAwards = awards.filter(
      (a) => a.interactionInstanceId === interaction.interactionInstanceId
    );
    expect(alexAwards).toHaveLength(1);
    expect(alexAwards[0].points).toBe(15);
  });

  it("leaves point_awards empty when no participant answers correctly", async () => {
    const session = buildSessionRecord();
    createdSessionIds.push(session.sessionId);
    await repository.createSession(session, buildInitialEvent(session));
    await repository.setSessionCapabilities(session.sessionId, session.hostToken, [
      "OPEN_RESPONSE",
      "VOTING",
      "TRIVIA",
      "QUIZ",
    ]);

    const alex = buildParticipantRecord(session.sessionId, { displayName: "Alex-MC-wrong" });
    await repository.joinParticipant(alex, buildJoinedEvent(alex));

    await repository.lockLobby(session.sessionId, session.hostToken, {
      sessionId: session.sessionId,
      eventType: "LOBBY_LOCKED",
      payload: {},
    });

    const [prepared] = await repository.createPreparedQuestions(session.sessionId, [
      {
        promptText: "Capital of France?",
        options: ["London", "Berlin", "Paris"],
        correctOptionIndex: 2,
        pointsForCorrect: 10,
      },
    ]);

    await repository.startSession(
      session.sessionId,
      session.hostToken,
      { engineType: "MULTIPLE_CHOICE", preparedQuestionId: prepared.preparedQuestionId }
    );

    await repository.submitResponse(
      session.sessionId,
      alex.participantId,
      alex.participantToken,
      "0"
    );

    await repository.closeSubmissions(session.sessionId, session.hostToken, {
      sessionId: session.sessionId,
      eventType: "SUBMISSIONS_CLOSED",
      payload: {},
    });

    await repository.revealResults(session.sessionId, session.hostToken, {
      sessionId: session.sessionId,
      eventType: "RESULTS_REVEALED",
      payload: {},
    });

    const awards = await repository.getPointAwardsForSession(session.sessionId);
    expect(awards).toHaveLength(0);
  });

  it("does not score an Open Response interaction — automatic evaluation is Multiple-Choice-only", async () => {
    const session = buildSessionRecord();
    createdSessionIds.push(session.sessionId);
    await repository.createSession(session, buildInitialEvent(session));
    await repository.setSessionCapabilities(session.sessionId, session.hostToken, [
      "OPEN_RESPONSE",
      "VOTING",
      "TRIVIA",
      "QUIZ",
    ]);

    const alex = buildParticipantRecord(session.sessionId, { displayName: "Alex-OR-untouched" });
    await repository.joinParticipant(alex, buildJoinedEvent(alex));

    await repository.lockLobby(session.sessionId, session.hostToken, {
      sessionId: session.sessionId,
      eventType: "LOBBY_LOCKED",
      payload: {},
    });

    await repository.startSession(
      session.sessionId,
      session.hostToken,
      { engineType: "OPEN_RESPONSE", promptText: "An ordinary Open Response prompt" }
    );

    await repository.submitResponse(
      session.sessionId,
      alex.participantId,
      alex.participantToken,
      "A free-text answer"
    );

    await repository.closeSubmissions(session.sessionId, session.hostToken, {
      sessionId: session.sessionId,
      eventType: "SUBMISSIONS_CLOSED",
      payload: {},
    });

    await repository.revealResults(session.sessionId, session.hostToken, {
      sessionId: session.sessionId,
      eventType: "RESULTS_REVEALED",
      payload: {},
    });

    const awards = await repository.getPointAwardsForSession(session.sessionId);
    expect(awards).toHaveLength(0);
  });
});

/**
 * Session Continuity slice. These tests exist for the same reason the
 * lifecycle suite above does: prove the extended create_session_atomically
 * (0029) and the new schema constraints (0028) actually behave as
 * intended against real Postgres, since none of that is exercisable by
 * the in-memory double. createSuccessorSession.test.ts already covers
 * the domain-layer decision logic exhaustively — this suite only
 * covers what only Postgres itself can prove: constraint enforcement
 * and the new RPC parameter actually persisting.
 */
describe("SupabaseSessionRepository contract — Session Continuity (predecessor_session_id)", () => {
  it("persists predecessor_session_id via the extended create_session_atomically", async () => {
    const predecessor = buildSessionRecord();
    createdSessionIds.push(predecessor.sessionId);
    await repository.createSession(predecessor, buildInitialEvent(predecessor));

    const successor = buildSessionRecord({
      predecessorSessionId: predecessor.sessionId,
    });
    createdSessionIds.push(successor.sessionId);
    await repository.createSession(successor, buildInitialEvent(successor));

    const stored = await repository.getSessionById(successor.sessionId);
    expect(stored?.predecessorSessionId).toBe(predecessor.sessionId);
  });

  it("resolves the successor via getSuccessorSessionByPredecessorId", async () => {
    const predecessor = buildSessionRecord();
    createdSessionIds.push(predecessor.sessionId);
    await repository.createSession(predecessor, buildInitialEvent(predecessor));

    const successor = buildSessionRecord({
      predecessorSessionId: predecessor.sessionId,
    });
    createdSessionIds.push(successor.sessionId);
    await repository.createSession(successor, buildInitialEvent(successor));

    const resolved = await repository.getSuccessorSessionByPredecessorId(
      predecessor.sessionId
    );
    expect(resolved?.sessionId).toBe(successor.sessionId);
  });

  it("returns null from getSuccessorSessionByPredecessorId when no successor exists", async () => {
    const predecessor = buildSessionRecord();
    createdSessionIds.push(predecessor.sessionId);
    await repository.createSession(predecessor, buildInitialEvent(predecessor));

    const resolved = await repository.getSuccessorSessionByPredecessorId(
      predecessor.sessionId
    );
    expect(resolved).toBeNull();
  });

  it("does not collide two independent sessions that both have a null predecessor_session_id", async () => {
    const first = buildSessionRecord();
    createdSessionIds.push(first.sessionId);
    const second = buildSessionRecord();
    createdSessionIds.push(second.sessionId);

    await expect(
      Promise.all([
        repository.createSession(first, buildInitialEvent(first)),
        repository.createSession(second, buildInitialEvent(second)),
      ])
    ).resolves.not.toThrow();
  });

  it("translates a predecessor_session_id unique violation into PredecessorAlreadyHasSuccessorError", async () => {
    const predecessor = buildSessionRecord();
    createdSessionIds.push(predecessor.sessionId);
    await repository.createSession(predecessor, buildInitialEvent(predecessor));

    const firstSuccessor = buildSessionRecord({
      predecessorSessionId: predecessor.sessionId,
    });
    createdSessionIds.push(firstSuccessor.sessionId);
    await repository.createSession(firstSuccessor, buildInitialEvent(firstSuccessor));

    const secondSuccessor = buildSessionRecord({
      predecessorSessionId: predecessor.sessionId,
    });
    createdSessionIds.push(secondSuccessor.sessionId);

    await expect(
      repository.createSession(secondSuccessor, buildInitialEvent(secondSuccessor))
    ).rejects.toBeInstanceOf(PredecessorAlreadyHasSuccessorError);

    const failedSession = await repository.getSessionById(secondSuccessor.sessionId);
    expect(failedSession).toBeNull();
  });

  it("rejects a session naming itself as its own predecessor (sessions_predecessor_not_self)", async () => {
    const selfReferencing = buildSessionRecord();
    selfReferencing.predecessorSessionId = selfReferencing.sessionId;

    await expect(
      repository.createSession(selfReferencing, buildInitialEvent(selfReferencing))
    ).rejects.toMatchObject({ code: "23514" });

    const stored = await repository.getSessionById(selfReferencing.sessionId);
    expect(stored).toBeNull();
  });
});

describe("SupabaseSessionRepository contract — Session Capability Architecture v1 against live Postgres", () => {
  it("persistence round-trip: create_session_atomically assigns an empty declared set, set_session_capabilities_atomically writes and reads back a real declared set", async () => {
    const session = buildSessionRecord();
    createdSessionIds.push(session.sessionId);
    await repository.createSession(session, buildInitialEvent(session));

    const fresh = await repository.getSessionById(session.sessionId);
    expect(fresh?.declaredCapabilities).toEqual([]);

    const result = await repository.setSessionCapabilities(session.sessionId, session.hostToken, [
      "QUIZ",
      "VOTING",
    ]);
    expect(result.declaredCapabilities).toEqual(["QUIZ", "VOTING"]);
    expect(result.locked).toBe(false);

    const reread = await repository.getSessionById(session.sessionId);
    expect(reread?.declaredCapabilities).toEqual(["QUIZ", "VOTING"]);
  });

  it("rejects an invalid capability key with a real database round-trip, not merely a client-side guess", async () => {
    const session = buildSessionRecord();
    createdSessionIds.push(session.sessionId);
    await repository.createSession(session, buildInitialEvent(session));

    await expect(
      repository.setSessionCapabilities(session.sessionId, session.hostToken, ["MULTIPLE_CHOICE"])
    ).rejects.toBeInstanceOf(InvalidCapabilityKeyError);
  });

  it("legacy NULL distinction: a row with declared_capabilities left NULL (simulating a pre-migration session) is read back as null, not an empty array", async () => {
    const session = buildSessionRecord();
    createdSessionIds.push(session.sessionId);
    await repository.createSession(session, buildInitialEvent(session));

    // Directly force the column back to NULL — the only way a real
    // LEGACY_UNDECLARED row can exist is one that predates this
    // migration; there is no legitimate write path that produces NULL
    // for a session created after it.
    const { error } = await cleanupClient
      .from("sessions")
      .update({ declared_capabilities: null })
      .eq("session_id", session.sessionId);
    expect(error).toBeNull();

    const reread = await repository.getSessionById(session.sessionId);
    expect(reread?.declaredCapabilities).toBeNull();
  });

  it("atomic first-join lock: join_participant_atomically rejects a session with no declared capabilities, succeeds once declared, and locks the set from that moment on", async () => {
    const session = buildSessionRecord();
    createdSessionIds.push(session.sessionId);
    await repository.createSession(session, buildInitialEvent(session));

    const early = buildParticipantRecord(session.sessionId);
    await expect(
      repository.joinParticipant(early, buildJoinedEvent(early))
    ).rejects.toBeInstanceOf(SessionCapabilitiesNotDeclaredError);

    await repository.setSessionCapabilities(session.sessionId, session.hostToken, ["QUIZ"]);

    const alex = buildParticipantRecord(session.sessionId, { displayName: "CapabilityLockAlex" });
    await repository.joinParticipant(alex, buildJoinedEvent(alex));

    await expect(
      repository.setSessionCapabilities(session.sessionId, session.hostToken, ["VOTING"])
    ).rejects.toBeInstanceOf(CapabilitiesLockedError);

    const reread = await repository.getSessionById(session.sessionId);
    expect(reread?.declaredCapabilities).toEqual(["QUIZ"]);
  });

  it("genuine concurrent race — JOIN_SESSION vs SET_SESSION_CAPABILITIES for the same session, fired truly concurrently — resolves to exactly one internally-consistent outcome, never a corrupted or contradictory final state", async () => {
    const session = buildSessionRecord();
    createdSessionIds.push(session.sessionId);
    await repository.createSession(session, buildInitialEvent(session));
    await repository.setSessionCapabilities(session.sessionId, session.hostToken, ["QUIZ"]);

    const participant = buildParticipantRecord(session.sessionId, { displayName: "RaceParticipant" });

    const [joinResult, capabilityResult] = await Promise.allSettled([
      repository.joinParticipant(participant, buildJoinedEvent(participant)),
      repository.setSessionCapabilities(session.sessionId, session.hostToken, ["VOTING"]),
    ]);

    // The join was always against a session with a non-empty declared
    // set (QUIZ initially, or VOTING if the capability update won the
    // race and committed first) — real Postgres row-locking on the
    // same sessions row (both functions take `for update` on it)
    // guarantees the join always sees a fully-committed, consistent
    // state either way, so it must always succeed.
    expect(joinResult.status).toBe("fulfilled");

    const reread = await repository.getSessionById(session.sessionId);

    if (capabilityResult.status === "fulfilled") {
      // The capability update won the race (committed before the
      // join's own lock acquisition) — the final stored value must be
      // exactly what it wrote, and the join proceeded against that
      // already-locked value.
      expect(reread?.declaredCapabilities).toEqual(["VOTING"]);
    } else {
      // The join won the race — the capability update, once it
      // resumed, correctly observed real participant evidence and
      // rejected the change, leaving the original declaration intact.
      expect(capabilityResult.reason).toBeInstanceOf(CapabilitiesLockedError);
      expect(reread?.declaredCapabilities).toEqual(["QUIZ"]);
    }

    const participants = await repository.getParticipantsForSession(session.sessionId);
    expect(participants).toHaveLength(1);
  });

  it("two concurrent pre-lock capability updates serialize cleanly — the final value is exactly one of the two attempted sets, never a corrupted hybrid", async () => {
    const session = buildSessionRecord();
    createdSessionIds.push(session.sessionId);
    await repository.createSession(session, buildInitialEvent(session));

    const [first, second] = await Promise.allSettled([
      repository.setSessionCapabilities(session.sessionId, session.hostToken, ["QUIZ"]),
      repository.setSessionCapabilities(session.sessionId, session.hostToken, ["VOTING", "OPEN_RESPONSE"]),
    ]);

    expect(first.status).toBe("fulfilled");
    expect(second.status).toBe("fulfilled");

    const reread = await repository.getSessionById(session.sessionId);
    const finalValue = reread?.declaredCapabilities ?? [];
    const isFirstSet = finalValue.length === 1 && finalValue[0] === "QUIZ";
    const isSecondSet =
      finalValue.length === 2 && finalValue[0] === "OPEN_RESPONSE" && finalValue[1] === "VOTING";

    expect(isFirstSet || isSecondSet).toBe(true);
  });

  it("QUIZ and TRIVIA are enforced as genuinely separate capabilities against real Postgres: a QUIZ-only session's ad-hoc Trivia attempt is rejected server-side", async () => {
    const session = buildSessionRecord();
    createdSessionIds.push(session.sessionId);
    await repository.createSession(session, buildInitialEvent(session));
    await repository.setSessionCapabilities(session.sessionId, session.hostToken, ["QUIZ"]);

    const alex = buildParticipantRecord(session.sessionId, { displayName: "QuizTriviaAlex" });
    await repository.joinParticipant(alex, buildJoinedEvent(alex));
    await repository.lockLobby(session.sessionId, session.hostToken, {
      sessionId: session.sessionId,
      eventType: "LOBBY_LOCKED",
      payload: {},
    });

    await expect(
      repository.startSession(session.sessionId, session.hostToken, {
        engineType: "OPEN_RESPONSE",
        promptText: "Undeclared capability attempt",
      })
    ).rejects.toBeInstanceOf(CapabilityNotAuthorizedError);

    await repository.createPreparedQuestions(session.sessionId, [
      { promptText: "2+2?", options: ["3", "4"], correctOptionIndex: 1, pointsForCorrect: 10 },
    ]);
    const preparedQuestions = await repository.getPreparedQuestionsForSession(session.sessionId);

    await expect(
      repository.startSession(session.sessionId, session.hostToken, {
        engineType: "MULTIPLE_CHOICE",
        preparedQuestionId: preparedQuestions[0].preparedQuestionId,
      })
    ).rejects.toBeInstanceOf(CapabilityNotAuthorizedError);

    // The declared QUIZ capability itself works cleanly.
    const quizResult = await repository.startQuiz(session.sessionId, session.hostToken, 60);
    expect(quizResult.interactionInstanceIds).toHaveLength(1);
  });

  it("prepared-question authoring against real Postgres: rejected for a VOTING-only session, allowed for TRIVIA-only, allowed for QUIZ-only", async () => {
    const votingOnly = buildSessionRecord();
    createdSessionIds.push(votingOnly.sessionId);
    await repository.createSession(votingOnly, buildInitialEvent(votingOnly));
    await repository.setSessionCapabilities(votingOnly.sessionId, votingOnly.hostToken, ["VOTING"]);

    await expect(
      repository.createPreparedQuestions(votingOnly.sessionId, [
        { promptText: "Bypass?", options: ["A", "B"], correctOptionIndex: 0, pointsForCorrect: 10 },
      ])
    ).rejects.toBeInstanceOf(CapabilityNotAuthorizedError);

    const votingOnlyRows = await repository.getPreparedQuestionsForSession(votingOnly.sessionId);
    expect(votingOnlyRows).toHaveLength(0);

    const triviaOnly = buildSessionRecord();
    createdSessionIds.push(triviaOnly.sessionId);
    await repository.createSession(triviaOnly, buildInitialEvent(triviaOnly));
    await repository.setSessionCapabilities(triviaOnly.sessionId, triviaOnly.hostToken, ["TRIVIA"]);

    const triviaPrepared = await repository.createPreparedQuestions(triviaOnly.sessionId, [
      { promptText: "2+2?", options: ["3", "4"], correctOptionIndex: 1, pointsForCorrect: 10 },
    ]);
    expect(triviaPrepared).toHaveLength(1);

    const quizOnly = buildSessionRecord();
    createdSessionIds.push(quizOnly.sessionId);
    await repository.createSession(quizOnly, buildInitialEvent(quizOnly));
    await repository.setSessionCapabilities(quizOnly.sessionId, quizOnly.hostToken, ["QUIZ"]);

    const quizPrepared = await repository.createPreparedQuestions(quizOnly.sessionId, [
      { promptText: "2+2?", options: ["3", "4"], correctOptionIndex: 1, pointsForCorrect: 10 },
    ]);
    expect(quizPrepared).toHaveLength(1);
  });
});