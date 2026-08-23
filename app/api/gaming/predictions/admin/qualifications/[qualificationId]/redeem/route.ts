import { NextResponse } from "next/server";
import {
  getSupabaseCredentials,
  buildPredictionsRepo,
  requirePlatformAuthorityHttp,
  statusForPredictionsError,
} from "@/lib/gaming/predictions/httpAuth";
import { redeemPrizeQualification } from "@/lib/gaming/predictions/redeemPrizeQualification";

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

  const repo = buildPredictionsRepo(credentials);
  try {
    const result = await redeemPrizeQualification(
      repo,
      params.qualificationId,
      admin.gamingMemberId
    );
    return NextResponse.json({ result });
  } catch (err) {
    const status = statusForPredictionsError(err);
    if (status) return NextResponse.json({ error: (err as Error).message }, { status });
    console.error("REDEEM_PRIZE_QUALIFICATION failed:", err);
    return NextResponse.json({ error: "Failed to redeem prize qualification." }, { status: 500 });
  }
}
