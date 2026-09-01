import { NextResponse } from "next/server";
import { startAttempt } from "@/lib/gaming/rutas/startAttempt";
import { SupabaseRutasRepository } from "@/lib/gaming/rutas/db/supabaseRutasRepository";
import { RutasScenarioNotFoundError } from "@/lib/gaming/rutas/types";

/**
 * POST /api/gaming/rutas/attempts — START_ATTEMPT
 *
 * No Host, no Participant, no room code, no auth token — BOUNDED_GAME_
 * RUNTIME, addressed directly by attemptId (the id itself is the
 * capability, exactly as a single-player attempt with no adversarial
 * second party needs — see the Slice 001 closure gate's runtime-
 * classification finding).
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
    // no body is fine — scenarioId/scenarioVersion have no default here,
    // so this will surface as a 400 below instead of a parse error.
  }

  const scenarioId = body?.scenarioId;
  const scenarioVersion = body?.scenarioVersion;
  if (typeof scenarioId !== "string" || typeof scenarioVersion !== "number") {
    return NextResponse.json(
      { error: "scenarioId (string) and scenarioVersion (number) are required." },
      { status: 400 }
    );
  }

  const repo = new SupabaseRutasRepository(supabaseUrl, supabaseServiceKey);

  try {
    const result = await startAttempt(repo, { scenarioId, scenarioVersion });
    return NextResponse.json(result.attempt, { status: 201 });
  } catch (err) {
    if (err instanceof RutasScenarioNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    console.error("START_ATTEMPT failed:", err);
    return NextResponse.json({ error: "Failed to start Rutas attempt." }, { status: 500 });
  }
}
