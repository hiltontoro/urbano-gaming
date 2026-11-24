import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  LIFETIME_DATABASE_CODES, LIFETIME_TEAM_NAME_MAX, LIFETIME_TEAM_NAME_MIN, LifetimeTeamError, lifetimeErrorFromDatabase, normalizeLifetimeTeamName,
  parseClaimDecision, parseOfferDecision, parseOfferKind, requireUuid,
  createLifetimeTeam, decideLifetimeMembership, endLifetimeMembership, enterLifetimeTeam, listPendingLifetimeOffers, proposeRosterClaims, backfillLegacyTeams,
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

  it("CFM-012: the inbox read takes the verified member alone — a malformed identifier never reaches the store, and nothing else can be named", async () => {
    const { fn, store: s } = store();
    fn.mockResolvedValue([] as never);
    await expect(listPendingLifetimeOffers(s, "nope")).rejects.toMatchObject({ code: "INPUT_INVALID" });
    await expect(listPendingLifetimeOffers(s, undefined as never)).rejects.toMatchObject({ code: "INPUT_INVALID" });
    expect(fn).not.toHaveBeenCalled();
    expect(await listPendingLifetimeOffers(s, U1)).toEqual([]);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(U1);
    expect(listPendingLifetimeOffers.length, "exactly (store, member): no selector, filter or second identity").toBe(2);
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

  // -------------------------------------------------------------------------------------------------------------------------------------------
  // UG-CR-GATE-CFM-012 — the read side: the member's role on each team, and the member's own pending offers. Everything is derived from the verified member alone.
  // -------------------------------------------------------------------------------------------------------------------------------------------

  /** The membership read: ONE statement. The embedded team may arrive as an object or a one-element list, and carries the team's seats — history included. */
  function teamsClient(rows: unknown[]) {
    const calls: string[] = [];
    const chain: Record<string, unknown> = {};
    for (const method of ["select", "eq"]) chain[method] = (...args: unknown[]) => { calls.push(`${method}:${args.join(",")}`); return chain; };
    chain.order = async (...args: unknown[]) => { calls.push(`order:${args.join(",")}`); return { data: rows, error: null }; };
    const from = vi.fn(() => chain);
    return { calls, from, repo: new SupabaseLifetimeTeamsRepository("http://127.0.0.1:1", "service-key", { from, rpc: vi.fn() } as never) };
  }

  it("reads the teams a member belongs to — with the member's own role — in ONE statement (the embedded team may arrive as an object or a one-element list; a missing team is skipped)", async () => {
    const team = { public_code: "e".repeat(22), name: "Los Halcones", status: "ACTIVE", leaders: [] as unknown[] };
    const { repo, calls, from } = teamsClient([
      { lifetime_team_id: U1, joined_at: "T1", is_legacy: false, team },
      { lifetime_team_id: U2, joined_at: "T2", is_legacy: true, team: [{ ...team, name: "Old FC", status: "DISBANDED" }] },
      { lifetime_team_id: U3, joined_at: "T3", is_legacy: false, team: null },
    ]);
    const result = await repo.listActiveTeamsOfMember(U4);
    expect(result).toEqual([
      { lifetimeTeamId: U1, publicCode: team.public_code, name: "Los Halcones", status: "ACTIVE", joinedAt: "T1", isLegacy: false, role: "MEMBER" },
      { lifetimeTeamId: U2, publicCode: team.public_code, name: "Old FC", status: "DISBANDED", joinedAt: "T2", isLegacy: true, role: "MEMBER" },
    ]);
    expect(from, "one statement: the membership and the seat that decides the role come from the same snapshot").toHaveBeenCalledTimes(1);
    expect(from).toHaveBeenCalledWith("lifetime_team_memberships");
    expect(calls.find((c) => c.startsWith("select:"))).toMatch(/team:lifetime_teams\(public_code, name, status, leaders:lifetime_team_leaderships\(gaming_member_id, role, status, started_at, ended_at\)\)/);
    expect(calls).toEqual(expect.arrayContaining([`eq:gaming_member_id,${U4}`, "eq:status,ACTIVE", "order:seq"]));
    await expect(teamsClient([]).repo.listActiveTeamsOfMember("nope")).rejects.toMatchObject({ code: "INPUT_INVALID" });
  });

  describe("CFM-012: the member's role on a team comes from the member's ACTIVE seat on that team — and from nothing else", () => {
    const ME = U4, OTHER = U2;
    const BEGAN = "2026-11-20T10:00:00+00:00";
    const seat = (over: Record<string, unknown> = {}) => ({ gaming_member_id: ME, role: "CAPTAIN", status: "ACTIVE", started_at: BEGAN, ended_at: null, ...over });
    const rolesFor = async (seats: unknown) => {
      const { repo } = teamsClient([{ lifetime_team_id: U1, joined_at: "T1", is_legacy: false, team: { public_code: "e".repeat(22), name: "Los Halcones", status: "ACTIVE", leaders: seats } }]);
      return (await repo.listActiveTeamsOfMember(ME)).map((t) => t.role);
    };
    const CASES: Array<[string, unknown, string]> = [
      ["an active captain seat", [seat()], "CAPTAIN"],
      ["an active sub-captain seat", [seat({ role: "SUB_CAPTAIN" })], "SUB_CAPTAIN"],
      ["no seat at all (an ordinary member)", [], "MEMBER"],
      ["somebody else's captain seat", [seat({ gaming_member_id: OTHER })], "MEMBER"],
      ["somebody else's captain seat beside the member's own sub-captain seat", [seat({ gaming_member_id: OTHER }), seat({ role: "SUB_CAPTAIN" })], "SUB_CAPTAIN"],
      ["a PENDING seat offer (it grants nothing until it is accepted)", [seat({ role: "SUB_CAPTAIN", status: "PENDING", started_at: null })], "MEMBER"],
      ["an ENDED seat", [seat({ role: "SUB_CAPTAIN", status: "ENDED", ended_at: BEGAN })], "MEMBER"],
      ["an ENDED captain seat beside an ACTIVE sub-captain seat", [seat({ status: "ENDED", ended_at: BEGAN }), seat({ role: "SUB_CAPTAIN" })], "SUB_CAPTAIN"],
      ["a PENDING offer beside the member's ACTIVE captain seat", [seat({ role: "SUB_CAPTAIN", status: "PENDING", started_at: null }), seat()], "CAPTAIN"],
      ["both seats active for the same member: the captain's wins", [seat({ role: "SUB_CAPTAIN" }), seat()], "CAPTAIN"],
      ["a seat that is ACTIVE and also ended (contradictory)", [seat({ ended_at: BEGAN })], "MEMBER"],
      ["a seat that is ACTIVE and never started (contradictory)", [seat({ started_at: null })], "MEMBER"],
      ["an ACTIVE seat with no start or end fields at all (malformed)", [{ gaming_member_id: ME, role: "CAPTAIN", status: "ACTIVE" }], "MEMBER"],
      ["an unknown role", [seat({ role: "OWNER" })], "MEMBER"],
      ["a missing role", [seat({ role: undefined })], "MEMBER"],
      ["a lower-case status", [seat({ status: "active" })], "MEMBER"],
      ["a seat whose holder is missing", [seat({ gaming_member_id: undefined })], "MEMBER"],
      ["two different people holding the captaincy (contradictory): nobody is granted it", [seat(), seat({ gaming_member_id: OTHER })], "MEMBER"],
      ["two seat rows for the same captaincy (contradictory)", [seat(), seat()], "MEMBER"],
      ["two different people holding the sub-captain seat (contradictory)", [seat({ role: "SUB_CAPTAIN" }), seat({ role: "SUB_CAPTAIN", gaming_member_id: OTHER })], "MEMBER"],
      ["junk among the seats is ignored, the one valid seat counts", [null, 7, "CAPTAIN", [], seat({ role: "SUB_CAPTAIN" })], "SUB_CAPTAIN"],
      ["leaders that are not a list", { role: "CAPTAIN" }, "MEMBER"],
      ["leaders missing", undefined, "MEMBER"],
      ["leaders null", null, "MEMBER"],
    ];
    it.each(CASES)("%s → %s", async (_label, seats, expected) => {
      expect(await rolesFor(seats)).toEqual([expected]);
    });

    it("the same person's identifier in a different letter case is still the same person", async () => {
      expect(await rolesFor([seat({ gaming_member_id: ME.toUpperCase() })])).toEqual(["CAPTAIN"]);
    });

    it("a seat on ANOTHER team grants nothing here: each team is judged by its own seats, and the order of the member's teams is the membership order", async () => {
      const mk = (teamId: string, leaders: unknown[]) => ({ lifetime_team_id: teamId, joined_at: "T", is_legacy: false, team: { public_code: "e".repeat(22), name: teamId, status: "ACTIVE", leaders } });
      const { repo } = teamsClient([mk(U1, []), mk(U2, [seat()]), mk(U3, [seat({ role: "SUB_CAPTAIN" })]), mk("00000000-0000-4000-8000-0000000000aa", [seat({ gaming_member_id: OTHER })])]);
      const teams = await repo.listActiveTeamsOfMember(ME);
      expect(teams.map((t) => [t.lifetimeTeamId, t.role])).toEqual([[U1, "MEMBER"], [U2, "CAPTAIN"], [U3, "SUB_CAPTAIN"], ["00000000-0000-4000-8000-0000000000aa", "MEMBER"]]);
    });

    it("nothing but a membership lists a team: a leadership with no membership row lists nothing", async () => {
      const { repo } = teamsClient([]);
      expect(await repo.listActiveTeamsOfMember(ME)).toEqual([]);
    });

    it("exposes exactly the seven summary fields — no seat, leader or member detail from the embedded rows ever reaches the result", async () => {
      const { repo } = teamsClient([{ lifetime_team_id: U1, joined_at: "T1", is_legacy: false, auth_user_id: "secret", team: { public_code: "e".repeat(22), name: "Los Halcones", status: "ACTIVE", email: "x@example.com", leaders: [seat(), seat({ gaming_member_id: OTHER, role: "SUB_CAPTAIN" })] } }]);
      const [summary] = await repo.listActiveTeamsOfMember(ME);
      expect(Object.keys(summary)).toEqual(["lifetimeTeamId", "publicCode", "name", "status", "joinedAt", "isLegacy", "role"]);
      expect(JSON.stringify(summary)).not.toMatch(/secret|example\.com|SUB_CAPTAIN|started_at/);
    });
  });

  // -------------------------------------------------------------------------------------------------------------------------------------------
  describe("CFM-012: the member's pending offers — derived from the verified member, projected field by field, deterministic", () => {
    const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
    const ME = id(1), CAPTAIN = id(2), SUBCAP = id(3), PERSON = id(4), STRANGER = id(5), MEMBER = id(6), ORDINARY = id(7), OTHER_CAPTAIN = id(8), INVITEE = id(9), NOBODY = id(10);
    const TEAM = id(100), TEAM_2 = id(101);
    const BEGAN = "2026-11-20T10:00:00+00:00";
    const EXPIRES = "2026-12-01T10:00:00+00:00";
    const NAMES: Record<string, string> = { [ME]: "Marta", [CAPTAIN]: "Capi", [SUBCAP]: "Subi", [PERSON]: "Pedro", [STRANGER]: "Sara", [MEMBER]: "Memo", [ORDINARY]: "Ordi", [OTHER_CAPTAIN]: "Otto", [INVITEE]: "Ivan", [NOBODY]: "Nadie" };
    const seatOf = (member: string, role = "CAPTAIN", over: Record<string, unknown> = {}) => ({ gaming_member_id: member, role, status: "ACTIVE", started_at: BEGAN, ended_at: null, ...over });
    const teamNamed = (teamId: string) => (teamId === TEAM ? "Los Halcones" : "Los Gatos");
    const codeOf = (teamId: string) => `code${teamId.slice(-3)}`.padEnd(22, "x");
    const team = (teamId = TEAM, seats: unknown[] = teamId === TEAM ? [seatOf(CAPTAIN), seatOf(SUBCAP, "SUB_CAPTAIN")] : [seatOf(OTHER_CAPTAIN)], over: Record<string, unknown> = {}) =>
      ({ lifetime_team_id: teamId, public_code: codeOf(teamId), name: teamNamed(teamId), status: "ACTIVE", leaders: seats, ...over });
    const at = (n: number) => `2026-11-24T10:00:00.${String(n).padStart(6, "0")}+00:00`;
    const membership = (offer: number, over: Record<string, unknown> = {}) => ({
      lifetime_team_membership_id: id(offer), seq: offer, created_at: at(offer), expires_at: EXPIRES, status: "PENDING", lifetime_team_id: TEAM,
      gaming_member_id: ME, initiated_by_side: "TEAM", initiated_by_gaming_member_id: CAPTAIN, team: team(), ...over,
    });
    const seatOffer = (offer: number, over: Record<string, unknown> = {}) => ({
      lifetime_team_leadership_id: id(offer), seq: offer, created_at: at(offer), expires_at: EXPIRES, status: "PENDING", role: "SUB_CAPTAIN", lifetime_team_id: TEAM,
      gaming_member_id: MEMBER, offered_by_gaming_member_id: CAPTAIN, team: team(), ...over,
    });
    const view = (kind: "MEMBERSHIP" | "LEADERSHIP", offer: number, direction: "INCOMING" | "OUTGOING", counterparty: string | null, teamId = TEAM) => ({
      kind, offerId: id(offer), direction,
      team: { lifetimeTeamId: teamId, publicCode: codeOf(teamId), name: teamNamed(teamId) },
      counterparty: counterparty === null ? null : { gamingMemberId: counterparty, displayName: NAMES[counterparty] },
      expiresAt: EXPIRES,
    });
    const memberRows = () => Object.entries(NAMES).map(([gaming_member_id, display_name]) => ({ gaming_member_id, display_name }));

    interface Data { seats?: unknown[]; memberships?: unknown[]; offers?: unknown[]; members?: unknown[]; fail?: "seats" | "memberships" | "requests" | "offers" | "members" }
    /** A client that answers EVERY statement with the whole dataset — whatever it was asked: the repository, not the filter, must decide what a member may see. */
    function inboxRepo(data: Data) {
      const statements: Array<{ table: string; steps: string[] }> = [];
      const from = (table: string) => {
        const statement = { table, steps: [] as string[] };
        statements.push(statement);
        const chain: Record<string, unknown> = {};
        for (const method of ["select", "eq", "or", "in", "order"]) chain[method] = (...args: unknown[]) => { statement.steps.push(`${method}:${args.map(String).join(",")}`); return chain; };
        chain.then = (resolve: (value: unknown) => unknown, reject: (reason: unknown) => unknown) => {
          const has = (prefix: string) => statement.steps.some((step) => step.startsWith(prefix));
          const which = table === "gaming_members" ? "members" : table === "lifetime_team_leaderships" ? (has("eq:status,ACTIVE") ? "seats" : "offers") : has("in:lifetime_team_id") ? "requests" : "memberships";
          const rows = { members: data.members ?? memberRows(), seats: data.seats ?? [], memberships: data.memberships ?? [], requests: data.memberships ?? [], offers: data.offers ?? [] }[which];
          const answer = which === data.fail ? { data: null, error: { code: "XX000", message: 'relation "lifetime_team_memberships" violates secret detail' } } : { data: rows, error: null };
          return Promise.resolve(answer).then(resolve, reject);
        };
        return chain;
      };
      return { statements, repo: new SupabaseLifetimeTeamsRepository("http://127.0.0.1:1", "service-key", { from, rpc: vi.fn() } as never) };
    }
    const everyone = () => ({
      seats: [{ lifetime_team_id: TEAM, ...seatOf(CAPTAIN) }, { lifetime_team_id: TEAM, ...seatOf(SUBCAP, "SUB_CAPTAIN") }, { lifetime_team_id: TEAM_2, ...seatOf(OTHER_CAPTAIN) }],
      memberships: [
        membership(201),                                                                                                        // the captain invites ME
        membership(202, { gaming_member_id: PERSON, initiated_by_side: "PERSON", initiated_by_gaming_member_id: PERSON }),      // PERSON asks to join
        membership(203, { gaming_member_id: INVITEE }),                                                                         // the captain invites INVITEE
        membership(204, { gaming_member_id: ORDINARY, initiated_by_gaming_member_id: OTHER_CAPTAIN, lifetime_team_id: TEAM_2, team: team(TEAM_2) }), // ANOTHER team invites ORDINARY
      ],
      offers: [seatOffer(301)],                                                                                                // the captain offers MEMBER the sub-captain seat
    });
    const inboxOf = async (caller: string, data: Data = everyone()) => inboxRepo(data).repo.listPendingOffersOfMember(caller);

    it("who sees what: the invitee, the inviter, the other leader, the requester, the offered member — and nobody else", async () => {
      expect(await inboxOf(ME), "the invited member").toEqual([view("MEMBERSHIP", 201, "INCOMING", CAPTAIN)]);
      expect(await inboxOf(CAPTAIN), "the captain: their own invitations and the seat offer they made, and the join request to their team").toEqual([
        view("MEMBERSHIP", 201, "OUTGOING", ME), view("MEMBERSHIP", 202, "INCOMING", PERSON), view("MEMBERSHIP", 203, "OUTGOING", INVITEE), view("LEADERSHIP", 301, "OUTGOING", MEMBER),
      ]);
      expect(await inboxOf(SUBCAP), "the sub-captain: the join request only — never an invitation another leader made").toEqual([view("MEMBERSHIP", 202, "INCOMING", PERSON)]);
      expect(await inboxOf(PERSON), "the requester: an OUTGOING request with no counterparty person").toEqual([view("MEMBERSHIP", 202, "OUTGOING", null)]);
      expect(await inboxOf(INVITEE), "the other invitee").toEqual([view("MEMBERSHIP", 203, "INCOMING", CAPTAIN)]);
      expect(await inboxOf(MEMBER), "the member offered the seat").toEqual([view("LEADERSHIP", 301, "INCOMING", CAPTAIN)]);
      expect(await inboxOf(ORDINARY), "an ordinary member sees their own invitation from ANOTHER team, and nothing of this team").toEqual([view("MEMBERSHIP", 204, "INCOMING", OTHER_CAPTAIN, TEAM_2)]);
      expect(await inboxOf(OTHER_CAPTAIN), "another team's captain sees only their own team's").toEqual([view("MEMBERSHIP", 204, "OUTGOING", ORDINARY, TEAM_2)]);
      for (const nobody of [STRANGER, NOBODY, id(77)]) expect(await inboxOf(nobody), "an unrelated member sees nothing").toEqual([]);
    });

    it("a join request is shown only to a CURRENT captain or sub-captain: a pending or ended seat, an ordinary member and a seat on another team see nothing", async () => {
      const request = membership(202, { gaming_member_id: PERSON, initiated_by_side: "PERSON", initiated_by_gaming_member_id: PERSON });
      const withSeats = (seats: unknown[]) => ({ memberships: [{ ...request, team: team(TEAM, seats) }], seats: [] as unknown[] });
      const caller = SUBCAP;
      const mine = (over: Record<string, unknown> = {}) => ({ lifetime_team_id: TEAM, ...seatOf(caller, "SUB_CAPTAIN", over) });
      const cases: Array<[string, unknown[], boolean]> = [
        ["an active sub-captain seat", [seatOf(CAPTAIN), seatOf(caller, "SUB_CAPTAIN")], true],
        ["a seat that ended", [seatOf(CAPTAIN), seatOf(caller, "SUB_CAPTAIN", { status: "ENDED", ended_at: BEGAN })], false],
        ["a seat that is only offered", [seatOf(CAPTAIN), seatOf(caller, "SUB_CAPTAIN", { status: "PENDING", started_at: null })], false],
        ["no seat on this team", [seatOf(CAPTAIN)], false],
        ["a seat that is ACTIVE and ended (contradictory)", [seatOf(CAPTAIN), seatOf(caller, "SUB_CAPTAIN", { ended_at: BEGAN })], false],
      ];
      for (const [label, seats, sees] of cases) {
        const data = { ...withSeats(seats), seats: sees ? [mine()] : [mine({ status: "ENDED", ended_at: BEGAN })] };
        expect(await inboxOf(caller, data), label).toEqual(sees ? [view("MEMBERSHIP", 202, "INCOMING", PERSON)] : []);
      }
    });

    it("an invitation stands only while the leader who made it still leads: otherwise neither side sees it", async () => {
      const gone = membership(201, { team: team(TEAM, [seatOf(SUBCAP, "SUB_CAPTAIN")]) });            // the captain who invited ME holds no ACTIVE seat any more
      const ended = membership(201, { team: team(TEAM, [seatOf(CAPTAIN, "CAPTAIN", { status: "ENDED", ended_at: BEGAN })]) });
      for (const row of [gone, ended]) {
        expect(await inboxOf(ME, { memberships: [row] }), "the invitee").toEqual([]);
        expect(await inboxOf(CAPTAIN, { memberships: [row], seats: [] }), "the former leader").toEqual([]);
      }
    });

    it("a seat offer is OUTGOING only for the team's active captain who made it — a sub-captain or a former captain sees nothing", async () => {
      const notCaptain = seatOffer(301, { team: team(TEAM, [seatOf(CAPTAIN, "SUB_CAPTAIN")]) });
      expect(await inboxOf(CAPTAIN, { offers: [notCaptain] })).toEqual([]);
      expect(await inboxOf(MEMBER, { offers: [notCaptain] }), "the offered member still sees what was offered to them").toEqual([view("LEADERSHIP", 301, "INCOMING", CAPTAIN)]);
      expect(await inboxOf(SUBCAP, { offers: [seatOffer(301)] }), "another leader").toEqual([]);
    });

    it("only a PENDING offer on an ACTIVE team is ever shown — an accepted, declined, withdrawn, ended or lapsed-and-ended record never is, whatever the server returned", async () => {
      const rows = {
        memberships: [membership(201, { status: "ACTIVE" }), membership(202, { status: "ENDED" }), membership(203, { status: "pending" }), membership(204, { status: undefined }), membership(205, { team: team(TEAM, undefined, { status: "DISBANDED" }) }), membership(206)],
        offers: [seatOffer(301, { status: "ACTIVE", gaming_member_id: ME }), seatOffer(302, { status: "ENDED", gaming_member_id: ME }), seatOffer(303, { role: "CAPTAIN", gaming_member_id: ME }), seatOffer(304, { gaming_member_id: ME })],
      };
      expect((await inboxOf(ME, rows)).map((o) => [o.kind, o.offerId])).toEqual([["MEMBERSHIP", id(206)], ["LEADERSHIP", id(304)]]);
    });

    it("a PAST expiry is still shown, and nothing is invented from it: there is no 'actionable' flag — the decision operations remain the authority", async () => {
      const lapsed = membership(201, { expires_at: "2020-01-01T00:00:00+00:00" });
      const [offer] = await inboxOf(ME, { memberships: [lapsed] });
      expect(offer.expiresAt).toBe("2020-01-01T00:00:00+00:00");
      expect(Object.keys(offer).sort()).toEqual(["counterparty", "direction", "expiresAt", "kind", "offerId", "team"]);
    });

    it("exposes exactly the contract's fields: no email, phone, auth id or any other profile or database field, from the offers, their teams or their counterparties", async () => {
      const pii = { email: "someone@example.com", phone: "+5062222333", auth_user_id: id(900), initiated_by_side_extra: "x", ended_at: "T", decided_by_gaming_member_id: id(901) };
      const data: Data = everyone();
      data.memberships = (data.memberships ?? []).map((m) => ({ ...(m as object), ...pii, team: { ...(m as { team: object }).team, ...pii } }));
      data.offers = (data.offers ?? []).map((o) => ({ ...(o as object), ...pii, team: { ...(o as { team: object }).team, ...pii } }));
      const members = memberRows().map((r) => ({ ...r, ...pii, created_at: "T" }));
      const all = [...(await inboxOf(CAPTAIN, { ...data, members })), ...(await inboxOf(ME, { ...data, members }))];
      expect(all.length).toBeGreaterThan(4);
      for (const offer of all) {
        expect(Object.keys(offer)).toEqual(["kind", "offerId", "direction", "team", "counterparty", "expiresAt"]);
        expect(Object.keys(offer.team)).toEqual(["lifetimeTeamId", "publicCode", "name"]);
        if (offer.counterparty) expect(Object.keys(offer.counterparty)).toEqual(["gamingMemberId", "displayName"]);
      }
      expect(JSON.stringify(all)).not.toMatch(/someone@example\.com|\+5062222333|auth_user_id|decided_by|created_at|initiated_by/);
      expect(JSON.stringify(all)).not.toContain(id(900));
      expect(JSON.stringify(all)).not.toContain(id(901));
    });

    it("every statement is derived from the verified member alone: the member's own identifier in each filter, the member's led teams for the requests, and only the counterparties the offers name — never another selector", async () => {
      const { repo, statements } = inboxRepo(everyone());
      await repo.listPendingOffersOfMember(CAPTAIN);
      const by = (table: string, prefix: string) => statements.filter((s) => s.table === table && s.steps.some((step) => step.startsWith(prefix)));
      expect(statements.map((s) => s.table).sort()).toEqual(["gaming_members", "lifetime_team_leaderships", "lifetime_team_leaderships", "lifetime_team_memberships", "lifetime_team_memberships"]);
      const [seats] = by("lifetime_team_leaderships", "eq:status,ACTIVE");
      expect(seats.steps).toEqual(expect.arrayContaining([`eq:gaming_member_id,${CAPTAIN}`, "eq:status,ACTIVE"]));
      const [party] = by("lifetime_team_memberships", "or:");
      expect(party.steps).toEqual(expect.arrayContaining(["eq:status,PENDING", `or:gaming_member_id.eq.${CAPTAIN},initiated_by_gaming_member_id.eq.${CAPTAIN}`, "order:seq"]));
      const [requests] = by("lifetime_team_memberships", "in:lifetime_team_id");
      expect(requests.steps, "the join requests of the teams the member currently leads").toEqual(expect.arrayContaining(["eq:status,PENDING", "eq:initiated_by_side,PERSON", `in:lifetime_team_id,${TEAM}`]));
      const [offers] = by("lifetime_team_leaderships", "eq:status,PENDING");
      expect(offers.steps).toEqual(expect.arrayContaining(["eq:status,PENDING", `or:gaming_member_id.eq.${CAPTAIN},offered_by_gaming_member_id.eq.${CAPTAIN}`, "order:seq"]));
      const [names] = by("gaming_members", "in:gaming_member_id");
      const named = names.steps.find((step) => step.startsWith("in:gaming_member_id,"))!.slice("in:gaming_member_id,".length).split(",").sort();
      expect(named, "only the people the visible offers involve").toEqual([ME, PERSON, INVITEE, MEMBER].sort());
      expect(names.steps.find((step) => step.startsWith("select:"))).toBe("select:gaming_member_id, display_name");
      // no statement names a member the caller did not already stand in a relation to, and none selects a column the contract does not return
      for (const statement of statements) for (const step of statement.steps.filter((s) => s.startsWith("select:"))) expect(step, statement.table).not.toMatch(/\*|auth_user_id|email|phone/);
      for (const statement of statements.filter((s) => s.table !== "gaming_members")) {
        for (const step of statement.steps.filter((s) => /^(eq:gaming_member_id|or:)/.test(s))) expect([...step.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g)].every((m) => m[0] === CAPTAIN), step).toBe(true);
      }
    });

    it("a member who leads nothing runs no join-request statement; a member who leads runs exactly one", async () => {
      const none = inboxRepo(everyone());
      await none.repo.listPendingOffersOfMember(ME);
      expect(none.statements.filter((s) => s.steps.some((step) => step.startsWith("in:lifetime_team_id")))).toHaveLength(0);
      const led = inboxRepo(everyone());
      await led.repo.listPendingOffersOfMember(SUBCAP);
      expect(led.statements.filter((s) => s.steps.some((step) => step.startsWith("in:lifetime_team_id")))).toHaveLength(1);
    });

    it("a record that is malformed or contradictory is dropped — never shown, never guessed — while a good record beside it still is", async () => {
      const bad = [
        membership(210, { lifetime_team_membership_id: "not-a-uuid" }), membership(211, { initiated_by_side: "CLUB" }), membership(212, { initiated_by_side: undefined }),
        membership(213, { gaming_member_id: undefined }), membership(214, { initiated_by_gaming_member_id: null }),
        membership(215, { initiated_by_gaming_member_id: ME }),                                                              // an invitation the invitee made to themselves
        membership(216, { initiated_by_side: "PERSON", gaming_member_id: ME, initiated_by_gaming_member_id: CAPTAIN }),     // a request the person did not make
        membership(217, { team: null }), membership(218, { team: team(id(555)) }),                                          // the team of another row
        membership(219, { team: team(TEAM, undefined, { name: "" }) }), membership(220, { team: team(TEAM, undefined, { name: 7 }) }), membership(221, { team: team(TEAM, undefined, { public_code: "" }) }),
        membership(222, { team: team(TEAM, undefined, { public_code: undefined }) }),
        membership(223, { expires_at: null }), membership(224, { expires_at: "soon" }), membership(225, { created_at: "yesterday" }), membership(226, { created_at: null }),
        membership(227, { seq: "first" }), membership(228, { seq: null }), membership(229, { seq: 1.5 }),
        null, 7, "offer", [], { lifetime_team_membership_id: id(230) },
      ];
      const badOffers = [seatOffer(310, { lifetime_team_leadership_id: undefined }), seatOffer(311, { gaming_member_id: ME, offered_by_gaming_member_id: ME }), seatOffer(312, { gaming_member_id: ME, role: "OWNER" }),
        seatOffer(313, { gaming_member_id: ME, team: null }), seatOffer(314, { gaming_member_id: ME, expires_at: "later" }), seatOffer(315, { gaming_member_id: ME, seq: "x" })];
      const good = membership(299);
      expect((await inboxOf(ME, { memberships: [...bad, good], offers: badOffers })).map((o) => o.offerId)).toEqual([id(299)]);
    });

    it("a counterparty whose display name is missing, blank or not text drops that offer — the rest stay; an offer with no counterparty person needs none", async () => {
      const members = (name: unknown) => memberRows().map((r) => (r.gaming_member_id === CAPTAIN ? { ...r, display_name: name } : r));
      for (const name of [undefined, null, "", "   ", 7]) expect(await inboxOf(ME, { memberships: [membership(201), membership(202, { gaming_member_id: ME, initiated_by_side: "PERSON", initiated_by_gaming_member_id: ME })], members: members(name) }), String(name))
        .toEqual([view("MEMBERSHIP", 202, "OUTGOING", null)]);
      expect(await inboxOf(ME, { memberships: [membership(201)], members: memberRows().filter((r) => r.gaming_member_id !== CAPTAIN) }), "a counterparty the lookup did not return").toEqual([]);
    });

    describe("the order is deterministic: creation time across both kinds, then each table's creation sequence, then the kind, then the identifier", () => {
      const mine = (rows: unknown[], offers: unknown[]) => ({ memberships: rows, offers });
      it("creation time decides first — even against a larger sequence — across membership and leadership offers", async () => {
        const rows = mine([
          membership(205, { seq: 90, created_at: "2026-11-24T10:00:00.000400+00:00" }),
          membership(206, { seq: 100, created_at: "2026-11-24T09:59:59+00:00" }),                    // earliest, though its sequence is the largest; no fractional seconds at all
        ], [seatOffer(301, { gaming_member_id: ME, seq: 7, created_at: "2026-11-24T10:00:00.000500+00:00" })]);
        expect((await inboxOf(ME, rows)).map((o) => o.offerId)).toEqual([id(206), id(205), id(301)]);
      });

      it("the same instant written with a different offset or fractional width is the same instant: then the kind, then the sequence, then the identifier break the tie", async () => {
        const rows = mine([
          membership(210, { seq: 5, created_at: "2026-11-24T05:00:00.5-05:00" }),                   // 10:00:00.500000Z
          membership(211, { seq: 4, created_at: "2026-11-24T10:00:00.500000+00:00" }),              // the same instant, a smaller sequence
          membership(212, { seq: 4, created_at: "2026-11-24T10:00:00.5Z" }),                        // the same instant and sequence: the identifier decides
        ], [seatOffer(300, { gaming_member_id: ME, seq: 1, created_at: "2026-11-24T10:00:00.500000+00:00" })]);
        expect((await inboxOf(ME, rows)).map((o) => o.offerId)).toEqual([id(211), id(212), id(210), id(300)]);
      });

      it("a microsecond decides, where a millisecond clock could not", async () => {
        const rows = mine([membership(220, { seq: 2, created_at: "2026-11-24T10:00:00.123457+00:00" }), membership(221, { seq: 1, created_at: "2026-11-24T10:00:00.123456+00:00" })], []);
        expect((await inboxOf(ME, rows)).map((o) => o.offerId)).toEqual([id(221), id(220)]);
      });

      it("whatever order the server returns the rows in, the answer is the same", async () => {
        const rows = [membership(231), membership(232), membership(233), membership(234)];
        const offers = [seatOffer(331, { gaming_member_id: ME }), seatOffer(332, { gaming_member_id: ME })];
        const expected = (await inboxOf(ME, mine(rows, offers))).map((o) => o.offerId);
        expect(expected).toEqual([id(231), id(232), id(233), id(234), id(331), id(332)]);
        for (const [a, b] of [[[...rows].reverse(), [...offers].reverse()], [[rows[2], rows[0], rows[3], rows[1]], [offers[1], offers[0]]]] as const) {
          expect((await inboxOf(ME, mine([...a], [...b]))).map((o) => o.offerId)).toEqual(expected);
        }
      });

      it("a request listed by both statements (as a party and as a leader) appears once", async () => {
        const request = membership(240, { gaming_member_id: PERSON, initiated_by_side: "PERSON", initiated_by_gaming_member_id: PERSON });
        const out = await inboxOf(CAPTAIN, { memberships: [request, request, request], seats: [{ lifetime_team_id: TEAM, ...seatOf(CAPTAIN) }] });
        expect(out.map((o) => o.offerId)).toEqual([id(240)]);
      });
    });

    it("a failure of ANY statement is a bounded error that carries none of the database's words — and a malformed identifier fails before any statement is made", async () => {
      for (const fail of ["seats", "memberships", "requests", "offers", "members"] as const) {
        const { repo } = inboxRepo({ ...everyone(), fail });
        const thrown = await repo.listPendingOffersOfMember(SUBCAP).catch((e) => e);
        expect(thrown, fail).toBeInstanceOf(LifetimeTeamError);
        expect(thrown.code, fail).toBe("UNAVAILABLE");
        expect(thrown.message, fail).not.toMatch(/relation|violates|secret|lifetime_/);
      }
      const { repo, statements } = inboxRepo(everyone());
      await expect(repo.listPendingOffersOfMember("nope")).rejects.toMatchObject({ code: "INPUT_INVALID" });
      await expect(repo.listPendingOffersOfMember(undefined as never)).rejects.toMatchObject({ code: "INPUT_INVALID" });
      expect(statements).toHaveLength(0);
    });

    it("an answer that is not a list of rows is dropped, not guessed at (a null table answer is an empty inbox, not a crash)", async () => {
      const { repo } = inboxRepo({ ...everyone(), memberships: null as never, offers: {} as never, seats: "x" as never });
      expect(await repo.listPendingOffersOfMember(ME)).toEqual([]);
    });
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
  // UG-CR-GATE-CFM-007: the ONE server module allowed to stand between the foundation and a route. It is exempt from the two scans below by its exact path (never by
  // directory or pattern), and it is held to a guard of its own — derived from the foundation — in the last block of this section.
  const HTTP_ADAPTER = "lib/gaming/competitions/lifetimeHttp.ts";
  // UG-CR-GATE-CFM-010: the SECOND server module allowed to stand between the foundation and a route, for membership and leadership. It is exempt by its exact path too —
  // never by directory or pattern — and it is held to a guard of its own, in the last block but one of this section.
  const MEMBERSHIP_HTTP_ADAPTER = "lib/gaming/competitions/lifetimeMembershipHttp.ts";
  const HTTP_ADAPTERS = [HTTP_ADAPTER, MEMBERSHIP_HTTP_ADAPTER];
  // The routes of the Competitions API that import a module by its exact specifier (what a route may reach is decided by what it imports, not by where it lives).
  const competitionRoutes = () => walk(path.join(ROOT, "app", "api", "gaming", "competitions")).filter((f) => /[\\/]route\.ts$/.test(f)).map((f) => path.relative(ROOT, f).split(path.sep).join("/")).sort();
  const importsOf = (file: string) => [...read(file).matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
  const routesImporting = (specifier: string) => competitionRoutes().filter((f) => importsOf(f).includes(specifier));

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

  it("is called by no other server code either: outside its own two files and the two bounded HTTP adapters, nothing in lib names one of its objects (a new repository file with a direct rpc call would otherwise slip past)", () => {
    const libFiles = walk(path.join(ROOT, "lib")).filter((f) => /\.ts$/.test(f) && !MODULE_FILES.has(path.relative(ROOT, f)) && !HTTP_ADAPTERS.includes(path.relative(ROOT, f)));
    expect(libFiles.length).toBeGreaterThan(100);
    const offenders = libFiles.filter((file) => TOKENS.test(readFileSync(file, "utf8"))).map((f) => path.relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("is imported by nothing outside its own module, the two bounded HTTP adapters and the tests", () => {
    const libFiles = walk(path.join(ROOT, "lib")).filter((f) => /\.ts$/.test(f));
    const importers = libFiles.filter((file) => /from\s+["'][^"']*(lifetimeTeams|supabaseLifetimeTeamsRepository)["']/.test(readFileSync(file, "utf8"))).map((f) => path.relative(ROOT, f)).sort();
    expect(importers).toEqual(["lib/gaming/competitions/db/supabaseLifetimeTeamsRepository.ts", HTTP_ADAPTER, MEMBERSHIP_HTTP_ADAPTER]);
  });

  // UG-CR-GATE-CFM-007: the exception above is exactly ONE file, and that file is held to the same standard from the other side. What it may name is DERIVED from the
  // foundation itself (never hand-listed), so an operation added to the foundation later is forbidden to the adapter from the day it exists.
  describe("the one bounded HTTP adapter exposes create, the member's own active list and disband — and nothing else", () => {
    const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const adapterCode = () => stripComments(read(HTTP_ADAPTER));
    const namesIn = (pattern: RegExp, text: string) => [...text.matchAll(pattern)].map((m) => m[1]);
    const unix = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");

    const FOUNDATION = read("lib/gaming/competitions/lifetimeTeams.ts");
    const storeStart = FOUNDATION.indexOf("export interface LifetimeTeamsStore");
    const STORE_METHODS = namesIn(/^ {2}(\w+)\(/gm, FOUNDATION.slice(storeStart, FOUNDATION.indexOf("// ---", storeStart)));
    const FOUNDATION_NAMES = [
      ...STORE_METHODS,
      ...namesIn(/^export async function (\w+)\(/gm, FOUNDATION), // the thin operations
      ...namesIn(/^export function (\w+)\(/gm, FOUNDATION), // the parsers and the database-text translator
      ...namesIn(/^export const (\w+)/gm, FOUNDATION),
      ...namesIn(/^export (?:interface|type) (\w+)/gm, FOUNDATION).filter((n) => n !== "LifetimeTeamsStore"),
    ];
    // What the adapter may use: the two operations it calls, the member's own list (a store method), the two parsers, the typed refusal and the records those return.
    const ALLOWED = ["createLifetimeTeam", "disbandLifetimeTeam", "listActiveTeamsOfMember", "normalizeLifetimeTeamName", "requireUuid", "LifetimeProblem", "LifetimeTeamCreated", "LifetimeTeamDisbanded", "MemberTeamSummary", "LIFETIME_TEAM_NAME_MIN", "LIFETIME_TEAM_NAME_MAX"];
    const FORBIDDEN = [...new Set(FOUNDATION_NAMES)].filter((n) => !ALLOWED.includes(n));
    const named = (code: string, candidates: string[]) => candidates.filter((n) => new RegExp(`\\b${n}\\b`).test(code));

    it("derives what it forbids from the foundation: every operation, record, parser and lookup is found, and every allowance names something that exists", () => {
      expect(STORE_METHODS).toContain("listActiveTeamsOfMember");
      expect(STORE_METHODS.length).toBeGreaterThan(20);
      expect(FORBIDDEN.length).toBeGreaterThan(50);
      for (const name of ["proposeMembership", "decideEntry", "freezeEntries", "backfillLegacyTeams", "getLifetimeTeam", "getEntry", "proposeRosterClaims", "offerLeadership", "decideLifetimeEntry", "lifetimeErrorFromDatabase", "LifetimeTeamView", "EntryDecided",
        "listPendingOffersOfMember", "listPendingLifetimeOffers", "PendingOfferView", "TeamRole"]) {
        expect(FORBIDDEN, name).toContain(name);
      }
      for (const name of ALLOWED) expect(FOUNDATION_NAMES, `${name} must exist in the foundation`).toContain(name);
    });

    it("names none of the foundation's other operations, records, parsers or lookups (its code, comments removed)", () => {
      expect(named(adapterCode(), FORBIDDEN)).toEqual([]);
    });

    const CAPABILITIES: Array<[string, RegExp]> = [
      ["membership offers", /Membership|Offer/], ["leadership", /Leadership/], ["competition entry", /Entry|Entries|enterTeam|enterLifetimeTeam/], ["roster claims", /Roster|Claim/],
      ["organizer decisions", /decideEntry|decideLifetimeEntry|EntryDecision|EntryDecided/], ["freeze", /[Ff]reez|Frozen/], ["backfill", /[Bb]ackfill/],
      ["unrestricted team lookup", /^get(?:LifetimeTeam|Entry)$|LifetimeTeamView|LifetimeEntryView/],
    ];
    it.each(CAPABILITIES)("references no %s: the foundation's own names for it are found, and none appears in the adapter", (_capability, pattern) => {
      const theirs = FORBIDDEN.filter((n) => pattern.test(n));
      expect(theirs.length, "the scan must find the foundation's names for this capability, or it proves nothing").toBeGreaterThan(0);
      expect(named(adapterCode(), theirs)).toEqual([]);
    });

    it("names no database object and makes no database call of its own (it goes through the domain operations and nothing else)", () => {
      const databaseNames = [...new Set([CODE, DECISIONS_CODE].flatMap((sql) => namesIn(/create\s+(?:or\s+replace\s+)?(?:function|table)\s+(\w+)/gi, sql)))];
      expect(databaseNames.length).toBeGreaterThan(35);
      expect(named(adapterCode(), databaseNames)).toEqual([]);
      expect(adapterCode()).not.toMatch(/\.rpc\s*\(|\.from\s*\(|createClient|@supabase\/supabase-js/);
    });

    it("exports exactly its three handlers and no helper", () => {
      const code = adapterCode();
      expect(namesIn(/^export\s+(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+(\w+)/gm, code).sort()).toEqual(["handleCreateTeam", "handleDisbandTeam", "handleListMyTeams"]);
      expect(code).not.toMatch(/^export\s*(?:\{|\*|default)/m);
    });

    it("imports only what its three operations need, one statement per module", () => {
      const code = adapterCode();
      const imports: Record<string, string[]> = {};
      for (const m of code.matchAll(/^import\s+\{([^}]*)\}\s+from\s+["']([^"']+)["'];?$/gm)) {
        imports[m[2]] = m[1].split(",").map((s) => s.replace(/^\s*type\s+/, "").trim()).filter(Boolean).sort();
      }
      expect(imports).toEqual({
        "next/server": ["NextResponse"],
        "./httpAuth": ["getSupabaseCredentials", "requireCompetitionsSchemaReady", "requireGamingMember"],
        "./db/supabaseLifetimeTeamsRepository": ["SupabaseLifetimeTeamsRepository"],
        "./lifetimeTeams": ["LifetimeProblem", "LifetimeTeamError", "createLifetimeTeam", "disbandLifetimeTeam", "normalizeLifetimeTeamName", "requireUuid"],
      });
      expect([...code.matchAll(/^import\b/gm)], "no other form of import (default, namespace, side-effect, type-only statement)").toHaveLength(4);
      expect(code).not.toMatch(/\bimport\s*\(|\brequire\s*\(/);
    });

    it("is reached only by its two routes, which import nothing but the adapter and name no foundation symbol", () => {
      const routes = routesImporting("@/lib/gaming/competitions/lifetimeHttp");
      expect(routes).toEqual(["app/api/gaming/competitions/lifetime-teams/[lifetimeTeamId]/disband/route.ts", "app/api/gaming/competitions/lifetime-teams/route.ts"]);
      for (const route of routes) {
        const code = stripComments(read(route));
        expect([...code.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]), route).toEqual(["@/lib/gaming/competitions/lifetimeHttp"]);
        expect(code, route).not.toMatch(/\bimport\s*\(|\brequire\s*\(/);
        expect(TOKENS.test(read(route)), `${route} must not name a foundation symbol`).toBe(false);
      }
      const surfaces = ["app", "lib", "public"].flatMap((dir) => walk(path.join(ROOT, dir))).filter((f) => /\.(ts|tsx|js|mjs|html)$/.test(f));
      const mentioning = surfaces.map(unix).filter((f) => f !== HTTP_ADAPTER && /lifetimeHttp/.test(read(f))).sort();
      expect(mentioning, "nothing but the two routes reaches the adapter").toEqual(routes);
    });
  });

  // UG-CR-GATE-CFM-010: the second exception is exactly ONE more file, held to the same standard. What it may name is DERIVED from the foundation (never hand-listed): the
  // seven operations it exists for, the two decision parsers, the identifier parser and the typed refusal. Everything else the foundation offers is forbidden to it.
  describe("the bounded membership and leadership HTTP adapter exposes seven operations — and nothing else", () => {
    const stripComments = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
    const adapterCode = () => stripComments(read(MEMBERSHIP_HTTP_ADAPTER));
    const namesIn = (pattern: RegExp, text: string) => [...text.matchAll(pattern)].map((m) => m[1]);
    const unix = (file: string) => path.relative(ROOT, file).split(path.sep).join("/");

    const FOUNDATION = read("lib/gaming/competitions/lifetimeTeams.ts");
    const storeStart = FOUNDATION.indexOf("export interface LifetimeTeamsStore");
    const STORE_METHODS = namesIn(/^ {2}(\w+)\(/gm, FOUNDATION.slice(storeStart, FOUNDATION.indexOf("// ---", storeStart)));
    const FOUNDATION_NAMES = [
      ...STORE_METHODS,
      ...namesIn(/^export async function (\w+)\(/gm, FOUNDATION),
      ...namesIn(/^export function (\w+)\(/gm, FOUNDATION),
      ...namesIn(/^export const (\w+)/gm, FOUNDATION),
      ...namesIn(/^export (?:interface|type) (\w+)/gm, FOUNDATION).filter((n) => n !== "LifetimeTeamsStore"),
    ];
    const OPERATIONS = ["proposeLifetimeMembership", "decideLifetimeMembership", "withdrawLifetimeOffer", "endLifetimeMembership", "offerLifetimeLeadership", "decideLifetimeLeadership", "endLifetimeLeadership"];
    // CFM-012: the one read the adapter owns — the member's own pending offers — is called through its domain function, never through the store.
    const READS = ["listPendingLifetimeOffers"];
    const ALLOWED = [...OPERATIONS, ...READS, "parseOfferDecision", "parseOfferKind", "requireUuid", "LifetimeProblem"];
    const FORBIDDEN = [...new Set(FOUNDATION_NAMES)].filter((n) => !ALLOWED.includes(n));
    const named = (code: string, candidates: string[]) => candidates.filter((n) => new RegExp(`\\b${n}\\b`).test(code));

    it("derives what it forbids from the foundation: every other operation, record, parser and lookup is found, and every allowance names something that exists", () => {
      expect(STORE_METHODS).toContain("proposeMembership");
      expect(STORE_METHODS.length).toBeGreaterThan(20);
      expect(FORBIDDEN.length).toBeGreaterThan(50);
      for (const name of ["createLifetimeTeam", "disbandLifetimeTeam", "listActiveTeamsOfMember", "normalizeLifetimeTeamName", "decideEntry", "freezeEntries", "backfillLegacyTeams", "getLifetimeTeam", "getEntry", "proposeRosterClaims",
        "decideLifetimeEntry", "lifetimeErrorFromDatabase", "LifetimeTeamView", "EntryDecided", "proposeMembership", "MembershipOffer", "listPendingOffersOfMember", "PendingOfferView", "OfferDirection", "TeamRole"]) {
        expect(FORBIDDEN, name).toContain(name);
      }
      for (const name of ALLOWED) expect(FOUNDATION_NAMES, `${name} must exist in the foundation`).toContain(name);
    });

    it("names none of the foundation's other operations, records, parsers or lookups — and never the store directly (its code, comments removed)", () => {
      expect(named(adapterCode(), FORBIDDEN)).toEqual([]);
    });

    const CAPABILITIES: Array<[string, RegExp]> = [
      ["team creation, disbanding or listing", /^(?:createLifetimeTeam|disbandLifetimeTeam|listActiveTeamsOfMember|LifetimeTeamCreated|LifetimeTeamDisbanded|MemberTeamSummary|normalizeLifetimeTeamName|LIFETIME_TEAM_NAME_MIN|LIFETIME_TEAM_NAME_MAX)$/],
      ["competition entry", /Entry|Entries|enterTeam|enterLifetimeTeam/], ["roster claims", /Roster|Claim/],
      ["organizer decisions", /decideEntry|decideLifetimeEntry|EntryDecision|EntryDecided/], ["freeze", /[Ff]reez|Frozen/], ["backfill", /[Bb]ackfill/],
      ["unrestricted team lookup", /^get(?:LifetimeTeam|Entry)$|LifetimeTeamView|LifetimeEntryView/],
    ];
    it.each(CAPABILITIES)("references no %s: the foundation's own names for it are found, and none appears in the adapter", (_capability, pattern) => {
      const theirs = FORBIDDEN.filter((n) => pattern.test(n));
      expect(theirs.length, "the scan must find the foundation's names for this capability, or it proves nothing").toBeGreaterThan(0);
      expect(named(adapterCode(), theirs)).toEqual([]);
    });

    it("names no database object and makes no database call of its own (it goes through the domain operations and nothing else)", () => {
      const databaseNames = [...new Set([CODE, DECISIONS_CODE].flatMap((sql) => namesIn(/create\s+(?:or\s+replace\s+)?(?:function|table)\s+(\w+)/gi, sql)))];
      expect(databaseNames.length).toBeGreaterThan(35);
      expect(named(adapterCode(), databaseNames)).toEqual([]);
      expect(adapterCode()).not.toMatch(/\.rpc\s*\(|\.from\s*\(|createClient|@supabase\/supabase-js/);
    });

    it("calls each of the seven operations and its one read, and no other", () => {
      const code = adapterCode();
      for (const operation of [...OPERATIONS, ...READS]) expect(code, operation).toMatch(new RegExp(`\\b${operation}\\(`));
    });

    it("exports exactly its eight handlers (seven operations and the member's own offer inbox) and no helper", () => {
      const code = adapterCode();
      expect(namesIn(/^export\s+(?:async\s+)?(?:function|const|let|var|class|interface|type|enum)\s+(\w+)/gm, code).sort()).toEqual([
        "handleDecideLeadership", "handleDecideMembership", "handleEndLeadership", "handleEndMembership", "handleListMyOffers", "handleOfferLeadership", "handleProposeMembership", "handleWithdrawOffer",
      ]);
      expect(code).not.toMatch(/^export\s*(?:\{|\*|default)/m);
    });

    it("imports only what its operations and its one read need, one statement per module", () => {
      const code = adapterCode();
      const imports: Record<string, string[]> = {};
      for (const m of code.matchAll(/^import\s+\{([^}]*)\}\s+from\s+["']([^"']+)["'];?$/gm)) {
        imports[m[2]] = m[1].split(",").map((s) => s.replace(/^\s*type\s+/, "").trim()).filter(Boolean).sort();
      }
      expect(imports).toEqual({
        "next/server": ["NextResponse"],
        "./httpAuth": ["getSupabaseCredentials", "requireCompetitionsSchemaReady", "requireGamingMember"],
        "./db/supabaseLifetimeTeamsRepository": ["SupabaseLifetimeTeamsRepository"],
        "./lifetimeTeams": [...ALLOWED.filter((n) => n !== "requireUuid"), "LifetimeTeamError", "requireUuid"].sort(),
      });
      expect([...code.matchAll(/^import\b/gm)], "no other form of import (default, namespace, side-effect, type-only statement)").toHaveLength(4);
      expect(code).not.toMatch(/\bimport\s*\(|\brequire\s*\(/);
    });

    it("is reached only by its eight routes, which import nothing but the adapter and name no foundation symbol — and no route of the lifetime family is outside the two adapters", () => {
      const SPECIFIER = "@/lib/gaming/competitions/lifetimeMembershipHttp";
      const routes = routesImporting(SPECIFIER);
      expect(routes).toEqual([
        "app/api/gaming/competitions/lifetime-leaderships/[leadershipId]/decision/route.ts",
        "app/api/gaming/competitions/lifetime-memberships/[membershipId]/decision/route.ts",
        "app/api/gaming/competitions/lifetime-offers/[offerId]/withdraw/route.ts",
        "app/api/gaming/competitions/lifetime-offers/route.ts",
        "app/api/gaming/competitions/lifetime-teams/[lifetimeTeamId]/leadership-offers/route.ts",
        "app/api/gaming/competitions/lifetime-teams/[lifetimeTeamId]/leadership/end/route.ts",
        "app/api/gaming/competitions/lifetime-teams/[lifetimeTeamId]/memberships/end/route.ts",
        "app/api/gaming/competitions/lifetime-teams/[lifetimeTeamId]/memberships/route.ts",
      ]);
      for (const route of routes) {
        const code = stripComments(read(route));
        expect(importsOf(route), route).toEqual([SPECIFIER]);
        expect(code, route).not.toMatch(/\bimport\s*\(|\brequire\s*\(/);
        expect(TOKENS.test(read(route)), `${route} must not name a foundation symbol`).toBe(false);
      }
      const surfaces = ["app", "lib", "public"].flatMap((dir) => walk(path.join(ROOT, dir))).filter((f) => /\.(ts|tsx|js|mjs|html)$/.test(f));
      const mentioning = surfaces.map(unix).filter((f) => f !== MEMBERSHIP_HTTP_ADAPTER && /lifetimeMembershipHttp/.test(read(f))).sort();
      expect(mentioning, "nothing but the eight routes reaches the adapter").toEqual(routes);
      // No broad exemption and no unbounded sibling: every route of the lifetime family imports exactly one of the two adapters and nothing else.
      const family = competitionRoutes().filter((f) => /\/lifetime-[a-z]+\//.test(f));
      expect(family).toHaveLength(10);
      for (const route of family) expect([["@/lib/gaming/competitions/lifetimeHttp"], [SPECIFIER]], route).toContainEqual(importsOf(route));
    });

    it("is registered in the explicit test lists: the route test in npm test, the contract file in the contract script only", () => {
      const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;
      expect(scripts.test).toContain("__tests__/lifetimeMembershipHttp.test.ts");
      expect(scripts["test:contract"]).toContain("__tests__/lifetimeMembershipHttpSupabase.contract.test.ts");
      expect(scripts.test, "the contract file must stay out of the in-memory suite").not.toContain("lifetimeMembershipHttpSupabase");
    });
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
