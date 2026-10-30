import { HostTokenMismatchError } from "../../session/types";
import type { CommunityVotingRepository } from "./db/communityVotingRepository";
import type { ConfirmedEntry, CreatedEntry, PreparationView } from "./types";
import { CommunityVotingError, isUuidLike } from "./types";

/**
 * Host-side preparation of a Community Voting ballot — everything that happens BEFORE Voting opens.
 *
 * These are thin front doors: they validate the SHAPE of a request and hand one atomic operation to the
 * repository, which is the authority for every rule (Session-first locking, host authority, the freeze once
 * Voting has opened, the state of each entry). None of them opens anything, creates a candidate, or can be
 * the thing that "completes" a ballot into an open one: opening is `startCommunityVoting`, an explicit act.
 *
 * What the host sees is deliberately small: labels, states and whether a claim credential is still usable.
 * Never a phone, an Auth id, a binding, a Participant, or a secret. The claim credential returned by
 * createCommunityVotingEntry is shown ONCE; it is stored only as a digest and cannot be read again.
 */

function requireInstanceId(value: unknown): string {
  if (!isUuidLike(value)) {
    throw new CommunityVotingError("INSTANCE_NOT_FOUND", "No Community Voting Instance exists for this id.");
  }
  return value;
}

function requireHostToken(value: unknown): string {
  if (typeof value !== "string") throw new HostTokenMismatchError();
  return value;
}

function requireEntryId(value: unknown): string {
  if (!isUuidLike(value)) {
    throw new CommunityVotingError("ENTRY_NOT_FOUND", "This ballot has no such entry.");
  }
  return value;
}

/** Adds one entry to the ballot and returns its single-use claim credential. */
export async function createCommunityVotingEntry(
  repo: CommunityVotingRepository,
  input: { instanceId: unknown; hostToken: unknown; label: unknown; claimTtlSeconds?: unknown }
): Promise<CreatedEntry> {
  const instanceId = requireInstanceId(input.instanceId);
  const hostToken = requireHostToken(input.hostToken);

  if (typeof input.label !== "string") {
    throw new CommunityVotingError("ENTRY_LABEL_INVALID", "An entry label must be 1 to 60 characters.");
  }

  let claimTtlSeconds: number | undefined;
  if (input.claimTtlSeconds !== undefined) {
    if (
      typeof input.claimTtlSeconds !== "number" ||
      !Number.isInteger(input.claimTtlSeconds) ||
      input.claimTtlSeconds < 1 ||
      input.claimTtlSeconds > 86400
    ) {
      throw new CommunityVotingError("INVALID_REQUEST", "The claim window must be between 1 and 86400 seconds.");
    }
    claimTtlSeconds = input.claimTtlSeconds;
  }

  return repo.createEntry({ instanceId, hostToken, label: input.label, claimTtlSeconds });
}

export async function removeCommunityVotingEntry(
  repo: CommunityVotingRepository,
  input: { instanceId: unknown; hostToken: unknown; entryId: unknown }
): Promise<void> {
  return repo.removeEntry({
    instanceId: requireInstanceId(input.instanceId),
    hostToken: requireHostToken(input.hostToken),
    entryId: requireEntryId(input.entryId),
  });
}

/**
 * Confirms the intended entry against the code shown on the claimant's own screen. A malformed code is rejected
 * here, before the repository, and so is not counted as an attempt; a well-formed wrong code is counted by the
 * repository, five of them void the claim.
 */
export async function confirmCommunityVotingEntry(
  repo: CommunityVotingRepository,
  input: { instanceId: unknown; hostToken: unknown; entryId: unknown; confirmationCode: unknown }
): Promise<ConfirmedEntry> {
  const instanceId = requireInstanceId(input.instanceId);
  const hostToken = requireHostToken(input.hostToken);
  const entryId = requireEntryId(input.entryId);
  if (typeof input.confirmationCode !== "string" || input.confirmationCode.trim().length === 0) {
    throw new CommunityVotingError("INVALID_REQUEST", "A confirmation code is required.");
  }
  return repo.confirmEntry({ instanceId, hostToken, entryId, confirmationCode: input.confirmationCode });
}

/** The host's whole view of the ballot being prepared. Readiness is information only — it never opens anything. */
export async function readCommunityVotingPreparation(
  repo: CommunityVotingRepository,
  input: { instanceId: unknown; hostToken: unknown }
): Promise<PreparationView> {
  const entries = await repo.readPreparation({
    instanceId: requireInstanceId(input.instanceId),
    hostToken: requireHostToken(input.hostToken),
  });
  const confirmedCount = entries.filter((e) => e.state === "CONFIRMED").length;
  return {
    entries,
    readiness: {
      entryCount: entries.length,
      confirmedCount,
      ready: entries.length >= 2 && confirmedCount === entries.length,
    },
  };
}
