import { NextResponse } from "next/server";
import { confirmReadiness } from "@/lib/gaming/race/confirmReadiness";
import { SupabaseRaceRepository } from "@/lib/gaming/race/db/supabaseRaceRepository";
import { RaceEventNotFoundError, RaceInvalidTokenError, RaceScenarioNotFoundError } from "@/lib/gaming/race/types";

/**
 * POST /api/gaming/race/events/[raceEventId]/ready — CONFIRM_READINESS
 *
 * Authorization: Bearer <competitorToken>. When both competitors are
 * ready, the response's sharedStartAt carries the single future server
 * timestamp both clients must count down to.
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

  const repo = new SupabaseRaceRepository(supabaseUrl, supabaseServiceKey);

  try {
    const result = await confirmReadiness(repo, { raceEventId: params.raceEventId, competitorToken: bearerMatch[1] });
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
    console.error("CONFIRM_RACE_READINESS failed:", err);
    return NextResponse.json({ error: "Failed to confirm readiness." }, { status: 500 });
  }
}
