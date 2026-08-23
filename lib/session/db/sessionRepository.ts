import type {
  SessionRecord,
  SessionState,
  InteractionState,
  EngineType,
  VotingCandidateSummary,
  VotingResultSummary,
  SegmentTarget,
  StartTurnConfig,
  DuelRecord,
  DuelMechanicKey,
  DuelLifecycleState,
  DuelTerminalResolution,
  DuelExceptionalResolution,
} from "../types";

export interface SessionEventRecord {
  sessionId: string;
  eventType: string;
  payload: Record<string, unknown>;
}

export interface ParticipantRecord {
  participantId: string;
  sessionId: string;
  displayName: string;
  normalizedDisplayName: string;
  participantToken: string;
  joinedAt: string;
  /**
   * URBANO Gaming Identity Foundation. Null for a Guest participant
   * (unchanged from every pre-Identity-Foundation row and code path).
   * Set to the joining Gaming Member's id for an authenticated join —
   * see 0046's migration comment for the FK/on-delete-set-null/
   * one-per-Session enforcement this links into.
   */
  gamingMemberId: string | null;
}

export interface ParticipantJoinedEventRecord extends SessionEventRecord {
  eventType: "PARTICIPANT_JOINED";
  payload: {
    participantId: string;
    displayName: string;
  };
}

export interface LobbyLockedEventRecord extends SessionEventRecord {
  eventType: "LOBBY_LOCKED";
  payload: Record<string, never>;
}

export interface SessionCompletedEventRecord extends SessionEventRecord {
  eventType: "SESSION_COMPLETED";
  payload: Record<string, never>;
}

export interface PromptRecord {
  promptId: string;
  text: string;
}

/**
 * Slice 001 (Session / Interaction separation). One executable Open
 * Response interaction inside a session. Sessions may now run zero,
 * one, or many of these sequentially — each owns its own prompt and
 * its own PROMPT_ACTIVE / SUBMISSIONS_CLOSED / RESULT_REVEAL
 * lifecycle, independent of the session's own (now narrower)
 * lifecycle.
 *
 * Deliberately has no stored sequence number and no stored
 * state_version — see 0015's migration comment for why both were
 * cut during the accepted design's stress test. Ordering and
 * "current" are both derived from createdAt, never stored.
 *
 * Slice 003 (Second Interaction Engine): engineType is the single
 * source of truth for which engine produced this interaction —
 * 'OPEN_RESPONSE' for every row that predates this slice.
 *
 * Slice 008 (Segment / Turn grouping): segmentId is the Interaction
 * Instance's Segment membership — every row now belongs to exactly one
 * Segment, including every pre-Slice-008 row (each backfilled into its
 * own one-Interaction-Instance Segment; see 0036's migration comment).
 * Retained alongside sessionId rather than replacing it — every
 * existing query filtering by sessionId keeps working unchanged; the
 * composite (session_id, segment_id) foreign key (0036) is what
 * prevents the two from ever disagreeing.
 */
export interface InteractionInstanceRecord {
  interactionInstanceId: string;
  sessionId: string;
  segmentId: string;
  promptId: string;
  state: InteractionState;
  engineType: EngineType;
  createdAt: string;
  updatedAt: string;
}

/**
 * Slice 008 (Segment / Turn grouping). A Segment groups one or more
 * Interaction Instances under one stable, member-facing Turn identity.
 * segmentOrdinal IS that Turn number — a durable value allocated once,
 * atomically, inside start_session_atomically's existing per-session
 * row lock (see that migration's comment for why this is safe without
 * an advisory lock or a separate counter table), not a derived count or
 * an artifact of createdAt ordering. createdAt is audit/history
 * information only; it plays no role in Turn identity.
 *
 * Deliberately has no stored lifecycle/state column — whether a Segment
 * is still current, still accepting another Interaction Instance, or
 * has been superseded is entirely derived from its own most-recent
 * Interaction Instance's state and from whether a newer Segment exists,
 * mirroring InteractionInstanceRecord's own "derive, don't persist"
 * precedent one level up.
 */
export interface SegmentRecord {
  segmentId: string;
  sessionId: string;
  segmentOrdinal: number;
  createdAt: string;
}

/**
 * Slice 003. The Multiple Choice engine's own data for one interaction
 * instance — a 1:1 extension, not a merge into InteractionInstanceRecord
 * itself (see 0024's migration comment for why). correctOptionIndex is
 * private state: known to the repository from creation, but the
 * domain layer (GET_SESSION) is exclusively responsible for
 * withholding it from any caller until the interaction reaches
 * RESULT_REVEAL.
 */
export interface MultipleChoiceDetailsRecord {
  interactionInstanceId: string;
  options: string[];
  correctOptionIndex: number;
  pointsForCorrect: number;
}

/**
 * Slice 007 (Voting Engine). A Voting Candidate — the output of
 * Candidate Resolution, Voting-owned and immutable once created,
 * regardless of which source (HOST_AUTHORED, SUBMISSION, or Slice 009's
 * PARTICIPANTS) produced it.
 *
 * Slice 009 (Engine Selection + PARTICIPANTS Voting): `participantId`
 * is the reveal-time attribution this table's original comment
 * anticipated ("if reveal-time attribution becomes a real product
 * need later, promoting it to a column is a small additive migration,
 * not a redesign") — populated for PARTICIPANTS (the participant *is*
 * the Candidate) and for SUBMISSION (the submission's own author,
 * already known at zero marginal query cost), left `null` for
 * HOST_AUTHORED (no participant identity exists behind an arbitrary
 * host-typed string). Two consumers, both internal: self-vote
 * enforcement now (see SelfVoteNotAllowedError), and Slice 010's future
 * Candidate→participant scoring resolution. Deliberately never
 * projected through GET_SESSION or any client-facing type — see
 * VotingCandidateSummary, unchanged. `ON DELETE SET NULL`, not
 * `CASCADE`: the Candidate's `label` is already an immutable snapshot
 * independent of any live row (see Slice 007's own precedent); if a
 * participant were ever removed by some future lifecycle feature (none
 * exists today), the Candidate and its label survive, only the
 * structured attribution degrades to unknown — deliberately different
 * from `submissions.participant_id`'s own `ON DELETE CASCADE` (0009),
 * which was never pressure-tested against this same "must survive"
 * requirement and is not a precedent this column follows.
 */
export interface VotingCandidateRecord {
  candidateId: string;
  interactionInstanceId: string;
  ordinal: number;
  label: string;
  participantId: string | null;
  createdAt: string;
}

/**
 * Slice 007. One participant's current vote in one Voting interaction
 * instance. One row per (interactionInstanceId, participantId) —
 * revisable via upsert while the interaction is PROMPT_ACTIVE
 * (mirrors SubmissionRecord's own last-write-wins shape exactly),
 * immutable once the interaction leaves PROMPT_ACTIVE.
 */
export interface VoteRecord {
  voteId: string;
  interactionInstanceId: string;
  participantId: string;
  candidateId: string;
  createdAt: string;
  updatedAt: string;
}

export interface VoteCastEventRecord extends SessionEventRecord {
  eventType: "VOTE_CAST";
  payload: {
    participantId: string;
    interactionInstanceId: string;
    candidateId: string;
  };
}

/**
 * Slice 007. Derives each Candidate's vote count and standard
 * competition rank from raw, already-immutable vote data — the single
 * shared computation both InMemorySessionRepository and
 * SupabaseSessionRepository call from their own
 * getVotingResultsForInteractionInstance, so ranking semantics (tied
 * candidates share a rank; the next distinct count skips ranks by the
 * number tied) can never drift between the two implementations.
 * Deliberately not persisted anywhere — see VotingResultSummary's
 * comment in types.ts for why this mirrors Multiple Choice's own
 * derived-not-stored `correctness`.
 */
export function computeVotingResults(
  candidates: VotingCandidateRecord[],
  votes: VoteRecord[]
): VotingResultSummary[] {
  const countByCandidateId = new Map<string, number>();
  for (const candidate of candidates) {
    countByCandidateId.set(candidate.candidateId, 0);
  }
  for (const vote of votes) {
    countByCandidateId.set(
      vote.candidateId,
      (countByCandidateId.get(vote.candidateId) ?? 0) + 1
    );
  }

  const sorted = [...candidates].sort(
    (a, b) =>
      (countByCandidateId.get(b.candidateId) ?? 0) -
      (countByCandidateId.get(a.candidateId) ?? 0)
  );

  const results: VotingResultSummary[] = [];
  let previousCount: number | null = null;
  let previousRank = 0;
  sorted.forEach((candidate, index) => {
    const voteCount = countByCandidateId.get(candidate.candidateId) ?? 0;
    const rank = voteCount === previousCount ? previousRank : index + 1;
    previousCount = voteCount;
    previousRank = rank;
    results.push({
      candidateId: candidate.candidateId,
      label: candidate.label,
      voteCount,
      rank,
    });
  });

  return results;
}

/**
 * Slice 003. One question in a session's pre-authored Multiple Choice
 * queue. consumedAt is null until a START_SESSION call turns it into a
 * real interaction instance, after which it is permanent history —
 * never deleted or reused.
 */
export interface PreparedQuestionRecord {
  preparedQuestionId: string;
  sessionId: string;
  ordinal: number;
  promptText: string;
  options: string[];
  correctOptionIndex: number;
  pointsForCorrect: number;
  consumedAt: string | null;
  createdAt: string;
}

export interface InteractionStartedEventRecord extends SessionEventRecord {
  eventType: "INTERACTION_STARTED";
  payload: {
    interactionInstanceId: string;
    promptId: string;
  };
}

export interface SubmissionRecord {
  submissionId: string;
  sessionId: string;
  /**
   * Slice 001: the authoritative scope a submission belongs to.
   * promptId is retained alongside it as harmless denormalization
   * (see 0016's migration comment) rather than removed.
   */
  interactionInstanceId: string;
  participantId: string;
  promptId: string;
  text: string;
  createdAt: string;
  updatedAt: string;
}

export interface ResponseSubmittedEventRecord extends SessionEventRecord {
  eventType: "RESPONSE_SUBMITTED";
  payload: {
    participantId: string;
    interactionInstanceId: string;
    promptId: string;
  };
}

export interface SubmissionsClosedEventRecord extends SessionEventRecord {
  eventType: "SUBMISSIONS_CLOSED";
  payload: Record<string, never>;
}

export interface ResultsRevealedEventRecord extends SessionEventRecord {
  eventType: "RESULTS_REVEALED";
  payload: Record<string, never>;
}

/**
 * Slice 002 (Scored Multi-Round Experience). One independent scoring
 * event: the host awarding a participant a positive number of points
 * for a specific, currently-revealed interaction instance. Immutable —
 * there is no update-in-place; every row is permanent from the moment
 * it is written. Deliberately has no uniqueness constraint on
 * (interactionInstanceId, participantId): a future experience may
 * legitimately produce more than one independent scoring event for the
 * same participant in the same interaction, and this generic ledger
 * should not encode a business rule that belongs to the experience,
 * not to Shared Game State.
 */
export interface PointAwardRecord {
  pointAwardId: string;
  sessionId: string;
  interactionInstanceId: string;
  participantId: string;
  points: number;
  createdAt: string;
}

export interface PointsAwardedEventRecord extends SessionEventRecord {
  eventType: "POINTS_AWARDED";
  payload: {
    pointAwardId: string;
    interactionInstanceId: string;
    participantId: string;
    points: number;
  };
}

/**
 * Quiz Experience (self-paced, independent participant progression).
 * The minimum authoritative state that cannot be derived from anything
 * else already in this schema — see 0041's migration comment for the
 * full pressure test that trimmed this from a four-column proposal
 * down to two. `opens_at` is deliberately absent: a Quiz opens exactly
 * when its Segment is created, so `SegmentRecord.createdAt` already is
 * that fact. One row per Quiz Segment; `segmentId` is both this
 * record's identity and its foreign key.
 */
export interface QuizWindowRecord {
  segmentId: string;
  closesAt: string;
  closedAt: string | null;
}

export interface QuizStartedEventRecord extends SessionEventRecord {
  eventType: "QUIZ_STARTED";
  payload: {
    segmentId: string;
    questionCount: number;
    closesAt: string;
  };
}

export interface QuizResponseSubmittedEventRecord extends SessionEventRecord {
  eventType: "QUIZ_RESPONSE_SUBMITTED";
  payload: {
    participantId: string;
    interactionInstanceId: string;
  };
}

export interface QuizClosedEventRecord extends SessionEventRecord {
  eventType: "QUIZ_CLOSED";
  payload: {
    segmentId: string;
    closedBy: "HOST" | "TIMER";
  };
}

/**
 * Repository interface for Session Engine persistence.
 *
 * The repository exposes conceptual persistence operations rather than
 * individual database writes. This ensures callers cannot accidentally
 * persist an aggregate without its required event.
 */
export interface SessionRepository {
  /**
   * Persist a new session and its initial event as one atomic operation.
   *
   * Implementations must:
   * - commit both records or neither record;
   * - enforce active room-code uniqueness;
   * - throw RoomCodeCollisionError only when room_code collides;
   * - when record.predecessorSessionId is non-null, persist it verbatim
   *   (this method does not itself verify the predecessor exists or is
   *   SESSION_COMPLETE — that is CREATE_SUCCESSOR_SESSION's
   *   responsibility, since it is permanently true once checked and
   *   never re-verified for the same reason completeSession never
   *   needs to guard against a session un-completing) and throw
   *   PredecessorAlreadyHasSuccessorError only when
   *   predecessor_session_id collides with an existing session.
   */
  createSession(
    record: SessionRecord,
    initialEvent: SessionEventRecord
  ): Promise<void>;

  /**
   * Persist a participant and its PARTICIPANT_JOINED event atomically.
   *
   * Implementations must:
   * - commit both records or neither record;
   * - enforce session-scoped normalized display-name uniqueness;
   * - translate only the display-name uniqueness violation into the
   *   corresponding domain error.
   */
  joinParticipant(
    record: ParticipantRecord,
    joinedEvent: ParticipantJoinedEventRecord
  ): Promise<void>;

  /**
   * Resolve a room code to its active (non-SESSION_COMPLETE) session.
   * Required by JOIN_SESSION to validate the target session exists and
   * is joinable before persisting a participant.
   */
  getActiveSessionByRoomCode(roomCode: string): Promise<SessionRecord | null>;

  /** Used by tests and validation to confirm a session round-trips. */
  getSessionById(sessionId: string): Promise<SessionRecord | null>;

  /**
   * Session Continuity slice. Resolve the (at most one) session whose
   * predecessorSessionId equals the given session id — i.e. "does this
   * session have a successor, and if so, which one." Used by
   * CREATE_SUCCESSOR_SESSION as a fast-path check before attempting to
   * create a second successor (the authoritative guard is still
   * sessions_predecessor_session_id_unique, per 0028 — this is a
   * clean-error convenience, not the sole enforcement), and by
   * GET_SESSION to populate successorSessionId/successorRoomCode once
   * a session reaches SESSION_COMPLETE. Returns null if no session
   * names this one as its predecessor.
   */
  getSuccessorSessionByPredecessorId(
    predecessorSessionId: string
  ): Promise<SessionRecord | null>;

  /**
   * Atomically re-verify the supplied host token and that the session is
   * LOBBY_OPEN, then transition it to LOBBY_LOCKED, increment
   * state_version, and persist the LOBBY_LOCKED event — as one atomic
   * operation, mirroring joinParticipant's authoritative re-check.
   *
   * Implementations must:
   * - commit the state transition and its event, or neither;
   * - re-verify the host token and session state inside the atomic
   *   operation itself, not merely trust an earlier caller-side check;
   * - throw SessionNotFoundError only when no session exists for the id;
   * - throw HostTokenMismatchError only on a host-token mismatch;
   * - throw LobbyNotOpenError only when the session is not LOBBY_OPEN;
   * - return the authoritative post-transition state and state_version.
   */
  lockLobby(
    sessionId: string,
    hostToken: string,
    event: LobbyLockedEventRecord
  ): Promise<{ state: SessionState; stateVersion: number }>;

  /**
   * Session Capability Architecture v1. Atomically re-verify the host
   * token, validate every supplied key against the current Product-
   * approved capability catalog, normalize (dedupe + canonically sort
   * — order carries no meaning), and either store it (no real
   * participant has ever joined) or compare it against the already-
   * locked value (idempotent success on an identical set, rejection on
   * any change). Persists a SESSION_CAPABILITIES_DECLARED event only
   * on a genuine write, mirroring lockLobby's identical precedent.
   *
   * Implementations must:
   * - re-verify the host token inside the atomic operation itself;
   * - throw SessionNotFoundError only when no session exists for the id;
   * - throw HostTokenMismatchError only on a host-token mismatch;
   * - throw InvalidCapabilityKeyError only when a supplied key is not
   *   in SessionCapabilityKey;
   * - throw CapabilitiesLockedError only when real participant
   *   evidence already exists and the supplied (normalized) set
   *   differs from the currently stored one;
   * - never reject a same-value redeclaration once locked;
   * - return the authoritative, normalized declared set and lock state.
   */
  setSessionCapabilities(
    sessionId: string,
    hostToken: string,
    capabilities: string[]
  ): Promise<{ declaredCapabilities: string[]; locked: boolean }>;

  /**
   * List all participants for a session, ordered by joinedAt ascending.
   * Not filtered by session state — GET_SESSION must be able to read a
   * session's participant list regardless of its current state.
   *
   * Tie-break contract: if multiple participants share the same
   * joinedAt timestamp, their relative order is intentionally
   * unspecified and must not be relied upon by consumers. The
   * guarantee implementations must uphold is determinism — repeated
   * calls against the same underlying data return the same order every
   * time. How a given implementation achieves that (a secondary sort
   * key, an incidental property of its storage model, or anything
   * else) is an implementation detail, not part of this contract.
   */
  getParticipantsForSession(sessionId: string): Promise<ParticipantRecord[]>;

  /**
   * Atomically re-verify the supplied host token and that the session is
   * not already SESSION_COMPLETE, then transition it to SESSION_COMPLETE,
   * increment state_version, and persist the SESSION_COMPLETED event —
   * as one atomic operation, mirroring lockLobby's authoritative
   * re-check.
   *
   * Per Interpretation 2 (administrative termination): this is callable
   * from any state except SESSION_COMPLETE itself — there is no single
   * required source state the way LOCK_LOBBY requires LOBBY_OPEN. This
   * remains true unchanged by Slice 001: completing while an
   * interaction instance is still PROMPT_ACTIVE (or any other
   * interaction state) is explicitly supported — that interaction
   * instance simply stays at whatever state it was in, as history.
   *
   * Implementations must:
   * - commit the state transition and its event, or neither;
   * - re-verify the host token and session state inside the atomic
   *   operation itself, not merely trust an earlier caller-side check;
   * - throw SessionNotFoundError only when no session exists for the id;
   * - throw HostTokenMismatchError only on a host-token mismatch;
   * - throw SessionAlreadyCompleteError only when the session is already
   *   SESSION_COMPLETE;
   * - return the authoritative post-transition state and state_version.
   */
  completeSession(
    sessionId: string,
    hostToken: string,
    event: SessionCompletedEventRecord
  ): Promise<{ state: SessionState; stateVersion: number }>;

  /**
   * Look up a single prompt by id. Returns null if it doesn't exist.
   * Used by GET_SESSION to hydrate the current interaction instance's
   * prompt.
   */
  getPromptById(promptId: string): Promise<PromptRecord | null>;

  /**
   * Slice 001: list every interaction instance for a session, ordered
   * by createdAt ascending. Callers derive "the current interaction"
   * as the last element (or null if the array is empty — no
   * interaction has been started yet) and "interactionNumber" as the
   * array's length. Not filtered by state — GET_SESSION must be able
   * to read this regardless of session state.
   *
   * Deliberately returns the full list rather than exposing separate
   * "current" and "count" methods: one query covers both needs (see
   * the accepted Slice 001 design's stress test on avoiding a stored
   * sequence number or a stored "current" pointer).
   */
  getInteractionInstancesForSession(
    sessionId: string
  ): Promise<InteractionInstanceRecord[]>;

  /**
   * Slice 008 (Segment / Turn grouping). List every Segment for a
   * session, ordered by segmentOrdinal ascending. Callers derive "the
   * current Segment" as the last element (or null if the array is
   * empty — no Segment has ever been created). Mirrors
   * getInteractionInstancesForSession's exact division of
   * responsibility: one query, no separate "current"/"count" methods.
   */
  getSegmentsForSession(sessionId: string): Promise<SegmentRecord[]>;

  /**
   * Slice 001. Atomically re-verify the supplied host token and that
   * the session is LOBBY_LOCKED, re-verify that the session's current
   * interaction instance (if any) is at RESULT_REVEAL, insert a new
   * prompt from the supplied text, create a new interaction instance
   * referencing it in PROMPT_ACTIVE, and persist an INTERACTION_STARTED
   * event — as one atomic operation.
   *
   * Re-invocable: unlike the pre-Slice-001 START_SESSION, this may be
   * called once per interaction, any number of times, for the same
   * session — not once per session's entire lifetime. The session's
   * own state and state_version are never touched by this call.
   *
   * Implementations must:
   * - commit the prompt insert, the interaction instance insert, and
   *   the event, or none of them;
   * - re-verify the host token and session state inside the atomic
   *   operation itself, not merely trust an earlier caller-side check;
   * - re-verify the current interaction instance's state (if one
   *   exists) inside the same atomic operation, closing the race
   *   window between two concurrent start attempts;
   * - throw SessionNotFoundError only when no session exists for the id;
   * - throw HostTokenMismatchError only on a host-token mismatch;
   * - throw LobbyNotLockedError only when the session is not
   *   LOBBY_LOCKED;
   * - throw PreviousInteractionNotRevealedError only when a current
   *   interaction instance exists and is not at RESULT_REVEAL;
   * - throw EmptyPromptTextError / PromptTextTooLongError only for the
   *   corresponding validation failure;
   * - return the newly created interaction instance's id, prompt id,
   *   and state.
   *
   * Slice 003 (Second Interaction Engine): gains an optional
   * preparedQuestionId. When supplied, promptText is ignored and the
   * implementation must instead atomically: verify the prepared
   * question exists, belongs to this session, and is not already
   * consumed; create the interaction instance as 'MULTIPLE_CHOICE';
   * create its multiple_choice_details row from the prepared
   * question's options/correctOptionIndex/pointsForCorrect; and mark
   * the prepared question consumed — all inside the same atomic
   * operation as every other check here. When omitted, behavior is
   * byte-for-byte the existing Open Response path. Deliberately
   * explicit rather than an implicit "use the next unconsumed prepared
   * question" fallback, so the request's meaning never depends on
   * hidden repository state.
   *
   * Implementations must additionally:
   * - throw PreparedQuestionNotFoundError only when preparedQuestionId
   *   does not identify a prepared question belonging to this session;
   * - throw PreparedQuestionAlreadyConsumedError only when it has
   *   already been consumed;
   * - return engineType alongside the existing fields.
   *
   * Slice 007 (Voting Engine) / Slice 009 (Engine Selection +
   * PARTICIPANTS Voting): the VOTING branch of StartTurnConfig carries
   * a candidateSource, structurally exclusive from MULTIPLE_CHOICE's
   * preparedQuestionId by construction (different union members, not
   * different optional fields on one object) — the domain layer can no
   * longer construct the ambiguous case; this method's own
   * AmbiguousStartSessionTargetError check is retained as
   * defense-in-depth. promptText IS still required for VOTING (unlike
   * the prepared-question path) — Voting always needs host-framed text
   * ("Vote for your favorite!"), since no candidate source provides
   * one. Candidate Resolution happens here, inside this same atomic
   * operation, for the same reason prepared-question consumption does.
   *
   * - type "HOST_AUTHORED": validate candidates has at least two
   *   distinct, non-empty (post-trim) entries — mirrors
   *   validateAndTrimOptions's floor — then insert each as a
   *   Voting-owned Candidate snapshot, ordinal-ordered as supplied.
   *   participantId is null for every row (no participant identity
   *   exists behind an arbitrary host-typed string).
   * - type "SUBMISSION": re-verify sourceInteractionInstanceId belongs
   *   to this session, is engineType OPEN_RESPONSE, is state
   *   RESULT_REVEAL, and has at least one submission; then copy each
   *   submission's text into a new, Voting-owned Candidate snapshot,
   *   now also populating participantId from that submission's own
   *   participantId (Slice 009 — zero marginal cost, since the query
   *   already reads that row). The source interaction instance itself
   *   is never modified.
   * - type "PARTICIPANTS" (Slice 009): resolve the session's current
   *   participant roster; require at least two participants (same
   *   floor as HOST_AUTHORED — a Voting round needs ≥2 usable
   *   Candidates); insert one Candidate per participant, label = that
   *   participant's display_name at this moment, participantId =
   *   that participant's own id. No extra input beyond the type
   *   discriminator — the roster is already resolvable from sessionId.
   *
   * Implementations must additionally:
   * - throw InvalidVotingCandidatesError for the HOST_AUTHORED
   *   candidate-count/emptiness failure, or when PARTICIPANTS resolves
   *   fewer than two participants;
   * - throw VotingSourceInteractionNotFoundError only when
   *   sourceInteractionInstanceId does not identify an interaction
   *   instance belonging to this session;
   * - throw VotingSourceInteractionNotEligibleError only when that
   *   interaction instance exists but is not OPEN_RESPONSE, not
   *   RESULT_REVEAL, or has zero submissions.
   *
   * Slice 008 (Segment / Turn grouping): gains an optional segmentTarget,
   * defaulting to "NEW_SEGMENT" when omitted — every pre-Slice-008 call
   * site keeps working unchanged. "NEW_SEGMENT" allocates the next
   * segmentOrdinal for this session (COALESCE(MAX(segment_ordinal), 0) + 1,
   * computed only after the session-row lock this method already holds
   * — see 0037's migration comment for why that lock is what makes this
   * safe without an advisory lock or a separate counter table) and
   * creates a new Segment row before creating the Interaction Instance.
   * "CURRENT_SEGMENT" creates no new Segment: it reuses the session's
   * existing current Segment's id and ordinal, attaching only a new
   * Interaction Instance to it — this is the mechanism behind the Best
   * Joke proving case (Open Response, then Voting, same Turn). Every
   * pre-existing precondition (previous interaction instance, if any,
   * must be RESULT_REVEAL) applies identically to both targets.
   *
   * Implementations must additionally:
   * - throw NoCurrentSegmentToContinueError only when segmentTarget is
   *   "CURRENT_SEGMENT" and no Interaction Instance (and therefore no
   *   Segment) has ever been created for this session;
   * - return segmentNumber (the resolved Segment's segmentOrdinal)
   *   alongside the existing fields.
   */
  startSession(
    sessionId: string,
    hostToken: string,
    config: StartTurnConfig,
    segmentTarget?: SegmentTarget
  ): Promise<{
    interactionInstanceId: string;
    promptId: string;
    state: InteractionState;
    engineType: EngineType;
    segmentNumber: number;
  }>;

  /**
   * Atomically re-verify that the supplied participant token belongs to
   * the given participant of this session, that the session is
   * LOBBY_LOCKED, and that the session's current interaction instance
   * is PROMPT_ACTIVE, then upsert the participant's response to that
   * interaction instance (one submission per participant per
   * interaction instance — a second call replaces the first, "last
   * write wins") and persist a RESPONSE_SUBMITTED event.
   *
   * "Last write wins" is an explicit MVP implementation decision, not a
   * permanent gameplay rule — see SubmitResponseResult.
   *
   * Like startSession, this method does not take an event argument: the
   * event payload depends on which interaction instance is current,
   * which must be re-read authoritatively inside this same atomic
   * operation (not trusted from an earlier domain-layer read), so the
   * payload is built here, not by the caller.
   *
   * Implementations must:
   * - commit the submission and its event, or neither;
   * - re-verify the participant token and session state inside the
   *   atomic operation itself, not merely trust an earlier caller-side
   *   check;
   * - re-resolve the current interaction instance inside the same
   *   atomic operation;
   * - throw SessionNotFoundError only when no session exists for the id;
   * - throw SessionAccessDeniedError only when the token does not match
   *   the given participant of this session;
   * - throw PromptNotActiveError only when the session is not
   *   LOBBY_LOCKED, or no interaction instance exists, or the current
   *   one is not PROMPT_ACTIVE;
   * - throw EmptyResponseError / ResponseTooLongError only for the
   *   corresponding validation failure;
   * - return the resulting submissionId, the interaction instance's id
   *   and promptId, and updatedAt.
   */
  submitResponse(
    sessionId: string,
    participantId: string,
    participantToken: string,
    text: string
  ): Promise<{
    submissionId: string;
    interactionInstanceId: string;
    promptId: string;
    updatedAt: string;
  }>;

  /**
   * Slice 001: list all submissions for one interaction instance. Not
   * filtered by state — GET_SESSION's own state-based visibility rule
   * (submissions only surfaced once RESULT_REVEAL) is applied by the
   * domain layer, not this method.
   */
  getSubmissionsForInteractionInstance(
    interactionInstanceId: string
  ): Promise<SubmissionRecord[]>;

  /**
   * Atomically re-verify the supplied host token, that the session is
   * LOBBY_LOCKED, and that the session's current interaction instance
   * is PROMPT_ACTIVE, then transition that interaction instance to
   * SUBMISSIONS_CLOSED and persist the SUBMISSIONS_CLOSED event — as
   * one atomic operation, mirroring lockLobby's authoritative re-check.
   *
   * Implementations must:
   * - commit the state transition and its event, or neither;
   * - re-verify the host token and session state inside the atomic
   *   operation itself;
   * - re-resolve the current interaction instance inside the same
   *   atomic operation;
   * - throw SessionNotFoundError only when no session exists for the id;
   * - throw HostTokenMismatchError only on a host-token mismatch;
   * - throw PromptNotActiveError only when the session is not
   *   LOBBY_LOCKED, or no interaction instance exists, or the current
   *   one is not PROMPT_ACTIVE;
   * - return the interaction instance's id and its post-transition
   *   state.
   */
  closeSubmissions(
    sessionId: string,
    hostToken: string,
    event: SubmissionsClosedEventRecord
  ): Promise<{ interactionInstanceId: string; state: InteractionState }>;

  /**
   * Atomically re-verify the supplied host token, that the session is
   * LOBBY_LOCKED, and that the session's current interaction instance
   * is SUBMISSIONS_CLOSED, then transition that interaction instance to
   * RESULT_REVEAL and persist the RESULTS_REVEALED event — as one
   * atomic operation.
   *
   * Implementations must:
   * - commit the state transition and its event, or neither;
   * - re-verify the host token and session state inside the atomic
   *   operation itself;
   * - re-resolve the current interaction instance inside the same
   *   atomic operation;
   * - throw SessionNotFoundError only when no session exists for the id;
   * - throw HostTokenMismatchError only on a host-token mismatch;
   * - throw SubmissionsNotClosedError only when the session is not
   *   LOBBY_LOCKED, or no interaction instance exists, or the current
   *   one is not SUBMISSIONS_CLOSED;
   * - return the interaction instance's id and its post-transition
   *   state.
   */
  revealResults(
    sessionId: string,
    hostToken: string,
    event: ResultsRevealedEventRecord
  ): Promise<{ interactionInstanceId: string; state: InteractionState }>;

  /**
   * Slice 002. Idempotency-first: if a point_award already exists for
   * this (sessionId, idempotencyKey) pair, return it immediately — no
   * other validation runs, even if the session has since progressed to
   * a later interaction or completed. Only when the key is genuinely
   * new does the implementation validate host token, session state
   * (LOBBY_LOCKED), that interactionInstanceId is both the session's
   * current interaction and at RESULT_REVEAL, that participantId
   * belongs to the session, and that points is a positive integer —
   * then insert one new, permanent point_award row and persist a
   * POINTS_AWARDED event.
   *
   * No update-in-place: a second call with a different idempotencyKey,
   * even for the same participant and interaction, creates a second,
   * independent row. This is deliberate — the ledger does not enforce
   * "one award per participant per interaction."
   *
   * Implementations must:
   * - resolve idempotencyKey (scoped to sessionId) before any other
   *   check, and skip all other validation on a match;
   * - commit the new row and its event atomically, or neither;
   * - guard against a concurrent request racing on the same
   *   (sessionId, idempotencyKey) pair by returning the winner's result
   *   rather than erroring;
   * - throw SessionNotFoundError only when no session exists for the id;
   * - throw HostTokenMismatchError only on a host-token mismatch;
   * - throw LobbyNotLockedError only when the session is not
   *   LOBBY_LOCKED;
   * - throw InteractionInstanceNotEligibleError only when
   *   interactionInstanceId is not the session's current interaction,
   *   or that interaction is not at RESULT_REVEAL;
   * - throw ParticipantNotInSessionError only when participantId does
   *   not belong to this session;
   * - throw InvalidPointsError only when points is not a positive
   *   integer within the accepted bound;
   * - return the resulting (or pre-existing) point award record.
   */
  awardPoints(
    sessionId: string,
    hostToken: string,
    interactionInstanceId: string,
    participantId: string,
    points: number,
    idempotencyKey: string
  ): Promise<PointAwardRecord>;

  /**
   * Slice 002: list every point award for a session. Used by
   * GET_SESSION to derive per-participant cumulative standings by
   * summation — never filtered or pre-aggregated here, since the
   * summation itself is the domain layer's responsibility.
   */
  getPointAwardsForSession(sessionId: string): Promise<PointAwardRecord[]>;

  /**
   * Slice 003 (Second Interaction Engine). Persist a batch of
   * pre-authored Multiple Choice questions for a session, assigning
   * each the next sequential ordinal after whatever already exists for
   * this session. Host-token verification and validation of each
   * question's shape (non-empty prompt text, at least two distinct
   * non-empty options, correctOptionIndex within bounds, points a
   * positive integer within the accepted bound) are the domain layer's
   * responsibility (see prepareQuestions.ts) — this method persists
   * already-validated rows.
   *
   * No atomic re-check of host token or session state is required here
   * the way write commands elsewhere in this interface require one:
   * authoring a prepared question has no concurrent invariant to
   * protect (no state transition, no uniqueness other than the
   * ordinal this method itself assigns), unlike lockLobby or
   * startSession, which race against concurrent calls changing the
   * same state.
   *
   * Session Capability Architecture v1. Implementations must re-verify,
   * authoritatively (never trusting only the domain layer's own
   * fast-path check), that the target session has declared QUIZ or
   * TRIVIA (or both) before persisting any row — throwing
   * CapabilityNotAuthorizedError otherwise. See prepareQuestions.ts's
   * own comment for why the rule is an "or," not either capability
   * alone: both QUIZ's and TRIVIA's own activation paths read from
   * this same table.
   */
  createPreparedQuestions(
    sessionId: string,
    questions: Array<{
      promptText: string;
      options: string[];
      correctOptionIndex: number;
      pointsForCorrect: number;
    }>
  ): Promise<PreparedQuestionRecord[]>;

  /**
   * Slice 003. List every prepared question for a session, ordered by
   * ordinal ascending — both consumed and unconsumed. GET_SESSION
   * applies its own host-only visibility rule on top of this; this
   * method itself performs no filtering by caller role.
   */
  getPreparedQuestionsForSession(
    sessionId: string
  ): Promise<PreparedQuestionRecord[]>;

  /**
   * Slice 003. Look up the Multiple Choice engine's own data for one
   * interaction instance. Returns null for an Open Response
   * interaction (or any interaction instance id with no matching row).
   * Used by SUBMIT_RESPONSE (engine-aware validation) and GET_SESSION
   * (resolving options, reveal-gating correctOptionIndex, mapping
   * submitted option indices to their label text).
   */
  getMultipleChoiceDetailsForInteraction(
    interactionInstanceId: string
  ): Promise<MultipleChoiceDetailsRecord | null>;

  /**
   * Slice 007 (Voting Engine). List every Candidate for one Voting
   * interaction instance, ordinal-ordered. Not reveal-gated — Candidates
   * must be visible before voting can happen at all, mirroring
   * MULTIPLE_CHOICE's `options`. Returns an empty array for a
   * non-Voting interaction instance (or any id with no matching rows).
   */
  getVotingCandidatesForInteraction(
    interactionInstanceId: string
  ): Promise<VotingCandidateRecord[]>;

  /**
   * Slice 007. List every vote for one Voting interaction instance —
   * one row per participant who has voted, per VoteRecord's own
   * uniqueness. Used both for progress counts (pre-reveal) and, joined
   * with getVotingCandidatesForInteraction via computeVotingResults,
   * for derived results (post-reveal). Not filtered by state — visibility
   * rules are the domain layer's (GET_SESSION's) responsibility, not
   * this method's, mirroring getSubmissionsForInteractionInstance's
   * identical division of responsibility.
   */
  getVotesForInteractionInstance(
    interactionInstanceId: string
  ): Promise<VoteRecord[]>;

  /**
   * Slice 007. The single repository path for deriving Voting's
   * `placement` Outcome — candidate identity, label, vote count, and
   * standard-competition rank, computed live from immutable vote data
   * via computeVotingResults. Never persisted; see that function's
   * comment. GET_SESSION calls this only once the interaction has
   * reached RESULT_REVEAL — this method itself performs no
   * reveal-gating, the same division of responsibility used everywhere
   * else in this interface.
   */
  getVotingResultsForInteractionInstance(
    interactionInstanceId: string
  ): Promise<VotingResultSummary[]>;

  /**
   * Slice 007. CAST_VOTE's repository operation. Atomically re-verifies
   * the supplied participant token belongs to the given participant of
   * this session, that the session is LOBBY_LOCKED, that the session's
   * current interaction instance is PROMPT_ACTIVE and engineType
   * VOTING, and that candidateId identifies a Candidate belonging to
   * that interaction instance, then upserts the participant's vote
   * (one vote per participant per interaction instance — a second call
   * replaces the first, "last write wins," mirroring submitResponse's
   * identical MVP decision) and persists a VOTE_CAST event.
   *
   * Implementations must:
   * - commit the vote and its event, or neither;
   * - re-verify the participant token and session/interaction state
   *   inside the atomic operation itself, not merely trust an earlier
   *   caller-side check;
   * - throw SessionNotFoundError only when no session exists for the id;
   * - throw SessionAccessDeniedError only when the token does not match
   *   the given participant of this session;
   * - throw PromptNotActiveError only when the session is not
   *   LOBBY_LOCKED, no interaction instance exists, the current one is
   *   not PROMPT_ACTIVE, or the current one is not engineType VOTING;
   * - throw InvalidCandidateSelectionError only when candidateId does
   *   not identify a Candidate belonging to the current interaction
   *   instance;
   * - return the resulting voteId, interactionInstanceId, candidateId,
   *   and updatedAt.
   *
   * Slice 009 (Engine Selection + PARTICIPANTS Voting): additionally
   * re-verify, inside this same atomic operation, that the selected
   * Candidate's participantId (see VotingCandidateRecord) does not
   * match the voting participant's own id — this is the authoritative
   * self-vote check; the domain layer's own fast-path re-check is not
   * the sole guarantee, matching every other precondition in this
   * method. Implementations must additionally throw
   * SelfVoteNotAllowedError only in that case, and only when the
   * Candidate has a non-null participantId — HOST_AUTHORED Candidates
   * (participantId always null) are never subject to this check.
   */
  castVote(
    sessionId: string,
    participantId: string,
    participantToken: string,
    candidateId: string
  ): Promise<{
    voteId: string;
    interactionInstanceId: string;
    candidateId: string;
    updatedAt: string;
  }>;

  /**
   * Quiz Experience. START_QUIZ's repository operation — dedicated,
   * not a generalization of startSession (see this platform's
   * implementation-readiness design for why). Atomically: authenticate
   * the host, verify the session is LOBBY_LOCKED with no un-revealed
   * current interaction (the same precondition NEW_SEGMENT already
   * enforces), allocate a new Segment, compute closesAt from
   * database-authoritative time (never a client-supplied value),
   * create the quiz window row, and consume every currently-unconsumed
   * prepared question for this session into its own new Multiple
   * Choice Interaction Instance + multiple_choice_details row, all
   * belonging to the new Segment, all created PROMPT_ACTIVE together
   * (never lazily) — closing the exact concurrent-creation race a
   * lazy-creation alternative would reintroduce.
   *
   * Implementations must:
   * - commit the Segment, quiz window, every Interaction Instance,
   *   every multiple_choice_details row, every prepared-question
   *   consumption, and the event, or none of them;
   * - re-verify the host token and session state inside the atomic
   *   operation itself;
   * - throw SessionNotFoundError only when no session exists for the id;
   * - throw HostTokenMismatchError only on a host-token mismatch;
   * - throw LobbyNotLockedError only when the session is not
   *   LOBBY_LOCKED;
   * - throw PreviousInteractionNotRevealedError only when a current
   *   interaction instance exists and is not at RESULT_REVEAL;
   * - throw EmptyQuizQuestionSetError only when no prepared question is
   *   currently unconsumed for this session;
   * - throw InvalidQuizDurationError only when durationSeconds is
   *   outside the accepted bound;
   * - return the new Segment's id and ordinal, the computed closesAt,
   *   and the ordered list of created Interaction Instance ids.
   */
  startQuiz(
    sessionId: string,
    hostToken: string,
    durationSeconds: number
  ): Promise<{
    segmentId: string;
    segmentOrdinal: number;
    closesAt: string;
    interactionInstanceIds: string[];
  }>;

  /**
   * Quiz Experience. SUBMIT_QUIZ_RESPONSE's repository operation —
   * dedicated, not a generalization of submitResponse. Atomically
   * re-verifies the participant token, that interactionInstanceId
   * belongs to this session and is a MULTIPLE_CHOICE instance whose
   * Segment has a quiz window, that the window is not closed and the
   * database's own clock has not yet reached closesAt (the
   * authoritative late-submission rejection — never derived from the
   * instance's own PROMPT_ACTIVE state alone, since that state does
   * not change until CLOSE_QUIZ actually runs), and that
   * selectedOptionIndex is valid for that question — then upserts the
   * participant's response using the existing submissions
   * (interactionInstanceId, participantId) upsert semantics unchanged
   * and persists a QUIZ_RESPONSE_SUBMITTED event.
   *
   * Implementations must:
   * - commit the submission and its event, or neither;
   * - re-verify every precondition above inside the atomic operation
   *   itself;
   * - throw SessionNotFoundError only when no session exists for the id;
   * - throw SessionAccessDeniedError only when the token does not match
   *   the given participant of this session;
   * - throw QuizInstanceNotFoundError only when interactionInstanceId
   *   does not identify a MULTIPLE_CHOICE Interaction Instance
   *   belonging to a Quiz Segment of this session;
   * - throw QuizClosedError only when that Quiz's window is closed or
   *   its deadline has passed;
   * - throw InvalidOptionSelectionError only when selectedOptionIndex
   *   is out of bounds for that question;
   * - return the resulting submissionId, interactionInstanceId, and
   *   updatedAt.
   */
  submitQuizResponse(
    sessionId: string,
    participantId: string,
    participantToken: string,
    interactionInstanceId: string,
    selectedOptionIndex: number
  ): Promise<{
    submissionId: string;
    interactionInstanceId: string;
    updatedAt: string;
  }>;

  /**
   * Quiz Experience. CLOSE_QUIZ's repository operation — dedicated,
   * not a generalization of revealResults. Idempotent: if the named
   * Quiz Segment's window is already closed, returns the existing
   * closedAt immediately with no further work. Otherwise, atomically:
   * authorizes the caller as either the session's host (always allowed
   * to close early) or any participant of this session (allowed only
   * once database time has reached the window's closesAt — a
   * participant may trigger automatic expiry but never force an early
   * close), sets closedAt, evaluates every submitted answer across
   * every Multiple Choice Interaction Instance in the Segment
   * (correct → that question's configured points via point_awards,
   * deterministically idempotency-keyed; wrong or unanswered → no
   * award), and transitions every Interaction Instance in the Segment
   * to RESULT_REVEAL — all in the same transaction, all-or-nothing.
   *
   * Implementations must:
   * - commit the closedAt write, every point_award, every Interaction
   *   Instance transition, and the event, or none of them;
   * - short-circuit safely (no error, no duplicate work) when already
   *   closed;
   * - throw SessionNotFoundError only when no session exists for the id;
   * - throw QuizNotFoundError only when segmentId does not identify a
   *   Quiz Segment of this session;
   * - throw QuizAccessDeniedError only when callerToken matches
   *   neither the host token nor any participant token of this
   *   session;
   * - throw QuizExpiryNotReachedError only when a participant (not the
   *   host) attempts to close before database time has reached
   *   closesAt;
   * - return the Segment id and the (new or pre-existing) closedAt.
   */
  closeQuiz(
    sessionId: string,
    segmentId: string,
    callerToken: string
  ): Promise<{
    segmentId: string;
    closedAt: string;
    alreadyClosed: boolean;
  }>;

  /**
   * Quiz Experience. Look up the Quiz window for one Segment. Returns
   * null when that Segment is not a Quiz (Trivia/Best-Joke-style
   * Segments have no window row at all) or does not exist. Used by
   * GET_SESSION to determine whether the session's most recent Segment
   * is a Quiz and, if so, to read its authoritative deadline/close
   * state.
   */
  getQuizWindowForSegment(segmentId: string): Promise<QuizWindowRecord | null>;

  /**
   * Duel / SESSION_SUBGAME v1 (Product/Duel_Architecture.md).
   * START_DUEL's atomic operation. Re-verifies the host token and
   * LOBBY_LOCKED state, that DUEL is declared, that both competitor
   * ids are distinct participants of this session, that no ordinary
   * Interaction Instance is active (not yet RESULT_REVEAL), and that
   * no other Duel is already active for this session — creating the
   * Duel already ACTIVE, mirroring how ordinary Interaction Instances
   * go straight to PROMPT_ACTIVE. Duel does not create an
   * interaction_instances row; it is its own structurally separate
   * entity (see 0128's migration comment for why).
   *
   * Implementations must:
   * - re-verify the host token and session state inside the atomic
   *   operation itself;
   * - throw SessionNotFoundError only when no session exists;
   * - throw HostTokenMismatchError only on a host-token mismatch;
   * - throw LobbyNotLockedError only when the session is not
   *   LOBBY_LOCKED;
   * - throw CapabilityNotAuthorizedError("DUEL") only when DUEL is not
   *   declared;
   * - throw DuplicateDuelCompetitorError only when both competitor ids
   *   are identical;
   * - throw DuelCompetitorNotInSessionError only when a competitor id
   *   does not resolve to a participant of this session;
   * - throw InteractionActiveError only when the current Interaction
   *   Instance (if any) is not RESULT_REVEAL;
   * - throw ActiveDuelExistsError only when another Duel is already
   *   ACTIVE for this session;
   * - throw InvalidDuelOptionsError only when options/correctOptionIndex
   *   are invalid;
   * - persist exactly one DUEL_STARTED session event on success;
   * - return the newly created Duel's public fields, never the correct
   *   option index.
   */
  startDuel(
    sessionId: string,
    hostToken: string,
    competitorAParticipantId: string,
    competitorBParticipantId: string,
    promptText: string,
    options: string[],
    correctOptionIndex: number
  ): Promise<{
    duelId: string;
    mechanicKey: DuelMechanicKey;
    lifecycleState: DuelLifecycleState;
    promptText: string;
    options: string[];
    startedAt: string;
  }>;

  /**
   * Duel / SESSION_SUBGAME v1. SUBMIT_DUEL_RESPONSE's atomic
   * operation. Participant-token authority only — resolves the caller
   * against this session's participants, then requires that resolved
   * participant to be one of this Duel's two bound competitors.
   * Idempotent upsert: a second submission from the same competitor
   * replaces the first (last write wins), mirroring submitResponse's
   * own precedent.
   *
   * Implementations must:
   * - throw DuelNotFoundError only when no Duel exists for this id;
   * - throw DuelNotActiveError only when the Duel is not ACTIVE;
   * - throw DuelAccessDeniedError only when the resolved participant is
   *   not one of this Duel's two competitors (including a
   *   non-competitor, a stranger, or the host acting outside their own
   *   participant identity);
   * - throw InvalidDuelOptionSelectionError only when the supplied
   *   index is not a legal option index for this Duel;
   * - never leak the other competitor's response.
   */
  submitDuelResponse(
    duelId: string,
    participantToken: string,
    selectedOptionIndex: number
  ): Promise<{ participantId: string; answeredAt: string }>;

  /**
   * Duel / SESSION_SUBGAME v1. RESOLVE_DUEL's atomic operation — the
   * normal, mechanic-derived resolution. Host-triggered only; no
   * timer, no background job. Deterministic winner logic exactly as
   * documented in 0131's own migration comment — never fabricates a
   * winner.
   *
   * Implementations must:
   * - re-verify the host token inside the atomic operation itself;
   * - throw DuelNotFoundError only when no Duel exists for this id;
   * - throw HostTokenMismatchError only on a host-token mismatch;
   * - throw DuelAlreadyResolvedError only when the Duel is not ACTIVE;
   * - persist exactly one DUEL_RESOLVED session event on success.
   */
  resolveDuel(
    duelId: string,
    hostToken: string
  ): Promise<{
    duelId: string;
    lifecycleState: DuelLifecycleState;
    terminalResolution: DuelTerminalResolution;
    winnerParticipantId: string | null;
  }>;

  /**
   * Duel / SESSION_SUBGAME v1. RESOLVE_DUEL_EXCEPTIONALLY's atomic
   * operation — the Host's exceptional-resolution tier (CANCELLED,
   * VOID, or a named competitor's FORFEIT). Never callable against an
   * already-COMPLETED Duel — a mechanic-derived or prior exceptional
   * result is never silently overwritten.
   *
   * Implementations must:
   * - re-verify the host token inside the atomic operation itself;
   * - throw DuelNotFoundError only when no Duel exists for this id;
   * - throw HostTokenMismatchError only on a host-token mismatch;
   * - throw InvalidDuelResolutionError only when resolution is not one
   *   of CANCELLED, VOID, FORFEIT_A, FORFEIT_B;
   * - throw DuelReasonRequiredError only when resolution is a forfeit
   *   and no reason is supplied;
   * - throw DuelAlreadyResolvedError only when the Duel is already
   *   COMPLETED;
   * - persist exactly one DUEL_RESOLVED session event on success.
   */
  resolveDuelExceptionally(
    duelId: string,
    hostToken: string,
    resolution: DuelExceptionalResolution,
    reason: string | null
  ): Promise<{
    duelId: string;
    lifecycleState: DuelLifecycleState;
    terminalResolution: DuelTerminalResolution;
    winnerParticipantId: string | null;
  }>;

  /**
   * Duel / SESSION_SUBGAME v1. Look up a single Duel by id. Returns
   * null if it doesn't exist. The fast-path lookup submitDuelResponse.ts
   * and resolveDuel.ts/resolveDuelExceptionally.ts use, mirroring
   * getSessionById/getPromptById's own single-entity precedent.
   */
  getDuelById(duelId: string): Promise<DuelRecord | null>;

  /**
   * Duel / SESSION_SUBGAME v1. The active Duel for a session, if any —
   * at most one, per the one-active-subgame-per-session invariant.
   * Used by GET_SESSION and by every command that must check this
   * invariant from the read side.
   */
  getActiveDuelForSession(sessionId: string): Promise<DuelRecord | null>;

  /**
   * Duel / SESSION_SUBGAME v1. Every Duel that has ever run for a
   * session, most recent first — historical evidence, readable
   * regardless of session state, mirroring
   * getInteractionInstancesForSession's own unfiltered contract.
   */
  getDuelsForSession(sessionId: string): Promise<DuelRecord[]>;

  /**
   * Duel / SESSION_SUBGAME v1. Both competitors' responses for one
   * Duel, if submitted. Used by GET_SESSION to expose each caller only
   * their own response before resolution, and both once resolved —
   * privacy enforcement happens at the read-model boundary
   * (getSession.ts), not here; this returns the raw evidence.
   */
  getDuelResponses(
    duelId: string
  ): Promise<Array<{ participantId: string; selectedOptionIndex: number; answeredAt: string }>>;
}
