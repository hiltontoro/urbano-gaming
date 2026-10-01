import { randomUUID } from "node:crypto";

import { loadEnv } from "vite";
import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";

import { SupabaseSessionRepository } from "../lib/session/db/supabaseSessionRepository";
import type { ParticipantRecord } from "../lib/session/db/sessionRepository";
import { PreviousInteractionNotRevealedError, type SessionRecord } from "../lib/session/types";
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
 * Slice 008 (Segment / Turn grouping) — Supabase contract suite.
 *
 * Structurally identical to votingSupabaseRepository.contract.test.ts
 * (same builders, same cleanup discipline), kept in its own file for the
 * same reason that one is. Exercises exactly what InMemorySessionRepository
 * (__tests__/segment.test.ts) cannot: real Postgres constraint
 * enforcement (the composite session/segment FK, the UNIQUE
 * (session_id, segment_ordinal) constraint) and real row-lock
 * serialization of start_session_atomically under genuine concurrency —
 * the three founder-directed concurrency reviews this slice's design
 * went through were specifically about behavior only provable here, not
 * in a single-threaded in-memory double.
 *
 * NOTE: historical backfill (0036's migration) is deliberately NOT
 * exercised by this file — it is a one-time transformation of
 * pre-existing rows, not a repeatable behavior this suite's
 * create-fresh-session-per-test pattern can represent. That must be
 * rehearsed separately, once, against a realistic seeded copy of
 * pre-Slice-008 data before this migration ever runs against production.
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
    hostToken: `segment-contract-host-token-${randomUUID()}`,
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
  const displayName = overrides.displayName ?? `SegmentContract-${randomUUID().slice(0, 8)}`;
  return {
    participantId: randomUUID(),
    sessionId,
    displayName,
    normalizedDisplayName: displayName.toLowerCase(),
    participantToken: `segment-contract-participant-token-${randomUUID()}`,
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

async function setupLockedSession(displayNames: string[] = ["Alex", "Jordan"]) {
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

describe("SupabaseSessionRepository contract — Segment migration-created schema", () => {
  it("segments exists and is reachable through the real client", async () => {
    const { data, error } = await cleanupClient
      .from("segments")
      .select("segment_id")
      .limit(1);
    expect(error).toBeNull();
    expect(data).toBeDefined();
  });
});

describe("SupabaseSessionRepository contract — ordinal allocation against live Postgres", () => {
  it("the first Segment for a session gets segment_ordinal 1, live", async () => {
    const { session } = await setupLockedSession();

    const started = await repository.startSession(
      session.sessionId,
      session.hostToken,
      { engineType: "OPEN_RESPONSE", promptText: "Prompt 1" }
    );

    expect(started.segmentNumber).toBe(1);

    const segments = await repository.getSegmentsForSession(session.sessionId);
    expect(segments).toHaveLength(1);
    expect(segments[0].segmentOrdinal).toBe(1);
  });

  it("NEW_SEGMENT increments the ordinal; CURRENT_SEGMENT reuses it — the Best Joke shape, against real Postgres", async () => {
    const { session, participants } = await setupLockedSession(["Alex", "Jordan"]);
    const [alex, jordan] = participants;

    const openResponse = await repository.startSession(
      session.sessionId,
      session.hostToken,
      { engineType: "OPEN_RESPONSE", promptText: "Tell us your best joke!" }
    );
    expect(openResponse.segmentNumber).toBe(1);

    await repository.submitResponse(session.sessionId, alex.participantId, alex.participantToken, "Joke A");
    await repository.submitResponse(session.sessionId, jordan.participantId, jordan.participantToken, "Joke B");
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

    const voting = await repository.startSession(
      session.sessionId,
      session.hostToken,
      {
        engineType: "VOTING",
        promptText: "Vote for the funniest!",
        candidateSource: { type: "SUBMISSION", sourceInteractionInstanceId: openResponse.interactionInstanceId },
      },
      "CURRENT_SEGMENT"
    );
    expect(voting.segmentNumber).toBe(1);
    expect(voting.interactionInstanceId).not.toBe(openResponse.interactionInstanceId);

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

    const nextTurn = await repository.startSession(
      session.sessionId,
      session.hostToken,
      { engineType: "OPEN_RESPONSE", promptText: "Next ad-hoc question" }
    );
    expect(nextTurn.segmentNumber).toBe(2);

    const segments = await repository.getSegmentsForSession(session.sessionId);
    expect(segments.map((s) => s.segmentOrdinal)).toEqual([1, 2]);
  });

  it("two genuinely concurrent NEW_SEGMENT calls against the same session: exactly one succeeds, no duplicate ordinal is ever persisted", async () => {
    const { session } = await setupLockedSession();

    const attempts = await Promise.allSettled([
      repository.startSession(session.sessionId, session.hostToken, {
        engineType: "OPEN_RESPONSE",
        promptText: "Prompt A",
      }),
      repository.startSession(session.sessionId, session.hostToken, {
        engineType: "OPEN_RESPONSE",
        promptText: "Prompt B",
      }),
    ]);

    const successes = attempts.filter((a) => a.status === "fulfilled");
    const failures = attempts.filter(
      (a): a is PromiseRejectedResult => a.status === "rejected"
    );

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toBeInstanceOf(PreviousInteractionNotRevealedError);

    const segments = await repository.getSegmentsForSession(session.sessionId);
    expect(segments).toHaveLength(1);
  });

  it("two genuinely concurrent CURRENT_SEGMENT calls against the same session: exactly one succeeds, the Segment gains only one new Interaction Instance", async () => {
    const { session } = await setupLockedSession();

    await repository.startSession(
      session.sessionId,
      session.hostToken,
      { engineType: "OPEN_RESPONSE", promptText: "Tell us your best joke!" }
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

    const attempts = await Promise.allSettled([
      repository.startSession(
        session.sessionId,
        session.hostToken,
        {
          engineType: "VOTING",
          promptText: "Vote for the funniest! (A)",
          candidateSource: { type: "HOST_AUTHORED", candidates: ["A1", "A2"] },
        },
        "CURRENT_SEGMENT"
      ),
      repository.startSession(
        session.sessionId,
        session.hostToken,
        {
          engineType: "VOTING",
          promptText: "Vote for the funniest! (B)",
          candidateSource: { type: "HOST_AUTHORED", candidates: ["B1", "B2"] },
        },
        "CURRENT_SEGMENT"
      ),
    ]);

    const successes = attempts.filter(
      (a): a is PromiseFulfilledResult<Awaited<ReturnType<typeof repository.startSession>>> =>
        a.status === "fulfilled"
    );
    const failures = attempts.filter(
      (a): a is PromiseRejectedResult => a.status === "rejected"
    );

    expect(successes).toHaveLength(1);
    expect(failures).toHaveLength(1);
    expect(failures[0].reason).toBeInstanceOf(PreviousInteractionNotRevealedError);
    expect(successes[0].value.segmentNumber).toBe(1);

    // The Segment gained exactly one new Interaction Instance (the
    // winner's) — never two, and the loser's attempt left no partial
    // row behind.
    const segments = await repository.getSegmentsForSession(session.sessionId);
    expect(segments).toHaveLength(1);
  });
});

describe("SupabaseSessionRepository contract — database-level integrity", () => {
  it("rejects a duplicate (session_id, segment_ordinal) pair at the database level", async () => {
    const { session } = await setupLockedSession();

    await repository.startSession(session.sessionId, session.hostToken, {
      engineType: "OPEN_RESPONSE",
      promptText: "Prompt 1",
    });
    const segments = await repository.getSegmentsForSession(session.sessionId);
    expect(segments).toHaveLength(1);

    // Bypasses the application layer entirely — start_session_atomically
    // can never produce this state itself (see 0037); this proves the
    // UNIQUE (session_id, segment_ordinal) constraint (0035) is the
    // actual, final integrity guarantee, not merely applicaton discipline.
    const { error } = await cleanupClient.from("segments").insert({
      session_id: session.sessionId,
      segment_ordinal: segments[0].segmentOrdinal,
    });

    expect(error).not.toBeNull();
    expect(error?.code).toBe("23505");
  });

  it("rejects cross-session Segment membership at the database level via the composite FK", async () => {
    const { session: sessionA } = await setupLockedSession(["Alex"]);
    const { session: sessionB } = await setupLockedSession(["Jordan"]);

    const startedA = await repository.startSession(
      sessionA.sessionId,
      sessionA.hostToken,
      { engineType: "OPEN_RESPONSE", promptText: "Prompt in session A" }
    );
    await repository.startSession(sessionB.sessionId, sessionB.hostToken, {
      engineType: "OPEN_RESPONSE",
      promptText: "Prompt in session B",
    });

    const segmentsB = await repository.getSegmentsForSession(sessionB.sessionId);
    expect(segmentsB).toHaveLength(1);

    // Attempts to attach an Interaction Instance whose session_id is A
    // but whose segment_id belongs to session B — the exact invalid
    // state the composite FK (0036) exists to make unrepresentable.
    // Bypasses the application layer entirely; no repository method can
    // construct this request, by design. Reuses session A's own
    // already-created prompt_id — irrelevant to the constraint under
    // test, just needed to satisfy the not-null prompt_id column.
    const { error } = await cleanupClient.from("interaction_instances").insert({
      session_id: sessionA.sessionId,
      segment_id: segmentsB[0].segmentId,
      prompt_id: startedA.promptId,
      state: "PROMPT_ACTIVE",
      engine_type: "OPEN_RESPONSE",
    });

    expect(error).not.toBeNull();
  });
});
