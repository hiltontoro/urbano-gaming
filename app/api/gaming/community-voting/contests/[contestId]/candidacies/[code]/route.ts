import { handle, json } from "@/lib/gaming/communityVoting/rounds/http";
import { getCandidacyFicha } from "@/lib/gaming/communityVoting/contest/operations";

export const dynamic = "force-dynamic";

/**
 * GET /api/gaming/community-voting/contests/[contestId]/candidacies/[code] — a candidacy's ficha by its public code. Public, no session: it shows only
 * what the gallery shows and where the category stands in time. It casts nothing; an unknown code and a candidacy that is not public answer alike (404).
 */
export async function GET(request: Request, { params }: { params: { contestId: string; code: string } }) {
  return handle("READ_CANDIDACY_FICHA", request, async (env) => json(await getCandidacyFicha(env.repo, params.contestId, params.code)));
}
