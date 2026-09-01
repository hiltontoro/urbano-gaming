import { randomUUID } from "crypto";
import type { TowersRepository } from "./db/towersRepository";
import type { StartTowersAttemptResult } from "./types";
import { TowersScenarioNotFoundError } from "./types";
import { findScenario } from "./scenarios";
import { initialStacks } from "./moveLogic";

/**
 * START_ATTEMPT command handler. No collision/uniqueness concern exists
 * for creating a fresh attempt — a plain insert is safe and sufficient;
 * no retry loop, no atomic RPC needed. Scenario content is read from the
 * code-owned catalog, never from the database.
 */
export async function startAttempt(
  repo: TowersRepository,
  input: { scenarioId: string; scenarioVersion: number }
): Promise<StartTowersAttemptResult> {
  const scenario = findScenario(input.scenarioId, input.scenarioVersion);
  if (!scenario) {
    throw new TowersScenarioNotFoundError();
  }

  const attemptId = randomUUID();
  const record = await repo.createAttempt({
    attemptId,
    scenarioId: scenario.scenarioId,
    scenarioVersion: scenario.scenarioVersion,
    initialStacks: initialStacks(scenario),
    restartOfAttemptId: null,
  });

  return { attempt: { ...record, actionHistory: [] } };
}
