import { handleCreateTeam, handleListMyTeams } from "@/lib/gaming/competitions/lifetimeHttp";

export const dynamic = "force-dynamic";

/**
 * GET — the signed-in member's own active teams, and nothing about anyone else.
 * POST — create one team; the body is exactly {"name": "..."} and the creator is always the verified caller.
 *
 * Every rule, status and response shape lives in the one bounded adapter; this file only forwards the request.
 */
export async function GET(request: Request) {
  return handleListMyTeams(request);
}

export async function POST(request: Request) {
  return handleCreateTeam(request);
}
