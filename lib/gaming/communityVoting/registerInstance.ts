import { HostTokenMismatchError } from "../../session/types";
import type { CommunityVotingRepository } from "./db/communityVotingRepository";
import { validateGeofenceConfig } from "./eligibility";
import type { CommunityVotingInstanceRecord } from "./types";
import { CommunityVotingError, isUuidLike } from "./types";

/**
 * REGISTER_COMMUNITY_VOTING_INSTANCE. Binds one Instance to one Session.
 *
 * Authority is the Session's own host token (the same authority that locks, starts, closes and
 * reveals — no new operator role). This function only validates shape; the repository's atomic
 * operation is the authority for everything else: it locks the Session row before checking or
 * writing, requires the declared capability set to be exactly VOTING, requires that no Participant
 * exists yet, and enforces one Instance per Session. The Instance has no lifecycle state of its own.
 */
export async function registerCommunityVotingInstance(
  repo: CommunityVotingRepository,
  input: { sessionId: unknown; hostToken: unknown; config: unknown; ruleVersion: unknown }
): Promise<CommunityVotingInstanceRecord> {
  if (!isUuidLike(input.sessionId)) {
    throw new CommunityVotingError("INVALID_REQUEST", "sessionId must be a valid session id.");
  }
  if (typeof input.hostToken !== "string") {
    throw new HostTokenMismatchError();
  }
  const config = validateGeofenceConfig(input.config);
  if (
    typeof input.ruleVersion !== "number" ||
    !Number.isInteger(input.ruleVersion) ||
    input.ruleVersion < 1
  ) {
    throw new CommunityVotingError("INVALID_REQUEST", "ruleVersion must be a positive integer.");
  }

  return repo.registerInstance({
    sessionId: input.sessionId,
    hostToken: input.hostToken,
    config,
    ruleVersion: input.ruleVersion,
  });
}
