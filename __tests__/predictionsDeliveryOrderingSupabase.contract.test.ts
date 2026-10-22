import { randomUUID } from "node:crypto";

import { loadEnv } from "vite";
import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { Client } from "pg";
import { afterAll, describe, expect, it } from "vitest";

import { SupabasePredictionsRepository } from "../lib/gaming/predictions/db/supabasePredictionsRepository";
import { SupabaseGamingRepository } from "../lib/gaming/db/supabaseGamingRepository";
import { submitPrediction } from "../lib/gaming/predictions/submitPrediction";
import { currentSaveBase } from "./helpers/predictionsResultFixtures";
import { requireLocalSupabase } from "./helpers/requireLocalSupabase";
import { localSettlementDatabaseUrl, purgeSettlementEvidence } from "./helpers/localSettlementCleanup";
import {
  RESULT_SPECS,
  SCENARIOS,
  SCRAMBLED_SCENARIOS,
  runScenario,
  type ResultKey,
  type ScenarioWorld,
} from "./helpers/prizeDeliveryScenarios";

/**
 * Score Predictions — delivery ordering and legacy delivery evidence,
 * against real local Postgres (migrations 20261020150000 / 20261020150100).
 *
 * The same scenario table the in-memory suite runs
 * (predictionsDeliveryOrdering.test.ts) is run here through the real
 * functions, so the two implementations are held to identical rules and
 * identical expected rows — including with every timestamp rewritten (all
 * equal, and running backwards). On top of that: a transaction that began
 * earlier but took its lock later, the catalog, and the guard against
 * writing an entitlement whose lineage or fulfilling delivery is wrong.
 *
 * Legacy rows are built the way the data migration leaves them (delivery
 * evidence observed at migration, no lineage position) by rewriting a row
 * under session_replication_role = replica; every CHECK constraint still
 * applies, only the evidence triggers are bypassed — as they did not exist
 * when the legacy rows were written.
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

async function realMember(displayName: string) {
  const email = `ordering-contract-${randomUUID()}@example.com`;
  const { data, error } = await admin.auth.admin.createUser({ email, email_confirm: true });
  if (error || !data.user) throw error ?? new Error("Failed to create test auth user.");
  createdAuthUserIds.push(data.user.id);
  const member = await gamingRepo.createGamingMember(data.user.id, displayName);
  createdGamingMemberIds.push(member.gamingMemberId);
  return { authUserId: data.user.id, gamingMemberId: member.gamingMemberId };
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

async function withClient<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const client = await openClient();
  try {
    return await run(client);
  } finally {
    await client.end();
  }
}

type World = Awaited<ReturnType<typeof world>>;

/** Two teams, one match with an activation and prizes {4: Jersey, 2: Cap}, and Ana's prediction (1-0, Mbappe 20', home first). */
async function world() {
  const finalizer = await realMember("OrderingFinalizer");
  await grant(finalizer.gamingMemberId, "CONSEQUENTIAL_FINALIZER");
  const operator = await realMember("OrderingOperator");
  await grant(operator.gamingMemberId, "OPERATIONAL");
  const ana = await realMember("OrderingAna");

  const home = await repo.createTeam({ name: `Madrid ${randomUUID().slice(0, 8)}` });
  const away = await repo.createTeam({ name: `Barca ${randomUUID().slice(0, 8)}` });
  createdTeamIds.push(home.teamId, away.teamId);
  const players = {
    mbappe: await repo.createPlayer({ teamId: home.teamId, name: "Mbappe" }),
    vini: await repo.createPlayer({ teamId: home.teamId, name: "Vini" }),
    lewa: await repo.createPlayer({ teamId: away.teamId, name: "Lewandowski" }),
    pedri: await repo.createPlayer({ teamId: away.teamId, name: "Pedri" }),
  };

  const match = await repo.createMatch({ homeTeamId: home.teamId, awayTeamId: away.teamId, competition: "Ordering Contract", kickoffAt: new Date(Date.now() + 3600_000).toISOString() });
  createdMatchIds.push(match.matchId);
  await repo.setMatchActivityClassification(match.matchId, "TRAINING", finalizer.gamingMemberId, null);
  const venue = await repo.createVenue({ name: "Ordering Venue", latitude: 10, longitude: 10, radiusMeters: 100 });
  createdVenueIds.push(venue.venueId);
  const activation = await repo.createVenueActivation({ matchId: match.matchId, venueId: venue.venueId });
  const jersey = await repo.createPrizeTier({ venueActivationId: activation.venueActivationId, correctDimensionCount: 4, prizeLabel: "Jersey" });
  const cap = await repo.createPrizeTier({ venueActivationId: activation.venueActivationId, correctDimensionCount: 2, prizeLabel: "Cap" });

  await submitPrediction(repo, {
    matchId: match.matchId, gamingMemberId: ana.gamingMemberId, venueActivationId: activation.venueActivationId,
    predictedHomeScore: 1, predictedAwayScore: 0, predictedGoalscorerPlayerId: players.mbappe.playerId,
    predictedGoalMinuteRegulation: 20, predictedGoalMinuteStoppage: null, predictedFirstTeamToScore: "HOME",
    geo: { latitude: 10.0001, longitude: 10.0001, accuracyMeters: 5 },
  });

  return { finalizer, operator, ana, players, match, activation, jersey, cap };
}

async function settleResult(w: World, key: ResultKey, reason = "Official match sheet") {
  const spec = RESULT_SPECS[key];
  const saved = await repo.saveDraftMatchResult({
    matchId: w.match.matchId, homeScore: spec.home, awayScore: spec.away,
    officialGoalEvents: spec.events.map((e) => ({ scorerPlayerId: w.players[e.scorer].playerId, minuteRegulation: e.minute })),
    enteredByGamingMemberId: w.operator.gamingMemberId,
    saveBase: await currentSaveBase(repo, w.match.matchId),
  });
  if (saved.isCorrection) {
    await repo.correctMatchResult(saved.matchResultId, w.finalizer.gamingMemberId, reason, saved.contentDigest);
  } else {
    await repo.finalizeMatchResult(saved.matchResultId, w.finalizer.gamingMemberId, null, saved.contentDigest);
  }
  return saved;
}

async function anaRows(w: World) {
  const all = await repo.listQualificationsForActivation(w.activation.venueActivationId);
  return all
    .filter((q) => q.gamingMemberId === w.ana.gamingMemberId)
    .sort((a, b) => (a.lineageOrdinal ?? 1000) - (b.lineageOrdinal ?? 1000));
}

async function activeRow(w: World) {
  const active = (await anaRows(w)).filter((q) => q.supersededAt === null);
  expect(active.length).toBeLessThanOrEqual(1);
  return active[0] ?? null;
}

/** Runs SQL with the evidence triggers bypassed, as the data migration's own statements ran before they existed. */
async function asMigration<T>(run: (client: Client) => Promise<T>): Promise<T> {
  const client = await openClient();
  try {
    await client.query("begin");
    await client.query("set local session_replication_role = replica");
    const out = await run(client);
    await client.query("commit");
    return out;
  } finally {
    await client.query("rollback").catch(() => undefined);
    await client.end();
  }
}

function scenarioWorld(w: World): ScenarioWorld {
  return {
    repo,
    memberId: w.ana.gamingMemberId,
    activationId: w.activation.venueActivationId,
    finalizerId: w.finalizer.gamingMemberId,
    tierIdByCount: { 4: w.jersey.prizeTierId, 2: w.cap.prizeTierId },
    async settle(key) {
      await settleResult(w, key);
    },
    async editPrizeLabel(tier, label) {
      const { error } = await admin.from("prize_tiers").update({ prize_label: label }).eq("prize_tier_id", tier === 4 ? w.jersey.prizeTierId : w.cap.prizeTierId);
      if (error) throw error;
    },
    async moveLineage(prizeQualificationId, to) {
      await asMigration((client) => client.query("update prize_qualifications set lineage_ordinal = $2 where prize_qualification_id = $1", [prizeQualificationId, to]));
    },
    async restateAsMigratedLegacy(prizeQualificationId, patch) {
      await asMigration((client) =>
        client.query(
          `update prize_qualifications
              set redeemed_prize_label = null,
                  redeemed_prize_label_basis = $2,
                  legacy_observed_prize_label = $3,
                  lineage_ordinal = case when $4::boolean then null else lineage_ordinal end
            where prize_qualification_id = $1`,
          [prizeQualificationId, patch.basis, patch.observedLabel, patch.dropLineage === true]
        )
      );
    },
    async scrambleTimestamps(mode) {
      // Rewrites the timestamps of the entitlements, the results and the evaluations of this match. The ranking used to spread the
      // "reversed" values is the test's own bookkeeping; nothing under test reads it.
      await asMigration(async (client) => {
        const base = "2026-10-25T12:00:00.000Z";
        const step = mode === "equal" ? "0 hours" : "1 hour";
        await client.query(
          `with ranked as (
             select prize_qualification_id, row_number() over (order by coalesce(lineage_ordinal, 1000), prize_qualification_id) as k
               from prize_qualifications where gaming_member_id = $1 and venue_activation_id = $2)
           update prize_qualifications pq
              set created_at = $3::timestamptz - ranked.k * $4::interval,
                  redeemed_at = case when pq.redeemed_at is null then null else $3::timestamptz - ranked.k * $4::interval end,
                  superseded_at = case when pq.superseded_at is null then null else $3::timestamptz - ranked.k * $4::interval end,
                  held_at = case when pq.held_at is null then null else $3::timestamptz - ranked.k * $4::interval end,
                  released_at = case when pq.released_at is null then null else $3::timestamptz - ranked.k * $4::interval end
             from ranked where ranked.prize_qualification_id = pq.prize_qualification_id`,
          [w.ana.gamingMemberId, w.activation.venueActivationId, base, step]
        );
        await client.query(
          `with ranked as (
             select match_result_id, match_result_lineage_ordinal(match_result_id) as k from match_results where match_id = $1)
           update match_results mr
              set created_at = $2::timestamptz - ranked.k * $3::interval,
                  finalized_at = case when mr.finalized_at is null then null else $2::timestamptz - ranked.k * $3::interval end
             from ranked where ranked.match_result_id = mr.match_result_id`,
          [w.match.matchId, base, step]
        );
        await client.query(
          `update evaluations e
              set evaluated_at = $2::timestamptz - match_result_lineage_ordinal(e.match_result_id) * $3::interval
            where e.match_result_id in (select match_result_id from match_results where match_id = $1)`,
          [w.match.matchId, base, step]
        );
      });
    },
  };
}

// ---------------------------------------------------------------------
// The shared scenario table, on the real database
// ---------------------------------------------------------------------

describe("Delivery ordering and legacy evidence — scenario table (database)", () => {
  for (const scenario of SCENARIOS) {
    it(scenario.name, async () => {
      const w = await world();
      expect(await runScenario(scenarioWorld(w), scenario)).toEqual(scenario.expected);
    }, 120000);
  }
});

describe("Delivery ordering never depends on timestamps — every timestamp rewritten (database)", () => {
  for (const scenario of SCRAMBLED_SCENARIOS) {
    it(scenario.name, async () => {
      const w = await world();
      expect(await runScenario(scenarioWorld(w), scenario)).toEqual(scenario.expected);
    }, 120000);
  }
});

// ---------------------------------------------------------------------
// Transactions that begin in one order and lock in another
// ---------------------------------------------------------------------

describe("Transaction start time is not delivery order (database)", () => {
  it("a redemption whose transaction BEGAN before an earlier delivery still counts as the later delivery", async () => {
    const w = await world();
    await settleResult(w, "A");
    const r0 = (await activeRow(w))!;

    // A transaction begins now; its now() is fixed here.
    const stale = await openClient();
    await stale.query("begin");
    const began = (await stale.query("select now() as t")).rows[0].t as Date;
    await new Promise((resolve) => setTimeout(resolve, 60));

    // Meanwhile the first delivery happens, then a correction holds Cap, which is released.
    await repo.redeemPrizeQualification(r0.prizeQualificationId, w.finalizer.gamingMemberId, null);
    await settleResult(w, "B");
    const r1 = (await activeRow(w))!;
    expect(r1.holdBasis).toBe("DELIVERED_PRIZE_CHANGED");
    await repo.releasePrizeQualificationHold(r1.prizeQualificationId, w.finalizer.gamingMemberId, "Founder approved the Cap");

    // The early-begun transaction now performs the second delivery (it is the one that takes the row lock last).
    await stale.query("select * from redeem_prize_qualification_atomically($1, $2, null)", [r1.prizeQualificationId, w.finalizer.gamingMemberId]);
    await stale.query("commit");
    await stale.end();

    const [first, second] = await anaRows(w);
    expect(new Date(second.redeemedAt!).getTime()).toBe(began.getTime());
    // The trap: the LATER delivery carries the EARLIER timestamp.
    expect(new Date(second.redeemedAt!).getTime()).toBeLessThan(new Date(first.redeemedAt!).getTime());
    expect(second.redeemedPrizeLabel).toBe("Cap");

    // Jersey again: judged against the latest delivery in the chain (Cap, r1) — not against the row with the latest timestamp (Jersey, r0).
    await settleResult(w, "A");
    const current = (await activeRow(w))!;
    expect(current).toMatchObject({ holdBasis: "DELIVERED_PRIZE_CHANGED", holdPriorPrizeQualificationId: r1.prizeQualificationId, fulfilledByPrizeQualificationId: null });
    expect(current.holdReason).toContain('Delivered: "Cap" (2 of 4 correct)');
  }, 120000);

  it("a delivery recorded by a transaction that began long BEFORE the entitlement even existed is still ordered by the chain", async () => {
    const w = await world();
    const stale = await openClient();
    await stale.query("begin");
    await stale.query("select now()");
    await new Promise((resolve) => setTimeout(resolve, 60));
    await settleResult(w, "A");
    const r0 = (await activeRow(w))!;
    await stale.query("select * from redeem_prize_qualification_atomically($1, $2, null)", [r0.prizeQualificationId, w.finalizer.gamingMemberId]);
    await stale.query("commit");
    await stale.end();

    const [delivered] = await anaRows(w);
    expect(new Date(delivered.redeemedAt!).getTime()).toBeLessThan(new Date(delivered.createdAt).getTime());
    await settleResult(w, "A");
    expect(await activeRow(w)).toMatchObject({ fulfilledByPrizeQualificationId: r0.prizeQualificationId, holdBasis: null });
  }, 120000);
});

// ---------------------------------------------------------------------
// Catalog and guard
// ---------------------------------------------------------------------

describe("Lineage and delivery-evidence structure (database)", () => {
  it("catalog: columns, uniqueness of (member, activation, lineage position), and the position function is service_role only", async () => {
    const client = await openClient();
    try {
      const { rows: columns } = await client.query(
        `select column_name from information_schema.columns
          where table_schema = 'public' and table_name = 'prize_qualifications'
            and column_name in ('lineage_ordinal','redeemed_prize_label_basis','legacy_observed_prize_label','hold_basis')`
      );
      expect(columns.map((c) => c.column_name).sort()).toEqual(["hold_basis", "legacy_observed_prize_label", "lineage_ordinal", "redeemed_prize_label_basis"]);

      const { rows: index } = await client.query(
        `select i.indisunique, pg_get_indexdef(i.indexrelid) as def
           from pg_index i join pg_class c on c.oid = i.indexrelid
          where c.relname = 'prize_qualifications_lineage_position_key'`
      );
      expect(index).toHaveLength(1);
      expect(index[0].indisunique).toBe(true);
      expect(index[0].def).toMatch(/gaming_member_id, venue_activation_id, lineage_ordinal/);

      const { rows: fn } = await client.query(
        `select p.oid::regprocedure::text as signature,
                has_function_privilege('anon', p.oid, 'execute') as anon_exec,
                has_function_privilege('authenticated', p.oid, 'execute') as auth_exec,
                has_function_privilege('service_role', p.oid, 'execute') as service_exec
           from pg_proc p where p.pronamespace = 'public'::regnamespace and p.proname = 'match_result_lineage_ordinal'`
      );
      expect(fn).toHaveLength(1);
      expect(fn[0]).toMatchObject({ anon_exec: false, auth_exec: false, service_exec: true });
    } finally {
      await client.end();
    }
  });

  it("the position of a result is its number of ancestors in the supersession chain, and a real anon client cannot ask", async () => {
    const w = await world();
    const first = await settleResult(w, "A");
    const second = await settleResult(w, "B");
    const third = await settleResult(w, "A");
    const positions = [];
    for (const saved of [first, second, third]) {
      const { data, error } = await admin.rpc("match_result_lineage_ordinal", { p_match_result_id: saved.matchResultId });
      expect(error).toBeNull();
      positions.push(data);
    }
    expect(positions).toEqual([0, 1, 2]);
    const anon = createClient(supabaseUrl, anonKey);
    const denied = await anon.rpc("match_result_lineage_ordinal", { p_match_result_id: first.matchResultId });
    expect(denied.error).not.toBeNull();
    expect(denied.error!.message).toMatch(/permission denied/i);
  }, 120000);

  it("the current evaluation is the one for the result at the highest chain position, even when its timestamp is the OLDEST", async () => {
    const w = await world();
    await settleResult(w, "A");
    await settleResult(w, "B");
    const last = await settleResult(w, "A");
    const prediction = (await repo.getPredictionForMember(w.match.matchId, w.ana.gamingMemberId))!;

    // Make the newest chain position the oldest in time, and the first the newest.
    await asMigration((client) =>
      client.query(
        `update evaluations e
            set evaluated_at = '2026-10-25T12:00:00Z'::timestamptz + match_result_lineage_ordinal(e.match_result_id) * interval '1 hour' * -1
          where e.prediction_id = $1`,
        [prediction.predictionId]
      )
    );
    const evaluations = await withClient((client) =>
      client.query(
        `select match_result_lineage_ordinal(match_result_id) as pos, evaluated_at from evaluations where prediction_id = $1 order by 1`,
        [prediction.predictionId]
      )
    );
    expect(evaluations.rows.map((r) => r.pos)).toEqual([0, 1, 2]);
    expect(new Date(evaluations.rows[2].evaluated_at).getTime()).toBeLessThan(new Date(evaluations.rows[0].evaluated_at).getTime());

    const current = await repo.getCurrentEvaluationForPrediction(prediction.predictionId);
    expect(current!.matchResultId).toBe(last.matchResultId);
    expect(current!.correctDimensionCount).toBe(4);
  }, 120000);

  it("every entitlement the functions write states the lineage position of its own result", async () => {
    const w = await world();
    await settleResult(w, "A");
    await repo.redeemPrizeQualification((await activeRow(w))!.prizeQualificationId, w.finalizer.gamingMemberId, null);
    await settleResult(w, "B");
    await settleResult(w, "C");
    await settleResult(w, "A");
    const { rows } = await (async () => {
      const client = await openClient();
      try {
        return await client.query(
          `select pq.lineage_ordinal, match_result_lineage_ordinal(e.match_result_id) as expected
             from prize_qualifications pq join evaluations e on e.evaluation_id = pq.evaluation_id
            where pq.gaming_member_id = $1 and pq.venue_activation_id = $2`,
          [w.ana.gamingMemberId, w.activation.venueActivationId]
        );
      } finally {
        await client.end();
      }
    })();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.lineage_ordinal).toBe(row.expected);
  }, 120000);

  it("the table guard refuses an entitlement written with the wrong lineage, or satisfied by a delivery that was not recorded at redemption", async () => {
    const w = await world();
    await settleResult(w, "A");
    const r0 = (await activeRow(w))!;
    await repo.redeemPrizeQualification(r0.prizeQualificationId, w.finalizer.gamingMemberId, null);
    await settleResult(w, "C"); // Ana qualifies for nothing: this result's evaluation has no entitlement row

    const evaluation = await (async () => {
      const client = await openClient();
      try {
        const { rows } = await client.query(
          `select e.evaluation_id from evaluations e
             join predictions p on p.prediction_id = e.prediction_id
            where p.gaming_member_id = $1 and p.match_id = $2 and match_result_lineage_ordinal(e.match_result_id) = 1`,
          [w.ana.gamingMemberId, w.match.matchId]
        );
        return rows[0].evaluation_id as string;
      } finally {
        await client.end();
      }
    })();
    const insert = (over: Record<string, unknown>) =>
      admin.from("prize_qualifications").insert({
        evaluation_id: evaluation, gaming_member_id: w.ana.gamingMemberId,
        venue_activation_id: w.activation.venueActivationId, prize_tier_id: w.jersey.prizeTierId, ...over,
      });

    const wrongLineage = await insert({ lineage_ordinal: 5 });
    expect(wrongLineage.error?.message).toContain("PRIZE_QUALIFICATION_IMMUTABLE");
    expect(wrongLineage.error?.message).toContain("lineage position");
    const noLineage = await insert({ lineage_ordinal: null });
    expect(noLineage.error?.message).toContain("PRIZE_QUALIFICATION_IMMUTABLE");

    // Make the delivery a legacy one, then try to satisfy a new entitlement with it.
    await asMigration((client) =>
      client.query(
        `update prize_qualifications set redeemed_prize_label = null, redeemed_prize_label_basis = 'OBSERVED_AT_MIGRATION',
                legacy_observed_prize_label = 'Jersey' where prize_qualification_id = $1`,
        [r0.prizeQualificationId]
      )
    );
    const satisfiedByLegacy = await insert({ lineage_ordinal: 1, fulfilled_by_prize_qualification_id: r0.prizeQualificationId });
    expect(satisfiedByLegacy.error?.message).toContain("recorded at redemption");

    // The legacy delivery's evidence cannot be rewritten into something stronger through an ordinary path.
    const upgrade = await admin.from("prize_qualifications")
      .update({ redeemed_prize_label_basis: "SNAPSHOT_AT_REDEMPTION", redeemed_prize_label: "Jersey", legacy_observed_prize_label: null })
      .eq("prize_qualification_id", r0.prizeQualificationId);
    expect(upgrade.error?.message).toContain("PRIZE_QUALIFICATION_IMMUTABLE");
    const rewriteObserved = await admin.from("prize_qualifications").update({ legacy_observed_prize_label: "Free car" }).eq("prize_qualification_id", r0.prizeQualificationId);
    expect(rewriteObserved.error?.message).toContain("PRIZE_QUALIFICATION_IMMUTABLE");
    const moveLineage = await admin.from("prize_qualifications").update({ lineage_ordinal: 9 }).eq("prize_qualification_id", r0.prizeQualificationId);
    expect(moveLineage.error?.message).toContain("PRIZE_QUALIFICATION_IMMUTABLE");
  }, 120000);

  it("a redemption must carry a snapshot and its basis; a held, superseded or satisfied row is refused for its own reason first", async () => {
    const w = await world();
    await settleResult(w, "A");
    const r0 = (await activeRow(w))!;
    const noBasis = await admin.from("prize_qualifications")
      .update({ redeemed_at: new Date().toISOString(), redeemed_by_gaming_member_id: w.finalizer.gamingMemberId, redeemed_prize_label: "Jersey" })
      .eq("prize_qualification_id", r0.prizeQualificationId);
    expect(noBasis.error?.message).toContain("PRIZE_QUALIFICATION_IMMUTABLE");
    expect(noBasis.error?.message).toContain("snapshot");
    const migrationBasis = await admin.from("prize_qualifications")
      .update({ redeemed_at: new Date().toISOString(), redeemed_by_gaming_member_id: w.finalizer.gamingMemberId, redeemed_prize_label: null, redeemed_prize_label_basis: "OBSERVED_AT_MIGRATION", legacy_observed_prize_label: "Jersey" })
      .eq("prize_qualification_id", r0.prizeQualificationId);
    expect(migrationBasis.error?.message).toContain("PRIZE_QUALIFICATION_IMMUTABLE");
    expect((await activeRow(w))!.redeemedAt).toBeNull();
  }, 60000);
});

// ---------------------------------------------------------------------
// CHECK constraints: UNKNOWN is not a pass
// ---------------------------------------------------------------------

/**
 * PostgreSQL accepts a CHECK whose expression is NULL as well as TRUE, so a
 * constraint over nullable columns can silently allow a forbidden state (a
 * redemption with no evidence basis, a hold with no basis). Every case below
 * rewrites the WHOLE delivery / hold / release state of one real row inside a
 * transaction with session_replication_role = replica (no trigger can mask
 * the constraint) and rolls it back.
 */
describe("prize_qualifications CHECK constraints refuse every forbidden state, UNKNOWN included (database)", () => {
  const NOW = "2026-10-25T10:00:00Z";
  const blank = {
    redeemed_at: null, redeemed_by_gaming_member_id: null, redeemed_prize_label: null, redeemed_prize_label_basis: null,
    legacy_observed_prize_label: null, held_at: null, hold_basis: null, hold_reason: null, hold_prior_prize_qualification_id: null,
    released_at: null, released_by_gaming_member_id: null, release_reason: null, fulfilled_by_prize_qualification_id: null,
  } as Record<string, unknown>;

  type Case = [name: string, state: (ids: { finalizer: string; other: string; self: string }) => Record<string, unknown>, accepted: boolean];
  const redeemed = (f: string) => ({ redeemed_at: NOW, redeemed_by_gaming_member_id: f });
  const held = (basis: string | null, extra: Record<string, unknown> = {}) => (i: { other: string }) =>
    ({ held_at: NOW, hold_basis: basis, hold_reason: "why", hold_prior_prize_qualification_id: i.other, ...extra });
  const cases: Case[] = [
    ["redeemed_at set, evidence basis missing (label and observed also missing)", (i) => ({ ...redeemed(i.finalizer) }), false],
    ["redeemed_at set, evidence basis missing, a snapshot-style label present", (i) => ({ ...redeemed(i.finalizer), redeemed_prize_label: "Jersey" }), false],
    ["redeemed_at set, evidence basis missing, an observed label present", (i) => ({ ...redeemed(i.finalizer), legacy_observed_prize_label: "Jersey" }), false],
    ["SNAPSHOT_AT_REDEMPTION without its label", (i) => ({ ...redeemed(i.finalizer), redeemed_prize_label_basis: "SNAPSHOT_AT_REDEMPTION" }), false],
    ["SNAPSHOT_AT_REDEMPTION that also claims an observed label", (i) => ({ ...redeemed(i.finalizer), redeemed_prize_label_basis: "SNAPSHOT_AT_REDEMPTION", redeemed_prize_label: "Jersey", legacy_observed_prize_label: "Jersey" }), false],
    ["OBSERVED_AT_MIGRATION without an observed label", (i) => ({ ...redeemed(i.finalizer), redeemed_prize_label_basis: "OBSERVED_AT_MIGRATION" }), false],
    ["OBSERVED_AT_MIGRATION that claims a snapshot label", (i) => ({ ...redeemed(i.finalizer), redeemed_prize_label_basis: "OBSERVED_AT_MIGRATION", redeemed_prize_label: "Jersey", legacy_observed_prize_label: "Jersey" }), false],
    ["UNKNOWN carrying a label", (i) => ({ ...redeemed(i.finalizer), redeemed_prize_label_basis: "UNKNOWN", legacy_observed_prize_label: "Jersey" }), false],
    ["an evidence basis with no redemption", () => ({ redeemed_prize_label_basis: "UNKNOWN" }), false],
    ["a snapshot label with no redemption", () => ({ redeemed_prize_label: "Jersey" }), false],
    ["an invalid evidence basis value", (i) => ({ ...redeemed(i.finalizer), redeemed_prize_label_basis: "GUESSED", redeemed_prize_label: "Jersey" }), false],
    ["a hold with no basis (reason present)", held(null), false],
    ["a hold with no reason", held("DELIVERED_PRIZE_CHANGED", { hold_reason: null }), false],
    ["a hold with a blank reason", held("DELIVERED_PRIZE_CHANGED", { hold_reason: "   " }), false],
    ["a hold with an invalid basis value", held("SOMETHING_ELSE"), false],
    ["a hold basis with no held_at", () => ({ hold_basis: "DELIVERED_PRIZE_CHANGED", hold_reason: "why" }), false],
    ["a hold reason with no held_at", () => ({ hold_reason: "why" }), false],
    ["a hold prior with no held_at", (i) => ({ hold_prior_prize_qualification_id: i.other }), false],
    ["a hold that needs a prior (DELIVERED_PRIZE_CHANGED) and has none", held("DELIVERED_PRIZE_CHANGED", { hold_prior_prize_qualification_id: null }), false],
    ["released_at with no hold", (i) => ({ released_at: NOW, released_by_gaming_member_id: i.finalizer, release_reason: "ok" }), false],
    ["a release with no releaser", (i) => ({ ...held("DELIVERED_PRIZE_CHANGED")(i), released_at: NOW, release_reason: "ok" }), false],
    ["a release with no reason", (i) => ({ ...held("DELIVERED_PRIZE_CHANGED")(i), released_at: NOW, released_by_gaming_member_id: i.finalizer }), false],
    ["a release with a blank reason", (i) => ({ ...held("DELIVERED_PRIZE_CHANGED")(i), released_at: NOW, released_by_gaming_member_id: i.finalizer, release_reason: " " }), false],
    ["a releaser recorded without released_at", (i) => ({ ...held("DELIVERED_PRIZE_CHANGED")(i), released_by_gaming_member_id: i.finalizer }), false],
    ["a release reason recorded without released_at", (i) => ({ ...held("DELIVERED_PRIZE_CHANGED")(i), release_reason: "ok" }), false],
    ["a satisfied row that is also held", (i) => ({ ...held("DELIVERED_PRIZE_CHANGED")(i), fulfilled_by_prize_qualification_id: i.other }), false],
    ["a satisfied row with its own redemption", (i) => ({ ...redeemed(i.finalizer), redeemed_prize_label_basis: "SNAPSHOT_AT_REDEMPTION", redeemed_prize_label: "Jersey", fulfilled_by_prize_qualification_id: i.other }), false],
    ["a satisfied row with a redeemer but no redeemed_at", (i) => ({ redeemed_by_gaming_member_id: i.finalizer, fulfilled_by_prize_qualification_id: i.other }), false],
    ["a negative lineage position", () => ({ lineage_ordinal: -1 }), false],
    ["a row satisfied by itself", (i) => ({ fulfilled_by_prize_qualification_id: i.self }), false],
    ["valid legacy UNKNOWN evidence", (i) => ({ ...redeemed(i.finalizer), redeemed_prize_label_basis: "UNKNOWN" }), true],
    ["valid snapshot-at-redemption evidence", (i) => ({ ...redeemed(i.finalizer), redeemed_prize_label_basis: "SNAPSHOT_AT_REDEMPTION", redeemed_prize_label: "Jersey" }), true],
    ["valid observed-at-migration evidence", (i) => ({ ...redeemed(i.finalizer), redeemed_prize_label_basis: "OBSERVED_AT_MIGRATION", legacy_observed_prize_label: "Jersey" }), true],
    ["a pending row with no delivery, hold or release state", () => ({}), true],
    ["a valid hold with a prior", held("DELIVERED_PRIZE_CHANGED"), true],
    ["a valid DELIVERY_ORDER_UNKNOWN hold with no prior", held("DELIVERY_ORDER_UNKNOWN", { hold_prior_prize_qualification_id: null }), true],
    ["a valid released hold", (i) => ({ ...held("DELIVERY_EQUIVALENCE_UNKNOWN")(i), released_at: NOW, released_by_gaming_member_id: i.finalizer, release_reason: "ok" }), true],
    ["a valid satisfied row", (i) => ({ fulfilled_by_prize_qualification_id: i.other }), true],
    ["a valid released hold that was then redeemed with a snapshot", (i) => ({ ...held("LEGACY_PENDING_TWIN")(i), released_at: NOW, released_by_gaming_member_id: i.finalizer, release_reason: "ok", ...redeemed(i.finalizer), redeemed_prize_label_basis: "SNAPSHOT_AT_REDEMPTION", redeemed_prize_label: "Jersey" }), true],
    ["an unordered legacy row (no lineage position)", () => ({ lineage_ordinal: null }), true],
  ];

  it("every forbidden state is refused by a constraint and every valid state is accepted", async () => {
    const w = await world();
    await settleResult(w, "A");
    await settleResult(w, "B");
    const [first, second] = await anaRows(w);
    const ids = { finalizer: w.finalizer.gamingMemberId, other: first.prizeQualificationId, self: second.prizeQualificationId };

    const outcomes = await withClient(async (client) => {
      await client.query("begin");
      try {
        await client.query("set local session_replication_role = replica");
        const results: Array<{ name: string; accepted: boolean; wanted: boolean; constraint: string }> = [];
        for (const [name, state, wanted] of cases) {
          const next = { ...blank, ...state(ids) };
          const keys = Object.keys(next);
          await client.query("savepoint probe");
          let accepted = true;
          let constraint = "";
          try {
            await client.query(
              `update prize_qualifications set ${keys.map((k, n) => `${k} = $${n + 2}`).join(", ")} where prize_qualification_id = $1`,
              [ids.self, ...keys.map((k) => next[k])]
            );
          } catch (error) {
            accepted = false;
            constraint = (error as { constraint?: string }).constraint ?? String((error as Error).message);
          }
          await client.query("rollback to savepoint probe");
          results.push({ name, accepted, wanted, constraint });
        }
        return results;
      } finally {
        await client.query("rollback");
      }
    });

    expect(outcomes).toHaveLength(cases.length);
    for (const outcome of outcomes) {
      expect(outcome.accepted, `${outcome.name}${outcome.accepted ? "" : ` (refused by ${outcome.constraint})`}`).toBe(outcome.wanted);
      // A refusal must come from a CHECK constraint, not from some unrelated key.
      if (!outcome.accepted) expect(outcome.constraint, outcome.name).toMatch(/^prize_qualifications_.*(shape|excludes_hold|no_own_redemption|no_self_link|non_negative)$/);
    }
  }, 120000);

  it("the transitional enforcement of migration 1 is gone once migration 2 is installed: only the evidence guard remains", async () => {
    const found = await withClient(async (client) => {
      const triggers = await client.query(`select tgname from pg_trigger where tgrelid = 'public.prize_qualifications'::regclass and not tgisinternal order by 1`);
      const functions = await client.query(
        `select proname from pg_proc where pronamespace = 'public'::regnamespace
          and proname in ('prize_qualifications_transitional_redeem_guard','prize_qualifications_transitional_insert_guard','prize_qualification_twin_hold')`
      );
      return { triggers: triggers.rows.map((r) => r.tgname), functions: functions.rows.map((r) => r.proname) };
    });
    expect(found.functions).toEqual([]);
    expect(found.triggers).toEqual(["prize_qualifications_evidence_guard", "prize_qualifications_no_truncate"]);
  });
});

// ---------------------------------------------------------------------
// Race: corrections, redemptions and releases still never see a half-state
// ---------------------------------------------------------------------

describe("Correction racing redemption keeps the chain order (database)", () => {
  it("a redemption racing a correction either lands before it (and is honoured by it) or finds the row superseded", async () => {
    const w = await world();
    await settleResult(w, "A");
    const failures: unknown[] = [];
    for (let round = 0; round < 4; round += 1) {
      const target = (await activeRow(w))!;
      const draft = await repo.saveDraftMatchResult({
        matchId: w.match.matchId,
        homeScore: RESULT_SPECS[round % 2 === 0 ? "B" : "A"].home,
        awayScore: RESULT_SPECS[round % 2 === 0 ? "B" : "A"].away,
        officialGoalEvents: RESULT_SPECS[round % 2 === 0 ? "B" : "A"].events.map((e) => ({ scorerPlayerId: w.players[e.scorer].playerId, minuteRegulation: e.minute })),
        enteredByGamingMemberId: w.operator.gamingMemberId,
        saveBase: await currentSaveBase(repo, w.match.matchId),
      });
      const outcomes = await Promise.allSettled([
        repo.correctMatchResult(draft.matchResultId, w.finalizer.gamingMemberId, `Round ${round}`, draft.contentDigest),
        repo.redeemPrizeQualification(target.prizeQualificationId, w.finalizer.gamingMemberId, null),
      ]);
      for (const outcome of outcomes) {
        if (outcome.status === "rejected") {
          const message = String((outcome.reason as Error)?.message ?? outcome.reason);
          if (/deadlock|could not serialize/i.test(message)) failures.push(outcome.reason);
        }
      }
    }
    expect(failures).toEqual([]);

    const rows = await anaRows(w);
    // Whatever interleaving happened, a delivered row is never also satisfied by another, and positions are unique.
    expect(rows.filter((r) => r.supersededAt === null)).toHaveLength(1);
    expect(new Set(rows.map((r) => r.lineageOrdinal)).size).toBe(rows.length);
    for (const row of rows.filter((r) => r.redeemedAt !== null)) {
      expect(row.fulfilledByPrizeQualificationId).toBeNull();
      expect(row.redeemedPrizeLabelBasis).toBe("SNAPSHOT_AT_REDEMPTION");
    }
    // The next correction judges against the latest delivery by lineage.
    const delivered = rows.filter((r) => r.redeemedAt !== null);
    if (delivered.length > 0) {
      const latest = delivered.reduce((a, b) => ((a.lineageOrdinal ?? -1) > (b.lineageOrdinal ?? -1) ? a : b));
      await settleResult(w, "A");
      const after = (await activeRow(w))!;
      if (after.holdPriorPrizeQualificationId) expect(after.holdPriorPrizeQualificationId).toBe(latest.prizeQualificationId);
      if (after.fulfilledByPrizeQualificationId) expect(after.fulfilledByPrizeQualificationId).toBe(latest.prizeQualificationId);
    }
  }, 180000);
});
