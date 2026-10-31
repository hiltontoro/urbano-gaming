import { handle, json } from "@/lib/gaming/communityVoting/rounds/http";
import { getMyCandidacy } from "@/lib/gaming/communityVoting/contest/operations";

export const dynamic = "force-dynamic";

/** GET /api/gaming/community-voting/contests/[contestId]/mine — the caller's OWN candidacy in the contest (contestant, representative or attributed member), or null. Never the number. */
export async function GET(request: Request, { params }: { params: { contestId: string } }) {
  return handle("READ_MY_CANDIDACY", request, async (env) => json(await getMyCandidacy(env.repo, env.voter, request.headers.get("authorization"), params.contestId)));
}
