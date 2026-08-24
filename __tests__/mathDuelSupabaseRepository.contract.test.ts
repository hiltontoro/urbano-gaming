import { randomUUID } from "node:crypto";

import { loadEnv } from "vite";
import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";

import { SupabaseSessionRepository } from "../lib/session/db/supabaseSessionRepository";
import type { ParticipantRecord } from "../lib/session/db/sessionRepository";
import { type SessionRecord, DuelNotActiveError } from "../lib/session/types";
import { selectMathDuelChallenges, MATH_DUEL_STANDARD_COUNT } from "../lib/session/mathDuelFixture";

const env = loadEnv("development", process.cwd(), "");

const supabaseUrl = env.SUPABASE_URL;
const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error(
    "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for contract tests."
  );
}

/**
 * Math Duel Slice 001 — Supabase contract suite. Structurally
 * identical to duelSupabaseRepository.contract.test.ts (same builders,
 * same cleanup discipline). Exercises exactly what
 * InMemorySessionRepository (__tests__/mathDuel.test.ts) cannot: the
 * real start_math_duel_atomically / submit_math_duel_answer_atomically
 * functions against live Postgres, real FK/check-constraint
 * enforcement on duel_math_challenges/duel_math_responses, first-
 * write-wins under genuine concurrent INSERT, the sessions-then-duels
 * lock order under genuine concurrent races (mirroring
 * duelSupabaseRepository.contract.test.ts's own proven RESOLVE_DUEL-
 * vs-COMPLETE_SESSION scenario), and — explicitly — that the
 * unmodified Multiple Choice RPCs remain byte-identical in behavior
 * after these migrations.
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
    hostToken: `math-duel-contract-host-token-${randomUUID()}`,
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
  const displayName = overrides.displayName ?? `MathDuelContract-${randomUUID().slice(0, 8)}`;
  return {
    participantId: randomUUID(),
    sessionId,
    displayName,
    normalizedDisplayName: displayName.toLowerCase(),
    participantToken: `math-duel-contract-participant-token-${randomUUID()}`,
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

const zeroRandom = () => 0;
const EXPECTED_CHALLENGES = selectMathDuelChallenges(zeroRandom);
const STANDARD = EXPECTED_CHALLENGES.slice(0, MATH_DUEL_STANDARD_COUNT);

async function setupDuelReadySession(
  capabilities: string[] = ["DUEL"],
  displayNames: string[] = ["Alex", "Blair", "Casey"]
) {
  const session = buildSessionRecord();
  createdSessionIds.push(session.sessionId);
  await repository.createSession(session, buildInitialEvent(session));
  await repository.setSessionCapabilities(session.sessionId, session.hostToken, capabilities);

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

async function startAMathDuel(session: SessionRecord, aId: string, bId: string) {
  return repository.startMathDuel(
    session.sessionId,
    session.hostToken,
    aId,
    bId,
    EXPECTED_CHALLENGES
  );
}

afterAll(async () => {
  if (createdSessionIds.length === 0) return;
  const { error: responsesError } = await cleanupClient
    .from("duel_math_responses")
    .delete()
    .in(
      "duel_id",
      (
        await cleanupClient
          .from("duels")
          .select("duel_id")
          .in("session_id", createdSessionIds)
      ).data?.map((r) => r.duel_id) ?? []
    );
  if (responsesError) throw responsesError;

  const { error: challengesError } = await cleanupClient
    .from("duel_math_challenges")
    .delete()
    .in(
      "duel_id",
      (
        await cleanupClient
          .from("duels")
          .select("duel_id")
          .in("session_id", createdSessionIds)
      ).data?.map((r) => r.duel_id) ?? []
    );
  if (challengesError) throw challengesError;

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

describe("SupabaseSessionRepository contract — Math Duel migration-created schema", () => {
  it("duel_math_challenges and duel_math_responses exist and are reachable", async () => {
    const challengesProbe = await cleanupClient
      .from("duel_math_challenges")
      .select("duel_id")
      .limit(1);
    expect(challengesProbe.error).toBeNull();
    const responsesProbe = await cleanupClient
      .from("duel_math_responses")
      .select("duel_id")
      .limit(1);
    expect(responsesProbe.error).toBeNull();
  });

  it("rejects a math response with no corresponding challenge (composite FK)", async () => {
    const { session, participants } = await setupDuelReadySession();
    const [a, b] = participants;
    const duel = await startAMathDuel(session, a.participantId, b.participantId);
    const { error } = await cleanupClient.from("duel_math_responses").insert({
      duel_id: duel.duelId,
      challenge_ordinal: 9999,
      participant_id: a.participantId,
      submitted_answer: 1,
      is_correct: false,
    });
    expect(error).not.toBeNull();
  });

  it("rejects a duels row with an out-of-vocabulary mechanic_key (check constraint still enforced after widening)", async () => {
    const { session, participants } = await setupDuelReadySession();
    const [a, b] = participants;
    const { error } = await cleanupClient.from("duels").insert({
      session_id: session.sessionId,
      competitor_a_participant_id: a.participantId,
      competitor_b_participant_id: b.participantId,
      mechanic_key: "CONNECT_FOUR",
    });
    expect(error).not.toBeNull();
    expect(error?.message).toMatch(/duels_mechanic_key_valid_values/);
  });

  it("start_math_duel_atomically persists exactly 5 STANDARD challenges plus the full sudden-death supply, with mechanic_key MATH_DUEL and null legacy MC columns", async () => {
    const { session, participants } = await setupDuelReadySession();
    const [a, b] = participants;
    const duel = await startAMathDuel(session, a.participantId, b.participantId);

    const { data: duelRow, error: duelError } = await cleanupClient
      .from("duels")
      .select("mechanic_key, prompt_text, options, correct_option_index")
      .eq("duel_id", duel.duelId)
      .single();
    if (duelError) throw duelError;
    expect(duelRow.mechanic_key).toBe("MATH_DUEL");
    expect(duelRow.prompt_text).toBeNull();
    expect(duelRow.options).toBeNull();
    expect(duelRow.correct_option_index).toBeNull();

    const challenges = await repository.getMathDuelChallenges(duel.duelId);
    expect(challenges.filter((c) => c.phase === "STANDARD")).toHaveLength(5);
    expect(challenges.length).toBe(EXPECTED_CHALLENGES.length);
  });
});

describe("SUBMIT_MATH_DUEL_ANSWER — first-write-wins under genuine concurrency", () => {
  it("two concurrent submissions for the same (duel, ordinal, participant) never create two rows — exactly one wins", async () => {
    const { session, participants } = await setupDuelReadySession();
    const [a, b] = participants;
    const duel = await startAMathDuel(session, a.participantId, b.participantId);

    const results = await Promise.allSettled([
      repository.submitMathDuelAnswer(duel.duelId, a.participantToken, 1, STANDARD[0].correctAnswer),
      repository.submitMathDuelAnswer(duel.duelId, a.participantToken, 1, STANDARD[0].correctAnswer),
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    const { data, error } = await cleanupClient
      .from("duel_math_responses")
      .select("*")
      .eq("duel_id", duel.duelId)
      .eq("challenge_ordinal", 1)
      .eq("participant_id", a.participantId);
    if (error) throw error;
    expect(data).toHaveLength(1);
  });

  it("both competitors submitting the deciding standard challenge (ordinal 5) concurrently produces exactly one terminal state, never a duplicate resolution", async () => {
    const { session, participants } = await setupDuelReadySession();
    const [a, b] = participants;
    const duel = await startAMathDuel(session, a.participantId, b.participantId);

    for (let ord = 1; ord <= 4; ord++) {
      await repository.submitMathDuelAnswer(duel.duelId, a.participantToken, ord, STANDARD[ord - 1].correctAnswer);
      await repository.submitMathDuelAnswer(duel.duelId, b.participantToken, ord, STANDARD[ord - 1].correctAnswer + 1);
    }

    const results = await Promise.allSettled([
      repository.submitMathDuelAnswer(duel.duelId, a.participantToken, 5, STANDARD[4].correctAnswer),
      repository.submitMathDuelAnswer(duel.duelId, b.participantToken, 5, STANDARD[4].correctAnswer + 1),
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    const finalDuel = await repository.getDuelById(duel.duelId);
    expect(finalDuel?.lifecycleState).toBe("COMPLETED");
    expect(finalDuel?.terminalResolution).toBe("WON_LOST");
    expect(finalDuel?.winnerParticipantId).toBe(a.participantId);

    const { data: events, error } = await cleanupClient
      .from("session_events")
      .select("event_type")
      .eq("session_id", session.sessionId)
      .eq("event_type", "DUEL_RESOLVED");
    if (error) throw error;
    expect(events).toHaveLength(1);
  });

  it("both competitors submitting the same tied sudden-death round concurrently never creates a duplicate next round", async () => {
    const { session, participants } = await setupDuelReadySession();
    const [a, b] = participants;
    const duel = await startAMathDuel(session, a.participantId, b.participantId);

    for (let ord = 1; ord <= 5; ord++) {
      await repository.submitMathDuelAnswer(duel.duelId, a.participantToken, ord, STANDARD[ord - 1].correctAnswer);
      await repository.submitMathDuelAnswer(duel.duelId, b.participantToken, ord, STANDARD[ord - 1].correctAnswer);
    }

    const round6 = EXPECTED_CHALLENGES[5];
    const results = await Promise.allSettled([
      repository.submitMathDuelAnswer(duel.duelId, a.participantToken, 6, round6.correctAnswer),
      repository.submitMathDuelAnswer(duel.duelId, b.participantToken, 6, round6.correctAnswer),
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    const finalDuel = await repository.getDuelById(duel.duelId);
    expect(finalDuel?.lifecycleState).toBe("ACTIVE");

    const view = await repository.getMathDuelResponses(duel.duelId);
    expect(view.filter((r) => r.challengeOrdinal === 6)).toHaveLength(2);
  });
});

describe("SUBMIT_MATH_DUEL_ANSWER races COMPLETE_SESSION and Forfeit — live Postgres", () => {
  it("a submission racing COMPLETE_SESSION never leaves a fabricated winner", async () => {
    const { session, participants } = await setupDuelReadySession();
    const [a, b] = participants;
    const duel = await startAMathDuel(session, a.participantId, b.participantId);

    const results = await Promise.allSettled([
      repository.submitMathDuelAnswer(duel.duelId, a.participantToken, 1, STANDARD[0].correctAnswer),
      repository.completeSession(session.sessionId, session.hostToken, {
        sessionId: session.sessionId,
        eventType: "SESSION_COMPLETED",
        payload: {},
      }),
    ]);

    expect(results[1].status).toBe("fulfilled");

    const finalDuel = await repository.getDuelById(duel.duelId);
    expect(finalDuel?.lifecycleState).toBe("COMPLETED");
    // Whichever order won, the Duel is never left ACTIVE and never
    // carries a fabricated winner from a submission alone.
    if (finalDuel?.terminalResolution === "VOID") {
      expect(finalDuel.winnerParticipantId).toBeNull();
    }
  });

  it("a submission racing an exceptional Forfeit resolution never leaves two terminal events", async () => {
    const { session, participants } = await setupDuelReadySession();
    const [a, b] = participants;
    const duel = await startAMathDuel(session, a.participantId, b.participantId);

    const results = await Promise.allSettled([
      repository.submitMathDuelAnswer(duel.duelId, a.participantToken, 1, STANDARD[0].correctAnswer),
      repository.resolveDuelExceptionally(duel.duelId, session.hostToken, "FORFEIT_A", "Disconnected"),
    ]);

    expect(results[1].status).toBe("fulfilled");
    const finalDuel = await repository.getDuelById(duel.duelId);
    expect(finalDuel?.lifecycleState).toBe("COMPLETED");

    const { data: events, error } = await cleanupClient
      .from("session_events")
      .select("event_type")
      .eq("session_id", session.sessionId)
      .eq("event_type", "DUEL_RESOLVED");
    if (error) throw error;
    expect(events).toHaveLength(1);
  });

  it("rejects a submission to an already-completed Math Duel", async () => {
    const { session, participants } = await setupDuelReadySession();
    const [a, b] = participants;
    const duel = await startAMathDuel(session, a.participantId, b.participantId);
    await repository.resolveDuelExceptionally(duel.duelId, session.hostToken, "VOID", null);

    await expect(
      repository.submitMathDuelAnswer(duel.duelId, a.participantToken, 1, STANDARD[0].correctAnswer)
    ).rejects.toThrow(DuelNotActiveError);
  });
});

describe("Legacy Multiple Choice compatibility after Math Duel migrations — live Postgres", () => {
  it("start_duel_atomically / submit_duel_response_atomically / resolve_duel_atomically remain unchanged in behavior", async () => {
    const { session, participants } = await setupDuelReadySession();
    const [a, b] = participants;

    const duel = await repository.startDuel(
      session.sessionId,
      session.hostToken,
      a.participantId,
      b.participantId,
      "Legacy MC still works?",
      ["Yes", "No"],
      0
    );
    expect(duel.mechanicKey).toBe("MULTIPLE_CHOICE");

    await repository.submitDuelResponse(duel.duelId, a.participantToken, 0);
    await repository.submitDuelResponse(duel.duelId, b.participantToken, 1);

    const resolved = await repository.resolveDuel(duel.duelId, session.hostToken);
    expect(resolved.terminalResolution).toBe("WON_LOST");
    expect(resolved.winnerParticipantId).toBe(a.participantId);

    const record = await repository.getDuelById(duel.duelId);
    expect(record?.multipleChoice?.promptText).toBe("Legacy MC still works?");
  });
});
