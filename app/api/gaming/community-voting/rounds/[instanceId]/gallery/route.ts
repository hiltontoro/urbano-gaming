import { handle, json } from "@/lib/gaming/communityVoting/rounds/http";
import { getRoundGallery } from "@/lib/gaming/communityVoting/rounds/voterOperations";

/** GET /api/gaming/community-voting/rounds/[instanceId]/gallery — the shown contestants in THIS voter's own reproducible order. Picture URLs use the opaque number only. */
export async function GET(request: Request, { params }: { params: { instanceId: string } }) {
  return handle("READ_ROUND_GALLERY", request, async (env) => json(await getRoundGallery(env.voter, request.headers.get("authorization"), params.instanceId)));
}
