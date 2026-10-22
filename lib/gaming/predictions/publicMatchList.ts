import type { MatchRecord } from "./types";

/**
 * The public match list never offers a cancelled Match. Applied to the
 * raw match rows, before any per-match Team/Player/Activation/Venue/Tier
 * fan-out, so a cancelled Match costs no further queries. The admin
 * surface keeps using the unfiltered repository list.
 */
export function selectPublicMatches(matches: MatchRecord[]): MatchRecord[] {
  return matches.filter((match) => !match.cancelledAt);
}
