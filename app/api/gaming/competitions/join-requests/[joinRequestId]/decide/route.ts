import { NextResponse } from "next/server";
import { getSupabaseCredentials, buildCompetitionsRepo, requireGamingMember, statusForCompetitionsError } from "@/lib/gaming/competitions/httpAuth";
import { decideJoinRequest } from "@/lib/gaming/competitions/decideJoinRequest";

/**
 * POST /api/gaming/competitions/join-requests/[joinRequestId]/decide —
 * DECIDE_JOIN_REQUEST. Actor is the deciding Gaming Member — the RPC
 * itself determines whether they are the target team's captain or an
 * organizer override; isOrganizerOverride is the caller's own claim,
 * re-verified server-side inside the RPC, never trusted at face value.
 */
export async function POST(request: Request, { params }: { params: { joinRequestId: string } }) {
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

  const { decision, isOrganizerOverride } = body;
  if (decision !== "APPROVE" && decision !== "REJECT") {
    return NextResponse.json({ error: "decision must be APPROVE or REJECT." }, { status: 400 });
  }

  const repo = buildCompetitionsRepo(credentials);
  try {
    const result = await decideJoinRequest(repo, params.joinRequestId, auth.gamingMemberId, decision, isOrganizerOverride === true);
    return NextResponse.json({ result });
  } catch (err) {
    const status = statusForCompetitionsError(err);
    if (status) return NextResponse.json({ error: (err as Error).message }, { status });
    console.error("DECIDE_JOIN_REQUEST failed:", err);
    return NextResponse.json({ error: "Failed to decide join request." }, { status: 500 });
  }
}
