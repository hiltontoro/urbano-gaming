import type { RaceRepository } from "./db/raceRepository";
import type { RaceEventProjection, RaceLifecyclePhase } from "./types";
import { RaceEventNotFoundError } from "./types";

const READINESS_WINDOW_MS = 5 * 60 * 1000;
const RUNNING_WINDOW_MS = 10 * 60 * 1000;

function derivePhase(event: {
  terminalResolution: string | null;
  competitorAToken: string | null;
  competitorBToken: string | null;
  competitorAReady: boolean;
  competitorBReady: boolean;
  sharedStartAt: string | null;
}): RaceLifecyclePhase {
  if (event.terminalResolution) return "COMPLETED";
  if (!event.competitorAToken || !event.competitorBToken) return "AWAITING_COMPETITORS";
  if (!event.sharedStartAt) return "AWAITING_READINESS";
  if (Date.now() < new Date(event.sharedStartAt).getTime()) return "COUNTDOWN";
  return "LIVE";
}

/**
 * GET_PROJECTION query handler — the sole place client-facing read
 * shapes are assembled. Raw Towers attemptId values and the opponent's
 * competitor_token never leave repo.getEvent()'s server-internal
 * RaceEventRecord; "you.board" is populated only from the CALLER's own
 * attemptId, and only when the caller is a resolved competitor, so an
 * opponent's board is never fetched at all here, let alone returned —
 * this holds in every phase, not only during live play, since Slice 001
 * has no product requirement to reveal it even after the event ends.
 */
export async function getRaceEventProjection(
  repo: RaceRepository,
  input: { raceEventId: string; callerToken: string | null }
): Promise<RaceEventProjection> {
  const event = await repo.getEvent(input.raceEventId);
  if (!event) throw new RaceEventNotFoundError();

  const phase = derivePhase(event);

  const readinessExpiresAt =
    !event.sharedStartAt && event.secondCompetitorAssignedAt && !event.terminalResolution
      ? new Date(new Date(event.secondCompetitorAssignedAt).getTime() + READINESS_WINDOW_MS).toISOString()
      : null;

  const runningExpiresAt =
    event.sharedStartAt && !event.terminalResolution
      ? new Date(new Date(event.sharedStartAt).getTime() + RUNNING_WINDOW_MS).toISOString()
      : null;

  let you: RaceEventProjection["you"] = null;
  if (input.callerToken && input.callerToken === event.organizerToken) {
    you = { role: "ORGANIZER", slot: null, cancelRequested: false, board: null };
  } else if (input.callerToken && input.callerToken === event.competitorAToken) {
    const board = event.competitorAAttemptId ? await repo.getBoard(event.competitorAAttemptId) : null;
    you = { role: "COMPETITOR", slot: "A", cancelRequested: event.competitorACancelRequested, board };
  } else if (input.callerToken && input.callerToken === event.competitorBToken) {
    const board = event.competitorBAttemptId ? await repo.getBoard(event.competitorBAttemptId) : null;
    you = { role: "COMPETITOR", slot: "B", cancelRequested: event.competitorBCancelRequested, board };
  }

  return {
    raceEventId: event.raceEventId,
    childGame: event.childGame,
    scenarioId: event.scenarioId,
    scenarioVersion: event.scenarioVersion,
    phase,
    competitorASlotFilled: event.competitorAToken !== null,
    competitorBSlotFilled: event.competitorBToken !== null,
    competitorAReady: event.competitorAReady,
    competitorBReady: event.competitorBReady,
    secondCompetitorAssignedAt: event.secondCompetitorAssignedAt,
    readinessExpiresAt,
    sharedStartAt: event.sharedStartAt,
    runningExpiresAt,
    terminalResolution: event.terminalResolution,
    winnerSlot: event.winnerSlot,
    terminalReason: event.terminalReason,
    endedAt: event.endedAt,
    createdAt: event.createdAt,
    you,
  };
}
