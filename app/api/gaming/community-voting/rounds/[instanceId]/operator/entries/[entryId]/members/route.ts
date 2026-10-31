import { handle, json, operatorContext } from "@/lib/gaming/communityVoting/rounds/http";
import { createGroupMember } from "@/lib/gaming/communityVoting/contest/operations";

/** POST .../operator/entries/[entryId]/members — adds ONE attributed member under a group entry and returns that person's one-time claim code. Body (optional): { claimTtlSeconds }. */
export async function POST(request: Request, { params }: { params: { instanceId: string; entryId: string } }) {
  return handle("CREATE_GROUP_MEMBER", request, async (env) => {
    const ctx = await operatorContext(env, params.instanceId);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      body = undefined;
    }
    return json({ entry: await createGroupMember(env.repo, ctx, params.entryId, body) }, 201);
  });
}
