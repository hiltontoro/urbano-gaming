/**
 * The phase of a round as a voter or visitor experiences it, derived from the Session, the Voting interaction and the SERVER'S
 * deadline. There is no "preparing while open" phase: OPEN means votes are actually accepted.
 *
 * The deadline binds BOTH rounds: for the preliminary it is the configured closing time, for the final it is the explicit opening plus
 * the window. It is judged against the server's clock as reported in the same answer (`serverNow`), never the browser's: a phone with a
 * wrong clock must not decide that a round is open or over. The database enforces the same deadline on every vote; this is only what
 * the screen shows. A round that is scheduled but has not been opened by the operator is NOT_OPEN, however near its time is.
 */
export type RoundPhase = "NOT_OPEN" | "OPEN" | "CLOSED" | "ENDED";

export interface RoundPhaseInput {
  sessionState: string;
  interactionState: string | null;
  closed: boolean;
  deadlineAt: string | null;
  serverNow: string;
}

export function deriveRoundPhase(info: RoundPhaseInput): RoundPhase {
  if (info.sessionState === "SESSION_COMPLETE") return "ENDED";
  if (info.closed || info.interactionState === "SUBMISSIONS_CLOSED" || info.interactionState === "RESULT_REVEAL") return "CLOSED";
  if (info.interactionState === "PROMPT_ACTIVE") {
    // Strictly before the deadline is open; at it and after it is not (the database's own rule). No deadline fails closed.
    if (info.deadlineAt === null || !(Date.parse(info.serverNow) < Date.parse(info.deadlineAt))) return "CLOSED";
    return "OPEN";
  }
  return "NOT_OPEN";
}

/** Milliseconds left until the deadline according to the server's clock; null when there is no deadline yet. Never negative. */
export function deadlineRemainingMs(info: { deadlineAt: string | null; serverNow: string }): number | null {
  if (info.deadlineAt === null) return null;
  return Math.max(0, Date.parse(info.deadlineAt) - Date.parse(info.serverNow));
}
