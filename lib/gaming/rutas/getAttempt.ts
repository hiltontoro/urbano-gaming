import type { RutasRepository } from "./db/rutasRepository";
import type { RutasAttemptView } from "./types";
import { RutasAttemptNotFoundError } from "./types";

/**
 * GET_ATTEMPT — read-only, no locking required. Reload/reconnect always
 * reconstructs from this: current piece positions, counts, timer
 * timestamps, and outcome are all authoritative server state, never
 * client-cached.
 */
export async function getAttempt(repo: RutasRepository, attemptId: string): Promise<RutasAttemptView> {
  const attempt = await repo.getAttempt(attemptId);
  if (!attempt) {
    throw new RutasAttemptNotFoundError();
  }
  const actionHistory = await repo.listActionsForAttempt(attemptId);
  return { ...attempt, actionHistory };
}
