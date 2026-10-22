import { NextResponse } from "next/server";
import { getSupabaseCredentials, buildPredictionsRepo, requireGamingMember } from "@/lib/gaming/predictions/httpAuth";
import { toMemberQualificationView } from "@/lib/gaming/predictions/qualificationDetails";

/**
 * GET /api/gaming/predictions/matches/[matchId]/mine — the caller's
 * own Prediction, current Evaluation (if the match has been
 * finalized), and Prize Qualification (if any) for this Match.
 * gamingMemberId always comes from the verified Authorization header
 * — there is no parameter through which a caller could read another
 * member's Prediction via this route.
 */
export async function GET(
  request: Request,
  { params }: { params: { matchId: string } }
) {
  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return NextResponse.json(
      { error: "Server misconfiguration: Supabase credentials not set." },
      { status: 500 }
    );
  }

  const authResult = await requireGamingMember(request, credentials);
  if ("errorResponse" in authResult) return authResult.errorResponse;

  const repo = buildPredictionsRepo(credentials);
  const prediction = await repo.getPredictionForMember(params.matchId, authResult.gamingMemberId);

  if (!prediction) {
    return NextResponse.json({ prediction: null, evaluation: null, qualification: null });
  }

  const evaluation = await repo.getCurrentEvaluationForPrediction(prediction.predictionId);
  const qualification = evaluation
    ? await repo.getQualificationForEvaluation(evaluation.evaluationId)
    : null;

  return NextResponse.json({
    prediction,
    evaluation,
    qualification: qualification ? toMemberQualificationView(qualification) : null,
  });
}
