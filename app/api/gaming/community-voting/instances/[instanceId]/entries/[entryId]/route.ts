import { NextResponse } from "next/server";
import { removeCommunityVotingEntry } from "@/lib/gaming/communityVoting/preparation";
import { SupabaseCommunityVotingRepository } from "@/lib/gaming/communityVoting/db/supabaseCommunityVotingRepository";
import { NO_STORE, getSupabaseCredentials, toHttpErrorResponse } from "@/lib/gaming/communityVoting/httpSupport";

/**
 * DELETE /api/gaming/community-voting/instances/[instanceId]/entries/[entryId] — REMOVE_COMMUNITY_VOTING_ENTRY.
 *
 * Host-authorized: `Authorization: Bearer <hostToken>`. Removes an entry (and with it any pending claim) while the
 * ballot is still being prepared, so the host can recreate it. Refused once Voting has opened.
 */
export async function DELETE(request: Request, { params }: { params: { instanceId: string; entryId: string } }) {
  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return NextResponse.json(
      { error: "Server misconfiguration: Supabase credentials not set." },
      { status: 500, headers: NO_STORE }
    );
  }

  const bearer = request.headers.get("authorization")?.match(/^Bearer (.+)$/i);
  if (!bearer) {
    return NextResponse.json(
      { error: "A Bearer host token is required in the Authorization header.", code: "AUTHENTICATION_REQUIRED" },
      { status: 401, headers: NO_STORE }
    );
  }

  try {
    await removeCommunityVotingEntry(
      new SupabaseCommunityVotingRepository(credentials.url, credentials.serviceKey),
      { instanceId: params.instanceId, hostToken: bearer[1], entryId: params.entryId }
    );
    return NextResponse.json({ entryId: params.entryId, removed: true }, { status: 200, headers: NO_STORE });
  } catch (err) {
    const { status, body: errorBody } = toHttpErrorResponse(err, "REMOVE_COMMUNITY_VOTING_ENTRY");
    return NextResponse.json(errorBody, { status, headers: NO_STORE });
  }
}
