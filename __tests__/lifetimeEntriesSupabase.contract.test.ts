import { randomBytes } from "node:crypto";

import { afterAll, describe, expect, it, vi } from "vitest";
import { loadEnv } from "vite";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";

import { DAY, createHarness, type BuiltTeam, type LifetimeTestCompetition } from "./helpers/lifetimeContract";

/**
 * UG-CR-GATE-CFM-001 — Competition entry of a lifetime team, against a real (disposable, loopback-only) Postgres.
 *
 * Proves, in the database itself: a competition uses the lifetime flow only after its organizer explicitly enables it, and from then on every V1 team path
 * answers "registration is closed" (a lifetime-flow competition can never reach a draw or a fixture); a leader enters a lifetime team as an ENTRY — a
 * competition_teams row carrying immutable competition-time snapshots (name, captain, sub-captain, lifetime team); a person is on an entry's roster only
 * after THEIR OWN acceptance; at most one accepted claim per person per competition, whatever the order in which anyone typed a name; a claim is released by
 * rejection, withdrawal, removal or expiry before the freeze; and after the freeze every accepted claim stays as evidence, with a later departure only dated.
 */

// The shared contract-test guard (UG-CR-GATE-079) runs before anything is constructed: no target that is not loopback is ever touched.
const supabaseUrl = loadEnv("development", process.cwd(), "").SUPABASE_URL;
requireLocalSupabase(supabaseUrl);
// Every scenario here builds real people and teams through the real operations, and the freeze scenarios wait for a registration deadline to pass: none of them is
// a unit test. One explicit budget for the whole file (the repo's other contract suites do the same), instead of the 5 s default that a slow machine or a parallel run can cross.
vi.setConfig({ testTimeout: 90_000 });

const h = createHarness("le");
const { one, rpc, refused, rawQuery, violation, withClock } = h;

afterAll(() => h.cleanup(), 300000);

const claimRows = (competitionId: string) => rawQuery(
  "select * from competition_lifetime_roster_claims where competition_id = $1 order by proposed_at, competition_lifetime_roster_claim_id", [competitionId]);
const claimOf = async (claimId: string) => (await rawQuery("select * from competition_lifetime_roster_claims where competition_lifetime_roster_claim_id = $1", [claimId]))[0];
const accepted = (competitionId: string) => rawQuery("select gaming_member_id, competition_team_id from competition_lifetime_roster_claims where competition_id = $1 and status = 'ACCEPTED'", [competitionId]);
const entryRow = async (entryId: string) => (await rawQuery("select * from competition_teams where competition_team_id = $1", [entryId]))[0];
const deadlineOf = async (competitionId: string): Promise<Date> => (await rawQuery("select registration_deadline_utc as d from competition_current_registration_plan($1)", [competitionId]))[0].d;

const proposeArgs = (entryId: string, actor: { gamingMemberId: string }, ids: string[]) => ({ p_competition_team_id: entryId, p_actor_gaming_member_id: actor.gamingMemberId, p_gaming_member_ids: ids });
const decideArgs = (claimId: string, actor: { gamingMemberId: string }, decision: string) => ({ p_competition_lifetime_roster_claim_id: claimId, p_actor_gaming_member_id: actor.gamingMemberId, p_decision: decision });
const releaseArgs = (claimId: string, actor: { gamingMemberId: string }) => ({ p_competition_lifetime_roster_claim_id: claimId, p_actor_gaming_member_id: actor.gamingMemberId });
const freezeArgs = (c: LifetimeTestCompetition, organizer: { gamingMemberId: string } | null = c.organizer) => ({ p_competition_id: c.competitionId, p_organizer_gaming_member_id: organizer?.gamingMemberId ?? null });

/**
 * A competition and two teams entered in it, each with `size` people on the roster (everyone has proposed, registered and affirmed). UG-CR-GATE-CFM-004: the organizer has
 * APPROVED both entries (before the deadline, as the rule requires) — the freeze counts only ACCEPTED entries, so an unapproved pair is no longer something it can freeze.
 */
async function twoRosteredEntries(label: string, size = 6) {
  const competition = await h.setUpCompetition(label);
  const [teamA, teamB] = [await h.buildTeam(`${label}A`, size), await h.buildTeam(`${label}B`, size)];
  const entryA = await h.enterTeam(competition, teamA);
  const entryB = await h.enterTeam(competition, teamB);
  await h.approveEntries(competition, entryA.entryId, entryB.entryId);
  const claimsA = await h.rosterUp(entryA.entryId, teamA.captain, competition, teamA.everyone);
  const claimsB = await h.rosterUp(entryB.entryId, teamB.captain, competition, teamB.everyone);
  return { competition, teamA, teamB, entryA, entryB, claimsA, claimsB };
}

/** A person who belongs to two teams, each entered in the same competition and each proposing that person. */
async function sharedPersonScenario(label: string, opts: { deadlineMs?: number; maximum?: number } = {}) {
  const competition = await h.setUpCompetition(label, opts);
  const [captainA, captainB, shared] = await h.newPeople(3, `${label}Cap`);
  const teamA = await h.createTeam(captainA);
  const teamB = await h.createTeam(captainB);
  await h.addMember(teamA.teamId, captainA, shared);
  await h.addMember(teamB.teamId, captainB, shared);
  const [fillerA, fillerB] = await h.newPeople(2, `${label}Fill`);
  await h.addMember(teamA.teamId, captainA, fillerA);
  await h.addMember(teamB.teamId, captainB, fillerB);
  const asBuilt = (team: { teamId: string; name: string }, captain: typeof captainA): BuiltTeam => ({ ...team, captain, subCaptain: null, members: [], everyone: [] });
  const entryA = await h.enterTeam(competition, asBuilt(teamA, captainA));
  const entryB = await h.enterTeam(competition, asBuilt(teamB, captainB));
  const proposedA = await rpc("propose_lifetime_entry_roster_claims_atomically", proposeArgs(entryA.entryId, captainA, [shared.gamingMemberId]));
  const proposedB = await rpc("propose_lifetime_entry_roster_claims_atomically", proposeArgs(entryB.entryId, captainB, [shared.gamingMemberId]));
  await h.register(competition, shared);
  return {
    competition, captainA, captainB, shared, teamA, teamB, entryA, entryB, fillerA, fillerB,
    claimA: proposedA[0].competition_lifetime_roster_claim_id as string, claimB: proposedB[0].competition_lifetime_roster_claim_id as string,
  };
}

// =============================================================================================================================================
describe("[1] a competition uses the lifetime flow only when its organizer enables it", () => {
  it("is enabled by the competition's own organizer, once (a retry returns the same switch), and leaves no other trace", async () => {
    const competition = await h.setUpCompetition("Flow", { lifetimeFlow: false });
    expect(await rawQuery("select 1 from competition_lifetime_flows where competition_id = $1", [competition.competitionId])).toHaveLength(0);
    const first = await one("enable_lifetime_entry_flow_atomically", { p_competition_id: competition.competitionId, p_organizer_gaming_member_id: competition.organizer.gamingMemberId });
    expect(first.already_enabled).toBe(false);
    const again = await one("enable_lifetime_entry_flow_atomically", { p_competition_id: competition.competitionId, p_organizer_gaming_member_id: competition.organizer.gamingMemberId });
    expect(again.already_enabled).toBe(true);
    expect(new Date(again.enabled_at).getTime()).toBe(new Date(first.enabled_at).getTime());
    const [flow] = await rawQuery("select * from competition_lifetime_flows where competition_id = $1", [competition.competitionId]);
    expect(flow.enabled_by_gaming_member_id).toBe(competition.organizer.gamingMemberId);
    const [row] = await rawQuery("select state from competitions where competition_id = $1", [competition.competitionId]);
    expect(row.state).toBe("TEAM_REGISTRATION_OPEN");
  });

  it("is refused to anyone but the organizer (a missing organizer too), for an unknown competition, for a cancelled one, and for one that already has legacy teams", async () => {
    const competition = await h.setUpCompetition("FlowRefuse", { lifetimeFlow: false });
    const [stranger] = await h.newPeople(1, "Stranger");
    await refused("enable_lifetime_entry_flow_atomically", { p_competition_id: competition.competitionId, p_organizer_gaming_member_id: stranger.gamingMemberId }, "COMPETITION_ACCESS_DENIED");
    await refused("enable_lifetime_entry_flow_atomically", { p_competition_id: competition.competitionId, p_organizer_gaming_member_id: null }, "COMPETITION_ACCESS_DENIED");
    await refused("enable_lifetime_entry_flow_atomically", { p_competition_id: "00000000-0000-4000-8000-000000000000", p_organizer_gaming_member_id: competition.organizer.gamingMemberId }, "COMPETITION_NOT_FOUND");
    expect(await rawQuery("select 1 from competition_lifetime_flows where competition_id = $1", [competition.competitionId])).toHaveLength(0);
    // A competition that already has a legacy (V1) team keeps the legacy flow.
    await h.rpc("add_competition_team_atomically", { p_competition_id: competition.competitionId, p_organizer_gaming_member_id: competition.organizer.gamingMemberId, p_name: h.uniqueName("Legacy"), p_captain_gaming_member_id: stranger.gamingMemberId, p_public_code: randomBytes(16).toString("base64url") });
    await refused("enable_lifetime_entry_flow_atomically", { p_competition_id: competition.competitionId, p_organizer_gaming_member_id: competition.organizer.gamingMemberId }, "LIFETIME_FLOW_CONFLICT");
    const cancelled = await h.setUpCompetition("FlowCancelled", { lifetimeFlow: false });
    await rawQuery("update competitions set state = 'CANCELLED_WITHOUT_CHAMPION' where competition_id = $1", [cancelled.competitionId]);
    await refused("enable_lifetime_entry_flow_atomically", { p_competition_id: cancelled.competitionId, p_organizer_gaming_member_id: cancelled.organizer.gamingMemberId }, "COMPETITION_CANCELLED");
  });

  it("is refused once the organizer's hosting access has been revoked", async () => {
    const competition = await h.setUpCompetition("FlowRevoked", { lifetimeFlow: false });
    const outcome = await h.rawTransaction(async (db) => {
      await db.query("set local session_replication_role = replica");
      await db.query(
        `insert into competition_host_capabilities (host_application_id, gaming_member_id, state, competition_id, granted_by_gaming_member_id, consumed_at, revoked_at, revoked_by_gaming_member_id, revoke_reason)
         values (gen_random_uuid(), $2, 'REVOKED', $1, $2, now(), now(), $2, 'contract-test fixture')`, [competition.competitionId, competition.organizer.gamingMemberId]);
      await db.query("set local session_replication_role = origin");
      try {
        await db.query("select * from enable_lifetime_entry_flow_atomically($1::uuid, $2::uuid)", [competition.competitionId, competition.organizer.gamingMemberId]);
        return null;
      } catch (err) {
        return (err as { message: string }).message;
      }
    });
    expect(outcome).toMatch(/^HOST_ACCESS_REVOKED:/);
  });

  it("makes the switch permanent and exclusive: it cannot be changed or removed, and cannot be added beside legacy teams by a direct write either", async () => {
    const competition = await h.setUpCompetition("FlowPermanent");
    expect(await violation("update competition_lifetime_flows set enabled_at = now() where competition_id = $1", [competition.competitionId])).not.toBeNull();
    expect(await violation("delete from competition_lifetime_flows where competition_id = $1", [competition.competitionId])).not.toBeNull();
    expect(await violation("truncate competition_lifetime_flows")).not.toBeNull();
    const legacy = await h.setUpCompetition("FlowLegacy", { lifetimeFlow: false });
    const [person] = await h.newPeople(1, "Legacy Captain");
    await h.rpc("add_competition_team_atomically", { p_competition_id: legacy.competitionId, p_organizer_gaming_member_id: legacy.organizer.gamingMemberId, p_name: h.uniqueName("Old"), p_captain_gaming_member_id: person.gamingMemberId, p_public_code: randomBytes(16).toString("base64url") });
    const direct = await violation("insert into competition_lifetime_flows (competition_id, enabled_by_gaming_member_id, enabled_at) values ($1, $2, now())", [legacy.competitionId, legacy.organizer.gamingMemberId]);
    expect(direct?.message).toMatch(/^LIFETIME_FLOW_CONFLICT:/);
  });

  it("makes every V1 team path answer \"registration is closed\" once the flow is enabled, and no V1 freeze, draw or fixture can exist", async () => {
    const competition = await h.setUpCompetition("V1Closed");
    const team = await h.buildTeam("V1ClosedTeam", 6);
    const entry = await h.enterTeam(competition, team);
    const [person] = await h.newPeople(1, "V1 Person");
    await h.register(competition, person);
    const closed = "TEAM_REGISTRATION_NOT_OPEN";
    await refused("add_competition_team_atomically", { p_competition_id: competition.competitionId, p_organizer_gaming_member_id: competition.organizer.gamingMemberId, p_name: h.uniqueName("V1"), p_captain_gaming_member_id: person.gamingMemberId, p_public_code: randomBytes(16).toString("base64url") }, closed);
    await refused("propose_competition_team_atomically", { p_competition_id: competition.competitionId, p_name: h.uniqueName("V1"), p_proposing_gaming_member_id: person.gamingMemberId, p_public_code: randomBytes(16).toString("base64url") }, closed);
    // The organizer cannot approve (or reject) a lifetime entry through the V1 decision either: only the lifetime operations change an entry.
    await refused("decide_competition_team_atomically", { p_competition_team_id: entry.entryId, p_organizer_gaming_member_id: competition.organizer.gamingMemberId, p_decision: "APPROVE", p_reason: null }, closed);
    await refused("decide_competition_team_atomically", { p_competition_team_id: entry.entryId, p_organizer_gaming_member_id: competition.organizer.gamingMemberId, p_decision: "REJECT", p_reason: "no" }, closed);
    expect((await entryRow(entry.entryId)).status).toBe("PENDING_ORGANIZER_APPROVAL");
    // The V1 freeze needs four ACCEPTED teams, and none can exist; a direct V1 freeze or fixture row for this competition is refused by the table.
    await h.passDeadline(competition.competitionId);
    const v1Close = await h.settle("close_team_registration_atomically", { p_competition_id: competition.competitionId, p_organizer_gaming_member_id: competition.organizer.gamingMemberId });
    // Refused by V1's own capacity rule (it needs four ACCEPTED teams, and a lifetime entry never is one), not by anything else.
    expect(v1Close).toMatchObject({ ok: false, refusal: "TEAM_REGISTRATION_CAPACITY_NOT_REACHED" });
    expect(await rawQuery("select 1 from competition_registration_freezes where competition_id = $1", [competition.competitionId])).toHaveLength(0);
    const freezeInsert = await violation(
      `insert into competition_registration_freezes (competition_id, planning_revision_id, format_key, roster_minimum, roster_maximum, registration_deadline_utc, frozen_at, frozen_by_gaming_member_id, team_count, member_count, snapshot_digest)
       select $1, planning_revision_id, format_key, roster_minimum, roster_maximum, registration_deadline_utc, now(), $2, 4, 0, repeat('a', 64) from competition_planning_revisions where competition_id = $1 limit 1`, [competition.competitionId, competition.organizer.gamingMemberId]);
    // The refusals below can only come from the lifetime-flow guards: the V1 freeze's own checks are deferred (they would not run inside this statement), and the fixture is otherwise valid.
    expect(freezeInsert?.message).toMatch(/^REGISTRATION_FREEZE_INVALID:/);
    const fixtureInsert = await violation(
      "insert into competition_fixtures (competition_id, fixture_role, scheduled_at, team_a_competition_team_id) values ($1, 'SEMIFINAL_1', now() + interval '1 day', $2)", [competition.competitionId, entry.entryId]);
    expect(fixtureInsert?.message).toMatch(/^COMPETITION_NOT_READY_TO_PUBLISH:/);
    expect((await rawQuery("select state from competitions where competition_id = $1", [competition.competitionId]))[0].state).toBe("TEAM_REGISTRATION_OPEN");
  });
});

// =============================================================================================================================================
describe("[2] entering a competition: an entry with competition-time snapshots", () => {
  it("lets a leader enter the team; the entry is a competition team row that carries the team's name, captain, sub-captain and lifetime reference", async () => {
    const competition = await h.setUpCompetition("Enter");
    const team = await h.buildTeam("Entering", 6);
    const entry = await h.enterTeam(competition, team);
    const row = await entryRow(entry.entryId);
    expect(row).toMatchObject({
      competition_id: competition.competitionId, name: team.name, captain_gaming_member_id: team.captain.gamingMemberId, sub_captain_gaming_member_id: team.subCaptain!.gamingMemberId,
      lifetime_team_id: team.teamId, entry_flow: "LIFETIME", status: "PENDING_ORGANIZER_APPROVAL", provenance: "MEMBER_PROPOSED",
    });
    expect(row.public_code).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(row.public_code).toBe(entry.publicCode);
    const events = await rawQuery("select event_type, details from lifetime_team_events where lifetime_team_id = $1 and event_type = 'ENTRY_SUBMITTED'", [team.teamId]);
    expect(events).toHaveLength(1);
    expect(JSON.stringify(events[0].details)).toContain(entry.entryId);
  });

  it("lets the sub-captain enter the team too; a member, an outsider and a missing actor cannot", async () => {
    const competition = await h.setUpCompetition("EnterWho");
    const team = await h.buildTeam("EnterWhoTeam", 6);
    const [outsider] = await h.newPeople(1, "Outsider");
    const args = (actor: { gamingMemberId: string } | null) => ({ p_competition_id: competition.competitionId, p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: actor?.gamingMemberId ?? null });
    for (const person of [team.members[0], outsider]) {
      await h.register(competition, person);
      await refused("enter_lifetime_team_into_competition_atomically", args(person), "LIFETIME_NOT_A_LEADER");
    }
    await refused("enter_lifetime_team_into_competition_atomically", args(null), "LIFETIME_NOT_A_LEADER");
    const entry = await h.enterTeam(competition, team, team.subCaptain!);
    expect((await entryRow(entry.entryId)).sub_captain_gaming_member_id).toBe(team.subCaptain!.gamingMemberId);
  });

  it("lets the same team enter two different competitions, each with its own entry, and refuses a second live entry in the same competition", async () => {
    const [one_, two] = [await h.setUpCompetition("TwoA"), await h.setUpCompetition("TwoB")];
    const team = await h.buildTeam("TwoComps", 6);
    const entryOne = await h.enterTeam(one_, team);
    const entryTwo = await h.enterTeam(two, team);
    expect(entryOne.entryId).not.toBe(entryTwo.entryId);
    expect((await entryRow(entryOne.entryId)).competition_id).toBe(one_.competitionId);
    expect((await entryRow(entryTwo.entryId)).competition_id).toBe(two.competitionId);
    await refused("enter_lifetime_team_into_competition_atomically", { p_competition_id: one_.competitionId, p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: team.captain.gamingMemberId }, "LIFETIME_ENTRY_ALREADY_EXISTS");
    // The same person can be accepted on the team's roster in BOTH competitions: the one-team rule is per competition.
    const person = team.members[0];
    const [claimOne] = await rpc("propose_lifetime_entry_roster_claims_atomically", proposeArgs(entryOne.entryId, team.captain, [person.gamingMemberId]));
    const [claimTwo] = await rpc("propose_lifetime_entry_roster_claims_atomically", proposeArgs(entryTwo.entryId, team.captain, [person.gamingMemberId]));
    await h.register(one_, person);
    await h.register(two, person);
    await one("decide_lifetime_entry_roster_claim_atomically", decideArgs(claimOne.competition_lifetime_roster_claim_id, person, "ACCEPT"));
    await one("decide_lifetime_entry_roster_claim_atomically", decideArgs(claimTwo.competition_lifetime_roster_claim_id, person, "ACCEPT"));
    expect((await accepted(one_.competitionId)).length + (await accepted(two.competitionId)).length).toBe(2);
  });

  it("keeps the snapshots whatever later happens to the team: succession, a new sub-captain, a different name — and the table refuses to change them", async () => {
    const competition = await h.setUpCompetition("Snapshots");
    const team = await h.buildTeam("Snapshotted", 6);
    const entry = await h.enterTeam(competition, team);
    const before = await entryRow(entry.entryId);
    // The captain leaves (the sub-captain succeeds), the new captain names another sub-captain, and the team is renamed (a service-side fixture: there is no rename operation).
    await one("end_lifetime_team_membership_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: team.captain.gamingMemberId, p_subject_gaming_member_id: team.captain.gamingMemberId });
    await h.makeSubCaptain(team.teamId, team.subCaptain!, team.members[0]);
    await rawQuery("update lifetime_teams set name = $2 where lifetime_team_id = $1", [team.teamId, `${team.name} Renamed`]);
    const after = await entryRow(entry.entryId);
    for (const column of ["name", "captain_gaming_member_id", "sub_captain_gaming_member_id", "lifetime_team_id", "entry_flow", "competition_id", "public_code", "provenance", "created_at"]) {
      expect(after[column], column).toEqual(before[column]);
    }
    expect(after.captain_gaming_member_id).toBe(team.captain.gamingMemberId);
    // The table itself refuses any change to a snapshot, a status change outside the lifetime operations, and a deletion.
    const snapshot = /^LIFETIME_INVARIANT_VIOLATION: an entry keeps the snapshot it was made with/;
    const lifetimeColumns = /^LIFETIME_INVARIANT_VIOLATION: the lifetime columns of an entry never change/;
    const identity = /^LIFETIME_INVARIANT_VIOLATION: a team entry keeps its identity and its competition/;
    const closed = /^TEAM_REGISTRATION_NOT_OPEN: registration is closed for this competition/;
    for (const [sql, params, words] of [
      ["update competition_teams set name = 'Other' where competition_team_id = $1", [entry.entryId], snapshot],
      ["update competition_teams set captain_gaming_member_id = $2 where competition_team_id = $1", [entry.entryId, team.members[0].gamingMemberId], snapshot],
      ["update competition_teams set sub_captain_gaming_member_id = null where competition_team_id = $1", [entry.entryId], lifetimeColumns],
      ["update competition_teams set lifetime_team_id = (select lifetime_team_id from lifetime_teams where lifetime_team_id <> $2 limit 1) where competition_team_id = $1", [entry.entryId, team.teamId], lifetimeColumns],
      ["update competition_teams set entry_flow = 'V1' where competition_team_id = $1", [entry.entryId], lifetimeColumns],
      ["update competition_teams set competition_team_id = gen_random_uuid() where competition_team_id = $1", [entry.entryId], identity],
      ["update competition_teams set competition_id = (select competition_id from competitions where competition_id <> $2 limit 1) where competition_team_id = $1", [entry.entryId, competition.competitionId], identity],
      ["update competition_teams set status = 'ACCEPTED' where competition_team_id = $1", [entry.entryId], closed],
      ["update competition_teams set status = 'REJECTED' where competition_team_id = $1", [entry.entryId], closed],
      ["delete from competition_teams where competition_team_id = $1", [entry.entryId], /^LIFETIME_INVARIANT_VIOLATION: an entry is never deleted/],
    ] as Array<[string, unknown[], RegExp]>) {
      const v = await violation(sql, params);
      expect(v, sql).not.toBeNull();
      expect({ sqlstate: v!.code, refusedBy: v!.message }, sql).toEqual({ sqlstate: "P0001", refusedBy: expect.stringMatching(words) });
    }
    expect((await entryRow(entry.entryId)).status).toBe("PENDING_ORGANIZER_APPROVAL");
  });

  it("refuses an entry for a dormant team, a disbanded team, an unregistered actor, a team that does not exist, and a competition that is not on the lifetime flow", async () => {
    const competition = await h.setUpCompetition("EnterRefuse");
    const [captain] = await h.newPeople(1, "Lonely");
    const lonely = await h.createTeam(captain);
    await h.register(competition, captain);
    const enter = (teamId: string, actor: { gamingMemberId: string }, c = competition) => ({ p_competition_id: c.competitionId, p_lifetime_team_id: teamId, p_actor_gaming_member_id: actor.gamingMemberId });
    await refused("enter_lifetime_team_into_competition_atomically", enter(lonely.teamId, captain), "LIFETIME_TEAM_DORMANT");
    const team = await h.buildTeam("Unregistered", 4);
    await refused("enter_lifetime_team_into_competition_atomically", enter(team.teamId, team.captain), "COMPETITION_REGISTRATION_REQUIRED");
    await h.register(competition, team.captain);
    await refused("enter_lifetime_team_into_competition_atomically", enter("00000000-0000-4000-8000-000000000000", team.captain), "LIFETIME_TEAM_NOT_FOUND");
    const gone = await h.buildTeam("Gone", 4);
    await one("disband_lifetime_team_atomically", { p_lifetime_team_id: gone.teamId, p_actor_gaming_member_id: gone.captain.gamingMemberId });
    // A disbanded team has no leaders: its ex-captain is answered exactly like a stranger (authorization comes before any word about the team's state).
    await refused("enter_lifetime_team_into_competition_atomically", enter(gone.teamId, gone.captain), "LIFETIME_NOT_A_LEADER");
    const legacyFlow = await h.setUpCompetition("EnterLegacy", { lifetimeFlow: false });
    await h.register(legacyFlow, team.captain);
    await refused("enter_lifetime_team_into_competition_atomically", enter(team.teamId, team.captain, legacyFlow), "LIFETIME_FLOW_NOT_ENABLED");
    await refused("enter_lifetime_team_into_competition_atomically", { ...enter(team.teamId, team.captain), p_competition_id: "00000000-0000-4000-8000-000000000000" }, "COMPETITION_NOT_FOUND");
  });

  it("refuses an entry while registration is not open, after the registration deadline and once the competition is cancelled", async () => {
    const team = await h.buildTeam("Timing", 6);
    const enter = (c: LifetimeTestCompetition) => ({ p_competition_id: c.competitionId, p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: team.captain.gamingMemberId });
    const draft = await h.setUpCompetition("TimingDraft", { open: false });
    await h.register(draft, team.captain).catch(() => {}); // registration is not open either; the entry must still be refused
    await refused("enter_lifetime_team_into_competition_atomically", enter(draft), "TEAM_REGISTRATION_NOT_OPEN");
    const late = await h.setUpCompetition("TimingLate");
    await h.register(late, team.captain);
    await h.passDeadline(late.competitionId);
    await refused("enter_lifetime_team_into_competition_atomically", enter(late), "TEAM_REGISTRATION_NOT_OPEN");
    const cancelled = await h.setUpCompetition("TimingCancelled");
    await h.register(cancelled, team.captain);
    await rawQuery("update competitions set state = 'CANCELLED_WITHOUT_CHAMPION' where competition_id = $1", [cancelled.competitionId]);
    await refused("enter_lifetime_team_into_competition_atomically", enter(cancelled), "COMPETITION_CANCELLED");
  });

  it("lets a leader withdraw an entry before the freeze: its claims are released, the old entry stays as history, and the team can enter again (re-entry)", async () => {
    const competition = await h.setUpCompetition("Withdraw");
    const team = await h.buildTeam("Withdrawing", 6);
    const entry = await h.enterTeam(competition, team);
    const claims = await h.rosterUp(entry.entryId, team.captain, competition, team.everyone.slice(0, 4));
    const [pendingClaim] = await rpc("propose_lifetime_entry_roster_claims_atomically", proposeArgs(entry.entryId, team.captain, [team.everyone[5].gamingMemberId]));
    await refused("withdraw_lifetime_competition_entry_atomically", { p_competition_team_id: entry.entryId, p_actor_gaming_member_id: team.members[0].gamingMemberId }, "LIFETIME_NOT_A_LEADER");
    const done = await one("withdraw_lifetime_competition_entry_atomically", { p_competition_team_id: entry.entryId, p_actor_gaming_member_id: team.subCaptain!.gamingMemberId });
    expect(done.released_claims).toBe(5);
    expect(await entryRow(entry.entryId)).toMatchObject({ status: "REJECTED", decided_by_gaming_member_id: team.subCaptain!.gamingMemberId });
    expect((await entryRow(entry.entryId)).decided_at).toBeInstanceOf(Date);
    const entryEvents = await rawQuery("select event_type, actor_gaming_member_id, related_id, details from lifetime_team_events where lifetime_team_id = $1 and event_type in ('ENTRY_SUBMITTED', 'ENTRY_WITHDRAWN') order by event_seq", [team.teamId]);
    expect(entryEvents.map((e) => [e.event_type, e.actor_gaming_member_id, e.related_id])).toEqual([
      ["ENTRY_SUBMITTED", team.captain.gamingMemberId, entry.entryId], ["ENTRY_WITHDRAWN", team.subCaptain!.gamingMemberId, entry.entryId]]);
    expect(entryEvents[1].details).toMatchObject({ competition_id: competition.competitionId, released_claims: 5 });
    for (const id of Object.values(claims)) expect(await claimOf(id)).toMatchObject({ status: "REMOVED", release_reason: "ENTRY_WITHDRAWN" });
    expect(await claimOf(pendingClaim.competition_lifetime_roster_claim_id)).toMatchObject({ status: "WITHDRAWN", release_reason: "ENTRY_WITHDRAWN" });
    expect(await accepted(competition.competitionId)).toHaveLength(0);
    await refused("withdraw_lifetime_competition_entry_atomically", { p_competition_team_id: entry.entryId, p_actor_gaming_member_id: team.captain.gamingMemberId }, "LIFETIME_ENTRY_NOT_LIVE");
    await refused("propose_lifetime_entry_roster_claims_atomically", proposeArgs(entry.entryId, team.captain, [team.everyone[4].gamingMemberId]), "LIFETIME_ENTRY_NOT_LIVE");
    // Re-entry: a new entry row; the withdrawn one and its claims stay as history; the same people can be accepted again.
    const second = await h.enterTeam(competition, team);
    expect(second.entryId).not.toBe(entry.entryId);
    await h.rosterUp(second.entryId, team.captain, competition, team.everyone.slice(0, 4));
    expect(await accepted(competition.competitionId)).toHaveLength(4);
    expect((await claimRows(competition.competitionId)).filter((c) => c.status === "REMOVED")).toHaveLength(4);
  });

  it("does not let a team with a live entry disband; once the entry is withdrawn (or its competition cancelled) it can", async () => {
    const competition = await h.setUpCompetition("DisbandEntry");
    const team = await h.buildTeam("DisbandEntryTeam", 4);
    const entry = await h.enterTeam(competition, team);
    await refused("disband_lifetime_team_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: team.captain.gamingMemberId }, "LIFETIME_TEAM_HAS_LIVE_ENTRIES");
    await one("withdraw_lifetime_competition_entry_atomically", { p_competition_team_id: entry.entryId, p_actor_gaming_member_id: team.captain.gamingMemberId });
    await one("disband_lifetime_team_atomically", { p_lifetime_team_id: team.teamId, p_actor_gaming_member_id: team.captain.gamingMemberId });
    const other = await h.setUpCompetition("DisbandCancelled");
    const team2 = await h.buildTeam("DisbandCancelledTeam", 4);
    await h.enterTeam(other, team2);
    await rawQuery("update competitions set state = 'CANCELLED_WITHOUT_CHAMPION' where competition_id = $1", [other.competitionId]);
    await one("disband_lifetime_team_atomically", { p_lifetime_team_id: team2.teamId, p_actor_gaming_member_id: team2.captain.gamingMemberId });
  });
});

// =============================================================================================================================================
describe("[3] a roster claim begins only when the person accepts it", () => {
  it("lets a leader propose members of the team only, validates the batch, and claims nobody by proposing", async () => {
    const competition = await h.setUpCompetition("Propose");
    const team = await h.buildTeam("Proposing", 6);
    const entry = await h.enterTeam(competition, team);
    const [outsider] = await h.newPeople(1, "NotOnTeam");
    const ids = team.everyone.map((p) => p.gamingMemberId);
    await refused("propose_lifetime_entry_roster_claims_atomically", proposeArgs(entry.entryId, team.members[0], ids.slice(0, 1)), "LIFETIME_NOT_A_LEADER");
    await refused("propose_lifetime_entry_roster_claims_atomically", proposeArgs(entry.entryId, team.captain, [outsider.gamingMemberId]), "LIFETIME_CLAIM_SUBJECT_NOT_MEMBER");
    for (const bad of [[], [ids[0], ids[0]], Array.from({ length: 33 }, () => ids[0]), [ids[0], null as unknown as string]]) {
      await refused("propose_lifetime_entry_roster_claims_atomically", proposeArgs(entry.entryId, team.captain, bad), "LIFETIME_CLAIM_BATCH_INVALID");
    }
    const proposed = await rpc("propose_lifetime_entry_roster_claims_atomically", proposeArgs(entry.entryId, team.subCaptain!, ids));
    expect(proposed).toHaveLength(6);
    expect(proposed.every((p) => p.status === "PROPOSED")).toBe(true);
    expect(await accepted(competition.competitionId)).toHaveLength(0);
    const [row] = await rawQuery("select * from competition_lifetime_roster_claims where competition_lifetime_roster_claim_id = $1", [proposed[0].competition_lifetime_roster_claim_id]);
    expect(row).toMatchObject({ competition_id: competition.competitionId, competition_team_id: entry.entryId, lifetime_team_id: team.teamId, status: "PROPOSED", accepted_at: null, released_at: null, departed_at: null });
    // The deadline is nearer than seven days, so a proposal lapses AT the deadline (and never later).
    expect(new Date(row.expires_at).getTime()).toBe((await deadlineOf(competition.competitionId)).getTime());
    await refused("propose_lifetime_entry_roster_claims_atomically", proposeArgs(entry.entryId, team.captain, [ids[0]]), "LIFETIME_CLAIM_ALREADY_OPEN");
  });

  it("lets only the person affirm their own inclusion, and only with the adult self-attestation: a leader, a stranger and an unregistered person cannot", async () => {
    const competition = await h.setUpCompetition("Affirm");
    const team = await h.buildTeam("Affirming", 6);
    const entry = await h.enterTeam(competition, team);
    const person = team.members[0];
    const stranger = team.members[1];
    const [claim] = await rpc("propose_lifetime_entry_roster_claims_atomically", proposeArgs(entry.entryId, team.captain, [person.gamingMemberId]));
    const claimId = claim.competition_lifetime_roster_claim_id;
    await refused("decide_lifetime_entry_roster_claim_atomically", decideArgs(claimId, team.captain, "ACCEPT"), "LIFETIME_CLAIM_WRONG_PARTY");
    await refused("decide_lifetime_entry_roster_claim_atomically", decideArgs(claimId, stranger, "ACCEPT"), "LIFETIME_CLAIM_WRONG_PARTY");
    await refused("decide_lifetime_entry_roster_claim_atomically", decideArgs(claimId, person, "ACCEPT"), "COMPETITION_REGISTRATION_REQUIRED");
    await rawQuery("insert into competition_registrations (competition_id, gaming_member_id, is_adult_self_attested) values ($1, $2, false)", [competition.competitionId, person.gamingMemberId]);
    // A registration made WITHOUT the adult tick is a different truth from no registration at all, and says so.
    await refused("decide_lifetime_entry_roster_claim_atomically", decideArgs(claimId, person, "ACCEPT"), "LIFETIME_ADULT_ATTESTATION_REQUIRED");
    await rawQuery("update competition_registrations set is_adult_self_attested = true where competition_id = $1 and gaming_member_id = $2", [competition.competitionId, person.gamingMemberId]);
    await refused("decide_lifetime_entry_roster_claim_atomically", decideArgs(claimId, person, "MAYBE"), "LIFETIME_DECISION_INVALID");
    await refused("decide_lifetime_entry_roster_claim_atomically", decideArgs("00000000-0000-4000-8000-000000000000", person, "ACCEPT"), "LIFETIME_CLAIM_NOT_FOUND");
    expect(await accepted(competition.competitionId)).toHaveLength(0);
    const done = await one("decide_lifetime_entry_roster_claim_atomically", decideArgs(claimId, person, "ACCEPT"));
    expect(done.status).toBe("ACCEPTED");
    expect(await claimOf(claimId)).toMatchObject({ status: "ACCEPTED", released_at: null });
    expect((await claimOf(claimId)).accepted_at).toBeInstanceOf(Date);
    await refused("decide_lifetime_entry_roster_claim_atomically", decideArgs(claimId, person, "ACCEPT"), "LIFETIME_CLAIM_NOT_OPEN");
  });

  it("never lets two captains decide who gets a person: both may propose, nothing is claimed, and the PERSON's acceptance claims them for exactly one team", async () => {
    const s = await sharedPersonScenario("Shared");
    const rows = await claimRows(s.competition.competitionId);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.status === "PROPOSED")).toBe(true);
    expect(await accepted(s.competition.competitionId)).toHaveLength(0);
    // The person chooses; the other team's proposal can then no longer be accepted.
    await one("decide_lifetime_entry_roster_claim_atomically", decideArgs(s.claimB, s.shared, "ACCEPT"));
    await refused("decide_lifetime_entry_roster_claim_atomically", decideArgs(s.claimA, s.shared, "ACCEPT"), "LIFETIME_PERSON_ALREADY_CLAIMED");
    expect(await accepted(s.competition.competitionId)).toEqual([{ gaming_member_id: s.shared.gamingMemberId, competition_team_id: s.entryB.entryId }]);
    expect((await claimOf(s.claimA)).status).toBe("PROPOSED");
    // The unique claim is held by the table itself, whatever writes: the other team's proposal is still PROPOSED, and accepting it by a direct write passes every rule of
    // the claims guard (a member of that team, a live entry, nobody else's leader) — so the unique INDEX, and nothing else, is what refuses it.
    const direct = await violation(
      "update competition_lifetime_roster_claims set status = 'ACCEPTED', accepted_at = now(), decided_at = now() where competition_lifetime_roster_claim_id = $1", [s.claimA]);
    expect(direct).toMatchObject({ code: "23505", constraint: "competition_lifetime_roster_claims_one_accepted_per_person" });
  });

  it("releases a claim by withdrawal, so the person can then accept the other team (withdrawal before the freeze frees the claim)", async () => {
    const s = await sharedPersonScenario("Withdrawal");
    await one("decide_lifetime_entry_roster_claim_atomically", decideArgs(s.claimA, s.shared, "ACCEPT"));
    await refused("decide_lifetime_entry_roster_claim_atomically", decideArgs(s.claimB, s.shared, "ACCEPT"), "LIFETIME_PERSON_ALREADY_CLAIMED");
    const released = await one("release_lifetime_entry_roster_claim_atomically", releaseArgs(s.claimA, s.shared));
    expect(released).toMatchObject({ status: "WITHDRAWN", release_reason: "PERSON_WITHDREW" });
    expect(await claimOf(s.claimA)).toMatchObject({ status: "WITHDRAWN", released_by_gaming_member_id: s.shared.gamingMemberId });
    expect((await claimOf(s.claimA)).released_at).toBeInstanceOf(Date);
    await one("decide_lifetime_entry_roster_claim_atomically", decideArgs(s.claimB, s.shared, "ACCEPT"));
    expect((await accepted(s.competition.competitionId))[0].competition_team_id).toBe(s.entryB.entryId);
  });

  it("releases a claim by rejection and lets the team propose the person again later (rejection followed by re-entry); a new claim is a new row", async () => {
    const s = await sharedPersonScenario("Rejection");
    const rejected = await one("decide_lifetime_entry_roster_claim_atomically", decideArgs(s.claimA, s.shared, "REJECT"));
    expect(rejected.status).toBe("REJECTED");
    expect(await claimOf(s.claimA)).toMatchObject({ status: "REJECTED", released_by_gaming_member_id: s.shared.gamingMemberId, release_reason: "PERSON_REJECTED" });
    await refused("decide_lifetime_entry_roster_claim_atomically", decideArgs(s.claimA, s.shared, "ACCEPT"), "LIFETIME_CLAIM_NOT_OPEN");
    const [again] = await rpc("propose_lifetime_entry_roster_claims_atomically", proposeArgs(s.entryA.entryId, s.captainA, [s.shared.gamingMemberId]));
    expect(again.competition_lifetime_roster_claim_id).not.toBe(s.claimA);
    await one("decide_lifetime_entry_roster_claim_atomically", decideArgs(again.competition_lifetime_roster_claim_id, s.shared, "ACCEPT"));
    expect((await claimRows(s.competition.competitionId)).map((r) => r.status).sort()).toEqual(["ACCEPTED", "PROPOSED", "REJECTED"]);
  });

  it("releases a claim by removal when a leader takes the person off the list, and a leader can also withdraw a proposal nobody has answered", async () => {
    const s = await sharedPersonScenario("Removal");
    await one("decide_lifetime_entry_roster_claim_atomically", decideArgs(s.claimA, s.shared, "ACCEPT"));
    await refused("release_lifetime_entry_roster_claim_atomically", releaseArgs(s.claimA, s.captainB), "LIFETIME_NOT_A_LEADER");
    const [stranger] = await h.newPeople(1, "Stranger");
    await refused("release_lifetime_entry_roster_claim_atomically", releaseArgs(s.claimA, stranger), "LIFETIME_NOT_A_LEADER");
    const removed = await one("release_lifetime_entry_roster_claim_atomically", releaseArgs(s.claimA, s.captainA));
    expect(removed).toMatchObject({ status: "REMOVED", release_reason: "LEADER_REMOVED" });
    const withdrawn = await one("release_lifetime_entry_roster_claim_atomically", releaseArgs(s.claimB, s.captainB));
    expect(withdrawn).toMatchObject({ status: "WITHDRAWN", release_reason: "LEADER_WITHDREW_PROPOSAL" });
    await refused("decide_lifetime_entry_roster_claim_atomically", decideArgs(s.claimB, s.shared, "ACCEPT"), "LIFETIME_CLAIM_NOT_OPEN");
    await refused("release_lifetime_entry_roster_claim_atomically", releaseArgs(s.claimB, s.captainB), "LIFETIME_CLAIM_NOT_OPEN");
    expect(await accepted(s.competition.competitionId)).toHaveLength(0);
  });

  it("releases a person's claims when they leave the lifetime team before the freeze, and frees them for another team", async () => {
    const s = await sharedPersonScenario("LeaveTeam");
    await one("decide_lifetime_entry_roster_claim_atomically", decideArgs(s.claimA, s.shared, "ACCEPT"));
    await one("end_lifetime_team_membership_atomically", { p_lifetime_team_id: s.teamA.teamId, p_actor_gaming_member_id: s.shared.gamingMemberId, p_subject_gaming_member_id: s.shared.gamingMemberId });
    expect(await claimOf(s.claimA)).toMatchObject({ status: "WITHDRAWN", release_reason: "LEFT_TEAM", departed_at: null });
    await one("decide_lifetime_entry_roster_claim_atomically", decideArgs(s.claimB, s.shared, "ACCEPT"));
    // A leader removing a member also releases that member's claims.
    await one("end_lifetime_team_membership_atomically", { p_lifetime_team_id: s.teamB.teamId, p_actor_gaming_member_id: s.captainB.gamingMemberId, p_subject_gaming_member_id: s.shared.gamingMemberId });
    expect(await claimOf(s.claimB)).toMatchObject({ status: "REMOVED", release_reason: "REMOVED_FROM_TEAM" });
    expect(await accepted(s.competition.competitionId)).toHaveLength(0);
  });

  it("lets a claim expire: it cannot be accepted afterwards, and a new proposal ends the stale one as EXPIRED", async () => {
    const s = await sharedPersonScenario("Expiry", { deadlineMs: Date.now() + 30 * DAY });
    // The deadline is far away, so a proposal lapses exactly seven days after it was made.
    const stamps = await claimOf(s.claimA);
    expect(new Date(stamps.expires_at).getTime() - new Date(stamps.proposed_at).getTime()).toBe(7 * DAY);
    const later = new Date(Date.now() + 8 * DAY).toISOString();
    const late = await h.atInstant(later, "select * from decide_lifetime_entry_roster_claim_atomically($1::uuid, $2::uuid, 'ACCEPT')", [s.claimA, s.shared.gamingMemberId]);
    expect(late).toMatchObject({ ok: false, refusal: "LIFETIME_CLAIM_EXPIRED" });
    const rows = await withClock(later, async (db) => {
      await db.query("select * from propose_lifetime_entry_roster_claims_atomically($1::uuid, $2::uuid, $3::uuid[])", [s.entryA.entryId, s.captainA.gamingMemberId, [s.shared.gamingMemberId]]);
      return (await db.query("select status, release_reason from competition_lifetime_roster_claims where competition_team_id = $1 order by seq", [s.entryA.entryId])).rows;
    });
    expect(rows).toEqual([{ status: "EXPIRED", release_reason: "EXPIRED" }, { status: "PROPOSED", release_reason: null }]);
    expect((await claimOf(s.claimA)).status).toBe("PROPOSED");
  });

  it("holds, in the claims table itself, that only an active member of the team can be accepted: a direct acceptance for someone who left is refused by that very rule", async () => {
    const competition = await h.setUpCompetition("ClaimGuard");
    const team = await h.buildTeam("ClaimGuardTeam", 4);
    const entry = await h.enterTeam(competition, team);
    const person = team.members[0];
    const [proposal] = await rpc("propose_lifetime_entry_roster_claims_atomically", proposeArgs(entry.entryId, team.captain, [person.gamingMemberId]));
    const outcome = await h.rawTransaction(async (db) => {
      // The person's membership is ended BY A DIRECT WRITE (the operation would have released the claim), leaving the proposal open for a non-member.
      await db.query("update lifetime_team_memberships set status = 'ENDED', ended_at = now(), end_reason = 'LEFT' where lifetime_team_id = $1 and gaming_member_id = $2 and status = 'ACTIVE'", [team.teamId, person.gamingMemberId]);
      try {
        await db.query("update competition_lifetime_roster_claims set status = 'ACCEPTED', accepted_at = now(), decided_at = now() where competition_lifetime_roster_claim_id = $1", [proposal.competition_lifetime_roster_claim_id]);
        return null;
      } catch (err) {
        const e = err as { code?: string; message?: string };
        return { code: e.code, message: e.message ?? "" };
      }
    });
    expect(outcome?.code).toBe("P0001");
    expect(outcome?.message).toMatch(/^LIFETIME_CLAIM_SUBJECT_NOT_MEMBER:/);
  });

  it("freezes a roster at exactly the plan's minimum and at exactly its maximum, and refuses one below the minimum", async () => {
    const atMinimum = await twoRosteredEntries("FreezeMin", 5); // the default plan is 5 to 8
    await h.passDeadline(atMinimum.competition.competitionId);
    expect(await one("freeze_lifetime_competition_entries_atomically", freezeArgs(atMinimum.competition))).toMatchObject({ entry_count: 2, claim_count: 10 });
    const atMaximum = await twoRosteredEntries("FreezeMax", 8);
    await h.passDeadline(atMaximum.competition.competitionId);
    expect(await one("freeze_lifetime_competition_entries_atomically", freezeArgs(atMaximum.competition))).toMatchObject({ entry_count: 2, claim_count: 16 });
    const below = await twoRosteredEntries("FreezeBelow", 5);
    await one("release_lifetime_entry_roster_claim_atomically", releaseArgs(Object.values(below.claimsA)[0], below.teamA.captain));
    await h.passDeadline(below.competition.competitionId);
    await refused("freeze_lifetime_competition_entries_atomically", freezeArgs(below.competition), "LIFETIME_FREEZE_ROSTER_BELOW_MINIMUM");
  }, 90_000);

  it("refuses a freeze whose roster is ABOVE the plan's maximum (the plan was lowered after the people were accepted) or whose plan is not usable, and records nothing", async () => {
    const soon = () => new Date(Date.now() + 3600_000).toISOString();
    const above = await twoRosteredEntries("FreezeAbove", 6); // the default plan is 5 to 8: rosters of 6 are accepted
    await h.supersedePlan(above.competition.competitionId, soon(), { minimum: 5, maximum: 5 });
    await h.passDeadline(above.competition.competitionId);
    await refused("freeze_lifetime_competition_entries_atomically", freezeArgs(above.competition), "LIFETIME_FREEZE_ROSTER_ABOVE_MAXIMUM");
    const unusable = await twoRosteredEntries("FreezeUnusable", 5);
    await h.supersedePlan(unusable.competition.competitionId, soon(), { minimum: 1, maximum: 2 });
    await h.passDeadline(unusable.competition.competitionId);
    await refused("freeze_lifetime_competition_entries_atomically", freezeArgs(unusable.competition), "LIFETIME_FREEZE_PLAN_INVALID");
    for (const c of [above.competition, unusable.competition]) {
      expect((await h.rawQuery("select count(*)::int n from competition_lifetime_freezes where competition_id = $1", [c.competitionId]))[0].n, "a refused freeze records nothing").toBe(0);
    }
  }, 90_000);

  it("limits an entry to the plan's roster maximum", async () => {
    const competition = await h.setUpCompetition("Full", { minimum: 5, maximum: 5 });
    const team = await h.buildTeam("FullTeam", 6);
    const entry = await h.enterTeam(competition, team);
    const claims = await h.rosterUp(entry.entryId, team.captain, competition, team.everyone.slice(0, 5));
    expect(Object.keys(claims)).toHaveLength(5);
    const [extra] = await rpc("propose_lifetime_entry_roster_claims_atomically", proposeArgs(entry.entryId, team.captain, [team.everyone[5].gamingMemberId]));
    await h.register(competition, team.everyone[5]);
    await refused("decide_lifetime_entry_roster_claim_atomically", decideArgs(extra.competition_lifetime_roster_claim_id, team.everyone[5], "ACCEPT"), "LIFETIME_ROSTER_FULL");
  });

  it("stops proposals and acceptances at the registration deadline, but lets a person still reject or withdraw before the freeze", async () => {
    const s = await sharedPersonScenario("Deadline");
    await one("decide_lifetime_entry_roster_claim_atomically", decideArgs(s.claimA, s.shared, "ACCEPT"));
    await h.passDeadline(s.competition.competitionId);
    await refused("propose_lifetime_entry_roster_claims_atomically", proposeArgs(s.entryB.entryId, s.captainB, [s.fillerB.gamingMemberId]), "TEAM_REGISTRATION_NOT_OPEN");
    await refused("decide_lifetime_entry_roster_claim_atomically", decideArgs(s.claimB, s.shared, "ACCEPT"), "TEAM_REGISTRATION_NOT_OPEN");
    const reject = await one("decide_lifetime_entry_roster_claim_atomically", decideArgs(s.claimB, s.shared, "REJECT"));
    expect(reject.status).toBe("REJECTED");
    const withdrawn = await one("release_lifetime_entry_roster_claim_atomically", releaseArgs(s.claimA, s.shared));
    expect(withdrawn.status).toBe("WITHDRAWN");
  });
});

// =============================================================================================================================================
describe("[4] the freeze fixes the entries; accepted claims stay as evidence", () => {
  it("freezes after the deadline with counts that match the rows; the competition state and every V1 table are untouched; a retry returns the same freeze", async () => {
    const f = await twoRosteredEntries("Freeze");
    const deadline = await h.passDeadline(f.competition.competitionId);
    const stateBefore = (await rawQuery("select state from competitions where competition_id = $1", [f.competition.competitionId]))[0].state;
    const frozen = await one("freeze_lifetime_competition_entries_atomically", freezeArgs(f.competition));
    expect(frozen).toMatchObject({ entry_count: 2, claim_count: 12, already_frozen: false });
    const [row] = await rawQuery("select * from competition_lifetime_freezes where competition_id = $1", [f.competition.competitionId]);
    expect(row).toMatchObject({ entry_count: 2, claim_count: 12, roster_minimum: 5, roster_maximum: 8, frozen_by_gaming_member_id: f.competition.organizer.gamingMemberId });
    expect(new Date(row.registration_deadline_utc).toISOString()).toBe(deadline);
    expect(row.frozen_at.getTime()).toBeGreaterThanOrEqual(new Date(deadline).getTime());
    expect((await rawQuery("select state from competitions where competition_id = $1", [f.competition.competitionId]))[0].state).toBe(stateBefore);
    for (const table of ["competition_registration_freezes", "competition_draws", "competition_fixtures", "competition_team_memberships"]) {
      expect((await rawQuery(`select count(*)::int n from ${table} where competition_id = $1`, [f.competition.competitionId]))[0].n, table).toBe(0);
    }
    const retry = await one("freeze_lifetime_competition_entries_atomically", freezeArgs(f.competition));
    expect(retry.already_frozen).toBe(true);
    expect(new Date(retry.frozen_at).getTime()).toBe(new Date(frozen.frozen_at).getTime());
    expect(await violation("update competition_lifetime_freezes set claim_count = 0 where competition_id = $1", [f.competition.competitionId])).not.toBeNull();
    expect(await violation("delete from competition_lifetime_freezes where competition_id = $1", [f.competition.competitionId])).not.toBeNull();
  });

  it("is the organizer's alone, and refused before the deadline, with fewer than two entries, with a roster below the minimum, for a cancelled competition and a revoked host", async () => {
    const f = await twoRosteredEntries("FreezeRefuse");
    const [stranger] = await h.newPeople(1, "Stranger");
    await refused("freeze_lifetime_competition_entries_atomically", freezeArgs(f.competition, stranger), "COMPETITION_ACCESS_DENIED");
    await refused("freeze_lifetime_competition_entries_atomically", freezeArgs(f.competition, null), "COMPETITION_ACCESS_DENIED");
    await refused("freeze_lifetime_competition_entries_atomically", freezeArgs(f.competition), "LIFETIME_FREEZE_DEADLINE_NOT_REACHED");
    await h.passDeadline(f.competition.competitionId);
    // Below the minimum: an entry with only three accepted players.
    await one("release_lifetime_entry_roster_claim_atomically", releaseArgs(Object.values(f.claimsA)[0], f.teamA.captain));
    await one("release_lifetime_entry_roster_claim_atomically", releaseArgs(Object.values(f.claimsA)[1], f.teamA.captain));
    await one("release_lifetime_entry_roster_claim_atomically", releaseArgs(Object.values(f.claimsA)[2], f.teamA.captain));
    const below = await refused("freeze_lifetime_competition_entries_atomically", freezeArgs(f.competition), "LIFETIME_FREEZE_ROSTER_BELOW_MINIMUM");
    expect(below.message).toMatch(/3/);
    expect(below.message).toMatch(/5/);
    // Fewer than two live entries.
    await one("withdraw_lifetime_competition_entry_atomically", { p_competition_team_id: f.entryA.entryId, p_actor_gaming_member_id: f.teamA.captain.gamingMemberId });
    await refused("freeze_lifetime_competition_entries_atomically", freezeArgs(f.competition), "LIFETIME_FREEZE_NOT_ENOUGH_ENTRIES");
    expect(await rawQuery("select 1 from competition_lifetime_freezes where competition_id = $1", [f.competition.competitionId])).toHaveLength(0);
    // Not the lifetime flow / cancelled.
    const legacy = await h.setUpCompetition("FreezeLegacy", { lifetimeFlow: false });
    await h.passDeadline(legacy.competitionId);
    await refused("freeze_lifetime_competition_entries_atomically", freezeArgs(legacy), "LIFETIME_FLOW_NOT_ENABLED");
    const cancelled = await twoRosteredEntries("FreezeCancelled");
    await h.passDeadline(cancelled.competition.competitionId);
    await rawQuery("update competitions set state = 'CANCELLED_WITHOUT_CHAMPION' where competition_id = $1", [cancelled.competition.competitionId]);
    await refused("freeze_lifetime_competition_entries_atomically", freezeArgs(cancelled.competition), "COMPETITION_CANCELLED");
    const revoked = await twoRosteredEntries("FreezeRevoked");
    await h.passDeadline(revoked.competition.competitionId);
    const message = await h.rawTransaction(async (db) => {
      await db.query("set local session_replication_role = replica");
      await db.query(
        `insert into competition_host_capabilities (host_application_id, gaming_member_id, state, competition_id, granted_by_gaming_member_id, consumed_at, revoked_at, revoked_by_gaming_member_id, revoke_reason)
         values (gen_random_uuid(), $2, 'REVOKED', $1, $2, now(), now(), $2, 'contract-test fixture')`, [revoked.competition.competitionId, revoked.competition.organizer.gamingMemberId]);
      await db.query("set local session_replication_role = origin");
      try {
        await db.query("select * from freeze_lifetime_competition_entries_atomically($1::uuid, $2::uuid)", [revoked.competition.competitionId, revoked.competition.organizer.gamingMemberId]);
        return null;
      } catch (err) {
        return (err as { message: string }).message;
      }
    });
    expect(message).toMatch(/^HOST_ACCESS_REVOKED:/);
  });

  it("refuses every change to the entries once frozen, keeps every accepted claim exactly as it was, and refuses direct writes too", async () => {
    const f = await twoRosteredEntries("Frozen");
    const [extraPerson] = await h.newPeople(1, "Late");
    await h.passDeadline(f.competition.competitionId);
    await one("freeze_lifetime_competition_entries_atomically", freezeArgs(f.competition));
    const before = await claimRows(f.competition.competitionId);
    const claimId = Object.values(f.claimsA)[0];
    const person = f.teamA.everyone[0];
    await refused("release_lifetime_entry_roster_claim_atomically", releaseArgs(claimId, person), "LIFETIME_ENTRIES_FROZEN");
    await refused("release_lifetime_entry_roster_claim_atomically", releaseArgs(claimId, f.teamA.captain), "LIFETIME_ENTRIES_FROZEN");
    await refused("withdraw_lifetime_competition_entry_atomically", { p_competition_team_id: f.entryA.entryId, p_actor_gaming_member_id: f.teamA.captain.gamingMemberId }, "LIFETIME_ENTRIES_FROZEN");
    await refused("propose_lifetime_entry_roster_claims_atomically", proposeArgs(f.entryA.entryId, f.teamA.captain, [extraPerson.gamingMemberId]), "LIFETIME_ENTRIES_FROZEN");
    await refused("enter_lifetime_team_into_competition_atomically", { p_competition_id: f.competition.competitionId, p_lifetime_team_id: f.teamA.teamId, p_actor_gaming_member_id: f.teamA.captain.gamingMemberId }, "LIFETIME_ENTRIES_FROZEN");
    expect(await claimRows(f.competition.competitionId)).toEqual(before);
    for (const [sql, params] of [
      ["update competition_lifetime_roster_claims set status = 'WITHDRAWN', released_at = now(), release_reason = 'PERSON_WITHDREW', released_by_gaming_member_id = gaming_member_id where competition_lifetime_roster_claim_id = $1", [claimId]],
      ["update competition_lifetime_roster_claims set gaming_member_id = $2 where competition_lifetime_roster_claim_id = $1", [claimId, extraPerson.gamingMemberId]],
      ["update competition_lifetime_roster_claims set accepted_at = accepted_at - interval '1 day' where competition_lifetime_roster_claim_id = $1", [claimId]],
      ["delete from competition_lifetime_roster_claims where competition_lifetime_roster_claim_id = $1", [claimId]],
      ["truncate competition_lifetime_roster_claims", []],
    ] as Array<[string, unknown[]]>) expect(await violation(sql, params), sql).not.toBeNull();
    const insert = await violation(
      "insert into competition_lifetime_roster_claims (competition_id, competition_team_id, lifetime_team_id, gaming_member_id, status, proposed_by_gaming_member_id, proposed_at, expires_at) values ($1, $2, $3, $4, 'PROPOSED', $5, now(), now() + interval '1 day')",
      [f.competition.competitionId, f.entryA.entryId, f.teamA.teamId, extraPerson.gamingMemberId, f.teamA.captain.gamingMemberId]);
    expect(insert).not.toBeNull();
  });

  it("dates a later departure instead of erasing the participation, and keeps the person claimed for that competition", async () => {
    const f = await twoRosteredEntries("Departure");
    await h.passDeadline(f.competition.competitionId);
    await one("freeze_lifetime_competition_entries_atomically", freezeArgs(f.competition));
    const leaver = f.teamA.members[0];
    const removed = f.teamA.members[1];
    const leaverClaim = f.claimsA[leaver.gamingMemberId];
    const before = await claimOf(leaverClaim);
    await one("end_lifetime_team_membership_atomically", { p_lifetime_team_id: f.teamA.teamId, p_actor_gaming_member_id: leaver.gamingMemberId, p_subject_gaming_member_id: leaver.gamingMemberId });
    const after = await claimOf(leaverClaim);
    expect(after).toMatchObject({ status: "ACCEPTED", release_reason: null, released_at: null, departure_reason: "LEFT_TEAM" });
    expect(after.departed_at).toBeInstanceOf(Date);
    expect(after.accepted_at).toEqual(before.accepted_at);
    expect(after.departed_at.getTime()).toBeGreaterThanOrEqual(before.accepted_at.getTime());
    await one("end_lifetime_team_membership_atomically", { p_lifetime_team_id: f.teamA.teamId, p_actor_gaming_member_id: f.teamA.captain.gamingMemberId, p_subject_gaming_member_id: removed.gamingMemberId });
    expect(await claimOf(f.claimsA[removed.gamingMemberId])).toMatchObject({ status: "ACCEPTED", departure_reason: "REMOVED_FROM_TEAM" });
    expect(await accepted(f.competition.competitionId)).toHaveLength(12);
    // The departed person is still the competition's claim. After the freeze the claims guard refuses ANY new claim (the freeze comes first)...
    const second = await violation(
      "insert into competition_lifetime_roster_claims (competition_id, competition_team_id, lifetime_team_id, gaming_member_id, status, proposed_by_gaming_member_id, proposed_at, expires_at, accepted_at, decided_at) values ($1, $2, $3, $4, 'ACCEPTED', $5, now(), now() + interval '1 day', now(), now())",
      [f.competition.competitionId, f.entryB.entryId, f.teamB.teamId, leaver.gamingMemberId, f.teamB.captain.gamingMemberId]);
    expect(second?.message).toMatch(/^LIFETIME_ENTRIES_FROZEN:/);
    // ...and, with that guard taken away (in a transaction that is rolled back), the unique index alone still refuses a second accepted claim for a person who has DEPARTED.
    const indexAlone = await h.rawTransaction(async (db) => {
      await db.query("alter table competition_lifetime_roster_claims disable trigger competition_lifetime_roster_claims_guard");
      try {
        await db.query(
          "insert into competition_lifetime_roster_claims (competition_id, competition_team_id, lifetime_team_id, gaming_member_id, status, proposed_by_gaming_member_id, proposed_at, expires_at, accepted_at, decided_at) values ($1, $2, $3, $4, 'ACCEPTED', $5, now(), now() + interval '1 day', now(), now())",
          [f.competition.competitionId, f.entryB.entryId, f.teamB.teamId, leaver.gamingMemberId, f.teamB.captain.gamingMemberId]);
        return null;
      } catch (err) {
        const e = err as { code?: string; constraint?: string };
        return { code: e.code, constraint: e.constraint };
      }
    });
    expect(indexAlone).toEqual({ code: "23505", constraint: "competition_lifetime_roster_claims_one_accepted_per_person" });
    // The entry's snapshots are untouched by the departure (and by the captain leaving afterwards).
    await one("end_lifetime_team_membership_atomically", { p_lifetime_team_id: f.teamA.teamId, p_actor_gaming_member_id: f.teamA.captain.gamingMemberId, p_subject_gaming_member_id: f.teamA.captain.gamingMemberId });
    const entry = await entryRow(f.entryA.entryId);
    expect(entry).toMatchObject({ captain_gaming_member_id: f.teamA.captain.gamingMemberId, name: f.teamA.name });
    expect(await claimOf(f.claimsA[f.teamA.captain.gamingMemberId])).toMatchObject({ status: "ACCEPTED", departure_reason: "LEFT_TEAM" });
  });
});
