import { NextResponse } from "next/server";
import { undoRaceMove } from "@/lib/gaming/race/undoMove";
import { SupabaseRaceRepository } from "@/lib/gaming/race/db/supabaseRaceRepository";
import { isValidIdempotencyKey } from "@/lib/gaming/race/idempotencyKey";
import {
  RaceEventAlreadyTerminalError,
  RaceEventNotFoundError,
  RaceIdempotencyKeyConflictError,
  RaceInvalidTokenError,
  RaceNotYetStartedError,
  RaceNothingToUndoError,
} from "@/lib/gaming/race/types";

/**
 * POST /api/gaming/race/events/[raceEventId]/undo — UNDO
 *
 * Authorization: Bearer <competitorToken>. Body: { idempotencyKey }.
 * Reverses only the caller's own most recent move, server-derived —
 * mirrors Towers' own UNDO contract exactly.
 */
export async function POST(request: Request, { params }: { params: { raceEventId: string } }) {
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
    return NextResponse.json({ error: "A Bearer token is required in the Authorization header." }, { status: 401 });
  }

  let body: any = {};
  try {
    body = await request.json();
  } catch {
    // handled by the validation below
  }

  const { idempotencyKey } = body ?? {};
  if (!isValidIdempotencyKey(idempotencyKey)) {
    return NextResponse.json({ error: "idempotencyKey must be a standard UUID string." }, { status: 400 });
  }

  const repo = new SupabaseRaceRepository(supabaseUrl, supabaseServiceKey);

  try {
    const result = await undoRaceMove(repo, {
      raceEventId: params.raceEventId,
      competitorToken: bearerMatch[1],
      idempotencyKey,
    });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof RaceEventNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof RaceInvalidTokenError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof RaceEventAlreadyTerminalError) {
      return NextResponse.json(
        { error: err.message, terminalResolution: err.terminalResolution },
        { status: 409 }
      );
    }
    if (err instanceof RaceNotYetStartedError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof RaceNothingToUndoError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof RaceIdempotencyKeyConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error("UNDO_RACE_MOVE failed:", err);
    return NextResponse.json({ error: "Failed to undo Race move." }, { status: 500 });
  }
}
