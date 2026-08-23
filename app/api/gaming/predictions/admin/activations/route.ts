import { NextResponse } from "next/server";
import {
  getSupabaseCredentials,
  buildPredictionsRepo,
  requirePlatformAuthorityHttp,
} from "@/lib/gaming/predictions/httpAuth";
import { createVenueActivation } from "@/lib/gaming/predictions/adminCatalog";

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

  const { matchId, venueId } = body;
  if (typeof matchId !== "string" || typeof venueId !== "string") {
    return NextResponse.json({ error: "Invalid venue activation payload." }, { status: 400 });
  }

  const repo = buildPredictionsRepo(credentials);
  try {
    const activation = await createVenueActivation(repo, { matchId, venueId });
    return NextResponse.json({ activation }, { status: 201 });
  } catch (err) {
    console.error("CREATE_VENUE_ACTIVATION failed:", err);
    return NextResponse.json({ error: "Failed to create venue activation." }, { status: 500 });
  }
}
