import { NextResponse } from "next/server";
import { getSupabaseCredentials, buildCompetitionsRepo, requireGamingMember, statusForCompetitionsError, requireCompetitionsSchemaReady } from "@/lib/gaming/competitions/httpAuth";
import { openTeamRegistration } from "@/lib/gaming/competitions/openTeamRegistration";
import { RegistrationOpeningError } from "@/lib/gaming/competitions/registrationFreeze";

/**
 * POST /api/gaming/competitions/[competitionId]/open-team-registration — OPEN_TEAM_REGISTRATION. Organizer-only, DRAFT-only — enforced inside the RPC.
 * UG-CR-GATE-SSS-007: opening also requires a usable plan with a deadline still in the future by the DATABASE clock, judged inside the same RPC; a refusal for
 * that is a 409 with a stable code (PLAN_MISSING, PLAN_INVALID, DEADLINE_EXPIRED). The body is never read: the organizer is the verified caller and no time
 * or deadline is accepted from the client.
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
    const result = await openTeamRegistration(repo, params.competitionId, auth.gamingMemberId);
    return NextResponse.json({ result });
  } catch (err) {
    if (err instanceof RegistrationOpeningError) return NextResponse.json({ error: err.message, code: err.code }, { status: 409 });
    const status = statusForCompetitionsError(err);
    if (status) return NextResponse.json({ error: (err as Error).message }, { status });
    console.error("OPEN_TEAM_REGISTRATION failed:", err);
    return NextResponse.json({ error: "Failed to open team registration." }, { status: 500 });
  }
}
