import type { SessionRepository } from "./db/sessionRepository";
import type {
  GetSessionResult,
  QuizQuestionSummary,
  QuizParticipantProgressSummary,
} from "./types";
import { SessionNotFoundError, SessionAccessDeniedError } from "./types";

/**
 * GET_SESSION command handler.
 *
 * Scope: returns current session state, state_version, the
 * participant list (display names only — never a hostToken or any
 * participantToken), and Slice 001 (Session / Interaction
 * separation): the current interaction instance's number, state, and
 * prompt. Read-only, no state mutation, no event write.
 *
 * Authorization: unlike LOCK_LOBBY's write-time authorization, there is
 * no concurrent-mutation race to close here — two reads cannot conflict
 * with each other. So the bearer token is checked once, in this domain
 * function, against the session's host token and every participant's
 * token, with no need for a repository-level atomic re-check.
 */
export async function getSession(
  repo: SessionRepository,
  sessionId: string,
  bearerToken: string
): Promise<GetSessionResult> {
  const session = await repo.getSessionById(sessionId);
  if (!session) {
    throw new SessionNotFoundError();
  }

  const participants = await repo.getParticipantsForSession(sessionId);

  const isHost = bearerToken === session.hostToken;
  const callingParticipant = participants.find(
    (participant) => participant.participantToken === bearerToken
  );
  const isParticipant = callingParticipant !== undefined;

  if (!isHost && !isParticipant) {
    throw new SessionAccessDeniedError();
  }

  const interactionInstances = await repo.getInteractionInstancesForSession(
    sessionId
  );
  const currentInteraction =
    interactionInstances.length > 0
      ? interactionInstances[interactionInstances.length - 1]
      : null;
  const interactionNumber =
    interactionInstances.length > 0 ? interactionInstances.length : null;

  // Slice 008 (Segment / Turn grouping): segmentNumber is the
  // member-facing Turn identity — the current Interaction Instance's
  // Segment's own segment_ordinal, a durable allocated value, not a
  // derived count. Deliberately looked up by matching
  // currentInteraction.segmentId rather than assumed to be the last
  // element of the ordered segments list, so this stays correct by
  // construction rather than by an ordering coincidence.
  const segments = currentInteraction
    ? await repo.getSegmentsForSession(sessionId)
    : [];
  const segmentNumber =
    segments.find((s) => s.segmentId === currentInteraction?.segmentId)
      ?.segmentOrdinal ?? null;

  // Slice 003 (Second Interaction Engine): resolved once, up front,
  // since both currentPrompt's shape and submissions' visibility now
  // depend on which engine produced the current interaction.
  const multipleChoiceDetails =
    currentInteraction && currentInteraction.engineType === "MULTIPLE_CHOICE"
      ? await repo.getMultipleChoiceDetailsForInteraction(
          currentInteraction.interactionInstanceId
        )
      : null;
  const isRevealed = currentInteraction?.state === "RESULT_REVEAL";

  // Slice 007 (Voting Engine): resolved once, up front, alongside
  // multipleChoiceDetails — the same "which engine produced the current
  // interaction" branch point, extended to a third engine.
  const isVotingInteraction = currentInteraction?.engineType === "VOTING";

  // Candidates are visible as soon as the interaction starts, never
  // reveal-gated — mirrors currentPrompt.options' identical visibility
  // rule for Multiple Choice, and stays visible unconditionally
  // (including after SESSION_COMPLETE) the same way currentPrompt
  // itself does.
  const currentVotingCandidates =
    currentInteraction && isVotingInteraction
      ? (
          await repo.getVotingCandidatesForInteraction(
            currentInteraction.interactionInstanceId
          )
        ).map((c) => ({
          candidateId: c.candidateId,
          ordinal: c.ordinal,
          label: c.label,
        }))
      : null;

  // Slice 007. The first GET_SESSION field scoped to the specific
  // caller's own identity rather than only their role — see
  // GetSessionResult's doc comment. Unlike Multiple Choice's
  // selectedOptionIndex (client-tracked only, since GET_SESSION never
  // echoes it back), this is authoritatively read back here, on every
  // call, deliberately: casting a vote is not itself a Gameplay
  // Outcome (see Gameplay_Outcome_Taxonomy.md, 433b61e), so there is
  // nothing to withhold from the participant who cast it. Null for the
  // host and for a participant who has not voted in the current
  // interaction. Persists across session state the same way
  // currentPrompt does, not gated to LOBBY_LOCKED like the transient
  // progress/results fields below.
  const myVoteCandidateId =
    !isHost && callingParticipant && currentInteraction && isVotingInteraction
      ? (
          await repo.getVotesForInteractionInstance(
            currentInteraction.interactionInstanceId
          )
        ).find((v) => v.participantId === callingParticipant.participantId)
          ?.candidateId ?? null
      : null;

  // Visible regardless of session state once an interaction has ever
  // started — mirrors the pre-Slice-001 precedent where currentPrompt
  // stayed visible after SESSION_COMPLETE. Slice 003: options is
  // populated whenever this is a Multiple Choice interaction (needed
  // to answer at all); correctOptionIndex is this platform's first
  // genuinely private-until-reveal field — known internally from
  // creation, but withheld from every caller, host included, until the
  // interaction reaches RESULT_REVEAL, mirroring submissions' existing
  // reveal-gating below.
  const currentPromptRecord = currentInteraction
    ? await repo.getPromptById(currentInteraction.promptId)
    : null;
  const currentPrompt = currentPromptRecord
    ? {
        promptId: currentPromptRecord.promptId,
        text: currentPromptRecord.text,
        options: multipleChoiceDetails?.options ?? null,
        correctOptionIndex:
          multipleChoiceDetails && isRevealed
            ? multipleChoiceDetails.correctOptionIndex
            : null,
      }
    : null;

  let submittedCount: number | null = null;
  let eligibleParticipantCount: number | null = null;
  let submissions: GetSessionResult["submissions"] = null;
  let votingResults: GetSessionResult["votingResults"] = null;

  // Both branches below require session.state === "LOBBY_LOCKED" —
  // this exactly preserves the pre-Slice-001 behavior of resetting to
  // null once the session reaches SESSION_COMPLETE, now expressed via
  // two conditions (session state + interaction state) instead of one,
  // since those two responsibilities are no longer the same field.
  if (
    session.state === "LOBBY_LOCKED" &&
    currentInteraction &&
    (currentInteraction.state === "PROMPT_ACTIVE" ||
      currentInteraction.state === "SUBMISSIONS_CLOSED")
  ) {
    // Slice 007: "submitted" becomes "voted" for a Voting interaction —
    // same progress-bar semantics (submittedCount / eligibleParticipantCount),
    // sourced from votes instead of submissions. No per-candidate tally
    // leaks here — that is votingResults' job, reveal-gated below.
    submittedCount = isVotingInteraction
      ? (
          await repo.getVotesForInteractionInstance(
            currentInteraction.interactionInstanceId
          )
        ).length
      : (
          await repo.getSubmissionsForInteractionInstance(
            currentInteraction.interactionInstanceId
          )
        ).length;
    eligibleParticipantCount = participants.length;
  } else if (
    session.state === "LOBBY_LOCKED" &&
    currentInteraction &&
    currentInteraction.state === "RESULT_REVEAL" &&
    isVotingInteraction
  ) {
    // Slice 007: `placement` derived live from immutable vote data —
    // never persisted, mirroring Multiple Choice's own derived, never-
    // stored `correctness`. Gated on RESULT_REVEAL exactly like
    // `submissions` below, so per-candidate tallies never leak before
    // reveal.
    votingResults = await repo.getVotingResultsForInteractionInstance(
      currentInteraction.interactionInstanceId
    );
  } else if (
    session.state === "LOBBY_LOCKED" &&
    currentInteraction &&
    currentInteraction.state === "RESULT_REVEAL"
  ) {
    // Deliberately not extended to SESSION_COMPLETE, mirroring the
    // pre-Slice-001 reasoning exactly: whether a completed session's
    // current interaction ever actually passed through RESULT_REVEAL
    // (vs. an early admin termination) is, in principle, now cheaply
    // knowable from the interaction instance's own persisted state —
    // but changing this visibility behavior is not part of this
    // slice's scope, so the same reset-to-null-at-completion behavior
    // already relied upon by the harness's lastKnownSubmissions cache
    // is preserved unchanged.
    const allSubmissions = await repo.getSubmissionsForInteractionInstance(
      currentInteraction.interactionInstanceId
    );
    const displayNameByParticipantId = new Map(
      participants.map((p) => [p.participantId, p.displayName])
    );
    // Slice 003: for a Multiple Choice interaction, the stored text is
    // the selected option's index, not something a host or participant
    // should ever see raw — resolved here to the option's actual
    // label, with correctness computed alongside it. Open Response
    // keeps its raw free-text display and isCorrect stays null, since
    // it has no correctness concept at all.
    submissions = allSubmissions.map((s) => {
      if (multipleChoiceDetails) {
        const selectedIndex = Number(s.text);
        const label =
          multipleChoiceDetails.options[selectedIndex] ?? s.text;
        return {
          participantId: s.participantId,
          displayName: displayNameByParticipantId.get(s.participantId) ?? "",
          text: label,
          isCorrect: selectedIndex === multipleChoiceDetails.correctOptionIndex,
        };
      }

      return {
        participantId: s.participantId,
        displayName: displayNameByParticipantId.get(s.participantId) ?? "",
        text: s.text,
        isCorrect: null,
      };
    });
  }

  // Slice 002 (Scored Multi-Round Experience): standings are always
  // computed, with their own visibility rule independent of the
  // currentPrompt/submissions branches above — they must remain
  // visible at SESSION_COMPLETE (final standings), unlike submissions,
  // which intentionally goes null again at that point. Every
  // participant appears, defaulting to a score of 0, so the client
  // never has to distinguish "no standings yet" from "no awards yet."
  const pointAwards = await repo.getPointAwardsForSession(sessionId);
  const scoreByParticipantId = new Map<string, number>();
  for (const award of pointAwards) {
    scoreByParticipantId.set(
      award.participantId,
      (scoreByParticipantId.get(award.participantId) ?? 0) + award.points
    );
  }
  const standings = participants.map((participant) => ({
    participantId: participant.participantId,
    displayName: participant.displayName,
    score: scoreByParticipantId.get(participant.participantId) ?? 0,
  }));

  // Slice 003: the first field in this platform's history that
  // differs by caller role rather than only by overall access. Every
  // prepared question's correctOptionIndex is authoring-time data the
  // host must be able to review — and must never reach a participant,
  // who is equally authorized to call GET_SESSION at all, just not to
  // see this.
  //
  // Trivia Game composition correction (post-Slice-009): the same
  // underlying query now also backs the participant-safe
  // questionProgress field below, so it is fetched whenever either
  // caller needs it — the host (always, as before) or a participant
  // currently mid-Trivia (currentEngineType "MULTIPLE_CHOICE") — rather
  // than only for the host, to avoid adding this query to every
  // Open-Response/Voting participant's hot polled path.
  const needsPreparedQuestions =
    isHost || currentInteraction?.engineType === "MULTIPLE_CHOICE";
  const allPreparedQuestions = needsPreparedQuestions
    ? await repo.getPreparedQuestionsForSession(sessionId)
    : [];
  const preparedQuestions = isHost
    ? allPreparedQuestions.map((q) => ({
        preparedQuestionId: q.preparedQuestionId,
        ordinal: q.ordinal,
        promptText: q.promptText,
        options: q.options,
        correctOptionIndex: q.correctOptionIndex,
        pointsForCorrect: q.pointsForCorrect,
        consumedAt: q.consumedAt,
      }))
    : null;

  // Trivia Game composition correction (post-Slice-009): a
  // participant-safe count-only projection of the same data — no
  // question text, no options, no correctOptionIndex. `current` counts
  // already-consumed prepared questions (strictly ordinal-ordered
  // consumption, enforced by lowestUnconsumedPreparedQuestion's own
  // selection rule, so this count IS the current question's position);
  // `total` counts every prepared question that exists for the
  // session. Populated only during a Multiple Choice interaction — Open
  // Response and Voting have no question-sequence concept.
  const questionProgress =
    currentInteraction?.engineType === "MULTIPLE_CHOICE"
      ? {
          current: allPreparedQuestions.filter((q) => q.consumedAt !== null)
            .length,
          total: allPreparedQuestions.length,
        }
      : null;

  // Quiz Experience (self-paced, independent participant progression —
  // distinct from Trivia). Entirely additive: every field above
  // (currentInteraction, currentPrompt, interactionState,
  // segmentNumber, interactionNumber) keeps its unchanged, pre-existing
  // Trivia/Open Response/Voting-only meaning even while a Quiz is
  // active — they simply resolve to the last-created Quiz question
  // Interaction Instance, which Quiz's own UI never reads. See this
  // platform's implementation-readiness design for why Quiz's read
  // model is a parallel branch rather than a modification of the
  // existing single-current-instance resolution above.
  const currentSegmentId = currentInteraction?.segmentId ?? null;
  const quizWindow = currentSegmentId
    ? await repo.getQuizWindowForSegment(currentSegmentId)
    : null;

  let currentQuiz: GetSessionResult["currentQuiz"] = null;
  if (quizWindow && currentSegmentId) {
    const quizSegment = segments.find((s) => s.segmentId === currentSegmentId);
    const quizInstances = interactionInstances
      .filter(
        (i) => i.segmentId === currentSegmentId && i.engineType === "MULTIPLE_CHOICE"
      )
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

    const closed = quizWindow.closedAt !== null;

    type QuizQuestionRow = {
      instanceId: string;
      promptText: string;
      options: string[];
      correctOptionIndex: number;
      selectedOptionIndex: number | null;
      answeredByCaller: boolean;
      pointsForCorrect: number;
    };
    const questionRows: QuizQuestionRow[] = [];

    // Host-facing aggregate only — a count per participant, never
    // answer content. See QuizParticipantProgressSummary's doc comment
    // for why this is the deliberate privacy boundary.
    const answeredCountByParticipantId = new Map<string, number>();

    for (const instance of quizInstances) {
      const [promptRecord, details, submissionsForInstance] = await Promise.all([
        repo.getPromptById(instance.promptId),
        repo.getMultipleChoiceDetailsForInteraction(instance.interactionInstanceId),
        repo.getSubmissionsForInteractionInstance(instance.interactionInstanceId),
      ]);

      for (const submission of submissionsForInstance) {
        answeredCountByParticipantId.set(
          submission.participantId,
          (answeredCountByParticipantId.get(submission.participantId) ?? 0) + 1
        );
      }

      const callerSubmission =
        !isHost && callingParticipant
          ? submissionsForInstance.find(
              (s) => s.participantId === callingParticipant.participantId
            )
          : undefined;

      questionRows.push({
        instanceId: instance.interactionInstanceId,
        promptText: promptRecord?.text ?? "",
        options: details?.options ?? [],
        correctOptionIndex: details?.correctOptionIndex ?? -1,
        selectedOptionIndex: callerSubmission ? Number(callerSubmission.text) : null,
        answeredByCaller: callerSubmission !== undefined,
        pointsForCorrect: details?.pointsForCorrect ?? 0,
      });
    }

    // CRITICAL Quiz privacy rule: correctOptionIndex/isCorrect stay
    // null while the Quiz is open, regardless of whether this
    // participant has already answered — another participant may not
    // have reached this question yet, and revealing correctness early
    // to anyone would leak it. See QuizQuestionSummary's doc comment.
    const questions: QuizQuestionSummary[] | null =
      !isHost && callingParticipant
        ? questionRows.map((row, index) => ({
            interactionInstanceId: row.instanceId,
            ordinal: index + 1,
            promptText: row.promptText,
            options: row.options,
            answered: row.answeredByCaller,
            selectedOptionIndex: row.selectedOptionIndex,
            correctOptionIndex: closed ? row.correctOptionIndex : null,
            isCorrect: closed
              ? row.selectedOptionIndex !== null &&
                row.selectedOptionIndex === row.correctOptionIndex
              : null,
            pointsForCorrect: row.pointsForCorrect,
          }))
        : null;

    const myProgress =
      !isHost && callingParticipant
        ? {
            answered: questionRows.filter((row) => row.answeredByCaller).length,
            total: questionRows.length,
          }
        : null;

    const participantProgress: QuizParticipantProgressSummary[] | null = isHost
      ? participants.map((p) => ({
          participantId: p.participantId,
          displayName: p.displayName,
          answered: answeredCountByParticipantId.get(p.participantId) ?? 0,
          total: questionRows.length,
        }))
      : null;

    currentQuiz = {
      segmentId: currentSegmentId,
      segmentNumber: quizSegment?.segmentOrdinal ?? 0,
      closesAt: quizWindow.closesAt,
      closed,
      totalQuestions: questionRows.length,
      questions,
      myProgress,
      participantProgress,
    };

    // CRITICAL Quiz privacy rule (server-side, network-level — not a
    // client-rendering concern): the legacy `submissions` field above
    // is scoped only to currentInteraction (the Quiz's *last-created*
    // question), populated for every caller once that instance reaches
    // RESULT_REVEAL — which Close Quiz sets on every Quiz Interaction
    // Instance at once. Left unguarded, this would transmit every
    // participant's raw selected answer to the Quiz's final question,
    // to every other participant and the host, over the actual
    // GET_SESSION response — independent of, and in addition to, any
    // client-side rendering. Quiz has its own dedicated, correctly
    // privacy-scoped equivalent (currentQuiz.questions /
    // currentQuiz.participantProgress above), so the legacy field is
    // unconditionally suppressed whenever the current interaction
    // belongs to a Quiz Segment, exactly as if no interaction were
    // active for this field's purposes.
    submissions = null;
  }

  // Session Continuity slice: a successor can only exist once this
  // session is SESSION_COMPLETE (CREATE_SUCCESSOR_SESSION requires it),
  // so the lookup is skipped for every other state rather than adding
  // a query to the hot, frequently-polled path for sessions still in
  // progress. Visible to host and participant alike — see
  // GetSessionResult's doc comment for why this needs no role gating.
  let successorSessionId: string | null = null;
  let successorRoomCode: string | null = null;
  if (session.state === "SESSION_COMPLETE") {
    const successor = await repo.getSuccessorSessionByPredecessorId(sessionId);
    if (successor) {
      successorSessionId = successor.sessionId;
      successorRoomCode = successor.roomCode;
    }
  }

  // Duel / SESSION_SUBGAME v1 (Product/Duel_Architecture.md). Read-
  // model privacy: myResponseOptionIndex is always visible to the
  // calling competitor (their own answer); both competitors' own
  // answers are visible to everyone only once COMPLETED, never while
  // ACTIVE — the exact requirement Duel_Architecture.md's own read-
  // model section states.
  const duelRecords = await repo.getDuelsForSession(sessionId);
  const duelSummaries = await Promise.all(
    duelRecords.map(async (duel) => {
      const responses = await repo.getDuelResponses(duel.duelId);
      const responseA = responses.find(
        (r) => r.participantId === duel.competitorAParticipantId
      );
      const responseB = responses.find(
        (r) => r.participantId === duel.competitorBParticipantId
      );
      const revealed = duel.lifecycleState === "COMPLETED";

      const myResponseOptionIndex = callingParticipant
        ? callingParticipant.participantId === duel.competitorAParticipantId
          ? responseA?.selectedOptionIndex ?? null
          : callingParticipant.participantId === duel.competitorBParticipantId
          ? responseB?.selectedOptionIndex ?? null
          : null
        : null;

      return {
        duelId: duel.duelId,
        competitorAParticipantId: duel.competitorAParticipantId,
        competitorBParticipantId: duel.competitorBParticipantId,
        promptText: duel.promptText,
        options: duel.options,
        lifecycleState: duel.lifecycleState,
        terminalResolution: duel.terminalResolution,
        winnerParticipantId: duel.winnerParticipantId,
        reason: duel.reason,
        startedAt: duel.startedAt,
        endedAt: duel.endedAt,
        myResponseOptionIndex,
        competitorAOptionIndex: revealed ? responseA?.selectedOptionIndex ?? null : null,
        competitorBOptionIndex: revealed ? responseB?.selectedOptionIndex ?? null : null,
      };
    })
  );
  const activeDuel = duelSummaries.find((d) => d.lifecycleState === "ACTIVE") ?? null;

  return {
    sessionId: session.sessionId,
    state: session.state,
    stateVersion: session.stateVersion,
    participants: participants.map((participant) => ({
      participantId: participant.participantId,
      displayName: participant.displayName,
    })),
    interactionNumber,
    segmentNumber,
    interactionState: currentInteraction?.state ?? null,
    currentInteractionInstanceId: currentInteraction?.interactionInstanceId ?? null,
    currentEngineType: currentInteraction?.engineType ?? null,
    currentPrompt,
    submittedCount,
    eligibleParticipantCount,
    submissions,
    standings,
    preparedQuestions,
    successorSessionId,
    successorRoomCode,
    currentVotingCandidates,
    myVoteCandidateId,
    votingResults,
    questionProgress,
    currentQuiz,
    // Session Capability Architecture v1. Derived, not persisted
    // separately — capabilitiesLocked is computed from the same
    // participants list already fetched above, identically to
    // set_session_capabilities_atomically's own live evidence check,
    // so this is the same one source of truth, not a second one.
    declaredCapabilities: session.declaredCapabilities ?? [],
    capabilitiesLocked: participants.length > 0,
    legacyUndeclared: session.declaredCapabilities === null,
    activeDuel,
    duelHistory: duelSummaries,
  };
}
