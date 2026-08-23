import { NextResponse } from "next/server";
import {
  getSupabaseCredentials,
  buildPredictionsRepo,
  requirePlatformAuthorityHttp,
  statusForPredictionsError,
} from "@/lib/gaming/predictions/httpAuth";
import { setMatchXpEligibility } from "@/lib/gaming/predictions/adminCatalog";
import { InsufficientPlatformAuthorityError } from "@/lib/gaming/authority/types";

/**
 * PATCH /api/gaming/predictions/admin/matches/[matchId]/xp-eligibility
 * — DECLARE_XP_ELIGIBILITY. Predictions A1's first HTTP exposure of
 * set_match_xp_eligibility_atomically — the function itself, and its
 * evidence-lock rule, are unchanged from the XP Eligibility /
 * Calibration Support Slice; only authority, actor provenance, and
 * audit evidence are new (Admin Control Plane A0).
 *
 * This declares whether Predictions on this Match may enter the
 * persistent XP consequence path — it is not XP policy/value
 * configuration (PRODUCT_GOVERNANCE, out of scope here) and does not
 * activate Gaming XP by itself.
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

  const { xpEligible, reason } = body;
  if (typeof xpEligible !== "boolean") {
    return NextResponse.json({ error: "xpEligible is required and must be a boolean." }, { status: 400 });
  }
  if (reason !== undefined && reason !== null && typeof reason !== "string") {
    return NextResponse.json({ error: "reason, if supplied, must be a string." }, { status: 400 });
  }

  const repo = buildPredictionsRepo(credentials);

  try {
    const result = await setMatchXpEligibility(
      repo,
      params.matchId,
      xpEligible,
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
    console.error("DECLARE_XP_ELIGIBILITY failed:", err);
    return NextResponse.json({ error: "Failed to declare Match XP Eligibility." }, { status: 500 });
  }
}
