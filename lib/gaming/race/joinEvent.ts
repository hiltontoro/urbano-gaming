import type { RaceRepository } from "./db/raceRepository";
import type { JoinRaceEventResult } from "./types";

/**
 * JOIN_EVENT command handler. race_event_id is the semi-public "join
 * code" (anyone who has it may attempt to claim an open slot); the
 * returned competitor_token is the private per-competitor bearer
 * credential needed for every subsequent competitor action. Genuinely
 * concurrent (two people could join at once) — the repository's
 * join_race_event_atomically RPC locks the event row.
 *
 * Ledger-backed (UG-CR-GATE-025 Correction A): the client supplies its
 * own idempotencyKey, and a lost-response retry with the same key
 * returns the SAME slot/token — it can never consume the other slot,
 * because the ledger check happens before the slot-assignment logic
 * runs at all.
 */
export async function joinEvent(
  repo: RaceRepository,
  input: { raceEventId: string; idempotencyKey: string }
): Promise<JoinRaceEventResult> {
  return repo.joinEvent({ raceEventId: input.raceEventId, idempotencyKey: input.idempotencyKey });
}
