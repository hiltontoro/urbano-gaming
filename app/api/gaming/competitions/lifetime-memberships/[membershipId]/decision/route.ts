import { handleDecideMembership } from "@/lib/gaming/competitions/lifetimeMembershipHttp";

/**
 * POST — answer a membership offer. The body is exactly {"decision": "ACCEPT" | "DECLINE"} and the actor is always the verified caller.
 *
 * Every rule, status and response shape lives in the one bounded adapter; this file only forwards the request and the addressed id.
 */
export async function POST(request: Request, context: { params: { membershipId: string } }) {
  return handleDecideMembership(request, context?.params?.membershipId);
}
