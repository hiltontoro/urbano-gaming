import { handle, json, operatorContext, readJson } from "@/lib/gaming/communityVoting/rounds/http";
import { createEntry } from "@/lib/gaming/communityVoting/rounds/operations";

/** POST .../operator/entries — creates a contestant's entry (preliminary only: a final's entries come from its preliminary's cut). Returns the one-time claim code. Body (optional): { claimTtlSeconds }. */
export async function POST(request: Request, { params }: { params: { instanceId: string } }) {
  return handle("CREATE_ROUND_ENTRY", request, async (env) => {
    const ctx = await operatorContext(env, params.instanceId);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      body = undefined;
    }
    return json({ entry: await createEntry(env.repo, ctx, body) }, 201);
  });
}
