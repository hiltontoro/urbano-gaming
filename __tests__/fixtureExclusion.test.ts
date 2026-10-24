import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import {
  FixtureManifestIntegrityError,
  emptyFixtureManifest,
  excludeFixtures,
  fixtureFingerprint,
  includeFixturesRequested,
  isFixtureId,
  verifyFixtureManifest,
  visibleInAdminView,
  type FixtureManifest,
} from "@/lib/gaming/predictions/fixtureExclusion";
import { TEMPORARY_FIXTURE_EXCLUSION } from "@/lib/gaming/predictions/fixtureExclusionManifest";
import { buildCatalogWorld, callCount, callSignature, callsTouching, type CatalogWorld } from "./fixtureCatalogWorld";

/**
 * The temporary exclusion of the verified contract-test fixtures. It is an exact list of ids (172 of them, with fingerprints), never a rule:
 * nothing is hidden by name, prefix, date, age, classification or competition, a new match is never taken for a fixture, and an excluded
 * match costs no dependent query. Nothing is deleted or altered.
 */

const world: { current: CatalogWorld | null } = vi.hoisted(() => ({ current: null }));

vi.mock("@/lib/gaming/predictions/httpAuth", () => ({
  getSupabaseCredentials: () => ({ url: "http://localhost:1", serviceKey: "stand-in" }),
  buildPredictionsRepo: () => world.current!.repo,
}));

import { GET as publicMatches } from "@/app/api/gaming/predictions/matches/route";

const M = TEMPORARY_FIXTURE_EXCLUSION;
const KINDS = ["matches", "teams", "venues", "activations"] as const;

function copy(manifest: FixtureManifest): { -readonly [K in keyof FixtureManifest]: any } {
  return JSON.parse(JSON.stringify(manifest));
}

describe("the manifest is exactly the inventoried set", () => {
  it("holds the counts that were read from Production, and every fingerprint is reproduced from its ids", () => {
    expect({ matches: M.matches.length, teams: M.teams.length, venues: M.venues.length, activations: M.activations.length }).toEqual({ matches: 36, teams: 82, venues: 30, activations: 24 });
    for (const kind of KINDS) {
      expect(M.fingerprints[kind].count, kind).toBe(M[kind].length);
      expect(fixtureFingerprint(M[kind]), kind).toBe(M.fingerprints[kind].sha256);
    }
    expect(() => verifyFixtureManifest(M)).not.toThrow();
  });

  it("pins the fingerprints that the read-only inventory computed in Production on 2026-10-24", () => {
    expect(M.fingerprints.matches.sha256).toBe("2fe72826a5391a51a421586c22ce4a2a20c7589a3de0769e35a55084b09c0ca2");
    expect(M.fingerprints.teams.sha256).toBe("719f9695fe361c09d06a3103ec82be0a8ed3830cafc5ed0f412136ee487f9460");
    expect(M.fingerprints.venues.sha256).toBe("845aa1b0d1797cbde02cc566fa7afb1587af0aa733b48ec4960ae6d1addc04c0");
    expect(M.fingerprints.activations.sha256).toBe("2792ec5e8cd6808c708f96876953c34164bb7ea7ca5b3b13b9cf31b215f773b8");
  });

  it("contains canonical lowercase uuids, no duplicates, and no id in two lists", () => {
    const all: string[] = [];
    for (const kind of KINDS) {
      for (const id of M[kind]) {
        expect(id, `${kind} ${id}`).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
        all.push(id);
      }
    }
    expect(new Set(all).size).toBe(all.length);
    expect(all).toHaveLength(172);
  });

  it("is a subset-compatible with the 64-row recoverable-delete set of the inventory (its fingerprints reproduce from the same method)", () => {
    // The 4 matches, 22 teams and 6 venues of that set are all inside this manifest; the method (sorted ids joined by ",") is the same.
    expect(fixtureFingerprint(["b", "a"])).toBe(fixtureFingerprint(["a", "b"]));
    expect(fixtureFingerprint([])).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
  });

  it("refuses an edited list: a dropped, swapped or duplicated id, a wrong count or a wrong fingerprint all fail loudly", () => {
    const mutate = (change: (m: any) => void) => { const m = copy(M); change(m); return m as FixtureManifest; };
    const bad: Array<[string, FixtureManifest]> = [
      ["dropped match", mutate((m) => m.matches.pop())],
      ["swapped team", mutate((m) => { m.teams[0] = "00000000-0000-4000-8000-000000000000"; })],
      ["duplicated venue", mutate((m) => { m.venues[1] = m.venues[0]; })],
      ["wrong declared count", mutate((m) => { m.fingerprints.activations.count = 25; })],
      ["wrong declared fingerprint", mutate((m) => { m.fingerprints.matches.sha256 = "0".repeat(64); })],
      ["added activation", mutate((m) => { m.activations.push("00000000-0000-4000-8000-000000000001"); })],
    ];
    for (const [label, manifest] of bad) {
      expect(() => verifyFixtureManifest(manifest), label).toThrow(FixtureManifestIntegrityError);
      expect(() => excludeFixtures([{ id: "x" }], "matches", (item) => item.id, manifest), `${label} must not be used to hide anything`).toThrow(FixtureManifestIntegrityError);
    }
  });
});

describe("excludeFixtures hides ids, and nothing else", () => {
  const item = (id: string, extra: Record<string, unknown> = {}) => ({ id, ...extra });

  it("removes exactly the ids of the manifest, per kind, and keeps the order of the rest", () => {
    const fixture = M.matches[3]!;
    const kept = [item("11111111-1111-4111-8111-111111111111"), item("22222222-2222-4222-8222-222222222222")];
    const result = excludeFixtures([kept[0]!, item(fixture), kept[1]!], "matches", (i) => i.id);
    expect(result).toEqual(kept);
    // an id of ANOTHER kind is not an id of this kind
    expect(excludeFixtures([item(M.teams[0]!)], "matches", (i) => i.id)).toHaveLength(1);
    expect(isFixtureId("teams", M.teams[0]!)).toBe(true);
    expect(isFixtureId("matches", M.teams[0]!)).toBe(false);
  });

  it("is case-insensitive on the id only", () => {
    expect(excludeFixtures([item(M.matches[0]!.toUpperCase())], "matches", (i) => i.id)).toEqual([]);
  });

  it("nothing is hidden by name, prefix, date, age, classification or competition", () => {
    const lookalikes = [
      item("33333333-3333-4333-8333-333333333333", { competition: "Contract Test", name: "Real Madrid 0001", kickoffAt: "2026-08-25T18:00:00.000Z", classification: "RANKED" }),
      item("44444444-4444-4444-8444-444444444444", { competition: "Contract Test — A1", name: "Barcelona a6", kickoffAt: "2020-01-01T00:00:00.000Z", classification: "RANKED" }),
      item("55555555-5555-4555-8555-555555555555", { competition: "Liga Nacional", name: "Outsiders", kickoffAt: "2019-05-05T00:00:00.000Z", classification: null }),
    ];
    expect(excludeFixtures(lookalikes, "matches", (i) => i.id)).toEqual(lookalikes);
    // …and an id of the manifest is excluded whatever it looks like
    const disguised = item(M.matches[7]!, { competition: "Liga Nacional", name: "Alpha FC", kickoffAt: "2099-01-01T00:00:00.000Z", classification: "TRAINING" });
    expect(excludeFixtures([disguised], "matches", (i) => i.id)).toEqual([]);
  });

  it("an empty manifest excludes nothing (the catalog as it was before)", () => {
    const empty = emptyFixtureManifest();
    expect(() => verifyFixtureManifest(empty)).not.toThrow();
    expect(excludeFixtures([item(M.matches[0]!)], "matches", (i) => i.id, empty)).toHaveLength(1);
  });

  it("the module's code looks at ids only: no name, date, age, class, competition or prefix test", () => {
    const code = readFileSync(path.join(process.cwd(), "lib/gaming/predictions/fixtureExclusion.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const forbidden of [/competition/i, /kickoff/i, /createdAt/i, /RANKED|TRAINING|OFFICIAL|CASUAL/, /Contract Test/i, /startsWith|endsWith|\.test\(|\.match\(|RegExp|toLocale|Date\b|(?<!this)\.name\b/]) {
      expect(code, String(forbidden)).not.toMatch(forbidden);
    }
    const route = readFileSync(path.join(process.cwd(), "app/api/gaming/predictions/matches/route.ts"), "utf8")
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    expect(route).toContain('excludeFixtures(');
    expect(route).not.toMatch(/Contract Test|startsWith|PREFIX|horizon|\b48 ?h|new Date|Date\.now|kickoffAt\s*[<>]/i);
  });
});

describe("the administration views ask for the history by name", () => {
  const request = (query: string) => new Request(`http://localhost/api/gaming/predictions/admin/teams${query}`);

  it("only ?includeFixtures=1 brings the historical data back", () => {
    expect(includeFixturesRequested(request(""))).toBe(false);
    expect(includeFixturesRequested(request("?includeFixtures=1"))).toBe(true);
    for (const query of ["?includeFixtures=0", "?includeFixtures=true", "?includeFixtures=", "?includeFixtures=yes", "?includeFixtures=1x", "?IncludeFixtures=1", "?include=1", "?includeFixtures%5B%5D=1"]) {
      expect(includeFixturesRequested(request(query)), query).toBe(false);
    }
    expect(includeFixturesRequested({ url: "not a url" } as unknown as Request)).toBe(false);
  });

  it("visibleInAdminView drops the manifest by default and keeps everything when asked", () => {
    const rows = [{ id: M.teams[0]! }, { id: "66666666-6666-4666-8666-666666666666" }];
    expect(visibleInAdminView(request(""), rows, "teams", (r) => r.id)).toEqual([rows[1]]);
    expect(visibleInAdminView(request("?includeFixtures=1"), rows, "teams", (r) => r.id)).toEqual(rows);
  });
});

describe("GET /api/gaming/predictions/matches: fixtures are left out before anything depends on them", () => {
  const ask = async () => {
    const response = await publicMatches();
    expect(response.status).toBe(200);
    return (await response.json()) as { matches: Array<{ matchId: string; competition: string; homeTeam: { name: string } | null }> };
  };

  beforeEach(() => { world.current = null; });

  it("lists the legitimate matches and none of the 36 fixtures", async () => {
    world.current = buildCatalogWorld();
    const body = await ask();
    const ids = body.matches.map((m) => m.matchId);
    for (const id of world.current.fixtureIds.matches) expect(ids).not.toContain(id);
    // the cancelled one stays out (as before); the three legitimate, non-cancelled ones are all there
    const { oldMatchId, lookAlikeMatchId, newMatchId, cancelledMatchId } = world.current.legit;
    expect([...ids].sort()).toEqual([oldMatchId, lookAlikeMatchId, newMatchId].sort());
    expect(ids).not.toContain(cancelledMatchId);
  });

  it("a legitimate OLD match is not hidden by its age, and a new match is not taken for a fixture", async () => {
    world.current = buildCatalogWorld();
    const body = await ask();
    const byId = new Map(body.matches.map((m) => [m.matchId, m]));
    const { oldMatchId, newMatchId, lookAlikeMatchId } = world.current.legit;
    expect(byId.get(oldMatchId)?.competition).toBe("Liga Nacional"); // kick-off in 2020, shown
    expect(byId.get(newMatchId)?.competition).toBe("Ensayo de ubicación — sin valor"); // created today, shown
    // same competition, classification and day as the fixtures, but a new id: shown
    expect(byId.get(lookAlikeMatchId)?.competition).toBe("Contract Test");
  });

  it("an excluded match costs no dependent query: no team, roster, activation, venue, tier or result is read for it", async () => {
    world.current = buildCatalogWorld();
    await ask();
    const w = world.current;
    expect(callsTouching(w.calls, w.fixtureIds.matches)).toEqual([]);
    expect(callsTouching(w.calls, w.fixtureIds.teams)).toEqual([]);
    expect(callsTouching(w.calls, w.fixtureIds.venues)).toEqual([]);
    expect(callsTouching(w.calls, w.fixtureIds.activations)).toEqual([]);
    expect(callCount(w.calls, "listMatches")).toBe(1);
  });

  it("the requests are exactly those of a catalog that never had the fixtures (apart from reading the matches list itself)", async () => {
    world.current = buildCatalogWorld();
    await ask();
    const withFixtures = callSignature(world.current.calls);
    world.current = buildCatalogWorld({ withoutFixtures: true });
    await ask();
    expect(callSignature(world.current.calls)).toEqual(withFixtures);
  });

  it("without the exclusion (the same rows under ids that are not in the manifest) every one of them is loaded: the control that proves the saving", async () => {
    world.current = buildCatalogWorld({ unlistedFixtures: true });
    const body = await ask();
    // 34 non-cancelled fixtures + 3 legitimate ones
    expect(body.matches).toHaveLength(37);
    const unlistedCalls = callCount(world.current.calls);
    world.current = buildCatalogWorld();
    await ask();
    const excludedCalls = callCount(world.current.calls);
    expect(excludedCalls).toBeLessThan(unlistedCalls / 5);
    // the exact figures of this catalog, recorded so a change in the fan-out is noticed
    console.log("public list repository calls:", { before: unlistedCalls, after: excludedCalls });
  });

  it("does not delete or alter a single row", async () => {
    world.current = buildCatalogWorld();
    const before = JSON.stringify({ m: world.current.matches, t: world.current.teams, v: world.current.venues, a: world.current.activations, p: world.current.players });
    await ask();
    expect(JSON.stringify({ m: world.current.matches, t: world.current.teams, v: world.current.venues, a: world.current.activations, p: world.current.players })).toBe(before);
    expect(world.current.calls.every(([method]) => /^(list|get)/.test(method))).toBe(true);
  });
});
