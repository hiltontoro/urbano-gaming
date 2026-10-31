import { handle, json, operatorContext } from "@/lib/gaming/communityVoting/rounds/http";

/** GET .../operator/overview — the operator's working view of ONE category: entries with their kind, association, photograph and consent states (a group's members under it), and live counters. NEVER a total per candidacy. */
export async function GET(request: Request, { params }: { params: { instanceId: string } }) {
  return handle("READ_ROUND_OVERVIEW", request, async (env) => json(await env.repo.readCategoryOverview(await operatorContext(env, params.instanceId))));
}
