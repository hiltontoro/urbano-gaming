import type { AuthorityRepository } from "./db/authorityRepository";
import type { PlatformAuthorityClass } from "./types";

/**
 * GRANT_AUTHORITY — Governance-only, after bootstrap. Never called from
 * any HTTP route in this Slice. All guard logic (Governance-actor
 * requirement, reason requirement, idempotent already-active return)
 * lives inside grant_platform_authority_atomically itself.
 */
export async function grantPlatformAuthority(
  repo: AuthorityRepository,
  grantingGamingMemberId: string,
  targetGamingMemberId: string,
  authorityClass: PlatformAuthorityClass,
  reason: string
) {
  return repo.grantPlatformAuthority(grantingGamingMemberId, targetGamingMemberId, authorityClass, reason);
}
