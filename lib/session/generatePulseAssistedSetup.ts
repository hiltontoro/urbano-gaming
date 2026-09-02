import type { PulseForm } from "./types";

const BOARD_SIZE = 8;
const FORM_LENGTHS = [2, 2, 3, 4];

/**
 * GENERATE_ASSISTED_SETUP. URBANO Pulse Slice 001 (UG-CR-GATE-002 /
 * UG-CR-REV-001's own "smallest bounded generator" correction — no
 * claim of statistical uniformity is made or needed). Pure, stateless,
 * no repository call: nothing is persisted by this action. The
 * returned draft remains fully editable client-side before commit, and
 * the server always fully revalidates the final layout at COMMIT_SETUP
 * regardless of whether it originated here or from manual placement —
 * this function's own output is never trusted as "already valid" by
 * anything downstream.
 *
 * Simple rejection sampling: place each form (longest first, the
 * hardest to fit) at a uniformly random in-bounds anchor cell and
 * orientation, retrying on overlap with an already-placed form, up to
 * a generous bounded attempt count. `random` is injectable only for
 * deterministic test control, mirroring mathDuelFixture.ts's own
 * precedent — production always uses Math.random via this function's
 * own default.
 */
export function generatePulseAssistedSetup(random: () => number = Math.random): PulseForm[] {
  const occupied = new Set<string>();
  const forms: PulseForm[] = [];

  const orderedLengths = [...FORM_LENGTHS].sort((a, b) => b - a);

  orderedLengths.forEach((length, index) => {
    const formId = `f${index + 1}`;
    const cells = placeOneForm(length, occupied, random);
    cells.forEach((c) => occupied.add(`${c.row},${c.col}`));
    forms.push({ formId, cells });
  });

  // Stable, product-neutral ordering (by length ascending, matching
  // the accepted 2,2,3,4 vocabulary) rather than placement order.
  return forms.sort((a, b) => a.cells.length - b.cells.length);
}

function placeOneForm(
  length: number,
  occupied: Set<string>,
  random: () => number
): Array<{ row: number; col: number }> {
  const maxAttempts = 500;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const horizontal = random() < 0.5;
    const maxAnchor = BOARD_SIZE - length;
    if (horizontal) {
      const row = Math.floor(random() * BOARD_SIZE);
      const col = Math.floor(random() * (maxAnchor + 1));
      const cells = Array.from({ length }, (_, i) => ({ row, col: col + i }));
      if (cells.every((c) => !occupied.has(`${c.row},${c.col}`))) {
        return cells;
      }
    } else {
      const col = Math.floor(random() * BOARD_SIZE);
      const row = Math.floor(random() * (maxAnchor + 1));
      const cells = Array.from({ length }, (_, i) => ({ row: row + i, col }));
      if (cells.every((c) => !occupied.has(`${c.row},${c.col}`))) {
        return cells;
      }
    }
  }
  // Defensive fallback (should never be reached at this board size/
  // inventory — 8x8 with only 11 total occupied cells has abundant
  // room): scan deterministically for the first legal placement.
  for (let row = 0; row < BOARD_SIZE; row++) {
    for (let col = 0; col <= BOARD_SIZE - length; col++) {
      const cells = Array.from({ length }, (_, i) => ({ row, col: col + i }));
      if (cells.every((c) => !occupied.has(`${c.row},${c.col}`))) {
        return cells;
      }
    }
  }
  throw new Error("generatePulseAssistedSetup: no legal placement found (unreachable at this board size).");
}
