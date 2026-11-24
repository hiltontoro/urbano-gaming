import { handleDisableEntryFlow } from "@/lib/gaming/competitions/lifetimeEntryHttp";

/**
 * POST — the organizer switches team entries off again. The database allows it only while nothing has come of them, and otherwise refuses and deletes nothing. No request body is read.
 *
 * Every rule, status and response shape lives in the one bounded adapter; this file only forwards the request and the addressed id.
 */
export async function POST(request: Request, context: { params: { competitionId: string } }) {
  return handleDisableEntryFlow(request, context?.params?.competitionId);
}
