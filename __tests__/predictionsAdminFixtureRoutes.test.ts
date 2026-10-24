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
