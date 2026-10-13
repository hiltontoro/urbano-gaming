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
import { getHostStatus } from "@/lib/gaming/host/getHostStatus";

export const dynamic = "force-dynamic";

/**
 * GET /api/gaming/host/status — the caller's OWN host application, if any.
 * The applicant is always the verified caller; the response carries the
 * application's opaque code and plain-language phase, never a member id, and
 * never the internal decision reason.
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

  try {
    const status = await getHostStatus(buildHostRepo(credentials), auth.gamingMemberId);
    return NextResponse.json(status);
  } catch (err) {
    const code = statusForHostError(err);
    if (code) return NextResponse.json(bodyForHostError(err), { status: code });
    logHostFailure("GET_HOST_STATUS", err);
    return NextResponse.json({ error: "Failed to load your host application." }, { status: 500 });
  }
}
