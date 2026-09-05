import type { RaceRepository } from "./db/raceRepository";
import type { RequestRaceCancellationResult } from "./types";

/**
 * REQUEST_CANCELLATION command handler. The organizer may cancel freely
 * before the countdown is scheduled; once scheduled, only a matching
 * pair of competitor cancellation requests terminalizes the event
 * (RaceOrganizerCannotCancelAfterCountdownError otherwise) — enforced
 * entirely inside the repository's atomic RPC, which is also
 * ledger-backed (UG-CR-GATE-025 Correction A): a retry with the same
 * idempotencyKey replays the exact original response (pending or
 * already-mutual) rather than duplicating evidence or re-deriving
 * possibly-changed current state.
 */
export async function requestRaceCancellation(
  repo: RaceRepository,
  input: { raceEventId: string; callerToken: string; idempotencyKey: string }
): Promise<RequestRaceCancellationResult> {
  return repo.requestCancellation({
    raceEventId: input.raceEventId,
    callerToken: input.callerToken,
    idempotencyKey: input.idempotencyKey,
  });
}
