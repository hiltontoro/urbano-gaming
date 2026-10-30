import { HostTokenMismatchError } from "../../session/types";
import type { CommunityVotingRepository } from "./db/communityVotingRepository";
import type { StartedVoting } from "./types";
import { CommunityVotingError, isUuidLike } from "./types";

const MAX_PROMPT_LENGTH = 1000;

/**
 * START_COMMUNITY_VOTING — the one explicit, host-authorized act that opens an event's Voting.
 *
 * Completing the preparation never calls this; only the host does. The repository's atomic operation verifies
 * the Session's host authority, locks the Session first, requires the exact VOTING capability set and a locked
 * lobby, requires a complete ballot (every entry has a confirmed contestant), then — in the same transaction —
 * materializes the authoritative Voting candidates already attributed and opens the Session's Voting interaction
 * through the Session's own start. Any failed precondition or step leaves nothing behind. After it succeeds the
 * ballot and every attribution are frozen.
 */
export async function startCommunityVoting(
  repo: CommunityVotingRepository,
  input: { instanceId: unknown; hostToken: unknown; promptText: unknown }
): Promise<StartedVoting> {
  if (!isUuidLike(input.instanceId)) {
    throw new CommunityVotingError("INSTANCE_NOT_FOUND", "No Community Voting Instance exists for this id.");
  }
  if (typeof input.hostToken !== "string") throw new HostTokenMismatchError();

  const promptText = typeof input.promptText === "string" ? input.promptText.trim() : "";
  if (promptText.length === 0 || promptText.length > MAX_PROMPT_LENGTH) {
    throw new CommunityVotingError("INVALID_REQUEST", "The prompt must be 1 to 1000 characters.");
  }

  return repo.startVoting({ instanceId: input.instanceId, hostToken: input.hostToken, promptText });
}
