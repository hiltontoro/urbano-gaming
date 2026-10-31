import { handle, json } from "@/lib/gaming/communityVoting/rounds/http";
import { getRoundPublicResults } from "@/lib/gaming/communityVoting/rounds/voterOperations";

/** GET /api/gaming/community-voting/rounds/[instanceId]/results — what a PUBLISHED round announced: the finalists (preliminary) or the winners (final). Nothing before publication; never a count. */
export async function GET(request: Request, { params }: { params: { instanceId: string } }) {
  return handle("READ_ROUND_PUBLIC_RESULTS", request, async (env) => json(await getRoundPublicResults(env.repo, params.instanceId)));
}
