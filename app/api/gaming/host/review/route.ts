import { NextResponse } from "next/server";
import {
  getSupabaseCredentials,
  buildHostRepo,
  requireGamingMember,
  requireHostSchemaReady,
  statusForHostError,
  bodyForHostError,
  logHostFailure,
} from "@/lib/gaming/host/httpAuth";
import { listHostApplicationsForReview } from "@/lib/gaming/host/listHostApplicationsForReview";

export const dynamic = "force-dynamic";

/**
 * GET /api/gaming/host/review?view=PENDING|ACTIVE|HISTORY — the internal review
 * queue. Authorization is NOT decided here: the database function checks that
 * the verified caller holds an active PRODUCT_GOVERNANCE grant and refuses
 * everyone else (403). No email-domain, display-name, client flag, user_metadata
 * or URL knowledge is consulted anywhere. Applicants are shown by name and
 * application text; no member or application identifier is returned, only the
 * opaque application code.
 */
export async function GET(request: Request) {
  const unavailable = requireHostSchemaReady();
  if (unavailable) return unavailable;

  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return NextResponse.json({ error: "Server misconfiguration: Supabase credentials not set." }, { status: 500 });
  }
  const auth = await requireGamingMember(request, credentials);
  if ("errorResponse" in auth) return auth.errorResponse;

  const view = new URL(request.url).searchParams.get("view") ?? "PENDING";

  try {
    const applications = await listHostApplicationsForReview(buildHostRepo(credentials), auth.gamingMemberId, view);
    return NextResponse.json({ applications });
  } catch (err) {
    const code = statusForHostError(err);
    if (code) return NextResponse.json(bodyForHostError(err), { status: code });
    logHostFailure("LIST_HOST_APPLICATIONS_FOR_REVIEW", err);
    return NextResponse.json({ error: "Failed to load host applications." }, { status: 500 });
  }
}
