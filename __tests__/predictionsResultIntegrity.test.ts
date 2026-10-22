import { describe, expect, it, vi, beforeEach } from "vitest";
import { NextResponse } from "next/server";

import { InMemoryPredictionsRepository } from "../lib/gaming/predictions/db/inMemoryPredictionsRepository";
import { submitPrediction } from "../lib/gaming/predictions/submitPrediction";
import { redeemPrizeQualification } from "../lib/gaming/predictions/redeemPrizeQualification";
import { releasePrizeQualificationHold } from "../lib/gaming/predictions/releasePrizeQualificationHold";
import { finalizeMatchResult as finalizeWithDigest } from "../lib/gaming/predictions/finalizeMatchResult";
import { correctMatchResult as correctWithDigest } from "../lib/gaming/predictions/correctMatchResult";
import {
  createTeam,
  createPlayer,
  createMatch,
  editMatch,
  createVenue,
  createVenueActivation,
  createPrizeTier,
  saveMatchResultDraft,
  setMatchActivityClassification,
  setMatchXpEligibility,
} from "../lib/gaming/predictions/adminCatalog";
import {
  computeMatchResultContentDigest,
  NO_RESULT_SAVE_BASE,
} from "../lib/gaming/predictions/resultIntegrity";
import { readResultView, ResultChangedWhileLoadingError } from "../lib/gaming/predictions/resultView";
import { toMemberQualificationView } from "../lib/gaming/predictions/qualificationDetails";
import {
  InvalidMatchResultEventsError,
  InvalidMatchResultScoreError,
  InvalidOfficialGoalMinuteError,
  MatchResultBaseRequiredError,
  MatchResultBaseStaleError,
  MatchResultDigestMismatchError,
  MatchResultDigestRequiredError,
  MatchResultEventMinuteInvalidError,
  MatchResultEventsContradictScoreError,
  MatchResultIsCorrectionError,
  MatchResultScorerNotInMatchError,
  NotACorrectionError,
  PrizeAlreadyFulfilledError,
  PrizeQualificationHeldError,
  PrizeQualificationNotFoundError,
  PrizeQualificationNotHeldError,
  QualificationSupersededError,
} from "../lib/gaming/predictions/types";
import { InsufficientPlatformAuthorityError, ReasonRequiredError } from "../lib/gaming/authority/types";
import { saveResult } from "./helpers/predictionsResultFixtures";

// Mocks only the module boundary between the routes under test and the outside world (credentials, repository construction, caller
// identity and authority resolution); the repository behind it is the real in-memory implementation.
vi.mock("@/lib/gaming/predictions/httpAuth", async () => {
  const actual = await vi.importActual<typeof import("../lib/gaming/predictions/httpAuth")>("../lib/gaming/predictions/httpAuth");
  return {
    ...actual,
    getSupabaseCredentials: vi.fn(),
    buildPredictionsRepo: vi.fn(),
    requireAnyAdminAuthority: vi.fn(),
    requirePlatformAuthorityHttp: vi.fn(),
    requireGamingMember: vi.fn(),
  };
});

const INSIDE = { latitude: 10.0001, longitude: 10.0001, accuracyMeters: 5 };
const ADMIN = "gm-admin";

function futureIso(ms = 3600_000): string {
  return new Date(Date.now() + ms).toISOString();
}

/** Two teams of two players, one RANKED XP-eligible match, one venue activation. */
async function setup(prizes: Record<number, string> = { 4: "Jersey", 2: "Cap" }) {
  const repo = new InMemoryPredictionsRepository();
  repo.authorityRepository.seedAuthority(ADMIN, "CONSEQUENTIAL_FINALIZER");
  repo.authorityRepository.seedAuthority("gm-operator", "OPERATIONAL");

  const home = await createTeam(repo, { name: "Real Madrid" });
  const away = await createTeam(repo, { name: "Barcelona" });
  const third = await createTeam(repo, { name: "Atletico" });
  const mbappe = await createPlayer(repo, { teamId: home.teamId, name: "Mbappe" });
  const vini = await createPlayer(repo, { teamId: home.teamId, name: "Vini" });
  const lewa = await createPlayer(repo, { teamId: away.teamId, name: "Lewandowski" });
  const pedri = await createPlayer(repo, { teamId: away.teamId, name: "Pedri" });
  const outsider = await createPlayer(repo, { teamId: third.teamId, name: "Griezmann" });

  const match = await createMatch(repo, {
    homeTeamId: home.teamId,
    awayTeamId: away.teamId,
    competition: "Friendly",
    kickoffAt: futureIso(),
  });
  await setMatchActivityClassification(repo, match.matchId, "RANKED", ADMIN);
  await setMatchXpEligibility(repo, match.matchId, true, ADMIN);
  await repo.metagameRepository.createCategoryParticipationPolicy({
    categoryKey: "SOCCER_PREDICTIONS",
    dailyParticipationAllowance: 1000,
  });
  await repo.metagameRepository.createGamingXpRule({
    categoryKey: "SOCCER_PREDICTIONS",
    consequenceClass: "PARTICIPATION",
    performanceBandKey: null,
    points: 1,
  });
  const venue = await createVenue(repo, { name: "Test Venue", latitude: 10, longitude: 10, radiusMeters: 100 });
  const activation = await createVenueActivation(repo, { matchId: match.matchId, venueId: venue.venueId });
  const tiers: Record<number, string> = {};
  for (const [count, label] of Object.entries(prizes)) {
    const tier = await createPrizeTier(repo, {
      venueActivationId: activation.venueActivationId,
      correctDimensionCount: Number(count),
      prizeLabel: label,
    });
    tiers[Number(count)] = tier.prizeTierId;
  }
  return { repo, home, away, third, mbappe, vini, lewa, pedri, outsider, match, venue, activation, tiers };
}

type Fixture = Awaited<ReturnType<typeof setup>>;

async function predict(
  f: Fixture,
  memberId: string,
  guess: {
    home: number;
    away: number;
    scorer: string | null;
    minute: number | null;
    stoppage?: number | null;
    first: "HOME" | "AWAY" | null;
  }
) {
  return submitPrediction(f.repo, {
    matchId: f.match.matchId,
    gamingMemberId: memberId,
    venueActivationId: f.activation.venueActivationId,
    predictedHomeScore: guess.home,
    predictedAwayScore: guess.away,
    predictedGoalscorerPlayerId: guess.scorer,
    predictedGoalMinuteRegulation: guess.minute,
    predictedGoalMinuteStoppage: guess.stoppage ?? null,
    predictedFirstTeamToScore: guess.first,
    geo: INSIDE,
  });
}

/** Result A: 1-0, Mbappe 20'. Result B: 1-0, Vini 30' (a different scorer and minute). */
const resultA = (f: Fixture) => ({ home: 1, away: 0, events: [{ scorerPlayerId: f.mbappe.playerId, minuteRegulation: 20 }] });
const resultB = (f: Fixture) => ({ home: 1, away: 0, events: [{ scorerPlayerId: f.vini.playerId, minuteRegulation: 30 }] });

async function save(f: Fixture, result: { home: number; away: number; events: Array<Record<string, unknown>> }) {
  return saveResult(f.repo, {
    matchId: f.match.matchId,
    homeScore: result.home,
    awayScore: result.away,
    officialGoalEvents: result.events as never,
    enteredByGamingMemberId: "gm-operator",
  });
}

/** Saves, reviews (reads the digest of what was saved) and finalizes or corrects. */
async function settle(f: Fixture, result: { home: number; away: number; events: Array<Record<string, unknown>> }, reason = "Official sheet") {
  const saved = await save(f, result);
  if (saved.isCorrection) {
    await correctWithDigest(f.repo, saved.matchResultId, ADMIN, saved.contentDigest, reason);
  } else {
    await finalizeWithDigest(f.repo, saved.matchResultId, ADMIN, saved.contentDigest);
  }
  return saved;
}

async function rowsFor(f: Fixture, memberId: string) {
  return (await f.repo.listQualificationsForActivation(f.activation.venueActivationId))
    .filter((q) => q.gamingMemberId === memberId)
    .sort((a, b) => (a.lineageOrdinal ?? 1000) - (b.lineageOrdinal ?? 1000));
}

async function activeRow(f: Fixture, memberId: string) {
  const rows = (await rowsFor(f, memberId)).filter((q) => q.supersededAt === null);
  expect(rows.length).toBeLessThanOrEqual(1);
  return rows[0] ?? null;
}

const ANA = { home: 1, away: 0, minute: 20, first: "HOME" as const };

// ---------------------------------------------------------------------
// Result integrity: the score and the goal events must agree
// ---------------------------------------------------------------------

describe("Result integrity — score and goal events must agree (regulation time)", () => {
  it("accepts events that add up to the score and reports a first result as not a correction", async () => {
    const f = await setup();
    const saved = await save(f, { home: 2, away: 1, events: [
      { scorerPlayerId: f.mbappe.playerId, minuteRegulation: 10 },
      { scorerPlayerId: f.vini.playerId, minuteRegulation: 40 },
      { scorerPlayerId: f.lewa.playerId, minuteRegulation: 70 },
    ] });
    expect(saved.isCorrection).toBe(false);
    expect(saved.contentDigest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects a score the regulation-time events do not add up to, in both directions", async () => {
    const f = await setup();
    await expect(save(f, { home: 2, away: 0, events: [{ scorerPlayerId: f.mbappe.playerId, minuteRegulation: 10 }] }))
      .rejects.toBeInstanceOf(MatchResultEventsContradictScoreError);
    await expect(save(f, { home: 0, away: 0, events: [{ scorerPlayerId: f.mbappe.playerId, minuteRegulation: 10 }] }))
      .rejects.toBeInstanceOf(MatchResultEventsContradictScoreError);
    await expect(save(f, { home: 1, away: 1, events: [{ scorerPlayerId: f.mbappe.playerId, minuteRegulation: 10 }] }))
      .rejects.toBeInstanceOf(MatchResultEventsContradictScoreError);
    expect(await f.repo.getDraftMatchResult(f.match.matchId)).toBeNull();
  });

  it("an own goal credits the opposing team on the scoreline", async () => {
    const f = await setup();
    // Mbappe (home) puts it into his own net: 0-1.
    const saved = await save(f, { home: 0, away: 1, events: [{ scorerPlayerId: f.mbappe.playerId, minuteRegulation: 30, isOwnGoal: true }] });
    expect(saved.awayScore).toBe(1);
    await expect(save(f, { home: 1, away: 0, events: [{ scorerPlayerId: f.mbappe.playerId, minuteRegulation: 30, isOwnGoal: true }] }))
      .rejects.toBeInstanceOf(MatchResultEventsContradictScoreError);
  });

  it("every scorer must belong to one of the match's two teams", async () => {
    const f = await setup();
    await expect(save(f, { home: 1, away: 0, events: [{ scorerPlayerId: f.outsider.playerId, minuteRegulation: 10 }] }))
      .rejects.toBeInstanceOf(MatchResultScorerNotInMatchError);
    await expect(save(f, { home: 1, away: 0, events: [{ scorerPlayerId: "no-such-player", minuteRegulation: 10 }] }))
      .rejects.toBeInstanceOf(MatchResultScorerNotInMatchError);
  });

  it("stoppage goals at 45 and 90 are regulation time and count toward the score", async () => {
    const f = await setup();
    const saved = await save(f, { home: 2, away: 0, events: [
      { scorerPlayerId: f.mbappe.playerId, minuteRegulation: 45, minuteStoppage: 3 },
      { scorerPlayerId: f.vini.playerId, minuteRegulation: 90, minuteStoppage: 5 },
    ] });
    expect(saved.homeScore).toBe(2);
    await expect(save(f, { home: 1, away: 0, events: [
      { scorerPlayerId: f.mbappe.playerId, minuteRegulation: 45, minuteStoppage: 3 },
      { scorerPlayerId: f.vini.playerId, minuteRegulation: 90, minuteStoppage: 5 },
    ] })).rejects.toBeInstanceOf(MatchResultEventsContradictScoreError);
  });

  it("extra-time goals are kept as evidence but excluded from the score check", async () => {
    const f = await setup();
    const saved = await save(f, { home: 0, away: 0, events: [
      { scorerPlayerId: f.mbappe.playerId, minuteRegulation: 105, minuteStoppage: 2 },
      { scorerPlayerId: f.lewa.playerId, minuteRegulation: 118 },
    ] });
    expect(saved.homeScore).toBe(0);
    expect(await f.repo.listGoalEventsForResult(saved.matchResultId)).toHaveLength(2);
    // The score may not count the extra-time goals.
    await expect(save(f, { home: 1, away: 1, events: [
      { scorerPlayerId: f.mbappe.playerId, minuteRegulation: 105 },
      { scorerPlayerId: f.lewa.playerId, minuteRegulation: 118 },
    ] })).rejects.toBeInstanceOf(MatchResultEventsContradictScoreError);
  });

  it("minute 90 is regulation time and minute 91 is not", async () => {
    const f = await setup();
    await save(f, { home: 1, away: 0, events: [{ scorerPlayerId: f.mbappe.playerId, minuteRegulation: 90 }] });
    const g = await setup();
    await save(g, { home: 0, away: 0, events: [{ scorerPlayerId: g.mbappe.playerId, minuteRegulation: 91 }] });
    await expect(save(g, { home: 1, away: 0, events: [{ scorerPlayerId: g.mbappe.playerId, minuteRegulation: 91 }] }))
      .rejects.toBeInstanceOf(MatchResultEventsContradictScoreError);
  });

  it("rejects malformed scores and goal events without saving anything", async () => {
    const f = await setup();
    const ok = [{ scorerPlayerId: f.mbappe.playerId, minuteRegulation: 10 }];
    const base = { matchId: f.match.matchId, enteredByGamingMemberId: "gm-operator", saveBase: NO_RESULT_SAVE_BASE };
    await expect(saveMatchResultDraft(f.repo, { ...base, homeScore: -1, awayScore: 0, officialGoalEvents: [] }))
      .rejects.toBeInstanceOf(InvalidMatchResultScoreError);
    await expect(saveMatchResultDraft(f.repo, { ...base, homeScore: 1.5, awayScore: 0, officialGoalEvents: ok }))
      .rejects.toBeInstanceOf(InvalidMatchResultScoreError);
    await expect(saveMatchResultDraft(f.repo, { ...base, homeScore: 1, awayScore: 0, officialGoalEvents: "x" as never }))
      .rejects.toBeInstanceOf(InvalidMatchResultEventsError);
    for (const bad of [0, 121, 45.5, -3]) {
      await expect(saveMatchResultDraft(f.repo, { ...base, homeScore: 1, awayScore: 0, officialGoalEvents: [{ scorerPlayerId: f.mbappe.playerId, minuteRegulation: bad }] }))
        .rejects.toBeInstanceOf(MatchResultEventMinuteInvalidError);
    }
    await expect(saveMatchResultDraft(f.repo, { ...base, homeScore: 1, awayScore: 0, officialGoalEvents: [{ scorerPlayerId: f.mbappe.playerId, minuteRegulation: 50, minuteStoppage: 2 }] }))
      .rejects.toBeInstanceOf(InvalidOfficialGoalMinuteError);
    await expect(saveMatchResultDraft(f.repo, { ...base, homeScore: 1, awayScore: 0, officialGoalEvents: [{ scorerPlayerId: f.mbappe.playerId, minuteRegulation: 45, minuteStoppage: 0 }] }))
      .rejects.toBeInstanceOf(MatchResultEventMinuteInvalidError);
    await expect(saveMatchResultDraft(f.repo, { ...base, homeScore: 1, awayScore: 0, officialGoalEvents: [{ scorerPlayerId: "", minuteRegulation: 10 }] }))
      .rejects.toBeInstanceOf(InvalidMatchResultEventsError);
    expect(await f.repo.getDraftMatchResult(f.match.matchId)).toBeNull();
  });

  it("a rejected save leaves the prior draft — score, events and digest — exactly as it was", async () => {
    const f = await setup();
    const first = await save(f, { home: 1, away: 0, events: [{ scorerPlayerId: f.mbappe.playerId, minuteRegulation: 20 }] });
    const eventsBefore = await f.repo.listGoalEventsForResult(first.matchResultId);

    await expect(save(f, { home: 3, away: 0, events: [{ scorerPlayerId: f.vini.playerId, minuteRegulation: 30 }] }))
      .rejects.toBeInstanceOf(MatchResultEventsContradictScoreError);
    await expect(save(f, { home: 1, away: 0, events: [{ scorerPlayerId: f.outsider.playerId, minuteRegulation: 30 }] }))
      .rejects.toBeInstanceOf(MatchResultScorerNotInMatchError);

    const after = await f.repo.getDraftMatchResult(f.match.matchId);
    expect(after).toMatchObject({ matchResultId: first.matchResultId, homeScore: 1, awayScore: 0 });
    expect(await f.repo.listGoalEventsForResult(first.matchResultId)).toEqual(eventsBefore);
    expect(await f.repo.getMatchResultContentDigest(first.matchResultId)).toBe(first.contentDigest);
  });

  it("first scorer ordering: first-half stoppage 45+10 comes before ordinary minute 55", async () => {
    const f = await setup();
    await predict(f, "gm-first-home", { home: 1, away: 1, scorer: null, minute: null, first: "HOME" });
    // Entered away-goal first so the old (minute + stoppage) tie fell back to entry order and chose AWAY.
    await settle(f, { home: 1, away: 1, events: [
      { scorerPlayerId: f.lewa.playerId, minuteRegulation: 55 },
      { scorerPlayerId: f.mbappe.playerId, minuteRegulation: 45, minuteStoppage: 10 },
    ] });
    const prediction = await f.repo.getPredictionForMember(f.match.matchId, "gm-first-home");
    const evaluation = await f.repo.getCurrentEvaluationForPrediction(prediction!.predictionId);
    expect(evaluation!.firstTeamToScoreCorrect).toBe(true);
  });
});

// ---------------------------------------------------------------------
// Draft saving: base digest, initial vs correction, atomicity
// ---------------------------------------------------------------------

describe("Atomic draft save — base digest and initial-vs-correction", () => {
  it("requires the base digest of what was loaded", async () => {
    const f = await setup();
    await expect(
      saveMatchResultDraft(f.repo, { matchId: f.match.matchId, homeScore: 0, awayScore: 0, officialGoalEvents: [], enteredByGamingMemberId: "gm-operator", saveBase: "" })
    ).rejects.toBeInstanceOf(MatchResultBaseRequiredError);
  });

  it("rejects a save over a draft that changed since it was loaded, and a NONE base over an existing draft", async () => {
    const f = await setup();
    const first = await save(f, resultA(f));
    const stale = first.contentDigest;
    const second = await save(f, resultB(f));
    expect(second.contentDigest).not.toBe(stale);

    const attempt = (saveBase: string) =>
      saveMatchResultDraft(f.repo, {
        matchId: f.match.matchId, homeScore: 1, awayScore: 0,
        officialGoalEvents: [{ scorerPlayerId: f.mbappe.playerId, minuteRegulation: 20 }],
        enteredByGamingMemberId: "gm-operator", saveBase,
      });
    await expect(attempt(stale)).rejects.toBeInstanceOf(MatchResultBaseStaleError);
    await expect(attempt(NO_RESULT_SAVE_BASE)).rejects.toBeInstanceOf(MatchResultBaseStaleError);
    await expect(attempt(second.contentDigest)).resolves.toMatchObject({ matchResultId: first.matchResultId });
  });

  it("the save base names the whole result state: NONE for a first result, FINAL:<digest> to correct a finalized one", async () => {
    const f = await setup();
    const saveWith = (saveBase: string, result = resultA(f)) =>
      saveMatchResultDraft(f.repo, {
        matchId: f.match.matchId, homeScore: result.home, awayScore: result.away,
        officialGoalEvents: result.events, enteredByGamingMemberId: "gm-operator", saveBase,
      });

    const first = await settle(f, resultA(f));
    const finalDigest = (await f.repo.getMatchResultContentDigest(first.matchResultId))!;

    // An editor who loaded nothing cannot silently create a second first result beside a finalized one.
    await expect(saveWith(NO_RESULT_SAVE_BASE, resultB(f))).rejects.toBeInstanceOf(MatchResultBaseStaleError);
    // The finalized result's digest alone is not the base either: it must say it is a correction.
    await expect(saveWith(finalDigest, resultB(f))).rejects.toBeInstanceOf(MatchResultBaseStaleError);
    expect(await f.repo.getDraftMatchResult(f.match.matchId)).toBeNull();

    const correction = await saveWith(`FINAL:${finalDigest}`, resultB(f));
    expect(correction).toMatchObject({ isCorrection: true, supersedesMatchResultId: first.matchResultId });
    // Once a correction draft exists, the base is that draft's digest.
    await expect(saveWith(`FINAL:${finalDigest}`, resultA(f))).rejects.toBeInstanceOf(MatchResultBaseStaleError);
    await expect(saveWith(correction.contentDigest, resultA(f))).resolves.toMatchObject({ matchResultId: correction.matchResultId });
  });

  it("an editor who loaded no result while a draft was finalized meanwhile is refused, never given a second first result", async () => {
    const f = await setup();
    const editorLoadedNothing = NO_RESULT_SAVE_BASE;
    const draft = await save(f, resultA(f));
    const outcomes = await Promise.allSettled([
      finalizeWithDigest(f.repo, draft.matchResultId, ADMIN, draft.contentDigest),
      saveMatchResultDraft(f.repo, {
        matchId: f.match.matchId, homeScore: 1, awayScore: 0, officialGoalEvents: resultB(f).events,
        enteredByGamingMemberId: "gm-operator", saveBase: editorLoadedNothing,
      }),
    ]);
    expect(outcomes[0].status).toBe("fulfilled");
    expect((outcomes[1] as PromiseRejectedResult).reason).toBeInstanceOf(MatchResultBaseStaleError);
    expect(await f.repo.getDraftMatchResult(f.match.matchId)).toBeNull();
  });

  it("two concurrent saves from the same base: exactly one wins, the other is stale", async () => {
    const f = await setup();
    const outcomes = await Promise.allSettled([
      saveMatchResultDraft(f.repo, { matchId: f.match.matchId, homeScore: 1, awayScore: 0, officialGoalEvents: resultA(f).events, enteredByGamingMemberId: "gm-operator", saveBase: NO_RESULT_SAVE_BASE }),
      saveMatchResultDraft(f.repo, { matchId: f.match.matchId, homeScore: 1, awayScore: 0, officialGoalEvents: resultB(f).events, enteredByGamingMemberId: "gm-operator", saveBase: NO_RESULT_SAVE_BASE }),
    ]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    const rejected = outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(MatchResultBaseStaleError);
  });

  it("the save, not the caller, decides initial draft versus correction", async () => {
    const f = await setup();
    const first = await save(f, resultA(f));
    expect(first.isCorrection).toBe(false);
    expect(first.supersedesMatchResultId).toBeNull();
    await finalizeWithDigest(f.repo, first.matchResultId, ADMIN, first.contentDigest);

    const correction = await save(f, resultB(f));
    expect(correction.isCorrection).toBe(true);
    expect(correction.supersedesMatchResultId).toBe(first.matchResultId);
    // Re-saving the correction draft stays a correction of the same result.
    const again = await save(f, resultA(f));
    expect(again).toMatchObject({ matchResultId: correction.matchResultId, isCorrection: true, supersedesMatchResultId: first.matchResultId });
  });

  it("saving after finalization never alters the finalized result or its goal evidence", async () => {
    const f = await setup();
    const first = await settle(f, resultA(f));
    const finalizedEvents = await f.repo.listGoalEventsForResult(first.matchResultId);
    const finalizedDigest = await f.repo.getMatchResultContentDigest(first.matchResultId);

    await save(f, resultB(f));

    expect(await f.repo.listGoalEventsForResult(first.matchResultId)).toEqual(finalizedEvents);
    expect(await f.repo.getMatchResultContentDigest(first.matchResultId)).toBe(finalizedDigest);
    expect((await f.repo.getMatchResultById(first.matchResultId))!.finalizedAt).not.toBeNull();
  });
});

// ---------------------------------------------------------------------
// The digest
// ---------------------------------------------------------------------

describe("Result content digest", () => {
  const base = {
    matchResultId: "r1", matchId: "m1", homeTeamId: "h", awayTeamId: "a", homeScore: 1, awayScore: 0,
    supersedesMatchResultId: null as string | null,
    events: [{ ordinal: 1, scorerPlayerId: "p1", minuteRegulation: 20, minuteStoppage: null as number | null, isOwnGoal: false }],
  };

  it("is deterministic and independent of the order events are listed in", () => {
    const two = { ...base, events: [...base.events, { ordinal: 2, scorerPlayerId: "p2", minuteRegulation: 30, minuteStoppage: null, isOwnGoal: false }] };
    expect(computeMatchResultContentDigest(base)).toBe(computeMatchResultContentDigest({ ...base }));
    expect(computeMatchResultContentDigest(two)).toBe(computeMatchResultContentDigest({ ...two, events: [...two.events].reverse() }));
  });

  it("changes when anything a finalizer reviews changes", () => {
    const original = computeMatchResultContentDigest(base);
    const variants = [
      { ...base, matchResultId: "r2" },
      { ...base, matchId: "m2" },
      { ...base, homeTeamId: "h2" },
      { ...base, awayTeamId: "a2" },
      { ...base, homeScore: 2 },
      { ...base, awayScore: 1 },
      { ...base, supersedesMatchResultId: "r0" },
      { ...base, events: [{ ...base.events[0], scorerPlayerId: "p9" }] },
      { ...base, events: [{ ...base.events[0], minuteRegulation: 21 }] },
      { ...base, events: [{ ...base.events[0], minuteStoppage: 2 }] },
      { ...base, events: [{ ...base.events[0], isOwnGoal: true }] },
      { ...base, events: [] },
    ];
    for (const variant of variants) {
      expect(computeMatchResultContentDigest(variant)).not.toBe(original);
    }
  });

  it("a team edit after the draft was saved invalidates the reviewed digest", async () => {
    const f = await setup();
    const saved = await save(f, resultA(f));
    const other = await createTeam(f.repo, { name: "Sevilla" });
    await editMatch(f.repo, f.match.matchId, {
      homeTeamId: f.home.teamId, awayTeamId: other.teamId, competition: "Friendly", kickoffAt: f.match.kickoffAt,
    });
    expect(await f.repo.getMatchResultContentDigest(saved.matchResultId)).not.toBe(saved.contentDigest);
    await expect(finalizeWithDigest(f.repo, saved.matchResultId, ADMIN, saved.contentDigest)).rejects.toBeInstanceOf(MatchResultDigestMismatchError);
  });
});

// ---------------------------------------------------------------------
// Reviewed-content finalization
// ---------------------------------------------------------------------

describe("Finalize / correct require the reviewed content", () => {
  it("rejects a missing digest and a stale one, and settles nothing", async () => {
    const f = await setup();
    await predict(f, "gm-ana", { ...ANA, scorer: f.mbappe.playerId });
    const saved = await save(f, resultA(f));
    await expect(finalizeWithDigest(f.repo, saved.matchResultId, ADMIN, "")).rejects.toBeInstanceOf(MatchResultDigestRequiredError);

    const reviewed = saved.contentDigest;
    await save(f, resultB(f)); // someone edits the draft after it was reviewed
    await expect(finalizeWithDigest(f.repo, saved.matchResultId, ADMIN, reviewed)).rejects.toBeInstanceOf(MatchResultDigestMismatchError);
    expect((await f.repo.getMatchResultById(saved.matchResultId))!.finalizedAt).toBeNull();
    expect(await rowsFor(f, "gm-ana")).toHaveLength(0);
  });

  it("authority is checked before the digest: a valid digest is not authorization", async () => {
    const f = await setup();
    const saved = await save(f, resultA(f));
    await expect(finalizeWithDigest(f.repo, saved.matchResultId, "gm-nobody", saved.contentDigest)).rejects.toBeInstanceOf(InsufficientPlatformAuthorityError);
    await expect(finalizeWithDigest(f.repo, saved.matchResultId, "gm-operator", saved.contentDigest)).rejects.toBeInstanceOf(InsufficientPlatformAuthorityError);
    // ...and a wrong digest from an unauthorized caller learns nothing either.
    await expect(finalizeWithDigest(f.repo, saved.matchResultId, "gm-nobody", "0".repeat(64))).rejects.toBeInstanceOf(InsufficientPlatformAuthorityError);
    expect((await f.repo.getMatchResultById(saved.matchResultId))!.finalizedAt).toBeNull();
  });

  it("an already-finalized result replays idempotently only for the content that was finalized", async () => {
    const f = await setup();
    const saved = await save(f, resultA(f));
    const first = await finalizeWithDigest(f.repo, saved.matchResultId, ADMIN, saved.contentDigest);
    const replay = await finalizeWithDigest(f.repo, saved.matchResultId, ADMIN, saved.contentDigest);
    expect(first.alreadyFinalized).toBe(false);
    expect(replay).toMatchObject({ alreadyFinalized: true, finalizedAt: first.finalizedAt });
    await expect(finalizeWithDigest(f.repo, saved.matchResultId, ADMIN, "f".repeat(64))).rejects.toBeInstanceOf(MatchResultDigestMismatchError);
    const audit = await f.repo.auditStoreForTests.listEventsForTarget("match_results", saved.matchResultId);
    expect(audit.filter((e) => e.actionType === "FINALIZE_RESULT")).toHaveLength(1);
  });

  it("a correction draft cannot be finalized as a first result, nor a first result as a correction", async () => {
    const f = await setup();
    const first = await settle(f, resultA(f));
    const correction = await save(f, resultB(f));
    await expect(finalizeWithDigest(f.repo, correction.matchResultId, ADMIN, correction.contentDigest)).rejects.toBeInstanceOf(MatchResultIsCorrectionError);
    await expect(correctWithDigest(f.repo, first.matchResultId, ADMIN, first.contentDigest, "reason")).rejects.toBeInstanceOf(NotACorrectionError);
  });

  it("a correction needs a reason, a digest, and is idempotent for the same content", async () => {
    const f = await setup();
    await settle(f, resultA(f));
    const correction = await save(f, resultB(f));
    await expect(correctWithDigest(f.repo, correction.matchResultId, ADMIN, correction.contentDigest, "  ")).rejects.toBeInstanceOf(ReasonRequiredError);
    await expect(correctWithDigest(f.repo, correction.matchResultId, ADMIN, "", "Scorer fixed")).rejects.toBeInstanceOf(MatchResultDigestRequiredError);
    await correctWithDigest(f.repo, correction.matchResultId, ADMIN, correction.contentDigest, "Scorer fixed");
    const replay = await correctWithDigest(f.repo, correction.matchResultId, ADMIN, correction.contentDigest, "Scorer fixed");
    expect(replay.alreadyFinalized).toBe(true);
    await expect(correctWithDigest(f.repo, correction.matchResultId, ADMIN, "a".repeat(64), "Scorer fixed")).rejects.toBeInstanceOf(MatchResultDigestMismatchError);
  });

  it("save racing finalize: only content the finalizer reviewed is ever finalized", async () => {
    for (const order of ["save-first", "finalize-first"] as const) {
      const f = await setup();
      const first = await save(f, resultA(f));
      const reviewed = first.contentDigest;
      const saveEdit = () =>
        saveMatchResultDraft(f.repo, { matchId: f.match.matchId, homeScore: 1, awayScore: 0, officialGoalEvents: resultB(f).events, enteredByGamingMemberId: "gm-operator", saveBase: reviewed });
      const finalize = () => finalizeWithDigest(f.repo, first.matchResultId, ADMIN, reviewed);
      const outcomes = await Promise.allSettled(order === "save-first" ? [saveEdit(), finalize()] : [finalize(), saveEdit()]);

      const finalized = (await f.repo.getMatchResultById(first.matchResultId))!;
      if (finalized.finalizedAt) {
        // finalize won: it must have finalized exactly the reviewed content
        expect(await f.repo.getMatchResultContentDigest(first.matchResultId)).toBe(reviewed);
        expect(outcomes[order === "save-first" ? 0 : 1].status).toBe("rejected"); // the late save found no such draft
      } else {
        // save won: the finalize of the old digest was refused
        expect((outcomes[order === "save-first" ? 1 : 0] as PromiseRejectedResult).reason).toBeInstanceOf(MatchResultDigestMismatchError);
      }
    }
  });
});

// ---------------------------------------------------------------------
// The loaded view always pairs content with its own digest
// ---------------------------------------------------------------------

describe("Result view — the digest describes exactly what is shown", () => {
  it("returns the draft and the current finalized result, each with its verified digest", async () => {
    const f = await setup();
    const first = await settle(f, resultA(f));
    const correction = await save(f, resultB(f));
    const view = await readResultView(f.repo, f.match.matchId);
    expect(view.currentFinalized).toMatchObject({ matchResultId: first.matchResultId, contentDigest: first.contentDigest });
    expect(view.draft).toMatchObject({ matchResultId: correction.matchResultId, contentDigest: correction.contentDigest });
    expect(view.draft!.goalEvents).toHaveLength(1);
  });

  it("re-reads when a save lands in the middle of the read, and still pairs content with its digest", async () => {
    const f = await setup();
    await save(f, resultA(f));
    let tornOnce = false;
    const real = f.repo.listGoalEventsForResult.bind(f.repo);
    f.repo.listGoalEventsForResult = async (id: string) => {
      const events = await real(id);
      if (!tornOnce) {
        tornOnce = true;
        await save(f, resultB(f)); // a save lands after the events were read
      }
      return events;
    };
    const view = await readResultView(f.repo, f.match.matchId);
    expect(tornOnce).toBe(true);
    expect(view.draft!.goalEvents[0].scorerPlayerId).toBe(f.vini.playerId);
    expect(view.draft!.contentDigest).toBe(await f.repo.getMatchResultContentDigest(view.draft!.matchResultId));
  });

  it("gives up with a clear error if the result keeps changing under the read", async () => {
    const f = await setup();
    await save(f, resultA(f));
    const real = f.repo.listGoalEventsForResult.bind(f.repo);
    let flip = false;
    f.repo.listGoalEventsForResult = async (id: string) => {
      const events = await real(id);
      flip = !flip;
      await save(f, flip ? resultB(f) : resultA(f));
      return events;
    };
    await expect(readResultView(f.repo, f.match.matchId)).rejects.toBeInstanceOf(ResultChangedWhileLoadingError);
  });
});

// ---------------------------------------------------------------------
// Prize policy at correction
// ---------------------------------------------------------------------

describe("Correction prize policy — never a second delivery on its own", () => {
  async function anaWinsJersey(f: Fixture) {
    await predict(f, "gm-ana", { ...ANA, scorer: f.mbappe.playerId });
    await settle(f, resultA(f));
    const row = (await activeRow(f, "gm-ana"))!;
    expect(row.prizeTierId).toBe(f.tiers[4]);
    return row;
  }

  it("unredeemed entitlements are replaced, with a history link and nothing held", async () => {
    const f = await setup();
    const original = await anaWinsJersey(f);

    await settle(f, resultB(f)); // Ana now has 2 of 4 -> Cap

    const rows = await rowsFor(f, "gm-ana");
    expect(rows).toHaveLength(2);
    const replaced = rows.find((r) => r.prizeQualificationId === original.prizeQualificationId)!;
    const current = await activeRow(f, "gm-ana");
    expect(replaced.supersededAt).not.toBeNull();
    expect(current).toMatchObject({
      prizeTierId: f.tiers[2],
      replacesPrizeQualificationId: original.prizeQualificationId,
      fulfilledByPrizeQualificationId: null,
      heldAt: null,
      redeemedAt: null,
    });
    await expect(redeemPrizeQualification(f.repo, current!.prizeQualificationId, ADMIN)).resolves.toMatchObject({ alreadyRedeemed: false });
  });

  it("redeemed and unchanged: linked to the original delivery, not redeemable, no second redemption event", async () => {
    const f = await setup();
    const original = await anaWinsJersey(f);
    const delivered = await redeemPrizeQualification(f.repo, original.prizeQualificationId, ADMIN);

    await settle(f, resultA(f)); // identical outcome for Ana

    const current = (await activeRow(f, "gm-ana"))!;
    expect(current.prizeQualificationId).not.toBe(original.prizeQualificationId);
    expect(current).toMatchObject({
      prizeTierId: f.tiers[4],
      fulfilledByPrizeQualificationId: original.prizeQualificationId,
      replacesPrizeQualificationId: original.prizeQualificationId,
      redeemedAt: null,
      redeemedByGamingMemberId: null,
      redeemedPrizeLabel: null,
      heldAt: null,
    });
    await expect(redeemPrizeQualification(f.repo, current.prizeQualificationId, ADMIN)).rejects.toBeInstanceOf(PrizeAlreadyFulfilledError);

    const originalAfter = (await rowsFor(f, "gm-ana")).find((r) => r.prizeQualificationId === original.prizeQualificationId)!;
    expect(originalAfter).toMatchObject({ redeemedAt: delivered.redeemedAt, redeemedByGamingMemberId: ADMIN, redeemedPrizeLabel: "Jersey" });
    expect(originalAfter.supersededAt).not.toBeNull();
    const redemptions = (await rowsFor(f, "gm-ana")).filter((r) => r.redeemedAt !== null);
    expect(redemptions).toHaveLength(1);
    for (const row of await rowsFor(f, "gm-ana")) {
      const audit = await f.repo.auditStoreForTests.listEventsForTarget("prize_qualifications", row.prizeQualificationId);
      const expected = row.prizeQualificationId === original.prizeQualificationId ? 1 : 0;
      expect(audit.filter((e) => e.actionType === "CONFIRM_PRIZE_REDEMPTION")).toHaveLength(expected);
    }
  });

  it("redeemed and changed: the replacement is held for a reasoned Founder decision", async () => {
    const f = await setup();
    const original = await anaWinsJersey(f);
    await redeemPrizeQualification(f.repo, original.prizeQualificationId, ADMIN);

    await settle(f, resultB(f)); // Ana drops to 2 of 4 -> Cap

    const held = (await activeRow(f, "gm-ana"))!;
    expect(held).toMatchObject({
      prizeTierId: f.tiers[2],
      holdPriorPrizeQualificationId: original.prizeQualificationId,
      fulfilledByPrizeQualificationId: null,
      releasedAt: null,
      redeemedAt: null,
    });
    expect(held.heldAt).not.toBeNull();
    expect(held.holdReason).toContain("Jersey");
    expect(held.holdReason).toContain("Cap");
    await expect(redeemPrizeQualification(f.repo, held.prizeQualificationId, ADMIN)).rejects.toBeInstanceOf(PrizeQualificationHeldError);

    // Release: finalizer authority and a reason are both required.
    await expect(releasePrizeQualificationHold(f.repo, held.prizeQualificationId, "gm-operator", "ok")).rejects.toBeInstanceOf(InsufficientPlatformAuthorityError);
    await expect(releasePrizeQualificationHold(f.repo, held.prizeQualificationId, ADMIN, "   ")).rejects.toBeInstanceOf(ReasonRequiredError);
    expect((await activeRow(f, "gm-ana"))!.releasedAt).toBeNull();

    const released = await releasePrizeQualificationHold(f.repo, held.prizeQualificationId, ADMIN, "Founder approved the Cap as a goodwill prize");
    expect(released.alreadyReleased).toBe(false);
    const replay = await releasePrizeQualificationHold(f.repo, held.prizeQualificationId, ADMIN, "Founder approved the Cap as a goodwill prize");
    expect(replay).toMatchObject({ alreadyReleased: true, releasedAt: released.releasedAt });

    const audit = (await f.repo.auditStoreForTests.listEventsForTarget("prize_qualifications", held.prizeQualificationId))
      .filter((e) => e.actionType === "RELEASE_PRIZE_HOLD");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actorId: ADMIN,
      authorityClassUsed: "CONSEQUENTIAL_FINALIZER",
      reason: "Founder approved the Cap as a goodwill prize",
      previousReference: { table: "prize_qualifications", id: original.prizeQualificationId },
    });
    expect(await activeRow(f, "gm-ana")).toMatchObject({ releasedByGamingMemberId: ADMIN, releaseReason: "Founder approved the Cap as a goodwill prize" });

    // Releasing delivers nothing; redemption is its own explicit act.
    expect((await activeRow(f, "gm-ana"))!.redeemedAt).toBeNull();
    await expect(redeemPrizeQualification(f.repo, held.prizeQualificationId, ADMIN)).resolves.toMatchObject({ alreadyRedeemed: false });
    expect(await activeRow(f, "gm-ana")).toMatchObject({ redeemedPrizeLabel: "Cap" });

    // The original delivery evidence is untouched by all of it.
    const originalAfter = (await rowsFor(f, "gm-ana")).find((r) => r.prizeQualificationId === original.prizeQualificationId)!;
    expect(originalAfter).toMatchObject({ redeemedByGamingMemberId: ADMIN, redeemedPrizeLabel: "Jersey" });
  });

  it("redeemed and the participant no longer qualifies: history is preserved, nothing is clawed back", async () => {
    const f = await setup({ 4: "Jersey" }); // no 2-of-4 prize
    await predict(f, "gm-ana", { ...ANA, scorer: f.mbappe.playerId });
    const firstResult = await settle(f, resultA(f));
    const original = (await activeRow(f, "gm-ana"))!;
    const delivered = await redeemPrizeQualification(f.repo, original.prizeQualificationId, ADMIN);

    await settle(f, resultB(f)); // Ana drops to 2 of 4: no prize configured

    expect(await activeRow(f, "gm-ana")).toBeNull();
    const rows = await rowsFor(f, "gm-ana");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ redeemedAt: delivered.redeemedAt, redeemedByGamingMemberId: ADMIN, redeemedPrizeLabel: "Jersey" });
    expect(rows[0].supersededAt).not.toBeNull();
    const prediction = await f.repo.getPredictionForMember(f.match.matchId, "gm-ana");
    const superseded = await f.repo.getEvaluation(prediction!.predictionId, firstResult.matchResultId);
    expect(superseded!.correctDimensionCount).toBe(4); // the superseded evaluation is still there
    const current = await f.repo.getCurrentEvaluationForPrediction(prediction!.predictionId);
    expect(current!.correctDimensionCount).toBe(2);
  });

  it("an edited prize definition is not an unchanged prize: same tier, new label -> held", async () => {
    const f = await setup();
    const original = await anaWinsJersey(f);
    await redeemPrizeQualification(f.repo, original.prizeQualificationId, ADMIN);
    f.repo.setPrizeLabelForTests(f.tiers[4], "Premium Jersey");

    await settle(f, resultA(f));

    const current = (await activeRow(f, "gm-ana"))!;
    expect(current.prizeTierId).toBe(f.tiers[4]);
    expect(current.heldAt).not.toBeNull();
    expect(current.fulfilledByPrizeQualificationId).toBeNull();
    expect(current.holdReason).toContain("Jersey");
    expect(current.holdReason).toContain("Premium Jersey");
    await expect(redeemPrizeQualification(f.repo, current.prizeQualificationId, ADMIN)).rejects.toBeInstanceOf(PrizeQualificationHeldError);
  });

  it("an upgrade after delivery is held too (2 of 4 delivered, 4 of 4 after correction)", async () => {
    const f = await setup();
    await predict(f, "gm-ben", { home: 1, away: 0, scorer: f.vini.playerId, minute: 30, first: "HOME" });
    await settle(f, resultA(f)); // Ben: scoreline + first team -> 2 of 4 -> Cap
    const capRow = (await activeRow(f, "gm-ben"))!;
    expect(capRow.prizeTierId).toBe(f.tiers[2]);
    await redeemPrizeQualification(f.repo, capRow.prizeQualificationId, ADMIN);

    await settle(f, resultB(f)); // Vini 30' is the real goal -> 4 of 4 -> Jersey

    const jersey = (await activeRow(f, "gm-ben"))!;
    expect(jersey.prizeTierId).toBe(f.tiers[4]);
    expect(jersey.heldAt).not.toBeNull();
    expect(jersey.holdPriorPrizeQualificationId).toBe(capRow.prizeQualificationId);
    await expect(redeemPrizeQualification(f.repo, jersey.prizeQualificationId, ADMIN)).rejects.toBeInstanceOf(PrizeQualificationHeldError);
  });

  it("repeated corrections keep pointing at the one real delivery", async () => {
    const f = await setup();
    const original = await anaWinsJersey(f);
    await redeemPrizeQualification(f.repo, original.prizeQualificationId, ADMIN);

    await settle(f, resultA(f)); // v2: unchanged
    const v2 = (await activeRow(f, "gm-ana"))!;
    expect(v2.fulfilledByPrizeQualificationId).toBe(original.prizeQualificationId);

    await settle(f, resultA(f)); // v3: unchanged again — still the ORIGINAL delivery, not v2
    const v3 = (await activeRow(f, "gm-ana"))!;
    expect(v3.fulfilledByPrizeQualificationId).toBe(original.prizeQualificationId);

    await settle(f, resultB(f)); // v4: changed -> held against the original delivery
    const v4 = (await activeRow(f, "gm-ana"))!;
    expect(v4.holdPriorPrizeQualificationId).toBe(original.prizeQualificationId);

    await settle(f, resultA(f)); // v5: back to the delivered prize -> satisfied again, the hold is superseded
    const v5 = (await activeRow(f, "gm-ana"))!;
    expect(v5.fulfilledByPrizeQualificationId).toBe(original.prizeQualificationId);
    expect(v5.heldAt).toBeNull();

    const rows = await rowsFor(f, "gm-ana");
    expect(rows).toHaveLength(5);
    expect(rows.filter((r) => r.redeemedAt !== null)).toHaveLength(1);
    expect(rows.filter((r) => r.supersededAt === null)).toHaveLength(1);
  });

  it("a released-and-redeemed replacement becomes the delivery baseline for later corrections", async () => {
    const f = await setup();
    const original = await anaWinsJersey(f);
    await redeemPrizeQualification(f.repo, original.prizeQualificationId, ADMIN);
    await settle(f, resultB(f)); // held Cap
    const held = (await activeRow(f, "gm-ana"))!;
    await releasePrizeQualificationHold(f.repo, held.prizeQualificationId, ADMIN, "Approved");
    await redeemPrizeQualification(f.repo, held.prizeQualificationId, ADMIN);

    await settle(f, resultB(f)); // unchanged relative to the Cap that was delivered last
    const afterSame = (await activeRow(f, "gm-ana"))!;
    expect(afterSame.fulfilledByPrizeQualificationId).toBe(held.prizeQualificationId);

    await settle(f, resultA(f)); // back to Jersey: differs from the last delivery (Cap) -> held again
    const afterBack = (await activeRow(f, "gm-ana"))!;
    expect(afterBack.holdPriorPrizeQualificationId).toBe(held.prizeQualificationId);
  });

  it("a hold on an entitlement that a later correction superseded can no longer be released", async () => {
    const f = await setup();
    const original = await anaWinsJersey(f);
    await redeemPrizeQualification(f.repo, original.prizeQualificationId, ADMIN);
    await settle(f, resultB(f));
    const held = (await activeRow(f, "gm-ana"))!;
    await settle(f, resultA(f)); // supersedes the held row
    await expect(releasePrizeQualificationHold(f.repo, held.prizeQualificationId, ADMIN, "late")).rejects.toBeInstanceOf(QualificationSupersededError);
  });

  it("release rejects an unknown or not-held entitlement", async () => {
    const f = await setup();
    const original = await anaWinsJersey(f);
    await expect(releasePrizeQualificationHold(f.repo, "missing", ADMIN, "x")).rejects.toBeInstanceOf(PrizeQualificationNotFoundError);
    await expect(releasePrizeQualificationHold(f.repo, original.prizeQualificationId, ADMIN, "x")).rejects.toBeInstanceOf(PrizeQualificationNotHeldError);
  });

  it("redeem: unauthorized callers learn nothing, a replay is idempotent, the delivered label is recorded", async () => {
    const f = await setup();
    const original = await anaWinsJersey(f);
    await expect(redeemPrizeQualification(f.repo, original.prizeQualificationId, "gm-operator")).rejects.toBeInstanceOf(InsufficientPlatformAuthorityError);
    await expect(redeemPrizeQualification(f.repo, "missing", ADMIN)).rejects.toBeInstanceOf(PrizeQualificationNotFoundError);
    const first = await redeemPrizeQualification(f.repo, original.prizeQualificationId, ADMIN);
    const replay = await redeemPrizeQualification(f.repo, original.prizeQualificationId, ADMIN);
    expect(replay).toMatchObject({ alreadyRedeemed: true, redeemedAt: first.redeemedAt });
    expect((await activeRow(f, "gm-ana"))!.redeemedPrizeLabel).toBe("Jersey");
  });

  it("redemption racing a correction: either the delivery is seen by the correction, or the redeem is refused as superseded", async () => {
    for (const order of ["redeem-first", "correct-first"] as const) {
      const f = await setup();
      const original = await anaWinsJersey(f);
      const correction = await save(f, resultA(f));
      const redeem = () => redeemPrizeQualification(f.repo, original.prizeQualificationId, ADMIN);
      const correct = () => correctWithDigest(f.repo, correction.matchResultId, ADMIN, correction.contentDigest, "Re-confirmed");
      const [first, second] = order === "redeem-first" ? [redeem, correct] : [correct, redeem];
      const outcomes = await Promise.allSettled([first(), second()]);

      const rows = await rowsFor(f, "gm-ana");
      const delivered = rows.filter((r) => r.redeemedAt !== null);
      const current = rows.filter((r) => r.supersededAt === null);
      expect(current).toHaveLength(1);
      if (order === "redeem-first") {
        expect(outcomes.every((o) => o.status === "fulfilled")).toBe(true);
        expect(delivered).toHaveLength(1);
        expect(current[0].fulfilledByPrizeQualificationId).toBe(original.prizeQualificationId);
        await expect(redeemPrizeQualification(f.repo, current[0].prizeQualificationId, ADMIN)).rejects.toBeInstanceOf(PrizeAlreadyFulfilledError);
      } else {
        expect((outcomes[1] as PromiseRejectedResult).reason).toBeInstanceOf(QualificationSupersededError);
        expect(delivered).toHaveLength(0);
        expect(current[0].fulfilledByPrizeQualificationId).toBeNull();
        await expect(redeemPrizeQualification(f.repo, current[0].prizeQualificationId, ADMIN)).resolves.toMatchObject({ alreadyRedeemed: false });
        expect((await rowsFor(f, "gm-ana")).filter((r) => r.redeemedAt !== null)).toHaveLength(1);
      }
    }
  });

  it("release racing a correction: the release lands first or finds the hold superseded, never a second delivery", async () => {
    for (const order of ["release-first", "correct-first"] as const) {
      const f = await setup();
      const original = await anaWinsJersey(f);
      await redeemPrizeQualification(f.repo, original.prizeQualificationId, ADMIN);
      await settle(f, resultB(f));
      const held = (await activeRow(f, "gm-ana"))!;
      const correction = await save(f, resultA(f));
      const release = () => releasePrizeQualificationHold(f.repo, held.prizeQualificationId, ADMIN, "Approved");
      const correct = () => correctWithDigest(f.repo, correction.matchResultId, ADMIN, correction.contentDigest, "Re-confirmed");
      const [first, second] = order === "release-first" ? [release, correct] : [correct, release];
      const outcomes = await Promise.allSettled([first(), second()]);

      const current = (await activeRow(f, "gm-ana"))!;
      // After the correction the delivered Jersey satisfies the entitlement again.
      expect(current.fulfilledByPrizeQualificationId).toBe(original.prizeQualificationId);
      await expect(redeemPrizeQualification(f.repo, current.prizeQualificationId, ADMIN)).rejects.toBeInstanceOf(PrizeAlreadyFulfilledError);
      if (order === "correct-first") {
        expect((outcomes[1] as PromiseRejectedResult).reason).toBeInstanceOf(QualificationSupersededError);
      } else {
        expect(outcomes.every((o) => o.status === "fulfilled")).toBe(true);
      }
      expect((await rowsFor(f, "gm-ana")).filter((r) => r.redeemedAt !== null)).toHaveLength(1);
    }
  });
});

// ---------------------------------------------------------------------
// What a member sees
// ---------------------------------------------------------------------

describe("Member view of an entitlement", () => {
  it("shows only delivery status, never staff detail", async () => {
    const f = await setup();
    await predict(f, "gm-ana", { ...ANA, scorer: f.mbappe.playerId });
    await settle(f, resultA(f));
    const original = (await activeRow(f, "gm-ana"))!;
    await redeemPrizeQualification(f.repo, original.prizeQualificationId, ADMIN);
    await settle(f, resultB(f));
    const held = (await activeRow(f, "gm-ana"))!;

    const view = toMemberQualificationView(held);
    expect(view).toMatchObject({ underReview: true, alreadyDelivered: false, redeemedAt: null });
    expect(Object.keys(view).sort()).toEqual(
      ["alreadyDelivered", "createdAt", "evaluationId", "prizeQualificationId", "prizeTierId", "redeemedAt", "supersededAt", "underReview", "venueActivationId"].sort()
    );
    expect(JSON.stringify(view)).not.toContain(ADMIN);

    await releasePrizeQualificationHold(f.repo, held.prizeQualificationId, ADMIN, "Approved");
    expect(toMemberQualificationView((await activeRow(f, "gm-ana"))!)).toMatchObject({ underReview: false });
  });
});

// ---------------------------------------------------------------------
// The routes: what the HTTP layer accepts, refuses and reports
// ---------------------------------------------------------------------

describe("Result, finalize, release and redeem routes", () => {
  let httpAuth: typeof import("../lib/gaming/predictions/httpAuth");

  beforeEach(async () => {
    httpAuth = await import("../lib/gaming/predictions/httpAuth");
    vi.clearAllMocks();
    vi.mocked(httpAuth.getSupabaseCredentials).mockReturnValue({ url: "http://fake", serviceKey: "fake" });
  });

  function use(f: Fixture, caller = ADMIN) {
    vi.mocked(httpAuth.buildPredictionsRepo).mockReturnValue(f.repo as unknown as ReturnType<typeof httpAuth.buildPredictionsRepo>);
    vi.mocked(httpAuth.requireAnyAdminAuthority).mockResolvedValue({ gamingMemberId: caller });
    vi.mocked(httpAuth.requirePlatformAuthorityHttp).mockResolvedValue({ gamingMemberId: caller });
    vi.mocked(httpAuth.requireGamingMember).mockResolvedValue({ gamingMemberId: caller });
  }
  const post = (url: string, body: unknown) =>
    new Request(url, { method: "POST", headers: { "content-type": "application/json", authorization: "Bearer t" }, body: JSON.stringify(body) });
  const resultUrl = (f: Fixture) => `http://localhost/api/gaming/predictions/admin/matches/${f.match.matchId}/result`;
  const ctx = (f: Fixture) => ({ params: { matchId: f.match.matchId } });
  const payload = (f: Fixture, over: Record<string, unknown> = {}) => ({
    homeScore: 1, awayScore: 0, saveBase: NO_RESULT_SAVE_BASE,
    officialGoalEvents: [{ scorerPlayerId: f.mbappe.playerId, minuteRegulation: 20 }], ...over,
  });

  it("GET returns the draft and the finalized result with verified digests, and the save base to send back", async () => {
    const { GET } = await import("../app/api/gaming/predictions/admin/matches/[matchId]/result/route");
    const f = await setup();
    use(f);
    const first = await settle(f, resultA(f));
    const draft = await save(f, resultB(f));
    const res = await GET(new Request(resultUrl(f)), ctx(f));
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.currentFinalized).toMatchObject({ matchResultId: first.matchResultId, contentDigest: first.contentDigest });
    expect(body.draft).toMatchObject({ matchResultId: draft.matchResultId, contentDigest: draft.contentDigest });
    expect(body.draft.goalEvents).toHaveLength(1);
    expect(body.saveBase).toBe(draft.contentDigest);
  });

  it("GET of a match with nothing saved gives NONE; with only a finalized result gives FINAL:<digest>; an unknown match is 404", async () => {
    const { GET } = await import("../app/api/gaming/predictions/admin/matches/[matchId]/result/route");
    const f = await setup();
    use(f);
    expect(await (await GET(new Request(resultUrl(f)), ctx(f))).json()).toEqual({ draft: null, currentFinalized: null, saveBase: "NONE" });
    const first = await settle(f, resultA(f));
    expect((await (await GET(new Request(resultUrl(f)), ctx(f))).json()).saveBase).toBe(`FINAL:${first.contentDigest}`);
    expect((await GET(new Request(resultUrl(f)), { params: { matchId: "missing" } })).status).toBe(404);
  });

  it("GET is refused without admin authority, and the repository is never read", async () => {
    const { GET } = await import("../app/api/gaming/predictions/admin/matches/[matchId]/result/route");
    const f = await setup();
    use(f);
    vi.mocked(httpAuth.requireAnyAdminAuthority).mockResolvedValue({ errorResponse: NextResponse.json({ error: "no" }, { status: 403 }) });
    const spy = vi.spyOn(f.repo, "getDraftMatchResult");
    expect((await GET(new Request(resultUrl(f)), ctx(f))).status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });

  it("POST needs the save base: a missing or blank one is a 400 and nothing is saved", async () => {
    const { POST } = await import("../app/api/gaming/predictions/admin/matches/[matchId]/result/route");
    const f = await setup();
    use(f);
    for (const saveBase of [undefined, "", "   ", 7]) {
      const res = await POST(post(resultUrl(f), payload(f, { saveBase })), ctx(f));
      expect(res.status).toBe(400);
      expect((await res.json()).error).toContain("saveBase is required");
    }
    expect(await f.repo.getDraftMatchResult(f.match.matchId)).toBeNull();
  });

  it("POST saves in one step and reports the digest and whether it is a correction; a stale base is 409; invalid data is 400 and leaves the draft alone", async () => {
    const { POST } = await import("../app/api/gaming/predictions/admin/matches/[matchId]/result/route");
    const f = await setup();
    use(f);
    const created = await POST(post(resultUrl(f), payload(f)), ctx(f));
    expect(created.status).toBe(201);
    const { result } = await created.json();
    expect(result).toMatchObject({ isCorrection: false, homeScore: 1, awayScore: 0 });
    expect(result.contentDigest).toBe(await f.repo.getMatchResultContentDigest(result.matchResultId));

    const stale = await POST(post(resultUrl(f), payload(f, { saveBase: NO_RESULT_SAVE_BASE })), ctx(f));
    expect(stale.status).toBe(409);
    expect((await stale.json()).error).toContain("changed since you loaded it");

    const contradicting = await POST(post(resultUrl(f), payload(f, { homeScore: 3, saveBase: result.contentDigest })), ctx(f));
    expect(contradicting.status).toBe(400);
    expect((await contradicting.json()).error).toContain("credit 1 home and 0 away, but the score is 3-0");
    const wrongTeam = await POST(post(resultUrl(f), payload(f, { saveBase: result.contentDigest, officialGoalEvents: [{ scorerPlayerId: f.outsider.playerId, minuteRegulation: 20 }] })), ctx(f));
    expect(wrongTeam.status).toBe(400);
    const badMinute = await POST(post(resultUrl(f), payload(f, { saveBase: result.contentDigest, officialGoalEvents: [{ scorerPlayerId: f.mbappe.playerId, minuteRegulation: 150 }] })), ctx(f));
    expect(badMinute.status).toBe(400);
    expect(await f.repo.getMatchResultContentDigest(result.matchResultId)).toBe(result.contentDigest);
  });

  it("POST is refused without operational authority and never reaches the repository", async () => {
    const { POST } = await import("../app/api/gaming/predictions/admin/matches/[matchId]/result/route");
    const f = await setup();
    use(f);
    vi.mocked(httpAuth.requirePlatformAuthorityHttp).mockResolvedValue({ errorResponse: NextResponse.json({ error: "no" }, { status: 403 }) });
    const spy = vi.spyOn(f.repo, "saveDraftMatchResult");
    expect((await POST(post(resultUrl(f), payload(f)), ctx(f))).status).toBe(403);
    expect(spy).not.toHaveBeenCalled();
  });

  async function finalizeCall(f: Fixture, body: unknown, matchId = f.match.matchId) {
    const { POST } = await import("../app/api/gaming/predictions/admin/matches/[matchId]/result/finalize/route");
    return POST(post(`${resultUrl(f)}/finalize`, body), { params: { matchId } });
  }

  it("finalize needs the result id and the reviewed digest: without them it is a 400, and it never finalizes 'the current draft'", async () => {
    const f = await setup();
    use(f);
    const saved = await save(f, resultA(f));
    for (const body of [{}, { reason: "x" }, { matchResultId: saved.matchResultId }, { contentDigest: saved.contentDigest }, { matchResultId: "", contentDigest: "" }]) {
      expect((await finalizeCall(f, body)).status).toBe(400);
    }
    expect((await f.repo.getMatchResultById(saved.matchResultId))!.finalizedAt).toBeNull();
  });

  it("finalize refuses a result that belongs to another match (404) and a stale digest (409), and settles only the reviewed content", async () => {
    const f = await setup();
    use(f);
    const saved = await save(f, resultA(f));
    expect((await finalizeCall(f, { matchResultId: saved.matchResultId, contentDigest: saved.contentDigest }, "another-match")).status).toBe(404);
    await save(f, resultB(f)); // edited after the review
    const stale = await finalizeCall(f, { matchResultId: saved.matchResultId, contentDigest: saved.contentDigest });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error).toContain("changed since it was reviewed");
    expect((await f.repo.getMatchResultById(saved.matchResultId))!.finalizedAt).toBeNull();
  });

  it("finalize without finalizer authority is a 403 even with a correct digest; with it, a first result and then a correction go through, and a replay is idempotent", async () => {
    const f = await setup();
    const saved = await save(f, resultA(f));
    use(f, "gm-operator");
    const forbidden = await finalizeCall(f, { matchResultId: saved.matchResultId, contentDigest: saved.contentDigest });
    expect(forbidden.status).toBe(403);
    expect((await f.repo.getMatchResultById(saved.matchResultId))!.finalizedAt).toBeNull();

    use(f, ADMIN);
    const first = await finalizeCall(f, { matchResultId: saved.matchResultId, contentDigest: saved.contentDigest });
    expect(first.status).toBe(200);
    expect((await first.json()).result).toMatchObject({ matchResultId: saved.matchResultId, alreadyFinalized: false });
    const replay = await finalizeCall(f, { matchResultId: saved.matchResultId, contentDigest: saved.contentDigest });
    expect((await replay.json()).result.alreadyFinalized).toBe(true);

    const correction = await save(f, resultB(f));
    const noReason = await finalizeCall(f, { matchResultId: correction.matchResultId, contentDigest: correction.contentDigest });
    expect(noReason.status).toBe(400);
    const corrected = await finalizeCall(f, { matchResultId: correction.matchResultId, contentDigest: correction.contentDigest, reason: "Scorer fixed" });
    expect(corrected.status).toBe(200);
    expect((await corrected.json()).result).toMatchObject({ matchResultId: correction.matchResultId, supersedesMatchResultId: saved.matchResultId });
  });

  async function releaseCall(f: Fixture, id: string, body: unknown) {
    const { POST } = await import("../app/api/gaming/predictions/admin/qualifications/[qualificationId]/release-hold/route");
    return POST(post(`http://localhost/api/gaming/predictions/admin/qualifications/${id}/release-hold`, body), { params: { qualificationId: id } });
  }
  async function redeemCall(f: Fixture, id: string) {
    const { POST } = await import("../app/api/gaming/predictions/admin/qualifications/[qualificationId]/redeem/route");
    return POST(post(`http://localhost/api/gaming/predictions/admin/qualifications/${id}/redeem`, {}), { params: { qualificationId: id } });
  }

  it("release-hold: a reason is required (400), finalizer authority is required (403), an entitlement that is not on hold is 409, and a release is audited and idempotent", async () => {
    const f = await setup();
    use(f);
    await predict(f, "gm-ana", { ...ANA, scorer: f.mbappe.playerId });
    await settle(f, resultA(f));
    const original = (await activeRow(f, "gm-ana"))!;
    await f.repo.redeemPrizeQualification(original.prizeQualificationId, ADMIN, null);
    await settle(f, resultB(f));
    const held = (await activeRow(f, "gm-ana"))!;

    expect((await releaseCall(f, held.prizeQualificationId, {})).status).toBe(400);
    expect((await releaseCall(f, held.prizeQualificationId, { reason: "   " })).status).toBe(400);
    use(f, "gm-operator");
    expect((await releaseCall(f, held.prizeQualificationId, { reason: "ok" })).status).toBe(403);
    use(f, ADMIN);
    expect((await releaseCall(f, original.prizeQualificationId, { reason: "ok" })).status).toBe(409);
    expect((await releaseCall(f, "missing", { reason: "ok" })).status).toBe(404);

    const released = await releaseCall(f, held.prizeQualificationId, { reason: "Founder approved" });
    expect(released.status).toBe(200);
    expect((await released.json()).result).toMatchObject({ prizeQualificationId: held.prizeQualificationId, alreadyReleased: false });
    expect((await (await releaseCall(f, held.prizeQualificationId, { reason: "Founder approved" })).json()).result.alreadyReleased).toBe(true);
  });

  it("redeem reports a held or already-delivered prize as a 409 and a missing authority as a 403, not as a server error", async () => {
    const f = await setup();
    use(f);
    await predict(f, "gm-ana", { ...ANA, scorer: f.mbappe.playerId });
    await settle(f, resultA(f));
    const original = (await activeRow(f, "gm-ana"))!;
    await f.repo.redeemPrizeQualification(original.prizeQualificationId, ADMIN, null);
    await settle(f, resultA(f)); // unchanged -> already delivered
    const satisfied = (await activeRow(f, "gm-ana"))!;
    const fulfilled = await redeemCall(f, satisfied.prizeQualificationId);
    expect(fulfilled.status).toBe(409);
    expect((await fulfilled.json()).error).toContain("already satisfies");

    await settle(f, resultB(f)); // changed -> held
    const held = (await activeRow(f, "gm-ana"))!;
    const refused = await redeemCall(f, held.prizeQualificationId);
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toContain("on hold");

    use(f, "gm-operator");
    expect((await redeemCall(f, held.prizeQualificationId)).status).toBe(403);
  });

  it("the member's own view of a prize hides staff identity, hold reasons and links", async () => {
    const { GET } = await import("../app/api/gaming/predictions/matches/[matchId]/mine/route");
    const f = await setup();
    await predict(f, "gm-ana", { ...ANA, scorer: f.mbappe.playerId });
    await settle(f, resultA(f));
    const original = (await activeRow(f, "gm-ana"))!;
    await f.repo.redeemPrizeQualification(original.prizeQualificationId, ADMIN, null);
    await settle(f, resultB(f));
    use(f, "gm-ana");
    const res = await GET(new Request(`http://localhost/api/gaming/predictions/matches/${f.match.matchId}/mine`), { params: { matchId: f.match.matchId } });
    const body = await res.json();
    expect(body.qualification).toMatchObject({ underReview: true, alreadyDelivered: false, redeemedAt: null });
    expect(Object.keys(body.qualification).sort()).toEqual(
      ["alreadyDelivered", "createdAt", "evaluationId", "prizeQualificationId", "prizeTierId", "redeemedAt", "supersededAt", "underReview", "venueActivationId"].sort()
    );
    expect(JSON.stringify(body)).not.toContain(ADMIN);
  });
});
