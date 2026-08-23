import { NextResponse } from "next/server";
import {
  getSupabaseCredentials,
  buildPredictionsRepo,
  requireAnyAdminAuthority,
  requirePlatformAuthorityHttp,
} from "@/lib/gaming/predictions/httpAuth";
import { createTeam, listTeams } from "@/lib/gaming/predictions/adminCatalog";

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
  const teams = await listTeams(repo);
  return NextResponse.json({ teams });
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

  const { name } = body;
  if (typeof name !== "string") {
    return NextResponse.json({ error: "Invalid team payload." }, { status: 400 });
  }

  const repo = buildPredictionsRepo(credentials);
  const team = await createTeam(repo, { name });
  return NextResponse.json({ team }, { status: 201 });
}
