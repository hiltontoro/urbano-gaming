import { handle, json, readJson } from "@/lib/gaming/communityVoting/rounds/http";
import { claimRoundEntryAsVoter } from "@/lib/gaming/communityVoting/rounds/voterOperations";

/** POST /api/gaming/community-voting/rounds/[instanceId]/claims — a contestant presents the claim code the operator handed them. Body: { claimCode }. */
export async function POST(request: Request, { params }: { params: { instanceId: string } }) {
  return handle("CLAIM_ROUND_ENTRY", request, async (env) =>
    json(await claimRoundEntryAsVoter(env.voter, request.headers.get("authorization"), params.instanceId, await readJson(request)), 201)
  );
}
