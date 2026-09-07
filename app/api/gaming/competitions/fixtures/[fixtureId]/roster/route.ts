import { NextResponse } from "next/server";
import { getSupabaseCredentials, buildCompetitionsRepo, requireGamingMember, statusForCompetitionsError, requireCompetitionsSchemaReady } from "@/lib/gaming/competitions/httpAuth";
import { declareRoster } from "@/lib/gaming/competitions/declareRoster";

/** POST /api/gaming/competitions/fixtures/[fixtureId]/roster — DECLARE_ROSTER. Append-only revision; declaringGamingMemberId is always the verified caller's own. */
export async function POST(request: Request, { params }: { params: { fixtureId: string } }) {
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

  const { competitionTeamId, isOrganizerAction, reason, gamingMemberIds } = body;
  if (
    typeof competitionTeamId !== "string" ||
    !Array.isArray(gamingMemberIds) ||
    !gamingMemberIds.every((id) => typeof id === "string")
  ) {
    return NextResponse.json({ error: "Invalid roster payload." }, { status: 400 });
  }

  const repo = buildCompetitionsRepo(credentials);
  try {
    const result = await declareRoster(
      repo, params.fixtureId, competitionTeamId, auth.gamingMemberId,
      isOrganizerAction === true, typeof reason === "string" ? reason : null, gamingMemberIds
    );
    return NextResponse.json({ result }, { status: 201 });
  } catch (err) {
    const status = statusForCompetitionsError(err);
    if (status) return NextResponse.json({ error: (err as Error).message }, { status });
    console.error("DECLARE_ROSTER failed:", err);
    return NextResponse.json({ error: "Failed to declare roster." }, { status: 500 });
  }
}
