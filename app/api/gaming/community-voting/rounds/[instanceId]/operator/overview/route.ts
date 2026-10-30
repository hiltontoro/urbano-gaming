import { handle, json, operatorContext } from "@/lib/gaming/communityVoting/rounds/http";
import { readRoundOverview } from "@/lib/gaming/communityVoting/rounds/operations";

/** GET .../operator/overview — the operator's working view of the round: entries with their association, photograph, consent states, and live counters. NEVER a total per contestant. */
export async function GET(request: Request, { params }: { params: { instanceId: string } }) {
  return handle("READ_ROUND_OVERVIEW", request, async (env) => json(await readRoundOverview(env.repo, await operatorContext(env, params.instanceId))));
}
