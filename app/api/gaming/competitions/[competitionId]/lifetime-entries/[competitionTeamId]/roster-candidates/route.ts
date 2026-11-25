import { handleListRosterCandidates } from "@/lib/gaming/competitions/lifetimeEntryHttp";

export const dynamic = "force-dynamic";

/**
 * GET — the members a leader may propose for the addressed entry of the addressed competition. The verified member is the only actor: nothing can choose another.
 *
 * Every rule, status and response shape lives in the one bounded adapter; this file only forwards the request and the addressed ids.
 */
export async function GET(request: Request, context: { params: { competitionId: string, competitionTeamId: string } }) {
  return handleListRosterCandidates(request, context?.params?.competitionId, context?.params?.competitionTeamId);
}
