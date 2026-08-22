import type { AuthorityRepository } from "./db/authorityRepository";
import type { PlatformAuthorityClass } from "./types";

/**
 * REVOKE_AUTHORITY — Governance-only. Never called from any HTTP route
 * in this Slice. All guard logic (Governance-actor requirement, reason
 * requirement, idempotent already-revoked return, not-found rejection)
 * lives inside revoke_platform_authority_atomically itself.
 */
export async function revokePlatformAuthority(
  repo: AuthorityRepository,
  revokingGamingMemberId: string,
  targetGamingMemberId: string,
  authorityClass: PlatformAuthorityClass,
  reason: string
) {
  return repo.revokePlatformAuthority(revokingGamingMemberId, targetGamingMemberId, authorityClass, reason);
}
