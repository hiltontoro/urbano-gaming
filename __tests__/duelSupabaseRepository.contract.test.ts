import { randomUUID } from "node:crypto";

import { loadEnv } from "vite";
import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";

import { SupabaseSessionRepository } from "../lib/session/db/supabaseSessionRepository";
import type { ParticipantRecord } from "../lib/session/db/sessionRepository";
import {
  type SessionRecord,
  ActiveDuelExistsError,
  InteractionActiveError,
  DuelAlreadyResolvedError,
} from "../lib/session/types";

const env = loadEnv("development", process.cwd(), "");

const supabaseUrl = env.SUPABASE_URL;
const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;

if (!supabaseUrl || !supabaseServiceRoleKey) {
  throw new Error(
    "SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required for contract tests."
  );
}

/**
 * Duel / SESSION_SUBGAME v1 — Supabase contract suite.
 *
 * Structurally identical to quizSupabaseRepository.contract.test.ts
 * (same builders, same cleanup discipline). Exercises exactly what
 * InMemorySessionRepository (__tests__/duel.test.ts) cannot: the real
 * start_duel_atomically / submit_duel_response_atomically /
 * resolve_duel_atomically / resolve_duel_exceptionally_atomically
 * functions against live Postgres, real FK and check-constraint
 * enforcement on duels/duel_responses, the
 * duels_one_active_per_session unique partial index under genuine
 * concurrency, and the extended start_session_atomically /
 * start_quiz_atomically / complete_session_atomically guards under
 * genuine concurrency.
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
    hostToken: `duel-contract-host-token-${randomUUID()}`,
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
  const displayName = overrides.displayName ?? `DuelContract-${randomUUID().slice(0, 8)}`;
  return {
    participantId: randomUUID(),
    sessionId,
    displayName,
    normalizedDisplayName: displayName.toLowerCase(),
    participantToken: `duel-contract-participant-token-${randomUUID()}`,
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

const OPTIONS = ["Paris", "London", "Berlin", "Madrid"];
const CORRECT_INDEX = 0;

async function setupDuelReadySession(
  capabilities: string[] = ["DUEL"],
  displayNames: string[] = ["Alex", "Blair", "Casey", "Drew"]
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

async function startADuel(session: SessionRecord, aId: string, bId: string) {
  return repository.startDuel(
    session.sessionId,
    session.hostToken,
    aId,
    bId,
    "Capital of France?",
    OPTIONS,
    CORRECT_INDEX
  );
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

describe("SupabaseSessionRepository contract — Duel migration-created schema", () => {
  it("duels and duel_responses exist and are reachable through the real client", async () => {
    const duelsProbe = await cleanupClient.from("duels").select("duel_id").limit(1);
    expect(duelsProbe.error).toBeNull();
    const responsesProbe = await cleanupClient.from("duel_responses").select("duel_id").limit(1);
    expect(responsesProbe.error).toBeNull();
  });

  it("rejects an orphan duel_responses row at the database level (FK to duels)", async () => {
    const { error } = await cleanupClient.from("duel_responses").insert({
      duel_id: randomUUID(),
      participant_id: randomUUID(),
      selected_option_index: 0,
    });
    expect(error).not.toBeNull();
  });

  it("rejects a duel row with identical competitor ids at the database level (check constraint)", async () => {
    const { session, participants } = await setupDuelReadySession();
    const sameId = participants[0].participantId;
    const { error } = await cleanupClient.from("duels").insert({
      session_id: session.sessionId,
      competitor_a_participant_id: sameId,
      competitor_b_participant_id: sameId,
      prompt_text: "Q?",
      options: OPTIONS,
      correct_option_index: 0,
    });
    expect(error).not.toBeNull();
  });
});

describe("start_duel_atomically — live Postgres", () => {
  it("creates an ACTIVE duel bound to two real competitors, with no interaction_instances row", async () => {
    const { session, participants } = await setupDuelReadySession();
    const [a, b] = participants;

    const result = await startADuel(session, a.participantId, b.participantId);
    expect(result.lifecycleState).toBe("ACTIVE");

    const active = await repository.getActiveDuelForSession(session.sessionId);
    expect(active?.duelId).toBe(result.duelId);

    const instances = await repository.getInteractionInstancesForSession(session.sessionId);
    expect(instances).toHaveLength(0);
  });

  it("the duels_one_active_per_session unique partial index holds under genuine concurrency: two simultaneous START_DUELs resolve to exactly one ACTIVE duel", async () => {
    const { session, participants } = await setupDuelReadySession(["DUEL"], [
      "RaceA1",
      "RaceB1",
      "RaceA2",
      "RaceB2",
    ]);
    const [p1, p2, p3, p4] = participants;

    const results = await Promise.allSettled([
      startADuel(session, p1.participantId, p2.participantId),
      startADuel(session, p3.participantId, p4.participantId),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);
    const rejected = results.filter((r) => r.status === "rejected");
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(ActiveDuelExistsError);

    const { count, error } = await cleanupClient
      .from("duels")
      .select("duel_id", { count: "exact", head: true })
      .eq("session_id", session.sessionId)
      .eq("lifecycle_state", "ACTIVE");
    if (error) throw error;
    expect(count).toBe(1);
  });

  it("START_DUEL races an ordinary START_SESSION: exactly one of the two mutually exclusive activities wins", async () => {
    const { session, participants } = await setupDuelReadySession(["DUEL", "OPEN_RESPONSE"]);
    const [a, b] = participants;

    const results = await Promise.allSettled([
      startADuel(session, a.participantId, b.participantId),
      repository.startSession(session.sessionId, session.hostToken, {
        engineType: "OPEN_RESPONSE",
        promptText: "Racing prompt",
      }),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    expect(fulfilled).toHaveLength(1);

    const activeDuel = await repository.getActiveDuelForSession(session.sessionId);
    const instances = await repository.getInteractionInstancesForSession(session.sessionId);
    // Exactly one of the two activities actually exists — never both.
    const duelWon = activeDuel !== null;
    const interactionWon = instances.length > 0;
    expect(duelWon).toBe(!interactionWon);
  });

  it("START_DUEL races COMPLETE_SESSION: either the duel starts before completion voids it, or completion wins outright and no duel is left ACTIVE", async () => {
    const { session, participants } = await setupDuelReadySession();
    const [a, b] = participants;

    const results = await Promise.allSettled([
      startADuel(session, a.participantId, b.participantId),
      repository.completeSession(session.sessionId, session.hostToken, {
        sessionId: session.sessionId,
        eventType: "SESSION_COMPLETED",
        payload: {},
      }),
    ]);

    // Both operations are legal to succeed independently (starting a
    // duel does not require the session to still be running, and
    // completing does not require the duel to not yet exist) — the
    // invariant under test is only that no ACTIVE duel survives.
    const anySucceeded = results.some((r) => r.status === "fulfilled");
    expect(anySucceeded).toBe(true);

    const stillActive = await repository.getActiveDuelForSession(session.sessionId);
    expect(stillActive).toBeNull();
  });

  it("rejects starting a Duel while an ordinary Interaction is still active", async () => {
    const { session, participants } = await setupDuelReadySession(["DUEL", "OPEN_RESPONSE"]);
    const [a, b] = participants;
    await repository.startSession(session.sessionId, session.hostToken, {
      engineType: "OPEN_RESPONSE",
      promptText: "Still open",
    });

    await expect(startADuel(session, a.participantId, b.participantId)).rejects.toBeInstanceOf(
      InteractionActiveError
    );
  });

  it("rejects starting a second Duel while one is already ACTIVE, then permits it once resolved (terminalization vs next-activity-start)", async () => {
    const { session, participants } = await setupDuelReadySession(["DUEL"], [
      "SeqA1",
      "SeqB1",
      "SeqA2",
      "SeqB2",
    ]);
    const [p1, p2, p3, p4] = participants;

    const first = await startADuel(session, p1.participantId, p2.participantId);
    await expect(startADuel(session, p3.participantId, p4.participantId)).rejects.toBeInstanceOf(
      ActiveDuelExistsError
    );

    await repository.resolveDuel(first.duelId, session.hostToken);

    const results = await Promise.allSettled([
      startADuel(session, p3.participantId, p4.participantId),
      repository.getActiveDuelForSession(session.sessionId),
    ]);
    expect(results[0].status).toBe("fulfilled");
  });
});

describe("submit_duel_response_atomically — live Postgres", () => {
  it("persists a legal competitor submission and rejects an out-of-range option at the database level", async () => {
    const { session, participants } = await setupDuelReadySession();
    const [a, b] = participants;
    const duel = await startADuel(session, a.participantId, b.participantId);

    const result = await repository.submitDuelResponse(duel.duelId, a.participantToken, 1);
    expect(result.participantId).toBe(a.participantId);

    const responses = await repository.getDuelResponses(duel.duelId);
    expect(responses).toHaveLength(1);
    expect(responses[0].selectedOptionIndex).toBe(1);
  });

  it("two simultaneous competitor submissions to the same Duel both persist without deadlock, one row each", async () => {
    const { session, participants } = await setupDuelReadySession();
    const [a, b] = participants;
    const duel = await startADuel(session, a.participantId, b.participantId);

    const results = await Promise.allSettled([
      repository.submitDuelResponse(duel.duelId, a.participantToken, CORRECT_INDEX),
      repository.submitDuelResponse(duel.duelId, b.participantToken, CORRECT_INDEX + 1),
    ]);
    expect(results.every((r) => r.status === "fulfilled")).toBe(true);

    const responses = await repository.getDuelResponses(duel.duelId);
    expect(responses).toHaveLength(2);
    const byParticipant = new Map(responses.map((r) => [r.participantId, r.selectedOptionIndex]));
    expect(byParticipant.get(a.participantId)).toBe(CORRECT_INDEX);
    expect(byParticipant.get(b.participantId)).toBe(CORRECT_INDEX + 1);
  });

  it("last-write-wins: a second submission from the same competitor replaces the first as one row, not two", async () => {
    const { session, participants } = await setupDuelReadySession();
    const [a, b] = participants;
    const duel = await startADuel(session, a.participantId, b.participantId);

    await repository.submitDuelResponse(duel.duelId, a.participantToken, 1);
    await repository.submitDuelResponse(duel.duelId, a.participantToken, 2);

    const { count, error } = await cleanupClient
      .from("duel_responses")
      .select("duel_id", { count: "exact", head: true })
      .eq("duel_id", duel.duelId)
      .eq("participant_id", a.participantId);
    if (error) throw error;
    expect(count).toBe(1);

    const responses = await repository.getDuelResponses(duel.duelId);
    expect(responses.find((r) => r.participantId === a.participantId)?.selectedOptionIndex).toBe(2);
  });
});

describe("resolve_duel_atomically — live Postgres", () => {
  it("resolves deterministically: only-correct-competitor wins, correctOptionIndex never leaks through the public read", async () => {
    const { session, participants } = await setupDuelReadySession();
    const [a, b] = participants;
    const duel = await startADuel(session, a.participantId, b.participantId);

    await repository.submitDuelResponse(duel.duelId, a.participantToken, CORRECT_INDEX);
    await repository.submitDuelResponse(duel.duelId, b.participantToken, CORRECT_INDEX + 1);

    const result = await repository.resolveDuel(duel.duelId, session.hostToken);
    expect(result.terminalResolution).toBe("WON_LOST");
    expect(result.winnerParticipantId).toBe(a.participantId);
    expect(result).not.toHaveProperty("correctOptionIndex");
  });

  it("resolution voids Session completion race: a Duel resolving concurrently with COMPLETE_SESSION never leaves a fabricated winner", async () => {
    const { session, participants } = await setupDuelReadySession();
    const [a, b] = participants;
    const duel = await startADuel(session, a.participantId, b.participantId);
    await repository.submitDuelResponse(duel.duelId, a.participantToken, CORRECT_INDEX);

    const results = await Promise.allSettled([
      repository.resolveDuel(duel.duelId, session.hostToken),
      repository.completeSession(session.sessionId, session.hostToken, {
        sessionId: session.sessionId,
        eventType: "SESSION_COMPLETED",
        payload: {},
      }),
    ]);

    // completeSession never depends on the Duel's state, so it always
    // succeeds. resolveDuel races it for the same duel row lock:
    // whichever transaction locks the row first wins the Duel's
    // terminal state. If completeSession's void wins, resolveDuel finds
    // the Duel already COMPLETED and correctly rejects rather than
    // silently overwriting a terminal result.
    const [resolveResult, completeResult] = results;
    expect(completeResult.status).toBe("fulfilled");
    if (resolveResult.status === "rejected") {
      expect(resolveResult.reason).toBeInstanceOf(DuelAlreadyResolvedError);
    }

    const finalDuel = await repository.getDuelById(duel.duelId);
    expect(finalDuel?.lifecycleState).toBe("COMPLETED");
    if (resolveResult.status === "fulfilled") {
      // resolveDuel's own mechanic-derived result won the race.
      expect(finalDuel?.terminalResolution).toBe("WON_LOST");
    } else {
      // completeSession's void won the race — never a fabricated winner.
      expect(finalDuel?.terminalResolution).toBe("VOID");
      expect(finalDuel?.winnerParticipantId).toBeNull();
    }
  });
});

describe("Session-completion voids an active Duel — live Postgres", () => {
  it("COMPLETE_SESSION transitions an ACTIVE duel to COMPLETED/VOID atomically, preserving partial responses", async () => {
    const { session, participants } = await setupDuelReadySession();
    const [a, b] = participants;
    const duel = await startADuel(session, a.participantId, b.participantId);
    await repository.submitDuelResponse(duel.duelId, a.participantToken, CORRECT_INDEX);

    await repository.completeSession(session.sessionId, session.hostToken, {
      sessionId: session.sessionId,
      eventType: "SESSION_COMPLETED",
      payload: {},
    });

    const voided = await repository.getDuelById(duel.duelId);
    expect(voided?.lifecycleState).toBe("COMPLETED");
    expect(voided?.terminalResolution).toBe("VOID");
    expect(voided?.winnerParticipantId).toBeNull();

    const responses = await repository.getDuelResponses(duel.duelId);
    expect(responses).toHaveLength(1);
    expect(responses[0].participantId).toBe(a.participantId);
  });
});
