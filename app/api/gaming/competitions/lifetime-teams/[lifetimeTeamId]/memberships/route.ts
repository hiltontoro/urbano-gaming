import { handleProposeMembership } from "@/lib/gaming/competitions/lifetimeMembershipHttp";

/**
 * POST — invite a member to the addressed team, or ask to join it. The body is exactly {"gamingMemberId": "..."} and the actor is always the verified caller.
 *
 * Every rule, status and response shape lives in the one bounded adapter; this file only forwards the request and the addressed id.
 */
export async function POST(request: Request, context: { params: { lifetimeTeamId: string } }) {
  return handleProposeMembership(request, context?.params?.lifetimeTeamId);
}
