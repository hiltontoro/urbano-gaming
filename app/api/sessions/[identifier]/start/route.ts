import { NextResponse } from "next/server";
import { startSession } from "@/lib/session/startSession";
import { SupabaseSessionRepository } from "@/lib/session/db/supabaseSessionRepository";
import type {
  StartTurnConfig,
  VotingCandidateSource,
  SegmentTarget,
} from "@/lib/session/types";
import {
  SessionNotFoundError,
  HostTokenMismatchError,
  LobbyNotLockedError,
  PreviousInteractionNotRevealedError,
  NoCurrentSegmentToContinueError,
  EmptyPromptTextError,
  PromptTextTooLongError,
  PreparedQuestionNotFoundError,
  PreparedQuestionAlreadyConsumedError,
  InvalidVotingCandidatesError,
  VotingSourceInteractionNotFoundError,
  VotingSourceInteractionNotEligibleError,
  AmbiguousStartSessionTargetError,
  CapabilityNotAuthorizedError,
  ActiveDuelExistsError,
} from "@/lib/session/types";

/**
 * POST /api/sessions/[identifier]/start — START_SESSION
 *
 * Slice 001 (Session / Interaction separation): host-authenticated
 * only, re-invocable — callable once per interaction, any number of
 * times, as long as the session is LOBBY_LOCKED and its current
 * interaction instance (if any) is already RESULT_REVEAL.
 *
 * Slice 003 (Second Interaction Engine): a Multiple Choice interaction
 * selects from a specific, previously-authored prepared question.
 *
 * Slice 007 (Voting Engine): a Voting interaction is sourced from
 * either host-authored candidates or a prior interaction's submissions.
 *
 * Slice 008 (Segment / Turn grouping): an optional segmentTarget —
 * "NEW_SEGMENT" (default when omitted) or "CURRENT_SEGMENT" — selects
 * whether this Interaction Instance starts a new member-facing Turn or
 * joins the session's existing current one.
 *
 * Slice 009 (Engine Selection + PARTICIPANTS Voting): the request body
 * now carries a single structured `turnConfig` field, matching
 * StartTurnConfig exactly (see lib/session/types.ts) — a discriminated
 * union that makes "both a preparedQuestionId and a candidateSource"
 * structurally inexpressible. `turnConfig.candidateSource` also gains
 * a third member, { type: "PARTICIPANTS" }, sourcing Candidates from
 * the session's own roster.
 *
 * TEMPORARY COMPATIBILITY SHIM: when `turnConfig` is absent, the route
 * falls back to reconstructing an equivalent StartTurnConfig from the
 * previous flat fields (promptText / preparedQuestionId /
 * votingCandidateSource), exactly as every pre-Slice-009 caller already
 * sends them. This reconstruction is the one place
 * AmbiguousStartSessionTargetError is still checked at runtime — it is
 * parsing untyped JSON, so the two flat fields really can both be
 * present, unlike anywhere past this point. This shim is transitional:
 * it exists only to avoid breaking existing clients (host.html is
 * updated in this same slice to send `turnConfig` directly) and should
 * be removed once no caller depends on the legacy shape.
 *
 * The dynamic segment is named [identifier] for the same reason the
 * join/lock/complete/GET routes share it. Route is thin by design:
 * transport concerns only. All logic lives in startSession(), which is
 * transport-agnostic and unit-tested independent of this route.
 */
export async function POST(
  request: Request,
  { params }: { params: { identifier: string } }
) {
  const sessionId = params.identifier;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return NextResponse.json(
      { error: "Server misconfiguration: Supabase credentials not set." },
      { status: 500 }
    );
  }

  let hostToken: unknown;
  let turnConfig: unknown;
  let promptText: unknown;
  let preparedQuestionId: unknown;
  let votingCandidateSource: unknown;
  let segmentTarget: unknown;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    hostToken = body?.hostToken;
    turnConfig = body?.turnConfig;
    promptText = body?.promptText;
    preparedQuestionId = body?.preparedQuestionId;
    votingCandidateSource = body?.votingCandidateSource;
    segmentTarget = body?.segmentTarget;
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  if (typeof hostToken !== "string" || hostToken.length === 0) {
    return NextResponse.json(
      { error: "hostToken is required and must be a string." },
      { status: 400 }
    );
  }

  if (
    segmentTarget !== undefined &&
    segmentTarget !== null &&
    segmentTarget !== "NEW_SEGMENT" &&
    segmentTarget !== "CURRENT_SEGMENT"
  ) {
    return NextResponse.json(
      {
        error:
          'segmentTarget, if supplied, must be "NEW_SEGMENT" or "CURRENT_SEGMENT".',
      },
      { status: 400 }
    );
  }

  const normalizedSegmentTarget: SegmentTarget =
    segmentTarget === "CURRENT_SEGMENT" ? "CURRENT_SEGMENT" : "NEW_SEGMENT";

  // Slice 007/009: minimal shape validation only — deep validation
  // (candidate count/emptiness, source-interaction eligibility) is
  // startSession()'s and the repository's job, not the route's.
  function parseVotingCandidateSource(
    raw: unknown
  ): VotingCandidateSource | null {
    if (raw === undefined || raw === null) {
      return null;
    }
    const source = raw as Record<string, unknown>;
    if (
      source.type === "HOST_AUTHORED" &&
      Array.isArray(source.candidates) &&
      source.candidates.every((c) => typeof c === "string")
    ) {
      return { type: "HOST_AUTHORED", candidates: source.candidates as string[] };
    }
    if (
      source.type === "SUBMISSION" &&
      typeof source.sourceInteractionInstanceId === "string" &&
      source.sourceInteractionInstanceId.length > 0
    ) {
      return {
        type: "SUBMISSION",
        sourceInteractionInstanceId: source.sourceInteractionInstanceId,
      };
    }
    if (source.type === "PARTICIPANTS") {
      return { type: "PARTICIPANTS" };
    }
    return undefined as unknown as VotingCandidateSource; // sentinel: invalid shape
  }

  let normalizedConfig: StartTurnConfig;

  if (turnConfig !== undefined && turnConfig !== null) {
    // Preferred Slice 009 shape: turnConfig mirrors StartTurnConfig
    // directly, so the discriminant alone decides the branch — no
    // mutual-exclusivity check is needed here, since a caller sending
    // this shape can only ever populate one branch's fields.
    const cfg = turnConfig as Record<string, unknown>;

    if (cfg.engineType === "OPEN_RESPONSE") {
      if (typeof cfg.promptText !== "string") {
        return NextResponse.json(
          { error: "turnConfig.promptText is required and must be a string for OPEN_RESPONSE." },
          { status: 400 }
        );
      }
      normalizedConfig = { engineType: "OPEN_RESPONSE", promptText: cfg.promptText };
    } else if (cfg.engineType === "MULTIPLE_CHOICE") {
      if (
        typeof cfg.preparedQuestionId !== "string" ||
        cfg.preparedQuestionId.length === 0
      ) {
        return NextResponse.json(
          {
            error:
              "turnConfig.preparedQuestionId is required and must be a non-empty string for MULTIPLE_CHOICE.",
          },
          { status: 400 }
        );
      }
      normalizedConfig = {
        engineType: "MULTIPLE_CHOICE",
        preparedQuestionId: cfg.preparedQuestionId,
      };
    } else if (cfg.engineType === "VOTING") {
      if (typeof cfg.promptText !== "string") {
        return NextResponse.json(
          { error: "turnConfig.promptText is required and must be a string for VOTING." },
          { status: 400 }
        );
      }
      const candidateSource = parseVotingCandidateSource(cfg.candidateSource);
      if (!candidateSource) {
        return NextResponse.json(
          {
            error:
              'turnConfig.candidateSource must be { type: "HOST_AUTHORED", candidates: string[] }, { type: "SUBMISSION", sourceInteractionInstanceId: string }, or { type: "PARTICIPANTS" }.',
          },
          { status: 400 }
        );
      }
      normalizedConfig = {
        engineType: "VOTING",
        promptText: cfg.promptText,
        candidateSource,
      };
    } else {
      return NextResponse.json(
        {
          error:
            'turnConfig.engineType must be "OPEN_RESPONSE", "MULTIPLE_CHOICE", or "VOTING".',
        },
        { status: 400 }
      );
    }
  } else {
    // TEMPORARY COMPATIBILITY SHIM (legacy flat shape). See doc comment
    // above. AmbiguousStartSessionTargetError is checked here because,
    // unlike turnConfig above, these two fields are genuinely
    // independent optional inputs at this point in the parsing — both
    // being present is a real, reachable, invalid state.
    if (
      preparedQuestionId !== undefined &&
      preparedQuestionId !== null &&
      (typeof preparedQuestionId !== "string" || preparedQuestionId.length === 0)
    ) {
      return NextResponse.json(
        { error: "preparedQuestionId, if supplied, must be a non-empty string." },
        { status: 400 }
      );
    }

    const hasPreparedQuestionId =
      typeof preparedQuestionId === "string" && preparedQuestionId.length > 0;

    const normalizedVotingCandidateSource =
      parseVotingCandidateSource(votingCandidateSource);

    if (normalizedVotingCandidateSource === undefined) {
      return NextResponse.json(
        {
          error:
            'votingCandidateSource, if supplied, must be { type: "HOST_AUTHORED", candidates: string[] }, { type: "SUBMISSION", sourceInteractionInstanceId: string }, or { type: "PARTICIPANTS" }.',
        },
        { status: 400 }
      );
    }

    if (hasPreparedQuestionId && normalizedVotingCandidateSource) {
      const err = new AmbiguousStartSessionTargetError();
      return NextResponse.json({ error: err.message }, { status: 400 });
    }

    if (
      !hasPreparedQuestionId &&
      !normalizedVotingCandidateSource &&
      typeof promptText !== "string"
    ) {
      return NextResponse.json(
        {
          error:
            "promptText is required and must be a string, unless preparedQuestionId is supplied.",
        },
        { status: 400 }
      );
    }

    if (normalizedVotingCandidateSource && typeof promptText !== "string") {
      return NextResponse.json(
        { error: "promptText is required and must be a string for a Voting interaction." },
        { status: 400 }
      );
    }

    if (hasPreparedQuestionId) {
      normalizedConfig = {
        engineType: "MULTIPLE_CHOICE",
        preparedQuestionId: preparedQuestionId as string,
      };
    } else if (normalizedVotingCandidateSource) {
      normalizedConfig = {
        engineType: "VOTING",
        promptText: promptText as string,
        candidateSource: normalizedVotingCandidateSource,
      };
    } else {
      normalizedConfig = {
        engineType: "OPEN_RESPONSE",
        promptText: promptText as string,
      };
    }
  }

  const repo = new SupabaseSessionRepository(supabaseUrl, supabaseServiceKey);

  try {
    const result = await startSession(
      repo,
      sessionId,
      hostToken,
      normalizedConfig,
      normalizedSegmentTarget
    );
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof HostTokenMismatchError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof CapabilityNotAuthorizedError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof LobbyNotLockedError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof PreviousInteractionNotRevealedError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof ActiveDuelExistsError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof NoCurrentSegmentToContinueError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (
      err instanceof EmptyPromptTextError ||
      err instanceof PromptTextTooLongError
    ) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof PreparedQuestionNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof PreparedQuestionAlreadyConsumedError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof AmbiguousStartSessionTargetError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof InvalidVotingCandidatesError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof VotingSourceInteractionNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof VotingSourceInteractionNotEligibleError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }

    console.error("START_SESSION failed:", err);
    return NextResponse.json(
      { error: "Failed to start session." },
      { status: 500 }
    );
  }
}
