import type { AuthorityRepository } from "./db/authorityRepository";

/**
 * BOOTSTRAP_GOVERNANCE_GRANT — the one-time root bootstrap. Never called
 * from any HTTP route; invoked directly by tooling. All guard logic
 * (already-bootstrapped rejection, reason requirement) lives inside
 * bootstrap_governance_authority_atomically itself — this wrapper
 * exists only for the same reason every other command in this codebase
 * gets one.
 */
export async function bootstrapGovernanceAuthority(
  repo: AuthorityRepository,
  gamingMemberId: string,
  reason: string
) {
  return repo.bootstrapGovernanceAuthority(gamingMemberId, reason);
}
