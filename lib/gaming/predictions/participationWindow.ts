import { ParticipationNotOpenError } from "./types";

/**
 * THE PARTICIPATION WINDOW OF AN APPROVED EVENT — enforced by the server, at the API boundary, before anything is written.
 *
 * The database closes a match at its start (a participation is refused from the instant of kickoff) and gates it on the venue activation and the
 * match's classification, but it has no OPENING time. For an event with an approved window this module adds the missing half where members' requests
 * arrive: a participation sent before the window opens is refused, whatever the page shows and whoever sends it.
 *
 * What it does and does not do:
 *  - It only ever says "not yet". It never opens anything: a match is open when its venue activation is enabled AND the window (if it has one) has
 *    opened. Reaching the time opens nothing by itself — the activation must be enabled by a person, and is created disabled for that reason.
 *  - It is keyed to the EXACT instant the approved event starts, not to team names: no spelling of a team can leave the window unenforced, and a
 *    match that starts at another instant is not touched by it. A match that does start at that instant is held to the window.
 *  - It lives in the application layer. Someone holding the database service role and calling the database function directly would not be stopped by
 *    it; a database-level opening time would need a schema change, which is only proposed (see the record).
 *
 * To approve another event's window, add it here (a reviewed change), not by configuration.
 */

export interface ApprovedParticipationWindow {
  /** What the event is, for people reading this list. */
  label: string;
  /** The exact instant the event starts (UTC): the key. */
  kickoffAt: string;
  /** The window opens this many minutes before the start and closes at the start. */
  opensMinutesBeforeKickoff: number;
}

export const APPROVED_PARTICIPATION_WINDOWS: readonly ApprovedParticipationWindow[] = [
  // El Clásico, FC Barcelona vs. Real Madrid CF, 2026-10-25: starts 2:00 p. m. in Honduras (20:00 UTC); the window is 12:30 p. m. to 2:00 p. m., Honduras.
  { label: "El Clásico — FC Barcelona vs. Real Madrid CF", kickoffAt: "2026-10-25T20:00:00.000Z", opensMinutesBeforeKickoff: 90 },
];

/** When participation opens for a match that starts at `kickoffAt`, or null if the match has no approved window. */
export function participationOpensAt(kickoffAt: string, windows: readonly ApprovedParticipationWindow[] = APPROVED_PARTICIPATION_WINDOWS): Date | null {
  const start = new Date(kickoffAt).getTime();
  if (Number.isNaN(start)) return null;
  const window = windows.find((candidate) => new Date(candidate.kickoffAt).getTime() === start);
  return window ? new Date(start - window.opensMinutesBeforeKickoff * 60_000) : null;
}

/** Throws ParticipationNotOpenError while the window of this match has not opened yet. After the opening it says nothing: the closing is the start of the match, judged where it always was. */
export function assertParticipationOpen(
  match: { kickoffAt: string },
  now: Date = new Date(),
  windows: readonly ApprovedParticipationWindow[] = APPROVED_PARTICIPATION_WINDOWS
): void {
  const opensAt = participationOpensAt(match.kickoffAt, windows);
  if (opensAt && now.getTime() < opensAt.getTime()) throw new ParticipationNotOpenError(opensAt);
}
