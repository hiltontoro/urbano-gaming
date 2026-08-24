import { describe, expect, it } from "vitest";

import { createSession } from "../lib/session/createSession";
import { setSessionCapabilities } from "../lib/session/setSessionCapabilities";
import { joinSession } from "../lib/session/joinSession";
import { lockLobby } from "../lib/session/lockLobby";
import { completeSession } from "../lib/session/completeSession";
import { getSession } from "../lib/session/getSession";
import { startMathDuel } from "../lib/session/startMathDuel";
import { submitMathDuelAnswer } from "../lib/session/submitMathDuelAnswer";
import { resolveDuelExceptionally } from "../lib/session/resolveDuelExceptionally";
import { InMemorySessionRepository } from "../lib/session/db/inMemorySessionRepository";
import { selectMathDuelChallenges, MATH_DUEL_STANDARD_COUNT } from "../lib/session/mathDuelFixture";
import {
  DuplicateDuelCompetitorError,
  DuelCompetitorNotInSessionError,
  ActiveDuelExistsError,
  InteractionActiveError,
  DuelNotFoundError,
  DuelAccessDeniedError,
  DuelNotActiveError,
  InvalidMathDuelOrdinalError,
  InvalidMathDuelAnswerError,
} from "../lib/session/types";

/**
 * Math Duel Slice 001 (MATH_DUEL_IMPLEMENTATION_RECORD.md).
 *
 * Duel's second mechanic — a multi-challenge, independently-paced,
 * automatically-adjudicated proving mechanic, deliberately exercising
 * container properties Multiple Choice's own single-question shape
 * never had to: sequential per-participant authorization, first-write-
 * wins finality, mechanic-driven normal resolution folded into the
 * submission path itself, and mechanic-internal sudden-death phase
 * state inside the same generic Duel lifecycle.
 *
 * Deterministic fixture control: `zeroRandom` performs no shuffling at
 * all (a Fisher-Yates swap against itself is a no-op), so every test
 * below can predict the exact selected challenge sequence — and
 * therefore every correct answer — from mathDuelFixture.ts's own
 * declared array order, via the same selectMathDuelChallenges() call
 * startMathDuel() itself makes internally.
 */

const zeroRandom = () => 0;
const EXPECTED_CHALLENGES = selectMathDuelChallenges(zeroRandom);
const STANDARD = EXPECTED_CHALLENGES.slice(0, MATH_DUEL_STANDARD_COUNT);

async function setupDuelReadySession(capabilities: string[] = ["DUEL"]) {
  const repo = new InMemorySessionRepository();
  const session = await createSession(repo);
  await setSessionCapabilities(repo, session.sessionId, session.hostToken, capabilities);
  const a = await joinSession(repo, session.roomCode, "Alex");
  const b = await joinSession(repo, session.roomCode, "Blair");
  const c = await joinSession(repo, session.roomCode, "Casey");
  await lockLobby(repo, session.sessionId, session.hostToken);
  return { repo, session, a, b, c };
}

async function startAMathDuel(
  repo: InMemorySessionRepository,
  session: Awaited<ReturnType<typeof createSession>>,
  aId: string,
  bId: string
) {
  return startMathDuel(repo, session.sessionId, session.hostToken, aId, bId, zeroRandom);
}

/** Answers ordinals 1..count for one participant, each with the fixture's own correct value. */
async function answerAllCorrect(
  repo: InMemorySessionRepository,
  duelId: string,
  token: string,
  count: number
) {
  for (let i = 0; i < count; i++) {
    await submitMathDuelAnswer(repo, duelId, token, i + 1, EXPECTED_CHALLENGES[i].correctAnswer);
  }
}

/** Answers ordinals 1..count for one participant, each with a deliberately wrong value. */
async function answerAllWrong(
  repo: InMemorySessionRepository,
  duelId: string,
  token: string,
  count: number
) {
  for (let i = 0; i < count; i++) {
    await submitMathDuelAnswer(repo, duelId, token, i + 1, EXPECTED_CHALLENGES[i].correctAnswer + 1);
  }
}

describe("Math Duel Slice 001", () => {
  describe("Start", () => {
    it("creates an ACTIVE MATH_DUEL with exactly 5 persisted STANDARD challenges, plus a sudden-death supply", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const started = await startAMathDuel(repo, session, a.participantId, b.participantId);
      expect(started.mechanicKey).toBe("MATH_DUEL");
      expect(started.lifecycleState).toBe("ACTIVE");

      const challenges = await repo.getMathDuelChallenges(started.duelId);
      const standard = challenges.filter((c) => c.phase === "STANDARD");
      const suddenDeath = challenges.filter((c) => c.phase === "SUDDEN_DEATH");
      expect(standard).toHaveLength(MATH_DUEL_STANDARD_COUNT);
      expect(standard.map((c) => c.challengeOrdinal)).toEqual([1, 2, 3, 4, 5]);
      expect(suddenDeath.length).toBeGreaterThan(20);
      // No duplicate challenge content within this Duel's own set.
      expect(new Set(challenges.map((c) => c.questionText)).size).toBe(challenges.length);
    });

    it("both competitors receive the identical authoritative standard set and order", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const started = await startAMathDuel(repo, session, a.participantId, b.participantId);

      const asA = await getSession(repo, session.sessionId, a.participantToken);
      await submitMathDuelAnswer(repo, started.duelId, a.participantToken, 1, STANDARD[0].correctAnswer);
      const asB = await getSession(repo, session.sessionId, b.participantToken);

      expect(asA.activeDuel?.mathDuel?.challenges[0].questionText).toBe(STANDARD[0].questionText);
      expect(asB.activeDuel?.mathDuel?.challenges[0].questionText).toBe(STANDARD[0].questionText);
    });

    it("rejects duplicate competitors", async () => {
      const { repo, session, a } = await setupDuelReadySession();
      await expect(
        startMathDuel(repo, session.sessionId, session.hostToken, a.participantId, a.participantId)
      ).rejects.toThrow(DuplicateDuelCompetitorError);
    });

    it("rejects a competitor not in this session", async () => {
      const { repo, session, a } = await setupDuelReadySession();
      await expect(
        startMathDuel(repo, session.sessionId, session.hostToken, a.participantId, "stranger")
      ).rejects.toThrow(DuelCompetitorNotInSessionError);
    });

    it("rejects starting while a Duel is already active", async () => {
      const { repo, session, a, b, c } = await setupDuelReadySession();
      await startAMathDuel(repo, session, a.participantId, b.participantId);
      await expect(
        startMathDuel(repo, session.sessionId, session.hostToken, a.participantId, c.participantId)
      ).rejects.toThrow(ActiveDuelExistsError);
    });
  });

  describe("Sequential authorization", () => {
    it("a competitor's own view shows only their currently authorized challenge — future challenges absent from the payload", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const started = await startAMathDuel(repo, session, a.participantId, b.participantId);

      let view = await getSession(repo, session.sessionId, a.participantToken);
      expect(view.activeDuel?.mathDuel?.challenges).toHaveLength(1);
      expect(view.activeDuel?.mathDuel?.challenges[0].challengeOrdinal).toBe(1);
      expect(view.activeDuel?.mathDuel?.myProgress).toEqual({ answered: 0, total: 5 });
      // Explicit negative check: challenge 2's text must not appear anywhere in this payload.
      const serialized = JSON.stringify(view.activeDuel?.mathDuel);
      expect(serialized).not.toContain(STANDARD[1].questionText);

      await submitMathDuelAnswer(repo, started.duelId, a.participantToken, 1, STANDARD[0].correctAnswer);
      view = await getSession(repo, session.sessionId, a.participantToken);
      expect(view.activeDuel?.mathDuel?.challenges).toHaveLength(2);
      expect(view.activeDuel?.mathDuel?.challenges[1].challengeOrdinal).toBe(2);
      expect(view.activeDuel?.mathDuel?.myProgress).toEqual({ answered: 1, total: 5 });
    });

    it("reconnect derives the correct next challenge purely from persisted responses, never from client state", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const started = await startAMathDuel(repo, session, a.participantId, b.participantId);
      await submitMathDuelAnswer(repo, started.duelId, a.participantToken, 1, STANDARD[0].correctAnswer);
      await submitMathDuelAnswer(repo, started.duelId, a.participantToken, 2, STANDARD[1].correctAnswer);

      // A fresh GET_SESSION call — no client-supplied position — must
      // independently recover ordinal 3 as current.
      const view = await getSession(repo, session.sessionId, a.participantToken);
      expect(view.activeDuel?.mathDuel?.myProgress).toEqual({ answered: 2, total: 5 });
      expect(view.activeDuel?.mathDuel?.challenges.at(-1)?.challengeOrdinal).toBe(3);
    });
  });

  describe("Submission / idempotency", () => {
    it("accepts a correct answer and a wrong answer, both recorded without leaking correctness in the response", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const started = await startAMathDuel(repo, session, a.participantId, b.participantId);

      const correctResult = await submitMathDuelAnswer(
        repo,
        started.duelId,
        a.participantToken,
        1,
        STANDARD[0].correctAnswer
      );
      expect(correctResult).not.toHaveProperty("isCorrect");

      const wrongResult = await submitMathDuelAnswer(
        repo,
        started.duelId,
        b.participantToken,
        1,
        STANDARD[0].correctAnswer + 1
      );
      expect(wrongResult).not.toHaveProperty("isCorrect");

      const responses = await repo.getMathDuelResponses(started.duelId);
      expect(responses.find((r) => r.participantId === a.participantId)?.isCorrect).toBe(true);
      expect(responses.find((r) => r.participantId === b.participantId)?.isCorrect).toBe(false);
    });

    it("first successful submission is final — a second, different-valued submission for the same ordinal does not change it", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const started = await startAMathDuel(repo, session, a.participantId, b.participantId);

      await submitMathDuelAnswer(repo, started.duelId, a.participantToken, 1, STANDARD[0].correctAnswer);
      await submitMathDuelAnswer(repo, started.duelId, a.participantToken, 1, STANDARD[0].correctAnswer + 999);

      const responses = await repo.getMathDuelResponses(started.duelId);
      const mine = responses.filter((r) => r.participantId === a.participantId);
      expect(mine).toHaveLength(1);
      expect(mine[0].submittedAnswer).toBe(STANDARD[0].correctAnswer);
      expect(mine[0].isCorrect).toBe(true);
    });

    it("a retry with the identical value is idempotent — no duplicate row, same answeredAt returned", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const started = await startAMathDuel(repo, session, a.participantId, b.participantId);

      const first = await submitMathDuelAnswer(
        repo,
        started.duelId,
        a.participantToken,
        1,
        STANDARD[0].correctAnswer
      );
      const retry = await submitMathDuelAnswer(
        repo,
        started.duelId,
        a.participantToken,
        1,
        STANDARD[0].correctAnswer
      );
      expect(retry.answeredAt).toBe(first.answeredAt);

      const responses = await repo.getMathDuelResponses(started.duelId);
      expect(responses.filter((r) => r.participantId === a.participantId)).toHaveLength(1);
    });

    it("rejects a future-ordinal submission ahead of this competitor's own progress", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const started = await startAMathDuel(repo, session, a.participantId, b.participantId);

      await expect(
        submitMathDuelAnswer(repo, started.duelId, a.participantToken, 3, STANDARD[2].correctAnswer)
      ).rejects.toThrow(InvalidMathDuelOrdinalError);
    });

    it("rejects a non-integer/negative answer", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const started = await startAMathDuel(repo, session, a.participantId, b.participantId);

      await expect(
        submitMathDuelAnswer(repo, started.duelId, a.participantToken, 1, -3)
      ).rejects.toThrow(InvalidMathDuelAnswerError);
      await expect(
        submitMathDuelAnswer(repo, started.duelId, a.participantToken, 1, 1.5)
      ).rejects.toThrow(InvalidMathDuelAnswerError);
    });

    it("rejects a non-competitor's submission", async () => {
      const { repo, session, a, b, c } = await setupDuelReadySession();
      const started = await startAMathDuel(repo, session, a.participantId, b.participantId);

      await expect(
        submitMathDuelAnswer(repo, started.duelId, c.participantToken, 1, STANDARD[0].correctAnswer)
      ).rejects.toThrow(DuelAccessDeniedError);
    });

    it("rejects a submission for a Duel that is not this participant's Math Duel", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      await expect(
        submitMathDuelAnswer(repo, "does-not-exist", a.participantToken, 1, 1)
      ).rejects.toThrow(DuelNotFoundError);
    });
  });

  describe("Privacy", () => {
    it("opponent cannot see a competitor's answer or correctness before resolution", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const started = await startAMathDuel(repo, session, a.participantId, b.participantId);
      await submitMathDuelAnswer(repo, started.duelId, a.participantToken, 1, STANDARD[0].correctAnswer);

      const bView = await getSession(repo, session.sessionId, b.participantToken);
      expect(bView.activeDuel?.mathDuel?.competitorASubmittedCount).toBe(1);
      // Coarse count only — never correctness or the answer itself.
      const serialized = JSON.stringify(bView.activeDuel?.mathDuel);
      expect(serialized).not.toContain(String(STANDARD[0].correctAnswer));
    });

    it("a competitor never sees their own correctness before the Duel completes", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const started = await startAMathDuel(repo, session, a.participantId, b.participantId);
      await submitMathDuelAnswer(repo, started.duelId, a.participantToken, 1, STANDARD[0].correctAnswer);

      const view = await getSession(repo, session.sessionId, a.participantToken);
      expect(view.activeDuel?.mathDuel?.challenges[0].myCorrect).toBeNull();
    });

    it("Host sees only coarse submission counts, never correctness or answer content", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const started = await startAMathDuel(repo, session, a.participantId, b.participantId);
      await submitMathDuelAnswer(repo, started.duelId, a.participantToken, 1, STANDARD[0].correctAnswer);

      const hostView = await getSession(repo, session.sessionId, session.hostToken);
      expect(hostView.activeDuel?.mathDuel?.competitorASubmittedCount).toBe(1);
      expect(hostView.activeDuel?.mathDuel?.competitorBSubmittedCount).toBe(0);
      expect(hostView.activeDuel?.mathDuel?.challenges).toEqual([]);
      expect(hostView.activeDuel?.mathDuel?.myProgress).toBeNull();
    });

    it("spectator sees no challenge content while ACTIVE", async () => {
      const { repo, session, a, b, c } = await setupDuelReadySession();
      const started = await startAMathDuel(repo, session, a.participantId, b.participantId);
      await submitMathDuelAnswer(repo, started.duelId, a.participantToken, 1, STANDARD[0].correctAnswer);

      const spectatorView = await getSession(repo, session.sessionId, c.participantToken);
      expect(spectatorView.activeDuel?.mathDuel?.challenges).toEqual([]);
      expect(spectatorView.activeDuel?.mathDuel?.myProgress).toBeNull();
    });
  });

  describe("Normal resolution", () => {
    it("higher standard correct count wins", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const started = await startAMathDuel(repo, session, a.participantId, b.participantId);

      await answerAllCorrect(repo, started.duelId, a.participantToken, 5);
      await answerAllWrong(repo, started.duelId, b.participantToken, 5);

      const duel = await repo.getDuelById(started.duelId);
      expect(duel?.lifecycleState).toBe("COMPLETED");
      expect(duel?.terminalResolution).toBe("WON_LOST");
      expect(duel?.winnerParticipantId).toBe(a.participantId);
    });

    it("a slower-but-more-correct competitor still wins — no timing affects the outcome", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const started = await startAMathDuel(repo, session, a.participantId, b.participantId);

      // B finishes first (answers immediately) but gets fewer correct;
      // A takes longer (interleaved calls) but gets more correct.
      await submitMathDuelAnswer(repo, started.duelId, b.participantToken, 1, STANDARD[0].correctAnswer + 1);
      await submitMathDuelAnswer(repo, started.duelId, a.participantToken, 1, STANDARD[0].correctAnswer);
      for (let i = 2; i <= 5; i++) {
        await submitMathDuelAnswer(repo, started.duelId, b.participantToken, i, STANDARD[i - 1].correctAnswer + 1);
        await submitMathDuelAnswer(repo, started.duelId, a.participantToken, i, STANDARD[i - 1].correctAnswer);
      }

      const duel = await repo.getDuelById(started.duelId);
      expect(duel?.winnerParticipantId).toBe(a.participantId);
    });

    it("equal standard correct counts transition to SUDDEN_DEATH, never a fabricated result", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const started = await startAMathDuel(repo, session, a.participantId, b.participantId);

      await answerAllCorrect(repo, started.duelId, a.participantToken, 5);
      await answerAllCorrect(repo, started.duelId, b.participantToken, 5);

      const duel = await repo.getDuelById(started.duelId);
      expect(duel?.lifecycleState).toBe("ACTIVE");
      expect(duel?.terminalResolution).toBeNull();

      const view = await getSession(repo, session.sessionId, a.participantToken);
      expect(view.activeDuel?.mathDuel?.phase).toBe("SUDDEN_DEATH");
    });
  });

  describe("Independent pacing safety", () => {
    it("rejects a competitor who finishes the standard phase first from pre-answering sudden death before the opponent finishes", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const started = await startAMathDuel(repo, session, a.participantId, b.participantId);

      // A races ahead and answers all 5 standard challenges while B
      // has answered none.
      await answerAllCorrect(repo, started.duelId, a.participantToken, 5);

      const round6 = EXPECTED_CHALLENGES[5];
      await expect(
        submitMathDuelAnswer(repo, started.duelId, a.participantToken, 6, round6.correctAnswer)
      ).rejects.toThrow(InvalidMathDuelOrdinalError);

      // A's own read-model view must not show challenge 6 either — the
      // rejection isn't merely a write-side guard.
      const view = await getSession(repo, session.sessionId, a.participantToken);
      const ordinalsShown = view.activeDuel?.mathDuel?.challenges.map((c) => c.challengeOrdinal);
      expect(ordinalsShown).toEqual([1, 2, 3, 4, 5]);

      // Once B also finishes standard (tied 5-5), A's own retry now
      // succeeds — the block was genuinely about pacing, not a
      // permanent rejection.
      await answerAllCorrect(repo, started.duelId, b.participantToken, 5);
      await expect(
        submitMathDuelAnswer(repo, started.duelId, a.participantToken, 6, round6.correctAnswer)
      ).resolves.toBeDefined();
    });
  });

  describe("Sudden death", () => {
    async function reachSuddenDeath(repo: InMemorySessionRepository, duelId: string, aToken: string, bToken: string) {
      await answerAllCorrect(repo, duelId, aToken, 5);
      await answerAllCorrect(repo, duelId, bToken, 5);
    }

    it("both correct in a sudden-death round continues to the next round", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const started = await startAMathDuel(repo, session, a.participantId, b.participantId);
      await reachSuddenDeath(repo, started.duelId, a.participantToken, b.participantToken);

      const round6 = EXPECTED_CHALLENGES[5];
      await submitMathDuelAnswer(repo, started.duelId, a.participantToken, 6, round6.correctAnswer);
      await submitMathDuelAnswer(repo, started.duelId, b.participantToken, 6, round6.correctAnswer);

      const duel = await repo.getDuelById(started.duelId);
      expect(duel?.lifecycleState).toBe("ACTIVE");
      const view = await getSession(repo, session.sessionId, a.participantToken);
      expect(view.activeDuel?.mathDuel?.phase).toBe("SUDDEN_DEATH");
      expect(view.activeDuel?.mathDuel?.myProgress?.answered).toBe(6);
    });

    it("both wrong in a sudden-death round continues to the next round", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const started = await startAMathDuel(repo, session, a.participantId, b.participantId);
      await reachSuddenDeath(repo, started.duelId, a.participantToken, b.participantToken);

      const round6 = EXPECTED_CHALLENGES[5];
      await submitMathDuelAnswer(repo, started.duelId, a.participantToken, 6, round6.correctAnswer + 1);
      await submitMathDuelAnswer(repo, started.duelId, b.participantToken, 6, round6.correctAnswer + 1);

      const duel = await repo.getDuelById(started.duelId);
      expect(duel?.lifecycleState).toBe("ACTIVE");
    });

    it("exactly one correct in a sudden-death round wins the Duel immediately", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const started = await startAMathDuel(repo, session, a.participantId, b.participantId);
      await reachSuddenDeath(repo, started.duelId, a.participantToken, b.participantToken);

      const round6 = EXPECTED_CHALLENGES[5];
      await submitMathDuelAnswer(repo, started.duelId, a.participantToken, 6, round6.correctAnswer);
      await submitMathDuelAnswer(repo, started.duelId, b.participantToken, 6, round6.correctAnswer + 1);

      const duel = await repo.getDuelById(started.duelId);
      expect(duel?.lifecycleState).toBe("COMPLETED");
      expect(duel?.terminalResolution).toBe("WON_LOST");
      expect(duel?.winnerParticipantId).toBe(a.participantId);
    });

    it("continues correctly through 10 consecutive tied sudden-death rounds with no artificial cap", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const started = await startAMathDuel(repo, session, a.participantId, b.participantId);
      await reachSuddenDeath(repo, started.duelId, a.participantToken, b.participantToken);

      for (let round = 6; round <= 15; round++) {
        const challenge = EXPECTED_CHALLENGES[round - 1];
        await submitMathDuelAnswer(repo, started.duelId, a.participantToken, round, challenge.correctAnswer);
        await submitMathDuelAnswer(repo, started.duelId, b.participantToken, round, challenge.correctAnswer);
      }

      const duel = await repo.getDuelById(started.duelId);
      expect(duel?.lifecycleState).toBe("ACTIVE");
      const view = await getSession(repo, session.sessionId, a.participantToken);
      expect(view.activeDuel?.mathDuel?.myProgress?.answered).toBe(15);

      // Round 16 decides it.
      const decisive = EXPECTED_CHALLENGES[15];
      await submitMathDuelAnswer(repo, started.duelId, a.participantToken, 16, decisive.correctAnswer);
      await submitMathDuelAnswer(repo, started.duelId, b.participantToken, 16, decisive.correctAnswer + 1);

      const resolved = await repo.getDuelById(started.duelId);
      expect(resolved?.lifecycleState).toBe("COMPLETED");
      expect(resolved?.winnerParticipantId).toBe(a.participantId);
    });
  });

  describe("Terminal reveal", () => {
    it("reveals every standard challenge, both answers, and correctness only once COMPLETED — never at the STANDARD→SUDDEN_DEATH boundary", async () => {
      const { repo, session, a, b, c } = await setupDuelReadySession();
      const started = await startAMathDuel(repo, session, a.participantId, b.participantId);
      await answerAllCorrect(repo, started.duelId, a.participantToken, 5);
      await answerAllCorrect(repo, started.duelId, b.participantToken, 5);

      // Now in SUDDEN_DEATH, still ACTIVE — spectator must see nothing yet.
      const midView = await getSession(repo, session.sessionId, c.participantToken);
      expect(midView.activeDuel?.mathDuel?.challenges).toEqual([]);

      const round6 = EXPECTED_CHALLENGES[5];
      await submitMathDuelAnswer(repo, started.duelId, a.participantToken, 6, round6.correctAnswer);
      await submitMathDuelAnswer(repo, started.duelId, b.participantToken, 6, round6.correctAnswer + 1);

      const finalView = await getSession(repo, session.sessionId, c.participantToken);
      expect(finalView.duelHistory[0].lifecycleState).toBe("COMPLETED");
      const revealed = finalView.duelHistory[0].mathDuel!;
      expect(revealed.challenges).toHaveLength(6);
      expect(revealed.challenges[0].competitorAAnswer).toBe(STANDARD[0].correctAnswer);
      expect(revealed.challenges[0].competitorACorrect).toBe(true);
      expect(revealed.standardCorrectCountA).toBe(5);
      expect(revealed.standardCorrectCountB).toBe(5);
    });
  });

  describe("Session completion and exceptional resolution", () => {
    it("completing the Session while a Math Duel is active VOIDs it, preserving the partial response", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const started = await startAMathDuel(repo, session, a.participantId, b.participantId);
      await submitMathDuelAnswer(repo, started.duelId, a.participantToken, 1, STANDARD[0].correctAnswer);

      await completeSession(repo, session.sessionId, session.hostToken);

      const duel = await repo.getDuelById(started.duelId);
      expect(duel?.lifecycleState).toBe("COMPLETED");
      expect(duel?.terminalResolution).toBe("VOID");
      expect(duel?.winnerParticipantId).toBeNull();

      const responses = await repo.getMathDuelResponses(started.duelId);
      expect(responses.filter((r) => r.participantId === a.participantId)).toHaveLength(1);
      expect(responses.filter((r) => r.participantId === b.participantId)).toHaveLength(0);
    });

    it("Cancel ends a Math Duel with no winner", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const started = await startAMathDuel(repo, session, a.participantId, b.participantId);

      const resolved = await resolveDuelExceptionally(
        repo,
        started.duelId,
        session.hostToken,
        "CANCELLED",
        null
      );
      expect(resolved.terminalResolution).toBe("CANCELLED");
      expect(resolved.winnerParticipantId).toBeNull();
    });

    it("Forfeit A resolves the Duel in competitor B's favor with a reason", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const started = await startAMathDuel(repo, session, a.participantId, b.participantId);

      const resolved = await resolveDuelExceptionally(
        repo,
        started.duelId,
        session.hostToken,
        "FORFEIT_A",
        "Alex disconnected"
      );
      expect(resolved.terminalResolution).toBe("FORFEIT");
      expect(resolved.winnerParticipantId).toBe(b.participantId);
    });

    it("Forfeit B resolves the Duel in competitor A's favor with a reason", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const started = await startAMathDuel(repo, session, a.participantId, b.participantId);

      const resolved = await resolveDuelExceptionally(
        repo,
        started.duelId,
        session.hostToken,
        "FORFEIT_B",
        "Blair disconnected"
      );
      expect(resolved.terminalResolution).toBe("FORFEIT");
      expect(resolved.winnerParticipantId).toBe(a.participantId);
    });

    it("rejects submitting an answer to an already-completed Math Duel", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const started = await startAMathDuel(repo, session, a.participantId, b.participantId);
      await resolveDuelExceptionally(repo, started.duelId, session.hostToken, "VOID", null);

      await expect(
        submitMathDuelAnswer(repo, started.duelId, a.participantToken, 1, STANDARD[0].correctAnswer)
      ).rejects.toThrow(DuelNotActiveError);
    });
  });

  describe("Mutual exclusion with ordinary Session capabilities", () => {
    it("blocks starting a Math Duel while an ordinary Interaction is active", async () => {
      const { repo, session, a, b } = await setupDuelReadySession(["DUEL", "OPEN_RESPONSE"]);
      const { startSession } = await import("../lib/session/startSession");
      await startSession(repo, session.sessionId, session.hostToken, {
        engineType: "OPEN_RESPONSE",
        promptText: "An ordinary question",
      });

      await expect(
        startMathDuel(repo, session.sessionId, session.hostToken, a.participantId, b.participantId)
      ).rejects.toThrow(InteractionActiveError);
    });
  });
});
