import { handle, json, operatorContext, readJson } from "@/lib/gaming/communityVoting/rounds/http";
import { resolveFollowupTask } from "@/lib/gaming/communityVoting/rounds/operations";

/** POST .../operator/tasks/[taskId] — the team did the pending operational work (for example, took down an external publication by hand). Body { note }. A task is resolved once. */
export async function POST(request: Request, { params }: { params: { instanceId: string; taskId: string } }) {
  return handle("RESOLVE_ROUND_FOLLOWUP_TASK", request, async (env) => {
    const ctx = await operatorContext(env, params.instanceId);
    return json(await resolveFollowupTask(env.repo, ctx, params.taskId, await readJson(request)));
  });
}
