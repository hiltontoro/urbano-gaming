import { NextResponse } from "next/server";
import { startQuiz } from "@/lib/session/startQuiz";
import { SupabaseSessionRepository } from "@/lib/session/db/supabaseSessionRepository";
import {
  SessionNotFoundError,
  HostTokenMismatchError,
  LobbyNotLockedError,
  PreviousInteractionNotRevealedError,
  EmptyQuizQuestionSetError,
  InvalidQuizDurationError,
  CapabilityNotAuthorizedError,
  ActiveDuelExistsError,
} from "@/lib/session/types";

/**
 * POST /api/sessions/[identifier]/start-quiz — START_QUIZ
 *
 * Quiz Experience (self-paced, independent participant progression —
 * distinct from Trivia). Host-authenticated only. Dedicated route, not
 * a variant of /start — see startQuiz.ts's own comment for why this
 * platform's implementation-readiness design chose a dedicated command
 * rather than generalizing START_SESSION.
 *
 * Route is thin by design, mirroring every other command route in this
 * app: header/body extraction only. All logic lives in startQuiz(),
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
  let durationSeconds: unknown;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    hostToken = body?.hostToken;
    durationSeconds = body?.durationSeconds;
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

  if (typeof durationSeconds !== "number") {
    return NextResponse.json(
      { error: "durationSeconds is required and must be a number." },
      { status: 400 }
    );
  }

  const repo = new SupabaseSessionRepository(supabaseUrl, supabaseServiceKey);

  try {
    const result = await startQuiz(repo, sessionId, hostToken, durationSeconds);
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
    if (
      err instanceof LobbyNotLockedError ||
      err instanceof PreviousInteractionNotRevealedError ||
      err instanceof ActiveDuelExistsError
    ) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (
      err instanceof EmptyQuizQuestionSetError ||
      err instanceof InvalidQuizDurationError
    ) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }

    console.error("START_QUIZ failed:", err);
    return NextResponse.json({ error: "Failed to start Quiz." }, { status: 500 });
  }
}
