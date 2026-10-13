import type { CompetitionRecord } from "./types";

type OrganizerFields = Pick<CompetitionRecord, "organizerGamingMemberId" | "hostAccessRevoked">;
type ListingFields = OrganizerFields & Pick<CompetitionRecord, "state" | "hostBound">;

/**
 * UG-CR-GATE-088 — the single TypeScript-side answer to "does this caller
 * currently hold organizer access to this competition?". It replaces the four
 * verbatim `organizerGamingMemberId === caller` comparisons (the competition
 * view, the list, fixture admin detail and team join-request reads), so a
 * former host whose hosting access has been revoked stops reading organizer-only
 * data in all four places at once. The database independently refuses every
 * organizer mutation for such a host (assert_competition_not_host_revoked); this
 * helper only governs what these routes may show.
 */
export function isActiveOrganizer(competition: OrganizerFields | null | undefined, callerGamingMemberId: string): boolean {
  if (!competition) return false;
  return competition.organizerGamingMemberId === callerGamingMemberId && competition.hostAccessRevoked !== true;
}

/**
 * Whether a competition appears in the caller's competition list.
 *  - A competition created through a host capability is a private pilot. It is never
 *    enumerable: it is listed only to its own organizer and to members who hold a role
 *    in it (registrant, team member or captain, join requester, proposer, or appointed
 *    scorekeeper — `involvedCompetitionIds`). Every such role is reached only through the
 *    invitation link or an appointment, so a stranger never sees it, while an assigned
 *    scorekeeper or a returning player can find the competition they belong to.
 *  - Any other competition keeps the existing rule: a DRAFT is organizer-only, every
 *    other state is listed to every signed-in member.
 */
export function isListedFor(
  competition: ListingFields & Pick<CompetitionRecord, "competitionId">,
  callerGamingMemberId: string,
  involvedCompetitionIds: ReadonlySet<string> = EMPTY_SET
): boolean {
  if (competition.hostBound === true) {
    return competition.organizerGamingMemberId === callerGamingMemberId || involvedCompetitionIds.has(competition.competitionId);
  }
  return competition.state !== "DRAFT" || competition.organizerGamingMemberId === callerGamingMemberId;
}

const EMPTY_SET: ReadonlySet<string> = new Set();

/**
 * What a browser may be told about a competition. The host-binding and revocation flags
 * are server-side facts used for authorization and listing only; they are never part of a
 * response, so nobody can tell from the API which competitions are host pilots or whether
 * a host's access has been revoked.
 */
export function toPublicCompetition<T extends Partial<Pick<CompetitionRecord, "hostBound" | "hostAccessRevoked">>>(
  competition: T
): Omit<T, "hostBound" | "hostAccessRevoked"> {
  const { hostBound: _hostBound, hostAccessRevoked: _hostAccessRevoked, ...rest } = competition;
  return rest;
}
