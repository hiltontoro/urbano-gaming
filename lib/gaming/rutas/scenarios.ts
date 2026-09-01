/**
 * URBANO Rutas Slice 001 — curated scenario catalog.
 *
 * Code-owned, hand-authored, deliberately tiny — three scenarios, each
 * earning its place rather than one mechanism per scenario (that
 * granular isolation was appropriate during design pressure-testing, not
 * for what actually ships). No player authoring, no procedural
 * generation, no runtime or offline solver in this Slice — with only
 * three small scenarios a human author can trivially hand-verify
 * solvability. Original URBANO expression throughout: no names, palette,
 * board sizes, or piece styling borrowed from any reference product.
 */

import type { RutasScenario } from "./types";

export const RUTAS_SCENARIOS: RutasScenario[] = [
  // Scenario 1 — core proof. Free partial-distance movement, multiple
  // straight segments, obstruction, a mismatched exit, at least two
  // valid move orderings to the same solution, and completion.
  {
    scenarioId: "rutas-001",
    scenarioVersion: 1,
    boardWidth: 5,
    boardHeight: 5,
    pieces: [
      {
        pieceId: "r1",
        footprint: { width: 1, height: 1 },
        startAnchor: { col: 2, row: 2 },
        identity: "RUBY",
        isRequired: true,
      },
      {
        // Blocker: no gate anywhere matches AMBER in this scenario, so
        // it can never clear — purely an obstruction, never required.
        pieceId: "b1",
        footprint: { width: 1, height: 1 },
        startAnchor: { col: 0, row: 2 },
        identity: "AMBER",
        isRequired: false,
      },
    ],
    gates: [
      // Correct exit for r1: East edge, row 2. Reachable at distance 3
      // (partial rests are legal at distance 1 and 2 first).
      { gateId: "g1", edge: "E", position: 2, identity: "RUBY" },
      // Deliberately mismatched: South edge, col 2 — reachable
      // geometrically but wrong identity, must reject the exit.
      { gateId: "g2", edge: "S", position: 2, identity: "SAPPHIRE" },
    ],
  },

  // Scenario 2 — footprint proof. A 1x2 required piece must sweep two
  // cells at once and exit through a matching two-position gate span.
  {
    scenarioId: "rutas-002",
    scenarioVersion: 1,
    boardWidth: 4,
    boardHeight: 4,
    pieces: [
      {
        pieceId: "r2",
        footprint: { width: 1, height: 2 },
        startAnchor: { col: 1, row: 1 }, // occupies (1,1) and (1,2)
        identity: "EMERALD",
        isRequired: true,
      },
    ],
    gates: [
      // Both edge-cell positions the footprint crosses on exit must
      // independently match — this is the whole point of the scenario.
      { gateId: "g1", edge: "E", position: 1, identity: "EMERALD" },
      { gateId: "g2", edge: "E", position: 2, identity: "EMERALD" },
    ],
  },

  // Scenario 3 — accessibility proof. Two identities chosen to be
  // difficult to tell apart by color alone (amber/topaz), routed to
  // visually distinct gates in opposite directions — the game must stay
  // playable purely from shape/label, not hue.
  {
    scenarioId: "rutas-003",
    scenarioVersion: 1,
    boardWidth: 5,
    boardHeight: 5,
    pieces: [
      {
        pieceId: "r3a",
        footprint: { width: 1, height: 1 },
        startAnchor: { col: 1, row: 2 },
        identity: "AMBER",
        isRequired: true,
      },
      {
        pieceId: "r3b",
        footprint: { width: 1, height: 1 },
        startAnchor: { col: 3, row: 2 },
        identity: "TOPAZ",
        isRequired: true,
      },
    ],
    gates: [
      { gateId: "g1", edge: "W", position: 2, identity: "AMBER" },
      { gateId: "g2", edge: "E", position: 2, identity: "TOPAZ" },
    ],
  },
];

export function findScenario(scenarioId: string, scenarioVersion: number): RutasScenario | null {
  return (
    RUTAS_SCENARIOS.find(
      (s) => s.scenarioId === scenarioId && s.scenarioVersion === scenarioVersion
    ) ?? null
  );
}

export function latestScenarioVersion(scenarioId: string): RutasScenario | null {
  const versions = RUTAS_SCENARIOS.filter((s) => s.scenarioId === scenarioId).sort(
    (a, b) => b.scenarioVersion - a.scenarioVersion
  );
  return versions[0] ?? null;
}
