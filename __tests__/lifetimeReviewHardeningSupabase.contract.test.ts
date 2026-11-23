import { randomBytes } from "node:crypto";

import { afterAll, describe, expect, it, vi } from "vitest";
import { loadEnv } from "vite";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";

import { registerForCompetition } from "../lib/gaming/competitions/registerForCompetition";
import { DAY, createHarness, type Person } from "./helpers/lifetimeContract";

/**
 * UG-CR-GATE-CFM-001 — the correction round after the six-lens adversarial review of the lifetime-team foundation. Every test here reproduces a defect the review
 * found (and two independent verifiers confirmed) against a real, disposable, loopback-only Postgres, and states the behaviour the foundation must have instead:
 *
 *   F1  a person may represent only ONE team in a competition — the captain and sub-captain an entry names count, not only the people on its roster
 *   F2  a pending sub-captain offer does not outlive the invitee's membership;  F3  a team-side offer or roster proposal does not outlive the leader who issued it
 *   F4  a direct write cannot forge, move or add an entry   F5  authorization comes before every lifecycle, state and membership answer
 *   F6  the audit trail is complete for a disband and dates a lapsed offer at its expiry   F7  the deadline instant is a coded refusal, never a raw CHECK failure
 *   F8  no browser or server role can read or move an identity sequence   F9  a leader deciding a request is not told which other teams the person belongs to
 *   F11 the legacy backfill converges (a later V1 approval is mirrored by a re-run)   F14 an unattested registration has its own, truthful refusal
 *   F22 a disband releases or dates the claims of a team whose competition was cancelled   F23 the backfill has no fail-open default
 *   F26 the freeze settles every proposal that is still open
 */

// The shared contract-test guard (UG-CR-GATE-079) runs before anything is constructed: no target that is not loopback is ever touched.
const supabaseUrl = loadEnv("development", process.cwd(), "").SUPABASE_URL;
requireLocalSupabase(supabaseUrl);
// Every scenario here builds real people and teams through the real operations, and the freeze scenarios wait for a registration deadline to pass: none of them is
// a unit test. One explicit budget for the whole file (the repo's other contract suites do the same), instead of the 5 s default that a slow machine or a parallel run can cross.
vi.setConfig({ testTimeout: 90_000 });

const h = createHarness("lr");
const { one, rpc, refused, settle, rawQuery, rawTransaction, violation, atInstant, withClock } = h;

afterAll(() => h.cleanup(), 300000);

const T = 90_000; // each scenario builds real people and teams through the real operations
const id = (p: Person) => p.gamingMemberId;

const proposeArgs = (entryId: string, actor: Person, ids: string[]) => ({ p_competition_team_id: entryId, p_actor_gaming_member_id: id(actor), p_gaming_member_ids: ids });
const decideClaim = (claimId: string, actor: Person, decision: string) => ({ p_competition_lifetime_roster_claim_id: claimId, p_actor_gaming_member_id: id(actor), p_decision: decision });
const releaseClaim = (claimId: string, actor: Person) => ({ p_competition_lifetime_roster_claim_id: claimId, p_actor_gaming_member_id: id(actor) });
const enterArgs = (competitionId: string, teamId: string, actor: Person) => ({ p_competition_id: competitionId, p_lifetime_team_id: teamId, p_actor_gaming_member_id: id(actor) });
const leave = (teamId: string, actor: Person, subject: Person, successor?: Person) =>
  one("end_lifetime_team_membership_atomically", { p_lifetime_team_id: teamId, p_actor_gaming_member_id: id(actor), p_subject_gaming_member_id: id(subject), ...(successor ? { p_successor_gaming_member_id: id(successor) } : {}) });
const invite = (teamId: string, actor: Person, subject: Person) =>
  one("propose_lifetime_team_membership_atomically", { p_lifetime_team_id: teamId, p_actor_gaming_member_id: id(actor), p_subject_gaming_member_id: id(subject) });
const decideMembership = (membershipId: string, actor: Person, decision: string) =>
  ({ p_lifetime_team_membership_id: membershipId, p_actor_gaming_member_id: id(actor), p_decision: decision });
const offerSeat = (teamId: string, actor: Person, subject: Person) =>
  one("offer_lifetime_team_leadership_atomically", { p_lifetime_team_id: teamId, p_actor_gaming_member_id: id(actor), p_subject_gaming_member_id: id(subject) });
const decideSeat = (seatId: string, actor: Person, decision: string) =>
  ({ p_lifetime_team_leadership_id: seatId, p_actor_gaming_member_id: id(actor), p_decision: decision });
const eventsOf = async (teamId: string) => rawQuery("select event_type, actor_gaming_member_id, subject_gaming_member_id, related_id, details from lifetime_team_events where lifetime_team_id = $1 order by event_seq", [teamId]);
const claimRow = async (claimId: string) => (await rawQuery("select * from competition_lifetime_roster_claims where competition_lifetime_roster_claim_id = $1", [claimId]))[0];
const entryRow = async (entryId: string) => (await rawQuery("select * from competition_teams where competition_team_id = $1", [entryId]))[0];
const deadlineOf = async (competitionId: string): Promise<Date> => (await rawQuery("select registration_deadline_utc as d from competition_current_registration_plan($1)", [competitionId]))[0].d;

/** One statement as the SERVER role (the credential the application holds), in a transaction that is always rolled back. */
async function asServiceRole(statement: string, params: unknown[] = []): Promise<{ code?: string; message: string } | null> {
  return rawTransaction(async (db) => {
    await db.query("set local role service_role");
    try {
      await db.query(statement, params);
      return null;
    } catch (err) {
      const e = err as { code?: string; message?: string };
      return { code: e.code, message: e.message ?? "" };
    }
  });
}

// =============================================================================================================================================
describe("[F1] a person represents ONE team in a competition: the leaders an entry names count too", () => {
  it("refuses a roster place to a person who is still captain of record of another live entry (the captain left, the entry still names them)", async () => {
    const competition = await h.setUpCompetition("F1Accept");
    const alpha = await h.buildTeam("F1Alpha", 6);
    const bravo = await h.buildTeam("F1Bravo", 6);
    const [p1, p2] = [alpha.captain, alpha.subCaptain!];
    const entryA = await h.enterTeam(competition, alpha);
    const entryB = await h.enterTeam(competition, bravo);
    await leave(alpha.teamId, p1, p1, p2); // P1 leaves Alpha; P2 succeeds. The entry keeps naming P1 as its captain of record.
    expect((await entryRow(entryA.entryId)).captain_gaming_member_id).toBe(id(p1));
    await h.addMember(bravo.teamId, bravo.captain, p1);
    const [proposal] = await rpc("propose_lifetime_entry_roster_claims_atomically", proposeArgs(entryB.entryId, bravo.captain, [id(p1)]));
    const claimId = proposal.competition_lifetime_roster_claim_id as string;
    await refused("decide_lifetime_entry_roster_claim_atomically", decideClaim(claimId, p1, "ACCEPT"), "LIFETIME_PERSON_REPRESENTS_ANOTHER_TEAM");
    expect((await claimRow(claimId)).status).toBe("PROPOSED"); // a refusal changes nothing
    // Once the first team's CURRENT leader withdraws that entry, the person is free to play for the other team.
    await one("withdraw_lifetime_competition_entry_atomically", { p_competition_team_id: entryA.entryId, p_actor_gaming_member_id: id(p2) });
    expect((await one("decide_lifetime_entry_roster_claim_atomically", decideClaim(claimId, p1, "ACCEPT"))).status).toBe("ACCEPTED");
  }, T);

  it("refuses a roster place to a sub-captain of record who stepped down, joined another team and was proposed there", async () => {
    const competition = await h.setUpCompetition("F1StepDown");
    const alpha = await h.buildTeam("F1SDAlpha", 6);
    const bravo = await h.buildTeam("F1SDBravo", 6);
    const p2 = alpha.subCaptain!;
    const entryA = await h.enterTeam(competition, alpha);
    const entryB = await h.enterTeam(competition, bravo);
    expect((await entryRow(entryA.entryId)).sub_captain_gaming_member_id).toBe(id(p2));
    await one("end_lifetime_team_leadership_atomically", { p_lifetime_team_id: alpha.teamId, p_actor_gaming_member_id: id(alpha.captain) }); // P2 steps down, stays a member
    await h.addMember(bravo.teamId, bravo.captain, p2); // a second membership is allowed for an ordinary member
    await h.register(competition, p2);
    const [proposal] = await rpc("propose_lifetime_entry_roster_claims_atomically", proposeArgs(entryB.entryId, bravo.captain, [id(p2)]));
    await refused("decide_lifetime_entry_roster_claim_atomically", decideClaim(proposal.competition_lifetime_roster_claim_id, p2, "ACCEPT"), "LIFETIME_PERSON_REPRESENTS_ANOTHER_TEAM");
  }, T);

  it("refuses an entry whose snapshot sub-captain is already sub-captain of record of another live entry", async () => {
    const competition = await h.setUpCompetition("F1Enter");
    const alpha = await h.buildTeam("F1EAlpha", 5);
    const bravo = await h.buildTeam("F1EBravo", 5, { subCaptain: false });
    const p2 = alpha.subCaptain!;
    await h.enterTeam(competition, alpha); // names P2 as its sub-captain of record
    await leave(alpha.teamId, p2, p2); // P2 steps down and leaves Alpha...
    await h.addMember(bravo.teamId, bravo.captain, p2); // ...joins Bravo and takes its sub-captain seat
    await h.makeSubCaptain(bravo.teamId, bravo.captain, p2);
    await h.register(competition, bravo.captain);
    await refused("enter_lifetime_team_into_competition_atomically", enterArgs(competition.competitionId, bravo.teamId, bravo.captain), "LIFETIME_PERSON_REPRESENTS_ANOTHER_TEAM");
    expect((await rawQuery("select count(*)::int n from competition_teams where competition_id = $1 and entry_flow = 'LIFETIME' and status <> 'REJECTED'", [competition.competitionId]))[0].n).toBe(1);
  }, T);

  it("lets the same team's own captain play on the entry that names them, and does not block anyone else", async () => {
    const competition = await h.setUpCompetition("F1Normal");
    const alpha = await h.buildTeam("F1NAlpha", 5);
    const entryA = await h.enterTeam(competition, alpha);
    const claims = await h.rosterUp(entryA.entryId, alpha.captain, competition, alpha.everyone); // the captain and the sub-captain are on their own roster
    expect(Object.keys(claims)).toHaveLength(5);
    expect((await rawQuery("select count(*)::int n from competition_lifetime_roster_claims where competition_id = $1 and status = 'ACCEPTED'", [competition.competitionId]))[0].n).toBe(5);
  }, T);
});

// =============================================================================================================================================
describe("[F2] a pending sub-captain offer does not outlive the invitee's membership", () => {
  for (const variant of ["removed", "left"] as const) {
    it(`ends the offer when the invitee is ${variant}, so a re-admitted person cannot accept it and the seat is free again`, async () => {
      const [captain, invitee, other] = await h.newPeople(3, `F2${variant}`);
      const team = await h.createTeam(captain);
      await h.addMember(team.teamId, captain, invitee);
      await h.addMember(team.teamId, captain, other);
      const offer = await offerSeat(team.teamId, captain, invitee);
      await leave(team.teamId, variant === "removed" ? captain : invitee, invitee);
      const seat = (await rawQuery("select status, end_reason, ended_by_gaming_member_id from lifetime_team_leaderships where lifetime_team_leadership_id = $1", [offer.lifetime_team_leadership_id]))[0];
      expect(seat).toMatchObject({ status: "ENDED", end_reason: "WITHDRAWN" });
      expect((await eventsOf(team.teamId)).some((e) => e.event_type === "LEADERSHIP_WITHDRAWN" && e.related_id === offer.lifetime_team_leadership_id)).toBe(true);
      await h.addMember(team.teamId, captain, invitee); // re-admitted as an ordinary member
      await refused("decide_lifetime_team_leadership_atomically", decideSeat(offer.lifetime_team_leadership_id, invitee, "ACCEPT"), "LIFETIME_OFFER_NOT_PENDING");
      await offerSeat(team.teamId, captain, other); // the seat is not blocked by a ghost offer
    }, T);
  }
});

// =============================================================================================================================================
describe("[F3] a team-side offer or roster proposal does not outlive the leader who issued it", () => {
  it("lets the captain withdraw an invitation the sub-captain made, and ends a leader's pending invitations when their seat ends", async () => {
    const team = await h.buildTeam("F3Invite", 3);
    const sub = team.subCaptain!;
    const [x, y] = await h.newPeople(2, "F3Outsider");
    const first = await invite(team.teamId, sub, x);
    const withdrawn = await one("withdraw_lifetime_team_offer_atomically", { p_offer_kind: "MEMBERSHIP", p_offer_id: first.lifetime_team_membership_id, p_actor_gaming_member_id: id(team.captain) });
    expect(withdrawn.status).toBe("ENDED");
    const second = await invite(team.teamId, sub, y);
    await one("end_lifetime_team_leadership_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: id(sub) }); // the sub-captain steps down
    expect((await rawQuery("select status, end_reason from lifetime_team_memberships where lifetime_team_membership_id = $1", [second.lifetime_team_membership_id]))[0]).toMatchObject({ status: "ENDED", end_reason: "WITHDRAWN" });
    await refused("decide_lifetime_team_membership_atomically", decideMembership(second.lifetime_team_membership_id, y, "ACCEPT"), "LIFETIME_OFFER_NOT_PENDING");
    expect((await rawQuery("select count(*)::int n from lifetime_team_memberships where lifetime_team_id = $1 and gaming_member_id = $2 and status = 'ACTIVE'", [team.teamId, id(y)]))[0].n).toBe(0);
  }, T);

  // The invitation is ended EAGERLY, at its source: its row is ended and audited, and a leader's re-invitation is not blocked by a ghost. (The accept-time re-check refuses
  // an old invitation with the very same code, so a refusal alone cannot tell the two defences apart — the row, the event and the re-invitation can.)
  const eagerlyEnded = async (teamId: string, pendingId: string) => {
    expect((await rawQuery("select status, end_reason from lifetime_team_memberships where lifetime_team_membership_id = $1", [pendingId]))[0]).toMatchObject({ status: "ENDED", end_reason: "WITHDRAWN" });
    const events = await eventsOf(teamId);
    expect(events.find((e) => e.event_type === "MEMBERSHIP_WITHDRAWN" && e.related_id === pendingId)).toMatchObject({ details: { reason: "INVITER_LEFT_LEADERSHIP" } });
  };

  it("ends the invitations of a captain who leaves (the sub-captain succeeds): the invitation is ended and audited at its source, and the new captain can invite the same person", async () => {
    const team = await h.buildTeam("F3Succession", 3);
    const [x] = await h.newPeople(1, "F3Guest");
    const pending = await invite(team.teamId, team.captain, x);
    await leave(team.teamId, team.captain, team.captain, team.subCaptain!);
    await eagerlyEnded(team.teamId, pending.lifetime_team_membership_id);
    await refused("decide_lifetime_team_membership_atomically", decideMembership(pending.lifetime_team_membership_id, x, "ACCEPT"), "LIFETIME_OFFER_NOT_PENDING");
    await invite(team.teamId, team.subCaptain!, x); // not blocked by a ghost offer
  }, T);

  it("ends the invitations of a SUB-CAPTAIN who leaves the team (not only a captain's): ended and audited at its source, and the captain can invite the same person", async () => {
    const team = await h.buildTeam("F3SubLeaves", 3);
    const [y] = await h.newPeople(1, "F3SubGuest");
    const pending = await invite(team.teamId, team.subCaptain!, y);
    await leave(team.teamId, team.subCaptain!, team.subCaptain!);
    await eagerlyEnded(team.teamId, pending.lifetime_team_membership_id);
    await invite(team.teamId, team.captain, y);
  }, T);

  it("does not let a person accept a roster place proposed by someone who is no longer a leader; a current leader can release it and propose again", async () => {
    const competition = await h.setUpCompetition("F3Claim");
    const team = await h.buildTeam("F3ClaimTeam", 4);
    const [sub, m1] = [team.subCaptain!, team.members[0]];
    const entry = await h.enterTeam(competition, team);
    const [proposal] = await rpc("propose_lifetime_entry_roster_claims_atomically", proposeArgs(entry.entryId, sub, [id(m1)]));
    const claimId = proposal.competition_lifetime_roster_claim_id as string;
    await one("end_lifetime_team_leadership_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: id(team.captain) }); // the captain removes the sub-captain's seat
    await leave(team.teamId, sub, sub); // and the sub-captain leaves
    await h.register(competition, m1);
    await refused("decide_lifetime_entry_roster_claim_atomically", decideClaim(claimId, m1, "ACCEPT"), "LIFETIME_CLAIM_NOT_OPEN");
    expect((await claimRow(claimId)).status).toBe("PROPOSED");
    await one("release_lifetime_entry_roster_claim_atomically", releaseClaim(claimId, team.captain));
    const [again] = await rpc("propose_lifetime_entry_roster_claims_atomically", proposeArgs(entry.entryId, team.captain, [id(m1)]));
    expect((await one("decide_lifetime_entry_roster_claim_atomically", decideClaim(again.competition_lifetime_roster_claim_id, m1, "ACCEPT"))).status).toBe("ACCEPTED");
  }, T);
});

// =============================================================================================================================================
describe("[F4] a direct write cannot forge, move or add an entry", () => {
  it("refuses an entry inserted without the lifetime operation, a changed entry or competition id, and a V1 team moved into a lifetime-flow competition", async () => {
    const competition = await h.setUpCompetition("F4");
    const team = await h.buildTeam("F4Team", 4);
    const entry = await h.enterTeam(competition, team);
    const other = await h.buildTeam("F4Other", 4);

    const forged = await asServiceRole(
      `insert into competition_teams (competition_id, name, captain_gaming_member_id, status, provenance, entry_flow, lifetime_team_id, sub_captain_gaming_member_id)
       values ($1, 'Totally Different Name', $2, 'PENDING_ORGANIZER_APPROVAL', 'MEMBER_PROPOSED', 'LIFETIME', $3, null)`, [competition.competitionId, id(other.captain), other.teamId]);
    expect(forged, "a forged entry must be refused").not.toBeNull();
    expect(forged?.message).toMatch(/^LIFETIME_INVARIANT_VIOLATION:/);

    const movedEntry = await asServiceRole("update competition_teams set competition_team_id = gen_random_uuid() where competition_team_id = $1", [entry.entryId]);
    expect(movedEntry?.message).toMatch(/^LIFETIME_INVARIANT_VIOLATION:/);
    const movedCompetition = await asServiceRole("update competition_teams set competition_id = $2 where competition_team_id = $1", [entry.entryId, (await h.setUpCompetition("F4Elsewhere", { lifetimeFlow: false })).competitionId]);
    expect(movedCompetition?.message).toMatch(/^LIFETIME_INVARIANT_VIOLATION:/);

    // A V1 team of an ordinary competition cannot be moved into a lifetime-flow competition either (the same row via INSERT is refused).
    const v1 = await h.setUpCompetition("F4V1", { lifetimeFlow: false });
    const [captain] = await h.newPeople(1, "F4V1Captain");
    const created = await one("add_competition_team_atomically", { p_competition_id: v1.competitionId, p_organizer_gaming_member_id: id(v1.organizer), p_name: h.uniqueName("F4 V1"), p_captain_gaming_member_id: id(captain), p_public_code: randomBytes(16).toString("base64url") });
    const movedV1 = await asServiceRole("update competition_teams set competition_id = $2 where competition_team_id = $1", [created.competition_team_id, competition.competitionId]);
    expect(movedV1?.message).toMatch(/^LIFETIME_INVARIANT_VIOLATION:/);
  }, T);
});

// =============================================================================================================================================
describe("[F5] authorization comes before every lifecycle, state and membership answer", () => {
  const code = async (name: string, args: Record<string, unknown>) => {
    const outcome = await settle(name, args);
    return outcome.ok ? "OK" : outcome.refusal;
  };
  const same = (answers: Array<string | null>, expected: string) => expect(answers, `every stranger answer must be ${expected}`).toEqual(answers.map(() => expected));

  it("answers a caller with no role identically whatever the state of the record they probe (teams, offers, seats)", async () => {
    const [stranger, ghost] = await h.newPeople(2, "F5Stranger");
    const team = await h.buildTeam("F5Team", 4);
    const [member] = team.members;
    const strangerId = id(stranger);
    const randomId = "00000000-0000-4000-8000-0000000000aa";

    // end membership: the stranger cannot tell a member from a non-member, or a real person from a made-up id
    same([
      await code("end_lifetime_team_membership_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: strangerId, p_subject_gaming_member_id: id(member) }),
      await code("end_lifetime_team_membership_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: strangerId, p_subject_gaming_member_id: id(ghost) }),
      await code("end_lifetime_team_membership_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: strangerId, p_subject_gaming_member_id: randomId }),
    ], "LIFETIME_NOT_A_LEADER");
    // propose a membership: a made-up subject and a real member answer the same
    same([
      await code("propose_lifetime_team_membership_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: strangerId, p_subject_gaming_member_id: id(member) }),
      await code("propose_lifetime_team_membership_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: strangerId, p_subject_gaming_member_id: randomId }),
    ], "LIFETIME_NOT_A_LEADER");

    // offers: pending, declined, and withdrawn offers answer the same to someone who is not a party
    const [guest] = await h.newPeople(1, "F5Guest");
    const pending = await invite(team.teamId, team.captain, guest);
    const declined = await invite(team.teamId, team.captain, ghost);
    await one("decide_lifetime_team_membership_atomically", decideMembership(declined.lifetime_team_membership_id, ghost, "DECLINE"));
    same([
      await code("decide_lifetime_team_membership_atomically", decideMembership(pending.lifetime_team_membership_id, stranger, "ACCEPT")),
      await code("decide_lifetime_team_membership_atomically", decideMembership(declined.lifetime_team_membership_id, stranger, "ACCEPT")),
    ], "LIFETIME_OFFER_WRONG_PARTY");
    same([
      await code("withdraw_lifetime_team_offer_atomically", { p_offer_kind: "MEMBERSHIP", p_offer_id: pending.lifetime_team_membership_id, p_actor_gaming_member_id: strangerId }),
      await code("withdraw_lifetime_team_offer_atomically", { p_offer_kind: "MEMBERSHIP", p_offer_id: declined.lifetime_team_membership_id, p_actor_gaming_member_id: strangerId }),
    ], "LIFETIME_OFFER_WRONG_PARTY");

    // seats
    const seatTeam = await h.buildTeam("F5Seat", 3, { subCaptain: false });
    const seatOffer = await offerSeat(seatTeam.teamId, seatTeam.captain, seatTeam.members[0]);
    const seatDeclined = await (async () => {
      await one("decide_lifetime_team_leadership_atomically", decideSeat(seatOffer.lifetime_team_leadership_id, seatTeam.members[0], "DECLINE"));
      return offerSeat(seatTeam.teamId, seatTeam.captain, seatTeam.members[1]);
    })();
    same([
      await code("decide_lifetime_team_leadership_atomically", decideSeat(seatOffer.lifetime_team_leadership_id, stranger, "ACCEPT")), // declined
      await code("decide_lifetime_team_leadership_atomically", decideSeat(seatDeclined.lifetime_team_leadership_id, stranger, "ACCEPT")), // pending
    ], "LIFETIME_OFFER_WRONG_PARTY");

    // the captain-only operations on an active team and on a disbanded one
    const doomed = await h.createTeam(ghost);
    await one("disband_lifetime_team_atomically", { p_lifetime_team_id: doomed.teamId, p_actor_gaming_member_id: id(ghost) });
    same([
      await code("disband_lifetime_team_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: strangerId }),
      await code("disband_lifetime_team_atomically", { p_lifetime_team_id: doomed.teamId, p_actor_gaming_member_id: strangerId }),
    ], "LIFETIME_NOT_THE_CAPTAIN");
    same([
      await code("offer_lifetime_team_leadership_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: strangerId, p_subject_gaming_member_id: id(member) }),
      await code("offer_lifetime_team_leadership_atomically", { p_lifetime_team_id: doomed.teamId, p_actor_gaming_member_id: strangerId, p_subject_gaming_member_id: id(member) }),
    ], "LIFETIME_NOT_THE_CAPTAIN");
  }, T);

  it("answers a caller with no role identically whatever the state of the competition, entry or claim they probe", async () => {
    const [stranger] = await h.newPeople(1, "F5Outsider");
    const open = await h.setUpCompetition("F5Open");
    const noFlow = await h.setUpCompetition("F5NoFlow", { lifetimeFlow: false });
    const cancelled = await h.setUpCompetition("F5Cancelled");
    await rawQuery("update competitions set state = 'CANCELLED_WITHOUT_CHAMPION' where competition_id = $1", [cancelled.competitionId]);
    const team = await h.buildTeam("F5Entry", 4);
    const liveEntry = await h.enterTeam(open, team);
    const second = await h.buildTeam("F5Entry2", 4);
    const withdrawnEntry = await h.enterTeam(open, second);
    await one("withdraw_lifetime_competition_entry_atomically", { p_competition_team_id: withdrawnEntry.entryId, p_actor_gaming_member_id: id(second.captain) });
    const nonLeader = code;

    // enter: an open competition with the flow, one without it, a cancelled one and one that does not exist
    const entering = await Promise.all([open, noFlow, cancelled].map((c) => nonLeader("enter_lifetime_team_into_competition_atomically", enterArgs(c.competitionId, team.teamId, stranger))));
    entering.push(await nonLeader("enter_lifetime_team_into_competition_atomically", enterArgs("00000000-0000-4000-8000-0000000000bb", team.teamId, stranger)));
    expect(entering).toEqual(entering.map(() => "LIFETIME_NOT_A_LEADER"));

    // withdraw the entry and propose claims: a live entry and a withdrawn one
    const answers = [
      await nonLeader("withdraw_lifetime_competition_entry_atomically", { p_competition_team_id: liveEntry.entryId, p_actor_gaming_member_id: id(stranger) }),
      await nonLeader("withdraw_lifetime_competition_entry_atomically", { p_competition_team_id: withdrawnEntry.entryId, p_actor_gaming_member_id: id(stranger) }),
      await nonLeader("propose_lifetime_entry_roster_claims_atomically", proposeArgs(liveEntry.entryId, stranger, [id(team.captain)])),
      await nonLeader("propose_lifetime_entry_roster_claims_atomically", proposeArgs(withdrawnEntry.entryId, stranger, [id(team.captain)])),
    ];
    expect(answers).toEqual(answers.map(() => "LIFETIME_NOT_A_LEADER"));

    // release: an open claim and a rejected one
    const [openClaim] = await rpc("propose_lifetime_entry_roster_claims_atomically", proposeArgs(liveEntry.entryId, team.captain, [id(team.members[0])]));
    await h.register(open, team.members[0]);
    await one("decide_lifetime_entry_roster_claim_atomically", decideClaim(openClaim.competition_lifetime_roster_claim_id, team.members[0], "REJECT"));
    const [anotherClaim] = await rpc("propose_lifetime_entry_roster_claims_atomically", proposeArgs(liveEntry.entryId, team.captain, [id(team.members[1])]));
    const releasing = [
      await nonLeader("release_lifetime_entry_roster_claim_atomically", releaseClaim(anotherClaim.competition_lifetime_roster_claim_id, stranger)), // open
      await nonLeader("release_lifetime_entry_roster_claim_atomically", releaseClaim(openClaim.competition_lifetime_roster_claim_id, stranger)), // rejected
    ];
    expect(releasing).toEqual(releasing.map(() => "LIFETIME_NOT_A_LEADER"));
  }, T);
});

// =============================================================================================================================================
describe("[F6] the audit trail is complete for a disband, and a lapsed offer is dated at its expiry", () => {
  it("writes one event per ended membership and seat when a team is disbanded, in order, before the disband event", async () => {
    const team = await h.buildTeam("F6Disband", 3);
    const [guest] = await h.newPeople(1, "F6Guest");
    await invite(team.teamId, team.captain, guest); // an unanswered invitation is ended by the disband too
    const before = (await eventsOf(team.teamId)).length;
    await one("disband_lifetime_team_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: id(team.captain) });
    const fresh = (await eventsOf(team.teamId)).slice(before);
    expect(fresh.filter((e) => e.event_type === "LEADERSHIP_ENDED")).toHaveLength(2);
    expect(fresh.filter((e) => e.event_type === "MEMBERSHIP_ENDED")).toHaveLength(4); // captain, sub-captain, member and the pending invitation
    expect(fresh[fresh.length - 1].event_type).toBe("TEAM_DISBANDED");
    for (const e of fresh.filter((x) => x.event_type !== "TEAM_DISBANDED")) {
      expect(e.actor_gaming_member_id).toBe(id(team.captain));
      expect(e.related_id).not.toBeNull();
      expect(e.details).toMatchObject({ end_reason: "TEAM_DISBANDED" });
    }
  }, T);

  it("dates an offer that lapsed on day seven at its expiry, not at the later moment a sweep noticed", async () => {
    const [captain, guest, guestSeat] = await h.newPeople(3, "F6Lapse");
    const team = await h.createTeam(captain);
    const offer = await invite(team.teamId, captain, guest);
    await h.addMember(team.teamId, captain, guestSeat);
    const seat = await offerSeat(team.teamId, captain, guestSeat);
    await withClock(new Date(Date.now() + 20 * DAY).toISOString(), async (db) => {
      await db.query("select * from propose_lifetime_team_membership_atomically($1, $2, $3)", [team.teamId, id(captain), id(guest)]); // sweeps the lapsed invitation
      await db.query("select * from offer_lifetime_team_leadership_atomically($1, $2, $3)", [team.teamId, id(captain), id(guestSeat)]); // sweeps the lapsed seat offer
      const membership = (await db.query("select status, end_reason, ended_at = expires_at as at_expiry from lifetime_team_memberships where lifetime_team_membership_id = $1", [offer.lifetime_team_membership_id])).rows[0];
      expect(membership).toMatchObject({ status: "ENDED", end_reason: "EXPIRED", at_expiry: true });
      const lapsedSeat = (await db.query("select status, end_reason, ended_at = expires_at as at_expiry from lifetime_team_leaderships where lifetime_team_leadership_id = $1", [seat.lifetime_team_leadership_id])).rows[0];
      expect(lapsedSeat).toMatchObject({ status: "ENDED", end_reason: "EXPIRED", at_expiry: true });
    });
  }, T);
});

// =============================================================================================================================================
describe("[F7] the registration deadline is a coded refusal at the instant it falls", () => {
  it("refuses a proposal stamped at the deadline with TEAM_REGISTRATION_NOT_OPEN (never a raw CHECK failure), and still accepts one a millisecond earlier", async () => {
    const competition = await h.setUpCompetition("F7");
    const team = await h.buildTeam("F7Team", 4);
    const entry = await h.enterTeam(competition, team);
    const deadline = await deadlineOf(competition.competitionId);
    const statement = "select * from propose_lifetime_entry_roster_claims_atomically($1::uuid, $2::uuid, $3::uuid[])";
    const params = [entry.entryId, id(team.captain), [id(team.members[0])]];
    const at = await atInstant(deadline.toISOString(), statement, params);
    expect(at).toMatchObject({ ok: false, refusal: "TEAM_REGISTRATION_NOT_OPEN" });
    const justBefore = await atInstant(new Date(deadline.getTime() - 1).toISOString(), statement, params);
    expect(justBefore.ok).toBe(true);
    if (justBefore.ok) expect(new Date(justBefore.rows[0].expires_at).getTime()).toBe(deadline.getTime());
  }, T);
});

// =============================================================================================================================================
describe("[F8] no role can read or move an identity sequence", () => {
  it("leaves every identity sequence of the foundation with no privilege for any browser or server role", async () => {
    const rows = await rawQuery(
      `select c.relname,
              has_sequence_privilege('anon', c.oid, 'USAGE') or has_sequence_privilege('anon', c.oid, 'SELECT') or has_sequence_privilege('anon', c.oid, 'UPDATE') as anon,
              has_sequence_privilege('authenticated', c.oid, 'USAGE') or has_sequence_privilege('authenticated', c.oid, 'SELECT') or has_sequence_privilege('authenticated', c.oid, 'UPDATE') as authenticated,
              has_sequence_privilege('service_role', c.oid, 'USAGE') or has_sequence_privilege('service_role', c.oid, 'SELECT') or has_sequence_privilege('service_role', c.oid, 'UPDATE') as service_role
         from pg_class c join pg_namespace n on n.oid = c.relnamespace
        where n.nspname = 'public' and c.relkind = 'S' and (c.relname like 'lifetime\\_%' or c.relname like 'competition\\_lifetime\\_%') order by c.relname`);
    // The foundation's four, and — UG-CR-GATE-CFM-004 — the two of its audit tables (every decision, every enable/disable of the flow): equally closed to every role.
    expect(rows.map((r) => r.relname)).toEqual([
      "competition_lifetime_entry_decisions_decision_seq_seq", "competition_lifetime_flow_events_flow_event_seq_seq",
      "competition_lifetime_roster_claims_seq_seq", "lifetime_team_events_event_seq_seq", "lifetime_team_leaderships_seq_seq", "lifetime_team_memberships_seq_seq"]);
    for (const row of rows) expect(row, row.relname).toMatchObject({ anon: false, authenticated: false, service_role: false });
  });
});

// =============================================================================================================================================
describe("[F9] a leader deciding a request is not told where else the person belongs", () => {
  it("answers the same bounded refusal whether the person is at the cap or leads another team, and leaves the request waiting", async () => {
    const [captainA, captainB, captainC, captainD] = await h.newPeople(4, "F9Captain");
    const [capped, leader] = await h.newPeople(2, "F9Person");
    const [alpha, bravo, charlie, delta] = [await h.createTeam(captainA), await h.createTeam(captainB), await h.createTeam(captainC), await h.createTeam(captainD)];
    const request = await invite(alpha.teamId, capped, capped); // the person asks to join Alpha (a self request)
    await h.addMember(bravo.teamId, captainB, capped);
    await h.addMember(charlie.teamId, captainC, capped); // two other teams now: the cap
    await refused("decide_lifetime_team_membership_atomically", decideMembership(request.lifetime_team_membership_id, captainA, "ACCEPT"), "LIFETIME_REQUEST_NOT_ACCEPTABLE");
    expect((await rawQuery("select status from lifetime_team_memberships where lifetime_team_membership_id = $1", [request.lifetime_team_membership_id]))[0].status).toBe("PENDING");

    const second = await invite(alpha.teamId, leader, leader);
    await h.createTeam(leader); // the person founds a team: a leader elsewhere
    await refused("decide_lifetime_team_membership_atomically", decideMembership(second.lifetime_team_membership_id, captainA, "ACCEPT"), "LIFETIME_REQUEST_NOT_ACCEPTABLE");

    // The person's OWN answers keep their specific reasons: an invitation from Delta is judged when the person accepts it.
    const invitation = await invite(delta.teamId, captainD, capped);
    await refused("decide_lifetime_team_membership_atomically", decideMembership(invitation.lifetime_team_membership_id, capped, "ACCEPT"), "LIFETIME_MEMBERSHIP_CAP_REACHED");
  }, T);
});

// =============================================================================================================================================
describe("[F11] the legacy backfill converges and its audit trail is honest", () => {
  async function legacyWorld(label: string) {
    const competition = await h.setUpCompetition(label, { lifetimeFlow: false });
    const [captain, a, b, later] = await h.newPeople(4, `${label}Person`);
    const created = await one("add_competition_team_atomically", { p_competition_id: competition.competitionId, p_organizer_gaming_member_id: id(competition.organizer), p_name: h.uniqueName("Legacy FC"), p_captain_gaming_member_id: id(captain), p_public_code: randomBytes(16).toString("base64url") });
    const give = (people: Person[]) => rawQuery(
      "insert into competition_team_memberships (competition_id, competition_team_id, gaming_member_id, approved_by_gaming_member_id) select $1, $2, unnest($3::uuid[]), $4", [competition.competitionId, created.competition_team_id, people.map(id), id(competition.organizer)]);
    await give([a, b]);
    return { competition, captain, a, b, later, give, teamId: created.competition_team_id as string };
  }
  const run = (competitionId: string) => one("backfill_legacy_competition_teams_atomically", { p_competition_ids: [competitionId] });

  it("mirrors a V1 approval that landed after the first run, never resurrects a person who left, and is stable afterwards", async () => {
    const w = await legacyWorld("F11Converge");
    const first = await run(w.competition.competitionId);
    expect(first).toMatchObject({ teams_created: 1, memberships_created: 3, leaderships_created: 1, skipped_already_linked: 0 });
    const [{ lifetime_team_id: legacyId }] = await rawQuery("select lifetime_team_id from lifetime_team_legacy_sources where competition_id = $1", [w.competition.competitionId]);
    h.trackTeam(legacyId);
    await w.give([w.later]); // a V1 approval after the first run
    const second = await run(w.competition.competitionId);
    expect(second).toMatchObject({ teams_created: 0, memberships_created: 1, leaderships_created: 0, skipped_already_linked: 1 });
    expect((await rawQuery("select count(*)::int n from lifetime_team_memberships where lifetime_team_id = $1 and status = 'ACTIVE' and is_legacy", [legacyId]))[0].n).toBe(4);
    expect(await run(w.competition.competitionId)).toMatchObject({ teams_created: 0, memberships_created: 0, skipped_already_linked: 1 });
    // A person who left the legacy team through the lifetime flow is not brought back by a later run.
    await leave(legacyId, w.captain, w.a);
    expect(await run(w.competition.competitionId)).toMatchObject({ memberships_created: 0 });
    expect((await rawQuery("select count(*)::int n from lifetime_team_memberships where lifetime_team_id = $1 and gaming_member_id = $2 and status = 'ACTIVE'", [legacyId, id(w.a)]))[0].n).toBe(0);
  }, T);

  it("records the backfill as the system's own act: no person is named as its actor, every legacy membership and seat has an event, and the V1 dates are kept in the details", async () => {
    const w = await legacyWorld("F11Events");
    await run(w.competition.competitionId);
    const [{ lifetime_team_id: legacyId }] = await rawQuery("select lifetime_team_id from lifetime_team_legacy_sources where competition_id = $1", [w.competition.competitionId]);
    h.trackTeam(legacyId);
    const events = await eventsOf(legacyId);
    expect(events.filter((e) => e.event_type === "TEAM_CREATED")).toHaveLength(1);
    expect(events.filter((e) => e.event_type === "MEMBERSHIP_ACTIVATED")).toHaveLength(3);
    expect(events.filter((e) => e.event_type === "LEADERSHIP_ACTIVATED")).toHaveLength(1);
    for (const e of events) {
      expect(e.actor_gaming_member_id, `${e.event_type} must not name a person as its actor`).toBeNull();
      expect(JSON.stringify(e.details)).toContain("LEGACY");
    }
    // ...and the V1 dates are the V1 rows' own (a details object that merely said LEGACY would pass the loop above).
    const at = (value: unknown) => new Date(value as string).getTime();
    const [v1Team] = await rawQuery("select created_at from competition_teams where competition_team_id = $1", [w.teamId]);
    const v1Members = await rawQuery("select gaming_member_id, approved_at from competition_team_memberships where competition_team_id = $1", [w.teamId]);
    expect(at(events.find((e) => e.event_type === "TEAM_CREATED")!.details.v1_created_at)).toBe(at(v1Team.created_at));
    expect(at(events.find((e) => e.event_type === "LEADERSHIP_ACTIVATED")!.details.started_at)).toBe(at(v1Team.created_at));
    const activated = (person: Person) => events.find((e) => e.event_type === "MEMBERSHIP_ACTIVATED" && e.subject_gaming_member_id === id(person))!;
    expect(at(activated(w.captain).details.joined_at), "the captain joined when the team was created").toBe(at(v1Team.created_at));
    for (const m of v1Members) expect(at(events.find((e) => e.event_type === "MEMBERSHIP_ACTIVATED" && e.subject_gaming_member_id === m.gaming_member_id)!.details.joined_at)).toBe(at(m.approved_at));
  }, T);
});

// =============================================================================================================================================
describe("[F14] an unattested registration has its own, truthful refusal", () => {
  it("tells a leader or a player whose registration lacks the adult self-attestation so, and still tells an unregistered person to register", async () => {
    const competition = await h.setUpCompetition("F14");
    const team = await h.buildTeam("F14Team", 4);
    await registerForCompetition(h.compRepo, competition.competitionId, id(team.captain), false); // pressed Register without the tick
    await refused("enter_lifetime_team_into_competition_atomically", enterArgs(competition.competitionId, team.teamId, team.captain), "LIFETIME_ADULT_ATTESTATION_REQUIRED");

    const other = await h.buildTeam("F14Other", 4);
    await refused("enter_lifetime_team_into_competition_atomically", enterArgs(competition.competitionId, other.teamId, other.captain), "COMPETITION_REGISTRATION_REQUIRED"); // never registered
    const entry = await h.enterTeam(competition, other);
    const [player, unregistered] = [other.members[0], other.subCaptain!];
    const proposed = await rpc("propose_lifetime_entry_roster_claims_atomically", proposeArgs(entry.entryId, other.captain, [id(player), id(unregistered)]));
    const claimOf = (p: Person) => proposed.find((r) => r.gaming_member_id === id(p))!.competition_lifetime_roster_claim_id as string;
    await registerForCompetition(h.compRepo, competition.competitionId, id(player), false);
    await refused("decide_lifetime_entry_roster_claim_atomically", decideClaim(claimOf(player), player, "ACCEPT"), "LIFETIME_ADULT_ATTESTATION_REQUIRED");
    await refused("decide_lifetime_entry_roster_claim_atomically", decideClaim(claimOf(unregistered), unregistered, "ACCEPT"), "COMPETITION_REGISTRATION_REQUIRED");
  }, T);
});

// =============================================================================================================================================
describe("[F22] a disband settles the claims of a team whose competition was cancelled", () => {
  const openClaims = (teamId: string) => rawQuery(
    `select count(*)::int n from competition_lifetime_roster_claims c
      where c.lifetime_team_id = $1 and c.status = 'ACCEPTED' and c.departed_at is null
        and not exists (select 1 from lifetime_team_memberships m where m.lifetime_team_id = c.lifetime_team_id and m.gaming_member_id = c.gaming_member_id and m.status = 'ACTIVE')`, [teamId]);

  it("releases the accepted claims before a freeze (reason TEAM_DISBANDED), so no accepted claim is left without a member", async () => {
    const competition = await h.setUpCompetition("F22Open");
    const team = await h.buildTeam("F22Team", 5);
    const entry = await h.enterTeam(competition, team);
    await h.rosterUp(entry.entryId, team.captain, competition, team.everyone);
    await rawQuery("update competitions set state = 'CANCELLED_WITHOUT_CHAMPION' where competition_id = $1", [competition.competitionId]);
    await one("disband_lifetime_team_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: id(team.captain) });
    expect((await openClaims(team.teamId))[0].n).toBe(0);
    const rows = await rawQuery("select status, release_reason from competition_lifetime_roster_claims where competition_team_id = $1", [entry.entryId]);
    expect(rows).toHaveLength(5);
    for (const row of rows) expect(row).toEqual({ status: "REMOVED", release_reason: "TEAM_DISBANDED" });
  }, T);

  it("dates the accepted claims after a freeze (departure TEAM_DISBANDED), keeping them as evidence", async () => {
    const competition = await h.setUpCompetition("F22Frozen");
    const [teamA, teamB] = [await h.buildTeam("F22FA", 5), await h.buildTeam("F22FB", 5)];
    const [entryA, entryB] = [await h.enterTeam(competition, teamA), await h.enterTeam(competition, teamB)];
    await h.approveEntries(competition, entryA.entryId, entryB.entryId); // UG-CR-GATE-CFM-004: the freeze counts only ACCEPTED entries
    await h.rosterUp(entryA.entryId, teamA.captain, competition, teamA.everyone);
    await h.rosterUp(entryB.entryId, teamB.captain, competition, teamB.everyone);
    await h.passDeadline(competition.competitionId);
    await one("freeze_lifetime_competition_entries_atomically", { p_competition_id: competition.competitionId, p_organizer_gaming_member_id: id(competition.organizer) });
    await rawQuery("update competitions set state = 'CANCELLED_WITHOUT_CHAMPION' where competition_id = $1", [competition.competitionId]);
    await one("disband_lifetime_team_atomically", { p_lifetime_team_id: teamA.teamId, p_actor_gaming_member_id: id(teamA.captain) });
    expect((await openClaims(teamA.teamId))[0].n).toBe(0);
    const rows = await rawQuery("select status, departure_reason, departed_at is not null as dated from competition_lifetime_roster_claims where competition_team_id = $1", [entryA.entryId]);
    expect(rows).toHaveLength(5);
    for (const row of rows) expect(row).toEqual({ status: "ACCEPTED", departure_reason: "TEAM_DISBANDED", dated: true });
  }, T);
});

// =============================================================================================================================================
describe("[F23] the backfill has no fail-open default", () => {
  it("refuses a missing or null scope instead of backfilling every legacy team", async () => {
    const nothing = await violation("select * from backfill_legacy_competition_teams_atomically()");
    expect(nothing, "calling it with no argument must not run").not.toBeNull();
    const nulled = await violation("select * from backfill_legacy_competition_teams_atomically(null::uuid[])");
    expect(nulled?.message).toMatch(/^LIFETIME_BACKFILL_SCOPE_INVALID:/);
    const empty = await violation("select * from backfill_legacy_competition_teams_atomically(array[]::uuid[])");
    expect(empty?.message).toMatch(/^LIFETIME_BACKFILL_SCOPE_INVALID:/);
  });
});

// =============================================================================================================================================
describe("[F26] the freeze settles every proposal that is still open", () => {
  it("expires an unanswered proposal at the freeze, so it cannot be left open or answered afterwards", async () => {
    const competition = await h.setUpCompetition("F26");
    const [teamA, teamB] = [await h.buildTeam("F26A", 7), await h.buildTeam("F26B", 6)];
    const [entryA, entryB] = [await h.enterTeam(competition, teamA), await h.enterTeam(competition, teamB)];
    await h.approveEntries(competition, entryA.entryId, entryB.entryId); // UG-CR-GATE-CFM-004: the freeze counts only ACCEPTED entries
    await h.rosterUp(entryA.entryId, teamA.captain, competition, teamA.everyone.slice(0, 6));
    await h.rosterUp(entryB.entryId, teamB.captain, competition, teamB.everyone);
    const late = teamA.everyone[6];
    const [open] = await rpc("propose_lifetime_entry_roster_claims_atomically", proposeArgs(entryA.entryId, teamA.captain, [id(late)]));
    await h.passDeadline(competition.competitionId);
    const frozen = await one("freeze_lifetime_competition_entries_atomically", { p_competition_id: competition.competitionId, p_organizer_gaming_member_id: id(competition.organizer) });
    expect(frozen).toMatchObject({ entry_count: 2, claim_count: 12 });
    const row = await claimRow(open.competition_lifetime_roster_claim_id);
    expect(row).toMatchObject({ status: "EXPIRED", release_reason: "EXPIRED" });
    expect(new Date(row.released_at).getTime()).toBeLessThanOrEqual(new Date(frozen.frozen_at).getTime());
    await refused("decide_lifetime_entry_roster_claim_atomically", decideClaim(open.competition_lifetime_roster_claim_id, late, "REJECT"), "LIFETIME_CLAIM_NOT_OPEN");
    await refused("decide_lifetime_entry_roster_claim_atomically", decideClaim(open.competition_lifetime_roster_claim_id, late, "ACCEPT"), "LIFETIME_CLAIM_NOT_OPEN");
  }, T);
});
