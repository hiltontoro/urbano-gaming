import { handle, json, operatorContext, readJson } from "@/lib/gaming/communityVoting/rounds/http";
import { hideRoundPhoto } from "@/lib/gaming/communityVoting/rounds/operations";

/** POST .../operator/entries/[entryId]/photo-hide — the person asked for their photograph to stop being shown. It is hidden in every round and its bytes are erased now; the candidature, the votes and the selection are untouched. Body { reason }. */
export async function POST(request: Request, { params }: { params: { instanceId: string; entryId: string } }) {
  return handle("HIDE_ROUND_PHOTO", request, async (env) => {
    const ctx = await operatorContext(env, params.instanceId);
    return json(await hideRoundPhoto(env.repo, ctx, params.entryId, await readJson(request)), 201);
  });
}
