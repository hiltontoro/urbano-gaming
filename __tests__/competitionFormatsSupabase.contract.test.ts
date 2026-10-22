import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { loadEnv } from "vite";
import { createClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { SupabaseCompetitionsRepository } from "../lib/gaming/competitions/db/supabaseCompetitionsRepository";
import { SupabaseHostRepository } from "../lib/gaming/host/db/supabaseHostRepository";
import { SupabaseGamingRepository } from "../lib/gaming/db/supabaseGamingRepository";
import { submitHostApplication } from "../lib/gaming/host/submitHostApplication";
import { decideHostApplication } from "../lib/gaming/host/decideHostApplication";
import { createCompetition } from "../lib/gaming/competitions/createCompetition";
import { openTeamRegistration } from "../lib/gaming/competitions/openTeamRegistration";
import { closeTeamRegistration } from "../lib/gaming/competitions/closeTeamRegistration";
import { addCompetitionTeam } from "../lib/gaming/competitions/addCompetitionTeam";
import { publishCompetition } from "../lib/gaming/competitions/publishCompetition";
import { registerForCompetition } from "../lib/gaming/competitions/registerForCompetition";
import { requestJoinTeam } from "../lib/gaming/competitions/requestJoinTeam";
import { decideJoinRequest } from "../lib/gaming/competitions/decideJoinRequest";
import { declareRoster } from "../lib/gaming/competitions/declareRoster";
import { appointScorekeeper } from "../lib/gaming/competitions/appointScorekeeper";
import { submitFixtureEvidence } from "../lib/gaming/competitions/submitFixtureEvidence";
import { finalizeFixture } from "../lib/gaming/competitions/finalizeFixture";
import { correctFixture } from "../lib/gaming/competitions/correctFixture";
import { MinimumParticipationNotMetError, UnsupportedActivityKeyError } from "../lib/gaming/competitions/types";
import type { ParticipationAttestationInput } from "../lib/gaming/competitions/types";
import type { SoccerFormatKey } from "../lib/gaming/competitions/formats";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";
// The REAL route handlers, called with real user access tokens against the real local database.
import { POST as generalCreateRoute } from "../app/api/gaming/competitions/route";
import { POST as hostCreateRoute } from "../app/api/gaming/host/competition/route";

/**
 * UG-CR-GATE-SSS-001 — Small-Sided Soccer Format Rules Foundation, against a real (disposable, loopback-only) Postgres.
 *
 * Proves: the registry rows equal the accepted values and the TypeScript mirror; every numeric invariant is enforced by the database
 * itself; the migration applies over existing 5v5 rows without altering them; the minimum-participation threshold of every format is
 * enforced at N−1 (rejected) and N (accepted) by evidence submission, finalization and correction; the existing HTTP creation paths still
 * cannot create or select 6v6–8v8; and no browser caller can read or write the registry.
 *
 * Non-5v5 participation fixtures are BOUNDED SERVICE-SIDE CONTRACT FIXTURES: a competition is built through the ordinary 5v5 domain flow and its
 * format is then set by one service-role row update. No public creation path is used or widened to make that possible.
 */

const env = loadEnv("development", process.cwd(), "");
const supabaseUrl = env.SUPABASE_URL;
requireLocalSupabase(supabaseUrl);
const supabaseServiceRoleKey = env.SUPABASE_SERVICE_ROLE_KEY;
const supabaseAnonKey = env.SUPABASE_ANON_KEY;
if (!supabaseUrl || !supabaseServiceRoleKey || !supabaseAnonKey) {
  throw new Error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are required for contract tests.");
}

// Raw pg runs rolled-back DDL/negative controls. The URL is supplied explicitly, never read from .env.local, and must be loopback.
const supabaseDbUrl = process.env.COMPETITIONS_LOCAL_DB_URL ?? "";
if (!/^postgresql:\/\/[^@]+@(127\.0\.0\.1|localhost|\[::1\]):\d+\//.test(supabaseDbUrl)) {
  throw new Error("COMPETITIONS_LOCAL_DB_URL must be set to a loopback Postgres URL for the format-foundation contract tests.");
}

const compRepo = new SupabaseCompetitionsRepository(supabaseUrl, supabaseServiceRoleKey);
const hostRepo = new SupabaseHostRepository(supabaseUrl, supabaseServiceRoleKey);
const gamingRepo = new SupabaseGamingRepository(supabaseUrl, supabaseServiceRoleKey);
const service = createClient(supabaseUrl, supabaseServiceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });

/** The accepted SSS-001 values, written out independently of the implementation (the Execution Addendum's tables). */
const KEYS = ["SOCCER_5V5", "SOCCER_6V6", "SOCCER_7V7", "SOCCER_8V8"] as const;
const ACCEPTED_ROWS = [
  ["SOCCER_5V5", 5, 4, 4, 5, 8, 5, 8, 5, 10, 10, 2, 10, 3, 10, 30, 15],
  ["SOCCER_6V6", 6, 5, 5, 6, 10, 6, 10, 6, 12, 12, 2, 12, 3, 10, 30, 15],
  ["SOCCER_7V7", 7, 6, 6, 7, 12, 7, 12, 7, 14, 14, 2, 15, 5, 10, 45, 15],
  ["SOCCER_8V8", 8, 7, 7, 8, 14, 8, 14, 8, 16, 16, 2, 15, 5, 10, 45, 15],
] as const;
const ACCEPTED_PLAYERS: Record<(typeof KEYS)[number], { playersOnField: number; minimumNormalResult: number }> = {
  SOCCER_5V5: { playersOnField: 5, minimumNormalResult: 4 }, SOCCER_6V6: { playersOnField: 6, minimumNormalResult: 5 },
  SOCCER_7V7: { playersOnField: 7, minimumNormalResult: 6 }, SOCCER_8V8: { playersOnField: 8, minimumNormalResult: 7 },
};
// Loaded lazily: until the module exists, only the tests that need the TypeScript mirror can fail.
const loadFormats = () => import("../lib/gaming/competitions/formats");

const RUN = randomUUID().slice(0, 8);
const inMs = (ms: number) => new Date(Date.now() + ms).toISOString();
const TABLE = "competition_format_rules";

interface Person { authUserId: string; gamingMemberId: string; email: string }
const authUsers: string[] = [];
const operators: string[] = [];
let counter = 0;

async function newPerson(label: string): Promise<Person> {
  const email = `format-foundation-${RUN}-${counter++}@example.com`;
  const { data, error } = await service.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("Could not create a test auth user.");
  authUsers.push(data.user.id);
  const member = await gamingRepo.createGamingMember(data.user.id, `${label} ${RUN}`);
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
  const anon = createClient(supabaseUrl, supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const verified = await anon.auth.verifyOtp({ token_hash: link.data.properties.hashed_token, type: "email" });
  const token = verified.data.session?.access_token;
  if (!token) throw new Error("No session for the test member.");
  return token;
}

const bearer = (token: string, body: unknown) =>
  new Request("http://localhost/probe", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });

async function rawTransaction<T>(fn: (db: Client) => Promise<T>): Promise<T> {
  const db = new Client({ connectionString: supabaseDbUrl, statement_timeout: 30000 });
  await db.connect();
  try {
    await db.query("begin");
    return await fn(db);
  } finally {
    await db.query("rollback").catch(() => {});
    await db.end().catch(() => {});
  }
}

/** Runs one statement inside a transaction that is always rolled back, and returns the database error it raised (or null). */
async function violation(statement: string): Promise<{ code?: string; constraint?: string } | null> {
  return rawTransaction(async (db) => {
    try {
      await db.query(statement);
      return null;
    } catch (err) {
      const e = err as { code?: string; constraint?: string };
      return { code: e.code, constraint: e.constraint };
    }
  });
}

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
}, 120000);

// Best effort only: finalizations and audit rows pin their members, so a failed delete is expected and silent by design. A database reset
// restores a clean state, and this file's identities are unique per run.
afterAll(async () => {
  if (operators.length > 0) await service.from("authority_grants").delete().in("gaming_member_id", operators);
  if (reviewer) await service.from("authority_grants").delete().eq("gaming_member_id", reviewer.gamingMemberId);
  for (const id of authUsers) await service.auth.admin.deleteUser(id).catch(() => {});
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
}, 300000);

function toRegistryShape(row: Record<string, any>) {
  return {
    formatKey: row.format_key,
    playersOnField: row.players_on_field,
    minimumToStartOrContinue: row.minimum_to_start_or_continue,
    minimumActualParticipantsForNormalResult: row.minimum_actual_participants_normal_result,
    roster: {
      defaultMinimum: row.roster_default_minimum, defaultMaximum: row.roster_default_maximum,
      configurableMinimumRange: { low: row.roster_minimum_range_low, high: row.roster_minimum_range_high },
      configurableMaximumRange: { low: row.roster_maximum_range_low, high: row.roster_maximum_range_high },
      absoluteMaximum: row.roster_absolute_maximum,
    },
    timing: {
      halves: row.halves, minutesPerHalf: row.minutes_per_half, halftimeMinutes: row.halftime_minutes,
      pitchTransitionMinutes: row.pitch_transition_minutes, minimumTeamRestMinutes: row.minimum_team_rest_minutes,
      knockoutShootoutReserveMinutes: row.knockout_shootout_reserve_minutes,
    },
  };
}

describe("[registry] the database rows are the accepted values and equal the TypeScript mirror", () => {
  it("holds exactly the four accepted formats, and every row deep-equals the TypeScript registry (parity both ways)", async () => {
    const { SOCCER_FORMAT_KEYS, SOCCER_FORMAT_RULES } = await loadFormats();
    const { data, error } = await service.from(TABLE).select("*").order("format_key");
    expect(error).toBeNull();
    expect((data ?? []).map((r) => r.format_key)).toEqual(["SOCCER_5V5", "SOCCER_6V6", "SOCCER_7V7", "SOCCER_8V8"]);
    for (const row of data ?? []) {
      expect(toRegistryShape(row), row.format_key).toEqual(SOCCER_FORMAT_RULES[row.format_key as SoccerFormatKey]);
    }
    expect([...SOCCER_FORMAT_KEYS]).toEqual((data ?? []).map((r) => r.format_key));
  }, 60000);

  it("carries exactly the accepted participation, roster and timing values, written out independently of the implementation", async () => {
    const { data } = await service.from(TABLE).select("*").order("format_key");
    const table = (data ?? []).map((r) => [
      r.format_key, r.players_on_field, r.minimum_to_start_or_continue, r.minimum_actual_participants_normal_result, r.roster_default_minimum, r.roster_default_maximum,
      r.roster_minimum_range_low, r.roster_minimum_range_high, r.roster_maximum_range_low, r.roster_maximum_range_high, r.roster_absolute_maximum,
      r.halves, r.minutes_per_half, r.halftime_minutes, r.pitch_transition_minutes, r.minimum_team_rest_minutes, r.knockout_shootout_reserve_minutes,
    ]);
    expect(table).toEqual(ACCEPTED_ROWS.map((r) => [...r]));
  }, 60000);

  it("stores no substitute count: the table has no such column", async () => {
    const columns = await rawTransaction(async (db) => (await db.query("select column_name from information_schema.columns where table_schema = 'public' and table_name = $1", [TABLE])).rows.map((r) => r.column_name as string));
    expect(columns.length).toBe(17);
    expect(columns.filter((c) => /substitut/i.test(c))).toEqual([]);
  }, 60000);
});

describe("[constraints] the database itself enforces every numeric invariant", () => {
  it("the table's constraint inventory is exactly the primary key plus the fifteen named invariants", async () => {
    const names = await rawTransaction(async (db) => (await db.query("select conname from pg_constraint where conrelid = 'public.competition_format_rules'::regclass order by conname")).rows.map((r) => r.conname as string));
    expect(names).toEqual([
      "competition_format_rules_default_maximum_in_range", "competition_format_rules_default_minimum_in_range",
      "competition_format_rules_default_minimum_not_above_maximum", "competition_format_rules_key_closed_set",
      "competition_format_rules_key_matches_players", "competition_format_rules_maximum_range_ordered",
      "competition_format_rules_maximum_within_absolute", "competition_format_rules_minimum_range_ordered",
      "competition_format_rules_normal_result_range", "competition_format_rules_pkey", "competition_format_rules_players_range",
      "competition_format_rules_players_within_minimum_range", "competition_format_rules_ranges_jointly_satisfiable",
      "competition_format_rules_start_continue_range", "competition_format_rules_timing_positive", "competition_format_rules_two_halves",
    ].sort());
  }, 60000);

  const P = "competition_format_rules_";
  // Each statement is run against the 7v7 row (players 7, minimum range 7–12, maximum range 7–14, absolute 14) inside a rolled-back transaction.
  const CASES: Array<[string, string, string[]]> = [
    ["players on field above 8", "update competition_format_rules set players_on_field = 9 where format_key = 'SOCCER_7V7'", ["players_range", "key_matches_players", "players_within_minimum_range"]],
    ["players on field below 5", "update competition_format_rules set players_on_field = 4 where format_key = 'SOCCER_7V7'", ["players_range", "key_matches_players", "start_continue_range", "normal_result_range"]],
    ["a key that does not match its players on field", "update competition_format_rules set players_on_field = 6 where format_key = 'SOCCER_7V7'", ["key_matches_players"]],
    ["a key outside the closed set", "update competition_format_rules set format_key = 'SOCCER_9V9' where format_key = 'SOCCER_7V7'", ["key_closed_set", "key_matches_players"]],
    ["a minimum-to-start above players on field", "update competition_format_rules set minimum_to_start_or_continue = 8 where format_key = 'SOCCER_7V7'", ["start_continue_range"]],
    ["a minimum-to-start below one", "update competition_format_rules set minimum_to_start_or_continue = 0 where format_key = 'SOCCER_7V7'", ["start_continue_range"]],
    ["a normal-result minimum above players on field", "update competition_format_rules set minimum_actual_participants_normal_result = 8 where format_key = 'SOCCER_7V7'", ["normal_result_range"]],
    ["a normal-result minimum below one", "update competition_format_rules set minimum_actual_participants_normal_result = 0 where format_key = 'SOCCER_7V7'", ["normal_result_range"]],
    ["a roster-minimum range that starts below players on field", "update competition_format_rules set roster_minimum_range_low = 6 where format_key = 'SOCCER_7V7'", ["players_within_minimum_range"]],
    ["a default roster minimum below its range", "update competition_format_rules set roster_default_minimum = 6 where format_key = 'SOCCER_7V7'", ["default_minimum_in_range"]],
    ["a default roster minimum above its range", "update competition_format_rules set roster_default_minimum = 13 where format_key = 'SOCCER_7V7'", ["default_minimum_in_range", "default_minimum_not_above_maximum"]],
    ["a default roster maximum below its range", "update competition_format_rules set roster_default_maximum = 6 where format_key = 'SOCCER_7V7'", ["default_maximum_in_range", "default_minimum_not_above_maximum"]],
    ["a default roster maximum above its range", "update competition_format_rules set roster_default_maximum = 15 where format_key = 'SOCCER_7V7'", ["default_maximum_in_range"]],
    ["an inverted roster-minimum range", "update competition_format_rules set roster_minimum_range_high = 6 where format_key = 'SOCCER_7V7'", ["minimum_range_ordered", "default_minimum_in_range"]],
    ["an inverted roster-maximum range", "update competition_format_rules set roster_maximum_range_high = 6 where format_key = 'SOCCER_7V7'", ["maximum_range_ordered", "default_maximum_in_range", "ranges_jointly_satisfiable", "maximum_within_absolute"]],
    ["ranges that cannot be satisfied together (minimum range reaches beyond the maximum range)", "update competition_format_rules set roster_minimum_range_high = 15 where format_key = 'SOCCER_7V7'", ["ranges_jointly_satisfiable"]],
    ["a maximum range that ends below the minimum range", "update competition_format_rules set roster_maximum_range_high = 11 where format_key = 'SOCCER_7V7'", ["default_maximum_in_range", "ranges_jointly_satisfiable"]],
    ["an absolute roster maximum below the configurable maximum", "update competition_format_rules set roster_absolute_maximum = 13 where format_key = 'SOCCER_7V7'", ["maximum_within_absolute"]],
    ["three halves", "update competition_format_rules set halves = 3 where format_key = 'SOCCER_7V7'", ["two_halves"]],
    ["one half", "update competition_format_rules set halves = 1 where format_key = 'SOCCER_7V7'", ["two_halves"]],
    ["zero minutes per half", "update competition_format_rules set minutes_per_half = 0 where format_key = 'SOCCER_7V7'", ["timing_positive"]],
    ["zero halftime", "update competition_format_rules set halftime_minutes = 0 where format_key = 'SOCCER_7V7'", ["timing_positive"]],
    ["a negative pitch transition", "update competition_format_rules set pitch_transition_minutes = -1 where format_key = 'SOCCER_7V7'", ["timing_positive"]],
    ["zero minimum team rest", "update competition_format_rules set minimum_team_rest_minutes = 0 where format_key = 'SOCCER_7V7'", ["timing_positive"]],
    ["a zero shootout reserve", "update competition_format_rules set knockout_shootout_reserve_minutes = 0 where format_key = 'SOCCER_7V7'", ["timing_positive"]],
  ];

  it.each(CASES)("refuses %s with a CHECK violation naming a relevant invariant", async (_label, statement, accepted) => {
    const outcome = await violation(statement);
    expect(outcome?.code, "a CHECK violation (23514) is required").toBe("23514");
    expect(accepted.map((n) => P + n), `constraint ${outcome?.constraint}`).toContain(outcome?.constraint);
  }, 60000);

  it("refuses a duplicate key (23505), a missing value (23502), and a row for a format outside the closed set (23514)", async () => {
    const one = (await service.from(TABLE).select("*").eq("format_key", "SOCCER_5V5").single()).data as Record<string, unknown>;
    const columns = Object.keys(one);
    const insertOf = (overrides: Record<string, unknown>) => {
      const row = { ...one, ...overrides };
      return `insert into competition_format_rules (${columns.join(", ")}) values (${columns.map((c) => (typeof row[c] === "string" ? `'${row[c]}'` : String(row[c]))).join(", ")})`;
    };
    expect((await violation(insertOf({})))?.code).toBe("23505");
    expect((await violation("update competition_format_rules set players_on_field = null where format_key = 'SOCCER_5V5'"))?.code).toBe("23502");
    const outsider = await violation(insertOf({ format_key: "SOCCER_9V9", players_on_field: 9 }));
    expect(outsider?.code).toBe("23514");
  }, 60000);

  it("a rolled-back violation changes nothing: the four rows are still exactly the accepted ones", async () => {
    const { getSoccerFormatRule } = await loadFormats();
    const { data } = await service.from(TABLE).select("*").order("format_key");
    expect((data ?? []).map((r) => r.format_key)).toEqual([...KEYS]);
    for (const row of data ?? []) expect(toRegistryShape(row)).toEqual(getSoccerFormatRule(row.format_key));
  }, 60000);
});

describe("[transition] activity_key is restricted by a foreign key to the registry, and existing 5v5 rows survive it untouched", () => {
  it("the single-value CHECK is gone and a foreign key to the registry is in place", async () => {
    const defs = await rawTransaction(async (db) => (await db.query("select contype, pg_get_constraintdef(oid) as def from pg_constraint where conrelid = 'public.competitions'::regclass and (pg_get_constraintdef(oid) ilike '%activity_key%')")).rows as Array<{ contype: string; def: string }>);
    expect(defs.filter((d) => d.contype === "c")).toEqual([]);
    expect(defs.filter((d) => d.contype === "f").map((d) => d.def)).toEqual(["FOREIGN KEY (activity_key) REFERENCES competition_format_rules(format_key)"]);
  }, 60000);

  it("a competition row cannot name a format that is not in the registry (23503), and the registry's own keys are accepted at the database level", async () => {
    const organizer = await newPerson("FK Organizer");
    const insert = (key: string) => `insert into competitions (activity_key, name, organizer_gaming_member_id, state, public_code) values ('${key}', 'FK probe ${RUN}', '${organizer.gamingMemberId}', 'DRAFT', 'fkprobe${randomUUID().replace(/-/g, "").slice(0, 14)}')`;
    for (const bad of ["SOCCER_9V9", "SOCCER_11V11", "soccer_5v5", "SOCCER_5V5 ", "FUTSAL_5V5"]) expect((await violation(insert(bad)))?.code, bad).toBe("23503");
    for (const good of KEYS) expect(await violation(insert(good)), good).toBeNull();
  }, 60000);

  it("re-applying the SSS-001 migration over the pre-migration state keeps every existing 5v5 row byte-for-byte unchanged", async () => {
    const dir = path.join(process.cwd(), "supabase/migrations");
    const files = readdirSync(dir).filter((f) => /small_sided_soccer_format_rules_foundation/.test(f));
    expect(files).toHaveLength(1);
    const migrationSql = readFileSync(path.join(dir, files[0]), "utf8");
    const organizer = await newPerson("Transition Organizer");

    await rawTransaction(async (db) => {
      // Rebuild the PRE-migration state: no registry, the single-value CHECK on activity_key.
      await db.query("alter table competitions drop constraint competitions_activity_key_fkey");
      await db.query("drop table competition_format_rules");
      await db.query("alter table competitions add constraint competitions_activity_key_check check (activity_key in ('SOCCER_5V5'))");
      // Existing rows, in several lifecycle states, as they were before the migration.
      for (const [i, state] of (["DRAFT", "TEAM_REGISTRATION_OPEN", "READY_TO_PUBLISH", "PUBLISHED", "COMPLETE", "CANCELLED_WITHOUT_CHAMPION"] as const).entries()) {
        await db.query(
          "insert into competitions (activity_key, name, organizer_gaming_member_id, state, public_code) values ('SOCCER_5V5', $1, $2, $3, $4)",
          [`Pre-migration ${i} ${RUN}`, organizer.gamingMemberId, state, `premig${i}${randomUUID().replace(/-/g, "").slice(0, 12)}`]
        );
      }
      const snapshot = async () => (await db.query("select competition_id, activity_key, name, organizer_gaming_member_id, state, public_code, created_at, published_at, cancelled_reason from competitions where name like $1 order by name", [`Pre-migration % ${RUN}`])).rows;
      const before = await snapshot();
      expect(before).toHaveLength(6);

      await db.query(migrationSql);

      expect(await snapshot()).toEqual(before);
      expect((await db.query("select format_key from competition_format_rules order by format_key")).rows.map((r) => r.format_key)).toEqual(["SOCCER_5V5", "SOCCER_6V6", "SOCCER_7V7", "SOCCER_8V8"]);
      const checks = (await db.query("select count(*)::int as n from pg_constraint where conrelid = 'public.competitions'::regclass and contype = 'c' and pg_get_constraintdef(oid) ilike '%activity_key%'")).rows[0].n;
      expect(checks).toBe(0);
      // ...and the data remains usable: a pre-existing row still satisfies the new constraint, and a registry format can now be recorded.
      await db.query("update competitions set name = name where name like $1", [`Pre-migration % ${RUN}`]);
      await db.query("update competitions set activity_key = 'SOCCER_6V6' where name = $1", [`Pre-migration 0 ${RUN}`]);
      expect((await db.query("select activity_key from competitions where name = $1", [`Pre-migration 0 ${RUN}`])).rows[0].activity_key).toBe("SOCCER_6V6");
    });
  }, 120000);
});

describe("[participation] the minimum actual participants for a normal result is each format's own registry value (N−1 rejected, N accepted)", () => {
  async function enroll(competitionId: string, teamId: string, captainId: string, label: string): Promise<string> {
    const member = await newPerson(label);
    await registerForCompetition(compRepo, competitionId, member.gamingMemberId, true);
    const request = await requestJoinTeam(compRepo, competitionId, teamId, member.gamingMemberId);
    await decideJoinRequest(compRepo, request.competitionJoinRequestId, captainId, "APPROVE", false);
    return member.gamingMemberId;
  }

  async function setAttestation(fixtureId: string, memberId: string, participated: boolean) {
    const { data, error } = await service.from("competition_participation_attestations")
      .update({ actually_participated: participated }).eq("competition_fixture_id", fixtureId).eq("gaming_member_id", memberId).eq("is_current", true).select("actually_participated");
    expect(error).toBeNull();
    expect(data).toHaveLength(1);
  }

  const attest = (roster: string[], participating: number): ParticipationAttestationInput[] =>
    roster.map((gamingMemberId, i) => ({ gamingMemberId, actuallyParticipated: i < participating }));

  it.each([...KEYS])("%s: evidence, finalization and correction each enforce the format's threshold", async (formatKey) => {
    const N = ACCEPTED_PLAYERS[formatKey].minimumNormalResult;
    const P = ACCEPTED_PLAYERS[formatKey].playersOnField;

    // A published four-team bracket, built through the ORDINARY (5v5-only) domain flow.
    const organizer = await makeOperator("Organizer");
    const competition = await createCompetition(compRepo, organizer.gamingMemberId, `SSS ${formatKey} ${RUN}`, "SOCCER_5V5");
    const captains = await Promise.all([newPerson("Cap A"), newPerson("Cap B"), newPerson("Cap C"), newPerson("Cap D")]);
    const teams: Array<{ id: string; captain: string }> = [];
    for (let i = 0; i < 4; i++) {
      const team = await addCompetitionTeam(compRepo, competition.competitionId, organizer.gamingMemberId, `Team ${i} ${RUN}`, captains[i].gamingMemberId);
      teams.push({ id: team.competitionTeamId, captain: captains[i].gamingMemberId });
    }
    await openTeamRegistration(compRepo, competition.competitionId, organizer.gamingMemberId);
    await closeTeamRegistration(compRepo, competition.competitionId, organizer.gamingMemberId);
    const published = await publishCompetition(compRepo, competition.competitionId, organizer.gamingMemberId, teams[0].id, teams[1].id, teams[2].id, teams[3].id, inMs(3_600_000), inMs(7_200_000), inMs(10_800_000));

    // BOUNDED SERVICE-SIDE CONTRACT FIXTURE: record this competition's format. No public creation path is involved.
    if (formatKey !== "SOCCER_5V5") {
      const { data, error } = await service.from("competitions").update({ activity_key: formatKey }).eq("competition_id", competition.competitionId).select("activity_key");
      expect(error).toBeNull();
      expect(data).toEqual([{ activity_key: formatKey }]);
    }
    expect((await service.from("competitions").select("activity_key").eq("competition_id", competition.competitionId).single()).data?.activity_key).toBe(formatKey);

    // Rosters of exactly the players on the field (registered roster ≠ actual participation).
    const rosterA = await Promise.all(Array.from({ length: P }, (_, i) => enroll(competition.competitionId, teams[0].id, teams[0].captain, `A${i}`)));
    const rosterB = await Promise.all(Array.from({ length: P }, (_, i) => enroll(competition.competitionId, teams[1].id, teams[1].captain, `B${i}`)));
    const sf1 = published.semifinal1FixtureId;
    await declareRoster(compRepo, sf1, teams[0].id, teams[0].captain, false, null, rosterA);
    await declareRoster(compRepo, sf1, teams[1].id, teams[1].captain, false, null, rosterB);
    const scorekeeper = await newPerson("Scorekeeper");
    await appointScorekeeper(compRepo, sf1, organizer.gamingMemberId, scorekeeper.gamingMemberId);
    const goals = [{ scorerGamingMemberId: rosterA[0], competitionTeamId: teams[0].id }];
    const submit = (a: number, b: number) =>
      submitFixtureEvidence(compRepo, sf1, scorekeeper.gamingMemberId, 1, 0, goals, [], [...attest(rosterA, a), ...attest(rosterB, b)], null);
    const message = (promise: Promise<unknown>) => promise.then(() => null, (e: unknown) => e as Error);

    // 1. Evidence: N−1 on either team is refused, with that format's own number in the message.
    for (const [a, b] of [[N - 1, P], [P, N - 1], [N - 1, N - 1]] as Array<[number, number]>) {
      const refused = await message(submit(a, b));
      expect(refused, `${formatKey} evidence with ${a}/${b}`).toBeInstanceOf(MinimumParticipationNotMetError);
      expect(refused!.message).toContain(`at least ${N} actually-participating`);
    }
    // ...and exactly N on each team is accepted.
    const accepted = await submit(N, N);
    expect(accepted.alreadySubmitted).toBe(false);

    // 2. Finalization re-derives the count from current data: drop one participant below N, and it refuses.
    await setAttestation(sf1, rosterB[1], false);
    // (exactly N participants were attested; one fewer leaves N−1 for team B)
    const finalizeRefused = await message(finalizeFixture(compRepo, sf1, organizer.gamingMemberId));
    expect(finalizeRefused, `${formatKey} finalize at N−1`).toBeInstanceOf(MinimumParticipationNotMetError);
    expect(finalizeRefused!.message).toContain(`at least ${N} actually-participating`);
    await setAttestation(sf1, rosterB[1], true);
    const finalized = await finalizeFixture(compRepo, sf1, organizer.gamingMemberId);
    expect(finalized.outcomeType).toBe("NORMAL");

    // 3. Correction re-derives it too.
    await setAttestation(sf1, rosterA[1], false);
    const correctRefused = await message(correctFixture(compRepo, sf1, organizer.gamingMemberId, "Contract correction", 1, 0, goals, [], null));
    expect(correctRefused, `${formatKey} correction at N−1`).toBeInstanceOf(MinimumParticipationNotMetError);
    expect(correctRefused!.message).toContain(`at least ${N} actually-participating`);
    await setAttestation(sf1, rosterA[1], true);
    const corrected = await correctFixture(compRepo, sf1, organizer.gamingMemberId, "Contract correction", 1, 0, goals, [], null);
    expect(corrected).toBeTruthy();
  }, 240000);

  it("5v5 remains threshold 4 while 6v6, 7v7 and 8v8 are 5, 6 and 7 — the four registry values the database actually uses", async () => {
    const used = await rawTransaction(async (db) => (await db.query("select format_key, minimum_actual_participants_normal_result as n from competition_format_rules order by format_key")).rows.map((r) => [r.format_key, r.n]));
    expect(used).toEqual([["SOCCER_5V5", 4], ["SOCCER_6V6", 5], ["SOCCER_7V7", 6], ["SOCCER_8V8", 7]]);
  }, 60000);
});

describe("[creation paths] the existing HTTP and RPC creation paths still cannot create or select 6v6–8v8", () => {
  const NON_5V5 = ["SOCCER_6V6", "SOCCER_7V7", "SOCCER_8V8"] as const;

  it("the general create route accepts 5v5 as before and refuses every other registry format — creating nothing", async () => {
    const operator = await makeOperator("Operator");
    const token = await tokenFor(operator);
    const created = await generalCreateRoute(bearer(token, { name: `Allowed ${RUN}`, activityKey: "SOCCER_5V5" }));
    expect(created.status).toBe(201);
    for (const key of NON_5V5) {
      const res = await generalCreateRoute(bearer(token, { name: `Refused ${key} ${RUN}`, activityKey: key }));
      expect(res.status, key).toBe(400);
      expect(JSON.stringify(await res.json())).toContain("SOCCER_5V5");
    }
    const { data } = await service.from("competitions").select("name, activity_key").eq("organizer_gaming_member_id", operator.gamingMemberId);
    expect(data).toEqual([{ name: `Allowed ${RUN}`, activity_key: "SOCCER_5V5" }]);
  }, 120000);

  it("the creation RPC itself still refuses every other format with the existing typed error", async () => {
    const operator = await makeOperator("RPC Operator");
    for (const key of NON_5V5) await expect(createCompetition(compRepo, operator.gamingMemberId, `RPC ${key} ${RUN}`, key)).rejects.toBeInstanceOf(UnsupportedActivityKeyError);
    expect((await createCompetition(compRepo, operator.gamingMemberId, `RPC 5v5 ${RUN}`, "SOCCER_5V5")).state).toBe("DRAFT");
    const { data } = await service.from("competitions").select("activity_key").eq("organizer_gaming_member_id", operator.gamingMemberId);
    expect(data).toEqual([{ activity_key: "SOCCER_5V5" }]);
  }, 120000);

  it("an approved host cannot select a format: whatever activityKey the request carries, the one pilot is 5v5, and the capability is spent once", async () => {
    const host = await newPerson("Host");
    const application = {
      venueName: `Venue ${RUN}`, cityArea: "Fictional Heights", playingFields: 2,
      venueDescription: "A fictional venue used only by the local contract suite; it runs imaginary leagues.",
      expectedWindow: "weekend of 14 November", expectedTeamCount: 4,
      confirmAllAdults: true, confirmIndependentScorekeepers: true, confirmPilotExclusions: true,
    };
    const submitted = await submitHostApplication(hostRepo, host.gamingMemberId, application);
    await asGovernance(() => decideHostApplication(hostRepo, reviewer.gamingMemberId, submitted.publicCode, "APPROVE", null));
    process.env.BECOME_A_HOST_SCHEMA_READY = "true";
    try {
      const token = await tokenFor(host);
      const first = await hostCreateRoute(bearer(token, { name: `Host Pilot ${RUN}`, activityKey: "SOCCER_8V8" }));
      expect(first.status).toBe(201);
      for (const key of NON_5V5) {
        const again = await hostCreateRoute(bearer(token, { name: `Second ${key} ${RUN}`, activityKey: key }));
        expect(again.status, key).toBe(409);
      }
    } finally {
      delete process.env.BECOME_A_HOST_SCHEMA_READY;
    }
    const { data } = await service.from("competitions").select("name, activity_key").eq("organizer_gaming_member_id", host.gamingMemberId);
    expect(data).toEqual([{ name: `Host Pilot ${RUN}`, activity_key: "SOCCER_5V5" }]);
  }, 120000);
});

describe("[access] the registry is internal server authority: no browser caller can read or write it", () => {
  it("anon and authenticated hold no privilege of any kind on the table; the server role may read it and nothing else; row-level security is on", async () => {
    const privileges = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"];
    const answers = await rawTransaction(async (db) => {
      const out: Record<string, Record<string, boolean>> = {};
      for (const role of ["anon", "authenticated", "service_role", "public"]) {
        out[role] = {};
        for (const priv of privileges) {
          const sql = role === "public"
            ? `select has_table_privilege('public', 'public.competition_format_rules', '${priv}') as ok`
            : `select has_table_privilege('${role}', 'public.competition_format_rules', '${priv}') as ok`;
          out[role][priv] = (await db.query(sql)).rows[0].ok as boolean;
        }
      }
      out.rls = { enabled: (await db.query("select relrowsecurity as on from pg_class where oid = 'public.competition_format_rules'::regclass")).rows[0].on as boolean };
      return out;
    });
    for (const role of ["anon", "authenticated", "public"]) for (const priv of privileges) expect(answers[role][priv], `${role} ${priv}`).toBe(false);
    expect(answers.service_role).toEqual({ SELECT: true, INSERT: false, UPDATE: false, DELETE: false, TRUNCATE: false, REFERENCES: false, TRIGGER: false });
    expect(answers.rls.enabled).toBe(true);
  }, 60000);

  it("through the browser-facing API, the anon key and a signed-in member can neither read nor change a single row", async () => {
    const member = await newPerson("Browser Caller");
    const token = await tokenFor(member);
    const clients = [
      ["anon key", createClient(supabaseUrl, supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false } })],
      ["signed-in member", createClient(supabaseUrl, supabaseAnonKey, { auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: `Bearer ${token}` } } })],
    ] as const;
    for (const [label, client] of clients) {
      const read = await client.from(TABLE).select("*");
      expect(read.error, `${label} select`).not.toBeNull();
      expect(read.data ?? []).toEqual([]);
      expect((await client.from(TABLE).update({ minimum_actual_participants_normal_result: 1 }).eq("format_key", "SOCCER_5V5").select()).error, `${label} update`).not.toBeNull();
      expect((await client.from(TABLE).delete().eq("format_key", "SOCCER_5V5").select()).error, `${label} delete`).not.toBeNull();
      expect((await client.from(TABLE).insert({ format_key: "SOCCER_5V5" })).error, `${label} insert`).not.toBeNull();
    }
  }, 120000);

  it("even the server role cannot change the registry: writes are denied, and the rows are still exactly the accepted ones afterwards", async () => {
    expect((await service.from(TABLE).update({ minimum_actual_participants_normal_result: 1 }).eq("format_key", "SOCCER_5V5").select()).error?.code).toBe("42501");
    expect((await service.from(TABLE).delete().eq("format_key", "SOCCER_8V8").select()).error?.code).toBe("42501");
    expect((await service.from(TABLE).insert({ format_key: "SOCCER_5V5" })).error?.code).toBe("42501");
    const { getSoccerFormatRule, SOCCER_FORMAT_KEYS } = await loadFormats();
    const { data } = await service.from(TABLE).select("*").order("format_key");
    expect((data ?? []).map(toRegistryShape)).toEqual(SOCCER_FORMAT_KEYS.map((k) => getSoccerFormatRule(k)));
  }, 60000);
});
