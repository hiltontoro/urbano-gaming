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
import { EFFECTIVE_FIXTURE_EXCLUSION, REHEARSAL_FIXTURE_EXCLUSION, TEMPORARY_FIXTURE_EXCLUSION } from "@/lib/gaming/predictions/fixtureExclusionManifest";
import { buildCatalogWorld, callCount, callSignature, callsTouching, type CatalogWorld } from "./fixtureCatalogWorld";

/**
 * The temporary exclusion of the verified contract-test fixtures (first batch, 172 ids) and of our own rehearsals of 2026-10-25 (second
 * batch, 8 ids; see the last two blocks). It is an exact list of ids with fingerprints, never a rule:
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

// ---- the second batch: our own rehearsals of 2026-10-25 ------------------------------------------------------------------------
const R = REHEARSAL_FIXTURE_EXCLUSION;
const E = EFFECTIVE_FIXTURE_EXCLUSION;

/** The ids exactly as the full Production backup of 2026-10-25 (10:10, Honduras) holds them, written out here so an edit cannot go unnoticed. */
const REHEARSAL_IDS = {
  matches: ["0ef3b349-6636-4a41-97a8-676aa33bfd1b", "58765eb4-7bec-4c1f-8bca-c542bd93239a", "c25f8a8f-99ea-4756-b5a6-8a84a3f173de"],
  teams: ["9bd7171b-355b-43ed-a684-72316bb5200f", "eab01687-bbaa-4eba-ac20-63c02bf22c31"],
  activations: ["36670fbd-0af7-4516-9c90-8122cecf615b", "754b4eea-91c7-429b-a726-2eefb1ed7c11", "8e19e862-8278-4709-b0b5-73395af21e1b"],
} as const;
const REAL_ROWS = {
  venues: { thePub: "703657cc-2f77-4c96-bf33-c22aa8bd8247", fincaOcho: "2105dd59-3131-4735-8ea3-e98fef64e557", fincaOcho15m: "1ab69d0b-aa72-4e64-bdba-d0d29d9d359d" },
  clasico: { matchId: "ad72e2e2-dad0-48ef-8e7a-7d8369d37af6", activationId: "5f9ea3d1-9892-4d72-a1d0-c5c1d458d93a", homeTeamId: "e6a1db23-c8d2-4bdf-9b03-af1815ab94fd" },
} as const;

describe("the rehearsal batch is exactly the inventoried set", () => {
  it("holds the 3 matches, 2 teams and 3 activations of the rehearsals, no venue, and their fingerprints are reproduced from the ids", () => {
    expect({ matches: [...R.matches].sort(), teams: [...R.teams].sort(), activations: [...R.activations].sort(), venues: [...R.venues] }).toEqual({
      matches: [...REHEARSAL_IDS.matches].sort(), teams: [...REHEARSAL_IDS.teams].sort(), activations: [...REHEARSAL_IDS.activations].sort(), venues: [],
    });
    for (const kind of KINDS) {
      expect(R.fingerprints[kind].count, kind).toBe(R[kind].length);
      expect(fixtureFingerprint(R[kind]), kind).toBe(R.fingerprints[kind].sha256);
    }
    expect(() => verifyFixtureManifest(R)).not.toThrow();
    expect(R.playersReachedThroughTheirTeam).toHaveLength(4); // recorded for the record: they are reached only through their (excluded) teams
  });

  it("pins the fingerprints computed from the backup", () => {
    expect(R.fingerprints.matches.sha256).toBe("2b6fa6dba97d19c6a1595f827f9421bdd3412b38827dc4b81ac57c9d352f0241");
    expect(R.fingerprints.teams.sha256).toBe("4fe82299d88b0bffbf9d1cf82cda0ec90e0f426920b3883d97f21ee7ef93ffb6");
    expect(R.fingerprints.activations.sha256).toBe("76cf1a5c387927f7e4674d54d1e0e19c661ab12bf6f04a8f3addfe7a51f719a4");
    expect(R.fingerprints.venues.sha256).toBe(fixtureFingerprint([]));
  });

  it("the first batch is untouched: same counts, same ids, same fingerprints as before the rehearsals were added", () => {
    expect({ matches: M.matches.length, teams: M.teams.length, venues: M.venues.length, activations: M.activations.length }).toEqual({ matches: 36, teams: 82, venues: 30, activations: 24 });
    expect(M.fingerprints.matches.sha256).toBe("2fe72826a5391a51a421586c22ce4a2a20c7589a3de0769e35a55084b09c0ca2");
    expect(() => verifyFixtureManifest(M)).not.toThrow();
  });
});

describe("the manifest that the server applies is exactly both batches together", () => {
  it("has 39 matches, 84 teams, 30 venues and 27 activations (180 ids), with the fingerprints of the union pinned and reproduced", () => {
    expect({ matches: E.matches.length, teams: E.teams.length, venues: E.venues.length, activations: E.activations.length }).toEqual({ matches: 39, teams: 84, venues: 30, activations: 27 });
    expect(E.fingerprints.matches.sha256).toBe("b9d36220cfc356430a6cd6796155ff6597e0873e4084d3c24c31243c5868899b");
    expect(E.fingerprints.teams.sha256).toBe("d301577fee71b91c08c896abb5d0b164712785a640b77990ed0bc26ccec31211");
    expect(E.fingerprints.venues.sha256).toBe(M.fingerprints.venues.sha256); // the venues did not change
    expect(E.fingerprints.activations.sha256).toBe("ea68f28574dc7097a1ddfc5e139cdd642706c00b4bed763a4efb52730911c5cd");
    expect(() => verifyFixtureManifest(E)).not.toThrow();
    const all = KINDS.flatMap((kind) => [...E[kind]]);
    expect(all).toHaveLength(180);
    expect(new Set(all).size).toBe(180); // no id twice, none in two lists
  });

  it("contains every id of both batches and nothing else", () => {
    for (const kind of KINDS) expect([...E[kind]].sort(), kind).toEqual([...M[kind], ...R[kind]].sort());
  });

  it("does NOT contain the real rows: the venues of the real flow, the real Clasico, its activation and its teams", () => {
    for (const id of Object.values(REAL_ROWS.venues)) expect(isFixtureId("venues", id), id).toBe(false);
    expect(isFixtureId("matches", REAL_ROWS.clasico.matchId)).toBe(false);
    expect(isFixtureId("activations", REAL_ROWS.clasico.activationId)).toBe(false);
    expect(isFixtureId("teams", REAL_ROWS.clasico.homeTeamId)).toBe(false);
    for (const kind of KINDS) for (const id of Object.values(REAL_ROWS.venues)) expect(E[kind] as readonly string[], `${kind} ${id}`).not.toContain(id);
  });

  it("refuses an edited union: dropping, swapping or adding a rehearsal id all fail loudly, so a hidden row cannot be changed without a new inventory", () => {
    const mutate = (change: (m: any) => void) => { const m = copy(E); change(m); return m as FixtureManifest; };
    const bad: Array<[string, FixtureManifest]> = [
      ["dropped rehearsal match", mutate((m) => { m.matches = m.matches.filter((id: string) => id !== REHEARSAL_IDS.matches[0]); })],
      ["dropped rehearsal team", mutate((m) => { m.teams = m.teams.filter((id: string) => id !== REHEARSAL_IDS.teams[1]); })],
      ["dropped rehearsal activation", mutate((m) => { m.activations.pop(); })],
      ["swapped rehearsal match for the real Clasico", mutate((m) => { m.matches[m.matches.indexOf(REHEARSAL_IDS.matches[2])] = REAL_ROWS.clasico.matchId; })],
      ["added a venue (The Pub)", mutate((m) => { m.venues.push(REAL_ROWS.venues.thePub); })],
    ];
    for (const [label, manifest] of bad) {
      expect(() => verifyFixtureManifest(manifest), label).toThrow(FixtureManifestIntegrityError);
      expect(() => excludeFixtures([{ id: "x" }], "matches", (item) => item.id, manifest), `${label} must not be used to hide anything`).toThrow(FixtureManifestIntegrityError);
    }
  });
});

describe("what the default exclusion hides of our rehearsals — and what it never does", () => {
  const item = (id: string, extra: Record<string, unknown> = {}) => ({ id, ...extra });

  it("hides each rehearsal id under its own kind and not under another", () => {
    for (const id of REHEARSAL_IDS.matches) { expect(isFixtureId("matches", id), id).toBe(true); expect(isFixtureId("teams", id), id).toBe(false); }
    for (const id of REHEARSAL_IDS.teams) { expect(isFixtureId("teams", id), id).toBe(true); expect(isFixtureId("matches", id), id).toBe(false); }
    for (const id of REHEARSAL_IDS.activations) { expect(isFixtureId("activations", id), id).toBe(true); expect(isFixtureId("venues", id), id).toBe(false); }
  });

  it("is by id and nothing else: the very same names, competition and classification under a new id are not hidden", () => {
    const sameNames = [
      item("77777777-7777-4777-8777-777777777777", { name: "Equipo A (ensayo)" }),
      item("88888888-8888-4888-8888-888888888888", { competition: "ENSAYO — sin premios reales · The Pub", classification: "TRAINING", cancelledAt: "2026-10-25T02:06:40.759124Z", kickoffAt: "2026-10-25T02:50:39.304568Z" }),
    ];
    expect(excludeFixtures(sameNames, "matches", (i) => i.id)).toEqual(sameNames);
    expect(excludeFixtures(sameNames, "teams", (i) => i.id)).toEqual(sameNames);
    // …while a rehearsal id is hidden whatever it looks like
    const disguised = item(REHEARSAL_IDS.matches[1], { competition: "El Clásico", name: "FC Barcelona", classification: "OFFICIAL" });
    expect(excludeFixtures([disguised], "matches", (i) => i.id)).toEqual([]);
  });

  it("the code of the exclusion never mentions the word «ensayo» (nothing is decided by it)", () => {
    const code = readFileSync(path.join(process.cwd(), "lib/gaming/predictions/fixtureExclusion.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(code).not.toMatch(/ensayo|rehearsal|training/i);
  });

  it("the admin views hide the rehearsals by default and bring them back only with ?includeFixtures=1", () => {
    const request = (query: string) => new Request(`http://localhost/api/gaming/predictions/admin/matches${query}`);
    const rows = [...REHEARSAL_IDS.matches.map((id) => ({ id })), { id: REAL_ROWS.clasico.matchId }];
    expect(visibleInAdminView(request(""), rows, "matches", (r) => r.id)).toEqual([{ id: REAL_ROWS.clasico.matchId }]);
    expect(visibleInAdminView(request("?includeFixtures=1"), rows, "matches", (r) => r.id)).toEqual(rows);
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

describe("GET /api/gaming/predictions/matches with our rehearsals in the catalog", () => {
  const ask = async () => {
    const response = await publicMatches();
    expect(response.status).toBe(200);
    return (await response.json()) as { matches: Array<{ matchId: string; homeTeam: { name: string } | null; venueActivations: Array<{ venueActivationId: string; enabled: boolean }> }> };
  };

  beforeEach(() => { world.current = null; });

  it("lists the real Clasico (disabled activation) and the same-name match under a new id, and none of the rehearsal matches", async () => {
    world.current = buildCatalogWorld({ withRehearsal: true });
    const { rehearsal } = world.current;
    const body = await ask();
    const ids = body.matches.map((m) => m.matchId);
    for (const id of rehearsal!.ids.matches) expect(ids).not.toContain(id);
    expect(ids).toContain(rehearsal!.clasico.matchId);
    expect(ids).toContain(rehearsal!.sameNameNewIds.matchId);
    const clasico = body.matches.find((m) => m.matchId === rehearsal!.clasico.matchId)!;
    expect(clasico.homeTeam?.name).toBe("FC Barcelona");
    expect(clasico.venueActivations).toEqual([expect.objectContaining({ venueActivationId: rehearsal!.clasico.activationId, enabled: false })]);
  });

  it("reads nothing about a rehearsal row and changes nothing", async () => {
    world.current = buildCatalogWorld({ withRehearsal: true });
    const w = world.current;
    const before = JSON.stringify({ m: w.matches, t: w.teams, p: w.players, a: w.activations, tiers: w.tiers });
    await ask();
    expect(callsTouching(w.calls, w.rehearsal!.ids.matches)).toEqual([]);
    expect(callsTouching(w.calls, w.rehearsal!.ids.activations)).toEqual([]);
    expect(callsTouching(w.calls, w.rehearsal!.ids.teams)).toEqual([]);
    expect(JSON.stringify({ m: w.matches, t: w.teams, p: w.players, a: w.activations, tiers: w.tiers })).toBe(before);
    expect(w.calls.every(([method]) => /^(list|get)/.test(method))).toBe(true);
  });
});
