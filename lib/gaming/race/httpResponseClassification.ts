export type RaceResponseClassification = "ambiguous" | "definite";

/**
 * Classifies an HTTP response status for Race's client-side pending-
 * operation recovery (UG-CR-GATE-027 Defect 3). "ambiguous" means the
 * request's server-side outcome is not proven, so a pending envelope must
 * be retained and safely retried under the same key/payload: a 5xx, or an
 * explicit 408 (request timeout) / 429 (throttled) — cases where the
 * server may not have processed the request body at all. Every other 4xx
 * (validation, auth, not-found, illegal-move, stale-state, and
 * idempotency-conflict) is "definite": the server has already
 * communicated an outcome, so the client must stop and reflect it rather
 * than retry blindly under the same key. Mirrored exactly by
 * `classifyResponseStatus` in public/race.html — keep both in sync.
 */
export function classifyRaceResponseStatus(status: number): RaceResponseClassification {
  if (status >= 500) return "ambiguous";
  if (status === 408 || status === 429) return "ambiguous";
  return "definite";
}
