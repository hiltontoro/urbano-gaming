/**
 * URBANO Towers Slice 001 — curated scenario catalog.
 *
 * Code-owned, hand-authored, deliberately tiny — three scenarios, each
 * earning its place as a proof of a distinct mechanic property rather
 * than a difficulty ladder, mirroring RUTAS_SCENARIOS' own convention.
 * No player authoring, no procedural generation, no solver — every
 * scenario's solvability was hand-verified during authoring (see each
 * scenario's own comment). All three use exactly 3 towers per the
 * accepted Slice 001 boundary; towerIds/initialStacks are still fully
 * scenario-authored data, not hardcoded assumptions in the rules engine.
 */

import type { TowersScenario } from "./types";

const TOWER_IDS = ["T1", "T2", "T3"];

export const TOWERS_SCENARIOS: TowersScenario[] = [
  // Scenario 1 — classic minimal. Full 3-piece stack starts on T1;
  // destination T3. Proves basic legal transfer, illegal
  // larger-on-smaller rejection, multi-step sequencing, and completion.
  // Closed-form minimum for the classic single-origin case: 2^3 - 1 = 7.
  {
    scenarioId: "towers-001",
    scenarioVersion: 1,
    towerIds: TOWER_IDS,
    initialStacks: {
      T1: [3, 2, 1],
      T2: [],
      T3: [],
    },
    destinationTowerId: "T3",
    knownMinimumMoves: 7,
  },

  // Scenario 2 — classic deeper. Full 4-piece stack starts on T1;
  // destination T3. Proves genuine multi-step planning pressure exists
  // beyond the trivial 3-piece case, while staying practical to prove by
  // hand in browser operational simulation. Closed-form minimum:
  // 2^4 - 1 = 15.
  {
    scenarioId: "towers-002",
    scenarioVersion: 1,
    towerIds: TOWER_IDS,
    initialStacks: {
      T1: [4, 3, 2, 1],
      T2: [],
      T3: [],
    },
    destinationTowerId: "T3",
    knownMinimumMoves: 15,
  },

  // Scenario 3 — split-start proof. Pieces begin legally distributed
  // across TWO non-destination towers (T1=[3,1], T2=[2]) rather than a
  // single origin pile — proves initialStacks is genuinely authored data
  // and that completion detection makes no single-origin assumption.
  // Hand-verified solvable in 5 moves (not claimed optimal, so
  // knownMinimumMoves is null rather than guessed):
  //   T1 top(1)->T2   => T1=[3]    T2=[2,1] T3=[]
  //   T1 top(3)->T3   => T1=[]     T2=[2,1] T3=[3]
  //   T2 top(1)->T1   => T1=[1]    T2=[2]   T3=[3]
  //   T2 top(2)->T3   => T1=[1]    T2=[]    T3=[3,2]
  //   T1 top(1)->T3   => T1=[]     T2=[]    T3=[3,2,1]  (complete)
  {
    scenarioId: "towers-003",
    scenarioVersion: 1,
    towerIds: TOWER_IDS,
    initialStacks: {
      T1: [3, 1],
      T2: [2],
      T3: [],
    },
    destinationTowerId: "T3",
    knownMinimumMoves: null,
  },
];

export function findScenario(scenarioId: string, scenarioVersion: number): TowersScenario | null {
  return (
    TOWERS_SCENARIOS.find(
      (s) => s.scenarioId === scenarioId && s.scenarioVersion === scenarioVersion
    ) ?? null
  );
}

export function latestScenarioVersion(scenarioId: string): TowersScenario | null {
  const versions = TOWERS_SCENARIOS.filter((s) => s.scenarioId === scenarioId).sort(
    (a, b) => b.scenarioVersion - a.scenarioVersion
  );
  return versions[0] ?? null;
}
