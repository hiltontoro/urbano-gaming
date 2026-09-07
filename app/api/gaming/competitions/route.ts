import { NextResponse } from "next/server";
import { getSupabaseCredentials, buildCompetitionsRepo, requireGamingMember, statusForCompetitionsError } from "@/lib/gaming/competitions/httpAuth";
import { createCompetition } from "@/lib/gaming/competitions/createCompetition";

export const dynamic = "force-dynamic";

/** GET /api/gaming/competitions — every competition (any authenticated Gaming Member; local demo has no public browsing). */
export async function GET(request: Request) {
  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return NextResponse.json({ error: "Server misconfiguration: Supabase credentials not set." }, { status: 500 });
  }
  const auth = await requireGamingMember(request, credentials);
  if ("errorResponse" in auth) return auth.errorResponse;

  const repo = buildCompetitionsRepo(credentials);
  const competitions = await repo.listCompetitions();
  return NextResponse.json({ competitions });
}

/**
 * POST /api/gaming/competitions — CREATE_COMPETITION. The caller becomes
 * the organizer; organizerGamingMemberId is always the verified caller's
 * own, never accepted from the body. Requires active platform OPERATIONAL
 * authority — enforced inside the atomic RPC (UG-CR-REV-026 condition 1).
 */
export async function POST(request: Request) {
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
