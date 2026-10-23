import { createHash } from "node:crypto";

import type { CompetitionsRepository, CompetitionPlanningStore } from "./db/competitionsRepository";
import type { CompetitionPlanningPlan, CompetitionPlanningRevisionRecord, SavePlanningRevisionResult } from "./types";
import { CompetitionAccessDeniedError, CompetitionNotDraftError, CompetitionNotFoundError, HostAccessRevokedError } from "./types";
import { getSoccerFormatRule, isSoccerFormatKey, type SoccerFormatKey } from "./formats";
import { isActiveOrganizer } from "./organizerAccess";

/**
 * UG-CR-GATE-SSS-004 — Organizer Planning foundation: the validation, the revision payload and the two commands behind the planning route.
 *
 * A plan is the organizer's DRAFT PLAN for ONE competition: a venue and its time zone, pitches, one to three tournament dates with one or two
 * operating windows each, the roster size configured within the format's registry ranges, a registration deadline, and the rules the plan was
 * made under. It is not venue approval, not a verified claim, and not a schedule: it records validated planning capacity only.
 *
 * What a plan can NEVER carry: the competition's format (it is derived from the competition, here and in the database) and the format's fixed
 * timing (it stays in the registry). Both are refused wherever they appear, by name, so a client cannot even attempt to supply them.
 *
 * The same rules are enforced again inside the atomic save operation in the database; this module exists so the organizer gets every problem at
 * once, in plain words, before anything is sent. Errors are defined here, not in types.ts: the planning route owns their wording and status.
 */

export const PLANNING_LIMITS = Object.freeze({
  maxDates: 3,
  maxSpanDays: 14,
  maxWindowsPerDate: 2,
  maxPitches: 16,
  venueNameMax: 120,
  locationMax: 300,
  venueNotesMax: 500,
  pitchLabelMax: 40,
  pitchNotesMax: 300,
  rulesVersionMax: 32,
  rulesSnapshotMax: 4000,
});

export interface PlanningViolation {
  /** A path into the plan, e.g. "dates[1].windows[0].start" ("plan" for the whole plan). */
  field: string;
  /** A stable machine code, e.g. "WINDOW_OVERLAP". */
  code: string;
  /** A plain sentence for the organizer. */
  message: string;
}

/** Every reason a plan (or the request carrying it) is not acceptable. Always a 400 at the boundary. */
export class PlanningValidationError extends Error {
  readonly violations: readonly PlanningViolation[];
  constructor(violations: readonly PlanningViolation[]) {
    super("The plan is not valid.");
    this.name = "PlanningValidationError";
    this.violations = violations;
  }
}

/** The same save identifier was used for a different plan. Always a 409; it says nothing about the earlier plan. */
export class PlanningIntentMismatchError extends Error {
  constructor() {
    super("This save was already used for a different plan. Review the saved plan and save again.");
    this.name = "PlanningIntentMismatchError";
  }
}

const FORMAT_KEY_FIELDS: ReadonlySet<string> = new Set(["format", "formatKey", "activityKey", "competitionFormat"]);
const TIMING_FIELDS: ReadonlySet<string> = new Set([
  "timing", "halves", "minutesPerHalf", "halftimeMinutes", "pitchTransitionMinutes", "minimumTeamRestMinutes", "knockoutShootoutReserveMinutes",
]);

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const TIME_ZONE_SHAPE = /^[A-Z][A-Za-z0-9_+-]*(?:\/[A-Z][A-Za-z0-9_+-]*){1,2}$/;
const DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const LOCAL_PATTERN = /^(\d{4})-(\d{2})-(\d{2})T([01]\d|2[0-3]):([0-5]\d)$/;
const OFFSET_PATTERN = /^([+-])(\d{2}):(\d{2})$/;
const UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const RULES_VERSION_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;
const SINGLE_LINE_FORBIDDEN = /[\u0000-\u001F\u007F]/;
const MULTI_LINE_FORBIDDEN = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const FIRST_YEAR = 2020;
const LAST_YEAR = 2099;
const DAY_MS = 86_400_000;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

const codePoints = (text: string) => [...text].length;

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Time zones and venue-local time
// ---------------------------------------------------------------------------------------------------------------------------------------------

const formatters = new Map<string, Intl.DateTimeFormat>();
function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat("en-US", {
      timeZone, hourCycle: "h23", year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", second: "numeric",
    });
    formatters.set(timeZone, formatter);
  }
  return formatter;
}

/** A canonical-looking IANA name (Area/Location, no abbreviations such as EST or UTC+2) that the runtime's time zone database knows. */
export function isValidIanaTimeZone(value: unknown): value is string {
  if (typeof value !== "string" || !TIME_ZONE_SHAPE.test(value)) return false;
  try {
    formatterFor(value);
    return true;
  } catch {
    return false;
  }
}

/** The zone's offset from UTC, in minutes, at one instant. */
function offsetMinutesAt(epochMs: number, timeZone: string): number {
  const parts = formatterFor(timeZone).formatToParts(new Date(epochMs));
  const part = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(part("year"), part("month") - 1, part("day"), part("hour") % 24, part("minute"), part("second"));
  return Math.round((asUtc - Math.floor(epochMs / 1000) * 1000) / 60_000);
}

export interface ResolvedInstant { utc: string; offsetMinutes: number }
export interface ResolvedLocalTime {
  /** "ok": exactly one instant. "ambiguous": the clocks show this time twice. "nonexistent": the clocks skip it. */
  kind: "ok" | "ambiguous" | "nonexistent";
  instants: ResolvedInstant[];
}

function localParts(local: string): { y: number; m: number; d: number; h: number; mi: number } | null {
  const match = LOCAL_PATTERN.exec(local);
  if (!match) return null;
  const [y, m, d, h, mi] = match.slice(1).map(Number);
  return realDay(y, m, d) ? { y, m, d, h, mi } : null;
}

function realDay(y: number, m: number, d: number): boolean {
  if (y < FIRST_YEAR || y > LAST_YEAR) return false;
  const probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

/** Which instants a venue-local wall-clock time (YYYY-MM-DDTHH:MM) can mean in a zone: one, two (the clocks repeat it) or none (they skip it). */
export function resolveLocalTime(local: string, timeZone: string): ResolvedLocalTime {
  const parts = localParts(local);
  if (!parts || !isValidIanaTimeZone(timeZone)) throw new RangeError("A real venue-local time and a valid time zone are required.");
  const naive = Date.UTC(parts.y, parts.m - 1, parts.d, parts.h, parts.mi);
  const found = new Map<number, number>();
  // The offset can differ on either side of a clock change, so each plausible offset is tried and kept only if it holds at the instant it implies.
  for (const probe of [naive - 36 * 3_600_000, naive, naive + 36 * 3_600_000]) {
    const offset = offsetMinutesAt(probe, timeZone);
    const instant = naive - offset * 60_000;
    if (offsetMinutesAt(instant, timeZone) === offset) found.set(instant, offset);
  }
  const instants = [...found.entries()].sort((a, b) => a[0] - b[0]).map(([instant, offsetMinutes]) => ({ utc: new Date(instant).toISOString(), offsetMinutes }));
  return { kind: instants.length === 0 ? "nonexistent" : instants.length === 1 ? "ok" : "ambiguous", instants };
}

export function formatUtcOffset(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `${sign}${String(Math.floor(abs / 60)).padStart(2, "0")}:${String(abs % 60).padStart(2, "0")}`;
}

/** ±HH:MM within ±14:00, as minutes; null if it is anything else. */
export function parseUtcOffset(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const match = OFFSET_PATTERN.exec(value);
  if (!match) return null;
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  if (Number(match[3]) > 59 || minutes > 14 * 60) return null;
  return match[1] === "-" ? -minutes : minutes;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------------------------------------------------------------

type Violations = PlanningViolation[];
const add = (v: Violations, field: string, code: string, message: string) => { v.push({ field, code, message }); };

function checkKeys(obj: Record<string, unknown>, allowed: readonly string[], path: string, v: Violations) {
  for (const key of Object.keys(obj)) {
    if (allowed.includes(key)) continue;
    const field = path ? `${path}.${key}` : key;
    if (FORMAT_KEY_FIELDS.has(key)) add(v, field, "FORMAT_NOT_EDITABLE", "The format is set by the competition and cannot be chosen or changed in a plan.");
    else if (TIMING_FIELDS.has(key)) add(v, field, "TIMING_NOT_EDITABLE", "Match timing is fixed by the format rules and cannot be changed in a plan.");
    else add(v, field, "UNKNOWN_FIELD", "This field is not part of a plan.");
  }
}

interface TextOptions { required: boolean; max: number; multiline: boolean; label: string }

/** Trimmed text with normalized line endings, or null (with the reason recorded) if it is missing, over-long or holds forbidden characters. */
function cleanText(raw: unknown, field: string, o: TextOptions, v: Violations): string {
  if (raw === undefined || raw === null || typeof raw !== "string") {
    if (o.required) add(v, field, "REQUIRED", `Enter the ${o.label}.`);
    else if (raw !== undefined && raw !== null) add(v, field, "INVALID_TEXT", `The ${o.label} must be text.`);
    return "";
  }
  const text = raw.replace(/\r\n?/g, "\n").trim();
  if (text === "") {
    if (o.required) add(v, field, "REQUIRED", `Enter the ${o.label}.`);
    return "";
  }
  if ((o.multiline ? MULTI_LINE_FORBIDDEN : SINGLE_LINE_FORBIDDEN).test(text)) {
    add(v, field, "INVALID_TEXT", `The ${o.label} contains characters that are not allowed.`);
    return "";
  }
  if (codePoints(text) > o.max) {
    add(v, field, "TOO_LONG", `The ${o.label} can have at most ${o.max} characters.`);
    return "";
  }
  return text;
}

function wholeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) ? value : null;
}

function minutesOf(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h * 60 + m;
}

/**
 * Judges a plan for a competition of the given format and returns it normalized: text trimmed, dates and windows in ascending order, pitch
 * format sets de-duplicated and sorted, the roster values explicit (registry defaults filled in), and the registration deadline resolved to
 * its one authoritative UTC instant. Throws a PlanningValidationError listing EVERY problem found; throws UnsupportedSoccerFormatError for a
 * format the registry does not know (a caller bug, never organizer input).
 */
export function parsePlanningPlan(raw: unknown, formatKey: SoccerFormatKey): CompetitionPlanningPlan {
  const rule = getSoccerFormatRule(formatKey);
  if (!isPlainObject(raw)) throw new PlanningValidationError([{ field: "plan", code: "PLAN_NOT_OBJECT", message: "The plan must be an object." }]);
  const v: Violations = [];
  checkKeys(raw, ["venue", "pitches", "dates", "roster", "registrationDeadline", "rules"], "", v);

  // Venue ------------------------------------------------------------------------------------------------------------------------------
  let venueName = "", location = "", venueNotes = "", timeZone: string | null = null;
  let capacityRaw: unknown;
  if (!isPlainObject(raw.venue)) {
    add(v, "venue", "REQUIRED", "Enter the venue details.");
  } else {
    const venue = raw.venue;
    checkKeys(venue, ["name", "locationDescription", "timeZone", "simultaneousMatchCapacity", "restrictionNotes"], "venue", v);
    venueName = cleanText(venue.name, "venue.name", { required: true, max: PLANNING_LIMITS.venueNameMax, multiline: false, label: "venue name" }, v);
    location = cleanText(venue.locationDescription, "venue.locationDescription", { required: true, max: PLANNING_LIMITS.locationMax, multiline: true, label: "venue location description" }, v);
    venueNotes = cleanText(venue.restrictionNotes, "venue.restrictionNotes", { required: false, max: PLANNING_LIMITS.venueNotesMax, multiline: true, label: "venue restriction notes" }, v);
    if (isValidIanaTimeZone(venue.timeZone)) timeZone = venue.timeZone;
    else add(v, "venue.timeZone", "INVALID_TIMEZONE", "Enter a valid time zone name such as America/Costa_Rica.");
    capacityRaw = venue.simultaneousMatchCapacity;
  }

  // Pitches ----------------------------------------------------------------------------------------------------------------------------
  const pitches: CompetitionPlanningPlan["pitches"] = [];
  let usableCount = 0;
  let formatSupported = false;
  if (!Array.isArray(raw.pitches) || raw.pitches.length === 0) {
    add(v, "pitches", "NO_PITCHES", "Add at least one pitch.");
  } else if (raw.pitches.length > PLANNING_LIMITS.maxPitches) {
    add(v, "pitches", "TOO_MANY_PITCHES", `A plan can have at most ${PLANNING_LIMITS.maxPitches} pitches.`);
  } else {
    const seen = new Set<string>();
    raw.pitches.forEach((entry: unknown, i: number) => {
      const at = `pitches[${i}]`;
      const where = `Pitch ${i + 1}`;
      if (!isPlainObject(entry)) { add(v, at, "INVALID", `${where} is not valid.`); return; }
      checkKeys(entry, ["label", "usable", "supportedFormats", "restrictionNotes"], at, v);
      const label = cleanText(entry.label, `${at}.label`, { required: true, max: PLANNING_LIMITS.pitchLabelMax, multiline: false, label: `${where} label` }, v);
      if (label) {
        if (seen.has(label.toLowerCase())) add(v, `${at}.label`, "DUPLICATE_LABEL", `${where}: another pitch already has the label “${label}”.`);
        seen.add(label.toLowerCase());
      }
      const notes = cleanText(entry.restrictionNotes, `${at}.restrictionNotes`, { required: false, max: PLANNING_LIMITS.pitchNotesMax, multiline: true, label: `${where} restriction notes` }, v);
      let usable = false;
      if (typeof entry.usable === "boolean") usable = entry.usable;
      else add(v, `${at}.usable`, "INVALID", `${where}: say whether the pitch is usable.`);
      const formats: SoccerFormatKey[] = [];
      if (!Array.isArray(entry.supportedFormats)) {
        add(v, `${at}.supportedFormats`, "REQUIRED", `${where}: choose at least one format the pitch is suitable for.`);
      } else {
        let unsupported = false;
        for (const key of entry.supportedFormats) {
          if (isSoccerFormatKey(key)) { if (!formats.includes(key)) formats.push(key); } else unsupported = true;
        }
        if (unsupported) add(v, `${at}.supportedFormats`, "UNSUPPORTED_FORMAT_KEY", `${where} lists a format that is not supported.`);
        else if (usable && formats.length === 0) add(v, `${at}.supportedFormats`, "REQUIRED", `${where}: a usable pitch must be suitable for at least one format.`);
      }
      formats.sort();
      if (usable) {
        usableCount += 1;
        if (formats.includes(formatKey)) formatSupported = true;
      }
      pitches.push({ label, usable, supportedFormats: formats, restrictionNotes: notes });
    });
    if (usableCount === 0) add(v, "pitches", "NO_USABLE_PITCH", "At least one pitch must be usable.");
    else if (!formatSupported) add(v, "pitches", "FORMAT_NOT_SUPPORTED_BY_ANY_USABLE_PITCH", "At least one usable pitch must be suitable for this competition's format.");
  }

  // Capacity ---------------------------------------------------------------------------------------------------------------------------
  const capacity = wholeNumber(capacityRaw);
  if (isPlainObject(raw.venue) && (capacity === null || capacity < 1 || capacity > usableCount)) {
    add(v, "venue.simultaneousMatchCapacity", "CAPACITY_INVALID", `Simultaneous matches must be a whole number from 1 up to the number of usable pitches (${usableCount}).`);
  }

  // Dates and windows ------------------------------------------------------------------------------------------------------------------
  const dates: CompetitionPlanningPlan["dates"] = [];
  let firstWindowStart = null as string | null;
  if (!Array.isArray(raw.dates) || raw.dates.length < 1 || raw.dates.length > PLANNING_LIMITS.maxDates) {
    add(v, "dates", "DATE_COUNT_INVALID", `A plan has one to ${PLANNING_LIMITS.maxDates} tournament dates.`);
  } else {
    const seenDates = new Set<string>();
    const days: number[] = [];
    raw.dates.forEach((entry: unknown, i: number) => {
      const at = `dates[${i}]`;
      const where = `Date ${i + 1}`;
      if (!isPlainObject(entry)) { add(v, at, "INVALID_DATE", `${where} is not valid.`); return; }
      checkKeys(entry, ["date", "windows"], at, v);
      const dateMatch = typeof entry.date === "string" ? DATE_PATTERN.exec(entry.date) : null;
      const valid = !!dateMatch && realDay(Number(dateMatch[1]), Number(dateMatch[2]), Number(dateMatch[3]));
      if (!valid) { add(v, `${at}.date`, "INVALID_DATE", `${where} must be a real calendar day written YYYY-MM-DD.`); }
      const date = valid ? (entry.date as string) : "";
      if (valid) {
        if (seenDates.has(date)) add(v, `${at}.date`, "DUPLICATE_DATE", `${where}: ${date} is listed twice.`);
        seenDates.add(date);
        days.push(Date.UTC(Number(dateMatch![1]), Number(dateMatch![2]) - 1, Number(dateMatch![3])) / DAY_MS);
      }
      const windows: Array<{ start: string; end: string; index: number }> = [];
      if (!Array.isArray(entry.windows) || entry.windows.length < 1 || entry.windows.length > PLANNING_LIMITS.maxWindowsPerDate) {
        add(v, `${at}.windows`, "WINDOW_COUNT_INVALID", `${where}: add one or two operating windows.`);
      } else {
        entry.windows.forEach((w: unknown, j: number) => {
          const wat = `${at}.windows[${j}]`;
          const wwhere = `${where}, window ${j + 1}`;
          if (!isPlainObject(w)) { add(v, wat, "INVALID_TIME", `${wwhere} is not valid.`); return; }
          checkKeys(w, ["start", "end"], wat, v);
          const startOk = typeof w.start === "string" && TIME_PATTERN.test(w.start);
          const endOk = typeof w.end === "string" && TIME_PATTERN.test(w.end);
          if (!startOk) add(v, `${wat}.start`, "INVALID_TIME", `${wwhere}: the start must be a time written HH:MM on a 24-hour clock.`);
          if (!endOk) add(v, `${wat}.end`, "INVALID_TIME", `${wwhere}: the end must be a time written HH:MM on a 24-hour clock.`);
          if (!startOk || !endOk) return;
          // Every endpoint is a wall-clock time in the venue's own zone on that date. One a clock change skips (it never occurs) or repeats (it occurs
          // twice) is refused outright: nothing here picks another time or an offset for the organizer.
          let endpointsUsable = true;
          if (valid && timeZone !== null) {
            for (const [which, value] of [["start", w.start], ["end", w.end]] as const) {
              const kind = resolveLocalTime(`${date}T${value}`, timeZone).kind;
              if (kind === "nonexistent") {
                endpointsUsable = false;
                add(v, `${wat}.${which}`, "WINDOW_NONEXISTENT_LOCAL_TIME", `${wwhere}: the ${which} ${value} does not exist on ${date} in ${timeZone} (the clocks skip it). Choose another time.`);
              } else if (kind === "ambiguous") {
                endpointsUsable = false;
                add(v, `${wat}.${which}`, "WINDOW_AMBIGUOUS_LOCAL_TIME", `${wwhere}: the ${which} ${value} happens twice on ${date} in ${timeZone} (the clocks repeat it). Choose a time that is not repeated.`);
              }
            }
          }
          if (minutesOf(w.start as string) >= minutesOf(w.end as string)) {
            add(v, wat, "WINDOW_CROSSES_MIDNIGHT", `${wwhere}: a window must end after it starts, on the same day.`);
            return;
          }
          if (!endpointsUsable) return;
          windows.push({ start: w.start as string, end: w.end as string, index: j });
        });
        const ordered = [...windows].sort((a, b) => minutesOf(a.start) - minutesOf(b.start));
        for (let k = 1; k < ordered.length; k++) {
          if (minutesOf(ordered[k].start) < minutesOf(ordered[k - 1].end)) {
            add(v, `${at}.windows[${ordered[k].index}]`, "WINDOW_OVERLAP", `${where}: the operating windows overlap.`);
          }
        }
        if (valid && ordered.length > 0) {
          const start = `${date}T${ordered[0].start}`;
          if (firstWindowStart === null || start < firstWindowStart) firstWindowStart = start;
        }
        dates.push({ date, windows: ordered.map(({ start, end }) => ({ start, end })) });
        return;
      }
      dates.push({ date, windows: [] });
    });
    if (days.length > 0 && Math.max(...days) - Math.min(...days) + 1 > PLANNING_LIMITS.maxSpanDays) {
      add(v, "dates", "DATE_SPAN_TOO_LONG", `The tournament dates must fall within a span of ${PLANNING_LIMITS.maxSpanDays} days.`);
    }
    dates.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  }

  // Roster -----------------------------------------------------------------------------------------------------------------------------
  let rosterMinimum = rule.roster.defaultMinimum;
  let rosterMaximum = rule.roster.defaultMaximum;
  if (raw.roster !== undefined && raw.roster !== null) {
    if (!isPlainObject(raw.roster)) {
      add(v, "roster", "ROSTER_VALUE_INVALID", "The roster minimum and maximum must be whole numbers.");
    } else {
      checkKeys(raw.roster, ["minimum", "maximum"], "roster", v);
      let minOk = true, maxOk = true;
      if (raw.roster.minimum !== undefined && raw.roster.minimum !== null) {
        const n = wholeNumber(raw.roster.minimum);
        if (n === null) { minOk = false; add(v, "roster.minimum", "ROSTER_VALUE_INVALID", "The roster minimum must be a whole number."); } else rosterMinimum = n;
      }
      if (raw.roster.maximum !== undefined && raw.roster.maximum !== null) {
        const n = wholeNumber(raw.roster.maximum);
        if (n === null) { maxOk = false; add(v, "roster.maximum", "ROSTER_VALUE_INVALID", "The roster maximum must be a whole number."); } else rosterMaximum = n;
      }
      const { configurableMinimumRange: minRange, configurableMaximumRange: maxRange } = rule.roster;
      if (minOk && (rosterMinimum < minRange.low || rosterMinimum > minRange.high)) {
        add(v, "roster.minimum", "ROSTER_MINIMUM_OUT_OF_RANGE", `The roster minimum must be from ${minRange.low} to ${minRange.high} for this format.`);
      }
      if (maxOk && (rosterMaximum < maxRange.low || rosterMaximum > maxRange.high)) {
        add(v, "roster.maximum", "ROSTER_MAXIMUM_OUT_OF_RANGE", `The roster maximum must be from ${maxRange.low} to ${maxRange.high} for this format.`);
      }
      if (minOk && maxOk && rosterMinimum > rosterMaximum) add(v, "roster", "ROSTER_MINIMUM_ABOVE_MAXIMUM", "The roster minimum cannot be above the roster maximum.");
    }
  }

  // Registration deadline --------------------------------------------------------------------------------------------------------------
  let deadline: CompetitionPlanningPlan["registrationDeadline"] = { local: "", timeZone: timeZone ?? "", utcOffset: "+00:00", utc: "" };
  if (!isPlainObject(raw.registrationDeadline)) {
    add(v, "registrationDeadline", "REQUIRED", "Enter the registration deadline.");
  } else {
    const d = raw.registrationDeadline;
    checkKeys(d, ["local", "timeZone", "utcOffset", "utc"], "registrationDeadline", v);
    const localOk = typeof d.local === "string" && localParts(d.local) !== null;
    if (!localOk) add(v, "registrationDeadline.local", "DEADLINE_INVALID", "The registration deadline must be a real date and time written YYYY-MM-DDTHH:MM.");
    let offset: number | null = null;
    if (d.utcOffset !== undefined && d.utcOffset !== null) {
      offset = parseUtcOffset(d.utcOffset);
      if (offset === null) add(v, "registrationDeadline.utcOffset", "DEADLINE_OFFSET_INVALID", "The UTC offset must be written ±HH:MM and be at most 14 hours.");
    }
    let utcMs: number | null = null;
    if (d.utc !== undefined && d.utc !== null) {
      utcMs = typeof d.utc === "string" && UTC_PATTERN.test(d.utc) ? Date.parse(d.utc) : NaN;
      if (Number.isNaN(utcMs)) { utcMs = null; add(v, "registrationDeadline.utc", "DEADLINE_UTC_INVALID", "The UTC instant must be a real moment written YYYY-MM-DDTHH:MM:SSZ."); }
    }
    // The deadline is judged only against a valid venue zone: an unusable zone has already been reported once.
    if (timeZone !== null) {
      const zoneMatches = d.timeZone === timeZone;
      if (!zoneMatches) add(v, "registrationDeadline.timeZone", "DEADLINE_TIMEZONE_MISMATCH", "The registration deadline must use the venue's time zone.");
      if (localOk && zoneMatches) {
        const resolved = resolveLocalTime(d.local as string, timeZone);
        if (resolved.kind === "nonexistent") {
          add(v, "registrationDeadline.local", "DEADLINE_NONEXISTENT_LOCAL_TIME", `That local time does not exist on that date in ${timeZone} (the clocks skip it). Choose another time.`);
        } else {
          let chosen: ResolvedInstant | undefined;
          if (offset !== null) {
            chosen = resolved.instants.find((i) => i.offsetMinutes === offset);
            if (!chosen) add(v, "registrationDeadline.utcOffset", "DEADLINE_OFFSET_MISMATCH", `${formatUtcOffset(offset)} is not the UTC offset in force at that local time in ${timeZone}.`);
          } else if (resolved.kind === "ambiguous") {
            const options = resolved.instants.map((i) => `UTC${formatUtcOffset(i.offsetMinutes)}`).join(" and ");
            add(v, "registrationDeadline.local", "DEADLINE_AMBIGUOUS_LOCAL_TIME", `That local time happens twice that day (${options}). Enter the UTC offset that applies.`);
          } else {
            chosen = resolved.instants[0];
          }
          if (chosen) {
            if (utcMs !== null && utcMs !== Date.parse(chosen.utc)) {
              add(v, "registrationDeadline.utc", "DEADLINE_UTC_MISMATCH", "The UTC instant does not match the local deadline in the venue's time zone.");
            }
            deadline = { local: d.local as string, timeZone, utcOffset: formatUtcOffset(chosen.offsetMinutes), utc: chosen.utc };
            if (firstWindowStart !== null && deadline.local >= firstWindowStart) {
              add(v, "registrationDeadline.local", "DEADLINE_NOT_BEFORE_FIRST_WINDOW", "Registration must close before the first operating window opens.");
            }
          }
        }
      }
    }
  }

  // Rules ------------------------------------------------------------------------------------------------------------------------------
  let rulesVersion = "", rulesSnapshot = "";
  if (!isPlainObject(raw.rules)) {
    add(v, "rules", "REQUIRED", "Enter the rules version and the rules snapshot.");
  } else {
    checkKeys(raw.rules, ["version", "snapshot"], "rules", v);
    // The length is the pattern's to judge (one rule, one code): the cleaner only guards against absurd input.
    rulesVersion = cleanText(raw.rules.version, "rules.version", { required: true, max: 1000, multiline: false, label: "rules version" }, v);
    if (rulesVersion && !RULES_VERSION_PATTERN.test(rulesVersion)) {
      add(v, "rules.version", "INVALID", "The rules version may use letters, digits, dots, dashes and underscores only (up to 32 characters).");
    }
    rulesSnapshot = cleanText(raw.rules.snapshot, "rules.snapshot", { required: true, max: PLANNING_LIMITS.rulesSnapshotMax, multiline: true, label: "rules snapshot" }, v);
  }

  if (v.length > 0) throw new PlanningValidationError(v);
  return {
    venue: { name: venueName, locationDescription: location, timeZone: timeZone as string, simultaneousMatchCapacity: capacity as number, restrictionNotes: venueNotes },
    pitches,
    dates,
    roster: { minimum: rosterMinimum, maximum: rosterMaximum },
    registrationDeadline: deadline,
    rules: { version: rulesVersion, snapshot: rulesSnapshot },
  };
}

/** The SHA-256 (hex) of a rules snapshot exactly as it is stored. */
export function rulesSnapshotDigest(snapshot: string): string {
  return createHash("sha256").update(snapshot, "utf8").digest("hex");
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The request, the revision payload and what a browser may see
// ---------------------------------------------------------------------------------------------------------------------------------------------

/** The body of a save: exactly a save identifier and a plan. Nothing else — least of all an actor, a format or a timing — is accepted. */
export function parsePlanningSaveRequest(body: unknown): { intentId: string; plan: unknown } {
  if (!isPlainObject(body)) throw new PlanningValidationError([{ field: "request", code: "PLAN_NOT_OBJECT", message: "The request must be an object." }]);
  const v: Violations = [];
  checkKeys(body, ["intentId", "plan"], "", v);
  if (typeof body.intentId !== "string" || !UUID_PATTERN.test(body.intentId)) add(v, "intentId", "INTENT_INVALID", "A save identifier is required.");
  if (!isPlainObject(body.plan)) add(v, "plan", "PLAN_NOT_OBJECT", "The plan must be an object.");
  if (v.length > 0) throw new PlanningValidationError(v);
  return { intentId: body.intentId as string, plan: body.plan };
}

/**
 * The plan as the database's atomic save operation takes it. Every fact is explicit (the roster values included); the format and the fixed timing
 * are absent by construction, and so is any actor — the database takes the organizer and the competition as separate arguments.
 */
export function planToRpcPayload(plan: CompetitionPlanningPlan) {
  return {
    venue: {
      name: plan.venue.name,
      location_description: plan.venue.locationDescription,
      time_zone: plan.venue.timeZone,
      simultaneous_match_capacity: plan.venue.simultaneousMatchCapacity,
      restriction_notes: plan.venue.restrictionNotes,
    },
    pitches: plan.pitches.map((p) => ({ label: p.label, usable: p.usable, supported_formats: [...p.supportedFormats], restriction_notes: p.restrictionNotes })),
    dates: plan.dates.map((d) => ({ date: d.date, windows: d.windows.map((w) => ({ start: w.start, end: w.end })) })),
    roster: { minimum: plan.roster.minimum, maximum: plan.roster.maximum },
    registration_deadline: {
      local: plan.registrationDeadline.local,
      time_zone: plan.registrationDeadline.timeZone,
      utc_offset_minutes: parseUtcOffset(plan.registrationDeadline.utcOffset) ?? 0,
      utc: plan.registrationDeadline.utc,
    },
    rules: { version: plan.rules.version, snapshot: plan.rules.snapshot },
  };
}

/** A refusal raised inside the database ("PLANNING_INVALID: CODE: message"), as the same typed error the application raises. */
export function planningValidationFromDatabase(message: string): PlanningValidationError {
  const match = /PLANNING_INVALID: ([A-Z_]+): ([^\n]*)/.exec(message);
  return new PlanningValidationError([match
    ? { field: "plan", code: match[1], message: match[2].charAt(0).toUpperCase() + match[2].slice(1) + (/[.!?]$/.test(match[2]) ? "" : ".") }
    : { field: "plan", code: "INVALID", message: "The plan is not valid." }]);
}

export interface PlanningContext {
  formatKey: SoccerFormatKey;
  formatLabel: string;
  playersOnField: number;
  roster: {
    defaultMinimum: number; defaultMaximum: number;
    minimumRange: { low: number; high: number }; maximumRange: { low: number; high: number };
    absoluteMaximum: number;
  };
  timing: {
    halves: number; minutesPerHalf: number; halftimeMinutes: number; pitchTransitionMinutes: number;
    minimumTeamRestMinutes: number; knockoutShootoutReserveMinutes: number;
  };
  limits: { maxDates: number; maxSpanDays: number; maxWindowsPerDate: number; maxPitches: number };
}

/** What the planning editor may be told about the competition's OWN format: read-only values from the registry, plus the plan's limits. */
export function planningContextFor(formatKey: SoccerFormatKey): PlanningContext {
  const rule = getSoccerFormatRule(formatKey);
  const n = rule.playersOnField;
  return Object.freeze({
    formatKey: rule.formatKey,
    formatLabel: `Soccer ${n}v${n}`,
    playersOnField: n,
    roster: Object.freeze({
      defaultMinimum: rule.roster.defaultMinimum,
      defaultMaximum: rule.roster.defaultMaximum,
      minimumRange: Object.freeze({ low: rule.roster.configurableMinimumRange.low, high: rule.roster.configurableMinimumRange.high }),
      maximumRange: Object.freeze({ low: rule.roster.configurableMaximumRange.low, high: rule.roster.configurableMaximumRange.high }),
      absoluteMaximum: rule.roster.absoluteMaximum,
    }),
    timing: Object.freeze({
      halves: rule.timing.halves,
      minutesPerHalf: rule.timing.minutesPerHalf,
      halftimeMinutes: rule.timing.halftimeMinutes,
      pitchTransitionMinutes: rule.timing.pitchTransitionMinutes,
      minimumTeamRestMinutes: rule.timing.minimumTeamRestMinutes,
      knockoutShootoutReserveMinutes: rule.timing.knockoutShootoutReserveMinutes,
    }),
    limits: Object.freeze({
      maxDates: PLANNING_LIMITS.maxDates, maxSpanDays: PLANNING_LIMITS.maxSpanDays, maxWindowsPerDate: PLANNING_LIMITS.maxWindowsPerDate, maxPitches: PLANNING_LIMITS.maxPitches,
    }),
  });
}

/**
 * A saved revision as a browser may see it: every field is copied by name, so nothing the server holds beyond this list — an identifier, the
 * authoring member, the competition's id — can reach a response, whatever the record carries.
 */
export function publicRevision(record: CompetitionPlanningRevisionRecord) {
  return {
    revisionNumber: record.revisionNumber,
    supersedesRevisionNumber: record.supersedesRevisionNumber,
    createdAt: record.createdAt,
    formatKey: record.formatKey,
    venue: {
      name: record.venue.name, locationDescription: record.venue.locationDescription, timeZone: record.venue.timeZone,
      simultaneousMatchCapacity: record.venue.simultaneousMatchCapacity, restrictionNotes: record.venue.restrictionNotes,
    },
    pitches: record.pitches.map((p) => ({ label: p.label, usable: p.usable, supportedFormats: [...p.supportedFormats], restrictionNotes: p.restrictionNotes })),
    dates: record.dates.map((d) => ({ date: d.date, windows: d.windows.map((w) => ({ start: w.start, end: w.end })) })),
    roster: { minimum: record.roster.minimum, maximum: record.roster.maximum },
    registrationDeadline: {
      local: record.registrationDeadline.local, timeZone: record.registrationDeadline.timeZone,
      utcOffset: record.registrationDeadline.utcOffset, utc: record.registrationDeadline.utc,
    },
    rules: { version: record.rules.version, snapshot: record.rules.snapshot, snapshotDigest: record.rules.snapshotDigest },
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------------------------------------------------------------------------

export type PlanningRepository = Pick<CompetitionsRepository, "getCompetitionById"> & CompetitionPlanningStore;

/**
 * SAVE_COMPETITION_PLANNING. The same decisions are made again, atomically and under a lock, inside the database; these checks decide first so that
 * a caller who is not the organizer never learns whether a plan would have been valid, and a plan is never judged for a competition that cannot take it.
 * The organizer is always the verified caller and the format is always the stored competition's: neither comes from the request.
 */
export async function saveCompetitionPlanning(
  repo: PlanningRepository,
  competitionId: string,
  callerGamingMemberId: string,
  intentId: string,
  rawPlan: unknown
): Promise<SavePlanningRevisionResult> {
  const competition = await repo.getCompetitionById(competitionId);
  if (!competition) throw new CompetitionNotFoundError();
  if (competition.organizerGamingMemberId !== callerGamingMemberId) throw new CompetitionAccessDeniedError("Only this competition's organizer may plan it.");
  if (!isActiveOrganizer(competition, callerGamingMemberId)) throw new HostAccessRevokedError();
  if (competition.state !== "DRAFT") throw new CompetitionNotDraftError();
  const plan = parsePlanningPlan(rawPlan, competition.activityKey);
  return repo.savePlanningRevision(competitionId, callerGamingMemberId, intentId, plan);
}

/**
 * READ_COMPETITION_PLANNING. The current revision of ONE addressed competition, for its active organizer only. Anyone else — an unrelated member, a
 * scorekeeper, a registrant, a former host, or an unknown competition — gets null, indistinguishable from each other.
 */
export async function readCompetitionPlanning(
  repo: PlanningRepository,
  competitionId: string,
  callerGamingMemberId: string
): Promise<{ context: PlanningContext; revision: CompetitionPlanningRevisionRecord | null } | null> {
  const competition = await repo.getCompetitionById(competitionId);
  if (!competition || !isActiveOrganizer(competition, callerGamingMemberId)) return null;
  const revision = await repo.getCurrentPlanningRevision(competitionId);
  return { context: planningContextFor(competition.activityKey), revision };
}
