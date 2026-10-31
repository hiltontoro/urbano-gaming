import { handle, json, readJson, resolveOperatorCredentials } from "@/lib/gaming/communityVoting/rounds/http";
import { SupabaseAuthUserVerifier } from "@/lib/gaming/auth";
import { registerCommunityVotingCategoryRound } from "@/lib/gaming/communityVoting/contest/operations";

/**
 * POST /api/gaming/community-voting/rounds — REGISTER_COMMUNITY_VOTING_CATEGORY_ROUND (one call per category: each category is a round of its own
 * Session; the first call creates the contest and answers its id, the next three pass it).
 *
 * Credentials: the Session's host token (`x-host-token`) AND `Authorization: Bearer <access token>` of the Gaming Member who will be
 * THE operator. Only a member on the COMMUNITY_VOTING_OPERATOR_MEMBER_IDS allow-list may register, and with no valid allow-list nobody can.
 * Body: { sessionId, categoryKey, contestId? } — categoryKey is MOST_ELABORATE, SEXIEST, BEST_GROUP or FUNNIEST. There is no role, no venue and no
 * test mode: the contest has one round and no location. The operator's id is recorded, never returned.
 */
export async function POST(request: Request) {
  return handle("REGISTER_COMMUNITY_VOTING_CATEGORY_ROUND", request, async (env) => {
    const credentials = await resolveOperatorCredentials(
      { gamingRepo: env.voter.gamingRepo, verifier: new SupabaseAuthUserVerifier(env.url, env.serviceKey) },
      request.headers.get("authorization"),
      request.headers.get("x-host-token")
    );
    const round = await registerCommunityVotingCategoryRound(env.repo, {
      body: await readJson(request),
      hostToken: credentials.hostToken,
      operatorMemberId: credentials.operatorMemberId,
      allowlistRaw: process.env.COMMUNITY_VOTING_OPERATOR_MEMBER_IDS,
    });
    return json({ round }, 201);
  });
}
