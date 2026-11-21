import { randomBytes } from "node:crypto";

import { Client } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import { loadEnv } from "vite";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";

import { createHarness, type Person } from "./helpers/lifetimeContract";

/**
 * UG-CR-GATE-CFM-001 — the second correction round. A second, independent six-lens adversarial review re-examined only what the first correction round CHANGED
 * (lock order, authorization order, the state machine, the backfill, the tests, the TypeScript), and an independent verifier reproduced every finding against a real,
 * disposable, loopback-only Postgres. The findings that touch the contract are corrected here; each test below states the behaviour the foundation must have and was
 * written to FAIL on the schema as it stood after the first round (the red evidence is recorded in the return report).
 *
 *   R2-F1   the legacy backfill converges without ever meeting a membership the lifetime flow already wrote (no raw unique violation, no stuck offer, nobody who left
 *           or declined is brought back) and one team's state never aborts the others in its scope;  deciding an offer can never leak a raw unique violation
 *   R2-F2   a V1 team whose name V1 accepted but the legacy name rule cannot hold (blank) is still preserved as a legacy team
 *   R2-F3   a leave is dated AFTER the competition locks it queues on: the membership, the seat and the audit event agree with the freeze that still counts the person
 *   R2-F12  the backfill's mirror takes the team lock, so a disband that wins the race leaves no ACTIVE member in a DISBANDED team
 *   R2-F13  a caller with no identity is nobody: the generic denial, never the lifecycle of the team
 *
 * The rest of the second round is test-only — tests that could not fail now can (each was proven by a mutation of the object it guards; see the return report):
 *
 *   R2-F6   the entry guard's accepted-roster-place clause and every role pairing of "captain or sub-captain of record"
 *   R2-F7   an ordinary member of the team is refused by every leader-only operation (decide a request, withdraw an invitation or a seat offer, release a claim)
 *   R2-F19  authorization before state, for the callers and states the first round did not probe (a former captain, another team's leader, a NULL actor, every claim state)
 *   R2-F20  refusals the migration raises that no test named (an unknown or V1 entry id; a backstop that no operation can reach)
 *   R2-F21  a disband ends a pending seat offer; a lapsed roster proposal is dated at its expiry; a departure is never dated before the freeze it follows
 */

// The shared contract-test guard (UG-CR-GATE-079) runs before anything is constructed: no target that is not loopback is ever touched.
const supabaseUrl = loadEnv("development", process.cwd(), "").SUPABASE_URL;
requireLocalSupabase(supabaseUrl);
// Every scenario here builds real people and teams through the real operations, and the freeze scenarios wait for a registration deadline to pass: none of them is
// a unit test. One explicit budget for the whole file (the repo's other contract suites do the same), instead of the 5 s default that a slow machine or a parallel run can cross.
vi.setConfig({ testTimeout: 90_000 });

const h = createHarness("r2");
const { one, rpc, refused, settle, rawQuery } = h;

afterAll(() => h.cleanup(), 300000);

const T = 90_000; // each scenario builds real people and teams through the real operations
const id = (p: Person) => p.gamingMemberId;

const invite = (teamId: string, actor: Person, subject: Person) =>
  one("propose_lifetime_team_membership_atomically", { p_lifetime_team_id: teamId, p_actor_gaming_member_id: id(actor), p_subject_gaming_member_id: id(subject) });
const decideMembership = (membershipId: string, actor: Person, decision: string) =>
  ({ p_lifetime_team_membership_id: membershipId, p_actor_gaming_member_id: id(actor), p_decision: decision });
const proposeArgs = (entryId: string, actor: Person, ids: string[]) => ({ p_competition_team_id: entryId, p_actor_gaming_member_id: id(actor), p_gaming_member_ids: ids });
const decideClaim = (claimId: string, actor: Person, decision: string) => ({ p_competition_lifetime_roster_claim_id: claimId, p_actor_gaming_member_id: id(actor), p_decision: decision });
const releaseClaim = (claimId: string, actor: Person) => ({ p_competition_lifetime_roster_claim_id: claimId, p_actor_gaming_member_id: id(actor) });
const enterArgs = (competitionId: string, teamId: string, actor: Person) => ({ p_competition_id: competitionId, p_lifetime_team_id: teamId, p_actor_gaming_member_id: id(actor) });
const withdrawOffer = (kind: "MEMBERSHIP" | "LEADERSHIP", offerId: string, actor: Person | null) => ({ p_offer_kind: kind, p_offer_id: offerId, p_actor_gaming_member_id: actor ? id(actor) : null });
const offerSeat = (teamId: string, actor: Person, subject: Person) =>
  one("offer_lifetime_team_leadership_atomically", { p_lifetime_team_id: teamId, p_actor_gaming_member_id: id(actor), p_subject_gaming_member_id: id(subject) });
const eventsOf = (teamId: string) => rawQuery("select event_type, actor_gaming_member_id, subject_gaming_member_id, related_id, details from lifetime_team_events where lifetime_team_id = $1 order by event_seq", [teamId]);
const claimRow = async (claimId: string) => (await rawQuery("select * from competition_lifetime_roster_claims where competition_lifetime_roster_claim_id = $1", [claimId]))[0];
/** What a call answers: "OK" or the coded refusal. */
const answer = async (name: string, args: Record<string, unknown>) => {
  const outcome = await settle(name, args);
  return outcome.ok ? "OK" : (outcome.refusal ?? `RAW ${outcome.code}`);
};
const leave = (teamId: string, actor: Person, subject: Person, successor?: Person) =>
  one("end_lifetime_team_membership_atomically", { p_lifetime_team_id: teamId, p_actor_gaming_member_id: id(actor), p_subject_gaming_member_id: id(subject), ...(successor ? { p_successor_gaming_member_id: id(successor) } : {}) });

// =============================================================================================================================================
// The legacy world: a V1 competition (the lifetime flow is NOT enabled) with one ACCEPTED V1 team of a captain and two approved members.
// =============================================================================================================================================
async function legacyWorld(label: string, teamName?: string) {
  const competition = await h.setUpCompetition(label, { lifetimeFlow: false });
  const [captain, a, b, later] = await h.newPeople(4, `${label}Person`);
  const created = await one("add_competition_team_atomically", {
    p_competition_id: competition.competitionId, p_organizer_gaming_member_id: id(competition.organizer), p_name: teamName ?? h.uniqueName("Legacy FC"),
    p_captain_gaming_member_id: id(captain), p_public_code: randomBytes(16).toString("base64url") });
  const give = (people: Person[]) => rawQuery(
    "insert into competition_team_memberships (competition_id, competition_team_id, gaming_member_id, approved_by_gaming_member_id) select $1, $2, unnest($3::uuid[]), $4",
    [competition.competitionId, created.competition_team_id, people.map(id), id(competition.organizer)]);
  await give([a, b]);
  return { competition, captain, a, b, later, give, teamId: created.competition_team_id as string };
}
type LegacyWorld = Awaited<ReturnType<typeof legacyWorld>>;

const runScope = (...competitionIds: string[]) => settle("backfill_legacy_competition_teams_atomically", { p_competition_ids: competitionIds });
/** The backfill must SUCCEED (a failure here is reported with its SQLSTATE, so a raw database failure is visible as one). */
async function mustRun(...competitionIds: string[]) {
  const outcome = await runScope(...competitionIds);
  if (!outcome.ok) throw new Error(`the backfill failed with ${outcome.code} (${outcome.refusal ?? "not a coded refusal"}): ${outcome.message}`);
  return outcome.rows[0] as { teams_created: number; memberships_created: number; leaderships_created: number; skipped_already_linked: number; skipped_not_accepted: number };
}
async function legacyTeamOf(competitionId: string): Promise<string> {
  const rows = await rawQuery("select lifetime_team_id from lifetime_team_legacy_sources where competition_id = $1", [competitionId]);
  h.trackTeam(rows[0].lifetime_team_id);
  return rows[0].lifetime_team_id as string;
}
const rowsOf = (teamId: string, person: Person) =>
  rawQuery("select status, is_legacy, end_reason, initiated_by_side from lifetime_team_memberships where lifetime_team_id = $1 and gaming_member_id = $2 order by seq", [teamId, id(person)]);

// =============================================================================================================================================
describe("[R2-F1] the backfill converges without meeting a membership the lifetime flow already wrote", () => {
  /** A legacy team that has been backfilled once, an outsider, and a second V1 team (not yet linked) in the same scope: the re-run must reach it. */
  async function world(label: string) {
    const w = await legacyWorld(label);
    await mustRun(w.competition.competitionId);
    const legacyId = await legacyTeamOf(w.competition.competitionId);
    const [outsider] = await h.newPeople(1, `${label}Outsider`);
    const second = await legacyWorld(`${label}2`);
    return { w, legacyId, outsider, second };
  }
  const scope = (x: Awaited<ReturnType<typeof world>>) => [x.w.competition.competitionId, x.second.competition.competitionId];

  it("[order A] a person who joined through the lifetime flow and is then approved in V1 is not mirrored twice, and the other team in the scope is still backfilled", async () => {
    const x = await world("R2F1A");
    const offer = await invite(x.legacyId, x.w.captain, x.outsider);
    await one("decide_lifetime_team_membership_atomically", decideMembership(offer.lifetime_team_membership_id, x.outsider, "ACCEPT"));
    await x.w.give([x.outsider]); // V1 approves the same person
    const rerun = await mustRun(...scope(x));
    expect(rerun).toMatchObject({ teams_created: 1, memberships_created: 3, leaderships_created: 1, skipped_already_linked: 1 });
    const rows = await rowsOf(x.legacyId, x.outsider);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "ACTIVE", is_legacy: false });
    h.trackTeam(await legacyTeamOf(x.second.competition.competitionId));
  }, T);

  it("[order B, team side] an invitation that is still pending when V1 approves the person is not shadowed by a mirror: it can still be accepted, once", async () => {
    const x = await world("R2F1B");
    const offer = await invite(x.legacyId, x.w.captain, x.outsider);
    await x.w.give([x.outsider]);
    const rerun = await mustRun(...scope(x));
    expect(rerun.memberships_created, "the person already holds a lifetime row (the pending invitation): not mirrored").toBe(3); // only the second team's three
    const accepted = await settle("decide_lifetime_team_membership_atomically", decideMembership(offer.lifetime_team_membership_id, x.outsider, "ACCEPT"));
    expect(accepted.ok, accepted.ok ? "" : `accepting failed with ${accepted.code}: ${accepted.message}`).toBe(true);
    const rows = await rowsOf(x.legacyId, x.outsider);
    expect(rows.filter((r) => r.status === "ACTIVE")).toHaveLength(1);
    expect(rows.find((r) => r.status === "ACTIVE")).toMatchObject({ is_legacy: false });
    h.trackTeam(await legacyTeamOf(x.second.competition.competitionId));
  }, T);

  it("[order B, person side] a request that is still pending when V1 approves the person can still be accepted by a leader, once", async () => {
    const x = await world("R2F1P");
    const request = await invite(x.legacyId, x.outsider, x.outsider); // the person asks for themselves
    await x.w.give([x.outsider]);
    await mustRun(...scope(x));
    const accepted = await settle("decide_lifetime_team_membership_atomically", decideMembership(request.lifetime_team_membership_id, x.w.captain, "ACCEPT"));
    expect(accepted.ok, accepted.ok ? "" : `accepting failed with ${accepted.code}: ${accepted.message}`).toBe(true);
    expect((await rowsOf(x.legacyId, x.outsider)).filter((r) => r.status === "ACTIVE")).toHaveLength(1);
    h.trackTeam(await legacyTeamOf(x.second.competition.competitionId));
  }, T);

  it("[order C] a person who left through the lifetime flow is not brought back by a later V1 approval and a re-run", async () => {
    const x = await world("R2F1C");
    const offer = await invite(x.legacyId, x.w.captain, x.outsider);
    await one("decide_lifetime_team_membership_atomically", decideMembership(offer.lifetime_team_membership_id, x.outsider, "ACCEPT"));
    await leave(x.legacyId, x.outsider, x.outsider);
    await x.w.give([x.outsider]);
    await mustRun(...scope(x));
    expect((await rowsOf(x.legacyId, x.outsider)).filter((r) => r.status === "ACTIVE"), "nobody who left is revived without an act of their own").toHaveLength(0);
    h.trackTeam(await legacyTeamOf(x.second.competition.competitionId));
  }, T);

  it("[order E] a person who declined an invitation is not mirrored as a member by a later V1 approval and a re-run", async () => {
    const x = await world("R2F1E");
    const offer = await invite(x.legacyId, x.w.captain, x.outsider);
    await one("decide_lifetime_team_membership_atomically", decideMembership(offer.lifetime_team_membership_id, x.outsider, "DECLINE"));
    await x.w.give([x.outsider]);
    await mustRun(...scope(x));
    expect((await rowsOf(x.legacyId, x.outsider)).filter((r) => r.status === "ACTIVE")).toHaveLength(0);
    h.trackTeam(await legacyTeamOf(x.second.competition.competitionId));
  }, T);

  it("[defence in depth] deciding an offer for a person who is ALREADY an active member is a coded refusal, never a raw unique violation, and the offer stays pending", async () => {
    const x = await world("R2F1D");
    const offer = await invite(x.legacyId, x.w.captain, x.outsider);
    // The state the unfixed mirror used to create: a legacy ACTIVE row beside a pending offer (written as the database owner — no operation can reach it any more).
    await rawQuery(
      `insert into lifetime_team_memberships (lifetime_team_id, gaming_member_id, status, initiated_by_side, initiated_by_gaming_member_id, is_legacy, created_at, decided_at, decided_by_gaming_member_id, joined_at)
       values ($1, $2, 'ACTIVE', 'TEAM', $3, true, now(), now(), $3, now())`, [x.legacyId, id(x.outsider), id(x.w.captain)]);
    await refused("decide_lifetime_team_membership_atomically", decideMembership(offer.lifetime_team_membership_id, x.outsider, "ACCEPT"), "LIFETIME_ALREADY_MEMBER");
    expect((await rowsOf(x.legacyId, x.outsider)).filter((r) => r.status === "PENDING")).toHaveLength(1);
  }, T);
});

// =============================================================================================================================================
describe("[R2-F12] the backfill's mirror takes the team lock", () => {
  /** Sessions that the holder is blocking right now (directly or through the queue behind it). */
  const blockedBy = async (db: Client, pid: number) => (await db.query("select count(*)::int n from pg_stat_activity where $1 = any(pg_blocking_pids(pid))", [pid])).rows[0].n as number;

  it("a disband that commits while the backfill waits for the team leaves no ACTIVE member in a DISBANDED team", async () => {
    const w = await legacyWorld("R2F12");
    await mustRun(w.competition.competitionId);
    const legacyId = await legacyTeamOf(w.competition.competitionId);
    await w.give([w.later]); // a V1 approval the next run would mirror — if the team were still active
    const holder = new Client({ connectionString: h.dbUrl, statement_timeout: 60000 });
    await holder.connect();
    try {
      await holder.query("begin");
      await holder.query("select 1 from lifetime_teams where lifetime_team_id = $1 for update", [legacyId]);
      const pid = (await holder.query("select pg_backend_pid() as pid")).rows[0].pid as number;
      const pending = runScope(w.competition.competitionId);
      const deadline = Date.now() + 30_000;
      while ((await blockedBy(holder, pid)) < 1) {
        if (Date.now() > deadline) throw new Error("the backfill never queued behind the held team row");
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      // The disband wins: the team ends while the backfill is waiting (the backfill has already decided, or is about to, on a team it believes is active).
      await holder.query("select * from disband_lifetime_team_atomically($1, $2)", [legacyId, id(w.captain)]);
      await holder.query("commit");
      const outcome = await pending;
      expect(outcome.ok, outcome.ok ? "" : `the backfill failed with ${outcome.code}: ${outcome.message}`).toBe(true);
    } finally {
      await holder.query("rollback").catch(() => {});
      await holder.end().catch(() => {});
    }
    const [{ status }] = await rawQuery("select status from lifetime_teams where lifetime_team_id = $1", [legacyId]);
    expect(status).toBe("DISBANDED");
    expect((await rawQuery("select count(*)::int n from lifetime_team_memberships where lifetime_team_id = $1 and status = 'ACTIVE'", [legacyId]))[0].n, "a disbanded team has no active member").toBe(0);
  }, T);
});

// =============================================================================================================================================
describe("[R2-F2] a V1 team whose name the legacy name rule cannot hold is still preserved", () => {
  it("backfills a team named with spaces only (V1 accepts it), keeps the V1 rows exactly as they were, and converges on a re-run", async () => {
    const blank = await legacyWorld("R2F2Blank", "   ");
    const ordinary = await legacyWorld("R2F2Ordinary");
    const scope = [blank.competition.competitionId, ordinary.competition.competitionId];
    const v1Before = await rawQuery("select competition_team_id, name, status from competition_teams where competition_id = any($1) order by competition_team_id", [scope]);
    expect(await mustRun(...scope)).toMatchObject({ teams_created: 2, memberships_created: 6, leaderships_created: 2, skipped_already_linked: 0 });
    const names = (await rawQuery("select t.name from lifetime_teams t join lifetime_team_legacy_sources s on s.lifetime_team_id = t.lifetime_team_id where s.competition_id = any($1) order by t.name", [scope])).map((r) => r.name);
    for (const competitionId of scope) await legacyTeamOf(competitionId);
    expect(names).toContain("(unnamed team)");
    expect(names).toHaveLength(2);
    expect(await rawQuery("select competition_team_id, name, status from competition_teams where competition_id = any($1) order by competition_team_id", [scope]), "no V1 row is touched").toEqual(v1Before);
    expect(await mustRun(...scope)).toMatchObject({ teams_created: 0, memberships_created: 0, skipped_already_linked: 2 });
  }, T);
});

// =============================================================================================================================================
describe("[R2-F13] a caller with no identity is nobody", () => {
  it("answers the generic denial to a NULL actor asking for a NULL subject, on an active AND on a disbanded team", async () => {
    const team = await h.buildTeam("R2F13", 3, { subCaptain: false });
    const args = (actor: string | null, subject: string | null) => ({ p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: actor, p_subject_gaming_member_id: subject });
    await refused("propose_lifetime_team_membership_atomically", args(null, null), "LIFETIME_NOT_A_LEADER");
    await refused("propose_lifetime_team_membership_atomically", args(null, id(team.members[0])), "LIFETIME_NOT_A_LEADER");
    await one("disband_lifetime_team_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: id(team.captain) });
    await refused("propose_lifetime_team_membership_atomically", args(null, null), "LIFETIME_NOT_A_LEADER");
    // The control: a real person asking for themselves on a disbanded team is told the team is gone (it is their own information).
    const [outsider] = await h.newPeople(1, "R2F13Outsider");
    await refused("propose_lifetime_team_membership_atomically", args(id(outsider), id(outsider)), "LIFETIME_TEAM_NOT_ACTIVE");
  }, T);
});

// =============================================================================================================================================
describe("[R2-F6] the entry guard holds BOTH halves of 'one team per person per competition', in every role pairing", () => {
  const asLeader = async (competition: Awaited<ReturnType<typeof h.setUpCompetition>>, team: { teamId: string }, leader: Person) => {
    await h.register(competition, leader);
    return refused("enter_lifetime_team_into_competition_atomically", enterArgs(competition.competitionId, team.teamId, leader), "LIFETIME_PERSON_REPRESENTS_ANOTHER_TEAM");
  };

  it("[sub-captain of record x entering captain] a sub-captain who stepped down, left, and founded another team cannot enter it as its captain", async () => {
    const competition = await h.setUpCompetition("R2F6S1");
    const alpha = await h.buildTeam("R2F6Alpha", 5);
    const x = alpha.subCaptain!;
    await h.enterTeam(competition, alpha); // names X as its sub-captain of record
    await leave(alpha.teamId, x, x); // X steps down and leaves
    const charlie = await h.createTeam(x);
    const [filler] = await h.newPeople(1, "R2F6Filler");
    await h.addMember(charlie.teamId, x, filler);
    await asLeader(competition, charlie, x);
    expect((await rawQuery("select count(*)::int n from competition_teams where competition_id = $1 and entry_flow = 'LIFETIME' and status <> 'REJECTED'", [competition.competitionId]))[0].n).toBe(1);
  }, T);

  it("[captain of record x entering sub-captain] a captain who left (with a successor), joined another team and took its sub-captain seat cannot have that team enter", async () => {
    const competition = await h.setUpCompetition("R2F6S2");
    const alpha = await h.buildTeam("R2F6AlphaS2", 5);
    const bravo = await h.buildTeam("R2F6BravoS2", 5, { subCaptain: false });
    const x = alpha.captain;
    await h.enterTeam(competition, alpha); // names X as its captain of record
    await leave(alpha.teamId, x, x, alpha.subCaptain!); // X leaves; the sub-captain succeeds
    await h.addMember(bravo.teamId, bravo.captain, x);
    await h.makeSubCaptain(bravo.teamId, bravo.captain, x);
    await asLeader(competition, bravo, bravo.captain);
  }, T);

  it("[accepted roster place x entering captain] a LEGACY member holding an accepted place on one entry cannot found a team and enter it as captain in the same competition", async () => {
    // Only the legacy world can reach this half of the guard: an ordinary person who holds an accepted place belongs to that team, so founding another is refused earlier
    // (they must belong to one team). A legacy membership is history, outside the caps — so the guard itself is the only thing that holds the rule.
    const w = await legacyWorld("R2F6Legacy");
    await mustRun(w.competition.competitionId);
    const legacyId = await legacyTeamOf(w.competition.competitionId);
    const competition = await h.setUpCompetition("R2F6S3");
    await h.register(competition, w.captain);
    const entry = await one("enter_lifetime_team_into_competition_atomically", enterArgs(competition.competitionId, legacyId, w.captain));
    await h.rosterUp(entry.competition_team_id, w.captain, competition, [w.a]); // A: an ACCEPTED place on the legacy team's entry
    const founded = await h.createTeam(w.a); // legal: a legacy membership does not count toward the caps
    const [filler] = await h.newPeople(1, "R2F6LegacyFiller");
    await h.addMember(founded.teamId, w.a, filler);
    await asLeader(competition, founded, w.a);
  }, T);
});

// =============================================================================================================================================
describe("[R2-F7] an ordinary member of a team is refused by every leader-only operation", () => {
  it("refuses an ordinary member, a stranger and the person themselves when they try to decide a person's request, and lets only the asker withdraw it", async () => {
    const team = await h.buildTeam("R2F7Request", 5);
    const [asker, stranger] = await h.newPeople(2, "R2F7Asker");
    const ordinary = team.members[0];
    const request = await invite(team.teamId, asker, asker); // the person asks for themselves
    const decideAs = (actor: Person) => answer("decide_lifetime_team_membership_atomically", decideMembership(request.lifetime_team_membership_id, actor, "ACCEPT"));
    expect([await decideAs(ordinary), await decideAs(stranger), await decideAs(asker)]).toEqual(Array(3).fill("LIFETIME_OFFER_WRONG_PARTY"));
    const withdrawAs = (actor: Person) => answer("withdraw_lifetime_team_offer_atomically", withdrawOffer("MEMBERSHIP", request.lifetime_team_membership_id, actor));
    expect([await withdrawAs(team.captain), await withdrawAs(ordinary), await withdrawAs(stranger)], "a request is the person's own: no leader and no member withdraws it").toEqual(Array(3).fill("LIFETIME_OFFER_WRONG_PARTY"));
    expect(await withdrawAs(asker)).toBe("OK");
  }, T);

  it("refuses an ordinary member, a stranger and the invitee when they try to withdraw a leader's invitation, and lets any leader do it", async () => {
    const team = await h.buildTeam("R2F7Invite", 5);
    const [guest, stranger] = await h.newPeople(2, "R2F7Guest");
    const ordinary = team.members[0];
    const invitation = await invite(team.teamId, team.captain, guest);
    const withdrawAs = (actor: Person) => answer("withdraw_lifetime_team_offer_atomically", withdrawOffer("MEMBERSHIP", invitation.lifetime_team_membership_id, actor));
    expect([await withdrawAs(ordinary), await withdrawAs(stranger), await withdrawAs(guest)]).toEqual(Array(3).fill("LIFETIME_OFFER_WRONG_PARTY"));
    expect(await withdrawAs(team.subCaptain!), "any current leader may withdraw an invitation").toBe("OK");
  }, T);

  it("refuses an ordinary member, a stranger and the offeree when they try to withdraw a sub-captain seat offer, in any state, and lets only a leader do it", async () => {
    const team = await h.buildTeam("R2F7Seat", 4, { subCaptain: false });
    const [stranger] = await h.newPeople(1, "R2F7Stranger");
    const [offeree, ordinary] = team.members;
    const seat = await offerSeat(team.teamId, team.captain, offeree);
    const withdrawAs = (actor: Person) => answer("withdraw_lifetime_team_offer_atomically", withdrawOffer("LEADERSHIP", seat.lifetime_team_leadership_id, actor));
    expect([await withdrawAs(ordinary), await withdrawAs(stranger), await withdrawAs(offeree)]).toEqual(Array(3).fill("LIFETIME_OFFER_WRONG_PARTY"));
    expect(await withdrawAs(team.captain)).toBe("OK");
    expect([await withdrawAs(stranger), await withdrawAs(ordinary)], "an ended offer answers a caller with no role exactly as a pending one did").toEqual(Array(2).fill("LIFETIME_OFFER_WRONG_PARTY"));
  }, T);

  it("refuses an ordinary member of the same team when they try to release someone else's roster claim, in any claim state", async () => {
    const competition = await h.setUpCompetition("R2F7Claim");
    const team = await h.buildTeam("R2F7ClaimTeam", 5);
    const entry = await h.enterTeam(competition, team);
    const [subject, ordinary] = team.members;
    const [proposal] = await rpc("propose_lifetime_entry_roster_claims_atomically", proposeArgs(entry.entryId, team.captain, [id(subject)]));
    const claimId = proposal.competition_lifetime_roster_claim_id as string;
    expect(await answer("release_lifetime_entry_roster_claim_atomically", releaseClaim(claimId, ordinary)), "while it is only proposed").toBe("LIFETIME_NOT_A_LEADER");
    await h.register(competition, subject);
    await one("decide_lifetime_entry_roster_claim_atomically", decideClaim(claimId, subject, "ACCEPT"));
    expect(await answer("release_lifetime_entry_roster_claim_atomically", releaseClaim(claimId, ordinary)), "once accepted").toBe("LIFETIME_NOT_A_LEADER");
    expect((await claimRow(claimId)).status).toBe("ACCEPTED");
  }, T);
});

// =============================================================================================================================================
describe("[R2-F19] authorization before state, for the callers and states the first round did not probe", () => {
  it("answers a stranger and another team's captain identically in every state of a roster claim (the state is not disclosed to someone who cannot decide it)", async () => {
    const competition = await h.setUpCompetition("R2F19Claim");
    const team = await h.buildTeam("R2F19Team", 5);
    const other = await h.buildTeam("R2F19Other", 3);
    const [stranger] = await h.newPeople(1, "R2F19Stranger");
    const entry = await h.enterTeam(competition, team);
    const [m1, m2, m3] = team.members;
    const proposed = await rpc("propose_lifetime_entry_roster_claims_atomically", proposeArgs(entry.entryId, team.captain, [id(m1), id(m2), id(m3)]));
    const claimOf = (p: Person) => proposed.find((c) => c.gaming_member_id === id(p))!.competition_lifetime_roster_claim_id as string;
    await h.register(competition, m1);
    await one("decide_lifetime_entry_roster_claim_atomically", decideClaim(claimOf(m1), m1, "REJECT")); // REJECTED
    await one("release_lifetime_entry_roster_claim_atomically", releaseClaim(claimOf(m2), team.captain)); // WITHDRAWN; m3 stays PROPOSED
    const answers: string[] = [];
    for (const claim of [claimOf(m1), claimOf(m2), claimOf(m3)]) for (const actor of [stranger, other.captain]) answers.push(await answer("decide_lifetime_entry_roster_claim_atomically", decideClaim(claim, actor, "ACCEPT")));
    expect(answers).toEqual(Array(6).fill("LIFETIME_CLAIM_WRONG_PARTY"));
  }, T);

  it("answers a stranger the same on ending a seat whether or not the team has a sub-captain, and whether or not it still exists", async () => {
    const [stranger] = await h.newPeople(1, "R2F19Seat");
    const noSub = await h.buildTeam("R2F19NoSub", 3, { subCaptain: false });
    const withSub = await h.buildTeam("R2F19WithSub", 3);
    const gone = await h.buildTeam("R2F19Gone", 2, { subCaptain: false });
    await one("disband_lifetime_team_atomically", { p_lifetime_team_id: gone.teamId, p_actor_gaming_member_id: id(gone.captain) });
    const answers = [];
    for (const team of [noSub, withSub, gone]) answers.push(await answer("end_lifetime_team_leadership_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: id(stranger) }));
    expect(answers).toEqual(Array(3).fill("LIFETIME_NOT_A_LEADER"));
  }, T);

  it("answers a stranger the same on a declined or withdrawn REQUEST as on a pending one", async () => {
    const team = await h.buildTeam("R2F19Requests", 3);
    const [askerA, askerB, stranger] = await h.newPeople(3, "R2F19Asker");
    const declined = await invite(team.teamId, askerA, askerA);
    await one("decide_lifetime_team_membership_atomically", decideMembership(declined.lifetime_team_membership_id, team.captain, "DECLINE"));
    const withdrawn = await invite(team.teamId, askerB, askerB);
    await one("withdraw_lifetime_team_offer_atomically", withdrawOffer("MEMBERSHIP", withdrawn.lifetime_team_membership_id, askerB));
    const answers: string[] = [];
    for (const request of [declined, withdrawn]) {
      answers.push(await answer("decide_lifetime_team_membership_atomically", decideMembership(request.lifetime_team_membership_id, stranger, "ACCEPT")));
      answers.push(await answer("withdraw_lifetime_team_offer_atomically", withdrawOffer("MEMBERSHIP", request.lifetime_team_membership_id, stranger)));
    }
    expect(answers).toEqual(Array(4).fill("LIFETIME_OFFER_WRONG_PARTY"));
  }, T);

  it("answers a FORMER captain like any stranger: on a team they handed over (still live) and on a team that was disbanded", async () => {
    const [stranger, guest] = await h.newPeople(2, "R2F19Guest");
    const live = await h.buildTeam("R2F19Live", 4);
    const doomed = await h.buildTeam("R2F19Doomed", 3, { subCaptain: false });
    const formerLive = live.captain;
    const formerDoomed = doomed.captain;
    await leave(live.teamId, live.captain, live.captain, live.subCaptain!); // hands over and leaves
    await one("disband_lifetime_team_atomically", { p_lifetime_team_id: doomed.teamId, p_actor_gaming_member_id: id(doomed.captain) });
    for (const [team, former, member] of [[live, formerLive, live.members[0]], [doomed, formerDoomed, doomed.members[0]]] as const) {
      const probe = async (actor: Person) => [
        await answer("propose_lifetime_team_membership_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: id(actor), p_subject_gaming_member_id: id(guest) }),
        await answer("offer_lifetime_team_leadership_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: id(actor), p_subject_gaming_member_id: id(member) }),
        await answer("end_lifetime_team_membership_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: id(actor), p_subject_gaming_member_id: id(member) }),
        await answer("disband_lifetime_team_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: id(actor) }),
      ];
      const asStranger = await probe(stranger);
      expect(asStranger).toEqual(["LIFETIME_NOT_A_LEADER", "LIFETIME_NOT_THE_CAPTAIN", "LIFETIME_NOT_A_LEADER", "LIFETIME_NOT_THE_CAPTAIN"]);
      expect(await probe(former), `${team.teamId}: a former captain is no more than a stranger`).toEqual(asStranger);
    }
  }, T);

  it("answers a caller with NO identity (a NULL actor) the generic denial on every operation that names an actor and a record", async () => {
    const team = await h.buildTeam("R2F19Null", 4);
    const [guest] = await h.newPeople(1, "R2F19NullGuest");
    const member = team.members[0];
    const invitation = await invite(team.teamId, team.captain, guest);
    expect([
      await answer("end_lifetime_team_membership_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: null, p_subject_gaming_member_id: id(member) }),
      await answer("disband_lifetime_team_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: null }),
      await answer("offer_lifetime_team_leadership_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: null, p_subject_gaming_member_id: id(member) }),
    ]).toEqual(["LIFETIME_NOT_A_LEADER", "LIFETIME_NOT_THE_CAPTAIN", "LIFETIME_NOT_THE_CAPTAIN"]);
    expect([
      await answer("decide_lifetime_team_membership_atomically", { p_lifetime_team_membership_id: invitation.lifetime_team_membership_id, p_actor_gaming_member_id: null, p_decision: "ACCEPT" }),
      await answer("withdraw_lifetime_team_offer_atomically", withdrawOffer("MEMBERSHIP", invitation.lifetime_team_membership_id, null)),
    ]).toEqual(["LIFETIME_OFFER_WRONG_PARTY", "LIFETIME_OFFER_WRONG_PARTY"]);
  }, T);
});

// =============================================================================================================================================
describe("[R2-F20] refusals the migration raises that no test named", () => {
  it("answers an entry id that names nothing — and the id of a V1 entry — with LIFETIME_ENTRY_NOT_FOUND, before it says anything about authority", async () => {
    const v1 = await h.setUpCompetition("R2F20V1", { lifetimeFlow: false });
    const [captain, anyone] = await h.newPeople(2, "R2F20Person");
    const v1Entry = await one("add_competition_team_atomically", { p_competition_id: v1.competitionId, p_organizer_gaming_member_id: id(v1.organizer), p_name: h.uniqueName("R2F20 V1"), p_captain_gaming_member_id: id(captain), p_public_code: randomBytes(16).toString("base64url") });
    for (const entryId of ["00000000-0000-4000-8000-0000000000cc", v1Entry.competition_team_id as string]) {
      await refused("withdraw_lifetime_competition_entry_atomically", { p_competition_team_id: entryId, p_actor_gaming_member_id: id(anyone) }, "LIFETIME_ENTRY_NOT_FOUND");
      await refused("propose_lifetime_entry_roster_claims_atomically", proposeArgs(entryId, anyone, [id(anyone)]), "LIFETIME_ENTRY_NOT_FOUND");
    }
  }, T);

  it("refuses to admit a person on an invitation whose issuer no longer leads even when nothing ended it (the accept's own backstop; no operation can write this state)", async () => {
    const team = await h.buildTeam("R2F20Backstop", 4);
    const [guest] = await h.newPeople(1, "R2F20Guest");
    const ordinary = team.members[0];
    // A TEAM-side invitation 'issued' by an ordinary member: every operation ends an invitation with its issuer's seat, so this is written as the database owner.
    const [{ offer_id: offerId }] = await rawQuery(
      `insert into lifetime_team_memberships (lifetime_team_id, gaming_member_id, status, initiated_by_side, initiated_by_gaming_member_id, created_at, expires_at)
       values ($1, $2, 'PENDING', 'TEAM', $3, now(), now() + interval '7 days') returning lifetime_team_membership_id as offer_id`, [team.teamId, id(guest), id(ordinary)]);
    await refused("decide_lifetime_team_membership_atomically", decideMembership(offerId, guest, "ACCEPT"), "LIFETIME_OFFER_NOT_PENDING");
    expect((await rawQuery("select count(*)::int n from lifetime_team_memberships where lifetime_team_id = $1 and gaming_member_id = $2 and status = 'ACTIVE'", [team.teamId, id(guest)]))[0].n).toBe(0);
  }, T);
});

// =============================================================================================================================================
describe("[R2-F21] what the first round's tests claimed more than they checked", () => {
  it("a disband ends a pending sub-captain offer: the seat row is ended as TEAM_DISBANDED and the audit trail names it", async () => {
    const team = await h.buildTeam("R2F21Seat", 3, { subCaptain: false });
    const offer = await offerSeat(team.teamId, team.captain, team.members[0]);
    await one("disband_lifetime_team_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: id(team.captain) });
    expect((await rawQuery("select status, end_reason from lifetime_team_leaderships where lifetime_team_leadership_id = $1", [offer.lifetime_team_leadership_id]))[0]).toMatchObject({ status: "ENDED", end_reason: "TEAM_DISBANDED" });
    const events = await eventsOf(team.teamId);
    expect(events.find((e) => e.event_type === "LEADERSHIP_ENDED" && e.related_id === offer.lifetime_team_leadership_id)).toMatchObject({ details: { role: "SUB_CAPTAIN", end_reason: "TEAM_DISBANDED" } });
    expect(events[events.length - 1].event_type, "the disband event comes last").toBe("TEAM_DISBANDED");
  }, T);

  it("dates a roster proposal that lapsed (7 days) at its EXPIRY, not at the moment someone proposed again", async () => {
    const competition = await h.setUpCompetition("R2F21Lapse", { deadlineMs: Date.now() + 30 * 24 * 3600_000 });
    const team = await h.buildTeam("R2F21LapseTeam", 4);
    const entry = await h.enterTeam(competition, team);
    const person = team.members[0];
    const [first] = await rpc("propose_lifetime_entry_roster_claims_atomically", proposeArgs(entry.entryId, team.captain, [id(person)]));
    const firstId = first.competition_lifetime_roster_claim_id as string;
    const { expires_at: expiresAt } = await claimRow(firstId);
    const later = new Date(new Date(expiresAt).getTime() + 24 * 3600_000).toISOString(); // a day after the proposal lapsed
    const swept = await h.withClock(later, async (db) => {
      await db.query("select * from propose_lifetime_entry_roster_claims_atomically($1, $2, $3)", [entry.entryId, id(team.captain), [id(person)]]);
      return (await db.query("select status, released_at, expires_at from competition_lifetime_roster_claims where competition_lifetime_roster_claim_id = $1", [firstId])).rows[0];
    });
    expect(swept.status).toBe("EXPIRED");
    expect(new Date(swept.released_at).getTime(), "dated when it lapsed, not when it was noticed").toBe(new Date(swept.expires_at).getTime());
  }, T);

  it("never dates a departure before the freeze that still counted the person: with the clock behind the freeze, the claim is dated AT the freeze", async () => {
    const competition = await h.setUpCompetition("R2F21Clock");
    const teamA = await h.buildTeam("R2F21ClockA", 6);
    const teamB = await h.buildTeam("R2F21ClockB", 6);
    const entryA = await h.enterTeam(competition, teamA);
    const entryB = await h.enterTeam(competition, teamB);
    const claimsA = await h.rosterUp(entryA.entryId, teamA.captain, competition, teamA.everyone);
    await h.rosterUp(entryB.entryId, teamB.captain, competition, teamB.everyone);
    await h.passDeadline(competition.competitionId);
    await one("freeze_lifetime_competition_entries_atomically", { p_competition_id: competition.competitionId, p_organizer_gaming_member_id: id(competition.organizer) });
    const [{ frozen_at: frozenAt }] = await rawQuery("select frozen_at from competition_lifetime_freezes where competition_id = $1", [competition.competitionId]);
    const leaver = teamA.members[1];
    const behind = new Date(new Date(frozenAt).getTime() - 1).toISOString(); // one millisecond BEFORE the freeze (a clock that lags)
    const claim = await h.withClock(behind, async (db) => {
      await db.query("select * from end_lifetime_team_membership_atomically($1, $2, $3)", [teamA.teamId, id(leaver), id(leaver)]);
      return (await db.query("select status, departed_at from competition_lifetime_roster_claims where competition_lifetime_roster_claim_id = $1", [claimsA[id(leaver)]])).rows[0];
    });
    expect(claim.status, "after the freeze the accepted claim stays as evidence").toBe("ACCEPTED");
    expect(new Date(claim.departed_at).getTime(), "never dated before the freeze").toBe(new Date(frozenAt).getTime());
  }, T);
});
