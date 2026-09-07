import { NextResponse } from "next/server";
import { getSupabaseCredentials, buildCompetitionsRepo, requireGamingMember, statusForCompetitionsError, requireCompetitionsSchemaReady } from "@/lib/gaming/competitions/httpAuth";
import { requestJoinTeam } from "@/lib/gaming/competitions/requestJoinTeam";

/** POST /api/gaming/competitions/[competitionId]/join-requests — REQUEST_JOIN_TEAM. requestingGamingMemberId is always the verified caller's own. */
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

  const { competitionTeamId } = body;
  if (typeof competitionTeamId !== "string") {
    return NextResponse.json({ error: "Invalid join-request payload." }, { status: 400 });
  }

  const repo = buildCompetitionsRepo(credentials);
  try {
    const joinRequest = await requestJoinTeam(repo, params.competitionId, competitionTeamId, auth.gamingMemberId);
    return NextResponse.json({ joinRequest }, { status: 201 });
  } catch (err) {
    const status = statusForCompetitionsError(err);
    if (status) return NextResponse.json({ error: (err as Error).message }, { status });
    console.error("REQUEST_JOIN_TEAM failed:", err);
    return NextResponse.json({ error: "Failed to request to join team." }, { status: 500 });
  }
}
