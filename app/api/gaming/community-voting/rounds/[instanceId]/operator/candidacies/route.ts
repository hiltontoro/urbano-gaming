import { handle, json, operatorContext } from "@/lib/gaming/communityVoting/rounds/http";
import { findStationCandidacy } from "@/lib/gaming/communityVoting/contest/operations";

export const dynamic = "force-dynamic";

/** GET .../operator/candidacies?code=HAL-XXXXX — the station's search: a candidacy by its public code, in any category of the contest, before it is public. Never the number. */
export async function GET(request: Request, { params }: { params: { instanceId: string } }) {
  return handle("FIND_CANDIDACY_BY_CODE", request, async (env) => {
    const ctx = await operatorContext(env, params.instanceId);
    return json(await findStationCandidacy(env.repo, ctx, new URL(request.url).searchParams.get("code")));
  });
}
