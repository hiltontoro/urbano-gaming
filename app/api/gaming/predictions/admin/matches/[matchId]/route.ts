import { NextResponse } from "next/server";
import {
  getSupabaseCredentials,
  buildPredictionsRepo,
  requirePlatformAuthorityHttp,
} from "@/lib/gaming/predictions/httpAuth";
import { editMatch, cancelMatch } from "@/lib/gaming/predictions/adminCatalog";

export async function PATCH(
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

  const repo = buildPredictionsRepo(credentials);
  const match = await editMatch(repo, params.matchId, {
    homeTeamId,
    awayTeamId,
    competition,
    kickoffAt,
  });
  return NextResponse.json({ match });
}

export async function DELETE(
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
  const admin = await requirePlatformAuthorityHttp(request, credentials, "OPERATIONAL");
  if ("errorResponse" in admin) return admin.errorResponse;

  const repo = buildPredictionsRepo(credentials);
  const match = await cancelMatch(repo, params.matchId);
  return NextResponse.json({ match });
}
