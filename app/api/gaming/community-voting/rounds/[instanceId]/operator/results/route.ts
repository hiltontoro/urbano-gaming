import { handle, json, operatorContext } from "@/lib/gaming/communityVoting/rounds/http";
import { readRoundResultsForOperator } from "@/lib/gaming/communityVoting/rounds/operations";

/** GET .../operator/results — per-contestant totals, ranks, finalists/winners and the evidence. Available ONLY after the round has closed (hidden from everyone during the window, the operator included). */
export async function GET(request: Request, { params }: { params: { instanceId: string } }) {
  return handle("READ_ROUND_RESULTS", request, async (env) => json(await readRoundResultsForOperator(env.repo, await operatorContext(env, params.instanceId))));
}
