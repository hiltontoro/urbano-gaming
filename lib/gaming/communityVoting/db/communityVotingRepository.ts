import type {
  CastCommunityVoteInput,
  CastCommunityVoteResult,
  ClaimedEntry,
  CommunityVotingInstanceRecord,
  ConfirmedEntry,
  CreatedEntry,
  IssuedIntent,
  PreparationEntry,
  RegisterInstanceInput,
  StartedVoting,
  VoterBindingResult,
  VoterStatusSnapshot,
} from "../types";

/**
 * Persistence boundary for the Community Voting Experience Instance.
 *
 * Every mutating operation is authoritative inside its own atomic implementation (SQL function /
 * serialized in-memory section): Session-first lock order, re-validation of every precondition, and
 * rollback of the whole operation on any failure. Domain functions are a fast path only.
 *
 * The lifecycle this interface exposes is exactly:
 *
 *   register -> bind voters -> PREPARE (create entries, contestants claim, host confirms) -> START -> vote
 *
 * PREPARE writes readiness data only (preparation entries); it never opens anything and never creates a
 * candidate or a vote. START is the single explicit, host-authorized, atomic operation that materializes the
 * authoritative Voting candidates — already attributed — and opens the Session's Voting interaction. After
 * it, no operation on this interface can change the ballot or any attribution.
 *
 * There is intentionally no operation here that writes a vote directly: castVote delegates to the unchanged
 * Session/Voting `cast_vote_atomically`. Participant tokens never cross this interface in either direction.
 */
export interface CommunityVotingRepository {
  /** Binds one Instance to one Session. Host-authorized; Session-first lock. */
  registerInstance(input: RegisterInstanceInput): Promise<CommunityVotingInstanceRecord>;

  /** Idempotent: an existing (instance, authUser) binding is returned unchanged. */
  bindVoter(input: { instanceId: string; authUserId: string }): Promise<VoterBindingResult>;

  /** Issues the next server-ordered intent number for the caller's binding. Refused unless voting is open. */
  issueIntent(input: { instanceId: string; authUserId: string }): Promise<IssuedIntent>;

  // ---- preparation (host-authorized unless stated; all refused with PREPARATION_CLOSED once Voting has opened)

  /** Adds one entry to the ballot and returns its single-use claim credential — once. */
  createEntry(input: { instanceId: string; hostToken: string; label: string; claimTtlSeconds?: number }): Promise<CreatedEntry>;
  removeEntry(input: { instanceId: string; hostToken: string; entryId: string }): Promise<void>;
  /** The host's view: labels and states only. No identity, no secret. */
  readPreparation(input: { instanceId: string; hostToken: string }): Promise<PreparationEntry[]>;
  /** The CONTESTANT's act (authenticated, bound): consumes the claim credential and returns the confirmation code once. */
  claimEntry(input: { instanceId: string; authUserId: string; claimCode: string }): Promise<ClaimedEntry>;
  /** The host confirms the intended entry against the code shown on the claimant's own screen. */
  confirmEntry(input: { instanceId: string; hostToken: string; entryId: string; confirmationCode: string }): Promise<ConfirmedEntry>;

  // ---- opening

  /** The explicit atomic start: validate, materialize attributed candidates, open the Session's Voting interaction. */
  startVoting(input: { instanceId: string; hostToken: string; promptText: string }): Promise<StartedVoting>;

  // ---- voting

  /** The single cast path: validate, evaluate location, delegate, record recovery metadata — atomically. */
  castVote(input: CastCommunityVoteInput & { authUserId: string }): Promise<CastCommunityVoteResult>;

  /** The caller's own bounded snapshot, or null when the caller has no binding to this Instance. */
  readVoterStatus(input: { instanceId: string; authUserId: string }): Promise<VoterStatusSnapshot | null>;
}
