/**
 * Types matching the finalized Session Data Model.
 * Fields beyond what CREATE_SESSION needs (e.g. participants) are
 * intentionally not modeled here — out of scope for this vertical slice.
 */

export type SessionState =
  | "LOBBY_OPEN"
  | "LOBBY_LOCKED"
  | "SESSION_INTRO"
  | "PROMPT_ACTIVE"
  | "SUBMISSIONS_CLOSED"
  | "RESULT_REVEAL"
  | "SOCIAL_PAUSE"
  | "SESSION_COMPLETE"
  | "SESSION_PAUSED";

export type PauseReason = "MANUAL" | "HOST_DISCONNECTED" | null;

/**
 * Slice 003 (Second Interaction Engine). Which Interaction Engine
 * produced a given Interaction Instance. Every interaction before this
 * slice was implicitly OPEN_RESPONSE — this type makes that explicit
 * rather than leaving it inferable only from which engine-specific
 * extension table has a matching row.
 *
 * Slice 007 (Voting Engine): adds "VOTING". Committed Product
 * architecture (Gameplay_Outcome_Taxonomy.md, Interaction_Engine_Taxonomy.md,
 * 433b61e) — casting a vote is engine-owned interaction data, not a
 * `submission` Outcome; `placement` is the real Outcome, and it is
 * derived at read time rather than persisted (see
 * computeVotingResults in db/sessionRepository.ts), mirroring how
 * Multiple Choice's own `correctness` is never stored either.
 */
export type EngineType = "OPEN_RESPONSE" | "MULTIPLE_CHOICE" | "VOTING";

/**
 * Slice 007 (Voting Engine). The Candidate Resolution sources
 * START_SESSION accepts for a Voting interaction, kept as one
 * structured, mutually-exclusive-by-construction input rather than flat
 * optional parameters — this is the "structured domain input"
 * referenced throughout this slice's design; SupabaseSessionRepository
 * decomposes it into flat RPC parameters at the boundary to
 * start_session_atomically (see that method's comment for why the
 * decomposition happens there and not here).
 *
 * Slice 009 (Engine Selection + PARTICIPANTS Voting): adds
 * "PARTICIPANTS" — snapshots the session's current participant roster
 * into immutable Candidates, one per participant, at Voting start.
 * Needs no extra input beyond the type discriminator itself; the
 * session's own membership (already known from sessionId) is the
 * entire source. This is deliberately independent of `SegmentTarget`
 * (see StartTurnConfig) — "where candidates come from" and "does this
 * Interaction continue the current Turn" are orthogonal questions, and
 * a caller may combine any candidate source with either Segment target.
 */
export type VotingCandidateSource =
  | { type: "HOST_AUTHORED"; candidates: string[] }
  | { type: "SUBMISSION"; sourceInteractionInstanceId: string }
  | { type: "PARTICIPANTS" };

/**
 * Slice 009 (Engine Selection + PARTICIPANTS Voting). The discriminated
 * start configuration START_SESSION accepts, replacing the previous
 * shape of independent optional fields (promptText / preparedQuestionId /
 * votingCandidateSource) — two of which were mutually exclusive with
 * each other, and the third was an implicit fallback rather than an
 * explicit choice. One required, self-describing, mutually-exclusive-
 * by-construction value replaces that: AmbiguousStartSessionTargetError
 * becomes structurally impossible rather than runtime-checked, since
 * TypeScript itself rejects supplying both a preparedQuestionId and a
 * candidateSource.
 *
 * `segmentTarget` (see SegmentTarget) remains a separate, orthogonal
 * parameter on startSession itself, not part of this type — "what
 * engine, with what configuration" and "does this begin a new Turn or
 * continue the current one" are independent questions.
 */
export type StartTurnConfig =
  | { engineType: "OPEN_RESPONSE"; promptText: string }
  | { engineType: "MULTIPLE_CHOICE"; preparedQuestionId: string }
  | {
      engineType: "VOTING";
      promptText: string;
      candidateSource: VotingCandidateSource;
    };

/**
 * Slice 008 (Segment / Turn grouping). Which Segment a new Interaction
 * Instance joins. "NEW_SEGMENT" allocates a new Segment (a new
 * member-facing Turn) and is the default, preserving every pre-Slice-008
 * call site's exact behavior unchanged. "CURRENT_SEGMENT" attaches the
 * new Interaction Instance to the session's existing current Segment
 * instead — the mechanism the Best Joke proving case uses to add Voting
 * to the same Turn an Open Response phase already ran in. Requires a
 * current Interaction Instance to exist and be RESULT_REVEAL, exactly
 * mirroring the existing PreviousInteractionNotRevealedError precondition
 * (see NoCurrentSegmentToContinueError for the one additional case this
 * adds: no Segment exists yet at all).
 */
export type SegmentTarget = "NEW_SEGMENT" | "CURRENT_SEGMENT";

/**
 * Slice 007. A Voting Candidate as exposed by GET_SESSION — a stable
 * id plus a presentation reference. `label` is this slice's text-only
 * presentation field, not a claim about the final non-text Candidate
 * architecture (see Interaction_Engine_Taxonomy.md's Voting Engine
 * section) — a future non-text Candidate is a real design decision to
 * be made against real evidence, not inferred from the fact that this
 * field could technically hold a URL today.
 */
export interface VotingCandidateSummary {
  candidateId: string;
  ordinal: number;
  label: string;
}

/**
 * Slice 007. One Candidate's derived result, exposed by GET_SESSION
 * only once the interaction reaches RESULT_REVEAL. Computed live from
 * immutable vote data — never persisted — mirroring how Multiple
 * Choice's own `isCorrect` is derived, not stored. `rank` uses standard
 * competition ranking: tied candidates share a rank, and the next
 * distinct count skips ranks by the number tied.
 */
export interface VotingResultSummary {
  candidateId: string;
  label: string;
  voteCount: number;
  rank: number;
}

/** Result of a successful CAST_VOTE. */
export interface CastVoteResult {
  voteId: string;
  sessionId: string;
  interactionInstanceId: string;
  participantId: string;
  candidateId: string;
  updatedAt: string;
}

/**
 * Slice 001 (Session / Interaction separation): the lifecycle of one
 * Interaction Instance, independent of the session's own (now
 * narrower) lifecycle. These three values are already members of
 * SessionState above — kept as literal members there rather than
 * removed, since the sessions.state check constraint still permits
 * them and no existing historical row needs to change shape. Going
 * forward, the application only ever writes them to
 * interaction_instances.state, never to sessions.state.
 */
export type InteractionState =
  | "PROMPT_ACTIVE"
  | "SUBMISSIONS_CLOSED"
  | "RESULT_REVEAL";

export interface SessionRecord {
  sessionId: string;
  roomCode: string;
  hostToken: string;
  state: SessionState;
  stateVersion: number;
  pauseReason: PauseReason;
  /**
   * Explicit MVP optimization, not a commitment to the long-term
   * gameplay model — a future "rounds" concept may eventually own
   * prompt selection instead of the session row directly.
   */
  currentPromptId: string | null;
  /**
   * Session Continuity slice. Null for every session except one
   * created via CREATE_SUCCESSOR_SESSION, in which case this is the
   * (already SESSION_COMPLETE) session it continues from. Set once, at
   * creation, and never revised afterward — this session's own row is
   * the one that changes over its lifetime, never the predecessor's.
   * See 0028's migration comment for why this describes a session's
   * own origin rather than a forward pointer on the earlier session.
   */
  predecessorSessionId: string | null;
  createdAt: string;
  updatedAt: string;
  /**
   * Session Capability Architecture v1 (Product/Session_Capability_Architecture.md,
   * ADR-036). null = LEGACY_UNDECLARED (a session created before this
   * column existed — its historical Interaction Instance evidence
   * remains fully authoritative; this field concerns future
   * authorization only). A non-null array — possibly empty — is the
   * declared capability snapshot for every session created after this
   * feature: freely settable via SET_SESSION_CAPABILITIES while no
   * real participant has ever joined, immutable the instant one does.
   * Order carries no meaning; the sole write path always stores it
   * deduplicated and canonically sorted.
   */
  declaredCapabilities: string[] | null;
}

export interface CreateSessionResult {
  sessionId: string;
  roomCode: string;
  hostToken: string;
  state: SessionState;
  stateVersion: number;
}

/**
 * Session Capability Architecture v1. The Product-approved, ad-hoc-
 * composable capability catalog for this slice — see
 * Product/Session_Capability_Architecture.md. MULTIPLE_CHOICE is
 * deliberately absent: it is an internal Interaction Engine primitive,
 * never a Product capability. TRIVIA and QUIZ both compose it
 * internally but are authorized independently of one another.
 *
 * Duel / SESSION_SUBGAME v1 (Product/Duel_Architecture.md): adds
 * "DUEL" — unlike the other four (COMPOSABLE_INTERACTION, using the
 * full Session roster), DUEL is a SESSION_SUBGAME, activated against
 * exactly two Host-selected competitors via START_DUEL, never through
 * START_SESSION/START_QUIZ. Ad-hoc composable for manual Host
 * selection specifically — rule-driven or sequenced selection remains
 * outside this Slice's scope, per Session_Capability_Architecture.md's
 * own refined ad-hoc/orchestrated boundary.
 */
export type SessionCapabilityKey = "OPEN_RESPONSE" | "VOTING" | "TRIVIA" | "QUIZ" | "DUEL";

/**
 * Result of a successful SET_SESSION_CAPABILITIES.
 */
export interface SetSessionCapabilitiesResult {
  sessionId: string;
  declaredCapabilities: string[];
  locked: boolean;
}

/**
 * Result of a successful LOCK_LOBBY.
 */
export interface LockLobbyResult {
  sessionId: string;
  state: SessionState;
  stateVersion: number;
}

/**
 * Result of a successful COMPLETE_SESSION.
 */
export interface CompleteSessionResult {
  sessionId: string;
  state: SessionState;
  stateVersion: number;
}

/**
 * Result of a successful START_SESSION. Slice 001: this command is now
 * re-invocable — once per interaction, not once per session — and
 * always creates a fresh interaction instance from host-supplied
 * prompt text. The session's own state/stateVersion never change as a
 * result of this call (the session was already LOBBY_LOCKED and stays
 * that way for every interaction it runs), so this result describes
 * only the newly created interaction instance.
 */
export interface StartSessionResult {
  sessionId: string;
  interactionInstanceId: string;
  promptId: string;
  state: InteractionState;
  engineType: EngineType;
  /**
   * Slice 008. The member-facing Turn number of the Segment this
   * Interaction Instance belongs to — unchanged from the caller's prior
   * Turn when segmentTarget was CURRENT_SEGMENT, incremented by one when
   * it was NEW_SEGMENT (the default). Lets a host UI update its Turn
   * label immediately from this response, without waiting on the next
   * GET_SESSION poll.
   */
  segmentNumber: number;
}

/**
 * Result of a successful SUBMIT_RESPONSE. "Latest response replaces the
 * previous one" (last-write-wins) is an explicit MVP implementation
 * decision, not a permanent gameplay rule — future product validation
 * may determine immutable submissions or a different revision policy
 * (e.g. a submit-once lock, an edit history, or a host-controlled
 * revision window). Revisit this deliberately rather than assuming the
 * current behavior is load-bearing.
 */
export interface SubmitResponseResult {
  submissionId: string;
  sessionId: string;
  interactionInstanceId: string;
  participantId: string;
  text: string;
  updatedAt: string;
}

/**
 * Result of a successful CLOSE_SUBMISSIONS. Slice 001: describes the
 * interaction instance that closed, not the session — the session's
 * own state does not change.
 */
export interface CloseSubmissionsResult {
  sessionId: string;
  interactionInstanceId: string;
  state: InteractionState;
}

/**
 * Result of a successful REVEAL_RESULTS. Slice 001: describes the
 * interaction instance that revealed, not the session.
 */
export interface RevealResultsResult {
  sessionId: string;
  interactionInstanceId: string;
  state: InteractionState;
}

/** A participant as exposed by GET_SESSION — no token, no join timestamp. */
export interface ParticipantSummary {
  participantId: string;
  displayName: string;
}

/**
 * Slice 002 (Scored Multi-Round Experience). One participant's
 * cumulative score for this session, derived by summing point_awards
 * at read time — never stored as a running total. Always present for
 * every participant, defaulting to 0 before any award exists.
 */
export interface ParticipantStanding {
  participantId: string;
  displayName: string;
  score: number;
}

/**
 * Result of a successful AWARD_POINTS. Slice 002: describes the one
 * point-award ledger row created (or, on an idempotent replay,
 * already existing) — not the session, and not cumulative standings.
 * GET_SESSION is responsible for surfacing derived standings.
 */
export interface AwardPointsResult {
  pointAwardId: string;
  sessionId: string;
  interactionInstanceId: string;
  participantId: string;
  points: number;
  createdAt: string;
}

/**
 * A prompt as exposed by GET_SESSION.
 *
 * Slice 003: options is populated for a Multiple Choice interaction
 * (needed to answer at all) and null for Open Response. correctIndex
 * is the platform's first genuinely private-until-reveal field — known
 * to the system from the moment the interaction is created, but always
 * null here until the current interaction reaches RESULT_REVEAL,
 * regardless of caller role. This mirrors submissions' existing
 * reveal-gating exactly, applied to a second field.
 */
export interface PromptSummary {
  promptId: string;
  text: string;
  options: string[] | null;
  correctOptionIndex: number | null;
}

/**
 * A submitted response as exposed by GET_SESSION during RESULT_REVEAL.
 * No anonymity for the MVP — attributed directly to the participant.
 *
 * Slice 003: for a Multiple Choice interaction, text is resolved to
 * the selected option's label (not the raw stored index) and
 * isCorrect reflects automatic evaluation. Both are null/unset in
 * spirit for Open Response — isCorrect is always null there, since
 * Open Response has no correctness concept at all.
 */
export interface SubmissionSummary {
  participantId: string;
  displayName: string;
  text: string;
  isCorrect: boolean | null;
}

/**
 * Slice 003. One question in a session's pre-authored Multiple Choice
 * queue, as exposed by GET_SESSION. Host-only: the correct answer here
 * is available before the corresponding interaction is ever started,
 * let alone revealed, so this field must never be included in a
 * participant's GET_SESSION response.
 */
export interface PreparedQuestionSummary {
  preparedQuestionId: string;
  ordinal: number;
  promptText: string;
  options: string[];
  correctOptionIndex: number;
  pointsForCorrect: number;
  consumedAt: string | null;
}

/**
 * Trivia Game composition correction (founder production-playtest
 * follow-up, post-Slice-009). A participant-safe read model of "where
 * are we in this Multiple Choice question sequence" — unlike
 * `preparedQuestions` (host-only, carries `correctOptionIndex` and
 * every question's own text), this carries no authoring content at
 * all: `current` is simply a count of already-consumed prepared
 * questions, `total` a count of every prepared question that exists
 * for the session, both already-public facts derivable from data any
 * caller could already infer indirectly. Populated whenever
 * `currentEngineType` is `"MULTIPLE_CHOICE"`, null otherwise (Open
 * Response and Voting have no question-sequence concept to report).
 * `total` is intentionally session-wide, not scoped to one Segment —
 * this slice deliberately does not introduce a named Question Set/Quiz
 * entity; see the Trivia Game composition implementation record.
 */
export interface QuestionProgress {
  current: number;
  total: number;
}

/**
 * Quiz Experience (self-paced, independent participant progression —
 * distinct from Trivia). One question within an active Quiz, from the
 * requesting participant's own point of view. `selectedOptionIndex` is
 * that participant's own answer (safe — it is their own data).
 * `correctOptionIndex` and `isCorrect` are null while the Quiz remains
 * open — the whole point of Quiz's privacy boundary is that no
 * participant may learn correctness (their own or anyone else's)
 * before the Quiz closes, since another participant may not have
 * reached this question yet. Populated only once the owning Quiz's
 * `closed` becomes true.
 */
export interface QuizQuestionSummary {
  interactionInstanceId: string;
  ordinal: number;
  promptText: string;
  options: string[];
  answered: boolean;
  selectedOptionIndex: number | null;
  correctOptionIndex: number | null;
  isCorrect: boolean | null;
  /**
   * The question's configured point value — already known,
   * authoring-time data (mirrors preparedQuestions' own
   * pointsForCorrect), not a new scoring concept. Exposed so a
   * participant-side "Quiz complete" summary can show points earned
   * from this Quiz specifically without inventing a second ledger:
   * sum(pointsForCorrect where isCorrect) equals exactly what
   * close_quiz_atomically already wrote to point_awards for this
   * participant's Quiz questions.
   */
  pointsForCorrect: number;
}

/**
 * Host-only, per-participant Quiz facilitation view. Deliberately
 * carries only a count, never answer content — "Alex 10/10," not what
 * Alex actually selected. See GET_SESSION's Quiz privacy rule.
 */
export interface QuizParticipantProgressSummary {
  participantId: string;
  displayName: string;
  answered: number;
  total: number;
}

/**
 * Quiz Experience read model. Populated whenever the session's most
 * recently created Segment is a Quiz (has a quiz_windows row) —
 * entirely additive alongside the existing currentInteraction /
 * currentPrompt fields, which keep their unchanged, Trivia/Open
 * Response/Voting-only meaning and are not repurposed for Quiz. `null`
 * for every session that has never started a Quiz.
 *
 * `questions` and `myProgress` are populated for a participant caller
 * (their own answers only). `participantProgress` is populated for
 * the host only (aggregate counts, never answer content — see
 * QuizParticipantProgressSummary). Exactly one of the two is non-null
 * for any given caller, mirroring `preparedQuestions`' existing
 * host-vs-participant role split.
 *
 * `closesAt` is the server-authoritative deadline; the client renders
 * a countdown from it but is never the authority on whether time has
 * run out — see submitQuizResponse/closeQuiz. `closed` is true once
 * `closedAt` is set (by host manual close or by any client detecting
 * expiry and triggering CLOSE_QUIZ) — before that point, correctness
 * and final scoring remain hidden even if the displayed countdown has
 * reached zero, since the authoritative close transaction may not
 * have run yet. Final standings are not duplicated here — once
 * `closed` is true, the existing session-wide `standings` field already
 * reflects the Quiz's point_awards.
 */
export interface QuizSummary {
  segmentId: string;
  segmentNumber: number;
  closesAt: string;
  closed: boolean;
  totalQuestions: number;
  questions: QuizQuestionSummary[] | null;
  myProgress: { answered: number; total: number } | null;
  participantProgress: QuizParticipantProgressSummary[] | null;
}

/** Result of a successful START_QUIZ. */
export interface StartQuizResult {
  sessionId: string;
  segmentId: string;
  segmentNumber: number;
  closesAt: string;
  totalQuestions: number;
}

/** Result of a successful SUBMIT_QUIZ_RESPONSE. */
export interface SubmitQuizResponseResult {
  submissionId: string;
  sessionId: string;
  interactionInstanceId: string;
  participantId: string;
  selectedOptionIndex: number;
  updatedAt: string;
}

/**
 * Result of a successful CLOSE_QUIZ. `alreadyClosed` distinguishes a
 * genuine finalization from an idempotent replay (a second host click,
 * or a benign host-close/expiry-close race) — both return the same
 * closedAt, but only the former performed evaluation/reveal work in
 * this call.
 */
export interface CloseQuizResult {
  sessionId: string;
  segmentId: string;
  closedAt: string;
  alreadyClosed: boolean;
}

/** One question as supplied to PREPARE_QUESTIONS, before validation. */
export interface PrepareQuestionsInput {
  promptText: string;
  options: string[];
  correctOptionIndex: number;
  points?: number;
}

/** Result of a successful PREPARE_QUESTIONS. */
export interface PrepareQuestionsResult {
  sessionId: string;
  questions: PreparedQuestionSummary[];
}

/**
 * Result of a successful GET_SESSION. Never includes hostToken or any
 * participantToken.
 *
 * Slice 001: `state` is now the session's own narrower lifecycle
 * (LOBBY_OPEN | LOBBY_LOCKED | SESSION_COMPLETE) — it no longer
 * reflects prompt/submission/reveal phase. `interactionNumber` and
 * `interactionState` describe the current interaction instance (the
 * most recently started one for this session), both null before any
 * interaction has ever been started. interactionNumber is a 1-indexed
 * count of interactions started so far — derived at read time from
 * however many interaction_instances rows exist for this session, not
 * a stored value (see the accepted Slice 001 design's stress test).
 *
 * submittedCount / eligibleParticipantCount are populated while the
 * current interaction is PROMPT_ACTIVE or SUBMISSIONS_CLOSED, null
 * otherwise. submissions is populated only while the current
 * interaction is RESULT_REVEAL (including after SESSION_COMPLETE, if
 * the session completed after revealing — mirroring currentPrompt's
 * precedent), null otherwise — response text is never exposed before
 * RESULT_REVEAL. Both are scoped to the *current* interaction only;
 * this slice does not expose past interactions' submissions.
 *
 * Slice 002 (Scored Multi-Round Experience): `standings` is always
 * present (one entry per participant, score defaulting to 0), with its
 * own visibility rule independent of currentPrompt/submissions above —
 * it does not go null at SESSION_COMPLETE, since final standings must
 * remain visible once the session ends. `currentInteractionInstanceId`
 * is exposed so a client can submit AWARD_POINTS against an explicit
 * target after a refresh or on a second device, rather than only ever
 * learning it from START_SESSION/REVEAL_RESULTS's own responses. No
 * "winner" field is exposed — winner determination (including the
 * zero-score case, where no awards exist and no one should be declared
 * a winner) is an intentionally client-derived presentation rule for
 * this slice, not a stored or server-computed value.
 *
 * Slice 003 (Second Interaction Engine): `preparedQuestions` is the
 * first field in this platform's history that differs by caller role
 * rather than only by overall access — populated (including each
 * question's correct answer) only when the caller is the host, null
 * for a participant, even though both roles are equally authorized to
 * call GET_SESSION at all. `currentPrompt.options` / `correctOptionIndex`
 * and `submissions[].isCorrect` are the Multiple Choice-specific fields
 * described on their own types above.
 *
 * Session Continuity slice: `successorSessionId` / `successorRoomCode`
 * describe whether *this* session has a successor — even though the
 * column that makes that knowable (predecessor_session_id) lives on
 * the successor's own row, not this one (see 0028's migration
 * comment). Both are null until a successor exists, and a successor
 * can only exist once this session is SESSION_COMPLETE. Visible to
 * host and participant alike, with no role gating: unlike
 * preparedQuestions' correct answers, there is nothing to protect
 * about the existence or room code of a next game.
 *
 * Slice 008 (Segment / Turn grouping): `segmentNumber` is the
 * member-facing Turn identity — the current Segment's segment_ordinal,
 * a durable, database-allocated value, not a derived count. It is a
 * deliberately different field from `interactionNumber`, which keeps its
 * pre-Slice-008 meaning unchanged (a 1-indexed count of Interaction
 * Instances, used only for the host/participant clients' own current-
 * interaction-changed cache invalidation). One Segment may contain more
 * than one Interaction Instance (the Best Joke proving case: Open
 * Response then Voting, same Turn), so segmentNumber can stay the same
 * across a GET_SESSION call where interactionNumber has advanced — this
 * is expected, not a bug. Null before any Segment has ever been created
 * for this session.
 */
export interface GetSessionResult {
  sessionId: string;
  state: SessionState;
  stateVersion: number;
  participants: ParticipantSummary[];
  interactionNumber: number | null;
  segmentNumber: number | null;
  interactionState: InteractionState | null;
  currentInteractionInstanceId: string | null;
  currentEngineType: EngineType | null;
  currentPrompt: PromptSummary | null;
  submittedCount: number | null;
  eligibleParticipantCount: number | null;
  submissions: SubmissionSummary[] | null;
  standings: ParticipantStanding[];
  preparedQuestions: PreparedQuestionSummary[] | null;
  successorSessionId: string | null;
  successorRoomCode: string | null;
  /**
   * Slice 007 (Voting Engine). Populated whenever currentEngineType is
   * "VOTING", regardless of interaction state — candidates must be
   * visible before voting can happen at all, mirroring how MULTIPLE_CHOICE's
   * `currentPrompt.options` is never reveal-gated. Null for every other
   * engine.
   */
  currentVotingCandidates: VotingCandidateSummary[] | null;
  /**
   * Slice 007. The first GET_SESSION field whose value depends on the
   * identity of the specific participant making the request, not only
   * their broad role — every prior role-differentiated field
   * (preparedQuestions) varies by host-vs-participant only. Null for
   * the host (who does not vote in this slice) and for a participant
   * when the current interaction is not VOTING or they have not voted
   * yet. Unlike Multiple Choice's selectedOptionIndex (client-tracked
   * only, since GET_SESSION never echoes it back before reveal), this
   * field IS authoritatively echoed back before reveal — a deliberate
   * new precedent, not an oversight.
   */
  myVoteCandidateId: string | null;
  /**
   * Slice 007. Null until the current VOTING interaction reaches
   * RESULT_REVEAL, mirroring `submissions`'s existing reveal-gating
   * exactly. No role gating once revealed — mirrors `submissions`'s own
   * no-gating precedent, since Voting has no private "correct answer"
   * concept to withhold from anyone.
   */
  votingResults: VotingResultSummary[] | null;
  /**
   * Trivia Game composition correction (post-Slice-009). See
   * `QuestionProgress`'s own doc comment for exactly what this does
   * and does not carry.
   */
  questionProgress: QuestionProgress | null;
  /**
   * Quiz Experience. See QuizSummary's own doc comment for exactly
   * what this does and does not carry, and for its role split between
   * host and participant callers.
   */
  currentQuiz: QuizSummary | null;
  /**
   * Session Capability Architecture v1. Raw declared set, `[]` for
   * both "not yet declared" and "declared empty," `[]` also for
   * legacyUndeclared (see that field for the actual distinction).
   */
  declaredCapabilities: string[];
  /**
   * Derived, never persisted separately — true the moment this
   * session has real participant evidence (participants.length > 0
   * here), computed identically to set_session_capabilities_atomically's
   * own live check. One source of truth.
   */
  capabilitiesLocked: boolean;
  /**
   * True only for a session whose declaredCapabilities column is
   * NULL — created before this feature existed. Distinct from a
   * freshly created, still-undeclared session (declaredCapabilities
   * `[]`, legacyUndeclared false).
   */
  legacyUndeclared: boolean;
  /**
   * Duel / SESSION_SUBGAME v1. This session's currently active Duel,
   * if any — at most one, per the one-active-subgame invariant. Null
   * whenever no Duel is ACTIVE, regardless of whether one has ever run
   * or completed for this session (see duelHistory for that).
   */
  activeDuel: DuelSummary | null;
  /**
   * Duel / SESSION_SUBGAME v1. Every Duel that has ever run for this
   * session, most recent first — historical evidence, readable
   * regardless of session state. Includes the currently active one
   * (if any), duplicated with activeDuel deliberately, mirroring how
   * currentInteractionInstanceId's own interaction also appears within
   * a session's broader history elsewhere in this codebase.
   */
  duelHistory: DuelSummary[];
}

/**
 * Duel Mechanic Boundary — Narrow Backend Correction. GET_SESSION's
 * own Duel projection for the currently-only mechanic, Multiple
 * Choice: never carries correctOptionIndex, and applies the read-model
 * privacy requirement Duel_Architecture.md's own "Read-Model Boundary"
 * section requires: each competitor always sees their own response;
 * both competitors' responses become visible to everyone only once the
 * Duel is COMPLETED, never while ACTIVE. Nested under DuelSummary's own
 * multipleChoice field, mirroring MultipleChoiceDuelContent — a future
 * mechanic projects its own sibling shape under its own field, never
 * widening this one.
 */
export interface MultipleChoiceDuelSummary {
  promptText: string;
  options: string[];
  /** The calling competitor's own submitted option index. Null if the caller is not a competitor, or has not answered yet. */
  myResponseOptionIndex: number | null;
  /** Null while ACTIVE (privacy); populated for everyone once COMPLETED. */
  competitorAOptionIndex: number | null;
  /** Null while ACTIVE (privacy); populated for everyone once COMPLETED. */
  competitorBOptionIndex: number | null;
}

/**
 * Math Duel Slice 001's own read-model projection of a single
 * challenge — never carries the correct answer itself, only each
 * competitor's own submitted value and its already-computed
 * correctness (a stronger cut than strictly required: implementation-
 * readiness explicitly noted correctness can be represented without
 * ever re-exposing correct_answer, so this type doesn't carry it even
 * post-COMPLETED). questionText is present only once this specific
 * viewer is authorized to see it — see MathDuelSummary's own doc
 * comment for the exact sequential-authorization rule this implements.
 */
export interface MathDuelChallengeSummary {
  challengeOrdinal: number;
  phase: "STANDARD" | "SUDDEN_DEATH";
  questionText: string;
  /** This viewer's own answer, if this viewer is a competitor and has answered this challenge. */
  myAnswer: number | null;
  myCorrect: boolean | null;
  /** Null until the whole Duel reaches COMPLETED (privacy) — never revealed merely because this one challenge, or even this one phase, has been answered by both. */
  competitorAAnswer: number | null;
  competitorACorrect: boolean | null;
  competitorBAnswer: number | null;
  competitorBCorrect: boolean | null;
}

/**
 * Math Duel Slice 001's own GET_SESSION projection, nested under
 * DuelSummary's own mathDuel field exactly the way MultipleChoiceDuelSummary
 * nests under multipleChoice — Duel_Architecture.md's own "Read-Model
 * Boundary": mechanic-specific state is projected per that mechanic's
 * own privacy/lifecycle rules, never flattened onto the shared
 * summary.
 *
 * Sequential-authorization rule (Founder decision, Math Duel Founder
 * Product Confirmation gate): `challenges` includes only what this
 * specific viewer is currently authorized to see — a competitor sees
 * their own already-answered challenges plus their own current
 * challenge, never a future one; a Host or spectator sees none at all
 * while ACTIVE; every viewer sees every challenge, fully revealed,
 * once the Duel reaches COMPLETED. This is enforced by the read-model
 * projection function itself (getSession.ts), not merely hidden by the
 * UI — a future challenge's questionText is genuinely absent from the
 * JSON payload, not present-but-unrendered.
 *
 * Reveal-timing correction (implementation-readiness §16, revising an
 * earlier draft of this Slice): the STANDARD→SUDDEN_DEATH phase
 * transition is explicitly NOT a reveal boundary — no correctness or
 * opponent content is exposed at that boundary, only once the Duel is
 * genuinely COMPLETED. `phase` itself is always visible as a fact
 * (everyone needs to know the format changed), but never accompanied
 * by content.
 */
export interface MathDuelSummary {
  /** The phase of whichever challenge is currently authorized/current for this Duel overall — derived, not separately persisted (see 0141's own migration comment: there is no duels.current_phase column). */
  phase: "STANDARD" | "SUDDEN_DEATH";
  /** See this interface's own sequential-authorization doc comment above for exactly which challenges appear here for which viewer. */
  challenges: MathDuelChallengeSummary[];
  /** This competitor's own progress. Null if the caller is not a competitor in this Duel. */
  myProgress: { answered: number; total: number } | null;
  /** Coarse, correctness-free completion counts — safe for Host/spectator viewing, satisfying the explicit "no running score" requirement. */
  competitorASubmittedCount: number;
  competitorBSubmittedCount: number;
  /** Populated only once COMPLETED. */
  standardCorrectCountA: number | null;
  standardCorrectCountB: number | null;
}

/**
 * Duel / SESSION_SUBGAME v1. GET_SESSION's own Duel projection —
 * distinct from DuelRecord. Generic Duel facts only at the top level;
 * mechanicKey identifies which mechanic this Duel hosts, and that
 * mechanic's own viewer-projected state lives in the correspondingly-
 * named nested field (Product/Duel_Architecture.md's own "Read-Model
 * Boundary" section — mechanic-specific state is projected according
 * to that mechanic's own privacy/lifecycle rules, never flattened onto
 * the shared summary). multipleChoice/mathDuel are both optional,
 * mirroring DuelRecord's own two-optional-sibling-fields shape (see
 * that interface's doc comment for why this was chosen over a strict
 * discriminated union) — exactly one is populated for any valid Duel,
 * selected by mechanicKey.
 */
export interface DuelSummary {
  duelId: string;
  mechanicKey: DuelMechanicKey;
  competitorAParticipantId: string;
  competitorBParticipantId: string;
  lifecycleState: DuelLifecycleState;
  terminalResolution: DuelTerminalResolution | null;
  winnerParticipantId: string | null;
  reason: string | null;
  startedAt: string | null;
  endedAt: string | null;
  multipleChoice?: MultipleChoiceDuelSummary;
  mathDuel?: MathDuelSummary;
}

/** Raised when a generated room code collides with an active session. */
export class RoomCodeCollisionError extends Error {
  constructor() {
    super("Room code collision against an active session.");
    this.name = "RoomCodeCollisionError";
  }
}

/**
 * Result of a successful JOIN_SESSION.
 *
 * URBANO Gaming Identity Foundation: gamingMemberId is null for a Guest
 * join (the existing, unchanged path) and set for an authenticated join
 * — see joinSession.ts's own comment on the additive Authorization
 * header handling.
 */
export interface JoinSessionResult {
  participantId: string;
  participantToken: string;
  sessionId: string;
  sessionState: SessionState;
  displayName: string;
  gamingMemberId: string | null;
}

/**
 * Raised when a command targets a session that does not exist (by room
 * code or by session id, depending on the caller). Shared across
 * JOIN_SESSION and LOCK_LOBBY.
 */
export class SessionNotFoundError extends Error {
  constructor() {
    super("No active session found.");
    this.name = "SessionNotFoundError";
  }
}

/**
 * Raised when a command requires the session to be LOBBY_OPEN and it is
 * not. Shared across JOIN_SESSION and LOCK_LOBBY — the message is
 * intentionally action-neutral rather than naming a specific command.
 */
export class LobbyNotOpenError extends Error {
  constructor(currentState?: SessionState) {
    super(
      currentState
        ? `Session is in ${currentState}, not LOBBY_OPEN.`
        : "Session is no longer LOBBY_OPEN."
    );
    this.name = "LobbyNotOpenError";
  }
}

/**
 * Raised when a command requires the session to be LOBBY_LOCKED and it
 * is not. Distinct from LobbyNotOpenError, which means the opposite
 * requirement (needs OPEN, isn't) — this means the session hasn't been
 * locked yet, or has already moved past LOBBY_LOCKED.
 */
export class LobbyNotLockedError extends Error {
  constructor(currentState?: SessionState) {
    super(
      currentState
        ? `Session is in ${currentState}, not LOBBY_LOCKED.`
        : "Session is no longer LOBBY_LOCKED."
    );
    this.name = "LobbyNotLockedError";
  }
}

/**
 * Raised when LOCK_LOBBY's supplied host token does not match the
 * session's stored host token.
 */
export class HostTokenMismatchError extends Error {
  constructor() {
    super("Host token does not match this session.");
    this.name = "HostTokenMismatchError";
  }
}

/**
 * Raised when GET_SESSION's supplied bearer token matches neither the
 * session's host token nor any participant's token for that session.
 */
export class SessionAccessDeniedError extends Error {
  constructor() {
    super("This token does not grant access to this session.");
    this.name = "SessionAccessDeniedError";
  }
}

/**
 * Raised when COMPLETE_SESSION targets a session that is already
 * SESSION_COMPLETE. Per Interpretation 2 (administrative termination),
 * this is the only state COMPLETE_SESSION rejects — every other state
 * is a valid source state.
 */
export class SessionAlreadyCompleteError extends Error {
  constructor() {
    super("Session is already complete.");
    this.name = "SessionAlreadyCompleteError";
  }
}

/**
 * Raised when a command requires the current interaction instance to
 * be PROMPT_ACTIVE and it is not — either because no interaction has
 * been started yet, or because the current one has already moved past
 * PROMPT_ACTIVE, or because the session itself is no longer
 * LOBBY_LOCKED (e.g. already completed). Shared across SUBMIT_RESPONSE
 * and CLOSE_SUBMISSIONS, which have the identical precondition.
 * Slice 001: the state described is now the interaction instance's,
 * not the session's, though the type remains SessionState since
 * InteractionState's members are already a subset of it.
 */
export class PromptNotActiveError extends Error {
  constructor(currentState?: SessionState) {
    super(
      currentState
        ? `Session is in ${currentState}, not PROMPT_ACTIVE.`
        : "Session is no longer PROMPT_ACTIVE."
    );
    this.name = "PromptNotActiveError";
  }
}

/**
 * Raised when REVEAL_RESULTS targets a session whose current
 * interaction instance is not SUBMISSIONS_CLOSED.
 */
export class SubmissionsNotClosedError extends Error {
  constructor(currentState?: SessionState) {
    super(
      currentState
        ? `Session is in ${currentState}, not SUBMISSIONS_CLOSED.`
        : "Session is no longer SUBMISSIONS_CLOSED."
    );
    this.name = "SubmissionsNotClosedError";
  }
}

/**
 * Slice 001. Raised when START_SESSION is invoked while the session's
 * current interaction instance exists but has not yet reached
 * RESULT_REVEAL — the precondition that makes the command safely
 * re-invocable once per interaction rather than once per session.
 */
export class PreviousInteractionNotRevealedError extends Error {
  constructor(currentInteractionState?: InteractionState) {
    super(
      currentInteractionState
        ? `The current interaction is in ${currentInteractionState}, not RESULT_REVEAL.`
        : "The current interaction has not been revealed yet."
    );
    this.name = "PreviousInteractionNotRevealedError";
  }
}

/**
 * Slice 008 (Segment / Turn grouping). Raised when START_SESSION is
 * invoked with segmentTarget "CURRENT_SEGMENT" but the session has no
 * current Segment to continue — either no Interaction Instance has ever
 * been started, or (structurally impossible today, but named for
 * completeness) no Segment exists to attach one to. Distinct from
 * PreviousInteractionNotRevealedError, which fires when a current
 * Segment exists but its latest Interaction Instance is not yet
 * RESULT_REVEAL.
 */
export class NoCurrentSegmentToContinueError extends Error {
  constructor() {
    super(
      "There is no current Segment to continue — start a new Turn instead."
    );
    this.name = "NoCurrentSegmentToContinueError";
  }
}

/**
 * Slice 001. Raised when a host-supplied prompt is empty after
 * trimming whitespace. Mirrors EmptyResponseError's MVP floor: at
 * least one visible character is required.
 */
export class EmptyPromptTextError extends Error {
  constructor() {
    super("Prompt text cannot be empty.");
    this.name = "EmptyPromptTextError";
  }
}

/**
 * Slice 001. Raised when a host-supplied prompt exceeds the MVP
 * length floor (1000 characters after trimming) — mirrors
 * ResponseTooLongError's deliberately generous, adjustable
 * placeholder, not a considered product limit.
 */
export class PromptTextTooLongError extends Error {
  constructor() {
    super("Prompt text cannot exceed 1000 characters.");
    this.name = "PromptTextTooLongError";
  }
}

/**
 * Raised when a submitted response is empty after trimming whitespace.
 * Per MVP response floor: at least one visible character is required.
 */
export class EmptyResponseError extends Error {
  constructor() {
    super("Response cannot be empty.");
    this.name = "EmptyResponseError";
  }
}

/**
 * Raised when a submitted response exceeds the MVP length floor (1000
 * characters after trimming) — a deliberately generous, adjustable
 * placeholder, not a considered product limit.
 */
export class ResponseTooLongError extends Error {
  constructor() {
    super("Response cannot exceed 1000 characters.");
    this.name = "ResponseTooLongError";
  }
}

/**
 * Raised when a display name collides with an existing participant in
 * the same session, per the canonical repository's normalized
 * display-name uniqueness rule.
 */
export class DisplayNameTakenError extends Error {
  constructor() {
    super("This display name is already in use in this session.");
    this.name = "DisplayNameTakenError";
  }
}

/**
 * URBANO Gaming Identity Foundation. Raised when an authenticated
 * JOIN_SESSION call's Gaming Member already has a Participant in this
 * Session — the domain-layer/repository translation of
 * participants_session_gaming_member_unique (0046). A Gaming Member may
 * still join a different Session freely; this is scoped to one Session
 * only.
 */
export class GamingMemberAlreadyInSessionError extends Error {
  constructor() {
    super("This Gaming Member already has a participant in this session.");
    this.name = "GamingMemberAlreadyInSessionError";
  }
}

/**
 * Raised when a submitted display name is empty after trimming
 * whitespace. Per MVP display-name floor: at least one visible
 * character is required after trimming.
 */
export class EmptyDisplayNameError extends Error {
  constructor() {
    super("Display name cannot be empty.");
    this.name = "EmptyDisplayNameError";
  }
}

/**
 * Raised when a submitted display name exceeds 40 characters after
 * trimming. Per MVP display-name floor.
 */
export class DisplayNameTooLongError extends Error {
  constructor() {
    super("Display name cannot exceed 40 characters.");
    this.name = "DisplayNameTooLongError";
  }
}

/**
 * Slice 002 (Scored Multi-Round Experience). Raised on a genuinely new
 * AWARD_POINTS request (never on an idempotent replay) when the
 * supplied interactionInstanceId is not both the session's current
 * (most recently created) interaction instance and at RESULT_REVEAL.
 * Awards are restricted to the specific interaction the client named,
 * and only while that one is still current and revealed — not any
 * earlier interaction, and not "whatever is current now" if the
 * session has since moved on.
 */
export class InteractionInstanceNotEligibleError extends Error {
  constructor() {
    super(
      "The supplied interaction is not the session's current, revealed interaction."
    );
    this.name = "InteractionInstanceNotEligibleError";
  }
}

/**
 * Slice 002. Raised on a genuinely new AWARD_POINTS request when the
 * supplied participantId does not belong to the session.
 */
export class ParticipantNotInSessionError extends Error {
  constructor() {
    super("This participant does not belong to this session.");
    this.name = "ParticipantNotInSessionError";
  }
}

/**
 * Slice 002. Raised on a genuinely new AWARD_POINTS request when the
 * supplied points value is not a positive integer, or exceeds the MVP
 * sanity bound (10000) — a fat-finger floor, not a considered scoring
 * limit. Score correction is deferred for this slice, so negative
 * values are rejected outright rather than treated as corrections.
 */
export class InvalidPointsError extends Error {
  constructor() {
    super("Points must be a positive integer no greater than 10000.");
    this.name = "InvalidPointsError";
  }
}

/**
 * Slice 003 (Second Interaction Engine). Raised by PREPARE_QUESTIONS
 * when a question supplies fewer than two options, an empty option
 * after trimming, or duplicate option text.
 */
export class InvalidOptionsError extends Error {
  constructor() {
    super(
      "A question must supply at least two distinct, non-empty options."
    );
    this.name = "InvalidOptionsError";
  }
}

/**
 * Slice 003. Raised by PREPARE_QUESTIONS when a question's
 * correctOptionIndex is not a valid index into its own options array.
 */
export class InvalidCorrectOptionIndexError extends Error {
  constructor() {
    super("correctOptionIndex must be a valid index into options.");
    this.name = "InvalidCorrectOptionIndexError";
  }
}

/**
 * Slice 003. Raised when a START_SESSION call's supplied
 * preparedQuestionId does not identify a prepared question belonging
 * to this session.
 */
export class PreparedQuestionNotFoundError extends Error {
  constructor() {
    super("No prepared question exists for this id in this session.");
    this.name = "PreparedQuestionNotFoundError";
  }
}

/**
 * Slice 003. Raised when a START_SESSION call's supplied
 * preparedQuestionId has already been consumed by an earlier
 * interaction instance.
 */
export class PreparedQuestionAlreadyConsumedError extends Error {
  constructor() {
    super("This prepared question has already been started.");
    this.name = "PreparedQuestionAlreadyConsumedError";
  }
}

/**
 * Slice 003. Raised when SUBMIT_RESPONSE targets a Multiple Choice
 * interaction with text that is not a legal option index for that
 * specific question — the Multiple Choice analogue of
 * EmptyResponseError/ResponseTooLongError, which only make sense for
 * Open Response's free-text shape.
 */
export class InvalidOptionSelectionError extends Error {
  constructor() {
    super("Selected option is not valid for this question.");
    this.name = "InvalidOptionSelectionError";
  }
}

/**
 * Session Continuity slice. Raised by CREATE_SUCCESSOR_SESSION when
 * the named predecessor session exists but has not yet reached
 * SESSION_COMPLETE. A rematch can only be created after its
 * predecessor's game has actually ended.
 */
export class PredecessorSessionNotCompleteError extends Error {
  constructor(currentState?: SessionState) {
    super(
      currentState
        ? `Predecessor session is in ${currentState}, not SESSION_COMPLETE.`
        : "Predecessor session is not yet SESSION_COMPLETE."
    );
    this.name = "PredecessorSessionNotCompleteError";
  }
}

/**
 * Slice 007 (Voting Engine). Raised by START_SESSION when both
 * preparedQuestionId and votingCandidateSource are supplied on the
 * same call. The two are mutually exclusive engine-selection targets;
 * silently letting one win (matching promptText's existing "ignored
 * when preparedQuestionId is set" precedent) would mask what is very
 * likely a client bug rather than an intentional request, so this is
 * rejected outright instead.
 */
export class AmbiguousStartSessionTargetError extends Error {
  constructor() {
    super(
      "At most one of preparedQuestionId or votingCandidateSource may be supplied."
    );
    this.name = "AmbiguousStartSessionTargetError";
  }
}

/**
 * Slice 007 (Voting Engine). Raised by START_SESSION when a
 * HOST_AUTHORED votingCandidateSource supplies fewer than two distinct,
 * non-empty (post-trim) candidate labels — mirrors InvalidOptionsError's
 * exact floor for Multiple Choice options.
 */
export class InvalidVotingCandidatesError extends Error {
  constructor() {
    super(
      "A Voting interaction must supply at least two distinct, non-empty candidates."
    );
    this.name = "InvalidVotingCandidatesError";
  }
}

/**
 * Slice 007. Raised by START_SESSION when a SUBMISSION
 * votingCandidateSource names an interaction instance that does not
 * exist, or does not belong to this session.
 */
export class VotingSourceInteractionNotFoundError extends Error {
  constructor() {
    super(
      "No interaction exists for this id in this session to source Voting candidates from."
    );
    this.name = "VotingSourceInteractionNotFoundError";
  }
}

/**
 * Slice 007. Raised by START_SESSION when a SUBMISSION
 * votingCandidateSource names an interaction instance that exists and
 * belongs to this session, but is not OPEN_RESPONSE, is not at
 * RESULT_REVEAL, or has zero submissions to source candidates from.
 */
export class VotingSourceInteractionNotEligibleError extends Error {
  constructor() {
    super(
      "The named interaction is not an OPEN_RESPONSE interaction at RESULT_REVEAL with at least one submission."
    );
    this.name = "VotingSourceInteractionNotEligibleError";
  }
}

/**
 * Slice 007. Raised by CAST_VOTE when the supplied candidateId does
 * not identify a Voting Candidate belonging to the session's current
 * interaction instance — the Voting analogue of
 * InvalidOptionSelectionError.
 */
export class InvalidCandidateSelectionError extends Error {
  constructor() {
    super("Selected candidate is not valid for this Voting interaction.");
    this.name = "InvalidCandidateSelectionError";
  }
}

/**
 * Slice 009 (Engine Selection + PARTICIPANTS Voting). Raised by
 * CAST_VOTE when the selected Candidate's structured participant
 * attribution (see VotingCandidateRecord.participantId) identifies it
 * as belonging to the voting participant themselves. Founder-directed:
 * self-vote is prohibited by default whenever attribution exists —
 * PARTICIPANTS Candidates always have it; SUBMISSION Candidates now
 * have it too (the participant who authored that submission);
 * HOST_AUTHORED Candidates never have it, so this can never fire for
 * them — there is no participant identity to compare against. Not
 * configurable in this slice. The error message deliberately does not
 * name the candidate or reveal anything about it beyond "you cannot
 * vote for this one" — no additional Candidate ownership information
 * is leaked.
 */
export class SelfVoteNotAllowedError extends Error {
  constructor() {
    super("A participant cannot vote for their own Candidate.");
    this.name = "SelfVoteNotAllowedError";
  }
}

/**
 * Session Continuity slice. Raised by CREATE_SUCCESSOR_SESSION when
 * the named predecessor session already has a successor —
 * sessions_predecessor_session_id_unique (0028) permits at most one
 * direct successor per session. Not a signal to retry with a new
 * predecessor (unlike RoomCodeCollisionError's regenerate-and-retry):
 * the operation itself is invalid a second time for the same
 * predecessor.
 */
export class PredecessorAlreadyHasSuccessorError extends Error {
  constructor() {
    super("This session already has a successor session.");
    this.name = "PredecessorAlreadyHasSuccessorError";
  }
}

/**
 * Quiz Experience. Raised when START_QUIZ is given a duration outside
 * the accepted bound. A pure input-validation failure, checked
 * domain-side before the atomic operation runs — mirrors
 * EmptyPromptTextError's division of responsibility, not a
 * concurrency-dependent check.
 */
export class InvalidQuizDurationError extends Error {
  constructor() {
    super("Quiz duration must be between 30 and 3600 seconds.");
    this.name = "InvalidQuizDurationError";
  }
}

/**
 * Quiz Experience. Raised when START_QUIZ is invoked but no prepared
 * question remains unconsumed for this session — a Quiz cannot start
 * with zero questions.
 */
export class EmptyQuizQuestionSetError extends Error {
  constructor() {
    super("No unconsumed prepared questions exist to start a Quiz.");
    this.name = "EmptyQuizQuestionSetError";
  }
}

/**
 * Quiz Experience. Raised when SUBMIT_QUIZ_RESPONSE targets an
 * interactionInstanceId that does not identify a Multiple Choice
 * Interaction Instance belonging to an active Quiz Segment of this
 * session — cross-session targeting, cross-Segment targeting, a
 * non-Quiz (Trivia/Open Response/Voting) instance, and a
 * never-existed id are all rejected identically, deliberately not
 * distinguished from each other in the error message (mirrors
 * SessionAccessDeniedError's own refusal to reveal which part of a
 * combined check failed).
 */
export class QuizInstanceNotFoundError extends Error {
  constructor() {
    super(
      "The target question does not belong to an active Quiz in this session."
    );
    this.name = "QuizInstanceNotFoundError";
  }
}

/**
 * Quiz Experience. Raised when SUBMIT_QUIZ_RESPONSE is invoked after
 * the Quiz's authoritative window has already closed — either
 * `closed_at` is already set, or the database's own clock has reached
 * `closes_at`, checked inside the same atomic operation as the
 * submission itself (never trusting client time). This is the
 * authoritative late-submission rejection.
 */
export class QuizClosedError extends Error {
  constructor() {
    super("This Quiz is closed and no longer accepting submissions.");
    this.name = "QuizClosedError";
  }
}

/**
 * Quiz Experience. Raised when CLOSE_QUIZ targets a Segment with no
 * quiz_windows row — either segmentId does not belong to this session,
 * or it names a Segment that was never a Quiz (Trivia/Best-Joke-style
 * Segments have no window at all).
 */
export class QuizNotFoundError extends Error {
  constructor() {
    super("No active Quiz exists for this Segment.");
    this.name = "QuizNotFoundError";
  }
}

/**
 * Quiz Experience. Raised when CLOSE_QUIZ's caller token matches
 * neither the session's host token nor any participant token of this
 * session.
 */
export class QuizAccessDeniedError extends Error {
  constructor() {
    super("Token does not authorize closing this Quiz.");
    this.name = "QuizAccessDeniedError";
  }
}

/**
 * Quiz Experience. Raised when a participant (not the host) attempts
 * CLOSE_QUIZ before the authoritative deadline has actually passed —
 * a participant may only trigger the automatic-expiry path once
 * `database_now >= closes_at`; only the host may force an early
 * close. Prevents a participant from unilaterally locking out others
 * who have not finished.
 */
export class QuizExpiryNotReachedError extends Error {
  constructor() {
    super(
      "The Quiz deadline has not passed yet — only the host may close it early."
    );
    this.name = "QuizExpiryNotReachedError";
  }
}

/**
 * Session Capability Architecture v1. Raised by SET_SESSION_CAPABILITIES
 * when a supplied key is not in the current Product-approved catalog
 * (SessionCapabilityKey).
 */
export class InvalidCapabilityKeyError extends Error {
  constructor() {
    super("Must be one of OPEN_RESPONSE, VOTING, TRIVIA, QUIZ, DUEL.");
    this.name = "InvalidCapabilityKeyError";
  }
}

/**
 * Session Capability Architecture v1. Raised by SET_SESSION_CAPABILITIES
 * when this session already has real participant evidence and the
 * caller supplied a set different from the one already locked in.
 * Same-value redeclaration is idempotent success, not this error.
 */
export class CapabilitiesLockedError extends Error {
  constructor() {
    super(
      "This session already has a real participant and its declared capabilities cannot change."
    );
    this.name = "CapabilitiesLockedError";
  }
}

/**
 * Session Capability Architecture v1. Raised by JOIN_SESSION when the
 * target session has not declared any gameplay capability yet (null
 * or empty declaredCapabilities) — the evidence-creating precondition
 * mirroring MATCH_NOT_CLASSIFIED's own established boundary.
 */
export class SessionCapabilitiesNotDeclaredError extends Error {
  constructor() {
    super("This session has not declared any gameplay capability yet.");
    this.name = "SessionCapabilitiesNotDeclaredError";
  }
}

/**
 * Session Capability Architecture v1. Raised when a gameplay-
 * activating command (START_SESSION, START_QUIZ) targets a capability
 * this session has not declared. Server-authoritative — never
 * bypassable by a stale UI or a direct API call.
 */
export class CapabilityNotAuthorizedError extends Error {
  constructor(capability?: string) {
    super(
      capability
        ? `This session has not declared the ${capability} capability.`
        : "This session has not declared the required capability."
    );
    this.name = "CapabilityNotAuthorizedError";
  }
}

/**
 * Duel / SESSION_SUBGAME v1 (Product/Duel_Architecture.md). Duel's own
 * lifecycle — CREATED is a valid value but never persisted by
 * application code (start_duel_atomically creates a Duel already
 * ACTIVE, mirroring how ordinary Interaction Instances go straight to
 * PROMPT_ACTIVE on creation).
 */
export type DuelLifecycleState = "CREATED" | "ACTIVE" | "COMPLETED";

/**
 * Duel's terminal-resolution vocabulary, deliberately not the shared
 * Gameplay Outcome taxonomy's victory/defeat — Duel_Architecture.md's
 * own "Draw / Void Disposition" keeps DRAW/VOID/CANCELLED/FORFEIT
 * SESSION_SUBGAME-local for now. WON_LOST means a real competitive
 * result exists (see winnerParticipantId).
 */
export type DuelTerminalResolution =
  | "WON_LOST"
  | "DRAW"
  | "VOID"
  | "CANCELLED"
  | "FORFEIT";

/** The exceptional-resolution values RESOLVE_DUEL_EXCEPTIONALLY accepts. */
export type DuelExceptionalResolution =
  | "CANCELLED"
  | "VOID"
  | "FORFEIT_A"
  | "FORFEIT_B";

/**
 * Duel Mechanic Boundary — Narrow Backend Correction (Product/Duel_
 * Architecture.md, "Duel Container vs. Mechanic" / "Mechanic
 * Identity"). Code-owned vocabulary, not a database registry, mirroring
 * SessionCapabilityKey's own precedent. Grows only when a mechanic is
 * actually graduated and implemented, never speculatively — MATH_DUEL
 * is Math Duel Slice 001's own graduated second mechanic (Product
 * Definition confirmed across two Founder reconciliation gates; see
 * MATH_DUEL_IMPLEMENTATION_RECORD.md).
 */
export type DuelMechanicKey = "MULTIPLE_CHOICE" | "MATH_DUEL";

/**
 * Multiple Choice's own mechanic-owned content — the prompt and
 * options a Duel competitor answers against. Duel_Architecture.md's
 * own "Duel Container vs. Mechanic" section: these are not generic
 * Duel facts, they belong to whichever mechanic produced them.
 * Deliberately excludes correctOptionIndex, which never leaves the
 * repository/resolution layer — see StartDuelResult's own doc comment.
 */
export interface MultipleChoiceDuelContent {
  promptText: string;
  options: string[];
}

/**
 * Math Duel Slice 001's own mechanic-owned content, mirroring
 * MultipleChoiceDuelContent's own shape and privacy discipline exactly
 * — deliberately excludes correctAnswer, which never leaves the
 * repository/resolution layer, the same boundary
 * correctOptionIndex/StartDuelResult already established.
 */
export interface MathDuelChallengeRecord {
  duelId: string;
  challengeOrdinal: number;
  phase: "STANDARD" | "SUDDEN_DEATH";
  questionText: string;
  createdAt: string;
  /**
   * Pre-Deployment Product-Invariant Correction. Non-derivable
   * evidence of when this challenge first became authorized/presented
   * to a competitor, independent of whether anyone ever answered it —
   * see 0143's own migration comment. Null only for a STANDARD
   * ordinal 2-5 no competitor has reached yet; every SUDDEN_DEATH row
   * is activated at the exact moment it is created (0145), so it is
   * never observably null for those. getSession.ts's terminal reveal
   * filters on this, not on duel_math_responses existence, so an
   * activated-but-never-answered final round (Cancel/Void/Forfeit cut
   * short before a response) is still honestly included in history.
   */
  activatedAt: string | null;
}

/** One competitor's answer to one Math Duel challenge. */
export interface MathDuelResponseRecord {
  duelId: string;
  challengeOrdinal: number;
  participantId: string;
  submittedAnswer: number;
  isCorrect: boolean;
  answeredAt: string;
}

/**
 * A Duel as returned by the repository layer (getDuelById,
 * getActiveDuelForSession, getDuelsForSession) — the internal record
 * every command handler and the GET_SESSION projection build from.
 * Not itself the GET_SESSION read-model shape; see DuelSummary for
 * that. Generic Duel fields only — mechanicKey identifies which
 * mechanic this Duel hosts; that mechanic's own content lives in the
 * correspondingly-named nested field. multipleChoice is optional as of
 * Math Duel Slice 001 (a Math Duel row never populates it) — two
 * optional sibling fields, not a strict discriminated union: the
 * smaller change against every already-deployed call site currently
 * reading `duel.multipleChoice.promptText` directly, deferred to a
 * future stricter refactor only if a third mechanic ever makes this
 * pattern unwieldy (implementation-readiness §15's own reasoning).
 * Math Duel's own content is deliberately NOT nested here the same
 * way — its challenges/responses live in their own tables, fetched
 * separately (getMathDuelChallenges/getMathDuelResponses), mirroring
 * how duel_responses already works for Multiple Choice today.
 */
export interface DuelRecord {
  duelId: string;
  sessionId: string;
  mechanicKey: DuelMechanicKey;
  competitorAParticipantId: string;
  competitorBParticipantId: string;
  lifecycleState: DuelLifecycleState;
  terminalResolution: DuelTerminalResolution | null;
  winnerParticipantId: string | null;
  reason: string | null;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
  multipleChoice?: MultipleChoiceDuelContent;
  /**
   * Ordinary Duel Session Scoring Slice 001. The Session-scoring
   * configuration snapshot captured for this Duel instance — not an
   * intrinsic universal property of "winning a Duel" (mirrors
   * PreparedQuestionRecord.pointsForCorrect's own per-instance-
   * configuration relationship to correctness). Always 10 for a Duel
   * created through the ordinary Host start path; no current caller
   * can set it to anything else.
   */
  winnerPoints: number;
}

/**
 * Result of a successful START_DUEL. Deliberately omits
 * correctOptionIndex — Duel_Architecture.md's own read-model privacy
 * requirement: the correct answer is never exposed to participants
 * before resolution, and this is the shape every caller (Host and
 * competitor alike) receives.
 *
 * Deliberately NOT nested like DuelRecord/DuelSummary, despite the
 * Duel Mechanic Boundary correction: this is a command result, not a
 * passive read-model any viewer polls regardless of what they just
 * did. The Host who calls START_DUEL supplied promptText/options as
 * input a moment earlier — echoing them back flat isn't the read-
 * model coupling risk that correction addresses, since the caller
 * already knows which mechanic they targeted. A future mechanic's own
 * start command is expected to define its own result shape (its own
 * config echoed back), not to force this one's shape wider — this
 * type is Multiple Choice's own start-result, not a generic template
 * to extend.
 */
export interface StartDuelResult {
  duelId: string;
  sessionId: string;
  mechanicKey: DuelMechanicKey;
  competitorAParticipantId: string;
  competitorBParticipantId: string;
  lifecycleState: DuelLifecycleState;
  promptText: string;
  options: string[];
  startedAt: string;
}

/** Result of a successful SUBMIT_DUEL_RESPONSE. */
export interface SubmitDuelResponseResult {
  duelId: string;
  participantId: string;
  answeredAt: string;
}

/**
 * Result of a successful START_MATH_DUEL. Deliberately minimal — no
 * challenge content echoed back, unlike StartDuelResult's own
 * prompt/options echo. The Host supplied no mechanic content (Math
 * Duel's own Product Definition: the Host must not manually author
 * challenges), so there is nothing of the Host's own input to echo;
 * the Host's own next GET_SESSION poll (via the same hostRefresh()
 * pattern every other Duel action already triggers) is the read path.
 */
export interface StartMathDuelResult {
  duelId: string;
  sessionId: string;
  mechanicKey: DuelMechanicKey;
  competitorAParticipantId: string;
  competitorBParticipantId: string;
  lifecycleState: DuelLifecycleState;
  startedAt: string;
}

/**
 * Result of a successful SUBMIT_MATH_DUEL_ANSWER. Deliberately
 * excludes correctness — unlike the read-model's own eventual reveal,
 * a command result the calling competitor could inspect directly on
 * every submission would silently defeat the entire pre-completion
 * privacy boundary (Math Duel Founder Product Confirmation gate's own
 * explicit "no correctness feedback during standard phase"
 * requirement). challengeOrdinal is echoed back so a genuine retry and
 * a fresh submission are distinguishable by the caller without needing
 * a separate read.
 */
export interface SubmitMathDuelAnswerResult {
  duelId: string;
  participantId: string;
  challengeOrdinal: number;
  answeredAt: string;
}

/** Result of a successful RESOLVE_DUEL or RESOLVE_DUEL_EXCEPTIONALLY. */
export interface ResolveDuelResult {
  duelId: string;
  lifecycleState: DuelLifecycleState;
  terminalResolution: DuelTerminalResolution;
  winnerParticipantId: string | null;
}

/**
 * Duel / SESSION_SUBGAME v1. Raised by START_DUEL when the same
 * participant id is supplied for both competitor slots.
 */
export class DuplicateDuelCompetitorError extends Error {
  constructor() {
    super("A Duel requires two distinct competitors.");
    this.name = "DuplicateDuelCompetitorError";
  }
}

/**
 * Duel / SESSION_SUBGAME v1. Raised by START_DUEL when a supplied
 * competitor id does not belong to this session.
 */
export class DuelCompetitorNotInSessionError extends Error {
  constructor() {
    super("Both Duel competitors must be participants of this session.");
    this.name = "DuelCompetitorNotInSessionError";
  }
}

/**
 * Duel / SESSION_SUBGAME v1. Raised by START_DUEL when this session
 * already has an active Duel, and by START_SESSION/START_QUIZ for the
 * symmetric reason — the one-active-subgame-per-Session invariant.
 */
export class ActiveDuelExistsError extends Error {
  constructor() {
    super("This session already has an active Duel.");
    this.name = "ActiveDuelExistsError";
  }
}

/**
 * Duel / SESSION_SUBGAME v1. Raised by START_DUEL when an ordinary
 * Interaction Instance is active (not yet RESULT_REVEAL) — the
 * symmetric half of ActiveDuelExistsError.
 */
export class InteractionActiveError extends Error {
  constructor(state?: string) {
    super(
      state
        ? `An ordinary interaction is in ${state} state; a Duel cannot start until it is RESULT_REVEAL.`
        : "An ordinary interaction is active; a Duel cannot start until it resolves."
    );
    this.name = "InteractionActiveError";
  }
}

/** Duel / SESSION_SUBGAME v1. Raised when a supplied options array is invalid. */
export class InvalidDuelOptionsError extends Error {
  constructor() {
    super("Duel options must be at least two distinct, non-empty entries, with a valid correct option index.");
    this.name = "InvalidDuelOptionsError";
  }
}

/** Duel / SESSION_SUBGAME v1. Raised when no Duel exists for a given id. */
export class DuelNotFoundError extends Error {
  constructor() {
    super("No Duel exists for this id.");
    this.name = "DuelNotFoundError";
  }
}

/**
 * Duel / SESSION_SUBGAME v1. Raised by SUBMIT_DUEL_RESPONSE when the
 * caller's participant token does not resolve to one of this Duel's
 * two bound competitors — including a non-competitor Session
 * participant, a stranger, or the Host.
 */
export class DuelAccessDeniedError extends Error {
  constructor() {
    super("This participant is not a competitor in this Duel.");
    this.name = "DuelAccessDeniedError";
  }
}

/**
 * Duel / SESSION_SUBGAME v1. Raised by SUBMIT_DUEL_RESPONSE when the
 * target Duel is not ACTIVE.
 */
export class DuelNotActiveError extends Error {
  constructor(state?: string) {
    super(
      state
        ? `Duel is in ${state} state, not ACTIVE.`
        : "This Duel is not active."
    );
    this.name = "DuelNotActiveError";
  }
}

/**
 * Duel / SESSION_SUBGAME v1. Raised by SUBMIT_DUEL_RESPONSE when the
 * supplied option index is not a legal index for this Duel's options.
 */
export class InvalidDuelOptionSelectionError extends Error {
  constructor() {
    super("Must be a valid option index for this Duel.");
    this.name = "InvalidDuelOptionSelectionError";
  }
}

/**
 * Duel / SESSION_SUBGAME v1. Raised by RESOLVE_DUEL and
 * RESOLVE_DUEL_EXCEPTIONALLY when the target Duel already has a
 * terminal resolution — a mechanic-derived or exceptional result is
 * never silently overwritten (Duel_Architecture.md's own "Host
 * Authority" section). Correction/supersession of an already-terminal
 * Duel is explicitly deferred, not implemented in v1.
 */
export class DuelAlreadyResolvedError extends Error {
  constructor() {
    super("This Duel already has a terminal resolution.");
    this.name = "DuelAlreadyResolvedError";
  }
}

/**
 * Duel / SESSION_SUBGAME v1. Raised by RESOLVE_DUEL_EXCEPTIONALLY when
 * the supplied resolution value is not one of CANCELLED, VOID,
 * FORFEIT_A, FORFEIT_B.
 */
export class InvalidDuelResolutionError extends Error {
  constructor() {
    super("Must be one of CANCELLED, VOID, FORFEIT_A, FORFEIT_B.");
    this.name = "InvalidDuelResolutionError";
  }
}

/**
 * Duel / SESSION_SUBGAME v1. Raised by RESOLVE_DUEL_EXCEPTIONALLY when
 * a FORFEIT_A/FORFEIT_B resolution is requested without a reason —
 * the one exceptional-resolution case where the outcome would
 * otherwise be ambiguous.
 */
export class DuelReasonRequiredError extends Error {
  constructor() {
    super("A forfeit requires a reason.");
    this.name = "DuelReasonRequiredError";
  }
}

/**
 * Math Duel Slice 001. Raised by START_MATH_DUEL when the supplied
 * challenge set is not exactly 5 valid {questionText, correctAnswer}
 * entries. A domain-layer validation failure — the challenges
 * themselves come from the server's own fixture selection, never
 * client input, so this guards a genuine implementation bug, not a
 * caller-facing input error.
 */
export class InvalidMathDuelChallengesError extends Error {
  constructor() {
    super("Exactly 5 standard-phase challenges are required.");
    this.name = "InvalidMathDuelChallengesError";
  }
}

/**
 * Math Duel Slice 001. Raised by SUBMIT_MATH_DUEL_ANSWER when the
 * supplied ordinal is not this competitor's own currently-authorized
 * challenge — either a future ordinal (rejected outright) is being
 * requested. A retry of an already-answered ordinal is never an
 * error — see SubmitMathDuelAnswerResult's own doc comment.
 */
export class InvalidMathDuelOrdinalError extends Error {
  constructor(nextExpectedOrdinal?: number) {
    super(
      nextExpectedOrdinal
        ? `That challenge is not yet authorized; the next challenge is ${nextExpectedOrdinal}.`
        : "That challenge is not yet authorized."
    );
    this.name = "InvalidMathDuelOrdinalError";
  }
}

/**
 * Math Duel Slice 001. Raised by SUBMIT_MATH_DUEL_ANSWER when the
 * supplied answer is not a non-negative integer.
 */
export class InvalidMathDuelAnswerError extends Error {
  constructor() {
    super("Submitted answer must be a non-negative integer.");
    this.name = "InvalidMathDuelAnswerError";
  }
}

/**
 * Math Duel Slice 001. Pre-Deployment Product-Invariant Correction:
 * with lazy sudden-death creation (0144/0145), a genuinely tied
 * challenge always creates its own successor before returning, so
 * this should never fire in normal operation any more — retained as a
 * defensive invariant guard (an unreachable-in-correct-operation
 * state), not an expected/disclosed Slice 001 limit the way it was
 * under the prior pre-materialized-reserve design. Never silently
 * fabricates a winner or a new challenge if it does somehow fire; Host
 * exceptional resolution (Cancel/Void/Forfeit) remains the
 * operational escape path, exactly as it already is for every other
 * stalled-Duel case.
 */
export class MathDuelChallengesExhaustedError extends Error {
  constructor() {
    super("No further challenges remain for this Duel.");
    this.name = "MathDuelChallengesExhaustedError";
  }
}
