import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextResponse } from "next/server";
import { buildCatalogWorld, callCount, callsTouching, type CatalogWorld } from "./fixtureCatalogWorld";

/**
 * The administration lists (teams, matches, venues, activations): the default view leaves out the exact fixture ids and the explicit
 * ?includeFixtures=1 brings the historical test data back. The authority checks are unchanged (they run first and a refusal reads nothing).
 * Repository calls are counted: an excluded match must cost no activation, venue or prize tier query.
 */

const state: { world: CatalogWorld | null; deny: number | null } = vi.hoisted(() => ({ world: null, deny: null }));

vi.mock("@/lib/gaming/predictions/httpAuth", () => ({
  getSupabaseCredentials: () => ({ url: "http://localhost:1", serviceKey: "stand-in" }),
  buildPredictionsRepo: () => state.world!.repo,
  requireAnyAdminAuthority: async () => (state.deny ? { errorResponse: NextResponse.json({ error: "denied" }, { status: state.deny }) } : { gamingMemberId: "admin-member" }),
  requirePlatformAuthorityHttp: async () => (state.deny ? { errorResponse: NextResponse.json({ error: "denied" }, { status: state.deny }) } : { gamingMemberId: "admin-member" }),
  statusForPredictionsError: () => null,
}));

import { GET as teamsGet } from "@/app/api/gaming/predictions/admin/teams/route";
import { GET as matchesGet } from "@/app/api/gaming/predictions/admin/matches/route";
import { GET as venuesGet } from "@/app/api/gaming/predictions/admin/venues/route";
import { GET as activationsGet } from "@/app/api/gaming/predictions/admin/activations/route";

const url = (name: string, query = "") => new Request(`http://localhost/api/gaming/predictions/admin/${name}${query}`);
const FLAG = "?includeFixtures=1";

async function json(response: Response) {
  expect(response.status).toBe(200);
  return (await response.json()) as any;
}

beforeEach(() => {
  state.world = buildCatalogWorld();
  state.deny = null;
});

describe("default view: the fixtures are not in the lists", () => {
  it("teams: only the legitimate teams", async () => {
    const body = await json(await teamsGet(url("teams")));
    expect(body.teams.map((t: any) => t.teamId).sort()).toEqual([...state.world!.legit.teamIds].sort());
    for (const team of body.teams) expect(state.world!.fixtureIds.teams.has(team.teamId)).toBe(false);
  });

  it("matches: only the legitimate matches and teams (a cancelled legitimate match is still listed to the admin)", async () => {
    const body = await json(await matchesGet(url("matches")));
    const { oldMatchId, lookAlikeMatchId, newMatchId, cancelledMatchId, teamIds } = state.world!.legit;
    expect(body.matches.map((m: any) => m.matchId).sort()).toEqual([oldMatchId, lookAlikeMatchId, newMatchId, cancelledMatchId].sort());
    expect(body.teams.map((t: any) => t.teamId).sort()).toEqual([...teamIds].sort());
  });

  it("a legitimate old match is still listed, and a new one is not taken for a fixture", async () => {
    const body = await json(await matchesGet(url("matches")));
    const ids = body.matches.map((m: any) => m.matchId);
    expect(ids).toContain(state.world!.legit.oldMatchId); // kick-off in 2020
    expect(ids).toContain(state.world!.legit.newMatchId); // created today
    expect(ids).toContain(state.world!.legit.lookAlikeMatchId); // same competition, class and day as the fixtures, new id
  });

  it("venues: only the legitimate venues", async () => {
    const body = await json(await venuesGet(url("venues")));
    expect(body.venues.map((v: any) => v.venueId).sort()).toEqual([...state.world!.legit.venueIds].sort());
  });

  it("activations: only the legitimate ones, and the fixture matches cost no activation, venue or tier query", async () => {
    const body = await json(await activationsGet(url("activations")));
    const w = state.world!;
    expect(body.activations.map((a: any) => a.venueActivationId).sort()).toEqual([...w.legit.activationIds].sort());
    expect(callsTouching(w.calls, w.fixtureIds.matches)).toEqual([]);
    expect(callsTouching(w.calls, w.fixtureIds.venues)).toEqual([]);
    expect(callsTouching(w.calls, w.fixtureIds.activations)).toEqual([]);
    expect(callCount(w.calls, "listVenueActivationsForMatch")).toBe(4); // the 4 legitimate matches, not 40
  });

  it("the offer of the new activation is still computed (four consecutive levels)", async () => {
    const body = await json(await activationsGet(url("activations")));
    const rehearsal = body.activations.find((a: any) => a.venueActivationId === state.world!.legit.activationIds[1]);
    expect(rehearsal.enabled).toBe(false);
    expect(rehearsal.offer).toMatchObject({ available: true, maxLevel: 4 });
  });
});

describe("?includeFixtures=1: the historical test data is back, and only then", () => {
  it("teams, matches, venues and activations return everything", async () => {
    const w = state.world!;
    expect((await json(await teamsGet(url("teams", FLAG)))).teams).toHaveLength(w.teams.length);
    const matches = await json(await matchesGet(url("matches", FLAG)));
    expect(matches.matches).toHaveLength(w.matches.length);
    expect(matches.teams).toHaveLength(w.teams.length);
    expect((await json(await venuesGet(url("venues", FLAG)))).venues).toHaveLength(w.venues.length);
    expect((await json(await activationsGet(url("activations", FLAG)))).activations).toHaveLength(w.activations.length);
    expect(callCount(w.calls, "listVenueActivationsForMatch")).toBe(w.matches.length);
  });

  it("any other value is the default view", async () => {
    for (const query of ["?includeFixtures=0", "?includeFixtures=true", "?includeFixtures="]) {
      expect((await json(await teamsGet(url("teams", query)))).teams).toHaveLength(state.world!.legit.teamIds.length);
    }
  });
});

describe("our own rehearsals (2026-10-25): hidden by their exact ids, shown only on request, nothing else touched", () => {
  const rehearsalWorld = () => buildCatalogWorld({ withRehearsal: true });
  const idsOf = (rows: any[], key: string) => rows.map((row) => row[key]);

  beforeEach(() => { state.world = rehearsalWorld(); });

  it("default view: none of the 2 rehearsal teams, 3 rehearsal matches or 3 rehearsal activations is listed", async () => {
    const w = state.world!;
    const teams = await json(await teamsGet(url("teams")));
    const matches = await json(await matchesGet(url("matches")));
    const activations = await json(await activationsGet(url("activations")));
    for (const id of w.rehearsal!.ids.teams) { expect(idsOf(teams.teams, "teamId")).not.toContain(id); expect(idsOf(matches.teams, "teamId")).not.toContain(id); }
    for (const id of w.rehearsal!.ids.matches) expect(idsOf(matches.matches, "matchId")).not.toContain(id);
    for (const id of w.rehearsal!.ids.activations) expect(idsOf(activations.activations, "venueActivationId")).not.toContain(id);
  });

  it("default view: the REAL Clasico (new ids, disabled activation, The Pub) is listed in every view, with its prize offer still computed", async () => {
    const w = state.world!;
    const { clasico } = w.rehearsal!;
    const matches = await json(await matchesGet(url("matches")));
    expect(idsOf(matches.matches, "matchId")).toContain(clasico.matchId);
    expect(idsOf(matches.teams, "teamId")).toEqual(expect.arrayContaining([clasico.homeTeamId, clasico.awayTeamId]));
    const activations = await json(await activationsGet(url("activations")));
    const activation = activations.activations.find((a: any) => a.venueActivationId === clasico.activationId);
    expect(activation).toMatchObject({ matchId: clasico.matchId, enabled: false, venue: { venueId: clasico.venueId, name: "The Pub by Beer Box" } });
    expect(activation.offer).toMatchObject({ available: false, problem: "NO_LEVELS" });
  });

  it("default view: nothing is hidden by name — a team and a match created later with EXACTLY the rehearsal names, under new ids, are listed", async () => {
    const { sameNameNewIds } = state.world!.rehearsal!;
    const teams = await json(await teamsGet(url("teams")));
    expect(teams.teams.find((t: any) => t.teamId === sameNameNewIds.teamId)).toMatchObject({ name: "Equipo A (ensayo)" });
    const matches = await json(await matchesGet(url("matches")));
    expect(matches.matches.find((m: any) => m.matchId === sameNameNewIds.matchId)).toMatchObject({ competition: "ENSAYO — sin premios reales · The Pub", activityClassification: "TRAINING" });
  });

  it("default view: the venues are NOT hidden — The Pub, Finca Ocho and the 15 m copy that a rehearsal made are all listed", async () => {
    const { venueIds } = state.world!.rehearsal!;
    const venues = await json(await venuesGet(url("venues")));
    expect(idsOf(venues.venues, "venueId")).toEqual(expect.arrayContaining([venueIds.thePub, venueIds.fincaOcho, venueIds.fincaOcho15m]));
    expect(venues.venues).toHaveLength(state.world!.legit.venueIds.length + 3);
  });

  it("?includeFixtures=1 brings every rehearsal row back (and everything else is listed too)", async () => {
    const w = state.world!;
    const teams = await json(await teamsGet(url("teams", FLAG)));
    const matches = await json(await matchesGet(url("matches", FLAG)));
    const activations = await json(await activationsGet(url("activations", FLAG)));
    expect(teams.teams).toHaveLength(w.teams.length);
    expect(matches.matches).toHaveLength(w.matches.length);
    expect(activations.activations).toHaveLength(w.activations.length);
    for (const id of w.rehearsal!.ids.teams) expect(idsOf(teams.teams, "teamId")).toContain(id);
    for (const id of w.rehearsal!.ids.matches) expect(idsOf(matches.matches, "matchId")).toContain(id);
    for (const id of w.rehearsal!.ids.activations) expect(idsOf(activations.activations, "venueActivationId")).toContain(id);
  });

  it("a hidden rehearsal match costs no activation, venue, tier or team query, and no rehearsal row is read in the default view", async () => {
    const w = state.world!;
    await matchesGet(url("matches"));
    await activationsGet(url("activations"));
    expect(callsTouching(w.calls, w.rehearsal!.ids.matches)).toEqual([]);
    expect(callsTouching(w.calls, w.rehearsal!.ids.activations)).toEqual([]);
    expect(callsTouching(w.calls, w.rehearsal!.ids.teams)).toEqual([]);
    // the 4 legitimate matches + the real Clasico + the same-name match: 6 activation lookups, not 9 (3 rehearsal) and not 45
    expect(callCount(w.calls, "listVenueActivationsForMatch")).toBe(6);
  });

  it("nothing is deleted, renamed or altered: the rows, their players, their tiers and the lists themselves only ever read", async () => {
    const w = state.world!;
    const before = JSON.stringify({ m: w.matches, t: w.teams, p: w.players, v: w.venues, a: w.activations, tiers: w.tiers });
    for (const query of ["", FLAG]) {
      await teamsGet(url("teams", query));
      await matchesGet(url("matches", query));
      await venuesGet(url("venues", query));
      await activationsGet(url("activations", query));
    }
    expect(JSON.stringify({ m: w.matches, t: w.teams, p: w.players, v: w.venues, a: w.activations, tiers: w.tiers })).toBe(before);
    expect(w.calls.every(([method]) => /^(list|get)/.test(method))).toBe(true);
    // the evidence is all still there: 4 rehearsal players, 12 rehearsal tiers
    expect(w.players.filter((p) => w.rehearsal!.ids.players.has(p.playerId))).toHaveLength(4);
    expect(w.tiers.filter((t) => w.rehearsal!.ids.tiers.has(t.prizeTierId))).toHaveLength(12);
  });
});

describe("the authority checks are untouched: a refusal reads nothing", () => {
  it("401 and 403 are returned before any repository call, with or without the flag", async () => {
    for (const status of [401, 403]) {
      state.deny = status;
      for (const handler of [teamsGet, matchesGet, venuesGet, activationsGet]) {
        for (const query of ["", FLAG]) {
          state.world = buildCatalogWorld();
          const response = await handler(url("x", query));
          expect(response.status).toBe(status);
          expect(state.world.calls).toEqual([]);
        }
      }
    }
  });
});

describe("the exclusion never changes a row", () => {
  it("only reads: no create, edit, cancel or toggle is made by any list", async () => {
    for (const query of ["", FLAG]) {
      await teamsGet(url("teams", query));
      await matchesGet(url("matches", query));
      await venuesGet(url("venues", query));
      await activationsGet(url("activations", query));
    }
    expect(state.world!.calls.every(([method]) => /^(list|get)/.test(method))).toBe(true);
  });
});
