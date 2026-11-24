import { handleListMyTeamEntries } from "@/lib/gaming/competitions/lifetimeEntryHttp";

export const dynamic = "force-dynamic";

/**
 * GET — the live entries of the team the signed-in member leads, with the proposals on them. The verified member is the only input: nothing in the query, the headers or a body can choose another one.
 *
 * Every rule, status and response shape lives in the one bounded adapter; this file only forwards the request and the addressed id.
 */
export async function GET(request: Request) {
  return handleListMyTeamEntries(request);
}
