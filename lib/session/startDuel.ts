import type { SessionRepository } from "./db/sessionRepository";
import type { StartDuelResult } from "./types";
import {
  SessionNotFoundError,
  HostTokenMismatchError,
  LobbyNotLockedError,
  CapabilityNotAuthorizedError,
  DuplicateDuelCompetitorError,
  DuelCompetitorNotInSessionError,
  InteractionActiveError,
  ActiveDuelExistsError,
  InvalidDuelOptionsError,
} from "./types";

/**
 * Validates a Duel's proving-mechanic content: at least two distinct,
 * non-empty trimmed options, and a correct option index within range.
 * Mirrors the same floor prepareQuestions.ts/startSession.ts already
 * apply to Multiple Choice/Voting options.
 */
function validateDuelOptions(
  options: string[],
  correctOptionIndex: number
): string[] {
  const trimmed = options.map((o) => o.trim());
  const distinct = new Set(trimmed);

  if (
    trimmed.length < 2 ||
    trimmed.some((o) => o.length === 0) ||
    distinct.size !== trimmed.length ||
    !Number.isInteger(correctOptionIndex) ||
    correctOptionIndex < 0 ||
    correctOptionIndex >= trimmed.length
  ) {
    throw new InvalidDuelOptionsError();
  }

  return trimmed;
}

/**
 * START_DUEL command handler.
 *
 * Duel / SESSION_SUBGAME v1 (Product/Duel_Architecture.md). Scope:
 * authenticates the caller as the session's host via the stored host
 * token, verifies the session is LOBBY_LOCKED and has declared DUEL,
 * that both competitor ids are distinct participants of this session,
 * that no ordinary Interaction is active, and that no other Duel is
 * already active — then atomically creates the Duel already ACTIVE.
 * Only manual, Host-selected competitor ids are accepted here — no
 * rule-driven or sequenced selection, per Session_Capability_
 * Architecture.md's own ad-hoc/orchestrated boundary.
 *
 * Host-token, session-state, competitor-membership, and mutual-
 * exclusion authority: the getSessionById/getParticipantsForSession/
 * getInteractionInstancesForSession/getActiveDuelForSession lookups
 * below are a fast-path check for immediate rejection — they are NOT
 * the sole guarantee. The repository's startDuel call is the
 * authoritative check, re-verifying everything inside the same atomic
 * operation that creates the Duel.
 *
 * correctOptionIndex is never returned to the caller — the read-model
 * privacy requirement applies from the very first response.
 */
export async function startDuel(
  repo: SessionRepository,
  sessionId: string,
  hostToken: string,
  competitorAParticipantId: string,
  competitorBParticipantId: string,
  promptText: string,
  options: string[],
  correctOptionIndex: number
): Promise<StartDuelResult> {
  if (competitorAParticipantId === competitorBParticipantId) {
    throw new DuplicateDuelCompetitorError();
  }

  const trimmedOptions = validateDuelOptions(options, correctOptionIndex);
  const trimmedPrompt = promptText.trim();

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

  const result = await repo.startDuel(
    session.sessionId,
    hostToken,
    competitorAParticipantId,
    competitorBParticipantId,
    trimmedPrompt,
    trimmedOptions,
    correctOptionIndex
  );

  return {
    duelId: result.duelId,
    sessionId: session.sessionId,
    mechanicKey: result.mechanicKey,
    competitorAParticipantId,
    competitorBParticipantId,
    lifecycleState: result.lifecycleState,
    promptText: result.promptText,
    options: result.options,
    startedAt: result.startedAt,
  };
}
