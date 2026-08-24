import { NextResponse } from "next/server";
import { submitMathDuelAnswer } from "@/lib/session/submitMathDuelAnswer";
import { SupabaseSessionRepository } from "@/lib/session/db/supabaseSessionRepository";
import {
  DuelNotFoundError,
  DuelNotActiveError,
  DuelAccessDeniedError,
  InvalidMathDuelOrdinalError,
  InvalidMathDuelAnswerError,
  MathDuelChallengesExhaustedError,
} from "@/lib/session/types";

/**
 * POST /api/sessions/[identifier]/duel/submit-math-answer —
 * SUBMIT_MATH_DUEL_ANSWER
 *
 * Math Duel Slice 001. Participant-authenticated only, via
 * Authorization: Bearer — mirrors respond/route.ts's own convention
 * exactly, no host fallback. A separate route from /duel/respond
 * (Multiple Choice's own submission), not a shared one: the action
 * semantics genuinely differ (a challenge ordinal instead of an option
 * index, first-write-wins instead of upsert) — earning its own
 * command per Duel_Architecture.md's own "Duel Container vs.
 * Mechanic" rule, exactly as implementation-readiness concluded.
 */
export async function POST(
  request: Request,
  { params }: { params: { identifier: string } }
) {
  void params.identifier;

  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseServiceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !supabaseServiceKey) {
    return NextResponse.json(
      { error: "Server misconfiguration: Supabase credentials not set." },
      { status: 500 }
    );
  }

  const authHeader = request.headers.get("authorization");
  const bearerMatch = authHeader?.match(/^Bearer (.+)$/i);

  if (!bearerMatch) {
    return NextResponse.json(
      { error: "A Bearer token is required in the Authorization header." },
      { status: 401 }
    );
  }

  const participantToken = bearerMatch[1];

  let duelId: unknown;
  let challengeOrdinal: unknown;
  let submittedAnswer: unknown;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    duelId = body?.duelId;
    challengeOrdinal = body?.challengeOrdinal;
    submittedAnswer = body?.submittedAnswer;
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 }
    );
  }

  if (typeof duelId !== "string" || duelId.length === 0) {
    return NextResponse.json(
      { error: "duelId is required and must be a string." },
      { status: 400 }
    );
  }
  if (typeof challengeOrdinal !== "number") {
    return NextResponse.json(
      { error: "challengeOrdinal is required and must be a number." },
      { status: 400 }
    );
  }
  if (typeof submittedAnswer !== "number") {
    return NextResponse.json(
      { error: "submittedAnswer is required and must be a number." },
      { status: 400 }
    );
  }

  const repo = new SupabaseSessionRepository(supabaseUrl, supabaseServiceKey);

  try {
    const result = await submitMathDuelAnswer(
      repo,
      duelId,
      participantToken,
      challengeOrdinal,
      submittedAnswer
    );
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof DuelNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof DuelAccessDeniedError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof DuelNotActiveError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (
      err instanceof InvalidMathDuelOrdinalError ||
      err instanceof InvalidMathDuelAnswerError
    ) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    if (err instanceof MathDuelChallengesExhaustedError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }

    console.error("SUBMIT_MATH_DUEL_ANSWER failed:", err);
    return NextResponse.json(
      { error: "Failed to submit Math Duel answer." },
      { status: 500 }
    );
  }
}
