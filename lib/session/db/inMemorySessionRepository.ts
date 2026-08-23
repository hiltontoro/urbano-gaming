import { randomUUID } from "crypto";
import type {
  SessionRecord,
  InteractionState,
  EngineType,
  VotingResultSummary,
  SegmentTarget,
  StartTurnConfig,
  SessionCapabilityKey,
} from "../types";
import {
  RoomCodeCollisionError,
  DisplayNameTakenError,
  SessionNotFoundError,
  LobbyNotOpenError,
  LobbyNotLockedError,
  HostTokenMismatchError,
  SessionAlreadyCompleteError,
  SessionAccessDeniedError,
  PromptNotActiveError,
  SubmissionsNotClosedError,
  PreviousInteractionNotRevealedError,
  NoCurrentSegmentToContinueError,
  EmptyPromptTextError,
  PromptTextTooLongError,
  InteractionInstanceNotEligibleError,
  ParticipantNotInSessionError,
  InvalidPointsError,
  PreparedQuestionNotFoundError,
  PreparedQuestionAlreadyConsumedError,
  PredecessorAlreadyHasSuccessorError,
  InvalidVotingCandidatesError,
  VotingSourceInteractionNotFoundError,
  VotingSourceInteractionNotEligibleError,
  InvalidCandidateSelectionError,
  SelfVoteNotAllowedError,
  InvalidQuizDurationError,
  EmptyQuizQuestionSetError,
  QuizInstanceNotFoundError,
  QuizClosedError,
  QuizNotFoundError,
  QuizAccessDeniedError,
  QuizExpiryNotReachedError,
  InvalidOptionSelectionError,
  GamingMemberAlreadyInSessionError,
  InvalidCapabilityKeyError,
  CapabilitiesLockedError,
  SessionCapabilitiesNotDeclaredError,
  CapabilityNotAuthorizedError,
  DuplicateDuelCompetitorError,
  DuelCompetitorNotInSessionError,
  ActiveDuelExistsError,
  InteractionActiveError,
  InvalidDuelOptionsError,
  DuelNotFoundError,
  DuelAccessDeniedError,
  DuelNotActiveError,
  InvalidDuelOptionSelectionError,
  DuelAlreadyResolvedError,
  InvalidDuelResolutionError,
  DuelReasonRequiredError,
} from "../types";
import type {
  DuelRecord,
  DuelMechanicKey,
  DuelLifecycleState,
  DuelTerminalResolution,
  DuelExceptionalResolution,
} from "../types";

const SESSION_CAPABILITY_KEYS: SessionCapabilityKey[] = [
  "OPEN_RESPONSE",
  "VOTING",
  "TRIVIA",
  "QUIZ",
  "DUEL",
];
import type {
  SessionEventRecord,
  ParticipantRecord,
  ParticipantJoinedEventRecord,
  LobbyLockedEventRecord,
  SessionCompletedEventRecord,
  PromptRecord,
  InteractionInstanceRecord,
  SegmentRecord,
  SubmissionRecord,
  SubmissionsClosedEventRecord,
  ResultsRevealedEventRecord,
  PointAwardRecord,
  MultipleChoiceDetailsRecord,
  PreparedQuestionRecord,
  VotingCandidateRecord,
  VoteRecord,
  SessionRepository,
  QuizWindowRecord,
} from "./sessionRepository";
import { computeVotingResults } from "./sessionRepository";

const MAX_POINTS = 10000;

const MAX_PROMPT_TEXT_LENGTH = 1000;

/**
 * In-memory test double.
 *
 * createSession mirrors the production repository's conceptual atomic
 * operation: validation occurs before either the session or event is stored.
 * joinParticipant follows the identical pattern for participants, and is
 * independently authoritative for session-state — it re-checks the
 * session's current state itself rather than trusting a caller's earlier
 * lookup, mirroring join_participant_atomically's row-locked re-check in
 * the real database function.
 */
export class InMemorySessionRepository implements SessionRepository {
  private sessions = new Map<string, SessionRecord>();

  private participants = new Map<string, ParticipantRecord>();

  private events: Array<SessionEventRecord> = [];

  private submissions = new Map<string, SubmissionRecord>();

  private prompts = new Map<string, PromptRecord>();

  /**
   * Slice 001 (Session / Interaction separation). No seeded content —
   * unlike prompts, which were previously seeded with one fixed row,
   * interaction instances (and the prompts that back them) are always
   * created dynamically from host-supplied text via startSession.
   */
  private interactionInstances = new Map<string, InteractionInstanceRecord>();

  /**
   * Duel / SESSION_SUBGAME v1. Keyed by duelId. Duel is its own
   * structurally separate entity, never an interactionInstances row —
   * see 0128's migration comment for why.
   */
  private duels = new Map<string, DuelRecord>();

  /** Keyed by `${duelId}:${participantId}` — mirrors duel_responses' own composite primary key. */
  private duelResponses = new Map<
    string,
    { participantId: string; selectedOptionIndex: number; answeredAt: string }
  >();

  /**
   * correctOptionIndex is intentionally not part of DuelRecord — kept
   * on this side map, keyed by duelId, so it can never leak through
   * getActiveDuelForSession/getDuelsForSession before resolution,
   * mirroring how the real duels table's own column is simply never
   * selected by the read paths GET_SESSION uses pre-resolution.
   */
  private duelCorrectOptionIndexes = new Map<string, number>();

  /**
   * Slice 008 (Segment / Turn grouping). Keyed by segmentId. No stored
   * "current" pointer — the current Segment is always the one whose
   * segmentOrdinal is highest for a given session (see
   * getCurrentSegmentForSession).
   */
  private segments = new Map<string, SegmentRecord>();

  /**
   * Slice 002 (Scored Multi-Round Experience). Keyed by pointAwardId,
   * not by (sessionId, idempotencyKey) — the idempotency lookup below
   * scans values, mirroring how getCurrentInteractionInstance scans
   * rather than maintaining a second index, since this test double
   * prioritizes fidelity to the atomic function's logic over raw
   * performance.
   */
  private pointAwards = new Map<string, PointAwardRecord>();

  /**
   * Idempotency index: `${sessionId}:${idempotencyKey}` -> pointAwardId.
   * Kept separate from PointAwardRecord itself since idempotencyKey is
   * an internal deduplication detail, not part of the record the
   * domain layer or GET_SESSION ever sees.
   */
  private pointAwardIdempotencyIndex = new Map<string, string>();

  /**
   * Slice 003 (Second Interaction Engine). Multiple Choice's own data
   * for one interaction instance — a 1:1 extension, keyed by
   * interactionInstanceId, mirroring multiple_choice_details.
   */
  private multipleChoiceDetails = new Map<string, MultipleChoiceDetailsRecord>();

  /**
   * Slice 003. A session's pre-authored Multiple Choice question
   * queue, keyed by preparedQuestionId.
   */
  private preparedQuestions = new Map<string, PreparedQuestionRecord>();

  /**
   * Slice 007 (Voting Engine). Voting-owned Candidate snapshots, keyed
   * by candidateId. A 1:N extension of interaction_instances, mirroring
   * multipleChoiceDetails' 1:1 extension shape widened to N rows.
   */
  private votingCandidates = new Map<string, VotingCandidateRecord>();

  /**
   * Slice 007. One row per participant who has voted in one Voting
   * interaction instance, keyed by voteId.
   */
  private votes = new Map<string, VoteRecord>();

  /**
   * Quiz Experience. One row per Quiz Segment, keyed by segmentId
   * (matching QuizWindowRecord's own identity — see its doc comment
   * for why this is the minimum authoritative state that cannot be
   * derived from anything else already in this repository).
   */
  private quizWindows = new Map<string, QuizWindowRecord>();

  /**
   * The current interaction instance for a session is "the most
   * recently created one" — never a stored pointer (see the accepted
   * Slice 001 design's stress test). Returns null if no interaction
   * has ever been started for this session.
   */
  private getCurrentInteractionInstance(
    sessionId: string
  ): InteractionInstanceRecord | null {
    const instances = [...this.interactionInstances.values()]
      .filter((instance) => instance.sessionId === sessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    return instances.length > 0 ? instances[instances.length - 1] : null;
  }

  /**
   * Slice 008. The current Segment for a session is the one with the
   * highest segmentOrdinal — never a stored pointer, mirroring
   * getCurrentInteractionInstance's identical derivation one level up.
   */
  private getCurrentSegmentForSession(sessionId: string): SegmentRecord | null {
    const segments = [...this.segments.values()]
      .filter((segment) => segment.sessionId === sessionId)
      .sort((a, b) => a.segmentOrdinal - b.segmentOrdinal);

    return segments.length > 0 ? segments[segments.length - 1] : null;
  }

  private validateAndTrimPromptText(text: string): string {
    const trimmed = text.trim();

    if (trimmed.length === 0) {
      throw new EmptyPromptTextError();
    }

    if (trimmed.length > MAX_PROMPT_TEXT_LENGTH) {
      throw new PromptTextTooLongError();
    }

    return trimmed;
  }

  async createSession(
    record: SessionRecord,
    initialEvent: SessionEventRecord
  ): Promise<void> {
    const collision = [...this.sessions.values()].some(
      (session) =>
        session.roomCode === record.roomCode &&
        session.state !== "SESSION_COMPLETE"
    );

    if (collision) {
      throw new RoomCodeCollisionError();
    }

    // Mirrors sessions_predecessor_session_id_unique (0028): at most
    // one session may name a given predecessor. Null predecessors
    // never collide with each other, matching Postgres unique-index
    // semantics for null values.
    if (
      record.predecessorSessionId !== null &&
      [...this.sessions.values()].some(
        (session) => session.predecessorSessionId === record.predecessorSessionId
      )
    ) {
      throw new PredecessorAlreadyHasSuccessorError();
    }

    if (this.sessions.has(record.sessionId)) {
      throw new Error("Duplicate session_id insert.");
    }

    if (initialEvent.sessionId !== record.sessionId) {
      throw new Error(
        "Initial event sessionId must match the session being created."
      );
    }

    /*
     * No mutation occurs before every validation succeeds. This preserves
     * all-or-nothing behavior within the in-memory implementation.
     */
    this.sessions.set(record.sessionId, { ...record });

    this.events.push({
      sessionId: initialEvent.sessionId,
      eventType: initialEvent.eventType,
      payload: { ...initialEvent.payload },
    });
  }

  async joinParticipant(
    record: ParticipantRecord,
    joinedEvent: ParticipantJoinedEventRecord
  ): Promise<void> {
    // Authoritative session-state re-check, independent of any earlier
    // application-layer lookup. Mirrors join_participant_atomically's
    // row-locked re-check in the real database function.
    const session = this.sessions.get(record.sessionId);

    if (!session) {
      throw new SessionNotFoundError();
    }

    if (session.state !== "LOBBY_OPEN") {
      throw new LobbyNotOpenError(session.state);
    }

    if ((session.declaredCapabilities ?? []).length === 0) {
      throw new SessionCapabilitiesNotDeclaredError();
    }

    const nameCollision = [...this.participants.values()].some(
      (participant) =>
        participant.sessionId === record.sessionId &&
        participant.normalizedDisplayName === record.normalizedDisplayName
    );

    if (nameCollision) {
      throw new DisplayNameTakenError();
    }

    // Mirrors participants_session_gaming_member_unique (0046): a
    // Gaming Member may have at most one Participant per Session. Guest
    // participants (gamingMemberId null) never collide with each other
    // or with anyone else here.
    if (record.gamingMemberId) {
      const gamingMemberCollision = [...this.participants.values()].some(
        (participant) =>
          participant.sessionId === record.sessionId &&
          participant.gamingMemberId === record.gamingMemberId
      );

      if (gamingMemberCollision) {
        throw new GamingMemberAlreadyInSessionError();
      }
    }

    if (this.participants.has(record.participantId)) {
      throw new Error("Duplicate participant_id insert.");
    }

    if (joinedEvent.sessionId !== record.sessionId) {
      throw new Error(
        "Joined event sessionId must match the participant's session."
      );
    }

    /*
     * No mutation occurs before every validation succeeds, matching
     * createSession's all-or-nothing behavior.
     */
    this.participants.set(record.participantId, { ...record });

    this.events.push({
      sessionId: joinedEvent.sessionId,
      eventType: joinedEvent.eventType,
      payload: { ...joinedEvent.payload },
    });
  }

  async getActiveSessionByRoomCode(
    roomCode: string
  ): Promise<SessionRecord | null> {
    const match = [...this.sessions.values()].find(
      (session) =>
        session.roomCode === roomCode && session.state !== "SESSION_COMPLETE"
    );

    return match ?? null;
  }

  async getSessionById(sessionId: string): Promise<SessionRecord | null> {
    return this.sessions.get(sessionId) ?? null;
  }

  async getSuccessorSessionByPredecessorId(
    predecessorSessionId: string
  ): Promise<SessionRecord | null> {
    const match = [...this.sessions.values()].find(
      (session) => session.predecessorSessionId === predecessorSessionId
    );

    return match ?? null;
  }

  async lockLobby(
    sessionId: string,
    hostToken: string,
    event: LobbyLockedEventRecord
  ): Promise<{ state: SessionRecord["state"]; stateVersion: number }> {
    // Authoritative host-token and session-state re-check, independent of
    // any earlier application-layer lookup. Mirrors
    // lock_lobby_atomically's row-locked re-check in the real database
    // function.
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new SessionNotFoundError();
    }

    if (session.hostToken !== hostToken) {
      throw new HostTokenMismatchError();
    }

    if (session.state !== "LOBBY_OPEN") {
      throw new LobbyNotOpenError(session.state);
    }

    if (event.sessionId !== sessionId) {
      throw new Error(
        "Lock event sessionId must match the session being locked."
      );
    }

    const updated: SessionRecord = {
      ...session,
      state: "LOBBY_LOCKED",
      stateVersion: session.stateVersion + 1,
      updatedAt: new Date().toISOString(),
    };

    this.sessions.set(sessionId, updated);

    this.events.push({
      sessionId: event.sessionId,
      eventType: event.eventType,
      payload: { ...event.payload },
    });

    return { state: updated.state, stateVersion: updated.stateVersion };
  }

  async setSessionCapabilities(
    sessionId: string,
    hostToken: string,
    capabilities: string[]
  ): Promise<{ declaredCapabilities: string[]; locked: boolean }> {
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new SessionNotFoundError();
    }

    if (session.hostToken !== hostToken) {
      throw new HostTokenMismatchError();
    }

    const normalized = [...new Set(capabilities)].sort();

    if (
      normalized.some(
        (key) => !SESSION_CAPABILITY_KEYS.includes(key as SessionCapabilityKey)
      )
    ) {
      throw new InvalidCapabilityKeyError();
    }

    const hasParticipants = [...this.participants.values()].some(
      (participant) => participant.sessionId === sessionId
    );

    if (hasParticipants) {
      const current = session.declaredCapabilities ?? [];
      const isSameSet =
        current.length === normalized.length &&
        current.every((key, index) => key === normalized[index]);

      if (!isSameSet) {
        throw new CapabilitiesLockedError();
      }

      return { declaredCapabilities: current, locked: true };
    }

    this.sessions.set(sessionId, {
      ...session,
      declaredCapabilities: normalized,
      updatedAt: new Date().toISOString(),
    });

    this.events.push({
      sessionId,
      eventType: "SESSION_CAPABILITIES_DECLARED",
      payload: { declaredCapabilities: normalized },
    });

    return { declaredCapabilities: normalized, locked: false };
  }

  async getParticipantsForSession(
    sessionId: string
  ): Promise<ParticipantRecord[]> {
    return [...this.participants.values()]
      .filter((participant) => participant.sessionId === sessionId)
      .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
  }

  async completeSession(
    sessionId: string,
    hostToken: string,
    event: SessionCompletedEventRecord
  ): Promise<{ state: SessionRecord["state"]; stateVersion: number }> {
    // Authoritative host-token and session-state re-check, independent of
    // any earlier application-layer lookup. Mirrors
    // complete_session_atomically's row-locked re-check in the real
    // database function.
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new SessionNotFoundError();
    }

    if (session.hostToken !== hostToken) {
      throw new HostTokenMismatchError();
    }

    if (session.state === "SESSION_COMPLETE") {
      throw new SessionAlreadyCompleteError();
    }

    if (event.sessionId !== sessionId) {
      throw new Error(
        "Completion event sessionId must match the session being completed."
      );
    }

    const updated: SessionRecord = {
      ...session,
      state: "SESSION_COMPLETE",
      stateVersion: session.stateVersion + 1,
      updatedAt: new Date().toISOString(),
    };

    this.sessions.set(sessionId, updated);

    // Duel / SESSION_SUBGAME v1: mirrors complete_session_atomically's
    // identical side effect (0135) — Session completion is never
    // blocked by an active Duel; it supersedes it, resolving VOID,
    // never fabricating a winner.
    const activeDuel = this.getActiveDuelRecordForSession(sessionId);
    if (activeDuel) {
      const endedAt = new Date().toISOString();
      const voided: DuelRecord = {
        ...activeDuel,
        lifecycleState: "COMPLETED",
        terminalResolution: "VOID",
        winnerParticipantId: null,
        reason: "Session completed while Duel was active",
        endedAt,
      };
      this.duels.set(activeDuel.duelId, voided);

      this.events.push({
        sessionId,
        eventType: "DUEL_RESOLVED",
        payload: {
          duelId: activeDuel.duelId,
          terminalResolution: "VOID",
          winnerParticipantId: null,
          reason: "Session completed while Duel was active",
        },
      });
    }

    this.events.push({
      sessionId: event.sessionId,
      eventType: event.eventType,
      payload: { ...event.payload },
    });

    return { state: updated.state, stateVersion: updated.stateVersion };
  }

  async getPromptById(promptId: string): Promise<PromptRecord | null> {
    return this.prompts.get(promptId) ?? null;
  }

  async getInteractionInstancesForSession(
    sessionId: string
  ): Promise<InteractionInstanceRecord[]> {
    return [...this.interactionInstances.values()]
      .filter((instance) => instance.sessionId === sessionId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  async getSegmentsForSession(sessionId: string): Promise<SegmentRecord[]> {
    return [...this.segments.values()]
      .filter((segment) => segment.sessionId === sessionId)
      .sort((a, b) => a.segmentOrdinal - b.segmentOrdinal);
  }

  async startSession(
    sessionId: string,
    hostToken: string,
    config: StartTurnConfig,
    segmentTarget: SegmentTarget = "NEW_SEGMENT"
  ): Promise<{
    interactionInstanceId: string;
    promptId: string;
    state: InteractionState;
    engineType: EngineType;
    segmentNumber: number;
  }> {
    // Authoritative host-token and session-state re-check, independent of
    // any earlier application-layer lookup. Mirrors
    // start_session_atomically's row-locked re-check in the real
    // database function.
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new SessionNotFoundError();
    }

    if (session.hostToken !== hostToken) {
      throw new HostTokenMismatchError();
    }

    if (session.state !== "LOBBY_LOCKED") {
      throw new LobbyNotLockedError(session.state);
    }

    // Duel / SESSION_SUBGAME v1: mirrors start_session_atomically's
    // identical guard (0133) — symmetric half of the mutual-exclusion
    // invariant with startDuel, below.
    if (this.getActiveDuelRecordForSession(sessionId)) {
      throw new ActiveDuelExistsError();
    }

    // Session Capability Architecture v1: mirrors
    // start_session_atomically's identical guard (0111) — TRIVIA for
    // the ad-hoc MULTIPLE_CHOICE path, VOTING, or OPEN_RESPONSE. QUIZ
    // is never reachable here (see startQuiz's own, structurally
    // separate method below).
    const requiredCapability: SessionCapabilityKey =
      config.engineType === "MULTIPLE_CHOICE"
        ? "TRIVIA"
        : config.engineType === "VOTING"
        ? "VOTING"
        : "OPEN_RESPONSE";
    if (!(session.declaredCapabilities ?? []).includes(requiredCapability)) {
      throw new CapabilityNotAuthorizedError(requiredCapability);
    }

    // Re-invocable precondition: the session's current interaction
    // instance, if any, must already be RESULT_REVEAL before another
    // one may begin. Applies identically to both segmentTargets — see
    // 0037's migration comment for why CURRENT_SEGMENT does not relax
    // this.
    const previousInteraction = this.getCurrentInteractionInstance(sessionId);
    if (previousInteraction && previousInteraction.state !== "RESULT_REVEAL") {
      throw new PreviousInteractionNotRevealedError(previousInteraction.state);
    }

    // Slice 009: AmbiguousStartSessionTargetError is no longer checked
    // here — config is a real discriminated union at this point, so
    // "both a preparedQuestionId and a candidateSource" is structurally
    // unreachable through this call. The error remains reachable only
    // where untyped input still exists: the API route's legacy flat-
    // shape compatibility shim, and the SQL RPC's own defense-in-depth
    // re-check (unchanged).

    // Slice 008 (Segment / Turn grouping): resolve which Segment the new
    // Interaction Instance joins. NEW_SEGMENT allocates the next
    // segmentOrdinal for this session — safe here because, unlike real
    // Postgres, this in-memory double is single-threaded, so there is no
    // MAX+1 race to protect against; the real database's equivalent
    // safety comes from the session-row lock (see 0037's comment).
    // CURRENT_SEGMENT reuses the existing current Segment untouched.
    let segment: SegmentRecord;
    if (segmentTarget === "CURRENT_SEGMENT") {
      const currentSegment = this.getCurrentSegmentForSession(sessionId);
      if (!currentSegment) {
        throw new NoCurrentSegmentToContinueError();
      }
      segment = currentSegment;
    } else {
      const currentSegment = this.getCurrentSegmentForSession(sessionId);
      const nextOrdinal = currentSegment ? currentSegment.segmentOrdinal + 1 : 1;
      segment = {
        segmentId: randomUUID(),
        sessionId,
        segmentOrdinal: nextOrdinal,
        createdAt: new Date().toISOString(),
      };
      this.segments.set(segment.segmentId, segment);
    }

    const now = new Date().toISOString();
    let promptTextToStore: string;
    let engineType: EngineType;
    let preparedQuestionToConsume: PreparedQuestionRecord | undefined;
    // Slice 009: each entry pairs a Candidate's label with its
    // structured participantId attribution (null for HOST_AUTHORED) —
    // see VotingCandidateRecord's own comment for why this exists.
    let votingCandidatesToCreate:
      | Array<{ label: string; participantId: string | null }>
      | undefined;

    if (config.engineType === "MULTIPLE_CHOICE") {
      // Slice 003: explicit prepared-question target — the caller
      // names the exact question, this method never infers one.
      const prepared = this.preparedQuestions.get(config.preparedQuestionId);

      if (!prepared || prepared.sessionId !== sessionId) {
        throw new PreparedQuestionNotFoundError();
      }

      if (prepared.consumedAt !== null) {
        throw new PreparedQuestionAlreadyConsumedError();
      }

      promptTextToStore = prepared.promptText;
      engineType = "MULTIPLE_CHOICE";
      preparedQuestionToConsume = prepared;
    } else if (config.engineType === "VOTING") {
      // Slice 007 (Voting Engine): unlike the prepared-question path,
      // Voting always needs host-framed prompt text — no Candidate
      // source provides one.
      promptTextToStore = this.validateAndTrimPromptText(config.promptText);
      engineType = "VOTING";

      const source = config.candidateSource;
      if (source.type === "HOST_AUTHORED") {
        const trimmed = source.candidates.map((c) => c.trim());
        const distinct = new Set(trimmed);
        if (
          trimmed.length < 2 ||
          trimmed.some((c) => c.length === 0) ||
          distinct.size !== trimmed.length
        ) {
          throw new InvalidVotingCandidatesError();
        }
        votingCandidatesToCreate = trimmed.map((label) => ({
          label,
          participantId: null,
        }));
      } else if (source.type === "SUBMISSION") {
        const sourceInteraction = this.interactionInstances.get(
          source.sourceInteractionInstanceId
        );
        if (!sourceInteraction || sourceInteraction.sessionId !== sessionId) {
          throw new VotingSourceInteractionNotFoundError();
        }
        if (
          sourceInteraction.engineType !== "OPEN_RESPONSE" ||
          sourceInteraction.state !== "RESULT_REVEAL"
        ) {
          throw new VotingSourceInteractionNotEligibleError();
        }
        const sourceSubmissions = [...this.submissions.values()]
          .filter(
            (s) => s.interactionInstanceId === sourceInteraction.interactionInstanceId
          )
          .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
        if (sourceSubmissions.length === 0) {
          throw new VotingSourceInteractionNotEligibleError();
        }
        // Slice 009: participantId now carried alongside label — the
        // submission's own author, already read in this same query, at
        // zero marginal cost.
        votingCandidatesToCreate = sourceSubmissions.map((s) => ({
          label: s.text,
          participantId: s.participantId,
        }));
      } else {
        // Slice 009: PARTICIPANTS — snapshot the session's current
        // roster. Same ≥2 floor as HOST_AUTHORED; a Voting round with
        // fewer than two Candidates is unusable regardless of source.
        const roster = [...this.participants.values()]
          .filter((p) => p.sessionId === sessionId)
          .sort((a, b) => a.joinedAt.localeCompare(b.joinedAt));
        if (roster.length < 2) {
          throw new InvalidVotingCandidatesError();
        }
        votingCandidatesToCreate = roster.map((p) => ({
          label: p.displayName,
          participantId: p.participantId,
        }));
      }
    } else {
      promptTextToStore = this.validateAndTrimPromptText(config.promptText);
      engineType = "OPEN_RESPONSE";
    }

    const promptId = randomUUID();
    this.prompts.set(promptId, { promptId, text: promptTextToStore });

    const interactionInstanceId = randomUUID();
    const interactionInstance: InteractionInstanceRecord = {
      interactionInstanceId,
      sessionId,
      segmentId: segment.segmentId,
      promptId,
      state: "PROMPT_ACTIVE",
      engineType,
      createdAt: now,
      updatedAt: now,
    };
    this.interactionInstances.set(interactionInstanceId, interactionInstance);

    if (preparedQuestionToConsume) {
      this.multipleChoiceDetails.set(interactionInstanceId, {
        interactionInstanceId,
        options: preparedQuestionToConsume.options,
        correctOptionIndex: preparedQuestionToConsume.correctOptionIndex,
        pointsForCorrect: preparedQuestionToConsume.pointsForCorrect,
      });

      this.preparedQuestions.set(preparedQuestionToConsume.preparedQuestionId, {
        ...preparedQuestionToConsume,
        consumedAt: now,
      });
    }

    if (votingCandidatesToCreate) {
      votingCandidatesToCreate.forEach(({ label, participantId }, ordinal) => {
        const candidateId = randomUUID();
        this.votingCandidates.set(candidateId, {
          candidateId,
          interactionInstanceId,
          ordinal,
          label,
          participantId,
          createdAt: now,
        });
      });
    }

    this.events.push({
      sessionId,
      eventType: "INTERACTION_STARTED",
      payload: { interactionInstanceId, promptId, engineType },
    });

    return {
      interactionInstanceId,
      promptId,
      state: "PROMPT_ACTIVE",
      engineType,
      segmentNumber: segment.segmentOrdinal,
    };
  }

  async submitResponse(
    sessionId: string,
    participantId: string,
    participantToken: string,
    text: string
  ): Promise<{
    submissionId: string;
    interactionInstanceId: string;
    promptId: string;
    updatedAt: string;
  }> {
    // Authoritative participant-token and session/interaction-state
    // re-check, independent of any earlier application-layer lookup.
    // Mirrors submit_response_atomically's row-locked re-check in the
    // real database function. Also re-resolves the current interaction
    // instance here (not trusting an earlier domain-layer read), since
    // that's what the submission and its event are scoped to.
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new SessionNotFoundError();
    }

    const participant = this.participants.get(participantId);
    if (!participant || participant.participantToken !== participantToken) {
      throw new SessionAccessDeniedError();
    }

    const interactionInstance = this.getCurrentInteractionInstance(sessionId);

    if (
      session.state !== "LOBBY_LOCKED" ||
      !interactionInstance ||
      interactionInstance.state !== "PROMPT_ACTIVE"
    ) {
      throw new PromptNotActiveError(interactionInstance?.state);
    }

    const { interactionInstanceId, promptId } = interactionInstance;
    const now = new Date().toISOString();

    // Upsert: one submission per participant per interaction instance.
    // "Last write wins" is an explicit MVP implementation decision, not
    // a permanent gameplay rule — see SubmitResponseResult's doc
    // comment.
    const existing = [...this.submissions.values()].find(
      (submission) =>
        submission.interactionInstanceId === interactionInstanceId &&
        submission.participantId === participantId
    );

    const submissionId = existing?.submissionId ?? randomUUID();
    const record: SubmissionRecord = {
      submissionId,
      sessionId,
      interactionInstanceId,
      participantId,
      promptId,
      text,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.submissions.set(submissionId, record);

    this.events.push({
      sessionId,
      eventType: "RESPONSE_SUBMITTED",
      payload: { participantId, interactionInstanceId, promptId },
    });

    return { submissionId, interactionInstanceId, promptId, updatedAt: now };
  }

  async getSubmissionsForInteractionInstance(
    interactionInstanceId: string
  ): Promise<SubmissionRecord[]> {
    return [...this.submissions.values()].filter(
      (submission) => submission.interactionInstanceId === interactionInstanceId
    );
  }

  async closeSubmissions(
    sessionId: string,
    hostToken: string,
    event: SubmissionsClosedEventRecord
  ): Promise<{ interactionInstanceId: string; state: InteractionState }> {
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new SessionNotFoundError();
    }

    if (session.hostToken !== hostToken) {
      throw new HostTokenMismatchError();
    }

    const interactionInstance = this.getCurrentInteractionInstance(sessionId);

    if (
      session.state !== "LOBBY_LOCKED" ||
      !interactionInstance ||
      interactionInstance.state !== "PROMPT_ACTIVE"
    ) {
      throw new PromptNotActiveError(interactionInstance?.state);
    }

    const updated: InteractionInstanceRecord = {
      ...interactionInstance,
      state: "SUBMISSIONS_CLOSED",
      updatedAt: new Date().toISOString(),
    };
    this.interactionInstances.set(updated.interactionInstanceId, updated);

    this.events.push({
      sessionId: event.sessionId,
      eventType: event.eventType,
      payload: { ...event.payload },
    });

    return {
      interactionInstanceId: updated.interactionInstanceId,
      state: updated.state,
    };
  }

  async revealResults(
    sessionId: string,
    hostToken: string,
    event: ResultsRevealedEventRecord
  ): Promise<{ interactionInstanceId: string; state: InteractionState }> {
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new SessionNotFoundError();
    }

    if (session.hostToken !== hostToken) {
      throw new HostTokenMismatchError();
    }

    const interactionInstance = this.getCurrentInteractionInstance(sessionId);

    if (
      session.state !== "LOBBY_LOCKED" ||
      !interactionInstance ||
      interactionInstance.state !== "SUBMISSIONS_CLOSED"
    ) {
      throw new SubmissionsNotClosedError(interactionInstance?.state);
    }

    const updated: InteractionInstanceRecord = {
      ...interactionInstance,
      state: "RESULT_REVEAL",
      updatedAt: new Date().toISOString(),
    };
    this.interactionInstances.set(updated.interactionInstanceId, updated);

    this.events.push({
      sessionId: event.sessionId,
      eventType: event.eventType,
      payload: { ...event.payload },
    });

    // Slice 003 (Second Interaction Engine): for a Multiple Choice
    // interaction, automatic scoring happens here, in the same
    // synchronous call as the state transition above — mirroring
    // reveal_results_atomically's single-transaction guarantee (see
    // 0027's migration comment). A single-threaded in-memory double
    // cannot demonstrate the atomicity property itself (nothing here
    // can partially fail), but the *shape* — evaluation as an
    // inseparable step of reveal, not a later independent call — is
    // reproduced faithfully so in-memory tests exercise the same logic
    // a live contract test verifies is transactional.
    const details = this.multipleChoiceDetails.get(updated.interactionInstanceId);
    if (details) {
      const submissions = await this.getSubmissionsForInteractionInstance(
        updated.interactionInstanceId
      );

      for (const submission of submissions) {
        if (submission.text !== String(details.correctOptionIndex)) {
          continue;
        }

        // Deterministic per-(interaction, participant) key so this
        // step can never double-award if ever re-run. Unlike
        // award_points_atomically's real-Postgres counterpart, this
        // in-memory idempotency_key has no uuid-column constraint to
        // satisfy, so the readable form is used directly rather than
        // hashed.
        const idempotencyKey = `mc-auto:${updated.interactionInstanceId}:${submission.participantId}`;
        const indexKey = `${sessionId}:${idempotencyKey}`;

        if (this.pointAwardIdempotencyIndex.has(indexKey)) {
          continue;
        }

        const pointAwardId = randomUUID();
        const award: PointAwardRecord = {
          pointAwardId,
          sessionId,
          interactionInstanceId: updated.interactionInstanceId,
          participantId: submission.participantId,
          points: details.pointsForCorrect,
          createdAt: new Date().toISOString(),
        };

        this.pointAwards.set(pointAwardId, award);
        this.pointAwardIdempotencyIndex.set(indexKey, pointAwardId);

        this.events.push({
          sessionId,
          eventType: "POINTS_AWARDED",
          payload: {
            pointAwardId,
            interactionInstanceId: updated.interactionInstanceId,
            participantId: submission.participantId,
            points: details.pointsForCorrect,
          },
        });
      }
    }

    return {
      interactionInstanceId: updated.interactionInstanceId,
      state: updated.state,
    };
  }

  async awardPoints(
    sessionId: string,
    hostToken: string,
    interactionInstanceId: string,
    participantId: string,
    points: number,
    idempotencyKey: string
  ): Promise<PointAwardRecord> {
    // Step 1: idempotency-first resolution, scoped to this session. No
    // other check runs if a match is found — this is what lets a
    // retry succeed identically even after the session has since
    // progressed past the interaction this award targeted.
    const indexKey = `${sessionId}:${idempotencyKey}`;
    const existingId = this.pointAwardIdempotencyIndex.get(indexKey);
    if (existingId) {
      const existing = this.pointAwards.get(existingId);
      if (existing) {
        return existing;
      }
    }

    // Step 2: new-award path — full validation, reached only when the
    // idempotency key is genuinely new for this session.
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new SessionNotFoundError();
    }

    if (session.hostToken !== hostToken) {
      throw new HostTokenMismatchError();
    }

    if (session.state !== "LOBBY_LOCKED") {
      throw new LobbyNotLockedError(session.state);
    }

    const currentInteraction = this.getCurrentInteractionInstance(sessionId);

    if (
      !currentInteraction ||
      currentInteraction.interactionInstanceId !== interactionInstanceId ||
      currentInteraction.state !== "RESULT_REVEAL"
    ) {
      throw new InteractionInstanceNotEligibleError();
    }

    const participant = this.participants.get(participantId);
    if (!participant || participant.sessionId !== sessionId) {
      throw new ParticipantNotInSessionError();
    }

    if (!Number.isInteger(points) || points <= 0 || points > MAX_POINTS) {
      throw new InvalidPointsError();
    }

    // Step 3: insert. A genuine race between two concurrent requests
    // carrying the same (sessionId, idempotencyKey) cannot occur
    // within a single-threaded in-memory double the way it can against
    // real Postgres — this re-check exists so the logic mirrors the
    // atomic function's shape exactly, not because JS needs it here.
    const raceWinnerId = this.pointAwardIdempotencyIndex.get(indexKey);
    if (raceWinnerId) {
      const winner = this.pointAwards.get(raceWinnerId);
      if (winner) {
        return winner;
      }
    }

    const pointAwardId = randomUUID();
    const record: PointAwardRecord = {
      pointAwardId,
      sessionId,
      interactionInstanceId,
      participantId,
      points,
      createdAt: new Date().toISOString(),
    };

    this.pointAwards.set(pointAwardId, record);
    this.pointAwardIdempotencyIndex.set(indexKey, pointAwardId);

    this.events.push({
      sessionId,
      eventType: "POINTS_AWARDED",
      payload: { pointAwardId, interactionInstanceId, participantId, points },
    });

    return record;
  }

  async getPointAwardsForSession(sessionId: string): Promise<PointAwardRecord[]> {
    return [...this.pointAwards.values()].filter(
      (award) => award.sessionId === sessionId
    );
  }

  /** Test-only helper, not part of the repository interface. */
  _allPointAwards() {
    return [...this.pointAwards.values()];
  }

  /** Test-only helper, not part of the repository interface. */
  _getEventsForSession(sessionId: string) {
    return this.events.filter((event) => event.sessionId === sessionId);
  }

  /** Test-only helper to inspect current size and state. */
  _all() {
    return [...this.sessions.values()];
  }

  /** Test-only helper to inspect stored participants. */
  _allParticipants() {
    return [...this.participants.values()];
  }

  /**
   * Test-only helper to jump a session directly to SESSION_COMPLETE
   * without going through completeSession()'s host-token check —
   * useful for tests that only need a completed session as setup, not
   * as the behavior under test.
   */
  _forceComplete(sessionId: string) {
    const session = this.sessions.get(sessionId);

    if (session) {
      this.sessions.set(sessionId, {
        ...session,
        state: "SESSION_COMPLETE",
      });
    }
  }

  /**
   * Test-only helper simulating a LEGACY_UNDECLARED row (declared_
   * capabilities null) — the only way such a row can exist is a
   * session that predates Session Capability Architecture v1, which
   * this repository has no other way to construct directly.
   */
  _setDeclaredCapabilitiesForTest(sessionId: string, capabilities: string[] | null) {
    const session = this.sessions.get(sessionId);

    if (session) {
      this.sessions.set(sessionId, { ...session, declaredCapabilities: capabilities });
    }
  }

  /** Test-only helper to force a session into an arbitrary state directly. */
  _forceState(sessionId: string, state: SessionRecord["state"]) {
    const session = this.sessions.get(sessionId);

    if (session) {
      this.sessions.set(sessionId, { ...session, state });
    }
  }

  /** Test-only helper, not part of the repository interface. */
  _allInteractionInstances() {
    return [...this.interactionInstances.values()];
  }

  /** Test-only helper, not part of the repository interface. */
  _allSegments() {
    return [...this.segments.values()];
  }

  async createPreparedQuestions(
    sessionId: string,
    questions: Array<{
      promptText: string;
      options: string[];
      correctOptionIndex: number;
      pointsForCorrect: number;
    }>
  ): Promise<PreparedQuestionRecord[]> {
    // Session Capability Architecture v1: authoritative re-check,
    // independent of the domain layer's own fast-path — see
    // prepareQuestions.ts's comment for why "QUIZ or TRIVIA," not
    // either alone.
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new SessionNotFoundError();
    }
    const declaredCapabilities = session.declaredCapabilities ?? [];
    if (
      !declaredCapabilities.includes("QUIZ") &&
      !declaredCapabilities.includes("TRIVIA")
    ) {
      throw new CapabilityNotAuthorizedError("QUIZ or TRIVIA");
    }

    const existing = await this.getPreparedQuestionsForSession(sessionId);
    let nextOrdinal =
      existing.length > 0
        ? Math.max(...existing.map((q) => q.ordinal)) + 1
        : 1;

    const created: PreparedQuestionRecord[] = [];
    const now = new Date().toISOString();

    for (const question of questions) {
      const record: PreparedQuestionRecord = {
        preparedQuestionId: randomUUID(),
        sessionId,
        ordinal: nextOrdinal,
        promptText: question.promptText,
        options: question.options,
        correctOptionIndex: question.correctOptionIndex,
        pointsForCorrect: question.pointsForCorrect,
        consumedAt: null,
        createdAt: now,
      };

      this.preparedQuestions.set(record.preparedQuestionId, record);
      created.push(record);
      nextOrdinal += 1;
    }

    return created;
  }

  async getPreparedQuestionsForSession(
    sessionId: string
  ): Promise<PreparedQuestionRecord[]> {
    return [...this.preparedQuestions.values()]
      .filter((question) => question.sessionId === sessionId)
      .sort((a, b) => a.ordinal - b.ordinal);
  }

  async getMultipleChoiceDetailsForInteraction(
    interactionInstanceId: string
  ): Promise<MultipleChoiceDetailsRecord | null> {
    return this.multipleChoiceDetails.get(interactionInstanceId) ?? null;
  }

  /** Test-only helper, not part of the repository interface. */
  _allPreparedQuestions() {
    return [...this.preparedQuestions.values()];
  }

  /** Test-only helper, not part of the repository interface. */
  _allMultipleChoiceDetails() {
    return [...this.multipleChoiceDetails.values()];
  }

  async getVotingCandidatesForInteraction(
    interactionInstanceId: string
  ): Promise<VotingCandidateRecord[]> {
    return [...this.votingCandidates.values()]
      .filter((c) => c.interactionInstanceId === interactionInstanceId)
      .sort((a, b) => a.ordinal - b.ordinal);
  }

  async getVotesForInteractionInstance(
    interactionInstanceId: string
  ): Promise<VoteRecord[]> {
    return [...this.votes.values()].filter(
      (v) => v.interactionInstanceId === interactionInstanceId
    );
  }

  async getVotingResultsForInteractionInstance(
    interactionInstanceId: string
  ): Promise<VotingResultSummary[]> {
    const candidates = await this.getVotingCandidatesForInteraction(
      interactionInstanceId
    );
    const votes = await this.getVotesForInteractionInstance(interactionInstanceId);
    return computeVotingResults(candidates, votes);
  }

  async castVote(
    sessionId: string,
    participantId: string,
    participantToken: string,
    candidateId: string
  ): Promise<{
    voteId: string;
    interactionInstanceId: string;
    candidateId: string;
    updatedAt: string;
  }> {
    // Authoritative participant-token and session/interaction-state
    // re-check, mirroring submitResponse's identical discipline.
    const session = this.sessions.get(sessionId);

    if (!session) {
      throw new SessionNotFoundError();
    }

    const participant = this.participants.get(participantId);
    if (!participant || participant.participantToken !== participantToken) {
      throw new SessionAccessDeniedError();
    }

    const interactionInstance = this.getCurrentInteractionInstance(sessionId);

    if (
      session.state !== "LOBBY_LOCKED" ||
      !interactionInstance ||
      interactionInstance.state !== "PROMPT_ACTIVE" ||
      interactionInstance.engineType !== "VOTING"
    ) {
      throw new PromptNotActiveError(interactionInstance?.state);
    }

    const { interactionInstanceId } = interactionInstance;

    const candidate = this.votingCandidates.get(candidateId);
    if (!candidate || candidate.interactionInstanceId !== interactionInstanceId) {
      throw new InvalidCandidateSelectionError();
    }

    // Slice 009: self-vote prohibition. Only meaningful when the
    // Candidate has structured participant attribution — HOST_AUTHORED
    // Candidates (participantId always null) are never subject to
    // this.
    if (candidate.participantId !== null && candidate.participantId === participantId) {
      throw new SelfVoteNotAllowedError();
    }

    const now = new Date().toISOString();

    // Upsert: one vote per participant per interaction instance,
    // "last write wins" while PROMPT_ACTIVE — mirrors submitResponse's
    // identical MVP decision, applied to votes instead of submissions.
    const existing = [...this.votes.values()].find(
      (v) =>
        v.interactionInstanceId === interactionInstanceId &&
        v.participantId === participantId
    );

    const voteId = existing?.voteId ?? randomUUID();
    const record: VoteRecord = {
      voteId,
      interactionInstanceId,
      participantId,
      candidateId,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };

    this.votes.set(voteId, record);

    this.events.push({
      sessionId,
      eventType: "VOTE_CAST",
      payload: { participantId, interactionInstanceId, candidateId },
    });

    return { voteId, interactionInstanceId, candidateId, updatedAt: now };
  }

  /** Test-only helper, not part of the repository interface. */
  _allVotingCandidates() {
    return [...this.votingCandidates.values()];
  }

  /** Test-only helper, not part of the repository interface. */
  _allVotes() {
    return [...this.votes.values()];
  }

  /**
   * Quiz Experience. Dedicated, not a generalization of startSession —
   * see this platform's implementation-readiness design. Mirrors
   * startSession's own authoritative host-token/session-state re-check
   * and NEW_SEGMENT allocation exactly, then consumes every currently-
   * unconsumed prepared question for this session into its own new
   * Multiple Choice Interaction Instance, all created PROMPT_ACTIVE
   * together (never lazily — see the accepted design's Seam 3
   * resolution for why).
   */
  async startQuiz(
    sessionId: string,
    hostToken: string,
    durationSeconds: number
  ): Promise<{
    segmentId: string;
    segmentOrdinal: number;
    closesAt: string;
    interactionInstanceIds: string[];
  }> {
    if (
      !Number.isInteger(durationSeconds) ||
      durationSeconds < 30 ||
      durationSeconds > 3600
    ) {
      throw new InvalidQuizDurationError();
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new SessionNotFoundError();
    }
    if (session.hostToken !== hostToken) {
      throw new HostTokenMismatchError();
    }
    if (session.state !== "LOBBY_LOCKED") {
      throw new LobbyNotLockedError(session.state);
    }

    // Duel / SESSION_SUBGAME v1: mirrors start_quiz_atomically's
    // identical guard (0134), same as startSession's own guard above.
    if (this.getActiveDuelRecordForSession(sessionId)) {
      throw new ActiveDuelExistsError();
    }

    // Session Capability Architecture v1: mirrors start_quiz_atomically's
    // identical guard (0112).
    if (!(session.declaredCapabilities ?? []).includes("QUIZ")) {
      throw new CapabilityNotAuthorizedError("QUIZ");
    }

    const previousInteraction = this.getCurrentInteractionInstance(sessionId);
    if (previousInteraction && previousInteraction.state !== "RESULT_REVEAL") {
      throw new PreviousInteractionNotRevealedError(previousInteraction.state);
    }

    // Fail fast, before creating any Segment/window, mirroring
    // start_quiz_atomically's own SQL ordering.
    const unconsumed = [...this.preparedQuestions.values()]
      .filter((q) => q.sessionId === sessionId && q.consumedAt === null)
      .sort((a, b) => a.ordinal - b.ordinal);

    if (unconsumed.length === 0) {
      throw new EmptyQuizQuestionSetError();
    }

    const currentSegment = this.getCurrentSegmentForSession(sessionId);
    const segmentOrdinal = currentSegment ? currentSegment.segmentOrdinal + 1 : 1;
    const now = new Date().toISOString();
    const segment: SegmentRecord = {
      segmentId: randomUUID(),
      sessionId,
      segmentOrdinal,
      createdAt: now,
    };
    this.segments.set(segment.segmentId, segment);

    const closesAt = new Date(Date.now() + durationSeconds * 1000).toISOString();
    this.quizWindows.set(segment.segmentId, {
      segmentId: segment.segmentId,
      closesAt,
      closedAt: null,
    });

    const interactionInstanceIds: string[] = [];
    for (const prepared of unconsumed) {
      const promptId = randomUUID();
      this.prompts.set(promptId, { promptId, text: prepared.promptText });

      const interactionInstanceId = randomUUID();
      this.interactionInstances.set(interactionInstanceId, {
        interactionInstanceId,
        sessionId,
        segmentId: segment.segmentId,
        promptId,
        state: "PROMPT_ACTIVE",
        engineType: "MULTIPLE_CHOICE",
        createdAt: now,
        updatedAt: now,
      });

      this.multipleChoiceDetails.set(interactionInstanceId, {
        interactionInstanceId,
        options: prepared.options,
        correctOptionIndex: prepared.correctOptionIndex,
        pointsForCorrect: prepared.pointsForCorrect,
      });

      this.preparedQuestions.set(prepared.preparedQuestionId, {
        ...prepared,
        consumedAt: now,
      });

      interactionInstanceIds.push(interactionInstanceId);
    }

    this.events.push({
      sessionId,
      eventType: "QUIZ_STARTED",
      payload: {
        segmentId: segment.segmentId,
        questionCount: interactionInstanceIds.length,
        closesAt,
      },
    });

    return {
      segmentId: segment.segmentId,
      segmentOrdinal,
      closesAt,
      interactionInstanceIds,
    };
  }

  /**
   * Quiz Experience. Dedicated, not a generalization of submitResponse
   * — the target Interaction Instance is explicit, not resolved as
   * "the current one." Authoritative validation mirrors
   * submit_quiz_response_atomically's SQL exactly: participant
   * ownership, that the target is a MULTIPLE_CHOICE instance belonging
   * to a Quiz Segment of this session, that the window is open (never
   * derived from the instance's own PROMPT_ACTIVE state alone — see
   * QuizWindowRecord's doc comment), and that the option index is in
   * bounds.
   */
  async submitQuizResponse(
    sessionId: string,
    participantId: string,
    participantToken: string,
    interactionInstanceId: string,
    selectedOptionIndex: number
  ): Promise<{
    submissionId: string;
    interactionInstanceId: string;
    updatedAt: string;
  }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new SessionNotFoundError();
    }

    const participant = this.participants.get(participantId);
    if (!participant || participant.participantToken !== participantToken) {
      throw new SessionAccessDeniedError();
    }

    const instance = this.interactionInstances.get(interactionInstanceId);
    if (
      !instance ||
      instance.sessionId !== sessionId ||
      instance.engineType !== "MULTIPLE_CHOICE"
    ) {
      throw new QuizInstanceNotFoundError();
    }

    const window = this.quizWindows.get(instance.segmentId);
    if (!window) {
      throw new QuizInstanceNotFoundError();
    }

    if (instance.state !== "PROMPT_ACTIVE") {
      throw new QuizClosedError();
    }

    if (window.closedAt !== null || Date.now() >= new Date(window.closesAt).getTime()) {
      throw new QuizClosedError();
    }

    const details = this.multipleChoiceDetails.get(interactionInstanceId);
    const optionCount = details?.options.length ?? 0;
    if (
      !Number.isInteger(selectedOptionIndex) ||
      selectedOptionIndex < 0 ||
      selectedOptionIndex >= optionCount
    ) {
      throw new InvalidOptionSelectionError();
    }

    const now = new Date().toISOString();
    const existing = [...this.submissions.values()].find(
      (submission) =>
        submission.interactionInstanceId === interactionInstanceId &&
        submission.participantId === participantId
    );

    const submissionId = existing?.submissionId ?? randomUUID();
    this.submissions.set(submissionId, {
      submissionId,
      sessionId,
      interactionInstanceId,
      participantId,
      promptId: instance.promptId,
      text: String(selectedOptionIndex),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    });

    this.events.push({
      sessionId,
      eventType: "QUIZ_RESPONSE_SUBMITTED",
      payload: { participantId, interactionInstanceId },
    });

    return { submissionId, interactionInstanceId, updatedAt: now };
  }

  /**
   * Quiz Experience. Dedicated, not a generalization of revealResults
   * — evaluates and reveals every question in the Quiz Segment
   * together, in one call, rather than one Interaction Instance at a
   * time. Idempotent: a second call after closedAt is already set
   * returns the existing result with no further work. Mirrors
   * close_quiz_atomically's SQL host-or-participant authority split
   * exactly.
   */
  async closeQuiz(
    sessionId: string,
    segmentId: string,
    callerToken: string
  ): Promise<{
    segmentId: string;
    closedAt: string;
    alreadyClosed: boolean;
  }> {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new SessionNotFoundError();
    }

    const segment = this.segments.get(segmentId);
    if (!segment || segment.sessionId !== sessionId) {
      throw new QuizNotFoundError();
    }

    const window = this.quizWindows.get(segmentId);
    if (!window) {
      throw new QuizNotFoundError();
    }

    if (window.closedAt !== null) {
      return { segmentId, closedAt: window.closedAt, alreadyClosed: true };
    }

    const isHost = callerToken === session.hostToken;
    const isParticipant = [...this.participants.values()].some(
      (p) => p.sessionId === sessionId && p.participantToken === callerToken
    );

    if (!isHost && !isParticipant) {
      throw new QuizAccessDeniedError();
    }

    let closedBy: "HOST" | "TIMER";
    if (isHost) {
      closedBy = "HOST";
    } else {
      if (Date.now() < new Date(window.closesAt).getTime()) {
        throw new QuizExpiryNotReachedError();
      }
      closedBy = "TIMER";
    }

    const closedAt = new Date().toISOString();
    this.quizWindows.set(segmentId, { ...window, closedAt });

    // Evaluate every question in this Segment together — mirrors
    // revealResults' single-instance evaluation (see that method's own
    // comment) at Segment scope instead.
    const instancesInSegment = [...this.interactionInstances.values()].filter(
      (i) => i.segmentId === segmentId
    );

    for (const instance of instancesInSegment) {
      const details = this.multipleChoiceDetails.get(instance.interactionInstanceId);
      if (!details) continue;

      const submissions = await this.getSubmissionsForInteractionInstance(
        instance.interactionInstanceId
      );

      for (const submission of submissions) {
        if (submission.text !== String(details.correctOptionIndex)) {
          continue;
        }

        const idempotencyKey = `quiz-auto:${instance.interactionInstanceId}:${submission.participantId}`;
        const indexKey = `${sessionId}:${idempotencyKey}`;
        if (this.pointAwardIdempotencyIndex.has(indexKey)) {
          continue;
        }

        const pointAwardId = randomUUID();
        this.pointAwards.set(pointAwardId, {
          pointAwardId,
          sessionId,
          interactionInstanceId: instance.interactionInstanceId,
          participantId: submission.participantId,
          points: details.pointsForCorrect,
          createdAt: new Date().toISOString(),
        });
        this.pointAwardIdempotencyIndex.set(indexKey, pointAwardId);

        this.events.push({
          sessionId,
          eventType: "POINTS_AWARDED",
          payload: {
            pointAwardId,
            interactionInstanceId: instance.interactionInstanceId,
            participantId: submission.participantId,
            points: details.pointsForCorrect,
          },
        });
      }

      if (instance.state !== "RESULT_REVEAL") {
        this.interactionInstances.set(instance.interactionInstanceId, {
          ...instance,
          state: "RESULT_REVEAL",
          updatedAt: closedAt,
        });
      }
    }

    this.events.push({
      sessionId,
      eventType: "QUIZ_CLOSED",
      payload: { segmentId, closedBy },
    });

    return { segmentId, closedAt, alreadyClosed: false };
  }

  async getQuizWindowForSegment(segmentId: string): Promise<QuizWindowRecord | null> {
    return this.quizWindows.get(segmentId) ?? null;
  }

  /**
   * Duel / SESSION_SUBGAME v1. Private helper shared by startSession,
   * startQuiz, completeSession, and the public
   * getActiveDuelForSession — the one-active-subgame-per-session
   * invariant, read from evidence rather than a duplicated flag.
   */
  private getActiveDuelRecordForSession(sessionId: string): DuelRecord | null {
    return (
      [...this.duels.values()].find(
        (duel) => duel.sessionId === sessionId && duel.lifecycleState === "ACTIVE"
      ) ?? null
    );
  }

  async startDuel(
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
  }> {
    if (competitorAParticipantId === competitorBParticipantId) {
      throw new DuplicateDuelCompetitorError();
    }

    if (
      !Array.isArray(options) ||
      options.length < 2 ||
      options.some((o) => o.trim().length === 0) ||
      new Set(options.map((o) => o.trim())).size !== options.length ||
      !Number.isInteger(correctOptionIndex) ||
      correctOptionIndex < 0 ||
      correctOptionIndex >= options.length
    ) {
      throw new InvalidDuelOptionsError();
    }

    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new SessionNotFoundError();
    }
    if (session.hostToken !== hostToken) {
      throw new HostTokenMismatchError();
    }
    if (session.state !== "LOBBY_LOCKED") {
      throw new LobbyNotLockedError(session.state);
    }
    if (!(session.declaredCapabilities ?? []).includes("DUEL")) {
      throw new CapabilityNotAuthorizedError("DUEL");
    }

    const competitorA = this.participants.get(competitorAParticipantId);
    if (!competitorA || competitorA.sessionId !== sessionId) {
      throw new DuelCompetitorNotInSessionError();
    }
    const competitorB = this.participants.get(competitorBParticipantId);
    if (!competitorB || competitorB.sessionId !== sessionId) {
      throw new DuelCompetitorNotInSessionError();
    }

    const previousInteraction = this.getCurrentInteractionInstance(sessionId);
    if (previousInteraction && previousInteraction.state !== "RESULT_REVEAL") {
      throw new InteractionActiveError(previousInteraction.state);
    }

    if (this.getActiveDuelRecordForSession(sessionId)) {
      throw new ActiveDuelExistsError();
    }

    const startedAt = new Date().toISOString();
    const trimmedPrompt = promptText.trim();
    const trimmedOptions = options.map((o) => o.trim());
    const duel: DuelRecord = {
      duelId: randomUUID(),
      sessionId,
      mechanicKey: "MULTIPLE_CHOICE",
      competitorAParticipantId,
      competitorBParticipantId,
      lifecycleState: "ACTIVE",
      terminalResolution: null,
      winnerParticipantId: null,
      reason: null,
      createdAt: startedAt,
      startedAt,
      endedAt: null,
      multipleChoice: {
        promptText: trimmedPrompt,
        options: trimmedOptions,
      },
    };
    this.duels.set(duel.duelId, duel);
    // correctOptionIndex is intentionally not stored on the public
    // DuelRecord shape — kept on a side map so it never leaks through
    // getActiveDuelForSession/getDuelsForSession before resolution.
    this.duelCorrectOptionIndexes.set(duel.duelId, correctOptionIndex);

    this.events.push({
      sessionId,
      eventType: "DUEL_STARTED",
      payload: {
        duelId: duel.duelId,
        competitorAParticipantId,
        competitorBParticipantId,
      },
    });

    return {
      duelId: duel.duelId,
      mechanicKey: duel.mechanicKey,
      lifecycleState: duel.lifecycleState,
      promptText: duel.multipleChoice.promptText,
      options: duel.multipleChoice.options,
      startedAt,
    };
  }

  async submitDuelResponse(
    duelId: string,
    participantToken: string,
    selectedOptionIndex: number
  ): Promise<{ participantId: string; answeredAt: string }> {
    const duel = this.duels.get(duelId);
    if (!duel) {
      throw new DuelNotFoundError();
    }
    if (duel.lifecycleState !== "ACTIVE") {
      throw new DuelNotActiveError(duel.lifecycleState);
    }

    const participant = [...this.participants.values()].find(
      (p) => p.sessionId === duel.sessionId && p.participantToken === participantToken
    );
    if (
      !participant ||
      (participant.participantId !== duel.competitorAParticipantId &&
        participant.participantId !== duel.competitorBParticipantId)
    ) {
      throw new DuelAccessDeniedError();
    }

    if (
      !Number.isInteger(selectedOptionIndex) ||
      selectedOptionIndex < 0 ||
      selectedOptionIndex >= duel.multipleChoice.options.length
    ) {
      throw new InvalidDuelOptionSelectionError();
    }

    const answeredAt = new Date().toISOString();
    this.duelResponses.set(`${duelId}:${participant.participantId}`, {
      participantId: participant.participantId,
      selectedOptionIndex,
      answeredAt,
    });

    return { participantId: participant.participantId, answeredAt };
  }

  async resolveDuel(
    duelId: string,
    hostToken: string
  ): Promise<{
    duelId: string;
    lifecycleState: DuelLifecycleState;
    terminalResolution: DuelTerminalResolution;
    winnerParticipantId: string | null;
  }> {
    const duel = this.duels.get(duelId);
    if (!duel) {
      throw new DuelNotFoundError();
    }
    const session = this.sessions.get(duel.sessionId);
    if (!session || session.hostToken !== hostToken) {
      throw new HostTokenMismatchError();
    }
    if (duel.lifecycleState !== "ACTIVE") {
      throw new DuelAlreadyResolvedError();
    }

    const correctOptionIndex = this.duelCorrectOptionIndexes.get(duelId);
    const responseA = this.duelResponses.get(`${duelId}:${duel.competitorAParticipantId}`);
    const responseB = this.duelResponses.get(`${duelId}:${duel.competitorBParticipantId}`);
    const aCorrect = responseA !== undefined && responseA.selectedOptionIndex === correctOptionIndex;
    const bCorrect = responseB !== undefined && responseB.selectedOptionIndex === correctOptionIndex;

    let terminalResolution: DuelTerminalResolution;
    let winnerParticipantId: string | null;

    if (responseA && responseB) {
      if (aCorrect && !bCorrect) {
        terminalResolution = "WON_LOST";
        winnerParticipantId = duel.competitorAParticipantId;
      } else if (bCorrect && !aCorrect) {
        terminalResolution = "WON_LOST";
        winnerParticipantId = duel.competitorBParticipantId;
      } else if (aCorrect && bCorrect) {
        if (responseA.answeredAt < responseB.answeredAt) {
          terminalResolution = "WON_LOST";
          winnerParticipantId = duel.competitorAParticipantId;
        } else if (responseB.answeredAt < responseA.answeredAt) {
          terminalResolution = "WON_LOST";
          winnerParticipantId = duel.competitorBParticipantId;
        } else {
          terminalResolution = "DRAW";
          winnerParticipantId = null;
        }
      } else {
        terminalResolution = "DRAW";
        winnerParticipantId = null;
      }
    } else if (responseA && aCorrect) {
      terminalResolution = "WON_LOST";
      winnerParticipantId = duel.competitorAParticipantId;
    } else if (responseB && bCorrect) {
      terminalResolution = "WON_LOST";
      winnerParticipantId = duel.competitorBParticipantId;
    } else {
      terminalResolution = "VOID";
      winnerParticipantId = null;
    }

    const endedAt = new Date().toISOString();
    const resolved: DuelRecord = {
      ...duel,
      lifecycleState: "COMPLETED",
      terminalResolution,
      winnerParticipantId,
      endedAt,
    };
    this.duels.set(duelId, resolved);

    this.events.push({
      sessionId: duel.sessionId,
      eventType: "DUEL_RESOLVED",
      payload: { duelId, terminalResolution, winnerParticipantId },
    });

    return { duelId, lifecycleState: "COMPLETED", terminalResolution, winnerParticipantId };
  }

  async resolveDuelExceptionally(
    duelId: string,
    hostToken: string,
    resolution: DuelExceptionalResolution,
    reason: string | null
  ): Promise<{
    duelId: string;
    lifecycleState: DuelLifecycleState;
    terminalResolution: DuelTerminalResolution;
    winnerParticipantId: string | null;
  }> {
    if (!["CANCELLED", "VOID", "FORFEIT_A", "FORFEIT_B"].includes(resolution)) {
      throw new InvalidDuelResolutionError();
    }
    if ((resolution === "FORFEIT_A" || resolution === "FORFEIT_B") && (!reason || reason.trim() === "")) {
      throw new DuelReasonRequiredError();
    }

    const duel = this.duels.get(duelId);
    if (!duel) {
      throw new DuelNotFoundError();
    }
    const session = this.sessions.get(duel.sessionId);
    if (!session || session.hostToken !== hostToken) {
      throw new HostTokenMismatchError();
    }
    if (duel.lifecycleState === "COMPLETED") {
      throw new DuelAlreadyResolvedError();
    }

    const winnerParticipantId =
      resolution === "FORFEIT_A"
        ? duel.competitorBParticipantId
        : resolution === "FORFEIT_B"
        ? duel.competitorAParticipantId
        : null;
    const terminalResolution: DuelTerminalResolution =
      resolution === "FORFEIT_A" || resolution === "FORFEIT_B" ? "FORFEIT" : resolution;

    const endedAt = new Date().toISOString();
    const resolved: DuelRecord = {
      ...duel,
      lifecycleState: "COMPLETED",
      terminalResolution,
      winnerParticipantId,
      reason,
      endedAt,
    };
    this.duels.set(duelId, resolved);

    this.events.push({
      sessionId: duel.sessionId,
      eventType: "DUEL_RESOLVED",
      payload: { duelId, terminalResolution, winnerParticipantId, reason },
    });

    return { duelId, lifecycleState: "COMPLETED", terminalResolution, winnerParticipantId };
  }

  async getDuelById(duelId: string): Promise<DuelRecord | null> {
    return this.duels.get(duelId) ?? null;
  }

  async getActiveDuelForSession(sessionId: string): Promise<DuelRecord | null> {
    return this.getActiveDuelRecordForSession(sessionId);
  }

  async getDuelsForSession(sessionId: string): Promise<DuelRecord[]> {
    return [...this.duels.values()]
      .filter((duel) => duel.sessionId === sessionId)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  async getDuelResponses(
    duelId: string
  ): Promise<Array<{ participantId: string; selectedOptionIndex: number; answeredAt: string }>> {
    return [...this.duelResponses.entries()]
      .filter(([key]) => key.startsWith(`${duelId}:`))
      .map(([, value]) => value);
  }

  /** Test-only helper, not part of the repository interface. */
  _allQuizWindows() {
    return [...this.quizWindows.values()];
  }
}
