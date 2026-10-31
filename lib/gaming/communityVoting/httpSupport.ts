import {
  HostTokenMismatchError,
  InvalidCandidateSelectionError,
  PromptNotActiveError,
  SelfVoteNotAllowedError,
  SessionNotFoundError,
} from "../../session/types";
import type { CommunityVotingErrorCode, IntentOutcome, VoterStatusSnapshot } from "./types";
import { CommunityVotingError } from "./types";

/** Per-user responses are never cacheable. */
export const NO_STORE = { "Cache-Control": "no-store" } as const;

const STATUS_BY_CODE: Record<CommunityVotingErrorCode, number> = {
  AUTHENTICATION_REQUIRED: 401,
  VERIFIED_PHONE_REQUIRED: 403,
  INVALID_REQUEST: 400,
  INVALID_GEOFENCE_CONFIG: 400,
  INSTANCE_NOT_FOUND: 404,
  INSTANCE_ALREADY_REGISTERED: 409,
  PARTICIPANTS_ALREADY_EXIST: 409,
  CAPABILITY_SET_NOT_EXACTLY_VOTING: 409,
  SESSION_NOT_REGISTRABLE: 409,
  ADMISSION_CLOSED: 409,
  NOT_BOUND: 404,
  PREPARATION_CLOSED: 409,
  ENTRY_NOT_FOUND: 404,
  ENTRY_LABEL_INVALID: 400,
  ENTRY_LABEL_DUPLICATE: 409,
  CLAIM_INVALID: 403,
  CLAIM_EXPIRED: 409,
  CLAIM_VOIDED: 409,
  CONTESTANT_ALREADY_HAS_ENTRY: 409,
  CONFIRMATION_NOT_PENDING: 409,
  CONFIRMATION_REJECTED: 403,
  PREPARATION_INCOMPLETE: 409,
  SESSION_NOT_STARTABLE: 409,
  ALREADY_OPENED: 409,
  VOTING_NOT_OPEN: 409,
  INTERACTION_MISMATCH: 409,
  INTENT_UNISSUED: 400,
  INTENT_BINDING_MISMATCH: 403,
  INTENT_PAYLOAD_MISMATCH: 409,
  STALE_INTENT: 409,
  INVALID_LOCATION_READING: 400,
  LOCATION_ACCURACY_EXCESSIVE: 400,
  LOCATION_OUTSIDE: 403,
  LOCATION_AMBIGUOUS: 422,
  STATE_INCONSISTENT: 500,
  NOT_A_ROUND: 409,
  WRONG_ROUND: 409,
  OPERATOR_REQUIRED: 403,
  OPERATOR_NOT_CONFIGURED: 503,
  VERIFIED_EMAIL_REQUIRED: 403,
  PROFILE_INCOMPLETE: 403,
  CLAIM_RATE_LIMITED: 429,
  SCHEDULE_INVALID: 400,
  SCHEDULE_REQUIRED: 409,
  CUTOFF_PASSED: 409,
  ALIAS_EXHAUSTED: 409,
  ENTRY_HAS_MEDIA: 409,
  ENTRY_ALREADY_WITHDRAWN: 409,
  PHOTO_INVALID: 400,
  PHOTO_REQUIRED: 409,
  PHOTO_HIDDEN: 409,
  PHOTO_NOT_FOUND: 404,
  CONSENT_REQUIRED: 409,
  CONSENT_ALREADY_RECORDED: 409,
  DECISION_ALREADY_RECORDED: 409,
  POLICY_REQUIRED: 409,
  POLICY_ALREADY_RECORDED: 409,
  CANDIDATE_NOT_AVAILABLE: 409,
  VOTING_WINDOW_ELAPSED: 409,
  NO_ELIGIBLE_ENTRIES: 409,
  FINALISTS_NOT_SELECTED: 409,
  ALREADY_CLOSED: 409,
  RESULTS_NOT_AVAILABLE: 409,
  NO_VALID_RESULT: 409,
  REVIEW_REQUIRED: 409,
  REVIEW_STALE: 409,
  ALREADY_PUBLISHED: 409,
  GEOFENCE_FROZEN: 409,
  NOT_A_FINAL: 409,
  TEST_MODE_MISMATCH: 409,
  NOT_A_CATEGORY_ROUND: 409,
  CONTEST_NOT_FOUND: 404,
  CATEGORY_ALREADY_REGISTERED: 409,
  WRONG_CATEGORY: 409,
  WRONG_ENTRY_KIND: 409,
  GROUP_FULL: 409,
  ALREADY_CANDIDATE: 409,
  OBSOLETE_FOR_CATEGORY: 409,
  REGISTRATION_NOT_OPEN: 409,
};

/**
 * Maps a known error to its HTTP status and stable code; null when unrecognized. Besides this module's
 * own errors it recognises the existing Session/Voting errors the delegated operations can raise, so
 * those keep their established meaning.
 */
export function statusForCommunityVotingError(err: unknown): { status: number; code: string } | null {
  if (err instanceof CommunityVotingError) {
    return { status: STATUS_BY_CODE[err.code], code: err.code };
  }
  if (err instanceof HostTokenMismatchError) return { status: 403, code: "HOST_TOKEN_MISMATCH" };
  if (err instanceof SessionNotFoundError) return { status: 404, code: "SESSION_NOT_FOUND" };
  if (err instanceof SelfVoteNotAllowedError) return { status: 400, code: "SELF_VOTE_NOT_ALLOWED" };
  if (err instanceof InvalidCandidateSelectionError) return { status: 400, code: "INVALID_CANDIDATE_SELECTION" };
  if (err instanceof PromptNotActiveError) return { status: 409, code: "VOTING_NOT_OPEN" };
  return null;
}

/**
 * The response body for a mapped error. Messages are this module's fixed texts; a conflict also carries
 * the CALLER'S OWN current state (never another voter's, never a token). Unknown errors get a generic body.
 */
export function communityVotingErrorBody(err: unknown): {
  error: string;
  code: string;
  intentOutcome?: IntentOutcome;
  current?: VoterStatusSnapshot;
} {
  const mapped = statusForCommunityVotingError(err);
  if (!mapped) return { error: "Request failed.", code: "INTERNAL_ERROR" };
  const message = err instanceof Error ? err.message : "Request failed.";
  if (err instanceof CommunityVotingError && (err.current || err.intentOutcome)) {
    // `intentOutcome` says what is (and is not) known about THE INTENT; `current` is the caller's present vote
    // state. They are separate fields on purpose: a stale conflict must never read as "this intent chose that".
    return {
      error: message,
      code: mapped.code,
      ...(err.intentOutcome ? { intentOutcome: err.intentOutcome } : {}),
      ...(err.current ? { current: err.current } : {}),
    };
  }
  return { error: message, code: mapped.code };
}

/** Resolves any thrown value to a status and body, logging unrecognized failures WITHOUT their payload. */
export function toHttpErrorResponse(
  err: unknown,
  label: string
): { status: number; body: { error: string; code: string; intentOutcome?: IntentOutcome; current?: VoterStatusSnapshot } } {
  const mapped = statusForCommunityVotingError(err);
  if (mapped) return { status: mapped.status, body: communityVotingErrorBody(err) };

  // Log the failure's class only. A request body carries a coordinate; an error object can carry a
  // query parameter. Neither may reach a log line.
  const name = err instanceof Error ? err.name : typeof err;
  console.error(`${label} failed (${name}).`);
  return { status: 500, body: { error: "Request failed.", code: "INTERNAL_ERROR" } };
}

export function getSupabaseCredentials(): { url: string; serviceKey: string } | null {
  const url = process.env.SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceKey) return null;
  return { url, serviceKey };
}
