import { handleEnterTeam, handleListCompetitionEntries } from "@/lib/gaming/competitions/lifetimeEntryHttp";

export const dynamic = "force-dynamic";

/**
 * GET — the live entries of the addressed competition, for its organizer. Anybody else is told the competition is unknown.
 *
 * Every rule, status and response shape lives in the one bounded adapter; this file only forwards the request and the addressed id.
 */
export async function GET(request: Request, context: { params: { competitionId: string } }) {
  return handleListCompetitionEntries(request, context?.params?.competitionId);
}

/**
 * POST — a leader enters their team in the addressed competition. The body is exactly {"lifetimeTeamId": "..."} and the actor is always the verified caller.
 */
export async function POST(request: Request, context: { params: { competitionId: string } }) {
  return handleEnterTeam(request, context?.params?.competitionId);
}
