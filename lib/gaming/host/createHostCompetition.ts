import type { HostRepository } from "./db/hostRepository";
import type { CreateHostCompetitionResult } from "./types";
import { InvalidHostCompetitionError } from "./types";
import { generatePublicCode } from "../competitions/publicCode";

/**
 * CREATE_HOST_COMPETITION — the approved host creates their ONE pilot. The
 * capability is consumed in the same transaction that creates the competition,
 * and the activity key is fixed to the only supported value by the database.
 * The opaque public code is generated here, never derived from database output
 * (the same rule createCompetition follows).
 */
export async function createHostCompetition(
  repo: HostRepository,
  hostGamingMemberId: string,
  name: unknown,
  activityKey: unknown = "SOCCER_5V5"
): Promise<CreateHostCompetitionResult> {
  if (
    typeof name !== "string" ||
    name.trim().length < 3 ||
    name.trim().length > 80 ||
    /[\u0000-\u001F\u007F]/.test(name.trim())
  ) {
    throw new InvalidHostCompetitionError("name");
  }
  if (typeof activityKey !== "string") throw new InvalidHostCompetitionError("activityKey");
  return repo.createHostCompetition(hostGamingMemberId, name.trim(), activityKey, generatePublicCode());
}
