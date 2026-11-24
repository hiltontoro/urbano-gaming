import { handleProposeRosterClaims } from "@/lib/gaming/competitions/lifetimeEntryHttp";

/**
 * POST — a leader proposes people for the addressed entry. The body is exactly {"gamingMemberIds": ["..."]}, one to thirty-two different ids. A proposal claims nobody: the person's own acceptance does.
 *
 * Every rule, status and response shape lives in the one bounded adapter; this file only forwards the request and the addressed ids.
 */
export async function POST(request: Request, context: { params: { competitionId: string, competitionTeamId: string } }) {
  return handleProposeRosterClaims(request, context?.params?.competitionId, context?.params?.competitionTeamId);
}
