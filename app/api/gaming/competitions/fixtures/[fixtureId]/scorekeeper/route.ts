import { NextResponse } from "next/server";
import { getSupabaseCredentials, buildCompetitionsRepo, requireGamingMember, statusForCompetitionsError } from "@/lib/gaming/competitions/httpAuth";
import { appointScorekeeper } from "@/lib/gaming/competitions/appointScorekeeper";

/** POST /api/gaming/competitions/fixtures/[fixtureId]/scorekeeper — APPOINT_SCOREKEEPER. Organizer-only; conflict-of-interest checked inside the RPC. */
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

  const { scorekeeperGamingMemberId } = body;
  if (typeof scorekeeperGamingMemberId !== "string") {
    return NextResponse.json({ error: "Invalid scorekeeper payload." }, { status: 400 });
  }

  const repo = buildCompetitionsRepo(credentials);
  try {
    const result = await appointScorekeeper(repo, params.fixtureId, auth.gamingMemberId, scorekeeperGamingMemberId);
    return NextResponse.json({ result });
  } catch (err) {
    const status = statusForCompetitionsError(err);
    if (status) return NextResponse.json({ error: (err as Error).message }, { status });
    console.error("APPOINT_SCOREKEEPER failed:", err);
    return NextResponse.json({ error: "Failed to appoint scorekeeper." }, { status: 500 });
  }
}
