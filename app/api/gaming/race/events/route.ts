import { NextResponse } from "next/server";
import { createEvent } from "@/lib/gaming/race/createEvent";
import { SupabaseRaceRepository } from "@/lib/gaming/race/db/supabaseRaceRepository";
import { isValidIdempotencyKey } from "@/lib/gaming/race/idempotencyKey";
import { RaceIdempotencyKeyConflictError, RaceScenarioNotFoundError } from "@/lib/gaming/race/types";

/**
 * POST /api/gaming/race/events — CREATE_EVENT
 *
 * Body: { idempotencyKey, scenarioId, scenarioVersion }. Returns
 * { raceEventId, organizerToken, scenarioId, scenarioVersion }.
 * raceEventId is the semi-public join code; organizerToken is a
 * private bearer credential — the client that creates the event is
 * responsible for remembering both. No competitor slot is assigned by
 * this call. idempotencyKey is client-generated; a lost-response retry
 * with the same key returns the same event rather than creating a
 * second one.
 */
export async function POST(request: Request) {
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
  const scenarioId = body?.scenarioId;
  const scenarioVersion = body?.scenarioVersion;
  if (!isValidIdempotencyKey(idempotencyKey)) {
    return NextResponse.json(
      { error: "idempotencyKey must be a standard UUID string." },
      { status: 400 }
    );
  }
  if (typeof scenarioId !== "string" || typeof scenarioVersion !== "number") {
    return NextResponse.json(
      { error: "scenarioId (string) and scenarioVersion (number) are required." },
      { status: 400 }
    );
  }

  const repo = new SupabaseRaceRepository(supabaseUrl, supabaseServiceKey);

  try {
    const result = await createEvent(repo, { idempotencyKey, scenarioId, scenarioVersion });
    return NextResponse.json(result, { status: 201 });
  } catch (err) {
    if (err instanceof RaceScenarioNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    if (err instanceof RaceIdempotencyKeyConflictError) {
      return NextResponse.json({ error: err.message }, { status: 409 });
    }
    console.error("CREATE_RACE_EVENT failed:", err);
    return NextResponse.json({ error: "Failed to create Race event." }, { status: 500 });
  }
}
