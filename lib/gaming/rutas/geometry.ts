/**
 * URBANO Rutas Slice 001 — pure movement/collision/exit geometry.
 *
 * No I/O, no persistence, no randomness — a deterministic function of
 * (scenario, currentPositions, move) => resulting positions | rejection.
 * Used identically by applyMove.ts (server-authoritative validation) and
 * by the client's live-clamp preview (same rules, different runtime) —
 * this module has zero knowledge of which side is calling it.
 *
 * Movement contract (Product-closed, see RUTAS_SLICE_001 gate history):
 * one committed move = one straight orthogonal segment; direction+distance,
 * never a target cell (a target cell doesn't exist for a piece exiting the
 * board). Intermediate steps are swept through, not rested at — a piece
 * may legally sweep through a cell it could not legally stop in, but only
 * ON-BOARD unoccupied cells or a matching gate crossing; it may never sweep
 * through a wall or another piece. Only the final step must be a valid
 * terminal state: fully on-board and collision-free, or fully off-board
 * through matching gates (CLEARED). Straddling the boundary at the final
 * step is always illegal — a piece is never left half-through a wall.
 */

import type {
  RutasCell,
  RutasDirection,
  RutasFootprint,
  RutasPiecePosition,
  RutasScenario,
} from "./types";

const DELTA: Record<RutasDirection, { dCol: number; dRow: number }> = {
  N: { dCol: 0, dRow: -1 },
  S: { dCol: 0, dRow: 1 },
  E: { dCol: 1, dRow: 0 },
  W: { dCol: -1, dRow: 0 },
};

export function footprintCells(anchor: RutasCell, footprint: RutasFootprint): RutasCell[] {
  const cells: RutasCell[] = [];
  for (let i = 0; i < footprint.width; i++) {
    for (let j = 0; j < footprint.height; j++) {
      cells.push({ col: anchor.col + i, row: anchor.row + j });
    }
  }
  return cells;
}

function isOnBoard(cell: RutasCell, scenario: RutasScenario): boolean {
  return cell.col >= 0 && cell.col < scenario.boardWidth && cell.row >= 0 && cell.row < scenario.boardHeight;
}

/**
 * The edge-cell position a cell crosses when it exits the board in the
 * given direction — e.g. an East exit's "position" is its row index, a
 * North exit's "position" is its col index. Only meaningful for a cell
 * that is exactly one step off-board in the direction of travel.
 */
function edgePositionFor(cell: RutasCell, direction: RutasDirection): number {
  return direction === "N" || direction === "S" ? cell.col : cell.row;
}

function hasMatchingGate(
  scenario: RutasScenario,
  direction: RutasDirection,
  position: number,
  identity: string
): boolean {
  return scenario.gates.some(
    (g) => g.edge === direction && g.position === position && g.identity === identity
  );
}

function occupiedCellKeys(
  scenario: RutasScenario,
  currentPositions: Record<string, RutasPiecePosition>,
  excludePieceId: string
): Set<string> {
  const occupied = new Set<string>();
  for (const piece of scenario.pieces) {
    if (piece.pieceId === excludePieceId) continue;
    const pos = currentPositions[piece.pieceId];
    if (pos === "CLEARED") continue;
    const cells = footprintCells(pos, piece.footprint);
    for (const c of cells) occupied.add(`${c.col},${c.row}`);
  }
  return occupied;
}

export interface MoveValidationResult {
  legal: boolean;
  reason?: string;
  resultingPositions?: Record<string, RutasPiecePosition>;
  cleared?: boolean;
}

/**
 * Validates and computes the result of one MOVE against the CURRENT
 * authoritative positions. Never mutates its inputs. The caller is
 * responsible for atomically committing resultingPositions only if this
 * returns legal: true — this function has no side effects of its own.
 */
export function validateAndApplyMove(
  scenario: RutasScenario,
  currentPositions: Record<string, RutasPiecePosition>,
  pieceId: string,
  direction: RutasDirection,
  distance: number
): MoveValidationResult {
  if (!Number.isInteger(distance) || distance < 1) {
    return { legal: false, reason: "distance must be a positive integer" };
  }
  // Sanity bound, not a gameplay rule: no legitimate move ever needs to
  // travel farther than the board's own span. Without this, a client
  // (malicious or merely buggy) submitting an enormous distance would
  // force the loop below to run that many synchronous iterations —
  // found during the Final Local Acceptance gate's client-tampering
  // pressure test (distance=99 was semantically harmless but exposed
  // the missing bound; a distance of 10^9 would not have been).
  const maxSaneDistance = scenario.boardWidth + scenario.boardHeight + 1;
  if (distance > maxSaneDistance) {
    return { legal: false, reason: "distance exceeds the board's own span" };
  }

  const piece = scenario.pieces.find((p) => p.pieceId === pieceId);
  if (!piece) {
    return { legal: false, reason: "piece not found in scenario" };
  }

  const currentPos = currentPositions[pieceId];
  if (currentPos === "CLEARED" || currentPos === undefined) {
    return { legal: false, reason: "piece is already cleared" };
  }

  const otherOccupied = occupiedCellKeys(scenario, currentPositions, pieceId);
  const { dCol, dRow } = DELTA[direction];

  let lastValidOnBoardAnchor: RutasCell | null = currentPos;
  let exitedFully = false;

  for (let step = 1; step <= distance; step++) {
    const anchor: RutasCell = { col: currentPos.col + dCol * step, row: currentPos.row + dRow * step };
    const cells = footprintCells(anchor, piece.footprint);

    const onBoardCells = cells.filter((c) => isOnBoard(c, scenario));
    const offBoardCells = cells.filter((c) => !isOnBoard(c, scenario));

    // Collision: every on-board cell of the stepped footprint must be free.
    for (const c of onBoardCells) {
      if (otherOccupied.has(`${c.col},${c.row}`)) {
        return { legal: false, reason: "blocked by another piece" };
      }
    }

    // Boundary crossing: every off-board cell must align with a matching gate.
    for (const c of offBoardCells) {
      const position = edgePositionFor(c, direction);
      if (!hasMatchingGate(scenario, direction, position, piece.identity)) {
        return { legal: false, reason: "blocked by the board edge or a mismatched gate" };
      }
    }

    if (offBoardCells.length === 0) {
      lastValidOnBoardAnchor = anchor;
      exitedFully = false;
    } else if (onBoardCells.length === 0) {
      exitedFully = true;
      break; // fully cleared — no later step can mean anything new
    } else if (step === distance) {
      // Straddling the boundary is only ever tolerated as an intermediate
      // sweep step, never as the final resting/exit state.
      return { legal: false, reason: "cannot rest straddling the board boundary" };
    }
  }

  if (exitedFully) {
    const resultingPositions = { ...currentPositions, [pieceId]: "CLEARED" as const };
    return { legal: true, resultingPositions, cleared: true };
  }

  const resultingPositions = { ...currentPositions, [pieceId]: lastValidOnBoardAnchor! };
  return { legal: true, resultingPositions, cleared: false };
}

/** All pieces flagged isRequired have been cleared. Non-required blockers may remain. */
export function isComplete(scenario: RutasScenario, positions: Record<string, RutasPiecePosition>): boolean {
  return scenario.pieces
    .filter((p) => p.isRequired)
    .every((p) => positions[p.pieceId] === "CLEARED");
}

export function initialPositions(scenario: RutasScenario): Record<string, RutasPiecePosition> {
  const positions: Record<string, RutasPiecePosition> = {};
  for (const piece of scenario.pieces) {
    positions[piece.pieceId] = { col: piece.startAnchor.col, row: piece.startAnchor.row };
  }
  return positions;
}

/**
 * The maximum legal distance a piece can travel in one direction from its
 * CURRENT position, used identically by the client for live drag-clamping
 * and by tests — not used by validateAndApplyMove itself, which always
 * validates the caller-submitted exact distance rather than trusting a
 * precomputed maximum.
 *
 * Deliberately does NOT stop at the first illegal distance: a distance
 * that lands a piece straddling the boundary mid-slide is illegal even
 * though a LARGER distance that completes the exit through a matching
 * gate is legal (e.g. distance 3 straddles, distance 4 clears) — legality
 * by distance is not monotonic, so every distance up to the board's own
 * span must be checked independently. Stops scanning once a distance
 * fully clears the piece, since no larger distance can mean anything new.
 */
export function maxLegalDistance(
  scenario: RutasScenario,
  currentPositions: Record<string, RutasPiecePosition>,
  pieceId: string,
  direction: RutasDirection
): number {
  let max = 0;
  const upperBound = scenario.boardWidth + scenario.boardHeight + 1;
  for (let d = 1; d <= upperBound; d++) {
    const result = validateAndApplyMove(scenario, currentPositions, pieceId, direction, d);
    if (result.legal) {
      max = d;
      if (result.cleared) break;
    }
  }
  return max;
}
