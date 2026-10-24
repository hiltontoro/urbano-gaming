import { NextResponse } from "next/server";
import { getSupabaseCredentials, resolveAdminAccessHttp } from "@/lib/gaming/predictions/httpAuth";

// Answers per caller and per call: never cached, never shared.
export const dynamic = "force-dynamic";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * GET /api/gaming/predictions/admin/access — what the Score administration portal may show the signed-in caller.
 *
 * A hint for the interface, not a boundary: nothing else calls it and nothing trusts it. Every admin route re-checks its own
 * authority class on every request. Read-only: it creates no member, no session and no grant.
 *
 *   200 { access: true, classes: [...] }   at least one of OPERATIONAL, CONSEQUENTIAL_FINALIZER, PRODUCT_GOVERNANCE is active
 *   401                                     no valid token, or no finished Gaming Member
 *   403                                     an authenticated Gaming Member with no administrative class
 */
export async function GET(request: Request) {
  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return NextResponse.json(
      { error: "Server misconfiguration: Supabase credentials not set." },
      { status: 500, headers: NO_STORE }
    );
  }

  const access = await resolveAdminAccessHttp(request, credentials);
  if ("errorResponse" in access) {
    access.errorResponse.headers.set("Cache-Control", "no-store");
    return access.errorResponse;
  }

  return NextResponse.json({ access: true, classes: access.classes }, { status: 200, headers: NO_STORE });
}
