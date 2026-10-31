import type { CommunityVotingRepository } from "./db/communityVotingRepository";
import type { IssuedIntent } from "./types";
import { CommunityVotingError, isUuidLike } from "./types";
import { resolveVerifiedVoter, type VoterIdentityVerifier } from "./verifiedIdentity";

/**
 * ISSUE_COMMUNITY_VOTING_INTENT. Hands the caller's own binding its next server-issued, strictly
 * increasing intent number. The number orders the intents the SERVER issued; it does not prove the
 * chronological order in which a person formed intentions across devices.
 */
export async function issueCommunityVotingIntent(
  repo: CommunityVotingRepository,
  verifier: VoterIdentityVerifier,
  authorizationHeader: string | null | undefined,
  instanceId: string
): Promise<IssuedIntent> {
  const identity = await resolveVerifiedVoter(verifier, authorizationHeader);
  if (!isUuidLike(instanceId)) {
    throw new CommunityVotingError("INSTANCE_NOT_FOUND", "No Community Voting Instance exists for this id.");
  }
  return repo.issueIntent({ instanceId, authUserId: identity.authUserId });
}
