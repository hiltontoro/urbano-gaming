import { handle, json, operatorContext } from "@/lib/gaming/communityVoting/rounds/http";
import { prepareFinal } from "@/lib/gaming/communityVoting/rounds/operations";

/** POST .../operator/prepare-final — carries the preliminary's finalists into THIS final (the final's own Instance), starting from zero votes. Idempotent. */
export async function POST(request: Request, { params }: { params: { instanceId: string } }) {
  return handle("PREPARE_FINAL", request, async (env) => json({ prepared: await prepareFinal(env.repo, await operatorContext(env, params.instanceId)) }));
}
