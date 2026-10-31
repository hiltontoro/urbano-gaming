import { handle, json } from "@/lib/gaming/communityVoting/rounds/http";
import { getContestPublicInfo } from "@/lib/gaming/communityVoting/contest/operations";

export const dynamic = "force-dynamic";

/**
 * GET /api/gaming/community-voting/contests/[contestId] — public, no identity. The categories that have a round, each with its phase by the SERVER's
 * clock, its plan and the deadline that binds, plus the one sentence about prizes the contest may say. No count, rank, total or location.
 * Never cached: the phase is derived from the server clock, so the answer carries it and a browser derives its counter from it.
 */
export async function GET(request: Request, { params }: { params: { contestId: string } }) {
  return handle("READ_CONTEST_INFO", request, async (env) => json(await getContestPublicInfo(env.repo, params.contestId), 200, { "Cache-Control": "no-store" }));
}
