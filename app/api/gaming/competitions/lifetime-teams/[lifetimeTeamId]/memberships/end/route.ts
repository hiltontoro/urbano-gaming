import { handleEndMembership } from "@/lib/gaming/competitions/lifetimeMembershipHttp";

/**
 * POST — a person leaves, or a leader removes an ordinary member. The body is {"gamingMemberId": "..."} and, for a captain who leaves, optionally {"successorGamingMemberId": "..."}.
 *
 * Every rule, status and response shape lives in the one bounded adapter; this file only forwards the request and the addressed id.
 */
export async function POST(request: Request, context: { params: { lifetimeTeamId: string } }) {
  return handleEndMembership(request, context?.params?.lifetimeTeamId);
}
