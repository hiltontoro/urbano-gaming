import { createHash } from "node:crypto";
import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mocks the ONE module boundary between a route and the outside world (credentials, repository construction, caller identity), exactly as
// competitions.test.ts does; statusForCompetitionsError and the schema-ready guard keep their REAL implementation.
vi.mock("@/lib/gaming/competitions/httpAuth", async () => {
  const actual = await vi.importActual<typeof import("../lib/gaming/competitions/httpAuth")>("../lib/gaming/competitions/httpAuth");
  return {
    getSupabaseCredentials: vi.fn(),
    buildCompetitionsRepo: vi.fn(),
    requireGamingMember: vi.fn(),
    statusForCompetitionsError: actual.statusForCompetitionsError,
    requireCompetitionsSchemaReady: actual.requireCompetitionsSchemaReady,
    isCompetitionsSchemaReady: actual.isCompetitionsSchemaReady,
    normalizeCompetitionsSchemaReady: actual.normalizeCompetitionsSchemaReady,
  };
});

import * as httpAuth from "../lib/gaming/competitions/httpAuth";
import { SupabaseCompetitionsRepository, translateError } from "../lib/gaming/competitions/db/supabaseCompetitionsRepository";
import { SOCCER_FORMAT_KEYS } from "../lib/gaming/competitions/formats";
import type { CompetitionDrawRecord } from "../lib/gaming/competitions/types";
import { CompetitionAccessDeniedError, CompetitionNotFoundError, HostAccessRevokedError } from "../lib/gaming/competitions/types";

/**
 * UG-CR-GATE-SSS-019 — the auditable four-team draw, application side.
 *
 * Every DECISION (who may draw, the lifecycle, the freeze, the pending plan change, the entropy, the one permanent draw, replay and conflict) is made inside
 * the one atomic database operation and is proved against a real database in competitionDrawSupabase.contract.test.ts. This file proves what the
 * application adds on top, and that it adds nothing it should not: the algorithm the database also implements (against an INDEPENDENT oracle — Python
 * hashlib and itertools computed every literal below, not this code), the digest and the reproduction of a draw from its stored evidence, the strict request
 * allowlist, the typed refusals and their stable codes, the bounded shapes a browser is shown, the routes' uniform non-enumerating answers, and the static
 * facts about the surface (no randomness source, no page control, no new format, one append-only migration).
 *
 * The modules under test are loaded lazily so that, before they exist, every test here fails for the behavior it is missing and not because the file could
 * not be collected.
 */

const loadDraw = () => import("../lib/gaming/competitions/draw");
const ROUTE = "../app/api/gaming/competitions/[competitionId]/draw/route";
type Ctx = { params: { competitionId: string } };
type Handler = (request: Request, context: Ctx) => Promise<Response>;
const loadRoute = () => import(/* @vite-ignore */ ROUTE) as Promise<Record<string, Handler | undefined>>;

const REPO_ROOT = path.resolve(__dirname, "..");
const read = (relative: string) => readFileSync(path.join(REPO_ROOT, relative), "utf8");
const sha = (text: string) => createHash("sha256").update(text, "utf8").digest("hex");
function walk(dir: string, accept: (file: string) => boolean): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full, accept));
    else if (accept(full)) out.push(full);
  }
  return out;
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The independent oracle. Every literal in this block was computed by Python (hashlib.sha256, itertools.permutations), from the specification in draw.ts's
// header: word(seed, c) = the first four bytes, big-endian, of SHA-256(seed bytes || c as four big-endian bytes); a word below 4294967280 gives index word mod 24.
// ---------------------------------------------------------------------------------------------------------------------------------------------

const SEED_VECTORS: Array<{ seed: string; word0: number; index: number }> = [
  { seed: "0000000000000000000000000000000000000000000000000000000000000000", word0: 1840668629, index: 5 },
  { seed: "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff", word0: 417982684, index: 4 },
  { seed: "0100000000000000000000000000000000000000000000000000000000000000", word0: 297537884, index: 20 },
  { seed: "abababababababababababababababababababababababababababababababab", word0: 1403299552, index: 16 },
  { seed: "80d4278cdeda8cd9f38395272d82bd1fc78b43433aff35c700cfb5903eeea6e7", word0: 2862083036, index: 20 },
  { seed: "fbf2d96ec0174ae3f2434b7181ad7469d94253cc305714e83c00fca12ed01263", word0: 1107983618, index: 2 },
  { seed: "3a04fbe99713e2e823645d331fbe9441c4c6bc84586a7f13e16a90f18cddcf68", word0: 2649533133, index: 21 },
  { seed: "67e02b61dafba7f44f6aa7cf10bc3466ee6cd05377148aa9803f129a742aed79", word0: 1103456211, index: 3 },
  { seed: "f8fd80ddce7f195fe672a0436af50ebe4fc496edbfc5b8ef06b9adc25cfa1153", word0: 3949706855, index: 23 },
  { seed: "bb20a42448d8143e6fc50b1a2ef420410048023e526bec2091adb0b326658846", word0: 703952750, index: 14 },
  { seed: "88ab9d555359ccd3c2e7b983e1c2cd73b749ec969b1b219bf58a9f940cf5fc1a", word0: 3764207070, index: 6 },
  { seed: "e83c92cebce954679d8ba433d789cc9743bfc06177220402a5ad8776fdb06c7f", word0: 2135698041, index: 9 },
];

/**
 * A seed whose FIRST sampled word is in the rejected band, found by an offline search (the smallest i such that the seed "00"*24 || i as eight big-endian
 * bytes has a counter-0 word >= 4294967280; i = 379723946). Counter 0 gives 4294967282 (rejected); counter 1 gives 270744965, so the index is 5
 * (lexicographic permutation [1, 4, 3, 2]). The only way to prove the rejection loop itself, end to end, rather than the boundary alone.
 */
const REJECTION_SEED = "0000000000000000000000000000000000000000000000000000000016a220aa";

/** word -> accepted index, or null for a rejected word (the boundary the sampling must have). */
const BOUNDARY: Array<[number, number | null]> = [
  [0, 0], [1, 1], [23, 23], [24, 0], [25, 1], [4294967255, 23], [4294967256, 0], [4294967278, 22], [4294967279, 23],
  [4294967280, null], [4294967281, null], [4294967295, null],
];

/** The index each of 24,000 seeds, sha256(String(g)) for g = 1..24000, draws; counted by Python. Chi-square against 1000 each: 24.466 (23 degrees of freedom). */
const UNIFORM_COUNTS = [965, 999, 985, 950, 1032, 997, 1003, 972, 1012, 970, 1002, 1017, 977, 997, 1054, 987, 945, 1046, 1054, 1058, 1016, 986, 960, 1016];

/** itertools.permutations([1, 2, 3, 4]), in the order it yields them (lexicographic). */
const LEXICOGRAPHIC: number[][] = [
  [1, 2, 3, 4], [1, 2, 4, 3], [1, 3, 2, 4], [1, 3, 4, 2], [1, 4, 2, 3], [1, 4, 3, 2],
  [2, 1, 3, 4], [2, 1, 4, 3], [2, 3, 1, 4], [2, 3, 4, 1], [2, 4, 1, 3], [2, 4, 3, 1],
  [3, 1, 2, 4], [3, 1, 4, 2], [3, 2, 1, 4], [3, 2, 4, 1], [3, 4, 1, 2], [3, 4, 2, 1],
  [4, 1, 2, 3], [4, 1, 3, 2], [4, 2, 1, 3], [4, 2, 3, 1], [4, 3, 1, 2], [4, 3, 2, 1],
];

const CID = "11111111-1111-4111-8111-111111111111";
const TEAMS = [
  "1b0a7c5e-3d24-4c1f-9a53-0e8d2f6b7a01", "3f9d2a10-7b6e-4d85-8c42-5a1e9b0c3d02",
  "8c41e7d9-0a35-4b6f-a1d8-2c7e5f9b4a03", "d2e6b8f1-5c97-4a30-b4e2-9f1a6d8c0b04",
];
const NAMES = ["Rayo FC", "Los Halcones", "Tigres 5", "Deportivo Sur"];
const FREEZE_DIGEST = sha("freeze");
const KAT_SEED = SEED_VECTORS[3].seed; // index 16 -> lexicographic [3, 4, 1, 2]
const KAT_INDEX = 16;
/** SHA-256 of the canonical text below, computed by Python. */
const KAT_DIGEST = "6e8a187d5973a87a226f04d4a2758a073f472463c25efcf935c7c81cbc9aa6b8";
const KAT_TEXT = [
  "URBANO-COMPETITION-DRAW-V1",
  `competition:${CID}`,
  `freeze-digest:${FREEZE_DIGEST}`,
  "algorithm:URBANO-DRAW-PERMUTATION-V1",
  `seed:${KAT_SEED}`,
  `index:${KAT_INDEX}`,
  `input:${TEAMS.join(",")}`,
  `order:${[TEAMS[2], TEAMS[3], TEAMS[0], TEAMS[1]].join(",")}`,
].join("\n");

const ORGANIZER = "00000000-0000-4000-8000-0000000000a1";
const CAPTAIN = "00000000-0000-4000-8000-0000000000c1";
const SCOREKEEPER = "00000000-0000-4000-8000-0000000000e1";
const REGISTRANT = "00000000-0000-4000-8000-0000000000f1";
const OPERATIONAL = "00000000-0000-4000-8000-0000000000b1";
const STRANGER = "00000000-0000-4000-8000-0000000000d9";
const INTENT = "33333333-3333-4333-8333-333333333333";
const OTHER_INTENT = "44444444-4444-4444-8444-444444444444";

/** The stored evidence of the known-answer draw, assembled from literals (not from the code under test). */
function katRecord(over: Partial<CompetitionDrawRecord> = {}): CompetitionDrawRecord {
  const input = TEAMS.map((teamId, i) => ({ inputPosition: i + 1, teamId, teamName: NAMES[i] }));
  const positions = LEXICOGRAPHIC[KAT_INDEX]; // [3, 4, 1, 2]
  const order = positions.map((p, i) => ({ drawPosition: i + 1, inputPosition: p, teamId: TEAMS[p - 1], teamName: NAMES[p - 1] }));
  return {
    algorithm: "URBANO-DRAW-PERMUTATION-V1", drawnAt: "2026-11-03T08:15:00.123456Z", seed: KAT_SEED, permutationIndex: KAT_INDEX,
    freezeDigest: FREEZE_DIGEST, drawDigest: KAT_DIGEST, input, order, ...over,
  };
}

/** The same evidence as the database returns it. */
function rawEvidence(): Record<string, unknown> {
  const r = katRecord();
  return {
    algorithm: r.algorithm, drawn_at: r.drawnAt, seed: r.seed, permutation_index: r.permutationIndex, freeze_digest: r.freezeDigest, draw_digest: r.drawDigest,
    input: r.input.map((t) => ({ input_position: t.inputPosition, team_id: t.teamId, team_name: t.teamName })),
    order: r.order.map((t) => ({ draw_position: t.drawPosition, input_position: t.inputPosition, team_id: t.teamId, team_name: t.teamName })),
  };
}

// ---------------------------------------------------------------------------------------------------------------------------------------------
// [15][16] Sampling
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("[16] sampling: 32-bit words, rejection of the last sixteen values, and never a modulo of the whole range", () => {
  it("the rejection limit is the largest multiple of 24 not above 2^32, so every index is exactly equally likely", async () => {
    const { DRAW_WORD_LIMIT, DRAW_PERMUTATION_COUNT } = await loadDraw();
    expect(DRAW_PERMUTATION_COUNT).toBe(24);
    expect(DRAW_WORD_LIMIT).toBe(4294967280);
    expect(DRAW_WORD_LIMIT).toBe(Math.floor(2 ** 32 / 24) * 24);
    expect(DRAW_WORD_LIMIT % 24).toBe(0);
    expect(2 ** 32 - DRAW_WORD_LIMIT).toBe(16);
  });

  it.each(BOUNDARY)("acceptDrawWord(%i) is %s — the boundary an independent implementation gives", async (word, expected) => {
    const { acceptDrawWord } = await loadDraw();
    expect(acceptDrawWord(word)).toBe(expected);
  });

  it("refuses a word that is not a 32-bit unsigned integer (it never reduces, rounds or wraps one)", async () => {
    const { acceptDrawWord } = await loadDraw();
    for (const bad of [-1, 4294967296, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "5" as unknown as number, null as unknown as number]) {
      expect(() => acceptDrawWord(bad), String(bad)).toThrow(RangeError);
    }
  });

  it.each(SEED_VECTORS.map((v, i) => [i, v] as const))("vector %i: the counter-0 word and the drawn index equal what an independent implementation computed", async (_i, vector) => {
    const { drawWord, permutationIndexFromSeed } = await loadDraw();
    expect(drawWord(vector.seed, 0)).toBe(vector.word0);
    expect(permutationIndexFromSeed(vector.seed)).toBe(vector.index);
  });

  it("[16] a rejected first word advances the counter: the pinned seed's counter-0 word is rejected and counter 1 decides, giving index 5", async () => {
    const { drawWord, acceptDrawWord, permutationIndexFromSeed } = await loadDraw();
    expect(drawWord(REJECTION_SEED, 0)).toBe(4294967282);
    expect(acceptDrawWord(drawWord(REJECTION_SEED, 0))).toBeNull();
    expect(drawWord(REJECTION_SEED, 1)).toBe(270744965);
    expect(permutationIndexFromSeed(REJECTION_SEED)).toBe(5);
    // Not simply "word mod 24 of the first word" (the biased shortcut): 4294967282 mod 24 is 2, the answer is 5.
    expect(4294967282 % 24).toBe(2);
  });

  it("refuses a malformed seed and a counter outside 0..63; the loop is bounded", async () => {
    const { drawWord, permutationIndexFromSeed, DRAW_MAX_ATTEMPTS } = await loadDraw();
    expect(DRAW_MAX_ATTEMPTS).toBe(64);
    const good = SEED_VECTORS[0].seed;
    for (const seed of ["", "abc", good.toUpperCase().replace(/0/g, "A"), good.slice(1), `${good}0`, good.replace(/^0/, "g"), 5 as unknown as string, null as unknown as string]) {
      expect(() => drawWord(seed, 0), String(seed)).toThrow();
      expect(() => permutationIndexFromSeed(seed), String(seed)).toThrow();
    }
    for (const counter of [-1, 64, 1.5, Number.NaN]) expect(() => drawWord(good, counter), String(counter)).toThrow();
    expect(() => drawWord(good, 63)).not.toThrow();
  });

  it("[15] over 24,000 deterministic seeds every one of the 24 indexes occurs, with exactly the counts an independent implementation gives, and a chi-square far inside the limit", async () => {
    const { permutationIndexFromSeed } = await loadDraw();
    const counts = new Array(24).fill(0);
    for (let g = 1; g <= 24000; g++) counts[permutationIndexFromSeed(sha(String(g)))] += 1;
    expect(counts).toEqual(UNIFORM_COUNTS);
    expect(counts.every((c) => c > 0)).toBe(true);
    const chiSquare = counts.reduce((sum, c) => sum + (c - 1000) ** 2 / 1000, 0);
    expect(chiSquare).toBeLessThan(58.3); // the p = 1e-6 critical value for 23 degrees of freedom
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// [15] The permutation
// ---------------------------------------------------------------------------------------------------------------------------------------------

/** Every ordering of the items, lexicographically — written here, independently of the code under test. */
function allOrders<T>(items: T[]): T[][] {
  if (items.length <= 1) return [items.slice()];
  const out: T[][] = [];
  items.forEach((item, i) => {
    for (const rest of allOrders(items.filter((_, j) => j !== i))) out.push([item, ...rest]);
  });
  return out;
}

describe("[15] the permutation: factorial decoding is a bijection onto all 24 orders", () => {
  it("index i is the i-th permutation in lexicographic order, for all 24 (Python's itertools and a separate recursive oracle agree with it)", async () => {
    const { permuteTeams } = await loadDraw();
    expect(allOrders([1, 2, 3, 4])).toEqual(LEXICOGRAPHIC);
    for (let i = 0; i < 24; i++) expect(permuteTeams([1, 2, 3, 4], i), `index ${i}`).toEqual(LEXICOGRAPHIC[i]);
  });

  it("the 24 indexes give 24 distinct, valid orders: every possible order is reachable and none repeats", async () => {
    const { permuteTeams } = await loadDraw();
    const seen = new Set<string>();
    for (let i = 0; i < 24; i++) {
      const order = permuteTeams(TEAMS, i);
      expect(new Set(order).size, `index ${i} repeats or drops a team`).toBe(4);
      expect([...order].sort(), `index ${i}`).toEqual([...TEAMS].sort());
      seen.add(order.join(","));
    }
    expect(seen.size).toBe(24);
    expect(seen).toEqual(new Set(allOrders(TEAMS).map((o) => o.join(","))));
  });

  it("works on identifiers as it does on positions (the team ids are only labels)", async () => {
    const { permuteTeams } = await loadDraw();
    for (let i = 0; i < 24; i++) expect(permuteTeams(TEAMS, i)).toEqual(LEXICOGRAPHIC[i].map((p) => TEAMS[p - 1]));
  });

  it("refuses an index that is not a whole number from 0 to 23, and anything but exactly four distinct teams", async () => {
    const { permuteTeams } = await loadDraw();
    for (const index of [-1, 24, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "3" as unknown as number]) expect(() => permuteTeams(TEAMS, index), String(index)).toThrow(RangeError);
    expect(() => permuteTeams(TEAMS.slice(0, 3), 0)).toThrow();
    expect(() => permuteTeams([...TEAMS, "extra"], 0)).toThrow();
    expect(() => permuteTeams([TEAMS[0], TEAMS[0], TEAMS[1], TEAMS[2]], 0)).toThrow();
  });

  it("does not modify the list it is given", async () => {
    const { permuteTeams } = await loadDraw();
    const input = [...TEAMS];
    permuteTeams(input, 17);
    expect(input).toEqual(TEAMS);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// [17] Canonical input order
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("[17] canonical input order: the frozen teams in byte order of their identifiers, whatever order they arrive in", () => {
  it("gives one order for every arrival order", async () => {
    const { canonicalTeamOrder } = await loadDraw();
    for (const arrival of allOrders([...TEAMS])) expect(canonicalTeamOrder(arrival)).toEqual(TEAMS);
  });

  it("compares bytes, not locale rules or the order of arrival, and treats the letters of an identifier as lowercase", async () => {
    const { canonicalTeamOrder } = await loadDraw();
    expect(canonicalTeamOrder([TEAMS[3].toUpperCase(), TEAMS[0], TEAMS[2], TEAMS[1].toUpperCase()])).toEqual(TEAMS);
  });

  it("refuses a duplicate, a malformed identifier, and anything but four teams", async () => {
    const { canonicalTeamOrder } = await loadDraw();
    expect(() => canonicalTeamOrder([TEAMS[0], TEAMS[0], TEAMS[1], TEAMS[2]])).toThrow();
    expect(() => canonicalTeamOrder([TEAMS[0], TEAMS[1], TEAMS[2], "not-a-uuid"])).toThrow();
    expect(() => canonicalTeamOrder(TEAMS.slice(0, 3))).toThrow();
    expect(() => canonicalTeamOrder([...TEAMS, "5a5a5a5a-5a5a-45a5-85a5-5a5a5a5a5a05"])).toThrow();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// [14][15][16][18] Pairing
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("[14][15][16][18] pairing: positions 1–2 are Semifinal 1, positions 3–4 are Semifinal 2 — a bracket slot, never a rank", () => {
  it("derives exactly two semifinals, in that order, from a drawn order", async () => {
    const { deriveSemifinals } = await loadDraw();
    const semifinals = deriveSemifinals(["P1", "P2", "P3", "P4"]);
    expect(semifinals).toEqual([
      { fixtureRole: "SEMIFINAL_1", teamA: "P1", teamB: "P2" },
      { fixtureRole: "SEMIFINAL_2", teamA: "P3", teamB: "P4" },
    ]);
  });

  it("every team plays exactly once and nobody meets themself, for every one of the 24 orders", async () => {
    const { deriveSemifinals, permuteTeams } = await loadDraw();
    for (let i = 0; i < 24; i++) {
      const semifinals = deriveSemifinals(permuteTeams(TEAMS, i));
      const players = semifinals.flatMap((s) => [s.teamA, s.teamB]);
      expect(players, `index ${i}`).toHaveLength(4);
      expect(new Set(players).size, `index ${i}`).toBe(4);
      expect([...players].sort()).toEqual([...TEAMS].sort());
      for (const s of semifinals) expect(s.teamA).not.toBe(s.teamB);
    }
  });

  it("the three possible pairings of four teams are each produced by exactly 8 of the 24 orders (no pairing is favoured)", async () => {
    const { deriveSemifinals, permuteTeams } = await loadDraw();
    const tally = new Map<string, number>();
    for (let i = 0; i < 24; i++) {
      const [a, b] = deriveSemifinals(permuteTeams(TEAMS, i)).map((s) => [s.teamA, s.teamB].sort().join("+"));
      const key = [a, b].sort().join(" | ");
      tally.set(key, (tally.get(key) ?? 0) + 1);
    }
    expect(tally.size).toBe(3);
    expect([...tally.values()]).toEqual([8, 8, 8]);
  });

  it("carries nothing that could be read as a ranking, a seeding, a priority or a schedule", async () => {
    const { deriveSemifinals } = await loadDraw();
    const semifinals = deriveSemifinals(["P1", "P2", "P3", "P4"]);
    for (const s of semifinals) expect(Object.keys(s).sort()).toEqual(["fixtureRole", "teamA", "teamB"]);
    expect(JSON.stringify(semifinals)).not.toMatch(/rank|seed|priority|schedul|time|date|pitch|venue|score/i);
  });

  it("refuses anything but four teams", async () => {
    const { deriveSemifinals } = await loadDraw();
    expect(() => deriveSemifinals(["P1", "P2", "P3"])).toThrow();
    expect(() => deriveSemifinals(["P1", "P2", "P3", "P4", "P5"])).toThrow();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// [19][20] The digest, reproduction from stored evidence, tamper detection
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("[19][20] the digest and the reproduction of a draw from its stored evidence", () => {
  const digestInput = (over: Record<string, unknown> = {}) => ({
    competitionId: CID, freezeDigest: FREEZE_DIGEST, seed: KAT_SEED, permutationIndex: KAT_INDEX,
    inputTeamIds: [...TEAMS], orderTeamIds: [TEAMS[2], TEAMS[3], TEAMS[0], TEAMS[1]], ...over,
  });

  it("the known-answer text hashes to the known answer (the pin does not depend on the code under test)", () => {
    expect(sha(KAT_TEXT)).toBe(KAT_DIGEST);
  });

  it("computeDrawDigest matches the independently computed known answer", async () => {
    const { computeDrawDigest, DRAW_DIGEST_VERSION, DRAW_ALGORITHM_VERSION } = await loadDraw();
    expect(DRAW_DIGEST_VERSION).toBe("URBANO-COMPETITION-DRAW-V1");
    expect(DRAW_ALGORITHM_VERSION).toBe("URBANO-DRAW-PERMUTATION-V1");
    expect(computeDrawDigest(digestInput())).toBe(KAT_DIGEST);
  });

  it("changes when any one bound fact changes", async () => {
    const { computeDrawDigest } = await loadDraw();
    const swapped = [TEAMS[3], TEAMS[2], TEAMS[0], TEAMS[1]];
    const mutations: Array<[string, Record<string, unknown>]> = [
      ["competition", { competitionId: "11111111-1111-4111-8111-111111111112" }],
      ["freeze digest", { freezeDigest: sha("another freeze") }],
      ["seed", { seed: SEED_VECTORS[4].seed }],
      ["index", { permutationIndex: 17 }],
      ["input order", { inputTeamIds: [TEAMS[1], TEAMS[0], TEAMS[2], TEAMS[3]] }],
      ["drawn order", { orderTeamIds: swapped }],
    ];
    const answers = new Set<string>([KAT_DIGEST]);
    for (const [label, over] of mutations) {
      const digest = computeDrawDigest(digestInput(over));
      expect(digest, label).toMatch(/^[0-9a-f]{64}$/);
      expect(digest, label).not.toBe(KAT_DIGEST);
      answers.add(digest);
    }
    expect(answers.size).toBe(mutations.length + 1);
  });

  it("verifyDraw reproduces the index, the order and the digest from the stored evidence alone, and accepts a genuine draw", async () => {
    const { verifyDraw } = await loadDraw();
    expect(verifyDraw(CID, katRecord())).toEqual({ ok: true });
    for (const vector of SEED_VECTORS) {
      const { permutationIndexFromSeed, permuteTeams, computeDrawDigest } = await loadDraw();
      const index = permutationIndexFromSeed(vector.seed);
      const orderIds = permuteTeams(TEAMS, index);
      const record = katRecord({
        seed: vector.seed, permutationIndex: index,
        order: orderIds.map((teamId, i) => ({ drawPosition: i + 1, inputPosition: TEAMS.indexOf(teamId) + 1, teamId, teamName: NAMES[TEAMS.indexOf(teamId)] })),
        drawDigest: computeDrawDigest({ competitionId: CID, freezeDigest: FREEZE_DIGEST, seed: vector.seed, permutationIndex: index, inputTeamIds: TEAMS, orderTeamIds: orderIds }),
      });
      expect(verifyDraw(CID, record), vector.seed).toEqual({ ok: true });
    }
  });

  const swap = <T,>(list: T[], a: number, b: number) => { const copy = [...list]; [copy[a], copy[b]] = [copy[b], copy[a]]; return copy; };
  const TAMPERED: Array<[string, (r: CompetitionDrawRecord) => CompetitionDrawRecord]> = [
    ["a different seed (the index no longer follows from it)", (r) => ({ ...r, seed: SEED_VECTORS[0].seed })],
    ["a different permutation index", (r) => ({ ...r, permutationIndex: 17 })],
    ["two teams swapped in the drawn order", (r) => ({ ...r, order: swap(r.order, 0, 1).map((t, i) => ({ ...t, drawPosition: i + 1 })) })],
    ["the drawn order replaced by the input order", (r) => ({ ...r, order: r.input.map((t, i) => ({ drawPosition: i + 1, inputPosition: t.inputPosition, teamId: t.teamId, teamName: t.teamName })) })],
    ["the input order changed", (r) => ({ ...r, input: swap(r.input, 0, 3).map((t, i) => ({ ...t, inputPosition: i + 1 })) })],
    ["a team replaced by an outsider", (r) => ({ ...r, order: r.order.map((t, i) => (i === 2 ? { ...t, teamId: "5a5a5a5a-5a5a-45a5-85a5-5a5a5a5a5a05" } : t)) })],
    ["a team drawn twice", (r) => ({ ...r, order: r.order.map((t, i) => (i === 3 ? { ...r.order[0], drawPosition: 4 } : t)) })],
    ["only three teams", (r) => ({ ...r, order: r.order.slice(0, 3), input: r.input.slice(0, 3) })],
    ["five teams", (r) => ({ ...r, order: [...r.order, { ...r.order[0], drawPosition: 5 }] })],
    ["a stale draw digest", (r) => ({ ...r, drawDigest: sha("stale") })],
    ["a draw digest that is not a digest", (r) => ({ ...r, drawDigest: "not-a-digest" })],
    ["a different freeze digest", (r) => ({ ...r, freezeDigest: sha("another freeze") })],
    ["an unknown algorithm version", (r) => ({ ...r, algorithm: "URBANO-DRAW-PERMUTATION-V0" })],
    ["a seed that is not 64 lowercase hexadecimal digits", (r) => ({ ...r, seed: r.seed.toUpperCase() })],
    ["a position label that does not match the position", (r) => ({ ...r, order: r.order.map((t, i) => (i === 0 ? { ...t, drawPosition: 2 } : t)) })],
  ];

  it.each(TAMPERED)("detects tampering: %s", async (_label, tamper) => {
    const { verifyDraw } = await loadDraw();
    const result = verifyDraw(CID, tamper(katRecord()));
    expect(result.ok).toBe(false);
    expect((result as { reason: string }).reason).toEqual(expect.any(String));
  });

  it("detects the same evidence presented for another competition (the digest binds the competition)", async () => {
    const { verifyDraw } = await loadDraw();
    expect(verifyDraw("11111111-1111-4111-8111-111111111112", katRecord()).ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// [1][9] The request
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("[1] the request: exactly a draw identifier, and nothing a client could use to influence the draw", () => {
  const FORBIDDEN = [
    "seed", "teams", "teamIds", "order", "drawOrder", "pairing", "pairings", "format", "formatKey", "organizerGamingMemberId", "organizerId", "gamingMemberId",
    "memberId", "actor", "reroll", "redraw", "permutationIndex", "algorithm", "freezeDigest", "drawDigest", "competitionId",
  ];

  it("accepts exactly { intentId } with a UUID, and returns it", async () => {
    const { parseDrawRequest } = await loadDraw();
    expect(parseDrawRequest({ intentId: INTENT })).toEqual({ intentId: INTENT });
    expect(parseDrawRequest({ intentId: INTENT.toUpperCase() }).intentId.toLowerCase()).toBe(INTENT);
  });

  it.each(FORBIDDEN)("rejects %s by name, as a field the server alone decides, even beside a valid identifier", async (field) => {
    const { parseDrawRequest, CompetitionDrawValidationError } = await loadDraw();
    let caught: unknown = null;
    try { parseDrawRequest({ intentId: INTENT, [field]: field === "reroll" || field === "redraw" ? true : "x" }); } catch (err) { caught = err; }
    expect(caught).toBeInstanceOf(CompetitionDrawValidationError);
    const violations = (caught as { violations: Array<{ field: string; code: string }> }).violations;
    expect(violations).toEqual([expect.objectContaining({ field, code: "FORBIDDEN_FIELD" })]);
  });

  it("rejects any other field as unknown, including a prototype key", async () => {
    const { parseDrawRequest, CompetitionDrawValidationError } = await loadDraw();
    for (const body of [{ intentId: INTENT, note: "hello" }, JSON.parse(`{"intentId":"${INTENT}","__proto__":{"seed":"x"}}`)]) {
      let caught: unknown = null;
      try { parseDrawRequest(body); } catch (err) { caught = err; }
      expect(caught).toBeInstanceOf(CompetitionDrawValidationError);
      expect((caught as { violations: Array<{ code: string }> }).violations.map((v) => v.code)).toEqual(["UNKNOWN_FIELD"]);
    }
  });

  it("requires a UUID identifier, and a plain object", async () => {
    const { parseDrawRequest, CompetitionDrawValidationError } = await loadDraw();
    const bodies: unknown[] = [{}, { intentId: "" }, { intentId: "not-a-uuid" }, { intentId: 5 }, { intentId: null }, { intentId: [INTENT] }, { intentId: `${INTENT}x` }, [], [{ intentId: INTENT }], null, "intent", 7, true];
    for (const body of bodies) {
      let caught: unknown = null;
      try { parseDrawRequest(body); } catch (err) { caught = err; }
      expect(caught, JSON.stringify(body)).toBeInstanceOf(CompetitionDrawValidationError);
    }
  });

  it("lists every problem at once", async () => {
    const { parseDrawRequest } = await loadDraw();
    let caught: unknown = null;
    try { parseDrawRequest({ seed: "x", teams: [], note: 1 }); } catch (err) { caught = err; }
    expect((caught as { violations: Array<{ field: string; code: string }> }).violations.map((v) => `${v.field}:${v.code}`).sort())
      .toEqual(["intentId:INTENT_INVALID", "note:UNKNOWN_FIELD", "seed:FORBIDDEN_FIELD", "teams:FORBIDDEN_FIELD"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// Refusals
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("[5][6][10][13] the database's refusals become typed errors with stable codes and bounded wording", () => {
  const CODES: Array<[string, string]> = [
    ["COMPETITION_DRAW_WRONG_STATE", "WRONG_STATE"],
    ["COMPETITION_DRAW_FREEZE_REQUIRED", "FREEZE_REQUIRED"],
    ["COMPETITION_DRAW_FREEZE_INCONSISTENT", "FREEZE_INCONSISTENT"],
    ["COMPETITION_DRAW_AMENDMENT_PENDING", "AMENDMENT_PENDING"],
    ["COMPETITION_DRAW_ALREADY_DRAWN", "ALREADY_DRAWN"],
  ];

  it.each(CODES)("%s becomes the %s refusal, through drawErrorFromDatabase and through the repository's own translation", async (databaseCode, code) => {
    const { drawErrorFromDatabase, CompetitionDrawError } = await loadDraw();
    const raw = `${databaseCode}: some words of the database 7f3a9c52-0000-4000-8000-000000000001`;
    const direct = drawErrorFromDatabase(raw);
    expect(direct).toBeInstanceOf(CompetitionDrawError);
    expect(direct!.code).toBe(code);
    const viaRepository = translateError({ code: "P0001", message: raw });
    expect(viaRepository).toBeInstanceOf(CompetitionDrawError);
    expect((viaRepository as unknown as { code: string }).code).toBe(code);
    // Only the application's own wording ever reaches a browser: no database words, no identifier.
    for (const error of [direct!, viaRepository]) {
      expect(error.message.length).toBeLessThan(200);
      expect(error.message).not.toMatch(/COMPETITION_DRAW|database|7f3a9c52|P0001|sql|postgres/i);
    }
  });

  it("an error that is not one of the draw's is not claimed by it (null), and the draw's codes do not shadow the existing ones", async () => {
    const { drawErrorFromDatabase } = await loadDraw();
    for (const message of ["", "COMPETITION_NOT_FOUND: no such competition exists", "HOST_ACCESS_REVOKED: gone", "PLAN_AMENDMENT_STALE: x", "something else"]) {
      expect(drawErrorFromDatabase(message), message).toBeNull();
    }
    expect(translateError({ code: "P0001", message: "COMPETITION_NOT_FOUND: no such competition exists" })).toBeInstanceOf(CompetitionNotFoundError);
    expect(translateError({ code: "P0001", message: "COMPETITION_ACCESS_DENIED: no" })).toBeInstanceOf(CompetitionAccessDeniedError);
    expect(translateError({ code: "P0001", message: "HOST_ACCESS_REVOKED: no" })).toBeInstanceOf(HostAccessRevokedError);
  });

  it("drawFailure: invalid input is 400 with every problem; everything the caller has no part in is the same 404; every other typed refusal is a 409 with its code", async () => {
    const { drawFailure, parseDrawRequest, CompetitionDrawNotAvailableError, drawErrorFromDatabase, DRAW_NOT_FOUND_MESSAGE } = await loadDraw();
    let validation: unknown = null;
    try { parseDrawRequest({}); } catch (err) { validation = err; }
    expect(drawFailure(validation)).toEqual({ status: 400, body: expect.objectContaining({ problems: expect.any(Array) }) });
    const notFound = [new CompetitionDrawNotAvailableError(), new CompetitionNotFoundError(), new CompetitionAccessDeniedError("x"), new HostAccessRevokedError()].map(drawFailure);
    for (const failure of notFound) expect(failure).toEqual({ status: 404, body: { error: DRAW_NOT_FOUND_MESSAGE } });
    for (const [databaseCode, code] of CODES) {
      const failure = drawFailure(drawErrorFromDatabase(`${databaseCode}: x`));
      expect(failure!.status).toBe(409);
      expect(failure!.body).toEqual({ error: expect.any(String), code });
    }
    expect(drawFailure(new Error("boom"))).toBeNull();
  });

  it("the not-found wording names nothing: not the competition, the state, the roles, the draw or whether anything exists", async () => {
    const { DRAW_NOT_FOUND_MESSAGE } = await loadDraw();
    expect(DRAW_NOT_FOUND_MESSAGE).not.toMatch(/organizer|captain|state|ready|freeze|frozen|revoked|host|seed|team|exists|already/i);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// [22] What the database returns, and what a browser may see
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("[22] the stored evidence as the application reads it, and as a browser may see it", () => {
  it("reads the database's evidence into the application's shape, copying by name (no identifier of a member, intent or freeze can come through)", async () => {
    const { drawRecordFromDatabase } = await loadDraw();
    const raw = { ...rawEvidence(), drawn_by_gaming_member_id: ORGANIZER, intent_id: INTENT, registration_freeze_id: CID, competition_id: CID, competition_draw_id: CID };
    const record = drawRecordFromDatabase(raw);
    expect(record).toEqual(katRecord());
    expect(JSON.stringify(record)).not.toMatch(new RegExp(`${ORGANIZER}|${INTENT}`));
  });

  it("refuses any evidence that is not exactly the expected shape: it never guesses", async () => {
    const { drawRecordFromDatabase } = await loadDraw();
    const mutate = (fn: (r: Record<string, any>) => void) => { const r = rawEvidence() as Record<string, any>; fn(r); return r; };
    const broken: Array<[string, unknown]> = [
      ["null", null], ["a string", "evidence"], ["an array", []],
      ["no seed", mutate((r) => { delete r.seed; })],
      ["a numeric seed", mutate((r) => { r.seed = 5; })],
      ["no index", mutate((r) => { delete r.permutation_index; })],
      ["a fractional index", mutate((r) => { r.permutation_index = 1.5; })],
      ["three input teams", mutate((r) => { r.input = r.input.slice(0, 3); })],
      ["five ordered teams", mutate((r) => { r.order = [...r.order, r.order[0]]; })],
      ["a team without a name", mutate((r) => { delete r.order[0].team_name; })],
      ["a position of 0", mutate((r) => { r.order[0].draw_position = 0; })],
      ["a position of 5", mutate((r) => { r.input[0].input_position = 5; })],
      ["a missing draw time", mutate((r) => { delete r.drawn_at; })],
    ];
    for (const [label, raw] of broken) expect(() => drawRecordFromDatabase(raw), label).toThrow();
  });

  it("a browser is shown exactly the bounded fields — evidence, the order and the two semifinals — copied by name", async () => {
    const { publicDraw } = await loadDraw();
    const record = { ...katRecord(), drawnByGamingMemberId: ORGANIZER, intentId: INTENT, registrationFreezeId: CID } as unknown as CompetitionDrawRecord;
    const shown = publicDraw(record);
    expect(Object.keys(shown).sort()).toEqual(["algorithm", "drawDigest", "drawnAt", "freezeDigest", "inputOrder", "permutationIndex", "seed", "semifinals", "teams"]);
    expect(shown.teams.map((t) => t.drawPosition)).toEqual([1, 2, 3, 4]);
    expect(shown.teams.map((t) => t.teamId)).toEqual([TEAMS[2], TEAMS[3], TEAMS[0], TEAMS[1]]);
    expect(shown.semifinals).toEqual([
      { fixtureRole: "SEMIFINAL_1", teamA: { drawPosition: 1, teamId: TEAMS[2], teamName: NAMES[2] }, teamB: { drawPosition: 2, teamId: TEAMS[3], teamName: NAMES[3] } },
      { fixtureRole: "SEMIFINAL_2", teamA: { drawPosition: 3, teamId: TEAMS[0], teamName: NAMES[0] }, teamB: { drawPosition: 4, teamId: TEAMS[1], teamName: NAMES[1] } },
    ]);
    const text = JSON.stringify(shown);
    expect(text).not.toMatch(new RegExp(`${ORGANIZER}|${INTENT}`));
    expect(text).not.toMatch(/intent|organizer|actor|captain|member|capabilit|application|schedul|pitch|venue|fixture(?!Role)/i);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The commands
// ---------------------------------------------------------------------------------------------------------------------------------------------

function competition(over: Record<string, unknown> = {}) {
  return { competitionId: CID, organizerGamingMemberId: ORGANIZER, state: "READY_TO_PUBLISH", hostBound: false, hostAccessRevoked: false, ...over };
}
function makeRepo() {
  return {
    getCompetitionById: vi.fn(async (id: string) => (id === CID ? competition() : null)),
    createCompetitionDraw: vi.fn(async () => ({ draw: katRecord(), alreadyDrawn: false })),
    getCompetitionDraw: vi.fn(async () => ({ draw: katRecord() }) as { draw: CompetitionDrawRecord | null } | null),
  };
}

describe("[2][3][4] the command: only the active organizer reaches the database; everyone else is told nothing", () => {
  it("[2] the organizer's request reaches the store with the verified caller and the identifier, and the result comes back unchanged", async () => {
    const { createCompetitionDraw } = await loadDraw();
    const repo = makeRepo();
    const result = await createCompetitionDraw(repo as never, CID, ORGANIZER, INTENT);
    expect(result).toEqual({ draw: katRecord(), alreadyDrawn: false });
    expect(repo.createCompetitionDraw).toHaveBeenCalledTimes(1);
    expect(repo.createCompetitionDraw).toHaveBeenCalledWith(CID, ORGANIZER, INTENT);
  });

  it.each([["a frozen captain", CAPTAIN], ["a scorekeeper", SCOREKEEPER], ["an ordinary registrant", REGISTRANT], ["a member holding only OPERATIONAL authority", OPERATIONAL], ["a stranger", STRANGER]])(
    "[4] %s is told the one uniform not-available, and the database is never asked", async (_label, caller) => {
      const { createCompetitionDraw, CompetitionDrawNotAvailableError } = await loadDraw();
      const repo = makeRepo();
      await expect(createCompetitionDraw(repo as never, CID, caller, INTENT)).rejects.toBeInstanceOf(CompetitionDrawNotAvailableError);
      expect(repo.createCompetitionDraw).not.toHaveBeenCalled();
    });

  it("[3] a revoked organizer, an unknown competition and a missing caller are told the same, and the database is never asked", async () => {
    const { createCompetitionDraw, CompetitionDrawNotAvailableError } = await loadDraw();
    const revoked = makeRepo();
    revoked.getCompetitionById.mockResolvedValue(competition({ hostBound: true, hostAccessRevoked: true }));
    await expect(createCompetitionDraw(revoked as never, CID, ORGANIZER, INTENT)).rejects.toBeInstanceOf(CompetitionDrawNotAvailableError);
    const unknown = makeRepo();
    await expect(createCompetitionDraw(unknown as never, "99999999-9999-4999-8999-999999999999", ORGANIZER, INTENT)).rejects.toBeInstanceOf(CompetitionDrawNotAvailableError);
    const missing = makeRepo();
    await expect(createCompetitionDraw(missing as never, CID, undefined as unknown as string, INTENT)).rejects.toBeInstanceOf(CompetitionDrawNotAvailableError);
    for (const repo of [revoked, unknown, missing]) expect(repo.createCompetitionDraw).not.toHaveBeenCalled();
  });

  it("whatever the store refuses with is passed on untouched (the decision is the database's, never repeated or softened here)", async () => {
    const { createCompetitionDraw, drawErrorFromDatabase } = await loadDraw();
    const repo = makeRepo();
    const refusal = drawErrorFromDatabase("COMPETITION_DRAW_AMENDMENT_PENDING: x")!;
    repo.createCompetitionDraw.mockRejectedValue(refusal);
    await expect(createCompetitionDraw(repo as never, CID, ORGANIZER, INTENT)).rejects.toBe(refusal);
  });

  it("[22] a read is passed straight to the store with the verified caller: the database alone says who may see the draw", async () => {
    const { readCompetitionDraw } = await loadDraw();
    const repo = makeRepo();
    expect(await readCompetitionDraw(repo as never, CID, CAPTAIN)).toEqual({ draw: katRecord() });
    expect(repo.getCompetitionDraw).toHaveBeenCalledWith(CID, CAPTAIN);
    repo.getCompetitionDraw.mockResolvedValue(null);
    expect(await readCompetitionDraw(repo as never, CID, STRANGER)).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The route
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("the route: 503 first, 401, one uniform not-available, the exact body, 201 / 200 / 409, bounded errors, no caching", () => {
  const ctx = (competitionId: string): Ctx => ({ params: { competitionId } });
  const post = (body: unknown) => new Request("http://localhost/x", { method: "POST", headers: { "content-type": "application/json" }, body: typeof body === "string" ? body : JSON.stringify(body) });
  const get = () => new Request("http://localhost/x", { method: "GET" });
  const ORIGINAL = process.env.COMPETITIONS_SCHEMA_READY;
  let repo: ReturnType<typeof makeRepo>;

  beforeEach(() => {
    process.env.COMPETITIONS_SCHEMA_READY = "true";
    vi.clearAllMocks();
    repo = makeRepo();
    vi.mocked(httpAuth.getSupabaseCredentials).mockReturnValue({ url: "http://fake", serviceKey: "fake" });
    vi.mocked(httpAuth.buildCompetitionsRepo).mockReturnValue(repo as never);
    vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ gamingMemberId: ORGANIZER });
    return () => { if (ORIGINAL === undefined) delete process.env.COMPETITIONS_SCHEMA_READY; else process.env.COMPETITIONS_SCHEMA_READY = ORIGINAL; };
  });

  it("exports exactly GET and POST", async () => {
    const mod = await loadRoute();
    expect(["GET", "POST", "PUT", "PATCH", "DELETE"].filter((m) => typeof mod[m] === "function")).toEqual(["GET", "POST"]);
  });

  it("[29] with the schema not ready, both methods answer 503 first — before authenticating, parsing a body or building a repository — and uncached", async () => {
    const mod = await loadRoute();
    for (const value of [undefined, "", "false", "TRUE", "1"]) {
      if (value === undefined) delete process.env.COMPETITIONS_SCHEMA_READY; else process.env.COMPETITIONS_SCHEMA_READY = value;
      for (const [method, handler] of [["GET", mod.GET], ["POST", mod.POST]] as const) {
        const res = await handler!(new Request("http://localhost/x", { method, body: method === "POST" ? "not json {{{" : undefined }), ctx("test-id"));
        expect(res.status, `${method} ${String(value)}`).toBe(503);
        expect(res.headers.get("cache-control")).toMatch(/no-store/);
      }
    }
    expect(httpAuth.requireGamingMember).not.toHaveBeenCalled();
    expect(httpAuth.buildCompetitionsRepo).not.toHaveBeenCalled();
  });

  it("answers 401 first, from the credential alone, with no repository built and nothing cached", async () => {
    const mod = await loadRoute();
    vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ errorResponse: new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 }) } as never);
    for (const [handler, request] of [[mod.GET!, get()], [mod.POST!, post({ intentId: INTENT })]] as const) {
      const res = await handler(request, ctx(CID));
      expect(res.status).toBe(401);
      expect(res.headers.get("cache-control")).toMatch(/no-store/);
    }
    expect(httpAuth.buildCompetitionsRepo).not.toHaveBeenCalled();
    expect(repo.createCompetitionDraw).not.toHaveBeenCalled();
  });

  it("[1] POST rejects every field a client could use to influence the draw with a 400 listing the problem — and neither the competition nor the store is touched", async () => {
    const mod = await loadRoute();
    for (const field of ["seed", "teams", "order", "pairing", "format", "organizerGamingMemberId", "gamingMemberId", "reroll", "permutationIndex"]) {
      const res = await mod.POST!(post({ intentId: INTENT, [field]: field === "reroll" ? true : "x" }), ctx(CID));
      expect(res.status, field).toBe(400);
      expect(res.headers.get("cache-control")).toMatch(/no-store/);
      const body = await res.json();
      expect(body.problems).toEqual([expect.objectContaining({ field, code: "FORBIDDEN_FIELD" })]);
    }
    const missing = await mod.POST!(post({}), ctx(CID));
    expect(missing.status).toBe(400);
    expect((await mod.POST!(post("not json {{{"), ctx(CID))).status).toBe(400);
    expect(repo.getCompetitionById).not.toHaveBeenCalled();
    expect(repo.createCompetitionDraw).not.toHaveBeenCalled();
  });

  it("POST: a malformed competition id is the uniform 404 before the body is even read", async () => {
    const mod = await loadRoute();
    const res = await mod.POST!(post("not json {{{"), ctx("not-a-uuid"));
    expect(res.status).toBe(404);
  });

  it("[10][11] POST: 201 for a new draw, 200 for an authorized same-intent replay — each with exactly the bounded draw and the flag", async () => {
    const mod = await loadRoute();
    const { publicDraw } = await loadDraw();
    const created = await mod.POST!(post({ intentId: INTENT }), ctx(CID));
    expect(created.status).toBe(201);
    expect(created.headers.get("cache-control")).toMatch(/no-store/);
    expect(await created.json()).toEqual({ draw: publicDraw(katRecord()), alreadyDrawn: false });
    expect(repo.createCompetitionDraw).toHaveBeenCalledWith(CID, ORGANIZER, INTENT);
    repo.createCompetitionDraw.mockResolvedValue({ draw: katRecord(), alreadyDrawn: true });
    const replay = await mod.POST!(post({ intentId: INTENT }), ctx(CID));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toEqual({ draw: publicDraw(katRecord()), alreadyDrawn: true });
  });

  it("[2] POST: the actor is always the verified caller, never anything in the request", async () => {
    const mod = await loadRoute();
    vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ gamingMemberId: ORGANIZER });
    await mod.POST!(post({ intentId: INTENT }), ctx(CID));
    expect(repo.createCompetitionDraw.mock.calls[0]).toEqual([CID, ORGANIZER, INTENT]);
  });

  it.each([["a frozen captain", CAPTAIN], ["a scorekeeper", SCOREKEEPER], ["an ordinary registrant", REGISTRANT], ["a member holding only OPERATIONAL authority", OPERATIONAL], ["a stranger", STRANGER]])(
    "[4] POST by %s: the one uniform 404, the same words as for an unknown competition, and no draw is attempted", async (_label, caller) => {
      const mod = await loadRoute();
      vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ gamingMemberId: caller });
      const refused = await mod.POST!(post({ intentId: INTENT }), ctx(CID));
      const unknown = await mod.POST!(post({ intentId: INTENT }), ctx("99999999-9999-4999-8999-999999999999"));
      expect([refused.status, unknown.status]).toEqual([404, 404]);
      expect(await refused.text()).toBe(await unknown.text());
      expect(refused.headers.get("cache-control")).toMatch(/no-store/);
      expect(repo.createCompetitionDraw).not.toHaveBeenCalled();
    });

  it("[3] POST by a revoked organizer — in the application's view or by a race at the database — is the same 404 and says nothing of revocation", async () => {
    const mod = await loadRoute();
    const { DRAW_NOT_FOUND_MESSAGE } = await loadDraw();
    repo.getCompetitionById.mockResolvedValue(competition({ hostBound: true, hostAccessRevoked: true }));
    const viaApplication = await mod.POST!(post({ intentId: INTENT }), ctx(CID));
    expect(viaApplication.status).toBe(404);
    expect(await viaApplication.json()).toEqual({ error: DRAW_NOT_FOUND_MESSAGE });
    repo.getCompetitionById.mockResolvedValue(competition());
    for (const err of [new HostAccessRevokedError(), new CompetitionAccessDeniedError("x"), new CompetitionNotFoundError()]) {
      repo.createCompetitionDraw.mockRejectedValue(err);
      const res = await mod.POST!(post({ intentId: INTENT }), ctx(CID));
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: DRAW_NOT_FOUND_MESSAGE });
    }
  });

  it("[5][6][12] POST: every lifecycle refusal is a 409 with its stable code and the application's bounded words", async () => {
    const mod = await loadRoute();
    const { drawErrorFromDatabase } = await loadDraw();
    for (const [databaseCode, code] of [["COMPETITION_DRAW_WRONG_STATE", "WRONG_STATE"], ["COMPETITION_DRAW_FREEZE_REQUIRED", "FREEZE_REQUIRED"], ["COMPETITION_DRAW_FREEZE_INCONSISTENT", "FREEZE_INCONSISTENT"],
      ["COMPETITION_DRAW_AMENDMENT_PENDING", "AMENDMENT_PENDING"], ["COMPETITION_DRAW_ALREADY_DRAWN", "ALREADY_DRAWN"]]) {
      repo.createCompetitionDraw.mockRejectedValue(drawErrorFromDatabase(`${databaseCode}: raw database words`));
      const res = await mod.POST!(post({ intentId: OTHER_INTENT }), ctx(CID));
      expect(res.status, code).toBe(409);
      expect(res.headers.get("cache-control")).toMatch(/no-store/);
      const body = await res.json();
      expect(body.code).toBe(code);
      expect(JSON.stringify(body)).not.toMatch(/raw database words|COMPETITION_DRAW/);
    }
  });

  it("POST: an unexpected failure is a generic 500 that leaks nothing of the error", async () => {
    const mod = await loadRoute();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    repo.createCompetitionDraw.mockRejectedValue(new Error("secret internals 12345"));
    const res = await mod.POST!(post({ intentId: INTENT }), ctx(CID));
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    expect(JSON.stringify(await res.json())).not.toMatch(/secret|12345/);
  });

  it("[22][23] GET: the organizer and a frozen captain are answered with the bounded draw; the organizer before a draw is answered { draw: null }; uncached", async () => {
    const mod = await loadRoute();
    const { publicDraw } = await loadDraw();
    for (const caller of [ORGANIZER, CAPTAIN]) {
      vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ gamingMemberId: caller });
      const res = await mod.GET!(get(), ctx(CID));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toMatch(/no-store/);
      expect(await res.json()).toEqual({ draw: publicDraw(katRecord()) });
      expect(repo.getCompetitionDraw).toHaveBeenLastCalledWith(CID, caller);
    }
    repo.getCompetitionDraw.mockResolvedValue({ draw: null });
    vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ gamingMemberId: ORGANIZER });
    const before = await mod.GET!(get(), ctx(CID));
    expect(before.status).toBe(200);
    expect(await before.json()).toEqual({ draw: null });
  });

  it("[23] GET: unrelated callers, unknown competitions and malformed ids all get the one identical 404, which names nothing", async () => {
    const mod = await loadRoute();
    repo.getCompetitionDraw.mockResolvedValue(null);
    const answers: Array<[number, string, string | null]> = [];
    for (const id of [CID, "99999999-9999-4999-8999-999999999999", "not-a-uuid", ""]) {
      const res = await mod.GET!(get(), ctx(id));
      answers.push([res.status, await res.text(), res.headers.get("cache-control")]);
    }
    expect(new Set(answers.map((a) => a[0]))).toEqual(new Set([404]));
    expect(new Set(answers.map((a) => a[1])).size).toBe(1);
    for (const a of answers) expect(a[2]).toMatch(/no-store/);
    expect(answers[0][1]).not.toMatch(/organizer|captain|seed|team|freeze|state|ready/i);
  });

  it("GET: an unexpected failure is a generic 500", async () => {
    const mod = await loadRoute();
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    repo.getCompetitionDraw.mockRejectedValue(new Error("secret internals 12345"));
    const res = await mod.GET!(get(), ctx(CID));
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toMatch(/secret|12345/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The repository adapter: it sends the database three facts, and hands on only evidence that reproduces itself
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("the repository adapter sends exactly three facts and never hands on evidence that does not reproduce itself", () => {
  const sent: Array<{ url: string; body: Record<string, unknown> | null }> = [];
  /** Answers every request the Supabase client makes with this JSON (the client calls the global fetch at request time). */
  function answer(body: unknown, status = 200) {
    sent.length = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: unknown, init?: { body?: unknown }) => {
      sent.push({ url: String(input), body: init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : null });
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    }));
  }
  const repository = () => new SupabaseCompetitionsRepository("http://127.0.0.1:1", "service-key");
  afterEach(() => { vi.unstubAllGlobals(); });

  it("create: sends exactly the competition, the verified caller and the identifier to the one operation, and returns the verified draw", async () => {
    answer({ already_drawn: false, draw: rawEvidence() });
    const result = await repository().createCompetitionDraw(CID, ORGANIZER, INTENT);
    expect(result).toEqual({ draw: katRecord(), alreadyDrawn: false });
    expect(sent).toHaveLength(1);
    expect(sent[0].url).toMatch(/\/rest\/v1\/rpc\/create_competition_draw_atomically$/);
    expect(sent[0].body).toEqual({ p_competition_id: CID, p_organizer_gaming_member_id: ORGANIZER, p_intent_id: INTENT });
  });

  it("create: an exact replay is reported as already drawn", async () => {
    answer({ already_drawn: true, draw: rawEvidence() });
    expect((await repository().createCompetitionDraw(CID, ORGANIZER, INTENT)).alreadyDrawn).toBe(true);
  });

  it("create: the database's refusals become the typed errors, by their stable codes", async () => {
    const { CompetitionDrawError } = await loadDraw();
    for (const [databaseCode, code] of [["COMPETITION_DRAW_ALREADY_DRAWN", "ALREADY_DRAWN"], ["COMPETITION_DRAW_AMENDMENT_PENDING", "AMENDMENT_PENDING"], ["COMPETITION_DRAW_WRONG_STATE", "WRONG_STATE"]]) {
      answer({ code: "P0001", details: null, hint: null, message: `${databaseCode}: raw words` }, 400);
      const error = await repository().createCompetitionDraw(CID, ORGANIZER, INTENT).then(() => null, (e: unknown) => e);
      expect(error).toBeInstanceOf(CompetitionDrawError);
      expect((error as { code: string }).code).toBe(code);
    }
  });

  it("[20] create: evidence whose digest, index, order or seed has been tampered with is never handed on", async () => {
    const tampered: Array<[string, (raw: Record<string, any>) => void]> = [
      ["a stale digest", (r) => { r.draw_digest = sha("stale"); }],
      ["a different permutation index", (r) => { r.permutation_index = 17; }],
      ["two teams swapped in the drawn order", (r) => { const [a, b] = [r.order[0], r.order[1]]; r.order[0] = { ...b, draw_position: 1 }; r.order[1] = { ...a, draw_position: 2 }; }],
      ["a different seed", (r) => { r.seed = SEED_VECTORS[0].seed; }],
      ["a different freeze digest", (r) => { r.freeze_digest = sha("another freeze"); }],
    ];
    for (const [label, tamper] of tampered) {
      const raw = rawEvidence() as Record<string, any>;
      tamper(raw);
      answer({ already_drawn: false, draw: raw });
      await expect(repository().createCompetitionDraw(CID, ORGANIZER, INTENT), label).rejects.toThrow(/could not be verified/);
    }
  });

  it("[20] create: evidence presented for ANOTHER competition does not verify (the digest binds the competition)", async () => {
    answer({ already_drawn: false, draw: rawEvidence() });
    await expect(repository().createCompetitionDraw("11111111-1111-4111-8111-111111111112", ORGANIZER, INTENT)).rejects.toThrow(/could not be verified/);
  });

  it("create: a response that is not the evidence is a failure, never a guess", async () => {
    for (const body of [{}, { already_drawn: false }, { already_drawn: false, draw: null }, { already_drawn: false, draw: "evidence" }, null]) {
      answer(body);
      await expect(repository().createCompetitionDraw(CID, ORGANIZER, INTENT), JSON.stringify(body)).rejects.toThrow();
    }
  });

  it("read: sends exactly the competition and the verified caller to the one operation", async () => {
    answer(null);
    await repository().getCompetitionDraw(CID, CAPTAIN);
    expect(sent[0].url).toMatch(/\/rest\/v1\/rpc\/get_competition_draw$/);
    expect(sent[0].body).toEqual({ p_competition_id: CID, p_caller_gaming_member_id: CAPTAIN });
  });

  it("read: SQL NULL (no part in this draw) is null; the organizer before a draw is { draw: null }; a genuine draw is returned verified, whatever the case of the competition id", async () => {
    answer(null);
    expect(await repository().getCompetitionDraw(CID, STRANGER)).toBeNull();
    answer({ draw: null });
    expect(await repository().getCompetitionDraw(CID, ORGANIZER)).toEqual({ draw: null });
    answer({ draw: rawEvidence() });
    expect(await repository().getCompetitionDraw(CID, ORGANIZER)).toEqual({ draw: katRecord() });
    expect(await repository().getCompetitionDraw(CID.toUpperCase(), CAPTAIN)).toEqual({ draw: katRecord() });
  });

  it("read: a response that is neither SQL NULL, { draw: null } nor genuine evidence is a failure — a missing draw key is not read as 'no draw yet'", async () => {
    for (const body of [{}, { draw: "evidence" }, { draw: {} }, { drawn: null }, []]) {
      answer(body);
      await expect(repository().getCompetitionDraw(CID, ORGANIZER), JSON.stringify(body)).rejects.toThrow();
    }
  });

  it("[20] read: tampered evidence is never handed on either", async () => {
    const raw = rawEvidence() as Record<string, any>;
    raw.draw_digest = sha("stale");
    answer({ draw: raw });
    await expect(repository().getCompetitionDraw(CID, CAPTAIN)).rejects.toThrow(/could not be verified/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------------------
// The static facts about the surface
// ---------------------------------------------------------------------------------------------------------------------------------------------

describe("[8] no randomness and no clock in the application: the entropy is the database's alone", () => {
  const FILES = ["lib/gaming/competitions/draw.ts", "app/api/gaming/competitions/[competitionId]/draw/route.ts"];
  const FORBIDDEN: Array<[string, RegExp]> = [
    ["Math.random", /Math\.random/], ["crypto random bytes", /randomBytes|randomInt|randomUUID|randomFill/], ["getRandomValues", /getRandomValues/],
    ["webcrypto", /crypto\.subtle|webcrypto/], ["a clock", /Date\.now|new Date\(|performance\.now|hrtime/], ["an environment-chosen seed", /process\.env/],
  ];
  const strip = (source: string) => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

  it.each(FILES)("%s contains no random source, no clock and no seed from outside", (file) => {
    const source = strip(read(file));
    for (const [label, pattern] of FORBIDDEN) expect(source, `${file}: ${label}`).not.toMatch(pattern);
  });

  it("the repository adapter sends the database exactly the competition, the verified caller and the identifier — nothing more", () => {
    const source = read("lib/gaming/competitions/db/supabaseCompetitionsRepository.ts");
    const create = /rpc\("create_competition_draw_atomically",\s*\{([^}]*)\}/.exec(source);
    const readRpc = /rpc\("get_competition_draw",\s*\{([^}]*)\}/.exec(source);
    expect(create, "the create call").not.toBeNull();
    expect(readRpc, "the read call").not.toBeNull();
    expect([...create![1].matchAll(/(p_[a-z_]+)\s*:/g)].map((m) => m[1])).toEqual(["p_competition_id", "p_organizer_gaming_member_id", "p_intent_id"]);
    expect([...readRpc![1].matchAll(/(p_[a-z_]+)\s*:/g)].map((m) => m[1])).toEqual(["p_competition_id", "p_caller_gaming_member_id"]);
  });
});

describe("[28][29] no page offers a draw, and no format other than five-a-side is made available", () => {
  const PUBLIC = () => walk(path.join(REPO_ROOT, "public"), (f) => /\.(html|js)$/.test(f));

  it("[29] no public page or script calls a draw endpoint or carries a draw control", () => {
    for (const file of PUBLIC()) {
      const source = readFileSync(file, "utf8");
      const where = path.relative(REPO_ROOT, file);
      expect(source, `${where}: a /draw path`).not.toMatch(/competitions\/[^\s"'`<>]*\/draw(?![A-Za-z])/);
      expect(source, `${where}: a control named draw`).not.toMatch(/\b(?:id|name|class|for|data-[a-z-]+)=["'][^"']*(?<![A-Za-z])draw(?![A-Za-z])[^"']*["']/i);
      expect(source, `${where}: a draw button`).not.toMatch(/<(?:button|a|summary)\b[^>]*>\s*(?:(?:make|run|do|start|request|perform)\s+(?:the\s+)?)?draw\s*</i);
    }
  });

  it("[28] the registry still knows the same four formats, the creation routes still take no format from it, and the draw module names none of them", () => {
    expect([...SOCCER_FORMAT_KEYS]).toEqual(["SOCCER_5V5", "SOCCER_6V6", "SOCCER_7V7", "SOCCER_8V8"]);
    expect(read("lib/gaming/competitions/createCompetition.ts")).not.toMatch(/formats|SOCCER_FORMAT|planning|draw/i);
    expect(read("app/api/gaming/host/competition/route.ts")).not.toMatch(/activityKey|formats|SOCCER_|draw/i);
    expect(read("app/api/gaming/competitions/route.ts")).not.toMatch(/planning|formats|draw/i);
    for (const file of ["lib/gaming/competitions/draw.ts", "app/api/gaming/competitions/[competitionId]/draw/route.ts"]) {
      expect(read(file), file).not.toMatch(/SOCCER_[5-8]V[5-8]|SOCCER_FORMAT|formats"/);
    }
  });
});

describe("the migration (static contract): exactly one new, append-only migration", () => {
  const DIR = path.join(REPO_ROOT, "supabase/migrations");
  /** The newest migration current main is known to carry; the draw's migration must sort after it. */
  const NEWEST_KNOWN_MAIN = "20261101022329_community_voting_group_representative.sql";
  const BASE_NEWEST = "20261023215208_post_freeze_plan_amendment_foundation.sql";
  const files = () => readdirSync(DIR).filter((f) => /four_team_draw/i.test(f));
  const code = () => {
    const found = files();
    if (found.length !== 1) throw new Error(`expected exactly one four-team-draw migration, found ${found.length}`);
    return readFileSync(path.join(DIR, found[0]), "utf8").split("\n").filter((l) => !/^\s*--/.test(l)).join("\n");
  };
  const body = (sql: string, name: string) => {
    const start = sql.indexOf(`create function ${name}(`);
    expect(start, `${name} exists`).toBeGreaterThan(-1);
    const end = sql.indexOf("$function$;", sql.indexOf("$function$", start + 20) + 5);
    return sql.slice(start, end);
  };

  it("is exactly one migration with a descriptive four-team-draw name, after current main's newest and after the base's", () => {
    const found = files();
    expect(found).toHaveLength(1);
    expect(found[0]).toMatch(/^\d{14}_[a-z0-9_]*four_team_draw[a-z0-9_]*\.sql$/);
    expect(found[0] > NEWEST_KNOWN_MAIN).toBe(true);
    expect(found[0] > BASE_NEWEST).toBe(true);
    // nothing else was added beyond the base: every other migration sorts at or before the base's newest
    expect(readdirSync(DIR).filter((f) => f > BASE_NEWEST)).toEqual(found);
  });

  it("creates exactly the two evidence tables, server-only: row-level security on, no policy, no privilege for anyone", () => {
    const sql = code();
    expect([...sql.matchAll(/create table (\w+)/g)].map((m) => m[1]).sort()).toEqual(["competition_draw_entries", "competition_draws"]);
    for (const table of ["competition_draws", "competition_draw_entries"]) {
      expect(sql, table).toMatch(new RegExp(`alter table ${table} enable row level security;`));
      expect(sql, table).toMatch(new RegExp(`revoke all on table ${table} from public, anon, authenticated, service_role;`));
    }
    expect(sql).not.toMatch(/create policy/i);
    expect(sql).not.toMatch(/grant\s+(select|insert|update|delete|truncate|all)[^;]*\bon\s+(table\s+)?competition_draw/i);
  });

  it("keeps one draw per competition, exactly positions 1–4, and the shapes of the seed and digests, as constraints", () => {
    const sql = code();
    expect(sql).toMatch(/unique \(competition_id\)/);
    expect(sql).toMatch(/unique \(competition_id, intent_id\)/);
    expect(sql).toMatch(/draw_position between 1 and 4/);
    expect(sql).toMatch(/input_position between 1 and 4/);
    expect(sql).toMatch(/primary key \(competition_draw_id, draw_position\)/);
    expect(sql).toMatch(/seed ~ '\^\[0-9a-f\]\{64\}\$'/);
    expect(sql).toMatch(/permutation_index between 0 and 23/);
    expect(sql).toMatch(/algorithm_version = 'URBANO-DRAW-PERMUTATION-V1'/);
    expect(sql).toMatch(/references competition_registration_freezes \(competition_id, registration_freeze_id\)/);
    expect(sql).toMatch(/references competition_registration_freeze_teams \(registration_freeze_id, competition_team_id\)/);
  });

  it("refuses UPDATE, DELETE and TRUNCATE by trigger on both tables, and verifies the evidence at commit with deferred constraint triggers", () => {
    const sql = code();
    for (const table of ["competition_draws", "competition_draw_entries"]) {
      expect(sql, table).toMatch(new RegExp(`create trigger \\w+ before update or delete on ${table}\\s+for each row execute function competition_draw_reject_change\\(\\)`));
      expect(sql, table).toMatch(new RegExp(`create trigger \\w+ before truncate on ${table}\\s+for each statement execute function competition_draw_reject_change\\(\\)`));
    }
    expect([...sql.matchAll(/create constraint trigger/g)]).toHaveLength(2);
    expect(sql.match(/deferrable initially deferred/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("defines exactly the two operations, SECURITY DEFINER with a pinned search_path, executable by the server role alone, taking no seed, team, order, pairing, time or actor beyond the verified caller", () => {
    const sql = code();
    expect(sql).toMatch(/create function create_competition_draw_atomically\(p_competition_id uuid, p_organizer_gaming_member_id uuid, p_intent_id uuid\)/);
    expect(sql).toMatch(/create function get_competition_draw\(p_competition_id uuid, p_caller_gaming_member_id uuid\)/);
    for (const name of ["create_competition_draw_atomically", "get_competition_draw"]) {
      const fn = body(sql, name);
      expect(fn, name).toMatch(/security definer/);
      expect(fn, name).toMatch(/set search_path = public, pg_temp/);
    }
    expect(sql).toMatch(/grant execute on function create_competition_draw_atomically\(uuid, uuid, uuid\) to service_role;/);
    expect(sql).toMatch(/grant execute on function get_competition_draw\(uuid, uuid\) to service_role;/);
    expect([...sql.matchAll(/grant execute on function (\w+)/g)].map((m) => m[1]).sort()).toEqual(["create_competition_draw_atomically", "get_competition_draw"]);
  });

  it("every other function is internal: revoked from everyone, including the server role", () => {
    const sql = code();
    const all = [...sql.matchAll(/create function (\w+)\(/g)].map((m) => m[1]);
    expect(all.length).toBeGreaterThanOrEqual(8);
    for (const name of all) {
      expect(sql, name).toMatch(new RegExp(`revoke all on function ${name}\\([^)]*\\) from public, anon, authenticated`));
      if (!["create_competition_draw_atomically", "get_competition_draw"].includes(name)) {
        expect(sql, `${name} (service_role)`).toMatch(new RegExp(`revoke all on function ${name}\\([^)]*\\) from service_role`));
      }
    }
  });

  it("[8] the create operation takes the competition lock, then decides authority, replay, eligibility, and only then draws entropy and writes — in that order", () => {
    const fn = body(code(), "create_competition_draw_atomically");
    const at = (needle: string) => { const i = fn.indexOf(needle); expect(i, needle).toBeGreaterThan(-1); return i; };
    const lock = at("pg_advisory_xact_lock(hashtext('competition_scope:'");
    const owner = at("p_organizer_gaming_member_id is distinct from");
    const revoked = at("assert_competition_not_host_revoked(");
    const replay = at("already_drawn");
    const eligibility = at("competition_draw_eligibility_problem(");
    const entropy = at("gen_random_uuid()");
    const insert = at("insert into competition_draws");
    expect([lock, owner, revoked, replay, eligibility, entropy, insert]).toEqual([lock, owner, revoked, replay, eligibility, entropy, insert].sort((a, b) => a - b));
    expect(fn.match(/gen_random_uuid\(\)/g)).toHaveLength(3); // two for the seed, one for the draw's own id
  });

  it("[8] uses no weak or external randomness: no random(), setseed, tablesample, ordering by chance, extension or external provider", () => {
    const sql = code();
    for (const pattern of [/\brandom\s*\(/i, /setseed/i, /tablesample/i, /order by\s+random/i, /gen_random_bytes/i, /pgcrypto/i, /create extension/i, /uuid_generate/i, /dblink|http_|pg_net|plv8|plpython/i]) {
      expect(sql, String(pattern)).not.toMatch(pattern);
    }
  });

  it("only creates new objects and writes only the draw's own tables: nothing replaced, no fixture, publication, schedule, state or format", () => {
    const sql = code();
    expect(sql).not.toMatch(/create or replace/i);
    expect(sql).not.toMatch(/\bdrop\s+/i);
    expect(sql).not.toMatch(/alter table (?!competition_draw)/i);
    expect([...new Set([...sql.matchAll(/insert into (\w+)/g)].map((m) => m[1]))].sort()).toEqual(["competition_draw_entries", "competition_draws"]);
    expect(sql).not.toMatch(/\bupdate\s+\w+\s+set\b/i);
    expect(sql).not.toMatch(/delete from/i);
    expect(sql).not.toMatch(/(insert into|update|delete from)\s+competition_fixtures/i);
    expect(sql).not.toMatch(/publish_competition_atomically|schedule|pitch|venue|window_index|planning_pitch|competition_planning_windows/i);
    expect(sql).not.toMatch(/competition_format_rules|SOCCER_/i);
    expect(sql).not.toMatch(/set\s+state\s*=|'(DRAFT|TEAM_REGISTRATION_OPEN|PUBLISHED|COMPLETE)'/);
  });
});

describe("the new tests are registered in the explicit lists", () => {
  it("package.json runs this file in the ordinary suite and the contract file in the contract suite", () => {
    const scripts = (JSON.parse(read("package.json")) as { scripts: Record<string, string> }).scripts;
    expect(scripts.test).toContain("__tests__/competitionDraw.test.ts");
    expect(scripts["test:contract"]).toContain("__tests__/competitionDrawSupabase.contract.test.ts");
    expect(scripts["test:contract"]).not.toContain("competitionDraw.test.ts");
  });
});
