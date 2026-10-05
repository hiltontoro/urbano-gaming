import { NextResponse } from "next/server";
import { getSupabaseCredentials, buildCompetitionsRepo, requireCompetitionsSchemaReady } from "@/lib/gaming/competitions/httpAuth";
import { resolveCompetitionByPublicCode } from "@/lib/gaming/competitions/resolveCompetitionByPublicCode";
import { resolveCompetitionTeamByPublicCode } from "@/lib/gaming/competitions/resolveCompetitionTeamByPublicCode";

export const dynamic = "force-dynamic";

/**
 * GET /api/gaming/competitions/resolve?c=<competitionPublicCode>&t=<teamPublicCode>
 * (UG-CR-GATE-081 Phase 3A) — the one deliberately UNAUTHENTICATED
 * Competitions read besides the existing invitation-preview route,
 * which it exists to feed: a visitor's browser (signed in or not) only
 * ever holds an opaque public_code (never the real competitionId/
 * competitionTeamId), and this route is the single place that turns one
 * back into the real id(s) the rest of this domain's existing,
 * already-authorized routes expect. It never returns anything else, and
 * it grants nothing by itself — exactly like the existing invitation-
 * preview route one step later in the same chain (UG-CR-RPT-041/042
 * §8/§9/§10, "invitations are navigation, not authority"), every
 * subsequent read or write independently re-authenticates and
 * re-authorizes, regardless of whether a given public_code is ever
 * guessed.
 *
 * `c` alone resolves the ordinary (non-invitation) competition
 * navigation case. `c` + `t` together resolve an invitation link.
 * `t` without `c` is rejected — an invitation always carries both,
 * mirroring competitionsIntent.js's own existing teamId-only-alongside-
 * competitionId rule.
 */
export async function GET(request: Request) {
  const unavailable = requireCompetitionsSchemaReady();
  if (unavailable) return unavailable;

  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return NextResponse.json({ error: "Server misconfiguration: Supabase credentials not set." }, { status: 500 });
  }

  const { searchParams } = new URL(request.url);
  const competitionCode = searchParams.get("c");
  const teamCode = searchParams.get("t");

  if (!competitionCode || typeof competitionCode !== "string") {
    return NextResponse.json({ error: "A competition code is required." }, { status: 400 });
  }

  const repo = buildCompetitionsRepo(credentials);
  try {
    if (teamCode) {
      const resolved = await resolveCompetitionTeamByPublicCode(repo, competitionCode, teamCode);
      return NextResponse.json({ competitionId: resolved.competitionId, teamId: resolved.competitionTeamId });
    }
    const resolved = await resolveCompetitionByPublicCode(repo, competitionCode);
    return NextResponse.json({ competitionId: resolved.competitionId });
  } catch {
    // Deliberately generic and uniform on any mismatch (unknown code,
    // unknown pairing, malformed input) — mirrors invitation-preview's
    // own "fabricated/mismatched pair fails safely" convention, and
    // never discloses which half of a pair was the problem.
    return NextResponse.json({ error: "This link is no longer valid." }, { status: 404 });
  }
}
