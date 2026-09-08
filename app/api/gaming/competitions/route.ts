import { NextResponse } from "next/server";
import { getSupabaseCredentials, buildCompetitionsRepo, requireGamingMember, statusForCompetitionsError, requireCompetitionsSchemaReady } from "@/lib/gaming/competitions/httpAuth";
import { createCompetition } from "@/lib/gaming/competitions/createCompetition";

export const dynamic = "force-dynamic";

/**
 * GET /api/gaming/competitions — every competition the caller may
 * discover. UG-CR-RPT-041 §4/§7: a DRAFT competition is organizer-only —
 * an organizer preparing a tournament before opening it must not be
 * visible to an ordinary member browsing the list. This filter is the
 * actual privacy boundary; it is enforced here, server-side, on every
 * request — never left to client-side presentation alone.
 */
export async function GET(request: Request) {
  const unavailable = requireCompetitionsSchemaReady();
  if (unavailable) return unavailable;

  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return NextResponse.json({ error: "Server misconfiguration: Supabase credentials not set." }, { status: 500 });
  }
  const auth = await requireGamingMember(request, credentials);
  if ("errorResponse" in auth) return auth.errorResponse;

  const repo = buildCompetitionsRepo(credentials);
  const allCompetitions = await repo.listCompetitions();
  const competitions = allCompetitions.filter(
    (c) => c.state !== "DRAFT" || c.organizerGamingMemberId === auth.gamingMemberId
  );
  return NextResponse.json({ competitions });
}

/**
 * POST /api/gaming/competitions — CREATE_COMPETITION. The caller becomes
 * the organizer; organizerGamingMemberId is always the verified caller's
 * own, never accepted from the body. Requires active platform OPERATIONAL
 * authority — enforced inside the atomic RPC (UG-CR-REV-026 condition 1).
 */
export async function POST(request: Request) {
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

  const { name, activityKey } = body;
  if (typeof name !== "string" || typeof activityKey !== "string") {
    return NextResponse.json({ error: "Invalid competition payload." }, { status: 400 });
  }

  const repo = buildCompetitionsRepo(credentials);
  try {
    const competition = await createCompetition(repo, auth.gamingMemberId, name, activityKey);
    return NextResponse.json({ competition }, { status: 201 });
  } catch (err) {
    const status = statusForCompetitionsError(err);
    if (status) return NextResponse.json({ error: (err as Error).message }, { status });
    console.error("CREATE_COMPETITION failed:", err);
    return NextResponse.json({ error: "Failed to create competition." }, { status: 500 });
  }
}
