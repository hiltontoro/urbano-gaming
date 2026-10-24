import { NextResponse } from "next/server";
import {
  getSupabaseCredentials,
  buildPredictionsRepo,
  requireAnyAdminAuthority,
  requirePlatformAuthorityHttp,
  statusForPredictionsError,
} from "@/lib/gaming/predictions/httpAuth";
import { createMatch } from "@/lib/gaming/predictions/adminCatalog";
import { visibleInAdminView } from "@/lib/gaming/predictions/fixtureExclusion";
import { PROGRESSIVE_PREDICTION_CONTRACT } from "@/lib/gaming/predictions/prizeLadder";
import type { PredictionContract } from "@/lib/gaming/predictions/types";

export async function GET(request: Request) {
  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return NextResponse.json(
      { error: "Server misconfiguration: Supabase credentials not set." },
      { status: 500 }
    );
  }
  const admin = await requireAnyAdminAuthority(request, credentials);
  if ("errorResponse" in admin) return admin.errorResponse;

  const repo = buildPredictionsRepo(credentials);
  // Default view: the temporary fixture manifest is left out (?includeFixtures=1 brings the historical test data back).
  const matches = visibleInAdminView(request, await repo.listMatches(), "matches", (match) => match.matchId);
  const teams = visibleInAdminView(request, await repo.listTeams(), "teams", (team) => team.teamId);
  return NextResponse.json({ matches, teams });
}

export async function POST(request: Request) {
  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return NextResponse.json(
      { error: "Server misconfiguration: Supabase credentials not set." },
      { status: 500 }
    );
  }
  const admin = await requirePlatformAuthorityHttp(request, credentials, "OPERATIONAL");
  if ("errorResponse" in admin) return admin.errorResponse;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const { homeTeamId, awayTeamId, competition, kickoffAt } = body;
  if (
    typeof homeTeamId !== "string" ||
    typeof awayTeamId !== "string" ||
    typeof competition !== "string" ||
    typeof kickoffAt !== "string"
  ) {
    return NextResponse.json({ error: "Invalid match payload." }, { status: 400 });
  }

  // New matches are created under the progressive contract unless the
  // request names the historical one. The contract is frozen from the
  // match's first prediction or result.
  const requested = body.predictionContract;
  if (requested !== undefined && requested !== "COMPLETE_COUNT_V1" && requested !== "PROGRESSIVE_LADDER_V1") {
    return NextResponse.json({ error: "Unknown prediction contract." }, { status: 400 });
  }
  const predictionContract: PredictionContract = requested ?? PROGRESSIVE_PREDICTION_CONTRACT;

  const repo = buildPredictionsRepo(credentials);
  try {
    const match = await createMatch(repo, { homeTeamId, awayTeamId, competition, kickoffAt, predictionContract });
    return NextResponse.json({ match }, { status: 201 });
  } catch (err) {
    const status = statusForPredictionsError(err);
    if (status) return NextResponse.json({ error: (err as Error).message }, { status });
    throw err;
  }
}
