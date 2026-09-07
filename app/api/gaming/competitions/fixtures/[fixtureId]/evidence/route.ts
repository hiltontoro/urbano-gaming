import { NextResponse } from "next/server";
import { getSupabaseCredentials, buildCompetitionsRepo, requireGamingMember, statusForCompetitionsError, requireCompetitionsSchemaReady } from "@/lib/gaming/competitions/httpAuth";
import { submitFixtureEvidence } from "@/lib/gaming/competitions/submitFixtureEvidence";
import type { GoalEventInput, AssistEventInput, ParticipationAttestationInput } from "@/lib/gaming/competitions/types";

function isGoalEvents(value: unknown): value is GoalEventInput[] {
  return Array.isArray(value) && value.every((g) => g && typeof g.scorerGamingMemberId === "string" && typeof g.competitionTeamId === "string");
}
function isAssistEvents(value: unknown): value is AssistEventInput[] {
  return Array.isArray(value) && value.every((a) => a && typeof a.assistingGamingMemberId === "string" && typeof a.goalEventIndex === "number");
}
function isAttestations(value: unknown): value is ParticipationAttestationInput[] {
  return Array.isArray(value) && value.every((a) => a && typeof a.gamingMemberId === "string" && typeof a.actuallyParticipated === "boolean");
}

/**
 * POST /api/gaming/competitions/fixtures/[fixtureId]/evidence —
 * SUBMIT_FIXTURE_EVIDENCE. Scorekeeper-only; one atomic bundle covering
 * score, goal/assist events, attestations, and — when regulation is
 * tied — the penalty-shootout winner. scorekeeperGamingMemberId is
 * always the verified caller's own.
 */
export async function POST(request: Request, { params }: { params: { fixtureId: string } }) {
  const unavailable = requireCompetitionsSchemaReady();
  if (unavailable) return unavailable;

  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return NextResponse.json({ error: "Server misconfiguration: Supabase credentials not set." }, { status: 500 });
  }
  const auth = await requireGamingMember(request, credentials);
  if ("errorResponse" in auth) return auth.errorResponse;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const { teamAScore, teamBScore, goalEvents, assistEvents, participationAttestations, penaltyShootoutWinningTeamId } = body;
  if (
    typeof teamAScore !== "number" || typeof teamBScore !== "number" ||
    !isGoalEvents(goalEvents) || !isAssistEvents(assistEvents) || !isAttestations(participationAttestations) ||
    !(penaltyShootoutWinningTeamId === null || penaltyShootoutWinningTeamId === undefined || typeof penaltyShootoutWinningTeamId === "string")
  ) {
    return NextResponse.json({ error: "Invalid evidence payload." }, { status: 400 });
  }

  const repo = buildCompetitionsRepo(credentials);
  try {
    const result = await submitFixtureEvidence(
      repo, params.fixtureId, auth.gamingMemberId, teamAScore, teamBScore,
      goalEvents, assistEvents, participationAttestations, penaltyShootoutWinningTeamId ?? null
    );
    return NextResponse.json({ result }, { status: result.alreadySubmitted ? 200 : 201 });
  } catch (err) {
    const status = statusForCompetitionsError(err);
    if (status) return NextResponse.json({ error: (err as Error).message }, { status });
    console.error("SUBMIT_FIXTURE_EVIDENCE failed:", err);
    return NextResponse.json({ error: "Failed to submit evidence." }, { status: 500 });
  }
}
