import { handleListMyRosterClaims } from "@/lib/gaming/competitions/lifetimeEntryHttp";

export const dynamic = "force-dynamic";

/**
 * GET — the signed-in member's own open roster proposals and accepted places. The verified member is the only input: nothing in the query, the headers or a body can choose another one.
 *
 * Every rule, status and response shape lives in the one bounded adapter; this file only forwards the request and the addressed id.
 */
export async function GET(request: Request) {
  return handleListMyRosterClaims(request);
}
