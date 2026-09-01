/**
 * URBANO Towers Slice 001 — pure stack-transfer rules engine. No I/O, no
 * randomness, no wall-clock reads (mirrors geometry.ts's role for Rutas).
 * The authoritative move is MOVE_TOP_PIECE { fromTowerId, toTowerId } —
 * the caller never supplies which piece moves; it is always derived here
 * from the current top of fromTowerId.
 */

import type { TowersScenario, TowersStacks } from "./types";

export interface TowersMoveValidation {
  legal: boolean;
  reason?: string;
  resultingStacks?: TowersStacks;
  movedPieceRank?: number;
}

function stackOf(stacks: TowersStacks, towerId: string): number[] {
  return stacks[towerId] ?? [];
}

/**
 * Validates and computes the result of MOVE_TOP_PIECE against the given
 * current state. Never mutates its input. Returns legal:false with a
 * human-readable reason for every rejection case — nonexistent tower,
 * same source/destination, empty source, and larger-on-smaller.
 */
export function validateAndApplyMove(
  scenario: TowersScenario,
  currentStacks: TowersStacks,
  fromTowerId: string,
  toTowerId: string
): TowersMoveValidation {
  if (!scenario.towerIds.includes(fromTowerId) || !scenario.towerIds.includes(toTowerId)) {
    return { legal: false, reason: "No such tower exists in this scenario." };
  }
  if (fromTowerId === toTowerId) {
    return { legal: false, reason: "Source and destination towers must be different." };
  }

  const fromStack = stackOf(currentStacks, fromTowerId);
  if (fromStack.length === 0) {
    return { legal: false, reason: "The source tower is empty." };
  }
  const movingRank = fromStack[fromStack.length - 1];

  const toStack = stackOf(currentStacks, toTowerId);
  const destTopRank = toStack.length > 0 ? toStack[toStack.length - 1] : null;
  if (destTopRank !== null && destTopRank < movingRank) {
    return { legal: false, reason: "Cannot place a larger piece on top of a smaller piece." };
  }

  const resultingStacks: TowersStacks = {
    ...currentStacks,
    [fromTowerId]: fromStack.slice(0, -1),
    [toTowerId]: [...toStack, movingRank],
  };

  return { legal: true, resultingStacks, movedPieceRank: movingRank };
}

/**
 * Classic destination completion: every piece from the scenario's
 * original starting arrangement now sits on destinationTowerId in valid
 * descending order (largest at the bottom), and every other tower is
 * empty. The ordering check is a defensive invariant, not a load-bearing
 * one — every legal move already preserves valid ordering by
 * construction, so this can never actually fail in reachable states, but
 * it costs nothing to assert explicitly.
 */
export function isComplete(scenario: TowersScenario, stacks: TowersStacks): boolean {
  const totalPieces = Object.values(scenario.initialStacks).reduce((sum, s) => sum + s.length, 0);
  const destStack = stackOf(stacks, scenario.destinationTowerId);
  if (destStack.length !== totalPieces) return false;

  for (let i = 0; i < destStack.length - 1; i++) {
    if (destStack[i] <= destStack[i + 1]) return false;
  }

  for (const towerId of scenario.towerIds) {
    if (towerId === scenario.destinationTowerId) continue;
    if (stackOf(stacks, towerId).length > 0) return false;
  }

  return true;
}

/** Deep-copies a scenario's authored starting arrangement into runtime state. */
export function initialStacks(scenario: TowersScenario): TowersStacks {
  const result: TowersStacks = {};
  for (const towerId of scenario.towerIds) {
    result[towerId] = [...(scenario.initialStacks[towerId] ?? [])];
  }
  return result;
}
