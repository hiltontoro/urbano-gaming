import { NextResponse } from "next/server";
import { getSupabaseCredentials, buildPredictionsRepo } from "@/lib/gaming/predictions/httpAuth";
import { getLeaderboard } from "@/lib/gaming/predictions/leaderboard";

// See matches/route.ts's identical comment: no dynamic segment, no
// request-object access, so this must be forced dynamic to avoid
// static prerendering hitting live Supabase during `next build`.
export const dynamic = "force-dynamic";

/**
 * GET /api/gaming/predictions/leaderboard — public: Predictions-
 * specific, pre-Persistent-Metagame progression ranking over the
 * legacy gaming_progression_events ledger, SUM(points) per Gaming
 * Member. NOT the canonical Global Gaming XP Leaderboard — see
 * lib/gaming/predictions/leaderboard.ts's own doc comment and
 * GET /api/gaming/leaderboard for that. No auth required — a
 * leaderboard is inherently public-facing.
 */
export async function GET() {
  // CLOSED BY DEFAULT, like GET /api/gaming/leaderboard: it opens only when GAMING_LEADERBOARD_PUBLIC is exactly "true"; otherwise it
  // answers a stable, empty body and reads neither credentials nor any ranking.
  if (process.env.GAMING_LEADERBOARD_PUBLIC !== "true") {
    return NextResponse.json({ leaderboard: [], available: false }, { headers: { "Cache-Control": "no-store" } });
  }

  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return NextResponse.json(
      { error: "Server misconfiguration: Supabase credentials not set." },
      { status: 500 }
    );
  }

  const repo = buildPredictionsRepo(credentials);
  const leaderboard = await getLeaderboard(repo);
  return NextResponse.json({ leaderboard });
}
