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
import {
  selectMathDuelChallenges,
  generateSuddenDeathChallenge,
  MATH_DUEL_STANDARD_COUNT,
} from "../lib/session/mathDuelFixture";
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
 * Math Duel Slice 001 (MATH_DUEL_IMPLEMENTATION_RECORD.md), corrected
 * by the Pre-Deployment Product-Invariant Correction gate.
 *
 * Two confirmed defects in the original implementation drove this
 * rewrite: (Issue A) a pre-materialized, finite 25-round sudden-death
 * reserve was a real functional cap, contradicting the Founder-
 * confirmed "no round cap" requirement; (Issue B) history evidence
 * based on "a response exists" could not distinguish a challenge
 * genuinely shown to competitors and then cut short by an exceptional
 * termination from one that was never part of the Duel at all. Lazy
 * sudden-death creation (row existence = activation, for that phase)
 * plus an explicit activated_at signal (for the STANDARD phase's own
 * pre-created-but-not-yet-reached ordinals) resolve both together.
 *
 * Deterministic fixture control: `zeroRandom` performs no shuffling at
 * all (a Fisher-Yates swap against itself is a no-op), so every test
 * below can predict the exact selected STANDARD sequence from
 * mathDuelFixture.ts's own declared array order. Sudden-death content
 * is no longer part of that shuffle — it comes from
 * generateSuddenDeathChallenge(duelId, ordinal), a pure function of
 * its two inputs, so tests compute the exact same content the
 * production code path will independently compute for any given Duel
 * and ordinal.
 */

const zeroRandom = () => 0;
const STANDARD = selectMathDuelChallenges(zeroRandom);

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
    await submitMathDuelAnswer(repo, duelId, token, i + 1, STANDARD[i].correctAnswer);
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
    await submitMathDuelAnswer(repo, duelId, token, i + 1, STANDARD[i].correctAnswer + 1);
  }
}

/** The deterministic content one specific sudden-death ordinal will have for this Duel. */
function suddenDeathContent(duelId: string, ordinal: number) {
  return generateSuddenDeathChallenge(duelId, ordinal);
}

describe("Math Duel Slice 001", () => {
  describe("Start", () => {
    it("creates an ACTIVE MATH_DUEL with exactly 5 persisted STANDARD challenges — no sudden-death rows pre-materialized", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const started = await startAMathDuel(repo, session, a.participantId, b.participantId);
      expect(started.mechanicKey).toBe("MATH_DUEL");
      expect(started.lifecycleState).toBe("ACTIVE");

      const challenges = await repo.getMathDuelChallenges(started.duelId);
      expect(challenges).toHaveLength(5);
      expect(challenges.every((c) => c.phase === "STANDARD")).toBe(true);
      expect(challenges.map((c) => c.challengeOrdinal)).toEqual([1, 2, 3, 4, 5]);
      // Ordinal 1 is activated immediately (authorized to both from the
      // instant the Duel starts); ordinals 2-5 are not yet activated —
      // nobody has been authorized into them yet.
      expect(challenges[0].activatedAt).not.toBeNull();
      expect(challenges.slice(1).every((c) => c.activatedAt === null)).toBe(true);
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

    it("equal standard correct counts transition to SUDDEN_DEATH, never a fabricated result — and lazily creates exactly one round 6", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const started = await startAMathDuel(repo, session, a.participantId, b.participantId);

      await answerAllCorrect(repo, started.duelId, a.participantToken, 5);
      await answerAllCorrect(repo, started.duelId, b.participantToken, 5);

      const duel = await repo.getDuelById(started.duelId);
      expect(duel?.lifecycleState).toBe("ACTIVE");
      expect(duel?.terminalResolution).toBeNull();

      const view = await getSession(repo, session.sessionId, a.participantToken);
      expect(view.activeDuel?.mathDuel?.phase).toBe("SUDDEN_DEATH");

      // Issue A's fix, proven at the point of creation: round 6 exists,
      // was created lazily (not pre-materialized at start — see the
      // "Start" describe block above), and matches the same
      // deterministic content the domain layer will independently
      // compute for this exact (duelId, ordinal) pair.
      const challenges = await repo.getMathDuelChallenges(started.duelId);
      expect(challenges).toHaveLength(6);
      const round6 = challenges[5];
      expect(round6.phase).toBe("SUDDEN_DEATH");
      expect(round6.questionText).toBe(suddenDeathContent(started.duelId, 6).questionText);
      expect(round6.activatedAt).not.toBeNull();
    });
  });

  describe("Independent pacing safety", () => {
    it("rejects a competitor who finishes the standard phase first from pre-answering sudden death before the opponent finishes", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const started = await startAMathDuel(repo, session, a.participantId, b.participantId);

      // A races ahead and answers all 5 standard challenges while B
      // has answered none. Under lazy creation, round 6 does not exist
      // at all yet at this point (nobody has tied the standard phase),
      // so this exercises the "not yet authorized" guard on a
      // genuinely nonexistent row, not merely an unauthorized one.
      await answerAllCorrect(repo, started.duelId, a.participantToken, 5);

      const round6 = suddenDeathContent(started.duelId, 6);
      await expect(
        submitMathDuelAnswer(repo, started.duelId, a.participantToken, 6, round6.correctAnswer)
      ).rejects.toThrow(InvalidMathDuelOrdinalError);

      // A's own read-model view must not show challenge 6 either — the
      // rejection isn't merely a write-side guard.
      const view = await getSession(repo, session.sessionId, a.participantToken);
      const ordinalsShown = view.activeDuel?.mathDuel?.challenges.map((c) => c.challengeOrdinal);
      expect(ordinalsShown).toEqual([1, 2, 3, 4, 5]);

      // Once B also finishes standard (tied 5-5), round 6 gets created
      // and A's own retry now succeeds — the block was genuinely about
      // pacing, not a permanent rejection.
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

      const round6 = suddenDeathContent(started.duelId, 6);
      await submitMathDuelAnswer(repo, started.duelId, a.participantToken, 6, round6.correctAnswer);
      await submitMathDuelAnswer(repo, started.duelId, b.participantToken, 6, round6.correctAnswer);

      const duel = await repo.getDuelById(started.duelId);
      expect(duel?.lifecycleState).toBe("ACTIVE");
      const view = await getSession(repo, session.sessionId, a.participantToken);
      expect(view.activeDuel?.mathDuel?.phase).toBe("SUDDEN_DEATH");
      expect(view.activeDuel?.mathDuel?.myProgress?.answered).toBe(6);

      // Round 7 was lazily created by the tie at round 6.
      const challenges = await repo.getMathDuelChallenges(started.duelId);
      expect(challenges).toHaveLength(7);
    });

    it("both wrong in a sudden-death round continues to the next round", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const started = await startAMathDuel(repo, session, a.participantId, b.participantId);
      await reachSuddenDeath(repo, started.duelId, a.participantToken, b.participantToken);

      const round6 = suddenDeathContent(started.duelId, 6);
      await submitMathDuelAnswer(repo, started.duelId, a.participantToken, 6, round6.correctAnswer + 1);
      await submitMathDuelAnswer(repo, started.duelId, b.participantToken, 6, round6.correctAnswer + 1);

      const duel = await repo.getDuelById(started.duelId);
      expect(duel?.lifecycleState).toBe("ACTIVE");
    });

    it("exactly one correct in a sudden-death round wins the Duel immediately", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const started = await startAMathDuel(repo, session, a.participantId, b.participantId);
      await reachSuddenDeath(repo, started.duelId, a.participantToken, b.participantToken);

      const round6 = suddenDeathContent(started.duelId, 6);
      await submitMathDuelAnswer(repo, started.duelId, a.participantToken, 6, round6.correctAnswer);
      await submitMathDuelAnswer(repo, started.duelId, b.participantToken, 6, round6.correctAnswer + 1);

      const duel = await repo.getDuelById(started.duelId);
      expect(duel?.lifecycleState).toBe("COMPLETED");
      expect(duel?.terminalResolution).toBe("WON_LOST");
      expect(duel?.winnerParticipantId).toBe(a.participantId);

      // No round 7 was ever created — a decisive round must not
      // lazily create a successor nobody will ever need.
      const challenges = await repo.getMathDuelChallenges(started.duelId);
      expect(challenges).toHaveLength(6);
    });

    it("continues correctly through 10 consecutive tied sudden-death rounds with no artificial cap", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const started = await startAMathDuel(repo, session, a.participantId, b.participantId);
      await reachSuddenDeath(repo, started.duelId, a.participantToken, b.participantToken);

      for (let round = 6; round <= 15; round++) {
        const challenge = suddenDeathContent(started.duelId, round);
        await submitMathDuelAnswer(repo, started.duelId, a.participantToken, round, challenge.correctAnswer);
        await submitMathDuelAnswer(repo, started.duelId, b.participantToken, round, challenge.correctAnswer);
      }

      const duel = await repo.getDuelById(started.duelId);
      expect(duel?.lifecycleState).toBe("ACTIVE");
      const view = await getSession(repo, session.sessionId, a.participantToken);
      expect(view.activeDuel?.mathDuel?.myProgress?.answered).toBe(15);

      // Round 16 decides it.
      const decisive = suddenDeathContent(started.duelId, 16);
      await submitMathDuelAnswer(repo, started.duelId, a.participantToken, 16, decisive.correctAnswer);
      await submitMathDuelAnswer(repo, started.duelId, b.participantToken, 16, decisive.correctAnswer + 1);

      const resolved = await repo.getDuelById(started.duelId);
      expect(resolved?.lifecycleState).toBe("COMPLETED");
      expect(resolved?.winnerParticipantId).toBe(a.participantId);
    });

    it("Issue A — continues well past the old 25-round pre-materialized reserve boundary, structurally proving no hard cap", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const started = await startAMathDuel(repo, session, a.participantId, b.participantId);
      await reachSuddenDeath(repo, started.duelId, a.participantToken, b.participantToken);

      // The old design pre-materialized exactly 25 sudden-death rows
      // (ordinals 6-30) and stalled with MATH_DUEL_CHALLENGES_EXHAUSTED
      // the instant ordinal 31 was needed. Run 40 consecutive tied
      // rounds — well past that old boundary — and confirm the Duel
      // is still cleanly ACTIVE with no error at any point.
      for (let round = 6; round <= 45; round++) {
        const challenge = suddenDeathContent(started.duelId, round);
        await submitMathDuelAnswer(repo, started.duelId, a.participantToken, round, challenge.correctAnswer);
        await submitMathDuelAnswer(repo, started.duelId, b.participantToken, round, challenge.correctAnswer);
      }

      const duel = await repo.getDuelById(started.duelId);
      expect(duel?.lifecycleState).toBe("ACTIVE");
      expect(duel?.terminalResolution).toBeNull();

      const challenges = await repo.getMathDuelChallenges(started.duelId);
      expect(challenges).toHaveLength(46); // 5 standard + rounds 6..46 (46 lazily created by round 45's tie)
      expect(challenges.at(-1)?.challengeOrdinal).toBe(46);

      // Finally decide it, well past the old cap, to confirm normal
      // resolution still works correctly from this state.
      const decisive = suddenDeathContent(started.duelId, 46);
      await submitMathDuelAnswer(repo, started.duelId, a.participantToken, 46, decisive.correctAnswer);
      await submitMathDuelAnswer(repo, started.duelId, b.participantToken, 46, decisive.correctAnswer + 1);

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

      const round6 = suddenDeathContent(started.duelId, 6);
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

    it("Issue B — a sudden-death round activated by a tie but cut short by Forfeit before either answers is still honestly included in history, with no-answer clearly distinguished from a wrong answer", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const started = await startAMathDuel(repo, session, a.participantId, b.participantId);
      await answerAllCorrect(repo, started.duelId, a.participantToken, 5);
      await answerAllCorrect(repo, started.duelId, b.participantToken, 5);

      // The 5-5 tie already lazily created round 6 — activated,
      // genuinely shown to both competitors (both are now authorized
      // into it) — but forfeit before either submits a response.
      const preForfeitChallenges = await repo.getMathDuelChallenges(started.duelId);
      expect(preForfeitChallenges).toHaveLength(6);
      expect(preForfeitChallenges[5].activatedAt).not.toBeNull();

      const resolved = await resolveDuelExceptionally(
        repo,
        started.duelId,
        session.hostToken,
        "FORFEIT_A",
        "Alex disconnected mid sudden-death"
      );
      expect(resolved.terminalResolution).toBe("FORFEIT");

      const view = await getSession(repo, session.sessionId, b.participantToken);
      const revealed = view.duelHistory[0].mathDuel!;
      // Round 6 must appear — it was genuinely activated/reached, not
      // merely prepared-but-untouched reserve — with both answers
      // null (nobody actually answered it), never misclassified as
      // "never happened".
      expect(revealed.challenges).toHaveLength(6);
      const round6Revealed = revealed.challenges[5];
      expect(round6Revealed.competitorAAnswer).toBeNull();
      expect(round6Revealed.competitorBAnswer).toBeNull();
      expect(round6Revealed.competitorACorrect).toBeNull();
      expect(round6Revealed.competitorBCorrect).toBeNull();
    });

    it("a STANDARD challenge nobody was ever authorized into is correctly excluded from history, distinguishing it from one merely prepared", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const started = await startAMathDuel(repo, session, a.participantId, b.participantId);
      // Only ordinal 1 is ever touched by anyone.
      await submitMathDuelAnswer(repo, started.duelId, a.participantToken, 1, STANDARD[0].correctAnswer);

      await resolveDuelExceptionally(repo, started.duelId, session.hostToken, "VOID", null);

      const view = await getSession(repo, session.sessionId, b.participantToken);
      const revealed = view.duelHistory[0].mathDuel!;
      // Ordinal 1 was reached (A answered it, which also forward-
      // activates ordinal 2 — the instant A is authorized into it —
      // but ordinals 3-5 were never activated by anyone and must not
      // appear).
      const ordinalsRevealed = revealed.challenges.map((c) => c.challengeOrdinal);
      expect(ordinalsRevealed).toEqual([1, 2]);
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

  describe("Session scoring (Ordinary Duel Session Scoring Slice 001)", () => {
    it("a fresh Math Duel's winnerPoints configuration snapshot is 10", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      await startAMathDuel(repo, session, a.participantId, b.participantId);
      const active = await repo.getActiveDuelForSession(session.sessionId);
      expect(active?.winnerPoints).toBe(10);
    });

    it("a normal standard-phase WON_LOST resolution awards the winner 10 Session points", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const started = await startAMathDuel(repo, session, a.participantId, b.participantId);
      await answerAllCorrect(repo, started.duelId, a.participantToken, MATH_DUEL_STANDARD_COUNT);
      await answerAllWrong(repo, started.duelId, b.participantToken, MATH_DUEL_STANDARD_COUNT);

      const result = await getSession(repo, session.sessionId, session.hostToken);
      const aStanding = result.standings.find((s) => s.participantId === a.participantId);
      const bStanding = result.standings.find((s) => s.participantId === b.participantId);
      expect(aStanding?.score).toBe(10);
      expect(bStanding?.score).toBe(0);
    });

    it("a sudden-death WON_LOST resolution awards the winner 10 Session points", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const started = await startAMathDuel(repo, session, a.participantId, b.participantId);
      // Tie the standard phase 5-5 to force sudden death.
      await answerAllCorrect(repo, started.duelId, a.participantToken, MATH_DUEL_STANDARD_COUNT);
      await answerAllCorrect(repo, started.duelId, b.participantToken, MATH_DUEL_STANDARD_COUNT);

      const round6 = suddenDeathContent(started.duelId, 6);
      await submitMathDuelAnswer(
        repo,
        started.duelId,
        a.participantToken,
        6,
        round6.correctAnswer
      );
      await submitMathDuelAnswer(
        repo,
        started.duelId,
        b.participantToken,
        6,
        round6.correctAnswer + 1
      );

      const duel = await repo.getDuelById(started.duelId);
      expect(duel?.terminalResolution).toBe("WON_LOST");
      expect(duel?.winnerParticipantId).toBe(a.participantId);

      const result = await getSession(repo, session.sessionId, session.hostToken);
      const aStanding = result.standings.find((s) => s.participantId === a.participantId);
      const bStanding = result.standings.find((s) => s.participantId === b.participantId);
      expect(aStanding?.score).toBe(10);
      expect(bStanding?.score).toBe(0);
    });

    it("FORFEIT_A awards the non-forfeiting competitor B 10 Session points", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const started = await startAMathDuel(repo, session, a.participantId, b.participantId);
      await resolveDuelExceptionally(repo, started.duelId, session.hostToken, "FORFEIT_A", "Alex disconnected");

      const result = await getSession(repo, session.sessionId, session.hostToken);
      const bStanding = result.standings.find((s) => s.participantId === b.participantId);
      expect(bStanding?.score).toBe(10);
    });

    it("CANCELLED awards no Session points", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const started = await startAMathDuel(repo, session, a.participantId, b.participantId);
      await resolveDuelExceptionally(repo, started.duelId, session.hostToken, "CANCELLED", null);

      const result = await getSession(repo, session.sessionId, session.hostToken);
      expect(result.standings.every((s) => s.score === 0)).toBe(true);
    });

    it("a Math Duel VOIDed by COMPLETE_SESSION awards no Session points", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const started = await startAMathDuel(repo, session, a.participantId, b.participantId);
      await submitMathDuelAnswer(repo, started.duelId, a.participantToken, 1, STANDARD[0].correctAnswer);
      await completeSession(repo, session.sessionId, session.hostToken);

      const result = await getSession(repo, session.sessionId, session.hostToken);
      expect(result.standings.every((s) => s.score === 0)).toBe(true);
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
