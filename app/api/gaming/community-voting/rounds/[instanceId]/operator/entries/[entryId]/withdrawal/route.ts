import { handle, json, operatorContext, readJson } from "@/lib/gaming/communityVoting/rounds/http";
import { withdrawCandidature } from "@/lib/gaming/communityVoting/rounds/operations";

/** POST .../operator/entries/[entryId]/withdrawal — the candidature is withdrawn, in BOTH rounds, at any time. Votes already cast are kept as evidence; the photograph is erased only when asked. Body { reason, hidePhoto? }. */
export async function POST(request: Request, { params }: { params: { instanceId: string; entryId: string } }) {
  return handle("WITHDRAW_ROUND_CANDIDATURE", request, async (env) => {
    const ctx = await operatorContext(env, params.instanceId);
    return json(await withdrawCandidature(env.repo, ctx, params.entryId, await readJson(request)), 201);
  });
}
