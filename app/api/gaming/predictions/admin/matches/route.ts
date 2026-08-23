import { NextResponse } from "next/server";
import {
  getSupabaseCredentials,
  buildPredictionsRepo,
  requireAnyAdminAuthority,
  requirePlatformAuthorityHttp,
} from "@/lib/gaming/predictions/httpAuth";
import { createMatch } from "@/lib/gaming/predictions/adminCatalog";

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
  const matches = await repo.listMatches();
  const teams = await repo.listTeams();
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

  const repo = buildPredictionsRepo(credentials);
  const match = await createMatch(repo, { homeTeamId, awayTeamId, competition, kickoffAt });
  return NextResponse.json({ match }, { status: 201 });
}
