import type { CompetitionsRepository } from "./db/competitionsRepository";
import type { StartCompetitionResult } from "./types";
import { generatePublicCode } from "./publicCode";

/**
 * CREATE_COMPETITION. Requires the caller to hold active platform
 * OPERATIONAL authority — enforced inside the atomic RPC, not here. The
 * opaque public_code (UG-CR-GATE-081 Phase 3A) is generated here, once,
 * before the repository call — never derived from the real id the RPC
 * assigns, so a public_code's entropy never depends on anything the
 * database produces.
 */
export async function createCompetition(
  repo: CompetitionsRepository,
  organizerGamingMemberId: string,
  name: string,
  activityKey: string
): Promise<StartCompetitionResult> {
  return repo.createCompetition(organizerGamingMemberId, name, activityKey, generatePublicCode());
}
