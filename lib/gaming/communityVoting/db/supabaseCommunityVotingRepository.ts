import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

import {
  HostTokenMismatchError,
  InvalidCandidateSelectionError,
  PromptNotActiveError,
  SelfVoteNotAllowedError,
  SessionNotFoundError,
} from "../../../session/types";
import type {
  CastCommunityVoteInput,
  CastCommunityVoteResult,
  CastOutcome,
  ClaimedEntry,
  CommunityVotingErrorCode,
  CommunityVotingInstanceRecord,
  ConfirmedEntry,
  CreatedEntry,
  EntryState,
  IssuedIntent,
  PreparationEntry,
  RegisterInstanceInput,
  StartedVoting,
  VoterBindingResult,
  VoterStatusSnapshot,
} from "../types";
import { CommunityVotingError } from "../types";
import type { CommunityVotingRepository } from "./communityVotingRepository";

const KNOWN_CODES: ReadonlySet<string> = new Set<CommunityVotingErrorCode>([
  "AUTHENTICATION_REQUIRED",
  "VERIFIED_PHONE_REQUIRED",
  "INVALID_REQUEST",
  "INVALID_GEOFENCE_CONFIG",
  "INSTANCE_NOT_FOUND",
  "INSTANCE_ALREADY_REGISTERED",
  "PARTICIPANTS_ALREADY_EXIST",
  "CAPABILITY_SET_NOT_EXACTLY_VOTING",
  "SESSION_NOT_REGISTRABLE",
  "ADMISSION_CLOSED",
  "NOT_BOUND",
  "PREPARATION_CLOSED",
  "ENTRY_NOT_FOUND",
  "ENTRY_LABEL_INVALID",
  "ENTRY_LABEL_DUPLICATE",
  "CLAIM_INVALID",
  "CLAIM_EXPIRED",
  "CLAIM_VOIDED",
  "CONTESTANT_ALREADY_HAS_ENTRY",
  "CONFIRMATION_NOT_PENDING",
  "CONFIRMATION_REJECTED",
  "PREPARATION_INCOMPLETE",
  "SESSION_NOT_STARTABLE",
  "ALREADY_OPENED",
  "VOTING_NOT_OPEN",
  "INTERACTION_MISMATCH",
  "INTENT_UNISSUED",
  "INTENT_BINDING_MISMATCH",
  "INTENT_PAYLOAD_MISMATCH",
  "STALE_INTENT",
  "INVALID_LOCATION_READING",
  "LOCATION_ACCURACY_EXCESSIVE",
  "LOCATION_OUTSIDE",
  "LOCATION_AMBIGUOUS",
  "STATE_INCONSISTENT",
]);

interface PostgrestLikeError {
  code?: string;
  message?: string;
}

/** Messages from the functions this repository calls are fixed texts: "CODE: description". */
function codeFromMessage(message: unknown): string | null {
  if (typeof message !== "string") return null;
  const match = /^([A-Z][A-Z0-9_]+):/.exec(message.trim());
  return match ? match[1] : null;
}

const ENTRY_STATES: ReadonlySet<string> = new Set<EntryState>(["UNCLAIMED", "PENDING_CONFIRMATION", "CONFIRMED"]);

/**
 * Supabase-backed Community Voting repository. Always constructed with the service_role key, like
 * every other repository here: these tables and functions are reached only from the server.
 *
 * Each method is exactly one RPC, so each operation is atomic in the database. Raw database errors are
 * NEVER propagated: they can carry statement parameters. Every failure is either translated to a typed
 * error with a fixed message, or reduced to a generic Error naming only the SQLSTATE.
 */
export class SupabaseCommunityVotingRepository implements CommunityVotingRepository {
  protected client: SupabaseClient;

  constructor(supabaseUrl: string, supabaseServiceKey: string) {
    // The platform's no-store override (see every other Supabase repository). Without it Next's patched fetch stores the POST rpc a public
    // GET route makes for a YEAR, so a phase, a publication or a hidden photograph would be answered from the first read ever made.
    this.client = createClient(supabaseUrl, supabaseServiceKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { fetch: (input, init) => fetch(input, { ...init, cache: "no-store" } as RequestInit) },
    });
  }

  protected translate(error: PostgrestLikeError): Error {
    const code = codeFromMessage(error.message);

    if (code && code.startsWith("CV_")) {
      const known = code.slice(3);
      if (KNOWN_CODES.has(known)) {
        return new CommunityVotingError(known as CommunityVotingErrorCode, fixedMessage(known));
      }
    }
    // Existing Session / Voting vocabulary, raised by the host-authority checks and by the delegated
    // cast_vote_atomically, keeps its established meaning.
    switch (code) {
      case "SESSION_NOT_FOUND":
        return new SessionNotFoundError();
      case "HOST_TOKEN_MISMATCH":
        return new HostTokenMismatchError();
      case "SELF_VOTE_NOT_ALLOWED":
        return new SelfVoteNotAllowedError();
      case "INVALID_CANDIDATE_SELECTION":
        return new InvalidCandidateSelectionError();
      case "PROMPT_NOT_ACTIVE":
        return new PromptNotActiveError();
      default:
        return new Error(`Community Voting database error (${error.code ?? "unknown"}).`);
    }
  }

  protected async rows<T>(fn: string, args: Record<string, unknown>): Promise<T[]> {
    const { data, error } = await this.client.rpc(fn, args);
    if (error) throw this.translate(error);
    if (Array.isArray(data)) return data as T[];
    return data ? [data as T] : [];
  }

  async registerInstance(input: RegisterInstanceInput): Promise<CommunityVotingInstanceRecord> {
    const [row] = await this.rows<Record<string, unknown>>("register_community_voting_instance_atomically", {
      p_session_id: input.sessionId,
      p_host_token: input.hostToken,
      p_venue_latitude: input.config.venueLatitude,
      p_venue_longitude: input.config.venueLongitude,
      p_venue_radius_meters: input.config.venueRadiusMeters,
      p_max_accuracy_meters: input.config.maxAccuracyMeters,
      p_inside_margin_factor: input.config.insideMarginFactor,
      p_outside_margin_factor: input.config.outsideMarginFactor,
      p_rule_version: input.ruleVersion,
    });
    return {
      instanceId: row.instance_id as string,
      sessionId: row.session_id as string,
      venueLatitude: row.venue_latitude as number,
      venueLongitude: row.venue_longitude as number,
      venueRadiusMeters: row.venue_radius_meters as number,
      maxAccuracyMeters: row.max_accuracy_meters as number,
      insideMarginFactor: row.inside_margin_factor as number,
      outsideMarginFactor: row.outside_margin_factor as number,
      ruleVersion: row.rule_version as number,
      createdAt: row.created_at as string,
    };
  }

  async bindVoter(input: { instanceId: string; authUserId: string }): Promise<VoterBindingResult> {
    const [row] = await this.rows<Record<string, unknown>>("bind_community_voting_voter_atomically", {
      p_instance_id: input.instanceId,
      p_auth_user_id: input.authUserId,
    });
    return {
      bindingId: row.binding_id as string,
      instanceId: row.instance_id as string,
      created: row.created as boolean,
    };
  }

  async issueIntent(input: { instanceId: string; authUserId: string }): Promise<IssuedIntent> {
    const [row] = await this.rows<Record<string, unknown>>("issue_community_voting_intent_atomically", {
      p_instance_id: input.instanceId,
      p_auth_user_id: input.authUserId,
    });
    return { bindingId: row.binding_id as string, intentNo: row.intent_no as number };
  }

  // ---- preparation

  async createEntry(input: {
    instanceId: string;
    hostToken: string;
    label: string;
    claimTtlSeconds?: number;
  }): Promise<CreatedEntry> {
    const [row] = await this.rows<Record<string, unknown>>("create_community_voting_entry_atomically", {
      p_instance_id: input.instanceId,
      p_host_token: input.hostToken,
      p_label: input.label,
      ...(input.claimTtlSeconds === undefined ? {} : { p_claim_ttl_seconds: input.claimTtlSeconds }),
    });
    return {
      entryId: row.entry_id as string,
      label: row.label as string,
      claimCode: row.claim_code as string,
      claimExpiresAt: row.claim_expires_at as string,
    };
  }

  async removeEntry(input: { instanceId: string; hostToken: string; entryId: string }): Promise<void> {
    await this.rows<Record<string, unknown>>("remove_community_voting_entry_atomically", {
      p_instance_id: input.instanceId,
      p_host_token: input.hostToken,
      p_entry_id: input.entryId,
    });
  }

  async readPreparation(input: { instanceId: string; hostToken: string }): Promise<PreparationEntry[]> {
    const rows = await this.rows<Record<string, unknown>>("read_community_voting_preparation", {
      p_instance_id: input.instanceId,
      p_host_token: input.hostToken,
    });
    return rows.map((row) => {
      if (!ENTRY_STATES.has(row.state as string)) {
        throw new CommunityVotingError("STATE_INCONSISTENT", fixedMessage("STATE_INCONSISTENT"));
      }
      return {
        entryId: row.entry_id as string,
        label: row.label as string,
        state: row.state as EntryState,
        claimable: Boolean(row.claimable),
        claimExpiresAt: (row.claim_expires_at as string | null) ?? null,
      };
    });
  }

  async claimEntry(input: { instanceId: string; authUserId: string; claimCode: string }): Promise<ClaimedEntry> {
    const [row] = await this.rows<Record<string, unknown>>("claim_community_voting_entry_atomically", {
      p_instance_id: input.instanceId,
      p_auth_user_id: input.authUserId,
      p_claim_code: input.claimCode,
    });
    return {
      label: row.label as string,
      confirmationCode: row.confirmation_code as string,
      confirmExpiresAt: row.confirm_expires_at as string,
    };
  }

  async confirmEntry(input: {
    instanceId: string;
    hostToken: string;
    entryId: string;
    confirmationCode: string;
  }): Promise<ConfirmedEntry> {
    const [row] = await this.rows<Record<string, unknown>>("confirm_community_voting_entry_atomically", {
      p_instance_id: input.instanceId,
      p_host_token: input.hostToken,
      p_entry_id: input.entryId,
      p_confirmation_code: input.confirmationCode,
    });
    // A mismatch is a normal RETURN from the function (so the attempt count survives); it becomes an error here.
    switch (row.outcome) {
      case "CONFIRMED":
        return { entryId: row.entry_id as string, state: "CONFIRMED" };
      case "REJECTED":
        throw new CommunityVotingError("CONFIRMATION_REJECTED", fixedMessage("CONFIRMATION_REJECTED"));
      case "VOIDED":
        throw new CommunityVotingError("CLAIM_VOIDED", fixedMessage("CLAIM_VOIDED"));
      default:
        throw new CommunityVotingError("STATE_INCONSISTENT", fixedMessage("STATE_INCONSISTENT"));
    }
  }

  // ---- opening

  async startVoting(input: { instanceId: string; hostToken: string; promptText: string }): Promise<StartedVoting> {
    const [row] = await this.rows<Record<string, unknown>>("start_community_voting_atomically", {
      p_instance_id: input.instanceId,
      p_host_token: input.hostToken,
      p_prompt_text: input.promptText,
    });
    return {
      interactionInstanceId: row.interaction_instance_id as string,
      promptId: row.prompt_id as string,
      state: row.state as "PROMPT_ACTIVE",
      segmentNumber: row.segment_ordinal as number,
      candidateCount: row.candidate_count as number,
    };
  }

  // ---- voting

  async castVote(input: CastCommunityVoteInput & { authUserId: string }): Promise<CastCommunityVoteResult> {
    let rows: Record<string, unknown>[];
    try {
      rows = await this.rows<Record<string, unknown>>("cast_community_voting_vote_atomically", {
        p_instance_id: input.instanceId,
        p_auth_user_id: input.authUserId,
        p_binding_id: input.bindingId,
        p_intent_no: input.intentNo,
        p_interaction_instance_id: input.interactionInstanceId,
        p_candidate_id: input.candidateId,
        p_latitude: input.location.latitude,
        p_longitude: input.location.longitude,
        p_accuracy_meters: input.location.accuracyMeters,
      });
    } catch (err) {
      // A losing device needs to reconcile. Attach the caller's OWN current state, and say — separately and
      // honestly — what is known about the INTENT: that this number was applied with another payload, or that it
      // is older than the last applied intent and its own fate is not recorded. Neither is ever dressed up as a
      // success, and neither claims that the current candidate is this intent's result.
      if (err instanceof CommunityVotingError && (err.code === "STALE_INTENT" || err.code === "INTENT_PAYLOAD_MISMATCH")) {
        const current = await this.readVoterStatus({ instanceId: input.instanceId, authUserId: input.authUserId });
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
      outcome: row.outcome as CastOutcome,
      bindingId: row.binding_id as string,
      intentNo: row.intent_no as number,
      interactionInstanceId: row.interaction_instance_id as string,
      candidateId: row.candidate_id as string,
      voteUpdatedAt: row.vote_updated_at as string,
    };
  }

  async readVoterStatus(input: { instanceId: string; authUserId: string }): Promise<VoterStatusSnapshot | null> {
    const rows = await this.rows<Record<string, unknown>>("read_community_voting_voter_status", {
      p_instance_id: input.instanceId,
      p_auth_user_id: input.authUserId,
    });
    if (rows.length === 0) return null;
    const row = rows[0];
    const entryLabel = (row.my_entry_label as string | null) ?? null;
    const entryState = (row.my_entry_state as string | null) ?? null;
    return {
      instanceId: row.instance_id as string,
      bindingId: row.binding_id as string,
      sessionState: row.session_state as string,
      interactionInstanceId: (row.interaction_instance_id as string | null) ?? null,
      interactionState: (row.interaction_state as string | null) ?? null,
      engineType: (row.engine_type as string | null) ?? null,
      issuedIntentNo: row.issued_intent_no as number,
      appliedIntentNo: row.applied_intent_no as number,
      myCandidateId: (row.my_candidate_id as string | null) ?? null,
      myEntry:
        entryLabel !== null && (entryState === "PENDING_CONFIRMATION" || entryState === "CONFIRMED")
          ? { label: entryLabel, state: entryState }
          : null,
    };
  }
}

const FIXED_MESSAGES: Record<string, string> = {
  INSTANCE_NOT_FOUND: "No Community Voting Instance exists for this id.",
  INSTANCE_ALREADY_REGISTERED: "This session already has a Community Voting Instance.",
  PARTICIPANTS_ALREADY_EXIST: "An Instance must be registered before any Participant exists.",
  CAPABILITY_SET_NOT_EXACTLY_VOTING: "The declared capability set must be exactly VOTING.",
  SESSION_NOT_REGISTRABLE: "This session cannot be registered in its current state.",
  ADMISSION_CLOSED: "New voters are not admitted in this state.",
  NOT_BOUND: "This identity is not bound to the Instance.",
  PREPARATION_CLOSED: "Voting has opened; the ballot can no longer change.",
  ENTRY_NOT_FOUND: "This ballot has no such entry.",
  ENTRY_LABEL_INVALID: "An entry label must be 1 to 60 characters.",
  ENTRY_LABEL_DUPLICATE: "This ballot already has an entry with that label.",
  CLAIM_INVALID: "This claim is not valid.",
  CLAIM_EXPIRED: "This claim has expired.",
  CLAIM_VOIDED: "Too many wrong confirmation codes: this claim is void. Remove the entry and create it again.",
  CONTESTANT_ALREADY_HAS_ENTRY: "This identity already holds an entry in this ballot.",
  CONFIRMATION_NOT_PENDING: "This entry has no claim waiting for confirmation.",
  CONFIRMATION_REJECTED: "The confirmation code does not match.",
  PREPARATION_INCOMPLETE:
    "The ballot needs at least two entries and every entry must have a confirmed contestant.",
  SESSION_NOT_STARTABLE: "The Session must be locked before Voting can start.",
  ALREADY_OPENED: "Voting has already opened for this event.",
  VOTING_NOT_OPEN: "Voting is not open.",
  INTERACTION_MISMATCH: "The stated interaction is not the current Voting interaction.",
  INTENT_UNISSUED: "This intent was not issued to this binding.",
  INTENT_BINDING_MISMATCH: "The intent does not belong to this voter binding.",
  INTENT_PAYLOAD_MISMATCH: "This intent was already applied with a different payload.",
  STALE_INTENT: "A newer intent has already been applied.",
  INVALID_LOCATION_READING: "The location reading is missing, malformed or not accepted.",
  LOCATION_ACCURACY_EXCESSIVE: "The reading is too imprecise to be accepted.",
  LOCATION_OUTSIDE: "The reading is outside the event area.",
  LOCATION_AMBIGUOUS: "The reading cannot be confirmed inside or outside the event area.",
  INVALID_REQUEST: "The request is not valid.",
  INVALID_GEOFENCE_CONFIG: "The geofence configuration is missing or out of range.",
  STATE_INCONSISTENT: "The event's stored state is inconsistent; the operation was refused.",
};

function fixedMessage(code: string): string {
  return FIXED_MESSAGES[code] ?? "The request could not be completed.";
}
