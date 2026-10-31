import { handle, json } from "@/lib/gaming/communityVoting/rounds/http";
import { getFeaturedContest } from "@/lib/gaming/communityVoting/contest/operations";

export const dynamic = "force-dynamic";

/**
 * GET /api/gaming/community-voting/contests/featured — public. What Home may say: `{ featured: null }` until the operator has explicitly chosen to
 * show a contest (Home then keeps its truthful informational card, with no link), or the contest's id, the page's URL and its phase.
 */
export async function GET(request: Request) {
  return handle("READ_FEATURED_CONTEST", request, async (env) => json(await getFeaturedContest(env.repo), 200, { "Cache-Control": "no-store" }));
}
