import { createHash, randomUUID } from "node:crypto";

import { loadEnv } from "vite";
import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SupabaseCompetitionsRepository } from "../lib/gaming/competitions/db/supabaseCompetitionsRepository";
import { SupabaseHostRepository } from "../lib/gaming/host/db/supabaseHostRepository";
import { SupabaseGamingRepository } from "../lib/gaming/db/supabaseGamingRepository";
import { submitHostApplication } from "../lib/gaming/host/submitHostApplication";
import { decideHostApplication } from "../lib/gaming/host/decideHostApplication";
import { revokeHostCapability } from "../lib/gaming/host/revokeHostCapability";
import { createCompetition } from "../lib/gaming/competitions/createCompetition";
import { addCompetitionTeam } from "../lib/gaming/competitions/addCompetitionTeam";
import { openTeamRegistration } from "../lib/gaming/competitions/openTeamRegistration";
import { closeTeamRegistration } from "../lib/gaming/competitions/closeTeamRegistration";
import { publishCompetition } from "../lib/gaming/competitions/publishCompetition";
import { cancelCompetition } from "../lib/gaming/competitions/cancelCompetition";
import { appointScorekeeper } from "../lib/gaming/competitions/appointScorekeeper";
import { CompetitionAccessDeniedError, CompetitionNotFoundError, HostAccessRevokedError, UnsupportedActivityKeyError } from "../lib/gaming/competitions/types";
import type { SoccerFormatKey } from "../lib/gaming/competitions/formats";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";
// The REAL route handlers, called with real user access tokens against the real local database.
import { POST as hostCreateRoute } from "../app/api/gaming/host/competition/route";

/**
 * UG-CR-GATE-SSS-022 — Four-Team Schedule Proposal backend foundation, against a real (disposable, loopback-only) Postgres.
 *
 * Proves, in the database itself: only the competition's own ACTIVE organizer can create or read a proposal (a revoked host, a frozen captain, a scorekeeper, an ordinary
 * member and a member holding only OPERATIONAL authority cannot); no proposal without READY_TO_PUBLISH, a consistent freeze, exactly one permanent draw, a current accepted
 * plan, no pending plan change and no fixture; the request is exactly an intent and three placements and the server derives every other fact (teams and pairing from the
 * draw; venue, dates, windows, pitches, capacity and zone from the current plan revision; timing from the format registry; the actor from the caller); one complete schedule is
 * judged by every rule (occupancy, same-pitch transition, window containment, capacity, the final's rest for BOTH finalists, the strict future by the accepted clock seam, and
 * a venue-local time the clocks skip or repeat), against an independent oracle (oracle.py: Python zoneinfo, written from the gate's text); proposals are append-only versions
 * with an idempotent intent, a conflict that fails closed, a gap-free sequence under concurrency and preserved superseded evidence; a plan change activated after the draw makes
 * an older proposal stale and leaves the draw exactly as it was; and a proposal creates no fixture, publishes nothing, changes no state and changes nothing the freeze, the draw,
 * the plan, the amendments, discovery or the view carry.
 *
 * CLOCK. The decision instant is competition_registration_clock() (SSS-007): this file redefines it ONLY inside transactions it rolls back. THE MATRIX uses a competition whose plan
 * is pinned to fixed dates (a service-side fixture, like the amendment suite's DST fixture), decided on pinned instants, so it never depends on the real calendar; tests that COMMIT
 * proposals use plans whose dates are relative to the real clock. Service-side fixtures (the database owner) are used only to build the planned, frozen and drawn competition
 * quickly, to put a competition into a state no public path can reach, and to forge evidence the operations never would — each is named where it is used.
 */

const env = loadEnv("development", process.cwd(), "");
const supabaseUrl = env.SUPABASE_URL;
requireLocalSupabase(supabaseUrl);
const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAnonKey = env.SUPABASE_ANON_KEY;
if (!supabaseUrl || !supabaseServiceRoleKey || !supabaseAnonKey) {
  throw new Error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are required for contract tests.");
}
// Raw pg runs the rolled-back clock seam, the fixtures, the forged evidence and the catalog checks. The URL is supplied explicitly, never read from .env.local, and must be loopback.
const supabaseDbUrl = process.env.COMPETITIONS_LOCAL_DB_URL ?? "";
if (!/^postgresql:\/\/[^@]+@(127\.0\.0\.1|localhost|\[::1\]):\d+\//.test(supabaseDbUrl)) {
  throw new Error("COMPETITIONS_LOCAL_DB_URL must be set to a loopback Postgres URL for the schedule proposal contract tests.");
}

const compRepo = new SupabaseCompetitionsRepository(supabaseUrl, supabaseServiceRoleKey);
const hostRepo = new SupabaseHostRepository(supabaseUrl, supabaseServiceRoleKey);
const gamingRepo = new SupabaseGamingRepository(supabaseUrl, supabaseServiceRoleKey);
const service = createClient(supabaseUrl, supabaseServiceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
const anon = createClient(supabaseUrl, supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false } });

const RUN = randomUUID().slice(0, 8);
const DAY = 24 * 3600_000;
const TABLES = ["competition_schedule_proposal_placements", "competition_schedule_proposals"] as const;
const RPCS = ["create_competition_schedule_proposal_atomically", "get_competition_schedule_proposals"] as const;
const HELPERS = [
  "competition_schedule_context", "competition_schedule_eligibility_problem", "competition_schedule_evaluate", "competition_schedule_placement_verify_row", "competition_schedule_proposal_digest",
  "competition_schedule_proposal_evidence", "competition_schedule_proposal_verify", "competition_schedule_proposal_verify_row", "competition_schedule_reject_change",
  "competition_schedule_request_digest", "competition_schedule_timing",
] as const;
const ALL4 = ["SOCCER_5V5", "SOCCER_6V6", "SOCCER_7V7", "SOCCER_8V8"];

// Loaded lazily: until the module exists, only the tests that need it can fail.
const loadSp = () => import("../lib/gaming/competitions/scheduleProposal");
const loadRoute = async () => (await import("../app/api/gaming/competitions/[competitionId]/schedule-proposal/route")) as unknown as Record<string, (r: Request, c: { params: { competitionId: string } }) => Promise<Response>>;

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The independent oracle (oracle.py) — see competitionScheduleProposal.test.ts; the same rows, now judged by the database.
// ---------------------------------------------------------------------------------------------------------------------------------------------

const PINNED_NOW = "2026-11-10T12:00:00.000Z";
const NY_NOW = "2026-10-30T14:00:00.000Z";
const PINNED_DAYS: Record<string, string> = { "1": "2026-11-14", "2": "2026-11-15", "3": "2026-11-16" };
// Costa Rica has no daylight saving: always UTC-06:00, so these instants are arithmetic, not a second implementation of anything.
const crInstant = (day: string, hhmm: string) => new Date(Date.parse(`${PINNED_DAYS[day]}T${hhmm}:00-06:00`)).toISOString();
const crWindow = (day: string, hhmm: string): [string, string] => {
  const windows: Record<string, Array<[string, string]>> = { "1": [["09:00", "12:00"], ["13:00", "16:00"]], "2": [["09:00", "10:00"], ["10:05", "12:00"]] };
  const found = windows[day].find(([s, e]) => hhmm >= s && hhmm < e)!;
  return [crInstant(day, found[0]), crInstant(day, found[1])];
};

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
const GATE_TIMING: Record<string, { occupancy: number; transition: number; rest: number }> = {
  SOCCER_5V5: { occupancy: 38, transition: 10, rest: 30 }, SOCCER_6V6: { occupancy: 42, transition: 10, rest: 30 },
  SOCCER_7V7: { occupancy: 50, transition: 10, rest: 45 }, SOCCER_8V8: { occupancy: 50, transition: 10, rest: 45 },
};

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
const KAT = {
  competition: "11111111-1111-4111-8111-111111111111", intent: "33333333-3333-4333-8333-333333333333", intent2: "44444444-4444-4444-8444-444444444444",
  revision: "22222222-2222-4222-8222-222222222222", draw: "55555555-5555-4555-8555-555555555555",
  pitchA: "a0a0a0a0-a0a0-40a0-80a0-a0a0a0a0a001", pitchB: "b0b0b0b0-b0b0-40b0-80b0-b0b0b0b0b002",
  drawDigest: createHash("sha256").update("draw", "utf8").digest("hex"),
  request1: "dad0af24474920fbe58f4f15a19980a8edb34b0bfe305583af09a8419bc07f58", request2: "51ecfffebf6c7164d7cf7952be2331f428fd42fa8c5bb1dfc03d59ebf4313025",
  proposal1: "c6b64b3101982308672760eb6aa091853b408d671a96efd32bc16cc6bcbca8bf", proposal2: "8a4c1b8926151de94ef00905b9c478b6b6fe66186ef21fe79e6dda2ede2b1184",
};

// ---------------------------------------------------------------------------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------------------------------------------------------------------------

interface Person { authUserId: string; gamingMemberId: string; email: string }
const authUsers: string[] = [];
const operators: string[] = [];
const competitionIds: string[] = [];
let counter = 0;

async function newPerson(label: string): Promise<Person> {
  const email = `sched-${RUN}-${counter++}@example.com`;
  const { data, error } = await service.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("Could not create a test auth user.");
  authUsers.push(data.user.id);
  const member = await gamingRepo.createGamingMember(data.user.id, `${label.slice(0, 26)} ${RUN}-${counter}`);
  return { authUserId: data.user.id, gamingMemberId: member.gamingMemberId, email };
}

async function makeOperator(label: string): Promise<Person> {
  const person = await newPerson(label);
  const { error } = await service.from("authority_grants").insert({ gaming_member_id: person.gamingMemberId, authority_class: "OPERATIONAL" });
  if (error) throw error;
  operators.push(person.gamingMemberId);
  return person;
}

let reviewer: Person;
async function asGovernance<T>(fn: () => Promise<T>): Promise<T> {
  const { error } = await service.from("authority_grants").insert({ gaming_member_id: reviewer.gamingMemberId, authority_class: "PRODUCT_GOVERNANCE" });
  if (error) throw error;
  try {
    return await fn();
  } finally {
    await service.from("authority_grants").delete().eq("gaming_member_id", reviewer.gamingMemberId).eq("authority_class", "PRODUCT_GOVERNANCE");
  }
}

async function tokenFor(person: Person): Promise<string> {
  const link = await service.auth.admin.generateLink({ type: "magiclink", email: person.email });
  if (!link.data.properties) throw new Error("No link properties for the test member.");
  const client = createClient(supabaseUrl, supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const verified = await client.auth.verifyOtp({ token_hash: link.data.properties.hashed_token, type: "email" });
  const token = verified.data.session?.access_token;
  if (!token) throw new Error("No session for the test member.");
  return token;
}

// A shared pool: a member can belong to one team per competition, so each competition draws disjoint slices from the same people.
const POOL_SIZE = 26;
let captains: Person[] = [];
let pool: Person[] = [];
async function ensurePool() {
  if (pool.length > 0) return;
  captains = await Promise.all([0, 1, 2, 3, 4].map((i) => newPerson(`Captain ${i}`)));
  const made: Person[] = [];
  for (let i = 0; i < POOL_SIZE; i += 8) {
    made.push(...(await Promise.all(Array.from({ length: Math.min(8, POOL_SIZE - i) }, (_, k) => newPerson(`Player ${i + k}`)))));
  }
  pool = made;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Raw database access (the database owner), fixtures and the rolled-back clock
// ---------------------------------------------------------------------------------------------------------------------------------------------

async function rawTransaction<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  const db = new Client({ connectionString: supabaseDbUrl, statement_timeout: 60000 });
  await db.connect();
  try {
    await db.query("begin");
    return await fn(db);
  } finally {
    await db.query("rollback").catch(() => {});
    await db.end().catch(() => {});
  }
}

async function rawQuery<T extends Record<string, any> = Record<string, any>>(sql: string, params: unknown[] = []): Promise<T[]> {
  const db = new Client({ connectionString: supabaseDbUrl, statement_timeout: 60000 });
  await db.connect();
  try {
    return (await db.query(sql, params)).rows as T[];
  } finally {
    await db.end().catch(() => {});
  }
}

interface DbViolation { code?: string; constraint?: string; message: string }
/** Runs statements inside a transaction that is always rolled back, forcing every deferred check to run before the end; returns the database error (or null). */
async function violationOf(fn: (db: Client) => Promise<void>): Promise<DbViolation | null> {
  return rawTransaction(async (db) => {
    try {
      await fn(db);
      await db.query("set constraints all immediate");
      return null;
    } catch (err) {
      const e = err as { code?: string; constraint?: string; message?: string };
      return { code: e.code, constraint: e.constraint, message: e.message ?? "" };
    }
  });
}

type Outcome = { ok: true; rows: Record<string, any>[] } | { ok: false; message: string; code?: string };
const CLOCK_DEFINITION = (instant: string) => `create or replace function public.competition_registration_clock() returns timestamptz language sql volatile set search_path to 'public' as $clock$ select '${instant}'::timestamptz $clock$`;
/** Calls one statement with the database clock put on an exact instant, in a transaction that is ALWAYS rolled back. */
async function atInstant(instant: string, statement: string, params: unknown[] = []): Promise<Outcome> {
  return rawTransaction(async (db) => {
    await db.query(CLOCK_DEFINITION(instant));
    try {
      return { ok: true, rows: (await db.query(statement, params)).rows };
    } catch (err) {
      const e = err as { code?: string; message?: string };
      return { ok: false, message: e.message ?? "", code: e.code };
    }
  });
}
/** The same seam, for a decision that must be READ BACK before its transaction ends. */
async function withClockAt<T>(instant: string, fn: (db: Client) => Promise<T>): Promise<T> {
  return rawTransaction(async (db) => {
    await db.query(CLOCK_DEFINITION(instant));
    return fn(db);
  });
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Plans and competitions
// ---------------------------------------------------------------------------------------------------------------------------------------------

const CR_OFFSET_MS = -6 * 3600_000; // America/Costa_Rica has no daylight saving: always UTC-06:00
const localMinute = (utcMs: number) => new Date(utcMs + CR_OFFSET_MS).toISOString().slice(0, 16);
const localDate = (utcMs: number) => new Date(utcMs + CR_OFFSET_MS).toISOString().slice(0, 10);

function rawPlan(opts: { deadlineMs: number }) {
  return {
    venue: { name: `Cancha ${RUN}`, locationDescription: "Calle 5, San José, behind the central market", timeZone: "America/Costa_Rica", simultaneousMatchCapacity: 1, restrictionNotes: "No metal cleats." },
    pitches: [{ label: "A", usable: true, supportedFormats: ["SOCCER_5V5"], restrictionNotes: "" }],
    dates: [{ date: localDate(opts.deadlineMs + 3 * DAY), windows: [{ start: "09:00", end: "13:00" }] }],
    roster: { minimum: 5, maximum: 8 },
    registrationDeadline: { local: localMinute(opts.deadlineMs), timeZone: "America/Costa_Rica" },
    rules: { version: "draft-1", snapshot: "Draft registration rules, version one." },
  };
}

async function savePlan(competitionId: string, organizerId: string, deadlineMs: number) {
  const { parsePlanningPlan } = await import("../lib/gaming/competitions/planning");
  return compRepo.savePlanningRevision(competitionId, organizerId, randomUUID(), parsePlanningPlan(rawPlan({ deadlineMs }), "SOCCER_5V5"));
}

interface PlanSpec {
  timeZone: string;
  capacity: number;
  pitches: Array<{ label: string; usable: boolean; formats: string[] }>;
  dates: Array<{ date: string; windows: Array<{ start: string; end: string }> }>;
  /** The registration deadline, as a UTC instant, with the zone's offset in force then; it must be in the past (the real close needs it) and before the first window. */
  deadlineIso: string;
  deadlineOffsetMinutes: number;
}

/**
 * Service-side fixture: records a later planning revision as the database owner, exactly as the plan spec says (venue zone, capacity, pitches with the formats each takes, dates
 * and windows, the deadline). The revision chain, the children and every constraint are the real ones; only the save operation (which needs a DRAFT, a future deadline and a
 * minute-resolution deadline) is bypassed. Used BEFORE the freeze, so the freeze records exactly this revision.
 */
async function recordPlan(competitionId: string, spec: PlanSpec): Promise<string> {
  return rawTransaction(async (db) => {
    const cur = (await db.query("select * from competition_planning_revisions where competition_id = $1 order by revision_number desc limit 1", [competitionId])).rows[0];
    const next = (await db.query(
      `insert into competition_planning_revisions (competition_id, format_key, revision_number, supersedes_revision_id, authored_by_gaming_member_id, intent_id, payload_digest,
         venue_name, venue_location_description, venue_time_zone, simultaneous_match_capacity, venue_restriction_notes, roster_minimum, roster_maximum,
         registration_deadline_local, registration_deadline_time_zone, registration_deadline_utc_offset_minutes, registration_deadline_utc, rules_version, rules_snapshot, rules_snapshot_digest)
       values ($1,$2,$3,$4,$5,gen_random_uuid(),$6,$7,$8,$9,$10,$11,$12,$13, ($14::timestamptz at time zone $9), $9, $15, $14::timestamptz, $16,$17,$18) returning planning_revision_id`,
      [competitionId, cur.format_key, cur.revision_number + 1, cur.planning_revision_id, cur.authored_by_gaming_member_id, cur.payload_digest, cur.venue_name, cur.venue_location_description,
        spec.timeZone, spec.capacity, cur.venue_restriction_notes, cur.roster_minimum, cur.roster_maximum, spec.deadlineIso, spec.deadlineOffsetMinutes,
        cur.rules_version, cur.rules_snapshot, cur.rules_snapshot_digest])).rows[0].planning_revision_id as string;
    for (let i = 0; i < spec.pitches.length; i++) {
      const pitch = spec.pitches[i];
      const id = (await db.query("insert into competition_planning_pitches (planning_revision_id, position, label, is_usable, restriction_notes) values ($1,$2,$3,$4,'') returning planning_pitch_id", [next, i + 1, pitch.label, pitch.usable])).rows[0].planning_pitch_id as string;
      for (const format of pitch.formats) await db.query("insert into competition_planning_pitch_formats (planning_pitch_id, format_key) values ($1,$2)", [id, format]);
    }
    const dates = [...spec.dates].sort((a, b) => (a.date < b.date ? -1 : 1));
    for (let i = 0; i < dates.length; i++) {
      await db.query("insert into competition_planning_dates (planning_revision_id, plan_date, position) values ($1,$2,$3)", [next, dates[i].date, i + 1]);
      const windows = [...dates[i].windows].sort((a, b) => (a.start < b.start ? -1 : 1));
      for (let j = 0; j < windows.length; j++) {
        await db.query("insert into competition_planning_windows (planning_revision_id, plan_date, window_index, start_time, end_time) values ($1,$2,$3,$4,$5)", [next, dates[i].date, j + 1, windows[j].start, windows[j].end]);
      }
    }
    await db.query("commit");
    return next;
  });
}

/**
 * The live plans' registration deadline: ten whole minutes before the start of this minute. The real close judges "the deadline has been reached" on the DATABASE's clock, while this
 * test picks the deadline on the HOST's clock; a deadline only seconds ago would make that judgment depend on the sub-second difference between the two clocks (a virtual machine's
 * clock can lag the host's), and so on how far into the minute the fixture happened to be built. Ten minutes makes it independent of any such difference.
 */
const livePlanDeadline = () => new Date(Math.floor(Date.now() / 60_000) * 60_000 - 10 * 60_000).toISOString();
const PITCHES_5V5_MIXED = [
  { label: "A", usable: true, formats: ALL4 }, { label: "B", usable: true, formats: ALL4 }, { label: "C", usable: true, formats: ["SOCCER_5V5"] },
  { label: "E", usable: false, formats: ["SOCCER_5V5"] }, { label: "F", usable: true, formats: ["SOCCER_6V6"] },
];
/** A plan whose dates are relative to the real clock (five and six days ahead), for the tests that COMMIT proposals. */
function liveSpec(capacity = 2): PlanSpec {
  return {
    timeZone: "America/Costa_Rica", capacity, pitches: PITCHES_5V5_MIXED, deadlineIso: livePlanDeadline(), deadlineOffsetMinutes: -360,
    dates: [
      { date: localDate(Date.now() + 5 * DAY), windows: [{ start: "09:00", end: "12:00" }, { start: "13:00", end: "16:00" }] },
      { date: localDate(Date.now() + 6 * DAY), windows: [{ start: "09:00", end: "10:00" }, { start: "10:05", end: "12:00" }] },
    ],
  };
}
/** The oracle's Costa Rica plan, pinned to fixed dates (the deadline is long past, before the first window). */
const PINNED_SPEC: PlanSpec = {
  timeZone: "America/Costa_Rica", capacity: 2, pitches: PITCHES_5V5_MIXED, deadlineIso: "2026-11-01T06:00:00.000Z", deadlineOffsetMinutes: -360,
  dates: [
    { date: "2026-11-14", windows: [{ start: "09:00", end: "12:00" }, { start: "13:00", end: "16:00" }] },
    { date: "2026-11-15", windows: [{ start: "09:00", end: "10:00" }, { start: "10:05", end: "12:00" }] },
  ],
};
const NY_PITCHES = [{ label: "A", usable: true, formats: ALL4 }, { label: "B", usable: true, formats: ALL4 }];
const NY_FALL_SPEC: PlanSpec = { timeZone: "America/New_York", capacity: 2, pitches: NY_PITCHES, deadlineIso: "2026-10-29T22:00:00.000Z", deadlineOffsetMinutes: -240, dates: [{ date: "2026-11-01", windows: [{ start: "00:00", end: "05:00" }] }] };
const NY_SPRING_SPEC: PlanSpec = {
  timeZone: "America/New_York", capacity: 2, pitches: NY_PITCHES, deadlineIso: "2026-10-29T22:00:00.000Z", deadlineOffsetMinutes: -240,
  dates: [{ date: "2027-03-14", windows: [{ start: "00:00", end: "05:00" }, { start: "06:00", end: "12:00" }] }],
};

interface Ctx {
  competitionId: string; organizer: Person; deadlineMs: number; teams: Array<{ teamId: string; captain: Person; members: string[] }>;
  /** label -> planning pitch id of the plan revision the freeze recorded */
  pitch: Record<string, string>;
  /** "1", "2" -> the plan's dates, in order; "3" is a date that is NOT in the plan */
  dates: Record<string, string>;
  revisionId: string;
}

/** A competition with a saved plan, four organizer-created teams and (optionally) open registration. */
async function setUp(label: string, opts: { open?: boolean; teamCount?: number } = {}): Promise<Omit<Ctx, "pitch" | "dates" | "revisionId">> {
  await ensurePool();
  const deadlineMs = Date.now() + 2 * DAY;
  const organizer = await makeOperator(`${label} Organizer`);
  const created = await createCompetition(compRepo, organizer.gamingMemberId, `Schedule ${label} ${RUN}`, "SOCCER_5V5");
  competitionIds.push(created.competitionId);
  const teams: Ctx["teams"] = [];
  for (let i = 0; i < (opts.teamCount ?? 4); i++) {
    const team = await addCompetitionTeam(compRepo, created.competitionId, organizer.gamingMemberId, `T${i} ${label.slice(0, 12)} ${RUN}`, captains[i].gamingMemberId);
    teams.push({ teamId: team.competitionTeamId, captain: captains[i], members: [] });
  }
  await savePlan(created.competitionId, organizer.gamingMemberId, deadlineMs);
  if (opts.open !== false) await openTeamRegistration(compRepo, created.competitionId, organizer.gamingMemberId);
  return { competitionId: created.competitionId, organizer, deadlineMs, teams };
}

/** Service-side fixture: approved memberships for a team, drawn from a disjoint slice of the shared pool. */
async function giveMembers(ctx: { competitionId: string; organizer: Person; teams: Ctx["teams"] }, teamIndex: number, count: number): Promise<string[]> {
  const start = ctx.teams.slice(0, teamIndex).reduce((n, t) => n + t.members.length, 0);
  const slice = pool.slice(start, start + count).map((p) => p.gamingMemberId);
  expect(slice).toHaveLength(count);
  await rawQuery(
    "insert into competition_team_memberships (competition_id, competition_team_id, gaming_member_id, approved_by_gaming_member_id) select $1, $2, unnest($3::uuid[]), $4",
    [ctx.competitionId, ctx.teams[teamIndex].teamId, slice, ctx.organizer.gamingMemberId]);
  ctx.teams[teamIndex].members.push(...slice);
  return slice;
}
async function fillRosters(ctx: { competitionId: string; organizer: Person; teams: Ctx["teams"] }, size = 5) { for (let i = 0; i < ctx.teams.length; i++) await giveMembers(ctx, i, size); }

async function pitchIds(competitionId: string): Promise<{ pitch: Record<string, string>; dates: Record<string, string>; revisionId: string }> {
  const rev = (await rawQuery("select planning_revision_id from competition_planning_revisions where competition_id = $1 order by revision_number desc limit 1", [competitionId]))[0].planning_revision_id as string;
  const pitches = await rawQuery("select label, planning_pitch_id from competition_planning_pitches where planning_revision_id = $1", [rev]);
  const dates = await rawQuery("select to_char(plan_date, 'YYYY-MM-DD') as d from competition_planning_dates where planning_revision_id = $1 order by position", [rev]);
  const byIndex: Record<string, string> = {};
  dates.forEach((d, i) => { byIndex[String(i + 1)] = d.d as string; });
  // "3" is always a calendar day the plan does NOT list: two days after its last date
  byIndex["3"] = new Date(Date.parse(`${dates[dates.length - 1].d as string}T00:00:00Z`) + 2 * DAY).toISOString().slice(0, 10);
  return { pitch: { ...Object.fromEntries(pitches.map((p) => [p.label as string, p.planning_pitch_id as string])), X: randomUUID() }, dates: byIndex, revisionId: rev };
}

/** A frozen competition on this plan: four teams whose rosters were filled, the plan recorded (service-side), and registration frozen through the real close. NOT yet drawn. */
async function frozenOn(label: string, spec: PlanSpec): Promise<Ctx> {
  const base = await setUp(label);
  await fillRosters(base);
  await recordPlan(base.competitionId, spec);
  expect((await closeTeamRegistration(compRepo, base.competitionId, base.organizer.gamingMemberId)).state).toBe("READY_TO_PUBLISH");
  return { ...base, ...(await pitchIds(base.competitionId)) };
}
/** A frozen, DRAWN competition: the state in which an organizer may propose a schedule. */
async function drawnOn(label: string, spec: PlanSpec): Promise<Ctx> {
  const ctx = await frozenOn(label, spec);
  await compRepo.createCompetitionDraw(ctx.competitionId, ctx.organizer.gamingMemberId, randomUUID());
  return ctx;
}
const live = (label: string, capacity = 2) => drawnOn(label, liveSpec(capacity));

const memo = new Map<string, Promise<Ctx>>();
/** Competitions that only rolled-back statements touch are built once. */
function shared(key: string, build: () => Promise<Ctx>): Promise<Ctx> {
  if (!memo.has(key)) memo.set(key, build());
  return memo.get(key)!;
}
const pinned = () => shared("pinned", () => drawnOn("Pinned", PINNED_SPEC));
const nyFall = () => shared("nyFall", () => drawnOn("NyFall", NY_FALL_SPEC));
const nySpring = () => shared("nySpring", () => drawnOn("NySpring", NY_SPRING_SPEC));

/** An approved host's one private pilot (a DRAFT, host-bound competition) and a way to revoke the host. */
async function hostPilot(label: string) {
  const host = await newPerson(`${label} Host`);
  const application = {
    venueName: `Venue ${RUN}`, cityArea: "Fictional Heights", playingFields: 2,
    venueDescription: "A fictional venue used only by the local contract suite; it runs imaginary leagues.",
    expectedWindow: "weekend of 14 November", expectedTeamCount: 4,
    confirmAllAdults: true, confirmIndependentScorekeepers: true, confirmPilotExclusions: true,
  };
  const submitted = await submitHostApplication(hostRepo, host.gamingMemberId, application);
  await asGovernance(() => decideHostApplication(hostRepo, reviewer.gamingMemberId, submitted.publicCode, "APPROVE", null));
  process.env.BECOME_A_HOST_SCHEMA_READY = "true";
  let competitionId = "";
  try {
    const res = await hostCreateRoute(request("http://localhost/api/gaming/host/competition", "POST", await tokenFor(host), { name: `Host Pilot ${label} ${RUN}` }));
    expect(res.status).toBe(201);
    competitionId = (await res.json()).competition.competitionId;
  } finally {
    delete process.env.BECOME_A_HOST_SCHEMA_READY;
  }
  competitionIds.push(competitionId);
  const revoke = () => asGovernance(() => revokeHostCapability(hostRepo, reviewer.gamingMemberId, submitted.publicCode, "Schedule proposal contract test."));
  return { host, competitionId, revoke };
}

async function drawnPilot(label: string) {
  await ensurePool();
  const pilot = await hostPilot(label);
  const ctx = { competitionId: pilot.competitionId, organizer: pilot.host, deadlineMs: Date.now() + 2 * DAY, teams: [] as Ctx["teams"] };
  for (let i = 0; i < 4; i++) {
    const team = await addCompetitionTeam(compRepo, ctx.competitionId, pilot.host.gamingMemberId, `P${i} ${label.slice(0, 10)} ${RUN}`, captains[i].gamingMemberId);
    ctx.teams.push({ teamId: team.competitionTeamId, captain: captains[i], members: [] });
  }
  await savePlan(ctx.competitionId, pilot.host.gamingMemberId, ctx.deadlineMs);
  await openTeamRegistration(compRepo, ctx.competitionId, pilot.host.gamingMemberId);
  await fillRosters(ctx);
  await recordPlan(ctx.competitionId, liveSpec(2));
  await closeTeamRegistration(compRepo, ctx.competitionId, pilot.host.gamingMemberId);
  await compRepo.createCompetitionDraw(ctx.competitionId, pilot.host.gamingMemberId, randomUUID());
  const full: Ctx = { ...ctx, ...(await pitchIds(ctx.competitionId)) };
  return { ctx: full, pilot };
}

const COMP = "http://localhost/api/gaming/competitions";
const request = (url: string, method: string, token: string, body?: unknown) =>
  new Request(url, { method, headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
const ctxOf = (competitionId: string) => ({ params: { competitionId } });

const ENV_KEYS = ["COMPETITIONS_SCHEMA_READY", "BECOME_A_HOST_SCHEMA_READY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY"] as const;
const originalEnv: Record<string, string | undefined> = {};

beforeAll(async () => {
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
  process.env.COMPETITIONS_SCHEMA_READY = "true";
  delete process.env.BECOME_A_HOST_SCHEMA_READY;
  process.env.SUPABASE_URL ??= supabaseUrl;
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= supabaseServiceRoleKey;
  process.env.SUPABASE_ANON_KEY ??= supabaseAnonKey;
  reviewer = await newPerson("Reviewer");
}, 180000);

// Evidence rows are append-only, so the owner removes them with row triggers off (replica role). Every statement runs on its own: one that cannot run must not stop the rest.
// Best effort beyond that: a database reset restores a clean state. The proposals' rows go FIRST (they reference the draw and the plan), then the draw's.
afterAll(async () => {
  if (competitionIds.length > 0) {
    const db = new Client({ connectionString: supabaseDbUrl, statement_timeout: 60000 });
    try {
      await db.connect();
      await db.query("set session_replication_role = replica");
      const ids = [competitionIds];
      const revs = "(select planning_revision_id from competition_planning_revisions where competition_id = any($1))";
      const fx = "(select competition_fixture_id from competition_fixtures where competition_id = any($1))";
      const statements = [
        "delete from competition_schedule_proposal_placements where competition_id = any($1)",
        "delete from competition_schedule_proposals where competition_id = any($1)",
        "delete from competition_draw_entries where competition_id = any($1)",
        "delete from competition_draws where competition_id = any($1)",
        "delete from competition_plan_change_resolutions where competition_id = any($1)",
        "delete from competition_plan_change_decisions where competition_id = any($1)",
        "delete from competition_plan_change_proposals where competition_id = any($1)",
        "delete from competition_registration_freeze_members where competition_id = any($1)",
        "delete from competition_registration_freeze_teams where competition_id = any($1)",
        "delete from competition_registration_freezes where competition_id = any($1)",
        `delete from competition_planning_windows where planning_revision_id in ${revs}`,
        `delete from competition_planning_dates where planning_revision_id in ${revs}`,
        `delete from competition_planning_pitch_formats where planning_pitch_id in (select planning_pitch_id from competition_planning_pitches where planning_revision_id in ${revs})`,
        `delete from competition_planning_pitches where planning_revision_id in ${revs}`,
        "delete from competition_planning_revisions where competition_id = any($1)",
        `delete from competition_roster_revision_entries where competition_roster_revision_id in (select competition_roster_revision_id from competition_roster_revisions where competition_fixture_id in ${fx})`,
        `delete from competition_roster_revisions where competition_fixture_id in ${fx}`,
        `delete from competition_checkins where competition_fixture_id in ${fx}`,
        `delete from competition_member_participation_records where competition_fixture_id in ${fx}`,
        "delete from competition_fixtures where competition_id = any($1)",
        "delete from competition_team_memberships where competition_id = any($1)",
        "delete from competition_join_requests where competition_id = any($1)",
        "delete from competition_registrations where competition_id = any($1)",
        "delete from competition_teams where competition_id = any($1)",
        "delete from competition_host_capabilities where competition_id = any($1)",
        "delete from competitions where competition_id = any($1)",
      ];
      for (const statement of statements) await db.query(statement, ids).catch(() => {});
    } catch {
      /* best effort */
    } finally {
      await db.end().catch(() => {});
    }
  }
  if (operators.length > 0) await service.from("authority_grants").delete().in("gaming_member_id", operators);
  if (reviewer) await service.from("authority_grants").delete().eq("gaming_member_id", reviewer.gamingMemberId);
  for (const id of authUsers) await service.auth.admin.deleteUser(id).catch(() => {});
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
}, 600000);

// =============================================================================================================================================
// Helpers of this gate
// =============================================================================================================================================

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
/** "A 1 09:00" = pitch A, plan date 1, venue-local 09:00, in the competition's own plan. */
function req(ctx: Ctx, a: string, b: string, c: string) {
  return [["SEMIFINAL_1", a], ["SEMIFINAL_2", b], ["FINAL", c]].map(([role, spec]) => {
    const [label, day, time] = spec.split(" ");
    return { fixtureRole: role, planningPitchId: ctx.pitch[label], planDate: ctx.dates[day], startTime: time };
  });
}
const snake = (placements: Array<{ fixtureRole: string; planningPitchId: string; planDate: string; startTime: string }>) =>
  placements.map((p) => ({ fixture_role: p.fixtureRole, planning_pitch_id: p.planningPitchId, plan_date: p.planDate, start_time: p.startTime }));
const CREATE_SQL = "select create_competition_schedule_proposal_atomically($1, $2, $3, $4::jsonb) as r";
const READ_SQL = "select get_competition_schedule_proposals($1, $2) as r";
const GOOD = (ctx: Ctx) => req(ctx, "A 1 09:00", "B 1 09:00", "A 1 10:08");

const propose = (ctx: Ctx, placements: ReturnType<typeof req>, intent: string = randomUUID(), caller: string = ctx.organizer.gamingMemberId) =>
  compRepo.createScheduleProposal(ctx.competitionId, caller, intent, placements as never);
const readProposals = (ctx: Ctx, memberId: string = ctx.organizer.gamingMemberId) => compRepo.getScheduleProposals(ctx.competitionId, memberId);
const rawCreate = (ctx: Ctx, instant: string, placements: unknown, intent: string | null = randomUUID(), caller: string | null = ctx.organizer.gamingMemberId) =>
  atInstant(instant, CREATE_SQL, [ctx.competitionId, caller, intent, JSON.stringify(placements)]);
const refusalCode = (outcome: Outcome): string => {
  if (outcome.ok) return "OK";
  const invalid = /SCHEDULE_PROPOSAL_INVALID: ([A-Z_]+):/.exec(outcome.message);
  if (invalid) return invalid[1];
  const typed = /(SCHEDULE_PROPOSAL_[A-Z_]+|COMPETITION_[A-Z_]+|HOST_ACCESS_REVOKED)/.exec(outcome.message);
  return typed ? typed[1] : `UNRECOGNISED: ${outcome.message}`;
};

const proposalRows = (competitionId: string) => rawQuery("select * from competition_schedule_proposals where competition_id = $1 order by sequence_number", [competitionId]);
const placementRows = (competitionId: string) => rawQuery("select * from competition_schedule_proposal_placements where competition_id = $1 order by schedule_proposal_id, fixture_role", [competitionId]);
const proposalCount = async (competitionId: string) => (await rawQuery("select (select count(*)::int from competition_schedule_proposals where competition_id = $1) as proposals, (select count(*)::int from competition_schedule_proposal_placements where competition_id = $1) as placements", [competitionId]))[0] as { proposals: number; placements: number };
const NO_PROPOSAL = { proposals: 0, placements: 0 };
const stateOf = async (competitionId: string) => (await rawQuery("select state, published_at from competitions where competition_id = $1", [competitionId]))[0] as { state: string; published_at: Date | null };
const fixtureCount = async (competitionId: string) => (await rawQuery("select count(*)::int n from competition_fixtures where competition_id = $1", [competitionId]))[0].n as number;

/** A hash of the proposals' own rows and their placements (the evidence, byte for byte): a retry or a later change elsewhere must leave it exactly as it was. */
async function proposalEvidenceHash(competitionId: string, upToSequence = 1_000_000): Promise<string> {
  const rows = await rawQuery(
    `select (select coalesce(jsonb_agg(to_jsonb(p) order by p.sequence_number), '[]') from competition_schedule_proposals p where p.competition_id = $1 and p.sequence_number <= $2) as proposals,
            (select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]') from competition_schedule_proposal_placements x
              where x.competition_id = $1 and x.schedule_proposal_id in (select schedule_proposal_id from competition_schedule_proposals where competition_id = $1 and sequence_number <= $2)) as placements`, [competitionId, upToSequence]);
  return sha(JSON.stringify(rows[0]));
}
async function drawEvidenceHash(competitionId: string): Promise<string> {
  const rows = await rawQuery(
    `select (select coalesce(jsonb_agg(to_jsonb(d) order by to_jsonb(d)::text), '[]') from competition_draws d where d.competition_id = $1) as draws,
            (select coalesce(jsonb_agg(to_jsonb(e) order by to_jsonb(e)::text), '[]') from competition_draw_entries e where e.competition_id = $1) as entries`, [competitionId]);
  return sha(JSON.stringify(rows[0]));
}
/**
 * A hash of EVERYTHING else a competition carries: the competition row, its teams, memberships, registrations, join requests, fixtures, the registration freeze, the draw, every
 * planning revision and child, every plan change (proposals, decisions, resolutions), and its host capability. A schedule proposal must leave all of it byte-identical.
 */
async function collateralHash(competitionId: string): Promise<string> {
  const agg = (table: string, key = "competition_id") => `(select coalesce(jsonb_agg(to_jsonb(x) order by to_jsonb(x)::text), '[]') from ${table} x where x.${key} = $1)`;
  const rows = await rawQuery(
    `select (select to_jsonb(c) from competitions c where c.competition_id = $1) as competition,
            ${agg("competition_teams")} as teams, ${agg("competition_team_memberships")} as memberships, ${agg("competition_registrations")} as registrations,
            ${agg("competition_join_requests")} as join_requests, ${agg("competition_fixtures")} as fixtures, ${agg("competition_registration_freezes")} as freezes,
            ${agg("competition_registration_freeze_teams")} as freeze_teams, ${agg("competition_registration_freeze_members")} as freeze_members,
            ${agg("competition_draws")} as draws, ${agg("competition_draw_entries")} as draw_entries,
            ${agg("competition_planning_revisions")} as revisions, ${agg("competition_plan_change_proposals")} as proposals, ${agg("competition_plan_change_decisions")} as decisions,
            ${agg("competition_plan_change_resolutions")} as resolutions, ${agg("competition_host_capabilities")} as hosts`, [competitionId]);
  return sha(JSON.stringify(rows[0]));
}

async function expectRejects<E extends Error>(promise: Promise<unknown>, type: new (...args: any[]) => E): Promise<E> {
  let caught: unknown = null;
  let resolved = false;
  try {
    await promise;
    resolved = true;
  } catch (err) {
    caught = err;
  }
  expect(resolved, `the call must be refused with ${type.name}, but it resolved`).toBe(false);
  expect(caught).toBeInstanceOf(type);
  return caught as E;
}

/** The request must be refused with the typed refusal carrying this stable code. */
async function expectRefusal(promise: Promise<unknown>, code: string) {
  let caught: unknown = null;
  let resolved = false;
  try {
    await promise;
    resolved = true;
  } catch (err) {
    caught = err;
  }
  expect(resolved, `the request must be refused with ${code}, but it succeeded`).toBe(false);
  const { ScheduleProposalError } = await loadSp();
  expect(caught, String((caught as Error)?.message)).toBeInstanceOf(ScheduleProposalError);
  expect((caught as { code: string }).code).toBe(code);
}
/** The request must be refused as an invalid schedule, with the stable code of the rule it breaks. */
async function expectInvalid(promise: Promise<unknown>, code: string) {
  let caught: unknown = null;
  try { await promise; } catch (err) { caught = err; }
  const { ScheduleProposalValidationError } = await loadSp();
  expect(caught, `the request must be refused as ${code}`).toBeInstanceOf(ScheduleProposalValidationError);
  expect((caught as { violations: Array<{ code: string }> }).violations.map((v) => v.code)).toEqual([code]);
}

/** Publishes the bracket the OLD way (the competition leaves READY_TO_PUBLISH and fixtures exist). */
const publishNow = (ctx: Ctx, order = [0, 1, 2, 3]) => publishCompetition(compRepo, ctx.competitionId, ctx.organizer.gamingMemberId, ctx.teams[order[0]].teamId, ctx.teams[order[1]].teamId, ctx.teams[order[2]].teamId, ctx.teams[order[3]].teamId,
  new Date(Date.now() + 3600_000).toISOString(), new Date(Date.now() + 7200_000).toISOString(), new Date(Date.now() + 10800_000).toISOString());

/** An amendable proposal (a plan change): a new venue, the same pitch labels, one new date. */
function amendmentFacts(name = `Amended Venue ${RUN}`) {
  return {
    venue: { name, locationDescription: "Calle 9, San José, behind the old market", restrictionNotes: "Lights off at 21:00.", simultaneousMatchCapacity: 2 },
    pitches: [{ label: "A", usable: true, supportedFormats: ALL4 as SoccerFormatKey[], restrictionNotes: "" }, { label: "B", usable: true, supportedFormats: ALL4 as SoccerFormatKey[], restrictionNotes: "" }],
    dates: [{ date: localDate(Date.now() + 7 * DAY), windows: [{ start: "09:00", end: "13:00" }] }],
  };
}
const proposeChange = (ctx: Ctx, f = amendmentFacts(), intent: string = randomUUID()) => compRepo.proposePlanAmendment(ctx.competitionId, ctx.organizer.gamingMemberId, intent, f);
const decideChange = (ctx: Ctx, team: number, digest: string, decision: "CONFIRMED" | "REJECTED") => compRepo.decidePlanAmendment(ctx.competitionId, ctx.teams[team].captain.gamingMemberId, digest, decision);
const withdrawChange = (ctx: Ctx, digest: string) => compRepo.withdrawPlanAmendment(ctx.competitionId, ctx.organizer.gamingMemberId, digest);
/** Service-side fixture (the database owner, row triggers off): moves a plan change's creation and expiry into the past, as if the time had really gone by. */
async function ageChange(digest: string, hours: number): Promise<void> {
  const db = new Client({ connectionString: supabaseDbUrl, statement_timeout: 60000 });
  await db.connect();
  try {
    await db.query("set session_replication_role = replica");
    await db.query("update competition_plan_change_proposals set created_at = created_at - ($2 || ' hours')::interval, expires_at = expires_at - ($2 || ' hours')::interval where amendment_digest = $1", [digest, String(hours)]);
  } finally { await db.end().catch(() => {}); }
}
async function activateChange(ctx: Ctx): Promise<void> {
  const p = await proposeChange(ctx);
  for (let i = 0; i < 4; i++) await decideChange(ctx, i, p.digest, "CONFIRMED");
}

// =============================================================================================================================================
// [fixture] control
// =============================================================================================================================================

describe("[fixture] a drawn competition can be built through the public lifecycle (this passes before the feature exists)", () => {
  it("READY_TO_PUBLISH, one freeze of four teams, one permanent draw of those four teams, a current plan with pitches, no fixture", async () => {
    const ctx = await live("Fixture");
    expect((await stateOf(ctx.competitionId)).state).toBe("READY_TO_PUBLISH");
    const frozenTeams = await rawQuery("select captain_gaming_member_id, position, competition_team_id from competition_registration_freeze_teams where competition_id = $1 order by position", [ctx.competitionId]);
    expect(frozenTeams).toHaveLength(4);
    const draws = await rawQuery("select competition_draw_id from competition_draws where competition_id = $1", [ctx.competitionId]);
    expect(draws).toHaveLength(1);
    expect(await rawQuery("select count(*)::int n from competition_draw_entries where competition_id = $1", [ctx.competitionId])).toEqual([{ n: 4 }]);
    expect(await fixtureCount(ctx.competitionId)).toBe(0);
    expect(Object.keys(ctx.pitch).sort()).toEqual(["A", "B", "C", "E", "F", "X"]);
    expect(Object.keys(ctx.dates).sort()).toEqual(["1", "2", "3"]);
    const plan = await rawQuery("select simultaneous_match_capacity, venue_time_zone from competition_planning_revisions where planning_revision_id = $1", [ctx.revisionId]);
    expect(plan).toEqual([{ simultaneous_match_capacity: 2, venue_time_zone: "America/Costa_Rica" }]);
    // the proposal catalog does not exist yet or is empty for this competition; either way the fixture never needed it
  }, 180000);

  it("the pinned fixtures exist on fixed dates with the oracle's pitches, and the New York fixtures on the two clock changes", async () => {
    const p = await pinned();
    expect(Object.values(p.dates).slice(0, 2)).toEqual(["2026-11-14", "2026-11-15"]);
    const fall = await nyFall();
    const spring = await nySpring();
    expect(fall.dates["1"]).toBe("2026-11-01");
    expect(spring.dates["1"]).toBe("2027-03-14");
    expect((await rawQuery("select venue_time_zone from competition_planning_revisions where planning_revision_id = $1", [fall.revisionId]))[0].venue_time_zone).toBe("America/New_York");
  }, 300000);
});

// =============================================================================================================================================
// [18] the data boundary
// =============================================================================================================================================

describe("[18] the data boundary: two server-only append-only tables, two service-role operations, internal helpers nobody can run", () => {
  it("the two tables exist with row-level security on, no policy and no privilege for anyone — not even the server role", async () => {
    const rows = await rawQuery(
      `select c.relname, c.relrowsecurity as rls, (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies,
              (select count(*)::int from information_schema.table_privileges tp where tp.table_schema = 'public' and tp.table_name = c.relname and tp.grantee in ('anon', 'authenticated', 'service_role', 'PUBLIC')) as grants,
              (select count(*)::int from pg_class k, aclexplode(coalesce(k.relacl, acldefault('r', k.relowner))) a where k.oid = c.oid and a.grantee = 0) as public_grants
         from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname = any($1) order by c.relname`, [[...TABLES]]);
    expect(rows.map((r) => r.relname)).toEqual([...TABLES]);
    for (const r of rows) expect({ table: r.relname, rls: r.rls, policies: r.policies, grants: r.grants, publicGrants: r.public_grants }).toEqual({ table: r.relname, rls: true, policies: 0, grants: 0, publicGrants: 0 });
    expect((await rawQuery("select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and relname like 'competition\\_schedule%' order by relname")).map((r) => r.relname)).toEqual([...TABLES]);
  });

  it("the migration adds exactly these functions: the two operations and the internal helpers — nothing else with 'schedule' in its name", async () => {
    const names = (await rawQuery("select p.proname from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname ~ 'schedule' order by p.proname")).map((r) => r.proname);
    expect(names).toEqual([...RPCS, ...HELPERS].sort());
  });

  it("each operation is SECURITY DEFINER with a pinned search_path and executable by the server role alone; every helper by nobody", async () => {
    const ops = await rawQuery(`select p.oid, p.proname, p.prosecdef, p.proconfig::text as cfg, pg_get_function_identity_arguments(p.oid) as args from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = any($1) order by p.proname`, [[...RPCS]]);
    expect(ops).toHaveLength(2);
    for (const op of ops) {
      expect(op.prosecdef, op.proname).toBe(true);
      expect(op.cfg, op.proname).toContain("search_path=public");
      for (const [role, expected] of [["anon", false], ["authenticated", false], ["service_role", true], ["public", false]] as const) {
        const has = (await rawQuery(`select has_function_privilege('${role}', $1::oid, 'EXECUTE') as has`, [op.oid]))[0].has as boolean;
        expect({ fn: op.proname, role, has }).toEqual({ fn: op.proname, role, has: expected });
      }
    }
    expect(ops.find((o) => o.proname === RPCS[0])!.args).toBe("p_competition_id uuid, p_organizer_gaming_member_id uuid, p_intent_id uuid, p_placements jsonb");
    expect(ops.find((o) => o.proname === RPCS[1])!.args).toBe("p_competition_id uuid, p_caller_gaming_member_id uuid");
    const helpers = await rawQuery(`select p.oid, p.proname from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = any($1)`, [[...HELPERS]]);
    expect(helpers).toHaveLength(HELPERS.length);
    for (const h of helpers) {
      for (const role of ["anon", "authenticated", "service_role", "public"]) {
        expect((await rawQuery(`select has_function_privilege('${role}', $1::oid, 'EXECUTE') as has`, [h.oid]))[0].has, `${h.proname} for ${role}`).toBe(false);
      }
    }
  });

  it("no browser role can read or write a proposal table through the API, with or without a signed-in user; the server role cannot write one directly either", async () => {
    // Not vacuous: an API refusal of a table that does not exist proves nothing, so the tables must be there, and closed to every role, in the catalog itself.
    const present = await rawQuery(
      `select c.relname, has_table_privilege('anon', c.oid, 'select, insert, update, delete, truncate') as anon_any, has_table_privilege('authenticated', c.oid, 'select, insert, update, delete, truncate') as auth_any,
              has_table_privilege('service_role', c.oid, 'select, insert, update, delete, truncate') as service_any
         from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname = any($1) and c.relkind = 'r' order by c.relname`, [[...TABLES]]);
    expect(present.map((r) => [r.relname, r.anon_any, r.auth_any, r.service_any])).toEqual(TABLES.map((t) => [t, false, false, false]));
    const member = await newPerson("Browser Caller");
    const userClient = createClient(supabaseUrl, supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { authorization: `Bearer ${await tokenFor(member)}` } } });
    const row = { competition_id: randomUUID(), sequence_number: 1 };
    for (const table of TABLES) {
      for (const [who, client] of [["anon", anon], ["authenticated", userClient], ["service_role", service]] as const) {
        const select = await client.from(table).select("*").limit(1);
        expect(select.error, `${who} select ${table}`).not.toBeNull();
        const insert = await client.from(table).insert(row);
        expect(insert.error, `${who} insert ${table}`).not.toBeNull();
        const update = await client.from(table).update({ sequence_number: 9 }).eq("competition_id", row.competition_id);
        expect(update.error, `${who} update ${table}`).not.toBeNull();
        const del = await client.from(table).delete().eq("competition_id", row.competition_id);
        expect(del.error, `${who} delete ${table}`).not.toBeNull();
      }
    }
    // and neither operation is callable by a browser role (the answer carries no database words)
    for (const [who, client] of [["anon", anon], ["authenticated", userClient]] as const) {
      const create = await client.rpc(RPCS[0], { p_competition_id: randomUUID(), p_organizer_gaming_member_id: member.gamingMemberId, p_intent_id: randomUUID(), p_placements: [] });
      expect(create.error, `${who} create`).not.toBeNull();
      const readCall = await client.rpc(RPCS[1], { p_competition_id: randomUUID(), p_caller_gaming_member_id: member.gamingMemberId });
      expect(readCall.error, `${who} read`).not.toBeNull();
    }
    for (const helper of ["competition_schedule_evaluate", "competition_schedule_timing", "competition_schedule_eligibility_problem"]) {
      expect((await service.rpc(helper, {})).error, `service_role ${helper}`).not.toBeNull();
    }
  }, 120000);

  it("a recorded proposal and its placements are immutable even to the database owner: UPDATE, DELETE and TRUNCATE are refused", async () => {
    const ctx = await live("Immutable");
    await propose(ctx, GOOD(ctx));
    const [proposal] = await proposalRows(ctx.competitionId);
    const before = await proposalEvidenceHash(ctx.competitionId);
    const attempts: Array<[string, string, unknown[]]> = [
      ["update a proposal", "update competition_schedule_proposals set sequence_number = sequence_number where schedule_proposal_id = $1", [proposal.schedule_proposal_id]],
      ["update a proposal's digest", "update competition_schedule_proposals set proposal_digest = repeat('a', 64) where schedule_proposal_id = $1", [proposal.schedule_proposal_id]],
      ["delete a proposal", "delete from competition_schedule_proposals where schedule_proposal_id = $1", [proposal.schedule_proposal_id]],
      ["update a placement", "update competition_schedule_proposal_placements set start_time = '10:00' where schedule_proposal_id = $1", [proposal.schedule_proposal_id]],
      ["move a placement's pitch", "update competition_schedule_proposal_placements set planning_pitch_id = planning_pitch_id where schedule_proposal_id = $1", [proposal.schedule_proposal_id]],
      ["delete a placement", "delete from competition_schedule_proposal_placements where schedule_proposal_id = $1", [proposal.schedule_proposal_id]],
      ["truncate the placements", "truncate competition_schedule_proposal_placements", []],
      ["truncate the proposals", "truncate competition_schedule_proposals", []],
      ["truncate both, cascading", "truncate competition_schedule_proposals, competition_schedule_proposal_placements cascade", []],
    ];
    for (const [label, sql, params] of attempts) {
      const out = await violationOf(async (db) => { await db.query(sql, params); });
      expect(out, label).not.toBeNull();
      // The trigger refuses every one; truncating the proposals ALONE is refused even earlier, by Postgres itself, because the placements reference them.
      expect(out!.message, label).toMatch(/SCHEDULE_PROPOSAL_IMMUTABLE|cannot truncate a table referenced in a foreign key constraint/);
    }
    expect(await proposalEvidenceHash(ctx.competitionId)).toBe(before);
  }, 180000);
});

// =============================================================================================================================================
// [1][2] the request, at the database
// =============================================================================================================================================

describe("[1][2] the database takes exactly an intent and three placements — whatever sent them", () => {
  it("[1] an unknown field, a missing or duplicate or invalid role, a wrong count and malformed values are each refused with their own code, and nothing is written", async () => {
    const ctx = await pinned();
    const good = snake(GOOD(ctx));
    const NOW_ = PINNED_NOW;
    const cases: Array<[string, unknown, string]> = [
      ["no placements at all", null, "PLACEMENTS_INVALID"], ["an object instead of a list", {}, "PLACEMENTS_INVALID"], ["a string", "x", "PLACEMENTS_INVALID"], ["an empty list", [], "PLACEMENTS_INVALID"],
      ["two placements", good.slice(0, 2), "PLACEMENTS_INVALID"], ["four placements", [...good, good[0]], "PLACEMENTS_INVALID"],
      ["a placement that is not an object", [1, good[1], good[2]], "PLACEMENT_NOT_OBJECT"],
      ["an extra field (an end instant)", [{ ...good[0], start_utc: "2026-11-14T15:00:00Z" }, good[1], good[2]], "UNKNOWN_FIELD"],
      ["an extra field (a time zone)", [good[0], { ...good[1], time_zone: "America/New_York" }, good[2]], "UNKNOWN_FIELD"],
      ["an extra field (a team)", [good[0], good[1], { ...good[2], team_a_id: randomUUID() }], "UNKNOWN_FIELD"],
      ["an extra field (a capacity)", [{ ...good[0], capacity: 9 }, good[1], good[2]], "UNKNOWN_FIELD"],
      ["a duplicate role", [good[0], { ...good[1], fixture_role: "SEMIFINAL_1" }, good[2]], "ROLE_DUPLICATE"],
      ["an unknown role", [{ ...good[0], fixture_role: "THIRD_PLACE" }, good[1], good[2]], "ROLE_INVALID"],
      ["a role in lowercase", [{ ...good[0], fixture_role: "final" }, good[1], good[2]], "ROLE_INVALID"],
      ["a missing role field", [{ planning_pitch_id: good[0].planning_pitch_id, plan_date: good[0].plan_date, start_time: good[0].start_time }, good[1], good[2]], "ROLE_INVALID"],
      ["a pitch that is not a UUID", [{ ...good[0], planning_pitch_id: "A" }, good[1], good[2]], "PITCH_INVALID"],
      ["a missing pitch", [{ fixture_role: "SEMIFINAL_1", plan_date: good[0].plan_date, start_time: good[0].start_time }, good[1], good[2]], "PITCH_INVALID"],
      ["a date that is not a real day", [{ ...good[0], plan_date: "2026-02-30" }, good[1], good[2]], "DATE_INVALID"], ["a date with a time", [{ ...good[0], plan_date: "2026-11-14T09:00" }, good[1], good[2]], "DATE_INVALID"],
      ["a time that is not HH:MM", [{ ...good[0], start_time: "9:00" }, good[1], good[2]], "TIME_INVALID"], ["a time with seconds", [{ ...good[0], start_time: "09:00:00" }, good[1], good[2]], "TIME_INVALID"],
      ["a time of 24:00", [{ ...good[0], start_time: "24:00" }, good[1], good[2]], "TIME_INVALID"], ["a numeric time", [{ ...good[0], start_time: 900 }, good[1], good[2]], "TIME_INVALID"],
    ];
    for (const [label, placements, code] of cases) {
      expect(refusalCode(await rawCreate(ctx, NOW_, placements)), label).toBe(code);
    }
    const noIntent = await rawCreate(ctx, NOW_, good, null);
    expect(refusalCode(noIntent)).toBe("INTENT_INVALID");
    expect(await proposalCount(ctx.competitionId)).toEqual(NO_PROPOSAL);
  }, 180000);

  it("[2] the same refusals through the application's own parser, which names the fields a client must never send", async () => {
    const ctx = await pinned();
    const { parseScheduleProposalRequest, ScheduleProposalValidationError } = await loadSp();
    const body = { intentId: randomUUID(), placements: GOOD(ctx) };
    expect(parseScheduleProposalRequest(body).placements).toHaveLength(3);
    for (const field of ["teams", "startUtc", "timeZone", "durationMinutes", "capacity", "format", "organizerGamingMemberId", "fixtureId"]) {
      expect(() => parseScheduleProposalRequest({ ...body, [field]: "x" }), field).toThrow(ScheduleProposalValidationError);
    }
    expect(await proposalCount(ctx.competitionId)).toEqual(NO_PROPOSAL);
  });
});

// =============================================================================================================================================
// [3][4] authority
// =============================================================================================================================================

describe("[3][4] only the competition's own ACTIVE organizer may create or read a proposal", () => {
  it("[3] the organizer proposes; the proposal is recorded as theirs, against the plan revision and the draw the server found", async () => {
    const ctx = await live("Organizer");
    const result = await propose(ctx, GOOD(ctx));
    expect(result.alreadyProposed).toBe(false);
    expect(result.proposal.sequenceNumber).toBe(1);
    const [row] = await proposalRows(ctx.competitionId);
    expect(row.proposed_by_gaming_member_id).toBe(ctx.organizer.gamingMemberId);
    expect(row.planning_revision_id).toBe(ctx.revisionId);
    const [draw] = await rawQuery("select competition_draw_id, draw_digest from competition_draws where competition_id = $1", [ctx.competitionId]);
    expect(row.competition_draw_id).toBe(draw.competition_draw_id);
    expect(row.draw_digest).toBe(draw.draw_digest);
    expect(row.format_key).toBe("SOCCER_5V5");
    expect(row.time_zone).toBe("America/Costa_Rica");
    expect(row.simultaneous_match_capacity).toBe(2);
    expect([row.occupancy_minutes, row.pitch_transition_minutes, row.minimum_team_rest_minutes]).toEqual([38, 10, 30]);
  }, 180000);

  it("[4] a frozen captain, a player, a registrant, a member holding only OPERATIONAL authority, another competition's organizer and an unknown member are all refused, and nothing is written", async () => {
    const ctx = await live("Authority");
    const other = await live("Authority Other");
    const operational = await makeOperator("Operational Only");
    const registrant = await newPerson("Registrant");
    const before = await collateralHash(ctx.competitionId);
    const callers: Array<[string, string]> = [
      ["a frozen captain", ctx.teams[0].captain.gamingMemberId], ["another frozen captain", ctx.teams[3].captain.gamingMemberId], ["a player on a team", ctx.teams[1].members[0]],
      ["a member holding only OPERATIONAL authority", operational.gamingMemberId], ["a member with no role", registrant.gamingMemberId],
      ["another competition's organizer", other.organizer.gamingMemberId], ["an unknown member", randomUUID()],
    ];
    for (const [label, caller] of callers) {
      await expectRejects(propose(ctx, GOOD(ctx), randomUUID(), caller), CompetitionAccessDeniedError).then(() => undefined, (e) => { throw new Error(`${label}: ${e.message}`); });
    }
    expect(await proposalCount(ctx.competitionId)).toEqual(NO_PROPOSAL);
    expect(await collateralHash(ctx.competitionId)).toBe(before);
    // A missing caller (SQL NULL) is refused too — never skipped (the comparison is null-safe).
    const nullCaller = await rawCreate(ctx, new Date().toISOString(), snake(GOOD(ctx)), randomUUID(), null);
    expect(refusalCode(nullCaller)).toBe("COMPETITION_ACCESS_DENIED");
  }, 300000);

  it("an unknown competition is refused as not found", async () => {
    const ctx = await live("Unknown");
    await expectRejects(compRepo.createScheduleProposal(randomUUID(), ctx.organizer.gamingMemberId, randomUUID(), GOOD(ctx) as never), CompetitionNotFoundError);
  }, 120000);

  it("[4] a scorekeeper of the competition's own fixtures has no authority either (and reads nothing)", async () => {
    const ctx = await live("Scorekeeper");
    await publishNow(ctx); // the OLD publication path, only to create fixtures a scorekeeper can be appointed to
    const fixtures = await compRepo.getCompetitionFixtures(ctx.competitionId);
    const scorekeeper = pool[POOL_SIZE - 5];
    await appointScorekeeper(compRepo, fixtures.find((f) => f.fixtureRole === "SEMIFINAL_1")!.competitionFixtureId, ctx.organizer.gamingMemberId, scorekeeper.gamingMemberId);
    await expectRejects(propose(ctx, GOOD(ctx), randomUUID(), scorekeeper.gamingMemberId), CompetitionAccessDeniedError);
    expect(await readProposals(ctx, scorekeeper.gamingMemberId)).toBeNull();
    expect(await proposalCount(ctx.competitionId)).toEqual(NO_PROPOSAL);
  }, 300000);

  it("[3] a REVOKED host organizer is refused (and the replay of their own earlier proposal too), reads nothing, and nothing is changed", async () => {
    const { ctx, pilot } = await drawnPilot("Revoked Host");
    const first = await propose(ctx, GOOD(ctx), randomUUID(), pilot.host.gamingMemberId); // active: allowed
    const intent = (await proposalRows(ctx.competitionId))[0].intent_id as string;
    const evidence = await proposalEvidenceHash(ctx.competitionId);
    expect(first.alreadyProposed).toBe(false);
    await pilot.revoke();
    await expectRejects(propose(ctx, GOOD(ctx), randomUUID(), pilot.host.gamingMemberId), HostAccessRevokedError);
    await expectRejects(propose(ctx, GOOD(ctx), intent, pilot.host.gamingMemberId), HostAccessRevokedError); // authority before replay
    expect(await readProposals(ctx, pilot.host.gamingMemberId)).toBeNull();
    expect(await proposalEvidenceHash(ctx.competitionId)).toBe(evidence);
  }, 300000);

  it("[3] a host revoked BEFORE the first proposal can never make one: refused, nothing written", async () => {
    const { ctx, pilot } = await drawnPilot("Revoked Before");
    await pilot.revoke();
    await expectRejects(propose(ctx, GOOD(ctx), randomUUID(), pilot.host.gamingMemberId), HostAccessRevokedError);
    expect(await proposalCount(ctx.competitionId)).toEqual(NO_PROPOSAL);
  }, 300000);

  it("[22] only the active organizer reads: everyone else, a missing caller and an unknown competition get SQL NULL — the same answer", async () => {
    const ctx = await live("Read");
    await propose(ctx, GOOD(ctx));
    const operational = await makeOperator("Read Operational");
    const outsider = await newPerson("Read Outsider");
    for (const [label, who] of [["a frozen captain", ctx.teams[0].captain.gamingMemberId], ["a player", ctx.teams[2].members[0]], ["an operational-only member", operational.gamingMemberId],
      ["a member with no role", outsider.gamingMemberId], ["an unknown member", randomUUID()]] as const) {
      expect(await readProposals(ctx, who), label).toBeNull();
    }
    const nullCaller = await atInstant(new Date().toISOString(), READ_SQL, [ctx.competitionId, null]);
    expect(nullCaller.ok).toBe(true);
    expect((nullCaller as { rows: any[] }).rows[0].r).toBeNull();
    expect(await compRepo.getScheduleProposals(randomUUID(), ctx.organizer.gamingMemberId)).toBeNull();
    expect(await readProposals(ctx)).not.toBeNull();
  }, 240000);
});

// =============================================================================================================================================
// [5][6] the lifecycle
// =============================================================================================================================================

describe("[5][6] a proposal needs READY_TO_PUBLISH, a consistent freeze, the one permanent draw, the current accepted plan, no pending plan change and no fixture", () => {
  it("[5] no draw: a frozen competition that was never drawn refuses with DRAW_REQUIRED", async () => {
    const ctx = await frozenOn("No Draw", liveSpec(2));
    await expectRefusal(propose(ctx, GOOD(ctx)), "DRAW_REQUIRED");
    expect(await proposalCount(ctx.competitionId)).toEqual(NO_PROPOSAL);
  }, 180000);

  it("[5] no freeze: a READY_TO_PUBLISH competition without a freeze (a state no public path reaches) refuses with FREEZE_REQUIRED", async () => {
    const ctx = await live("No Freeze");
    const out = await rawTransaction(async (db) => {
      await db.query("set session_replication_role = replica");
      for (const t of ["competition_draw_entries", "competition_draws", "competition_registration_freeze_members", "competition_registration_freeze_teams", "competition_registration_freezes"]) await db.query(`delete from ${t} where competition_id = $1`, [ctx.competitionId]);
      await db.query("set session_replication_role = origin");
      return db.query(CREATE_SQL, [ctx.competitionId, ctx.organizer.gamingMemberId, randomUUID(), JSON.stringify(snake(GOOD(ctx)))]).then(() => "created", (e: Error) => e.message);
    });
    expect(out).toMatch(/SCHEDULE_PROPOSAL_FREEZE_REQUIRED/);
    expect((await stateOf(ctx.competitionId)).state).toBe("READY_TO_PUBLISH");
  }, 180000);

  it("[5] no accepted plan: a frozen, drawn competition whose plan revisions are gone refuses with PLAN_REQUIRED (a state no public path reaches)", async () => {
    const ctx = await live("No Plan");
    const out = await rawTransaction(async (db) => {
      await db.query("set session_replication_role = replica");
      const revs = "(select planning_revision_id from competition_planning_revisions where competition_id = $1)";
      await db.query(`delete from competition_planning_windows where planning_revision_id in ${revs}`, [ctx.competitionId]);
      await db.query(`delete from competition_planning_dates where planning_revision_id in ${revs}`, [ctx.competitionId]);
      await db.query(`delete from competition_planning_pitch_formats where planning_pitch_id in (select planning_pitch_id from competition_planning_pitches where planning_revision_id in ${revs})`, [ctx.competitionId]);
      await db.query(`delete from competition_planning_pitches where planning_revision_id in ${revs}`, [ctx.competitionId]);
      await db.query("delete from competition_planning_revisions where competition_id = $1", [ctx.competitionId]);
      await db.query("set session_replication_role = origin");
      return db.query(CREATE_SQL, [ctx.competitionId, ctx.organizer.gamingMemberId, randomUUID(), JSON.stringify(snake(GOOD(ctx)))]).then(() => "created", (e: Error) => e.message);
    });
    expect(out).toMatch(/SCHEDULE_PROPOSAL_PLAN_REQUIRED/);
  }, 180000);

  it("a draft, an open competition, a published one, a cancelled one, a completed one and one with a fixture already present are refused as the wrong state", async () => {
    const wellFormed = () => [
      { fixtureRole: "SEMIFINAL_1", planningPitchId: randomUUID(), planDate: "2026-12-01", startTime: "09:00" }, { fixtureRole: "SEMIFINAL_2", planningPitchId: randomUUID(), planDate: "2026-12-01", startTime: "09:00" },
      { fixtureRole: "FINAL", planningPitchId: randomUUID(), planDate: "2026-12-01", startTime: "10:08" }];
    const draft = await setUp("Draft Competition", { open: false });
    await expectRefusal(compRepo.createScheduleProposal(draft.competitionId, draft.organizer.gamingMemberId, randomUUID(), wellFormed() as never), "WRONG_STATE");
    const open = await setUp("Open Competition");
    await expectRefusal(compRepo.createScheduleProposal(open.competitionId, open.organizer.gamingMemberId, randomUUID(), wellFormed() as never), "WRONG_STATE");
    const published = await live("Published");
    await publishNow(published);
    await expectRefusal(propose(published, GOOD(published)), "WRONG_STATE");
    const cancelled = await live("Cancelled");
    await cancelCompetition(compRepo, cancelled.competitionId, cancelled.organizer.gamingMemberId, "Closed before the schedule was proposed.");
    await expectRefusal(propose(cancelled, GOOD(cancelled)), "WRONG_STATE");
    const complete = await live("Complete");
    await rawQuery("update competitions set state = 'COMPLETE' where competition_id = $1", [complete.competitionId]); // service-side fixture
    await expectRefusal(propose(complete, GOOD(complete)), "WRONG_STATE");
    const fixture = await live("Stray Fixture");
    await rawQuery( // service-side fixture: a fixture in a READY competition, which no public path can create
      "insert into competition_fixtures (competition_id, fixture_role, scheduled_at, team_a_competition_team_id, team_b_competition_team_id) values ($1, 'SEMIFINAL_1', now() + interval '1 day', $2, $3)",
      [fixture.competitionId, fixture.teams[0].teamId, fixture.teams[1].teamId]);
    await expectRefusal(propose(fixture, GOOD(fixture)), "WRONG_STATE");
    for (const c of [draft, open, published, cancelled, complete, fixture]) expect(await proposalCount(c.competitionId), c.competitionId).toEqual(NO_PROPOSAL);
  }, 420000);

  it("the freeze is judged in both directions: the live competition drifting from the freeze, and a plan that no longer carries what the freeze recorded, each refuse with FREEZE_INCONSISTENT", async () => {
    const member = await live("Drift Member");
    await rawQuery("insert into competition_team_memberships (competition_id, competition_team_id, gaming_member_id, approved_by_gaming_member_id) values ($1, $2, $3, $4)",
      [member.competitionId, member.teams[0].teamId, pool[POOL_SIZE - 1].gamingMemberId, member.organizer.gamingMemberId]);
    await expectRefusal(propose(member, GOOD(member)), "FREEZE_INCONSISTENT");
    const plan = await live("Plan Drift");
    await rawTransaction(async (db) => {
      // service-side fixture: a later revision with other roster bounds (what a plan change can never do)
      const cur = (await db.query("select * from competition_planning_revisions where competition_id = $1 order by revision_number desc limit 1", [plan.competitionId])).rows[0];
      await db.query(
        `insert into competition_planning_revisions (competition_id, format_key, revision_number, supersedes_revision_id, authored_by_gaming_member_id, intent_id, payload_digest, venue_name, venue_location_description,
           venue_time_zone, simultaneous_match_capacity, venue_restriction_notes, roster_minimum, roster_maximum, registration_deadline_local, registration_deadline_time_zone, registration_deadline_utc_offset_minutes,
           registration_deadline_utc, rules_version, rules_snapshot, rules_snapshot_digest)
         values ($1,$2,$3,$4,$5,gen_random_uuid(),$6,$7,$8,$9,$10,$11,6,$12,$13,$14,$15,$16,$17,$18,$19)`,
        [plan.competitionId, cur.format_key, cur.revision_number + 1, cur.planning_revision_id, cur.authored_by_gaming_member_id, cur.payload_digest, cur.venue_name, cur.venue_location_description, cur.venue_time_zone,
          cur.simultaneous_match_capacity, cur.venue_restriction_notes, cur.roster_maximum, cur.registration_deadline_local, cur.registration_deadline_time_zone, cur.registration_deadline_utc_offset_minutes,
          cur.registration_deadline_utc, cur.rules_version, cur.rules_snapshot, cur.rules_snapshot_digest]);
      await db.query("commit");
    });
    await expectRefusal(propose(plan, GOOD(plan)), "FREEZE_INCONSISTENT");
  }, 300000);

  it("a draw whose evidence no longer reproduces itself cannot be built on: the proposal is refused and nothing is written", async () => {
    const ctx = await live("Tampered Draw");
    const out = await rawTransaction(async (db) => {
      await db.query("set session_replication_role = replica");
      await db.query("update competition_draws set seed = repeat('0', 64) where competition_id = $1", [ctx.competitionId]);
      await db.query("set session_replication_role = origin");
      return db.query(CREATE_SQL, [ctx.competitionId, ctx.organizer.gamingMemberId, randomUUID(), JSON.stringify(snake(GOOD(ctx)))]).then(() => "created", (e: Error) => e.message);
    });
    expect(out).toMatch(/COMPETITION_DRAW_INVALID/);
  }, 180000);

  it("[6] a PENDING plan change refuses with AMENDMENT_PENDING; a rejected, a withdrawn, an expired and an activated one do not block", async () => {
    const pending = await live("Pending Change");
    const p = await proposeChange(pending);
    await expectRefusal(propose(pending, GOOD(pending)), "AMENDMENT_PENDING");
    expect(await proposalCount(pending.competitionId)).toEqual(NO_PROPOSAL);
    await withdrawChange(pending, p.digest);
    expect((await propose(pending, GOOD(pending))).proposal.sequenceNumber).toBe(1);

    const rejected = await live("Rejected Change");
    const r = await proposeChange(rejected);
    await decideChange(rejected, 0, r.digest, "REJECTED");
    expect((await propose(rejected, GOOD(rejected))).alreadyProposed).toBe(false);

    const expired = await live("Expired Change");
    const e = await proposeChange(expired);
    await expectRefusal(propose(expired, GOOD(expired)), "AMENDMENT_PENDING");
    await ageChange(e.digest, 30);
    expect((await propose(expired, GOOD(expired))).proposal.sequenceNumber).toBe(1);

    const activated = await live("Activated Change");
    await activateChange(activated);
    const ids = await pitchIds(activated.competitionId);
    const after = { ...activated, ...ids };
    expect(ids.revisionId).not.toBe(activated.revisionId);
    expect((await propose(after, req(after, "A 1 09:00", "B 1 09:00", "A 1 10:08"))).proposal.planningRevisionNumber).toBe(3);
  }, 600000);

  it("the refusals are decided in a fixed order — the wrong state, then the freeze, then the draw, then a pending plan change — and each is atomic (nothing is written)", async () => {
    const pendingAndPublished = await live("Order Published");
    await proposeChange(pendingAndPublished);
    await rawQuery("update competitions set state = 'COMPLETE' where competition_id = $1", [pendingAndPublished.competitionId]);
    await expectRefusal(propose(pendingAndPublished, GOOD(pendingAndPublished)), "WRONG_STATE"); // complete AND pending: the state is judged first
    const undrawnAndPending = await frozenOn("Order Undrawn", liveSpec(2));
    await proposeChange(undrawnAndPending);
    await expectRefusal(propose(undrawnAndPending, GOOD(undrawnAndPending)), "DRAW_REQUIRED"); // undrawn AND pending: the draw is judged first
    for (const c of [pendingAndPublished, undrawnAndPending]) expect(await proposalCount(c.competitionId)).toEqual(NO_PROPOSAL);
  }, 420000);
});

// =============================================================================================================================================
// [7] the binding to the plan revision and the draw
// =============================================================================================================================================

describe("[7] a proposal is bound to the plan revision and the draw the server used — and says when it is no longer current", () => {
  it("stores the revision, the draw and the draw's digest, derives the pairing from the draw, and reads back as CURRENT with both facts true", async () => {
    const ctx = await live("Binding");
    const { proposal } = await propose(ctx, GOOD(ctx));
    expect(proposal.status).toBe("CURRENT");
    expect([proposal.planningRevisionCurrent, proposal.drawDigestMatches]).toEqual([true, true]);
    const draw = await compRepo.getCompetitionDraw(ctx.competitionId, ctx.organizer.gamingMemberId);
    expect(proposal.drawDigest).toBe(draw!.draw!.drawDigest);
    const [sf1, sf2, final] = proposal.placements;
    // positions 1-2 are Semifinal 1 (position 1 is team A), positions 3-4 Semifinal 2; the final names no team: its finalists are not known
    expect([sf1.teamA!.teamId, sf1.teamB!.teamId, sf2.teamA!.teamId, sf2.teamB!.teamId]).toEqual(draw!.draw!.order.map((t) => t.teamId));
    expect([sf1.teamA!.teamName, sf2.teamB!.teamName]).toEqual([draw!.draw!.order[0].teamName, draw!.draw!.order[3].teamName]);
    expect([final.teamA, final.teamB]).toEqual([null, null]);
    const read = await readProposals(ctx);
    expect(read!.proposal).toEqual(proposal);
    expect(read!.history.map((h) => [h.sequenceNumber, h.status])).toEqual([[1, "CURRENT"]]);
    expect(read!.context!.planningRevisionNumber).toBe(proposal.planningRevisionNumber);
  }, 180000);

  it("the read's context is exactly the plan the proposal is judged against: the pitches with their identifiers, the dates and windows, the zone, the capacity and the registry timing", async () => {
    const ctx = await live("Context");
    const read = await readProposals(ctx);
    expect(read!.proposal).toBeNull();
    expect(read!.history).toEqual([]);
    const c = read!.context!;
    expect(c.formatKey).toBe("SOCCER_5V5");
    expect(c.timeZone).toBe("America/Costa_Rica");
    expect(c.simultaneousMatchCapacity).toBe(2);
    expect(c.timing).toEqual({ occupancyMinutes: 38, pitchTransitionMinutes: 10, minimumTeamRestMinutes: 30 });
    expect(c.pitches.map((p) => [p.label, p.usable, p.supportedFormats])).toEqual([
      ["A", true, ALL4], ["B", true, ALL4], ["C", true, ["SOCCER_5V5"]], ["E", false, ["SOCCER_5V5"]], ["F", true, ["SOCCER_6V6"]],
    ]);
    for (const p of c.pitches) expect(p.planningPitchId).toBe(ctx.pitch[p.label]);
    expect(c.dates).toEqual([
      { date: ctx.dates["1"], windows: [{ start: "09:00", end: "12:00" }, { start: "13:00", end: "16:00" }] },
      { date: ctx.dates["2"], windows: [{ start: "09:00", end: "10:00" }, { start: "10:05", end: "12:00" }] },
    ]);
  }, 180000);

  it("a draw whose digest no longer equals the one the proposal was made on reads the proposal as STALE — the binding is judged at every read (service-side tamper, restored)", async () => {
    const ctx = await live("Draw Digest Binding");
    const first = await propose(ctx, GOOD(ctx));
    const [draw] = await rawQuery("select competition_draw_id, draw_digest from competition_draws where competition_id = $1", [ctx.competitionId]);
    const setDigest = async (digest: string) => {
      const db = new Client({ connectionString: supabaseDbUrl, statement_timeout: 60000 });
      await db.connect();
      try {
        await db.query("set session_replication_role = replica"); // the draw is append-only: only the owner, with row triggers off, can forge this
        await db.query("update competition_draws set draw_digest = $2 where competition_draw_id = $1", [draw.competition_draw_id, digest]);
      } finally { await db.end().catch(() => {}); }
    };
    await setDigest(sha("a different draw"));
    try {
      const read = (await readProposals(ctx))!;
      expect(read.proposal!.status).toBe("STALE");
      expect([read.proposal!.planningRevisionCurrent, read.proposal!.drawDigestMatches]).toEqual([true, false]);
      expect(read.proposal!.proposalDigest).toBe(first.proposal.proposalDigest);
      expect(read.history.map((h) => [h.sequenceNumber, h.status])).toEqual([[1, "STALE"]]);
    } finally {
      await setDigest(draw.draw_digest);
    }
    const restored = (await readProposals(ctx))!;
    expect([restored.proposal!.status, restored.proposal!.drawDigestMatches]).toEqual(["CURRENT", true]);
  }, 240000);

  it("a pitch of ANOTHER revision of the same competition, or of another competition, is not in the plan the proposal is judged against", async () => {
    const ctx = await live("Foreign Pitches");
    const other = await live("Foreign Other");
    await expectInvalid(propose(ctx, req({ ...ctx, pitch: { ...ctx.pitch, A: other.pitch.A } }, "A 1 09:00", "B 1 09:00", "A 1 10:08")), "PITCH_NOT_IN_PLAN");
    await expectInvalid(propose(ctx, req({ ...ctx, pitch: { ...ctx.pitch, A: randomUUID() } }, "A 1 09:00", "B 1 09:00", "A 1 10:08")), "PITCH_NOT_IN_PLAN");
    expect(await proposalCount(ctx.competitionId)).toEqual(NO_PROPOSAL);
  }, 240000);
});

// =============================================================================================================================================
// [8]-[12] the scheduling matrix
// =============================================================================================================================================

describe("[8][9][10][11][12] one complete schedule is judged by every rule, and the database agrees with the independent oracle on every row", () => {
  it.each(CR_MATRIX)("%s", async (_name, a, b, c, expected, nowIso) => {
    const ctx = await pinned();
    const out = await rawCreate(ctx, nowIso ?? PINNED_NOW, snake(req(ctx, a, b, c)));
    expect(refusalCode(out)).toBe(expected);
    if (expected !== "OK" || !out.ok) return;
    const result = out.rows[0].r as { already_proposed: boolean; proposal: any };
    expect(result.already_proposed).toBe(false);
    const specs = [a, b, c].map((s) => s.split(" "));
    result.proposal.placements.forEach((p: any, i: number) => {
      const [label, day, time] = specs[i];
      const start = crInstant(day, time);
      expect(p.fixture_role).toBe(["SEMIFINAL_1", "SEMIFINAL_2", "FINAL"][i]);
      expect(p.planning_pitch_id).toBe(ctx.pitch[label]);
      expect(p.start_time).toBe(time); // never silently altered
      expect(p.start_utc).toBe(start);
      expect(p.end_utc).toBe(new Date(Date.parse(start) + 38 * 60_000).toISOString());
      expect([p.window_start_utc, p.window_end_utc]).toEqual(crWindow(day, time));
    });
  }, 60000);

  it("a refused row writes nothing and an accepted row, decided in a transaction that is always rolled back, leaves nothing behind", async () => {
    const ctx = await pinned();
    expect(await proposalCount(ctx.competitionId)).toEqual(NO_PROPOSAL);
    expect(await fixtureCount(ctx.competitionId)).toBe(0);
  });

  it("every accepted row verifies in the application too: the stored evidence reproduces itself (digest, derived instants, every rule)", async () => {
    const ctx = await pinned();
    const { scheduleProposalRecordFromDatabase, verifyScheduleProposal, computeScheduleProposalDigest, computeScheduleRequestDigest } = await loadSp();
    for (const [name, a, b, c, expected, nowIso] of CR_MATRIX.filter((r) => r[4] === "OK")) {
      const intent = randomUUID();
      const placements = req(ctx, a, b, c);
      const out = await atInstant(nowIso ?? PINNED_NOW, CREATE_SQL, [ctx.competitionId, ctx.organizer.gamingMemberId, intent, JSON.stringify(snake(placements))]);
      expect(out.ok, name).toBe(true);
      const record = scheduleProposalRecordFromDatabase((out as { rows: any[] }).rows[0].r.proposal);
      expect(verifyScheduleProposal(ctx.competitionId, record), name).toEqual({ ok: true });
      expect(record.requestDigest, name).toBe(computeScheduleRequestDigest(ctx.competitionId, intent, placements as never));
      expect(record.proposalDigest, name).toBe(computeScheduleProposalDigest(ctx.competitionId, record));
      expect(expected).toBe("OK");
    }
  }, 240000);
});

describe("[8][9] the same four rules for every format in the registry — judged by the database's own evaluator, on service-side facts only", () => {
  it("the registry's timing is exactly what the gate accepts, in the database and in the application", async () => {
    const { scheduleTimingFor } = await loadSp();
    for (const [format, t] of Object.entries(GATE_TIMING)) {
      const [row] = await rawQuery("select * from competition_schedule_timing($1)", [format]);
      expect([Number(row.occupancy_minutes), Number(row.pitch_transition_minutes), Number(row.minimum_team_rest_minutes)], format).toEqual([t.occupancy, t.transition, t.rest]);
      const ts = scheduleTimingFor(format as SoccerFormatKey);
      expect([ts.occupancyMinutes, ts.pitchTransitionMinutes, ts.minimumTeamRestMinutes], format).toEqual([t.occupancy, t.transition, t.rest]);
    }
    expect(await rawQuery("select count(*)::int n from competition_schedule_timing('SOCCER_9V9')")).toEqual([{ n: 0 }]);
  });

  it.each(FORMAT_GRID)("%s %s, %s (%s) -> %s", async (format, rule, _edge, minute, expected) => {
    const ctx = await pinned();
    const placements = rule === "final" ? req(ctx, "A 1 09:00", "B 1 09:00", `A 1 ${minute}`) : req(ctx, "A 1 09:00", `A 1 ${minute}`, "B 2 10:10");
    const out = await rawQuery("select competition_schedule_evaluate($1, $2, $3, $4::jsonb, $5::timestamptz) as r", [ctx.competitionId, ctx.revisionId, format, JSON.stringify(snake(placements)), PINNED_NOW]).then(
      () => "OK", (e: Error) => /SCHEDULE_PROPOSAL_INVALID: ([A-Z_]+):/.exec(e.message)?.[1] ?? `UNRECOGNISED: ${e.message}`);
    expect(out).toBe(expected);
  }, 60000);

  it("the same four rules exist in the application, and the two implementations agree on every grid row", async () => {
    const ctx = await pinned();
    const { evaluateScheduleProposal } = await loadSp();
    const read = (await readProposals(ctx))!;
    for (const [format, rule, , minute, expected] of FORMAT_GRID) {
      const placements = rule === "final" ? req(ctx, "A 1 09:00", "B 1 09:00", `A 1 ${minute}`) : req(ctx, "A 1 09:00", `A 1 ${minute}`, "B 2 10:10");
      const facts = { ...read.context!, formatKey: format, pitches: read.context!.pitches };
      const result = evaluateScheduleProposal(facts as never, placements as never, Date.parse(PINNED_NOW));
      expect(result.ok ? "OK" : result.violations[0].code, `${format} ${rule} ${minute}`).toBe(expected);
    }
  }, 120000);
});

describe("[11] the strict future is the accepted clock seam's, never a client's or the wall clock's", () => {
  it("the proposal's own instant is the seam's instant, and a start at that instant is refused while one a millisecond later is accepted", async () => {
    const ctx = await pinned();
    const at = "2026-11-14T15:00:00.000Z";
    expect(refusalCode(await rawCreate(ctx, at, snake(GOOD(ctx))))).toBe("START_NOT_FUTURE");
    const accepted = await withClockAt("2026-11-14T14:59:59.999Z", async (db) => {
      const result = (await db.query(CREATE_SQL, [ctx.competitionId, ctx.organizer.gamingMemberId, randomUUID(), JSON.stringify(snake(GOOD(ctx)))])).rows[0].r;
      const row = (await db.query("select created_at from competition_schedule_proposals where competition_id = $1", [ctx.competitionId])).rows[0];
      return { result, createdAt: (row.created_at as Date).toISOString() };
    });
    expect(accepted.createdAt).toBe("2026-11-14T14:59:59.999Z");
    expect(accepted.result.proposal.created_at).toBe("2026-11-14T14:59:59.999000Z");
    expect(await proposalCount(ctx.competitionId)).toEqual(NO_PROPOSAL);
  }, 120000);

  it("the operation reads no other clock: its source mentions the seam and none of the wall clocks", async () => {
    const [create] = await rawQuery("select prosrc from pg_proc where oid = (select oid from pg_proc where proname = 'create_competition_schedule_proposal_atomically')");
    expect(create.prosrc).toMatch(/competition_registration_clock\(\)/);
    for (const helper of [...HELPERS, ...RPCS]) {
      const [row] = await rawQuery("select prosrc from pg_proc where proname = $1", [helper]);
      expect(row.prosrc, helper).not.toMatch(/\bnow\s*\(|clock_timestamp|current_timestamp|statement_timestamp|transaction_timestamp|localtimestamp/i);
    }
  });
});

// =============================================================================================================================================
// [13] the venue's own clock
// =============================================================================================================================================

describe("[13] a venue-local time the clocks skip or repeat is refused; every duration is real elapsed time; calendar-independent", () => {
  it.each(DST_MATRIX)("%s", async (name, a, b, c, expected) => {
    const ctx = name.startsWith("fall back") ? await nyFall() : await nySpring();
    const out = await rawCreate(ctx, NY_NOW, snake(req(ctx, a, b, c)));
    expect(refusalCode(out)).toBe(expected);
    if (expected !== "OK" || !out.ok) return;
    const want = DST_ACCEPTED[name];
    if (!want) return;
    const placements = (out.rows[0].r as any).proposal.placements;
    expect(placements.map((p: any) => p.start_utc)).toEqual(want.starts);
    expect(placements.map((p: any) => p.end_utc)).toEqual(want.ends);
    expect(placements.map((p: any) => [p.window_start_utc, p.window_end_utc])).toEqual(want.windows);
  }, 60000);

  it("the decision is pinned: no row above reads the wall clock, and the seam is restored (the function is the original) after every one", async () => {
    const [clock] = await rawQuery("select prosrc from pg_proc where oid = 'public.competition_registration_clock()'::regprocedure");
    expect(clock.prosrc).toMatch(/clock_timestamp\(\)/);
    expect(clock.prosrc).not.toMatch(/2026|2027/);
  });
});

// =============================================================================================================================================
// [14] idempotency
// =============================================================================================================================================

describe("[14] an exact replay returns the existing proposal; the same intent for anything else fails closed", () => {
  it("replays the same intent and the same placements as the existing proposal, writing nothing — even if the placements arrive in another order", async () => {
    const ctx = await live("Replay");
    const intent = randomUUID();
    const first = await propose(ctx, GOOD(ctx), intent);
    const evidence = await proposalEvidenceHash(ctx.competitionId);
    const again = await propose(ctx, GOOD(ctx), intent);
    expect(again.alreadyProposed).toBe(true);
    expect(again.proposal).toEqual(first.proposal);
    const reordered = await propose(ctx, [GOOD(ctx)[2], GOOD(ctx)[0], GOOD(ctx)[1]], intent);
    expect(reordered.alreadyProposed).toBe(true);
    expect(reordered.proposal.proposalDigest).toBe(first.proposal.proposalDigest);
    expect(await proposalCount(ctx.competitionId)).toEqual({ proposals: 1, placements: 3 });
    expect(await proposalEvidenceHash(ctx.competitionId)).toBe(evidence);
  }, 240000);

  it("the same intent with ANY different placement is a conflict (INTENT_MISMATCH) and changes nothing", async () => {
    const ctx = await live("Conflict");
    const intent = randomUUID();
    await propose(ctx, GOOD(ctx), intent);
    const evidence = await proposalEvidenceHash(ctx.competitionId);
    const variants: Array<[string, ReturnType<typeof req>]> = [
      ["another minute", req(ctx, "A 1 09:00", "B 1 09:00", "A 1 10:09")], ["another pitch", req(ctx, "A 1 09:00", "C 1 09:00", "A 1 10:08")],
      ["another day", req(ctx, "A 1 09:00", "B 1 09:00", "A 2 10:10")], ["another semifinal", req(ctx, "A 1 09:01", "B 1 09:00", "A 1 10:09")],
    ];
    for (const [label, placements] of variants) {
      await expectRefusal(propose(ctx, placements, intent), "INTENT_MISMATCH").then(() => undefined, (e) => { throw new Error(`${label}: ${e.message}`); });
    }
    // even an INVALID schedule under a used intent is the conflict (the request is judged before the schedule), and a valid-looking one for another competition's plan likewise
    await expectRefusal(propose(ctx, req(ctx, "X 1 09:00", "B 1 09:00", "A 1 10:08"), intent), "INTENT_MISMATCH");
    expect(await proposalCount(ctx.competitionId)).toEqual({ proposals: 1, placements: 3 });
    expect(await proposalEvidenceHash(ctx.competitionId)).toBe(evidence);
  }, 300000);

  it("an intent is unique per competition: the same intent may be used by another competition, and it is bound to the competition (the request digest says so)", async () => {
    const ctx = await live("Intent A");
    const other = await live("Intent B");
    const intent = randomUUID();
    const a = await propose(ctx, GOOD(ctx), intent);
    const b = await propose(other, GOOD(other), intent);
    expect([a.alreadyProposed, b.alreadyProposed]).toEqual([false, false]);
    expect(a.proposal.proposalDigest).not.toBe(b.proposal.proposalDigest);
    const [rowA] = await proposalRows(ctx.competitionId);
    const [rowB] = await proposalRows(other.competitionId);
    expect(rowA.request_digest).not.toBe(rowB.request_digest);
  }, 300000);

  it("a replay is answered from the record after the competition has moved on, for the organizer only", async () => {
    const ctx = await live("Replay After");
    const intent = randomUUID();
    const first = await propose(ctx, GOOD(ctx), intent);
    await publishNow(ctx); // the OLD publication path: the competition leaves READY_TO_PUBLISH
    const again = await propose(ctx, GOOD(ctx), intent);
    expect(again.alreadyProposed).toBe(true);
    expect(again.proposal.proposalDigest).toBe(first.proposal.proposalDigest);
    await expectRefusal(propose(ctx, GOOD(ctx), randomUUID()), "WRONG_STATE");
    await expectRejects(propose(ctx, GOOD(ctx), intent, ctx.teams[0].captain.gamingMemberId), CompetitionAccessDeniedError);
  }, 300000);

  it("the stored request digest and proposal digest are the ones the application computes from the canonical texts", async () => {
    const ctx = await live("Digests");
    const intent = randomUUID();
    const { computeScheduleProposalDigest, computeScheduleRequestDigest } = await loadSp();
    const { proposal } = await propose(ctx, GOOD(ctx), intent);
    const [row] = await proposalRows(ctx.competitionId);
    expect(row.request_digest).toBe(computeScheduleRequestDigest(ctx.competitionId, intent, GOOD(ctx) as never));
    expect(row.proposal_digest).toBe(computeScheduleProposalDigest(ctx.competitionId, proposal));
    expect(row.proposal_digest).toBe(proposal.proposalDigest);
  }, 180000);

  it("the database's digest helpers give the independent known answers (SQL, TypeScript and Python hashlib agree)", async () => {
    const [r1] = await rawQuery("select competition_schedule_request_digest($1, $2, $3::jsonb) as d", [KAT.competition, KAT.intent, JSON.stringify([
      { fixture_role: "SEMIFINAL_1", planning_pitch_id: KAT.pitchA, plan_date: "2026-11-14", start_time: "09:00" }, { fixture_role: "SEMIFINAL_2", planning_pitch_id: KAT.pitchB, plan_date: "2026-11-14", start_time: "09:00" },
      { fixture_role: "FINAL", planning_pitch_id: KAT.pitchA, plan_date: "2026-11-14", start_time: "10:08" }])]);
    expect(r1.d).toBe(KAT.request1);
    const derived = (role: string, pitch: string, start: string, end: string, time: string) => ({ fixture_role: role, planning_pitch_id: pitch, plan_date: "2026-11-14", start_time: time, start_utc: start, end_utc: end, window_start_utc: "2026-11-14T15:00:00.000Z", window_end_utc: "2026-11-14T18:00:00.000Z" });
    const placements = JSON.stringify([
      derived("SEMIFINAL_1", KAT.pitchA, "2026-11-14T15:00:00.000Z", "2026-11-14T15:38:00.000Z", "09:00"), derived("SEMIFINAL_2", KAT.pitchB, "2026-11-14T15:00:00.000Z", "2026-11-14T15:38:00.000Z", "09:00"),
      derived("FINAL", KAT.pitchA, "2026-11-14T16:08:00.000Z", "2026-11-14T16:46:00.000Z", "10:08")]);
    const [p1] = await rawQuery("select competition_schedule_proposal_digest($1, 1, null, $2, $3, $4, $5, 'SOCCER_5V5', 'America/Costa_Rica', 2, 38, 10, 30, $6::jsonb) as d", [KAT.competition, KAT.request1, KAT.revision, KAT.draw, KAT.drawDigest, placements]);
    expect(p1.d).toBe(KAT.proposal1);
    const [p2] = await rawQuery("select competition_schedule_proposal_digest($1, 2, $2, $3, $4, $5, $6, 'SOCCER_5V5', 'America/Costa_Rica', 2, 38, 10, 30, $7::jsonb) as d", [KAT.competition, KAT.proposal1, KAT.request2, KAT.revision, KAT.draw, KAT.drawDigest, placements]);
    expect(p2.d).toBe(KAT.proposal2);
  });
});

// =============================================================================================================================================
// [15] versions and supersession
// =============================================================================================================================================

describe("[15] each accepted proposal is the next version; a new valid one supersedes the previous, and everything earlier is preserved byte for byte", () => {
  it("numbers the proposals 1, 2, 3 in order, each superseding the one before, and preserves every earlier row and placement exactly", async () => {
    const ctx = await live("Versions");
    const p1 = await propose(ctx, req(ctx, "A 1 09:00", "B 1 09:00", "A 1 10:08"));
    const afterOne = await proposalEvidenceHash(ctx.competitionId, 1);
    const p2 = await propose(ctx, req(ctx, "A 1 09:30", "B 1 09:30", "B 1 10:38"));
    const afterTwo = await proposalEvidenceHash(ctx.competitionId, 2);
    const p3 = await propose(ctx, req(ctx, "A 2 09:00", "B 2 09:00", "A 2 10:10"));
    expect([p1, p2, p3].map((p) => p.proposal.sequenceNumber)).toEqual([1, 2, 3]);
    expect(await proposalEvidenceHash(ctx.competitionId, 1)).toBe(afterOne);
    expect(await proposalEvidenceHash(ctx.competitionId, 2)).toBe(afterTwo);
    const rows = await proposalRows(ctx.competitionId);
    expect(rows.map((r) => r.sequence_number)).toEqual([1, 2, 3]);
    expect(rows[0].supersedes_schedule_proposal_id).toBeNull();
    expect(rows[1].supersedes_schedule_proposal_id).toBe(rows[0].schedule_proposal_id);
    expect(rows[2].supersedes_schedule_proposal_id).toBe(rows[1].schedule_proposal_id);
    expect(p1.proposal.supersedesDigest).toBeNull();
    expect(p2.proposal.supersedesDigest).toBe(p1.proposal.proposalDigest);
    expect(p3.proposal.supersedesDigest).toBe(p2.proposal.proposalDigest);
    expect(new Set(rows.map((r) => r.proposal_digest)).size).toBe(3);
    expect(await proposalCount(ctx.competitionId)).toEqual({ proposals: 3, placements: 9 });
  }, 300000);

  it("the read shows the latest in full as CURRENT and every earlier one as SUPERSEDED, newest first, bounded", async () => {
    const ctx = await live("History");
    for (const final of ["10:08", "10:09", "10:10"]) await propose(ctx, req(ctx, "A 1 09:00", "B 1 09:00", `A 1 ${final}`));
    const read = (await readProposals(ctx))!;
    expect(read.proposal!.sequenceNumber).toBe(3);
    expect(read.proposal!.status).toBe("CURRENT");
    expect(read.history.map((h) => [h.sequenceNumber, h.status])).toEqual([[3, "CURRENT"], [2, "SUPERSEDED"], [1, "SUPERSEDED"]]);
    expect(read.history.map((h) => h.proposalDigest)).toEqual([...(await proposalRows(ctx.competitionId))].reverse().map((r) => r.proposal_digest));
    expect(read.proposal!.placements[2].startTime).toBe("10:10");
  }, 300000);

  it("a refused request never takes a sequence number: the next accepted proposal is still the next number", async () => {
    const ctx = await live("No Gap");
    await propose(ctx, GOOD(ctx));
    await expectInvalid(propose(ctx, req(ctx, "A 1 09:00", "B 1 09:00", "A 1 10:07")), "FINAL_REST");
    await expectRejects(propose(ctx, GOOD(ctx), randomUUID(), ctx.teams[0].captain.gamingMemberId), CompetitionAccessDeniedError);
    // a replay of the first request is answered from the record and takes no number either
    const replay = await propose(ctx, GOOD(ctx), (await proposalRows(ctx.competitionId))[0].intent_id as string);
    expect(replay.alreadyProposed).toBe(true);
    const next = await propose(ctx, req(ctx, "A 1 09:00", "B 1 09:00", "A 1 10:20"));
    expect(next.proposal.sequenceNumber).toBe(2);
    expect((await proposalRows(ctx.competitionId)).map((r) => r.sequence_number)).toEqual([1, 2]);
  }, 240000);

  it("a proposal identical in content to the current one, under a NEW intent, is still a new version (the intent is the request's identity)", async () => {
    const ctx = await live("Same Content");
    const a = await propose(ctx, GOOD(ctx));
    const b = await propose(ctx, GOOD(ctx));
    expect([a.proposal.sequenceNumber, b.proposal.sequenceNumber, b.alreadyProposed]).toEqual([1, 2, false]);
    expect(b.proposal.proposalDigest).not.toBe(a.proposal.proposalDigest);
    expect(b.proposal.supersedesDigest).toBe(a.proposal.proposalDigest);
  }, 240000);
});

// =============================================================================================================================================
// [16] plan changes after the draw
// =============================================================================================================================================

describe("[16] a plan change activated after the draw makes an older proposal STALE, leaves the draw exactly as it was, and needs a new proposal on the new revision", () => {
  it("the older proposal reads as STALE (its plan revision is no longer current), the draw is byte-identical, and a proposal on the old pitches is refused", async () => {
    const ctx = await live("Stale");
    const first = await propose(ctx, GOOD(ctx));
    expect(first.proposal.status).toBe("CURRENT");
    const drawBefore = await drawEvidenceHash(ctx.competitionId);
    const proposalBefore = await proposalEvidenceHash(ctx.competitionId);
    const [freezeBefore] = await rawQuery("select snapshot_digest from competition_registration_freezes where competition_id = $1", [ctx.competitionId]);
    await activateChange(ctx);

    const read = (await readProposals(ctx))!;
    expect(read.proposal!.sequenceNumber).toBe(1);
    expect(read.proposal!.status).toBe("STALE");
    expect([read.proposal!.planningRevisionCurrent, read.proposal!.drawDigestMatches]).toEqual([false, true]);
    expect(read.history.map((h) => [h.sequenceNumber, h.status])).toEqual([[1, "STALE"]]);
    expect(read.context!.planningRevisionNumber).toBe(first.proposal.planningRevisionNumber + 1);
    // the draw is permanent: unchanged, and the proposal's bound digest still equals it
    expect(await drawEvidenceHash(ctx.competitionId)).toBe(drawBefore);
    expect(read.proposal!.drawDigest).toBe(first.proposal.drawDigest);
    expect((await compRepo.getCompetitionDraw(ctx.competitionId, ctx.organizer.gamingMemberId))!.draw!.drawDigest).toBe(first.proposal.drawDigest);
    expect((await rawQuery("select snapshot_digest from competition_registration_freezes where competition_id = $1", [ctx.competitionId]))[0]).toEqual(freezeBefore);
    // the old proposal's bytes are untouched
    expect(await proposalEvidenceHash(ctx.competitionId)).toBe(proposalBefore);
    // a proposal built from the OLD plan's pitches is refused: they are not the current revision's
    await expectInvalid(propose(ctx, GOOD(ctx)), "PITCH_NOT_IN_PLAN");
  }, 420000);

  it("a new proposal on the new revision is accepted, supersedes the stale one, and reads CURRENT; the stale one is preserved as it was", async () => {
    const ctx = await live("Renew");
    const first = await propose(ctx, GOOD(ctx));
    const proposalBefore = await proposalEvidenceHash(ctx.competitionId, 1);
    await activateChange(ctx);
    const after: Ctx = { ...ctx, ...(await pitchIds(ctx.competitionId)) };
    const dateOfChange = after.dates["1"];
    const second = await propose(after, [
      { fixtureRole: "SEMIFINAL_1", planningPitchId: after.pitch.A, planDate: dateOfChange, startTime: "09:00" },
      { fixtureRole: "SEMIFINAL_2", planningPitchId: after.pitch.B, planDate: dateOfChange, startTime: "09:00" },
      { fixtureRole: "FINAL", planningPitchId: after.pitch.A, planDate: dateOfChange, startTime: "10:08" },
    ]);
    expect(second.proposal.sequenceNumber).toBe(2);
    expect(second.proposal.status).toBe("CURRENT");
    expect(second.proposal.planningRevisionNumber).toBe(first.proposal.planningRevisionNumber + 1);
    expect(second.proposal.drawDigest).toBe(first.proposal.drawDigest);
    expect(second.proposal.supersedesDigest).toBe(first.proposal.proposalDigest);
    expect(await proposalEvidenceHash(ctx.competitionId, 1)).toBe(proposalBefore);
    const read = (await readProposals(after))!;
    expect(read.history.map((h) => [h.sequenceNumber, h.status])).toEqual([[2, "CURRENT"], [1, "SUPERSEDED"]]);
  }, 420000);

  it("a pending plan change blocks a new proposal, but does not alter an existing one", async () => {
    const ctx = await live("Pending After");
    const first = await propose(ctx, GOOD(ctx));
    const change = await proposeChange(ctx);
    await expectRefusal(propose(ctx, req(ctx, "A 1 09:00", "B 1 09:00", "A 1 10:20")), "AMENDMENT_PENDING");
    const read = (await readProposals(ctx))!;
    expect(read.proposal!.status).toBe("CURRENT");
    expect(read.proposal!.proposalDigest).toBe(first.proposal.proposalDigest);
    await withdrawChange(ctx, change.digest);
  }, 300000);
});

// =============================================================================================================================================
// [17] concurrency
// =============================================================================================================================================

describe("[17] concurrent requests leave one deterministic accepted sequence", () => {
  it("six simultaneous proposals under six intents become exactly versions 1 to 6, one chain, no gap, no duplicate, one CURRENT", async () => {
    const ctx = await live("Concurrent Many");
    const minutes = ["10:08", "10:09", "10:10", "10:11", "10:12", "10:13"];
    const results = await Promise.all(minutes.map((m) => propose(ctx, req(ctx, "A 1 09:00", "B 1 09:00", `A 1 ${m}`))));
    expect(results.every((r) => r.alreadyProposed === false)).toBe(true);
    expect(results.map((r) => r.proposal.sequenceNumber).sort((a, b) => a - b)).toEqual([1, 2, 3, 4, 5, 6]);
    const rows = await proposalRows(ctx.competitionId);
    expect(rows.map((r) => r.sequence_number)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(rows[0].supersedes_schedule_proposal_id).toBeNull();
    for (let i = 1; i < rows.length; i++) expect(rows[i].supersedes_schedule_proposal_id, `version ${i + 1}`).toBe(rows[i - 1].schedule_proposal_id);
    expect(new Set(rows.map((r) => r.supersedes_schedule_proposal_id).filter(Boolean)).size).toBe(5); // one successor each
    const read = (await readProposals(ctx))!;
    expect(read.history.map((h) => h.status)).toEqual(["CURRENT", "SUPERSEDED", "SUPERSEDED", "SUPERSEDED", "SUPERSEDED", "SUPERSEDED"]);
    expect(await proposalCount(ctx.competitionId)).toEqual({ proposals: 6, placements: 18 });
  }, 300000);

  it("four simultaneous requests with the SAME intent and placements leave exactly one proposal, and everyone is given that one", async () => {
    const ctx = await live("Concurrent Same");
    const intent = randomUUID();
    const results = await Promise.all([0, 1, 2, 3].map(() => propose(ctx, GOOD(ctx), intent)));
    expect(results.filter((r) => !r.alreadyProposed)).toHaveLength(1);
    expect(new Set(results.map((r) => r.proposal.proposalDigest)).size).toBe(1);
    expect(await proposalCount(ctx.competitionId)).toEqual({ proposals: 1, placements: 3 });
  }, 240000);

  it("four simultaneous requests with the SAME intent and DIFFERENT placements: exactly one is recorded, the others are the conflict", async () => {
    const ctx = await live("Concurrent Conflict");
    const intent = randomUUID();
    const outcomes = await Promise.all(["10:08", "10:09", "10:10", "10:11"].map((m) => propose(ctx, req(ctx, "A 1 09:00", "B 1 09:00", `A 1 ${m}`), intent).then((r) => ({ ok: true as const, r }), (e: Error) => ({ ok: false as const, e }))));
    const { ScheduleProposalError } = await loadSp();
    expect(outcomes.filter((o) => o.ok)).toHaveLength(1);
    for (const o of outcomes.filter((x) => !x.ok)) {
      expect((o as { e: Error }).e).toBeInstanceOf(ScheduleProposalError);
      expect(((o as unknown as { e: { code: string } }).e).code).toBe("INTENT_MISMATCH");
    }
    expect(await proposalCount(ctx.competitionId)).toEqual({ proposals: 1, placements: 3 });
  }, 240000);

  it("simultaneous valid and invalid requests: the invalid ones are refused for their rule, the valid ones are numbered without a gap", async () => {
    const ctx = await live("Concurrent Mixed");
    const outcomes = await Promise.all([
      propose(ctx, req(ctx, "A 1 09:00", "B 1 09:00", "A 1 10:08")), propose(ctx, req(ctx, "A 1 09:00", "B 1 09:00", "A 1 10:07")), propose(ctx, req(ctx, "A 1 09:00", "B 1 09:00", "A 1 10:09")),
      propose(ctx, req(ctx, "A 1 09:00", "A 1 09:00", "B 1 10:08")), propose(ctx, req(ctx, "A 1 09:00", "B 1 09:00", "A 1 10:10")),
    ].map((p) => p.then((r) => ({ ok: true as const, r }), (e: Error) => ({ ok: false as const, e }))));
    expect(outcomes.filter((o) => o.ok)).toHaveLength(3);
    expect(outcomes.filter((o) => !o.ok)).toHaveLength(2);
    expect((await proposalRows(ctx.competitionId)).map((r) => r.sequence_number)).toEqual([1, 2, 3]);
  }, 300000);

  it("a proposal and the activation of a plan change racing: the proposal is refused in either order — never recorded against a plan that is not current", async () => {
    const ctx = await live("Race Change");
    const p = await proposeChange(ctx);
    for (let i = 0; i < 3; i++) await decideChange(ctx, i, p.digest, "CONFIRMED");
    const settled = await Promise.all([
      decideChange(ctx, 3, p.digest, "CONFIRMED").then(() => "activated", (e: Error) => e.message),
      propose(ctx, GOOD(ctx)).then(() => "proposed", (e: Error) => e.constructor.name),
    ]);
    expect(settled[0]).toBe("activated");
    // In either order nothing is recorded: before the activation the change is PENDING (AMENDMENT_PENDING); after it the old pitches are not the new revision's (PITCH_NOT_IN_PLAN).
    expect(settled[1]).toMatch(/^ScheduleProposal(Validation)?Error$/);
    expect(await proposalCount(ctx.competitionId)).toEqual(NO_PROPOSAL);
    expect((await pitchIds(ctx.competitionId)).revisionId).not.toBe(ctx.revisionId);
  }, 420000);
});

// =============================================================================================================================================
// the verification triggers
// =============================================================================================================================================

describe("[18] the evidence is consistent whatever wrote it: a forged proposal is refused at commit — for the one thing that is wrong with it", () => {
  const ROLE_ORDER = ["SEMIFINAL_1", "SEMIFINAL_2", "FINAL"];
  interface Forgery {
    sequence?: number;
    /** undefined = the latest genuine proposal; null = no predecessor */
    supersedesId?: string | null;
    planningRevisionId?: string;
    proposalDigest?: string;
    requestDigest?: string;
    drawDigest?: string;
    proposedBy?: string;
    occupancy?: number;
    /** the capacity the proposal states (default: the genuine proposal's) */
    capacity?: number;
    /** how many of the three placements are written (default 3) */
    keep?: number;
    /** overrides of the stored placement columns, by index in role order */
    placement?: (p: Record<string, any>, i: number) => Record<string, unknown>;
  }

  /**
   * Records, as the database owner and inside a transaction that is ALWAYS rolled back, a second proposal beside the genuine first one, forcing every deferred check to run. Every
   * digest is computed for exactly what is written, so the only thing wrong with a forgery is the one thing it changes; the control (no change at all) must be ACCEPTED, which
   * proves this harness is not refusing for some other reason.
   */
  async function forge(ctx: Ctx, f: Forgery = {}) {
    const { computeScheduleProposalDigest, computeScheduleRequestDigest } = await loadSp();
    return violationOf(async (db) => {
      const base = (await db.query("select * from competition_schedule_proposals where competition_id = $1 order by sequence_number desc limit 1", [ctx.competitionId])).rows[0];
      const rows = (await db.query(
        `select p.*, to_char(p.plan_date, 'YYYY-MM-DD') as date_text, to_char(p.start_time, 'HH24:MI') as time_text from competition_schedule_proposal_placements p where p.schedule_proposal_id = $1`, [base.schedule_proposal_id])).rows;
      const placements = ROLE_ORDER.map((role, i) => {
        const row = rows.find((r) => r.fixture_role === role)!;
        return { ...row, ...(f.placement ? f.placement(row, i) : {}) } as Record<string, any>;
      });
      const id = randomUUID();
      const intent = randomUUID();
      const sequence = f.sequence ?? base.sequence_number + 1;
      const supersedesId = f.supersedesId === undefined ? base.schedule_proposal_id : f.supersedesId;
      const supersedesDigest = supersedesId === base.schedule_proposal_id ? base.proposal_digest : null;
      const revision = f.planningRevisionId ?? base.planning_revision_id;
      const occupancy = f.occupancy ?? base.occupancy_minutes;
      const capacity = f.capacity ?? base.simultaneous_match_capacity;
      const iso = (d: Date) => d.toISOString();
      const requestDigest = f.requestDigest ?? computeScheduleRequestDigest(ctx.competitionId, intent, placements.map((p) => ({ fixtureRole: p.fixture_role, planningPitchId: p.planning_pitch_id, planDate: p.date_text, startTime: p.time_text })) as never);
      const proposalDigest = f.proposalDigest ?? computeScheduleProposalDigest(ctx.competitionId, {
        sequenceNumber: sequence, supersedesDigest, requestDigest, planningRevisionId: revision, drawId: base.competition_draw_id, drawDigest: f.drawDigest ?? base.draw_digest, formatKey: base.format_key,
        timeZone: base.time_zone, simultaneousMatchCapacity: capacity, timing: { occupancyMinutes: occupancy, pitchTransitionMinutes: base.pitch_transition_minutes, minimumTeamRestMinutes: base.minimum_team_rest_minutes },
        placements: placements.map((p) => ({ fixtureRole: p.fixture_role, planningPitchId: p.planning_pitch_id, planDate: p.date_text, startTime: p.time_text, startUtc: iso(p.starts_at), endUtc: iso(p.occupancy_ends_at), windowStartUtc: iso(p.window_starts_at), windowEndUtc: iso(p.window_ends_at) })),
      } as never);
      await db.query(
        `insert into competition_schedule_proposals (schedule_proposal_id, competition_id, sequence_number, supersedes_schedule_proposal_id, intent_id, request_digest, proposed_by_gaming_member_id, created_at,
           planning_revision_id, competition_draw_id, draw_digest, format_key, time_zone, simultaneous_match_capacity, occupancy_minutes, pitch_transition_minutes, minimum_team_rest_minutes, proposal_digest)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)`,
        [id, ctx.competitionId, sequence, supersedesId, intent, requestDigest, f.proposedBy ?? base.proposed_by_gaming_member_id, base.created_at, revision, base.competition_draw_id, f.drawDigest ?? base.draw_digest,
          base.format_key, base.time_zone, capacity, occupancy, base.pitch_transition_minutes, base.minimum_team_rest_minutes, proposalDigest]);
      for (const p of placements.slice(0, f.keep ?? 3)) {
        await db.query(
          `insert into competition_schedule_proposal_placements (schedule_proposal_id, competition_id, planning_revision_id, fixture_role, planning_pitch_id, plan_date, start_time, starts_at, occupancy_ends_at, window_starts_at, window_ends_at)
           values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          [id, ctx.competitionId, p.planning_revision_id === base.planning_revision_id ? revision : p.planning_revision_id, p.fixture_role, p.planning_pitch_id, p.date_text, p.time_text, p.starts_at, p.occupancy_ends_at, p.window_starts_at, p.window_ends_at]);
      }
    });
  }
  /** The forgery must be refused, and for THIS reason (a pattern for the stable code of the check, or for the table's own constraint). */
  const refusedWith = (out: DbViolation | null, reason: RegExp) => { expect(out, "the forgery must be refused").not.toBeNull(); expect(out!.message).toMatch(reason); };
  const invalid = (code: string) => new RegExp(`SCHEDULE_PROPOSAL_INVALID: ${code}:`);

  it("[control] a correctly sealed second version, written by the owner, is accepted: so every refusal below is for the thing it changes and nothing else", async () => {
    const ctx = await live("Forge Control");
    await propose(ctx, GOOD(ctx));
    expect(await forge(ctx)).toBeNull();
    expect(await proposalCount(ctx.competitionId)).toEqual({ proposals: 1, placements: 3 }); // the forgery's transaction was rolled back
  }, 240000);

  it("a proposal with no placements, with two, with a digest that does not match its evidence, and with a request digest that does not match its request are refused", async () => {
    const ctx = await live("Forge Shape");
    await propose(ctx, GOOD(ctx));
    refusedWith(await forge(ctx, { keep: 0 }), invalid("SHAPE"));
    refusedWith(await forge(ctx, { keep: 2 }), invalid("SHAPE"));
    refusedWith(await forge(ctx, { proposalDigest: "a".repeat(64) }), invalid("DIGEST"));
    refusedWith(await forge(ctx, { requestDigest: "b".repeat(64) }), invalid("REQUEST_DIGEST"));
    expect(await proposalCount(ctx.competitionId)).toEqual({ proposals: 1, placements: 3 });
  }, 300000);

  it("a gap in the sequence, a missing predecessor and a second first version are refused", async () => {
    const ctx = await live("Forge Chain");
    await propose(ctx, GOOD(ctx));
    refusedWith(await forge(ctx, { sequence: 3 }), invalid("SEQUENCE"));
    refusedWith(await forge(ctx, { supersedesId: null }), /violates check constraint "competition_schedule_proposals_first_has_no_predecessor"/);
    refusedWith(await forge(ctx, { sequence: 1, supersedesId: null }), /duplicate key value violates unique constraint "competition_schedule_proposals_sequence_key"/);
    expect(await proposalCount(ctx.competitionId)).toEqual({ proposals: 1, placements: 3 });
  }, 300000);

  it("a version on a plan revision that is no longer the current one, and one whose pitch belongs to another competition, are refused — each internally consistent, digest included", async () => {
    const ctx = await live("Forge Plan");
    const other = await live("Forge Other Plan");
    await propose(ctx, GOOD(ctx));
    // The competition's FIRST revision (the one the public save made) is real and valid in itself — one pitch, one window — but it is not the current revision.
    const old = (await rawQuery("select r.planning_revision_id, p.planning_pitch_id, to_char(d.plan_date, 'YYYY-MM-DD') as d from competition_planning_revisions r join competition_planning_pitches p on p.planning_revision_id = r.planning_revision_id join competition_planning_dates d on d.planning_revision_id = r.planning_revision_id where r.competition_id = $1 and r.revision_number = 1", [ctx.competitionId]))[0];
    const at = (hhmm: string) => new Date(Date.parse(`${old.d}T${hhmm}:00-06:00`));
    const stale = await forge(ctx, {
      planningRevisionId: old.planning_revision_id,
      capacity: 1, // that revision's own capacity, so the ONLY thing wrong with this proposal is that its plan revision is not the current one
      placement: (p, i) => {
        const start = [at("09:00"), at("09:48"), at("10:56")][i];
        return { planning_revision_id: old.planning_revision_id, planning_pitch_id: old.planning_pitch_id, plan_date: old.d, date_text: old.d, time_text: ["09:00", "09:48", "10:56"][i], starts_at: start, occupancy_ends_at: new Date(start.getTime() + 38 * 60_000), window_starts_at: at("09:00"), window_ends_at: at("13:00") };
      },
    });
    refusedWith(stale, invalid("PLAN_NOT_CURRENT"));
    refusedWith(await forge(ctx, { placement: (p, i) => (i === 0 ? { planning_pitch_id: other.pitch.A } : {}) }), invalid("PITCH_NOT_IN_PLAN"));
    expect(await proposalCount(ctx.competitionId)).toEqual({ proposals: 1, placements: 3 });
  }, 360000);

  it("derived instants that do not follow from the local time, an end that is not start + occupancy, a window that does not hold the occupancy, timing that is not the registry's, and a broken rule are each refused", async () => {
    const ctx = await live("Forge Derived");
    await propose(ctx, GOOD(ctx));
    const minute = 60_000;
    refusedWith(await forge(ctx, { placement: (p, i) => (i === 1 ? { starts_at: new Date(p.starts_at.getTime() + minute), occupancy_ends_at: new Date(p.occupancy_ends_at.getTime() + minute) } : {}) }), invalid("DERIVED"));
    refusedWith(await forge(ctx, { placement: (p, i) => (i === 2 ? { occupancy_ends_at: new Date(p.occupancy_ends_at.getTime() - minute) } : {}) }), invalid("DERIVED"));
    // a window that cannot hold its occupancy is refused by the table's own CHECK constraint, even before the commit-time verification
    refusedWith(await forge(ctx, { placement: (p, i) => (i === 0 ? { window_ends_at: new Date(p.starts_at.getTime() + minute) } : {}) }), /violates check constraint "competition_schedule_proposal_placements_window"/);
    refusedWith(await forge(ctx, { occupancy: 40 }), invalid("TIMING"));
    // semifinal 2 on semifinal 1's pitch at the same time: every instant is right, the digest is right, the rule is broken
    refusedWith(await forge(ctx, { placement: (p, i) => (i === 1 ? { planning_pitch_id: ctx.pitch.A } : {}) }), invalid("PITCH_OVERLAP"));
    // the final 67 minutes after the semifinals: instants consistent, rule broken
    refusedWith(await forge(ctx, { placement: (p, i) => (i === 2 ? { time_text: "10:07", starts_at: new Date(p.starts_at.getTime() - minute), occupancy_ends_at: new Date(p.occupancy_ends_at.getTime() - minute) } : {}) }), invalid("FINAL_REST"));
    expect(await proposalCount(ctx.competitionId)).toEqual({ proposals: 1, placements: 3 });
  }, 360000);

  it("a draw digest that is not the draw's, a proposer who is not the organizer, and a competition that is not eligible are refused, even for the database owner", async () => {
    const ctx = await live("Forge Binding");
    await propose(ctx, GOOD(ctx));
    refusedWith(await forge(ctx, { drawDigest: sha("another draw") }), invalid("DRAW"));
    refusedWith(await forge(ctx, { proposedBy: ctx.teams[0].captain.gamingMemberId }), invalid("ACTOR"));
    await rawQuery("update competitions set state = 'COMPLETE' where competition_id = $1", [ctx.competitionId]); // service-side fixture
    refusedWith(await forge(ctx), invalid("NOT_ELIGIBLE"));
  }, 300000);
});

// =============================================================================================================================================
// [19] nothing else changes
// =============================================================================================================================================

describe("[19] a proposal creates no fixture, publishes nothing, changes no state, and changes nothing the freeze, the draw, the plan, the amendments or the host carry", () => {
  it("creating, replaying, superseding, refusing and reading proposals leaves everything else byte-identical", async () => {
    const ctx = await live("Collateral");
    const before = await collateralHash(ctx.competitionId);
    const stateBefore = await stateOf(ctx.competitionId);
    const intent = randomUUID();
    await propose(ctx, GOOD(ctx), intent);
    await propose(ctx, GOOD(ctx), intent); // replay
    await propose(ctx, req(ctx, "A 2 09:00", "B 2 09:00", "A 2 10:10")); // supersession
    await expectInvalid(propose(ctx, req(ctx, "A 1 09:00", "B 1 09:00", "A 1 10:07")), "FINAL_REST");
    await expectRejects(propose(ctx, GOOD(ctx), randomUUID(), ctx.teams[0].captain.gamingMemberId), CompetitionAccessDeniedError);
    await readProposals(ctx);
    expect(await collateralHash(ctx.competitionId)).toBe(before);
    expect(await stateOf(ctx.competitionId)).toEqual(stateBefore);
    expect(stateBefore.state).toBe("READY_TO_PUBLISH");
    expect(stateBefore.published_at).toBeNull();
    expect(await fixtureCount(ctx.competitionId)).toBe(0);
    expect(await proposalCount(ctx.competitionId)).toEqual({ proposals: 2, placements: 6 });
  }, 300000);

  it("the application's view of the competition and its discovery are unchanged by a proposal: still READY_TO_PUBLISH, still no fixtures, the same registrations and teams", async () => {
    const ctx = await live("View");
    const before = {
      competition: await compRepo.getCompetitionById(ctx.competitionId), fixtures: await compRepo.getCompetitionFixtures(ctx.competitionId), teams: await compRepo.getCompetitionTeams(ctx.competitionId),
      list: (await compRepo.listCompetitions()).filter((c) => c.competitionId === ctx.competitionId), freeze: await compRepo.getRegistrationFreeze(ctx.competitionId), draw: await compRepo.getCompetitionDraw(ctx.competitionId, ctx.organizer.gamingMemberId),
      plan: await compRepo.getCurrentPlanningRevision(ctx.competitionId),
    };
    await propose(ctx, GOOD(ctx));
    const after = {
      competition: await compRepo.getCompetitionById(ctx.competitionId), fixtures: await compRepo.getCompetitionFixtures(ctx.competitionId), teams: await compRepo.getCompetitionTeams(ctx.competitionId),
      list: (await compRepo.listCompetitions()).filter((c) => c.competitionId === ctx.competitionId), freeze: await compRepo.getRegistrationFreeze(ctx.competitionId), draw: await compRepo.getCompetitionDraw(ctx.competitionId, ctx.organizer.gamingMemberId),
      plan: await compRepo.getCurrentPlanningRevision(ctx.competitionId),
    };
    expect(after).toEqual(before);
    expect(after.fixtures).toEqual([]);
    expect(after.competition!.state).toBe("READY_TO_PUBLISH");
  }, 240000);

  it("the legacy manual publication still works exactly as it did, whatever proposals exist (it is not retired, not bound to a proposal, and not changed here)", async () => {
    const ctx = await live("Legacy Publish");
    await propose(ctx, GOOD(ctx));
    const published = await publishNow(ctx);
    expect(published.state).toBe("PUBLISHED");
    expect(await fixtureCount(ctx.competitionId)).toBe(3);
    // the proposal is untouched evidence; nothing derived from it was scheduled
    expect(await proposalCount(ctx.competitionId)).toEqual({ proposals: 1, placements: 3 });
  }, 300000);
});

// =============================================================================================================================================
// [20] public creation paths
// =============================================================================================================================================

describe("[20] 6v6, 7v7 and 8v8 remain unavailable through every public creation path; the proposal takes no format from anyone", () => {
  it.each(["SOCCER_6V6", "SOCCER_7V7", "SOCCER_8V8"])("%s cannot be created: the application and the database both refuse it, and no competition is made", async (format) => {
    const organizer = await makeOperator(`Format ${format}`);
    await expectRejects(createCompetition(compRepo, organizer.gamingMemberId, `Format ${format} ${RUN}`, format as never), UnsupportedActivityKeyError);
    const raw = await rawQuery("select count(*)::int n from competitions where organizer_gaming_member_id = $1", [organizer.gamingMemberId]);
    expect(raw[0].n).toBe(0);
    const rpc = await service.rpc("create_competition_atomically", { p_organizer_gaming_member_id: organizer.gamingMemberId, p_name: `Raw ${format} ${RUN}`, p_activity_key: format, p_public_code: `x${RUN}${format.slice(7, 9)}` });
    expect(rpc.error?.message ?? "").toMatch(/UNSUPPORTED_ACTIVITY_KEY/);
  }, 120000);

  it("the proposal operations take no format, no timing and no zone: their signatures say so, and the format used is always the competition's own", async () => {
    const args = (await rawQuery("select pg_get_function_arguments(p.oid) as a from pg_proc p where p.proname = any($1) order by p.proname", [[...RPCS]])).map((r) => r.a as string);
    for (const a of args) expect(a).not.toMatch(/format|timing|zone|capacity|actor|now|occupancy/i);
    const ctx = await pinned();
    const [competition] = await rawQuery("select activity_key from competitions where competition_id = $1", [ctx.competitionId]);
    expect(competition.activity_key).toBe("SOCCER_5V5");
    const accepted = await rawCreate(ctx, PINNED_NOW, snake(GOOD(ctx)));
    expect((accepted as { rows: any[] }).rows[0].r.proposal.format_key).toBe("SOCCER_5V5");
  });

  it("the registry still holds exactly the four formats, and the competition's format is unchanged by anything a proposal does", async () => {
    expect((await rawQuery("select format_key from competition_format_rules order by format_key")).map((r) => r.format_key)).toEqual(ALL4);
    const ctx = await live("Format Unchanged");
    await propose(ctx, GOOD(ctx));
    expect((await rawQuery("select activity_key from competitions where competition_id = $1", [ctx.competitionId]))[0].activity_key).toBe("SOCCER_5V5");
    expect((await rawQuery("select format_key from competition_planning_revisions where competition_id = $1", [ctx.competitionId])).every((r) => r.format_key === "SOCCER_5V5")).toBe(true);
  }, 180000);
});

// =============================================================================================================================================
// the routes, with real tokens
// =============================================================================================================================================

describe("the route, with real access tokens against the real database", () => {
  it("POST creates (201), an exact replay answers 200, a conflicting intent is 409, an invalid schedule is 400 with its code, and the answer is bounded and uncached", async () => {
    const ctx = await live("Route Post");
    const route = await loadRoute();
    const token = await tokenFor(ctx.organizer);
    const intent = randomUUID();
    const body = { intentId: intent, placements: GOOD(ctx) };
    const created = await route.POST(request(`${COMP}/${ctx.competitionId}/schedule-proposal`, "POST", token, body), ctxOf(ctx.competitionId));
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toMatch(/no-store/);
    const json = await created.json();
    expect(json.alreadyProposed).toBe(false);
    expect(json.proposal.sequenceNumber).toBe(1);
    expect(json.proposal.status).toBe("CURRENT");
    expect(Object.keys(json.proposal).sort()).toEqual([
      "createdAt", "drawDigest", "drawDigestMatches", "formatKey", "placements", "planningRevisionCurrent", "planningRevisionNumber", "proposalDigest", "sequenceNumber",
      "simultaneousMatchCapacity", "status", "supersedesDigest", "timeZone", "timing"]);
    const text = JSON.stringify(json);
    expect(text).not.toContain(ctx.organizer.gamingMemberId);
    expect(text).not.toContain(intent);
    expect(text).not.toContain(ctx.revisionId);
    const replay = await route.POST(request(`${COMP}/${ctx.competitionId}/schedule-proposal`, "POST", token, body), ctxOf(ctx.competitionId));
    expect([replay.status, (await replay.json()).alreadyProposed]).toEqual([200, true]);
    const conflict = await route.POST(request(`${COMP}/${ctx.competitionId}/schedule-proposal`, "POST", token, { intentId: intent, placements: req(ctx, "A 1 09:00", "B 1 09:00", "A 1 10:09") }), ctxOf(ctx.competitionId));
    expect([conflict.status, (await conflict.json()).code]).toEqual([409, "INTENT_MISMATCH"]);
    const invalid = await route.POST(request(`${COMP}/${ctx.competitionId}/schedule-proposal`, "POST", token, { intentId: randomUUID(), placements: req(ctx, "A 1 09:00", "B 1 09:00", "A 1 10:07") }), ctxOf(ctx.competitionId));
    expect(invalid.status).toBe(400);
    expect((await invalid.json()).problems).toEqual([expect.objectContaining({ code: "FINAL_REST" })]);
    const forbidden = await route.POST(request(`${COMP}/${ctx.competitionId}/schedule-proposal`, "POST", token, { ...body, intentId: randomUUID(), timeZone: "UTC" }), ctxOf(ctx.competitionId));
    expect(forbidden.status).toBe(400);
    expect(await proposalCount(ctx.competitionId)).toEqual({ proposals: 1, placements: 3 });
  }, 300000);

  it("POST by a captain, an operational-only member, a stranger and for an unknown competition all get the same 404 — and nothing is written", async () => {
    const ctx = await live("Route Authority");
    const route = await loadRoute();
    const operational = await makeOperator("Route Operational");
    const stranger = await newPerson("Route Stranger");
    const answers: Array<[number, string]> = [];
    for (const [who, id] of [[ctx.teams[0].captain, ctx.competitionId], [operational, ctx.competitionId], [stranger, ctx.competitionId], [ctx.organizer, randomUUID()]] as const) {
      const res = await route.POST(request(`${COMP}/${id}/schedule-proposal`, "POST", await tokenFor(who), { intentId: randomUUID(), placements: GOOD(ctx) }), ctxOf(id));
      answers.push([res.status, await res.text()]);
    }
    expect(new Set(answers.map((a) => a[0]))).toEqual(new Set([404]));
    expect(new Set(answers.map((a) => a[1])).size).toBe(1);
    expect(await proposalCount(ctx.competitionId)).toEqual(NO_PROPOSAL);
  }, 300000);

  it("GET answers the organizer with the bounded context, latest proposal and history; everyone else, and an unknown competition, with the same 404", async () => {
    const ctx = await live("Route Get");
    const route = await loadRoute();
    await propose(ctx, GOOD(ctx));
    const res = await route.GET(request(`${COMP}/${ctx.competitionId}/schedule-proposal`, "GET", await tokenFor(ctx.organizer)), ctxOf(ctx.competitionId));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    const json = await res.json();
    expect(Object.keys(json).sort()).toEqual(["context", "history", "proposal"]);
    expect(json.proposal.sequenceNumber).toBe(1);
    expect(json.context.pitches.map((p: any) => p.planningPitchId).sort()).toEqual(Object.entries(ctx.pitch).filter(([k]) => k !== "X").map(([, v]) => v).sort());
    const captain = await route.GET(request(`${COMP}/${ctx.competitionId}/schedule-proposal`, "GET", await tokenFor(ctx.teams[0].captain)), ctxOf(ctx.competitionId));
    const unknown = await route.GET(request(`${COMP}/${randomUUID()}/schedule-proposal`, "GET", await tokenFor(ctx.organizer)), ctxOf(randomUUID()));
    expect([captain.status, unknown.status]).toEqual([404, 404]);
    expect(await captain.text()).toBe(await unknown.text());
  }, 300000);
});
