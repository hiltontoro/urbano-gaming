import { NextResponse } from "next/server";
import { getSupabaseCredentials, buildCompetitionsRepo, requireGamingMember, statusForCompetitionsError, requireCompetitionsSchemaReady } from "@/lib/gaming/competitions/httpAuth";
import { proposeCompetitionTeam } from "@/lib/gaming/competitions/proposeCompetitionTeam";

/**
 * POST /api/gaming/competitions/[competitionId]/teams/propose —
 * PROPOSE_COMPETITION_TEAM. The member entry path (accepted decisions
 * §4/§5/§9) — distinct from the organizer-only POST .../teams route.
 * The body accepts only { name }; the proposer/proposed-captain identity
 * is always the verified caller's own gamingMemberId — this route never
 * accepts a captainGamingMemberId, organizer id, status, or approval
 * field from the client.
 */
export async function POST(request: Request, { params }: { params: { competitionId: string } }) {
  const unavailable = requireCompetitionsSchemaReady();
  if (unavailable) return unavailable;

  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return NextResponse.json({ error: "Server misconfiguration: Supabase credentials not set." }, { status: 500 });
  }
  const auth = await requireGamingMember(request, credentials);
  if ("errorResponse" in auth) return auth.errorResponse;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const { name } = body;
  if (typeof name !== "string" || name.trim().length === 0) {
    return NextResponse.json({ error: "A team name is required." }, { status: 400 });
  }

  const repo = buildCompetitionsRepo(credentials);
  try {
    const team = await proposeCompetitionTeam(repo, params.competitionId, name, auth.gamingMemberId);
    return NextResponse.json({ team }, { status: 201 });
  } catch (err) {
    const status = statusForCompetitionsError(err);
    if (status) return NextResponse.json({ error: (err as Error).message }, { status });
    console.error("PROPOSE_COMPETITION_TEAM failed:", err);
    return NextResponse.json({ error: "Failed to propose team." }, { status: 500 });
  }
}
