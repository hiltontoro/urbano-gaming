import { handle, json, operatorContext } from "@/lib/gaming/communityVoting/rounds/http";
import { reviewRound } from "@/lib/gaming/communityVoting/rounds/operations";

/** POST .../operator/review — the operator's recorded review of the CLOSED result (commits to its digest). Body (optional): { note }. A publication is refused without a review of the current result. */
export async function POST(request: Request, { params }: { params: { instanceId: string } }) {
  return handle("REVIEW_ROUND", request, async (env) => {
    const ctx = await operatorContext(env, params.instanceId);
    let body: unknown;
    try {
      body = await request.json();
    } catch {
      body = undefined;
    }
    return json({ review: await reviewRound(env.repo, ctx, body) }, 201);
  });
}
