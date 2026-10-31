import { handle, json, operatorContext } from "@/lib/gaming/communityVoting/rounds/http";
import { createEntry } from "@/lib/gaming/communityVoting/rounds/operations";
import { createGroupEntry } from "@/lib/gaming/communityVoting/contest/operations";

/**
 * POST .../operator/entries — creates a candidacy's entry and returns the one-time claim code. Body (optional): { kind?: "INDIVIDUAL" | "GROUP",
 * claimTtlSeconds }. The group category takes GROUP entries only, every other category INDIVIDUAL ones: the database refuses the other.
 * A group's attributed members are added under it (see .../entries/[entryId]/members).
 */
export async function POST(request: Request, { params }: { params: { instanceId: string } }) {
  return handle("CREATE_ROUND_ENTRY", request, async (env) => {
    const ctx = await operatorContext(env, params.instanceId);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      body = undefined;
    }
    const kind = typeof body === "object" && body !== null && !Array.isArray(body) ? (body as Record<string, unknown>).kind : undefined;
    const entry = kind === "GROUP" ? await createGroupEntry(env.repo, ctx, body) : await createEntry(env.repo, ctx, body);
    return json({ entry }, 201);
  });
}
