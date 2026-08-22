import type { AuthorityRepository } from "./db/authorityRepository";
import type { PlatformAuthorityClass } from "./types";
import { InsufficientPlatformAuthorityError } from "./types";

/**
 * Does this authenticated Gaming Member possess authority class X?
 * Fresh per call — no caching, mirroring isGamingAdmin's own convention
 * (see gaming_admins' own migration comment for why). Never implies
 * hierarchy: checking CONSEQUENTIAL_FINALIZER never passes for a member
 * holding only PRODUCT_GOVERNANCE.
 */
export async function requirePlatformAuthority(
  repo: AuthorityRepository,
  gamingMemberId: string,
  authorityClass: PlatformAuthorityClass
): Promise<void> {
  const has = await repo.hasActiveAuthority(gamingMemberId, authorityClass);
  if (!has) throw new InsufficientPlatformAuthorityError(authorityClass);
}

/** For the rare action legitimately performable by more than one class. */
export async function requireAnyPlatformAuthority(
  repo: AuthorityRepository,
  gamingMemberId: string,
  authorityClasses: PlatformAuthorityClass[]
): Promise<void> {
  for (const authorityClass of authorityClasses) {
    if (await repo.hasActiveAuthority(gamingMemberId, authorityClass)) return;
  }
  throw new InsufficientPlatformAuthorityError();
}
