/**
 * Community Voting — Experience Instance contract types (UG-IV-GATE-002).
 *
 * Accepted ownership (Design B1):
 *   - Experience Instance (this module): access, verified-voter binding,
 *     eligibility and recovery metadata for ONE Session.
 *   - Session: capability declaration, host authority, lifecycle, close,
 *     reveal and completion. Never re-implemented here.
 *   - Voting Interaction: candidates, authoritative votes and tally. Never
 *     re-implemented here — every accepted vote is written by the unchanged
 *     `cast_vote_atomically`.
 *   - Supabase Auth: identity.  - Gaming Member: optional profile (never
 *     created or required by anything in this module).
 *
 * There is deliberately no lifecycle state on an Instance, no ballot, no
 * tally and no vote store here.
 *
 * GATE-003 (Canon: IDENTITY_VOTING_LITERAL_PREPARATION_AND_ATOMIC_START_ACCEPTED): PROMPT_ACTIVE means
 * Voting is actually open. Everything that prepares a ballot — the entries and a verified, host-confirmed
 * contestant for each — happens BEFORE it, in "preparation entries" that are readiness data only (they
 * are not candidates and not votes). One explicit, host-authorized, atomic start then materializes the
 * authoritative Voting candidates, already attributed, and opens the Session's Voting interaction.
 * Nothing about the ballot or its attribution can change afterwards, and Community Voting has no
 * "open but still preparing" phase: open, closed and published derive from Session and Voting alone.
 */

/** Synthetic-or-venue geofence facts stored on an Instance. Thresholds are configuration, not policy. */
export interface GeofenceConfig {
  venueLatitude: number;
  venueLongitude: number;
  venueRadiusMeters: number;
  /** Readings reporting a larger accuracy radius than this are rejected outright. */
  maxAccuracyMeters: number;
  /** INSIDE requires distance + insideMarginFactor * accuracy <= radius. */
  insideMarginFactor: number;
  /** OUTSIDE requires distance - outsideMarginFactor * accuracy > radius. Anything between is AMBIGUOUS. */
  outsideMarginFactor: number;
}

export interface CommunityVotingInstanceRecord extends GeofenceConfig {
  instanceId: string;
  sessionId: string;
  /** Explicit, immutable rule version stamped at registration. */
  ruleVersion: number;
  createdAt: string;
}

/** An untrusted client claim about position. Never persisted, logged or echoed. */
export interface LocationClaim {
  latitude: number;
  longitude: number;
  accuracyMeters: number;
}

export type LocationDecision = "INSIDE" | "OUTSIDE" | "AMBIGUOUS" | "ACCURACY_EXCESSIVE";

/** What a verified server-side Auth lookup establishes about the caller. Never client-claimed. */
export interface VerifiedVoterIdentity {
  authUserId: string;
  /** True only when the Auth user has a phone number AND it has been confirmed. */
  phoneVerified: boolean;
}

export interface VoterBindingResult {
  bindingId: string;
  instanceId: string;
  /** False when the binding already existed (idempotent bind / recovery). */
  created: boolean;
}

export interface IssuedIntent {
  bindingId: string;
  intentNo: number;
}

/**
 * APPLIED   - a new Voting transition was written by cast_vote_atomically.
 * UNCHANGED - the voter re-selected their current candidate: the intent is
 *             consumed (it supersedes older intents) but NO Voting transition occurs.
 * REPLAYED  - the same already-committed intent was presented again: the
 *             authoritative result is returned and nothing is written.
 */
export type CastOutcome = "APPLIED" | "UNCHANGED" | "REPLAYED";

export interface CastCommunityVoteInput {
  instanceId: string;
  bindingId: string;
  intentNo: number;
  interactionInstanceId: string;
  candidateId: string;
  location: LocationClaim;
}

export interface CastCommunityVoteResult {
  outcome: CastOutcome;
  bindingId: string;
  /** The intent this response is about (== appliedIntentNo for every successful outcome). */
  intentNo: number;
  interactionInstanceId: string;
  candidateId: string;
  /** From the authoritative Voting store (votes.updated_at). */
  voteUpdatedAt: string;
}

/** Bounded snapshot of one caller's own participation. Contains no token, no label, no other voter. */
export interface VoterStatusSnapshot {
  instanceId: string;
  bindingId: string;
  sessionState: string;
  interactionInstanceId: string | null;
  interactionState: string | null;
  engineType: string | null;
  issuedIntentNo: number;
  appliedIntentNo: number;
  myCandidateId: string | null;
  /** The caller's OWN preparation entry, if any: its label and state. Never a secret, never another voter's. */
  myEntry: { label: string; state: "PENDING_CONFIRMATION" | "CONFIRMED" } | null;
}

/**
 * Derived from the Session and the Voting interaction ALONE. NOT_OPEN covers everything before the Session
 * has opened Voting — including a fully prepared and confirmed ballot. There is no preparation phase.
 */
export type VotingPhase = "NOT_OPEN" | "OPEN" | "CLOSED" | "PUBLISHED" | "ENDED";

export interface CommunityVotingStatus {
  bound: boolean;
  instanceId: string;
  phase: VotingPhase | null;
  interactionInstanceId: string | null;
  candidates: Array<{ candidateId: string; ordinal: number; label: string }> | null;
  myCandidateId: string | null;
  myEntry: { label: string; state: "PENDING_CONFIRMATION" | "CONFIRMED" } | null;
  intents: { issued: number; applied: number } | null;
  bindingId: string | null;
  /** Present only once the Session has revealed the Voting interaction (mirrors GET_SESSION's reveal gate). */
  results: Array<{ candidateId: string; label: string; voteCount: number; rank: number }> | null;
}

/** A preparation entry's lifecycle, entirely before opening. */
export type EntryState = "UNCLAIMED" | "PENDING_CONFIRMATION" | "CONFIRMED";

/** What the HOST sees of an entry: no phone, no Auth id, no binding or Participant, no secret. */
export interface PreparationEntry {
  entryId: string;
  label: string;
  state: EntryState;
  /** True while an unclaimed entry still holds a usable (unexpired) claim credential. */
  claimable: boolean;
  claimExpiresAt: string | null;
}

export interface PreparationView {
  entries: PreparationEntry[];
  readiness: { entryCount: number; confirmedCount: number; ready: boolean };
}

/** Returned ONCE, to the host. The credential is never stored in the clear and never appears again. */
export interface CreatedEntry {
  entryId: string;
  label: string;
  claimCode: string;
  claimExpiresAt: string;
}

/** Returned ONCE, to the claimant. The host needs it, from the claimant's own screen, to confirm. */
export interface ClaimedEntry {
  label: string;
  confirmationCode: string;
  confirmExpiresAt: string;
}

export interface ConfirmedEntry {
  entryId: string;
  state: "CONFIRMED";
}

export interface StartedVoting {
  interactionInstanceId: string;
  promptId: string;
  state: "PROMPT_ACTIVE";
  segmentNumber: number;
  candidateCount: number;
}

export interface RegisterInstanceInput {
  sessionId: string;
  hostToken: string;
  config: GeofenceConfig;
  ruleVersion: number;
}

/**
 * Closed set of Community Voting failure codes. Each maps 1:1 to a
 * `CV_<CODE>:` SQL exception in the authoritative migration functions and
 * to one HTTP status in httpSupport.ts. No code ever carries a coordinate,
 * a phone number, an Auth id, a token or a candidate selection.
 */
export type CommunityVotingErrorCode =
  | "AUTHENTICATION_REQUIRED"
  | "VERIFIED_PHONE_REQUIRED"
  | "INVALID_REQUEST"
  | "INVALID_GEOFENCE_CONFIG"
  | "INSTANCE_NOT_FOUND"
  | "INSTANCE_ALREADY_REGISTERED"
  | "PARTICIPANTS_ALREADY_EXIST"
  | "CAPABILITY_SET_NOT_EXACTLY_VOTING"
  | "SESSION_NOT_REGISTRABLE"
  | "ADMISSION_CLOSED"
  | "NOT_BOUND"
  // preparation, claim and confirmation
  | "PREPARATION_CLOSED"
  | "ENTRY_NOT_FOUND"
  | "ENTRY_LABEL_INVALID"
  | "ENTRY_LABEL_DUPLICATE"
  | "CLAIM_INVALID"
  | "CLAIM_EXPIRED"
  | "CLAIM_VOIDED"
  | "CONTESTANT_ALREADY_HAS_ENTRY"
  | "CONFIRMATION_NOT_PENDING"
  | "CONFIRMATION_REJECTED"
  // the explicit start
  | "PREPARATION_INCOMPLETE"
  | "SESSION_NOT_STARTABLE"
  | "ALREADY_OPENED"
  // voting
  | "VOTING_NOT_OPEN"
  | "INTERACTION_MISMATCH"
  | "INTENT_UNISSUED"
  | "INTENT_BINDING_MISMATCH"
  | "INTENT_PAYLOAD_MISMATCH"
  | "STALE_INTENT"
  | "INVALID_LOCATION_READING"
  | "LOCATION_ACCURACY_EXCESSIVE"
  | "LOCATION_OUTSIDE"
  | "LOCATION_AMBIGUOUS"
  // an invariant the database guarantees was found broken: always fails closed, never accepts the operation
  | "STATE_INCONSISTENT"
  // ---- two-round pilot (UG-IV-GATE-004A / 005 / 005A): authority, identity, schedule, media, policies, the rounds, the cut, the review
  | "NOT_A_ROUND"
  | "WRONG_ROUND"
  | "OPERATOR_REQUIRED"
  | "OPERATOR_NOT_CONFIGURED"
  | "VERIFIED_EMAIL_REQUIRED"
  | "PROFILE_INCOMPLETE"
  | "CLAIM_RATE_LIMITED"
  | "SCHEDULE_INVALID"
  | "SCHEDULE_REQUIRED"
  | "CUTOFF_PASSED"
  | "ALIAS_EXHAUSTED"
  | "ENTRY_HAS_MEDIA"
  | "ENTRY_ALREADY_WITHDRAWN"
  | "PHOTO_INVALID"
  | "PHOTO_REQUIRED"
  | "PHOTO_HIDDEN"
  | "PHOTO_NOT_FOUND"
  | "CONSENT_REQUIRED"
  | "CONSENT_ALREADY_RECORDED"
  | "DECISION_ALREADY_RECORDED"
  | "POLICY_REQUIRED"
  | "POLICY_ALREADY_RECORDED"
  | "CANDIDATE_NOT_AVAILABLE"
  | "VOTING_WINDOW_ELAPSED"
  | "NO_ELIGIBLE_ENTRIES"
  | "FINALISTS_NOT_SELECTED"
  | "ALREADY_CLOSED"
  | "RESULTS_NOT_AVAILABLE"
  | "REVIEW_REQUIRED"
  | "REVIEW_STALE"
  | "NO_VALID_RESULT"
  | "ALREADY_PUBLISHED"
  // ---- UG-IV-GATE-010: the operator's geofence setup and the test event
  | "GEOFENCE_FROZEN"
  | "NOT_A_FINAL"
  | "TEST_MODE_MISMATCH"
  // ---- UG-IV-GATE-018: the four-category contest (categories, groups, one candidacy per person)
  | "NOT_A_CATEGORY_ROUND"
  | "CONTEST_NOT_FOUND"
  | "CATEGORY_ALREADY_REGISTERED"
  | "WRONG_CATEGORY"
  | "WRONG_ENTRY_KIND"
  | "GROUP_FULL"
  | "ALREADY_CANDIDATE"
  | "OBSOLETE_FOR_CATEGORY"
  // ---- UG-IV-GATE-018 addendum: self-registration
  | "REGISTRATION_NOT_OPEN";

/**
 * What a conflict says about the INTENT itself — kept strictly apart from `current`, the caller's present vote state.
 *
 *   HISTORICAL_OUTCOME_UNAVAILABLE  - the intent is older than the last applied one. The server keeps only the last
 *                                     applied intent, so it cannot say whether this one was ever applied. It says so,
 *                                     and never reports success or the current candidate as this intent's result.
 *   APPLIED_WITH_DIFFERENT_PAYLOAD  - this exact intent number WAS applied, but with another payload.
 */
export type IntentOutcome = "HISTORICAL_OUTCOME_UNAVAILABLE" | "APPLIED_WITH_DIFFERENT_PAYLOAD";

export class CommunityVotingError extends Error {
  readonly code: CommunityVotingErrorCode;
  /** For STALE_INTENT / INTENT_PAYLOAD_MISMATCH: the caller's own current state, so a losing device can reconcile. */
  readonly current: VoterStatusSnapshot | null;
  /** For a conflicting intent: what is (and is not) known about THAT intent. See IntentOutcome. */
  readonly intentOutcome: IntentOutcome | null;

  constructor(
    code: CommunityVotingErrorCode,
    message?: string,
    current: VoterStatusSnapshot | null = null,
    intentOutcome: IntentOutcome | null = null
  ) {
    super(message ?? code);
    this.name = "CommunityVotingError";
    this.code = code;
    this.current = current;
    this.intentOutcome = intentOutcome;
  }
}

const UUID_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Shape check only (any uuid version). Used to reject malformed ids before they reach the database. */
export function isUuidLike(value: unknown): value is string {
  return typeof value === "string" && UUID_SHAPE.test(value);
}
