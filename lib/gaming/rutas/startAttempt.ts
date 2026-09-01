import { randomUUID } from "crypto";
import type { RutasRepository } from "./db/rutasRepository";
import type { StartRutasAttemptResult } from "./types";
import { RutasScenarioNotFoundError } from "./types";
import { findScenario } from "./scenarios";
import { initialPositions } from "./geometry";

/**
 * START_ATTEMPT command handler. No collision/uniqueness concern exists
 * for creating a fresh attempt (unlike Poker's room-code allocation) — a
 * plain insert is safe and sufficient; no retry loop, no atomic RPC
 * needed. Scenario geometry is read from the code-owned catalog, never
 * from the database.
 */
export async function startAttempt(
  repo: RutasRepository,
  input: { scenarioId: string; scenarioVersion: number }
): Promise<StartRutasAttemptResult> {
  const scenario = findScenario(input.scenarioId, input.scenarioVersion);
  if (!scenario) {
    throw new RutasScenarioNotFoundError();
  }

  const attemptId = randomUUID();
  const record = await repo.createAttempt({
    attemptId,
    scenarioId: scenario.scenarioId,
    scenarioVersion: scenario.scenarioVersion,
    initialPositions: initialPositions(scenario),
    restartOfAttemptId: null,
  });

  return { attempt: { ...record, actionHistory: [] } };
}
