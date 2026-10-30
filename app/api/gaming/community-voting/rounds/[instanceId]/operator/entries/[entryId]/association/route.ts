import { handle, json, operatorContext, readJson } from "@/lib/gaming/communityVoting/rounds/http";
import { confirmAssociation } from "@/lib/gaming/communityVoting/rounds/operations";

/** POST .../operator/entries/[entryId]/association — the operator types the confirmation code shown on the contestant's phone, binding that identity to this entry. Body { confirmationCode }. */
export async function POST(request: Request, { params }: { params: { instanceId: string; entryId: string } }) {
  return handle("CONFIRM_ROUND_ASSOCIATION", request, async (env) => {
    const ctx = await operatorContext(env, params.instanceId);
    return json(await confirmAssociation(env.repo, ctx, params.entryId, await readJson(request)));
  });
}
