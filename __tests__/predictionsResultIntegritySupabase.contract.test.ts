import { randomUUID } from "node:crypto";

import { loadEnv } from "vite";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { SupabasePredictionsRepository } from "../lib/gaming/predictions/db/supabasePredictionsRepository";
import { SupabaseGamingRepository } from "../lib/gaming/db/supabaseGamingRepository";
import { submitPrediction } from "../lib/gaming/predictions/submitPrediction";
import { computeMatchResultContentDigest, NO_RESULT_SAVE_BASE } from "../lib/gaming/predictions/resultIntegrity";
import { currentSaveBase } from "./helpers/predictionsResultFixtures";
import { readResultView } from "../lib/gaming/predictions/resultView";
import {
  MatchResultBaseStaleError,
  MatchResultDigestMismatchError,
  MatchResultDigestRequiredError,
  MatchResultEventsContradictScoreError,
  MatchResultEventMinuteInvalidError,
  MatchResultIsCorrectionError,
  MatchResultScorerNotInMatchError,
  PrizeAlreadyFulfilledError,
  PrizeQualificationHeldError,
  PrizeQualificationNotHeldError,
  QualificationSupersededError,
} from "../lib/gaming/predictions/types";
import { InsufficientPlatformAuthorityError, ReasonRequiredError } from "../lib/gaming/authority/types";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";
import { localSettlementDatabaseUrl, purgeSettlementEvidence } from "./helpers/localSettlementCleanup";

/**
 * Score Predictions — Result Integrity and Prize Correction, against real
 * local Postgres (migrations 20261020150000 / 20261020150100).
 *
 * Proves, on independent database connections where concurrency is
 * claimed: score/goal-event integrity (own goals, scorer teams, stoppage,
 * extra time excluded), atomic draft save (a failed save leaves the prior
 * draft untouched), reviewed-content digests and their parity with the
 * TypeScript digest, lock-ordered races between save / finalize /
 * correct / redeem / release, immutability of finalized evidence, the
 * prize policy at correction (unchanged / changed / removed / edited
 * prize), and the database access boundary (real anon and authenticated
 * clients are refused; service_role succeeds).
 *
 * Deterministic race proofs hold one transaction open on a raw
 * connection, start the competing operation through the repository,
 * wait until PostgreSQL reports it blocked on a lock, then release the
 * holder — so the outcome of each ordering is observed, not hoped for.
 */

const env = loadEnv("development", process.cwd(), "");
const supabaseUrl = env.SUPABASE_URL;
requireLocalSupabase(supabaseUrl);
const serviceKey = env.SUPABASE_SERVICE_ROLE_KEY;
const anonKey = env.SUPABASE_ANON_KEY;
if (!supabaseUrl || !serviceKey || !anonKey) {
  throw new Error("SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY and SUPABASE_ANON_KEY are required for contract tests.");
}
const databaseUrl = localSettlementDatabaseUrl();

const repo = new SupabasePredictionsRepository(supabaseUrl, serviceKey);
const gamingRepo = new SupabaseGamingRepository(supabaseUrl, serviceKey);
const admin: SupabaseClient = createClient(supabaseUrl, serviceKey);

const createdAuthUserIds: string[] = [];
const createdGamingMemberIds: string[] = [];
const createdMatchIds: string[] = [];
const createdVenueIds: string[] = [];
const createdTeamIds: string[] = [];

afterAll(async () => {
  await purgeSettlementEvidence(databaseUrl, createdMatchIds);
  for (const matchId of createdMatchIds) {
    await admin.from("gaming_progression_events").delete().eq("match_id", matchId);
    await admin.from("predictions").delete().eq("match_id", matchId);
    const { data: activations } = await admin.from("venue_activations").select("venue_activation_id").eq("match_id", matchId);
    const activationIds = (activations ?? []).map((a) => a.venue_activation_id);
    if (activationIds.length > 0) await admin.from("prize_tiers").delete().in("venue_activation_id", activationIds);
    await admin.from("venue_activations").delete().eq("match_id", matchId);
    await admin.from("matches").delete().eq("match_id", matchId);
  }
  for (const venueId of createdVenueIds) await admin.from("venues").delete().eq("venue_id", venueId);
  for (const teamId of createdTeamIds) {
    await admin.from("players").delete().eq("team_id", teamId);
    await admin.from("teams").delete().eq("team_id", teamId);
  }
  if (createdGamingMemberIds.length > 0) {
    await admin.from("admin_audit_events").delete().in("actor_id", createdGamingMemberIds);
    await admin.from("authority_grants").delete().in("gaming_member_id", createdGamingMemberIds);
    await admin.from("gaming_xp_events").delete().in("gaming_member_id", createdGamingMemberIds);
    await admin.from("experience_summaries").delete().in("gaming_member_id", createdGamingMemberIds);
  }
  for (const authUserId of createdAuthUserIds) await admin.auth.admin.deleteUser(authUserId);
}, 60000);

// ---------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------

function futureIso(ms = 3600_000): string {
  return new Date(Date.now() + ms).toISOString();
}

async function realMember(displayName: string, password?: string) {
  const email = `integrity-contract-${randomUUID()}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true, ...(password ? { password } : {}) });
  if (error || !data.user) throw error ?? new Error("Failed to create test auth user.");
  createdAuthUserIds.push(data.user.id);
  const member = await gamingRepo.createGamingMember(data.user.id, displayName);
  createdGamingMemberIds.push(member.gamingMemberId);
  return { authUserId: data.user.id, gamingMemberId: member.gamingMemberId, email };
}

async function grant(gamingMemberId: string, authorityClass: "CONSEQUENTIAL_FINALIZER" | "OPERATIONAL") {
  const { error } = await admin.from("authority_grants").insert({ gaming_member_id: gamingMemberId, authority_class: authorityClass });
  if (error) throw error;
}

type World = Awaited<ReturnType<typeof world>>;

/** Two teams, a third unrelated team, one RANKED match with an activation, prizes, and Ana's prediction. */
async function world(prizes: Record<number, string> = { 4: "Jersey", 2: "Cap" }, predict = true) {
  const finalizer = await realMember("IntegrityFinalizer");
  await grant(finalizer.gamingMemberId, "CONSEQUENTIAL_FINALIZER");
  const operator = await realMember("IntegrityOperator");
  await grant(operator.gamingMemberId, "OPERATIONAL");
  const ana = await realMember("IntegrityAna");

  const home = await repo.createTeam({ name: `Madrid ${randomUUID().slice(0, 8)}` });
  const away = await repo.createTeam({ name: `Barca ${randomUUID().slice(0, 8)}` });
  const third = await repo.createTeam({ name: `Atleti ${randomUUID().slice(0, 8)}` });
  createdTeamIds.push(home.teamId, away.teamId, third.teamId);
  const mbappe = await repo.createPlayer({ teamId: home.teamId, name: "Mbappe" });
  const vini = await repo.createPlayer({ teamId: home.teamId, name: "Vini" });
  const lewa = await repo.createPlayer({ teamId: away.teamId, name: "Lewandowski" });
  const pedri = await repo.createPlayer({ teamId: away.teamId, name: "Pedri" });
  const outsider = await repo.createPlayer({ teamId: third.teamId, name: "Griezmann" });

  const match = await repo.createMatch({ homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Integrity Contract", kickoffAt: futureIso() });
  createdMatchIds.push(match.matchId);
  await repo.setMatchActivityClassification(match.matchId, "TRAINING", finalizer.gamingMemberId, null);
  const venue = await repo.createVenue({ name: "Integrity Venue", latitude: 10, longitude: 10, radiusMeters: 100 });
  createdVenueIds.push(venue.venueId);
  const activation = await repo.createVenueActivation({ matchId: match.matchId, venueId: venue.venueId });
  const tiers: Record<number, string> = {};
  for (const [count, label] of Object.entries(prizes)) {
    const tier = await repo.createPrizeTier({ venueActivationId: activation.venueActivationId, correctDimensionCount: Number(count), prizeLabel: label });
    tiers[Number(count)] = tier.prizeTierId;
  }
  if (predict) {
    await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: ana.gamingMemberId, venueActivationId: activation.venueActivationId,
      predictedHomeScore: 1, predictedAwayScore: 0,
      predictedGoalscorerPlayerId: mbappe.playerId, predictedGoalMinuteRegulation: 20, predictedGoalMinuteStoppage: null,
      predictedFirstTeamToScore: "HOME", geo: { latitude: 10.0001, longitude: 10.0001, accuracyMeters: 5 },
    });
  }
  return { finalizer, operator, ana, home, away, third, mbappe, vini, lewa, pedri, outsider, match, venue, activation, tiers };
}

type Ev = { scorerPlayerId: string; minuteRegulation: number; minuteStoppage?: number | null; isOwnGoal?: boolean };
type Result = { home: number; away: number; events: Ev[] };
const resultA = (w: World): Result => ({ home: 1, away: 0, events: [{ scorerPlayerId: w.mbappe.playerId, minuteRegulation: 20 }] });
const resultB = (w: World): Result => ({ home: 1, away: 0, events: [{ scorerPlayerId: w.vini.playerId, minuteRegulation: 30 }] });

async function saveBaseNow(w: World): Promise<string> {
  return currentSaveBase(repo, w.match.matchId);
}

async function save(w: World, result: Result, saveBase?: string) {
  return repo.saveDraftMatchResult({
    matchId: w.match.matchId, homeScore: result.home, awayScore: result.away,
    officialGoalEvents: result.events, enteredByGamingMemberId: w.operator.gamingMemberId,
    saveBase: saveBase ?? (await saveBaseNow(w)),
  });
}

/** Saves a result and finalizes (first) or corrects (later) exactly the saved content. */
async function settle(w: World, result: Result, reason = "Official match sheet") {
  const saved = await save(w, result);
  if (saved.isCorrection) {
    await repo.correctMatchResult(saved.matchResultId, w.finalizer.gamingMemberId, reason, saved.contentDigest);
  } else {
    await repo.finalizeMatchResult(saved.matchResultId, w.finalizer.gamingMemberId, null, saved.contentDigest);
  }
  return saved;
}

async function rows(w: World) {
  const all = await repo.listQualificationsForActivation(w.activation.venueActivationId);
  return all.filter((q) => q.gamingMemberId === w.ana.gamingMemberId).sort((a, b) => (a.lineageOrdinal ?? 1000) - (b.lineageOrdinal ?? 1000));
}
async function activeRow(w: World) {
  const active = (await rows(w)).filter((q) => q.supersededAt === null);
  expect(active.length).toBeLessThanOrEqual(1);
  return active[0] ?? null;
}
async function redeem(w: World, id: string) {
  return repo.redeemPrizeQualification(id, w.finalizer.gamingMemberId, null);
}

// Raw-connection helpers for deterministic lock proofs.
async function openClient(): Promise<Client> {
  const client = new Client({ connectionString: databaseUrl, statement_timeout: 30000 });
  await client.connect();
  return client;
}

async function waitUntilBlocked(functionName: string, timeoutMs = 10000): Promise<void> {
  const probe = await openClient();
  try {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const { rows: waiting } = await probe.query(
        `select count(*)::int as n from pg_stat_activity
          where pid <> pg_backend_pid() and wait_event_type = 'Lock' and query ilike '%' || $1 || '%'`,
        [functionName]
      );
      if (waiting[0].n > 0) return;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error(`No session became blocked in ${functionName}`);
  } finally {
    await probe.end();
  }
}

function track<T>(promise: Promise<T>) {
  const state = { done: false };
  const wrapped = promise.finally(() => { state.done = true; });
  wrapped.catch(() => undefined);
  return { promise: wrapped, state };
}

// ---------------------------------------------------------------------
// Integrity
// ---------------------------------------------------------------------

describe("Result integrity in the database", () => {
  it("rejects a score the regulation-time events do not add up to; a rejected save leaves the prior draft untouched", async () => {
    const w = await world({ 4: "Jersey" }, false);
    const first = await save(w, resultA(w));
    const eventsBefore = await repo.listGoalEventsForResult(first.matchResultId);

    await expect(save(w, { home: 3, away: 0, events: resultB(w).events })).rejects.toBeInstanceOf(MatchResultEventsContradictScoreError);
    await expect(save(w, { home: 0, away: 0, events: resultB(w).events })).rejects.toBeInstanceOf(MatchResultEventsContradictScoreError);
    await expect(save(w, { home: 1, away: 0, events: [{ scorerPlayerId: w.outsider.playerId, minuteRegulation: 30 }] })).rejects.toBeInstanceOf(MatchResultScorerNotInMatchError);
    await expect(save(w, { home: 1, away: 0, events: [{ scorerPlayerId: randomUUID(), minuteRegulation: 30 }] })).rejects.toBeInstanceOf(MatchResultScorerNotInMatchError);
    await expect(save(w, { home: 1, away: 0, events: [{ scorerPlayerId: w.mbappe.playerId, minuteRegulation: 0 }] })).rejects.toBeInstanceOf(MatchResultEventMinuteInvalidError);
    await expect(save(w, { home: 1, away: 0, events: [{ scorerPlayerId: w.mbappe.playerId, minuteRegulation: 121 }] })).rejects.toBeInstanceOf(MatchResultEventMinuteInvalidError);
    await expect(save(w, { home: 1, away: 0, events: [{ scorerPlayerId: w.mbappe.playerId, minuteRegulation: 50, minuteStoppage: 2 }] })).rejects.toBeInstanceOf(MatchResultEventMinuteInvalidError);

    const draft = await repo.getDraftMatchResult(w.match.matchId);
    expect(draft).toMatchObject({ matchResultId: first.matchResultId, homeScore: 1, awayScore: 0 });
    expect(await repo.listGoalEventsForResult(first.matchResultId)).toEqual(eventsBefore);
    expect(await repo.getMatchResultContentDigest(first.matchResultId)).toBe(first.contentDigest);
  }, 60000);

  it("own goals credit the opponent; stoppage goals at 45 and 90 count; extra time is kept as evidence but excluded", async () => {
    const w = await world({ 4: "Jersey" }, false);
    await expect(save(w, { home: 1, away: 0, events: [{ scorerPlayerId: w.mbappe.playerId, minuteRegulation: 30, isOwnGoal: true }] })).rejects.toBeInstanceOf(MatchResultEventsContradictScoreError);
    const own = await save(w, { home: 0, away: 1, events: [{ scorerPlayerId: w.mbappe.playerId, minuteRegulation: 30, isOwnGoal: true }] });
    expect(own.awayScore).toBe(1);

    const stoppage = await save(w, { home: 2, away: 0, events: [
      { scorerPlayerId: w.mbappe.playerId, minuteRegulation: 45, minuteStoppage: 3 },
      { scorerPlayerId: w.vini.playerId, minuteRegulation: 90, minuteStoppage: 5 },
    ] });
    expect(stoppage.homeScore).toBe(2);

    const extra = await save(w, { home: 0, away: 0, events: [
      { scorerPlayerId: w.mbappe.playerId, minuteRegulation: 105, minuteStoppage: 2 },
      { scorerPlayerId: w.lewa.playerId, minuteRegulation: 118 },
    ] });
    expect(await repo.listGoalEventsForResult(extra.matchResultId)).toHaveLength(2);
    await expect(save(w, { home: 1, away: 1, events: [
      { scorerPlayerId: w.mbappe.playerId, minuteRegulation: 105 },
      { scorerPlayerId: w.lewa.playerId, minuteRegulation: 118 },
    ] })).rejects.toBeInstanceOf(MatchResultEventsContradictScoreError);
  }, 60000);

  it("extra-time goals never satisfy any prediction dimension (settled on the real database)", async () => {
    const w = await world({ 4: "Jersey", 3: "Scarf", 2: "Cap", 1: "Pin" }, false);
    const guesser = await realMember("IntegrityNoGoal");
    await submitPrediction(repo, {
      matchId: w.match.matchId, gamingMemberId: guesser.gamingMemberId, venueActivationId: w.activation.venueActivationId,
      predictedHomeScore: 0, predictedAwayScore: 0, predictedGoalscorerPlayerId: null, predictedGoalMinuteRegulation: null,
      predictedGoalMinuteStoppage: null, predictedFirstTeamToScore: null, geo: { latitude: 10.0001, longitude: 10.0001, accuracyMeters: 5 },
    });
    const namer = await realMember("IntegrityNamesExtraTime");
    await submitPrediction(repo, {
      matchId: w.match.matchId, gamingMemberId: namer.gamingMemberId, venueActivationId: w.activation.venueActivationId,
      predictedHomeScore: 1, predictedAwayScore: 0, predictedGoalscorerPlayerId: w.mbappe.playerId, predictedGoalMinuteRegulation: 90,
      predictedGoalMinuteStoppage: null, predictedFirstTeamToScore: "HOME", geo: { latitude: 10.0001, longitude: 10.0001, accuracyMeters: 5 },
    });
    await settle(w, { home: 0, away: 0, events: [{ scorerPlayerId: w.mbappe.playerId, minuteRegulation: 101 }] });

    const noGoal = await repo.getPredictionForMember(w.match.matchId, guesser.gamingMemberId);
    const noGoalEval = await repo.getCurrentEvaluationForPrediction(noGoal!.predictionId);
    expect(noGoalEval).toMatchObject({ scorelineCorrect: true, goalscorerCorrect: true, goalMinuteCorrect: true, firstTeamToScoreCorrect: true, correctDimensionCount: 4 });
    const named = await repo.getPredictionForMember(w.match.matchId, namer.gamingMemberId);
    const namedEval = await repo.getCurrentEvaluationForPrediction(named!.predictionId);
    expect(namedEval).toMatchObject({ scorelineCorrect: false, goalscorerCorrect: false, goalMinuteCorrect: false, firstTeamToScoreCorrect: false, correctDimensionCount: 0 });
  }, 60000);

  it("first-half stoppage 45+10 is chronologically before ordinary minute 55 (first team to score)", async () => {
    const w = await world({ 1: "Pin" }, false);
    const guesser = await realMember("IntegrityFirstHome");
    await submitPrediction(repo, {
      matchId: w.match.matchId, gamingMemberId: guesser.gamingMemberId, venueActivationId: w.activation.venueActivationId,
      predictedHomeScore: 5, predictedAwayScore: 5, predictedGoalscorerPlayerId: null, predictedGoalMinuteRegulation: null,
      predictedGoalMinuteStoppage: null, predictedFirstTeamToScore: "HOME", geo: { latitude: 10.0001, longitude: 10.0001, accuracyMeters: 5 },
    });
    await settle(w, { home: 1, away: 1, events: [
      { scorerPlayerId: w.lewa.playerId, minuteRegulation: 55 },
      { scorerPlayerId: w.mbappe.playerId, minuteRegulation: 45, minuteStoppage: 10 },
    ] });
    const prediction = await repo.getPredictionForMember(w.match.matchId, guesser.gamingMemberId);
    const evaluation = await repo.getCurrentEvaluationForPrediction(prediction!.predictionId);
    expect(evaluation!.firstTeamToScoreCorrect).toBe(true);
  }, 60000);

  it("the database digest equals the TypeScript digest for the same content", async () => {
    const w = await world({ 4: "Jersey" }, false);
    for (const result of [
      resultA(w),
      { home: 0, away: 1, events: [{ scorerPlayerId: w.mbappe.playerId, minuteRegulation: 30, isOwnGoal: true }] },
      { home: 2, away: 1, events: [
        { scorerPlayerId: w.mbappe.playerId, minuteRegulation: 45, minuteStoppage: 3 },
        { scorerPlayerId: w.lewa.playerId, minuteRegulation: 70 },
        { scorerPlayerId: w.vini.playerId, minuteRegulation: 90 },
        { scorerPlayerId: w.lewa.playerId, minuteRegulation: 105, minuteStoppage: 1 },
      ] },
      { home: 0, away: 0, events: [] as Ev[] },
    ]) {
      const saved = await save(w, result);
      const events = await repo.listGoalEventsForResult(saved.matchResultId);
      const local = computeMatchResultContentDigest({
        matchResultId: saved.matchResultId, matchId: saved.matchId, homeTeamId: w.home.teamId, awayTeamId: w.away.teamId,
        homeScore: saved.homeScore, awayScore: saved.awayScore, supersedesMatchResultId: saved.supersedesMatchResultId, events,
      });
      expect(local).toBe(saved.contentDigest);
      expect(await repo.getMatchResultContentDigest(saved.matchResultId)).toBe(saved.contentDigest);
    }
  }, 60000);

  it("the verified result view pairs the content shown with its own digest", async () => {
    const w = await world({ 4: "Jersey" }, false);
    await settle(w, resultA(w));
    const draft = await save(w, resultB(w));
    const view = await readResultView(repo, w.match.matchId);
    expect(view.draft).toMatchObject({ matchResultId: draft.matchResultId, contentDigest: draft.contentDigest });
    expect(view.currentFinalized!.contentDigest).toBe(await repo.getMatchResultContentDigest(view.currentFinalized!.matchResultId));
  }, 60000);
});

// ---------------------------------------------------------------------
// Reviewed-content finalization
// ---------------------------------------------------------------------

describe("Finalize / correct require the reviewed content (database)", () => {
  it("rejects missing and stale digests, checks authority first, and replays idempotently only for the finalized content", async () => {
    const w = await world();
    const saved = await save(w, resultA(w));
    await expect(repo.finalizeMatchResult(saved.matchResultId, w.finalizer.gamingMemberId, null, "")).rejects.toBeInstanceOf(MatchResultDigestRequiredError);
    // The pre-digest signature no longer exists as a separate entry point: omitting the digest fails closed.
    const legacy = await admin.rpc("finalize_match_result_atomically", { p_match_result_id: saved.matchResultId, p_finalized_by_gaming_member_id: w.finalizer.gamingMemberId, p_reason: null });
    expect(legacy.error?.message).toContain("MATCH_RESULT_DIGEST_REQUIRED");

    await expect(repo.finalizeMatchResult(saved.matchResultId, w.operator.gamingMemberId, null, saved.contentDigest)).rejects.toBeInstanceOf(InsufficientPlatformAuthorityError);
    await expect(repo.finalizeMatchResult(saved.matchResultId, w.operator.gamingMemberId, null, "0".repeat(64))).rejects.toBeInstanceOf(InsufficientPlatformAuthorityError);

    const edited = await save(w, resultB(w), saved.contentDigest);
    await expect(repo.finalizeMatchResult(saved.matchResultId, w.finalizer.gamingMemberId, null, saved.contentDigest)).rejects.toBeInstanceOf(MatchResultDigestMismatchError);
    expect((await repo.getMatchResultById(saved.matchResultId))!.finalizedAt).toBeNull();
    expect(await rows(w)).toHaveLength(0);

    const finalized = await repo.finalizeMatchResult(saved.matchResultId, w.finalizer.gamingMemberId, null, edited.contentDigest);
    expect(finalized.alreadyFinalized).toBe(false);
    const replay = await repo.finalizeMatchResult(saved.matchResultId, w.finalizer.gamingMemberId, null, edited.contentDigest);
    expect(replay).toMatchObject({ alreadyFinalized: true });
    await expect(repo.finalizeMatchResult(saved.matchResultId, w.finalizer.gamingMemberId, null, saved.contentDigest)).rejects.toBeInstanceOf(MatchResultDigestMismatchError);
    const audit = await admin.from("admin_audit_events").select("*").eq("target_id", saved.matchResultId).eq("action_type", "FINALIZE_RESULT");
    expect(audit.data).toHaveLength(1);
  }, 60000);

  it("a correction draft cannot be finalized as a first result, and a reason and digest are required to correct", async () => {
    const w = await world();
    await settle(w, resultA(w));
    const correction = await save(w, resultB(w));
    expect(correction.isCorrection).toBe(true);
    await expect(repo.finalizeMatchResult(correction.matchResultId, w.finalizer.gamingMemberId, null, correction.contentDigest)).rejects.toBeInstanceOf(MatchResultIsCorrectionError);
    await expect(repo.correctMatchResult(correction.matchResultId, w.finalizer.gamingMemberId, "  ", correction.contentDigest)).rejects.toBeInstanceOf(ReasonRequiredError);
    await expect(repo.correctMatchResult(correction.matchResultId, w.finalizer.gamingMemberId, "Fixed scorer", "")).rejects.toBeInstanceOf(MatchResultDigestRequiredError);
    const done = await repo.correctMatchResult(correction.matchResultId, w.finalizer.gamingMemberId, "Fixed scorer", correction.contentDigest);
    expect(done.alreadyFinalized).toBe(false);
    expect((await repo.correctMatchResult(correction.matchResultId, w.finalizer.gamingMemberId, "Fixed scorer", correction.contentDigest)).alreadyFinalized).toBe(true);
  }, 60000);

  it("a stale digest is refused for a correction too", async () => {
    const w = await world();
    await settle(w, resultA(w));
    const correction = await save(w, resultB(w));
    await save(w, resultA(w), correction.contentDigest); // edited after it was reviewed
    await expect(repo.correctMatchResult(correction.matchResultId, w.finalizer.gamingMemberId, "Fix", correction.contentDigest)).rejects.toBeInstanceOf(MatchResultDigestMismatchError);
    expect((await repo.getMatchResultById(correction.matchResultId))!.finalizedAt).toBeNull();
  }, 60000);

  it("finalize and correct re-check integrity even if a draft was altered by a direct privileged write", async () => {
    const w = await world({ 4: "Jersey" }, false);
    const first = await save(w, resultA(w));
    // A privileged direct insert is allowed on a DRAFT; it makes the events disagree with the score.
    const tamper = (matchResultId: string) =>
      admin.from("official_goal_events").insert({ match_result_id: matchResultId, scorer_player_id: w.vini.playerId, minute_regulation: 60, ordinal: 2 });
    expect((await tamper(first.matchResultId)).error).toBeNull();
    const reviewedAgain = (await repo.getMatchResultContentDigest(first.matchResultId))!;
    expect(reviewedAgain).not.toBe(first.contentDigest);
    await expect(repo.finalizeMatchResult(first.matchResultId, w.finalizer.gamingMemberId, null, reviewedAgain)).rejects.toBeInstanceOf(MatchResultEventsContradictScoreError);
    expect((await repo.getMatchResultById(first.matchResultId))!.finalizedAt).toBeNull();

    // Repair the draft through the atomic save, finalize it, then do the same to a correction draft.
    const repaired = await save(w, resultA(w));
    await repo.finalizeMatchResult(repaired.matchResultId, w.finalizer.gamingMemberId, null, repaired.contentDigest);
    const correction = await save(w, resultB(w));
    expect((await tamper(correction.matchResultId)).error).toBeNull();
    const correctionAgain = (await repo.getMatchResultContentDigest(correction.matchResultId))!;
    await expect(repo.correctMatchResult(correction.matchResultId, w.finalizer.gamingMemberId, "Fix", correctionAgain)).rejects.toBeInstanceOf(MatchResultEventsContradictScoreError);
    expect((await repo.getMatchResultById(correction.matchResultId))!.finalizedAt).toBeNull();
  }, 60000);

  it("a team edit after the draft was reviewed invalidates the digest", async () => {
    const w = await world({ 4: "Jersey" }, false);
    const saved = await save(w, resultA(w));
    const replacement = await repo.createTeam({ name: `Sevilla ${randomUUID().slice(0, 8)}` });
    createdTeamIds.push(replacement.teamId);
    await repo.editMatch(w.match.matchId, { homeTeamId: w.home.teamId, awayTeamId: replacement.teamId, competition: "Integrity Contract", kickoffAt: w.match.kickoffAt });
    expect(await repo.getMatchResultContentDigest(saved.matchResultId)).not.toBe(saved.contentDigest);
    await expect(repo.finalizeMatchResult(saved.matchResultId, w.finalizer.gamingMemberId, null, saved.contentDigest)).rejects.toBeInstanceOf(MatchResultDigestMismatchError);
  }, 60000);
});

// ---------------------------------------------------------------------
// Races on independent connections
// ---------------------------------------------------------------------

describe("Serialization on independent connections", () => {
  it("two concurrent saves from the same base: exactly one wins", async () => {
    const w = await world({ 4: "Jersey" }, false);
    const outcomes = await Promise.allSettled([save(w, resultA(w), NO_RESULT_SAVE_BASE), save(w, resultB(w), NO_RESULT_SAVE_BASE)]);
    expect(outcomes.filter((o) => o.status === "fulfilled")).toHaveLength(1);
    expect((outcomes.find((o) => o.status === "rejected") as PromiseRejectedResult).reason).toBeInstanceOf(MatchResultBaseStaleError);
    const { count } = await admin.from("match_results").select("*", { count: "exact", head: true }).eq("match_id", w.match.matchId);
    expect(count).toBe(1);
  }, 60000);

  it("a finalize that arrives while a save is in flight waits, then is refused because the reviewed content changed", async () => {
    const w = await world();
    const reviewed = await save(w, resultA(w));
    const holder = await openClient();
    try {
      await holder.query("begin");
      await holder.query(
        "select * from save_draft_match_result_atomically($1,$2,$3,$4,$5::jsonb,$6)",
        [w.match.matchId, w.operator.gamingMemberId, 1, 0, JSON.stringify([{ scorerPlayerId: w.vini.playerId, minuteRegulation: 30, minuteStoppage: null, isOwnGoal: false }]), reviewed.contentDigest]
      );
      const pending = track(repo.finalizeMatchResult(reviewed.matchResultId, w.finalizer.gamingMemberId, null, reviewed.contentDigest));
      await waitUntilBlocked("finalize_match_result_atomically");
      expect(pending.state.done).toBe(false);
      await holder.query("commit");
      await expect(pending.promise).rejects.toBeInstanceOf(MatchResultDigestMismatchError);
    } finally {
      await holder.query("rollback").catch(() => undefined);
      await holder.end();
    }
    expect((await repo.getMatchResultById(reviewed.matchResultId))!.finalizedAt).toBeNull();
    expect(await rows(w)).toHaveLength(0);
  }, 60000);

  it("a save that arrives while a finalize is in flight waits, then cannot start a correction from a stale base", async () => {
    const w = await world();
    const reviewed = await save(w, resultA(w));
    const holder = await openClient();
    try {
      await holder.query("begin");
      await holder.query("select * from finalize_match_result_atomically($1,$2,$3,$4)", [reviewed.matchResultId, w.finalizer.gamingMemberId, null, reviewed.contentDigest]);
      const pending = track(save(w, resultB(w), reviewed.contentDigest));
      await waitUntilBlocked("save_draft_match_result_atomically");
      expect(pending.state.done).toBe(false);
      await holder.query("commit");
      await expect(pending.promise).rejects.toBeInstanceOf(MatchResultBaseStaleError);
    } finally {
      await holder.query("rollback").catch(() => undefined);
      await holder.end();
    }
    expect(await repo.getDraftMatchResult(w.match.matchId)).toBeNull();
    expect(await repo.getMatchResultContentDigest(reviewed.matchResultId)).toBe(reviewed.contentDigest);
  }, 60000);

  it("a save by an editor who loaded no result, arriving while the draft's finalize is in flight, is refused — never a second first result", async () => {
    const w = await world();
    const draft = await save(w, resultA(w));
    const holder = await openClient();
    try {
      await holder.query("begin");
      await holder.query("select * from finalize_match_result_atomically($1,$2,$3,$4)", [draft.matchResultId, w.finalizer.gamingMemberId, null, draft.contentDigest]);
      const pending = track(save(w, resultB(w), NO_RESULT_SAVE_BASE));
      await waitUntilBlocked("save_draft_match_result_atomically");
      expect(pending.state.done).toBe(false);
      await holder.query("commit");
      await expect(pending.promise).rejects.toBeInstanceOf(MatchResultBaseStaleError);
    } finally {
      await holder.query("rollback").catch(() => undefined);
      await holder.end();
    }
    const { data: results } = await admin.from("match_results").select("match_result_id, supersedes_match_result_id, finalized_at").eq("match_id", w.match.matchId);
    expect(results).toHaveLength(1);
    expect(results![0].finalized_at).not.toBeNull();
    expect(await repo.getDraftMatchResult(w.match.matchId)).toBeNull();
  }, 60000);

  it("the save base names the whole result state: FINAL:<digest> starts a correction; nothing else may", async () => {
    const w = await world();
    const first = await settle(w, resultA(w));
    const digest = (await repo.getMatchResultContentDigest(first.matchResultId))!;
    await expect(save(w, resultB(w), NO_RESULT_SAVE_BASE)).rejects.toBeInstanceOf(MatchResultBaseStaleError);
    await expect(save(w, resultB(w), digest)).rejects.toBeInstanceOf(MatchResultBaseStaleError);
    expect(await repo.getDraftMatchResult(w.match.matchId)).toBeNull();
    const correction = await save(w, resultB(w), `FINAL:${digest}`);
    expect(correction).toMatchObject({ isCorrection: true, supersedesMatchResultId: first.matchResultId });
    const view = await readResultView(repo, w.match.matchId);
    expect(view.saveBase).toBe(correction.contentDigest);
  }, 60000);

  it("a redemption that arrives while a correction is in flight waits, then finds the entitlement superseded", async () => {
    const w = await world();
    await settle(w, resultA(w));
    const original = (await activeRow(w))!;
    const correction = await save(w, resultA(w));
    const holder = await openClient();
    try {
      await holder.query("begin");
      await holder.query("select * from correct_match_result_atomically($1,$2,$3,$4)", [correction.matchResultId, w.finalizer.gamingMemberId, "Re-confirmed", correction.contentDigest]);
      const pending = track(redeem(w, original.prizeQualificationId));
      await waitUntilBlocked("redeem_prize_qualification_atomically");
      expect(pending.state.done).toBe(false);
      await holder.query("commit");
      await expect(pending.promise).rejects.toBeInstanceOf(QualificationSupersededError);
    } finally {
      await holder.query("rollback").catch(() => undefined);
      await holder.end();
    }
    const current = (await activeRow(w))!;
    expect(current).toMatchObject({ fulfilledByPrizeQualificationId: null, heldAt: null, redeemedAt: null });
    await redeem(w, current.prizeQualificationId);
    expect((await rows(w)).filter((r) => r.redeemedAt !== null)).toHaveLength(1);
  }, 60000);

  it("a correction that arrives while a redemption is in flight waits, then sees the delivery and links to it", async () => {
    const w = await world();
    await settle(w, resultA(w));
    const original = (await activeRow(w))!;
    const correction = await save(w, resultA(w));
    const holder = await openClient();
    try {
      await holder.query("begin");
      await holder.query("select * from redeem_prize_qualification_atomically($1,$2,$3)", [original.prizeQualificationId, w.finalizer.gamingMemberId, null]);
      const pending = track(repo.correctMatchResult(correction.matchResultId, w.finalizer.gamingMemberId, "Re-confirmed", correction.contentDigest));
      await waitUntilBlocked("correct_match_result_atomically");
      expect(pending.state.done).toBe(false);
      await holder.query("commit");
      await pending.promise;
    } finally {
      await holder.query("rollback").catch(() => undefined);
      await holder.end();
    }
    const current = (await activeRow(w))!;
    expect(current.fulfilledByPrizeQualificationId).toBe(original.prizeQualificationId);
    expect(current.redeemedAt).toBeNull();
    await expect(redeem(w, current.prizeQualificationId)).rejects.toBeInstanceOf(PrizeAlreadyFulfilledError);
    expect((await rows(w)).filter((r) => r.redeemedAt !== null)).toHaveLength(1);
  }, 60000);

  it("a correction that arrives while a hold release is in flight waits, then supersedes the released entitlement and links to the original delivery", async () => {
    const w = await world();
    await settle(w, resultA(w));
    await redeem(w, (await activeRow(w))!.prizeQualificationId);
    const original = (await rows(w))[0];
    await settle(w, resultB(w)); // Cap, held
    const held = (await activeRow(w))!;
    expect(held.heldAt).not.toBeNull();
    const correction = await save(w, resultA(w));
    const holder = await openClient();
    try {
      await holder.query("begin");
      await holder.query("select * from release_prize_qualification_hold_atomically($1,$2,$3)", [held.prizeQualificationId, w.finalizer.gamingMemberId, "Approved"]);
      const pending = track(repo.correctMatchResult(correction.matchResultId, w.finalizer.gamingMemberId, "Back to the first sheet", correction.contentDigest));
      await waitUntilBlocked("correct_match_result_atomically");
      expect(pending.state.done).toBe(false);
      await holder.query("commit");
      await pending.promise;
    } finally {
      await holder.query("rollback").catch(() => undefined);
      await holder.end();
    }
    const current = (await activeRow(w))!;
    expect(current.fulfilledByPrizeQualificationId).toBe(original.prizeQualificationId);
    const releasedButSuperseded = (await rows(w)).find((r) => r.prizeQualificationId === held.prizeQualificationId)!;
    expect(releasedButSuperseded.releasedAt).not.toBeNull();
    expect(releasedButSuperseded.supersededAt).not.toBeNull();
    expect(releasedButSuperseded.redeemedAt).toBeNull();
  }, 90000);

  it("a hold release that arrives while a correction is in flight waits, then finds the hold superseded", async () => {
    const w = await world();
    await settle(w, resultA(w));
    await redeem(w, (await activeRow(w))!.prizeQualificationId);
    await settle(w, resultB(w));
    const held = (await activeRow(w))!;
    const correction = await save(w, resultA(w));
    const holder = await openClient();
    try {
      await holder.query("begin");
      await holder.query("select * from correct_match_result_atomically($1,$2,$3,$4)", [correction.matchResultId, w.finalizer.gamingMemberId, "Back to the first sheet", correction.contentDigest]);
      const pending = track(repo.releasePrizeQualificationHold(held.prizeQualificationId, w.finalizer.gamingMemberId, "Approved"));
      await waitUntilBlocked("release_prize_qualification_hold_atomically");
      expect(pending.state.done).toBe(false);
      await holder.query("commit");
      await expect(pending.promise).rejects.toBeInstanceOf(QualificationSupersededError);
    } finally {
      await holder.query("rollback").catch(() => undefined);
      await holder.end();
    }
    expect((await rows(w)).filter((r) => r.redeemedAt !== null)).toHaveLength(1);
  }, 90000);

  it("repeated concurrent save / correct / redeem / release rounds never deadlock and never produce a second delivery", async () => {
    const w = await world();
    await settle(w, resultA(w));
    await redeem(w, (await activeRow(w))!.prizeQualificationId);

    const failures: unknown[] = [];
    for (let round = 0; round < 6; round += 1) {
      const next = round % 2 === 0 ? resultB(w) : resultA(w);
      const draft = await save(w, next);
      const before = await activeRow(w);
      const operations: Array<Promise<unknown>> = [
        repo.correctMatchResult(draft.matchResultId, w.finalizer.gamingMemberId, `Round ${round}`, draft.contentDigest),
      ];
      if (before) {
        operations.push(repo.redeemPrizeQualification(before.prizeQualificationId, w.finalizer.gamingMemberId, null));
        operations.push(repo.releasePrizeQualificationHold(before.prizeQualificationId, w.finalizer.gamingMemberId, `Release ${round}`));
      }
      for (const outcome of await Promise.allSettled(operations)) {
        if (outcome.status === "rejected") {
          const message = String((outcome.reason as Error)?.message ?? outcome.reason);
          const code = (outcome.reason as { code?: string })?.code;
          if (code === "40P01" || /deadlock/i.test(message) || /could not serialize/i.test(message)) failures.push(outcome.reason);
        }
      }
    }
    expect(failures).toEqual([]);

    const all = await rows(w);
    expect(all.filter((r) => r.supersededAt === null)).toHaveLength(1);
    for (const row of all.filter((r) => r.redeemedAt !== null)) {
      // A redeemed row was never satisfied by another delivery, and a held row is only ever redeemed after its release.
      expect(row.fulfilledByPrizeQualificationId).toBeNull();
      if (row.heldAt) expect(row.releasedAt).not.toBeNull();
    }
  }, 120000);
});

// ---------------------------------------------------------------------
// Prize policy
// ---------------------------------------------------------------------

describe("Prize policy at correction (database)", () => {
  async function anaWinsJersey(w: World) {
    await settle(w, resultA(w));
    const row = (await activeRow(w))!;
    expect(row.prizeTierId).toBe(w.tiers[4]);
    return row;
  }

  it("unredeemed entitlements are replaced as before, with a history link", async () => {
    const w = await world();
    const original = await anaWinsJersey(w);
    await settle(w, resultB(w));
    const current = (await activeRow(w))!;
    expect(current).toMatchObject({ prizeTierId: w.tiers[2], replacesPrizeQualificationId: original.prizeQualificationId, fulfilledByPrizeQualificationId: null, heldAt: null });
    expect((await rows(w)).find((r) => r.prizeQualificationId === original.prizeQualificationId)!.supersededAt).not.toBeNull();
  }, 60000);

  it("redeemed and unchanged: linked to the original delivery, not redeemable, no second redemption event, delivery evidence untouched", async () => {
    const w = await world();
    const original = await anaWinsJersey(w);
    const delivered = await redeem(w, original.prizeQualificationId);
    await settle(w, resultA(w));

    const current = (await activeRow(w))!;
    expect(current).toMatchObject({
      prizeTierId: w.tiers[4], fulfilledByPrizeQualificationId: original.prizeQualificationId,
      redeemedAt: null, redeemedByGamingMemberId: null, redeemedPrizeLabel: null, redeemedPrizeLabelBasis: null, heldAt: null,
    });
    await expect(redeem(w, current.prizeQualificationId)).rejects.toBeInstanceOf(PrizeAlreadyFulfilledError);
    const originalAfter = (await rows(w)).find((r) => r.prizeQualificationId === original.prizeQualificationId)!;
    expect(originalAfter).toMatchObject({ redeemedAt: delivered.redeemedAt, redeemedByGamingMemberId: w.finalizer.gamingMemberId, redeemedPrizeLabel: "Jersey" });
    const events = await admin.from("admin_audit_events").select("target_id").eq("action_type", "CONFIRM_PRIZE_REDEMPTION").in("target_id", (await rows(w)).map((r) => r.prizeQualificationId));
    expect(events.data).toHaveLength(1);
  }, 60000);

  it("redeemed and changed: held; release needs finalizer authority and a reason, is audited and idempotent; redemption stays a separate act", async () => {
    const w = await world();
    const original = await anaWinsJersey(w);
    await redeem(w, original.prizeQualificationId);
    await settle(w, resultB(w));
    const held = (await activeRow(w))!;
    expect(held).toMatchObject({ prizeTierId: w.tiers[2], holdPriorPrizeQualificationId: original.prizeQualificationId, redeemedAt: null });
    expect(held.holdReason).toContain("Jersey");
    expect(held.holdReason).toContain("Cap");
    await expect(redeem(w, held.prizeQualificationId)).rejects.toBeInstanceOf(PrizeQualificationHeldError);

    await expect(repo.releasePrizeQualificationHold(held.prizeQualificationId, w.operator.gamingMemberId, "ok")).rejects.toBeInstanceOf(InsufficientPlatformAuthorityError);
    await expect(repo.releasePrizeQualificationHold(held.prizeQualificationId, w.finalizer.gamingMemberId, "   ")).rejects.toBeInstanceOf(ReasonRequiredError);
    expect((await activeRow(w))!.releasedAt).toBeNull();

    const released = await repo.releasePrizeQualificationHold(held.prizeQualificationId, w.finalizer.gamingMemberId, "Founder approved the Cap");
    expect(released.alreadyReleased).toBe(false);
    expect((await repo.releasePrizeQualificationHold(held.prizeQualificationId, w.finalizer.gamingMemberId, "Founder approved the Cap")).alreadyReleased).toBe(true);
    const audit = await admin.from("admin_audit_events").select("*").eq("target_id", held.prizeQualificationId).eq("action_type", "RELEASE_PRIZE_HOLD");
    expect(audit.data).toHaveLength(1);
    expect(audit.data![0]).toMatchObject({
      actor_id: w.finalizer.gamingMemberId, authority_class_used: "CONSEQUENTIAL_FINALIZER", reason: "Founder approved the Cap", outcome: "SUCCESS",
      previous_reference: { table: "prize_qualifications", id: original.prizeQualificationId },
    });

    expect((await activeRow(w))!.redeemedAt).toBeNull(); // releasing delivers nothing
    await redeem(w, held.prizeQualificationId);
    expect((await activeRow(w))!.redeemedPrizeLabel).toBe("Cap");
    const originalAfter = (await rows(w)).find((r) => r.prizeQualificationId === original.prizeQualificationId)!;
    expect(originalAfter).toMatchObject({ redeemedPrizeLabel: "Jersey", redeemedByGamingMemberId: w.finalizer.gamingMemberId });
    await expect(repo.releasePrizeQualificationHold(original.prizeQualificationId, w.finalizer.gamingMemberId, "x")).rejects.toBeInstanceOf(PrizeQualificationNotHeldError);
  }, 90000);

  it("redeemed and the participant no longer qualifies: history preserved, no clawback", async () => {
    const w = await world({ 4: "Jersey" });
    const original = await anaWinsJersey(w);
    const delivered = await redeem(w, original.prizeQualificationId);
    await settle(w, resultB(w));
    expect(await activeRow(w)).toBeNull();
    const all = await rows(w);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ redeemedAt: delivered.redeemedAt, redeemedPrizeLabel: "Jersey" });
    expect(all[0].supersededAt).not.toBeNull();
  }, 60000);

  it("an edited prize definition is not an unchanged prize: same tier, edited label -> held", async () => {
    const w = await world();
    const original = await anaWinsJersey(w);
    await redeem(w, original.prizeQualificationId);
    const edit = await admin.from("prize_tiers").update({ prize_label: "Premium Jersey" }).eq("prize_tier_id", w.tiers[4]);
    expect(edit.error).toBeNull();
    await settle(w, resultA(w));
    const current = (await activeRow(w))!;
    expect(current.prizeTierId).toBe(w.tiers[4]);
    expect(current.heldAt).not.toBeNull();
    expect(current.fulfilledByPrizeQualificationId).toBeNull();
    expect(current.holdReason).toContain("Premium Jersey");
  }, 60000);

  it("repeated corrections keep pointing at the one real delivery", async () => {
    const w = await world();
    const original = await anaWinsJersey(w);
    await redeem(w, original.prizeQualificationId);
    await settle(w, resultA(w));
    expect((await activeRow(w))!.fulfilledByPrizeQualificationId).toBe(original.prizeQualificationId);
    await settle(w, resultA(w));
    expect((await activeRow(w))!.fulfilledByPrizeQualificationId).toBe(original.prizeQualificationId);
    await settle(w, resultB(w));
    expect((await activeRow(w))!.holdPriorPrizeQualificationId).toBe(original.prizeQualificationId);
    await settle(w, resultA(w));
    const last = (await activeRow(w))!;
    expect(last.fulfilledByPrizeQualificationId).toBe(original.prizeQualificationId);
    expect(last.heldAt).toBeNull();
    const all = await rows(w);
    expect(all).toHaveLength(5);
    expect(all.filter((r) => r.redeemedAt !== null)).toHaveLength(1);
  }, 120000);
});

// ---------------------------------------------------------------------
// Immutability of finalized evidence
// ---------------------------------------------------------------------

describe("Finalized evidence cannot be altered or deleted through ordinary paths", () => {
  it("finalized results, their goal events, evaluations and prize history reject update and delete", async () => {
    const w = await world();
    const finalized = await settle(w, resultA(w));
    const original = (await activeRow(w))!;
    await redeem(w, original.prizeQualificationId);
    await settle(w, resultB(w)); // original is now superseded + redeemed

    const mutate = async (label: string, run: () => PromiseLike<{ error: { message: string } | null }>, code: string) => {
      const { error } = await run();
      expect(error, label).not.toBeNull();
      expect(error!.message, label).toContain(code);
    };

    await mutate("update finalized result", () => admin.from("match_results").update({ home_score: 9 }).eq("match_result_id", finalized.matchResultId), "MATCH_RESULT_FINALIZED_IMMUTABLE");
    await mutate("un-finalize result", () => admin.from("match_results").update({ finalized_at: null }).eq("match_result_id", finalized.matchResultId), "MATCH_RESULT_FINALIZED_IMMUTABLE");
    await mutate("delete finalized result", () => admin.from("match_results").delete().eq("match_result_id", finalized.matchResultId), "MATCH_RESULT_FINALIZED_IMMUTABLE");

    await mutate("update finalized goal event", () => admin.from("official_goal_events").update({ minute_regulation: 21 }).eq("match_result_id", finalized.matchResultId), "MATCH_RESULT_FINALIZED_IMMUTABLE");
    await mutate("delete finalized goal event", () => admin.from("official_goal_events").delete().eq("match_result_id", finalized.matchResultId), "MATCH_RESULT_FINALIZED_IMMUTABLE");
    await mutate("insert goal event into finalized result", () => admin.from("official_goal_events").insert({ match_result_id: finalized.matchResultId, scorer_player_id: w.vini.playerId, minute_regulation: 50, ordinal: 9 }), "MATCH_RESULT_FINALIZED_IMMUTABLE");

    const evaluation = await repo.getCurrentEvaluationForPrediction((await repo.getPredictionForMember(w.match.matchId, w.ana.gamingMemberId))!.predictionId);
    await mutate("update evaluation", () => admin.from("evaluations").update({ correct_dimension_count: 4 }).eq("evaluation_id", evaluation!.evaluationId), "EVALUATION_IMMUTABLE");
    await mutate("delete evaluation", () => admin.from("evaluations").delete().eq("evaluation_id", evaluation!.evaluationId), "EVALUATION_IMMUTABLE");

    await mutate("clear redemption", () => admin.from("prize_qualifications").update({ redeemed_at: null, redeemed_by_gaming_member_id: null, redeemed_prize_label: null }).eq("prize_qualification_id", original.prizeQualificationId), "PRIZE_QUALIFICATION_IMMUTABLE");
    await mutate("rewrite delivered label", () => admin.from("prize_qualifications").update({ redeemed_prize_label: "Free car" }).eq("prize_qualification_id", original.prizeQualificationId), "PRIZE_QUALIFICATION_IMMUTABLE");
    await mutate("clear supersession", () => admin.from("prize_qualifications").update({ superseded_at: null }).eq("prize_qualification_id", original.prizeQualificationId), "PRIZE_QUALIFICATION_IMMUTABLE");
    await mutate("move entitlement to another tier", () => admin.from("prize_qualifications").update({ prize_tier_id: w.tiers[2] }).eq("prize_qualification_id", original.prizeQualificationId), "PRIZE_QUALIFICATION_IMMUTABLE");
    await mutate("delete entitlement history", () => admin.from("prize_qualifications").delete().eq("prize_qualification_id", original.prizeQualificationId), "PRIZE_QUALIFICATION_IMMUTABLE");

    // Direct redemption of a held or satisfied entitlement is refused by the table guard as well.
    const held = (await activeRow(w))!;
    expect(held.heldAt).not.toBeNull();
    await mutate("redeem a held row directly", () => admin.from("prize_qualifications").update({ redeemed_at: new Date().toISOString(), redeemed_by_gaming_member_id: w.finalizer.gamingMemberId, redeemed_prize_label: "Cap", redeemed_prize_label_basis: "SNAPSHOT_AT_REDEMPTION" }).eq("prize_qualification_id", held.prizeQualificationId), "PRIZE_QUALIFICATION_HELD");
    await settle(w, resultA(w));
    const fulfilled = (await activeRow(w))!;
    expect(fulfilled.fulfilledByPrizeQualificationId).not.toBeNull();
    await mutate("redeem a satisfied row directly", () => admin.from("prize_qualifications").update({ redeemed_at: new Date().toISOString(), redeemed_by_gaming_member_id: w.finalizer.gamingMemberId, redeemed_prize_label: "Jersey", redeemed_prize_label_basis: "SNAPSHOT_AT_REDEMPTION" }).eq("prize_qualification_id", fulfilled.prizeQualificationId), "PRIZE_ALREADY_FULFILLED");
    await mutate("insert a pre-redeemed entitlement", () => admin.from("prize_qualifications").insert({ evaluation_id: evaluation!.evaluationId, gaming_member_id: w.ana.gamingMemberId, venue_activation_id: w.activation.venueActivationId, prize_tier_id: w.tiers[4], redeemed_at: new Date().toISOString(), redeemed_by_gaming_member_id: w.finalizer.gamingMemberId, redeemed_prize_label: "Jersey" }), "PRIZE_QUALIFICATION_IMMUTABLE");

    // Evidence is unchanged after all of it.
    expect(await repo.getMatchResultContentDigest(finalized.matchResultId)).toBe(finalized.contentDigest);
    expect((await rows(w)).find((r) => r.prizeQualificationId === original.prizeQualificationId)).toMatchObject({ redeemedPrizeLabel: "Jersey", redeemedByGamingMemberId: w.finalizer.gamingMemberId });
  }, 120000);

  it("truncating settlement evidence is refused", async () => {
    const client = await openClient();
    try {
      for (const table of ["match_results", "official_goal_events", "evaluations", "prize_qualifications"]) {
        await client.query("begin");
        await expect(client.query(`truncate table ${table} cascade`)).rejects.toThrow(/SETTLEMENT_EVIDENCE_IMMUTABLE/);
        await client.query("rollback");
      }
    } finally {
      await client.query("rollback").catch(() => undefined);
      await client.end();
    }
  }, 30000);

  it("a draft can still be re-saved and the finalize path still works; only finalized evidence is frozen", async () => {
    const w = await world({ 4: "Jersey" }, false);
    const first = await save(w, resultA(w));
    const second = await save(w, resultB(w));
    expect(second.matchResultId).toBe(first.matchResultId);
    const events = await repo.listGoalEventsForResult(second.matchResultId);
    expect(events).toHaveLength(1);
    expect(events[0].scorerPlayerId).toBe(w.vini.playerId);
  }, 60000);
});

// ---------------------------------------------------------------------
// Database access boundary
// ---------------------------------------------------------------------

describe("Database access boundary", () => {
  const FUNCTIONS = [
    "match_result_content_digest",
    "assert_match_result_integrity",
    "save_draft_match_result_atomically",
    "finalize_match_result_atomically",
    "correct_match_result_atomically",
    "redeem_prize_qualification_atomically",
    "release_prize_qualification_hold_atomically",
  ];
  const TABLES = ["match_results", "official_goal_events", "evaluations", "prize_qualifications", "prize_tiers"];

  it("catalog: exactly one signature per function, executable by service_role only; settlement tables are RLS-protected with no client privileges", async () => {
    const client = await openClient();
    try {
      const { rows: functions } = await client.query(
        `select p.proname, p.oid::regprocedure::text as signature,
                has_function_privilege('anon', p.oid, 'execute') as anon_x,
                has_function_privilege('authenticated', p.oid, 'execute') as auth_x,
                has_function_privilege('service_role', p.oid, 'execute') as service_x,
                exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
                         where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_x
           from pg_proc p
          where p.pronamespace = 'public'::regnamespace and p.proname = any($1)`,
        [FUNCTIONS]
      );
      expect(functions.map((f) => f.proname).sort()).toEqual([...FUNCTIONS].sort()); // no overloads, no stale 3-argument signatures
      for (const fn of functions) {
        expect({ fn: fn.signature, anon: fn.anon_x, authenticated: fn.auth_x, public: fn.public_x, service: fn.service_x })
          .toEqual({ fn: fn.signature, anon: false, authenticated: false, public: false, service: true });
      }

      const { rows: tables } = await client.query(
        `select c.relname, c.relrowsecurity
           from pg_class c where c.relnamespace = 'public'::regnamespace and c.relname = any($1)`,
        [TABLES]
      );
      expect(tables.every((t) => t.relrowsecurity === true)).toBe(true);
      for (const role of ["anon", "authenticated"]) {
        for (const table of TABLES) {
          const { rows: privileges } = await client.query(
            `select has_table_privilege($1, $2, p) as granted, p
               from unnest(array['SELECT','INSERT','UPDATE','DELETE','TRUNCATE','REFERENCES','TRIGGER']) as p`,
            [role, `public.${table}`]
          );
          expect(privileges.filter((p) => p.granted), `${role} on ${table}`).toEqual([]);
        }
      }
    } finally {
      await client.end();
    }
  }, 30000);

  it("real anon and authenticated clients are refused every mutating function and every settlement table; service_role succeeds", async () => {
    const w = await world();
    const saved = await save(w, resultA(w));

    const password = `Pw-${randomUUID()}`;
    const signedIn = await realMember("IntegrityAuthenticated", password);
    const anon = createClient(supabaseUrl, anonKey);
    const authenticatedLogin = await createClient(supabaseUrl, anonKey).auth.signInWithPassword({ email: signedIn.email, password });
    expect(authenticatedLogin.error).toBeNull();
    const authenticated = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: `Bearer ${authenticatedLogin.data.session!.access_token}` } },
    });

    const calls: Array<[string, Record<string, unknown>]> = [
      ["match_result_content_digest", { p_match_result_id: saved.matchResultId }],
      ["assert_match_result_integrity", { p_match_result_id: saved.matchResultId }],
      ["save_draft_match_result_atomically", { p_match_id: w.match.matchId, p_entered_by_gaming_member_id: w.operator.gamingMemberId, p_home_score: 0, p_away_score: 0, p_events: [], p_save_base: saved.contentDigest }],
      ["finalize_match_result_atomically", { p_match_result_id: saved.matchResultId, p_finalized_by_gaming_member_id: w.finalizer.gamingMemberId, p_reason: null, p_expected_digest: saved.contentDigest }],
      ["correct_match_result_atomically", { p_match_result_id: saved.matchResultId, p_finalized_by_gaming_member_id: w.finalizer.gamingMemberId, p_reason: "x", p_expected_digest: saved.contentDigest }],
      ["redeem_prize_qualification_atomically", { p_prize_qualification_id: randomUUID(), p_redeemed_by_gaming_member_id: w.finalizer.gamingMemberId, p_reason: null }],
      ["release_prize_qualification_hold_atomically", { p_prize_qualification_id: randomUUID(), p_released_by_gaming_member_id: w.finalizer.gamingMemberId, p_reason: "x" }],
    ];
    for (const [label, client] of [["anon", anon], ["authenticated", authenticated]] as const) {
      for (const [fn, args] of calls) {
        const { error } = await client.rpc(fn, args);
        expect(error, `${label} ${fn}`).not.toBeNull();
        expect(error!.code, `${label} ${fn}`).toBe("42501");
      }
      for (const table of TABLES) {
        const read = await client.from(table).select("*").limit(1);
        expect(read.error, `${label} read ${table}`).not.toBeNull();
        expect(read.error!.code, `${label} read ${table}`).toBe("42501");
        const write = await client.from(table).insert({}).select();
        expect(write.error, `${label} insert ${table}`).not.toBeNull();
        const update = await client.from(table).update({ created_at: new Date().toISOString() }).neq("created_at", "1970-01-01").select();
        expect(update.error, `${label} update ${table}`).not.toBeNull();
        const del = await client.from(table).delete().neq("created_at", "1970-01-01").select();
        expect(del.error, `${label} delete ${table}`).not.toBeNull();
      }
    }

    // Nothing the direct clients attempted changed anything; the privileged application path still works end to end.
    expect(await repo.getMatchResultContentDigest(saved.matchResultId)).toBe(saved.contentDigest);
    const done = await repo.finalizeMatchResult(saved.matchResultId, w.finalizer.gamingMemberId, null, saved.contentDigest);
    expect(done.alreadyFinalized).toBe(false);
    expect((await activeRow(w))!.prizeTierId).toBe(w.tiers[4]);
  }, 120000);
});
