import { NextResponse } from "next/server";
import { getSupabaseCredentials, buildCompetitionsRepo, requireGamingMember, statusForCompetitionsError, requireCompetitionsSchemaReady } from "@/lib/gaming/competitions/httpAuth";
import { voidFixture } from "@/lib/gaming/competitions/voidFixture";

/** POST /api/gaming/competitions/fixtures/[fixtureId]/void — VOID_FIXTURE. Organizer-only, reason required; immediately cancels the whole competition. */
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

  const { reason } = body;
  if (typeof reason !== "string") {
    return NextResponse.json({ error: "reason is required." }, { status: 400 });
  }

  const repo = buildCompetitionsRepo(credentials);
  try {
    const result = await voidFixture(repo, params.fixtureId, auth.gamingMemberId, reason);
    return NextResponse.json({ result }, { status: result.alreadyFinalized ? 200 : 201 });
  } catch (err) {
    const status = statusForCompetitionsError(err);
    if (status) return NextResponse.json({ error: (err as Error).message }, { status });
    console.error("VOID_FIXTURE failed:", err);
    return NextResponse.json({ error: "Failed to void fixture." }, { status: 500 });
  }
}
