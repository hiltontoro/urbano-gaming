import type { CommunityVotingRepository } from "./db/communityVotingRepository";
import { validateLocationClaim } from "./eligibility";
import type { CastCommunityVoteResult } from "./types";
import { CommunityVotingError, isUuidLike } from "./types";
import { resolveVerifiedVoter, type VoterIdentityVerifier } from "./verifiedIdentity";

/**
 * CAST_COMMUNITY_VOTE. The single cast path for an event voter.
 *
 * This is a thin front door: it authenticates the caller (server-verified, phone required), validates
 * the SHAPE of the request, and hands one atomic operation to the repository. Location is evaluated by
 * that operation from the Instance's stored facts — the client's coordinates are untrusted claims and
 * any eligibility flag a client sends is simply not read. The operation delegates the actual vote to the
 * unchanged Session/Voting writer and records only the accepted recovery metadata.
 *
 * Validation failures are raised BEFORE the repository is touched, so a malformed request can never
 * consume an intent, and no error here ever repeats a coordinate.
 */
export async function castCommunityVote(
  repo: CommunityVotingRepository,
  verifier: VoterIdentityVerifier,
  authorizationHeader: string | null | undefined,
  instanceId: string,
  body: unknown
): Promise<CastCommunityVoteResult> {
  const identity = await resolveVerifiedVoter(verifier, authorizationHeader);

  if (!isUuidLike(instanceId)) {
    throw new CommunityVotingError("INSTANCE_NOT_FOUND", "No Community Voting Instance exists for this id.");
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    throw new CommunityVotingError("INVALID_REQUEST", "The request body must be a JSON object.");
  }
  const { bindingId, intentNo, interactionInstanceId, candidateId, location } = body as Record<string, unknown>;

  if (!isUuidLike(bindingId) || !isUuidLike(interactionInstanceId) || !isUuidLike(candidateId)) {
    throw new CommunityVotingError(
      "INVALID_REQUEST",
      "bindingId, interactionInstanceId and candidateId must be valid ids."
    );
  }
  if (typeof intentNo !== "number" || !Number.isInteger(intentNo) || intentNo < 1) {
    throw new CommunityVotingError("INVALID_REQUEST", "intentNo must be a positive integer.");
  }
  const claim = validateLocationClaim(location);

  return repo.castVote({
    instanceId,
    authUserId: identity.authUserId,
    bindingId,
    intentNo,
    interactionInstanceId,
    candidateId,
    location: claim,
  });
}
