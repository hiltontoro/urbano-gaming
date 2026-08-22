/**
 * Admin Control Plane A0 — Authority & Audit Foundation.
 *
 * The three canonical, non-hierarchical platform authority classes
 * (Product/Authority_and_Audit_Foundation.md, ADR-037). Holding one
 * never implies another — CONSEQUENTIAL_FINALIZER does not inherit
 * OPERATIONAL, and PRODUCT_GOVERNANCE does not inherit either.
 */
export type PlatformAuthorityClass =
  | "OPERATIONAL"
  | "CONSEQUENTIAL_FINALIZER"
  | "PRODUCT_GOVERNANCE";

export interface AuthorityGrantRecord {
  authorityGrantId: string;
  gamingMemberId: string;
  authorityClass: PlatformAuthorityClass;
  grantedAt: string;
  grantedBy: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
}

export class InvalidAuthorityClassError extends Error {
  constructor() {
    super("The specified authority class is not a recognized platform authority class.");
  }
}

/** Shared by bootstrap, grant, revoke, and Result correction. */
export class ReasonRequiredError extends Error {
  constructor() {
    super("This action requires a reason.");
  }
}

export class GamingMemberNotFoundError extends Error {
  constructor() {
    super("No such Gaming Member exists.");
  }
}

export class GovernanceAlreadyBootstrappedError extends Error {
  constructor() {
    super("Platform Governance authority has already been established.");
  }
}

export class GovernanceAuthorityRequiredError extends Error {
  constructor() {
    super("Only an active Product Governance actor may perform this action.");
  }
}

export class AuthorityGrantNotFoundError extends Error {
  constructor() {
    super("No matching authority grant exists for this Gaming Member.");
  }
}

/**
 * Thrown by requirePlatformAuthority/requireAnyPlatformAuthority, and
 * translated from the RPC layer's own CONSEQUENTIAL_FINALIZER_AUTHORITY_
 * REQUIRED — the RPC's check is the authoritative enforcement boundary;
 * this class is what both paths surface as.
 */
export class InsufficientPlatformAuthorityError extends Error {
  constructor(requiredClass?: PlatformAuthorityClass) {
    super(
      requiredClass
        ? `This action requires ${requiredClass} authority.`
        : "Insufficient platform authority."
    );
  }
}
