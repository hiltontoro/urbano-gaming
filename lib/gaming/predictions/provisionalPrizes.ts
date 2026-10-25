/**
 * PROVISIONAL PRIZES — a notice, never an offer.
 *
 * A venue can propose prizes before it has confirmed them. While that is so, the member must be told, wherever the prizes are listed and before
 * anything is sent, that the prizes are proposed, that the venue has not yet confirmed them and that the participation creates no right to a
 * prize. This module decides only WHICH matches carry that notice; the prizes themselves are ordinary data of the match (its prize tiers) and
 * nothing here creates, edits or enables any of them, and nothing here changes how a participation is evaluated: one prize per participant, the
 * one of the highest level got right in order, no quota and no draw.
 *
 * It is inert until it is told otherwise. The notice is shown for a match only when its id is named, exactly, in GAMING_PROVISIONAL_PRIZE_MATCH_IDS
 * (comma-separated ids). Unset, empty or malformed, no match carries it. So shipping this code turns nothing on: the variable is set, per match,
 * as a deliberate step, and is not set in any provider by this work.
 */

export const PROVISIONAL_PRIZE_MATCHES_ENV = "GAMING_PROVISIONAL_PRIZE_MATCH_IDS";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** The ids named in the variable: exact, canonical ids only (anything else — a prefix, a pattern, a name — is ignored, never interpreted). */
export function provisionalPrizeMatchIds(env: Record<string, string | undefined> = process.env): Set<string> {
  const raw = env[PROVISIONAL_PRIZE_MATCHES_ENV];
  if (typeof raw !== "string") return new Set();
  return new Set(
    raw
      .split(",")
      .map((part) => part.trim().toLowerCase())
      .filter((part) => UUID.test(part))
  );
}

export function hasProvisionalPrizes(matchId: string, ids: Set<string> = provisionalPrizeMatchIds()): boolean {
  return ids.has(matchId.toLowerCase());
}
