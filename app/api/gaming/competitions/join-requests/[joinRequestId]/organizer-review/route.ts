import { NextResponse } from "next/server";
import { getSupabaseCredentials, buildCompetitionsRepo, requireGamingMember, statusForCompetitionsError, requireCompetitionsSchemaReady } from "@/lib/gaming/competitions/httpAuth";
import { organizerReviewJoinRequest } from "@/lib/gaming/competitions/organizerReviewJoinRequest";

/** POST /api/gaming/competitions/join-requests/[joinRequestId]/organizer-review — the one-shot organizer review of an already-rejected request. */
export async function POST(request: Request, { params }: { params: { joinRequestId: string } }) {
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
  if (typeof reason !== "string") {
    return NextResponse.json({ error: "reason is required." }, { status: 400 });
  }

  const repo = buildCompetitionsRepo(credentials);
  try {
    const result = await organizerReviewJoinRequest(repo, params.joinRequestId, auth.gamingMemberId, decision, reason);
    return NextResponse.json({ result });
  } catch (err) {
    const status = statusForCompetitionsError(err);
    if (status) return NextResponse.json({ error: (err as Error).message }, { status });
    console.error("ORGANIZER_REVIEW_JOIN_REQUEST failed:", err);
    return NextResponse.json({ error: "Failed to review join request." }, { status: 500 });
  }
}
