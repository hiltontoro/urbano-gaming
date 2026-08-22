import type { PlatformAuthorityClass } from "../types";

/**
 * Platform authority persistence boundary — its own interface, parallel
 * to lib/gaming/predictions/db/predictionsRepository.ts, never merged
 * with it. Predictions (and every other domain) consumes this; it does
 * not own it.
 *
 * bootstrapGovernanceAuthority and grantPlatformAuthority/
 * revokePlatformAuthority are never called from any HTTP route in this
 * Slice — invoked directly by tooling/tests, exactly like gaming_admins'
 * own current seeding posture.
 */
export interface AuthorityRepository {
  bootstrapGovernanceAuthority(
    gamingMemberId: string,
    reason: string
  ): Promise<{
    authorityGrantId: string;
    gamingMemberId: string;
    authorityClass: PlatformAuthorityClass;
    grantedAt: string;
  }>;

  grantPlatformAuthority(
    grantingGamingMemberId: string,
    targetGamingMemberId: string,
    authorityClass: PlatformAuthorityClass,
    reason: string
  ): Promise<{
    authorityGrantId: string;
    gamingMemberId: string;
    authorityClass: PlatformAuthorityClass;
    grantedAt: string;
    alreadyActive: boolean;
  }>;

  revokePlatformAuthority(
    revokingGamingMemberId: string,
    targetGamingMemberId: string,
    authorityClass: PlatformAuthorityClass,
    reason: string
  ): Promise<{
    authorityGrantId: string;
    gamingMemberId: string;
    authorityClass: PlatformAuthorityClass;
    revokedAt: string;
    alreadyRevoked: boolean;
  }>;

  /** Fresh-every-call, never cached — mirrors isGamingAdmin's own convention. */
  hasActiveAuthority(
    gamingMemberId: string,
    authorityClass: PlatformAuthorityClass
  ): Promise<boolean>;

  listActiveAuthorityClasses(gamingMemberId: string): Promise<PlatformAuthorityClass[]>;
}
