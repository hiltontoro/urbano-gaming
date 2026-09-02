import type { PulseForm } from "./types";

const BOARD_SIZE = 8;
const EXPECTED_LENGTHS = [2, 2, 3, 4];

/**
 * URBANO Pulse Slice 001 (UG-CR-GATE-002). Pure TypeScript mirror of
 * pulse_forms_are_valid (0168) — used by InMemorySessionRepository so
 * the in-memory and real-Postgres implementations enforce the
 * identical layout contract; behavioral drift between them is a
 * genuine defect, not an acceptable implementation difference (mirrors
 * the same discipline already established for Math Duel's own
 * dual-implementation logic).
 *
 * Exactly 4 forms; cell counts exactly the multiset {2,2,3,4}; every
 * cell in 0..7 bounds; every form a single straight horizontal or
 * vertical run (contiguity/orientation/no-within-form-duplicate all
 * fall out of the same span-length-equals-cell-count check); no two
 * forms share a cell (overlap forbidden; adjacency/touching is
 * deliberately unrestricted).
 */
export function pulseFormsAreValid(forms: PulseForm[] | null | undefined): boolean {
  if (!Array.isArray(forms) || forms.length !== 4) {
    return false;
  }

  const allCells = new Set<string>();
  const lengths: number[] = [];

  for (const form of forms) {
    if (!Array.isArray(form.cells)) {
      return false;
    }
    const cellCount = form.cells.length;
    if (cellCount < 2 || cellCount > 4) {
      return false;
    }
    lengths.push(cellCount);

    for (const cell of form.cells) {
      if (
        !Number.isInteger(cell.row) ||
        !Number.isInteger(cell.col) ||
        cell.row < 0 ||
        cell.row > BOARD_SIZE - 1 ||
        cell.col < 0 ||
        cell.col > BOARD_SIZE - 1
      ) {
        return false;
      }
    }

    const rows = form.cells.map((c) => c.row);
    const cols = form.cells.map((c) => c.col);
    const minRow = Math.min(...rows);
    const maxRow = Math.max(...rows);
    const minCol = Math.min(...cols);
    const maxCol = Math.max(...cols);

    if (minRow === maxRow && minCol === maxCol && cellCount > 1) {
      return false; // every cell identical: not a line, hides a within-form duplicate
    } else if (minRow === maxRow) {
      if (maxCol - minCol + 1 !== cellCount) return false;
    } else if (minCol === maxCol) {
      if (maxRow - minRow + 1 !== cellCount) return false;
    } else {
      return false; // not a straight line
    }

    for (const cell of form.cells) {
      const key = `${cell.row},${cell.col}`;
      if (allCells.has(key)) {
        return false; // overlaps a cell already claimed by an earlier form
      }
      allCells.add(key);
    }
  }

  const sortedLengths = [...lengths].sort((a, b) => a - b);
  if (sortedLengths.length !== EXPECTED_LENGTHS.length || sortedLengths.some((v, i) => v !== EXPECTED_LENGTHS[i])) {
    return false;
  }

  return true;
}
