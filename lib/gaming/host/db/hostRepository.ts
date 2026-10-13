import type {
  HostApplicationInput,
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

/**
 * Become a Host persistence boundary (UG-CR-GATE-088). Same convention as the
 * Competitions and authority repositories: one interface, an in-memory
 * implementation for domain tests, and a Supabase implementation in which each
 * operation is a single atomic RPC whose own authorization is the authority —
 * this layer never decides who may do something, it only passes the verified
 * acting member through.
 *
 * Every actor id here comes from a verified session on the server. Nothing in
 * this interface accepts an identity from a request body.
 */
export interface HostRepository {
  /** The applicant, for themself. One live (pending or approved) application per member. */
  submitApplication(gamingMemberId: string, input: HostApplicationInput): Promise<SubmitHostApplicationResult>;

  /** The applicant, and only for their own pending application. Idempotent once withdrawn. */
  withdrawApplication(gamingMemberId: string, publicCode: string): Promise<WithdrawHostApplicationResult>;

  /** The member's own live application, else their most recent; null if they never applied. */
  getStatus(gamingMemberId: string): Promise<HostStatusRecord | null>;

  /** PRODUCT_GOVERNANCE only, enforced by the database. */
  listForReview(reviewerGamingMemberId: string, view: HostReviewView): Promise<HostReviewRecord[]>;

  /** PRODUCT_GOVERNANCE only, never for one's own application. Approval creates exactly one capability. */
  decideApplication(
    reviewerGamingMemberId: string,
    publicCode: string,
    decision: HostDecision,
    reason: string | null
  ): Promise<DecideHostApplicationResult>;

  /** PRODUCT_GOVERNANCE only. Preserves every record; blocks future organizer mutations. */
  revokeCapability(reviewerGamingMemberId: string, publicCode: string, reason: string): Promise<RevokeHostCapabilityResult>;

  /** The approved host. Consumes the capability and creates the competition in one transaction. */
  createHostCompetition(
    hostGamingMemberId: string,
    name: string,
    activityKey: string,
    publicCode: string
  ): Promise<CreateHostCompetitionResult>;
}
