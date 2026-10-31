import { handle, json, operatorContext, readJson } from "@/lib/gaming/communityVoting/rounds/http";
import { setContestListing } from "@/lib/gaming/communityVoting/contest/operations";

/**
 * PUT .../operator/listing — the operator's explicit act of showing the contest on Home ({ listed: true }) or taking it down ({ listed: false }).
 * Until it is done Home says only what is true: no link, no invented event. The same authority as every operator act.
 */
export async function PUT(request: Request, { params }: { params: { instanceId: string } }) {
  return handle("SET_CONTEST_LISTING", request, async (env) => json({ listing: await setContestListing(env.repo, await operatorContext(env, params.instanceId), await readJson(request)) }));
}
