import { NextResponse } from "next/server";
import {
  getSupabaseCredentials,
  buildPredictionsRepo,
  requireAnyAdminAuthority,
} from "@/lib/gaming/predictions/httpAuth";

/**
 * GET /api/gaming/predictions/admin/qualifications?venueActivationId=...
 * — Prize Qualifications for one Venue Activation, including
 * superseded/redeemed state, so the admin surface can show a
 * correction discrepancy without hiding redemption history.
 */
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

  const url = new URL(request.url);
  const venueActivationId = url.searchParams.get("venueActivationId");
  if (!venueActivationId) {
    return NextResponse.json(
      { error: "venueActivationId query parameter is required." },
      { status: 400 }
    );
  }

  const repo = buildPredictionsRepo(credentials);
  const qualifications = await repo.listQualificationsForActivation(venueActivationId);
  return NextResponse.json({ qualifications });
}
