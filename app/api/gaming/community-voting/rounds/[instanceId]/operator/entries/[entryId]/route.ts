import { handle, json, operatorContext } from "@/lib/gaming/communityVoting/rounds/http";
import { removeEntry } from "@/lib/gaming/communityVoting/rounds/operations";

/** DELETE .../operator/entries/[entryId] — removes an entry that has no photograph yet (one with media is withdrawn, never removed). */
export async function DELETE(request: Request, { params }: { params: { instanceId: string; entryId: string } }) {
  return handle("REMOVE_ROUND_ENTRY", request, async (env) => {
    await removeEntry(env.repo, await operatorContext(env, params.instanceId), params.entryId);
    return json({ removed: true });
  });
}
