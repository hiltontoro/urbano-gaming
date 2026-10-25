import { randomUUID } from "node:crypto";

import { loadEnv } from "vite";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { SupabasePredictionsRepository } from "../lib/gaming/predictions/db/supabasePredictionsRepository";
import { SupabaseGamingRepository } from "../lib/gaming/db/supabaseGamingRepository";
import { InMemoryPredictionsRepository } from "../lib/gaming/predictions/db/inMemoryPredictionsRepository";
import { submitPrediction } from "../lib/gaming/predictions/submitPrediction";
import { computeLadderOffer } from "../lib/gaming/predictions/prizeLadder";
import {
  ContractFrozenError,
  ContractMismatchError,
  InvalidAttemptShapeError,
  LevelNotOfferedError,
  OfferChangedError,
  OfferDigestRequiredError,
  OfferFrozenError,
  OfferNotAvailableError,
  PrizeQualificationHeldError,
  ResultAlreadyFinalizedError,
  TierKeyContractMismatchError,
  KickoffPassedError,
  GeoNotEligibleError,
  MatchCancelledError,
  VenueActivationDisabledError,
  VenueActivationImmutableError,
} from "../lib/gaming/predictions/types";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";
import { localSettlementDatabaseUrl, purgeSettlementEvidence } from "./helpers/localSettlementCleanup";
import {
  NEAR,
  answersFor,
  buildLadderWorld,
  expectSettled,
  goallessCases,
  offerDigestOf,
  settle,
  submitAs,
  twoOneCases,
  type LadderCase,
  type LadderEnv,
  type LadderWorld,
} from "./helpers/progressiveLadderScenarios";

/**
 * URBANO Score — progressive predictions and the prize ladder, against the
 * real database (migrations 20261023180000 and 20261023180100).
 *
 * What this proves, with the same scenario tables the in-memory suite runs:
 * the won level is the consecutive correct prefix; a category that was not
 * attempted is never evaluated as correct; NONE and not-attempted are
 * different; only a consecutive offered prefix takes participations; the
 * accepted offer and the contract cannot change under a participant; closing
 * at kickoff and at a finalized result; one prize per participation under
 * correction and under concurrency from independent clients; the table
 * constraints hold whatever writes the row; and every new or replaced
 * function stays server-only.
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
const authOptions = { auth: { persistSession: false, autoRefreshToken: false } };

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
}, 120000);

// ---------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------

async function realMember(displayName: string, password?: string) {
  const email = `ladder-contract-${randomUUID()}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true, ...(password ? { password } : {}) });
  if (error || !data.user) throw error ?? new Error("Failed to create test auth user.");
  createdAuthUserIds.push(data.user.id);
  const member = await gamingRepo.createGamingMember(data.user.id, displayName);
  createdGamingMemberIds.push(member.gamingMemberId);
  return { gamingMemberId: member.gamingMemberId, email };
}

async function grant(gamingMemberId: string, authorityClass: "CONSEQUENTIAL_FINALIZER" | "OPERATIONAL") {
  const { error } = await admin.from("authority_grants").insert({ gaming_member_id: gamingMemberId, authority_class: authorityClass });
  if (error) throw error;
}

async function openClient(): Promise<Client> {
  const client = new Client({ connectionString: databaseUrl, statement_timeout: 30000 });
  await client.connect();
  return client;
}

async function withDb<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const client = await openClient();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

/** Runs the statement in a transaction that is always rolled back, so a rejected or accepted probe leaves nothing behind. */
async function probe(sql: string, params: unknown[] = []): Promise<{ ok: true; rows: any[] } | { ok: false; message: string; code?: string; constraint?: string }> {
  return withDb(async (client) => {
    await client.query("begin");
    try {
      const result = await client.query(sql, params);
      return { ok: true as const, rows: result.rows };
    } catch (error) {
      const e = error as { message: string; code?: string; constraint?: string };
      return { ok: false as const, message: e.message, code: e.code, constraint: e.constraint };
    } finally {
      await client.query("rollback").catch(() => undefined);
    }
  });
}

function expectRejected(result: Awaited<ReturnType<typeof probe>>, matcher: RegExp, label = "") {
  expect(result.ok, `${label}: expected the database to refuse this`).toBe(false);
  if (!result.ok) expect(`${result.message} ${result.constraint ?? ""}`, label).toMatch(matcher);
}

let finalizerMember: { gamingMemberId: string; email: string } | null = null;
let operatorMember: { gamingMemberId: string; email: string } | null = null;

async function sqlEnv(): Promise<LadderEnv> {
  if (!finalizerMember) {
    finalizerMember = await realMember("LadderFinalizer");
    await grant(finalizerMember.gamingMemberId, "CONSEQUENTIAL_FINALIZER");
    operatorMember = await realMember("LadderOperator");
    await grant(operatorMember.gamingMemberId, "OPERATIONAL");
  }
  const tracked: LadderEnv = {
    repo,
    newMember: async (label) => (await realMember(label)).gamingMemberId,
    finalizerId: finalizerMember.gamingMemberId,
    operatorId: operatorMember!.gamingMemberId,
  };
  return tracked;
}

/** buildLadderWorld that also registers every created row for the cleanup above. */
async function world(levels: number[], extra: { kickoffAt?: string } = {}) {
  const e = await sqlEnv();
  const w = await buildLadderWorld(e, { offeredLevels: levels, kickoffAt: extra.kickoffAt });
  createdMatchIds.push(w.matchId);
  createdVenueIds.push(w.venueId);
  createdTeamIds.push(w.homeTeamId, w.awayTeamId);
  return { e, w };
}

const ALL = { S: true, F: true, G: true, M: true };

// ---------------------------------------------------------------------
// The scenario tables, on SQL, and in parity with the in-memory model
// ---------------------------------------------------------------------

interface Observed {
  attempted: number | null;
  ladder: number | null;
  outcomes: [boolean | null, boolean | null, boolean | null, boolean | null];
  hits: number;
  prize: string | null;
  attemptedStates: [string | null, string | null, string | null];
}

async function observe(e: LadderEnv, w: LadderWorld, memberId: string): Promise<Observed> {
  const prediction = (await e.repo.getPredictionForMember(w.matchId, memberId))!;
  const evaluation = (await e.repo.getCurrentEvaluationForPrediction(prediction.predictionId))!;
  const qualification = await e.repo.getQualificationForEvaluation(evaluation.evaluationId);
  const prize = qualification
    ? (Object.entries(w.tierIdByLevel).find(([, id]) => id === qualification.prizeTierId)?.[0] ?? "unknown-tier")
    : null;
  return {
    attempted: evaluation.attemptedLevel,
    ladder: evaluation.ladderLevel,
    outcomes: [evaluation.scorelineCorrect, evaluation.firstTeamToScoreCorrect, evaluation.goalscorerCorrect, evaluation.goalMinuteCorrect],
    hits: evaluation.correctDimensionCount,
    prize: prize === null ? null : `level ${prize}`,
    attemptedStates: [prediction.firstTeamState, prediction.goalscorerState, prediction.goalMinuteState],
  };
}

async function runGroup(e: LadderEnv, w: LadderWorld, cases: LadderCase[], official: "TWO_ONE" | "GOALLESS") {
  const members: string[] = [];
  const predictions = [];
  for (const c of cases) {
    const memberId = await e.newMember("member");
    members.push(memberId);
    predictions.push(await submitAs(e, w, memberId, c.build(w)));
  }
  await settle(e, w, official);
  const observed: Observed[] = [];
  for (let i = 0; i < cases.length; i++) {
    await expectSettled(e, w, members[i], cases[i], predictions[i]);
    observed.push(await observe(e, w, members[i]));
  }
  return observed;
}

function memoryEnv(): LadderEnv {
  const memory = new InMemoryPredictionsRepository();
  memory.authorityRepository.seedAuthority("gm-final", "CONSEQUENTIAL_FINALIZER");
  return { repo: memory, newMember: async (label) => `${label}-${randomUUID().slice(0, 8)}`, finalizerId: "gm-final", operatorId: "gm-final" };
}

describe("scenario tables on the real functions", () => {
  it("the 30 prefix cases (the 16 complete attempts are the level-4 ones) settle by the consecutive correct prefix, and agree with the in-memory model", async () => {
    const { e, w } = await world([1, 2, 3, 4]);
    const cases = twoOneCases();
    const sql = await runGroup(e, w, cases, "TWO_ONE");

    const m = memoryEnv();
    const mw = await buildLadderWorld(m, { offeredLevels: [1, 2, 3, 4] });
    const memory = await runGroup(m, mw, cases, "TWO_ONE");
    expect(sql).toEqual(memory);
  }, 180000);

  it("the goalless match: NONE is right, a pick is wrong, not attempted is neither — and SQL agrees with the in-memory model", async () => {
    const { e, w } = await world([1, 2, 3, 4]);
    const cases = goallessCases();
    const sql = await runGroup(e, w, cases, "GOALLESS");

    const m = memoryEnv();
    const mw = await buildLadderWorld(m, { offeredLevels: [1, 2, 3, 4] });
    const memory = await runGroup(m, mw, cases, "GOALLESS");
    expect(sql).toEqual(memory);
    expect(sql[0]).toMatchObject({ attempted: 4, ladder: 4, prize: "level 4" }); // 0-0 with every NONE reaches Legendary
  }, 120000);

  it("attempting fewer levels cannot win a higher prize, whatever is right", async () => {
    const { e, w } = await world([1, 2, 3, 4]);
    const member = await e.newMember("two-levels");
    const prediction = await submitAs(e, w, member, answersFor(w, 2, ALL));
    await settle(e, w, "TWO_ONE");
    const evaluation = (await repo.getCurrentEvaluationForPrediction(prediction.predictionId))!;
    expect(evaluation).toMatchObject({ attemptedLevel: 2, ladderLevel: 2, goalscorerCorrect: null, goalMinuteCorrect: null });
    // The table itself refuses a higher won level for this evaluation.
    const refused = await probe(
      `insert into evaluations (prediction_id, match_result_id, scoreline_correct, first_team_to_score_correct, goalscorer_correct, goal_minute_correct,
                               correct_dimension_count, prediction_contract, attempted_level, ladder_level)
       values ($1, gen_random_uuid(), true, true, true, true, 4, 'PROGRESSIVE_LADDER_V1', 2, 4)`,
      [prediction.predictionId]
    );
    expectRejected(refused, /evaluations_contract_shape|match_result_id|violates/, "won level above attempted level");
  }, 120000);

  it("the SQL ladder-level function and the application's function give the same answer for all 16 combinations", async () => {
    const { wonLevelOf } = await import("../lib/gaming/predictions/prizeLadder");
    for (let n = 0; n < 16; n++) {
      const [s, f, g, m] = [(n & 8) !== 0, (n & 4) !== 0, (n & 2) !== 0, (n & 1) !== 0];
      const result = await probe("select prediction_prize_ladder_level($1, $2, $3, $4) as level", [s, f, g, m]);
      expect(result.ok && result.rows[0].level).toBe(wonLevelOf({ scoreline: s, firstTeam: f, goalscorer: g, goalMinute: m }));
    }
    // A category that was not attempted (null) stops the ladder; it is never read as correct.
    const nulls = await probe("select prediction_prize_ladder_level(true, true, null, true) as a, prediction_prize_ladder_level(null, true, true, true) as b, prediction_prize_ladder_level(true, null, null, null) as c");
    expect(nulls.ok && nulls.rows[0]).toEqual({ a: 2, b: 0, c: 1 });
  });
});

// ---------------------------------------------------------------------
// The offer
// ---------------------------------------------------------------------

describe("the offered levels, enforced by the function and by the table", () => {
  it.each([[[1]], [[1, 2]], [[1, 2, 3]], [[1, 2, 3, 4]]])("levels %j: up to the last can be attempted, nothing above", async (levels) => {
    const { e, w } = await world(levels);
    for (let level = 1; level <= levels.length; level++) {
      const member = await e.newMember("m");
      const prediction = await submitAs(e, w, member, answersFor(w, level, ALL));
      expect(prediction.attemptedLevel).toBe(level);
      expect(prediction.acceptedOfferMaxLevel).toBe(levels.length);
    }
    if (levels.length < 4) {
      const member = await e.newMember("m");
      await expect(submitAs(e, w, member, answersFor(w, levels.length + 1, ALL))).rejects.toBeInstanceOf(LevelNotOfferedError);
      expect(await repo.getPredictionForMember(w.matchId, member)).toBeNull();
    }
  }, 120000);

  it.each([
    ["no prizes", [] as number[]],
    ["Medium alone", [2]],
    ["Easy and Hard (a gap)", [1, 3]],
    ["Easy, Medium and Legendary (a gap)", [1, 2, 4]],
    ["Hard and Legendary without Easy", [3, 4]],
    ["Legendary alone", [4]],
  ])("an activation with %s takes no new participation", async (_name, levels) => {
    const { e, w } = await world(levels);
    for (const level of [1, 2, 3, 4]) {
      const member = await e.newMember("m");
      await expect(submitAs(e, w, member, answersFor(w, level, ALL), { offerDigest: "x" })).rejects.toBeInstanceOf(OfferNotAvailableError);
      expect(await repo.getPredictionForMember(w.matchId, member)).toBeNull();
    }
  }, 120000);

  it("a direct write cannot get around the function: a level above the offer, an unavailable offer or a stale offer is refused by the table", async () => {
    const { e, w } = await world([1, 2]);
    const member = await e.newMember("direct");
    const digest = (await offerDigestOf(e, w))!;
    const insert = (states: [string, string, string], values: { team?: string; player?: string; minute?: number }, offer: { digest: string; max: number }) =>
      probe(
        `insert into predictions (match_id, gaming_member_id, venue_activation_id, predicted_home_score, predicted_away_score,
                predicted_first_team_to_score, predicted_goalscorer_player_id, predicted_goal_minute_regulation,
                prediction_contract, first_team_state, goalscorer_state, goal_minute_state, accepted_offer_digest, accepted_offer_max_level,
                geo_verified_at, measured_distance_meters, geo_eligible)
         values ($1, $2, $3, 1, 0, $4, $5, $6, 'PROGRESSIVE_LADDER_V1', $7, $8, $9, $10, $11, now(), 1, true) returning attempted_level`,
        [w.matchId, member, w.activationId, values.team ?? null, values.player ?? null, values.minute ?? null, states[0], states[1], states[2], offer.digest, offer.max]
      );
    // Level 1 and 2 are offered...
    const ok1 = await insert(["NOT_ATTEMPTED", "NOT_ATTEMPTED", "NOT_ATTEMPTED"], {}, { digest, max: 2 });
    expect(ok1.ok && ok1.rows[0].attempted_level).toBe(1);
    const ok2 = await insert(["NONE", "NOT_ATTEMPTED", "NOT_ATTEMPTED"], {}, { digest, max: 2 });
    expect(ok2.ok && ok2.rows[0].attempted_level).toBe(2);
    // ...level 3 is not.
    expectRejected(await insert(["NONE", "NONE", "NOT_ATTEMPTED"], {}, { digest, max: 2 }), /LEVEL_NOT_OFFERED/, "level 3 on a 2-level offer");
    // A stale fingerprint, or a falsified highest level, is refused.
    expectRejected(await insert(["NOT_ATTEMPTED", "NOT_ATTEMPTED", "NOT_ATTEMPTED"], {}, { digest: "0".repeat(64), max: 2 }), /OFFER_CHANGED/, "stale digest");
    expectRejected(await insert(["NOT_ATTEMPTED", "NOT_ATTEMPTED", "NOT_ATTEMPTED"], {}, { digest, max: 4 }), /OFFER_CHANGED|predictions_attempted_level_offered/, "falsified maximum");
    // An activation with no valid offer takes nothing, even by a direct write.
    const bad = await world([1, 3]);
    const badMember = await bad.e.newMember("bad");
    const badInsert = await probe(
      `insert into predictions (match_id, gaming_member_id, venue_activation_id, predicted_home_score, predicted_away_score, prediction_contract,
              first_team_state, goalscorer_state, goal_minute_state, accepted_offer_digest, accepted_offer_max_level, geo_verified_at, measured_distance_meters, geo_eligible)
       values ($1, $2, $3, 1, 0, 'PROGRESSIVE_LADDER_V1', 'NOT_ATTEMPTED', 'NOT_ATTEMPTED', 'NOT_ATTEMPTED', $4, 1, now(), 1, true)`,
      [bad.w.matchId, badMember, bad.w.activationId, "a".repeat(64)]
    );
    expectRejected(badInsert, /OFFER_NOT_AVAILABLE/, "unavailable offer");
  }, 120000);

  it("the submission function refuses a level above the offer and a stale fingerprint by itself, with every trigger disabled", async () => {
    // Defense in depth: the table guard refuses these too, but the function must not depend on it. The probe runs the function in a
    // transaction that is rolled back, with triggers off (local superuser, this transaction only).
    const { e, w } = await world([1, 2]);
    const member = await e.newMember("direct-function");
    const digest = (await offerDigestOf(e, w))!;
    // The scoreline is 0-0 because a "none" answer is only coherent with no goals: the test is about the offer (level, fingerprint), not
    // about coherence, so its fixture must be coherent whichever version of the function it meets.
    const call = (level: number, stale = false) =>
      withDb(async (client) => {
        await client.query("begin");
        try {
          await client.query("set local session_replication_role = replica");
          const states = (n: number) => (level >= n ? "'NONE'" : "'NOT_ATTEMPTED'");
          const result = await client.query(
            `select * from upsert_progressive_prediction_atomically($1,$2,$3,$4,0,0,${states(2)},null,${states(3)},null,${states(4)},null,null,$5,now(),1,null,true)`,
            [w.matchId, member, w.activationId, level, stale ? "0".repeat(64) : digest]
          );
          return { ok: true as const, level: result.rows[0].attempted_level };
        } catch (error) {
          return { ok: false as const, message: (error as Error).message };
        } finally {
          await client.query("rollback").catch(() => undefined);
        }
      });
    expect(await call(2)).toMatchObject({ ok: true, level: 2 });
    const above = await call(3);
    expect(above.ok).toBe(false);
    expect(!above.ok && above.message).toMatch(/LEVEL_NOT_OFFERED/);
    const stale = await call(1, true);
    expect(stale.ok).toBe(false);
    expect(!stale.ok && stale.message).toMatch(/OFFER_CHANGED/);
  }, 60000);

  it("the SQL offer functions agree with the application for every configuration of levels", async () => {
    const e = await sqlEnv();
    const configs: number[][] = [[], [1], [2], [1, 2], [1, 3], [1, 2, 3], [1, 2, 4], [3, 4], [1, 2, 3, 4], [4]];
    for (const levels of configs) {
      const w = await buildLadderWorld(e, { offeredLevels: levels });
      createdMatchIds.push(w.matchId);
      createdVenueIds.push(w.venueId);
      createdTeamIds.push(w.homeTeamId, w.awayTeamId);
      const offer = computeLadderOffer(await repo.listPrizeTiersForActivation(w.activationId));
      const result = await probe("select progressive_offer_max_level($1) as max, progressive_offer_digest($1) as digest", [w.activationId]);
      expect(result.ok && Number(result.rows[0].max), JSON.stringify(levels)).toBe(offer.maxLevel);
      expect(result.ok && result.rows[0].digest, JSON.stringify(levels)).toBe(offer.digest);
    }
  }, 120000);

  it("the SQL fingerprint equals the application's for awkward labels (accents, quotes, newlines, emoji, a label that looks like another line)", async () => {
    const e = await sqlEnv();
    const w = await buildLadderWorld(e, { offeredLevels: [] });
    createdMatchIds.push(w.matchId);
    createdVenueIds.push(w.venueId);
    createdTeamIds.push(w.homeTeamId, w.awayTeamId);
    const labels = ["Camiseta oficial ⚽", 'Cena "para dos" · 50%', "Línea 1\nLínea 2", "2|3|xyz", "🎽🎫"];
    for (let i = 0; i < labels.length; i++) {
      await repo.createLadderPrizeTier({ venueActivationId: w.activationId, ladderLevel: i + 1, prizeLabel: labels[i] });
      const offer = computeLadderOffer(await repo.listPrizeTiersForActivation(w.activationId));
      const result = await probe("select progressive_offer_digest($1) as digest", [w.activationId]);
      expect(result.ok && result.rows[0].digest, `after level ${i + 1}`).toBe(offer.digest);
      if (i === 3) break; // levels are 1..4
    }
  }, 60000);
});

// ---------------------------------------------------------------------
// Protecting the accepted offer
// ---------------------------------------------------------------------

describe("the accepted offer cannot change silently", () => {
  it("refuses a submission made against an offer that changed before anyone accepted it, then accepts the current one", async () => {
    const { e, w } = await world([1, 2]);
    const seen = await offerDigestOf(e, w);
    await repo.createLadderPrizeTier({ venueActivationId: w.activationId, ladderLevel: 3, prizeLabel: "Added Hard prize" });
    const member = await e.newMember("m");
    await expect(submitAs(e, w, member, answersFor(w, 1, ALL), { offerDigest: seen })).rejects.toBeInstanceOf(OfferChangedError);
    await expect(submitAs(e, w, member, answersFor(w, 1, ALL), { offerDigest: null })).rejects.toBeInstanceOf(OfferDigestRequiredError);
    const ok = await submitAs(e, w, member, answersFor(w, 3, ALL));
    expect(ok.acceptedOfferMaxLevel).toBe(3);
    expect(ok.acceptedOfferDigest).toBe(await offerDigestOf(e, w));
  }, 60000);

  it("freezes levels, labels and the highest level offered from the first prediction — through the repository, the API client and direct SQL", async () => {
    const { e, w } = await world([1, 2]);
    const member = await e.newMember("m");
    await submitAs(e, w, member, answersFor(w, 2, ALL));

    await expect(repo.createLadderPrizeTier({ venueActivationId: w.activationId, ladderLevel: 3, prizeLabel: "Late" })).rejects.toBeInstanceOf(OfferFrozenError);
    const viaApi = await admin.from("prize_tiers").update({ prize_label: "Cheaper" }).eq("prize_tier_id", w.tierIdByLevel[1]);
    expect(viaApi.error?.message).toMatch(/OFFER_FROZEN/);
    const viaApiDelete = await admin.from("prize_tiers").delete().eq("prize_tier_id", w.tierIdByLevel[2]);
    expect(viaApiDelete.error?.message).toMatch(/OFFER_FROZEN/);
    expectRejected(await probe("update prize_tiers set ladder_level = 3 where prize_tier_id = $1", [w.tierIdByLevel[2]]), /OFFER_FROZEN/, "move a level");
    expectRejected(await probe("update prize_tiers set venue_activation_id = (select venue_activation_id from venue_activations where venue_activation_id <> $2 limit 1) where prize_tier_id = $1", [w.tierIdByLevel[2], w.activationId]), /OFFER_FROZEN|TIER_KEY_CONTRACT_MISMATCH/, "move to another activation");

    const tiers = await repo.listPrizeTiersForActivation(w.activationId);
    expect(tiers.map((t) => `${t.ladderLevel}:${t.prizeLabel}`)).toEqual(["1:Prize L1", "2:Prize L2"]);
    expect((await repo.getPredictionForMember(w.matchId, member))!.acceptedOfferDigest).toBe(await offerDigestOf(e, w));
  }, 60000);

  it("freezes an activation on its own, and leaves a historical match's prizes editable as before", async () => {
    const { e, w } = await world([1]);
    const otherVenue = await repo.createVenue({ name: `Other Venue ${randomUUID().slice(0, 6)}`, latitude: 10, longitude: 10, radiusMeters: 100 });
    createdVenueIds.push(otherVenue.venueId);
    const second = await repo.createVenueActivation({ matchId: w.matchId, venueId: otherVenue.venueId });
    await repo.createLadderPrizeTier({ venueActivationId: second.venueActivationId, ladderLevel: 1, prizeLabel: "Other Easy" });
    await submitAs(e, w, await e.newMember("m"), answersFor(w, 1, ALL));
    await expect(repo.createLadderPrizeTier({ venueActivationId: w.activationId, ladderLevel: 2, prizeLabel: "x" })).rejects.toBeInstanceOf(OfferFrozenError);
    await expect(repo.createLadderPrizeTier({ venueActivationId: second.venueActivationId, ladderLevel: 2, prizeLabel: "Other Medium" })).resolves.toBeTruthy();

    const home = await repo.createTeam({ name: `H ${randomUUID().slice(0, 6)}` });
    const away = await repo.createTeam({ name: `A ${randomUUID().slice(0, 6)}` });
    createdTeamIds.push(home.teamId, away.teamId);
    const legacy = await repo.createMatch({ homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Old", kickoffAt: new Date(Date.now() + 3600_000).toISOString() });
    createdMatchIds.push(legacy.matchId);
    expect(legacy.predictionContract).toBe("COMPLETE_COUNT_V1");
    const activation = await repo.createVenueActivation({ matchId: legacy.matchId, venueId: w.venueId });
    const tier = await repo.createPrizeTier({ venueActivationId: activation.venueActivationId, correctDimensionCount: 4, prizeLabel: "Jersey" });
    const edited = await admin.from("prize_tiers").update({ prize_label: "Better Jersey" }).eq("prize_tier_id", tier.prizeTierId);
    expect(edited.error).toBeNull();
  }, 60000);

  it("serializes 'change the offer' against 'first prediction' with independent connections: neither can slip past the other", async () => {
    // A) A tier insert holds its lock while a submission arrives with the OLD fingerprint: the submission waits,
    //    then sees the new offer and is refused (the offer changed before anyone accepted it).
    {
      const { e, w } = await world([1, 2]);
      const stale = await offerDigestOf(e, w);
      const member = await e.newMember("late");
      const tierTx = await openClient();
      await tierTx.query("begin");
      await tierTx.query("insert into prize_tiers (venue_activation_id, ladder_level, prize_label) values ($1, 3, 'Concurrent Hard')", [w.activationId]);
      const submission = submitAs(e, w, member, answersFor(w, 2, ALL), { offerDigest: stale }).then(
        () => "accepted",
        (error) => (error instanceof OfferChangedError ? "offer-changed" : `other:${(error as Error).message}`)
      );
      await new Promise((resolve) => setTimeout(resolve, 600));
      await tierTx.query("commit");
      await tierTx.end();
      expect(await submission).toBe("offer-changed");
      expect(await repo.getPredictionForMember(w.matchId, member)).toBeNull();
    }
    // B) A first prediction is in flight (uncommitted) when a tier change arrives: the change waits, then is refused.
    {
      const { e, w } = await world([1, 2]);
      const digest = (await offerDigestOf(e, w))!;
      const member = await e.newMember("first");
      const predictionTx = await openClient();
      await predictionTx.query("begin");
      await predictionTx.query(
        "select * from upsert_progressive_prediction_atomically($1,$2,$3,1,1,0,'NOT_ATTEMPTED',null,'NOT_ATTEMPTED',null,'NOT_ATTEMPTED',null,null,$4,now(),1,null,true)",
        [w.matchId, member, w.activationId, digest]
      );
      const tierChange = repo.createLadderPrizeTier({ venueActivationId: w.activationId, ladderLevel: 3, prizeLabel: "Slipped in" }).then(
        () => "accepted",
        (error) => (error instanceof OfferFrozenError ? "offer-frozen" : `other:${(error as Error).message}`)
      );
      await new Promise((resolve) => setTimeout(resolve, 600));
      await predictionTx.query("commit");
      await predictionTx.end();
      expect(await tierChange).toBe("offer-frozen");
      expect((await repo.listPrizeTiersForActivation(w.activationId)).map((t) => t.ladderLevel)).toEqual([1, 2]);
    }
  }, 120000);
});

// ---------------------------------------------------------------------
// The contract of a match
// ---------------------------------------------------------------------

describe("the prediction contract of a match", () => {
  it("is frozen from the first prediction and from the first result, and free before either", async () => {
    const { e, w } = await world([1]);
    const home = await repo.createTeam({ name: `H ${randomUUID().slice(0, 6)}` });
    const away = await repo.createTeam({ name: `A ${randomUUID().slice(0, 6)}` });
    createdTeamIds.push(home.teamId, away.teamId);
    const open = await repo.createMatch({ homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Open", kickoffAt: new Date(Date.now() + 3600_000).toISOString() });
    createdMatchIds.push(open.matchId);
    expect((await repo.setMatchPredictionContract(open.matchId, "PROGRESSIVE_LADDER_V1")).predictionContract).toBe("PROGRESSIVE_LADDER_V1");
    expect((await repo.setMatchPredictionContract(open.matchId, "COMPLETE_COUNT_V1")).predictionContract).toBe("COMPLETE_COUNT_V1");

    await submitAs(e, w, await e.newMember("m"), answersFor(w, 1, ALL));
    await expect(repo.setMatchPredictionContract(w.matchId, "COMPLETE_COUNT_V1")).rejects.toBeInstanceOf(ContractFrozenError);
    const direct = await admin.from("matches").update({ prediction_contract: "COMPLETE_COUNT_V1" }).eq("match_id", w.matchId);
    expect(direct.error?.message).toMatch(/CONTRACT_FROZEN/);

    // A draft result alone freezes it too.
    const second = await world([1]);
    const { saveResult } = await import("./helpers/predictionsResultFixtures");
    await saveResult(repo, { matchId: second.w.matchId, homeScore: 0, awayScore: 0, officialGoalEvents: [], enteredByGamingMemberId: second.e.operatorId });
    await expect(repo.setMatchPredictionContract(second.w.matchId, "COMPLETE_COUNT_V1")).rejects.toBeInstanceOf(ContractFrozenError);
  }, 120000);

  it("serializes 'change the contract' against 'first prediction' with independent connections", async () => {
    // A) the flip is in flight (uncommitted): a submission waits, then finds the other contract.
    {
      const { e, w } = await world([1]);
      const flip = await openClient();
      await flip.query("begin");
      await flip.query("update matches set prediction_contract = 'COMPLETE_COUNT_V1' where match_id = $1", [w.matchId]);
      const submission = submitAs(e, w, await e.newMember("m"), answersFor(w, 1, ALL)).then(
        () => "accepted",
        (error) => (error instanceof ContractMismatchError ? "contract-mismatch" : `other:${(error as Error).message}`)
      );
      await new Promise((resolve) => setTimeout(resolve, 600));
      await flip.query("commit");
      await flip.end();
      expect(await submission).toBe("contract-mismatch");
    }
    // B) a first prediction is in flight: the flip waits, then is refused.
    {
      const { e, w } = await world([1]);
      const digest = (await offerDigestOf(e, w))!;
      const member = await e.newMember("m");
      const tx = await openClient();
      await tx.query("begin");
      await tx.query(
        "select * from upsert_progressive_prediction_atomically($1,$2,$3,1,1,0,'NOT_ATTEMPTED',null,'NOT_ATTEMPTED',null,'NOT_ATTEMPTED',null,null,$4,now(),1,null,true)",
        [w.matchId, member, w.activationId, digest]
      );
      const flip = repo.setMatchPredictionContract(w.matchId, "COMPLETE_COUNT_V1").then(
        () => "flipped",
        (error) => (error instanceof ContractFrozenError ? "frozen" : `other:${(error as Error).message}`)
      );
      await new Promise((resolve) => setTimeout(resolve, 600));
      await tx.query("commit");
      await tx.end();
      expect(await flip).toBe("frozen");
    }
  }, 120000);

  it("a tier key must match the contract of its match, through the repository and by direct write", async () => {
    const { w } = await world([1]);
    await expect(repo.createPrizeTier({ venueActivationId: w.activationId, correctDimensionCount: 4, prizeLabel: "Jersey" })).rejects.toBeInstanceOf(TierKeyContractMismatchError);
    expectRejected(await probe("insert into prize_tiers (venue_activation_id, correct_dimension_count, prize_label) values ($1, 4, 'x')", [w.activationId]), /TIER_KEY_CONTRACT_MISMATCH/, "count tier on progressive");

    const home = await repo.createTeam({ name: `H ${randomUUID().slice(0, 6)}` });
    const away = await repo.createTeam({ name: `A ${randomUUID().slice(0, 6)}` });
    createdTeamIds.push(home.teamId, away.teamId);
    const legacy = await repo.createMatch({ homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Old", kickoffAt: new Date(Date.now() + 3600_000).toISOString() });
    createdMatchIds.push(legacy.matchId);
    const activation = await repo.createVenueActivation({ matchId: legacy.matchId, venueId: w.venueId });
    await expect(repo.createLadderPrizeTier({ venueActivationId: activation.venueActivationId, ladderLevel: 1, prizeLabel: "Easy" })).rejects.toBeInstanceOf(TierKeyContractMismatchError);
    // Exactly one key, whatever the contract.
    expectRejected(await probe("insert into prize_tiers (venue_activation_id, correct_dimension_count, ladder_level, prize_label) values ($1, 2, 2, 'x')", [w.activationId]), /prize_tiers_exactly_one_key/, "both keys");
    expectRejected(await probe("insert into prize_tiers (venue_activation_id, prize_label) values ($1, 'x')", [w.activationId]), /TIER_KEY_CONTRACT_MISMATCH|prize_tiers_exactly_one_key/, "no key");
    expectRejected(await probe("insert into prize_tiers (venue_activation_id, ladder_level, prize_label) values ($1, 5, 'x')", [w.activationId]), /prize_tiers_ladder_level_range/, "level 5");
  }, 60000);

  it("refuses a historical prediction on a progressive match and a progressive one on a historical match, at the function and at the table", async () => {
    const { e, w } = await world([1]);
    const member = await e.newMember("m");
    await expect(
      submitPrediction(repo, {
        matchId: w.matchId, gamingMemberId: member, venueActivationId: w.activationId,
        predictedHomeScore: 1, predictedAwayScore: 0, predictedGoalscorerPlayerId: null, predictedGoalMinuteRegulation: null,
        predictedGoalMinuteStoppage: null, predictedFirstTeamToScore: null, geo: NEAR,
      })
    ).rejects.toBeInstanceOf(ContractMismatchError);

    const home = await repo.createTeam({ name: `H ${randomUUID().slice(0, 6)}` });
    const away = await repo.createTeam({ name: `A ${randomUUID().slice(0, 6)}` });
    createdTeamIds.push(home.teamId, away.teamId);
    const legacy = await repo.createMatch({ homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Old", kickoffAt: new Date(Date.now() + 3600_000).toISOString() });
    createdMatchIds.push(legacy.matchId);
    await repo.setMatchActivityClassification(legacy.matchId, "TRAINING", e.finalizerId, null);
    const activation = await repo.createVenueActivation({ matchId: legacy.matchId, venueId: w.venueId });
    await expect(
      repo.upsertProgressivePrediction({
        matchId: legacy.matchId, gamingMemberId: member, venueActivationId: activation.venueActivationId,
        answers: { attemptedLevel: 1, scoreline: { home: 1, away: 0 } }, offerDigest: "x",
        geoVerifiedAt: new Date().toISOString(), measuredDistanceMeters: 1, reportedAccuracyMeters: null, geoEligible: true,
      })
    ).rejects.toBeInstanceOf(ContractMismatchError);
    // Direct write of a row of the other contract.
    expectRejected(
      await probe(
        `insert into predictions (match_id, gaming_member_id, venue_activation_id, predicted_home_score, predicted_away_score, prediction_contract,
                first_team_state, goalscorer_state, goal_minute_state, accepted_offer_digest, accepted_offer_max_level, geo_verified_at, measured_distance_meters, geo_eligible)
         values ($1, $2, $3, 1, 0, 'PROGRESSIVE_LADDER_V1', 'NOT_ATTEMPTED','NOT_ATTEMPTED','NOT_ATTEMPTED', $4, 1, now(), 1, true)`,
        [legacy.matchId, member, activation.venueActivationId, "b".repeat(64)]
      ),
      /CONTRACT_MISMATCH/, "progressive row on a historical match"
    );
  }, 60000);
});

// ---------------------------------------------------------------------
// Table constraints: whatever writes the row
// ---------------------------------------------------------------------

describe("the table refuses gaps, contradictions and a not-attempted category that holds a value", () => {
  async function fixture() {
    const { e, w } = await world([1, 2, 3, 4]);
    const member = await e.newMember("direct");
    const digest = (await offerDigestOf(e, w))!;
    const insert = (columns: Record<string, unknown>, options: { constraintsOnly?: boolean } = {}) => {
      const row: Record<string, unknown> = {
        match_id: w.matchId, gaming_member_id: member, venue_activation_id: w.activationId,
        predicted_home_score: 1, predicted_away_score: 0, prediction_contract: "PROGRESSIVE_LADDER_V1",
        first_team_state: "NOT_ATTEMPTED", goalscorer_state: "NOT_ATTEMPTED", goal_minute_state: "NOT_ATTEMPTED",
        accepted_offer_digest: digest, accepted_offer_max_level: 4, geo_verified_at: new Date().toISOString(),
        measured_distance_meters: 1, geo_eligible: true, ...columns,
      };
      const keys = Object.keys(row);
      const sql = `insert into predictions (${keys.join(", ")}) values (${keys.map((_, i) => `$${i + 1}`).join(", ")}) returning attempted_level`;
      const params = keys.map((k) => row[k]);
      // constraintsOnly runs with every trigger disabled (local superuser, this transaction only): the CHECK
      // constraints alone must refuse the row, so the guarantee does not depend on a trigger.
      return options.constraintsOnly
        ? withDb(async (client) => {
            await client.query("begin");
            try {
              await client.query("set local session_replication_role = replica");
              const result = await client.query(sql, params);
              return { ok: true as const, rows: result.rows };
            } catch (error) {
              const x = error as { message: string; code?: string; constraint?: string };
              return { ok: false as const, message: x.message, code: x.code, constraint: x.constraint };
            } finally {
              await client.query("rollback").catch(() => undefined);
            }
          })
        : probe(sql, params);
    };
    return { w, member, insert };
  }

  it("accepts every consecutive prefix and derives the attempted level from the states", async () => {
    const { w, insert } = await fixture();
    const cases: Array<[Record<string, unknown>, number]> = [
      [{}, 1],
      [{ first_team_state: "NONE" }, 2],
      [{ first_team_state: "PICKED", predicted_first_team_to_score: "AWAY" }, 2],
      [{ first_team_state: "NONE", goalscorer_state: "NONE" }, 3],
      [{ first_team_state: "PICKED", predicted_first_team_to_score: "HOME", goalscorer_state: "PICKED", predicted_goalscorer_player_id: w.players.mbappe }, 3],
      [{ first_team_state: "NONE", goalscorer_state: "NONE", goal_minute_state: "NONE" }, 4],
      [{ first_team_state: "NONE", goalscorer_state: "NONE", goal_minute_state: "PICKED", predicted_goal_minute_regulation: 45, predicted_goal_minute_stoppage: 2 }, 4],
    ];
    for (const [columns, level] of cases) {
      const result = await insert(columns);
      expect(result.ok && result.rows[0].attempted_level, JSON.stringify(columns)).toBe(level);
    }
  }, 60000);

  // [name, columns, the constraint that refuses it on its own, the guard that may refuse it first]
  const REFUSED: Array<[string, Record<string, unknown>, RegExp, RegExp | null]> = [
    ["a gap: goalscorer attempted without the first team", { goalscorer_state: "NONE" }, /predictions_progressive_no_gaps/, null],
    ["a gap: goal minute attempted without the goalscorer", { first_team_state: "NONE", goal_minute_state: "NONE" }, /predictions_progressive_no_gaps/, null],
    ["a value under NOT_ATTEMPTED (first team)", { predicted_first_team_to_score: "HOME" }, /predictions_progressive_values/, null],
    ["a value under NOT_ATTEMPTED (goal minute)", { predicted_goal_minute_regulation: 30 }, /predictions_progressive_values/, null],
    ["a value under NONE (first team)", { first_team_state: "NONE", predicted_first_team_to_score: "HOME" }, /predictions_progressive_values/, null],
    ["PICKED without a value (first team)", { first_team_state: "PICKED" }, /predictions_progressive_values/, null],
    ["PICKED without a value (goalscorer)", { first_team_state: "NONE", goalscorer_state: "PICKED" }, /predictions_progressive_values/, null],
    ["PICKED without a value (goal minute)", { first_team_state: "NONE", goalscorer_state: "NONE", goal_minute_state: "PICKED" }, /predictions_progressive_values/, null],
    ["added time without a picked minute", { first_team_state: "NONE", goalscorer_state: "NONE", goal_minute_state: "NONE", predicted_goal_minute_stoppage: 2 }, /predictions_progressive_values|stoppage/, null],
    ["added time at minute 30", { first_team_state: "NONE", goalscorer_state: "NONE", goal_minute_state: "PICKED", predicted_goal_minute_regulation: 30, predicted_goal_minute_stoppage: 2 }, /stoppage_requires_boundary/, null],
    ["a null state in a progressive row", { first_team_state: null }, /predictions_contract_shape/, null],
    ["an unknown state", { first_team_state: "MAYBE" }, /predictions_category_state_values/, null],
    ["no accepted offer in a progressive row", { accepted_offer_digest: null }, /predictions_contract_shape/, /OFFER_CHANGED/],
    ["an accepted highest level of 0", { accepted_offer_max_level: 0 }, /predictions_contract_shape|predictions_attempted_level_offered/, /OFFER_CHANGED/],
    ["an attempted level above the accepted highest level", { first_team_state: "NONE", goalscorer_state: "NONE", accepted_offer_max_level: 2 }, /predictions_attempted_level_offered/, /OFFER_CHANGED/],
    ["an unknown contract", { prediction_contract: "SOMETHING" }, /predictions_contract_known/, /CONTRACT_MISMATCH/],
    ["a historical row that carries states", { prediction_contract: "COMPLETE_COUNT_V1" }, /predictions_contract_shape/, /CONTRACT_MISMATCH/],
    ["a negative score", { predicted_home_score: -1 }, /predictions_scores_non_negative/, null],
  ];

  it.each(REFUSED)("refuses %s (with the guards, and by the constraints alone)", async (name, columns, constraint, guard) => {
    const { insert } = await fixture();
    const withGuards = await insert(columns);
    expectRejected(withGuards, guard ? new RegExp(`${constraint.source}|${guard.source}`) : constraint, `${name} (guards on)`);
    const constraintsOnly = await insert(columns, { constraintsOnly: true });
    expectRejected(constraintsOnly, constraint, `${name} (constraints alone)`);
  }, 60000);

  it("refuses to write a category above the level through an update, and clears a lower level through the function", async () => {
    const { e, w } = await world([1, 2, 3, 4]);
    const member = await e.newMember("m");
    const full = await submitAs(e, w, member, answersFor(w, 4, ALL));
    expect(full.predictedGoalMinuteRegulation).toBe(30);
    const reduced = await submitAs(e, w, member, answersFor(w, 1, ALL));
    expect(reduced).toMatchObject({
      predictionId: full.predictionId, attemptedLevel: 1,
      firstTeamState: "NOT_ATTEMPTED", goalscorerState: "NOT_ATTEMPTED", goalMinuteState: "NOT_ATTEMPTED",
      predictedFirstTeamToScore: null, predictedGoalscorerPlayerId: null, predictedGoalMinuteRegulation: null, predictedGoalMinuteStoppage: null,
    });
    expectRejected(
      await probe("update predictions set predicted_goalscorer_player_id = $2 where prediction_id = $1", [full.predictionId, w.players.mbappe]),
      /predictions_progressive_values/, "a hidden value written back"
    );
    const after = await repo.getPredictionForMember(w.matchId, member);
    expect(after!.predictedGoalscorerPlayerId).toBeNull();
  }, 60000);

  it("refuses an evaluation that contradicts the ladder or the attempted level", async () => {
    const { e, w } = await world([1, 2, 3, 4]);
    const member = await e.newMember("m");
    const prediction = await submitAs(e, w, member, answersFor(w, 2, ALL));
    await settle(e, w, "TWO_ONE");
    const base = `insert into evaluations (prediction_id, match_result_id, scoreline_correct, first_team_to_score_correct, goalscorer_correct, goal_minute_correct,
                  correct_dimension_count, prediction_contract, attempted_level, ladder_level)
                  select $1, match_result_id, $2, $3, $4, $5, $6, 'PROGRESSIVE_LADDER_V1', $7, $8 from match_results where match_id = $9 and finalized_at is not null`;
    const attempt = (flags: [boolean, boolean | null, boolean | null, boolean | null], count: number, attempted: number, won: number) =>
      probe(base, [prediction.predictionId, flags[0], flags[1], flags[2], flags[3], count, attempted, won, w.matchId]);
    // The only row valid for these flags at attempted level 2 would be (true, true, null, null, count 2, 2, 2) — and it already exists for this pair.
    expectRejected(await attempt([true, true, null, null], 2, 2, 2), /evaluations_prediction_id_match_result_id_key|duplicate key|unique/, "the one valid shape is already stored");
    expectRejected(await attempt([true, true, null, null], 2, 2, 3), /evaluations_contract_shape/, "won level above attempted");
    expectRejected(await attempt([true, false, null, null], 1, 2, 2), /evaluations_contract_shape/, "won level is not the consecutive prefix");
    expectRejected(await attempt([true, true, true, null], 3, 2, 2), /evaluations_contract_shape/, "an outcome for a category that was not attempted");
    expectRejected(await attempt([true, true, null, null], 3, 2, 2), /evaluations_contract_shape/, "count is not the number of true outcomes");
    expectRejected(await attempt([false, true, null, null], 1, 2, 2), /evaluations_contract_shape/, "scoreline wrong but level 2");
    expectRejected(await attempt([true, null, null, null], 1, 2, 1), /evaluations_contract_shape/, "a null outcome for an attempted category");
    expectRejected(
      await probe(
        `insert into evaluations (prediction_id, match_result_id, scoreline_correct, first_team_to_score_correct, goalscorer_correct, goal_minute_correct, correct_dimension_count)
         select $1, match_result_id, true, null, true, true, 3 from match_results where match_id = $2 and finalized_at is not null`,
        [prediction.predictionId, w.matchId]
      ),
      /evaluations_contract_shape|duplicate key|unique/, "a historical evaluation with a null outcome"
    );
  }, 120000);
});

// ---------------------------------------------------------------------
// Closing
// ---------------------------------------------------------------------

describe("closing", () => {
  it("closes at kickoff for a first prediction and for an edit", async () => {
    const { e, w } = await world([1, 2]);
    const early = await e.newMember("early");
    await submitAs(e, w, early, answersFor(w, 1, ALL));
    const moved = await admin.from("matches").update({ kickoff_at: new Date(Date.now() - 1000).toISOString() }).eq("match_id", w.matchId);
    expect(moved.error).toBeNull();
    await expect(submitAs(e, w, early, answersFor(w, 2, ALL))).rejects.toBeInstanceOf(KickoffPassedError);
    await expect(submitAs(e, w, await e.newMember("late"), answersFor(w, 1, ALL))).rejects.toBeInstanceOf(KickoffPassedError);
  }, 60000);

  it("rejects new predictions and edits once a result is finalized, even when the kickoff is moved later — for both contracts", async () => {
    const { e, w } = await world([1, 2]);
    const member = await e.newMember("m");
    await submitAs(e, w, member, answersFor(w, 1, ALL));
    await settle(e, w, "TWO_ONE");
    const moved = await admin.from("matches").update({ kickoff_at: new Date(Date.now() + 86_400_000).toISOString() }).eq("match_id", w.matchId);
    expect(moved.error).toBeNull();
    await expect(submitAs(e, w, member, answersFor(w, 2, ALL))).rejects.toBeInstanceOf(ResultAlreadyFinalizedError);
    await expect(submitAs(e, w, await e.newMember("new"), answersFor(w, 1, ALL))).rejects.toBeInstanceOf(ResultAlreadyFinalizedError);
    // The same by a direct write.
    expectRejected(await probe("update predictions set predicted_home_score = 9 where match_id = $1", [w.matchId]), /RESULT_ALREADY_FINALIZED/, "direct edit");
    const stored = await repo.getPredictionForMember(w.matchId, member);
    expect(stored!.attemptedLevel).toBe(1);
    expect((await repo.getCurrentEvaluationForPrediction(stored!.predictionId))!.attemptedLevel).toBe(1);

    // Historical contract: same rule through the historical function.
    const home = await repo.createTeam({ name: `H ${randomUUID().slice(0, 6)}` });
    const away = await repo.createTeam({ name: `A ${randomUUID().slice(0, 6)}` });
    createdTeamIds.push(home.teamId, away.teamId);
    const scorer = await repo.createPlayer({ teamId: home.teamId, name: "Scorer" });
    const legacy = await repo.createMatch({ homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Old", kickoffAt: new Date(Date.now() + 3600_000).toISOString() });
    createdMatchIds.push(legacy.matchId);
    await repo.setMatchActivityClassification(legacy.matchId, "TRAINING", e.finalizerId, null);
    const activation = await repo.createVenueActivation({ matchId: legacy.matchId, venueId: w.venueId });
    const legacySubmit = (id: string) =>
      submitPrediction(repo, {
        matchId: legacy.matchId, gamingMemberId: id, venueActivationId: activation.venueActivationId,
        predictedHomeScore: 1, predictedAwayScore: 0, predictedGoalscorerPlayerId: null, predictedGoalMinuteRegulation: null,
        predictedGoalMinuteStoppage: null, predictedFirstTeamToScore: null, geo: NEAR,
      });
    const legacyMember = await e.newMember("legacy");
    await legacySubmit(legacyMember);
    const { saveResult, finalizeMatchResult } = await import("./helpers/predictionsResultFixtures");
    const saved = await saveResult(repo, { matchId: legacy.matchId, homeScore: 1, awayScore: 0, officialGoalEvents: [{ scorerPlayerId: scorer.playerId, minuteRegulation: 10 }], enteredByGamingMemberId: e.operatorId });
    await finalizeMatchResult(repo, saved.matchResultId, e.finalizerId);
    await admin.from("matches").update({ kickoff_at: new Date(Date.now() + 86_400_000).toISOString() }).eq("match_id", legacy.matchId);
    await expect(legacySubmit(legacyMember)).rejects.toBeInstanceOf(ResultAlreadyFinalizedError);
    await expect(legacySubmit(await e.newMember("legacy2"))).rejects.toBeInstanceOf(ResultAlreadyFinalizedError);
  }, 120000);
});

// ---------------------------------------------------------------------
// Settlement, correction and a single delivery
// ---------------------------------------------------------------------

describe("finalization and correction under the ladder (real functions)", () => {
  async function scene() {
    const { e, w } = await world([1, 2, 3, 4]);
    const ids = { a: await e.newMember("a"), b: await e.newMember("b"), c: await e.newMember("c"), d: await e.newMember("d") };
    await submitAs(e, w, ids.a, answersFor(w, 2, ALL));
    await submitAs(e, w, ids.b, answersFor(w, 1, ALL));
    await submitAs(e, w, ids.c, answersFor(w, 4, { S: false, F: true, G: true, M: true }));
    await submitAs(e, w, ids.d, { attemptedLevel: 2, scoreline: { home: 2, away: 1 }, firstTeam: { kind: "PICKED", team: "AWAY" } });
    await settle(e, w, "TWO_ONE");
    return { e, w, ids };
  }
  async function rows(w: LadderWorld, memberId: string) {
    const all = (await repo.listQualificationsForActivation(w.activationId)).filter((q) => q.gamingMemberId === memberId);
    return { all, active: all.filter((q) => q.supersededAt === null) };
  }

  it("issues exactly the prize of the won level; a correction without delivery replaces it; history is kept", async () => {
    const { e, w, ids } = await scene();
    expect((await rows(w, ids.a)).active.map((q) => q.prizeTierId)).toEqual([w.tierIdByLevel[2]]);
    expect((await rows(w, ids.b)).active.map((q) => q.prizeTierId)).toEqual([w.tierIdByLevel[1]]);
    expect((await rows(w, ids.c)).all).toHaveLength(0);
    expect((await rows(w, ids.d)).active.map((q) => q.prizeTierId)).toEqual([w.tierIdByLevel[1]]);

    await settle(e, w, "TWO_ONE_AWAY_FIRST", "Official sheet corrected");
    expect((await rows(w, ids.a)).active.map((q) => q.prizeTierId)).toEqual([w.tierIdByLevel[1]]);
    expect((await rows(w, ids.a)).all).toHaveLength(2);
    expect((await rows(w, ids.d)).active.map((q) => q.prizeTierId)).toEqual([w.tierIdByLevel[2]]);
    for (const id of Object.values(ids)) expect((await rows(w, id)).active.length).toBeLessThanOrEqual(1);
  }, 120000);

  it("a delivered prize that the correction changes is held, worded 'level N of 4', never delivered a second time", async () => {
    const { e, w, ids } = await scene();
    const first = (await rows(w, ids.a)).active[0];
    await repo.redeemPrizeQualification(first.prizeQualificationId, e.finalizerId, null);
    await settle(e, w, "TWO_ONE_AWAY_FIRST", "Official sheet corrected");
    const held = (await rows(w, ids.a)).active[0];
    expect(held.holdBasis).toBe("DELIVERED_PRIZE_CHANGED");
    expect(held.holdReason).toContain('Delivered: "Prize L2" (level 2 of 4)');
    expect(held.holdReason).toContain('Now entitled to: "Prize L1" (level 1 of 4)');
    expect(held.holdReason).not.toContain("of 4 correct");
    await expect(repo.redeemPrizeQualification(held.prizeQualificationId, e.finalizerId, null)).rejects.toBeInstanceOf(PrizeQualificationHeldError);
  }, 120000);

  it("a delivered prize the correction leaves the same is satisfied by the original delivery", async () => {
    const { e, w, ids } = await scene();
    const first = (await rows(w, ids.b)).active[0];
    await repo.redeemPrizeQualification(first.prizeQualificationId, e.finalizerId, null);
    await settle(e, w, "TWO_ONE_AWAY_FIRST", "Official sheet corrected");
    const current = (await rows(w, ids.b)).active;
    expect(current).toHaveLength(1);
    expect(current[0].fulfilledByPrizeQualificationId).toBe(first.prizeQualificationId);
  }, 120000);

  it("the historical wording is unchanged for a historical match (still 'N of 4 correct')", async () => {
    const e = await sqlEnv();
    const home = await repo.createTeam({ name: `H ${randomUUID().slice(0, 6)}` });
    const away = await repo.createTeam({ name: `A ${randomUUID().slice(0, 6)}` });
    createdTeamIds.push(home.teamId, away.teamId);
    const scorer = await repo.createPlayer({ teamId: home.teamId, name: "Scorer" });
    const other = await repo.createPlayer({ teamId: home.teamId, name: "Other" });
    const venue = await repo.createVenue({ name: "Hist V", latitude: 10, longitude: 10, radiusMeters: 100 });
    createdVenueIds.push(venue.venueId);
    const match = await repo.createMatch({ homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Old", kickoffAt: new Date(Date.now() + 3600_000).toISOString() });
    createdMatchIds.push(match.matchId);
    await repo.setMatchActivityClassification(match.matchId, "TRAINING", e.finalizerId, null);
    const activation = await repo.createVenueActivation({ matchId: match.matchId, venueId: venue.venueId });
    await repo.createPrizeTier({ venueActivationId: activation.venueActivationId, correctDimensionCount: 4, prizeLabel: "Jersey" });
    await repo.createPrizeTier({ venueActivationId: activation.venueActivationId, correctDimensionCount: 2, prizeLabel: "Cap" });
    const member = await e.newMember("hist");
    await submitPrediction(repo, {
      matchId: match.matchId, gamingMemberId: member, venueActivationId: activation.venueActivationId,
      predictedHomeScore: 1, predictedAwayScore: 0, predictedGoalscorerPlayerId: scorer.playerId, predictedGoalMinuteRegulation: 10,
      predictedGoalMinuteStoppage: null, predictedFirstTeamToScore: "HOME", geo: NEAR,
    });
    const { saveResult, finalizeMatchResult, correctMatchResult } = await import("./helpers/predictionsResultFixtures");
    const first = await saveResult(repo, { matchId: match.matchId, homeScore: 1, awayScore: 0, officialGoalEvents: [{ scorerPlayerId: scorer.playerId, minuteRegulation: 10 }], enteredByGamingMemberId: e.operatorId });
    await finalizeMatchResult(repo, first.matchResultId, e.finalizerId);
    const prediction = (await repo.getPredictionForMember(match.matchId, member))!;
    const evaluation = (await repo.getCurrentEvaluationForPrediction(prediction.predictionId))!;
    expect(evaluation).toMatchObject({ predictionContract: "COMPLETE_COUNT_V1", attemptedLevel: null, ladderLevel: null, correctDimensionCount: 4 });
    const qualification = (await repo.listQualificationsForActivation(activation.venueActivationId))[0];
    await repo.redeemPrizeQualification(qualification.prizeQualificationId, e.finalizerId, null);
    // Corrected: another scorer at another minute. Scoreline and first team stay right, the other two are wrong: 2 of 4.
    const corrected = await saveResult(repo, { matchId: match.matchId, homeScore: 1, awayScore: 0, officialGoalEvents: [{ scorerPlayerId: other.playerId, minuteRegulation: 50 }], enteredByGamingMemberId: e.operatorId });
    await correctMatchResult(repo, corrected.matchResultId, e.finalizerId, "Scorer corrected");
    const held = (await repo.listQualificationsForActivation(activation.venueActivationId)).find((q) => q.supersededAt === null)!;
    expect(held.holdBasis).toBe("DELIVERED_PRIZE_CHANGED");
    expect(held.holdReason).toContain('Delivered: "Jersey" (4 of 4 correct)');
    expect(held.holdReason).toContain('Now entitled to: "Cap" (2 of 4 correct)');
    expect(held.holdReason).not.toContain("level");
  }, 120000);
});

// ---------------------------------------------------------------------
// Concurrency with independent clients
// ---------------------------------------------------------------------

describe("concurrent work from independent clients", () => {
  function independentRepo() {
    return new SupabasePredictionsRepository(supabaseUrl as string, serviceKey as string);
  }

  it("finalizing the same result from two clients settles it once: one qualification per winner, none doubled", async () => {
    const { e, w } = await world([1, 2]);
    const members = [await e.newMember("a"), await e.newMember("b"), await e.newMember("c")];
    for (const m of members) await submitAs(e, w, m, answersFor(w, 2, ALL));
    const spec = (await import("./helpers/progressiveLadderScenarios")).officialGoals(w, "TWO_ONE");
    const { currentSaveBase } = await import("./helpers/predictionsResultFixtures");
    const saved = await repo.saveDraftMatchResult({
      matchId: w.matchId, homeScore: spec.home, awayScore: spec.away, officialGoalEvents: spec.events,
      enteredByGamingMemberId: e.operatorId, saveBase: await currentSaveBase(repo, w.matchId),
    });
    const clients = [independentRepo(), independentRepo(), independentRepo()];
    const outcomes = await Promise.allSettled(clients.map((c) => c.finalizeMatchResult(saved.matchResultId, e.finalizerId, null, saved.contentDigest)));
    expect(outcomes.filter((o) => o.status === "fulfilled").length).toBe(3); // one settles, the others replay
    const settled = outcomes.flatMap((o) => (o.status === "fulfilled" ? [o.value] : []));
    expect(settled.filter((r) => r.alreadyFinalized === false)).toHaveLength(1);
    const qualifications = await repo.listQualificationsForActivation(w.activationId);
    expect(qualifications).toHaveLength(3);
    expect(new Set(qualifications.map((q) => q.gamingMemberId)).size).toBe(3);
    const evaluations = await withDb((c) => c.query("select count(*)::int as n from evaluations ev join predictions p on p.prediction_id = ev.prediction_id where p.match_id = $1", [w.matchId]));
    expect(evaluations.rows[0].n).toBe(3);
  }, 120000);

  it("two clients redeeming the same prize at once deliver it once", async () => {
    const { e, w } = await world([1]);
    const member = await e.newMember("winner");
    await submitAs(e, w, member, answersFor(w, 1, ALL));
    await settle(e, w, "TWO_ONE");
    const q = (await repo.listQualificationsForActivation(w.activationId))[0];
    const results = await Promise.allSettled([independentRepo(), independentRepo(), independentRepo()].map((c) => c.redeemPrizeQualification(q.prizeQualificationId, e.finalizerId, null)));
    const fulfilled = results.flatMap((r) => (r.status === "fulfilled" ? [r.value] : []));
    expect(fulfilled.filter((r) => r.alreadyRedeemed === false)).toHaveLength(1);
    const redeemedRows = await withDb((c) => c.query("select count(*)::int as n from prize_qualifications where prize_qualification_id = $1 and redeemed_at is not null", [q.prizeQualificationId]));
    expect(redeemedRows.rows[0].n).toBe(1);
  }, 120000);

  it("a correction racing a redemption never produces a second delivery", async () => {
    const { e, w } = await world([1, 2]);
    const member = await e.newMember("winner");
    await submitAs(e, w, member, answersFor(w, 2, ALL));
    await settle(e, w, "TWO_ONE");
    const first = (await repo.listQualificationsForActivation(w.activationId)).find((x) => x.supersededAt === null)!;
    const spec = (await import("./helpers/progressiveLadderScenarios")).officialGoals(w, "TWO_ONE_AWAY_FIRST");
    const { currentSaveBase } = await import("./helpers/predictionsResultFixtures");
    const draft = await repo.saveDraftMatchResult({
      matchId: w.matchId, homeScore: spec.home, awayScore: spec.away, officialGoalEvents: spec.events,
      enteredByGamingMemberId: e.operatorId, saveBase: await currentSaveBase(repo, w.matchId),
    });
    await Promise.allSettled([
      independentRepo().correctMatchResult(draft.matchResultId, e.finalizerId, "Race", draft.contentDigest),
      independentRepo().redeemPrizeQualification(first.prizeQualificationId, e.finalizerId, null),
    ]);
    const all = (await repo.listQualificationsForActivation(w.activationId)).filter((x) => x.gamingMemberId === member);
    expect(all.filter((x) => x.supersededAt === null).length).toBeLessThanOrEqual(1);
    // At most one physical delivery of the whole lineage: one redeemed row carries the delivery, none is redeemed a second time.
    expect(all.filter((x) => x.redeemedAt !== null).length).toBeLessThanOrEqual(1);
    const redeemable = all.filter((x) => x.supersededAt === null && x.redeemedAt === null && x.heldAt === null && x.fulfilledByPrizeQualificationId === null);
    if (all.some((x) => x.redeemedAt !== null)) {
      // Delivered first: whatever replaced it must be held or fulfilled, not freely deliverable.
      expect(redeemable.filter((x) => x.prizeQualificationId !== first.prizeQualificationId)).toHaveLength(0);
    }
  }, 120000);

  it("independent first submissions by one member leave one prediction; by different members all succeed", async () => {
    const { e, w } = await world([1, 2, 3]);
    const same = await e.newMember("same");
    const racers = await Promise.allSettled([
      submitAs(e, w, same, answersFor(w, 3, ALL)),
      submitAs(e, w, same, answersFor(w, 1, ALL)),
      submitAs(e, w, same, answersFor(w, 2, ALL)),
    ]);
    expect(racers.every((r) => r.status === "fulfilled")).toBe(true);
    const rowsForMember = await withDb((c) => c.query("select attempted_level from predictions where match_id = $1 and gaming_member_id = $2", [w.matchId, same]));
    expect(rowsForMember.rows).toHaveLength(1);
    expect([1, 2, 3]).toContain(rowsForMember.rows[0].attempted_level);

    const members = await Promise.all(Array.from({ length: 6 }, (_, i) => e.newMember(`p${i}`)));
    const many = await Promise.allSettled(members.map((m, i) => submitAs(e, w, m, answersFor(w, (i % 3) + 1, ALL))));
    expect(many.every((r) => r.status === "fulfilled")).toBe(true);
  }, 120000);
});

// ---------------------------------------------------------------------
// F-1: an exact replay of the accepted request is not a new edit
// F-2: the historical write path never creates or edits a progressive prediction
// ---------------------------------------------------------------------

/**
 * What the table holds for one member's prediction. xmin changes whenever the row is rewritten (even to the same values), so equal
 * states before and after prove that nothing was written, which equal timestamps alone could not.
 */
async function rowState(matchId: string, memberId: string) {
  return withDb(async (client) =>
    (
      await client.query(
        `select xmin::text as xmin, prediction_id, created_at, updated_at, geo_verified_at, measured_distance_meters,
                reported_accuracy_meters, geo_eligible, attempted_level, predicted_home_score, predicted_away_score
           from predictions where match_id = $1 and gaming_member_id = $2`,
        [matchId, memberId]
      )
    ).rows
  );
}

const pause = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms));
const FAR = { latitude: 40, longitude: 40, accuracyMeters: 5 };

describe("an exact replay of the accepted request returns the confirmed row and writes nothing", () => {
  async function accepted(levels = [1, 2, 3, 4], level = 2) {
    const { e, w } = await world(levels);
    const member = await e.newMember("m");
    const answers = answersFor(w, level, ALL);
    const first = await submitAs(e, w, member, answers);
    const before = await rowState(w.matchId, member);
    await pause(); // a rewritten row could not carry the same timestamp by chance
    return { e, w, member, answers, first, before };
  }

  it("returns the stored row exactly — same identity, timestamps and geolocation evidence — and the row is not rewritten, even when the repeat carries another position and accuracy", async () => {
    const { e, w, member, answers, first, before } = await accepted();
    const repeat = await submitAs(e, w, member, answers, { geo: { latitude: 10.0002, longitude: 10.0003, accuracyMeters: 41 } });
    expect(repeat).toEqual(first);
    expect(await rowState(w.matchId, member)).toEqual(before); // including xmin: the tuple was not rewritten
    expect(before).toHaveLength(1);
    expect(Number(before[0].reported_accuracy_meters)).toBe(5); // the evidence of the first acceptance, not of the repeat
  }, 60000);

  const closers: Array<[string, (c: Awaited<ReturnType<typeof accepted>>) => Promise<void>, new (...args: any[]) => Error]> = [
    ["kickoff has passed", async (c) => { expect((await admin.from("matches").update({ kickoff_at: new Date(Date.now() - 1000).toISOString() }).eq("match_id", c.w.matchId)).error).toBeNull(); }, KickoffPassedError],
    ["the activation is closed", async (c) => { await repo.setVenueActivationEnabled(c.w.activationId, false); }, VenueActivationDisabledError],
    ["the match is cancelled", async (c) => { await repo.cancelMatch(c.w.matchId); }, MatchCancelledError],
    ["a result is finalized and the kickoff is moved later", async (c) => {
      await settle(c.e, c.w, "TWO_ONE");
      expect((await admin.from("matches").update({ kickoff_at: new Date(Date.now() + 86_400_000).toISOString() }).eq("match_id", c.w.matchId)).error).toBeNull();
    }, ResultAlreadyFinalizedError],
  ];
  it.each(closers)("after %s: the repeat returns the confirmed row; a changed request is refused; nothing is rewritten", async (_label, close, refusal) => {
    const c = await accepted();
    await close(c);
    const stateAfterClosing = await rowState(c.w.matchId, c.member);
    expect(await submitAs(c.e, c.w, c.member, c.answers)).toEqual(c.first);
    await expect(submitAs(c.e, c.w, c.member, answersFor(c.w, 3, ALL))).rejects.toBeInstanceOf(refusal);
    await expect(submitAs(c.e, c.w, c.member, { ...c.answers, scoreline: { home: 9, away: 9 } })).rejects.toBeInstanceOf(refusal);
    expect(await rowState(c.w.matchId, c.member)).toEqual(stateAfterClosing);
    expect(await repo.getPredictionForMember(c.w.matchId, c.member)).toEqual(c.first);
    if (refusal === ResultAlreadyFinalizedError) expect((await repo.getCurrentEvaluationForPrediction(c.first.predictionId))!.attemptedLevel).toBe(2);
  }, 120000);

  it("does not depend on where the repeat is sent from: outside the radius it returns the confirmed row, while a changed request from there and a first request from there are refused and create nothing", async () => {
    const { e, w, member, answers, first, before } = await accepted();
    expect(await submitAs(e, w, member, answers, { geo: FAR })).toEqual(first);
    await expect(submitAs(e, w, member, answersFor(w, 3, ALL), { geo: FAR })).rejects.toBeInstanceOf(GeoNotEligibleError);
    const stranger = await e.newMember("outside");
    await expect(submitAs(e, w, stranger, answers, { geo: FAR })).rejects.toBeInstanceOf(GeoNotEligibleError);
    expect(await rowState(w.matchId, stranger)).toEqual([]);
    expect(await rowState(w.matchId, member)).toEqual(before);
  }, 60000);

  it("at the function itself, with the pre-computed evidence saying 'not eligible' and the match past kickoff: the replay is returned, an edit is refused — and a probe changes nothing", async () => {
    const { w, member, first } = await accepted();
    const digest = first.acceptedOfferDigest!;
    const call = (home: number) => `select prediction_id::text, updated_at::text, geo_verified_at::text, reported_accuracy_meters::text
        from upsert_progressive_prediction_atomically($1::uuid, $2::uuid, $3::uuid, 2, ${home}, 1, 'PICKED', 'HOME', 'NOT_ATTEMPTED', null, 'NOT_ATTEMPTED', null, null, $4, now(), 99999, 77, false)`;
    const outcome = await withDb(async (client) => {
      await client.query("begin");
      try {
        await client.query("update matches set kickoff_at = now() - interval '1 minute' where match_id = $1", [w.matchId]);
        const replay = await client.query(call(2), [w.matchId, member, w.activationId, digest]);
        await client.query("savepoint edit");
        let editMessage = "";
        try { await client.query(call(3), [w.matchId, member, w.activationId, digest]); } catch (error) { editMessage = (error as Error).message; }
        await client.query("rollback to savepoint edit");
        return { replay: replay.rows, editMessage };
      } finally {
        await client.query("rollback");
      }
    });
    expect(outcome.replay).toHaveLength(1);
    expect(outcome.replay[0].prediction_id).toBe(first.predictionId);
    expect(outcome.replay[0].updated_at).not.toBeNull();
    expect(Number(outcome.replay[0].reported_accuracy_meters)).toBe(5); // not the 77 the repeat carried
    expect(outcome.editMessage).toMatch(/KICKOFF_PASSED/);
  }, 60000);

  describe("what makes a request a different one", () => {
    const variations: Array<[string, (w: LadderWorld) => unknown]> = [
      ["the home score", (w) => ({ ...answersFor(w, 4, ALL), scoreline: { home: 3, away: 1 } })],
      ["the away score", (w) => ({ ...answersFor(w, 4, ALL), scoreline: { home: 2, away: 2 } })],
      ["the first team", (w) => ({ ...answersFor(w, 4, ALL), firstTeam: { kind: "PICKED", team: "AWAY" } })],
      ["the goalscorer", (w) => ({ ...answersFor(w, 4, ALL), goalscorer: { kind: "PICKED", playerId: w.players.lewa } })],
      ["the goal minute", (w) => ({ ...answersFor(w, 4, ALL), goalMinute: { kind: "PICKED", regulation: 31, stoppage: null } })],
      ["added time on a boundary minute", (w) => ({ ...answersFor(w, 4, ALL), goalMinute: { kind: "PICKED", regulation: 45, stoppage: 2 } })],
      // A NONE can only accompany a 0-0 scoreline now, so the "turned into none" variations are one: the whole prediction turned into 0-0 and none.
      ["the whole prediction turned into 0-0 with none for team, player and minute", () => ({ attemptedLevel: 4, scoreline: { home: 0, away: 0 }, firstTeam: { kind: "NONE" }, goalscorer: { kind: "NONE" }, goalMinute: { kind: "NONE" } })],
      ["the level, reduced", (w) => answersFor(w, 3, ALL)],
    ];

    it("each of these is a new edit: accepted before kickoff, rewriting the row, never returned as a replay", async () => {
      const { e, w } = await world([1, 2, 3, 4]);
      for (const [label, build] of variations) {
        const member = await e.newMember("v");
        const first = await submitAs(e, w, member, answersFor(w, 4, ALL));
        const before = await rowState(w.matchId, member);
        await pause();
        const edited = await submitAs(e, w, member, build(w));
        expect(edited.predictionId, label).toBe(first.predictionId);
        expect(edited.updatedAt, label).not.toBe(first.updatedAt);
        expect(await rowState(w.matchId, member), label).not.toEqual(before);
        expect(await repo.getPredictionForMember(w.matchId, member), label).toEqual(edited);
      }
    }, 240000);

    it("a different venue, a different fingerprint and a missing fingerprint are each refused, never answered with the stored row", async () => {
      const { e, w, member, answers, first, before } = await accepted();
      const venue2 = await repo.createVenue({ name: `Second ${randomUUID().slice(0, 6)}`, latitude: 10, longitude: 10, radiusMeters: 100 });
      createdVenueIds.push(venue2.venueId);
      const activation2 = await repo.createVenueActivation({ matchId: w.matchId, venueId: venue2.venueId });
      for (const level of [1, 2]) await repo.createLadderPrizeTier({ venueActivationId: activation2.venueActivationId, ladderLevel: level, prizeLabel: `Prize L${level}` });
      const digest2 = computeLadderOffer(await repo.listPrizeTiersForActivation(activation2.venueActivationId)).digest!;
      await expect(submitAs(e, w, member, answers, { activationId: activation2.venueActivationId, offerDigest: digest2 })).rejects.toBeInstanceOf(VenueActivationImmutableError);
      await expect(submitAs(e, w, member, answers, { offerDigest: "0".repeat(64) })).rejects.toBeInstanceOf(OfferChangedError);
      await expect(submitAs(e, w, member, answers, { offerDigest: null })).rejects.toBeInstanceOf(OfferDigestRequiredError);
      expect(await rowState(w.matchId, member)).toEqual(before);
      expect(await repo.getPredictionForMember(w.matchId, member)).toEqual(first);
    }, 60000);

    it("a malformed request is never answered with the stored row, even when its useful part is the same", async () => {
      const { e, w, member, answers, before } = await accepted();
      await expect(submitAs(e, w, member, { ...(answers as object), extra: true })).rejects.toBeInstanceOf(InvalidAttemptShapeError);
      await expect(submitAs(e, w, member, { ...(answers as object), goalscorer: { kind: "NONE" } })).rejects.toBeInstanceOf(InvalidAttemptShapeError);
      expect(await rowState(w.matchId, member)).toEqual(before);
    }, 60000);

    it("is a guarantee about the request currently accepted, not an idempotency key: an older request sent late is a new edit before kickoff and refused after it", async () => {
      const { e, w, member, answers: second } = await accepted([1, 2, 3, 4], 2);
      const older = answersFor(w, 1, ALL);
      const reverted = await submitAs(e, w, member, older);
      expect(reverted.attemptedLevel).toBe(1);
      expect((await admin.from("matches").update({ kickoff_at: new Date(Date.now() - 1000).toISOString() }).eq("match_id", w.matchId)).error).toBeNull();
      await expect(submitAs(e, w, member, second)).rejects.toBeInstanceOf(KickoffPassedError);
      expect(await submitAs(e, w, member, older)).toEqual(reverted);
    }, 60000);
  });

  describe("concurrency from independent clients", () => {
    it("six identical first requests at once leave one row written once: one prediction, created and last updated at the same instant", async () => {
      const { e, w } = await world([1, 2, 3]);
      const member = await e.newMember("racer");
      const answers = answersFor(w, 3, ALL);
      const results = await Promise.allSettled(Array.from({ length: 6 }, () => submitAs(e, w, member, answers)));
      expect(results.every((r) => r.status === "fulfilled"), JSON.stringify(results.filter((r) => r.status === "rejected"))).toBe(true);
      const rows = await rowState(w.matchId, member);
      expect(rows).toHaveLength(1);
      expect(new Set(results.map((r) => (r as PromiseFulfilledResult<{ predictionId: string }>).value.predictionId)).size).toBe(1);
      expect(rows[0].updated_at.getTime()).toBe(rows[0].created_at.getTime()); // no repeat rewrote the row
    }, 120000);

    it("six repeats of an accepted request at once rewrite nothing", async () => {
      const { e, w, member, answers, first, before } = await accepted();
      const results = await Promise.allSettled(Array.from({ length: 6 }, () => submitAs(e, w, member, answers)));
      expect(results.every((r) => r.status === "fulfilled")).toBe(true);
      for (const r of results) expect((r as PromiseFulfilledResult<unknown>).value).toEqual(first);
      expect(await rowState(w.matchId, member)).toEqual(before);
    }, 120000);

    it("a repeat racing the finalization of the result never changes the row, whichever lands first", async () => {
      const { e, w, member, answers, first, before } = await accepted();
      const results = await Promise.allSettled([submitAs(e, w, member, answers), settle(e, w, "TWO_ONE"), submitAs(e, w, member, answers)]);
      expect(results.every((r) => r.status === "fulfilled"), JSON.stringify(results.filter((r) => r.status === "rejected"))).toBe(true);
      expect(await rowState(w.matchId, member)).toEqual(before);
      expect(await repo.getPredictionForMember(w.matchId, member)).toEqual(first);
      expect((await repo.getCurrentEvaluationForPrediction(first.predictionId))!.attemptedLevel).toBe(2);
    }, 120000);
  });
});

describe("the historical write path never creates or edits a progressive prediction", () => {
  const historical = (w: LadderWorld, member: string, over: Record<string, unknown> = {}) =>
    submitPrediction(repo, {
      matchId: w.matchId, gamingMemberId: member, venueActivationId: w.activationId,
      predictedHomeScore: 2, predictedAwayScore: 1, predictedGoalscorerPlayerId: null,
      predictedGoalMinuteRegulation: null, predictedGoalMinuteStoppage: null, predictedFirstTeamToScore: null, geo: NEAR,
      ...over,
    });
  const functionCall = `select prediction_id from upsert_prediction_atomically($1::uuid, $2::uuid, $3::uuid, $4::int, 1, null, null, null, null, now(), 1, 1, true)`;

  it("refuses to create one and to edit one — including the edit that changes only the scoreline, which the table's own checks cannot see — through the application and at the function", async () => {
    const { e, w } = await world([1, 2]);
    const member = await e.newMember("m");
    const stranger = await e.newMember("s");
    await expect(historical(w, stranger)).rejects.toBeInstanceOf(ContractMismatchError);
    expectRejected(await probe(functionCall, [w.matchId, stranger, w.activationId, 2]), /CONTRACT_MISMATCH/, "create at the function");
    expect(await rowState(w.matchId, stranger)).toEqual([]);

    const stored = await submitAs(e, w, member, { attemptedLevel: 2, scoreline: { home: 2, away: 1 }, firstTeam: { kind: "PICKED", team: "HOME" } });
    const before = await rowState(w.matchId, member);
    await expect(historical(w, member, { predictedHomeScore: 5 })).rejects.toBeInstanceOf(ContractMismatchError);
    await expect(historical(w, member)).rejects.toBeInstanceOf(ContractMismatchError);
    expectRejected(await probe(functionCall, [w.matchId, member, w.activationId, 5]), /CONTRACT_MISMATCH/, "scoreline-only edit at the function");
    expect(await rowState(w.matchId, member)).toEqual(before);
    expect(await repo.getPredictionForMember(w.matchId, member)).toEqual(stored);
  }, 120000);

  it("says so before anything else: past kickoff, with the activation closed and with 'not eligible' evidence, the answer is still the contract", async () => {
    const { e, w } = await world([1]);
    const member = await e.newMember("m");
    await submitAs(e, w, member, answersFor(w, 1, ALL));
    expect((await admin.from("matches").update({ kickoff_at: new Date(Date.now() - 1000).toISOString() }).eq("match_id", w.matchId)).error).toBeNull();
    await repo.setVenueActivationEnabled(w.activationId, false);
    await expect(historical(w, member, { geo: FAR })).rejects.toBeInstanceOf(ContractMismatchError);
    expectRejected(await probe(`select prediction_id from upsert_prediction_atomically($1::uuid, $2::uuid, $3::uuid, 2, 1, null, null, null, null, now(), 1, 1, false)`, [w.matchId, member, w.activationId]), /CONTRACT_MISMATCH/, "ordering at the function");
  }, 120000);

  it("still writes the historical contract exactly as before: a historical match takes and edits a historical prediction", async () => {
    const { e, w } = await world([1]);
    const home = await repo.createTeam({ name: `H ${randomUUID().slice(0, 6)}` });
    const away = await repo.createTeam({ name: `A ${randomUUID().slice(0, 6)}` });
    createdTeamIds.push(home.teamId, away.teamId);
    const legacy = await repo.createMatch({ homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Old", kickoffAt: new Date(Date.now() + 3600_000).toISOString() });
    createdMatchIds.push(legacy.matchId);
    await repo.setMatchActivityClassification(legacy.matchId, "TRAINING", e.finalizerId, null);
    const activation = await repo.createVenueActivation({ matchId: legacy.matchId, venueId: w.venueId });
    const member = await e.newMember("legacy");
    const call = (home_: number) =>
      submitPrediction(repo, {
        matchId: legacy.matchId, gamingMemberId: member, venueActivationId: activation.venueActivationId,
        predictedHomeScore: home_, predictedAwayScore: 0, predictedGoalscorerPlayerId: null, predictedGoalMinuteRegulation: null,
        predictedGoalMinuteStoppage: null, predictedFirstTeamToScore: null, geo: NEAR,
      });
    const created = await call(1);
    const edited = await call(4);
    expect(edited.predictionId).toBe(created.predictionId);
    expect(edited.predictedHomeScore).toBe(4);
    expect(edited.predictionContract).toBe("COMPLETE_COUNT_V1");
  }, 120000);
});

// ---------------------------------------------------------------------
// Privileges: every new or replaced function is server-only
// ---------------------------------------------------------------------

describe("every new or replaced function stays server-only", () => {
  const CALLABLE = [
    "upsert_prediction_atomically",
    "upsert_progressive_prediction_atomically",
    "progressive_offer_max_level",
    "progressive_offer_digest",
    "prediction_prize_ladder_level",
    "finalize_match_result_atomically",
    "correct_match_result_atomically",
  ];
  const TRIGGER_FUNCTIONS = ["matches_contract_freeze", "predictions_guard", "prize_tiers_offer_guard"];

  it("has exactly the intended signatures, executable by service_role and by no client role (including PUBLIC)", async () => {
    const functions = await withDb(async (client) => {
      const { rows } = await client.query(
        `select p.proname, p.oid::regprocedure::text as signature,
                has_function_privilege('anon', p.oid, 'execute') as anon_exec,
                has_function_privilege('authenticated', p.oid, 'execute') as auth_exec,
                has_function_privilege('service_role', p.oid, 'execute') as service_exec,
                exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a where a.grantee = 0) as public_exec,
                p.prosecdef as security_definer
           from pg_proc p
          where p.pronamespace = 'public'::regnamespace and p.proname = any($1::text[])
          order by 1, 2`,
        [[...CALLABLE, ...TRIGGER_FUNCTIONS]]
      );
      return rows;
    });
    expect(functions.map((f) => f.signature)).toEqual([
      "correct_match_result_atomically(uuid,uuid,text,text)",
      "finalize_match_result_atomically(uuid,uuid,text,text)",
      "matches_contract_freeze()",
      "prediction_prize_ladder_level(boolean,boolean,boolean,boolean)",
      "predictions_guard()",
      "prize_tiers_offer_guard()",
      "progressive_offer_digest(uuid)",
      "progressive_offer_max_level(uuid)",
      "upsert_prediction_atomically(uuid,uuid,uuid,integer,integer,uuid,integer,integer,text,timestamp with time zone,numeric,numeric,boolean)",
      "upsert_progressive_prediction_atomically(uuid,uuid,uuid,integer,integer,integer,text,text,text,uuid,text,integer,integer,text,timestamp with time zone,numeric,numeric,boolean)",
    ]);
    for (const f of functions) {
      expect(f, f.signature).toMatchObject({ anon_exec: false, auth_exec: false, public_exec: false, security_definer: false });
      if (CALLABLE.includes(f.proname)) expect(f.service_exec, f.signature).toBe(true);
    }
  });

  it("direct calls by the public key and by a signed-in member are refused for privilege, and change nothing", async () => {
    const { e, w } = await world([1, 2]);
    const password = `Pw-${randomUUID()}`;
    const memberAccount = await realMember("LadderClient", password);
    const anonClient = createClient(supabaseUrl as string, anonKey as string, authOptions);
    const signedIn = await anonClient.auth.signInWithPassword({ email: memberAccount.email, password });
    if (signedIn.error || !signedIn.data.session) throw signedIn.error ?? new Error("sign-in failed");
    const authed = createClient(supabaseUrl as string, anonKey as string, {
      ...authOptions,
      global: { headers: { Authorization: `Bearer ${signedIn.data.session.access_token}` } },
    });
    const digest = (await offerDigestOf(e, w))!;
    const args: Record<string, Record<string, unknown>> = {
      upsert_progressive_prediction_atomically: {
        p_match_id: w.matchId, p_gaming_member_id: memberAccount.gamingMemberId, p_venue_activation_id: w.activationId, p_attempted_level: 1,
        p_predicted_home_score: 9, p_predicted_away_score: 9, p_first_team_state: "NOT_ATTEMPTED", p_first_team: null,
        p_goalscorer_state: "NOT_ATTEMPTED", p_goalscorer_player_id: null, p_goal_minute_state: "NOT_ATTEMPTED",
        p_goal_minute_regulation: null, p_goal_minute_stoppage: null, p_offer_digest: digest,
        p_geo_verified_at: new Date().toISOString(), p_measured_distance_meters: 1, p_reported_accuracy_meters: 1, p_geo_eligible: true,
      },
      upsert_prediction_atomically: {
        p_match_id: w.matchId, p_gaming_member_id: memberAccount.gamingMemberId, p_venue_activation_id: w.activationId,
        p_predicted_home_score: 9, p_predicted_away_score: 9, p_predicted_goalscorer_player_id: null,
        p_predicted_goal_minute_regulation: null, p_predicted_goal_minute_stoppage: null, p_predicted_first_team_to_score: null,
        p_geo_verified_at: new Date().toISOString(), p_measured_distance_meters: 1, p_reported_accuracy_meters: 1, p_geo_eligible: true,
      },
      progressive_offer_max_level: { p_venue_activation_id: w.activationId },
      progressive_offer_digest: { p_venue_activation_id: w.activationId },
      prediction_prize_ladder_level: { p_scoreline: true, p_first_team: true, p_goalscorer: true, p_goal_minute: true },
      finalize_match_result_atomically: { p_match_result_id: randomUUID(), p_finalized_by_gaming_member_id: e.finalizerId, p_reason: null, p_expected_digest: "x" },
      correct_match_result_atomically: { p_match_result_id: randomUUID(), p_finalized_by_gaming_member_id: e.finalizerId, p_reason: "client", p_expected_digest: "x" },
    };
    for (const [role, client] of [["anon", anonClient], ["authenticated", authed]] as const) {
      for (const name of CALLABLE) {
        const result = await client.rpc(name, args[name]);
        expect(result.error, `${role} ${name}: must be refused`).not.toBeNull();
        expect(result.error!.code, `${role} ${name}: ${result.error!.message}`).toBe("42501");
        expect(result.data ?? null, `${role} ${name}: returned data`).toBeNull();
      }
    }
    expect(await repo.getPredictionForMember(w.matchId, memberAccount.gamingMemberId)).toBeNull();
  }, 120000);

  it("the new columns are not reachable by client roles either", async () => {
    const anon = createClient(supabaseUrl as string, anonKey as string, authOptions);
    for (const table of ["matches", "predictions", "prize_tiers", "evaluations"]) {
      const result = await anon.from(table).select("*").limit(1);
      expect(result.error, table).not.toBeNull();
      expect(result.error!.code, table).toBe("42501");
    }
  });
});
