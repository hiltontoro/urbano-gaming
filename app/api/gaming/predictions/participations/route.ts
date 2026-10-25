import { NextResponse } from "next/server";
import { getSupabaseCredentials, buildPredictionsRepo, requireGamingMember } from "@/lib/gaming/predictions/httpAuth";
import { buildMemberParticipations } from "@/lib/gaming/predictions/participations";

// Per-request and private: it answers for the signed-in member only, so nothing here may be prerendered or shared by a cache.
export const dynamic = "force-dynamic";

/**
 * GET /api/gaming/predictions/participations — MY PARTICIPATIONS. Read-only history of the SIGNED-IN member's own participations.
 *
 * Whose history is decided by the verified session and by nothing the client sends: the query string, the headers other than
 * Authorization and any body are never read, so there is no identifier a caller could change to see someone else's participations.
 * No session, an unknown token, or an account without a finished profile get 401 and nothing. The answer carries no coordinates,
 * distance, accuracy or geolocation evidence, no offer fingerprint and no identifier of any member, and building it reads no match
 * result, no Gaming XP and no prize qualification or redemption (see lib/gaming/predictions/participations.ts). It returns the newest
 * `limit` participations (50) and says in `truncated` whether there are older ones.
 */
export async function GET(request: Request) {
  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return NextResponse.json({ error: "Server misconfiguration: Supabase credentials not set." }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }

  const member = await requireGamingMember(request, credentials);
  if ("errorResponse" in member) {
    member.errorResponse.headers.set("Cache-Control", "no-store");
    return member.errorResponse;
  }

  try {
    const { participations, limit, truncated } = await buildMemberParticipations(buildPredictionsRepo(credentials), member.gamingMemberId);
    return NextResponse.json({ participations, limit, truncated }, { headers: { "Cache-Control": "no-store" } });
  } catch (err) {
    console.error("LIST_MY_PARTICIPATIONS failed:", err);
    return NextResponse.json({ error: "Failed to load your participations." }, { status: 500, headers: { "Cache-Control": "no-store" } });
  }
}
