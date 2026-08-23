import { NextResponse } from "next/server";
import { submitDuelResponse } from "@/lib/session/submitDuelResponse";
import { SupabaseSessionRepository } from "@/lib/session/db/supabaseSessionRepository";
import {
  DuelNotFoundError,
  DuelNotActiveError,
  DuelAccessDeniedError,
  InvalidDuelOptionSelectionError,
} from "@/lib/session/types";

/**
 * POST /api/sessions/[identifier]/duel/respond — SUBMIT_DUEL_RESPONSE
 *
 * Duel / SESSION_SUBGAME v1. Participant-authenticated only, via
 * Authorization: Bearer — mirrors submit/route.ts's own convention
 * exactly, no host fallback. The session identifier in the URL is not
 * itself used by the command (a Duel is looked up by its own id) but
 * is kept for route-family consistency with every other Session route.
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
  let selectedOptionIndex: unknown;
  try {
    const body = (await request.json()) as Record<string, unknown>;
    duelId = body?.duelId;
    selectedOptionIndex = body?.selectedOptionIndex;
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
  if (typeof selectedOptionIndex !== "number") {
    return NextResponse.json(
      { error: "selectedOptionIndex is required and must be a number." },
      { status: 400 }
    );
  }

  const repo = new SupabaseSessionRepository(supabaseUrl, supabaseServiceKey);

  try {
    const result = await submitDuelResponse(
      repo,
      duelId,
      participantToken,
      selectedOptionIndex
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
    if (err instanceof InvalidDuelOptionSelectionError) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }

    console.error("SUBMIT_DUEL_RESPONSE failed:", err);
    return NextResponse.json(
      { error: "Failed to submit Duel response." },
      { status: 500 }
    );
  }
}
