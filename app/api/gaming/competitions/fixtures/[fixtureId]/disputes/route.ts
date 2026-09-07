import { NextResponse } from "next/server";
import { getSupabaseCredentials, buildCompetitionsRepo, requireGamingMember, statusForCompetitionsError } from "@/lib/gaming/competitions/httpAuth";
import { raiseDispute } from "@/lib/gaming/competitions/raiseDispute";

/** POST /api/gaming/competitions/fixtures/[fixtureId]/disputes — RAISE_DISPUTE. Never itself changes a fact — only requests organizer review. */
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

  const { targetFactType, targetFactId, reason } = body;
  if (typeof targetFactType !== "string" || typeof targetFactId !== "string" || typeof reason !== "string") {
    return NextResponse.json({ error: "Invalid dispute payload." }, { status: 400 });
  }

  const repo = buildCompetitionsRepo(credentials);
  try {
    const dispute = await raiseDispute(repo, params.fixtureId, auth.gamingMemberId, targetFactType, targetFactId, reason);
    return NextResponse.json({ dispute }, { status: 201 });
  } catch (err) {
    const status = statusForCompetitionsError(err);
    if (status) return NextResponse.json({ error: (err as Error).message }, { status });
    console.error("RAISE_DISPUTE failed:", err);
    return NextResponse.json({ error: "Failed to raise dispute." }, { status: 500 });
  }
}
