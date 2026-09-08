import { NextResponse } from "next/server";
import { getSupabaseCredentials, buildCompetitionsRepo, requireGamingMember, statusForCompetitionsError, requireCompetitionsSchemaReady } from "@/lib/gaming/competitions/httpAuth";
import { decideCompetitionTeam } from "@/lib/gaming/competitions/decideCompetitionTeam";

/**
 * POST /api/gaming/competitions/teams/[teamId]/decide —
 * DECIDE_COMPETITION_TEAM. Organizer-only — re-verified inside the RPC,
 * never trusted from the caller. On REJECT, `reason` is required. The
 * client never supplies a status, decision timestamp, or membership id —
 * every one of those is server-derived inside the atomic RPC.
 */
export async function POST(request: Request, { params }: { params: { teamId: string } }) {
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

  const { decision, reason } = body;
  if (decision !== "APPROVE" && decision !== "REJECT") {
    return NextResponse.json({ error: "decision must be APPROVE or REJECT." }, { status: 400 });
  }
  if (decision === "REJECT" && typeof reason !== "string") {
    return NextResponse.json({ error: "reason is required to reject a team proposal." }, { status: 400 });
  }

  const repo = buildCompetitionsRepo(credentials);
  try {
    const result = await decideCompetitionTeam(repo, params.teamId, auth.gamingMemberId, decision, typeof reason === "string" ? reason : null);
    return NextResponse.json({ result });
  } catch (err) {
    const status = statusForCompetitionsError(err);
    if (status) return NextResponse.json({ error: (err as Error).message }, { status });
    console.error("DECIDE_COMPETITION_TEAM failed:", err);
    return NextResponse.json({ error: "Failed to decide team proposal." }, { status: 500 });
  }
}
