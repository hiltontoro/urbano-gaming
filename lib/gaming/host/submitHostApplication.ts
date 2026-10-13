import type { HostRepository } from "./db/hostRepository";
import type { SubmitHostApplicationResult } from "./types";
import { validateHostApplication } from "./validateHostApplication";

/**
 * SUBMIT_HOST_APPLICATION. The applicant is always the verified caller; the
 * submission is validated and normalized here first, and the database then
 * re-validates and enforces one live application per member.
 */
export async function submitHostApplication(
  repo: HostRepository,
  gamingMemberId: string,
  rawInput: unknown
): Promise<SubmitHostApplicationResult> {
  const input = validateHostApplication(rawInput);
  return repo.submitApplication(gamingMemberId, input);
}
