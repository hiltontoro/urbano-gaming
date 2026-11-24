import { handleDisbandTeam } from "@/lib/gaming/competitions/lifetimeHttp";

/**
 * POST — disband the addressed team. No request body is read, and the actor is always the verified caller.
 *
 * Every rule, status and response shape lives in the one bounded adapter; this file only forwards the request and the addressed id.
 */
export async function POST(request: Request, context: { params: { lifetimeTeamId: string } }) {
  return handleDisbandTeam(request, context?.params?.lifetimeTeamId);
}
