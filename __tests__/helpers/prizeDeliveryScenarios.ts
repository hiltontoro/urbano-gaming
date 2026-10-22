import { expect } from "vitest";

import type { PredictionsRepository } from "../../lib/gaming/predictions/db/predictionsRepository";
import type { DeliveryEvidenceBasis, PrizeQualificationRecord } from "../../lib/gaming/predictions/types";

/**
 * One scenario table, two implementations.
 *
 * The prize-delivery rules that a result correction applies exist twice:
 * in Postgres (correct_match_result_atomically) and in the in-memory
 * repository (through deliveryPolicy.ts). Each scenario here is a short
 * story about one member's entitlement across settlements, deliveries,
 * holds and legacy rows, plus the EXACT state every entitlement row must
 * end in. The in-memory behavioral suite and the Postgres contract suite
 * both run every scenario through the same engine against the same
 * expected rows, so a difference between the two implementations — or a
 * regression in either — fails a test.
 *
 * The expected rows are written out by hand. They are authored from the
 * accepted policy, not computed by the code under test, and nothing here
 * reads a timestamp or an identifier to decide order.
 */

export type ResultKey = "A" | "B" | "C";

/** Ana predicts 1-0, Mbappe, minute 20, home first. A = 4 of 4 correct (Jersey), B = 2 (Cap), C = 1 (no prize). */
export const RESULT_SPECS: Record<ResultKey, { home: number; away: number; events: Array<{ scorer: "mbappe" | "vini" | "lewa" | "pedri"; minute: number }> }> = {
  A: { home: 1, away: 0, events: [{ scorer: "mbappe", minute: 20 }] },
  B: { home: 1, away: 0, events: [{ scorer: "vini", minute: 30 }] },
  C: { home: 0, away: 2, events: [{ scorer: "lewa", minute: 10 }, { scorer: "pedri", minute: 20 }] },
};

export interface LegacyPatch {
  basis: Extract<DeliveryEvidenceBasis, "OBSERVED_AT_MIGRATION" | "UNKNOWN">;
  /** The prize definition seen when the data was migrated (null when none was readable). */
  observedLabel: string | null;
  /** The row's position in the result chain could not be established. */
  dropLineage?: boolean;
}

/** equal: every timestamp identical. reversed: later rows get EARLIER timestamps (a clock running backwards). */
export type ScrambleMode = "equal" | "reversed";

export type Step =
  | { settle: ResultKey }
  | { scramble: ScrambleMode }
  | { redeem: string }
  | { release: string }
  | { refuseRedeem: string; error: string }
  | { editPrize: { tier: 4 | 2; label: string } }
  | { restate: string; patch: LegacyPatch }
  /** Puts a delivery at a position in the chain that no valid history can produce (at or beyond a later correction). */
  | { moveLineage: string; to: number };

export interface ExpectedRow {
  row: string;
  lineage: number | null;
  tier: 4 | 2;
  superseded: boolean;
  replaces: string | null;
  redeemed: boolean;
  /** The label snapshot taken at redemption (basis SNAPSHOT_AT_REDEMPTION only). */
  deliveredAs: string | null;
  basis: DeliveryEvidenceBasis | null;
  observedLabel: string | null;
  fulfilledBy: string | null;
  holdBasis: string | null;
  holdPrior: string | null;
  holdReason: string | null;
  released: boolean;
}

export interface Scenario {
  name: string;
  steps: Step[];
  expected: ExpectedRow[];
}

// The text a hold carries. Written out here independently of the code that produces it.
const changedText = (delivered: string, deliveredCount: number, now: string, nowCount: number) =>
  `A correction changed a prize that was already delivered. Delivered: "${delivered}" (${deliveredCount} of 4 correct). ` +
  `Now entitled to: "${now}" (${nowCount} of 4 correct). ` +
  `No further delivery is authorized until a Consequential Finalizer releases this hold with a reason.`;

const equivalenceUnknownText = (observed: string | null, observedCount: number, now: string, nowCount: number) =>
  `A correction affected a prize that was already delivered, but that delivery was recorded before delivery-time prize labels were kept, so it cannot be shown to be the same prize. ` +
  `The earlier delivery is defined today as "${observed ?? "(no definition found)"}" (${observedCount} of 4 correct), which may differ from what was handed over; ` +
  `this correction entitles the member to "${now}" (${nowCount} of 4 correct). ` +
  `A Consequential Finalizer must reconcile this with the venue, with a reason, before any further delivery.`;

const orderUnknownText = (now: string, nowCount: number) =>
  `A correction affected a prize for a member who already has a delivery, but the order of this member's deliveries and replacements could not be established from the records. ` +
  `Now entitled to: "${now}" (${nowCount} of 4 correct). ` +
  `A Consequential Finalizer must reconcile this with the venue, with a reason, before any further delivery.`;

function row(over: Partial<ExpectedRow> & Pick<ExpectedRow, "row" | "lineage" | "tier">): ExpectedRow {
  return {
    superseded: true,
    replaces: null,
    redeemed: false,
    deliveredAs: null,
    basis: null,
    observedLabel: null,
    fulfilledBy: null,
    holdBasis: null,
    holdPrior: null,
    holdReason: null,
    released: false,
    ...over,
  };
}

const delivered = (label: string): Partial<ExpectedRow> => ({ redeemed: true, deliveredAs: label, basis: "SNAPSHOT_AT_REDEMPTION" });
const legacyDelivery = (observed: string | null, basis: "OBSERVED_AT_MIGRATION" | "UNKNOWN" = "OBSERVED_AT_MIGRATION"): Partial<ExpectedRow> => ({
  redeemed: true, deliveredAs: null, basis, observedLabel: observed,
});

export const SCENARIOS: Scenario[] = [
  {
    name: "unredeemed entitlements are replaced, with a history link and nothing held; a superseded row cannot be redeemed",
    steps: [{ settle: "A" }, { settle: "B" }, { refuseRedeem: "r0", error: "QualificationSupersededError" }, { redeem: "r1" }],
    expected: [
      row({ row: "r0", lineage: 0, tier: 4 }),
      row({ row: "r1", lineage: 1, tier: 2, superseded: false, replaces: "r0", ...delivered("Cap") }),
    ],
  },
  {
    name: "redeemed and unchanged, corrected repeatedly: every replacement points at the one real delivery",
    steps: [
      { settle: "A" }, { redeem: "r0" },
      { settle: "A" }, { settle: "A" },
      { refuseRedeem: "r1", error: "QualificationSupersededError" },
      { settle: "B" },
      { settle: "A" },
      { refuseRedeem: "r4", error: "PrizeAlreadyFulfilledError" },
    ],
    expected: [
      row({ row: "r0", lineage: 0, tier: 4, ...delivered("Jersey") }),
      row({ row: "r1", lineage: 1, tier: 4, replaces: "r0", fulfilledBy: "r0" }),
      row({ row: "r2", lineage: 2, tier: 4, replaces: "r1", fulfilledBy: "r0" }),
      row({ row: "r3", lineage: 3, tier: 2, replaces: "r2", holdBasis: "DELIVERED_PRIZE_CHANGED", holdPrior: "r0", holdReason: changedText("Jersey", 4, "Cap", 2) }),
      row({ row: "r4", lineage: 4, tier: 4, superseded: false, replaces: "r3", fulfilledBy: "r0" }),
    ],
  },
  {
    name: "several redeemed rows: the latest delivery is the one at the highest lineage position, and each decision follows it",
    steps: [
      { settle: "A" }, { redeem: "r0" },
      { settle: "B" },                                                   // r1: Cap held (Jersey was delivered)
      { refuseRedeem: "r1", error: "PrizeQualificationHeldError" },
      { release: "r1" }, { redeem: "r1" },                                // Cap delivered
      { settle: "A" },                                                   // r2: Jersey vs latest delivery Cap -> held, NOT fulfilled by the older Jersey
      { release: "r2" }, { redeem: "r2" },                                // Jersey delivered again
      { settle: "A" },                                                   // r3: fulfilled by r2, not r0
      { refuseRedeem: "r3", error: "PrizeAlreadyFulfilledError" },
      { settle: "B" },                                                   // r4: Cap vs latest delivery Jersey (r2) -> held
    ],
    expected: [
      row({ row: "r0", lineage: 0, tier: 4, ...delivered("Jersey") }),
      row({
        row: "r1", lineage: 1, tier: 2, replaces: "r0", ...delivered("Cap"),
        holdBasis: "DELIVERED_PRIZE_CHANGED", holdPrior: "r0", holdReason: changedText("Jersey", 4, "Cap", 2), released: true,
      }),
      row({
        row: "r2", lineage: 2, tier: 4, replaces: "r1", ...delivered("Jersey"),
        holdBasis: "DELIVERED_PRIZE_CHANGED", holdPrior: "r1", holdReason: changedText("Cap", 2, "Jersey", 4), released: true,
      }),
      row({ row: "r3", lineage: 3, tier: 4, replaces: "r2", fulfilledBy: "r2" }),
      row({ row: "r4", lineage: 4, tier: 2, superseded: false, replaces: "r3", holdBasis: "DELIVERED_PRIZE_CHANGED", holdPrior: "r2", holdReason: changedText("Jersey", 4, "Cap", 2) }),
    ],
  },
  {
    name: "temporary loss, then re-qualification: lineage positions are positions in the chain, not row counts",
    steps: [{ settle: "A" }, { redeem: "r0" }, { settle: "C" }, { settle: "A" }, { settle: "B" }],
    expected: [
      row({ row: "r0", lineage: 0, tier: 4, ...delivered("Jersey") }),
      row({ row: "r1", lineage: 2, tier: 4, replaces: null, fulfilledBy: "r0" }),
      row({ row: "r2", lineage: 3, tier: 2, superseded: false, replaces: "r1", holdBasis: "DELIVERED_PRIZE_CHANGED", holdPrior: "r0", holdReason: changedText("Jersey", 4, "Cap", 2) }),
    ],
  },
  {
    name: "redeemed and the participant no longer qualifies: history preserved, no clawback, no new row",
    steps: [{ settle: "A" }, { redeem: "r0" }, { settle: "C" }],
    expected: [row({ row: "r0", lineage: 0, tier: 4, ...delivered("Jersey") })],
  },
  {
    name: "an edited prize definition is not an unchanged prize (same tier, new label)",
    steps: [{ settle: "A" }, { redeem: "r0" }, { editPrize: { tier: 4, label: "Premium Jersey" } }, { settle: "A" }],
    expected: [
      row({ row: "r0", lineage: 0, tier: 4, ...delivered("Jersey") }),
      row({ row: "r1", lineage: 1, tier: 4, superseded: false, replaces: "r0", holdBasis: "DELIVERED_PRIZE_CHANGED", holdPrior: "r0", holdReason: changedText("Jersey", 4, "Premium Jersey", 4) }),
    ],
  },
  {
    name: "a legacy delivery whose observed label equals today's is still not proof: held, never auto-fulfilled; a later delivery recorded at redemption can satisfy",
    steps: [
      { settle: "A" }, { redeem: "r0" },
      { restate: "r0", patch: { basis: "OBSERVED_AT_MIGRATION", observedLabel: "Jersey" } },
      { settle: "A" },
      { refuseRedeem: "r1", error: "PrizeQualificationHeldError" },
      { release: "r1" }, { redeem: "r1" },
      { settle: "A" },
    ],
    expected: [
      row({ row: "r0", lineage: 0, tier: 4, ...legacyDelivery("Jersey") }),
      row({
        row: "r1", lineage: 1, tier: 4, replaces: "r0", ...delivered("Jersey"),
        holdBasis: "DELIVERY_EQUIVALENCE_UNKNOWN", holdPrior: "r0", holdReason: equivalenceUnknownText("Jersey", 4, "Jersey", 4), released: true,
      }),
      row({ row: "r2", lineage: 2, tier: 4, superseded: false, replaces: "r1", fulfilledBy: "r1" }),
    ],
  },
  {
    name: "a prize whose label changed before migration: the migration observed the NEW label, so equivalence with what was handed over is unknown (held)",
    steps: [
      { settle: "A" }, { redeem: "r0" },
      { editPrize: { tier: 4, label: "Premium Jersey" } },
      { restate: "r0", patch: { basis: "OBSERVED_AT_MIGRATION", observedLabel: "Premium Jersey" } },
      { settle: "A" },
    ],
    expected: [
      row({ row: "r0", lineage: 0, tier: 4, ...legacyDelivery("Premium Jersey") }),
      row({
        row: "r1", lineage: 1, tier: 4, superseded: false, replaces: "r0",
        holdBasis: "DELIVERY_EQUIVALENCE_UNKNOWN", holdPrior: "r0", holdReason: equivalenceUnknownText("Premium Jersey", 4, "Premium Jersey", 4),
      }),
    ],
  },
  {
    name: "a legacy delivery with no readable prize definition: held with the unknown stated",
    steps: [
      { settle: "A" }, { redeem: "r0" },
      { restate: "r0", patch: { basis: "UNKNOWN", observedLabel: null } },
      { settle: "B" },
    ],
    expected: [
      row({ row: "r0", lineage: 0, tier: 4, ...legacyDelivery(null, "UNKNOWN") }),
      row({
        row: "r1", lineage: 1, tier: 2, superseded: false, replaces: "r0",
        holdBasis: "DELIVERY_EQUIVALENCE_UNKNOWN", holdPrior: "r0", holdReason: equivalenceUnknownText(null, 4, "Cap", 2),
      }),
    ],
  },
  {
    name: "a delivery whose place in the chain cannot be established: hold for reconciliation, naming no prior, and keep holding while any such delivery remains",
    steps: [
      { settle: "A" }, { redeem: "r0" },
      { restate: "r0", patch: { basis: "OBSERVED_AT_MIGRATION", observedLabel: "Jersey", dropLineage: true } },
      { settle: "A" },
      { refuseRedeem: "r1", error: "PrizeQualificationHeldError" },
      { release: "r1" }, { redeem: "r1" },
      { settle: "A" },
    ],
    expected: [
      row({ row: "r0", lineage: null, tier: 4, ...legacyDelivery("Jersey") }),
      row({
        row: "r1", lineage: 1, tier: 4, replaces: "r0", ...delivered("Jersey"),
        holdBasis: "DELIVERY_ORDER_UNKNOWN", holdPrior: null, holdReason: orderUnknownText("Jersey", 4), released: true,
      }),
      row({ row: "r2", lineage: 2, tier: 4, superseded: false, replaces: "r1", holdBasis: "DELIVERY_ORDER_UNKNOWN", holdPrior: null, holdReason: orderUnknownText("Jersey", 4) }),
    ],
  },
  {
    name: "a legacy delivery beside a known new delivery: the new delivery, at the later lineage position, is the baseline",
    steps: [
      { settle: "A" }, { redeem: "r0" },
      { restate: "r0", patch: { basis: "OBSERVED_AT_MIGRATION", observedLabel: "Jersey" } },
      { settle: "B" },
      { release: "r1" }, { redeem: "r1" },
      { settle: "B" },
    ],
    expected: [
      row({ row: "r0", lineage: 0, tier: 4, ...legacyDelivery("Jersey") }),
      row({
        row: "r1", lineage: 1, tier: 2, replaces: "r0", ...delivered("Cap"),
        holdBasis: "DELIVERY_EQUIVALENCE_UNKNOWN", holdPrior: "r0", holdReason: equivalenceUnknownText("Jersey", 4, "Cap", 2), released: true,
      }),
      row({ row: "r2", lineage: 2, tier: 2, superseded: false, replaces: "r1", fulfilledBy: "r1" }),
    ],
  },
  {
    name: "a delivery recorded at or beyond the correction's own position cannot be trusted: held for reconciliation, never satisfied by it",
    steps: [
      { settle: "A" }, { redeem: "r0" },
      { moveLineage: "r0", to: 7 },
      { settle: "A" },
    ],
    expected: [
      row({ row: "r0", lineage: 7, tier: 4, ...delivered("Jersey") }),
      row({ row: "r1", lineage: 1, tier: 4, superseded: false, replaces: "r0", holdBasis: "DELIVERY_ORDER_UNKNOWN", holdPrior: null, holdReason: orderUnknownText("Jersey", 4) }),
    ],
  },
];

// ---------------------------------------------------------------------
// Engine
// ---------------------------------------------------------------------

function withScrambledClocks(scenario: Scenario, mode: ScrambleMode): Scenario {
  return {
    name: `${scenario.name} — timestamps scrambled (${mode}) before every settlement`,
    steps: scenario.steps.flatMap<Step>((step) => ("settle" in step ? [{ scramble: mode }, step] : [step])),
    expected: scenario.expected,
  };
}

/**
 * Every scenario above again, with the timestamps of the entitlements (and
 * in Postgres also of results and evaluations) rewritten before each
 * settlement: all equal, and running backwards. Ordering must not move.
 */
export const SCRAMBLED_SCENARIOS: Scenario[] = SCENARIOS.flatMap((scenario) => [
  withScrambledClocks(scenario, "equal"),
  withScrambledClocks(scenario, "reversed"),
]);

/** What an implementation supplies so the engine can drive it. */
export interface ScenarioWorld {
  repo: PredictionsRepository;
  memberId: string;
  activationId: string;
  finalizerId: string;
  /** correct-dimension count of each prize tier (4 and 2). */
  tierIdByCount: Record<4 | 2, string>;
  settle(result: ResultKey): Promise<void>;
  editPrizeLabel(tier: 4 | 2, label: string): Promise<void>;
  /** Rewrites the timestamps of existing rows without touching anything else. */
  scrambleTimestamps(mode: ScrambleMode): Promise<void>;
  /** Rewrites a delivered row the way the data migration leaves a pre-existing one. */
  restateAsMigratedLegacy(prizeQualificationId: string, patch: LegacyPatch): Promise<void>;
  /** Moves a row's lineage position without touching anything else. */
  moveLineage(prizeQualificationId: string, to: number): Promise<void>;
}

async function memberRows(world: ScenarioWorld): Promise<PrizeQualificationRecord[]> {
  return (await world.repo.listQualificationsForActivation(world.activationId)).filter((q) => q.gamingMemberId === world.memberId);
}

/** Runs the steps and returns the member's entitlement rows in their final state, labelled r0, r1, ... in order of appearance. */
export async function runScenario(world: ScenarioWorld, scenario: Scenario): Promise<ExpectedRow[]> {
  const labelOf = new Map<string, string>();
  const idOf = new Map<string, string>();

  const refresh = async (): Promise<PrizeQualificationRecord[]> => {
    const rows = await memberRows(world);
    const fresh = rows.filter((r) => !labelOf.has(r.prizeQualificationId));
    expect(fresh.length, "at most one new entitlement row per step").toBeLessThanOrEqual(1);
    for (const r of fresh) {
      const label = `r${labelOf.size}`;
      labelOf.set(r.prizeQualificationId, label);
      idOf.set(label, r.prizeQualificationId);
    }
    return rows;
  };
  const idFor = (label: string): string => {
    const id = idOf.get(label);
    if (!id) throw new Error(`scenario refers to ${label} before it exists`);
    return id;
  };

  for (const step of scenario.steps) {
    if ("settle" in step) {
      await world.settle(step.settle);
    } else if ("scramble" in step) {
      await world.scrambleTimestamps(step.scramble);
    } else if ("redeem" in step) {
      await world.repo.redeemPrizeQualification(idFor(step.redeem), world.finalizerId, null);
    } else if ("release" in step) {
      await world.repo.releasePrizeQualificationHold(idFor(step.release), world.finalizerId, "Founder approved the replacement prize");
    } else if ("refuseRedeem" in step) {
      const refused = await world.repo
        .redeemPrizeQualification(idFor(step.refuseRedeem), world.finalizerId, null)
        .then(() => "NOT REFUSED", (e: unknown) => (e as { constructor: { name: string } }).constructor.name);
      expect(refused, `redeem ${step.refuseRedeem}`).toBe(step.error);
    } else if ("editPrize" in step) {
      await world.editPrizeLabel(step.editPrize.tier, step.editPrize.label);
    } else if ("moveLineage" in step) {
      await world.moveLineage(idFor(step.moveLineage), step.to);
    } else {
      await world.restateAsMigratedLegacy(idFor(step.restate), step.patch);
    }
    await refresh();
  }

  const finalRows = await refresh();
  const tierCount = new Map<string, 4 | 2>([
    [world.tierIdByCount[4], 4],
    [world.tierIdByCount[2], 2],
  ]);
  const link = (id: string | null) => (id === null ? null : labelOf.get(id) ?? `UNKNOWN(${id})`);

  return finalRows
    .map<ExpectedRow>((q) => ({
      row: labelOf.get(q.prizeQualificationId)!,
      lineage: q.lineageOrdinal,
      tier: tierCount.get(q.prizeTierId)!,
      superseded: q.supersededAt !== null,
      replaces: link(q.replacesPrizeQualificationId),
      redeemed: q.redeemedAt !== null,
      deliveredAs: q.redeemedPrizeLabel,
      basis: q.redeemedPrizeLabelBasis,
      observedLabel: q.legacyObservedPrizeLabel,
      fulfilledBy: link(q.fulfilledByPrizeQualificationId),
      holdBasis: q.holdBasis,
      holdPrior: link(q.holdPriorPrizeQualificationId),
      holdReason: q.holdReason,
      released: q.releasedAt !== null,
    }))
    .sort((a, b) => Number(a.row.slice(1)) - Number(b.row.slice(1)));
}
