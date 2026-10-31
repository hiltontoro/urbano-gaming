import { handle, json, operatorContext } from "@/lib/gaming/communityVoting/rounds/http";
import { publishRound } from "@/lib/gaming/communityVoting/rounds/operations";

/** POST .../operator/publish — publishes the closed, reviewed round through the Session's own reveal. Refused (REVIEW_REQUIRED / REVIEW_STALE) without a review of the current result. */
export async function POST(request: Request, { params }: { params: { instanceId: string } }) {
  return handle("PUBLISH_ROUND", request, async (env) => json({ publication: await publishRound(env.repo, await operatorContext(env, params.instanceId)) }, 201));
}
