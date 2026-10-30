import { createHash } from "node:crypto";

/**
 * Per-voter candidate ordering.
 *
 * A single shared order puts the same contestants first for everyone — and an order by arrival or by anything
 * derived from votes would reward early registration or popularity. Instead each voter sees an independent,
 * uniformly random permutation that is nevertheless REPRODUCIBLE: it is a pure function of the event and the
 * voter, so an audit can recompute exactly what any voter was shown.
 *
 * Algorithm `fisher-yates-sha256-v1`:
 *   1. canonical base order = candidates sorted by candidate id (independent of the order rows were fetched in,
 *      and unrelated to arrival order, label or votes — this function receives no vote data at all);
 *   2. Fisher–Yates from the end; the random index at step i is the first four bytes of
 *      sha256("fisher-yates-sha256-v1|<instance>|<voter key>|<i>") scaled into [0, i].
 *
 * The voter key is an opaque per-event identifier of the voter (their binding id), never a phone, email or user id.
 */
export const ORDERING_ALGORITHM = "fisher-yates-sha256-v1";

export function orderCandidatesForVoter<T extends { candidateId: string }>(
  items: readonly T[],
  instanceId: string,
  voterKey: string
): T[] {
  const ordered = [...items].sort((a, b) => (a.candidateId < b.candidateId ? -1 : a.candidateId > b.candidateId ? 1 : 0));
  for (let i = ordered.length - 1; i > 0; i--) {
    const digest = createHash("sha256").update(`${ORDERING_ALGORITHM}|${instanceId}|${voterKey}|${i}`, "utf8").digest();
    const j = Math.floor((digest.readUInt32BE(0) / 0x1_0000_0000) * (i + 1));
    [ordered[i], ordered[j]] = [ordered[j], ordered[i]];
  }
  return ordered;
}
