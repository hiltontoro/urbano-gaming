import { isUuidLike } from "../types";

/**
 * The activation operator allow-list.
 *
 * For this activation exactly one person (Hilton Toro) may operate: approve photographs, complete the contestant
 * association, open and close voting, withdraw a contestant and read the tally. The Instance records that person's
 * Gaming Member id when it is registered, and the database refuses every operator call from anyone else. THIS list
 * decides who may register such an Instance in the first place.
 *
 * It is read from COMMUNITY_VOTING_OPERATOR_MEMBER_IDS and FAILS CLOSED: unset, blank or containing any malformed
 * entry means NO ONE may register — a typo must never widen or silently shrink the set of operators.
 */
export function parseOperatorAllowlist(raw: unknown): Set<string> | null {
  if (typeof raw !== "string") return null;
  const entries = raw
    .split(",")
    .map((e) => e.trim())
    .filter((e) => e.length > 0);
  if (entries.length === 0) return null;
  if (!entries.every((e) => isUuidLike(e))) return null;
  return new Set(entries.map((e) => e.toLowerCase()));
}
