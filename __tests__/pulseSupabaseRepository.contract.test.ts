import { randomUUID } from "node:crypto";

import { loadEnv } from "vite";
import { createClient } from "@supabase/supabase-js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SupabaseSessionRepository } from "../lib/session/db/supabaseSessionRepository";
import type { ParticipantRecord } from "../lib/session/db/sessionRepository";
import { type SessionRecord } from "../lib/session/types";
import type { PulseForm } from "../lib/session/types";
import {
  PulseNotYourTurnError,
  PulseTurnExpiredError,
  PulseNotActiveError,
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
 * URBANO Pulse Slice 001 (UG-CR-GATE-002). Mandatory environment guard
 * — the gate explicitly requires proving this suite targets the local
 * Postgres stack before it runs any mutation, given that a private
 * board layout is genuinely at stake if this suite is ever pointed at
 * the cloud project by an unedited .env.local. Refuse outright rather
 * than trusting the ambient environment.
 */
if (!/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/.test(supabaseUrl)) {
  throw new Error(
    `Pulse contract suite refuses to run against a non-local SUPABASE_URL ("${supabaseUrl}"). ` +
      "Export SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY for the local `supabase status` stack " +
      "before running npm run test:contract — never edit .env.local for this."
  );
}

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
    hostToken: `pulse-contract-host-token-${randomUUID()}`,
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
  const displayName = overrides.displayName ?? `PulseContract-${randomUUID().slice(0, 8)}`;
  return {
    participantId: randomUUID(),
    sessionId,
    displayName,
    normalizedDisplayName: displayName.toLowerCase(),
    participantToken: `pulse-contract-participant-token-${randomUUID()}`,
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

const ALICE_FORMS: PulseForm[] = [
  { formId: "a1", cells: [{ row: 0, col: 0 }, { row: 0, col: 1 }] },
  { formId: "a2", cells: [{ row: 2, col: 0 }, { row: 3, col: 0 }] },
  { formId: "a3", cells: [{ row: 5, col: 0 }, { row: 5, col: 1 }, { row: 5, col: 2 }] },
  { formId: "a4", cells: [{ row: 7, col: 0 }, { row: 7, col: 1 }, { row: 7, col: 2 }, { row: 7, col: 3 }] },
];
const BOB_FORMS: PulseForm[] = [
  { formId: "b1", cells: [{ row: 0, col: 2 }, { row: 0, col: 3 }] },
  { formId: "b2", cells: [{ row: 2, col: 2 }, { row: 3, col: 2 }] },
  { formId: "b3", cells: [{ row: 5, col: 3 }, { row: 5, col: 4 }, { row: 5, col: 5 }] },
  { formId: "b4", cells: [{ row: 7, col: 4 }, { row: 7, col: 5 }, { row: 7, col: 6 }, { row: 7, col: 7 }] },
];

async function setupPulseReadySession(displayNames: string[] = ["Alice", "Bob", "Spectator"]) {
  const session = buildSessionRecord();
  createdSessionIds.push(session.sessionId);
  await repository.createSession(session, buildInitialEvent(session));
  await repository.setSessionCapabilities(session.sessionId, session.hostToken, ["DUEL"]);

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

async function startAPulseDuel(session: SessionRecord, aId: string, bId: string) {
  return repository.startPulseDuel(session.sessionId, session.hostToken, aId, bId);
}

function testKey(): string {
  return `pulse-contract-${randomUUID()}`;
}

async function commitBoth(duelId: string, aToken: string, bToken: string) {
  await repository.commitPulseSetup(duelId, aToken, ALICE_FORMS, false, testKey());
  return repository.commitPulseSetup(duelId, bToken, BOB_FORMS, false, testKey());
}

const SAFE_MISS_CELLS = [
  { row: 1, col: 7 }, { row: 4, col: 7 }, { row: 6, col: 7 }, { row: 1, col: 6 },
  { row: 4, col: 6 }, { row: 6, col: 6 }, { row: 1, col: 5 }, { row: 4, col: 5 },
  { row: 6, col: 5 }, { row: 1, col: 4 }, { row: 4, col: 4 }, { row: 6, col: 4 },
];

/** Drives whichever competitor the coin flip selected first to a full, ordinary win. */
async function driveToOrdinaryCompletion(
  duelId: string,
  aId: string,
  aToken: string,
  bId: string,
  bToken: string
) {
  const game = await repository.getPulseGame(duelId);
  const winnerId = game!.currentActorParticipantId!;
  const winnerToken = winnerId === aId ? aToken : bToken;
  const loserToken = winnerId === aId ? bToken : aToken;
  const winnerTargets = winnerId === aId ? BOB_FORMS : ALICE_FORMS;
  const cells = winnerTargets.flatMap((f) => f.cells);

  let loserIdx = 0;
  let last;
  for (const cell of cells) {
    last = await repository.applyPulseTarget(duelId, winnerToken, cell.row, cell.col, testKey());
    if (last.terminal) break;
    const safe = SAFE_MISS_CELLS[loserIdx];
    loserIdx += 1;
    await repository.applyPulseTarget(duelId, loserToken, safe.row, safe.col, testKey());
  }
  return { winnerId, winnerToken, loserToken, last: last! };
}

beforeAll(async () => {
  const probe = await cleanupClient.from("sessions").select("session_id").limit(1);
  if (probe.error) {
    throw new Error(
      `Local Supabase probe failed against ${supabaseUrl}: ${probe.error.message}. ` +
        "Is the local stack running (`npx supabase status`)?"
    );
  }
});

afterAll(async () => {
  if (createdSessionIds.length === 0) return;

  const { data: duelRows, error: duelLookupError } = await cleanupClient
    .from("duels")
    .select("duel_id")
    .in("session_id", createdSessionIds);
  if (duelLookupError) throw duelLookupError;
  const duelIds = (duelRows ?? []).map((r) => r.duel_id);

  if (duelIds.length > 0) {
    const { error: actionsError } = await cleanupClient.from("pulse_actions").delete().in("duel_id", duelIds);
    if (actionsError) throw actionsError;

    const { error: boardsError } = await cleanupClient.from("pulse_boards").delete().in("duel_id", duelIds);
    if (boardsError) throw boardsError;

    const { error: gamesError } = await cleanupClient.from("pulse_games").delete().in("duel_id", duelIds);
    if (gamesError) throw gamesError;

    const { error: pointAwardsError } = await cleanupClient.from("point_awards").delete().in("duel_id", duelIds);
    if (pointAwardsError) throw pointAwardsError;

    const { error: duelsError } = await cleanupClient.from("duels").delete().in("duel_id", duelIds);
    if (duelsError) throw duelsError;
  }

  const { error: eventsError } = await cleanupClient.from("session_events").delete().in("session_id", createdSessionIds);
  if (eventsError) throw eventsError;

  const { error: sessionsError } = await cleanupClient.from("sessions").delete().in("session_id", createdSessionIds);
  if (sessionsError) throw sessionsError;
});

describe("SupabaseSessionRepository contract — Pulse migration-created schema (0164-0172)", () => {
  it("pulse_boards, pulse_games, pulse_actions exist and are reachable", async () => {
    const boardsProbe = await cleanupClient.from("pulse_boards").select("duel_id").limit(1);
    expect(boardsProbe.error).toBeNull();
    const gamesProbe = await cleanupClient.from("pulse_games").select("duel_id").limit(1);
    expect(gamesProbe.error).toBeNull();
    const actionsProbe = await cleanupClient.from("pulse_actions").select("duel_id").limit(1);
    expect(actionsProbe.error).toBeNull();
  });

  it("duels_mechanic_key_valid_values now accepts PULSE, still rejects an out-of-vocabulary key", async () => {
    const { session, participants } = await setupPulseReadySession();
    const [a, b] = participants;
    const started = await startAPulseDuel(session, a.participantId, b.participantId);

    const { data: duelRow, error } = await cleanupClient
      .from("duels")
      .select("mechanic_key, lifecycle_state, prompt_text, options, correct_option_index")
      .eq("duel_id", started.duelId)
      .single();
    if (error) throw error;
    expect(duelRow.mechanic_key).toBe("PULSE");
    expect(duelRow.lifecycle_state).toBe("ACTIVE");
    expect(duelRow.prompt_text).toBeNull();

    const { error: badKeyError } = await cleanupClient.from("duels").insert({
      session_id: session.sessionId,
      competitor_a_participant_id: a.participantId,
      competitor_b_participant_id: b.participantId,
      mechanic_key: "CONNECT_FOUR",
    });
    expect(badKeyError).not.toBeNull();
    expect(badKeyError?.message).toMatch(/duels_mechanic_key_valid_values/);
  });

  it("start_pulse_duel_atomically creates exactly two empty pulse_boards rows and one pulse_games header row, both boards uncommitted", async () => {
    const { session, participants } = await setupPulseReadySession();
    const [a, b] = participants;
    const started = await startAPulseDuel(session, a.participantId, b.participantId);

    const boards = await repository.getPulseBoards(started.duelId);
    expect(boards).toHaveLength(2);
    expect(boards.every((board) => board.forms === null && board.committedAt === null)).toBe(true);

    const game = await repository.getPulseGame(started.duelId);
    expect(game).not.toBeNull();
    expect(game!.currentActorParticipantId).toBeNull();
    expect(game!.currentDeadline).toBeNull();
  });

  it("pulse_boards primary key (duel_id, participant_id) is enforced — a raw duplicate insert is rejected", async () => {
    const { session, participants } = await setupPulseReadySession();
    const [a, b] = participants;
    const started = await startAPulseDuel(session, a.participantId, b.participantId);

    const { error } = await cleanupClient.from("pulse_boards").insert({
      duel_id: started.duelId,
      participant_id: a.participantId,
      was_assisted: false,
    });
    expect(error).not.toBeNull();
  });

  it("pulse_actions unique(duel_id, idempotency_key) is enforced — a raw duplicate insert is rejected", async () => {
    const { session, participants } = await setupPulseReadySession();
    const [a, b] = participants;
    const started = await startAPulseDuel(session, a.participantId, b.participantId);
    const activation = await commitBoth(started.duelId, a.participantToken, b.participantToken);
    const actorToken = activation.currentActorParticipantId === a.participantId ? a.participantToken : b.participantToken;

    const key = testKey();
    await repository.applyPulseTarget(started.duelId, actorToken, 1, 7, key);

    const { error } = await cleanupClient.from("pulse_actions").insert({
      duel_id: started.duelId,
      sequence_number: 999,
      actor_participant_id: a.participantId,
      cell_row: 1,
      cell_col: 6,
      result: "MISS",
      idempotency_key: key,
    });
    expect(error).not.toBeNull();
  });
});

describe("COMMIT_SETUP against real Postgres", () => {
  it("private layouts persist correctly and are readable back through the repository", async () => {
    const { session, participants } = await setupPulseReadySession();
    const [a, b] = participants;
    const started = await startAPulseDuel(session, a.participantId, b.participantId);

    await repository.commitPulseSetup(started.duelId, a.participantToken, ALICE_FORMS, false, testKey());

    const boards = await repository.getPulseBoards(started.duelId);
    const aBoard = boards.find((board) => board.participantId === a.participantId)!;
    expect(aBoard.forms).toEqual(ALICE_FORMS);
    expect(aBoard.committedAt).not.toBeNull();

    const bBoard = boards.find((board) => board.participantId === b.participantId)!;
    expect(bBoard.forms).toBeNull();
  });

  it("mutate-then-immediate-GET returns current truth for a commit", async () => {
    const { session, participants } = await setupPulseReadySession();
    const [a, b] = participants;
    const started = await startAPulseDuel(session, a.participantId, b.participantId);

    const commitResult = await repository.commitPulseSetup(started.duelId, a.participantToken, ALICE_FORMS, false, testKey());
    const boards = await repository.getPulseBoards(started.duelId);
    const aBoard = boards.find((board) => board.participantId === a.participantId)!;
    expect(aBoard.committedAt).toBe(commitResult.committedAt);
  });

  it("simultaneous commitment: two near-simultaneous COMMIT_SETUP calls against the same duel activate exactly once", async () => {
    const { session, participants } = await setupPulseReadySession();
    const [a, b] = participants;
    const started = await startAPulseDuel(session, a.participantId, b.participantId);

    const [r1, r2] = await Promise.all([
      repository.commitPulseSetup(started.duelId, a.participantToken, ALICE_FORMS, false, testKey()),
      repository.commitPulseSetup(started.duelId, b.participantToken, BOB_FORMS, false, testKey()),
    ]);
    const activatedCount = [r1, r2].filter((r) => r.activated).length;
    expect(activatedCount).toBe(1);

    const game = await repository.getPulseGame(started.duelId);
    expect(game!.currentActorParticipantId).not.toBeNull();
    expect(game!.currentDeadline).not.toBeNull();
  });
});

describe("TARGET_CELL against real Postgres", () => {
  it("current state and action history remain coherent after a sequence of real targets", async () => {
    const { session, participants } = await setupPulseReadySession();
    const [a, b] = participants;
    const started = await startAPulseDuel(session, a.participantId, b.participantId);
    const activation = await commitBoth(started.duelId, a.participantToken, b.participantToken);
    const actorToken = activation.currentActorParticipantId === a.participantId ? a.participantToken : b.participantToken;
    const nextToken = activation.currentActorParticipantId === a.participantId ? b.participantToken : a.participantToken;

    await repository.applyPulseTarget(started.duelId, actorToken, 1, 7, testKey());
    await repository.applyPulseTarget(started.duelId, nextToken, 4, 7, testKey());

    const actions = await repository.getPulseActions(started.duelId);
    expect(actions).toHaveLength(2);
    expect(actions[0].sequenceNumber).toBe(1);
    expect(actions[1].sequenceNumber).toBe(2);

    const game = await repository.getPulseGame(started.duelId);
    expect(game!.targetCountA + game!.targetCountB).toBe(2);
  });

  it("simultaneous targets: two concurrent TARGET_CELL calls consume at most one turn (row lock serializes; the loser sees PulseNotYourTurnError)", async () => {
    const { session, participants } = await setupPulseReadySession();
    const [a, b] = participants;
    const started = await startAPulseDuel(session, a.participantId, b.participantId);
    const activation = await commitBoth(started.duelId, a.participantToken, b.participantToken);
    const actorToken = activation.currentActorParticipantId === a.participantId ? a.participantToken : b.participantToken;
    const nonActorToken = activation.currentActorParticipantId === a.participantId ? b.participantToken : a.participantToken;

    const results = await Promise.allSettled([
      repository.applyPulseTarget(started.duelId, actorToken, 1, 7, testKey()),
      repository.applyPulseTarget(started.duelId, actorToken, 4, 7, testKey()),
    ]);

    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(PulseNotYourTurnError);

    const actions = await repository.getPulseActions(started.duelId);
    expect(actions).toHaveLength(1);

    void nonActorToken;
  });

  it("target-vs-deadline race: once the deadline has passed, TARGET_CELL rejects PulseTurnExpiredError without mutating, and CLAIM_TIMEOUT resolves the FORFEIT exactly once", async () => {
    const { session, participants } = await setupPulseReadySession();
    const [a, b] = participants;
    const started = await startAPulseDuel(session, a.participantId, b.participantId);
    const activation = await commitBoth(started.duelId, a.participantToken, b.participantToken);
    const timedOutId = activation.currentActorParticipantId!;
    const timedOutToken = timedOutId === a.participantId ? a.participantToken : b.participantToken;
    const otherToken = timedOutId === a.participantId ? b.participantToken : a.participantToken;
    const otherId = timedOutId === a.participantId ? b.participantId : a.participantId;

    const { error: backdateError } = await cleanupClient
      .from("pulse_games")
      .update({ current_deadline: new Date(Date.now() - 5_000).toISOString() })
      .eq("duel_id", started.duelId);
    if (backdateError) throw backdateError;

    await expect(
      repository.applyPulseTarget(started.duelId, timedOutToken, 1, 7, testKey())
    ).rejects.toBeInstanceOf(PulseTurnExpiredError);

    const actionsAfterRejection = await repository.getPulseActions(started.duelId);
    expect(actionsAfterRejection).toHaveLength(0);

    const [claim1, claim2] = await Promise.allSettled([
      repository.claimPulseTimeout(started.duelId, otherToken),
      repository.claimPulseTimeout(started.duelId, timedOutToken),
    ]);
    expect(claim1.status).toBe("fulfilled");
    expect(claim2.status).toBe("fulfilled");
    const results = [claim1, claim2].map((r) => (r as PromiseFulfilledResult<any>).value);
    const nonCached = results.filter((r) => r.alreadyApplied === false);
    expect(nonCached).toHaveLength(1);
    expect(results.every((r) => r.terminalResolution === "FORFEIT")).toBe(true);
    expect(results.every((r) => r.winnerParticipantId === otherId)).toBe(true);

    const { data: pointAwards, error: pointAwardsError } = await cleanupClient
      .from("point_awards")
      .select("*")
      .eq("duel_id", started.duelId);
    if (pointAwardsError) throw pointAwardsError;
    expect(pointAwards).toHaveLength(1);
    expect(pointAwards![0].participant_id).toBe(otherId);
  });

  it("ordinary completion: terminal and scoring resolve exactly once; the exact completing retry returns the cached original result", async () => {
    const { session, participants } = await setupPulseReadySession();
    const [a, b] = participants;
    const started = await startAPulseDuel(session, a.participantId, b.participantId);
    await commitBoth(started.duelId, a.participantToken, b.participantToken);
    const { winnerId, winnerToken, last } = await driveToOrdinaryCompletion(
      started.duelId,
      a.participantId,
      a.participantToken,
      b.participantId,
      b.participantToken
    );
    expect(last.terminal).toBe(true);

    const { data: duelRow, error } = await cleanupClient
      .from("duels")
      .select("lifecycle_state, terminal_resolution, winner_participant_id")
      .eq("duel_id", started.duelId)
      .single();
    if (error) throw error;
    expect(duelRow.lifecycle_state).toBe("COMPLETED");
    expect(duelRow.terminal_resolution).toBe("WON_LOST");
    expect(duelRow.winner_participant_id).toBe(winnerId);

    const { data: pointAwards, error: pointAwardsError } = await cleanupClient
      .from("point_awards")
      .select("*")
      .eq("duel_id", started.duelId);
    if (pointAwardsError) throw pointAwardsError;
    expect(pointAwards).toHaveLength(1);

    // Re-derive the exact winning coordinate/key by reading the last
    // accepted action back, then retry it verbatim.
    const actions = await repository.getPulseActions(started.duelId);
    const finalAction = actions[actions.length - 1];
    const retry = await repository.applyPulseTarget(
      started.duelId,
      winnerToken,
      finalAction.row,
      finalAction.col,
      finalAction.idempotencyKey
    );
    expect(retry.alreadyApplied).toBe(true);
    expect(retry.terminal).toBe(true);
    expect(retry.winnerParticipantId).toBe(winnerId);

    const { data: pointAwardsAfterRetry, error: retryError } = await cleanupClient
      .from("point_awards")
      .select("*")
      .eq("duel_id", started.duelId);
    if (retryError) throw retryError;
    expect(pointAwardsAfterRetry).toHaveLength(1);
  });
});

describe("Session-completion vs. Pulse-mutation concurrency (UG-CR-GATE-004)", () => {
  it("racing COMPLETE_SESSION against a concurrent non-terminal TARGET_CELL against real Postgres always resolves to exactly one coherent outcome, never double-scores, and never permits a post-void mutation", async () => {
    const { session, participants } = await setupPulseReadySession();
    const [a, b] = participants;
    const started = await startAPulseDuel(session, a.participantId, b.participantId);
    const activation = await commitBoth(started.duelId, a.participantToken, b.participantToken);
    const actorToken = activation.currentActorParticipantId === a.participantId ? a.participantToken : b.participantToken;

    // A deliberately non-completing coordinate (a MISS against the fixed
    // opponent layouts used throughout this file) — the race is between
    // Session completion and an otherwise-valid, non-terminal Pulse
    // mutation, exactly as the gate specifies, not a race against a
    // duel-completing hit (already covered separately by the terminal/
    // idempotency tests above).
    const [completeResult, targetResult] = await Promise.allSettled([
      repository.completeSession(session.sessionId, session.hostToken, {
        sessionId: session.sessionId,
        eventType: "SESSION_COMPLETED",
        payload: {},
      }),
      repository.applyPulseTarget(started.duelId, actorToken, 1, 7, testKey()),
    ]);

    // Session completion is host-authoritative and never blocked by a
    // subordinate Duel's runtime state (Duel_Architecture.md's own
    // "Interaction With Session Completion" section, and 0135's own
    // migration comment) — it must always succeed here.
    expect(completeResult.status).toBe("fulfilled");

    const { data: sessionRow, error: sessionError } = await cleanupClient
      .from("sessions")
      .select("state")
      .eq("session_id", session.sessionId)
      .single();
    if (sessionError) throw sessionError;
    expect(sessionRow.state).toBe("SESSION_COMPLETE");

    const { data: duelRow, error: duelError } = await cleanupClient
      .from("duels")
      .select("lifecycle_state, terminal_resolution, winner_participant_id")
      .eq("duel_id", started.duelId)
      .single();
    if (duelError) throw duelError;
    // One coherent terminal outcome regardless of which side of the race
    // actually reached the shared `duels` row lock first: the Duel ends
    // COMPLETED/VOID either way, since the targeted coordinate is a MISS
    // (never itself terminal) and Session completion supersedes an
    // active, not-yet-finished Duel unconditionally.
    expect(duelRow.lifecycle_state).toBe("COMPLETED");
    expect(duelRow.terminal_resolution).toBe("VOID");
    expect(duelRow.winner_participant_id).toBeNull();

    // The concurrent target either lost the race (rejected because the
    // Duel was no longer ACTIVE by the time it acquired the lock) or won
    // it (applied while still ACTIVE, then superseded by VOID moments
    // later) — both are coherent; what must never happen is the target
    // silently succeeding against an already-VOIDed Duel or corrupting
    // the Duel's own terminal fields.
    if (targetResult.status === "fulfilled") {
      expect(targetResult.value.terminal).toBe(false);
    } else {
      expect((targetResult as PromiseRejectedResult).reason).toBeInstanceOf(PulseNotActiveError);
    }

    // No double scoring: VOID never awards points (mirrors CANCELLED —
    // proven in the schema-level suite above), so this must be exactly
    // zero regardless of which side of the race the target fell on.
    const { data: pointAwards, error: pointAwardsError } = await cleanupClient
      .from("point_awards")
      .select("*")
      .eq("duel_id", started.duelId);
    if (pointAwardsError) throw pointAwardsError;
    expect(pointAwards).toHaveLength(0);

    // Append-only evidence preserved: at most the one racing target
    // attempt is ever recorded, and if it is recorded it is never
    // deleted/rolled back by the Session-completion side of the race.
    const actionsAfterRace = await repository.getPulseActions(started.duelId);
    expect(actionsAfterRace.length).toBeLessThanOrEqual(1);
    if (targetResult.status === "fulfilled") {
      expect(actionsAfterRace).toHaveLength(1);
      expect(actionsAfterRace[0].result).toBe("MISS");
    }

    // No post-void mutation: a fresh TARGET_CELL attempt against the
    // now-VOIDed Duel, made strictly after the race has fully settled,
    // must be rejected — the void is not a transient state that a later
    // caller could still slip a mutation past.
    await expect(
      repository.applyPulseTarget(started.duelId, actorToken, 4, 7, testKey())
    ).rejects.toBeInstanceOf(PulseNotActiveError);
  });
});
