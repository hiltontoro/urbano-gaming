import { NextResponse } from "next/server";
import { getSupabaseCredentials, buildCompetitionsRepo, requireGamingMember, statusForCompetitionsError } from "@/lib/gaming/competitions/httpAuth";
import { registerForCompetition } from "@/lib/gaming/competitions/registerForCompetition";

/** POST /api/gaming/competitions/[competitionId]/register — REGISTER_FOR_COMPETITION. isAdultSelfAttested is synthetic self-attestation only. */
export async function POST(request: Request, { params }: { params: { competitionId: string } }) {
  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return NextResponse.json({ error: "Server misconfiguration: Supabase credentials not set." }, { status: 500 });
  }
  const auth = await requireGamingMember(request, credentials);
  if ("errorResponse" in auth) return auth.errorResponse;

  let body: Record<string, unknown> = {};
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    // No body treated as isAdultSelfAttested: false below.
  }
  const isAdultSelfAttested = body.isAdultSelfAttested === true;

  const repo = buildCompetitionsRepo(credentials);
  try {
    const registration = await registerForCompetition(repo, params.competitionId, auth.gamingMemberId, isAdultSelfAttested);
    return NextResponse.json({ registration }, { status: registration.alreadyRegistered ? 200 : 201 });
  } catch (err) {
    const status = statusForCompetitionsError(err);
    if (status) return NextResponse.json({ error: (err as Error).message }, { status });
    console.error("REGISTER_FOR_COMPETITION failed:", err);
    return NextResponse.json({ error: "Failed to register." }, { status: 500 });
  }
}
