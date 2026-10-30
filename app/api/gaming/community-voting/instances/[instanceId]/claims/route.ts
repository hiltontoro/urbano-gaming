import { NextResponse } from "next/server";
import { claimCommunityVotingEntry } from "@/lib/gaming/communityVoting/claimEntry";
import { SupabaseCommunityVotingRepository } from "@/lib/gaming/communityVoting/db/supabaseCommunityVotingRepository";
import { SupabaseVoterIdentityVerifier } from "@/lib/gaming/communityVoting/verifiedIdentity";
import { CommunityVotingError } from "@/lib/gaming/communityVoting/types";
import { NO_STORE, getSupabaseCredentials, toHttpErrorResponse } from "@/lib/gaming/communityVoting/httpSupport";

/**
 * POST /api/gaming/community-voting/instances/[instanceId]/claims — CLAIM_COMMUNITY_VOTING_ENTRY.
 *
 * The CONTESTANT's act. `Authorization: Bearer <Supabase access token>` of a user with a CONFIRMED PHONE who is
 * already bound to this event; the identity is verified server-side, never taken from the body. Body: { claimCode }
 * — the single-use credential the host handed over. It travels in the body only (never a URL) and is never logged.
 * The response carries the confirmation code, once: the contestant shows it to the host, who confirms the entry.
 * No account is linked and no Gaming Member is required or created.
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
    const { status, body: errorBody } = toHttpErrorResponse(invalid, "CLAIM_COMMUNITY_VOTING_ENTRY");
    return NextResponse.json(errorBody, { status, headers: NO_STORE });
  }

  try {
    const claimed = await claimCommunityVotingEntry(
      new SupabaseCommunityVotingRepository(credentials.url, credentials.serviceKey),
      new SupabaseVoterIdentityVerifier(credentials.url, credentials.serviceKey),
      request.headers.get("authorization"),
      params.instanceId,
      body
    );
    return NextResponse.json(claimed, { status: 200, headers: NO_STORE });
  } catch (err) {
    const { status, body: errorBody } = toHttpErrorResponse(err, "CLAIM_COMMUNITY_VOTING_ENTRY");
    return NextResponse.json(errorBody, { status, headers: NO_STORE });
  }
}
