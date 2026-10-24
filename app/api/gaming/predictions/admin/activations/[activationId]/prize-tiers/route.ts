import { NextResponse } from "next/server";
import {
  getSupabaseCredentials,
  buildPredictionsRepo,
  requirePlatformAuthorityHttp,
  statusForPredictionsError,
} from "@/lib/gaming/predictions/httpAuth";
import { createPrizeTier, createLadderPrizeTier } from "@/lib/gaming/predictions/adminCatalog";

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

  // A tier of a progressive match is keyed by `ladderLevel` (1 to 4); a tier
  // of a historical match by `correctDimensionCount`. Exactly one is given;
  // which one is accepted is decided by the match's contract, in the database.
  const { correctDimensionCount, ladderLevel, prizeLabel } = body;
  const hasCount = correctDimensionCount !== undefined;
  const hasLevel = ladderLevel !== undefined;
  if (
    typeof prizeLabel !== "string" ||
    hasCount === hasLevel ||
    (hasCount && typeof correctDimensionCount !== "number") ||
    (hasLevel && typeof ladderLevel !== "number")
  ) {
    return NextResponse.json({ error: "Invalid prize tier payload." }, { status: 400 });
  }

  const repo = buildPredictionsRepo(credentials);
  try {
    const tier = hasLevel
      ? await createLadderPrizeTier(repo, {
          venueActivationId: params.activationId,
          ladderLevel: ladderLevel as number,
          prizeLabel,
        })
      : await createPrizeTier(repo, {
          venueActivationId: params.activationId,
          correctDimensionCount: correctDimensionCount as number,
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
