import { handle, json, operatorContext } from "@/lib/gaming/communityVoting/rounds/http";

/** Explicit opening of contestant registration. Does not open Voting or list the contest. */
export async function POST(request: Request, { params }: { params: { instanceId: string } }) {
  return handle("OPEN_CONTEST_REGISTRATION", request, async (env) =>
    json({ registration: await env.repo.openContestRegistration(await operatorContext(env, params.instanceId)) }));
}
