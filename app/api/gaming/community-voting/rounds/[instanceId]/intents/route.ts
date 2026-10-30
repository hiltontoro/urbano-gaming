import { handle, json } from "@/lib/gaming/communityVoting/rounds/http";
import { issueRoundIntent } from "@/lib/gaming/communityVoting/rounds/voterOperations";

/** POST /api/gaming/community-voting/rounds/[instanceId]/intents — hands the caller's own binding its next server-issued intent number. No body is read. */
export async function POST(request: Request, { params }: { params: { instanceId: string } }) {
  return handle("ISSUE_ROUND_INTENT", request, async (env) =>
    json(await issueRoundIntent(env.voter, request.headers.get("authorization"), params.instanceId), 201)
  );
}
