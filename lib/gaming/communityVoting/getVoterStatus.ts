import type { SessionRepository } from "../../session/db/sessionRepository";
import type { CommunityVotingRepository } from "./db/communityVotingRepository";
import type { CommunityVotingStatus, VotingPhase } from "./types";
import { CommunityVotingError, isUuidLike } from "./types";
import { resolveVerifiedVoter, type VoterIdentityVerifier } from "./verifiedIdentity";

/**
 * GET_COMMUNITY_VOTING_STATUS. Authenticated status recovery from the EXISTING Voting store.
 *
 * Returns ONLY the caller's own bounded state: whether they are bound, the phase, the candidates (the
 * same labels GET_SESSION shows participants), their own current selection, their own preparation entry (label
 * and state) and their intent counters.
 *
 * The phase is derived from the Session and the Voting interaction ALONE. There is no preparation phase: until the
 * Session has opened Voting the phase is NOT_OPEN — even for a ballot that is fully prepared and confirmed — and the
 * candidates are not shown, because there are none yet (the entries are readiness data, not candidates).
 * It is recoverable after a lost response, on a new authenticated session for the same Auth user, and
 * after close for an already-committed vote. It exposes no Participant token, no opaque label, no
 * Participant id, no other voter, and no tally before the Session reveals.
 *
 * Results mirror GET_SESSION's reveal gate exactly (LOBBY_LOCKED + RESULT_REVEAL) and are produced by
 * the existing tally (getVotingResultsForInteractionInstance) — there is no second tally here.
 */
export async function getCommunityVotingStatus(
  repo: CommunityVotingRepository,
  sessionRepo: SessionRepository,
  verifier: VoterIdentityVerifier,
  authorizationHeader: string | null | undefined,
  instanceId: string
): Promise<CommunityVotingStatus> {
  const identity = await resolveVerifiedVoter(verifier, authorizationHeader);
  if (!isUuidLike(instanceId)) {
    throw new CommunityVotingError("INSTANCE_NOT_FOUND", "No Community Voting Instance exists for this id.");
  }

  const snapshot = await repo.readVoterStatus({ instanceId, authUserId: identity.authUserId });
  if (!snapshot) {
    return {
      bound: false,
      instanceId,
      phase: null,
      interactionInstanceId: null,
      candidates: null,
      myCandidateId: null,
      myEntry: null,
      intents: null,
      bindingId: null,
      results: null,
    };
  }

  const isVoting = snapshot.interactionInstanceId !== null && snapshot.engineType === "VOTING";

  let phase: VotingPhase;
  if (snapshot.sessionState === "SESSION_COMPLETE") {
    phase = "ENDED";
  } else if (!isVoting) {
    phase = "NOT_OPEN";
  } else if (snapshot.interactionState === "PROMPT_ACTIVE") {
    phase = "OPEN";
  } else if (snapshot.interactionState === "SUBMISSIONS_CLOSED") {
    phase = "CLOSED";
  } else if (snapshot.interactionState === "RESULT_REVEAL" && snapshot.sessionState === "LOBBY_LOCKED") {
    phase = "PUBLISHED";
  } else {
    phase = "NOT_OPEN";
  }

  const candidates = isVoting
    ? (await sessionRepo.getVotingCandidatesForInteraction(snapshot.interactionInstanceId as string))
        .map((c) => ({ candidateId: c.candidateId, ordinal: c.ordinal, label: c.label }))
        .sort((a, b) => a.ordinal - b.ordinal)
    : null;

  const results =
    phase === "PUBLISHED" && isVoting
      ? (await sessionRepo.getVotingResultsForInteractionInstance(snapshot.interactionInstanceId as string)).map(
          (r) => ({ candidateId: r.candidateId, label: r.label, voteCount: r.voteCount, rank: r.rank })
        )
      : null;

  return {
    bound: true,
    instanceId,
    phase,
    interactionInstanceId: snapshot.interactionInstanceId,
    candidates,
    myCandidateId: snapshot.myCandidateId,
    myEntry: snapshot.myEntry,
    intents: { issued: snapshot.issuedIntentNo, applied: snapshot.appliedIntentNo },
    bindingId: snapshot.bindingId,
    results,
  };
}
