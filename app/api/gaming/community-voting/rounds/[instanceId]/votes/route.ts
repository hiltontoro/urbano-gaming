import { handle, json, readJson } from "@/lib/gaming/communityVoting/rounds/http";
import { castRoundVote } from "@/lib/gaming/communityVoting/rounds/voterOperations";

/**
 * POST /api/gaming/community-voting/rounds/[instanceId]/votes — casts or REVISES the caller's one favorite in this round.
 * Body: { bindingId, intentNo, interactionInstanceId, candidateId, location? }. `location` ({ latitude, longitude, accuracyMeters }) is REQUIRED by
 * the final, for every vote and every revision, and is evaluated server-side; the preliminary never needs one and drops any it is sent.
 * Coordinates travel only in this POST body — never a URL — and are never persisted, logged or echoed. Success is 200 with outcome APPLIED,
 * UNCHANGED or REPLAYED. The vote counts only when this answers 200: the page confirms nothing before that.
 */
export async function POST(request: Request, { params }: { params: { instanceId: string } }) {
  return handle("CAST_ROUND_VOTE", request, async (env) =>
    json(await castRoundVote(env.voter, request.headers.get("authorization"), params.instanceId, await readJson(request)))
  );
}
