import { createHash, randomBytes, randomUUID } from "node:crypto";

import type { Client } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import { loadEnv } from "vite";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";

import { registerForCompetition } from "../lib/gaming/competitions/registerForCompetition";
import { createHarness, type LifetimeTestCompetition, type Person } from "./helpers/lifetimeContract";

/**
 * UG-CR-GATE-CFM-004 — organizer decisions on lifetime-team entries, removal before the freeze, and the corrected freeze, against a real (disposable,
 * loopback-only) Postgres. Written BEFORE the migration. On the CFM-001 schema the operation tests fail because the operation does not exist, the undecided-entries
 * freeze test fails because that freeze counts entries nobody decided, and the two tests marked "pre-existing control" PASS (they pin V1 behaviour that must not change).
 *
 *   [1] approval        PENDING_ORGANIZER_APPROVAL -> ACCEPTED, by the competition's own organizer only, never touching a roster claim
 *   [2] rejection       PENDING -> REJECTED with a bounded reason code; the open proposals and accepted places are released and their records preserved
 *   [3] removal         ACCEPTED -> REJECTED before the freeze, while registration is open, with a reason
 *   [4] authority       nobody but the active, non-revoked organizer of THIS competition decides an entry
 *   [5] withdrawal      a team's own withdrawal stays distinguishable from an organizer's decision (status category, reason, audit evidence)
 *   [6] the freeze      counts only ACCEPTED entries and the accepted places of those entries; refuses while an entry is pending
 *   [7] V1              an ACCEPTED lifetime entry is still nothing V1 can consume (join requests, memberships, the V1 freeze)
 */

// The shared contract-test guard (UG-CR-GATE-079) runs before anything is constructed: no target that is not loopback is ever touched.
const supabaseUrl = loadEnv("development", process.cwd(), "").SUPABASE_URL;
requireLocalSupabase(supabaseUrl);
// Every scenario builds real people and teams through the real operations, and the freeze scenarios wait for a registration deadline to pass.
vi.setConfig({ testTimeout: 90_000 });

const h = createHarness("ed");
const { one, rpc, refused, settle, rawQuery, rawTransaction, violation } = h;

afterAll(() => h.cleanup(), 300000);

const id = (p: Person) => p.gamingMemberId;
const REASON = "INELIGIBLE_TEAM";
const REASONS = ["INELIGIBLE_TEAM", "INCOMPLETE_ENTRY", "DUPLICATE_OR_MISTAKEN_ENTRY", "COMPETITION_CAPACITY", "RULE_VIOLATION", "OTHER_ORGANIZER_DECISION"];

const decideArgs = (c: { competitionId: string }, entryId: string, who: Person, decision: string, reason: string | null = null, note: string | null = null) =>
  ({ p_competition_id: c.competitionId, p_competition_team_id: entryId, p_organizer_gaming_member_id: id(who), p_decision: decision, p_reason_code: reason, p_note: note });
const freezeArgs = (c: LifetimeTestCompetition) => ({ p_competition_id: c.competitionId, p_organizer_gaming_member_id: id(c.organizer) });
const proposeArgs = (entryId: string, actor: Person, ids: string[]) => ({ p_competition_team_id: entryId, p_actor_gaming_member_id: id(actor), p_gaming_member_ids: ids });
const withdrawArgs = (entryId: string, actor: Person) => ({ p_competition_team_id: entryId, p_actor_gaming_member_id: id(actor) });

const entryRow = async (entryId: string) => (await rawQuery("select * from competition_teams where competition_team_id = $1", [entryId]))[0];
const decisionsOf = (entryId: string) => rawQuery("select * from competition_lifetime_entry_decisions where competition_team_id = $1 order by decision_seq", [entryId]);
const eventsOf = (teamId: string) => rawQuery("select event_type, actor_gaming_member_id, related_id, details from lifetime_team_events where lifetime_team_id = $1 order by event_seq", [teamId]);
const claimsOf = (entryId: string) => rawQuery(
  "select competition_lifetime_roster_claim_id id, gaming_member_id, status, release_reason, released_by_gaming_member_id, accepted_at, released_at from competition_lifetime_roster_claims where competition_team_id = $1 order by seq", [entryId]);
const claimsDigest = async (entryId: string) => createHash("sha256").update(JSON.stringify(await rawQuery("select * from competition_lifetime_roster_claims where competition_team_id = $1 order by seq", [entryId]))).digest("hex");
const countOf = async (sql: string, params: unknown[]) => (await rawQuery(sql, params))[0].n as number;

/** A competition with the lifetime flow, one team (captain, sub-captain and members) and its PENDING entry. */
async function scenario(label: string, size = 5) {
  const competition = await h.setUpCompetition(label);
  const team = await h.buildTeam(`${label}T`, size);
  const entry = await h.enterTeam(competition, team);
  return { competition, team, entry };
}

/** `count` teams entered in one competition, each with its full roster accepted (every entry is still PENDING). */
async function entered(label: string, count: number, size = 5) {
  const competition = await h.setUpCompetition(label);
  const teams = [];
  for (let i = 0; i < count; i++) {
    const team = await h.buildTeam(`${label}${i}`, size);
    const entry = await h.enterTeam(competition, team);
    await h.rosterUp(entry.entryId, team.captain, competition, team.everyone);
    teams.push({ team, entry });
  }
  return { competition, teams };
}

/** Runs `fn` inside a transaction that is ALWAYS rolled back, in which the competition's hosting access has been REVOKED (the real helper reads the real table). */
async function withRevokedHost<T>(competition: LifetimeTestCompetition, fn: (db: Client) => Promise<T>): Promise<T> {
  return rawTransaction(async (db) => {
    const member = id(competition.organizer);
    const application = (await db.query(
      `insert into competition_host_applications (gaming_member_id, state, venue_name, city_area, playing_fields, venue_description, expected_window, expected_team_count,
         confirm_all_adults, confirm_independent_scorekeepers, confirm_pilot_exclusions, decided_by_gaming_member_id, decided_at)
       values ($1, 'APPROVED', 'Fictional venue', 'Fictional area', 2, 'A fictional venue that exists only inside a rolled-back test transaction.', 'a weekend', 4, true, true, true, $1, now())
       returning host_application_id`, [member])).rows[0].host_application_id;
    await db.query(
      `insert into competition_host_capabilities (host_application_id, gaming_member_id, state, competition_id, granted_by_gaming_member_id, consumed_at, revoked_at, revoked_by_gaming_member_id, revoke_reason)
       values ($1, $2, 'REVOKED', $3, $2, now(), now(), $2, 'Revoked inside a rolled-back test transaction.')`, [application, member, competition.competitionId]);
    return fn(db);
  });
}
/** The message of the refusal a statement raises inside a transaction (null when it succeeds). */
async function refusalOf(db: Client, sql: string, params: unknown[]): Promise<string | null> {
  try {
    await db.query(sql, params);
    return null;
  } catch (err) {
    return (err as Error).message;
  }
}

// =============================================================================================================================================
describe("[1] the organizer approves an entry", () => {
  it("moves PENDING_ORGANIZER_APPROVAL to ACCEPTED, and records who, when, what changed and an audit event", async () => {
    const { competition, team, entry } = await scenario("Approve");
    const row = await one("decide_lifetime_competition_entry_atomically", decideArgs(competition, entry.entryId, competition.organizer, "APPROVE"));
    expect(row).toMatchObject({ competition_team_id: entry.entryId, status: "ACCEPTED", decision: "APPROVE", released_claims: 0 });
    const entryAfter = await entryRow(entry.entryId);
    expect(entryAfter).toMatchObject({ status: "ACCEPTED", decided_by_gaming_member_id: id(competition.organizer), rejection_reason: null });
    expect(entryAfter.decided_at).not.toBeNull();
    const [decision, ...others] = await decisionsOf(entry.entryId);
    expect(others).toHaveLength(0);
    expect(decision).toMatchObject({
      decision: "APPROVED", decided_by_role: "ORGANIZER", decided_by_gaming_member_id: id(competition.organizer), reason_code: null, note: null,
      previous_status: "PENDING_ORGANIZER_APPROVAL", new_status: "ACCEPTED", released_claims: 0, competition_id: competition.competitionId, lifetime_team_id: team.teamId });
    expect(new Date(decision.decided_at).getTime()).toBe(new Date(entryAfter.decided_at).getTime());
    const approved = (await eventsOf(team.teamId)).filter((e) => e.event_type === "ENTRY_APPROVED");
    expect(approved).toHaveLength(1);
    expect(approved[0]).toMatchObject({ actor_gaming_member_id: id(competition.organizer), related_id: entry.entryId, details: { competition_id: competition.competitionId, decision_id: decision.decision_id } });
  });

  it("does not touch a single roster claim: proposals stay proposals, accepted places stay accepted, nobody is accepted on anyone's behalf", async () => {
    const { competition, team, entry } = await scenario("ApproveClaims", 6);
    const [a, b, c, d] = [team.captain, team.members[0], team.members[1], team.members[2]];
    await h.rosterUp(entry.entryId, team.captain, competition, [a, b]); // two accepted places
    await rpc("propose_lifetime_entry_roster_claims_atomically", proposeArgs(entry.entryId, team.captain, [id(c), id(d)])); // two proposals nobody has answered
    const before = await claimsDigest(entry.entryId);
    await h.decideEntry(competition, entry.entryId, "APPROVE");
    expect(await claimsDigest(entry.entryId), "approval changes no byte of any claim").toBe(before);
    expect((await claimsOf(entry.entryId)).map((r) => r.status)).toEqual(["ACCEPTED", "ACCEPTED", "PROPOSED", "PROPOSED"]);
  });

  it("waives nothing: the adult attestation, the team membership, one team per person and the roster maximum are still enforced on an accepted entry", async () => {
    const { competition, team, entry } = await scenario("ApproveWaives", 6);
    await h.decideEntry(competition, entry.entryId, "APPROVE");
    const [member, stranger] = [team.members[0], (await h.newPeople(1, "Waive"))[0]];
    // a person who registered WITHOUT the adult self-attestation cannot take a place, and neither can someone who is not on the team at all
    const [proposed] = await rpc("propose_lifetime_entry_roster_claims_atomically", proposeArgs(entry.entryId, team.captain, [id(member)]));
    const accept = (who: Person) => ({ p_competition_lifetime_roster_claim_id: proposed.competition_lifetime_roster_claim_id, p_actor_gaming_member_id: id(who), p_decision: "ACCEPT" });
    await refused("decide_lifetime_entry_roster_claim_atomically", accept(member), "COMPETITION_REGISTRATION_REQUIRED");
    await registerForCompetition(h.compRepo, competition.competitionId, id(member), false);
    await refused("decide_lifetime_entry_roster_claim_atomically", accept(member), "LIFETIME_ADULT_ATTESTATION_REQUIRED");
    await refused("propose_lifetime_entry_roster_claims_atomically", proposeArgs(entry.entryId, team.captain, [id(stranger)]), "LIFETIME_CLAIM_SUBJECT_NOT_MEMBER");
    expect((await claimsOf(entry.entryId))[0].status, "the proposal was never accepted on anyone's behalf").toBe("PROPOSED");
    // one team per person: a person on two accepted entries can hold a place on only one of them
    const other = await h.buildTeam("ApproveWaivesOther", 5);
    const otherEntry = await h.enterTeam(competition, other);
    await h.decideEntry(competition, otherEntry.entryId, "APPROVE");
    const [both] = await h.newPeople(1, "Both");
    await h.addMember(team.teamId, team.captain, both);
    await h.addMember(other.teamId, other.captain, both);
    await h.register(competition, both);
    const [onA] = await rpc("propose_lifetime_entry_roster_claims_atomically", proposeArgs(entry.entryId, team.captain, [id(both)]));
    const [onB] = await rpc("propose_lifetime_entry_roster_claims_atomically", proposeArgs(otherEntry.entryId, other.captain, [id(both)]));
    await one("decide_lifetime_entry_roster_claim_atomically", { p_competition_lifetime_roster_claim_id: onA.competition_lifetime_roster_claim_id, p_actor_gaming_member_id: id(both), p_decision: "ACCEPT" });
    await refused("decide_lifetime_entry_roster_claim_atomically", { p_competition_lifetime_roster_claim_id: onB.competition_lifetime_roster_claim_id, p_actor_gaming_member_id: id(both), p_decision: "ACCEPT" }, "LIFETIME_PERSON_ALREADY_CLAIMED");
  });

  it("keeps the roster maximum of the plan on an accepted entry", async () => {
    const competition = await h.setUpCompetition("ApproveMax", { minimum: 5, maximum: 5 });
    const team = await h.buildTeam("ApproveMaxT", 6);
    const entry = await h.enterTeam(competition, team);
    await h.decideEntry(competition, entry.entryId, "APPROVE");
    await h.rosterUp(entry.entryId, team.captain, competition, team.everyone.slice(0, 5));
    // CFM-001 enforces the maximum where a place is TAKEN, not where it is proposed: a proposal is not a place, so a sixth can be proposed, but cannot accept past the plan's maximum.
    const sixth = team.everyone[5];
    const [proposal] = await rpc("propose_lifetime_entry_roster_claims_atomically", proposeArgs(entry.entryId, team.captain, [id(sixth)]));
    await h.register(competition, sixth);
    await refused("decide_lifetime_entry_roster_claim_atomically", { p_competition_lifetime_roster_claim_id: proposal.competition_lifetime_roster_claim_id, p_actor_gaming_member_id: id(sixth), p_decision: "ACCEPT" }, "LIFETIME_ROSTER_FULL");
    expect((await claimsOf(entry.entryId)).filter((c) => c.status === "ACCEPTED"), "an approval never raised the plan's maximum").toHaveLength(5);
  });

  it("is refused, with its own code, for an entry that was already decided or withdrawn", async () => {
    const { competition, entry } = await scenario("ApproveTwice");
    await h.decideEntry(competition, entry.entryId, "APPROVE");
    await refused("decide_lifetime_competition_entry_atomically", decideArgs(competition, entry.entryId, competition.organizer, "APPROVE"), "LIFETIME_ENTRY_NOT_PENDING");
    await refused("decide_lifetime_competition_entry_atomically", decideArgs(competition, entry.entryId, competition.organizer, "REJECT", REASON), "LIFETIME_ENTRY_NOT_PENDING");
    expect(await decisionsOf(entry.entryId), "a refusal records nothing").toHaveLength(1);
    const second = await scenario("ApproveWithdrawn");
    await one("withdraw_lifetime_competition_entry_atomically", withdrawArgs(second.entry.entryId, second.team.captain));
    await refused("decide_lifetime_competition_entry_atomically", decideArgs(second.competition, second.entry.entryId, second.competition.organizer, "APPROVE"), "LIFETIME_ENTRY_NOT_PENDING");
  });

  it("is refused once the intake deadline has passed (registration is no longer open), but the organizer can still REJECT what is pending", async () => {
    const { competition, entry } = await scenario("ApproveLate");
    await h.passDeadline(competition.competitionId);
    await refused("decide_lifetime_competition_entry_atomically", decideArgs(competition, entry.entryId, competition.organizer, "APPROVE"), "TEAM_REGISTRATION_NOT_OPEN");
    expect((await entryRow(entry.entryId)).status).toBe("PENDING_ORGANIZER_APPROVAL");
    // Rejecting after the deadline is what lets the organizer clear a leftover pending entry so the freeze can proceed (otherwise it would block the freeze for ever).
    const rejected = await one("decide_lifetime_competition_entry_atomically", decideArgs(competition, entry.entryId, competition.organizer, "REJECT", "INCOMPLETE_ENTRY"));
    expect(rejected).toMatchObject({ status: "REJECTED", decision: "REJECT" });
  });

  it("is refused when the captain the entry names no longer leads the team (the snapshot no longer represents an active captain)", async () => {
    const { competition, team, entry } = await scenario("ApproveCaptain");
    await one("end_lifetime_team_membership_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: id(team.captain), p_subject_gaming_member_id: id(team.captain), p_successor_gaming_member_id: id(team.subCaptain!) });
    await refused("decide_lifetime_competition_entry_atomically", decideArgs(competition, entry.entryId, competition.organizer, "APPROVE"), "LIFETIME_ENTRY_CAPTAIN_CHANGED");
    expect((await entryRow(entry.entryId)).status).toBe("PENDING_ORGANIZER_APPROVAL");
    // The organizer can still reject it, and the team can enter again with its current captain.
    await h.decideEntry(competition, entry.entryId, "REJECT", { reason: "INCOMPLETE_ENTRY" });
    const again = await h.enterTeam(competition, team, team.subCaptain!);
    await h.decideEntry(competition, again.entryId, "APPROVE");
  });

  it("only decides an entry of THIS competition, and only a lifetime entry, in a competition that uses the lifetime flow and is not cancelled", async () => {
    const { competition, entry } = await scenario("Scope");
    const elsewhere = await h.setUpCompetition("ScopeElsewhere");
    await refused("decide_lifetime_competition_entry_atomically", decideArgs(elsewhere, entry.entryId, elsewhere.organizer, "APPROVE"), "LIFETIME_ENTRY_NOT_FOUND"); // another competition's entry
    await refused("decide_lifetime_competition_entry_atomically", decideArgs(competition, "00000000-0000-4000-8000-0000000000dd", competition.organizer, "APPROVE"), "LIFETIME_ENTRY_NOT_FOUND");
    const v1 = await h.setUpCompetition("ScopeV1", { lifetimeFlow: false });
    const [captain] = await h.newPeople(1, "ScopeV1Captain");
    const v1Team = await one("add_competition_team_atomically", { p_competition_id: v1.competitionId, p_organizer_gaming_member_id: id(v1.organizer), p_name: h.uniqueName("V1"), p_captain_gaming_member_id: id(captain), p_public_code: randomBytes(16).toString("base64url") });
    await refused("decide_lifetime_competition_entry_atomically", decideArgs(v1, v1Team.competition_team_id, v1.organizer, "APPROVE"), "LIFETIME_FLOW_NOT_ENABLED");
    const cancelled = await scenario("ScopeCancelled");
    await rawQuery("update competitions set state = 'CANCELLED_WITHOUT_CHAMPION' where competition_id = $1", [cancelled.competition.competitionId]);
    await refused("decide_lifetime_competition_entry_atomically", decideArgs(cancelled.competition, cancelled.entry.entryId, cancelled.competition.organizer, "APPROVE"), "COMPETITION_CANCELLED");
  });

  it("normalizes the administrative note (trimmed, inner whitespace collapsed) and bounds it at 280 characters, counted in characters, not bytes", async () => {
    const competition = await h.setUpCompetition("Note");
    const decide = async (note: string) => {
      const entered = await h.enterTeam(competition, await h.buildTeam("NoteT", 3));
      await h.decideEntry(competition, entered.entryId, "REJECT", { reason: REASON, note });
      return (await decisionsOf(entered.entryId))[0].note as string | null;
    };
    expect(await decide("  Two   spaces\tand a\nnewline  ")).toBe("Two spaces and a newline");
    expect(await decide("x".repeat(280))).toBe("x".repeat(280));
    expect(await decide("é".repeat(280)), "280 two-byte characters fit: the bound is in characters").toBe("é".repeat(280));
    expect((await decide("😀".repeat(280))), "an emoji is one character").toBe("😀".repeat(280));
    const overflow = await h.enterTeam(competition, await h.buildTeam("NoteOver", 3));
    await refused("decide_lifetime_competition_entry_atomically", decideArgs(competition, overflow.entryId, competition.organizer, "REJECT", REASON, `${"x".repeat(280)} y`), "LIFETIME_NOTE_INVALID");
    expect((await entryRow(overflow.entryId)).status).toBe("PENDING_ORGANIZER_APPROVAL");
  });

  it("refuses an unknown decision, a reason or note that does not belong to the decision, and an oversized or control-character note — each with its own code", async () => {
    const { competition, entry } = await scenario("Input");
    const call = (decision: string, reason: string | null, note: string | null) => decideArgs(competition, entry.entryId, competition.organizer, decision, reason, note);
    await refused("decide_lifetime_competition_entry_atomically", call("MAYBE", null, null), "LIFETIME_DECISION_INVALID");
    await refused("decide_lifetime_competition_entry_atomically", call("APPROVE", REASON, null), "LIFETIME_REASON_INVALID"); // an approval carries no reason
    await refused("decide_lifetime_competition_entry_atomically", call("APPROVE", null, "fine"), "LIFETIME_NOTE_INVALID");
    await refused("decide_lifetime_competition_entry_atomically", call("REJECT", null, null), "LIFETIME_REASON_INVALID");
    await refused("decide_lifetime_competition_entry_atomically", call("REJECT", "BECAUSE_I_SAY_SO", null), "LIFETIME_REASON_INVALID");
    await refused("decide_lifetime_competition_entry_atomically", call("REJECT", REASON, "x".repeat(281)), "LIFETIME_NOTE_INVALID");
    await refused("decide_lifetime_competition_entry_atomically", call("REJECT", REASON, "bad\u0007note"), "LIFETIME_NOTE_INVALID");
    await refused("decide_lifetime_competition_entry_atomically", call("REJECT", REASON, "   "), "LIFETIME_NOTE_INVALID");
    expect((await entryRow(entry.entryId)).status, "every refusal left the entry alone").toBe("PENDING_ORGANIZER_APPROVAL");
    expect(await decisionsOf(entry.entryId)).toHaveLength(0);
  });
});

// =============================================================================================================================================
describe("[2] the organizer rejects an entry", () => {
  it("moves PENDING to REJECTED with a reason code and an optional note, and releases the open proposals and the accepted places WITHOUT deleting any of them", async () => {
    const { competition, team, entry } = await scenario("Reject", 6);
    const [a, b, c] = [team.captain, team.members[0], team.members[1]];
    await h.rosterUp(entry.entryId, team.captain, competition, [a, b]);
    await rpc("propose_lifetime_entry_roster_claims_atomically", proposeArgs(entry.entryId, team.captain, [id(c)]));
    const before = await claimsOf(entry.entryId);
    const row = await one("decide_lifetime_competition_entry_atomically", decideArgs(competition, entry.entryId, competition.organizer, "REJECT", "DUPLICATE_OR_MISTAKEN_ENTRY", "Entered twice by mistake."));
    expect(row).toMatchObject({ status: "REJECTED", decision: "REJECT", released_claims: 3 });
    expect(await entryRow(entry.entryId)).toMatchObject({ status: "REJECTED", decided_by_gaming_member_id: id(competition.organizer), rejection_reason: "ENTRY_REJECTED_BY_ORGANIZER" });
    const [decision] = await decisionsOf(entry.entryId);
    expect(decision).toMatchObject({ decision: "REJECTED", decided_by_role: "ORGANIZER", reason_code: "DUPLICATE_OR_MISTAKEN_ENTRY", note: "Entered twice by mistake.", previous_status: "PENDING_ORGANIZER_APPROVAL", new_status: "REJECTED", released_claims: 3 });
    expect((await eventsOf(team.teamId)).filter((e) => e.event_type === "ENTRY_REJECTED")[0]).toMatchObject({ actor_gaming_member_id: id(competition.organizer), related_id: entry.entryId });
    // The claims are settled and PRESERVED: the same rows, the same people, an accepted place becomes REMOVED and a proposal WITHDRAWN, each dated and attributed.
    const after = await claimsOf(entry.entryId);
    expect(after.map((r) => r.id)).toEqual(before.map((r) => r.id));
    expect(after.map((r) => r.status)).toEqual(["REMOVED", "REMOVED", "WITHDRAWN"]);
    for (const claim of after) expect(claim).toMatchObject({ release_reason: "ENTRY_REJECTED_BY_ORGANIZER", released_by_gaming_member_id: id(competition.organizer) });
    expect(after.map((r) => r.accepted_at !== null)).toEqual(before.map((r) => r.accepted_at !== null)); // an accepted place keeps the moment it was accepted
    // The team is free to enter again; a rejected entry never blocks a new one.
    const again = await h.enterTeam(competition, team);
    expect(again.entryId).not.toBe(entry.entryId);
  });

  it("accepts every reason code of the bounded list, and records it", async () => {
    const competition = await h.setUpCompetition("ReasonCodes");
    for (const reason of REASONS) {
      const fresh = await h.buildTeam(`Reason${reason.slice(0, 6)}`, 3);
      const entered = await h.enterTeam(competition, fresh);
      const row = await h.decideEntry(competition, entered.entryId, "REJECT", { reason });
      expect(row.status).toBe("REJECTED");
      expect((await decisionsOf(entered.entryId))[0].reason_code).toBe(reason);
    }
  });

  it("will not reject an accepted entry (that is a removal), and will not remove one that is not accepted", async () => {
    const { competition, entry } = await scenario("RejectAccepted");
    await refused("decide_lifetime_competition_entry_atomically", decideArgs(competition, entry.entryId, competition.organizer, "REMOVE", REASON), "LIFETIME_ENTRY_NOT_ACCEPTED");
    await h.decideEntry(competition, entry.entryId, "APPROVE");
    await refused("decide_lifetime_competition_entry_atomically", decideArgs(competition, entry.entryId, competition.organizer, "REJECT", REASON), "LIFETIME_ENTRY_NOT_PENDING");
  });
});

// =============================================================================================================================================
describe("[3] the organizer removes an accepted entry before the freeze", () => {
  it("moves ACCEPTED to REJECTED with a reason, settles every claim and preserves its record, and says so as a REMOVAL (not a rejection, not a withdrawal)", async () => {
    const { competition, team, entry } = await scenario("Remove", 6);
    await h.rosterUp(entry.entryId, team.captain, competition, [team.captain, team.members[0]]);
    await rpc("propose_lifetime_entry_roster_claims_atomically", proposeArgs(entry.entryId, team.captain, [id(team.members[1])]));
    await h.decideEntry(competition, entry.entryId, "APPROVE");
    const row = await one("decide_lifetime_competition_entry_atomically", decideArgs(competition, entry.entryId, competition.organizer, "REMOVE", "RULE_VIOLATION", "Fielded an ineligible player."));
    expect(row).toMatchObject({ status: "REJECTED", decision: "REMOVE", released_claims: 3 });
    expect(await entryRow(entry.entryId)).toMatchObject({ status: "REJECTED", rejection_reason: "ENTRY_REMOVED_BY_ORGANIZER", decided_by_gaming_member_id: id(competition.organizer) });
    const decisions = await decisionsOf(entry.entryId);
    expect(decisions.map((d) => d.decision)).toEqual(["APPROVED", "REMOVED"]); // the approval is history, it is never overwritten
    expect(decisions[1]).toMatchObject({ decided_by_role: "ORGANIZER", reason_code: "RULE_VIOLATION", note: "Fielded an ineligible player.", previous_status: "ACCEPTED", new_status: "REJECTED", released_claims: 3 });
    expect((await eventsOf(team.teamId)).map((e) => e.event_type).filter((t) => t.startsWith("ENTRY_"))).toEqual(["ENTRY_SUBMITTED", "ENTRY_APPROVED", "ENTRY_REMOVED"]);
    const claims = await claimsOf(entry.entryId);
    expect(claims.map((r) => r.status)).toEqual(["REMOVED", "REMOVED", "WITHDRAWN"]);
    for (const claim of claims) expect(claim.release_reason).toBe("ENTRY_REMOVED_BY_ORGANIZER");
  });

  it("needs a reason, and is refused after the deadline (registration is no longer open) and after the freeze", async () => {
    const { competition, entry } = await scenario("RemoveGuards");
    await h.decideEntry(competition, entry.entryId, "APPROVE");
    await refused("decide_lifetime_competition_entry_atomically", decideArgs(competition, entry.entryId, competition.organizer, "REMOVE"), "LIFETIME_REASON_INVALID");
    await h.passDeadline(competition.competitionId);
    await refused("decide_lifetime_competition_entry_atomically", decideArgs(competition, entry.entryId, competition.organizer, "REMOVE", REASON), "TEAM_REGISTRATION_NOT_OPEN");
    expect((await entryRow(entry.entryId)).status).toBe("ACCEPTED");
  });

  it("fails closed after the freeze: no approval, rejection or removal can change a frozen competition", async () => {
    const { competition, teams } = await entered("PostFreeze", 3);
    const [a, b, c] = teams.map((t) => t.entry.entryId);
    await h.approveEntries(competition, a, b);
    await h.decideEntry(competition, c, "REJECT", { reason: "COMPETITION_CAPACITY" });
    await h.passDeadline(competition.competitionId);
    await one("freeze_lifetime_competition_entries_atomically", freezeArgs(competition));
    for (const [entryId, decision, reason] of [[a, "REMOVE", REASON], [b, "REJECT", REASON], [c, "APPROVE", null], [a, "APPROVE", null]] as const) {
      await refused("decide_lifetime_competition_entry_atomically", decideArgs(competition, entryId, competition.organizer, decision, reason), "LIFETIME_ENTRIES_FROZEN");
    }
    expect((await entryRow(a)).status).toBe("ACCEPTED");
    expect((await entryRow(c)).status).toBe("REJECTED");
  });
});

// =============================================================================================================================================
describe("[4] nobody but the competition's own, active, non-revoked organizer decides an entry", () => {
  it("answers COMPETITION_ACCESS_DENIED to an unrelated organizer, a captain, a sub-captain, a team member, an applicant, a stranger and a caller with no identity — for every decision", async () => {
    const { competition, team, entry } = await scenario("Authority", 6);
    await h.rosterUp(entry.entryId, team.captain, competition, [team.members[0]]);
    const unrelated = await h.setUpCompetition("AuthorityOther"); // its own, perfectly valid organizer — of ANOTHER competition
    const [applicant, stranger] = await h.newPeople(2, "Authority");
    await h.register(competition, applicant);
    const everyone: Array<[string, string | null]> = [
      ["unrelated organizer", id(unrelated.organizer)], ["captain", id(team.captain)], ["sub-captain", id(team.subCaptain!)], ["team member", id(team.members[0])],
      ["registered applicant", id(applicant)], ["stranger", id(stranger)], ["nobody", null]];
    for (const [who, actor] of everyone) {
      for (const [decision, reason] of [["APPROVE", null], ["REJECT", REASON], ["REMOVE", REASON]] as const) {
        const outcome = await settle("decide_lifetime_competition_entry_atomically", { ...decideArgs(competition, entry.entryId, competition.organizer, decision, reason), p_organizer_gaming_member_id: actor });
        expect(outcome, `${who} must have no authority (${decision})`).toMatchObject({ ok: false, refusal: "COMPETITION_ACCESS_DENIED" });
      }
    }
    expect(await entryRow(entry.entryId)).toMatchObject({ status: "PENDING_ORGANIZER_APPROVAL", decided_at: null });
    expect(await decisionsOf(entry.entryId)).toHaveLength(0);
    expect(await claimsOf(entry.entryId), "and not one claim moved").toHaveLength(1);
    // The denial comes BEFORE anything about the entry: a stranger learns nothing from a made-up entry id either.
    expect(await settle("decide_lifetime_competition_entry_atomically", { ...decideArgs(competition, "00000000-0000-4000-8000-0000000000ee", competition.organizer, "APPROVE"), p_organizer_gaming_member_id: id(stranger) }))
      .toMatchObject({ ok: false, refusal: "COMPETITION_ACCESS_DENIED" });
  });

  it("fails closed for a REVOKED organizer, for every decision, before it says anything about the entry", async () => {
    const { competition, entry } = await scenario("Revoked");
    await h.decideEntry(competition, entry.entryId, "APPROVE"); // made before the revocation
    const pending = await scenario("RevokedPending");
    for (const [target, decision, reason] of [[pending, "APPROVE", null], [pending, "REJECT", REASON], [{ competition, entry }, "REMOVE", REASON]] as const) {
      // One decision per transaction: a refused statement aborts its transaction, and the revocation row is rolled back with it.
      const refusal = await withRevokedHost(target.competition, (db) => refusalOf(db, "select * from decide_lifetime_competition_entry_atomically($1, $2, $3, $4, $5, null)",
        [target.competition.competitionId, target.entry.entryId, id(target.competition.organizer), decision, reason]));
      expect(refusal ?? "", `${decision} by a revoked organizer`).toMatch(/^HOST_ACCESS_REVOKED:/);
    }
    // The revocation was never committed, so the very same organizer still can: the refusals above were the revocation and nothing else.
    expect((await h.decideEntry(pending.competition, pending.entry.entryId, "APPROVE")).status).toBe("ACCEPTED");
    expect((await decisionsOf(entry.entryId)).map((d) => d.decision)).toEqual(["APPROVED"]);
  });
});

// =============================================================================================================================================
describe("[5] a team's own withdrawal stays distinguishable from an organizer's decision", () => {
  it("records withdrawal, organizer rejection and organizer removal differently in the entry's category, the decision record, the audit event and the claim reasons", async () => {
    const competition = await h.setUpCompetition("Distinct");
    const [withdrawn, rejected, removed] = [await h.buildTeam("DistinctW", 5), await h.buildTeam("DistinctR", 5), await h.buildTeam("DistinctM", 5)];
    const entries = [await h.enterTeam(competition, withdrawn), await h.enterTeam(competition, rejected), await h.enterTeam(competition, removed)];
    for (const [i, t] of [withdrawn, rejected, removed].entries()) await h.rosterUp(entries[i].entryId, t.captain, competition, [t.captain, t.members[0]]);
    await h.decideEntry(competition, entries[2].entryId, "APPROVE");
    await one("withdraw_lifetime_competition_entry_atomically", withdrawArgs(entries[0].entryId, withdrawn.captain)); // a PENDING entry, withdrawn by its own captain
    await h.decideEntry(competition, entries[1].entryId, "REJECT", { reason: REASON });
    await h.decideEntry(competition, entries[2].entryId, "REMOVE", { reason: REASON });
    const view = async (i: number, team: { teamId: string }) => {
      const e = await entryRow(entries[i].entryId);
      const decisions = await decisionsOf(entries[i].entryId);
      return {
        status: e.status, category: e.rejection_reason, decidedBy: e.decided_by_gaming_member_id,
        lastDecision: { decision: decisions[decisions.length - 1].decision, role: decisions[decisions.length - 1].decided_by_role, reason: decisions[decisions.length - 1].reason_code },
        event: (await eventsOf(team.teamId)).map((x) => x.event_type).filter((t) => /^ENTRY_(WITHDRAWN|REJECTED|REMOVED)$/.test(t)),
        claimReasons: [...new Set((await claimsOf(entries[i].entryId)).map((c) => c.release_reason))],
      };
    };
    expect(await view(0, withdrawn)).toEqual({ status: "REJECTED", category: "ENTRY_WITHDRAWN_BY_TEAM", decidedBy: id(withdrawn.captain), lastDecision: { decision: "WITHDRAWN", role: "TEAM_LEADER", reason: null }, event: ["ENTRY_WITHDRAWN"], claimReasons: ["ENTRY_WITHDRAWN"] });
    expect(await view(1, rejected)).toEqual({ status: "REJECTED", category: "ENTRY_REJECTED_BY_ORGANIZER", decidedBy: id(competition.organizer), lastDecision: { decision: "REJECTED", role: "ORGANIZER", reason: REASON }, event: ["ENTRY_REJECTED"], claimReasons: ["ENTRY_REJECTED_BY_ORGANIZER"] });
    expect(await view(2, removed)).toEqual({ status: "REJECTED", category: "ENTRY_REMOVED_BY_ORGANIZER", decidedBy: id(competition.organizer), lastDecision: { decision: "REMOVED", role: "ORGANIZER", reason: REASON }, event: ["ENTRY_REMOVED"], claimReasons: ["ENTRY_REMOVED_BY_ORGANIZER"] });
  });

  it("keeps the team's ability to withdraw its own entry before the freeze — a pending one and, now, an accepted one — and refuses it after", async () => {
    const { competition, teams } = await entered("Withdraw", 3);
    const [a, b, c] = teams;
    await h.approveEntries(competition, a.entry.entryId, b.entry.entryId);
    expect(await one("withdraw_lifetime_competition_entry_atomically", withdrawArgs(a.entry.entryId, a.team.captain))).toMatchObject({ status: "REJECTED", released_claims: 5 }); // accepted entry
    expect(await one("withdraw_lifetime_competition_entry_atomically", withdrawArgs(c.entry.entryId, c.team.subCaptain!))).toMatchObject({ status: "REJECTED" }); // pending entry, by the sub-captain
    expect((await decisionsOf(a.entry.entryId)).map((d) => d.decision)).toEqual(["APPROVED", "WITHDRAWN"]);
    await refused("withdraw_lifetime_competition_entry_atomically", withdrawArgs(a.entry.entryId, a.team.captain), "LIFETIME_ENTRY_NOT_LIVE");
    // a person who leads no team cannot withdraw anybody's entry, whoever they are (the organizer included: that is a removal)
    await refused("withdraw_lifetime_competition_entry_atomically", withdrawArgs(b.entry.entryId, competition.organizer), "LIFETIME_NOT_A_LEADER");
  });
});

// =============================================================================================================================================
describe("[6] the freeze counts only accepted entries", () => {
  it("refuses while ANY lifetime entry is pending — the rule needs no approval to be exercised: two rostered entries nobody decided cannot be frozen", async () => {
    const { competition } = await entered("FreezeUndecided", 2);
    await h.passDeadline(competition.competitionId);
    await refused("freeze_lifetime_competition_entries_atomically", freezeArgs(competition), "LIFETIME_FREEZE_PENDING_ENTRIES");
    expect(await rawQuery("select 1 from competition_lifetime_freezes where competition_id = $1", [competition.competitionId]), "a refused freeze records nothing").toHaveLength(0);
  });

  it("refuses while ANY lifetime entry is still pending, however many others are accepted", async () => {
    const { competition, teams } = await entered("FreezePending", 3);
    await h.approveEntries(competition, teams[0].entry.entryId, teams[1].entry.entryId); // the third stays pending
    await h.passDeadline(competition.competitionId);
    await refused("freeze_lifetime_competition_entries_atomically", freezeArgs(competition), "LIFETIME_FREEZE_PENDING_ENTRIES");
    expect(await rawQuery("select 1 from competition_lifetime_freezes where competition_id = $1", [competition.competitionId]), "a refused freeze records nothing").toHaveLength(0);
    await h.decideEntry(competition, teams[2].entry.entryId, "REJECT", { reason: "COMPETITION_CAPACITY" }); // rejecting is allowed after the deadline: it clears the way
    expect(await one("freeze_lifetime_competition_entries_atomically", freezeArgs(competition))).toMatchObject({ entry_count: 2, claim_count: 10, already_frozen: false });
  });

  it("never counts a rejected, removed or withdrawn entry, nor the places of one, in the entry or the roster totals", async () => {
    const { competition, teams } = await entered("FreezeCounts", 5);
    const ids = teams.map((t) => t.entry.entryId);
    await h.approveEntries(competition, ids[0], ids[1], ids[2]);
    await h.decideEntry(competition, ids[3], "REJECT", { reason: REASON }); // rejected while pending
    await one("withdraw_lifetime_competition_entry_atomically", withdrawArgs(ids[4], teams[4].team.captain)); // withdrawn by its team
    await h.decideEntry(competition, ids[2], "REMOVE", { reason: "RULE_VIOLATION" }); // removed after being accepted
    await h.passDeadline(competition.competitionId);
    const frozen = await one("freeze_lifetime_competition_entries_atomically", freezeArgs(competition));
    expect(frozen).toMatchObject({ entry_count: 2, claim_count: 10 });
    const [row] = await rawQuery("select entry_count, claim_count from competition_lifetime_freezes where competition_id = $1", [competition.competitionId]);
    expect(row).toEqual({ entry_count: 2, claim_count: 10 });
    expect(await countOf("select count(*)::int n from competition_lifetime_roster_claims where competition_id = $1 and status = 'ACCEPTED'", [competition.competitionId])).toBe(10); // and nothing else is accepted
  });

  it("settles the proposals nobody answered (they expire) and counts only ACCEPTED places of ACCEPTED entries", async () => {
    const { competition, teams } = await entered("FreezeClaims", 2, 6);
    const [a, b] = teams;
    const [extra] = await h.newPeople(1, "Unanswered");
    await h.addMember(a.team.teamId, a.team.captain, extra); // a member who is not on the roster yet
    await rpc("propose_lifetime_entry_roster_claims_atomically", proposeArgs(a.entry.entryId, a.team.captain, [id(extra)])); // a proposal nobody answers
    await h.approveEntries(competition, a.entry.entryId, b.entry.entryId);
    await h.passDeadline(competition.competitionId);
    expect(await one("freeze_lifetime_competition_entries_atomically", freezeArgs(competition))).toMatchObject({ entry_count: 2, claim_count: 12 });
    expect((await claimsOf(a.entry.entryId)).map((c) => c.status).sort()).toEqual(["ACCEPTED", "ACCEPTED", "ACCEPTED", "ACCEPTED", "ACCEPTED", "ACCEPTED", "EXPIRED"]);
  });

  it("validates the roster bounds for ACCEPTED entries only: a rejected entry with no players does not block the freeze, an accepted one below the minimum does", async () => {
    const fine = await entered("FreezeBoundsFine", 2, 5);
    const bare = await h.enterTeam(fine.competition, await h.buildTeam("FreezeBoundsBare", 3)); // a third entry with no roster at all
    await h.approveEntries(fine.competition, fine.teams[0].entry.entryId, fine.teams[1].entry.entryId);
    await h.decideEntry(fine.competition, bare.entryId, "REJECT", { reason: "INCOMPLETE_ENTRY" });
    await h.passDeadline(fine.competition.competitionId);
    expect(await one("freeze_lifetime_competition_entries_atomically", freezeArgs(fine.competition))).toMatchObject({ entry_count: 2, claim_count: 10 });
    const short = await entered("FreezeBoundsShort", 2, 5);
    await h.approveEntries(short.competition, short.teams[0].entry.entryId, short.teams[1].entry.entryId);
    await one("release_lifetime_entry_roster_claim_atomically", { p_competition_lifetime_roster_claim_id: (await claimsOf(short.teams[1].entry.entryId))[0].id, p_actor_gaming_member_id: id(short.teams[1].team.captain) });
    await h.passDeadline(short.competition.competitionId);
    await refused("freeze_lifetime_competition_entries_atomically", freezeArgs(short.competition), "LIFETIME_FREEZE_ROSTER_BELOW_MINIMUM"); // an ACCEPTED entry with four players
  });

  it("needs at least two ACCEPTED entries (one accepted and one rejected is not enough), and reports a pending entry first", async () => {
    const { competition, teams } = await entered("FreezeTwo", 2);
    await h.approveEntries(competition, teams[0].entry.entryId);
    await h.decideEntry(competition, teams[1].entry.entryId, "REJECT", { reason: REASON });
    await h.passDeadline(competition.competitionId);
    await refused("freeze_lifetime_competition_entries_atomically", freezeArgs(competition), "LIFETIME_FREEZE_NOT_ENOUGH_ENTRIES");
    const nothing = await entered("FreezeNone", 2);
    await h.passDeadline(nothing.competition.competitionId);
    await refused("freeze_lifetime_competition_entries_atomically", freezeArgs(nothing.competition), "LIFETIME_FREEZE_PENDING_ENTRIES"); // two pending: decide them first
  });

  it("is idempotent, preserves the plan revision and the deadline, and blocks every later entry, decision, withdrawal and roster change", async () => {
    const { competition, teams } = await entered("FreezeAfter", 2);
    const late = await h.buildTeam("FreezeAfterLate", 3);
    await h.register(competition, late.captain);
    await h.approveEntries(competition, teams[0].entry.entryId, teams[1].entry.entryId);
    await h.passDeadline(competition.competitionId);
    const first = await one("freeze_lifetime_competition_entries_atomically", freezeArgs(competition));
    const again = await one("freeze_lifetime_competition_entries_atomically", freezeArgs(competition));
    expect(again).toMatchObject({ already_frozen: true, entry_count: first.entry_count, claim_count: first.claim_count });
    expect(new Date(again.frozen_at).getTime()).toBe(new Date(first.frozen_at).getTime());
    const [plan] = await rawQuery("select planning_revision_id, roster_minimum, roster_maximum, registration_deadline_utc from competition_current_registration_plan($1)", [competition.competitionId]);
    const [freeze] = await rawQuery("select planning_revision_id, roster_minimum, roster_maximum, registration_deadline_utc from competition_lifetime_freezes where competition_id = $1", [competition.competitionId]);
    expect(freeze).toEqual(plan);
    const a = teams[0];
    await refused("withdraw_lifetime_competition_entry_atomically", withdrawArgs(a.entry.entryId, a.team.captain), "LIFETIME_ENTRIES_FROZEN");
    await refused("propose_lifetime_entry_roster_claims_atomically", proposeArgs(a.entry.entryId, a.team.captain, [id(a.team.members[0])]), "LIFETIME_ENTRIES_FROZEN");
    await refused("enter_lifetime_team_into_competition_atomically", { p_competition_id: competition.competitionId, p_lifetime_team_id: late.teamId, p_actor_gaming_member_id: id(late.captain) }, "LIFETIME_ENTRIES_FROZEN");
    await refused("decide_lifetime_competition_entry_atomically", decideArgs(competition, a.entry.entryId, competition.organizer, "REMOVE", REASON), "LIFETIME_ENTRIES_FROZEN");
  });
});

// =============================================================================================================================================
describe("[7] an ACCEPTED lifetime entry is still nothing the V1 team paths can consume", () => {
  it("[pre-existing control] V1 paths refuse a PENDING lifetime entry exactly as CFM-001 made them: a join request (TEAM_NOT_ACCEPTED) and a decision (TEAM_REGISTRATION_NOT_OPEN)", async () => {
    const { competition, entry } = await scenario("V1Pending");
    const [person] = await h.newPeople(1, "V1PendingJoiner");
    await h.register(competition, person);
    await refused("request_join_competition_team_atomically", { p_competition_id: competition.competitionId, p_competition_team_id: entry.entryId, p_requesting_gaming_member_id: id(person) }, "TEAM_NOT_ACCEPTED");
    await refused("decide_competition_team_atomically", { p_competition_team_id: entry.entryId, p_organizer_gaming_member_id: id(competition.organizer), p_decision: "APPROVE", p_reason: null }, "TEAM_REGISTRATION_NOT_OPEN");
    expect((await entryRow(entry.entryId)).status).toBe("PENDING_ORGANIZER_APPROVAL");
    expect(await countOf("select count(*)::int n from competition_join_requests where competition_team_id = $1", [entry.entryId])).toBe(0);
  });

  it("[pre-existing control] real V1 teams are untouched by the lifetime guards: a member can request to join one and its membership rows can still be written", async () => {
    const v1 = await h.setUpCompetition("V1Real", { lifetimeFlow: false });
    const [captain, joiner] = await h.newPeople(2, "V1Real");
    await h.register(v1, joiner);
    const team = await one("add_competition_team_atomically", { p_competition_id: v1.competitionId, p_organizer_gaming_member_id: id(v1.organizer), p_name: h.uniqueName("V1 Real"), p_captain_gaming_member_id: id(captain), p_public_code: randomBytes(16).toString("base64url") });
    const request = await one("request_join_competition_team_atomically", { p_competition_id: v1.competitionId, p_competition_team_id: team.competition_team_id, p_requesting_gaming_member_id: id(joiner) });
    expect(request.status).toBe("REQUESTED");
    expect(await violation("insert into competition_team_memberships (competition_id, competition_team_id, gaming_member_id, approved_by_gaming_member_id) values ($1, $2, $3, $4)",
      [v1.competitionId, team.competition_team_id, id(joiner), id(v1.organizer)]), "a V1 membership row is written exactly as before").toBeNull();
  });

  it("refuses a V1 join request against it, as it always did (TEAM_NOT_ACCEPTED), and no V1 membership or request can be written for it", async () => {
    const { competition, entry } = await scenario("V1Join");
    const [person] = await h.newPeople(1, "V1Joiner");
    await h.register(competition, person);
    const request = { p_competition_id: competition.competitionId, p_competition_team_id: entry.entryId, p_requesting_gaming_member_id: id(person) };
    await refused("request_join_competition_team_atomically", request, "TEAM_NOT_ACCEPTED"); // pending: V1's own check
    await h.decideEntry(competition, entry.entryId, "APPROVE");
    await refused("request_join_competition_team_atomically", request, "TEAM_NOT_ACCEPTED"); // accepted: the table's guard says the same thing
    expect(await countOf("select count(*)::int n from competition_join_requests where competition_team_id = $1", [entry.entryId])).toBe(0);
    const membership = await violation("insert into competition_team_memberships (competition_id, competition_team_id, gaming_member_id, approved_by_gaming_member_id) values ($1, $2, $3, $4)", [competition.competitionId, entry.entryId, id(person), id(competition.organizer)]);
    expect(membership?.message).toMatch(/^TEAM_NOT_ACCEPTED:/);
    const joinRow = await violation("insert into competition_join_requests (competition_id, competition_team_id, requesting_gaming_member_id) values ($1, $2, $3)", [competition.competitionId, entry.entryId, id(person)]);
    expect(joinRow?.message).toMatch(/^TEAM_NOT_ACCEPTED:/);
  });

  it("leaves the V1 decision, the V1 close and the V1 freeze unable to consume a competition full of accepted lifetime entries", async () => {
    const { competition, teams } = await entered("V1Four", 4);
    const decideV1 = (entryId: string) => ({ p_competition_team_id: entryId, p_organizer_gaming_member_id: id(competition.organizer), p_decision: "REJECT", p_reason: "no" });
    await refused("decide_competition_team_atomically", decideV1(teams[0].entry.entryId), "TEAM_REGISTRATION_NOT_OPEN"); // pending: unchanged CFM-001 behaviour
    await h.approveEntries(competition, ...teams.map((t) => t.entry.entryId));
    await refused("decide_competition_team_atomically", decideV1(teams[0].entry.entryId), "TEAM_DECISION_ALREADY_MADE"); // accepted: V1's own answer for a team that is already decided
    expect((await entryRow(teams[0].entry.entryId)).status, "and it did not move").toBe("ACCEPTED");
    await h.passDeadline(competition.competitionId);
    const close = await settle("close_team_registration_atomically", { p_competition_id: competition.competitionId, p_organizer_gaming_member_id: id(competition.organizer) });
    // The first refusal on this path is V1's own roster check: a lifetime entry has no V1 membership (and the guards of this migration keep it from ever getting one), so the "teams"
    // V1 sees have 0 members. The V1 freeze-insert guard is the backstop behind it (pinned directly by the CFM-001 suites); either way the close is atomic: nothing is written.
    expect(close.ok, "four accepted lifetime entries must not let the V1 close through").toBe(false);
    expect(close.ok ? null : close.refusal, "observed on this base: V1 refuses before it reaches its freeze").toBe("REGISTRATION_FREEZE_ROSTER_BELOW_MINIMUM");
    expect(await rawQuery("select 1 from competition_registration_freezes where competition_id = $1", [competition.competitionId])).toHaveLength(0);
    expect((await rawQuery("select state from competitions where competition_id = $1", [competition.competitionId]))[0].state).toBe("TEAM_REGISTRATION_OPEN");
  });

  it("leaves the four-team draw unable to consume accepted lifetime entries: four accepted and frozen entries are refused as the wrong state, and — in the very state it expects — for lacking the V1 registration freeze that cannot exist", async () => {
    const { competition, teams } = await entered("V1Draw", 4);
    await h.approveEntries(competition, ...teams.map((t) => t.entry.entryId));
    await h.passDeadline(competition.competitionId);
    expect(await one("freeze_lifetime_competition_entries_atomically", freezeArgs(competition))).toMatchObject({ entry_count: 4, claim_count: 20 }); // the lifetime freeze holds all four
    const draw = { p_competition_id: competition.competitionId, p_organizer_gaming_member_id: id(competition.organizer), p_intent_id: randomUUID() };
    await refused("create_competition_draw_atomically", draw, "COMPETITION_DRAW_WRONG_STATE");
    const inExpectedState = await rawTransaction(async (db) => {
      await db.query("set local session_replication_role = replica");
      await db.query("update competitions set state = 'READY_TO_PUBLISH' where competition_id = $1", [competition.competitionId]);
      await db.query("set local session_replication_role = origin");
      return refusalOf(db, "select create_competition_draw_atomically($1::uuid, $2::uuid, $3::uuid)", [competition.competitionId, id(competition.organizer), randomUUID()]);
    });
    expect(inExpectedState).toMatch(/^COMPETITION_DRAW_FREEZE_REQUIRED:/);
    for (const table of ["competition_draws", "competition_registration_freezes", "competition_fixtures"]) {
      expect(await countOf(`select count(*)::int n from ${table} where competition_id = $1`, [competition.competitionId]), `${table}: nothing was drawn, frozen the V1 way or scheduled`).toBe(0);
    }
  });
});
