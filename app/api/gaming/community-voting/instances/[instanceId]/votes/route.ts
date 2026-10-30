import { NextResponse } from "next/server";
import { castCommunityVote } from "@/lib/gaming/communityVoting/castCommunityVote";
import { SupabaseCommunityVotingRepository } from "@/lib/gaming/communityVoting/db/supabaseCommunityVotingRepository";
import { SupabaseVoterIdentityVerifier } from "@/lib/gaming/communityVoting/verifiedIdentity";
import { CommunityVotingError } from "@/lib/gaming/communityVoting/types";
import { NO_STORE, getSupabaseCredentials, toHttpErrorResponse } from "@/lib/gaming/communityVoting/httpSupport";

/**
 * POST /api/gaming/community-voting/instances/[instanceId]/votes — CAST_COMMUNITY_VOTE.
 *
 * Body: { bindingId, intentNo, interactionInstanceId, candidateId, location: { latitude, longitude,
 * accuracyMeters } }. The location is an untrusted claim evaluated server-side; coordinates travel only in
 * this POST body — never a URL — and are never persisted, logged or echoed. Any `eligible`-style field a
 * client adds is not read. Success is 200 with outcome APPLIED, UNCHANGED or REPLAYED.
 */
export async function POST(request: Request, { params }: { params: { instanceId: string } }) {
  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return NextResponse.json(
      { error: "Server misconfiguration: Supabase credentials not set." },
      { status: 500, headers: NO_STORE }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    const invalid = new CommunityVotingError("INVALID_REQUEST", "Request body must be valid JSON.");
    const { status, body: errorBody } = toHttpErrorResponse(invalid, "CAST_COMMUNITY_VOTE");
    return NextResponse.json(errorBody, { status, headers: NO_STORE });
  }

  try {
    const result = await castCommunityVote(
      new SupabaseCommunityVotingRepository(credentials.url, credentials.serviceKey),
      new SupabaseVoterIdentityVerifier(credentials.url, credentials.serviceKey),
      request.headers.get("authorization"),
      params.instanceId,
      body
    );
    return NextResponse.json(result, { status: 200, headers: NO_STORE });
  } catch (err) {
    const { status, body: errorBody } = toHttpErrorResponse(err, "CAST_COMMUNITY_VOTE");
    return NextResponse.json(errorBody, { status, headers: NO_STORE });
  }
}
