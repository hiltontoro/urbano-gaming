import { randomUUID } from "crypto";
import type { RutasRepository } from "./db/rutasRepository";
import type { RestartRutasAttemptResult } from "./types";
import { RutasAttemptNotFoundError, RutasScenarioNotFoundError } from "./types";
import { findScenario } from "./scenarios";
import { initialPositions } from "./geometry";

/**
 * RESTART_ATTEMPT command handler. Creates a NEW attempt rather than
 * resetting the old one in place — the old attempt is finalized
 * ABANDONED only if it was still IN_PROGRESS; a COMPLETE attempt stays
 * COMPLETE forever (restarting after a win is "play again," not
 * un-winning). Full evidence is preserved on both sides — see
 * rutasRepository.ts's commitRestart for the atomic linkage.
 */
export async function restartAttempt(
  repo: RutasRepository,
  input: { attemptId: string; idempotencyKey: string }
): Promise<RestartRutasAttemptResult> {
  const oldAttempt = await repo.getAttempt(input.attemptId);
  if (!oldAttempt) {
    throw new RutasAttemptNotFoundError();
  }

  const scenario = findScenario(oldAttempt.scenarioId, oldAttempt.scenarioVersion);
  if (!scenario) {
    throw new RutasScenarioNotFoundError();
  }

  const newAttemptId = randomUUID();
  const { newAttempt, abandonedAttemptId, alreadyApplied } = await repo.commitRestart({
    oldAttemptId: input.attemptId,
    newAttemptId,
    scenarioId: scenario.scenarioId,
    scenarioVersion: scenario.scenarioVersion,
    initialPositions: initialPositions(scenario),
    idempotencyKey: input.idempotencyKey,
  });

  return {
    newAttempt: { ...newAttempt, actionHistory: [] },
    abandonedAttemptId,
    alreadyRestarted: alreadyApplied,
  };
}
