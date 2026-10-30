import type { CommunityVotingRepository } from "./db/communityVotingRepository";
import type { VoterBindingResult } from "./types";
import { CommunityVotingError, isUuidLike } from "./types";
import { resolveVerifiedVoter, type VoterIdentityVerifier } from "./verifiedIdentity";

/**
 * BIND_COMMUNITY_VOTING_VOTER. Establishes (or idempotently recovers) the event-scoped binding from a
 * SERVER-VERIFIED Auth identity with a confirmed phone to an internal Participant.
 *
 * The Instance id (what a QR code carries) is only discovery context: it identifies WHICH event, and
 * grants nothing by itself — authority comes from the verified identity, and every later vote from the
 * eligibility check. No Gaming Member is required or created; the result carries no Participant token,
 * label or id.
 */
export async function bindCommunityVotingVoter(
  repo: CommunityVotingRepository,
  verifier: VoterIdentityVerifier,
  authorizationHeader: string | null | undefined,
  instanceId: string
): Promise<VoterBindingResult> {
  const identity = await resolveVerifiedVoter(verifier, authorizationHeader);
  if (!isUuidLike(instanceId)) {
    throw new CommunityVotingError("INSTANCE_NOT_FOUND", "No Community Voting Instance exists for this id.");
  }
  return repo.bindVoter({ instanceId, authUserId: identity.authUserId });
}
