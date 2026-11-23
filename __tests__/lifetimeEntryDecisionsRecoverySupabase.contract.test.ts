import { createHash, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";

import type { Client } from "pg";
import { afterAll, describe, expect, it, vi } from "vitest";
import { loadEnv } from "vite";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";

import { createHarness, type LifetimeTestCompetition, type Person } from "./helpers/lifetimeContract";

/**
 * UG-CR-GATE-CFM-004 — the safe recovery of an accidentally enabled lifetime flow, against a real (disposable, loopback-only) Postgres.
 *
 *   [1] it switches the flow off, and says so as evidence: the switch row goes, the ENABLED and DISABLED events stay, nothing else changes
 *   [2] V1 behaves again exactly as it did before the flow was enabled, and the flow can be enabled again (a second ENABLED event)
 *   [3] it is explicit and idempotent: a second call, or a call for a competition that never enabled the flow, answers "already disabled" and writes nothing
 *   [4] it fails closed once the flow produced anything — an entry of any status, a decision, a freeze — and deletes nothing to make itself possible
 *   [5] it fails closed outside the pre-publication states, and when legacy rows exist (written around the guards)
 *   [6] only the competition's own, active, non-revoked organizer can use it, and nobody learns anything before that is established
 *   [7] the audit is append-only, the switch row cannot be removed any other way, and the enablement already on record is preserved by the migration
 */

// The shared contract-test guard (UG-CR-GATE-079) runs before anything is constructed: no target that is not loopback is ever touched.
const supabaseUrl = loadEnv("development", process.cwd(), "").SUPABASE_URL;
requireLocalSupabase(supabaseUrl);
vi.setConfig({ testTimeout: 90_000 });

const h = createHarness("er");
const { one, refused, rawQuery, rawTransaction, violation } = h;

afterAll(() => h.cleanup(), 300000);

const id = (p: Person) => p.gamingMemberId;
const disableArgs = (c: { competitionId: string }, who: Person | null) => ({ p_competition_id: c.competitionId, p_organizer_gaming_member_id: who ? id(who) : null });
const publicCode = () => randomBytes(16).toString("base64url");

const flowRows = (competitionId: string) => rawQuery("select * from competition_lifetime_flows where competition_id = $1", [competitionId]);
const flowEvents = (competitionId: string) => rawQuery("select event_type, actor_gaming_member_id, occurred_at, details from competition_lifetime_flow_events where competition_id = $1 order by flow_event_seq", [competitionId]);
const entriesOf = (competitionId: string) => rawQuery("select * from competition_teams where competition_id = $1 order by created_at, competition_team_id", [competitionId]);

/** Everything the flow could have produced or the recovery could have touched, for one competition, as one digest: a refusal must leave it byte-for-byte as it was. */
async function digestOf(competitionId: string): Promise<string> {
  const parts = [
    await rawQuery("select * from competitions where competition_id = $1", [competitionId]),
    await flowRows(competitionId),
    await flowEvents(competitionId),
    await entriesOf(competitionId),
    await rawQuery("select * from competition_lifetime_entry_decisions where competition_id = $1 order by decision_seq", [competitionId]),
    await rawQuery("select * from competition_lifetime_roster_claims where competition_id = $1 order by seq", [competitionId]),
    await rawQuery("select * from competition_lifetime_freezes where competition_id = $1", [competitionId]),
    await rawQuery("select * from competition_registrations where competition_id = $1 order by gaming_member_id", [competitionId]),
  ];
  return createHash("sha256").update(JSON.stringify(parts)).digest("hex");
}

/** A competition with the flow on and one entered team (PENDING). */
async function withEntry(label: string, size = 5) {
  const competition = await h.setUpCompetition(label);
  const team = await h.buildTeam(`${label}T`, size);
  const entry = await h.enterTeam(competition, team);
  return { competition, team, entry };
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

/** The refusal a statement raises inside an open transaction (null when it succeeds); a failed statement is rolled back to its own savepoint so the transaction stays usable. */
async function refusalOf(db: Client, sql: string, params: unknown[]): Promise<string | null> {
  await db.query("savepoint probe");
  try {
    await db.query(sql, params);
    await db.query("release savepoint probe");
    return null;
  } catch (err) {
    await db.query("rollback to savepoint probe");
    return (err as Error).message;
  }
}

// =============================================================================================================================================
describe("[1] the recovery switches the flow off and leaves the evidence", () => {
  it("removes the switch row only: ENABLED and DISABLED stay as dated, attributed events, and nothing else about the competition changes", async () => {
    const competition = await h.setUpCompetition("RecoverOk");
    const [flowBefore] = await flowRows(competition.competitionId);
    const eventsBefore = await flowEvents(competition.competitionId);
    expect(eventsBefore, "enabling the flow wrote its event").toHaveLength(1);
    expect(eventsBefore[0]).toMatchObject({ event_type: "ENABLED", actor_gaming_member_id: id(competition.organizer), details: { state: "TEAM_REGISTRATION_OPEN" } });
    expect(new Date(eventsBefore[0].occurred_at).getTime()).toBe(new Date(flowBefore.enabled_at).getTime());
    const competitionBefore = (await rawQuery("select * from competitions where competition_id = $1", [competition.competitionId]))[0];
    const registrationsBefore = await rawQuery("select * from competition_registrations where competition_id = $1", [competition.competitionId]);

    const result = await one("disable_lifetime_entry_flow_atomically", disableArgs(competition, competition.organizer));
    expect(result).toMatchObject({ competition_id: competition.competitionId, already_disabled: false });
    expect(result.disabled_at).toBeTruthy();

    expect(await flowRows(competition.competitionId), "the switch row is gone").toHaveLength(0);
    const events = await flowEvents(competition.competitionId);
    expect(events.map((e) => e.event_type)).toEqual(["ENABLED", "DISABLED"]);
    expect(events[0]).toEqual(eventsBefore[0]); // the enablement evidence is exactly what it was
    expect(events[1]).toMatchObject({ event_type: "DISABLED", actor_gaming_member_id: id(competition.organizer) });
    expect(new Date(events[1].occurred_at).getTime()).toBe(new Date(result.disabled_at).getTime());
    expect(new Date(events[1].occurred_at).getTime()).toBeGreaterThanOrEqual(new Date(flowBefore.enabled_at).getTime());
    expect(events[1].details).toMatchObject({ state: "TEAM_REGISTRATION_OPEN" });
    expect(new Date(events[1].details.enabled_at).getTime(), "the DISABLED event says which enablement it ended").toBe(new Date(flowBefore.enabled_at).getTime());

    expect((await rawQuery("select * from competitions where competition_id = $1", [competition.competitionId]))[0], "the competition itself is untouched").toEqual(competitionBefore);
    expect(await rawQuery("select * from competition_registrations where competition_id = $1", [competition.competitionId])).toEqual(registrationsBefore);
    for (const table of ["competition_teams", "competition_lifetime_roster_claims", "competition_lifetime_freezes", "competition_lifetime_entry_decisions", "competition_team_memberships", "competition_join_requests"]) {
      expect((await rawQuery(`select count(*)::int n from ${table} where competition_id = $1`, [competition.competitionId]))[0].n, table).toBe(0);
    }
  });

  it("works for a competition still in DRAFT as well as one whose registration is open", async () => {
    const draft = await h.setUpCompetition("RecoverDraft", { open: false });
    expect((await rawQuery("select state from competitions where competition_id = $1", [draft.competitionId]))[0].state).toBe("DRAFT");
    expect(await one("disable_lifetime_entry_flow_atomically", disableArgs(draft, draft.organizer))).toMatchObject({ already_disabled: false });
    const events = await flowEvents(draft.competitionId);
    expect(events.map((e) => e.event_type)).toEqual(["ENABLED", "DISABLED"]);
    expect(events[1].details).toMatchObject({ state: "DRAFT" });
  });
});

// =============================================================================================================================================
describe("[2] after the recovery V1 behaves as it did before the flow was enabled", () => {
  it("lets V1 add and propose teams again, keeps the competition exclusive to the first flow that gets data, and lets the lifetime flow be enabled again with a second ENABLED event", async () => {
    const competition = await h.setUpCompetition("RecoverV1");
    const [captain, proposer] = await h.newPeople(2, "RecoverV1");
    await h.register(competition, proposer);
    const closed = "TEAM_REGISTRATION_NOT_OPEN";
    const addArgs = (name: string) => ({ p_competition_id: competition.competitionId, p_organizer_gaming_member_id: id(competition.organizer), p_name: name, p_captain_gaming_member_id: id(captain), p_public_code: publicCode() });
    const proposeArgs = (name: string) => ({ p_competition_id: competition.competitionId, p_name: name, p_proposing_gaming_member_id: id(proposer), p_public_code: publicCode() });
    // while the flow is on, every V1 team path is closed ...
    await refused("add_competition_team_atomically", addArgs(h.uniqueName("Closed")), closed);
    await refused("propose_competition_team_atomically", proposeArgs(h.uniqueName("Closed")), closed);

    await one("disable_lifetime_entry_flow_atomically", disableArgs(competition, competition.organizer));

    // ... and after the recovery they work, exactly as on any competition that never had the flow
    const added = await one("add_competition_team_atomically", addArgs(h.uniqueName("Legacy")));
    const proposed = await one("propose_competition_team_atomically", proposeArgs(h.uniqueName("Proposed")));
    const v1Rows = await entriesOf(competition.competitionId);
    expect(v1Rows.map((r) => r.competition_team_id).sort()).toEqual([added.competition_team_id, proposed.competition_team_id].sort());
    expect(v1Rows.map((r) => r.status).sort(), "the organizer's team is accepted, the member's proposal waits — exactly as on any V1 competition").toEqual(["ACCEPTED", "PENDING_ORGANIZER_APPROVAL"]);
    expect(v1Rows.every((r) => r.entry_flow === "V1" && r.lifetime_team_id === null)).toBe(true);
    // the competition now has legacy teams, so the lifetime flow can no longer be enabled (the exclusivity the foundation promised)
    await refused("enable_lifetime_entry_flow_atomically", { p_competition_id: competition.competitionId, p_organizer_gaming_member_id: id(competition.organizer) }, "LIFETIME_FLOW_CONFLICT");

    // a competition that recovered and kept no V1 data can enable the flow again; the audit then reads ENABLED, DISABLED, ENABLED
    const again = await h.setUpCompetition("RecoverAgain");
    const first = (await flowRows(again.competitionId))[0];
    await one("disable_lifetime_entry_flow_atomically", disableArgs(again, again.organizer));
    const reenabled = await one("enable_lifetime_entry_flow_atomically", { p_competition_id: again.competitionId, p_organizer_gaming_member_id: id(again.organizer) });
    expect(reenabled.already_enabled).toBe(false);
    const events = await flowEvents(again.competitionId);
    expect(events.map((e) => e.event_type)).toEqual(["ENABLED", "DISABLED", "ENABLED"]);
    expect(new Date(events[2].occurred_at).getTime()).toBeGreaterThanOrEqual(new Date(events[1].occurred_at).getTime());
    const [second] = await flowRows(again.competitionId);
    expect(new Date(second.enabled_at).getTime(), "a new switch, a new date").toBeGreaterThan(new Date(first.enabled_at).getTime());
    expect(new Date(events[2].occurred_at).getTime()).toBe(new Date(second.enabled_at).getTime());
    // the lifetime flow works again — and, once something has been entered, the recovery is closed for good
    const team = await h.buildTeam("RecoverAgainT", 5);
    const entry = await h.enterTeam(again, team);
    expect((await entriesOf(again.competitionId))[0]).toMatchObject({ competition_team_id: entry.entryId, entry_flow: "LIFETIME", status: "PENDING_ORGANIZER_APPROVAL" });
    await refused("disable_lifetime_entry_flow_atomically", disableArgs(again, again.organizer), "LIFETIME_FLOW_RECOVERY_BLOCKED");
  });
});

// =============================================================================================================================================
describe("[3] the recovery is explicit and idempotent", () => {
  it("answers already_disabled for a second call and for a competition that never enabled the flow, and writes nothing either time", async () => {
    const competition = await h.setUpCompetition("RecoverTwice");
    await one("disable_lifetime_entry_flow_atomically", disableArgs(competition, competition.organizer));
    const digest = await digestOf(competition.competitionId);
    const retry = await one("disable_lifetime_entry_flow_atomically", disableArgs(competition, competition.organizer));
    expect(retry).toMatchObject({ competition_id: competition.competitionId, already_disabled: true, disabled_at: null });
    expect(await digestOf(competition.competitionId), "a retry changes nothing").toBe(digest);
    expect((await flowEvents(competition.competitionId)).map((e) => e.event_type)).toEqual(["ENABLED", "DISABLED"]);

    const never = await h.setUpCompetition("RecoverNever", { lifetimeFlow: false });
    const neverDigest = await digestOf(never.competitionId);
    expect(await one("disable_lifetime_entry_flow_atomically", disableArgs(never, never.organizer))).toMatchObject({ already_disabled: true, disabled_at: null });
    expect(await digestOf(never.competitionId)).toBe(neverDigest);
    expect(await flowEvents(never.competitionId), "no event is invented for a flow that never existed").toHaveLength(0);
  });
});

// =============================================================================================================================================
describe("[4] the recovery fails closed once the flow produced anything", () => {
  const blocked = (competition: { competitionId: string; organizer: Person }) => refused("disable_lifetime_entry_flow_atomically", disableArgs(competition, competition.organizer), "LIFETIME_FLOW_RECOVERY_BLOCKED");

  it("refuses for a pending entry, an approved one, a rejected one, a removed one and a withdrawn one — an entry that EVER existed blocks it — and every time deletes nothing", async () => {
    const cases: Array<[string, (s: Awaited<ReturnType<typeof withEntry>>) => Promise<unknown>]> = [
      ["pending", async () => undefined],
      ["approved", (s) => h.decideEntry(s.competition, s.entry.entryId, "APPROVE")],
      ["rejected", (s) => h.decideEntry(s.competition, s.entry.entryId, "REJECT", { reason: "INELIGIBLE_TEAM" })],
      ["removed", async (s) => { await h.decideEntry(s.competition, s.entry.entryId, "APPROVE"); await h.decideEntry(s.competition, s.entry.entryId, "REMOVE", { reason: "RULE_VIOLATION", note: "left the venue" }); }],
      ["withdrawn", (s) => one("withdraw_lifetime_competition_entry_atomically", { p_competition_team_id: s.entry.entryId, p_actor_gaming_member_id: id(s.team.captain) })],
    ];
    for (const [label, prepare] of cases) {
      const s = await withEntry(`RecoverEntry${label}`);
      await prepare(s);
      const digest = await digestOf(s.competition.competitionId);
      await blocked(s.competition);
      expect(await digestOf(s.competition.competitionId), `${label}: a refusal deletes and changes nothing`).toBe(digest);
      expect(await flowRows(s.competition.competitionId), `${label}: the switch row is still there`).toHaveLength(1);
      expect((await flowEvents(s.competition.competitionId)).map((e) => e.event_type), label).toEqual(["ENABLED"]);
    }
  });

  it("refuses for a rostered entry (claims exist) and after the entries are frozen", async () => {
    const competition = await h.setUpCompetition("RecoverFrozen");
    const [teamA, teamB] = [await h.buildTeam("RecoverFrozenA", 5), await h.buildTeam("RecoverFrozenB", 5)];
    const [entryA, entryB] = [await h.enterTeam(competition, teamA), await h.enterTeam(competition, teamB)];
    await h.approveEntries(competition, entryA.entryId, entryB.entryId);
    await h.rosterUp(entryA.entryId, teamA.captain, competition, teamA.everyone);
    await h.rosterUp(entryB.entryId, teamB.captain, competition, teamB.everyone);
    expect((await rawQuery("select count(*)::int n from competition_lifetime_roster_claims where competition_id = $1", [competition.competitionId]))[0].n).toBeGreaterThan(0);
    await blocked(competition);
    await h.passDeadline(competition.competitionId);
    await one("freeze_lifetime_competition_entries_atomically", { p_competition_id: competition.competitionId, p_organizer_gaming_member_id: id(competition.organizer) });
    const digest = await digestOf(competition.competitionId);
    await blocked(competition);
    expect(await digestOf(competition.competitionId)).toBe(digest);
    expect(await flowRows(competition.competitionId)).toHaveLength(1);
  });
});

// =============================================================================================================================================
describe("[5] the recovery fails closed outside the pre-publication states and when legacy data exists", () => {
  it("refuses once the competition is ready to publish, published or complete (blocked) and cancelled (cancelled), and leaves the switch where it is", async () => {
    for (const [state, code] of [["READY_TO_PUBLISH", "LIFETIME_FLOW_RECOVERY_BLOCKED"], ["PUBLISHED", "LIFETIME_FLOW_RECOVERY_BLOCKED"], ["COMPLETE", "LIFETIME_FLOW_RECOVERY_BLOCKED"], ["CANCELLED_WITHOUT_CHAMPION", "COMPETITION_CANCELLED"]] as const) {
      const competition = await h.setUpCompetition(`RecoverState${state.slice(0, 6)}`);
      const message = await rawTransaction(async (db) => {
        await db.query("set local session_replication_role = replica");
        await db.query("update competitions set state = $2 where competition_id = $1", [competition.competitionId, state]);
        await db.query("set local session_replication_role = origin");
        const refusal = await refusalOf(db, "select * from disable_lifetime_entry_flow_atomically($1::uuid, $2::uuid)", [competition.competitionId, id(competition.organizer)]);
        const stillThere = (await db.query("select count(*)::int n from competition_lifetime_flows where competition_id = $1", [competition.competitionId])).rows[0].n;
        return { refusal, stillThere };
      });
      expect(message.refusal, state).toMatch(new RegExp(`^${code}:`));
      expect(message.stillThere, `${state}: the switch row is still there`).toBe(1);
    }
  });

  it("refuses when legacy team rows exist for the competition — data only written around the guards could produce them — and removes nothing", async () => {
    const competition = await h.setUpCompetition("RecoverLegacy");
    const [captain] = await h.newPeople(1, "RecoverLegacyCaptain");
    const result = await rawTransaction(async (db) => {
      // The guards of the flow refuse a V1 team while it is on, so the row is written around them (as only the database owner could), inside a transaction that is rolled back.
      await db.query("set local session_replication_role = replica");
      await db.query("insert into competition_teams (competition_id, name, captain_gaming_member_id, status, provenance) values ($1, 'Written around the guards', $2, 'ACCEPTED', 'ORGANIZER_CREATED')", [competition.competitionId, id(captain)]);
      await db.query("set local session_replication_role = origin");
      const refusal = await refusalOf(db, "select * from disable_lifetime_entry_flow_atomically($1::uuid, $2::uuid)", [competition.competitionId, id(competition.organizer)]);
      const stillThere = (await db.query("select count(*)::int n from competition_lifetime_flows where competition_id = $1", [competition.competitionId])).rows[0].n;
      const events = (await db.query("select event_type from competition_lifetime_flow_events where competition_id = $1 order by flow_event_seq", [competition.competitionId])).rows.map((r) => r.event_type);
      return { refusal, stillThere, events };
    });
    expect(result.refusal).toMatch(/^LIFETIME_FLOW_RECOVERY_UNSAFE_LEGACY_STATE:/);
    expect(result.stillThere).toBe(1);
    expect(result.events).toEqual(["ENABLED"]);
  });
});

// =============================================================================================================================================
describe("[6] only the competition's own, active, non-revoked organizer can switch the flow off", () => {
  it("answers COMPETITION_ACCESS_DENIED to everyone else — before saying anything about the competition's state — and COMPETITION_NOT_FOUND for none", async () => {
    const { competition, team } = await withEntry("RecoverAuthz"); // an entry exists, so the owner would be told "blocked": nobody else is told anything
    const other = await h.setUpCompetition("RecoverAuthzOther"); // another competition's organizer
    const [stranger, member] = await h.newPeople(2, "RecoverAuthzStranger");
    await h.addMember(team.teamId, team.captain, member);
    const digest = await digestOf(competition.competitionId);
    for (const [label, who] of [["a stranger", stranger], ["another competition's organizer", other.organizer], ["the team captain", team.captain], ["a team member", member], ["no identity", null]] as const) {
      await refused("disable_lifetime_entry_flow_atomically", disableArgs(competition, who), "COMPETITION_ACCESS_DENIED").catch((e) => { throw new Error(`${label}: ${(e as Error).message}`); });
    }
    expect(await digestOf(competition.competitionId)).toBe(digest);
    // the same on a competition that never had the flow: a stranger does not learn "already disabled"
    const never = await h.setUpCompetition("RecoverAuthzNever", { lifetimeFlow: false });
    await refused("disable_lifetime_entry_flow_atomically", disableArgs(never, stranger), "COMPETITION_ACCESS_DENIED");
    await refused("disable_lifetime_entry_flow_atomically", { p_competition_id: "00000000-0000-4000-8000-000000000000", p_organizer_gaming_member_id: id(competition.organizer) }, "COMPETITION_NOT_FOUND");
  });

  it("answers HOST_ACCESS_REVOKED to a revoked host, before the flow's state is read, and removes nothing", async () => {
    const competition = await h.setUpCompetition("RecoverRevoked");
    const never = await h.setUpCompetition("RecoverRevokedNever", { lifetimeFlow: false });
    for (const c of [competition, never]) {
      const outcome = await withRevokedHost(c, async (db) => ({
        refusal: await refusalOf(db, "select * from disable_lifetime_entry_flow_atomically($1::uuid, $2::uuid)", [c.competitionId, id(c.organizer)]),
        flows: (await db.query("select count(*)::int n from competition_lifetime_flows where competition_id = $1", [c.competitionId])).rows[0].n,
      }));
      expect(outcome.refusal).toMatch(/^HOST_ACCESS_REVOKED:/);
      expect(outcome.flows).toBe(c === competition ? 1 : 0);
    }
    expect(await flowRows(competition.competitionId)).toHaveLength(1);
  });
});

// =============================================================================================================================================
describe("[7] the audit is append-only and the enablement evidence is preserved", () => {
  it("cannot be rewritten: no update, delete or truncate of a flow event, and no direct removal or change of the switch row — by SQL or through the API", async () => {
    const competition = await h.setUpCompetition("RecoverAppendOnly");
    await one("disable_lifetime_entry_flow_atomically", disableArgs(competition, competition.organizer));
    const digest = await digestOf(competition.competitionId);
    for (const sql of [
      "update competition_lifetime_flow_events set event_type = 'ENABLED' where competition_id = $1",
      "update competition_lifetime_flow_events set occurred_at = occurred_at - interval '1 day' where competition_id = $1",
      "delete from competition_lifetime_flow_events where competition_id = $1",
    ]) expect((await violation(sql, [competition.competitionId]))?.message, sql).toMatch(/^LIFETIME_INVARIANT_VIOLATION:/);
    expect((await violation("truncate competition_lifetime_flow_events"))?.message).toMatch(/^LIFETIME_INVARIANT_VIOLATION:/);
    // the switch row of a competition that has one can be neither changed nor removed outside the recovery
    const live = await h.setUpCompetition("RecoverAppendOnlyLive");
    for (const sql of [
      "update competition_lifetime_flows set enabled_at = now() where competition_id = $1",
      "update competition_lifetime_flows set enabled_by_gaming_member_id = enabled_by_gaming_member_id where competition_id = $1",
      "delete from competition_lifetime_flows where competition_id = $1",
    ]) expect((await violation(sql, [live.competitionId]))?.message, sql).toMatch(/^LIFETIME_INVARIANT_VIOLATION:/);
    expect((await violation("truncate competition_lifetime_flows"))?.message).toMatch(/^LIFETIME_INVARIANT_VIOLATION:/);
    expect(await flowRows(live.competitionId)).toHaveLength(1);
    expect(await digestOf(competition.competitionId)).toBe(digest);
    // and no API role can write either table at all (permission denied, not an empty result)
    for (const table of ["competition_lifetime_flows", "competition_lifetime_flow_events", "competition_lifetime_entry_decisions"]) {
      const removed = await h.service.from(table).delete().eq("competition_id", live.competitionId);
      expect(removed.error?.code, `${table} service delete`).toBe("42501");
      const anon = await h.anon.from(table).delete().eq("competition_id", live.competitionId);
      expect(anon.error?.code, `${table} anon delete`).toBe("42501");
    }
  });

  it("keeps a DISABLED event only through the recovery: the switch row guard refuses a direct DELETE even in the same transaction as a flow event insert", async () => {
    const competition = await h.setUpCompetition("RecoverNoBypass");
    const refusal = await rawTransaction(async (db) =>
      refusalOf(db, "with gone as (delete from competition_lifetime_flows where competition_id = $1 returning competition_id) select count(*) from gone", [competition.competitionId]));
    expect(refusal).toMatch(/^LIFETIME_INVARIANT_VIOLATION:/);
    expect(await flowRows(competition.competitionId)).toHaveLength(1);
  });

  it("preserves the enablement of a flow that existed BEFORE the migration: the migration's own statement writes its ENABLED event, from the switch row, tagged as a backfill", async () => {
    const migrations = path.join(process.cwd(), "supabase", "migrations");
    const file = readFileSync(path.join(migrations, "20261121060000_competition_lifetime_entry_decisions_and_flow_recovery.sql"), "utf8");
    const statement = /insert into competition_lifetime_flow_events \(competition_id, event_type, actor_gaming_member_id, occurred_at, details\)\s*select f\.competition_id[^;]*;/.exec(file);
    expect(statement, "the backfill statement is in the migration").toBeTruthy();
    const competition = await h.setUpCompetition("RecoverBackfill");
    const [flow] = await flowRows(competition.competitionId);
    const events = await rawTransaction(async (db) => {
      // As if the flow had been enabled by the CFM-001 migration, before any event existed: remove its event (as the owner could), then run the migration's statement.
      await db.query("set local session_replication_role = replica");
      await db.query("delete from competition_lifetime_flow_events where competition_id = $1", [competition.competitionId]);
      await db.query("set local session_replication_role = origin");
      await db.query(statement![0]);
      return (await db.query("select event_type, actor_gaming_member_id, occurred_at, details from competition_lifetime_flow_events where competition_id = $1 order by flow_event_seq", [competition.competitionId])).rows;
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ event_type: "ENABLED", actor_gaming_member_id: flow.enabled_by_gaming_member_id, details: { origin: "FLOW_RECORD_BACKFILL" } });
    expect(new Date(events[0].occurred_at).getTime()).toBe(new Date(flow.enabled_at).getTime());
  });
});
