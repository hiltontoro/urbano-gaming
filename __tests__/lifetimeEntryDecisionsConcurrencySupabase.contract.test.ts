import { randomBytes } from "node:crypto";

import { Client } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import { loadEnv } from "vite";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";

import { createHarness, type BuiltTeam, type LifetimeTestCompetition, type Outcome, type Person } from "./helpers/lifetimeContract";

/**
 * UG-CR-GATE-CFM-004 — concurrency, audit integrity, the entry guard's transition matrix, the catalog, and mutation controls for the organizer's entry decisions and the
 * recovery of the lifetime flow, against a real (disposable, loopback-only) Postgres.
 *
 * Every race is REAL (see the CFM-001 concurrency suite, whose technique this reuses): each call is its own HTTP request and its own database transaction; a raw session
 * holds the competition's scope lock — the one every organizer operation of this repository takes first — the calls are started ONE AT A TIME, each only once the database
 * SHOWS the previous one queued behind that session, and the lock is released after: the arrival order is forced in both directions and the exact outcome of each order is
 * asserted. Nothing is left to a coin toss, and no assertion is vacuous. What every race proves: exactly the outcomes the rules allow, a coded refusal for every loser
 * (never a deadlock, never a raw database error), and the invariants afterwards.
 *
 *   [1] decisions against each other and against the team's own operations     [4] organizer revocation racing with a decision or the recovery
 *   [2] the freeze against decisions                                          [5] the decision record and the entry guard: nothing is rewritten, nothing moves off the matrix
 *   [3] the recovery against entry creation and V1 team creation              [6] the catalog: privileges, RLS, triggers
 *                                                                              [7] mutation controls: the probes can fail
 */

// The shared contract-test guard (UG-CR-GATE-079) runs before anything is constructed: no target that is not loopback is ever touched.
const supabaseUrl = loadEnv("development", process.cwd(), "").SUPABASE_URL;
requireLocalSupabase(supabaseUrl);
vi.setConfig({ testTimeout: 120_000 });

const h = createHarness("ec");
const { one, rpc, settle, rawQuery, rawTransaction, violation } = h;

afterAll(() => h.cleanup(), 600000);

const id = (p: Person) => p.gamingMemberId;
const REASON = "INELIGIBLE_TEAM";
const publicCode = () => randomBytes(16).toString("base64url");

const decideArgs = (c: { competitionId: string }, entryId: string, who: Person, decision: string, reason: string | null = null, note: string | null = null) =>
  ({ p_competition_id: c.competitionId, p_competition_team_id: entryId, p_organizer_gaming_member_id: id(who), p_decision: decision, p_reason_code: reason, p_note: note });
const freezeArgs = (c: LifetimeTestCompetition) => ({ p_competition_id: c.competitionId, p_organizer_gaming_member_id: id(c.organizer) });
const withdrawArgs = (entryId: string, actor: Person) => ({ p_competition_team_id: entryId, p_actor_gaming_member_id: id(actor) });
const disableArgs = (c: { competitionId: string; organizer: Person }) => ({ p_competition_id: c.competitionId, p_organizer_gaming_member_id: id(c.organizer) });
const enterArgs = (c: { competitionId: string }, team: BuiltTeam) => ({ p_competition_id: c.competitionId, p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: id(team.captain) });
const claimDecision = (claimId: string, actor: Person, decision = "ACCEPT") => ({ p_competition_lifetime_roster_claim_id: claimId, p_actor_gaming_member_id: id(actor), p_decision: decision });

const entryRow = async (entryId: string) => (await rawQuery("select * from competition_teams where competition_team_id = $1", [entryId]))[0];
const decisionKinds = async (entryId: string) => (await rawQuery("select decision from competition_lifetime_entry_decisions where competition_team_id = $1 order by decision_seq", [entryId])).map((r) => r.decision as string);
const claimsOf = (entryId: string) => rawQuery("select competition_lifetime_roster_claim_id id, gaming_member_id, status, release_reason from competition_lifetime_roster_claims where competition_team_id = $1 order by seq", [entryId]);
const flowCount = async (competitionId: string) => (await rawQuery("select count(*)::int n from competition_lifetime_flows where competition_id = $1", [competitionId]))[0].n as number;
const flowEvents = async (competitionId: string) => (await rawQuery("select event_type from competition_lifetime_flow_events where competition_id = $1 order by flow_event_seq", [competitionId])).map((r) => r.event_type as string);
const countOf = async (sql: string, params: unknown[]) => (await rawQuery(sql, params))[0].n as number;

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The race machinery (the CFM-001 technique: hold the lock, start ONE call at a time, wait until the database shows it queued, then release)
// ---------------------------------------------------------------------------------------------------------------------------------------------
/**
 * How many sessions wait on the holder, directly OR through a chain: a racer that holds the team row and waits for the held competition lock is directly blocked, and the racer
 * that then waits for that team row is blocked by it — both are queued behind the holder, and nothing else in the database can change this count.
 * The snapshot is cleared first: the holder polls INSIDE its open transaction, where pg_stat_activity is cached at its first read, so a backend created later (a new PostgREST pool
 * connection for a racer, when the pool is short) would stay invisible and the racer would "never queue" — the intermittent failure this line fixes (proved in isolation: three new
 * backends showed as 0 until pg_stat_clear_snapshot()).
 */
async function blockedBy(db: Client, holderPid: number): Promise<number> {
  await db.query("select pg_stat_clear_snapshot()");
  return (await db.query(
    `with recursive chain as (
       select a.pid from pg_stat_activity a where $1 = any(pg_blocking_pids(a.pid))
       union
       select a.pid from pg_stat_activity a join chain c on c.pid = any(pg_blocking_pids(a.pid)))
     select count(*)::int n from chain`, [holderPid])).rows[0].n as number;
}
async function queued(db: Client, holderPid: number, count: number, label: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    if ((await blockedBy(db, holderPid)) >= count) return;
    if (Date.now() > deadline) throw new Error(`${label}: ${count} racer(s) never queued behind the held lock`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}
const holdCompetition = (competitionId: string) => async (db: Client) => {
  await db.query("select pg_advisory_xact_lock(hashtext($1))", [`competition_scope:${competitionId}`]);
  await db.query("select 1 from competitions where competition_id = $1 for update", [competitionId]);
};
/** Holds the competition's scope lock, starts the calls ONE AT A TIME (each once the previous is queued), runs `beforeRelease` with the holder's own session, then releases. */
async function arrivingInOrder<T>(competitionId: string, calls: Array<() => Promise<T>>, label: string, beforeRelease?: (db: Client) => Promise<void>): Promise<T[]> {
  const db = new Client({ connectionString: h.dbUrl, statement_timeout: 60000 });
  await db.connect();
  try {
    await db.query("begin");
    await holdCompetition(competitionId)(db);
    const pid = (await db.query("select pg_backend_pid() as pid")).rows[0].pid as number;
    const pending: Array<Promise<T>> = [];
    for (let i = 0; i < calls.length; i++) {
      pending.push(calls[i]());
      await queued(db, pid, i + 1, `${label} #${i + 1}`);
    }
    if (beforeRelease) await beforeRelease(db);
    await db.query("commit");
    return await Promise.all(pending);
  } finally {
    await db.query("rollback").catch(() => {});
    await db.end().catch(() => {});
  }
}
function onlyCodedRefusals(outcomes: Outcome[]) {
  for (const outcome of outcomes) {
    if (!outcome.ok) expect({ code: outcome.code, refusal: outcome.refusal, message: outcome.message }, "a failure must be a coded refusal, not a raw database error").toMatchObject({ code: "P0001", refusal: expect.stringMatching(/^[A-Z][A-Z0-9_]+$/) });
  }
}
const refusalOf = (outcome: Outcome) => (outcome.ok ? null : outcome.refusal);

/** A competition and one entered team (PENDING, nothing rostered unless `size` people accept). */
async function scenario(label: string, size = 5) {
  const competition = await h.setUpCompetition(label);
  const team = await h.buildTeam(`${label}T`, size);
  const entry = await h.enterTeam(competition, team);
  return { competition, team, entry };
}
/** Three rostered entries in one competition: A and B approved, C still pending. */
async function threeEntries(label: string, size = 5) {
  const competition = await h.setUpCompetition(label);
  const teams: Array<{ team: BuiltTeam; entry: { entryId: string; publicCode: string } }> = [];
  for (let i = 0; i < 3; i++) {
    const team = await h.buildTeam(`${label}${i}`, size);
    const entry = await h.enterTeam(competition, team);
    await h.rosterUp(entry.entryId, team.captain, competition, team.everyone);
    teams.push({ team, entry });
  }
  await h.approveEntries(competition, teams[0].entry.entryId, teams[1].entry.entryId);
  return { competition, teams };
}

/** Inserts (as the owner, so it is VISIBLE to a racer) a REVOKED hosting capability for the competition's organizer. Returns what to delete afterwards. */
async function revokeHostCommitted(competition: LifetimeTestCompetition, db?: Client): Promise<{ application: string }> {
  const run = db ?? new Client({ connectionString: h.dbUrl });
  if (!db) await run.connect();
  try {
    const member = id(competition.organizer);
    const application = (await run.query(
      `insert into competition_host_applications (gaming_member_id, state, venue_name, city_area, playing_fields, venue_description, expected_window, expected_team_count,
         confirm_all_adults, confirm_independent_scorekeepers, confirm_pilot_exclusions, decided_by_gaming_member_id, decided_at)
       values ($1, 'APPROVED', 'Fictional venue', 'Fictional area', 2, 'A fictional venue used only by a contract test and removed when it ends.', 'a weekend', 4, true, true, true, $1, now())
       returning host_application_id`, [member])).rows[0].host_application_id as string;
    await run.query(
      `insert into competition_host_capabilities (host_application_id, gaming_member_id, state, competition_id, granted_by_gaming_member_id, consumed_at, revoked_at, revoked_by_gaming_member_id, revoke_reason)
       values ($1, $2, 'REVOKED', $3, $2, now(), now(), $2, 'Revoked by a contract test.')`, [application, member, competition.competitionId]);
    return { application };
  } finally {
    if (!db) await run.end().catch(() => {});
  }
}
/** Removes the fixture the revocation tests committed (the harness cleanup removes the capability by competition, but the application it references is the test's own). */
async function removeHostFixture(competition: LifetimeTestCompetition, application: string): Promise<void> {
  const db = new Client({ connectionString: h.dbUrl });
  await db.connect();
  try {
    await db.query("set session_replication_role = replica");
    await db.query("delete from competition_host_capabilities where competition_id = $1", [competition.competitionId]);
    await db.query("delete from competition_host_applications where host_application_id = $1", [application]);
  } finally {
    await db.end().catch(() => {});
  }
}

// =============================================================================================================================================
describe("[1] organizer decisions raced against each other and against the team's own operations", () => {
  it("two decisions on one entry: whoever arrives first decides, the other gets its own coded refusal, and exactly one decision is recorded — in every order", async () => {
    const cases: Array<[string, Array<[string, string | null]>, string, string, string[]]> = [
      ["approve then reject", [["APPROVE", null], ["REJECT", REASON]], "LIFETIME_ENTRY_NOT_PENDING", "ACCEPTED", ["APPROVED"]],
      ["reject then approve", [["REJECT", REASON], ["APPROVE", null]], "LIFETIME_ENTRY_NOT_PENDING", "REJECTED", ["REJECTED"]],
      ["approve then approve", [["APPROVE", null], ["APPROVE", null]], "LIFETIME_ENTRY_NOT_PENDING", "ACCEPTED", ["APPROVED"]],
      ["reject then reject", [["REJECT", REASON], ["REJECT", "RULE_VIOLATION"]], "LIFETIME_ENTRY_NOT_PENDING", "REJECTED", ["REJECTED"]],
    ];
    for (const [label, [first, second], refusal, status, kinds] of cases) {
      const s = await scenario(`Race2${label.replace(/\W/g, "")}`);
      const outcomes = await arrivingInOrder(s.competition.competitionId, [
        () => settle("decide_lifetime_competition_entry_atomically", decideArgs(s.competition, s.entry.entryId, s.competition.organizer, first[0], first[1])),
        () => settle("decide_lifetime_competition_entry_atomically", decideArgs(s.competition, s.entry.entryId, s.competition.organizer, second[0], second[1])),
      ], label);
      onlyCodedRefusals(outcomes);
      expect(outcomes.map((o) => o.ok), label).toEqual([true, false]);
      expect(refusalOf(outcomes[1]), label).toBe(refusal);
      expect((await entryRow(s.entry.entryId)).status, label).toBe(status);
      expect(await decisionKinds(s.entry.entryId), `${label}: one decision, the first`).toEqual(kinds);
    }
    // an accepted entry removed twice: the second removal finds nothing to remove
    const s = await scenario("Race2RemoveTwice");
    await h.decideEntry(s.competition, s.entry.entryId, "APPROVE");
    const outcomes = await arrivingInOrder(s.competition.competitionId, [
      () => settle("decide_lifetime_competition_entry_atomically", decideArgs(s.competition, s.entry.entryId, s.competition.organizer, "REMOVE", REASON)),
      () => settle("decide_lifetime_competition_entry_atomically", decideArgs(s.competition, s.entry.entryId, s.competition.organizer, "REMOVE", "RULE_VIOLATION")),
    ], "remove twice");
    onlyCodedRefusals(outcomes);
    expect(outcomes.map((o) => o.ok)).toEqual([true, false]);
    expect(refusalOf(outcomes[1])).toBe("LIFETIME_ENTRY_NOT_ACCEPTED");
    expect(await decisionKinds(s.entry.entryId)).toEqual(["APPROVED", "REMOVED"]);
    expect((await rawQuery("select reason_code from competition_lifetime_entry_decisions where competition_team_id = $1 and decision = 'REMOVED'", [s.entry.entryId]))[0].reason_code, "the first removal's reason").toBe(REASON);
  });

  it("a decision racing with the team's own withdrawal (the withdrawal locks the team first, the competition second): no deadlock, the order decides, the record shows exactly what happened", async () => {
    const cases: Array<[string, "withdraw-first" | "decide-first", string, string[], string | null]> = [
      // [label, order, decision, expected decision kinds, the second racer's refusal]
      ["approve vs withdraw (withdraw first)", "withdraw-first", "APPROVE", ["WITHDRAWN"], "LIFETIME_ENTRY_NOT_PENDING"],
      ["approve vs withdraw (approve first)", "decide-first", "APPROVE", ["APPROVED", "WITHDRAWN"], null], // the team may still withdraw an accepted entry
      ["reject vs withdraw (withdraw first)", "withdraw-first", "REJECT", ["WITHDRAWN"], "LIFETIME_ENTRY_NOT_PENDING"],
      ["reject vs withdraw (reject first)", "decide-first", "REJECT", ["REJECTED"], "LIFETIME_ENTRY_NOT_LIVE"],
    ];
    for (const [label, order, decision, kinds, refusal] of cases) {
      const s = await scenario(`Race1W${label.replace(/\W/g, "").slice(0, 24)}`);
      const decide = () => settle("decide_lifetime_competition_entry_atomically", decideArgs(s.competition, s.entry.entryId, s.competition.organizer, decision, decision === "REJECT" ? REASON : null));
      const withdraw = () => settle("withdraw_lifetime_competition_entry_atomically", withdrawArgs(s.entry.entryId, s.team.captain));
      const outcomes = await arrivingInOrder(s.competition.competitionId, order === "withdraw-first" ? [withdraw, decide] : [decide, withdraw], label);
      onlyCodedRefusals(outcomes);
      if (refusal) {
        expect(outcomes.map((o) => o.ok), label).toEqual([true, false]);
        expect(refusalOf(outcomes[1]), label).toBe(refusal);
      } else {
        expect(outcomes.map((o) => o.ok), label).toEqual([true, true]);
      }
      expect(await decisionKinds(s.entry.entryId), label).toEqual(kinds);
      const finalRow = await entryRow(s.entry.entryId);
      expect(finalRow.status, `${label}: the entry ended REJECTED when anyone withdrew or rejected it, ACCEPTED only when nobody did`).toBe(kinds.includes("WITHDRAWN") || kinds.includes("REJECTED") ? "REJECTED" : "ACCEPTED");
      expect(await countOf("select count(*)::int n from competition_lifetime_roster_claims where competition_team_id = $1 and status in ('PROPOSED', 'ACCEPTED')", [s.entry.entryId]), `${label}: no live claim on a rejected entry`).toBe(0);
    }
  });

  it("a person's acceptance racing with the organizer's rejection of the entry: either the place is released with the entry or the acceptance is refused — never a claim left live on a rejected entry", async () => {
    for (const order of ["accept-first", "reject-first"] as const) {
      const s = await scenario(`Race1Claim${order.slice(0, 6)}`, 6);
      const [subject] = s.team.members;
      const [proposed] = await rpc("propose_lifetime_entry_roster_claims_atomically", { p_competition_team_id: s.entry.entryId, p_actor_gaming_member_id: id(s.team.captain), p_gaming_member_ids: [id(subject)] });
      await h.register(s.competition, subject);
      const accept = () => settle("decide_lifetime_entry_roster_claim_atomically", claimDecision(proposed.competition_lifetime_roster_claim_id, subject));
      const reject = () => settle("decide_lifetime_competition_entry_atomically", decideArgs(s.competition, s.entry.entryId, s.competition.organizer, "REJECT", REASON));
      const outcomes = await arrivingInOrder(s.competition.competitionId, order === "accept-first" ? [accept, reject] : [reject, accept], order);
      onlyCodedRefusals(outcomes);
      const [claim] = await claimsOf(s.entry.entryId);
      expect((await entryRow(s.entry.entryId)).status, order).toBe("REJECTED");
      expect(await countOf("select count(*)::int n from competition_lifetime_roster_claims where competition_team_id = $1 and status in ('PROPOSED', 'ACCEPTED')", [s.entry.entryId]), `${order}: no live claim on a rejected entry`).toBe(0);
      if (order === "accept-first") {
        expect(outcomes.map((o) => o.ok)).toEqual([true, true]);
        expect(claim).toMatchObject({ status: "REMOVED", release_reason: "ENTRY_REJECTED_BY_ORGANIZER" }); // accepted first, then released with the entry
        expect((await decisionKinds(s.entry.entryId))).toEqual(["REJECTED"]);
        expect(Number((await rawQuery("select released_claims from competition_lifetime_entry_decisions where competition_team_id = $1", [s.entry.entryId]))[0].released_claims)).toBe(1);
      } else {
        expect(outcomes.map((o) => o.ok)).toEqual([true, false]);
        expect(refusalOf(outcomes[1]), "the late acceptance is a coded refusal").toMatch(/^LIFETIME_(CLAIM_NOT_OPEN|ENTRY_NOT_LIVE)$/);
        expect(claim).toMatchObject({ status: "WITHDRAWN", release_reason: "ENTRY_REJECTED_BY_ORGANIZER" }); // released as a proposal before the person could accept
      }
    }
  });
});

// =============================================================================================================================================
describe("[2] the freeze raced against the organizer's decisions", () => {
  it("rejecting the last pending entry and freezing, in both orders: the freeze waits for the decision it needs, and refuses without it — it never counts the pending entry", async () => {
    // after the deadline a pending entry cannot be approved, but it CAN be rejected: that is how it stops blocking the freeze
    const reject = (s: Awaited<ReturnType<typeof threeEntries>>) => () => settle("decide_lifetime_competition_entry_atomically", decideArgs(s.competition, s.teams[2].entry.entryId, s.competition.organizer, "REJECT", "COMPETITION_CAPACITY"));
    const freeze = (s: Awaited<ReturnType<typeof threeEntries>>) => () => settle("freeze_lifetime_competition_entries_atomically", freezeArgs(s.competition));

    const first = await threeEntries("Race2RejectFirst");
    await h.passDeadline(first.competition.competitionId);
    const rejectFirst = await arrivingInOrder(first.competition.competitionId, [reject(first), freeze(first)], "reject then freeze");
    onlyCodedRefusals(rejectFirst);
    expect(rejectFirst.map((o) => o.ok)).toEqual([true, true]);
    expect(rejectFirst[1].ok && rejectFirst[1].rows[0]).toMatchObject({ entry_count: 2, claim_count: 10, already_frozen: false });
    expect(await decisionKinds(first.teams[2].entry.entryId)).toEqual(["REJECTED"]);

    const second = await threeEntries("Race2FreezeFirst");
    await h.passDeadline(second.competition.competitionId);
    const freezeFirst = await arrivingInOrder(second.competition.competitionId, [freeze(second), reject(second)], "freeze then reject");
    onlyCodedRefusals(freezeFirst);
    expect(freezeFirst.map((o) => o.ok)).toEqual([false, true]);
    expect(refusalOf(freezeFirst[0])).toBe("LIFETIME_FREEZE_PENDING_ENTRIES");
    expect(await countOf("select count(*)::int n from competition_lifetime_freezes where competition_id = $1", [second.competition.competitionId]), "the refused freeze recorded nothing").toBe(0);
    // the decision it was waiting for is made; the freeze now succeeds with exactly the accepted entries
    expect(await one("freeze_lifetime_competition_entries_atomically", freezeArgs(second.competition))).toMatchObject({ entry_count: 2, claim_count: 10, already_frozen: false });
  });

  it("decisions queued behind a freeze find it: each is refused with LIFETIME_ENTRIES_FROZEN and changes nothing; a removal after the deadline never happened, so the freeze counts the entry", async () => {
    const s = await threeEntries("Race2Frozen");
    await h.decideEntry(s.competition, s.teams[2].entry.entryId, "REJECT", { reason: "COMPETITION_CAPACITY" }); // C is decided before the deadline; A and B are accepted
    await h.passDeadline(s.competition.competitionId);
    const decide = (entryId: string, decision: string, reason: string | null = null) => () => settle("decide_lifetime_competition_entry_atomically", decideArgs(s.competition, entryId, s.competition.organizer, decision, reason));
    const outcomes = await arrivingInOrder(s.competition.competitionId, [
      () => settle("freeze_lifetime_competition_entries_atomically", freezeArgs(s.competition)),
      decide(s.teams[0].entry.entryId, "REMOVE", REASON),
      decide(s.teams[1].entry.entryId, "REJECT", REASON),
      decide(s.teams[2].entry.entryId, "APPROVE"),
    ], "freeze then decisions");
    onlyCodedRefusals(outcomes);
    expect(outcomes[0].ok).toBe(true);
    expect(outcomes.slice(1).map(refusalOf)).toEqual(["LIFETIME_ENTRIES_FROZEN", "LIFETIME_ENTRIES_FROZEN", "LIFETIME_ENTRIES_FROZEN"]);
    expect((await entryRow(s.teams[0].entry.entryId)).status).toBe("ACCEPTED");
    expect(await decisionKinds(s.teams[0].entry.entryId)).toEqual(["APPROVED"]);

    // and the other order: a removal that arrives BEFORE the freeze but AFTER the deadline is refused (registration is closed), so the entry stays and the freeze counts it
    const t = await threeEntries("Race2RemoveLate");
    await h.decideEntry(t.competition, t.teams[2].entry.entryId, "REJECT", { reason: "COMPETITION_CAPACITY" });
    await h.passDeadline(t.competition.competitionId);
    const late = await arrivingInOrder(t.competition.competitionId, [
      () => settle("decide_lifetime_competition_entry_atomically", decideArgs(t.competition, t.teams[0].entry.entryId, t.competition.organizer, "REMOVE", REASON)),
      () => settle("freeze_lifetime_competition_entries_atomically", freezeArgs(t.competition)),
    ], "late removal then freeze");
    onlyCodedRefusals(late);
    expect(refusalOf(late[0])).toBe("TEAM_REGISTRATION_NOT_OPEN");
    expect(late[1].ok && late[1].rows[0]).toMatchObject({ entry_count: 2, claim_count: 10 });
    expect((await entryRow(t.teams[0].entry.entryId)).status).toBe("ACCEPTED");
  });
});

// =============================================================================================================================================
describe("[3] the recovery raced against entry creation and V1 team creation", () => {
  it("recovery against entering a team, in both orders: the flow is never switched off while an entry exists", async () => {
    for (const order of ["disable-first", "enter-first"] as const) {
      const competition = await h.setUpCompetition(`Race3Enter${order.slice(0, 7)}`);
      const team = await h.buildTeam(`Race3Enter${order.slice(0, 7)}T`, 5);
      await h.register(competition, team.captain);
      const disable = () => settle("disable_lifetime_entry_flow_atomically", disableArgs(competition));
      const enter = () => settle("enter_lifetime_team_into_competition_atomically", enterArgs(competition, team));
      const outcomes = await arrivingInOrder(competition.competitionId, order === "disable-first" ? [disable, enter] : [enter, disable], order);
      onlyCodedRefusals(outcomes);
      const entries = await countOf("select count(*)::int n from competition_teams where competition_id = $1 and entry_flow = 'LIFETIME'", [competition.competitionId]);
      const flows = await flowCount(competition.competitionId);
      expect(entries === 0 || flows === 1, `${order}: never the flow off with an entry on record`).toBe(true);
      if (order === "disable-first") {
        expect(outcomes.map((o) => o.ok)).toEqual([true, false]);
        expect(refusalOf(outcomes[1])).toBe("LIFETIME_FLOW_NOT_ENABLED");
        expect({ entries, flows, events: await flowEvents(competition.competitionId) }).toEqual({ entries: 0, flows: 0, events: ["ENABLED", "DISABLED"] });
      } else {
        expect(outcomes.map((o) => o.ok)).toEqual([true, false]);
        expect(refusalOf(outcomes[1])).toBe("LIFETIME_FLOW_RECOVERY_BLOCKED");
        expect({ entries, flows, events: await flowEvents(competition.competitionId) }).toEqual({ entries: 1, flows: 1, events: ["ENABLED"] });
      }
    }
  });

  it("recovery against a V1 team being added, in both orders: V1 never gets a team while the flow is on, and the flow is never on beside a V1 team", async () => {
    for (const order of ["disable-first", "add-first"] as const) {
      const competition = await h.setUpCompetition(`Race3V1${order.slice(0, 7)}`);
      const [captain] = await h.newPeople(1, `Race3V1Captain${order.slice(0, 3)}`);
      const disable = () => settle("disable_lifetime_entry_flow_atomically", disableArgs(competition));
      const add = () => settle("add_competition_team_atomically", { p_competition_id: competition.competitionId, p_organizer_gaming_member_id: id(competition.organizer), p_name: h.uniqueName("Race3 V1"), p_captain_gaming_member_id: id(captain), p_public_code: publicCode() });
      const outcomes = await arrivingInOrder(competition.competitionId, order === "disable-first" ? [disable, add] : [add, disable], order);
      onlyCodedRefusals(outcomes);
      const v1Teams = await countOf("select count(*)::int n from competition_teams where competition_id = $1 and entry_flow = 'V1'", [competition.competitionId]);
      const flows = await flowCount(competition.competitionId);
      expect(v1Teams === 0 || flows === 0, `${order}: never a V1 team beside the flow`).toBe(true);
      if (order === "disable-first") {
        expect(outcomes.map((o) => o.ok)).toEqual([true, true]);
        expect({ v1Teams, flows }).toEqual({ v1Teams: 1, flows: 0 });
      } else {
        expect(outcomes.map((o) => o.ok)).toEqual([false, true]);
        expect(refusalOf(outcomes[0])).toBe("TEAM_REGISTRATION_NOT_OPEN");
        expect({ v1Teams, flows }).toEqual({ v1Teams: 0, flows: 0 });
      }
    }
  });
});

// =============================================================================================================================================
describe("[4] organizer revocation racing with a decision or the recovery", () => {
  it("a revocation that commits while a decision waits for the competition lock is seen by it: HOST_ACCESS_REVOKED, and nothing changes", async () => {
    const s = await scenario("Race4Decide");
    let fixture: { application: string } | null = null;
    try {
      const outcomes = await arrivingInOrder(s.competition.competitionId, [
        () => settle("decide_lifetime_competition_entry_atomically", decideArgs(s.competition, s.entry.entryId, s.competition.organizer, "APPROVE")),
      ], "decision waiting for a revocation", async (db) => { fixture = await revokeHostCommitted(s.competition, db); });
      onlyCodedRefusals(outcomes);
      expect(refusalOf(outcomes[0])).toBe("HOST_ACCESS_REVOKED");
      expect((await entryRow(s.entry.entryId)).status).toBe("PENDING_ORGANIZER_APPROVAL");
      expect(await decisionKinds(s.entry.entryId)).toEqual([]);
      // and every kind of decision stays refused afterwards
      for (const [decision, reason] of [["APPROVE", null], ["REJECT", REASON]] as const) {
        const again = await settle("decide_lifetime_competition_entry_atomically", decideArgs(s.competition, s.entry.entryId, s.competition.organizer, decision, reason));
        expect(refusalOf(again), decision).toBe("HOST_ACCESS_REVOKED");
      }
    } finally {
      if (fixture) await removeHostFixture(s.competition, (fixture as { application: string }).application);
    }
  });

  it("a decision that wins the lock before the revocation stands as it was recorded; every decision after the revocation is refused, the removal included", async () => {
    const s = await scenario("Race4First");
    await h.decideEntry(s.competition, s.entry.entryId, "APPROVE"); // the organizer was active when it took the lock
    const fixture = await revokeHostCommitted(s.competition);
    try {
      const removal = await settle("decide_lifetime_competition_entry_atomically", decideArgs(s.competition, s.entry.entryId, s.competition.organizer, "REMOVE", REASON));
      expect(refusalOf(removal)).toBe("HOST_ACCESS_REVOKED");
      expect((await entryRow(s.entry.entryId)).status, "the earlier approval stands").toBe("ACCEPTED");
      expect(await decisionKinds(s.entry.entryId)).toEqual(["APPROVED"]);
    } finally {
      await removeHostFixture(s.competition, fixture.application);
    }
  });

  it("a revocation that commits while the recovery waits is seen by it: HOST_ACCESS_REVOKED, and the switch row stays", async () => {
    const competition = await h.setUpCompetition("Race4Disable");
    let fixture: { application: string } | null = null;
    try {
      const outcomes = await arrivingInOrder(competition.competitionId, [() => settle("disable_lifetime_entry_flow_atomically", disableArgs(competition))],
        "recovery waiting for a revocation", async (db) => { fixture = await revokeHostCommitted(competition, db); });
      onlyCodedRefusals(outcomes);
      expect(refusalOf(outcomes[0])).toBe("HOST_ACCESS_REVOKED");
      expect(await flowCount(competition.competitionId)).toBe(1);
      expect(await flowEvents(competition.competitionId)).toEqual(["ENABLED"]);
    } finally {
      if (fixture) await removeHostFixture(competition, (fixture as { application: string }).application);
    }
  });
});

// =============================================================================================================================================
describe("[5] the decision record and the entry guard", () => {
  it("never lets a decision be rewritten: no update, delete or truncate — and a row whose shape contradicts its kind, or whose entry is not its own, is refused by the table itself", async () => {
    const s = await scenario("Audit5");
    await h.decideEntry(s.competition, s.entry.entryId, "REJECT", { reason: REASON, note: "recorded" });
    const [decision] = await rawQuery("select * from competition_lifetime_entry_decisions where competition_team_id = $1", [s.entry.entryId]);
    for (const sql of [
      "update competition_lifetime_entry_decisions set note = 'rewritten' where decision_id = $1",
      "update competition_lifetime_entry_decisions set decided_by_gaming_member_id = decided_by_gaming_member_id where decision_id = $1",
      "update competition_lifetime_entry_decisions set decided_at = decided_at - interval '1 day' where decision_id = $1",
      "delete from competition_lifetime_entry_decisions where decision_id = $1",
    ]) expect((await violation(sql, [decision.decision_id]))?.message, sql).toMatch(/^LIFETIME_INVARIANT_VIOLATION:/);
    expect((await violation("truncate competition_lifetime_entry_decisions"))?.message).toMatch(/^LIFETIME_INVARIANT_VIOLATION:/);
    expect(await rawQuery("select * from competition_lifetime_entry_decisions where decision_id = $1", [decision.decision_id]), "nothing changed").toEqual([decision]);

    // the shape: a valid row passes (inside a rolled-back transaction), and each single defect is refused by its own constraint
    const other = await scenario("Audit5Other");
    const base = { competition: s.competition.competitionId, entry: s.entry.entryId, team: s.team.teamId, by: id(s.competition.organizer) };
    const insert = (over: Record<string, unknown> = {}) => {
      const v = { competition_id: base.competition, competition_team_id: base.entry, lifetime_team_id: base.team, decision: "REJECTED", decided_by_role: "ORGANIZER", decided_by_gaming_member_id: base.by, reason_code: REASON, note: null,
        previous_status: "PENDING_ORGANIZER_APPROVAL", new_status: "REJECTED", released_claims: 0, decided_at: new Date().toISOString(), ...over };
      return [`insert into competition_lifetime_entry_decisions (${Object.keys(v).join(", ")}) values (${Object.keys(v).map((_, i) => `$${i + 1}`).join(", ")})`, Object.values(v)] as [string, unknown[]];
    };
    const outcome = async (over: Record<string, unknown>) => rawTransaction(async (db) => {
      const [sql, params] = insert(over);
      try { await db.query(sql, params); return null; } catch (err) { return { code: (err as { code?: string }).code, constraint: (err as { constraint?: string }).constraint }; }
    });
    expect(await outcome({}), "a well-formed row is accepted (so every refusal below is about its one defect)").toBeNull();
    const defects: Array<[string, Record<string, unknown>, string]> = [
      ["an approval that carries a reason", { decision: "APPROVED", new_status: "ACCEPTED", reason_code: REASON }, "competition_lifetime_entry_decisions_shape"],
      ["a rejection without a reason", { reason_code: null }, "competition_lifetime_entry_decisions_shape"],
      ["a removal of an entry that was pending", { decision: "REMOVED", previous_status: "PENDING_ORGANIZER_APPROVAL" }, "competition_lifetime_entry_decisions_shape"],
      ["a withdrawal made by the organizer", { decision: "WITHDRAWN", reason_code: null }, "competition_lifetime_entry_decisions_shape"],
      ["a reason outside the bounded list", { reason_code: "BECAUSE_I_SAY_SO" }, "competition_lifetime_entry_decisions_reason_check"],
      ["a note that is not normalized", { note: " padded " }, "competition_lifetime_entry_decisions_note_check"],
      ["a note longer than 280 characters", { note: "x".repeat(281) }, "competition_lifetime_entry_decisions_note_check"],
      ["a negative count of released claims", { released_claims: -1 }, "competition_lifetime_entry_decisions_claims_check"],
      ["an unknown kind of decision", { decision: "PARDONED" }, "competition_lifetime_entry_decisions_decision_check"],
      ["an unknown role", { decided_by_role: "ADMIN" }, "competition_lifetime_entry_decisions_role_check"],
    ];
    for (const [label, over, constraint] of defects) expect(await outcome(over), label).toMatchObject({ code: "23514", constraint });
    expect(await outcome({ competition_id: other.competition.competitionId }), "an entry cannot be decided in a competition that is not its own").toMatchObject({ code: "23503", constraint: "competition_lifetime_entry_decisions_entry_fkey" });
    expect(await outcome({ lifetime_team_id: other.team.teamId }), "nor for a team that is not its own").toMatchObject({ code: "23503", constraint: "competition_lifetime_entry_decisions_entry_fkey" });
    expect(await outcome({ decided_by_gaming_member_id: "00000000-0000-4000-8000-000000000000" }), "nor by nobody").toMatchObject({ code: "23503" });
  });

  it("moves an entry's status only along the transitions the guard allows, each only inside its own operation: the whole matrix, every start, every target, every mark", async () => {
    const competition = await h.setUpCompetition("Matrix5");
    const starts: Record<string, string> = {};
    for (const label of ["PENDING_ORGANIZER_APPROVAL", "ACCEPTED", "REJECTED"]) {
      const team = await h.buildTeam(`Matrix5${label.slice(0, 3)}`, 5);
      const entry = await h.enterTeam(competition, team);
      if (label === "ACCEPTED") await h.decideEntry(competition, entry.entryId, "APPROVE");
      if (label === "REJECTED") await h.decideEntry(competition, entry.entryId, "REJECT", { reason: REASON });
      starts[label] = entry.entryId;
    }
    const marks = ["", "enter", "off", "on", "approve", "reject", "remove"];
    const allowed = new Set(["PENDING_ORGANIZER_APPROVAL>ACCEPTED:approve", "PENDING_ORGANIZER_APPROVAL>REJECTED:on", "PENDING_ORGANIZER_APPROVAL>REJECTED:reject", "ACCEPTED>REJECTED:on", "ACCEPTED>REJECTED:remove"]);
    const organizer = id(competition.organizer);
    const observed = await rawTransaction(async (db) => {
      const results: string[] = [];
      for (const [from, entryId] of Object.entries(starts)) {
        for (const to of ["PENDING_ORGANIZER_APPROVAL", "ACCEPTED", "REJECTED"]) {
          if (to === from) continue;
          for (const mark of marks) {
            await db.query("savepoint attempt");
            try {
              if (mark) await db.query("select set_config('urbano.lifetime_entry_transition', $1, true)", [mark]);
              await db.query(
                "update competition_teams set status = $2, decided_at = case when $2 = 'PENDING_ORGANIZER_APPROVAL' then null else now() end, decided_by_gaming_member_id = case when $2 = 'PENDING_ORGANIZER_APPROVAL' then null else $3::uuid end, rejection_reason = case when $2 = 'REJECTED' then 'ENTRY_REJECTED_BY_ORGANIZER' else null end where competition_team_id = $1",
                [entryId, to, organizer]);
              results.push(`${from}>${to}:${mark}`);
            } catch {
              /* refused, as it should be for every combination outside the matrix */
            }
            await db.query("rollback to savepoint attempt");
          }
        }
      }
      return results;
    });
    expect([...observed].sort(), "exactly the five allowed (start, target, mark) combinations succeed; every other combination is refused").toEqual([...allowed].sort());
    // ... and without any mark nothing moves at all
    for (const [from, entryId] of Object.entries(starts)) expect((await entryRow(entryId)).status, "the matrix ran in a rolled-back transaction").toBe(from);
  });

  it("refuses a change of an entry's snapshot, its identity or its flow, with or without a mark", async () => {
    const s = await scenario("Snapshot5");
    for (const sql of [
      "update competition_teams set name = 'Renamed' where competition_team_id = $1",
      "update competition_teams set captain_gaming_member_id = sub_captain_gaming_member_id where competition_team_id = $1",
      "update competition_teams set entry_flow = 'V1' where competition_team_id = $1",
      "update competition_teams set lifetime_team_id = null where competition_team_id = $1",
      "update competition_teams set decided_at = now() where competition_team_id = $1",
      "update competition_teams set rejection_reason = 'ENTRY_REJECTED_BY_ORGANIZER' where competition_team_id = $1",
      "delete from competition_teams where competition_team_id = $1",
    ]) expect((await violation(sql, [s.entry.entryId]))?.message, sql).toMatch(/^(LIFETIME_INVARIANT_VIOLATION|TEAM_REGISTRATION_NOT_OPEN):/);
    expect((await entryRow(s.entry.entryId)).status).toBe("PENDING_ORGANIZER_APPROVAL");
  });
});

// =============================================================================================================================================
describe("[6] the catalog: privileges, row-level security and triggers of the new objects", () => {
  it("has row-level security, no policy, no browser privilege and a read-only service role on both audit tables, and closed sequences", async () => {
    const rows = await rawQuery(
      `select c.relname, c.relrowsecurity as rls, (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies,
              has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') as anon_any, has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') as auth_any,
              has_table_privilege('public', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') as public_any,
              has_table_privilege('service_role', c.oid, 'SELECT') as service_select, has_table_privilege('service_role', c.oid, 'INSERT') as service_insert,
              has_table_privilege('service_role', c.oid, 'UPDATE') as service_update, has_table_privilege('service_role', c.oid, 'DELETE') as service_delete,
              has_table_privilege('service_role', c.oid, 'TRUNCATE') as service_truncate, has_table_privilege('service_role', c.oid, 'REFERENCES') as service_references
         from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname in ('competition_lifetime_entry_decisions', 'competition_lifetime_flow_events') order by c.relname`);
    expect(rows.map((r) => r.relname)).toEqual(["competition_lifetime_entry_decisions", "competition_lifetime_flow_events"]);
    for (const r of rows) {
      expect(r, r.relname).toMatchObject({ rls: true, policies: 0, anon_any: false, auth_any: false, public_any: false, service_select: true, service_insert: false, service_update: false, service_delete: false, service_truncate: false, service_references: false });
    }
  });

  it("makes the two new operations executable by the server role only, and the two trigger functions by nobody", async () => {
    const rows = await rawQuery(
      `select p.proname, p.prosecdef, p.proconfig::text as cfg, has_function_privilege('service_role', p.oid, 'EXECUTE') as service_x, has_function_privilege('anon', p.oid, 'EXECUTE') as anon_x,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_x,
              (select count(*)::int from pg_proc q, aclexplode(coalesce(q.proacl, acldefault('f', q.proowner))) a where q.oid = p.oid and a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_x
         from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname in ('decide_lifetime_competition_entry_atomically', 'disable_lifetime_entry_flow_atomically', 'competition_lifetime_flows_row_guard', 'competition_lifetime_entry_v1_path_guard') order by p.proname`);
    expect(rows.map((r) => r.proname)).toEqual(["competition_lifetime_entry_v1_path_guard", "competition_lifetime_flows_row_guard", "decide_lifetime_competition_entry_atomically", "disable_lifetime_entry_flow_atomically"]);
    for (const r of rows) {
      expect(r, r.proname).toMatchObject({ prosecdef: true, anon_x: false, auth_x: false, public_x: 0 });
      expect(r.cfg, r.proname).toMatch(/search_path/);
      expect(r.service_x, r.proname).toBe(/_atomically$/.test(r.proname));
    }
  });

  it("installs each guard where the migration says, enabled: V1 join requests and memberships, both audit tables, and the switch row", async () => {
    const triggers = await rawQuery(
      `select c.relname, t.tgname, t.tgenabled, (t.tgtype & 1) = 1 as per_row, (t.tgtype & 2) = 2 as before_event, (t.tgtype & 4) = 4 as on_insert, (t.tgtype & 8) = 8 as on_delete, (t.tgtype & 16) = 16 as on_update,
              (t.tgtype & 32) = 32 as on_truncate, p.proname as fn
         from pg_trigger t join pg_class c on c.oid = t.tgrelid join pg_proc p on p.oid = t.tgfoid
        where not t.tgisinternal and c.relnamespace = 'public'::regnamespace
          and c.relname in ('competition_join_requests', 'competition_team_memberships', 'competition_lifetime_entry_decisions', 'competition_lifetime_flow_events', 'competition_lifetime_flows')
          and t.tgname ~ '(lifetime)' order by c.relname, t.tgname`);
    const by = (name: string) => triggers.find((t) => t.tgname === name);
    for (const [name, table] of [["competition_join_requests_lifetime_entry_guard", "competition_join_requests"], ["competition_team_memberships_lifetime_entry_guard", "competition_team_memberships"]]) {
      expect(by(name), name).toMatchObject({ relname: table, tgenabled: "O", per_row: true, before_event: true, on_insert: true, on_delete: false, on_update: false, fn: "competition_lifetime_entry_v1_path_guard" });
    }
    for (const table of ["competition_lifetime_entry_decisions", "competition_lifetime_flow_events"]) {
      expect(by(`${table}_history_rows`), table).toMatchObject({ relname: table, tgenabled: "O", per_row: true, before_event: true, on_update: true, on_delete: true, on_insert: false, fn: "lifetime_history_guard" });
      expect(by(`${table}_history_truncate`), table).toMatchObject({ relname: table, tgenabled: "O", per_row: false, before_event: true, on_truncate: true, fn: "lifetime_history_guard" });
    }
    expect(by("competition_lifetime_flows_row_guard"), "the switch row's guard").toMatchObject({ relname: "competition_lifetime_flows", tgenabled: "O", per_row: true, before_event: true, on_update: true, on_delete: true, on_insert: false, fn: "competition_lifetime_flows_row_guard" });
    expect(by("competition_lifetime_flows_history_rows"), "the old unconditional row guard is gone").toBeUndefined();
    expect(by("competition_lifetime_flows_history_truncate"), "the flow table still cannot be truncated").toMatchObject({ on_truncate: true, tgenabled: "O" });
  });

  it("widened the two CHECKs it had to widen, and only those: the team events and the claim release reasons", async () => {
    const defs = await rawQuery("select conname, pg_get_constraintdef(oid) as def from pg_constraint where conname in ('lifetime_team_events_type_check', 'competition_lifetime_roster_claims_release_reason_check') order by conname");
    expect(defs).toHaveLength(2);
    expect(defs[1].def).toMatch(/ENTRY_APPROVED.*ENTRY_REJECTED.*ENTRY_REMOVED/s);
    expect(defs[0].def).toMatch(/ENTRY_REJECTED_BY_ORGANIZER.*ENTRY_REMOVED_BY_ORGANIZER/s);
    expect(defs[0].def, "the foundation's reasons are all still accepted").toMatch(/ENTRY_WITHDRAWN/);
  });
});

// =============================================================================================================================================
describe("[7] mutation controls: the probes above can fail", () => {
  /**
   * Inside a transaction that is ALWAYS rolled back, replaces `edits` (each text must occur exactly once — a control that finds nothing to mutate must fail loudly, not pass
   * silently) in the live definition of `signature`, then runs `probe` in the same transaction. The mutated definition never outlives the transaction.
   */
  async function mutated<T>(signature: string, edits: Array<[string, string]>, probe: (db: Client) => Promise<T>): Promise<T> {
    return rawTransaction(async (db) => {
      let definition = (await db.query("select pg_get_functiondef($1::regprocedure) as def", [signature])).rows[0].def as string;
      for (const [from, to] of edits) {
        if (definition.split(from).length !== 2) throw new Error(`the mutation target must occur exactly once in ${signature}: ${from.slice(0, 70)}`);
        definition = definition.replace(from, to);
      }
      await db.query(definition);
      return probe(db);
    });
  }
  const call = async (db: Client, sql: string, params: unknown[]) => {
    await db.query("savepoint probe");
    try {
      const result = await db.query(sql, params);
      await db.query("release savepoint probe");
      return { ok: true as const, rows: result.rows };
    } catch (err) {
      await db.query("rollback to savepoint probe");
      return { ok: false as const, message: (err as Error).message };
    }
  };

  it("[mutation 1] a freeze that counts PENDING entries: with the pending refusal and the accepted-only count removed, the freeze goes through and counts the pending entry — the probes that expect a refusal and a count of two are sensitive to exactly those rules", async () => {
    const s = await threeEntries("Mut1");
    await h.passDeadline(s.competition.competitionId);
    const sql = "select * from freeze_lifetime_competition_entries_atomically($1::uuid, $2::uuid)";
    const args = [s.competition.competitionId, id(s.competition.organizer)];
    // the real operation refuses (the probe the suites rely on)
    expect(refusalOf(await settle("freeze_lifetime_competition_entries_atomically", freezeArgs(s.competition)))).toBe("LIFETIME_FREEZE_PENDING_ENTRIES");
    // mutation 1a: only the refusal removed — the freeze would now succeed with the pending entry still pending
    const refusalGone = await mutated("freeze_lifetime_competition_entries_atomically(uuid, uuid)", [["e.status = 'PENDING_ORGANIZER_APPROVAL') then", "e.status = 'NO_SUCH_STATUS') then"]], (db) => call(db, sql, args));
    expect(refusalGone.ok, "without the refusal the freeze succeeds although an entry is pending").toBe(true);
    // mutation 1b: the refusal removed AND pending entries counted — the wrong count is observable
    const counted = await mutated("freeze_lifetime_competition_entries_atomically(uuid, uuid)", [
      ["e.status = 'PENDING_ORGANIZER_APPROVAL') then", "e.status = 'NO_SUCH_STATUS') then"],
      ["into v_entries from competition_teams e where e.competition_id = p_competition_id and e.entry_flow = 'LIFETIME' and e.status = 'ACCEPTED';", "into v_entries from competition_teams e where e.competition_id = p_competition_id and e.entry_flow = 'LIFETIME' and e.status <> 'REJECTED';"],
    ], (db) => call(db, sql, args));
    expect(counted.ok && counted.rows[0].entry_count, "with pending entries counted the frozen entry count is wrong").toBe(3);
    // and nothing leaked out of the rolled-back transactions
    expect(await countOf("select count(*)::int n from competition_lifetime_freezes where competition_id = $1", [s.competition.competitionId])).toBe(0);
    expect(refusalOf(await settle("freeze_lifetime_competition_entries_atomically", freezeArgs(s.competition)))).toBe("LIFETIME_FREEZE_PENDING_ENTRIES");
  });

  it("[mutation 2] a decision that does not check the organizer's hosting access: a REVOKED organizer would approve — the revocation probe is sensitive to that one line", async () => {
    const s = await scenario("Mut2");
    const sql = "select * from decide_lifetime_competition_entry_atomically($1::uuid, $2::uuid, $3::uuid, 'APPROVE', null, null)";
    const args = [s.competition.competitionId, s.entry.entryId, id(s.competition.organizer)];
    const revoked = async (db: Client) => {
      await revokeHostCommitted(s.competition, db); // inside the mutation's own rolled-back transaction
      return call(db, sql, args);
    };
    expect((await rawTransaction(revoked)), "the real operation refuses a revoked organizer").toMatchObject({ ok: false, message: expect.stringMatching(/^HOST_ACCESS_REVOKED:/) });
    const withoutGuard = await mutated("decide_lifetime_competition_entry_atomically(uuid, uuid, uuid, text, text, text)", [["perform assert_competition_not_host_revoked(p_competition_id);", "null;"]], revoked);
    expect(withoutGuard.ok, "without the guard a revoked organizer approves").toBe(true);
    expect((await entryRow(s.entry.entryId)).status, "and it was all rolled back").toBe("PENDING_ORGANIZER_APPROVAL");
  });

  it("[mutation 3] a recovery that forgets an entry ever existed: the switch is removed while a pending, rejected or withdrawn entry stays on record — the probes for 'ever' and for 'any status' are sensitive", async () => {
    const pending = await scenario("Mut3Pending");
    const withdrawn = await scenario("Mut3Withdrawn");
    await one("withdraw_lifetime_competition_entry_atomically", withdrawArgs(withdrawn.entry.entryId, withdrawn.team.captain));
    const sql = "select * from disable_lifetime_entry_flow_atomically($1::uuid, $2::uuid)";
    const argsOf = (c: { competitionId: string; organizer: Person }) => [c.competitionId, id(c.organizer)];
    const signature = "disable_lifetime_entry_flow_atomically(uuid, uuid)";
    const legacyProbe = "exists (select 1 from competition_teams t where t.competition_id = p_competition_id)";
    const entryProbe = "exists (select 1 from competition_teams e where e.competition_id = p_competition_id and e.entry_flow = 'LIFETIME')";
    for (const [label, s] of [["pending", pending], ["withdrawn", withdrawn]] as const) {
      expect(refusalOf(await settle("disable_lifetime_entry_flow_atomically", disableArgs(s.competition))), `${label}: the real recovery refuses`).toBe("LIFETIME_FLOW_RECOVERY_BLOCKED");
    }
    // mutation 3a: the entry probe removed (and the legacy probe narrowed to legacy rows, as it would have to be): a pending entry no longer blocks
    const noEntryProbe = await mutated(signature, [[entryProbe, "false"], [legacyProbe, "exists (select 1 from competition_teams t where t.competition_id = p_competition_id and t.entry_flow <> 'LIFETIME')"]],
      async (db) => ({ result: await call(db, sql, argsOf(pending.competition)), flows: (await db.query("select count(*)::int n from competition_lifetime_flows where competition_id = $1", [pending.competition.competitionId])).rows[0].n, entries: (await db.query("select count(*)::int n from competition_teams where competition_id = $1 and entry_flow = 'LIFETIME'", [pending.competition.competitionId])).rows[0].n }));
    expect(noEntryProbe.result.ok, "without the entry probe the recovery succeeds").toBe(true);
    expect({ flows: noEntryProbe.flows, entries: noEntryProbe.entries }, "the corrupted end state: the flow is gone, the entry remains").toEqual({ flows: 0, entries: 1 });
    // mutation 3b: only LIVE entries count ("ever existed" weakened to "exists now"): a withdrawn entry no longer blocks. A withdrawal also leaves a decision record, which is a second,
    // independent blocker (defence in depth) — so the control removes that probe too, to show the PAIR is what keeps a withdrawn entry from being forgotten.
    const decisionProbe = "exists (select 1 from competition_lifetime_entry_decisions d where d.competition_id = p_competition_id)";
    const onlyLive = await mutated(signature, [[entryProbe, "exists (select 1 from competition_teams e where e.competition_id = p_competition_id and e.entry_flow = 'LIFETIME' and e.status <> 'REJECTED')"],
      [decisionProbe, "false"], [legacyProbe, "exists (select 1 from competition_teams t where t.competition_id = p_competition_id and t.entry_flow <> 'LIFETIME')"]], (db) => call(db, sql, argsOf(withdrawn.competition)));
    expect(onlyLive.ok, "if only live entries blocked, a withdrawn entry would let the recovery through").toBe(true);
    // with ONLY the live-entry weakening, the decision record still blocks: the two probes cover each other
    const stillBlocked = await mutated(signature, [[entryProbe, "exists (select 1 from competition_teams e where e.competition_id = p_competition_id and e.entry_flow = 'LIFETIME' and e.status <> 'REJECTED')"],
      [legacyProbe, "exists (select 1 from competition_teams t where t.competition_id = p_competition_id and t.entry_flow <> 'LIFETIME')"]], (db) => call(db, sql, argsOf(withdrawn.competition)));
    expect(stillBlocked.ok ? null : stillBlocked.message).toMatch(/^LIFETIME_FLOW_RECOVERY_BLOCKED:/);
    // nothing leaked
    expect(await flowCount(pending.competition.competitionId)).toBe(1);
    expect(await flowCount(withdrawn.competition.competitionId)).toBe(1);
  });

  it("[mutation 4] audit history that can be rewritten or removed: with a guard taken away the very statement the suites expect to be refused goes through — for decisions, for flow events and for the switch row", async () => {
    const s = await scenario("Mut4");
    await h.decideEntry(s.competition, s.entry.entryId, "REJECT", { reason: REASON });
    const done = await h.setUpCompetition("Mut4Flow");
    await one("disable_lifetime_entry_flow_atomically", disableArgs(done));
    const live = await h.setUpCompetition("Mut4Live");
    const probe = async (sql: string, params: unknown[], disableTrigger?: [string, string]) => rawTransaction(async (db) => {
      if (disableTrigger) await db.query(`alter table ${disableTrigger[0]} disable trigger ${disableTrigger[1]}`);
      try {
        const result = await db.query(sql, params);
        return { ok: true as const, rowCount: result.rowCount };
      } catch (err) {
        return { ok: false as const, message: (err as Error).message };
      }
    });
    const decisionUpdate = "update competition_lifetime_entry_decisions set note = 'rewritten by a mutation' where competition_team_id = $1";
    const decisionDelete = "delete from competition_lifetime_entry_decisions where competition_team_id = $1";
    const eventUpdate = "update competition_lifetime_flow_events set event_type = 'ENABLED' where competition_id = $1";
    const eventDelete = "delete from competition_lifetime_flow_events where competition_id = $1";
    // with the real guards: refused (the same statements the suites rely on)
    for (const [sql, params] of [[decisionUpdate, [s.entry.entryId]], [decisionDelete, [s.entry.entryId]], [eventUpdate, [done.competitionId]], [eventDelete, [done.competitionId]]] as Array<[string, unknown[]]>) {
      expect((await probe(sql, params)).ok, sql).toBe(false);
    }
    // with the history trigger taken away: the same statements rewrite and remove the record
    expect(await probe(decisionUpdate, [s.entry.entryId], ["competition_lifetime_entry_decisions", "competition_lifetime_entry_decisions_history_rows"])).toMatchObject({ ok: true, rowCount: 1 });
    expect(await probe(decisionDelete, [s.entry.entryId], ["competition_lifetime_entry_decisions", "competition_lifetime_entry_decisions_history_rows"])).toMatchObject({ ok: true, rowCount: 1 });
    expect(await probe(eventUpdate, [done.competitionId], ["competition_lifetime_flow_events", "competition_lifetime_flow_events_history_rows"])).toMatchObject({ ok: true });
    expect(await probe(eventDelete, [done.competitionId], ["competition_lifetime_flow_events", "competition_lifetime_flow_events_history_rows"])).toMatchObject({ ok: true, rowCount: 2 });
    // the switch row: with the row guard taken away a direct DELETE removes it, so the guard (and the mark only the recovery sets) is what protects it
    expect((await probe("delete from competition_lifetime_flows where competition_id = $1", [live.competitionId])).ok).toBe(false);
    expect(await probe("delete from competition_lifetime_flows where competition_id = $1", [live.competitionId], ["competition_lifetime_flows", "competition_lifetime_flows_row_guard"])).toMatchObject({ ok: true, rowCount: 1 });
    // the truncate guards are what stop a wholesale wipe
    expect((await probe("truncate competition_lifetime_entry_decisions", [])).ok).toBe(false);
    expect(await probe("truncate competition_lifetime_entry_decisions", [], ["competition_lifetime_entry_decisions", "competition_lifetime_entry_decisions_history_truncate"])).toMatchObject({ ok: true });
    // and every control rolled back: the history is intact
    expect(await decisionKinds(s.entry.entryId)).toEqual(["REJECTED"]);
    expect(await flowEvents(done.competitionId)).toEqual(["ENABLED", "DISABLED"]);
    expect(await flowCount(live.competitionId)).toBe(1);
  });

  it("[mutation 5] a V1 path that does not refuse a lifetime entry: with the guard taken away a V1 join request is written for an accepted lifetime entry — the separation probe is sensitive to the trigger", async () => {
    const s = await scenario("Mut5");
    await h.decideEntry(s.competition, s.entry.entryId, "APPROVE");
    const [person] = await h.newPeople(1, "Mut5Joiner");
    await h.register(s.competition, person);
    const insert = "insert into competition_join_requests (competition_id, competition_team_id, requesting_gaming_member_id) values ($1, $2, $3)";
    const params = [s.competition.competitionId, s.entry.entryId, id(person)];
    expect((await violation(insert, params))?.message, "the real guard refuses").toMatch(/^TEAM_NOT_ACCEPTED:/);
    const without = await rawTransaction(async (db) => {
      await db.query("alter table competition_join_requests disable trigger competition_join_requests_lifetime_entry_guard");
      try {
        await db.query(insert, params);
        return "written";
      } catch (err) {
        return (err as Error).message;
      }
    });
    expect(without, "without the guard V1 would accept a join request for a lifetime entry").toBe("written");
    expect(await countOf("select count(*)::int n from competition_join_requests where competition_team_id = $1", [s.entry.entryId])).toBe(0);
  });
});
