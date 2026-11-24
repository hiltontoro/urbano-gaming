import { handleDecideRosterClaim } from "@/lib/gaming/competitions/lifetimeEntryHttp";

/**
 * POST — the person a roster proposal names accepts or rejects it. The body is exactly {"decision": "ACCEPT"} or {"decision": "REJECT"}; nobody else can answer it.
 *
 * Every rule, status and response shape lives in the one bounded adapter; this file only forwards the request and the addressed ids.
 */
export async function POST(request: Request, context: { params: { competitionId: string, claimId: string } }) {
  return handleDecideRosterClaim(request, context?.params?.competitionId, context?.params?.claimId);
}
