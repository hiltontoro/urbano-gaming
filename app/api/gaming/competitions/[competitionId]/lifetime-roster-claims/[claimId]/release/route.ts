import { handleReleaseRosterClaim } from "@/lib/gaming/competitions/lifetimeEntryHttp";

/**
 * POST — the person withdraws their accepted place, or a leader withdraws a proposal or removes a place. No request body is read: the actor is always the verified caller.
 *
 * Every rule, status and response shape lives in the one bounded adapter; this file only forwards the request and the addressed ids.
 */
export async function POST(request: Request, context: { params: { competitionId: string, claimId: string } }) {
  return handleReleaseRosterClaim(request, context?.params?.competitionId, context?.params?.claimId);
}
