import { handle, json } from "@/lib/gaming/communityVoting/rounds/http";
import { getRoundSlideshow } from "@/lib/gaming/communityVoting/rounds/voterOperations";

/** GET /api/gaming/community-voting/rounds/[instanceId]/slideshow — public display data: each shown contestant once, freshly shuffled, and NO standing of any kind. */
export async function GET(request: Request, { params }: { params: { instanceId: string } }) {
  return handle("READ_ROUND_SLIDESHOW", request, async (env) => json(await getRoundSlideshow(env.repo, params.instanceId)));
}
