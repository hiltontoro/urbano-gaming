import { handle, json } from "@/lib/gaming/communityVoting/rounds/http";
import { bindRoundVoter } from "@/lib/gaming/communityVoting/rounds/voterOperations";

/**
 * POST /api/gaming/community-voting/rounds/[instanceId]/binding — binds the caller to this round. `Authorization: Bearer <Supabase access token>`
 * of a user with a CONFIRMED EMAIL and a Gaming Member profile; both are verified on the server and by the database. No body is read. The
 * response carries no Participant token, label or id. Idempotent: 201 when created, 200 when recovered. No identity or profile is created here.
 */
export async function POST(request: Request, { params }: { params: { instanceId: string } }) {
  return handle("BIND_ROUND_VOTER", request, async (env) => {
    const result = await bindRoundVoter(env.voter, request.headers.get("authorization"), params.instanceId);
    return json(result, result.created ? 201 : 200);
  });
}
