import { handle, json, readJson } from "@/lib/gaming/communityVoting/rounds/http";
import { registerAsContestant } from "@/lib/gaming/communityVoting/contest/operations";

export const dynamic = "force-dynamic";

/**
 * POST /api/gaming/community-voting/rounds/[instanceId]/registration — a person registers THEMSELVES as a contestant in this category. `Authorization:
 * Bearer <Supabase access token>` of a user with a CONFIRMED EMAIL and a Gaming Member profile; the identity is derived here, never read from the body.
 * Body: { publicName, adultConfirmed, requirementsAccepted, requirementsVersion, whatsapp (with its country code), whatsappConfirmed,
 * deliveryAuthorized, deliveryVersion }. The response carries the public code and name and never the number. 201 when registered.
 */
export async function POST(request: Request, { params }: { params: { instanceId: string } }) {
  return handle("REGISTER_CANDIDACY", request, async (env) =>
    json(await registerAsContestant(env.repo, env.voter, request.headers.get("authorization"), params.instanceId, await readJson(request)), 201)
  );
}
