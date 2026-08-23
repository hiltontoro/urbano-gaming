import { NextResponse } from "next/server";
import { startDuel } from "@/lib/session/startDuel";
import { SupabaseSessionRepository } from "@/lib/session/db/supabaseSessionRepository";
import {
  SessionNotFoundError,
  HostTokenMismatchError,
  LobbyNotLockedError,
  CapabilityNotAuthorizedError,
  DuplicateDuelCompetitorError,
  DuelCompetitorNotInSessionError,
  InteractionActiveError,
  ActiveDuelExistsError,
  InvalidDuelOptionsError,
} from "@/lib/session/types";

/**
 * POST /api/sessions/[identifier]/duel/start — START_DUEL
 *
 * Duel / SESSION_SUBGAME v1 (Product/Duel_Architecture.md). Host-
 * authenticated only, via body hostToken — mirrors complete/route.ts's
 * own convention exactly. Route is thin by design: transport concerns
 * only. All logic lives in startDuel(), transport-agnostic and
 * unit-tested independent of this route.
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
  let competitorAParticipantId: unknown;
  let competitorBParticipantId: unknown;
  let promptText: unknown;
  let options: unknown;
  let correctOptionIndex: unknown;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    hostToken = body?.hostToken;
    competitorAParticipantId = body?.competitorAParticipantId;
    competitorBParticipantId = body?.competitorBParticipantId;
    promptText = body?.promptText;
    options = body?.options;
    correctOptionIndex = body?.correctOptionIndex;
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
    typeof competitorAParticipantId !== "string" ||
    typeof competitorBParticipantId !== "string"
  ) {
    return NextResponse.json(
      {
        error:
          "competitorAParticipantId and competitorBParticipantId are required and must be strings.",
      },
      { status: 400 }
    );
  }
  if (typeof promptText !== "string") {
    return NextResponse.json(
      { error: "promptText is required and must be a string." },
      { status: 400 }
    );
  }
  if (
    !Array.isArray(options) ||
    !options.every((o) => typeof o === "string")
  ) {
    return NextResponse.json(
      { error: "options is required and must be an array of strings." },
      { status: 400 }
    );
  }
  if (typeof correctOptionIndex !== "number") {
    return NextResponse.json(
      { error: "correctOptionIndex is required and must be a number." },
      { status: 400 }
    );
  }

  const repo = new SupabaseSessionRepository(supabaseUrl, supabaseServiceKey);

  try {
    const result = await startDuel(
      repo,
      sessionId,
      hostToken,
      competitorAParticipantId,
      competitorBParticipantId,
      promptText,
      options as string[],
      correctOptionIndex
    );
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof HostTokenMismatchError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (
      err instanceof LobbyNotLockedError ||
      err instanceof CapabilityNotAuthorizedError ||
      err instanceof InteractionActiveError ||
      err instanceof ActiveDuelExistsError
    ) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (
      err instanceof DuplicateDuelCompetitorError ||
      err instanceof DuelCompetitorNotInSessionError ||
      err instanceof InvalidDuelOptionsError
    ) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }

    console.error("START_DUEL failed:", err);
    return NextResponse.json(
      { error: "Failed to start Duel." },
      { status: 500 }
    );
  }
}
