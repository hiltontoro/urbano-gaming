import { createHash, randomBytes, randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { loadEnv } from "vite";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";

import { createCompetition } from "../lib/gaming/competitions/createCompetition";
import { addCompetitionTeam } from "../lib/gaming/competitions/addCompetitionTeam";
import { closeTeamRegistration } from "../lib/gaming/competitions/closeTeamRegistration";
import { CompetitionAccessDeniedError, CompetitionNotFoundError } from "../lib/gaming/competitions/types";
import { POST as createRoute, GET as listRoute } from "../app/api/gaming/competitions/route";
import { GET as viewRoute } from "../app/api/gaming/competitions/[competitionId]/route";
import { createHarness } from "./helpers/lifetimeContract";

/**
 * UG-CR-GATE-CFM-001 — compatibility, legacy backfill, privileges and the absence of any public surface, against a real (disposable, loopback-only) Postgres.
 *
 * Proves: a competition that never enables the lifetime flow runs the V1 four-team journey exactly as before (teams, freeze, draw); the legacy backfill turns
 * accepted V1 teams into legacy lifetime teams WITHOUT changing a single V1 row, merging anything or counting toward the new caps, and runs only when someone calls
 * it; every new table and function is server-only (row-level security, no browser privilege, EXECUTE only for the server role); no route or discovery payload can
 * select or create the lifetime flow; and the TypeScript repository turns every database refusal into a typed domain error.
 */

// The shared contract-test guard (UG-CR-GATE-079) runs before anything is constructed: no target that is not loopback is ever touched.
const supabaseUrl = loadEnv("development", process.cwd(), "").SUPABASE_URL;
requireLocalSupabase(supabaseUrl);
// Every scenario here builds real people and teams through the real operations, and the freeze scenarios wait for a registration deadline to pass: none of them is
// a unit test. One explicit budget for the whole file (the repo's other contract suites do the same), instead of the 5 s default that a slow machine or a parallel run can cross.
vi.setConfig({ testTimeout: 90_000 });

const h = createHarness("lx");
const { one, rpc, refused, rawQuery, violation } = h;

afterAll(() => h.cleanup(), 300000);

// The in-process route handlers and the repository read these at call time: set what they need (like the draw suite does) and put the process back as it was.
const ENV_KEYS = ["COMPETITIONS_SCHEMA_READY", "SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "SUPABASE_ANON_KEY"] as const;
const originalEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
  process.env.COMPETITIONS_SCHEMA_READY = "true";
  process.env.SUPABASE_URL ??= h.supabaseUrl;
  process.env.SUPABASE_SERVICE_ROLE_KEY ??= h.serviceKey;
  process.env.SUPABASE_ANON_KEY ??= h.anonKey;
});
afterAll(() => {
  for (const key of ENV_KEYS) {
    if (originalEnv[key] === undefined) delete process.env[key];
    else process.env[key] = originalEnv[key];
  }
});

/** Every object key in a JSON document, at any depth (values are not searched: a competition's own name is its own business). */
const allKeys = (value: unknown, found = new Set<string>()): Set<string> => {
  if (Array.isArray(value)) value.forEach((v) => allKeys(v, found));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) { found.add(k); allKeys(v, found); }
  return found;
};
const LIFETIME_KEY = /lifetime|entry_?flow|sub_?captain|roster_?claim/i;

const digestOf = async (sql: string, params: unknown[]) => createHash("sha256").update(JSON.stringify(await rawQuery(sql, params))).digest("hex");

/** Service-side fixture: approved V1 memberships (as the database owner), exactly as the SSS suites write them. */
async function giveMembers(competitionId: string, teamId: string, organizerId: string, people: Array<{ gamingMemberId: string }>) {
  await rawQuery(
    "insert into competition_team_memberships (competition_id, competition_team_id, gaming_member_id, approved_by_gaming_member_id) select $1, $2, unnest($3::uuid[]), $4",
    [competitionId, teamId, people.map((p) => p.gamingMemberId), organizerId]);
}

const V1_TABLES = {
  teams: "select * from competition_teams where competition_id = any($1) order by competition_team_id",
  memberships: "select * from competition_team_memberships where competition_id = any($1) order by competition_team_membership_id",
  registrations: "select * from competition_registrations where competition_id = any($1) order by competition_registration_id",
  competitions: "select * from competitions where competition_id = any($1) order by competition_id",
};

// =============================================================================================================================================
describe("[1] the V1 journey is unchanged for a competition that never enables the lifetime flow", () => {
  it("runs four organizer-created teams to a registration freeze and a draw, with every entry a V1 entry and no lifetime trace", async () => {
    const competition = await h.setUpCompetition("V1Journey", { lifetimeFlow: false });
    const organizerId = competition.organizer.gamingMemberId;
    const captains = await h.newPeople(4, "V1Captain");
    const members = await h.newPeople(20, "V1Member");
    const teams: string[] = [];
    for (let i = 0; i < 4; i++) {
      const team = await addCompetitionTeam(h.compRepo, competition.competitionId, organizerId, `V1 Team ${i} ${h.RUN}`, captains[i].gamingMemberId);
      teams.push(team.competitionTeamId);
      await giveMembers(competition.competitionId, team.competitionTeamId, organizerId, members.slice(i * 5, i * 5 + 5));
    }
    await h.passDeadline(competition.competitionId);
    const closed = await closeTeamRegistration(h.compRepo, competition.competitionId, organizerId);
    expect(closed.state).toBe("READY_TO_PUBLISH");
    const [freeze] = await rawQuery("select team_count, member_count from competition_registration_freezes where competition_id = $1", [competition.competitionId]);
    expect(freeze).toMatchObject({ team_count: 4, member_count: 20 });
    const draw = await h.compRepo.createCompetitionDraw(competition.competitionId, organizerId, randomUUID());
    expect(draw).toBeTruthy();
    const rows = await rawQuery("select entry_flow, lifetime_team_id, sub_captain_gaming_member_id, status from competition_teams where competition_id = $1", [competition.competitionId]);
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row).toEqual({ entry_flow: "V1", lifetime_team_id: null, sub_captain_gaming_member_id: null, status: "ACCEPTED" });
    for (const table of ["competition_lifetime_flows", "competition_lifetime_roster_claims", "competition_lifetime_freezes"]) {
      expect((await rawQuery(`select count(*)::int n from ${table} where competition_id = $1`, [competition.competitionId]))[0].n, table).toBe(0);
    }
  });

  it("adds the lifetime columns to competition_teams with the V1 default (V1, nullable references), so a team that never enters the lifetime flow is exactly what it was", async () => {
    const [columns] = await rawQuery(
      `select count(*)::int n from information_schema.columns where table_schema = 'public' and table_name = 'competition_teams'
          and ((column_name = 'entry_flow' and column_default like '%V1%' and is_nullable = 'NO') or (column_name in ('lifetime_team_id', 'sub_captain_gaming_member_id') and is_nullable = 'YES'))`);
    expect(columns.n).toBe(3);
    const [privileges] = await rawQuery("select has_table_privilege('anon', 'competition_teams', 'SELECT') a, has_table_privilege('authenticated', 'competition_teams', 'SELECT') b");
    expect(privileges).toEqual({ a: false, b: false });
  });
});

// =============================================================================================================================================
describe("[2] the legacy backfill: accepted V1 teams become legacy lifetime teams, and nothing else changes", () => {
  async function legacyWorld() {
    const [c1, c2] = [await h.setUpCompetition("LegacyOne", { lifetimeFlow: false }), await h.setUpCompetition("LegacyTwo", { lifetimeFlow: false })];
    const [cap1, cap2, a, b, c, shared] = await h.newPeople(6, "Legacy");
    const name = h.uniqueName("Los Rayos");
    const publicCode = () => randomBytes(16).toString("base64url");
    const t1 = (await rpc("add_competition_team_atomically", { p_competition_id: c1.competitionId, p_organizer_gaming_member_id: c1.organizer.gamingMemberId, p_name: name, p_captain_gaming_member_id: cap1.gamingMemberId, p_public_code: publicCode() }))[0].competition_team_id as string;
    const t2 = (await rpc("add_competition_team_atomically", { p_competition_id: c2.competitionId, p_organizer_gaming_member_id: c2.organizer.gamingMemberId, p_name: name, p_captain_gaming_member_id: cap2.gamingMemberId, p_public_code: publicCode() }))[0].competition_team_id as string;
    await giveMembers(c1.competitionId, t1, c1.organizer.gamingMemberId, [a, b, shared]);
    await giveMembers(c2.competitionId, t2, c2.organizer.gamingMemberId, [c, shared]);
    // A pending member-proposed team is not a team yet and must be skipped.
    await h.register(c1, c);
    await rpc("propose_competition_team_atomically", { p_competition_id: c1.competitionId, p_name: h.uniqueName("Pending"), p_proposing_gaming_member_id: c.gamingMemberId, p_public_code: publicCode() });
    return { c1, c2, cap1, cap2, a, b, c, shared, t1, t2, name, scope: [c1.competitionId, c2.competitionId] };
  }

  it("creates one legacy team per accepted V1 team — dated from the V1 rows, with the captain's legacy seat — without changing a single V1 row, merging anyone or skipping a duplicate name", async () => {
    const w = await legacyWorld();
    const before = Object.fromEntries(await Promise.all(Object.entries(V1_TABLES).map(async ([k, sql]) => [k, await digestOf(sql, [w.scope])])));
    const result = await one("backfill_legacy_competition_teams_atomically", { p_competition_ids: w.scope });
    expect(result).toMatchObject({ teams_created: 2, memberships_created: 7, leaderships_created: 2, skipped_already_linked: 0, skipped_not_accepted: 1 });
    const after = Object.fromEntries(await Promise.all(Object.entries(V1_TABLES).map(async ([k, sql]) => [k, await digestOf(sql, [w.scope])])));
    expect(after).toEqual(before); // not one V1 row changed
    const legacy = await rawQuery(
      `select t.lifetime_team_id, t.name, t.origin, t.status, t.created_at, s.competition_team_id from lifetime_teams t join lifetime_team_legacy_sources s on s.lifetime_team_id = t.lifetime_team_id
        where s.competition_id = any($1) order by s.competition_id`, [w.scope]);
    expect(legacy).toHaveLength(2);
    expect(legacy.map((l) => l.name)).toEqual([w.name, w.name]); // the same name twice: nothing merged
    expect(legacy.map((l) => l.competition_team_id).sort()).toEqual([w.t1, w.t2].sort());
    for (const l of legacy) {
      expect(l).toMatchObject({ origin: "LEGACY_BACKFILL", status: "ACTIVE" });
      const v1 = (await rawQuery("select created_at from competition_teams where competition_team_id = $1", [l.competition_team_id]))[0];
      expect(l.created_at).toEqual(v1.created_at);
      track(l.lifetime_team_id);
    }
    const seats = await rawQuery("select l.gaming_member_id, l.role, l.status, l.is_legacy, l.lifetime_team_id from lifetime_team_leaderships l where l.lifetime_team_id = any($1)", [legacy.map((l) => l.lifetime_team_id)]);
    expect(seats).toHaveLength(2);
    expect(seats.every((s) => s.role === "CAPTAIN" && s.status === "ACTIVE" && s.is_legacy)).toBe(true);
    const memberships = await rawQuery("select gaming_member_id, lifetime_team_id, is_legacy, status, joined_at from lifetime_team_memberships where lifetime_team_id = any($1)", [legacy.map((l) => l.lifetime_team_id)]);
    expect(memberships).toHaveLength(7);
    expect(memberships.every((m) => m.is_legacy && m.status === "ACTIVE" && m.joined_at instanceof Date)).toBe(true);
    // The person on two V1 teams (in two competitions) is on two legacy teams: two rows, one person, no merge.
    expect(memberships.filter((m) => m.gaming_member_id === w.shared.gamingMemberId)).toHaveLength(2);
    const events = await rawQuery("select details from lifetime_team_events where lifetime_team_id = any($1) and event_type = 'TEAM_CREATED'", [legacy.map((l) => l.lifetime_team_id)]);
    expect(events).toHaveLength(2);
    expect(JSON.stringify(events)).toContain("LEGACY_BACKFILL");
  });

  it("is idempotent: a second run creates nothing and reports what it skipped", async () => {
    const w = await legacyWorld();
    await one("backfill_legacy_competition_teams_atomically", { p_competition_ids: w.scope });
    const counts = async () => (await rawQuery("select (select count(*)::int from lifetime_team_legacy_sources where competition_id = any($1)) s, (select count(*)::int from lifetime_team_memberships m join lifetime_team_legacy_sources s on s.lifetime_team_id = m.lifetime_team_id where s.competition_id = any($1)) m", [w.scope]))[0];
    const before = await counts();
    const again = await one("backfill_legacy_competition_teams_atomically", { p_competition_ids: w.scope });
    expect(again).toMatchObject({ teams_created: 0, memberships_created: 0, leaderships_created: 0, skipped_already_linked: 2, skipped_not_accepted: 1 });
    expect(await counts()).toEqual(before);
    const legacyTeams = await rawQuery("select lifetime_team_id from lifetime_team_legacy_sources where competition_id = any($1)", [w.scope]);
    for (const l of legacyTeams) track(l.lifetime_team_id);
  });

  it("refuses an empty scope and does nothing for a scope with no accepted teams (a competition that has none, an id that names no competition)", async () => {
    await refused("backfill_legacy_competition_teams_atomically", { p_competition_ids: [] }, "LIFETIME_BACKFILL_SCOPE_INVALID");
    const empty = await h.setUpCompetition("LegacyEmpty", { lifetimeFlow: false });
    const none = await one("backfill_legacy_competition_teams_atomically", { p_competition_ids: [empty.competitionId, "00000000-0000-4000-8000-000000000000"] });
    expect(none).toMatchObject({ teams_created: 0, memberships_created: 0, leaderships_created: 0 });
    // That the migration itself never runs the backfill is proven by the static test in lifetimeTeams.test.ts (the name occurs exactly three times: definition, revoke,
    // grant). A check of the database's global state could not prove it — an empty database passes it, and it fails on anyone else's legitimate run.
  });

  it("keeps legacy seats and memberships out of the new caps: a legacy member joins two new teams, a legacy captain creates a new team", async () => {
    const w = await legacyWorld();
    await one("backfill_legacy_competition_teams_atomically", { p_competition_ids: w.scope });
    for (const l of await rawQuery("select lifetime_team_id from lifetime_team_legacy_sources where competition_id = any($1)", [w.scope])) track(l.lifetime_team_id);
    // `shared` holds TWO legacy memberships and then takes the full two NEW ones.
    const [capX, capY, capZ] = await h.newPeople(3, "NewCap");
    const [tx, ty, tz] = [await h.createTeam(capX), await h.createTeam(capY), await h.createTeam(capZ)];
    await h.addMember(tx.teamId, capX, w.shared);
    await h.addMember(ty.teamId, capY, w.shared);
    const third = await one("propose_lifetime_team_membership_atomically", { p_lifetime_team_id: tz.teamId, p_actor_gaming_member_id: capZ.gamingMemberId, p_subject_gaming_member_id: w.shared.gamingMemberId });
    await refused("decide_lifetime_team_membership_atomically", { p_lifetime_team_membership_id: third.lifetime_team_membership_id, p_actor_gaming_member_id: w.shared.gamingMemberId, p_decision: "ACCEPT" }, "LIFETIME_MEMBERSHIP_CAP_REACHED");
    // A legacy captain creates a NEW team: the legacy seat does not make them a leader elsewhere.
    const fresh = await h.createTeam(w.cap1);
    expect(fresh.teamId).toBeTruthy();
    // ...and that new captain is now exclusive: they cannot join another new team.
    const invitation = await one("propose_lifetime_team_membership_atomically", { p_lifetime_team_id: tx.teamId, p_actor_gaming_member_id: capX.gamingMemberId, p_subject_gaming_member_id: w.cap1.gamingMemberId });
    await refused("decide_lifetime_team_membership_atomically", { p_lifetime_team_membership_id: invitation.lifetime_team_membership_id, p_actor_gaming_member_id: w.cap1.gamingMemberId, p_decision: "ACCEPT" }, "LIFETIME_LEADER_CANNOT_JOIN_OTHER_TEAM");
  });

  it("lets a legacy team enter a new lifetime-flow competition with its legacy members, who accept their own claims", async () => {
    const w = await legacyWorld();
    await one("backfill_legacy_competition_teams_atomically", { p_competition_ids: w.scope });
    const [legacyTeam] = await rawQuery("select lifetime_team_id from lifetime_team_legacy_sources where competition_id = $1", [w.c1.competitionId]);
    track(legacyTeam.lifetime_team_id);
    const fresh = await h.setUpCompetition("LegacyEnters");
    await h.register(fresh, w.cap1, w.a, w.b);
    const entry = await one("enter_lifetime_team_into_competition_atomically", { p_competition_id: fresh.competitionId, p_lifetime_team_id: legacyTeam.lifetime_team_id, p_actor_gaming_member_id: w.cap1.gamingMemberId });
    const proposed = await rpc("propose_lifetime_entry_roster_claims_atomically", { p_competition_team_id: entry.competition_team_id, p_actor_gaming_member_id: w.cap1.gamingMemberId, p_gaming_member_ids: [w.a.gamingMemberId, w.b.gamingMemberId] });
    for (const claim of proposed) {
      const person = claim.gaming_member_id === w.a.gamingMemberId ? w.a : w.b;
      await one("decide_lifetime_entry_roster_claim_atomically", { p_competition_lifetime_roster_claim_id: claim.competition_lifetime_roster_claim_id, p_actor_gaming_member_id: person.gamingMemberId, p_decision: "ACCEPT" });
    }
    expect((await rawQuery("select count(*)::int n from competition_lifetime_roster_claims where competition_id = $1 and status = 'ACCEPTED'", [fresh.competitionId]))[0].n).toBe(2);
    const row = (await rawQuery("select entry_flow, lifetime_team_id from competition_teams where competition_team_id = $1", [entry.competition_team_id]))[0];
    expect(row).toEqual({ entry_flow: "LIFETIME", lifetime_team_id: legacyTeam.lifetime_team_id });
  });

  it("refuses — never merges — the legacy ambiguity: two same-named legacy teams cannot both enter one competition, and a person who captained two legacy teams cannot lead both entries", async () => {
    const w = await legacyWorld(); // two legacy teams with THE SAME NAME (different competitions, different captains)
    await one("backfill_legacy_competition_teams_atomically", { p_competition_ids: w.scope });
    const sources = await rawQuery("select competition_id, lifetime_team_id from lifetime_team_legacy_sources where competition_id = any($1)", [w.scope]);
    for (const row of sources) track(row.lifetime_team_id);
    const teamOf = (competitionId: string) => sources.find((r) => r.competition_id === competitionId)!.lifetime_team_id as string;
    const enter = (competitionId: string, teamId: string, actor: { gamingMemberId: string }) => ({ p_competition_id: competitionId, p_lifetime_team_id: teamId, p_actor_gaming_member_id: actor.gamingMemberId });
    const fresh = await h.setUpCompetition("LegacySameName");
    await h.register(fresh, w.cap1, w.cap2);
    await one("enter_lifetime_team_into_competition_atomically", enter(fresh.competitionId, teamOf(w.c1.competitionId), w.cap1));
    await refused("enter_lifetime_team_into_competition_atomically", enter(fresh.competitionId, teamOf(w.c2.competitionId), w.cap2), "DUPLICATE_TEAM_NAME");
    expect((await rawQuery("select count(*)::int n from competition_teams where competition_id = $1 and entry_flow = 'LIFETIME'", [fresh.competitionId]))[0].n).toBe(1);

    // One person captained two legacy teams (two competitions): backfilled as two legacy teams, never merged — and they cannot both enter one competition under that person.
    const [ca, cb] = [await h.setUpCompetition("LegacyBossA", { lifetimeFlow: false }), await h.setUpCompetition("LegacyBossB", { lifetimeFlow: false })];
    const [boss, ma, mb] = await h.newPeople(3, "Boss");
    const legacyTeam = async (c: typeof ca, name: string, member: { gamingMemberId: string }) => {
      const t = (await rpc("add_competition_team_atomically", { p_competition_id: c.competitionId, p_organizer_gaming_member_id: c.organizer.gamingMemberId, p_name: h.uniqueName(name), p_captain_gaming_member_id: boss.gamingMemberId, p_public_code: randomBytes(16).toString("base64url") }))[0].competition_team_id as string;
      await giveMembers(c.competitionId, t, c.organizer.gamingMemberId, [member]);
    };
    await legacyTeam(ca, "Boss One", ma);
    await legacyTeam(cb, "Boss Two", mb);
    await one("backfill_legacy_competition_teams_atomically", { p_competition_ids: [ca.competitionId, cb.competitionId] });
    const bossTeams = await rawQuery("select lifetime_team_id, competition_id from lifetime_team_legacy_sources where competition_id = any($1)", [[ca.competitionId, cb.competitionId]]);
    expect(bossTeams).toHaveLength(2);
    for (const row of bossTeams) track(row.lifetime_team_id);
    const second = await h.setUpCompetition("LegacyBossEnters");
    await h.register(second, boss);
    await one("enter_lifetime_team_into_competition_atomically", enter(second.competitionId, bossTeams[0].lifetime_team_id, boss));
    await refused("enter_lifetime_team_into_competition_atomically", enter(second.competitionId, bossTeams[1].lifetime_team_id, boss), "LIFETIME_PERSON_REPRESENTS_ANOTHER_TEAM");
    expect((await rawQuery("select count(*)::int n from competition_teams where competition_id = $1 and entry_flow = 'LIFETIME'", [second.competitionId]))[0].n).toBe(1);
  });

  it("lets only a legacy-origin team carry legacy rows: a direct write cannot mark a new team's rows as legacy", async () => {
    const [captain, person] = await h.newPeople(2, "NotLegacy");
    const team = await h.createTeam(captain);
    const membership = await violation(
      "insert into lifetime_team_memberships (lifetime_team_id, gaming_member_id, status, initiated_by_side, initiated_by_gaming_member_id, joined_at, expires_at, is_legacy) values ($1, $2, 'ACTIVE', 'PERSON', $2, now(), now(), true)", [team.teamId, person.gamingMemberId]);
    expect(membership?.message).toMatch(/^LIFETIME_INVARIANT_VIOLATION:/);
    const seat = await violation(
      "insert into lifetime_team_leaderships (lifetime_team_id, gaming_member_id, role, status, offered_by_gaming_member_id, started_at, is_legacy) values ($1, $2, 'SUB_CAPTAIN', 'ACTIVE', $2, now(), true)", [team.teamId, captain.gamingMemberId]);
    expect(seat?.message).toMatch(/^LIFETIME_INVARIANT_VIOLATION:/);
    expect((await violation("update lifetime_teams set origin = 'LEGACY_BACKFILL' where lifetime_team_id = $1", [team.teamId]))).not.toBeNull();
  });

  const track = (id: string) => h.trackTeam(id);
});

// =============================================================================================================================================
const TABLES = [
  "lifetime_teams", "lifetime_team_memberships", "lifetime_team_leaderships", "lifetime_team_events", "lifetime_team_legacy_sources",
  "competition_lifetime_flows", "competition_lifetime_roster_claims", "competition_lifetime_freezes",
] as const;

const U = "00000000-0000-4000-8000-000000000001";
const RPC_ARGS: Record<string, Record<string, unknown>> = {
  create_lifetime_team_atomically: { p_creator_gaming_member_id: U, p_name: "Authz Probe" },
  disband_lifetime_team_atomically: { p_lifetime_team_id: U, p_actor_gaming_member_id: U },
  propose_lifetime_team_membership_atomically: { p_lifetime_team_id: U, p_actor_gaming_member_id: U, p_subject_gaming_member_id: U },
  decide_lifetime_team_membership_atomically: { p_lifetime_team_membership_id: U, p_actor_gaming_member_id: U, p_decision: "ACCEPT" },
  withdraw_lifetime_team_offer_atomically: { p_offer_kind: "MEMBERSHIP", p_offer_id: U, p_actor_gaming_member_id: U },
  end_lifetime_team_membership_atomically: { p_lifetime_team_id: U, p_actor_gaming_member_id: U, p_subject_gaming_member_id: U, p_successor_gaming_member_id: null },
  offer_lifetime_team_leadership_atomically: { p_lifetime_team_id: U, p_actor_gaming_member_id: U, p_subject_gaming_member_id: U },
  decide_lifetime_team_leadership_atomically: { p_lifetime_team_leadership_id: U, p_actor_gaming_member_id: U, p_decision: "ACCEPT" },
  end_lifetime_team_leadership_atomically: { p_lifetime_team_id: U, p_actor_gaming_member_id: U },
  enable_lifetime_entry_flow_atomically: { p_competition_id: U, p_organizer_gaming_member_id: U },
  enter_lifetime_team_into_competition_atomically: { p_competition_id: U, p_lifetime_team_id: U, p_actor_gaming_member_id: U },
  withdraw_lifetime_competition_entry_atomically: { p_competition_team_id: U, p_actor_gaming_member_id: U },
  propose_lifetime_entry_roster_claims_atomically: { p_competition_team_id: U, p_actor_gaming_member_id: U, p_gaming_member_ids: [U] },
  decide_lifetime_entry_roster_claim_atomically: { p_competition_lifetime_roster_claim_id: U, p_actor_gaming_member_id: U, p_decision: "ACCEPT" },
  release_lifetime_entry_roster_claim_atomically: { p_competition_lifetime_roster_claim_id: U, p_actor_gaming_member_id: U },
  freeze_lifetime_competition_entries_atomically: { p_competition_id: U, p_organizer_gaming_member_id: U },
  backfill_legacy_competition_teams_atomically: { p_competition_ids: [U] },
};
const RPCS = Object.keys(RPC_ARGS);
const INTERNAL = ["lifetime_clock", "lifetime_lock_people"];

describe("[3] every new table and function is server-only", () => {
  it("lists exactly the expected tables and functions, so nothing is added by accident (8 tables, 17 operations)", async () => {
    expect(TABLES).toHaveLength(8);
    expect(RPCS).toHaveLength(17);
    const tables = await rawQuery("select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and (relname like 'lifetime\\_%' or relname like 'competition\\_lifetime\\_%') order by relname");
    expect(tables.map((t) => t.relname)).toEqual([...TABLES].sort());
    const functions = await rawQuery(
      "select proname from pg_proc where pronamespace = 'public'::regnamespace and prokind = 'f' and (proname like '%lifetime%' or proname like 'backfill\\_legacy%') and proname not like '%\\_guard' order by proname");
    expect(functions.map((f) => f.proname).sort()).toEqual([...RPCS, ...INTERNAL].sort());
  });

  it("has row-level security, no policy, no browser privilege and no direct service-role write on every table", async () => {
    const rows = await rawQuery(
      `select c.relname, c.relrowsecurity as rls, (select count(*)::int from pg_policies p where p.schemaname = 'public' and p.tablename = c.relname) as policies,
              has_table_privilege('anon', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') as anon_any, has_table_privilege('authenticated', c.oid, 'SELECT,INSERT,UPDATE,DELETE,TRUNCATE') as auth_any,
              has_table_privilege('service_role', c.oid, 'SELECT') as service_select, has_table_privilege('service_role', c.oid, 'INSERT') as service_insert,
              has_table_privilege('service_role', c.oid, 'UPDATE') as service_update, has_table_privilege('service_role', c.oid, 'DELETE') as service_delete, has_table_privilege('service_role', c.oid, 'TRUNCATE') as service_truncate
         from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname = any($1) order by c.relname`, [[...TABLES]]);
    expect(rows).toHaveLength(8);
    for (const r of rows) {
      expect(r.rls, `${r.relname} rls`).toBe(true);
      expect(r.policies, `${r.relname} policies`).toBe(0);
      expect(r.anon_any, `${r.relname} anon`).toBe(false);
      expect(r.auth_any, `${r.relname} authenticated`).toBe(false);
      expect([r.service_select, r.service_insert, r.service_update, r.service_delete, r.service_truncate], `${r.relname} service_role`).toEqual([true, false, false, false, false]);
    }
  });

  it("denies direct SELECT to the anon role and to a genuinely authenticated client (42501, not an empty result)", async () => {
    const authed = await h.authenticatedClient();
    for (const table of TABLES) {
      const anonResult = await h.anon.from(table).select("*").limit(1);
      expect(anonResult.error?.code, `${table} anon`).toBe("42501");
      const authedResult = await authed.from(table).select("*").limit(1);
      expect(authedResult.error?.code, `${table} authenticated`).toBe("42501");
    }
  });

  it("denies direct execution of every operation to anon and to an authenticated client with a strict 42501 (a well-formed call, so only the revoked privilege can refuse it)", async () => {
    const authed = await h.authenticatedClient();
    for (const fn of RPCS) {
      const anonResult = await h.anon.rpc(fn, RPC_ARGS[fn]);
      expect(anonResult.error?.code, `${fn} anon`).toBe("42501");
      const authedResult = await authed.rpc(fn, RPC_ARGS[fn]);
      expect(authedResult.error?.code, `${fn} authenticated`).toBe("42501");
    }
  });

  it("makes every operation SECURITY DEFINER with a locked search_path and EXECUTE for the server role only; the internal helpers and guards are executable by nobody", async () => {
    const rows = await rawQuery(
      `select p.proname, p.prosecdef, p.proconfig::text as cfg, has_function_privilege('service_role', p.oid, 'EXECUTE') as service_x, has_function_privilege('anon', p.oid, 'EXECUTE') as anon_x,
              has_function_privilege('authenticated', p.oid, 'EXECUTE') as auth_x,
              (select count(*)::int from pg_proc q, aclexplode(coalesce(q.proacl, acldefault('f', q.proowner))) a where q.oid = p.oid and a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_x
         from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and (p.proname like '%lifetime%' or p.proname like 'backfill\\_legacy%')`);
    expect(rows.length).toBeGreaterThanOrEqual(RPCS.length + INTERNAL.length);
    for (const row of rows) {
      expect(row.cfg, `${row.proname} search_path`).toMatch(/search_path/);
      expect(row.public_x, `${row.proname} PUBLIC`).toBe(0);
      expect(row.anon_x, `${row.proname} anon`).toBe(false);
      expect(row.auth_x, `${row.proname} authenticated`).toBe(false);
      if (RPCS.includes(row.proname)) {
        expect(row.prosecdef, `${row.proname} security definer`).toBe(true);
        expect(row.service_x, `${row.proname} service_role`).toBe(true);
      } else {
        expect(row.service_x, `${row.proname} (internal) service_role`).toBe(false);
      }
    }
  });

  it("uses no name an existing negative-surface contract watches for, and no bare null-unsafe comparison of a member id (the GATE-094 form)", async () => {
    const names = await rawQuery("select proname from pg_proc where pronamespace = 'public'::regnamespace and (proname like '%lifetime%' or proname like 'backfill\\_legacy%')");
    expect(names.length, "the scan must actually have found the new functions").toBeGreaterThanOrEqual(RPCS.length + INTERNAL.length);
    for (const { proname } of names) {
      expect(proname, proname).not.toMatch(/(amend|override|replace_captain|captain|schedule|host|competition_draw|plan_amendment)/);
      expect(proname, proname).not.toMatch(/^competition_planning_/);
    }
    const tables = await rawQuery("select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and (relname like 'lifetime\\_%' or relname like 'competition\\_lifetime\\_%')");
    expect(tables, "the scan must actually have found the new tables").toHaveLength(TABLES.length);
    for (const { relname } of tables) expect(relname, relname).not.toMatch(/(draw|pairing|schedule|fixture_slot|appeal|adjudicat|amend)/);
    const defs = await rawQuery("select p.proname, pg_get_functiondef(p.oid) as def from pg_proc p where p.pronamespace = 'public'::regnamespace and p.prokind = 'f' and (p.proname like '%lifetime%' or p.proname like 'backfill\\_legacy%')");
    const bare = /\b(p_\w*gaming_member_id)\s*(<>|!=)\s*(v_\w+)\b|\b(v_\w+)\s*(<>|!=)\s*(p_\w*gaming_member_id)\b/i;
    expect(defs.length, "the definitions must actually have been read").toBeGreaterThanOrEqual(RPCS.length);
    for (const { proname, def } of defs) expect(bare.test((def as string).replace(/--.*$/gm, "").replace(/\/\*[\s\S]*?\*\//g, "")), `${proname}: bare id comparison`).toBe(false);
  });
});

// =============================================================================================================================================
describe("[4] no public surface can select or create the lifetime flow", () => {
  it("ignores lifetime fields on the real create route: the competition is created exactly as before and has no lifetime flow", async () => {
    const organizer = await h.makeOperator("RouteOrganizer");
    const token = await h.tokenFor(organizer);
    const request = (body: unknown) => new Request("http://localhost/api/gaming/competitions", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify(body) });
    const response = await createRoute(request({ name: `CFM Route ${h.RUN}`, activityKey: "SOCCER_5V5", entryFlow: "LIFETIME", flow: "LIFETIME", lifetimeFlow: true, lifetime: { enabled: true } }));
    expect(response.status).toBe(201);
    const body = await response.json();
    h.trackCompetition(body.competition.competitionId);
    expect([...allKeys(body)].filter((k) => LIFETIME_KEY.test(k))).toEqual([]);
    expect(await rawQuery("select 1 from competition_lifetime_flows where competition_id = $1", [body.competition.competitionId])).toHaveLength(0);
  });

  it("shows no lifetime field in the discovery list or in the addressed competition view, even for a competition on the lifetime flow with an entry", async () => {
    const competition = await h.setUpCompetition("Discovery");
    const team = await h.buildTeam("DiscoveryTeam", 4);
    await h.enterTeam(competition, team);
    const token = await h.tokenFor(competition.organizer);
    const list = await listRoute(new Request("http://localhost/api/gaming/competitions", { headers: { authorization: `Bearer ${token}` } }));
    expect(list.status).toBe(200);
    const listed = await list.json();
    const mine = listed.competitions.find((c: { competitionId: string }) => c.competitionId === competition.competitionId);
    expect(mine, "the competition is discoverable exactly as any other").toBeTruthy();
    expect([...allKeys(listed)].filter((k) => LIFETIME_KEY.test(k))).toEqual([]);
    const view = await viewRoute(new Request(`http://localhost/api/gaming/competitions/${competition.competitionId}`, { headers: { authorization: `Bearer ${token}` } }), { params: { competitionId: competition.competitionId } });
    expect(view.status).toBe(200);
    expect([...allKeys(await view.json())].filter((k) => LIFETIME_KEY.test(k))).toEqual([]);
  });
});

// =============================================================================================================================================
describe("[5] the TypeScript repository turns every database refusal into a typed domain error", () => {
  // Loaded lazily: until the modules exist, only the tests that need them can fail.
  const load = async () => {
    const { LifetimeTeamError } = await import("../lib/gaming/competitions/lifetimeTeams");
    const { SupabaseLifetimeTeamsRepository } = await import("../lib/gaming/competitions/db/supabaseLifetimeTeamsRepository");
    return { LifetimeTeamError, repo: new SupabaseLifetimeTeamsRepository(h.supabaseUrl, h.serviceKey) };
  };

  it("creates and reads a team, and maps a coded lifetime refusal to a LifetimeTeamError with a stable code and no database wording", async () => {
    const { LifetimeTeamError, repo } = await load();
    const [captain, other] = await h.newPeople(2, "Repo");
    const name = h.uniqueName("Repo Team");
    const created = await repo.createLifetimeTeam(captain.gamingMemberId, name);
    h.trackTeam(created.lifetimeTeamId);
    expect(created.publicCode).toMatch(/^[A-Za-z0-9_-]{22}$/);
    const read = await repo.getLifetimeTeam(created.lifetimeTeamId);
    expect(read).toMatchObject({ name, status: "ACTIVE", origin: "NEW" });
    expect(read!.members.map((m) => m.gamingMemberId)).toEqual([captain.gamingMemberId]);
    expect(read!.leaders.map((l) => [l.role, l.gamingMemberId])).toEqual([["CAPTAIN", captain.gamingMemberId]]);
    const taken = await repo.createLifetimeTeam(other.gamingMemberId, name).catch((e) => e);
    expect(taken).toBeInstanceOf(LifetimeTeamError);
    expect(taken.code).toBe("NAME_TAKEN");
    expect(taken.message).not.toMatch(/LIFETIME_|P0001|violates|constraint/);
    expect(await repo.getLifetimeTeam("00000000-0000-4000-8000-000000000000")).toBeNull();
    // A team with a sub-captain and members: the ONE request returns exactly the ACTIVE leaders and members, in the order they began, and never an ended period.
    const built = await h.buildTeam("RepoRead", 4);
    const left = built.members[1];
    await h.rpc("end_lifetime_team_membership_atomically", { p_lifetime_team_id: built.teamId, p_actor_gaming_member_id: left.gamingMemberId, p_subject_gaming_member_id: left.gamingMemberId });
    const view = await repo.getLifetimeTeam(built.teamId);
    expect(view!.leaders.map((l) => [l.role, l.gamingMemberId])).toEqual([["CAPTAIN", built.captain.gamingMemberId], ["SUB_CAPTAIN", built.subCaptain!.gamingMemberId]]);
    expect(view!.members.map((m) => m.gamingMemberId)).toEqual([built.captain.gamingMemberId, built.subCaptain!.gamingMemberId, built.members[0].gamingMemberId]);
    const summaries = await repo.listActiveTeamsOfMember(built.members[0].gamingMemberId);
    expect(summaries.map((t) => [t.lifetimeTeamId, t.name, t.status])).toEqual([[built.teamId, built.name, "ACTIVE"]]);
    expect(await repo.listActiveTeamsOfMember(left.gamingMemberId)).toEqual([]);
  });

  it("maps the shared competition refusals to the existing typed errors, and a missing or malformed identifier before it reaches the database", async () => {
    const { LifetimeTeamError, repo } = await load();
    const competition = await h.setUpCompetition("RepoFlow", { lifetimeFlow: false });
    const [stranger] = await h.newPeople(1, "RepoStranger");
    const denied = await repo.enableEntryFlow(competition.competitionId, stranger.gamingMemberId).catch((e) => e);
    expect(denied).toBeInstanceOf(CompetitionAccessDeniedError);
    expect(denied.message).not.toMatch(/COMPETITION_ACCESS_DENIED|lifetime flow/i); // the database's own words never reach a caller
    const enabled = await repo.enableEntryFlow(competition.competitionId, competition.organizer.gamingMemberId);
    expect(enabled.alreadyEnabled).toBe(false);
    const noCompetition = await repo.enableEntryFlow("00000000-0000-4000-8000-000000000000", competition.organizer.gamingMemberId).catch((e) => e);
    expect(noCompetition).toBeInstanceOf(CompetitionNotFoundError);
  });

  it("runs the whole entry journey through the repository: enter, propose, affirm, freeze, and reads the entry with its claims", async () => {
    const { LifetimeTeamError, repo } = await load();
    const competition = await h.setUpCompetition("RepoJourney");
    const teamA = await h.buildTeam("RepoA", 6);
    const teamB = await h.buildTeam("RepoB", 6);
    await h.register(competition, teamA.captain, teamB.captain);
    const entryA = await repo.enterTeam(competition.competitionId, teamA.teamId, teamA.captain.gamingMemberId);
    const entryB = await repo.enterTeam(competition.competitionId, teamB.teamId, teamB.captain.gamingMemberId);
    const proposedOrder: Record<string, string[]> = {};
    for (const [entry, team] of [[entryA, teamA], [entryB, teamB]] as const) {
      const proposed = await repo.proposeRosterClaims(entry.competitionTeamId, team.captain.gamingMemberId, team.everyone.map((p) => p.gamingMemberId));
      expect(proposed).toHaveLength(6);
      proposedOrder[entry.competitionTeamId] = proposed.map((c) => c.claimId);
      for (const claim of proposed) {
        const person = team.everyone.find((p) => p.gamingMemberId === claim.gamingMemberId)!;
        await h.register(competition, person);
        const decided = await repo.decideRosterClaim(claim.claimId, person.gamingMemberId, "ACCEPT");
        expect(decided.status).toBe("ACCEPTED");
      }
    }
    await h.passDeadline(competition.competitionId);
    const frozen = await repo.freezeEntries(competition.competitionId, competition.organizer.gamingMemberId);
    expect(frozen).toMatchObject({ entryCount: 2, claimCount: 12, alreadyFrozen: false });
    const entry = await repo.getEntry(entryA.competitionTeamId);
    expect(entry).toMatchObject({ lifetimeTeamId: teamA.teamId, name: teamA.name, captainGamingMemberId: teamA.captain.gamingMemberId, subCaptainGamingMemberId: teamA.subCaptain!.gamingMemberId });
    expect(entry!.claims).toHaveLength(6);
    expect(entry!.claims.every((c) => c.status === "ACCEPTED")).toBe(true);
    // The claims arrive embedded in the entry's own single read (a composite foreign key), in the order they were made.
    expect(entry!.claims.map((c) => c.claimId)).toEqual(proposedOrder[entryA.competitionTeamId]);
    const frozenAgain = await repo.proposeRosterClaims(entryA.competitionTeamId, teamA.captain.gamingMemberId, [teamA.members[0].gamingMemberId]).catch((e) => e);
    expect(frozenAgain).toBeInstanceOf(LifetimeTeamError);
    expect(frozenAgain.code).toBe("ENTRIES_FROZEN");
  });

  it("rejects a malformed identifier before it reaches the database, with no database wording", async () => {
    const { LifetimeTeamError, repo } = await load();
    const error = await repo.endMembership("not-a-uuid", "not-a-uuid", "not-a-uuid").catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).not.toMatch(/invalid input syntax|uuid|PGRST|22P02/i);
  });
});
