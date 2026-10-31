import { SupabaseCommunityVotingRepository } from "../db/supabaseCommunityVotingRepository";
import type { ClaimedEntry, CommunityVotingErrorCode, ConfirmedEntry } from "../types";
import { CommunityVotingError } from "../types";
import type { CastRoundVoteInput, RoundsRepository } from "./repository";
import type {
  CastCommunityVoteResult,
  FinalistSelection,
  FollowupTask,
  GalleryRow,
  GeofenceTestResult,
  OperatorContext,
  PhotoBytes,
  PhotoDecision,
  PhotoHiddenResult,
  PolicyApproval,
  PolicyKey,
  PromoDecision,
  PublicRoundResult,
  RegisterRoundInput,
  RoundClosure,
  RoundEntryCreated,
  RoundEvidence,
  RoundInstanceRecord,
  RoundOverview,
  RoundPublication,
  RoundPublicInfo,
  RoundResultRow,
  RoundReview,
  RoundRole,
  RoundStarted,
  RoundVenue,
  RoundVoterStatus,
  RoundWithdrawal,
  SavedVenue,
  Schedule,
  ScheduleInput,
  UploadedPhoto,
} from "./types";

/** Codes the pilot's SQL functions and guards raise as `CV_<CODE>:`. Everything else falls through to the foundation repository's table. */
const ROUND_CODES: ReadonlySet<string> = new Set<CommunityVotingErrorCode>([
  "NOT_A_ROUND",
  "WRONG_ROUND",
  "OPERATOR_REQUIRED",
  "VERIFIED_EMAIL_REQUIRED",
  "PROFILE_INCOMPLETE",
  "SCHEDULE_INVALID",
  "SCHEDULE_REQUIRED",
  "CUTOFF_PASSED",
  "ALIAS_EXHAUSTED",
  "ENTRY_HAS_MEDIA",
  "ENTRY_ALREADY_WITHDRAWN",
  "PHOTO_INVALID",
  "PHOTO_REQUIRED",
  "PHOTO_HIDDEN",
  "CONSENT_REQUIRED",
  "CONSENT_ALREADY_RECORDED",
  "DECISION_ALREADY_RECORDED",
  "POLICY_REQUIRED",
  "POLICY_ALREADY_RECORDED",
  "CANDIDATE_NOT_AVAILABLE",
  "VOTING_WINDOW_ELAPSED",
  "NO_ELIGIBLE_ENTRIES",
  "FINALISTS_NOT_SELECTED",
  "ALREADY_CLOSED",
  "RESULTS_NOT_AVAILABLE",
  "REVIEW_REQUIRED",
  "REVIEW_STALE",
  "NO_VALID_RESULT",
  "ALREADY_PUBLISHED",
  "GEOFENCE_FROZEN",
  "NOT_A_FINAL",
  "TEST_MODE_MISMATCH",
]);

const MESSAGES: Record<string, string> = {
  NOT_A_ROUND: "This operation does not apply to this kind of event.",
  WRONG_ROUND: "This operation does not apply to this round.",
  OPERATOR_REQUIRED: "Only the designated operator may do this.",
  VERIFIED_EMAIL_REQUIRED: "A verified email address is required to take part.",
  PROFILE_INCOMPLETE: "Complete your URBANO Gaming profile to take part.",
  SCHEDULE_INVALID: "The schedule is not valid.",
  SCHEDULE_REQUIRED: "The preliminary needs a configured closing time in the future before it can open.",
  CUTOFF_PASSED: "The cutoff for new contestants and photographs has passed.",
  ALIAS_EXHAUSTED: "No free contestant number could be issued.",
  ENTRY_HAS_MEDIA: "An entry with a photograph cannot be removed; withdraw it instead.",
  ENTRY_ALREADY_WITHDRAWN: "This entry has been withdrawn.",
  PHOTO_INVALID: "The photograph is not acceptable.",
  PHOTO_REQUIRED: "This applies to the entry's current photograph.",
  PHOTO_HIDDEN: "This photograph has been hidden at the person's request.",
  CONSENT_REQUIRED: "The contestant's consent is required first.",
  CONSENT_ALREADY_RECORDED: "This decision is already recorded.",
  DECISION_ALREADY_RECORDED: "This photograph has already been decided.",
  POLICY_ALREADY_RECORDED: "This Product decision has already been recorded.",
  CANDIDATE_NOT_AVAILABLE: "This contestant is not available.",
  VOTING_WINDOW_ELAPSED: "The voting time of this round has ended.",
  NO_ELIGIBLE_ENTRIES: "No contestant remains to advance.",
  FINALISTS_NOT_SELECTED: "The finalist cut has not been made yet.",
  ALREADY_CLOSED: "This has already been closed.",
  RESULTS_NOT_AVAILABLE: "Results are not available yet.",
  REVIEW_REQUIRED: "The closed result must be reviewed before it is published.",
  REVIEW_STALE: "The result or the eligible contestants changed after it was reviewed; review it again.",
  NO_VALID_RESULT: "The final has no valid votes, so there is no result to publish.",
  ALREADY_PUBLISHED: "The results of this round have already been published.",
  GEOFENCE_FROZEN: "The final has opened: its venue geofence can no longer change.",
  NOT_A_FINAL: "Only the final has a venue geofence.",
  TEST_MODE_MISMATCH: "A test final can only follow a test preliminary, and a real final a real one.",
  CLAIM_RATE_LIMITED: "Too many wrong credentials. Ask the operator for help.",
};

const POLICY_KEYS: readonly PolicyKey[] = ["ZERO_VALID_VOTES_PRELIMINARY", "ZERO_VOTE_ENTRIES_AT_CUTOFF", "FINALIST_WITHDRAWAL_AFTER_SELECTION"];

function codeFromMessage(message: unknown): string | null {
  if (typeof message !== "string") return null;
  const match = /^([A-Z][A-Z0-9_]+):/.exec(message.trim());
  return match ? match[1] : null;
}

/** The policy a CV_POLICY_REQUIRED refusal names. Only a known key is ever repeated; nothing else of the raw message is. */
function policyKeyFromMessage(message: unknown): PolicyKey | null {
  if (typeof message !== "string") return null;
  return POLICY_KEYS.find((k) => message.includes(k)) ?? null;
}

/** PostgREST renders timestamptz as "2026-10-29T14:14:10.55+00:00" (a variable number of fractional digits); every time that leaves this repository is canonical ISO-8601. */
const iso = (value: unknown): string | null => {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? value : new Date(ms).toISOString();
};
const ts = (value: unknown): string => iso(value) as string;
const str = (value: unknown): string | null => (typeof value === "string" ? value : null);

function operatorArgs(c: OperatorContext) {
  return { p_instance_id: c.instanceId, p_host_token: c.hostToken, p_operator_member_id: c.operatorMemberId };
}

function mapSchedule(row: Record<string, unknown>): Schedule {
  return {
    registrationOpensAt: iso(row.registration_opens_at),
    contestantCutoffAt: iso(row.contestant_cutoff_at),
    votingOpensAt: iso(row.voting_opens_at),
    votingClosesAt: iso(row.voting_closes_at),
    status: row.status as Schedule["status"],
    updatedAt: ts(row.updated_at),
  };
}

/** The jsonb the overview, the evidence and the schedule carry holds timestamps as the database rendered them; canonicalize each one. */
function canonicalTimes<T>(value: T, keys: readonly string[]): T {
  if (Array.isArray(value)) return value.map((v) => canonicalTimes(v, keys)) as unknown as T;
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = keys.includes(k) && typeof v === "string" ? ts(v) : canonicalTimes(v, keys);
    }
    return out as T;
  }
  return value;
}

const TIME_KEYS = [
  "serverNow", "deadlineAt", "openedAt", "closedAt", "registrationOpensAt", "contestantCutoffAt", "votingOpensAt", "votingClosesAt",
  "reviewedAt", "publishedAt", "selectedAt", "withdrawnAt", "approvedAt", "createdAt", "resolvedAt", "claimExpiresAt", "at", "savedAt",
] as const;

/**
 * Supabase-backed repository for the two-round pilot. One RPC per operation, so each is atomic in the database; raw database errors are
 * NEVER propagated (the foundation class reduces anything it does not recognize to its SQLSTATE). Voter binding and intent issuing are
 * the unchanged GATE-003 operations of the class it extends — the pilot's identity rules for them live in the database (the binding
 * trigger), not here.
 */
export class SupabaseRoundsRepository extends SupabaseCommunityVotingRepository implements RoundsRepository {
  protected override translate(error: { code?: string; message?: string }): Error {
    const code = codeFromMessage(error.message);
    if (code && code.startsWith("CV_")) {
      const known = code.slice(3);
      if (known === "POLICY_REQUIRED") {
        // The refusal names WHICH Product decision is missing; nothing else of the raw message is repeated.
        const key = policyKeyFromMessage(error.message);
        return new CommunityVotingError("POLICY_REQUIRED", key ? `A Product decision is pending: ${key}.` : "A Product decision is pending.");
      }
      if (ROUND_CODES.has(known)) return new CommunityVotingError(known as CommunityVotingErrorCode, MESSAGES[known]);
    }
    return super.translate(error);
  }

  // ------------------------------------------------------------------ operator

  async registerRound(input: RegisterRoundInput): Promise<RoundInstanceRecord> {
    const v = input.venue;
    const [row] = await this.rows<Record<string, unknown>>("register_community_voting_round_atomically", {
      p_session_id: input.sessionId,
      p_host_token: input.hostToken,
      p_operator_member_id: input.operatorMemberId,
      p_rule_version: input.ruleVersion,
      p_round_role: input.roundRole,
      p_source_instance_id: input.sourceInstanceId,
      p_venue_latitude: v ? v.venueLatitude : null,
      p_venue_longitude: v ? v.venueLongitude : null,
      p_venue_radius_meters: v ? v.venueRadiusMeters : null,
      p_max_accuracy_meters: v ? v.maxAccuracyMeters : null,
      p_inside_margin_factor: v ? v.insideMarginFactor : null,
      p_outside_margin_factor: v ? v.outsideMarginFactor : null,
      p_window_seconds: input.windowSeconds,
      p_is_test: input.testMode === true,
    });
    return {
      instanceId: row.instance_id as string,
      sessionId: row.session_id as string,
      roundRole: row.round_role as RoundRole,
      ruleVersion: row.rule_version as number,
      sourceInstanceId: str(row.source_instance_id),
      windowSeconds: (row.window_seconds as number | null) ?? null,
      isTest: Boolean(row.is_test),
      createdAt: ts(row.created_at),
    };
  }

  async configureFinalGeofence(input: OperatorContext & { venue: RoundVenue }): Promise<SavedVenue> {
    const v = input.venue;
    const [row] = await this.rows<Record<string, unknown>>("configure_community_voting_final_geofence_atomically", {
      ...operatorArgs(input),
      p_venue_latitude: v.venueLatitude,
      p_venue_longitude: v.venueLongitude,
      p_venue_radius_meters: v.venueRadiusMeters,
      p_max_accuracy_meters: v.maxAccuracyMeters,
      p_inside_margin_factor: v.insideMarginFactor,
      p_outside_margin_factor: v.outsideMarginFactor,
    });
    return {
      venueLatitude: row.venue_latitude as number,
      venueLongitude: row.venue_longitude as number,
      venueRadiusMeters: row.venue_radius_meters as number,
      maxAccuracyMeters: row.max_accuracy_meters as number,
      insideMarginFactor: row.inside_margin_factor as number,
      outsideMarginFactor: row.outside_margin_factor as number,
      configuredAt: ts(row.configured_at),
    };
  }

  async testFinalGeofence(input: OperatorContext & { location: { latitude: number; longitude: number; accuracyMeters: number } }): Promise<GeofenceTestResult> {
    const [row] = await this.rows<Record<string, unknown>>("test_community_voting_round_geofence", {
      ...operatorArgs(input),
      p_latitude: input.location.latitude,
      p_longitude: input.location.longitude,
      p_accuracy_meters: input.location.accuracyMeters,
    });
    return {
      decision: row.decision as GeofenceTestResult["decision"],
      distanceMeters: Number(row.distance_meters),
      accuracyMeters: Number(row.accuracy_meters),
      radiusMeters: Number(row.radius_meters),
      maxAccuracyMeters: Number(row.max_accuracy_meters),
    };
  }

  async setRoundSchedule(input: OperatorContext & { schedule: ScheduleInput }): Promise<Schedule> {
    const [row] = await this.rows<Record<string, unknown>>("set_community_voting_round_schedule_atomically", {
      ...operatorArgs(input),
      p_registration_opens_at: input.schedule.registrationOpensAt,
      p_contestant_cutoff_at: input.schedule.contestantCutoffAt,
      p_voting_opens_at: input.schedule.votingOpensAt,
      p_voting_closes_at: input.schedule.votingClosesAt,
      p_status: input.schedule.status,
    });
    return mapSchedule(row);
  }

  async createRoundEntry(input: OperatorContext & { claimTtlSeconds?: number }): Promise<RoundEntryCreated> {
    const [row] = await this.rows<Record<string, unknown>>("create_community_voting_round_entry_atomically", {
      ...operatorArgs(input),
      ...(input.claimTtlSeconds === undefined ? {} : { p_claim_ttl_seconds: input.claimTtlSeconds }),
    });
    return {
      entryId: row.entry_id as string,
      label: row.label as string,
      claimCode: row.claim_code as string,
      claimExpiresAt: ts(row.claim_expires_at),
    };
  }

  async removeRoundEntry(input: OperatorContext & { entryId: string }): Promise<void> {
    await this.rows("remove_community_voting_round_entry_atomically", { ...operatorArgs(input), p_entry_id: input.entryId });
  }

  async uploadEntryPhoto(input: OperatorContext & { entryId: string; fullBase64: string; thumbBase64: string; width: number; height: number }): Promise<UploadedPhoto> {
    const [row] = await this.rows<Record<string, unknown>>("upload_community_voting_round_photo_atomically", {
      ...operatorArgs(input),
      p_entry_id: input.entryId,
      p_full_b64: input.fullBase64,
      p_thumb_b64: input.thumbBase64,
      p_width: input.width,
      p_height: input.height,
    });
    return { photoId: row.photo_id as string, fullSha256: row.full_sha256 as string, thumbSha256: row.thumb_sha256 as string };
  }

  async recordEntryConsent(input: OperatorContext & { entryId: string; photoId: string; consentVersion: string; statementSha256: string; ageConfirmed: boolean }): Promise<{ consentId: string; acceptedAt: string }> {
    const [row] = await this.rows<Record<string, unknown>>("record_community_voting_round_consent_atomically", {
      ...operatorArgs(input),
      p_entry_id: input.entryId,
      p_photo_id: input.photoId,
      p_consent_version: input.consentVersion,
      p_statement_sha256: input.statementSha256,
      p_age_confirmed: input.ageConfirmed,
    });
    return { consentId: row.consent_id as string, acceptedAt: ts(row.accepted_at) };
  }

  async recordPromoConsent(
    input: OperatorContext & { entryId: string; decision: PromoDecision; consentVersion: string; statementSha256: string }
  ): Promise<{ promoConsentId: string; entryId: string; decision: PromoDecision; recordedAt: string }> {
    const [row] = await this.rows<Record<string, unknown>>("record_community_voting_promo_consent_atomically", {
      ...operatorArgs(input),
      p_entry_id: input.entryId,
      p_decision: input.decision,
      p_consent_version: input.consentVersion,
      p_statement_sha256: input.statementSha256,
    });
    return {
      promoConsentId: row.promo_consent_id as string,
      entryId: row.entry_id as string,
      decision: row.decision as PromoDecision,
      recordedAt: ts(row.recorded_at),
    };
  }

  async decideEntryPhoto(input: OperatorContext & { entryId: string; photoId: string; decision: PhotoDecision; reason?: string }): Promise<{ entryId: string; photoId: string; decision: PhotoDecision }> {
    const [row] = await this.rows<Record<string, unknown>>("decide_community_voting_round_photo_atomically", {
      ...operatorArgs(input),
      p_entry_id: input.entryId,
      p_photo_id: input.photoId,
      p_decision: input.decision,
      p_reason: input.reason ?? null,
    });
    return { entryId: row.entry_id as string, photoId: row.photo_id as string, decision: row.decision as PhotoDecision };
  }

  async confirmRoundAssociation(input: OperatorContext & { entryId: string; confirmationCode: string }): Promise<ConfirmedEntry> {
    const [row] = await this.rows<Record<string, unknown>>("confirm_community_voting_round_entry_atomically", {
      ...operatorArgs(input),
      p_entry_id: input.entryId,
      p_confirmation_code: input.confirmationCode,
    });
    // A mismatch is a normal RETURN from the function (so the attempt count survives); it becomes an error here.
    switch (row.outcome) {
      case "CONFIRMED":
        return { entryId: row.entry_id as string, state: "CONFIRMED" };
      case "REJECTED":
        throw new CommunityVotingError("CONFIRMATION_REJECTED", "The confirmation code does not match.");
      case "VOIDED":
        throw new CommunityVotingError("CLAIM_VOIDED", "Too many wrong confirmation codes: this claim is void. Create the entry again.");
      default:
        throw new CommunityVotingError("STATE_INCONSISTENT");
    }
  }

  async hideRoundPhoto(input: OperatorContext & { entryId: string; reason: string }): Promise<PhotoHiddenResult> {
    const [row] = await this.rows<Record<string, unknown>>("hide_community_voting_round_photo_atomically", {
      ...operatorArgs(input),
      p_entry_id: input.entryId,
      p_reason: input.reason,
    });
    return { actionId: row.action_id as string, entryId: row.entry_id as string, performedAt: ts(row.performed_at) };
  }

  async withdrawRoundCandidature(input: OperatorContext & { entryId: string; reason: string; hidePhoto: boolean }): Promise<RoundWithdrawal> {
    const [row] = await this.rows<Record<string, unknown>>("withdraw_community_voting_round_candidature_atomically", {
      ...operatorArgs(input),
      p_entry_id: input.entryId,
      p_reason: input.reason,
      p_hide_photo: input.hidePhoto,
    });
    return {
      withdrawalId: row.withdrawal_id as string,
      entryId: row.entry_id as string,
      withdrawnAt: ts(row.withdrawn_at),
      duringVoting: Boolean(row.during_voting),
      cascaded: Number(row.cascaded),
      photoHidden: Boolean(row.photo_hidden),
    };
  }

  async recordPolicyApproval(input: OperatorContext & { policyKey: PolicyKey; policyValue: string; approvalReference: string }): Promise<PolicyApproval> {
    const [row] = await this.rows<Record<string, unknown>>("record_community_voting_policy_approval_atomically", {
      ...operatorArgs(input),
      p_policy_key: input.policyKey,
      p_policy_value: input.policyValue,
      p_approval_reference: input.approvalReference,
    });
    return {
      approvalId: row.approval_id as string,
      policyKey: row.policy_key as PolicyKey,
      policyValue: row.policy_value as string,
      approvedAt: ts(row.approved_at),
    };
  }

  async resolveFollowupTask(input: OperatorContext & { taskId: string; note: string }): Promise<Pick<FollowupTask, "taskId" | "status" | "resolvedAt">> {
    const [row] = await this.rows<Record<string, unknown>>("resolve_community_voting_followup_task_atomically", {
      ...operatorArgs(input),
      p_task_id: input.taskId,
      p_note: input.note,
    });
    return { taskId: row.task_id as string, status: row.status as FollowupTask["status"], resolvedAt: ts(row.resolved_at) };
  }

  /** The database operation that opens a round. The four-category contest names its own (the ballot excludes group members). */
  protected startRpcName(): string {
    return "start_community_voting_round_atomically";
  }

  /** The database operation that casts a vote, and its arguments. The contest's has NO location parameter at all. */
  protected castRpcName(): string {
    return "cast_community_voting_round_vote_atomically";
  }
  protected castRpcArgs(input: CastRoundVoteInput): Record<string, unknown> {
    const loc = input.location;
    return {
      p_instance_id: input.instanceId,
      p_auth_user_id: input.authUserId,
      p_binding_id: input.bindingId,
      p_intent_no: input.intentNo,
      p_interaction_instance_id: input.interactionInstanceId,
      p_candidate_id: input.candidateId,
      p_latitude: loc ? loc.latitude : null,
      p_longitude: loc ? loc.longitude : null,
      p_accuracy_meters: loc ? loc.accuracyMeters : null,
    };
  }

  async startRound(input: OperatorContext & { promptText: string }): Promise<RoundStarted> {
    const [row] = await this.rows<Record<string, unknown>>(this.startRpcName(), {
      ...operatorArgs(input),
      p_prompt_text: input.promptText,
    });
    return {
      interactionInstanceId: row.interaction_instance_id as string,
      promptId: row.prompt_id as string,
      state: row.state as "PROMPT_ACTIVE",
      segmentNumber: row.segment_ordinal as number,
      candidateCount: row.candidate_count as number,
      openedAt: ts(row.opened_at),
      deadlineAt: iso(row.deadline_at),
    };
  }

  async closeRound(input: OperatorContext): Promise<RoundClosure> {
    const [row] = await this.rows<Record<string, unknown>>("close_community_voting_round_atomically", operatorArgs(input));
    return {
      closedAt: ts(row.closed_at),
      validVoteCount: row.valid_vote_count as number,
      resultsDigest: row.results_digest as string,
    };
  }

  async readRoundResults(input: OperatorContext): Promise<RoundResultRow[]> {
    const rows = await this.rows<Record<string, unknown>>("read_community_voting_round_results", operatorArgs(input));
    return rows.map((r) => ({
      candidateId: r.candidate_id as string,
      entryId: r.entry_id as string,
      label: r.label as string,
      ordinal: r.ordinal as number,
      withdrawn: Boolean(r.withdrawn),
      votes: Number(r.votes),
      competitionRank: r.competition_rank === null || r.competition_rank === undefined ? null : Number(r.competition_rank),
      finalist: Boolean(r.finalist),
      winner: Boolean(r.winner),
    }));
  }

  async readRoundEvidence(input: OperatorContext): Promise<RoundEvidence> {
    const rows = await this.rows<unknown>("read_community_voting_round_evidence", operatorArgs(input));
    return canonicalTimes(rows[0] as RoundEvidence, TIME_KEYS);
  }

  async readRoundOverview(input: OperatorContext): Promise<RoundOverview> {
    const rows = await this.rows<unknown>("read_community_voting_round_overview", operatorArgs(input));
    return canonicalTimes(rows[0] as RoundOverview, TIME_KEYS);
  }

  async selectFinalists(input: OperatorContext): Promise<FinalistSelection> {
    const [row] = await this.rows<Record<string, unknown>>("select_community_voting_finalists_atomically", operatorArgs(input));
    return {
      finalistCount: Number(row.finalist_count),
      eligibleCount: Number(row.eligible_count),
      selectionDigest: row.selection_digest as string,
      selectedAt: ts(row.selected_at),
      alreadySelected: Boolean(row.already_selected),
    };
  }

  async prepareFinal(input: OperatorContext): Promise<{ carriedCount: number; alreadyPrepared: boolean }> {
    const [row] = await this.rows<Record<string, unknown>>("prepare_community_voting_final_atomically", operatorArgs(input));
    return { carriedCount: Number(row.carried_count), alreadyPrepared: Boolean(row.already_prepared) };
  }

  async recordRoundReview(input: OperatorContext & { note?: string }): Promise<RoundReview> {
    const [row] = await this.rows<Record<string, unknown>>("record_community_voting_round_review_atomically", {
      ...operatorArgs(input),
      p_note: input.note ?? null,
    });
    return { reviewId: row.review_id as string, resultsDigest: row.results_digest as string, reviewedAt: ts(row.reviewed_at) };
  }

  async publishRound(input: OperatorContext): Promise<RoundPublication> {
    const [row] = await this.rows<Record<string, unknown>>("publish_community_voting_round_atomically", operatorArgs(input));
    return { publishedAt: ts(row.published_at), resultsDigest: row.results_digest as string };
  }

  // ------------------------------------------------------------------ public

  async readRoundPublicInfo(instanceId: string): Promise<RoundPublicInfo | null> {
    const rows = await this.rows<Record<string, unknown>>("read_community_voting_round_public_info", { p_instance_id: instanceId });
    if (rows.length === 0) return null;
    const r = rows[0];
    return {
      roundRole: r.round_role as RoundRole,
      sessionState: r.session_state as string,
      interactionState: str(r.interaction_state),
      openedAt: iso(r.opened_at),
      windowSeconds: (r.window_seconds as number | null) ?? null,
      deadlineAt: iso(r.deadline_at),
      serverNow: ts(r.server_now),
      locationRequired: Boolean(r.location_required),
      registrationOpensAt: iso(r.registration_opens_at),
      contestantCutoffAt: iso(r.contestant_cutoff_at),
      votingOpensAt: iso(r.voting_opens_at),
      votingClosesAt: iso(r.voting_closes_at),
      scheduleStatus: (r.schedule_status as Schedule["status"] | null) ?? null,
      approvedContestants: Number(r.approved_contestants),
      closed: Boolean(r.closed),
      published: Boolean(r.published),
      isTest: Boolean(r.is_test),
    };
  }

  async readRoundGallery(instanceId: string): Promise<GalleryRow[]> {
    const rows = await this.rows<Record<string, unknown>>("read_community_voting_round_gallery", { p_instance_id: instanceId });
    return rows.map((r) => ({ alias: r.alias as string, candidateId: (r.candidate_id as string | null) ?? null, ordinal: r.ordinal as number }));
  }

  async readRoundPhoto(input: { instanceId: string; alias: string; variant: "thumb" | "full" }): Promise<PhotoBytes | null> {
    const rows = await this.rows<Record<string, unknown>>("read_community_voting_round_photo", {
      p_instance_id: input.instanceId,
      p_alias: input.alias,
      p_variant: input.variant,
    });
    if (rows.length === 0) return null;
    return {
      contentType: rows[0].content_type as string,
      bytes: Buffer.from(rows[0].bytes_b64 as string, "base64"),
      sha256: rows[0].sha256 as string,
    };
  }

  async readRoundPublicResults(instanceId: string): Promise<PublicRoundResult[]> {
    const rows = await this.rows<Record<string, unknown>>("read_community_voting_round_public_results", { p_instance_id: instanceId });
    return rows.map((r) => ({ kind: r.kind as PublicRoundResult["kind"], alias: r.alias as string, ordinal: r.ordinal as number }));
  }

  // ------------------------------------------------------------------ voter

  async claimRoundEntry(input: { instanceId: string; authUserId: string; claimCode: string }): Promise<ClaimedEntry> {
    const [row] = await this.rows<Record<string, unknown>>("claim_community_voting_round_entry_atomically", {
      p_instance_id: input.instanceId,
      p_auth_user_id: input.authUserId,
      p_claim_code: input.claimCode,
    });
    switch (row.outcome) {
      case "CLAIMED":
        return { label: row.label as string, confirmationCode: row.confirmation_code as string, confirmExpiresAt: ts(row.confirm_expires_at) };
      case "INVALID":
        throw new CommunityVotingError("CLAIM_INVALID", "This claim is not valid.");
      case "EXPIRED":
        throw new CommunityVotingError("CLAIM_EXPIRED", "This claim has expired.");
      case "RATE_LIMITED":
        throw new CommunityVotingError("CLAIM_RATE_LIMITED", MESSAGES.CLAIM_RATE_LIMITED);
      case "CONTESTANT_ALREADY_HAS_ENTRY":
        throw new CommunityVotingError("CONTESTANT_ALREADY_HAS_ENTRY", "This identity already holds an entry in this event.");
      default:
        throw new CommunityVotingError("STATE_INCONSISTENT");
    }
  }

  async castRoundVote(input: CastRoundVoteInput): Promise<CastCommunityVoteResult> {
    let rows: Record<string, unknown>[];
    try {
      rows = await this.rows<Record<string, unknown>>(this.castRpcName(), this.castRpcArgs(input));
    } catch (err) {
      // A losing device needs to reconcile (see the foundation repository): attach the caller's OWN current state, and say honestly what
      // is known about the INTENT. Neither is ever dressed up as a success.
      if (err instanceof CommunityVotingError && (err.code === "STALE_INTENT" || err.code === "INTENT_PAYLOAD_MISMATCH")) {
        const status = await this.readRoundVoterStatus({ instanceId: input.instanceId, authUserId: input.authUserId });
        const current = status
          ? {
              instanceId: status.instanceId,
              bindingId: status.bindingId,
              sessionState: status.sessionState,
              interactionInstanceId: status.interactionInstanceId,
              interactionState: status.interactionState,
              engineType: status.interactionInstanceId ? "VOTING" : null,
              issuedIntentNo: status.issuedIntentNo,
              appliedIntentNo: status.appliedIntentNo,
              myCandidateId: status.myCandidateId,
              myEntry: status.myEntry,
            }
          : null;
        throw new CommunityVotingError(
          err.code,
          err.message,
          current,
          err.code === "STALE_INTENT" ? "HISTORICAL_OUTCOME_UNAVAILABLE" : "APPLIED_WITH_DIFFERENT_PAYLOAD"
        );
      }
      throw err;
    }

    const row = rows[0];
    return {
      outcome: row.outcome as CastCommunityVoteResult["outcome"],
      bindingId: row.binding_id as string,
      intentNo: row.intent_no as number,
      interactionInstanceId: row.interaction_instance_id as string,
      candidateId: row.candidate_id as string,
      voteUpdatedAt: ts(row.vote_updated_at),
    };
  }

  async readRoundVoterStatus(input: { instanceId: string; authUserId: string }): Promise<RoundVoterStatus | null> {
    const rows = await this.rows<Record<string, unknown>>("read_community_voting_round_voter_status", {
      p_instance_id: input.instanceId,
      p_auth_user_id: input.authUserId,
    });
    if (rows.length === 0) return null;
    const r = rows[0];
    const entryLabel = (r.my_entry_label as string | null) ?? null;
    const entryState = (r.my_entry_state as string | null) ?? null;
    return {
      instanceId: r.instance_id as string,
      bindingId: r.binding_id as string,
      roundRole: r.round_role as RoundRole,
      sessionState: r.session_state as string,
      interactionInstanceId: (r.interaction_instance_id as string | null) ?? null,
      interactionState: (r.interaction_state as string | null) ?? null,
      issuedIntentNo: r.issued_intent_no as number,
      appliedIntentNo: r.applied_intent_no as number,
      myCandidateId: (r.my_candidate_id as string | null) ?? null,
      myEntry:
        entryLabel !== null && (entryState === "PENDING_CONFIRMATION" || entryState === "CONFIRMED")
          ? { label: entryLabel, state: entryState }
          : null,
      openedAt: iso(r.opened_at),
      deadlineAt: iso(r.deadline_at),
      serverNow: ts(r.server_now),
      closed: Boolean(r.closed),
      published: Boolean(r.published),
    };
  }
}
