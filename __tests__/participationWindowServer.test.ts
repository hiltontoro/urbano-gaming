import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";

import { InMemoryPredictionsRepository } from "../lib/gaming/predictions/db/inMemoryPredictionsRepository";
import { APPROVED_PARTICIPATION_WINDOWS, assertParticipationOpen, participationOpensAt } from "../lib/gaming/predictions/participationWindow";
import { ParticipationNotOpenError } from "../lib/gaming/predictions/types";
import { statusForPredictionsError } from "../lib/gaming/predictions/httpAuth";
import { NEAR, buildLadderWorld, offerDigestOf, type LadderEnv } from "./helpers/progressiveLadderScenarios";
import { InMemoryLegalAcceptanceRepository } from "../lib/gaming/legal/db/inMemoryLegalAcceptanceRepository";
import { acceptEverything, fixtureRegistry } from "./helpers/legalFixtures";

/**
 * THE PARTICIPATION WINDOW, ENFORCED BY THE SERVER. Approved for El Clásico: 25 October 2026, 12:30 p. m. to 2:00 p. m. Honduras time — it opens 90
 * minutes before the start and closes when the match starts. These tests drive the REAL predict route (only authentication and the repository's
 * wiring are stood in for) with the clock set around the opening, and prove: a request before 12:30 is refused by the server whatever a page shows;
 * from 12:30 the window alone still opens nothing (the venue activation must be enabled by a person); the start closes it, as it always did; and
 * a match that starts at any other instant is not touched. The refusal says "not yet", never "no".
 */

vi.mock("@/lib/gaming/predictions/httpAuth", async () => {
  const actual = await vi.importActual<typeof import("../lib/gaming/predictions/httpAuth")>("../lib/gaming/predictions/httpAuth");
  return { ...actual, getSupabaseCredentials: vi.fn(), buildPredictionsRepo: vi.fn(), requireGamingMember: vi.fn() };
});
// The conditions (legal texts) are not what this file is about: a member who has accepted the fixture texts is admitted, so the window is what is judged.
vi.mock("@/lib/gaming/legal/httpLegal", async () => {
  const actual = await vi.importActual<typeof import("../lib/gaming/legal/httpLegal")>("../lib/gaming/legal/httpLegal");
  return { ...actual, buildLegalRepo: vi.fn(), currentLegalRegistry: vi.fn() };
});
import * as httpAuth from "../lib/gaming/predictions/httpAuth";
import * as httpLegal from "../lib/gaming/legal/httpLegal";

const CLASICO = "2026-10-25T20:00:00.000Z"; // 2:00 p. m., Honduras
const kickoff = new Date(CLASICO).getTime();
const MIN = 60_000;
const OPENS = kickoff - 90 * MIN; // 12:30 p. m., Honduras
const NOT_OPEN_MESSAGE = "Participation for this match has not opened yet.";

describe("the rule itself", () => {
  it("opens 90 minutes before the approved start: 12:30 p. m. in Honduras, 18:30 UTC", () => {
    const opens = participationOpensAt(CLASICO)!;
    expect(opens.toISOString()).toBe("2026-10-25T18:30:00.000Z");
    expect(new Intl.DateTimeFormat("en-GB", { timeZone: "America/Tegucigalpa", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(opens)).toBe("12:30");
    expect(APPROVED_PARTICIPATION_WINDOWS.map((w) => w.kickoffAt)).toEqual([CLASICO]);
  });

  it("is keyed to the exact instant: any other start, an hour either side, or one millisecond off, has no window", () => {
    for (const other of ["2026-10-25T19:00:00.000Z", "2026-10-25T21:00:00.000Z", "2026-10-25T20:00:00.001Z", "2026-10-25T19:59:59.999Z", "2026-10-26T20:00:00.000Z", "not a date", ""]) {
      expect(participationOpensAt(other), other).toBeNull();
    }
    // the same instant written another way is the same instant
    expect(participationOpensAt("2026-10-25T14:00:00-06:00")?.toISOString()).toBe("2026-10-25T18:30:00.000Z");
  });

  it("says 'not yet' only before the opening: refuses until then, and says nothing from the opening on (the start is judged elsewhere)", () => {
    expect(() => assertParticipationOpen({ kickoffAt: CLASICO }, new Date(OPENS - 1))).toThrow(ParticipationNotOpenError);
    expect(() => assertParticipationOpen({ kickoffAt: CLASICO }, new Date(OPENS))).not.toThrow();
    expect(() => assertParticipationOpen({ kickoffAt: CLASICO }, new Date(kickoff - 1))).not.toThrow();
    expect(() => assertParticipationOpen({ kickoffAt: CLASICO }, new Date(kickoff + 5 * MIN))).not.toThrow(); // after the start: the closing refuses, not this
    expect(() => assertParticipationOpen({ kickoffAt: "2026-10-26T20:00:00.000Z" }, new Date(0))).not.toThrow(); // another match: untouched
    let thrown: ParticipationNotOpenError | null = null;
    try { assertParticipationOpen({ kickoffAt: CLASICO }, new Date(OPENS - 60 * MIN)); } catch (error) { thrown = error as ParticipationNotOpenError; }
    expect(thrown?.message).toBe(NOT_OPEN_MESSAGE);
    expect(thrown?.opensAt.toISOString()).toBe("2026-10-25T18:30:00.000Z");
    expect(statusForPredictionsError(thrown)).toBe(409); // a conflict of state, like the start of the match
  });
});

describe("the public matches answer tells the page when the window opens (information; the server is what refuses)", () => {
  it("carries the opening time for the approved start and null for every other match", async () => {
    const repo = new InMemoryPredictionsRepository();
    const home = await repo.createTeam({ name: "FC Barcelona" });
    const away = await repo.createTeam({ name: "Real Madrid CF" });
    const clasico = await repo.createMatch({ homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "El Clásico", kickoffAt: CLASICO });
    const other = await repo.createMatch({ homeTeamId: away.teamId, awayTeamId: home.teamId, competition: "Otro", kickoffAt: "2026-10-26T20:00:00.000Z" });
    vi.mocked(httpAuth.getSupabaseCredentials).mockReturnValue({ url: "http://127.0.0.1:1", serviceKey: "x" });
    vi.mocked(httpAuth.buildPredictionsRepo).mockReturnValue(repo as never);
    const GET = (await import("../app/api/gaming/predictions/matches/route")).GET;
    const matches = ((await (await GET()).json()) as { matches: any[] }).matches;
    expect(matches.find((m) => m.matchId === clasico.matchId).participationOpensAt).toBe("2026-10-25T18:30:00.000Z");
    expect(matches.find((m) => m.matchId === other.matchId).participationOpensAt).toBeNull();
  });
});

describe("the predict route, with the clock around the opening", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.useRealTimers(); });

  const post = (body: unknown) =>
    new Request("http://localhost/api/gaming/predictions/matches/x/predict", { method: "POST", headers: { authorization: "Bearer t", "content-type": "application/json" }, body: JSON.stringify(body) });

  async function setup(kickoffAt = CLASICO) {
    const repo = new InMemoryPredictionsRepository();
    repo.authorityRepository.seedAuthority("finalizer", "CONSEQUENTIAL_FINALIZER");
    const env: LadderEnv = { repo, newMember: async (label) => `${label}-${randomUUID().slice(0, 8)}`, finalizerId: "finalizer", operatorId: "finalizer" };
    // the world is built with the clock a long time before the start, so these tests do not depend on the day they run
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date(kickoffAt).getTime() - 10 * 60 * MIN);
    const w = await buildLadderWorld(env, { offeredLevels: [1, 2, 3, 4], kickoffAt });
    vi.useRealTimers();
    vi.mocked(httpAuth.getSupabaseCredentials).mockReturnValue({ url: "http://127.0.0.1:1", serviceKey: "x" });
    vi.mocked(httpAuth.buildPredictionsRepo).mockReturnValue(repo as never);
    const memberId = await env.newMember("member");
    vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ gamingMemberId: memberId } as never);
    const legal = new InMemoryLegalAcceptanceRepository();
    const registry = fixtureRegistry(kickoffAt);
    vi.mocked(httpLegal.buildLegalRepo).mockReturnValue(legal as never);
    vi.mocked(httpLegal.currentLegalRegistry).mockReturnValue(registry);
    await acceptEverything(legal, registry, { matchId: w.matchId, kickoffAt }, memberId);
    const digest = (await offerDigestOf(env, w))!;
    const POST = (await import("../app/api/gaming/predictions/matches/[matchId]/predict/route")).POST;
    const send = async (at: number, homeGoals = 1) => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(at);
      const res = await POST(post({ venueActivationId: w.activationId, offerDigest: digest, attemptedLevel: 1, scoreline: { home: homeGoals, away: 0 }, latitude: NEAR.latitude, longitude: NEAR.longitude, accuracyMeters: 5 }), { params: { matchId: w.matchId } });
      vi.useRealTimers();
      return { status: res.status, body: await res.json() };
    };
    return { repo, w, memberId, send };
  }

  it("refuses before 12:30 — hours before, and the last millisecond before — with 409 and the 'not yet' message, and writes nothing", async () => {
    const { repo, w, memberId, send } = await setup();
    for (const at of [OPENS - 6 * 60 * MIN, OPENS - 90 * MIN, OPENS - MIN, OPENS - 1]) {
      const { status, body } = await send(at);
      expect(status, new Date(at).toISOString()).toBe(409);
      expect(body.error).toBe(NOT_OPEN_MESSAGE);
    }
    expect(await repo.getPredictionForMember(w.matchId, memberId)).toBeNull();
  });

  it("accepts from 12:30 exactly until the start, when the venue activation is enabled; the start itself and after are refused by the closing that always existed", async () => {
    const { repo, w, memberId, send } = await setup();
    expect((await send(OPENS)).status).toBe(201);
    expect((await repo.getPredictionForMember(w.matchId, memberId))!.attemptedLevel).toBe(1);
    expect((await send(OPENS + 45 * MIN)).status).toBe(201); // changing it while the window is open is allowed
    expect((await send(kickoff - 1)).status).toBe(201);
    // a CHANGED answer at the start or after is refused (an identical resend of what is saved is answered as a replay, as it always was)
    const atStart = await send(kickoff, 2);
    expect(atStart.status).toBe(409);
    expect(atStart.body.error).toBe("Predictions are locked for this match.");
    expect((await send(kickoff + 10 * MIN, 3)).body.error).toBe("Predictions are locked for this match.");
    expect((await repo.getPredictionForMember(w.matchId, memberId))!.predictedHomeScore).toBe(1); // nothing was changed
  });

  it("the clock alone opens nothing: at 12:30 and after, a DISABLED venue activation still refuses, and enabling it is what opens", async () => {
    const { repo, w, memberId, send } = await setup();
    await repo.setVenueActivationEnabled(w.activationId, false);
    for (const at of [OPENS, OPENS + 30 * MIN, kickoff - 1]) {
      const { status, body } = await send(at);
      expect(status, new Date(at).toISOString()).toBe(409);
      expect(body.error).not.toBe(NOT_OPEN_MESSAGE); // the window is open; what refuses is the switch nobody has turned on
    }
    expect(await repo.getPredictionForMember(w.matchId, memberId)).toBeNull();
    await repo.setVenueActivationEnabled(w.activationId, true);
    expect((await send(OPENS + 31 * MIN)).status).toBe(201);
  });

  it("and enabling the activation early does not open it early: before 12:30 the server still says 'not yet'", async () => {
    const { repo, w, memberId, send } = await setup();
    await repo.setVenueActivationEnabled(w.activationId, true);
    const { status, body } = await send(OPENS - 20 * MIN);
    expect(status).toBe(409);
    expect(body.error).toBe(NOT_OPEN_MESSAGE);
    expect(await repo.getPredictionForMember(w.matchId, memberId)).toBeNull();
  });

  it("does not touch any match that starts at another instant: it is accepted at any hour before its own start, as before", async () => {
    const other = new Date(kickoff + 24 * 60 * MIN).toISOString(); // the next day, same time
    const { send, repo, w, memberId } = await setup(other);
    const otherKickoff = new Date(other).getTime();
    expect((await send(otherKickoff - 20 * 60 * MIN)).status).toBe(201); // twenty hours before: no window for this match
    expect((await repo.getPredictionForMember(w.matchId, memberId))!.attemptedLevel).toBe(1);
    expect((await send(otherKickoff, 2)).status).toBe(409); // its own start closes it, as before
  });
});
