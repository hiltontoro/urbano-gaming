import { NextResponse } from "next/server";
import { getSupabaseCredentials, buildCompetitionsRepo, requireGamingMember, statusForCompetitionsError, requireCompetitionsSchemaReady } from "@/lib/gaming/competitions/httpAuth";
import { closeTeamRegistration } from "@/lib/gaming/competitions/closeTeamRegistration";
import { RegistrationFreezeError, closeFailureCode } from "@/lib/gaming/competitions/registrationFreeze";

/**
 * POST /api/gaming/competitions/[competitionId]/close-team-registration — CLOSE_TEAM_REGISTRATION, the registration FREEZE checkpoint (UG-CR-GATE-SSS-007).
 * Organizer-only; the deadline, exactly four accepted teams, nothing pending, every roster within the plan's bounds and the immutable freeze record are all
 * judged and written inside the one atomic RPC, by the database clock. The body is never read: the organizer is the verified caller and no time, team or
 * roster is accepted from the client. A success carries the freeze summary (team names and counts); every refusal carries a stable `code`.
 */
export async function POST(request: Request, { params }: { params: { competitionId: string } }) {
  const unavailable = requireCompetitionsSchemaReady();
  if (unavailable) return unavailable;

  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return NextResponse.json({ error: "Server misconfiguration: Supabase credentials not set." }, { status: 500 });
  }
  const auth = await requireGamingMember(request, credentials);
  if ("errorResponse" in auth) return auth.errorResponse;

  const repo = buildCompetitionsRepo(credentials);
  try {
    const result = await closeTeamRegistration(repo, params.competitionId, auth.gamingMemberId);
    return NextResponse.json({ result });
  } catch (err) {
    if (err instanceof RegistrationFreezeError) return NextResponse.json({ error: err.message, code: err.code }, { status: 409 });
    const status = statusForCompetitionsError(err);
    if (status) {
      const code = closeFailureCode(err);
      return NextResponse.json(code ? { error: (err as Error).message, code } : { error: (err as Error).message }, { status });
    }
    console.error("CLOSE_TEAM_REGISTRATION failed:", err);
    return NextResponse.json({ error: "Failed to close team registration." }, { status: 500 });
  }
}
