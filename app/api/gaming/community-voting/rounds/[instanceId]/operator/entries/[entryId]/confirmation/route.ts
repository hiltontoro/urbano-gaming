import { handle, json, operatorContext } from "@/lib/gaming/communityVoting/rounds/http";
import { confirmRegistration } from "@/lib/gaming/communityVoting/contest/operations";

/** POST .../operator/entries/[entryId]/confirmation — the operator, having verified the name and the category with the person, confirms the association of the account that registered. No body. */
export async function POST(request: Request, { params }: { params: { instanceId: string; entryId: string } }) {
  return handle("CONFIRM_REGISTRATION", request, async (env) => {
    const ctx = await operatorContext(env, params.instanceId);
    return json(await confirmRegistration(env.repo, ctx, params.entryId));
  });
}
