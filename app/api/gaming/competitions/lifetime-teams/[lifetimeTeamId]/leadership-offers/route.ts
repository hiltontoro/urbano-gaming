import { handleOfferLeadership } from "@/lib/gaming/competitions/lifetimeMembershipHttp";

/**
 * POST — the captain offers the sub-captain seat. The body is exactly {"gamingMemberId": "..."} and the actor is always the verified caller.
 *
 * Every rule, status and response shape lives in the one bounded adapter; this file only forwards the request and the addressed id.
 */
export async function POST(request: Request, context: { params: { lifetimeTeamId: string } }) {
  return handleOfferLeadership(request, context?.params?.lifetimeTeamId);
}
