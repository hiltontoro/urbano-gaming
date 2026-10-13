import type { HostApplicationInput } from "./types";
import { InvalidHostApplicationError } from "./types";

/**
 * The bounds below are the same bounds the database enforces (both in
 * submit_host_application_atomically and as CHECK constraints on
 * competition_host_applications). They are repeated here so a bad submission is
 * rejected with a precise field name before any database round trip; the
 * database remains the authority.
 */
export const HOST_APPLICATION_LIMITS = {
  venueName: { min: 2, max: 80 },
  cityArea: { min: 2, max: 80 },
  playingFields: { min: 1, max: 50 },
  venueDescription: { min: 20, max: 800 },
  expectedWindow: { min: 3, max: 100 },
  expectedTeamCount: { min: 4, max: 16 },
} as const;

// A NUL byte cannot be stored in a Postgres text column (it would surface as a
// 500 instead of a precise field error), and a control character has no place in
// a single-line field. The multi-line description may keep tab, line feed and
// carriage return. Everything else, including markup and quotes, is ordinary
// text: it is stored literally and rendered only through textContent.
const CONTROL_CHARACTERS_SINGLE_LINE = /[\u0000-\u001F\u007F]/;
const CONTROL_CHARACTERS_MULTI_LINE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;

function text(value: unknown, field: keyof typeof HOST_APPLICATION_LIMITS, multiLine = false): string {
  if (typeof value !== "string") throw new InvalidHostApplicationError(field);
  const trimmed = value.trim();
  const { min, max } = HOST_APPLICATION_LIMITS[field];
  if (trimmed.length < min || trimmed.length > max) throw new InvalidHostApplicationError(field);
  if ((multiLine ? CONTROL_CHARACTERS_MULTI_LINE : CONTROL_CHARACTERS_SINGLE_LINE).test(trimmed)) {
    throw new InvalidHostApplicationError(field);
  }
  return trimmed;
}

function wholeNumber(value: unknown, field: keyof typeof HOST_APPLICATION_LIMITS): number {
  if (typeof value !== "number" || !Number.isInteger(value)) throw new InvalidHostApplicationError(field);
  const { min, max } = HOST_APPLICATION_LIMITS[field];
  if (value < min || value > max) throw new InvalidHostApplicationError(field);
  return value;
}

/**
 * Validates an untrusted submission and returns the normalized input. Anything
 * not on this list is ignored: the only fields collected are the ones needed to
 * evaluate a pilot (no identity documents, finances, rosters, or contact data).
 * All three confirmations must be exactly true.
 */
export function validateHostApplication(raw: unknown): HostApplicationInput {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new InvalidHostApplicationError("application");
  }
  const r = raw as Record<string, unknown>;
  const input: HostApplicationInput = {
    venueName: text(r.venueName, "venueName"),
    cityArea: text(r.cityArea, "cityArea"),
    playingFields: wholeNumber(r.playingFields, "playingFields"),
    venueDescription: text(r.venueDescription, "venueDescription", true),
    expectedWindow: text(r.expectedWindow, "expectedWindow"),
    expectedTeamCount: wholeNumber(r.expectedTeamCount, "expectedTeamCount"),
    confirmAllAdults: r.confirmAllAdults === true,
    confirmIndependentScorekeepers: r.confirmIndependentScorekeepers === true,
    confirmPilotExclusions: r.confirmPilotExclusions === true,
  };
  if (!input.confirmAllAdults || !input.confirmIndependentScorekeepers || !input.confirmPilotExclusions) {
    throw new InvalidHostApplicationError("confirmations");
  }
  return input;
}
