import type { HostRepository } from "./db/hostRepository";
import type { HostPhase, HostStatusRecord, HostStatusView } from "./types";

/**
 * Maps an application and its capability to the plain-language phase the
 * applicant is in. This only describes state; it never authorizes anything.
 */
export function phaseOf(record: HostStatusRecord | null): HostPhase {
  if (!record) return "NOT_APPLIED";
  switch (record.state) {
    case "PENDING":
      return "UNDER_REVIEW";
    case "REJECTED":
      return "NOT_APPROVED";
    case "WITHDRAWN":
      return "WITHDRAWN";
    case "APPROVED":
      if (record.capabilityState === "REVOKED") return "ACCESS_REVOKED";
      if (record.capabilityState === "CONSUMED") return "PILOT_CREATED";
      return "APPROVED_READY";
  }
}

/** GET_HOST_STATUS — the caller's own application only; the repository is keyed by the verified caller. */
export async function getHostStatus(repo: HostRepository, gamingMemberId: string): Promise<HostStatusView> {
  const application = await repo.getStatus(gamingMemberId);
  return { phase: phaseOf(application), application };
}
