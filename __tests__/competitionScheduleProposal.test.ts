import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mocks the ONE module boundary between a route and the outside world (credentials, repository construction, caller identity), exactly as
// competitions.test.ts and competitionDraw.test.ts do; statusForCompetitionsError and the schema-ready guard keep their REAL implementation.
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

import * as httpAuth from "../lib/gaming/competitions/httpAuth";
import { SupabaseCompetitionsRepository, translateError } from "../lib/gaming/competitions/db/supabaseCompetitionsRepository";
import { SOCCER_FORMAT_KEYS } from "../lib/gaming/competitions/formats";
import type { ScheduleContextRecord, ScheduleProposalRead, ScheduleProposalRecord } from "../lib/gaming/competitions/types";
import { CompetitionAccessDeniedError, CompetitionNotFoundError, HostAccessRevokedError } from "../lib/gaming/competitions/types";

/**
 * UG-CR-GATE-SSS-022 — the four-team schedule proposal foundation, application side.
 *
 * Every DECISION (who may propose, the lifecycle, the one permanent draw, the current accepted plan, a plan change that awaits the captains, the idempotency, the
 * sequence and the supersession, every scheduling rule) is made inside the one atomic database operation and is proved against a real database in
 * competitionScheduleProposalSupabase.contract.test.ts. This file proves what the application adds on top, and that it adds nothing it should not:
 * the strict request allowlist (exactly three placements; nothing the server derives), the pure evaluator the database also implements — against an INDEPENDENT
 * oracle (Python zoneinfo/hashlib wrote every literal below, from the gate's text, not this code) — the timing derived from the format registry, the digests and the
 * reproduction of a stored proposal from its own evidence, the typed refusals, the bounded shapes a browser is shown, the route's uniform non-enumerating answers, and
 * the static facts about the surface (no clock, no randomness, no page control, no format named, one append-only migration).
 *
 * The modules under test are loaded lazily so that, before they exist, every test here fails for the behavior it is missing and not because the file could not be
 * collected.
 */

const loadSp = () => import("../lib/gaming/competitions/scheduleProposal");
const ROUTE = "../app/api/gaming/competitions/[competitionId]/schedule-proposal/route";
type Ctx = { params: { competitionId: string } };
type Handler = (request: Request, context: Ctx) => Promise<Response>;
const loadRoute = () => import(/* @vite-ignore */ ROUTE) as Promise<Record<string, Handler | undefined>>;

const REPO_ROOT = path.resolve(__dirname, "..");
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), "utf8");
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
function walk(dir: string, accept: (file: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, accept));
    else if (accept(full)) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The independent oracle (oracle.py, Python zoneinfo / hashlib — written from the gate's text, sharing no code with the TypeScript or the SQL)
// ---------------------------------------------------------------------------------------------------------------------------------------------

const CID = "11111111-1111-4111-8111-111111111111";
const INTENT = "33333333-3333-4333-8333-333333333333";
const INTENT_2 = "44444444-4444-4444-8444-444444444444";
const REV_ID = "22222222-2222-4222-8222-222222222222";
const DRAW_ID = "55555555-5555-4555-8555-555555555555";
const DRAW_DIGEST = sha("draw"); // 50f7becde477bb509c7704de62c349247fb3499c03a95e4bce20151cd552dea5
const ORGANIZER = "00000000-0000-4000-8000-0000000000a1";
const CAPTAIN = "00000000-0000-4000-8000-0000000000c1";
const SCOREKEEPER = "00000000-0000-4000-8000-0000000000e1";
const REGISTRANT = "00000000-0000-4000-8000-0000000000f1";
const OPERATIONAL = "00000000-0000-4000-8000-0000000000b1";
const STRANGER = "00000000-0000-4000-8000-0000000000d9";
const TEAMS = [
  { teamId: "1b0a7c5e-3d24-4c1f-9a53-0e8d2f6b7a01", teamName: "Rayo FC" }, { teamId: "3f9d2a10-7b6e-4d85-8c42-5a1e9b0c3d02", teamName: "Los Halcones" },
  { teamId: "8c41e7d9-0a35-4b6f-a1d8-2c7e5f9b4a03", teamName: "Tigres 5" }, { teamId: "d2e6b8f1-5c97-4a30-b4e2-9f1a6d8c0b04", teamName: "Deportivo Sur" },
];

/** The accepted values by format, from the gate: reserved occupancy, same-pitch kickoff separation, and the earliest final after the LATER semifinal's kickoff. */
const GATE_TIMING: Record<string, { occupancy: number; transition: number; rest: number; gap: number; finalLead: number }> = {
  SOCCER_5V5: { occupancy: 38, transition: 10, rest: 30, gap: 48, finalLead: 68 },
  SOCCER_6V6: { occupancy: 42, transition: 10, rest: 30, gap: 52, finalLead: 72 },
  SOCCER_7V7: { occupancy: 50, transition: 10, rest: 45, gap: 60, finalLead: 95 },
  SOCCER_8V8: { occupancy: 50, transition: 10, rest: 45, gap: 60, finalLead: 95 },
};

const PITCH: Record<string, string> = {
  A: "a0a0a0a0-a0a0-40a0-80a0-a0a0a0a0a001", B: "b0b0b0b0-b0b0-40b0-80b0-b0b0b0b0b002", C: "c0c0c0c0-c0c0-40c0-80c0-c0c0c0c0c003",
  E: "e0e0e0e0-e0e0-40e0-80e0-e0e0e0e0e005", F: "f0f0f0f0-f0f0-40f0-80f0-f0f0f0f0f006", X: "99999999-9999-4999-8999-999999999999",
};
const DAY: Record<string, string> = { "1": "2026-11-14", "2": "2026-11-15", "3": "2026-11-16" };
const ALL4 = ["SOCCER_5V5", "SOCCER_6V6", "SOCCER_7V7", "SOCCER_8V8"];

/** The Costa Rica plan of the oracle: capacity 2; A and B take every format, C five-a-side only, E is unusable, F takes six-a-side only; day 1 has two windows, day 2 two windows 5 minutes apart. */
function crFacts(over: Record<string, unknown> = {}) {
  return {
    formatKey: "SOCCER_5V5", timeZone: "America/Costa_Rica", simultaneousMatchCapacity: 2,
    pitches: [
      { planningPitchId: PITCH.A, label: "A", usable: true, supportedFormats: ALL4 }, { planningPitchId: PITCH.B, label: "B", usable: true, supportedFormats: ALL4 },
      { planningPitchId: PITCH.C, label: "C", usable: true, supportedFormats: ["SOCCER_5V5"] }, { planningPitchId: PITCH.E, label: "E", usable: false, supportedFormats: ["SOCCER_5V5"] },
      { planningPitchId: PITCH.F, label: "F", usable: true, supportedFormats: ["SOCCER_6V6"] },
    ],
    dates: [
      { date: DAY["1"], windows: [{ start: "09:00", end: "12:00" }, { start: "13:00", end: "16:00" }] },
      { date: DAY["2"], windows: [{ start: "09:00", end: "10:00" }, { start: "10:05", end: "12:00" }] },
    ],
    ...over,
  };
}
const nyFacts = (date: string, windows: Array<{ start: string; end: string }>) => ({
  formatKey: "SOCCER_5V5", timeZone: "America/New_York", simultaneousMatchCapacity: 2,
  pitches: [{ planningPitchId: PITCH.A, label: "A", usable: true, supportedFormats: ALL4 }, { planningPitchId: PITCH.B, label: "B", usable: true, supportedFormats: ALL4 }],
  dates: [{ date, windows }],
});
const NY_FALL = () => nyFacts("2026-11-01", [{ start: "00:00", end: "05:00" }]);
const NY_SPRING = () => nyFacts("2027-03-14", [{ start: "00:00", end: "05:00" }, { start: "06:00", end: "12:00" }]);

const NOW = Date.parse("2026-11-10T12:00:00.000Z");
const NOW_NY = Date.parse("2026-10-30T14:00:00.000Z");

/** "A 1 09:00" = pitch A, day 1, venue-local 09:00. */
function placement(role: string, spec: string) {
  const [label, day, time] = spec.split(" ");
  return { fixtureRole: role, planningPitchId: PITCH[label], planDate: DAY[day], startTime: time };
}
const placementsOf = (a: string, b: string, c: string) => [placement("SEMIFINAL_1", a), placement("SEMIFINAL_2", b), placement("FINAL", c)];

// Costa Rica has no daylight saving: always UTC-06:00, so these instants are arithmetic, not a second implementation of anything.
const crInstant = (day: string, hhmm: string) => new Date(Date.parse(`${DAY[day]}T${hhmm}:00-06:00`)).toISOString();
const crWindow = (day: string, hhmm: string): [string, string] => {
  const windows: Record<string, Array<[string, string]>> = { "1": [["09:00", "12:00"], ["13:00", "16:00"]], "2": [["09:00", "10:00"], ["10:05", "12:00"]] };
  const found = windows[day].find(([s, e]) => hhmm >= s && hhmm < e)!;
  return [crInstant(day, found[0]), crInstant(day, found[1])];
};

/** Every row below was decided by the oracle AND by hand; the oracle printed zero disagreements. [name, SF1, SF2, FINAL, first violation or OK, optional decision instant] */
const CR_MATRIX: Array<[name: string, sf1: string, sf2: string, final: string, expected: string, now?: string]> = [
  ["valid: simultaneous semifinals on two pitches, final 68 minutes after their kickoff", "A 1 09:00", "B 1 09:00", "A 1 10:08", "OK"],
  ["valid: same pitch, semifinal 2 exactly 48 minutes after semifinal 1", "A 1 09:00", "A 1 09:48", "B 1 10:56", "OK"],
  ["valid: the final in the second window of the day", "A 1 09:00", "B 1 09:00", "A 1 13:00", "OK"],
  ["valid: the final on the next day", "A 1 09:00", "B 1 09:00", "A 2 10:10", "OK"],
  ["valid: all three on one pitch at the exact minimum separations", "A 1 09:00", "A 1 09:48", "A 1 10:56", "OK"],
  ["valid: the final's occupancy ends exactly at the window end (11:22 + 38 = 12:00)", "A 1 09:00", "B 1 09:00", "A 1 11:22", "OK"],
  ["valid: a match ending exactly at a window end, the next window opening 5 minutes later, on another pitch", "A 2 09:22", "B 2 10:05", "A 2 11:14", "OK"],
  ["valid: staggered semifinals back to back on two pitches with capacity 2", "A 1 09:00", "B 1 09:30", "A 1 10:38", "OK"],
  ["valid: semifinals on different days", "A 1 09:00", "B 2 09:00", "A 2 10:38", "OK"],
  ["pitch not in the plan", "X 1 09:00", "B 1 09:00", "A 1 10:08", "PITCH_NOT_IN_PLAN"],
  ["pitch not usable", "A 1 09:00", "E 1 09:00", "A 1 10:08", "PITCH_NOT_USABLE"],
  ["pitch that supports another format only", "A 1 09:00", "B 1 09:00", "F 1 10:08", "PITCH_FORMAT_UNSUPPORTED"],
  ["a foreign pitch is reported before a bad date of the same placement", "X 3 09:00", "B 1 09:00", "A 1 10:08", "PITCH_NOT_IN_PLAN"],
  ["date not in the plan", "A 1 09:00", "B 3 09:00", "A 1 10:08", "DATE_NOT_IN_PLAN"],
  ["start one minute before the window opens", "A 1 08:59", "B 1 09:00", "A 1 10:08", "OUTSIDE_WINDOW"],
  ["start in the gap between two windows", "A 1 09:00", "B 1 09:00", "A 1 12:30", "OUTSIDE_WINDOW"],
  ["occupancy ends one minute after the window ends (11:23 + 38 = 12:01)", "A 1 09:00", "B 1 09:00", "A 1 11:23", "OUTSIDE_WINDOW"],
  ["a start after the last window of the day", "A 1 09:00", "B 1 09:00", "A 1 16:00", "OUTSIDE_WINDOW"],
  ["start exactly at the decision instant is not strictly future", "A 1 09:00", "B 1 09:00", "A 1 10:08", "START_NOT_FUTURE", "2026-11-14T15:00:00.000Z"],
  ["start one millisecond after the decision instant is future", "A 1 09:00", "B 1 09:00", "A 1 10:08", "OK", "2026-11-14T14:59:59.999Z"],
  ["a start in the past is reported before the window check", "A 1 08:00", "B 1 09:00", "A 1 10:08", "START_NOT_FUTURE", "2026-11-14T14:30:00.000Z"],
  ["same pitch, simultaneous semifinals", "A 1 09:00", "A 1 09:00", "B 1 10:08", "PITCH_OVERLAP"],
  ["same pitch, partially overlapping occupancy", "A 1 09:00", "A 1 09:30", "B 1 10:38", "PITCH_OVERLAP"],
  ["same pitch, back to back with no transition (38 minutes)", "A 1 09:00", "A 1 09:38", "B 1 10:46", "PITCH_TRANSITION"],
  ["same pitch, 47 minutes apart", "A 1 09:00", "A 1 09:47", "B 1 10:55", "PITCH_TRANSITION"],
  ["same pitch, semifinal and final too close (47 minutes after the semifinal)", "A 1 09:00", "B 1 09:00", "A 1 09:47", "PITCH_TRANSITION"],
  ["same pitch across windows: the transition is not respected (43 minutes)", "A 2 09:22", "A 2 10:05", "B 2 11:14", "PITCH_TRANSITION"],
  ["same pitch across windows: exactly 48 minutes", "A 2 09:22", "A 2 10:10", "B 2 11:20", "OK"],
  ["three matches at once with capacity 2", "A 1 09:00", "B 1 09:00", "C 1 09:00", "CAPACITY_EXCEEDED"],
  ["three overlapping matches on three pitches with capacity 2", "A 1 09:00", "B 1 09:20", "C 1 09:30", "CAPACITY_EXCEEDED"],
  ["final 67 minutes after the semifinals' kickoff", "A 1 09:00", "B 1 09:00", "A 1 10:07", "FINAL_REST"],
  ["final 68 minutes after the semifinals' kickoff", "A 1 09:00", "B 1 09:00", "A 1 10:08", "OK"],
  ["final rest is measured from the LATER semifinal (67 minutes after it)", "A 1 09:00", "B 1 09:30", "A 1 10:37", "FINAL_REST"],
  ["final rest is measured from the later semifinal (68 minutes after it)", "A 1 09:00", "B 1 09:30", "A 1 10:38", "OK"],
  ["final rest is measured from the later semifinal when it is semifinal 1", "B 1 09:30", "A 1 09:00", "A 1 10:37", "FINAL_REST"],
  ["final before the semifinals", "B 1 10:00", "C 1 10:00", "A 1 09:00", "FINAL_REST"],
  ["the first violation wins: semifinal 1's pitch before semifinal 2's window", "X 1 09:00", "B 1 08:00", "A 1 10:08", "PITCH_NOT_IN_PLAN"],
  ["a per-placement violation is reported before any cross-placement one", "A 1 08:00", "A 1 08:00", "A 1 08:00", "OUTSIDE_WINDOW"],
  ["same-pitch overlap is reported before the final rest", "A 1 09:00", "A 1 09:00", "B 1 09:10", "PITCH_OVERLAP"],
  ["same-pitch rules are reported before capacity", "A 1 09:00", "A 1 09:38", "B 1 09:10", "PITCH_TRANSITION"],
];

/** The boundaries of every format, for the formats no public path can create (service-side facts only). [format, rule, edge, the minute tried, expected] */
const FORMAT_GRID: Array<[format: string, rule: string, edge: string, start: string, expected: string]> = [
  ["SOCCER_5V5", "final", "one minute short", "10:07", "FINAL_REST"], ["SOCCER_5V5", "final", "exact", "10:08", "OK"],
  ["SOCCER_5V5", "same-pitch", "one minute short", "09:47", "PITCH_TRANSITION"], ["SOCCER_5V5", "same-pitch", "exact", "09:48", "OK"],
  ["SOCCER_6V6", "final", "one minute short", "10:11", "FINAL_REST"], ["SOCCER_6V6", "final", "exact", "10:12", "OK"],
  ["SOCCER_6V6", "same-pitch", "one minute short", "09:51", "PITCH_TRANSITION"], ["SOCCER_6V6", "same-pitch", "exact", "09:52", "OK"],
  ["SOCCER_7V7", "final", "one minute short", "10:34", "FINAL_REST"], ["SOCCER_7V7", "final", "exact", "10:35", "OK"],
  ["SOCCER_7V7", "same-pitch", "one minute short", "09:59", "PITCH_TRANSITION"], ["SOCCER_7V7", "same-pitch", "exact", "10:00", "OK"],
  ["SOCCER_8V8", "final", "one minute short", "10:34", "FINAL_REST"], ["SOCCER_8V8", "final", "exact", "10:35", "OK"],
  ["SOCCER_8V8", "same-pitch", "one minute short", "09:59", "PITCH_TRANSITION"], ["SOCCER_8V8", "same-pitch", "exact", "10:00", "OK"],
];

/** America/New_York, decided on the pinned instant 2026-10-30T14:00Z. Fall back 2026-11-01 (01:00-01:59 happens twice); spring forward 2027-03-14 (02:00-02:59 does not exist). */
const DST_MATRIX: Array<[name: string, sf1: string, sf2: string, final: string, expected: string]> = [
  ["fall back: 01:30 happens twice", "A 1 01:30", "B 1 00:30", "A 1 03:00", "LOCAL_TIME_AMBIGUOUS"],
  ["fall back: 01:00 happens twice", "A 1 00:30", "B 1 01:00", "A 1 03:00", "LOCAL_TIME_AMBIGUOUS"],
  ["fall back: 01:59 happens twice", "A 1 00:30", "B 1 00:30", "A 1 01:59", "LOCAL_TIME_AMBIGUOUS"],
  ["fall back: 00:59 is unambiguous", "A 1 00:59", "B 1 00:59", "A 1 02:07", "OK"],
  ["fall back: 02:00 is unambiguous (after the repeat)", "A 1 00:30", "B 1 00:30", "A 1 02:00", "OK"],
  ["spring forward: 02:30 does not exist", "A 1 02:30", "B 1 00:30", "A 1 03:38", "LOCAL_TIME_NONEXISTENT"],
  ["spring forward: 02:00 does not exist", "A 1 00:30", "B 1 02:00", "A 1 03:38", "LOCAL_TIME_NONEXISTENT"],
  ["spring forward: 02:59 does not exist", "A 1 00:30", "B 1 00:30", "A 1 02:59", "LOCAL_TIME_NONEXISTENT"],
  ["spring forward: 01:59 exists (the last minute before the gap)", "A 1 01:59", "B 1 01:59", "B 1 04:07", "OK"],
  ["spring forward: 03:00 exists (the first minute after the gap)", "A 1 03:00", "B 1 03:00", "A 1 04:08", "OK"],
  ["spring forward: the same pitch 40 real minutes apart (100 local minutes)", "A 1 01:30", "A 1 03:10", "B 1 04:18", "PITCH_TRANSITION"],
  ["spring forward: the same pitch 48 real minutes apart (108 local)", "A 1 01:30", "A 1 03:18", "B 1 06:00", "OK"],
  ["spring forward: final 60 real minutes after the semifinals (120 local)", "A 1 01:30", "B 1 01:30", "A 1 03:30", "FINAL_REST"],
  ["spring forward: final exactly 68 real minutes after the semifinals", "A 1 01:30", "B 1 01:30", "A 1 03:38", "OK"],
  ["spring forward: the day's window really lasts four hours (00:00 EST to 05:00 EDT)", "A 1 00:30", "B 1 00:30", "A 1 04:22", "OK"],
  ["spring forward: ... and a match cannot end after 05:00 EDT", "A 1 00:30", "B 1 00:30", "A 1 04:23", "OUTSIDE_WINDOW"],
];
/** The UTC instants the oracle computed for the accepted DST rows: [starts], [ends], [windows]. */
const DST_ACCEPTED: Record<string, { starts: string[]; ends: string[]; windows: Array<[string, string]> }> = {
  "fall back: 00:59 is unambiguous": {
    starts: ["2026-11-01T04:59:00.000Z", "2026-11-01T04:59:00.000Z", "2026-11-01T07:07:00.000Z"], ends: ["2026-11-01T05:37:00.000Z", "2026-11-01T05:37:00.000Z", "2026-11-01T07:45:00.000Z"],
    windows: [["2026-11-01T04:00:00.000Z", "2026-11-01T10:00:00.000Z"], ["2026-11-01T04:00:00.000Z", "2026-11-01T10:00:00.000Z"], ["2026-11-01T04:00:00.000Z", "2026-11-01T10:00:00.000Z"]],
  },
  "spring forward: 01:59 exists (the last minute before the gap)": {
    starts: ["2027-03-14T06:59:00.000Z", "2027-03-14T06:59:00.000Z", "2027-03-14T08:07:00.000Z"], ends: ["2027-03-14T07:37:00.000Z", "2027-03-14T07:37:00.000Z", "2027-03-14T08:45:00.000Z"],
    windows: [["2027-03-14T05:00:00.000Z", "2027-03-14T09:00:00.000Z"], ["2027-03-14T05:00:00.000Z", "2027-03-14T09:00:00.000Z"], ["2027-03-14T05:00:00.000Z", "2027-03-14T09:00:00.000Z"]],
  },
  "spring forward: the same pitch 48 real minutes apart (108 local)": {
    starts: ["2027-03-14T06:30:00.000Z", "2027-03-14T07:18:00.000Z", "2027-03-14T10:00:00.000Z"], ends: ["2027-03-14T07:08:00.000Z", "2027-03-14T07:56:00.000Z", "2027-03-14T10:38:00.000Z"],
    windows: [["2027-03-14T05:00:00.000Z", "2027-03-14T09:00:00.000Z"], ["2027-03-14T05:00:00.000Z", "2027-03-14T09:00:00.000Z"], ["2027-03-14T10:00:00.000Z", "2027-03-14T16:00:00.000Z"]],
  },
  "spring forward: final exactly 68 real minutes after the semifinals": {
    starts: ["2027-03-14T06:30:00.000Z", "2027-03-14T06:30:00.000Z", "2027-03-14T07:38:00.000Z"], ends: ["2027-03-14T07:08:00.000Z", "2027-03-14T07:08:00.000Z", "2027-03-14T08:16:00.000Z"],
    windows: [["2027-03-14T05:00:00.000Z", "2027-03-14T09:00:00.000Z"], ["2027-03-14T05:00:00.000Z", "2027-03-14T09:00:00.000Z"], ["2027-03-14T05:00:00.000Z", "2027-03-14T09:00:00.000Z"]],
  },
  "spring forward: the day's window really lasts four hours (00:00 EST to 05:00 EDT)": {
    starts: ["2027-03-14T05:30:00.000Z", "2027-03-14T05:30:00.000Z", "2027-03-14T08:22:00.000Z"], ends: ["2027-03-14T06:08:00.000Z", "2027-03-14T06:08:00.000Z", "2027-03-14T09:00:00.000Z"],
    windows: [["2027-03-14T05:00:00.000Z", "2027-03-14T09:00:00.000Z"], ["2027-03-14T05:00:00.000Z", "2027-03-14T09:00:00.000Z"], ["2027-03-14T05:00:00.000Z", "2027-03-14T09:00:00.000Z"]],
  },
};

/** The digests of the known-answer proposal, computed by Python hashlib from the canonical texts in scheduleProposal.ts's header. */
const KAT = {
  request1: "dad0af24474920fbe58f4f15a19980a8edb34b0bfe305583af09a8419bc07f58",
  request2: "51ecfffebf6c7164d7cf7952be2331f428fd42fa8c5bb1dfc03d59ebf4313025",
  proposal1: "c6b64b3101982308672760eb6aa091853b408d671a96efd32bc16cc6bcbca8bf",
  proposal2: "8a4c1b8926151de94ef00905b9c478b6b6fe66186ef21fe79e6dda2ede2b1184",
};

/** The stored evidence of the known-answer proposal, assembled from literals (not from the code under test). */
function katRecord(over: Record<string, unknown> = {}): ScheduleProposalRecord {
  const base = {
    sequenceNumber: 1, createdAt: "2026-11-05T17:00:00.123456Z", status: "CURRENT", planningRevisionCurrent: true, drawDigestMatches: true,
    proposalDigest: KAT.proposal1, requestDigest: KAT.request1, supersedesDigest: null,
    planningRevisionId: REV_ID, planningRevisionNumber: 1, drawId: DRAW_ID, drawDigest: DRAW_DIGEST,
    formatKey: "SOCCER_5V5", timeZone: "America/Costa_Rica", simultaneousMatchCapacity: 2,
    timing: { occupancyMinutes: 38, pitchTransitionMinutes: 10, minimumTeamRestMinutes: 30 },
    placements: [
      { fixtureRole: "SEMIFINAL_1", planningPitchId: PITCH.A, pitchLabel: "A", planDate: "2026-11-14", startTime: "09:00", startUtc: "2026-11-14T15:00:00.000Z", endUtc: "2026-11-14T15:38:00.000Z",
        windowStartUtc: "2026-11-14T15:00:00.000Z", windowEndUtc: "2026-11-14T18:00:00.000Z", teamA: TEAMS[0], teamB: TEAMS[1] },
      { fixtureRole: "SEMIFINAL_2", planningPitchId: PITCH.B, pitchLabel: "B", planDate: "2026-11-14", startTime: "09:00", startUtc: "2026-11-14T15:00:00.000Z", endUtc: "2026-11-14T15:38:00.000Z",
        windowStartUtc: "2026-11-14T15:00:00.000Z", windowEndUtc: "2026-11-14T18:00:00.000Z", teamA: TEAMS[2], teamB: TEAMS[3] },
      { fixtureRole: "FINAL", planningPitchId: PITCH.A, pitchLabel: "A", planDate: "2026-11-14", startTime: "10:08", startUtc: "2026-11-14T16:08:00.000Z", endUtc: "2026-11-14T16:46:00.000Z",
        windowStartUtc: "2026-11-14T15:00:00.000Z", windowEndUtc: "2026-11-14T18:00:00.000Z", teamA: null, teamB: null },
    ],
  };
  return { ...base, ...over } as unknown as ScheduleProposalRecord;
}

/** The same evidence as the database returns it. */
function rawEvidence(over: Record<string, unknown> = {}): Record<string, any> {
  const r = katRecord() as any;
  const team = (t: { teamId: string; teamName: string } | null) => (t ? { team_id: t.teamId, team_name: t.teamName } : null);
  return {
    sequence_number: r.sequenceNumber, created_at: r.createdAt, status: r.status, planning_revision_current: r.planningRevisionCurrent, draw_digest_matches: r.drawDigestMatches,
    proposal_digest: r.proposalDigest, request_digest: r.requestDigest, supersedes_digest: r.supersedesDigest,
    planning_revision_id: r.planningRevisionId, planning_revision_number: r.planningRevisionNumber, draw_id: r.drawId, draw_digest: r.drawDigest,
    format_key: r.formatKey, time_zone: r.timeZone, simultaneous_match_capacity: r.simultaneousMatchCapacity,
    timing: { occupancy_minutes: 38, pitch_transition_minutes: 10, minimum_team_rest_minutes: 30 },
    placements: r.placements.map((p: any) => ({
      fixture_role: p.fixtureRole, planning_pitch_id: p.planningPitchId, pitch_label: p.pitchLabel, plan_date: p.planDate, start_time: p.startTime,
      start_utc: p.startUtc, end_utc: p.endUtc, window_start_utc: p.windowStartUtc, window_end_utc: p.windowEndUtc, team_a: team(p.teamA), team_b: team(p.teamB),
    })),
    ...over,
  };
}
function ctxRecord(): ScheduleContextRecord {
  return {
    planningRevisionNumber: 1, formatKey: "SOCCER_5V5", timeZone: "America/Costa_Rica", simultaneousMatchCapacity: 2,
    timing: { occupancyMinutes: 38, pitchTransitionMinutes: 10, minimumTeamRestMinutes: 30 },
    pitches: [{ planningPitchId: PITCH.A, label: "A", usable: true, supportedFormats: ["SOCCER_5V5"] }, { planningPitchId: PITCH.B, label: "B", usable: true, supportedFormats: ["SOCCER_5V5"] }],
    dates: [{ date: "2026-11-14", windows: [{ start: "09:00", end: "12:00" }] }],
  } as ScheduleContextRecord;
}
function rawContext(): Record<string, any> {
  return {
    planning_revision_number: 1, format_key: "SOCCER_5V5", time_zone: "America/Costa_Rica", simultaneous_match_capacity: 2,
    timing: { occupancy_minutes: 38, pitch_transition_minutes: 10, minimum_team_rest_minutes: 30 },
    pitches: [{ planning_pitch_id: PITCH.A, label: "A", usable: true, supported_formats: ["SOCCER_5V5"] }, { planning_pitch_id: PITCH.B, label: "B", usable: true, supported_formats: ["SOCCER_5V5"] }],
    dates: [{ date: "2026-11-14", windows: [{ start: "09:00", end: "12:00" }] }],
  };
}
const HISTORY = [{ sequenceNumber: 1, createdAt: "2026-11-05T17:00:00.123456Z", status: "CURRENT", proposalDigest: KAT.proposal1 }];
const rawHistory = () => [{ sequence_number: 1, created_at: "2026-11-05T17:00:00.123456Z", status: "CURRENT", proposal_digest: KAT.proposal1 }];

const BODY = () => ({
  intentId: INTENT,
  placements: [
    { fixtureRole: "SEMIFINAL_1", planningPitchId: PITCH.A, planDate: "2026-11-14", startTime: "09:00" },
    { fixtureRole: "SEMIFINAL_2", planningPitchId: PITCH.B, planDate: "2026-11-14", startTime: "09:00" },
    { fixtureRole: "FINAL", planningPitchId: PITCH.A, planDate: "2026-11-14", startTime: "10:08" },
  ],
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// [8][9] The accepted timing, derived from the format registry
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("[8][9] the timing is derived from the format registry: reserved occupancy, same-pitch kickoff separation, the final's rest", () => {
  it.each(Object.keys(GATE_TIMING))("%s gives exactly the accepted occupancy, transition, rest, same-pitch gap and final lead", async (format) => {
    const { scheduleTimingFor } = await loadSp();
    const want = GATE_TIMING[format];
    expect(scheduleTimingFor(format as never)).toEqual({
      occupancyMinutes: want.occupancy, pitchTransitionMinutes: want.transition, minimumTeamRestMinutes: want.rest,
      samePitchKickoffGapMinutes: want.gap, finalAfterSemifinalKickoffMinutes: want.finalLead,
    });
  });

  it("occupancy is first half + halftime + second half + the FULL shootout reserve, read from the registry and never typed in", async () => {
    const { scheduleTimingFor } = await loadSp();
    const { SOCCER_FORMAT_RULES } = await import("../lib/gaming/competitions/formats");
    for (const key of SOCCER_FORMAT_KEYS) {
      const t = SOCCER_FORMAT_RULES[key].timing;
      expect(scheduleTimingFor(key).occupancyMinutes).toBe(2 * t.minutesPerHalf + t.halftimeMinutes + t.knockoutShootoutReserveMinutes);
    }
    expect(read("lib/gaming/competitions/scheduleProposal.ts")).not.toMatch(/\b(38|42)\b/);
  });

  it("an unknown or malformed format has no timing (never a default, never an echo)", async () => {
    const { scheduleTimingFor } = await loadSp();
    for (const bad of ["SOCCER_9V9", "soccer_5v5", "", null, undefined, 5, {}]) expect(() => scheduleTimingFor(bad as never), String(bad)).toThrow();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// [1][2] The request: exactly three placements; nothing the server derives
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("[1] the request is exactly an intent and three placements, one per role, each exactly a pitch, a plan date and a venue-local start time", () => {
  it("accepts the three roles in any order and returns them in role order with the pitch identifier in lowercase", async () => {
    const { parseScheduleProposalRequest } = await loadSp();
    const parsed = parseScheduleProposalRequest(BODY());
    expect(parsed).toEqual({
      intentId: INTENT,
      placements: [
        { fixtureRole: "SEMIFINAL_1", planningPitchId: PITCH.A, planDate: "2026-11-14", startTime: "09:00" },
        { fixtureRole: "SEMIFINAL_2", planningPitchId: PITCH.B, planDate: "2026-11-14", startTime: "09:00" },
        { fixtureRole: "FINAL", planningPitchId: PITCH.A, planDate: "2026-11-14", startTime: "10:08" },
      ],
    });
    const scrambled = BODY();
    scrambled.placements = [scrambled.placements[2], scrambled.placements[0], scrambled.placements[1]];
    scrambled.placements[0] = { ...scrambled.placements[0], planningPitchId: PITCH.A.toUpperCase() };
    expect(parseScheduleProposalRequest(scrambled)).toEqual(parsed);
    expect(Object.keys(parsed).sort()).toEqual(["intentId", "placements"]);
    for (const p of parsed.placements) expect(Object.keys(p).sort()).toEqual(["fixtureRole", "planDate", "planningPitchId", "startTime"]);
  });

  const codesOf = async (body: unknown) => {
    const { parseScheduleProposalRequest, ScheduleProposalValidationError } = await loadSp();
    try { parseScheduleProposalRequest(body); return null; } catch (err) {
      expect(err).toBeInstanceOf(ScheduleProposalValidationError);
      return (err as { violations: Array<{ field: string; code: string; message: string }> }).violations;
    }
  };

  it("refuses anything but exactly three placements", async () => {
    for (const placements of [[], [BODY().placements[0]], BODY().placements.slice(0, 2), [...BODY().placements, BODY().placements[0]], "x", null, {}, undefined]) {
      const violations = await codesOf({ intentId: INTENT, placements });
      expect(violations!.map((v) => v.code), JSON.stringify(placements)).toContain("PLACEMENTS_INVALID");
    }
  });

  it("refuses a missing, a duplicate and an unknown role — and says each", async () => {
    const b = BODY();
    expect((await codesOf({ intentId: INTENT, placements: [b.placements[0], b.placements[0], b.placements[2]] }))!.map((v) => v.code).sort()).toEqual(["ROLE_DUPLICATE", "ROLE_MISSING"]);
    for (const role of ["QUARTERFINAL_1", "semifinal_1", "Final", "", "SEMIFINAL_3", "THIRD_PLACE", 1, null]) {
      const placements = [{ ...b.placements[0], fixtureRole: role }, b.placements[1], b.placements[2]];
      expect((await codesOf({ intentId: INTENT, placements }))!.map((v) => v.code), String(role)).toContain("ROLE_INVALID");
    }
  });

  it("refuses a placement that is not an object, a pitch that is not a UUID, a date that is not a real calendar day, a time that is not exactly HH:MM", async () => {
    const b = BODY();
    const withFirst = (patch: Record<string, unknown>) => ({ intentId: INTENT, placements: [{ ...b.placements[0], ...patch }, b.placements[1], b.placements[2]] });
    expect((await codesOf({ intentId: INTENT, placements: ["x", b.placements[1], b.placements[2]] }))!.map((v) => v.code)).toContain("PLACEMENT_NOT_OBJECT");
    for (const pitch of ["", "A", "not-a-uuid", PITCH.A.replace(/-/g, ""), ` ${PITCH.A}`, 5, null, undefined]) {
      expect((await codesOf(withFirst({ planningPitchId: pitch })))!.map((v) => v.code), String(pitch)).toContain("PITCH_INVALID");
    }
    for (const date of ["2026-02-30", "2026-13-01", "2026-11-14T09:00", "14/11/2026", "2026-1-14", " 2026-11-14", "2026-11-14 ", "", 20261114, null, undefined]) {
      expect((await codesOf(withFirst({ planDate: date })))!.map((v) => v.code), String(date)).toContain("DATE_INVALID");
    }
    for (const time of ["9:00", "09:00:00", "24:00", "09:60", "09:00Z", "0900", "09.00", " 09:00", "9am", "", 900, null, undefined]) {
      expect((await codesOf(withFirst({ startTime: time })))!.map((v) => v.code), String(time)).toContain("TIME_INVALID");
    }
  });

  it("reports every problem at once, with the path of each", async () => {
    const violations = await codesOf({ intentId: "x", placements: [{ fixtureRole: "FINAL", planningPitchId: "no", planDate: "no", startTime: "no" }, { fixtureRole: "FINAL" }, 7] });
    const codes = violations!.map((v) => v.code);
    for (const code of ["INTENT_INVALID", "PITCH_INVALID", "DATE_INVALID", "TIME_INVALID", "ROLE_DUPLICATE", "PLACEMENT_NOT_OBJECT"]) expect(codes, code).toContain(code);
    for (const v of violations!) {
      expect(typeof v.field).toBe("string");
      expect(v.message.length).toBeGreaterThan(5);
    }
    expect(violations!.some((v) => v.field.startsWith("placements[0]"))).toBe(true);
  });

  it("refuses an intent that is not a UUID and a body that is not an object", async () => {
    const b = BODY();
    for (const intentId of ["", "x", null, undefined, 5, `${INTENT} `]) expect((await codesOf({ ...b, intentId }))!.map((v) => v.code), String(intentId)).toContain("INTENT_INVALID");
    for (const body of [null, undefined, "x", 5, [], [BODY()]]) expect((await codesOf(body))!.map((v) => v.code), JSON.stringify(body)).toEqual(["REQUEST_NOT_OBJECT"]);
  });
});

/** Everything a client might send to name teams, an order, a time the server derives, a duration, a capacity, a venue fact, a format, a timing value, an actor or a fixture. */
const FORBIDDEN = [
  "teams", "team", "teamIds", "teamA", "teamB", "pairing", "pairings", "semifinals", "bracket", "drawOrder", "drawPosition", "order", "seed",
  "startUtc", "endUtc", "utc", "startsAt", "endsAt", "scheduledAt", "timeZone", "timezone", "tz", "utcOffset", "offset", "duration", "durationMinutes", "occupancy", "occupancyMinutes",
  "transition", "rest", "restMinutes", "capacity", "simultaneousMatchCapacity", "venue", "venueName", "venueTimeZone", "windows", "window",
  "format", "formatKey", "activityKey", "timing", "halves", "minutesPerHalf", "halftimeMinutes", "pitchTransitionMinutes", "minimumTeamRestMinutes", "knockoutShootoutReserveMinutes",
  "organizer", "organizerId", "organizerGamingMemberId", "gamingMemberId", "memberId", "actor", "actorId", "authority", "capability",
  "fixtureId", "competitionFixtureId", "fixtures", "competitionId", "planningRevisionId", "planningRevision", "drawId", "drawDigest", "sequence", "sequenceNumber", "supersedes", "digest", "state", "now",
];

describe("[2] a client can never send what the server derives: every such field is refused by name, at the request and at each placement", () => {
  it.each(FORBIDDEN)("`%s` is refused as FORBIDDEN_FIELD at the top level and at a placement", async (field) => {
    const { parseScheduleProposalRequest, ScheduleProposalValidationError } = await loadSp();
    const top = { ...BODY(), [field]: "x" };
    let violations: Array<{ field: string; code: string }> = [];
    try { parseScheduleProposalRequest(top); } catch (err) { expect(err).toBeInstanceOf(ScheduleProposalValidationError); violations = (err as any).violations; }
    expect(violations).toEqual([expect.objectContaining({ field, code: "FORBIDDEN_FIELD" })]);
    const nested = BODY();
    (nested.placements[1] as Record<string, unknown>)[field] = "x";
    violations = [];
    try { parseScheduleProposalRequest(nested); } catch (err) { violations = (err as any).violations; }
    expect(violations).toEqual([expect.objectContaining({ field: `placements[1].${field}`, code: "FORBIDDEN_FIELD" })]);
  });

  it("an unnamed extra field is refused as UNKNOWN_FIELD, wherever it is — including a prototype-looking key", async () => {
    const { parseScheduleProposalRequest } = await loadSp();
    for (const field of ["colour", "note", "__proto__", "constructor", "x"]) {
      const body = JSON.parse(JSON.stringify(BODY()));
      Object.defineProperty(body, field, { value: 1, enumerable: true, configurable: true, writable: true });
      expect(() => parseScheduleProposalRequest(body), field).toThrow();
    }
    const { ScheduleProposalValidationError } = await loadSp();
    try { parseScheduleProposalRequest({ ...BODY(), colour: "red" }); } catch (err) {
      expect((err as InstanceType<typeof ScheduleProposalValidationError>).violations).toEqual([expect.objectContaining({ field: "colour", code: "UNKNOWN_FIELD" })]);
    }
  });

  it("the parser reads no clock, no environment and no repository: the same body gives the same result", async () => {
    const { parseScheduleProposalRequest } = await loadSp();
    expect(parseScheduleProposalRequest(BODY())).toEqual(parseScheduleProposalRequest(BODY()));
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// [8]-[13] The evaluator: one complete schedule, judged against the oracle
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("[8][9][10][11][12] the complete schedule is judged by the rules, and agrees with the independent oracle on every row", () => {
  it.each(CR_MATRIX)("%s", async (_name, a, b, c, expected, nowIso) => {
    const { evaluateScheduleProposal } = await loadSp();
    const result = evaluateScheduleProposal(crFacts() as never, placementsOf(a, b, c) as never, Date.parse(nowIso ?? "2026-11-10T12:00:00.000Z"));
    if (expected !== "OK") {
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.violations[0].code).toBe(expected);
      for (const v of result.violations) {
        expect(v.field).toMatch(/^(placements\[\d\]\.[A-Za-z]+|schedule)$/);
        expect(v.message.length).toBeGreaterThan(5);
      }
      return;
    }
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const specs = [a, b, c].map((s) => s.split(" "));
    expect(result.placements).toHaveLength(3);
    result.placements.forEach((p, i) => {
      const [label, day, time] = specs[i];
      const start = crInstant(day, time);
      expect(p.fixtureRole).toBe(["SEMIFINAL_1", "SEMIFINAL_2", "FINAL"][i]);
      expect(p.planningPitchId).toBe(PITCH[label]);
      expect(p.pitchLabel).toBe(label);
      expect(p.planDate).toBe(DAY[day]);
      expect(p.startTime).toBe(time); // never silently altered
      expect(p.startUtc).toBe(start);
      expect(p.endUtc).toBe(new Date(Date.parse(start) + 38 * 60_000).toISOString());
      expect([p.windowStartUtc, p.windowEndUtc]).toEqual(crWindow(day, time));
    });
  });

  it("[8] the reserved occupancy is 38 minutes for five-a-side and the same-pitch kickoff separation 48: 47 is refused, 48 accepted — and the placements are never moved to make them fit", async () => {
    const { evaluateScheduleProposal } = await loadSp();
    const refused = evaluateScheduleProposal(crFacts() as never, placementsOf("A 1 09:00", "A 1 09:47", "B 1 10:55") as never, NOW);
    expect(refused.ok).toBe(false);
    const accepted = evaluateScheduleProposal(crFacts() as never, placementsOf("A 1 09:00", "A 1 09:48", "B 1 10:56") as never, NOW);
    expect(accepted.ok && accepted.placements.map((p) => p.startTime)).toEqual(["09:00", "09:48", "10:56"]);
  });

  it("[9] the final is judged against BOTH possible finalists: 67 minutes refused, 68 accepted, whichever semifinal is later", async () => {
    const { evaluateScheduleProposal } = await loadSp();
    for (const [sf1, sf2] of [["A 1 09:00", "B 1 09:30"], ["B 1 09:30", "A 1 09:00"]]) {
      const short = evaluateScheduleProposal(crFacts() as never, placementsOf(sf1, sf2, "A 1 10:37") as never, NOW);
      const exact = evaluateScheduleProposal(crFacts() as never, placementsOf(sf1, sf2, "A 1 10:38") as never, NOW);
      expect(short.ok === false && short.violations[0].code).toBe("FINAL_REST");
      expect(exact.ok).toBe(true);
    }
  });

  it("[10] simultaneous semifinals are accepted only when the pitches AND the capacity permit", async () => {
    const { evaluateScheduleProposal } = await loadSp();
    const two = evaluateScheduleProposal(crFacts() as never, placementsOf("A 1 09:00", "B 1 09:00", "A 1 10:08") as never, NOW);
    expect(two.ok).toBe(true);
    const onePitch = evaluateScheduleProposal(crFacts() as never, placementsOf("A 1 09:00", "A 1 09:00", "B 1 10:08") as never, NOW);
    expect(onePitch.ok === false && onePitch.violations[0].code).toBe("PITCH_OVERLAP");
    const capacityOne = evaluateScheduleProposal(crFacts({ simultaneousMatchCapacity: 1 }) as never, placementsOf("A 1 09:00", "B 1 09:00", "A 1 10:08") as never, NOW);
    expect(capacityOne.ok === false && capacityOne.violations[0].code).toBe("CAPACITY_EXCEEDED");
    // Back to back (the first ends exactly as the second begins) is not simultaneous: capacity 1 is enough.
    const backToBack = evaluateScheduleProposal(crFacts({ simultaneousMatchCapacity: 1 }) as never, placementsOf("A 1 09:00", "B 1 09:38", "A 1 11:00") as never, NOW);
    expect(backToBack.ok).toBe(true);
  });

  it("[11] the strict-future rule: a start at the decision instant is refused; one millisecond later is accepted; no decision instant (null) skips only that rule", async () => {
    const { evaluateScheduleProposal } = await loadSp();
    const start = Date.parse(crInstant("1", "09:00"));
    const p = placementsOf("A 1 09:00", "B 1 09:00", "A 1 10:08");
    expect(evaluateScheduleProposal(crFacts() as never, p as never, start).ok).toBe(false);
    expect(evaluateScheduleProposal(crFacts() as never, p as never, start - 1).ok).toBe(true);
    expect(evaluateScheduleProposal(crFacts() as never, p as never, start + 1).ok).toBe(false);
    expect(evaluateScheduleProposal(crFacts() as never, p as never, null).ok).toBe(true);
    const bad = placementsOf("A 1 08:00", "B 1 09:00", "A 1 10:08");
    expect(evaluateScheduleProposal(crFacts() as never, bad as never, null).ok).toBe(false);
  });

  it("lists every per-placement violation in role order, each with the path of the field that causes it", async () => {
    const { evaluateScheduleProposal } = await loadSp();
    const result = evaluateScheduleProposal(crFacts() as never, placementsOf("X 1 09:00", "E 1 09:00", "A 3 10:08") as never, NOW);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.violations.map((v) => [v.field, v.code])).toEqual([
      ["placements[0].planningPitchId", "PITCH_NOT_IN_PLAN"], ["placements[1].planningPitchId", "PITCH_NOT_USABLE"], ["placements[2].planDate", "DATE_NOT_IN_PLAN"],
    ]);
  });

  it("never mutates its inputs, is pure, and refuses a time zone it cannot resolve instead of guessing", async () => {
    const { evaluateScheduleProposal } = await loadSp();
    const facts = Object.freeze(JSON.parse(JSON.stringify(crFacts())));
    const p = Object.freeze(placementsOf("A 1 09:00", "B 1 09:00", "A 1 10:08").map((x) => Object.freeze(x)));
    const first = evaluateScheduleProposal(facts as never, p as never, NOW);
    const second = evaluateScheduleProposal(facts as never, p as never, NOW);
    expect(second).toEqual(first);
    expect(() => evaluateScheduleProposal(crFacts({ timeZone: "Not/AZone" }) as never, p as never, NOW)).toThrow();
  });

  it("a window whose endpoint the clocks skip or repeat is never matched (it cannot be used, and nothing throws)", async () => {
    const { evaluateScheduleProposal } = await loadSp();
    const facts = nyFacts("2027-03-14", [{ start: "02:30", end: "05:00" }]);
    const result = evaluateScheduleProposal(facts as never, placementsOf("A 1 03:00", "B 1 03:00", "A 1 04:08").map((p) => ({ ...p, planDate: "2027-03-14" })) as never, NOW_NY);
    expect(result.ok === false && result.violations[0].code).toBe("OUTSIDE_WINDOW");
  });
});

describe("[8][9] the same four rules for every format in the registry — service-side facts only (no path can create a competition in any but five-a-side)", () => {
  it.each(FORMAT_GRID)("%s %s, %s (%s) -> %s", async (format, rule, _edge, minute, expected) => {
    const { evaluateScheduleProposal } = await loadSp();
    const placements = rule === "final"
      ? placementsOf("A 1 09:00", "B 1 09:00", `A 1 ${minute}`)
      : placementsOf("A 1 09:00", `A 1 ${minute}`, "B 2 10:10");
    const result = evaluateScheduleProposal(crFacts({ formatKey: format }) as never, placements as never, NOW);
    if (expected === "OK") expect(result.ok, JSON.stringify(result)).toBe(true);
    else expect(result.ok === false && result.violations[0].code).toBe(expected);
  });

  it("the grid's boundaries are exactly the gate's: same-pitch 48 / 52 / 60 / 60 and final after the later semifinal 68 / 72 / 95 / 95 (kickoff to kickoff)", () => {
    for (const [format, t] of Object.entries(GATE_TIMING)) {
      expect(t.occupancy + t.transition, format).toBe(t.gap);
      expect(t.occupancy + t.rest, format).toBe(t.finalLead);
      const exact = FORMAT_GRID.find((r) => r[0] === format && r[1] === "final" && r[2] === "exact")![3];
      const [h, m] = exact.split(":").map(Number);
      expect(h * 60 + m - 9 * 60, format).toBe(t.finalLead);
      const gapRow = FORMAT_GRID.find((r) => r[0] === format && r[1] === "same-pitch" && r[2] === "exact")![3];
      const [gh, gm] = gapRow.split(":").map(Number);
      expect(gh * 60 + gm - 9 * 60, format).toBe(t.gap);
    }
  });
});

describe("[13] the venue's own clock: a local time that is skipped or repeated is refused, and every duration is real elapsed time", () => {
  const rows = DST_MATRIX.map((r) => r);
  it.each(rows)("%s", async (name, a, b, c, expected) => {
    const { evaluateScheduleProposal } = await loadSp();
    const facts = name.startsWith("fall back") ? NY_FALL() : NY_SPRING();
    const result = evaluateScheduleProposal(facts as never, placementsOf(a, b, c).map((p) => ({ ...p, planDate: facts.dates[0].date })) as never, NOW_NY);
    if (expected !== "OK") {
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.violations[0].code).toBe(expected);
      return;
    }
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const want = DST_ACCEPTED[name];
    if (want) {
      expect(result.placements.map((p) => p.startUtc)).toEqual(want.starts);
      expect(result.placements.map((p) => p.endUtc)).toEqual(want.ends);
      expect(result.placements.map((p) => [p.windowStartUtc, p.windowEndUtc])).toEqual(want.windows);
    }
  });

  it("the nonexistent and the ambiguous time are refused with their own stable codes and never shifted to another time", async () => {
    const { evaluateScheduleProposal } = await loadSp();
    const spring = evaluateScheduleProposal(NY_SPRING() as never, placementsOf("A 1 02:30", "B 1 00:30", "A 1 03:38").map((p) => ({ ...p, planDate: "2027-03-14" })) as never, NOW_NY);
    const fall = evaluateScheduleProposal(NY_FALL() as never, placementsOf("A 1 01:30", "B 1 00:30", "A 1 03:00").map((p) => ({ ...p, planDate: "2026-11-01" })) as never, NOW_NY);
    expect(spring.ok === false && spring.violations.map((v) => v.code)).toEqual(["LOCAL_TIME_NONEXISTENT"]);
    expect(fall.ok === false && fall.violations.map((v) => v.code)).toEqual(["LOCAL_TIME_AMBIGUOUS"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// [7][14] The digests
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("[7][14] the request digest and the proposal digest: one canonical text each, pinned by independent known answers", () => {
  const katRequest = () => ({ competitionId: CID, intentId: INTENT, placements: BODY().placements });

  it("the request digest of the known-answer request equals what Python's hashlib computed from the canonical text", async () => {
    const { computeScheduleRequestDigest } = await loadSp();
    expect(computeScheduleRequestDigest(katRequest().competitionId, katRequest().intentId, katRequest().placements as never)).toBe(KAT.request1);
    expect(computeScheduleRequestDigest(CID, INTENT_2, BODY().placements as never)).toBe(KAT.request2);
  });

  it("is independent of the order the placements arrive in and of the case of an identifier, and depends on every fact of the request", async () => {
    const { computeScheduleRequestDigest } = await loadSp();
    const p = BODY().placements;
    expect(computeScheduleRequestDigest(CID, INTENT, [p[2], p[0], p[1]] as never)).toBe(KAT.request1);
    expect(computeScheduleRequestDigest(CID.toUpperCase(), INTENT.toUpperCase(), p.map((x) => ({ ...x, planningPitchId: x.planningPitchId.toUpperCase() })) as never)).toBe(KAT.request1);
    const variants: Array<[string, (x: any[]) => any[]]> = [
      ["pitch", (x) => x.map((y, i) => (i === 0 ? { ...y, planningPitchId: PITCH.C } : y))], ["date", (x) => x.map((y, i) => (i === 1 ? { ...y, planDate: "2026-11-15" } : y))],
      ["time", (x) => x.map((y, i) => (i === 2 ? { ...y, startTime: "10:09" } : y))],
    ];
    for (const [label, change] of variants) expect(computeScheduleRequestDigest(CID, INTENT, change(p) as never), label).not.toBe(KAT.request1);
    expect(computeScheduleRequestDigest(CID, INTENT_2, p as never)).not.toBe(KAT.request1);
    expect(computeScheduleRequestDigest("99999999-9999-4999-8999-999999999999", INTENT, p as never)).not.toBe(KAT.request1);
  });

  it("the proposal digest of the known-answer proposals (sequence 1, then 2 superseding it) equals what Python's hashlib computed", async () => {
    const { computeScheduleProposalDigest } = await loadSp();
    expect(computeScheduleProposalDigest(CID, katRecord())).toBe(KAT.proposal1);
    const second = katRecord({ sequenceNumber: 2, supersedesDigest: KAT.proposal1, requestDigest: KAT.request2 });
    expect(computeScheduleProposalDigest(CID, second)).toBe(KAT.proposal2);
  });

  it("the proposal digest depends on every fact it binds: sequence, predecessor, request, plan revision, draw and its digest, format, zone, capacity, timing and every placement field", async () => {
    const { computeScheduleProposalDigest } = await loadSp();
    const base = computeScheduleProposalDigest(CID, katRecord());
    const placement = (i: number, patch: Record<string, unknown>) => (katRecord() as any).placements.map((p: any, k: number) => (k === i ? { ...p, ...patch } : p));
    const changes: Array<[string, Record<string, unknown>]> = [
      ["sequence", { sequenceNumber: 2 }], ["predecessor", { supersedesDigest: sha("other") }], ["request", { requestDigest: sha("another request") }],
      ["revision", { planningRevisionId: "66666666-6666-4666-8666-666666666666" }], ["draw", { drawId: "77777777-7777-4777-8777-777777777777" }], ["draw digest", { drawDigest: sha("other draw") }],
      ["format", { formatKey: "SOCCER_6V6" }], ["zone", { timeZone: "America/New_York" }], ["capacity", { simultaneousMatchCapacity: 1 }],
      ["occupancy", { timing: { occupancyMinutes: 39, pitchTransitionMinutes: 10, minimumTeamRestMinutes: 30 } }],
      ["transition", { timing: { occupancyMinutes: 38, pitchTransitionMinutes: 11, minimumTeamRestMinutes: 30 } }],
      ["rest", { timing: { occupancyMinutes: 38, pitchTransitionMinutes: 10, minimumTeamRestMinutes: 31 } }],
      ["pitch", { placements: placement(0, { planningPitchId: PITCH.C }) }], ["date", { placements: placement(1, { planDate: "2026-11-15" }) }],
      ["local time", { placements: placement(2, { startTime: "10:09" }) }], ["start", { placements: placement(0, { startUtc: "2026-11-14T15:01:00.000Z" }) }],
      ["end", { placements: placement(1, { endUtc: "2026-11-14T15:39:00.000Z" }) }], ["window start", { placements: placement(2, { windowStartUtc: "2026-11-14T14:59:00.000Z" }) }],
      ["window end", { placements: placement(0, { windowEndUtc: "2026-11-14T18:01:00.000Z" }) }],
    ];
    for (const [label, patch] of changes) expect(computeScheduleProposalDigest(CID, katRecord(patch)), label).not.toBe(base);
    expect(computeScheduleProposalDigest("99999999-9999-4999-8999-999999999999", katRecord())).not.toBe(base);
  });

  it("the digest does not bind what the browser is shown on top of it: status, the live booleans, the creation instant, pitch labels and team names", async () => {
    const { computeScheduleProposalDigest } = await loadSp();
    const base = computeScheduleProposalDigest(CID, katRecord());
    expect(computeScheduleProposalDigest(CID, katRecord({ status: "SUPERSEDED", planningRevisionCurrent: false, createdAt: "2030-01-01T00:00:00.000000Z" }))).toBe(base);
    expect(computeScheduleProposalDigest(CID, katRecord({ placements: (katRecord() as any).placements.map((p: any) => ({ ...p, pitchLabel: "Zed", teamA: null })) }))).toBe(base);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The evidence reproduces itself
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("a stored proposal reproduces itself from its own evidence, and evidence that does not is never handed on", () => {
  /** A mutated record with the digest recomputed, so that the rule under test — not the digest — is what refuses it. */
  const redigested = async (patch: Record<string, unknown>) => {
    const { computeScheduleProposalDigest } = await loadSp();
    const record = katRecord(patch) as any;
    return { ...record, proposalDigest: computeScheduleProposalDigest(CID, record) } as ScheduleProposalRecord;
  };
  const placement = (i: number, patch: Record<string, unknown>) => (katRecord() as any).placements.map((p: any, k: number) => (k === i ? { ...p, ...patch } : p));

  it("the known-answer proposal verifies", async () => {
    const { verifyScheduleProposal } = await loadSp();
    expect(verifyScheduleProposal(CID, katRecord())).toEqual({ ok: true });
    expect(verifyScheduleProposal(CID, katRecord({ sequenceNumber: 2, supersedesDigest: KAT.proposal1, requestDigest: KAT.request2, proposalDigest: KAT.proposal2 }))).toEqual({ ok: true });
  });

  it.each([
    ["a digest that does not match", { proposalDigest: sha("nope") }],
    ["a malformed digest", { proposalDigest: "ABC" }],
    ["a malformed request digest", { requestDigest: "12" }],
    ["a different competition's digest", { proposalDigest: KAT.proposal2 }],
    ["sequence 0", { sequenceNumber: 0 }],
    ["a fractional sequence", { sequenceNumber: 1.5 }],
    ["a first proposal that supersedes one", { supersedesDigest: KAT.proposal2 }],
    ["a later proposal that supersedes nothing", { sequenceNumber: 2 }],
    ["an unknown status", { status: "PUBLISHED" }],
    ["status CURRENT while the plan revision is no longer current", { planningRevisionCurrent: false }],
    ["status CURRENT while the draw digest does not match", { drawDigestMatches: false }],
    ["status STALE while both facts hold", { status: "STALE" }],
    ["a malformed creation instant", { createdAt: "2026-11-05T17:00:00Z" }],
    ["an unknown format", { formatKey: "SOCCER_9V9" }],
    ["a time zone that is not an IANA name", { timeZone: "UTC+2" }],
    ["a capacity of 0", { simultaneousMatchCapacity: 0 }],
    ["a capacity above 16", { simultaneousMatchCapacity: 17 }],
    ["timing that is not the registry's for the format", { timing: { occupancyMinutes: 40, pitchTransitionMinutes: 10, minimumTeamRestMinutes: 30 } }],
    ["a malformed plan revision identifier", { planningRevisionId: "x" }],
    ["a malformed draw identifier", { drawId: "x" }],
    ["a malformed draw digest", { drawDigest: "x" }],
    ["two placements", { placements: (katRecord() as any).placements.slice(0, 2) }],
    ["four placements", { placements: [...(katRecord() as any).placements, (katRecord() as any).placements[0]] }],
    ["placements out of role order", { placements: [(katRecord() as any).placements[1], (katRecord() as any).placements[0], (katRecord() as any).placements[2]] }],
    ["a repeated role", { placements: placement(1, { fixtureRole: "SEMIFINAL_1" }) }],
    ["a local time that is not HH:MM", { placements: placement(0, { startTime: "9:00" }) }],
    ["a date that is not a real day", { placements: placement(0, { planDate: "2026-02-30" }) }],
    ["a start that does not follow from the local time and the zone", { placements: placement(0, { startUtc: "2026-11-14T16:00:00.000Z", endUtc: "2026-11-14T16:38:00.000Z" }) }],
    ["an end that is not the start plus the reserved occupancy", { placements: placement(1, { endUtc: "2026-11-14T15:37:00.000Z" }) }],
    ["an occupancy that leaves its window", { placements: placement(1, { windowEndUtc: "2026-11-14T15:30:00.000Z" }) }],
    ["a window that opens after the start", { placements: placement(0, { windowStartUtc: "2026-11-14T15:01:00.000Z" }) }],
    ["a semifinal without teams", { placements: placement(0, { teamA: null }) }],
    ["a final that already names teams", { placements: placement(2, { teamA: TEAMS[0] }) }],
    ["a team that plays twice", { placements: placement(1, { teamA: TEAMS[0] }) }],
    ["a pitch label that is empty", { placements: placement(0, { pitchLabel: "" }) }],
  ] as Array<[string, Record<string, unknown>]>)("refuses %s", async (_label, patch) => {
    const { verifyScheduleProposal } = await loadSp();
    const result = verifyScheduleProposal(CID, katRecord(patch));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason.length).toBeGreaterThan(5);
  });

  it("refuses a schedule that breaks a rule even when its digest was recomputed to agree with it (the rules are checked on the evidence itself)", async () => {
    const { verifyScheduleProposal } = await loadSp();
    // Semifinal 2 on semifinal 1's pitch, simultaneous: the digest below is correct for it, the schedule is not.
    const overlap = await redigested({ placements: placement(1, { planningPitchId: PITCH.A, pitchLabel: "A" }) });
    expect(verifyScheduleProposal(CID, overlap).ok).toBe(false);
    // The final 67 minutes after the later kickoff.
    const early = await redigested({ placements: placement(2, { startTime: "10:07", startUtc: "2026-11-14T16:07:00.000Z", endUtc: "2026-11-14T16:45:00.000Z" }) });
    expect(verifyScheduleProposal(CID, early).ok).toBe(false);
    // Three matches at once with capacity 2.
    const three = await redigested({ placements: placement(2, { planningPitchId: PITCH.C, startTime: "09:00", startUtc: "2026-11-14T15:00:00.000Z", endUtc: "2026-11-14T15:38:00.000Z" }) });
    expect(verifyScheduleProposal(CID, three).ok).toBe(false);
    // A transition shorter than the format's, on the same pitch.
    const transition = await redigested({ placements: placement(1, { planningPitchId: PITCH.A, startTime: "09:38", startUtc: "2026-11-14T15:38:00.000Z", endUtc: "2026-11-14T16:16:00.000Z" }) });
    expect(verifyScheduleProposal(CID, transition).ok).toBe(false);
    expect(verifyScheduleProposal(CID, await redigested({})).ok).toBe(true);
  });

  it("verifies a New York proposal across the clock change: the start follows from the local time and the offset in force that day", async () => {
    const { verifyScheduleProposal, computeScheduleProposalDigest } = await loadSp();
    const ny = katRecord({
      timeZone: "America/New_York",
      placements: [
        { ...(katRecord() as any).placements[0], planDate: "2027-03-14", startTime: "01:30", startUtc: "2027-03-14T06:30:00.000Z", endUtc: "2027-03-14T07:08:00.000Z", windowStartUtc: "2027-03-14T05:00:00.000Z", windowEndUtc: "2027-03-14T09:00:00.000Z" },
        { ...(katRecord() as any).placements[1], planDate: "2027-03-14", startTime: "01:30", startUtc: "2027-03-14T06:30:00.000Z", endUtc: "2027-03-14T07:08:00.000Z", windowStartUtc: "2027-03-14T05:00:00.000Z", windowEndUtc: "2027-03-14T09:00:00.000Z" },
        { ...(katRecord() as any).placements[2], planDate: "2027-03-14", startTime: "03:38", startUtc: "2027-03-14T07:38:00.000Z", endUtc: "2027-03-14T08:16:00.000Z", windowStartUtc: "2027-03-14T05:00:00.000Z", windowEndUtc: "2027-03-14T09:00:00.000Z" },
      ],
    }) as any;
    const sealed = { ...ny, proposalDigest: computeScheduleProposalDigest(CID, ny) };
    expect(verifyScheduleProposal(CID, sealed)).toEqual({ ok: true });
    // The same wall-clock times, but a start computed as if the clocks had not changed (UTC-05:00 all day): refused.
    const naive = { ...sealed, placements: sealed.placements.map((p: any, i: number) => (i === 2 ? { ...p, startUtc: "2027-03-14T08:38:00.000Z", endUtc: "2027-03-14T09:16:00.000Z" } : p)) };
    expect(verifyScheduleProposal(CID, { ...naive, proposalDigest: computeScheduleProposalDigest(CID, naive) }).ok).toBe(false);
  });

  it("never throws: evidence that cannot be evaluated does not verify", async () => {
    const { verifyScheduleProposal } = await loadSp();
    for (const bad of [null, undefined, 5, "x", [], {}, { placements: null }, { placements: [null, null, null] }]) expect(verifyScheduleProposal(CID, bad as never).ok, String(bad)).toBe(false);
  });

  it("assertScheduleProposalVerifies throws for evidence that does not verify and returns for evidence that does", async () => {
    const { assertScheduleProposalVerifies } = await loadSp();
    expect(() => assertScheduleProposalVerifies(CID, katRecord())).not.toThrow();
    expect(() => assertScheduleProposalVerifies(CID, katRecord({ proposalDigest: sha("nope") }))).toThrow(/could not be verified/);
  });
});

describe("what the database returns is judged strictly, field by field", () => {
  it("maps the database evidence into the application's shape, exactly", async () => {
    const { scheduleProposalRecordFromDatabase } = await loadSp();
    expect(scheduleProposalRecordFromDatabase(rawEvidence())).toEqual(katRecord());
  });

  it.each([
    ["not an object", null], ["an array", []], ["a missing digest", rawEvidence({ proposal_digest: undefined })], ["a text sequence", rawEvidence({ sequence_number: "1" })],
    ["a missing timing", rawEvidence({ timing: undefined })], ["a timing field that is not a number", rawEvidence({ timing: { occupancy_minutes: "38", pitch_transition_minutes: 10, minimum_team_rest_minutes: 30 } })],
    ["two placements", rawEvidence({ placements: rawEvidence().placements.slice(0, 2) })], ["placements that are not an array", rawEvidence({ placements: {} })],
    ["a placement that is not an object", rawEvidence({ placements: [1, 2, 3] })], ["a boolean that is text", rawEvidence({ planning_revision_current: "true" })],
    ["an empty pitch label", rawEvidence({ placements: rawEvidence().placements.map((p: any, i: number) => (i === 0 ? { ...p, pitch_label: "" } : p)) })],
    ["a team that is not an object", rawEvidence({ placements: rawEvidence().placements.map((p: any, i: number) => (i === 0 ? { ...p, team_a: "x" } : p)) })],
  ])("refuses %s", async (_label, raw) => {
    const { scheduleProposalRecordFromDatabase } = await loadSp();
    expect(() => scheduleProposalRecordFromDatabase(raw)).toThrow();
  });

  it("maps the context and the read, and refuses a context that is not exactly its shape", async () => {
    const { scheduleContextFromDatabase, scheduleReadFromDatabase } = await loadSp();
    expect(scheduleContextFromDatabase(rawContext())).toEqual(ctxRecord());
    expect(scheduleReadFromDatabase({ context: rawContext(), proposal: rawEvidence(), history: rawHistory() })).toEqual({ context: ctxRecord(), proposal: katRecord(), history: HISTORY });
    expect(scheduleReadFromDatabase({ context: null, proposal: null, history: [] })).toEqual({ context: null, proposal: null, history: [] });
    for (const bad of [null, [], { context: rawContext() }, { context: rawContext(), proposal: undefined, history: [] }, { context: 5, proposal: null, history: [] }, { context: null, proposal: null, history: {} },
      { context: null, proposal: null, history: [{ sequence_number: 1 }] }, { context: { ...rawContext(), pitches: "x" }, proposal: null, history: [] }]) {
      expect(() => scheduleReadFromDatabase(bad), JSON.stringify(bad)).toThrow();
    }
  });
});

describe("what a browser may see: every field is copied by name, so nothing the server holds beyond this list can reach a response", () => {
  it("the proposal as a browser sees it: no identifier of a plan revision, a draw, a request, an intent or a member", async () => {
    const { publicScheduleProposal } = await loadSp();
    const view = publicScheduleProposal(katRecord());
    expect(Object.keys(view).sort()).toEqual([
      "createdAt", "drawDigest", "drawDigestMatches", "formatKey", "placements", "planningRevisionCurrent", "planningRevisionNumber", "proposalDigest", "sequenceNumber",
      "simultaneousMatchCapacity", "status", "supersedesDigest", "timeZone", "timing",
    ]);
    expect(view.placements).toHaveLength(3);
    for (const p of view.placements) {
      expect(Object.keys(p).sort()).toEqual(["endUtc", "fixtureRole", "pitchLabel", "planDate", "planningPitchId", "startTime", "startUtc", "teamA", "teamB", "windowEndUtc", "windowStartUtc"]);
    }
    expect(view.placements[0].teamA).toEqual({ teamId: TEAMS[0].teamId, teamName: TEAMS[0].teamName });
    expect(view.placements[2].teamA).toBeNull();
    const text = JSON.stringify(view);
    expect(text).not.toContain(REV_ID);
    expect(text).not.toContain(DRAW_ID);
    expect(text).not.toContain(KAT.request1);
    expect(text).not.toMatch(/organizer|intent|actor|capabilit|member/i);
    expect(view.timing).toEqual({ occupancyMinutes: 38, pitchTransitionMinutes: 10, minimumTeamRestMinutes: 30 });
  });

  it("copies by name even when the record carries more", async () => {
    const { publicScheduleProposal, publicScheduleContext, publicScheduleRead } = await loadSp();
    const rich = { ...(katRecord() as any), organizerGamingMemberId: ORGANIZER, intentId: INTENT, secret: "s3cret" };
    rich.placements = rich.placements.map((p: any) => ({ ...p, competitionFixtureId: "fx", secret: "s3cret" }));
    expect(JSON.stringify(publicScheduleProposal(rich))).not.toMatch(/s3cret|fx|00000000-0000-4000-8000-0000000000a1|33333333/);
    const context = { ...(ctxRecord() as any), secret: "s3cret", pitches: ctxRecord().pitches.map((p) => ({ ...p, secret: "s3cret" })) };
    expect(JSON.stringify(publicScheduleContext(context))).not.toContain("s3cret");
    expect(Object.keys(publicScheduleContext(ctxRecord())).sort()).toEqual(["dates", "formatKey", "pitches", "planningRevisionNumber", "simultaneousMatchCapacity", "timeZone", "timing"]);
    expect(publicScheduleRead({ context: ctxRecord(), proposal: katRecord(), history: HISTORY as never })).toEqual({
      context: publicScheduleContext(ctxRecord()), proposal: publicScheduleProposal(katRecord()), history: HISTORY,
    });
    expect(publicScheduleRead({ context: null, proposal: null, history: [] })).toEqual({ context: null, proposal: null, history: [] });
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Typed refusals
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("the typed refusals: stable codes, the application's own words, and a uniform answer for everyone who has no part in this", () => {
  it("maps the database's codes to typed refusals and its validation refusals to the one validation error — by the code alone, never the words", async () => {
    const { scheduleProposalErrorFromDatabase, ScheduleProposalError, ScheduleProposalValidationError } = await loadSp();
    for (const [databaseCode, code] of [
      ["SCHEDULE_PROPOSAL_WRONG_STATE", "WRONG_STATE"], ["SCHEDULE_PROPOSAL_FREEZE_REQUIRED", "FREEZE_REQUIRED"], ["SCHEDULE_PROPOSAL_FREEZE_INCONSISTENT", "FREEZE_INCONSISTENT"],
      ["SCHEDULE_PROPOSAL_DRAW_REQUIRED", "DRAW_REQUIRED"], ["SCHEDULE_PROPOSAL_PLAN_REQUIRED", "PLAN_REQUIRED"], ["SCHEDULE_PROPOSAL_AMENDMENT_PENDING", "AMENDMENT_PENDING"],
      ["SCHEDULE_PROPOSAL_INTENT_MISMATCH", "INTENT_MISMATCH"],
    ] as const) {
      const err = scheduleProposalErrorFromDatabase(`${databaseCode}: raw database words`);
      expect(err, code).toBeInstanceOf(ScheduleProposalError);
      expect((err as { code: string }).code).toBe(code);
      expect((err as Error).message).not.toMatch(/raw database words|SCHEDULE_PROPOSAL/);
    }
    const invalid = scheduleProposalErrorFromDatabase("SCHEDULE_PROPOSAL_INVALID: PITCH_OVERLAP: two matches would use pitch A at once");
    expect(invalid).toBeInstanceOf(ScheduleProposalValidationError);
    expect((invalid as InstanceType<typeof ScheduleProposalValidationError>).violations).toEqual([
      { field: "schedule", code: "PITCH_OVERLAP", message: expect.stringMatching(/^Two matches would use pitch A at once\.?$/) },
    ]);
    expect(scheduleProposalErrorFromDatabase("something else")).toBeNull();
    expect(scheduleProposalErrorFromDatabase("")).toBeNull();
    expect(scheduleProposalErrorFromDatabase(undefined as never)).toBeNull();
  });

  it("how a failure is answered: 400 with every problem, the one uniform 404, 409 with the code, and nothing else is this module's to describe", async () => {
    const { scheduleProposalFailure, SCHEDULE_PROPOSAL_NOT_FOUND_MESSAGE, ScheduleProposalError, ScheduleProposalNotAvailableError, ScheduleProposalValidationError } = await loadSp();
    const violation = { field: "schedule", code: "PITCH_OVERLAP", message: "Two matches would use one pitch at once." };
    expect(scheduleProposalFailure(new ScheduleProposalValidationError([violation]))).toEqual({ status: 400, body: { error: "The schedule proposal is not valid.", problems: [violation] } });
    for (const err of [new ScheduleProposalNotAvailableError(), new CompetitionNotFoundError(), new CompetitionAccessDeniedError("x"), new HostAccessRevokedError()]) {
      expect(scheduleProposalFailure(err)).toEqual({ status: 404, body: { error: SCHEDULE_PROPOSAL_NOT_FOUND_MESSAGE } });
    }
    const refusal = scheduleProposalFailure(new ScheduleProposalError("DRAW_REQUIRED"));
    expect(refusal).toEqual({ status: 409, body: { error: expect.stringMatching(/draw/i), code: "DRAW_REQUIRED" } });
    expect(scheduleProposalFailure(new Error("boom"))).toBeNull();
    expect(scheduleProposalFailure("x")).toBeNull();
    expect(SCHEDULE_PROPOSAL_NOT_FOUND_MESSAGE).not.toMatch(/organizer|captain|draw|freeze|state|ready|plan/i);
  });

  it("every refusal code has its own bounded sentence", async () => {
    const { ScheduleProposalError } = await loadSp();
    const codes = ["WRONG_STATE", "FREEZE_REQUIRED", "FREEZE_INCONSISTENT", "DRAW_REQUIRED", "PLAN_REQUIRED", "AMENDMENT_PENDING", "INTENT_MISMATCH"] as const;
    const messages = codes.map((code) => new ScheduleProposalError(code).message);
    expect(new Set(messages).size).toBe(codes.length);
    for (const m of messages) expect(m).not.toMatch(/SCHEDULE_PROPOSAL|COMPETITION_|supabase|postgres/i);
  });

  it("the repository's translation table knows every code, ahead of the shared codes", () => {
    for (const code of ["WRONG_STATE", "FREEZE_REQUIRED", "FREEZE_INCONSISTENT", "DRAW_REQUIRED", "PLAN_REQUIRED", "AMENDMENT_PENDING", "INTENT_MISMATCH", "INVALID: PITCH_OVERLAP: x"]) {
      const err = translateError({ code: "P0001", message: `SCHEDULE_PROPOSAL_${code}` });
      expect(err.constructor.name, code).toMatch(/^ScheduleProposal(Validation)?Error$/);
    }
    expect(translateError({ code: "P0001", message: "COMPETITION_NOT_FOUND: x" })).toBeInstanceOf(CompetitionNotFoundError);
    expect(translateError({ code: "XX000", message: "SCHEDULE_PROPOSAL_WRONG_STATE: x" }).constructor.name).toBe("Error");
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The commands
// ---------------------------------------------------------------------------------------------------------------------------------------------

function competition(over: Record<string, unknown> = {}) {
  return { competitionId: CID, organizerGamingMemberId: ORGANIZER, state: "READY_TO_PUBLISH", hostBound: false, hostAccessRevoked: false, ...over };
}
function makeRepo() {
  return {
    getCompetitionById: vi.fn(async (id: string) => (id === CID ? competition() : null)),
    createScheduleProposal: vi.fn(async () => ({ proposal: katRecord(), alreadyProposed: false })),
    getScheduleProposals: vi.fn(async () => ({ context: ctxRecord(), proposal: katRecord(), history: HISTORY }) as unknown as ScheduleProposalRead | null),
  };
}

describe("[3][4] the command: only the active organizer reaches the database; everyone else is told nothing", () => {
  it("the organizer's request reaches the store with the verified caller, the identifier and exactly the three placements, and the result comes back unchanged", async () => {
    const { createScheduleProposal, parseScheduleProposalRequest } = await loadSp();
    const repo = makeRepo();
    const request = parseScheduleProposalRequest(BODY());
    const result = await createScheduleProposal(repo as never, CID, ORGANIZER, request);
    expect(result).toEqual({ proposal: katRecord(), alreadyProposed: false });
    expect(repo.createScheduleProposal).toHaveBeenCalledTimes(1);
    expect(repo.createScheduleProposal).toHaveBeenCalledWith(CID, ORGANIZER, INTENT, request.placements);
  });

  it.each([["a frozen captain", CAPTAIN], ["a scorekeeper", SCOREKEEPER], ["an ordinary registrant", REGISTRANT], ["a member holding only OPERATIONAL authority", OPERATIONAL], ["a stranger", STRANGER]])(
    "%s is told the one uniform not-available, and the database is never asked", async (_label, caller) => {
      const { createScheduleProposal, parseScheduleProposalRequest, ScheduleProposalNotAvailableError } = await loadSp();
      const repo = makeRepo();
      await expect(createScheduleProposal(repo as never, CID, caller, parseScheduleProposalRequest(BODY()))).rejects.toBeInstanceOf(ScheduleProposalNotAvailableError);
      expect(repo.createScheduleProposal).not.toHaveBeenCalled();
    });

  it("[4] a revoked organizer, an unknown competition and a missing caller are told the same, and the database is never asked", async () => {
    const { createScheduleProposal, parseScheduleProposalRequest, ScheduleProposalNotAvailableError } = await loadSp();
    const request = parseScheduleProposalRequest(BODY());
    const revoked = makeRepo();
    revoked.getCompetitionById.mockResolvedValue(competition({ hostBound: true, hostAccessRevoked: true }));
    await expect(createScheduleProposal(revoked as never, CID, ORGANIZER, request)).rejects.toBeInstanceOf(ScheduleProposalNotAvailableError);
    const unknown = makeRepo();
    await expect(createScheduleProposal(unknown as never, "99999999-9999-4999-8999-999999999999", ORGANIZER, request)).rejects.toBeInstanceOf(ScheduleProposalNotAvailableError);
    const missing = makeRepo();
    await expect(createScheduleProposal(missing as never, CID, undefined as unknown as string, request)).rejects.toBeInstanceOf(ScheduleProposalNotAvailableError);
    for (const repo of [revoked, unknown, missing]) expect(repo.createScheduleProposal).not.toHaveBeenCalled();
  });

  it("whatever the store refuses with is passed on untouched (the decision is the database's, never repeated or softened here)", async () => {
    const { createScheduleProposal, parseScheduleProposalRequest, scheduleProposalErrorFromDatabase } = await loadSp();
    const repo = makeRepo();
    const refusal = scheduleProposalErrorFromDatabase("SCHEDULE_PROPOSAL_AMENDMENT_PENDING: x")!;
    repo.createScheduleProposal.mockRejectedValue(refusal);
    await expect(createScheduleProposal(repo as never, CID, ORGANIZER, parseScheduleProposalRequest(BODY()))).rejects.toBe(refusal);
  });

  it("a read is passed straight to the store with the verified caller: the database alone says who may see a proposal", async () => {
    const { readScheduleProposals } = await loadSp();
    const repo = makeRepo();
    expect(await readScheduleProposals(repo as never, CID, ORGANIZER)).toEqual({ context: ctxRecord(), proposal: katRecord(), history: HISTORY });
    expect(repo.getScheduleProposals).toHaveBeenCalledWith(CID, ORGANIZER);
    repo.getScheduleProposals.mockResolvedValue(null);
    expect(await readScheduleProposals(repo as never, CID, CAPTAIN)).toBeNull();
    expect(repo.getScheduleProposals).toHaveBeenLastCalledWith(CID, CAPTAIN);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("the route: 503 first, 401, one uniform not-available, the exact body, 201 / 200 / 400 / 409, bounded errors, no caching", () => {
  const ctx = (competitionId: string): Ctx => ({ params: { competitionId } });
  const post = (body: unknown) => new Request("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const get = () => new Request("http://localhost/x", { method: "GET" });
  const ORIGINAL = process.env.COMPETITIONS_SCHEMA_READY;
  let repo: ReturnType<typeof makeRepo>;

  beforeEach(() => {
    process.env.COMPETITIONS_SCHEMA_READY = "true";
    vi.clearAllMocks();
    repo = makeRepo();
    vi.mocked(httpAuth.getSupabaseCredentials).mockReturnValue({ url: "http://fake", serviceKey: "fake" });
    vi.mocked(httpAuth.buildCompetitionsRepo).mockReturnValue(repo as never);
    vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ gamingMemberId: ORGANIZER });
    return () => { if (ORIGINAL === undefined) delete process.env.COMPETITIONS_SCHEMA_READY; else process.env.COMPETITIONS_SCHEMA_READY = ORIGINAL; };
  });

  it("exports exactly GET and POST", async () => {
    const mod = await loadRoute();
    expect(["GET", "POST", "PUT", "PATCH", "DELETE"].filter((m) => typeof mod[m] === "function")).toEqual(["GET", "POST"]);
  });

  it("with the schema not ready, both methods answer 503 first — before authenticating, parsing a body or building a repository — and uncached", async () => {
    const mod = await loadRoute();
    for (const value of [undefined, "", "false", "TRUE", "1"]) {
      if (value === undefined) delete process.env.COMPETITIONS_SCHEMA_READY; else process.env.COMPETITIONS_SCHEMA_READY = value;
      for (const [method, handler] of [["GET", mod.GET], ["POST", mod.POST]] as const) {
        const res = await handler!(new Request("http://localhost/x", { method, body: method === "POST" ? "not json {{{" : undefined }), ctx("test-id"));
        expect(res.status, `${method} ${String(value)}`).toBe(503);
        expect(res.headers.get("cache-control")).toMatch(/no-store/);
      }
    }
    expect(httpAuth.requireGamingMember).not.toHaveBeenCalled();
    expect(httpAuth.buildCompetitionsRepo).not.toHaveBeenCalled();
  });

  it("answers 401 first, from the credential alone, with no repository built and nothing cached", async () => {
    const mod = await loadRoute();
    vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ errorResponse: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }) } as never);
    for (const [handler, request] of [[mod.GET!, get()], [mod.POST!, post(BODY())]] as const) {
      const res = await handler(request, ctx(CID));
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toMatch(/no-store/);
    }
    expect(httpAuth.buildCompetitionsRepo).not.toHaveBeenCalled();
    expect(repo.createScheduleProposal).not.toHaveBeenCalled();
  });

  it("[2] POST rejects every field a client could use to steer the schedule with a 400 listing the problem — and neither the competition nor the store is touched", async () => {
    const mod = await loadRoute();
    for (const field of ["teams", "pairing", "drawOrder", "startUtc", "timeZone", "durationMinutes", "capacity", "venue", "format", "timing", "organizerGamingMemberId", "actor", "fixtureId", "competitionId", "planningRevisionId"]) {
      const res = await mod.POST!(post({ ...BODY(), [field]: "x" }), ctx(CID));
      expect(res.status, field).toBe(400);
      expect(res.headers.get("cache-control")).toMatch(/no-store/);
      expect((await res.json()).problems).toEqual([expect.objectContaining({ field, code: "FORBIDDEN_FIELD" })]);
      const nested = BODY();
      (nested.placements[0] as Record<string, unknown>)[field] = "x";
      const inPlacement = await mod.POST!(post(nested), ctx(CID));
      expect(inPlacement.status, `placements[0].${field}`).toBe(400);
      expect((await inPlacement.json()).problems).toEqual([expect.objectContaining({ field: `placements[0].${field}`, code: "FORBIDDEN_FIELD" })]);
    }
    expect((await mod.POST!(post({}), ctx(CID))).status).toBe(400);
    expect((await mod.POST!(post({ intentId: INTENT, placements: BODY().placements.slice(0, 2) }), ctx(CID))).status).toBe(400);
    expect((await mod.POST!(post("not json {{{"), ctx(CID))).status).toBe(400);
    expect(repo.getCompetitionById).not.toHaveBeenCalled();
    expect(repo.createScheduleProposal).not.toHaveBeenCalled();
  });

  it("POST: a malformed competition id is the uniform 404 before the body is even read", async () => {
    const mod = await loadRoute();
    expect((await mod.POST!(post("not json {{{"), ctx("not-a-uuid"))).status).toBe(404);
  });

  it("POST: 201 for a new proposal, 200 for an authorized same-intent replay — each with exactly the bounded proposal and the flag", async () => {
    const mod = await loadRoute();
    const { publicScheduleProposal } = await loadSp();
    const created = await mod.POST!(post(BODY()), ctx(CID));
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toMatch(/no-store/);
    expect(await created.json()).toEqual({ proposal: publicScheduleProposal(katRecord()), alreadyProposed: false });
    expect(repo.createScheduleProposal).toHaveBeenCalledWith(CID, ORGANIZER, INTENT, parseOf(BODY()));
    repo.createScheduleProposal.mockResolvedValue({ proposal: katRecord(), alreadyProposed: true });
    const replay = await mod.POST!(post(BODY()), ctx(CID));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ proposal: publicScheduleProposal(katRecord()), alreadyProposed: true });
  });

  it("POST: the actor is always the verified caller, never anything in the request", async () => {
    const mod = await loadRoute();
    await mod.POST!(post(BODY()), ctx(CID));
    expect(repo.createScheduleProposal.mock.calls[0].slice(0, 3)).toEqual([CID, ORGANIZER, INTENT]);
  });

  it.each([["a frozen captain", CAPTAIN], ["a scorekeeper", SCOREKEEPER], ["an ordinary registrant", REGISTRANT], ["a member holding only OPERATIONAL authority", OPERATIONAL], ["a stranger", STRANGER]])(
    "POST by %s: the one uniform 404, the same words as for an unknown competition, and nothing is attempted", async (_label, caller) => {
      const mod = await loadRoute();
      vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ gamingMemberId: caller });
      const refused = await mod.POST!(post(BODY()), ctx(CID));
      const unknown = await mod.POST!(post(BODY()), ctx("99999999-9999-4999-8999-999999999999"));
      expect([refused.status, unknown.status]).toEqual([404, 404]);
      expect(await refused.text()).toBe(await unknown.text());
      expect(refused.headers.get("cache-control")).toMatch(/no-store/);
      expect(repo.createScheduleProposal).not.toHaveBeenCalled();
    });

  it("POST by a revoked organizer — in the application's view or by a race at the database — is the same 404 and says nothing of revocation", async () => {
    const mod = await loadRoute();
    const { SCHEDULE_PROPOSAL_NOT_FOUND_MESSAGE } = await loadSp();
    repo.getCompetitionById.mockResolvedValue(competition({ hostBound: true, hostAccessRevoked: true }));
    const viaApplication = await mod.POST!(post(BODY()), ctx(CID));
    expect(viaApplication.status).toBe(404);
    expect(await viaApplication.json()).toEqual({ error: SCHEDULE_PROPOSAL_NOT_FOUND_MESSAGE });
    repo.getCompetitionById.mockResolvedValue(competition());
    for (const err of [new HostAccessRevokedError(), new CompetitionAccessDeniedError("x"), new CompetitionNotFoundError()]) {
      repo.createScheduleProposal.mockRejectedValue(err);
      const res = await mod.POST!(post(BODY()), ctx(CID));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: SCHEDULE_PROPOSAL_NOT_FOUND_MESSAGE });
    }
  });

  it("[5][6] POST: every lifecycle refusal is a 409 with its stable code and the application's bounded words", async () => {
    const mod = await loadRoute();
    const { scheduleProposalErrorFromDatabase } = await loadSp();
    for (const [databaseCode, code] of [["WRONG_STATE", "WRONG_STATE"], ["FREEZE_REQUIRED", "FREEZE_REQUIRED"], ["FREEZE_INCONSISTENT", "FREEZE_INCONSISTENT"], ["DRAW_REQUIRED", "DRAW_REQUIRED"],
      ["PLAN_REQUIRED", "PLAN_REQUIRED"], ["AMENDMENT_PENDING", "AMENDMENT_PENDING"], ["INTENT_MISMATCH", "INTENT_MISMATCH"]]) {
      repo.createScheduleProposal.mockRejectedValue(scheduleProposalErrorFromDatabase(`SCHEDULE_PROPOSAL_${databaseCode}: raw database words`));
      const res = await mod.POST!(post(BODY()), ctx(CID));
      expect(res.status, code).toBe(409);
      expect(res.headers.get("cache-control")).toMatch(/no-store/);
      const body = await res.json();
      expect(body.code).toBe(code);
      expect(JSON.stringify(body)).not.toMatch(/raw database words|SCHEDULE_PROPOSAL/);
    }
  });

  it("POST: a schedule the database refuses is a 400 with the stable code of the rule it breaks", async () => {
    const mod = await loadRoute();
    const { scheduleProposalErrorFromDatabase } = await loadSp();
    repo.createScheduleProposal.mockRejectedValue(scheduleProposalErrorFromDatabase("SCHEDULE_PROPOSAL_INVALID: FINAL_REST: the final starts too soon after the semifinals"));
    const res = await mod.POST!(post(BODY()), ctx(CID));
    expect(res.status).toBe(400);
    expect((await res.json()).problems).toEqual([{ field: "schedule", code: "FINAL_REST", message: expect.stringMatching(/final starts too soon/i) }]);
  });

  it("POST: an unexpected failure is a generic 500 that leaks nothing of the error", async () => {
    const mod = await loadRoute();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    repo.createScheduleProposal.mockRejectedValue(new Error("secret internals 12345"));
    const res = await mod.POST!(post(BODY()), ctx(CID));
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    expect(JSON.stringify(await res.json())).not.toMatch(/secret|12345/);
  });

  it("GET: the organizer is answered with the bounded context, latest proposal and history; uncached", async () => {
    const mod = await loadRoute();
    const { publicScheduleRead } = await loadSp();
    const res = await mod.GET!(get(), ctx(CID));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    expect(await res.json()).toEqual(publicScheduleRead({ context: ctxRecord(), proposal: katRecord(), history: HISTORY as never }));
    expect(repo.getScheduleProposals).toHaveBeenLastCalledWith(CID, ORGANIZER);
    repo.getScheduleProposals.mockResolvedValue({ context: null, proposal: null, history: [] });
    expect(await (await mod.GET!(get(), ctx(CID))).json()).toEqual({ context: null, proposal: null, history: [] });
  });

  it("GET: unrelated callers, unknown competitions and malformed ids all get the one identical 404, which names nothing", async () => {
    const mod = await loadRoute();
    repo.getScheduleProposals.mockResolvedValue(null);
    const answers: Array<[number, string, string | null]> = [];
    for (const id of [CID, "99999999-9999-4999-8999-999999999999", "not-a-uuid", ""]) {
      const res = await mod.GET!(get(), ctx(id));
      answers.push([res.status, await res.text(), res.headers.get("cache-control")]);
    }
    expect(new Set(answers.map((a) => a[0]))).toEqual(new Set([404]));
    expect(new Set(answers.map((a) => a[1])).size).toBe(1);
    for (const a of answers) expect(a[2]).toMatch(/no-store/);
    expect(answers[0][1]).not.toMatch(/organizer|captain|draw|team|freeze|state|ready|plan|pitch/i);
  });

  it("GET: an unexpected failure is a generic 500", async () => {
    const mod = await loadRoute();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    repo.getScheduleProposals.mockRejectedValue(new Error("secret internals 12345"));
    const res = await mod.GET!(get(), ctx(CID));
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/secret|12345/);
  });
});
/** The parser's output for a body, for comparing what reaches the store. */
function parseOf(body: unknown) {
  const placements = (body as ReturnType<typeof BODY>).placements;
  return placements.map((p) => ({ fixtureRole: p.fixtureRole, planningPitchId: p.planningPitchId, planDate: p.planDate, startTime: p.startTime }));
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The repository adapter: it sends the database four facts, and hands on only evidence that reproduces itself
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("the repository adapter sends exactly the competition, the verified caller, the identifier and the three placements — and never hands on evidence that does not reproduce itself", () => {
  const sent: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  function answer(body: unknown, status = 200) {
    sent.length = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: { body?: unknown }) => {
      sent.push({ url: String(input), body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null });
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }));
  }
  const repository = () => new SupabaseCompetitionsRepository("http://127.0.0.1:1", "service-key");
  afterEach(() => { vi.unstubAllGlobals(); });
  const placements = () => parseOf(BODY());

  it("create: sends exactly four parameters to the one operation, with the placements in role order and in the database's own words, and returns the verified proposal", async () => {
    answer({ already_proposed: false, proposal: rawEvidence() });
    const result = await repository().createScheduleProposal(CID, ORGANIZER, INTENT, placements() as never);
    expect(result).toEqual({ proposal: katRecord(), alreadyProposed: false });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toMatch(/\/rest\/v1\/rpc\/create_competition_schedule_proposal_atomically$/);
    expect(sent[0].body).toEqual({
      p_competition_id: CID, p_organizer_gaming_member_id: ORGANIZER, p_intent_id: INTENT,
      p_placements: [
        { fixture_role: "SEMIFINAL_1", planning_pitch_id: PITCH.A, plan_date: "2026-11-14", start_time: "09:00" },
        { fixture_role: "SEMIFINAL_2", planning_pitch_id: PITCH.B, plan_date: "2026-11-14", start_time: "09:00" },
        { fixture_role: "FINAL", planning_pitch_id: PITCH.A, plan_date: "2026-11-14", start_time: "10:08" },
      ],
    });
  });

  it("create: an exact replay is reported as such", async () => {
    answer({ already_proposed: true, proposal: rawEvidence() });
    expect((await repository().createScheduleProposal(CID, ORGANIZER, INTENT, placements() as never)).alreadyProposed).toBe(true);
  });

  it("create: a database refusal becomes its typed error (the shared translation, ahead of every shared code)", async () => {
    const { ScheduleProposalError, ScheduleProposalValidationError } = await loadSp();
    answer({ code: "P0001", message: "SCHEDULE_PROPOSAL_DRAW_REQUIRED: no draw", details: null, hint: null }, 400);
    const refusal = await repository().createScheduleProposal(CID, ORGANIZER, INTENT, placements() as never).then(() => null, (e: unknown) => e);
    expect(refusal).toBeInstanceOf(ScheduleProposalError);
    expect((refusal as { code: string }).code).toBe("DRAW_REQUIRED");
    answer({ code: "P0001", message: "SCHEDULE_PROPOSAL_INVALID: FINAL_REST: too soon", details: null, hint: null }, 400);
    const invalid = await repository().createScheduleProposal(CID, ORGANIZER, INTENT, placements() as never).then(() => null, (e: unknown) => e);
    expect(invalid).toBeInstanceOf(ScheduleProposalValidationError);
  });

  it("create: evidence that does not verify is never returned (a changed digest, a changed start, a response without a proposal)", async () => {
    for (const body of [
      { already_proposed: false, proposal: rawEvidence({ proposal_digest: sha("tampered") }) },
      { already_proposed: false, proposal: rawEvidence({ placements: rawEvidence().placements.map((p: any, i: number) => (i === 0 ? { ...p, start_utc: "2026-11-14T15:01:00.000Z" } : p)) }) },
      { already_proposed: false, proposal: rawEvidence({ timing: { occupancy_minutes: 40, pitch_transition_minutes: 10, minimum_team_rest_minutes: 30 } }) },
      { already_proposed: false }, { already_proposed: false, proposal: null }, { already_proposed: false, proposal: [] }, null,
    ]) {
      answer(body);
      await expect(repository().createScheduleProposal(CID, ORGANIZER, INTENT, placements() as never), JSON.stringify(body).slice(0, 80)).rejects.toThrow();
    }
  });

  it("read: sends exactly the competition and the verified caller; SQL NULL is 'no part in this'; the organizer's read is verified before it is returned", async () => {
    answer({ context: rawContext(), proposal: rawEvidence(), history: rawHistory() });
    expect(await repository().getScheduleProposals(CID, ORGANIZER)).toEqual({ context: ctxRecord(), proposal: katRecord(), history: HISTORY });
    expect(sent[0].url).toMatch(/\/rest\/v1\/rpc\/get_competition_schedule_proposals$/);
    expect(sent[0].body).toEqual({ p_competition_id: CID, p_caller_gaming_member_id: ORGANIZER });
    answer(null);
    expect(await repository().getScheduleProposals(CID, STRANGER)).toBeNull();
    answer({ context: null, proposal: null, history: [] });
    expect(await repository().getScheduleProposals(CID, ORGANIZER)).toEqual({ context: null, proposal: null, history: [] });
    answer({ context: rawContext(), proposal: rawEvidence({ proposal_digest: sha("tampered") }), history: rawHistory() });
    await expect(repository().getScheduleProposals(CID, ORGANIZER)).rejects.toThrow(/could not be verified/);
    for (const body of [{}, { proposal: null }, { context: null, proposal: null }, "x", []]) {
      answer(body);
      await expect(repository().getScheduleProposals(CID, ORGANIZER), JSON.stringify(body)).rejects.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The static facts about the surface
// ---------------------------------------------------------------------------------------------------------------------------------------------

const SURFACE = ["lib/gaming/competitions/scheduleProposal.ts", "app/api/gaming/competitions/[competitionId]/schedule-proposal/route.ts"];
const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

describe("no clock, no randomness and no environment in the application: the decision instant and every identifier are the database's alone", () => {
  const FORBIDDEN_IN_APP: Array<[string, RegExp]> = [
    ["Math.random", /Math\.random/], ["crypto random bytes", /randomBytes|randomInt|randomUUID|randomFill/], ["getRandomValues", /getRandomValues/],
    ["webcrypto", /crypto\.subtle|webcrypto/], ["a clock", /Date\.now|new Date\(\s*\)|performance\.now|hrtime/], ["an environment-chosen value", /process\.env/],
  ];
  it.each(SURFACE)("%s contains no random source, no clock and no seed from outside", (file) => {
    const source = strip(read(file));
    for (const [label, pattern] of FORBIDDEN_IN_APP) expect(source, `${file}: ${label}`).not.toMatch(pattern);
  });

  it("the repository adapter sends the database exactly the facts the contract names — nothing more", () => {
    const source = read("lib/gaming/competitions/db/supabaseCompetitionsRepository.ts");
    const create = /rpc\("create_competition_schedule_proposal_atomically",\s*\{([^}]*)\}/.exec(source);
    const readRpc = /rpc\("get_competition_schedule_proposals",\s*\{([^}]*)\}/.exec(source);
    expect(create, "the create call").not.toBeNull();
    expect(readRpc, "the read call").not.toBeNull();
    expect([...create![1].matchAll(/(p_[a-z_]+)\s*:/g)].map((m) => m[1])).toEqual(["p_competition_id", "p_organizer_gaming_member_id", "p_intent_id", "p_placements"]);
    expect([...readRpc![1].matchAll(/(p_[a-z_]+)\s*:/g)].map((m) => m[1])).toEqual(["p_competition_id", "p_caller_gaming_member_id"]);
  });
});

describe("[20] no page offers a schedule proposal, and no format other than five-a-side is made available", () => {
  const PUBLIC = () => walk(path.join(REPO_ROOT, "public"), (f) => /\.(html|js)$/.test(f));

  it("no public page or script calls the proposal endpoint or carries a proposal control", () => {
    for (const file of PUBLIC()) {
      const source = readFileSync(file, "utf8");
      const where = path.relative(REPO_ROOT, file);
      expect(source, `${where}: a /schedule-proposal path`).not.toMatch(/schedule-proposal/);
      expect(source, `${where}: a schedule_proposal name`).not.toMatch(/schedule_proposal|scheduleProposal/i);
    }
  });

  it("the registry still knows the same four formats, the creation routes still take no format from it, and the new module and route name none of them", () => {
    expect([...SOCCER_FORMAT_KEYS]).toEqual(["SOCCER_5V5", "SOCCER_6V6", "SOCCER_7V7", "SOCCER_8V8"]);
    expect(read("lib/gaming/competitions/createCompetition.ts")).not.toMatch(/formats|SOCCER_FORMAT|planning|draw|schedule/i);
    expect(read("app/api/gaming/host/competition/route.ts")).not.toMatch(/activityKey|formats|SOCCER_|draw|schedule/i);
    expect(read("app/api/gaming/competitions/route.ts")).not.toMatch(/planning|formats|draw|schedule/i);
    for (const file of SURFACE) expect(strip(read(file)), file).not.toMatch(/SOCCER_[5-8]V[5-8]/);
  });

  it("no discovery read, no creation function and no publication function mentions schedule proposals", () => {
    for (const file of ["lib/gaming/competitions/getCompetitionView.ts", "lib/gaming/competitions/publishCompetition.ts", "lib/gaming/competitions/createCompetition.ts", "lib/gaming/competitions/organizerAccess.ts",
      "lib/gaming/competitions/administration.ts", "lib/gaming/competitions/resolveCompetitionByPublicCode.ts"]) {
      expect(read(file), file).not.toMatch(/schedule[-_ ]?proposal|ScheduleProposal/);
    }
  });
});

describe("the migration (static contract): exactly one new, append-only migration", () => {
  const DIR = path.join(REPO_ROOT, "supabase/migrations");
  /** The draw's migration (SSS-019): the proposal's must sort after it, and nothing else may sort after it but the proposal's. */
  const DRAW_MIGRATION = "20261103094717_competition_four_team_draw_foundation.sql";
  const found = () => readdirSync(DIR).filter((f) => /schedule_proposal/i.test(f));
  const code = () => {
    const files = found();
    if (files.length !== 1) throw new Error(`expected exactly one schedule-proposal migration, found ${files.length}`);
    return readFileSync(path.join(DIR, files[0]), "utf8").split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
  };
  const body = (sql: string, name: string) => {
    const start = sql.indexOf(`create function ${name}(`);
    expect(start, `${name} exists`).toBeGreaterThan(-1);
    const end = sql.indexOf("$function$;", sql.indexOf("$function$", start + 20) + 5);
    return sql.slice(start, end);
  };
  const TABLES = ["competition_schedule_proposal_placements", "competition_schedule_proposals"];
  const RPCS = ["create_competition_schedule_proposal_atomically", "get_competition_schedule_proposals"];

  it("is exactly one migration with a descriptive schedule-proposal name, after the draw's, and the only one after it", () => {
    const files = found();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^\d{14}_[a-z0-9_]*schedule_proposal[a-z0-9_]*\.sql$/);
    expect(files[0] > DRAW_MIGRATION).toBe(true);
    expect(readdirSync(DIR).filter((f) => f > DRAW_MIGRATION)).toEqual(files);
  });

  it("creates exactly the two proposal tables, server-only: row-level security on, no policy, no privilege for anyone", () => {
    const sql = code();
    expect([...sql.matchAll(/create table (\w+)/g)].map((m) => m[1]).sort()).toEqual(TABLES);
    for (const table of TABLES) {
      expect(sql, table).toMatch(new RegExp(`alter table ${table} enable row level security;`));
      expect(sql, table).toMatch(new RegExp(`revoke all on table ${table} from public, anon, authenticated, service_role;`));
    }
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).not.toMatch(/grant\s+(select|insert|update|delete|truncate|all)[^;]*\bon\s+(table\s+)?competition_schedule/i);
  });

  it("keeps one sequence and one intent per competition, one successor per proposal, exactly three placements by role, and the shapes of every digest, as constraints", () => {
    const sql = code();
    expect(sql).toMatch(/unique \(competition_id, sequence_number\)/);
    expect(sql).toMatch(/unique \(competition_id, intent_id\)/);
    expect(sql).toMatch(/unique \(supersedes_schedule_proposal_id\)/);
    expect(sql).toMatch(/primary key \(schedule_proposal_id, fixture_role\)/);
    expect(sql).toMatch(/fixture_role in \('SEMIFINAL_1', 'SEMIFINAL_2', 'FINAL'\)/);
    expect(sql).toMatch(/\(sequence_number = 1\) = \(supersedes_schedule_proposal_id is null\)/);
    expect(sql).toMatch(/proposal_digest ~ '\^\[0-9a-f\]\{64\}\$'/);
    expect(sql).toMatch(/references competition_planning_revisions \(competition_id, planning_revision_id\)/);
    expect(sql).toMatch(/references competition_draws \(competition_id, competition_draw_id\)/);
    expect(sql).toMatch(/references competition_planning_dates \(planning_revision_id, plan_date\)/);
    expect(sql).toMatch(/references competition_planning_pitches \(planning_pitch_id\)/);
  });

  it("refuses UPDATE, DELETE and TRUNCATE by trigger on both tables, and verifies the evidence at commit with deferred constraint triggers", () => {
    const sql = code();
    for (const table of TABLES) {
      expect(sql, table).toMatch(new RegExp(`create trigger \\w+ before update or delete on ${table}\\s+for each row execute function competition_schedule_reject_change\\(\\)`));
      expect(sql, table).toMatch(new RegExp(`create trigger \\w+ before truncate on ${table}\\s+for each statement execute function competition_schedule_reject_change\\(\\)`));
    }
    expect([...sql.matchAll(/create constraint trigger/g)]).toHaveLength(2);
    expect(sql.match(/deferrable initially deferred/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("defines exactly the two operations, SECURITY DEFINER with a pinned search_path, executable by the server role alone, taking no team, pairing, time, duration, capacity, format or actor beyond the verified caller", () => {
    const sql = code();
    expect(sql).toMatch(/create function create_competition_schedule_proposal_atomically\(p_competition_id uuid, p_organizer_gaming_member_id uuid, p_intent_id uuid, p_placements jsonb\)/);
    expect(sql).toMatch(/create function get_competition_schedule_proposals\(p_competition_id uuid, p_caller_gaming_member_id uuid\)/);
    for (const name of RPCS) {
      const fn = body(sql, name);
      expect(fn, name).toMatch(/security definer/);
      expect(fn, name).toMatch(/set search_path = public, pg_temp/);
    }
    expect(sql).toMatch(/grant execute on function create_competition_schedule_proposal_atomically\(uuid, uuid, uuid, jsonb\) to service_role;/);
    expect(sql).toMatch(/grant execute on function get_competition_schedule_proposals\(uuid, uuid\) to service_role;/);
    expect([...sql.matchAll(/grant execute on function (\w+)/g)].map((m) => m[1]).sort()).toEqual(RPCS);
  });

  it("every other function is internal: revoked from everyone, including the server role", () => {
    const sql = code();
    const all = [...sql.matchAll(/create function (\w+)\(/g)].map((m) => m[1]);
    expect(all.length).toBeGreaterThanOrEqual(8);
    for (const name of all) {
      expect(sql, name).toMatch(new RegExp(`revoke all on function ${name}\\([^)]*\\) from public, anon, authenticated`));
      if (!RPCS.includes(name)) expect(sql, `${name} (service_role)`).toMatch(new RegExp(`revoke all on function ${name}\\([^)]*\\) from service_role`));
    }
  });

  it("the create operation takes the competition lock, then decides authority, the request, the replay, eligibility, the schedule, and only then writes — in that order", () => {
    const fn = body(code(), "create_competition_schedule_proposal_atomically");
    const at = (needle: string) => { const i = fn.indexOf(needle); expect(i, needle).toBeGreaterThan(-1); return i; };
    const lock = at("pg_advisory_xact_lock(hashtext('competition_scope:'");
    const owner = at("p_organizer_gaming_member_id is distinct from");
    const revoked = at("assert_competition_not_host_revoked(");
    const request = at("competition_schedule_request_digest(");
    const replay = at("already_proposed");
    const eligibility = at("competition_schedule_eligibility_problem(");
    const evaluation = at("competition_schedule_evaluate(");
    const insert = at("insert into competition_schedule_proposals");
    expect([lock, owner, revoked, request, replay, eligibility, evaluation, insert]).toEqual([lock, owner, revoked, request, replay, eligibility, evaluation, insert].sort((a, b) => a - b));
    expect(fn.match(/gen_random_uuid\(\)/g)).toHaveLength(1); // the proposal's own identifier
    expect(fn).toMatch(/competition_registration_clock\(\)/);
  });

  it("uses no weak or external randomness and no wall clock: only the accepted clock seam", () => {
    const sql = code();
    for (const pattern of [/\brandom\s*\(/i, /setseed/i, /tablesample/i, /order by\s+random/i, /gen_random_bytes/i, /pgcrypto/i, /create extension/i, /uuid_generate/i, /dblink|http_|pg_net|plv8|plpython/i,
      /\bnow\s*\(\s*\)/i, /clock_timestamp\s*\(/i, /current_timestamp|statement_timestamp|transaction_timestamp|localtimestamp/i]) {
      expect(sql, String(pattern)).not.toMatch(pattern);
    }
  });

  it("only creates new objects and writes only the proposal's own tables: nothing replaced, no fixture, publication, state, draw, plan or registry change, no reschedule, notification, appeal or adjudication", () => {
    const sql = code();
    expect(sql).not.toMatch(/create or replace/i);
    expect(sql).not.toMatch(/\bdrop\s+/i);
    expect(sql).not.toMatch(/alter table (?!competition_schedule_proposal)/i);
    expect([...new Set([...sql.matchAll(/insert into (\w+)/g)].map((m) => m[1]))].sort()).toEqual(TABLES);
    expect(sql).not.toMatch(/\bupdate\s+\w+\s+set\b/i);
    expect(sql).not.toMatch(/delete from/i);
    expect(sql).not.toMatch(/(insert into|update|delete from)\s+(competition_fixtures|competitions|competition_draws|competition_draw_entries|competition_planning_\w+|competition_format_rules|competition_registration_\w+|competition_plan_change_\w+)\b/i);
    expect(sql).not.toMatch(/publish_competition_atomically|reschedul|notif|appeal|adjudicat|webhook|email/i);
    expect(sql).not.toMatch(/set\s+state\s*=|'(DRAFT|TEAM_REGISTRATION_OPEN|PUBLISHED|COMPLETE|CANCELLED)'/);
    expect(sql).not.toMatch(/SOCCER_[5-8]V[5-8]/);
  });

  it("every comparison of a member identifier is null-safe: none uses a bare <> or != (the repository-wide authorization rule the live catalog scan also enforces)", () => {
    const sql = code();
    expect(sql).not.toMatch(/gaming_member_id\s*(<>|!=)/);
    expect(sql).not.toMatch(/(<>|!=)\s*[a-z_.]*gaming_member_id/);
    expect(body(sql, "create_competition_schedule_proposal_atomically")).toMatch(/p_organizer_gaming_member_id is distinct from v_organizer_id/);
    expect(body(sql, "get_competition_schedule_proposals")).toMatch(/p_caller_gaming_member_id is distinct from v_organizer_id/);
  });

  it("reads the registry for the timing and the competition's own format for the rest: the operation takes the format from no argument", () => {
    const sql = code();
    expect(sql).toMatch(/from competition_format_rules/);
    const create = body(sql, "create_competition_schedule_proposal_atomically");
    expect(create).toMatch(/activity_key/);
    expect(create).not.toMatch(/p_format|p_timing|p_zone|p_capacity|p_now|p_actor/);
  });
});

describe("the new tests are registered in the explicit lists", () => {
  it("package.json runs this file in the ordinary suite and the contract file in the contract suite", () => {
    const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;
    expect(scripts.test).toContain("__tests__/competitionScheduleProposal.test.ts");
    expect(scripts["test:contract"]).toContain("__tests__/competitionScheduleProposalSupabase.contract.test.ts");
    expect(scripts["test:contract"]).not.toContain("competitionScheduleProposal.test.ts");
  });
});
