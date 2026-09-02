import type { SessionRepository } from "./db/sessionRepository";
import type { StartPulseDuelResult } from "./types";
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

/**
 * START_PULSE_DUEL command handler.
 *
 * URBANO Pulse Slice 001 (UG-CR-GATE-002). Sibling to startDuel()
 * (Multiple Choice) and startMathDuel() (Math Duel), not a
 * generalization of either — mirrors startMathDuel.ts's own
 * established "duplicate the generic Duel-initiation checks rather
 * than share them" convention exactly. No mechanic-owned content to
 * select up front (unlike Math Duel's challenge selection) — Pulse's
 * own content (each competitor's private layout) does not exist until
 * COMMIT_SETUP, well after this command returns.
 */
export async function startPulseDuel(
  repo: SessionRepository,
  sessionId: string,
  hostToken: string,
  competitorAParticipantId: string,
  competitorBParticipantId: string
): Promise<StartPulseDuelResult> {
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

  const interactionInstances = await repo.getInteractionInstancesForSession(sessionId);
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

  const result = await repo.startPulseDuel(
    session.sessionId,
    hostToken,
    competitorAParticipantId,
    competitorBParticipantId
  );

  return {
    duelId: result.duelId,
    sessionId: session.sessionId,
    mechanicKey: "PULSE",
    competitorAParticipantId,
    competitorBParticipantId,
    lifecycleState: result.lifecycleState,
    startedAt: result.startedAt,
  };
}
