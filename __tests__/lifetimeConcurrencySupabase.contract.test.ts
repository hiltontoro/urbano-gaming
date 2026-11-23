import { Client } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import { loadEnv } from "vite";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";

import { createHarness, type BuiltTeam, type LifetimeTestCompetition, type Outcome, type Person } from "./helpers/lifetimeContract";

/**
 * UG-CR-GATE-CFM-001 — concurrency and mutation controls for lifetime teams and competition entry, against a real (disposable, loopback-only) Postgres.
 *
 * Every race is REAL: each call is its own HTTP request and its own database transaction. A raw session first holds the advisory lock the operations queue on, the
 * calls are started, and the lock is released only once the database SHOWS every racer blocked behind THAT session (pg_blocking_pids of the holder's own backend: a
 * waiter of some other suite, on some other lock, can neither satisfy nor spoil the count) — so the racers genuinely overlap, whatever the machine's speed. Where the
 * outcome depends on who got there first, the ARRIVAL ORDER is forced in both directions (start one racer, wait until it is queued, start the next; waiters on an
 * advisory lock are served first come, first served) and the exact outcome of each order is asserted: nothing is left to a coin toss, and no assertion is vacuous.
 * (The person key is the one documented in the migration: class 7101, hashtext('lifetime_person:' || member id); the competition key is V1's own competition_scope.)
 *
 * What every race proves: exactly the outcomes the rules allow, never a raw database failure (no deadlock, no unique violation reaches the caller — every refusal
 * is a coded domain refusal) and the invariants hold afterwards, whatever the order in which the transactions happened to finish.
 *
 * The MUTATION CONTROLS then show that the direct-write probes are sensitive to the very objects that hold each rule (the index, the guard): remove the object inside
 * a transaction that is always rolled back and the same probe goes through. They prove the probes can fail; the races above prove the operations hold the rules.
 */

// The shared contract-test guard (UG-CR-GATE-079) runs before anything is constructed: no target that is not loopback is ever touched.
const supabaseUrl = loadEnv("development", process.cwd(), "").SUPABASE_URL;
requireLocalSupabase(supabaseUrl);
// Every scenario here builds real people and teams through the real operations, and the freeze scenarios wait for a registration deadline to pass: none of them is
// a unit test. One explicit budget for the whole file (the repo's other contract suites do the same), instead of the 5 s default that a slow machine or a parallel run can cross.
vi.setConfig({ testTimeout: 90_000 });

const h = createHarness("lc");
const { one, rpc, rawQuery, violation, rawTransaction, settle } = h;

afterAll(() => h.cleanup(), 600000);

const personKey = (id: string) => `lifetime_person:${id}`;

/** How many sessions the holder is blocking right now (directly, or through the queue behind a lock it holds). Nothing else in the database can change this count. */
async function blockedBy(db: Client, holderPid: number): Promise<number> {
  // The holder polls INSIDE its open transaction, where pg_stat_activity is a snapshot taken at the first read: a backend created later (a new PostgREST pool connection for a racer)
  // would stay invisible and the racer would "never queue". Clearing the snapshot first makes every count current (UG-CR-GATE-CFM-004: found by a four-racer race whose pool was short).
  await db.query("select pg_stat_clear_snapshot()");
  return (await db.query("select count(*)::int n from pg_stat_activity where $1 = any(pg_blocking_pids(pid))", [holderPid])).rows[0].n as number;
}

/** Waits until at least `count` sessions are queued behind the locks the holder has; a racer that never queues is a failure, not a silent mis-alignment. */
async function queued(db: Client, holderPid: number, count: number, label: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    if ((await blockedBy(db, holderPid)) >= count) return;
    if (Date.now() > deadline) throw new Error(`${label}: ${count} racer(s) never queued behind the held lock`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/**
 * Holds `acquire`'s locks, starts `run` and waits until `waiters` racers are queued behind them, then releases: the racers enter their critical sections together.
 * `waiters` is the number of racers that take a held lock — a racer that takes none (for instance a roster proposal, which takes no person lock) is not counted.
 * `whileQueued` runs once every racer is queued and before the lock is released (a probe of what the queued racers do and do not yet hold).
 */
async function holding<T>(acquire: (db: Client) => Promise<void>, run: () => Promise<T>, waiters: number, label: string, whileQueued?: () => Promise<void>): Promise<T> {
  const db = new Client({ connectionString: h.dbUrl, statement_timeout: 60000 });
  await db.connect();
  try {
    await db.query("begin");
    await acquire(db);
    const pid = (await db.query("select pg_backend_pid() as pid")).rows[0].pid as number;
    const pending = run();
    await queued(db, pid, waiters, label);
    if (whileQueued) await whileQueued();
    await db.query("commit");
    return await pending;
  } finally {
    await db.query("rollback").catch(() => {});
    await db.end().catch(() => {});
  }
}

/** Like `holding`, but starts the calls ONE AT A TIME, each only once the previous one is queued: the arrival order is forced and so is the order they are served in. */
async function arrivingInOrder<T>(acquire: (db: Client) => Promise<void>, calls: Array<() => Promise<T>>, label: string): Promise<T[]> {
  const db = new Client({ connectionString: h.dbUrl, statement_timeout: 60000 });
  await db.connect();
  try {
    await db.query("begin");
    await acquire(db);
    const pid = (await db.query("select pg_backend_pid() as pid")).rows[0].pid as number;
    const pending: Array<Promise<T>> = [];
    for (let i = 0; i < calls.length; i++) {
      pending.push(calls[i]());
      await queued(db, pid, i + 1, `${label} #${i + 1}`);
    }
    await db.query("commit");
    return await Promise.all(pending);
  } finally {
    await db.query("rollback").catch(() => {});
    await db.end().catch(() => {});
  }
}

const holdPeople = (people: string[]) => async (db: Client) => {
  for (const id of people) await db.query("select pg_advisory_xact_lock(7101, hashtext($1))", [personKey(id)]);
};
const holdCompetition = (competitionId: string) => async (db: Client) => {
  await db.query("select pg_advisory_xact_lock(hashtext($1))", [`competition_scope:${competitionId}`]);
  await db.query("select 1 from competitions where competition_id = $1 for update", [competitionId]);
};

/** Holds the person locks, starts `run` and releases once `waiters` racers are queued behind them. */
const racing = <T,>(people: string[], run: () => Promise<T>, waiters: number, whileQueued?: () => Promise<void>) => holding(holdPeople(people), run, waiters, "person-lock race", whileQueued);
/** Holds the COMPETITION's own scope lock (the one every V1 and lifetime operation takes) so that the calls queue and then overlap. */
const racingOnCompetition = <T,>(competitionId: string, run: () => Promise<T>, waiters: number) => holding(holdCompetition(competitionId), run, waiters, "competition-lock race");

/** Every failure must be a coded domain refusal: never a deadlock, a serialization failure or a unique violation. */
function onlyCodedRefusals(outcomes: Outcome[]) {
  for (const outcome of outcomes) {
    if (!outcome.ok) expect({ code: outcome.code, refusal: outcome.refusal, message: outcome.message }, "a failure must be a coded refusal, not a raw database error").toMatchObject({ code: "P0001", refusal: expect.stringMatching(/^[A-Z][A-Z0-9_]+$/) });
  }
}
const successes = (outcomes: Outcome[]) => outcomes.filter((o) => o.ok).length;
const refusals = (outcomes: Outcome[]) => outcomes.filter((o): o is Extract<Outcome, { ok: false }> => !o.ok).map((o) => o.refusal);

const activeCount = async (person: Person) => (await rawQuery("select count(*)::int n from lifetime_team_memberships where gaming_member_id = $1 and status = 'ACTIVE' and not is_legacy", [person.gamingMemberId]))[0].n as number;
const acceptedFor = async (competitionId: string, person: Person) => (await rawQuery("select competition_team_id from competition_lifetime_roster_claims where competition_id = $1 and gaming_member_id = $2 and status = 'ACCEPTED'", [competitionId, person.gamingMemberId]));

const offerArgs = (teamId: string, actor: Person, subject: Person) => ({ p_lifetime_team_id: teamId, p_actor_gaming_member_id: actor.gamingMemberId, p_subject_gaming_member_id: subject.gamingMemberId });
const acceptMembership = (id: string, actor: Person) => ({ p_lifetime_team_membership_id: id, p_actor_gaming_member_id: actor.gamingMemberId, p_decision: "ACCEPT" });
const claimDecision = (id: string, actor: Person, decision = "ACCEPT") => ({ p_competition_lifetime_roster_claim_id: id, p_actor_gaming_member_id: actor.gamingMemberId, p_decision: decision });
const proposeClaims = (entryId: string, actor: Person, ids: string[]) => ({ p_competition_team_id: entryId, p_actor_gaming_member_id: actor.gamingMemberId, p_gaming_member_ids: ids });

// =============================================================================================================================================
describe("[1] the races the gate names", () => {
  /** Two teams, each with an entry in one competition (each with a second member, so it can enter). */
  async function twoEntries(label: string) {
    const competition = await h.setUpCompetition(label);
    const [captainA, captainB] = await h.newPeople(2, "Cap");
    const [teamA, teamB] = [await h.createTeam(captainA), await h.createTeam(captainB)];
    const filler = await h.newPeople(2, "Fill");
    await h.addMember(teamA.teamId, captainA, filler[0]);
    await h.addMember(teamB.teamId, captainB, filler[1]);
    const asBuilt = (t: { teamId: string; name: string }, captain: Person): BuiltTeam => ({ ...t, captain, subCaptain: null, members: [], everyone: [] });
    const [entryA, entryB] = [await h.enterTeam(competition, asBuilt(teamA, captainA)), await h.enterTeam(competition, asBuilt(teamB, captainB))];
    return { competition, captainA, captainB, teamA, teamB, entryA, entryB };
  }

  it("simultaneous invitations from two entries in one competition: both are recorded, nobody is claimed, nobody is refused a raw error", async () => {
    const { competition, captainA, captainB, teamA, teamB, entryA, entryB } = await twoEntries("RaceInvite");
    for (let i = 0; i < 5; i++) {
      const [person] = await h.newPeople(1, `Shared${i}`);
      await h.addMember(teamA.teamId, captainA, person);
      await h.addMember(teamB.teamId, captainB, person);
      // A roster proposal takes no person lock, so the racers are aligned on the COMPETITION lock they both queue on.
      const outcomes = await racingOnCompetition(competition.competitionId, () => Promise.all([
        settle("propose_lifetime_entry_roster_claims_atomically", proposeClaims(entryA.entryId, captainA, [person.gamingMemberId])),
        settle("propose_lifetime_entry_roster_claims_atomically", proposeClaims(entryB.entryId, captainB, [person.gamingMemberId])),
      ]), 2);
      onlyCodedRefusals(outcomes);
      expect(successes(outcomes)).toBe(2);
      expect((await rawQuery("select status from competition_lifetime_roster_claims where competition_id = $1 and gaming_member_id = $2", [competition.competitionId, person.gamingMemberId])).map((r) => r.status)).toEqual(["PROPOSED", "PROPOSED"]);
      expect(await acceptedFor(competition.competitionId, person)).toHaveLength(0);
    }
  });

  it("simultaneous acceptance into two entries: the person's own FIRST acceptance holds them — never the order the captains typed a name, in either arrival order", async () => {
    const { competition, captainA, captainB, teamA, teamB, entryA, entryB } = await twoEntries("RaceAccept");
    for (const aFirst of [true, false, true, false]) {
      const [person] = await h.newPeople(1, `Pick${aFirst ? "A" : "B"}`);
      await h.addMember(teamA.teamId, captainA, person);
      await h.addMember(teamB.teamId, captainB, person);
      await h.register(competition, person);
      // The entry that will be answered SECOND is proposed FIRST: the proposal order must never decide anything.
      const claims: Record<string, string> = {};
      const typed = aFirst ? [[entryB, captainB], [entryA, captainA]] as const : [[entryA, captainA], [entryB, captainB]] as const;
      for (const [entry, captain] of typed) claims[entry.entryId] = (await rpc("propose_lifetime_entry_roster_claims_atomically", proposeClaims(entry.entryId, captain, [person.gamingMemberId])))[0].competition_lifetime_roster_claim_id;
      const answered = aFirst ? [entryA, entryB] : [entryB, entryA];
      const outcomes = await arrivingInOrder(holdPeople([person.gamingMemberId]), answered.map((entry) => () => settle("decide_lifetime_entry_roster_claim_atomically", claimDecision(claims[entry.entryId], person))), "two acceptances");
      onlyCodedRefusals(outcomes);
      expect(outcomes[0].ok, "the first acceptance to arrive succeeds").toBe(true);
      expect(refusals(outcomes)).toEqual(["LIFETIME_PERSON_ALREADY_CLAIMED"]);
      expect((await acceptedFor(competition.competitionId, person)).map((r) => r.competition_team_id)).toEqual([answered[0].entryId]);
    }
  });

  it("simultaneous third-team membership: with two memberships allowed, exactly one of two simultaneous acceptances succeeds", async () => {
    const [capOne, capTwo, capThree] = await h.newPeople(3, "Cap");
    const [t1, t2, t3] = [await h.createTeam(capOne), await h.createTeam(capTwo), await h.createTeam(capThree)];
    for (let i = 0; i < 8; i++) {
      const [person] = await h.newPeople(1, `Third${i}`);
      await h.addMember(t1.teamId, capOne, person);
      const offers = await Promise.all([t2, t3].map((t, k) => one("propose_lifetime_team_membership_atomically", offerArgs(t.teamId, [capTwo, capThree][k], person))));
      const outcomes = await racing([person.gamingMemberId], () => Promise.all(offers.map((o) => settle("decide_lifetime_team_membership_atomically", acceptMembership(o.lifetime_team_membership_id, person)))), 2);
      onlyCodedRefusals(outcomes);
      expect(successes(outcomes)).toBe(1);
      expect(refusals(outcomes)).toEqual(["LIFETIME_MEMBERSHIP_CAP_REACHED"]);
      expect(await activeCount(person)).toBe(2);
    }
  });

  it("simultaneous leadership and membership changes: a person cannot end up leading one team and belonging to another — whichever arrives first wins, the other gets its own refusal", async () => {
    const [capOne, capTwo] = await h.newPeople(2, "Cap");
    const [t1, t2] = [await h.createTeam(capOne), await h.createTeam(capTwo)];
    for (const seatFirst of [true, false, true, false]) {
      const [person] = await h.newPeople(1, `Lead${seatFirst ? "Seat" : "Team"}`);
      await h.addMember(t1.teamId, capOne, person);
      const seat = await one("offer_lifetime_team_leadership_atomically", offerArgs(t1.teamId, capOne, person));
      const invitation = await one("propose_lifetime_team_membership_atomically", offerArgs(t2.teamId, capTwo, person));
      const takeSeat = () => settle("decide_lifetime_team_leadership_atomically", { p_lifetime_team_leadership_id: seat.lifetime_team_leadership_id, p_actor_gaming_member_id: person.gamingMemberId, p_decision: "ACCEPT" });
      const joinOther = () => settle("decide_lifetime_team_membership_atomically", acceptMembership(invitation.lifetime_team_membership_id, person));
      const outcomes = await arrivingInOrder(holdPeople([person.gamingMemberId]), seatFirst ? [takeSeat, joinOther] : [joinOther, takeSeat], "seat versus membership");
      onlyCodedRefusals(outcomes);
      expect(outcomes[0].ok).toBe(true);
      // The seat came first: the person leads, so joining elsewhere is refused. The membership came first: the person belongs elsewhere, so the seat is refused.
      expect(refusals(outcomes)).toEqual([seatFirst ? "LIFETIME_LEADER_CANNOT_JOIN_OTHER_TEAM" : "LIFETIME_LEADER_MUST_BELONG_TO_ONE_TEAM"]);
      const leads = (await rawQuery("select 1 from lifetime_team_leaderships where gaming_member_id = $1 and status = 'ACTIVE'", [person.gamingMemberId])).length;
      expect(leads).toBe(seatFirst ? 1 : 0);
      expect(await activeCount(person)).toBe(seatFirst ? 1 : 2);
      // The shared team keeps its seat between rounds, so put it back: a seat offer the person never took is withdrawn, a seat they took is removed by the captain.
      if (seatFirst) await one("end_lifetime_team_leadership_atomically", { p_lifetime_team_id: t1.teamId, p_actor_gaming_member_id: capOne.gamingMemberId });
      else await one("withdraw_lifetime_team_offer_atomically", { p_offer_kind: "LEADERSHIP", p_offer_id: seat.lifetime_team_leadership_id, p_actor_gaming_member_id: capOne.gamingMemberId });
    }
  });

  for (const acceptFirst of [true, false]) {
    it(`a person already on one team who accepts an invitation while a leader accepts their request for a third (${acceptFirst ? "the person's acceptance" : "the leader's decision"} arrives first): exactly one succeeds, the person ends on exactly two`, async () => {
      const [capOne, capTwo, capThree] = await h.newPeople(3, "Cap");
      const [t1, t2, t3] = [await h.createTeam(capOne), await h.createTeam(capTwo), await h.createTeam(capThree)];
      const [person] = await h.newPeople(1, `Cap${acceptFirst}`);
      await h.addMember(t1.teamId, capOne, person); // one membership already: one more is allowed, a third is not
      const invitation = await one("propose_lifetime_team_membership_atomically", offerArgs(t2.teamId, capTwo, person));
      const request = await one("propose_lifetime_team_membership_atomically", offerArgs(t3.teamId, person, person));
      const accept = () => settle("decide_lifetime_team_membership_atomically", acceptMembership(invitation.lifetime_team_membership_id, person));
      const decideRequest = () => settle("decide_lifetime_team_membership_atomically", acceptMembership(request.lifetime_team_membership_id, capThree));
      // Both racers lock the PERSON (the acceptance as the actor, the decision as the subject), so both queue on the one lock that is held.
      const outcomes = await arrivingInOrder(holdPeople([person.gamingMemberId]), acceptFirst ? [accept, decideRequest] : [decideRequest, accept], "invitation versus request");
      onlyCodedRefusals(outcomes);
      expect(outcomes[0].ok, "the racer that arrived first succeeds").toBe(true);
      expect(successes(outcomes)).toBe(1);
      // The leader who decides a request is never told WHY (it would disclose the person's other teams); the person accepting an invitation is told the cap.
      expect(refusals(outcomes)).toEqual([acceptFirst ? "LIFETIME_REQUEST_NOT_ACCEPTABLE" : "LIFETIME_MEMBERSHIP_CAP_REACHED"]);
      expect(await activeCount(person), "never a third team").toBe(2);
    });
  }

  it("two simultaneous creations by one person: exactly one team is made, the other is refused, and the person leads exactly one team", async () => {
    const [person] = await h.newPeople(1, "Founder");
    const outcomes = await arrivingInOrder(holdPeople([person.gamingMemberId]), [
      () => settle("create_lifetime_team_atomically", { p_creator_gaming_member_id: person.gamingMemberId, p_name: h.uniqueName("First Founded") }),
      () => settle("create_lifetime_team_atomically", { p_creator_gaming_member_id: person.gamingMemberId, p_name: h.uniqueName("Second Founded") }),
    ], "two creations");
    onlyCodedRefusals(outcomes);
    expect(outcomes[0].ok).toBe(true);
    expect(refusals(outcomes)).toEqual(["LIFETIME_LEADER_MUST_BELONG_TO_ONE_TEAM"]);
    if (outcomes[0].ok) h.trackTeam(outcomes[0].rows[0].lifetime_team_id);
    expect((await rawQuery("select count(*)::int n from lifetime_team_leaderships where gaming_member_id = $1 and status = 'ACTIVE'", [person.gamingMemberId]))[0].n).toBe(1);
  });

  it("the captain leaving while the sub-captain steps down: whichever arrives first decides, and the other is a coded refusal (a succession is never made from a stale sub-captain)", async () => {
    for (const captainFirst of [true, false]) {
      const team = await h.buildTeam(`Succession${captainFirst}`, 3);
      const [captain, sub] = [team.captain, team.subCaptain!];
      const leave = () => settle("end_lifetime_team_membership_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: captain.gamingMemberId, p_subject_gaming_member_id: captain.gamingMemberId, p_successor_gaming_member_id: sub.gamingMemberId });
      const stepDown = () => settle("end_lifetime_team_leadership_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: sub.gamingMemberId });
      // Only the sub-captain's lock is held: it is the one lock BOTH racers need, so they are served strictly in the order they queued on it.
      const outcomes = await arrivingInOrder(holdPeople([sub.gamingMemberId]), captainFirst ? [leave, stepDown] : [stepDown, leave], "succession versus step-down");
      onlyCodedRefusals(outcomes);
      expect(outcomes[0].ok).toBe(true);
      const roles = await rawQuery("select role, gaming_member_id from lifetime_team_leaderships where lifetime_team_id = $1 and status = 'ACTIVE' order by role", [team.teamId]);
      if (captainFirst) {
        // The sub-captain became the captain, so there is no sub-captain seat left to step down from.
        expect(refusals(outcomes)).toEqual(["LIFETIME_SEAT_EMPTY"]);
        expect(roles).toEqual([{ role: "CAPTAIN", gaming_member_id: sub.gamingMemberId }]);
      } else {
        // The sub-captain stepped down first: the captain peeked at a sub-captain who is gone by the time it holds its locks.
        expect(refusals(outcomes)).toEqual(["LIFETIME_CONCURRENT_CHANGE"]);
        expect(roles).toEqual([{ role: "CAPTAIN", gaming_member_id: captain.gamingMemberId }]);
      }
    }
  });

  it("the captain leaving with the DEFAULT successor takes the sub-captain's person lock BEFORE the team row (the peeked seat holder is in its lock list: person, then team)", async () => {
    const team = await h.buildTeam("SuccessionDefault", 3);
    const [captain, sub] = [team.captain, team.subCaptain!];
    // No p_successor_gaming_member_id: the sub-captain is known only by the PEEK. Only the sub-captain's lock is held, so the leave must wait on it.
    const leave = () => settle("end_lifetime_team_membership_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: captain.gamingMemberId, p_subject_gaming_member_id: captain.gamingMemberId });
    const teamRowIsFree = async () => {
      // While the leave is queued on the person lock it must hold NOTHING of the team yet: a NOWAIT lock on the team row succeeds. (A leave that took the team first
      // and met the sub-captain's person lock only inside the seat guard would hold the row here — and could deadlock against an operation that takes person, then team.)
      const refusal = await violation("select 1 from lifetime_teams where lifetime_team_id = $1 for update nowait", [team.teamId]);
      expect(refusal, "the queued leave has not taken the team row").toBeNull();
    };
    const outcome = await racing([sub.gamingMemberId], leave, 1, teamRowIsFree);
    expect(outcome.ok, "the leave succeeds once the lock is released").toBe(true);
    const roles = await rawQuery("select role, gaming_member_id from lifetime_team_leaderships where lifetime_team_id = $1 and status = 'ACTIVE' order by role", [team.teamId]);
    expect(roles).toEqual([{ role: "CAPTAIN", gaming_member_id: sub.gamingMemberId }]);
  });
});

// =============================================================================================================================================
describe("[2] claims, withdrawals and the freeze", () => {
  // Teams are built ONCE; each race gets its own competition, so the same people are claimed in a fresh competition each time.
  let teamA: BuiltTeam;
  let teamB: BuiltTeam;
  const ensureTeams = async () => {
    if (!teamA) {
      teamA = await h.buildTeam("RaceA", 6);
      teamB = await h.buildTeam("RaceB", 6);
    }
  };
  async function rostered(label: string) {
    await ensureTeams();
    const competition = await h.setUpCompetition(label);
    const entryA = await h.enterTeam(competition, teamA);
    const entryB = await h.enterTeam(competition, teamB);
    await h.approveEntries(competition, entryA.entryId, entryB.entryId); // UG-CR-GATE-CFM-004: the freeze counts only ACCEPTED entries
    const claimsA = await h.rosterUp(entryA.entryId, teamA.captain, competition, teamA.everyone);
    const claimsB = await h.rosterUp(entryB.entryId, teamB.captain, competition, teamB.everyone);
    return { competition, entryA, entryB, claimsA, claimsB };
  }
  const freezeArgs = (c: LifetimeTestCompetition) => ({ p_competition_id: c.competitionId, p_organizer_gaming_member_id: c.organizer.gamingMemberId });
  const freezeCall = (c: LifetimeTestCompetition) => () => settle("freeze_lifetime_competition_entries_atomically", freezeArgs(c));

  it("a leader withdrawing a proposal while the person accepts it: whichever arrives first decides, the other is refused, and a claim is never left accepted by nobody", async () => {
    await ensureTeams();
    const competition = await h.setUpCompetition("RaceWithdrawAccept");
    const entry = await h.enterTeam(competition, teamA);
    const outsider = teamA.members[0];
    await h.register(competition, outsider);
    for (const acceptFirst of [true, false, true, false]) {
      const [claim] = await rpc("propose_lifetime_entry_roster_claims_atomically", proposeClaims(entry.entryId, teamA.captain, [outsider.gamingMemberId]));
      const id = claim.competition_lifetime_roster_claim_id as string;
      const accept = () => settle("decide_lifetime_entry_roster_claim_atomically", claimDecision(id, outsider));
      const withdraw = () => settle("release_lifetime_entry_roster_claim_atomically", { p_competition_lifetime_roster_claim_id: id, p_actor_gaming_member_id: teamA.captain.gamingMemberId });
      const outcomes = await arrivingInOrder(holdPeople([outsider.gamingMemberId]), acceptFirst ? [accept, withdraw] : [withdraw, accept], "accept versus withdraw");
      onlyCodedRefusals(outcomes);
      const [row] = await rawQuery("select status, release_reason from competition_lifetime_roster_claims where competition_lifetime_roster_claim_id = $1", [id]);
      if (acceptFirst) {
        expect(outcomes.every((o) => o.ok), "accepted, then removed by the leader").toBe(true);
        expect(row).toEqual({ status: "REMOVED", release_reason: "LEADER_REMOVED" });
      } else {
        expect(refusals(outcomes), "withdrawn first: nothing is left to accept").toEqual(["LIFETIME_CLAIM_NOT_OPEN"]);
        expect(row).toEqual({ status: "WITHDRAWN", release_reason: "LEADER_WITHDREW_PROPOSAL" });
      }
      expect(await acceptedFor(competition.competitionId, outsider)).toHaveLength(0);
    }
  });

  for (const releaseFirst of [true, false]) {
    it(`a person withdrawing a claim while accepting another entry's (${releaseFirst ? "withdrawal" : "acceptance"} arrives first): never two accepted claims, and the final state follows the order`, async () => {
      const s = await rostered(`RaceSwap${releaseFirst ? "Release" : "Accept"}`);
      // A person who is on BOTH teams and holds the claim on A, with a second proposal on B.
      const swapper = teamA.members[1];
      const memberships = await rawQuery("select lifetime_team_id from lifetime_team_memberships where gaming_member_id = $1 and status = 'ACTIVE'", [swapper.gamingMemberId]);
      if (!memberships.some((m) => m.lifetime_team_id === teamB.teamId)) await h.addMember(teamB.teamId, teamB.captain, swapper);
      const [claimB] = await rpc("propose_lifetime_entry_roster_claims_atomically", proposeClaims(s.entryB.entryId, teamB.captain, [swapper.gamingMemberId]));
      const release = () => settle("release_lifetime_entry_roster_claim_atomically", { p_competition_lifetime_roster_claim_id: s.claimsA[swapper.gamingMemberId], p_actor_gaming_member_id: swapper.gamingMemberId });
      const accept = () => settle("decide_lifetime_entry_roster_claim_atomically", claimDecision(claimB.competition_lifetime_roster_claim_id, swapper));
      const outcomes = await arrivingInOrder(holdPeople([swapper.gamingMemberId]), releaseFirst ? [release, accept] : [accept, release], "swap");
      onlyCodedRefusals(outcomes);
      const held = (await acceptedFor(s.competition.competitionId, swapper)).map((r) => r.competition_team_id);
      if (releaseFirst) {
        expect(outcomes.every((o) => o.ok)).toBe(true);
        expect(held).toEqual([s.entryB.entryId]); // withdrew from A, then accepted B
      } else {
        expect(refusals(outcomes)).toEqual(["LIFETIME_PERSON_ALREADY_CLAIMED"]); // still held by A when B was answered
        expect(outcomes[1].ok).toBe(true); // the withdrawal itself always succeeds
        expect(held).toEqual([]);
      }
    });
  }

  for (const freezeFirst of [true, false]) {
    it(`the freeze racing with a person's withdrawal (${freezeFirst ? "freeze" : "withdrawal"} arrives first): the frozen count equals the claims that are accepted, and the order decides which`, async () => {
      const s = await rostered(`RaceFreezeWithdraw${freezeFirst ? "Freeze" : "Withdraw"}`);
      await h.passDeadline(s.competition.competitionId);
      const victim = teamA.members[2];
      const withdraw = () => settle("release_lifetime_entry_roster_claim_atomically", { p_competition_lifetime_roster_claim_id: s.claimsA[victim.gamingMemberId], p_actor_gaming_member_id: victim.gamingMemberId });
      const outcomes = await arrivingInOrder(holdCompetition(s.competition.competitionId), freezeFirst ? [freezeCall(s.competition), withdraw] : [withdraw, freezeCall(s.competition)], "freeze versus withdrawal");
      onlyCodedRefusals(outcomes);
      const [freezeOutcome, withdrawOutcome] = freezeFirst ? outcomes : [outcomes[1], outcomes[0]];
      expect(freezeOutcome.ok, "the freeze succeeds either way: a roster of 6 stays at or above the minimum of 5").toBe(true);
      const [freeze] = await rawQuery("select claim_count from competition_lifetime_freezes where competition_id = $1", [s.competition.competitionId]);
      const [accepted] = await rawQuery("select count(*)::int n from competition_lifetime_roster_claims where competition_id = $1 and status = 'ACCEPTED'", [s.competition.competitionId]);
      expect(freeze.claim_count).toBe(accepted.n);
      if (freezeFirst) {
        expect(withdrawOutcome).toMatchObject({ ok: false, refusal: "LIFETIME_ENTRIES_FROZEN" });
        expect(freeze.claim_count).toBe(12);
      } else {
        expect(withdrawOutcome.ok).toBe(true);
        expect(freeze.claim_count).toBe(11);
      }
    });
  }

  for (const freezeFirst of [true, false]) {
    it(`the freeze racing with an entry's withdrawal (${freezeFirst ? "freeze" : "withdrawal"} arrives first): a frozen entry count never includes a withdrawn entry`, async () => {
      const s = await rostered(`RaceFreezeEntry${freezeFirst ? "Freeze" : "Withdraw"}`);
      await h.passDeadline(s.competition.competitionId);
      const withdraw = () => settle("withdraw_lifetime_competition_entry_atomically", { p_competition_team_id: s.entryA.entryId, p_actor_gaming_member_id: teamA.captain.gamingMemberId });
      const outcomes = await arrivingInOrder(holdCompetition(s.competition.competitionId), freezeFirst ? [freezeCall(s.competition), withdraw] : [withdraw, freezeCall(s.competition)], "freeze versus entry withdrawal");
      onlyCodedRefusals(outcomes);
      const live = (await rawQuery("select count(*)::int n from competition_teams where competition_id = $1 and entry_flow = 'LIFETIME' and status <> 'REJECTED'", [s.competition.competitionId]))[0].n;
      const [freeze] = await rawQuery("select entry_count, claim_count from competition_lifetime_freezes where competition_id = $1", [s.competition.competitionId]);
      if (freezeFirst) {
        expect(outcomes[0].ok).toBe(true);
        expect(outcomes[1]).toMatchObject({ ok: false, refusal: "LIFETIME_ENTRIES_FROZEN" }); // the withdrawal came after the freeze
        expect(freeze).toMatchObject({ entry_count: 2, claim_count: 12 });
        expect(live).toBe(2);
      } else {
        expect(outcomes[0].ok).toBe(true);
        expect(outcomes[1]).toMatchObject({ ok: false, refusal: "LIFETIME_FREEZE_NOT_ENOUGH_ENTRIES" }); // one live entry is not enough to freeze
        expect(freeze).toBeUndefined();
        expect(live).toBe(1);
      }
    });
  }

  for (const freezeFirst of [true, false]) {
    it(`the freeze racing with a person leaving the team (${freezeFirst ? "freeze" : "departure"} arrives first): the claim is released before it or dated AFTER it — never both, never neither`, async () => {
      const s = await rostered(`RaceFreezeLeave${freezeFirst ? "Freeze" : "Leave"}`);
      await h.passDeadline(s.competition.competitionId);
      const leaver = teamB.members[2];
      const leave = () => settle("end_lifetime_team_membership_atomically", { p_lifetime_team_id: teamB.teamId, p_actor_gaming_member_id: leaver.gamingMemberId, p_subject_gaming_member_id: leaver.gamingMemberId });
      const outcomes = await arrivingInOrder(holdCompetition(s.competition.competitionId), freezeFirst ? [freezeCall(s.competition), leave] : [leave, freezeCall(s.competition)], "freeze versus departure");
      onlyCodedRefusals(outcomes);
      expect(outcomes.every((o) => o.ok)).toBe(true);
      const [claim] = await rawQuery("select status, departed_at, release_reason, released_at from competition_lifetime_roster_claims where competition_lifetime_roster_claim_id = $1", [s.claimsB[leaver.gamingMemberId]]);
      const [freeze] = await rawQuery("select claim_count, frozen_at from competition_lifetime_freezes where competition_id = $1", [s.competition.competitionId]);
      if (freezeFirst) {
        expect(claim.status).toBe("ACCEPTED");
        expect(claim.departed_at).not.toBeNull(); // the freeze came first: the departure is dated, the claim stays
        // The departure is dated when it was RECORDED (after the lock), never before the freeze it was serialized behind.
        expect(new Date(claim.departed_at).getTime(), "a departure recorded after the freeze is dated at or after it").toBeGreaterThanOrEqual(new Date(freeze.frozen_at).getTime());
        expect(freeze.claim_count).toBe(12);
      } else {
        expect(claim).toMatchObject({ status: "WITHDRAWN", departed_at: null, release_reason: "LEFT_TEAM" }); // the departure came first: released, and not counted
        expect(new Date(claim.released_at).getTime()).toBeLessThanOrEqual(new Date(freeze.frozen_at).getTime());
        expect(freeze.claim_count).toBe(11);
      }
      // ONE act, ONE moment (R2-F3): the membership period, its audit event and the claim all agree with the order the competition lock produced. Behind the freeze the
      // person was still counted on the frozen roster, so the period cannot have ended before the freeze; ahead of it the period ended before the freeze counted.
      const [period] = await rawQuery("select lifetime_team_membership_id, ended_at from lifetime_team_memberships where lifetime_team_id = $1 and gaming_member_id = $2 and status = 'ENDED' order by seq desc limit 1", [teamB.teamId, leaver.gamingMemberId]);
      const [ended] = await rawQuery("select occurred_at from lifetime_team_events where lifetime_team_id = $1 and event_type = 'MEMBERSHIP_ENDED' and related_id = $2", [teamB.teamId, period.lifetime_team_membership_id]);
      const frozenAt = new Date(freeze.frozen_at).getTime();
      if (freezeFirst) {
        expect(new Date(period.ended_at).getTime(), "the period of a person the freeze still counted ends at or after the freeze").toBeGreaterThanOrEqual(frozenAt);
        expect(new Date(ended.occurred_at).getTime(), "and so does its audit event").toBeGreaterThanOrEqual(frozenAt);
        expect(new Date(period.ended_at).getTime(), "and the claim is dated at the same moment").toBe(new Date(claim.departed_at).getTime());
      } else {
        expect(new Date(period.ended_at).getTime(), "a person who left first ended their period before the freeze counted").toBeLessThanOrEqual(frozenAt);
        expect(new Date(ended.occurred_at).getTime()).toBeLessThanOrEqual(frozenAt);
      }
      // Put the person back for the next test (a new period; the history keeps the old one).
      await h.addMember(teamB.teamId, teamB.captain, leaver);
    });
  }

  for (const freezeFirst of [true, false]) {
    it(`the freeze racing with a person's acceptance (${freezeFirst ? "freeze" : "acceptance"} arrives first): the acceptance is refused either way, no claim is accepted after the freeze, and the open proposal is settled`, async () => {
      const s = await rostered(`RaceFreezeAccept${freezeFirst ? "Freeze" : "Accept"}`);
      const [late] = await h.newPeople(1, "Late");
      await h.addMember(teamA.teamId, teamA.captain, late);
      await h.register(s.competition, late);
      const [open] = await rpc("propose_lifetime_entry_roster_claims_atomically", proposeClaims(s.entryA.entryId, teamA.captain, [late.gamingMemberId]));
      await h.passDeadline(s.competition.competitionId);
      const accept = () => settle("decide_lifetime_entry_roster_claim_atomically", claimDecision(open.competition_lifetime_roster_claim_id, late));
      const outcomes = await arrivingInOrder(holdCompetition(s.competition.competitionId), freezeFirst ? [freezeCall(s.competition), accept] : [accept, freezeCall(s.competition)], "freeze versus acceptance");
      onlyCodedRefusals(outcomes);
      const [freezeOutcome, acceptOutcome] = freezeFirst ? outcomes : [outcomes[1], outcomes[0]];
      expect(freezeOutcome.ok).toBe(true);
      // The deadline has passed, so an acceptance can never succeed. Behind the freeze the proposal has already been settled by it (expired), so there is nothing left to
      // answer; ahead of the freeze the acceptance meets the closed deadline.
      expect(acceptOutcome).toMatchObject({ ok: false, refusal: freezeFirst ? "LIFETIME_CLAIM_NOT_OPEN" : "TEAM_REGISTRATION_NOT_OPEN" });
      const [freeze] = await rawQuery("select claim_count, frozen_at from competition_lifetime_freezes where competition_id = $1", [s.competition.competitionId]);
      expect(freeze.claim_count).toBe(12);
      const [counts] = await rawQuery("select count(*) filter (where status = 'ACCEPTED')::int accepted, max(accepted_at) latest from competition_lifetime_roster_claims where competition_id = $1", [s.competition.competitionId]);
      expect(counts.accepted).toBe(freeze.claim_count);
      expect(new Date(counts.latest).getTime()).toBeLessThanOrEqual(new Date(freeze.frozen_at).getTime());
      expect((await rawQuery("select status from competition_lifetime_roster_claims where competition_lifetime_roster_claim_id = $1", [open.competition_lifetime_roster_claim_id]))[0].status).toBe("EXPIRED");
      await one("end_lifetime_team_membership_atomically", { p_lifetime_team_id: teamA.teamId, p_actor_gaming_member_id: teamA.captain.gamingMemberId, p_subject_gaming_member_id: late.gamingMemberId });
    });
  }

  for (const acceptFirst of [true, false]) {
    it(`a person leaving the team while accepting a claim for it (${acceptFirst ? "acceptance" : "departure"} arrives first): no accepted claim is ever left without a member`, async () => {
      await ensureTeams();
      const competition = await h.setUpCompetition(`RaceLeaveAccept${acceptFirst ? "Accept" : "Leave"}`);
      const entry = await h.enterTeam(competition, teamB);
      const person = teamB.members[3];
      await h.register(competition, person);
      const [claim] = await rpc("propose_lifetime_entry_roster_claims_atomically", proposeClaims(entry.entryId, teamB.captain, [person.gamingMemberId]));
      const accept = () => settle("decide_lifetime_entry_roster_claim_atomically", claimDecision(claim.competition_lifetime_roster_claim_id, person));
      const leave = () => settle("end_lifetime_team_membership_atomically", { p_lifetime_team_id: teamB.teamId, p_actor_gaming_member_id: person.gamingMemberId, p_subject_gaming_member_id: person.gamingMemberId });
      const outcomes = await arrivingInOrder(holdPeople([person.gamingMemberId]), acceptFirst ? [accept, leave] : [leave, accept], "acceptance versus departure");
      onlyCodedRefusals(outcomes);
      const [row] = await rawQuery("select status, release_reason from competition_lifetime_roster_claims where competition_lifetime_roster_claim_id = $1", [claim.competition_lifetime_roster_claim_id]);
      if (acceptFirst) {
        expect(outcomes.every((o) => o.ok)).toBe(true); // accepted, then released with the departure
        expect(row).toEqual({ status: "WITHDRAWN", release_reason: "LEFT_TEAM" });
      } else {
        expect(refusals(outcomes)).toEqual(["LIFETIME_CLAIM_NOT_OPEN"]); // the departure withdrew the proposal first
        expect(row).toEqual({ status: "WITHDRAWN", release_reason: "LEFT_TEAM" });
      }
      const orphan = await rawQuery(
        `select 1 from competition_lifetime_roster_claims c where c.competition_id = $1 and c.status = 'ACCEPTED' and c.departed_at is null
           and not exists (select 1 from lifetime_team_memberships m where m.lifetime_team_id = c.lifetime_team_id and m.gaming_member_id = c.gaming_member_id and m.status = 'ACTIVE')`, [competition.competitionId]);
      expect(orphan).toHaveLength(0);
      await h.addMember(teamB.teamId, teamB.captain, person); // back on the team for the next test
    });
  }
});

// =============================================================================================================================================
describe("[3] a seeded random storm: many different operations at once, invariants after every round", () => {
  function prng(seed: number) {
    let a = seed >>> 0;
    return () => {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const SEED = 20261120;

  it(`keeps the team-level invariants (cap, one seat, seats and offers that outlive nobody, one accepted claim per person) through 14 rounds of 10 concurrent random operations (seed ${SEED}), and never fails with a raw database error`, async () => {
    const random = prng(SEED);
    const pick = <T,>(items: T[]): T => items[Math.floor(random() * items.length)];
    const people = await h.newPeople(10, "Storm");
    const captains = people.slice(0, 4);
    const others = people.slice(4);
    const teams = [] as Array<{ teamId: string; name: string; captain: Person }>;
    for (const captain of captains) teams.push({ ...(await h.createTeam(captain)), captain });
    // Seed: every team has two members before it can enter; some people are on two teams.
    for (let i = 0; i < 4; i++) {
      await h.addMember(teams[i].teamId, captains[i], others[i % others.length]);
      await h.addMember(teams[i].teamId, captains[i], others[(i + 2) % others.length]);
    }
    const competitions = [await h.setUpCompetition("StormA"), await h.setUpCompetition("StormB")];
    const entries: Array<{ competition: LifetimeTestCompetition; teamIndex: number; entryId: string }> = [];
    for (const competition of competitions) {
      await h.register(competition, ...people);
      for (let i = 0; i < 4; i++) {
        const entry = await h.enterTeam(competition, { teamId: teams[i].teamId, name: teams[i].name, captain: captains[i], subCaptain: null, members: [], everyone: [] });
        entries.push({ competition, teamIndex: i, entryId: entry.entryId });
      }
    }
    const teamIds = teams.map((t) => t.teamId);
    const competitionIds = competitions.map((c) => c.competitionId);
    const byId = new Map(people.map((p) => [p.gamingMemberId, p]));
    const captainOf = async (teamId: string) => byId.get((await rawQuery("select gaming_member_id from lifetime_team_leaderships where lifetime_team_id = $1 and role = 'CAPTAIN' and status = 'ACTIVE'", [teamId]))[0]?.gaming_member_id) ?? null;

    const failures: string[] = [];
    let attempted = 0;
    let succeeded = 0;
    for (let round = 0; round < 14; round++) {
      const pendingMemberships = await rawQuery("select lifetime_team_membership_id id, lifetime_team_id team, gaming_member_id subject, initiated_by_side side from lifetime_team_memberships where status = 'PENDING' and lifetime_team_id = any($1)", [teamIds]);
      const activeMemberships = await rawQuery("select lifetime_team_id team, gaming_member_id subject from lifetime_team_memberships where status = 'ACTIVE' and lifetime_team_id = any($1)", [teamIds]);
      const pendingSeats = await rawQuery("select lifetime_team_leadership_id id, lifetime_team_id team, gaming_member_id subject from lifetime_team_leaderships where status = 'PENDING' and lifetime_team_id = any($1)", [teamIds]);
      const openClaims = await rawQuery("select competition_lifetime_roster_claim_id id, gaming_member_id subject, lifetime_team_id team, status, competition_team_id entry from competition_lifetime_roster_claims where status in ('PROPOSED', 'ACCEPTED') and competition_id = any($1)", [competitionIds]);
      const calls: Array<() => Promise<Outcome>> = [];
      for (let n = 0; n < 10; n++) {
        const kind = Math.floor(random() * 11);
        const team = pick(teams);
        const captain = (await captainOf(team.teamId)) ?? team.captain;
        const person = pick(others);
        const member = activeMemberships.length ? byId.get(pick(activeMemberships).subject as string) ?? person : person;
        const entry = pick(entries);
        switch (kind) {
          case 0: calls.push(() => settle("propose_lifetime_team_membership_atomically", offerArgs(team.teamId, captain, person))); break;
          case 1: calls.push(() => settle("propose_lifetime_team_membership_atomically", offerArgs(team.teamId, person, person))); break;
          case 2: case 3: {
            if (!pendingMemberships.length) break;
            const m = pick(pendingMemberships);
            const actor = m.side === "TEAM" ? byId.get(m.subject as string)! : ((await captainOf(m.team as string)) ?? captain);
            calls.push(() => settle("decide_lifetime_team_membership_atomically", { p_lifetime_team_membership_id: m.id, p_actor_gaming_member_id: actor.gamingMemberId, p_decision: random() < 0.8 ? "ACCEPT" : "DECLINE" }));
            break;
          }
          case 4: calls.push(() => settle("offer_lifetime_team_leadership_atomically", offerArgs(team.teamId, captain, member))); break;
          case 5: {
            if (!pendingSeats.length) break;
            const seat = pick(pendingSeats);
            calls.push(() => settle("decide_lifetime_team_leadership_atomically", { p_lifetime_team_leadership_id: seat.id, p_actor_gaming_member_id: seat.subject, p_decision: random() < 0.8 ? "ACCEPT" : "DECLINE" }));
            break;
          }
          case 6: calls.push(() => settle("end_lifetime_team_leadership_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: member.gamingMemberId })); break;
          case 7: calls.push(() => settle("end_lifetime_team_membership_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: member.gamingMemberId, p_subject_gaming_member_id: member.gamingMemberId })); break;
          case 8: {
            const ids = [member.gamingMemberId, person.gamingMemberId].filter((v, i, a) => a.indexOf(v) === i);
            const entryCaptain = (await captainOf(teams[entry.teamIndex].teamId)) ?? captains[entry.teamIndex];
            calls.push(() => settle("propose_lifetime_entry_roster_claims_atomically", proposeClaims(entry.entryId, entryCaptain, ids)));
            break;
          }
          case 9: {
            const proposed = openClaims.filter((c) => c.status === "PROPOSED");
            if (!proposed.length) break;
            const claim = pick(proposed);
            calls.push(() => settle("decide_lifetime_entry_roster_claim_atomically", claimDecision(claim.id, byId.get(claim.subject as string)!, random() < 0.85 ? "ACCEPT" : "REJECT")));
            break;
          }
          default: {
            if (!openClaims.length) break;
            const claim = pick(openClaims);
            const asPerson = random() < 0.5;
            const actor = asPerson ? byId.get(claim.subject as string)! : ((await captainOf(claim.team as string)) ?? captain);
            calls.push(() => settle("release_lifetime_entry_roster_claim_atomically", { p_competition_lifetime_roster_claim_id: claim.id, p_actor_gaming_member_id: actor.gamingMemberId }));
          }
        }
      }
      const outcomes = await Promise.all(calls.map((call) => call()));
      attempted += outcomes.length;
      succeeded += successes(outcomes);
      for (const o of outcomes) if (!o.ok && !(o.code === "P0001" && o.refusal)) failures.push(`round ${round}: ${o.code} ${o.message}`);

      const cap = await rawQuery("select gaming_member_id from lifetime_team_memberships where status = 'ACTIVE' and not is_legacy and lifetime_team_id = any($1) group by 1 having count(*) > 2", [teamIds]);
      const leaderElsewhere = await rawQuery(
        `select l.gaming_member_id from lifetime_team_leaderships l join lifetime_team_memberships m on m.gaming_member_id = l.gaming_member_id and m.status = 'ACTIVE' and not m.is_legacy and m.lifetime_team_id <> l.lifetime_team_id
          where l.status = 'ACTIVE' and not l.is_legacy and l.lifetime_team_id = any($1)`, [teamIds]);
      const leaderNotMember = await rawQuery(
        `select l.gaming_member_id from lifetime_team_leaderships l where l.status = 'ACTIVE' and l.lifetime_team_id = any($1)
            and not exists (select 1 from lifetime_team_memberships m where m.lifetime_team_id = l.lifetime_team_id and m.gaming_member_id = l.gaming_member_id and m.status = 'ACTIVE')`, [teamIds]);
      const seats = await rawQuery(
        `select t.id from unnest($1::uuid[]) t(id) where (select count(*) from lifetime_team_leaderships where lifetime_team_id = t.id and role = 'CAPTAIN' and status = 'ACTIVE') <> 1
            or (select count(*) from lifetime_team_leaderships where lifetime_team_id = t.id and role = 'SUB_CAPTAIN' and status = 'ACTIVE') > 1`, [teamIds]);
      const doubleClaim = await rawQuery("select competition_id, gaming_member_id from competition_lifetime_roster_claims where status = 'ACCEPTED' and competition_id = any($1) group by 1, 2 having count(*) > 1", [competitionIds]);
      const orphanClaim = await rawQuery(
        `select c.competition_lifetime_roster_claim_id from competition_lifetime_roster_claims c where c.status = 'ACCEPTED' and c.departed_at is null and c.competition_id = any($1)
            and not exists (select 1 from lifetime_team_memberships m where m.lifetime_team_id = c.lifetime_team_id and m.gaming_member_id = c.gaming_member_id and m.status = 'ACTIVE')`, [competitionIds]);
      // The two invariants the first correction round added at the team level (a pending seat offer does not outlive the invitee's membership; an invitation does not
      // outlive the seat of the leader who made it). They are sound (no false positive in a model of half a million operations) but only SOME seeds reach their states —
      // the fixed seed does not — so they are cheap extra coverage, not the pin: the deterministic tests of [F2], [F3] and R2 are. The entry-level corrections (one team per
      // person per competition, the freeze dating) are pinned by their own deterministic tests too: this storm creates its entries once, by four fixed captains, and never
      // freezes, so it cannot reach them.
      const staleSeatOffer = await rawQuery(
        `select l.lifetime_team_leadership_id from lifetime_team_leaderships l where l.status = 'PENDING' and l.lifetime_team_id = any($1)
            and not exists (select 1 from lifetime_team_memberships m where m.lifetime_team_id = l.lifetime_team_id and m.gaming_member_id = l.gaming_member_id and m.status = 'ACTIVE')`, [teamIds]);
      const staleInvitation = await rawQuery(
        `select m.lifetime_team_membership_id from lifetime_team_memberships m where m.status = 'PENDING' and m.initiated_by_side = 'TEAM' and m.lifetime_team_id = any($1)
            and not exists (select 1 from lifetime_team_leaderships l where l.lifetime_team_id = m.lifetime_team_id and l.gaming_member_id = m.initiated_by_gaming_member_id and l.status = 'ACTIVE')`, [teamIds]);
      expect({ round, cap, leaderElsewhere, leaderNotMember, seats, doubleClaim, orphanClaim, staleSeatOffer, staleInvitation })
        .toEqual({ round, cap: [], leaderElsewhere: [], leaderNotMember: [], seats: [], doubleClaim: [], orphanClaim: [], staleSeatOffer: [], staleInvitation: [] });
    }
    expect(failures, `raw failures: ${failures.join(" | ")}`).toEqual([]);
    expect(attempted).toBeGreaterThan(80);
    expect(succeeded).toBeGreaterThan(10);
  }, 600000);
});

// =============================================================================================================================================
describe("[4] mutation controls: take each invariant away and the same probe passes — so the tests above can fail", () => {
  it("[claims] without the unique index a person holds two accepted claims in one competition; with it the second is refused", async () => {
    const competition = await h.setUpCompetition("MutateClaims");
    const [captainA, captainB, shared] = await h.newPeople(3, "Mut");
    const [teamA, teamB] = [await h.createTeam(captainA), await h.createTeam(captainB)];
    await h.addMember(teamA.teamId, captainA, shared);
    await h.addMember(teamB.teamId, captainB, shared);
    const [fa, fb] = await h.newPeople(2, "MutFill");
    await h.addMember(teamA.teamId, captainA, fa);
    await h.addMember(teamB.teamId, captainB, fb);
    const asBuilt = (t: { teamId: string; name: string }, captain: Person): BuiltTeam => ({ ...t, captain, subCaptain: null, members: [], everyone: [] });
    const [entryA, entryB] = [await h.enterTeam(competition, asBuilt(teamA, captainA)), await h.enterTeam(competition, asBuilt(teamB, captainB))];
    const [claimA] = await rpc("propose_lifetime_entry_roster_claims_atomically", proposeClaims(entryA.entryId, captainA, [shared.gamingMemberId]));
    const [claimB] = await rpc("propose_lifetime_entry_roster_claims_atomically", proposeClaims(entryB.entryId, captainB, [shared.gamingMemberId]));
    const accept = (id: string) => `update competition_lifetime_roster_claims set status = 'ACCEPTED', accepted_at = now(), decided_at = now() where competition_lifetime_roster_claim_id = '${id}'`;
    // With the invariant in place the second acceptance is refused by the table.
    const withIndex = await rawTransaction(async (db) => {
      await db.query(accept(claimA.competition_lifetime_roster_claim_id));
      try { await db.query(accept(claimB.competition_lifetime_roster_claim_id)); return null; } catch (err) { return (err as { code?: string }).code; }
    });
    expect(withIndex).toBe("23505");
    // The control: the index named in the migration is what refuses it.
    const index = (await rawQuery("select indexname from pg_indexes where schemaname = 'public' and tablename = 'competition_lifetime_roster_claims' and indexdef ilike '%where%accepted%' and indexdef ilike '%competition_id%gaming_member_id%'"))[0]?.indexname as string;
    expect(index, "the one-accepted-claim-per-person index must exist").toBeTruthy();
    const withoutIndex = await rawTransaction(async (db) => {
      await db.query(`drop index public."${index}"`);
      await db.query(accept(claimA.competition_lifetime_roster_claim_id));
      await db.query(accept(claimB.competition_lifetime_roster_claim_id));
      return (await db.query("select count(*)::int n from competition_lifetime_roster_claims where competition_id = $1 and gaming_member_id = $2 and status = 'ACCEPTED'", [competition.competitionId, shared.gamingMemberId])).rows[0].n;
    });
    expect(withoutIndex, "without the index the same probe lets a person hold two claims").toBe(2);
  });

  it("[cap] without the membership guard a third membership is accepted; with it the same insert is refused", async () => {
    const [a, b, c, person] = await h.newPeople(4, "MutCap");
    const [t1, t2, t3] = [await h.createTeam(a), await h.createTeam(b), await h.createTeam(c)];
    await h.addMember(t1.teamId, a, person);
    await h.addMember(t2.teamId, b, person);
    const insert = `insert into lifetime_team_memberships (lifetime_team_id, gaming_member_id, status, initiated_by_side, initiated_by_gaming_member_id, joined_at, expires_at) values ('${t3.teamId}', '${person.gamingMemberId}', 'ACTIVE', 'PERSON', '${person.gamingMemberId}', now(), now() + interval '7 days')`;
    expect((await violation(insert))?.message).toMatch(/^LIFETIME_MEMBERSHIP_CAP_REACHED:/);
    const mutated = await rawTransaction(async (db) => {
      await db.query("alter table lifetime_team_memberships disable trigger user");
      await db.query(insert);
      return (await db.query("select count(*)::int n from lifetime_team_memberships where gaming_member_id = $1 and status = 'ACTIVE'", [person.gamingMemberId])).rows[0].n;
    });
    expect(mutated, "without the guard the cap is not held").toBe(3);
  });

  it("[leaders] without the leadership guard a person on two teams takes a seat; with it the same insert is refused", async () => {
    const [a, b, person] = await h.newPeople(3, "MutLead");
    const [t1, t2] = [await h.createTeam(a), await h.createTeam(b)];
    await h.addMember(t1.teamId, a, person);
    await h.addMember(t2.teamId, b, person);
    const insert = `insert into lifetime_team_leaderships (lifetime_team_id, gaming_member_id, role, status, offered_by_gaming_member_id, started_at) values ('${t1.teamId}', '${person.gamingMemberId}', 'SUB_CAPTAIN', 'ACTIVE', '${a.gamingMemberId}', now())`;
    expect((await violation(insert))?.message).toMatch(/^LIFETIME_LEADER_MUST_BELONG_TO_ONE_TEAM:/);
    const mutated = await rawTransaction(async (db) => {
      await db.query("alter table lifetime_team_leaderships disable trigger user");
      await db.query(insert);
      return (await db.query("select count(*)::int n from lifetime_team_leaderships where gaming_member_id = $1 and status = 'ACTIVE'", [person.gamingMemberId])).rows[0].n;
    });
    expect(mutated, "without the guard a person on two teams can lead one of them").toBe(1);
  });

  it("[entry snapshots] without the entry guard one direct write can rewrite an entry's name and force it to ACCEPTED; with it that write is refused", async () => {
    const competition = await h.setUpCompetition("MutateEntry");
    const team = await h.buildTeam("MutateEntryTeam", 4);
    const entry = await h.enterTeam(competition, team);
    const rewrite = `update competition_teams set name = 'Rewritten', status = 'ACCEPTED' where competition_team_id = '${entry.entryId}'`;
    expect(await violation(rewrite)).not.toBeNull();
    const mutated = await rawTransaction(async (db) => {
      await db.query("alter table competition_teams disable trigger user");
      await db.query(rewrite);
      return (await db.query("select name, status from competition_teams where competition_team_id = $1", [entry.entryId])).rows[0];
    });
    expect(mutated).toEqual({ name: "Rewritten", status: "ACCEPTED" });
  });

  it("[locks] every operation that changes a person's relationships takes the person locks BEFORE any competition or team work", async () => {
    const defs = await rawQuery(
      "select p.proname, pg_get_functiondef(p.oid) as def from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = any($1)",
      [["create_lifetime_team_atomically", "propose_lifetime_team_membership_atomically", "decide_lifetime_team_membership_atomically", "end_lifetime_team_membership_atomically", "offer_lifetime_team_leadership_atomically", "decide_lifetime_team_leadership_atomically", "end_lifetime_team_leadership_atomically", "decide_lifetime_entry_roster_claim_atomically", "release_lifetime_entry_roster_claim_atomically"]]);
    expect(defs).toHaveLength(9);
    for (const { proname, def } of defs) {
      const text = (def as string).replace(/--.*$/gm, "");
      const lock = text.indexOf("lifetime_lock_people(");
      expect(lock, `${proname} must take the person locks`).toBeGreaterThan(-1);
      for (const later of ["for update", "pg_advisory_xact_lock(hashtext('competition_scope"]) {
        const at = text.indexOf(later);
        if (at !== -1) expect(lock, `${proname}: person locks before "${later}"`).toBeLessThan(at);
      }
    }
  });
});
