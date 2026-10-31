import { handle, json, readJson, resolveOperatorCredentials } from "@/lib/gaming/communityVoting/rounds/http";
import { SupabaseAuthUserVerifier } from "@/lib/gaming/auth";
import { registerCommunityVotingRound } from "@/lib/gaming/communityVoting/rounds/operations";

/**
 * POST /api/gaming/community-voting/rounds — REGISTER_COMMUNITY_VOTING_ROUND (one call per round: the preliminary, then the final).
 *
 * Credentials: the Session's host token (`x-host-token`) AND `Authorization: Bearer <access token>` of the Gaming Member who will be
 * THE operator. Only a member on the COMMUNITY_VOTING_OPERATOR_MEMBER_IDS allow-list may register, and with no valid allow-list nobody can.
 * Body: { sessionId, roundRole: "PRELIMINARY" } — or — { sessionId, roundRole: "FINAL", sourceInstanceId, venue: { ...geofence } }.
 * The final's window is the contractual five minutes; the request cannot choose it. The operator's id is recorded, never returned.
 */
export async function POST(request: Request) {
  return handle("REGISTER_COMMUNITY_VOTING_ROUND", request, async (env) => {
    const credentials = await resolveOperatorCredentials(
      { gamingRepo: env.voter.gamingRepo, verifier: new SupabaseAuthUserVerifier(env.url, env.serviceKey) },
      request.headers.get("authorization"),
      request.headers.get("x-host-token")
    );
    const instance = await registerCommunityVotingRound(env.repo, {
      body: await readJson(request),
      hostToken: credentials.hostToken,
      operatorMemberId: credentials.operatorMemberId,
      allowlistRaw: process.env.COMMUNITY_VOTING_OPERATOR_MEMBER_IDS,
    });
    return json({ instance }, 201);
  });
}
