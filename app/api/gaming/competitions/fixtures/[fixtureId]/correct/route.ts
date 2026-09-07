import { NextResponse } from "next/server";
import { getSupabaseCredentials, buildCompetitionsRepo, requireGamingMember, statusForCompetitionsError, requireCompetitionsSchemaReady } from "@/lib/gaming/competitions/httpAuth";
import { correctFixture } from "@/lib/gaming/competitions/correctFixture";
import type { GoalEventInput, AssistEventInput } from "@/lib/gaming/competitions/types";

function isGoalEvents(value: unknown): value is GoalEventInput[] {
  return Array.isArray(value) && value.every((g) => g && typeof g.scorerGamingMemberId === "string" && typeof g.competitionTeamId === "string");
}
function isAssistEvents(value: unknown): value is AssistEventInput[] {
  return Array.isArray(value) && value.every((a) => a && typeof a.assistingGamingMemberId === "string" && typeof a.goalEventIndex === "number");
}

/**
 * POST /api/gaming/competitions/fixtures/[fixtureId]/correct —
 * CORRECT_FIXTURE. Organizer-only, reason always required. Supersedes
 * the whole evidence bundle; may trigger the semifinal-correction
 * cascade (finalist replacement or competition cancellation) when the
 * winner changes — see UG-CR-RPT-024 §7.
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

  const { reason, teamAScore, teamBScore, goalEvents, assistEvents, penaltyShootoutWinningTeamId } = body;
  if (
    typeof reason !== "string" || typeof teamAScore !== "number" || typeof teamBScore !== "number" ||
    !isGoalEvents(goalEvents) || !isAssistEvents(assistEvents) ||
    !(penaltyShootoutWinningTeamId === null || penaltyShootoutWinningTeamId === undefined || typeof penaltyShootoutWinningTeamId === "string")
  ) {
    return NextResponse.json({ error: "Invalid correction payload." }, { status: 400 });
  }

  const repo = buildCompetitionsRepo(credentials);
  try {
    const result = await correctFixture(
      repo, params.fixtureId, auth.gamingMemberId, reason, teamAScore, teamBScore,
      goalEvents, assistEvents, penaltyShootoutWinningTeamId ?? null
    );
    return NextResponse.json({ result });
  } catch (err) {
    const status = statusForCompetitionsError(err);
    if (status) return NextResponse.json({ error: (err as Error).message }, { status });
    console.error("CORRECT_FIXTURE failed:", err);
    return NextResponse.json({ error: "Failed to correct fixture." }, { status: 500 });
  }
}
