import { NextResponse } from "next/server";
import { getSupabaseCredentials, buildCompetitionsRepo, requireGamingMember, statusForCompetitionsError } from "@/lib/gaming/competitions/httpAuth";
import { forfeitFixture } from "@/lib/gaming/competitions/forfeitFixture";

/** POST /api/gaming/competitions/fixtures/[fixtureId]/forfeit — FORFEIT_FIXTURE. Organizer-only, reason required; idempotent on retry. */
export async function POST(request: Request, { params }: { params: { fixtureId: string } }) {
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

  const { forfeitingCompetitionTeamId, reason } = body;
  if (typeof forfeitingCompetitionTeamId !== "string" || typeof reason !== "string") {
    return NextResponse.json({ error: "Invalid forfeit payload." }, { status: 400 });
  }

  const repo = buildCompetitionsRepo(credentials);
  try {
    const result = await forfeitFixture(repo, params.fixtureId, auth.gamingMemberId, forfeitingCompetitionTeamId, reason);
    return NextResponse.json({ result }, { status: result.alreadyFinalized ? 200 : 201 });
  } catch (err) {
    const status = statusForCompetitionsError(err);
    if (status) return NextResponse.json({ error: (err as Error).message }, { status });
    console.error("FORFEIT_FIXTURE failed:", err);
    return NextResponse.json({ error: "Failed to forfeit fixture." }, { status: 500 });
  }
}
