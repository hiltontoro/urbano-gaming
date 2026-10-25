import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

import { InMemoryPredictionsRepository } from "../lib/gaming/predictions/db/inMemoryPredictionsRepository";
import { buildMemberParticipations } from "../lib/gaming/predictions/participations";
import { answersFor, buildLadderWorld, settle, submitAs, type LadderEnv, type LadderWorld } from "./helpers/progressiveLadderScenarios";

/**
 * MY PARTICIPATIONS (GET /api/gaming/predictions/participations), through the REAL authority chain (lib/gaming/predictions/httpAuth.ts and
 * the route are not replaced; only the classes that talk to Supabase are stood in for by in-memory equivalents).
 *
 * What it must guarantee: only the signed-in member's own participations; no session, no data; nothing the client sends can choose whose
 * history is returned; a level that was SENT is never presented as a prize that was WON; no coordinates, distance, accuracy, fingerprint
 * or identifier of anyone else; and building it never reads a match result, Gaming XP, a prize qualification or a redemption.
 */

const world = vi.hoisted(() => ({
  tokens: new Map<string, { authUserId: string }>(),
  members: new Map<string, { gamingMemberId: string; displayName: string }>(),
  repo: null as unknown,
  calls: [] as string[],
}));

vi.mock("@/lib/gaming/db/supabaseGamingRepository", () => ({
  SupabaseGamingRepository: class {
    async resolveGamingMemberByAuthUserId(authUserId: string) {
      return world.members.get(authUserId) ?? null;
    }
  },
}));
vi.mock("@/lib/gaming/auth", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/gaming/auth")>();
  return {
    ...actual,
    SupabaseAuthUserVerifier: class {
      async verifyAccessToken(token: string) {
        return world.tokens.get(token) ?? null;
      }
    },
  };
});
vi.mock("@/lib/gaming/predictions/db/supabasePredictionsRepository", () => ({
  SupabasePredictionsRepository: class {
    constructor() {
      // every call is recorded by name, so a test can say what the route did and did not touch
      return new Proxy(world.repo as object, {
        get(target, property) {
          const value = (target as Record<string | symbol, unknown>)[property as string];
          if (typeof value !== "function") return value;
          return (...args: unknown[]) => {
            world.calls.push(String(property));
            return (value as (...a: unknown[]) => unknown).apply(target, args);
          };
        },
      });
    }
  },
}));

import { GET } from "@/app/api/gaming/predictions/participations/route";

const FINALIZER = "gm-finalizer";
const ask = (headers: Record<string, string> = {}, query = "") =>
  GET(new Request(`http://localhost/api/gaming/predictions/participations${query}`, { headers }));

function person(name: string, finished = true) {
  world.tokens.set(`token-${name}`, { authUserId: `auth-${name}` });
  const memberId = `member-${name}-${randomUUID().slice(0, 6)}`;
  if (finished) world.members.set(`auth-${name}`, { gamingMemberId: memberId, displayName: name });
  return { header: { authorization: `Bearer token-${name}` }, memberId };
}

async function fresh(levels = [1, 2, 3, 4]): Promise<{ env: LadderEnv; repo: InMemoryPredictionsRepository; w: LadderWorld }> {
  const repo = new InMemoryPredictionsRepository();
  repo.authorityRepository.seedAuthority(FINALIZER, "CONSEQUENTIAL_FINALIZER");
  const env: LadderEnv = { repo, newMember: async (label) => label, finalizerId: FINALIZER, operatorId: FINALIZER };
  const w = await buildLadderWorld(env, { offeredLevels: levels });
  world.repo = repo;
  return { env, repo, w };
}

beforeEach(() => {
  world.tokens.clear();
  world.members.clear();
  world.calls.length = 0;
  process.env.SUPABASE_URL = "http://127.0.0.1:1";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "stand-in";
});

describe("only the signed-in member's own participations", () => {
  it("two members on the same match each see only their own, whatever is in the other's", async () => {
    const { env, w } = await fresh();
    const ana = person("ana");
    const beto = person("beto");
    await submitAs(env, w, ana.memberId, { attemptedLevel: 2, scoreline: { home: 2, away: 1 }, firstTeam: { kind: "PICKED", team: "HOME" } });
    await submitAs(env, w, beto.memberId, { attemptedLevel: 1, scoreline: { home: 5, away: 5 } });

    const forAna = (await (await ask(ana.header)).json()) as { participations: Array<{ attemptedLevel: number; answers: { scoreline: { home: number; away: number } } }> };
    const forBeto = (await (await ask(beto.header)).json()) as { participations: Array<{ attemptedLevel: number; answers: { scoreline: { home: number; away: number } } }> };
    expect(forAna.participations).toHaveLength(1);
    expect(forAna.participations[0]!.attemptedLevel).toBe(2);
    expect(forAna.participations[0]!.answers.scoreline).toEqual({ home: 2, away: 1 });
    expect(forBeto.participations).toHaveLength(1);
    expect(forBeto.participations[0]!.attemptedLevel).toBe(1);
    expect(forBeto.participations[0]!.answers.scoreline).toEqual({ home: 5, away: 5 });
    expect(JSON.stringify(forAna)).not.toContain("5,\"away\":5");
  });

  it("a member with no participation gets an empty list, not someone else's", async () => {
    const { env, w } = await fresh();
    const ana = person("ana");
    const nobody = person("nobody");
    await submitAs(env, w, ana.memberId, answersFor(w, 1, { S: true, F: true, G: true, M: true }));
    const body = (await (await ask(nobody.header)).json()) as { participations: unknown[] };
    expect(body.participations).toEqual([]);
  });

  it("nothing the client sends chooses whose history is returned: not a query string, not a header, not a body", async () => {
    const { env, w } = await fresh();
    const ana = person("ana");
    const beto = person("beto");
    await submitAs(env, w, ana.memberId, { attemptedLevel: 1, scoreline: { home: 1, away: 0 } });
    await submitAs(env, w, beto.memberId, { attemptedLevel: 1, scoreline: { home: 7, away: 7 } });
    const attempts: Array<[string, Record<string, string>]> = [
      [`?gamingMemberId=${beto.memberId}`, {}],
      [`?memberId=${beto.memberId}&member=${beto.memberId}&userId=auth-beto&limit=500`, {}],
      ["", { "x-gaming-member-id": beto.memberId, "x-member-id": beto.memberId }],
      [`?gamingMemberId=${beto.memberId}`, { "x-forwarded-user": beto.memberId }],
    ];
    for (const [query, extra] of attempts) {
      const body = (await (await ask({ ...ana.header, ...extra }, query)).json()) as { participations: Array<{ answers: { scoreline: { home: number } } }> };
      expect(body.participations, `${query} ${JSON.stringify(extra)}`).toHaveLength(1);
      expect(body.participations[0]!.answers.scoreline.home).toBe(1);
    }
    // and the same identifiers with a request from nobody are not an identity either
    expect((await ask({}, `?gamingMemberId=${beto.memberId}`)).status).toBe(401);
  });

  it("the member of the response is the verified caller even if the repository is handed rows of others (only own rows become views)", async () => {
    const { env, repo, w } = await fresh();
    const ana = person("ana");
    const beto = person("beto");
    await submitAs(env, w, ana.memberId, { attemptedLevel: 1, scoreline: { home: 1, away: 0 } });
    await submitAs(env, w, beto.memberId, { attemptedLevel: 1, scoreline: { home: 9, away: 0 } });
    const leaky = Object.create(repo) as InMemoryPredictionsRepository;
    leaky.listPredictionsForMember = async () => [...(await repo.listPredictionsForMatch(w.matchId))]; // returns BOTH members' rows
    const { participations: views } = await buildMemberParticipations(leaky, ana.memberId);
    expect(views).toHaveLength(1);
    expect(views[0]!.answers.scoreline).toEqual({ home: 1, away: 0 });
  });

  it("whatever the repository returns, the ids that reach the batch reads are only those of the caller's own rows", async () => {
    const { env, repo, w } = await fresh();
    const other = await buildLadderWorld(env, { offeredLevels: [1, 2, 3, 4] });
    const ana = person("ana");
    const beto = person("beto");
    await submitAs(env, w, ana.memberId, { attemptedLevel: 1, scoreline: { home: 1, away: 0 } });
    await submitAs(env, other, beto.memberId, { attemptedLevel: 1, scoreline: { home: 9, away: 0 } });
    const seen: Record<string, string[][]> = {};
    const spy = new Proxy(repo, {
      get(target, property) {
        const value = (target as unknown as Record<string, unknown>)[property as string];
        if (typeof value !== "function") return value;
        if (property === "listPredictionsForMember") {
          return async () => [...(await repo.listPredictionsForMatch(w.matchId)), ...(await repo.listPredictionsForMatch(other.matchId))]; // BOTH members' rows
        }
        return (...args: unknown[]) => {
          (seen[String(property)] ??= []).push(args.filter(Array.isArray).flat() as string[]);
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    }) as InMemoryPredictionsRepository;
    const { participations } = await buildMemberParticipations(spy, ana.memberId);
    expect(participations).toHaveLength(1);
    const ids = Object.values(seen).flat(2);
    expect(ids).toContain(w.matchId);
    for (const foreign of [other.matchId, other.activationId, beto.memberId]) expect(ids, foreign).not.toContain(foreign);
  });
});

describe("no session, no data", () => {
  it("401 and no repository read for: no header, a non-bearer header, an unknown token, and an identity without a finished profile", async () => {
    await fresh();
    const unfinished = person("unfinished", false);
    for (const headers of [{}, { authorization: "Basic abc" }, { authorization: "Bearer unknown" }, unfinished.header]) {
      world.calls.length = 0;
      const response = await ask(headers);
      expect(response.status, JSON.stringify(headers)).toBe(401);
      expect(await response.json()).toEqual({ error: "A valid Authorization header for an authenticated Gaming Member is required." });
      expect(world.calls, JSON.stringify(headers)).toEqual([]);
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });

  it("answers 500 without credentials configured, never a guess", async () => {
    await fresh();
    const ana = person("ana");
    delete process.env.SUPABASE_URL;
    expect((await ask(ana.header)).status).toBe(500);
  });

  it("every answer is private and per request: no-store", async () => {
    await fresh();
    const ana = person("ana");
    const ok = await ask(ana.header);
    expect(ok.status).toBe(200);
    expect(ok.headers.get("cache-control")).toBe("no-store");
  });

  it("only GET exists, and the route reads no body", async () => {
    const mod = await import("@/app/api/gaming/predictions/participations/route");
    expect(Object.keys(mod).filter((key) => ["GET", "POST", "PUT", "PATCH", "DELETE"].includes(key))).toEqual(["GET"]);
    const source = readFileSync(path.join(process.cwd(), "app/api/gaming/predictions/participations/route.ts"), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(source).not.toMatch(/request\.(json|text|formData|url)|searchParams|headers\.get/);
  });
});

describe("what is sent, what state the window is in, and what was evaluated are different things", () => {
  it("a sent level is not a prize won: before any evaluation the participation says so, and the level sent is its own field", async () => {
    const { env, w } = await fresh();
    const ana = person("ana");
    await submitAs(env, w, ana.memberId, answersFor(w, 4, { S: true, F: true, G: true, M: true }));
    const [participation] = ((await (await ask(ana.header)).json()) as { participations: any[] }).participations;
    expect(participation.attemptedLevel).toBe(4);
    expect(participation.evaluation).toEqual({ evaluated: false });
    expect(participation.state).toBe("OPEN");
    expect(participation.editable).toBe(true);
    expect("reachedLevel" in participation).toBe(false);
    expect(JSON.stringify(participation)).not.toMatch(/won|prize|premio/i);
  });

  it("after the evaluation, the level it reached is reported separately from the level sent (sent 4, reached 2)", async () => {
    const { env, w } = await fresh();
    const ana = person("ana");
    await submitAs(env, w, ana.memberId, answersFor(w, 4, { S: true, F: true, G: false, M: true }));
    await settle(env, w, "TWO_ONE");
    const [participation] = ((await (await ask(ana.header)).json()) as { participations: any[] }).participations;
    expect(participation.attemptedLevel).toBe(4);
    expect(participation.evaluation.evaluated).toBe(true);
    expect(participation.evaluation.reachedLevel).toBe(2);
    expect(participation.editable).toBe(false);
    expect(participation.editBlockedReason).toBe("EVALUATED");
    expect(Object.keys(participation.evaluation).sort()).toEqual(["evaluated", "evaluatedAt", "reachedLevel"]);
  });

  it("the window state follows the match only: open, closed once it started, cancelled", async () => {
    const { env, repo, w } = await fresh();
    const ana = person("ana");
    await submitAs(env, w, ana.memberId, answersFor(w, 1, { S: true, F: true, G: true, M: true }));
    const state = async () => ((await (await ask(ana.header)).json()) as { participations: any[] }).participations[0];
    expect(await state()).toMatchObject({ state: "OPEN", editable: true, editBlockedReason: null });
    const match = (await repo.getMatchById(w.matchId))!;
    await repo.editMatch(w.matchId, { homeTeamId: match.homeTeamId, awayTeamId: match.awayTeamId, competition: match.competition, kickoffAt: new Date(Date.now() - 1000).toISOString() });
    expect(await state()).toMatchObject({ state: "CLOSED", editable: false, editBlockedReason: "MATCH_STARTED" });
    await repo.cancelMatch(w.matchId);
    expect(await state()).toMatchObject({ state: "CANCELLED", editable: false, editBlockedReason: "MATCH_CANCELLED", match: { cancelled: true } });
  });

  it("carries the venue name, the teams, the answers in their explicit form, and 'edited' only after a real edit", async () => {
    const { env, w } = await fresh();
    const ana = person("ana");
    await submitAs(env, w, ana.memberId, { attemptedLevel: 3, scoreline: { home: 2, away: 1 }, firstTeam: { kind: "PICKED", team: "HOME" }, goalscorer: { kind: "PICKED", playerId: w.players.mbappe } });
    let participation = ((await (await ask(ana.header)).json()) as { participations: any[] }).participations[0];
    expect(participation.venueName).toEqual(expect.any(String));
    expect(participation.match.homeTeam).toEqual(expect.any(String));
    expect(participation.answers.firstTeam).toEqual({ kind: "PICKED", team: "HOME" });
    expect(participation.answers.goalscorer).toEqual({ kind: "PICKED", playerName: "Mbappe", jerseyNumber: null }); // a player added by hand has no squad number
    expect("goalMinute" in participation.answers).toBe(false); // not attempted is not NONE
    expect(participation.lastChangedAt).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 1100));
    await submitAs(env, w, ana.memberId, { attemptedLevel: 2, scoreline: { home: 2, away: 1 }, firstTeam: { kind: "PICKED", team: "AWAY" } });
    participation = ((await (await ask(ana.header)).json()) as { participations: any[] }).participations[0];
    expect(participation.attemptedLevel).toBe(2);
    expect(participation.lastChangedAt).toEqual(expect.any(String));
    expect("goalscorer" in participation.answers).toBe(false);
  });

  it("carries the scorer's squad number when the roster has one, and nothing else about the player: no position, no source, no date", async () => {
    const { env, repo, w } = await fresh();
    const ana = person("ana");
    await submitAs(env, w, ana.memberId, { attemptedLevel: 3, scoreline: { home: 2, away: 1 }, firstTeam: { kind: "PICKED", team: "HOME" }, goalscorer: { kind: "PICKED", playerId: w.players.mbappe } });
    repo.setRosterFields(w.players.mbappe, { jerseyNumber: 10, position: "DEL", rosterSource: "realmadrid.com · First team · Players — https://www.realmadrid.com/en-US/football/first-team/players", rosterConsultedOn: "2026-10-24" });
    const body = (await (await ask(ana.header)).json()) as { participations: any[] };
    expect(body.participations[0].answers.goalscorer).toEqual({ kind: "PICKED", playerName: "Mbappe", jerseyNumber: 10 });
    const raw = JSON.stringify(body);
    expect(raw).not.toMatch(/"position"|DEL|rosterSource|rosterConsultedOn|realmadrid\.com|2026-10-24/);
  });

  it("a participation under the historical contract has no level and no categories of the ladder", async () => {
    const { repo, env, w } = await fresh();
    const ana = person("ana");
    await submitAs(env, w, ana.memberId, answersFor(w, 1, { S: true, F: true, G: true, M: true }));
    const map = (repo as unknown as { predictions: Map<string, Record<string, unknown>> }).predictions;
    const [id] = [...map.keys()];
    map.set(id!, { ...map.get(id!)!, predictionContract: "COMPLETE_COUNT_V1", attemptedLevel: null, firstTeamState: null, goalscorerState: null, goalMinuteState: null });
    const [participation] = ((await (await ask(ana.header)).json()) as { participations: any[] }).participations;
    expect(participation.contract).toBe("COMPLETE_COUNT_V1");
    expect(participation.attemptedLevel).toBeNull();
    expect(Object.keys(participation.answers)).toEqual(["scoreline"]);
  });

  it("is ordered newest first, limited to 50, and says whether there are older ones", async () => {
    const { repo, env, w } = await fresh([1]);
    const ana = person("ana");
    await submitAs(env, w, ana.memberId, answersFor(w, 1, { S: true, F: true, G: true, M: true }));
    const map = (repo as unknown as { predictions: Map<string, Record<string, unknown>>; matches: Map<string, Record<string, unknown>> }).predictions;
    const matches = (repo as unknown as { matches: Map<string, Record<string, unknown>> }).matches;
    const template = [...map.values()][0]!;
    const grow = (extra: number) => {
      for (let i = 0; i < extra; i += 1) {
        const id = randomUUID();
        const matchId = randomUUID();
        matches.set(matchId, { ...matches.get(w.matchId)!, matchId });
        map.set(id, { ...template, predictionId: id, matchId, createdAt: new Date(Date.now() - (map.size + 1) * 60_000).toISOString(), updatedAt: new Date(Date.now() - (map.size + 1) * 60_000).toISOString() });
      }
    };
    const body = async () => (await (await ask(ana.header)).json()) as { participations: Array<{ sentAt: string }>; limit: number; truncated: boolean };
    expect(await body()).toMatchObject({ limit: 50, truncated: false });
    grow(48); // 49 in all
    expect(await body()).toMatchObject({ limit: 50, truncated: false });
    grow(1); // exactly 50: all of them, and nothing older
    let current = await body();
    expect(current.participations).toHaveLength(50);
    expect(current.truncated).toBe(false);
    grow(1); // 51: the oldest one is not shown, and the answer says so
    current = await body();
    expect(current.participations).toHaveLength(50);
    expect(current.truncated).toBe(true);
    grow(9);
    current = await body();
    expect(current.participations).toHaveLength(50);
    expect(current.truncated).toBe(true);
    expect(current.limit).toBe(50);
    const times = current.participations.map((view) => view.sentAt);
    expect([...times].sort().reverse()).toEqual(times);
  });

  it("the cap of the builder is the one it reports, and it never exceeds 50", async () => {
    const { repo, env, w } = await fresh([1]);
    const ana = person("ana");
    await submitAs(env, w, ana.memberId, answersFor(w, 1, { S: true, F: true, G: true, M: true }));
    expect(await buildMemberParticipations(repo, ana.memberId, new Date(), 5)).toMatchObject({ limit: 5, truncated: false });
    expect(await buildMemberParticipations(repo, ana.memberId, new Date(), 500)).toMatchObject({ limit: 50 });
    expect(await buildMemberParticipations(repo, ana.memberId, new Date(), 0)).toMatchObject({ limit: 1 });
  });
});

describe("what the answer never carries", () => {
  it("no coordinates, distance, accuracy, geolocation evidence, fingerprint or identifier of any member or of the prediction", async () => {
    const { env, w } = await fresh();
    const ana = person("ana");
    const beto = person("beto");
    await submitAs(env, w, ana.memberId, answersFor(w, 4, { S: true, F: true, G: true, M: true }));
    await submitAs(env, w, beto.memberId, answersFor(w, 2, { S: true, F: true, G: true, M: true }));
    await settle(env, w, "TWO_ONE");
    const text = JSON.stringify(await (await ask(ana.header)).json());
    const keys = new Set<string>();
    const walk = (value: unknown) => {
      if (Array.isArray(value)) value.forEach(walk);
      else if (value && typeof value === "object") for (const [key, inner] of Object.entries(value)) { keys.add(key); walk(inner); }
    };
    walk(JSON.parse(text));
    for (const forbidden of ["latitude", "longitude", "measuredDistanceMeters", "reportedAccuracyMeters", "geoVerifiedAt", "geoEligible", "acceptedOfferDigest", "acceptedOfferMaxLevel", "predictionId", "gamingMemberId", "venueActivationId", "evaluationId", "matchResultId", "digest"]) {
      expect(keys.has(forbidden), forbidden).toBe(false);
    }
    expect(text).not.toContain(ana.memberId);
    expect(text).not.toContain(beto.memberId);
    expect(text).not.toMatch(/"distance|"accuracy|coordinate/i);
    expect(text).not.toMatch(/member-/); // no member id of anyone, in any field
  });

  it("building it reads no match result, no Gaming XP, no prize qualification and no redemption, and writes nothing", async () => {
    const { env, w } = await fresh();
    const ana = person("ana");
    await submitAs(env, w, ana.memberId, answersFor(w, 3, { S: true, F: true, G: true, M: true }));
    await settle(env, w, "TWO_ONE"); // there IS a finalized result, an evaluation, a qualification and XP-side data to be tempted by
    world.calls.length = 0;
    expect((await ask(ana.header)).status).toBe(200);
    expect(world.calls.length).toBeGreaterThan(0);
    const called = new Set(world.calls);
    for (const name of called) {
      expect(name, name).not.toMatch(/Result|Qualification|Xp|XP|Progression|Experience|Redeem|Redemption|Hold|Delivery|Standing|Leaderboard/);
      expect(name, name).not.toMatch(/^(create|upsert|save|set|finalize|correct|edit|cancel|add|delete|release|confirm|record)/);
    }
    expect([...called].sort()).toEqual(
      ["getCurrentEvaluationsForPredictions", "getMatchesByIds", "getPlayersByIds", "getTeamsByIds", "getVenueActivationsByIds", "getVenuesByIds", "listPredictionsForMember", "listPrizeTiersForActivations"].filter((name) => called.has(name)).sort()
    );
  });
});

describe("editable follows what a new edit would really meet", () => {
  const first = async (header: Record<string, string>) => ((await (await ask(header)).json()) as { participations: any[] }).participations[0];
  async function member(levels = [1, 2, 3, 4]) {
    const f = await fresh(levels);
    const ana = person("ana");
    await submitAs(f.env, f.w, ana.memberId, answersFor(f.w, 3, { S: true, F: true, G: true, M: true }));
    return { ...f, ana };
  }

  it("an open participation on an enabled, available venue with a valid offer is editable, with no reason", async () => {
    const { ana } = await member();
    expect(await first(ana.header)).toMatchObject({ state: "OPEN", editable: true, editBlockedReason: null });
  });

  it("a DISABLED venue activation is not editable, says why, and the window is still open (the match has not started)", async () => {
    const { repo, w, ana } = await member();
    await repo.setVenueActivationEnabled(w.activationId, false);
    expect(await first(ana.header)).toMatchObject({ state: "OPEN", editable: false, editBlockedReason: "ACTIVATION_DISABLED" });
    await repo.setVenueActivationEnabled(w.activationId, true);
    expect(await first(ana.header)).toMatchObject({ editable: true, editBlockedReason: null });
  });

  it("a venue that is not available, and an offer that is no longer valid, are not editable either, each with its own reason", async () => {
    const { repo, w, ana } = await member();
    const venues = (repo as unknown as { venues: Map<string, { active: boolean }> }).venues;
    const activation = (await repo.getVenueActivationById(w.activationId))!;
    venues.get(activation.venueId)!.active = false;
    expect(await first(ana.header)).toMatchObject({ editable: false, editBlockedReason: "VENUE_UNAVAILABLE" });
    venues.get(activation.venueId)!.active = true;
    const tiers = (repo as unknown as { prizeTiers: Map<string, { venueActivationId: string; ladderLevel: number | null }> }).prizeTiers;
    const removed = [...tiers.entries()].filter(([, tier]) => tier.venueActivationId === w.activationId && tier.ladderLevel === 1);
    for (const [id] of removed) tiers.delete(id); // level 1 gone: the offer no longer starts at Easy
    expect(await first(ana.header)).toMatchObject({ editable: false, editBlockedReason: "OFFER_UNAVAILABLE" });
  });

  it("the reasons are explained in a fixed order: the match first, then what was evaluated, then the venue's side", async () => {
    const { repo, env, w, ana } = await member();
    await repo.setVenueActivationEnabled(w.activationId, false);
    const venues = (repo as unknown as { venues: Map<string, { active: boolean }> }).venues;
    venues.get((await repo.getVenueActivationById(w.activationId))!.venueId)!.active = false;
    expect((await first(ana.header)).editBlockedReason).toBe("ACTIVATION_DISABLED"); // disabled before unavailable
    await repo.cancelMatch(w.matchId);
    expect((await first(ana.header)).editBlockedReason).toBe("MATCH_CANCELLED"); // the match before the venue
    void env;
  });

  it("an exact repeat of what is saved is not an edit: it is still answered with the stored row when editing is no longer possible; a changed answer is refused", async () => {
    const { env, repo, w, ana } = await member();
    const saved = answersFor(w, 3, { S: true, F: true, G: true, M: true });
    const stored = await repo.getPredictionForMember(w.matchId, ana.memberId);
    await repo.setVenueActivationEnabled(w.activationId, false);
    expect((await first(ana.header)).editable).toBe(false);
    const replay = await submitAs(env, w, ana.memberId, saved); // identical request, activation disabled
    expect(replay.predictionId).toBe(stored!.predictionId);
    expect(replay.updatedAt).toBe(stored!.updatedAt); // nothing was written
    await expect(submitAs(env, w, ana.memberId, { ...saved, scoreline: { home: 7, away: 0 } })).rejects.toThrow(/not currently enabled|disabled/i); // a real edit is refused
    expect((await repo.getPredictionForMember(w.matchId, ana.memberId))!.updatedAt).toBe(stored!.updatedAt);
  });
});

describe("the cost of the history does not grow with the number of participations", () => {
  async function history(count: number) {
    const f = await fresh([1, 2, 3, 4]);
    const ana = person("ana");
    await submitAs(f.env, f.w, ana.memberId, answersFor(f.w, 3, { S: true, F: true, G: true, M: true }));
    for (let i = 1; i < count; i += 1) {
      const world2 = await buildLadderWorld(f.env, { offeredLevels: [1, 2, 3, 4] });
      await submitAs(f.env, world2, ana.memberId, answersFor(world2, 3, { S: true, F: true, G: true, M: true }));
      await new Promise((r) => setTimeout(r, 1)); // distinct creation times, so the order is defined
    }
    return { ...f, ana };
  }

  it("1 participation and 50 cost exactly the same requests: one per kind, never one per participation", async () => {
    const counts: Record<string, number> = {};
    const byName: Record<number, string[]> = {};
    for (const count of [1, 50]) {
      const { ana } = await history(count);
      world.calls.length = 0;
      const body = (await (await ask(ana.header)).json()) as { participations: unknown[] };
      expect(body.participations).toHaveLength(count);
      counts[count] = world.calls.length;
      byName[count] = [...world.calls].sort();
    }
    expect(counts[50]).toBe(counts[1]);
    expect(byName[50]).toEqual(byName[1]);
    expect(counts[1]).toBeLessThanOrEqual(8);
    // each batch read is made at most once
    for (const name of new Set(byName[50])) expect(byName[50]!.filter((n) => n === name).length, name).toBe(1);
  });

  it("an empty history costs one request, and a history with no scorer picked does not ask for players", async () => {
    const { ana } = await history(1);
    const nobody = person("nobody");
    world.calls.length = 0;
    await ask(nobody.header);
    expect(world.calls).toEqual(["listPredictionsForMember"]);
    // Ana picked no goalscorer at level 1
    const { env, w } = await fresh();
    const solo = person("solo");
    await submitAs(env, w, solo.memberId, { attemptedLevel: 1, scoreline: { home: 1, away: 0 } });
    world.calls.length = 0;
    await ask(solo.header);
    expect(world.calls).not.toContain("getPlayersByIds");
    expect(world.calls.filter((name) => name === "getPlayersByIds").length).toBeLessThanOrEqual(1);
    void ana;
  });
});
