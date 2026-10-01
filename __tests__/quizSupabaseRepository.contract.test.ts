import { randomUUID } from "node:crypto";

import { loadEnv } from "vite";
import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";

import { SupabaseSessionRepository } from "../lib/session/db/supabaseSessionRepository";
import type { ParticipantRecord } from "../lib/session/db/sessionRepository";
import {
  type SessionRecord,
  QuizInstanceNotFoundError,
  QuizClosedError,
  QuizExpiryNotReachedError,
} from "../lib/session/types";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";

const env = loadEnv("development", process.cwd(), "");

const supabaseUrl = env.SUPABASE_URL;
requireLocalSupabase(supabaseUrl);
const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error(
    "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for contract tests."
  );
}

/**
 * Quiz Experience — Supabase contract suite.
 *
 * Structurally identical to segmentSupabaseRepository.contract.test.ts
 * (same builders, same cleanup discipline). Exercises exactly what
 * InMemorySessionRepository (__tests__/quiz.test.ts) cannot: the real
 * start_quiz_atomically / submit_quiz_response_atomically /
 * close_quiz_atomically functions against live Postgres, real FK
 * enforcement on quiz_windows, and genuine concurrent-close behavior
 * under real row locking.
 */
const repository = new SupabaseSessionRepository(supabaseUrl, supabaseServiceRoleKey);
const cleanupClient = createClient(supabaseUrl, supabaseServiceRoleKey);
const createdSessionIds: string[] = [];

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
    hostToken: `quiz-contract-host-token-${randomUUID()}`,
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
    payload: { roomCode: record.roomCode },
  };
}

function buildParticipantRecord(
  sessionId: string,
  overrides: Partial<ParticipantRecord> = {}
): ParticipantRecord {
  const displayName = overrides.displayName ?? `QuizContract-${randomUUID().slice(0, 8)}`;
  return {
    participantId: randomUUID(),
    sessionId,
    displayName,
    normalizedDisplayName: displayName.toLowerCase(),
    participantToken: `quiz-contract-participant-token-${randomUUID()}`,
    joinedAt: new Date().toISOString(),
    gamingMemberId: null,
    ...overrides,
  };
}

function buildJoinedEvent(record: ParticipantRecord) {
  return {
    sessionId: record.sessionId,
    eventType: "PARTICIPANT_JOINED" as const,
    payload: { participantId: record.participantId, displayName: record.displayName },
  };
}

async function setupLockedSessionWithQuestions(displayNames: string[] = ["Alex", "Jordan"]) {
  const session = buildSessionRecord();
  createdSessionIds.push(session.sessionId);
  await repository.createSession(session, buildInitialEvent(session));
  await repository.setSessionCapabilities(session.sessionId, session.hostToken, [
    "OPEN_RESPONSE",
    "VOTING",
    "TRIVIA",
    "QUIZ",
  ]);

  const participants: ParticipantRecord[] = [];
  for (const displayName of displayNames) {
    const participant = buildParticipantRecord(session.sessionId, {
      displayName: `${displayName}-${randomUUID().slice(0, 6)}`,
    });
    await repository.joinParticipant(participant, buildJoinedEvent(participant));
    participants.push(participant);
  }

  await repository.lockLobby(session.sessionId, session.hostToken, {
    sessionId: session.sessionId,
    eventType: "LOBBY_LOCKED",
    payload: {},
  });

  await repository.createPreparedQuestions(session.sessionId, [
    { promptText: "Q1?", options: ["A", "B"], correctOptionIndex: 0, pointsForCorrect: 10 },
    { promptText: "Q2?", options: ["A", "B"], correctOptionIndex: 1, pointsForCorrect: 10 },
  ]);

  return { session, participants };
}

afterAll(async () => {
  if (createdSessionIds.length === 0) return;
  const { error: eventsError } = await cleanupClient
    .from("session_events")
    .delete()
    .in("session_id", createdSessionIds);
  if (eventsError) throw eventsError;

  const { error: sessionsError } = await cleanupClient
    .from("sessions")
    .delete()
    .in("session_id", createdSessionIds);
  if (sessionsError) throw sessionsError;
});

describe("SupabaseSessionRepository contract — Quiz migration-created schema", () => {
  it("quiz_windows exists and is reachable through the real client", async () => {
    const { data, error } = await cleanupClient
      .from("quiz_windows")
      .select("segment_id")
      .limit(1);
    expect(error).toBeNull();
    expect(data).toBeDefined();
  });

  it("rejects an orphan quiz_windows row at the database level (FK to segments)", async () => {
    const { error } = await cleanupClient.from("quiz_windows").insert({
      segment_id: randomUUID(),
      closes_at: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(error).not.toBeNull();
  });
});

describe("start_quiz_atomically — live Postgres", () => {
  it("creates one Segment, N Multiple Choice Interaction Instances, and one quiz_windows row, atomically", async () => {
    const { session } = await setupLockedSessionWithQuestions();

    const result = await repository.startQuiz(session.sessionId, session.hostToken, 60);

    expect(result.interactionInstanceIds).toHaveLength(2);

    const segments = await repository.getSegmentsForSession(session.sessionId);
    expect(segments).toHaveLength(1);
    expect(segments[0].segmentId).toBe(result.segmentId);

    const window = await repository.getQuizWindowForSegment(result.segmentId);
    expect(window).not.toBeNull();
    expect(window?.closedAt).toBeNull();

    const instances = await repository.getInteractionInstancesForSession(session.sessionId);
    expect(instances).toHaveLength(2);
    expect(instances.every((i) => i.segmentId === result.segmentId)).toBe(true);
    expect(instances.every((i) => i.engineType === "MULTIPLE_CHOICE")).toBe(true);
    expect(instances.every((i) => i.state === "PROMPT_ACTIVE")).toBe(true);
  });
});

describe("submit_quiz_response_atomically — live Postgres", () => {
  it("accepts a legal submission targeting a specific question, independent of any other Interaction Instance's state", async () => {
    const { session, participants } = await setupLockedSessionWithQuestions();
    const [alex] = participants;
    const started = await repository.startQuiz(session.sessionId, session.hostToken, 60);

    const result = await repository.submitQuizResponse(
      session.sessionId,
      alex.participantId,
      alex.participantToken,
      started.interactionInstanceIds[1],
      1
    );

    expect(result.interactionInstanceId).toBe(started.interactionInstanceIds[1]);

    // Independent targeting proven directly: the participant answered
    // Q2 (index 1) while Q1 (index 0) has zero submissions — nothing
    // about targeting Q2 required Q1 to be touched first.
    const q1Submissions = await repository.getSubmissionsForInteractionInstance(
      started.interactionInstanceIds[0]
    );
    expect(q1Submissions).toHaveLength(0);
  });

  it("rejects a target Interaction Instance belonging to a different session", async () => {
    const { session: sessionA, participants: participantsA } = await setupLockedSessionWithQuestions(["Alex"]);
    const { session: sessionB } = await setupLockedSessionWithQuestions(["Jordan"]);
    const startedB = await repository.startQuiz(sessionB.sessionId, sessionB.hostToken, 60);

    await expect(
      repository.submitQuizResponse(
        sessionA.sessionId,
        participantsA[0].participantId,
        participantsA[0].participantToken,
        startedB.interactionInstanceIds[0],
        0
      )
    ).rejects.toBeInstanceOf(QuizInstanceNotFoundError);
  });

  it("authoritatively rejects a submission once the deadline has passed, independent of client time", async () => {
    const { session, participants } = await setupLockedSessionWithQuestions();
    const [alex] = participants;
    const started = await repository.startQuiz(session.sessionId, session.hostToken, 60);

    // Bypasses the application layer entirely, mirroring this suite's
    // established technique for proving a database-level guarantee
    // rather than application discipline: directly backdate closes_at
    // so it has already passed, without ever calling CLOSE_QUIZ. The
    // Interaction Instance itself is still PROMPT_ACTIVE — proving the
    // rejection below is genuinely deadline-driven, not derived from
    // per-instance state (see submit_quiz_response_atomically's own
    // migration comment).
    const { error: backdateError } = await cleanupClient
      .from("quiz_windows")
      .update({ closes_at: new Date(Date.now() - 1000).toISOString() })
      .eq("segment_id", started.segmentId);
    expect(backdateError).toBeNull();

    await expect(
      repository.submitQuizResponse(
        session.sessionId,
        alex.participantId,
        alex.participantToken,
        started.interactionInstanceIds[0],
        0
      )
    ).rejects.toBeInstanceOf(QuizClosedError);
  });
});

describe("close_quiz_atomically — live Postgres", () => {
  it("manual close scores correct answers and reveals every question together", async () => {
    const { session, participants } = await setupLockedSessionWithQuestions();
    const [alex, jordan] = participants;
    const started = await repository.startQuiz(session.sessionId, session.hostToken, 60);

    // Alex: Q1 correct (0), Q2 unanswered.
    await repository.submitQuizResponse(
      session.sessionId, alex.participantId, alex.participantToken, started.interactionInstanceIds[0], 0
    );
    // Jordan: Q1 wrong (1), Q2 correct (1).
    await repository.submitQuizResponse(
      session.sessionId, jordan.participantId, jordan.participantToken, started.interactionInstanceIds[0], 1
    );
    await repository.submitQuizResponse(
      session.sessionId, jordan.participantId, jordan.participantToken, started.interactionInstanceIds[1], 1
    );

    const result = await repository.closeQuiz(session.sessionId, started.segmentId, session.hostToken);
    expect(result.alreadyClosed).toBe(false);

    const instances = await repository.getInteractionInstancesForSession(session.sessionId);
    expect(instances.every((i) => i.state === "RESULT_REVEAL")).toBe(true);

    const awards = await repository.getPointAwardsForSession(session.sessionId);
    const byParticipant = new Map<string, number>();
    for (const award of awards) {
      byParticipant.set(award.participantId, (byParticipant.get(award.participantId) ?? 0) + award.points);
    }
    expect(byParticipant.get(alex.participantId)).toBe(10);
    expect(byParticipant.get(jordan.participantId)).toBe(10);
  });

  it("is idempotent under genuinely concurrent duplicate close requests", async () => {
    const { session } = await setupLockedSessionWithQuestions();
    const started = await repository.startQuiz(session.sessionId, session.hostToken, 60);

    const attempts = await Promise.allSettled([
      repository.closeQuiz(session.sessionId, started.segmentId, session.hostToken),
      repository.closeQuiz(session.sessionId, started.segmentId, session.hostToken),
    ]);

    const fulfilled = attempts.filter(
      (a): a is PromiseFulfilledResult<Awaited<ReturnType<typeof repository.closeQuiz>>> =>
        a.status === "fulfilled"
    );
    expect(fulfilled).toHaveLength(2);
    const alreadyClosedFlags = fulfilled.map((f) => f.value.alreadyClosed).sort();
    expect(alreadyClosedFlags).toEqual([false, true]);
    expect(fulfilled[0].value.closedAt).toBe(fulfilled[1].value.closedAt);

    const window = await repository.getQuizWindowForSegment(started.segmentId);
    expect(window?.closedAt).not.toBeNull();
  });

  it("rejects a participant closing before the deadline has passed", async () => {
    const { session, participants } = await setupLockedSessionWithQuestions();
    const [alex] = participants;
    const started = await repository.startQuiz(session.sessionId, session.hostToken, 3600);

    await expect(
      repository.closeQuiz(session.sessionId, started.segmentId, alex.participantToken)
    ).rejects.toBeInstanceOf(QuizExpiryNotReachedError);
  });
});
