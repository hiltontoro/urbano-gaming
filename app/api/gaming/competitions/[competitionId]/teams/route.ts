import { NextResponse } from "next/server";
import { getSupabaseCredentials, buildCompetitionsRepo, requireGamingMember, statusForCompetitionsError } from "@/lib/gaming/competitions/httpAuth";
import { addCompetitionTeam } from "@/lib/gaming/competitions/addCompetitionTeam";

/** POST /api/gaming/competitions/[competitionId]/teams — ADD_COMPETITION_TEAM. Organizer-only, DRAFT-only — enforced inside the RPC. */
export async function POST(request: Request, { params }: { params: { competitionId: string } }) {
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

  const { name, captainGamingMemberId } = body;
  if (typeof name !== "string" || typeof captainGamingMemberId !== "string") {
    return NextResponse.json({ error: "Invalid team payload." }, { status: 400 });
  }

  const repo = buildCompetitionsRepo(credentials);
  try {
    const team = await addCompetitionTeam(repo, params.competitionId, auth.gamingMemberId, name, captainGamingMemberId);
    return NextResponse.json({ team }, { status: 201 });
  } catch (err) {
    const status = statusForCompetitionsError(err);
    if (status) return NextResponse.json({ error: (err as Error).message }, { status });
    console.error("ADD_COMPETITION_TEAM failed:", err);
    return NextResponse.json({ error: "Failed to add team." }, { status: 500 });
  }
}
