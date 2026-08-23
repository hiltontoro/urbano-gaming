import { describe, expect, it } from "vitest";

import { createSession } from "../lib/session/createSession";
import { setSessionCapabilities } from "../lib/session/setSessionCapabilities";
import { createSuccessorSession } from "../lib/session/createSuccessorSession";
import { joinSession } from "../lib/session/joinSession";
import { lockLobby } from "../lib/session/lockLobby";
import { startSession } from "../lib/session/startSession";
import { startQuiz } from "../lib/session/startQuiz";
import { closeQuiz } from "../lib/session/closeQuiz";
import { prepareQuestions } from "../lib/session/prepareQuestions";
import { closeSubmissions } from "../lib/session/closeSubmissions";
import { revealResults } from "../lib/session/revealResults";
import { completeSession } from "../lib/session/completeSession";
import { awardPoints } from "../lib/session/awardPoints";
import { getSession } from "../lib/session/getSession";
import { InMemorySessionRepository } from "../lib/session/db/inMemorySessionRepository";
import {
  SessionNotFoundError,
  HostTokenMismatchError,
  InvalidCapabilityKeyError,
  CapabilitiesLockedError,
  SessionCapabilitiesNotDeclaredError,
  CapabilityNotAuthorizedError,
} from "../lib/session/types";

/**
 * Session Capability Architecture v1
 * (Product/Session_Capability_Architecture.md, ADR-036).
 *
 * MULTIPLE_CHOICE is an internal Interaction Engine primitive, never a
 * Product capability — every test below authorizes TRIVIA (the ad-hoc
 * host-paced /start path) or QUIZ (the dedicated orchestration
 * pipeline) independently, proving the two are genuinely separate
 * authorizations, not two names for the same thing.
 */

describe("Session Capability Architecture v1", () => {
  describe("Creation and configuration (SET_SESSION_CAPABILITIES)", () => {
    it("a freshly created session has an empty, unlocked declared capability set", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);

      const stored = await repo.getSessionById(session.sessionId);
      expect(stored?.declaredCapabilities).toEqual([]);
    });

    it("declares OPEN_RESPONSE only", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);

      const result = await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE"]);

      expect(result.declaredCapabilities).toEqual(["OPEN_RESPONSE"]);
      expect(result.locked).toBe(false);
    });

    it("declares VOTING only", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);

      const result = await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["VOTING"]);

      expect(result.declaredCapabilities).toEqual(["VOTING"]);
    });

    it("declares TRIVIA only", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);

      const result = await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["TRIVIA"]);

      expect(result.declaredCapabilities).toEqual(["TRIVIA"]);
    });

    it("declares QUIZ only", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);

      const result = await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["QUIZ"]);

      expect(result.declaredCapabilities).toEqual(["QUIZ"]);
    });

    it("declares QUIZ + VOTING + OPEN_RESPONSE together, canonically sorted regardless of input order", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);

      const result = await setSessionCapabilities(repo, session.sessionId, session.hostToken, [
        "QUIZ",
        "OPEN_RESPONSE",
        "VOTING",
      ]);

      expect(result.declaredCapabilities).toEqual(["OPEN_RESPONSE", "QUIZ", "VOTING"]);
    });

    it("normalizes duplicate capability keys to one entry rather than rejecting", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);

      const result = await setSessionCapabilities(repo, session.sessionId, session.hostToken, [
        "QUIZ",
        "QUIZ",
        "VOTING",
      ]);

      expect(result.declaredCapabilities).toEqual(["QUIZ", "VOTING"]);
    });

    it("rejects an unsupported/unavailable capability key — MULTIPLE_CHOICE is an internal engine primitive, never a Product capability", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);

      await expect(
        setSessionCapabilities(repo, session.sessionId, session.hostToken, ["MULTIPLE_CHOICE"])
      ).rejects.toBeInstanceOf(InvalidCapabilityKeyError);
    });

    it("rejects a nonexistent capability key entirely", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);

      // Duel / SESSION_SUBGAME v1: DUEL graduated from "nonexistent" to
      // a real capability key (see duel.test.ts) — this placeholder is
      // updated to a key that genuinely does not exist, preserving the
      // original intent of this test rather than silently asserting
      // something now false.
      await expect(
        setSessionCapabilities(repo, session.sessionId, session.hostToken, [
          "NONEXISTENT_CAPABILITY",
        ])
      ).rejects.toBeInstanceOf(InvalidCapabilityKeyError);
    });

    it("an empty set is a legal declaration — clearing a prior selection before first join", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["QUIZ"]);

      const result = await setSessionCapabilities(repo, session.sessionId, session.hostToken, []);

      expect(result.declaredCapabilities).toEqual([]);
      expect(result.locked).toBe(false);
    });

    it("rejects a nonexistent session id", async () => {
      const repo = new InMemorySessionRepository();

      await expect(
        setSessionCapabilities(repo, "11111111-1111-1111-1111-111111111111", "any-token", ["QUIZ"])
      ).rejects.toBeInstanceOf(SessionNotFoundError);
    });

    it("rejects a mismatched host token", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);

      await expect(
        setSessionCapabilities(repo, session.sessionId, "wrong-token", ["QUIZ"])
      ).rejects.toBeInstanceOf(HostTokenMismatchError);
    });
  });

  describe("Pre-join mutation (freely editable before first real participant join)", () => {
    it("adds a capability before first join", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["QUIZ"]);

      const result = await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["QUIZ", "VOTING"]);

      expect(result.declaredCapabilities).toEqual(["QUIZ", "VOTING"]);
    });

    it("removes a capability before first join", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["QUIZ", "VOTING"]);

      const result = await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["QUIZ"]);

      expect(result.declaredCapabilities).toEqual(["QUIZ"]);
    });

    it("supports repeated updates before first join — the real product workflow: host realizes before anyone joins they also want Voting", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);

      await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["QUIZ"]);
      await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["QUIZ", "VOTING"]);
      const final = await setSessionCapabilities(repo, session.sessionId, session.hostToken, [
        "QUIZ",
        "VOTING",
        "OPEN_RESPONSE",
      ]);

      expect(final.declaredCapabilities).toEqual(["OPEN_RESPONSE", "QUIZ", "VOTING"]);
      expect(final.locked).toBe(false);
    });

    it("idempotent same-value redeclaration before first join succeeds without error", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["QUIZ"]);

      const result = await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["QUIZ"]);

      expect(result.declaredCapabilities).toEqual(["QUIZ"]);
      expect(result.locked).toBe(false);
    });
  });

  describe("Capability lock — first successful real participant join", () => {
    it("first participant join locks the declared set", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["QUIZ"]);
      await joinSession(repo, session.roomCode, "Alex");

      const stored = await repo.getSessionById(session.sessionId);
      const result = await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["QUIZ"]);

      expect(stored?.declaredCapabilities).toEqual(["QUIZ"]);
      expect(result.locked).toBe(true);
    });

    it("rejects a changed capability set once locked", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["QUIZ"]);
      await joinSession(repo, session.roomCode, "Alex");

      await expect(
        setSessionCapabilities(repo, session.sessionId, session.hostToken, ["VOTING"])
      ).rejects.toBeInstanceOf(CapabilitiesLockedError);

      const stored = await repo.getSessionById(session.sessionId);
      expect(stored?.declaredCapabilities).toEqual(["QUIZ"]);
    });

    it("idempotent same-value redeclaration once locked returns success, not an error", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["QUIZ", "VOTING"]);
      await joinSession(repo, session.roomCode, "Alex");

      const result = await setSessionCapabilities(repo, session.sessionId, session.hostToken, [
        "VOTING",
        "QUIZ",
      ]);

      expect(result.locked).toBe(true);
      expect(result.declaredCapabilities).toEqual(["QUIZ", "VOTING"]);
    });

    it("a second participant joining after lock does not itself change anything — the lock is evidence-existence, not participant-count", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["QUIZ"]);
      await joinSession(repo, session.roomCode, "Alex");
      await joinSession(repo, session.roomCode, "Jordan");

      await expect(
        setSessionCapabilities(repo, session.sessionId, session.hostToken, ["VOTING"])
      ).rejects.toBeInstanceOf(CapabilitiesLockedError);
    });

    it("gameplay not having started yet does not affect the lock — it is join-evidence-derived, independent of interaction/state progress", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["QUIZ"]);
      await joinSession(repo, session.roomCode, "Alex");
      // No lockLobby, no startSession — the lock already holds purely
      // from participant evidence, before any gameplay has occurred.

      await expect(
        setSessionCapabilities(repo, session.sessionId, session.hostToken, ["VOTING"])
      ).rejects.toBeInstanceOf(CapabilitiesLockedError);
    });
  });

  describe("JOIN_SESSION precondition — a session must have declared at least one capability", () => {
    it("rejects the first real participant join when nothing has been declared yet", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);

      await expect(joinSession(repo, session.roomCode, "Early")).rejects.toBeInstanceOf(
        SessionCapabilitiesNotDeclaredError
      );
    });

    it("rejects the first real participant join when the declared set was explicitly cleared to empty", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["QUIZ"]);
      await setSessionCapabilities(repo, session.sessionId, session.hostToken, []);

      await expect(joinSession(repo, session.roomCode, "Early")).rejects.toBeInstanceOf(
        SessionCapabilitiesNotDeclaredError
      );
    });

    it("succeeds once at least one capability is declared", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE"]);

      const result = await joinSession(repo, session.roomCode, "Alex");

      expect(result.displayName).toBe("Alex");
    });
  });

  describe("Command-family authorization — QUIZ and TRIVIA are distinct capabilities", () => {
    async function setupLockedSession(repo: InMemorySessionRepository, capabilities: string[]) {
      const session = await createSession(repo);
      await setSessionCapabilities(repo, session.sessionId, session.hostToken, capabilities);
      const participant = await joinSession(repo, session.roomCode, "Alex");
      await joinSession(repo, session.roomCode, "Jordan");
      await lockLobby(repo, session.sessionId, session.hostToken);
      return { session, participant };
    }

    it("QUIZ-only: Quiz preparation/start succeeds", async () => {
      const repo = new InMemorySessionRepository();
      const { session } = await setupLockedSession(repo, ["QUIZ"]);
      await prepareQuestions(repo, session.sessionId, session.hostToken, [
        { promptText: "2+2?", options: ["3", "4"], correctOptionIndex: 1, points: 10 },
      ]);

      const result = await startQuiz(repo, session.sessionId, session.hostToken, 60);
      expect(result.totalQuestions).toBe(1);
    });

    it("QUIZ-only: host-paced Trivia (ad-hoc MULTIPLE_CHOICE via /start) is rejected", async () => {
      const repo = new InMemorySessionRepository();
      const { session } = await setupLockedSession(repo, ["QUIZ"]);
      await prepareQuestions(repo, session.sessionId, session.hostToken, [
        { promptText: "2+2?", options: ["3", "4"], correctOptionIndex: 1, points: 10 },
      ]);
      const [prepared] = (await repo.getPreparedQuestionsForSession(session.sessionId));

      await expect(
        startSession(repo, session.sessionId, session.hostToken, {
          engineType: "MULTIPLE_CHOICE",
          preparedQuestionId: prepared.preparedQuestionId,
        })
      ).rejects.toBeInstanceOf(CapabilityNotAuthorizedError);
    });

    it("TRIVIA-only: host-paced Multiple Choice via /start succeeds", async () => {
      const repo = new InMemorySessionRepository();
      const { session } = await setupLockedSession(repo, ["TRIVIA"]);
      await prepareQuestions(repo, session.sessionId, session.hostToken, [
        { promptText: "2+2?", options: ["3", "4"], correctOptionIndex: 1, points: 10 },
      ]);
      const [prepared] = await repo.getPreparedQuestionsForSession(session.sessionId);

      const result = await startSession(repo, session.sessionId, session.hostToken, {
        engineType: "MULTIPLE_CHOICE",
        preparedQuestionId: prepared.preparedQuestionId,
      });
      expect(result.engineType).toBe("MULTIPLE_CHOICE");
    });

    it("TRIVIA-only: dedicated Quiz start is rejected", async () => {
      const repo = new InMemorySessionRepository();
      const { session } = await setupLockedSession(repo, ["TRIVIA"]);
      await prepareQuestions(repo, session.sessionId, session.hostToken, [
        { promptText: "2+2?", options: ["3", "4"], correctOptionIndex: 1, points: 10 },
      ]);

      await expect(
        startQuiz(repo, session.sessionId, session.hostToken, 60)
      ).rejects.toBeInstanceOf(CapabilityNotAuthorizedError);
    });

    it("VOTING-only: Voting succeeds", async () => {
      const repo = new InMemorySessionRepository();
      const { session } = await setupLockedSession(repo, ["VOTING"]);

      const result = await startSession(repo, session.sessionId, session.hostToken, {
        engineType: "VOTING",
        promptText: "Best joke?",
        candidateSource: { type: "HOST_AUTHORED", candidates: ["A", "B"] },
      });
      expect(result.engineType).toBe("VOTING");
    });

    it("VOTING-only: Open Response is rejected", async () => {
      const repo = new InMemorySessionRepository();
      const { session } = await setupLockedSession(repo, ["VOTING"]);

      await expect(
        startSession(repo, session.sessionId, session.hostToken, {
          engineType: "OPEN_RESPONSE",
          promptText: "Tell a joke",
        })
      ).rejects.toBeInstanceOf(CapabilityNotAuthorizedError);
    });

    it("OPEN_RESPONSE-only: Open Response succeeds", async () => {
      const repo = new InMemorySessionRepository();
      const { session } = await setupLockedSession(repo, ["OPEN_RESPONSE"]);

      const result = await startSession(repo, session.sessionId, session.hostToken, {
        engineType: "OPEN_RESPONSE",
        promptText: "Tell a joke",
      });
      expect(result.engineType).toBe("OPEN_RESPONSE");
    });

    it("OPEN_RESPONSE-only: Voting is rejected", async () => {
      const repo = new InMemorySessionRepository();
      const { session } = await setupLockedSession(repo, ["OPEN_RESPONSE"]);

      await expect(
        startSession(repo, session.sessionId, session.hostToken, {
          engineType: "VOTING",
          promptText: "Best joke?",
          candidateSource: { type: "HOST_AUTHORED", candidates: ["A", "B"] },
        })
      ).rejects.toBeInstanceOf(CapabilityNotAuthorizedError);
    });

    it("undeclared capability activation is rejected server-side even when attempted directly against the repository — never a UI-only boundary", async () => {
      const repo = new InMemorySessionRepository();
      const { session } = await setupLockedSession(repo, ["QUIZ"]);

      await expect(
        repo.startSession(session.sessionId, session.hostToken, {
          engineType: "OPEN_RESPONSE",
          promptText: "Bypass attempt",
        })
      ).rejects.toBeInstanceOf(CapabilityNotAuthorizedError);
    });
  });

  describe("Prepared-question authorization — Session-owned state consumed by two legitimate capabilities", () => {
    it("a Session declaring only VOTING cannot prepare questions", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["VOTING"]);

      await expect(
        prepareQuestions(repo, session.sessionId, session.hostToken, [
          { promptText: "2+2?", options: ["3", "4"], correctOptionIndex: 1, points: 10 },
        ])
      ).rejects.toBeInstanceOf(CapabilityNotAuthorizedError);

      const stored = await repo.getPreparedQuestionsForSession(session.sessionId);
      expect(stored).toHaveLength(0);
    });

    it("a Session declaring only OPEN_RESPONSE cannot prepare questions", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE"]);

      await expect(
        prepareQuestions(repo, session.sessionId, session.hostToken, [
          { promptText: "2+2?", options: ["3", "4"], correctOptionIndex: 1, points: 10 },
        ])
      ).rejects.toBeInstanceOf(CapabilityNotAuthorizedError);

      const stored = await repo.getPreparedQuestionsForSession(session.sessionId);
      expect(stored).toHaveLength(0);
    });

    it("a Session declaring only TRIVIA (no QUIZ) can prepare questions, and the ad-hoc host-paced /start path can consume one", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["TRIVIA"]);
      await joinSession(repo, session.roomCode, "Alex");
      await lockLobby(repo, session.sessionId, session.hostToken);

      const prepared = await prepareQuestions(repo, session.sessionId, session.hostToken, [
        { promptText: "2+2?", options: ["3", "4"], correctOptionIndex: 1, points: 10 },
      ]);
      expect(prepared.questions).toHaveLength(1);

      const started = await startSession(repo, session.sessionId, session.hostToken, {
        engineType: "MULTIPLE_CHOICE",
        preparedQuestionId: prepared.questions[0].preparedQuestionId,
      });
      expect(started.engineType).toBe("MULTIPLE_CHOICE");
    });

    it("a Session declaring only QUIZ (no TRIVIA) can prepare questions, and start-quiz remains functional", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["QUIZ"]);
      await joinSession(repo, session.roomCode, "Alex");
      await lockLobby(repo, session.sessionId, session.hostToken);

      const prepared = await prepareQuestions(repo, session.sessionId, session.hostToken, [
        { promptText: "2+2?", options: ["3", "4"], correctOptionIndex: 1, points: 10 },
      ]);
      expect(prepared.questions).toHaveLength(1);

      const quizResult = await startQuiz(repo, session.sessionId, session.hostToken, 60);
      expect(quizResult.totalQuestions).toBe(1);
    });

    it("a Session declaring both TRIVIA and QUIZ preserves the existing shared-pool behavior: one prepared question consumed ad-hoc via /start, the remainder later swept up by start-quiz", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["TRIVIA", "QUIZ"]);
      await joinSession(repo, session.roomCode, "Alex");
      await lockLobby(repo, session.sessionId, session.hostToken);

      const prepared = await prepareQuestions(repo, session.sessionId, session.hostToken, [
        { promptText: "Q1?", options: ["A", "B"], correctOptionIndex: 0, points: 10 },
        { promptText: "Q2?", options: ["A", "B"], correctOptionIndex: 1, points: 10 },
        { promptText: "Q3?", options: ["A", "B"], correctOptionIndex: 0, points: 10 },
      ]);
      expect(prepared.questions).toHaveLength(3);

      // Ad-hoc Trivia consumes exactly one, by explicit id.
      const triviaTurn = await startSession(repo, session.sessionId, session.hostToken, {
        engineType: "MULTIPLE_CHOICE",
        preparedQuestionId: prepared.questions[0].preparedQuestionId,
      });
      expect(triviaTurn.engineType).toBe("MULTIPLE_CHOICE");
      await closeSubmissions(repo, session.sessionId, session.hostToken);
      await revealResults(repo, session.sessionId, session.hostToken);

      // start-quiz sweeps up the two still-unconsumed questions.
      const quizResult = await startQuiz(repo, session.sessionId, session.hostToken, 60);
      expect(quizResult.totalQuestions).toBe(2);

      const allPrepared = await repo.getPreparedQuestionsForSession(session.sessionId);
      expect(allPrepared.every((q) => q.consumedAt !== null)).toBe(true);
    });

    it("undeclared-capability prepared-question authoring is rejected server-side even when attempted directly against the repository — never a UI-only boundary", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["VOTING"]);

      await expect(
        repo.createPreparedQuestions(session.sessionId, [
          { promptText: "Bypass attempt", options: ["A", "B"], correctOptionIndex: 0, pointsForCorrect: 10 },
        ])
      ).rejects.toBeInstanceOf(CapabilityNotAuthorizedError);
    });
  });

  describe("Mixed Session — every declared capability works sequentially, in one Session", () => {
    it("[QUIZ, VOTING, OPEN_RESPONSE]: Quiz, then Voting, then Open Response all succeed; undeclared TRIVIA is rejected; the Session remains active throughout, completed only by the existing host-controlled mechanism", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      await setSessionCapabilities(repo, session.sessionId, session.hostToken, [
        "QUIZ",
        "VOTING",
        "OPEN_RESPONSE",
      ]);
      await joinSession(repo, session.roomCode, "Alex");
      await joinSession(repo, session.roomCode, "Jordan");
      await lockLobby(repo, session.sessionId, session.hostToken);

      // 1. Quiz
      await prepareQuestions(repo, session.sessionId, session.hostToken, [
        { promptText: "2+2?", options: ["3", "4"], correctOptionIndex: 1, points: 10 },
      ]);
      const quizResult = await startQuiz(repo, session.sessionId, session.hostToken, 60);
      expect(quizResult.totalQuestions).toBe(1);
      await closeQuiz(repo, session.sessionId, quizResult.segmentId, session.hostToken);

      // 2. Voting (a fresh Turn — Quiz's own Segment already exists, this opens a new one)
      const votingResult = await startSession(repo, session.sessionId, session.hostToken, {
        engineType: "VOTING",
        promptText: "Best joke?",
        candidateSource: { type: "HOST_AUTHORED", candidates: ["A", "B"] },
      });
      expect(votingResult.engineType).toBe("VOTING");
      await closeSubmissions(repo, session.sessionId, session.hostToken);
      await revealResults(repo, session.sessionId, session.hostToken);

      // 3. Open Response
      const openResponseResult = await startSession(repo, session.sessionId, session.hostToken, {
        engineType: "OPEN_RESPONSE",
        promptText: "Tell a joke",
      });
      expect(openResponseResult.engineType).toBe("OPEN_RESPONSE");

      // 4. Undeclared TRIVIA rejected
      await expect(
        startSession(repo, session.sessionId, session.hostToken, {
          engineType: "MULTIPLE_CHOICE",
          preparedQuestionId: "00000000-0000-0000-0000-000000000000",
        })
      ).rejects.toBeInstanceOf(CapabilityNotAuthorizedError);

      // 5. The Session is still active — completion is the host's own,
      // separate, unrelated action; capability authorization never
      // completes a Session on its own.
      const midState = await repo.getSessionById(session.sessionId);
      expect(midState?.state).toBe("LOBBY_LOCKED");

      const completed = await completeSession(repo, session.sessionId, session.hostToken);
      expect(completed.state).toBe("SESSION_COMPLETE");
    });
  });

  describe("Read model (GET_SESSION)", () => {
    it("exposes declaredCapabilities, capabilitiesLocked, and legacyUndeclared for a freshly created, undeclared session", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);

      const result = await getSession(repo, session.sessionId, session.hostToken);

      expect(result.declaredCapabilities).toEqual([]);
      expect(result.capabilitiesLocked).toBe(false);
      expect(result.legacyUndeclared).toBe(false);
    });

    it("capabilitiesLocked becomes true the moment a real participant joins", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["QUIZ"]);
      await joinSession(repo, session.roomCode, "Alex");

      const result = await getSession(repo, session.sessionId, session.hostToken);

      expect(result.declaredCapabilities).toEqual(["QUIZ"]);
      expect(result.capabilitiesLocked).toBe(true);
    });

    it("legacyUndeclared is true for a session whose declaredCapabilities column is null — distinct from a freshly created, still-undeclared session", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      // Simulate a pre-migration row directly, bypassing the normal
      // creation path (which now always assigns []) — the only way a
      // real null row can exist is a session that predates this schema.
      repo._setDeclaredCapabilitiesForTest(session.sessionId, null);

      const result = await getSession(repo, session.sessionId, session.hostToken);

      expect(result.declaredCapabilities).toEqual([]);
      expect(result.legacyUndeclared).toBe(true);
    });
  });

  describe("Successor Session — a fresh, independent capability context, never silently inherited", () => {
    it("a successor session starts with an empty, unlocked declared capability set, regardless of the predecessor's own declaration", async () => {
      const repo = new InMemorySessionRepository();
      const predecessor = await createSession(repo);
      await setSessionCapabilities(repo, predecessor.sessionId, predecessor.hostToken, ["QUIZ", "VOTING"]);
      await joinSession(repo, predecessor.roomCode, "Alex");
      await completeSession(repo, predecessor.sessionId, predecessor.hostToken);

      const successor = await createSuccessorSession(repo, predecessor.sessionId, predecessor.hostToken);

      const stored = await repo.getSessionById(successor.sessionId);
      expect(stored?.declaredCapabilities).toEqual([]);
    });

    it("the successor must declare its own capabilities before it can accept its own first participant", async () => {
      const repo = new InMemorySessionRepository();
      const predecessor = await createSession(repo);
      await setSessionCapabilities(repo, predecessor.sessionId, predecessor.hostToken, ["QUIZ"]);
      await joinSession(repo, predecessor.roomCode, "Alex");
      await completeSession(repo, predecessor.sessionId, predecessor.hostToken);
      const successor = await createSuccessorSession(repo, predecessor.sessionId, predecessor.hostToken);

      await expect(joinSession(repo, successor.roomCode, "Sam")).rejects.toBeInstanceOf(
        SessionCapabilitiesNotDeclaredError
      );

      await setSessionCapabilities(repo, successor.sessionId, successor.hostToken, ["VOTING"]);
      const joined = await joinSession(repo, successor.roomCode, "Sam");
      expect(joined.displayName).toBe("Sam");
    });
  });

  describe("Regression — existing systems remain untouched by capability authorization", () => {
    it("Segments, standings, point_awards, and Session completion behave exactly as before, for a normally-declared Session", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      await setSessionCapabilities(repo, session.sessionId, session.hostToken, ["OPEN_RESPONSE"]);
      const alex = await joinSession(repo, session.roomCode, "Alex");
      await joinSession(repo, session.roomCode, "Jordan");
      await lockLobby(repo, session.sessionId, session.hostToken);

      const started = await startSession(repo, session.sessionId, session.hostToken, {
        engineType: "OPEN_RESPONSE",
        promptText: "Tell a joke",
      });
      await closeSubmissions(repo, session.sessionId, session.hostToken);
      await revealResults(repo, session.sessionId, session.hostToken);

      await awardPoints(
        repo,
        session.sessionId,
        session.hostToken,
        started.interactionInstanceId,
        alex.participantId,
        5,
        "regression-award-1"
      );

      const result = await getSession(repo, session.sessionId, session.hostToken);
      expect(result.standings.find((s) => s.participantId === alex.participantId)?.score).toBe(5);
      expect(result.segmentNumber).toBe(1);

      const completed = await completeSession(repo, session.sessionId, session.hostToken);
      expect(completed.state).toBe("SESSION_COMPLETE");
    });
  });
});
