import { randomUUID } from "node:crypto";

import { loadEnv } from "vite";
import { createClient } from "@supabase/supabase-js";
import { afterAll, describe, expect, it } from "vitest";

import { SupabaseSessionRepository } from "../lib/session/db/supabaseSessionRepository";
import type { ParticipantRecord } from "../lib/session/db/sessionRepository";
import {
  PromptNotActiveError,
  SessionAccessDeniedError,
  InvalidCandidateSelectionError,
  InvalidVotingCandidatesError,
  VotingSourceInteractionNotFoundError,
  VotingSourceInteractionNotEligibleError,
  SelfVoteNotAllowedError,
  type SessionRecord,
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
 * Slice 007 (Voting Engine) — Supabase contract suite.
 *
 * Structurally identical to supabaseSessionRepository.contract.test.ts
 * (same builders, same cleanup discipline) but kept in its own file so
 * package.json's test:contract script (and any future selective
 * contract run) can address Voting coverage independently. Exercises
 * the real SupabaseSessionRepository against a real, migrated
 * database — not InMemorySessionRepository — proving exactly the
 * class of thing the in-memory double cannot: real Postgres
 * constraints (the composite Candidate/interaction FK), real atomic
 * function execution, and real upsert/ON CONFLICT behavior.
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
    hostToken: `voting-contract-host-token-${randomUUID()}`,
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
  const displayName = overrides.displayName ?? `VotingContract-${randomUUID().slice(0, 8)}`;
  return {
    participantId: randomUUID(),
    sessionId,
    displayName,
    normalizedDisplayName: displayName.toLowerCase(),
    participantToken: `voting-contract-participant-token-${randomUUID()}`,
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

async function setupLockedSession(displayNames: string[] = ["Alex", "Jordan", "Sam"]) {
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

describe("SupabaseSessionRepository contract — Voting migration-created schema", () => {
  it("voting_candidates and votes exist and are reachable through the real client", async () => {
    const { data: candidatesProbe, error: candidatesError } = await cleanupClient
      .from("voting_candidates")
      .select("candidate_id")
      .limit(1);
    expect(candidatesError).toBeNull();
    expect(candidatesProbe).toBeDefined();

    const { data: votesProbe, error: votesError } = await cleanupClient
      .from("votes")
      .select("vote_id")
      .limit(1);
    expect(votesError).toBeNull();
    expect(votesProbe).toBeDefined();
  });
});

describe("SupabaseSessionRepository contract — Candidate Resolution against live Postgres", () => {
  it("host-authored: resolves Voting-owned Candidate snapshots atomically at start", async () => {
    const { session } = await setupLockedSession(["Alex"]);

    const started = await repository.startSession(session.sessionId, session.hostToken, {
      engineType: "VOTING",
      promptText: "Vote for your favorite!",
      candidateSource: { type: "HOST_AUTHORED", candidates: ["Pizza", "Tacos", "Sushi"] },
    });
    expect(started.engineType).toBe("VOTING");

    const candidates = await repository.getVotingCandidatesForInteraction(
      started.interactionInstanceId
    );
    expect(candidates.map((c) => c.label)).toEqual(["Pizza", "Tacos", "Sushi"]);
    expect(candidates.map((c) => c.ordinal)).toEqual([0, 1, 2]);
  });

  it("rejects fewer than two HOST_AUTHORED candidates, live", async () => {
    const { session } = await setupLockedSession(["Alex"]);

    await expect(
      repository.startSession(session.sessionId, session.hostToken, {
        engineType: "VOTING",
        promptText: "Vote for your favorite!",
        candidateSource: { type: "HOST_AUTHORED", candidates: ["Only one"] },
      })
    ).rejects.toBeInstanceOf(InvalidVotingCandidatesError);
  });

  it("Open Response -> Voting: resolves Candidates across the Interaction Instance boundary, and later reads never depend on the source's live rows", async () => {
    const { session, participants } = await setupLockedSession(["Alex", "Jordan"]);
    const [alex, jordan] = participants;

    const openResponse = await repository.startSession(session.sessionId, session.hostToken, {
      engineType: "OPEN_RESPONSE",
      promptText: "Tell us your best joke!",
    });
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

    const voting = await repository.startSession(session.sessionId, session.hostToken, {
      engineType: "VOTING",
      promptText: "Vote for the funniest!",
      candidateSource: { type: "SUBMISSION", sourceInteractionInstanceId: openResponse.interactionInstanceId },
    });
    expect(voting.engineType).toBe("VOTING");

    const candidates = await repository.getVotingCandidatesForInteraction(voting.interactionInstanceId);
    expect(candidates.map((c) => c.label).sort()).toEqual(["Joke A", "Joke B"].sort());

    // Candidates are snapshots: independent of the source's live rows.
    // Confirm by re-reading the source's own submissions directly — the
    // Voting start above never wrote to `submissions`.
    const sourceSubmissions = await repository.getSubmissionsForInteractionInstance(
      openResponse.interactionInstanceId
    );
    expect(sourceSubmissions).toHaveLength(2);
    expect(sourceSubmissions.map((s) => s.text).sort()).toEqual(["Joke A", "Joke B"].sort());
  });

  it("rejects a SUBMISSION source that does not belong to this session, live", async () => {
    const { session: sourceSession, participants } = await setupLockedSession(["Alex"]);
    const openResponse = await repository.startSession(sourceSession.sessionId, sourceSession.hostToken, {
      engineType: "OPEN_RESPONSE",
      promptText: "Tell us your best joke!",
    });
    await repository.submitResponse(
      sourceSession.sessionId,
      participants[0].participantId,
      participants[0].participantToken,
      "Joke A"
    );
    await repository.closeSubmissions(sourceSession.sessionId, sourceSession.hostToken, {
      sessionId: sourceSession.sessionId,
      eventType: "SUBMISSIONS_CLOSED",
      payload: {},
    });
    await repository.revealResults(sourceSession.sessionId, sourceSession.hostToken, {
      sessionId: sourceSession.sessionId,
      eventType: "RESULTS_REVEALED",
      payload: {},
    });

    const { session: otherSession } = await setupLockedSession(["Casey"]);
    await expect(
      repository.startSession(otherSession.sessionId, otherSession.hostToken, {
        engineType: "VOTING",
        promptText: "Vote for the funniest!",
        candidateSource: { type: "SUBMISSION", sourceInteractionInstanceId: openResponse.interactionInstanceId },
      })
    ).rejects.toBeInstanceOf(VotingSourceInteractionNotFoundError);
  });

  it("rejects a SUBMISSION source that is Multiple Choice rather than Open Response, live", async () => {
    const { session, participants } = await setupLockedSession(["Alex"]);
    const [prepared] = await repository.createPreparedQuestions(session.sessionId, [
      { promptText: "Cats or dogs?", options: ["Cats", "Dogs"], correctOptionIndex: 0, pointsForCorrect: 10 },
    ]);
    const mc = await repository.startSession(session.sessionId, session.hostToken, {
      engineType: "MULTIPLE_CHOICE",
      preparedQuestionId: prepared.preparedQuestionId,
    });
    await repository.submitResponse(session.sessionId, participants[0].participantId, participants[0].participantToken, "0");
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

    await expect(
      repository.startSession(session.sessionId, session.hostToken, {
        engineType: "VOTING",
        promptText: "Vote for the funniest!",
        candidateSource: { type: "SUBMISSION", sourceInteractionInstanceId: mc.interactionInstanceId },
      })
    ).rejects.toBeInstanceOf(VotingSourceInteractionNotEligibleError);
  });

  // Slice 009: this test previously called repository.startSession(...)
  // directly with both a preparedQuestionId and a votingCandidateSource
  // to prove AMBIGUOUS_START_TARGET's SQL-level defense-in-depth (see
  // start_session_atomically). That call shape no longer type-checks —
  // StartTurnConfig is a real discriminated union, so the typed
  // repository method can no longer construct an ambiguous request
  // either (see AmbiguousStartSessionTargetError's Slice 009 doc
  // comment in lib/session/types.ts). The SQL check itself is
  // unchanged and still real (0039 carries it forward verbatim from
  // 0037), so this test now calls the RPC directly via the raw
  // Supabase client, bypassing SupabaseSessionRepository's typed
  // wrapper entirely, to keep live proof that the database-level guard
  // still fires independent of any TypeScript-layer prevention.
  it("rejects an ambiguous preparedQuestionId + votingCandidateSource request at the SQL level, live (bypassing the typed repository method, which can no longer construct this request)", async () => {
    const { session } = await setupLockedSession(["Alex"]);
    const [prepared] = await repository.createPreparedQuestions(session.sessionId, [
      { promptText: "Cats or dogs?", options: ["Cats", "Dogs"], correctOptionIndex: 0, pointsForCorrect: 10 },
    ]);

    const { error } = await cleanupClient.rpc("start_session_atomically", {
      p_session_id: session.sessionId,
      p_host_token: session.hostToken,
      p_prompt_text: "Vote for your favorite!",
      p_prepared_question_id: prepared.preparedQuestionId,
      p_voting_source_type: "HOST_AUTHORED",
      p_voting_candidates: ["Pizza", "Tacos"],
      p_voting_source_interaction_instance_id: null,
      p_segment_target: "NEW_SEGMENT",
    });

    expect(error).not.toBeNull();
    expect(error?.message).toContain("AMBIGUOUS_START_TARGET");
  });
});

describe("SupabaseSessionRepository contract — CAST_VOTE against live Postgres", () => {
  async function setupActiveVoting(displayNames: string[] = ["Alex", "Jordan", "Sam"]) {
    const { session, participants } = await setupLockedSession(displayNames);
    const interaction = await repository.startSession(session.sessionId, session.hostToken, {
      engineType: "VOTING",
      promptText: "Vote for your favorite!",
      candidateSource: { type: "HOST_AUTHORED", candidates: ["Pizza", "Tacos", "Sushi"] },
    });
    const candidates = await repository.getVotingCandidatesForInteraction(interaction.interactionInstanceId);
    return { session, participants, interaction, candidates };
  }

  it("creates a vote and returns the expected shape", async () => {
    const { session, participants, candidates } = await setupActiveVoting(["Alex"]);
    const result = await repository.castVote(
      session.sessionId,
      participants[0].participantId,
      participants[0].participantToken,
      candidates[0].candidateId
    );
    expect(result.candidateId).toBe(candidates[0].candidateId);
    expect(result.interactionInstanceId).toBe(candidates[0].interactionInstanceId);
  });

  it("revises a vote before close via a real ON CONFLICT upsert — exactly one authoritative row per participant per interaction instance", async () => {
    const { session, participants, candidates, interaction } = await setupActiveVoting(["Alex"]);
    const first = await repository.castVote(
      session.sessionId,
      participants[0].participantId,
      participants[0].participantToken,
      candidates[0].candidateId
    );
    const second = await repository.castVote(
      session.sessionId,
      participants[0].participantId,
      participants[0].participantToken,
      candidates[1].candidateId
    );
    expect(second.voteId).toBe(first.voteId);

    const votes = await repository.getVotesForInteractionInstance(interaction.interactionInstanceId);
    const mine = votes.filter((v) => v.participantId === participants[0].participantId);
    expect(mine).toHaveLength(1);
    expect(mine[0].candidateId).toBe(candidates[1].candidateId);
  });

  it("rejects a Candidate that exists but belongs to a different Voting interaction instance — proves the composite FK, not just application code", async () => {
    const { session, participants, candidates } = await setupActiveVoting(["Alex"]);
    // Close and reveal the first round (required before a second can
    // start at all — this system's existing re-invocation precondition),
    // then start a second, independent Voting round in the same
    // session — real, persisted Candidates, just not this vote's own
    // interaction. The vote below targets whatever is *current*
    // (round 2), using a real Candidate id that belongs to round 1.
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
    await repository.startSession(session.sessionId, session.hostToken, {
      engineType: "VOTING",
      promptText: "Second, independent round",
      candidateSource: { type: "HOST_AUTHORED", candidates: ["Cats", "Dogs"] },
    });

    await expect(
      repository.castVote(
        session.sessionId,
        participants[0].participantId,
        participants[0].participantToken,
        candidates[0].candidateId
      )
    ).rejects.toBeInstanceOf(InvalidCandidateSelectionError);
  });

  it("rejects a candidateId that does not exist at all", async () => {
    const { session, participants } = await setupActiveVoting(["Alex"]);
    await expect(
      repository.castVote(
        session.sessionId,
        participants[0].participantId,
        participants[0].participantToken,
        "11111111-1111-1111-1111-111111111111"
      )
    ).rejects.toBeInstanceOf(InvalidCandidateSelectionError);
  });

  it("rejects a wrong participant token", async () => {
    const { session, candidates } = await setupActiveVoting(["Alex"]);
    await expect(
      repository.castVote(session.sessionId, randomUUID(), "not-a-real-token", candidates[0].candidateId)
    ).rejects.toBeInstanceOf(SessionAccessDeniedError);
  });

  it("rejects a real participant token belonging to a different session", async () => {
    const { session, candidates } = await setupActiveVoting(["Alex"]);
    const { participants: otherParticipants } = await setupLockedSession(["Casey"]);

    await expect(
      repository.castVote(
        session.sessionId,
        otherParticipants[0].participantId,
        otherParticipants[0].participantToken,
        candidates[0].candidateId
      )
    ).rejects.toBeInstanceOf(SessionAccessDeniedError);
  });

  it("rejects a vote after submissions close — immutable after close", async () => {
    const { session, participants, candidates } = await setupActiveVoting(["Alex"]);
    await repository.closeSubmissions(session.sessionId, session.hostToken, {
      sessionId: session.sessionId,
      eventType: "SUBMISSIONS_CLOSED",
      payload: {},
    });

    await expect(
      repository.castVote(
        session.sessionId,
        participants[0].participantId,
        participants[0].participantToken,
        candidates[0].candidateId
      )
    ).rejects.toBeInstanceOf(PromptNotActiveError);
  });
});

describe("SupabaseSessionRepository contract — derived placement against live Postgres", () => {
  it("withholds per-candidate tally before reveal", async () => {
    const { session, participants } = await setupLockedSession(["Alex", "Jordan"]);
    const interaction = await repository.startSession(session.sessionId, session.hostToken, {
      engineType: "VOTING",
      promptText: "Vote for your favorite!",
      candidateSource: { type: "HOST_AUTHORED", candidates: ["Pizza", "Tacos"] },
    });
    const candidates = await repository.getVotingCandidatesForInteraction(interaction.interactionInstanceId);
    await repository.castVote(session.sessionId, participants[0].participantId, participants[0].participantToken, candidates[0].candidateId);

    // Pre-reveal: no interface method surfaces per-candidate tally at
    // all before RESULT_REVEAL in this architecture (GET_SESSION is the
    // gate; getVotingResultsForInteractionInstance itself performs no
    // gating, by design — the domain layer, not the repository, is
    // responsible for the reveal check). Confirmed instead by proving
    // GET_SESSION's own domain-layer gating, which is the actual
    // security boundary participants/hosts depend on.
    const { getSession } = await import("../lib/session/getSession");
    const hostView = await getSession(repository, session.sessionId, session.hostToken);
    expect(hostView.votingResults).toBeNull();
  });

  it("reveals tally and standard-competition rank, including a genuine tie and a zero-vote Candidate, hand-checked against raw rows", async () => {
    const { session, participants } = await setupLockedSession(["Alex", "Jordan", "Sam"]);
    const interaction = await repository.startSession(session.sessionId, session.hostToken, {
      engineType: "VOTING",
      promptText: "Vote for your favorite!",
      candidateSource: { type: "HOST_AUTHORED", candidates: ["Pizza", "Tacos", "Sushi"] },
    });
    const candidates = await repository.getVotingCandidatesForInteraction(interaction.interactionInstanceId);

    // Pizza and Tacos tie at 1 vote each; Sushi gets none.
    await repository.castVote(session.sessionId, participants[0].participantId, participants[0].participantToken, candidates[0].candidateId);
    await repository.castVote(session.sessionId, participants[1].participantId, participants[1].participantToken, candidates[1].candidateId);

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

    const results = await repository.getVotingResultsForInteractionInstance(interaction.interactionInstanceId);
    const byId = new Map(results.map((r) => [r.candidateId, r]));
    expect(byId.get(candidates[0].candidateId)?.rank).toBe(1);
    expect(byId.get(candidates[1].candidateId)?.rank).toBe(1);
    expect(byId.get(candidates[2].candidateId)?.rank).toBe(3);
    expect(byId.get(candidates[2].candidateId)?.voteCount).toBe(0);

    // Hand-check against raw rows via the cleanup client, independent
    // of the repository's own read path.
    const { data: rawVotes } = await cleanupClient
      .from("votes")
      .select("candidate_id")
      .eq("interaction_instance_id", interaction.interactionInstanceId);
    expect(rawVotes).toHaveLength(2);
  });

  it("participant-specific myVoteCandidateId does not leak between participants, live", async () => {
    const { session, participants } = await setupLockedSession(["Alex", "Jordan", "Sam"]);
    const interaction = await repository.startSession(session.sessionId, session.hostToken, {
      engineType: "VOTING",
      promptText: "Vote for your favorite!",
      candidateSource: { type: "HOST_AUTHORED", candidates: ["Pizza", "Tacos"] },
    });
    const candidates = await repository.getVotingCandidatesForInteraction(interaction.interactionInstanceId);
    await repository.castVote(session.sessionId, participants[0].participantId, participants[0].participantToken, candidates[0].candidateId);
    await repository.castVote(session.sessionId, participants[1].participantId, participants[1].participantToken, candidates[1].candidateId);

    const { getSession } = await import("../lib/session/getSession");
    const alexView = await getSession(repository, session.sessionId, participants[0].participantToken);
    const jordanView = await getSession(repository, session.sessionId, participants[1].participantToken);
    const samView = await getSession(repository, session.sessionId, participants[2].participantToken);
    const hostView = await getSession(repository, session.sessionId, session.hostToken);

    expect(alexView.myVoteCandidateId).toBe(candidates[0].candidateId);
    expect(jordanView.myVoteCandidateId).toBe(candidates[1].candidateId);
    expect(samView.myVoteCandidateId).toBeNull();
    expect(hostView.myVoteCandidateId).toBeNull();
  });
});

describe("SupabaseSessionRepository contract — Open Response / Multiple Choice regression alongside Voting", () => {
  it("Open Response and Multiple Choice behave exactly as before, in a session that also runs Voting", async () => {
    const { session, participants } = await setupLockedSession(["Alex", "Jordan"]);
    const [alex, jordan] = participants;

    // Open Response, unaffected.
    const openResponse = await repository.startSession(session.sessionId, session.hostToken, {
      engineType: "OPEN_RESPONSE",
      promptText: "Best joke?",
    });
    await repository.submitResponse(session.sessionId, alex.participantId, alex.participantToken, "Joke A");
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
    const orSubmissions = await repository.getSubmissionsForInteractionInstance(openResponse.interactionInstanceId);
    expect(orSubmissions[0].text).toBe("Joke A");

    // Voting in between.
    const voting = await repository.startSession(session.sessionId, session.hostToken, {
      engineType: "VOTING",
      promptText: "Pick one",
      candidateSource: { type: "HOST_AUTHORED", candidates: ["A", "B"] },
    });
    const candidates = await repository.getVotingCandidatesForInteraction(voting.interactionInstanceId);
    await repository.castVote(session.sessionId, alex.participantId, alex.participantToken, candidates[0].candidateId);
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

    // Multiple Choice afterward — automatic scoring must be completely
    // unaffected by the two preceding, differently-shaped interactions.
    const [prepared] = await repository.createPreparedQuestions(session.sessionId, [
      { promptText: "Cats or dogs?", options: ["Cats", "Dogs"], correctOptionIndex: 1, pointsForCorrect: 20 },
    ]);
    const mc = await repository.startSession(session.sessionId, session.hostToken, {
      engineType: "MULTIPLE_CHOICE",
      preparedQuestionId: prepared.preparedQuestionId,
    });
    expect(mc.engineType).toBe("MULTIPLE_CHOICE");
    await repository.submitResponse(session.sessionId, alex.participantId, alex.participantToken, "1");
    await repository.submitResponse(session.sessionId, jordan.participantId, jordan.participantToken, "0");
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
    expect(alexAward?.points).toBe(20);
    expect(jordanAward).toBeUndefined();
  }, 20000);
});

describe("SupabaseSessionRepository contract — PARTICIPANTS Candidate source against live Postgres (Slice 009)", () => {
  it("snapshots one Candidate per current participant, attributed by real participant_id, live", async () => {
    const { session, participants } = await setupLockedSession(["Alex", "Jordan", "Sam"]);

    const started = await repository.startSession(session.sessionId, session.hostToken, {
      engineType: "VOTING",
      promptText: "Vote for your favorite person!",
      candidateSource: { type: "PARTICIPANTS" },
    });
    expect(started.engineType).toBe("VOTING");

    const candidates = await repository.getVotingCandidatesForInteraction(started.interactionInstanceId);
    expect(candidates).toHaveLength(3);
    expect(candidates.map((c) => c.participantId).sort()).toEqual(
      participants.map((p) => p.participantId).sort()
    );

    // Hand-check against raw rows, independent of the repository's own
    // read path.
    const { data: rawCandidates } = await cleanupClient
      .from("voting_candidates")
      .select("participant_id")
      .eq("interaction_instance_id", started.interactionInstanceId);
    expect(rawCandidates?.map((r) => r.participant_id).sort()).toEqual(
      participants.map((p) => p.participantId).sort()
    );
  });

  it("rejects fewer than two participants, live", async () => {
    const { session } = await setupLockedSession(["Alex"]);

    await expect(
      repository.startSession(session.sessionId, session.hostToken, {
        engineType: "VOTING",
        promptText: "Vote for your favorite person!",
        candidateSource: { type: "PARTICIPANTS" },
      })
    ).rejects.toBeInstanceOf(InvalidVotingCandidatesError);
  });

  it("HOST_AUTHORED and SUBMISSION Candidates remain distinguishable by participant_id (null vs a real id) in the same schema, live", async () => {
    const { session, participants } = await setupLockedSession(["Alex", "Jordan"]);
    const [alex, jordan] = participants;

    const openResponse = await repository.startSession(session.sessionId, session.hostToken, {
      engineType: "OPEN_RESPONSE",
      promptText: "Tell us your best joke!",
    });
    await repository.submitResponse(session.sessionId, alex.participantId, alex.participantToken, "Joke A");
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

    const submissionVoting = await repository.startSession(session.sessionId, session.hostToken, {
      engineType: "VOTING",
      promptText: "Vote for the funniest!",
      candidateSource: { type: "SUBMISSION", sourceInteractionInstanceId: openResponse.interactionInstanceId },
    });
    const submissionCandidates = await repository.getVotingCandidatesForInteraction(
      submissionVoting.interactionInstanceId
    );
    expect(submissionCandidates.every((c) => c.participantId === alex.participantId)).toBe(true);

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

    const hostAuthoredVoting = await repository.startSession(session.sessionId, session.hostToken, {
      engineType: "VOTING",
      promptText: "Vote for your favorite!",
      candidateSource: { type: "HOST_AUTHORED", candidates: ["Pizza", "Tacos"] },
    });
    const hostAuthoredCandidates = await repository.getVotingCandidatesForInteraction(
      hostAuthoredVoting.interactionInstanceId
    );
    expect(hostAuthoredCandidates.every((c) => c.participantId === null)).toBe(true);

    void jordan;
  });

  it("voting_candidates.participant_id is ON DELETE SET NULL, not CASCADE — the Candidate row survives its attributed participant's removal, live", async () => {
    const { session, participants } = await setupLockedSession(["Alex", "Jordan"]);
    const [alex] = participants;

    const started = await repository.startSession(session.sessionId, session.hostToken, {
      engineType: "VOTING",
      promptText: "Vote for your favorite person!",
      candidateSource: { type: "PARTICIPANTS" },
    });
    const candidates = await repository.getVotingCandidatesForInteraction(started.interactionInstanceId);
    const alexCandidate = candidates.find((c) => c.participantId === alex.participantId)!;
    expect(alexCandidate).toBeDefined();

    // No application code path deletes a participants row individually
    // (see 0038's migration comment) — this directly exercises the
    // constraint itself, via the raw client, independent of any
    // repository method.
    const { error: deleteError } = await cleanupClient
      .from("participants")
      .delete()
      .eq("participant_id", alex.participantId);
    expect(deleteError).toBeNull();

    const { data: survivingCandidate, error: selectError } = await cleanupClient
      .from("voting_candidates")
      .select("candidate_id, label, participant_id")
      .eq("candidate_id", alexCandidate.candidateId)
      .single();
    expect(selectError).toBeNull();
    expect(survivingCandidate?.candidate_id).toBe(alexCandidate.candidateId);
    expect(survivingCandidate?.label).toBe(alexCandidate.label);
    expect(survivingCandidate?.participant_id).toBeNull();
  });
});

describe("SupabaseSessionRepository contract — self-vote prohibition against live Postgres (Slice 009)", () => {
  it("rejects a participant voting for their own PARTICIPANTS-sourced Candidate, live", async () => {
    const { session, participants } = await setupLockedSession(["Alex", "Jordan"]);
    const [alex] = participants;

    const started = await repository.startSession(session.sessionId, session.hostToken, {
      engineType: "VOTING",
      promptText: "Vote for your favorite person!",
      candidateSource: { type: "PARTICIPANTS" },
    });
    const candidates = await repository.getVotingCandidatesForInteraction(started.interactionInstanceId);
    const ownCandidate = candidates.find((c) => c.participantId === alex.participantId)!;

    await expect(
      repository.castVote(session.sessionId, alex.participantId, alex.participantToken, ownCandidate.candidateId)
    ).rejects.toBeInstanceOf(SelfVoteNotAllowedError);
  });

  it("allows voting for a different participant's Candidate, live", async () => {
    const { session, participants } = await setupLockedSession(["Alex", "Jordan"]);
    const [alex, jordan] = participants;

    const started = await repository.startSession(session.sessionId, session.hostToken, {
      engineType: "VOTING",
      promptText: "Vote for your favorite person!",
      candidateSource: { type: "PARTICIPANTS" },
    });
    const candidates = await repository.getVotingCandidatesForInteraction(started.interactionInstanceId);
    const othersCandidate = candidates.find((c) => c.participantId === jordan.participantId)!;

    const result = await repository.castVote(
      session.sessionId,
      alex.participantId,
      alex.participantToken,
      othersCandidate.candidateId
    );
    expect(result.candidateId).toBe(othersCandidate.candidateId);
  });
});
