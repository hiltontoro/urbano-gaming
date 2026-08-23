import { NextResponse } from "next/server";
import {
  getSupabaseCredentials,
  buildPredictionsRepo,
  requirePlatformAuthorityHttp,
} from "@/lib/gaming/predictions/httpAuth";
import { editVenue } from "@/lib/gaming/predictions/adminCatalog";

export async function PATCH(
  request: Request,
  { params }: { params: { venueId: string } }
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

  const { name, latitude, longitude, radiusMeters, active } = body;
  if (
    typeof name !== "string" ||
    typeof latitude !== "number" ||
    typeof longitude !== "number" ||
    typeof radiusMeters !== "number" ||
    typeof active !== "boolean"
  ) {
    return NextResponse.json({ error: "Invalid venue payload." }, { status: 400 });
  }

  const repo = buildPredictionsRepo(credentials);
  const venue = await editVenue(repo, params.venueId, {
    name,
    latitude,
    longitude,
    radiusMeters,
    active,
  });
  return NextResponse.json({ venue });
}
