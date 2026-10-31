import { handle, json } from "@/lib/gaming/communityVoting/rounds/http";
import { getRoundVoterStatus } from "@/lib/gaming/communityVoting/rounds/voterOperations";

/** GET /api/gaming/community-voting/rounds/[instanceId]/status — the caller's OWN snapshot (bound or not, the round's phase, their current favorite). No token, no other voter, no tally. */
export async function GET(request: Request, { params }: { params: { instanceId: string } }) {
  return handle("READ_ROUND_STATUS", request, async (env) => json(await getRoundVoterStatus(env.voter, request.headers.get("authorization"), params.instanceId)));
}
