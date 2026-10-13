import { NextResponse } from "next/server";
import {
  getSupabaseCredentials,
  buildHostRepo,
  requireGamingMember,
  requireHostSchemaReady,
  statusForHostError,
  bodyForHostError,
  logHostFailure,
} from "@/lib/gaming/host/httpAuth";
import { requireCompetitionsSchemaReady } from "@/lib/gaming/competitions/httpAuth";
import { createHostCompetition } from "@/lib/gaming/host/createHostCompetition";

export const dynamic = "force-dynamic";

/**
 * POST /api/gaming/host/competition — the approved host creates their ONE
 * private pilot. The capability is consumed in the same database transaction
 * that creates the competition, so a failed creation consumes nothing and
 * concurrent attempts yield exactly one competition. The activity is fixed to
 * the only supported one; the host is always the verified caller. This is a
 * separate path from POST /api/gaming/competitions, whose OPERATIONAL-only
 * behavior for internal users is unchanged.
 */
export async function POST(request: Request) {
  const unavailable = requireHostSchemaReady();
  if (unavailable) return unavailable;
  const competitionsUnavailable = requireCompetitionsSchemaReady();
  if (competitionsUnavailable) return competitionsUnavailable;

  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return NextResponse.json({ error: "Server misconfiguration: Supabase credentials not set." }, { status: 500 });
  }
  const auth = await requireGamingMember(request, credentials);
  if ("errorResponse" in auth) return auth.errorResponse;

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Request body must be a JSON object." }, { status: 400 });
  }

  try {
    const competition = await createHostCompetition(buildHostRepo(credentials), auth.gamingMemberId, body.name);
    return NextResponse.json({ competition }, { status: 201 });
  } catch (err) {
    const code = statusForHostError(err);
    if (code) return NextResponse.json(bodyForHostError(err), { status: code });
    logHostFailure("CREATE_HOST_COMPETITION", err);
    return NextResponse.json({ error: "Failed to create your pilot competition." }, { status: 500 });
  }
}
