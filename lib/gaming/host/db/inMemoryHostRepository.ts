import type { HostRepository } from "./hostRepository";
import type {
  HostApplicationInput,
  HostApplicationState,
  HostCapabilityState,
  HostDecision,
  HostReviewView,
  HostStatusRecord,
  HostReviewRecord,
  SubmitHostApplicationResult,
  WithdrawHostApplicationResult,
  DecideHostApplicationResult,
  RevokeHostCapabilityResult,
  CreateHostCompetitionResult,
} from "../types";
import {
  HostApplicationAlreadyActiveError,
  HostApplicationNotFoundError,
  HostApplicationNotPendingError,
  HostApplicationAlreadyDecidedError,
  HostSelfReviewForbiddenError,
  HostCapabilityNotFoundError,
  HostCapabilityRequiredError,
  HostCapabilityAlreadyConsumedError,
  HostCapabilityRevokedError,
  HostReasonRequiredError,
  HostReviewerAuthorityRequiredError,
  InvalidHostApplicationError,
  InvalidHostCompetitionError,
} from "../types";
import { validateHostApplication } from "../validateHostApplication";
import { generatePublicCode } from "../../competitions/publicCode";

interface AppRow extends HostApplicationInput {
  id: string;
  publicCode: string;
  memberId: string;
  state: HostApplicationState;
  submittedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  withdrawnAt: string | null;
}

interface CapRow {
  id: string;
  applicationId: string;
  memberId: string;
  state: HostCapabilityState;
  competitionId: string | null;
  grantedAt: string;
  consumedAt: string | null;
  revokedAt: string | null;
  revokedBy: string | null;
  revokeReason: string | null;
}

interface CompetitionRow {
  id: string;
  name: string;
  publicCode: string;
  organizerMemberId: string;
  createdAt: string;
}

export interface InMemoryHostAuditEvent {
  actionType: string;
  actorMemberId: string;
  authorityClassUsed: string | null;
  targetType: string;
  targetId: string;
  outcome: "SUCCESS";
  reason: string | null;
  occurredAt: string;
}

/**
 * In-memory HostRepository for domain tests. Like the authority in-memory
 * repository it re-implements the SQL invariants rather than passing through,
 * so the command layer is tested against the same rules the database enforces:
 * one live application per member, a single terminal decision, one capability
 * per approval, one competition per capability, revocation that preserves
 * history, and a self-review ban. The Postgres contract suite is the proof of
 * the real thing; this class is only the fast, credential-free stand-in.
 *
 * Test seams (not part of HostRepository): seedMember, seedGovernance,
 * assertOrganizerAccess, and the read-only audit/inspection accessors.
 */
export class InMemoryHostRepository implements HostRepository {
  private members = new Map<string, string>();
  private governance = new Set<string>();
  private applications: AppRow[] = [];
  private capabilities: CapRow[] = [];
  private competitions: CompetitionRow[] = [];
  readonly auditEvents: InMemoryHostAuditEvent[] = [];
  private counter = 0;
  /** Makes the next createHostCompetition fail after validation, to prove a failed creation consumes nothing. */
  failNextCreation = false;

  seedMember(memberId: string, displayName: string): void {
    this.members.set(memberId, displayName);
  }

  seedGovernance(memberId: string): void {
    this.governance.add(memberId);
  }

  /** Mirror of assert_competition_not_host_revoked: organizer actions on a revoked host's competition are refused. */
  assertOrganizerAccess(competitionId: string): void {
    const cap = this.capabilities.find((c) => c.competitionId === competitionId);
    if (cap && cap.state === "REVOKED") throw new Error("HOST_ACCESS_REVOKED");
  }

  competitionCount(): number {
    return this.competitions.length;
  }

  capabilityStateFor(memberId: string): HostCapabilityState | null {
    const caps = this.capabilities.filter((c) => c.memberId === memberId);
    return caps.length ? caps[caps.length - 1].state : null;
  }

  capabilityCount(): number {
    return this.capabilities.length;
  }

  applicationCount(): number {
    return this.applications.length;
  }

  private now(): string {
    // Strictly increasing, so ordering assertions are deterministic.
    return new Date(Date.UTC(2026, 9, 7, 12, 0, this.counter++)).toISOString();
  }

  private id(prefix: string): string {
    return `${prefix}-${this.counter++}`;
  }

  private audit(
    actionType: string,
    actor: string,
    authorityClassUsed: string | null,
    targetType: string,
    targetId: string,
    reason: string | null,
    at: string
  ): void {
    this.auditEvents.push({ actionType, actorMemberId: actor, authorityClassUsed, targetType, targetId, outcome: "SUCCESS", reason, occurredAt: at });
  }

  private requireGovernance(memberId: string): void {
    if (!this.governance.has(memberId)) throw new HostReviewerAuthorityRequiredError();
  }

  async submitApplication(gamingMemberId: string, input: HostApplicationInput): Promise<SubmitHostApplicationResult> {
    // The database re-validates what the command layer already validated.
    const clean = validateHostApplication({ ...input });
    if (!this.members.has(gamingMemberId)) throw new InvalidHostApplicationError("application");
    if (this.applications.some((a) => a.memberId === gamingMemberId && (a.state === "PENDING" || a.state === "APPROVED"))) {
      throw new HostApplicationAlreadyActiveError();
    }
    const at = this.now();
    const row: AppRow = {
      ...clean,
      id: this.id("app"),
      publicCode: generatePublicCode(),
      memberId: gamingMemberId,
      state: "PENDING",
      submittedAt: at,
      decidedBy: null,
      decidedAt: null,
      decisionReason: null,
      withdrawnAt: null,
    };
    this.applications.push(row);
    this.audit("HOST_APPLICATION_SUBMITTED", gamingMemberId, null, "competition_host_applications", row.id, null, at);
    return { publicCode: row.publicCode, state: "PENDING", submittedAt: at };
  }

  async withdrawApplication(gamingMemberId: string, publicCode: string): Promise<WithdrawHostApplicationResult> {
    // Ownership is part of the lookup: someone else's application is indistinguishable from a missing one.
    const row = this.applications.find((a) => a.publicCode === publicCode && a.memberId === gamingMemberId);
    if (!row) throw new HostApplicationNotFoundError();
    if (row.state === "WITHDRAWN") return { publicCode, state: "WITHDRAWN", alreadyWithdrawn: true };
    if (row.state !== "PENDING") throw new HostApplicationNotPendingError();
    const at = this.now();
    row.state = "WITHDRAWN";
    row.withdrawnAt = at;
    this.audit("HOST_APPLICATION_WITHDRAWN", gamingMemberId, null, "competition_host_applications", row.id, null, at);
    return { publicCode, state: "WITHDRAWN", alreadyWithdrawn: false };
  }

  async getStatus(gamingMemberId: string): Promise<HostStatusRecord | null> {
    const mine = this.applications.filter((a) => a.memberId === gamingMemberId);
    if (mine.length === 0) return null;
    const live = mine.filter((a) => a.state === "PENDING" || a.state === "APPROVED");
    const row = (live.length ? live : mine)[(live.length ? live : mine).length - 1];
    const cap = this.capabilities.find((c) => c.applicationId === row.id) ?? null;
    const comp = cap?.competitionId ? this.competitions.find((c) => c.id === cap.competitionId) ?? null : null;
    return {
      publicCode: row.publicCode,
      state: row.state,
      venueName: row.venueName,
      cityArea: row.cityArea,
      playingFields: row.playingFields,
      venueDescription: row.venueDescription,
      expectedWindow: row.expectedWindow,
      expectedTeamCount: row.expectedTeamCount,
      submittedAt: row.submittedAt,
      decidedAt: row.decidedAt,
      withdrawnAt: row.withdrawnAt,
      capabilityState: cap?.state ?? null,
      competitionName: comp?.name ?? null,
      competitionPublicCode: comp?.publicCode ?? null,
      competitionState: comp ? "DRAFT" : null,
    };
  }

  async listForReview(reviewerGamingMemberId: string, view: HostReviewView): Promise<HostReviewRecord[]> {
    this.requireGovernance(reviewerGamingMemberId);
    const capFor = (a: AppRow) => this.capabilities.find((c) => c.applicationId === a.id) ?? null;
    const live = (a: AppRow) => a.state === "APPROVED" && (capFor(a)?.state === "AVAILABLE" || capFor(a)?.state === "CONSUMED");
    const rows = this.applications.filter((a) =>
      view === "PENDING" ? a.state === "PENDING"
      : view === "ACTIVE" ? live(a)
      : a.state === "REJECTED" || (a.state === "APPROVED" && capFor(a)?.state === "REVOKED")
    );
    return rows.map((a) => {
      const cap = this.capabilities.find((c) => c.applicationId === a.id) ?? null;
      const comp = cap?.competitionId ? this.competitions.find((c) => c.id === cap.competitionId) ?? null : null;
      return {
        publicCode: a.publicCode,
        state: a.state,
        applicantDisplayName: this.members.get(a.memberId) ?? "",
        venueName: a.venueName,
        cityArea: a.cityArea,
        playingFields: a.playingFields,
        venueDescription: a.venueDescription,
        expectedWindow: a.expectedWindow,
        expectedTeamCount: a.expectedTeamCount,
        submittedAt: a.submittedAt,
        decidedAt: a.decidedAt,
        decidedByDisplayName: a.decidedBy ? this.members.get(a.decidedBy) ?? null : null,
        decisionReason: a.decisionReason,
        withdrawnAt: a.withdrawnAt,
        capabilityState: cap?.state ?? null,
        capabilityGrantedAt: cap?.grantedAt ?? null,
        capabilityConsumedAt: cap?.consumedAt ?? null,
        capabilityRevokedAt: cap?.revokedAt ?? null,
        capabilityRevokeReason: cap?.revokeReason ?? null,
        competitionName: comp?.name ?? null,
        competitionState: comp ? "DRAFT" : null,
      };
    });
  }

  async decideApplication(
    reviewerGamingMemberId: string,
    publicCode: string,
    decision: HostDecision,
    reason: string | null
  ): Promise<DecideHostApplicationResult> {
    this.requireGovernance(reviewerGamingMemberId);
    const cleanReason = reason && reason.trim().length > 0 ? reason.trim() : null;
    if (decision === "REJECT" && !cleanReason) throw new HostReasonRequiredError();
    const row = this.applications.find((a) => a.publicCode === publicCode);
    if (!row) throw new HostApplicationNotFoundError();
    if (row.memberId === reviewerGamingMemberId) throw new HostSelfReviewForbiddenError();

    if (row.state !== "PENDING") {
      if ((row.state === "APPROVED" && decision === "APPROVE") || (row.state === "REJECTED" && decision === "REJECT")) {
        const cap = this.capabilities.find((c) => c.applicationId === row.id) ?? null;
        return { publicCode, state: row.state, capabilityState: cap?.state ?? null, alreadyDecided: true };
      }
      throw new HostApplicationAlreadyDecidedError();
    }

    const at = this.now();
    row.decidedBy = reviewerGamingMemberId;
    row.decidedAt = at;
    row.decisionReason = cleanReason;
    if (decision === "APPROVE") {
      row.state = "APPROVED";
      const cap: CapRow = {
        id: this.id("cap"),
        applicationId: row.id,
        memberId: row.memberId,
        state: "AVAILABLE",
        competitionId: null,
        grantedAt: at,
        consumedAt: null,
        revokedAt: null,
        revokedBy: null,
        revokeReason: null,
      };
      this.capabilities.push(cap);
      this.audit("HOST_APPLICATION_APPROVED", reviewerGamingMemberId, "PRODUCT_GOVERNANCE", "competition_host_applications", row.id, cleanReason, at);
      return { publicCode, state: "APPROVED", capabilityState: "AVAILABLE", alreadyDecided: false };
    }
    row.state = "REJECTED";
    this.audit("HOST_APPLICATION_REJECTED", reviewerGamingMemberId, "PRODUCT_GOVERNANCE", "competition_host_applications", row.id, cleanReason, at);
    return { publicCode, state: "REJECTED", capabilityState: null, alreadyDecided: false };
  }

  async revokeCapability(reviewerGamingMemberId: string, publicCode: string, reason: string): Promise<RevokeHostCapabilityResult> {
    this.requireGovernance(reviewerGamingMemberId);
    const cleanReason = reason && reason.trim().length > 0 ? reason.trim() : null;
    if (!cleanReason) throw new HostReasonRequiredError();
    const row = this.applications.find((a) => a.publicCode === publicCode);
    if (!row) throw new HostApplicationNotFoundError();
    const cap = this.capabilities.find((c) => c.applicationId === row.id);
    if (!cap) throw new HostCapabilityNotFoundError();
    if (cap.state === "REVOKED") return { publicCode, capabilityState: "REVOKED", alreadyRevoked: true };
    const at = this.now();
    cap.state = "REVOKED";
    cap.revokedAt = at;
    cap.revokedBy = reviewerGamingMemberId;
    cap.revokeReason = cleanReason;
    this.audit("HOST_CAPABILITY_REVOKED", reviewerGamingMemberId, "PRODUCT_GOVERNANCE", "competition_host_capabilities", cap.id, cleanReason, at);
    return { publicCode, capabilityState: "REVOKED", alreadyRevoked: false };
  }

  async createHostCompetition(
    hostGamingMemberId: string,
    name: string,
    activityKey: string,
    publicCode: string
  ): Promise<CreateHostCompetitionResult> {
    const trimmed = name.trim();
    if (trimmed.length < 3 || trimmed.length > 80) throw new InvalidHostCompetitionError("name");
    if (activityKey !== "SOCCER_5V5") throw new InvalidHostCompetitionError("activityKey");
    if (!publicCode || publicCode.trim().length === 0) throw new InvalidHostCompetitionError("publicCode");

    const caps = this.capabilities.filter((c) => c.memberId === hostGamingMemberId);
    const cap = caps[caps.length - 1];
    if (!cap) throw new HostCapabilityRequiredError();
    if (cap.state === "REVOKED") throw new HostCapabilityRevokedError();
    if (cap.state === "CONSUMED") throw new HostCapabilityAlreadyConsumedError();

    // A failure here (the whole transaction rolls back in Postgres) must leave the capability AVAILABLE.
    if (this.failNextCreation) {
      this.failNextCreation = false;
      throw new Error("simulated creation failure");
    }

    const at = this.now();
    const comp: CompetitionRow = { id: this.id("comp"), name: trimmed, publicCode, organizerMemberId: hostGamingMemberId, createdAt: at };
    this.competitions.push(comp);
    cap.state = "CONSUMED";
    cap.competitionId = comp.id;
    cap.consumedAt = at;
    this.audit("HOST_CAPABILITY_CONSUMED", hostGamingMemberId, null, "competition_host_capabilities", cap.id, null, at);
    return { competitionId: comp.id, state: "DRAFT", createdAt: at };
  }
}
