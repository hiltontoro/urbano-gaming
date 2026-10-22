/**
 * UG-CR-GATE-SSS-001 — Small-Sided Soccer Format Rules Foundation.
 *
 * The INTERNAL, authoritative registry of the four accepted small-sided soccer formats and their V1 rules. It is a typed read-through
 * mirror of the `competition_format_rules` table (migration `…_small_sided_soccer_format_rules_foundation.sql`): the database is what the
 * competition functions read, and a parity test proves the two are identical, so neither can drift on its own.
 *
 * This module is internal server authority. It is not a browser contract and is deliberately imported by nothing a browser can reach:
 * having a rule here does NOT make a format selectable, creatable or advertised. Every creation path still accepts only SOCCER_5V5;
 * enabling another format is a separate, later decision.
 *
 * Reading the values:
 *  - `minimumToStartOrContinue` and `minimumActualParticipantsForNormalResult` are two separate facts, even where their numbers match.
 *    Registered roster size is not actual participation, and this registry does not itself prove continuous on-field compliance.
 *  - Substitutes are DERIVED (roster size − players on field); no authoritative substitute count is stored.
 *  - `knockoutShootoutReserveMinutes` is scheduling reserve for a knockout fixture, not a guaranteed or maximum shootout duration.
 *  - The roster ranges describe what an organizer may later configure within; this gate stores and validates them only.
 *
 * Unknown, missing or malformed formats fail closed: there is no default format and no coercion.
 */

/**
 * An unknown, missing or malformed soccer format key was presented to the registry. Deliberately does not echo the rejected value.
 * It is defined HERE, not in types.ts: the registry is internal server authority that no route reaches, so this refusal is not an
 * HTTP-mapped domain error (statusForCompetitionsError does not, and must not, know it).
 */
export class UnsupportedSoccerFormatError extends Error {
  constructor() { super("This soccer format is not supported."); this.name = "UnsupportedSoccerFormatError"; }
}

export const SOCCER_FORMAT_KEYS = Object.freeze(["SOCCER_5V5", "SOCCER_6V6", "SOCCER_7V7", "SOCCER_8V8"] as const);
export type SoccerFormatKey = (typeof SOCCER_FORMAT_KEYS)[number];

export interface IntegerRange {
  readonly low: number;
  readonly high: number;
}

export interface SoccerFormatRule {
  readonly formatKey: SoccerFormatKey;
  /** Players simultaneously on the field for each team. */
  readonly playersOnField: 5 | 6 | 7 | 8;
  /** The fewest players a team may field to start or continue a match. */
  readonly minimumToStartOrContinue: number;
  /** The fewest actually-participating rostered members each team needs for a NORMAL (evidence-backed) result. */
  readonly minimumActualParticipantsForNormalResult: number;
  readonly roster: {
    readonly defaultMinimum: number;
    readonly defaultMaximum: number;
    readonly configurableMinimumRange: IntegerRange;
    readonly configurableMaximumRange: IntegerRange;
    readonly absoluteMaximum: number;
  };
  readonly timing: {
    readonly halves: 2;
    readonly minutesPerHalf: number;
    readonly halftimeMinutes: number;
    readonly pitchTransitionMinutes: number;
    readonly minimumTeamRestMinutes: number;
    readonly knockoutShootoutReserveMinutes: number;
  };
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object") {
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

/** The accepted V1 values, exactly as given in the SSS-001 execution addendum. */
export const SOCCER_FORMAT_RULES: Readonly<Record<SoccerFormatKey, SoccerFormatRule>> = deepFreeze({
  SOCCER_5V5: {
    formatKey: "SOCCER_5V5", playersOnField: 5, minimumToStartOrContinue: 4, minimumActualParticipantsForNormalResult: 4,
    roster: { defaultMinimum: 5, defaultMaximum: 8, configurableMinimumRange: { low: 5, high: 8 }, configurableMaximumRange: { low: 5, high: 10 }, absoluteMaximum: 10 },
    timing: { halves: 2, minutesPerHalf: 10, halftimeMinutes: 3, pitchTransitionMinutes: 10, minimumTeamRestMinutes: 30, knockoutShootoutReserveMinutes: 15 },
  },
  SOCCER_6V6: {
    formatKey: "SOCCER_6V6", playersOnField: 6, minimumToStartOrContinue: 5, minimumActualParticipantsForNormalResult: 5,
    roster: { defaultMinimum: 6, defaultMaximum: 10, configurableMinimumRange: { low: 6, high: 10 }, configurableMaximumRange: { low: 6, high: 12 }, absoluteMaximum: 12 },
    timing: { halves: 2, minutesPerHalf: 12, halftimeMinutes: 3, pitchTransitionMinutes: 10, minimumTeamRestMinutes: 30, knockoutShootoutReserveMinutes: 15 },
  },
  SOCCER_7V7: {
    formatKey: "SOCCER_7V7", playersOnField: 7, minimumToStartOrContinue: 6, minimumActualParticipantsForNormalResult: 6,
    roster: { defaultMinimum: 7, defaultMaximum: 12, configurableMinimumRange: { low: 7, high: 12 }, configurableMaximumRange: { low: 7, high: 14 }, absoluteMaximum: 14 },
    timing: { halves: 2, minutesPerHalf: 15, halftimeMinutes: 5, pitchTransitionMinutes: 10, minimumTeamRestMinutes: 45, knockoutShootoutReserveMinutes: 15 },
  },
  SOCCER_8V8: {
    formatKey: "SOCCER_8V8", playersOnField: 8, minimumToStartOrContinue: 7, minimumActualParticipantsForNormalResult: 7,
    roster: { defaultMinimum: 8, defaultMaximum: 14, configurableMinimumRange: { low: 8, high: 14 }, configurableMaximumRange: { low: 8, high: 16 }, absoluteMaximum: 16 },
    timing: { halves: 2, minutesPerHalf: 15, halftimeMinutes: 5, pitchTransitionMinutes: 10, minimumTeamRestMinutes: 45, knockoutShootoutReserveMinutes: 15 },
  },
} satisfies Record<SoccerFormatKey, SoccerFormatRule>);

/** True only for one of the four accepted keys, spelled exactly: no trimming, no case folding, no coercion, nothing inherited. */
export function isSoccerFormatKey(value: unknown): value is SoccerFormatKey {
  return typeof value === "string" && (SOCCER_FORMAT_KEYS as readonly string[]).includes(value);
}

/** The rule for an accepted format, or a typed refusal (never a default, never an echo of the rejected value). */
export function getSoccerFormatRule(formatKey: unknown): SoccerFormatRule {
  if (!isSoccerFormatKey(formatKey)) throw new UnsupportedSoccerFormatError();
  return SOCCER_FORMAT_RULES[formatKey];
}

function isInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value);
}

function isRange(value: unknown): value is IntegerRange {
  return value !== null && typeof value === "object" && isInteger((value as IntegerRange).low) && isInteger((value as IntegerRange).high);
}

/**
 * Every way a rule can contradict the accepted invariants, as plain sentences (empty = consistent). Accepts `unknown` so a malformed or
 * hand-built rule is reported, never trusted. The chain it enforces is
 *   playersOnField ≤ roster minimum ≤ roster maximum ≤ absolute roster maximum
 * over the defaults and over both configurable ranges, plus the participation and timing sanity the accepted values satisfy.
 */
export function findFormatRuleViolations(rule: unknown): string[] {
  if (rule === null || typeof rule !== "object" || Array.isArray(rule)) return ["the rule is not an object"];
  const r = rule as Record<string, any>;
  const problems: string[] = [];
  if (!isSoccerFormatKey(r.formatKey)) problems.push("the format key is not one of the four accepted keys");
  const players = r.playersOnField;
  if (!isInteger(players) || players < 5 || players > 8) problems.push("players on field must be a whole number from 5 to 8");
  if (isInteger(players) && r.formatKey !== `SOCCER_${players}V${players}`) problems.push("the format key does not match its players on field");

  const participation = (name: string, value: unknown) => {
    if (!isInteger(value) || value < 1 || (isInteger(players) && value > players)) problems.push(`${name} must be a whole number from 1 to players on field`);
  };
  participation("the minimum to start or continue", r.minimumToStartOrContinue);
  participation("the minimum actual participants for a normal result", r.minimumActualParticipantsForNormalResult);

  const roster = r.roster;
  if (roster === null || typeof roster !== "object") {
    problems.push("the roster rules are missing");
  } else if (!isRange(roster.configurableMinimumRange) || !isRange(roster.configurableMaximumRange) || !isInteger(roster.defaultMinimum) || !isInteger(roster.defaultMaximum) || !isInteger(roster.absoluteMaximum)) {
    problems.push("the roster rules must be whole numbers with two complete ranges");
  } else {
    const minR = roster.configurableMinimumRange as IntegerRange;
    const maxR = roster.configurableMaximumRange as IntegerRange;
    if (isInteger(players) && players > minR.low) problems.push("the roster-minimum range may not start below players on field");
    if (minR.low > minR.high) problems.push("the roster-minimum range is inverted");
    if (maxR.low > maxR.high) problems.push("the roster-maximum range is inverted");
    if (minR.low > maxR.low || minR.high > maxR.high) problems.push("the roster minimum and maximum ranges cannot be satisfied together");
    if (roster.defaultMinimum < minR.low || roster.defaultMinimum > minR.high) problems.push("the default roster minimum is outside its range");
    if (roster.defaultMaximum < maxR.low || roster.defaultMaximum > maxR.high) problems.push("the default roster maximum is outside its range");
    if (roster.defaultMinimum > roster.defaultMaximum) problems.push("the default roster minimum exceeds the default roster maximum");
    if (maxR.high > roster.absoluteMaximum) problems.push("the roster-maximum range exceeds the absolute roster maximum");
  }

  const timing = r.timing;
  if (timing === null || typeof timing !== "object") {
    problems.push("the timing rules are missing");
  } else {
    if (timing.halves !== 2) problems.push("a match has exactly two halves");
    for (const name of ["minutesPerHalf", "halftimeMinutes", "pitchTransitionMinutes", "minimumTeamRestMinutes", "knockoutShootoutReserveMinutes"] as const) {
      if (!isInteger(timing[name]) || timing[name] <= 0) problems.push(`${name} must be a positive whole number of minutes`);
    }
  }
  return problems;
}

export type RosterConfigurationCheck = { readonly valid: true } | { readonly valid: false; readonly reasons: string[] };

/**
 * Is this pair an allowed roster configuration for the format? It must satisfy, together:
 *   playersOnField ≤ configuredMinimum ≤ configuredMaximum ≤ absoluteMaximum,
 * with the minimum inside the format's roster-minimum range and the maximum inside its roster-maximum range. Pure; nothing is stored or exposed.
 */
export function checkRosterConfiguration(formatKey: unknown, configuredMinimum: unknown, configuredMaximum: unknown): RosterConfigurationCheck {
  if (!isSoccerFormatKey(formatKey)) return { valid: false, reasons: ["the format is not supported"] };
  const rule = SOCCER_FORMAT_RULES[formatKey];
  const reasons: string[] = [];
  if (!isInteger(configuredMinimum)) reasons.push("the roster minimum must be a whole number");
  if (!isInteger(configuredMaximum)) reasons.push("the roster maximum must be a whole number");
  if (reasons.length > 0) return { valid: false, reasons };
  const min = configuredMinimum as number;
  const max = configuredMaximum as number;
  if (min < rule.playersOnField) reasons.push("the roster minimum may not be below players on field");
  if (min > max) reasons.push("the roster minimum may not exceed the roster maximum");
  if (max > rule.roster.absoluteMaximum) reasons.push("the roster maximum may not exceed the absolute roster maximum");
  if (min < rule.roster.configurableMinimumRange.low || min > rule.roster.configurableMinimumRange.high) reasons.push("the roster minimum is outside the configurable range for this format");
  if (max < rule.roster.configurableMaximumRange.low || max > rule.roster.configurableMaximumRange.high) reasons.push("the roster maximum is outside the configurable range for this format");
  return reasons.length === 0 ? { valid: true } : { valid: false, reasons };
}

/** Substitutes are derived, never stored: the registered roster beyond the players on the field (never negative). */
export function substitutesFor(formatKey: unknown, rosterSize: number): number {
  const rule = getSoccerFormatRule(formatKey);
  if (!isInteger(rosterSize) || rosterSize < 0) throw new RangeError("rosterSize must be a whole number of players");
  return Math.max(0, rosterSize - rule.playersOnField);
}

// Fail closed at load time: an inconsistent built-in registry must never be usable.
for (const key of SOCCER_FORMAT_KEYS) {
  const problems = findFormatRuleViolations(SOCCER_FORMAT_RULES[key]);
  if (problems.length > 0) throw new Error(`The built-in soccer format rule ${key} is invalid: ${problems.join("; ")}`);
}
