import { NextResponse } from "next/server";
import { getSupabaseCredentials, buildCompetitionsRepo, requireGamingMember, statusForCompetitionsError, requireCompetitionsSchemaReady } from "@/lib/gaming/competitions/httpAuth";
import { openTeamRegistration } from "@/lib/gaming/competitions/openTeamRegistration";

/** POST /api/gaming/competitions/[competitionId]/open-team-registration — OPEN_TEAM_REGISTRATION. Organizer-only, DRAFT-only — enforced inside the RPC. */
export async function POST(request: Request, { params }: { params: { competitionId: string } }) {
  const unavailable = requireCompetitionsSchemaReady();
  if (unavailable) return unavailable;

  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return NextResponse.json({ error: "Server misconfiguration: Supabase credentials not set." }, { status: 500 });
  }
  const auth = await requireGamingMember(request, credentials);
  if ("errorResponse" in auth) return auth.errorResponse;

  const repo = buildCompetitionsRepo(credentials);
  try {
    const result = await openTeamRegistration(repo, params.competitionId, auth.gamingMemberId);
    return NextResponse.json({ result });
  } catch (err) {
    const status = statusForCompetitionsError(err);
    if (status) return NextResponse.json({ error: (err as Error).message }, { status });
    console.error("OPEN_TEAM_REGISTRATION failed:", err);
    return NextResponse.json({ error: "Failed to open team registration." }, { status: 500 });
  }
}
