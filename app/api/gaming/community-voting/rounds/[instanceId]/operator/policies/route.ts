import { handle, json, operatorContext, readJson } from "@/lib/gaming/communityVoting/rounds/http";
import { recordPolicyApproval } from "@/lib/gaming/communityVoting/rounds/operations";

/** POST .../operator/policies — records the Product decision that unblocks an operation which fails closed until it exists. Body { policyKey, policyValue, approvalReference }. Recorded once, never changed. */
export async function POST(request: Request, { params }: { params: { instanceId: string } }) {
  return handle("RECORD_ROUND_POLICY_APPROVAL", request, async (env) => {
    const ctx = await operatorContext(env, params.instanceId);
    return json(await recordPolicyApproval(env.repo, ctx, await readJson(request)), 201);
  });
}
