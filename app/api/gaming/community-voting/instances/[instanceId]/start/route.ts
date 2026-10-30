import { NextResponse } from "next/server";
import { startCommunityVoting } from "@/lib/gaming/communityVoting/startVoting";
import { SupabaseCommunityVotingRepository } from "@/lib/gaming/communityVoting/db/supabaseCommunityVotingRepository";
import { CommunityVotingError } from "@/lib/gaming/communityVoting/types";
import { NO_STORE, getSupabaseCredentials, toHttpErrorResponse } from "@/lib/gaming/communityVoting/httpSupport";

/**
 * POST /api/gaming/community-voting/instances/[instanceId]/start — START_COMMUNITY_VOTING.
 *
 * The one explicit, host-authorized act that opens an event's Voting: `Authorization: Bearer <hostToken>`,
 * body { promptText }. One atomic database transaction validates the ballot, materializes the attributed
 * candidates and opens the Session's Voting interaction — or changes nothing. Completing preparation never
 * calls this. The Session's ordinary start cannot open an event-bound Session at all.
 */
export async function POST(request: Request, { params }: { params: { instanceId: string } }) {
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
    const { status, body: errorBody } = toHttpErrorResponse(invalid, "START_COMMUNITY_VOTING");
    return NextResponse.json(errorBody, { status, headers: NO_STORE });
  }

  try {
    const started = await startCommunityVoting(
      new SupabaseCommunityVotingRepository(credentials.url, credentials.serviceKey),
      { instanceId: params.instanceId, hostToken: bearer[1], promptText: body?.promptText }
    );
    return NextResponse.json(started, { status: 201, headers: NO_STORE });
  } catch (err) {
    const { status, body: errorBody } = toHttpErrorResponse(err, "START_COMMUNITY_VOTING");
    return NextResponse.json(errorBody, { status, headers: NO_STORE });
  }
}
