import { randomUUID } from "crypto";
import type { TowersRepository } from "./db/towersRepository";
import type { RestartTowersAttemptResult } from "./types";
import { TowersAttemptNotFoundError, TowersScenarioNotFoundError } from "./types";
import { findScenario } from "./scenarios";
import { initialStacks } from "./moveLogic";

/**
 * RESTART_ATTEMPT command handler. Creates a NEW attempt rather than
 * resetting the old one in place — the old attempt is finalized
 * ABANDONED only if it was still IN_PROGRESS; a COMPLETE attempt stays
 * COMPLETE forever (restarting after a win is "play again," not
 * un-winning). Full evidence is preserved on both sides — see
 * towersRepository.ts's commitRestart for the atomic linkage.
 */
export async function restartAttempt(
  repo: TowersRepository,
  input: { attemptId: string; idempotencyKey: string }
): Promise<RestartTowersAttemptResult> {
  const oldAttempt = await repo.getAttempt(input.attemptId);
  if (!oldAttempt) {
    throw new TowersAttemptNotFoundError();
  }

  const scenario = findScenario(oldAttempt.scenarioId, oldAttempt.scenarioVersion);
  if (!scenario) {
    throw new TowersScenarioNotFoundError();
  }

  const newAttemptId = randomUUID();
  const { newAttempt, abandonedAttemptId, alreadyApplied } = await repo.commitRestart({
    oldAttemptId: input.attemptId,
    newAttemptId,
    scenarioId: scenario.scenarioId,
    scenarioVersion: scenario.scenarioVersion,
    initialStacks: initialStacks(scenario),
    idempotencyKey: input.idempotencyKey,
  });

  return {
    newAttempt: { ...newAttempt, actionHistory: [] },
    abandonedAttemptId,
    alreadyRestarted: alreadyApplied,
  };
}
