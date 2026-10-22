import { NextResponse } from "next/server";
import {
  getSupabaseCredentials,
  buildPredictionsRepo,
  requirePlatformAuthorityHttp,
  statusForPredictionsError,
} from "@/lib/gaming/predictions/httpAuth";
import { releasePrizeQualificationHold } from "@/lib/gaming/predictions/releasePrizeQualificationHold";

/**
 * POST /api/gaming/predictions/admin/qualifications/[qualificationId]/release-hold
 * — a Consequential Finalizer's reasoned decision that a replacement
 * entitlement, created on hold because a correction changed a prize that
 * had already been delivered, may now be delivered. Body: { reason }
 * (required). Releasing delivers nothing; the entitlement then becomes
 * redeemable through the ordinary redeem route, a separate explicit act.
 */
export async function POST(
  request: Request,
  { params }: { params: { qualificationId: string } }
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

  let reason = "";
  try {
    const body: unknown = await request.json();
    if (body && typeof body === "object" && typeof (body as { reason?: unknown }).reason === "string") {
      reason = (body as { reason: string }).reason;
    }
  } catch {
    // Handled by the reason-required check in the domain function.
  }

  const repo = buildPredictionsRepo(credentials);
  try {
    const result = await releasePrizeQualificationHold(
      repo,
      params.qualificationId,
      admin.gamingMemberId,
      reason
    );
    return NextResponse.json({ result });
  } catch (err) {
    const status = statusForPredictionsError(err);
    if (status) return NextResponse.json({ error: (err as Error).message }, { status });
    console.error("RELEASE_PRIZE_HOLD failed:", err);
    return NextResponse.json({ error: "Failed to release the prize hold." }, { status: 500 });
  }
}
