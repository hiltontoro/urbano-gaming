import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { InMemoryPredictionsRepository } from "../lib/gaming/predictions/db/inMemoryPredictionsRepository";
import { PROVISIONAL_PRIZE_MATCHES_ENV, hasProvisionalPrizes, provisionalPrizeMatchIds } from "../lib/gaming/predictions/provisionalPrizes";

/**
 * PROVISIONAL PRIZES. A venue's proposed prizes carry a notice until the venue confirms them. What is proved here is the part that must never turn
 * itself on: no match carries the notice unless its id is named, exactly, in GAMING_PROVISIONAL_PRIZE_MATCH_IDS; that variable is read per request,
 * unset by default, and changes nothing else in the public answer; and the module touches neither the offer nor the evaluation. How the page shows
 * the notice is in soccerPredictionsStepper.test.ts.
 */

const A = "11111111-1111-4111-8111-111111111111";
const B = "22222222-2222-4222-8222-222222222222";

describe("which matches carry the notice", () => {
  it("none, when the variable is unset, empty, blank or holds nothing that is an exact id", () => {
    for (const env of [{}, { [PROVISIONAL_PRIZE_MATCHES_ENV]: undefined }, { [PROVISIONAL_PRIZE_MATCHES_ENV]: "" }, { [PROVISIONAL_PRIZE_MATCHES_ENV]: "   " }, { [PROVISIONAL_PRIZE_MATCHES_ENV]: ",," }]) {
      expect(provisionalPrizeMatchIds(env as Record<string, string | undefined>).size).toBe(0);
    }
  });

  it("exactly the ids named: case-insensitive, with spaces around them, and nothing that merely resembles one (a prefix, a pattern, a name, a truncated id)", () => {
    const ids = provisionalPrizeMatchIds({ [PROVISIONAL_PRIZE_MATCHES_ENV]: ` ${A.toUpperCase()} , ${B} ,*, 1111, ${A.slice(0, 20)}, the-pub, ${A}x, true ` });
    expect([...ids].sort()).toEqual([A, B]);
    expect(hasProvisionalPrizes(A.toUpperCase(), ids)).toBe(true);
    expect(hasProvisionalPrizes("33333333-3333-4333-8333-333333333333", ids)).toBe(false);
    expect(hasProvisionalPrizes(A.slice(0, 20), ids)).toBe(false);
  });

  it("is not a switch for everything: no value such as '*', 'all', 'true' or '1' turns the notice on for any match", () => {
    for (const value of ["*", "all", "ALL", "true", "1", "yes", "on"]) expect(hasProvisionalPrizes(A, provisionalPrizeMatchIds({ [PROVISIONAL_PRIZE_MATCHES_ENV]: value }))).toBe(false);
  });
});

describe("the module does only that", () => {
  const source = readFileSync(path.join(process.cwd(), "lib/gaming/predictions/provisionalPrizes.ts"), "utf8");
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  it("imports nothing: not the repository, not the ladder, not the evaluation — it cannot create, edit, enable or evaluate a prize", () => {
    expect(code).not.toMatch(/^\s*import\b/m);
    expect(code).not.toMatch(/prizeTier|createLadderPrizeTier|evaluat|qualification|redeem|finalize|setMatchActivityClassification|process\.env\s*\[[^\]]*\]\s*=/i);
  });

  it("is never set by code in the repository: no source file assigns the variable (only a deliberate, per-match setting outside the code can)", () => {
    const route = readFileSync(path.join(process.cwd(), "app/api/gaming/predictions/matches/route.ts"), "utf8");
    expect(route.match(/GAMING_PROVISIONAL_PRIZE_MATCH_IDS/g) ?? []).toHaveLength(1); // a comment naming it, no assignment
    expect(route).not.toMatch(/process\.env\.[A-Z_]+\s*=/);
    const packageJson = readFileSync(path.join(process.cwd(), "package.json"), "utf8");
    expect(packageJson).not.toMatch(/PROVISIONAL_PRIZE/);
  });
});

// ---------------------------------------------------------------------------------------------------------------------------------
// the public route
// ---------------------------------------------------------------------------------------------------------------------------------

const world = vi.hoisted(() => ({ repo: null as unknown }));
vi.mock("@/lib/gaming/predictions/httpAuth", () => ({
  getSupabaseCredentials: () => ({ url: "http://localhost:1", serviceKey: "stand-in" }),
  buildPredictionsRepo: () => world.repo,
}));
import { GET as publicMatches } from "@/app/api/gaming/predictions/matches/route";

describe("the public matches route", () => {
  const saved = process.env[PROVISIONAL_PRIZE_MATCHES_ENV];
  let first: string;
  let second: string;
  beforeEach(async () => {
    delete process.env[PROVISIONAL_PRIZE_MATCHES_ENV];
    const repo = new InMemoryPredictionsRepository();
    const home = await repo.createTeam({ name: "FC Barcelona" });
    const away = await repo.createTeam({ name: "Real Madrid CF" });
    first = (await repo.createMatch({ homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "El Clásico", kickoffAt: new Date(Date.now() + 86_400_000).toISOString() })).matchId;
    second = (await repo.createMatch({ homeTeamId: away.teamId, awayTeamId: home.teamId, competition: "Otro partido", kickoffAt: new Date(Date.now() + 2 * 86_400_000).toISOString() })).matchId;
    world.repo = repo;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env[PROVISIONAL_PRIZE_MATCHES_ENV]; else process.env[PROVISIONAL_PRIZE_MATCHES_ENV] = saved;
  });
  const ask = async () => ((await (await publicMatches()).json()) as { matches: any[] }).matches;

  it("by default no match carries the notice: shipping the code turns nothing on", async () => {
    const matches = await ask();
    expect(matches).toHaveLength(2);
    expect(matches.map((m) => m.provisionalPrizes)).toEqual([false, false]);
  });

  it("only the match named in the variable carries it, and it is read on every request (setting or clearing it needs no restart)", async () => {
    process.env[PROVISIONAL_PRIZE_MATCHES_ENV] = first;
    expect((await ask()).map((m) => [m.matchId === first, m.provisionalPrizes])).toEqual([[true, true], [false, false]]);
    process.env[PROVISIONAL_PRIZE_MATCHES_ENV] = `${second}`;
    expect((await ask()).map((m) => [m.matchId === second, m.provisionalPrizes])).toEqual([[false, false], [true, true]]);
    delete process.env[PROVISIONAL_PRIZE_MATCHES_ENV];
    expect((await ask()).map((m) => m.provisionalPrizes)).toEqual([false, false]);
  });

  it("a pattern or a prefix names nothing", async () => {
    for (const value of ["*", first.slice(0, 18), "El Clásico", "true"]) {
      process.env[PROVISIONAL_PRIZE_MATCHES_ENV] = value;
      expect((await ask()).map((m) => m.provisionalPrizes), value).toEqual([false, false]);
    }
  });

  it("changes nothing else in the answer: with the flag set, the match is the same field for field apart from the flag itself", async () => {
    const plain = (await ask()).map((m) => ({ ...m }));
    process.env[PROVISIONAL_PRIZE_MATCHES_ENV] = `${first},${second}`;
    const flagged = (await ask()).map((m) => ({ ...m }));
    for (const m of [...plain, ...flagged]) delete m.provisionalPrizes;
    expect(flagged).toEqual(plain);
  });
});
