import { NextResponse } from "next/server";
import { requestRaceCancellation } from "@/lib/gaming/race/requestCancellation";
import { SupabaseRaceRepository } from "@/lib/gaming/race/db/supabaseRaceRepository";
import { isValidIdempotencyKey } from "@/lib/gaming/race/idempotencyKey";
import {
  RaceEventNotFoundError,
  RaceIdempotencyKeyConflictError,
  RaceInvalidTokenError,
  RaceOrganizerCannotCancelAfterCountdownError,
} from "@/lib/gaming/race/types";
import { requireRaceSchemaReady } from "@/lib/gaming/race/schemaAvailability";

/**
 * POST /api/gaming/race/events/[raceEventId]/cancel — REQUEST_CANCELLATION
 *
 * Authorization: Bearer <organizerToken | competitorToken>. Body:
 * { idempotencyKey }. Before the countdown is scheduled, the
 * organizer's own token cancels immediately. After scheduling, only a
 * matching pair of competitor requests terminalizes the event; an
 * organizer-only request in that phase is rejected (409) — no
 * independent administrative cancellation surface in Slice 001. A
 * retry with the same idempotencyKey replays the exact original
 * response rather than duplicating evidence.
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

  const idempotencyKey = body?.idempotencyKey;
  if (!isValidIdempotencyKey(idempotencyKey)) {
    return NextResponse.json({ error: "idempotencyKey must be a standard UUID string." }, { status: 400 });
  }

  const repo = new SupabaseRaceRepository(supabaseUrl, supabaseServiceKey);

  try {
    const result = await requestRaceCancellation(repo, {
      raceEventId: params.raceEventId,
      callerToken: bearerMatch[1],
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
    if (err instanceof RaceOrganizerCannotCancelAfterCountdownError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof RaceIdempotencyKeyConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error("REQUEST_RACE_CANCELLATION failed:", err);
    return NextResponse.json({ error: "Failed to request Race cancellation." }, { status: 500 });
  }
}
