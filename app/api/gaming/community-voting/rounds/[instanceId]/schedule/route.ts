import { handle, json, operatorContext, readJson } from "@/lib/gaming/communityVoting/rounds/http";
import { setRoundSchedule } from "@/lib/gaming/communityVoting/rounds/operations";

/** PUT /api/gaming/community-voting/rounds/[instanceId]/schedule — the round's schedule (registration, cutoff, opening, closing, TENTATIVE|CONFIRMED). Configuration until the round opens, frozen afterwards: the cutoff then refuses new contestants and photographs, and the preliminary's closing is its deadline. It opens nothing by itself. Operator only. */
export async function PUT(request: Request, { params }: { params: { instanceId: string } }) {
  return handle("SET_ROUND_SCHEDULE", request, async (env) =>
    json({ schedule: await setRoundSchedule(env.repo, await operatorContext(env, params.instanceId), await readJson(request)) })
  );
}
