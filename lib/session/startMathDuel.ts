import type { SessionRepository } from "./db/sessionRepository";
import type { StartMathDuelResult } from "./types";
import {
  SessionNotFoundError,
  HostTokenMismatchError,
  LobbyNotLockedError,
  CapabilityNotAuthorizedError,
  DuplicateDuelCompetitorError,
  DuelCompetitorNotInSessionError,
  InteractionActiveError,
  ActiveDuelExistsError,
} from "./types";
import { selectMathDuelChallenges } from "./mathDuelFixture";

/**
 * START_MATH_DUEL command handler.
 *
 * Math Duel Slice 001. Sibling to startDuel() (Multiple Choice), not a
 * generalization of it — see StartMathDuelResult's own doc comment for
 * why the two command results deliberately have different shapes. The
 * generic Duel-initiation checks are identical (host token, session
 * LOBBY_LOCKED + DUEL declared, distinct in-session competitors, no
 * active ordinary Interaction, no active Duel) — duplicated here
 * rather than shared, mirroring this file's own established per-
 * mechanic-independence convention (submitDuelResponse.ts/
 * resolveDuel.ts already duplicate their own fast-path checks rather
 * than sharing them with this file).
 *
 * Challenge selection is entirely server-owned: the Host supplies only
 * the two competitor ids, matching Math Duel's own Product Definition
 * ("the Host should not author the individual math questions
 * manually"). `random` is injectable only for deterministic test
 * control — no real caller ever supplies it; production always uses
 * Math.random via mathDuelFixture.ts's own default.
 */
export async function startMathDuel(
  repo: SessionRepository,
  sessionId: string,
  hostToken: string,
  competitorAParticipantId: string,
  competitorBParticipantId: string,
  random?: () => number
): Promise<StartMathDuelResult> {
  if (competitorAParticipantId === competitorBParticipantId) {
    throw new DuplicateDuelCompetitorError();
  }

  const session = await repo.getSessionById(sessionId);
  if (!session) {
    throw new SessionNotFoundError();
  }

  if (session.hostToken !== hostToken) {
    throw new HostTokenMismatchError();
  }

  if (session.state !== "LOBBY_LOCKED") {
    throw new LobbyNotLockedError(session.state);
  }

  if (!(session.declaredCapabilities ?? []).includes("DUEL")) {
    throw new CapabilityNotAuthorizedError("DUEL");
  }

  const participants = await repo.getParticipantsForSession(sessionId);
  const participantIds = new Set(participants.map((p) => p.participantId));
  if (
    !participantIds.has(competitorAParticipantId) ||
    !participantIds.has(competitorBParticipantId)
  ) {
    throw new DuelCompetitorNotInSessionError();
  }

  const interactionInstances = await repo.getInteractionInstancesForSession(
    sessionId
  );
  const currentInteraction =
    interactionInstances.length > 0
      ? interactionInstances[interactionInstances.length - 1]
      : null;
  if (currentInteraction && currentInteraction.state !== "RESULT_REVEAL") {
    throw new InteractionActiveError(currentInteraction.state);
  }

  const activeDuel = await repo.getActiveDuelForSession(sessionId);
  if (activeDuel) {
    throw new ActiveDuelExistsError();
  }

  const challenges = selectMathDuelChallenges(random);

  const result = await repo.startMathDuel(
    session.sessionId,
    hostToken,
    competitorAParticipantId,
    competitorBParticipantId,
    challenges
  );

  return {
    duelId: result.duelId,
    sessionId: session.sessionId,
    mechanicKey: "MATH_DUEL",
    competitorAParticipantId,
    competitorBParticipantId,
    lifecycleState: result.lifecycleState,
    startedAt: result.startedAt,
  };
}
