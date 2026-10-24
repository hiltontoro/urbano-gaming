import type { DeliveryEvidenceBasis, PrizeHoldBasis, PrizeQualificationRecord } from "./types";

/**
 * The prize-delivery rules a result correction applies, as pure functions.
 *
 * correct_match_result_atomically (Postgres) holds the authoritative copy;
 * the in-memory repository calls these functions, and a shared scenario
 * table drives both implementations to prove they agree. Keep the decision
 * order and the hold text identical to the SQL.
 *
 * ORDERING. "Latest delivery" is the redeemed entitlement at the highest
 * LINEAGE position — the position of its result in the explicit
 * supersession chain of results (match_results.supersedes_match_result_id).
 * It is never derived from a timestamp or an identifier: transactions can
 * begin in one order and take their locks in another, one transaction can
 * write several rows with one timestamp, and random identifiers carry no
 * order at all. (member, activation, lineage position) is unique, so the
 * latest delivery is unambiguous whenever every delivery has a position.
 * Where one does not, the order cannot be established and nothing is
 * inferred: the new entitlement is held for reconciliation.
 */

/** Same cap as match_result_lineage_ordinal(): a chain this deep is treated as unreadable. */
export const MAX_LINEAGE_DEPTH = 10000;

/**
 * Position of a result in its supersession chain: the number of ancestors.
 * null when the result does not exist or its chain is unreadable (too deep
 * or cyclic). A parent that cannot be found ends the chain, exactly as the
 * recursive SQL join does. supersedesOf returns undefined for an unknown
 * result and null for a result that supersedes nothing.
 */
export function lineageOrdinalOf(
  matchResultId: string,
  supersedesOf: (matchResultId: string) => string | null | undefined
): number | null {
  if (supersedesOf(matchResultId) === undefined) return null; // no such result
  let depth = 0;
  let current = matchResultId;
  const seen = new Set<string>([current]);
  for (;;) {
    const parent = supersedesOf(current);
    if (parent === undefined || parent === null) return depth;
    if (supersedesOf(parent) === undefined) return depth; // parent row not found: chain ends at `current`
    depth += 1;
    if (depth >= MAX_LINEAGE_DEPTH || seen.has(parent)) return null;
    seen.add(parent);
    current = parent;
  }
}

/** One physically delivered entitlement of a member for an activation. */
export interface DeliveredEntitlement {
  prizeQualificationId: string;
  prizeTierId: string;
  lineageOrdinal: number | null;
  basis: DeliveryEvidenceBasis;
  /** Present only for basis SNAPSHOT_AT_REDEMPTION. */
  redeemedPrizeLabel: string | null;
  /** Present only for basis OBSERVED_AT_MIGRATION. */
  legacyObservedPrizeLabel: string | null;
  /**
   * The delivered tier's key today, if the tier still exists: its
   * correct-dimension count (scale COUNT) or its ladder level (scale
   * LADDER). Only used to word the hold reason.
   */
  tierDimensionCount: number | null;
}

/**
 * How a tier's key is worded: COUNT is the historical "N of 4 correct";
 * LADDER is the won level, "level N of 4". The decision itself never
 * depends on this — only the text.
 */
export type TierScale = "COUNT" | "LADDER";

function describeTierKey(scale: TierScale, value: number | string): string {
  return scale === "LADDER" ? `level ${value} of 4` : `${value} of 4 correct`;
}

export interface CorrectionPrizeInput {
  /** EVERY redeemed entitlement of this member and activation, superseded or not. */
  delivered: DeliveredEntitlement[];
  /** Lineage position of the correction being applied; null if its own chain is unreadable. */
  correctionLineage: number | null;
  newTierId: string;
  newTierLabel: string;
  /** The new tier's key: the correct-dimension count (COUNT) or the won level (LADDER). */
  newDimensionCount: number;
  /** Defaults to COUNT, the historical wording. */
  scale?: TierScale;
}

export type CorrectionPrizeDecision =
  | { kind: "REPLACE_UNREDEEMED" }
  | { kind: "FULFILLED"; fulfilledByPrizeQualificationId: string }
  | {
      kind: "HOLD";
      basis: PrizeHoldBasis;
      holdPriorPrizeQualificationId: string | null;
      reason: string;
    };

export function decideCorrectionPrize(input: CorrectionPrizeInput): CorrectionPrizeDecision {
  const { delivered, correctionLineage, newTierId, newTierLabel, newDimensionCount } = input;
  const scale: TierScale = input.scale ?? "COUNT";
  if (delivered.length === 0) return { kind: "REPLACE_UNREDEEMED" };

  const ordered = delivered.filter((d) => d.lineageOrdinal !== null);
  const unordered = delivered.length - ordered.length;
  let latest: DeliveredEntitlement | null = null;
  for (const d of ordered) {
    if (latest === null || (d.lineageOrdinal as number) > (latest.lineageOrdinal as number)) latest = d;
  }

  if (correctionLineage === null || unordered > 0 || latest === null || (latest.lineageOrdinal as number) >= correctionLineage) {
    return {
      kind: "HOLD",
      basis: "DELIVERY_ORDER_UNKNOWN",
      holdPriorPrizeQualificationId: null,
      reason:
        `A correction affected a prize for a member who already has a delivery, but the order of this member's deliveries and replacements could not be established from the records. ` +
        `Now entitled to: "${newTierLabel}" (${describeTierKey(scale, newDimensionCount)}). ` +
        `A Consequential Finalizer must reconcile this with the venue, with a reason, before any further delivery.`,
    };
  }

  const dimension = latest.tierDimensionCount === null ? "?" : String(latest.tierDimensionCount);

  if (
    latest.basis === "SNAPSHOT_AT_REDEMPTION" &&
    latest.prizeTierId === newTierId &&
    latest.redeemedPrizeLabel === newTierLabel
  ) {
    // Same prize identity AND the label recorded at delivery equals today's
    // definition: the original delivery already satisfies the entitlement.
    return { kind: "FULFILLED", fulfilledByPrizeQualificationId: latest.prizeQualificationId };
  }

  if (latest.basis === "SNAPSHOT_AT_REDEMPTION") {
    return {
      kind: "HOLD",
      basis: "DELIVERED_PRIZE_CHANGED",
      holdPriorPrizeQualificationId: latest.prizeQualificationId,
      reason:
        `A correction changed a prize that was already delivered. Delivered: "${latest.redeemedPrizeLabel}" (${describeTierKey(scale, dimension)}). ` +
        `Now entitled to: "${newTierLabel}" (${describeTierKey(scale, newDimensionCount)}). ` +
        `No further delivery is authorized until a Consequential Finalizer releases this hold with a reason.`,
    };
  }

  // The earlier delivery predates delivery-time label snapshots: today's
  // definition of that prize is not evidence of what was handed over.
  return {
    kind: "HOLD",
    basis: "DELIVERY_EQUIVALENCE_UNKNOWN",
    holdPriorPrizeQualificationId: latest.prizeQualificationId,
    reason:
      `A correction affected a prize that was already delivered, but that delivery was recorded before delivery-time prize labels were kept, so it cannot be shown to be the same prize. ` +
      `The earlier delivery is defined today as "${latest.legacyObservedPrizeLabel ?? "(no definition found)"}" (${describeTierKey(scale, dimension)}), which may differ from what was handed over; ` +
      `this correction entitles the member to "${newTierLabel}" (${describeTierKey(scale, newDimensionCount)}). ` +
      `A Consequential Finalizer must reconcile this with the venue, with a reason, before any further delivery.`,
  };
}

const HOLD_BASES: ReadonlySet<string> = new Set<PrizeHoldBasis>([
  "DELIVERED_PRIZE_CHANGED",
  "DELIVERY_EQUIVALENCE_UNKNOWN",
  "DELIVERY_ORDER_UNKNOWN",
  "LEGACY_PENDING_TWIN",
]);

/**
 * The row-shape rules prize_qualifications enforces with CHECK constraints
 * (hold_shape, release_shape, fulfilled_excludes_hold,
 * fulfilled_has_no_own_redemption, no_self_link, delivery_evidence_shape,
 * lineage_non_negative). The in-memory repository applies them to every
 * write so it cannot hold a row the database would refuse.
 */
export function assertPrizeQualificationShape(q: PrizeQualificationRecord): void {
  const fail = (rule: string): never => {
    throw new Error(`prize_qualifications shape violation (${rule}) on ${q.prizeQualificationId}`);
  };

  const holdAny = q.heldAt !== null || q.holdPriorPrizeQualificationId !== null || q.holdBasis !== null || q.holdReason !== null;
  if (holdAny) {
    if (q.heldAt === null || q.holdBasis === null || !HOLD_BASES.has(q.holdBasis) || q.holdReason === null || q.holdReason.trim().length < 1) {
      fail("hold_shape");
    }
  }

  const releaseAny = q.releasedAt !== null || q.releasedByGamingMemberId !== null || q.releaseReason !== null;
  if (releaseAny) {
    if (
      q.heldAt === null ||
      q.releasedAt === null ||
      q.releasedByGamingMemberId === null ||
      q.releaseReason === null ||
      q.releaseReason.trim().length < 1
    ) {
      fail("release_shape");
    }
  }

  if (q.fulfilledByPrizeQualificationId !== null) {
    if (q.heldAt !== null) fail("fulfilled_excludes_hold");
    if (q.redeemedAt !== null) fail("fulfilled_has_no_own_redemption");
  }

  const id = q.prizeQualificationId;
  if (
    q.fulfilledByPrizeQualificationId === id ||
    q.holdPriorPrizeQualificationId === id ||
    q.replacesPrizeQualificationId === id
  ) {
    fail("no_self_link");
  }

  if (q.redeemedAt === null) {
    if (q.redeemedPrizeLabel !== null || q.redeemedPrizeLabelBasis !== null || q.legacyObservedPrizeLabel !== null) {
      fail("delivery_evidence_shape");
    }
  } else if (q.redeemedPrizeLabelBasis === "SNAPSHOT_AT_REDEMPTION") {
    if (q.redeemedPrizeLabel === null || q.legacyObservedPrizeLabel !== null) fail("delivery_evidence_shape");
  } else if (q.redeemedPrizeLabelBasis === "OBSERVED_AT_MIGRATION") {
    if (q.redeemedPrizeLabel !== null || q.legacyObservedPrizeLabel === null) fail("delivery_evidence_shape");
  } else if (q.redeemedPrizeLabelBasis === "UNKNOWN") {
    if (q.redeemedPrizeLabel !== null || q.legacyObservedPrizeLabel !== null) fail("delivery_evidence_shape");
  } else {
    fail("delivery_evidence_shape");
  }

  if (q.lineageOrdinal !== null && q.lineageOrdinal < 0) fail("lineage_non_negative");
}
