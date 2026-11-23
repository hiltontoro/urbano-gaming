import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  LIFETIME_DATABASE_CODES, LIFETIME_TEAM_NAME_MAX, LIFETIME_TEAM_NAME_MIN, LifetimeTeamError, lifetimeErrorFromDatabase, normalizeLifetimeTeamName,
  parseClaimDecision, parseOfferDecision, parseOfferKind, requireUuid,
  createLifetimeTeam, decideLifetimeMembership, endLifetimeMembership, enterLifetimeTeam, proposeRosterClaims, backfillLegacyTeams,
  type LifetimeTeamsStore,
} from "../lib/gaming/competitions/lifetimeTeams";
import { SupabaseLifetimeTeamsRepository } from "../lib/gaming/competitions/db/supabaseLifetimeTeamsRepository";
import { CompetitionAccessDeniedError, CompetitionCancelledError, TeamRegistrationNotOpenError } from "../lib/gaming/competitions/types";

/**
 * UG-CR-GATE-CFM-001 — Lifetime Teams and Competition Entry Foundation: the application side and the static guarantees about the migration (no database needed).
 *
 * The decisions are the database's. This file proves what the application adds — validation before a call, the stable typed errors, the exact arguments each
 * operation is called with — and, by reading the migration as text, the properties that must hold whatever the database does: it is additive, every new object is
 * server-only, nothing runs the legacy backfill but an explicit call, and no route, page or public file can select or create the lifetime flow.
 */

const ROOT = path.resolve(__dirname, "..");
const read = (relative: string) => readFileSync(path.join(ROOT, relative), "utf8");
const U1 = "11111111-1111-4111-8111-111111111111";
const U2 = "22222222-2222-4222-8222-222222222222";
const U3 = "33333333-3333-4333-8333-333333333333";
const U4 = "44444444-4444-4444-8444-444444444444";

/** The `code` of the LifetimeTeamError a call throws (or a marker when it throws something else, or nothing). */
const codeOf = (fn: () => unknown): string => {
  try { fn(); } catch (err) { return err instanceof LifetimeTeamError ? err.code : `OTHER:${(err as Error)?.name}`; }
  return "NO_THROW";
};

const MIGRATIONS_DIR = path.join(ROOT, "supabase", "migrations");
const migrationFiles = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
const MIGRATION_NAME = migrationFiles.find((f) => /_competition_lifetime_teams_and_entry_foundation\.sql$/.test(f));
const MIGRATION = MIGRATION_NAME ? readFileSync(path.join(MIGRATIONS_DIR, MIGRATION_NAME), "utf8") : "";
const CODE = MIGRATION.replace(/--.*$/gm, ""); // comments removed (the scans below must not be fooled by prose)
// UG-CR-GATE-CFM-004: the organizer-decision migration continues this one. The scans about the refusals the database RAISES read both; the rest of the CFM-001 scans are about the file they were written for.
const DECISIONS_MIGRATION_NAME = migrationFiles.find((f) => /_competition_lifetime_entry_decisions_and_flow_recovery\.sql$/.test(f));
const DECISIONS_CODE = (DECISIONS_MIGRATION_NAME ? readFileSync(path.join(MIGRATIONS_DIR, DECISIONS_MIGRATION_NAME), "utf8") : "").replace(/--.*$/gm, "");

// =============================================================================================================================================
describe("team names", () => {
  it("normalizes whitespace and accepts names from 2 to 60 characters", () => {
    expect(normalizeLifetimeTeamName("  Los   Halcones \t")).toBe("Los Halcones");
    expect(normalizeLifetimeTeamName("ab")).toBe("ab");
    expect(normalizeLifetimeTeamName("x".repeat(LIFETIME_TEAM_NAME_MAX))).toHaveLength(LIFETIME_TEAM_NAME_MAX);
    // The database counts CHARACTERS (code points: char_length), so an emoji is one — never two UTF-16 units.
    expect(Array.from(normalizeLifetimeTeamName("😀".repeat(31)))).toHaveLength(31);
    expect(Array.from(normalizeLifetimeTeamName("😀".repeat(LIFETIME_TEAM_NAME_MAX)))).toHaveLength(LIFETIME_TEAM_NAME_MAX);
    expect(Array.from(normalizeLifetimeTeamName("a".repeat(LIFETIME_TEAM_NAME_MAX - 1) + "😀"))).toHaveLength(LIFETIME_TEAM_NAME_MAX);
    expect(LIFETIME_TEAM_NAME_MIN).toBe(2);
  });

  it.each([[""], ["   "], ["a"], ["😀"], ["x".repeat(61)], ["😀".repeat(61)], ["bad\u0007name"], [null], [undefined], [42], [{}]])("refuses %j with NAME_INVALID", (raw) => {
    expect(() => normalizeLifetimeTeamName(raw)).toThrow(LifetimeTeamError);
    try { normalizeLifetimeTeamName(raw); } catch (err) { expect((err as LifetimeTeamError).code).toBe("NAME_INVALID"); }
  });
});

describe("input parsing", () => {
  it("accepts only well-formed identifiers, decisions and offer kinds, and says so with a stable code", () => {
    expect(requireUuid(U1)).toBe(U1);
    for (const bad of ["", "not-a-uuid", null, undefined, 7, `${U1} `, `${U1}x`, "11111111111111111111111111111111"]) {
      expect(codeOf(() => requireUuid(bad)), String(bad)).toBe("INPUT_INVALID");
    }
    expect(parseOfferDecision("ACCEPT")).toBe("ACCEPT");
    expect(parseOfferDecision("DECLINE")).toBe("DECLINE");
    expect(parseClaimDecision("REJECT")).toBe("REJECT");
    expect(parseOfferKind("LEADERSHIP")).toBe("LEADERSHIP");
    for (const bad of ["accept", "MAYBE", "", null, 1]) {
      expect(codeOf(() => parseOfferDecision(bad)), String(bad)).toBe("DECISION_INVALID");
      expect(codeOf(() => parseClaimDecision(bad)), String(bad)).toBe("DECISION_INVALID");
      expect(codeOf(() => parseOfferKind(bad)), String(bad)).toBe("DECISION_INVALID");
    }
    // a membership offer is declined, a roster claim is rejected: the words are not interchangeable
    expect(codeOf(() => parseOfferDecision("REJECT"))).toBe("DECISION_INVALID");
    expect(codeOf(() => parseClaimDecision("DECLINE"))).toBe("DECISION_INVALID");
  });
});

// =============================================================================================================================================
describe("the database code table", () => {
  it("maps every coded lifetime refusal to a typed error, and only the leading code counts", () => {
    expect(LIFETIME_DATABASE_CODES.length).toBeGreaterThan(40);
    for (const [databaseCode, problem] of LIFETIME_DATABASE_CODES) {
      const error = lifetimeErrorFromDatabase(`${databaseCode}: whatever the database said`);
      expect(error, databaseCode).toBeInstanceOf(LifetimeTeamError);
      expect(error!.code, databaseCode).toBe(problem);
      expect(error!.message, databaseCode).not.toMatch(/LIFETIME_|whatever the database said/);
      expect(lifetimeErrorFromDatabase(`some other text mentioning ${databaseCode} later`), `${databaseCode} not at the start`).toBeNull();
    }
    expect(lifetimeErrorFromDatabase("COMPETITION_NOT_FOUND: no such competition exists")).toBeNull();
    expect(lifetimeErrorFromDatabase("")).toBeNull();
  });

  it("uses distinct, prefixed codes, and none collides with a code the existing repository already matches by containment", () => {
    const mine = LIFETIME_DATABASE_CODES.map(([code]) => code);
    expect(new Set(mine).size).toBe(mine.length);
    expect(new Set(LIFETIME_DATABASE_CODES.map(([, problem]) => problem)).size).toBe(mine.length);
    for (const code of mine) expect(code).toMatch(/^LIFETIME_[A-Z_]+$/);
    for (const a of mine) for (const b of mine) if (a !== b) expect(b.includes(a), `${a} is contained in ${b}`).toBe(false);
    const v1Source = read("lib/gaming/competitions/db/supabaseCompetitionsRepository.ts");
    const v1Codes = [...v1Source.matchAll(/\["([A-Z][A-Z0-9_]+)", \(\) =>/g)].map((m) => m[1]);
    expect(v1Codes.length).toBeGreaterThan(60);
    for (const mineCode of mine) for (const v1 of v1Codes) {
      expect(mineCode.includes(v1), `${v1} is contained in ${mineCode}`).toBe(false);
      expect(v1.includes(mineCode), `${mineCode} is contained in ${v1}`).toBe(false);
    }
  });

  it("maps EVERY coded refusal the lifetime migrations raise (a code added to the SQL but not to the table would reach a caller as UNAVAILABLE)", () => {
    expect(DECISIONS_MIGRATION_NAME, "the CFM-004 migration must exist").toBeTruthy();
    const raised = [...new Set([...(CODE + "\n" + DECISIONS_CODE).matchAll(/raise\s+exception\s+'(LIFETIME_[A-Z_]+):/g)].map((m) => m[1]))];
    expect(raised.length).toBeGreaterThan(50);
    const mapped = new Set(LIFETIME_DATABASE_CODES.map(([code]) => code));
    expect(raised.filter((code) => !mapped.has(code))).toEqual([]);
    expect([...mapped].filter((code) => !raised.includes(code)), "a mapped code the migration never raises is dead weight").toEqual([]);
  });

  it("states a count only when the database stated one (the roster refusals)", () => {
    const below = lifetimeErrorFromDatabase("LIFETIME_FREEZE_ROSTER_BELOW_MINIMUM: an entry has 3 accepted player(s); the minimum is 5");
    expect(below!.code).toBe("FREEZE_ROSTER_BELOW_MINIMUM");
    expect(below!.message).toMatch(/3/);
    expect(below!.message).toMatch(/5/);
    const bare = lifetimeErrorFromDatabase("LIFETIME_FREEZE_ROSTER_BELOW_MINIMUM: no numbers here");
    expect(bare!.message).not.toMatch(/\d/);
  });
});

// =============================================================================================================================================
describe("the domain functions", () => {
  const store = () => {
    const fn = vi.fn(async (..._args: unknown[]) => ({}) as never);
    return {
      fn,
      store: new Proxy({}, { get: () => fn }) as unknown as LifetimeTeamsStore,
    };
  };

  it("normalizes the name and calls the store once with validated arguments", async () => {
    const { fn, store: s } = store();
    await createLifetimeTeam(s, U1, "  Los   Tigres ");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(U1, "Los Tigres");
  });

  it("refuses a malformed identifier or decision BEFORE the store is called", async () => {
    const { fn, store: s } = store();
    await expect(createLifetimeTeam(s, "nope", "Los Tigres")).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(createLifetimeTeam(s, U1, "x")).rejects.toMatchObject({ code: "NAME_INVALID" });
    await expect(decideLifetimeMembership(s, U1, U2, "REJECT")).rejects.toMatchObject({ code: "DECISION_INVALID" });
    await expect(endLifetimeMembership(s, U1, U2, "not-a-uuid")).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(proposeRosterClaims(s, U1, U2, [])).rejects.toMatchObject({ code: "CLAIM_BATCH_INVALID" });
    await expect(proposeRosterClaims(s, U1, U2, [U3, U3])).rejects.toMatchObject({ code: "CLAIM_BATCH_INVALID" });
    await expect(proposeRosterClaims(s, U1, U2, Array.from({ length: 33 }, (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`))).rejects.toMatchObject({ code: "CLAIM_BATCH_INVALID" });
    await expect(proposeRosterClaims(s, U1, U2, [U3, "nope"])).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(backfillLegacyTeams(s, [])).rejects.toMatchObject({ code: "BACKFILL_SCOPE_INVALID" });
    await expect(enterLifetimeTeam(s, U1, U2, "")).rejects.toMatchObject({ code: "INPUT_INVALID" });
    expect(fn).not.toHaveBeenCalled();
  });

  it("passes a successor only when one is named, a claim batch as given, and the backfill scope only as a named list (there is no \"all\")", async () => {
    const { fn, store: s } = store();
    await endLifetimeMembership(s, U1, U2, U2);
    expect(fn).toHaveBeenLastCalledWith(U1, U2, U2, null);
    await endLifetimeMembership(s, U1, U2, U2, U3);
    expect(fn).toHaveBeenLastCalledWith(U1, U2, U2, U3);
    await proposeRosterClaims(s, U1, U2, [U3, U4]);
    expect(fn).toHaveBeenLastCalledWith(U1, U2, [U3, U4]);
    await backfillLegacyTeams(s, [U1]);
    expect(fn).toHaveBeenLastCalledWith([U1]);
    fn.mockClear();
    for (const scope of [null, undefined, [], "all"]) await expect(backfillLegacyTeams(s, scope)).rejects.toMatchObject({ code: "BACKFILL_SCOPE_INVALID" });
    await expect(backfillLegacyTeams(s, [U1, "not-a-uuid"])).rejects.toMatchObject({ code: "INPUT_INVALID" });
    expect(fn).not.toHaveBeenCalled(); // a refused scope never reaches the store
  });
});

// =============================================================================================================================================
describe("the Supabase repository adapter", () => {
  /** A client whose rpc answers from a script; the adapter must call each operation by its exact database name with its exact parameter names. */
  function repoWith(answer: (name: string, args: Record<string, unknown>) => { data?: unknown; error?: { code?: string; message?: string } | null }) {
    const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => ({ data: null, error: null, ...answer(name, args) }));
    const repo = new SupabaseLifetimeTeamsRepository("http://127.0.0.1:1", "service-key", { rpc } as never);
    return { repo, rpc };
  }

  const CASES: Array<[string, (r: SupabaseLifetimeTeamsRepository) => Promise<unknown>, string, Record<string, unknown>, unknown[]]> = [
    ["createLifetimeTeam", (r) => r.createLifetimeTeam(U1, "Los Halcones"), "create_lifetime_team_atomically", { p_creator_gaming_member_id: U1, p_name: "Los Halcones" }, [{ lifetime_team_id: U2, public_code: "c".repeat(22), created_at: "2026-11-20T00:00:00Z" }]],
    ["disbandLifetimeTeam", (r) => r.disbandLifetimeTeam(U1, U2), "disband_lifetime_team_atomically", { p_lifetime_team_id: U1, p_actor_gaming_member_id: U2 }, [{ lifetime_team_id: U1, status: "DISBANDED", disbanded_at: "2026-11-20T00:00:00Z" }]],
    ["proposeMembership", (r) => r.proposeMembership(U1, U2, U3), "propose_lifetime_team_membership_atomically", { p_lifetime_team_id: U1, p_actor_gaming_member_id: U2, p_subject_gaming_member_id: U3 }, [{ lifetime_team_membership_id: U4, status: "PENDING", initiated_by_side: "TEAM", expires_at: "2026-11-27T00:00:00Z" }]],
    ["decideMembership", (r) => r.decideMembership(U1, U2, "ACCEPT"), "decide_lifetime_team_membership_atomically", { p_lifetime_team_membership_id: U1, p_actor_gaming_member_id: U2, p_decision: "ACCEPT" }, [{ lifetime_team_membership_id: U1, status: "ACTIVE", joined_at: "2026-11-20T00:00:00Z" }]],
    ["withdrawOffer", (r) => r.withdrawOffer("MEMBERSHIP", U1, U2), "withdraw_lifetime_team_offer_atomically", { p_offer_kind: "MEMBERSHIP", p_offer_id: U1, p_actor_gaming_member_id: U2 }, [{ offer_id: U1, status: "ENDED" }]],
    ["endMembership", (r) => r.endMembership(U1, U2, U2), "end_lifetime_team_membership_atomically", { p_lifetime_team_id: U1, p_actor_gaming_member_id: U2, p_subject_gaming_member_id: U2, p_successor_gaming_member_id: null }, [{ lifetime_team_membership_id: U1, ended_at: "2026-11-20T00:00:00Z", successor_leadership_id: null }]],
    ["offerLeadership", (r) => r.offerLeadership(U1, U2, U3), "offer_lifetime_team_leadership_atomically", { p_lifetime_team_id: U1, p_actor_gaming_member_id: U2, p_subject_gaming_member_id: U3 }, [{ lifetime_team_leadership_id: U4, status: "PENDING", expires_at: "2026-11-27T00:00:00Z" }]],
    ["decideLeadership", (r) => r.decideLeadership(U1, U2, "DECLINE"), "decide_lifetime_team_leadership_atomically", { p_lifetime_team_leadership_id: U1, p_actor_gaming_member_id: U2, p_decision: "DECLINE" }, [{ lifetime_team_leadership_id: U1, status: "ENDED", started_at: null }]],
    ["endLeadership", (r) => r.endLeadership(U1, U2), "end_lifetime_team_leadership_atomically", { p_lifetime_team_id: U1, p_actor_gaming_member_id: U2 }, [{ lifetime_team_leadership_id: U1, ended_at: "2026-11-20T00:00:00Z", end_reason: "STEPPED_DOWN" }]],
    ["enableEntryFlow", (r) => r.enableEntryFlow(U1, U2), "enable_lifetime_entry_flow_atomically", { p_competition_id: U1, p_organizer_gaming_member_id: U2 }, [{ competition_id: U1, enabled_at: "2026-11-20T00:00:00Z", already_enabled: false }]],
    ["enterTeam", (r) => r.enterTeam(U1, U2, U3), "enter_lifetime_team_into_competition_atomically", { p_competition_id: U1, p_lifetime_team_id: U2, p_actor_gaming_member_id: U3 }, [{ competition_team_id: U4, public_code: "d".repeat(22), created_at: "2026-11-20T00:00:00Z" }]],
    ["withdrawEntry", (r) => r.withdrawEntry(U1, U2), "withdraw_lifetime_competition_entry_atomically", { p_competition_team_id: U1, p_actor_gaming_member_id: U2 }, [{ competition_team_id: U1, status: "REJECTED", released_claims: 3 }]],
    ["proposeRosterClaims", (r) => r.proposeRosterClaims(U1, U2, [U3, U4]), "propose_lifetime_entry_roster_claims_atomically", { p_competition_team_id: U1, p_actor_gaming_member_id: U2, p_gaming_member_ids: [U3, U4] }, [{ competition_lifetime_roster_claim_id: U1, gaming_member_id: U3, status: "PROPOSED", expires_at: "2026-11-27T00:00:00Z" }]],
    ["decideRosterClaim", (r) => r.decideRosterClaim(U1, U2, "ACCEPT"), "decide_lifetime_entry_roster_claim_atomically", { p_competition_lifetime_roster_claim_id: U1, p_actor_gaming_member_id: U2, p_decision: "ACCEPT" }, [{ competition_lifetime_roster_claim_id: U1, status: "ACCEPTED", accepted_at: "2026-11-20T00:00:00Z" }]],
    ["releaseRosterClaim", (r) => r.releaseRosterClaim(U1, U2), "release_lifetime_entry_roster_claim_atomically", { p_competition_lifetime_roster_claim_id: U1, p_actor_gaming_member_id: U2 }, [{ competition_lifetime_roster_claim_id: U1, status: "WITHDRAWN", release_reason: "PERSON_WITHDREW" }]],
    ["freezeEntries", (r) => r.freezeEntries(U1, U2), "freeze_lifetime_competition_entries_atomically", { p_competition_id: U1, p_organizer_gaming_member_id: U2 }, [{ competition_id: U1, frozen_at: "2026-11-20T00:00:00Z", entry_count: 2, claim_count: 12, already_frozen: false }]],
    ["backfillLegacyTeams", (r) => r.backfillLegacyTeams([U1]), "backfill_legacy_competition_teams_atomically", { p_competition_ids: [U1] }, [{ teams_created: 1, memberships_created: 2, leaderships_created: 1, skipped_already_linked: 0, skipped_not_accepted: 0 }]],
  ];

  it.each(CASES)("%s calls exactly the database operation with exactly its parameter names", async (_label, call, rpcName, args, rows) => {
    const { repo, rpc } = repoWith(() => ({ data: rows }));
    await call(repo);
    expect(rpc).toHaveBeenCalledTimes(1);
    expect(rpc).toHaveBeenCalledWith(rpcName, args);
  });

  it("covers every operation the migration defines (no operation is reachable only by a raw call)", () => {
    const defined = [...CODE.matchAll(/create function (\w+_atomically)\s*\(/g)].map((m) => m[1]);
    expect(defined.length).toBe(17);
    expect(CASES.map((c) => c[2]).sort()).toEqual([...defined].sort());
  });

  it("translates a coded lifetime refusal into a LifetimeTeamError with no database wording", async () => {
    const { repo } = repoWith(() => ({ error: { code: "P0001", message: "LIFETIME_NAME_TAKEN: a team with this name already exists" } }));
    const error = await repo.createLifetimeTeam(U1, "Los Halcones").catch((e) => e);
    expect(error).toBeInstanceOf(LifetimeTeamError);
    expect(error.code).toBe("NAME_TAKEN");
    expect(error.message).not.toMatch(/LIFETIME_|already exists/);
  });

  it("translates the shared competition refusals into the existing typed errors", async () => {
    const denied = repoWith(() => ({ error: { code: "P0001", message: "COMPETITION_ACCESS_DENIED: only this competition's own organizer may do this" } }));
    expect(await denied.repo.enableEntryFlow(U1, U2).catch((e) => e)).toBeInstanceOf(CompetitionAccessDeniedError);
    const cancelled = repoWith(() => ({ error: { code: "P0001", message: "COMPETITION_CANCELLED: this competition has been cancelled" } }));
    expect(await cancelled.repo.freezeEntries(U1, U2).catch((e) => e)).toBeInstanceOf(CompetitionCancelledError);
  });

  it("rebuilds the shared refusals this gate raises with their own bounded messages — no code token, no database wording, no internal feature name — keeping their classes", async () => {
    const denied = repoWith(() => ({ error: { code: "P0001", message: "COMPETITION_ACCESS_DENIED: only this competition's own organizer may enable the lifetime flow" } }));
    const a = await denied.repo.enableEntryFlow(U1, U2).catch((e) => e);
    expect(a).toBeInstanceOf(CompetitionAccessDeniedError);
    expect(a.message).toBe(new CompetitionAccessDeniedError().message);
    expect(a.message).not.toMatch(/COMPETITION_ACCESS_DENIED|lifetime flow|organizer may/i);
    for (const database of [
      "TEAM_REGISTRATION_NOT_OPEN: team entries are only accepted while team registration is open",
      "TEAM_REGISTRATION_NOT_OPEN: the registration deadline for this competition has passed",
      "TEAM_REGISTRATION_NOT_OPEN: registration is closed for this competition",
    ]) {
      const closed = repoWith(() => ({ error: { code: "P0001", message: database } }));
      const b = await closed.repo.enterTeam(U1, U2, U3).catch((e) => e);
      expect(b, database).toBeInstanceOf(TeamRegistrationNotOpenError);
      expect(b.message, database).toBe(new TeamRegistrationNotOpenError().message);
      expect(b.message, database).not.toMatch(/TEAM_REGISTRATION_NOT_OPEN|deadline|entries/i);
    }
  });

  it("reads through a client that never uses the Next.js Data Cache (like every sibling repository), and takes an injected client only for tests", () => {
    const source = read("lib/gaming/competitions/db/supabaseLifetimeTeamsRepository.ts");
    expect(source).toMatch(/global:\s*\{\s*fetch:\s*\(input,\s*init\)\s*=>\s*fetch\(input,\s*\{\s*\.\.\.init,\s*cache:\s*"no-store"\s*\}/);
    expect(source).toMatch(/client\s*\?\?\s*createClient\(/);
  });

  it("takes exactly the parameters the migration's signatures declare (a typo in a hand-copied parameter name would otherwise only show up against a database)", () => {
    const signatures = new Map<string, string[]>();
    for (const m of CODE.matchAll(/create\s+function\s+(\w+_atomically)\s*\(([^)]*)\)/gi)) {
      signatures.set(m[1], m[2].split(",").map((part) => part.trim().split(/\s+/)[0]).filter(Boolean).sort());
    }
    expect(signatures.size).toBe(17);
    for (const [label, , rpcName, args] of CASES) expect(Object.keys(args).sort(), `${label} -> ${rpcName}`).toEqual(signatures.get(rpcName));
  });

  /** What each operation's answer becomes, for every branch that changes the mapped value (a default-branch row cannot tell a hard-coded constant from a field). */
  const RESULTS: Array<[string, (r: SupabaseLifetimeTeamsRepository) => Promise<unknown>, unknown[], unknown]> = [
    ["createLifetimeTeam", (r) => r.createLifetimeTeam(U1, "Los Halcones"), [{ lifetime_team_id: U2, public_code: "c".repeat(22), created_at: "T1" }], { lifetimeTeamId: U2, publicCode: "c".repeat(22), createdAt: "T1" }],
    ["disbandLifetimeTeam", (r) => r.disbandLifetimeTeam(U1, U2), [{ lifetime_team_id: U1, status: "DISBANDED", disbanded_at: "T2" }], { lifetimeTeamId: U1, status: "DISBANDED", disbandedAt: "T2" }],
    ["proposeMembership by the team", (r) => r.proposeMembership(U1, U2, U3), [{ lifetime_team_membership_id: U4, status: "PENDING", initiated_by_side: "TEAM", expires_at: "T3" }], { lifetimeTeamMembershipId: U4, status: "PENDING", initiatedBySide: "TEAM", expiresAt: "T3" }],
    ["proposeMembership by the person", (r) => r.proposeMembership(U1, U2, U2), [{ lifetime_team_membership_id: U4, status: "PENDING", initiated_by_side: "PERSON", expires_at: "T3" }], { lifetimeTeamMembershipId: U4, status: "PENDING", initiatedBySide: "PERSON", expiresAt: "T3" }],
    ["decideMembership ACCEPT", (r) => r.decideMembership(U1, U2, "ACCEPT"), [{ lifetime_team_membership_id: U1, status: "ACTIVE", joined_at: "T4" }], { lifetimeTeamMembershipId: U1, status: "ACTIVE", joinedAt: "T4" }],
    ["decideMembership DECLINE", (r) => r.decideMembership(U1, U2, "DECLINE"), [{ lifetime_team_membership_id: U1, status: "ENDED", joined_at: null }], { lifetimeTeamMembershipId: U1, status: "ENDED", joinedAt: null }],
    ["withdrawOffer", (r) => r.withdrawOffer("LEADERSHIP", U3, U2), [{ offer_id: U3, status: "ENDED" }], { offerId: U3, status: "ENDED" }],
    ["endMembership with a successor", (r) => r.endMembership(U1, U2, U2, U3), [{ lifetime_team_membership_id: U1, ended_at: "T5", successor_leadership_id: U4 }], { lifetimeTeamMembershipId: U1, endedAt: "T5", successorLeadershipId: U4 }],
    ["endMembership without one", (r) => r.endMembership(U1, U2, U2), [{ lifetime_team_membership_id: U1, ended_at: "T5", successor_leadership_id: null }], { lifetimeTeamMembershipId: U1, endedAt: "T5", successorLeadershipId: null }],
    ["offerLeadership", (r) => r.offerLeadership(U1, U2, U3), [{ lifetime_team_leadership_id: U4, status: "PENDING", expires_at: "T6" }], { lifetimeTeamLeadershipId: U4, status: "PENDING", expiresAt: "T6" }],
    ["decideLeadership ACCEPT", (r) => r.decideLeadership(U1, U2, "ACCEPT"), [{ lifetime_team_leadership_id: U1, status: "ACTIVE", started_at: "T7" }], { lifetimeTeamLeadershipId: U1, status: "ACTIVE", startedAt: "T7" }],
    ["decideLeadership DECLINE", (r) => r.decideLeadership(U1, U2, "DECLINE"), [{ lifetime_team_leadership_id: U1, status: "ENDED", started_at: null }], { lifetimeTeamLeadershipId: U1, status: "ENDED", startedAt: null }],
    ["endLeadership REMOVED", (r) => r.endLeadership(U1, U2), [{ lifetime_team_leadership_id: U1, ended_at: "T8", end_reason: "REMOVED" }], { lifetimeTeamLeadershipId: U1, endedAt: "T8", endReason: "REMOVED" }],
    ["endLeadership STEPPED_DOWN", (r) => r.endLeadership(U1, U2), [{ lifetime_team_leadership_id: U1, ended_at: "T8", end_reason: "STEPPED_DOWN" }], { lifetimeTeamLeadershipId: U1, endedAt: "T8", endReason: "STEPPED_DOWN" }],
    ["enableEntryFlow already on", (r) => r.enableEntryFlow(U1, U2), [{ competition_id: U1, enabled_at: "T9", already_enabled: true }], { competitionId: U1, enabledAt: "T9", alreadyEnabled: true }],
    ["enterTeam", (r) => r.enterTeam(U1, U2, U3), [{ competition_team_id: U4, public_code: "d".repeat(22), created_at: "T10" }], { competitionTeamId: U4, publicCode: "d".repeat(22), createdAt: "T10" }],
    ["withdrawEntry", (r) => r.withdrawEntry(U1, U2), [{ competition_team_id: U1, status: "REJECTED", released_claims: 3 }], { competitionTeamId: U1, status: "REJECTED", releasedClaims: 3 }],
    ["proposeRosterClaims", (r) => r.proposeRosterClaims(U1, U2, [U3, U4]), [{ competition_lifetime_roster_claim_id: U1, gaming_member_id: U3, status: "PROPOSED", expires_at: "T11" }, { competition_lifetime_roster_claim_id: U2, gaming_member_id: U4, status: "PROPOSED", expires_at: "T12" }],
      [{ claimId: U1, gamingMemberId: U3, status: "PROPOSED", expiresAt: "T11" }, { claimId: U2, gamingMemberId: U4, status: "PROPOSED", expiresAt: "T12" }]],
    ["decideRosterClaim ACCEPT", (r) => r.decideRosterClaim(U1, U2, "ACCEPT"), [{ competition_lifetime_roster_claim_id: U1, status: "ACCEPTED", accepted_at: "T13" }], { claimId: U1, status: "ACCEPTED", acceptedAt: "T13" }],
    ["decideRosterClaim REJECT", (r) => r.decideRosterClaim(U1, U2, "REJECT"), [{ competition_lifetime_roster_claim_id: U1, status: "REJECTED", accepted_at: null }], { claimId: U1, status: "REJECTED", acceptedAt: null }],
    ["releaseRosterClaim removed by a leader", (r) => r.releaseRosterClaim(U1, U2), [{ competition_lifetime_roster_claim_id: U1, status: "REMOVED", release_reason: "LEADER_REMOVED" }], { claimId: U1, status: "REMOVED", releaseReason: "LEADER_REMOVED" }],
    ["releaseRosterClaim withdrawn", (r) => r.releaseRosterClaim(U1, U2), [{ competition_lifetime_roster_claim_id: U1, status: "WITHDRAWN", release_reason: "PERSON_WITHDREW" }], { claimId: U1, status: "WITHDRAWN", releaseReason: "PERSON_WITHDREW" }],
    ["freezeEntries", (r) => r.freezeEntries(U1, U2), [{ competition_id: U1, frozen_at: "T14", entry_count: 3, claim_count: 17, already_frozen: true }], { competitionId: U1, frozenAt: "T14", entryCount: 3, claimCount: 17, alreadyFrozen: true }],
    ["backfillLegacyTeams (every count distinct, so a swap shows)", (r) => r.backfillLegacyTeams([U1]), [{ teams_created: 1, memberships_created: 2, leaderships_created: 3, skipped_already_linked: 4, skipped_not_accepted: 5 }],
      { teamsCreated: 1, membershipsCreated: 2, leadershipsCreated: 3, skippedAlreadyLinked: 4, skippedNotAccepted: 5 }],
  ];

  it.each(RESULTS)("%s maps the database's answer field by field", async (_label, call, rows, expected) => {
    const { repo } = repoWith(() => ({ data: rows }));
    expect(await call(repo)).toEqual(expected);
  });

  it("reads the teams a member belongs to (the embedded team may arrive as an object or a one-element list; a missing team is skipped)", async () => {
    const answer = (rows: unknown[]) => {
      const chain: Record<string, unknown> = {};
      for (const method of ["select", "eq"]) chain[method] = () => chain;
      chain.order = async () => ({ data: rows, error: null });
      return new SupabaseLifetimeTeamsRepository("http://127.0.0.1:1", "service-key", { from: () => chain, rpc: vi.fn() } as never);
    };
    const team = { public_code: "e".repeat(22), name: "Los Halcones", status: "ACTIVE" };
    const result = await answer([
      { lifetime_team_id: U1, joined_at: "T1", is_legacy: false, team },
      { lifetime_team_id: U2, joined_at: "T2", is_legacy: true, team: [{ ...team, name: "Old FC", status: "DISBANDED" }] },
      { lifetime_team_id: U3, joined_at: "T3", is_legacy: false, team: null },
    ]).listActiveTeamsOfMember(U4);
    expect(result).toEqual([
      { lifetimeTeamId: U1, publicCode: team.public_code, name: "Los Halcones", status: "ACTIVE", joinedAt: "T1", isLegacy: false },
      { lifetimeTeamId: U2, publicCode: team.public_code, name: "Old FC", status: "DISBANDED", joinedAt: "T2", isLegacy: true },
    ]);
    await expect(answer([]).listActiveTeamsOfMember("nope")).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });

  it("reads a team with its leaders and members in ONE request (one snapshot), ordered by their sequence", async () => {
    const calls: string[] = [];
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "eq"]) chain[method] = (...args: unknown[]) => { calls.push(`${method}:${args.join(",")}`); return chain; };
    chain.maybeSingle = async () => ({
      data: {
        lifetime_team_id: U1, public_code: "f".repeat(22), name: "Los Halcones", status: "ACTIVE", origin: "NEW", created_at: "T0", disbanded_at: null,
        lifetime_team_leaderships: [{ role: "SUB_CAPTAIN", gaming_member_id: U3, started_at: "T2", seq: 9 }, { role: "CAPTAIN", gaming_member_id: U2, started_at: "T1", seq: 4 }],
        lifetime_team_memberships: [{ gaming_member_id: U3, joined_at: "T2", is_legacy: false, seq: 8 }, { gaming_member_id: U2, joined_at: "T1", is_legacy: true, seq: 3 }],
      },
      error: null,
    });
    const from = vi.fn(() => chain);
    const repo = new SupabaseLifetimeTeamsRepository("http://127.0.0.1:1", "service-key", { from, rpc: vi.fn() } as never);
    const view = await repo.getLifetimeTeam(U1);
    expect(from).toHaveBeenCalledTimes(1); // one statement: leaders and members cannot come from different moments
    expect(view!.leaders.map((l) => l.role)).toEqual(["CAPTAIN", "SUB_CAPTAIN"]);
    expect(view!.members).toEqual([{ gamingMemberId: U2, joinedAt: "T1", isLegacy: true }, { gamingMemberId: U3, joinedAt: "T2", isLegacy: false }]);
    expect(calls).toContain("eq:lifetime_team_leaderships.status,ACTIVE");
    expect(calls).toContain("eq:lifetime_team_memberships.status,ACTIVE");
  });

  it("reads an entry with its roster claims in ONE request (one snapshot), ordered by their sequence — never an entry from one moment and its claims from another", async () => {
    const calls: string[] = [];
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "eq"]) chain[method] = (...args: unknown[]) => { calls.push(`${method}:${args.join(",")}`); return chain; };
    chain.maybeSingle = async () => ({
      data: {
        competition_team_id: U1, competition_id: U2, lifetime_team_id: U3, public_code: "g".repeat(22), name: "Los Halcones", captain_gaming_member_id: U4,
        sub_captain_gaming_member_id: null, status: "PENDING_ORGANIZER_APPROVAL", created_at: "T0",
        competition_lifetime_roster_claims: [
          { competition_lifetime_roster_claim_id: "c2", gaming_member_id: U3, status: "ACCEPTED", accepted_at: "T3", departed_at: null, seq: 7 },
          { competition_lifetime_roster_claim_id: "c1", gaming_member_id: U2, status: "PROPOSED", accepted_at: null, departed_at: null, seq: 2 },
        ],
      },
      error: null,
    });
    const from = vi.fn(() => chain);
    const repo = new SupabaseLifetimeTeamsRepository("http://127.0.0.1:1", "service-key", { from, rpc: vi.fn() } as never);
    const view = await repo.getEntry(U1);
    expect(from).toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith("competition_teams");
    expect(calls.find((c) => c.startsWith("select:")), "the claims are embedded in the one statement").toMatch(/competition_lifetime_roster_claims\(/);
    expect(calls).toContain(`eq:competition_team_id,${U1}`);
    expect(calls).toContain("eq:entry_flow,LIFETIME");
    expect(view!.claims.map((c) => c.claimId)).toEqual(["c1", "c2"]);
    expect(view).toMatchObject({ competitionTeamId: U1, competitionId: U2, lifetimeTeamId: U3, captainGamingMemberId: U4, subCaptainGamingMemberId: null, status: "PENDING_ORGANIZER_APPROVAL" });
    chain.maybeSingle = async () => ({ data: null, error: null });
    expect(await repo.getEntry(U1)).toBeNull();
  });

  it("turns anything else — an unknown refusal, a raw database failure, a missing row — into a bounded error that carries none of the database's words", async () => {
    for (const error of [
      { code: "P0001", message: "SOMETHING_NEW: unexpected thing with secret detail" },
      { code: "23505", message: 'duplicate key value violates unique constraint "x" secret' },
      { code: "40P01", message: "deadlock detected secret" },
      { code: "PGRST202", message: "Could not find the function secret" },
      { message: "fetch failed secret" },
    ]) {
      const { repo } = repoWith(() => ({ error }));
      const thrown = await repo.freezeEntries(U1, U2).catch((e) => e);
      expect(thrown, JSON.stringify(error)).toBeInstanceOf(LifetimeTeamError);
      expect(thrown.code).toBe("UNAVAILABLE");
      expect(thrown.message).not.toMatch(/secret|duplicate|deadlock|PGRST|fetch/i);
    }
    const { repo } = repoWith(() => ({ data: [] }));
    expect(await repo.createLifetimeTeam(U1, "Los Halcones").catch((e) => e)).toBeInstanceOf(LifetimeTeamError);
  });

  it("validates identifiers before any call is made", async () => {
    const { repo, rpc } = repoWith(() => ({ data: [] }));
    await expect(repo.endMembership("nope", U2, U3)).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(repo.decideRosterClaim(U1, U2, "MAYBE" as never)).rejects.toMatchObject({ code: "DECISION_INVALID" });
    expect(rpc).not.toHaveBeenCalled();
  });
});

// =============================================================================================================================================
describe("the migration (read as text)", () => {
  it("exists, follows the newest migration the SSS chain had, and is one coherent append-only file", () => {
    expect(MIGRATION_NAME, "the lifetime migration must exist").toBeTruthy();
    // Bounded on BOTH sides, so a later gate's migration never makes this fail: nothing sorts between the predecessor (the newest SSS migration, compared by its full file
    // name — its bare timestamp sorts before its own file) and this file.
    const PREDECESSOR = "20261106001815_competition_four_team_schedule_publication_foundation.sql";
    expect(migrationFiles).toContain(PREDECESSOR);
    expect(migrationFiles.filter((f) => f > PREDECESSOR && f <= MIGRATION_NAME!)).toEqual([MIGRATION_NAME]);
    expect(MIGRATION_NAME!.slice(0, 14) > "20261101022329").toBe(true); // after the newest migration on main
    expect(migrationFiles.filter((f) => /_competition_lifetime_teams_and_entry_foundation\.sql$/.test(f))).toHaveLength(1);
    expect(MIGRATION.length).toBeGreaterThan(20000);
  });

  /** Every write target in the migration's executable text (comments removed), wherever on a line the statement sits. */
  const writeTargets = () => {
    const targets = new Set<string>();
    for (const m of CODE.matchAll(/\binsert\s+into\s+(\w+)/gi)) targets.add(m[1]);
    for (const m of CODE.matchAll(/\bupdate\s+(\w+)(?:\s+\w+)?\s+set\b/gi)) targets.add(m[1]);
    for (const m of CODE.matchAll(/\bdelete\s+from\s+(\w+)/gi)) targets.add(m[1]);
    return targets;
  };
  const MINE = new Set(["lifetime_teams", "lifetime_team_memberships", "lifetime_team_leaderships", "lifetime_team_events", "lifetime_team_legacy_sources", "competition_lifetime_flows", "competition_lifetime_roster_claims", "competition_lifetime_freezes"]);

  it("is additive: no drop, truncate or delete anywhere in a statement, and it writes only to its own tables and to the one lifetime entry table", () => {
    expect(CODE).not.toMatch(/\bdrop\s+(table|function|trigger|index|policy|schema|type|view|column|constraint|sequence|extension|role)\b/i);
    expect(CODE).not.toMatch(/(?:^|;)\s*truncate\s+(?:table\s+)?\w/im); // (a `before truncate` trigger is a guard, not a truncate)
    expect(CODE).not.toMatch(/\bdelete\s+from\b/i);
    expect([...writeTargets()].filter((t) => !MINE.has(t) && t !== "competition_teams"), "write targets outside the lifetime tables and competition_teams").toEqual([]);
    const alters = [...CODE.matchAll(/\balter\s+(table|function|sequence|type|index|policy|trigger)\s+(?:if\s+exists\s+)?(?:only\s+)?(?:public\.)?(\w+)/gi)];
    expect(alters.filter((m) => m[1].toLowerCase() !== "table"), "only tables are altered").toEqual([]);
    for (const [, , table] of alters) expect(MINE.has(table) || table === "competition_teams", `alter table ${table}`).toBe(true);
    for (const statement of CODE.matchAll(/\balter\s+table\s+competition_teams\b([\s\S]*?);/gi)) expect(statement[1], "competition_teams may only gain columns, constraints and indexes").toMatch(/^\s*(add\s+(column|constraint)|enable\s+row)/i);
    // Nothing is created in another schema, replaced or hidden: one strict `create function name (` form, no `or replace`, no schema qualifier on a created object.
    expect(CODE).not.toMatch(/\bcreate\s+or\s+replace\b/i);
    expect(CODE).not.toMatch(/\bcreate\s+(function|table|trigger|index|unique\s+index)\s+(if\s+not\s+exists\s+)?\w+\./i);
    expect([...CODE.matchAll(/\bcreate\s+function\b/gi)].length).toBe([...CODE.matchAll(/\bcreate\s+function\s+\w+\s*\(/gi)].length);
  });

  it("puts triggers only on its own tables and on the three V1 tables the lifetime flow must keep out of", () => {
    const triggers = [...CODE.matchAll(/create\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s+\w+\s+(?:before|after|instead\s+of)\s+[\w\s,]+?\s+on\s+(?:public\.)?(\w+)/gi)].map((m) => m[1]);
    expect(triggers.length, "every trigger statement is recognised").toBe([...CODE.matchAll(/\bcreate\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\b/gi)].length);
    expect(triggers.length).toBeGreaterThan(10);
    const allowed = new Set(["lifetime_teams", "lifetime_team_memberships", "lifetime_team_leaderships", "lifetime_team_events", "lifetime_team_legacy_sources", "competition_lifetime_flows", "competition_lifetime_roster_claims", "competition_lifetime_freezes", "competition_teams", "competition_registration_freezes", "competition_fixtures"]);
    for (const table of triggers) expect(allowed.has(table), `trigger on ${table}`).toBe(true);
    for (const table of ["competition_teams", "competition_registration_freezes", "competition_fixtures"]) expect(triggers, table).toContain(table);
  });

  it("keeps every new table server-only (row-level security, no browser privilege, read-only for the server role)", () => {
    const tables = [...CODE.matchAll(/create\s+table\s+(\w+)\s*\(/gi)].map((m) => m[1]);
    expect(tables.sort()).toEqual(["competition_lifetime_flows", "competition_lifetime_freezes", "competition_lifetime_roster_claims", "lifetime_team_events", "lifetime_team_leaderships", "lifetime_team_legacy_sources", "lifetime_team_memberships", "lifetime_teams"]);
    for (const table of tables) {
      expect(CODE, `${table} rls`).toMatch(new RegExp(`alter\\s+table\\s+${table}\\s+enable\\s+row\\s+level\\s+security`, "i"));
      expect(CODE, `${table} revoke`).toMatch(new RegExp(`revoke\\s+all\\s+on\\s+table\\s+${table}\\s+from\\s+public,\\s*anon,\\s*authenticated,\\s*service_role`, "i"));
      expect(CODE, `${table} grant`).toMatch(new RegExp(`grant\\s+select\\s+on\\s+table\\s+${table}\\s+to\\s+service_role`, "i"));
      expect(CODE, `${table} must not grant writes`).not.toMatch(new RegExp(`grant\\s+(insert|update|delete|all)[^;]*\\son\\s+(table\\s+)?${table}\\b`, "i"));
    }
    // No privilege of ANY kind, on anything, is ever granted to a browser role or to public, with or without the word TABLE.
    expect(CODE).not.toMatch(/\bgrant\b[^;]*\bto\b[^;]*\b(anon|authenticated|public)\b/i);
    // The identity sequences are revoked from every role that could otherwise read or move them.
    const sequences = ["competition_lifetime_roster_claims_seq_seq", "lifetime_team_events_event_seq_seq", "lifetime_team_leaderships_seq_seq", "lifetime_team_memberships_seq_seq"];
    const revoked = CODE.match(/revoke\s+all\s+on\s+sequence\s+([\s\S]*?)\s+from\s+public,\s*anon,\s*authenticated,\s*service_role/i);
    expect(revoked, "the sequences are revoked").not.toBeNull();
    expect(revoked![1].split(",").map((n) => n.trim()).sort()).toEqual(sequences);
  });

  it("makes every function SECURITY DEFINER-or-internal with a locked search_path, executable by the server role only (operations) or by nobody (helpers and guards)", () => {
    const functions = [...CODE.matchAll(/create\s+function\s+(\w+)\s*\(([^)]*)\)([\s\S]*?)\$function\$;/gi)];
    expect(functions.length).toBeGreaterThan(25);
    for (const [, name, , body] of functions) {
      expect(body, `${name} search_path`).toMatch(/set\s+search_path\s*=\s*public,\s*pg_temp/i);
      expect(CODE, `${name} revoke from public`).toMatch(new RegExp(`revoke\\s+all\\s+on\\s+function\\s+${name}\\([^)]*\\)\\s+from\\s+public,\\s*anon,\\s*authenticated`, "i"));
      if (/_atomically$/.test(name)) {
        expect(body, `${name} security definer`).toMatch(/security\s+definer/i);
        expect(CODE, `${name} grant`).toMatch(new RegExp(`grant\\s+execute\\s+on\\s+function\\s+${name}\\([^)]*\\)\\s+to\\s+service_role`, "i"));
      } else {
        expect(CODE, `${name} internal: revoked from the server role too`).toMatch(new RegExp(`revoke\\s+all\\s+on\\s+function\\s+${name}\\([^)]*\\)\\s+from\\s+service_role`, "i"));
      }
    }
  });

  it("never compares a member id with a bare <> or != (the GATE-094 null-unsafe form), and uses no name an existing negative-surface contract watches for", () => {
    const bare = /\b(p_\w*gaming_member_id)\s*(<>|!=)\s*(v_\w+)\b|\b(v_\w+)\s*(<>|!=)\s*(p_\w*gaming_member_id)\b/i;
    expect(bare.test(CODE)).toBe(false);
    // The repository's wider form (competitionSchedulePublication): no `<>` or `!=` on either side of ANY member-id expression.
    expect(CODE).not.toMatch(/gaming_member_id\s*(<>|!=)/);
    expect(CODE).not.toMatch(/(<>|!=)\s*[a-z_.]*gaming_member_id/);
    const names = [...CODE.matchAll(/create\s+(?:or\s+replace\s+)?function\s+(\w+)/gi)].map((m) => m[1]);
    for (const name of names) {
      expect(name, name).not.toMatch(/(amend|override|replace_captain|captain|schedule|host|competition_draw|plan_amendment)/);
      expect(name, name).not.toMatch(/^competition_planning_/);
    }
    const tableNames = [...CODE.matchAll(/create\s+table\s+(\w+)/gi)].map((m) => m[1]);
    for (const name of tableNames) expect(name, name).not.toMatch(/(draw|pairing|schedule|fixture_slot|appeal|adjudicat|amend)/);
  });

  it("is never run by itself: the legacy backfill is only defined, granted and revoked here, never called", () => {
    const lines = MIGRATION.split("\n").filter((l) => /backfill_legacy_competition_teams_atomically/.test(l));
    expect(lines.length).toBeGreaterThan(0);
    for (const line of lines) expect(line.trim(), line).toMatch(/^(--|create\s+function|revoke|grant|comment)/i);
    expect(CODE).not.toMatch(/\bperform\s+backfill_legacy/i);
    expect(CODE).not.toMatch(/\bselect\s+(\*\s+from\s+)?backfill_legacy/i);
    // Whatever the spelling, the name occurs exactly three times in the executable text: its definition, its revoke and its grant. Any other occurrence is a call.
    expect([...CODE.matchAll(/backfill_legacy_competition_teams_atomically/g)]).toHaveLength(3);
  });

  it("has no default that makes the backfill run for everyone: the scope is a required argument", () => {
    expect(CODE).toMatch(/create\s+function\s+backfill_legacy_competition_teams_atomically\(p_competition_ids\s+uuid\[\]\)/i);
    expect(CODE).not.toMatch(/p_competition_ids\s+uuid\[\]\s+default/i);
    expect(CODE).toMatch(/if\s+p_competition_ids\s+is\s+null\s+or\s+cardinality\(p_competition_ids\)\s*=\s*0/i);
  });

  it("takes the person locks, the team locks and the competition lock in one fixed order, and documents it", () => {
    expect(MIGRATION).toMatch(/LOCK ORDER/i);
    expect(CODE).toMatch(/pg_advisory_xact_lock\(\s*7101\s*,/);
    expect(CODE).toMatch(/pg_advisory_xact_lock\(hashtext\('competition_scope:'/);
    expect(MIGRATION).toMatch(/persons?.*(then|→|->).*teams?.*(then|→|->).*competition/is);
  });

  // -----------------------------------------------------------------------------------------------------------------------------------------
  // The lock order (R2-F5): DERIVED from the code of every function, never from the prose of the header (a comment can say anything). A lock is classified by what the
  // statement takes — P: a person lock (lifetime_lock_people), T: a team row FOR UPDATE, C: the competition's scope advisory lock — and the classes must appear in
  // non-decreasing order within each function. Each rule below was proven by MUTATION on a scratch copy (see the return report): reordering the three that matter, dropping
  // the sub-captain from the lock list and reversing or mismatching a competition loop all fail one of these tests.
  // -----------------------------------------------------------------------------------------------------------------------------------------
  const FUNCTIONS = [...CODE.matchAll(/create\s+function\s+(\w+)\s*\([^)]*\)([\s\S]*?)\$function\$;/gi)].map((m) => {
    const whole = m[0];
    return { name: m[1], body: whole.slice(whole.indexOf("as $function$") + "as $function$".length) };
  });
  type LockClass = "P" | "T" | "C";
  const RANK: Record<LockClass, number> = { P: 0, T: 1, C: 2 };
  const locksOf = (body: string) => {
    const found: Array<{ cls: LockClass; at: number }> = [];
    for (const m of body.matchAll(/\blifetime_lock_people\(/g)) found.push({ cls: "P", at: m.index! });
    for (const m of body.matchAll(/from\s+lifetime_teams\s+\w+\s+where[^;]*\bfor\s+update\b/gi)) found.push({ cls: "T", at: m.index! });
    for (const m of body.matchAll(/pg_advisory_xact_lock\(\s*hashtext\('competition_scope:'/g)) found.push({ cls: "C", at: m.index! });
    return found.sort((a, b) => a.at - b.at);
  };
  /** The loops over a set of competitions: the header, and the body up to its `end loop`. */
  const competitionLoops = (body: string) => [...body.matchAll(/for\s+v_competition\s+in([\s\S]*?)\bloop\b([\s\S]*?)end\s+loop/gi)].map((m) => ({ header: m[1], inner: m[2], at: m.index! }));

  it("derives the lock order from the code: every function takes persons, then the team, then the competition", () => {
    expect(FUNCTIONS.length, "the functions this migration creates").toBeGreaterThan(25);
    expect(FUNCTIONS.filter((f) => locksOf(f.body).length > 0).length, "the functions that take locks").toBeGreaterThan(15);
    for (const f of FUNCTIONS) {
      const sequence = locksOf(f.body).map((l) => l.cls);
      for (let i = 1; i < sequence.length; i++) expect(RANK[sequence[i]], `${f.name} takes its locks in the order ${sequence.join(" ")}; it must be P, then T, then C`).toBeGreaterThanOrEqual(RANK[sequence[i - 1]]);
    }
  });

  it("names, in the person lock list of the leave, every person whose seat or membership the operation can activate (the actor, the subject, the successor and the PEEKED sub-captain)", () => {
    const leave = FUNCTIONS.find((f) => f.name === "end_lifetime_team_membership_atomically")!;
    // The sub-captain becomes the captain, and that activation locks THEIR person inside a guard while the team row is already held: if the list ever omits them, the
    // guard would take a person lock AFTER the team lock — against operations that take the person first, a cycle.
    expect(leave.body).toMatch(/lifetime_lock_people\(array\[\s*p_actor_gaming_member_id\s*,\s*p_subject_gaming_member_id\s*,\s*p_successor_gaming_member_id\s*,\s*v_peek\s*\]\)/);
    expect(leave.body).toMatch(/select\s+l\.gaming_member_id\s+into\s+v_peek\s+from\s+lifetime_team_leaderships[^;]*role\s*=\s*'SUB_CAPTAIN'/i);
    for (const name of ["propose_lifetime_team_membership_atomically", "decide_lifetime_team_membership_atomically", "offer_lifetime_team_leadership_atomically", "decide_lifetime_team_leadership_atomically", "end_lifetime_team_leadership_atomically"]) {
      expect(FUNCTIONS.find((f) => f.name === name)!.body, `${name} takes the person locks first`).toMatch(/lifetime_lock_people\(array\[/);
    }
  });

  it("locks the competitions of one operation in the order of the LOCK itself (the hash of its key), never in uuid order: two hashes can collide, a uuid order then does not prevent a cycle", () => {
    const locking = FUNCTIONS.flatMap((f) => competitionLoops(f.body).filter((l) => /pg_advisory_xact_lock/.test(l.inner)).map((l) => ({ name: f.name, ...l })));
    expect(locking.map((l) => l.name).sort(), "the operations that lock several competitions: a leave and a disband").toEqual(["disband_lifetime_team_atomically", "end_lifetime_team_membership_atomically"]);
    for (const loop of locking) {
      expect(loop.header, `${loop.name}: ordered by the hash of the lock key, then by id`).toMatch(/order\s+by\s+hashtext\('competition_scope:'\s*\|\|\s*\w+\.competition_id::text\)\s*,\s*\w+\.competition_id\s*$/i);
      expect(loop.header, `${loop.name}: ascending`).not.toMatch(/\bdesc\b/i);
      expect(loop.header, loop.name).not.toMatch(/order\s+by\s+1\b/i);
      expect(loop.inner, `${loop.name}: the lock inside the loop is the key the loop is ordered by`).toMatch(/pg_advisory_xact_lock\(\s*hashtext\('competition_scope:'\s*\|\|\s*v_competition::text\)\s*\)/);
      expect([...loop.inner.matchAll(/pg_advisory_xact_lock/g)], `${loop.name}: nothing else takes a competition lock inside the loop`).toHaveLength(1);
    }
    // A loop that takes no lock (the settlement of the leave) may only follow one that did.
    const leave = FUNCTIONS.find((f) => f.name === "end_lifetime_team_membership_atomically")!;
    const loops = competitionLoops(leave.body);
    expect(loops).toHaveLength(2);
    expect(loops[0].inner).toMatch(/pg_advisory_xact_lock/);
    expect(loops[1].inner, "the settlement takes no lock: every lock is already held").not.toMatch(/pg_advisory_xact_lock|for\s+update/i);
  });

  it("takes the moment of a leave only once every competition lock is held, and dates a departure at that moment, never before the freeze it was serialized behind", () => {
    const leave = FUNCTIONS.find((f) => f.name === "end_lifetime_team_membership_atomically")!;
    const lastLock = leave.body.lastIndexOf("perform pg_advisory_xact_lock(hashtext('competition_scope:'");
    expect(lastLock).toBeGreaterThan(-1);
    expect([...leave.body.matchAll(/v_now\s*:=\s*lifetime_clock\(\)/g)], "one moment for the whole act").toHaveLength(1);
    expect(leave.body.indexOf("v_now := lifetime_clock()"), "the moment is read after the competition locks").toBeGreaterThan(lastLock);
    expect(leave.body).not.toMatch(/\bv_stamp\b/);
    expect(leave.body).toMatch(/departed_at\s*=\s*greatest\(v_now,\s*v_frozen_at\)/);
    expect(leave.body).toMatch(/released_at\s*=\s*v_now/);
    // A disband locks and then dates inside its loop: the stamp follows the lock there too.
    const disband = FUNCTIONS.find((f) => f.name === "disband_lifetime_team_atomically")!;
    expect(disband.body.indexOf("v_stamp := lifetime_clock()"), "the disband's stamp is read after the lock of its competition").toBeGreaterThan(disband.body.indexOf("perform pg_advisory_xact_lock(hashtext('competition_scope:'"));
    expect(disband.body).toMatch(/departed_at\s*=\s*greatest\(v_stamp,\s*v_frozen_at\)/);
  });
});

// =============================================================================================================================================
describe("no public surface", () => {
  // The forbidden tokens are DERIVED from the migration (every function and table it creates, plus the backfill) and from the module's own names, so a new operation
  // can never be left out of the scan: a hand-written list drifted before (six of seventeen operations were missing).
  const OBJECTS = [...new Set([...CODE.matchAll(/create\s+(?:function|table)\s+(\w+)/gi)].map((m) => m[1]).concat("backfill_legacy"))];
  const TOKENS = new RegExp([...OBJECTS, "lifetimeTeams", "lifetimeEntries", "SupabaseLifetimeTeamsRepository", "LifetimeTeam", "lifetime-team", "lifetimeFlow", "entry_flow", "entryFlow"].join("|"));
  const walk = (dir: string): string[] => readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
  const MODULE_FILES = new Set(["lib/gaming/competitions/lifetimeTeams.ts", "lib/gaming/competitions/db/supabaseLifetimeTeamsRepository.ts"]);

  it("derives its tokens from every function and table the migration creates", () => {
    expect(OBJECTS.length).toBeGreaterThan(35);
    for (const name of ["withdraw_lifetime_competition_entry_atomically", "propose_lifetime_entry_roster_claims_atomically", "decide_lifetime_entry_roster_claim_atomically", "release_lifetime_entry_roster_claim_atomically", "freeze_lifetime_competition_entries_atomically", "backfill_legacy_competition_teams_atomically"]) {
      expect(TOKENS.test(name), name).toBe(true);
    }
  });

  it("is referenced by no route, page or public file (the foundation is reachable only from server code and tests)", () => {
    const surfaces = [...walk(path.join(ROOT, "app")), ...walk(path.join(ROOT, "public"))].filter((f) => /\.(ts|tsx|js|mjs|html|css|json)$/.test(f));
    expect(surfaces.length).toBeGreaterThan(50);
    const offenders = surfaces.filter((file) => TOKENS.test(readFileSync(file, "utf8"))).map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("is called by no other server code either: outside its own two files, nothing in lib names one of its objects (a new repository file with a direct rpc call would otherwise slip past)", () => {
    const libFiles = walk(path.join(ROOT, "lib")).filter((f) => /\.ts$/.test(f) && !MODULE_FILES.has(path.relative(ROOT, f)));
    expect(libFiles.length).toBeGreaterThan(100);
    const offenders = libFiles.filter((file) => TOKENS.test(readFileSync(file, "utf8"))).map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("is imported by nothing outside its own module and the tests", () => {
    const libFiles = walk(path.join(ROOT, "lib")).filter((f) => /\.ts$/.test(f));
    const importers = libFiles.filter((file) => /from\s+["'][^"']*(lifetimeTeams|supabaseLifetimeTeamsRepository)["']/.test(readFileSync(file, "utf8"))).map((f) => path.relative(ROOT, f));
    expect(importers).toEqual(["lib/gaming/competitions/db/supabaseLifetimeTeamsRepository.ts"]);
  });

  it("is registered in the explicit test lists: the unit test in npm test, the five contract files in the contract script", () => {
    const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;
    expect(scripts.test).toContain("__tests__/lifetimeTeams.test.ts");
    for (const file of ["lifetimeTeamsSupabase", "lifetimeEntriesSupabase", "lifetimeConcurrencySupabase", "lifetimeCompatibilitySupabase", "lifetimeReviewHardeningSupabase"]) {
      expect(scripts["test:contract"], file).toContain(`__tests__/${file}.contract.test.ts`);
      expect(scripts.test, `${file} must stay out of the in-memory suite`).not.toContain(file);
    }
  });
});
