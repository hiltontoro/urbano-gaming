import { NextResponse } from "next/server";
import { getSupabaseCredentials, buildCompetitionsRepo, requireGamingMember, statusForCompetitionsError, requireCompetitionsSchemaReady } from "@/lib/gaming/competitions/httpAuth";
import { cancelCompetition } from "@/lib/gaming/competitions/cancelCompetition";

/**
 * POST /api/gaming/competitions/[competitionId]/cancel — CANCEL_
 * INCOMPLETE_COMPETITION (UG-CR-GATE-081 Phase 3E). Organizer-only,
 * DRAFT/TEAM_REGISTRATION_OPEN/READY_TO_PUBLISH-only, reason required —
 * every check enforced inside the atomic RPC, never only here.
 * organizerGamingMemberId is always the verified caller's own, never
 * accepted from the body, matching every other organizer-only route in
 * this domain.
 */
export async function POST(request: Request, { params }: { params: { competitionId: string } }) {
  const unavailable = requireCompetitionsSchemaReady();
  if (unavailable) return unavailable;

  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return NextResponse.json({ error: "Server misconfiguration: Supabase credentials not set." }, { status: 500 });
  }
  const auth = await requireGamingMember(request, credentials);
  if ("errorResponse" in auth) return auth.errorResponse;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }
  const { reason } = (body ?? {}) as { reason?: unknown };
  if (typeof reason !== "string" || reason.trim().length === 0) {
    return NextResponse.json({ error: "A reason is required to cancel a competition." }, { status: 400 });
  }

  const repo = buildCompetitionsRepo(credentials);
  try {
    const result = await cancelCompetition(repo, params.competitionId, auth.gamingMemberId, reason.trim());
    return NextResponse.json({ result });
  } catch (err) {
    const status = statusForCompetitionsError(err);
    if (status) return NextResponse.json({ error: (err as Error).message }, { status });
    console.error("CANCEL_INCOMPLETE_COMPETITION failed:", err);
    return NextResponse.json({ error: "Failed to cancel competition." }, { status: 500 });
  }
}
