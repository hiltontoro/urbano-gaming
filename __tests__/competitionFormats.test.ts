import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

/**
 * UG-CR-GATE-SSS-001 — Small-Sided Soccer Format Rules Foundation (unit level).
 *
 * The registry is INTERNAL server authority. These tests pin the exact accepted V1 values, the fail-closed handling of unknown or
 * malformed formats, every numeric invariant, the parity between the TypeScript mirror and the migration's own seed, the 5v5
 * compatibility surface, and the guarantee that merely having registry rows does not make 6v6–8v8 selectable or creatable.
 *
 * The module under test is loaded lazily so that, before it exists, each test fails on its own (red-first evidence) rather than the
 * whole file failing to import.
 */

const REPO_ROOT = process.cwd();
const loadFormats = () => import("../lib/gaming/competitions/formats");

/** The accepted SSS-001 values, written out independently of the implementation (Execution Addendum — Exact Accepted SSS-001 Registry Values). */
const ACCEPTED = {
  SOCCER_5V5: { playersOnField: 5, start: 4, normal: 4, defMin: 5, defMax: 8, minRange: [5, 8], maxRange: [5, 10], absMax: 10, half: 10, halftime: 3, transition: 10, rest: 30, reserve: 15 },
  SOCCER_6V6: { playersOnField: 6, start: 5, normal: 5, defMin: 6, defMax: 10, minRange: [6, 10], maxRange: [6, 12], absMax: 12, half: 12, halftime: 3, transition: 10, rest: 30, reserve: 15 },
  SOCCER_7V7: { playersOnField: 7, start: 6, normal: 6, defMin: 7, defMax: 12, minRange: [7, 12], maxRange: [7, 14], absMax: 14, half: 15, halftime: 5, transition: 10, rest: 45, reserve: 15 },
  SOCCER_8V8: { playersOnField: 8, start: 7, normal: 7, defMin: 8, defMax: 14, minRange: [8, 14], maxRange: [8, 16], absMax: 16, half: 15, halftime: 5, transition: 10, rest: 45, reserve: 15 },
} as const;
const KEYS = Object.keys(ACCEPTED) as Array<keyof typeof ACCEPTED>;

function migrationFile(): string {
  const dir = path.join(REPO_ROOT, "supabase/migrations");
  const matches = readdirSync(dir).filter((f) => /small_sided_soccer_format_rules_foundation/.test(f));
  if (matches.length !== 1) throw new Error(`expected exactly one SSS-001 migration, found ${matches.length}`);
  return path.join(dir, matches[0]);
}

describe("the registry holds exactly the four accepted formats and their exact accepted values", () => {
  it("has exactly SOCCER_5V5, SOCCER_6V6, SOCCER_7V7 and SOCCER_8V8 — nothing else, in this order", async () => {
    const { SOCCER_FORMAT_KEYS, SOCCER_FORMAT_RULES } = await loadFormats();
    expect([...SOCCER_FORMAT_KEYS]).toEqual(["SOCCER_5V5", "SOCCER_6V6", "SOCCER_7V7", "SOCCER_8V8"]);
    expect(Object.keys(SOCCER_FORMAT_RULES)).toEqual(["SOCCER_5V5", "SOCCER_6V6", "SOCCER_7V7", "SOCCER_8V8"]);
  });

  it.each(KEYS)("%s carries exactly the accepted players-on-field, participation, roster and timing values", async (key) => {
    const { getSoccerFormatRule } = await loadFormats();
    const a = ACCEPTED[key];
    expect(getSoccerFormatRule(key)).toEqual({
      formatKey: key,
      playersOnField: a.playersOnField,
      minimumToStartOrContinue: a.start,
      minimumActualParticipantsForNormalResult: a.normal,
      roster: {
        defaultMinimum: a.defMin, defaultMaximum: a.defMax,
        configurableMinimumRange: { low: a.minRange[0], high: a.minRange[1] },
        configurableMaximumRange: { low: a.maxRange[0], high: a.maxRange[1] },
        absoluteMaximum: a.absMax,
      },
      timing: {
        halves: 2, minutesPerHalf: a.half, halftimeMinutes: a.halftime, pitchTransitionMinutes: a.transition,
        minimumTeamRestMinutes: a.rest, knockoutShootoutReserveMinutes: a.reserve,
      },
    });
  });

  it("keeps 'minimum to start or continue' and 'minimum actual participants for a normal result' as two separate facts, even where they match", async () => {
    const { getSoccerFormatRule } = await loadFormats();
    for (const key of KEYS) {
      const rule = getSoccerFormatRule(key);
      expect(Object.keys(rule)).toEqual(expect.arrayContaining(["minimumToStartOrContinue", "minimumActualParticipantsForNormalResult"]));
      expect(rule.minimumToStartOrContinue).toBe(ACCEPTED[key].start);
      expect(rule.minimumActualParticipantsForNormalResult).toBe(ACCEPTED[key].normal);
    }
  });

  it("5v5 keeps the historical threshold of four actually-participating members", async () => {
    const { getSoccerFormatRule } = await loadFormats();
    expect(getSoccerFormatRule("SOCCER_5V5").minimumActualParticipantsForNormalResult).toBe(4);
    expect(getSoccerFormatRule("SOCCER_5V5").minimumToStartOrContinue).toBe(4);
  });

  it("stores no substitute count: substitutes are derived from roster size and players on field", async () => {
    const mod = await loadFormats();
    for (const key of KEYS) {
      const rule = mod.getSoccerFormatRule(key);
      expect(JSON.stringify(rule).toLowerCase()).not.toContain("substitut");
      expect(mod.substitutesFor(key, ACCEPTED[key].defMax)).toBe(ACCEPTED[key].defMax - ACCEPTED[key].playersOnField);
      expect(mod.substitutesFor(key, ACCEPTED[key].playersOnField)).toBe(0);
    }
    expect(mod.substitutesFor("SOCCER_7V7", 14)).toBe(7);
  });

  it("is immutable: neither the registry, a rule, nor any nested value can be altered", async () => {
    const { SOCCER_FORMAT_RULES, SOCCER_FORMAT_KEYS, getSoccerFormatRule } = await loadFormats();
    const frozen = (value: unknown): boolean => {
      if (value === null || typeof value !== "object") return true;
      return Object.isFrozen(value) && Object.values(value as Record<string, unknown>).every(frozen);
    };
    expect(frozen(SOCCER_FORMAT_RULES)).toBe(true);
    expect(Object.isFrozen(SOCCER_FORMAT_KEYS)).toBe(true);
    const rule = getSoccerFormatRule("SOCCER_5V5") as unknown as Record<string, any>;
    expect(() => { rule.playersOnField = 11; }).toThrow();
    expect(() => { rule.roster.absoluteMaximum = 99; }).toThrow();
    expect(() => { (SOCCER_FORMAT_RULES as Record<string, unknown>).SOCCER_11V11 = {}; }).toThrow();
    expect(getSoccerFormatRule("SOCCER_5V5").playersOnField).toBe(5);
  });
});

describe("unknown, missing and malformed formats fail closed", () => {
  const BAD: unknown[] = [
    undefined, null, 5, 5.5, true, false, {}, [], ["SOCCER_5V5"], { formatKey: "SOCCER_5V5" }, () => "SOCCER_5V5", Symbol("SOCCER_5V5"),
    "", " ", "5v5", "5V5", "SOCCER", "SOCCER_", "SOCCER_5V5 ", " SOCCER_5V5", "SOCCER_5V5\n", "SOCCER_5V5\u0000", "soccer_5v5", "Soccer_5V5", "SOCCER-5V5",
    "SOCCER_4V4", "SOCCER_9V9", "SOCCER_10V10", "SOCCER_11V11", "SOCCER_5V6", "SOCCER_05V05", "SOCCER_5V5_EXTRA", "FUTSAL_5V5", "SOCCER_5V5;DROP TABLE competitions",
    "__proto__", "constructor", "prototype", "toString", "valueOf", "hasOwnProperty", "isPrototypeOf",
  ];

  it.each(BAD.map((v, i) => [i, typeof v === "symbol" ? "Symbol" : typeof v === "function" ? "function" : JSON.stringify(v) ?? String(v)] as const))(
    "rejects candidate #%i (%s)", async (index) => {
      const { isSoccerFormatKey, getSoccerFormatRule } = await loadFormats();
      const candidate = BAD[index];
      expect(isSoccerFormatKey(candidate)).toBe(false);
      expect(() => getSoccerFormatRule(candidate)).toThrow();
    }
  );

  it("the refusal is the dedicated typed error, and never echoes the rejected value", async () => {
    const { getSoccerFormatRule, UnsupportedSoccerFormatError } = await loadFormats();
    let caught: unknown;
    try { getSoccerFormatRule("SOCCER_11V11 <script>alert(1)</script>"); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(UnsupportedSoccerFormatError);
    expect((caught as Error).message).not.toContain("script");
    expect((caught as Error).message).not.toContain("11V11");
  });

  it("the refusal lives in the registry module and is not an exported Competitions domain error: no HTTP status is implied for an internal registry", async () => {
    const types = await import("../lib/gaming/competitions/types");
    expect(Object.keys(types)).not.toContain("UnsupportedSoccerFormatError");
    const { statusForCompetitionsError } = await import("../lib/gaming/competitions/httpAuth");
    const { UnsupportedSoccerFormatError } = await loadFormats();
    expect(statusForCompetitionsError(new UnsupportedSoccerFormatError())).toBeNull();
  });

  it("accepts exactly the four keys", async () => {
    const { isSoccerFormatKey } = await loadFormats();
    for (const key of KEYS) expect(isSoccerFormatKey(key)).toBe(true);
  });
});

describe("numeric invariants: playersOnField ≤ roster minimum ≤ roster maximum ≤ absolute roster maximum", () => {
  it.each(KEYS)("%s: every accepted value satisfies the full chain and range consistency", async (key) => {
    const { getSoccerFormatRule, findFormatRuleViolations } = await loadFormats();
    const rule = getSoccerFormatRule(key);
    const { roster } = rule;
    expect(rule.playersOnField).toBeLessThanOrEqual(roster.configurableMinimumRange.low);
    expect(roster.configurableMinimumRange.low).toBeLessThanOrEqual(roster.defaultMinimum);
    expect(roster.defaultMinimum).toBeLessThanOrEqual(roster.configurableMinimumRange.high);
    expect(roster.defaultMinimum).toBeLessThanOrEqual(roster.defaultMaximum);
    expect(roster.configurableMaximumRange.low).toBeLessThanOrEqual(roster.defaultMaximum);
    expect(roster.defaultMaximum).toBeLessThanOrEqual(roster.configurableMaximumRange.high);
    expect(roster.configurableMinimumRange.high).toBeLessThanOrEqual(roster.configurableMaximumRange.high);
    expect(roster.configurableMinimumRange.low).toBeLessThanOrEqual(roster.configurableMaximumRange.low);
    expect(roster.configurableMaximumRange.high).toBeLessThanOrEqual(roster.absoluteMaximum);
    expect(rule.minimumToStartOrContinue).toBeLessThanOrEqual(rule.playersOnField);
    expect(rule.minimumActualParticipantsForNormalResult).toBeLessThanOrEqual(rule.playersOnField);
    expect(findFormatRuleViolations(rule)).toEqual([]);
  });

  it.each(KEYS)("%s: checkRosterConfiguration accepts a pair exactly when the whole chain and both ranges hold (exhaustive over 0–20)", async (key) => {
    const { getSoccerFormatRule, checkRosterConfiguration } = await loadFormats();
    const rule = getSoccerFormatRule(key);
    const r = rule.roster;
    let accepted = 0;
    for (let min = 0; min <= 20; min++) {
      for (let max = 0; max <= 20; max++) {
        const expected =
          rule.playersOnField <= min && min <= max && max <= r.absoluteMaximum &&
          min >= r.configurableMinimumRange.low && min <= r.configurableMinimumRange.high &&
          max >= r.configurableMaximumRange.low && max <= r.configurableMaximumRange.high;
        const outcome = checkRosterConfiguration(key, min, max);
        expect(outcome.valid, `${key} min=${min} max=${max}`).toBe(expected);
        if (!expected) expect(outcome.valid === false && outcome.reasons.length > 0).toBe(true);
        if (expected) accepted++;
      }
    }
    expect(accepted).toBeGreaterThan(0);
    expect(checkRosterConfiguration(key, r.defaultMinimum, r.defaultMaximum).valid).toBe(true);
  });

  it("checkRosterConfiguration rejects non-integers, NaN, infinities, strings and unknown formats outright", async () => {
    const { checkRosterConfiguration } = await loadFormats();
    for (const bad of [5.5, NaN, Infinity, -Infinity, "6", null, undefined, {}, [], -1]) {
      expect(checkRosterConfiguration("SOCCER_5V5", bad as number, 8).valid, String(bad)).toBe(false);
      expect(checkRosterConfiguration("SOCCER_5V5", 5, bad as number).valid, String(bad)).toBe(false);
    }
    expect(checkRosterConfiguration("SOCCER_11V11", 11, 14).valid).toBe(false);
    expect(checkRosterConfiguration(undefined, 5, 8).valid).toBe(false);
  });

  it("a minimum above the maximum, a maximum above the absolute maximum, and a minimum below players on field are each refused", async () => {
    const { checkRosterConfiguration } = await loadFormats();
    expect(checkRosterConfiguration("SOCCER_6V6", 10, 7).valid).toBe(false);   // min > max
    expect(checkRosterConfiguration("SOCCER_6V6", 6, 13).valid).toBe(false);   // max > absolute 12
    expect(checkRosterConfiguration("SOCCER_6V6", 5, 8).valid).toBe(false);    // min < playersOnField 6
    expect(checkRosterConfiguration("SOCCER_6V6", 6, 12).valid).toBe(true);
    expect(checkRosterConfiguration("SOCCER_8V8", 8, 16).valid).toBe(true);
    expect(checkRosterConfiguration("SOCCER_8V8", 8, 17).valid).toBe(false);
  });

  it("each refusal names the specific invariant that was broken, so the chain playersOnField ≤ minimum ≤ maximum ≤ absolute maximum is observable link by link", async () => {
    const { checkRosterConfiguration } = await loadFormats();
    const reasonsOf = (key: string, min: number, max: number) => { const r = checkRosterConfiguration(key, min, max); return r.valid ? [] : r.reasons.join(" | "); };
    expect(reasonsOf("SOCCER_6V6", 5, 8)).toContain("below players on field");
    expect(reasonsOf("SOCCER_6V6", 10, 7)).toContain("may not exceed the roster maximum");
    expect(reasonsOf("SOCCER_6V6", 6, 13)).toContain("absolute roster maximum");
    expect(reasonsOf("SOCCER_8V8", 8, 17)).toContain("absolute roster maximum");
    expect(reasonsOf("SOCCER_8V8", 15, 16)).toContain("minimum is outside the configurable range");
    expect(reasonsOf("SOCCER_5V5", 5, 4)).toContain("maximum is outside the configurable range");
  });

  it("findFormatRuleViolations catches every kind of corrupted rule, so an invalid registry can never load", async () => {
    const { getSoccerFormatRule, findFormatRuleViolations } = await loadFormats();
    const base = JSON.parse(JSON.stringify(getSoccerFormatRule("SOCCER_7V7")));
    const mutate = (fn: (r: any) => void) => { const copy = JSON.parse(JSON.stringify(base)); fn(copy); return copy; };
    const corruptions: Array<[string, any]> = [
      ["players on field outside 5–8", mutate((r) => { r.playersOnField = 9; })],
      ["players on field not matching the key", mutate((r) => { r.playersOnField = 6; })],
      ["minimum range low below players on field", mutate((r) => { r.roster.configurableMinimumRange.low = 6; })],
      ["default minimum below its range", mutate((r) => { r.roster.defaultMinimum = 6; })],
      ["default minimum above its range", mutate((r) => { r.roster.defaultMinimum = 13; })],
      ["default maximum below its range", mutate((r) => { r.roster.defaultMaximum = 6; })],
      ["default maximum above its range", mutate((r) => { r.roster.defaultMaximum = 15; })],
      ["default minimum above default maximum", mutate((r) => { r.roster.defaultMinimum = 12; r.roster.defaultMaximum = 12; r.roster.defaultMaximum = 11; })],
      ["maximum range high above the absolute maximum", mutate((r) => { r.roster.absoluteMaximum = 13; })],
      ["minimum range high above maximum range high", mutate((r) => { r.roster.configurableMinimumRange.high = 15; })],
      ["participation minimum above players on field", mutate((r) => { r.minimumActualParticipantsForNormalResult = 8; })],
      ["start minimum above players on field", mutate((r) => { r.minimumToStartOrContinue = 8; })],
      ["participation minimum below one", mutate((r) => { r.minimumActualParticipantsForNormalResult = 0; })],
      ["two halves required", mutate((r) => { r.timing.halves = 3; })],
      ["non-positive minutes per half", mutate((r) => { r.timing.minutesPerHalf = 0; })],
      ["non-positive halftime", mutate((r) => { r.timing.halftimeMinutes = 0; })],
      ["non-positive transition", mutate((r) => { r.timing.pitchTransitionMinutes = -1; })],
      ["non-positive team rest", mutate((r) => { r.timing.minimumTeamRestMinutes = 0; })],
      ["non-positive shootout reserve", mutate((r) => { r.timing.knockoutShootoutReserveMinutes = 0; })],
      ["a non-integer value", mutate((r) => { r.timing.minutesPerHalf = 15.5; })],
    ];
    expect(findFormatRuleViolations(base)).toEqual([]);
    for (const [label, rule] of corruptions) expect(findFormatRuleViolations(rule).length, label).toBeGreaterThan(0);
  });
});

describe("TypeScript registry ↔ migration seed parity (static, no database)", () => {
  function parseSeed() {
    const sql = readFileSync(migrationFile(), "utf8").replace(/--.*$/gm, "");
    const match = /insert\s+into\s+competition_format_rules\s*\(([^)]*)\)\s*values\s*([\s\S]*?);/i.exec(sql);
    if (!match) throw new Error("the seed insert was not found in the migration");
    const columns = match[1].split(",").map((c) => c.trim());
    const tuples = [...match[2].matchAll(/\(([^()]*)\)/g)].map((m) => m[1].split(",").map((v) => v.trim()));
    return { columns, rows: tuples.map((t) => Object.fromEntries(columns.map((c, i) => [c, t[i]]))) as Array<Record<string, string>> };
  }

  it("the migration seeds exactly four rows, with exactly the accepted keys", () => {
    const { rows } = parseSeed();
    expect(rows.map((r) => r.format_key)).toEqual(["'SOCCER_5V5'", "'SOCCER_6V6'", "'SOCCER_7V7'", "'SOCCER_8V8'"]);
  });

  it("every seeded column of every row equals the TypeScript registry", async () => {
    const { rows, columns } = parseSeed();
    const { getSoccerFormatRule } = await loadFormats();
    expect(columns).toEqual([
      "format_key", "players_on_field", "minimum_to_start_or_continue", "minimum_actual_participants_normal_result",
      "roster_default_minimum", "roster_default_maximum", "roster_minimum_range_low", "roster_minimum_range_high",
      "roster_maximum_range_low", "roster_maximum_range_high", "roster_absolute_maximum",
      "halves", "minutes_per_half", "halftime_minutes", "pitch_transition_minutes", "minimum_team_rest_minutes", "knockout_shootout_reserve_minutes",
    ]);
    for (const row of rows) {
      const key = row.format_key.replace(/'/g, "");
      const rule = getSoccerFormatRule(key);
      const n = (column: string) => Number(row[column]);
      expect({
        players_on_field: n("players_on_field"), minimum_to_start_or_continue: n("minimum_to_start_or_continue"),
        minimum_actual_participants_normal_result: n("minimum_actual_participants_normal_result"),
        roster_default_minimum: n("roster_default_minimum"), roster_default_maximum: n("roster_default_maximum"),
        roster_minimum_range_low: n("roster_minimum_range_low"), roster_minimum_range_high: n("roster_minimum_range_high"),
        roster_maximum_range_low: n("roster_maximum_range_low"), roster_maximum_range_high: n("roster_maximum_range_high"),
        roster_absolute_maximum: n("roster_absolute_maximum"), halves: n("halves"), minutes_per_half: n("minutes_per_half"),
        halftime_minutes: n("halftime_minutes"), pitch_transition_minutes: n("pitch_transition_minutes"),
        minimum_team_rest_minutes: n("minimum_team_rest_minutes"), knockout_shootout_reserve_minutes: n("knockout_shootout_reserve_minutes"),
      }, key).toEqual({
        players_on_field: rule.playersOnField, minimum_to_start_or_continue: rule.minimumToStartOrContinue,
        minimum_actual_participants_normal_result: rule.minimumActualParticipantsForNormalResult,
        roster_default_minimum: rule.roster.defaultMinimum, roster_default_maximum: rule.roster.defaultMaximum,
        roster_minimum_range_low: rule.roster.configurableMinimumRange.low, roster_minimum_range_high: rule.roster.configurableMinimumRange.high,
        roster_maximum_range_low: rule.roster.configurableMaximumRange.low, roster_maximum_range_high: rule.roster.configurableMaximumRange.high,
        roster_absolute_maximum: rule.roster.absoluteMaximum, halves: rule.timing.halves, minutes_per_half: rule.timing.minutesPerHalf,
        halftime_minutes: rule.timing.halftimeMinutes, pitch_transition_minutes: rule.timing.pitchTransitionMinutes,
        minimum_team_rest_minutes: rule.timing.minimumTeamRestMinutes, knockout_shootout_reserve_minutes: rule.timing.knockoutShootoutReserveMinutes,
      });
    }
  });
});

describe("the migration stays inside its boundary (static inventory of the SSS-001 migration)", () => {
  const sql = () => readFileSync(migrationFile(), "utf8").replace(/--.*$/gm, "").toLowerCase();

  it("every constraint name fits Postgres' 63-character identifier limit (a longer one is silently truncated, so the database would not hold the name written here)", () => {
    const names = [...sql().matchAll(/constraint\s+([a-z_0-9]+)/g)].map((m) => m[1]);
    expect(names.length).toBeGreaterThanOrEqual(16);                       // fifteen CHECKs on the registry and the foreign key on competitions
    for (const name of names) expect(name.length, name).toBeLessThanOrEqual(63);
  });

  it("creates the registry table and nothing else: no planning, venue, date, window, draw, schedule, appeal or adjudication tables", () => {
    const created = [...sql().matchAll(/create\s+table\s+(?:if\s+not\s+exists\s+)?(?:public\.)?([a-z_]+)/g)].map((m) => m[1]);
    expect(created).toEqual(["competition_format_rules"]);
  });

  it("replaces exactly the three participation functions and defines no other function, trigger, policy, view or type", () => {
    const text = sql();
    const functions = [...text.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(?:public\.)?([a-z_]+)/g)].map((m) => m[1]);
    expect(functions.sort()).toEqual(["correct_competition_fixture_atomically", "finalize_competition_fixture_atomically", "submit_competition_fixture_evidence_atomically"]);
    for (const forbidden of [/create\s+trigger/, /create\s+policy/, /create\s+(?:or\s+replace\s+)?view/, /create\s+type/, /create\s+extension/, /create\s+index/]) {
      expect(text).not.toMatch(forbidden);
    }
  });

  it("does not touch the creation functions, authority grants, states, fixtures or discovery", () => {
    const text = sql();
    for (const protectedName of ["create_competition_atomically", "create_host_competition_atomically", "authority_grants", "competition_host_capabilities", "competition_host_applications", "publish_competition_atomically", "islistedfor"]) {
      expect(text, protectedName).not.toContain(protectedName.toLowerCase());
    }
    // The three replaced functions legitimately READ fixtures; the structure of the table itself must not change.
    expect(text).not.toMatch(/alter\s+table\s+(?:public\.)?competition_fixtures/);
    expect(text).not.toMatch(/fixture_role_check|unique\s*\(\s*competition_id\s*,\s*fixture_role/);
    expect(text).not.toMatch(/alter\s+table\s+(?:public\.)?competitions\s+(?:add\s+column|drop\s+column|alter\s+column)/);
    expect(text).not.toMatch(/competitions_state_check/);
  });

  it("gives anon and authenticated no access to the registry, and the application role read access only", () => {
    const text = sql();
    expect(text).toMatch(/enable\s+row\s+level\s+security/);
    expect(text).toMatch(/revoke\s+all\s+on\s+(?:table\s+)?competition_format_rules\s+from\s+public,\s*anon,\s*authenticated,\s*service_role/);
    expect(text).toMatch(/grant\s+select\s+on\s+(?:table\s+)?competition_format_rules\s+to\s+service_role/);
    expect(text).not.toMatch(/grant\s+(?:insert|update|delete|all)[^;]*competition_format_rules/);
    expect(text).not.toMatch(/to\s+(?:anon|authenticated)\b[^;]*competition_format_rules|competition_format_rules[^;]*to\s+(?:anon|authenticated)\b/);
  });

  it("restricts activity_key with a foreign key to the registry and removes the single-value CHECK", () => {
    const text = sql();
    expect(text).toMatch(/foreign\s+key\s*\(activity_key\)\s*references\s+competition_format_rules\s*\(format_key\)/);
    expect(text).toMatch(/drop\s+constraint/);
  });

  it("derives the minimum from the registry in all three functions and leaves no literal participation threshold of 4", () => {
    const text = sql();
    expect(text).not.toMatch(/participant_count,\s*0\)\s*<\s*4/);
    expect((text.match(/< v_min_participants/g) ?? []).length).toBe(6);        // two comparisons in each of the three functions
    expect((text.match(/competition_format_rules\.minimum_actual_participants_normal_result/g) ?? []).length).toBeGreaterThanOrEqual(3);
    expect((text.match(/format_rules_not_found/g) ?? []).length).toBe(3);        // each function fails closed when no rule exists
  });
});

describe("the participation error tells the truth about each format's own threshold", () => {
  it("the default error keeps the historical 5v5 message exactly", async () => {
    const { MinimumParticipationNotMetError } = await import("../lib/gaming/competitions/types");
    expect(new MinimumParticipationNotMetError().message).toBe("Each team requires at least 4 actually-participating rostered members for a normal result — use forfeit or void instead.");
  });

  it.each([[4, "SOCCER_5V5"], [5, "SOCCER_6V6"], [6, "SOCCER_7V7"], [7, "SOCCER_8V8"]] as Array<[number, string]>)(
    "the database refusal for a threshold of %i (%s) becomes an error that states that number", async (minimum) => {
      const { translateError } = await import("../lib/gaming/competitions/db/supabaseCompetitionsRepository");
      const { MinimumParticipationNotMetError } = await import("../lib/gaming/competitions/types");
      const dbMessage = `MINIMUM_PARTICIPATION_NOT_MET: each team requires at least ${minimum} actually-participating rostered members for a normal result — use forfeit or void instead`;
      const translated = translateError({ code: "P0001", message: dbMessage });
      expect(translated).toBeInstanceOf(MinimumParticipationNotMetError);
      expect(translated.message).toContain(`at least ${minimum} actually-participating`);
    }
  );

  it("an unparseable threshold never invents a number that was not in the database message", async () => {
    const { translateError } = await import("../lib/gaming/competitions/db/supabaseCompetitionsRepository");
    const { MinimumParticipationNotMetError } = await import("../lib/gaming/competitions/types");
    for (const message of ["MINIMUM_PARTICIPATION_NOT_MET", "MINIMUM_PARTICIPATION_NOT_MET: at least x actually-participating", "MINIMUM_PARTICIPATION_NOT_MET: at least 99 actually-participating", "MINIMUM_PARTICIPATION_NOT_MET: at least 0 actually-participating"]) {
      const translated = translateError({ code: "P0001", message });
      expect(translated).toBeInstanceOf(MinimumParticipationNotMetError);
      expect(translated.message, message).not.toMatch(/\d/);          // no number at all: it is never invented, not even the historical 4
    }
  });
});

describe("registry presence does not make 6v6–8v8 selectable, creatable or advertised", () => {
  const NEW_FORMAT = /SOCCER_[678]V[678]|\b[678]v[678]\b/i;

  function walk(dir: string, accept: (file: string) => boolean, out: string[] = []): string[] {
    for (const entry of readdirSync(dir)) {
      if (entry === "node_modules" || entry === ".next" || entry.startsWith(".")) continue;
      const full = path.join(dir, entry);
      if (statSync(full).isDirectory()) walk(full, accept, out);
      else if (accept(full)) out.push(full);
    }
    return out;
  }

  it("no public page or script mentions 6v6, 7v7 or 8v8", () => {
    // Pages and scripts only: SVG path data legitimately contains sequences such as "7v7" (vertical line commands), which are not format names.
    const files = walk(path.join(REPO_ROOT, "public"), (f) => /\.(html|js|css)$/.test(f));
    expect(files.length).toBeGreaterThan(10);
    for (const file of files) expect(readFileSync(file, "utf8"), path.relative(REPO_ROOT, file)).not.toMatch(NEW_FORMAT);
  });

  it("the organizer page's format select offers exactly SOCCER_5V5", () => {
    const html = readFileSync(path.join(REPO_ROOT, "public/competitions-admin.html"), "utf8");
    const select = /<select id="c-activity">([\s\S]*?)<\/select>/.exec(html);
    expect(select).not.toBeNull();
    expect([...select![1].matchAll(/<option value="([^"]*)"/g)].map((m) => m[1])).toEqual(["SOCCER_5V5"]);
  });

  it("no API route or application code names a non-5v5 format; only the registry itself does", () => {
    const files = [
      ...walk(path.join(REPO_ROOT, "app"), (f) => /\.(ts|tsx)$/.test(f)),
      ...walk(path.join(REPO_ROOT, "lib"), (f) => /\.(ts|tsx)$/.test(f)).filter((f) => !f.endsWith(path.join("competitions", "formats.ts"))),
    ];
    expect(files.length).toBeGreaterThan(50);
    for (const file of files) expect(readFileSync(file, "utf8"), path.relative(REPO_ROOT, file)).not.toMatch(NEW_FORMAT);
  });

  it("no route or page reads the registry table: it is internal server authority", () => {
    const files = [...walk(path.join(REPO_ROOT, "app"), (f) => /\.(ts|tsx)$/.test(f)), ...walk(path.join(REPO_ROOT, "public"), (f) => /\.(html|js)$/.test(f))];
    for (const file of files) expect(readFileSync(file, "utf8"), path.relative(REPO_ROOT, file)).not.toContain("competition_format_rules");
  });

  it("both creation functions still accept only 5v5, and the SSS-001 migration does not redefine them", () => {
    const dir = path.join(REPO_ROOT, "supabase/migrations");
    const latest = (name: string) => readdirSync(dir).filter((f) => !/small_sided_soccer/.test(f)).filter((f) => new RegExp(`function (public\\.)?${name}\\b`, "i").test(readFileSync(path.join(dir, f), "utf8"))).sort().pop()!;
    expect(readFileSync(path.join(dir, latest("create_competition_atomically")), "utf8")).toContain("p_activity_key <> 'SOCCER_5V5'");
    expect(readFileSync(path.join(dir, latest("create_host_competition_atomically")), "utf8")).toContain("p_activity_key is distinct from 'SOCCER_5V5'");
  });

  it("the host creation path cannot select a format at all: the route passes only the name, and the helper defaults to 5v5", () => {
    const route = readFileSync(path.join(REPO_ROOT, "app/api/gaming/host/competition/route.ts"), "utf8");
    expect(route).toMatch(/createHostCompetition\(buildHostRepo\(credentials\), auth\.gamingMemberId, body\.name\)/);
    expect(route).not.toContain("activityKey");
    expect(readFileSync(path.join(REPO_ROOT, "lib/gaming/host/createHostCompetition.ts"), "utf8")).toContain('activityKey: unknown = "SOCCER_5V5"');
  });
});
