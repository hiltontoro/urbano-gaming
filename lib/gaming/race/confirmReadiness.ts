import type { RaceRepository } from "./db/raceRepository";
import type { ConfirmRaceReadinessResult } from "./types";
import { RaceEventNotFoundError, RaceScenarioNotFoundError } from "./types";
import { findScenario } from "../towers/scenarios";
import { initialStacks } from "../towers/moveLogic";

/**
 * CONFIRM_READINESS command handler. When both competitors become
 * ready, the repository's atomic RPC schedules the shared three-second
 * countdown and creates both official Towers attempts in the same
 * transaction. Towers' scenario catalog is code-owned data with no
 * database representation, so this handler computes initialStacks()
 * (Towers' own pure helper) and passes it through — never redefining
 * scenario content inside Race.
 */
export async function confirmReadiness(
  repo: RaceRepository,
  input: { raceEventId: string; competitorToken: string }
): Promise<ConfirmRaceReadinessResult> {
  const event = await repo.getEvent(input.raceEventId);
  if (!event) throw new RaceEventNotFoundError();

  const scenario = findScenario(event.scenarioId, event.scenarioVersion);
  if (!scenario) throw new RaceScenarioNotFoundError();

  return repo.confirmReadiness({
    raceEventId: input.raceEventId,
    competitorToken: input.competitorToken,
    initialStacks: initialStacks(scenario),
  });
}
