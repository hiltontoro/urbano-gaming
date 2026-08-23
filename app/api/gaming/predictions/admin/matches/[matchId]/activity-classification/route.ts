import { NextResponse } from "next/server";
import {
  getSupabaseCredentials,
  buildPredictionsRepo,
  requirePlatformAuthorityHttp,
  statusForPredictionsError,
} from "@/lib/gaming/predictions/httpAuth";
import { setMatchActivityClassification } from "@/lib/gaming/predictions/adminCatalog";
import { InsufficientPlatformAuthorityError } from "@/lib/gaming/authority/types";

/**
 * PATCH /api/gaming/predictions/admin/matches/[matchId]/activity-classification
 * — DECLARE_ACTIVITY_CLASSIFICATION. Predictions A1's first HTTP
 * exposure of set_match_activity_classification_atomically — the
 * function itself, and its evidence-lock rule, are unchanged from
 * Persistent Metagame Phase 1; only authority, actor provenance, and
 * audit evidence are new (Admin Control Plane A0).
 */
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
  const admin = await requirePlatformAuthorityHttp(request, credentials, "CONSEQUENTIAL_FINALIZER");
  if ("errorResponse" in admin) return admin.errorResponse;

  let body: Record<string, unknown>;
  try {
    body = (await request.json()) as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Request body must be valid JSON." }, { status: 400 });
  }

  const { activityClassification, reason } = body;
  if (typeof activityClassification !== "string") {
    return NextResponse.json(
      { error: "activityClassification is required and must be a string." },
      { status: 400 }
    );
  }
  if (reason !== undefined && reason !== null && typeof reason !== "string") {
    return NextResponse.json({ error: "reason, if supplied, must be a string." }, { status: 400 });
  }

  const repo = buildPredictionsRepo(credentials);

  try {
    const result = await setMatchActivityClassification(
      repo,
      params.matchId,
      activityClassification,
      admin.gamingMemberId,
      typeof reason === "string" ? reason : null
    );
    return NextResponse.json({ result });
  } catch (err) {
    if (err instanceof InsufficientPlatformAuthorityError) {
      return NextResponse.json({ error: err.message }, { status: 403 });
    }
    const status = statusForPredictionsError(err);
    if (status) return NextResponse.json({ error: (err as Error).message }, { status });
    if (err instanceof Error && err.message.includes("activityClassification must be one of")) {
      return NextResponse.json({ error: err.message }, { status: 400 });
    }
    console.error("DECLARE_ACTIVITY_CLASSIFICATION failed:", err);
    return NextResponse.json({ error: "Failed to declare Activity Classification." }, { status: 500 });
  }
}
