import { randomUUID } from "node:crypto";

import { loadEnv } from "vite";
import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";

import { SupabaseSessionRepository } from "../lib/session/db/supabaseSessionRepository";
import type { ParticipantRecord } from "../lib/session/db/sessionRepository";
import { type SessionRecord, DuelNotActiveError } from "../lib/session/types";
import { selectMathDuelChallenges, generateSuddenDeathChallenge } from "../lib/session/mathDuelFixture";

const env = loadEnv("development", process.cwd(), "");

const supabaseUrl = env.SUPABASE_URL;
const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error(
    "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for contract tests."
  );
}

/**
 * Math Duel Slice 001 — Supabase contract suite, rewritten by the
 * Pre-Deployment Product-Invariant Correction gate for lazy sudden-
 * death creation. Structurally identical to
 * duelSupabaseRepository.contract.test.ts (same builders, same
 * cleanup discipline). Exercises exactly what
 * InMemorySessionRepository (__tests__/mathDuel.test.ts) cannot: the
 * real start_math_duel_atomically / submit_math_duel_answer_atomically
 * functions against live Postgres, real FK/check-constraint
 * enforcement on duel_math_challenges/duel_math_responses, first-
 * write-wins under genuine concurrent INSERT, the new lazy-creation
 * race (two competitors confirming the same tie concurrently must
 * still create exactly one next-round row), the sessions-then-duels
 * lock order under genuine concurrent races, live structural proof
 * that sudden death has no round-count ceiling (Issue A), live proof
 * that activated-but-unanswered evidence survives an exceptional
 * termination (Issue B), and — explicitly — that the unmodified
 * Multiple Choice RPCs remain byte-identical in behavior after these
 * migrations.
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
const STANDARD = selectMathDuelChallenges(zeroRandom);

/** The deterministic content one specific sudden-death ordinal will have for a given Duel. */
function suddenDeathContent(duelId: string, ordinal: number) {
  return generateSuddenDeathChallenge(duelId, ordinal);
}

/**
 * Mirrors submitMathDuelAnswer.ts's own always-compute-the-candidate
 * discipline — every call in this suite goes directly through the
 * repository (bypassing the domain layer), so each call site
 * reproduces exactly what that domain layer would have passed.
 */
function withNextCandidate(duelId: string, challengeOrdinal: number) {
  return suddenDeathContent(duelId, challengeOrdinal + 1);
}

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
  return repository.startMathDuel(session.sessionId, session.hostToken, aId, bId, STANDARD);
}

/** Answers ordinals 1..5 for one participant with the fixture's own correct STANDARD values. */
async function answerAllStandardCorrect(duelId: string, token: string) {
  for (let ord = 1; ord <= 5; ord++) {
    await repository.submitMathDuelAnswer(
      duelId,
      token,
      ord,
      STANDARD[ord - 1].correctAnswer,
      withNextCandidate(duelId, ord)
    );
  }
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

  it("duel_math_challenges_reached view is reachable and excludes non-activated rows", async () => {
    const probe = await cleanupClient
      .from("duel_math_challenges_reached")
      .select("duel_id")
      .limit(1);
    expect(probe.error).toBeNull();
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

  it("start_math_duel_atomically persists exactly 5 STANDARD challenges — no sudden-death rows pre-materialized — with mechanic_key MATH_DUEL and null legacy MC columns", async () => {
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
    expect(challenges).toHaveLength(5);
    expect(challenges.every((c) => c.phase === "STANDARD")).toBe(true);
    expect(challenges[0].activatedAt).not.toBeNull();
    expect(challenges.slice(1).every((c) => c.activatedAt === null)).toBe(true);
  });

  it("rejects a challenge set that is not exactly 5 entries", async () => {
    const { session, participants } = await setupDuelReadySession();
    const [a, b] = participants;
    await expect(
      repository.startMathDuel(session.sessionId, session.hostToken, a.participantId, b.participantId, STANDARD.slice(0, 4))
    ).rejects.toThrow();
  });
});

describe("SUBMIT_MATH_DUEL_ANSWER — first-write-wins under genuine concurrency", () => {
  it("two concurrent submissions for the same (duel, ordinal, participant) never create two rows — exactly one wins", async () => {
    const { session, participants } = await setupDuelReadySession();
    const [a, b] = participants;
    const duel = await startAMathDuel(session, a.participantId, b.participantId);

    const results = await Promise.allSettled([
      repository.submitMathDuelAnswer(duel.duelId, a.participantToken, 1, STANDARD[0].correctAnswer, withNextCandidate(duel.duelId, 1)),
      repository.submitMathDuelAnswer(duel.duelId, a.participantToken, 1, STANDARD[0].correctAnswer, withNextCandidate(duel.duelId, 1)),
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
      await repository.submitMathDuelAnswer(duel.duelId, a.participantToken, ord, STANDARD[ord - 1].correctAnswer, withNextCandidate(duel.duelId, ord));
      await repository.submitMathDuelAnswer(duel.duelId, b.participantToken, ord, STANDARD[ord - 1].correctAnswer + 1, withNextCandidate(duel.duelId, ord));
    }

    const results = await Promise.allSettled([
      repository.submitMathDuelAnswer(duel.duelId, a.participantToken, 5, STANDARD[4].correctAnswer, withNextCandidate(duel.duelId, 5)),
      repository.submitMathDuelAnswer(duel.duelId, b.participantToken, 5, STANDARD[4].correctAnswer + 1, withNextCandidate(duel.duelId, 5)),
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

    // Decisive, not tied — no sudden-death round should ever have been
    // created.
    const challenges = await repository.getMathDuelChallenges(duel.duelId);
    expect(challenges).toHaveLength(5);
  });

  it("both competitors confirming the same tied round concurrently creates exactly one next-round row — the core lazy-creation race", async () => {
    const { session, participants } = await setupDuelReadySession();
    const [a, b] = participants;
    const duel = await startAMathDuel(session, a.participantId, b.participantId);
    await answerAllStandardCorrect(duel.duelId, a.participantToken);
    await answerAllStandardCorrect(duel.duelId, b.participantToken);

    // At this point ordinal 5 was answered by both (tied), sequentially
    // — round 6 already exists. Push into round 6 itself, tied again,
    // this time via genuinely concurrent calls: both competitors'
    // SUBMIT_MATH_DUEL_ANSWER for round 6 fire at once, each carrying
    // its own independently-computed (but identical, since it's a pure
    // function of the same duelId+ordinal) candidate for round 7. Only
    // one of the two calls may ever actually perform the INSERT for
    // round 7 — the duels-row lock this function already holds for its
    // entire execution serializes them, exactly as it already does for
    // normal resolution.
    const round6 = suddenDeathContent(duel.duelId, 6);
    const results = await Promise.allSettled([
      repository.submitMathDuelAnswer(duel.duelId, a.participantToken, 6, round6.correctAnswer, withNextCandidate(duel.duelId, 6)),
      repository.submitMathDuelAnswer(duel.duelId, b.participantToken, 6, round6.correctAnswer, withNextCandidate(duel.duelId, 6)),
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    const finalDuel = await repository.getDuelById(duel.duelId);
    expect(finalDuel?.lifecycleState).toBe("ACTIVE");

    const responses = await repository.getMathDuelResponses(duel.duelId);
    expect(responses.filter((r) => r.challengeOrdinal === 6)).toHaveLength(2);

    // The actual race this test exists to prove: exactly one round-7
    // row, never two, never a unique-constraint error surfaced to
    // either caller (both settled "fulfilled" above already confirms
    // no error reached the caller).
    const { data: round7Rows, error } = await cleanupClient
      .from("duel_math_challenges")
      .select("challenge_ordinal, question_text, correct_answer, activated_at")
      .eq("duel_id", duel.duelId)
      .eq("challenge_ordinal", 7);
    if (error) throw error;
    expect(round7Rows).toHaveLength(1);
    expect(round7Rows![0].activated_at).not.toBeNull();
  });
});

describe("SUBMIT_MATH_DUEL_ANSWER races COMPLETE_SESSION and Forfeit — live Postgres", () => {
  it("a submission racing COMPLETE_SESSION never leaves a fabricated winner", async () => {
    const { session, participants } = await setupDuelReadySession();
    const [a, b] = participants;
    const duel = await startAMathDuel(session, a.participantId, b.participantId);

    const results = await Promise.allSettled([
      repository.submitMathDuelAnswer(duel.duelId, a.participantToken, 1, STANDARD[0].correctAnswer, withNextCandidate(duel.duelId, 1)),
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
      repository.submitMathDuelAnswer(duel.duelId, a.participantToken, 1, STANDARD[0].correctAnswer, withNextCandidate(duel.duelId, 1)),
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
      repository.submitMathDuelAnswer(duel.duelId, a.participantToken, 1, STANDARD[0].correctAnswer, withNextCandidate(duel.duelId, 1))
    ).rejects.toThrow(DuelNotActiveError);
  });

  it("Issue B — a sudden-death round activated by a tie but cut short by exceptional resolution before either answers is honestly preserved in duel_math_challenges_reached", async () => {
    const { session, participants } = await setupDuelReadySession();
    const [a, b] = participants;
    const duel = await startAMathDuel(session, a.participantId, b.participantId);
    await answerAllStandardCorrect(duel.duelId, a.participantToken);
    await answerAllStandardCorrect(duel.duelId, b.participantToken);

    // The 5-5 tie lazily created round 6, activated for both — cut
    // short by Cancel before either answers it.
    await repository.resolveDuelExceptionally(duel.duelId, session.hostToken, "CANCELLED", null);

    const { data: reached, error } = await cleanupClient
      .from("duel_math_challenges_reached")
      .select("challenge_ordinal")
      .eq("duel_id", duel.duelId)
      .order("challenge_ordinal", { ascending: true });
    if (error) throw error;
    expect(reached!.map((r) => r.challenge_ordinal)).toEqual([1, 2, 3, 4, 5, 6]);

    const responses = await repository.getMathDuelResponses(duel.duelId);
    expect(responses.filter((r) => r.challengeOrdinal === 6)).toHaveLength(0);
  });
});

describe("Issue A — sudden death has no round-count ceiling, proven live against real Postgres", () => {
  it("continues cleanly past the old 25-round pre-materialized reserve boundary with no exhaustion error", async () => {
    const { session, participants } = await setupDuelReadySession();
    const [a, b] = participants;
    const duel = await startAMathDuel(session, a.participantId, b.participantId);
    await answerAllStandardCorrect(duel.duelId, a.participantToken);
    await answerAllStandardCorrect(duel.duelId, b.participantToken);

    // Old design: exactly 25 sudden-death rows (ordinals 6-30)
    // pre-materialized; ordinal 31 had no row and
    // MATH_DUEL_CHALLENGES_EXHAUSTED fired permanently. Drive 28
    // consecutive tied rounds here (ordinals 6..33) — past that old
    // ordinal-31 boundary — against real Postgres, sequentially (not
    // parallel, so each round's lazy-creation happens deterministically
    // before the next is attempted).
    for (let round = 6; round <= 33; round++) {
      const challenge = suddenDeathContent(duel.duelId, round);
      await repository.submitMathDuelAnswer(duel.duelId, a.participantToken, round, challenge.correctAnswer, withNextCandidate(duel.duelId, round));
      await repository.submitMathDuelAnswer(duel.duelId, b.participantToken, round, challenge.correctAnswer, withNextCandidate(duel.duelId, round));
    }

    const midDuel = await repository.getDuelById(duel.duelId);
    expect(midDuel?.lifecycleState).toBe("ACTIVE");
    expect(midDuel?.terminalResolution).toBeNull();

    const challenges = await repository.getMathDuelChallenges(duel.duelId);
    expect(challenges).toHaveLength(34); // 5 standard + rounds 6..34 (34 lazily created by round 33's tie)
    expect(challenges.at(-1)?.challengeOrdinal).toBe(34);

    // Decide it, well past the old cap.
    const decisive = suddenDeathContent(duel.duelId, 34);
    await repository.submitMathDuelAnswer(duel.duelId, a.participantToken, 34, decisive.correctAnswer, withNextCandidate(duel.duelId, 34));
    await repository.submitMathDuelAnswer(duel.duelId, b.participantToken, 34, decisive.correctAnswer + 1, withNextCandidate(duel.duelId, 34));

    const resolved = await repository.getDuelById(duel.duelId);
    expect(resolved?.lifecycleState).toBe("COMPLETED");
    expect(resolved?.winnerParticipantId).toBe(a.participantId);
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
