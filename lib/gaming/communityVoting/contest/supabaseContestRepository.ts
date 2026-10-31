import { CommunityVotingError } from "../types";
import type { CommunityVotingErrorCode } from "../types";
import type { CastRoundVoteInput } from "../rounds/repository";
import { SupabaseRoundsRepository } from "../rounds/supabaseRoundsRepository";
import type { GalleryRow, OperatorContext, RoundEntryCreated, RoundOverview, RoundPublication, RoundResultRow, RoundReview } from "../rounds/types";
import { isCategoryKey } from "./categories";
import type { CategoryKey } from "./categories";
import type {
  CandidacyRegistered,
  CategoryOf,
  CategoryOverview,
  CategoryPublication,
  CategoryRoundRecord,
  CategoryStructureRow,
  ContestCategoryRef,
  DeliveryStatus,
  EntryKind,
  MyCandidacy,
  PublicCandidacy,
  RegisterCandidacyInput,
  RegistrationContact,
  StationCandidacy,
} from "./types";

/** Codes the contest's SQL functions and guards raise as `CV_<CODE>:`. Everything else falls through to the pilot's repository. */
const CONTEST_CODES: ReadonlySet<string> = new Set<CommunityVotingErrorCode>([
  "NOT_A_CATEGORY_ROUND",
  "CONTEST_NOT_FOUND",
  "CATEGORY_ALREADY_REGISTERED",
  "WRONG_CATEGORY",
  "WRONG_ENTRY_KIND",
  "GROUP_FULL",
  "ALREADY_CANDIDATE",
  "OBSOLETE_FOR_CATEGORY",
  "REGISTRATION_NOT_OPEN",
]);

const MESSAGES: Record<string, string> = {
  NOT_A_CATEGORY_ROUND: "This operation applies to a category of the contest only.",
  CONTEST_NOT_FOUND: "No contest exists for this id.",
  CATEGORY_ALREADY_REGISTERED: "This category already has its round in the contest.",
  WRONG_CATEGORY: "Groups take part in the group category, and individual costumes in the other three.",
  WRONG_ENTRY_KIND: "This operation does not apply to this kind of entry.",
  GROUP_FULL: "A group has no room for another member.",
  ALREADY_CANDIDATE: "This person already belongs to a candidacy of the contest: a person takes part once, in one category.",
  OBSOLETE_FOR_CATEGORY: "This does not exist in the contest: it has one round, with no finalist cut and no final.",
  REGISTRATION_NOT_OPEN: "Registration has not opened yet.",
};

const iso = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : new Date(ms).toISOString();
};
const ts = (value: unknown): string => iso(value) as string;

function operatorArgs(c: OperatorContext) {
  return { p_instance_id: c.instanceId, p_host_token: c.hostToken, p_operator_member_id: c.operatorMemberId };
}

const deliveryStatus = (value: unknown): DeliveryStatus | null => (value === "PENDING" || value === "DELIVERED" ? value : null);

function asCategory(value: unknown): CategoryKey {
  if (!isCategoryKey(value)) throw new CommunityVotingError("STATE_INCONSISTENT");
  return value;
}

/**
 * The repository of the four-category contest. It IS the pilot's repository for everything a category round shares with it (entries,
 * photographs, consent, decisions, the association, the close, the public reads), and it names the contest's own database operations where
 * the pilot's could not apply: the registration of a category round, group entries and members, a member's consent, the opening (the ballot
 * leaves members out), the cast (a group's members cannot vote for it, and there is NO location parameter), the results (a winner exists
 * with a valid vote), the review and the publication (a category with no valid vote announces nobody).
 */
export class SupabaseContestRepository extends SupabaseRoundsRepository {
  protected override translate(error: { code?: string; message?: string }): Error {
    const match = typeof error.message === "string" ? /^CV_([A-Z0-9_]+):/.exec(error.message.trim()) : null;
    if (match && CONTEST_CODES.has(match[1])) return new CommunityVotingError(match[1] as CommunityVotingErrorCode, MESSAGES[match[1]]);
    return super.translate(error);
  }

  // ------------------------------------------------------------------ the contest's own operations

  async registerCategoryRound(input: {
    sessionId: string;
    hostToken: string;
    operatorMemberId: string;
    ruleVersion: number;
    contestId: string | null;
    categoryKey: CategoryKey;
  }): Promise<CategoryRoundRecord> {
    const [row] = await this.rows<Record<string, unknown>>("register_community_voting_category_round_atomically", {
      p_session_id: input.sessionId,
      p_host_token: input.hostToken,
      p_operator_member_id: input.operatorMemberId,
      p_rule_version: input.ruleVersion,
      p_contest_id: input.contestId,
      p_category_key: input.categoryKey,
    });
    return {
      instanceId: row.instance_id as string,
      sessionId: row.session_id as string,
      contestId: row.contest_id as string,
      categoryKey: asCategory(row.category_key),
      ruleVersion: row.rule_version as number,
      createdAt: ts(row.created_at),
    };
  }

  async createGroupEntry(input: OperatorContext & { claimTtlSeconds?: number }): Promise<RoundEntryCreated> {
    const [row] = await this.rows<Record<string, unknown>>("create_community_voting_group_entry_atomically", {
      ...operatorArgs(input),
      ...(input.claimTtlSeconds === undefined ? {} : { p_claim_ttl_seconds: input.claimTtlSeconds }),
    });
    return { entryId: row.entry_id as string, label: row.label as string, claimCode: row.claim_code as string, claimExpiresAt: ts(row.claim_expires_at) };
  }

  async createGroupMember(input: OperatorContext & { groupEntryId: string; claimTtlSeconds?: number }): Promise<RoundEntryCreated> {
    const [row] = await this.rows<Record<string, unknown>>("create_community_voting_group_member_atomically", {
      ...operatorArgs(input),
      p_group_entry_id: input.groupEntryId,
      ...(input.claimTtlSeconds === undefined ? {} : { p_claim_ttl_seconds: input.claimTtlSeconds }),
    });
    return { entryId: row.entry_id as string, label: row.label as string, claimCode: row.claim_code as string, claimExpiresAt: ts(row.claim_expires_at) };
  }

  async recordMemberConsent(input: OperatorContext & { memberEntryId: string; photoId: string; consentVersion: string; statementSha256: string; ageConfirmed: boolean }): Promise<{ consentId: string; acceptedAt: string }> {
    const [row] = await this.rows<Record<string, unknown>>("record_community_voting_member_consent_atomically", {
      ...operatorArgs(input),
      p_member_entry_id: input.memberEntryId,
      p_photo_id: input.photoId,
      p_consent_version: input.consentVersion,
      p_statement_sha256: input.statementSha256,
      p_age_confirmed: input.ageConfirmed,
    });
    return { consentId: row.consent_id as string, acceptedAt: ts(row.accepted_at) };
  }

  async readCategoryStructure(input: OperatorContext): Promise<CategoryStructureRow[]> {
    const rows = await this.rows<Record<string, unknown>>("read_community_voting_category_structure", operatorArgs(input));
    return rows.map((r) => ({
      entryId: r.entry_id as string,
      kind: r.entry_kind as EntryKind,
      groupEntryId: (r.group_entry_id as string | null) ?? null,
      memberConsent: r.member_consent === null || r.member_consent === undefined ? null : Boolean(r.member_consent),
      groupComplete: r.group_complete === null || r.group_complete === undefined ? null : Boolean(r.group_complete),
      entryConsent: r.entry_consent === null || r.entry_consent === undefined ? null : Boolean(r.entry_consent),
      photoDecision: r.photo_decision === "APPROVED" || r.photo_decision === "REJECTED" ? r.photo_decision : null,
      publicCode: (r.public_code as string | null) ?? null,
      publicName: (r.public_name as string | null) ?? null,
      selfRegistered: Boolean(r.self_registered),
      hasWhatsapp: Boolean(r.has_whatsapp),
      deliveryStatus: deliveryStatus(r.delivery_status),
    }));
  }

  /** The pilot's overview with the kind and the group structure of every entry, and the category it belongs to. */
  async readCategoryOverview(input: OperatorContext): Promise<CategoryOverview> {
    const [overview, structure, category] = await Promise.all([
      this.readRoundOverview(input),
      this.readCategoryStructure(input),
      this.readCategoryOf(input.instanceId),
    ]);
    if (!category) throw new CommunityVotingError("NOT_A_CATEGORY_ROUND", MESSAGES.NOT_A_CATEGORY_ROUND);
    const byEntry = new Map(structure.map((s) => [s.entryId, s]));
    const o = overview as RoundOverview;
    return {
      ...o,
      contestId: category.contestId,
      categoryKey: category.categoryKey,
      entries: o.entries.map((e) => {
        const s = byEntry.get(e.entryId);
        return {
          ...e,
          kind: s?.kind ?? "INDIVIDUAL",
          groupEntryId: s?.groupEntryId ?? null,
          memberConsent: s?.memberConsent ?? null,
          groupComplete: s?.groupComplete ?? null,
          entryConsent: s?.entryConsent ?? null,
          photoDecision: s?.photoDecision ?? null,
          publicCode: s?.publicCode ?? null,
          publicName: s?.publicName ?? null,
          selfRegistered: s?.selfRegistered ?? false,
          hasWhatsapp: s?.hasWhatsapp ?? false,
          deliveryStatus: s?.deliveryStatus ?? null,
        };
      }),
    };
  }

  async readCategoryOf(instanceId: string): Promise<CategoryOf | null> {
    const rows = await this.rows<Record<string, unknown>>("read_community_voting_category_of", { p_instance_id: instanceId });
    if (rows.length === 0) return null;
    return { contestId: rows[0].contest_id as string, categoryKey: asCategory(rows[0].category_key) };
  }

  async readContestCategories(contestId: string): Promise<ContestCategoryRef[]> {
    const rows = await this.rows<Record<string, unknown>>("read_community_voting_contest_categories", { p_contest_id: contestId });
    return rows.map((r) => ({ categoryKey: asCategory(r.category_key), instanceId: r.instance_id as string, listed: Boolean(r.listed) }));
  }

  /** The contest the operator last chose to show on Home, or null. */
  async readFeaturedContest(): Promise<string | null> {
    const rows = await this.rows<Record<string, unknown>>("read_community_voting_featured_contest", {});
    return rows.length === 0 ? null : (rows[0].contest_id as string);
  }

  async setContestListing(input: OperatorContext & { listed: boolean }): Promise<{ contestId: string; listed: boolean }> {
    const [row] = await this.rows<Record<string, unknown>>("set_community_voting_contest_listing_atomically", { ...operatorArgs(input), p_listed: input.listed });
    return { contestId: row.contest_id as string, listed: Boolean(row.listed) };
  }

  // ------------------------------------------------------------------ self-registration, the public code, the station

  /** The person registers THEMSELVES. The identity is the server's (the verified bearer token), never a field of the request. */
  async registerCandidacy(input: RegisterCandidacyInput): Promise<CandidacyRegistered> {
    const [row] = await this.rows<Record<string, unknown>>("register_community_voting_candidacy_atomically", {
      p_instance_id: input.instanceId,
      p_auth_user_id: input.authUserId,
      p_public_name: input.publicName,
      p_adult_confirmed: input.adultConfirmed,
      p_requirements_version: input.requirementsVersion,
      p_requirements_sha256: input.requirementsSha256,
      p_whatsapp: input.whatsapp,
      p_whatsapp_confirmed: input.whatsappConfirmed,
      p_delivery_version: input.deliveryVersion,
      p_delivery_sha256: input.deliverySha256,
      p_delivery_authorized: input.deliveryAuthorized,
    });
    return {
      entryId: row.entry_id as string,
      categoryKey: asCategory(row.category_key),
      publicCode: row.public_code as string,
      publicName: row.public_name as string,
      kind: row.entry_kind === "GROUP" ? "GROUP" : "INDIVIDUAL",
    };
  }

  /** A person's OWN candidacy in the contest (zero or one). Never the number. */
  async readMyCandidacy(contestId: string, authUserId: string): Promise<MyCandidacy | null> {
    const rows = await this.rows<Record<string, unknown>>("read_community_voting_my_candidacy", { p_contest_id: contestId, p_auth_user_id: authUserId });
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      categoryKey: asCategory(r.category_key),
      instanceId: r.instance_id as string,
      role: r.role as MyCandidacy["role"],
      kind: r.entry_kind === "GROUP" ? "GROUP" : "INDIVIDUAL",
      publicCode: r.public_code as string,
      publicName: (r.public_name as string | null) ?? null,
      state: r.state as MyCandidacy["state"],
      deliveryStatus: deliveryStatus(r.delivery_status),
    };
  }

  /** The gallery of a category carries each candidacy's public code and name. The permission to show a candidacy is the pilot's, unchanged. */
  override async readRoundGallery(instanceId: string): Promise<GalleryRow[]> {
    const rows = await this.rows<Record<string, unknown>>("read_community_voting_category_gallery", { p_instance_id: instanceId });
    return rows.map((r) => ({
      alias: r.alias as string,
      candidateId: (r.candidate_id as string | null) ?? null,
      ordinal: r.ordinal as number,
      publicCode: r.public_code as string,
      publicName: (r.public_name as string | null) ?? null,
    }));
  }

  /** A candidacy by its public code, under the gallery's permission (nothing before it is confirmed, approved and consented). */
  async readCandidacyByCode(contestId: string, code: string): Promise<PublicCandidacy | null> {
    const rows = await this.rows<Record<string, unknown>>("read_community_voting_candidacy_by_code", { p_contest_id: contestId, p_code: code });
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      categoryKey: asCategory(r.category_key),
      instanceId: r.instance_id as string,
      alias: r.alias as string,
      candidateId: (r.candidate_id as string | null) ?? null,
      ordinal: r.ordinal as number,
      publicCode: r.public_code as string,
      publicName: (r.public_name as string | null) ?? null,
    };
  }

  /** The operator's search: a candidacy by its code, in any category of the contest, before it is public. */
  async findCandidacyByCode(input: OperatorContext & { code: string }): Promise<StationCandidacy | null> {
    const rows = await this.rows<Record<string, unknown>>("find_community_voting_candidacy_by_code", { ...operatorArgs(input), p_code: input.code });
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      entryId: r.entry_id as string,
      instanceId: r.instance_id as string,
      categoryKey: asCategory(r.category_key),
      kind: r.entry_kind as EntryKind,
      publicCode: r.public_code as string,
      publicName: (r.public_name as string | null) ?? null,
      selfRegistered: Boolean(r.self_registered),
      hasWhatsapp: Boolean(r.has_whatsapp),
      deliveryStatus: deliveryStatus(r.delivery_status),
      withdrawn: Boolean(r.withdrawn),
      createdAt: ts(r.created_at),
    };
  }

  async confirmRegistration(input: OperatorContext & { entryId: string }): Promise<{ entryId: string; confirmed: true }> {
    const [row] = await this.rows<Record<string, unknown>>("confirm_community_voting_registration_atomically", { ...operatorArgs(input), p_entry_id: input.entryId });
    return { entryId: row.entry_id as string, confirmed: true };
  }

  /** The ONLY read that returns a number, and only to the designated operator, for the manual delivery. The act is audited (the entry, never the number). */
  async readRegistrationContact(input: OperatorContext & { entryId: string }): Promise<RegistrationContact> {
    const [row] = await this.rows<Record<string, unknown>>("read_community_voting_registration_contact", { ...operatorArgs(input), p_entry_id: input.entryId });
    return { whatsapp: row.whatsapp_e164 as string, deliveryStatus: deliveryStatus(row.delivery_status) ?? "PENDING" };
  }

  async markRegistrationDelivered(input: OperatorContext & { entryId: string }): Promise<{ entryId: string; deliveryStatus: DeliveryStatus; deliveredAt: string | null }> {
    const [row] = await this.rows<Record<string, unknown>>("mark_community_voting_registration_delivered_atomically", { ...operatorArgs(input), p_entry_id: input.entryId });
    return { entryId: row.entry_id as string, deliveryStatus: deliveryStatus(row.delivery_status) ?? "PENDING", deliveredAt: iso(row.delivered_at) };
  }

  async correctCandidacyName(input: OperatorContext & { entryId: string; publicName: string }): Promise<{ entryId: string; publicName: string }> {
    const [row] = await this.rows<Record<string, unknown>>("correct_community_voting_candidacy_name_atomically", {
      ...operatorArgs(input),
      p_entry_id: input.entryId,
      p_public_name: input.publicName,
    });
    return { entryId: row.entry_id as string, publicName: row.public_name as string };
  }

  // ------------------------------------------------------------------ the pilot's operations, as a category round needs them

  protected override startRpcName(): string {
    return "start_community_voting_category_atomically";
  }

  protected override castRpcName(): string {
    return "cast_community_voting_category_vote_atomically";
  }

  /** NO location: the category cast has no parameter to carry one, so nothing a browser sends can reach the database. */
  protected override castRpcArgs(input: CastRoundVoteInput): Record<string, unknown> {
    return {
      p_instance_id: input.instanceId,
      p_auth_user_id: input.authUserId,
      p_binding_id: input.bindingId,
      p_intent_no: input.intentNo,
      p_interaction_instance_id: input.interactionInstanceId,
      p_candidate_id: input.candidateId,
    };
  }

  override async readRoundResults(input: OperatorContext): Promise<RoundResultRow[]> {
    const rows = await this.rows<Record<string, unknown>>("read_community_voting_category_results", operatorArgs(input));
    return rows.map((r) => ({
      candidateId: r.candidate_id as string,
      entryId: r.entry_id as string,
      label: r.label as string,
      ordinal: r.ordinal as number,
      withdrawn: Boolean(r.withdrawn),
      votes: Number(r.votes),
      competitionRank: r.competition_rank === null || r.competition_rank === undefined ? null : Number(r.competition_rank),
      finalist: false,
      winner: Boolean(r.winner),
    }));
  }

  override async recordRoundReview(input: OperatorContext & { note?: string }): Promise<RoundReview> {
    const [row] = await this.rows<Record<string, unknown>>("record_community_voting_category_review_atomically", { ...operatorArgs(input), p_note: input.note ?? null });
    return { reviewId: row.review_id as string, resultsDigest: row.results_digest as string, reviewedAt: ts(row.reviewed_at) };
  }

  override async publishRound(input: OperatorContext): Promise<RoundPublication & CategoryPublication> {
    const [row] = await this.rows<Record<string, unknown>>("publish_community_voting_category_atomically", operatorArgs(input));
    return { publishedAt: ts(row.published_at), resultsDigest: row.results_digest as string, winnerCount: Number(row.winner_count) };
  }
}
