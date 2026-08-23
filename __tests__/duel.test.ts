import { describe, expect, it } from "vitest";

import { createSession } from "../lib/session/createSession";
import { setSessionCapabilities } from "../lib/session/setSessionCapabilities";
import { joinSession } from "../lib/session/joinSession";
import { lockLobby } from "../lib/session/lockLobby";
import { startSession } from "../lib/session/startSession";
import { startQuiz } from "../lib/session/startQuiz";
import { prepareQuestions } from "../lib/session/prepareQuestions";
import { completeSession } from "../lib/session/completeSession";
import { createSuccessorSession } from "../lib/session/createSuccessorSession";
import { getSession } from "../lib/session/getSession";
import { startDuel } from "../lib/session/startDuel";
import { submitDuelResponse } from "../lib/session/submitDuelResponse";
import { resolveDuel } from "../lib/session/resolveDuel";
import { resolveDuelExceptionally } from "../lib/session/resolveDuelExceptionally";
import { InMemorySessionRepository } from "../lib/session/db/inMemorySessionRepository";
import {
  CapabilityNotAuthorizedError,
  DuplicateDuelCompetitorError,
  DuelCompetitorNotInSessionError,
  ActiveDuelExistsError,
  InteractionActiveError,
  InvalidDuelOptionsError,
  DuelNotFoundError,
  DuelAccessDeniedError,
  DuelNotActiveError,
  InvalidDuelOptionSelectionError,
  DuelAlreadyResolvedError,
  InvalidDuelResolutionError,
  DuelReasonRequiredError,
  HostTokenMismatchError,
} from "../lib/session/types";

/**
 * Duel / SESSION_SUBGAME v1 (Product/Duel_Architecture.md,
 * Session_Capability_Architecture.md, ADR-036).
 *
 * Duel is the first concrete SESSION_SUBGAME: a bounded competitive
 * subgame between exactly two Session Participants, owning its own
 * lifecycle and terminal result, returning control to the parent
 * Session. The proving mechanic reuses Multiple-Choice-shaped
 * evaluation concepts with Host-triggered closure — no Timer, per the
 * canonical correction (no Timer Modifier exists in this codebase).
 */

async function setupDuelReadySession(
  capabilities: string[] = ["DUEL"]
) {
  const repo = new InMemorySessionRepository();
  const session = await createSession(repo);
  await setSessionCapabilities(repo, session.sessionId, session.hostToken, capabilities);
  const a = await joinSession(repo, session.roomCode, "Alex");
  const b = await joinSession(repo, session.roomCode, "Blair");
  const c = await joinSession(repo, session.roomCode, "Casey");
  const d = await joinSession(repo, session.roomCode, "Drew");
  await lockLobby(repo, session.sessionId, session.hostToken);
  return { repo, session, a, b, c, d };
}

const OPTIONS = ["Paris", "London", "Berlin", "Madrid"];
const CORRECT_INDEX = 0;

async function startADuel(
  repo: InMemorySessionRepository,
  session: Awaited<ReturnType<typeof createSession>>,
  aId: string,
  bId: string
) {
  return startDuel(
    repo,
    session.sessionId,
    session.hostToken,
    aId,
    bId,
    "Capital of France?",
    OPTIONS,
    CORRECT_INDEX
  );
}

describe("Duel / SESSION_SUBGAME v1", () => {
  describe("Capability declaration", () => {
    it("DUEL becomes a valid declarable capability", async () => {
      const { session, repo } = await (async () => {
        const repo = new InMemorySessionRepository();
        const session = await createSession(repo);
        return { repo, session };
      })();
      const result = await setSessionCapabilities(repo, session.sessionId, session.hostToken, [
        "DUEL",
      ]);
      expect(result.declaredCapabilities).toEqual(["DUEL"]);
    });

    it("supports a mixed [QUIZ, VOTING, DUEL] declaration", async () => {
      const repo = new InMemorySessionRepository();
      const session = await createSession(repo);
      const result = await setSessionCapabilities(repo, session.sessionId, session.hostToken, [
        "QUIZ",
        "VOTING",
        "DUEL",
      ]);
      expect(result.declaredCapabilities).toEqual(["DUEL", "QUIZ", "VOTING"]);
    });

    it("the capability lock still applies once DUEL is declared and a real participant joins", async () => {
      const { repo, session } = await setupDuelReadySession();
      await expect(
        setSessionCapabilities(repo, session.sessionId, session.hostToken, ["QUIZ"])
      ).rejects.toBeInstanceOf(Error);
    });
  });

  describe("START_DUEL — authorization and validation", () => {
    it("starts a Duel between two valid, distinct competitors", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const result = await startADuel(repo, session, a.participantId, b.participantId);
      expect(result.lifecycleState).toBe("ACTIVE");
      expect(result.competitorAParticipantId).toBe(a.participantId);
      expect(result.competitorBParticipantId).toBe(b.participantId);
      expect(result).not.toHaveProperty("correctOptionIndex");
    });

    it("rejects starting a Duel when DUEL is not declared", async () => {
      const { repo, session, a, b } = await setupDuelReadySession(["QUIZ"]);
      await expect(
        startADuel(repo, session, a.participantId, b.participantId)
      ).rejects.toBeInstanceOf(CapabilityNotAuthorizedError);
    });

    it("rejects the same participant selected for both competitor slots", async () => {
      const { repo, session, a } = await setupDuelReadySession();
      await expect(
        startADuel(repo, session, a.participantId, a.participantId)
      ).rejects.toBeInstanceOf(DuplicateDuelCompetitorError);
    });

    it("rejects a competitor id that does not belong to this session", async () => {
      const { repo, session, a } = await setupDuelReadySession();
      await expect(
        startADuel(repo, session, a.participantId, "not-a-real-participant-id")
      ).rejects.toBeInstanceOf(DuelCompetitorNotInSessionError);
    });

    it("rejects a competitor from a different session entirely", async () => {
      const { repo, session, a } = await setupDuelReadySession();
      const other = await setupDuelReadySession();
      await expect(
        startADuel(repo, session, a.participantId, other.a.participantId)
      ).rejects.toBeInstanceOf(DuelCompetitorNotInSessionError);
    });

    it("rejects invalid options (fewer than two)", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      await expect(
        startDuel(repo, session.sessionId, session.hostToken, a.participantId, b.participantId, "Q?", ["only-one"], 0)
      ).rejects.toBeInstanceOf(InvalidDuelOptionsError);
    });

    it("rejects an out-of-range correct option index", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      await expect(
        startDuel(repo, session.sessionId, session.hostToken, a.participantId, b.participantId, "Q?", OPTIONS, 99)
      ).rejects.toBeInstanceOf(InvalidDuelOptionsError);
    });

    it("Guest vs Guest is a valid pairing", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      // Both a and b are Guest joins (no gamingMemberId) — the default
      // joinSession path throughout this helper.
      const result = await startADuel(repo, session, a.participantId, b.participantId);
      expect(result.lifecycleState).toBe("ACTIVE");
    });
  });

  describe("Mutual exclusion — Duel vs ordinary Interaction", () => {
    it("rejects starting a Duel while an ordinary Interaction is active", async () => {
      const { repo, session, a, b } = await setupDuelReadySession(["DUEL", "OPEN_RESPONSE"]);
      await startSession(repo, session.sessionId, session.hostToken, {
        engineType: "OPEN_RESPONSE",
        promptText: "Say something",
      });
      await expect(
        startADuel(repo, session, a.participantId, b.participantId)
      ).rejects.toBeInstanceOf(InteractionActiveError);
    });

    it("rejects starting Voting while a Duel is active", async () => {
      const { repo, session, a, b } = await setupDuelReadySession(["DUEL", "VOTING"]);
      await startADuel(repo, session, a.participantId, b.participantId);
      await expect(
        startSession(repo, session.sessionId, session.hostToken, {
          engineType: "VOTING",
          promptText: "Vote",
          candidateSource: { type: "PARTICIPANTS" },
        })
      ).rejects.toBeInstanceOf(ActiveDuelExistsError);
    });

    it("rejects starting Quiz while a Duel is active", async () => {
      const { repo, session, a, b } = await setupDuelReadySession(["DUEL", "QUIZ"]);
      await prepareQuestions(repo, session.sessionId, session.hostToken, [
        { promptText: "Q1", options: ["a", "b"], correctOptionIndex: 0, points: 1 },
      ]);
      await startADuel(repo, session, a.participantId, b.participantId);
      await expect(
        startQuiz(repo, session.sessionId, session.hostToken, 60)
      ).rejects.toBeInstanceOf(ActiveDuelExistsError);
    });

    it("rejects starting a second Duel while one is already active", async () => {
      const { repo, session, a, b, c, d } = await setupDuelReadySession();
      await startADuel(repo, session, a.participantId, b.participantId);
      await expect(
        startADuel(repo, session, c.participantId, d.participantId)
      ).rejects.toBeInstanceOf(ActiveDuelExistsError);
    });

    it("permits an ordinary Interaction once the Duel resolves", async () => {
      const { repo, session, a, b } = await setupDuelReadySession(["DUEL", "OPEN_RESPONSE"]);
      const duel = await startADuel(repo, session, a.participantId, b.participantId);
      await resolveDuel(repo, duel.duelId, session.hostToken);
      const result = await startSession(repo, session.sessionId, session.hostToken, {
        engineType: "OPEN_RESPONSE",
        promptText: "Now this works",
      });
      expect(result.state).toBe("PROMPT_ACTIVE");
    });

    it("permits a second Duel once the first resolves", async () => {
      const { repo, session, a, b, c, d } = await setupDuelReadySession();
      const first = await startADuel(repo, session, a.participantId, b.participantId);
      await resolveDuel(repo, first.duelId, session.hostToken);
      const second = await startADuel(repo, session, c.participantId, d.participantId);
      expect(second.lifecycleState).toBe("ACTIVE");
    });
  });

  describe("SUBMIT_DUEL_RESPONSE — authorization and privacy", () => {
    it("a competitor may submit a response", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const duel = await startADuel(repo, session, a.participantId, b.participantId);
      const result = await submitDuelResponse(repo, duel.duelId, a.participantToken, 0);
      expect(result.participantId).toBe(a.participantId);
    });

    it("rejects a non-competitor session participant", async () => {
      const { repo, session, a, b, c } = await setupDuelReadySession();
      const duel = await startADuel(repo, session, a.participantId, b.participantId);
      await expect(
        submitDuelResponse(repo, duel.duelId, c.participantToken, 0)
      ).rejects.toBeInstanceOf(DuelAccessDeniedError);
    });

    it("rejects an invalid option index", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const duel = await startADuel(repo, session, a.participantId, b.participantId);
      await expect(
        submitDuelResponse(repo, duel.duelId, a.participantToken, 999)
      ).rejects.toBeInstanceOf(InvalidDuelOptionSelectionError);
    });

    it("rejects submission to a nonexistent Duel", async () => {
      const { repo, a } = await setupDuelReadySession();
      await expect(
        submitDuelResponse(repo, "nonexistent-duel-id", a.participantToken, 0)
      ).rejects.toBeInstanceOf(DuelNotFoundError);
    });

    it("rejects submission once the Duel is no longer ACTIVE", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const duel = await startADuel(repo, session, a.participantId, b.participantId);
      await resolveDuel(repo, duel.duelId, session.hostToken);
      await expect(
        submitDuelResponse(repo, duel.duelId, a.participantToken, 0)
      ).rejects.toBeInstanceOf(DuelNotActiveError);
    });

    it("is idempotent — a second submission from the same competitor replaces the first", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const duel = await startADuel(repo, session, a.participantId, b.participantId);
      await submitDuelResponse(repo, duel.duelId, a.participantToken, 1);
      await submitDuelResponse(repo, duel.duelId, a.participantToken, 0);
      const result = await getSession(repo, session.sessionId, session.hostToken);
      // Before resolution, the host sees no per-competitor answers at
      // all (read-model privacy) — only each competitor's own
      // myResponseOptionIndex is populated, and the host is not a
      // competitor.
      expect(result.activeDuel?.competitorAOptionIndex).toBeNull();
    });

    it("answers remain private before resolution — competitor B cannot see A's answer via GET_SESSION", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const duel = await startADuel(repo, session, a.participantId, b.participantId);
      await submitDuelResponse(repo, duel.duelId, a.participantToken, CORRECT_INDEX);

      const bView = await getSession(repo, session.sessionId, b.participantToken);
      expect(bView.activeDuel?.competitorAOptionIndex).toBeNull();
      expect(bView.activeDuel?.myResponseOptionIndex).toBeNull();

      const aView = await getSession(repo, session.sessionId, a.participantToken);
      expect(aView.activeDuel?.myResponseOptionIndex).toBe(CORRECT_INDEX);
    });
  });

  describe("RESOLVE_DUEL — normal, mechanic-derived resolution", () => {
    it("competitor A wins when only A answers correctly", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const duel = await startADuel(repo, session, a.participantId, b.participantId);
      await submitDuelResponse(repo, duel.duelId, a.participantToken, CORRECT_INDEX);
      await submitDuelResponse(repo, duel.duelId, b.participantToken, CORRECT_INDEX + 1);
      const result = await resolveDuel(repo, duel.duelId, session.hostToken);
      expect(result.terminalResolution).toBe("WON_LOST");
      expect(result.winnerParticipantId).toBe(a.participantId);
    });

    it("competitor B wins when only B answers correctly", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const duel = await startADuel(repo, session, a.participantId, b.participantId);
      await submitDuelResponse(repo, duel.duelId, a.participantToken, CORRECT_INDEX + 1);
      await submitDuelResponse(repo, duel.duelId, b.participantToken, CORRECT_INDEX);
      const result = await resolveDuel(repo, duel.duelId, session.hostToken);
      expect(result.winnerParticipantId).toBe(b.participantId);
    });

    it("both wrong resolves as a DRAW", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const duel = await startADuel(repo, session, a.participantId, b.participantId);
      await submitDuelResponse(repo, duel.duelId, a.participantToken, CORRECT_INDEX + 1);
      await submitDuelResponse(repo, duel.duelId, b.participantToken, CORRECT_INDEX + 2);
      const result = await resolveDuel(repo, duel.duelId, session.hostToken);
      expect(result.terminalResolution).toBe("DRAW");
      expect(result.winnerParticipantId).toBeNull();
    });

    it("both correct — earlier answer wins", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const duel = await startADuel(repo, session, a.participantId, b.participantId);
      await submitDuelResponse(repo, duel.duelId, a.participantToken, CORRECT_INDEX);
      await new Promise((resolve) => setTimeout(resolve, 5));
      await submitDuelResponse(repo, duel.duelId, b.participantToken, CORRECT_INDEX);
      const result = await resolveDuel(repo, duel.duelId, session.hostToken);
      expect(result.terminalResolution).toBe("WON_LOST");
      expect(result.winnerParticipantId).toBe(a.participantId);
    });

    it("uncontested correct answer beats no answer at all", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const duel = await startADuel(repo, session, a.participantId, b.participantId);
      await submitDuelResponse(repo, duel.duelId, a.participantToken, CORRECT_INDEX);
      const result = await resolveDuel(repo, duel.duelId, session.hostToken);
      expect(result.winnerParticipantId).toBe(a.participantId);
    });

    it("a wrong uncontested answer resolves VOID, not a fabricated winner", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const duel = await startADuel(repo, session, a.participantId, b.participantId);
      await submitDuelResponse(repo, duel.duelId, a.participantToken, CORRECT_INDEX + 1);
      const result = await resolveDuel(repo, duel.duelId, session.hostToken);
      expect(result.terminalResolution).toBe("VOID");
      expect(result.winnerParticipantId).toBeNull();
    });

    it("neither responding resolves VOID", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const duel = await startADuel(repo, session, a.participantId, b.participantId);
      const result = await resolveDuel(repo, duel.duelId, session.hostToken);
      expect(result.terminalResolution).toBe("VOID");
    });

    it("rejects resolution from a non-host token", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const duel = await startADuel(repo, session, a.participantId, b.participantId);
      await expect(
        resolveDuel(repo, duel.duelId, a.participantToken)
      ).rejects.toBeInstanceOf(HostTokenMismatchError);
    });

    it("rejects resolving a nonexistent Duel", async () => {
      const { repo, session } = await setupDuelReadySession();
      await expect(
        resolveDuel(repo, "nonexistent-duel-id", session.hostToken)
      ).rejects.toBeInstanceOf(DuelNotFoundError);
    });

    it("a terminal Duel cannot be resolved a second time", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const duel = await startADuel(repo, session, a.participantId, b.participantId);
      await resolveDuel(repo, duel.duelId, session.hostToken);
      await expect(
        resolveDuel(repo, duel.duelId, session.hostToken)
      ).rejects.toBeInstanceOf(DuelAlreadyResolvedError);
    });

    it("results become visible Session-wide once resolved", async () => {
      const { repo, session, a, b, c } = await setupDuelReadySession();
      const duel = await startADuel(repo, session, a.participantId, b.participantId);
      await submitDuelResponse(repo, duel.duelId, a.participantToken, CORRECT_INDEX);
      await submitDuelResponse(repo, duel.duelId, b.participantToken, CORRECT_INDEX + 1);
      await resolveDuel(repo, duel.duelId, session.hostToken);

      // c is a non-competitor — sees the revealed result once terminal.
      const cView = await getSession(repo, session.sessionId, c.participantToken);
      const resolved = cView.duelHistory.find((d) => d.duelId === duel.duelId);
      expect(resolved?.lifecycleState).toBe("COMPLETED");
      expect(resolved?.competitorAOptionIndex).toBe(CORRECT_INDEX);
      expect(resolved?.competitorBOptionIndex).toBe(CORRECT_INDEX + 1);
      expect(resolved?.winnerParticipantId).toBe(a.participantId);
    });
  });

  describe("RESOLVE_DUEL_EXCEPTIONALLY — Host authority", () => {
    it("CANCELLED produces no winner", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const duel = await startADuel(repo, session, a.participantId, b.participantId);
      const result = await resolveDuelExceptionally(repo, duel.duelId, session.hostToken, "CANCELLED", null);
      expect(result.terminalResolution).toBe("CANCELLED");
      expect(result.winnerParticipantId).toBeNull();
    });

    it("VOID produces no winner", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const duel = await startADuel(repo, session, a.participantId, b.participantId);
      const result = await resolveDuelExceptionally(repo, duel.duelId, session.hostToken, "VOID", null);
      expect(result.terminalResolution).toBe("VOID");
      expect(result.winnerParticipantId).toBeNull();
    });

    it("FORFEIT_A makes competitor B the winner", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const duel = await startADuel(repo, session, a.participantId, b.participantId);
      const result = await resolveDuelExceptionally(
        repo,
        duel.duelId,
        session.hostToken,
        "FORFEIT_A",
        "Competitor A disconnected and did not return."
      );
      expect(result.terminalResolution).toBe("FORFEIT");
      expect(result.winnerParticipantId).toBe(b.participantId);
    });

    it("FORFEIT_B makes competitor A the winner", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const duel = await startADuel(repo, session, a.participantId, b.participantId);
      const result = await resolveDuelExceptionally(
        repo,
        duel.duelId,
        session.hostToken,
        "FORFEIT_B",
        "Competitor B left the game."
      );
      expect(result.winnerParticipantId).toBe(a.participantId);
    });

    it("a forfeit requires a reason", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const duel = await startADuel(repo, session, a.participantId, b.participantId);
      await expect(
        resolveDuelExceptionally(repo, duel.duelId, session.hostToken, "FORFEIT_A", null)
      ).rejects.toBeInstanceOf(DuelReasonRequiredError);
    });

    it("rejects an invalid resolution value", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const duel = await startADuel(repo, session, a.participantId, b.participantId);
      await expect(
        resolveDuelExceptionally(
          repo,
          duel.duelId,
          session.hostToken,
          // @ts-expect-error deliberately invalid for this test
          "NOT_A_REAL_RESOLUTION",
          null
        )
      ).rejects.toBeInstanceOf(InvalidDuelResolutionError);
    });

    it("cannot exceptionally resolve an already-COMPLETED Duel", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const duel = await startADuel(repo, session, a.participantId, b.participantId);
      await resolveDuel(repo, duel.duelId, session.hostToken);
      await expect(
        resolveDuelExceptionally(repo, duel.duelId, session.hostToken, "VOID", null)
      ).rejects.toBeInstanceOf(DuelAlreadyResolvedError);
    });
  });

  describe("Session completion while a Duel is active", () => {
    it("COMPLETE_SESSION is not blocked by an active Duel", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      await startADuel(repo, session, a.participantId, b.participantId);
      const result = await completeSession(repo, session.sessionId, session.hostToken);
      expect(result.state).toBe("SESSION_COMPLETE");
    });

    it("voids the active Duel rather than fabricating a winner", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const duel = await startADuel(repo, session, a.participantId, b.participantId);
      await submitDuelResponse(repo, duel.duelId, a.participantToken, CORRECT_INDEX);
      await completeSession(repo, session.sessionId, session.hostToken);

      const result = await getSession(repo, session.sessionId, session.hostToken);
      const voided = result.duelHistory.find((d) => d.duelId === duel.duelId);
      expect(voided?.lifecycleState).toBe("COMPLETED");
      expect(voided?.terminalResolution).toBe("VOID");
      expect(voided?.winnerParticipantId).toBeNull();
    });

    it("preserves partial response history after Session completion", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const duel = await startADuel(repo, session, a.participantId, b.participantId);
      await submitDuelResponse(repo, duel.duelId, a.participantToken, CORRECT_INDEX);
      await completeSession(repo, session.sessionId, session.hostToken);

      const result = await getSession(repo, session.sessionId, a.participantToken);
      const voided = result.duelHistory.find((d) => d.duelId === duel.duelId);
      expect(voided?.competitorAOptionIndex).toBe(CORRECT_INDEX);
    });
  });

  describe("Session scoring boundary", () => {
    it("a Duel resolves with no automatic Session points", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const duel = await startADuel(repo, session, a.participantId, b.participantId);
      await submitDuelResponse(repo, duel.duelId, a.participantToken, CORRECT_INDEX);
      await resolveDuel(repo, duel.duelId, session.hostToken);
      const result = await getSession(repo, session.sessionId, session.hostToken);
      expect(result.standings.every((s) => s.score === 0)).toBe(true);
    });
  });

  describe("Historical evidence", () => {
    it("completed Duel history remains readable", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const duel = await startADuel(repo, session, a.participantId, b.participantId);
      await resolveDuel(repo, duel.duelId, session.hostToken);
      const result = await getSession(repo, session.sessionId, session.hostToken);
      expect(result.duelHistory.some((d) => d.duelId === duel.duelId)).toBe(true);
      expect(result.activeDuel).toBeNull();
    });

    it("a successor Session inherits no Duel runtime or history", async () => {
      const { repo, session, a, b } = await setupDuelReadySession();
      const duel = await startADuel(repo, session, a.participantId, b.participantId);
      await resolveDuel(repo, duel.duelId, session.hostToken);
      await completeSession(repo, session.sessionId, session.hostToken);
      const successor = await createSuccessorSession(repo, session.sessionId, session.hostToken);
      const successorView = await getSession(repo, successor.sessionId, successor.hostToken);
      expect(successorView.duelHistory).toEqual([]);
      expect(successorView.activeDuel).toBeNull();
    });
  });
});
