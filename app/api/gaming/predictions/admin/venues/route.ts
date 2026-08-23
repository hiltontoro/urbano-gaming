import { NextResponse } from "next/server";
import {
  getSupabaseCredentials,
  buildPredictionsRepo,
  requireAnyAdminAuthority,
  requirePlatformAuthorityHttp,
} from "@/lib/gaming/predictions/httpAuth";
import { createVenue } from "@/lib/gaming/predictions/adminCatalog";

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
  const venues = await repo.listVenues();
  return NextResponse.json({ venues });
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

  const { name, latitude, longitude, radiusMeters } = body;
  if (
    typeof name !== "string" ||
    typeof latitude !== "number" ||
    typeof longitude !== "number" ||
    typeof radiusMeters !== "number"
  ) {
    return NextResponse.json({ error: "Invalid venue payload." }, { status: 400 });
  }

  const repo = buildPredictionsRepo(credentials);
  const venue = await createVenue(repo, { name, latitude, longitude, radiusMeters });
  return NextResponse.json({ venue }, { status: 201 });
}
