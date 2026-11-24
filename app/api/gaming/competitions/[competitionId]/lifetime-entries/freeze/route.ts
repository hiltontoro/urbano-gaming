import { handleFreezeEntries } from "@/lib/gaming/competitions/lifetimeEntryHttp";

/**
 * POST — the organizer freezes the entries of the addressed competition. No request body is read: the organizer is always the verified caller.
 *
 * Every rule, status and response shape lives in the one bounded adapter; this file only forwards the request and the addressed id.
 */
export async function POST(request: Request, context: { params: { competitionId: string } }) {
  return handleFreezeEntries(request, context?.params?.competitionId);
}
