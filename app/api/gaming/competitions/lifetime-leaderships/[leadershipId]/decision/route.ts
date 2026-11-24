import { handleDecideLeadership } from "@/lib/gaming/competitions/lifetimeMembershipHttp";

/**
 * POST — answer a sub-captain seat offer. The body is exactly {"decision": "ACCEPT" | "DECLINE"} and the actor is always the verified caller.
 *
 * Every rule, status and response shape lives in the one bounded adapter; this file only forwards the request and the addressed id.
 */
export async function POST(request: Request, context: { params: { leadershipId: string } }) {
  return handleDecideLeadership(request, context?.params?.leadershipId);
}
