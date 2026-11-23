import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  ENTRY_DECISION_NOTE_MAX, ENTRY_DECISION_REASON_CODES, LIFETIME_DATABASE_CODES, LifetimeTeamError, decideLifetimeEntry, disableLifetimeEntryFlow, lifetimeErrorFromDatabase,
  normalizeEntryDecisionNote, parseEntryDecision, parseEntryDecisionRequest, type LifetimeTeamsStore,
} from "../lib/gaming/competitions/lifetimeTeams";
import { SupabaseLifetimeTeamsRepository, translateLifetimeError } from "../lib/gaming/competitions/db/supabaseLifetimeTeamsRepository";
import {
  CompetitionAccessDeniedError, CompetitionCancelledError, CompetitionNotFoundError, HostAccessRevokedError, TeamRegistrationNotOpenError,
} from "../lib/gaming/competitions/types";

/**
 * UG-CR-GATE-CFM-004 — Organizer entry decisions and safe flow recovery: the application side and the static guarantees about the migration (no database needed).
 *
 * The decisions are the database's (see the contract suites). This file proves what the application adds — the bounded reason vocabulary, the note rules, validation
 * BEFORE a call, the exact arguments of each operation, the stable typed refusals — and, by reading the migration as text, the properties that must hold whatever the
 * database does: it is one additive file after the CFM-001 migration, replaces only the CFM-001 objects it must (never a V1 function), deletes nothing but the one switch
 * row recovery removes, keeps every new object server-only, and orders its organizer checks like every other organizer operation of this repository.
 */

const ROOT = path.resolve(__dirname, "..");
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");
const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const U3 = "33333333-3333-4333-8333-333333333333";
const U4 = "44444444-4444-4444-8444-444444444444";

const codeOf = (fn: () => unknown): string => {
  try { fn(); } catch (err) { return err instanceof LifetimeTeamError ? err.code : `OTHER:${(err as Error)?.name}`; }
  return "NO_THROW";
};

const MIGRATIONS_DIR = path.join(ROOT, "supabase", "migrations");
const migrationFiles = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
const FOUNDATION_NAME = migrationFiles.find((f) => /_competition_lifetime_teams_and_entry_foundation\.sql$/.test(f))!;
const DECISIONS_NAME = migrationFiles.find((f) => /_competition_lifetime_entry_decisions_and_flow_recovery\.sql$/.test(f))!;
const RAW = readFileSync(path.join(MIGRATIONS_DIR, DECISIONS_NAME), "utf8");
const CODE = RAW.replace(/--.*$/gm, ""); // comments removed: the scans below must not be fooled by prose

/** The text of one function of the migration (`create function` or `create or replace function`, up to its closing `$function$;`). */
function functionText(name: string): string {
  const match = new RegExp(`create\\s+(?:or\\s+replace\\s+)?function\\s+${name}\\s*\\(([\\s\\S]*?)\\n\\$function\\$;`, "i").exec(CODE);
  if (!match) throw new Error(`function ${name} not found in the migration`);
  return match[0];
}

// =============================================================================================================================================
describe("the reason vocabulary and the note", () => {
  it("lists exactly the six bounded reason codes, the same six the database holds in its CHECK and in the operation", () => {
    expect([...ENTRY_DECISION_REASON_CODES]).toEqual(["INELIGIBLE_TEAM", "INCOMPLETE_ENTRY", "DUPLICATE_OR_MISTAKEN_ENTRY", "COMPETITION_CAPACITY", "RULE_VIOLATION", "OTHER_ORGANIZER_DECISION"]);
    const quoted = (list: string) => [...list.matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]);
    const check = /reason_code is null or reason_code in \(([^)]*)\)/.exec(CODE);
    const operation = /p_reason_code not in \(([^)]*)\)/.exec(CODE);
    expect(check, "the decision table's CHECK").toBeTruthy();
    expect(operation, "the operation's own list").toBeTruthy();
    expect(quoted(check![1])).toEqual([...ENTRY_DECISION_REASON_CODES]);
    expect(quoted(operation![1])).toEqual([...ENTRY_DECISION_REASON_CODES]);
  });

  it("bounds a note at 280 characters in the code and in the database alike", () => {
    expect(ENTRY_DECISION_NOTE_MAX).toBe(280);
    expect(CODE).toMatch(/char_length\(note\) between 1 and 280/);
    expect(CODE).toMatch(/char_length\(v_note\) > 280/);
  });

  it("normalizes a note exactly like a team name — trimmed, every run of whitespace one space — and counts CHARACTERS, not UTF-16 units or bytes", () => {
    expect(normalizeEntryDecisionNote("  too   many \t spaces \n here ")).toBe("too many spaces here");
    expect(normalizeEntryDecisionNote("x".repeat(280))).toHaveLength(280);
    expect(Array.from(normalizeEntryDecisionNote("😀".repeat(280)))).toHaveLength(280); // 560 UTF-16 units, 1120 bytes: still 280 characters
    expect(Array.from(normalizeEntryDecisionNote("á".repeat(280)))).toHaveLength(280);
    for (const bad of ["x".repeat(281), "😀".repeat(281), "", "   ", "\n\t ", "bad\u0007note", "nul\u0000", "del\u007f", "c1\u0085control"]) {
      expect(codeOf(() => normalizeEntryDecisionNote(bad)), JSON.stringify(bad)).toBe("NOTE_INVALID");
    }
  });
});

describe("a decision request", () => {
  it("accepts exactly APPROVE, REJECT and REMOVE", () => {
    for (const ok of ["APPROVE", "REJECT", "REMOVE"] as const) expect(parseEntryDecision(ok)).toBe(ok);
    for (const bad of ["approve", "ACCEPT", "DECLINE", "WITHDRAW", "", null, undefined, 1, {}]) expect(codeOf(() => parseEntryDecision(bad)), String(bad)).toBe("DECISION_INVALID");
  });

  it("carries nothing with an approval: no reason and no note", () => {
    expect(parseEntryDecisionRequest("APPROVE", undefined, undefined)).toEqual({ decision: "APPROVE", reasonCode: null, note: null });
    expect(parseEntryDecisionRequest("APPROVE", null, null)).toEqual({ decision: "APPROVE", reasonCode: null, note: null });
    expect(codeOf(() => parseEntryDecisionRequest("APPROVE", "RULE_VIOLATION", null))).toBe("REASON_INVALID");
    expect(codeOf(() => parseEntryDecisionRequest("APPROVE", null, "fine"))).toBe("NOTE_INVALID");
    expect(codeOf(() => parseEntryDecisionRequest("APPROVE", null, ""))).toBe("NOTE_INVALID"); // an empty note is a note: refused, never silently dropped
  });

  it("needs one reason from the list for a rejection or a removal, and takes an optional note", () => {
    for (const decision of ["REJECT", "REMOVE"] as const) {
      for (const reason of ENTRY_DECISION_REASON_CODES) {
        expect(parseEntryDecisionRequest(decision, reason, undefined)).toEqual({ decision, reasonCode: reason, note: null });
        expect(parseEntryDecisionRequest(decision, reason, null)).toEqual({ decision, reasonCode: reason, note: null });
        expect(parseEntryDecisionRequest(decision, reason, "  two   words ")).toEqual({ decision, reasonCode: reason, note: "two words" });
      }
      for (const bad of [undefined, null, "", "BECAUSE", "rule_violation", " RULE_VIOLATION", 7, {}]) expect(codeOf(() => parseEntryDecisionRequest(decision, bad, null)), `${decision} ${String(bad)}`).toBe("REASON_INVALID");
      for (const bad of ["", "  ", "x".repeat(281), "bad\u0007", 5, {}, []]) expect(codeOf(() => parseEntryDecisionRequest(decision, "OTHER_ORGANIZER_DECISION", bad)), `${decision} note ${JSON.stringify(bad)}`).toBe("NOTE_INVALID");
    }
  });

  it("checks the decision before the reason, and the reason before the note", () => {
    expect(codeOf(() => parseEntryDecisionRequest("MAYBE", "NOPE", "x".repeat(999)))).toBe("DECISION_INVALID");
    expect(codeOf(() => parseEntryDecisionRequest("REJECT", "NOPE", "x".repeat(999)))).toBe("REASON_INVALID");
    expect(codeOf(() => parseEntryDecisionRequest("REJECT", "RULE_VIOLATION", "x".repeat(999)))).toBe("NOTE_INVALID");
  });
});

// =============================================================================================================================================
describe("the domain functions", () => {
  const stub = () => {
    const decideEntry = vi.fn(async (..._args: unknown[]) => ({}) as never);
    const disableEntryFlow = vi.fn(async (..._args: unknown[]) => ({}) as never);
    return { decideEntry, disableEntryFlow, store: { decideEntry, disableEntryFlow } as unknown as LifetimeTeamsStore };
  };

  it("hands the store validated, normalized arguments — and nothing but nulls for an approval", async () => {
    const { decideEntry, store } = stub();
    await decideLifetimeEntry(store, U1, U2, U3, "APPROVE");
    expect(decideEntry).toHaveBeenLastCalledWith(U1, U2, U3, "APPROVE", null, null);
    await decideLifetimeEntry(store, U1, U2, U3, "REJECT", "INCOMPLETE_ENTRY", "  roster   missing ");
    expect(decideEntry).toHaveBeenLastCalledWith(U1, U2, U3, "REJECT", "INCOMPLETE_ENTRY", "roster missing");
    await decideLifetimeEntry(store, U1, U2, U3, "REMOVE", "RULE_VIOLATION");
    expect(decideEntry).toHaveBeenLastCalledWith(U1, U2, U3, "REMOVE", "RULE_VIOLATION", null);
    expect(decideEntry).toHaveBeenCalledTimes(3);
  });

  it("refuses a malformed identifier, decision, reason or note BEFORE the store is called", async () => {
    const { decideEntry, disableEntryFlow, store } = stub();
    await expect(decideLifetimeEntry(store, "nope", U2, U3, "APPROVE")).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(decideLifetimeEntry(store, U1, "", U3, "APPROVE")).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(decideLifetimeEntry(store, U1, U2, null as never, "APPROVE")).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(decideLifetimeEntry(store, U1, U2, U3, "MAYBE")).rejects.toMatchObject({ code: "DECISION_INVALID" });
    await expect(decideLifetimeEntry(store, U1, U2, U3, "REJECT")).rejects.toMatchObject({ code: "REASON_INVALID" });
    await expect(decideLifetimeEntry(store, U1, U2, U3, "APPROVE", "RULE_VIOLATION")).rejects.toMatchObject({ code: "REASON_INVALID" });
    await expect(decideLifetimeEntry(store, U1, U2, U3, "REMOVE", "RULE_VIOLATION", "x".repeat(281))).rejects.toMatchObject({ code: "NOTE_INVALID" });
    await expect(disableLifetimeEntryFlow(store, "nope", U2)).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(disableLifetimeEntryFlow(store, U1, "nope")).rejects.toMatchObject({ code: "INPUT_INVALID" });
    expect(decideEntry).not.toHaveBeenCalled();
    expect(disableEntryFlow).not.toHaveBeenCalled();
  });

  it("calls the store once for the recovery, with both identifiers", async () => {
    const { disableEntryFlow, store } = stub();
    await disableLifetimeEntryFlow(store, U1, U2);
    expect(disableEntryFlow).toHaveBeenCalledTimes(1);
    expect(disableEntryFlow).toHaveBeenCalledWith(U1, U2);
  });
});

// =============================================================================================================================================
describe("exact domain error mapping", () => {
  const NEW_REFUSALS: Array<[string, string, RegExp]> = [
    ["LIFETIME_ENTRY_NOT_PENDING", "ENTRY_NOT_PENDING", /^This entry has already been decided or withdrawn\.$/],
    ["LIFETIME_ENTRY_NOT_ACCEPTED", "ENTRY_NOT_ACCEPTED", /^Only an accepted entry can be removed\.$/],
    ["LIFETIME_ENTRY_CAPTAIN_CHANGED", "ENTRY_CAPTAIN_CHANGED", /no longer leads the team/],
    ["LIFETIME_REASON_INVALID", "REASON_INVALID", /listed reasons/],
    ["LIFETIME_NOTE_INVALID", "NOTE_INVALID", /1 to 280 characters/],
    ["LIFETIME_FREEZE_PENDING_ENTRIES", "FREEZE_PENDING_ENTRIES", /Decide every pending entry/],
    ["LIFETIME_FLOW_RECOVERY_BLOCKED", "FLOW_RECOVERY_BLOCKED", /before publication and before anything has been entered, decided or frozen/],
    ["LIFETIME_FLOW_RECOVERY_UNSAFE_LEGACY_STATE", "FLOW_RECOVERY_UNSAFE_LEGACY_STATE", /Legacy team data exists/],
  ];

  it.each(NEW_REFUSALS)("%s becomes the typed refusal %s with a bounded message that never repeats the database's words", (databaseCode, problem, message) => {
    const error = lifetimeErrorFromDatabase(`${databaseCode}: the database's own wording, which must never be passed on`);
    expect(error).toBeInstanceOf(LifetimeTeamError);
    expect(error!.code).toBe(problem);
    expect(error!.message).toMatch(message);
    expect(error!.message).not.toMatch(/LIFETIME_|database|wording/);
    expect(LIFETIME_DATABASE_CODES.filter(([code]) => code === databaseCode)).toHaveLength(1);
    // and through the adapter's translator (what a route would receive)
    const translated = translateLifetimeError({ code: "P0001", message: `${databaseCode}: whatever` });
    expect(translated).toBeInstanceOf(LifetimeTeamError);
    expect((translated as LifetimeTeamError).code).toBe(problem);
  });

  it("states the accepted count the freeze refusal reports, and says ACCEPTED, not live", () => {
    const one = lifetimeErrorFromDatabase("LIFETIME_FREEZE_NOT_ENOUGH_ENTRIES: at least two accepted entries are needed (found 1)");
    expect(one!.code).toBe("FREEZE_NOT_ENOUGH_ENTRIES");
    expect(one!.message).toBe("At least two accepted entries are needed (found 1).");
    expect(lifetimeErrorFromDatabase("LIFETIME_FREEZE_NOT_ENOUGH_ENTRIES: no number here")!.message).toBe("At least two accepted entries are needed.");
  });

  it("keeps the shared competition refusals the new operations raise as the existing typed errors (and never the database's words)", () => {
    const shared: Array<[string, new (...args: never[]) => Error]> = [
      ["COMPETITION_NOT_FOUND: no such competition exists", CompetitionNotFoundError],
      ["COMPETITION_ACCESS_DENIED: only this competition's own organizer may decide a lifetime entry", CompetitionAccessDeniedError],
      ["HOST_ACCESS_REVOKED: this host's access has been revoked", HostAccessRevokedError],
      ["COMPETITION_CANCELLED: this competition has been cancelled", CompetitionCancelledError],
      ["TEAM_REGISTRATION_NOT_OPEN: team registration is not currently open", TeamRegistrationNotOpenError],
    ];
    for (const [message, cls] of shared) {
      const error = translateLifetimeError({ code: "P0001", message });
      expect(error, message).toBeInstanceOf(cls);
      expect(error.message, message).not.toMatch(/lifetime entry|feature|decide/i);
    }
    expect(translateLifetimeError({ code: "P0001", message: "SOMETHING_UNKNOWN: boom" })).toMatchObject({ code: "UNAVAILABLE" });
    expect(translateLifetimeError({ code: "XX000", message: "LIFETIME_ENTRY_NOT_PENDING: wrong sqlstate" })).toMatchObject({ code: "UNAVAILABLE" });
  });

  it("raises every code of the table somewhere in the lifetime migrations, and this migration's new codes only here", () => {
    const raised = new Set([...CODE.matchAll(/raise\s+exception\s+'(LIFETIME_[A-Z_]+):/g)].map((m) => m[1]));
    for (const [databaseCode] of NEW_REFUSALS) expect(raised.has(databaseCode), databaseCode).toBe(true);
    for (const raisedCode of raised) expect(LIFETIME_DATABASE_CODES.some(([code]) => code === raisedCode), `${raisedCode} is raised but not mapped`).toBe(true);
  });
});

// =============================================================================================================================================
describe("the Supabase repository adapter", () => {
  function repoWith(answer: (name: string, args: Record<string, unknown>) => { data?: unknown; error?: { code?: string; message?: string } | null }) {
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => ({ data: null, error: null, ...answer(name, args) }));
    return { repo: new SupabaseLifetimeTeamsRepository("http://127.0.0.1:1", "service-key", { rpc } as never), rpc };
  }

  const signatureOf = (name: string): string[] => {
    const m = new RegExp(`create\\s+function\\s+${name}\\s*\\(([^)]*)\\)`, "i").exec(CODE);
    expect(m, name).toBeTruthy();
    return m![1].split(",").map((part) => part.trim().split(/\s+/)[0]).filter(Boolean).sort();
  };

  it("calls the decision with exactly the parameter names the migration declares, for each of the three decisions", async () => {
    const row = (status: string, decision: string, released: number) => [{ competition_team_id: U2, status, decision, decided_at: "T1", released_claims: released, decision_id: U4 }];
    const approve = repoWith(() => ({ data: row("ACCEPTED", "APPROVE", 0) }));
    const reject = repoWith(() => ({ data: row("REJECTED", "REJECT", 3) }));
    const remove = repoWith(() => ({ data: row("REJECTED", "REMOVE", 5) }));
    const a = await approve.repo.decideEntry(U1, U2, U3, "APPROVE", null, null);
    const r = await reject.repo.decideEntry(U1, U2, U3, "REJECT", "INCOMPLETE_ENTRY", "  needs   a roster ");
    const m = await remove.repo.decideEntry(U1, U2, U3, "REMOVE", "RULE_VIOLATION", null);
    expect(a).toEqual({ competitionTeamId: U2, status: "ACCEPTED", decision: "APPROVE", decidedAt: "T1", releasedClaims: 0, decisionId: U4 });
    expect(r).toEqual({ competitionTeamId: U2, status: "REJECTED", decision: "REJECT", decidedAt: "T1", releasedClaims: 3, decisionId: U4 });
    expect(m).toEqual({ competitionTeamId: U2, status: "REJECTED", decision: "REMOVE", decidedAt: "T1", releasedClaims: 5, decisionId: U4 });
    const name = "decide_lifetime_competition_entry_atomically";
    expect(approve.rpc).toHaveBeenCalledWith(name, { p_competition_id: U1, p_competition_team_id: U2, p_organizer_gaming_member_id: U3, p_decision: "APPROVE", p_reason_code: null, p_note: null });
    expect(reject.rpc).toHaveBeenCalledWith(name, { p_competition_id: U1, p_competition_team_id: U2, p_organizer_gaming_member_id: U3, p_decision: "REJECT", p_reason_code: "INCOMPLETE_ENTRY", p_note: "needs a roster" });
    expect(remove.rpc).toHaveBeenCalledWith(name, { p_competition_id: U1, p_competition_team_id: U2, p_organizer_gaming_member_id: U3, p_decision: "REMOVE", p_reason_code: "RULE_VIOLATION", p_note: null });
    for (const { rpc } of [approve, reject, remove]) {
      expect(rpc).toHaveBeenCalledTimes(1);
      expect(Object.keys(rpc.mock.calls[0][1] as Record<string, unknown>).sort()).toEqual(signatureOf(name));
    }
  });

  it("calls the recovery with exactly the parameter names the migration declares, and reports an exact retry without inventing a date", async () => {
    const first = repoWith(() => ({ data: [{ competition_id: U1, disabled_at: "T2", already_disabled: false }] }));
    expect(await first.repo.disableEntryFlow(U1, U2)).toEqual({ competitionId: U1, disabledAt: "T2", alreadyDisabled: false });
    const name = "disable_lifetime_entry_flow_atomically";
    expect(first.rpc).toHaveBeenCalledWith(name, { p_competition_id: U1, p_organizer_gaming_member_id: U2 });
    expect(Object.keys(first.rpc.mock.calls[0][1] as Record<string, unknown>).sort()).toEqual(signatureOf(name));
    const retry = repoWith(() => ({ data: [{ competition_id: U1, disabled_at: null, already_disabled: true }] }));
    expect(await retry.repo.disableEntryFlow(U1, U2)).toEqual({ competitionId: U1, disabledAt: null, alreadyDisabled: true });
  });

  it("never calls the database for a malformed decision, and turns an answer without a row into the bounded UNAVAILABLE", async () => {
    const { repo, rpc } = repoWith(() => ({ data: [] }));
    await expect(repo.decideEntry(U1, U2, U3, "MAYBE" as never, null, null)).rejects.toMatchObject({ code: "DECISION_INVALID" });
    await expect(repo.decideEntry(U1, U2, U3, "REJECT", "NOT_A_REASON" as never, null)).rejects.toMatchObject({ code: "REASON_INVALID" });
    await expect(repo.decideEntry(U1, U2, U3, "APPROVE", "RULE_VIOLATION" as never, null)).rejects.toMatchObject({ code: "REASON_INVALID" });
    await expect(repo.decideEntry("nope", U2, U3, "APPROVE", null, null)).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(repo.disableEntryFlow(U1, "nope")).rejects.toMatchObject({ code: "INPUT_INVALID" });
    expect(rpc).not.toHaveBeenCalled();
    await expect(repo.decideEntry(U1, U2, U3, "APPROVE", null, null)).rejects.toMatchObject({ code: "UNAVAILABLE" });
    await expect(repo.disableEntryFlow(U1, U2)).rejects.toMatchObject({ code: "UNAVAILABLE" });
  });

  it("passes a coded refusal on as its typed error, and a raw database failure as UNAVAILABLE", async () => {
    const refused = repoWith(() => ({ error: { code: "P0001", message: "LIFETIME_ENTRY_NOT_PENDING: this entry has already been decided or withdrawn" } }));
    expect(await refused.repo.decideEntry(U1, U2, U3, "APPROVE", null, null).catch((e) => e)).toMatchObject({ code: "ENTRY_NOT_PENDING" });
    const blocked = repoWith(() => ({ error: { code: "P0001", message: "LIFETIME_FLOW_RECOVERY_BLOCKED: this competition already has lifetime entries" } }));
    expect(await blocked.repo.disableEntryFlow(U1, U2).catch((e) => e)).toMatchObject({ code: "FLOW_RECOVERY_BLOCKED" });
    const broken = repoWith(() => ({ error: { code: "57014", message: "canceling statement due to statement timeout" } }));
    const error = await broken.repo.decideEntry(U1, U2, U3, "APPROVE", null, null).catch((e) => e);
    expect(error).toMatchObject({ code: "UNAVAILABLE" });
    expect(error.message).not.toMatch(/statement|timeout/i);
  });

  it("defines exactly the two new callable operations, and the store has a method for each (no operation is reachable only by a raw call)", () => {
    const created = [...CODE.matchAll(/create\s+function\s+(\w+_atomically)\s*\(/gi)].map((m) => m[1]).sort();
    expect(created).toEqual(["decide_lifetime_competition_entry_atomically", "disable_lifetime_entry_flow_atomically"]);
    const source = read("lib/gaming/competitions/db/supabaseLifetimeTeamsRepository.ts");
    for (const name of created) expect(source, name).toContain(`"${name}"`);
    // the CFM-001 operations this migration replaces keep their exact signatures (the adapter's calls are unchanged)
    for (const name of ["enable_lifetime_entry_flow_atomically", "withdraw_lifetime_competition_entry_atomically", "freeze_lifetime_competition_entries_atomically"]) {
      expect(source, name).toContain(`"${name}"`);
      const foundation = new RegExp(`create function ${name}\\s*\\(([^)]*)\\)`, "i").exec(read(`supabase/migrations/${FOUNDATION_NAME}`).replace(/--.*$/gm, ""));
      const replacement = new RegExp(`create or replace function ${name}\\s*\\(([^)]*)\\)`, "i").exec(CODE);
      expect(foundation && replacement, name).toBeTruthy();
      expect(replacement![1].replace(/\s+/g, " ").trim(), `${name} keeps its signature`).toBe(foundation![1].replace(/\s+/g, " ").trim());
    }
  });
});

// =============================================================================================================================================
describe("the migration (read as text)", () => {
  it("is ONE additive file, ordered after the CFM-001 migration, and leaves that migration byte-for-byte as it was", () => {
    expect(FOUNDATION_NAME).toBeTruthy();
    expect(DECISIONS_NAME).toBeTruthy();
    expect(DECISIONS_NAME > FOUNDATION_NAME).toBe(true);
    // nothing sorts between the two, and this gate added exactly one file after the foundation (a later gate's file is bounded out by the upper limit)
    expect(migrationFiles.filter((f) => f > FOUNDATION_NAME && f <= DECISIONS_NAME)).toEqual([DECISIONS_NAME]);
    expect(migrationFiles.filter((f) => /_competition_lifetime_entry_decisions_and_flow_recovery\.sql$/.test(f))).toHaveLength(1);
    const digest = createHash("sha256").update(readFileSync(path.join(MIGRATIONS_DIR, FOUNDATION_NAME))).digest("hex");
    expect(digest, "the CFM-001 migration is append-only history: this gate never edits it").toBe("bfa61d35ce0e9909f8a9d003c7c8774ba6d1c3827aaec021ac5a2790aa08f257");
  });

  it("replaces only the CFM-001 objects it must, and never a V1 function", () => {
    const replaced = [...CODE.matchAll(/create\s+or\s+replace\s+function\s+(\w+)/gi)].map((m) => m[1]).sort();
    expect(replaced).toEqual([
      "competition_teams_lifetime_entry_guard", "enable_lifetime_entry_flow_atomically", "freeze_lifetime_competition_entries_atomically", "withdraw_lifetime_competition_entry_atomically",
    ]);
    const created = [...CODE.matchAll(/create\s+function\s+(\w+)/gi)].map((m) => m[1]).sort();
    expect(created).toEqual([
      "competition_lifetime_entry_v1_path_guard", "competition_lifetime_flows_row_guard", "decide_lifetime_competition_entry_atomically", "disable_lifetime_entry_flow_atomically",
    ]);
    // every function it defines is a lifetime object: none of the V1 team-registration operations (they are named without the word) is redefined
    for (const name of [...replaced, ...created]) expect(name, name).toMatch(/lifetime/);
    for (const v1 of ["decide_competition_team_atomically", "request_join_competition_team_atomically", "close_team_registration_atomically", "decide_join_request_atomically", "open_team_registration_atomically"]) {
      expect(CODE, v1).not.toMatch(new RegExp(`function\\s+${v1}\\b`));
    }
  });

  it("drops nothing but the three objects it replaces, truncates nothing, and deletes exactly one row kind: the switch row, inside the recovery", () => {
    const drops = [...CODE.matchAll(/\bdrop\s+(\w+)\s+(?:if\s+exists\s+)?(\w+)(?:\s+on\s+(\w+))?/gi)].map((m) => [m[1].toLowerCase(), m[2], m[3] ?? null]);
    expect(drops).toEqual([
      ["constraint", "lifetime_team_events_type_check", null],
      ["constraint", "competition_lifetime_roster_claims_release_reason_check", null],
      ["trigger", "competition_lifetime_flows_history_rows", "competition_lifetime_flows"],
    ]);
    expect(CODE, "no TRUNCATE statement (the word appears only in the triggers that FORBID truncating the history tables)").not.toMatch(/^\s*truncate\b/im);
    expect([...CODE.matchAll(/\btruncate\b/gi)]).toHaveLength(2);
    expect(CODE).not.toMatch(/\bdrop\s+(table|function|column|schema)\b/i);
    expect(CODE).not.toMatch(/\balter\s+table\s+\w+\s+(drop\s+column|rename)/i);
    const deletes = [...CODE.matchAll(/\bdelete\s+from\s+(\w+)/gi)].map((m) => m[1]);
    expect(deletes).toEqual(["competition_lifetime_flows"]);
    const recovery = functionText("disable_lifetime_entry_flow_atomically");
    expect(recovery).toMatch(/delete\s+from\s+competition_lifetime_flows/);
    // and only after the operation marked its own transaction, which is the only thing the row guard accepts
    expect(recovery.indexOf("set_config('urbano.lifetime_flow_transition', 'disable', true)")).toBeGreaterThan(-1);
    expect(recovery.indexOf("set_config('urbano.lifetime_flow_transition', 'disable', true)")).toBeLessThan(recovery.search(/delete\s+from\s+competition_lifetime_flows/));
    const guard = functionText("competition_lifetime_flows_row_guard");
    expect(guard).toMatch(/tg_op\s*=\s*'DELETE'\s+and\s+coalesce\(current_setting\('urbano\.lifetime_flow_transition',\s*true\),\s*''\)\s*=\s*'disable'/);
    expect(guard, "an UPDATE of the switch row is never allowed").not.toMatch(/'UPDATE'/);
  });

  it("keeps every new object server-only: security definer with a pinned search_path, no public execute, and tables nobody but the service role can read", () => {
    for (const name of ["decide_lifetime_competition_entry_atomically", "disable_lifetime_entry_flow_atomically", "competition_lifetime_flows_row_guard", "competition_lifetime_entry_v1_path_guard"]) {
      const text = functionText(name);
      expect(text, name).toMatch(/security definer/);
      expect(text, name).toMatch(/set search_path = public, pg_temp/);
      expect(CODE, name).toMatch(new RegExp(`revoke all on function ${name}\\([^)]*\\) from public, anon, authenticated`));
    }
    for (const name of ["decide_lifetime_competition_entry_atomically", "disable_lifetime_entry_flow_atomically", "enable_lifetime_entry_flow_atomically", "withdraw_lifetime_competition_entry_atomically", "freeze_lifetime_competition_entries_atomically"]) {
      expect(CODE, name).toMatch(new RegExp(`grant execute on function ${name}\\([^)]*\\) to service_role`));
    }
    for (const name of ["competition_lifetime_flows_row_guard", "competition_lifetime_entry_v1_path_guard"]) {
      expect(CODE, `${name} is a trigger function: not even the service role can call it`).toMatch(new RegExp(`revoke all on function ${name}\\(\\) from service_role`));
      expect(CODE, name).not.toMatch(new RegExp(`grant execute on function ${name}`));
    }
    for (const table of ["competition_lifetime_entry_decisions", "competition_lifetime_flow_events"]) {
      expect(CODE, table).toMatch(new RegExp(`alter table ${table} enable row level security`));
      expect(CODE, table).toMatch(new RegExp(`revoke all on table ${table} from public, anon, authenticated, service_role`));
      expect(CODE, table).toMatch(new RegExp(`grant select on table ${table} to service_role`));
      expect(CODE, `${table} is history`).toMatch(new RegExp(`create trigger ${table}_history_rows before update or delete on ${table} for each row execute function lifetime_history_guard\\(\\)`));
      expect(CODE, `${table} is history`).toMatch(new RegExp(`create trigger ${table}_history_truncate before truncate on ${table} for each statement execute function lifetime_history_guard\\(\\)`));
      expect(CODE, `${table}: no write privilege is granted to anyone`).not.toMatch(new RegExp(`grant\\s+(insert|update|delete|all)[^;]*on\\s+(table\\s+)?${table}`, "i"));
    }
    expect(CODE).not.toMatch(/to\s+(anon|authenticated|public)\b/i);
  });

  it("orders each organizer operation like every other organizer operation: scope lock, competition row, ownership, revocation, and only then a write", () => {
    for (const name of ["decide_lifetime_competition_entry_atomically", "disable_lifetime_entry_flow_atomically", "enable_lifetime_entry_flow_atomically", "freeze_lifetime_competition_entries_atomically"]) {
      const text = functionText(name);
      const lock = text.indexOf("pg_advisory_xact_lock(hashtext('competition_scope:'");
      const row = text.search(/from competitions c where c\.competition_id = p_competition_id for update/);
      const owner = text.indexOf("p_organizer_gaming_member_id is distinct from v_organizer_id");
      const revoked = text.indexOf("assert_competition_not_host_revoked(p_competition_id)");
      const write = text.search(/\b(insert\s+into|update\s+\w+\s+\w*\s*set|delete\s+from)\b|set_config\(/i);
      expect([lock, row, owner, revoked, write].every((i) => i > -1), name).toBe(true);
      expect(lock, `${name}: lock before row`).toBeLessThan(row);
      expect(row, `${name}: row before ownership`).toBeLessThan(owner);
      expect(owner, `${name}: ownership before revocation`).toBeLessThan(revoked);
      expect(revoked, `${name}: revocation before the first write`).toBeLessThan(write);
      expect(text, name).toMatch(/raise exception 'COMPETITION_ACCESS_DENIED:/);
    }
  });

  it("locks the TEAM row before the competition (the order of every other lifetime operation: its team event's foreign key would otherwise take that lock after the competition's and deadlock), takes no person lock, and never accepts a roster claim", () => {
    const text = functionText("decide_lifetime_competition_entry_atomically");
    const teamLock = text.search(/from lifetime_teams t where t\.lifetime_team_id = v_team_id for update/);
    const scopeLock = text.indexOf("pg_advisory_xact_lock(hashtext('competition_scope:'");
    expect(teamLock, "the team row is locked").toBeGreaterThan(-1);
    expect(teamLock, "and BEFORE the competition scope lock").toBeLessThan(scopeLock);
    // the team is found by a plain read (an entry never changes its team), before any lock
    expect(text.search(/select e\.lifetime_team_id into v_team_id from competition_teams e where/)).toBeLessThan(teamLock);
    expect(text, "the only for-update read of a team is that one (a later one would lock it a second time, after the competition)").not.toMatch(/from lifetime_teams t where t\.lifetime_team_id = v_entry\.lifetime_team_id[^;]*for update/);
    expect(text).not.toMatch(/lifetime_lock_people|pg_advisory_xact_lock\(7101/);
    expect(text, "the only claim update settles a claim as WITHDRAWN or REMOVED, never ACCEPTED").toMatch(/update competition_lifetime_roster_claims c\s+set status = case when c\.status = 'PROPOSED' then 'WITHDRAWN' else 'REMOVED' end/);
    expect(text).not.toMatch(/accepted_at/);
    expect(text).not.toMatch(/'ACCEPT'/);
    expect(text).not.toMatch(/\bdelete\s+from\b/i);
    // approval and removal need registration open; a rejection alone is allowed after the deadline (how a leftover pending entry is cleared)
    expect(text).toMatch(/competition_assert_registration_decision_allowed\(p_competition_id, 'REJECT', v_entry\.created_at\)/);
    expect(text).toMatch(/competition_assert_registration_intake_open\(p_competition_id\)/);
  });

  it("freezes only ACCEPTED entries: refuses while any is pending, counts accepted entries and accepted places of accepted entries, and keeps the rest of the CFM-001 freeze", () => {
    const text = functionText("freeze_lifetime_competition_entries_atomically");
    expect(text).toMatch(/e\.status = 'PENDING_ORGANIZER_APPROVAL'/);
    expect(text.indexOf("LIFETIME_FREEZE_PENDING_ENTRIES")).toBeGreaterThan(text.indexOf("LIFETIME_FREEZE_DEADLINE_NOT_REACHED"));
    expect(text.indexOf("LIFETIME_FREEZE_PENDING_ENTRIES")).toBeLessThan(text.indexOf("LIFETIME_FREEZE_NOT_ENOUGH_ENTRIES"));
    expect(text).toMatch(/select count\(\*\) into v_entries from competition_teams e where e\.competition_id = p_competition_id and e\.entry_flow = 'LIFETIME' and e\.status = 'ACCEPTED'/);
    expect(text).toMatch(/c\.status = 'ACCEPTED' and e\.status = 'ACCEPTED'/);
    expect(text, "a rejected or withdrawn entry is never counted").not.toMatch(/<>\s*'REJECTED'/);
    expect(text).toMatch(/v_entries < 2/);
    expect(text).toMatch(/return query select p_competition_id, v_existing\.frozen_at, v_existing\.entry_count, v_existing\.claim_count, true;/); // the idempotent retry is kept
    expect(text).toMatch(/v_existing\.frozen_at is not null/);
  });

  it("guards the V1 join and membership paths with ONE narrow trigger function, and touches no other V1 object", () => {
    const text = functionText("competition_lifetime_entry_v1_path_guard");
    expect(text).toMatch(/raise exception 'TEAM_NOT_ACCEPTED:/);
    expect(text).toMatch(/t\.entry_flow = 'LIFETIME'/);
    const triggers = [...CODE.matchAll(/create\s+trigger\s+(\w+)\s+before\s+insert\s+on\s+(\w+)\s+for\s+each\s+row\s+execute\s+function\s+competition_lifetime_entry_v1_path_guard\(\)/gi)].map((m) => [m[1], m[2]]);
    expect(triggers).toEqual([
      ["competition_join_requests_lifetime_entry_guard", "competition_join_requests"],
      ["competition_team_memberships_lifetime_entry_guard", "competition_team_memberships"],
    ]);
    // no V1 table is altered: the guard is the only change V1 sees
    const altered = [...CODE.matchAll(/alter\s+table\s+(\w+)/gi)].map((m) => m[1]);
    expect([...new Set(altered)].sort()).toEqual(["competition_lifetime_entry_decisions", "competition_lifetime_flow_events", "competition_lifetime_roster_claims", "lifetime_team_events"]);
  });

  it("proves the recovery from what the flow produced, fails closed, and never deletes data to make itself possible", () => {
    const text = functionText("disable_lifetime_entry_flow_atomically");
    for (const probe of [
      "competition_teams e where e.competition_id = p_competition_id and e.entry_flow = 'LIFETIME'", "competition_lifetime_roster_claims c where c.competition_id = p_competition_id",
      "competition_lifetime_freezes f where f.competition_id = p_competition_id", "competition_lifetime_entry_decisions d where d.competition_id = p_competition_id",
      "competition_teams t where t.competition_id = p_competition_id", "competition_team_memberships m where m.competition_id = p_competition_id",
      "competition_join_requests j where j.competition_id = p_competition_id", "competition_registration_freezes f where f.competition_id = p_competition_id",
      "competition_draws d where d.competition_id = p_competition_id", "competition_fixtures x where x.competition_id = p_competition_id",
      "competition_schedule_proposals s where s.competition_id = p_competition_id",
      "competition_plan_change_proposals p where p.competition_id = p_competition_id", "competition_member_participation_records r where r.competition_id = p_competition_id",
    ]) expect(text, probe).toContain(probe);
    // The schedule PUBLICATION table is on purpose not named: SSS-025's data boundary lets only its own family of functions mention it (a publication needs a PUBLISHED competition,
    // which the state check refuses, and a proposal, a draw and a freeze, which are probed).
    expect(text, "the publication table's data boundary").not.toMatch(/competition_schedule_publications/);
    expect(CODE, "nor does any other object of this migration").not.toMatch(/competition_schedule_publications/);
    expect(text).toMatch(/v_state not in \('DRAFT', 'TEAM_REGISTRATION_OPEN'\)/);
    expect(text).toMatch(/raise exception 'LIFETIME_FLOW_RECOVERY_BLOCKED:/);
    expect(text).toMatch(/raise exception 'LIFETIME_FLOW_RECOVERY_UNSAFE_LEGACY_STATE:/);
    expect(text, "the event is written in the same transaction as the removal").toMatch(/insert into competition_lifetime_flow_events[\s\S]*'DISABLED'/);
    // every refusal comes before the removal
    expect(text.indexOf("LIFETIME_FLOW_RECOVERY_BLOCKED")).toBeLessThan(text.search(/delete\s+from/));
    expect(text.indexOf("LIFETIME_FLOW_RECOVERY_UNSAFE_LEGACY_STATE")).toBeLessThan(text.search(/delete\s+from/));
    // the enablement is on record BEFORE the switch row can ever be removed
    expect(RAW.indexOf("insert into competition_lifetime_flow_events")).toBeLessThan(RAW.indexOf("create function competition_lifetime_flows_row_guard"));
    expect(CODE).toMatch(/jsonb_build_object\('origin', 'FLOW_RECORD_BACKFILL'\)/);
    expect(functionText("enable_lifetime_entry_flow_atomically")).toMatch(/insert into competition_lifetime_flow_events[\s\S]*'ENABLED'/);
  });
});

// =============================================================================================================================================
describe("no public surface", () => {
  const OBJECTS = [...new Set([...CODE.matchAll(/create\s+(?:function|table)\s+(\w+)/gi)].map((m) => m[1]))];
  const TOKENS = new RegExp([...OBJECTS, "decideLifetimeEntry", "disableLifetimeEntryFlow", "decideEntry", "disableEntryFlow", "parseEntryDecisionRequest", "ENTRY_DECISION_REASON_CODES"].join("|"));
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
  const MODULE_FILES = new Set(["lib/gaming/competitions/lifetimeTeams.ts", "lib/gaming/competitions/db/supabaseLifetimeTeamsRepository.ts"]);

  it("derives its tokens from every function and table the migration creates", () => {
    expect(OBJECTS.sort()).toEqual([
      "competition_lifetime_entry_decisions", "competition_lifetime_entry_v1_path_guard", "competition_lifetime_flow_events", "competition_lifetime_flows_row_guard",
      "decide_lifetime_competition_entry_atomically", "disable_lifetime_entry_flow_atomically",
    ]);
    for (const name of OBJECTS) expect(TOKENS.test(name), name).toBe(true);
  });

  it("is referenced by no route, page or public file: there is no organizer surface for it yet", () => {
    const surfaces = [...walk(path.join(ROOT, "app")), ...walk(path.join(ROOT, "public"))].filter((f) => /\.(ts|tsx|js|mjs|html|css|json)$/.test(f));
    expect(surfaces.length).toBeGreaterThan(50);
    const offenders = surfaces.filter((file) => TOKENS.test(readFileSync(file, "utf8"))).map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("is named by no other server code either: outside its own two files, nothing in lib mentions one of its objects", () => {
    const libFiles = walk(path.join(ROOT, "lib")).filter((f) => /\.ts$/.test(f) && !MODULE_FILES.has(path.relative(ROOT, f)));
    expect(libFiles.length).toBeGreaterThan(100);
    const offenders = libFiles.filter((file) => TOKENS.test(readFileSync(file, "utf8"))).map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("adds no bracket, group, league, result, standing, statistic or XP object: the migration creates only the audit tables and the operations above", () => {
    const tables = [...CODE.matchAll(/create\s+table\s+(\w+)/gi)].map((m) => m[1]).sort();
    expect(tables).toEqual(["competition_lifetime_entry_decisions", "competition_lifetime_flow_events"]);
    expect(CODE).not.toMatch(/\b(standings?|statistics?|xp|bracket|league|groups?_stage|result_entry)\b/i);
  });

  it("is registered in the explicit test lists: this file in npm test, the three decision contract files in the contract script and nowhere else", () => {
    const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;
    expect(scripts.test).toContain("__tests__/lifetimeEntryDecisions.test.ts");
    for (const file of ["lifetimeEntryDecisionsSupabase", "lifetimeEntryDecisionsRecoverySupabase", "lifetimeEntryDecisionsConcurrencySupabase"]) {
      expect(scripts["test:contract"], file).toContain(`__tests__/${file}.contract.test.ts`);
      expect(scripts.test, `${file} must stay out of the in-memory suite`).not.toContain(file);
    }
  });
});
