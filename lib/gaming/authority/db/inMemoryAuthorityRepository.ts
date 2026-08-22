import { randomUUID } from "crypto";
import type { AuthorityRepository } from "./authorityRepository";
import type { AuthorityGrantRecord, PlatformAuthorityClass } from "../types";
import {
  ReasonRequiredError,
  GovernanceAlreadyBootstrappedError,
  GovernanceAuthorityRequiredError,
  AuthorityGrantNotFoundError,
} from "../types";
import type { InMemoryAuditStore } from "../../audit/db/inMemoryAuditStore";

const PLATFORM_AUTHORITY_CLASSES: PlatformAuthorityClass[] = [
  "OPERATIONAL",
  "CONSEQUENTIAL_FINALIZER",
  "PRODUCT_GOVERNANCE",
];

function requireReason(reason: string): void {
  if (!reason || reason.trim().length === 0) throw new ReasonRequiredError();
}

/**
 * In-memory AuthorityRepository for behavioral tests — independently
 * re-implements the same invariants grant_platform_authority_atomically/
 * revoke_platform_authority_atomically/bootstrap_governance_authority_
 * atomically enforce (non-hierarchical, at-most-one-active-grant-per-
 * class, bootstrap-once, revocation preserves history), not a thin
 * passthrough.
 *
 * Takes the shared InMemoryAuditStore as a constructor dependency
 * rather than composing its own, mirroring the real schema: authority_
 * grants and admin_audit_events are two tables one Postgres transaction
 * writes to together, so their in-memory equivalents must be the same
 * shared instance wherever a real database would guarantee that.
 */
export class InMemoryAuthorityRepository implements AuthorityRepository {
  private grants = new Map<string, AuthorityGrantRecord>();

  constructor(private readonly auditStore: InMemoryAuditStore) {}

  private activeGrant(gamingMemberId: string, authorityClass: PlatformAuthorityClass): AuthorityGrantRecord | null {
    for (const grant of this.grants.values()) {
      if (
        grant.gamingMemberId === gamingMemberId &&
        grant.authorityClass === authorityClass &&
        grant.revokedAt === null
      ) {
        return grant;
      }
    }
    return null;
  }

  private mostRecentGrant(gamingMemberId: string, authorityClass: PlatformAuthorityClass): AuthorityGrantRecord | null {
    const matches = [...this.grants.values()]
      .filter((g) => g.gamingMemberId === gamingMemberId && g.authorityClass === authorityClass)
      .sort((a, b) => (a.grantedAt < b.grantedAt ? 1 : -1));
    return matches[0] ?? null;
  }

  async bootstrapGovernanceAuthority(gamingMemberId: string, reason: string) {
    requireReason(reason);

    const governanceExists = [...this.grants.values()].some(
      (g) => g.authorityClass === "PRODUCT_GOVERNANCE" && g.revokedAt === null
    );
    if (governanceExists) throw new GovernanceAlreadyBootstrappedError();

    const grantedAt = new Date().toISOString();
    const record: AuthorityGrantRecord = {
      authorityGrantId: randomUUID(),
      gamingMemberId,
      authorityClass: "PRODUCT_GOVERNANCE",
      grantedAt,
      grantedBy: null,
      revokedAt: null,
      revokedBy: null,
    };
    this.grants.set(record.authorityGrantId, record);

    this.auditStore.record({
      actionType: "BOOTSTRAP_GOVERNANCE_GRANT",
      actorKind: "GAMING_MEMBER",
      actorId: gamingMemberId,
      authorityClassUsed: null,
      targetType: "authority_grants",
      targetId: record.authorityGrantId,
      previousReference: null,
      resultingReference: { table: "authority_grants", id: record.authorityGrantId },
      outcome: "SUCCESS",
      reason,
    });

    return {
      authorityGrantId: record.authorityGrantId,
      gamingMemberId,
      authorityClass: record.authorityClass,
      grantedAt,
    };
  }

  async grantPlatformAuthority(
    grantingGamingMemberId: string,
    targetGamingMemberId: string,
    authorityClass: PlatformAuthorityClass,
    reason: string
  ) {
    requireReason(reason);

    const grantingIsGovernance = this.activeGrant(grantingGamingMemberId, "PRODUCT_GOVERNANCE") !== null;
    if (!grantingIsGovernance) throw new GovernanceAuthorityRequiredError();

    const existing = this.activeGrant(targetGamingMemberId, authorityClass);
    if (existing) {
      return {
        authorityGrantId: existing.authorityGrantId,
        gamingMemberId: targetGamingMemberId,
        authorityClass,
        grantedAt: existing.grantedAt,
        alreadyActive: true,
      };
    }

    const grantedAt = new Date().toISOString();
    const record: AuthorityGrantRecord = {
      authorityGrantId: randomUUID(),
      gamingMemberId: targetGamingMemberId,
      authorityClass,
      grantedAt,
      grantedBy: grantingGamingMemberId,
      revokedAt: null,
      revokedBy: null,
    };
    this.grants.set(record.authorityGrantId, record);

    this.auditStore.record({
      actionType: "GRANT_AUTHORITY",
      actorKind: "GAMING_MEMBER",
      actorId: grantingGamingMemberId,
      authorityClassUsed: "PRODUCT_GOVERNANCE",
      targetType: "authority_grants",
      targetId: record.authorityGrantId,
      previousReference: null,
      resultingReference: { table: "authority_grants", id: record.authorityGrantId },
      outcome: "SUCCESS",
      reason,
    });

    return {
      authorityGrantId: record.authorityGrantId,
      gamingMemberId: targetGamingMemberId,
      authorityClass,
      grantedAt,
      alreadyActive: false,
    };
  }

  async revokePlatformAuthority(
    revokingGamingMemberId: string,
    targetGamingMemberId: string,
    authorityClass: PlatformAuthorityClass,
    reason: string
  ) {
    requireReason(reason);

    const revokingIsGovernance = this.activeGrant(revokingGamingMemberId, "PRODUCT_GOVERNANCE") !== null;
    if (!revokingIsGovernance) throw new GovernanceAuthorityRequiredError();

    const grant = this.mostRecentGrant(targetGamingMemberId, authorityClass);
    if (!grant) throw new AuthorityGrantNotFoundError();

    if (grant.revokedAt !== null) {
      return {
        authorityGrantId: grant.authorityGrantId,
        gamingMemberId: targetGamingMemberId,
        authorityClass,
        revokedAt: grant.revokedAt,
        alreadyRevoked: true,
      };
    }

    const revokedAt = new Date().toISOString();
    const updated: AuthorityGrantRecord = { ...grant, revokedAt, revokedBy: revokingGamingMemberId };
    this.grants.set(grant.authorityGrantId, updated);

    this.auditStore.record({
      actionType: "REVOKE_AUTHORITY",
      actorKind: "GAMING_MEMBER",
      actorId: revokingGamingMemberId,
      authorityClassUsed: "PRODUCT_GOVERNANCE",
      targetType: "authority_grants",
      targetId: grant.authorityGrantId,
      previousReference: { table: "authority_grants", id: grant.authorityGrantId },
      resultingReference: null,
      outcome: "SUCCESS",
      reason,
    });

    return {
      authorityGrantId: grant.authorityGrantId,
      gamingMemberId: targetGamingMemberId,
      authorityClass,
      revokedAt,
      alreadyRevoked: false,
    };
  }

  async hasActiveAuthority(gamingMemberId: string, authorityClass: PlatformAuthorityClass): Promise<boolean> {
    return this.activeGrant(gamingMemberId, authorityClass) !== null;
  }

  /** Test-only seam: grants authority without going through bootstrap/grant. */
  seedAuthority(gamingMemberId: string, authorityClass: PlatformAuthorityClass): void {
    if (this.activeGrant(gamingMemberId, authorityClass)) return;
    const record: AuthorityGrantRecord = {
      authorityGrantId: randomUUID(),
      gamingMemberId,
      authorityClass,
      grantedAt: new Date().toISOString(),
      grantedBy: null,
      revokedAt: null,
      revokedBy: null,
    };
    this.grants.set(record.authorityGrantId, record);
  }

  /** Test-only seam: revokes authority without going through revokePlatformAuthority. */
  seedRevokeAuthority(gamingMemberId: string, authorityClass: PlatformAuthorityClass): void {
    const grant = this.activeGrant(gamingMemberId, authorityClass);
    if (!grant) return;
    this.grants.set(grant.authorityGrantId, {
      ...grant,
      revokedAt: new Date().toISOString(),
      revokedBy: null,
    });
  }

  async listActiveAuthorityClasses(gamingMemberId: string): Promise<PlatformAuthorityClass[]> {
    return PLATFORM_AUTHORITY_CLASSES.filter((c) => this.activeGrant(gamingMemberId, c) !== null);
  }
}
