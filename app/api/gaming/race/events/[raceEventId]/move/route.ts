import { NextResponse } from "next/server";
import { applyRaceMove } from "@/lib/gaming/race/applyMove";
import { SupabaseRaceRepository } from "@/lib/gaming/race/db/supabaseRaceRepository";
import { isValidIdempotencyKey } from "@/lib/gaming/race/idempotencyKey";
import {
  RaceEventAlreadyTerminalError,
  RaceEventNotFoundError,
  RaceIdempotencyKeyConflictError,
  RaceIllegalMoveError,
  RaceInvalidTokenError,
  RaceNotYetStartedError,
  RaceScenarioNotFoundError,
  RaceStaleAttemptStateError,
} from "@/lib/gaming/race/types";
import { requireRaceSchemaReady } from "@/lib/gaming/race/schemaAvailability";

/**
 * POST /api/gaming/race/events/[raceEventId]/move — APPLY_MOVE
 *
 * Authorization: Bearer <competitorToken>. Body: { fromTowerId,
 * toTowerId, idempotencyKey } — same client contract as Towers' own
 * MOVE_TOP_PIECE; the client never supplies which piece moves or any
 * attempt identity. A stale-state conflict (409) means the client's own
 * local copy of ITS OWN board is behind; it should re-read via GET and
 * retry.
 */
export async function POST(request: Request, { params }: { params: { raceEventId: string } }) {
  const unavailable = requireRaceSchemaReady();
  if (unavailable) return unavailable;

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

  const { fromTowerId, toTowerId, idempotencyKey } = body ?? {};
  if (typeof fromTowerId !== "string" || typeof toTowerId !== "string") {
    return NextResponse.json(
      { error: "fromTowerId (string) and toTowerId (string) are required." },
      { status: 400 }
    );
  }
  if (!isValidIdempotencyKey(idempotencyKey)) {
    return NextResponse.json({ error: "idempotencyKey must be a standard UUID string." }, { status: 400 });
  }

  const repo = new SupabaseRaceRepository(supabaseUrl, supabaseServiceKey);

  try {
    const result = await applyRaceMove(repo, {
      raceEventId: params.raceEventId,
      competitorToken: bearerMatch[1],
      fromTowerId,
      toTowerId,
      idempotencyKey,
    });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof RaceEventNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof RaceScenarioNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof RaceInvalidTokenError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    if (err instanceof RaceEventAlreadyTerminalError) {
      return NextResponse.json(
        { error: err.message, terminalResolution: err.terminalResolution, winnerSlot: err.winnerSlot },
        { status: 409 }
      );
    }
    if (err instanceof RaceNotYetStartedError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof RaceStaleAttemptStateError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof RaceIllegalMoveError) {
      return NextResponse.json({ error: err.message }, { status: 422 });
    }
    if (err instanceof RaceIdempotencyKeyConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error("APPLY_RACE_MOVE failed:", err);
    return NextResponse.json({ error: "Failed to apply Race move." }, { status: 500 });
  }
}
