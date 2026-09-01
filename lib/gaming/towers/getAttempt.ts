import type { TowersRepository } from "./db/towersRepository";
import type { TowersAttemptView } from "./types";
import { TowersAttemptNotFoundError } from "./types";

/**
 * GET_ATTEMPT — read-only, no locking required. Reload/reconnect always
 * reconstructs from this: current stacks, counts, timer timestamps, and
 * outcome are all authoritative server state, never client-cached.
 */
export async function getAttempt(repo: TowersRepository, attemptId: string): Promise<TowersAttemptView> {
  const attempt = await repo.getAttempt(attemptId);
  if (!attempt) {
    throw new TowersAttemptNotFoundError();
  }
  const actionHistory = await repo.listActionsForAttempt(attemptId);
  return { ...attempt, actionHistory };
}
