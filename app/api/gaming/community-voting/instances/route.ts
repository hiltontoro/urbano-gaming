import { NextResponse } from "next/server";
import { registerCommunityVotingInstance } from "@/lib/gaming/communityVoting/registerInstance";
import { SupabaseCommunityVotingRepository } from "@/lib/gaming/communityVoting/db/supabaseCommunityVotingRepository";
import { NO_STORE, getSupabaseCredentials, toHttpErrorResponse } from "@/lib/gaming/communityVoting/httpSupport";

/**
 * POST /api/gaming/community-voting/instances — REGISTER_COMMUNITY_VOTING_INSTANCE.
 *
 * Authority is the Session's own host token: `Authorization: Bearer <hostToken>`, the same authority
 * that locks, starts, closes and reveals. No new operator role. Body: { sessionId, config, ruleVersion }.
 * Route is thin: header/body extraction only; every rule lives in the domain function and, authoritatively,
 * in the database function it calls.
 */
export async function POST(request: Request) {
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
    return NextResponse.json(
      { error: "Request body must be valid JSON.", code: "INVALID_REQUEST" },
      { status: 400, headers: NO_STORE }
    );
  }

  try {
    const repo = new SupabaseCommunityVotingRepository(credentials.url, credentials.serviceKey);
    const instance = await registerCommunityVotingInstance(repo, {
      sessionId: body?.sessionId,
      hostToken: bearer[1],
      config: body?.config,
      ruleVersion: body?.ruleVersion,
    });
    return NextResponse.json({ instance }, { status: 201, headers: NO_STORE });
  } catch (err) {
    const { status, body: errorBody } = toHttpErrorResponse(err, "REGISTER_COMMUNITY_VOTING_INSTANCE");
    return NextResponse.json(errorBody, { status, headers: NO_STORE });
  }
}
