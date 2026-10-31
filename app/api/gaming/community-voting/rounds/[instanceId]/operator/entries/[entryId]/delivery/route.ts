import { handle, json, operatorContext } from "@/lib/gaming/communityVoting/rounds/http";
import { markDelivered } from "@/lib/gaming/communityVoting/contest/operations";

/** POST .../operator/entries/[entryId]/delivery — "delivered", only by the operator's explicit act. Idempotent. No body. */
export async function POST(request: Request, { params }: { params: { instanceId: string; entryId: string } }) {
  return handle("MARK_DELIVERED", request, async (env) => {
    const ctx = await operatorContext(env, params.instanceId);
    return json(await markDelivered(env.repo, ctx, params.entryId));
  });
}
