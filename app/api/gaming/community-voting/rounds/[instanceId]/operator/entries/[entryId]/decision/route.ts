import { handle, json, operatorContext, readJson } from "@/lib/gaming/communityVoting/rounds/http";
import { decidePhoto } from "@/lib/gaming/communityVoting/rounds/operations";

/** POST .../operator/entries/[entryId]/decision — approve or reject the current photograph. Approval needs the contestant's gallery/contest consent first. Body { photoId, decision, reason? }. */
export async function POST(request: Request, { params }: { params: { instanceId: string; entryId: string } }) {
  return handle("DECIDE_ROUND_PHOTO", request, async (env) => {
    const ctx = await operatorContext(env, params.instanceId);
    return json(await decidePhoto(env.repo, ctx, params.entryId, await readJson(request)));
  });
}
