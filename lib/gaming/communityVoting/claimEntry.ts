import type { CommunityVotingRepository } from "./db/communityVotingRepository";
import type { ClaimedEntry } from "./types";
import { CommunityVotingError, isUuidLike } from "./types";
import { resolveVerifiedVoter, type VoterIdentityVerifier } from "./verifiedIdentity";

/**
 * CLAIM_COMMUNITY_VOTING_ENTRY — the CONTESTANT's side of the private association.
 *
 * The claimant is authenticated like every other voter (a server-verified identity with a confirmed phone,
 * already bound to this event). The claim credential arrives in the request BODY — never a URL — and is never
 * logged; it is single-use, scoped to one entry of this event, and expires. On success the contestant is given a
 * confirmation code, once, to show the host. This function does not link accounts, create a profile, or reveal
 * the contestant to the host: the host learns only that SOME verified, event-bound identity presented the
 * credential and the code, which is exactly what the host then verifies against the person in front of them.
 */
export async function claimCommunityVotingEntry(
  repo: CommunityVotingRepository,
  verifier: VoterIdentityVerifier,
  authorizationHeader: string | null | undefined,
  instanceId: string,
  body: unknown
): Promise<ClaimedEntry> {
  const identity = await resolveVerifiedVoter(verifier, authorizationHeader);

  if (!isUuidLike(instanceId)) {
    throw new CommunityVotingError("INSTANCE_NOT_FOUND", "No Community Voting Instance exists for this id.");
  }
  if (
    typeof body !== "object" ||
    body === null ||
    Array.isArray(body) ||
    typeof (body as Record<string, unknown>).claimCode !== "string"
  ) {
    throw new CommunityVotingError("INVALID_REQUEST", "A claim code is required.");
  }

  return repo.claimEntry({
    instanceId,
    authUserId: identity.authUserId,
    claimCode: (body as { claimCode: string }).claimCode,
  });
}
