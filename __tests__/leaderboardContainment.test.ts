import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";

/**
 * Leaderboards, Phase 1 containment: BOTH public ranking endpoints are closed by default and open only when GAMING_LEADERBOARD_PUBLIC is
 * exactly the text "true".
 *
 * Why: the public ranking today holds only test-fixture members, and the exclusion of fixtures by exact ids does not exist yet. Hiding the
 * Clasificaciones page does not close the API, so the API itself answers nothing until it is deliberately opened.
 *
 * What it proves: closed is a stable 200 with an empty body and `available: false`; closed means NOTHING is read (no credentials, no
 * repository, no ranking query — the spies below are never called); only the exact value opens it; the open behaviour is the one that
 * existed (the projection has no identifier of anyone); and the check runs before any other statement of either route.
 */

const calls = vi.hoisted(() => ({ repoBuilt: 0, getGlobal: 0, credentials: 0, buildPredictionsRepo: 0, getLeaderboard: 0 }));

vi.mock("@/lib/gaming/metagame/db/supabaseMetagameRepository", () => ({
  SupabaseMetagameRepository: class {
    constructor() {
      calls.repoBuilt += 1;
    }
  },
}));
vi.mock("@/lib/gaming/metagame/leaderboard", () => ({
  getGlobalLeaderboard: async () => {
    calls.getGlobal += 1;
    // the real projection carries nothing but these three, but a repository that carried more must not leak it through the route
    return [{ rank: 1, displayName: "Alex", globalXp: 50, gamingMemberId: "member-secret", email: "secret@example.com" }];
  },
}));
vi.mock("@/lib/gaming/predictions/httpAuth", () => ({
  getSupabaseCredentials: () => {
    calls.credentials += 1;
    return { url: "http://127.0.0.1:1", serviceKey: "stand-in" };
  },
  buildPredictionsRepo: () => {
    calls.buildPredictionsRepo += 1;
    return {};
  },
}));
vi.mock("@/lib/gaming/predictions/leaderboard", () => ({
  getLeaderboard: async () => {
    calls.getLeaderboard += 1;
    return [{ displayName: "Legacy", points: 9 }];
  },
}));

import { GET as canonical } from "@/app/api/gaming/leaderboard/route";
import { GET as legacy } from "@/app/api/gaming/predictions/leaderboard/route";

const FLAG = "GAMING_LEADERBOARD_PUBLIC";
const saved = { flag: process.env[FLAG], url: process.env.SUPABASE_URL, key: process.env.SUPABASE_SERVICE_ROLE_KEY };

beforeEach(() => {
  for (const key of Object.keys(calls) as Array<keyof typeof calls>) calls[key] = 0;
  delete process.env[FLAG];
  process.env.SUPABASE_URL = "http://127.0.0.1:1";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stand-in";
});
afterEach(() => {
  for (const [name, value] of [[FLAG, saved.flag], ["SUPABASE_URL", saved.url], ["SUPABASE_SERVICE_ROLE_KEY", saved.key]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

const nothingWasRead = () => expect(calls).toEqual({ repoBuilt: 0, getGlobal: 0, credentials: 0, buildPredictionsRepo: 0, getLeaderboard: 0 });
const bodyOf = async (response: Response) => ({ status: response.status, cache: response.headers.get("cache-control"), body: await response.json() });

describe("closed by default", () => {
  it("with the variable unset, both endpoints answer a stable empty body and read nothing", async () => {
    expect(await bodyOf(await canonical())).toEqual({ status: 200, cache: "no-store", body: { entries: [], available: false } });
    expect(await bodyOf(await legacy())).toEqual({ status: 200, cache: "no-store", body: { leaderboard: [], available: false } });
    nothingWasRead();
  });

  it("it is the same answer every time, and it does not depend on the database being reachable or configured", async () => {
    delete process.env.SUPABASE_URL;
    delete process.env.SUPABASE_SERVICE_ROLE_KEY; // misconfiguration would be a 500 when open; closed never looks
    const first = await bodyOf(await canonical());
    const second = await bodyOf(await canonical());
    expect(second).toEqual(first);
    expect(first.status).toBe(200);
    expect((await legacy()).status).toBe(200);
    nothingWasRead();
  });

  it.each(["", "1", "TRUE", "True", "true ", " true", "\ttrue", "yes", "on", "false", "truee", "t", "enabled", "0"])(
    "the value %j does not open it",
    async (value) => {
      process.env[FLAG] = value;
      expect(await bodyOf(await canonical())).toEqual({ status: 200, cache: "no-store", body: { entries: [], available: false } });
      expect(await bodyOf(await legacy())).toEqual({ status: 200, cache: "no-store", body: { leaderboard: [], available: false } });
      nothingWasRead();
    }
  );
});

describe("open only on the exact value", () => {
  it('GAMING_LEADERBOARD_PUBLIC=true opens the canonical ranking, with exactly the public projection and no identifier or e-mail', async () => {
    process.env[FLAG] = "true";
    const result = await bodyOf(await canonical());
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ entries: [{ rank: 1, displayName: "Alex", globalXp: 50 }] });
    expect(JSON.stringify(result.body)).not.toMatch(/member-secret|secret@example\.com|gamingMemberId|email/);
    expect(calls.repoBuilt).toBe(1);
    expect(calls.getGlobal).toBe(1);
  });

  it("GAMING_LEADERBOARD_PUBLIC=true opens the legacy predictions ranking as it was", async () => {
    process.env[FLAG] = "true";
    expect(await bodyOf(await legacy())).toMatchObject({ status: 200, body: { leaderboard: [{ displayName: "Legacy", points: 9 }] } });
    expect(calls.getLeaderboard).toBe(1);
  });

  it("when open, a missing configuration is still the error it always was (500), not an empty ranking", async () => {
    process.env[FLAG] = "true";
    delete process.env.SUPABASE_URL;
    expect((await canonical()).status).toBe(500);
  });

  it("closing it again is just removing the variable: the same process answers closed", async () => {
    process.env[FLAG] = "true";
    expect(((await canonical()).status)).toBe(200);
    expect(calls.getGlobal).toBe(1);
    delete process.env[FLAG];
    for (const key of Object.keys(calls) as Array<keyof typeof calls>) calls[key] = 0;
    expect((await bodyOf(await canonical())).body).toEqual({ entries: [], available: false });
    nothingWasRead();
  });
});

describe("the check comes first, in the source of both routes", () => {
  for (const file of ["app/api/gaming/leaderboard/route.ts", "app/api/gaming/predictions/leaderboard/route.ts"]) {
    it(`${file}: the exact-value test is the first statement of GET, before credentials, repository or ranking`, () => {
      const source = readFileSync(file, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      const body = source.slice(source.indexOf("export async function GET"));
      const check = body.indexOf('process.env.GAMING_LEADERBOARD_PUBLIC !== "true"');
      expect(check).toBeGreaterThan(-1);
      for (const later of ["SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "getSupabaseCredentials(", "buildPredictionsRepo(", "new SupabaseMetagameRepository", "getGlobalLeaderboard(", "getLeaderboard("]) {
        const at = body.indexOf(later);
        if (at !== -1) expect(check, `${later} must come after the check`).toBeLessThan(at);
      }
      expect(body.match(/GAMING_LEADERBOARD_PUBLIC/g)).toHaveLength(1);
      expect(source).not.toMatch(/GAMING_LEADERBOARD_PUBLIC\s*(===|==|!=)\s*["'](1|TRUE|True|yes)["']/);
    });
  }

  it("the canonical route's GET still takes no request: it cannot look at any header", () => {
    const source = readFileSync("app/api/gaming/leaderboard/route.ts", "utf8");
    expect(source).toMatch(/export\s+async\s+function\s+GET\s*\(\s*\)\s*{/);
  });
});
