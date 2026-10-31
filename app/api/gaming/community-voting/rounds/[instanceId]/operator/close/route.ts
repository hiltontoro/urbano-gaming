import { handle, json, operatorContext } from "@/lib/gaming/communityVoting/rounds/http";
import { closeRound } from "@/lib/gaming/communityVoting/rounds/operations";

/** POST .../operator/close — the explicit atomic close; writes the closure record. Closing and publishing are two separate acts. */
export async function POST(request: Request, { params }: { params: { instanceId: string } }) {
  return handle("CLOSE_ROUND", request, async (env) => json({ closure: await closeRound(env.repo, await operatorContext(env, params.instanceId)) }));
}
