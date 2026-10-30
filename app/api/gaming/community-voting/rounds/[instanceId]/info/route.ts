import { handle, json } from "@/lib/gaming/communityVoting/rounds/http";
import { getRoundPublicInfo } from "@/lib/gaming/communityVoting/rounds/voterOperations";

/**
 * GET /api/gaming/community-voting/rounds/[instanceId]/info — public, no identity. The round's phase, its schedule and DEADLINE,
 * whether a location is needed (the final only), the SERVER's clock and the consent texts. Never cached: the phase is derived from
 * the server clock, so the answer carries it and a browser derives its counter from it.
 */
export async function GET(request: Request, { params }: { params: { instanceId: string } }) {
  return handle("READ_ROUND_INFO", request, async (env) =>
    json(await getRoundPublicInfo(env.repo, params.instanceId), 200, { "Cache-Control": "no-store" })
  );
}
