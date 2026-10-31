import { NextResponse } from "next/server";
import { createCommunityVotingEntry, readCommunityVotingPreparation } from "@/lib/gaming/communityVoting/preparation";
import { SupabaseCommunityVotingRepository } from "@/lib/gaming/communityVoting/db/supabaseCommunityVotingRepository";
import { CommunityVotingError } from "@/lib/gaming/communityVoting/types";
import { NO_STORE, getSupabaseCredentials, toHttpErrorResponse } from "@/lib/gaming/communityVoting/httpSupport";

const MISSING_HOST_TOKEN = {
  error: "A Bearer host token is required in the Authorization header.",
  code: "AUTHENTICATION_REQUIRED",
};

/**
 * POST /api/gaming/community-voting/instances/[instanceId]/entries — CREATE_COMMUNITY_VOTING_ENTRY.
 *
 * Host-authorized preparation: `Authorization: Bearer <hostToken>`. Body: { label, claimTtlSeconds? }. Creates one
 * ballot entry — readiness data, not a candidate — and returns its single-use claim credential ONCE, in this
 * response body only (never a URL, never logged, never readable again). Refused once Voting has opened.
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
  if (!bearer) return NextResponse.json(MISSING_HOST_TOKEN, { status: 401, headers: NO_STORE });

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    const invalid = new CommunityVotingError("INVALID_REQUEST", "Request body must be valid JSON.");
    const { status, body: errorBody } = toHttpErrorResponse(invalid, "CREATE_COMMUNITY_VOTING_ENTRY");
    return NextResponse.json(errorBody, { status, headers: NO_STORE });
  }

  try {
    const entry = await createCommunityVotingEntry(
      new SupabaseCommunityVotingRepository(credentials.url, credentials.serviceKey),
      {
        instanceId: params.instanceId,
        hostToken: bearer[1],
        label: body?.label,
        claimTtlSeconds: body?.claimTtlSeconds,
      }
    );
    return NextResponse.json(entry, { status: 201, headers: NO_STORE });
  } catch (err) {
    const { status, body: errorBody } = toHttpErrorResponse(err, "CREATE_COMMUNITY_VOTING_ENTRY");
    return NextResponse.json(errorBody, { status, headers: NO_STORE });
  }
}

/**
 * GET /api/gaming/community-voting/instances/[instanceId]/entries — READ_COMMUNITY_VOTING_PREPARATION.
 *
 * The host's view: entry labels, states and readiness. No phone, Auth id, binding, Participant or secret;
 * readiness is information only and never opens anything.
 */
export async function GET(request: Request, { params }: { params: { instanceId: string } }) {
  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return NextResponse.json(
      { error: "Server misconfiguration: Supabase credentials not set." },
      { status: 500, headers: NO_STORE }
    );
  }

  const bearer = request.headers.get("authorization")?.match(/^Bearer (.+)$/i);
  if (!bearer) return NextResponse.json(MISSING_HOST_TOKEN, { status: 401, headers: NO_STORE });

  try {
    const view = await readCommunityVotingPreparation(
      new SupabaseCommunityVotingRepository(credentials.url, credentials.serviceKey),
      { instanceId: params.instanceId, hostToken: bearer[1] }
    );
    return NextResponse.json(view, { status: 200, headers: NO_STORE });
  } catch (err) {
    const { status, body: errorBody } = toHttpErrorResponse(err, "READ_COMMUNITY_VOTING_PREPARATION");
    return NextResponse.json(errorBody, { status, headers: NO_STORE });
  }
}
