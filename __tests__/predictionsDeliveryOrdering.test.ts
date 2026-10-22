import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { InMemoryPredictionsRepository } from "../lib/gaming/predictions/db/inMemoryPredictionsRepository";
import { submitPrediction } from "../lib/gaming/predictions/submitPrediction";
import { finalizeMatchResult as finalizeWithDigest } from "../lib/gaming/predictions/finalizeMatchResult";
import { correctMatchResult as correctWithDigest } from "../lib/gaming/predictions/correctMatchResult";
import {
  createTeam,
  createPlayer,
  createMatch,
  createVenue,
  createVenueActivation,
  createPrizeTier,
  setMatchActivityClassification,
} from "../lib/gaming/predictions/adminCatalog";
import {
  assertPrizeQualificationShape,
  decideCorrectionPrize,
  lineageOrdinalOf,
  MAX_LINEAGE_DEPTH,
  type DeliveredEntitlement,
} from "../lib/gaming/predictions/deliveryPolicy";
import type { PrizeQualificationRecord } from "../lib/gaming/predictions/types";
import { saveResult } from "./helpers/predictionsResultFixtures";
import { RESULT_SPECS, SCENARIOS, SCRAMBLED_SCENARIOS, runScenario, type ResultKey, type ScenarioWorld } from "./helpers/prizeDeliveryScenarios";

/**
 * Score Predictions — delivery ordering and legacy delivery evidence
 * (in-memory behavior). The same scenario table runs against Postgres in
 * predictionsDeliveryOrderingSupabase.contract.test.ts; this file proves
 * the in-memory implementation follows the accepted rules, with a normal
 * clock AND with a frozen clock (every timestamp identical), plus the pure
 * decision function and the row-shape rules.
 */

const ADMIN = "gm-admin";
const ANA = "gm-ana";

async function buildWorld(): Promise<ScenarioWorld & { repo: InMemoryPredictionsRepository }> {
  const repo = new InMemoryPredictionsRepository();
  repo.authorityRepository.seedAuthority(ADMIN, "CONSEQUENTIAL_FINALIZER");
  repo.authorityRepository.seedAuthority("gm-operator", "OPERATIONAL");

  const home = await createTeam(repo, { name: "Real Madrid" });
  const away = await createTeam(repo, { name: "Barcelona" });
  const players = {
    mbappe: await createPlayer(repo, { teamId: home.teamId, name: "Mbappe" }),
    vini: await createPlayer(repo, { teamId: home.teamId, name: "Vini" }),
    lewa: await createPlayer(repo, { teamId: away.teamId, name: "Lewandowski" }),
    pedri: await createPlayer(repo, { teamId: away.teamId, name: "Pedri" }),
  };
  const match = await createMatch(repo, {
    homeTeamId: home.teamId,
    awayTeamId: away.teamId,
    competition: "Friendly",
    kickoffAt: new Date(Date.now() + 3600_000).toISOString(),
  });
  await setMatchActivityClassification(repo, match.matchId, "TRAINING", ADMIN);
  const venue = await createVenue(repo, { name: "Test Venue", latitude: 10, longitude: 10, radiusMeters: 100 });
  const activation = await createVenueActivation(repo, { matchId: match.matchId, venueId: venue.venueId });
  const jersey = await createPrizeTier(repo, { venueActivationId: activation.venueActivationId, correctDimensionCount: 4, prizeLabel: "Jersey" });
  const cap = await createPrizeTier(repo, { venueActivationId: activation.venueActivationId, correctDimensionCount: 2, prizeLabel: "Cap" });

  await submitPrediction(repo, {
    matchId: match.matchId,
    gamingMemberId: ANA,
    venueActivationId: activation.venueActivationId,
    predictedHomeScore: 1,
    predictedAwayScore: 0,
    predictedGoalscorerPlayerId: players.mbappe.playerId,
    predictedGoalMinuteRegulation: 20,
    predictedGoalMinuteStoppage: null,
    predictedFirstTeamToScore: "HOME",
    geo: { latitude: 10.0001, longitude: 10.0001, accuracyMeters: 5 },
  });

  return {
    repo,
    memberId: ANA,
    activationId: activation.venueActivationId,
    finalizerId: ADMIN,
    tierIdByCount: { 4: jersey.prizeTierId, 2: cap.prizeTierId },
    async settle(key: ResultKey) {
      const spec = RESULT_SPECS[key];
      const saved = await saveResult(repo, {
        matchId: match.matchId,
        homeScore: spec.home,
        awayScore: spec.away,
        officialGoalEvents: spec.events.map((e) => ({ scorerPlayerId: players[e.scorer].playerId, minuteRegulation: e.minute })),
        enteredByGamingMemberId: "gm-operator",
      });
      if (saved.isCorrection) {
        await correctWithDigest(repo, saved.matchResultId, ADMIN, saved.contentDigest, "Official sheet");
      } else {
        await finalizeWithDigest(repo, saved.matchResultId, ADMIN, saved.contentDigest);
      }
    },
    async editPrizeLabel(tier, label) {
      repo.setPrizeLabelForTests(tier === 4 ? jersey.prizeTierId : cap.prizeTierId, label);
    },
    async scrambleTimestamps(mode) {
      // The in-memory repository keeps no timestamp on results or evaluations that it ever reads back for ordering;
      // the entitlements' own timestamps are the ones a wrong implementation could be tempted to order by.
      const rows = (await repo.listQualificationsForActivation(activation.venueActivationId)).filter((q) => q.gamingMemberId === ANA);
      const base = new Date("2026-10-25T12:00:00.000Z").getTime();
      rows
        .slice()
        .sort((a, b) => (a.lineageOrdinal ?? 1000) - (b.lineageOrdinal ?? 1000))
        .forEach((q, k) => {
          const stamp = new Date(mode === "equal" ? base : base - (k + 1) * 3600_000).toISOString();
          repo.restateQualificationForTest(q.prizeQualificationId, {
            createdAt: stamp,
            redeemedAt: q.redeemedAt === null ? null : stamp,
            supersededAt: q.supersededAt === null ? null : stamp,
            heldAt: q.heldAt === null ? null : stamp,
            releasedAt: q.releasedAt === null ? null : stamp,
          });
        });
    },
    async moveLineage(prizeQualificationId, to) {
      repo.restateQualificationForTest(prizeQualificationId, { lineageOrdinal: to });
    },
    async restateAsMigratedLegacy(prizeQualificationId, patch) {
      repo.restateQualificationForTest(prizeQualificationId, {
        redeemedPrizeLabel: null,
        redeemedPrizeLabelBasis: patch.basis,
        legacyObservedPrizeLabel: patch.observedLabel,
        ...(patch.dropLineage ? { lineageOrdinal: null } : {}),
      });
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("Delivery ordering and legacy evidence — scenario table (in-memory)", () => {
  for (const scenario of SCENARIOS) {
    it(scenario.name, async () => {
      const world = await buildWorld();
      expect(await runScenario(world, scenario)).toEqual(scenario.expected);
    });
  }
});

describe("Delivery ordering never depends on timestamps — rewritten entitlement timestamps (in-memory)", () => {
  for (const scenario of SCRAMBLED_SCENARIOS) {
    it(scenario.name, async () => {
      const world = await buildWorld();
      expect(await runScenario(world, scenario)).toEqual(scenario.expected);
    });
  }
});

describe("Delivery ordering never depends on timestamps — frozen clock (every timestamp identical)", () => {
  for (const scenario of SCENARIOS) {
    it(scenario.name, async () => {
      vi.useFakeTimers({ toFake: ["Date"] });
      vi.setSystemTime(new Date("2026-10-25T20:00:00.000Z"));
      const world = await buildWorld();
      expect(await runScenario(world, scenario)).toEqual(scenario.expected);
    });
  }

  it("a clock that runs BACKWARDS between settlements changes nothing", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let tick = new Date("2026-10-25T23:00:00.000Z").getTime();
    vi.setSystemTime(tick);
    const world = await buildWorld();
    const original = world.settle.bind(world);
    world.settle = async (key) => {
      tick -= 60_000;
      vi.setSystemTime(tick);
      await original(key);
    };
    const redeem = world.repo.redeemPrizeQualification.bind(world.repo);
    world.repo.redeemPrizeQualification = async (...args: Parameters<typeof redeem>) => {
      tick -= 60_000;
      vi.setSystemTime(tick);
      return redeem(...args);
    };
    const scenario = SCENARIOS.find((s) => s.name.startsWith("several redeemed rows"))!;
    expect(await runScenario(world, scenario)).toEqual(scenario.expected);
  });
});

// ---------------------------------------------------------------------
// The pure decision
// ---------------------------------------------------------------------

function delivery(over: Partial<DeliveredEntitlement> & Pick<DeliveredEntitlement, "prizeQualificationId">): DeliveredEntitlement {
  return {
    prizeTierId: "tier-jersey",
    lineageOrdinal: 0,
    basis: "SNAPSHOT_AT_REDEMPTION",
    redeemedPrizeLabel: "Jersey",
    legacyObservedPrizeLabel: null,
    tierDimensionCount: 4,
    ...over,
  };
}

const NEW_JERSEY = { newTierId: "tier-jersey", newTierLabel: "Jersey", newDimensionCount: 4 };

describe("decideCorrectionPrize", () => {
  it("nothing delivered: replace the unredeemed entitlement", () => {
    expect(decideCorrectionPrize({ delivered: [], correctionLineage: 1, ...NEW_JERSEY })).toEqual({ kind: "REPLACE_UNREDEEMED" });
  });

  it("a delivery recorded at redemption, same tier and same label: fulfilled by that delivery", () => {
    expect(decideCorrectionPrize({ delivered: [delivery({ prizeQualificationId: "a" })], correctionLineage: 1, ...NEW_JERSEY }))
      .toEqual({ kind: "FULFILLED", fulfilledByPrizeQualificationId: "a" });
  });

  it("same tier but a different label, or a different tier: held as DELIVERED_PRIZE_CHANGED, prior = the delivery", () => {
    for (const d of [delivery({ prizeQualificationId: "a", redeemedPrizeLabel: "Old Jersey" }), delivery({ prizeQualificationId: "a", prizeTierId: "tier-cap", redeemedPrizeLabel: "Cap", tierDimensionCount: 2 })]) {
      const decision = decideCorrectionPrize({ delivered: [d], correctionLineage: 1, ...NEW_JERSEY });
      expect(decision).toMatchObject({ kind: "HOLD", basis: "DELIVERED_PRIZE_CHANGED", holdPriorPrizeQualificationId: "a" });
    }
  });

  it("a legacy delivery is never fulfilled, even when its observed label equals today's", () => {
    for (const basis of ["OBSERVED_AT_MIGRATION", "UNKNOWN"] as const) {
      const decision = decideCorrectionPrize({
        delivered: [delivery({ prizeQualificationId: "a", basis, redeemedPrizeLabel: null, legacyObservedPrizeLabel: basis === "UNKNOWN" ? null : "Jersey" })],
        correctionLineage: 1,
        ...NEW_JERSEY,
      });
      expect(decision).toMatchObject({ kind: "HOLD", basis: "DELIVERY_EQUIVALENCE_UNKNOWN", holdPriorPrizeQualificationId: "a" });
    }
  });

  it("the latest delivery is the highest lineage position, whatever the array order", () => {
    const older = delivery({ prizeQualificationId: "older", lineageOrdinal: 0, redeemedPrizeLabel: "Jersey" });
    const newer = delivery({ prizeQualificationId: "newer", lineageOrdinal: 3, prizeTierId: "tier-cap", redeemedPrizeLabel: "Cap", tierDimensionCount: 2 });
    for (const delivered of [[older, newer], [newer, older]]) {
      const decision = decideCorrectionPrize({ delivered, correctionLineage: 5, ...NEW_JERSEY });
      expect(decision).toMatchObject({ kind: "HOLD", basis: "DELIVERED_PRIZE_CHANGED", holdPriorPrizeQualificationId: "newer" });
    }
  });

  it("any delivery without a lineage position, a delivery at or beyond the correction, or an unreadable correction position: order unknown, no prior", () => {
    const known = delivery({ prizeQualificationId: "known", lineageOrdinal: 1 });
    const unordered = delivery({ prizeQualificationId: "unordered", lineageOrdinal: null });
    const cases: Array<[DeliveredEntitlement[], number | null]> = [
      [[known, unordered], 5],
      [[unordered], 5],
      [[known], 1],
      [[known], 0],
      [[known], null],
    ];
    for (const [delivered, correctionLineage] of cases) {
      expect(decideCorrectionPrize({ delivered, correctionLineage, ...NEW_JERSEY })).toMatchObject({
        kind: "HOLD", basis: "DELIVERY_ORDER_UNKNOWN", holdPriorPrizeQualificationId: null,
      });
    }
  });

  it("an unreadable correction position holds only when something was delivered", () => {
    expect(decideCorrectionPrize({ delivered: [], correctionLineage: null, ...NEW_JERSEY })).toEqual({ kind: "REPLACE_UNREDEEMED" });
  });

  it("a delivered tier that no longer exists reads as '?' of 4, not as an error", () => {
    const decision = decideCorrectionPrize({
      delivered: [delivery({ prizeQualificationId: "a", prizeTierId: "gone", tierDimensionCount: null })],
      correctionLineage: 1,
      ...NEW_JERSEY,
    });
    expect(decision).toMatchObject({ kind: "HOLD", basis: "DELIVERED_PRIZE_CHANGED" });
    expect((decision as { reason: string }).reason).toContain('(? of 4 correct)');
  });
});

describe("lineageOrdinalOf", () => {
  const chain = new Map<string, string | null>([
    ["r0", null], ["r1", "r0"], ["r2", "r1"], ["orphan", "missing"],
    ["loopA", "loopB"], ["loopB", "loopA"],
  ]);
  const parentOf = (id: string) => chain.get(id);

  it("counts ancestors: a first result is 0, each correction one more", () => {
    expect(lineageOrdinalOf("r0", parentOf)).toBe(0);
    expect(lineageOrdinalOf("r1", parentOf)).toBe(1);
    expect(lineageOrdinalOf("r2", parentOf)).toBe(2);
  });

  it("an unknown result has no position; a parent that cannot be found ends the chain; a cycle is unreadable", () => {
    expect(lineageOrdinalOf("nope", parentOf)).toBeNull();
    expect(lineageOrdinalOf("orphan", parentOf)).toBe(0);
    expect(lineageOrdinalOf("loopA", parentOf)).toBeNull();
  });

  it("a chain as deep as the database's cap is unreadable", () => {
    const deep = (id: string) => {
      const n = Number(id.slice(1));
      return n === 0 ? null : `d${n - 1}`;
    };
    expect(lineageOrdinalOf(`d${MAX_LINEAGE_DEPTH - 1}`, deep)).toBe(MAX_LINEAGE_DEPTH - 1);
    expect(lineageOrdinalOf(`d${MAX_LINEAGE_DEPTH}`, deep)).toBeNull();
  });
});

// ---------------------------------------------------------------------
// Row shape (the database's CHECK constraints, mirrored)
// ---------------------------------------------------------------------

function qualification(over: Partial<PrizeQualificationRecord> = {}): PrizeQualificationRecord {
  return {
    prizeQualificationId: "q", evaluationId: "e", gamingMemberId: "m", venueActivationId: "a", prizeTierId: "t",
    redeemedAt: null, redeemedByGamingMemberId: null, redeemedPrizeLabel: null, redeemedPrizeLabelBasis: null,
    legacyObservedPrizeLabel: null, lineageOrdinal: 0, supersededAt: null, replacesPrizeQualificationId: null,
    fulfilledByPrizeQualificationId: null, holdPriorPrizeQualificationId: null, heldAt: null, holdBasis: null,
    holdReason: null, releasedAt: null, releasedByGamingMemberId: null, releaseReason: null, createdAt: "2026-10-25T00:00:00.000Z",
    ...over,
  };
}

describe("assertPrizeQualificationShape", () => {
  const at = "2026-10-25T00:00:00.000Z";
  const snapshot = { redeemedAt: at, redeemedByGamingMemberId: "x", redeemedPrizeLabel: "Jersey", redeemedPrizeLabelBasis: "SNAPSHOT_AT_REDEMPTION" as const };

  it("accepts every legitimate shape", () => {
    for (const q of [
      qualification(),
      qualification({ ...snapshot }),
      qualification({ redeemedAt: at, redeemedByGamingMemberId: "x", redeemedPrizeLabelBasis: "OBSERVED_AT_MIGRATION", legacyObservedPrizeLabel: "Jersey" }),
      qualification({ redeemedAt: at, redeemedByGamingMemberId: "x", redeemedPrizeLabelBasis: "UNKNOWN" }),
      qualification({ lineageOrdinal: null }),
      qualification({ fulfilledByPrizeQualificationId: "other" }),
      qualification({ heldAt: at, holdBasis: "DELIVERY_ORDER_UNKNOWN", holdReason: "why" }),
      qualification({ heldAt: at, holdBasis: "LEGACY_PENDING_TWIN", holdReason: "why", releasedAt: at, releasedByGamingMemberId: "x", releaseReason: "ok" }),
    ]) {
      expect(() => assertPrizeQualificationShape(q)).not.toThrow();
    }
  });

  it("refuses each illegitimate shape", () => {
    const bad: Array<[string, Partial<PrizeQualificationRecord>]> = [
      ["a hold with no basis", { heldAt: at, holdReason: "why" }],
      ["a hold with an unknown basis", { heldAt: at, holdBasis: "SOMETHING" as never, holdReason: "why" }],
      ["a hold with a blank reason", { heldAt: at, holdBasis: "DELIVERED_PRIZE_CHANGED", holdReason: "  " }],
      ["a basis with no hold", { holdBasis: "DELIVERED_PRIZE_CHANGED" }],
      ["a release of something never held", { releasedAt: at, releasedByGamingMemberId: "x", releaseReason: "ok" }],
      ["a release with no reason", { heldAt: at, holdBasis: "DELIVERED_PRIZE_CHANGED", holdReason: "why", releasedAt: at, releasedByGamingMemberId: "x" }],
      ["a fulfilled row that is also held", { fulfilledByPrizeQualificationId: "o", heldAt: at, holdBasis: "DELIVERED_PRIZE_CHANGED", holdReason: "why" }],
      ["a fulfilled row with its own redemption", { fulfilledByPrizeQualificationId: "o", ...snapshot }],
      ["a self link", { replacesPrizeQualificationId: "q" }],
      ["a label with no redemption", { redeemedPrizeLabel: "Jersey" }],
      ["a redemption with no basis", { redeemedAt: at, redeemedByGamingMemberId: "x" }],
      ["a snapshot with no label", { redeemedAt: at, redeemedPrizeLabelBasis: "SNAPSHOT_AT_REDEMPTION" }],
      ["a snapshot that also carries an observed label", { ...snapshot, legacyObservedPrizeLabel: "Jersey" }],
      ["an observed delivery that claims a snapshot label", { redeemedAt: at, redeemedPrizeLabel: "Jersey", redeemedPrizeLabelBasis: "OBSERVED_AT_MIGRATION", legacyObservedPrizeLabel: "Jersey" }],
      ["an observed delivery with no observed label", { redeemedAt: at, redeemedPrizeLabelBasis: "OBSERVED_AT_MIGRATION" }],
      ["an unknown delivery that carries a label", { redeemedAt: at, redeemedPrizeLabelBasis: "UNKNOWN", legacyObservedPrizeLabel: "Jersey" }],
      ["a negative lineage position", { lineageOrdinal: -1 }],
    ];
    for (const [label, over] of bad) {
      expect(() => assertPrizeQualificationShape(qualification(over)), label).toThrow(/shape violation/);
    }
  });
});

describe("the in-memory repository cannot hold a row the database would refuse", () => {
  it("restating an entitlement with an impossible shape is refused", async () => {
    const world = await buildWorld();
    await world.settle("A");
    const [row] = await world.repo.listQualificationsForActivation(world.activationId);
    expect(() => world.repo.restateQualificationForTest(row.prizeQualificationId, { redeemedPrizeLabelBasis: "UNKNOWN" })).toThrow(/delivery_evidence_shape/);
    expect(() => world.repo.restateQualificationForTest(row.prizeQualificationId, { lineageOrdinal: -3 })).toThrow(/lineage_non_negative/);
  });

  it("the current evaluation is the one at the highest chain position, never the latest timestamp (a clock running backwards)", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    let tick = new Date("2026-10-25T23:00:00.000Z").getTime();
    vi.setSystemTime(tick);
    const world = await buildWorld();
    for (const key of ["A", "B", "A"] as const) {
      tick -= 3600_000; // every settlement is stamped EARLIER than the one before it
      vi.setSystemTime(tick);
      await world.settle(key);
    }
    const match = (await world.repo.listMatches())[0];
    const prediction = await world.repo.getPredictionForMember(match.matchId, ANA);
    const current = await world.repo.getCurrentEvaluationForPrediction(prediction!.predictionId);
    const finalized = await world.repo.getCurrentFinalizedMatchResult(match.matchId);
    expect(current!.matchResultId).toBe(finalized!.matchResultId);
    expect(current!.correctDimensionCount).toBe(4);

    // The newest chain position carries the OLDEST timestamp, so a timestamp ordering would answer with the first result's evaluation.
    const first = await world.repo.getEvaluation(prediction!.predictionId, finalized!.supersedesMatchResultId!);
    const earliest = await world.repo.getEvaluation(prediction!.predictionId, (await world.repo.getMatchResultById(finalized!.supersedesMatchResultId!))!.supersedesMatchResultId!);
    expect(current!.evaluatedAt < earliest!.evaluatedAt).toBe(true);
    expect(first!.correctDimensionCount).toBe(2);
  });
});

// ---------------------------------------------------------------------
// Tripwire: no ordering by time or by identifier in the delivery rules
// ---------------------------------------------------------------------

/** Every top-level ORDER BY key in the SQL (function calls such as lineage_ordinal(...) are one key). */
function orderingKeys(sql: string): string[] {
  const keys: string[] = [];
  const re = /order\s+by\s+/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(sql))) {
    let depth = 0;
    let current = "";
    for (let i = match.index + match[0].length; i < sql.length; i += 1) {
      const ch = sql[i];
      if (ch === "(") depth += 1;
      if (ch === ")") {
        if (depth === 0) break;
        depth -= 1;
      }
      if (depth === 0 && (ch === ";" || /^\s(limit|for|union|offset)\b/i.test(sql.slice(i, i + 9)))) break;
      if (depth === 0 && ch === ",") {
        keys.push(current.trim());
        current = "";
        continue;
      }
      current += ch;
    }
    keys.push(current.trim());
  }
  return keys.map((key) => key.replace(/\s+(asc|desc)(\s+nulls\s+(first|last))?\s*$/i, "").trim()).filter(Boolean);
}

/** A bare timestamp or identifier column used as an ordering key. */
const FORBIDDEN_KEY = /^(\w+\.)?(created_at|redeemed_at|superseded_at|held_at|released_at|evaluated_at|finalized_at|prize_qualification_id|evaluation_id|match_result_id)$/i;

describe("no delivery ordering by timestamp or identifier", () => {
  const root = process.cwd();

  it("the ordering-key extractor itself sees the keys it must (self-check)", () => {
    expect(orderingKeys("select 1 order by a.created_at desc, b.x limit 1;")).toEqual(["a.created_at", "b.x"]);
    expect(orderingKeys("select (select 1 order by lineage_ordinal(r.id) desc limit 1) from t order by t.redeemed_at;")).toEqual(["lineage_ordinal(r.id)", "t.redeemed_at"]);
    expect(orderingKeys("perform 1 from t order by prize_qualification_id for update of t;")).toEqual(["prize_qualification_id"]);
    expect(FORBIDDEN_KEY.test("match_results.finalized_at")).toBe(true);
    expect(FORBIDDEN_KEY.test("match_result_lineage_ordinal(match_results.match_result_id)")).toBe(false);
  });
  const strip = (sql: string) => sql.split("\n").filter((line) => !line.trim().startsWith("--")).join("\n");

  it("the SQL migrations never order, select a maximum or compare by a timestamp or an id to decide delivery order", () => {
    for (const file of [
      "supabase/migrations/20261020150000_add_fulfillment_and_hold_links_to_prize_qualifications.sql",
      "supabase/migrations/20261020150100_result_integrity_and_prize_correction_atomic_functions.sql",
    ]) {
      const sql = strip(readFileSync(join(root, file), "utf8"));
      expect(orderingKeys(sql).filter((key) => FORBIDDEN_KEY.test(key)), file).toEqual([]);
      expect(sql, file).not.toMatch(/\b(max|min)\s*\(\s*(prize_qualifications\.)?(created_at|redeemed_at|superseded_at|held_at|released_at|evaluated_at)\s*\)/i);
      expect(sql, file).not.toMatch(/distinct\s+on\s*\([^)]*(created_at|redeemed_at|prize_qualification_id)/i);
    }
  });

  it("the in-memory repository and the policy never sort by a timestamp or an identifier", () => {
    for (const file of ["lib/gaming/predictions/deliveryPolicy.ts", "lib/gaming/predictions/db/inMemoryPredictionsRepository.ts"]) {
      const ts = readFileSync(join(root, file), "utf8").split("\n").filter((l) => !l.trim().startsWith("//") && !l.trim().startsWith("*")).join("\n");
      expect(ts, file).not.toMatch(/\.sort\([^)]*(createdAt|redeemedAt|supersededAt|evaluatedAt|finalizedAt|localeCompare)/);
      expect(ts, file).not.toMatch(/qualificationSequence/);
    }
  });
});
