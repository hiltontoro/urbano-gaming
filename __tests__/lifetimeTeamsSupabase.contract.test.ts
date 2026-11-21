import { afterAll, describe, expect, it, vi } from "vitest";
import { loadEnv } from "vite";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";

import { DAY, createHarness } from "./helpers/lifetimeContract";

/**
 * UG-CR-GATE-CFM-001 — Lifetime Teams: creation, dated membership, captain and sub-captain, succession and history, against a real (disposable, loopback-only)
 * Postgres.
 *
 * Proves, in the database itself: a lifetime team is a persistent entity with a stable id, an opaque public code, a name, a lifecycle status and an audit trail;
 * its creator is its captain and first member; a person joins only when BOTH sides agree (a leader invites and the person accepts, or the person asks and a leader
 * accepts); an ordinary person may hold at most TWO active memberships; a captain or sub-captain belongs to ONE team only; the captaincy changes hands only when the
 * captain leaves, to the sub-captain; membership and leadership are dated periods that are ended, never overwritten or deleted; and every one of those rules is
 * also enforced by the tables themselves, so a direct write cannot get around it.
 *
 * Every refusal is a stable coded refusal (SQLSTATE P0001), never a raw database failure.
 */

// The shared contract-test guard (UG-CR-GATE-079) runs before anything is constructed: no target that is not loopback is ever touched.
const supabaseUrl = loadEnv("development", process.cwd(), "").SUPABASE_URL;
requireLocalSupabase(supabaseUrl);
// Every scenario here builds real people and teams through the real operations, and the freeze scenarios wait for a registration deadline to pass: none of them is
// a unit test. One explicit budget for the whole file (the repo's other contract suites do the same), instead of the 5 s default that a slow machine or a parallel run can cross.
vi.setConfig({ testTimeout: 90_000 });

const h = createHarness("lt");
const { one, refused, rawQuery, violation, atInstant } = h;

afterAll(() => h.cleanup(), 300000);

const activeMembers = async (teamId: string) => (await rawQuery<{ gaming_member_id: string }>(
  "select gaming_member_id from lifetime_team_memberships where lifetime_team_id = $1 and status = 'ACTIVE' order by seq", [teamId])).map((r) => r.gaming_member_id);
const leadership = async (teamId: string) => rawQuery(
  "select role, status, gaming_member_id, end_reason, predecessor_leadership_id, lifetime_team_leadership_id from lifetime_team_leaderships where lifetime_team_id = $1 order by seq", [teamId]);
const eventTypes = async (teamId: string) => (await rawQuery<{ event_type: string }>("select event_type from lifetime_team_events where lifetime_team_id = $1 order by event_seq", [teamId])).map((r) => r.event_type);
const offer = (teamId: string, actor: { gamingMemberId: string }, subject: { gamingMemberId: string }) =>
  ({ p_lifetime_team_id: teamId, p_actor_gaming_member_id: actor.gamingMemberId, p_subject_gaming_member_id: subject.gamingMemberId });
const decide = (membershipId: string, actor: { gamingMemberId: string }, decision: string) =>
  ({ p_lifetime_team_membership_id: membershipId, p_actor_gaming_member_id: actor.gamingMemberId, p_decision: decision });

// =============================================================================================================================================
describe("[1] a lifetime team", () => {
  it("is created ACTIVE with a stable id; its creator is its first ACTIVE member and its ACTIVE captain; the audit trail records all three", async () => {
    const creator = await h.newPerson("Creator");
    const team = await h.createTeam(creator, h.uniqueName("Los Halcones"));
    const [row] = await rawQuery("select * from lifetime_teams where lifetime_team_id = $1", [team.teamId]);
    expect(row.status).toBe("ACTIVE");
    expect(row.origin).toBe("NEW");
    expect(row.created_by_gaming_member_id).toBe(creator.gamingMemberId);
    expect(row.disbanded_at).toBeNull();
    expect(row.created_at).toBeInstanceOf(Date);
    expect(await activeMembers(team.teamId)).toEqual([creator.gamingMemberId]);
    const seats = await leadership(team.teamId);
    expect(seats).toHaveLength(1);
    expect(seats[0]).toMatchObject({ role: "CAPTAIN", status: "ACTIVE", gaming_member_id: creator.gamingMemberId });
    expect(await eventTypes(team.teamId)).toEqual(["TEAM_CREATED", "MEMBERSHIP_ACTIVATED", "LEADERSHIP_ACTIVATED"]);
  });

  it("stores a normalized name and refuses an invalid one with a stable code", async () => {
    const creator = await h.newPerson("Normalizer");
    const spaced = `  ${h.uniqueName("Los   Tigres")}\t `;
    const team = await h.createTeam(creator, spaced);
    const [row] = await rawQuery("select name from lifetime_teams where lifetime_team_id = $1", [team.teamId]);
    expect(row.name).toBe(spaced.trim().replace(/\s+/g, " "));
    for (const bad of ["", " ", "a", "x".repeat(61), "bad\u0007name"]) {
      await refused("create_lifetime_team_atomically", { p_creator_gaming_member_id: (await h.newPerson("Bad")).gamingMemberId, p_name: bad }, "LIFETIME_NAME_INVALID");
    }
    await refused("create_lifetime_team_atomically", { p_creator_gaming_member_id: (await h.newPerson("Null")).gamingMemberId, p_name: null }, "LIFETIME_NAME_INVALID");
  });

  it("has a name that is unique among active teams (ignoring case and spaces) and free again once the team is disbanded", async () => {
    const [a, b, c] = await h.newPeople(3, "Namer");
    const base = h.uniqueName("Unique Name");
    const first = await h.createTeam(a, base);
    await refused("create_lifetime_team_atomically", { p_creator_gaming_member_id: b.gamingMemberId, p_name: base.toUpperCase().replace(/ /g, "   ") }, "LIFETIME_NAME_TAKEN");
    await refused("create_lifetime_team_atomically", { p_creator_gaming_member_id: b.gamingMemberId, p_name: base.replace(/ /g, "") }, "LIFETIME_NAME_TAKEN");
    await one("disband_lifetime_team_atomically", { p_lifetime_team_id: first.teamId, p_actor_gaming_member_id: a.gamingMemberId });
    const second = await h.createTeam(c, base);
    expect(second.teamId).not.toBe(first.teamId);
  });

  it("has an opaque 22-character public code that is not its id, and each team has its own", async () => {
    const [a, b] = await h.newPeople(2, "Coder");
    const one_ = await h.createTeam(a);
    const two = await h.createTeam(b);
    expect(one_.publicCode).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(two.publicCode).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(one_.publicCode).not.toBe(two.publicCode);
    expect(one_.publicCode).not.toContain(one_.teamId.slice(0, 8));
    expect(await violation("update lifetime_teams set public_code = (select public_code from lifetime_teams where lifetime_team_id = $2) where lifetime_team_id = $1", [one_.teamId, two.teamId])).not.toBeNull();
  });

  it("is refused for an unknown creator and for a person who already belongs to a team (a leader belongs to one team only)", async () => {
    await refused("create_lifetime_team_atomically", { p_creator_gaming_member_id: "00000000-0000-4000-8000-000000000000", p_name: h.uniqueName("Ghost") }, "LIFETIME_PERSON_NOT_FOUND");
    await refused("create_lifetime_team_atomically", { p_creator_gaming_member_id: null, p_name: h.uniqueName("Null Creator") }, "LIFETIME_PERSON_NOT_FOUND");
    const [captain, member] = await h.newPeople(2, "Owner");
    const team = await h.createTeam(captain);
    await refused("create_lifetime_team_atomically", { p_creator_gaming_member_id: captain.gamingMemberId, p_name: h.uniqueName("Second Team") }, "LIFETIME_LEADER_MUST_BELONG_TO_ONE_TEAM");
    await h.addMember(team.teamId, captain, member);
    await refused("create_lifetime_team_atomically", { p_creator_gaming_member_id: member.gamingMemberId, p_name: h.uniqueName("Member Team") }, "LIFETIME_LEADER_MUST_BELONG_TO_ONE_TEAM");
  });
});

// =============================================================================================================================================
describe("[2] membership starts only when both sides agree", () => {
  it("a leader invites and the person accepts: an ACTIVE membership dated from acceptance, with the offer's history kept", async () => {
    const [captain, person] = await h.newPeople(2, "Invite");
    const team = await h.createTeam(captain);
    const invited = await one("propose_lifetime_team_membership_atomically", offer(team.teamId, captain, person));
    expect(invited).toMatchObject({ status: "PENDING", initiated_by_side: "TEAM" });
    expect(new Date(invited.expires_at).getTime() - Date.now()).toBeGreaterThan(6.9 * DAY);
    expect(new Date(invited.expires_at).getTime() - Date.now()).toBeLessThan(7.1 * DAY);
    expect(await activeMembers(team.teamId)).toEqual([captain.gamingMemberId]);
    const accepted = await one("decide_lifetime_team_membership_atomically", decide(invited.lifetime_team_membership_id, person, "ACCEPT"));
    expect(accepted.status).toBe("ACTIVE");
    const [row] = await rawQuery("select * from lifetime_team_memberships where lifetime_team_membership_id = $1", [invited.lifetime_team_membership_id]);
    expect(row).toMatchObject({ status: "ACTIVE", initiated_by_side: "TEAM", initiated_by_gaming_member_id: captain.gamingMemberId, decided_by_gaming_member_id: person.gamingMemberId, is_legacy: false });
    expect(row.joined_at).toBeInstanceOf(Date);
    expect(row.ended_at).toBeNull();
    expect(await activeMembers(team.teamId)).toContain(person.gamingMemberId);
    expect(await eventTypes(team.teamId)).toEqual(expect.arrayContaining(["MEMBERSHIP_OFFERED", "MEMBERSHIP_ACTIVATED"]));
  });

  it("a person asks to join and a leader (the captain or the sub-captain) accepts", async () => {
    const [captain, sub, asker, asker2] = await h.newPeople(4, "Request");
    const team = await h.createTeam(captain);
    await h.addMember(team.teamId, captain, sub);
    await h.makeSubCaptain(team.teamId, captain, sub);
    const request = await one("propose_lifetime_team_membership_atomically", offer(team.teamId, asker, asker));
    expect(request).toMatchObject({ status: "PENDING", initiated_by_side: "PERSON" });
    await one("decide_lifetime_team_membership_atomically", decide(request.lifetime_team_membership_id, captain, "ACCEPT"));
    const request2 = await one("propose_lifetime_team_membership_atomically", offer(team.teamId, asker2, asker2));
    await one("decide_lifetime_team_membership_atomically", decide(request2.lifetime_team_membership_id, sub, "ACCEPT"));
    expect(await activeMembers(team.teamId)).toEqual(expect.arrayContaining([asker.gamingMemberId, asker2.gamingMemberId]));
  });

  it("only the OTHER side decides: a person cannot accept their own request, a leader cannot accept an invitation for the person, a stranger can do neither", async () => {
    const [captain, person, stranger] = await h.newPeople(3, "Sides");
    const team = await h.createTeam(captain);
    const request = await one("propose_lifetime_team_membership_atomically", offer(team.teamId, person, person));
    await refused("decide_lifetime_team_membership_atomically", decide(request.lifetime_team_membership_id, person, "ACCEPT"), "LIFETIME_OFFER_WRONG_PARTY");
    await refused("decide_lifetime_team_membership_atomically", decide(request.lifetime_team_membership_id, stranger, "ACCEPT"), "LIFETIME_OFFER_WRONG_PARTY");
    await one("decide_lifetime_team_membership_atomically", decide(request.lifetime_team_membership_id, captain, "ACCEPT"));
    const [other] = await h.newPeople(1, "Other");
    const invitation = await one("propose_lifetime_team_membership_atomically", offer(team.teamId, captain, other));
    await refused("decide_lifetime_team_membership_atomically", decide(invitation.lifetime_team_membership_id, captain, "ACCEPT"), "LIFETIME_OFFER_WRONG_PARTY");
    await refused("decide_lifetime_team_membership_atomically", decide(invitation.lifetime_team_membership_id, stranger, "ACCEPT"), "LIFETIME_OFFER_WRONG_PARTY");
    await refused("decide_lifetime_team_membership_atomically", decide(invitation.lifetime_team_membership_id, other, "MAYBE"), "LIFETIME_DECISION_INVALID");
    await refused("decide_lifetime_team_membership_atomically", decide(invitation.lifetime_team_membership_id, other, "ACCEPT_ALL"), "LIFETIME_DECISION_INVALID");
    await refused("decide_lifetime_team_membership_atomically", decide("00000000-0000-4000-8000-000000000000", other, "ACCEPT"), "LIFETIME_OFFER_NOT_FOUND");
  });

  it("a non-leader cannot invite anyone (a member holds no such power), and an unknown team or person is refused", async () => {
    const [captain, member, outsider, target] = await h.newPeople(4, "Powers");
    const team = await h.createTeam(captain);
    await h.addMember(team.teamId, captain, member);
    await refused("propose_lifetime_team_membership_atomically", offer(team.teamId, member, target), "LIFETIME_NOT_A_LEADER");
    await refused("propose_lifetime_team_membership_atomically", offer(team.teamId, outsider, target), "LIFETIME_NOT_A_LEADER");
    await refused("propose_lifetime_team_membership_atomically", { ...offer(team.teamId, captain, target), p_subject_gaming_member_id: "00000000-0000-4000-8000-000000000000" }, "LIFETIME_PERSON_NOT_FOUND");
    await refused("propose_lifetime_team_membership_atomically", { ...offer("00000000-0000-4000-8000-000000000000", captain, target) }, "LIFETIME_TEAM_NOT_FOUND");
    await refused("propose_lifetime_team_membership_atomically", { ...offer(team.teamId, captain, target), p_actor_gaming_member_id: null }, "LIFETIME_NOT_A_LEADER");
  });

  it("allows one pending offer per team and person, and refuses an offer to someone who is already an active member", async () => {
    const [captain, person] = await h.newPeople(2, "Dup");
    const team = await h.createTeam(captain);
    await refused("propose_lifetime_team_membership_atomically", offer(team.teamId, captain, captain), "LIFETIME_ALREADY_MEMBER");
    const first = await one("propose_lifetime_team_membership_atomically", offer(team.teamId, captain, person));
    await refused("propose_lifetime_team_membership_atomically", offer(team.teamId, captain, person), "LIFETIME_OFFER_ALREADY_PENDING");
    await refused("propose_lifetime_team_membership_atomically", offer(team.teamId, person, person), "LIFETIME_OFFER_ALREADY_PENDING");
    await one("decide_lifetime_team_membership_atomically", decide(first.lifetime_team_membership_id, person, "ACCEPT"));
    await refused("decide_lifetime_team_membership_atomically", decide(first.lifetime_team_membership_id, person, "ACCEPT"), "LIFETIME_OFFER_NOT_PENDING");
    await refused("propose_lifetime_team_membership_atomically", offer(team.teamId, captain, person), "LIFETIME_ALREADY_MEMBER");
    await refused("propose_lifetime_team_membership_atomically", offer(team.teamId, person, person), "LIFETIME_ALREADY_MEMBER");
  });

  it("a declined offer ends as DECLINED, and the same offer can be made again afterwards (rejection followed by re-entry)", async () => {
    const [captain, person] = await h.newPeople(2, "Decline");
    const team = await h.createTeam(captain);
    const first = await one("propose_lifetime_team_membership_atomically", offer(team.teamId, captain, person));
    const declined = await one("decide_lifetime_team_membership_atomically", decide(first.lifetime_team_membership_id, person, "DECLINE"));
    expect(declined.status).toBe("ENDED");
    const [row] = await rawQuery("select status, end_reason, joined_at, ended_at from lifetime_team_memberships where lifetime_team_membership_id = $1", [first.lifetime_team_membership_id]);
    expect(row).toMatchObject({ status: "ENDED", end_reason: "DECLINED", joined_at: null });
    expect(row.ended_at).toBeInstanceOf(Date);
    const again = await h.addMember(team.teamId, captain, person);
    expect(again).not.toBe(first.lifetime_team_membership_id);
    expect(await activeMembers(team.teamId)).toContain(person.gamingMemberId);
  });

  it("lets the initiator withdraw a pending offer, and nobody else", async () => {
    const [captain, person, stranger] = await h.newPeople(3, "Withdraw");
    const team = await h.createTeam(captain);
    const invitation = await one("propose_lifetime_team_membership_atomically", offer(team.teamId, captain, person));
    const args = (actor: { gamingMemberId: string }) => ({ p_offer_kind: "MEMBERSHIP", p_offer_id: invitation.lifetime_team_membership_id, p_actor_gaming_member_id: actor.gamingMemberId });
    await refused("withdraw_lifetime_team_offer_atomically", args(person), "LIFETIME_OFFER_WRONG_PARTY");
    await refused("withdraw_lifetime_team_offer_atomically", args(stranger), "LIFETIME_OFFER_WRONG_PARTY");
    await refused("withdraw_lifetime_team_offer_atomically", { ...args(captain), p_offer_kind: "SOMETHING" }, "LIFETIME_DECISION_INVALID");
    const withdrawn = await one("withdraw_lifetime_team_offer_atomically", args(captain));
    expect(withdrawn.status).toBe("ENDED");
    expect((await rawQuery("select end_reason from lifetime_team_memberships where lifetime_team_membership_id = $1", [invitation.lifetime_team_membership_id]))[0].end_reason).toBe("WITHDRAWN");
    await refused("decide_lifetime_team_membership_atomically", decide(invitation.lifetime_team_membership_id, person, "ACCEPT"), "LIFETIME_OFFER_NOT_PENDING");
    await refused("withdraw_lifetime_team_offer_atomically", args(captain), "LIFETIME_OFFER_NOT_PENDING");
  });

  it("lets an offer expire after seven days: it cannot be accepted, and a new offer replaces the stale one", async () => {
    const [captain, person] = await h.newPeople(2, "Expire");
    const team = await h.createTeam(captain);
    const stale = await one("propose_lifetime_team_membership_atomically", offer(team.teamId, captain, person));
    const later = new Date(Date.now() + 8 * DAY).toISOString();
    const lateAccept = await atInstant(later, "select * from decide_lifetime_team_membership_atomically($1::uuid, $2::uuid, 'ACCEPT')", [stale.lifetime_team_membership_id, person.gamingMemberId]);
    expect(lateAccept).toMatchObject({ ok: false, refusal: "LIFETIME_OFFER_EXPIRED" });
    // Still PENDING in the database (a refusal persists nothing); the next offer for the same pair ends it as EXPIRED and replaces it (judged inside one rolled-back transaction).
    expect((await rawQuery("select status from lifetime_team_memberships where lifetime_team_membership_id = $1", [stale.lifetime_team_membership_id]))[0].status).toBe("PENDING");
    const rows = await h.withClock(later, async (db) => {
      await db.query("select * from propose_lifetime_team_membership_atomically($1::uuid, $2::uuid, $3::uuid)", [team.teamId, captain.gamingMemberId, person.gamingMemberId]);
      return (await db.query("select status, end_reason from lifetime_team_memberships where lifetime_team_id = $1 and gaming_member_id = $2 order by seq", [team.teamId, person.gamingMemberId])).rows;
    });
    expect(rows).toEqual([{ status: "ENDED", end_reason: "EXPIRED" }, { status: "PENDING", end_reason: null }]);
  });
});

// =============================================================================================================================================
describe("[3] an ordinary person holds at most two active memberships; a leader belongs to one team only", () => {
  it("allows two active memberships and refuses a third; pending offers do not count", async () => {
    const [a, b, c, person] = await h.newPeople(4, "Cap");
    const [t1, t2, t3] = [await h.createTeam(a), await h.createTeam(b), await h.createTeam(c)];
    // Three offers may be pending at once...
    const offers = [t1, t2, t3].map(async (t, i) => one("propose_lifetime_team_membership_atomically", offer(t.teamId, [a, b, c][i], person)));
    const pending = await Promise.all(offers);
    expect(pending).toHaveLength(3);
    // ...but only two can become memberships.
    await one("decide_lifetime_team_membership_atomically", decide(pending[0].lifetime_team_membership_id, person, "ACCEPT"));
    await one("decide_lifetime_team_membership_atomically", decide(pending[1].lifetime_team_membership_id, person, "ACCEPT"));
    await refused("decide_lifetime_team_membership_atomically", decide(pending[2].lifetime_team_membership_id, person, "ACCEPT"), "LIFETIME_MEMBERSHIP_CAP_REACHED");
    const [count] = await rawQuery("select count(*)::int n from lifetime_team_memberships where gaming_member_id = $1 and status = 'ACTIVE'", [person.gamingMemberId]);
    expect(count.n).toBe(2);
    // The refused offer is untouched (still pending): the person may accept it after leaving a team.
    expect((await rawQuery("select status from lifetime_team_memberships where lifetime_team_membership_id = $1", [pending[2].lifetime_team_membership_id]))[0].status).toBe("PENDING");
  });

  it("frees a slot when a member leaves, and the history keeps every dated period (the same person and team can have several)", async () => {
    const [a, b, c, person] = await h.newPeople(4, "Slots");
    const [t1, t2, t3] = [await h.createTeam(a), await h.createTeam(b), await h.createTeam(c)];
    await h.addMember(t1.teamId, a, person);
    await h.addMember(t2.teamId, b, person);
    const third = await one("propose_lifetime_team_membership_atomically", offer(t3.teamId, c, person));
    await refused("decide_lifetime_team_membership_atomically", decide(third.lifetime_team_membership_id, person, "ACCEPT"), "LIFETIME_MEMBERSHIP_CAP_REACHED");
    const left = await one("end_lifetime_team_membership_atomically", { p_lifetime_team_id: t1.teamId, p_actor_gaming_member_id: person.gamingMemberId, p_subject_gaming_member_id: person.gamingMemberId });
    expect(left.ended_at).toBeTruthy();
    await one("decide_lifetime_team_membership_atomically", decide(third.lifetime_team_membership_id, person, "ACCEPT"));
    // Rejoining the first team starts a NEW period; the earlier one stays as it was.
    await one("end_lifetime_team_membership_atomically", { p_lifetime_team_id: t2.teamId, p_actor_gaming_member_id: person.gamingMemberId, p_subject_gaming_member_id: person.gamingMemberId });
    await h.addMember(t1.teamId, a, person);
    const periods = await rawQuery("select status, joined_at, ended_at, end_reason from lifetime_team_memberships where lifetime_team_id = $1 and gaming_member_id = $2 order by seq", [t1.teamId, person.gamingMemberId]);
    expect(periods).toHaveLength(2);
    expect(periods[0]).toMatchObject({ status: "ENDED", end_reason: "LEFT" });
    expect(periods[0].joined_at).toBeInstanceOf(Date);
    expect(periods[0].ended_at.getTime()).toBeGreaterThanOrEqual(periods[0].joined_at.getTime());
    expect(periods[1]).toMatchObject({ status: "ACTIVE", ended_at: null });
    expect(periods[1].joined_at.getTime()).toBeGreaterThanOrEqual(periods[0].ended_at.getTime());
  });

  it("refuses a self-request that could never be accepted at once (the person's own information), while an invitation to someone at the cap is accepted into the table without disclosing anything", async () => {
    const [a, b, c, person] = await h.newPeople(4, "Early");
    const [t1, t2, t3] = [await h.createTeam(a), await h.createTeam(b), await h.createTeam(c)];
    await h.addMember(t1.teamId, a, person);
    await h.addMember(t2.teamId, b, person);
    await refused("propose_lifetime_team_membership_atomically", offer(t3.teamId, person, person), "LIFETIME_MEMBERSHIP_CAP_REACHED");
    const invitation = await one("propose_lifetime_team_membership_atomically", offer(t3.teamId, c, person));
    expect(invitation.status).toBe("PENDING");
    await refused("decide_lifetime_team_membership_atomically", decide(invitation.lifetime_team_membership_id, person, "ACCEPT"), "LIFETIME_MEMBERSHIP_CAP_REACHED");
  });

  it("refuses a leader joining another team, and refuses a seat to someone who still belongs to another team (they must leave it first, explicitly)", async () => {
    const [captainA, captainB, person] = await h.newPeople(3, "Leaders");
    const a = await h.createTeam(captainA);
    const b = await h.createTeam(captainB);
    // A leader cannot join another team.
    const invite = await one("propose_lifetime_team_membership_atomically", offer(b.teamId, captainB, captainA));
    await refused("decide_lifetime_team_membership_atomically", decide(invite.lifetime_team_membership_id, captainA, "ACCEPT"), "LIFETIME_LEADER_CANNOT_JOIN_OTHER_TEAM");
    await refused("propose_lifetime_team_membership_atomically", offer(b.teamId, captainA, captainA), "LIFETIME_LEADER_CANNOT_JOIN_OTHER_TEAM");
    // A person on two teams cannot take a seat in one of them until they leave the other.
    await h.addMember(a.teamId, captainA, person);
    await h.addMember(b.teamId, captainB, person);
    const seat = await one("offer_lifetime_team_leadership_atomically", { p_lifetime_team_id: a.teamId, p_actor_gaming_member_id: captainA.gamingMemberId, p_subject_gaming_member_id: person.gamingMemberId });
    const accept = { p_lifetime_team_leadership_id: seat.lifetime_team_leadership_id, p_actor_gaming_member_id: person.gamingMemberId, p_decision: "ACCEPT" };
    await refused("decide_lifetime_team_leadership_atomically", accept, "LIFETIME_LEADER_MUST_BELONG_TO_ONE_TEAM");
    await one("end_lifetime_team_membership_atomically", { p_lifetime_team_id: b.teamId, p_actor_gaming_member_id: person.gamingMemberId, p_subject_gaming_member_id: person.gamingMemberId });
    const taken = await one("decide_lifetime_team_leadership_atomically", accept);
    expect(taken.status).toBe("ACTIVE");
    // Now a leader of A cannot be invited to a second team either.
    const second = await one("propose_lifetime_team_membership_atomically", offer(b.teamId, captainB, person));
    await refused("decide_lifetime_team_membership_atomically", decide(second.lifetime_team_membership_id, person, "ACCEPT"), "LIFETIME_LEADER_CANNOT_JOIN_OTHER_TEAM");
  });
});

// =============================================================================================================================================
describe("[4] captain, sub-captain and succession", () => {
  it("lets only the captain offer the sub-captain seat, only to an active member, who then accepts or declines", async () => {
    const [captain, member, outsider, other] = await h.newPeople(4, "Seat");
    const team = await h.createTeam(captain);
    await h.addMember(team.teamId, captain, member);
    const seatArgs = (actor: { gamingMemberId: string }, subject: { gamingMemberId: string }) => ({ p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: actor.gamingMemberId, p_subject_gaming_member_id: subject.gamingMemberId });
    await refused("offer_lifetime_team_leadership_atomically", seatArgs(member, member), "LIFETIME_NOT_THE_CAPTAIN");
    await refused("offer_lifetime_team_leadership_atomically", seatArgs(outsider, member), "LIFETIME_NOT_THE_CAPTAIN");
    await refused("offer_lifetime_team_leadership_atomically", seatArgs(captain, outsider), "LIFETIME_NOT_A_MEMBER");
    await refused("offer_lifetime_team_leadership_atomically", seatArgs(captain, captain), "LIFETIME_SEAT_SUBJECT_INVALID");
    const seat = await one("offer_lifetime_team_leadership_atomically", seatArgs(captain, member));
    expect(seat.status).toBe("PENDING");
    await refused("offer_lifetime_team_leadership_atomically", seatArgs(captain, member), "LIFETIME_SEAT_TAKEN");
    await refused("decide_lifetime_team_leadership_atomically", { p_lifetime_team_leadership_id: seat.lifetime_team_leadership_id, p_actor_gaming_member_id: captain.gamingMemberId, p_decision: "ACCEPT" }, "LIFETIME_OFFER_WRONG_PARTY");
    const declined = await one("decide_lifetime_team_leadership_atomically", { p_lifetime_team_leadership_id: seat.lifetime_team_leadership_id, p_actor_gaming_member_id: member.gamingMemberId, p_decision: "DECLINE" });
    expect(declined.status).toBe("ENDED");
    await h.makeSubCaptain(team.teamId, captain, member);
    await h.addMember(team.teamId, captain, other);
    await refused("offer_lifetime_team_leadership_atomically", seatArgs(captain, other), "LIFETIME_SEAT_TAKEN");
    const seats = await leadership(team.teamId);
    expect(seats.filter((s) => s.status === "ACTIVE").map((s) => s.role).sort()).toEqual(["CAPTAIN", "SUB_CAPTAIN"]);
    expect(seats.some((s) => s.status === "ENDED" && s.end_reason === "DECLINED")).toBe(true);
  });

  it("lets the sub-captain step down and the captain remove the sub-captain; the seat's history stays and a new sub-captain can follow", async () => {
    const [captain, sub, next] = await h.newPeople(3, "Steps");
    const team = await h.createTeam(captain);
    await h.addMember(team.teamId, captain, sub);
    await h.addMember(team.teamId, captain, next);
    await h.makeSubCaptain(team.teamId, captain, sub);
    await refused("end_lifetime_team_leadership_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: next.gamingMemberId }, "LIFETIME_NOT_A_LEADER");
    const stepped = await one("end_lifetime_team_leadership_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: sub.gamingMemberId });
    expect(stepped.end_reason).toBe("STEPPED_DOWN");
    await refused("end_lifetime_team_leadership_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: captain.gamingMemberId }, "LIFETIME_SEAT_EMPTY");
    await h.makeSubCaptain(team.teamId, captain, next);
    const removed = await one("end_lifetime_team_leadership_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: captain.gamingMemberId });
    expect(removed.end_reason).toBe("REMOVED");
    const seats = await leadership(team.teamId);
    expect(seats.filter((s) => s.role === "SUB_CAPTAIN").map((s) => s.end_reason)).toEqual(["STEPPED_DOWN", "REMOVED"]);
    expect(await activeMembers(team.teamId)).toEqual(expect.arrayContaining([captain.gamingMemberId, sub.gamingMemberId, next.gamingMemberId]));
  });

  it("lets a captain leave only by naming a successor: the sub-captain becomes captain, and every leadership row stays (history is never overwritten)", async () => {
    const team = await h.buildTeam("Succession", 4);
    const { captain, subCaptain, members } = team;
    const leave = { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: captain.gamingMemberId, p_subject_gaming_member_id: captain.gamingMemberId };
    await refused("end_lifetime_team_membership_atomically", { ...leave, p_successor_gaming_member_id: members[0].gamingMemberId }, "LIFETIME_SUCCESSOR_INVALID");
    await refused("end_lifetime_team_membership_atomically", { ...leave, p_successor_gaming_member_id: captain.gamingMemberId }, "LIFETIME_SUCCESSOR_INVALID");
    const before = await leadership(team.teamId);
    const left = await one("end_lifetime_team_membership_atomically", leave); // the default successor is the sub-captain
    expect(left.successor_leadership_id).toBeTruthy();
    const after = await leadership(team.teamId);
    expect(after).toHaveLength(before.length + 1);
    const byPerson = (id: string, role: string) => after.filter((s) => s.gaming_member_id === id && s.role === role);
    expect(byPerson(captain.gamingMemberId, "CAPTAIN")).toMatchObject([{ status: "ENDED", end_reason: "SUCCEEDED" }]);
    expect(byPerson(subCaptain!.gamingMemberId, "SUB_CAPTAIN")).toMatchObject([{ status: "ENDED", end_reason: "PROMOTED" }]);
    const newCaptain = byPerson(subCaptain!.gamingMemberId, "CAPTAIN");
    expect(newCaptain).toHaveLength(1);
    expect(newCaptain[0]).toMatchObject({ status: "ACTIVE" });
    expect(newCaptain[0].predecessor_leadership_id).toBe(byPerson(captain.gamingMemberId, "CAPTAIN")[0].lifetime_team_leadership_id);
    expect(await activeMembers(team.teamId)).not.toContain(captain.gamingMemberId);
    expect(await eventTypes(team.teamId)).toEqual(expect.arrayContaining(["CAPTAINCY_SUCCEEDED", "MEMBERSHIP_ENDED"]));
    // The old captain is now an ordinary former member: free to create or join anything again.
    await h.createTeam(captain);
  });

  it("refuses a captain who tries to leave with nobody to succeed them, and a leader who tries to remove the other leader", async () => {
    const [captain, member] = await h.newPeople(2, "Alone");
    const team = await h.createTeam(captain);
    const leave = { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: captain.gamingMemberId, p_subject_gaming_member_id: captain.gamingMemberId };
    await refused("end_lifetime_team_membership_atomically", leave, "LIFETIME_CAPTAIN_NEEDS_SUCCESSOR");
    await h.addMember(team.teamId, captain, member);
    await refused("end_lifetime_team_membership_atomically", leave, "LIFETIME_CAPTAIN_NEEDS_SUCCESSOR");
    await h.makeSubCaptain(team.teamId, captain, member);
    await refused("end_lifetime_team_membership_atomically", { ...leave, p_actor_gaming_member_id: member.gamingMemberId }, "LIFETIME_LEADER_CANNOT_BE_REMOVED");
    await refused("end_lifetime_team_membership_atomically", { ...leave, p_subject_gaming_member_id: member.gamingMemberId }, "LIFETIME_LEADER_CANNOT_BE_REMOVED");
  });

  it("ends the seat when the sub-captain leaves the team, and lets members leave freely while a leader removes an ordinary member (a member cannot remove anyone)", async () => {
    const team = await h.buildTeam("Leaving", 5);
    const [m1, m2] = team.members;
    const end = (actor: { gamingMemberId: string }, subject: { gamingMemberId: string }) => ({ p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: actor.gamingMemberId, p_subject_gaming_member_id: subject.gamingMemberId });
    await refused("end_lifetime_team_membership_atomically", end(m1, m2), "LIFETIME_NOT_A_LEADER");
    await refused("end_lifetime_team_membership_atomically", end(m1, team.captain), "LIFETIME_NOT_A_LEADER");
    const removed = await one("end_lifetime_team_membership_atomically", end(team.captain, m2));
    expect(removed.ended_at).toBeTruthy();
    expect((await rawQuery("select end_reason from lifetime_team_memberships where lifetime_team_id = $1 and gaming_member_id = $2", [team.teamId, m2.gamingMemberId]))[0].end_reason).toBe("REMOVED");
    await one("end_lifetime_team_membership_atomically", end(m1, m1));
    expect((await rawQuery("select end_reason from lifetime_team_memberships where lifetime_team_id = $1 and gaming_member_id = $2", [team.teamId, m1.gamingMemberId]))[0].end_reason).toBe("LEFT");
    await refused("end_lifetime_team_membership_atomically", end(m1, m1), "LIFETIME_NOT_A_MEMBER");
    await one("end_lifetime_team_membership_atomically", end(team.subCaptain!, team.subCaptain!));
    const seat = (await leadership(team.teamId)).find((s) => s.role === "SUB_CAPTAIN")!;
    expect(seat).toMatchObject({ status: "ENDED", end_reason: "STEPPED_DOWN" });
    // The captain and the one ordinary member nobody removed are what is left.
    expect(await activeMembers(team.teamId)).toEqual([team.captain.gamingMemberId, team.members[2].gamingMemberId]);
  });
});

// =============================================================================================================================================
describe("[5] disbanding", () => {
  it("lets only the captain disband; every open period, seat and offer ends; the team keeps its history and takes no new offers", async () => {
    const team = await h.buildTeam("Disband", 4);
    const [outsider] = await h.newPeople(1, "Pending");
    const pending = await one("propose_lifetime_team_membership_atomically", offer(team.teamId, team.captain, outsider));
    const disband = (actor: { gamingMemberId: string }) => ({ p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: actor.gamingMemberId });
    await refused("disband_lifetime_team_atomically", disband(team.subCaptain!), "LIFETIME_NOT_THE_CAPTAIN");
    await refused("disband_lifetime_team_atomically", disband(team.members[0]), "LIFETIME_NOT_THE_CAPTAIN");
    const done = await one("disband_lifetime_team_atomically", disband(team.captain));
    expect(done.status).toBe("DISBANDED");
    const [row] = await rawQuery("select status, disbanded_at, disbanded_by_gaming_member_id from lifetime_teams where lifetime_team_id = $1", [team.teamId]);
    expect(row).toMatchObject({ status: "DISBANDED", disbanded_by_gaming_member_id: team.captain.gamingMemberId });
    expect(row.disbanded_at).toBeInstanceOf(Date);
    expect(await activeMembers(team.teamId)).toEqual([]);
    expect((await leadership(team.teamId)).every((s) => s.status === "ENDED" && s.end_reason !== null)).toBe(true);
    expect((await rawQuery("select status, end_reason from lifetime_team_memberships where lifetime_team_membership_id = $1", [pending.lifetime_team_membership_id]))[0]).toMatchObject({ status: "ENDED", end_reason: "TEAM_DISBANDED" });
    expect(await eventTypes(team.teamId)).toContain("TEAM_DISBANDED");
    // A disbanded team has no leaders: the ex-captain is answered exactly like a stranger, and only a person's OWN request is told the team has been disbanded.
    await refused("propose_lifetime_team_membership_atomically", offer(team.teamId, team.captain, outsider), "LIFETIME_NOT_A_LEADER");
    await refused("propose_lifetime_team_membership_atomically", offer(team.teamId, outsider, outsider), "LIFETIME_TEAM_NOT_ACTIVE");
    await refused("disband_lifetime_team_atomically", disband(team.captain), "LIFETIME_NOT_THE_CAPTAIN");
    // Everyone on it is free again, with a full history behind them.
    await h.createTeam(team.captain);
    await h.createTeam(team.subCaptain!);
    const periods = await rawQuery("select count(*)::int n from lifetime_team_memberships where lifetime_team_id = $1 and joined_at is not null", [team.teamId]);
    expect(periods[0].n).toBe(4);
  });
});

// =============================================================================================================================================
describe("[6] history and rules are held by the tables, not only by the operations", () => {
  /** A direct write (as the database owner) must be refused BY THE RULE under test: its SQLSTATE and its words are asserted, so a constraint that happens to refuse it first cannot stand in for the guard. */
  const refusedBy = async (sql: string, params: unknown[], expected: { sqlstate: string; message?: RegExp; constraint?: string }) => {
    const v = await violation(sql, params);
    expect(v, sql).not.toBeNull();
    expect(v!.code, `${sql} -> ${v!.message}`).toBe(expected.sqlstate);
    if (expected.message) expect(v!.message, sql).toMatch(expected.message);
    if (expected.constraint) expect(v!.constraint, sql).toBe(expected.constraint);
  };
  const GUARD = (words: string) => ({ sqlstate: "P0001", message: new RegExp(`^LIFETIME_INVARIANT_VIOLATION: ${words}`) });

  it("never lets a history row be deleted, rewritten or truncated — even by the database owner", async () => {
    const team = await h.buildTeam("History", 3);
    const membership = (await rawQuery("select lifetime_team_membership_id id from lifetime_team_memberships where lifetime_team_id = $1 and gaming_member_id = $2", [team.teamId, team.members[0].gamingMemberId]))[0].id;
    const seat = (await leadership(team.teamId))[0].lifetime_team_leadership_id;
    const event = (await rawQuery("select event_id id from lifetime_team_events where lifetime_team_id = $1 order by event_seq limit 1", [team.teamId]))[0].id;
    await refusedBy("delete from lifetime_team_memberships where lifetime_team_membership_id = $1", [membership], GUARD("a membership record is never deleted"));
    await refusedBy("update lifetime_team_memberships set joined_at = joined_at - interval '1 day' where lifetime_team_membership_id = $1", [membership], GUARD("a membership record moves forward only"));
    await refusedBy("update lifetime_team_memberships set gaming_member_id = $2 where lifetime_team_membership_id = $1", [membership, team.captain.gamingMemberId], GUARD("a membership record keeps what it recorded"));
    await refusedBy("update lifetime_team_memberships set status = 'PENDING' where lifetime_team_membership_id = $1", [membership], GUARD("a membership record moves forward only"));
    await refusedBy("delete from lifetime_team_leaderships where lifetime_team_leadership_id = $1", [seat], GUARD("a leadership record is never deleted"));
    await refusedBy("update lifetime_team_leaderships set role = 'SUB_CAPTAIN' where lifetime_team_leadership_id = $1", [seat], GUARD("a leadership record keeps what it recorded"));
    await refusedBy("update lifetime_team_leaderships set started_at = started_at - interval '1 day' where lifetime_team_leadership_id = $1", [seat], GUARD("a leadership record moves forward only"));
    await refusedBy("delete from lifetime_team_events where event_id = $1", [event], GUARD("this record is history"));
    await refusedBy("update lifetime_team_events set event_type = 'TEAM_DISBANDED' where event_id = $1", [event], GUARD("this record is history"));
    // TRUNCATE has no row to refuse: each history table is held by its own BEFORE TRUNCATE trigger (nothing references most of them, so no foreign key would stop it).
    for (const table of ["lifetime_team_events", "lifetime_team_memberships", "lifetime_team_leaderships", "lifetime_team_legacy_sources", "competition_lifetime_freezes"]) {
      await refusedBy(`truncate ${table}`, [], GUARD("this record is history"));
    }
    await refusedBy("delete from lifetime_teams where lifetime_team_id = $1", [team.teamId], GUARD("a lifetime team is never deleted"));
    // A team keeps its identity: its code cannot move to ANY other well-formed value (so neither the unique key nor the shape check is what refuses it).
    await refusedBy("update lifetime_teams set public_code = 'AAAAAAAAAAAAAAAAAAAAAA' where lifetime_team_id = $1", [team.teamId], GUARD("a team keeps its identity, origin and creation"));
    // An ended period cannot be reopened, and an ended period is final.
    await one("end_lifetime_team_membership_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: team.members[0].gamingMemberId, p_subject_gaming_member_id: team.members[0].gamingMemberId });
    await refusedBy("update lifetime_team_memberships set status = 'ACTIVE', ended_at = null, end_reason = null where lifetime_team_membership_id = $1", [membership], GUARD("a membership record moves forward only"));
    await refusedBy("update lifetime_team_memberships set ended_at = ended_at + interval '1 day' where lifetime_team_membership_id = $1", [membership], GUARD("a membership record moves forward only"));
  });

  it("refuses, by the guard that holds each rule, a rewritten start and a reopened team — probes only that one rule can refuse (a claim for someone who left is probed in the entries suite)", async () => {
    // An ACTIVE period ended by a direct write may not move its start (the end stays after the start, so no CHECK is involved).
    const team = await h.buildTeam("GuardRules", 3);
    const membership = (await rawQuery("select lifetime_team_membership_id id from lifetime_team_memberships where lifetime_team_id = $1 and gaming_member_id = $2", [team.teamId, team.members[0].gamingMemberId]))[0].id;
    await refusedBy("update lifetime_team_memberships set status = 'ENDED', ended_at = now(), end_reason = 'LEFT', joined_at = joined_at - interval '3 days' where lifetime_team_membership_id = $1", [membership], GUARD("an ended period keeps its start"));
    const seat = (await rawQuery("select lifetime_team_leadership_id id from lifetime_team_leaderships where lifetime_team_id = $1 and role = 'SUB_CAPTAIN' and status = 'ACTIVE'", [team.teamId]))[0].id;
    await refusedBy("update lifetime_team_leaderships set status = 'ENDED', ended_at = now(), end_reason = 'STEPPED_DOWN', started_at = started_at - interval '3 days' where lifetime_team_leadership_id = $1", [seat], GUARD("an ended seat keeps its start"));
    // A disbanded team is history: not its name, not its status.
    const doomed = await h.buildTeam("GuardDisbanded", 2, { subCaptain: false });
    await one("disband_lifetime_team_atomically", { p_lifetime_team_id: doomed.teamId, p_actor_gaming_member_id: doomed.captain.gamingMemberId });
    await refusedBy("update lifetime_teams set name = 'Renamed After Disband' where lifetime_team_id = $1", [doomed.teamId], GUARD("a disbanded team is history"));
    await refusedBy("update lifetime_teams set status = 'ACTIVE', disbanded_at = null, disbanded_by_gaming_member_id = null where lifetime_team_id = $1", [doomed.teamId], GUARD("a disbanded team is history"));
  });

  it("enforces the cap, the exclusivity of leaders and one captain per team on a DIRECT write too, each by its own rule", async () => {
    const [a, b, c, person, leader, solo] = await h.newPeople(6, "Direct");
    const [t1, t2, t3] = [await h.createTeam(a), await h.createTeam(b), await h.createTeam(c)];
    await h.addMember(t1.teamId, a, person);
    await h.addMember(t2.teamId, b, person);
    await h.addMember(t1.teamId, a, solo);
    const insertMembership = (team: string, who: string, status = "ACTIVE") =>
      "insert into lifetime_team_memberships (lifetime_team_id, gaming_member_id, status, initiated_by_side, initiated_by_gaming_member_id, joined_at, expires_at) " +
      `values ('${team}', '${who}', '${status}', 'PERSON', '${who}', now(), now() + interval '7 days')`;
    await refusedBy(insertMembership(t3.teamId, person.gamingMemberId), [], { sqlstate: "P0001", message: /^LIFETIME_MEMBERSHIP_CAP_REACHED:/ });
    await refusedBy(insertMembership(t2.teamId, a.gamingMemberId), [], { sqlstate: "P0001", message: /^LIFETIME_LEADER_CANNOT_JOIN_OTHER_TEAM:/ });
    // A second captain for a team: `solo` belongs to ONLY this team and holds no seat, so every guard rule passes and the unique index is what refuses it.
    await refusedBy(
      "insert into lifetime_team_leaderships (lifetime_team_id, gaming_member_id, role, status, offered_by_gaming_member_id, started_at) values ($1, $2, 'CAPTAIN', 'ACTIVE', $2, now())", [t1.teamId, solo.gamingMemberId],
      { sqlstate: "23505", constraint: "lifetime_team_leaderships_one_active_per_role" });
    // A seat for someone who is not a member of the team, and for a person on two teams: the guard's own words.
    await refusedBy(
      "insert into lifetime_team_leaderships (lifetime_team_id, gaming_member_id, role, status, offered_by_gaming_member_id, started_at) values ($1, $2, 'SUB_CAPTAIN', 'ACTIVE', $3, now())", [t3.teamId, leader.gamingMemberId, c.gamingMemberId],
      { sqlstate: "P0001", message: /^LIFETIME_NOT_A_MEMBER:/ });
    await refusedBy(
      "insert into lifetime_team_leaderships (lifetime_team_id, gaming_member_id, role, status, offered_by_gaming_member_id, started_at) values ($1, $2, 'SUB_CAPTAIN', 'ACTIVE', $3, now())", [t1.teamId, person.gamingMemberId, a.gamingMemberId],
      { sqlstate: "P0001", message: /^LIFETIME_LEADER_MUST_BELONG_TO_ONE_TEAM:/ });
  });

  /** The events of a team since `skip` of them, as (type, actor, subject) — the exact sequence an operation must have written. */
  const since = async (teamId: string, skip: number) => (await rawQuery("select event_type, actor_gaming_member_id actor, subject_gaming_member_id subject, related_id, details from lifetime_team_events where lifetime_team_id = $1 order by event_seq", [teamId])).slice(skip);
  const count = async (teamId: string) => (await rawQuery("select count(*)::int n from lifetime_team_events where lifetime_team_id = $1", [teamId]))[0].n as number;

  it("writes exactly the events of every operation — type, actor, subject and the record they are about — in the order they happened", async () => {
    const [cap, m, o] = await h.newPeople(3, "Audit");
    const [c, mm, oo] = [cap.gamingMemberId, m.gamingMemberId, o.gamingMemberId];
    const team = await h.createTeam(cap);
    const trail = async (label: string, run: () => Promise<unknown>, expected: Array<[string, string | null, string | null]>) => {
      const skip = await count(team.teamId);
      await run();
      expect((await since(team.teamId, skip)).map((e) => [e.event_type, e.actor, e.subject]), label).toEqual(expected);
      return since(team.teamId, skip);
    };
    expect((await since(team.teamId, 0)).map((e) => [e.event_type, e.actor, e.subject])).toEqual([["TEAM_CREATED", c, c], ["MEMBERSHIP_ACTIVATED", c, c], ["LEADERSHIP_ACTIVATED", c, c]]);

    const invitation = async () => (await one("propose_lifetime_team_membership_atomically", offer(team.teamId, cap, m))).lifetime_team_membership_id as string;
    let id = "";
    let rows = await trail("invitation declined", async () => { id = await invitation(); await one("decide_lifetime_team_membership_atomically", decide(id, m, "DECLINE")); }, [["MEMBERSHIP_OFFERED", c, mm], ["MEMBERSHIP_DECLINED", mm, mm]]);
    expect(rows.map((e) => e.related_id)).toEqual([id, id]);
    rows = await trail("invitation withdrawn", async () => { id = await invitation(); await one("withdraw_lifetime_team_offer_atomically", { p_offer_kind: "MEMBERSHIP", p_offer_id: id, p_actor_gaming_member_id: c }); }, [["MEMBERSHIP_OFFERED", c, mm], ["MEMBERSHIP_WITHDRAWN", c, mm]]);
    expect(rows.map((e) => e.related_id)).toEqual([id, id]);
    await trail("invitation accepted", async () => { id = await invitation(); await one("decide_lifetime_team_membership_atomically", decide(id, m, "ACCEPT")); }, [["MEMBERSHIP_OFFERED", c, mm], ["MEMBERSHIP_ACTIVATED", mm, mm]]);
    await h.addMember(team.teamId, cap, o);

    const seatOffer = async () => (await one("offer_lifetime_team_leadership_atomically", offer(team.teamId, cap, m))).lifetime_team_leadership_id as string;
    rows = await trail("seat declined", async () => { id = await seatOffer(); await one("decide_lifetime_team_leadership_atomically", { p_lifetime_team_leadership_id: id, p_actor_gaming_member_id: mm, p_decision: "DECLINE" }); }, [["LEADERSHIP_OFFERED", c, mm], ["LEADERSHIP_DECLINED", mm, mm]]);
    expect(rows.map((e) => e.related_id)).toEqual([id, id]);
    rows = await trail("seat withdrawn", async () => { id = await seatOffer(); await one("withdraw_lifetime_team_offer_atomically", { p_offer_kind: "LEADERSHIP", p_offer_id: id, p_actor_gaming_member_id: c }); }, [["LEADERSHIP_OFFERED", c, mm], ["LEADERSHIP_WITHDRAWN", c, mm]]);
    expect(rows.map((e) => e.related_id)).toEqual([id, id]);
    await trail("seat accepted", async () => { id = await seatOffer(); await one("decide_lifetime_team_leadership_atomically", { p_lifetime_team_leadership_id: id, p_actor_gaming_member_id: mm, p_decision: "ACCEPT" }); }, [["LEADERSHIP_OFFERED", c, mm], ["LEADERSHIP_ACTIVATED", mm, mm]]);
    rows = await trail("seat removed by the captain", () => one("end_lifetime_team_leadership_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: c }), [["LEADERSHIP_ENDED", c, mm]]);
    expect(rows[0].related_id).not.toBeNull();
    expect(rows[0].details).toMatchObject({ role: "SUB_CAPTAIN", end_reason: "REMOVED" });
    await h.makeSubCaptain(team.teamId, cap, m);
    rows = await trail("a sub-captain leaves (steps down, then leaves)", () => one("end_lifetime_team_membership_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: mm, p_subject_gaming_member_id: mm }), [["LEADERSHIP_ENDED", mm, mm], ["MEMBERSHIP_ENDED", mm, mm]]);
    expect(rows.every((e) => e.related_id !== null)).toBe(true);
    await h.addMember(team.teamId, cap, m);
    await h.makeSubCaptain(team.teamId, cap, m);
    // A captain leaves, handing over: the succession is ONE event, then the membership.
    rows = await trail("the captain leaves, succeeded by the sub-captain", () => one("end_lifetime_team_membership_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: c, p_subject_gaming_member_id: c, p_successor_gaming_member_id: mm }), [["CAPTAINCY_SUCCEEDED", c, mm], ["MEMBERSHIP_ENDED", c, c]]);
    expect(rows[0].related_id).not.toBeNull();
    // The new captain invites the former one back and leaves it unanswered; then the disband: one event per ended membership (in the order the rows were made: the
    // ordinary member, the new captain's, the unanswered invitation) and per ended seat, and finally the disband itself.
    await one("propose_lifetime_team_membership_atomically", offer(team.teamId, m, cap));
    rows = await trail("the disband", () => one("disband_lifetime_team_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: mm }), [
      ["MEMBERSHIP_ENDED", mm, oo], ["MEMBERSHIP_ENDED", mm, mm], ["MEMBERSHIP_ENDED", mm, c], ["LEADERSHIP_ENDED", mm, mm], ["TEAM_DISBANDED", mm, null]]);
    expect(rows.slice(0, 4).every((e) => e.related_id !== null && (e.details as { end_reason?: string }).end_reason === "TEAM_DISBANDED")).toBe(true);

    // Whatever ended, an event is about it: no ended membership or seat (other than a handed-over captaincy, which has its own event) is without one.
    const unrecorded = await rawQuery(
      `select 'membership' k from lifetime_team_memberships m where m.lifetime_team_id = $1 and m.status = 'ENDED' and not exists (select 1 from lifetime_team_events e where e.related_id = m.lifetime_team_membership_id)
        union all
       select 'seat' from lifetime_team_leaderships l where l.lifetime_team_id = $1 and l.status = 'ENDED' and l.end_reason not in ('SUCCEEDED', 'PROMOTED') and not exists (select 1 from lifetime_team_events e where e.related_id = l.lifetime_team_leadership_id)`, [team.teamId]);
    expect(unrecorded).toEqual([]);
  });
});
