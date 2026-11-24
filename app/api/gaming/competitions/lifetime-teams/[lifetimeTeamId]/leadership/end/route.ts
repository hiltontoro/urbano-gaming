import { handleEndLeadership } from "@/lib/gaming/competitions/lifetimeMembershipHttp";

/**
 * POST — the sub-captain steps down, or the captain removes the sub-captain. No request body is read, and the actor is always the verified caller.
 *
 * Every rule, status and response shape lives in the one bounded adapter; this file only forwards the request and the addressed id.
 */
export async function POST(request: Request, context: { params: { lifetimeTeamId: string } }) {
  return handleEndLeadership(request, context?.params?.lifetimeTeamId);
}
