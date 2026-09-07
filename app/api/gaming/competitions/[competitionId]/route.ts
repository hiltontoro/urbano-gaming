import { NextResponse } from "next/server";
import { getSupabaseCredentials, buildCompetitionsRepo, requireGamingMember, statusForCompetitionsError, requireCompetitionsSchemaReady } from "@/lib/gaming/competitions/httpAuth";
import { getCompetitionView } from "@/lib/gaming/competitions/getCompetitionView";

export const dynamic = "force-dynamic";

/** GET /api/gaming/competitions/[competitionId] — the one role-aware projection every journey reads through. */
export async function GET(request: Request, { params }: { params: { competitionId: string } }) {
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
    const view = await getCompetitionView(repo, params.competitionId, auth.gamingMemberId);
    return NextResponse.json({ view });
  } catch (err) {
    const status = statusForCompetitionsError(err);
    if (status) return NextResponse.json({ error: (err as Error).message }, { status });
    console.error("GET_COMPETITION_VIEW failed:", err);
    return NextResponse.json({ error: "Failed to load competition." }, { status: 500 });
  }
}
