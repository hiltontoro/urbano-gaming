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
import { revokeHostCapability } from "@/lib/gaming/host/revokeHostCapability";

export const dynamic = "force-dynamic";

/**
 * POST /api/gaming/host/review/[applicationCode]/revoke — revoke an approved
 * host's access. Governance-only (checked in the database), reason required.
 * Every record is preserved; only future organizer actions are blocked.
 */
export async function POST(request: Request, { params }: { params: { applicationCode: string } }) {
  const unavailable = requireHostSchemaReady();
  if (unavailable) return unavailable;

  const credentials = getSupabaseCredentials();
  if (!credentials) {
    return NextResponse.json({ error: "Server misconfiguration: Supabase credentials not set." }, { status: 500 });
  }
  const auth = await requireGamingMember(request, credentials);
  if ("errorResponse" in auth) return auth.errorResponse;

  let body: Record<string, unknown>;
  try {
    const parsed = await request.json();
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    body = parsed as Record<string, unknown>;
  } catch {
    return NextResponse.json({ error: "Request body must be a JSON object." }, { status: 400 });
  }

  try {
    const result = await revokeHostCapability(buildHostRepo(credentials), auth.gamingMemberId, params.applicationCode, body.reason);
    return NextResponse.json({ application: result });
  } catch (err) {
    const code = statusForHostError(err);
    if (code) return NextResponse.json(bodyForHostError(err), { status: code });
    logHostFailure("REVOKE_HOST_CAPABILITY", err);
    return NextResponse.json({ error: "Failed to revoke hosting access." }, { status: 500 });
  }
}
