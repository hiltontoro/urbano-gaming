import { NextResponse } from "next/server";
import { getSupabaseCredentials, buildCompetitionsRepo, requireGamingMember, statusForCompetitionsError, requireCompetitionsSchemaReady } from "@/lib/gaming/competitions/httpAuth";
import { finalizeFixture } from "@/lib/gaming/competitions/finalizeFixture";

/** POST /api/gaming/competitions/fixtures/[fixtureId]/finalize — FINALIZE_FIXTURE. Organizer-only; idempotent on retry. */
export async function POST(request: Request, { params }: { params: { fixtureId: string } }) {
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
    const result = await finalizeFixture(repo, params.fixtureId, auth.gamingMemberId);
    return NextResponse.json({ result }, { status: result.alreadyFinalized ? 200 : 201 });
  } catch (err) {
    const status = statusForCompetitionsError(err);
    if (status) return NextResponse.json({ error: (err as Error).message }, { status });
    console.error("FINALIZE_FIXTURE failed:", err);
    return NextResponse.json({ error: "Failed to finalize fixture." }, { status: 500 });
  }
}
