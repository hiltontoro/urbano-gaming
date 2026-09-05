import { NextResponse } from "next/server";
import { joinEvent } from "@/lib/gaming/race/joinEvent";
import { SupabaseRaceRepository } from "@/lib/gaming/race/db/supabaseRaceRepository";
import { isValidIdempotencyKey } from "@/lib/gaming/race/idempotencyKey";
import { RaceEventFullError, RaceEventNotFoundError, RaceIdempotencyKeyConflictError } from "@/lib/gaming/race/types";

/**
 * POST /api/gaming/race/events/[raceEventId]/join — JOIN_EVENT
 *
 * Body: { idempotencyKey }. No auth required to attempt joining —
 * race_event_id itself is the join code. Claims the next open
 * competitor slot (A, then B); rejects with 409 once both are filled or
 * the event has ended. Returns a fresh private competitorToken for the
 * claimed slot. idempotencyKey is client-generated; a lost-response
 * retry with the same key returns the same slot/token — it can never
 * consume the other slot.
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
    const result = await joinEvent(repo, { raceEventId: params.raceEventId, idempotencyKey });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof RaceEventNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof RaceEventFullError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    if (err instanceof RaceIdempotencyKeyConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error("JOIN_RACE_EVENT failed:", err);
    return NextResponse.json({ error: "Failed to join Race event." }, { status: 500 });
  }
}
