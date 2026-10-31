import { NextResponse } from "next/server";
import { bindCommunityVotingVoter } from "@/lib/gaming/communityVoting/bindVoter";
import { SupabaseCommunityVotingRepository } from "@/lib/gaming/communityVoting/db/supabaseCommunityVotingRepository";
import { SupabaseVoterIdentityVerifier } from "@/lib/gaming/communityVoting/verifiedIdentity";
import { NO_STORE, getSupabaseCredentials, toHttpErrorResponse } from "@/lib/gaming/communityVoting/httpSupport";

/**
 * POST /api/gaming/community-voting/instances/[instanceId]/binding — BIND_COMMUNITY_VOTING_VOTER.
 *
 * `Authorization: Bearer <Supabase access token>` of a user with a CONFIRMED PHONE. The identity is
 * verified server-side against Supabase Auth, never taken from the body; no body is read at all. The
 * Instance id in the path is only discovery context (it is what a QR code carries) and grants nothing.
 * No Gaming Member is required or created. The response carries no Participant token, label or id.
 * Idempotent: the same Auth user always gets the same binding (201 when created, 200 when recovered).
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
    const result = await bindCommunityVotingVoter(
      new SupabaseCommunityVotingRepository(credentials.url, credentials.serviceKey),
      new SupabaseVoterIdentityVerifier(credentials.url, credentials.serviceKey),
      request.headers.get("authorization"),
      params.instanceId
    );
    return NextResponse.json(result, { status: result.created ? 201 : 200, headers: NO_STORE });
  } catch (err) {
    const { status, body } = toHttpErrorResponse(err, "BIND_COMMUNITY_VOTING_VOTER");
    return NextResponse.json(body, { status, headers: NO_STORE });
  }
}
