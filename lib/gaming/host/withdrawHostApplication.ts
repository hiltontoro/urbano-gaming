import type { HostRepository } from "./db/hostRepository";
import type { WithdrawHostApplicationResult } from "./types";
import { HostApplicationNotFoundError } from "./types";
import { isWellFormedPublicCode } from "./publicCodeShape";

/** WITHDRAW_HOST_APPLICATION — the applicant, for their own pending application only. */
export async function withdrawHostApplication(
  repo: HostRepository,
  gamingMemberId: string,
  publicCode: unknown
): Promise<WithdrawHostApplicationResult> {
  if (!isWellFormedPublicCode(publicCode)) throw new HostApplicationNotFoundError();
  return repo.withdrawApplication(gamingMemberId, publicCode);
}
