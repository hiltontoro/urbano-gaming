import { beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

import { InMemoryPredictionsRepository } from "../lib/gaming/predictions/db/inMemoryPredictionsRepository";
import { InMemoryLegalAcceptanceRepository } from "../lib/gaming/legal/db/inMemoryLegalAcceptanceRepository";
import { NEAR, buildLadderWorld, offerDigestOf, submitAs, type LadderEnv, type LadderWorld } from "./helpers/progressiveLadderScenarios";
import { acceptEverything, fixtureRegistry, fixtureRegistryWithNewVersion } from "./helpers/legalFixtures";
import type { LegalDocumentEntry } from "../lib/gaming/legal/types";

/**
 * THE CONDITIONS, AT THE DOOR. These tests drive the REAL predict route (only authentication and the repositories' wiring are stood in
 * for). They prove what the page cannot: a new participation or a real edit needs the current conditions, whatever the page shows; an exact
 * replay of a participation that already exists is not an admission and needs nothing; the real registry ships empty, so nobody is admitted
 * until a text is approved.
 */

vi.mock("@/lib/gaming/predictions/httpAuth", async () => {
  const actual = await vi.importActual<typeof import("../lib/gaming/predictions/httpAuth")>("../lib/gaming/predictions/httpAuth");
  return { ...actual, getSupabaseCredentials: vi.fn(), buildPredictionsRepo: vi.fn(), requireGamingMember: vi.fn() };
});
vi.mock("@/lib/gaming/legal/httpLegal", async () => {
  const actual = await vi.importActual<typeof import("../lib/gaming/legal/httpLegal")>("../lib/gaming/legal/httpLegal");
  return { ...actual, buildLegalRepo: vi.fn(), currentLegalRegistry: vi.fn() };
});
import * as httpAuth from "../lib/gaming/predictions/httpAuth";
import * as httpLegal from "../lib/gaming/legal/httpLegal";

const post = (body: unknown) =>
  new Request("http://localhost/api/gaming/predictions/matches/x/predict", { method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body) });

interface Rig {
  repo: InMemoryPredictionsRepository;
  legal: InMemoryLegalAcceptanceRepository;
  w: LadderWorld;
  env: LadderEnv;
  kickoffAt: string;
  match: { matchId: string; kickoffAt: string };
  digest: string;
  registry: LegalDocumentEntry[];
  as(memberId: string): void;
  send(answers?: { home?: number; away?: number }, level?: number): Promise<{ status: number; body: any }>;
}

async function rig(): Promise<Rig> {
  const repo = new InMemoryPredictionsRepository();
  repo.authorityRepository.seedAuthority("finalizer", "CONSEQUENTIAL_FINALIZER");
  const env: LadderEnv = { repo, newMember: async (label) => `${label}-${randomUUID().slice(0, 8)}`, finalizerId: "finalizer", operatorId: "finalizer" };
  const w = await buildLadderWorld(env, { offeredLevels: [1, 2, 3, 4] });
  const kickoffAt = (await repo.getMatchById(w.matchId))!.kickoffAt;
  const legal = new InMemoryLegalAcceptanceRepository();
  const registry = fixtureRegistry(kickoffAt);
  vi.mocked(httpAuth.getSupabaseCredentials).mockReturnValue({ url: "http://127.0.0.1:1", serviceKey: "x" });
  vi.mocked(httpAuth.buildPredictionsRepo).mockReturnValue(repo as never);
  vi.mocked(httpLegal.buildLegalRepo).mockReturnValue(legal as never);
  vi.mocked(httpLegal.currentLegalRegistry).mockReturnValue(registry);
  const digest = (await offerDigestOf(env, w))!;
  const POST = (await import("../app/api/gaming/predictions/matches/[matchId]/predict/route")).POST;
  const self = {
    repo, legal, w, env, kickoffAt, match: { matchId: w.matchId, kickoffAt }, digest, registry,
    as(memberId: string) { vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ gamingMemberId: memberId } as never); },
    async send(answers: { home?: number; away?: number } = {}, level = 1) {
      const res = await POST(
        post({ venueActivationId: w.activationId, offerDigest: digest, attemptedLevel: level, scoreline: { home: answers.home ?? 1, away: answers.away ?? 0 }, latitude: NEAR.latitude, longitude: NEAR.longitude, accuracyMeters: 5 }),
        { params: { matchId: w.matchId } }
      );
      return { status: res.status, body: await res.json() };
    },
  } as Rig;
  return self;
}

beforeEach(() => { vi.clearAllMocks(); });

describe("an empty registry admits nobody", () => {
  it("with nothing published, a new participation is refused 409 'not published', naming the three texts, and nothing is stored", async () => {
    const r = await rig();
    vi.mocked(httpLegal.currentLegalRegistry).mockReturnValue([]);
    r.as("ana");
    const res = await r.send();
    expect(res.status).toBe(409);
    expect(res.body.code).toBe("LEGAL_DOCUMENTS_NOT_PUBLISHED");
    expect(res.body.error).toBe("The conditions for this event have not been published yet.");
    expect(res.body.missing.map((m: any) => m.documentKey)).toEqual(["ACCOUNT_TERMS", "PRIVACY_NOTICE", "EVENT_RULES"]);
    expect(await r.repo.getPredictionForMember(r.w.matchId, "ana")).toBeNull();
  });

  it("and no acceptance on file helps while a text is unpublished", async () => {
    const r = await rig();
    r.as("ana");
    await acceptEverything(r.legal, r.registry, r.match, "ana");
    vi.mocked(httpLegal.currentLegalRegistry).mockReturnValue(r.registry.filter((e) => e.key !== "EVENT_RULES"));
    expect((await r.send()).body.code).toBe("LEGAL_DOCUMENTS_NOT_PUBLISHED");
    expect(await r.repo.getPredictionForMember(r.w.matchId, "ana")).toBeNull();
  });
});

describe("a new participation needs the current conditions", () => {
  it("is refused 409 'required' with what is missing and the version of each, and nothing is stored", async () => {
    const r = await rig();
    r.as("ana");
    const res = await r.send();
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: "LEGAL_CONDITIONS_REQUIRED", error: "The current conditions must be accepted before taking part." });
    expect(res.body.missing).toEqual([
      { documentKey: "ACCOUNT_TERMS", documentVersion: "fixture-1" },
      { documentKey: "PRIVACY_NOTICE", documentVersion: "fixture-1" },
      { documentKey: "EVENT_RULES", documentVersion: "fixture-1" },
    ]);
    expect(await r.repo.getPredictionForMember(r.w.matchId, "ana")).toBeNull();
  });

  it("is refused while one of the three is still to do, and accepted once all are done", async () => {
    const r = await rig();
    r.as("ana");
    const { acceptConditions } = await import("../lib/gaming/legal/requirements");
    const [terms, privacy, rules] = r.registry;
    await acceptConditions(r.legal, r.registry, r.match, "ana", [{ documentKey: "ACCOUNT_TERMS", documentVersion: terms.version, contentSha256: terms.sha256 }]);
    expect((await r.send()).status).toBe(409);
    await acceptConditions(r.legal, r.registry, r.match, "ana", [{ documentKey: "PRIVACY_NOTICE", documentVersion: privacy.version, contentSha256: privacy.sha256 }]);
    expect((await r.send()).body.missing).toEqual([{ documentKey: "EVENT_RULES", documentVersion: "fixture-1" }]);
    await acceptConditions(r.legal, r.registry, r.match, "ana", [{ documentKey: "EVENT_RULES", documentVersion: rules.version, contentSha256: rules.sha256, ageDeclared18: true }]);
    const ok = await r.send();
    expect(ok.status).toBe(201);
    expect((await r.repo.getPredictionForMember(r.w.matchId, "ana"))!.attemptedLevel).toBe(1);
  });

  it("is judged for the caller only: what ana accepted does not admit beto", async () => {
    const r = await rig();
    await acceptEverything(r.legal, r.registry, r.match, "ana");
    r.as("ana");
    expect((await r.send()).status).toBe(201);
    r.as("beto");
    expect((await r.send()).status).toBe(409);
    expect(await r.repo.getPredictionForMember(r.w.matchId, "beto")).toBeNull();
  });

  it("does not take a member id from the request: only the verified caller counts", async () => {
    const r = await rig();
    await acceptEverything(r.legal, r.registry, r.match, "ana");
    r.as("beto");
    const POST = (await import("../app/api/gaming/predictions/matches/[matchId]/predict/route")).POST;
    const res = await POST(post({ venueActivationId: r.w.activationId, offerDigest: r.digest, attemptedLevel: 1, scoreline: { home: 1, away: 0 }, latitude: NEAR.latitude, longitude: NEAR.longitude, gamingMemberId: "ana" }), { params: { matchId: r.w.matchId } });
    expect(res.status).toBe(400); // an unexpected field, as always
    expect(await r.repo.getPredictionForMember(r.w.matchId, "ana")).toBeNull();
  });

  it("the historical contract is an admission too: refused without the conditions, accepted with them", async () => {
    const r = await rig();
    const match = await r.repo.createMatch({ homeTeamId: r.w.homeTeamId, awayTeamId: r.w.awayTeamId, competition: "Historical", kickoffAt: new Date(Date.now() + 7200_000).toISOString() });
    await r.repo.setMatchActivityClassification(match.matchId, "TRAINING", "finalizer", null);
    const activation = await r.repo.createVenueActivation({ matchId: match.matchId, venueId: r.w.venueId });
    const registry = fixtureRegistry(match.kickoffAt);
    vi.mocked(httpLegal.currentLegalRegistry).mockReturnValue(registry);
    r.as("ana");
    const POST = (await import("../app/api/gaming/predictions/matches/[matchId]/predict/route")).POST;
    const body = { venueActivationId: activation.venueActivationId, predictedHomeScore: 1, predictedAwayScore: 0, predictedGoalscorerPlayerId: null, predictedGoalMinuteRegulation: null, predictedGoalMinuteStoppage: null, predictedFirstTeamToScore: null, latitude: NEAR.latitude, longitude: NEAR.longitude, accuracyMeters: 5 };
    const refused = await POST(post(body), { params: { matchId: match.matchId } });
    expect(refused.status).toBe(409);
    expect((await refused.json()).code).toBe("LEGAL_CONDITIONS_REQUIRED");
    await acceptEverything(r.legal, registry, { matchId: match.matchId, kickoffAt: match.kickoffAt }, "ana");
    expect((await POST(post(body), { params: { matchId: match.matchId } })).status).toBe(201);
  });
});

describe("a participation that already exists", () => {
  it("an exact replay is not an admission: it is answered even when the registry is empty, and nothing about the stored participation changes", async () => {
    const r = await rig();
    r.as("ana");
    await acceptEverything(r.legal, r.registry, r.match, "ana");
    expect((await r.send()).status).toBe(201);
    const stored = await r.repo.getPredictionForMember(r.w.matchId, "ana");
    vi.mocked(httpLegal.currentLegalRegistry).mockReturnValue([]);
    const replay = await r.send();
    expect(replay.status).toBe(201);
    expect(await r.repo.getPredictionForMember(r.w.matchId, "ana")).toEqual(stored);
  });

  it("after a new version is published, the replay still goes through without accepting it, but a REAL edit needs the new version", async () => {
    const r = await rig();
    r.as("ana");
    await acceptEverything(r.legal, r.registry, r.match, "ana");
    await r.send({ home: 1 });
    const stored = await r.repo.getPredictionForMember(r.w.matchId, "ana");
    const v2 = fixtureRegistryWithNewVersion(r.kickoffAt);
    vi.mocked(httpLegal.currentLegalRegistry).mockReturnValue(v2);

    expect((await r.send({ home: 1 })).status).toBe(201); // the same answer again: a replay
    expect(await r.repo.getPredictionForMember(r.w.matchId, "ana")).toEqual(stored);

    const edit = await r.send({ home: 2 }); // a different answer: an edit, an admission
    expect(edit.status).toBe(409);
    expect(edit.body.code).toBe("LEGAL_CONDITIONS_REQUIRED");
    expect(edit.body.missing.every((m: any) => m.documentVersion === "fixture-2")).toBe(true);
    expect((await r.repo.getPredictionForMember(r.w.matchId, "ana"))!.predictedHomeScore).toBe(1);

    await acceptEverything(r.legal, v2, r.match, "ana");
    expect((await r.send({ home: 2 })).status).toBe(201);
    expect((await r.repo.getPredictionForMember(r.w.matchId, "ana"))!.predictedHomeScore).toBe(2);
  });

  it("a participation made before any conditions existed keeps its replay, and cannot be edited until the conditions are accepted", async () => {
    const r = await rig();
    // made through the domain write path with no gate, as every participation was before this change
    await submitAs(r.env, r.w, "ana", { attemptedLevel: 1, scoreline: { home: 1, away: 0 } });
    const stored = await r.repo.getPredictionForMember(r.w.matchId, "ana");
    r.as("ana");
    expect((await r.send({ home: 1 })).status).toBe(201); // the replay: not a new admission, and nothing recorded for her
    expect(await r.legal.listForMember("ana")).toEqual([]);
    expect(await r.repo.getPredictionForMember(r.w.matchId, "ana")).toEqual(stored);
    const edit = await r.send({ home: 3 });
    expect(edit.status).toBe(409);
    expect(edit.body.code).toBe("LEGAL_CONDITIONS_REQUIRED");
    expect((await r.repo.getPredictionForMember(r.w.matchId, "ana"))!.predictedHomeScore).toBe(1);
  });

  it("a replay by the member who has the participation does not open the door for anyone else", async () => {
    const r = await rig();
    await submitAs(r.env, r.w, "ana", { attemptedLevel: 1, scoreline: { home: 1, away: 0 } });
    r.as("beto");
    const res = await r.send({ home: 1 }); // the same answer, but beto has no participation: it is new
    expect(res.status).toBe(409);
    expect(await r.repo.getPredictionForMember(r.w.matchId, "beto")).toBeNull();
  });
});
