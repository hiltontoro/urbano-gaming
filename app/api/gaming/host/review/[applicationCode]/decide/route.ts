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
import { decideHostApplication } from "@/lib/gaming/host/decideHostApplication";

export const dynamic = "force-dynamic";

/**
 * POST /api/gaming/host/review/[applicationCode]/decide — approve or reject.
 * The reviewer is always the verified caller and is authorized by the database
 * (active PRODUCT_GOVERNANCE grant, never the applicant themself). The body
 * carries only the decision and, for a rejection, the required reason.
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
    const result = await decideHostApplication(
      buildHostRepo(credentials),
      auth.gamingMemberId,
      params.applicationCode,
      body.decision,
      body.reason
    );
    return NextResponse.json({ application: result });
  } catch (err) {
    const code = statusForHostError(err);
    if (code) return NextResponse.json(bodyForHostError(err), { status: code });
    logHostFailure("DECIDE_HOST_APPLICATION", err);
    return NextResponse.json({ error: "Failed to record the decision." }, { status: 500 });
  }
}
