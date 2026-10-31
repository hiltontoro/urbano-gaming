import { createHash } from "node:crypto";

/**
 * The canonical payload commitment of an intent: the Instance, the Voting interaction and the
 * candidate, version-prefixed. It is the TypeScript twin of the digest cast_community_voting_vote_atomically
 * computes in SQL (sha256 hex of the same string); identifiers are lower-cased because Postgres renders
 * uuids in lower case. It is a bounded commitment, not a copy of the selection: it exists so a replay of
 * an applied intent can be recognised and a re-use with a different payload refused.
 */
export function payloadDigest(
  instanceId: string,
  interactionInstanceId: string,
  candidateId: string
): string {
  return createHash("sha256")
    .update(
      `cv1|${instanceId.toLowerCase()}|${interactionInstanceId.toLowerCase()}|${candidateId.toLowerCase()}`,
      "utf8"
    )
    .digest("hex");
}
