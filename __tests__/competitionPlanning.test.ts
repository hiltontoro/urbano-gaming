import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// The ONE module boundary between a Competitions route and the outside world, mocked exactly as competitions.test.ts does it: the real
// statusForCompetitionsError and the real production-availability guard stay in place.
vi.mock("@/lib/gaming/competitions/httpAuth", async () => {
  const actual = await vi.importActual<typeof import("../lib/gaming/competitions/httpAuth")>("../lib/gaming/competitions/httpAuth");
  return {
    getSupabaseCredentials: vi.fn(),
    buildCompetitionsRepo: vi.fn(),
    requireGamingMember: vi.fn(),
    statusForCompetitionsError: actual.statusForCompetitionsError,
    requireCompetitionsSchemaReady: actual.requireCompetitionsSchemaReady,
    isCompetitionsSchemaReady: actual.isCompetitionsSchemaReady,
    normalizeCompetitionsSchemaReady: actual.normalizeCompetitionsSchemaReady,
  };
});

import * as httpAuth from "@/lib/gaming/competitions/httpAuth";
import { CompetitionAccessDeniedError, CompetitionNotDraftError, HostAccessRevokedError } from "../lib/gaming/competitions/types";

/**
 * UG-CR-GATE-SSS-004 — Small-Sided Soccer Organizer Planning Foundation: the planning domain, its HTTP boundary and its migration, without a database.
 *
 * Proves, in this order: the plan validation rules (dates, windows, timezones, the registration deadline, venue, pitches, capacity, roster bounds
 * for all four registry formats, fixed timing, the rules snapshot); the revision/RPC payload shape; the save and read routes (authentication, the
 * organizer deriving only from the verified caller, the format deriving only from the competition, uniform not-found, no-store, nothing internal in
 * a response); that no creation path or public asset gained a non-5v5 format; and the migration's static security contract. The database behavior
 * itself (locking, replay, immutability, concurrency) is the contract suite's job: competitionPlanningSupabase.contract.test.ts.
 *
 * The planning module is loaded lazily on purpose: until it exists, only the tests that need it can fail.
 */

const loadPlanning = () => import("../lib/gaming/competitions/planning");
type Planning = Awaited<ReturnType<typeof loadPlanning>>;

const REPO_ROOT = path.resolve(__dirname, "..");
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), "utf8");

/** The accepted SSS-001 registry values, written out independently of the implementation. */
const ACCEPTED = {
  SOCCER_5V5: { players: 5, label: "Soccer 5v5", rosterDefault: [5, 8], minRange: [5, 8], maxRange: [5, 10], absoluteMaximum: 10, timing: [2, 10, 3, 10, 30, 15] },
  SOCCER_6V6: { players: 6, label: "Soccer 6v6", rosterDefault: [6, 10], minRange: [6, 10], maxRange: [6, 12], absoluteMaximum: 12, timing: [2, 12, 3, 10, 30, 15] },
  SOCCER_7V7: { players: 7, label: "Soccer 7v7", rosterDefault: [7, 12], minRange: [7, 12], maxRange: [7, 14], absoluteMaximum: 14, timing: [2, 15, 5, 10, 45, 15] },
  SOCCER_8V8: { players: 8, label: "Soccer 8v8", rosterDefault: [8, 14], minRange: [8, 14], maxRange: [8, 16], absoluteMaximum: 16, timing: [2, 15, 5, 10, 45, 15] },
} as const;
type FormatKey = keyof typeof ACCEPTED;
const FORMAT_KEYS = Object.keys(ACCEPTED) as FormatKey[];

const SNAPSHOT = "Draft planning rules, version one. Matches follow the accepted small-sided format; full public rules are pending.";

function basePlan(overrides: Record<string, unknown> = {}): Record<string, any> {
  return {
    venue: {
      name: "Cancha Central", locationDescription: "Calle 5, San José, behind the central market", timeZone: "America/Costa_Rica",
      simultaneousMatchCapacity: 2, restrictionNotes: "No metal cleats.",
    },
    pitches: [
      { label: "A", usable: true, supportedFormats: ["SOCCER_5V5"], restrictionNotes: "" },
      { label: "B", usable: true, supportedFormats: ["SOCCER_5V5", "SOCCER_6V6"], restrictionNotes: "Lights off after 21:00." },
    ],
    dates: [
      { date: "2026-11-07", windows: [{ start: "09:00", end: "13:00" }, { start: "15:00", end: "19:00" }] },
      { date: "2026-11-08", windows: [{ start: "09:00", end: "13:00" }] },
    ],
    roster: { minimum: 5, maximum: 8 },
    registrationDeadline: { local: "2026-11-01T18:00", timeZone: "America/Costa_Rica" },
    rules: { version: "draft-1", snapshot: SNAPSHOT },
    ...overrides,
  };
}

/** A plan whose pitches support the given format, for the per-format roster and context checks. */
function planFor(format: FormatKey, overrides: Record<string, unknown> = {}) {
  return basePlan({
    pitches: [{ label: "A", usable: true, supportedFormats: [format], restrictionNotes: "" }, { label: "B", usable: true, supportedFormats: [format], restrictionNotes: "" }],
    roster: { minimum: ACCEPTED[format].rosterDefault[0], maximum: ACCEPTED[format].rosterDefault[1] },
    ...overrides,
  });
}

async function violationsOf(raw: unknown, format: FormatKey = "SOCCER_5V5"): Promise<string[]> {
  const planning = await loadPlanning();
  try {
    planning.parsePlanningPlan(raw, format);
    return [];
  } catch (err) {
    if (!(err instanceof planning.PlanningValidationError)) throw err;
    return err.violations.map((v) => `${v.field}:${v.code}`);
  }
}

async function accepted(raw: unknown, format: FormatKey = "SOCCER_5V5") {
  const planning = await loadPlanning();
  return planning.parsePlanningPlan(raw, format);
}

/** Replaces one nested value without mutating the shared base. */
function withDates(dates: unknown) { return basePlan({ dates }); }
const day = (date: string, ...windows: Array<[string, string]>) => ({ date, windows: windows.map(([start, end]) => ({ start, end })) });

describe("planning rules — dates and windows", () => {
  it("1. accepts exactly one to three tournament dates and rejects zero or four", async () => {
    expect(await violationsOf(withDates([day("2026-11-07", ["09:00", "13:00"])]))).toEqual([]);
    expect(await violationsOf(withDates([day("2026-11-07", ["09:00", "13:00"]), day("2026-11-08", ["09:00", "13:00"])]))).toEqual([]);
    expect(await violationsOf(withDates([day("2026-11-07", ["09:00", "13:00"]), day("2026-11-08", ["09:00", "13:00"]), day("2026-11-09", ["09:00", "13:00"])]))).toEqual([]);
    expect(await violationsOf(withDates([]))).toContain("dates:DATE_COUNT_INVALID");
    expect(await violationsOf(withDates([day("2026-11-07", ["09:00", "13:00"]), day("2026-11-08", ["09:00", "13:00"]), day("2026-11-09", ["09:00", "13:00"]), day("2026-11-10", ["09:00", "13:00"])]))).toContain("dates:DATE_COUNT_INVALID");
    expect(await violationsOf(basePlan({ dates: undefined }))).toContain("dates:DATE_COUNT_INVALID");
    expect(await violationsOf(basePlan({ dates: "2026-11-07" }))).toContain("dates:DATE_COUNT_INVALID");
  });

  it("2. enforces the 14-day inclusive span: fourteen days apart is fine, a fifteenth day is not", async () => {
    const w: [string, string] = ["09:00", "13:00"];
    expect(await violationsOf(withDates([day("2026-11-07", w), day("2026-11-20", w)]))).toEqual([]);          // 14 days inclusive
    expect(await violationsOf(withDates([day("2026-11-07", w), day("2026-11-21", w)]))).toContain("dates:DATE_SPAN_TOO_LONG");   // 15 days inclusive
    expect(await violationsOf(withDates([day("2026-11-21", w), day("2026-11-07", w), day("2026-11-10", w)]))).toContain("dates:DATE_SPAN_TOO_LONG"); // order does not matter
  });

  it("3. accepts nonconsecutive dates and stores them in ascending order", async () => {
    const w: [string, string] = ["09:00", "13:00"];
    const plan = await accepted(withDates([day("2026-11-20", w), day("2026-11-07", w), day("2026-11-10", w)]));
    expect(plan.dates.map((d: { date: string }) => d.date)).toEqual(["2026-11-07", "2026-11-10", "2026-11-20"]);
  });

  it("rejects a repeated date and every date that is not a real calendar day in YYYY-MM-DD", async () => {
    const w: [string, string] = ["09:00", "13:00"];
    expect(await violationsOf(withDates([day("2026-11-07", w), day("2026-11-07", ["15:00", "18:00"])]))).toContain("dates[1].date:DUPLICATE_DATE");
    for (const bad of ["2026-02-30", "2026-13-01", "2026-11-31", "11/07/2026", "2026-11-7", "20261107", "", "2026-11-07T00:00", 20261107, null, undefined]) {
      expect(await violationsOf(withDates([{ date: bad, windows: [{ start: "09:00", end: "13:00" }] }])), `date ${String(bad)}`).toContain("dates[0].date:INVALID_DATE");
    }
  });

  it("4. allows at most two windows per date and at least one", async () => {
    expect(await violationsOf(withDates([day("2026-11-07", ["09:00", "11:00"])]))).toEqual([]);
    expect(await violationsOf(withDates([day("2026-11-07", ["09:00", "11:00"], ["13:00", "15:00"])]))).toEqual([]);
    expect(await violationsOf(withDates([day("2026-11-07", ["09:00", "11:00"], ["12:00", "13:00"], ["14:00", "15:00"])]))).toContain("dates[0].windows:WINDOW_COUNT_INVALID");
    expect(await violationsOf(withDates([day("2026-11-07")]))).toContain("dates[0].windows:WINDOW_COUNT_INVALID");
    expect(await violationsOf(withDates([{ date: "2026-11-07" }]))).toContain("dates[0].windows:WINDOW_COUNT_INVALID");
  });

  it("5. rejects overlapping windows on the same date; adjacent windows do not overlap; order of entry does not matter", async () => {
    expect(await violationsOf(withDates([day("2026-11-07", ["09:00", "13:00"], ["12:00", "15:00"])]))).toContain("dates[0].windows[1]:WINDOW_OVERLAP");
    expect(await violationsOf(withDates([day("2026-11-07", ["09:00", "13:00"], ["09:30", "10:00"])]))).toContain("dates[0].windows[1]:WINDOW_OVERLAP");
    expect(await violationsOf(withDates([day("2026-11-07", ["09:00", "12:00"], ["12:00", "15:00"])]))).toEqual([]);
    const plan = await accepted(withDates([day("2026-11-07", ["15:00", "19:00"], ["09:00", "13:00"])]));
    expect(plan.dates[0].windows).toEqual([{ start: "09:00", end: "13:00" }, { start: "15:00", end: "19:00" }]);
  });

  it("6. rejects a window that crosses midnight, ends at or before it starts, or uses a malformed time", async () => {
    expect(await violationsOf(withDates([day("2026-11-07", ["22:00", "02:00"])]))).toContain("dates[0].windows[0]:WINDOW_CROSSES_MIDNIGHT");
    expect(await violationsOf(withDates([day("2026-11-07", ["23:00", "00:00"])]))).toContain("dates[0].windows[0]:WINDOW_CROSSES_MIDNIGHT");
    expect(await violationsOf(withDates([day("2026-11-07", ["10:00", "10:00"])]))).toContain("dates[0].windows[0]:WINDOW_CROSSES_MIDNIGHT");
    expect(await violationsOf(withDates([day("2026-11-07", ["09:00", "23:59"])]))).toEqual([]);
    for (const bad of ["24:00", "9:00", "09:60", "25:00", "09:00:30", "0900", "", "09:00Z", 900, null]) {
      expect(await violationsOf(withDates([{ date: "2026-11-07", windows: [{ start: bad, end: "23:00" }] }])), `start ${String(bad)}`).toContain("dates[0].windows[0].start:INVALID_TIME");
    }
  });
});

describe("planning rules — timezones and the registration deadline", () => {
  it("7. accepts canonical IANA zone names and rejects malformed, abbreviated or unknown ones", async () => {
    const { isValidIanaTimeZone } = await loadPlanning();
    for (const ok of ["America/Costa_Rica", "America/New_York", "Europe/Madrid", "Asia/Kolkata", "America/Argentina/Buenos_Aires", "Pacific/Auckland"]) expect(isValidIanaTimeZone(ok), ok).toBe(true);
    for (const bad of ["", " ", "UTC", "EST", "GMT+2", "UTC+02:00", "America/New York", "Mars/Olympus", "america/costa_rica", "America/Costa_Rica ", "../etc/passwd", "America//New_York", "America/", "/America/New_York", 5, null, undefined, {}]) {
      expect(isValidIanaTimeZone(bad), String(bad)).toBe(false);
    }
    for (const bad of ["Mars/Olympus", "EST", "America/New York", ""]) {
      const v = await violationsOf(basePlan({ venue: { ...basePlan().venue, timeZone: bad }, registrationDeadline: { local: "2026-11-01T18:00", timeZone: bad } }));
      expect(v, bad).toContain("venue.timeZone:INVALID_TIMEZONE");
    }
  });

  it("resolves a venue-local time to exactly one instant, two instants (ambiguous) or none (nonexistent)", async () => {
    const { resolveLocalTime } = await loadPlanning();
    expect(resolveLocalTime("2026-11-01T18:00", "America/Costa_Rica")).toEqual({ kind: "ok", instants: [{ utc: "2026-11-02T00:00:00.000Z", offsetMinutes: -360 }] });
    expect(resolveLocalTime("2026-10-30T12:00", "America/New_York")).toEqual({ kind: "ok", instants: [{ utc: "2026-10-30T16:00:00.000Z", offsetMinutes: -240 }] });
    expect(resolveLocalTime("2026-11-01T01:30", "America/New_York")).toEqual({
      kind: "ambiguous",
      instants: [{ utc: "2026-11-01T05:30:00.000Z", offsetMinutes: -240 }, { utc: "2026-11-01T06:30:00.000Z", offsetMinutes: -300 }],
    });
    expect(resolveLocalTime("2026-03-08T02:30", "America/New_York")).toEqual({ kind: "nonexistent", instants: [] });
    expect(resolveLocalTime("2026-03-08T03:30", "America/New_York").kind).toBe("ok");
  });

  it("8. rejects a nonexistent local time and an ambiguous one that no explicit offset resolves", async () => {
    const ny = (deadline: Record<string, unknown>) => basePlan({
      venue: { ...basePlan().venue, timeZone: "America/New_York" },
      registrationDeadline: { timeZone: "America/New_York", ...deadline },
      dates: [day("2026-11-07", ["09:00", "13:00"])],
    });
    expect(await violationsOf(ny({ local: "2026-03-08T02:30" }))).toContain("registrationDeadline.local:DEADLINE_NONEXISTENT_LOCAL_TIME");
    expect(await violationsOf(ny({ local: "2026-11-01T01:30" }))).toContain("registrationDeadline.local:DEADLINE_AMBIGUOUS_LOCAL_TIME");
    // An explicit offset that resolves the ambiguity is accepted, and each offset yields its own authoritative UTC instant.
    const first = await accepted(ny({ local: "2026-11-01T01:30", utcOffset: "-04:00" }));
    const second = await accepted(ny({ local: "2026-11-01T01:30", utcOffset: "-05:00" }));
    expect(first.registrationDeadline.utc).toBe("2026-11-01T05:30:00.000Z");
    expect(second.registrationDeadline.utc).toBe("2026-11-01T06:30:00.000Z");
    expect(first.registrationDeadline.utcOffset).toBe("-04:00");
    expect(second.registrationDeadline.utcOffset).toBe("-05:00");
  });

  it("9. rejects any disagreement between the local time, the zone, the offset and the UTC instant", async () => {
    const dl = (extra: Record<string, unknown>) => basePlan({ registrationDeadline: { local: "2026-11-01T18:00", timeZone: "America/Costa_Rica", ...extra } });
    expect(await violationsOf(dl({}))).toEqual([]);
    expect(await violationsOf(dl({ utcOffset: "-06:00" }))).toEqual([]);
    expect(await violationsOf(dl({ utcOffset: "-06:00", utc: "2026-11-02T00:00:00.000Z" }))).toEqual([]);
    expect(await violationsOf(dl({ utcOffset: "-05:00" }))).toContain("registrationDeadline.utcOffset:DEADLINE_OFFSET_MISMATCH");
    expect(await violationsOf(dl({ utc: "2026-11-02T01:00:00.000Z" }))).toContain("registrationDeadline.utc:DEADLINE_UTC_MISMATCH");
    expect(await violationsOf(dl({ utcOffset: "-06:00", utc: "2026-11-01T18:00:00.000Z" }))).toContain("registrationDeadline.utc:DEADLINE_UTC_MISMATCH");
    expect(await violationsOf(dl({ timeZone: "America/New_York" }))).toContain("registrationDeadline.timeZone:DEADLINE_TIMEZONE_MISMATCH");
    for (const bad of ["2026-11-01 18:00", "2026-11-01T18:00:00", "2026-11-01T18:00Z", "2026-11-01T18:00-06:00", "2026-11-01", "2026-13-01T18:00", "2026-11-01T24:00", "", null, 5]) {
      expect(await violationsOf(dl({ local: bad })), String(bad)).toContain("registrationDeadline.local:DEADLINE_INVALID");
    }
    for (const bad of ["-6:00", "06:00", "+25:00", "+05:60", "UTC", "", 360]) {
      expect(await violationsOf(dl({ utcOffset: bad })), String(bad)).toContain("registrationDeadline.utcOffset:DEADLINE_OFFSET_INVALID");
    }
    for (const bad of ["2026-11-02T00:00:00", "2026-11-02", "tomorrow", 5]) {
      expect(await violationsOf(dl({ utc: bad })), String(bad)).toContain("registrationDeadline.utc:DEADLINE_UTC_INVALID");
    }
  });

  it("stores the deadline as the venue-local time, the zone, the offset and the one authoritative UTC instant", async () => {
    const plan = await accepted(basePlan());
    expect(plan.registrationDeadline).toEqual({ local: "2026-11-01T18:00", timeZone: "America/Costa_Rica", utcOffset: "-06:00", utc: "2026-11-02T00:00:00.000Z" });
  });

  it("requires registration to close before the first operating window opens", async () => {
    const at = (local: string) => basePlan({ registrationDeadline: { local, timeZone: "America/Costa_Rica" } });
    expect(await violationsOf(at("2026-11-07T08:59"))).toEqual([]);
    expect(await violationsOf(at("2026-11-07T09:00"))).toContain("registrationDeadline.local:DEADLINE_NOT_BEFORE_FIRST_WINDOW");
    expect(await violationsOf(at("2026-11-07T20:00"))).toContain("registrationDeadline.local:DEADLINE_NOT_BEFORE_FIRST_WINDOW");
    expect(await violationsOf(at("2026-11-09T08:00"))).toContain("registrationDeadline.local:DEADLINE_NOT_BEFORE_FIRST_WINDOW");
  });
});

describe("planning rules — operating-window endpoints honor the venue's own clock changes (SSS-004A)", () => {
  // Fixed IANA zones and calendar dates, never the machine's zone. 2026 transitions (tzdata): New York springs forward Sun 8 Mar (02:00 → 03:00, so
  // 02:00–02:59 does not exist) and falls back Sun 1 Nov (02:00 → 01:00, so 01:00–01:59 happens twice); Madrid Sun 29 Mar / Sun 25 Oct (02:00–02:59 skipped /
  // repeated); Lord Howe shifts by 30 minutes: Sun 4 Oct 02:00 → 02:30 (02:00–02:29 skipped), Sun 5 Apr 02:00 → 01:30 (01:30–01:59 repeated).
  const DEADLINE = "2026-02-20T18:00";
  const NONEXISTENT = "WINDOW_NONEXISTENT_LOCAL_TIME";
  const AMBIGUOUS = "WINDOW_AMBIGUOUS_LOCAL_TIME";
  const planAt = (zone: string, date: string, ...windows: Array<[string, string]>) => basePlan({
    venue: { ...basePlan().venue, timeZone: zone },
    dates: [day(date, ...windows)],
    registrationDeadline: { local: DEADLINE, timeZone: zone },
  });
  const at = (field: "start" | "end", code: string, w = 0) => `dates[0].windows[${w}].${field}:${code}`;

  it("the fixtures themselves are what the tests below say they are", async () => {
    const { resolveLocalTime } = await loadPlanning();
    const kind = (local: string, zone: string) => resolveLocalTime(local, zone).kind;
    expect([kind("2026-03-08T02:30", "America/New_York"), kind("2026-03-08T01:59", "America/New_York"), kind("2026-03-08T03:00", "America/New_York")]).toEqual(["nonexistent", "ok", "ok"]);
    expect([kind("2026-11-01T01:30", "America/New_York"), kind("2026-11-01T00:59", "America/New_York"), kind("2026-11-01T02:00", "America/New_York")]).toEqual(["ambiguous", "ok", "ok"]);
    expect([kind("2026-03-29T02:30", "Europe/Madrid"), kind("2026-10-25T02:30", "Europe/Madrid")]).toEqual(["nonexistent", "ambiguous"]);
    expect([kind("2026-10-04T02:15", "Australia/Lord_Howe"), kind("2026-10-04T02:30", "Australia/Lord_Howe"), kind("2026-04-05T01:45", "Australia/Lord_Howe"), kind("2026-04-05T02:00", "Australia/Lord_Howe")]).toEqual(["nonexistent", "ok", "ambiguous", "ok"]);
    expect([kind("2026-03-08T02:30", "America/Phoenix"), kind("2026-03-08T02:30", "America/Costa_Rica"), kind("2026-11-01T01:30", "Asia/Kolkata")]).toEqual(["ok", "ok", "ok"]);
  });

  it("refuses a nonexistent START (a forward clock change skipped it), and says which time and why", async () => {
    expect(await violationsOf(planAt("America/New_York", "2026-03-08", ["02:30", "04:00"]))).toContain(at("start", NONEXISTENT));
    const { parsePlanningPlan, PlanningValidationError } = await loadPlanning();
    try { parsePlanningPlan(planAt("America/New_York", "2026-03-08", ["02:30", "04:00"]), "SOCCER_5V5"); throw new Error("accepted"); } catch (err) {
      expect(err).toBeInstanceOf(PlanningValidationError);
      const v = (err as InstanceType<typeof PlanningValidationError>).violations.find((x) => x.code === NONEXISTENT)!;
      expect(v.field).toBe("dates[0].windows[0].start");
      expect(v.message).toMatch(/02:30/);
      expect(v.message).toMatch(/America\/New_York/);
    }
  });

  it("refuses a nonexistent END", async () => {
    expect(await violationsOf(planAt("America/New_York", "2026-03-08", ["01:00", "02:30"]))).toContain(at("end", NONEXISTENT));
  });

  it("refuses an ambiguous START (a backward clock change repeated it) and never picks an offset for it", async () => {
    const v = await violationsOf(planAt("America/New_York", "2026-11-01", ["01:30", "03:00"]));
    expect(v).toContain(at("start", AMBIGUOUS));
    const { parsePlanningPlan } = await loadPlanning();
    expect(() => parsePlanningPlan(planAt("America/New_York", "2026-11-01", ["01:30", "03:00"]), "SOCCER_5V5")).toThrow();
  });

  it("refuses an ambiguous END", async () => {
    expect(await violationsOf(planAt("America/New_York", "2026-11-01", ["00:30", "01:15"]))).toContain(at("end", AMBIGUOUS));
  });

  it("reports BOTH endpoints of one window when both are bad, and each window of a date on its own", async () => {
    expect(await violationsOf(planAt("America/New_York", "2026-03-08", ["02:15", "02:45"]))).toEqual(expect.arrayContaining([at("start", NONEXISTENT), at("end", NONEXISTENT)]));
    const v = await violationsOf(planAt("America/New_York", "2026-11-01", ["00:10", "00:50"], ["01:10", "01:50"]));
    expect(v).toEqual(expect.arrayContaining([at("start", AMBIGUOUS, 1), at("end", AMBIGUOUS, 1)]));
    expect(v.filter((x) => x.startsWith("dates[0].windows[0]"))).toEqual([]);
  });

  it("covers other zones and other shapes of clock change: Madrid (hour), Lord Howe (half an hour)", async () => {
    expect(await violationsOf(planAt("Europe/Madrid", "2026-03-29", ["02:30", "05:00"]))).toContain(at("start", NONEXISTENT));
    expect(await violationsOf(planAt("Europe/Madrid", "2026-10-25", ["02:30", "05:00"]))).toContain(at("start", AMBIGUOUS));
    expect(await violationsOf(planAt("Australia/Lord_Howe", "2026-10-04", ["02:15", "05:00"]))).toContain(at("start", NONEXISTENT));
    expect(await violationsOf(planAt("Australia/Lord_Howe", "2026-04-05", ["01:45", "05:00"]))).toContain(at("start", AMBIGUOUS));
  });

  it("accepts an ordinary date in the SAME transition-observing zone, and the times just outside the skipped and repeated hours", async () => {
    expect(await violationsOf(planAt("America/New_York", "2026-03-09", ["02:30", "04:00"]))).toEqual([]);
    expect(await violationsOf(planAt("America/New_York", "2026-11-02", ["01:30", "03:00"]))).toEqual([]);
    expect(await violationsOf(planAt("America/New_York", "2026-03-08", ["01:00", "01:59"], ["03:00", "05:00"]))).toEqual([]);
    expect(await violationsOf(planAt("America/New_York", "2026-11-01", ["00:00", "00:59"], ["02:00", "03:00"]))).toEqual([]);
    expect(await violationsOf(planAt("Australia/Lord_Howe", "2026-10-04", ["02:30", "04:00"]))).toEqual([]);
    expect(await violationsOf(planAt("Australia/Lord_Howe", "2026-04-05", ["02:00", "03:00"]))).toEqual([]);
  });

  it("accepts the very same dates and times in a zone WITHOUT that transition", async () => {
    for (const [zone, date, start] of [["America/Phoenix", "2026-03-08", "02:30"], ["America/Costa_Rica", "2026-03-08", "02:30"], ["Asia/Kolkata", "2026-03-08", "02:30"],
      ["America/Phoenix", "2026-11-01", "01:30"], ["America/Costa_Rica", "2026-11-01", "01:30"], ["Asia/Kolkata", "2026-11-01", "01:30"], ["America/Costa_Rica", "2026-03-29", "02:30"]] as const) {
      expect(await violationsOf(planAt(zone, date, [start, "04:00"])), `${zone} ${date} ${start}`).toEqual([]);
    }
  });

  it("never silently normalizes: an accepted window keeps exactly the times entered, and a refused one yields no plan at all", async () => {
    const plan = await accepted(planAt("America/New_York", "2026-03-09", ["02:30", "04:00"]));
    expect(plan.dates[0].windows).toEqual([{ start: "02:30", end: "04:00" }]);
    const { planToRpcPayload, parsePlanningPlan } = await loadPlanning();
    expect(planToRpcPayload(plan).dates[0].windows).toEqual([{ start: "02:30", end: "04:00" }]);
    expect(() => parsePlanningPlan(planAt("America/New_York", "2026-03-08", ["02:30", "04:00"]), "SOCCER_5V5")).toThrow();
    expect(JSON.stringify(plan.dates)).not.toMatch(/03:30|utc|offset/i);               // the windows carry nothing but their two local times
    // No per-window instant or offset exists in the model.
    expect(Object.keys(plan.dates[0].windows[0]).sort()).toEqual(["end", "start"]);
  });

  it("keeps the existing window rules in force on a transition date: no midnight crossing, no overlap, adjacent windows still allowed", async () => {
    expect(await violationsOf(planAt("America/New_York", "2026-03-08", ["22:00", "02:00"]))).toContain("dates[0].windows[0]:WINDOW_CROSSES_MIDNIGHT");
    expect(await violationsOf(planAt("America/New_York", "2026-03-08", ["09:00", "13:00"], ["12:00", "15:00"]))).toContain("dates[0].windows[1]:WINDOW_OVERLAP");
    expect(await violationsOf(planAt("America/New_York", "2026-03-08", ["09:00", "12:00"], ["12:00", "15:00"]))).toEqual([]);
  });

  it("judges windows against the venue's zone only: an invalid zone is reported once and no window endpoint is judged against it", async () => {
    const v = await violationsOf(basePlan({ venue: { ...basePlan().venue, timeZone: "Mars/Olympus" }, dates: [day("2026-03-08", ["02:30", "04:00"])], registrationDeadline: { local: DEADLINE, timeZone: "Mars/Olympus" } }));
    expect(v).toContain("venue.timeZone:INVALID_TIMEZONE");
    expect(v.filter((x) => /WINDOW_(NONEXISTENT|AMBIGUOUS)/.test(x))).toEqual([]);
  });

  it("does not depend on the machine's time zone: the same answers under four different process zones", async () => {
    const original = process.env.TZ;
    const outcomes: string[] = [];
    try {
      for (const tz of ["UTC", "America/Los_Angeles", "Pacific/Kiritimati", "Asia/Kolkata"]) {
        process.env.TZ = tz;
        // The zone really changed under us: local-clock arithmetic differs between these zones.
        outcomes.push(JSON.stringify([
          await violationsOf(planAt("America/New_York", "2026-03-08", ["02:30", "04:00"])),
          await violationsOf(planAt("America/New_York", "2026-11-01", ["01:30", "03:00"])),
          await violationsOf(planAt("America/New_York", "2026-03-09", ["02:30", "04:00"])),
          await violationsOf(planAt("America/Phoenix", "2026-03-08", ["02:30", "04:00"])),
        ]));
      }
    } finally {
      if (original === undefined) delete process.env.TZ; else process.env.TZ = original;
    }
    expect(new Set(outcomes).size).toBe(1);
    expect(JSON.parse(outcomes[0])).toEqual([[at("start", NONEXISTENT)], [at("start", AMBIGUOUS)], [], []]);
  });
});

describe("planning rules — venue, pitches and capacity", () => {
  it("10. rejects a missing or empty venue", async () => {
    expect(await violationsOf(basePlan({ venue: undefined }))).toContain("venue:REQUIRED");
    expect(await violationsOf(basePlan({ venue: null }))).toContain("venue:REQUIRED");
    expect(await violationsOf(basePlan({ venue: {} }))).toEqual(expect.arrayContaining(["venue.name:REQUIRED", "venue.locationDescription:REQUIRED", "venue.timeZone:INVALID_TIMEZONE", "venue.simultaneousMatchCapacity:CAPACITY_INVALID"]));
    expect(await violationsOf(basePlan({ venue: { ...basePlan().venue, name: "   " } }))).toContain("venue.name:REQUIRED");
    expect(await violationsOf(basePlan({ venue: { ...basePlan().venue, locationDescription: "" } }))).toContain("venue.locationDescription:REQUIRED");
  });

  it("11. rejects a plan with no pitch or no usable pitch", async () => {
    expect(await violationsOf(basePlan({ pitches: [] }))).toContain("pitches:NO_PITCHES");
    expect(await violationsOf(basePlan({ pitches: undefined }))).toContain("pitches:NO_PITCHES");
    expect(await violationsOf(basePlan({ pitches: [{ label: "A", usable: false, supportedFormats: ["SOCCER_5V5"] }] }))).toContain("pitches:NO_USABLE_PITCH");
  });

  it("12. rejects duplicate pitch labels (ignoring case and surrounding spaces) and an empty label", async () => {
    const p = (label: string) => ({ label, usable: true, supportedFormats: ["SOCCER_5V5"], restrictionNotes: "" });
    expect(await violationsOf(basePlan({ pitches: [p("A"), p("A")] }))).toContain("pitches[1].label:DUPLICATE_LABEL");
    expect(await violationsOf(basePlan({ pitches: [p("Court 1"), p("  court 1 ")] }))).toContain("pitches[1].label:DUPLICATE_LABEL");
    expect(await violationsOf(basePlan({ pitches: [p("A"), p("")] }))).toContain("pitches[1].label:REQUIRED");
    expect(await violationsOf(basePlan({ pitches: [p("A"), p("B")] }))).toEqual([]);
  });

  it("13. rejects a pitch format that is not one of the four registry keys", async () => {
    const p = (supportedFormats: unknown) => ({ label: "A", usable: true, supportedFormats, restrictionNotes: "" });
    for (const bad of [["SOCCER_9V9"], ["5v5"], ["soccer_5v5"], [5], [""], ["SOCCER_5V5", "FUTSAL"], "SOCCER_5V5", null]) {
      const v = await violationsOf(basePlan({ pitches: [p(bad), { label: "B", usable: true, supportedFormats: ["SOCCER_5V5"] }], venue: { ...basePlan().venue } }));
      expect(v.some((x) => x.startsWith("pitches[0].supportedFormats:")), JSON.stringify(bad)).toBe(true);
    }
    expect(await violationsOf(basePlan({ pitches: [p(["SOCCER_9V9"]), { label: "B", usable: true, supportedFormats: ["SOCCER_5V5"] }] }))).toContain("pitches[0].supportedFormats:UNSUPPORTED_FORMAT_KEY");
    expect(await violationsOf(basePlan({ pitches: [p([]), { label: "B", usable: true, supportedFormats: ["SOCCER_5V5"] }] }))).toContain("pitches[0].supportedFormats:REQUIRED");
  });

  it("14. rejects a plan whose competition format no usable pitch supports (an unusable pitch does not count)", async () => {
    const only7 = [{ label: "A", usable: true, supportedFormats: ["SOCCER_7V7"] }, { label: "B", usable: true, supportedFormats: ["SOCCER_8V8"] }];
    expect(await violationsOf(basePlan({ pitches: only7 }))).toContain("pitches:FORMAT_NOT_SUPPORTED_BY_ANY_USABLE_PITCH");
    const unusableOnly = [{ label: "A", usable: true, supportedFormats: ["SOCCER_7V7"] }, { label: "B", usable: false, supportedFormats: ["SOCCER_5V5"] }];
    expect(await violationsOf(basePlan({ pitches: unusableOnly, venue: { ...basePlan().venue, simultaneousMatchCapacity: 1 } }))).toContain("pitches:FORMAT_NOT_SUPPORTED_BY_ANY_USABLE_PITCH");
    const mixed = [{ label: "A", usable: true, supportedFormats: ["SOCCER_7V7"] }, { label: "B", usable: true, supportedFormats: ["SOCCER_5V5", "SOCCER_7V7"] }];
    expect(await violationsOf(basePlan({ pitches: mixed }))).toEqual([]);
    // The same pitches answer differently for a different competition format: the format is the competition's, never the plan's.
    expect(await violationsOf(basePlan({ pitches: only7, roster: { minimum: 7, maximum: 12 } }), "SOCCER_7V7")).toEqual([]);
  });

  it("15. rejects a simultaneous-match capacity below one or above the number of usable pitches", async () => {
    const venue = (simultaneousMatchCapacity: unknown) => ({ ...basePlan().venue, simultaneousMatchCapacity });
    expect(await violationsOf(basePlan({ venue: venue(1) }))).toEqual([]);
    expect(await violationsOf(basePlan({ venue: venue(2) }))).toEqual([]);
    for (const bad of [0, -1, 3, 1.5, "2", NaN, Infinity, null, undefined, [2]]) {
      expect(await violationsOf(basePlan({ venue: venue(bad) })), String(bad)).toContain("venue.simultaneousMatchCapacity:CAPACITY_INVALID");
    }
    // Only usable pitches count: three pitches, one unusable, capacity three is still too many.
    const three = [{ label: "A", usable: true, supportedFormats: ["SOCCER_5V5"] }, { label: "B", usable: true, supportedFormats: ["SOCCER_5V5"] }, { label: "C", usable: false, supportedFormats: ["SOCCER_5V5"] }];
    expect(await violationsOf(basePlan({ pitches: three, venue: venue(3) }))).toContain("venue.simultaneousMatchCapacity:CAPACITY_INVALID");
    expect(await violationsOf(basePlan({ pitches: three, venue: venue(2) }))).toEqual([]);
  });

  it("bounds the number of pitches and the length of every free-text field, and refuses control characters", async () => {
    const many = Array.from({ length: 17 }, (_, i) => ({ label: `P${i}`, usable: true, supportedFormats: ["SOCCER_5V5"] }));
    expect(await violationsOf(basePlan({ pitches: many }))).toContain("pitches:TOO_MANY_PITCHES");
    const sixteen = Array.from({ length: 16 }, (_, i) => ({ label: `P${i}`, usable: true, supportedFormats: ["SOCCER_5V5"] }));
    expect(await violationsOf(basePlan({ pitches: sixteen }))).toEqual([]);
    expect(await violationsOf(basePlan({ venue: { ...basePlan().venue, name: "x".repeat(121) } }))).toContain("venue.name:TOO_LONG");
    expect(await violationsOf(basePlan({ venue: { ...basePlan().venue, name: "x".repeat(120) } }))).toEqual([]);
    expect(await violationsOf(basePlan({ venue: { ...basePlan().venue, locationDescription: "x".repeat(301) } }))).toContain("venue.locationDescription:TOO_LONG");
    expect(await violationsOf(basePlan({ venue: { ...basePlan().venue, restrictionNotes: "x".repeat(501) } }))).toContain("venue.restrictionNotes:TOO_LONG");
    expect(await violationsOf(basePlan({ pitches: [{ label: "x".repeat(41), usable: true, supportedFormats: ["SOCCER_5V5"] }, { label: "B", usable: true, supportedFormats: ["SOCCER_5V5"] }] }))).toContain("pitches[0].label:TOO_LONG");
    expect(await violationsOf(basePlan({ pitches: [{ label: "A", usable: true, supportedFormats: ["SOCCER_5V5"], restrictionNotes: "x".repeat(301) }, { label: "B", usable: true, supportedFormats: ["SOCCER_5V5"] }] }))).toContain("pitches[0].restrictionNotes:TOO_LONG");
    for (const bad of ["a\u0000b", "a\u0007b", "a\u001bb", "a\u007fb"]) {
      expect(await violationsOf(basePlan({ venue: { ...basePlan().venue, name: bad } })), JSON.stringify(bad)).toContain("venue.name:INVALID_TEXT");
    }
    expect(await violationsOf(basePlan({ venue: { ...basePlan().venue, name: 42 } }))).toContain("venue.name:REQUIRED");
    expect(await violationsOf(basePlan({ pitches: [{ label: "A", usable: "yes", supportedFormats: ["SOCCER_5V5"] }] }))).toContain("pitches[0].usable:INVALID");
  });

  it("trims text, keeps hostile text as plain data, and normalizes line endings in notes", async () => {
    const hostile = '<img src=x onerror="alert(1)">';
    const plan = await accepted(basePlan({ venue: { ...basePlan().venue, name: `  ${hostile}  `, restrictionNotes: "line one\r\nline two" } }));
    expect(plan.venue.name).toBe(hostile);
    expect(plan.venue.restrictionNotes).toBe("line one\nline two");
  });
});

describe("planning rules — roster bounds and fixed timing come from the registry", () => {
  it("16. enforces the registry roster bounds for every one of the four formats", async () => {
    for (const format of FORMAT_KEYS) {
      const a = ACCEPTED[format];
      const roster = (minimum: unknown, maximum: unknown) => planFor(format, { roster: { minimum, maximum } });
      const label = (s: string) => `${format} ${s}`;
      // The registry defaults, the corners of both ranges, and min = max where the ranges allow it.
      expect(await violationsOf(roster(a.rosterDefault[0], a.rosterDefault[1]), format), label("defaults")).toEqual([]);
      expect(await violationsOf(roster(a.minRange[0], a.maxRange[1]), format), label("widest")).toEqual([]);
      expect(await violationsOf(roster(a.minRange[1], a.maxRange[1]), format), label("min at its high bound")).toEqual([]);
      expect(await violationsOf(roster(a.minRange[0], a.minRange[0]), format), label("min = max")).toEqual([]);
      // One step outside each bound.
      expect(await violationsOf(roster(a.players - 1, a.rosterDefault[1]), format), label("below players on field")).toContain("roster.minimum:ROSTER_MINIMUM_OUT_OF_RANGE");
      expect(await violationsOf(roster(a.minRange[1] + 1, a.maxRange[1]), format), label("min above range")).toContain("roster.minimum:ROSTER_MINIMUM_OUT_OF_RANGE");
      expect(await violationsOf(roster(a.minRange[0], a.absoluteMaximum + 1), format), label("max above absolute")).toContain("roster.maximum:ROSTER_MAXIMUM_OUT_OF_RANGE");
      expect(await violationsOf(roster(a.minRange[1], a.minRange[1] - 1), format), label("min above max")).toContain("roster:ROSTER_MINIMUM_ABOVE_MAXIMUM");
      for (const bad of [5.5, "6", NaN, Infinity, [6]]) {
        expect(await violationsOf(roster(bad, a.rosterDefault[1]), format), label(`min ${String(bad)}`)).toContain("roster.minimum:ROSTER_VALUE_INVALID");
        expect(await violationsOf(roster(a.rosterDefault[0], bad), format), label(`max ${String(bad)}`)).toContain("roster.maximum:ROSTER_VALUE_INVALID");
      }
    }
  });

  it("persists the registry defaults explicitly when the roster values are omitted or null, and the same plan either way", async () => {
    for (const format of FORMAT_KEYS) {
      const a = ACCEPTED[format];
      const omitted = await accepted(planFor(format, { roster: undefined }), format);
      const nulls = await accepted(planFor(format, { roster: { minimum: null, maximum: null } }), format);
      const explicit = await accepted(planFor(format, { roster: { minimum: a.rosterDefault[0], maximum: a.rosterDefault[1] } }), format);
      expect(omitted.roster, format).toEqual({ minimum: a.rosterDefault[0], maximum: a.rosterDefault[1] });
      expect(nulls.roster, format).toEqual(omitted.roster);
      expect(explicit, format).toEqual(omitted);
    }
    const partial = await accepted(basePlan({ roster: { minimum: 6 } }));
    expect(partial.roster).toEqual({ minimum: 6, maximum: 8 });
  });

  it("17. exposes the fixed timing read-only per format and refuses every attempt to supply or change it", async () => {
    const { planningContextFor, PlanningValidationError } = await loadPlanning();
    for (const format of FORMAT_KEYS) {
      const a = ACCEPTED[format];
      const context = planningContextFor(format);
      expect(context.formatKey).toBe(format);
      expect(context.formatLabel).toBe(a.label);
      expect(context.playersOnField).toBe(a.players);
      expect(context.timing).toEqual({
        halves: a.timing[0], minutesPerHalf: a.timing[1], halftimeMinutes: a.timing[2], pitchTransitionMinutes: a.timing[3],
        minimumTeamRestMinutes: a.timing[4], knockoutShootoutReserveMinutes: a.timing[5],
      });
      expect(context.roster).toEqual({
        defaultMinimum: a.rosterDefault[0], defaultMaximum: a.rosterDefault[1],
        minimumRange: { low: a.minRange[0], high: a.minRange[1] }, maximumRange: { low: a.maxRange[0], high: a.maxRange[1] }, absoluteMaximum: a.absoluteMaximum,
      });
      expect(Object.isFrozen(context)).toBe(true);
      expect(Object.isFrozen(context.timing)).toBe(true);
    }
    expect(planningContextFor("SOCCER_5V5").limits).toEqual({ maxDates: 3, maxSpanDays: 14, maxWindowsPerDate: 2, maxPitches: 16 });
    for (const key of ["timing", "minutesPerHalf", "halves", "halftimeMinutes", "pitchTransitionMinutes", "minimumTeamRestMinutes", "knockoutShootoutReserveMinutes"]) {
      expect(await violationsOf(basePlan({ [key]: key === "timing" ? { minutesPerHalf: 20 } : 20 })), `top-level ${key}`).toContain(`${key}:TIMING_NOT_EDITABLE`);
      expect(await violationsOf(basePlan({ roster: { minimum: 5, maximum: 8, [key]: 20 } })), `roster.${key}`).toContain(`roster.${key}:TIMING_NOT_EDITABLE`);
      expect(await violationsOf(basePlan({ venue: { ...basePlan().venue, [key]: 20 } })), `venue.${key}`).toContain(`venue.${key}:TIMING_NOT_EDITABLE`);
    }
    const plan = await accepted(basePlan());
    expect(JSON.stringify(plan)).not.toMatch(/minutesPerHalf|halftime|pitchTransition|minimumTeamRest|knockoutShootout|halves|timing/i);
    void PlanningValidationError;
  });

  it("the plan can never choose or change the format: the format key is rejected wherever it appears, and an unsupported competition format throws", async () => {
    for (const key of ["format", "formatKey", "activityKey", "competitionFormat"]) {
      expect(await violationsOf(basePlan({ [key]: "SOCCER_6V6" })), key).toContain(`${key}:FORMAT_NOT_EDITABLE`);
      expect(await violationsOf(basePlan({ venue: { ...basePlan().venue, [key]: "SOCCER_6V6" } })), `venue.${key}`).toContain(`venue.${key}:FORMAT_NOT_EDITABLE`);
    }
    const { parsePlanningPlan } = await loadPlanning();
    expect(() => parsePlanningPlan(basePlan(), "SOCCER_9V9" as never)).toThrow();
    expect(() => parsePlanningPlan(basePlan(), undefined as never)).toThrow();
  });

  it("rejects any field the contract does not define, at every level, and a body that is not an object", async () => {
    expect(await violationsOf(basePlan({ extra: 1 }))).toContain("extra:UNKNOWN_FIELD");
    expect(await violationsOf(basePlan({ venue: { ...basePlan().venue, owner: "x" } }))).toContain("venue.owner:UNKNOWN_FIELD");
    expect(await violationsOf(basePlan({ pitches: [{ label: "A", usable: true, supportedFormats: ["SOCCER_5V5"], id: "x" }] }))).toContain("pitches[0].id:UNKNOWN_FIELD");
    expect(await violationsOf(withDates([{ date: "2026-11-07", windows: [{ start: "09:00", end: "13:00", pitch: "A" }] }]))).toContain("dates[0].windows[0].pitch:UNKNOWN_FIELD");
    expect(await violationsOf(basePlan({ rules: { version: "v1", snapshot: SNAPSHOT, digest: "abc" } }))).toContain("rules.digest:UNKNOWN_FIELD");
    expect(await violationsOf(basePlan({ organizerGamingMemberId: "m" }))).toContain("organizerGamingMemberId:UNKNOWN_FIELD");
    for (const bad of [null, undefined, 5, "x", [], [basePlan()]]) expect(await violationsOf(bad), String(bad)).toEqual(["plan:PLAN_NOT_OBJECT"]);
  });
});

describe("planning rules — the rules snapshot", () => {
  it("18. rejects a missing or malformed rules version and a missing or oversized snapshot", async () => {
    expect(await violationsOf(basePlan({ rules: undefined }))).toEqual(expect.arrayContaining(["rules:REQUIRED"]));
    expect(await violationsOf(basePlan({ rules: { snapshot: SNAPSHOT } }))).toContain("rules.version:REQUIRED");
    expect(await violationsOf(basePlan({ rules: { version: "draft-1" } }))).toContain("rules.snapshot:REQUIRED");
    expect(await violationsOf(basePlan({ rules: { version: "  ", snapshot: SNAPSHOT } }))).toContain("rules.version:REQUIRED");
    expect(await violationsOf(basePlan({ rules: { version: "draft-1", snapshot: "   " } }))).toContain("rules.snapshot:REQUIRED");
    for (const bad of ["has space", "x".repeat(33), "-leading", "semi;colon", "ünï", "a/b"]) {
      expect(await violationsOf(basePlan({ rules: { version: bad, snapshot: SNAPSHOT } })), bad).toContain("rules.version:INVALID");
    }
    for (const ok of ["draft-1", "v1.0", "2026.11_A", "x".repeat(32)]) expect(await violationsOf(basePlan({ rules: { version: ok, snapshot: SNAPSHOT } })), ok).toEqual([]);
    expect(await violationsOf(basePlan({ rules: { version: "v1", snapshot: "x".repeat(4001) } }))).toContain("rules.snapshot:TOO_LONG");
    expect(await violationsOf(basePlan({ rules: { version: "v1", snapshot: "x".repeat(4000) } }))).toEqual([]);
    expect(await violationsOf(basePlan({ rules: { version: "v1", snapshot: "bad\u0000text" } }))).toContain("rules.snapshot:INVALID_TEXT");
  });

  it("digests the stored snapshot with SHA-256 (hex), after trimming and normalizing line endings", async () => {
    const { rulesSnapshotDigest } = await loadPlanning();
    expect(rulesSnapshotDigest("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
    const plan = await accepted(basePlan({ rules: { version: "v1", snapshot: "  line one\r\nline two  \n" } }));
    expect(plan.rules.snapshot).toBe("line one\nline two");
    expect(rulesSnapshotDigest(plan.rules.snapshot)).toBe(createHash("sha256").update("line one\nline two", "utf8").digest("hex"));
  });
});

describe("the revision payload sent to the atomic save operation", () => {
  it("carries every fact explicitly (roster values included), nothing the registry owns, and no actor", async () => {
    const { planToRpcPayload } = await loadPlanning();
    const payload = planToRpcPayload(await accepted(basePlan({ roster: undefined })));
    expect(Object.keys(payload).sort()).toEqual(["dates", "pitches", "registration_deadline", "roster", "rules", "venue"]);
    expect(payload.roster).toEqual({ minimum: 5, maximum: 8 });
    expect(payload.venue).toEqual({
      name: "Cancha Central", location_description: "Calle 5, San José, behind the central market", time_zone: "America/Costa_Rica",
      simultaneous_match_capacity: 2, restriction_notes: "No metal cleats.",
    });
    expect(payload.registration_deadline).toEqual({ local: "2026-11-01T18:00", time_zone: "America/Costa_Rica", utc_offset_minutes: -360, utc: "2026-11-02T00:00:00.000Z" });
    expect(payload.pitches[1]).toEqual({ label: "B", usable: true, supported_formats: ["SOCCER_5V5", "SOCCER_6V6"], restriction_notes: "Lights off after 21:00." });
    expect(payload.dates[0]).toEqual({ date: "2026-11-07", windows: [{ start: "09:00", end: "13:00" }, { start: "15:00", end: "19:00" }] });
    expect(payload.rules).toEqual({ version: "draft-1", snapshot: SNAPSHOT });
    const text = JSON.stringify(payload);
    expect(text).not.toMatch(/gaming_member|organizer|minutes_per_half|halftime|format_key|activity|digest/i);
  });

  it("is deterministic: the same plan always yields the same bytes, and a different plan a different one", async () => {
    const { planToRpcPayload } = await loadPlanning();
    const a = JSON.stringify(planToRpcPayload(await accepted(basePlan())));
    const b = JSON.stringify(planToRpcPayload(await accepted(basePlan({ roster: { minimum: 5, maximum: 8 } }))));
    const c = JSON.stringify(planToRpcPayload(await accepted(basePlan({ roster: { minimum: 6, maximum: 8 } }))));
    expect(a).toBe(b);
    expect(a).not.toBe(c);
  });

  it("the public projection of a revision omits every identifier and the authoring member", async () => {
    const { publicRevision } = await loadPlanning();
    const record = {
      planningRevisionId: "rev-uuid", competitionId: "comp-uuid", formatKey: "SOCCER_5V5", revisionNumber: 3, supersedesRevisionNumber: 2,
      authoredByGamingMemberId: "member-uuid", createdAt: "2026-10-22T20:00:00.000Z",
      venue: { name: "V", locationDescription: "L", timeZone: "America/Costa_Rica", simultaneousMatchCapacity: 1, restrictionNotes: "" },
      pitches: [{ label: "A", usable: true, supportedFormats: ["SOCCER_5V5"], restrictionNotes: "" }],
      dates: [{ date: "2026-11-07", windows: [{ start: "09:00", end: "10:00" }] }],
      roster: { minimum: 5, maximum: 8 },
      registrationDeadline: { local: "2026-11-01T18:00", timeZone: "America/Costa_Rica", utcOffset: "-06:00", utc: "2026-11-02T00:00:00.000Z" },
      rules: { version: "v1", snapshot: "S", snapshotDigest: "d".repeat(64) },
    };
    const out = publicRevision(record as never);
    expect(out.revisionNumber).toBe(3);
    expect(out.supersedesRevisionNumber).toBe(2);
    expect(out.rules.snapshotDigest).toBe("d".repeat(64));
    const text = JSON.stringify(out);
    for (const secret of ["rev-uuid", "comp-uuid", "member-uuid", "planningRevisionId", "competitionId", "authoredBy", "gamingMember"]) expect(text).not.toContain(secret);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The HTTP boundary
// ---------------------------------------------------------------------------------------------------------------------------------------------

const COMPETITION_ID = "11111111-1111-4111-8111-111111111111";
const INTENT = "22222222-2222-4222-8222-222222222222";
const ORGANIZER = "auth-derived-organizer";
const OTHER = "someone-else";

function competition(overrides: Record<string, unknown> = {}) {
  return {
    competitionId: COMPETITION_ID, publicCode: "AbCdEfGhIjKlMnOpQrStUv", activityKey: "SOCCER_5V5", name: "Cup", organizerGamingMemberId: ORGANIZER,
    state: "DRAFT", cancelledReason: null, createdAt: "2026-10-22T00:00:00.000Z", publishedAt: null, ...overrides,
  };
}

function storedRevision(overrides: Record<string, unknown> = {}) {
  return {
    planningRevisionId: "rev-internal-id", competitionId: COMPETITION_ID, formatKey: "SOCCER_5V5", revisionNumber: 1, supersedesRevisionNumber: null,
    authoredByGamingMemberId: ORGANIZER, createdAt: "2026-10-22T20:00:00.000Z",
    venue: { name: "Cancha Central", locationDescription: "Calle 5", timeZone: "America/Costa_Rica", simultaneousMatchCapacity: 2, restrictionNotes: "" },
    pitches: [{ label: "A", usable: true, supportedFormats: ["SOCCER_5V5"], restrictionNotes: "" }, { label: "B", usable: true, supportedFormats: ["SOCCER_5V5"], restrictionNotes: "" }],
    dates: [{ date: "2026-11-07", windows: [{ start: "09:00", end: "13:00" }] }],
    roster: { minimum: 5, maximum: 8 },
    registrationDeadline: { local: "2026-11-01T18:00", timeZone: "America/Costa_Rica", utcOffset: "-06:00", utc: "2026-11-02T00:00:00.000Z" },
    rules: { version: "draft-1", snapshot: SNAPSHOT, snapshotDigest: "a".repeat(64) },
    ...overrides,
  };
}

function makeRepo() {
  return {
    getCompetitionById: vi.fn(),
    savePlanningRevision: vi.fn(),
    getCurrentPlanningRevision: vi.fn(),
    listCompetitions: vi.fn(),
    listCompetitionIdsInvolvingMember: vi.fn(),
  };
}

const POST_URL = `http://localhost/api/gaming/competitions/${COMPETITION_ID}/planning`;
const jsonRequest = (method: string, body?: unknown) =>
  new Request(POST_URL, { method, headers: { "content-type": "application/json", authorization: "Bearer t" }, body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body) });
const ctx = (competitionId: string = COMPETITION_ID) => ({ params: { competitionId } });

describe("the planning route (save and read)", () => {
  let repo: ReturnType<typeof makeRepo>;
  const original = process.env.COMPETITIONS_SCHEMA_READY;

  beforeEach(() => {
    repo = makeRepo();
    vi.resetAllMocks();
    process.env.COMPETITIONS_SCHEMA_READY = "true";
    vi.mocked(httpAuth.getSupabaseCredentials).mockReturnValue({ url: "http://fake", serviceKey: "fake" });
    vi.mocked(httpAuth.buildCompetitionsRepo).mockReturnValue(repo as unknown as ReturnType<typeof httpAuth.buildCompetitionsRepo>);
    vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ gamingMemberId: ORGANIZER });
    repo.getCompetitionById.mockResolvedValue(competition());
    repo.savePlanningRevision.mockResolvedValue({ revision: storedRevision(), alreadySaved: false, isCurrent: true });
    repo.getCurrentPlanningRevision.mockResolvedValue(storedRevision());
    return () => { if (original === undefined) delete process.env.COMPETITIONS_SCHEMA_READY; else process.env.COMPETITIONS_SCHEMA_READY = original; };
  });

  const route = () => import("../app/api/gaming/competitions/[competitionId]/planning/route");
  const post = async (body: unknown, competitionId?: string) => (await route()).POST(jsonRequest("POST", body), ctx(competitionId));
  const get = async (competitionId?: string) => (await route()).GET(jsonRequest("GET"), ctx(competitionId));
  const goodBody = (planOverrides: Record<string, unknown> = {}) => ({ intentId: INTENT, plan: basePlan(planOverrides) });

  it("20. saves a plan for the organizer's addressed draft: 201, the revision back, the actor and format derived server-side", async () => {
    const res = await post(goodBody());
    expect(res.status).toBe(201);
    const json = await res.json();
    expect(json.alreadySaved).toBe(false);
    expect(json.isCurrent).toBe(true);
    expect(json.revision.revisionNumber).toBe(1);
    expect(repo.savePlanningRevision).toHaveBeenCalledTimes(1);
    const [competitionId, organizerId, intentId, plan] = repo.savePlanningRevision.mock.calls[0];
    expect([competitionId, organizerId, intentId]).toEqual([COMPETITION_ID, ORGANIZER, INTENT]);
    expect(plan.roster).toEqual({ minimum: 5, maximum: 8 });          // defaults persisted explicitly
    expect(plan.registrationDeadline.utc).toBe("2026-11-02T00:00:00.000Z");
  });

  it("26. an exact replay answers 200 with alreadySaved, never 201", async () => {
    repo.savePlanningRevision.mockResolvedValue({ revision: storedRevision({ revisionNumber: 4 }), alreadySaved: true, isCurrent: true });
    const res = await post(goodBody());
    expect(res.status).toBe(200);
    expect((await res.json()).alreadySaved).toBe(true);
  });

  it("27. reusing an intent with a different payload is a 409 and returns nothing from the earlier save", async () => {
    const { PlanningIntentMismatchError } = await loadPlanning();
    repo.savePlanningRevision.mockRejectedValue(new PlanningIntentMismatchError());
    const res = await post(goodBody());
    expect(res.status).toBe(409);
    const text = JSON.stringify(await res.json());
    expect(text).not.toContain("Cancha");
  });

  it("never takes the actor, the format or any authority from the body: an unknown top-level field is refused before anything is read", async () => {
    for (const extra of [{ organizerGamingMemberId: OTHER }, { gamingMemberId: OTHER }, { authorityClass: "OPERATIONAL" }, { competitionId: OTHER }]) {
      repo.getCompetitionById.mockClear();
      const res = await post({ ...goodBody(), ...extra });
      expect(res.status, JSON.stringify(extra)).toBe(400);
      expect(repo.savePlanningRevision).not.toHaveBeenCalled();
    }
    for (const key of ["format", "formatKey", "activityKey"]) {
      const res = await post({ ...goodBody(), [key]: "SOCCER_6V6" });
      expect(res.status, key).toBe(400);
      expect(JSON.stringify(await res.json())).toContain("FORMAT_NOT_EDITABLE");
    }
    const insidePlan = await post(goodBody({ activityKey: "SOCCER_6V6" }));
    expect(insidePlan.status).toBe(400);
    expect(repo.savePlanningRevision).not.toHaveBeenCalled();
  });

  it("29. refuses a malformed competition identifier, a malformed intent identifier and a malformed body without reading or writing anything", async () => {
    for (const bad of ["not-a-uuid", "1", "' or 1=1 --", "11111111-1111-4111-8111-11111111111", "11111111-1111-4111-8111-1111111111111", "../1", ""]) {
      expect((await post(goodBody(), bad)).status, bad).toBe(404);
      expect((await get(bad)).status, bad).toBe(404);
    }
    expect(repo.getCompetitionById).not.toHaveBeenCalled();
    for (const bad of [undefined, "", "not-a-uuid", 5, null, "22222222-2222-4222-8222-22222222222"]) {
      const res = await post({ intentId: bad, plan: basePlan() });
      expect(res.status, String(bad)).toBe(400);
    }
    expect((await post("{ not json")).status).toBe(400);
    expect((await post("[]")).status).toBe(400);
    expect((await post("null")).status).toBe(400);
    expect((await post({ intentId: INTENT })).status).toBe(400);
    expect(repo.savePlanningRevision).not.toHaveBeenCalled();
  });

  it("returns every validation problem at once (400) and never saves an invalid plan", async () => {
    const res = await post(goodBody({ venue: { ...basePlan().venue, name: "" }, dates: [] }));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.problems.map((p: { field: string; code: string }) => `${p.field}:${p.code}`)).toEqual(expect.arrayContaining(["venue.name:REQUIRED", "dates:DATE_COUNT_INVALID"]));
    expect(repo.savePlanningRevision).not.toHaveBeenCalled();
  });

  it("derives the format from the stored competition, not the request: the same plan is judged against the competition's own format", async () => {
    repo.getCompetitionById.mockResolvedValue(competition({ activityKey: "SOCCER_7V7" }));
    const res = await post(goodBody());                                  // pitches support 5v5/6v6 only, roster 5-8
    expect(res.status).toBe(400);
    const codes = (await res.json()).problems.map((p: { code: string }) => p.code);
    expect(codes).toEqual(expect.arrayContaining(["FORMAT_NOT_SUPPORTED_BY_ANY_USABLE_PITCH", "ROSTER_MINIMUM_OUT_OF_RANGE"]));
  });

  it("21/22/23/24. only the active organizer may save: an unrelated member, a former host and an unknown competition are refused before the plan is judged", async () => {
    repo.getCompetitionById.mockResolvedValue(competition({ organizerGamingMemberId: OTHER }));
    expect((await post(goodBody())).status).toBe(403);
    repo.getCompetitionById.mockResolvedValue(competition({ hostBound: true, hostAccessRevoked: true }));
    expect((await post(goodBody())).status).toBe(403);
    repo.getCompetitionById.mockResolvedValue(null);
    expect((await post(goodBody())).status).toBe(404);
    expect(repo.savePlanningRevision).not.toHaveBeenCalled();
    // An invalid plan from a non-organizer learns nothing about validity.
    repo.getCompetitionById.mockResolvedValue(competition({ organizerGamingMemberId: OTHER }));
    const res = await post({ intentId: INTENT, plan: { nonsense: true } });
    expect(res.status).toBe(403);
    expect(JSON.stringify(await res.json())).not.toContain("UNKNOWN_FIELD");
  });

  it("25. refuses a competition that is no longer a draft (409) and says nothing about the plan", async () => {
    for (const state of ["TEAM_REGISTRATION_OPEN", "READY_TO_PUBLISH", "PUBLISHED", "COMPLETE", "CANCELLED_WITHOUT_CHAMPION"]) {
      repo.getCompetitionById.mockResolvedValue(competition({ state }));
      expect((await post(goodBody())).status, state).toBe(409);
    }
    expect(repo.savePlanningRevision).not.toHaveBeenCalled();
  });

  it("maps the database's own refusals (the organizer check and the host-revocation guard run again inside the atomic operation)", async () => {
    repo.savePlanningRevision.mockRejectedValueOnce(new CompetitionAccessDeniedError());
    expect((await post(goodBody())).status).toBe(403);
    repo.savePlanningRevision.mockRejectedValueOnce(new HostAccessRevokedError());
    expect((await post(goodBody())).status).toBe(403);
    repo.savePlanningRevision.mockRejectedValueOnce(new CompetitionNotDraftError());
    expect((await post(goodBody())).status).toBe(409);
    const { PlanningValidationError } = await loadPlanning();
    repo.savePlanningRevision.mockRejectedValueOnce(new PlanningValidationError([{ field: "dates", code: "DATE_COUNT_INVALID", message: "x" }]));
    expect((await post(goodBody())).status).toBe(400);
    repo.savePlanningRevision.mockRejectedValueOnce(new Error("relation \"competition_planning_revisions\" exploded at 10.0.0.1"));
    const res = await post(goodBody());
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/relation|10\.0\.0\.1|competition_planning/);
  });

  it("is closed while the Competitions schema is not ready, and signed-out callers get the 401 untouched", async () => {
    delete process.env.COMPETITIONS_SCHEMA_READY;
    expect((await post(goodBody())).status).toBe(503);
    expect((await get()).status).toBe(503);
    process.env.COMPETITIONS_SCHEMA_READY = "true";
    vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ errorResponse: new Response(JSON.stringify({ error: "no" }), { status: 401 }) as never });
    expect((await post(goodBody())).status).toBe(401);
    expect((await get()).status).toBe(401);
    expect(repo.getCompetitionById).not.toHaveBeenCalled();
  });

  it("20/30. reads only the addressed competition's current revision: the revision and the format context, nothing else", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    const json = await res.json();
    expect(json.revision.revisionNumber).toBe(1);
    expect(json.context.formatKey).toBe("SOCCER_5V5");
    expect(json.context.timing.minutesPerHalf).toBe(10);
    expect(repo.getCurrentPlanningRevision).toHaveBeenCalledTimes(1);
    expect(repo.getCurrentPlanningRevision).toHaveBeenCalledWith(COMPETITION_ID);
    expect(repo.listCompetitions).not.toHaveBeenCalled();
    expect(repo.listCompetitionIdsInvolvingMember).not.toHaveBeenCalled();
    const text = JSON.stringify(json);
    for (const secret of ["rev-internal-id", "authoredBy", ORGANIZER, "planningRevisionId", "competitionId", "publicCode", "organizerGamingMemberId"]) expect(text).not.toContain(secret);
  });

  it("SSS-004A: an authorized organizer with no saved plan yet gets a SUCCESS: 200, uncacheable, the bounded context, and `revision: null`", async () => {
    repo.getCurrentPlanningRevision.mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    const json = await res.json();
    expect(Object.keys(json).sort()).toEqual(["context", "revision"]);
    expect(json.revision).toBeNull();
    expect(json.context.formatKey).toBe("SOCCER_5V5");
    expect(json.context.timing.minutesPerHalf).toBe(10);
    expect(repo.getCurrentPlanningRevision).toHaveBeenCalledTimes(1);
  });

  it("SSS-004A: with a saved revision the SAME success shape carries it: 200, the same context keys, `revision` an object", async () => {
    const empty = await (async () => { repo.getCurrentPlanningRevision.mockResolvedValueOnce(null); return (await get()).json(); })();
    const saved = await (await get()).json();
    expect(Object.keys(saved).sort()).toEqual(Object.keys(empty).sort());
    expect(Object.keys(saved.context).sort()).toEqual(Object.keys(empty.context).sort());
    expect(saved.revision.revisionNumber).toBe(1);
  });

  it("SSS-004A: read access to your own competition's plan does not depend on its state — an owned non-draft with no plan is the same 200/null", async () => {
    repo.getCompetitionById.mockResolvedValue(competition({ state: "PUBLISHED" }));
    repo.getCurrentPlanningRevision.mockResolvedValue(null);
    const res = await get();
    expect(res.status).toBe(200);
    expect((await res.json()).revision).toBeNull();
  });

  it("21/22/23/24/30. every caller who is not the active organizer — and every unknown or malformed address — gets the SAME uniform 404 with no context", async () => {
    const bodies: string[] = [];
    const collect = async (res: Response) => { expect(res.status).toBe(404); expect(res.headers.get("cache-control")).toMatch(/no-store/); bodies.push(JSON.stringify(await res.json())); };
    repo.getCompetitionById.mockResolvedValue(competition({ organizerGamingMemberId: OTHER }));      // unrelated organizer / scorekeeper-only / captain / registrant / applicant or capability-only member
    await collect(await get());
    repo.getCompetitionById.mockResolvedValue(competition({ hostBound: true, hostAccessRevoked: true }));   // former host
    await collect(await get());
    repo.getCompetitionById.mockResolvedValue(null);                                                         // unknown competition
    await collect(await get());
    await collect(await get("not-a-uuid"));                                                                  // malformed address
    expect(new Set(bodies).size).toBe(1);
    expect(JSON.parse(bodies[0])).toEqual({ error: "Planning was not found for this competition." });   // no format, state, context, revision status or existence hint
    for (const hint of ["SOCCER", "context", "revision", "DRAFT", "state", "format", "timing", "roster"]) expect(bodies[0], hint).not.toContain(hint);
    expect(repo.getCurrentPlanningRevision).not.toHaveBeenCalled();
  });

  it("every response, success or failure, is uncacheable", async () => {
    const responses = [
      await post(goodBody()), await post("{ bad"), await post(goodBody(), "nope"), await get(), await get("nope"),
    ];
    repo.getCompetitionById.mockResolvedValue(competition({ state: "PUBLISHED" }));
    responses.push(await post(goodBody()));
    repo.savePlanningRevision.mockRejectedValueOnce(new Error("boom"));
    repo.getCompetitionById.mockResolvedValue(competition());
    responses.push(await post(goodBody()));
    for (const res of responses) expect(res.headers.get("cache-control"), String(res.status)).toMatch(/no-store/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Availability preservation: nothing about planning makes another format creatable, selectable or advertised
// ---------------------------------------------------------------------------------------------------------------------------------------------

function walk(dir: string, accept: (file: string) => boolean, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name === ".git") continue;
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) walk(full, accept, out);
    else if (accept(full)) out.push(full);
  }
  return out;
}

describe("availability preservation", () => {
  it("32. no public page or script mentions a 6v6, 7v7 or 8v8 option or key", () => {
    const files = walk(path.join(REPO_ROOT, "public"), (f) => /\.(html|js|css|json|svg|txt)$/.test(f));
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      expect(text, path.relative(REPO_ROOT, file)).not.toMatch(/SOCCER_[678]V[678]/i);
      expect(text, path.relative(REPO_ROOT, file)).not.toMatch(/\b[678]\s?v\s?[678]\b/i);
    }
  });

  it("33. no approved-format capability exists yet — not in code, pages, or the planning migration", () => {
    const files = [
      ...walk(path.join(REPO_ROOT, "lib"), (f) => f.endsWith(".ts")),
      ...walk(path.join(REPO_ROOT, "app"), (f) => f.endsWith(".ts") || f.endsWith(".tsx")),
      ...walk(path.join(REPO_ROOT, "public"), (f) => /\.(html|js)$/.test(f)),
    ];
    const migration = planningMigrationPath();
    if (migration) files.push(migration);
    for (const file of files) expect(readFileSync(file, "utf8"), path.relative(REPO_ROOT, file)).not.toMatch(/approved[_\s-]?formats?|format[_\s-]?capabilit|supported[_\s-]?format[_\s-]?capabilit/i);
  });

  it("31. the creation routes, domain and host path still know exactly one format: they take the activity from the request or fix it, never from the registry", () => {
    const create = read("lib/gaming/competitions/createCompetition.ts");
    expect(create).not.toMatch(/formats|SOCCER_FORMAT|planning/);
    const hostCreate = read("app/api/gaming/host/competition/route.ts");
    expect(hostCreate).not.toMatch(/activityKey|formats|SOCCER_/);
    const general = read("app/api/gaming/competitions/route.ts");
    expect(general).not.toMatch(/planning|formats/);
    const creationMigrations = readdirSync(path.join(REPO_ROOT, "supabase/migrations")).filter((f) => /create_competition|host_competition/i.test(f));
    expect(creationMigrations.length).toBeGreaterThan(0);
    const newMigration = planningMigrationPath();
    if (newMigration) {
      const sql = readFileSync(newMigration, "utf8");
      expect(sql).not.toMatch(/create (or replace )?function\s+(public\.)?(create_competition_atomically|create_host_competition|consume_host)/i);
    }
  });

  it("the admin page offers no format selector for planning and exposes no format other than the one read-only value", () => {
    const html = read("public/competitions-admin.html");
    expect(html).not.toMatch(/id="planning[^"]*format[^"]*"[^>]*>\s*<option/i);
    // The only select that mentions a format is the pre-existing 5v5-only creation selector.
    const selects = [...html.matchAll(/<select[^>]*>([\s\S]*?)<\/select>/g)].map((m) => m[1]).filter((s) => /SOCCER_/.test(s));
    expect(selects).toHaveLength(1);
    expect(selects[0]).toContain("SOCCER_5V5");
    expect(selects[0]).not.toMatch(/SOCCER_[678]V/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The migration's static security contract
// ---------------------------------------------------------------------------------------------------------------------------------------------

const MIGRATIONS_DIR = path.join(REPO_ROOT, "supabase/migrations");
const SSS_001_MIGRATION = "20261022143819_small_sided_soccer_format_rules_foundation.sql";

function planningMigrationPath(): string | null {
  const found = readdirSync(MIGRATIONS_DIR).filter((f) => /organizer_planning/i.test(f));
  return found.length === 1 ? path.join(MIGRATIONS_DIR, found[0]) : null;
}

const NEW_TABLES = [
  "competition_planning_revisions", "competition_planning_pitches", "competition_planning_pitch_formats",
  "competition_planning_dates", "competition_planning_windows",
];

describe("the Organizer Planning migration (static contract)", () => {
  it("is exactly one new migration, after the format-rules foundation, with a descriptive Organizer Planning name", () => {
    const all = readdirSync(MIGRATIONS_DIR).filter((f) => /organizer_planning/i.test(f));
    expect(all).toHaveLength(1);
    expect(all[0]).toMatch(/^\d{14}_[a-z0-9_]*organizer_planning[a-z0-9_]*\.sql$/);
    expect(all[0] > SSS_001_MIGRATION).toBe(true);
    const after = readdirSync(MIGRATIONS_DIR).filter((f) => f > SSS_001_MIGRATION);
    expect(after).toEqual(all);
  });

  const sql = () => {
    const file = planningMigrationPath();
    if (!file) throw new Error("the planning migration does not exist yet");
    return readFileSync(file, "utf8");
  };
  const code = () => sql().split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");

  it("creates exactly the five planning tables and nothing else that stores data", () => {
    const created = [...code().matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_]+)/gi)].map((m) => m[1]);
    expect(created.sort()).toEqual([...NEW_TABLES].sort());
  });

  it("server-only: row-level security on every new table, every privilege revoked from every role, only select re-granted to the service role", () => {
    const text = code();
    for (const table of NEW_TABLES) {
      expect(text, table).toMatch(new RegExp(`alter\\s+table\\s+${table}\\s+enable\\s+row\\s+level\\s+security`, "i"));
      expect(text, table).toMatch(new RegExp(`revoke\\s+all\\s+on\\s+(?:table\\s+)?${table}\\s+from\\s+public\\s*,\\s*anon\\s*,\\s*authenticated\\s*,\\s*service_role`, "i"));
      expect(text, table).toMatch(new RegExp(`grant\\s+select\\s+on\\s+(?:table\\s+)?${table}\\s+to\\s+service_role\\s*;`, "i"));
    }
    expect(text).not.toMatch(/grant\s+[^;]*\bto\s+[^;]*\b(anon|authenticated|public)\b/i);
    expect(text).not.toMatch(/grant\s+(insert|update|delete|all)\b[^;]*on\s+(?:table\s+)?competition_planning/i);
    expect(text).not.toMatch(/create\s+policy/i);
  });

  it("19. every planning table refuses UPDATE and DELETE (an append-only trigger), so a saved revision and its children can never change", () => {
    const text = code();
    for (const table of NEW_TABLES) {
      expect(text, table).toMatch(new RegExp(`create\\s+trigger\\s+[a-z_0-9]+\\s+before\\s+update\\s+or\\s+delete\\s+on\\s+${table}\\b`, "i"));
    }
    expect(text).toMatch(/truncate/i);
  });

  it("the one save operation is SECURITY DEFINER with a pinned search_path, executable by the service role alone", () => {
    const text = code();
    expect(text).toMatch(/create\s+function\s+save_competition_planning_revision_atomically\s*\(/i);
    const body = text.slice(text.search(/create\s+function\s+save_competition_planning_revision_atomically/i));
    expect(body).toMatch(/security\s+definer/i);
    expect(body).toMatch(/set\s+search_path\s*(=|to)\s*public\s*,\s*pg_temp/i);
    expect(text).toMatch(/revoke\s+all\s+on\s+function\s+save_competition_planning_revision_atomically\s*\([^)]*\)\s+from\s+public\s*,\s*anon\s*,\s*authenticated\s*;/i);
    expect(text).toMatch(/grant\s+execute\s+on\s+function\s+save_competition_planning_revision_atomically\s*\([^)]*\)\s+to\s+service_role\s*;/i);
    // Every trigger function is internal: nothing can call it.
    for (const fn of [...text.matchAll(/create\s+function\s+([a-z_0-9]+)\s*\(\s*\)\s+returns\s+trigger/gi)].map((m) => m[1])) {
      expect(text, fn).toMatch(new RegExp(`revoke\\s+all\\s+on\\s+function\\s+${fn}\\s*\\(\\s*\\)\\s+from\\s+public\\s*,\\s*anon\\s*,\\s*authenticated\\s*;`, "i"));
    }
  });

  it("the save operation applies the accepted authorization order: lock, exact ownership (null-safe), host-revocation guard, DRAFT, then the registry rule", () => {
    const text = code();
    const body = text.slice(text.search(/create\s+function\s+save_competition_planning_revision_atomically/i));
    const at = (re: RegExp) => { const i = body.search(re); expect(i, String(re)).toBeGreaterThan(-1); return i; };
    const lock = at(/pg_advisory_xact_lock\s*\(\s*hashtext\s*\(\s*'competition_scope:'/i);
    const forUpdate = at(/from\s+competitions[\s\S]{0,200}for\s+update/i);
    const owner = at(/p_organizer_gaming_member_id\s+is\s+distinct\s+from\s+v_organizer_id/i);
    const revoked = at(/assert_competition_not_host_revoked\s*\(/i);
    const draft = at(/COMPETITION_NOT_DRAFT/);
    const registry = at(/from\s+competition_format_rules/i);
    const insert = at(/insert\s+into\s+competition_planning_revisions/i);
    expect(lock).toBeLessThan(forUpdate);
    expect(forUpdate).toBeLessThan(owner);
    expect(owner).toBeLessThan(revoked);
    expect(revoked).toBeLessThan(draft);
    expect(draft).toBeLessThan(registry);
    expect(registry).toBeLessThan(insert);
    expect(body).not.toMatch(/p_organizer_gaming_member_id\s*(<>|!=)\s*v_organizer_id/i);
    expect(body).not.toMatch(/authority_grants|OPERATIONAL/i);   // ordinary planning needs no OPERATIONAL grant
  });

  it("depends on no extension, no event trigger and no provider configuration, and touches no other table, fixture, draw or schedule", () => {
    const text = code();
    expect(text).not.toMatch(/create\s+extension/i);
    expect(text).not.toMatch(/event\s+trigger/i);
    expect(text).not.toMatch(/create\s+table[^;]*(fixture|draw|schedule|appeal|adjudicat|venue_activation|capabilit)/i);
    expect(text).not.toMatch(/\bvenues\b|venue_activations/i);
    expect(text).not.toMatch(/insert\s+into\s+competition_format_rules|update\s+competition_format_rules|delete\s+from\s+competition_format_rules/i);
    // The only change to an existing table: the unique key that lets a revision's format be tied to its competition's by a composite foreign key.
    const alters = [...text.matchAll(/alter\s+table\s+(?:public\.)?([a-z_]+)\s+(add|drop|alter|rename)/gi)].map((m) => `${m[1]} ${m[2].toLowerCase()}`);
    expect(alters.filter((a) => !a.startsWith("competition_planning"))).toEqual(["competitions add"]);
  });

  it("SSS-004A: a pitch's supported format is a foreign key to the authoritative registry (never a duplicated list as the only boundary), and a revision stays tied to its competition's own format", () => {
    const text = code();
    const pitchFormats = /create\s+table\s+competition_planning_pitch_formats\s*\(([\s\S]*?)\n\);/i.exec(text);
    expect(pitchFormats, "the pitch-format table").not.toBeNull();
    expect(pitchFormats![1]).toMatch(/constraint\s+competition_planning_pitch_formats_format_registry_fkey\s+foreign\s+key\s*\(\s*format_key\s*\)\s+references\s+competition_format_rules\s*\(\s*format_key\s*\)/i);
    expect(pitchFormats![1]).not.toMatch(/check\s*\(\s*format_key\s+in\s*\(/i);
    expect(text).not.toMatch(/format_key\s+in\s*\(\s*'SOCCER_5V5'\s*,\s*'SOCCER_6V6'/i);
    expect(text).toMatch(/add\s+constraint\s+competition_planning_revisions_competition_format_fkey\s+foreign\s+key\s*\(\s*competition_id\s*,\s*format_key\s*\)\s+references\s+competitions\s*\(\s*competition_id\s*,\s*activity_key\s*\)/i);
  });

  it("SSS-004A: every internal helper (including the clock-change resolver) is executable by nobody, and the registry migration is not edited", () => {
    const text = code();
    const helpers = [...text.matchAll(/create\s+function\s+(competition_planning_[a-z_]+)\s*\(/gi)].map((m) => m[1]);
    expect(helpers).toEqual(expect.arrayContaining(["competition_planning_local_time_kind", "competition_planning_clean_text", "competition_planning_assert_keys"]));
    for (const fn of helpers) {
      expect(text, fn).toMatch(new RegExp(`revoke\\s+all\\s+on\\s+function\\s+${fn}\\s*\\([^)]*\\)\\s+from\\s+public\\s*,\\s*anon\\s*,\\s*authenticated\\s*;`, "i"));
      expect(text, fn).toMatch(new RegExp(`revoke\\s+all\\s+on\\s+function\\s+${fn}\\s*\\([^)]*\\)\\s+from\\s+service_role\\s*;`, "i"));
    }
  });

  it("SSS-004A: the save operation refuses a nonexistent or ambiguous window endpoint itself (it does not rely on the application having checked)", () => {
    const text = code();
    const body = text.slice(text.search(/create\s+function\s+save_competition_planning_revision_atomically/i));
    expect(body).toMatch(/competition_planning_local_time_kind\s*\(/);
    expect(body).toMatch(/WINDOW_NONEXISTENT_LOCAL_TIME/);
    expect(body).toMatch(/WINDOW_AMBIGUOUS_LOCAL_TIME/);
  });

  it("keeps every identifier within PostgreSQL's 63-character limit (a longer one is silently truncated)", () => {
    const names = [...code().matchAll(/\b(?:constraint|index|trigger)\s+([a-z_0-9]+)/gi)].map((m) => m[1]);
    expect(names.length).toBeGreaterThan(10);
    for (const name of names) expect(name.length, name).toBeLessThanOrEqual(63);
  });

  it("the earlier migration files are untouched: the planning migration is the only file after the SSS-001 foundation", () => {
    expect(existsSync(path.join(MIGRATIONS_DIR, SSS_001_MIGRATION))).toBe(true);
    expect(createHash("sha256").update(readFileSync(path.join(MIGRATIONS_DIR, SSS_001_MIGRATION))).digest("hex")).toBe("3e18d5cc4f637f2040f946b1dfb79b3251c91640133c94c898009d4b379bd41f");
  });
});
