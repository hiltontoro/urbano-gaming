import type { RaceRepository } from "./db/raceRepository";
import type { CreateRaceEventResult } from "./types";
import { RaceScenarioNotFoundError } from "./types";
import { findScenario } from "../towers/scenarios";

/**
 * CREATE_EVENT command handler. Ledger-backed (UG-CR-GATE-025
 * Correction A): the client supplies its own idempotencyKey, and a
 * lost-response retry with the same key returns the SAME event and
 * organizer credential rather than creating a second event — see
 * create_race_event_atomically in
 * supabase/migrations/20260904085843_create_race_functions.sql.
 */
export async function createEvent(
  repo: RaceRepository,
  input: { idempotencyKey: string; scenarioId: string; scenarioVersion: number }
): Promise<CreateRaceEventResult> {
  const scenario = findScenario(input.scenarioId, input.scenarioVersion);
  if (!scenario) {
    throw new RaceScenarioNotFoundError();
  }

  return repo.createEvent({
    idempotencyKey: input.idempotencyKey,
    scenarioId: scenario.scenarioId,
    scenarioVersion: scenario.scenarioVersion,
  });
}
