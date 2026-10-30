import { NextResponse } from "next/server";
import { confirmCommunityVotingEntry } from "@/lib/gaming/communityVoting/preparation";
import { SupabaseCommunityVotingRepository } from "@/lib/gaming/communityVoting/db/supabaseCommunityVotingRepository";
import { CommunityVotingError } from "@/lib/gaming/communityVoting/types";
import { NO_STORE, getSupabaseCredentials, toHttpErrorResponse } from "@/lib/gaming/communityVoting/httpSupport";

/**
 * POST /api/gaming/community-voting/instances/[instanceId]/entries/[entryId]/confirmation — CONFIRM_COMMUNITY_VOTING_ENTRY.
 *
 * Host-authorized: `Authorization: Bearer <hostToken>`. Body: { confirmationCode } — the code the host reads off the
 * claimant's own screen. The entry is the path's, so the host confirms the entry they INTEND; the code only
 * confirms that claimant. Five wrong codes void the claim. The code travels in the body only.
 */
export async function POST(request: Request, { params }: { params: { instanceId: string; entryId: string } }) {
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

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    const invalid = new CommunityVotingError("INVALID_REQUEST", "Request body must be valid JSON.");
    const { status, body: errorBody } = toHttpErrorResponse(invalid, "CONFIRM_COMMUNITY_VOTING_ENTRY");
    return NextResponse.json(errorBody, { status, headers: NO_STORE });
  }

  try {
    const confirmed = await confirmCommunityVotingEntry(
      new SupabaseCommunityVotingRepository(credentials.url, credentials.serviceKey),
      {
        instanceId: params.instanceId,
        hostToken: bearer[1],
        entryId: params.entryId,
        confirmationCode: body?.confirmationCode,
      }
    );
    return NextResponse.json(confirmed, { status: 200, headers: NO_STORE });
  } catch (err) {
    const { status, body: errorBody } = toHttpErrorResponse(err, "CONFIRM_COMMUNITY_VOTING_ENTRY");
    return NextResponse.json(errorBody, { status, headers: NO_STORE });
  }
}
