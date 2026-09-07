import { NextResponse } from "next/server";
import { getSupabaseCredentials, buildCompetitionsRepo, requireGamingMember, statusForCompetitionsError, requireCompetitionsSchemaReady } from "@/lib/gaming/competitions/httpAuth";
import { checkIn } from "@/lib/gaming/competitions/checkIn";

/** POST /api/gaming/competitions/fixtures/[fixtureId]/checkin — CHECK_IN. gamingMemberId is always the verified caller's own. */
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
    const result = await checkIn(repo, params.fixtureId, auth.gamingMemberId);
    return NextResponse.json({ result }, { status: result.alreadyCheckedIn ? 200 : 201 });
  } catch (err) {
    const status = statusForCompetitionsError(err);
    if (status) return NextResponse.json({ error: (err as Error).message }, { status });
    console.error("CHECK_IN failed:", err);
    return NextResponse.json({ error: "Failed to check in." }, { status: 500 });
  }
}
