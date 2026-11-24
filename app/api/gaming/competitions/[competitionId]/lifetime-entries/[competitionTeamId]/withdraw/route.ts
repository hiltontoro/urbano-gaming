import { handleWithdrawEntry } from "@/lib/gaming/competitions/lifetimeEntryHttp";

/**
 * POST — a leader withdraws their team's addressed entry. No request body is read: the actor is always the verified caller.
 *
 * Every rule, status and response shape lives in the one bounded adapter; this file only forwards the request and the addressed ids.
 */
export async function POST(request: Request, context: { params: { competitionId: string, competitionTeamId: string } }) {
  return handleWithdrawEntry(request, context?.params?.competitionId, context?.params?.competitionTeamId);
}
