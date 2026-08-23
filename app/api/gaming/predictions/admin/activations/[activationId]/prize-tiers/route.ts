import { NextResponse } from "next/server";
import {
  getSupabaseCredentials,
  buildPredictionsRepo,
  requirePlatformAuthorityHttp,
  statusForPredictionsError,
} from "@/lib/gaming/predictions/httpAuth";
import { createPrizeTier } from "@/lib/gaming/predictions/adminCatalog";

export async function POST(
  request: Request,
  { params }: { params: { activationId: string } }
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

  const { correctDimensionCount, prizeLabel } = body;
  if (typeof correctDimensionCount !== "number" || typeof prizeLabel !== "string") {
    return NextResponse.json({ error: "Invalid prize tier payload." }, { status: 400 });
  }

  const repo = buildPredictionsRepo(credentials);
  try {
    const tier = await createPrizeTier(repo, {
      venueActivationId: params.activationId,
      correctDimensionCount,
      prizeLabel,
    });
    return NextResponse.json({ tier }, { status: 201 });
  } catch (err) {
    const status = statusForPredictionsError(err);
    if (status) return NextResponse.json({ error: (err as Error).message }, { status });
    console.error("CREATE_PRIZE_TIER failed:", err);
    return NextResponse.json({ error: "Failed to create prize tier." }, { status: 500 });
  }
}
