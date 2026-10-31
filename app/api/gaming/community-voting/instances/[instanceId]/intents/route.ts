import { NextResponse } from "next/server";
import { issueCommunityVotingIntent } from "@/lib/gaming/communityVoting/issueVoteIntent";
import { SupabaseCommunityVotingRepository } from "@/lib/gaming/communityVoting/db/supabaseCommunityVotingRepository";
import { SupabaseVoterIdentityVerifier } from "@/lib/gaming/communityVoting/verifiedIdentity";
import { NO_STORE, getSupabaseCredentials, toHttpErrorResponse } from "@/lib/gaming/communityVoting/httpSupport";

/**
 * POST /api/gaming/community-voting/instances/[instanceId]/intents — ISSUE_COMMUNITY_VOTING_INTENT.
 * Authenticated exactly like the binding route. Returns the caller's own binding id and the next
 * server-issued intent number. No body is read.
 */
export async function POST(request: Request, { params }: { params: { instanceId: string } }) {
  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return NextResponse.json(
      { error: "Server misconfiguration: Supabase credentials not set." },
      { status: 500, headers: NO_STORE }
    );
  }
  try {
    const result = await issueCommunityVotingIntent(
      new SupabaseCommunityVotingRepository(credentials.url, credentials.serviceKey),
      new SupabaseVoterIdentityVerifier(credentials.url, credentials.serviceKey),
      request.headers.get("authorization"),
      params.instanceId
    );
    return NextResponse.json(result, { status: 201, headers: NO_STORE });
  } catch (err) {
    const { status, body } = toHttpErrorResponse(err, "ISSUE_COMMUNITY_VOTING_INTENT");
    return NextResponse.json(body, { status, headers: NO_STORE });
  }
}
