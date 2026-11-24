import { handleDecideEntry } from "@/lib/gaming/competitions/lifetimeEntryHttp";

/**
 * POST — the organizer approves, rejects or removes the addressed entry of the addressed competition. The body is {"decision": "APPROVE"}, or a decision with a reasonCode and, optionally, a note. An approval accepts no roster place.
 *
 * Every rule, status and response shape lives in the one bounded adapter; this file only forwards the request and the addressed ids.
 */
export async function POST(request: Request, context: { params: { competitionId: string, competitionTeamId: string } }) {
  return handleDecideEntry(request, context?.params?.competitionId, context?.params?.competitionTeamId);
}
