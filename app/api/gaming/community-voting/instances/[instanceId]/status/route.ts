import { NextResponse } from "next/server";
import { getCommunityVotingStatus } from "@/lib/gaming/communityVoting/getVoterStatus";
import { SupabaseCommunityVotingRepository } from "@/lib/gaming/communityVoting/db/supabaseCommunityVotingRepository";
import { SupabaseVoterIdentityVerifier } from "@/lib/gaming/communityVoting/verifiedIdentity";
import { SupabaseSessionRepository } from "@/lib/session/db/supabaseSessionRepository";
import { NO_STORE, getSupabaseCredentials, toHttpErrorResponse } from "@/lib/gaming/communityVoting/httpSupport";

/**
 * GET /api/gaming/community-voting/instances/[instanceId]/status — GET_COMMUNITY_VOTING_STATUS.
 *
 * Authenticated status recovery. Returns only the caller's own bounded participation and vote state,
 * recoverable after a lost response, on a new session for the same Auth user, and after close. It
 * exposes no token, label, other voter or hidden tally, and respects the Session's reveal gate.
 */
export async function GET(request: Request, { params }: { params: { instanceId: string } }) {
  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return NextResponse.json(
      { error: "Server misconfiguration: Supabase credentials not set." },
      { status: 500, headers: NO_STORE }
    );
  }
  try {
    const result = await getCommunityVotingStatus(
      new SupabaseCommunityVotingRepository(credentials.url, credentials.serviceKey),
      new SupabaseSessionRepository(credentials.url, credentials.serviceKey),
      new SupabaseVoterIdentityVerifier(credentials.url, credentials.serviceKey),
      request.headers.get("authorization"),
      params.instanceId
    );
    return NextResponse.json(result, { status: 200, headers: NO_STORE });
  } catch (err) {
    const { status, body } = toHttpErrorResponse(err, "GET_COMMUNITY_VOTING_STATUS");
    return NextResponse.json(body, { status, headers: NO_STORE });
  }
}
