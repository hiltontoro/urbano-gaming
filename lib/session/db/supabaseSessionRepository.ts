import { createClient } from "@supabase/supabase-js";
import type { SupabaseClient } from "@supabase/supabase-js";

import type {
  SessionRecord,
  SessionState,
  InteractionState,
  EngineType,
  VotingResultSummary,
  SegmentTarget,
  StartTurnConfig,
  DuelRecord,
  DuelMechanicKey,
  DuelLifecycleState,
  DuelTerminalResolution,
  DuelExceptionalResolution,
  MathDuelChallengeRecord,
  MathDuelResponseRecord,
} from "../types";
import type { MathDuelFixtureChallenge } from "../mathDuelFixture";
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
  AmbiguousStartSessionTargetError,
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
  InvalidMathDuelChallengesError,
  InvalidMathDuelOrdinalError,
  InvalidMathDuelAnswerError,
  MathDuelChallengesExhaustedError,
} from "../types";
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

/**
 * Supabase-backed implementation of SessionRepository.
 *
 * Session creation uses the create_session_atomically PostgreSQL function,
 * ensuring the session row and initial event are committed together or
 * rolled back together. joinParticipant follows the identical pattern via
 * a join_participant_atomically function — see
 * supabase/migrations/0004_join_participant_atomically.sql. lockLobby
 * follows the same pattern again via lock_lobby_atomically — see
 * supabase/migrations/0005_lock_lobby_atomically.sql. completeSession
 * follows the same pattern again via complete_session_atomically — see
 * supabase/migrations/0006_complete_session_atomically.sql.
 *
 * Slice 001 (Session / Interaction separation): startSession,
 * submitResponse, closeSubmissions, and revealResults now resolve and
 * operate on the session's *current interaction instance* rather than
 * the session's own state — see supabase/migrations/0017-0020, which
 * forward-fix 0010-0012 and 0008 respectively. This mirrors the
 * existing pairing rather than introducing a new persistence approach.
 */

/**
 * lock_lobby_atomically, join_participant_atomically,
 * start_session_atomically, submit_response_atomically,
 * close_submissions_atomically, and reveal_results_atomically each
 * raise their wrong-state exception with an embedded state name
 * ("... is in <STATE> state, not <REQUIRED_STATE>"), whether the
 * subject is "session" (pre-Slice-001 phrasing) or "current
 * interaction" (Slice 001 phrasing). Extracting it here lets every
 * translation site construct its specific error with the actual
 * state, matching the detail already available from the in-memory
 * repository and the domain-layer fast-path checks.
 */
function extractStateFromGuardMessage(
  message: string
): SessionState | undefined {
  const match = message.match(/is in (\w+) state/);
  return match ? (match[1] as SessionState) : undefined;
}

export class SupabaseSessionRepository implements SessionRepository {
  private client: SupabaseClient;

  constructor(supabaseUrl: string, supabaseServiceKey: string) {
    this.client = createClient(supabaseUrl, supabaseServiceKey);
  }

  async createSession(
    record: SessionRecord,
    initialEvent: SessionEventRecord
  ): Promise<void> {
    const { error } = await this.client.rpc("create_session_atomically", {
      p_session_id: record.sessionId,
      p_room_code: record.roomCode,
      p_host_token: record.hostToken,
      p_state: record.state,
      p_state_version: record.stateVersion,
      p_pause_reason: record.pauseReason,
      p_created_at: record.createdAt,
      p_updated_at: record.updatedAt,
      p_event_type: initialEvent.eventType,
      p_event_payload: initialEvent.payload,
      p_predecessor_session_id: record.predecessorSessionId,
    });

    if (error) {
      if (
        error.code === "23505" &&
        error.message.includes("sessions_room_code_active_unique")
      ) {
        throw new RoomCodeCollisionError();
      }

      if (
        error.code === "23505" &&
        error.message.includes("sessions_predecessor_session_id_unique")
      ) {
        throw new PredecessorAlreadyHasSuccessorError();
      }

      throw error;
    }
  }

  async joinParticipant(
    record: ParticipantRecord,
    joinedEvent: ParticipantJoinedEventRecord
  ): Promise<void> {
    const { error } = await this.client.rpc("join_participant_atomically", {
      p_participant_id: record.participantId,
      p_session_id: record.sessionId,
      p_display_name: record.displayName,
      p_normalized_display_name: record.normalizedDisplayName,
      p_participant_token: record.participantToken,
      p_joined_at: record.joinedAt,
      p_event_type: joinedEvent.eventType,
      p_event_payload: joinedEvent.payload,
      p_gaming_member_id: record.gamingMemberId,
    });

    if (error) {
      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("SESSION_NOT_FOUND")
      ) {
        throw new SessionNotFoundError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("SESSION_NOT_JOINABLE")
      ) {
        throw new LobbyNotOpenError(extractStateFromGuardMessage(error.message));
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("SESSION_CAPABILITIES_NOT_DECLARED")
      ) {
        throw new SessionCapabilitiesNotDeclaredError();
      }

      if (
        error.code === "23505" &&
        error.message.includes(
          "participants_session_display_name_unique"
        )
      ) {
        throw new DisplayNameTakenError();
      }

      if (
        error.code === "23505" &&
        error.message.includes("participants_session_gaming_member_unique")
      ) {
        throw new GamingMemberAlreadyInSessionError();
      }

      throw error;
    }
  }

  async getActiveSessionByRoomCode(
    roomCode: string
  ): Promise<SessionRecord | null> {
    const { data, error } = await this.client
      .from("sessions")
      .select("*")
      .eq("room_code", roomCode)
      .neq("state", "SESSION_COMPLETE")
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;

    return {
      sessionId: data.session_id,
      roomCode: data.room_code,
      hostToken: data.host_token,
      state: data.state,
      stateVersion: data.state_version,
      pauseReason: data.pause_reason,
      currentPromptId: data.current_prompt_id,
      predecessorSessionId: data.predecessor_session_id,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
      declaredCapabilities: data.declared_capabilities,
    };
  }

  async getSessionById(sessionId: string): Promise<SessionRecord | null> {
    const { data, error } = await this.client
      .from("sessions")
      .select("*")
      .eq("session_id", sessionId)
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;

    return {
      sessionId: data.session_id,
      roomCode: data.room_code,
      hostToken: data.host_token,
      state: data.state,
      stateVersion: data.state_version,
      pauseReason: data.pause_reason,
      currentPromptId: data.current_prompt_id,
      predecessorSessionId: data.predecessor_session_id,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
      declaredCapabilities: data.declared_capabilities,
    };
  }

  /**
   * Session Continuity slice. predecessor_session_id carries the
   * unique index (0028), so at most one row can ever match.
   */
  async getSuccessorSessionByPredecessorId(
    predecessorSessionId: string
  ): Promise<SessionRecord | null> {
    const { data, error } = await this.client
      .from("sessions")
      .select("*")
      .eq("predecessor_session_id", predecessorSessionId)
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;

    return {
      sessionId: data.session_id,
      roomCode: data.room_code,
      hostToken: data.host_token,
      state: data.state,
      stateVersion: data.state_version,
      pauseReason: data.pause_reason,
      currentPromptId: data.current_prompt_id,
      predecessorSessionId: data.predecessor_session_id,
      createdAt: data.created_at,
      updatedAt: data.updated_at,
      declaredCapabilities: data.declared_capabilities,
    };
  }

  async lockLobby(
    sessionId: string,
    hostToken: string,
    event: LobbyLockedEventRecord
  ): Promise<{ state: SessionState; stateVersion: number }> {
    const { data, error } = await this.client.rpc("lock_lobby_atomically", {
      p_session_id: sessionId,
      p_host_token: hostToken,
      p_event_type: event.eventType,
      p_event_payload: event.payload,
    });

    if (error) {
      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("SESSION_NOT_FOUND")
      ) {
        throw new SessionNotFoundError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("HOST_TOKEN_MISMATCH")
      ) {
        throw new HostTokenMismatchError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("LOBBY_NOT_OPEN")
      ) {
        throw new LobbyNotOpenError(extractStateFromGuardMessage(error.message));
      }

      throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;

    return {
      state: row.state as SessionState,
      stateVersion: row.state_version,
    };
  }

  async setSessionCapabilities(
    sessionId: string,
    hostToken: string,
    capabilities: string[]
  ): Promise<{ declaredCapabilities: string[]; locked: boolean }> {
    const { data, error } = await this.client.rpc(
      "set_session_capabilities_atomically",
      {
        p_session_id: sessionId,
        p_host_token: hostToken,
        p_capabilities: capabilities,
      }
    );

    if (error) {
      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("INVALID_CAPABILITY_KEY")
      ) {
        throw new InvalidCapabilityKeyError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("SESSION_NOT_FOUND")
      ) {
        throw new SessionNotFoundError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("HOST_TOKEN_MISMATCH")
      ) {
        throw new HostTokenMismatchError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("CAPABILITIES_LOCKED")
      ) {
        throw new CapabilitiesLockedError();
      }

      throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;

    return {
      declaredCapabilities: row.declared_capabilities,
      locked: row.locked,
    };
  }

  async getParticipantsForSession(
    sessionId: string
  ): Promise<ParticipantRecord[]> {
    // Secondary sort on participant_id: Postgres does not guarantee a
    // stable tie-break order on joined_at alone, and two joins can land
    // within the same millisecond (see JOIN_SESSION's concurrent-join
    // tests). Without an explicit tiebreaker, repeated calls against the
    // same data are not guaranteed to return the same order.
    const { data, error } = await this.client
      .from("participants")
      .select("*")
      .eq("session_id", sessionId)
      .order("joined_at", { ascending: true })
      .order("participant_id", { ascending: true });

    if (error) throw error;

    return (data ?? []).map((row) => ({
      participantId: row.participant_id,
      sessionId: row.session_id,
      displayName: row.display_name,
      normalizedDisplayName: row.normalized_display_name,
      participantToken: row.participant_token,
      joinedAt: row.joined_at,
      gamingMemberId: row.gaming_member_id,
    }));
  }

  async completeSession(
    sessionId: string,
    hostToken: string,
    event: SessionCompletedEventRecord
  ): Promise<{ state: SessionState; stateVersion: number }> {
    const { data, error } = await this.client.rpc(
      "complete_session_atomically",
      {
        p_session_id: sessionId,
        p_host_token: hostToken,
        p_event_type: event.eventType,
        p_event_payload: event.payload,
      }
    );

    if (error) {
      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("SESSION_NOT_FOUND")
      ) {
        throw new SessionNotFoundError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("HOST_TOKEN_MISMATCH")
      ) {
        throw new HostTokenMismatchError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("SESSION_ALREADY_COMPLETE")
      ) {
        throw new SessionAlreadyCompleteError();
      }

      throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;

    return {
      state: row.state as SessionState,
      stateVersion: row.state_version,
    };
  }

  async getPromptById(promptId: string): Promise<PromptRecord | null> {
    const { data, error } = await this.client
      .from("prompts")
      .select("*")
      .eq("prompt_id", promptId)
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;

    return {
      promptId: data.prompt_id,
      text: data.text,
    };
  }

  async getInteractionInstancesForSession(
    sessionId: string
  ): Promise<InteractionInstanceRecord[]> {
    const { data, error } = await this.client
      .from("interaction_instances")
      .select("*")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: true });

    if (error) throw error;

    return (data ?? []).map((row) => ({
      interactionInstanceId: row.interaction_instance_id,
      sessionId: row.session_id,
      segmentId: row.segment_id,
      promptId: row.prompt_id,
      state: row.state as InteractionState,
      engineType: row.engine_type as EngineType,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async getSegmentsForSession(sessionId: string): Promise<SegmentRecord[]> {
    const { data, error } = await this.client
      .from("segments")
      .select("*")
      .eq("session_id", sessionId)
      .order("segment_ordinal", { ascending: true });

    if (error) throw error;

    return (data ?? []).map((row) => ({
      segmentId: row.segment_id,
      sessionId: row.session_id,
      segmentOrdinal: row.segment_ordinal,
      createdAt: row.created_at,
    }));
  }

  /**
   * Slice 007 (Voting Engine) / Slice 009 (Engine Selection +
   * PARTICIPANTS Voting): `config` (StartTurnConfig) arrives here as
   * one structured, discriminated TypeScript union — this is the one
   * point where it is decomposed into the flat SQL parameters
   * start_session_atomically actually accepts. Postgres has no native
   * discriminated-union type, and this repository's existing
   * convention already favors flat, typed parameters (multiple_choice_details.options
   * is the one existing jsonb column, used because it's genuinely
   * array-shaped data, not for symmetry with a TypeScript type) — so
   * the decomposition happens in this adapter, not by forcing the
   * database to accept a JSON blob merely to mirror the domain shape.
   * "PARTICIPANTS" needs no extra parameter at all — the RPC already
   * has p_session_id, and that's the entire input PARTICIPANTS sourcing
   * requires.
   */
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
    const preparedQuestionId =
      config.engineType === "MULTIPLE_CHOICE" ? config.preparedQuestionId : null;
    const promptText =
      config.engineType === "OPEN_RESPONSE" || config.engineType === "VOTING"
        ? config.promptText
        : "";
    const candidateSource =
      config.engineType === "VOTING" ? config.candidateSource : null;

    const { data, error } = await this.client.rpc("start_session_atomically", {
      p_session_id: sessionId,
      p_host_token: hostToken,
      p_prompt_text: promptText,
      p_prepared_question_id: preparedQuestionId,
      p_voting_source_type: candidateSource?.type ?? null,
      p_voting_candidates:
        candidateSource?.type === "HOST_AUTHORED" ? candidateSource.candidates : null,
      p_voting_source_interaction_instance_id:
        candidateSource?.type === "SUBMISSION"
          ? candidateSource.sourceInteractionInstanceId
          : null,
      p_segment_target: segmentTarget,
    });

    if (error) {
      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("SESSION_NOT_FOUND")
      ) {
        throw new SessionNotFoundError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("HOST_TOKEN_MISMATCH")
      ) {
        throw new HostTokenMismatchError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("LOBBY_NOT_LOCKED")
      ) {
        throw new LobbyNotLockedError(extractStateFromGuardMessage(error.message));
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("ACTIVE_DUEL_EXISTS")
      ) {
        throw new ActiveDuelExistsError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("CAPABILITY_NOT_AUTHORIZED")
      ) {
        const match = error.message.match(/declared the (\w+) capability/);
        throw new CapabilityNotAuthorizedError(match ? match[1] : undefined);
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("PREVIOUS_INTERACTION_NOT_REVEALED")
      ) {
        throw new PreviousInteractionNotRevealedError(
          extractStateFromGuardMessage(error.message) as InteractionState | undefined
        );
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("NO_CURRENT_SEGMENT_TO_CONTINUE")
      ) {
        throw new NoCurrentSegmentToContinueError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("EMPTY_PROMPT_TEXT")
      ) {
        throw new EmptyPromptTextError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("PREPARED_QUESTION_NOT_FOUND")
      ) {
        throw new PreparedQuestionNotFoundError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("PREPARED_QUESTION_ALREADY_CONSUMED")
      ) {
        throw new PreparedQuestionAlreadyConsumedError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("AMBIGUOUS_START_TARGET")
      ) {
        throw new AmbiguousStartSessionTargetError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("INVALID_VOTING_CANDIDATES")
      ) {
        throw new InvalidVotingCandidatesError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("VOTING_SOURCE_INTERACTION_NOT_FOUND")
      ) {
        throw new VotingSourceInteractionNotFoundError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("VOTING_SOURCE_INTERACTION_NOT_ELIGIBLE")
      ) {
        throw new VotingSourceInteractionNotEligibleError();
      }

      throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;

    return {
      interactionInstanceId: row.interaction_instance_id,
      promptId: row.prompt_id,
      state: row.state as InteractionState,
      engineType: row.engine_type as EngineType,
      segmentNumber: row.segment_ordinal,
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
    const { data, error } = await this.client.rpc("submit_response_atomically", {
      p_session_id: sessionId,
      p_participant_id: participantId,
      p_participant_token: participantToken,
      p_text: text,
    });

    if (error) {
      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("SESSION_NOT_FOUND")
      ) {
        throw new SessionNotFoundError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("SESSION_ACCESS_DENIED")
      ) {
        throw new SessionAccessDeniedError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("PROMPT_NOT_ACTIVE")
      ) {
        throw new PromptNotActiveError(extractStateFromGuardMessage(error.message));
      }

      throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;

    return {
      submissionId: row.submission_id,
      interactionInstanceId: row.interaction_instance_id,
      promptId: row.prompt_id,
      updatedAt: row.updated_at,
    };
  }

  async getSubmissionsForInteractionInstance(
    interactionInstanceId: string
  ): Promise<SubmissionRecord[]> {
    const { data, error } = await this.client
      .from("submissions")
      .select("*")
      .eq("interaction_instance_id", interactionInstanceId);

    if (error) throw error;

    return (data ?? []).map((row) => ({
      submissionId: row.submission_id,
      sessionId: row.session_id,
      interactionInstanceId: row.interaction_instance_id,
      participantId: row.participant_id,
      promptId: row.prompt_id,
      text: row.text,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  async closeSubmissions(
    sessionId: string,
    hostToken: string,
    event: SubmissionsClosedEventRecord
  ): Promise<{ interactionInstanceId: string; state: InteractionState }> {
    const { data, error } = await this.client.rpc(
      "close_submissions_atomically",
      {
        p_session_id: sessionId,
        p_host_token: hostToken,
        p_event_type: event.eventType,
        p_event_payload: event.payload,
      }
    );

    if (error) {
      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("SESSION_NOT_FOUND")
      ) {
        throw new SessionNotFoundError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("HOST_TOKEN_MISMATCH")
      ) {
        throw new HostTokenMismatchError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("PROMPT_NOT_ACTIVE")
      ) {
        throw new PromptNotActiveError(extractStateFromGuardMessage(error.message));
      }

      throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;

    return {
      interactionInstanceId: row.interaction_instance_id,
      state: row.state as InteractionState,
    };
  }

  async revealResults(
    sessionId: string,
    hostToken: string,
    event: ResultsRevealedEventRecord
  ): Promise<{ interactionInstanceId: string; state: InteractionState }> {
    const { data, error } = await this.client.rpc(
      "reveal_results_atomically",
      {
        p_session_id: sessionId,
        p_host_token: hostToken,
        p_event_type: event.eventType,
        p_event_payload: event.payload,
      }
    );

    if (error) {
      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("SESSION_NOT_FOUND")
      ) {
        throw new SessionNotFoundError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("HOST_TOKEN_MISMATCH")
      ) {
        throw new HostTokenMismatchError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("SUBMISSIONS_NOT_CLOSED")
      ) {
        throw new SubmissionsNotClosedError(extractStateFromGuardMessage(error.message));
      }

      throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;

    return {
      interactionInstanceId: row.interaction_instance_id,
      state: row.state as InteractionState,
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
    const { data, error } = await this.client.rpc("award_points_atomically", {
      p_session_id: sessionId,
      p_host_token: hostToken,
      p_interaction_instance_id: interactionInstanceId,
      p_participant_id: participantId,
      p_points: points,
      p_idempotency_key: idempotencyKey,
    });

    if (error) {
      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("SESSION_NOT_FOUND")
      ) {
        throw new SessionNotFoundError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("HOST_TOKEN_MISMATCH")
      ) {
        throw new HostTokenMismatchError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("LOBBY_NOT_LOCKED")
      ) {
        throw new LobbyNotLockedError(extractStateFromGuardMessage(error.message));
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("INTERACTION_NOT_ELIGIBLE")
      ) {
        throw new InteractionInstanceNotEligibleError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("PARTICIPANT_NOT_IN_SESSION")
      ) {
        throw new ParticipantNotInSessionError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("INVALID_POINTS")
      ) {
        throw new InvalidPointsError();
      }

      throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;

    return {
      pointAwardId: row.point_award_id,
      sessionId,
      interactionInstanceId: row.interaction_instance_id,
      participantId: row.participant_id,
      points: row.points,
      createdAt: row.created_at,
    };
  }

  async getPointAwardsForSession(sessionId: string): Promise<PointAwardRecord[]> {
    const { data, error } = await this.client
      .from("point_awards")
      .select("*")
      .eq("session_id", sessionId);

    if (error) throw error;

    return (data ?? []).map((row) => ({
      pointAwardId: row.point_award_id,
      sessionId: row.session_id,
      interactionInstanceId: row.interaction_instance_id,
      participantId: row.participant_id,
      points: row.points,
      createdAt: row.created_at,
    }));
  }

  /**
   * Slice 003. No stored procedure — authoring a prepared question has
   * no concurrent invariant to protect (see the interface doc comment).
   * The next ordinal is computed from the current maximum for this
   * session, then assigned sequentially across the batch being
   * inserted in one call.
   */
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
    // either alone. No new atomic function is introduced here — this
    // method already accepts the same small, documented non-atomic
    // window every other check in this method tolerates (ordinal
    // assignment); a plain read-then-insert is consistent with that
    // existing, accepted design.
    const session = await this.getSessionById(sessionId);
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

    const { data: existing, error: existingError } = await this.client
      .from("prepared_questions")
      .select("ordinal")
      .eq("session_id", sessionId)
      .order("ordinal", { ascending: false })
      .limit(1);

    if (existingError) throw existingError;

    let nextOrdinal =
      existing && existing.length > 0 ? existing[0].ordinal + 1 : 1;

    const rows = questions.map((question) => ({
      session_id: sessionId,
      ordinal: nextOrdinal++,
      prompt_text: question.promptText,
      options: question.options,
      correct_option_index: question.correctOptionIndex,
      points_for_correct: question.pointsForCorrect,
    }));

    const { data, error } = await this.client
      .from("prepared_questions")
      .insert(rows)
      .select("*");

    if (error) throw error;

    return (data ?? []).map((row) => ({
      preparedQuestionId: row.prepared_question_id,
      sessionId: row.session_id,
      ordinal: row.ordinal,
      promptText: row.prompt_text,
      options: row.options,
      correctOptionIndex: row.correct_option_index,
      pointsForCorrect: row.points_for_correct,
      consumedAt: row.consumed_at,
      createdAt: row.created_at,
    }));
  }

  async getPreparedQuestionsForSession(
    sessionId: string
  ): Promise<PreparedQuestionRecord[]> {
    const { data, error } = await this.client
      .from("prepared_questions")
      .select("*")
      .eq("session_id", sessionId)
      .order("ordinal", { ascending: true });

    if (error) throw error;

    return (data ?? []).map((row) => ({
      preparedQuestionId: row.prepared_question_id,
      sessionId: row.session_id,
      ordinal: row.ordinal,
      promptText: row.prompt_text,
      options: row.options,
      correctOptionIndex: row.correct_option_index,
      pointsForCorrect: row.points_for_correct,
      consumedAt: row.consumed_at,
      createdAt: row.created_at,
    }));
  }

  async getMultipleChoiceDetailsForInteraction(
    interactionInstanceId: string
  ): Promise<MultipleChoiceDetailsRecord | null> {
    const { data, error } = await this.client
      .from("multiple_choice_details")
      .select("*")
      .eq("interaction_instance_id", interactionInstanceId)
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;

    return {
      interactionInstanceId: data.interaction_instance_id,
      options: data.options,
      correctOptionIndex: data.correct_option_index,
      pointsForCorrect: data.points_for_correct,
    };
  }

  async getVotingCandidatesForInteraction(
    interactionInstanceId: string
  ): Promise<VotingCandidateRecord[]> {
    const { data, error } = await this.client
      .from("voting_candidates")
      .select("*")
      .eq("interaction_instance_id", interactionInstanceId)
      .order("ordinal", { ascending: true });

    if (error) throw error;

    return (data ?? []).map((row) => ({
      candidateId: row.candidate_id,
      interactionInstanceId: row.interaction_instance_id,
      ordinal: row.ordinal,
      label: row.label,
      participantId: row.participant_id,
      createdAt: row.created_at,
    }));
  }

  async getVotesForInteractionInstance(
    interactionInstanceId: string
  ): Promise<VoteRecord[]> {
    const { data, error } = await this.client
      .from("votes")
      .select("*")
      .eq("interaction_instance_id", interactionInstanceId);

    if (error) throw error;

    return (data ?? []).map((row) => ({
      voteId: row.vote_id,
      interactionInstanceId: row.interaction_instance_id,
      participantId: row.participant_id,
      candidateId: row.candidate_id,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));
  }

  /**
   * Slice 007. Deliberately two plain selects plus the shared
   * computeVotingResults helper, not a bespoke SQL aggregate function —
   * this mirrors how `standings` is already derived in TypeScript from
   * plain point_awards rows (getSession.ts) rather than via a database
   * aggregate, and guarantees this implementation's ranking semantics
   * can never drift from InMemorySessionRepository's, since both call
   * the exact same function.
   */
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
    const { data, error } = await this.client.rpc("cast_vote_atomically", {
      p_session_id: sessionId,
      p_participant_id: participantId,
      p_participant_token: participantToken,
      p_candidate_id: candidateId,
    });

    if (error) {
      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("SESSION_NOT_FOUND")
      ) {
        throw new SessionNotFoundError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("SESSION_ACCESS_DENIED")
      ) {
        throw new SessionAccessDeniedError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("PROMPT_NOT_ACTIVE")
      ) {
        throw new PromptNotActiveError(extractStateFromGuardMessage(error.message));
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("INVALID_CANDIDATE_SELECTION")
      ) {
        throw new InvalidCandidateSelectionError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("SELF_VOTE_NOT_ALLOWED")
      ) {
        throw new SelfVoteNotAllowedError();
      }

      throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;

    return {
      voteId: row.vote_id,
      interactionInstanceId: row.interaction_instance_id,
      candidateId: row.candidate_id,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Quiz Experience. Dedicated, not a generalization of startSession —
   * see this platform's implementation-readiness design. The SQL
   * function returns one row per created question; segment_id /
   * segment_ordinal / closes_at are identical across every row, so
   * only the first row's copy is used for those, while
   * interaction_instance_id is collected from every row.
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
    const { data, error } = await this.client.rpc("start_quiz_atomically", {
      p_session_id: sessionId,
      p_host_token: hostToken,
      p_duration_seconds: durationSeconds,
    });

    if (error) {
      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("INVALID_QUIZ_DURATION")
      ) {
        throw new InvalidQuizDurationError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("SESSION_NOT_FOUND")
      ) {
        throw new SessionNotFoundError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("HOST_TOKEN_MISMATCH")
      ) {
        throw new HostTokenMismatchError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("LOBBY_NOT_LOCKED")
      ) {
        throw new LobbyNotLockedError(extractStateFromGuardMessage(error.message));
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("ACTIVE_DUEL_EXISTS")
      ) {
        throw new ActiveDuelExistsError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("CAPABILITY_NOT_AUTHORIZED")
      ) {
        throw new CapabilityNotAuthorizedError("QUIZ");
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("PREVIOUS_INTERACTION_NOT_REVEALED")
      ) {
        throw new PreviousInteractionNotRevealedError(
          extractStateFromGuardMessage(error.message) as InteractionState | undefined
        );
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("EMPTY_QUIZ_QUESTION_SET")
      ) {
        throw new EmptyQuizQuestionSetError();
      }

      throw error;
    }

    const rows = Array.isArray(data) ? data : [data];
    const first = rows[0];

    return {
      segmentId: first.segment_id,
      segmentOrdinal: first.segment_ordinal,
      closesAt: first.closes_at,
      interactionInstanceIds: rows.map((row) => row.interaction_instance_id),
    };
  }

  /**
   * Quiz Experience. Dedicated, not a generalization of submitResponse
   * — see startQuiz's own comment.
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
    const { data, error } = await this.client.rpc(
      "submit_quiz_response_atomically",
      {
        p_session_id: sessionId,
        p_participant_id: participantId,
        p_participant_token: participantToken,
        p_interaction_instance_id: interactionInstanceId,
        p_selected_option_index: selectedOptionIndex,
      }
    );

    if (error) {
      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("SESSION_NOT_FOUND")
      ) {
        throw new SessionNotFoundError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("SESSION_ACCESS_DENIED")
      ) {
        throw new SessionAccessDeniedError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("QUIZ_INSTANCE_NOT_FOUND")
      ) {
        throw new QuizInstanceNotFoundError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("QUIZ_CLOSED")
      ) {
        throw new QuizClosedError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("INVALID_OPTION_SELECTION")
      ) {
        throw new InvalidOptionSelectionError();
      }

      throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;

    return {
      submissionId: row.submission_id,
      interactionInstanceId: row.interaction_instance_id,
      updatedAt: row.updated_at,
    };
  }

  /**
   * Quiz Experience. Dedicated, not a generalization of revealResults
   * — see startQuiz's own comment.
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
    const { data, error } = await this.client.rpc("close_quiz_atomically", {
      p_session_id: sessionId,
      p_segment_id: segmentId,
      p_caller_token: callerToken,
    });

    if (error) {
      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("SESSION_NOT_FOUND")
      ) {
        throw new SessionNotFoundError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("QUIZ_NOT_FOUND")
      ) {
        throw new QuizNotFoundError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("QUIZ_ACCESS_DENIED")
      ) {
        throw new QuizAccessDeniedError();
      }

      if (
        error.code === "P0001" &&
        typeof error.message === "string" &&
        error.message.includes("QUIZ_EXPIRY_NOT_REACHED")
      ) {
        throw new QuizExpiryNotReachedError();
      }

      throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;

    return {
      segmentId: row.segment_id,
      closedAt: row.closed_at,
      alreadyClosed: row.already_closed,
    };
  }

  async getQuizWindowForSegment(segmentId: string): Promise<QuizWindowRecord | null> {
    const { data, error } = await this.client
      .from("quiz_windows")
      .select("segment_id, closes_at, closed_at")
      .eq("segment_id", segmentId)
      .maybeSingle();

    if (error) {
      throw error;
    }

    if (!data) {
      return null;
    }

    return {
      segmentId: data.segment_id,
      closesAt: data.closes_at,
      closedAt: data.closed_at,
    };
  }

  private toDuelRecord(row: Record<string, unknown>): DuelRecord {
    return {
      duelId: row.duel_id as string,
      sessionId: row.session_id as string,
      // mechanic_key is NOT NULL + CHECK-constrained to the same
      // vocabulary DuelMechanicKey declares (0136's own migration
      // comment) — trusted the same way lifecycle_state/terminal_
      // resolution already are below, not re-validated here.
      mechanicKey: row.mechanic_key as DuelMechanicKey,
      competitorAParticipantId: row.competitor_a_participant_id as string,
      competitorBParticipantId: row.competitor_b_participant_id as string,
      lifecycleState: row.lifecycle_state as DuelLifecycleState,
      terminalResolution: (row.terminal_resolution ?? null) as DuelTerminalResolution | null,
      winnerParticipantId: (row.winner_participant_id ?? null) as string | null,
      reason: (row.reason ?? null) as string | null,
      createdAt: row.created_at as string,
      startedAt: (row.started_at ?? null) as string | null,
      endedAt: (row.ended_at ?? null) as string | null,
      // Math Duel Slice 001: prompt_text/options are nullable as of
      // 0137 — a Math Duel row leaves them null, and multipleChoice is
      // correspondingly omitted rather than built from null values.
      // Math Duel's own content is fetched separately
      // (getMathDuelChallenges/getMathDuelResponses), never nested
      // here — see DuelRecord's own doc comment.
      ...(row.prompt_text !== null
        ? {
            multipleChoice: {
              promptText: row.prompt_text as string,
              options: row.options as string[],
            },
          }
        : {}),
    };
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
    const { data, error } = await this.client.rpc("start_duel_atomically", {
      p_session_id: sessionId,
      p_host_token: hostToken,
      p_competitor_a_participant_id: competitorAParticipantId,
      p_competitor_b_participant_id: competitorBParticipantId,
      p_prompt_text: promptText,
      p_options: options,
      p_correct_option_index: correctOptionIndex,
    });

    if (error) {
      const msg = typeof error.message === "string" ? error.message : "";
      if (error.code === "P0001" && msg.includes("DUPLICATE_DUEL_COMPETITOR")) {
        throw new DuplicateDuelCompetitorError();
      }
      if (error.code === "P0001" && msg.includes("INVALID_DUEL_OPTIONS")) {
        throw new InvalidDuelOptionsError();
      }
      if (error.code === "P0001" && msg.includes("SESSION_NOT_FOUND")) {
        throw new SessionNotFoundError();
      }
      if (error.code === "P0001" && msg.includes("HOST_TOKEN_MISMATCH")) {
        throw new HostTokenMismatchError();
      }
      if (error.code === "P0001" && msg.includes("LOBBY_NOT_LOCKED")) {
        throw new LobbyNotLockedError(extractStateFromGuardMessage(msg));
      }
      if (error.code === "P0001" && msg.includes("CAPABILITY_NOT_AUTHORIZED")) {
        throw new CapabilityNotAuthorizedError("DUEL");
      }
      if (error.code === "P0001" && msg.includes("DUEL_COMPETITOR_NOT_IN_SESSION")) {
        throw new DuelCompetitorNotInSessionError();
      }
      if (error.code === "P0001" && msg.includes("INTERACTION_ACTIVE")) {
        throw new InteractionActiveError(extractStateFromGuardMessage(msg));
      }
      if (error.code === "P0001" && msg.includes("ACTIVE_DUEL_EXISTS")) {
        throw new ActiveDuelExistsError();
      }
      throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;

    return {
      duelId: row.duel_id,
      // start_duel_atomically's own INSERT never lists mechanic_key,
      // so every row it creates gets the column default (0136) —
      // hardcoded here rather than added to the RPC's own returns
      // table, since there is only one mechanic to return.
      mechanicKey: "MULTIPLE_CHOICE",
      lifecycleState: row.lifecycle_state as DuelLifecycleState,
      promptText: row.prompt_text,
      options: row.options as string[],
      startedAt: row.started_at,
    };
  }

  async submitDuelResponse(
    duelId: string,
    participantToken: string,
    selectedOptionIndex: number
  ): Promise<{ participantId: string; answeredAt: string }> {
    const { data, error } = await this.client.rpc("submit_duel_response_atomically", {
      p_duel_id: duelId,
      p_participant_token: participantToken,
      p_selected_option_index: selectedOptionIndex,
    });

    if (error) {
      const msg = typeof error.message === "string" ? error.message : "";
      if (error.code === "P0001" && msg.includes("DUEL_NOT_FOUND")) {
        throw new DuelNotFoundError();
      }
      if (error.code === "P0001" && msg.includes("DUEL_NOT_ACTIVE")) {
        throw new DuelNotActiveError(extractStateFromGuardMessage(msg));
      }
      if (error.code === "P0001" && msg.includes("DUEL_ACCESS_DENIED")) {
        throw new DuelAccessDeniedError();
      }
      if (error.code === "P0001" && msg.includes("INVALID_DUEL_OPTION_SELECTION")) {
        throw new InvalidDuelOptionSelectionError();
      }
      throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;

    return { participantId: row.participant_id, answeredAt: row.answered_at };
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
    const { data, error } = await this.client.rpc("resolve_duel_atomically", {
      p_duel_id: duelId,
      p_host_token: hostToken,
    });

    if (error) {
      const msg = typeof error.message === "string" ? error.message : "";
      if (error.code === "P0001" && msg.includes("DUEL_NOT_FOUND")) {
        throw new DuelNotFoundError();
      }
      if (error.code === "P0001" && msg.includes("HOST_TOKEN_MISMATCH")) {
        throw new HostTokenMismatchError();
      }
      if (error.code === "P0001" && msg.includes("DUEL_ALREADY_RESOLVED")) {
        throw new DuelAlreadyResolvedError();
      }
      throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;

    return {
      duelId: row.duel_id,
      lifecycleState: row.lifecycle_state as DuelLifecycleState,
      terminalResolution: row.terminal_resolution as DuelTerminalResolution,
      winnerParticipantId: row.winner_participant_id ?? null,
    };
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
    const { data, error } = await this.client.rpc("resolve_duel_exceptionally_atomically", {
      p_duel_id: duelId,
      p_host_token: hostToken,
      p_resolution: resolution,
      p_reason: reason,
    });

    if (error) {
      const msg = typeof error.message === "string" ? error.message : "";
      if (error.code === "P0001" && msg.includes("INVALID_DUEL_RESOLUTION")) {
        throw new InvalidDuelResolutionError();
      }
      if (error.code === "P0001" && msg.includes("REASON_REQUIRED")) {
        throw new DuelReasonRequiredError();
      }
      if (error.code === "P0001" && msg.includes("DUEL_NOT_FOUND")) {
        throw new DuelNotFoundError();
      }
      if (error.code === "P0001" && msg.includes("HOST_TOKEN_MISMATCH")) {
        throw new HostTokenMismatchError();
      }
      if (error.code === "P0001" && msg.includes("DUEL_ALREADY_RESOLVED")) {
        throw new DuelAlreadyResolvedError();
      }
      throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;

    return {
      duelId: row.duel_id,
      lifecycleState: row.lifecycle_state as DuelLifecycleState,
      terminalResolution: row.terminal_resolution as DuelTerminalResolution,
      winnerParticipantId: row.winner_participant_id ?? null,
    };
  }

  async getDuelById(duelId: string): Promise<DuelRecord | null> {
    const { data, error } = await this.client
      .from("duels")
      .select("*")
      .eq("duel_id", duelId)
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;

    return this.toDuelRecord(data);
  }

  async getActiveDuelForSession(sessionId: string): Promise<DuelRecord | null> {
    const { data, error } = await this.client
      .from("duels")
      .select("*")
      .eq("session_id", sessionId)
      .eq("lifecycle_state", "ACTIVE")
      .maybeSingle();

    if (error) throw error;
    if (!data) return null;

    return this.toDuelRecord(data);
  }

  async getDuelsForSession(sessionId: string): Promise<DuelRecord[]> {
    const { data, error } = await this.client
      .from("duels")
      .select("*")
      .eq("session_id", sessionId)
      .order("created_at", { ascending: false });

    if (error) throw error;

    return (data ?? []).map((row) => this.toDuelRecord(row));
  }

  async getDuelResponses(
    duelId: string
  ): Promise<Array<{ participantId: string; selectedOptionIndex: number; answeredAt: string }>> {
    const { data, error } = await this.client
      .from("duel_responses")
      .select("*")
      .eq("duel_id", duelId);

    if (error) throw error;

    return (data ?? []).map((row) => ({
      participantId: row.participant_id,
      selectedOptionIndex: row.selected_option_index,
      answeredAt: row.answered_at,
    }));
  }

  // ===================== Math Duel Slice 001 =====================

  async startMathDuel(
    sessionId: string,
    hostToken: string,
    competitorAParticipantId: string,
    competitorBParticipantId: string,
    challenges: MathDuelFixtureChallenge[]
  ): Promise<{
    duelId: string;
    mechanicKey: DuelMechanicKey;
    lifecycleState: DuelLifecycleState;
    startedAt: string;
  }> {
    const { data, error } = await this.client.rpc("start_math_duel_atomically", {
      p_session_id: sessionId,
      p_host_token: hostToken,
      p_competitor_a_participant_id: competitorAParticipantId,
      p_competitor_b_participant_id: competitorBParticipantId,
      p_challenges: challenges,
    });

    if (error) {
      const msg = typeof error.message === "string" ? error.message : "";
      if (error.code === "P0001" && msg.includes("DUPLICATE_DUEL_COMPETITOR")) {
        throw new DuplicateDuelCompetitorError();
      }
      if (error.code === "P0001" && msg.includes("INVALID_MATH_DUEL_CHALLENGES")) {
        throw new InvalidMathDuelChallengesError();
      }
      if (error.code === "P0001" && msg.includes("SESSION_NOT_FOUND")) {
        throw new SessionNotFoundError();
      }
      if (error.code === "P0001" && msg.includes("HOST_TOKEN_MISMATCH")) {
        throw new HostTokenMismatchError();
      }
      if (error.code === "P0001" && msg.includes("LOBBY_NOT_LOCKED")) {
        throw new LobbyNotLockedError(extractStateFromGuardMessage(msg));
      }
      if (error.code === "P0001" && msg.includes("CAPABILITY_NOT_AUTHORIZED")) {
        throw new CapabilityNotAuthorizedError("DUEL");
      }
      if (error.code === "P0001" && msg.includes("DUEL_COMPETITOR_NOT_IN_SESSION")) {
        throw new DuelCompetitorNotInSessionError();
      }
      if (error.code === "P0001" && msg.includes("INTERACTION_ACTIVE")) {
        throw new InteractionActiveError(extractStateFromGuardMessage(msg));
      }
      if (error.code === "P0001" && msg.includes("ACTIVE_DUEL_EXISTS")) {
        throw new ActiveDuelExistsError();
      }
      throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;

    return {
      duelId: row.duel_id,
      mechanicKey: "MATH_DUEL",
      lifecycleState: row.lifecycle_state as DuelLifecycleState,
      startedAt: row.started_at,
    };
  }

  async submitMathDuelAnswer(
    duelId: string,
    participantToken: string,
    challengeOrdinal: number,
    submittedAnswer: number,
    nextChallengeCandidate: MathDuelFixtureChallenge
  ): Promise<{ participantId: string; challengeOrdinal: number; answeredAt: string }> {
    const { data, error } = await this.client.rpc("submit_math_duel_answer_atomically", {
      p_duel_id: duelId,
      p_participant_token: participantToken,
      p_challenge_ordinal: challengeOrdinal,
      p_submitted_answer: submittedAnswer,
      p_next_challenge: nextChallengeCandidate,
    });

    if (error) {
      const msg = typeof error.message === "string" ? error.message : "";
      if (error.code === "P0001" && msg.includes("DUEL_NOT_FOUND")) {
        throw new DuelNotFoundError();
      }
      if (error.code === "P0001" && msg.includes("DUEL_NOT_ACTIVE")) {
        throw new DuelNotActiveError(extractStateFromGuardMessage(msg));
      }
      if (error.code === "P0001" && msg.includes("DUEL_ACCESS_DENIED")) {
        throw new DuelAccessDeniedError();
      }
      if (error.code === "P0001" && msg.includes("MATH_DUEL_CHALLENGES_EXHAUSTED")) {
        throw new MathDuelChallengesExhaustedError();
      }
      if (error.code === "P0001" && msg.includes("INVALID_MATH_DUEL_ORDINAL")) {
        const match = msg.match(/next challenge is (\d+)/);
        throw new InvalidMathDuelOrdinalError(match ? Number(match[1]) : undefined);
      }
      if (error.code === "P0001" && msg.includes("INVALID_MATH_DUEL_ANSWER")) {
        throw new InvalidMathDuelAnswerError();
      }
      if (error.code === "P0001" && msg.includes("INVALID_MATH_DUEL_CHALLENGES")) {
        throw new InvalidMathDuelChallengesError();
      }
      throw error;
    }

    const row = Array.isArray(data) ? data[0] : data;

    return {
      participantId: row.participant_id,
      challengeOrdinal: row.challenge_ordinal,
      answeredAt: row.answered_at,
    };
  }

  async getMathDuelChallenges(duelId: string): Promise<MathDuelChallengeRecord[]> {
    const { data, error } = await this.client
      .from("duel_math_challenges")
      .select("*")
      .eq("duel_id", duelId)
      .order("challenge_ordinal", { ascending: true });

    if (error) throw error;

    // question_text/correct_answer both exist on every row; only
    // correct_answer is deliberately omitted from the returned shape —
    // MathDuelChallengeRecord never carries it, the same read-model
    // privacy boundary correctOptionIndex already established for
    // Multiple Choice.
    return (data ?? []).map((row) => ({
      duelId: row.duel_id,
      challengeOrdinal: row.challenge_ordinal,
      phase: row.phase as "STANDARD" | "SUDDEN_DEATH",
      questionText: row.question_text,
      createdAt: row.created_at,
      activatedAt: row.activated_at,
    }));
  }

  async getMathDuelResponses(duelId: string): Promise<MathDuelResponseRecord[]> {
    const { data, error } = await this.client
      .from("duel_math_responses")
      .select("*")
      .eq("duel_id", duelId);

    if (error) throw error;

    return (data ?? []).map((row) => ({
      duelId: row.duel_id,
      challengeOrdinal: row.challenge_ordinal,
      participantId: row.participant_id,
      submittedAnswer: row.submitted_answer,
      isCorrect: row.is_correct,
      answeredAt: row.answered_at,
    }));
  }
}
