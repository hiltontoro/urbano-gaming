import { NextResponse } from "next/server";
import { getRaceEventProjection } from "@/lib/gaming/race/getProjection";
import { SupabaseRaceRepository } from "@/lib/gaming/race/db/supabaseRaceRepository";
import { RaceEventNotFoundError } from "@/lib/gaming/race/types";

/**
 * GET /api/gaming/race/events/[raceEventId] — GET_PROJECTION
 *
 * Authorization is OPTIONAL here (unlike Poker's GET_TABLE_STATE):
 * anyone with the race_event_id (the semi-public join code) may read
 * the coarse pre-join state (are slots open?) with no bearer token. A
 * Bearer organizerToken/competitorToken in the Authorization header
 * additionally unlocks the role-appropriate "you" view — for a
 * competitor, exactly their own board and never the opponent's, in
 * every lifecycle phase. This route also lazily enacts readiness/
 * running expiry (via the repository's own atomic projection read), so
 * a reload/poll after a deadline surfaces the terminal state without
 * requiring a move first.
 */
export async function GET(request: Request, { params }: { params: { raceEventId: string } }) {
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
  const callerToken = bearerMatch ? bearerMatch[1] : null;

  const repo = new SupabaseRaceRepository(supabaseUrl, supabaseServiceKey);

  try {
    const result = await getRaceEventProjection(repo, { raceEventId: params.raceEventId, callerToken });
    return NextResponse.json(result, { status: 200 });
  } catch (err) {
    if (err instanceof RaceEventNotFoundError) {
      return NextResponse.json({ error: err.message }, { status: 404 });
    }
    console.error("GET_RACE_EVENT_PROJECTION failed:", err);
    return NextResponse.json({ error: "Failed to read Race event." }, { status: 500 });
  }
}
