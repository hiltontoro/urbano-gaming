import { handle, json, operatorContext, readJson } from "@/lib/gaming/communityVoting/rounds/http";
import { correctCandidacyName } from "@/lib/gaming/communityVoting/contest/operations";

/** PUT .../operator/entries/[entryId]/name — the public name, verified with the person at the station (before Voting opens). Body { publicName }. */
export async function PUT(request: Request, { params }: { params: { instanceId: string; entryId: string } }) {
  return handle("CORRECT_CANDIDACY_NAME", request, async (env) => {
    const ctx = await operatorContext(env, params.instanceId);
    return json(await correctCandidacyName(env.repo, ctx, params.entryId, await readJson(request)));
  });
}
