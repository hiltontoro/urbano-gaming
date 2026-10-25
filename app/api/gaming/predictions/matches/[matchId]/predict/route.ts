import { NextResponse } from "next/server";
import {
  getSupabaseCredentials,
  buildPredictionsRepo,
  requireGamingMember,
  statusForPredictionsError,
} from "@/lib/gaming/predictions/httpAuth";
import { submitPrediction, submitProgressivePrediction } from "@/lib/gaming/predictions/submitPrediction";
import { assertParticipationOpen } from "@/lib/gaming/predictions/participationWindow";
import { ContractMismatchError, InvalidAttemptShapeError } from "@/lib/gaming/predictions/types";
import { PROGRESSIVE_PREDICTION_CONTRACT, progressivePredictionView } from "@/lib/gaming/predictions/prizeLadder";

/** The fields of the historical request: four dimensions at once, a bare null meaning "No Goal". */
const HISTORICAL_FIELDS = [
  "predictedHomeScore",
  "predictedAwayScore",
  "predictedGoalscorerPlayerId",
  "predictedGoalMinuteRegulation",
  "predictedGoalMinuteStoppage",
  "predictedFirstTeamToScore",
];

/** The fields of the progressive request: a consecutive prefix of categories with explicit kinds. */
const PROGRESSIVE_FIELDS = ["attemptedLevel", "scoreline", "firstTeam", "goalscorer", "goalMinute", "offerDigest"];

const PROGRESSIVE_ALLOWED_FIELDS = [
  "venueActivationId",
  "latitude",
  "longitude",
  "accuracyMeters",
  ...PROGRESSIVE_FIELDS,
];

/**
 * POST /api/gaming/predictions/matches/[matchId]/predict —
 * SUBMIT_PREDICTION. Requires an authenticated Gaming Member; the
 * gamingMemberId is always the verified caller's own — never accepted
 * from the request body. Every call (first submission or a revision)
 * re-verifies geolocation and the kickoff lock.
 *
 * The request shape is decided by the Match's prediction contract, never
 * by the request. COMPLETE_COUNT_V1 (historical): the four dimensions
 * (scoreline, goalscorer, goal minute, first team to score) are
 * independent and nullable, null meaning "No Goal". PROGRESSIVE_LADDER_V1:
 * `attemptedLevel` (1 to 4), the scoreline, and exactly the categories up
 * to that level, each an object {kind: "PICKED", ...} or {kind: "NONE"};
 * a category above the level is ABSENT, never null, and the fingerprint of
 * the prize offer the member saw (`offerDigest`) must be echoed back. A
 * request of the other contract's shape is refused (409), not guessed at.
 */
export async function POST(
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

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json(
      { error: "Request body must be valid JSON." },
      { status: 400 }
    );
  }
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return NextResponse.json({ error: "Invalid prediction payload." }, { status: 400 });
  }

  const repo = buildPredictionsRepo(credentials);

  try {
    const match = await repo.getMatchById(params.matchId);
    if (!match) {
      return NextResponse.json({ error: "No match exists for this id." }, { status: 404 });
    }

    // An approved event with a participation window is refused here until the window opens (409), whatever the page shows. It only says "not
    // yet": opening is the venue activation being enabled by a person, and the closing is the start of the match, judged where it always was.
    assertParticipationOpen(match);

    if (match.predictionContract === PROGRESSIVE_PREDICTION_CONTRACT) {
      return await submitProgressive(repo, params.matchId, authResult.gamingMemberId, body);
    }

    if (PROGRESSIVE_FIELDS.some((field) => field in body)) {
      throw new ContractMismatchError(
        "This match takes the historical prediction; the request used the progressive shape."
      );
    }
    return await submitHistorical(repo, params.matchId, authResult.gamingMemberId, body);
  } catch (err) {
    const status = statusForPredictionsError(err);
    if (status) {
      return NextResponse.json({ error: (err as Error).message }, { status });
    }
    console.error("SUBMIT_PREDICTION failed:", err);
    return NextResponse.json({ error: "Failed to submit prediction." }, { status: 500 });
  }
}

function geoOf(body: Record<string, unknown>) {
  const { latitude, longitude, accuracyMeters } = body;
  return typeof latitude === "number" && typeof longitude === "number"
    ? {
        latitude,
        longitude,
        accuracyMeters: typeof accuracyMeters === "number" ? accuracyMeters : null,
      }
    : null;
}

async function submitProgressive(
  repo: ReturnType<typeof buildPredictionsRepo>,
  matchId: string,
  gamingMemberId: string,
  body: Record<string, unknown>
) {
  if (HISTORICAL_FIELDS.some((field) => field in body)) {
    throw new ContractMismatchError(
      "This match takes the progressive prediction; the request used the historical shape."
    );
  }
  for (const key of Object.keys(body)) {
    if (!PROGRESSIVE_ALLOWED_FIELDS.includes(key)) {
      throw new InvalidAttemptShapeError(`The request carries an unexpected field "${key}".`);
    }
  }
  if (typeof body.venueActivationId !== "string") {
    throw new InvalidAttemptShapeError("venueActivationId must be a venue activation id.");
  }
  if (body.offerDigest !== undefined && typeof body.offerDigest !== "string") {
    throw new InvalidAttemptShapeError("offerDigest must be text.");
  }

  const answers: Record<string, unknown> = {};
  for (const field of ["attemptedLevel", "scoreline", "firstTeam", "goalscorer", "goalMinute"]) {
    if (field in body) answers[field] = body[field];
  }

  const prediction = await submitProgressivePrediction(repo, {
    matchId,
    gamingMemberId,
    venueActivationId: body.venueActivationId,
    answers,
    offerDigest: typeof body.offerDigest === "string" ? body.offerDigest : null,
    geo: geoOf(body),
  });
  return NextResponse.json({ prediction: progressivePredictionView(prediction) }, { status: 201 });
}

async function submitHistorical(
  repo: ReturnType<typeof buildPredictionsRepo>,
  matchId: string,
  gamingMemberId: string,
  body: Record<string, unknown>
) {
  const {
    venueActivationId,
    predictedHomeScore,
    predictedAwayScore,
    predictedGoalscorerPlayerId,
    predictedGoalMinuteRegulation,
    predictedGoalMinuteStoppage,
    predictedFirstTeamToScore,
  } = body;

  if (
    typeof venueActivationId !== "string" ||
    typeof predictedHomeScore !== "number" ||
    typeof predictedAwayScore !== "number" ||
    !(predictedGoalscorerPlayerId === null || typeof predictedGoalscorerPlayerId === "string") ||
    !(predictedGoalMinuteRegulation === null || typeof predictedGoalMinuteRegulation === "number") ||
    !(predictedGoalMinuteStoppage === null || typeof predictedGoalMinuteStoppage === "number") ||
    !(
      predictedFirstTeamToScore === null ||
      predictedFirstTeamToScore === "HOME" ||
      predictedFirstTeamToScore === "AWAY"
    )
  ) {
    return NextResponse.json({ error: "Invalid prediction payload." }, { status: 400 });
  }

  const prediction = await submitPrediction(repo, {
    matchId,
    gamingMemberId,
    venueActivationId,
    predictedHomeScore,
    predictedAwayScore,
    predictedGoalscorerPlayerId: predictedGoalscorerPlayerId as string | null,
    predictedGoalMinuteRegulation: predictedGoalMinuteRegulation as number | null,
    predictedGoalMinuteStoppage: predictedGoalMinuteStoppage as number | null,
    predictedFirstTeamToScore: predictedFirstTeamToScore as "HOME" | "AWAY" | null,
    geo: geoOf(body),
  });
  return NextResponse.json({ prediction }, { status: 201 });
}
