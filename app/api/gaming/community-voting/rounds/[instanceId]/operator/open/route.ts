import { handle, json, operatorContext, readJson } from "@/lib/gaming/communityVoting/rounds/http";
import { openRound } from "@/lib/gaming/communityVoting/rounds/operations";

/** POST .../operator/open — the explicit atomic open. Body { promptText }. The configured times are not consulted: opening is an operator act. A final's window starts at this instant, on the database clock. */
export async function POST(request: Request, { params }: { params: { instanceId: string } }) {
  return handle("OPEN_ROUND", request, async (env) => {
    const ctx = await operatorContext(env, params.instanceId);
    return json({ started: await openRound(env.repo, ctx, await readJson(request)) }, 201);
  });
}
