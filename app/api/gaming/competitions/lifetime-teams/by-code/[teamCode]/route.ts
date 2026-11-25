import { handleFindTeamByCode } from "@/lib/gaming/competitions/lifetimeMembershipHttp";

export const dynamic = "force-dynamic";

/**
 * GET — the team a join link names, as its identifier and name only, for the signed-in member. The code is the only input about the team; it grants nothing.
 *
 * Every rule, status and response shape lives in the one bounded adapter; this file only forwards the request and the addressed code.
 */
export async function GET(request: Request, context: { params: { teamCode: string } }) {
  return handleFindTeamByCode(request, context?.params?.teamCode);
}
