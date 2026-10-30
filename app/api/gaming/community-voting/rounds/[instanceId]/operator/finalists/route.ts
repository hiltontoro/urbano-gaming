import { handle, json, operatorContext } from "@/lib/gaming/communityVoting/rounds/http";
import { selectFinalists } from "@/lib/gaming/communityVoting/rounds/operations";

/** POST .../operator/finalists — makes the deterministic finalist cut of a CLOSED preliminary (top ten plus every contestant tied with the tenth). Takes no list: the operator has no discretion. Idempotent. */
export async function POST(request: Request, { params }: { params: { instanceId: string } }) {
  return handle("SELECT_FINALISTS", request, async (env) => json({ selection: await selectFinalists(env.repo, await operatorContext(env, params.instanceId)) }));
}
