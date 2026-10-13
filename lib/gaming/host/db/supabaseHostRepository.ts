import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import type { HostRepository } from "./hostRepository";
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
import {
  InvalidHostApplicationError,
  InvalidHostCompetitionError,
  InvalidHostDecisionError,
  InvalidHostReviewViewError,
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
} from "../types";

const FIELD_NAMES: Record<string, string> = {
  venue_name: "venueName",
  city_area: "cityArea",
  playing_fields: "playingFields",
  venue_description: "venueDescription",
  expected_window: "expectedWindow",
  expected_team_count: "expectedTeamCount",
  confirmations: "confirmations",
  name: "name",
};

function fieldFromMessage(msg: string, code: string): string {
  const raw = msg.slice(msg.indexOf(code) + code.length).replace(/^:\s*/, "").trim().split(/\s/)[0] ?? "";
  return FIELD_NAMES[raw] ?? "application";
}

/**
 * Translates a P0001-coded RPC error into its typed host error — the same
 * convention as the Competitions repository: the SQL message begins with
 * `CODE: ...` and carries errcode P0001. The typed errors carry their own
 * plain-language messages; the raw SQL message is never passed through, so
 * nothing from the database reaches a browser.
 */
function translateError(error: { code?: string; message?: string }): Error {
  const msg = typeof error.message === "string" ? error.message : "";
  if (error.code === "P0001") {
    if (msg.includes("INVALID_HOST_APPLICATION")) return new InvalidHostApplicationError(fieldFromMessage(msg, "INVALID_HOST_APPLICATION"));
    if (msg.includes("INVALID_HOST_COMPETITION")) return new InvalidHostCompetitionError(fieldFromMessage(msg, "INVALID_HOST_COMPETITION"));
    if (msg.includes("UNSUPPORTED_ACTIVITY_KEY")) return new InvalidHostCompetitionError("activityKey");
    if (msg.includes("PUBLIC_CODE_REQUIRED")) return new InvalidHostCompetitionError("publicCode");
    const table: Array<[string, () => Error]> = [
      ["INVALID_HOST_DECISION", () => new InvalidHostDecisionError()],
      ["INVALID_HOST_REVIEW_VIEW", () => new InvalidHostReviewViewError()],
      ["GOVERNANCE_AUTHORITY_REQUIRED", () => new HostReviewerAuthorityRequiredError()],
      ["REASON_REQUIRED", () => new HostReasonRequiredError()],
      ["HOST_APPLICATION_ALREADY_ACTIVE", () => new HostApplicationAlreadyActiveError()],
      ["HOST_APPLICATION_NOT_FOUND", () => new HostApplicationNotFoundError()],
      ["HOST_APPLICATION_NOT_PENDING", () => new HostApplicationNotPendingError()],
      ["HOST_APPLICATION_ALREADY_DECIDED", () => new HostApplicationAlreadyDecidedError()],
      ["HOST_SELF_REVIEW_FORBIDDEN", () => new HostSelfReviewForbiddenError()],
      ["HOST_CAPABILITY_NOT_FOUND", () => new HostCapabilityNotFoundError()],
      ["HOST_CAPABILITY_REQUIRED", () => new HostCapabilityRequiredError()],
      ["HOST_CAPABILITY_ALREADY_CONSUMED", () => new HostCapabilityAlreadyConsumedError()],
      ["HOST_CAPABILITY_REVOKED", () => new HostCapabilityRevokedError()],
    ];
    for (const [code, build] of table) {
      if (msg.includes(code)) return build();
    }
  }
  // Unknown failure: keep the original for server-side logging; routes answer 500 without echoing it.
  return new Error(msg || "Unknown host repository error.");
}

function firstRow<T>(data: T[] | T | null): T | null {
  if (Array.isArray(data)) return data[0] ?? null;
  return data ?? null;
}

/** Service-role client; the browser never holds a data client and never reaches these tables directly. */
export class SupabaseHostRepository implements HostRepository {
  private client: SupabaseClient;

  constructor(supabaseUrl: string, supabaseServiceKey: string) {
    this.client = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store" } as RequestInit) },
    });
  }

  async submitApplication(gamingMemberId: string, input: HostApplicationInput): Promise<SubmitHostApplicationResult> {
    const { data, error } = await this.client.rpc("submit_host_application_atomically", {
      p_gaming_member_id: gamingMemberId,
      p_venue_name: input.venueName,
      p_city_area: input.cityArea,
      p_playing_fields: input.playingFields,
      p_venue_description: input.venueDescription,
      p_expected_window: input.expectedWindow,
      p_expected_team_count: input.expectedTeamCount,
      p_confirm_all_adults: input.confirmAllAdults,
      p_confirm_independent_scorekeepers: input.confirmIndependentScorekeepers,
      p_confirm_pilot_exclusions: input.confirmPilotExclusions,
    });
    if (error) throw translateError(error);
    const row = firstRow<any>(data);
    if (!row) throw new Error("submit_host_application_atomically returned no row.");
    return { publicCode: row.public_code, state: "PENDING", submittedAt: row.submitted_at };
  }

  async withdrawApplication(gamingMemberId: string, publicCode: string): Promise<WithdrawHostApplicationResult> {
    const { data, error } = await this.client.rpc("withdraw_host_application_atomically", {
      p_gaming_member_id: gamingMemberId,
      p_public_code: publicCode,
    });
    if (error) throw translateError(error);
    const row = firstRow<any>(data);
    if (!row) throw new Error("withdraw_host_application_atomically returned no row.");
    return { publicCode: row.public_code, state: "WITHDRAWN", alreadyWithdrawn: row.already_withdrawn };
  }

  async getStatus(gamingMemberId: string): Promise<HostStatusRecord | null> {
    const { data, error } = await this.client.rpc("get_host_status", { p_gaming_member_id: gamingMemberId });
    if (error) throw translateError(error);
    const row = firstRow<any>(data);
    if (!row) return null;
    return {
      publicCode: row.public_code,
      state: row.state,
      venueName: row.venue_name,
      cityArea: row.city_area,
      playingFields: row.playing_fields,
      venueDescription: row.venue_description,
      expectedWindow: row.expected_window,
      expectedTeamCount: row.expected_team_count,
      submittedAt: row.submitted_at,
      decidedAt: row.decided_at ?? null,
      withdrawnAt: row.withdrawn_at ?? null,
      capabilityState: row.capability_state ?? null,
      competitionName: row.competition_name ?? null,
      competitionPublicCode: row.competition_public_code ?? null,
      competitionState: row.competition_state ?? null,
    };
  }

  async listForReview(reviewerGamingMemberId: string, view: HostReviewView): Promise<HostReviewRecord[]> {
    const { data, error } = await this.client.rpc("list_host_applications_for_review", {
      p_reviewer_gaming_member_id: reviewerGamingMemberId,
      p_view: view,
    });
    if (error) throw translateError(error);
    return ((data ?? []) as any[]).map((row) => ({
      publicCode: row.public_code,
      state: row.state,
      applicantDisplayName: row.applicant_display_name,
      venueName: row.venue_name,
      cityArea: row.city_area,
      playingFields: row.playing_fields,
      venueDescription: row.venue_description,
      expectedWindow: row.expected_window,
      expectedTeamCount: row.expected_team_count,
      submittedAt: row.submitted_at,
      decidedAt: row.decided_at ?? null,
      decidedByDisplayName: row.decided_by_display_name ?? null,
      decisionReason: row.decision_reason ?? null,
      withdrawnAt: row.withdrawn_at ?? null,
      capabilityState: row.capability_state ?? null,
      capabilityGrantedAt: row.capability_granted_at ?? null,
      capabilityConsumedAt: row.capability_consumed_at ?? null,
      capabilityRevokedAt: row.capability_revoked_at ?? null,
      capabilityRevokeReason: row.capability_revoke_reason ?? null,
      competitionName: row.competition_name ?? null,
      competitionState: row.competition_state ?? null,
    }));
  }

  async decideApplication(
    reviewerGamingMemberId: string,
    publicCode: string,
    decision: HostDecision,
    reason: string | null
  ): Promise<DecideHostApplicationResult> {
    const { data, error } = await this.client.rpc("decide_host_application_atomically", {
      p_reviewer_gaming_member_id: reviewerGamingMemberId,
      p_public_code: publicCode,
      p_decision: decision,
      p_reason: reason,
    });
    if (error) throw translateError(error);
    const row = firstRow<any>(data);
    if (!row) throw new Error("decide_host_application_atomically returned no row.");
    return {
      publicCode: row.public_code,
      state: row.state,
      capabilityState: row.capability_state ?? null,
      alreadyDecided: row.already_decided,
    };
  }

  async revokeCapability(reviewerGamingMemberId: string, publicCode: string, reason: string): Promise<RevokeHostCapabilityResult> {
    const { data, error } = await this.client.rpc("revoke_host_capability_atomically", {
      p_reviewer_gaming_member_id: reviewerGamingMemberId,
      p_public_code: publicCode,
      p_reason: reason,
    });
    if (error) throw translateError(error);
    const row = firstRow<any>(data);
    if (!row) throw new Error("revoke_host_capability_atomically returned no row.");
    return { publicCode: row.public_code, capabilityState: "REVOKED", alreadyRevoked: row.already_revoked };
  }

  async createHostCompetition(
    hostGamingMemberId: string,
    name: string,
    activityKey: string,
    publicCode: string
  ): Promise<CreateHostCompetitionResult> {
    const { data, error } = await this.client.rpc("create_host_competition_atomically", {
      p_host_gaming_member_id: hostGamingMemberId,
      p_name: name,
      p_activity_key: activityKey,
      p_public_code: publicCode,
    });
    if (error) throw translateError(error);
    const row = firstRow<any>(data);
    if (!row) throw new Error("create_host_competition_atomically returned no row.");
    return { competitionId: row.competition_id, state: row.state, createdAt: row.created_at };
  }
}
